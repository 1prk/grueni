/* Tests of GZ.recordingCache. It must keep the recordings that the code used last. It must drop the others when the limit is reached. */
(function () {
  'use strict';
  const GZ = window.GZ, T = window.GZT, assert = T.assert;
  const RC = GZ.recordingCache;

  // A fake recording with a known size: one u8 column of n bytes, and no other data.
  const fake = n => ({ table: { times: new Float64Array(0), columns: [{ data: new Uint8Array(n), exc: null }] } });

  T.test('recordingCache: sizeOf counts the typed data of a real import', () => {
    const p = GZ.csvImport.importText(T.allFixtures().synthetic);
    const bytes = RC.sizeOf(p);
    // 3600 rows. 100 columns of 1 or 2 bytes. The time axis has 8 bytes for each row. Plus the arrays of times, SP, TC and cycles.
    assert.ok(bytes > 3600 * 100, 'bytes ' + bytes);
    assert.ok(bytes < 3600 * (100 * 2 + 8 + 4 * 8) + 4096, 'bytes ' + bytes);
    assert.equal(RC.sizeOf({}), 0);
  });

  T.test('recordingCache: the cache drops the recording that the code used least recently first', () => {
    const c = RC.create({ maxBytes: 300 });
    c.set('a', fake(100)); c.set('b', fake(100)); c.set('c', fake(100));
    assert.same(c.keys(), ['a', 'b', 'c']);
    assert.equal(c.bytes, 300);
    c.get('a');                                   // The code uses a again. So b is now the oldest.
    c.set('d', fake(100));
    assert.same(c.keys(), ['c', 'a', 'd']);
    assert.ok(!c.has('b'));
    assert.equal(c.size, 3);
    assert.equal(c.bytes, 300);
  });

  T.test('recordingCache: the last recording stays, also when it is above the limit', () => {
    const c = RC.create({ maxBytes: 100 });
    c.set('a', fake(60)); c.set('b', fake(500));
    assert.same(c.keys(), ['b']);
    assert.equal(c.bytes, 500);
    c.set('c', fake(10));
    assert.same(c.keys(), ['c']);
  });

  T.test('recordingCache: set replaces an entry and keeps the byte count right', () => {
    const c = RC.create({ maxBytes: 1000 });
    c.set('a', fake(100)); c.set('a', fake(40));
    assert.equal(c.size, 1);
    assert.equal(c.bytes, 40);
    c.delete('a');
    assert.equal(c.bytes, 0);
    c.set('b', fake(5)); c.clear();
    assert.equal(c.size, 0); assert.equal(c.bytes, 0);
    assert.equal(c.get('missing'), undefined);
  });

  T.test('recordingCache: a different sig drops the entry', () => {
    const c = RC.create({ maxBytes: 1000 });
    const rec = fake(10);
    c.set('a', rec, '3600:100');
    assert.ok(c.get('a', '3600:100') === rec);
    assert.ok(c.get('a') === rec, 'a call without sig does not check');
    assert.equal(c.get('a', '3600:999'), undefined);
    assert.ok(!c.has('a'));
    assert.equal(c.bytes, 0);
  });

  T.test('recordingCache: load calls the loader one time, also for two calls at the same time', async () => {
    const c = RC.create({ maxBytes: 1000 });
    let calls = 0;
    const loader = async () => { calls++; await Promise.resolve(); return fake(10); };
    const [x, y] = await Promise.all([c.load('a', loader, 's'), c.load('a', loader, 's')]);
    assert.ok(x === y);
    assert.equal(calls, 1);
    const z = await c.load('a', loader, 's');
    assert.ok(z === x);
    assert.equal(calls, 1, 'a cached recording needs no loader');
    const w = await c.load('a', loader, 'other');
    assert.ok(w !== x);
    assert.equal(calls, 2, 'another sig loads again');
  });

  T.test('recordingCache: a loader that fails leaves no entry and the next call tries again', async () => {
    const c = RC.create({ maxBytes: 1000 });
    let calls = 0;
    const bad = async () => { calls++; throw new Error('chunk missing'); };
    let msg = '';
    try { await c.load('a', bad); } catch (e) { msg = e.message; }
    assert.equal(msg, 'chunk missing');
    assert.ok(!c.has('a'));
    const good = await c.load('a', async () => fake(5));
    assert.ok(c.has('a'));
    assert.equal(good.table.columns[0].data.length, 5);
    assert.equal(calls, 1);
    let sync = '';
    try { await c.load('b', () => { throw new Error('thrown at once'); }); } catch (e) { sync = e.message; }
    assert.equal(sync, 'thrown at once');
  });

  T.test('recordingCache: the default limit is 256 MiB', () => {
    assert.equal(RC.DEFAULT_MAX_BYTES, 256 * 1024 * 1024);
    const c = RC.create();
    c.set('a', fake(10));
    assert.equal(c.size, 1);
  });
})();
