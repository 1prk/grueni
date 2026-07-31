/* GZ.phases — Phaseneinteilung einer Lichtsignalanlage (RiLSA): eine Phase
   fasst die Signalgruppen zusammen, die GLEICHZEITIG Grün (Freigabe) zeigen
   und damit keinen Verkehrskonflikt miteinander haben. Ein Signalprogramm
   durchläuft je Umlauf eine feste Phasenfolge, getrennt durch Zwischenzeiten
   (hier nicht modelliert - wir werten nur aus, WANN eine definierte Phase in
   den aufgezeichneten Daten tatsächlich vollständig angezeigt wurde).

   Eine Phase wird rein über ihre Mitglieder-Signalgruppen definiert
   (Stammdaten-LSA-Tab); ob/wann sie in der Aufzeichnung auftritt, wird aus
   den bereits vorhandenen Grünsegmenten (stats.greens je Signalgruppe)
   abgeleitet - reine Auswertungslogik, unabhängig vom DOM. */
(function (GZ) {
  'use strict';

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

  // Baut aus einer Phasendefinition + der laufenden Analyse eine Struktur im
  // selben Format wie ein Signalgruppen-Eintrag aus app.js (col/segs/stats) -
  // dadurch lassen sich das Signalzeitendiagramm (timelineChart), die
  // Kennzahlen-Logik und der Trend-Chart unverändert wiederverwenden. Aktiv
  // = Kategorie GRUEN (wie bei einer echten Signalgruppe), inaktiv = ROT.
  function buildPhaseAnalysisEntry(phase, allStats, tMin, tMax) {
    const memberGreens = [...phase.members]
      .map(idx => allStats.find(a => a.col.index === idx))
      .filter(Boolean)
      .map(entry => entry.stats.greens);
    const intervals = phase.members.size ? intersectIntervals(memberGreens) : [];

    const segs = [];
    let cursor = tMin;
    intervals.forEach(iv => {
      if (iv.start > cursor) segs.push({ cat: 'ROT', start: cursor, end: iv.start });
      segs.push({ cat: 'GRUEN', start: iv.start, end: iv.end });
      cursor = iv.end;
    });
    if (cursor < tMax) segs.push({ cat: 'ROT', start: cursor, end: tMax });

    const greenDurations = intervals.map(iv => (iv.end - iv.start) / 1000);
    const cycleDurations = [];
    for (let i = 0; i < intervals.length - 1; i++) cycleDurations.push((intervals[i + 1].start - intervals[i].start) / 1000);

    const col = { index: 'phase:' + phase.id, name: phase.kuerzel, beschreibung: phase.name };
    const stats = { greens: intervals, greenDurations, cycleDurations };
    return { col, segs, stats, phase };
  }

  GZ.phases = { intersectIntervals, createPhase, buildPhaseAnalysisEntry };
})(window.GZ = window.GZ || {});
