/* GZ.wartezeitLogic is the wait time from request (Wartezeit ab Anforderung):
   detector occupancy to start of green.
   It is pure calculation logic with event-based edge detection.
   TX and TU are only for information (see txAtTime and computeGlobalTU). */
GZ.define('wartezeitLogic', { layer: 'domain', deps: ['segments', 'series'] }, function (GZ) {
  'use strict';

  // Default limits for the rating for each signal group type.
  // They are only guide values without a guideline reference. The UI can override them.
  // The authoritative values are in RiLSA and HBS. A warning value of null means no warning level.
  const wzThresholdDefaults = {
    MIV: { warn: 90, grenz: 120 },
    FUSS: { warn: null, grenz: 85 }
  };

  function wzIsGreen(rawVal, inkBlinken) {
    const v = Number(rawVal);
    if (!Number.isFinite(v)) return false;
    if (v === 48) return true;
    if (inkBlinken && (v === 16 || v === 32)) return true;
    return false;
  }

  function wzIstBelegt(rawVal) {
    const v = Number(rawVal);
    return Number.isFinite(v) && v > 0;
  }

  // A request starts when the detector becomes occupied while the SG is not green and no request is
  // active.
  // The event ends as soon as the SG becomes green (again).
  // gapTolSek: gaps in the occupancy up to this duration do not interrupt an active request.
  //   Longer gaps end it without a green.
  // holdUntilGreen (pulse detector or push button): the request stays until the next green.
  //   This does not depend on the occupancy.
  //   With short pulse loops the vehicle waits BEHIND the loop at the stop line.
  //   A gap resolution would drop exactly the long wait times that the analysis must find.
  // sgSeries is the series of the signal group (a column or a text array).
  // detOccupied has one flag for each row (see GZ.series.flags).
  function computeWartezeitEvents(times, sgSeries, detOccupied, splRaw, inkBlinken, gapTolSek, holdUntilGreen, exclSpl) {
    const n = times.length;
    const sgGreen = GZ.series.flags(sgSeries, raw => wzIsGreen(raw, inkBlinken));
    const events = [];
    const cancelledTimes = []; // Start times of requests that ended without green.
    let prevBelegt = false, inGreenPeriod = false, waitingForGreen = false;
    let requestStartIdx = -1, letzteBelegtZeit = 0, nAufgeloest = 0;
    for (let i = 0; i < n; i++) {
      const detBelegt = detOccupied[i];
      const sgGruen = sgGreen[i] === 1;

      if (sgGruen && !inGreenPeriod) {
        inGreenPeriod = true;
        if (waitingForGreen) {
          const waitSec = (times[i] - times[requestStartIdx]) / 1000;
          const splVal = splRaw[requestStartIdx];
          const splNum = Number(splVal);
          events.push({
            reqIdx: requestStartIdx, greenIdx: i,
            reqTime: times[requestStartIdx], greenTime: times[i],
            waitSec, spl: splVal,
            excluded: Number.isFinite(splNum) && exclSpl.includes(splNum)
          });
          waitingForGreen = false;
        }
      } else if (!sgGruen) {
        inGreenPeriod = false;
      }

      if (waitingForGreen && !holdUntilGreen) {
        if (detBelegt) {
          letzteBelegtZeit = times[i];
        } else if ((times[i] - letzteBelegtZeit) / 1000 > gapTolSek) {
          nAufgeloest++;
          cancelledTimes.push(times[requestStartIdx]);
          waitingForGreen = false;
        }
      }

      if (detBelegt && !prevBelegt && !waitingForGreen && !sgGruen) {
        waitingForGreen = true;
        requestStartIdx = i;
        letzteBelegtZeit = times[i];
      }
      prevBelegt = detBelegt;
    }

    const unresolved = waitingForGreen
      ? { startIdx: requestStartIdx, startTime: times[requestStartIdx], durationSec: (times[n - 1] - times[requestStartIdx]) / 1000 }
      : null;
    return { events, nAufgeloest, cancelledTimes, unresolved };
  }

  function qualitaetsstufe(waitSec, warnSek, grenzSek) {
    if (waitSec > grenzSek) return 'GRENZWERT';
    if (warnSek != null && waitSec > warnSek) return 'WARNUNG';
    return 'OK';
  }

  const WZ_QUAL_LABEL = { OK: 'OK', WARNUNG: 'Warnung', GRENZWERT: 'Grenzwert überschritten' };

  function txAtTime(t, cycleStarts) {
    if (!cycleStarts || !cycleStarts.length) return null;
    const cs = GZ.segments.findEnclosingCycleStart(t, cycleStarts);
    return cs == null ? null : Math.round((t - cs) / 1000);
  }

  // table is the GZ.table of the recording. idx is the row.
  function auslosenderDetektor(detCols, table, idx) {
    const names = detCols.filter(c => wzIstBelegt(GZ.series.rawAt(table.byIndex.get(c.index), idx))).map(c => c.name);
    return names.length ? names.join(' + ') : '–';
  }

  return {
    wzThresholdDefaults, wzIsGreen, wzIstBelegt, computeWartezeitEvents,
    qualitaetsstufe, WZ_QUAL_LABEL, txAtTime, auslosenderDetektor
  };
});
