/* Tests of GZ.chunkCodec.
   A column or a time axis must come back from a chunk exactly as it went in.
   The tests also check that a damaged chunk gives a clear error and never a wrong result without a warning. */
(function () {
  'use strict';
  const GZ = window.GZ, T = window.GZT, assert = T.assert;
  const C = GZ.chunkCodec, TB = GZ.table;
  const haveGzip = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

  /* ---------- helpers ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // Returns a message when two columns differ, else null.
  function diffColumn(a, b, label) {
    if (a.index !== b.index) return label + ': index ' + a.index + ' vs ' + b.index;
    if (a.kind !== b.kind) return label + ': kind ' + a.kind + ' vs ' + b.kind;
    if (a.data.constructor.BYTES_PER_ELEMENT !== b.data.constructor.BYTES_PER_ELEMENT) return label + ': element size';
    if (a.data.length !== b.data.length) return label + ': length ' + a.data.length + ' vs ' + b.data.length;
    for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return label + ': data[' + i + '] ' + a.data[i] + ' vs ' + b.data[i];
    if ((a.exc === null) !== (b.exc === null)) return label + ': exception list present on one side only';
    if (a.exc !== null) {
      if (JSON.stringify(Array.from(a.exc.idx)) !== JSON.stringify(Array.from(b.exc.idx))) return label + ': exception rows';
      if (JSON.stringify(Array.from(a.exc.tok)) !== JSON.stringify(Array.from(b.exc.tok))) return label + ': exception tokens';
      if (JSON.stringify(a.exc.tokens) !== JSON.stringify(b.exc.tokens)) return label + ': exception texts';
    }
    if (JSON.stringify(a.dict) !== JSON.stringify(b.dict)) return label + ': dictionary';
    return null;
  }
  function numeric(index, values, Type, exc) { return TB.createNumericColumn(index, Type.from(values), exc || null); }
  function roundTrip(col) { return C.deserializeColumn(C.serializeColumn(col)); }
  function expectColumn(col, label) {
    const d = diffColumn(col, roundTrip(col), label);
    assert.ok(d === null, d);
  }
  function expectThrows(fn, pattern, label) {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    assert.ok(err !== null, label + ': no error');
    assert.ok(err instanceof Error && pattern.test(err.message), label + ': wrong error: ' + (err && err.message));
  }

  /* ---------- plain round trips ---------- */
  T.test('chunkCodec: constant, countdown and toggle columns', () => {
    expectColumn(numeric(5, new Array(1000).fill(7), Uint8Array), 'constant');
    const countdown = []; for (let c = 0; c < 40; c++) for (let k = 30; k >= 0; k--) countdown.push(k);
    expectColumn(numeric(6, countdown, Uint8Array), 'countdown');
    const toggle = []; for (let i = 0; i < 500; i++) toggle.push(Math.floor(i / 7) % 2);
    expectColumn(numeric(7, toggle, Uint8Array), 'toggle');
    expectColumn(numeric(8, [0, 1, 0, 1, 0, 1, 1, 1, 0], Uint8Array), 'short alternation');
  });

  T.test('chunkCodec: value limits 0, 255, 256, 65535, 65536 and 4294967295', () => {
    expectColumn(numeric(0, [0, 255, 0, 255, 128], Uint8Array), 'u8 limits');
    expectColumn(numeric(1, [0, 255, 256, 65535, 65534, 0], Uint16Array), 'u16 limits');
    expectColumn(numeric(2, [65535, 65536, 65537, 0, 4294967295, 4294967294, 1], Uint32Array), 'u32 limits');
    expectColumn(numeric(3, [999999999, 0, 999999999, 1000000000], Uint32Array), 'u32 big');
  });

  T.test('chunkCodec: empty column, one row and two rows', () => {
    expectColumn(numeric(4, [], Uint8Array), 'empty u8');
    expectColumn(numeric(4, [], Uint32Array), 'empty u32');
    expectColumn(TB.createDictColumn(9, new Uint8Array(0), []), 'empty dict');
    expectColumn(numeric(4, [5], Uint8Array), 'one row');
    expectColumn(numeric(4, [65535], Uint16Array), 'one row u16');
    expectColumn(numeric(4, [3, 9], Uint8Array), 'two rows');
    expectColumn(numeric(4, [9, 3], Uint8Array), 'two rows down');
  });

  T.test('chunkCodec: columns with exceptions (INV, blank, other text)', () => {
    const exc = { idx: Uint32Array.from([2, 3, 9]), tok: Uint32Array.from([0, 0, 1]), tokens: ['INV', ''] };
    expectColumn(numeric(11, [5, 5, 0, 0, 5, 5, 5, 5, 5, 0, 5], Uint8Array, exc), 'exceptions inside a run');
    const first = { idx: Uint32Array.from([0, 1]), tok: Uint32Array.from([0, 0]), tokens: ['INV'] };
    expectColumn(numeric(11, [0, 0, 4, 5, 6], Uint8Array, first), 'exceptions at the start');
    const last = { idx: Uint32Array.from([3, 4]), tok: Uint32Array.from([0, 1]), tokens: ['INV', 'x y ✓'] };
    expectColumn(numeric(11, [9, 8, 7, 0, 0], Uint8Array, last), 'exceptions at the end');
    const all = { idx: Uint32Array.from([0, 1, 2]), tok: Uint32Array.from([0, 0, 0]), tokens: ['INV'] };
    expectColumn(numeric(11, [0, 0, 0], Uint8Array, all), 'only exceptions');
    const hole = { idx: Uint32Array.from([2]), tok: Uint32Array.from([0]), tokens: ['INV'] };
    expectColumn(numeric(11, [250, 251, 0, 253, 254], Uint8Array, hole), 'run that goes past the range at the hole');
  });

  T.test('chunkCodec: dictionary columns', () => {
    expectColumn(TB.createDictColumn(3, Uint8Array.from([0, 1, 1, 0, 2, 2, 2]), ['ab', 'ü✓', '😀']), 'dict u8');
    const codes = new Uint16Array(600); for (let i = 0; i < 600; i++) codes[i] = i % 300;
    const dict = []; for (let i = 0; i < 300; i++) dict.push('t' + i);
    expectColumn(TB.createDictColumn(3, codes, dict), 'dict u16');
    expectColumn(TB.createDictColumn(3, Uint32Array.from([0, 1]), ['a', 'b']), 'dict u32');
  });

  T.test('chunkCodec: random columns (all kinds, runs, noise and exceptions)', () => {
    const rnd = mulberry32(20260101);
    for (let round = 0; round < 300; round++) {
      const kind = Math.floor(rnd() * 3), Type = [Uint8Array, Uint16Array, Uint32Array][kind];
      const max = [255, 65535, 999999999][kind];
      const n = Math.floor(rnd() * 400);
      const v = []; let cur = Math.floor(rnd() * (max + 1));
      while (v.length < n) {
        const mode = rnd();
        const len = 1 + Math.floor(rnd() * 40);
        const step = mode < 0.4 ? 0 : mode < 0.7 ? -1 : mode < 0.85 ? 1 : Math.floor(rnd() * 7) - 3;
        for (let k = 0; k < len && v.length < n; k++) {
          cur = Math.max(0, Math.min(max, cur + step));
          if (rnd() < 0.03) cur = Math.floor(rnd() * (max + 1));
          v.push(cur);
        }
        if (rnd() < 0.2) cur = Math.floor(rnd() * (max + 1));
      }
      let exc = null;
      if (n > 0 && rnd() < 0.5) {
        const rows = []; for (let i = 0; i < n; i++) if (rnd() < 0.08) rows.push(i);
        if (rows.length) {
          rows.forEach(i => { v[i] = 0; });
          exc = { idx: Uint32Array.from(rows), tok: Uint32Array.from(rows.map(() => Math.floor(rnd() * 3))), tokens: ['INV', '', 'x'] };
        }
      }
      const col = numeric(Math.floor(rnd() * 200), v, Type, exc);
      const d = diffColumn(col, roundTrip(col), 'round ' + round);
      assert.ok(d === null, d);
    }
  });

  /* ---------- real recordings ---------- */
  function tableOf(text) { return GZ.csvImport.importText(text).table; }

  T.test('chunkCodec: every column of every fixture comes back exactly', () => {
    const all = Object.assign({}, T.allFixtures(), T.extraFixtures());
    let count = 0;
    Object.keys(all).forEach(name => {
      let table;
      try { table = tableOf(all[name]); } catch (e) { return; }
      table.columns.forEach(col => {
        const d = diffColumn(col, roundTrip(col), name + ' column ' + col.index);
        assert.ok(d === null, d);
        count++;
      });
    });
    assert.ok(count > 100, 'too few columns checked: ' + count);
  });

  T.test('chunkCodec: the text of every cell stays the same', () => {
    const table = tableOf(T.allFixtures().synthetic);
    table.columns.forEach(col => {
      const back = roundTrip(col);
      const a = TB.columnStrings(col), b = TB.columnStrings(back);
      assert.same(b, a, 'column ' + col.index);
    });
  });

  T.test('chunkCodec: the time axis of every fixture comes back exactly', () => {
    const all = Object.assign({}, T.allFixtures(), T.extraFixtures());
    Object.keys(all).forEach(name => {
      let table;
      try { table = tableOf(all[name]); } catch (e) { return; }
      const back = C.deserializeTimes(C.serializeTimes(table.times));
      assert.equal(back.length, table.times.length, name + ': length');
      for (let i = 0; i < back.length; i++) assert.ok(Object.is(back[i], table.times[i]), name + ': time ' + i);
    });
  });

  T.test('chunkCodec: a time axis with 1 Hz and gaps', () => {
    const t0 = Date.UTC(2026, 10, 3, 5, 0, 0);
    const times = [];
    for (let i = 0; i < 3600; i++) times.push(t0 + i * 1000);
    for (let i = 0; i < 100; i++) times.push(t0 + 4000000 + i * 1000);
    times.push(t0 + 4100000, t0 + 4100000, t0 + 1000);
    const f = Float64Array.from(times);
    const bytes = C.serializeTimes(f);
    const back = C.deserializeTimes(bytes);
    assert.same(Array.from(back), times);
    assert.ok(bytes.length < 60, 'time axis needs ' + bytes.length + ' bytes');
    assert.equal(C.deserializeTimes(C.serializeTimes(new Float64Array(0))).length, 0);
    assert.same(Array.from(C.deserializeTimes(C.serializeTimes(Float64Array.from([t0])))), [t0]);
  });

  T.test('chunkCodec: a time axis with fractions or NaN uses plain storage', () => {
    const f = Float64Array.from([1000.5, 2000, NaN, 3000.25, -5]);
    const back = C.deserializeTimes(C.serializeTimes(f));
    assert.equal(back.length, 5);
    for (let i = 0; i < 5; i++) assert.ok(Object.is(back[i], f[i]), 'value ' + i);
  });

  T.test('chunkCodec: a one-day recording gives small chunks', () => {
    const table = tableOf(T.allFixtures().synthetic);
    let total = 0, plain = 0;
    table.columns.forEach(col => { total += C.serializeColumn(col).length; plain += col.data.length; });
    assert.ok(total < plain, 'segments alone must be smaller than one byte for each row: ' + total + ' vs ' + plain);
    const timesBytes = C.serializeTimes(table.times).length;
    assert.ok(timesBytes < 40, 'the time axis needs ' + timesBytes + ' bytes');
  });

  /* ---------- damaged chunks ---------- */
  T.test('chunkCodec: header errors', () => {
    const good = C.serializeColumn(numeric(1, [1, 2, 3], Uint8Array));
    const copy = (i, v) => { const b = good.slice(); b[i] = v; return b; };
    expectThrows(() => C.deserializeColumn(copy(0, 0)), /magic/, 'magic');
    expectThrows(() => C.deserializeColumn(copy(1, 0)), /magic/, 'magic 2');
    expectThrows(() => C.deserializeColumn(copy(2, 9)), /version 9/, 'version');
    expectThrows(() => C.deserializeColumn(copy(3, 2)), /chunk type/, 'type');
    expectThrows(() => C.deserializeColumn(copy(4, 7)), /packing/, 'packing');
    expectThrows(() => C.deserializeColumn(copy(4, 1)), /gzip/, 'gzip flag on plain bytes');
    expectThrows(() => C.deserializeTimes(good), /chunk type/, 'column as times');
    expectThrows(() => C.deserializeColumn([1, 2, 3]), /byte array/, 'not bytes');
    expectThrows(() => C.deserializeColumn(new Uint8Array(0)), /ends too early/, 'empty');
  });

  T.test('chunkCodec: every shortened chunk gives an error', () => {
    const exc = { idx: Uint32Array.from([2, 5]), tok: Uint32Array.from([0, 1]), tokens: ['INV', 'ü'] };
    const cols = [numeric(300, [1, 2, 3, 3, 3, 0, 9, 8, 7], Uint8Array, exc), TB.createDictColumn(2, Uint8Array.from([0, 1, 1]), ['a', 'bé'])];
    cols.forEach(col => {
      const good = C.serializeColumn(col);
      for (let len = 0; len < good.length; len++) {
        let err = null;
        try { C.deserializeColumn(good.subarray(0, len)); } catch (e) { err = e; }
        assert.ok(err instanceof Error, 'length ' + len + ' of ' + good.length + ' gave no error');
      }
    });
    const tg = C.serializeTimes(Float64Array.from([0, 1000, 2000, 5000]));
    for (let len = 0; len < tg.length; len++) {
      let err = null;
      try { C.deserializeTimes(tg.subarray(0, len)); } catch (e) { err = e; }
      assert.ok(err instanceof Error, 'time chunk length ' + len + ' gave no error');
    }
  });

  T.test('chunkCodec: random damage gives an error or a valid column, never a crash', () => {
    const rnd = mulberry32(777);
    const exc = { idx: Uint32Array.from([2, 5]), tok: Uint32Array.from([0, 1]), tokens: ['INV', 'ü'] };
    const goods = [
      C.serializeColumn(numeric(3, [1, 2, 3, 3, 3, 0, 9, 8, 7, 7, 7, 7], Uint8Array, exc)),
      C.serializeColumn(TB.createDictColumn(2, Uint8Array.from([0, 1, 1, 0]), ['a', 'bé'])),
      C.serializeTimes(Float64Array.from([0, 1000, 2000, 5000, 6000]))
    ];
    let errors = 0, valid = 0;
    for (let round = 0; round < 3000; round++) {
      const g = goods[round % 3], b = g.slice();
      const hits = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < hits; k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      try {
        if (round % 3 === 2) { const t = C.deserializeTimes(b); assert.ok(t instanceof Float64Array); } else {
          const c = C.deserializeColumn(b);
          // A column that decodes must be valid: every value in range, every code in the dictionary.
          const max = c.kind === 'u8' ? 255 : c.kind === 'u16' ? 65535 : 4294967295;
          for (let i = 0; i < c.data.length; i++) {
            assert.ok(c.data[i] <= max);
            if (c.kind === 'dict') assert.ok(c.data[i] < c.dict.length, 'code outside the dictionary');
          }
        }
        valid++;
      } catch (e) {
        assert.ok(e instanceof Error && /^chunk: /.test(e.message), 'unexpected error: ' + e.message);
        errors++;
      }
    }
    assert.ok(errors > 100, 'the damage test found only ' + errors + ' errors');
  });

  T.test('chunkCodec: a huge row count is refused before memory is used', () => {
    // payload: index 0, kind u8, width 0, row count 2^40 (a varint of 6 bytes)
    const w = [0x47, 0x5A, 1, 1, 0, 0, 0, 0, 0x80, 0x80, 0x80, 0x80, 0x80, 0x20, 0];
    expectThrows(() => C.deserializeColumn(Uint8Array.from(w)), /too many rows|too large/, 'row count');
    const t = [0x47, 0x5A, 1, 2, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F, 0];
    expectThrows(() => C.deserializeTimes(Uint8Array.from(t)), /too many rows/, 'time row count');
  });

  /* ---------- gzip ---------- */
  T.test('chunkCodec: gzip round trip for columns and the time axis', async () => {
    if (!haveGzip) return;
    const table = tableOf(T.allFixtures().synthetic);
    for (const col of table.columns.slice(0, 40)) {
      const bytes = await C.encodeColumn(col);
      const back = await C.decodeColumn(bytes);
      const d = diffColumn(col, back, 'column ' + col.index);
      assert.ok(d === null, d);
    }
    const tb = await C.encodeTimes(table.times);
    const times = await C.decodeTimes(tb);
    assert.equal(times.length, table.times.length);
    for (let i = 0; i < times.length; i++) assert.ok(times[i] === table.times[i], 'time ' + i);
  });

  T.test('chunkCodec: gzip makes a repeating countdown column much smaller', async () => {
    if (!haveGzip) return;
    const v = []; for (let c = 0; c < 2880; c++) for (let k = 30; k >= 0; k--) v.push(k);
    const col = numeric(1, v, Uint8Array);
    const plain = C.serializeColumn(col).length, packed = (await C.encodeColumn(col)).length;
    assert.ok(packed < plain / 10, 'packed ' + packed + ' bytes, plain ' + plain + ' bytes');
    assert.ok(packed < 200, 'packed size ' + packed);
    const d = diffColumn(col, await C.decodeColumn(await C.encodeColumn(col)), 'countdown');
    assert.ok(d === null, d);
  });

  T.test('chunkCodec: damaged gzip data gives an error', async () => {
    if (!haveGzip) return;
    const v = []; for (let c = 0; c < 500; c++) for (let k = 30; k >= 0; k--) v.push(k);
    const bytes = await C.encodeColumn(numeric(1, v, Uint8Array));
    assert.equal(bytes[4], 1, 'the chunk must be gzip packed');
    const bad = bytes.slice(); bad[bad.length - 3] ^= 0xFF;
    let err = null;
    try { await C.decodeColumn(bad); } catch (e) { err = e; }
    assert.ok(err instanceof Error && /^chunk: /.test(err.message), 'error: ' + (err && err.message));
    err = null;
    try { await C.decodeColumn(bytes.subarray(0, bytes.length - 8)); } catch (e) { err = e; }
    assert.ok(err instanceof Error && /^chunk: /.test(err.message), 'truncated: ' + (err && err.message));
  });
})();
