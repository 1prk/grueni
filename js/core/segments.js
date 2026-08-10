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
      time() { return curT; }
    };
  }

  GZ.segments = {
    buildSegments, computeCycleStats, computeCycleStatsBySpl,
    findSplAt, computeSplTransitions, computeGlobalTU,
    findEnclosingCycleStart, findCycleRange, computeSegmentAnAbTf, computeSignalplanRow,
    typicalCycleSegments, getFlaggedAnomalies, getSplGroupMed, computeTrendSplWindows,
    computeAnomalyBands, wrapInterval, makeIntervalSweep, makeIndexSweep, makePointSegmentSweep
  };
})(window.GZ = window.GZ || {});
