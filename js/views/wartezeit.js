/* GZ.views.wartezeit — Tab "Wartezeit ab Anforderung": Zuweisung von
   Signalgruppe + Detektor(en), Kennzahlen, Streudiagramm und Ereignistabelle. */
(function (GZ) {
  'use strict';
  const { esc, fmtTs, fmtTimeShort } = GZ.format;
  const { mean, percentile, parseNumListe } = GZ.stats;
  const { computeSplTransitions } = GZ.segments;
  const {
    wzThresholdDefaults, wzIstBelegt, computeWartezeitEvents, qualitaetsstufe,
    WZ_QUAL_LABEL, txAtTime, auslosenderDetektor
  } = GZ.wartezeitLogic;

  const thresholdsByType = { MIV: { ...wzThresholdDefaults.MIV }, FUSS: { ...wzThresholdDefaults.FUSS } };
  let els = null;

  function init(root) {
    els = {
      root,
      sgSelect: root.querySelector('#wzSgSelect'),
      detChecks: root.querySelector('#wzDetChecks'),
      warnSek: root.querySelector('#wzWarnSek'),
      grenzSek: root.querySelector('#wzGrenzSek'),
      gapRow: root.querySelector('#wzGapRow'),
      gapSek: root.querySelector('#wzGapSek'),
      splExcl: root.querySelector('#wzSplExcl'),
      hint: root.querySelector('#wzHint'),
      kpiPanel: root.querySelector('#wzKpiPanel'),
      kpiGrid: root.querySelector('#wzKpiGrid'),
      chartPanel: root.querySelector('#wzChartPanel'),
      chartInfo: root.querySelector('#wzChartInfo'),
      chartBox: root.querySelector('#wzChartBox'),
      axis: root.querySelector('#wzAxis'),
      tablePanel: root.querySelector('#wzTablePanel'),
      eventsBody: root.querySelector('#wzEventsBody')
    };
  }

  function aktuellerTyp() { return els.root.querySelector('#wzTypGroup input:checked').value; }

  function leseGrenzen() {
    const typ = aktuellerTyp();
    const warnRaw = els.warnSek.value.trim();
    const grenzRaw = els.grenzSek.value.trim();
    const warn = warnRaw === '' ? null : Number(warnRaw);
    const grenz = grenzRaw === '' ? wzThresholdDefaults[typ].grenz : Number(grenzRaw);
    thresholdsByType[typ] = {
      warn: (warn != null && Number.isFinite(warn)) ? warn : null,
      grenz: Number.isFinite(grenz) && grenz > 0 ? grenz : wzThresholdDefaults[typ].grenz
    };
    return thresholdsByType[typ];
  }

  function ladeGrenzenInUI() {
    const t = thresholdsByType[aktuellerTyp()];
    els.warnSek.value = t.warn != null ? t.warn : '';
    els.grenzSek.value = t.grenz;
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
    if (detCols.length === 0) {
      els.detChecks.innerHTML = '<div class="cfg-empty">Keine Detektor-Spalten (DET) in den Daten erkannt.</div>';
    } else {
      const prevChecked = new Set([...els.detChecks.querySelectorAll('input:checked')].map(i => i.value));
      els.detChecks.innerHTML = detCols.map((c, i) => {
        const label = c.beschreibung && c.beschreibung !== c.name ? `${c.name} – ${c.beschreibung}` : c.name;
        const checked = prevChecked.size ? prevChecked.has(String(c.index)) : i === 0;
        return `<label class="det-check"><input type="checkbox" value="${c.index}" ${checked ? 'checked' : ''}> ${esc(label)}</label>`;
      }).join('');
    }
    ladeGrenzenInUI();
    wireEvents();
    recompute();
  }

  let wired = false;
  function wireEvents() {
    els.sgSelect.onchange = recompute;
    els.detChecks.querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = recompute);
    if (wired) return;
    wired = true;
    els.root.querySelectorAll('#wzTypGroup input').forEach(r => r.onchange = () => { ladeGrenzenInUI(); recompute(); });
    els.root.querySelectorAll('#wzBlinkGroup input').forEach(r => r.onchange = recompute);
    els.root.querySelectorAll('#wzDetTypGroup input').forEach(r => r.onchange = () => {
      els.gapRow.style.display = els.root.querySelector('#wzDetTypGroup input:checked').value === 'praesenz' ? 'flex' : 'none';
      recompute();
    });
    [els.warnSek, els.grenzSek, els.gapSek, els.splExcl].forEach(inp => inp.onchange = recompute);
  }

  function recompute() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const { allStats, otherColumns, times, seriesByCol, splValues, cycleStarts } = a;
    const sgIdx = Number(els.sgSelect.value);
    const sgEntry = allStats[sgIdx];
    const detCols = otherColumns.filter(c => c.kuerzel === 'DET');
    const selectedDetIdx = [...els.detChecks.querySelectorAll('input:checked')].map(i => Number(i.value));
    const selectedDetCols = detCols.filter(c => selectedDetIdx.includes(c.index));
    const inkBlinken = els.root.querySelector('#wzBlinkGroup input:checked').value === 'ja';
    const detTyp = els.root.querySelector('#wzDetTypGroup input:checked').value;
    const holdUntilGreen = detTyp !== 'praesenz';
    const gapTolSek = Math.max(0, Number(els.gapSek.value) || 0);
    const exclSpl = parseNumListe(els.splExcl.value);
    const thresholds = leseGrenzen();

    if (!sgEntry || selectedDetCols.length === 0) {
      els.hint.textContent = 'Bitte mindestens eine Signalgruppe und einen Detektor auswählen.';
      els.hint.className = 'hint warn';
      els.kpiPanel.style.display = 'none';
      els.chartPanel.style.display = 'none';
      els.tablePanel.style.display = 'none';
      GZ.state.data.wzActivePoints = null;
      GZ.views.gruenzeitanalyse.refreshReqPoints();
      return;
    }

    const sgRaw = seriesByCol.get(sgEntry.col.index);
    const detOccupied = times.map((_, i) => selectedDetCols.some(c => wzIstBelegt(seriesByCol.get(c.index)[i])));
    const { events, nAufgeloest, unresolved } = computeWartezeitEvents(times, sgRaw, detOccupied, splValues, inkBlinken, gapTolSek, holdUntilGreen, exclSpl);

    GZ.state.data.wzActivePoints = {
      colIndex: sgEntry.col.index,
      times: events.map(e => e.reqTime),
      unresolvedTime: unresolved ? unresolved.startTime : null
    };
    GZ.views.gruenzeitanalyse.refreshReqPoints();

    const validEvents = events.filter(e => !e.excluded);
    const excludedCount = events.length - validEvents.length;
    const waits = validEvents.map(e => e.waitSec).sort((a, b) => a - b);
    const nWarnung = validEvents.filter(e => qualitaetsstufe(e.waitSec, thresholds.warn, thresholds.grenz) === 'WARNUNG').length;
    const nGrenzwert = validEvents.filter(e => qualitaetsstufe(e.waitSec, thresholds.warn, thresholds.grenz) === 'GRENZWERT').length;

    els.hint.textContent = `Signalgruppe „${sgEntry.col.name}“, Detektor(en): ${selectedDetCols.map(c => c.name).join(' + ')} · ${events.length} Anforderung(en) ausgewertet (${detTyp === 'praesenz' ? 'Präsenzdetektor, Lückentoleranz ' + gapTolSek + 's' : 'Impulsdetektor/Taster, Anforderung bis Freigabe'}).`;
    els.hint.className = 'hint';
    els.kpiPanel.style.display = 'block';
    els.chartPanel.style.display = 'block';
    els.tablePanel.style.display = 'block';

    renderKpis(waits, nWarnung, nGrenzwert, excludedCount, nAufgeloest, unresolved, thresholds);
    renderChart(events, thresholds, cycleStarts, a);
    renderTable(events, unresolved, thresholds, selectedDetCols, seriesByCol, cycleStarts);
  }

  function renderKpis(waits, nWarnung, nGrenzwert, excludedCount, nAufgeloest, unresolved, thresholds) {
    const n = waits.length;
    const cards = [
      { label: 'Mittelwert', value: n ? mean(waits).toFixed(1) + 's' : '–', sub: `n=${n}` },
      { label: 'Median (P50)', value: n ? percentile(waits, 50).toFixed(1) + 's' : '–' },
      { label: 'P85', value: n ? percentile(waits, 85).toFixed(1) + 's' : '–' },
      { label: 'P95', value: n ? percentile(waits, 95).toFixed(1) + 's' : '–' }
    ];
    if (thresholds.warn != null) cards.push({ label: `Warnung (>${thresholds.warn}s)`, value: nWarnung, cls: nWarnung > 0 ? 'warn' : '' });
    cards.push({ label: `Grenzwert (>${thresholds.grenz}s)`, value: nGrenzwert, cls: nGrenzwert > 0 ? 'crit' : '' });
    cards.push({ label: 'Ausgeschlossen (SPL)', value: excludedCount });
    cards.push({ label: 'Aufgelöst ohne Grün', value: nAufgeloest, cls: nAufgeloest > 0 ? 'warn' : '' });
    cards.push({ label: 'Unaufgelöst bis Datenende', value: unresolved ? `Ja (${unresolved.durationSec.toFixed(0)}s)` : 'Nein', cls: unresolved ? 'crit' : '' });

    els.kpiGrid.innerHTML = cards.map(c => `
      <div class="kpi ${c.cls || ''}">
        <div class="kpi-label">${esc(c.label)}</div>
        <div class="kpi-value">${esc(c.value)}</div>
        ${c.sub ? `<div class="kpi-sub">${esc(c.sub)}</div>` : ''}
      </div>`).join('');
  }

  function renderChart(events, thresholds, cycleStarts, a) {
    const splTransitions = computeSplTransitions(a.times, a.splValues);
    const result = GZ.charts.waitScatterChart.render(els.chartBox, els.axis.querySelector('svg'), {
      tMin: a.tMin, tMax: a.tMax, events, warnSek: thresholds.warn, grenzSek: thresholds.grenz,
      splTransitions, cycleStarts, onPointClick: GZ.app.jumpToGruenzeit
    });
    els.chartInfo.textContent = `${events.length} Ereignis(se)` + (result && result.yMax ? ` · y-Achse bis ${Math.round(result.yMax)}s` : '');
  }

  function renderTable(events, unresolved, thresholds, detCols, seriesByCol, cycleStarts) {
    let rows = events.map((e, i) => {
      const tx = txAtTime(e.reqTime, cycleStarts);
      const q = qualitaetsstufe(e.waitSec, thresholds.warn, thresholds.grenz);
      const cls = e.excluded ? 'wz-excluded' : (q === 'GRENZWERT' ? 'wz-grenzwert' : q === 'WARNUNG' ? 'wz-warnung' : '');
      const qLabel = e.excluded ? 'ausgeschlossen (SPL)' : WZ_QUAL_LABEL[q];
      const det = auslosenderDetektor(detCols, seriesByCol, e.reqIdx);
      return `<tr class="${cls}" data-t="${e.reqTime}">
        <td>${i + 1}</td><td>${fmtTs(new Date(e.reqTime))}</td><td>${tx ?? '–'}</td>
        <td>${fmtTs(new Date(e.greenTime))}</td><td>${esc(e.spl)}</td>
        <td>${e.waitSec.toFixed(1)}s</td><td>${esc(qLabel)}</td><td>${esc(det)}</td>
      </tr>`;
    }).join('');

    if (unresolved) {
      const tx = txAtTime(unresolved.startTime, cycleStarts);
      rows += `<tr class="wz-unresolved" data-t="${unresolved.startTime}">
        <td>–</td><td>${fmtTs(new Date(unresolved.startTime))}</td><td>${tx ?? '–'}</td>
        <td>(kein Grün bis Datenende)</td><td>–</td>
        <td>${unresolved.durationSec.toFixed(1)}s*</td><td>unaufgelöst</td><td>–</td>
      </tr>`;
    }

    els.eventsBody.innerHTML = rows || '<tr><td colspan="8">Keine Wartezeit-Ereignisse gefunden.</td></tr>';
    els.eventsBody.querySelectorAll('tr[data-t]').forEach(tr => {
      tr.addEventListener('click', () => GZ.app.jumpToGruenzeit(Number(tr.dataset.t)));
    });
  }

  GZ.views = GZ.views || {};
  GZ.views.wartezeit = { init, populateControls, recompute };
})(window.GZ = window.GZ || {});
