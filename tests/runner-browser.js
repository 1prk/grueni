/* Runs the suite in the browser and shows the result. The page has a strict CSP, so it has no
   inline script. */
(function () {
  'use strict';
  window.GZT.runAll().then(function (results) {
    const list = document.getElementById('results');
    let failed = 0;
    results.forEach(function (r) {
      const li = document.createElement('li');
      li.className = r.ok ? 'ok' : 'fail';
      li.textContent = (r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.ok ? '' : '\n     ' + r.error);
      list.appendChild(li);
      if (!r.ok) failed++;
    });
    const summary = document.getElementById('summary');
    summary.textContent = failed ? failed + ' of ' + results.length + ' tests failed' : 'all ' + results.length + ' tests passed';
    summary.className = failed ? 'fail' : 'ok';
    document.title = (failed ? 'FAIL' : 'PASS') + ' - grueni tests';
    window.__testResults = results;
    window.__testsDone = true;
  });
})();
