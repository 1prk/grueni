/* Tests of GZ.localStore. The IndexedDB tests run only in a browser. The Node runner has no IndexedDB. */
(function () {
  'use strict';
  const GZ = window.GZ, T = window.GZT, assert = T.assert;
  const L = GZ.localStore, P = GZ.project;
  const haveIdb = typeof indexedDB !== 'undefined';
  let seq = 0;
  const namespace = () => 'test-' + Date.now() + '-' + (++seq);

  async function expectReject(fn, pattern, label) {
    let err = null;
    try { await fn(); } catch (e) { err = e; }
    assert.ok(err !== null, label + ': no error');
    assert.ok(pattern.test(err.message), label + ': wrong error: ' + err.message);
    return err;
  }
  async function withStore(fn) {
    const store = await L.open({ namespace: namespace() });
    try { await fn(store); } finally { store.close(); }
  }
  function sampleProject() {
    const p = P.createProject({ name: 'P' });
    const lsa = P.addLsa(p, P.createLsa({ name: 'L' }));
    P.addRecording(lsa, P.createRecording({
      name: 'r', fileName: 'r.csv', rowCount: 3, tMin: 1, tMax: 3,
      header: { columns: [], otherColumns: [], knotenName: '', knotenNr: '', totalRows: 3, skippedRows: 0 },
      chunks: { times: 'times', cycles: 'cycles', tc: 'tc', spl: 'spl', columns: { 5: 'col-5' } }
    }));
    return p;
  }
  const chunksOf = p => new Map(P.chunkKeys(p).map((k, i) => [k, Uint8Array.from([i, i + 1, 255])]));

  T.test('localStore: the namespace comes from the folder of the page', () => {
    const a = L.namespaceFromPath('/home/user/grueni/index.html');
    assert.ok(/^[0-9a-f]{8}$/.test(a), a);
    assert.equal(L.namespaceFromPath('/home/user/grueni/other.html'), a, 'the file name does not count');
    assert.ok(L.namespaceFromPath('/home/user/grueni2/index.html') !== a, 'another folder');
    assert.equal(L.namespaceFromPath('/a/b/'), L.namespaceFromPath('/a/b/x.html'));
  });

  T.test('localStore: errors get a code and a German message', () => {
    const q = L.mapError({ name: 'QuotaExceededError', message: 'full' });
    assert.equal(q.code, 'quota'); assert.ok(/voll/.test(q.message));
    assert.equal(L.mapError({ name: 'SecurityError' }).code, 'unavailable');
    assert.equal(L.mapError({ name: 'InvalidStateError' }).code, 'unavailable');
    assert.equal(L.mapError({ name: 'VersionError' }).code, 'storage');
    const other = L.mapError(new Error('weird'));
    assert.equal(other.code, 'storage'); assert.ok(/weird/.test(other.message));
    assert.ok(L.mapError(q) === q, 'a mapped error stays as it is');
  });

  T.test('localStore: open needs a namespace and refuses a factory that throws', async () => {
    await expectReject(() => L.open({}), /namespace/, 'no namespace');
    await expectReject(() => L.open({ namespace: 'x', indexedDB: { open() { throw Object.assign(new Error('x'), { name: 'SecurityError' }); } } }), /nicht verfügbar/, 'throwing factory');
  });

  T.test('localStore: a project and its chunks are saved together and come back', async () => {
    if (!haveIdb) return;
    await withStore(async store => {
      const p = sampleProject(), chunks = chunksOf(p);
      await store.putProject(p, chunks);
      assert.same(await store.getProject(p.id), p);
      for (const [key, bytes] of chunks) {
        const back = await store.getChunk(key);
        assert.ok(back instanceof Uint8Array && back.length === bytes.length && back.every((v, i) => v === bytes[i]), key);
        assert.equal(await store.hasChunk(key), true);
      }
      assert.equal(await store.getProject('missing'), null);
      assert.equal(await store.getChunk('missing/times'), undefined);
      assert.equal(await store.hasChunk('missing/times'), false);
    });
  });

  T.test('localStore: the list is sorted by the change time, newest first', async () => {
    if (!haveIdb) return;
    await withStore(async store => {
      const a = P.createProject({ name: 'a', now: '2026-01-01T00:00:00.000Z' });
      const b = P.createProject({ name: 'b', now: '2026-06-01T00:00:00.000Z' });
      const c = P.createProject({ name: 'c', now: '2026-03-01T00:00:00.000Z' });
      for (const p of [a, b, c]) await store.putProject(p);
      assert.same((await store.listProjects()).map(p => p.name), ['b', 'c', 'a']);
    });
  });

  T.test('localStore: delete removes the model and the chunks it names', async () => {
    if (!haveIdb) return;
    await withStore(async store => {
      const p = sampleProject(), keep = sampleProject();
      await store.putProject(p, chunksOf(p)); await store.putProject(keep, chunksOf(keep));
      await store.deleteProject(p.id);
      assert.equal(await store.getProject(p.id), null);
      for (const k of P.chunkKeys(p)) assert.equal(await store.hasChunk(k), false, 'deleted ' + k);
      for (const k of P.chunkKeys(keep)) assert.equal(await store.hasChunk(k), true, 'kept ' + k);
      await store.deleteProject('missing');
    });
  });

  T.test('localStore: putChunks, deleteChunks and meta values', async () => {
    if (!haveIdb) return;
    await withStore(async store => {
      await store.putChunks(new Map([['a/b', Uint8Array.from([1])], ['a/c', Uint8Array.from([2])]]));
      await store.putChunks(new Map());
      assert.equal((await store.getChunk('a/c'))[0], 2);
      await store.deleteChunks(['a/b']); await store.deleteChunks([]);
      assert.equal(await store.hasChunk('a/b'), false);
      assert.equal(await store.getMeta('current'), null);
      await store.setMeta('current', 'abc');
      assert.equal(await store.getMeta('current'), 'abc');
      await store.setMeta('current', { x: [1, 2] });
      assert.same(await store.getMeta('current'), { x: [1, 2] });
    });
  });

  T.test('localStore: a failed save changes nothing', async () => {
    if (!haveIdb) return;
    await withStore(async store => {
      const p = sampleProject();
      const bad = chunksOf(p); bad.set('x/y', () => 1);            // a function cannot be cloned
      const err = await expectReject(() => store.putProject(p, bad), /Browser-Speicher/, 'clone error');
      assert.equal(err.code, 'storage');
      assert.equal(await store.getProject(p.id), null, 'the model was not saved');
      assert.equal(await store.hasChunk(P.chunkKeys(p)[0]), false, 'no chunk was saved');
    });
  });

  T.test('localStore: two namespaces do not share data and a reopened database keeps its data', async () => {
    if (!haveIdb) return;
    const ns1 = namespace(), ns2 = namespace();
    const s1 = await L.open({ namespace: ns1 }), s2 = await L.open({ namespace: ns2 });
    const p = sampleProject();
    await s1.putProject(p, chunksOf(p));
    assert.equal(await s2.getProject(p.id), null);
    s1.close();
    const again = await L.open({ namespace: ns1 });
    assert.same(await again.getProject(p.id), p);
    again.close(); s2.close();
  });

  T.test('localStore: persist and estimate do not throw', async () => {
    const p = await L.requestPersist();
    assert.ok(p === true || p === false || p === null);
    const e = await L.estimate();
    assert.ok(e === null || (e.usage >= 0 && e.quota >= 0));
  });
})();
