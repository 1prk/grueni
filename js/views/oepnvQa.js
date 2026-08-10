/* GZ.views.oepnvQa — Tab "ÖPNV — Anmeldung/Abmeldung": beliebig viele
   Signalgruppen gleichzeitig, je mit eigenen An-/Abmeldedetektor(en) und
   Fahrzeit-/Löschparametern; gemeinsame QSV-Stufen (A-F) und SPL-Ausschluss.
   Rohpunkte-Ansicht und Streudiagramm je Signalgruppe, kombinierte Kennzahlen
   (+ Aufschlüsselung je Signalgruppe) und eine sortier-/durchsuchbare,
   nach Excel exportierbare Ereignistabelle. */
(function (GZ) {
  'use strict';
  const { esc, fmtTs } = GZ.format;
  const { mean, percentile, parseNumListe } = GZ.stats;
  const { computeSplTransitions } = GZ.segments;
  const {
    LOS_LEVELS, losDefaultBounds, sollfahrzeitDefault, zwangsloeschDefault,
    losStufe, risingEdgeTimes, computeOepnvEvents,
    wzIstBelegt, txAtTime, auslosenderDetektor
  } = GZ.oepnvLogic;

  let els = null;
  let rows = []; // {id, sgIdx, anIdx:Set<colIndex>, abIdx:Set<colIndex>, sollfahrzeitSek, zwangsloeschSek}
  let nextRowId = 1;
  let lastModelRows = [];
  let sortState = { key: 'anTime', dir: 'asc' };

  function round1(v) { return Math.round(v * 10) / 10; }

  function losChipHtml(level) {
    return level ? `<span class="los-chip los-${level}">${level}</span>` : '<span class="los-chip los-na">–</span>';
  }

  const TABLE_COLUMNS = [
    { key: 'sgLabel', label: 'Signalgruppe', value: r => r.sgLabel, render: r => esc(r.sgLabel) },
    { key: 'nr', label: 'Nr', value: r => r.nr, render: r => String(r.nr) },
    { key: 'anTime', label: 'Anmeldung', value: r => r.anTime, render: r => fmtTs(new Date(r.anTime)), exportValue: r => fmtTs(new Date(r.anTime)) },
    { key: 'tx', label: 'TX', value: r => r.tx, render: r => r.tx ?? '–' },
    { key: 'ergebnisShort', label: 'Ergebnis', value: r => r.ergebnisShort, render: r => r.ergebnisTitle ? `<span title="${esc(r.ergebnisTitle)}">${esc(r.ergebnisShort)}</span>` : esc(r.ergebnisShort), exportValue: r => r.ergebnisShort },
    { key: 'endTime', label: 'Abmeldung/Löschung', value: r => r.endTime, render: r => r.endTime != null ? fmtTs(new Date(r.endTime)) : '–', exportValue: r => r.endTime != null ? fmtTs(new Date(r.endTime)) : '' },
    { key: 'spl', label: 'SPL', value: r => r.spl, render: r => esc(r.spl) },
    { key: 'istFahrzeitSek', label: 'Ist-Fahrzeit [s]', value: r => r.istFahrzeitSek, render: r => r.istFahrzeitSek.toFixed(1) + 's', exportValue: r => round1(r.istFahrzeitSek) },
    { key: 'verlustSek', label: 'Verlustzeit [s]', value: r => r.verlustSek, render: verlustRender, exportValue: r => r.verlustSek == null ? '' : round1(r.verlustSek) },
    { key: 'qsv', label: 'QSV', value: r => r.qsv, render: r => losChipHtml(r.qsv), exportValue: r => r.qsv || '' },
    { key: 'anPunkt', label: 'Anmeldepunkt', value: r => r.anPunkt, render: r => esc(r.anPunkt) },
    { key: 'abPunkt', label: 'Abmeldepunkt', value: r => r.abPunkt, render: r => esc(r.abPunkt) }
  ];

  function verlustRender(r) {
    if (r.verlustSek == null) return '–';
    const txt = (r.verlustIsEstimate ? '≥ ' : '') + r.verlustSek.toFixed(1) + 's' + (r.verlustIsEstimate ? '*' : '');
    return esc(txt);
  }

  function init(root) {
    els = {
      root,
      addSgBtn: root.querySelector('#oeAddSgBtn'),
      sgRows: root.querySelector('#oeSgRows'),
      losInputs: [...root.querySelectorAll('.oe-los-bound')],
      splExcl: root.querySelector('#oeSplExcl'),
      hint: root.querySelector('#oeHint'),
      rawPanel: root.querySelector('#oeRawPanel'),
      rawRows: root.querySelector('#oeRawRows'),
      rawAxis: root.querySelector('#oeRawAxis svg'),
      kpiPanel: root.querySelector('#oeKpiPanel'),
      kpiGrid: root.querySelector('#oeKpiGrid'),
      losDist: root.querySelector('#oeLosDist'),
      sgBreakdown: root.querySelector('#oeSgBreakdown'),
      chartPanel: root.querySelector('#oeChartPanel'),
      chartRows: root.querySelector('#oeChartRows'),
      tablePanel: root.querySelector('#oeTablePanel'),
      tableHead: root.querySelector('#oeTableHead'),
      eventsBody: root.querySelector('#oeEventsBody'),
      search: root.querySelector('#oeSearch'),
      searchInfo: root.querySelector('#oeSearchInfo'),
      exportBtn: root.querySelector('#oeExportBtn')
    };
    els.addSgBtn.onclick = () => { addRow(); renderRows(); recompute(); };
    els.search.oninput = applySearch;
    els.exportBtn.onclick = exportTableXlsx;
    els.losInputs.forEach(inp => inp.onchange = recompute);
    els.splExcl.onchange = recompute;
  }

  function currentDetCols() {
    const a = GZ.state.data.currentAnalysis;
    return a ? a.otherColumns.filter(c => c.kuerzel === 'DET') : [];
  }

  // Lesezugriff für die Umlaufprüfung (ÖV-Fahrzeiten-Zusatzspuren): die hier
  // konfigurierten Zeilen für eine gegebene Signalgruppe, mit aufgelösten
  // Detektor-Spalten statt roher Indizes. Nur vollständig konfigurierte
  // Zeilen (An- UND Abmeldedetektor gesetzt).
  function getRowsForSg(sgIdx) {
    const detCols = currentDetCols();
    return rows.filter(r => r.sgIdx === sgIdx).map(r => ({
      anDetCols: detCols.filter(c => r.anIdx.has(c.index)),
      abDetCols: detCols.filter(c => r.abIdx.has(c.index)),
      sollfahrzeitSek: r.sollfahrzeitSek,
      zwangsloeschSek: r.zwangsloeschSek
    })).filter(r => r.anDetCols.length > 0 && r.abDetCols.length > 0);
  }

  function addRow() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const detCols = currentDetCols();
    const usedSg = new Set(rows.map(r => r.sgIdx));
    let sgIdx = a.allStats.findIndex((_, i) => !usedSg.has(i));
    if (sgIdx === -1) sgIdx = 0;
    const anDefault = detCols.length ? detCols[0].index : null;
    const abDefault = detCols.length > 1 ? detCols[1].index : (detCols.length ? detCols[0].index : null);
    rows.push({
      id: nextRowId++,
      sgIdx,
      anIdx: new Set(anDefault != null ? [anDefault] : []),
      abIdx: new Set(abDefault != null ? [abDefault] : []),
      sollfahrzeitSek: sollfahrzeitDefault,
      zwangsloeschSek: zwangsloeschDefault
    });
  }

  function populateControls() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    rows.forEach(r => { r.sgIdx = Math.min(r.sgIdx, a.allStats.length - 1); });
    if (rows.length === 0) addRow();
    renderRows();
    recompute();
  }

  function detCheckboxesHtml(detCols, selectedSet) {
    if (detCols.length === 0) return '<div class="cfg-empty">Keine Detektor-Spalten (DET) in den Daten erkannt.</div>';
    return detCols.map(c => {
      const label = c.beschreibung && c.beschreibung !== c.name ? `${c.name} – ${c.beschreibung}` : c.name;
      return `<label class="det-check"><input type="checkbox" value="${c.index}" ${selectedSet.has(c.index) ? 'checked' : ''}> ${esc(label)}</label>`;
    }).join('');
  }

  function renderRows() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const { allStats } = a;
    const detCols = currentDetCols();

    els.sgRows.innerHTML = rows.map(row => {
      const sgOptions = allStats.map(({ col }, i) => {
        const label = col.beschreibung && col.beschreibung !== col.name ? `${col.name} – ${col.beschreibung}` : col.name;
        return `<option value="${i}" ${i === row.sgIdx ? 'selected' : ''}>${esc(label)}</option>`;
      }).join('');
      return `<div class="oe-sg-row" data-row-id="${row.id}">
        <div class="oe-sg-row-head">
          <select class="oe-row-sg">${sgOptions}</select>
          <button type="button" class="oe-row-remove">✕ entfernen</button>
        </div>
        <div class="cfg-grid">
          <div class="cfg-field">
            <label>Anmeldedetektor(en) <span class="cfg-field-hint">(mehrere = ODER-Verknüpfung, z.&nbsp;B. Hauptanmelder oder Türkontakt)</span></label>
            <div class="det-checks oe-row-an-checks">${detCheckboxesHtml(detCols, row.anIdx)}</div>
          </div>
          <div class="cfg-field">
            <label>Abmeldedetektor(en) <span class="cfg-field-hint">(mehrere = ODER-Verknüpfung)</span></label>
            <div class="det-checks oe-row-ab-checks">${detCheckboxesHtml(detCols, row.abIdx)}</div>
          </div>
          <div class="cfg-field">
            <label>Fahrzeit- und Löschparameter</label>
            <div class="num-row"><span>Sollfahrzeit An→Ab</span><input type="number" class="oe-row-soll" min="0" step="1" value="${row.sollfahrzeitSek}"><span>s</span></div>
            <div class="num-row"><span>Zwangslöschzeit</span><input type="number" class="oe-row-zwang" min="1" step="1" value="${row.zwangsloeschSek}"><span>s</span></div>
            <div class="source-note">Sollfahrzeit = ungestörte Fahrzeit zwischen den Meldepunkten (Standortwert, bitte messen/festlegen). Zwangslöschzeit = Zeit, nach der eine Anmeldung ohne Abmeldung verworfen wird (Steuergeräte-Parameter).</div>
          </div>
        </div>
      </div>`;
    }).join('') || '<div class="cfg-empty" style="margin:12px 16px 0;">Keine Signalgruppe konfiguriert – „+ Signalgruppe hinzufügen“ klicken.</div>';

    els.sgRows.querySelectorAll('.oe-sg-row').forEach(rowEl => {
      const id = Number(rowEl.dataset.rowId);
      const row = rows.find(r => r.id === id);
      rowEl.querySelector('.oe-row-sg').onchange = e => { row.sgIdx = Number(e.target.value); recompute(); };
      rowEl.querySelector('.oe-row-an-checks').querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.onchange = () => { toggleSet(row.anIdx, Number(cb.value), cb.checked); recompute(); };
      });
      rowEl.querySelector('.oe-row-ab-checks').querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.onchange = () => { toggleSet(row.abIdx, Number(cb.value), cb.checked); recompute(); };
      });
      rowEl.querySelector('.oe-row-soll').onchange = e => { row.sollfahrzeitSek = leseSek(e.target, sollfahrzeitDefault, 0); recompute(); };
      rowEl.querySelector('.oe-row-zwang').onchange = e => { row.zwangsloeschSek = leseSek(e.target, zwangsloeschDefault, 1); recompute(); };
      rowEl.querySelector('.oe-row-remove').onclick = () => { rows = rows.filter(r => r.id !== id); renderRows(); recompute(); };
    });
  }

  function toggleSet(set, val, on) { if (on) set.add(val); else set.delete(val); }

  function leseLosBounds() {
    return els.losInputs.map((inp, i) => {
      const raw = inp.value.trim();
      const v = raw === '' ? losDefaultBounds[i] : Number(raw);
      return Number.isFinite(v) && v > 0 ? v : losDefaultBounds[i];
    });
  }

  function leseSek(el, fallback, min) {
    const raw = el.value.trim();
    const v = raw === '' ? fallback : Number(raw);
    return Number.isFinite(v) && v >= min ? v : fallback;
  }

  function recompute() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const { allStats, times, seriesByCol, splValues, cycleStarts } = a;
    const detCols = currentDetCols();
    const losBounds = leseLosBounds();
    const exclSpl = parseNumListe(els.splExcl.value);

    const results = [];
    rows.forEach(row => {
      const sgEntry = allStats[row.sgIdx];
      const anDetCols = detCols.filter(c => row.anIdx.has(c.index));
      const abDetCols = detCols.filter(c => row.abIdx.has(c.index));
      if (!sgEntry || anDetCols.length === 0 || abDetCols.length === 0) return;
      const anOccupied = times.map((_, i) => anDetCols.some(c => wzIstBelegt(seriesByCol.get(c.index)[i])));
      const abOccupied = times.map((_, i) => abDetCols.some(c => wzIstBelegt(seriesByCol.get(c.index)[i])));
      const { events, unresolved } = computeOepnvEvents(times, anOccupied, abOccupied, splValues, exclSpl, row.sollfahrzeitSek, row.zwangsloeschSek);
      events.forEach(e => { e.sgLabel = sgEntry.col.name; e.sgColIndex = sgEntry.col.index; e.rowId = row.id; });
      if (unresolved) { unresolved.sgLabel = sgEntry.col.name; unresolved.rowId = row.id; }
      results.push({ row, sgEntry, anDetCols, abDetCols, anOccupied, abOccupied, events, unresolved });
    });

    if (results.length === 0) {
      els.hint.textContent = rows.length === 0
        ? 'Bitte mindestens eine Signalgruppe hinzufügen und konfigurieren.'
        : 'Bitte für mindestens eine Signalgruppe Anmelde- und Abmeldedetektor(en) auswählen.';
      els.hint.className = 'hint warn';
      els.rawPanel.style.display = 'none';
      els.kpiPanel.style.display = 'none';
      els.chartPanel.style.display = 'none';
      els.tablePanel.style.display = 'none';
      GZ.state.data.oepnvActivePoints = [];
      GZ.views.gruenzeitanalyse.refreshReqPoints();
      return;
    }

    GZ.state.data.oepnvActivePoints = results.map(r => ({
      colIndex: r.sgEntry.col.index,
      times: r.events.map(e => e.anTime),
      unresolvedTime: r.unresolved ? r.unresolved.startTime : null
    }));
    GZ.views.gruenzeitanalyse.refreshReqPoints();

    els.rawPanel.style.display = 'block';
    renderRawPoints(results, a);

    const allEvents = results.flatMap(r => r.events).sort((e1, e2) => e1.anTime - e2.anTime);
    const validAbmeldung = allEvents.filter(e => e.type === 'ABMELDUNG' && !e.excluded);
    const validZwangsgeloescht = allEvents.filter(e => e.type === 'ZWANGSGELOESCHT' && !e.excluded);
    const excludedCount = allEvents.filter(e => e.excluded).length;
    const verlustWerte = validAbmeldung.map(e => e.verlustSek).sort((a1, b1) => a1 - b1);
    const losCounts = {};
    LOS_LEVELS.forEach(l => { losCounts[l] = 0; });
    validAbmeldung.forEach(e => { losCounts[losStufe(e.verlustSek, losBounds)]++; });
    const unresolvedList = results.map(r => r.unresolved).filter(Boolean).sort((u1, u2) => u1.startTime - u2.startTime);

    const skipped = rows.length - results.length;
    els.hint.textContent = `${results.length} Signalgruppe(n) ausgewertet (${results.map(r => r.sgEntry.col.name).join(', ')})` +
      (skipped ? ` · ${skipped} unvollständig konfiguriert und übersprungen` : '') +
      ` · ${allEvents.length} Anmeldung(en) gesamt.`;
    els.hint.className = 'hint';
    els.kpiPanel.style.display = 'block';
    els.chartPanel.style.display = 'block';
    els.tablePanel.style.display = 'block';

    renderKpis(verlustWerte, losCounts, validZwangsgeloescht.length, excludedCount, unresolvedList, results);
    renderChart(results, losBounds, cycleStarts, a);
    lastModelRows = buildRowModel(allEvents, unresolvedList, losBounds, results);
    renderTableHead();
    renderTableBody();
    applySearch();
  }

  function renderRawPoints(results, a) {
    els.rawRows.innerHTML = results.map(r => `
      <div class="lane-row oe-raw-row"><div class="lane-name" title="${esc(r.sgEntry.col.name)} Anmeldung">${esc(r.sgEntry.col.name)} An</div><div class="lane-track" data-role="an"><svg></svg></div></div>
      <div class="lane-row oe-raw-row"><div class="lane-name" title="${esc(r.sgEntry.col.name)} Abmeldung">${esc(r.sgEntry.col.name)} Ab</div><div class="lane-track" data-role="ab"><svg></svg></div></div>
    `).join('');
    const laneEls = [...els.rawRows.querySelectorAll('.oe-raw-row')];
    results.forEach((r, i) => {
      const anSvg = laneEls[i * 2].querySelector('svg');
      const abSvg = laneEls[i * 2 + 1].querySelector('svg');
      GZ.charts.oepnvRawPointsChart.render(anSvg, abSvg, els.rawAxis, {
        tMin: a.tMin, tMax: a.tMax,
        anTimes: risingEdgeTimes(a.times, r.anOccupied), abTimes: risingEdgeTimes(a.times, r.abOccupied)
      });
    });
  }

  function renderKpis(verlustWerte, losCounts, zwangsgeloeschtCount, excludedCount, unresolvedList, results) {
    const n = verlustWerte.length;
    const totalOutcomes = n + zwangsgeloeschtCount;
    const successRate = totalOutcomes ? (n / totalOutcomes * 100) : null;
    const cards = [
      { label: 'Ø Verlustzeit', value: n ? mean(verlustWerte).toFixed(1) + 's' : '–', sub: `n=${n}` },
      { label: 'Median Verlustzeit (P50)', value: n ? percentile(verlustWerte, 50).toFixed(1) + 's' : '–' },
      { label: 'P85 Verlustzeit', value: n ? percentile(verlustWerte, 85).toFixed(1) + 's' : '–' },
      { label: 'P95 Verlustzeit', value: n ? percentile(verlustWerte, 95).toFixed(1) + 's' : '–' },
      { label: 'Abgemeldet', value: successRate != null ? successRate.toFixed(0) + '%' : '–', cls: successRate != null && successRate < 100 ? 'warn' : '' },
      { label: 'Zwangsgelöscht', value: zwangsgeloeschtCount, cls: zwangsgeloeschtCount > 0 ? 'crit' : '' },
      { label: 'Ausgeschlossen (SPL)', value: excludedCount },
      { label: 'Unaufgelöst bis Datenende', value: unresolvedList.length ? `Ja (${unresolvedList.length}×)` : 'Nein', cls: unresolvedList.length ? 'crit' : '' }
    ];
    els.kpiGrid.innerHTML = cards.map(c => `
      <div class="kpi ${c.cls || ''}">
        <div class="kpi-label">${esc(c.label)}</div>
        <div class="kpi-value">${esc(c.value)}</div>
        ${c.sub ? `<div class="kpi-sub">${esc(c.sub)}</div>` : ''}
      </div>`).join('');

    els.losDist.innerHTML = LOS_LEVELS.map(l => `
      <div class="los-dist-item"><span class="los-chip los-${l}">${l}</span> ${losCounts[l]}</div>
    `).join('');

    if (results.length > 1) {
      const bodyRows = results.map(r => {
        const valid = r.events.filter(e => e.type === 'ABMELDUNG' && !e.excluded);
        const denied = r.events.filter(e => e.type === 'ZWANGSGELOESCHT' && !e.excluded).length;
        const rate = (valid.length + denied) ? (valid.length / (valid.length + denied) * 100) : null;
        const werte = valid.map(e => e.verlustSek);
        return `<tr>
          <td>${esc(r.sgEntry.col.name)}</td><td>${valid.length}</td>
          <td>${werte.length ? mean(werte).toFixed(1) + 's' : '–'}</td>
          <td>${rate != null ? rate.toFixed(0) + '%' : '–'}</td>
          <td>${denied}</td>
        </tr>`;
      }).join('');
      els.sgBreakdown.innerHTML = `<table class="static-rows">
        <thead><tr><th>Signalgruppe</th><th>n</th><th>Ø Verlustzeit</th><th>Abgemeldet</th><th>Zwangsgelöscht</th></tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>`;
    } else {
      els.sgBreakdown.innerHTML = '';
    }
  }

  function renderChart(results, losBounds, cycleStarts, a) {
    const splTransitions = computeSplTransitions(a.times, a.splValues);
    els.chartRows.innerHTML = results.map(r => `
      <div class="oe-chart-row">
        <div class="oe-chart-row-head"><span>${esc(r.sgEntry.col.name)}</span><span class="win-label" data-info></span></div>
        <div class="chart-box" data-chart><svg></svg><div class="chart-tooltip"></div></div>
        <div class="axis oe-chart-axis" data-axis><svg></svg></div>
      </div>
    `).join('');
    const rowEls = [...els.chartRows.querySelectorAll('.oe-chart-row')];
    results.forEach((r, i) => {
      const rowEl = rowEls[i];
      const abmeldungEvents = r.events.filter(e => e.type === 'ABMELDUNG');
      const zwangsgeloeschtEvents = r.events.filter(e => e.type === 'ZWANGSGELOESCHT');
      const result = GZ.charts.oepnvScatterChart.render(rowEl.querySelector('[data-chart]'), rowEl.querySelector('[data-axis] svg'), {
        tMin: a.tMin, tMax: a.tMax, abmeldungEvents, zwangsgeloeschtEvents, losBounds,
        splTransitions, cycleStarts, onPointClick: GZ.app.jumpToGruenzeit
      });
      const total = abmeldungEvents.length + zwangsgeloeschtEvents.length;
      rowEl.querySelector('[data-info]').textContent = `${total} Ereignis(se)` + (result && result.yMax ? ` · y-Achse bis ${Math.round(result.yMax)}s` : '');
    });
  }

  function buildRowModel(allEvents, unresolvedList, losBounds, results) {
    const seriesByCol = GZ.state.data.currentAnalysis.seriesByCol;
    const cycleStarts = GZ.state.data.currentAnalysis.cycleStarts;
    const findResult = id => results.find(r => r.row.id === id);
    let nr = 0;
    const modelRows = allEvents.map(e => {
      nr++;
      const result = findResult(e.rowId);
      const isZwang = e.type === 'ZWANGSGELOESCHT';
      let ergebnisShort, ergebnisTitle, rowCls;
      if (e.excluded) {
        ergebnisShort = 'Sonstige'; ergebnisTitle = `Ausgeschlossen (SPL ${e.spl})`; rowCls = 'oe-excluded';
      } else if (isZwang) {
        ergebnisShort = 'Zwangsgelöscht'; ergebnisTitle = null; rowCls = 'oe-abgemeldet';
      } else {
        ergebnisShort = 'Abgemeldet'; ergebnisTitle = null; rowCls = '';
      }
      return {
        id: nr, rowCls, clickT: e.anTime, nr,
        sgLabel: e.sgLabel,
        anTime: e.anTime, tx: txAtTime(e.anTime, cycleStarts),
        ergebnisShort, ergebnisTitle,
        endTime: e.endTime, spl: String(e.spl),
        istFahrzeitSek: e.istFahrzeitSek,
        verlustSek: e.verlustSek, verlustIsEstimate: isZwang,
        qsv: (!e.excluded && !isZwang) ? losStufe(e.verlustSek, losBounds) : null,
        anPunkt: auslosenderDetektor(result.anDetCols, seriesByCol, e.anIdx),
        abPunkt: e.type === 'ABMELDUNG' ? auslosenderDetektor(result.abDetCols, seriesByCol, e.endIdx) : '–'
      };
    });

    unresolvedList.forEach(u => {
      nr++;
      const result = findResult(u.rowId);
      modelRows.push({
        id: nr, rowCls: 'oe-unresolved', clickT: u.startTime, nr,
        sgLabel: u.sgLabel,
        anTime: u.startTime, tx: txAtTime(u.startTime, cycleStarts),
        ergebnisShort: 'Sonstige', ergebnisTitle: 'Unaufgelöst bis Datenende (weder Abmeldung noch Zwangslöschung)',
        endTime: null, spl: String(u.spl),
        istFahrzeitSek: u.durationSec,
        verlustSek: null, verlustIsEstimate: false,
        qsv: null,
        anPunkt: result ? auslosenderDetektor(result.anDetCols, seriesByCol, u.startIdx) : '–',
        abPunkt: '–'
      });
    });

    return modelRows;
  }

  function compareValues(av, bv, dir) {
    const na = av == null, nb = bv == null;
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    const cmp = (typeof av === 'number' && typeof bv === 'number') ? av - bv : String(av).localeCompare(String(bv), 'de');
    return dir === 'asc' ? cmp : -cmp;
  }

  function sortedRows() {
    const col = TABLE_COLUMNS.find(c => c.key === sortState.key);
    return [...lastModelRows].sort((a, b) => compareValues(col.value(a), col.value(b), sortState.dir));
  }

  function renderTableHead() {
    els.tableHead.innerHTML = `<tr>${TABLE_COLUMNS.map(c => {
      const active = sortState.key === c.key;
      const arrow = active ? (sortState.dir === 'asc' ? '▲' : '▼') : '';
      return `<th class="sortable" data-key="${c.key}">${esc(c.label)}${arrow ? `<span class="sort-arrow">${arrow}</span>` : ''}</th>`;
    }).join('')}</tr>`;
    els.tableHead.querySelectorAll('th').forEach(th => {
      th.onclick = () => {
        const key = th.dataset.key;
        sortState = { key, dir: sortState.key === key && sortState.dir === 'asc' ? 'desc' : 'asc' };
        renderTableHead();
        renderTableBody();
        applySearch();
      };
    });
  }

  function renderTableBody() {
    const rowsSorted = sortedRows();
    els.eventsBody.innerHTML = rowsSorted.length
      ? rowsSorted.map(r => `<tr class="${r.rowCls}" data-t="${r.clickT}" data-row-id="${r.id}">${TABLE_COLUMNS.map(c => `<td>${c.render(r)}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${TABLE_COLUMNS.length}">Keine Anmeldungen gefunden.</td></tr>`;
    els.eventsBody.querySelectorAll('tr[data-t]').forEach(tr => {
      tr.addEventListener('click', () => GZ.app.jumpToGruenzeit(Number(tr.dataset.t)));
    });
  }

  function applySearch() {
    if (!els.eventsBody) return;
    const term = els.search.value.trim().toLowerCase();
    const trs = [...els.eventsBody.querySelectorAll('tr[data-t]')];
    let shown = 0;
    trs.forEach(tr => {
      const match = !term || tr.textContent.toLowerCase().includes(term);
      tr.classList.toggle('oe-hidden', !match);
      if (match) shown++;
    });
    els.searchInfo.textContent = term ? `${shown} von ${trs.length} Ereignis(sen) angezeigt.` : '';
  }

  function exportTableXlsx() {
    const visibleIds = new Set([...els.eventsBody.querySelectorAll('tr[data-t]:not(.oe-hidden)')].map(tr => Number(tr.dataset.rowId)));
    const rowsToExport = sortedRows().filter(r => visibleIds.has(r.id));
    if (rowsToExport.length === 0) return;
    const header = TABLE_COLUMNS.map(c => c.label);
    const data = rowsToExport.map(r => TABLE_COLUMNS.map(c => (c.exportValue || c.value)(r)));
    const blob = GZ.xlsxWriter.buildWorkbookBlob('ÖPNV Anmeldungen', header, data);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'oepnv_anmeldungen.xlsx';
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  GZ.views = GZ.views || {};
  GZ.views.oepnvQa = { init, populateControls, recompute, getRowsForSg };
})(window.GZ = window.GZ || {});
