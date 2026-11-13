/* GZ.zip writes and reads ZIP files (io layer, no DOM).

   The project file is a ZIP. Any ZIP tool can open it. The module needs no library.

   create(entries, opts) -> Promise<Uint8Array>
     entries: [{ name, data: Uint8Array, deflate?: boolean }]
     An entry is stored without packing, unless deflate is true and packing makes it smaller.
     The chunks of the project are already gzip packed. So they stay stored.
     opts.now is the date for all entries (default: the current time).
   read(bytes, opts) -> Promise<{ entries: [{ name, size }], get(name) -> Promise<Uint8Array>, has(name) }>
     read() checks the structure of the file and throws an Error for a damaged or unsupported file.
     get() checks the CRC-32 of the entry. It throws an Error when the data is damaged.
     opts.maxEntrySize is the largest size of one entry (default 1 GiB).
     opts.maxTotalSize is the largest total size of all entries (default 3 GiB).
   crc32(bytes) -> number

   What the module supports: the methods 0 (stored) and 8 (deflate), file names in UTF-8, files up to 4 GiB - 1 and up to 65535 entries.
   What it refuses: ZIP64, encrypted entries, several disks, other methods.
   A file name must not be empty, must not start with "/" or contain "\", ".." or a control character. */
GZ.define('zip', { layer: 'io', deps: [] }, function (GZ) {
  'use strict';

  const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_END = 0x06054b50;
  const MAX_U32 = 0xFFFFFFFF, MAX_U16 = 0xFFFF;
  const FLAG_ENCRYPTED = 1, FLAG_DATA_DESCRIPTOR = 8, FLAG_UTF8 = 0x0800;
  const DEFAULT_MAX_ENTRY = 1024 * 1024 * 1024, DEFAULT_MAX_TOTAL = 3 * 1024 * 1024 * 1024;

  /* ---------- CRC-32 ---------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------- names ---------- */
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  function checkName(name) {
    if (typeof name !== 'string' || name === '') throw new Error('zip: empty file name');
    if (name[0] === '/' || name.includes('\\') || /(^|\/)\.\.(\/|$)/.test(name) || /[\u0000-\u001f]/.test(name)) throw new Error('zip: bad file name ' + JSON.stringify(name));
  }

  /* ---------- streams ---------- */
  const hasStreams = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

  async function runStream(bytes, stream, limit) {
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    // The write can fail when the data is bad. Then the read fails too. So keep the write error for later.
    let writeError = null;
    const written = writer.write(bytes).then(() => writer.close()).catch(e => { writeError = e; });
    const parts = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (limit !== undefined && total > limit) { reader.cancel().catch(() => {}); throw new Error('zip: an entry is larger than its size in the directory'); }
        parts.push(value);
      }
    } catch (e) {
      await written;
      throw e;
    }
    await written;
    if (writeError !== null) throw writeError;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return out;
  }
  const deflateRaw = bytes => runStream(bytes, new CompressionStream('deflate-raw'));
  const inflateRaw = (bytes, limit) => runStream(bytes, new DecompressionStream('deflate-raw'), limit);

  /* ---------- writer ---------- */
  function dosDateTime(d) {
    const year = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  async function create(entries, opts) {
    const when = dosDateTime((opts && opts.now) || new Date());
    if (entries.length > MAX_U16) throw new Error('zip: too many entries (' + entries.length + '), the limit is ' + MAX_U16);
    const seen = new Set();
    const prepared = [];
    let size = 22;
    for (const e of entries) {
      checkName(e.name);
      if (seen.has(e.name)) throw new Error('zip: the file name ' + e.name + ' is used twice');
      seen.add(e.name);
      if (!(e.data instanceof Uint8Array) && !ArrayBuffer.isView(e.data)) throw new Error('zip: the data of ' + e.name + ' is not a byte array');
      const raw = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
      let method = 0, body = raw;
      if (e.deflate && raw.length > 0 && hasStreams()) {
        const z = await deflateRaw(raw);
        if (z.length < raw.length) { method = 8; body = z; }
      }
      const name = encoder.encode(e.name);
      if (name.length > MAX_U16) throw new Error('zip: the file name is too long');
      prepared.push({ name, body, method, crc: crc32(raw), usize: raw.length });
      size += 30 + name.length + body.length + 46 + name.length;
    }
    if (size > MAX_U32) throw new Error('zip: the project is larger than 4 GiB. A ZIP file of this kind cannot hold it');

    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    let pos = 0;
    const offsets = [];
    for (const p of prepared) {
      offsets.push(pos);
      dv.setUint32(pos, SIG_LOCAL, true); dv.setUint16(pos + 4, 20, true); dv.setUint16(pos + 6, FLAG_UTF8, true); dv.setUint16(pos + 8, p.method, true);
      dv.setUint16(pos + 10, when.time, true); dv.setUint16(pos + 12, when.date, true);
      dv.setUint32(pos + 14, p.crc, true); dv.setUint32(pos + 18, p.body.length, true); dv.setUint32(pos + 22, p.usize, true);
      dv.setUint16(pos + 26, p.name.length, true); dv.setUint16(pos + 28, 0, true);
      out.set(p.name, pos + 30); out.set(p.body, pos + 30 + p.name.length);
      pos += 30 + p.name.length + p.body.length;
    }
    const cdStart = pos;
    prepared.forEach((p, i) => {
      dv.setUint32(pos, SIG_CENTRAL, true); dv.setUint16(pos + 4, 20, true); dv.setUint16(pos + 6, 20, true); dv.setUint16(pos + 8, FLAG_UTF8, true); dv.setUint16(pos + 10, p.method, true);
      dv.setUint16(pos + 12, when.time, true); dv.setUint16(pos + 14, when.date, true);
      dv.setUint32(pos + 16, p.crc, true); dv.setUint32(pos + 20, p.body.length, true); dv.setUint32(pos + 24, p.usize, true);
      dv.setUint16(pos + 28, p.name.length, true); dv.setUint16(pos + 30, 0, true); dv.setUint16(pos + 32, 0, true);
      dv.setUint16(pos + 34, 0, true); dv.setUint16(pos + 36, 0, true); dv.setUint32(pos + 38, 0, true); dv.setUint32(pos + 42, offsets[i], true);
      out.set(p.name, pos + 46);
      pos += 46 + p.name.length;
    });
    dv.setUint32(pos, SIG_END, true); dv.setUint16(pos + 4, 0, true); dv.setUint16(pos + 6, 0, true);
    dv.setUint16(pos + 8, prepared.length, true); dv.setUint16(pos + 10, prepared.length, true);
    dv.setUint32(pos + 12, pos - cdStart, true); dv.setUint32(pos + 16, cdStart, true); dv.setUint16(pos + 20, 0, true);
    return out;
  }

  /* ---------- reader ---------- */
  async function read(bytes, opts) {
    const o = opts || {};
    const maxEntry = o.maxEntrySize || DEFAULT_MAX_ENTRY, maxTotal = o.maxTotalSize || DEFAULT_MAX_TOTAL;
    if (!ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1) throw new Error('zip: the input is not a byte array');
    if (bytes.length < 22) throw new Error('zip: the file is too short for a ZIP file');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // The end record is in the last 22 + 65535 bytes.
    let end = -1;
    for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 22 - 65535); p--) {
      if (dv.getUint32(p, true) === SIG_END && p + 22 + dv.getUint16(p + 20, true) === bytes.length) { end = p; break; }
    }
    if (end < 0) throw new Error('zip: this is not a ZIP file (no end record)');
    const diskNo = dv.getUint16(end + 4, true), cdDisk = dv.getUint16(end + 6, true);
    const countHere = dv.getUint16(end + 8, true), count = dv.getUint16(end + 10, true);
    const cdSize = dv.getUint32(end + 12, true), cdOffset = dv.getUint32(end + 16, true);
    if (diskNo !== 0 || cdDisk !== 0 || countHere !== count) throw new Error('zip: ZIP files with several disks are not supported');
    if (count === MAX_U16 || cdSize === MAX_U32 || cdOffset === MAX_U32) throw new Error('zip: ZIP64 files are not supported');
    if (cdOffset + cdSize > end) throw new Error('zip: the directory is outside the file');

    const entries = new Map();
    let p = cdOffset, total = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cdOffset + cdSize || dv.getUint32(p, true) !== SIG_CENTRAL) throw new Error('zip: the directory is damaged');
      const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
      const crc = dv.getUint32(p + 16, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
      const offset = dv.getUint32(p + 42, true);
      if (p + 46 + nameLen + extraLen + commentLen > cdOffset + cdSize) throw new Error('zip: the directory is damaged');
      if (flags & FLAG_ENCRYPTED) throw new Error('zip: encrypted entries are not supported');
      if (method !== 0 && method !== 8) throw new Error('zip: the packing method ' + method + ' is not supported');
      if (csize === MAX_U32 || usize === MAX_U32 || offset === MAX_U32) throw new Error('zip: ZIP64 files are not supported');
      let name;
      try { name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)); } catch (e) { throw new Error('zip: a file name is not valid UTF-8'); }
      if (name.endsWith('/')) { p += 46 + nameLen + extraLen + commentLen; continue; }   // a folder entry
      checkName(name);
      if (entries.has(name)) throw new Error('zip: the file name ' + name + ' is in the directory twice');
      if (usize > maxEntry) throw new Error('zip: the entry ' + name + ' is larger than the limit');
      total += usize;
      if (total > maxTotal) throw new Error('zip: the total size is larger than the limit');
      if (method === 0 && csize !== usize) throw new Error('zip: the sizes of the stored entry ' + name + ' differ');
      entries.set(name, { name, method, crc, csize, usize, offset, dataDescriptor: !!(flags & FLAG_DATA_DESCRIPTOR) });
      p += 46 + nameLen + extraLen + commentLen;
    }

    async function get(name) {
      const e = entries.get(name);
      if (!e) throw new Error('zip: the file ' + name + ' is not in the ZIP file');
      const q = e.offset;
      if (q + 30 > cdOffset || dv.getUint32(q, true) !== SIG_LOCAL) throw new Error('zip: the entry ' + name + ' is damaged (local header)');
      const start = q + 30 + dv.getUint16(q + 26, true) + dv.getUint16(q + 28, true);
      if (start + e.csize > cdOffset) throw new Error('zip: the entry ' + name + ' is damaged (data is outside the file)');
      const body = bytes.subarray(start, start + e.csize);
      let data;
      if (e.method === 0) data = body.slice();
      else {
        if (!hasStreams()) throw new Error('zip: this browser cannot unpack packed entries');
        try { data = await inflateRaw(body, e.usize); } catch (err) {
          if (/larger than its size/.test(err.message)) throw err;
          throw new Error('zip: the packed data of ' + name + ' is damaged');
        }
      }
      if (data.length !== e.usize) throw new Error('zip: the size of the entry ' + name + ' is wrong');
      if (crc32(data) !== e.crc) throw new Error('zip: the checksum of the entry ' + name + ' is wrong, the data is damaged');
      return data;
    }

    return { entries: Array.from(entries.values(), e => ({ name: e.name, size: e.usize })), get, has: name => entries.has(name) };
  }

  return { create, read, crc32 };
});
