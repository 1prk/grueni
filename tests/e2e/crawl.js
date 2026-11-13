/* End-to-end check in a real browser. It is not part of the application. It needs Playwright.
     node tests/e2e/crawl.js [url]
   The script loads the sample recording and the sample log from index.html (file://).
   Then it clicks many controls in every tab and moves the mouse over the charts.
   It reports every violation of the content security policy and every page error.
   For each one it names the action that caused it. The exit code is 1 when there is one. */
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const url = process.argv[2] || 'file://' + path.join(__dirname, '..', '..', 'index.html');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 160) + ' @ ' + (e.stack || '').split('\n').slice(1, 4).map(s => s.trim().replace(/file:\/\/\S*\//, '')).join(' < ')));
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.effectiveDirective + ' ' + e.blockedURI + ' line ' + e.lineNumber)); });
  await page.goto(url);
  await page.click('#btnSample');
  await page.waitForFunction(() => /Datenpr/.test(document.getElementById('statusLine').textContent), null, { timeout: 60000 });
  await page.waitForTimeout(800);
  const log = await page.evaluate(() => GZ.sampleData.generateSampleLog());
  await page.setInputFiles('#logInput', { name: 'log.csv', mimeType: 'text/csv', buffer: Buffer.from(log) });
  await page.waitForTimeout(500);
  let seen = 0, actions = 0;
  const culprits = [];
  async function check(what) {
    const v = await page.evaluate(() => window.__csp.length);
    if (v > seen) { culprits.push(what + ' -> ' + (v - seen) + ' violation(s)'); seen = v; }
    if (errors.length > (check.e || 0)) { culprits.push(what + ' -> error: ' + errors.slice(check.e || 0).join(' / ')); check.e = errors.length; }
  }
  const tabs = ['gz', 'sd', 'pa', 'wz', 'oe', 'up', 'us'];
  for (const t of tabs) {
    await page.click('.tab-btn[data-tab="' + t + '"]'); await page.waitForTimeout(400); await check('tab ' + t);
    if (t === 'sd') { await page.click('#sdAddPhase'); await page.click('#sdAddPhase'); await page.waitForTimeout(200); await check('add phases'); }
    if (t === 'up') {
      await page.click('#upBausteinPanelHead'); await page.click('#upAddFormulaBtn'); await page.click('#upAddVarBtn'); await page.click('#upAddFuncBtn'); await page.click('#upAddFilterBtn');
      await page.waitForTimeout(300); await check('add builder rows');
      const ed = await page.$('#upFormulaRows [contenteditable="true"]'); if (ed) { await ed.click(); await page.keyboard.type('Zustand(K1) == GRU'); await page.waitForTimeout(300); await check('autocomplete'); await page.keyboard.press('Tab'); await check('autocomplete accept'); }
      await page.click('#upFormulaHelpBtn'); await page.waitForTimeout(200); await check('help modal'); await page.click('#upFormulaHelpClose').catch(() => {});
    }
    if (t === 'us') { await page.click('#usAddColBtn'); const ed = await page.$('#usColRows [contenteditable="true"]'); if (ed) { await ed.click(); await page.keyboard.type('An(K1)'); await page.waitForTimeout(300); await check('us expr'); } }
    if (t === 'oe') { await page.click('#oeAddSgBtn'); await page.waitForTimeout(300); await check('oe add'); }
    if (t === 'sd') {
      await page.click('#sdSubnav > :nth-child(2)'); await page.waitForTimeout(300);
      await page.click('#topoExample'); await page.waitForTimeout(600); await check('topo example');
      for (let step = 1; step <= 4; step++) { await page.click('.topo-step[data-step="' + step + '"]'); await page.waitForTimeout(300); await check('topo step ' + step);
        const items = await page.$$('#topoSide [data-action]');
        for (const it of items.slice(0, 14)) { try { await it.click({ timeout: 1000 }); await page.waitForTimeout(80); await check('topo side action step ' + step); actions++; } catch (e) {} }
      }
      // hover and click on the canvas
      for (let i = 0; i < 12; i++) { await page.mouse.move(300 + i * 60, 300 + (i % 4) * 50); await page.waitForTimeout(40); }
      await check('topo hover');
      const sgChips = await page.$$('#topoSide .ts-chip'); for (const c of sgChips.slice(0, 6)) { try { await c.click({ timeout: 800 }); await page.waitForTimeout(60); } catch (e) {} } await check('topo chips');
      await page.click('#sdSubnav > :nth-child(1)'); await page.waitForTimeout(300);
    }
    // generic: click visible buttons and checkboxes in the tab, hover charts
    const handles = await page.$$('#tab-' + t + ' button:not([disabled]), #tab-' + t + ' input[type=checkbox], #tab-' + t + ' .tab-btn, #tab-' + t + ' [data-action], #tab-' + t + ' .obj-row, #tab-' + t + ' summary');
    for (const h of handles.slice(0, 60)) {
      try {
        const vis = await h.isVisible(); if (!vis) continue;
        const desc = await h.evaluate(e => e.tagName + '#' + e.id + '.' + (e.className.baseVal !== undefined ? e.className.baseVal : e.className) + ' ' + (e.textContent || '').trim().slice(0, 25));
        if (/Neu|Entfern|löschen|remove|Log entfernen|Help|Hilfe/i.test(desc)) continue;
        await h.click({ timeout: 800 }); actions++; await page.waitForTimeout(60); await check('click ' + t + ': ' + desc);
      } catch (e) {}
    }
    await page.evaluate(() => { const c = document.getElementById('upFormulaHelpClose'); if (c) c.click(); });
    const svgs = await page.$$('#tab-' + t + ' svg');
    for (const s of svgs.slice(0, 12)) { try { const b = await s.boundingBox(); if (!b || b.width < 40) continue; for (let i = 1; i <= 6; i++) { await page.mouse.move(b.x + b.width * i / 7, b.y + b.height / 2); await page.waitForTimeout(25); } await page.mouse.click(b.x + b.width / 3, b.y + b.height / 2, { modifiers: ['Control'] }); await page.waitForTimeout(40); await check('svg hover/ctrl-click in ' + t); } catch (e) {} }
  }
  // PÜ detail panel: click an inferred transition segment in the cycle check if there is one
  await page.click('.tab-btn[data-tab="up"]'); await page.waitForTimeout(400);
  const seg = await page.$('#tab-up svg [data-pue], #tab-up svg .pue-seg, #tab-up svg [class*="phase"]'); if (seg) { try { await seg.click({ timeout: 800 }); await page.waitForTimeout(300); await check('pue segment'); } catch (e) {} }
  const csp = await page.evaluate(() => window.__csp);
  console.log('actions:', actions, 'violations:', csp.length, 'errors:', errors.length);
  console.log(culprits.join('\n') || 'no culprits');
  console.log('unique violations:', JSON.stringify([...new Set(csp)].slice(0, 20)));
  console.log('errors:', JSON.stringify(errors.slice(0, 5)));
  await browser.close();
  if (csp.length || errors.length) process.exit(1);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
