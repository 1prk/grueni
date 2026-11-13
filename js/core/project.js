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

   A project can have several LSAs, and an LSA can have several recordings (one for each day).
   The configuration belongs to the LSA. All its recordings share it. It names columns by NAME, so it fits every recording
   of the LSA, also when the column order is different. mapColumns() and checkImport() compare the columns of two recordings
   by name and by type before a new recording joins an LSA.

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

  // The chunk keys of one recording.
  function recordingChunkKeys(r) {
    const keys = [], c = r.chunks;
    CHUNK_NAMES.forEach(n => { if (c[n]) keys.push(chunkKey(r.id, c[n])); });
    Object.keys(c.columns).forEach(i => keys.push(chunkKey(r.id, c.columns[i])));
    return keys;
  }
  // All chunk keys that the recordings of the project name.
  function chunkKeys(project) {
    const keys = [];
    project.lsas.forEach(l => l.recordings.forEach(r => { recordingChunkKeys(r).forEach(k => keys.push(k)); }));
    return keys;
  }

  // Removes a recording from an LSA. Returns the recording, or null when the id is not there.
  // The active recording becomes the last one that is left, or null.
  function removeRecording(lsa, id) {
    const i = lsa.recordings.findIndex(r => r.id === id);
    if (i < 0) return null;
    const removed = lsa.recordings.splice(i, 1)[0];
    if (lsa.activeRecordingId === id) lsa.activeRecordingId = lsa.recordings.length ? lsa.recordings[lsa.recordings.length - 1].id : null;
    return removed;
  }
  // Removes an LSA with all its recordings. Returns the LSA, or null when the id is not there.
  function removeLsa(project, id) {
    const i = project.lsas.findIndex(l => l.id === id);
    if (i < 0) return null;
    const removed = project.lsas.splice(i, 1)[0];
    if (project.activeLsaId === id) project.activeLsaId = project.lsas.length ? project.lsas[project.lsas.length - 1].id : null;
    return removed;
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

  /* ---------- the columns of two recordings ---------- */
  // A column is described by its group and its type.
  // A signal group has the group 'SG' and the OCIT type name (for example 'veh' or 'ped') as type.
  // Every other column has its short code (for example 'DET' or 'APW') as group and as type.
  const nameKey = name => String(name == null ? '' : name).trim().toUpperCase();
  function columnEntries(header) {
    const out = [];
    (header.columns || []).forEach(c => out.push({ name: c.name, group: 'SG', type: c.typName || 'SG', index: c.index }));
    (header.otherColumns || []).forEach(c => out.push({ name: c.name, group: c.kuerzel, type: c.kuerzel, index: c.index }));
    return out;
  }

  // Matches the columns of a recording to the columns of a reference recording by name, and then by group.
  // Two columns that have the same name and the same group are a pair. Names are not case sensitive.
  // When a name is used more than once, the first column pairs with the first, the second with the second.
  // Returns:
  //   pairs         [{ ref, col }]  columns that have the same name and the same group
  //   typeChanged   [{ ref, col }]  pairs where the type is different (for example 'veh' and 'ped')
  //   conflicts     [{ ref, col }]  the name is the same but the group is different (for example a signal group and a detector)
  //   missing       [ref]           columns of the reference that the new recording does not have
  //   added         [col]           columns of the new recording that the reference does not have
  // ref and col are { name, group, type, index }. The index is the field number in the CSV of the own recording.
  function mapColumns(refHeader, header) {
    const ref = columnEntries(refHeader), cur = columnEntries(header);
    const usedRef = new Set(), usedCur = new Set();
    const pairs = [], typeChanged = [], conflicts = [];
    // First pass: same name and same group.
    cur.forEach((c, ci) => {
      const ri = ref.findIndex((r, i) => !usedRef.has(i) && nameKey(r.name) === nameKey(c.name) && r.group === c.group);
      if (ri < 0) return;
      usedRef.add(ri); usedCur.add(ci);
      pairs.push({ ref: ref[ri], col: c });
      if (ref[ri].type !== c.type) typeChanged.push({ ref: ref[ri], col: c });
    });
    // Second pass: same name, another group.
    cur.forEach((c, ci) => {
      if (usedCur.has(ci)) return;
      const ri = ref.findIndex((r, i) => !usedRef.has(i) && nameKey(r.name) === nameKey(c.name));
      if (ri < 0) return;
      usedRef.add(ri); usedCur.add(ci);
      conflicts.push({ ref: ref[ri], col: c });
    });
    return {
      pairs, typeChanged, conflicts,
      missing: ref.filter((_, i) => !usedRef.has(i)),
      added: cur.filter((_, i) => !usedCur.has(i))
    };
  }

  function listNames(entries, max) {
    const names = entries.map(e => e.name);
    const shown = names.slice(0, max || 8).join(', ');
    return names.length > (max || 8) ? shown + ' und ' + (names.length - (max || 8)) + ' weitere' : shown;
  }

  // Checks a new recording against the LSA that it joins.
  // header, tMin and tMax are the fields of the new recording (see createRecording). The reference is the active recording of the LSA.
  // Returns { reference, mapping, problems, notes }.
  //   problems  German texts. The user must confirm the import (another node number, an overlap in time, a conflict of columns,
  //             missing signal groups).
  //   notes     German texts for differences that do not need a confirmation (new columns, other types, missing detectors).
  // An LSA without a recording has no reference. Then there are no problems.
  function checkImport(lsa, rec) {
    const problems = [], notes = [];
    const reference = (lsa.activeRecordingId && findRecording(lsa, lsa.activeRecordingId)) || lsa.recordings[lsa.recordings.length - 1] || null;
    if (!reference) return { reference: null, mapping: null, problems, notes };

    const nodeNow = rec.header.knotenNr == null ? '' : String(rec.header.knotenNr).trim();
    const nodeRef = lsa.nodeNo != null ? String(lsa.nodeNo).trim() : '';
    if (nodeNow && nodeRef && nodeNow !== nodeRef) problems.push('Die Knotennummer ist ' + nodeNow + '. Die LSA „' + lsa.name + '“ hat die Knotennummer ' + nodeRef + '.');

    const overlapping = lsa.recordings.filter(r => rec.tMin < r.tMax && rec.tMax > r.tMin);
    overlapping.forEach(r => problems.push('Der Zeitraum überschneidet sich mit der Aufzeichnung „' + r.name + '“.'));

    const m = mapColumns(reference.header, rec.header);
    if (m.conflicts.length) problems.push('Spalten mit gleichem Namen, aber anderer Art: ' + listNames(m.conflicts.map(c => ({ name: c.col.name + ' (' + c.ref.group + ' → ' + c.col.group + ')' }))) + '.');
    const missingSg = m.missing.filter(e => e.group === 'SG');
    if (missingSg.length) problems.push('Signalgruppen der Aufzeichnung „' + reference.name + '“ fehlen: ' + listNames(missingSg) + '.');
    const missingOther = m.missing.filter(e => e.group !== 'SG');
    if (missingOther.length) notes.push('Weitere Spalten fehlen: ' + listNames(missingOther) + '.');
    if (m.added.length) notes.push('Neue Spalten: ' + listNames(m.added) + '.');
    if (m.typeChanged.length) notes.push('Anderer Typ bei: ' + listNames(m.typeChanged.map(c => ({ name: c.col.name + ' (' + c.ref.type + ' → ' + c.col.type + ')' }))) + '.');
    return { reference, mapping: m, problems, notes };
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
    createProject, createLsa, createRecording, addLsa, addRecording, findLsa, findRecording, touch, chunkKeys, recordingChunkKeys, removeRecording, removeLsa, mapColumns, checkImport,
    validate, migrate, toConfigExport, parseConfigExport
  };
});
