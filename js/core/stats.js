/* GZ.stats — grundlegende Statistik-Helfer (rein numerisch, keine
   Abhängigkeit von der Analyse oder vom DOM). */
(function (GZ) {
  'use strict';

  function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }

  function median(a) {
    const s = [...a].sort((x, y) => x - y), m = s.length;
    return m % 2 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2;
  }

  function stdDev(a) {
    const m = mean(a);
    return Math.sqrt(mean(a.map(v => (v - m) ** 2)));
  }

  // Median-Absolute-Deviation-basierte Ausreißererkennung, robust gegen
  // wenige starke Ausreißer (anders als z-Score auf Basis von Mittelwert/Sigma).
  function detectAnomalies(values) {
    if (values.length < 4) return values.map(() => false);
    const med = median(values);
    const madVal = median(values.map(v => Math.abs(v - med)));
    // Absolute Mindesttoleranz von 2s: Bei Festzeitprogrammen sind fast alle
    // Grünzeiten identisch (MAD -> 0) - ohne Untergrenze würde schon 1s
    // Mess-Jitter als "auffällig" markiert.
    const toleranz = Math.max(3 * 1.4826 * madVal, 2);
    return values.map(v => Math.abs(v - med) > toleranz);
  }

  function percentile(sortedArr, p) {
    const n = sortedArr.length;
    if (n === 0) return 0;
    if (n === 1) return sortedArr[0];
    const rangPos = (p / 100) * (n - 1);
    const lower = Math.floor(rangPos), upper = Math.min(lower + 1, n - 1), frac = rangPos - lower;
    return sortedArr[lower] + frac * (sortedArr[upper] - sortedArr[lower]);
  }

  // Kommagetrennte Zahlenliste ("0,-1,-2" / "16,48") -> Number-Array.
  // Ungültige Einträge werden ignoriert.
  function parseNumListe(s) {
    return String(s || '').split(',')
      .map(t => Number(t.trim()))
      .filter(v => Number.isFinite(v));
  }

  // Natürliche Sortierung von SPL-Bezeichnern (numerisch wenn möglich, sonst alphabetisch).
  function sortSplList(splSet) {
    return [...splSet].sort((a, b) => {
      const na = Number(a), nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a).localeCompare(String(b), 'de');
    });
  }

  function countLessOrEqual(sortedArr, value) {
    let lo = 0, hi = sortedArr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedArr[mid] <= value) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  GZ.stats = { mean, median, stdDev, detectAnomalies, percentile, parseNumListe, sortSplList, countLessOrEqual };
})(window.GZ = window.GZ || {});
