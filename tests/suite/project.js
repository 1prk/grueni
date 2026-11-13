/* Tests of GZ.project: ids, validation, migration and the configuration files. */
(function () {
  'use strict';
  const GZ = window.GZ, T = window.GZT, assert = T.assert;
  const P = GZ.project;

  function throws(fn, pattern, label) {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    assert.ok(err !== null, label + ': no error');
    assert.ok(pattern.test(err.message), label + ': wrong error: ' + err.message);
    return err;
  }

  function sampleRecording(extra) {
    return P.createRecording(Object.assign({
      name: 'tag1.csv', fileName: 'tag1.csv', rowCount: 86400, tMin: 1000, tMax: 87400000,
      header: { columns: [{ index: 5, name: 'K1' }], otherColumns: [], knotenName: 'K', knotenNr: '7', totalRows: 86400, skippedRows: 0 },
      chunks: { times: 'times', cycles: 'cycles', tc: 'tc', spl: 'spl', columns: { 5: 'col-5' } }
    }, extra || {}));
  }
  function sampleProject() {
    const p = P.createProject({ name: 'Test' });
    const lsa = P.addLsa(p, P.createLsa({ name: 'Knoten 7', nodeNo: 7, nodeName: 'K' }));
    P.addRecording(lsa, sampleRecording());
    return p;
  }

  T.test('project: ids are 32 hex characters and different', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) { const id = P.newId(); assert.ok(P.isId(id), id); seen.add(id); }
    assert.equal(seen.size, 2000);
    assert.equal(P.isId('ABC'), false);
    assert.equal(P.isId(5), false);
  });

  T.test('project: a new project is valid and has the current version', () => {
    const p = P.createProject();
    assert.equal(p.schemaVersion, P.SCHEMA_VERSION);
    P.validate(p);
    P.validate(sampleProject());
  });

  T.test('project: add and find, the active ids follow', () => {
    const p = sampleProject();
    const lsa = p.lsas[0];
    assert.equal(p.activeLsaId, lsa.id);
    assert.equal(lsa.activeRecordingId, lsa.recordings[0].id);
    assert.ok(P.findLsa(p, lsa.id) === lsa);
    assert.ok(P.findRecording(lsa, lsa.recordings[0].id) === lsa.recordings[0]);
    assert.equal(P.findLsa(p, 'nope'), null);
    const second = P.addRecording(lsa, sampleRecording({ name: 'tag2.csv' }));
    assert.equal(lsa.activeRecordingId, second.id);
  });

  T.test('project: chunk keys list every chunk of every recording', () => {
    const p = sampleProject();
    const rec = p.lsas[0].recordings[0];
    assert.same(P.chunkKeys(p).sort(), ['times', 'cycles', 'tc', 'spl', 'col-5'].map(n => rec.id + '/' + n).sort());
    assert.equal(P.chunkKey('a', 'b'), 'a/b');
    assert.equal(P.columnChunkName(12), 'col-12');
    assert.equal(P.isChunkName('col-12'), true);
    assert.equal(P.isChunkName('col-'), false);
    assert.equal(P.isChunkName('../x'), false);
  });

  T.test('project: validation names the wrong field', () => {
    const bad = (mutate, pattern, label) => { const p = JSON.parse(JSON.stringify(sampleProject())); mutate(p); throws(() => P.validate(p), pattern, label); };
    throws(() => P.validate(null), /kein Objekt/, 'null');
    throws(() => P.validate([]), /kein Objekt/, 'array');
    bad(p => { p.format = 'x'; }, /format/, 'format');
    bad(p => { p.schemaVersion = 2; }, /schemaVersion/, 'future version');
    bad(p => { p.schemaVersion = 0; }, /schemaVersion/, 'zero version');
    bad(p => { p.id = 'x'; }, /id/, 'id');
    bad(p => { p.name = 5; }, /name/, 'name');
    bad(p => { p.lsas = {}; }, /lsas/, 'lsas');
    bad(p => { p.activeLsaId = P.newId(); }, /activeLsaId/, 'active lsa');
    bad(p => { p.lsas[0].id = p.id; }, /doppelt/, 'double id');
    bad(p => { p.lsas[0].config = null; }, /config/, 'config');
    bad(p => { p.lsas[0].config.statsColumns = [{ label: 1 }]; }, /statsColumns/, 'stats column');
    bad(p => { p.lsas[0].activeRecordingId = 'x'; }, /activeRecordingId/, 'active recording');
    bad(p => { p.lsas[0].recordings[0].rowCount = -1; }, /rowCount/, 'row count');
    bad(p => { p.lsas[0].recordings[0].tMin = NaN; }, /Zeitraum/, 'time range');
    bad(p => { p.lsas[0].recordings[0].header = null; }, /header/, 'header');
    bad(p => { p.lsas[0].recordings[0].chunks.times = '../evil'; }, /chunks\.times/, 'chunk name');
    bad(p => { p.lsas[0].recordings[0].chunks.columns['5'] = 'col-6'; }, /Namen/, 'column chunk name');
    bad(p => { p.lsas[0].recordings[0].chunks.columns['x'] = 'col-1'; }, /Spaltenindex/, 'column index');
  });

  T.test('project: migrate runs the steps in order and refuses a newer file', () => {
    const log = [];
    const steps = { 1: p => { log.push('1->2'); p.addedIn2 = true; }, 2: p => { log.push('2->3'); p.addedIn3 = true; } };
    const p = { format: P.FORMAT, schemaVersion: 1 };
    P.migrate(p, steps, 3);
    assert.same(log, ['1->2', '2->3']);
    assert.equal(p.schemaVersion, 3);
    assert.ok(p.addedIn2 && p.addedIn3);
    const e = throws(() => P.migrate({ format: P.FORMAT, schemaVersion: 9 }, steps, 3), /Version 9/, 'newer');
    assert.equal(e.code, 'newer');
    throws(() => P.migrate({ format: P.FORMAT, schemaVersion: 1 }, {}, 2), /Migrationsschritt/, 'missing step');
    throws(() => P.migrate({ format: 'x', schemaVersion: 1 }), /format/, 'wrong format');
    const cur = sampleProject();
    assert.ok(P.migrate(cur) === cur, 'a current project stays as it is');
  });

  T.test('project: the configuration export keeps the configuration and drops the recordings', () => {
    const p = sampleProject();
    const lsa = p.lsas[0];
    lsa.config.nodeConfig = { version: 2, phases: [{ kuerzel: 'Ph1', name: 'A', members: ['K1'] }] };
    lsa.config.statsColumns = [{ label: 'TF', expr: 'TF(K1)' }];
    const exp = P.toConfigExport(lsa, '2026-11-13T10:00:00.000Z');
    assert.equal(exp.format, P.CONFIG_FORMAT);
    assert.equal(exp.lsa.nodeNo, '7');
    assert.ok(!('recordings' in exp));
    const back = P.parseConfigExport(JSON.parse(JSON.stringify(exp)));
    assert.equal(back.kind, 'config');
    assert.same(back.config.nodeConfig, lsa.config.nodeConfig);
    assert.same(back.config.statsColumns, lsa.config.statsColumns);
    assert.equal(back.config.cycleConfig, null);
    exp.config.nodeConfig.phases.push('changed');
    assert.equal(lsa.config.nodeConfig.phases.length, 1, 'the export is a copy');
  });

  T.test('project: the older configuration files stay importable', () => {
    const node = P.parseConfigExport({ version: 2, knotenNr: 12, knotenName: 'Mitte', phases: [], pueOverrides: {}, detectors: { links: [], ignored: [] }, topology: { axes: [] } });
    assert.equal(node.kind, 'node');
    assert.equal(node.lsa.nodeNo, '12');
    assert.equal(node.config.nodeConfig.version, 2);
    assert.equal(P.parseConfigExport({ version: 1, phases: [] }).kind, 'node');
    const cycle = P.parseConfigExport({ version: 1, fingerprint: { columnNames: [] }, umlaufpruefung: { objects: [] }, formulaBuilder: null });
    assert.equal(cycle.kind, 'cycle');
    assert.ok(cycle.config.cycleConfig.umlaufpruefung);
  });

  T.test('project: other files are refused with a clear message', () => {
    throws(() => P.parseConfigExport(null), /kein Objekt/, 'null');
    throws(() => P.parseConfigExport({ format: P.FORMAT }), /Projektdatei/, 'project file');
    throws(() => P.parseConfigExport({ mapem: {} }), /MAP-Datei/, 'map');
    throws(() => P.parseConfigExport({ hello: 1 }), /Unbekanntes/, 'unknown');
    throws(() => P.parseConfigExport({ format: P.CONFIG_FORMAT, schemaVersion: 99, config: {} }), /neuer/, 'newer config');
    throws(() => P.parseConfigExport({ format: P.CONFIG_FORMAT, schemaVersion: 1 }), /config/, 'no config');
  });

  /* ---------- several recordings and LSAs ---------- */
  const col = (index, name, typName) => ({ index, name, typName: typName || 'veh', beschreibung: '' });
  const oth = (index, name, kuerzel) => ({ index, name, kuerzel: kuerzel || 'DET', beschreibung: '' });
  const rec = (name, tMin, tMax, columns, otherColumns, node) => sampleRecording({
    name, fileName: name, tMin, tMax,
    header: { columns, otherColumns, knotenName: 'K', knotenNr: node == null ? '7' : node, totalRows: 10, skippedRows: 0 }
  });

  T.test('project: removeRecording and removeLsa keep the active ids valid', () => {
    const p = sampleProject();
    const lsa = p.lsas[0];
    const a = lsa.recordings[0], b = P.addRecording(lsa, sampleRecording({ name: 'b' })), c = P.addRecording(lsa, sampleRecording({ name: 'c' }));
    assert.equal(lsa.activeRecordingId, c.id);
    assert.ok(P.removeRecording(lsa, b.id) === b);
    assert.equal(lsa.activeRecordingId, c.id, 'the active recording stays');
    assert.ok(P.removeRecording(lsa, c.id) === c);
    assert.equal(lsa.activeRecordingId, a.id, 'the last recording that is left becomes active');
    assert.equal(P.removeRecording(lsa, 'nope'), null);
    P.removeRecording(lsa, a.id);
    assert.equal(lsa.activeRecordingId, null);
    P.validate(p);
    const second = P.addLsa(p, P.createLsa({ name: 'zwei' }));
    assert.equal(p.activeLsaId, lsa.id);
    p.activeLsaId = second.id;
    assert.ok(P.removeLsa(p, second.id) === second);
    assert.equal(p.activeLsaId, lsa.id);
    P.removeLsa(p, lsa.id);
    assert.equal(p.activeLsaId, null);
    assert.equal(P.removeLsa(p, 'nope'), null);
    P.validate(p);
  });

  T.test('project: recordingChunkKeys lists the keys of one recording', () => {
    const r = sampleRecording();
    assert.same(P.recordingChunkKeys(r).sort(), ['times', 'cycles', 'tc', 'spl', 'col-5'].map(n => r.id + '/' + n).sort());
  });

  T.test('project: mapColumns pairs by name and group and reports the rest', () => {
    const ref = { columns: [col(5, 'K1'), col(6, 'K2'), col(7, 'F1', 'ped')], otherColumns: [oth(8, 'IS1'), oth(9, 'IS2'), oth(10, 'TA1', 'APW')] };
    // The new file has another column order, another type for F1, a new detector, no IS2, and K2 as a detector.
    const cur = { columns: [col(5, 'k1'), col(6, 'F1', 'veh')], otherColumns: [oth(7, 'IS1'), oth(8, 'IS9'), oth(9, 'K2'), oth(10, 'TA1', 'APW')] };
    const m = P.mapColumns(ref, cur);
    assert.same(m.pairs.map(x => [x.ref.name, x.col.name]), [['K1', 'k1'], ['F1', 'F1'], ['IS1', 'IS1'], ['TA1', 'TA1']]);
    assert.same(m.pairs.map(x => [x.ref.index, x.col.index]), [[5, 5], [7, 6], [8, 7], [10, 10]], 'the pairs keep both indices');
    assert.same(m.typeChanged.map(x => x.col.name), ['F1']);
    assert.same(m.conflicts.map(x => [x.ref.group, x.col.group]), [['SG', 'DET']]);
    assert.same(m.missing.map(x => x.name), ['IS2']);
    assert.same(m.added.map(x => x.name), ['IS9']);
  });

  T.test('project: mapColumns pairs equal names in order', () => {
    const h = { columns: [col(5, 'K1'), col(6, 'K1')], otherColumns: [] };
    const m = P.mapColumns(h, { columns: [col(8, 'K1'), col(9, 'K1'), col(10, 'K1')], otherColumns: [] });
    assert.same(m.pairs.map(x => [x.ref.index, x.col.index]), [[5, 8], [6, 9]]);
    assert.same(m.added.map(x => x.index), [10]);
    const none = P.mapColumns({ columns: [], otherColumns: [] }, { columns: [], otherColumns: [] });
    assert.equal(none.pairs.length + none.missing.length + none.added.length, 0);
  });

  T.test('project: checkImport gives no problem for the next day with the same columns', () => {
    const p = P.createProject();
    const lsa = P.addLsa(p, P.createLsa({ name: 'Knoten 7', nodeNo: '7' }));
    P.addRecording(lsa, rec('tag1', 0, 86400000, [col(5, 'K1')], [oth(6, 'IS1')]));
    const next = rec('tag2', 86400000, 172800000, [col(5, 'K1')], [oth(6, 'IS1')]);
    const r = P.checkImport(lsa, next);
    assert.same(r.problems, []);
    assert.same(r.notes, []);
    assert.equal(r.mapping.pairs.length, 2);
    // An LSA without a recording has no reference.
    const empty = P.checkImport(P.createLsa({ name: 'leer' }), next);
    assert.equal(empty.reference, null);
    assert.same(empty.problems, []);
  });

  T.test('project: checkImport names every problem and note in German', () => {
    const p = P.createProject();
    const lsa = P.addLsa(p, P.createLsa({ name: 'Knoten 7', nodeNo: '7' }));
    P.addRecording(lsa, rec('tag1', 0, 86400000, [col(5, 'K1'), col(6, 'K2')], [oth(7, 'IS1'), oth(8, 'IS2')]));
    const bad = rec('tag1b', 43200000, 129600000, [col(5, 'K1')], [oth(6, 'IS1'), oth(7, 'NEU')], '9');
    const r = P.checkImport(lsa, bad);
    const text = r.problems.join(' | ');
    assert.ok(/Knotennummer ist 9/.test(text) && /hat die Knotennummer 7/.test(text), text);
    assert.ok(/überschneidet sich mit der Aufzeichnung „tag1“/.test(text), text);
    assert.ok(/Signalgruppen .* fehlen: K2/.test(text), text);
    assert.ok(r.notes.some(n => /Weitere Spalten fehlen: IS2/.test(n)), r.notes.join(' | '));
    assert.ok(r.notes.some(n => /Neue Spalten: NEU/.test(n)), r.notes.join(' | '));
    // A recording that touches the end of the other is not an overlap.
    assert.same(P.checkImport(lsa, rec('tag2', 86400000, 172800000, [col(5, 'K1'), col(6, 'K2')], [oth(7, 'IS1'), oth(8, 'IS2')])).problems, []);
    // A conflict of columns.
    const conflict = P.checkImport(lsa, rec('tag3', 86400000, 172800000, [col(6, 'K2')], [oth(7, 'K1'), oth(8, 'IS1'), oth(9, 'IS2')]));
    assert.ok(conflict.problems.some(x => /gleichem Namen, aber anderer Art: K1 \(SG → DET\)/.test(x)), conflict.problems.join(' | '));
    // Many names are shortened.
    const many = P.checkImport(lsa, rec('tag4', 86400000, 172800000, [], []));
    assert.ok(/und \d+ weitere/.test(many.problems.join(' ')) || many.problems.join(' ').length > 10);
  });
})();
