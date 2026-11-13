/* Tests of GZ.projectFile. A project must come back from its file exactly, and a bad file must give a clear error. */
(function () {
  'use strict';
  const GZ = window.GZ, T = window.GZT, assert = T.assert;
  const PF = GZ.projectFile, P = GZ.project, R = GZ.recordingCodec, Z = GZ.zip;

  async function buildProject(texts) {
    const project = P.createProject({ name: 'Mein Projekt ü' });
    const lsa = P.addLsa(project, P.createLsa({ name: 'Knoten', nodeNo: 3 }));
    lsa.config.nodeConfig = { version: 2, phases: [{ kuerzel: 'Ph1', name: 'Süd', members: ['K1'] }] };
    lsa.config.statsColumns = [{ label: 'TF', expr: 'TF(K1)' }];
    const store = new Map();
    for (const text of texts) {
      const { recording, chunks } = await R.encode(GZ.csvImport.importText(text), { fileName: 'a.csv' });
      P.addRecording(lsa, recording);
      chunks.forEach((bytes, name) => store.set(P.chunkKey(recording.id, name), bytes));
    }
    return { project, store, getChunk: async key => store.get(key) };
  }
  async function expectReject(fn, pattern, label) {
    let err = null;
    try { await fn(); } catch (e) { err = e; }
    assert.ok(err !== null, label + ': no error');
    assert.ok(pattern.test(err.message), label + ': wrong error: ' + err.message);
    return err;
  }

  T.test('projectFile: a project with two recordings comes back exactly', async () => {
    const { project, store, getChunk } = await buildProject([T.allFixtures().synthetic, T.allFixtures().sample]);
    const bytes = await PF.pack(project, getChunk);
    const out = await PF.unpack(bytes);
    assert.same(out.project, project);
    assert.equal(out.keys.length, store.size);
    for (const [key, data] of store) {
      const back = await out.getChunk(key);
      assert.ok(back.length === data.length && back.every((x, i) => x === data[i]), 'chunk ' + key);
    }
  });

  T.test('projectFile: the recording decodes from the file', async () => {
    const { project, getChunk } = await buildProject([T.allFixtures().synthetic]);
    const out = await PF.unpack(await PF.pack(project, getChunk));
    const rec = out.project.lsas[0].recordings[0];
    const original = GZ.csvImport.importText(T.allFixtures().synthetic);
    const back = await R.decode(rec, name => out.getChunk(P.chunkKey(rec.id, name)));
    assert.same(back.times, Array.from(original.times));
    assert.same(back.cycleStarts, original.cycleStarts);
    assert.same(back.columns, original.columns);
  });

  T.test('projectFile: the file is a ZIP with project.json and one entry for each chunk', async () => {
    const { project, store, getChunk } = await buildProject([T.allFixtures().synthetic]);
    const zip = await Z.read(await PF.pack(project, getChunk));
    assert.ok(zip.has('project.json'));
    assert.equal(zip.entries.length, 1 + store.size);
    zip.entries.filter(e => e.name !== 'project.json').forEach(e => assert.ok(/^chunks\/[0-9a-f]{32}\/(times|cycles|tc|spl|col-\d+)\.chunk$/.test(e.name), e.name));
  });

  T.test('projectFile: an empty project comes back', async () => {
    const project = P.createProject();
    const out = await PF.unpack(await PF.pack(project, async () => null));
    assert.same(out.project, project);
  });

  T.test('projectFile: pack refuses an invalid project and a missing chunk', async () => {
    await expectReject(() => PF.pack({ format: 'x' }, async () => null), /Projekt ungültig/, 'invalid');
    const { project } = await buildProject([T.allFixtures().synthetic]);
    await expectReject(() => PF.pack(project, async () => undefined), /fehlt im Speicher/, 'missing chunk');
  });

  T.test('projectFile: a file that is not a project file gives a clear message', async () => {
    await expectReject(() => PF.unpack(new Uint8Array(100)), /Keine gültige Projektdatei/, 'zeros');
    const noProject = await Z.create([{ name: 'other.txt', data: new TextEncoder().encode('x') }]);
    await expectReject(() => PF.unpack(noProject), /"project.json" fehlt/, 'no project.json');
    const badJson = await Z.create([{ name: 'project.json', data: new TextEncoder().encode('{not json') }]);
    await expectReject(() => PF.unpack(badJson), /nicht lesbar/, 'bad json');
    const wrong = await Z.create([{ name: 'project.json', data: new TextEncoder().encode('{"format":"other"}') }]);
    await expectReject(() => PF.unpack(wrong), /format/, 'wrong format');
  });

  T.test('projectFile: a newer file has the code newer', async () => {
    const p = P.createProject(); p.schemaVersion = 99;
    const bytes = await Z.create([{ name: 'project.json', data: new TextEncoder().encode(JSON.stringify(p)) }]);
    const err = await expectReject(() => PF.unpack(bytes), /Version 99/, 'newer');
    assert.equal(err.code, 'newer');
  });

  T.test('projectFile: a missing chunk in the file is found at once', async () => {
    const { project, getChunk } = await buildProject([T.allFixtures().synthetic]);
    const all = await Z.read(await PF.pack(project, getChunk));
    const cut = [];
    for (const e of all.entries) if (!/col-/.test(e.name)) cut.push({ name: e.name, data: await all.get(e.name) });
    await expectReject(async () => PF.unpack(await Z.create(cut)), /Datenblock/, 'missing chunk');
  });

  T.test('projectFile: a damaged chunk is found when it is read', async () => {
    const { project, getChunk } = await buildProject([T.allFixtures().synthetic]);
    const bytes = await PF.pack(project, getChunk);
    const out = await PF.unpack(bytes);
    const key = out.keys[0];
    // find the stored data of this chunk in the file and change one byte
    const needle = await out.getChunk(key);
    let at = -1;
    for (let i = 0; i + needle.length <= bytes.length && at < 0; i++) { if (bytes[i] === needle[0] && bytes[i + 1] === needle[1] && bytes[i + needle.length - 1] === needle[needle.length - 1] && bytes[i + 6] === needle[6]) at = i; }
    assert.ok(at > 0, 'chunk found in the file');
    const bad = bytes.slice(); bad[at + 7] ^= 0x55;
    const out2 = await PF.unpack(bad);
    await expectReject(() => out2.getChunk(key), /checksum/, 'damaged chunk');
    await expectReject(() => out2.getChunk('0'.repeat(32) + '/times'), /unbekannter/, 'unknown chunk');
  });
})();
