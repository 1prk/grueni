/* GZ.detectors — assignment of detectors to signal groups.

   Wait time analysis needs to know which detectors request which signal group.
   Three sources, in this order:
   1. Name rule ("name"): IS | DF | RD + number [+ "_lane"] belongs to the vehicle
      or bicycle signal group K<number> / R<number>; FT | BT | FTV + number belongs
      to the pedestrian signal group F<number>.
   2. Data check ("data"): a presence detector that requests a signal group is
      occupied before the green start and stays occupied until shortly after it.
      So its occupancy periods span green starts of that signal group.
      The check suggests an assignment when the name rule gives none and
      shows a warning when a name-based link contradicts the data.
   3. Manual ("manual").
   A detector may belong to several signal groups. Several detectors of one
   signal group are combined with OR.

   Detector kinds: "presence" (induction loop, camera field, radar) and
   "pulse" (push button; the request stays until green). */
(function (GZ) {
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
  // Data check score from which a link counts as confirmed / contradicted.
  const CONFIRMED = 0.8;
  const CONTRADICTED = 0.5;
  // Scores this close to the best score count as a tie (for example two
  // signal groups with parallel green).
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

  // Names of the signal groups a detector name points to.
  function nameTargets(name, sgNames) {
    const rule = NAME_RULES.find(r => r.re.test(name));
    if (!rule) return [];
    const number = rule.re.exec(name)[2];
    return rule.prefixes.map(p => p + number).filter(n => sgNames.includes(n));
  }

  /* ---------------- State ---------------- */
  function data() { return GZ.state.data.detectors; }

  // Call once per new analysis. Builds the detector list and applies the name rule.
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
    GZ.state.data.detectors = { list, cache: { intervals: new Map(), scores: new Map(), occupancy: new Map() } };
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
      const segs = buildSegments(a.times, a.seriesByCol.get(det.col.index), categorizeDetRaw);
      c.set(det.col.index, segs.filter(s => s.cat === 'BELEGT' && (s.end - s.start) / 1000 >= MIN_OCCUPANCY_SEC));
    }
    return c.get(det.col.index);
  }

  // Share of the occupancy periods of a presence detector that span a green
  // start of the signal group. null for pulse detectors (no occupancy period).
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
        // first green start at or after the period start
        let lo = 0, hi = starts.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] < p.start) lo = mid + 1; else hi = mid; }
        if (lo < starts.length && starts[lo] <= p.end) hits++;
      });
      c.set(key, periods.length ? hits / periods.length : 0);
    }
    return c.get(key);
  }

  function eligibleSgs(a) { return a.allStats.filter(s => sgClass(s.col) !== 'transit'); }

  // Best data match for a presence detector. On a (near) tie, a signal group
  // without any detector wins. Returns { sg (column index), score, ties } or null.
  function bestMatch(a, det) {
    if (det.kind === 'pulse') return null;
    const ranked = eligibleSgs(a).map(s => ({ sg: s.col.index, score: score(a, det, s.col.index) })).sort((x, y) => y.score - x.score);
    if (!ranked.length) return null;
    const tied = ranked.filter(x => x.score >= ranked[0].score - TIE_MARGIN);
    const hasDetector = idx => list().some(o => o !== det && isLinked(o, idx));
    const pick = tied.find(x => !hasDetector(x.sg)) || tied[0];
    return { sg: pick.sg, score: pick.score, ties: tied.filter(x => x !== pick).map(x => x.sg) };
  }

  // Occupancy per sample (OR over the given detectors).
  function occupancy(a, dets) {
    const series = dets.map(d => a.seriesByCol.get(d.col.index));
    return a.times.map((_, i) => series.some(s => wzIstBelegt(s[i])));
  }

  /* ---------------- Persistence (part of the node configuration file) ---------------- */
  // References use column names, never indices (indices are stable only inside one parsed file).
  function toConfig(a) {
    const nameOf = new Map(a.allStats.map(s => [s.col.index, s.col.name]));
    return {
      links: list().flatMap(d => d.links.map(l => ({ detector: d.name, signalGroup: nameOf.get(l.sg), via: l.via }))),
      ignored: list().filter(d => d.ignored).map(d => d.name)
    };
  }
  // Returns a list of messages for references that no longer exist.
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

  GZ.detectors = {
    NAME_RULES, CONFIRMED, CONTRADICTED, sgClass, kindFromName, nameTargets,
    init, list, isLinked, detectorsOf, link, unlink, score, bestMatch, eligibleSgs, occupancy, toConfig, fromConfig
  };
})(window.GZ = window.GZ || {});
