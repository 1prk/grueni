/* GZ.logs reads log markers from a CSV file.

   Each line has the columns level, timestamp and text. The parser uses only these first three
   columns.
   It ignores more columns.
   The file is usually separated by semicolons. A file separated by tabs also works.
   The timestamp format is "DD.MM.YYYY, HH:MM:SS". The comma is optional.
   The ISO format "YYYY-MM-DD HH:MM:SS" is also accepted.
   A first line without a timestamp is a header line.
   Sometimes the parser cannot split the columns.
   An example is a comma-separated file, where the timestamp contains a comma.
   Then the parser searches for the timestamp in the line.
   The text before the timestamp is the level. The text after it is the message.

   The log text can be confidential. It stays in the browser memory.
   The application does not save it, export it or send it anywhere. */
(function (GZ) {
  'use strict';

  const DE_STAMP = /(\d{1,2})\.(\d{1,2})\.(\d{2,4}),?\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/;
  const ISO_STAMP = /(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/;

  // Severity classes. A level name that is not known goes to "other".
  const SEVERITY = [
    // The order is important. The first class that matches wins.
    { id: 'critical', label: 'Schwerer Fehler', re: /^(schwerer\s+fehler|schwerfehler|kritisch|fatal|critical|crit|severe)$/i },
    { id: 'error', label: 'Fehler', re: /^(e|err|error|fehler)$/i },
    { id: 'warning', label: 'Warnung', re: /^(w|warn|warning|warnung)$/i },
    { id: 'info', label: 'Info', re: /^(i|info|information|hinweis)$/i },
    { id: 'debug', label: 'Debug', re: /^(d|debug|trace|verbose)$/i }
  ];
  // Rank of a severity. It is used for the filters "this level and worse".
  const RANK = { debug: 0, other: 1, info: 2, warning: 3, error: 4, critical: 5 };

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

  // Splits one line and respects quotes. RFC 4180: two quotes inside quotes are one quote.
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

  // Tries the semicolon first, then the tab.
  // The result is null if there is no usable delimiter. Then the parser searches for the timestamp.
  function detectDelimiter(lines) {
    const sample = lines.find(l => l.trim()) || '';
    if (sample.includes(';')) return ';';
    if (sample.includes('\t')) return '\t';
    return null;
  }

  // Converts one line to { t, level, text } or null. Only columns 1 to 3 are used.
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
  // The entries are sorted by time.
  // skipped counts non-empty lines without a timestamp.
  // A header line in the first line is not counted.
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

  // Returns the entries that pass the current filters. The entries can be limited to [tMin, tMax].
  // The entries are sorted by time, so a binary search finds the range.
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
  // Returns the visible entries within `marginMs` of a time span.
  function around(t0, t1, marginMs) {
    return visible(t0 - marginMs, t1 + marginMs);
  }
  function severityCounts() {
    const counts = {};
    state().entries.forEach(e => { counts[e.severity] = (counts[e.severity] || 0) + 1; });
    return counts;
  }

  GZ.logs = { SEVERITY, RANK, severityOf, parseStamp, parse, state, load, clear, hasEntries, visible, around, severityCounts };
})(window.GZ = window.GZ || {});
