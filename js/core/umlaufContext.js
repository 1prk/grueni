/* GZ.umlaufContext — baut für Umlaufstatistiken je AUSWERTUNGSZEILE den
   Auswertungsscope für GZ.exprEngine.compileValue(): SG-/DET-Objekt-Handles
   im selben Grundformat wie js/views/formulaBuilder.js (class + cycleMetrics,
   siehe dort und exprEngine.js), aber OHNE zeilenweisen Sweep - Umlauf-
   statistiken braucht nur EINEN Wert je Zeile, nicht je Rohdaten-Zeile.
   Anders als der Formel-Builder (Variablen mit frei wählbarem Alias) werden
   hier die OCIT-Spaltennamen selbst direkt als Bezeichner nutzbar gemacht -
   kein separater "Variable anlegen"-Schritt.

   Eine AUSWERTUNGSZEILE ist NICHT zwingend ein Umlauf: ein Umlauf kann pro
   Signalgruppe mehr als EIN Anwurf- bzw. Abwurf-Ereignis enthalten (z.B.
   Fußgänger-Nachforderung/Re-Service, oder ein Grün, das über eine
   Umlaufgrenze hinausreicht). GZ.segments.computeCycleSgEvents() erfasst An
   und Ab dafür UNABHÄNGIG voneinander: An gehört zum Umlauf, in dem das
   Grün-Segment STARTET, Ab zu dem, in dem es ENDET - bei einem über die
   Umlaufgrenze hinausreichenden Grün sind das zwei verschiedene Umläufe.
   Beide bleiben dadurch ein rein LOKALER Wert (immer relativ zu GENAU dem
   Umlauf, in dem sie liegen), nie eine Modulo-Faltung auf einen fremden
   Umlauf. buildAll() erzeugt je Umlauf so viele Zeilen wie die
   "ereignisreichste" Seite (An ODER Ab, über alle Signalgruppen) dort hat
   (mindestens 1, auch ganz ohne jedes Ereignis - wie bisher eine Zeile mit
   lauter NaN-Werten): Zeile e sieht für JEDE Signalgruppe deren e-tes
   An-Ereignis UND deren e-tes Ab-Ereignis - beide rein per Index gepaart
   (n-tes An mit n-tem Ab, unabhängig davon, ob sie vom selben Grün-Segment
   stammen: ein Grün ohne Ab in diesem Umlauf liefert ein An OHNE
   zugehöriges Ab - Ab dort bewusst NaN, "wissen wir hier noch nicht" - und
   umgekehrt ein Ab OHNE zugehöriges An - "hat in einem früheren Umlauf
   begonnen"). TU/SPL/TU_MED bleiben über alle Zeilen desselben Umlaufs
   gleich (siehe cyc.cycleIdx/eventIdx/eventCount). Detektor-/APW-/ÖPNV-Werte
   (Ausgeloest/AnzahlAusloesungen) bleiben bewusst UMLAUF-weite Aggregate
   (nicht je Ereignis aufgeteilt) - dafür gibt es (anders als An/Ab/TF)
   keinen "welches Ereignis"-Bezug, sie gelten unverändert für JEDE Zeile
   desselben Umlaufs. */
(function (GZ) {
  'use strict';
  const {
    computeGlobalTU, computeCycleSgEvents, computeCycleDetMetrics, findSplAt,
    buildSegments, makeRawValueSampler, makeSegmentDurationSampler
  } = GZ.segments;
  const { categorizeDetRaw } = GZ.parser;
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

  // cycleMetrics aus einem {an:[...], ab:[...]}-Eintrag (siehe
  // computeCycleSgEvents()) für Zeilen-Index e zusammenbauen - null nur,
  // wenn WEDER ein An- noch ein Ab-Ereignis an dieser Stelle existiert
  // (diese Signalgruppe hatte in diesem Umlauf schlicht weniger Ereignisse
  // als die Zeilenanzahl); existiert nur eine Seite, bleibt die andere NaN
  // (bzw. 0 für rotgelb/gelb) statt den ganzen Datensatz zu verwerfen - An/
  // Ab/TF/RG/GE lesen ohnehin einzeln aus cm.an/cm.ab/... (siehe
  // exprEngine.js) und behandeln NaN bereits als "nicht verfügbar".
  function cycleMetricsForRow(evs, e) {
    const anEv = evs.an[e] || null, abEv = evs.ab[e] || null;
    if (!anEv && !abEv) return null;
    return {
      an: anEv ? anEv.value : NaN,
      ab: abEv ? abEv.value : NaN,
      tf: abEv ? abEv.tf : NaN,
      rotgelb: anEv ? anEv.rotgelb : 0,
      gelb: abEv ? abEv.gelb : 0,
      segIdx: abEv ? abEv.segIdx : (anEv ? anEv.segIdx : null),
      segStart: anEv ? anEv.segStart : null,
      segEnd: abEv ? abEv.segEnd : null
    };
  }

  // Baut den Kontext für JEDEN Umlauf der Aufzeichnung auf einmal - die
  // teure Sweep-Arbeit (GZ.segments.computeCycleSgEvents/-DetMetrics) läuft
  // einmal über die Aufzeichnung, danach ist das Auswerten einer Formel je
  // Zeile nur noch ein Baum-Durchlauf über wenige Knoten (compiled.run()).
  function buildAll(analysis) {
    const index = buildIdentifierIndex(analysis);
    const { allStats, otherColumns, cycleStarts, tMax, times, seriesByCol, splValues } = analysis;
    if (!cycleStarts || cycleStarts.length === 0) return { index, cycles: [] };

    const TU_MED = computeGlobalTU(cycleStarts);
    const n = cycleStarts.length;

    // sgEventsByName: Name -> Array (je Umlauf) von {an:[...], ab:[...]} -
    // GRUNDLAGE der Zeilen-Aufteilung unten (siehe computeCycleSgEvents()-
    // Kopfkommentar in segments.js).
    const sgEventsByName = new Map();
    const sgRawSamplerByName = new Map();
    // durationAtByName: Name -> sample(tMs)->Sekunden seit Beginn des zu tMs
    // gehörigen Zustands-Segments (GRUEN/ROT/... bzw. BELEGT/FREI) - Grundlage
    // der DauerBei()-Primitive (siehe exprEngine.js), gilt gleichermaßen für
    // Signalgruppen UND Detektoren/APW-/ÖPNV-Werte (bewusst generisch, siehe
    // GZ.segments.makeSegmentDurationSampler()).
    const durationAtByName = new Map();
    allStats.forEach(({ col, segs, stats }) => {
      sgEventsByName.set(col.name, computeCycleSgEvents(segs, stats.greens, cycleStarts, tMax));
      sgRawSamplerByName.set(col.name, makeRawValueSampler(times, seriesByCol.get(col.index)));
      durationAtByName.set(col.name, makeSegmentDurationSampler(segs));
    });
    const detMetricsByName = new Map();
    const rawSamplerByName = new Map();
    otherColumns.forEach(col => {
      const rawVals = seriesByCol.get(col.index);
      const occupied = times.map((_, k) => wzIstBelegt(rawVals[k]));
      detMetricsByName.set(col.name, computeCycleDetMetrics(times, occupied, cycleStarts, tMax));
      rawSamplerByName.set(col.name, makeRawValueSampler(times, rawVals));
      // Eigene BELEGT/FREI-Segmentierung nur für DauerBei() - computeCycleDetMetrics
      // oben kennt nur Umlauf-Aggregate (Ausgeloest/AnzahlAusloesungen), keine
      // Segmentgrenzen.
      durationAtByName.set(col.name, makeSegmentDurationSampler(buildSegments(times, rawVals, categorizeDetRaw)));
    });

    const cycles = [];
    for (let i = 0; i < n; i++) {
      const start = cycleStarts[i];
      const end = i + 1 < n ? cycleStarts[i + 1] : tMax;
      const spl = findSplAt(start, times, splValues) || '';
      const tu = Math.round((end - start) / 1000);

      // Zeilenanzahl DIESES Umlaufs = die größte An- ODER Ab-Ereignisanzahl
      // unter ALLEN Signalgruppen der Aufzeichnung in diesem Umlauf
      // (mindestens 1, auch ganz ohne jedes Ereignis - wie bisher eine Zeile
      // mit lauter NaN-Werten). Bewusst über ALLE Signalgruppen ermittelt
      // (nicht nur die in aktuell definierten Spalten-Formeln referenzierten)
      // - sonst würde sich die Zeilenzahl eines Umlaufs bei jeder
      // Formeländerung verschieben.
      let eventCount = 1;
      index.sgList.forEach(name => {
        const evs = sgEventsByName.get(name)[i];
        const c = Math.max(evs.an.length, evs.ab.length);
        if (c > eventCount) eventCount = c;
      });

      for (let e = 0; e < eventCount; e++) {
        // __cycleStart: kein regulärer, per varTypes deklarierter Bezeichner
        // (Nutzer können ihn nicht referenzieren) - nur intern von den
        // WertBei()-/DauerBei()-Primitiven gelesen (siehe exprEngine.js), um
        // deren Sekunden-Zeitpunkt in einen absoluten Zeitstempel für
        // handle.rawSample()/handle.durationAt() umzurechnen. Gilt für ALLE
        // Zeilen desselben Umlaufs gleich (der Umlauf selbst wird ja nicht
        // aufgeteilt, nur die pro Zeile sichtbaren SG-Ereignisse).
        const scope = { TU: tu, TU_MED: TU_MED == null ? NaN : TU_MED, SPL: spl, __cycleStart: start };
        index.sgList.forEach(name => {
          const evs = sgEventsByName.get(name)[i];
          scope[name] = { class: 'SG', cycleMetrics: cycleMetricsForRow(evs, e), rawSample: sgRawSamplerByName.get(name), durationAt: durationAtByName.get(name) };
        });
        // Detektor-/APW-/ÖPNV-Werte bleiben Umlauf-weite Aggregate, gleich
        // für jede Zeile desselben Umlaufs (siehe Datei-Kopfkommentar).
        index.detList.forEach(name => {
          scope[name] = { class: 'DET', cycleMetrics: detMetricsByName.get(name)[i] || null, rawSample: rawSamplerByName.get(name), durationAt: durationAtByName.get(name) };
        });

        cycles.push({ scope, start, end, TX: i + 1, SPL: spl, TU: tu, cycleIdx: i, eventIdx: e, eventCount });
      }
    }

    return { index, cycles };
  }

  GZ.umlaufContext = { buildIdentifierIndex, buildAll };
})(window.GZ = window.GZ || {});
