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
    oepnvActivePoints: [], // [{colIndex, times[], unresolvedTime}] - Anmeldepunkte je konfigurierter Signalgruppe im ÖPNV-Tab
    window: { count: 5, startIdx: 0, showAll: false },
    phases: [], // {id, name, kuerzel, members:Set<colIndex>} - siehe Tab „Stammdaten LSA“
    // Manuelle Korrekturen einer Phasenübergang-Detailtabelle (siehe
    // js/views/umlaufpruefung.js PÜ-Werkzeug), je PHASENÜBERGANGSTYP (nicht
    // je Vorkommen) - Schlüssel "<fromPhase.id>→<toPhase.id>", Wert
    // {rows:[{sgIndex, an, ab}]} (an/ab in Sekunden relativ zum PÜ-eigenen
    // TX=0, siehe dort). Ersetzt bei Vorhandensein die automatisch erkannte
    // Zeilenliste vollständig für JEDES Vorkommen dieses Übergangs.
    pueOverrides: {},
    umlaufSpalten: [] // {id, label, expr} - Formelspalten, siehe Tab „Umlaufstatistiken“
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
