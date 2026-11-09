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
['format', 'stats', 'parser', 'segments', 'wartezeitLogic', 'slices', 'greenTime', 'detectors', 'logParser', 'sampleData'].forEach(name => {
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
test('log: semicolon, quotes, ISO date and BOM', () => {
  const r = GZ.logs.parse('﻿Warning;03.11.2026 06:05:00;a; b\n"Error","03.11.2026, 06:10:00","q, t"\nInfo,2026-11-03 06:15:00,iso');
  same(r.entries.map(e => [e.severity, e.text]), [['warning', 'a; b'], ['error', 'q, t'], ['info', 'iso']]);
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

if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall tests passed');
