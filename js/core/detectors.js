/* GZ.detectors assigns detectors to signal groups.

   The wait time analysis must know which detectors request which signal group.
   There are three sources, in this order:
   1. Name rule ("name"): IS, DF or RD plus a number (and an optional "_lane")
      belongs to the vehicle or bicycle signal group K<number> or R<number>.
      FT, BT or FTV plus a number belongs to the pedestrian signal group F<number>.
   2. Data check ("data"): a presence detector that requests a signal group
      is occupied before the green start. It stays occupied until shortly after the green start.
      So its occupancy periods span green starts of that signal group.
      The check suggests an assignment when the name rule gives none.
      It shows a warning when a link from the name contradicts the data.
   3. Manual ("manual").
   A detector can belong to several signal groups.
   The detectors of one signal group are combined with OR.

   Detector kinds: "presence" (induction loop, camera field, radar)
   and "pulse" (push button, the request stays until green). */
GZ.define('detectors', { layer: 'domain', deps: ['parser', 'segments', 'series', 'wartezeitLogic'] }, function (GZ) {
  'use strict';
  const { buildSegments } = GZ.segments;
  const { categorizeDetRaw } = GZ.parser;
  const { wzIstBelegt } = GZ.wartezeitLogic;

  const NAME_RULES = [
    { re: /^(IS|DF|RD)(\d+)(?:_(\d+))?$/i, kind: 'presence', prefixes: ['K', 'R'] },
    { re: /^(FT|BT|FTV)(\d+)(?:_(\d+))?$/i, kind: 'pulse', prefixes: ['F'] }
  ];

  // An occupancy period must be at least this long to count in the data check.
  const MIN_OCCUPANCY_SEC = 3;
  // The data check score from which a link counts as confirmed or contradicted.
  const CONFIRMED = 0.8;
  const CONTRADICTED = 0.5;
  // Scores that are this close to the best score count as a tie.
  // An example is two signal groups with a parallel green.
  const TIE_MARGIN = 0.03;

  // Signal group types. Public transport (OCIT type "tram") has its own tab.
  function sgClass(col) {
    switch (col.typName) {
      case 'ped': case 'blind': return 'ped';
      case 'cyclist': return 'bike';
      case 'tram': return 'transit';
      default: return 'veh';
    }
  }

  function kindFromName(name) {
    const rule = NAME_RULES.find(r => r.re.test(name));
    return rule ? rule.kind : 'presence';
  }

  // Returns the names of the signal groups that a detector name points to.
  function nameTargets(name, sgNames) {
    const rule = NAME_RULES.find(r => r.re.test(name));
    if (!rule) return [];
    const number = rule.re.exec(name)[2];
    return rule.prefixes.map(p => p + number).filter(n => sgNames.includes(n));
  }

  /* ---------------- State ---------------- */
  // The holder is the object that keeps the assignment, in the field `detectors`.
  // The store gives it with bind(). The module itself does not know the store.
  let holder = { detectors: null };
  function bind(h) { holder = h; }
  function data() { return holder.detectors; }

  // Call this function once for each new analysis. It builds the detector list and applies the name
  // rule.
  function init(a) {
    const eligible = a.allStats.filter(s => sgClass(s.col) !== 'transit');
    const sgByName = new Map(eligible.map(s => [s.col.name.toUpperCase(), s.col.index]));
    const sgNames = [...sgByName.keys()];
    const list = a.otherColumns.filter(c => c.kuerzel === 'DET').map(col => {
      const targets = nameTargets(col.name, sgNames);
      return {
        col, name: col.name, desc: col.beschreibung && col.beschreibung !== col.name ? col.beschreibung : '',
        kind: kindFromName(col.name),
        links: targets.map(t => ({ sg: sgByName.get(t), via: 'name' })),
        ignored: false
      };
    });
    holder.detectors = { list, cache: { intervals: new Map(), scores: new Map(), occupancy: new Map() } };
  }
  function list() { return data() ? data().list : []; }

  function isLinked(det, sgIndex) { return det.links.some(l => l.sg === sgIndex); }
  function detectorsOf(sgIndex) { return list().filter(d => isLinked(d, sgIndex)); }
  function link(det, sgIndex, via) {
    if (!isLinked(det, sgIndex)) det.links.push({ sg: sgIndex, via });
    det.ignored = false;
  }
  function unlink(det, sgIndex) { det.links = det.links.filter(l => l.sg !== sgIndex); }

  /* ---------------- Data check ---------------- */
  function occupancyIntervals(a, det) {
    const c = data().cache.intervals;
    if (!c.has(det.col.index)) {
      const segs = buildSegments(a.times, a.table.byIndex.get(det.col.index), categorizeDetRaw);
      c.set(det.col.index, segs.filter(s => s.cat === 'BELEGT' && (s.end - s.start) / 1000 >= MIN_OCCUPANCY_SEC));
    }
    return c.get(det.col.index);
  }

  // Returns the share of the occupancy periods of a presence detector that span a green start of
  // the signal group.
  // Returns null for pulse detectors. They have no occupancy period.
  function score(a, det, sgIndex) {
    if (det.kind === 'pulse') return null;
    const key = det.col.index + ':' + sgIndex;
    const c = data().cache.scores;
    if (!c.has(key)) {
      const periods = occupancyIntervals(a, det);
      const entry = a.allStats.find(s => s.col.index === sgIndex);
      const starts = entry.stats.greens.map(g => g.start);
      let hits = 0;
      periods.forEach(p => {
        // The first green start at or after the start of the period.
        let lo = 0, hi = starts.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] < p.start) lo = mid + 1; else hi = mid; }
        if (lo < starts.length && starts[lo] <= p.end) hits++;
      });
      c.set(key, periods.length ? hits / periods.length : 0);
    }
    return c.get(key);
  }

  function eligibleSgs(a) { return a.allStats.filter(s => sgClass(s.col) !== 'transit'); }

  // Returns the best data match for a presence detector.
  // In a (near) tie, a signal group without a detector wins.
  // Returns { sg (column index), score, ties } or null.
  function bestMatch(a, det) {
    if (det.kind === 'pulse') return null;
    const ranked = eligibleSgs(a).map(s => ({ sg: s.col.index, score: score(a, det, s.col.index) })).sort((x, y) => y.score - x.score);
    if (!ranked.length) return null;
    const tied = ranked.filter(x => x.score >= ranked[0].score - TIE_MARGIN);
    const hasDetector = idx => list().some(o => o !== det && isLinked(o, idx));
    const pick = tied.find(x => !hasDetector(x.sg)) || tied[0];
    return { sg: pick.sg, score: pick.score, ties: tied.filter(x => x !== pick).map(x => x.sg) };
  }

  // Occupancy for each sample (OR over the given detectors). The result is a Uint8Array of 0 and 1.
  function occupancy(a, dets) {
    return GZ.series.anyFlag(dets.map(d => a.table.byIndex.get(d.col.index)), wzIstBelegt, a.times.length);
  }

  /* ---------------- Persistence (part of the junction configuration file) ---------------- */
  // References use column names. They never use indices. An index is stable only inside one parsed
  // file.
  function toConfig(a) {
    const nameOf = new Map(a.allStats.map(s => [s.col.index, s.col.name]));
    return {
      links: list().flatMap(d => d.links.map(l => ({ detector: d.name, signalGroup: nameOf.get(l.sg), via: l.via }))),
      ignored: list().filter(d => d.ignored).map(d => d.name)
    };
  }
  // Returns a list of messages for references that do not exist any more.
  function fromConfig(a, cfg) {
    const skipped = [];
    const sgIndexByName = new Map(a.allStats.map(s => [s.col.name, s.col.index]));
    list().forEach(d => { d.links = []; d.ignored = false; });
    (cfg.links || []).forEach(l => {
      const det = list().find(d => d.name === l.detector);
      const sg = sgIndexByName.get(l.signalGroup);
      if (!det) { skipped.push(`Detektor „${l.detector}“`); return; }
      if (sg == null) { skipped.push(`Signalgruppe „${l.signalGroup}“ (Detektor ${l.detector})`); return; }
      link(det, sg, l.via === 'data' || l.via === 'manual' ? l.via : 'name');
    });
    (cfg.ignored || []).forEach(name => { const d = list().find(x => x.name === name); if (d && !d.links.length) d.ignored = true; });
    return skipped;
  }

  return {
    NAME_RULES, CONFIRMED, CONTRADICTED, sgClass, kindFromName, nameTargets,
    bind, init, list, isLinked, detectorsOf, link, unlink, score, bestMatch, eligibleSgs, occupancy, toConfig, fromConfig
  };
});
