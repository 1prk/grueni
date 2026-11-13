/* GZ.project is the data model of a project file (domain layer, no DOM, no storage).

   A project has LSAs (junctions). An LSA has a configuration and recordings. A recording has a header and a list of chunk names.
   The bytes of the chunks are not part of the model. They live in the chunk store (js/io/localStore.js) and in the project file.

   project = {
     format: 'grueni-project', schemaVersion, id, name, createdAt, modifiedAt (ISO texts), activeLsaId,
     lsas: [ {
       id, name, nodeNo, nodeName, activeRecordingId,
       config: { nodeConfig, cycleConfig, statsColumns },
       recordings: [ {
         id, name, fileName, importedAt, rowCount, tMin, tMax,
         header: { columns, otherColumns, knotenName, knotenNr, totalRows, skippedRows },
         chunks: { times, cycles, tc, spl, columns: { "<csv column index>": chunk name } }
       } ]
     } ] }

   config.nodeConfig    the node configuration of the tab "Stammdaten LSA" (phases, PÜ corrections, detectors, topology) or null
   config.cycleConfig   the configuration of the cycle check (object order, filters, formula builder) or null
   config.statsColumns  the columns of the tab "Umlaufstatistiken", [{ label, expr }]
   The configurations use column NAMES and never the raw column index. See GZ.configIO.

   Every id is 128 random bits as 32 hex characters. The ids exist from the first version of the file.
   schemaVersion counts the versions of this model. migrate() brings an older project to the current version.
   A project with a newer version is refused. */
GZ.define('project', { layer: 'domain', deps: [] }, function (GZ) {
  'use strict';

  const FORMAT = 'grueni-project';
  const CONFIG_FORMAT = 'grueni-config';
  const SCHEMA_VERSION = 1;
  const MAX_LSAS = 10000, MAX_RECORDINGS = 100000, MAX_COLUMNS = 100000;

  /* ---------- ids ---------- */
  function newId() {
    const bytes = new Uint8Array(16);
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
    else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    let s = '';
    for (let i = 0; i < 16; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }
  const isId = v => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);

  const isoNow = () => new Date().toISOString();

  /* ---------- chunk names ---------- */
  // A recording has fixed chunk names. The column chunks use the CSV column index.
  const CHUNK_NAMES = ['times', 'cycles', 'tc', 'spl'];
  const columnChunkName = index => 'col-' + index;
  // The key in the chunk store and the path in the project file.
  const chunkKey = (recordingId, name) => recordingId + '/' + name;
  const isChunkName = n => typeof n === 'string' && /^(times|cycles|tc|spl|col-\d{1,9})$/.test(n);

  /* ---------- constructors ---------- */
  function createProject(opts) {
    const o = opts || {};
    const now = o.now || isoNow();
    return { format: FORMAT, schemaVersion: SCHEMA_VERSION, id: newId(), name: o.name || 'Projekt', createdAt: now, modifiedAt: now, activeLsaId: null, lsas: [] };
  }
  function createLsa(opts) {
    const o = opts || {};
    return {
      id: newId(), name: o.name || 'LSA', nodeNo: o.nodeNo != null ? String(o.nodeNo) : '', nodeName: o.nodeName || '',
      activeRecordingId: null,
      config: { nodeConfig: null, cycleConfig: null, statsColumns: [] },
      recordings: []
    };
  }
  // o: { name, fileName, importedAt, rowCount, tMin, tMax, header, chunks }
  function createRecording(o) {
    return {
      id: newId(), name: o.name || o.fileName || 'Aufzeichnung', fileName: o.fileName || '', importedAt: o.importedAt || isoNow(),
      rowCount: o.rowCount, tMin: o.tMin, tMax: o.tMax, header: o.header, chunks: o.chunks
    };
  }

  function addLsa(project, lsa) {
    project.lsas.push(lsa);
    if (!project.activeLsaId) project.activeLsaId = lsa.id;
    return lsa;
  }
  function addRecording(lsa, recording) {
    lsa.recordings.push(recording);
    lsa.activeRecordingId = recording.id;
    return recording;
  }
  const findLsa = (project, id) => project.lsas.find(l => l.id === id) || null;
  const findRecording = (lsa, id) => lsa.recordings.find(r => r.id === id) || null;
  function touch(project, now) { project.modifiedAt = now || isoNow(); return project; }

  // All chunk keys that the recordings of the project name.
  function chunkKeys(project) {
    const keys = [];
    project.lsas.forEach(l => l.recordings.forEach(r => {
      const c = r.chunks;
      CHUNK_NAMES.forEach(n => { if (c[n]) keys.push(chunkKey(r.id, c[n])); });
      Object.keys(c.columns).forEach(i => keys.push(chunkKey(r.id, c.columns[i])));
    }));
    return keys;
  }

  /* ---------- validation ---------- */
  function fail(path, text) { throw new Error('Projekt ungültig: ' + path + ' ' + text); }
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const isInt = v => Number.isInteger(v);
  const isStr = v => typeof v === 'string';

  function validateRecording(r, path, ids) {
    if (!isObj(r)) fail(path, 'ist kein Objekt');
    if (!isId(r.id)) fail(path + '.id', 'ist keine gültige Kennung');
    if (ids.has(r.id)) fail(path + '.id', 'kommt doppelt vor');
    ids.add(r.id);
    ['name', 'fileName', 'importedAt'].forEach(k => { if (!isStr(r[k])) fail(path + '.' + k, 'muss ein Text sein'); });
    if (!isInt(r.rowCount) || r.rowCount < 0) fail(path + '.rowCount', 'muss eine ganze Zahl sein');
    if (!isNum(r.tMin) || !isNum(r.tMax)) fail(path, 'hat keinen gültigen Zeitraum');
    const h = r.header;
    if (!isObj(h)) fail(path + '.header', 'fehlt');
    if (!Array.isArray(h.columns) || h.columns.length > MAX_COLUMNS) fail(path + '.header.columns', 'ist keine Liste');
    if (!Array.isArray(h.otherColumns) || h.otherColumns.length > MAX_COLUMNS) fail(path + '.header.otherColumns', 'ist keine Liste');
    const c = r.chunks;
    if (!isObj(c)) fail(path + '.chunks', 'fehlt');
    CHUNK_NAMES.forEach(n => { if (!isChunkName(c[n])) fail(path + '.chunks.' + n, 'ist kein gültiger Name'); });
    if (!isObj(c.columns)) fail(path + '.chunks.columns', 'fehlt');
    Object.keys(c.columns).forEach(i => {
      if (!/^\d{1,9}$/.test(i)) fail(path + '.chunks.columns', 'hat einen ungültigen Spaltenindex ' + i);
      if (c.columns[i] !== columnChunkName(Number(i))) fail(path + '.chunks.columns.' + i, 'hat einen ungültigen Namen');
    });
  }

  function validateLsa(l, path, ids) {
    if (!isObj(l)) fail(path, 'ist kein Objekt');
    if (!isId(l.id)) fail(path + '.id', 'ist keine gültige Kennung');
    if (ids.has(l.id)) fail(path + '.id', 'kommt doppelt vor');
    ids.add(l.id);
    ['name', 'nodeNo', 'nodeName'].forEach(k => { if (!isStr(l[k])) fail(path + '.' + k, 'muss ein Text sein'); });
    if (!isObj(l.config)) fail(path + '.config', 'fehlt');
    ['nodeConfig', 'cycleConfig'].forEach(k => { if (l.config[k] !== null && !isObj(l.config[k])) fail(path + '.config.' + k, 'muss ein Objekt oder null sein'); });
    if (!Array.isArray(l.config.statsColumns)) fail(path + '.config.statsColumns', 'muss eine Liste sein');
    l.config.statsColumns.forEach((s, i) => { if (!isObj(s) || !isStr(s.label) || !isStr(s.expr)) fail(path + '.config.statsColumns[' + i + ']', 'ist ungültig'); });
    if (!Array.isArray(l.recordings) || l.recordings.length > MAX_RECORDINGS) fail(path + '.recordings', 'ist keine Liste');
    l.recordings.forEach((r, i) => validateRecording(r, path + '.recordings[' + i + ']', ids));
    if (l.activeRecordingId !== null && !l.recordings.some(r => r.id === l.activeRecordingId)) fail(path + '.activeRecordingId', 'verweist auf keine Aufzeichnung');
  }

  // Throws an Error with a German message when the project is not valid. Returns the project.
  function validate(p) {
    if (!isObj(p)) fail('', 'ist kein Objekt');
    if (p.format !== FORMAT) fail('format', 'ist nicht "' + FORMAT + '"');
    if (!isInt(p.schemaVersion) || p.schemaVersion < 1) fail('schemaVersion', 'ist keine gültige Version');
    if (p.schemaVersion !== SCHEMA_VERSION) fail('schemaVersion', 'ist ' + p.schemaVersion + ' und nicht ' + SCHEMA_VERSION + '. Zuerst migrate() aufrufen');
    if (!isId(p.id)) fail('id', 'ist keine gültige Kennung');
    ['name', 'createdAt', 'modifiedAt'].forEach(k => { if (!isStr(p[k])) fail(k, 'muss ein Text sein'); });
    if (!Array.isArray(p.lsas) || p.lsas.length > MAX_LSAS) fail('lsas', 'ist keine Liste');
    const ids = new Set([p.id]);
    p.lsas.forEach((l, i) => validateLsa(l, 'lsas[' + i + ']', ids));
    if (p.activeLsaId !== null && !p.lsas.some(l => l.id === p.activeLsaId)) fail('activeLsaId', 'verweist auf keine LSA');
    return p;
  }

  /* ---------- migration ---------- */
  // MIGRATIONS[n] changes a project of the version n into the version n + 1. It changes the object in place.
  // The table is empty as long as there is only version 1.
  const MIGRATIONS = {};

  // Returns the project in the version `target`. It does not validate. The error has the code 'newer' for a newer file.
  function migrate(p, migrations, target) {
    const table = migrations || MIGRATIONS, to = target || SCHEMA_VERSION;
    if (!isObj(p) || p.format !== FORMAT) fail('format', 'ist nicht "' + FORMAT + '"');
    if (!isInt(p.schemaVersion) || p.schemaVersion < 1) fail('schemaVersion', 'ist keine gültige Version');
    if (p.schemaVersion > to) {
      const e = new Error('Die Projektdatei hat die Version ' + p.schemaVersion + '. Diese Anwendung kennt nur die Version ' + to + '. Bitte die Anwendung aktualisieren.');
      e.code = 'newer';
      throw e;
    }
    while (p.schemaVersion < to) {
      const step = table[p.schemaVersion];
      if (typeof step !== 'function') fail('schemaVersion', 'hat keinen Migrationsschritt von ' + p.schemaVersion);
      step(p);
      p.schemaVersion++;
    }
    return p;
  }

  /* ---------- configuration export ---------- */
  // The configuration of one LSA without the recordings.
  function toConfigExport(lsa, now) {
    return {
      format: CONFIG_FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: now || isoNow(),
      lsa: { name: lsa.name, nodeNo: lsa.nodeNo, nodeName: lsa.nodeName },
      config: JSON.parse(JSON.stringify(lsa.config))
    };
  }

  // Reads a parsed JSON object. It knows three kinds of files:
  //   'config'  the file of toConfigExport()
  //   'node'    the older node configuration of the tab "Stammdaten LSA" (phasen_knoten-*.json)
  //   'cycle'   the older configuration of the cycle check (umlaufpruefung_konfiguration.json)
  // Returns { kind, lsa, config } where config has the fields nodeConfig, cycleConfig and statsColumns. A missing part is null.
  // Throws an Error for everything else (for example the MAP file, which is only an output).
  function parseConfigExport(obj) {
    if (!isObj(obj)) throw new Error('Keine Konfigurationsdatei: der Inhalt ist kein Objekt.');
    if (obj.format === CONFIG_FORMAT) {
      if (!isInt(obj.schemaVersion) || obj.schemaVersion > SCHEMA_VERSION) throw new Error('Die Konfigurationsdatei ist neuer als diese Anwendung.');
      if (!isObj(obj.config)) throw new Error('Keine Konfigurationsdatei: "config" fehlt.');
      const c = obj.config;
      return {
        kind: 'config', lsa: isObj(obj.lsa) ? obj.lsa : null,
        config: { nodeConfig: isObj(c.nodeConfig) ? c.nodeConfig : null, cycleConfig: isObj(c.cycleConfig) ? c.cycleConfig : null, statsColumns: Array.isArray(c.statsColumns) ? c.statsColumns : [] }
      };
    }
    if (obj.format === FORMAT) throw new Error('Das ist eine Projektdatei und keine Konfigurationsdatei.');
    if (Array.isArray(obj.phases) && (obj.version === 1 || obj.version === 2)) {
      return { kind: 'node', lsa: { name: '', nodeNo: obj.knotenNr != null ? String(obj.knotenNr) : '', nodeName: obj.knotenName || '' }, config: { nodeConfig: obj, cycleConfig: null, statsColumns: [] } };
    }
    if (obj.version === 1 && (isObj(obj.umlaufpruefung) || isObj(obj.formulaBuilder) || isObj(obj.fingerprint))) {
      return { kind: 'cycle', lsa: null, config: { nodeConfig: null, cycleConfig: obj, statsColumns: [] } };
    }
    if (obj.mapem || obj.MapData || obj.intersections) throw new Error('Das ist eine MAP-Datei. Sie ist nur eine Ausgabe und kann nicht geladen werden.');
    throw new Error('Unbekanntes Dateiformat. Erwartet wird eine Konfigurationsdatei dieser Anwendung.');
  }

  return {
    FORMAT, CONFIG_FORMAT, SCHEMA_VERSION, CHUNK_NAMES, MIGRATIONS,
    newId, isId, columnChunkName, chunkKey, isChunkName,
    createProject, createLsa, createRecording, addLsa, addRecording, findLsa, findRecording, touch, chunkKeys,
    validate, migrate, toConfigExport, parseConfigExport
  };
});
