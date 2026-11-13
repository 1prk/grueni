/* GZ.csvImport is the streaming importer for OCIT tables (io layer).

   It gives the same result as GZ.parser.parseOcitText (same fields, same texts, same errors).
   But it reads bytes. It does not read a big string.
   - A fast path reads numbers directly from the bytes.
     Some lines go to a slow path. These are lines with quotes, with a carriage return in the
     scanned part,
     without a tab, or with an unusual time format.
     The slow path uses the reference functions of GZ.parser. So odd lines behave as before.
   - The columns are typed arrays (see GZ.table). The result also has the field `table`.
   - `seriesByCol` is a lazy map. It builds the text array of a column when a view asks for it.

   API
     importFile(file, { onProgress })  -> Promise<result>   (reads file.stream())
     importBytes(uint8array)           -> result
     importText(string)                -> result
     new Importer({ sizeHint })        push(uint8array) ... finish() -> result   (in chunks)
   Differences to parseOcitText:
   - The importer removes a byte order mark at the start. A file read does the same.
   - The importer decodes bytes that are not valid UTF-8 for each cell. It does not decode the
     whole file at once. */
(function (GZ) {
  'use strict';
  const P = GZ.parser;
  const T = GZ.table;

  // A plain number with at most 9 digits. It fits in u32 and prints back the same.
  const NUM_RE = /^(0|[1-9][0-9]{0,8})$/;
  const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true });   // Keeps a BOM character in cell texts.
  const firstLineDecoder = new TextDecoder('utf-8');                   // Removes the BOM at the start of the file.

  const E_TOO_FEW = 'Zu wenige Zeilen – erwartet 7 Kopfzeilen + mindestens 1 Messzeile.';
  const E_NO_SG = 'Keine Signalgruppen gefunden – kein bekannter OCIT-Typname (z. B. „veh“, „ped“, „tram“) in den Kopfzeilen erkannt.';
  const E_NO_TS = 'Keine gültigen Zeitstempel gefunden (Spalte A, ggf. + Spalte B als getrennte Uhrzeit).';

  const isDigit = x => x >= 0 && x <= 9;

  class Importer {
    constructor(opts) {
      opts = opts || {};
      this.sizeHint = opts.sizeHint || 0;
      this.carry = null;
      this.lineNo = 0;
      this.lastNonEmpty = -1;
      this.headerLines = [];
      this.hdr = null;
      this.noSg = false;
      this.pendingEmpty = 0;
      this.totalRows = 0;
      this.skipped = 0;
      this.n = 0;
      this.cap = 0;
      this.times = null;
      this.vals = []; this.excIdx = []; this.excTok = []; this.excMap = []; this.excList = []; this.ovfIdx = []; this.ovfVal = [];
      this.cycleStarts = [];
      this.tcValues = [];
      this.splValues = [];
      this.lastTc = '';
      this.lastSpl = '';
      this.prevTxZero = false;
      this.prevTxNum = null;
      this.dayCache = new Map();
    }

    /* ---------- bytes to lines ---------- */
    push(chunk) {
      let buf = chunk;
      if (this.carry !== null) {
        buf = new Uint8Array(this.carry.length + chunk.length);
        buf.set(this.carry, 0);
        buf.set(chunk, this.carry.length);
        this.carry = null;
      }
      let start = 0, idx;
      while ((idx = buf.indexOf(10, start)) >= 0) { this._line(buf, start, idx); start = idx + 1; }
      if (start < buf.length) this.carry = buf.slice(start);
    }

    finish() {
      if (this.carry !== null) { const c = this.carry; this.carry = null; this._line(c, 0, c.length); }
      if (this.lastNonEmpty + 1 < 8) throw new Error(E_TOO_FEW);
      if (this.noSg) throw new Error(E_NO_SG);
      if (this.n === 0) throw new Error(E_NO_TS);
      return this._result();
    }

    _isEmpty(b, s, e) {
      for (let k = s; k < e; k++) if (b[k] !== 13) return false;
      return true;
    }

    _line(b, s, e) {
      const idx = this.lineNo++;
      const empty = this._isEmpty(b, s, e);
      if (!empty) this.lastNonEmpty = idx;
      if (idx < 7) {
        const dec = idx === 0 ? firstLineDecoder : textDecoder;
        this.headerLines.push(dec.decode(b.subarray(s, e)).replace(/\r/g, ''));
        if (idx === 6) this._setupHeader();
        return;
      }
      if (empty) { this.pendingEmpty++; return; }
      this.totalRows += this.pendingEmpty + 1;
      this.skipped += this.pendingEmpty;
      this.pendingEmpty = 0;
      if (this.noSg) return;
      if (this.cap === 0) this._alloc(e - s);
      if (!this._rowFast(b, s, e)) this._rowSlow(b, s, e);
    }

    /* ---------- header ---------- */
    _setupHeader() {
      const h = P.analyzeHeader(this.headerLines.map(P.splitLine));
      this.hdr = h;
      if (h.columns.length === 0) { this.noSg = true; return; }
      this.allCols = h.columns.concat(h.otherColumns);
      this.colIdx = Int32Array.from(this.allCols.map(c => c.index));
      this.txCol = h.txCol; this.tcCol = h.tcCol; this.splCol = h.splCol;
      let m = 1;
      for (const f of [h.txCol, h.tcCol, h.splCol]) if (f > m) m = f;
      for (let c = 0; c < this.colIdx.length; c++) if (this.colIdx[c] > m) m = this.colIdx[c];
      this.needMax = m;
      this.fs = new Int32Array(m + 1);
      this.fe = new Int32Array(m + 1);
      this.fv = new Int32Array(m + 1);
    }

    _alloc(lineLen) {
      const est = this.sizeHint ? Math.ceil(this.sizeHint / (lineLen + 1) * 1.25) + 16 : 4096;
      this.cap = Math.max(1024, est);
      this.times = new Float64Array(this.cap);
      for (let c = 0; c < this.colIdx.length; c++) {
        this.vals.push(new Uint16Array(this.cap));
        this.excIdx.push([]); this.excTok.push([]); this.excMap.push(new Map()); this.excList.push([]);
        this.ovfIdx.push([]); this.ovfVal.push([]);
      }
    }

    _grow() {
      this.cap = Math.ceil(this.cap * 1.5);
      const nt = new Float64Array(this.cap); nt.set(this.times); this.times = nt;
      for (let c = 0; c < this.vals.length; c++) { const a = new Uint16Array(this.cap); a.set(this.vals[c]); this.vals[c] = a; }
    }

    /* ---------- one data row ---------- */
    // Fast path. Returns false if the row needs the slow path. In that case the function stores
    // nothing.
    _rowFast(b, s, e0) {
      let e = e0;
      if (e > s && b[e - 1] === 13) e--;
      const fs = this.fs, fe = this.fe, fv = this.fv, M = this.needMax;
      let f = 0, fstart = s, last = -1, sawTab = false;
      for (;;) {
        let p = fstart, val = 0, ok = 1;
        while (p < e) {
          const ch = b[p];
          if (ch === 9) break;
          const d = ch - 48;
          if (d >= 0 && d <= 9) val = val * 10 + d;
          else { if (ch === 34 || ch === 13) return false; ok = 0; }
          p++;
        }
        const len = p - fstart;
        fs[f] = fstart; fe[f] = p;
        fv[f] = (ok === 1 && len > 0 && len <= 9 && (len === 1 || b[fstart] !== 48)) ? val : -1;
        last = f;
        if (p >= e) break;
        sawTab = true;
        if (f === M) break;
        f++; fstart = p + 1;
      }
      if (!sawTab) return false;

      let t = last >= 1 ? this._fastTime(b, fs[0], fe[0], fs[1], fe[1]) : NaN;
      if (t !== t) {
        t = this._slowTimestamp(this._raw(b, fs[0], fe[0]), last >= 1 ? this._raw(b, fs[1], fe[1]) : undefined);
        if (t === null) { this.skipped++; return true; }
      }

      if (this.n >= this.cap) this._grow();
      const n = this.n, vals = this.vals, colIdx = this.colIdx, nc = colIdx.length;
      this.times[n] = t;
      for (let c = 0; c < nc; c++) {
        const fi = colIdx[c];
        if (fi <= last) {
          const v = fv[fi];
          if (v >= 0) {
            if (v <= 65534) vals[c][n] = v; else { this.ovfIdx[c].push(n); this.ovfVal[c].push(v); }
          } else this._cellToken(c, n, fe[fi] === fs[fi] ? '' : this._trimmed(b, fs[fi], fe[fi]));
        } else this._cellToken(c, n, '');
      }
      const tc = this._tokenAt(b, last, this.tcCol);
      if (tc !== '') this.lastTc = tc;
      this.tcValues.push(this.lastTc);
      const sp = this._tokenAt(b, last, this.splCol);
      if (sp !== '') this.lastSpl = sp;
      this.splValues.push(this.lastSpl);
      const tx = this.txCol;
      if (tx <= last && fv[tx] >= 0) this._txStep(t, fv[tx] === 0, fv[tx]);
      else { const str = this._tokenAt(b, last, tx); if (str !== '') this._txStep(t, str === '0', Number(str)); }
      this.n++;
      return true;
    }

    // Slow path. It does the same steps on strings. It uses the reference functions of GZ.parser.
    _rowSlow(b, s, e) {
      const r = P.splitLine(textDecoder.decode(b.subarray(s, e)).replace(/\r/g, ''));
      const t = this._slowTimestamp(r[0], r[1]);
      if (t === null) { this.skipped++; return; }
      if (this.n >= this.cap) this._grow();
      const n = this.n, colIdx = this.colIdx;
      this.times[n] = t;
      for (let c = 0; c < colIdx.length; c++) this._cellToken(c, n, (r[colIdx[c]] || '').trim());
      const tc = (r[this.tcCol] || '').trim();
      if (tc !== '') this.lastTc = tc;
      this.tcValues.push(this.lastTc);
      const sp = (r[this.splCol] || '').trim();
      if (sp !== '') this.lastSpl = sp;
      this.splValues.push(this.lastSpl);
      const str = (r[this.txCol] || '').trim();
      if (str !== '') this._txStep(t, str === '0', Number(str));
      this.n++;
    }

    _raw(b, s, e) { return e > s ? textDecoder.decode(b.subarray(s, e)) : ''; }
    _trimmed(b, s, e) { return textDecoder.decode(b.subarray(s, e)).trim(); }
    _tokenAt(b, last, f) {
      if (f > last) return '';
      const v = this.fv[f];
      if (v >= 0) return String(v);
      return this.fe[f] === this.fs[f] ? '' : this._trimmed(b, this.fs[f], this.fe[f]);
    }

    // `str` is a trimmed cell text. In the fast path it is not a plain number. In the slow path it
    // is any text.
    _cellToken(c, n, str) {
      if (NUM_RE.test(str)) {
        const v = +str;
        if (v <= 65534) this.vals[c][n] = v; else { this.ovfIdx[c].push(n); this.ovfVal[c].push(v); }
        return;
      }
      let id = this.excMap[c].get(str);
      if (id === undefined) { id = this.excList[c].length; this.excList[c].push(str); this.excMap[c].set(str, id); }
      this.excIdx[c].push(n); this.excTok[c].push(id);
    }

    // Detects the start of a cycle. The rules are the same as in parseOcitText.
    _txStep(t, isZero, num) {
      const isZeroEdge = isZero && !this.prevTxZero;
      const isWrapEdge = !isZeroEdge && Number.isFinite(num) && this.prevTxNum !== null && num < this.prevTxNum;
      if (isZeroEdge || isWrapEdge) this.cycleStarts.push(t);
      this.prevTxZero = isZero;
      if (Number.isFinite(num)) this.prevTxNum = num;
    }

    /* ---------- time ---------- */
    _slowTimestamp(s0, s1) {
      if (!s0 || !s0.trim()) return null;
      const ts = P.looksLikeTimeOnly(s1) ? (s0 + ' ' + s1) : s0;
      try { return P.parseTimestamp(ts); } catch (e) { return null; }
    }

    // Parses the date in field 0 ("DD.MM.YY" or "DD.MM.YYYY") and the time in field 1 ("HH:MM:SS").
    // Returns NaN for another format. Then the caller uses the slow path.
    // The function caches the start of the day. It uses the cache only if the day has no clock
    // change.
    // Then the result is the same as new Date(y, m, d, h, mi, s).
    _fastTime(b, s0, e0, s1, e1) {
      const l0 = e0 - s0;
      if (e1 - s1 !== 8 || (l0 !== 8 && l0 !== 10)) return NaN;
      if (b[s0 + 2] !== 46 || b[s0 + 5] !== 46 || b[s1 + 2] !== 58 || b[s1 + 5] !== 58) return NaN;
      const d1 = b[s0] - 48, d2 = b[s0 + 1] - 48, m1 = b[s0 + 3] - 48, m2 = b[s0 + 4] - 48;
      const y1 = b[s0 + 6] - 48, y2 = b[s0 + 7] - 48;
      const h1 = b[s1] - 48, h2 = b[s1 + 1] - 48, i1 = b[s1 + 3] - 48, i2 = b[s1 + 4] - 48, c1 = b[s1 + 6] - 48, c2 = b[s1 + 7] - 48;
      if (!(isDigit(d1) && isDigit(d2) && isDigit(m1) && isDigit(m2) && isDigit(y1) && isDigit(y2) &&
            isDigit(h1) && isDigit(h2) && isDigit(i1) && isDigit(i2) && isDigit(c1) && isDigit(c2))) return NaN;
      let yy = y1 * 10 + y2;
      if (l0 === 10) {
        const y3 = b[s0 + 8] - 48, y4 = b[s0 + 9] - 48;
        if (!isDigit(y3) || !isDigit(y4)) return NaN;
        yy = yy * 100 + y3 * 10 + y4;
      }
      const year = yy >= 100 ? yy : 2000 + yy;
      const dd = d1 * 10 + d2, mo = m1 * 10 + m2, hh = h1 * 10 + h2, mi = i1 * 10 + i2, ss = c1 * 10 + c2;
      const key = year * 10000 + mo * 100 + dd;
      let info = this.dayCache.get(key);
      if (info === undefined) {
        const d0 = new Date(year, mo - 1, dd);
        const base = d0.getTime();
        info = {
          base,
          exact: d0.getHours() === 0 && d0.getMinutes() === 0 && new Date(base + 86399000).getTimezoneOffset() === d0.getTimezoneOffset()
        };
        this.dayCache.set(key, info);
      }
      if (info.exact && hh < 24 && mi < 60 && ss < 60) return info.base + (hh * 3600 + mi * 60 + ss) * 1000;
      return new Date(year, mo - 1, dd, hh, mi, ss).getTime();
    }

    /* ---------- result ---------- */
    _finalColumn(c, n) {
      const index = this.colIdx[c];
      const a = this.vals[c].subarray(0, n);
      const excI = this.excIdx[c], excT = this.excTok[c], list = this.excList[c];
      const ovfI = this.ovfIdx[c], ovfV = this.ovfVal[c];

      if (excI.length > 0.2 * n || list.length > 60000) {
        // Mostly text (for example a sparse column): use a dictionary.
        const excAt = new Map();
        for (let k = 0; k < excI.length; k++) excAt.set(excI[k], list[excT[k]]);
        const ovfAt = new Map();
        for (let k = 0; k < ovfI.length; k++) ovfAt.set(ovfI[k], String(ovfV[k]));
        const dmap = new Map(), dict = [], codes = new Uint32Array(n);
        for (let i = 0; i < n; i++) {
          let tok = excAt.get(i);
          if (tok === undefined) { tok = ovfAt.get(i); if (tok === undefined) tok = String(a[i]); }
          let code = dmap.get(tok);
          if (code === undefined) { code = dict.length; dict.push(tok); dmap.set(tok, code); }
          codes[i] = code;
        }
        const data = dict.length <= 256 ? new Uint8Array(codes) : dict.length <= 65536 ? new Uint16Array(codes) : codes;
        return T.createDictColumn(index, data, dict);
      }

      let max = 0;
      for (let i = 0; i < n; i++) if (a[i] > max) max = a[i];
      for (let k = 0; k < ovfV.length; k++) if (ovfV[k] > max) max = ovfV[k];
      const data = max <= 255 ? new Uint8Array(a) : max <= 65535 ? a.slice() : new Uint32Array(a);
      for (let k = 0; k < ovfI.length; k++) data[ovfI[k]] = ovfV[k];
      const exc = excI.length ? { idx: Uint32Array.from(excI), tok: Uint32Array.from(excT), tokens: list } : null;
      return T.createNumericColumn(index, data, exc);
    }

    _result() {
      const n = this.n, h = this.hdr;
      const columnsData = [];
      for (let c = 0; c < this.colIdx.length; c++) columnsData.push(this._finalColumn(c, n));
      this.vals = []; this.excIdx = []; this.excTok = []; this.excMap = []; this.excList = []; this.ovfIdx = []; this.ovfVal = [];
      const timesF64 = this.times.slice(0, n);
      this.times = null;
      const table = T.createTable(timesF64, columnsData);
      return {
        columns: h.columns, otherColumns: h.otherColumns,
        times: Array.from(timesF64),
        seriesByCol: new T.LazySeriesMap(columnsData),
        splValues: this.splValues, tcValues: this.tcValues,
        totalRows: this.totalRows, skippedRows: this.skipped,
        knotenName: h.knotenName, knotenNr: h.knotenNr,
        cycleStarts: this.cycleStarts,
        table
      };
    }
  }

  function importBytes(bytes) {
    const imp = new Importer({ sizeHint: bytes.length });
    imp.push(bytes);
    return imp.finish();
  }
  function importText(text) { return importBytes(new TextEncoder().encode(text)); }

  async function importFile(file, opts) {
    opts = opts || {};
    const imp = new Importer({ sizeHint: file.size });
    const reader = file.stream().getReader();
    let done = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      imp.push(r.value);
      done += r.value.length;
      if (opts.onProgress) opts.onProgress(file.size ? done / file.size : 1);
    }
    return imp.finish();
  }

  GZ.csvImport = { Importer, importBytes, importText, importFile };
})(window.GZ = window.GZ || {});
