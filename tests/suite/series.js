/* Tests of GZ.series. Each function must give the same result as the text array version.
   The reference code reads the text of every row with GZ.table.columnStrings and applies the function to each row. */
(function () {
  'use strict';
  const GZ = window.GZ, T = window.GZT, assert = T.assert;
  const S = GZ.series, TB = GZ.table;

  // A small random number generator. The same seed gives the same columns.
  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }

  // Makes a column of the given kind with runs of equal values and some exception cells.
  function randomColumn(rand, kind, n) {
    const max = kind === 'u8' ? 255 : kind === 'u16' ? 65535 : 999999999;
    const Type = kind === 'u8' ? Uint8Array : kind === 'u16' ? Uint16Array : Uint32Array;
    const data = new Type(n);
    let v = Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) {
      if (rand() < 0.15) v = rand() < 0.6 ? Math.floor(rand() * 6) : Math.floor(rand() * (max + 1));
      data[i] = v;
    }
    const idx = [], tok = [], tokens = ['', 'INV', 'x1', '0.5'];
    for (let i = 0; i < n; i++) {
      if (rand() < 0.08) { idx.push(i); tok.push(Math.floor(rand() * tokens.length)); data[i] = 0; }
    }
    const exc = idx.length ? { idx: Uint32Array.from(idx), tok: Uint32Array.from(tok), tokens } : null;
    return TB.createNumericColumn(3, data, exc);
  }

  function randomStrings(rand, n) {
    const pool = ['', '0', '1', '48', 'INV', '16', 'abc', '2.5', '-3', '1e2'];
    const out = new Array(n);
    let c = pool[1];
    for (let i = 0; i < n; i++) { if (rand() < 0.2) c = pool[Math.floor(rand() * pool.length)]; out[i] = c; }
    return out;
  }

  const catSg = raw => (raw.toUpperCase() === 'INV' ? 'INV' : (Number.isFinite(Number(raw)) ? (Number(raw) === 0 ? 'ROT' : Number(raw) > 20 ? 'GRUEN' : 'GELB') : 'UNBEKANNT'));
  const isBusy = raw => { const v = Number(raw); return Number.isFinite(v) && v > 0; };

  function columnsFor(seed) {
    const rand = rng(seed), out = [];
    ['u8', 'u16', 'u32'].forEach(k => { out.push(randomColumn(rand, k, 400)); });
    out.push(S.fromStrings(randomStrings(rand, 400), 5));
    out.push(TB.createNumericColumn(1, new Uint8Array(400), null));
    out.push(TB.createNumericColumn(1, new Uint16Array(0), null));
    return out;
  }

  T.test('series: cats gives the category of each row and the code 0 for a blank cell', () => {
    for (let seed = 1; seed <= 60; seed++) {
      columnsFor(seed).forEach(col => {
        const raw = TB.columnStrings(col), r = S.cats(col, catSg);
        assert.equal(r.codes.length, raw.length);
        assert.equal(r.names[0], '');
        for (let i = 0; i < raw.length; i++) {
          const want = raw[i] === '' ? 0 : r.names.indexOf(catSg(raw[i]));
          assert.equal(r.codes[i], want, 'seed ' + seed + ' row ' + i + ' text "' + raw[i] + '"');
          if (raw[i] !== '') assert.ok(r.codes[i] > 0);
        }
        assert.equal(new Set(r.names).size, r.names.length, 'the names are unique');
      });
    }
  });

  T.test('series: cats calls the function once for each different text', () => {
    const col = S.fromStrings(['1', '1', '2', '', '2', '1', '3'], 0);
    const seen = [];
    S.cats(col, raw => { seen.push(raw); return raw; });
    assert.same(seen.slice().sort(), ['1', '2', '3']);
  });

  T.test('series: cats grows the code type for many categories', () => {
    const n = 70000, data = new Uint32Array(n);
    for (let i = 0; i < n; i++) data[i] = i;
    const col = TB.createNumericColumn(0, data, null);
    const r = S.cats(col, raw => 'c' + raw);
    assert.ok(r.codes instanceof Uint32Array, 'more than 65535 categories need 32 bit codes');
    assert.equal(r.names.length, n + 1);
    assert.equal(r.names[r.codes[69999]], 'c69999');
    const col2 = TB.createNumericColumn(0, Uint16Array.from({ length: 300 }, (_, i) => i), null);
    const r2 = S.cats(col2, raw => raw);
    assert.ok(r2.codes instanceof Uint16Array);
    assert.equal(r2.names[r2.codes[299]], '299');
    const r3 = S.cats(TB.createNumericColumn(0, Uint8Array.from({ length: 255 }, (_, i) => i), null), raw => raw);
    assert.ok(r3.codes instanceof Uint8Array, '255 categories fit in 8 bit codes');
  });

  T.test('series: flags equals the predicate for each row, also for blank cells', () => {
    for (let seed = 1; seed <= 60; seed++) {
      columnsFor(seed).forEach(col => {
        const raw = TB.columnStrings(col), f = S.flags(col, isBusy);
        assert.ok(f instanceof Uint8Array);
        for (let i = 0; i < raw.length; i++) assert.equal(f[i], isBusy(raw[i]) ? 1 : 0, 'seed ' + seed + ' row ' + i);
        const g = S.flags(col, r => r === '');
        for (let i = 0; i < raw.length; i++) assert.equal(g[i], raw[i] === '' ? 1 : 0);
      });
    }
  });

  T.test('series: anyFlag is the OR of the flags', () => {
    const cols = columnsFor(7).filter(c => c.data.length === 400);
    const f = S.anyFlag(cols, isBusy), raws = cols.map(TB.columnStrings);
    for (let i = 0; i < 400; i++) assert.equal(f[i], raws.some(r => isBusy(r[i])) ? 1 : 0);
    assert.equal(S.anyFlag([], isBusy).length, 0);
    const none = S.anyFlag([], isBusy, 5);
    assert.same(Array.from(none), [0, 0, 0, 0, 0]);
  });

  T.test('series: numberAt keeps the last value that was not blank', () => {
    for (let seed = 1; seed <= 60; seed++) {
      columnsFor(seed).forEach(col => {
        const raw = TB.columnStrings(col), at = S.numberAt(col);
        let last = '';
        for (let i = 0; i < raw.length; i++) {
          if (raw[i] !== '') last = raw[i];
          const want = last === '' ? NaN : (Number.isFinite(Number(last)) ? Number(last) : NaN);
          const got = at(i);
          assert.ok(Object.is(got, want) || got === want, 'seed ' + seed + ' row ' + i + ' got ' + got + ' want ' + want);
        }
      });
    }
  });

  T.test('series: rawGetter and rawAt give the raw text', () => {
    for (let seed = 1; seed <= 30; seed++) {
      columnsFor(seed).forEach(col => {
        const raw = TB.columnStrings(col), get = S.rawGetter(col);
        for (let i = 0; i < raw.length; i += 1) {
          assert.equal(get(i), raw[i]);
          if (i % 37 === 0) assert.equal(S.rawAt(col, i), raw[i]);
        }
      });
    }
  });

  T.test('series: a text array becomes a column and the same array gives the same column', () => {
    const arr = ['1', '', 'INV', '1', '48'];
    const col = S.of(arr);
    assert.equal(col.kind, 'dict');
    assert.same(TB.columnStrings(col), arr);
    assert.ok(S.of(arr) === col);
    assert.ok(S.of(col) === col);
    let threw = false;
    try { S.of(42); } catch (e) { threw = true; }
    assert.ok(threw, 'a number is not a series');
    const t = S.tableFromStrings(Float64Array.from([0, 1000, 2000]), new Map([[4, ['0', '1', '1']], [9, ['', '', '']]]));
    assert.equal(t.rowCount, 3);
    assert.same(TB.columnStrings(t.byIndex.get(4)), ['0', '1', '1']);
    assert.equal(t.byIndex.get(9).index, 9);
  });

  T.test('series: every column of the wide fixture gives the same result as the text array', () => {
    const text = T.allFixtures().synthetic;
    const p = GZ.csvImport.importText(text);
    p.table.columns.forEach(col => {
      const raw = TB.columnStrings(col);
      const r = S.cats(col, GZ.parser.categorizeDetRaw);
      for (let i = 0; i < raw.length; i += 97) {
        assert.equal(r.names[r.codes[i]], raw[i] === '' ? '' : GZ.parser.categorizeDetRaw(raw[i]));
      }
    });
  });
})();
