/* Tests of small helpers that the series consumers use. */
(function () {
  'use strict';
  const GZ = window.GZ, T = window.GZT, assert = T.assert;
  const SG = GZ.segments;

  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }

  T.test('segments: countCycleSgEvents gives the length of the event lists of computeCycleSgEvents', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed);
      const n = 1 + Math.floor(rand() * 12);
      const cycleStarts = [];
      let t = 1000 * Math.floor(rand() * 5);
      for (let i = 0; i < n; i++) { cycleStarts.push(t); t += 10000 * (1 + Math.floor(rand() * 3)); }
      const tMax = t;
      // Green segments in ascending order. Many borders fall exactly on a cycle start.
      const greens = [];
      let pos = cycleStarts[0] - 5000 * Math.floor(rand() * 2);
      while (pos < tMax + 5000) {
        const start = pos + 1000 * Math.floor(rand() * 6);
        const snap = cycleStarts[Math.floor(rand() * n)];
        const end = rand() < 0.4 && snap > start ? snap : start + 1000 * (1 + Math.floor(rand() * 8));
        greens.push({ cat: 'GRUEN', start, end });
        pos = end + 1000 * Math.floor(rand() * 4);
        if (rand() < 0.15 && cycleStarts.includes(pos)) pos += 0;
      }
      const segs = greens.slice();
      const events = SG.computeCycleSgEvents(segs, greens, cycleStarts, tMax);
      const counts = SG.countCycleSgEvents(greens, cycleStarts, tMax);
      assert.equal(counts.an.length, n);
      for (let i = 0; i < n; i++) {
        assert.equal(counts.an[i], events[i].an.length, 'seed ' + seed + ' cycle ' + i + ' An');
        assert.equal(counts.ab[i], events[i].ab.length, 'seed ' + seed + ' cycle ' + i + ' Ab');
      }
    }
    assert.equal(SG.countCycleSgEvents([], [], 0).an.length, 0);
    assert.equal(SG.countCycleSgEvents([], null, 0).an.length, 0);
  });

  T.test('detectors: the occupancy of no detector has one 0 for each row', () => {
    const times = [0, 1000, 2000, 3000];
    const a = { times, table: GZ.series.tableFromStrings(times, new Map([[1, ['0', '1', '1', '0']]])) };
    const none = GZ.detectors.occupancy(a, []);
    assert.equal(none.length, 4);
    assert.same(Array.from(none), [0, 0, 0, 0]);
    const one = GZ.detectors.occupancy(a, [{ col: { index: 1 } }]);
    assert.same(Array.from(one), [0, 1, 1, 0]);
  });
})();
