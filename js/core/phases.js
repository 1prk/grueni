/* GZ.phases — Phaseneinteilung einer Lichtsignalanlage (RiLSA): eine Phase
   fasst die Signalgruppen zusammen, die GLEICHZEITIG Grün (Freigabe) zeigen
   und damit keinen Verkehrskonflikt miteinander haben. Ein Signalprogramm
   durchläuft je Umlauf eine feste Phasenfolge, getrennt durch Zwischenzeiten
   - zwei Phasen sind daher per Definition nie gleichzeitig aktiv. Diese
   Datei leitet aus den bereits vorhandenen Grünsegmenten (stats.greens je
   Mitglieds-Signalgruppe) ab, WANN eine definierte Phase in der Aufzeichnung
   tatsächlich vollständig angezeigt wurde - reine Auswertungslogik,
   unabhängig vom DOM. */
(function (GZ) {
  'use strict';

  // Kategoriale Farbpalette je Phase (Reihenfolge = Definitionsreihenfolge in
  // GZ.state.data.phases) - bewusst von den Signalfarben (--sig-*) abgesetzt,
  // damit auf den ersten Blick klar ist: das sind Phasen-Identitäten, keine
  // Ampel-Zustände.
  const PHASE_COLORS = [
    '#3b7dc4', '#e08a2f', '#6c4fb0', '#2fa393',
    '#c2517a', '#8a9a2f', '#b8464a', '#4f7942',
    '#a3762f', '#4a5a8a'
  ];
  function colorForIndex(i) { return PHASE_COLORS[i % PHASE_COLORS.length]; }

  // Schnittmenge mehrerer sortierter, disjunkter Intervall-Listen (z. B.
  // stats.greens je Mitglieds-Signalgruppe): liefert die Zeitbereiche, in
  // denen ALLE Listen gleichzeitig ein Intervall abdecken - Sweep-Line über
  // Start(+1)/Ende(-1)-Ereignisse, O(m log m) bei m = Summe aller Intervalle.
  function intersectIntervals(intervalLists) {
    const n = intervalLists.length;
    if (n === 0) return [];
    const events = [];
    for (const list of intervalLists) {
      for (const iv of list) {
        events.push([iv.start, 1]);
        events.push([iv.end, -1]);
      }
    }
    if (events.length === 0) return [];
    // Bei gleichem Zeitpunkt zuerst Enden (-1), dann Beginne (+1) verarbeiten,
    // damit exakt aneinandergrenzende Intervalle nicht als Überlappung zählen.
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let count = 0, activeStart = null;
    const result = [];
    for (const [t, delta] of events) {
      const before = count;
      count += delta;
      if (before < n && count === n) activeStart = t;
      else if (before === n && count < n && activeStart != null) {
        if (t > activeStart) result.push({ start: activeStart, end: t });
        activeStart = null;
      }
    }
    return result;
  }

  // Vereinigung mehrerer sortierter, disjunkter Intervall-Listen: liefert die
  // Zeitbereiche, in denen MINDESTENS EINE Liste ein Intervall abdeckt -
  // gleiches Sweep-Line-Prinzip wie intersectIntervals oben, nur mit
  // "count > 0" statt "count === n" als Aktiv-Bedingung. Wird gebraucht, um
  // GENAU jene Zeiten zu ermitteln, in denen irgendeine NICHT zur Phase
  // gehörende Signalgruppe grün ist (siehe computePhaseOccurrences unten).
  function unionIntervals(intervalLists) {
    const events = [];
    for (const list of intervalLists) {
      for (const iv of list) {
        events.push([iv.start, 1]);
        events.push([iv.end, -1]);
      }
    }
    if (events.length === 0) return [];
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let count = 0, activeStart = null;
    const result = [];
    for (const [t, delta] of events) {
      const before = count;
      count += delta;
      if (before === 0 && count > 0) activeStart = t;
      else if (before > 0 && count === 0) { result.push({ start: activeStart, end: t }); activeStart = null; }
    }
    return result;
  }

  // Entfernt aus einer sortierten, disjunkten Intervall-Liste (base) alle
  // Zeitbereiche, die in einer zweiten sortierten, disjunkten Liste (remove)
  // liegen - Zwei-Zeiger-Verfahren, O(base + remove). Wird von
  // computePhaseOccurrences genutzt, um aus dem "Mitglieder alle grün"-
  // Zeitraum jene Abschnitte herauszuschneiden, in denen gleichzeitig eine
  // NICHT zur Phase gehörende Signalgruppe ebenfalls grün ist (eine Phase
  // gilt nur dann als angezeigt, wenn wirklich NUR ihre Mitglieder grün
  // sind - sonst wäre eine Phase, deren Mitgliederliste eine Teilmenge einer
  // anderen Phase ist, immer auch während dieser anderen Phase "aktiv").
  function subtractIntervals(base, remove) {
    if (!remove.length) return base;
    const result = [];
    let ri = 0;
    for (const b of base) {
      let curStart = b.start;
      const curEnd = b.end;
      while (ri < remove.length && remove[ri].end <= curStart) ri++;
      let j = ri;
      while (curStart < curEnd && j < remove.length && remove[j].start < curEnd) {
        const r = remove[j];
        if (r.start > curStart) result.push({ start: curStart, end: Math.min(r.start, curEnd) });
        curStart = Math.max(curStart, r.end);
        j++;
      }
      if (curStart < curEnd) result.push({ start: curStart, end: curEnd });
    }
    return result;
  }

  function nextDefaultLabel(existingPhases) {
    const n = existingPhases.length + 1;
    return { name: `Phase ${n}`, kuerzel: `Ph${n}` };
  }

  let phaseIdSeq = 1;
  function createPhase(existingPhases) {
    const { name, kuerzel } = nextDefaultLabel(existingPhases);
    return { id: 'ph' + (phaseIdSeq++), name, kuerzel, members: new Set() };
  }

  // Wie createPhase(), aber mit vorgegebenem Kürzel/Name/Mitgliedern (aus
  // einer geladenen Konfigurationsdatei, siehe stammdatenLsa.js
  // loadConfigFile()) statt automatisch vergebenen Standardwerten - nutzt
  // denselben phaseIdSeq-Zähler, damit die neu erzeugten IDs garantiert
  // nicht mit während dieser Sitzung bereits vorhandenen Phasen kollidieren.
  function createPhaseFromConfig(kuerzel, name, members) {
    return { id: 'ph' + (phaseIdSeq++), name, kuerzel, members: members instanceof Set ? members : new Set(members) };
  }

  // Zeitbereiche, in denen eine Phase tatsächlich vollständig angezeigt
  // wurde: alle Mitglieder gleichzeitig Grün UND KEINE nicht zur Phase
  // gehörende Signalgruppe gleichzeitig Grün. Der zweite Teil ist nötig,
  // sonst wäre jede Phase, deren Mitgliederliste eine Teilmenge einer
  // anderen Phase ist (z. B. Phase A = {K1,K2,K3,F1,F2}, Phase B =
  // {K1,K3,F1,F2}), automatisch auch während jener anderen Phase "aktiv" -
  // die Bedingung von B wäre ja immer schon erfüllt, wenn A erfüllt ist,
  // ohne dass B das je von A unterscheiden könnte (K2 wird von B schlicht
  // nicht betrachtet). Beide Phasen würden sich dann in der kombinierten
  // Phasenspur überlappen, obwohl Phasen per Definition nie gleichzeitig
  // aktiv sein können (siehe Kopfkommentar dieser Datei).
  function computePhaseOccurrences(phase, allStats) {
    const memberGreens = [], nonMemberGreens = [];
    allStats.forEach(entry => {
      (phase.members.has(entry.col.index) ? memberGreens : nonMemberGreens).push(entry.stats.greens);
    });
    const allMembersGreen = phase.members.size ? intersectIntervals(memberGreens) : [];
    const intervals = allMembersGreen.length ? subtractIntervals(allMembersGreen, unionIntervals(nonMemberGreens)) : [];
    return { phase, intervals };
  }

  // Baut aus mehreren Phasen-Vorkommenslisten EINE gemeinsame, lückenlose
  // Segment-Reihe für die kombinierte Zeitleiste (eine Spur für alle
  // Phasen): da Phasen per Definition nie gleichzeitig aktiv sind, genügt
  // Zusammenführen + Sortieren; Lücken (kein Phasen-Vorkommen, z. B.
  // Zwischenzeiten oder nicht abgedeckte Zustände) werden als eigene
  // Kategorie 'NONE' aufgefüllt. cat trägt die Phasen-ID (oder 'NONE').
  function buildCombinedSegments(occurrenceEntries, tMin, tMax) {
    const all = [];
    occurrenceEntries.forEach(({ phase, intervals }) => {
      intervals.forEach(iv => all.push({ cat: phase.id, start: iv.start, end: iv.end }));
    });
    all.sort((a, b) => a.start - b.start);
    const segs = [];
    let cursor = tMin;
    all.forEach(seg => {
      if (seg.start > cursor) segs.push({ cat: 'NONE', start: cursor, end: seg.start });
      segs.push(seg);
      if (seg.end > cursor) cursor = seg.end;
    });
    if (cursor < tMax) segs.push({ cat: 'NONE', start: cursor, end: tMax });
    return segs;
  }

  /* ---------------- Phasenübergänge (PÜ) ----------------
     Diese Sektion gehört sowohl der Phasenspur in Umlaufprüfung (Anzeige)
     als auch dem PÜ-Werkzeug in Stammdaten LSA (Bearbeitung) - deshalb hier
     als gemeinsame, view-unabhängige Grundlage statt in einer der beiden
     Ansichten. Reine Auswertungs-/Datenlogik: nimmt GZ.state.data.
     pueOverrides (falls benötigt) immer als expliziten Parameter entgegen,
     statt selbst auf den globalen Zustand zuzugreifen. */

  // Name für eine inferierte Phasenübergang-Lücke aus den Kürzeln der beiden
  // angrenzenden Phasen: enden beide auf eine Zahl (Standard-Kürzel "PhN"),
  // kurz als "PÜ<n1>.<n2>" (z.B. "PÜ1.2"); sonst robust als "PÜ k1→k2", damit
  // frei benannte Kürzel nicht zu einem unsinnigen Text zusammengequetscht
  // werden.
  function pueLabelFor(k1, k2) {
    const m1 = /(\d+)\s*$/.exec(k1), m2 = /(\d+)\s*$/.exec(k2);
    return (m1 && m2) ? `PÜ${m1[1]}.${m2[1]}` : `PÜ ${k1}→${k2}`;
  }

  // Wie buildCombinedSegments(), aber Lücken (cat 'NONE') zusätzlich mit den
  // beiden unmittelbar angrenzenden ECHTEN Phasen annotiert (seg.pueLabel,
  // seg.pueFromPhaseId/-ToPhaseId) statt anonym zu bleiben - Grundlage für
  // die Phasenspur (Balken + Klick zum Aufklappen) in Umlaufprüfung. Ohne
  // Nachbar auf einer Seite (Aufzeichnungsrand, nie erkannte Phase) bleiben
  // alle drei Felder null.
  function buildAnnotatedSegments(occurrenceEntries, tMin, tMax) {
    const phaseById = new Map(occurrenceEntries.map(e => [e.phase.id, e.phase]));
    const segs = buildCombinedSegments(occurrenceEntries, tMin, tMax);
    segs.forEach((seg, i) => {
      if (seg.cat !== 'NONE') return;
      const prevPhase = i > 0 ? phaseById.get(segs[i - 1].cat) : null;
      const nextPhase = i < segs.length - 1 ? phaseById.get(segs[i + 1].cat) : null;
      seg.pueLabel = (prevPhase && nextPhase) ? pueLabelFor(prevPhase.kuerzel, nextPhase.kuerzel) : null;
      seg.pueFromPhaseId = prevPhase ? prevPhase.id : null;
      seg.pueToPhaseId = nextPhase ? nextPhase.id : null;
    });
    return segs;
  }

  // Alle TATSÄCHLICH in der Aufzeichnung vorkommenden Übergangstypen (je
  // Phasen-ID-Paar genau einmal) - Grundlage für die Liste im PÜ-Werkzeug
  // (Stammdaten LSA): nur Übergänge anbieten, die es in den Rohdaten auch
  // wirklich gibt, nicht jede denkbare Kombination aus der Phasenliste. Je
  // Übergangstyp wird bewusst das Vorkommen NAHE DER MITTE der Aufzeichnung
  // gemerkt (kleinster Abstand zu (tMin+tMax)/2), NICHT das buchstäblich
  // erste - eine Aufzeichnung beginnt in der Praxis oft während einer
  // Anlauf-/Dunkelphase (Signalgeber aus, Anlage noch nicht im Regelbetrieb),
  // und genau dort läge das allererste Vorkommen jedes Übergangstyps, mit
  // entsprechend untypischen/unbrauchbaren An/Ab-Werten im PÜ-Werkzeug.
  function listDistinctTransitions(occurrenceEntries, tMin, tMax) {
    const segs = buildAnnotatedSegments(occurrenceEntries, tMin, tMax);
    const mid = (tMin + tMax) / 2;
    const seen = new Map();
    segs.forEach(seg => {
      if (seg.cat !== 'NONE' || !seg.pueFromPhaseId || !seg.pueToPhaseId) return;
      const key = seg.pueFromPhaseId + '→' + seg.pueToPhaseId;
      const dist = Math.abs(seg.start - mid);
      const cur = seen.get(key);
      if (!cur || dist < cur.dist) {
        seen.set(key, { fromPhaseId: seg.pueFromPhaseId, toPhaseId: seg.pueToPhaseId, label: seg.pueLabel, sampleOccurrence: { start: seg.start, end: seg.end }, dist });
      }
    });
    return [...seen.values()].map(({ dist, ...rest }) => rest);
  }

  // Umlaufindex, in dem der Zeitpunkt t liegt (letzter cycleStarts-Eintrag
  // <= t) - wandelt eine absolute Zeit (z.B. listDistinctTransitions()'
  // sampleOccurrence.start) in den cycleIdx um, den autoDetectPueRows()/
  // realCycleMetricsForSg() erwarten. -1, wenn t vor dem ersten Umlauf liegt.
  function cycleIdxAtTime(t, cycleStarts) {
    if (!cycleStarts || !cycleStarts.length) return -1;
    let idx = -1;
    for (let i = 0; i < cycleStarts.length; i++) {
      if (cycleStarts[i] <= t) idx = i; else break;
    }
    return idx;
  }

  // sgIndex ist hier IMMER der rohe CSV-Spaltenindex (col.index, wie in
  // phase.members - siehe stammdatenLsa.js data-member="${col.index}"),
  // NICHT die Position in allStats (die zählt SG-Spalten separat durch -
  // dieselbe Unterscheidung wie schon in computePhaseOccurrences() oben).
  function findSgEntryByColIndex(sgIndex, a) { return a.allStats.find(s => s.col.index === sgIndex); }

  // Reale An/Ab/TF/Rotgelb/Gelb-Werte EINER Signalgruppe für EINEN Umlauf -
  // dieselbe Grundlage wie die umlaufweisen exprEngine-Primitiven/Kennzahlen
  // (GZ.segments.computeCycleSgMetrics), hier aber für eine beliebige, ggf.
  // gerade nicht angehakte Signalgruppe auf Abruf berechnet (Phasenmitglieder
  // sind unabhängig von jeder Objekt-Auswahl in einer Ansicht).
  function realCycleMetricsForSg(sgIndex, cycleIdx, a, TU_MED) {
    const entry = findSgEntryByColIndex(sgIndex, a);
    if (!entry) return null;
    const metrics = GZ.segments.computeCycleSgMetrics(entry.segs, entry.stats.greens, a.cycleStarts, a.tMax, TU_MED);
    return metrics[cycleIdx] || null;
  }

  // Spätestes Intervallende einer Phase (computePhaseOccurrences), das noch
  // in [cycleStart, cycleEnd] liegt - die tatsächliche, "wie von der
  // Phasendefinition selbst bestimmte" Grenze, an der ein Phasen-Vorkommen
  // endet (siehe dortigen Kopfkommentar: alle Mitglieder grün UND alle
  // Nicht-Mitglieder rot). Grundlage der PÜ-Referenz unten - bewusst NICHT
  // separat aus den Ab-Werten einzelner Signalgruppen neu hergeleitet (siehe
  // dort), da das Vorkommen genauso gut durch eine anwerfende Signalgruppe
  // beendet werden kann, die vorzeitig nicht mehr rot ist (Rotgelb), nicht
  // nur durch eine abwerfende, die grün verlässt.
  function phaseOccurrenceEndInCycle(phase, allStats, cycleStart, cycleEnd) {
    const { intervals } = computePhaseOccurrences(phase, allStats);
    let best = null;
    intervals.forEach(iv => { if (iv.end > cycleStart && iv.end <= cycleEnd && (best == null || iv.end > best)) best = iv.end; });
    return best;
  }

  // "An" bezeichnet im PÜ-Werkzeug bewusst NICHT den Beginn des eigentlichen
  // Grüns (cm.an - das erste sichtbare Signal wäre dann schon vorbei),
  // sondern den Rot→Gelb-Wechsel (Beginn Rotgelb) davor - das ist der
  // Moment, an dem sich für die anwerfende Signalgruppe überhaupt etwas
  // ändert. Ohne erkanntes Rotgelb (cm.rotgelb=0, z.B. Datenlücke) fällt das
  // mit cm.an zusammen.
  function rotgelbStartSec(cm) { return cm.an - (cm.rotgelb || 0); }

  // Sucht in den ROHEN Segmenten EINER Signalgruppe das für einen
  // bestimmten Übergangs-Anker (referenceAbsMs, die TX=0-Referenz DIESES
  // Übergangs) tatsächlich relevante GRUEN-Segment - bewusst NICHT über ein
  // Umlauf-Fenster (cycleIdx, wie GZ.segments.computeCycleSgMetrics),
  // sondern direkt über den Anker selbst: eine Signalgruppe kann innerhalb
  // EINES Umlaufs mehrfach grün sein (z.B. verkehrsabhängige/mehrstufige
  // Freigaben), ein Umlauf-Fenster träfe dann leicht das FALSCHE Vorkommen
  // (führte zu unsinnigen negativen An/Ab-Werten und falschen Nachbar-
  // segmenten im Balken). role='outgoing': das Segment, das den Anker
  // enthält (diese Signalgruppe MUSS laut Phasendefinition zu diesem
  // Zeitpunkt noch grün sein, siehe computePhaseOccurrences) - ohne
  // Treffer ersatzweise das zuletzt VOR dem Anker endende. role='incoming':
  // das mit dem frühesten Start AB dem Anker (diese Signalgruppe MUSS laut
  // Phasendefinition bis dahin rot gewesen sein, siehe dort "alle
  // Nicht-Mitglieder rot"). null, wenn keine passende Signalgruppe/kein
  // passendes Segment existiert.
  function findAnchoredGreenSegIdx(entry, anchorAbsMs, role) {
    const segs = entry.segs;
    if (role === 'outgoing') {
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (s.cat === 'GRUEN' && s.start <= anchorAbsMs && s.end >= anchorAbsMs) return i;
      }
      let bestIdx = null, bestEnd = -Infinity;
      segs.forEach((s, i) => { if (s.cat === 'GRUEN' && s.end <= anchorAbsMs && s.end > bestEnd) { bestEnd = s.end; bestIdx = i; } });
      return bestIdx;
    }
    let bestIdx = null, bestStart = Infinity;
    segs.forEach((s, i) => { if (s.cat === 'GRUEN' && s.start >= anchorAbsMs && s.start < bestStart) { bestStart = s.start; bestIdx = i; } });
    return bestIdx;
  }

  // Kennzahlen (an/ab in echten Sekunden relativ zu referenceAbsMs statt
  // relativ zum Umlaufbeginn, dazu tf/rotgelb/gelb/segIdx/segStart/segEnd)
  // für EIN per findAnchoredGreenSegIdx() gefundenes GRUEN-Segment -
  // dieselben Felder wie GZ.segments.computeCycleSgMetrics, aber ohne
  // dessen Umlauf-Fenster-Bindung und ohne die dortige TU-Modulo-Rundung
  // (hier unnötig, da direkt an absoluten Rohzeiten gerechnet wird).
  function metricsForAnchoredSeg(entry, role, anchorAbsMs, referenceAbsMs) {
    const segIdx = findAnchoredGreenSegIdx(entry, anchorAbsMs, role);
    if (segIdx == null) return null;
    const seg = entry.segs[segIdx];
    const extra = GZ.segments.adjacentTransitionDurations(entry.segs, segIdx);
    return {
      an: (seg.start - referenceAbsMs) / 1000, ab: (seg.end - referenceAbsMs) / 1000,
      tf: (seg.end - seg.start) / 1000, rotgelb: extra.rotgelb, gelb: extra.gelb,
      segIdx, segStart: seg.start, segEnd: seg.end
    };
  }

  // Wie metricsForAnchoredSeg(), aber die role (outgoing/incoming) wird aus
  // der Zeile selbst abgeleitet (ab gesetzt -> outgoing, an gesetzt ->
  // incoming) statt separat übergeben zu werden müssen - für die
  // Balken-Darstellung in Stammdaten LSA/Umlaufprüfung (siehe dort
  // buildLocalRowSegs/applyRowOverrideToLocalSegs), wo nur die Zeile
  // bekannt ist. anchorAbsMs bleibt bewusst IMMER referenceAbsMs (die feste
  // TX=0-Referenz DIESES Übergangs, unabhängig von einer eventuellen
  // manuellen Korrektur der Zeilenwerte) - das reale Segment bleibt so am
  // tatsächlichen Übergang verankert, auch wenn die angezeigte Zahl
  // überschrieben wurde. null ohne eindeutige Rolle (z.B. eine frei
  // hinzugefügte Zeile ohne Wert oder eine "immer an"-Zeile).
  function cmForRow(row, referenceAbsMs, a) {
    const entry = findSgEntryByColIndex(row.sgIndex, a);
    if (!entry) return null;
    const role = row.ab != null ? 'outgoing' : (row.an != null ? 'incoming' : null);
    if (!role) return null;
    return metricsForAnchoredSeg(entry, role, referenceAbsMs, referenceAbsMs);
  }

  // TF (Freigabezeit) RELATIV ZUM ÜBERGANG selbst: wie viel echte Grünzeit
  // dieser Zeile innerhalb des definierten Übergangsfensters [startSec,
  // endSec] liegt - NICHT die volle reale Dauer der zugrundeliegenden
  // Freigabe (die erstreckt sich für eine abwerfende/anwerfende Zeile
  // typischerweise weit VOR bzw. NACH diesem Übergang und gehört nicht zu
  // ihm - z.B. die gesamte Grünzeit der vorherigen/nächsten Phase). Eine
  // abwerfende Zeile (nur Ab gesetzt) "beginnt" ihr Grün unbekannt weit vor
  // dem Fenster (auf startSec geklemmt); eine anwerfende Zeile (nur An
  // gesetzt) "endet" ihr Grün unbekannt weit nach dem Fenster (auf endSec
  // geklemmt) - deren realer Grünbeginn liegt bei An + Rotgelb-Dauer
  // (cm.rotgelb), nicht bei An selbst (siehe rotgelbStartSec). Beispiel:
  // An=5, Rotgelb=1s, Ende=8 -> Grünbeginn=6, TF=8-6=2. Ohne jeden Wert
  // (weder An noch Ab, z.B. eine frisch hinzugefügte, noch leere Zeile) ist
  // TF nicht definiert (null).
  function computeRowTf(row, cm, startSec, endSec) {
    if (row.an == null && row.ab == null) return null;
    const endAnchor = endSec != null ? endSec : startSec;
    const rotgelb = cm && Number.isFinite(cm.rotgelb) ? cm.rotgelb : 0;
    const greenStart = Math.max(row.an != null ? row.an + rotgelb : startSec, startSec);
    const greenEnd = Math.min(row.ab != null ? row.ab : endAnchor, endAnchor);
    return Math.round(Math.max(0, greenEnd - greenStart));
  }

  // Kanonische Sortierreihenfolge für Signalgruppennamen: K vor R vor F vor
  // S, innerhalb einer Gruppe numerisch aufsteigend (K1, K2, ..., Kn) - für
  // die PÜ-Zeilenreihenfolge (siehe autoDetectPueRows unten) und die
  // SG-Auswahllisten in Stammdaten LSA. Andere/unbekannte Präfixe (z.B.
  // Sonderbezeichnungen wie "DF1") fallen alphabetisch ans Ende, statt die
  // Sortierung zu erraten.
  const SG_PREFIX_ORDER = { K: 0, R: 1, F: 2, S: 3 };
  function compareSgNames(nameA, nameB) {
    const parse = n => { const m = /^([A-Za-z]+)(\d+)$/.exec(n || ''); return m ? [m[1].toUpperCase(), Number(m[2])] : null; };
    const pa = parse(nameA), pb = parse(nameB);
    const rankA = pa && SG_PREFIX_ORDER[pa[0]] != null ? SG_PREFIX_ORDER[pa[0]] : 99;
    const rankB = pb && SG_PREFIX_ORDER[pb[0]] != null ? SG_PREFIX_ORDER[pb[0]] : 99;
    if (rankA !== rankB) return rankA - rankB;
    if (rankA !== 99) return pa[1] - pb[1];
    return (nameA || '').localeCompare(nameB || '');
  }

  // Automatisch erkannte PÜ-Zeilen für EIN Vorkommen (fromPhase/toPhase in
  // GENAU diesem Umlauf): eine Zeile je Mitglied der abwerfenden Phase (nur
  // Ab gesetzt) bzw. der anwerfenden Phase (nur An gesetzt, siehe
  // rotgelbStartSec oben), relativ zu dem Zeitpunkt, an dem das Vorkommen
  // der abwerfenden Phase selbst endet (= die "TX=0"-Referenz dieses
  // Übergangs, siehe phaseOccurrenceEndInCycle oben) - das ist per
  // Definition "die Signalgruppe, die als erste (innerhalb der abwerfenden
  // Phase) endet", denn genau das lässt das Vorkommen enden. Bewusst NICHT
  // als Math.min() über nur die individuell "abwerfenden" (nicht auch zur
  // anwerfenden Phase gehörenden) Mitglieder neu berechnet: das würde sowohl
  // gemeinsame Mitglieder (die laut Phasendefinition ebenso zur abwerfenden
  // Phase zählen) als auch ein vorzeitiges Rotgelb einer anwerfenden
  // Signalgruppe übersehen - beides kann das Vorkommen schon vor dem
  // Ab-Wechsel jeder "echt abwerfenden" Signalgruppe beenden. Ein Mitglied,
  // das in BEIDEN Phasen steht (bleibt über den Übergang hinweg durchgehend
  // grün), wird als ZEILE dennoch weder als "endend" noch als "beginnend"
  // geführt - es engagiert/disengagiert an diesem Übergang schlicht nicht
  // (sonst würde ein und dieselbe reale Grünzeit fälschlich gleichzeitig als
  // An- UND Ab-Ereignis dieses Übergangs erscheinen); es zählt nur
  // (indirekt, über phaseOccurrenceEndInCycle) zur Referenzzeit-Bestimmung
  // mit. null, wenn in diesem Umlauf kein Vorkommen der abwerfenden Phase
  // endet (z.B. Datenlücke) - dann gibt es nichts, worauf sich die Spanne
  // beziehen könnte.
  function autoDetectPueRows(fromPhase, toPhase, cycleIdx, a, TU_MED) {
    // K vor R vor F vor S, je Gruppe numerisch (siehe compareSgNames oben) -
    // Ausgangs- und Eingangs-Mitglieder getrennt sortiert (die strukturelle
    // Gruppierung "erst alle abwerfenden, dann alle anwerfenden Zeilen"
    // bleibt erhalten).
    const nameOfSg = idx => { const e = findSgEntryByColIndex(idx, a); return e ? e.col.name : ''; };
    const outgoingIdx = [...fromPhase.members].filter(idx => !toPhase.members.has(idx)).sort((x, y) => compareSgNames(nameOfSg(x), nameOfSg(y)));
    const incomingIdx = [...toPhase.members].filter(idx => !fromPhase.members.has(idx)).sort((x, y) => compareSgNames(nameOfSg(x), nameOfSg(y)));
    const cycleStart = a.cycleStarts[cycleIdx];
    const cycleEnd = cycleIdx + 1 < a.cycleStarts.length ? a.cycleStarts[cycleIdx + 1] : a.tMax;
    const gapStartAbsMs = phaseOccurrenceEndInCycle(fromPhase, a.allStats, cycleStart, cycleEnd);
    if (gapStartAbsMs == null) return null;
    const referenceSec = (gapStartAbsMs - cycleStart) / 1000;
    // Ab hier direkt an gapStartAbsMs (= referenceAbsMs) verankert statt an
    // cycleIdx - siehe findAnchoredGreenSegIdx oben.
    const outgoing = outgoingIdx.map(sgIndex => {
      const entry = findSgEntryByColIndex(sgIndex, a);
      return { sgIndex, cm: entry ? metricsForAnchoredSeg(entry, 'outgoing', gapStartAbsMs, gapStartAbsMs) : null };
    });
    const incoming = incomingIdx.map(sgIndex => {
      const entry = findSgEntryByColIndex(sgIndex, a);
      return { sgIndex, cm: entry ? metricsForAnchoredSeg(entry, 'incoming', gapStartAbsMs, gapStartAbsMs) : null };
    });
    const rows = [];
    outgoing.forEach(o => { if (o.cm && Number.isFinite(o.cm.ab)) rows.push({ sgIndex: o.sgIndex, an: null, ab: Math.round(o.cm.ab) }); });
    // Übergangsende = die zuletzt (spätest) ins ECHTE GRÜN kommende
    // Signalgruppe der anwerfenden Phase (cm.an, NICHT deren früherer
    // Rotgelb-Start - siehe rotgelbStartSec/"An" oben) - per Definition das
    // Gegenstück zum Start (frühestes Ende der abwerfenden Phase). Bewusst
    // unabhängig von den Zeilenwerten gehalten (nicht aus rows[].an
    // hergeleitet), da "An" jetzt den früheren Rotgelb-Start zeigt.
    const greenArrivalSecs = [];
    incoming.forEach(o => {
      if (o.cm && Number.isFinite(o.cm.an)) {
        rows.push({ sgIndex: o.sgIndex, an: Math.round(rotgelbStartSec(o.cm)), ab: null });
        greenArrivalSecs.push(o.cm.an);
      }
    });
    const endSec = greenArrivalSecs.length ? Math.round(Math.max(...greenArrivalSecs)) : null;
    return { referenceSec, rows, endSec };
  }

  function pueOverrideKey(fromPhaseId, toPhaseId) { return fromPhaseId + '→' + toPhaseId; }

  // Aufgelöste Zeilenliste für das PÜ-Werkzeug: eine manuelle Korrektur
  // (siehe pueOverrides, je PHASENÜBERGANGSTYP - Bearbeitung in Stammdaten
  // LSA) hat Vorrang vor der automatischen Erkennung, gilt dann aber für
  // JEDES Vorkommen dieses Übergangs identisch (dieselben Zahlen,
  // unabhängig vom Umlauf) - die Referenzzeit für eine Balken-Darstellung
  // bleibt trotzdem live je Umlauf berechnet (siehe Aufrufer), damit ein
  // Balken immer die ECHTEN Rohdaten des jeweils gezeigten Umlaufs nutzt,
  // auch wenn die Tabellenwerte manuell überschrieben sind (so lässt sich
  // eine Korrektur visuell gegen die Realität prüfen statt blind zu
  // vertrauen).
  // startSec/endSec begrenzen den Übergang selbst (siehe Kopfkommentar
  // autoDetectPueRows): startSec ist FEST 0 (== referenceSec, der früheste
  // Ab-Wechsel auf Gelb der abwerfenden Phase - per Definition, nie
  // überschreibbar). endSec ist das späteste ECHTE Grün der anwerfenden
  // Phase (auto.endSec, siehe dort) - bewusst NICHT aus rows[].an
  // hergeleitet (das zeigt seit der Rotgelb-Umstellung einen FRÜHEREN
  // Zeitpunkt, siehe rotgelbStartSec), sondern immer frisch aus den echten
  // Rohdaten dieses Umlaufs berechnet, sofern pueOverrides.endSec es nicht
  // explizit fest vorgibt (siehe setPueOverrideEndSec unten) - z.B. um den
  // Übergang bewusst weiter zu fassen, als es die Rohdaten hergeben.
  function resolvePueRows(fromPhase, toPhase, cycleIdx, a, TU_MED, pueOverrides) {
    const auto = autoDetectPueRows(fromPhase, toPhase, cycleIdx, a, TU_MED);
    const override = pueOverrides ? pueOverrides[pueOverrideKey(fromPhase.id, toPhase.id)] : null;
    const rows = override ? override.rows : (auto ? auto.rows : []);
    return {
      referenceSec: auto ? auto.referenceSec : null,
      rows,
      startSec: 0,
      endSec: (override && override.endSec != null) ? override.endSec : (auto ? auto.endSec : null),
      overridden: !!override
    };
  }

  // Mutations-Helfer für pueOverrides - nehmen das Objekt (GZ.state.data.
  // pueOverrides) immer explizit entgegen und mutieren es in place, statt
  // selbst auf GZ.state zuzugreifen (siehe Sektions-Kopfkommentar); der
  // Aufrufer (Stammdaten LSA) ist für das Neu-Rendern nach der Mutation
  // zuständig. ensurePueOverride() legt bei Bedarf eine Korrektur an - mit
  // den aktuell ANGEZEIGTEN Zeilen (seedRows) als Startpunkt, damit ein
  // einzelnes Feld-Edit nicht die übrigen, bislang nur automatisch
  // erkannten Zeilen verliert - idempotent, ändert eine bereits vorhandene
  // Korrektur nicht erneut.
  function ensurePueOverride(pueOverrides, fromPhaseId, toPhaseId, seedRows) {
    const key = pueOverrideKey(fromPhaseId, toPhaseId);
    if (!pueOverrides[key]) pueOverrides[key] = { rows: seedRows.map(r => ({ ...r })) };
    return pueOverrides[key];
  }
  function setPueOverrideRowField(pueOverrides, fromPhaseId, toPhaseId, rowIdx, field, value, seedRows) {
    const ov = ensurePueOverride(pueOverrides, fromPhaseId, toPhaseId, seedRows);
    const row = ov.rows[rowIdx];
    if (!row) return;
    row[field] = value;
    // Ein echter An-/Ab-Wert widerspricht "durchgehend an" (siehe
    // setPueOverrideRowAlways) - ein Feld-Edit hebt die Markierung auf.
    if ((field === 'an' || field === 'ab') && value != null) row.always = false;
  }
  function addPueOverrideRow(pueOverrides, fromPhaseId, toPhaseId, seedRows, sgIndex) {
    ensurePueOverride(pueOverrides, fromPhaseId, toPhaseId, seedRows).rows.push({ sgIndex, an: null, ab: null, always: false });
  }
  // Markiert/entmarkiert eine Zeile als "durchgehend an" (weder An- noch
  // Ab-Ereignis - z.B. eine Signalgruppe, die laut Anlage über diesen
  // Übergang hinweg dauerhaft grün bleiben soll, aber (anders als ein
  // automatisch erkanntes gemeinsames Mitglied, siehe autoDetectPueRows)
  // hier explizit zu Dokumentationszwecken aufgeführt werden soll) - setzt
  // an/ab dabei auf null, da diese Zeile keinen realen Wechsel abbildet.
  function setPueOverrideRowAlways(pueOverrides, fromPhaseId, toPhaseId, rowIdx, always, seedRows) {
    const ov = ensurePueOverride(pueOverrides, fromPhaseId, toPhaseId, seedRows);
    if (ov.rows[rowIdx]) { ov.rows[rowIdx].always = always; ov.rows[rowIdx].an = null; ov.rows[rowIdx].ab = null; }
  }
  function removePueOverrideRow(pueOverrides, fromPhaseId, toPhaseId, seedRows, rowIdx) {
    ensurePueOverride(pueOverrides, fromPhaseId, toPhaseId, seedRows).rows.splice(rowIdx, 1);
  }
  // value === null setzt zurück auf "automatisch" (siehe resolvePueRows) -
  // legt bei Bedarf trotzdem eine Korrektur an (auch ein reines Ende-
  // Override ohne Zeilenänderung zählt als "manuell angepasst"). Der Start
  // ist bewusst NICHT überschreibbar (siehe resolvePueRows) - er ist per
  // Definition immer 0.
  function setPueOverrideEndSec(pueOverrides, fromPhaseId, toPhaseId, seedRows, value) {
    ensurePueOverride(pueOverrides, fromPhaseId, toPhaseId, seedRows).endSec = value;
  }
  function resetPueOverride(pueOverrides, fromPhaseId, toPhaseId) {
    delete pueOverrides[pueOverrideKey(fromPhaseId, toPhaseId)];
  }

  // Balken-Segmente EINER PÜ-Zeile - DIREKT aus ihren logischen Werten
  // (An/Ab, plus reale Rotgelb-/Gelb-Dauer aus cm, falls bekannt)
  // SYNTHETISIERT, nicht aus den Rohdaten gesucht und angepasst. Kern der
  // Phasendefinition (siehe computePhaseOccurrences): eine anwerfende
  // Signalgruppe ist ab ihrem Wechsel bis MINDESTENS Ende durchgehend grün
  // (sie ist ja Mitglied der jetzt aktiven Phase, deren gesamtes Vorkommen
  // mindestens bis Ende reicht), eine abwerfende war bis zu ihrem Wechsel
  // bereits durchgehend grün (Mitglied der bis dahin aktiven Phase). Der
  // Balken darf an diesen Stellen NIE einen anderen Zustand zeigen - auch
  // nicht nach einer manuellen Korrektur, die von der ursprünglich
  // gefundenen realen Freigabe abweicht, oder wenn gar kein passendes
  // reales Segment existiert (dann rotgelb/gelb=0, aber die Grün-Spanne
  // bleibt trotzdem korrekt). wMinMs/wMaxMs (das sichtbare Zeitfenster,
  // nicht nur startSec/endSec) begrenzen, wie weit die Grün-Fläche über den
  // eigentlichen Wechsel hinaus in den -3s/+2s-Rand hineingezeichnet wird -
  // alles außerhalb bleibt implizit die rote Grundlinie (baselineCat/-Color
  // in renderLane).
  function buildRowDisplaySegs(row, cm, wMinMs, wMaxMs) {
    const rotgelb = cm && Number.isFinite(cm.rotgelb) ? cm.rotgelb : 0;
    const gelb = cm && Number.isFinite(cm.gelb) ? cm.gelb : 0;
    const segs = [];
    if (row.an != null) {
      const greenStartMs = (row.an + rotgelb) * 1000;
      if (rotgelb > 0) segs.push({ cat: 'ROTGELB', start: row.an * 1000, end: greenStartMs });
      segs.push({ cat: 'GRUEN', start: greenStartMs, end: Math.max(wMaxMs, greenStartMs) });
    } else if (row.ab != null) {
      segs.push({ cat: 'GRUEN', start: Math.min(wMinMs, row.ab * 1000), end: row.ab * 1000 });
      if (gelb > 0) segs.push({ cat: 'GELB', start: row.ab * 1000, end: (row.ab + gelb) * 1000 });
    }
    return segs;
  }

  // Summiert je Umlauf (cycleStarts[i]..cycleStarts[i+1)) die Vorkommensdauer
  // einer Phase - amortisierter Sweep über die (sortierten) Vorkommen statt
  // eines Vollscans je Umlauf, damit auch bei "Alle anzeigen" auf großen
  // Aufzeichnungen performant.
  function durationPerCycle(intervals, cycleStarts, tMax, fromIdx, toIdx) {
    const sweep = GZ.segments.makeIntervalSweep(intervals);
    const out = [];
    for (let i = fromIdx; i < toIdx; i++) {
      const start = cycleStarts[i];
      const end = i + 1 < cycleStarts.length ? cycleStarts[i + 1] : tMax;
      const hits = sweep(start, end);
      const sec = hits.reduce((sum, iv) => sum + (Math.min(iv.end, end) - Math.max(iv.start, start)) / 1000, 0);
      out.push(sec);
    }
    return out;
  }

  GZ.phases = {
    PHASE_COLORS, colorForIndex, intersectIntervals, unionIntervals, subtractIntervals, createPhase, createPhaseFromConfig,
    computePhaseOccurrences, buildCombinedSegments, durationPerCycle,
    pueLabelFor, buildAnnotatedSegments, listDistinctTransitions, cycleIdxAtTime,
    findSgEntryByColIndex, realCycleMetricsForSg, rotgelbStartSec, findAnchoredGreenSegIdx, metricsForAnchoredSeg, cmForRow,
    computeRowTf, compareSgNames, autoDetectPueRows, pueOverrideKey, resolvePueRows,
    ensurePueOverride, setPueOverrideRowField, setPueOverrideRowAlways, addPueOverrideRow, removePueOverrideRow, resetPueOverride,
    setPueOverrideEndSec, buildRowDisplaySegs
  };
})(window.GZ = window.GZ || {});
