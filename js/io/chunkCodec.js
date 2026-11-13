/* GZ.chunkCodec turns the columns of a Table into compact byte chunks and back (io layer, no DOM).

   A chunk holds ONE column of ONE recording. A second kind of chunk holds the time axis.
   The caller keeps the chunks (for example in IndexedDB or in a project file).
   The caller decodes a chunk only when a view needs the column.

   Packing of the numbers: progression segments.
   A segment is a run of values that grow by a fixed step: value, value + step, value + 2 * step, ...
   The stream has three numbers for each segment:
     jump    first value of the segment minus the last value of the previous segment (the first segment uses 0)
     step    difference between two neighbour values in the segment (0 for a constant run)
     length  number of values minus 1
   A state column is a list of constant runs. A countdown is one run with step -1.
   The time axis at 1 Hz is one segment (start, step 1000 ms, row count). A gap in the data adds one segment.
   Equal segments repeat often (for example a countdown for each cycle).
   So gzip makes the stream much smaller.
   All numbers are zigzag varints (see putUInt and zigzag below).

   Rows with an exception (for example "INV") hold 0 in the table.
   The encoder replaces such a value with the value that continues the run. So the exception does not cut the run.
   The decoder sets those rows to 0 again.

   Chunk layout:
     byte 0-1  magic 0x47 0x5A ("GZ")
     byte 2    format version (1)
     byte 3    chunk type (1 = column, 2 = time axis)
     byte 4    packing (0 = plain, 1 = gzip)
     byte 5-   payload (gzip packed if byte 4 is 1)
   Column payload:  index, kind code (0 u8, 1 u16, 2 u32, 3 dict), code width (dict only), row count,
                    segment count, segments, exception count, exceptions, dictionary.
   Time payload:    mode (0 segments, 1 plain float64 values), row count, then the segments or the values.

   encodeColumn, decodeColumn, encodeTimes and decodeTimes return promises (gzip works with streams).
   serializeColumn, deserializeColumn, serializeTimes and deserializeTimes are the same without gzip. They are synchronous.
   A decoder throws an Error with a clear message when the bytes are not a valid chunk. */
(function (GZ) {
  'use strict';
  const T = GZ.table;

  const MAGIC0 = 0x47, MAGIC1 = 0x5A, VERSION = 1;
  const TYPE_COLUMN = 1, TYPE_TIMES = 2;
  const HEADER_SIZE = 5;
  const KIND_CODE = { u8: 0, u16: 1, u32: 2, dict: 3 };
  const KIND_NAME = ['u8', 'u16', 'u32', 'dict'];
  const KIND_MAX = [255, 65535, 4294967295];
  // A chunk cannot have more rows than this. The limit protects the decoder against a bad row count.
  const MAX_ROWS = 1 << 28;
  const MAX_SAFE = 9007199254740991;

  /* ---------- byte buffer ---------- */
  class ByteWriter {
    constructor(size) { this.buf = new Uint8Array(size || 1024); this.len = 0; }
    _grow(extra) {
      let cap = this.buf.length;
      while (cap < this.len + extra) cap *= 2;
      const b = new Uint8Array(cap);
      b.set(this.buf.subarray(0, this.len));
      this.buf = b;
    }
    byte(v) {
      if (this.len + 1 > this.buf.length) this._grow(1);
      this.buf[this.len++] = v;
    }
    // Writes an integer from 0 to 2^53 - 1 as a varint (7 bits in each byte, low bits first).
    uint(n) {
      if (this.len + 8 > this.buf.length) this._grow(8);
      const b = this.buf;
      if (n < 2147483648) {
        while (n >= 128) { b[this.len++] = (n & 127) | 128; n >>>= 7; }
        b[this.len++] = n;
      } else {
        while (n >= 128) { b[this.len++] = (n % 128) | 128; n = Math.floor(n / 128); }
        b[this.len++] = n;
      }
    }
    bytes(a) {
      if (this.len + a.length > this.buf.length) this._grow(a.length);
      this.buf.set(a, this.len);
      this.len += a.length;
    }
    result() { return this.buf.slice(0, this.len); }
  }

  class ByteReader {
    constructor(buf, pos) { this.buf = buf; this.pos = pos || 0; }
    byte() {
      if (this.pos >= this.buf.length) throw new Error('chunk: data ends too early');
      return this.buf[this.pos++];
    }
    uint() {
      const b = this.buf;
      let pos = this.pos, n = 0, mul = 1;
      // A number from 0 to 2^53 - 1 needs 8 bytes at most.
      for (let k = 0; k < 8; k++) {
        if (pos >= b.length) throw new Error('chunk: data ends too early');
        const x = b[pos++];
        if (x < 128) {
          n += x * mul;
          if (n > MAX_SAFE) throw new Error('chunk: number is too large');
          this.pos = pos;
          return n;
        }
        n += (x & 127) * mul;
        mul *= 128;
      }
      throw new Error('chunk: number is too large');
    }
    bytes(n) {
      if (n < 0 || this.pos + n > this.buf.length) throw new Error('chunk: data ends too early');
      const a = this.buf.subarray(this.pos, this.pos + n);
      this.pos += n;
      return a;
    }
    atEnd() { return this.pos >= this.buf.length; }
  }

  const zigzag = n => (n >= 0 ? n * 2 : -n * 2 - 1);
  const unzigzag = z => (z % 2 === 0 ? z / 2 : -(z + 1) / 2);

  /* ---------- progression segments ---------- */
  // Writes the segments of v[0..n) to w. Returns the number of segments.
  function writeSegments(w, v, n) {
    let i = 0, prev = 0, count = 0;
    while (i < n) {
      const start = v[i];
      let step = 0, len = 1;
      if (i + 1 < n) {
        step = v[i + 1] - start;
        len = 2;
        while (i + len < n && v[i + len] - v[i + len - 1] === step) len++;
      }
      w.uint(zigzag(start - prev));
      w.uint(zigzag(step));
      w.uint(len - 1);
      prev = start + step * (len - 1);
      i += len;
      count++;
    }
    return count;
  }

  // Reads segCount segments. Returns { jump, step, len } arrays. Checks that the lengths add up to n.
  function readSegments(r, segCount, n) {
    if (segCount > n) throw new Error('chunk: more segments than rows');
    const jump = new Float64Array(segCount), step = new Float64Array(segCount), len = new Float64Array(segCount);
    let total = 0;
    for (let s = 0; s < segCount; s++) {
      jump[s] = unzigzag(r.uint());
      step[s] = unzigzag(r.uint());
      len[s] = r.uint() + 1;
      total += len[s];
      if (total > n) throw new Error('chunk: segments are longer than the row count');
    }
    if (total !== n) throw new Error('chunk: segments are shorter than the row count');
    return { jump, step, len };
  }

  // Fills out[0..n) from the segments. lo and hi are the allowed values (inclusive).
  // A progression has its smallest and largest value at its ends. So it is enough to check the ends.
  function expandSegments(seg, out, lo, hi) {
    const { jump, step, len } = seg;
    let pos = 0, prev = 0;
    for (let s = 0; s < len.length; s++) {
      const start = prev + jump[s], st = step[s], l = len[s];
      const last = start + st * (l - 1);
      if (start < lo || start > hi || last < lo || last > hi) throw new Error('chunk: a value is out of range');
      if (st === 0) out.fill(start, pos, pos + l);
      else for (let k = 0; k < l; k++) out[pos + k] = start + st * k;
      pos += l;
      prev = last;
    }
  }

  /* ---------- text ---------- */
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder('utf-8', { fatal: true });
  function writeStrings(w, list) {
    w.uint(list.length);
    for (let i = 0; i < list.length; i++) {
      const b = textEncoder.encode(list[i]);
      w.uint(b.length);
      w.bytes(b);
    }
  }
  function readStrings(r) {
    const n = r.uint();
    // Each text needs at least one byte for its length. This also stops a bad count before it uses memory.
    if (n > r.buf.length - r.pos) throw new Error('chunk: too many texts');
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const len = r.uint();
      try { out[i] = textDecoder.decode(r.bytes(len)); } catch (e) {
        if (/ends too early/.test(e.message)) throw e;
        throw new Error('chunk: a text is not valid UTF-8');
      }
    }
    return out;
  }

  /* ---------- column ---------- */
  function serializeColumnPayload(col) {
    if (!col || !KIND_NAME.includes(col.kind)) throw new Error('chunk: not a column');
    const n = col.data.length;
    if (n > MAX_ROWS) throw new Error('chunk: too many rows');
    if (!Number.isInteger(col.index) || col.index < 0) throw new Error('chunk: bad column index');
    const w = new ByteWriter(Math.max(256, n >> 3));
    w.uint(col.index);
    w.byte(KIND_CODE[col.kind]);
    w.byte(col.kind === 'dict' ? col.data.BYTES_PER_ELEMENT : 0);
    w.uint(n);

    let v = col.data;
    const exc = col.exc;
    if (exc !== null && exc !== undefined && exc.idx.length) {
      // Work on a copy. An exception row continues the run of the rows before it.
      v = Float64Array.from(col.data);
      for (let k = 0; k < exc.idx.length; k++) {
        const i = exc.idx[k];
        v[i] = i === 0 ? 0 : i === 1 ? v[0] : v[i - 1] + (v[i - 1] - v[i - 2]);
      }
    }
    const seg = new ByteWriter(256);
    const segCount = writeSegments(seg, v, n);
    w.uint(segCount);
    w.bytes(seg.buf.subarray(0, seg.len));

    if (exc !== null && exc !== undefined && exc.idx.length) {
      w.uint(exc.idx.length);
      let prev = 0;
      for (let k = 0; k < exc.idx.length; k++) { w.uint(exc.idx[k] - prev); prev = exc.idx[k]; }
      for (let k = 0; k < exc.tok.length; k++) w.uint(exc.tok[k]);
      writeStrings(w, exc.tokens);
    } else w.uint(0);

    if (col.kind === 'dict') writeStrings(w, col.dict);
    return w.result();
  }

  function deserializeColumnPayload(payload) {
    const r = new ByteReader(payload);
    const index = r.uint();
    const kc = r.byte();
    if (kc > 3) throw new Error('chunk: unknown column kind');
    const width = r.byte();
    const n = r.uint();
    if (n > MAX_ROWS) throw new Error('chunk: too many rows');
    const segCount = r.uint();
    const seg = readSegments(r, segCount, n);

    let data, hi;
    if (kc === 3) {
      if (width !== 1 && width !== 2 && width !== 4) throw new Error('chunk: bad code width');
      data = width === 1 ? new Uint8Array(n) : width === 2 ? new Uint16Array(n) : new Uint32Array(n);
      hi = KIND_MAX[width === 1 ? 0 : width === 2 ? 1 : 2];
    } else {
      if (width !== 0) throw new Error('chunk: bad code width');
      data = kc === 0 ? new Uint8Array(n) : kc === 1 ? new Uint16Array(n) : new Uint32Array(n);
      hi = KIND_MAX[kc];
    }
    // An exception row can hold a value outside the range. The encoder keeps the run. So use a wide buffer first.
    const excCount = r.uint();
    let exc = null;
    let wide = null;
    if (excCount > n) throw new Error('chunk: more exceptions than rows');
    if (excCount > 0) {
      const idx = new Uint32Array(excCount), tok = new Uint32Array(excCount);
      let prev = 0;
      for (let k = 0; k < excCount; k++) {
        prev += r.uint();
        if (prev >= n) throw new Error('chunk: exception row is out of range');
        if (k > 0 && prev === idx[k - 1]) throw new Error('chunk: exception rows repeat');
        idx[k] = prev;
      }
      for (let k = 0; k < excCount; k++) tok[k] = r.uint();
      const tokens = readStrings(r);
      for (let k = 0; k < excCount; k++) if (tok[k] >= tokens.length) throw new Error('chunk: bad exception token');
      exc = { idx, tok, tokens };
      wide = new Float64Array(n);
      expandSegments(seg, wide, -MAX_SAFE, MAX_SAFE);
      for (let k = 0; k < excCount; k++) wide[idx[k]] = 0;
      for (let i = 0; i < n; i++) if (wide[i] < 0 || wide[i] > hi) throw new Error('chunk: a value is out of range');
      data.set(wide);
    } else {
      expandSegments(seg, data, 0, hi);
    }

    let dict = null;
    if (kc === 3) {
      dict = readStrings(r);
      for (let i = 0; i < n; i++) if (data[i] >= dict.length) throw new Error('chunk: bad dictionary code');
    }
    if (!r.atEnd()) throw new Error('chunk: extra bytes at the end');
    return kc === 3 ? T.createDictColumn(index, data, dict) : Object.assign(T.createNumericColumn(index, data, exc), { kind: KIND_NAME[kc] });
  }

  /* ---------- time axis ---------- */
  function serializeTimesPayload(times) {
    const n = times.length;
    if (n > MAX_ROWS) throw new Error('chunk: too many rows');
    let integers = true;
    for (let i = 0; i < n; i++) {
      const t = times[i];
      if (!(t >= 0 && t <= MAX_SAFE / 2) || Math.floor(t) !== t) { integers = false; break; }
    }
    const w = new ByteWriter(Math.max(64, n >> 6));
    if (integers) {
      w.byte(0);
      w.uint(n);
      const seg = new ByteWriter(64);
      const segCount = writeSegments(seg, times, n);
      w.uint(segCount);
      w.bytes(seg.buf.subarray(0, seg.len));
    } else {
      w.byte(1);
      w.uint(n);
      const raw = new Uint8Array(n * 8);
      const dv = new DataView(raw.buffer);
      for (let i = 0; i < n; i++) dv.setFloat64(i * 8, times[i], true);
      w.bytes(raw);
    }
    return w.result();
  }

  function deserializeTimesPayload(payload) {
    const r = new ByteReader(payload);
    const mode = r.byte();
    const n = r.uint();
    if (n > MAX_ROWS) throw new Error('chunk: too many rows');
    const out = new Float64Array(n);
    if (mode === 0) {
      const seg = readSegments(r, r.uint(), n);
      expandSegments(seg, out, 0, MAX_SAFE);
    } else if (mode === 1) {
      const raw = r.bytes(n * 8);
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let i = 0; i < n; i++) out[i] = dv.getFloat64(i * 8, true);
    } else throw new Error('chunk: unknown time mode');
    if (!r.atEnd()) throw new Error('chunk: extra bytes at the end');
    return out;
  }

  /* ---------- gzip ---------- */
  const hasGzip = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

  // Sends the bytes through a stream transform and returns the result bytes.
  async function runStream(bytes, stream) {
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    // The write can fail when the data is bad. Then the read fails too. So keep the write error for later.
    let writeError = null;
    const written = writer.write(bytes).then(() => writer.close()).catch(e => { writeError = e; });
    const parts = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
    }
    await written;
    if (writeError !== null) throw writeError;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return out;
  }
  const gzip = bytes => runStream(bytes, new CompressionStream('gzip'));
  const gunzip = bytes => runStream(bytes, new DecompressionStream('gzip'));

  /* ---------- container ---------- */
  function wrap(type, packing, payload) {
    const out = new Uint8Array(HEADER_SIZE + payload.length);
    out[0] = MAGIC0; out[1] = MAGIC1; out[2] = VERSION; out[3] = type; out[4] = packing;
    out.set(payload, HEADER_SIZE);
    return out;
  }
  function unwrapHeader(bytes, type) {
    if (!ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1) throw new Error('chunk: the input is not a byte array');
    if (bytes.length < HEADER_SIZE) throw new Error('chunk: data ends too early');
    if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1) throw new Error('chunk: bad magic number');
    if (bytes[2] !== VERSION) throw new Error('chunk: unknown format version ' + bytes[2]);
    if (bytes[3] !== type) throw new Error('chunk: wrong chunk type');
    if (bytes[4] > 1) throw new Error('chunk: unknown packing');
    return bytes[4];
  }

  const serializeColumn = col => wrap(TYPE_COLUMN, 0, serializeColumnPayload(col));
  const serializeTimes = times => wrap(TYPE_TIMES, 0, serializeTimesPayload(times));
  function deserializeColumn(bytes) {
    if (unwrapHeader(bytes, TYPE_COLUMN) !== 0) throw new Error('chunk: the data is gzip packed, use decodeColumn');
    return deserializeColumnPayload(bytes.subarray(HEADER_SIZE));
  }
  function deserializeTimes(bytes) {
    if (unwrapHeader(bytes, TYPE_TIMES) !== 0) throw new Error('chunk: the data is gzip packed, use decodeTimes');
    return deserializeTimesPayload(bytes.subarray(HEADER_SIZE));
  }

  async function pack(type, payload) {
    if (hasGzip()) {
      const z = await gzip(payload);
      if (z.length < payload.length) return wrap(type, 1, z);
    }
    return wrap(type, 0, payload);
  }
  async function payloadOf(bytes, type) {
    const packing = unwrapHeader(bytes, type);
    const body = bytes.subarray(HEADER_SIZE);
    if (packing === 0) return body;
    if (!hasGzip()) throw new Error('chunk: this browser cannot read gzip data');
    try { return await gunzip(body); } catch (e) { throw new Error('chunk: the gzip data is damaged'); }
  }

  const encodeColumn = col => pack(TYPE_COLUMN, serializeColumnPayload(col));
  const encodeTimes = times => pack(TYPE_TIMES, serializeTimesPayload(times));
  const decodeColumn = async bytes => deserializeColumnPayload(await payloadOf(bytes, TYPE_COLUMN));
  const decodeTimes = async bytes => deserializeTimesPayload(await payloadOf(bytes, TYPE_TIMES));

  GZ.chunkCodec = {
    VERSION, encodeColumn, decodeColumn, encodeTimes, decodeTimes,
    serializeColumn, deserializeColumn, serializeTimes, deserializeTimes
  };
})(window.GZ = window.GZ || {});
