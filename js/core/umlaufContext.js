/* GZ.umlaufContext — baut je Umlauf den Auswertungskontext für
   GZ.exprEngine: SG-Werte (An/Ab/TF/Rotgelb/Gelb), Detektor-/APW-Treffer
   (ausgelöst/Anzahl/erste/letzte Flanke), SPL/TU/TU_MED/TX/Start. Reine
   Logik auf den von GZ.parser/GZ.segments gelieferten Analyse-Daten,
   sweep-basiert (ein fortlaufender Zeiger je Signalgruppe/Spalte über
   aufsteigend besuchte Umläufe) für lineare statt quadratische Laufzeit bei
   vielen Umläufen - siehe die Sweep-Kommentare in js/views/umlaufpruefung.js
   für dasselbe Muster. */
(function (GZ) {
  'use strict';
  const {
    makeIndexSweep, findSplAt, computeSegmentAnAbTf, computeGlobalTU,
    mapGreensToSegIndex, adjacentTransitionDurations
  } = GZ.segments;
  const { wzIstBelegt } = GZ.wartezeitLogic;

  // Statischer Bezeichner-Index (Signalgruppen-/Detektornamen) - unabhängig
  // vom einzelnen Umlauf. Grundlage für die Namensauflösung in
  // GZ.exprEngine.evaluate() UND für Vorschläge in suggestAt()/nearestMatch().
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
    return { sg, det, sgList, detList };
  }

  // Baut den Kontext für JEDEN Umlauf der Aufzeichnung auf einmal (nicht
  // erst bei Bedarf je Spalte) - die teure Sweep-Arbeit läuft einmal über die
  // Aufzeichnung, danach ist das Auswerten einer Formel je Umlauf nur noch
  // ein Baum-Durchlauf über wenige Knoten.
  function buildAll(analysis) {
    const index = buildIdentifierIndex(analysis);
    const { allStats, otherColumns, cycleStarts, tMax, times, seriesByCol, splValues } = analysis;
    if (!cycleStarts || cycleStarts.length === 0) return { index, cycles: [] };

    const TU_MED = computeGlobalTU(cycleStarts) || 0;
    const n = cycleStarts.length;

    const sgSweeps = allStats.map(({ col, segs, stats }) => ({
      lname: col.name.toLowerCase(),
      greenSweep: makeIndexSweep(stats.greens),
      segIndexOfGreen: mapGreensToSegIndex(segs),
      segs, greens: stats.greens
    }));

    // Je andere Spalte (DET/APW/ÖPNV/BLK): sortierte Liste der steigenden
    // Flanken (Belegt-Beginn) einmal vorab bilden; pro Umlauf genügt ein
    // monoton fortschreitender Zweizeiger-Scan über diese Liste.
    const detCols = otherColumns.map(col => {
      const vals = seriesByCol.get(col.index);
      const edges = [];
      let prevBelegt = false;
      for (let k = 0; k < times.length; k++) {
        const belegt = wzIstBelegt(vals[k]);
        if (belegt && !prevBelegt) edges.push(times[k]);
        prevBelegt = belegt;
      }
      return { lname: col.name.toLowerCase(), edges };
    });
    const detPtrs = detCols.map(() => 0);

    const cycles = [];
    for (let i = 0; i < n; i++) {
      const start = cycleStarts[i];
      const end = i + 1 < n ? cycleStarts[i + 1] : tMax;
      const spl = findSplAt(start, times, splValues) || '';
      const tu = Math.round((end - start) / 1000);

      const sg = new Map();
      sgSweeps.forEach(sw => {
        const gIdx = sw.greenSweep(start, end);
        if (gIdx === -1) { sg.set(sw.lname, { an: null, ab: null, tf: null, rotgelb: 0, gelb: 0 }); return; }
        const seg = sw.greens[gIdx];
        const anab = TU_MED ? computeSegmentAnAbTf(seg, cycleStarts, TU_MED) : null;
        const segIdx = sw.segIndexOfGreen[gIdx];
        const extra = segIdx != null ? adjacentTransitionDurations(sw.segs, segIdx) : { rotgelb: 0, gelb: 0 };
        sg.set(sw.lname, {
          an: anab ? anab.an : null,
          ab: anab ? anab.ab : null,
          tf: anab ? anab.tf : (seg.end - seg.start) / 1000,
          rotgelb: extra.rotgelb, gelb: extra.gelb
        });
      });

      const det = new Map();
      detCols.forEach((dc, di) => {
        let ptr = detPtrs[di];
        while (ptr < dc.edges.length && dc.edges[ptr] < start) ptr++;
        const from = ptr;
        while (ptr < dc.edges.length && dc.edges[ptr] < end) ptr++;
        const to = ptr;
        detPtrs[di] = ptr;
        const count = to - from;
        det.set(dc.lname, {
          triggered: count > 0, count,
          first: count > 0 ? (dc.edges[from] - start) / 1000 : null,
          last: count > 0 ? (dc.edges[to - 1] - start) / 1000 : null
        });
      });

      cycles.push({ sg, det, TU: tu, TU_MED, TX: i + 1, SPL: spl, START: start });
    }

    return { index, cycles };
  }

  GZ.umlaufContext = { buildIdentifierIndex, buildAll };
})(window.GZ = window.GZ || {});
