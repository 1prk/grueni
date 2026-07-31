/* GZ.wartezeitLogic — Wartezeit ab Anforderung (Detektorbelegung ->
   Freigabebeginn): reine Berechnungslogik, ereignisbasierte Flankenerkennung.
   TX/TU sind nur informativ (siehe txAtTime/computeGlobalTU). */
(function (GZ) {
  'use strict';

  // Voreinstellungen der Bewertungsgrenzen je Signalgruppentyp - reine
  // Orientierungswerte ohne Richtlinienbezug, in der UI überschreibbar
  // (maßgebliche Werte: RiLSA/HBS). Warnung null = keine Warnstufe.
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

  // Anforderung = Detektor wird belegt, während SG nicht grün ist und keine
  // Anforderung bereits läuft. Ereignis endet, sobald SG (wieder) grün wird.
  // gapTolSek: Belegungslücken bis zu dieser Dauer unterbrechen eine laufende
  //   Anforderung nicht; längere Lücken lösen sie ohne Grün auf.
  // holdUntilGreen (Impulsdetektor/Taster): die Anforderung bleibt unabhängig
  //   von der Belegung bis zur nächsten Freigabe bestehen - bei kurzen
  //   Impulsschleifen steht das Fahrzeug HINTER der Schleife an der
  //   Haltlinie, eine Lückenauflösung würde genau die langen Wartezeiten
  //   verwerfen, die gefunden werden sollen.
  function computeWartezeitEvents(times, sgRaw, detOccupied, splRaw, inkBlinken, gapTolSek, holdUntilGreen, exclSpl) {
    const n = times.length;
    const events = [];
    let prevBelegt = false, inGreenPeriod = false, waitingForGreen = false;
    let requestStartIdx = -1, letzteBelegtZeit = 0, nAufgeloest = 0;
    for (let i = 0; i < n; i++) {
      const detBelegt = detOccupied[i];
      const sgGruen = wzIsGreen(sgRaw[i], inkBlinken);

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
    return { events, nAufgeloest, unresolved };
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

  function auslosenderDetektor(detCols, seriesByCol, idx) {
    const names = detCols.filter(c => wzIstBelegt(seriesByCol.get(c.index)[idx])).map(c => c.name);
    return names.length ? names.join(' + ') : '–';
  }

  GZ.wartezeitLogic = {
    wzThresholdDefaults, wzIsGreen, wzIstBelegt, computeWartezeitEvents,
    qualitaetsstufe, WZ_QUAL_LABEL, txAtTime, auslosenderDetektor
  };
})(window.GZ = window.GZ || {});
