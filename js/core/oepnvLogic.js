/* GZ.oepnvLogic — ÖPNV Anmeldung/Abmeldung: reine Berechnungslogik. Eine
   Anmeldung endet entweder regulär mit der Abmeldung (Ist-Fahrzeit gemessen,
   Verlustzeit = Ist-Fahrzeit - Sollfahrzeit) oder wird nach Ablauf der
   Zwangslöschzeit ohne Abmeldung zwangsweise gelöscht. Das LOS (A-F) bewertet
   die Verlustzeit. */
(function (GZ) {
  'use strict';
  const { wzIstBelegt, txAtTime, auslosenderDetektor } = GZ.wartezeitLogic;

  const LOS_LEVELS = ['A', 'B', 'C', 'D', 'E', 'F'];
  // Obergrenzen [s] für LOS A..E (Orientierungswerte ohne Richtlinienbezug, in
  // der UI überschreibbar); LOS F = alles darüber.
  const losDefaultBounds = [5, 10, 20, 35, 50];
  const sollfahrzeitDefault = 15;
  const zwangsloeschDefault = 60;

  function losStufe(verlustSek, bounds) {
    for (let i = 0; i < bounds.length; i++) {
      if (verlustSek <= bounds[i]) return LOS_LEVELS[i];
    }
    return LOS_LEVELS[LOS_LEVELS.length - 1];
  }

  // Alle steigenden Flanken (Belegt-Beginn) einer (ODER-verknüpften)
  // Detektorbelegung als Rohpunkte - unabhängig von der Anmeldung/Abmeldung-
  // Paarungslogik, für die Rohpunkte-Anzeige.
  function risingEdgeTimes(times, occupied) {
    const out = [];
    let prev = false;
    for (let i = 0; i < times.length; i++) {
      if (occupied[i] && !prev) out.push(times[i]);
      prev = occupied[i];
    }
    return out;
  }

  // Anmeldung = Anmeldedetektor(en) werden belegt, während keine Anmeldung
  // läuft (SG-Zustand spielt hier keine Rolle mehr - die Verlustzeit ergibt
  // sich rein aus der gemessenen Fahrzeit An- zu Abmeldung gegenüber der
  // Sollfahrzeit). Endet mit der Abmeldung oder, falls die keine
  // Zwangslöschzeit lang ausbleibt, durch Zwangslöschung.
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
      ? { startIdx, startTime: times[startIdx], durationSec: (times[n - 1] - times[startIdx]) / 1000 }
      : null;
    return { events, unresolved };
  }

  GZ.oepnvLogic = {
    LOS_LEVELS, losDefaultBounds, sollfahrzeitDefault, zwangsloeschDefault,
    losStufe, risingEdgeTimes, computeOepnvEvents,
    wzIstBelegt, txAtTime, auslosenderDetektor
  };
})(window.GZ = window.GZ || {});
