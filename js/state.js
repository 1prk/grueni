/* GZ.state — zentraler Anwendungszustand einer Analyse. Reine Datenhaltung
   + kleine Ableitungsfunktionen; das Rendering liegt in js/views/*. */
(function (GZ) {
  'use strict';

  const state = {
    currentAnalysis: null, // {allStats, tMin, tMax, cycleStarts, otherColumns, times, seriesByCol, splValues, tcValues, splList}
    selectedIdx: 0,
    statsScope: 'total', // 'total' = ganzer Mitschnitt, 'spl' = je Signalzeitenplan
    trendMode: 'scatter', // 'scatter' | 'hist'
    trendSelected: new Set(), // Signalgruppen-Indizes im Grünzeit-Trend
    wzActivePoints: null, // {colIndex, times[], unresolvedTime} - für Anforderungspunkte im Zeitdiagramm
    window: { count: 5, startIdx: 0, showAll: false }
  };

  function anomalyCtx() {
    const a = state.currentAnalysis;
    return { scope: state.statsScope, splList: a ? a.splList : [], times: a ? a.times : null, splValues: a ? a.splValues : null };
  }

  function computeWindowRange() {
    const { cycleStarts, tMin, tMax } = state.currentAnalysis;
    const w = state.window;
    if (w.showAll || !cycleStarts || cycleStarts.length < 2) {
      return { wMin: tMin, wMax: tMax, startIdx: 0, endIdx: cycleStarts ? cycleStarts.length - 1 : 0 };
    }
    const maxStart = cycleStarts.length - 1;
    const startIdx = Math.max(0, Math.min(w.startIdx, maxStart));
    const endIdx = Math.min(startIdx + w.count, maxStart);
    const wMin = cycleStarts[startIdx];
    const wMax = endIdx < maxStart ? cycleStarts[endIdx] : tMax;
    return { wMin, wMax, startIdx, endIdx };
  }

  function pickDefaultSG(allStats) {
    let best = 0, bestScore = -1;
    allStats.forEach((s, i) => {
      const score = GZ.stats.detectAnomalies(s.stats.greenDurations).filter(Boolean).length;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    return best;
  }

  GZ.state = { data: state, anomalyCtx, computeWindowRange, pickDefaultSG };
})(window.GZ = window.GZ || {});
