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
  // Phasen-ID-Paar genau einmal, erstes Vorkommen gemerkt) - Grundlage für
  // die Liste im PÜ-Werkzeug (Stammdaten LSA): nur Übergänge anbieten, die
  // es in den Rohdaten auch wirklich gibt, nicht jede denkbare Kombination
  // aus der Phasenliste.
  function listDistinctTransitions(occurrenceEntries, tMin, tMax) {
    const segs = buildAnnotatedSegments(occurrenceEntries, tMin, tMax);
    const seen = new Map();
    segs.forEach(seg => {
      if (seg.cat !== 'NONE' || !seg.pueFromPhaseId || !seg.pueToPhaseId) return;
      const key = seg.pueFromPhaseId + '→' + seg.pueToPhaseId;
      if (!seen.has(key)) {
        seen.set(key, { fromPhaseId: seg.pueFromPhaseId, toPhaseId: seg.pueToPhaseId, label: seg.pueLabel, firstOccurrence: { start: seg.start, end: seg.end } });
      }
    });
    return [...seen.values()];
  }

  // Umlaufindex, in dem der Zeitpunkt t liegt (letzter cycleStarts-Eintrag
  // <= t) - wandelt eine absolute Zeit (z.B. listDistinctTransitions()'
  // firstOccurrence.start) in den cycleIdx um, den autoDetectPueRows()/
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

  // Automatisch erkannte PÜ-Zeilen für EIN Vorkommen (fromPhase/toPhase in
  // GENAU diesem Umlauf): eine Zeile je Mitglied der abwerfenden Phase (nur
  // Ab gesetzt) bzw. der anwerfenden Phase (nur An gesetzt), relativ zu dem
  // Zeitpunkt, an dem das Vorkommen der abwerfenden Phase selbst endet (=
  // die "TX=0"-Referenz dieses Übergangs, siehe phaseOccurrenceEndInCycle
  // oben) - das ist per Definition "die Signalgruppe, die als erste
  // (innerhalb der abwerfenden Phase) endet", denn genau das lässt das
  // Vorkommen enden. Bewusst NICHT als Math.min() über nur die individuell
  // "abwerfenden" (nicht auch zur anwerfenden Phase gehörenden) Mitglieder
  // neu berechnet: das würde sowohl gemeinsame Mitglieder (die laut
  // Phasendefinition ebenso zur abwerfenden Phase zählen) als auch ein
  // vorzeitiges Rotgelb einer anwerfenden Signalgruppe übersehen - beides
  // kann das Vorkommen schon vor dem Ab-Wechsel jeder "echt abwerfenden"
  // Signalgruppe beenden. Ein Mitglied, das in BEIDEN Phasen steht (bleibt
  // über den Übergang hinweg durchgehend grün), wird als ZEILE dennoch
  // weder als "endend" noch als "beginnend" geführt - es engagiert/
  // disengagiert an diesem Übergang schlicht nicht (sonst würde ein und
  // dieselbe reale Grünzeit fälschlich gleichzeitig als An- UND Ab-Ereignis
  // dieses Übergangs erscheinen); es zählt nur (indirekt, über
  // phaseOccurrenceEndInCycle) zur Referenzzeit-Bestimmung mit. null, wenn
  // in diesem Umlauf kein Vorkommen der abwerfenden Phase endet (z.B.
  // Datenlücke) - dann gibt es nichts, worauf sich die Spanne beziehen
  // könnte.
  function autoDetectPueRows(fromPhase, toPhase, cycleIdx, a, TU_MED) {
    const outgoingIdx = [...fromPhase.members].filter(idx => !toPhase.members.has(idx));
    const incomingIdx = [...toPhase.members].filter(idx => !fromPhase.members.has(idx));
    const outgoing = outgoingIdx.map(sgIndex => ({ sgIndex, cm: realCycleMetricsForSg(sgIndex, cycleIdx, a, TU_MED) }));
    const incoming = incomingIdx.map(sgIndex => ({ sgIndex, cm: realCycleMetricsForSg(sgIndex, cycleIdx, a, TU_MED) }));
    const cycleStart = a.cycleStarts[cycleIdx];
    const cycleEnd = cycleIdx + 1 < a.cycleStarts.length ? a.cycleStarts[cycleIdx + 1] : a.tMax;
    const gapStartAbsMs = phaseOccurrenceEndInCycle(fromPhase, a.allStats, cycleStart, cycleEnd);
    if (gapStartAbsMs == null) return null;
    const referenceSec = (gapStartAbsMs - cycleStart) / 1000;
    const rows = [];
    outgoing.forEach(o => { if (o.cm && Number.isFinite(o.cm.ab)) rows.push({ sgIndex: o.sgIndex, an: null, ab: Math.round((o.cm.ab - referenceSec) * 10) / 10 }); });
    incoming.forEach(o => { if (o.cm && Number.isFinite(o.cm.an)) rows.push({ sgIndex: o.sgIndex, an: Math.round((o.cm.an - referenceSec) * 10) / 10, ab: null }); });
    // Übergangsende = die zuletzt (spätest) ins Grün kommende Signalgruppe
    // der anwerfenden Phase - per Definition das Gegenstück zum Start
    // (früheste Signalgruppe der abwerfenden Phase auf Gelb). null, wenn
    // keine incoming-Zeile einen An-Wert hat (z.B. Datenlücke).
    const ans = rows.map(r => r.an).filter(v => v != null);
    const endSec = ans.length ? Math.max(...ans) : null;
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
  // überschreibbar). endSec ist der späteste An der anwerfenden Phase,
  // standardmäßig aus den GERADE AKTIVEN Zeilen (override, falls vorhanden,
  // sonst automatisch erkannt) hergeleitet, so dass ein Bearbeiten einer
  // einzelnen Zeile automatisch auch das Übergangsende mitverschiebt.
  // pueOverrides.endSec erlaubt zusätzlich, es unabhängig von den Zeilen
  // fest vorzugeben (siehe setPueOverrideEndSec unten) - z.B. um den
  // Übergang bewusst weiter zu fassen, als es die aktuell erfassten Zeilen
  // hergeben.
  function resolvePueRows(fromPhase, toPhase, cycleIdx, a, TU_MED, pueOverrides) {
    const auto = autoDetectPueRows(fromPhase, toPhase, cycleIdx, a, TU_MED);
    const override = pueOverrides ? pueOverrides[pueOverrideKey(fromPhase.id, toPhase.id)] : null;
    const rows = override ? override.rows : (auto ? auto.rows : []);
    const ans = rows.map(r => r.an).filter(v => v != null);
    const derivedEndSec = ans.length ? Math.max(...ans) : null;
    return {
      referenceSec: auto ? auto.referenceSec : null,
      rows,
      startSec: 0,
      endSec: (override && override.endSec != null) ? override.endSec : derivedEndSec,
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
    if (ov.rows[rowIdx]) ov.rows[rowIdx][field] = value;
  }
  function addPueOverrideRow(pueOverrides, fromPhaseId, toPhaseId, seedRows, sgIndex) {
    ensurePueOverride(pueOverrides, fromPhaseId, toPhaseId, seedRows).rows.push({ sgIndex, an: null, ab: null });
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

  // Reale Segmentliste EINER Signalgruppe, zeitlich um die PÜ-Referenz
  // verschoben (referenceAbsMs = Umlaufbeginn + referenceSec) - ein
  // renderLane()-Aufruf mit wMin/wMax nahe 0 zeigt damit direkt die lokale
  // TX-Achse dieses Übergangs, ohne dass renderLane selbst etwas von
  // "Verschiebung" wissen müsste (dieselbe Funktion wie überall sonst, nur
  // mit bereits vorverschobenen Segment-Zeiten als Eingabe).
  function buildLocalShiftedSegs(sgIndex, referenceAbsMs, a) {
    const entry = findSgEntryByColIndex(sgIndex, a);
    if (!entry) return [];
    return entry.segs.map(s => ({ ...s, start: s.start - referenceAbsMs, end: s.end - referenceAbsMs }));
  }

  // Verschiebt in shiftedSegs (siehe buildLocalShiftedSegs()) genau die
  // Segmentgrenze, die row.an/row.ab tatsächlich abbildet, auf den
  // (ggf. manuell überschriebenen) Zeilenwert - sonst würde eine reine
  // Tabellenkorrektur nie im Balken selbst sichtbar, obwohl genau DAS der
  // Zweck der Zeile ist ("hier korrigiere ich, wo diese Signalgruppe
  // wirklich auf Gelb/Grün wechselt"). rawCm liefert die ECHTEN An/Ab-Werte
  // dieser Signalgruppe in diesem Umlauf (dieselbe Quelle, aus der die
  // automatische Erkennung ihre Zahlen zieht, siehe autoDetectPueRows) - nur
  // deren dazugehörige Grenze in shiftedSegs wird verschoben, alles andere
  // (der übrige reale Verlauf drumherum) bleibt unangetastet, damit eine
  // Korrektur weiterhin optisch gegen die Realität prüfbar bleibt. Ohne
  // rawCm (keine reale Grenze zum Verankern, z.B. frei hinzugefügte Zeile
  // ohne eigene Grünphase) bleiben die Segmente unverändert.
  function applyRowOverrideToLocalSegs(shiftedSegs, row, rawCm, referenceSec) {
    if (!rawCm || referenceSec == null) return shiftedSegs;
    const out = shiftedSegs.map(s => ({ ...s }));
    const moveBoundary = (rawSec, overrideSec) => {
      if (rawSec == null || !Number.isFinite(rawSec) || overrideSec == null) return;
      const rawLocalMs = (rawSec - referenceSec) * 1000;
      const overrideLocalMs = overrideSec * 1000;
      if (Math.abs(overrideLocalMs - rawLocalMs) < 1) return;
      // rawSec kommt aus computeSegmentAnAbTf(), das auf GANZE Sekunden
      // rundet (Math.round) - die tatsächliche Segmentgrenze in shiftedSegs
      // (unverundete Roh-Millisekunden) kann dadurch bis zu 500ms daneben
      // liegen, daher eine großzügigere Toleranz als ein reiner
      // Rundungsfehler nahelegen würde.
      for (let i = 0; i < out.length; i++) {
        if (Math.abs(out[i].end - rawLocalMs) < 700) out[i].end = overrideLocalMs;
        if (Math.abs(out[i].start - rawLocalMs) < 700) out[i].start = overrideLocalMs;
      }
    };
    moveBoundary(rawCm.ab, row.ab);
    moveBoundary(rawCm.an, row.an);
    return out;
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
    findSgEntryByColIndex, realCycleMetricsForSg, autoDetectPueRows, pueOverrideKey, resolvePueRows,
    ensurePueOverride, setPueOverrideRowField, addPueOverrideRow, removePueOverrideRow, resetPueOverride,
    setPueOverrideEndSec, buildLocalShiftedSegs, applyRowOverrideToLocalSegs
  };
})(window.GZ = window.GZ || {});
