/* GZ.parser — OCIT-Rohtabelle einlesen (Zeile 1-7 Kopf, ab Zeile 8
   Messdaten) und Rohwerte in Signalbild-Kategorien übersetzen.
   Siehe ocit-tabellenstruktur-Referenz für das Tabellenlayout. */
(function (GZ) {
  'use strict';

  const STATE_CAT = {
    0: 'DUNKEL', 1: 'ROT', 2: 'ROT', 3: 'ROT',
    4: 'GELB', 8: 'GELB', 12: 'GELB',
    15: 'ROTGELB', 16: 'GRUEN', 32: 'GRUEN', 48: 'GRUEN'
  };
  const CAT_LABEL = {
    ROT: 'Rot', ROTGELB: 'Rot-Gelb', GELB: 'Gelb', GRUEN: 'Grün',
    DUNKEL: 'Dunkel', UNBEKANNT: 'Unbekannt', INV: 'Ungültig (INV)', LUECKE: 'Datenlücke'
  };

  // OCIT-Typname (Type/Subtype aus der Roh-CSV) -> Kategorie-Kürzel.
  // Die Roh-CSV enthält KEIN fertiges Kürzel wie "SG" - das leitet erst der
  // CSV-Import (VBA: GetTypKategorie -> GetTypAbkuerzung) daraus ab. Type und
  // Subtype können je nach Quelle auf unterschiedliche Kopfzeilen verteilt
  // sein, deshalb werden alle Kopfzeilen je Spalte nach einem bekannten
  // Typnamen durchsucht, statt eine feste Zeile anzunehmen.
  const TYPNAME_TO_KUERZEL = {
    veh: 'SG', tram: 'SG', ped: 'SG', blind: 'SG', cyclist: 'SG', left: 'SG', right: 'SG',
    single_loop: 'DET',
    flasher: 'BLK',
    pt_dir: 'OEPNV',
    ta: 'APW', firmware: 'APW',
    none: 'N/A'
  };

  function looksLikeTimeOnly(s) {
    return /^\d{1,2}:\d{2}:\d{2}$/.test((s || '').trim());
  }

  function parseTimestamp(s) {
    const parts = s.trim().split(/\s+/);
    if (parts.length < 2) throw new Error('Zeitstempel „' + s + '“ nicht im Format DD.MM.YY HH:MM:SS');
    const dmy = parts[0].split('.').map(Number);
    const hms = parts[1].split(':').map(Number);
    if (dmy.length < 3 || hms.length < 3 || dmy.some(isNaN) || hms.some(isNaN)) {
      throw new Error('Zeitstempel „' + s + '“ nicht lesbar');
    }
    const [dd, mm, yy] = dmy, [hh, mi, ss] = hms;
    const year = yy >= 100 ? yy : 2000 + yy; // "26" -> 2026, "2026" bleibt 2026
    return new Date(year, mm - 1, dd, hh, mi, ss).getTime();
  }

  function extractLabeledValue(row, label) {
    const idx = (row || []).findIndex(v => (v || '').trim().toLowerCase() === label.toLowerCase());
    return idx >= 0 ? (row[idx + 1] || '').trim() : '';
  }

  function findColumnByLabel(header, label) {
    for (const row of header) {
      const idx = (row || []).findIndex(v => (v || '').trim().toUpperCase() === label.toUpperCase());
      if (idx >= 0) return idx;
    }
    return -1;
  }

  // Typischer Aufzeichnungsschritt: Median der ersten Zeitdifferenzen statt
  // nur times[1]-times[0] (robust gegen Duplikate/Lücken am Datenanfang).
  function estimateStep(times) {
    if (times.length < 2) return 1000;
    const diffs = [];
    for (let i = 1; i < Math.min(times.length, 200); i++) {
      const d = times[i] - times[i - 1];
      if (d > 0) diffs.push(d);
    }
    return diffs.length ? GZ.stats.median(diffs) : 1000;
  }

  // Kategorisierung eines Rohwerts einer AMPEL(SG)-Spalte (Signalbild-Bitfeld).
  function categorizeSgRaw(raw) {
    if (raw.toUpperCase() === 'INV') return 'INV';
    const num = Number(raw);
    return Number.isFinite(num) ? (STATE_CAT[num] ?? 'UNBEKANNT') : 'UNBEKANNT';
  }
  // Kategorisierung eines Rohwerts einer DETEKTOR(DET)-Spalte: 0 = frei, jeder
  // andere numerische Wert (1 = belegt, sonst Belegungsgrad in %) wird hier
  // vereinfacht als "belegt" gewertet.
  function categorizeDetRaw(raw) {
    if (raw.toUpperCase() === 'INV') return 'INV';
    const num = Number(raw);
    if (!Number.isFinite(num)) return 'UNBEKANNT';
    return num === 0 ? 'FREI' : 'BELEGT';
  }

  // Quote-fähiges Splitting: OCIT-/Excel-Exporte quoten Felder oft
  // ("Longname","Knoten Nord, West"). Naives split(',') zerlegt solche Felder
  // falsch; "" innerhalb eines gequoteten Felds ist ein escaptes
  // Anführungszeichen (RFC 4180).
  function splitLine(l) {
    const delim = l.includes('\t') ? '\t' : ',';
    const out = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (inQuote) {
        if (ch === '"') {
          if (l[i + 1] === '"') { cur += '"'; i++; }
          else inQuote = false;
        } else cur += ch;
      } else if (ch === '"') {
        inQuote = true;
      } else if (ch === delim) {
        out.push(cur); cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  }

  function parseOcitText(text) {
    const lines = text.replace(/\r/g, '').split('\n');
    while (lines.length && lines[lines.length - 1].length === 0) lines.pop();
    if (lines.length < 8) {
      throw new Error('Zu wenige Zeilen – erwartet 7 Kopfzeilen + mindestens 1 Messzeile.');
    }
    const rows = lines.map(splitLine);
    const header = rows.slice(0, 7);
    const dataRows = rows.slice(7);
    const nameRow = header[4] || [];   // Zeile 5: Kurzname der Spalte (K1, K2, DF1, ...)
    const beschrRow = header[5] || []; // Zeile 6: Klartext-Beschreibung
    const colCount = Math.max(...header.map(r => r.length));

    // Zeile 1: Knoten-Metadaten als Label/Wert-Paare, z. B.
    // "Longname",[NAME],"No",[INDEX]
    const knotenName = extractLabeledValue(header[0], 'Longname');
    const knotenNr = extractLabeledValue(header[0], 'No');

    // Spalte C/D/E (0-indiziert 2/3/4) = TX/TC/SP, per Label gesucht mit
    // Spalte 3 (Index 2) als Fallback gemäß Konvention.
    let txCol = findColumnByLabel(header, 'TX');
    if (txCol === -1) txCol = 2;
    let tcCol = findColumnByLabel(header, 'TC');
    if (tcCol === -1) tcCol = 3;
    let splCol = findColumnByLabel(header, 'SP');
    if (splCol === -1) splCol = 4;

    const columns = [];
    const otherColumns = [];
    for (let c = 1; c < colCount; c++) {
      let kuerzel = '', typName = '';
      for (const row of header) {
        const val = (row[c] || '').trim().toLowerCase();
        if (TYPNAME_TO_KUERZEL[val]) {
          kuerzel = TYPNAME_TO_KUERZEL[val];
          typName = val;
          break;
        }
      }
      // Zeile 5 liefert den eigentlichen Signalgruppennamen (z. B. "K1"). In
      // der Praxis steht in Zeile 6 (Beschreibung) oft nur die OCIT-Codierung
      // ohne echten Mehrwert - deshalb ist der Name aus Zeile 5 die primäre
      // Anzeige, Beschreibung nur eine optionale Zusatzinfo.
      const name = (nameRow[c] || '').trim() || `Sp.${c + 1}`;
      const beschreibung = (beschrRow[c] || '').trim();
      if (kuerzel === 'SG') {
        columns.push({ index: c, typName, name, beschreibung });
      } else if (kuerzel) {
        otherColumns.push({ index: c, kuerzel, name, beschreibung });
      }
    }
    if (columns.length === 0) {
      throw new Error('Keine Signalgruppen gefunden – kein bekannter OCIT-Typname (z. B. „veh“, „ped“, „tram“) in den Kopfzeilen erkannt.');
    }

    const times = [];
    const allCols = columns.concat(otherColumns);
    const seriesByCol = new Map(allCols.map(c => [c.index, []]));
    const splValues = [];
    const tcValues = [];
    const cycleStarts = [];
    let prevTx = null;
    let prevTxNum = null;
    // TC und SP werden datensparsam geloggt: ein Wert steht nur in der Zeile,
    // in der er sich ändert, danach bleibt die Zelle leer, bis sich der Wert
    // wieder ändert. Beim Einlesen wird das aufgefüllt (letzter bekannter
    // Wert gilt, bis ein neuer expliziter Wert erscheint).
    let lastTc = '', lastSpl = '';
    let skippedRows = 0;
    for (const r of dataRows) {
      if (!r[0] || !r[0].trim()) { skippedRows++; continue; }
      const tsString = looksLikeTimeOnly(r[1]) ? (r[0] + ' ' + r[1]) : r[0];
      let t;
      try { t = parseTimestamp(tsString); } catch (e) { skippedRows++; continue; }
      times.push(t);
      for (const col of allCols) seriesByCol.get(col.index).push((r[col.index] || '').trim());
      const rawTc = (r[tcCol] || '').trim();
      if (rawTc !== '') lastTc = rawTc;
      tcValues.push(lastTc);
      const rawSpl = (r[splCol] || '').trim();
      if (rawSpl !== '') lastSpl = rawSpl;
      splValues.push(lastSpl);
      const txVal = (r[txCol] || '').trim();
      if (txVal !== '') {
        const txNum = Number(txVal);
        // Normalfall: TX zählt seit Umlaufbeginn hoch und die Zeile mit dem
        // exakten Rücksprung auf "0" markiert den nächsten Umlaufbeginn.
        const isZeroEdge = txVal === '0' && prevTx !== '0';
        // Fallback für Datenlücken: fehlt genau diese "0"-Zeile im Rohexport
        // (z. B. eine ausgelassene Sekunde), springt TX ohne isZeroEdge direkt
        // von einem hohen Wert auf einen kleinen zurück (z. B. 89 -> 1). Ohne
        // diesen Fallback verschmelzen zwei Umläufe unerkannt zu einem
        // einzigen mit verdoppelter Umlaufzeit (z. B. 90s+90s -> 180s).
        const isWrapEdge = !isZeroEdge && Number.isFinite(txNum) && prevTxNum !== null && txNum < prevTxNum;
        if (isZeroEdge || isWrapEdge) cycleStarts.push(t);
        prevTx = txVal;
        if (Number.isFinite(txNum)) prevTxNum = txNum;
      }
    }
    if (times.length === 0) throw new Error('Keine gültigen Zeitstempel gefunden (Spalte A, ggf. + Spalte B als getrennte Uhrzeit).');

    return { columns, otherColumns, times, seriesByCol, splValues, tcValues, totalRows: dataRows.length, skippedRows, knotenName, knotenNr, cycleStarts };
  }

  GZ.parser = {
    STATE_CAT, CAT_LABEL, TYPNAME_TO_KUERZEL,
    parseOcitText, parseTimestamp, looksLikeTimeOnly,
    extractLabeledValue, findColumnByLabel, estimateStep,
    categorizeSgRaw, categorizeDetRaw
  };
})(window.GZ = window.GZ || {});
