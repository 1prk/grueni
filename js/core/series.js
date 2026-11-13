/* GZ.series gives the analyses numeric access to the columns of a GZ.table (domain layer, no DOM).

   The analyses used to read an array of texts for each column. A text array needs 8 bytes for each row.
   A series is a table column. The functions here work on the typed data of the column.
   Some functions need the meaning of a cell. They call a function of the caller for this (a category function or a predicate).
   They call it one time for each different cell text. They do not call it for each row.
   A lookup table keeps the result. So a day of 86400 rows costs a few calls.

   A cell text is the raw text of the cell. For a number it is the decimal text of the number.
   A blank cell has the raw text ''. A column of the kind 'u8', 'u16' or 'u32' keeps such a cell in its exception list.

   of(x)                       returns a column. A text array becomes a column of the kind 'dict'. A column stays as it is.
   fromStrings(arr, index)     makes a column of the kind 'dict' from a text array.
   tableFromStrings(times, m)  makes a table from a Map (index -> text array).
   cats(x, fn)                 { codes, names }. names[codes[i]] is the category of row i. The code 0 means a blank cell.
                               fn(raw) gives the category text of a non-blank cell.
   flags(x, pred)              Uint8Array. The value is 1 when pred(raw) is true. pred also gets the text '' for a blank cell.
   anyFlag(list, pred, rowCount) Uint8Array. The value is 1 when the flag of at least one column of the list is 1.
                               The list can be empty. Then the result has rowCount values and all are 0.
   numberAt(x)                 a function i -> number. A blank cell keeps the last value that was not blank.
                               The result is NaN when there is no such value or the value is not a finite number.
   rawGetter(x)                a function i -> text. It does not make a new string for each call.
   rawAt(x, i)                 the raw text of one cell. */
GZ.define('series', { layer: 'domain', deps: ['table'] }, function (GZ) {
  'use strict';
  const T = GZ.table;

  /* ---------- text arrays as columns ---------- */
  // A text array and its column. The same array gives the same column.
  const fromArrayCache = new WeakMap();

  function fromStrings(arr, index) {
    const n = arr.length, dict = [], codeOf = new Map();
    const codes = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const s = arr[i] == null ? '' : String(arr[i]);
      let c = codeOf.get(s);
      if (c === undefined) { c = dict.length; dict.push(s); codeOf.set(s, c); }
      codes[i] = c;
    }
    const small = dict.length <= 256 ? new Uint8Array(codes) : dict.length <= 65536 ? new Uint16Array(codes) : codes;
    return T.createDictColumn(index == null ? 0 : index, small, dict);
  }

  function of(x) {
    if (Array.isArray(x)) {
      let col = fromArrayCache.get(x);
      if (col === undefined) { col = fromStrings(x, 0); fromArrayCache.set(x, col); }
      return col;
    }
    if (x && typeof x === 'object' && x.data && x.kind) return x;
    throw new Error('series: the value is not a column and not a text array');
  }

  function tableFromStrings(times, map) {
    const cols = [];
    map.forEach((arr, index) => { cols.push(fromStrings(arr, index)); });
    return T.createTable(times, cols);
  }

  /* ---------- the core: one call of a function for each different cell text ---------- */
  // Writes f(raw) for each row to `out`. f gives a non-negative integer.
  // A run of equal values needs one lookup only.
  function mapRows(col, f, out) {
    const data = col.data, n = data.length;
    if (col.kind === 'dict') {
      const d = col.dict, m = new Array(d.length);
      for (let k = 0; k < d.length; k++) m[k] = f(d[k]);
      for (let i = 0; i < n; i++) out[i] = m[data[i]];
      return out;
    }
    const small = col.kind !== 'u32';
    const lutA = small ? new Array(col.kind === 'u8' ? 256 : 65536) : null;
    const lutM = small ? null : new Map();
    let pv = -1, pr = 0;
    for (let i = 0; i < n; i++) {
      const v = data[i];
      if (v !== pv) {
        let r = small ? lutA[v] : lutM.get(v);
        if (r === undefined) {
          r = f(String(v));
          if (small) lutA[v] = r; else lutM.set(v, r);
        }
        pv = v; pr = r;
      }
      out[i] = pr;
    }
    if (col.exc !== null) {
      const e = col.exc, memo = new Array(e.tokens.length);
      for (let k = 0; k < e.idx.length; k++) {
        const t = e.tok[k];
        let r = memo[t];
        if (r === undefined) { r = f(e.tokens[t]); memo[t] = r; }
        out[e.idx[k]] = r;
      }
    }
    return out;
  }

  /* ---------- categories ---------- */
  class CodeOverflow extends Error {}

  function catsWith(col, fn, Type, limit) {
    const names = [''], codeOf = new Map();
    const f = raw => {
      if (raw === '') return 0;
      const cat = fn(raw);
      let c = codeOf.get(cat);
      if (c === undefined) {
        c = names.length;
        if (c > limit) throw new CodeOverflow();
        names.push(cat); codeOf.set(cat, c);
      }
      return c;
    };
    const codes = mapRows(col, f, new Type(col.data.length));
    return { codes, names };
  }

  // Returns { codes, names }. See the header comment.
  // The code type grows when there are many categories (an APW column can have thousands).
  function cats(x, fn) {
    const col = of(x);
    try { return catsWith(col, fn, Uint8Array, 255); } catch (e) { if (!(e instanceof CodeOverflow)) throw e; }
    try { return catsWith(col, fn, Uint16Array, 65535); } catch (e) { if (!(e instanceof CodeOverflow)) throw e; }
    return catsWith(col, fn, Uint32Array, 4294967295);
  }

  /* ---------- flags ---------- */
  function flags(x, pred) {
    const col = of(x);
    return mapRows(col, raw => (pred(raw) ? 1 : 0), new Uint8Array(col.data.length));
  }

  // rowCount is the length of the result when the list is empty.
  function anyFlag(list, pred, rowCount) {
    if (!list.length) return new Uint8Array(rowCount || 0);
    const out = flags(list[0], pred);
    for (let k = 1; k < list.length; k++) {
      const f = flags(list[k], pred);
      for (let i = 0; i < out.length; i++) out[i] |= f[i];
    }
    return out;
  }

  /* ---------- numbers ---------- */
  function toNumber(raw) {
    if (raw === '') return NaN;
    const v = Number(raw);
    return Number.isFinite(v) ? v : NaN;
  }

  // A numeric column without exceptions needs no copy. Every other column gets a filled Float64Array.
  function numberAt(x) {
    const col = of(x);
    if (col.kind !== 'dict' && col.exc === null) {
      const data = col.data;
      return i => data[i];
    }
    const n = col.data.length, filled = new Float64Array(n);
    // blank[i] is 1 for a blank cell. value[i] is the number of the cell or NaN.
    const blank = mapRows(col, raw => (raw === '' ? 1 : 0), new Uint8Array(n));
    const value = new Float64Array(n);
    if (col.kind === 'dict') {
      const d = col.dict, m = new Float64Array(d.length);
      for (let k = 0; k < d.length; k++) m[k] = toNumber(d[k]);
      for (let i = 0; i < n; i++) value[i] = m[col.data[i]];
    } else {
      for (let i = 0; i < n; i++) value[i] = col.data[i];
      const e = col.exc;
      for (let k = 0; k < e.idx.length; k++) value[e.idx[k]] = toNumber(e.tokens[e.tok[k]]);
    }
    let last = NaN;
    for (let i = 0; i < n; i++) {
      if (!blank[i]) last = value[i];
      filled[i] = last;
    }
    return i => filled[i];
  }

  /* ---------- raw texts ---------- */
  function rawGetter(x) {
    const col = of(x), data = col.data;
    if (col.kind === 'dict') { const d = col.dict; return i => d[data[i]]; }
    const names = col.kind === 'u8' ? new Array(256) : col.kind === 'u16' ? new Array(65536) : null;
    const map = names ? null : new Map();
    const exc = col.exc;
    const excAt = exc === null ? null : new Map();
    if (exc !== null) for (let k = 0; k < exc.idx.length; k++) excAt.set(exc.idx[k], exc.tokens[exc.tok[k]]);
    return i => {
      if (excAt !== null) { const t = excAt.get(i); if (t !== undefined) return t; }
      const v = data[i];
      let s = names ? names[v] : map.get(v);
      if (s === undefined) { s = String(v); if (names) names[v] = s; else map.set(v, s); }
      return s;
    };
  }

  function rawAt(x, i) { return T.rawAt(of(x), i); }

  return { of, fromStrings, tableFromStrings, cats, flags, anyFlag, numberAt, rawGetter, rawAt };
});
