/* GZ.segments has state segments, cycle and SPL statistics and derived signal plan values (An,
   Ab, TF).
   It works on series. A series is a column of GZ.table or a text array (see GZ.series).
   It does not depend on the DOM. */
GZ.define('segments', { layer: 'domain', deps: ['parser', 'series', 'stats'] }, function (GZ) {
  'use strict';
  const { median, mean } = GZ.stats;
  const { categorizeSgRaw } = GZ.parser;

  // State segments of a column.
  // A recording gap (a time jump clearly above the typical step) ends the running segment.
  // The code reports the gap as its own LUECKE segment.
  // Otherwise a logging pause of 10 minutes during green would enter the statistics as a green
  // phase of 10 minutes.
  // That would falsify the average, the maximum and the trend.
  // catFn is optional (default: traffic signal categorization). For DET columns the caller passes
  // categorizeDetRaw.
  // The code calls catFn one time for each different cell text and not for each row (see GZ.series.cats).
  function buildSegments(times, series, catFn) {
    const fn = catFn || categorizeSgRaw;
    const { codes, names } = GZ.series.cats(series, fn);
    const segs = [];
    const step = GZ.parser.estimateStep(times);
    const gapThresh = Math.max(step * 5, 5000);
    let curCode = 0, curStart = null, prevT = null;
    for (let i = 0; i < codes.length; i++) {
      const t = times[i];
      if (prevT !== null && (t - prevT) > gapThresh && curCode !== 0) {
        const segEnd = prevT + step;
        segs.push({ cat: names[curCode], start: curStart, end: segEnd });
        segs.push({ cat: 'LUECKE', start: segEnd, end: t });
        curCode = 0; curStart = null;
      }
      prevT = t;
      const code = codes[i];
      if (code === 0) { continue; }
      if (code !== curCode) {
        if (curCode !== 0) segs.push({ cat: names[curCode], start: curStart, end: t });
        curCode = code; curStart = t;
      }
    }
    if (curCode !== 0) segs.push({ cat: names[curCode], start: curStart, end: times[times.length - 1] + GZ.parser.estimateStep(times) });
    return segs;
  }

  function computeCycleStats(segs) {
    const greens = segs.filter(s => s.cat === 'GRUEN');
    const greenDurations = greens.map(s => (s.end - s.start) / 1000);
    const cycleDurations = [];
    for (let i = 0; i < greens.length - 1; i++) cycleDurations.push((greens[i + 1].start - greens[i].start) / 1000);
    return { greens, greenDurations, cycleDurations };
  }

  // Finds the active SPL value (signal timing plan) at a time t.
  // splValues is already forward-filled at import, so a binary search for the last time index <= t
  // is enough.
  function findSplAt(t, times, splValues) {
    if (!times || !times.length) return '';
    let lo = 0, hi = times.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans >= 0 ? (splValues[ans] || '') : '';
  }

  // Returns a sample(tMs) function for the raw value of ONE column (DET, BLK, APW or ÖPNV) at any
  // time.
  // It is the basis of the exprEngine primitive WertBei(det, time).
  // An example is "which APW countdown did APW_01 show at the moment of the Ab of K1".
  // Unlike splValues, the DET, APW and ÖPNV raw series are NOT forward-filled beforehand
  // (see GZ.parser.parseOcitText: only TC and SP are forward-filled at import).
  // An empty cell means "unchanged since the last value". It does not mean "no value".
  // buildSegments() skips empty cells for the same reason.
  // So this function forward-fills once (not for each query).
  // After that it does a binary search for the last time index <= t, like findSplAt().
  // A REALLY empty cell (no value seen so far) and a non-numeric raw value (for example "INV") give
  // NaN.
  // This is consistent with the NUM/NaN contract in exprEngine.js.
  function makeRawValueSampler(times, series) {
    const valueAt = GZ.series.numberAt(series);
    return function sample(tMs) {
      let lo = 0, hi = times.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= tMs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (ans === -1) return NaN;
      return valueAt(ans);
    };
  }

  // Returns a durationAt(tMs) function.
  // It answers: for how long (in seconds) was the state that applies at the time tMs already active
  // WITHOUT interruption at that time?
  // It is the basis of the exprEngine primitive DauerBei(object, time).
  // It is GENERIC over any state segments (segs, as buildSegments() makes them) on purpose.
  // For a signal group these are GRUEN, ROT and so on segments.
  // For a detector, APW or ÖPNV value they are BELEGT and FREI segments (categorizeDetRaw).
  // This function does not care WHICH category applies. It only answers "since when does the
  // CURRENT state apply".
  // So it matches the row-wise Dauer(object) of exprEngine.js, but for any time (not only the
  // "current" time).
  // It uses a binary search and not a running sweep.
  // The reason is that queries do not need to come in ascending order (unlike a sweep over the raw
  // data).
  // It returns NaN if tMs is before the first segment or in a recording gap
  // (see the LUECKE segments of buildSegments(): a gap IS its own segment with .start,
  // so "since when gap" is well defined and the code treats it like any other state).
  function makeSegmentDurationSampler(segs) {
    return function durationAt(tMs) {
      let lo = 0, hi = segs.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (segs[mid].start <= tMs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (ans === -1) return NaN;
      const seg = segs[ans];
      if (tMs >= seg.end) return NaN; // After the last segment: no current state is known
      return (tMs - seg.start) / 1000;
    };
  }

  // Like computeCycleStats, but separate for each SPL that is active at the time of the start of
  // each green.
  // The average cycle uses only cycles that are fully inside the same SPL.
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

  // The times at which the SPL state changes. The code finds them once over the full series (not
  // for each cycle).
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

  // Finds the cycle time range (from the TX=0 borders) that contains a time.
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

  // An, Ab and TF for ONE specific green segment (not aggregated), including the wrap case
  // (for example TU=100, An=90, Ab=10 -> TF=20).
  function computeSegmentAnAbTf(seg, cycleStarts, TU) {
    const csStart = findEnclosingCycleStart(seg.start, cycleStarts);
    const csEnd = findEnclosingCycleStart(seg.end, cycleStarts);
    if (csStart == null || csEnd == null) return null;
    const an = ((Math.round((seg.start - csStart) / 1000) % TU) + TU) % TU;
    const ab = ((Math.round((seg.end - csEnd) / 1000) % TU) + TU) % TU;
    const tf = Math.round((seg.end - seg.start) / 1000);
    return { an, ab, tf };
  }

  // Typical (median) values of An, Ab and TF of a signal group,
  // and the red-amber and amber transition durations that the code really observed.
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

  // Maps stats.greens (only GRUEN segments) to their indices in the full segs array.
  // The code does this once for each signal group.
  // So adjacentTransitionDurations() does not need a linear search for the matching segment for
  // each cycle
  // (see GZ.umlaufContext).
  function mapGreensToSegIndex(segs) {
    const out = [];
    segs.forEach((s, i) => { if (s.cat === 'GRUEN') out.push(i); });
    return out;
  }

  // Red-amber or amber duration directly before or after ONE green segment (0 if not adjacent).
  // It uses the same neighbor logic as computeSignalplanRow, but for a single occurrence and not
  // for the median over all.
  function adjacentTransitionDurations(segs, segIndex) {
    const prev = segs[segIndex - 1];
    const rotgelb = (prev && prev.cat === 'ROTGELB') ? (prev.end - prev.start) / 1000 : 0;
    const next = segs[segIndex + 1];
    const gelb = (next && next.cat === 'GELB') ? (next.end - next.start) / 1000 : 0;
    return { rotgelb, gelb };
  }

  // An, Ab, TF, Rotgelb and Gelb of ONE signal group for EVERY cycle (index = cycle index in
  // cycleStarts).
  // It is the basis of the cycle-wise exprEngine primitives An, Ab, TF, RG and GE
  // (see the header comment there about handle.cycleMetrics).
  // greens = stats.greens of the signal group (only GRUEN segments).
  // segs = its full segment list (for the red-amber and amber neighbors).
  //
  // Returns: an array (one entry for each cycle) of arrays of ONE OR MORE occurrences.
  // An empty array means no green in this cycle.
  // A cycle can have more than ONE An/Ab pair of the same signal group (for example a pedestrian
  // re-request, re-service).
  // The code finds each GRUEN segment whose START is in this cycle window (not only the first one).
  // That was the real error before: the code dropped a second or third occurrence without a message
  // (see GZ.umlaufContext.buildAll(): for each cycle it makes as many EVALUATED ROWS as the "most
  // eventful" SG occurrence there has).
  // Occurrence[0] is still the first one in time in each cycle.
  // Callers that (as before) know only ONE occurrence for each cycle read only occurrence[0].
  // They stay exactly with the earlier behavior.
  // These callers are js/core/phases.js and the row-wise formula builder of
  // js/views/formulaBuilder.js.
  // For now, the detection of many occurrences applies only to the cycle-wise evaluation in
  // Umlaufstatistiken.
  //
  // The code calculates an and ab for each occurrence relative to the start of THIS cycle on
  // purpose.
  // It does not use computeSegmentAnAbTf(). There, ab is relative to the cycle in which the segment
  // ENDS on purpose.
  // That is right for the carrySegs row display of umlaufpruefung.js when a green extends past the
  // cycle border.
  // But it is wrong for ONE consistent Umlaufstatistiken record (see the git history).
  // So ab can be larger than TU_MED. This is an honest signal for "green for a long time past the
  // cycle"
  // and not a hidden modulo fold.
  // Versatz and Ueberschneidung fold it with MOD() in their own comparison anyway.
  function computeCycleSgMetrics(segs, greens, cycleStarts, tMax, TU_MED) {
    const n = cycleStarts ? cycleStarts.length : 0;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = [];
    if (!TU_MED || n === 0) return out;
    const segIndexOfGreen = mapGreensToSegIndex(segs);
    // A running pointer and not makeIndexSweep().
    // makeIndexSweep() needs "at most ONE hit for each window".
    // Here the inner loop must collect ALL occurrences with .start in the current window
    // before it moves on to the next (later) cycle window.
    // It is still amortized O(cycles + occurrences) over the whole recording.
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
        // segIdx, segStart and segEnd (raw, not rounded) in addition to the rounded key figures an,
        // ab and tf.
        // Callers that need the real position of this GRUEN segment in the full segs array must
        // otherwise search it again themselves.
        // An example is the PÜ tool of GZ.phases.
        // It shows exactly this segment plus its red-amber and amber neighbors, not the whole raw
        // time series of the signal group.
        out[i].push({ an, ab, tf, rotgelb: extra.rotgelb, gelb: extra.gelb, segIdx, segStart: seg.start, segEnd: seg.end });
        j++;
      }
      ptr = j;
    }
    return out;
  }

  // Like computeCycleSgMetrics(), but it records An AND Ab INDEPENDENT of each other
  // and not as ONE common occurrence.
  // An belongs to the cycle in which the segment STARTS. Ab belongs to the cycle in which it ENDS.
  // For a green that extends past a cycle border these are TWO DIFFERENT cycles.
  // GZ.umlaufContext.buildAll() (Umlaufstatistiken) uses it as its basis.
  // It differs from computeCycleSgMetrics.
  // js/core/phases.js and the row-wise formula builder still use that one.
  // They want a single, closed occurrence with An and Ab that surely belong together.
  //
  // Reason: An(sg) and Ab(sg) must stay a purely LOCAL value for each cycle in Umlaufstatistiken.
  // The value is always smaller than TU of this cycle.
  // It is never hidden by a modulo fold, and never coupled to a foreign cycle that only happens to
  // "belong".
  // The rule is: "we always talk about relative time inside THIS cycle".
  // A green that starts in cycle A and ends in cycle B gives an An WITHOUT a matching Ab in cycle A
  // (TF and Ab are NaN there: "we do not know this here yet").
  // It gives an Ab WITHOUT a matching An in cycle B (An is NaN there: "it started elsewhere").
  // The code does not force both artificially into ONE cycle.
  //
  // Returns: an array (one entry for each cycle) of { an: [...], ab: [...] }.
  // an[k] = {value, rotgelb, segIdx, segStart}. ab[k] = {value, tf, gelb, segIdx, segEnd}.
  // rotgelb (the duration directly BEFORE this green) belongs to An in meaning.
  // gelb (directly AFTER this green) belongs to Ab.
  // tf (the total duration of the green segment) is only known when the green ends, so it is in Ab.
  // an[k] and ab[k] do NOT need to come from the same green segment
  // when a cycle has a different number of An events than Ab events for the same signal group (see
  // above).
  // GZ.umlaufContext.buildAll() pairs them only by the index k
  // (the n-th An with the n-th Ab, independent of whether they belong to the same green segment).
  function computeCycleSgEvents(segs, greens, cycleStarts, tMax) {
    const n = cycleStarts ? cycleStarts.length : 0;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = { an: [], ab: [] };
    if (n === 0) return out;
    const segIndexOfGreen = mapGreensToSegIndex(segs);

    // An side: sweep over greens by .start (as in computeCycleSgMetrics).
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

    // Ab side: its OWN sweep over the same greens, but by .end.
    // greens is already ascending by .start AND .end (disjoint segments of a time series).
    // So a second pointer that only moves forward is enough. No new sorting is needed.
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

  // The number of An events and of Ab events of each cycle. It uses the same rules as computeCycleSgEvents().
  // But it does not make event objects. The count of rows of a cycle needs only these numbers.
  // Returns { an: Uint32Array, ab: Uint32Array }.
  function countCycleSgEvents(greens, cycleStarts, tMax) {
    const n = cycleStarts ? cycleStarts.length : 0;
    const an = new Uint32Array(n), ab = new Uint32Array(n);
    let ptrAn = 0, ptrAb = 0;
    for (let i = 0; i < n; i++) {
      const start = cycleStarts[i];
      const end = i + 1 < n ? cycleStarts[i + 1] : tMax;
      while (ptrAn < greens.length && greens[ptrAn].start < start) ptrAn++;
      let j = ptrAn;
      while (j < greens.length && greens[j].start < end) j++;
      an[i] = j - ptrAn;
      ptrAn = j;
      while (ptrAb < greens.length && greens[ptrAb].end < start) ptrAb++;
      j = ptrAb;
      while (j < greens.length && greens[j].end < end) j++;
      ab[i] = j - ptrAb;
      ptrAb = j;
    }
    return { an, ab };
  }

  // Triggered and count of rising edges of ONE detector or value for EVERY cycle.
  // It is the basis of the exprEngine primitives Ausgeloest and AnzahlAusloesungen.
  // occupiedFlags: an array parallel to times. A value is true or false, or 1 or 0 (see GZ.series.flags).
  // The caller decides which occupancy rule applies (for example GZ.wartezeitLogic.wzIstBelegt).
  // This function knows only points in time, no raw values.
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

  // Returns, for each cycle (parallel to stats.greens and greenDurations), if the cycle counts as
  // unusual.
  // ctx = {scope:'total'|'spl', splList, times, splValues}.
  // In SPL mode the code rates the deviation separately inside each signal plan (own median and MAD
  // for each SPL),
  // not against one common median over the whole recording.
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

  // Median and MAD of a signal group inside a specific SPL, from stats.bySpl.
  // It is the same basis as the key figure table in SPL mode.
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

  // Splits the visible time range [tMin,tMax] into continuous time windows for each active SPL.
  // Each window has the median of this plan that applies to the WHOLE recording.
  // So a plan that occurs many times in time gets the same reference value everywhere.
  // This is consistent with the key figure table.
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

  // The time ranges of the unusual cycles of a signal group (green time deviation of more than 3
  // times MAD),
  // as bands for the signal time chart.
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

  // Returns a "take(start,end)" function for a sweep over sortedIntervals
  // (ascending by .start, disjoint and chronological, as buildSegments makes them).
  // If the calls come in ASCENDING order and do not overlap (for example once for each cycle in a
  // loop),
  // take() returns the entries that overlap [start,end).
  // The cost is amortized O(n) over all calls together, not an O(n) full scan FOR EACH call.
  // It is necessary when a full scan for each cycle becomes quadratic with many cycles
  // (see the cycle check with big recordings).
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

  // Like makeIntervalSweep, but it returns only the FIRST index of an entry with start < end (or
  // -1).
  // Use it when at most one hit is expected for each window (as for stats.greens for each cycle)
  // and the caller needs the original index (for example for parallel unusual flags).
  function makeIndexSweep(sortedItems) {
    let ptr = 0;
    return function take(start, end) {
      while (ptr < sortedItems.length && sortedItems[ptr].start < start) ptr++;
      return (ptr < sortedItems.length && sortedItems[ptr].start < end) ? ptr : -1;
    };
  }

  // Point sweep: which (single) segment contains a specific point in time?
  // makeIntervalSweep and makeIndexSweep are for window overlap.
  // This one is for point lookups.
  // The formula builder primitives (Zustand, Dauer, DauerSeit) call advance(t) once for each row
  // (t ascending, amortized O(n) like the other sweeps).
  // After that they read segment() and time() as often as they want, without passing the time
  // again.
  // The segments must have no gaps and must not overlap, as buildSegments() delivers them.
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
      // Resets the pointer to the start.
      // This is necessary when the same sweep (for example the same object handle in
      // formulaBuilder.js)
      // is reused for SEVERAL runs in sequence over the same (ascending) time series (one formula
      // for each run).
      // Without reset() the pointer from the previous run would stay at the end.
      // Each later run would wrongly return "no segment".
      reset() { ptr = 0; curSeg = null; curT = null; }
    };
  }

  return {
    buildSegments, computeCycleStats, computeCycleStatsBySpl,
    findSplAt, makeRawValueSampler, makeSegmentDurationSampler, computeSplTransitions, computeGlobalTU,
    findEnclosingCycleStart, findCycleRange, computeSegmentAnAbTf, computeSignalplanRow,
    mapGreensToSegIndex, adjacentTransitionDurations, computeCycleSgMetrics, computeCycleSgEvents, countCycleSgEvents, computeCycleDetMetrics,
    typicalCycleSegments, getFlaggedAnomalies, getSplGroupMed, computeTrendSplWindows,
    computeAnomalyBands, wrapInterval, makeIntervalSweep, makeIndexSweep, makePointSegmentSweep
  };
});
