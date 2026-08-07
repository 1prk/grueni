/* GZ.oepnvLogic — ÖPNV Anmeldung/Abmeldung: reine Berechnungslogik, analog zu
   wartezeitLogic.js, aber mit getrennten An-/Abmeldedetektoren statt einer
   einzelnen Anforderung. Eine Anmeldung endet entweder mit Erfolg (SG wird
   grün) oder wird ohne Grün wieder abgemeldet (Prioritätsfehlschlag). */
(function (GZ) {
  'use strict';
  const { wzIstBelegt, txAtTime, auslosenderDetektor } = GZ.wartezeitLogic;

  const LOS_LEVELS = ['A', 'B', 'C', 'D', 'E', 'F'];
  // Obergrenzen [s] für LOS A..E (Orientierungswerte ohne Richtlinienbezug, in
  // der UI überschreibbar); LOS F = alles darüber.
  const losDefaultBounds = [5, 10, 20, 35, 50];

  // Freigabe = Dauergrün (Grünblinken zählt hier bewusst nicht als Freigabe).
  function istGruen(rawVal) {
    return Number(rawVal) === 48;
  }

  function losStufe(waitSec, bounds) {
    for (let i = 0; i < bounds.length; i++) {
      if (waitSec <= bounds[i]) return LOS_LEVELS[i];
    }
    return LOS_LEVELS[LOS_LEVELS.length - 1];
  }

  // Anmeldung = Anmeldedetektor(en) werden belegt, während SG nicht grün ist
  // und keine Anmeldung läuft. Ereignis endet mit Erfolg (SG grün) oder -
  // sofern das zuerst eintritt - mit Abmeldung ohne Grün (Prioritätsfehlschlag,
  // z.B. Türkontakt/Hauptmelder löst aus, Fahrzeug verlässt den Meldepunkt
  // ohne Freigabe erhalten zu haben).
  function computeOepnvEvents(times, sgRaw, anOccupied, abOccupied, splRaw, exclSpl) {
    const n = times.length;
    const events = [];
    let prevAn = false, prevAb = false, inGreenPeriod = false, waiting = false, startIdx = -1;

    for (let i = 0; i < n; i++) {
      const anBelegt = anOccupied[i];
      const abBelegt = abOccupied[i];
      const gruen = istGruen(sgRaw[i]);

      if (gruen && !inGreenPeriod) {
        inGreenPeriod = true;
        if (waiting) {
          const splVal = splRaw[startIdx];
          const splNum = Number(splVal);
          events.push({
            type: 'ERFOLG', reqIdx: startIdx, endIdx: i,
            reqTime: times[startIdx], endTime: times[i],
            waitSec: (times[i] - times[startIdx]) / 1000, spl: splVal,
            excluded: Number.isFinite(splNum) && exclSpl.includes(splNum)
          });
          waiting = false;
        }
      } else if (!gruen) {
        inGreenPeriod = false;
      }

      if (waiting && abBelegt && !prevAb) {
        const splVal = splRaw[startIdx];
        const splNum = Number(splVal);
        events.push({
          type: 'ABGEMELDET', reqIdx: startIdx, endIdx: i,
          reqTime: times[startIdx], endTime: times[i],
          waitSec: (times[i] - times[startIdx]) / 1000, spl: splVal,
          excluded: Number.isFinite(splNum) && exclSpl.includes(splNum)
        });
        waiting = false;
      }

      if (anBelegt && !prevAn && !waiting && !gruen) {
        waiting = true;
        startIdx = i;
      }
      prevAn = anBelegt;
      prevAb = abBelegt;
    }

    const unresolved = waiting
      ? { startIdx, startTime: times[startIdx], durationSec: (times[n - 1] - times[startIdx]) / 1000 }
      : null;
    return { events, unresolved };
  }

  GZ.oepnvLogic = {
    LOS_LEVELS, losDefaultBounds, istGruen, losStufe, computeOepnvEvents,
    wzIstBelegt, txAtTime, auslosenderDetektor
  };
})(window.GZ = window.GZ || {});
