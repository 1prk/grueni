/* Differential tests. GZ.csvImport must give the same result as GZ.parser.parseOcitText.
   This applies to every fixture, to every way to cut the bytes into chunks, and to random odd
   files.
   The old parser is the reference. */
(function () {
  'use strict';
  const GZ = window.GZ, T = window.GZT, assert = T.assert;
  const enc = new TextEncoder();
  const F = T.fixtures;

  /* ---------- comparison ---------- */
  function snapshot(r) {
    const series = {};
    r.seriesByCol.forEach((arr, idx) => { series[idx] = Array.prototype.slice.call(arr); });
    return {
      columns: r.columns, otherColumns: r.otherColumns, times: Array.prototype.slice.call(r.times), series,
      splValues: r.splValues, tcValues: r.tcValues, totalRows: r.totalRows, skippedRows: r.skippedRows,
      knotenName: r.knotenName, knotenNr: r.knotenNr, cycleStarts: r.cycleStarts
    };
  }
  function diffValue(path, x, y) {
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) return path + ': length ' + x.length + ' vs ' + y.length;
      for (let i = 0; i < x.length; i++) {
        if (!Object.is(x[i], y[i]) && JSON.stringify(x[i]) !== JSON.stringify(y[i])) return path + '[' + i + ']: ' + JSON.stringify(x[i]) + ' vs ' + JSON.stringify(y[i]);
      }
      return null;
    }
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      const keys = Array.from(new Set(Object.keys(x).concat(Object.keys(y))));
      for (const k of keys) { const d = diffValue(path + '.' + k, x[k], y[k]); if (d) return d; }
      return null;
    }
    return Object.is(x, y) ? null : path + ': ' + JSON.stringify(x) + ' vs ' + JSON.stringify(y);
  }
  function reference(text) {
    try { return { ok: snapshot(GZ.parser.parseOcitText(text)) }; } catch (e) { return { error: e.message }; }
  }
  // chunk: 0 means one piece. Any other number is the size of each piece in bytes.
  function candidate(text, chunk) {
    const bytes = enc.encode(text);
    try {
      let r;
      if (!chunk) r = GZ.csvImport.importBytes(bytes);
      else {
        const imp = new GZ.csvImport.Importer({ sizeHint: chunk % 2 ? bytes.length : 0 });
        for (let i = 0; i < bytes.length; i += chunk) imp.push(bytes.subarray(i, i + chunk));
        r = imp.finish();
      }
      return { ok: snapshot(r), raw: r };
    } catch (e) { return { error: e.message }; }
  }
  function expectSame(label, text, chunk) {
    const ref = reference(text), got = candidate(text, chunk);
    if (ref.error !== undefined || got.error !== undefined) {
      assert.equal(got.error, ref.error, label + ': error message');
      return;
    }
    const d = diffValue('result', ref.ok, got.ok);
    assert.ok(d === null, label + ': ' + d);
  }

  /* ---------- extra fixtures ---------- */
  const pad2 = n => (n < 10 ? '0' : '') + n;
  const KV = [{ type: 'veh', name: 'K1' }, { type: 'single_loop', name: 'IS1' }, { type: 'ta', name: 'TA1' }];
  function rowsWith(n, make) { const r = []; for (let i = 0; i < n; i++) r.push(make(i, F.clock(i))); return r; }
  const sg = i => (i % 20 < 8 ? 48 : i % 20 < 11 ? 12 : i % 20 < 18 ? 3 : 15);

  function extras() {
    const x = {};
    x.fourDigitYear = F.build({ cols: KV, rows: rowsWith(40, (i, c) => [c[0].slice(0, 6) + '2026', c[1], i % 20, '', '', sg(i), i % 2, 30 - i % 30]) });
    x.oneDigitHour = F.build({ cols: KV, rows: rowsWith(40, (i, c) => [c[0], c[1].replace(/^0/, ''), i % 20, '', '', sg(i), i % 2, 5]) });
    x.dstSpring = F.build({ cols: KV, rows: [['29.03.26', '01:59:58'], ['29.03.26', '02:00:00'], ['29.03.26', '02:30:00'], ['29.03.26', '03:00:00'], ['29.03.26', '03:00:01'], ['28.03.26', '23:59:59'], ['30.03.26', '00:00:00']]
      .map((t, i) => [t[0], t[1], i, '', '', 48, 1, 7]) });
    x.dstAutumn = F.build({ cols: KV, rows: [['25.10.26', '01:59:58'], ['25.10.26', '02:00:00'], ['25.10.26', '02:30:00'], ['25.10.26', '03:00:00'], ['25.10.26', '03:00:01'], ['24.10.26', '23:59:59'], ['26.10.26', '00:00:00']]
      .map((t, i) => [t[0], t[1], i, '', '', 48, 1, 7]) });
    x.oddTimes = F.build({ cols: KV, rows: [['31.02.26', '06:00:00'], ['03.13.26', '06:00:00'], ['03.11.26', '24:00:00'], ['03.11.26', '06:61:00'], ['03.11.26', '06:00:75'],
      ['00.00.00', '00:00:00'], ['03.11.0099', '06:00:00'], ['03.11.26 06:00:00', ''], ['3.11.26', '06:00:00'], ['03.11.26', '06:00']]
      .map((t, i) => [t[0], t[1], i, '', '', 48, 1, 7]) });
    x.quotesInData = F.build({ cols: KV, rows: rowsWith(30, (i, c) => [c[0], c[1], i % 20, '', '', i % 5 === 0 ? '"48"' : i % 7 === 0 ? 'a"b' : sg(i), i % 3 === 0 ? '"1' + '\t' + '0"' : 1, 5]) });
    x.carriageReturnInside = F.build({ cols: KV, rows: rowsWith(30, (i, c) => [c[0], c[1], i % 20, '', '', i % 4 === 0 ? '4\r8' : sg(i), i % 6 === 0 ? '\r' : 1, 5]) });
    x.mixedDelimiters = (function () {
      const base = F.build({ cols: KV, rows: [] });
      const rows = rowsWith(40, (i, c) => [c[0], c[1], i % 20, '', '', sg(i), i % 2, 9].join(i % 5 === 0 ? ',' : '\t'));
      return base + rows.join('\n') + '\n';
    })();
    x.numberZoo = F.build({ cols: KV, rows: ['0', '00', '000', '7', '07', '+5', '-1', '1.5', '1e3', '0x10', ' 8 ', '12345678', '123456789', '999999999', '1000000000', '4294967295', '4294967296', '65534', '65535', '65536', '', ' ', ' 5', 'Ünï', '✓', '😀', 'INV', 'inv']
      .map((v, i) => { const c = F.clock(i); return [c[0], c[1], i % 20, '', '', v, v, v]; }) });
    x.shortRows = F.build({ cols: KV, rows: rowsWith(30, (i, c) => (i % 4 === 0 ? [c[0], c[1]] : i % 4 === 1 ? [c[0], c[1], i, '', '', 48] : [c[0], c[1], i, '', '', 48, 1, 7])) });
    x.blankLines = (function () {
      const base = F.build({ cols: KV, rows: [] });
      const rows = rowsWith(20, (i, c) => [c[0], c[1], i, '', '', 48, 1, 7].join('\t'));
      const mixed = [];
      rows.forEach((r, i) => { mixed.push(r); if (i % 5 === 2) mixed.push(''); if (i % 7 === 3) mixed.push('   '); if (i % 9 === 4) mixed.push('\r'); });
      return base + mixed.join('\n') + '\n\n\r\n\n';
    })();
    x.onlyHeaderAndOneRow = F.build({ cols: KV, rows: [['03.11.26', '06:00:00', 0, '4', '12', 48, 1, 7]] });
    x.exactlySevenLines = F.build({ cols: KV, rows: [] });
    x.txTexts = F.build({ cols: KV, rows: ['0', '1', 'abc', '1.5', '1e1', '-1', '0', '3', '', ' ', '2', '0', '00', '007', '0', '5', '0', '0'].map((v, i) => { const c = F.clock(i); return [c[0], c[1], v, '', '', 48, 1, 7]; }) });
    x.tcSpFill = F.build({ cols: KV, rows: rowsWith(30, (i, c) => [c[0], c[1], i % 10, i === 3 ? ' 5 ' : i === 12 ? 'x y' : '', i === 4 ? '14' : i === 20 ? '' : i === 21 ? '12' : '', 48, 1, 7]) });
    x.mostlyBlankColumn = F.build({ cols: KV, rows: rowsWith(60, (i, c) => [c[0], c[1], i % 10, '', '', 48, i % 9 === 0 ? i : '', i % 11 === 0 ? 'INV' : '']) });
    x.bigValues = F.build({ cols: KV, rows: rowsWith(40, (i, c) => [c[0], c[1], i % 10, '', '', 48, i % 2 ? 65535 : 70000, i % 3 ? 999999999 : 3]) });
    x.noTrailingNewline = F.build({ cols: KV, rows: rowsWith(10, (i, c) => [c[0], c[1], i, '', '', 48, 1, 7]), noFinalEol: true });
    x.utf8Header = F.build({ longname: 'Knoten Köln-Süd ✓', no: '7', cols: [{ type: 'veh', name: 'K1', desc: 'Kfz Hauptrichtung – Süd' }], rows: rowsWith(10, (i, c) => [c[0], c[1], i, '', '', 48]) });
    return x;
  }
  let extraCache = null;
  const extra = () => extraCache || (extraCache = extras());
  T.extraFixtures = extra;

  /* ---------- tests ---------- */
  T.test('csvImport: the same result as parseOcitText for the golden fixtures', () => {
    const all = T.allFixtures();
    Object.keys(all).forEach(name => expectSame('fixture ' + name, all[name], 0));
  });
  T.test('csvImport: the same result for the extra fixtures', () => {
    const x = extra();
    Object.keys(x).forEach(name => expectSame('extra ' + name, x[name], 0));
  });
  T.test('csvImport: the same result for every cut into chunks (small fixtures)', () => {
    const all = Object.assign({}, T.allFixtures(), extra());
    const big = { sample: 1, synthetic: 1 };
    Object.keys(all).filter(n => !big[n]).forEach(name => {
      [1, 2, 3, 5, 17, 64].forEach(size => expectSame('chunk ' + size + ' ' + name, all[name], size));
    });
  });
  T.test('csvImport: the same result for chunks (large fixtures)', () => {
    const all = T.allFixtures();
    ['sample', 'synthetic'].forEach(name => [7, 100, 4096, 65536].forEach(size => expectSame('chunk ' + size + ' ' + name, all[name], size)));
  });

  // Random odd files.
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const TOKENS = ['0', '1', '3', '12', '48', '65534', '65535', '65536', '70000', '999999999', '1000000000', '', '', '', ' ', ' 3 ', 'INV', '+5', '-1', '1.5', '1e3', '007', '00', 'abc',
    'Ünï', '✓', '"q"', '"a\tb"', 'a"b', '5\r', '\r', 'x,y', '9 9'];
  const COLS6 = [{ type: 'veh', name: 'K1' }, { type: 'single_loop', name: 'IS1' }, { type: 'ta', name: 'TA1' }, { type: 'firmware', name: 'ST1' }, { type: 'pt_dir', name: 'W1' }, { type: 'ped', name: 'F1' }];
  function randomFile(seed) {
    const rand = mulberry32(seed);
    const pick = a => a[Math.floor(rand() * a.length)];
    const head = F.build({ cols: COLS6, rows: [], eol: rand() < 0.2 ? '\r\n' : '\n' });
    const n = 5 + Math.floor(rand() * 60);
    const lines = [];
    for (let i = 0; i < n; i++) {
      const c = F.clock(i);
      let date = c[0], time = c[1];
      const q = rand();
      if (q < 0.03) date = ''; else if (q < 0.06) date = 'xx'; else if (q < 0.08) time = '6:00:01'; else if (q < 0.10) { date = date.slice(0, 6) + '2026'; }
      const fields = [date, time, rand() < 0.15 ? pick(TOKENS) : i % 12, rand() < 0.9 ? '' : pick(TOKENS), rand() < 0.9 ? '' : pick(TOKENS)];
      for (let k = 0; k < 6; k++) fields.push(rand() < 0.7 ? pick(['0', '1', '3', '12', '48', '15']) : pick(TOKENS));
      if (rand() < 0.1) fields.length = 2 + Math.floor(rand() * 8);
      lines.push(fields.join(rand() < 0.06 ? ',' : '\t'));
      if (rand() < 0.04) lines.push('');
    }
    return head + lines.join(rand() < 0.2 ? '\r\n' : '\n') + (rand() < 0.5 ? '\n' : '');
  }
  T.test('csvImport: 300 random odd files give the same result, also in random chunks', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const text = randomFile(seed);
      expectSame('random file ' + seed, text, 0);
      expectSame('random file ' + seed + ' chunked', text, 1 + (seed % 23));
    }
  });

  T.test('csvImport: the result has the parseOcitText shape and a typed table', () => {
    const r = GZ.csvImport.importText(T.allFixtures().synthetic);
    assert.ok(Array.isArray(r.times), 'times is a plain array');
    assert.equal(r.table.rowCount, 3600);
    assert.ok(r.table.times instanceof Float64Array || r.table.times.length === 3600, 'table times');
    assert.equal(r.seriesByCol.size, 100);
    assert.equal(r.seriesByCol.get(99999), undefined);
    const copy = new Map(r.seriesByCol);
    assert.equal(copy.size, 100);
    assert.equal(copy.get(5).length, 3600);
    const kinds = {};
    r.table.columns.forEach(c => { kinds[c.kind] = (kinds[c.kind] || 0) + 1; });
    assert.ok(!kinds.dict && !kinds.u32, 'the synthetic recording needs only u8 and u16: ' + JSON.stringify(kinds));
    assert.ok(kinds.u8 > 0 && kinds.u16 > 0, 'both u8 and u16 columns exist: ' + JSON.stringify(kinds));
  });

  T.test('table: rawAt() and columnStrings() agree with the text for every cell', () => {
    ['tokens', 'numberZoo', 'bigValues', 'mostlyBlankColumn'].forEach(name => {
      const text = T.allFixtures()[name] || extra()[name];
      const r = GZ.csvImport.importText(text), ref = GZ.parser.parseOcitText(text);
      r.table.columns.forEach(col => {
        const strings = GZ.table.columnStrings(col), want = ref.seriesByCol.get(col.index);
        assert.equal(strings.length, want.length, name + ' col ' + col.index + ' length');
        for (let i = 0; i < want.length; i++) {
          assert.equal(strings[i], want[i], name + ' col ' + col.index + ' row ' + i + ' (columnStrings)');
          assert.equal(GZ.table.rawAt(col, i), want[i], name + ' col ' + col.index + ' row ' + i + ' (rawAt)');
        }
      });
    });
  });

  T.test('table: column kinds follow the largest value', () => {
    const r = GZ.csvImport.importText(extra().bigValues);
    const byIdx = i => r.table.byIndex.get(i);
    assert.equal(byIdx(5).kind, 'u8');        // 48
    assert.equal(byIdx(6).kind, 'u32');       // 70000
    assert.equal(byIdx(7).kind, 'u32');       // 999999999
  });
})();
