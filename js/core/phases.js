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

  function nextDefaultLabel(existingPhases) {
    const n = existingPhases.length + 1;
    return { name: `Phase ${n}`, kuerzel: `Ph${n}` };
  }

  let phaseIdSeq = 1;
  function createPhase(existingPhases) {
    const { name, kuerzel } = nextDefaultLabel(existingPhases);
    return { id: 'ph' + (phaseIdSeq++), name, kuerzel, members: new Set() };
  }

  // Zeitbereiche, in denen eine Phase tatsächlich vollständig angezeigt
  // wurde (alle Mitglieder gleichzeitig Grün).
  function computePhaseOccurrences(phase, allStats) {
    const memberGreens = [...phase.members]
      .map(idx => allStats.find(a => a.col.index === idx))
      .filter(Boolean)
      .map(entry => entry.stats.greens);
    const intervals = phase.members.size ? intersectIntervals(memberGreens) : [];
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
    PHASE_COLORS, colorForIndex, intersectIntervals, createPhase,
    computePhaseOccurrences, buildCombinedSegments, durationPerCycle
  };
})(window.GZ = window.GZ || {});
