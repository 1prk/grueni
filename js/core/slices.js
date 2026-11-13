/* GZ.slices gives the evaluation slices of one recording.
   A slice selects a part of the data: the whole recording (key null), one signal plan (SPL), or
   one clock hour.
   An item belongs to a slice by its start time.
   The functions are pure. They do not use the DOM. */
GZ.define('slices', { layer: 'domain', deps: ['format'] }, function (GZ) {
  'use strict';
  const { pad } = GZ.format;

  // If there are more hourly slices than this, the tables are not readable.
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

  // Hourly slices from the first sample to the last sample.
  // The label has the date only if the recording covers more than one calendar day.
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

  // a is the current analysis. Returns { plans, hours, hoursAvailable }.
  function build(a) {
    const plans = a.splList.map(p => ({ key: p, kind: 'plan', label: planLabel(p) }));
    const hours = buildHourSlices(a.tMin, a.tMax);
    return { plans, hours, hoursAvailable: hours.length <= MAX_HOUR_SLICES };
  }

  // Returns the slices to show for a scope ('total', 'spl' or 'hour').
  // The scope 'total' has one unnamed slice with the key null.
  function forScope(slices, scope) {
    if (scope === 'spl') return slices.plans;
    if (scope === 'hour') return slices.hours;
    return [];
  }

  // Tests if an item belongs to a slice. The item starts at time t under the signal plan `plan`.
  // sliceKey is null (everything), a plan name, or 'H<ms>' for an hour.
  function contains(sliceKey, t, plan) {
    if (sliceKey == null) return true;
    if (sliceKey[0] === 'H' && /^H\d+$/.test(sliceKey)) {
      const t0 = Number(sliceKey.slice(1));
      return t >= t0 && t < nextHour(t0);
    }
    return plan === sliceKey;
  }

  // Returns the runs of the same signal plan in sequence: [{ plan, t0, t1 }].
  // times and splValues are the parallel arrays of the analysis. The SPL values are forward-filled.
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

  // Returns the color of a slice in charts. Signal plans use two greens. Hours use a ramp from
  // light to dark.
  const HOUR_RAMP = ['#a9d8bd', '#62b586', '#1f8a4c', '#0d4a28'];
  const PLAN_COLORS = ['var(--plan-a)', 'var(--plan-b)', 'var(--plan-c)', 'var(--plan-d)'];
  function colorOf(slices, slice) {
    if (slice.kind === 'hour') return HOUR_RAMP[slices.hours.indexOf(slice) % HOUR_RAMP.length];
    return PLAN_COLORS[slices.plans.indexOf(slice) % PLAN_COLORS.length];
  }

  return { MAX_HOUR_SLICES, UNKNOWN_PLAN, build, forScope, contains, planRuns, colorOf, planLabel, startOfHour };
});
