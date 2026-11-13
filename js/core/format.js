/* GZ.format formats times and numbers. It also escapes HTML.
   The functions are pure. They do not use the DOM or an analysis. */
GZ.define('format', { layer: 'domain', deps: [] }, function (GZ) {
  'use strict';

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function fmtTs(date) {
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${pad(date.getFullYear() % 100)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
  function fmtDate(date) {
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${pad(date.getFullYear() % 100)}`;
  }
  function fmtTimeOnly(date) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
  function fmtTimeShort(ms) {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  // Formats a span as "Xh Ym" or "Ym Zs".
  // Use it for dark periods and switch-off periods. These last from seconds to many hours.
  function fmtDauer(sek) {
    sek = Math.round(sek);
    const h = Math.floor(sek / 3600), m = Math.floor((sek % 3600) / 60), s = sek % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  // Returns a number with a German decimal comma. Returns an empty text for null or NaN.
  function fmtNum(v, digits) {
    if (v == null || !Number.isFinite(v)) return '–';
    return v.toFixed(digits || 0).replace('.', ',');
  }
  // Returns "HH:MM" of a timestamp in local time.
  function fmtHm(ms) {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  // Returns "h:mm h" for a span in seconds.
  function fmtHoursMinutes(sek) {
    const m = Math.round(sek / 60);
    return `${Math.floor(m / 60)}:${pad(m % 60)} h`;
  }

  return { esc, pad, fmtTs, fmtDate, fmtTimeOnly, fmtTimeShort, fmtDauer, fmtNum, fmtHm, fmtHoursMinutes };
});
