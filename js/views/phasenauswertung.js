/* GZ.views.phasenauswertung — Tab "Phasenauswertung": zeigt für jede im Tab
   "Stammdaten LSA" definierte Phase, wann und wie oft sie in der Aufzeichnung
   vollständig angezeigt wurde (alle Mitglieds-Signalgruppen gleichzeitig
   Grün). Da Phasen per Definition nie gleichzeitig aktiv sind (Zwischenzeiten
   trennen sie), werden alle Phasen in EINER gemeinsamen Spur mit je eigener
   Farbe dargestellt statt einer Spur je Phase. */
(function (GZ) {
  'use strict';
  const { esc, fmtDauer, fmtTimeShort } = GZ.format;
  const { mean, median } = GZ.stats;
  const { computeSplTransitions } = GZ.segments;
  const { computePhaseOccurrences, buildCombinedSegments, durationPerCycle, colorForIndex } = GZ.phases;
  const { renderLane, renderTimeAxis } = GZ.charts.timelineLane;
  const NONE_COLOR = '#c2ccd6';
  const NONE_LABEL = 'Keine Phase aktiv';

  let els = null;
  let win = { count: 5, startIdx: 0, showAll: false };

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
      legend: root.querySelector('#paLegend'),
      splBarSvg: root.querySelector('#paSplBar svg'),
      laneSvg: root.querySelector('#paLaneTrack svg'),
      axisSvg: root.querySelector('#paAxis svg'),
      statsBody: root.querySelector('#paStatsBody'),
      durChartBox: root.querySelector('#paDurChartBox'),
      durAxis: root.querySelector('#paDurAxis')
    };

    els.btnWinPrev.addEventListener('click', () => { if (!win.showAll) { win.startIdx = Math.max(0, win.startIdx - win.count); refresh(); } });
    els.btnWinNext.addEventListener('click', () => {
      const a = GZ.state.data.currentAnalysis;
      if (win.showAll || !a || !a.cycleStarts) return;
      win.startIdx = Math.min(Math.max(0, a.cycleStarts.length - 1), win.startIdx + win.count);
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
  }

  function onAnalyzeComplete() {
    win = { count: 5, startIdx: 0, showAll: false };
    refresh();
  }

  function windowRange(n) {
    if (win.showAll || n <= 0) return { from: 0, to: n };
    const from = Math.max(0, Math.min(win.startIdx, Math.max(0, n - 1)));
    return { from, to: Math.min(from + win.count, n) };
  }

  function coloredPhases() {
    return GZ.state.data.phases.map((phase, i) => ({ phase, color: colorForIndex(i) }));
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

    const { cycleStarts, tMin, tMax, times, splValues } = a;
    const hasCycles = cycleStarts && cycleStarts.length >= 2;
    const n = hasCycles ? cycleStarts.length : 0;
    const { from, to } = windowRange(n);
    const wMin = hasCycles ? cycleStarts[from] : tMin;
    const wMax = hasCycles ? (to < n ? cycleStarts[to] : tMax) : tMax;

    const cp = coloredPhases();
    const occEntries = cp.map(({ phase, color }) => ({ ...computePhaseOccurrences(phase, a.allStats), color }));
    const colorByPhaseId = new Map(occEntries.map(e => [e.phase.id, e.color]));
    const labelByPhaseId = new Map(occEntries.map(e => [e.phase.id, e.phase.name && e.phase.name !== e.phase.kuerzel ? `${e.phase.kuerzel} – ${e.phase.name}` : e.phase.kuerzel]));

    renderLegend(occEntries);

    els.diagramControls.style.display = hasCycles ? 'flex' : 'none';
    GZ.charts.timelineChart.renderSplBar(els.splBarSvg, wMin, wMax, times, splValues);

    const combinedSegs = buildCombinedSegments(occEntries, tMin, tMax);
    renderLane(els.laneSvg, {
      wMin, wMax, segs: combinedSegs,
      baselineCat: '__none_baseline__', baselineHeight: 0,
      cycleMarks: cycleStarts || [],
      splMarks: (times && splValues) ? computeSplTransitions(times, splValues) : [],
      fillFor: seg => seg.cat === 'NONE' ? NONE_COLOR : colorByPhaseId.get(seg.cat),
      segTitle: seg => {
        const durS = Math.round((seg.end - seg.start) / 1000);
        const label = seg.cat === 'NONE' ? NONE_LABEL : labelByPhaseId.get(seg.cat);
        return `${label}: ${fmtTimeShort(seg.start)}–${fmtTimeShort(seg.end)} (${durS}s)`;
      }
    });
    renderTimeAxis(els.axisSvg, wMin, wMax);

    if (hasCycles) {
      const lastShown = to < n ? to : n;
      els.winLabel.textContent = win.showAll ? `Gesamte Aufzeichnung (${n} Umläufe erkannt)` : `Umlauf ${from + 1}–${lastShown} von ${n}`;
      els.btnWinPrev.disabled = win.showAll || from <= 0;
      els.btnWinNext.disabled = win.showAll || to >= n;
      els.winSize.disabled = win.showAll;
    }

    renderStats(occEntries);
    renderDurationChart(occEntries, cycleStarts, tMax, from, to);
  }

  function renderLegend(occEntries) {
    const items = occEntries.map(e =>
      `<span class="item"><span class="swatch" style="background:${e.color}"></span>${esc(e.phase.kuerzel)}${e.phase.name && e.phase.name !== e.phase.kuerzel ? ' – ' + esc(e.phase.name) : ''}</span>`
    ).join('');
    els.legend.innerHTML = items +
      `<span class="item"><span class="swatch" style="background:${NONE_COLOR}"></span>${esc(NONE_LABEL)}</span>` +
      `<span class="item"><span style="display:inline-block;width:0;height:9px;border-left:1px dashed var(--req-marker);"></span>Signalprogrammwechsel (SPL)</span>`;
  }

  function renderStats(occEntries) {
    els.statsBody.innerHTML = occEntries.map(({ phase, intervals, color }) => {
      const label = phase.name && phase.name !== phase.kuerzel ? `${phase.kuerzel} – ${phase.name}` : phase.kuerzel;
      const dot = `<span class="phase-color-dot" style="background:${color}"></span>`;
      const gd = intervals.map(iv => (iv.end - iv.start) / 1000);
      if (gd.length === 0) {
        const reason = phase.members.size === 0 ? 'keine Signalgruppe zugeordnet' : 'in dieser Aufzeichnung nicht gemeinsam Grün erkannt';
        return `<tr><td>${dot}${esc(label)}</td><td colspan="6" style="text-align:left; font-family:var(--sans); color:var(--text-faint); font-style:italic;">${reason}</td></tr>`;
      }
      const sum = gd.reduce((x, y) => x + y, 0);
      return `<tr>
        <td>${dot}${esc(label)}</td>
        <td>${gd.length}</td>
        <td>${mean(gd).toFixed(1)}s</td>
        <td>${median(gd).toFixed(1)}s</td>
        <td>${Math.min(...gd).toFixed(0)}s</td>
        <td>${Math.max(...gd).toFixed(0)}s</td>
        <td>${fmtDauer(sum)}</td>
      </tr>`;
    }).join('');
  }

  function renderDurationChart(occEntries, cycleStarts, tMax, from, to) {
    if (!cycleStarts || cycleStarts.length < 2 || to <= from) {
      els.durChartBox.querySelector('svg').innerHTML = '';
      els.durAxis.querySelector('svg').innerHTML = '';
      return;
    }
    const umlaufNumbers = [];
    for (let i = from; i < to; i++) umlaufNumbers.push(i + 1);
    const durationsByPhase = new Map();
    occEntries.forEach(({ phase, intervals }) => {
      durationsByPhase.set(phase.id, durationPerCycle(intervals, cycleStarts, tMax, from, to));
    });
    const phasesForChart = occEntries.map(({ phase, color }) => ({
      id: phase.id, color,
      label: phase.name && phase.name !== phase.kuerzel ? `${phase.kuerzel} – ${phase.name}` : phase.kuerzel
    }));
    GZ.charts.phaseDurationChart.render(els.durChartBox, els.durAxis.querySelector('svg'), {
      umlaufNumbers, phases: phasesForChart, durationsByPhase
    });
  }

  GZ.views = GZ.views || {};
  GZ.views.phasenauswertung = { init, onAnalyzeComplete, refresh };
})(window.GZ = window.GZ || {});
