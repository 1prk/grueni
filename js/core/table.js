/* GZ.table has typed columns for time series recordings (domain layer, no DOM).

   A recording is a Table. A Table has one time axis (a Float64Array of ms)
   and one Column for each signal or detector column.
   Column kinds:
   - 'u8', 'u16' and 'u32': numbers from 0 to 999999999 in a typed array.
     A cell that is not a plain number is listed in `exc`. Examples are "INV" and an empty cell.
     The place of such a cell in `data` holds 0.
   - 'dict': text columns. `data` has a code for each row. `dict` has the different texts.
   A cell always has one raw text. This is the trimmed text of the CSV cell. rawAt() returns it.

   Column: { index, kind, data, exc, dict }
     index  the field number in the CSV (0-based)
     exc    null, or { idx: Uint32Array (rows, ascending), tok: Uint32Array (token numbers), tokens: string[] }
     dict   string[] for the kind 'dict', else null */
GZ.define('table', { layer: 'domain', deps: [] }, function (GZ) {
  'use strict';

  function createNumericColumn(index, data, exc) {
    const kind = data.BYTES_PER_ELEMENT === 1 ? 'u8' : data.BYTES_PER_ELEMENT === 2 ? 'u16' : 'u32';
    return { index, kind, data, exc: exc || null, dict: null };
  }
  function createDictColumn(index, codes, dict) {
    return { index, kind: 'dict', data: codes, exc: null, dict };
  }

  // Returns the row of the exception list that belongs to row i, or -1.
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

  // Returns the raw text of cell i.
  function rawAt(col, i) {
    if (col.kind === 'dict') return col.dict[col.data[i]];
    if (col.exc !== null) {
      const r = excRow(col, i);
      if (r >= 0) return col.exc.tokens[col.exc.tok[r]];
    }
    return String(col.data[i]);
  }

  // Returns all raw texts of a column as an array. Equal texts share one string.
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

  function createTable(times, columns) {
    return { rowCount: times.length, times, columns, byIndex: new Map(columns.map(c => [c.index, c])) };
  }

  // Returns a new table with extra columns. The extra columns replace a column with the same index.
  // The original table does not change. The data of the columns is shared.
  function withColumns(table, extra) {
    const byIndex = new Map(table.byIndex);
    extra.forEach(c => byIndex.set(c.index, c));
    const columns = table.columns.filter(c => byIndex.get(c.index) === c).concat(extra);
    return { rowCount: table.rowCount, times: table.times, columns, byIndex };
  }

  return { createNumericColumn, createDictColumn, createTable, withColumns, isException, rawAt, columnStrings };
});
