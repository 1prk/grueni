/* GZ.umlaufContext — baut für Umlaufstatistiken je Umlauf den Auswertungs-
   scope für GZ.exprEngine.compileValue(): SG-/DET-Objekt-Handles im selben
   Grundformat wie js/views/formulaBuilder.js (class + cycleMetrics, siehe
   dort und exprEngine.js), aber OHNE zeilenweisen Sweep - Umlaufstatistiken
   braucht nur EINEN Wert je Umlauf, nicht je Zeile. Anders als der Formel-
   Builder (Variablen mit frei wählbarem Alias) werden hier die OCIT-Spalten-
   namen selbst direkt als Bezeichner nutzbar gemacht - kein separater
   "Variable anlegen"-Schritt. */
(function (GZ) {
  'use strict';
  const { computeGlobalTU, computeCycleSgMetrics, computeCycleDetMetrics, findSplAt, makeRawValueSampler } = GZ.segments;
  const { wzIstBelegt } = GZ.wartezeitLogic;

  // Statischer Bezeichner-Index (Namen + Typen) - Grundlage für varTypes je
  // compileValue()-Aufruf UND für die Vorschlagsliste in umlaufstatistiken.js.
  function buildIdentifierIndex(analysis) {
    const { allStats, otherColumns } = analysis;
    const sg = new Map(), det = new Map();
    const sgList = [], detList = [];
    allStats.forEach(({ col }) => {
      const l = col.name.toLowerCase();
      if (!sg.has(l)) { sg.set(l, col.name); sgList.push(col.name); }
    });
    otherColumns.forEach(col => {
      const l = col.name.toLowerCase();
      if (!det.has(l)) { det.set(l, col.name); detList.push(col.name); }
    });
    const varTypes = { TU: 'NUM', TU_MED: 'NUM', SPL: 'TEXT' };
    sgList.forEach(n => { varTypes[n] = 'SG'; });
    detList.forEach(n => { varTypes[n] = 'DET'; });
    return { sg, det, sgList, detList, varTypes };
  }

  // Baut den Kontext für JEDEN Umlauf der Aufzeichnung auf einmal - die
  // teure Sweep-Arbeit (GZ.segments.computeCycleSgMetrics/-DetMetrics) läuft
  // einmal über die Aufzeichnung, danach ist das Auswerten einer Formel je
  // Umlauf nur noch ein Baum-Durchlauf über wenige Knoten (compiled.run()).
  function buildAll(analysis) {
    const index = buildIdentifierIndex(analysis);
    const { allStats, otherColumns, cycleStarts, tMax, times, seriesByCol, splValues } = analysis;
    if (!cycleStarts || cycleStarts.length === 0) return { index, cycles: [] };

    const TU_MED = computeGlobalTU(cycleStarts);
    const n = cycleStarts.length;

    const sgMetricsByName = new Map();
    allStats.forEach(({ col, segs, stats }) => {
      sgMetricsByName.set(col.name, computeCycleSgMetrics(segs, stats.greens, cycleStarts, tMax, TU_MED));
    });
    const detMetricsByName = new Map();
    const rawSamplerByName = new Map();
    otherColumns.forEach(col => {
      const rawVals = seriesByCol.get(col.index);
      const occupied = times.map((_, k) => wzIstBelegt(rawVals[k]));
      detMetricsByName.set(col.name, computeCycleDetMetrics(times, occupied, cycleStarts, tMax));
      rawSamplerByName.set(col.name, makeRawValueSampler(times, rawVals));
    });

    const cycles = [];
    for (let i = 0; i < n; i++) {
      const start = cycleStarts[i];
      const end = i + 1 < n ? cycleStarts[i + 1] : tMax;
      const spl = findSplAt(start, times, splValues) || '';
      const tu = Math.round((end - start) / 1000);

      // __cycleStart: kein regulärer, per varTypes deklarierter Bezeichner
      // (Nutzer können ihn nicht referenzieren) - nur intern von der
      // WertBei()-Primitive gelesen (siehe exprEngine.js), um deren
      // Sekunden-Zeitpunkt in einen absoluten Zeitstempel für
      // handle.rawSample() umzurechnen.
      const scope = { TU: tu, TU_MED: TU_MED == null ? NaN : TU_MED, SPL: spl, __cycleStart: start };
      index.sgList.forEach(name => {
        scope[name] = { class: 'SG', cycleMetrics: sgMetricsByName.get(name)[i] || null };
      });
      index.detList.forEach(name => {
        scope[name] = { class: 'DET', cycleMetrics: detMetricsByName.get(name)[i] || null, rawSample: rawSamplerByName.get(name) };
      });

      cycles.push({ scope, start, end, TX: i + 1, SPL: spl, TU: tu });
    }

    return { index, cycles };
  }

  GZ.umlaufContext = { buildIdentifierIndex, buildAll };
})(window.GZ = window.GZ || {});
