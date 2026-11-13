/* Tests of GZ.recordingCodec. A recording must come back from its chunks exactly as the importer gave it. */
(function () {
  'use strict';
  const GZ = window.GZ, T = window.GZT, assert = T.assert;
  const R = GZ.recordingCodec, P = GZ.project;

  // The comparison of two import results, like in the csvImport tests.
  function snapshot(r) {
    const series = {};
    // The importer and the decoder give typed columns. The reference parser gives text arrays.
    if (r.seriesByCol) r.seriesByCol.forEach((arr, idx) => { series[idx] = Array.prototype.slice.call(arr); });
    else r.table.columns.forEach(col => { series[col.index] = GZ.table.columnStrings(col); });
    return {
      columns: r.columns, otherColumns: r.otherColumns, times: Array.prototype.slice.call(r.times), series,
      splValues: r.splValues, tcValues: r.tcValues, totalRows: r.totalRows, skippedRows: r.skippedRows,
      knotenName: r.knotenName, knotenNr: r.knotenNr, cycleStarts: r.cycleStarts
    };
  }
  async function roundTrip(text) {
    return roundTripParsed(GZ.csvImport.importText(text));
  }
  async function roundTripParsed(parsed) {
    const { recording, chunks } = await R.encode(parsed, { fileName: 'x.csv' });
    const back = await R.decode(recording, async name => {
      const b = chunks.get(name);
      if (!b) throw new Error('missing chunk ' + name);
      return b;
    });
    return { parsed, recording, chunks, back };
  }

  T.test('recordingCodec: every fixture comes back exactly', async () => {
    const all = Object.assign({}, T.allFixtures(), T.extraFixtures());
    let count = 0;
    for (const name of Object.keys(all)) {
      let parsed;
      try { parsed = GZ.csvImport.importText(all[name]); } catch (e) { continue; }   // the importer refuses this text
      const r = await roundTripParsed(parsed);
      assert.same(snapshot(r.back), snapshot(r.parsed), 'fixture ' + name);
      count++;
    }
    assert.ok(count > 15, 'too few fixtures checked: ' + count);
  });

  T.test('recordingCodec: the model entry is valid and lists every chunk', async () => {
    const { recording, chunks, parsed } = await roundTrip(T.allFixtures().synthetic);
    const p = P.createProject();
    const lsa = P.addLsa(p, P.createLsa({ name: 'x' }));
    P.addRecording(lsa, recording);
    P.validate(p);
    assert.equal(recording.rowCount, parsed.table.rowCount);
    assert.equal(recording.tMin, parsed.times[0]);
    assert.equal(recording.tMax, parsed.times[parsed.times.length - 1]);
    assert.same(P.chunkKeys(p).map(k => k.split('/')[1]).sort(), Array.from(chunks.keys()).sort());
    assert.equal(Object.keys(recording.chunks.columns).length, parsed.table.columns.length);
  });

  T.test('recordingCodec: the header survives JSON', async () => {
    const { recording, back, parsed } = await roundTrip(T.allFixtures().sample);
    const viaJson = JSON.parse(JSON.stringify(recording));
    assert.same(viaJson.header.columns, parsed.columns);
    assert.same(back.columns, parsed.columns);
  });

  T.test('recordingCodec: the decoded table gives the same text for every cell', async () => {
    const { parsed, back } = await roundTrip(T.allFixtures().synthetic);
    parsed.table.columns.forEach(col => {
      const other = back.table.byIndex.get(col.index);
      assert.same(GZ.table.columnStrings(other), GZ.table.columnStrings(col), 'column ' + col.index);
    });
  });

  T.test('recordingCodec: errors for a missing table, a wrong chunk and a wrong row count', async () => {
    let err = null;
    try { await R.encode({}); } catch (e) { err = e; }
    assert.ok(err && /no table/.test(err.message), 'no table');
    const { recording, chunks } = await roundTrip(T.allFixtures().synthetic);
    const get = async name => chunks.get(name);
    const wrongCount = JSON.parse(JSON.stringify(recording)); wrongCount.rowCount += 1;
    err = null; try { await R.decode(wrongCount, get); } catch (e) { err = e; }
    assert.ok(err && /time axis/.test(err.message), 'row count: ' + (err && err.message));
    const swapped = JSON.parse(JSON.stringify(recording));
    const keys = Object.keys(swapped.chunks.columns);
    const t = swapped.chunks.columns[keys[0]]; swapped.chunks.columns[keys[0]] = swapped.chunks.columns[keys[1]]; swapped.chunks.columns[keys[1]] = t;
    err = null; try { await R.decode(swapped, get); } catch (e) { err = e; }
    assert.ok(err && /column index/.test(err.message), 'swapped chunks: ' + (err && err.message));
    err = null; try { await R.decode(recording, async () => { throw new Error('storage: gone'); }); } catch (e) { err = e; }
    assert.ok(err && /gone/.test(err.message), 'a failing store gives its error');
  });
})();
