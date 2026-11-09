/* GZ.views.logBar — controls for the log markers (shown in every tab that
   has time charts). Appears when a log file is loaded: summary, a toggle per
   severity, a text filter and a button to remove the log. All containers
   with the attribute data-log-bar show the same state. */
(function (GZ) {
  'use strict';
  const { esc } = GZ.format;

  let onChange = () => {};

  function containers() { return [...document.querySelectorAll('[data-log-bar]')]; }

  function rangeCount() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return null;
    const { entries } = GZ.logs.state();
    return entries.filter(e => e.t >= a.tMin && e.t <= a.tMax).length;
  }

  function summaryText() {
    const st = GZ.logs.state();
    const inRange = rangeCount();
    const skipped = st.skipped ? ` · ${st.skipped} Zeile(n) ohne Zeitstempel übersprungen` : '';
    const range = inRange == null ? '' : ` (${inRange} im Zeitraum der Aufzeichnung)`;
    return `<b>Log</b> ${esc(st.fileName)} · ${st.entries.length} Einträge${range}${skipped}`;
  }

  function render() {
    const st = GZ.logs.state();
    const counts = GZ.logs.severityCounts();
    containers().forEach(box => {
      if (!st.entries.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
      box.style.display = '';
      const chips = GZ.logs.SEVERITY.concat([{ id: 'other', label: 'Sonstige' }])
        .filter(s => counts[s.id])
        .map(s => `<label class="log-chip"><input type="checkbox" data-severity="${s.id}" ${st.hiddenSeverities.has(s.id) ? '' : 'checked'}>
          <span class="log-swatch" style="background:${GZ.charts.logMarkers.SEVERITY_COLOR[s.id]}"></span>${esc(s.label)} <span class="dim">${counts[s.id]}</span></label>`).join('');
      box.innerHTML = `<span class="log-summary">${summaryText()}</span>${chips}
        <input type="search" class="log-search" placeholder="Log durchsuchen …" value="${esc(st.search)}">
        <button type="button" data-log-clear>Log entfernen</button>`;
    });
  }

  function init(changeCallback) {
    onChange = changeCallback;
    document.addEventListener('change', e => {
      const cb = e.target.closest('input[data-severity]');
      if (!cb) return;
      const st = GZ.logs.state();
      if (cb.checked) st.hiddenSeverities.delete(cb.dataset.severity); else st.hiddenSeverities.add(cb.dataset.severity);
      render(); onChange();
    });
    document.addEventListener('input', e => {
      const input = e.target.closest('.log-search');
      if (!input) return;
      GZ.logs.state().search = input.value;
      // keep the other search fields in sync without re-rendering (focus stays)
      document.querySelectorAll('.log-search').forEach(o => { if (o !== input) o.value = input.value; });
      onChange();
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('[data-log-clear]')) return;
      GZ.logs.clear(); render(); onChange();
    });
  }

  GZ.views = GZ.views || {};
  GZ.views.logBar = { init, render };
})(window.GZ = window.GZ || {});
