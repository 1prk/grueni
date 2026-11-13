/* Runs the browser test page tests/index.html in a real browser. It is not part of the application. It needs Playwright.
     node tests/e2e/suite.js
   The page has a strict content security policy and runs from file://.
   The script prints the failed tests and the console errors. The exit code is 1 when a test failed. */
'use strict';
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 160)));
  await page.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await page.waitForFunction(() => window.__testsDone === true, null, { timeout: 120000 });
  const r = await page.evaluate(() => ({ title: document.title, summary: document.getElementById('summary').textContent, results: window.__testResults }));
  const failed = r.results.filter(x => !x.ok);
  console.log(JSON.stringify({ title: r.title, summary: r.summary, failed, consoleErrors: errors }, null, 1));
  await browser.close();
  if (failed.length || errors.length) process.exit(1);
})();
