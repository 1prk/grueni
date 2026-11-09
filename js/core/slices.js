/* GZ.slices — evaluation slices of one recording.
   A slice selects part of the data: the whole recording (key null),
   one signal plan (SPL), or one clock hour. Items belong to a slice by
   their start time. Pure functions, no DOM. */
(function (GZ) {
  'use strict';
  const { pad } = GZ.format;

  // More hourly slices than this make the tables unreadable.
  const MAX_HOUR_SLICES = 48;
  const UNKNOWN_PLAN = '(unbekannt)';

  function startOfHour(ms) {
    const d = new Date(ms);
    d.setMinutes(0, 0, 0);
    return d.getTime();
  }
  function nextHour(ms) {
    const d = new Date(ms);
    d.setHours(d.getHours() + 1);
    return d.getTime();
  }

  function planLabel(plan) {
    return plan === UNKNOWN_PLAN ? 'SPL ?' : 'SPL ' + plan;
  }

  // Hourly slices from the first to the last sample. The label contains the
  // date only when the recording spans more than one calendar day.
  function buildHourSlices(tMin, tMax) {
    const slices = [];
    const multiDay = new Date(tMin).toDateString() !== new Date(tMax - 1).toDateString();
    for (let t0 = startOfHour(tMin); t0 < tMax; t0 = nextHour(t0)) {
      const t1 = nextHour(t0);
      const a = new Date(t0), b = new Date(t1);
      const day = multiDay ? `${pad(a.getDate())}.${pad(a.getMonth() + 1)}. ` : '';
      slices.push({
        key: 'H' + t0, kind: 'hour', t0, t1,
        label: `${day}${pad(a.getHours())}:00–${pad(b.getHours())}:00`
      });
    }
    return slices;
  }

  // a = current analysis. Returns { plans, hours, hoursAvailable }.
  function build(a) {
    const plans = a.splList.map(p => ({ key: p, kind: 'plan', label: planLabel(p) }));
    const hours = buildHourSlices(a.tMin, a.tMax);
    return { plans, hours, hoursAvailable: hours.length <= MAX_HOUR_SLICES };
  }

  // Slices to show for a scope ('total' | 'spl' | 'hour'). The whole-recording
  // scope has one unnamed slice with key null.
  function forScope(slices, scope) {
    if (scope === 'spl') return slices.plans;
    if (scope === 'hour') return slices.hours;
    return [];
  }

  // Does an item that starts at time t, under signal plan `plan`, belong to the slice?
  // sliceKey: null (everything), a plan name, or 'H<ms>' for an hour.
  function contains(sliceKey, t, plan) {
    if (sliceKey == null) return true;
    if (sliceKey[0] === 'H' && /^H\d+$/.test(sliceKey)) {
      const t0 = Number(sliceKey.slice(1));
      return t >= t0 && t < nextHour(t0);
    }
    return plan === sliceKey;
  }

  // Consecutive runs of the same signal plan: [{ plan, t0, t1 }].
  // times/splValues are the parallel arrays of the analysis (SPL is forward-filled).
  function planRuns(times, splValues, tMin, tMax) {
    const runs = [];
    for (let i = 0; i < times.length; i++) {
      const plan = splValues[i] || UNKNOWN_PLAN;
      const last = runs[runs.length - 1];
      if (last && last.plan === plan) continue;
      if (last) last.t1 = times[i];
      runs.push({ plan, t0: i === 0 ? tMin : times[i], t1: tMax });
    }
    return runs;
  }

  // Colour of a slice in charts: signal plans use two greens, hours a light-to-dark ramp.
  const HOUR_RAMP = ['#a9d8bd', '#62b586', '#1f8a4c', '#0d4a28'];
  const PLAN_COLORS = ['var(--plan-a)', 'var(--plan-b)', 'var(--plan-c)', 'var(--plan-d)'];
  function colorOf(slices, slice) {
    if (slice.kind === 'hour') return HOUR_RAMP[slices.hours.indexOf(slice) % HOUR_RAMP.length];
    return PLAN_COLORS[slices.plans.indexOf(slice) % PLAN_COLORS.length];
  }

  GZ.slices = { MAX_HOUR_SLICES, UNKNOWN_PLAN, build, forScope, contains, planRuns, colorOf, planLabel, startOfHour };
})(window.GZ = window.GZ || {});
