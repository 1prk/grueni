/* GZ.state — central application state of one analysis. Plain data plus
   small derived functions; rendering lives in js/views/*. */
(function (GZ) {
  'use strict';

  const state = {
    currentAnalysis: null, // {allStats, tMin, tMax, cycleStarts, otherColumns, times, seriesByCol, splValues, tcValues, splList}
    // 'total' = whole recording, 'spl' = per signal plan. Set by the green time tab,
    // read by the cycle check (see anomalyCtx).
    statsScope: 'total',
    phases: [], // {id, name, kuerzel, members:Set<colIndex>} - see tab "Stammdaten LSA"
    // Manual corrections of a phase transition detail table (see
    // js/views/umlaufpruefung.js), per phase TRANSITION TYPE (not per
    // occurrence) - key "<fromPhase.id>→<toPhase.id>", value
    // {rows:[{sgIndex, an, ab}]} (an/ab in seconds relative to the transition's own TX=0).
    // Replaces the automatically detected row list for EVERY occurrence of this transition.
    pueOverrides: {},
    umlaufSpalten: [], // {id, label, expr} - formula columns, see tab "Umlaufstatistiken"
    detectors: null,   // {list, cache} - detector assignment, see GZ.detectors
    topology: GZ.topology.create(), // intersection topology, see GZ.topology and the sub-tab "Topologie"
    log: null          // log markers, see GZ.logs
  };

  function anomalyCtx() {
    const a = state.currentAnalysis;
    return { scope: state.statsScope, splList: a ? a.splList : [], times: a ? a.times : null, splValues: a ? a.splValues : null };
  }

  GZ.state = { data: state, anomalyCtx };
})(window.GZ = window.GZ || {});
