/* GZ.configIO — Speichern/Laden der Umlaufprüfung-Konfiguration (Formel-
   Builder + Auswahl-"Layout") als JSON-Datei. Enthält bewusst NICHT die
   Rohdaten selbst (können bei großen Aufzeichnungen bis zu 100k Zeilen
   umfassen) - nur einen kompakten "Fingerabdruck" (Spaltennamen, Zeilen-
   zahl, Zeitraum) zur Prüfung, ob eine gerade geladene CSV zur gespeicherten
   Konfiguration passt. Spaltenverweise in der Konfiguration selbst
   (Formel-Variablen, Auswahl-Listen) sind daher immer Name+Kürzel, nie der
   rohe Spaltenindex - Indizes sind nur innerhalb einer geparsten CSV
   stabil, Namen bleiben es auch über neue Exports derselben Anlage hinweg. */
(function (GZ) {
  'use strict';

  function buildFingerprint(a) {
    if (!a) return null;
    const columnNames = a.allStats.map(s => s.col.name).concat(a.otherColumns.map(c => c.name)).sort();
    return { columnNames, rowCount: a.times.length, tMin: a.tMin, tMax: a.tMax };
  }

  // exact: identische Aufzeichnung (Spalten, Zeilenzahl UND Zeitraum stimmen
  //   überein) - Konfiguration passt mit hoher Sicherheit.
  // columnsMatch: zumindest dieselbe Spaltenstruktur (z.B. derselbe Knoten,
  //   aber ein anderer Aufzeichnungszeitraum) - Namenszuordnung sollte
  //   trotzdem funktionieren, aber sicherheitshalber als Hinweis ausweisen.
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

  GZ.configIO = { buildFingerprint, fingerprintMatches, downloadJson, readJsonFile };
})(window.GZ = window.GZ || {});
