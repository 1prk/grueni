/* GZ.views.logBar has the controls for the log markers. It shows them in every tab that has time
   charts.
   It appears when the user loads a log file.
   It shows a summary, a toggle for each severity, a text filter, a list of the entries and a
   button to remove the log.
   A click on a list entry opens its cycle in the cycle check.
   All containers with the attribute data-log-bar show the same state. */
GZ.define('views.logBar', { layer: 'views', deps: ['charts.logMarkers', 'cssom', 'format', 'logs', 'state'] }, function (GZ) {
  'use strict';
  const { esc, fmtTs } = GZ.format;

  // More rows make the list slow. The filters narrow the list.
  const MAX_LIST_ROWS = 500;

  // Quick filter of the LIST only. The chips filter the list and the markers.
  // The list shows a level when its rank is at least the chosen rank.
  const RANK = { debug: 0, other: 1, info: 2, warning: 3, error: 4, critical: 5 };
  const LIST_FILTERS = [
    { id: 'all', label: 'Alle', min: 0 },
    { id: 'warning', label: 'ab Warnung', min: 3 },
    { id: 'error', label: 'ab Fehler', min: 4 },
    { id: 'critical', label: 'nur Schwerer Fehler', min: 5 }
  ];

  let onChange = () => {};
  let listOpen = false;
  let listFilter = 'all';
  let inRecordingOnly = true; // The list shows only entries inside the time range of the recording.
  let active = null;  // The entry that the user opened last.
  let listed = [];    // The entries in the list, in the same order as the rows.

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

  // The list of entries that pass the filters. A click opens the entry in the cycle check.
  function renderLists() {
    const min = LIST_FILTERS.find(f => f.id === listFilter).min;
    const a = GZ.state.data.currentAnalysis;
    const useRange = inRecordingOnly && !!a;
    const matching = listOpen ? GZ.logs.visible(useRange ? a.tMin : null, useRange ? a.tMax : null).filter(e => RANK[e.severity] >= min) : [];
    listed = matching.slice(0, MAX_LIST_ROWS);
    const total = matching.length;
    const head = `<div class="log-list-head"><span>Anzeigen:</span>${LIST_FILTERS.map(f =>
      `<button type="button" data-list-filter="${f.id}" class="${f.id === listFilter ? 'active' : ''}">${f.label}</button>`).join('')}<label class="inline-check"><input type="checkbox" data-list-range ${inRecordingOnly ? 'checked' : ''}> nur Zeitraum der Aufzeichnung</label><span class="dim">${total} Einträge</span></div>`;
    containers().forEach(box => {
      const host = box.querySelector('.log-list');
      if (!host) return;
      host.style.display = listOpen ? '' : 'none';
      if (!listOpen) { host.innerHTML = ''; return; }
      host.innerHTML = head + (listed.length
        ? `<div class="log-list-scroll"><table><thead><tr><th>Zeit</th><th>Stufe</th><th>Text</th></tr></thead><tbody>${listed.map((e, i) =>
            `<tr data-i="${i}" class="${e === active ? 'active' : ''}${a && !GZ.state.inRecording(e.t) ? ' outside' : ''}" title="${a && !GZ.state.inRecording(e.t) ? 'Außerhalb der Aufzeichnung – kein Umlauf' : 'Klick: Umlauf in der Umlaufprüfung öffnen'}"><td>${esc(fmtTs(new Date(e.t)))}</td><td class="sev-${esc(e.severity)}">${esc(e.level || '–')}</td><td class="text">${esc(e.text)}</td></tr>`).join('')}</tbody></table>`
          + (total > listed.length ? `<div class="log-list-more">${listed.length} von ${total} Einträgen – Filter oder Suche einschränken.</div>` : '') + '</div>'
        : '<div class="log-list-more">Keine Einträge für diese Filter.</div>');
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
          <span class="log-swatch" data-css="border-bottom-color:${GZ.charts.logMarkers.SEVERITY_COLOR[s.id]}"></span>${esc(s.label)} <span class="dim">${counts[s.id]}</span></label>`).join('');
      box.innerHTML = `<span class="log-summary">${summaryText()}</span>${chips}
        <input type="search" class="log-search" placeholder="Log durchsuchen …" value="${esc(st.search)}">
        <button type="button" data-log-list>${listOpen ? 'Liste ausblenden' : 'Liste anzeigen'}</button>
        <button type="button" data-log-clear>Log entfernen</button>
        <div class="log-list"></div>`;
      GZ.cssom.apply(box);
    });
    renderLists();
  }

  // Marks the entry that the user opened last. It does not redraw, so the scroll position stays.
  function markActive(entry) {
    active = entry;
    containers().forEach(box => {
      box.querySelectorAll('.log-list tbody tr').forEach(tr => tr.classList.toggle('active', listed[Number(tr.dataset.i)] === entry));
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
    document.addEventListener('change', e => {
      const cb = e.target.closest('input[data-list-range]');
      if (!cb) return;
      inRecordingOnly = cb.checked;
      renderLists();
    });
    document.addEventListener('input', e => {
      const input = e.target.closest('.log-search');
      if (!input) return;
      GZ.logs.state().search = input.value;
      // Keeps the other search fields in sync without a new render. The focus stays.
      document.querySelectorAll('.log-search').forEach(o => { if (o !== input) o.value = input.value; });
      renderLists(); onChange();
    });
    document.addEventListener('click', e => {
      if (e.target.closest('[data-log-clear]')) { GZ.logs.clear(); listOpen = false; render(); onChange(); return; }
      if (e.target.closest('[data-log-list]')) { listOpen = !listOpen; render(); return; }
      const filterBtn = e.target.closest('button[data-list-filter]');
      if (filterBtn) { listFilter = filterBtn.dataset.listFilter; renderLists(); return; }
      const row = e.target.closest('.log-list tbody tr[data-i]');
      if (row && listed[Number(row.dataset.i)]) GZ.state.command('nav:jumpToLog', { entry: listed[Number(row.dataset.i)] });
    });
  }

  return { init, render, markActive };
});
