/* GZ.sampleData — synthetischer OCIT-Export für die Demo ("Beispieldaten
   laden"): 1 Knoten, 3 Signalgruppen + 1 Detektor, 20 Umläufe à 80s, mit
   einer eingebauten Grünzeit-Anomalie und mehreren Wartezeit-Sonderfällen. */
(function (GZ) {
  'use strict';
  const { fmtDate, fmtTimeOnly } = GZ.format;

  function expandPhases(phases, totalSeconds) {
    const seq = []; let i = 0;
    while (seq.length < totalSeconds) {
      const [dur, val] = phases[i % phases.length];
      for (let k = 0; k < dur && seq.length < totalSeconds; k++) seq.push(val);
      i++;
    }
    return seq;
  }

  function generateSampleText() {
    const CYCLE = 80, TOTAL_S = 1600;
    const K1_PHASES = [[2, 15], [32, 48], [3, 12], [43, 3]];
    const K2_PHASES = [[40, 3], [2, 15], [30, 48], [3, 12], [5, 3]];
    const F1_PHASES = [[6, 3], [24, 48], [50, 3]];

    const k1 = expandPhases(K1_PHASES, TOTAL_S);
    const k2 = expandPhases(K2_PHASES, TOTAL_S);
    const f1 = expandPhases(F1_PHASES, TOTAL_S);

    const anomalyStart = 8 * CYCLE;
    for (let s = 0; s < CYCLE; s++) {
      const t = anomalyStart + s;
      if (s < 2) k1[t] = 15;
      else if (s < 16) k1[t] = 48;
      else if (s < 19) k1[t] = 12;
      else k1[t] = 3;
    }
    // Engineered "Grenzwert"-Beispiel für die Wartezeit-Analyse: Zyklus 12
    // bleibt komplett Rot (simulierter Programmwechsel/Ausfall), damit ein
    // bereits wartendes Fahrzeug > 120s warten muss.
    for (let s = 0; s < CYCLE; s++) k1[12 * CYCLE + s] = 3;

    // D1 (Induktionsschleife K1): Präsenzdetektor-Modell für die
    // Wartezeit-ab-Anforderung-Analyse. Ein Fahrzeug belegt die Schleife ab
    // Ankunft während Rot und bleibt (durchgehend) bis kurz nach Grünbeginn
    // stehen. Mehrere Sonderfälle sind absichtlich eingebaut.
    const d1 = new Array(TOTAL_S).fill(0);
    const GRUEN_START_OFFSET = 2; // Grünbeginn im Zyklus (nach 2s Rot-Gelb)
    const occupy = (fromAbs, toAbsExcl) => {
      for (let t = Math.max(0, fromAbs); t < Math.min(toAbsExcl, TOTAL_S); t++) d1[t] = 1;
    };
    // Normalfälle: Ankunft während Rot, Wartezeit bis zum nächsten Grün.
    const arrivalOffsets = { 0: 70, 1: 65, 2: 73, 3: 60, 4: 75, 5: 68, 6: 71, 7: 64, 9: 69, 10: 66, 13: 72, 14: 63, 16: 67, 17: 70, 18: 65, 19: 69 };
    Object.keys(arrivalOffsets).forEach(cStr => {
      const c = Number(cStr);
      occupy(c * CYCLE + arrivalOffsets[c], (c + 1) * CYCLE + GRUEN_START_OFFSET);
    });
    // Zyklus 8 (bestehende Grünzeit-Anomalie): Ankunft direkt zu Beginn der
    // verlängerten Rotzeit -> etwas längere, aber unauffällige Wartezeit.
    occupy(8 * CYCLE + 19, 9 * CYCLE + GRUEN_START_OFFSET);
    // Zyklen 11->12->13: das Fahrzeug wartet über den komplett roten Zyklus
    // 12 hinweg -> Wartezeit > 120s (Grenzwert überschritten).
    occupy(11 * CYCLE + 40, 13 * CYCLE + GRUEN_START_OFFSET);
    // Gap-Toleranz-Beispiel (Zyklus 5): 2s-Unterbrechung MITTEN in der
    // Wartezeit (< 3s Toleranz) -> zählt trotzdem als EIN zusammenhängendes Ereignis.
    d1[5 * CYCLE + 75] = 0; d1[5 * CYCLE + 76] = 0;
    // "Aufgelöst ohne Grün"-Beispiel (Zyklus 15): kurze Belegung, Fahrzeug
    // fährt weg, bevor die Ampel Grün zeigt (Lücke > 3s Toleranz).
    for (let t = 15 * CYCLE + 70; t < 15 * CYCLE + 74; t++) d1[t] = 1;

    const start = new Date(2026, 6, 8, 8, 14, 0);
    const lines = [];
    // Spaltenlayout wie in der Roh-CSV vor dem CSV-Import (MergeDatumUndZeit):
    // 0=Datum 1=Uhrzeit 2=TX 3=TC 4=SP 5=K1(veh) 6=K2(veh) 7=DF1(ped) 8=D1(single_loop)
    lines.push(['Longname', 'KNOTEN 231 - Bahnhofstr./Ringstr.', 'No', '231', '', '', '', '', ''].join('\t'));
    lines.push(Array(9).fill('').join('\t'));
    lines.push(Array(9).fill('').join('\t'));
    lines.push(['', '', '', '', '', 'veh', 'veh', 'ped', 'single_loop'].join('\t'));
    lines.push(['', '', '', '', '', 'K1', 'K2', 'DF1', 'D1'].join('\t'));
    lines.push(['Beschreibung', '', 'TX', 'TC', 'SP', 'K1 Hauptrichtung Kfz', 'K2 Nebenrichtung Kfz', 'DF1 Fußgänger Nord', 'D1 Induktionsschleife K1'].join('\t'));
    lines.push(Array(9).fill('').join('\t')); // Zeile 7: in Roh-CSV nicht vorhanden (Kürzel wird erst abgeleitet)
    for (let i = 0; i < TOTAL_S; i++) {
      const ts = new Date(start.getTime() + i * 1000);
      const tx = i % CYCLE;
      // TC und SP werden - wie in der echten Roh-CSV - datensparsam geloggt:
      // ein Wert steht nur in der Zeile, in der er sich ändert.
      const tc = (i === 0) ? '4' : '';
      // SPL-Ausschluss-Beispiel: EIN Ereignis (Zyklus 3) fällt kurz in einen
      // ausgeschlossenen Signalprogrammzustand (SPL=0).
      let spl = '';
      if (i === 0) spl = '12';
      else if (i === 3 * CYCLE + 60) spl = '0';
      else if (i === 3 * CYCLE + 61) spl = '12';
      lines.push([fmtDate(ts), fmtTimeOnly(ts), String(tx), tc, spl, k1[i], k2[i], f1[i], d1[i]].join('\t'));
    }
    return lines.join('\n');
  }

  GZ.sampleData = { generateSampleText };
})(window.GZ = window.GZ || {});
