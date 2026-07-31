/* GZ.views.gruenzeitanalyse — Tab "Grünzeitanalyse": Navigator, Signalzeiten-
   diagramm mit Umlauf-Fenster, Kennzahlen-Tabelle, Dunkel-Panel und
   Grünzeit-Trend (Zeitverlauf/CDF, einzeln oder gestapelt). */
(function (GZ) {
  'use strict';
  const { esc, fmtDauer } = GZ.format;
  const { mean, median, stdDev, detectAnomalies } = GZ.stats;
  const {
    computeGlobalTU, computeSplTransitions, getFlaggedAnomalies, computeAnomalyBands,
    computeTrendSplWindows
  } = GZ.segments;

  let els = null;

  function init(root) {
    els = {
      root,
      navigator: root.querySelector('#gzNavigator'),
      diagramControls: root.querySelector('#gzDiagramControls'),
      btnWinPrev: root.querySelector('#gzBtnWinPrev'),
      btnWinNext: root.querySelector('#gzBtnWinNext'),
      winLabel: root.querySelector('#gzWinLabel'),
      winSize: root.querySelector('#gzWinSize'),
      btnWinAll: root.querySelector('#gzBtnWinAll'),
      timelineEl: root.querySelector('#gzTimeline'),
      splBarSvgEl: root.querySelector('#gzSplBar svg'),
      axisSvgEl: root.querySelector('#gzAxis svg'),
      statsScopeGroup: root.querySelector('#gzStatsScopeGroup'),
      statsBody: root.querySelector('#gzStatsBody'),
      dunkelPanel: root.querySelector('#gzDunkelPanel'),
      dunkelBody: root.querySelector('#gzDunkelBody'),
      dunkelHint: root.querySelector('#gzDunkelHint'),
      trendTarget: root.querySelector('#gzTrendTarget'),
      trendModeGroup: root.querySelector('#gzTrendModeGroup'),
      trendSgChecks: root.querySelector('#gzTrendSgChecks'),
      trendChartBox: root.querySelector('#gzTrendChartBox'),
      trendAxis: root.querySelector('#gzTrendAxis'),
      trendHistBox: root.querySelector('#gzTrendHistBox'),
      trendHistAxis: root.querySelector('#gzTrendHistAxis'),
      trendCaption: root.querySelector('#gzTrendCaption'),
      trendStackContainer: root.querySelector('#gzTrendStackContainer')
    };

    els.btnWinPrev.addEventListener('click', () => {
      const w = GZ.state.data.window;
      if (w.showAll) return;
      w.startIdx = Math.max(0, w.startIdx - 1);
      updateDiagramWindow();
    });
    els.btnWinNext.addEventListener('click', () => {
      const a = GZ.state.data.currentAnalysis, w = GZ.state.data.window;
      if (w.showAll || !a) return;
      const maxStart = a.cycleStarts.length - 1;
      w.startIdx = Math.min(maxStart, w.startIdx + 1);
      updateDiagramWindow();
    });
    els.winSize.addEventListener('change', () => {
      const v = parseInt(els.winSize.value, 10);
      GZ.state.data.window.count = Number.isFinite(v) && v > 0 ? v : 5;
      els.winSize.value = GZ.state.data.window.count;
      updateDiagramWindow();
    });
    els.btnWinAll.addEventListener('click', () => {
      const w = GZ.state.data.window;
      w.showAll = !w.showAll;
      els.btnWinAll.textContent = w.showAll ? 'Fenster anzeigen' : 'Alle anzeigen';
      els.btnWinAll.classList.toggle('primary', w.showAll);
      updateDiagramWindow();
    });
    els.statsScopeGroup.addEventListener('click', evt => {
      const btn = evt.target.closest('button[data-scope]');
      if (!btn || btn.disabled) return;
      GZ.state.data.statsScope = btn.dataset.scope;
      els.statsScopeGroup.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      const a = GZ.state.data.currentAnalysis;
      if (!a) return;
      a.allStats.forEach(({ stats }) => { stats._splMedCache = null; });
      renderStats(a.allStats);
      renderNavigatorPanel();
      updateDiagramWindow();
      renderTrend();
    });
    els.trendModeGroup.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        GZ.state.data.trendMode = btn.dataset.mode;
        renderTrend();
      });
    });
  }

  /* ---------------- Navigator + Auswahl ---------------- */
  function renderNavigatorPanel() {
    const a = GZ.state.data.currentAnalysis;
    GZ.views.navigator.render(els.navigator, a.allStats, GZ.state.data.selectedIdx, GZ.state.anomalyCtx(), selectSG);
  }

  function selectSG(idx) {
    if (!GZ.state.data.currentAnalysis) return;
    GZ.state.data.selectedIdx = idx;
    GZ.state.data.trendSelected = new Set([idx]);
    els.navigator.querySelectorAll('.nav-card').forEach(c => c.classList.toggle('active', Number(c.dataset.idx) === idx));
    els.timelineEl.querySelectorAll('.lane-track').forEach(t => t.classList.toggle('highlight', Number(t.dataset.idx) === idx));
    els.statsBody.querySelectorAll('tr').forEach(tr => tr.classList.toggle('selected-row', Number(tr.dataset.idx) === idx));
    const track = els.timelineEl.querySelector(`.lane-track[data-idx="${idx}"]`);
    if (track) track.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    syncTrendChecks();
    renderTrend();
  }

  /* ---------------- Signalzeitendiagramm ---------------- */
  function updateDiagramWindow() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const { cycleStarts } = a;
    const hasCycles = cycleStarts && cycleStarts.length >= 2;
    els.diagramControls.style.display = hasCycles ? 'flex' : 'none';
    const TU = computeGlobalTU(cycleStarts);
    const range = hasCycles ? GZ.state.computeWindowRange() : { wMin: a.tMin, wMax: a.tMax, startIdx: 0, endIdx: 0 };
    const wzActivePoints = GZ.state.data.wzActivePoints;
    const anomalyCtx = GZ.state.anomalyCtx();

    GZ.charts.timelineChart.render(els, {
      allStats: a.allStats, wMin: range.wMin, wMax: range.wMax, cycleStarts, times: a.times, splValues: a.splValues, TU,
      selectedIdx: GZ.state.data.selectedIdx,
      anomalyBandsFor: entry => computeAnomalyBands(entry.stats, cycleStarts, a.tMin, a.tMax, anomalyCtx),
      reqPointsFor: col => {
        if (!wzActivePoints || wzActivePoints.colIndex !== col.index) return [];
        const pts = wzActivePoints.times.map(t => ({ t, unresolved: false }));
        if (wzActivePoints.unresolvedTime != null) pts.push({ t: wzActivePoints.unresolvedTime, unresolved: true });
        return pts;
      },
      onGreenClick: () => {}
    });

    if (!hasCycles) return;
    const total = cycleStarts.length;
    const lastCycleShown = range.endIdx < (total - 1) ? range.endIdx : total;
    els.winLabel.textContent = GZ.state.data.window.showAll
      ? `Gesamte Aufzeichnung (${total} Umläufe erkannt)`
      : `Umlauf ${range.startIdx + 1}–${lastCycleShown} von ${total}`;
    els.btnWinPrev.disabled = GZ.state.data.window.showAll || range.startIdx <= 0;
    els.btnWinNext.disabled = GZ.state.data.window.showAll || range.startIdx >= total - 1;
    els.winSize.disabled = GZ.state.data.window.showAll;
  }

  // Springt im Signalzeitendiagramm zum Umlauf, der den Zeitpunkt t enthält
  // (aufgerufen aus Wartezeit-/Trend-Diagrammen und -Tabellen).
  function jumpTo(t) {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const cs = a.cycleStarts;
    if (cs && cs.length) {
      let idx = 0;
      for (let k = 0; k < cs.length; k++) { if (cs[k] <= t) idx = k; else break; }
      GZ.state.data.window.showAll = false;
      GZ.state.data.window.startIdx = Math.max(0, idx - Math.floor(GZ.state.data.window.count / 2));
    }
    updateDiagramWindow();
  }

  /* ---------------- Kennzahlen je Signalgruppe ---------------- */
  function statsRowHtml(col, i, gd, cycleDurations) {
    if (gd.length === 0) {
      return `<tr data-idx="${i}"><td>${esc(col.name)}</td><td colspan="7">keine Grünphase erkannt</td></tr>`;
    }
    const flagged = detectAnomalies(gd).some(Boolean);
    return `<tr class="${flagged ? 'flagged' : ''}" data-idx="${i}">
      <td>${esc(col.name)}${flagged ? ' ⚠' : ''}</td>
      <td>${gd.length}</td>
      <td>${mean(gd).toFixed(1)}s</td>
      <td>${median(gd).toFixed(1)}s</td>
      <td>${Math.min(...gd).toFixed(0)}s</td>
      <td>${Math.max(...gd).toFixed(0)}s</td>
      <td>${stdDev(gd).toFixed(1)}s</td>
      <td>${cycleDurations.length ? mean(cycleDurations).toFixed(1) + 's' : '–'}</td>
    </tr>`;
  }

  function renderStats(allStats) {
    const a = GZ.state.data.currentAnalysis;
    if (GZ.state.data.statsScope === 'spl' && a && a.splList.length > 1) {
      const { splList } = a;
      let html = '';
      splList.forEach(spl => {
        const label = spl === '(unbekannt)' ? 'Signalzeitenplan unbekannt' : `Signalzeitenplan – SPL ${esc(spl)}`;
        html += `<tr class="spl-group-row"><td colspan="8">${label}</td></tr>`;
        allStats.forEach(({ col, stats }, i) => {
          const entry = stats.bySpl.get(spl);
          html += statsRowHtml(col, i, entry ? entry.greenDurations : [], entry ? entry.cycleDurations : []);
        });
      });
      els.statsBody.innerHTML = html;
    } else {
      els.statsBody.innerHTML = allStats.map(({ col, stats }, i) => statsRowHtml(col, i, stats.greenDurations, stats.cycleDurations)).join('');
    }
    els.statsBody.querySelectorAll('tr[data-idx]').forEach(tr => {
      tr.addEventListener('click', () => selectSG(Number(tr.dataset.idx)));
    });
  }

  // Dunkel-/Abschaltzeiträume je Signalgruppe. Hintergrund (VwV-StVO zu § 37
  // Abs. 2): Lichtzeichenanlagen sollen i. d. R. auch nachts in Betrieb
  // bleiben; ein Abschalten ist nur nach Einzelfallprüfung zu verantworten.
  function renderDunkelPanel(allStats) {
    const rows = allStats.map(({ col, segs }) => {
      const dunkelSegs = segs.filter(s => s.cat === 'DUNKEL');
      const total = dunkelSegs.reduce((a, s) => a + (s.end - s.start), 0) / 1000;
      const longest = dunkelSegs.reduce((max, s) => Math.max(max, (s.end - s.start) / 1000), 0);
      return { col, n: dunkelSegs.length, total, longest };
    }).filter(r => r.n > 0);

    if (rows.length === 0) { els.dunkelPanel.style.display = 'none'; return; }
    els.dunkelPanel.style.display = 'block';
    els.dunkelBody.innerHTML = rows.map(r => `<tr>
        <td>${esc(r.col.name)}</td><td>${fmtDauer(r.total)}</td><td>${r.n}</td><td>${fmtDauer(r.longest)}</td>
      </tr>`).join('');
    els.dunkelHint.textContent = 'Erkannte Zeiträume ohne Signalbild (Kategorie „Dunkel“) je Signalgruppe – z. B. Nachtabschaltung oder Programmwechsel. Ein Abschalten von Lichtzeichenanlagen ist nach VwV-StVO zu § 37 Abs. 2 nur nach eingehender Einzelfallprüfung zu verantworten.';
  }

  /* ---------------- Grünzeit-Trend ---------------- */
  function populateTrendControls() {
    const a = GZ.state.data.currentAnalysis;
    els.trendSgChecks.innerHTML = a.allStats.map(({ col, stats }, i) => {
      const disabled = stats.greenDurations.length === 0;
      return `<label class="trend-sg-check${disabled ? ' disabled' : ''}" title="${disabled ? 'Keine Grünphasen erkannt' : ''}">
        <input type="checkbox" value="${i}" ${GZ.state.data.trendSelected.has(i) ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
        ${esc(col.name)}
      </label>`;
    }).join('');
    els.trendSgChecks.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.onchange = () => {
        const i = Number(cb.value);
        const sel = GZ.state.data.trendSelected;
        if (cb.checked) sel.add(i);
        else if (sel.size <= 1) { cb.checked = true; return; }
        else sel.delete(i);
        renderTrend();
      };
    });
  }

  function syncTrendChecks() {
    els.trendSgChecks.querySelectorAll('input[type=checkbox]').forEach(cb => {
      cb.checked = GZ.state.data.trendSelected.has(Number(cb.value));
    });
  }

  function trendPointStats(stats) {
    const gd = stats.greenDurations;
    const med = median(gd);
    const madVal = median(gd.map(v => Math.abs(v - med))) || 0.001;
    return { med, madVal, threshHi: med + 3 * 1.4826 * madVal, threshLo: Math.max(0, med - 3 * 1.4826 * madVal) };
  }

  function renderTrendBlock(col, stats, chartBox, axisEl, histBox, histAxisEl, captionEl) {
    const a = GZ.state.data.currentAnalysis;
    const gd = stats.greenDurations, greens = stats.greens;
    const mode = GZ.state.data.trendMode;
    chartBox.style.display = mode === 'scatter' ? '' : 'none';
    axisEl.style.display = mode === 'scatter' ? '' : 'none';
    histBox.style.display = mode === 'hist' ? '' : 'none';
    histAxisEl.style.display = mode === 'hist' ? '' : 'none';

    if (gd.length === 0) {
      captionEl.textContent = 'Keine Grünphasen für diese Signalgruppe erkannt.';
      return;
    }
    const anomalyCtx = GZ.state.anomalyCtx();
    const anomalies = getFlaggedAnomalies(stats, anomalyCtx);
    const { med, threshHi, threshLo } = trendPointStats(stats);
    const useSplScope = GZ.state.data.statsScope === 'spl' && a.splList.length > 1;
    const splWindows = useSplScope ? computeTrendSplWindows(stats, { times: a.times, splValues: a.splValues, tMin: a.tMin, tMax: a.tMax }) : null;
    const splTransitions = computeSplTransitions(a.times, a.splValues).filter(tr => tr.t >= a.tMin && tr.t <= a.tMax);

    GZ.charts.trendChart.renderScatter(chartBox, axisEl.querySelector('svg'), {
      tMin: a.tMin, tMax: a.tMax, greens, gd, med, threshHi, threshLo, splWindows, splTransitions,
      onPointClick: jumpTo
    });
    GZ.charts.trendChart.renderCdf(histBox, histAxisEl.querySelector('svg'), { gd, threshHi, threshLo });

    const flaggedIdx = anomalies.map((f, i) => f ? i + 1 : null).filter(x => x !== null);
    const scopeNote = useSplScope ? ' je Signalzeitenplan' : '';
    captionEl.innerHTML = flaggedIdx.length
      ? `<b>${flaggedIdx.length} auffällige${flaggedIdx.length > 1 ? '' : 'r'} Zyklus/Zyklen: Nr. ${flaggedIdx.join(', ')}</b> — Grünzeit weicht${scopeNote} deutlich vom Median ab.`
      : `Keine auffälligen Zyklen${scopeNote} — n=${gd.length}.`;
  }

  function renderTrend() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const idxs = [...GZ.state.data.trendSelected];
    els.trendModeGroup.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === GZ.state.data.trendMode));

    if (idxs.length === 1) {
      els.trendStackContainer.style.display = 'none';
      els.trendStackContainer.innerHTML = '';
      els.trendChartBox.style.display = '';
      els.trendAxis.style.display = '';
      els.trendHistBox.style.display = '';
      els.trendHistAxis.style.display = '';
      els.trendCaption.style.display = '';
      const { col, stats } = a.allStats[idxs[0]];
      els.trendTarget.textContent = col.name;
      renderTrendBlock(col, stats, els.trendChartBox, els.trendAxis, els.trendHistBox, els.trendHistAxis, els.trendCaption);
      return;
    }

    els.trendTarget.textContent = `${idxs.length} Signalgruppen`;
    els.trendChartBox.style.display = 'none';
    els.trendAxis.style.display = 'none';
    els.trendHistBox.style.display = 'none';
    els.trendHistAxis.style.display = 'none';
    els.trendCaption.style.display = 'none';
    els.trendStackContainer.style.display = '';
    els.trendStackContainer.innerHTML = idxs.map(i => {
      const { col } = a.allStats[i];
      const desc = (col.beschreibung && col.beschreibung !== col.name) ? ` <span class="trend-sub-desc">${esc(col.beschreibung)}</span>` : '';
      return `<div class="trend-sub" data-idx="${i}">
        <div class="trend-sub-head">${esc(col.name)}${desc}</div>
        <div class="chart-box" data-role="scatter"><svg></svg><div class="chart-tooltip"></div></div>
        <div class="axis" data-role="scatter-axis"><svg></svg></div>
        <div class="chart-box hoverable" data-role="hist"><svg></svg><div class="chart-tooltip"></div></div>
        <div class="axis" data-role="hist-axis"><svg></svg></div>
        <div class="chart-caption" data-role="caption"></div>
      </div>`;
    }).join('');
    els.trendStackContainer.querySelectorAll('.trend-sub').forEach(block => {
      const idx = Number(block.dataset.idx);
      const { col, stats } = a.allStats[idx];
      renderTrendBlock(
        col, stats,
        block.querySelector('[data-role="scatter"]'), block.querySelector('[data-role="scatter-axis"]'),
        block.querySelector('[data-role="hist"]'), block.querySelector('[data-role="hist-axis"]'),
        block.querySelector('[data-role="caption"]')
      );
    });
  }

  /* ---------------- CSV-Export ---------------- */
  function statsCSVRow(name, gd, cycleDurations) {
    if (gd.length === 0) return [name, 0, '', '', '', '', '', ''];
    return [name, gd.length, mean(gd).toFixed(1), median(gd).toFixed(1), Math.min(...gd).toFixed(0), Math.max(...gd).toFixed(0), stdDev(gd).toFixed(1), cycleDurations.length ? mean(cycleDurations).toFixed(1) : ''];
  }
  function exportStatsCSV() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const rows = [['Signalgruppe', 'Zyklen', 'Ø Grün (s)', 'Median (s)', 'Min (s)', 'Max (s)', 'Sigma (s)', 'Ø Umlauf (s)']];
    if (GZ.state.data.statsScope === 'spl' && a.splList.length > 1) {
      rows[0] = ['Signalzeitenplan', ...rows[0]];
      a.splList.forEach(spl => {
        const splLabel = spl === '(unbekannt)' ? 'unbekannt' : spl;
        a.allStats.forEach(({ col, stats }) => {
          const entry = stats.bySpl.get(spl);
          rows.push([splLabel, ...statsCSVRow(col.name, entry ? entry.greenDurations : [], entry ? entry.cycleDurations : [])]);
        });
      });
    } else {
      a.allStats.forEach(({ col, stats }) => rows.push(statsCSVRow(col.name, stats.greenDurations, stats.cycleDurations)));
    }
    const csv = rows.map(r => r.join(';')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'gruenzeitanalyse_kennzahlen.csv';
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /* ---------------- Einstiegspunkt nach Analyse ---------------- */
  function onAnalyzeComplete() {
    const a = GZ.state.data.currentAnalysis;
    GZ.state.data.statsScope = 'total';
    const splBtn = els.statsScopeGroup.querySelector('button[data-scope="spl"]');
    if (splBtn) splBtn.disabled = a.splList.length < 2;
    els.statsScopeGroup.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.scope === 'total'));

    GZ.state.data.selectedIdx = GZ.state.pickDefaultSG(a.allStats);
    GZ.state.data.window.startIdx = 0;
    GZ.state.data.window.showAll = false;
    GZ.state.data.wzActivePoints = null;
    const winSizeVal = parseInt(els.winSize.value, 10);
    GZ.state.data.window.count = Number.isFinite(winSizeVal) && winSizeVal > 0 ? winSizeVal : 5;

    renderNavigatorPanel();
    updateDiagramWindow();
    renderStats(a.allStats);
    renderDunkelPanel(a.allStats);
    GZ.state.data.trendSelected = new Set([GZ.state.data.selectedIdx]);
    populateTrendControls();
    selectSG(GZ.state.data.selectedIdx);
  }

  // Vom Wartezeit-Tab aufgerufen: Anforderungspunkte im Diagramm auffrischen.
  function refreshReqPoints() { updateDiagramWindow(); }

  GZ.views = GZ.views || {};
  GZ.views.gruenzeitanalyse = { init, onAnalyzeComplete, refresh: updateDiagramWindow, refreshReqPoints, jumpTo, exportStatsCSV, selectSG };
})(window.GZ = window.GZ || {});
