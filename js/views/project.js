/* GZ.views.project is the project bar at the top of the page.

   It connects the application to the project model (GZ.project):
   - After each import of a recording it builds a project with one LSA and one recording. The recording becomes chunks (GZ.recordingCodec).
     The project is the WORKING COPY. It lives in memory and in IndexedDB (GZ.localStore).
   - After each change of the settings it saves the working copy again (autosave, after a short pause).
     The settings come from the other views through the store (the providers nodeConfig, cycleConfig and statsColumns).
   - "Projekt speichern" writes the project as a ZIP file (GZ.projectFile, GZ.fileAccess).
     Edge writes into the same file on the next save. Firefox downloads a new file with a time stamp.
   - "Projekt öffnen" reads a project file. The recording is decoded and analysed again. Then the settings are applied.
   - After a restart the page offers to restore the working copy from IndexedDB.
   - "Konfiguration exportieren" and "Konfiguration laden" use only the settings, without the recording.
     The loader also reads the older files (phasen_knoten-*.json and umlaufpruefung_konfiguration.json).

   The project file is the source of truth. IndexedDB is a convenience copy. If it does not work, the page works as before
   and tells the user once. The chunks are small (about 150 KB for each day), so the session keeps them in memory too. */
GZ.define('views.project', { layer: 'views', deps: ['configIO', 'fileAccess', 'format', 'localStore', 'project', 'projectFile', 'recordingCache', 'recordingCodec', 'snackbar', 'state'] }, function (GZ) {
  'use strict';
  const P = GZ.project, PF = GZ.projectFile, R = GZ.recordingCodec, L = GZ.localStore, FA = GZ.fileAccess;

  const AUTOSAVE_DELAY_MS = 1500;
  const CURRENT_KEY = 'current';
  const EXTENSION = '.grueni.zip';

  const cache = GZ.recordingCache.create();   // decoded recordings. A recording that the code used before needs no new decoding.
  let els = null;
  let store = null;          // the open GZ.localStore Store, or null
  let storeProblem = null;   // the error when the store does not work
  let session = null;        // { project, chunks: Map(key -> bytes), lastConfigJson, fileHandle, fileName }
  let importSeq = 0;         // counts the imports. A slow import must not replace a newer one.
  let timer = null;
  let problemShown = false;
  let persistAsked = false;
  let pending = Promise.resolve();   // all writes run one after the other

  /* ---------- small helpers ---------- */
  const text = (el, t) => { el.textContent = t; };
  const snack = (title, type, description) => GZ.snackbar.show(title, { type, description });
  const timeText = d => GZ.format.fmtTimeOnly ? GZ.format.fmtTimeOnly(d) : d.toLocaleTimeString();
  // Runs the function after all earlier writes. An error in one write does not stop the next one.
  function queue(fn) {
    const run = pending.then(fn);
    pending = run.catch(() => {});
    return run;
  }

  function lsaNameFor(parsed) {
    if (parsed.knotenName) return String(parsed.knotenName);
    if (parsed.knotenNr) return 'Knoten ' + parsed.knotenNr;
    return 'LSA';
  }
  const activeLsa = () => (session ? P.findLsa(session.project, session.project.activeLsaId) : null);

  function setInfo(message, warn) {
    text(els.info, message);
    els.info.classList.toggle('warn', !!warn);
  }
  function describeSession() {
    if (!session) { setInfo('Noch keine Daten geladen'); return; }
    const lsa = activeLsa();
    const rec = lsa ? P.findRecording(lsa, lsa.activeRecordingId) : null;
    const parts = ['Arbeitskopie: ' + (lsa ? lsa.name : session.project.name)];
    if (rec) parts.push(rec.name + ' · ' + rec.rowCount + ' Zeilen');
    if (session.fileName) parts.push('Datei: ' + session.fileName);
    if (storeProblem) parts.push('nicht im Browser gesichert');
    else if (session.savedAt) parts.push('gesichert ' + timeText(session.savedAt));
    setInfo(parts.join(' · '), !!storeProblem);
  }
  function enableButtons() {
    els.btnSave.disabled = !session;
    els.btnConfigExport.disabled = !session;
  }

  // The user sees a problem with the store once. The page works without the store.
  function reportStoreProblem(err) {
    storeProblem = err;
    if (!problemShown) {
      problemShown = true;
      snack('Arbeitskopie nicht gesichert', 'warning', err.message + ' Das Projekt kann weiter als Datei gespeichert werden.');
    }
    describeSession();
  }

  /* ---------- the settings of the other views ---------- */
  // Returns { nodeConfig, cycleConfig, statsColumns } from the views through the store.
  function snapshotConfig() {
    return {
      nodeConfig: GZ.state.request('nodeConfig:get') || null,
      cycleConfig: GZ.state.request('cycleConfig:get') || null,
      statsColumns: GZ.state.request('statsColumns:get') || []
    };
  }

  // Applies settings to the views. Returns a list of remarks (texts) for things that the views could not take over.
  function applyConfig(config) {
    const remarks = [];
    if (config.nodeConfig) {
      const r = GZ.state.request('nodeConfig:apply', config.nodeConfig);
      if (r && r.warn) remarks.push(r.message);
    }
    if (config.cycleConfig) {
      const r = GZ.state.request('cycleConfig:apply', config.cycleConfig);
      if (r && r.text) remarks.push(r.text);
    }
    if (config.statsColumns && config.statsColumns.length) GZ.state.request('statsColumns:apply', config.statsColumns);
    return remarks;
  }

  /* ---------- the working copy in IndexedDB ---------- */
  async function openStore() {
    try {
      store = await L.open({ namespace: L.namespaceFromPath(location.pathname) });
    } catch (e) {
      storeProblem = e;
      store = null;
    }
  }

  async function writeProject(withChunks) {
    if (!store || !session) return;
    try {
      await store.putProject(session.project, withChunks ? session.chunks : undefined);
      await store.setMeta(CURRENT_KEY, session.project.id);
      session.savedAt = new Date();
      storeProblem = null;
      if (!persistAsked) { persistAsked = true; L.requestPersist(); }
    } catch (e) {
      reportStoreProblem(e);
      return;
    }
    describeSession();
  }

  // Saves the settings into the project when they changed. force = true saves in every case.
  function syncConfig(force) {
    if (!session) return false;
    const snap = snapshotConfig();
    const json = JSON.stringify(snap);
    if (!force && json === session.lastConfigJson) return false;
    session.lastConfigJson = json;
    const lsa = activeLsa();
    lsa.config.nodeConfig = snap.nodeConfig;
    lsa.config.cycleConfig = snap.cycleConfig;
    lsa.config.statsColumns = snap.statsColumns;
    P.touch(session.project);
    return true;
  }

  function autosave() {
    return queue(async () => {
      if (!syncConfig(false)) return;
      await writeProject(false);
    });
  }
  function scheduleAutosave() {
    if (!session) return;
    clearTimeout(timer);
    timer = setTimeout(autosave, AUTOSAVE_DELAY_MS);
  }

  // Describes the content of a recording. The cache drops an entry when the content has another signature.
  // A recording id never changes its content in this application. The signature protects against a damaged or edited file.
  function signatureOf(rec, chunks) {
    let bytes = 0;
    P.chunkKeys({ lsas: [{ recordings: [rec] }] }).forEach(key => { const b = chunks.get(key); bytes += b ? b.length : 0; });
    return rec.rowCount + ':' + bytes;
  }

  /* ---------- a new import ---------- */
  async function onImported(p) {
    const seq = ++importSeq;
    clearTimeout(timer);
    let encoded;
    try { encoded = await R.encode(p.parsed, { fileName: p.fileName }); }
    catch (e) { snack('Arbeitskopie nicht erstellt', 'warning', e.message); return; }
    if (seq !== importSeq) return;       // a newer import started while this one was in the encoder

    const project = P.createProject({ name: lsaNameFor(p.parsed) });
    const lsa = P.addLsa(project, P.createLsa({ name: lsaNameFor(p.parsed), nodeNo: p.parsed.knotenNr, nodeName: p.parsed.knotenName }));
    const rec = P.addRecording(lsa, encoded.recording);
    const chunks = new Map();
    encoded.chunks.forEach((bytes, name) => chunks.set(P.chunkKey(rec.id, name), bytes));
    const old = session;
    session = { project, chunks, lastConfigJson: null, fileHandle: null, fileName: '', savedAt: null };
    // The recording is ready. The cache keeps it for a later "restore" or "open".
    cache.set(rec.id, p.parsed, signatureOf(rec, chunks));
    syncConfig(true);
    enableButtons();
    describeSession();
    await queue(async () => {
      if (!store) { reportStoreProblem(storeProblem || new Error('Der Browser-Speicher ist nicht verfügbar.')); return; }
      await writeProject(true);
      // The code does not need the old working copy any more. Free its space.
      if (old && !storeProblem) { try { await store.deleteProject(old.project.id); } catch (e) { /* the old copy stays. This is not important. */ } }
    });
  }

  /* ---------- show a project ---------- */
  // Decodes the active recording of the session, shows it and applies the settings.
  async function showSession() {
    const lsa = activeLsa();
    const rec = lsa ? P.findRecording(lsa, lsa.activeRecordingId) : null;
    if (!rec) {
      snack('Das Projekt enthält keine Aufzeichnung', 'info', 'Die Einstellungen werden erst mit einer Aufzeichnung gebraucht.');
      return;
    }
    const chunks = session.chunks;
    const parsed = await cache.load(rec.id, () => R.decode(rec, name => {
      const bytes = chunks.get(P.chunkKey(rec.id, name));
      if (!bytes) throw new Error('Der Datenblock ' + name + ' fehlt.');
      return Promise.resolve(bytes);
    }), signatureOf(rec, chunks));
    importSeq++;                                  // an import that is still running must not replace this project
    GZ.state.command('recording:show', { parsed, fileName: rec.fileName || rec.name });
    const remarks = applyConfig(lsa.config);
    session.lastConfigJson = JSON.stringify(snapshotConfig());
    enableButtons();
    describeSession();
    if (remarks.length) snack('Einstellungen teilweise übernommen', 'warning', remarks.join(' '));
  }

  /* ---------- restore ---------- */
  async function offerRestore() {
    if (!store) return;
    let project = null;
    try {
      const id = await store.getMeta(CURRENT_KEY);
      if (id) project = await store.getProject(id);
    } catch (e) { reportStoreProblem(e); return; }
    if (!project) return;
    try { P.validate(P.migrate(project)); } catch (e) { return; }   // the page does not offer a damaged or newer working copy
    const lsa = P.findLsa(project, project.activeLsaId);
    const rec = lsa ? P.findRecording(lsa, lsa.activeRecordingId) : null;
    if (!rec) return;
    const when = new Date(project.modifiedAt);
    els.bannerText.textContent = 'Arbeitskopie vom ' + GZ.format.fmtTs(when) + ': ' + lsa.name + ' · ' + rec.name + ' · ' + rec.rowCount + ' Zeilen.';
    els.banner.style.display = '';
    els.btnRestore.onclick = () => { els.banner.style.display = 'none'; restoreWorkingCopy(project); };
    els.btnDiscard.onclick = async () => {
      els.banner.style.display = 'none';
      try { await store.deleteProject(project.id); await store.setMeta(CURRENT_KEY, null); } catch (e) { reportStoreProblem(e); }
    };
  }

  async function restoreWorkingCopy(project) {
    try {
      const chunks = new Map();
      for (const key of P.chunkKeys(project)) {
        const bytes = await store.getChunk(key);
        if (!bytes) throw new Error('Die Arbeitskopie ist unvollständig (Datenblock ' + key.split('/')[1] + ' fehlt).');
        chunks.set(key, bytes);
      }
      session = { project, chunks, lastConfigJson: null, fileHandle: null, fileName: '', savedAt: new Date(project.modifiedAt) };
      await showSession();
    } catch (e) {
      session = null;
      enableButtons(); describeSession();
      snack('Arbeitskopie konnte nicht wiederhergestellt werden', 'error', e.message);
    }
  }

  /* ---------- project file ---------- */
  async function saveProject() {
    if (!session) return;
    try {
      await queue(async () => { syncConfig(true); });
      const lsa = activeLsa();
      const bytes = await PF.pack(session.project, key => Promise.resolve(session.chunks.get(key)));
      const base = FA.safeName(lsa && lsa.name ? lsa.name : 'projekt');
      const r = await FA.save(bytes, { suggestedName: base + EXTENSION, handle: session.fileHandle, mime: 'application/zip', extensions: ['.zip', '.grueni'], description: 'Projektdatei' });
      if (r.cancelled) return;
      session.fileHandle = r.handle;
      session.fileName = r.name;
      describeSession();
      snack('Projekt gespeichert', 'info', r.name + (r.mode === 'download' ? ' (im Download-Ordner des Browsers)' : ''));
      queue(() => writeProject(false));
    } catch (e) {
      snack('Projekt konnte nicht gespeichert werden', 'error', e.message);
    }
  }

  async function openProject(file) {
    let unpacked;
    try {
      unpacked = await PF.unpack(new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      snack(e.code === 'newer' ? 'Projektdatei ist zu neu' : 'Projektdatei konnte nicht geöffnet werden', 'error', e.message);
      return;
    }
    try {
      const chunks = new Map();
      for (const key of unpacked.keys) chunks.set(key, await unpacked.getChunk(key));
      const old = session;
      session = { project: unpacked.project, chunks, lastConfigJson: null, fileHandle: null, fileName: file.name, savedAt: null };
      await showSession();
      enableButtons();
      await queue(async () => {
        if (!store) return;
        await writeProject(true);
        if (old && old.project.id !== session.project.id && !storeProblem) { try { await store.deleteProject(old.project.id); } catch (e) { /* not important */ } }
      });
    } catch (e) {
      snack('Projektdatei konnte nicht geöffnet werden', 'error', e.message);
    }
  }

  /* ---------- configuration files ---------- */
  function exportConfig() {
    if (!session) return;
    syncConfig(true);
    const lsa = activeLsa();
    const exp = P.toConfigExport(lsa);
    const id = lsa.nodeNo ? 'knoten-' + lsa.nodeNo : FA.safeName(lsa.name);
    GZ.configIO.downloadJson('grueni-konfiguration_' + id + '.json', exp);
  }

  async function importConfigFile(file) {
    let parsed;
    try { parsed = P.parseConfigExport(await GZ.configIO.readJsonFile(file)); }
    catch (e) { snack('Konfiguration konnte nicht geladen werden', 'warning', e.message); return; }
    if (!session) {
      snack('Keine Aufzeichnung geladen', 'warning', 'Bitte zuerst eine Aufzeichnung laden. Danach die Konfiguration laden.');
      return;
    }
    const remarks = applyConfig(parsed.config);
    syncConfig(true);
    queue(() => writeProject(false));
    if (remarks.length) snack('Konfiguration teilweise geladen', 'warning', remarks.join(' '));
    else snack('Konfiguration geladen', 'info', parsed.kind === 'config' ? 'Alle Einstellungen wurden übernommen.' : 'Die Datei hat das ältere Format. Die Einstellungen wurden übernommen.');
  }

  /* ---------- start ---------- */
  function init(root) {
    els = {
      root,
      info: root.querySelector('#projectInfo'),
      btnSave: root.querySelector('#btnProjectSave'),
      openInput: root.querySelector('#projectOpenInput'),
      btnConfigExport: root.querySelector('#btnConfigExport'),
      configInput: root.querySelector('#configImportInput'),
      banner: root.querySelector('#projectBanner'),
      bannerText: root.querySelector('#projectBannerText'),
      btnRestore: root.querySelector('#btnRestore'),
      btnDiscard: root.querySelector('#btnDiscard')
    };
    GZ.state.on('recording:imported', onImported);
    els.btnSave.addEventListener('click', saveProject);
    els.btnConfigExport.addEventListener('click', exportConfig);
    els.openInput.addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) openProject(f); });
    els.configInput.addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importConfigFile(f); });

    // Every action of the user can change a setting. A short pause after the last action starts the autosave.
    // The autosave compares the settings with the last saved ones. So an action without a change costs little.
    ['click', 'change', 'input', 'keyup', 'dragend'].forEach(type => document.addEventListener(type, scheduleAutosave, true));
    GZ.state.on('phases:changed', scheduleAutosave);
    GZ.state.on('detectors:changed', scheduleAutosave);
    GZ.state.on('syntheticColumns:changed', scheduleAutosave);
    // The last changes must not get lost when the user closes the page.
    window.addEventListener('pagehide', () => { clearTimeout(timer); if (session && syncConfig(false)) writeProject(false); });

    enableButtons();
    describeSession();
    openStore().then(() => { if (storeProblem) reportStoreProblem(storeProblem); else offerRestore(); });
  }

  return { init };
});
