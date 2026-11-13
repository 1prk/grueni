/* GZT: a small test harness. It runs in Node (inside a vm context) and in the browser.
   Tests can return a promise. */
(function (root) {
  'use strict';
  const tests = [];

  function fail(message, extra) {
    throw new Error(message + (extra ? '\n     ' + extra : ''));
  }
  const assert = {
    ok(value, message) { if (!value) fail(message || 'assertion failed'); },
    equal(actual, expected, message) {
      if (actual !== expected) fail(message || 'values differ', 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
    },
    // Compare as JSON. Arrays from another vm context have another prototype.
    same(actual, expected, message) {
      const a = JSON.stringify(actual), e = JSON.stringify(expected);
      if (a !== e) fail(message || 'values differ', 'expected ' + e.slice(0, 300) + ', got ' + a.slice(0, 300));
    }
  };

  function test(name, fn) { tests.push({ name, fn }); }

  async function runAll() {
    const results = [];
    for (const t of tests) {
      try { await t.fn(); results.push({ name: t.name, ok: true }); }
      catch (e) { results.push({ name: t.name, ok: false, error: String(e && e.message || e) }); }
    }
    return results;
  }

  root.GZT = root.GZT || {};
  Object.assign(root.GZT, { test, assert, runAll, fixtures: {} });
})(window);
