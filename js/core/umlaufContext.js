/* GZ.umlaufContext builds the evaluation scope for each EVALUATION ROW of the cycle statistics.
   The scope is for GZ.exprEngine.compileValue().
   It has SG and DET object handles in the same basic format as js/views/formulaBuilder.js
   (class and cycleMetrics, see there and exprEngine.js).
   But it has NO sweep for each row. The cycle statistics need only ONE value for each row, not
   for each raw data row.
   The formula builder uses variables with a free alias. This module is different.
   It makes the OCIT column names usable as identifiers directly.
   There is no separate step "create a variable".

   An, Ab, TF, RG and GE are UNIVERSAL (see the header comment of PRIMITIVES in exprEngine.js).
   A signal group AND a detector, APW or ÖPNV value each have exactly ONE "active" state (GRUEN
   or BELEGT).
   This file treats the start, end and duration of that state the same way for BOTH object
   classes.
   GZ.segments.computeCycleSgEvents() is not tied to "signal group" or "green" on purpose.
   It accepts any state segments that are already categorized.

   An EVALUATION ROW is NOT always one cycle.
   For each signal group OR detector or value, a cycle can have more than ONE start event or end
   event.
   Examples: a pedestrian re-request (re-service), many detector triggers,
   or a green or an occupancy that extends past a cycle border.
   computeCycleSgEvents() records An and Ab INDEPENDENT of each other.
   An belongs to the cycle in which the state segment STARTS. Ab belongs to the cycle in which it
   ENDS.
   If a cycle border is in the middle of a segment, these are two different cycles.
   So both stay a purely LOCAL value. They are always relative to EXACTLY the cycle in which they
   lie.
   They are never a modulo fold onto another cycle.
   For each cycle, buildAll() makes as many rows as the side with the most events has.
   The side is An OR Ab, over ALL signal groups AND detectors or values.
   The minimum is 1 row. A cycle with no event at all still has one row with only NaN values (as
   before).
   Row e shows, for EACH object, its e-th An event AND its e-th Ab event.
   The pairing is only by index: the n-th An with the n-th Ab.
   It does not matter if they come from the same state segment.
   A segment without Ab in this cycle gives an An WITHOUT a matching Ab.
   Then Ab and TF are NaN on purpose. NaN means "not known here yet".
   The reverse case is an Ab WITHOUT a matching An. It means "started in an earlier cycle".
   TU, SPL and TU_MED stay the same across all rows of the same cycle (see cyc.cycleIdx,
   cyc.eventIdx and cyc.eventCount).

   Ausgeloest and AnzahlAusloesungen stay CYCLE-wide aggregates on purpose.
   The code does not split them by event, because there is no reference to "which event".
   They are the same for EVERY row of the same cycle.
   The code adds them to the shared cycleMetrics object of a detector or value as the fields
   triggered and count.
   They come in addition to an, ab, tf, rotgelb and gelb (see detCycleMetricsForRow()). */
GZ.define('umlaufContext', { layer: 'domain', deps: ['parser', 'segments', 'series', 'wartezeitLogic'] }, function (GZ) {
  'use strict';
  const {
    computeGlobalTU, computeCycleSgEvents, countCycleSgEvents, computeCycleDetMetrics, findSplAt,
    buildSegments, makeRawValueSampler, makeSegmentDurationSampler
  } = GZ.segments;
  const { categorizeDetRaw } = GZ.parser;
  const { wzIstBelegt } = GZ.wartezeitLogic;

  // Static identifier index (names and types).
  // It is the basis for varTypes in each compileValue() call AND for the suggestion list in
  // umlaufstatistiken.js.
  function buildIdentifierIndex(analysis) {
    const { allStats, otherColumns } = analysis;
    const sg = new Map(), det = new Map();
    const sgList = [], detList = [];
    allStats.forEach(({ col }) => {
      const l = col.name.toLowerCase();
      if (!sg.has(l)) { sg.set(l, col.name); sgList.push(col.name); }
    });
    otherColumns.forEach(col => {
      const l = col.name.toLowerCase();
      if (!det.has(l)) { det.set(l, col.name); detList.push(col.name); }
    });
    // EREIGNIS: the 1-based row number INSIDE the cycle (see cyc.eventIdx and cyc.eventCount in
    // buildAll()).
    // It is the same number that the table shows in the column "Ereignis".
    // A formula can use it to limit the repeated "no event at all" rows of a cycle (see ISTLEER())
    // to the FIRST row of the cycle.
    // An example is WENN(EREIGNIS > 1 AND ISTLEER(An(X)), LEER, ...).
    // Without it, an UNRELATED object that triggers many times in this cycle
    // would repeat the same statement "no event of X" once for each of its own occurrences.
    // That object also increases the number of rows of the cycle.
    const varTypes = { TU: 'NUM', TU_MED: 'NUM', SPL: 'TEXT', EREIGNIS: 'NUM' };
    sgList.forEach(n => { varTypes[n] = 'SG'; });
    detList.forEach(n => { varTypes[n] = 'DET'; });
    return { sg, det, sgList, detList, varTypes };
  }

  // Builds the fields An, Ab, TF, RG and GE from an entry {an:[...], ab:[...]} for the row index e.
  // See the header comment of computeCycleSgEvents() in segments.js.
  // If only one side exists (An OR Ab), the other side stays NaN (or 0 for rotgelb and gelb).
  // The code does not drop the whole record.
  // An, Ab, TF, RG and GE read from cm.an, cm.ab and so on separately (see exprEngine.js).
  // They already treat NaN as "not available".
  // hasEvent shows if ANY side exists.
  // Signal groups (see sgCycleMetricsForRow()) become fully null when they have no event.
  // Detectors and values (see detCycleMetricsForRow()) always keep their cycle-wide aggregate
  // Ausgeloest and AnzahlAusloesungen.
  function anAbFields(evs, e) {
    const anEv = evs.an[e] || null, abEv = evs.ab[e] || null;
    return {
      an: anEv ? anEv.value : NaN,
      ab: abEv ? abEv.value : NaN,
      tf: abEv ? abEv.tf : NaN,
      rotgelb: anEv ? anEv.rotgelb : 0,
      gelb: abEv ? abEv.gelb : 0,
      segIdx: abEv ? abEv.segIdx : (anEv ? anEv.segIdx : null),
      segStart: anEv ? anEv.segStart : null,
      segEnd: abEv ? abEv.segEnd : null,
      hasEvent: !!(anEv || abEv)
    };
  }
  function sgCycleMetricsForRow(evs, e) {
    const f = anAbFields(evs, e);
    if (!f.hasEvent) return null;
    delete f.hasEvent;
    return f;
  }
  function detCycleMetricsForRow(evs, e, agg) {
    const f = anAbFields(evs, e);
    delete f.hasEvent;
    f.triggered = agg ? agg.triggered : false;
    f.count = agg ? agg.count : 0;
    return f;
  }

  // Builds the context for EVERY cycle of the recording at once.
  // The context is LAZY. The number of rows needs only the number of An and Ab events of each object.
  // The code counts them in one cheap pass (see GZ.segments.countCycleSgEvents).
  // The expensive data of an object is built when a formula reads this object for the first time:
  // the events, the sampler of the raw value, the sampler of the duration and the cycle aggregates of a detector.
  // A recording with 100 detector columns and a formula that uses 3 of them builds the data of 3 columns.
  // The scope of a row has a getter for each object name. The getters are on one shared prototype.
  // A getter makes the handle of the object for this row, and keeps it.
  // The result of buildAll() has the same shape as before. The scope of a row works as before.
  function buildAll(analysis) {
    const index = buildIdentifierIndex(analysis);
    const { allStats, otherColumns, cycleStarts, tMax, times, table, splValues } = analysis;
    if (!cycleStarts || cycleStarts.length === 0) return { index, cycles: [] };

    const TU_MED = computeGlobalTU(cycleStarts);
    const n = cycleStarts.length;

    // A name belongs to a signal group OR to a detector or value (see the file header comment).
    // If two columns have the same name, the later column wins. A detector wins over a signal group.
    const sources = new Map();
    allStats.forEach(entry => { sources.set(entry.col.name, { kind: 'SG', entry, col: entry.col }); });
    otherColumns.forEach(col => { sources.set(col.name, { kind: 'DET', col }); });

    // The data of one object. The code builds it on the first call and keeps it.
    // The samplers and the occupancy apply to SG AND DET equally (see the file header comment).
    // agg is for DET only (the aggregates Ausgeloest and AnzahlAusloesungen, see detCycleMetricsForRow()).
    const dataByName = new Map();
    function objectData(name) {
      let d = dataByName.get(name);
      if (d !== undefined) return d;
      const src = sources.get(name);
      const series = table.byIndex.get(src.col.index);
      if (src.kind === 'SG') {
        const { segs, stats } = src.entry;
        d = {
          events: computeCycleSgEvents(segs, stats.greens, cycleStarts, tMax),
          rawSample: makeRawValueSampler(times, series),
          durationAt: makeSegmentDurationSampler(segs),
          agg: null
        };
      } else {
        // Own BELEGT/FREI segmentation.
        // computeCycleDetMetrics below gives only the cycle aggregates (Ausgeloest and AnzahlAusloesungen).
        // It gives no segment borders.
        // An, Ab, TF and DauerBei need the real course of the BELEGT segments, as GRUEN for signal groups.
        const detSegs = buildSegments(times, series, categorizeDetRaw);
        const belegtSegs = detSegs.filter(s => s.cat === 'BELEGT');
        d = {
          events: computeCycleSgEvents(detSegs, belegtSegs, cycleStarts, tMax),
          rawSample: makeRawValueSampler(times, series),
          durationAt: makeSegmentDurationSampler(detSegs),
          agg: computeCycleDetMetrics(times, GZ.series.flags(series, wzIstBelegt), cycleStarts, tMax)
        };
      }
      dataByName.set(name, d);
      return d;
    }

    // The number of rows of THIS cycle is the largest number of An events or Ab events
    // among ALL signal groups AND detectors or values of the recording in this cycle.
    // The minimum is 1, also with no event at all (as before: one row with only NaN values).
    // The code finds it over ALL objects on purpose.
    // It does not use only the objects that the current column formulas reference.
    // Otherwise the number of rows of a cycle would change with each formula change.
    const eventCounts = new Uint32Array(n).fill(1);
    index.sgList.concat(index.detList).forEach(name => {
      const src = sources.get(name);
      let greens;
      if (src.kind === 'SG') greens = src.entry.stats.greens;
      else greens = buildSegments(times, table.byIndex.get(src.col.index), categorizeDetRaw).filter(s => s.cat === 'BELEGT');
      const c = countCycleSgEvents(greens, cycleStarts, tMax);
      for (let i = 0; i < n; i++) {
        const m = c.an[i] > c.ab[i] ? c.an[i] : c.ab[i];
        if (m > eventCounts[i]) eventCounts[i] = m;
      }
    });

    // The shared prototype of all scopes. Each object name has a getter.
    // __cycle and __event are internal fields. A user formula cannot reference them (as __cycleStart).
    const proto = {};
    const lazyNames = new Set();
    const defineLazy = (name, kind) => {
      lazyNames.add(name);
      Object.defineProperty(proto, name, {
        configurable: true,
        enumerable: true,
        get() {
          const d = objectData(name), i = this.__cycle, e = this.__event;
          const handle = kind === 'SG'
            ? { class: 'SG', cycleMetrics: sgCycleMetricsForRow(d.events[i], e), rawSample: d.rawSample, durationAt: d.durationAt }
            : { class: 'DET', cycleMetrics: detCycleMetricsForRow(d.events[i], e, d.agg[i]), rawSample: d.rawSample, durationAt: d.durationAt };
          Object.defineProperty(this, name, { value: handle, writable: true, configurable: true, enumerable: true });
          return handle;
        }
      });
    };
    index.sgList.forEach(name => defineLazy(name, 'SG'));
    index.detList.forEach(name => defineLazy(name, 'DET'));

    const cycles = [];
    for (let i = 0; i < n; i++) {
      const start = cycleStarts[i];
      const end = i + 1 < n ? cycleStarts[i + 1] : tMax;
      const spl = findSplAt(start, times, splValues) || '';
      const tu = Math.round((end - start) / 1000);
      const eventCount = eventCounts[i];

      for (let e = 0; e < eventCount; e++) {
        // __cycleStart is not a regular identifier that varTypes declares. Users cannot reference it.
        // Only the primitives WertBei() and DauerBei() read it internally (see exprEngine.js).
        // They use it to convert their time in seconds into an absolute timestamp
        // for handle.rawSample() and handle.durationAt().
        // It is the same for ALL rows of the same cycle.
        // The code does not split the cycle itself. It only splits the events that each row shows.
        // An object name wins over a field with the same name, as before.
        const scope = Object.create(proto);
        const fixed = { TU: tu, TU_MED: TU_MED == null ? NaN : TU_MED, SPL: spl, EREIGNIS: e + 1, __cycleStart: start, __cycle: i, __event: e };
        Object.keys(fixed).forEach(k => {
          if (!lazyNames.has(k)) Object.defineProperty(scope, k, { value: fixed[k], writable: true, configurable: true, enumerable: true });
        });
        cycles.push({ scope, start, end, TX: i + 1, SPL: spl, TU: tu, cycleIdx: i, eventIdx: e, eventCount });
      }
    }

    return { index, cycles };
  }

  return { buildIdentifierIndex, buildAll };
});
