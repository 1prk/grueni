/* End-to-end check of the downloads in a real browser. It is not part of the application. It needs Playwright.
     node tests/e2e/exports.js
   It loads the sample recording and starts each export: the CSV, the two Excel files and the MAP file.
   Each export must give a file, with no violation of the content security policy and no page error. */
'use strict';
const path = require('path');
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1500, height: 950 } }); const p = await ctx.newPage();
  const errs = [];
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); }); p.on('pageerror', e => errs.push('pageerror ' + e.message));
  await p.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.effectiveDirective + ' ' + e.blockedURI)); });
  await p.goto('file://' + path.join(__dirname, '..', '..', 'index.html'));
  await p.click('#btnSample'); await p.waitForTimeout(1500);
  const res = {};
  async function dl(name, tab, sel, pre) {
    if (tab) { await p.click('.tab-btn[data-tab="' + tab + '"]'); await p.waitForTimeout(500); }
    if (pre) await pre();
    try { const [d] = await Promise.all([p.waitForEvent('download', { timeout: 4000 }), p.click(sel)]); const path = await d.path(); res[name] = d.suggestedFilename() + ' ' + require('fs').statSync(path).size + ' bytes'; } catch (e) { res[name] = 'NO DOWNLOAD: ' + e.message.slice(0, 80); }
  }
  await dl('csv kennzahlen', null, '#btnExport');
  await dl('oepnv xlsx', 'oe', '#oeExportBtn', async () => { await p.click('#oeAddSgBtn'); await p.waitForTimeout(500); });
  await dl('us xlsx', 'us', '#usExportBtn', async () => { await p.click('#usAddColBtn'); const ed = await p.$('#usColRows [contenteditable="true"]'); await ed.click(); await p.keyboard.type('TF(K1)'); await p.keyboard.press('Escape'); await p.waitForTimeout(800); });
  await dl('topology MAPEM', 'sd', '#topoMapExport', async () => { await p.click('#sdSubnav > :nth-child(2)'); await p.click('#topoExample'); await p.waitForTimeout(500); });
  console.log(JSON.stringify(res, null, 1));
  const csp = await p.evaluate(() => window.__csp);
  console.log('csp:', JSON.stringify(csp), 'errors:', JSON.stringify(errs));
  await b.close();
  if (csp.length || errs.length || Object.values(res).some(v => /NO DOWNLOAD/.test(v))) process.exit(1);
})();
