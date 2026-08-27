/* GZ.segments — Zustandssegmente, Umlauf-/SPL-Statistik und abgeleitete
   Signalplan-Kennwerte (An/Ab/TF). Arbeitet auf den von GZ.parser gelieferten
   Rohreihen, unabhängig vom DOM. */
(function (GZ) {
  'use strict';
  const { median, mean } = GZ.stats;
  const { categorizeSgRaw } = GZ.parser;

  // Zustandssegmente einer Spalte. Aufzeichnungslücken (Zeitsprung deutlich
  // über dem typischen Schritt) beenden das laufende Segment und werden als
  // eigenes LUECKE-Segment ausgewiesen - sonst würde z. B. eine 10-minütige
  // Logging-Pause während Grün als 10-Minuten-Grünphase in die Statistik
  // eingehen und Ø/Max/Trend verfälschen. catFn optional (Standard = AMPEL-
  // Kategorisierung); für DET-Spalten wird categorizeDetRaw übergeben.
  function buildSegments(times, rawValues, catFn) {
    const fn = catFn || categorizeSgRaw;
    const segs = [];
    const step = GZ.parser.estimateStep(times);
    const gapThresh = Math.max(step * 5, 5000);
    let curCat = null, curStart = null, prevT = null;
    for (let i = 0; i < rawValues.length; i++) {
      const t = times[i];
      if (prevT !== null && (t - prevT) > gapThresh && curCat !== null) {
        const segEnd = prevT + step;
        segs.push({ cat: curCat, start: curStart, end: segEnd });
        segs.push({ cat: 'LUECKE', start: segEnd, end: t });
        curCat = null; curStart = null;
      }
      prevT = t;
      const raw = rawValues[i];
      if (raw === '') { continue; }
      const cat = fn(raw);
      if (cat !== curCat) {
        if (curCat !== null) segs.push({ cat: curCat, start: curStart, end: t });
        curCat = cat; curStart = t;
      }
    }
    if (curCat !== null) segs.push({ cat: curCat, start: curStart, end: times[times.length - 1] + GZ.parser.estimateStep(times) });
    return segs;
  }

  function computeCycleStats(segs) {
    const greens = segs.filter(s => s.cat === 'GRUEN');
    const greenDurations = greens.map(s => (s.end - s.start) / 1000);
    const cycleDurations = [];
    for (let i = 0; i < greens.length - 1; i++) cycleDurations.push((greens[i + 1].start - greens[i].start) / 1000);
    return { greens, greenDurations, cycleDurations };
  }

  // Aktiven SPL-Wert (Signalzeitenplan) zu einem Zeitpunkt t ermitteln.
  // splValues ist beim Einlesen bereits vorwärts aufgefüllt, daher genügt die
  // Binärsuche nach dem letzten Zeitindex <= t.
  function findSplAt(t, times, splValues) {
    if (!times || !times.length) return '';
    let lo = 0, hi = times.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans >= 0 ? (splValues[ans] || '') : '';
  }

  // Liefert eine sample(tMs)-Funktion für den Rohwert EINER Spalte (DET/BLK/
  // APW/ÖPNV) zu einem beliebigen Zeitpunkt - Grundlage der exprEngine-
  // Primitive WertBei(det, zeitpunkt) (z.B. "welchen APW-Countdown zeigte
  // APW_01 im Moment des Abwurfs von K1"). Anders als splValues sind
  // DET/APW/ÖPNV-Rohreihen NICHT vorab aufgefüllt (siehe GZ.parser.
  // parseOcitText: nur TC/SP werden beim Einlesen "forward-filled") - eine
  // leere Zelle bedeutet "unverändert seit dem letzten Wert", nicht "kein
  // Wert" (buildSegments() überspringt leere Zellen aus demselben Grund).
  // Daher hier einmalig (nicht pro Abfrage) vorwärts aufgefüllt, danach wie
  // findSplAt() eine Binärsuche nach dem letzten Zeitindex <= t. Eine
  // WIRKLICH leere Zelle (kein Wert je gesehen) sowie ein nicht-numerischer
  // Rohwert (z.B. "INV") liefern NaN - konsistent mit dem NUM/NaN-Vertrag
  // aus exprEngine.js.
  function makeRawValueSampler(times, rawVals) {
    const filled = new Array(rawVals.length);
    let last = '';
    for (let i = 0; i < rawVals.length; i++) {
      if (rawVals[i] !== '') last = rawVals[i];
      filled[i] = last;
    }
    return function sample(tMs) {
      let lo = 0, hi = times.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= tMs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (ans === -1) return NaN;
      const raw = filled[ans];
      if (raw === '') return NaN;
      const n = Number(raw);
      return Number.isFinite(n) ? n : NaN;
    };
  }

  // Liefert eine durationAt(tMs)-Funktion: wie lange (in Sekunden) war der
  // Zustand, der zum Zeitpunkt tMs gilt, zu diesem Zeitpunkt bereits
  // UNUNTERBROCHEN aktiv? Grundlage der exprEngine-Primitive DauerBei(objekt,
  // zeitpunkt) - bewusst GENERISCH über beliebige Zustandssegmente (segs, wie
  // von buildSegments() erzeugt): für eine Signalgruppe sind das GRUEN/ROT/...
  // -Segmente, für einen Detektor/APW-/ÖPNV-Wert BELEGT/FREI-Segmente
  // (categorizeDetRaw) - dieser Funktion ist es gleichgültig, WELCHE Kategorie
  // gerade gilt, sie beantwortet nur "seit wann gilt der jeweils AKTUELLE
  // Zustand". Entspricht damit dem zeilenweisen Dauer(objekt) aus
  // exprEngine.js, nur mit einem beliebigen (nicht nur dem "aktuellen")
  // Zeitpunkt - Binärsuche statt fortlaufendem Sweep, da Abfragen (anders als
  // ein Sweep über die Rohdaten) nicht notwendig aufsteigend erfolgen.
  // Liefert NaN, wenn tMs vor dem ersten Segment liegt oder in eine
  // Aufzeichnungslücke fällt (siehe buildSegments()' LUECKE-Segmente - das
  // IST ein eigenes Segment mit .start, "seit wann Lücke" ist daher wohl-
  // definiert und wird wie jeder andere Zustand behandelt).
  function makeSegmentDurationSampler(segs) {
    return function durationAt(tMs) {
      let lo = 0, hi = segs.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (segs[mid].start <= tMs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (ans === -1) return NaN;
      const seg = segs[ans];
      if (tMs >= seg.end) return NaN; // hinter dem letzten Segment - kein aktueller Zustand bekannt
      return (tMs - seg.start) / 1000;
    };
  }

  // Wie computeCycleStats, aber getrennt je aktivem SPL zum Zeitpunkt des
  // jeweiligen Grünbeginns. Ø Umlauf wird nur aus Zyklen gebildet, die
  // vollständig innerhalb desselben SPL liegen.
  function computeCycleStatsBySpl(segs, times, splValues) {
    const greens = segs.filter(s => s.cat === 'GRUEN');
    const splOf = greens.map(g => findSplAt(g.start, times, splValues) || '(unbekannt)');
    const bySpl = new Map();
    const ensure = spl => {
      if (!bySpl.has(spl)) bySpl.set(spl, { greenDurations: [], cycleDurations: [] });
      return bySpl.get(spl);
    };
    greens.forEach((g, i) => ensure(splOf[i]).greenDurations.push((g.end - g.start) / 1000));
    for (let i = 0; i < greens.length - 1; i++) {
      if (splOf[i] === splOf[i + 1]) ensure(splOf[i]).cycleDurations.push((greens[i + 1].start - greens[i].start) / 1000);
    }
    return bySpl;
  }

  // Zeitpunkte, an denen sich der SPL-Zustand ändert - einmalig über die
  // komplette Messreihe ermittelt (nicht pro Zyklus).
  function computeSplTransitions(times, splValues) {
    const transitions = [];
    let last = null;
    for (let i = 0; i < times.length; i++) {
      const v = splValues[i];
      if (v === '') continue;
      if (last !== null && v !== last) transitions.push({ t: times[i], from: last, to: v });
      last = v;
    }
    return transitions;
  }

  function computeGlobalTU(cycleStarts) {
    if (!cycleStarts || cycleStarts.length < 2) return null;
    const diffs = [];
    for (let i = 1; i < cycleStarts.length; i++) diffs.push((cycleStarts[i] - cycleStarts[i - 1]) / 1000);
    return Math.round(median(diffs));
  }

  function findEnclosingCycleStart(t, cycleStarts) {
    let idx = -1;
    for (let k = 0; k < cycleStarts.length; k++) {
      if (cycleStarts[k] <= t) idx = k; else break;
    }
    return idx >= 0 ? cycleStarts[idx] : null;
  }

  // Findet den Umlauf-Zeitbereich (laut TX=0-Grenzen), in dem ein Zeitpunkt liegt.
  function findCycleRange(t, cycleStarts, tMin, tMax) {
    if (!cycleStarts || cycleStarts.length === 0) return null;
    let idx = -1;
    for (let k = 0; k < cycleStarts.length; k++) {
      if (cycleStarts[k] <= t) idx = k; else break;
    }
    if (idx === -1) return { start: tMin, end: cycleStarts[0] };
    const start = cycleStarts[idx];
    const end = idx + 1 < cycleStarts.length ? cycleStarts[idx + 1] : tMax;
    return { start, end };
  }

  // An/Ab/TF für EIN konkretes Grünsegment (nicht aggregiert), inkl. Wrap-Fall
  // (z. B. TU=100, An=90, Ab=10 -> TF=20).
  function computeSegmentAnAbTf(seg, cycleStarts, TU) {
    const csStart = findEnclosingCycleStart(seg.start, cycleStarts);
    const csEnd = findEnclosingCycleStart(seg.end, cycleStarts);
    if (csStart == null || csEnd == null) return null;
    const an = ((Math.round((seg.start - csStart) / 1000) % TU) + TU) % TU;
    const ab = ((Math.round((seg.end - csEnd) / 1000) % TU) + TU) % TU;
    const tf = Math.round((seg.end - seg.start) / 1000);
    return { an, ab, tf };
  }

  // Typische (Median-)Werte An/Ab/TF einer Signalgruppe sowie die tatsächlich
  // beobachteten Rot-Gelb-/Gelb-Übergangsdauern.
  function computeSignalplanRow(segs, cycleStarts, TU) {
    const ans = [], abs_ = [], tfs = [], rotgelbs = [], gelbs = [];
    segs.forEach((g, i) => {
      if (g.cat !== 'GRUEN') return;
      const csStart = findEnclosingCycleStart(g.start, cycleStarts);
      const csEnd = findEnclosingCycleStart(g.end, cycleStarts);
      if (csStart == null || csEnd == null) return;
      ans.push(Math.round((g.start - csStart) / 1000));
      abs_.push(Math.round((g.end - csEnd) / 1000));
      tfs.push((g.end - g.start) / 1000);
      const prev = segs[i - 1];
      if (prev && prev.cat === 'ROTGELB') rotgelbs.push((prev.end - prev.start) / 1000);
      const next = segs[i + 1];
      if (next && next.cat === 'GELB') gelbs.push((next.end - next.start) / 1000);
    });
    if (ans.length === 0) return null;
    return {
      an: ((Math.round(median(ans)) % TU) + TU) % TU,
      ab: ((Math.round(median(abs_)) % TU) + TU) % TU,
      tf: Math.round(median(tfs)),
      rotgelb: rotgelbs.length ? Math.round(median(rotgelbs)) : 0,
      gelb: gelbs.length ? Math.round(median(gelbs)) : 0
    };
  }

  // Bildet stats.greens (nur GRUEN-Segmente) auf ihre Indizes im
  // vollständigen segs-Array ab - einmalig je Signalgruppe, damit
  // adjacentTransitionDurations() nicht pro Umlauf linear nach dem passenden
  // Segment suchen muss (siehe GZ.umlaufContext).
  function mapGreensToSegIndex(segs) {
    const out = [];
    segs.forEach((s, i) => { if (s.cat === 'GRUEN') out.push(i); });
    return out;
  }

  // Rotgelb-/Gelb-Dauer unmittelbar vor/nach EINEM Grünsegment (0, falls
  // nicht angrenzend) - dieselbe Nachbarschaftslogik wie computeSignalplanRow,
  // aber für ein einzelnes Vorkommen statt für den Median über alle.
  function adjacentTransitionDurations(segs, segIndex) {
    const prev = segs[segIndex - 1];
    const rotgelb = (prev && prev.cat === 'ROTGELB') ? (prev.end - prev.start) / 1000 : 0;
    const next = segs[segIndex + 1];
    const gelb = (next && next.cat === 'GELB') ? (next.end - next.start) / 1000 : 0;
    return { rotgelb, gelb };
  }

  // An/Ab/TF/Rotgelb/Gelb EINER Signalgruppe für JEDEN Umlauf (Index =
  // Umlaufindex in cycleStarts) - Grundlage der umlaufweisen exprEngine-
  // Primitiven An/Ab/TF/RG/GE (siehe dortigen Kopfkommentar zu
  // handle.cycleMetrics). greens = stats.greens der Signalgruppe (nur
  // GRUEN-Segmente), segs = deren vollständige Segmentliste (für die
  // Rotgelb-/Gelb-Nachbarschaft).
  //
  // Rückgabe: Array (je Umlauf) von Arrays EINES ODER MEHRERER Vorkommen
  // (leeres Array = kein Grün in diesem Umlauf) - ein Umlauf kann mehr als
  // EIN Anwurf/Abwurf-Paar derselben Signalgruppe enthalten (z.B. Fußgänger-
  // Nachforderung/Re-Service), erkannt als jedes GRUEN-Segment, dessen
  // START in dieses Umlauf-Fenster fällt (nicht nur das erste - das war der
  // eigentliche Fehler: ein zweites/drittes Vorkommen wurde bisher
  // stillschweigend verworfen, siehe GZ.umlaufContext.buildAll(), das daraus
  // je Umlauf so viele AUSGEWERTETE ZEILEN macht wie das "ereignisreichste"
  // SG-Vorkommen dort hat). Vorkommen[0] ist weiterhin das chronologisch
  // erste je Umlauf - Aufrufer, die (wie bisher) nur EIN Vorkommen je Umlauf
  // kennen (js/core/phases.js, js/views/formulaBuilder.js' zeilenweiser
  // Formel-Builder), lesen bewusst nur Vorkommen[0] und bleiben damit exakt
  // beim bisherigen Verhalten - die Mehrfach-Erkennung gilt vorerst nur für
  // die umlaufweise Auswertung in Umlaufstatistiken.
  //
  // an/ab je Vorkommen bewusst relativ zum Beginn DIESES Umlaufs berechnet
  // (nicht über computeSegmentAnAbTf(), dessen ab absichtlich relativ zu dem
  // Umlauf verankert ist, in dem das Segment ENDET - richtig für
  // umlaufpruefung.js' carrySegs-Zeilenanzeige bei über die Umlaufgrenze
  // hinausreichendem Grün, aber falsch für EINEN in sich konsistenten
  // Umlaufstatistiken-Datensatz, siehe Git-Historie). ab kann daher > TU_MED
  // sein (ehrliches Signal für "dauerhaft grün über den Umlauf hinaus" statt
  // einer verdeckenden Modulo-Faltung) - Versatz/Ueberschneidung falten das
  // beim eigenen Vergleich ohnehin per MOD().
  function computeCycleSgMetrics(segs, greens, cycleStarts, tMax, TU_MED) {
    const n = cycleStarts ? cycleStarts.length : 0;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = [];
    if (!TU_MED || n === 0) return out;
    const segIndexOfGreen = mapGreensToSegIndex(segs);
    // Fortlaufender Zeiger statt makeIndexSweep(): der bräuchte "höchstens
    // EIN Treffer je Fenster", hier soll die innere Schleife dagegen ALLE
    // Vorkommen mit .start im aktuellen Fenster aufsammeln, bevor sie für
    // das nächste (spätere) Umlauf-Fenster weiterrückt - bleibt trotzdem
    // amortisiert O(Umläufe + Vorkommen) über die gesamte Aufzeichnung.
    let ptr = 0;
    for (let i = 0; i < n; i++) {
      const start = cycleStarts[i];
      const end = i + 1 < n ? cycleStarts[i + 1] : tMax;
      while (ptr < greens.length && greens[ptr].start < start) ptr++;
      let j = ptr;
      while (j < greens.length && greens[j].start < end) {
        const seg = greens[j];
        const an = Math.round((seg.start - start) / 1000);
        const ab = Math.round((seg.end - start) / 1000);
        const tf = Math.round((seg.end - seg.start) / 1000);
        const segIdx = segIndexOfGreen[j];
        const extra = segIdx != null ? adjacentTransitionDurations(segs, segIdx) : { rotgelb: 0, gelb: 0 };
        // segIdx/segStart/segEnd (roh, unverundet) zusätzlich zu den
        // gerundeten an/ab/tf-Kennzahlen - Aufrufer, die die tatsächliche
        // Position dieses GRUEN-Segments im vollständigen segs-Array
        // brauchen (z.B. GZ.phases' PÜ-Werkzeug, um genau dieses Segment
        // plus seine Rotgelb-/Gelb-Nachbarn darzustellen, statt der
        // gesamten Rohdaten-Zeitreihe der Signalgruppe), müssen sie sonst
        // selbst neu suchen.
        out[i].push({ an, ab, tf, rotgelb: extra.rotgelb, gelb: extra.gelb, segIdx, segStart: seg.start, segEnd: seg.end });
        j++;
      }
      ptr = j;
    }
    return out;
  }

  // Wie computeCycleSgMetrics(), aber An UND Ab UNABHÄNGIG voneinander
  // erfasst statt als EIN gemeinsames Vorkommen: An gehört zu dem Umlauf,
  // in dem das Segment STARTET, Ab zu dem Umlauf, in dem es ENDET - bei
  // einem Grün, das über eine Umlaufgrenze hinausreicht, sind das ZWEI
  // VERSCHIEDENE Umläufe. Grundlage von GZ.umlaufContext.buildAll()
  // (Umlaufstatistiken) - anders als computeCycleSgMetrics (weiterhin genutzt
  // von js/core/phases.js und dem zeilenweisen Formel-Builder, die ein
  // einzelnes, in sich geschlossenes Vorkommen mit garantiert zusammen-
  // gehörigem An+Ab wollen).
  //
  // Motivation: An(sg)/Ab(sg) sollen in Umlaufstatistiken je Umlauf ein rein
  // LOKALER Wert bleiben (immer < TU dieses Umlaufs, nie über eine Modulo-
  // Faltung verdeckt UND nie an einen fremden, nur zufällig "zugehörigen"
  // Umlauf gekoppelt) - "wir reden hier immer über relative Zeit [innerhalb
  // DIESES Umlaufs]" (siehe Konversation). Ein Grün, das in Umlauf A beginnt
  // und erst in Umlauf B endet, erzeugt daher in Umlauf A ein An OHNE
  // zugehöriges Ab (TF/Ab dort NaN - "wissen wir hier noch nicht") und in
  // Umlauf B ein Ab OHNE zugehöriges An (An dort NaN - "hat woanders
  // begonnen"), STATT beides künstlich in EINEM Umlauf zusammenzuzwingen.
  //
  // Rückgabe: Array (je Umlauf) von { an: [...], ab: [...] } - an[k] =
  // {value, rotgelb, segIdx, segStart}, ab[k] = {value, tf, gelb, segIdx,
  // segEnd}. rotgelb (Dauer unmittelbar VOR dieser Freigabe) gehört inhaltlich
  // zu An, gelb (unmittelbar NACH dieser Freigabe) zu Ab; tf (Gesamtdauer des
  // Grün-Segments) ist erst beim Abwurf "fertig" bekannt, daher bei Ab. An[k]
  // und ab[k] MÜSSEN NICHT vom selben Grün-Segment stammen, sobald ein
  // Umlauf für dieselbe Signalgruppe unterschiedlich viele An- wie Ab-
  // Ereignisse hat (siehe oben) - GZ.umlaufContext.buildAll() paart sie rein
  // über den Index k (n-tes An mit n-tem Ab, unabhängig von der Frage, ob sie
  // zum selben Grün-Segment gehören).
  function computeCycleSgEvents(segs, greens, cycleStarts, tMax) {
    const n = cycleStarts ? cycleStarts.length : 0;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = { an: [], ab: [] };
    if (n === 0) return out;
    const segIndexOfGreen = mapGreensToSegIndex(segs);

    // An-Seite: Sweep über greens nach .start (wie computeCycleSgMetrics).
    let ptrAn = 0;
    for (let i = 0; i < n; i++) {
      const start = cycleStarts[i];
      const end = i + 1 < n ? cycleStarts[i + 1] : tMax;
      while (ptrAn < greens.length && greens[ptrAn].start < start) ptrAn++;
      let j = ptrAn;
      while (j < greens.length && greens[j].start < end) {
        const seg = greens[j];
        const segIdx = segIndexOfGreen[j];
        const extra = segIdx != null ? adjacentTransitionDurations(segs, segIdx) : { rotgelb: 0, gelb: 0 };
        out[i].an.push({ value: Math.round((seg.start - start) / 1000), rotgelb: extra.rotgelb, segIdx, segStart: seg.start });
        j++;
      }
      ptrAn = j;
    }

    // Ab-Seite: EIGENER Sweep über dieselben greens, aber nach .end - greens
    // ist bereits nach .start UND .end aufsteigend (disjunkte Segmente einer
    // Zeitreihe), ein zweiter monoton fortschreitender Zeiger reicht daher
    // aus (kein erneutes Sortieren nötig).
    let ptrAb = 0;
    for (let i = 0; i < n; i++) {
      const start = cycleStarts[i];
      const end = i + 1 < n ? cycleStarts[i + 1] : tMax;
      while (ptrAb < greens.length && greens[ptrAb].end < start) ptrAb++;
      let j = ptrAb;
      while (j < greens.length && greens[j].end < end) {
        const seg = greens[j];
        const segIdx = segIndexOfGreen[j];
        const extra = segIdx != null ? adjacentTransitionDurations(segs, segIdx) : { rotgelb: 0, gelb: 0 };
        out[i].ab.push({ value: Math.round((seg.end - start) / 1000), tf: Math.round((seg.end - seg.start) / 1000), gelb: extra.gelb, segIdx, segEnd: seg.end });
        j++;
      }
      ptrAb = j;
    }

    return out;
  }

  // Ausgelöst/Anzahl-steigender-Flanken EINES Detektors/Werts für JEDEN
  // Umlauf - Grundlage der exprEngine-Primitiven Ausgeloest/
  // AnzahlAusloesungen. occupiedFlags: boolean[] parallel zu times (welche
  // Belegungsregel gilt, entscheidet der Aufrufer, z.B. GZ.wartezeitLogic.
  // wzIstBelegt - diese Funktion kennt nur Zeitpunkte, keine Rohwerte).
  function computeCycleDetMetrics(times, occupiedFlags, cycleStarts, tMax) {
    const n = cycleStarts ? cycleStarts.length : 0;
    const out = new Array(n);
    const edges = [];
    let prevBelegt = false;
    for (let k = 0; k < times.length; k++) {
      const belegt = occupiedFlags[k];
      if (belegt && !prevBelegt) edges.push(times[k]);
      prevBelegt = belegt;
    }
    let ptr = 0;
    for (let i = 0; i < n; i++) {
      const start = cycleStarts[i];
      const end = i + 1 < n ? cycleStarts[i + 1] : tMax;
      while (ptr < edges.length && edges[ptr] < start) ptr++;
      let count = 0, p2 = ptr;
      while (p2 < edges.length && edges[p2] < end) { count++; p2++; }
      out[i] = { triggered: count > 0, count };
    }
    return out;
  }

  function typicalCycleSegments(segs, stats) {
    if (stats.greens.length === 0) return [];
    const anomalies = GZ.stats.detectAnomalies(stats.greenDurations);
    let idx = anomalies.findIndex(a => !a);
    if (idx === -1 || idx >= stats.greens.length - 1) idx = 0;
    const cStart = stats.greens[idx].start;
    const cEnd = stats.greens[idx + 1] ? stats.greens[idx + 1].start : segs[segs.length - 1].end;
    return segs.filter(s => s.start >= cStart && s.start < cEnd);
  }

  // Liefert je Zyklus (parallel zu stats.greens/greenDurations), ob er als
  // auffällig gilt. ctx = {scope:'total'|'spl', splList, times, splValues} -
  // im SPL-Modus wird die Abweichung innerhalb jedes Signalprogramms separat
  // beurteilt (eigener Median/MAD je SPL), statt an einem gemeinsamen Median
  // über den gesamten Mitschnitt.
  function getFlaggedAnomalies(stats, ctx) {
    const gd = stats.greenDurations;
    if (!ctx || ctx.scope !== 'spl' || !ctx.splList || ctx.splList.length < 2 || !stats.bySpl) {
      return GZ.stats.detectAnomalies(gd);
    }
    const { times, splValues } = ctx;
    const splOf = stats.greens.map(g => findSplAt(g.start, times, splValues) || '(unbekannt)');
    const bySplIdx = new Map();
    splOf.forEach((spl, i) => {
      if (!bySplIdx.has(spl)) bySplIdx.set(spl, []);
      bySplIdx.get(spl).push(i);
    });
    const flags = new Array(gd.length).fill(false);
    bySplIdx.forEach(idxs => {
      const localFlags = GZ.stats.detectAnomalies(idxs.map(i => gd[i]));
      idxs.forEach((origI, k) => { flags[origI] = localFlags[k]; });
    });
    return flags;
  }

  // Median/MAD einer Signalgruppe innerhalb eines bestimmten SPL, aus
  // stats.bySpl - dieselbe Grundlage wie die Kennzahlen-Tabelle im SPL-Modus.
  function getSplGroupMed(stats, spl) {
    if (!stats._splMedCache) stats._splMedCache = new Map();
    if (stats._splMedCache.has(spl)) return stats._splMedCache.get(spl);
    const entry = stats.bySpl ? stats.bySpl.get(spl) : null;
    const gd = entry ? entry.greenDurations : [];
    let result = null;
    if (gd.length) {
      const med = median(gd);
      const madVal = median(gd.map(v => Math.abs(v - med))) || 0.001;
      result = { med, madVal };
    }
    stats._splMedCache.set(spl, result);
    return result;
  }

  // Zerlegt den sichtbaren Zeitraum [tMin,tMax] in zusammenhängende
  // Zeitfenster je aktivem SPL, jeweils mit dem für die GESAMTE Aufzeichnung
  // geltenden Median dieses Plans - so bekommt ein Plan, der zeitlich mehrfach
  // vorkommt, überall denselben Referenzwert, konsistent zur Kennzahlen-Tabelle.
  function computeTrendSplWindows(stats, ctx) {
    const { times, splValues, tMin, tMax } = ctx;
    if (!times || !splValues || !times.length) return null;

    let activeSpl = '';
    for (let i = 0; i < times.length; i++) {
      if (times[i] > tMin) break;
      if (splValues[i] !== '') activeSpl = splValues[i];
    }
    const transitions = computeSplTransitions(times, splValues).filter(tr => tr.t > tMin && tr.t <= tMax);
    const bounds = [tMin, ...transitions.map(tr => tr.t), tMax];
    const labels = [activeSpl || '(unbekannt)', ...transitions.map(tr => tr.to || '(unbekannt)')];
    if (bounds.length <= 2) return null;

    return bounds.slice(0, -1).map((segStart, i) => {
      const segEnd = bounds[i + 1];
      const spl = labels[i];
      const g = getSplGroupMed(stats, spl);
      return { segStart, segEnd, spl, med: g ? g.med : null, madVal: g ? g.madVal : null };
    }).filter(w => w.segEnd > w.segStart);
  }

  // Zeitbereiche der auffälligen Umläufe einer Signalgruppe (>3x MAD
  // Grünzeit-Abweichung), als Bänder für das Signalzeitendiagramm.
  function computeAnomalyBands(stats, cycleStarts, tMin, tMax, anomalyCtx) {
    const gd = stats.greenDurations;
    if (gd.length < 4) return [];
    const anomalies = getFlaggedAnomalies(stats, anomalyCtx);
    const bands = [];
    stats.greens.forEach((g, i) => {
      if (!anomalies[i]) return;
      if (cycleStarts && cycleStarts.length) {
        const r = findCycleRange(g.start, cycleStarts, tMin, tMax);
        if (r) bands.push(r);
      } else {
        const start = i > 0 ? stats.greens[i - 1].start : g.start;
        const end = stats.greens[i + 1] ? stats.greens[i + 1].start : g.end;
        bands.push({ start, end });
      }
    });
    return bands;
  }

  function wrapInterval(start, end, TU) {
    start = ((start % TU) + TU) % TU;
    end = ((end % TU) + TU) % TU;
    if (end > start) return [{ start, end }];
    if (end === start) return [{ start: 0, end: TU }];
    return [{ start, end: TU }, { start: 0, end }];
  }

  // Liefert eine "take(start,end)"-Funktion für einen Sweep über
  // sortedIntervals (aufsteigend nach .start, disjunkt/chronologisch wie
  // von buildSegments erzeugt): bei AUFSTEIGEND aufeinanderfolgenden,
  // nicht überlappenden Aufrufen (z. B. einmal je Umlauf in einer Schleife)
  // liefert take() die mit [start,end) überlappenden Einträge - amortisiert
  // O(n) über alle Aufrufe zusammen, statt O(n) Vollscan PRO Aufruf. Wird
  // gebraucht, sobald ein Vollscan pro Umlauf bei vielen Umläufen quadratisch
  // würde (siehe Umlaufprüfung bei großen Aufzeichnungen).
  function makeIntervalSweep(sortedIntervals) {
    let ptr = 0;
    return function take(start, end) {
      while (ptr < sortedIntervals.length && sortedIntervals[ptr].end <= start) ptr++;
      const out = [];
      let j = ptr;
      while (j < sortedIntervals.length && sortedIntervals[j].start < end) {
        if (sortedIntervals[j].end > start) out.push(sortedIntervals[j]);
        j++;
      }
      return out;
    };
  }

  // Wie makeIntervalSweep, liefert aber nur den ERSTEN Index eines Eintrags
  // mit start < end (oder -1) - für Fälle, in denen (wie bei stats.greens je
  // Umlauf) je Fenster höchstens ein Treffer erwartet wird und dessen
  // Original-Index gebraucht wird (z. B. für parallele Auffällig-Flags).
  function makeIndexSweep(sortedItems) {
    let ptr = 0;
    return function take(start, end) {
      while (ptr < sortedItems.length && sortedItems[ptr].start < start) ptr++;
      return (ptr < sortedItems.length && sortedItems[ptr].start < end) ? ptr : -1;
    };
  }

  // Punkt-Sweep: welches (einzelne) Segment enthält einen bestimmten
  // Zeitpunkt? Anders als makeIntervalSweep/-IndexSweep (Fenster-Overlap)
  // für punktuelle Nachschlagen gedacht - Formel-Builder-Primitiven
  // (Zustand/Dauer/DauerSeit) rufen advance(t) einmal je Zeile auf (t
  // aufsteigend, amortisiert O(n) wie die anderen Sweeps) und lesen danach
  // segment()/time() beliebig oft, ohne den Zeitpunkt erneut durchreichen zu
  // müssen. Segmente müssen wie von buildSegments() geliefert lückenlos/
  // nicht überlappend sein.
  function makePointSegmentSweep(segs) {
    let ptr = 0, curSeg = null, curT = null;
    return {
      advance(t) {
        curT = t;
        while (ptr < segs.length && segs[ptr].end <= t) ptr++;
        const s = segs[ptr];
        curSeg = (s && t >= s.start) ? s : null;
      },
      segment() { return curSeg; },
      time() { return curT; },
      // Setzt den Zeiger auf den Anfang zurück - nötig, wenn derselbe Sweep
      // (z.B. dasselbe Objekt-Handle in formulaBuilder.js) für MEHRERE
      // aufeinanderfolgende Durchläufe über dieselbe (aufsteigende) Zeitreihe
      // wiederverwendet wird (eine Formel pro Durchlauf) - ohne reset() bliebe
      // der Zeiger vom vorherigen Durchlauf am Ende stehen und jeder weitere
      // Durchlauf würde fälschlich "kein Segment" liefern.
      reset() { ptr = 0; curSeg = null; curT = null; }
    };
  }

  GZ.segments = {
    buildSegments, computeCycleStats, computeCycleStatsBySpl,
    findSplAt, makeRawValueSampler, makeSegmentDurationSampler, computeSplTransitions, computeGlobalTU,
    findEnclosingCycleStart, findCycleRange, computeSegmentAnAbTf, computeSignalplanRow,
    mapGreensToSegIndex, adjacentTransitionDurations, computeCycleSgMetrics, computeCycleSgEvents, computeCycleDetMetrics,
    typicalCycleSegments, getFlaggedAnomalies, getSplGroupMed, computeTrendSplWindows,
    computeAnomalyBands, wrapInterval, makeIntervalSweep, makeIndexSweep, makePointSegmentSweep
  };
})(window.GZ = window.GZ || {});
