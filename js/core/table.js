/* GZ.table - typed columns for time series recordings (domain layer, no DOM).

   A recording is a Table: one time axis (Float64Array of ms) and one Column per signal or detector column.
   Column kinds:
   - 'u8', 'u16', 'u32': numbers 0 .. 999999999 in a typed array. Cells that are not a plain number
     (for example "INV" or an empty cell) are listed in `exc`. Their place in `data` holds 0.
   - 'dict': text columns. `data` holds a code per row, `dict` holds the distinct texts.
   A cell always has one raw text (the trimmed text of the CSV cell). rawAt() returns it.

   Column: { index, kind, data, exc, dict }
     index  field number in the CSV (0 based)
     exc    null, or { idx: Uint32Array (rows, ascending), tok: Uint32Array (token numbers), tokens: string[] }
     dict   string[] for kind 'dict', else null */
(function (GZ) {
  'use strict';

  function createNumericColumn(index, data, exc) {
    const kind = data.BYTES_PER_ELEMENT === 1 ? 'u8' : data.BYTES_PER_ELEMENT === 2 ? 'u16' : 'u32';
    return { index, kind, data, exc: exc || null, dict: null };
  }
  function createDictColumn(index, codes, dict) {
    return { index, kind: 'dict', data: codes, exc: null, dict };
  }

  // Row of the exception list that belongs to row i, or -1.
  function excRow(col, i) {
    const idx = col.exc.idx;
    let lo = 0, hi = idx.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (idx[mid] < i) lo = mid + 1; else if (idx[mid] > i) hi = mid - 1; else return mid;
    }
    return -1;
  }

  function isException(col, i) {
    return col.exc !== null && excRow(col, i) >= 0;
  }

  // Raw text of cell i.
  function rawAt(col, i) {
    if (col.kind === 'dict') return col.dict[col.data[i]];
    if (col.exc !== null) {
      const r = excRow(col, i);
      if (r >= 0) return col.exc.tokens[col.exc.tok[r]];
    }
    return String(col.data[i]);
  }

  // All raw texts of a column as an array. Equal texts share one string.
  function columnStrings(col) {
    const data = col.data, n = data.length, out = new Array(n);
    if (col.kind === 'dict') {
      const d = col.dict;
      for (let i = 0; i < n; i++) out[i] = d[data[i]];
      return out;
    }
    if (col.kind === 'u32') {
      const cache = new Map();
      for (let i = 0; i < n; i++) {
        const v = data[i];
        let s = cache.get(v);
        if (s === undefined) { s = String(v); cache.set(v, s); }
        out[i] = s;
      }
    } else {
      const names = new Array(col.kind === 'u8' ? 256 : 65536);
      for (let i = 0; i < n; i++) {
        const v = data[i];
        out[i] = names[v] || (names[v] = String(v));
      }
    }
    if (col.exc !== null) {
      const e = col.exc;
      for (let k = 0; k < e.idx.length; k++) out[e.idx[k]] = e.tokens[e.tok[k]];
    }
    return out;
  }

  // Looks like the Map of text arrays that parseOcitText returns (key: CSV column, value: array of raw texts),
  // but builds each array only when it is asked for. get(), has(), forEach(), keys(), values(), entries() and
  // iteration work, so `new Map(series)` also works. releaseStrings() drops the built arrays.
  class LazySeriesMap {
    constructor(columns) {
      this._cols = new Map(columns.map(c => [c.index, c]));
      this._cache = new Map();
    }
    get size() { return this._cols.size; }
    has(key) { return this._cols.has(key); }
    get(key) {
      let a = this._cache.get(key);
      if (a === undefined) {
        const col = this._cols.get(key);
        if (col === undefined) return undefined;
        a = columnStrings(col);
        this._cache.set(key, a);
      }
      return a;
    }
    keys() { return this._cols.keys(); }
    * values() { for (const k of this._cols.keys()) yield this.get(k); }
    * entries() { for (const k of this._cols.keys()) yield [k, this.get(k)]; }
    forEach(fn, thisArg) { for (const k of this._cols.keys()) fn.call(thisArg, this.get(k), k, this); }
    [Symbol.iterator]() { return this.entries(); }
    releaseStrings() { this._cache.clear(); }
  }

  function createTable(times, columns) {
    return { rowCount: times.length, times, columns, byIndex: new Map(columns.map(c => [c.index, c])) };
  }

  GZ.table = { createNumericColumn, createDictColumn, createTable, isException, rawAt, columnStrings, LazySeriesMap };
})(window.GZ = window.GZ || {});
