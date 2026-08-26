/* GZ.umlaufContext — baut für Umlaufstatistiken je AUSWERTUNGSZEILE den
   Auswertungsscope für GZ.exprEngine.compileValue(): SG-/DET-Objekt-Handles
   im selben Grundformat wie js/views/formulaBuilder.js (class + cycleMetrics,
   siehe dort und exprEngine.js), aber OHNE zeilenweisen Sweep - Umlauf-
   statistiken braucht nur EINEN Wert je Zeile, nicht je Rohdaten-Zeile.
   Anders als der Formel-Builder (Variablen mit frei wählbarem Alias) werden
   hier die OCIT-Spaltennamen selbst direkt als Bezeichner nutzbar gemacht -
   kein separater "Variable anlegen"-Schritt.

   Eine AUSWERTUNGSZEILE ist NICHT zwingend ein Umlauf: ein Umlauf kann pro
   Signalgruppe mehr als EIN Anwurf/Abwurf-Paar enthalten (z.B. Fußgänger-
   Nachforderung/Re-Service) - GZ.segments.computeCycleSgMetrics() liefert
   seither je Umlauf ein ARRAY aller erkannten Vorkommen statt nur des
   ersten. buildAll() erzeugt daher je Umlauf so viele Zeilen wie das
   "ereignisreichste" SG-Vorkommen dort hat (mindestens 1, auch ohne jedes
   Vorkommen - wie bisher eine Zeile mit lauter NaN/leeren Werten): Zeile e
   eines Umlaufs sieht für JEDE Signalgruppe deren e-tes Vorkommen (oder
   NaN/null, falls diese Signalgruppe in diesem Umlauf weniger Vorkommen
   hatte) - Vorkommen werden dabei chronologisch INDEX-gepaart (1. Vorkommen
   von K1 mit 1. Vorkommen von K2 usw.), nicht inhaltlich/zeitlich
   korreliert. TU/SPL/TU_MED bleiben über alle Zeilen desselben Umlaufs
   gleich (siehe cyc.cycleIdx/eventIdx/eventCount). Detektor-/APW-/ÖPNV-Werte
   (Ausgeloest/AnzahlAusloesungen) bleiben bewusst UMLAUF-weite Aggregate
   (nicht je Vorkommen aufgeteilt) - anders als An/Ab/TF gibt es dafür keinen
   "welches Vorkommen"-Bezug, sie gelten unverändert für JEDE Zeile desselben
   Umlaufs. */
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
  // Zeile nur noch ein Baum-Durchlauf über wenige Knoten (compiled.run()).
  function buildAll(analysis) {
    const index = buildIdentifierIndex(analysis);
    const { allStats, otherColumns, cycleStarts, tMax, times, seriesByCol, splValues } = analysis;
    if (!cycleStarts || cycleStarts.length === 0) return { index, cycles: [] };

    const TU_MED = computeGlobalTU(cycleStarts);
    const n = cycleStarts.length;

    // sgOccByName: Name -> Array (je Umlauf) von Arrays aller Vorkommen
    // dieser Signalgruppe in diesem Umlauf (siehe computeCycleSgMetrics()-
    // Kopfkommentar) - GRUNDLAGE der Zeilen-Aufteilung unten.
    const sgOccByName = new Map();
    const sgRawSamplerByName = new Map();
    allStats.forEach(({ col, segs, stats }) => {
      sgOccByName.set(col.name, computeCycleSgMetrics(segs, stats.greens, cycleStarts, tMax, TU_MED));
      sgRawSamplerByName.set(col.name, makeRawValueSampler(times, seriesByCol.get(col.index)));
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

      // Zeilenanzahl DIESES Umlaufs = die größte Vorkommen-Anzahl unter
      // ALLEN Signalgruppen der Aufzeichnung in diesem Umlauf (mindestens 1,
      // auch ganz ohne jedes Vorkommen - wie bisher eine Zeile mit lauter
      // NaN-Werten). Bewusst über ALLE Signalgruppen ermittelt (nicht nur
      // die in aktuell definierten Spalten-Formeln referenzierten) - sonst
      // würde sich die Zeilenzahl eines Umlaufs bei jeder Formeländerung
      // verschieben.
      let eventCount = 1;
      index.sgList.forEach(name => {
        const occs = sgOccByName.get(name)[i];
        if (occs && occs.length > eventCount) eventCount = occs.length;
      });

      for (let e = 0; e < eventCount; e++) {
        // __cycleStart: kein regulärer, per varTypes deklarierter Bezeichner
        // (Nutzer können ihn nicht referenzieren) - nur intern von der
        // WertBei()-Primitive gelesen (siehe exprEngine.js), um deren
        // Sekunden-Zeitpunkt in einen absoluten Zeitstempel für
        // handle.rawSample() umzurechnen. Gilt für ALLE Zeilen desselben
        // Umlaufs gleich (der Umlauf selbst wird ja nicht aufgeteilt, nur
        // die pro Zeile sichtbaren SG-Vorkommen).
        const scope = { TU: tu, TU_MED: TU_MED == null ? NaN : TU_MED, SPL: spl, __cycleStart: start };
        index.sgList.forEach(name => {
          const occs = sgOccByName.get(name)[i];
          const cycleMetrics = (occs && occs[e]) || null;
          scope[name] = { class: 'SG', cycleMetrics, rawSample: sgRawSamplerByName.get(name) };
        });
        // Detektor-/APW-/ÖPNV-Werte bleiben Umlauf-weite Aggregate, gleich
        // für jede Zeile desselben Umlaufs (siehe Datei-Kopfkommentar).
        index.detList.forEach(name => {
          scope[name] = { class: 'DET', cycleMetrics: detMetricsByName.get(name)[i] || null, rawSample: rawSamplerByName.get(name) };
        });

        cycles.push({ scope, start, end, TX: i + 1, SPL: spl, TU: tu, cycleIdx: i, eventIdx: e, eventCount });
      }
    }

    return { index, cycles };
  }

  GZ.umlaufContext = { buildIdentifierIndex, buildAll };
})(window.GZ = window.GZ || {});
