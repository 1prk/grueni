/* Tests for the core modules (no browser needed).
   Run: node tests/core.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const ctx = { window: {}, console, Date, Math };
ctx.window.GZ = {};
vm.createContext(ctx);
['format', 'stats', 'parser', 'segments', 'wartezeitLogic', 'slices', 'greenTime', 'detectors', 'logParser', 'sampleData', 'topology'].forEach(name => {
  const file = path.join(root, 'js/core', name + '.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
});
const GZ = ctx.window.GZ;
GZ.state = { data: {} };

// Arrays made inside the vm context have another prototype, so compare as JSON.
const same = (actual, expected) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected));

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); }
  catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + e.message); }
}

/* ---------- Log parser ---------- */
test('log: tab separated line with comma in the timestamp', () => {
  const r = GZ.logs.parse('Info\t03.11.2026, 06:00:01\tlog text');
  assert.strictEqual(r.entries.length, 1);
  const e = r.entries[0];
  assert.strictEqual(e.level, 'Info');
  assert.strictEqual(e.text, 'log text');
  assert.strictEqual(e.severity, 'info');
  same([new Date(e.t).getHours(), new Date(e.t).getMinutes(), new Date(e.t).getSeconds()], [6, 0, 1]);
});
test('log: header line is not an error; broken lines are counted', () => {
  const r = GZ.logs.parse('a\tb\tc\nInfo\t03.11.2026, 06:00:01\tx\nbroken line\n');
  assert.strictEqual(r.entries.length, 1);
  assert.strictEqual(r.skipped, 1);
});
test('log: semicolon file uses only the first three columns', () => {
  const r = GZ.logs.parse('\uFEFFStufe;Zeit;Text;Quelle;Nr\nWarnung;03.11.2026, 06:05:00;text one;Steuergerät;1001\nFehler;03.11.2026, 06:10:00;"quoted; text";x;y\nInfo;03.11.2026, 06:15:00;;only level and time');
  same(r.entries.map(e => [e.level, e.severity, e.text]), [['Warnung', 'warning', 'text one'], ['Fehler', 'error', 'quoted; text'], ['Info', 'info', '']]);
  assert.strictEqual(r.skipped, 0);
});
test('log: comma separated file and ISO date still work (timestamp search)', () => {
  const r = GZ.logs.parse('"Error","03.11.2026, 06:10:00","q, t"\nInfo,2026-11-03 06:15:00,iso');
  same(r.entries.map(e => [e.severity, e.text]), [['error', 'q, t'], ['info', 'iso']]);
});
test('log: levels "Fehler" and "Schwerer Fehler" are different severities', () => {
  const r = GZ.logs.parse('Fehler;03.11.2026, 06:00:00;a\nSchwerer Fehler;03.11.2026, 06:00:01;b\nWarnung;03.11.2026, 06:00:02;c');
  same(r.entries.map(e => e.severity), ['error', 'critical', 'warning']);
});
test('log: visible() filters by range, severity and text', () => {
  GZ.logs.load('Info;03.11.2026, 06:00:00;a b\nFehler;03.11.2026, 06:10:00;c\nInfo;03.11.2026, 06:20:00;d', 'x');
  const t = h => new Date(2026, 10, 3, 6, h).getTime();
  assert.strictEqual(GZ.logs.visible(t(5), t(15)).length, 1);
  GZ.logs.state().hiddenSeverities.add('error');
  assert.strictEqual(GZ.logs.visible().length, 2);
  GZ.logs.state().search = 'D';
  assert.strictEqual(GZ.logs.visible().length, 1);
  GZ.logs.clear();
});
test('log: entries are sorted by time', () => {
  const r = GZ.logs.parse('Info\t03.11.2026, 06:10:00\tlate\nInfo\t03.11.2026, 06:00:00\tearly');
  same(r.entries.map(e => e.text), ['early', 'late']);
});

/* ---------- Detector name rules ---------- */
test('detectors: name rules', () => {
  const D = GZ.detectors;
  same(D.nameTargets('IS1_2', ['K1', 'R1', 'F1']), ['K1', 'R1']);
  same(D.nameTargets('RD12', ['K12']), ['K12']);
  same(D.nameTargets('FTV3', ['F3', 'K3']), ['F3']);
  same(D.nameTargets('DF3', ['K1']), []);
  assert.strictEqual(D.kindFromName('FT1'), 'pulse');
  assert.strictEqual(D.kindFromName('BT2'), 'pulse');
  assert.strictEqual(D.kindFromName('IS1_1'), 'presence');
});

/* ---------- Sample data through the whole core ---------- */
const parsed = GZ.parser.parseOcitText(GZ.sampleData.generateSampleText());
const { columns, otherColumns, times, seriesByCol } = parsed;
const allStats = columns.map(col => {
  const segs = GZ.segments.buildSegments(times, seriesByCol.get(col.index));
  const stats = GZ.segments.computeCycleStats(segs);
  stats.bySpl = GZ.segments.computeCycleStatsBySpl(segs, times, parsed.splValues);
  return { col, segs, stats };
});
const splSet = new Set();
allStats.forEach(s => s.stats.bySpl.forEach((_, k) => splSet.add(k)));
const a = {
  allStats, tMin: times[0], tMax: times[times.length - 1] + 1000, cycleStarts: parsed.cycleStarts, otherColumns,
  times, seriesByCol, splValues: parsed.splValues, splList: GZ.stats.sortSplList(splSet)
};
GZ.state.data.currentAnalysis = a;

test('parser: detectors and signal groups of the sample', () => {
  same(columns.map(c => c.name), ['K1', 'K2', 'F1', 'S1']);
  assert.strictEqual(otherColumns.filter(c => c.kuerzel === 'DET').length, 7);
});

const model = GZ.greenTime.build(a);
const sg = name => model.sgs.find(s => s.col.name === name);
test('green time: fixed in plan 14, actuated in plan 12', () => {
  assert.strictEqual(GZ.greenTime.plantActuated(model, '12'), true);
  assert.strictEqual(GZ.greenTime.plantActuated(model, '14'), false);
});
test('green time: one intervention does not turn a fixed plan into an actuated one', () => {
  const st = GZ.greenTime.stats(model, sg('K1'), '14');
  assert.strictEqual(st.n, 80);
  assert.strictEqual(st.min, 22);          // the intervention
  assert.strictEqual(st.isFixed, true);    // 79 of 80 within median ± 1 s
  assert.strictEqual(GZ.greenTime.behaviour(st), 'Beginn und Ende fest');
});
test('green time: pedestrian group is fixed but only on demand', () => {
  const st = GZ.greenTime.stats(model, sg('F1'), null);
  assert.strictEqual(st.isFixed, true);
  assert.ok(st.cyclesWithGreen < st.total);
});
test('green time: K1 keeps its start, the end moves', () => {
  assert.strictEqual(GZ.greenTime.behaviour(GZ.greenTime.stats(model, sg('K1'), '12')), 'Beginn fest · Ende variabel');
});
test('green time: tolerance and share are parameters', () => {
  GZ.greenTime.params.fixedShare = 100;
  assert.strictEqual(GZ.greenTime.stats(model, sg('K1'), '14').isFixed, false);
  GZ.greenTime.params.fixedShare = 95;
});

const slices = GZ.slices.build(a);
test('slices: four full hours, two plans', () => {
  assert.strictEqual(slices.hours.length, 4);
  same(slices.plans.map(p => p.key), ['12', '14']);
  assert.strictEqual(slices.hours[0].label, '06:00–07:00');
});

GZ.detectors.init(a);
const detector = name => GZ.detectors.list().find(d => d.name === name);
const sgIndex = name => allStats.find(s => s.col.name === name).col.index;
test('detectors: name rule assigns IS1_1, IS2, FT1', () => {
  same(detector('IS1_1').links.map(l => l.sg), [sgIndex('K1')]);
  same(detector('IS2').links.map(l => l.sg), [sgIndex('K2')]);
  same(detector('FT1').links.map(l => l.sg), [sgIndex('F1')]);
  assert.strictEqual(detector('FT1').kind, 'pulse');
  assert.strictEqual(detector('DF3').links.length, 0);
});
test('detectors: data check confirms good links and contradicts the wrong name', () => {
  const D = GZ.detectors;
  assert.ok(D.score(a, detector('IS2'), sgIndex('K2')) > 0.9);
  assert.ok(D.score(a, detector('RD2'), sgIndex('K2')) < 0.5);       // named like K2 ...
  assert.ok(D.score(a, detector('RD2'), sgIndex('K1')) > 0.9);       // ... but measures K1
  assert.strictEqual(D.bestMatch(a, detector('RD2')).sg, sgIndex('K1'));
});
test('detectors: DF3 (no name rule) is suggested for K2; the counting loop has no match', () => {
  const D = GZ.detectors;
  assert.strictEqual(D.bestMatch(a, detector('DF3')).sg, sgIndex('K2'));
  assert.ok(D.bestMatch(a, detector('IS9')).score < 0.5);
  assert.strictEqual(D.bestMatch(a, detector('FT1')), null);          // pulse detectors have no data check
});
test('detectors: configuration round trip uses names', () => {
  const D = GZ.detectors;
  D.link(detector('DF3'), sgIndex('K2'), 'data');
  const cfg = D.toConfig(a);
  assert.ok(cfg.links.some(l => l.detector === 'DF3' && l.signalGroup === 'K2' && l.via === 'data'));
  D.init(a);
  assert.strictEqual(detector('DF3').links.length, 0);
  same(D.fromConfig(a, cfg), []);
  assert.strictEqual(detector('DF3').links.length, 1);
});

test('wait time: pulse detector holds the request until green', () => {
  const D = GZ.detectors, WL = GZ.wartezeitLogic;
  const f1 = allStats.find(s => s.col.name === 'F1');
  const dets = D.detectorsOf(f1.col.index);
  const r = WL.computeWartezeitEvents(times, seriesByCol.get(f1.col.index), D.occupancy(a, dets), parsed.splValues, false, 3, true, []);
  assert.ok(r.events.length > 100);
  assert.strictEqual(r.nAufgeloest, 0);
  assert.ok(Math.max(...r.events.map(e => e.waitSec)) > 85);
});

/* ---------- Dark period: TX stops, the whole dark block becomes one long "cycle" ---------- */
test('green time: a dark period without TX gives one irregular cycle that is left out of the statistics', () => {
  const lines = GZ.sampleData.generateSampleText().split('\n');
  const out = lines.slice(0, 7);
  for (let i = 7; i < lines.length; i++) {
    const f = lines[i].split('\t'), sec = i - 7;
    if (sec >= 7200 && sec < 9000) { f[2] = '0'; for (let c = 5; c <= 8; c++) f[c] = '0'; }   // 08:00-08:30 dark, TX frozen
    out.push(f.join('\t'));
  }
  const p2 = GZ.parser.parseOcitText(out.join('\n'));
  const stats2 = p2.columns.map(col => {
    const segs = GZ.segments.buildSegments(p2.times, p2.seriesByCol.get(col.index));
    return { col, segs, stats: GZ.segments.computeCycleStats(segs) };
  });
  const a2 = Object.assign({}, a, { allStats: stats2, cycleStarts: p2.cycleStarts, times: p2.times, seriesByCol: p2.seriesByCol, splValues: p2.splValues, tMin: p2.times[0], tMax: p2.times[p2.times.length - 1] + 1000 });
  const m2 = GZ.greenTime.build(a2);
  assert.strictEqual(m2.irregularCount, 1);
  const long = m2.cycles.filter(c => !c.regular)[0];
  assert.ok(long.tu > 1500 && long.tu < 2000);
  assert.ok(GZ.greenTime.cycleTimes(m2, null).max < 200);   // the dark block is not in the cycle time statistics
});


/* ---------- Topology ---------- */
const T = GZ.topology;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ` expected ${b} got ${a}`);

test('topology: spline passes through the control points and has no gaps', () => {
  const pts = [{ x: 0, y: 0 }, { x: 20, y: 10 }, { x: 40, y: 0 }];
  const poly = T.cleanPoly(T.sampleSpline(pts, 1));
  near(poly[0].x, 0, 1e-9); near(poly[poly.length - 1].x, 40, 1e-9);
  assert.ok(poly.some(p => Math.hypot(p.x - 20, p.y - 10) < 1e-6), 'middle point on the curve');
  for (let i = 1; i < poly.length; i++) assert.ok(Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y) < 1.6);
});

test('topology: offset curve keeps the distance to the source', () => {
  const poly = T.cleanPoly(T.sampleSpline([{ x: 0, y: 0 }, { x: 30, y: 8 }, { x: 60, y: 0 }], 1));
  const cl = T.cumLen(poly);
  const left = T.offsetPoly(poly, 3.5);
  left.forEach(p => near(T.projectOnPoly(poly, cl, p).d, 3.5, 0.15, 'distance'));
  // left of a line that runs east is north
  const line = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
  near(T.offsetPoly(line, 2)[0].y, 2, 1e-9);
});

test('topology: crossing of two axes gives four arms, ordered clockwise from north', () => {
  const m = T.create();
  T.addAxis(m, [{ x: -80, y: 0 }, { x: 0, y: 0 }, { x: 80, y: 0 }]);
  T.addAxis(m, [{ x: 0, y: -80 }, { x: 0, y: 0 }, { x: 0, y: 80 }]);
  const d = T.derive(m);
  near(d.center.x, 0, 1e-6); near(d.center.y, 0, 1e-6);
  assert.strictEqual(d.arms.length, 4);
  same(d.arms.map(a => a.name), ['Nord', 'Ost', 'Süd', 'West']);
  same(d.arms.map(a => a.approachId), [1, 2, 3, 4]);
});

test('topology: a T junction gives three arms; one axis gives two', () => {
  const t = T.create();
  T.addAxis(t, [{ x: -80, y: 0 }, { x: 0, y: 0 }, { x: 80, y: 0 }]);
  T.addAxis(t, [{ x: 0, y: 0 }, { x: 0, y: -80 }]);
  assert.strictEqual(T.derive(t).arms.length, 3);
  const one = T.create();
  T.addAxis(one, [{ x: -50, y: 0 }, { x: 50, y: 0 }]);
  assert.strictEqual(T.derive(one).arms.length, 2);
});

test('topology: ingress lanes are left, egress lanes right of the outward direction', () => {
  const m = T.create();
  T.addAxis(m, [{ x: -80, y: 0 }, { x: 80, y: 0 }]);
  T.addAxis(m, [{ x: 0, y: -80 }, { x: 0, y: 80 }]);
  T.ensureDefaults(m, T.derive(m));
  const d = T.derive(m);
  const north = d.arms.find(a => a.name === 'Nord');
  assert.ok(north.in[0].startPt.x < 0, 'ingress of the north arm is west of the axis');
  assert.ok(north.out[0].startPt.x > 0, 'egress of the north arm is east of the axis');
  near(north.in[0].startPt.y, north.stopDist, 0.05);
  near(Math.abs(north.in[0].startPt.x), 3.25 / 2, 1e-6);
});

test('topology: lane counts, offsets and removal of connections', () => {
  const m = T.create();
  T.addAxis(m, [{ x: -80, y: 0 }, { x: 80, y: 0 }]);
  T.addAxis(m, [{ x: 0, y: -80 }, { x: 0, y: 80 }]);
  T.ensureDefaults(m, T.derive(m));
  let d = T.derive(m);
  const key = d.arms.find(a => a.name === 'Nord').key;
  T.setLaneCount(m, key, 'in', 3);
  d = T.derive(m);
  const n = d.arms.find(a => a.key === key);
  assert.strictEqual(n.in.length, 3);
  near(Math.abs(n.in[2].startPt.x), 3.25 * 2.5, 1e-6);
  const south = d.arms.find(a => a.name === 'Süd');
  const c = T.addConnection(m, n.in[2].lane.id, south.out[0].lane.id);
  assert.ok(c && m.connections.length === 1);
  assert.strictEqual(T.addConnection(m, n.in[2].lane.id, south.out[0].lane.id), c, 'no duplicate');
  assert.strictEqual(T.addConnection(m, south.out[0].lane.id, n.in[2].lane.id), null, 'wrong direction');
  T.setLaneCount(m, key, 'in', 1);
  assert.strictEqual(m.connections.length, 0, 'connection of a removed lane is removed');
});

test('topology: maneuver from the heading change', () => {
  const m = T.create();
  T.exampleCrossing(m);
  const d = T.derive(m);
  const north = d.arms.find(a => a.name === 'Nord');
  const find = name => d.arms.find(a => a.name === name).out[0];
  assert.strictEqual(T.connectionManeuver(north.in[0], find('Süd')), 'straight');
  // coming from the north (driving south): west is on the right-hand side
  assert.strictEqual(T.connectionManeuver(north.in[0], find('West')), 'right');
  assert.strictEqual(T.connectionManeuver(north.in[0], find('Ost')), 'left');
});

test('topology: proposed connections give every ingress lane a target', () => {
  const m = T.create();
  const d = T.exampleCrossing(m);
  d.arms.forEach(arm => arm.in.forEach(g => assert.ok(m.connections.some(c => c.from === g.lane.id), arm.name + ' ' + g.label)));
  assert.ok(d.arms.every(a => a.cross), 'crossings');
  // leftmost lane turns left, rightmost lane goes straight and right
  const north = d.arms.find(a => a.name === 'Nord');
  assert.ok(T.laneManeuvers(m, d, north.in[0].lane.id).has('left'));
  assert.ok(T.laneManeuvers(m, d, north.in[1].lane.id).has('right'));
  assert.ok(!T.laneManeuvers(m, d, north.in[1].lane.id).has('left'));
});

test('topology: junction outline is closed', () => {
  const m = T.create();
  const d = T.exampleCrossing(m);
  const cmds = T.junctionOutline(d.arms);
  assert.strictEqual(cmds[0].type, 'M');
  assert.strictEqual(cmds[cmds.length - 1].type, 'Z');
  assert.strictEqual(cmds.filter(c => c.type === 'Q').length, 4);
});

test('topology: config round trip keeps the model and the id counters', () => {
  const m = T.create();
  T.exampleCrossing(m);
  m.lanes[0].sgs = ['K1']; m.lanes[0].detectors = ['DF1'];
  const cfg = JSON.parse(JSON.stringify(T.toConfig(m)));
  const m2 = T.fromConfig(cfg);
  same(T.toConfig(m2), cfg);
  const lane = T.setLaneCount(m2, T.derive(m2).arms[0].key, 'in', 5);
  const ids = m2.lanes.map(l => l.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'ids stay unique');
  // broken input does not throw
  T.fromConfig({ axes: [{ id: 'A1', points: [{ x: 1 }] }], lanes: [{ id: 'L1' }], connections: [{ id: 'V1', from: 'x', to: 'y' }] });
  T.fromConfig(null);
});

test('topology: removing an axis removes its arms, lanes and connections', () => {
  const m = T.create();
  T.exampleCrossing(m);
  T.removeAxis(m, 'A1');
  assert.ok(m.lanes.every(l => !l.armKey.startsWith('A1:')));
  assert.ok(m.crosswalks.every(c => !c.armKey.startsWith('A1:')));
  const ids = new Set(m.lanes.map(l => l.id));
  assert.ok(m.connections.every(c => ids.has(c.from) && ids.has(c.to)));
});

test('topology: MAPEM export has unique lane ids, delta nodes and signal groups', () => {
  const m = T.create();
  const d = T.exampleCrossing(m);
  const north = d.arms.find(a => a.name === 'Nord');
  north.in[0].lane.sgs = ['K2'];
  north.in[1].lane.sgs = ['K3'];
  d.arms.find(a => a.name === 'Süd').cross.cw.sgs = ['F1'];
  m.refLat = 48.1; m.refLon = 11.5;
  const out = T.toMapem(m, T.derive(m));
  const set = out.map.intersections[0].laneSet;
  const ids = set.map(l => l.laneID);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(ids.every(i => i >= 1 && i <= 255));
  assert.strictEqual(out.map.intersections[0].refPoint.lat, 481000000);
  const lane = set.find(l => l.name === 'Nord Z1');
  assert.strictEqual(lane.ingressApproach, 1);
  assert.ok(lane.connectsTo.length > 0 && lane.connectsTo.every(c => c.signalGroup === 2));
  assert.ok(lane.nodeList.nodes.length >= 2);
  // the first node of an ingress lane is the stop line point (relative to the reference point, in cm)
  const first = lane.nodeList.nodes[0].delta['node-XY'];
  near(first.y, Math.round(north.in[0].startPt.y * 100), 1);
  assert.ok(set.some(l => l.laneAttributes.laneType.crosswalk && l.connectsTo && l.connectsTo[0].signalGroup));
  same(out.signalGroups.map(g => g.name), ['F1', 'K2', 'K3']);
});

test('topology: simplify keeps the end points and removes straight points', () => {
  const poly = [{ x: 0, y: 0 }, { x: 5, y: 0.01 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
  const s = T.simplify(poly, 0.1);
  assert.strictEqual(s.length, 3);
  assert.strictEqual(s[0].x, 0); assert.strictEqual(s[2].y, 10);
});

test('topology: a short inner lane tapers to zero width and leaves an island', () => {
  const m = T.create();
  T.addAxis(m, [{ x: -90, y: 0 }, { x: 90, y: 0 }]);
  T.addAxis(m, [{ x: 0, y: -90 }, { x: 0, y: 90 }]);
  T.ensureDefaults(m, T.derive(m));
  const key = T.derive(m).arms.find(a => a.name === 'Nord').key;
  T.setLaneCount(m, key, 'in', 3);
  T.lanesOf(m, key, 'in')[0].length = 20;
  const arm = T.derive(m).arms.find(a => a.key === key);
  const g = arm.in[0];
  assert.ok(g.cut && g.cut.anchor === 'outer');
  near(T.polyLength(g.path), 20 + T.DEFAULTS.taper / 2, 0.6);
  const o = T.laneOutline(g);
  const width = i => Math.hypot(o.innerEdge[i].x - o.outerEdge[i].x, o.innerEdge[i].y - o.outerEdge[i].y);
  near(width(0), 3.25, 1e-6, 'full width at the stop line');
  near(width(o.innerEdge.length - 1), 0, 0.01, 'zero width at the end of the taper');
  const surf = T.armSurfaces(arm);
  assert.strictEqual(surf.freed.length, 1, 'the freed width becomes island');
  // the middle lane can not be short, the outermost lane anchors at its inner side
  T.lanesOf(m, key, 'in')[1].length = 10;
  assert.strictEqual(T.derive(m).arms.find(a => a.key === key).in[1].cut, null);
  T.lanesOf(m, key, 'in')[2].length = 15;
  assert.strictEqual(T.derive(m).arms.find(a => a.key === key).in[2].cut.anchor, 'inner');
  // a lane alone in its direction ignores the length
  T.setLaneCount(m, key, 'out', 1);
  T.lanesOf(m, key, 'out')[0].length = 10;
  assert.strictEqual(T.derive(m).arms.find(a => a.key === key).out[0].cut, null);
});

test('topology: a median gap gives an island with pointed ends', () => {
  const m = T.create();
  T.addAxis(m, [{ x: -90, y: 0 }, { x: 90, y: 0 }]);
  T.addAxis(m, [{ x: 0, y: -90 }, { x: 0, y: 90 }]);
  T.ensureDefaults(m, T.derive(m));
  const key = T.derive(m).arms.find(a => a.name === 'Ost').key;
  assert.strictEqual(T.armSurfaces(T.derive(m).arms.find(a => a.key === key)).island, null, 'no gap, no island');
  m.arms[key].gap = 3;
  const arm = T.derive(m).arms.find(a => a.key === key);
  const surf = T.armSurfaces(arm);
  assert.ok(surf.island && surf.gapBase && surf.walk);
  const xs = surf.island.map(p => p.y);       // east arm: the island width runs along y
  near(Math.max(...xs) - Math.min(...xs), 3, 0.05, 'island is as wide as the gap');
  // lanes keep their place: the first ingress lane starts half the gap plus half a lane from the axis
  near(arm.in[0].startPt.y, 1.5 + 3.25 / 2, 0.1);
  near(Math.hypot(surf.island[0].x - surf.island[surf.island.length - 1].x, surf.island[0].y - surf.island[surf.island.length - 1].y), 0, 0.01, 'pointed nose');
});

test('topology: lane length and median settings survive the config round trip', () => {
  const m = T.create();
  T.exampleCrossing(m);
  const lane = m.lanes.find(l => l.length);
  assert.ok(lane, 'the example has a turning lane');
  const m2 = T.fromConfig(JSON.parse(JSON.stringify(T.toConfig(m))));
  assert.strictEqual(m2.lanes.find(l => l.id === lane.id).length, lane.length);
  assert.ok(Object.values(m2.arms).some(a => a.gap === 3 && a.islandLen === 40));
});

test('topology: a stadium has round half-circle ends', () => {
  const path = [{ x: 0, y: 0 }, { x: 20, y: 0 }];
  const poly = T.stadiumPolygon(path, 1.5);
  const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
  near(Math.min(...xs), 0, 1e-6); near(Math.max(...xs), 20, 1e-6);
  near(Math.max(...ys), 1.5, 1e-6); near(Math.min(...ys), -1.5, 1e-6);
  // every point of the cap is on the circle around (1.5, 0)
  poly.filter(p => p.x < 1.5).forEach(p => near(Math.hypot(p.x - 1.5, p.y), 1.5, 0.02, 'cap point'));
  assert.ok(poly.filter(p => p.x < 1.5).length >= 8, 'dense enough for a smooth cap');
  // a path shorter than the diameter gets a smaller radius
  const short = T.stadiumPolygon([{ x: 0, y: 0 }, { x: 2, y: 0 }], 1.5);
  near(Math.max(...short.map(p => p.y)), 1, 1e-6);
});

test('topology: rounded corners only change the flagged points', () => {
  const sq = [{ x: 0, y: 0, round: true }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const r = T.roundCorners(sq, 2);
  assert.ok(r.length > 4);
  assert.ok(r.some(p => p.x === 10 && p.y === 0), 'sharp corner stays');
  assert.ok(!r.some(p => p.x === 0 && p.y === 0), 'rounded corner is cut');
});

test('topology: a free right turn gives a triangle island between slip lane and through lanes', () => {
  const m = T.create();
  const d = T.exampleCrossing(m);
  const islands = T.freeRightIslands(d);
  assert.strictEqual(islands.length, 1, 'the north arm has a free right turn');
  const north = d.arms.find(a => a.name === 'Nord');
  const pair = T.freeRightPair(d, north);
  assert.strictEqual(pair.prev.name, 'West');
  assert.strictEqual(pair.slip, north.in[1]);
  // the slip lane only turns right
  const fromSlip = m.connections.filter(c => c.from === pair.slip.lane.id);
  assert.strictEqual(fromSlip.length, 1);
  assert.strictEqual(T.connectionManeuver(pair.slip, d.arms.find(a => a.name === 'West').out[0]), 'right');
  // the island lies between the slip lane and the through lane: x between the lane boundary and the slip lane
  const isl = islands.find(i => i.armKey === north.key).polygon;
  const slipInner = Math.abs(north.in[1].startPt.x) - 3.25 / 2;   // inner edge of the slip lane
  isl.forEach(p => assert.ok(p.x <= -slipInner + T.DEFAULTS.triTip, 'island stays at the lane boundary (the noses may reach a little into the through lane)'));
  assert.ok(isl.length > 10);
  const info = T.freeRightIslands(d).find(i => i.armKey === north.key);
  assert.ok(info.r > 0.3 && info.r <= T.DEFAULTS.triRound, 'rounding radius');
  // the slip lane keeps its width: the curved side stays at the lane width from the kerb
  const [dSlip, dEgress] = info.widths;
  near(dSlip, 3.25, 1e-6);
  const lo = Math.min(dSlip, dEgress) - 0.2, hi = Math.max(dSlip, dEgress) + 0.2;
  info.curve.forEach(q => {
    const dd = Math.min(...info.kerb.map(k => Math.hypot(k.x - q.x, k.y - q.y)));
    assert.ok(dd >= lo && dd <= hi, `distance to the kerb ${dd.toFixed(2)} should be between ${lo.toFixed(2)} and ${hi.toFixed(2)}`);
  });
  // the receiving arm needs two vehicle egress lanes
  const west = d.arms.find(a => a.name === 'West');
  T.setLaneCount(m, west.key, 'out', 2);          // vehicle + bike: only one vehicle lane
  assert.strictEqual(T.freeRightPair(T.derive(m), T.derive(m).arms.find(a => a.key === north.key)), null);
  T.setLaneCount(m, west.key, 'out', 3);
  // an arm with one ingress lane has no free right turn
  const south = d.arms.find(a => a.name === 'Süd');
  T.setLaneCount(m, south.key, 'in', 1);
  assert.strictEqual(T.freeRightPair(T.derive(m), T.derive(m).arms.find(a => a.key === south.key)), null);
});

test('topology: applyFreeRight rewires the slip lane and can be switched off', () => {
  const m = T.create();
  T.addAxis(m, [{ x: -90, y: 0 }, { x: 90, y: 0 }]);
  T.addAxis(m, [{ x: 0, y: -90 }, { x: 0, y: 90 }]);
  T.ensureDefaults(m, T.derive(m));
  const key = T.derive(m).arms.find(a => a.name === 'Nord').key;
  T.setLaneCount(m, key, 'in', 2);
  T.setLaneCount(m, T.derive(m).arms.find(a => a.name === 'West').key, 'out', 2);   // the slip lane needs its own egress lane
  let d = T.derive(m);
  T.proposeConnections(m, d).forEach(c => T.addConnection(m, c.from, c.to));
  const slipId = d.arms.find(a => a.key === key).in[1].lane.id;
  assert.ok(m.connections.filter(c => c.from === slipId).length >= 2, 'before: straight and right');
  T.applyFreeRight(m, d, key, true);
  assert.strictEqual(m.connections.filter(c => c.from === slipId).length, 1);
  d = T.derive(m);
  assert.strictEqual(T.freeRightIslands(d).length, 1);
  T.applyFreeRight(m, d, key, false);
  assert.strictEqual(T.freeRightIslands(T.derive(m)).length, 0);
});

test('topology: insetting a polygon moves every edge inward by the distance', () => {
  const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const a = T.insetPolygon(sq, 1);
  same(a.map(p => [p.x, p.y]), [[1, 1], [9, 1], [9, 9], [1, 9]]);
  const cw = T.insetPolygon(sq.slice().reverse(), 1);          // the orientation does not matter
  assert.ok(cw.every(p => p.x > 0.99 && p.x < 9.01 && p.y > 0.99 && p.y < 9.01));
  // a thin triangle gets a radius that fits inside
  const tri = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 2 }];
  assert.ok(T.fitRadius(tri, 5) < 1);
  assert.strictEqual(T.fitRadius(sq, 0.5), 0.5);
});

test('topology: lanes never touch an island or a kerb inside the junction (example)', () => {
  const m = T.create();
  const d = T.exampleCrossing(m);
  const issues = T.connectionIssues(m, d);
  same(issues.map(i => i.connId + ':' + i.kind), []);
});

test('topology: the egress lane of a free right turn is reserved for the slip lane', () => {
  const m = T.create();
  const d = T.exampleCrossing(m);
  const north = d.arms.find(a => a.name === 'Nord');
  const pair = T.freeRightPair(d, north);
  const into = m.connections.filter(c => c.to === pair.target.lane.id);
  same(into.map(c => c.from), [pair.slip.lane.id]);
});

test('topology: a connection that crosses an island is found', () => {
  const m = T.create();
  const d = T.exampleCrossing(m);
  const east = d.arms.find(a => a.name === 'Ost'), west = d.arms.find(a => a.name === 'West');
  // through traffic into the egress lane of the slip lane has to cross the triangle island
  const c = T.addConnection(m, east.in[1].lane.id, west.out[2].lane.id);
  const issues = T.connectionIssues(m, T.derive(m));
  assert.ok(issues.some(i => i.connId === c.id && i.kind === 'island'), 'found');
  // the path of the slip lane itself keeps its distance to the kerb: it is not reported
  const slip = m.connections.find(x => x.from === T.freeRightPair(d, d.arms.find(a => a.name === 'Nord')).slip.lane.id);
  assert.ok(!issues.some(i => i.connId === slip.id));
});

test('topology: a straight movement with a sideways shift is in line before the corner', () => {
  const m = T.create();
  const d = T.exampleCrossing(m);
  const g = T.allLaneGeoms(d);
  const c = m.connections.find(x => g.get(x.from).arm.name === 'Ost' && g.get(x.from).label === 'Z3' && g.get(x.to).arm.name === 'West');
  const line = T.connectionPolyline(m, d, c);
  const end = line[line.length - 1];
  const late = line.filter(p => p.x < 0).map(p => Math.abs(p.y - end.y) / Math.abs(line[0].y - end.y));
  assert.ok(Math.max(...late) < 0.45, 'most of the shift is done at the centre');
});

test('topology: driving lines are smooth and leave and enter the lanes straight', () => {
  const m = T.create();
  const d = T.exampleCrossing(m);
  const g = T.allLaneGeoms(d);
  m.connections.forEach(c => {
    const line = T.connectionPolyline(m, d, c);
    const a = g.get(c.from), b = g.get(c.to);
    // start and end on the lane centre lines
    near(Math.hypot(line[0].x - a.startPt.x, line[0].y - a.startPt.y), 0, 0.05, c.id + ' start');
    near(Math.hypot(line[line.length - 1].x - b.startPt.x, line[line.length - 1].y - b.startPt.y), 0, 0.05, c.id + ' end');
    // no kink: the heading changes by less than 4 degrees from one sample to the next
    let worst = 0;
    for (let i = 2; i < line.length; i++) {
      const h1 = Math.atan2(line[i - 1].y - line[i - 2].y, line[i - 1].x - line[i - 2].x), h2 = Math.atan2(line[i].y - line[i - 1].y, line[i].x - line[i - 1].x);
      let dh = Math.abs(h2 - h1); if (dh > Math.PI) dh = 2 * Math.PI - dh;
      worst = Math.max(worst, dh * 180 / Math.PI);
    }
    assert.ok(worst < 4, `${c.id}: heading change ${worst.toFixed(1)} degrees between samples`);
    // curvature is zero at both ends: the first and last segments follow the lane heading
    const h0 = Math.atan2(line[1].y - line[0].y, line[1].x - line[0].x);
    const want = Math.atan2(-a.arm.dir.y, -a.arm.dir.x);
    let dd = Math.abs(h0 - want); if (dd > Math.PI) dd = 2 * Math.PI - dd;
    assert.ok(dd * 180 / Math.PI < 3, c.id + ' leaves along the lane');
  });
});

if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall tests passed');
