/* GZ.umlaufContext — baut für Umlaufstatistiken je AUSWERTUNGSZEILE den
   Auswertungsscope für GZ.exprEngine.compileValue(): SG-/DET-Objekt-Handles
   im selben Grundformat wie js/views/formulaBuilder.js (class + cycleMetrics,
   siehe dort und exprEngine.js), aber OHNE zeilenweisen Sweep - Umlauf-
   statistiken braucht nur EINEN Wert je Zeile, nicht je Rohdaten-Zeile.
   Anders als der Formel-Builder (Variablen mit frei wählbarem Alias) werden
   hier die OCIT-Spaltennamen selbst direkt als Bezeichner nutzbar gemacht -
   kein separater "Variable anlegen"-Schritt.

   An/Ab/TF/RG/GE sind UNIVERSELL (siehe exprEngine.js PRIMITIVES-Kopfkommentar
   dort): eine Signalgruppe UND ein Detektor/APW-/ÖPNV-Wert haben beide genau
   EINEN "aktiven" Zustand (GRUEN bzw. BELEGT), dessen Beginn/Ende/Dauer diese
   Datei für BEIDE Objekt-Klassen gleich behandelt - GZ.segments.
   computeCycleSgEvents() ist dafür bewusst nicht an "Signalgruppe"/"Grün"
   gebunden, sondern nimmt beliebige (bereits kategorisierte) Zustands-
   segmente entgegen.

   Eine AUSWERTUNGSZEILE ist NICHT zwingend ein Umlauf: ein Umlauf kann pro
   Signalgruppe ODER Detektor/Wert mehr als EIN Anwurf- bzw. Abwurf-Ereignis
   enthalten (z.B. Fußgänger-Nachforderung/Re-Service, mehrere Detektor-
   Auslösungen, oder ein Grün/eine Belegung, die über eine Umlaufgrenze
   hinausreicht). computeCycleSgEvents() erfasst An und Ab dafür UNABHÄNGIG
   voneinander: An gehört zum Umlauf, in dem das Zustands-Segment STARTET, Ab
   zu dem, in dem es ENDET - bei einer Umlaufgrenze mitten im Segment sind
   das zwei verschiedene Umläufe. Beide bleiben dadurch ein rein LOKALER
   Wert (immer relativ zu GENAU dem Umlauf, in dem sie liegen), nie eine
   Modulo-Faltung auf einen fremden Umlauf. buildAll() erzeugt je Umlauf so
   viele Zeilen wie die "ereignisreichste" Seite (An ODER Ab, über ALLE
   Signalgruppen UND Detektoren/Werte) dort hat (mindestens 1, auch ganz ohne
   jedes Ereignis - wie bisher eine Zeile mit lauter NaN-Werten): Zeile e
   sieht für JEDES Objekt dessen e-tes An-Ereignis UND dessen e-tes
   Ab-Ereignis - beide rein per Index gepaart (n-tes An mit n-tem Ab,
   unabhängig davon, ob sie vom selben Zustands-Segment stammen: ein Segment
   ohne Ab in diesem Umlauf liefert ein An OHNE zugehöriges Ab - Ab/TF dort
   bewusst NaN, "wissen wir hier noch nicht" - und umgekehrt ein Ab OHNE
   zugehöriges An - "hat in einem früheren Umlauf begonnen"). TU/SPL/TU_MED
   bleiben über alle Zeilen desselben Umlaufs gleich (siehe
   cyc.cycleIdx/eventIdx/eventCount).

   Ausgeloest/AnzahlAusloesungen bleiben bewusst UMLAUF-weite Aggregate
   (nicht je Ereignis aufgeteilt, dafür gibt es keinen "welches Ereignis"-
   Bezug) - sie gelten unverändert für JEDE Zeile desselben Umlaufs und
   werden dem gemeinsamen cycleMetrics-Objekt eines Detektors/Werts als
   triggered/count-Felder zusätzlich zu an/ab/tf/rotgelb/gelb beigemischt
   (siehe detCycleMetricsForRow()). */
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
    // EREIGNIS: 1-basierte Zeilennummer INNERHALB des Umlaufs (siehe
    // cyc.eventIdx/eventCount in buildAll()) - dieselbe Zahl, die die
    // Tabelle in der Spalte "Ereignis" anzeigt. Erlaubt Formeln, die
    // ansonsten je Umlauf mehrfach wiederholte "gar kein Ereignis"-Zeilen
    // (siehe ISTLEER()) auf die JEWEILS ERSTE Zeile des Umlaufs begrenzen,
    // z.B. WENN(EREIGNIS > 1 AND ISTLEER(An(X)), LEER, ...) - ohne das würde
    // ein UNBETEILIGTES Objekt, das in diesem Umlauf mehrfach auslöst (und
    // damit die Zeilenanzahl des Umlaufs hochtreibt), dieselbe "kein
    // Ereignis von X"-Aussage einmal je seiner eigenen Vorkommen wiederholen.
    const varTypes = { TU: 'NUM', TU_MED: 'NUM', SPL: 'TEXT', EREIGNIS: 'NUM' };
    sgList.forEach(n => { varTypes[n] = 'SG'; });
    detList.forEach(n => { varTypes[n] = 'DET'; });
    return { sg, det, sgList, detList, varTypes };
  }

  // An/Ab/TF/RG/GE-Felder aus einem {an:[...], ab:[...]}-Eintrag (siehe
  // computeCycleSgEvents()-Kopfkommentar in segments.js) für Zeilen-Index e
  // zusammenbauen - existiert nur eine Seite (An ODER Ab), bleibt die
  // andere NaN (bzw. 0 für rotgelb/gelb) statt den ganzen Datensatz zu
  // verwerfen: An/Ab/TF/RG/GE lesen ohnehin einzeln aus cm.an/cm.ab/...
  // (siehe exprEngine.js) und behandeln NaN bereits als "nicht verfügbar".
  // hasEvent kennzeichnet, ob ÜBERHAUPT eine Seite existiert - Signalgruppen
  // (siehe sgCycleMetricsForRow()) werden ohne jedes Ereignis komplett null,
  // Detektoren/Werte (siehe detCycleMetricsForRow()) behalten stattdessen
  // immer ihr Umlauf-weites Ausgeloest/AnzahlAusloesungen-Aggregat.
  function anAbFields(evs, e) {
    const anEv = evs.an[e] || null, abEv = evs.ab[e] || null;
    return {
      an: anEv ? anEv.value : NaN,
      ab: abEv ? abEv.value : NaN,
      tf: abEv ? abEv.tf : NaN,
      rotgelb: anEv ? anEv.rotgelb : 0,
      gelb: abEv ? abEv.gelb : 0,
      segIdx: abEv ? abEv.segIdx : (anEv ? anEv.segIdx : null),
      segStart: anEv ? anEv.segStart : null,
      segEnd: abEv ? abEv.segEnd : null,
      hasEvent: !!(anEv || abEv)
    };
  }
  function sgCycleMetricsForRow(evs, e) {
    const f = anAbFields(evs, e);
    if (!f.hasEvent) return null;
    delete f.hasEvent;
    return f;
  }
  function detCycleMetricsForRow(evs, e, agg) {
    const f = anAbFields(evs, e);
    delete f.hasEvent;
    f.triggered = agg ? agg.triggered : false;
    f.count = agg ? agg.count : 0;
    return f;
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

    // eventsByName/durationAtByName/rawSamplerByName gelten für SG UND DET
    // gleichermaßen (siehe Datei-Kopfkommentar) - detAggByName zusätzlich
    // NUR für DET (Ausgeloest/AnzahlAusloesungen-Aggregate, siehe
    // detCycleMetricsForRow()).
    const eventsByName = new Map();
    const rawSamplerByName = new Map();
    const durationAtByName = new Map();
    const detAggByName = new Map();

    allStats.forEach(({ col, segs, stats }) => {
      eventsByName.set(col.name, computeCycleSgEvents(segs, stats.greens, cycleStarts, tMax));
      rawSamplerByName.set(col.name, makeRawValueSampler(times, seriesByCol.get(col.index)));
      durationAtByName.set(col.name, makeSegmentDurationSampler(segs));
    });
    otherColumns.forEach(col => {
      const rawVals = seriesByCol.get(col.index);
      const occupied = times.map((_, k) => wzIstBelegt(rawVals[k]));
      // Eigene BELEGT/FREI-Segmentierung: computeCycleDetMetrics unten liefert
      // nur die Umlauf-Aggregate (Ausgeloest/AnzahlAusloesungen), keine
      // Segmentgrenzen - für An/Ab/TF/DauerBei wird der tatsächliche
      // BELEGT-Segmentverlauf gebraucht, genau wie GRUEN bei Signalgruppen.
      const detSegs = buildSegments(times, rawVals, categorizeDetRaw);
      const belegtSegs = detSegs.filter(s => s.cat === 'BELEGT');
      eventsByName.set(col.name, computeCycleSgEvents(detSegs, belegtSegs, cycleStarts, tMax));
      rawSamplerByName.set(col.name, makeRawValueSampler(times, rawVals));
      durationAtByName.set(col.name, makeSegmentDurationSampler(detSegs));
      detAggByName.set(col.name, computeCycleDetMetrics(times, occupied, cycleStarts, tMax));
    });

    const cycles = [];
    for (let i = 0; i < n; i++) {
      const start = cycleStarts[i];
      const end = i + 1 < n ? cycleStarts[i + 1] : tMax;
      const spl = findSplAt(start, times, splValues) || '';
      const tu = Math.round((end - start) / 1000);

      // Zeilenanzahl DIESES Umlaufs = die größte An- ODER Ab-Ereignisanzahl
      // unter ALLEN Signalgruppen UND Detektoren/Werten der Aufzeichnung in
      // diesem Umlauf (mindestens 1, auch ganz ohne jedes Ereignis - wie
      // bisher eine Zeile mit lauter NaN-Werten). Bewusst über ALLE Objekte
      // ermittelt (nicht nur die in aktuell definierten Spalten-Formeln
      // referenzierten) - sonst würde sich die Zeilenzahl eines Umlaufs bei
      // jeder Formeländerung verschieben.
      let eventCount = 1;
      index.sgList.concat(index.detList).forEach(name => {
        const evs = eventsByName.get(name)[i];
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
        // aufgeteilt, nur die pro Zeile sichtbaren Ereignisse).
        const scope = { TU: tu, TU_MED: TU_MED == null ? NaN : TU_MED, SPL: spl, EREIGNIS: e + 1, __cycleStart: start };
        index.sgList.forEach(name => {
          const evs = eventsByName.get(name)[i];
          scope[name] = { class: 'SG', cycleMetrics: sgCycleMetricsForRow(evs, e), rawSample: rawSamplerByName.get(name), durationAt: durationAtByName.get(name) };
        });
        index.detList.forEach(name => {
          const evs = eventsByName.get(name)[i];
          const agg = detAggByName.get(name)[i];
          scope[name] = { class: 'DET', cycleMetrics: detCycleMetricsForRow(evs, e, agg), rawSample: rawSamplerByName.get(name), durationAt: durationAtByName.get(name) };
        });

        cycles.push({ scope, start, end, TX: i + 1, SPL: spl, TU: tu, cycleIdx: i, eventIdx: e, eventCount });
      }
    }

    return { index, cycles };
  }

  GZ.umlaufContext = { buildIdentifierIndex, buildAll };
})(window.GZ = window.GZ || {});
