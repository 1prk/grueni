/* GZ.views.logBar — controls for the log markers (shown in every tab that
   has time charts). Appears when a log file is loaded: summary, a toggle per
   severity, a text filter, a list of the entries and a button to remove the
   log. A click on a list entry opens its cycle in the cycle check. All
   containers with the attribute data-log-bar show the same state. */
(function (GZ) {
  'use strict';
  const { esc, fmtTs } = GZ.format;

  // More rows make the list slow. The filters narrow it down.
  const MAX_LIST_ROWS = 500;

  let onChange = () => {};
  let listOpen = false;
  let listed = [];   // entries shown in the list, same order as the rows

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

  // The list of entries that pass the filters. Click = open in the cycle check.
  function renderLists() {
    listed = listOpen ? GZ.logs.visible().slice(0, MAX_LIST_ROWS) : [];
    const total = listOpen ? GZ.logs.visible().length : 0;
    containers().forEach(box => {
      const host = box.querySelector('.log-list');
      if (!host) return;
      host.style.display = listOpen ? '' : 'none';
      if (!listOpen) { host.innerHTML = ''; return; }
      host.innerHTML = listed.length
        ? `<table><thead><tr><th>Zeit</th><th>Stufe</th><th>Text</th></tr></thead><tbody>${listed.map((e, i) =>
            `<tr data-i="${i}" title="Klick: Umlauf in der Umlaufprüfung öffnen"><td>${esc(fmtTs(new Date(e.t)))}</td><td class="sev-${esc(e.severity)}">${esc(e.level || '–')}</td><td class="text">${esc(e.text)}</td></tr>`).join('')}</tbody></table>`
          + (total > listed.length ? `<div class="log-list-more">${listed.length} von ${total} Einträgen – Filter oder Suche einschränken.</div>` : '')
        : '<div class="log-list-more">Keine Einträge für diese Filter.</div>';
    });
  }

  function render() {
    const st = GZ.logs.state();
    const counts = GZ.logs.severityCounts();
    containers().forEach(box => {
      if (!st.entries.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
      box.style.display = '';
      const chips = GZ.logs.SEVERITY.concat([{ id: 'other', label: 'Sonstige' }])
        .filter(s => counts[s.id])
        .map(s => `<label class="log-chip log-chip-${s.id}"><input type="checkbox" data-severity="${s.id}" ${st.hiddenSeverities.has(s.id) ? '' : 'checked'}>
          <span class="log-swatch" style="border-bottom-color:${GZ.charts.logMarkers.SEVERITY_COLOR[s.id]}"></span>${esc(s.label)} <span class="dim">${counts[s.id]}</span></label>`).join('');
      box.innerHTML = `<span class="log-summary">${summaryText()}</span>${chips}
        <input type="search" class="log-search" placeholder="Log durchsuchen …" value="${esc(st.search)}">
        <button type="button" data-log-list>${listOpen ? 'Liste ausblenden' : 'Liste anzeigen'}</button>
        <button type="button" data-log-clear>Log entfernen</button>
        <div class="log-list" style="display:none;"></div>`;
    });
    renderLists();
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
      renderLists(); onChange();
    });
    document.addEventListener('click', e => {
      if (e.target.closest('[data-log-clear]')) { GZ.logs.clear(); listOpen = false; render(); onChange(); return; }
      if (e.target.closest('[data-log-list]')) { listOpen = !listOpen; render(); return; }
      const row = e.target.closest('.log-list tbody tr[data-i]');
      if (row && listed[Number(row.dataset.i)]) GZ.app.jumpToLog(listed[Number(row.dataset.i)]);
    });
  }

  GZ.views = GZ.views || {};
  GZ.views.logBar = { init, render };
})(window.GZ = window.GZ || {});
