/* GZ.logs — log markers from a CSV file.

   Each line has three columns: level, timestamp, text. The timestamp is
   "DD.MM.YYYY, HH:MM:SS" (the comma is optional; ISO "YYYY-MM-DD HH:MM:SS" is
   accepted too). The parser finds the timestamp inside the line and takes
   everything before it as the level and everything after it as the text.
   So it works with tab, semicolon or comma separated files and with or
   without a header line.

   The log text can be confidential. It stays in the browser memory: it is
   not saved, not exported and not sent anywhere. */
(function (GZ) {
  'use strict';

  const DE_STAMP = /(\d{1,2})\.(\d{1,2})\.(\d{2,4}),?\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/;
  const ISO_STAMP = /(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/;

  // Severity classes. Unknown level names fall into "other".
  const SEVERITY = [
    { id: 'error', label: 'Fehler', re: /^(e|err|error|fehler|fatal|critical|crit|severe)$/i },
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

  // Returns { entries: [{t, level, severity, text}], skipped, total }.
  // entries are sorted by time. skipped counts non-empty lines without a timestamp
  // (a header line in the first line is not counted).
  function parse(text) {
    const entries = [];
    let skipped = 0, total = 0, first = true;
    text.replace(/^﻿/, '').split(/\r?\n/).forEach(raw => {
      if (!raw.trim()) return;
      const isFirst = first;
      first = false;
      const stamp = parseStamp(raw);
      // A first line without a timestamp is a header line. It is not an error.
      if (!stamp && isFirst) return;
      total++;
      if (!stamp) { skipped++; return; }
      const level = stripDelimiters(raw.slice(0, stamp.index));
      const msg = stripDelimiters(raw.slice(stamp.index + stamp.length));
      entries.push({ t: stamp.t, level, severity: severityOf(level), text: msg });
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
  function visible(tMin, tMax) {
    const st = state(), needle = st.search.trim().toLowerCase();
    return st.entries.filter(e =>
      (tMin == null || (e.t >= tMin && e.t <= tMax)) &&
      !st.hiddenSeverities.has(e.severity) &&
      (!needle || e.text.toLowerCase().includes(needle) || e.level.toLowerCase().includes(needle)));
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
