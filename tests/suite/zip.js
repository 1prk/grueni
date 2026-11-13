/* Tests of GZ.zip. A file that the module writes must come back exactly. A damaged file must give a clear error. */
(function () {
  'use strict';
  const GZ = window.GZ, T = window.GZT, assert = T.assert;
  const Z = GZ.zip;
  const haveStreams = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
  const enc = new TextEncoder();
  const bytesOf = (...v) => Uint8Array.from(v);
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  async function expectReject(promiseFn, pattern, label) {
    let err = null;
    try { await promiseFn(); } catch (e) { err = e; }
    assert.ok(err !== null, label + ': no error');
    assert.ok(err instanceof Error && pattern.test(err.message), label + ': wrong error: ' + (err && err.message));
  }

  T.test('zip: crc32 of known texts', () => {
    assert.equal(Z.crc32(enc.encode('123456789')), 0xCBF43926);
    assert.equal(Z.crc32(new Uint8Array(0)), 0);
    assert.equal(Z.crc32(enc.encode('a')), 0xE8B7BE43);
  });

  T.test('zip: entries come back exactly (stored)', async () => {
    const big = new Uint8Array(100000); const r = mulberry32(5); for (let i = 0; i < big.length; i++) big[i] = Math.floor(r() * 256);
    const input = [
      { name: 'project.json', data: enc.encode('{"a":1}') },
      { name: 'chunks/abc/times.chunk', data: bytesOf(1, 2, 3, 0, 255) },
      { name: 'empty.bin', data: new Uint8Array(0) },
      { name: 'größe/ü ✓.txt', data: enc.encode('Umlaute') },
      { name: 'big.bin', data: big }
    ];
    const zip = await Z.read(await Z.create(input));
    assert.same(zip.entries.map(e => e.name), input.map(e => e.name));
    for (const e of input) assert.ok(same(await zip.get(e.name), e.data), 'data of ' + e.name);
    assert.equal(zip.has('project.json'), true);
    assert.equal(zip.has('nope'), false);
  });

  T.test('zip: packed entries come back exactly and are smaller', async () => {
    if (!haveStreams) return;
    const text = enc.encode(JSON.stringify({ rows: new Array(2000).fill({ name: 'K1', value: 12345 }) }));
    const noise = new Uint8Array(500); const r = mulberry32(9); for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(r() * 256);
    const bytes = await Z.create([{ name: 'a.json', data: text, deflate: true }, { name: 'noise.bin', data: noise, deflate: true }, { name: 'e', data: new Uint8Array(0), deflate: true }]);
    assert.ok(bytes.length < text.length / 5, 'size ' + bytes.length + ' for ' + text.length);
    const zip = await Z.read(bytes);
    assert.ok(same(await zip.get('a.json'), text));
    assert.ok(same(await zip.get('noise.bin'), noise), 'noise stays stored or comes back');
    assert.equal((await zip.get('e')).length, 0);
  });

  T.test('zip: bad names and too many or double entries are refused when writing', async () => {
    const d = bytesOf(1);
    for (const name of ['', '/abs', 'a\\b', '../x', 'a/../b', 'a/..', 'x\u0001y']) {
      await expectReject(() => Z.create([{ name, data: d }]), /file name/, 'name ' + JSON.stringify(name));
    }
    await expectReject(() => Z.create([{ name: 'a', data: d }, { name: 'a', data: d }]), /twice/, 'double');
    await expectReject(() => Z.create([{ name: 'a', data: 'text' }]), /byte array/, 'not bytes');
    const many = []; for (let i = 0; i < 65536; i++) many.push({ name: 'f' + i, data: new Uint8Array(0) });
    await expectReject(() => Z.create(many), /too many entries/, 'many');
  });

  T.test('zip: a file that is not a ZIP file is refused', async () => {
    await expectReject(() => Z.read(new Uint8Array(0)), /too short/, 'empty');
    await expectReject(() => Z.read(enc.encode('this is a text file with some length to pass the size check')), /not a ZIP file/, 'text');
    await expectReject(() => Z.read('abc'), /byte array/, 'not bytes');
  });

  T.test('zip: every shortened file gives an error', async () => {
    const good = await Z.create([{ name: 'a.txt', data: enc.encode('hello') }, { name: 'b.txt', data: enc.encode('world') }]);
    for (let len = 0; len < good.length; len++) {
      let err = null;
      try { await Z.read(good.subarray(0, len)); } catch (e) { err = e; }
      assert.ok(err instanceof Error, 'length ' + len + ' of ' + good.length + ' gave no error');
    }
  });

  T.test('zip: damaged data is found by the checksum', async () => {
    const good = await Z.create([{ name: 'a.txt', data: enc.encode('hello world, hello world') }]);
    const bad = good.slice(); bad[30 + 5 + 3] ^= 0x20;
    const zip = await Z.read(bad);
    await expectReject(() => zip.get('a.txt'), /checksum/, 'flipped byte');
    await expectReject(() => (async () => (await Z.read(good)).get('missing'))(), /not in the ZIP/, 'missing entry');
  });

  T.test('zip: random damage gives an error or the same data, never a crash', async () => {
    const r = mulberry32(31337);
    const data = enc.encode('payload payload payload');
    const good = await Z.create([{ name: 'a.bin', data }, { name: 'dir/b.bin', data: bytesOf(1, 2, 3) }]);
    let errors = 0;
    for (let round = 0; round < 1500; round++) {
      const b = good.slice();
      for (let k = 0, n = 1 + Math.floor(r() * 3); k < n; k++) b[Math.floor(r() * b.length)] = Math.floor(r() * 256);
      try {
        const zip = await Z.read(b);
        for (const e of zip.entries) { const d = await zip.get(e.name); assert.ok(d instanceof Uint8Array); }
      } catch (e) {
        assert.ok(e instanceof Error && /^zip: /.test(e.message), 'unexpected error: ' + e.message);
        errors++;
      }
    }
    assert.ok(errors > 200, 'only ' + errors + ' errors');
  });

  T.test('zip: unsupported kinds and limits', async () => {
    const good = await Z.create([{ name: 'a.txt', data: enc.encode('hello') }]);
    const cd = good.length - 22 - (46 + 5);          // start of the central directory
    const patch = (offset, setter) => { const b = good.slice(); setter(new DataView(b.buffer), b); return b; };
    await expectReject(() => Z.read(patch(0, dv => dv.setUint16(cd + 8, 1, true))), /encrypted/, 'encrypted');
    await expectReject(() => Z.read(patch(0, dv => dv.setUint16(cd + 10, 12, true))), /method 12/, 'method');
    await expectReject(() => Z.read(patch(0, dv => dv.setUint32(cd + 24, 0xFFFFFFFF, true))), /ZIP64/, 'zip64');
    await expectReject(() => Z.read(patch(0, dv => dv.setUint16(good.length - 22 + 4, 1, true))), /several disks/, 'disks');
    await expectReject(() => Z.read(good, { maxEntrySize: 3 }), /larger than the limit/, 'entry limit');
    await expectReject(() => Z.read(good, { maxTotalSize: 3 }), /total size/, 'total limit');
    await expectReject(() => Z.read(patch(0, (dv, b) => { b[cd + 46] = 0x2F; })), /file name|directory|checksum|not in/, 'name with slash');
  });

  T.test('zip: a packed entry that is larger than its size in the directory is refused', async () => {
    if (!haveStreams) return;
    const text = enc.encode('x'.repeat(5000));
    const good = await Z.create([{ name: 'a.txt', data: text, deflate: true }]);
    const nameLen = 5, cdStart = good.length - 22 - (46 + nameLen);
    const bad = good.slice(); const dv = new DataView(bad.buffer);
    dv.setUint32(cdStart + 24, 100, true);               // the directory says 100 bytes
    const zip = await Z.read(bad);
    await expectReject(() => zip.get('a.txt'), /larger than its size/, 'bomb');
  });
})();
