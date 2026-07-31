/* GZ.format — Zeit-/Zahlenformatierung und HTML-Escaping.
   Reine Funktionen ohne DOM- oder Analyse-Abhängigkeiten. */
(function (GZ) {
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
  // "Xh Ym" bzw. "Ym Zs" - für Dunkel-/Abschaltzeiträume (Sekunden bis viele Stunden).
  function fmtDauer(sek) {
    sek = Math.round(sek);
    const h = Math.floor(sek / 3600), m = Math.floor((sek % 3600) / 60), s = sek % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  GZ.format = { esc, pad, fmtTs, fmtDate, fmtTimeOnly, fmtTimeShort, fmtDauer };
})(window.GZ = window.GZ || {});
