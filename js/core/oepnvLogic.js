/* GZ.oepnvLogic is the pure calculation logic for public transport registration and
   deregistration
   (ÖPNV Anmeldung/Abmeldung).
   A registration ends in one of two ways.
   It ends normally with the deregistration. Then the code measures the actual travel time.
   The lost time is the actual travel time minus the planned travel time (Sollfahrzeit).
   Or the system clears the registration by force when the forced clearance time
   (Zwangslöschzeit)
   has passed without a deregistration.
   The LOS (A to F) rates the lost time. */
(function (GZ) {
  'use strict';
  const { wzIstBelegt, txAtTime, auslosenderDetektor } = GZ.wartezeitLogic;

  const LOS_LEVELS = ['A', 'B', 'C', 'D', 'E', 'F'];
  // Upper limits [s] for LOS A to E. The values are guide values without a guideline reference.
  // The UI can override them. LOS F is everything above.
  const losDefaultBounds = [5, 10, 20, 35, 50];
  const sollfahrzeitDefault = 15;
  const zwangsloeschDefault = 60;

  function losStufe(verlustSek, bounds) {
    for (let i = 0; i < bounds.length; i++) {
      if (verlustSek <= bounds[i]) return LOS_LEVELS[i];
    }
    return LOS_LEVELS[LOS_LEVELS.length - 1];
  }

  // All rising edges (start of occupied) of one detector occupancy (combined with OR) as raw
  // points.
  // They do not depend on the pairing logic of registration and deregistration.
  // The raw points display uses them.
  function risingEdgeTimes(times, occupied) {
    const out = [];
    let prev = false;
    for (let i = 0; i < times.length; i++) {
      if (occupied[i] && !prev) out.push(times[i]);
      prev = occupied[i];
    }
    return out;
  }

  // A registration starts when the registration detectors become occupied while no registration is
  // active.
  // The state of the signal group does not matter here.
  // The lost time comes only from the measured travel time from registration to deregistration,
  // compared with the planned travel time.
  // The registration ends with the deregistration.
  // If the deregistration does not arrive for one forced clearance time, a forced clearance ends
  // it.
  function computeOepnvEvents(times, anOccupied, abOccupied, splRaw, exclSpl, sollfahrzeitSek, zwangsloeschSek) {
    const n = times.length;
    const events = [];
    let prevAn = false, prevAb = false, waiting = false, startIdx = -1;

    function pushEvent(type, endIdx, istFahrzeitSek) {
      const splVal = splRaw[startIdx];
      const splNum = Number(splVal);
      events.push({
        type, anIdx: startIdx, endIdx,
        anTime: times[startIdx], endTime: times[endIdx],
        istFahrzeitSek, verlustSek: istFahrzeitSek - sollfahrzeitSek, spl: splVal,
        excluded: Number.isFinite(splNum) && exclSpl.includes(splNum)
      });
    }

    for (let i = 0; i < n; i++) {
      const anBelegt = anOccupied[i];
      const abBelegt = abOccupied[i];

      if (waiting) {
        const elapsedSek = (times[i] - times[startIdx]) / 1000;
        if (abBelegt && !prevAb) {
          pushEvent('ABMELDUNG', i, elapsedSek);
          waiting = false;
        } else if (elapsedSek >= zwangsloeschSek) {
          pushEvent('ZWANGSGELOESCHT', i, zwangsloeschSek);
          waiting = false;
        }
      }

      if (anBelegt && !prevAn && !waiting) {
        waiting = true;
        startIdx = i;
      }
      prevAn = anBelegt;
      prevAb = abBelegt;
    }

    const unresolved = waiting
      ? { startIdx, startTime: times[startIdx], durationSec: (times[n - 1] - times[startIdx]) / 1000, spl: splRaw[startIdx] }
      : null;
    return { events, unresolved };
  }

  GZ.oepnvLogic = {
    LOS_LEVELS, losDefaultBounds, sollfahrzeitDefault, zwangsloeschDefault,
    losStufe, risingEdgeTimes, computeOepnvEvents,
    wzIstBelegt, txAtTime, auslosenderDetektor
  };
})(window.GZ = window.GZ || {});
