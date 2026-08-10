/* GZ.views.oepnvQa — Tab "ÖPNV — Anmeldung/Abmeldung": Zuweisung von
   Signalgruppe + getrennten An-/Abmeldedetektor(en), Fahrzeit-/Löschparameter,
   Rohpunkte-Ansicht, LOS-Kennzahlen (A-F) auf Basis der Verlustzeit,
   Streudiagramm und durchsuchbare Ereignistabelle. */
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

  function init(root) {
    els = {
      root,
      sgSelect: root.querySelector('#oeSgSelect'),
      anDetChecks: root.querySelector('#oeAnDetChecks'),
      abDetChecks: root.querySelector('#oeAbDetChecks'),
      sollfahrzeit: root.querySelector('#oeSollfahrzeit'),
      zwangsloesch: root.querySelector('#oeZwangsloesch'),
      losInputs: [...root.querySelectorAll('.oe-los-bound')],
      splExcl: root.querySelector('#oeSplExcl'),
      hint: root.querySelector('#oeHint'),
      rawPanel: root.querySelector('#oeRawPanel'),
      rawAnTrack: root.querySelector('#oeRawAnTrack svg'),
      rawAbTrack: root.querySelector('#oeRawAbTrack svg'),
      rawAxis: root.querySelector('#oeRawAxis svg'),
      kpiPanel: root.querySelector('#oeKpiPanel'),
      kpiGrid: root.querySelector('#oeKpiGrid'),
      losDist: root.querySelector('#oeLosDist'),
      chartPanel: root.querySelector('#oeChartPanel'),
      chartInfo: root.querySelector('#oeChartInfo'),
      chartBox: root.querySelector('#oeChartBox'),
      axis: root.querySelector('#oeAxis'),
      tablePanel: root.querySelector('#oeTablePanel'),
      eventsBody: root.querySelector('#oeEventsBody'),
      search: root.querySelector('#oeSearch'),
      searchInfo: root.querySelector('#oeSearchInfo')
    };
  }

  function populateDetChecks(el, detCols, defaultIdx) {
    if (detCols.length === 0) {
      el.innerHTML = '<div class="cfg-empty">Keine Detektor-Spalten (DET) in den Daten erkannt.</div>';
      return;
    }
    const prevChecked = new Set([...el.querySelectorAll('input:checked')].map(i => i.value));
    el.innerHTML = detCols.map((c, i) => {
      const label = c.beschreibung && c.beschreibung !== c.name ? `${c.name} – ${c.beschreibung}` : c.name;
      const checked = prevChecked.size ? prevChecked.has(String(c.index)) : i === defaultIdx;
      return `<label class="det-check"><input type="checkbox" value="${c.index}" ${checked ? 'checked' : ''}> ${esc(label)}</label>`;
    }).join('');
  }

  function populateControls() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const { allStats, otherColumns } = a;

    const prevSg = els.sgSelect.value;
    els.sgSelect.innerHTML = allStats.map(({ col }, i) => {
      const label = col.beschreibung && col.beschreibung !== col.name ? `${col.name} – ${col.beschreibung}` : col.name;
      return `<option value="${i}">${esc(label)}</option>`;
    }).join('');
    if (prevSg && allStats[prevSg]) els.sgSelect.value = prevSg;

    const detCols = otherColumns.filter(c => c.kuerzel === 'DET');
    populateDetChecks(els.anDetChecks, detCols, 0);
    populateDetChecks(els.abDetChecks, detCols, detCols.length > 1 ? 1 : 0);

    wireEvents();
    recompute();
  }

  function wireEvents() {
    els.sgSelect.onchange = recompute;
    els.anDetChecks.querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = recompute);
    els.abDetChecks.querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = recompute);
    els.sollfahrzeit.onchange = recompute;
    els.zwangsloesch.onchange = recompute;
    els.losInputs.forEach(inp => inp.onchange = recompute);
    els.splExcl.onchange = recompute;
    els.search.oninput = applySearch;
  }

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
    const { allStats, otherColumns, times, seriesByCol, splValues, cycleStarts } = a;
    const sgIdx = Number(els.sgSelect.value);
    const sgEntry = allStats[sgIdx];
    const detCols = otherColumns.filter(c => c.kuerzel === 'DET');
    const anIdx = [...els.anDetChecks.querySelectorAll('input:checked')].map(i => Number(i.value));
    const abIdx = [...els.abDetChecks.querySelectorAll('input:checked')].map(i => Number(i.value));
    const anDetCols = detCols.filter(c => anIdx.includes(c.index));
    const abDetCols = detCols.filter(c => abIdx.includes(c.index));
    const sollfahrzeitSek = leseSek(els.sollfahrzeit, sollfahrzeitDefault, 0);
    const zwangsloeschSek = leseSek(els.zwangsloesch, zwangsloeschDefault, 1);
    const losBounds = leseLosBounds();
    const exclSpl = parseNumListe(els.splExcl.value);

    if (!sgEntry || anDetCols.length === 0 || abDetCols.length === 0) {
      els.hint.textContent = 'Bitte Signalgruppe sowie mindestens einen Anmelde- und einen Abmeldedetektor auswählen.';
      els.hint.className = 'hint warn';
      els.rawPanel.style.display = 'none';
      els.kpiPanel.style.display = 'none';
      els.chartPanel.style.display = 'none';
      els.tablePanel.style.display = 'none';
      GZ.state.data.oepnvActivePoints = null;
      GZ.views.gruenzeitanalyse.refreshReqPoints();
      return;
    }

    const anOccupied = times.map((_, i) => anDetCols.some(c => wzIstBelegt(seriesByCol.get(c.index)[i])));
    const abOccupied = times.map((_, i) => abDetCols.some(c => wzIstBelegt(seriesByCol.get(c.index)[i])));
    const { events, unresolved } = computeOepnvEvents(times, anOccupied, abOccupied, splValues, exclSpl, sollfahrzeitSek, zwangsloeschSek);

    GZ.state.data.oepnvActivePoints = {
      colIndex: sgEntry.col.index,
      times: events.map(e => e.anTime),
      unresolvedTime: unresolved ? unresolved.startTime : null
    };
    GZ.views.gruenzeitanalyse.refreshReqPoints();

    els.rawPanel.style.display = 'block';
    renderRawPoints(risingEdgeTimes(times, anOccupied), risingEdgeTimes(times, abOccupied), a);

    const abmeldungEvents = events.filter(e => e.type === 'ABMELDUNG');
    const zwangsgeloeschtEvents = events.filter(e => e.type === 'ZWANGSGELOESCHT');
    const validAbmeldung = abmeldungEvents.filter(e => !e.excluded);
    const validZwangsgeloescht = zwangsgeloeschtEvents.filter(e => !e.excluded);
    const excludedCount = events.length - validAbmeldung.length - validZwangsgeloescht.length;
    const verlustWerte = validAbmeldung.map(e => e.verlustSek).sort((a, b) => a - b);
    const losCounts = {};
    LOS_LEVELS.forEach(l => { losCounts[l] = 0; });
    validAbmeldung.forEach(e => { losCounts[losStufe(e.verlustSek, losBounds)]++; });

    els.hint.textContent = `Signalgruppe „${sgEntry.col.name}“, Anmeldedetektor(en): ${anDetCols.map(c => c.name).join(' + ')}, Abmeldedetektor(en): ${abDetCols.map(c => c.name).join(' + ')} · Sollfahrzeit ${sollfahrzeitSek}s, Zwangslöschzeit ${zwangsloeschSek}s · ${events.length} Anmeldung(en) ausgewertet.`;
    els.hint.className = 'hint';
    els.kpiPanel.style.display = 'block';
    els.chartPanel.style.display = 'block';
    els.tablePanel.style.display = 'block';

    renderKpis(verlustWerte, losCounts, validZwangsgeloescht.length, excludedCount, unresolved);
    renderChart(abmeldungEvents, zwangsgeloeschtEvents, losBounds, cycleStarts, a);
    renderTable(events, unresolved, losBounds, anDetCols, abDetCols, seriesByCol, cycleStarts);
    applySearch();
  }

  function renderRawPoints(anTimes, abTimes, a) {
    GZ.charts.oepnvRawPointsChart.render(els.rawAnTrack, els.rawAbTrack, els.rawAxis, {
      tMin: a.tMin, tMax: a.tMax, anTimes, abTimes
    });
  }

  function renderKpis(verlustWerte, losCounts, zwangsgeloeschtCount, excludedCount, unresolved) {
    const n = verlustWerte.length;
    const totalOutcomes = n + zwangsgeloeschtCount;
    const successRate = totalOutcomes ? (n / totalOutcomes * 100) : null;
    const cards = [
      { label: 'Ø Verlustzeit', value: n ? mean(verlustWerte).toFixed(1) + 's' : '–', sub: `n=${n}` },
      { label: 'Median Verlustzeit (P50)', value: n ? percentile(verlustWerte, 50).toFixed(1) + 's' : '–' },
      { label: 'P85 Verlustzeit', value: n ? percentile(verlustWerte, 85).toFixed(1) + 's' : '–' },
      { label: 'P95 Verlustzeit', value: n ? percentile(verlustWerte, 95).toFixed(1) + 's' : '–' },
      { label: 'Abmeldung erhalten', value: successRate != null ? successRate.toFixed(0) + '%' : '–', cls: successRate != null && successRate < 100 ? 'warn' : '' },
      { label: 'Zwangsgelöscht', value: zwangsgeloeschtCount, cls: zwangsgeloeschtCount > 0 ? 'crit' : '' },
      { label: 'Ausgeschlossen (SPL)', value: excludedCount },
      { label: 'Unaufgelöst bis Datenende', value: unresolved ? `Ja (${unresolved.durationSec.toFixed(0)}s)` : 'Nein', cls: unresolved ? 'crit' : '' }
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
  }

  function renderChart(abmeldungEvents, zwangsgeloeschtEvents, losBounds, cycleStarts, a) {
    const splTransitions = computeSplTransitions(a.times, a.splValues);
    const result = GZ.charts.oepnvScatterChart.render(els.chartBox, els.axis.querySelector('svg'), {
      tMin: a.tMin, tMax: a.tMax, abmeldungEvents, zwangsgeloeschtEvents, losBounds,
      splTransitions, cycleStarts, onPointClick: GZ.app.jumpToGruenzeit
    });
    const total = abmeldungEvents.length + zwangsgeloeschtEvents.length;
    els.chartInfo.textContent = `${total} Ereignis(se)` + (result && result.yMax ? ` · y-Achse bis ${Math.round(result.yMax)}s` : '');
  }

  function losChipHtml(level) {
    return level ? `<span class="los-chip los-${level}">${level}</span>` : '<span class="los-chip los-na">–</span>';
  }

  function renderTable(events, unresolved, losBounds, anDetCols, abDetCols, seriesByCol, cycleStarts) {
    let rows = events.map((e, i) => {
      const tx = txAtTime(e.anTime, cycleStarts);
      const cls = e.excluded ? 'oe-excluded' : (e.type === 'ZWANGSGELOESCHT' ? 'oe-abgemeldet' : '');
      const ergebnis = e.excluded ? 'ausgeschlossen (SPL)' : (e.type === 'ABMELDUNG' ? 'Abmeldung erhalten' : 'Zwangsgelöscht (keine Abmeldung)');
      const losLabel = (!e.excluded && e.type === 'ABMELDUNG') ? losStufe(e.verlustSek, losBounds) : null;
      const verlustText = e.type === 'ZWANGSGELOESCHT' ? `≥ ${e.verlustSek.toFixed(1)}s*` : `${e.verlustSek.toFixed(1)}s`;
      const anDet = auslosenderDetektor(anDetCols, seriesByCol, e.anIdx);
      const abDet = e.type === 'ABMELDUNG' ? auslosenderDetektor(abDetCols, seriesByCol, e.endIdx) : '–';
      return `<tr class="${cls}" data-t="${e.anTime}">
        <td>${i + 1}</td><td>${fmtTs(new Date(e.anTime))}</td><td>${tx ?? '–'}</td>
        <td>${esc(ergebnis)}</td><td>${fmtTs(new Date(e.endTime))}</td><td>${esc(e.spl)}</td>
        <td>${e.istFahrzeitSek.toFixed(1)}s</td><td>${esc(verlustText)}</td><td>${losChipHtml(losLabel)}</td>
        <td>${esc(anDet)}</td><td>${esc(abDet)}</td>
      </tr>`;
    }).join('');

    if (unresolved) {
      const tx = txAtTime(unresolved.startTime, cycleStarts);
      const anDet = auslosenderDetektor(anDetCols, seriesByCol, unresolved.startIdx);
      rows += `<tr class="oe-unresolved" data-t="${unresolved.startTime}">
        <td>–</td><td>${fmtTs(new Date(unresolved.startTime))}</td><td>${tx ?? '–'}</td>
        <td>unaufgelöst (weder Abmeldung noch Zwangslöschung bis Datenende)</td><td>–</td><td>–</td>
        <td>${unresolved.durationSec.toFixed(1)}s*</td><td>–</td><td>${losChipHtml(null)}</td>
        <td>${esc(anDet)}</td><td>–</td>
      </tr>`;
    }

    els.eventsBody.innerHTML = rows || '<tr><td colspan="11">Keine Anmeldungen gefunden.</td></tr>';
    els.eventsBody.querySelectorAll('tr[data-t]').forEach(tr => {
      tr.addEventListener('click', () => GZ.app.jumpToGruenzeit(Number(tr.dataset.t)));
    });
  }

  function applySearch() {
    if (!els.eventsBody) return;
    const term = els.search.value.trim().toLowerCase();
    const rows = [...els.eventsBody.querySelectorAll('tr[data-t]')];
    let shown = 0;
    rows.forEach(tr => {
      const match = !term || tr.textContent.toLowerCase().includes(term);
      tr.classList.toggle('oe-hidden', !match);
      if (match) shown++;
    });
    els.searchInfo.textContent = term ? `${shown} von ${rows.length} Ereignis(sen) angezeigt.` : '';
  }

  GZ.views = GZ.views || {};
  GZ.views.oepnvQa = { init, populateControls, recompute };
})(window.GZ = window.GZ || {});
