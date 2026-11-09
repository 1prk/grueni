/* GZ.greenTime — quantitative green time analysis.
   Builds, from one analysis, a model with all complete signal cycles and all
   green phases per signal group. Statistics are computed per slice
   (whole recording, one signal plan, one clock hour; see GZ.slices).

   Terms:
   - "fixed" (Festzeit): the green time of a signal group does not vary.
   - "actuated" (verkehrsabhängig): the green time varies.
   A signal group counts as fixed when at least `fixedShare` percent of its
   green times lie within median ± `tolerance` seconds. */
(function (GZ) {
  'use strict';
  const { median, mean, stdDev } = GZ.stats;
  // GZ.stats.percentile expects a sorted array. This one sorts a copy.
  const percentile = (values, p) => GZ.stats.percentile([...values].sort((x, y) => x - y), p);
  const { findSplAt, mapGreensToSegIndex, adjacentTransitionDurations } = GZ.segments;
  const { UNKNOWN_PLAN } = GZ.slices;

  // Fewer green phases than this are too few to tell fixed from actuated.
  const MIN_GREENS = 5;
  // A recorded cycle longer than this factor times the median cycle time is
  // not a normal cycle (data gap, switch-off). It is left out of the statistics.
  const IRREGULAR_CYCLE_FACTOR = 2.5;

  const params = { fixedShare: 95, tolerance: 1 };

  function lastIndexAtOrBefore(sorted, value) {
    let lo = 0, hi = sorted.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= value) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }

  // Red time (seconds) before every green phase of one signal group, in the
  // order of stats.greens. null when the time before the green is unknown
  // (first green, data gap, dark or unknown state in between).
  function redTimesBeforeGreens(segs) {
    const out = [];
    let acc = 0, haveGreen = false, unknown = false;
    segs.forEach(s => {
      if (s.cat === 'GRUEN') {
        out.push(haveGreen && !unknown ? acc : null);
        acc = 0; haveGreen = true; unknown = false;
      } else if (s.cat === 'ROT') {
        acc += (s.end - s.start) / 1000;
      } else if (s.cat !== 'ROTGELB' && s.cat !== 'GELB') {
        unknown = true;
      }
    });
    return out;
  }

  // Builds the model of one analysis (a = GZ.state.data.currentAnalysis).
  function build(a) {
    const starts = a.cycleStarts || [];
    const planAt = t => findSplAt(t, a.times, a.splValues) || UNKNOWN_PLAN;

    // Complete cycles only: from one cycle start to the next.
    const cycles = [];
    for (let i = 0; i + 1 < starts.length; i++) {
      cycles.push({ i, t: starts[i], tu: (starts[i + 1] - starts[i]) / 1000, plan: planAt(starts[i]) });
    }
    const tuMedian = cycles.length ? median(cycles.map(c => c.tu)) : 0;
    cycles.forEach(c => { c.regular = c.tu <= tuMedian * IRREGULAR_CYCLE_FACTOR; });
    const regularCount = cycles.filter(c => c.regular).length;

    const sgs = a.allStats.map(({ col, segs, stats }) => {
      const reds = redTimesBeforeGreens(segs);
      const segIndexOfGreen = mapGreensToSegIndex(segs);
      const redAmber = [], amber = [];
      const greens = stats.greens.map((g, k) => {
        const ci = lastIndexAtOrBefore(starts, g.start);
        const cycle = (ci >= 0 && ci < cycles.length && cycles[ci].regular) ? ci : -1;
        const trans = adjacentTransitionDurations(segs, segIndexOfGreen[k]);
        if (trans.rotgelb) redAmber.push(trans.rotgelb);
        if (trans.gelb) amber.push(trans.gelb);
        return {
          t: g.start, end: g.end, dur: (g.end - g.start) / 1000, plan: planAt(g.start),
          cycle,
          on: cycle >= 0 ? (g.start - starts[cycle]) / 1000 : null,
          off: cycle >= 0 ? (g.end - starts[cycle]) / 1000 : null,
          red: reds[k]
        };
      });
      return {
        col, greens, cache: new Map(),
        redAmber: redAmber.length ? median(redAmber) : 0,
        amber: amber.length ? median(amber) : 0
      };
    });

    // cycles: all complete cycles (indexed by green.cycle); only regular ones enter the statistics.
    return { cycles, hasCycles: regularCount >= 2, tuMedian, sgs };
  }

  function greensInSlice(sg, sliceKey) {
    const id = sliceKey == null ? '*' : sliceKey;
    if (!sg.cache.has(id)) sg.cache.set(id, sg.greens.filter(g => GZ.slices.contains(sliceKey, g.t, g.plan)));
    return sg.cache.get(id);
  }
  function cyclesInSlice(model, sliceKey) {
    return model.cycles.filter(c => c.regular && GZ.slices.contains(sliceKey, c.t, c.plan));
  }

  // Statistics of one signal group within one slice.
  function stats(model, sg, sliceKey) {
    const gs = greensInSlice(sg, sliceKey);
    const cyc = cyclesInSlice(model, sliceKey);
    const total = cyc.length, n = gs.length;
    if (!n) return { total, n: 0 };
    const durs = gs.map(g => g.dur);
    const med = median(durs), min = Math.min(...durs), max = Math.max(...durs);
    const share = durs.filter(v => Math.abs(v - med) <= params.tolerance).length / n;
    const withCycle = gs.filter(g => g.cycle >= 0);
    const on = withCycle.map(g => g.on), off = withCycle.map(g => g.off);
    const red = gs.map(g => g.red).filter(v => v != null);
    const cyclesWithGreen = new Set(withCycle.map(g => g.cycle)).size;
    return {
      total, n, gs, durs, med, min, max, sd: stdDev(durs), share,
      enough: n >= MIN_GREENS,
      isFixed: share * 100 >= params.fixedShare,
      atMax: durs.filter(v => v === max).length / n,
      p5: percentile(durs, 5), p95: percentile(durs, 95),
      hasCycleData: withCycle.length > 0,
      onMed: on.length ? median(on) : NaN, onLo: on.length ? percentile(on, 5) : NaN, onHi: on.length ? percentile(on, 95) : NaN,
      offMed: off.length ? median(off) : NaN, offLo: off.length ? percentile(off, 5) : NaN, offHi: off.length ? percentile(off, 95) : NaN,
      cyclesWithGreen,
      greenShare: withCycle.length ? median(withCycle.map(g => g.dur / model.cycles[g.cycle].tu)) : NaN,
      redMed: red.length ? median(red) : NaN, redMax: red.length ? Math.max(...red) : NaN,
      tuMed: cyc.length ? median(cyc.map(c => c.tu)) : NaN
    };
  }

  // Is the plant actuated in this slice? True as soon as one signal group
  // (with enough green phases) varies.
  function plantActuated(model, sliceKey) {
    return model.sgs.some(sg => { const st = stats(model, sg, sliceKey); return st.n && st.enough && !st.isFixed; });
  }
  function plantHasData(model, sliceKey) {
    return model.sgs.some(sg => { const st = stats(model, sg, sliceKey); return st.n && st.enough; });
  }

  // Cycle time statistics of one slice.
  function cycleTimes(model, sliceKey) {
    const tus = cyclesInSlice(model, sliceKey).map(c => c.tu);
    if (!tus.length) return null;
    return { n: tus.length, min: Math.min(...tus), max: Math.max(...tus), med: median(tus) };
  }

  // Which edge of the green window moves? Uses P5–P95, so a single
  // intervention does not count as "variable".
  function behaviour(st) {
    const fixedOn = st.onHi - st.onLo <= 0.5;
    const fixedOff = st.offHi - st.offLo <= 0.5;
    const fixedDuration = st.p95 - st.p5 <= 0.5;
    if (fixedOn && fixedOff) return 'Beginn und Ende fest';
    if (fixedOn) return 'Beginn fest · Ende variabel';
    if (fixedDuration) return 'Lage variabel · Dauer fest';
    return 'Beginn und Ende variabel';
  }

  GZ.greenTime = {
    MIN_GREENS, params, build, stats, plantActuated, plantHasData, cycleTimes, cyclesInSlice, behaviour,
    mean, percentile
  };
})(window.GZ = window.GZ || {});
