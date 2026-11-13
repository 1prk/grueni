/* GZ.parser reads the raw OCIT table.
   Lines 1 to 7 are the header. The measurement data starts at line 8.
   The parser also translates raw values into signal image categories.
   For the table layout, see the reference "ocit-tabellenstruktur". */
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

  // Maps an OCIT type name (type or subtype from the raw CSV) to a category abbreviation (kuerzel).
  // The raw CSV has NO ready abbreviation such as "SG". The CSV import derives it.
  // In the VBA import this is GetTypKategorie and then GetTypAbkuerzung.
  // Type and subtype can be in different header lines, depending on the source.
  // So the parser searches all header lines of a column for a known type name.
  // It does not assume a fixed line.
  const TYPNAME_TO_KUERZEL = {
    veh: 'SG', tram: 'SG', ped: 'SG', blind: 'SG', cyclist: 'SG', left: 'SG', right: 'SG',
    single_loop: 'DET',
    flasher: 'BLK',
    pt_dir: 'OEPNV',
    ta: 'APW', firmware: 'APW',
    none: 'N/A'
  };

  // Detector names follow a naming convention.
  // IS means induction loop. DF means camera field. RD means radar.
  // FT, BT and FTV mean pedestrian push button.
  // Each prefix has a number and an optional suffix "_<lane>".
  // A column without a known OCIT type name is still a detector (DET) if its name matches.
  const DETECTOR_NAME_RE = /^(IS|DF|RD|FT|BT|FTV)\d+(?:_\d+)?$/i;

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
    const year = yy >= 100 ? yy : 2000 + yy; // "26" becomes 2026. "2026" stays 2026.
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

  // Typical recording step. It is the median of the first time differences.
  // The code does not use only times[1]-times[0].
  // The median is robust against duplicates and gaps at the start of the data.
  function estimateStep(times) {
    if (times.length < 2) return 1000;
    const diffs = [];
    for (let i = 1; i < Math.min(times.length, 200); i++) {
      const d = times[i] - times[i - 1];
      if (d > 0) diffs.push(d);
    }
    return diffs.length ? GZ.stats.median(diffs) : 1000;
  }

  // Returns the category of a raw value of a signal group (SG) column.
  // The raw value is a bit field of the signal image.
  function categorizeSgRaw(raw) {
    if (raw.toUpperCase() === 'INV') return 'INV';
    const num = Number(raw);
    return Number.isFinite(num) ? (STATE_CAT[num] ?? 'UNBEKANNT') : 'UNBEKANNT';
  }
  // Returns the category of a raw value of a detector (DET) column.
  // The value 0 means free.
  // The code simplifies each other numeric value to "occupied".
  // The value 1 means occupied. Any other value is the degree of occupancy in percent.
  function categorizeDetRaw(raw) {
    if (raw.toUpperCase() === 'INV') return 'INV';
    const num = Number(raw);
    if (!Number.isFinite(num)) return 'UNBEKANNT';
    return num === 0 ? 'FREI' : 'BELEGT';
  }

  // Splits a line and respects quotes.
  // OCIT and Excel exports often put quotes around fields, for example ("Longname","Knoten Nord,
  // West").
  // A simple split(',') splits such fields in the wrong way.
  // Two quotes inside a quoted field are one escaped quote (RFC 4180).
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

  // Header analysis. parseOcitText and GZ.csvImport share it.
  // `header` has the first 7 lines. Each line is split into fields.
  function analyzeHeader(header) {
    const nameRow = header[4] || [];   // Line 5 has the short name of the column (K1, K2, DF1, ...).
    const beschrRow = header[5] || []; // Line 6 has the description in plain text.
    const colCount = Math.max(...header.map(r => r.length));

    // Line 1: junction metadata as label and value pairs.
    // For example: "Longname",[NAME],"No",[INDEX]
    const knotenName = extractLabeledValue(header[0], 'Longname');
    const knotenNr = extractLabeledValue(header[0], 'No');

    // The columns C, D and E (0-based index 2, 3 and 4) are TX, TC and SP.
    // The code searches for each of them by its label.
    // By convention, the fallback is the index 2, 3 and 4.
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
      // Line 5 gives the real signal group name (for example "K1").
      // Line 6 (description) often has only the OCIT code in practice. It adds no value.
      // So the name from line 5 is the main display text.
      // The description is only optional extra information.
      const name = (nameRow[c] || '').trim() || `Sp.${c + 1}`;
      const beschreibung = (beschrRow[c] || '').trim();
      if ((kuerzel === '' || kuerzel === 'N/A') && DETECTOR_NAME_RE.test(name)) { kuerzel = 'DET'; typName = 'detector_by_name'; }
      if (kuerzel === 'SG') {
        columns.push({ index: c, typName, name, beschreibung });
      } else if (kuerzel) {
        otherColumns.push({ index: c, kuerzel, name, beschreibung });
      }
    }
    return { colCount, knotenName, knotenNr, txCol, tcCol, splCol, columns, otherColumns };
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
    const { knotenName, knotenNr, txCol, tcCol, splCol, columns, otherColumns } = analyzeHeader(header);
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
    // The data logger saves TC and SP in a sparing way.
    // A value is only in the row where it changes.
    // After that the cell stays empty until the value changes again.
    // The import fills the gaps. The last known value is valid until a new explicit value appears.
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
        // Normal case: TX counts up from the start of the cycle.
        // The row with the exact jump back to "0" marks the start of the next cycle.
        const isZeroEdge = txVal === '0' && prevTx !== '0';
        // Fallback for data gaps.
        // The "0" row can be missing in the raw export, for example when the data has no row for
        // one second.
        // Then TX jumps from a high value to a small value without isZeroEdge (for example 89 ->
        // 1).
        // Without this fallback, two cycles merge into one cycle with a double cycle time.
        // The merge is not detected. An example is 90 s + 90 s -> 180 s.
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
    STATE_CAT, CAT_LABEL, TYPNAME_TO_KUERZEL, DETECTOR_NAME_RE,
    parseOcitText, parseTimestamp, looksLikeTimeOnly, splitLine, analyzeHeader,
    extractLabeledValue, findColumnByLabel, estimateStep,
    categorizeSgRaw, categorizeDetRaw
  };
})(window.GZ = window.GZ || {});
