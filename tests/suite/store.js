/* Tests of the store: topics, commands, providers and the selectors. */
(function () {
  'use strict';
  const GZ = window.GZ, T = window.GZT, assert = T.assert;
  const S = GZ.state;

  function expectError(fn, pattern, label) {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    assert.ok(err !== null, label + ': no error');
    assert.ok(pattern.test(err.message), label + ': wrong error: ' + err.message);
  }

  T.test('store: commit calls the subscribers and runs the mutator first', () => {
    const seen = [];
    const off = S.on('phases:changed', () => seen.push(S.data.phases.length));
    const keep = S.data.phases;
    try {
      S.commit('phases:changed', d => { d.phases = [{ id: 1 }]; });
      S.commit('phases:changed');
      assert.same(seen, [1, 1]);
    } finally { off(); S.data.phases = keep; }
    S.commit('phases:changed');
    assert.equal(seen.length, 2, 'a subscriber that left must not be called');
  });

  T.test('store: a command gives its payload to the subscribers', () => {
    const got = [];
    const off = S.on('nav:switchTab', p => got.push(p.tab));
    try { S.command('nav:switchTab', { tab: 'up' }); S.command('nav:switchTab', { tab: 'sd' }); } finally { off(); }
    assert.same(got, ['up', 'sd']);
  });

  T.test('store: unknown topics and the wrong call are errors', () => {
    expectError(() => S.on('nope', () => {}), /unknown topic/, 'on');
    expectError(() => S.commit('nope'), /unknown topic/, 'commit');
    expectError(() => S.command('nope'), /unknown topic/, 'command');
    expectError(() => S.commit('nav:jumpToTime'), /is a command and not a change/, 'commit of a command');
    expectError(() => S.command('phases:changed'), /is a change and not a command/, 'command of a change');
    expectError(() => S.on('phases:changed', 5), /must be a function/, 'subscriber');
  });

  T.test('store: a subscriber that throws does not stop the others', () => {
    const log = [];
    const original = console.error;
    console.error = () => {};
    const offs = [S.on('detectors:changed', () => { throw new Error('boom'); }), S.on('detectors:changed', () => log.push('second'))];
    try { S.commit('detectors:changed'); } finally { console.error = original; offs.forEach(o => o()); }
    assert.same(log, ['second']);
  });

  T.test('store: a provider answers a request, an unknown provider is an error', () => {
    assert.equal(S.request('oepnvRows', 3), undefined, 'no provider yet');
    S.provide('oepnvRows', sg => ['row' + sg]);
    assert.same(S.request('oepnvRows', 3), ['row3']);
    expectError(() => S.provide('oepnvRows', () => []), /exists already/, 'second provider');
    expectError(() => S.provide('nope', () => []), /unknown provider/, 'unknown provide');
    expectError(() => S.request('nope'), /unknown provider/, 'unknown request');
    expectError(() => S.provide('kennzahlColumns', 5), /must be a function/, 'provider function');
  });

  T.test('store: inRecording uses the loaded analysis', () => {
    const keep = S.data.currentAnalysis;
    try {
      S.data.currentAnalysis = null;
      assert.equal(S.inRecording(5), false);
      S.data.currentAnalysis = { tMin: 10, tMax: 20 };
      assert.equal(S.inRecording(10), true);
      assert.equal(S.inRecording(20), true);
      assert.equal(S.inRecording(9), false);
      assert.equal(S.inRecording(21), false);
    } finally { S.data.currentAnalysis = keep; }
  });

  T.test('store: the store binds the detector and log modules to its own state', () => {
    GZ.logs.load('Info\t03.11.2026, 06:00:01\tx', 'f');
    assert.equal(S.data.log.entries.length, 1, 'the log is in the store');
    GZ.logs.clear();
    assert.equal(S.data.log.entries.length, 0);
  });
})();
