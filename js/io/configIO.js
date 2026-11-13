/* GZ.configIO saves and loads the configuration of the cycle check as a JSON file.
   The configuration holds the formula builder and the selection "layout".
   The file does NOT hold the raw data. A big recording can have up to 100,000 rows.
   The file holds a small fingerprint: the column names, the row count and the time range.
   The fingerprint shows if a loaded CSV fits the saved configuration.
   Column references in the configuration are always the name plus the kuerzel.
   They are never the raw column index.
   An index is stable only inside one parsed CSV.
   A name stays stable across new exports of the same installation. */
GZ.define('configIO', { layer: 'io', deps: [] }, function (GZ) {
  'use strict';

  function buildFingerprint(a) {
    if (!a) return null;
    const columnNames = a.allStats.map(s => s.col.name).concat(a.otherColumns.map(c => c.name)).sort();
    return { columnNames, rowCount: a.times.length, tMin: a.tMin, tMax: a.tMax };
  }

  // exact: the same recording. The columns, the row count AND the time range match.
  //   The configuration fits with high confidence.
  // columnsMatch: at least the same column structure.
  //   An example is the same junction with another recording period.
  //   The name mapping must still work. Show a note to be safe.
  function fingerprintMatches(fp, a) {
    const cur = buildFingerprint(a);
    if (!fp || !cur) return { exact: false, columnsMatch: false };
    const columnsMatch = JSON.stringify(fp.columnNames) === JSON.stringify(cur.columnNames);
    const exact = columnsMatch && fp.rowCount === cur.rowCount && fp.tMin === cur.tMin && fp.tMax === cur.tMax;
    return { exact, columnsMatch };
  }

  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = filename;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function readJsonFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try { resolve(JSON.parse(reader.result)); }
        catch (e) { reject(new Error('Ungültiges JSON: ' + e.message)); }
      };
      reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
      reader.readAsText(file, 'utf-8');
    });
  }

  return { buildFingerprint, fingerprintMatches, downloadJson, readJsonFile };
});
