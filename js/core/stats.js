/* GZ.stats has basic statistics helpers.
   They are purely numeric. They do not use an analysis or the DOM. */
GZ.define('stats', { layer: 'domain', deps: [] }, function (GZ) {
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

  // Outlier detection that uses the median absolute deviation (MAD).
  // It is robust against a few strong outliers. A z-score on mean and sigma is not.
  function detectAnomalies(values) {
    if (values.length < 4) return values.map(() => false);
    const med = median(values);
    const madVal = median(values.map(v => Math.abs(v - med)));
    // The absolute minimum tolerance is 2 s.
    // In fixed-time plans almost all green times are equal (MAD -> 0).
    // Without a lower limit, 1 s of measurement jitter is marked as unusual.
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

  // Converts a comma-separated list of numbers ("0,-1,-2" or "16,48") to a number array.
  // The function ignores invalid entries.
  function parseNumListe(s) {
    return String(s || '').split(',')
      .map(t => Number(t.trim()))
      .filter(v => Number.isFinite(v));
  }

  // Natural sort of SPL names. Names that are numbers sort by value. Other names sort
  // alphabetically.
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

  return { mean, median, stdDev, detectAnomalies, percentile, parseNumListe, sortSplList, countLessOrEqual };
});
