/* GZ.state holds the state of one analysis.
   The state is plain data plus a few small functions that derive values.
   The views in js/views render the state. */
(function (GZ) {
  'use strict';

  const state = {
    // {allStats, tMin, tMax, cycleStarts, otherColumns, times, seriesByCol, splValues, tcValues,
    // splList}
    currentAnalysis: null,
    // 'total' means the whole recording. 'spl' means one signal plan.
    // The green time tab sets this value. The cycle check reads it (see anomalyCtx).
    statsScope: 'total',
    phases: [], // {id, name, kuerzel, members:Set<colIndex>}. See the tab "Stammdaten LSA".
    // Manual corrections of a phase transition table. See js/views/umlaufpruefung.js.
    // A correction applies to a phase TRANSITION TYPE, not to one occurrence.
    // The key is "<fromPhase.id>→<toPhase.id>". The value is {rows:[{sgIndex, an, ab}]}.
    // The values an and ab are in seconds from the TX=0 of the transition.
    // A correction replaces the automatic row list for EVERY occurrence of this transition.
    pueOverrides: {},
    umlaufSpalten: [], // {id, label, expr}. These are formula columns. See the tab "Umlaufstatistiken".
    detectors: null,   // {list, cache}. This is the detector assignment. See GZ.detectors.
    topology: GZ.topology.create(), // The intersection topology. See GZ.topology and the sub-tab "Topologie".
    log: null          // The log markers. See GZ.logs.
  };

  function anomalyCtx() {
    const a = state.currentAnalysis;
    return { scope: state.statsScope, splList: a ? a.splList : [], times: a ? a.times : null, splValues: a ? a.splValues : null };
  }

  GZ.state = { data: state, anomalyCtx };
})(window.GZ = window.GZ || {});
