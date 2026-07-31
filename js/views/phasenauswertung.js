/* GZ.views.phasenauswertung — Tab "Phasenauswertung": zeigt für jede im Tab
   "Stammdaten LSA" definierte Phase, wann und wie oft sie in der Aufzeichnung
   vollständig angezeigt wurde (alle Mitglieds-Signalgruppen gleichzeitig
   Grün) - im selben Aufbau wie die Grünzeitanalyse (Zeitdiagramm, Kennzahlen-
   Tabelle, Trend je Erscheinen), durch Wiederverwendung derselben Chart-
   Komponenten auf einer aus den Phasen abgeleiteten, kompatiblen Datenstruktur
   (siehe GZ.phases.buildPhaseAnalysisEntry). */
(function (GZ) {
  'use strict';
  const { esc, fmtDauer } = GZ.format;
  const { mean, median, detectAnomalies } = GZ.stats;
  const { computeGlobalTU, computeSplTransitions, computeAnomalyBands } = GZ.segments;
  const { buildPhaseAnalysisEntry } = GZ.phases;

  let els = null;
  let win = { count: 5, startIdx: 0, showAll: false };
  let trendMode = 'scatter';
  let selectedPhaseId = null;

  function init(root) {
    els = {
      root,
      emptyHint: root.querySelector('#paEmptyHint'),
      content: root.querySelector('#paContent'),
      diagramControls: root.querySelector('#paDiagramControls'),
      btnWinPrev: root.querySelector('#paBtnWinPrev'),
      winLabel: root.querySelector('#paWinLabel'),
      btnWinNext: root.querySelector('#paBtnWinNext'),
      winSize: root.querySelector('#paWinSize'),
      btnWinAll: root.querySelector('#paBtnWinAll'),
      timelineEl: root.querySelector('#paTimeline'),
      splBarSvgEl: root.querySelector('#paSplBar svg'),
      axisSvgEl: root.querySelector('#paAxis svg'),
      statsBody: root.querySelector('#paStatsBody'),
      trendTarget: root.querySelector('#paTrendTarget'),
      trendSelect: root.querySelector('#paTrendSelect'),
      trendModeGroup: root.querySelector('#paTrendModeGroup'),
      trendChartBox: root.querySelector('#paTrendChartBox'),
      trendAxis: root.querySelector('#paTrendAxis'),
      trendHistBox: root.querySelector('#paTrendHistBox'),
      trendHistAxis: root.querySelector('#paTrendHistAxis'),
      trendCaption: root.querySelector('#paTrendCaption')
    };

    els.btnWinPrev.addEventListener('click', () => { if (!win.showAll) { win.startIdx = Math.max(0, win.startIdx - 1); refresh(); } });
    els.btnWinNext.addEventListener('click', () => {
      const a = GZ.state.data.currentAnalysis;
      if (win.showAll || !a || !a.cycleStarts) return;
      win.startIdx = Math.min(a.cycleStarts.length - 1, win.startIdx + 1);
      refresh();
    });
    els.winSize.addEventListener('change', () => {
      const v = parseInt(els.winSize.value, 10);
      win.count = Number.isFinite(v) && v > 0 ? v : 5;
      els.winSize.value = win.count;
      refresh();
    });
    els.btnWinAll.addEventListener('click', () => {
      win.showAll = !win.showAll;
      els.btnWinAll.textContent = win.showAll ? 'Fenster anzeigen' : 'Alle anzeigen';
      els.btnWinAll.classList.toggle('primary', win.showAll);
      refresh();
    });
    els.trendModeGroup.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => { trendMode = btn.dataset.mode; renderTrend(currentPhaseAllStats()); });
    });
    els.trendSelect.addEventListener('change', () => {
      selectedPhaseId = els.trendSelect.value;
      renderTrend(currentPhaseAllStats());
    });
  }

  function onAnalyzeComplete() {
    win = { count: 5, startIdx: 0, showAll: false };
    selectedPhaseId = null;
    refresh();
  }

  function currentPhaseAllStats() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return [];
    return GZ.state.data.phases.map(p => buildPhaseAnalysisEntry(p, a.allStats, a.tMin, a.tMax));
  }

  function computeWindowRange(a) {
    const { cycleStarts, tMin, tMax } = a;
    if (win.showAll || !cycleStarts || cycleStarts.length < 2) {
      return { wMin: tMin, wMax: tMax, startIdx: 0, endIdx: cycleStarts ? cycleStarts.length - 1 : 0 };
    }
    const maxStart = cycleStarts.length - 1;
    const startIdx = Math.max(0, Math.min(win.startIdx, maxStart));
    const endIdx = Math.min(startIdx + win.count, maxStart);
    const wMin = cycleStarts[startIdx];
    const wMax = endIdx < maxStart ? cycleStarts[endIdx] : tMax;
    return { wMin, wMax, startIdx, endIdx };
  }

  function refresh() {
    const a = GZ.state.data.currentAnalysis;
    const phases = a ? GZ.state.data.phases : [];
    if (!a || phases.length === 0) {
      els.emptyHint.style.display = '';
      els.content.style.display = 'none';
      return;
    }
    els.emptyHint.style.display = 'none';
    els.content.style.display = '';

    const phaseAllStats = currentPhaseAllStats();
    const { cycleStarts, tMin, tMax, times, splValues } = a;
    const hasCycles = cycleStarts && cycleStarts.length >= 2;
    const TU = computeGlobalTU(cycleStarts);
    const range = hasCycles ? computeWindowRange(a) : { wMin: tMin, wMax: tMax, startIdx: 0, endIdx: 0 };

    els.diagramControls.style.display = hasCycles ? 'flex' : 'none';
    GZ.charts.timelineChart.render(els, {
      allStats: phaseAllStats, wMin: range.wMin, wMax: range.wMax, cycleStarts, times, splValues, TU,
      selectedIdx: -1,
      anomalyBandsFor: entry => computeAnomalyBands(entry.stats, cycleStarts, tMin, tMax, { scope: 'total' }),
      reqPointsFor: () => [],
      onGreenClick: () => {}
    });
    if (hasCycles) {
      const total = cycleStarts.length;
      const lastShown = range.endIdx < (total - 1) ? range.endIdx : total;
      els.winLabel.textContent = win.showAll ? `Gesamte Aufzeichnung (${total} Umläufe erkannt)` : `Umlauf ${range.startIdx + 1}–${lastShown} von ${total}`;
      els.btnWinPrev.disabled = win.showAll || range.startIdx <= 0;
      els.btnWinNext.disabled = win.showAll || range.startIdx >= total - 1;
      els.winSize.disabled = win.showAll;
    }

    renderStats(phaseAllStats);

    if (!selectedPhaseId || !phaseAllStats.some(e => e.phase.id === selectedPhaseId)) {
      selectedPhaseId = phaseAllStats.length ? phaseAllStats[0].phase.id : null;
    }
    els.trendSelect.innerHTML = phaseAllStats.map(e =>
      `<option value="${e.phase.id}" ${e.phase.id === selectedPhaseId ? 'selected' : ''}>${esc(e.phase.kuerzel)}${e.phase.name && e.phase.name !== e.phase.kuerzel ? ' – ' + esc(e.phase.name) : ''}</option>`
    ).join('');
    renderTrend(phaseAllStats);
  }

  function statsRowHtml(entry) {
    const gd = entry.stats.greenDurations;
    const label = entry.phase.name && entry.phase.name !== entry.phase.kuerzel ? `${entry.phase.kuerzel} – ${entry.phase.name}` : entry.phase.kuerzel;
    if (gd.length === 0) {
      const reason = entry.phase.members.size === 0 ? 'keine Signalgruppe zugeordnet' : 'in dieser Aufzeichnung nicht gemeinsam Grün erkannt';
      return `<tr data-phase="${entry.phase.id}"><td>${esc(label)}</td><td colspan="6" style="text-align:left; font-family:var(--sans); color:var(--text-faint); font-style:italic;">${reason}</td></tr>`;
    }
    const flagged = detectAnomalies(gd).some(Boolean);
    const sum = gd.reduce((x, y) => x + y, 0);
    return `<tr class="${flagged ? 'flagged' : ''}" data-phase="${entry.phase.id}">
      <td>${esc(label)}${flagged ? ' ⚠' : ''}</td>
      <td>${gd.length}</td>
      <td>${mean(gd).toFixed(1)}s</td>
      <td>${median(gd).toFixed(1)}s</td>
      <td>${Math.min(...gd).toFixed(0)}s</td>
      <td>${Math.max(...gd).toFixed(0)}s</td>
      <td>${fmtDauer(sum)}</td>
    </tr>`;
  }

  function renderStats(phaseAllStats) {
    els.statsBody.innerHTML = phaseAllStats.map(statsRowHtml).join('');
    els.statsBody.querySelectorAll('tr[data-phase]').forEach(tr => {
      tr.addEventListener('click', () => {
        selectedPhaseId = tr.dataset.phase;
        els.trendSelect.value = selectedPhaseId;
        renderTrend(currentPhaseAllStats());
      });
    });
  }

  function renderTrend(phaseAllStats) {
    els.trendModeGroup.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === trendMode));
    const entry = phaseAllStats.find(e => e.phase.id === selectedPhaseId);
    if (!entry) {
      els.trendTarget.textContent = '';
      els.trendCaption.textContent = 'Keine Phase ausgewählt.';
      return;
    }
    els.trendTarget.textContent = entry.phase.kuerzel;
    const a = GZ.state.data.currentAnalysis;
    const gd = entry.stats.greenDurations, greens = entry.stats.greens;

    els.trendChartBox.style.display = trendMode === 'scatter' ? '' : 'none';
    els.trendAxis.style.display = trendMode === 'scatter' ? '' : 'none';
    els.trendHistBox.style.display = trendMode === 'hist' ? '' : 'none';
    els.trendHistAxis.style.display = trendMode === 'hist' ? '' : 'none';

    if (gd.length === 0) {
      els.trendCaption.textContent = entry.phase.members.size === 0
        ? 'Dieser Phase sind noch keine Signalgruppen zugeordnet (siehe Tab „Stammdaten LSA“).'
        : 'Diese Phase wurde in der Aufzeichnung nicht erkannt (die zugeordneten Signalgruppen hatten nie gleichzeitig Grün).';
      return;
    }

    const anomalies = detectAnomalies(gd);
    const med = median(gd);
    const madVal = median(gd.map(v => Math.abs(v - med))) || 0.001;
    const threshHi = med + 3 * 1.4826 * madVal;
    const threshLo = Math.max(0, med - 3 * 1.4826 * madVal);
    const splTransitions = computeSplTransitions(a.times, a.splValues).filter(tr => tr.t >= a.tMin && tr.t <= a.tMax);

    GZ.charts.trendChart.renderScatter(els.trendChartBox, els.trendAxis.querySelector('svg'), {
      tMin: a.tMin, tMax: a.tMax, greens, gd, med, threshHi, threshLo, splWindows: null, splTransitions,
      onPointClick: GZ.app.jumpToGruenzeit
    });
    GZ.charts.trendChart.renderCdf(els.trendHistBox, els.trendHistAxis.querySelector('svg'), { gd, threshHi, threshLo });

    const flaggedIdx = anomalies.map((f, i) => f ? i + 1 : null).filter(x => x !== null);
    els.trendCaption.innerHTML = flaggedIdx.length
      ? `<b>${flaggedIdx.length} auffällige${flaggedIdx.length > 1 ? '' : 's'} Erscheinen: Nr. ${flaggedIdx.join(', ')}</b> — Dauer weicht deutlich vom Median ab.`
      : `Keine auffälligen Erscheinen — n=${gd.length}.`;
  }

  GZ.views = GZ.views || {};
  GZ.views.phasenauswertung = { init, onAnalyzeComplete, refresh };
})(window.GZ = window.GZ || {});
