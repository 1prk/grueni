/* GZ.recordingCodec turns an imported recording into chunks and back (io layer, no DOM).

   encode(parsed, opts) takes the result of GZ.csvImport (the field `table` must exist).
   It returns { recording, chunks }.
   - recording is the model entry for GZ.project (header, row count, time range, chunk names).
   - chunks is a Map from the chunk name to the bytes (see GZ.chunkCodec).
   The chunks are: the time axis, one chunk for each value column, the cycle starts, and the filled-in TC and SP texts.
   decode(recording, getChunk) is the opposite. getChunk(name) must return a promise for the bytes of a chunk.
   The result has the same fields as the result of GZ.csvImport, so the application can use it like a new import.

   The header keeps the column descriptions (name, kuerzel, type and so on). They are plain data. */
GZ.define('recordingCodec', { layer: 'io', deps: ['chunkCodec', 'project', 'table'] }, function (GZ) {
  'use strict';
  const C = GZ.chunkCodec, P = GZ.project, T = GZ.table;

  // A list of texts becomes a dictionary column. Equal texts share a code.
  function textColumn(values) {
    const map = new Map(), dict = [], n = values.length;
    const codes = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let c = map.get(values[i]);
      if (c === undefined) { c = dict.length; dict.push(values[i]); map.set(values[i], c); }
      codes[i] = c;
    }
    const data = dict.length <= 256 ? new Uint8Array(codes) : dict.length <= 65536 ? new Uint16Array(codes) : codes;
    return T.createDictColumn(0, data, dict);
  }

  // Makes the header a plain object that survives JSON. Throws when it does not.
  function plain(value, what) {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error('recording: ' + what + ' cannot be saved');
    return JSON.parse(text);
  }

  async function encode(parsed, opts) {
    const o = opts || {};
    const table = parsed.table;
    if (!table || !table.times) throw new Error('recording: the import has no table');
    const n = table.rowCount;
    const chunks = new Map();
    const names = { times: 'times', cycles: 'cycles', tc: 'tc', spl: 'spl', columns: {} };

    chunks.set('times', await C.encodeTimes(table.times));
    chunks.set('cycles', await C.encodeTimes(Float64Array.from(parsed.cycleStarts)));
    chunks.set('tc', await C.encodeColumn(textColumn(parsed.tcValues)));
    chunks.set('spl', await C.encodeColumn(textColumn(parsed.splValues)));
    for (const col of table.columns) {
      const name = P.columnChunkName(col.index);
      names.columns[col.index] = name;
      chunks.set(name, await C.encodeColumn(col));
    }

    const recording = P.createRecording({
      name: o.name || o.fileName || 'Aufzeichnung', fileName: o.fileName || '', importedAt: o.importedAt,
      rowCount: n, tMin: n ? table.times[0] : 0, tMax: n ? table.times[n - 1] : 0,
      header: plain({
        columns: parsed.columns, otherColumns: parsed.otherColumns,
        knotenName: parsed.knotenName || '', knotenNr: parsed.knotenNr || '', totalRows: parsed.totalRows, skippedRows: parsed.skippedRows
      }, 'the header'),
      chunks: names
    });
    return { recording, chunks };
  }

  async function decode(recording, getChunk) {
    const c = recording.chunks, h = recording.header;
    const times = await C.decodeTimes(await getChunk(c.times));
    if (times.length !== recording.rowCount) throw new Error('recording: the time axis has ' + times.length + ' rows and the recording has ' + recording.rowCount);
    const cycleStarts = Array.from(await C.decodeTimes(await getChunk(c.cycles)));
    const tcCol = await C.decodeColumn(await getChunk(c.tc));
    const splCol = await C.decodeColumn(await getChunk(c.spl));
    if (tcCol.data.length !== times.length || splCol.data.length !== times.length) throw new Error('recording: the TC or SP chunk has the wrong row count');
    const columns = [];
    for (const key of Object.keys(c.columns)) {
      const col = await C.decodeColumn(await getChunk(c.columns[key]));
      if (col.index !== Number(key)) throw new Error('recording: the chunk ' + c.columns[key] + ' has the column index ' + col.index);
      if (col.data.length !== times.length) throw new Error('recording: the chunk ' + c.columns[key] + ' has the wrong row count');
      columns.push(col);
    }
    columns.sort((a, b) => a.index - b.index);
    const table = T.createTable(times, columns);
    return {
      columns: h.columns, otherColumns: h.otherColumns,
      times: Array.from(times),
      splValues: T.columnStrings(splCol), tcValues: T.columnStrings(tcCol),
      totalRows: h.totalRows, skippedRows: h.skippedRows,
      knotenName: h.knotenName, knotenNr: h.knotenNr,
      cycleStarts, table
    };
  }

  return { encode, decode };
});
