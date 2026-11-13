/* GZ.localStore keeps the working copy of a project in IndexedDB (io layer).

   All local files of a browser share one origin (file://). Other pages can use IndexedDB too.
   So the database name has a namespace: "grueni:<namespace>". The caller chooses the namespace.
   namespaceFromPath(path) makes one from the folder of the page. Two copies of the application in two folders do not share data.

   The database has three object stores:
     meta      small values by name (for example the id of the current project)
     projects  the project models (GZ.project) by id
     chunks    the bytes of the chunks by key (see GZ.project.chunkKey)

   open(opts) -> Promise<Store>
     opts.namespace   (required)
     opts.indexedDB   the IndexedDB factory (default: the one of the browser)
   A Store has these methods. All return promises:
     putProject(project, chunks?)   saves the model and, in the SAME transaction, a Map of chunks (key -> bytes).
                                    Either everything is saved or nothing. The error code is 'quota' when the storage is full.
     getProject(id), listProjects(), deleteProject(id)   deleteProject also deletes the chunks that the model names.
     putChunks(map), getChunk(key), hasChunk(key), deleteChunks(keys)
     getMeta(name), setMeta(name, value)
     close()
   requestPersist() asks the browser to keep the data (navigator.storage.persist). It returns true, false or null (not supported).
   estimate() returns { usage, quota } or null.

   Every error is an Error with a German message and a code:
     'unavailable'  IndexedDB does not work here (for example in a private window)
     'quota'        the storage is full
     'blocked'      another tab holds an older version of the database
     'storage'      any other error */
GZ.define('localStore', { layer: 'io', deps: ['project'] }, function (GZ) {
  'use strict';
  const P = GZ.project;

  const DB_VERSION = 1;
  const STORES = ['meta', 'projects', 'chunks'];

  /* ---------- names and errors ---------- */
  // A short hash (FNV-1a, 32 bit) of the folder of the page. The result has 8 hex characters.
  function namespaceFromPath(path) {
    const folder = String(path).replace(/[^/]*$/, '');
    let h = 0x811c9dc5;
    for (let i = 0; i < folder.length; i++) { h ^= folder.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function makeError(code, message, cause) {
    const e = new Error(message);
    e.code = code;
    if (cause) e.cause = cause;
    return e;
  }
  function mapError(e) {
    if (e && e.code && /^(unavailable|quota|blocked|storage)$/.test(e.code) && e instanceof Error && e.message) return e;
    const name = e && e.name;
    if (name === 'QuotaExceededError' || (e && e.code === 22)) return makeError('quota', 'Der Speicher des Browsers ist voll. Bitte ein Projekt als Datei speichern und alte Arbeitskopien löschen.', e);
    if (name === 'SecurityError' || name === 'InvalidStateError' || name === 'NotSupportedError') return makeError('unavailable', 'Der Browser-Speicher ist hier nicht verfügbar (zum Beispiel in einem privaten Fenster). Die Arbeitskopie wird nicht gesichert.', e);
    if (name === 'VersionError') return makeError('storage', 'Der Browser-Speicher stammt von einer neueren Version dieser Anwendung.', e);
    return makeError('storage', 'Fehler im Browser-Speicher: ' + ((e && e.message) || e), e);
  }

  /* ---------- helpers for IndexedDB requests ---------- */
  const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(mapError(req.error)); });
  function done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(mapError(tx.error));
      tx.onabort = () => reject(mapError(tx.error || new Error('aborted')));
    });
  }

  function upgrade(db, oldVersion) {
    // The version 1 creates all stores. A later version adds a step here for each version.
    if (oldVersion < 1) STORES.forEach(name => db.createObjectStore(name));
  }

  function open(opts) {
    const o = opts || {};
    if (!o.namespace) return Promise.reject(makeError('storage', 'localStore: the namespace is missing'));
    const factory = o.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    if (!factory) return Promise.reject(makeError('unavailable', 'Der Browser-Speicher ist hier nicht verfügbar.'));
    return new Promise((resolve, reject) => {
      let req;
      try { req = factory.open('grueni:' + o.namespace, DB_VERSION); } catch (e) { reject(mapError(e)); return; }
      req.onupgradeneeded = ev => { try { upgrade(req.result, ev.oldVersion); } catch (e) { reject(mapError(e)); } };
      req.onblocked = () => reject(makeError('blocked', 'Der Browser-Speicher ist von einem anderen Fenster blockiert. Bitte andere Fenster dieser Anwendung schließen.'));
      req.onerror = () => reject(mapError(req.error));
      req.onsuccess = () => resolve(new Store(req.result));
    });
  }

  class Store {
    constructor(db) {
      this.db = db;
      // Another tab can ask to upgrade the database. Close it, so the other tab can go on.
      db.onversionchange = () => db.close();
    }
    _tx(names, mode) {
      try { return this.db.transaction(names, mode); } catch (e) { throw mapError(e); }
    }

    async putProject(project, chunks) {
      const tx = this._tx(chunks && chunks.size ? ['projects', 'chunks'] : ['projects'], 'readwrite');
      try {
        tx.objectStore('projects').put(JSON.parse(JSON.stringify(project)), project.id);
        if (chunks) { const cs = tx.objectStore('chunks'); chunks.forEach((bytes, key) => cs.put(bytes, key)); }
      } catch (e) { tx.abort(); throw mapError(e); }
      await done(tx);
    }
    async getProject(id) {
      const v = await request(this._tx(['projects'], 'readonly').objectStore('projects').get(id));
      return v === undefined ? null : v;
    }
    async listProjects() {
      const tx = this._tx(['projects'], 'readonly');
      const all = await request(tx.objectStore('projects').getAll());
      return all.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
    }
    async deleteProject(id) {
      const project = await this.getProject(id);
      const tx = this._tx(['projects', 'chunks'], 'readwrite');
      tx.objectStore('projects').delete(id);
      if (project) { const cs = tx.objectStore('chunks'); P.chunkKeys(project).forEach(k => cs.delete(k)); }
      await done(tx);
    }

    async putChunks(map) {
      if (!map.size) return;
      const tx = this._tx(['chunks'], 'readwrite');
      const cs = tx.objectStore('chunks');
      try { map.forEach((bytes, key) => cs.put(bytes, key)); } catch (e) { tx.abort(); throw mapError(e); }
      await done(tx);
    }
    async getChunk(key) {
      const v = await request(this._tx(['chunks'], 'readonly').objectStore('chunks').get(key));
      if (v === undefined) return undefined;
      return v instanceof Uint8Array ? v : new Uint8Array(v);
    }
    async hasChunk(key) {
      return (await request(this._tx(['chunks'], 'readonly').objectStore('chunks').count(key))) > 0;
    }
    async deleteChunks(keys) {
      if (!keys.length) return;
      const tx = this._tx(['chunks'], 'readwrite');
      const cs = tx.objectStore('chunks');
      keys.forEach(k => cs.delete(k));
      await done(tx);
    }

    async getMeta(name) {
      const v = await request(this._tx(['meta'], 'readonly').objectStore('meta').get(name));
      return v === undefined ? null : v;
    }
    async setMeta(name, value) {
      const tx = this._tx(['meta'], 'readwrite');
      tx.objectStore('meta').put(value, name);
      await done(tx);
    }
    close() { this.db.close(); }
  }

  async function requestPersist() {
    try {
      if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.persist !== 'function') return null;
      if (typeof navigator.storage.persisted === 'function' && await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    } catch (e) { return null; }
  }
  async function estimate() {
    try {
      if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.estimate !== 'function') return null;
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0 };
    } catch (e) { return null; }
  }

  return { open, namespaceFromPath, mapError, requestPersist, estimate, DB_VERSION };
});
