/* Golden-master tests for the OCIT parser and the analyses that use it.
   The golden values are compact hashes. The command `node tests/run-suite.js --update-golden`
   writes them to tests/golden/golden-data.js.
   They record what the current code does.
   A later rewrite of the importer must give the same values. */
(function () {
  'use strict';
  const GZ = window.GZ, T = window.GZT, H = T.hash, HL = T.hashList;
  GZ.state = GZ.state || { data: {} };

  // Map and Set become arrays, so that JSON keeps their content. The function cuts cycles.
  function plain(x, seen) {
    seen = seen || new Set();
    if (x === null || typeof x !== 'object') return x;
    if (seen.has(x)) return '[cycle]';
    seen.add(x);
    let out;
    if (x instanceof Map) out = { __map: Array.from(x.entries()).map(e => [plain(e[0], seen), plain(e[1], seen)]) };
    else if (x instanceof Set) out = { __set: Array.from(x.values()).map(v => plain(v, seen)) };
    else if (Array.isArray(x)) out = x.map(v => plain(v, seen));
    else { out = {}; Object.keys(x).forEach(k => { out[k] = plain(x[k], seen); }); }
    seen.delete(x);
    return out;
  }
  const digestOf = x => { try { return H(JSON.stringify(plain(x))); } catch (e) { return 'error:' + e.message; } };

  // The code compares times as differences. So the result does not depend on the time zone.
  function digestParsed(p) {
    const times = p.times, diffs = [];
    for (let i = 1; i < times.length; i++) diffs.push(times[i] - times[i - 1]);
    const d0 = new Date(times[0]);
    const series = {};
    p.seriesByCol.forEach((arr, idx) => { series[idx] = HL(arr); });
    return {
      rows: times.length, totalRows: p.totalRows, skippedRows: p.skippedRows,
      knotenName: p.knotenName, knotenNr: p.knotenNr,
      t0Local: [d0.getFullYear(), d0.getMonth() + 1, d0.getDate(), d0.getHours(), d0.getMinutes(), d0.getSeconds()],
      timeDiffs: HL(diffs),
      cycleStartCount: p.cycleStarts.length,
      cycleStartOffsets: HL(p.cycleStarts.map(t => t - times[0])),
      tc: HL(p.tcValues), spl: HL(p.splValues),
      columns: digestOf(p.columns), otherColumns: digestOf(p.otherColumns),
      series
    };
  }

  function analysisOf(p) {
    const { columns, otherColumns, times, seriesByCol } = p;
    const allStats = columns.map(col => {
      const segs = GZ.segments.buildSegments(times, seriesByCol.get(col.index));
      const stats = GZ.segments.computeCycleStats(segs);
      stats.bySpl = GZ.segments.computeCycleStatsBySpl(segs, times, p.splValues);
      return { col, segs, stats };
    });
    const splSet = new Set();
    allStats.forEach(s => s.stats.bySpl.forEach((_, k) => splSet.add(k)));
    return {
      allStats, tMin: times[0], tMax: times[times.length - 1] + 1000, cycleStarts: p.cycleStarts, otherColumns,
      times, table: GZ.series.tableFromStrings(times, seriesByCol), splValues: p.splValues, tcValues: p.tcValues, splList: GZ.stats.sortSplList(splSet)
    };
  }

  // The consumers of the series. The golden values record what the analyses give for each detector column.
  // The golden values come from the code that read text arrays (before Phase 5).
  // The code that reads the typed table must give the same values.
  function digestConsumers(p) {
    const a = analysisOf(p);
    GZ.state.data.currentAnalysis = a;
    const seriesOf = idx => a.table.byIndex.get(idx);
    const auslosend = (cols, idx) => GZ.wartezeitLogic.auslosenderDetektor(cols, a.table, idx);
    const SG = GZ.segments, WL = GZ.wartezeitLogic, D = GZ.detectors;
    const times = a.times, n = times.length;
    const flagsOf = occ => H(JSON.stringify(Array.from(occ, x => (x ? 1 : 0))));
    const out = { columns: {} };

    const probes = [times[0] - 5000, times[0], times[1], times[Math.floor(n / 3)], times[Math.floor(n / 2)] + 400, times[n - 1], times[n - 1] + 9999];
    a.otherColumns.forEach(col => {
      const s = seriesOf(col.index), sampler = SG.makeRawValueSampler(times, s);
      out.columns[col.name] = {
        det: digestOf(SG.buildSegments(times, s, GZ.parser.categorizeDetRaw)),
        sg: digestOf(SG.buildSegments(times, s)),
        trim: digestOf(SG.buildSegments(times, s, v => v.trim())),
        samples: digestOf(probes.map(t => sampler(t)))
      };
    });

    D.init(a);
    const dets = D.list();
    out.detectors = dets.map(d => ({
      name: d.name, links: d.links.length,
      scores: D.eligibleSgs(a).map(s => D.score(a, d, s.col.index)),
      best: D.bestMatch(a, d)
    }));
    out.occupancy = flagsOf(D.occupancy(a, dets.slice(0, 5)));

    const wz = [];
    D.eligibleSgs(a).slice(0, 4).forEach(sg => {
      dets.slice(0, 3).forEach(d => {
        const occ = D.occupancy(a, [d]);
        const r = WL.computeWartezeitEvents(times, seriesOf(sg.col.index), occ, a.splValues, false, 3, d.kind === 'pulse', []);
        const r2 = WL.computeWartezeitEvents(times, seriesOf(sg.col.index), occ, a.splValues, true, 5, false, [2]);
        wz.push({
          sg: sg.col.name, det: d.name, occ: flagsOf(occ), r: digestOf(r), r2: digestOf(r2),
          who: r.events.map(e => auslosend([d.col], e.reqIdx)),
          metrics: digestOf(SG.computeCycleDetMetrics(times, occ, a.cycleStarts, a.tMax))
        });
      });
    });
    out.wartezeit = wz;

    const oe = [];
    if (dets.length >= 2) {
      const occ1 = D.occupancy(a, [dets[0]]), occ2 = D.occupancy(a, [dets[1]]);
      oe.push(digestOf(GZ.oepnvLogic.computeOepnvEvents(times, occ1, occ2, a.splValues, [], 30, 60)));
    }
    out.oepnv = oe;

    // The cycle context: the rows and the values of many formulas, over all objects.
    const ctx = GZ.umlaufContext.buildAll(a);
    out.context = {
      index: digestOf({ sg: ctx.index.sgList, det: ctx.index.detList, types: ctx.index.varTypes }),
      rows: digestOf(ctx.cycles.map(c => [c.start, c.end, c.TX, c.SPL, c.TU, c.cycleIdx, c.eventIdx, c.eventCount])),
      values: {}
    };
    const exprs = ['TU', 'TU_MED', 'SPL', 'EREIGNIS'];
    ctx.index.sgList.concat(ctx.index.detList).forEach(name => {
      ['An', 'Ab', 'TF', 'RG', 'GE', 'Ausgeloest', 'AnzahlAusloesungen'].forEach(f => exprs.push(f + '(' + name + ')'));
      ['WertBei', 'DauerBei'].forEach(f => exprs.push(f + '(' + name + ', 20)'));
    });
    exprs.forEach(expr => {
      const c = GZ.exprEngine.compileValue(expr, ctx.index.varTypes, {});
      out.context.values[expr] = c.ok ? digestOf(ctx.cycles.map(cy => c.run(cy.scope))) : 'error:' + c.message;
    });
    GZ.state.data.currentAnalysis = null;
    return out;
  }

  function digestDownstream(p) {
    const a = analysisOf(p);
    GZ.state.data.currentAnalysis = a;
    const model = GZ.greenTime.build(a);
    const out = { columns: {} };
    a.allStats.forEach(s => {
      const sg = model.sgs.find(m => m.col.index === s.col.index);
      const st = GZ.greenTime.stats(model, sg, null);
      out.columns[s.col.name] = {
        segments: digestOf(s.segs), cycleStats: digestOf(s.stats), greenTime: digestOf(st), behaviour: GZ.greenTime.behaviour(st)
      };
    });
    out.slices = digestOf(GZ.slices.build(a));
    GZ.state.data.currentAnalysis = null;
    return out;
  }

  // name -> text. The code builds this map once.
  let cache = null;
  function fixtures() {
    if (cache) return cache;
    cache = Object.assign({ sample: GZ.sampleData.generateSampleText(), synthetic: T.fixtures.synthetic() }, T.fixtures.edgeCases());
    return cache;
  }
  const WITH_DOWNSTREAM = { sample: true, synthetic: true };

  function compute(name) {
    let p;
    try { p = GZ.parser.parseOcitText(fixtures()[name]); }
    catch (e) { return { error: e.message }; }
    const r = { parse: digestParsed(p) };
    if (WITH_DOWNSTREAM[name]) r.downstream = digestDownstream(p);
    // The consumers also run on the edge cases (INV cells, blank cells, wide numbers).
    // The golden value records only if a case throws, not the message of the error.
    try { r.consumers = digestConsumers(p); } catch (e) { r.consumers = 'threw'; }
    return r;
  }

  // The parse hashes do not depend on the time zone.
  // The downstream hashes contain absolute times and clock labels.
  // So the tests compare them only in the time zone that wrote the golden data.
  const tzOffset = () => new Date(2026, 10, 3, 6).getTimezoneOffset();

  T.allFixtures = fixtures;
  T.computeGolden = function () {
    const g = { __meta: { tzOffset: tzOffset() } };
    Object.keys(fixtures()).forEach(n => { g[n] = compute(n); });
    return g;
  };

  T.test('fixtures: the generators are deterministic', () => {
    T.assert.equal(H(T.fixtures.synthetic()), H(T.fixtures.synthetic()));
    T.assert.equal(H(GZ.sampleData.generateSampleText()), H(GZ.sampleData.generateSampleText()));
  });
  T.test('fixtures: the wide recording has 3600 rows and 105 fields per row', () => {
    const lines = fixtures().synthetic.split('\n');
    T.assert.equal(lines.length, 7 + 3600 + 1);
    T.assert.equal(lines[7].split('\t').length, 105);
  });
  T.test('golden: golden data is present', () => {
    T.assert.ok(window.GZT_GOLDEN, 'tests/golden/golden-data.js is empty. Run: node tests/run-suite.js --update-golden');
  });
  Object.keys(fixtures()).forEach(name => {
    T.test('golden: ' + name, () => {
      const g = window.GZT_GOLDEN;
      T.assert.ok(g && g[name], 'no golden value for ' + name);
      const now = compute(name), want = g[name];
      if (g.__meta.tzOffset === tzOffset()) T.assert.same(now, want);
      // Other time zone: compare the parse hashes only.
      else T.assert.same({ parse: now.parse, error: now.error }, { parse: want.parse, error: want.error });
    });
  });
})();
