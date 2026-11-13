/* Tests of GZ.define. A module with a wrong layer or a wrong dependency must not load. */
(function () {
  'use strict';
  const GZ = window.GZ, T = window.GZT, assert = T.assert;
  let seq = 0;
  const unique = () => 'zzTest' + (++seq);

  function expectError(fn, pattern, label) {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    assert.ok(err !== null, label + ': no error');
    assert.ok(pattern.test(err.message), label + ': wrong error: ' + err.message);
  }

  T.test('define: a module gets its place in GZ and in the registry', () => {
    const name = unique();
    const api = { x: 1 };
    GZ.define(name, { layer: 'domain', deps: [] }, () => api);
    assert.ok(GZ[name] === api, 'GZ.' + name);
    assert.equal(GZ.define.registry.get(name).layer, 'domain');
  });

  T.test('define: a dotted name makes a namespace', () => {
    const ns = unique();
    GZ.define(ns + '.part', { layer: 'ui', deps: [] }, () => ({ ok: true }));
    assert.ok(GZ[ns].part.ok === true);
  });

  T.test('define: a name that exists is refused', () => {
    const name = unique();
    GZ.define(name, { layer: 'domain', deps: [] }, () => ({}));
    expectError(() => GZ.define(name, { layer: 'domain', deps: [] }, () => ({})), /exists already/, 'second define');
  });

  T.test('define: bad arguments are refused', () => {
    expectError(() => GZ.define('bad name', { layer: 'domain', deps: [] }, () => ({})), /bad module name/, 'name');
    expectError(() => GZ.define(unique(), { layer: 'nope', deps: [] }, () => ({})), /unknown layer/, 'layer');
    expectError(() => GZ.define(unique(), { layer: 'domain' }, () => ({})), /deps must be an array/, 'deps');
    expectError(() => GZ.define(unique(), { layer: 'domain', deps: [] }, null), /must be a function/, 'factory');
    expectError(() => GZ.define(unique(), { layer: 'domain', deps: [] }, () => null), /must return an object/, 'result');
  });

  T.test('define: a dependency that is not defined yet is refused', () => {
    expectError(() => GZ.define(unique(), { layer: 'domain', deps: ['zzNothing'] }, () => ({})), /not defined yet/, 'missing dependency');
  });

  T.test('define: a dependency in a higher layer is refused', () => {
    const view = unique(), dom = unique();
    GZ.define(view, { layer: 'views', deps: [] }, () => ({}));
    expectError(() => GZ.define(dom, { layer: 'domain', deps: [view] }, () => ({})), /is higher/, 'domain uses view');
    const io = unique();
    expectError(() => GZ.define(io, { layer: 'io', deps: [view] }, () => ({})), /is higher/, 'io uses view');
  });

  T.test('define: a view must not use a view, and ui must not use the store', () => {
    const v1 = unique(), v2 = unique(), st = unique(), ui = unique();
    GZ.define(v1, { layer: 'views', deps: [] }, () => ({}));
    expectError(() => GZ.define(v2, { layer: 'views', deps: [v1] }, () => ({})), /must not use the view/, 'view to view');
    GZ.define(st, { layer: 'store', deps: [] }, () => ({}));
    expectError(() => GZ.define(ui, { layer: 'ui', deps: [st] }, () => ({})), /must not use the store/, 'ui to store');
  });

  T.test('define: the same layer and lower layers are allowed, the layer app is not a dependency', () => {
    const a = unique(), b = unique(), app = unique(), top = unique();
    GZ.define(a, { layer: 'domain', deps: [] }, () => ({}));
    GZ.define(b, { layer: 'domain', deps: [a] }, () => ({}));
    GZ.define(app, { layer: 'app', deps: [a, b] }, () => ({}));
    expectError(() => GZ.define(top, { layer: 'app', deps: [app] }, () => ({})), /layer app/, 'use of app');
  });

  T.test('define: every real module is in the registry with a known layer', () => {
    const reg = GZ.define.registry;
    ['format', 'stats', 'parser', 'table', 'segments', 'csvImport', 'chunkCodec', 'state'].forEach(n => {
      assert.ok(reg.has(n), 'module ' + n + ' is missing');
      assert.ok(reg.get(n).layer in GZ.define.RANK, 'layer of ' + n);
    });
    assert.equal(reg.get('csvImport').layer, 'io');
    assert.equal(reg.get('state').layer, 'store');
  });
})();
