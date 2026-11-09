/* GZ.logs — log markers from a CSV file.

   Each line has columns: level, timestamp, text. Only these first three
   columns are used. Further columns are ignored. The file is usually
   semicolon separated; tab separated files work too. The timestamp is
   "DD.MM.YYYY, HH:MM:SS" (the comma is optional; ISO "YYYY-MM-DD HH:MM:SS"
   is accepted too). A first line without a timestamp is a header line.
   When the columns cannot be split (for example a comma separated file,
   where the timestamp itself contains a comma), the parser searches the
   timestamp in the line: text before it is the level, text after it is
   the message.

   The log text can be confidential. It stays in the browser memory: it is
   not saved, not exported and not sent anywhere. */
(function (GZ) {
  'use strict';

  const DE_STAMP = /(\d{1,2})\.(\d{1,2})\.(\d{2,4}),?\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/;
  const ISO_STAMP = /(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/;

  // Severity classes. Unknown level names fall into "other".
  const SEVERITY = [
    // Order matters: the first matching class wins.
    { id: 'critical', label: 'Schwerer Fehler', re: /^(schwerer\s+fehler|schwerfehler|kritisch|fatal|critical|crit|severe)$/i },
    { id: 'error', label: 'Fehler', re: /^(e|err|error|fehler)$/i },
    { id: 'warning', label: 'Warnung', re: /^(w|warn|warning|warnung)$/i },
    { id: 'info', label: 'Info', re: /^(i|info|information|hinweis)$/i },
    { id: 'debug', label: 'Debug', re: /^(d|debug|trace|verbose)$/i }
  ];
  function severityOf(level) {
    const hit = SEVERITY.find(s => s.re.test(level));
    return hit ? hit.id : 'other';
  }

  function stripDelimiters(s) {
    return s.replace(/^[\s\t;,"']+|[\s\t;,"']+$/g, '');
  }

  function parseStamp(line) {
    let m = DE_STAMP.exec(line), y, mo, d, h, mi, s, ms;
    if (m) {
      d = +m[1]; mo = +m[2]; y = +m[3]; h = +m[4]; mi = +m[5]; s = +m[6]; ms = m[7] ? +m[7].padEnd(3, '0') : 0;
      if (y < 100) y += 2000;
    } else {
      m = ISO_STAMP.exec(line);
      if (!m) return null;
      y = +m[1]; mo = +m[2]; d = +m[3]; h = +m[4]; mi = +m[5]; s = +m[6]; ms = m[7] ? +m[7].padEnd(3, '0') : 0;
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
    return { t: new Date(y, mo - 1, d, h, mi, s, ms).getTime(), index: m.index, length: m[0].length };
  }

  // Quote-aware split of one line (RFC 4180: "" inside quotes is one quote).
  function splitFields(line, delimiter) {
    const out = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuote) {
        if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQuote = false; }
        else cur += ch;
      } else if (ch === '"') inQuote = true;
      else if (ch === delimiter) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  // Semicolon first, then tab. null: no usable delimiter, search the timestamp instead.
  function detectDelimiter(lines) {
    const sample = lines.find(l => l.trim()) || '';
    if (sample.includes(';')) return ';';
    if (sample.includes('\t')) return '\t';
    return null;
  }

  // One line -> { t, level, text } or null. Columns 1..3 only.
  function parseLine(raw, delimiter) {
    if (delimiter) {
      const f = splitFields(raw, delimiter);
      const stamp = f.length >= 2 ? parseStamp(f[1]) : null;
      if (stamp) return { t: stamp.t, level: f[0].trim(), text: (f[2] || '').trim() };
    }
    const stamp = parseStamp(raw);
    if (!stamp) return null;
    return { t: stamp.t, level: stripDelimiters(raw.slice(0, stamp.index)), text: stripDelimiters(raw.slice(stamp.index + stamp.length)) };
  }

  // Returns { entries: [{t, level, severity, text}], skipped, total }.
  // entries are sorted by time. skipped counts non-empty lines without a timestamp
  // (a header line in the first line is not counted).
  function parse(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    const delimiter = detectDelimiter(lines);
    const entries = [];
    let skipped = 0, total = 0, first = true;
    lines.forEach(raw => {
      if (!raw.trim()) return;
      const isFirst = first;
      first = false;
      const e = parseLine(raw, delimiter);
      // A first line without a timestamp is a header line. It is not an error.
      if (!e && isFirst) return;
      total++;
      if (!e) { skipped++; return; }
      entries.push({ t: e.t, level: e.level, severity: severityOf(e.level), text: e.text });
    });
    entries.sort((p, q) => p.t - q.t);
    return { entries, skipped, total };
  }

  /* ---------------- State ---------------- */
  function empty() {
    return { entries: [], fileName: '', skipped: 0, hiddenSeverities: new Set(), search: '' };
  }
  function state() {
    if (!GZ.state.data.log) GZ.state.data.log = empty();
    return GZ.state.data.log;
  }
  function load(text, fileName) {
    const parsed = parse(text);
    const st = state();
    st.entries = parsed.entries; st.fileName = fileName || ''; st.skipped = parsed.skipped;
    st.hiddenSeverities = new Set(); st.search = '';
    return parsed;
  }
  function clear() { GZ.state.data.log = empty(); }
  function hasEntries() { return state().entries.length > 0; }

  // Entries that pass the current filters, optionally inside [tMin, tMax].
  // entries are sorted by time, so the range is found by binary search.
  function visible(tMin, tMax) {
    const st = state(), needle = st.search.trim().toLowerCase();
    const all = st.entries;
    let from = 0;
    if (tMin != null) {
      let lo = 0, hi = all.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (all[mid].t < tMin) lo = mid + 1; else hi = mid; }
      from = lo;
    }
    const out = [];
    for (let i = from; i < all.length; i++) {
      const e = all[i];
      if (tMax != null && e.t > tMax) break;
      if (st.hiddenSeverities.has(e.severity)) continue;
      if (needle && !e.text.toLowerCase().includes(needle) && !e.level.toLowerCase().includes(needle)) continue;
      out.push(e);
    }
    return out;
  }
  // Visible entries within `marginMs` of a time span.
  function around(t0, t1, marginMs) {
    return visible(t0 - marginMs, t1 + marginMs);
  }
  function severityCounts() {
    const counts = {};
    state().entries.forEach(e => { counts[e.severity] = (counts[e.severity] || 0) + 1; });
    return counts;
  }

  GZ.logs = { SEVERITY, severityOf, parseStamp, parse, state, load, clear, hasEntries, visible, around, severityCounts };
})(window.GZ = window.GZ || {});
