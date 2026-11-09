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

if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall tests passed');
