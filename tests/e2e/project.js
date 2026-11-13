/* End-to-end check of the project functions in a real browser. It is not part of the application. It needs Playwright.
     node tests/e2e/project.js
   The script plays through these cases with the sample recording:
   - the working copy: autosave after an import and after a change, and restore after a reload
   - the project file: save as download, save in place with a fake file picker, open in a clean browser
   - the configuration files: export, import, and the older files
   - bad files: not a ZIP, a damaged chunk, a project from a newer version
   Each case compares the settings of the views before and after. The exit code is 1 when a case fails. */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const URL = 'file://' + path.join(__dirname, '..', '..', 'index.html');
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || !detail ? '' : '\n     ' + detail)); };

async function newPage(ctx, errors) {
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 200)));
  await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.effectiveDirective + ' ' + e.blockedURI)); });
  await page.goto(URL);
  return page;
}
const wait = (page, ms) => page.waitForTimeout(ms);

// The settings of all views, as text. Two states with the same text have the same settings.
const settings = page => page.evaluate(() => JSON.stringify({
  node: GZ.state.request('nodeConfig:get'), cycle: GZ.state.request('cycleConfig:get'), stats: GZ.state.request('statsColumns:get')
}));
const analysisSummary = page => page.evaluate(() => {
  const a = GZ.state.data.currentAnalysis;
  return a ? JSON.stringify({ rows: a.times.length, tMin: a.tMin, tMax: a.tMax, sgs: a.allStats.map(s => s.col.name), others: a.otherColumns.length, cycles: a.cycleStarts.length, spl: a.splList, greens: a.allStats.map(s => s.stats.greens.length) }) : null;
});
const info = page => page.evaluate(() => document.getElementById('projectInfo').textContent);

// Sets up some settings in the views: two phases, a formula, a key figure column, the topology example.
async function configure(page) {
  await page.click('.tab-btn[data-tab="sd"]'); await wait(page, 300);
  await page.click('#sdAddPhase'); await wait(page, 120); await page.click('#sdAddPhase'); await wait(page, 120);
  const boxes = await page.$$('#sdPhaseTable [data-member]');
  for (let i = 0; i < Math.min(boxes.length, 6); i += 2) { await boxes[i].check(); await wait(page, 50); }
  await page.click('#sdSubnav > :nth-child(2)'); await wait(page, 300);
  await page.click('#topoExample'); await wait(page, 500);
  await page.click('#sdSubnav > :nth-child(1)'); await wait(page, 200);
  await page.click('.tab-btn[data-tab="up"]'); await wait(page, 300);
  await page.click('#upBausteinPanelHead'); await wait(page, 100);
  await page.click('#upAddFormulaBtn'); await wait(page, 250);
  const ed = await page.$('#upFormulaRows [contenteditable="true"]');
  await ed.click(); await page.keyboard.type('Zustand(K1) == GRUEN'); await wait(page, 200);
  await page.keyboard.press('Escape');
  await page.click('#upFormulaCalcBtn'); await wait(page, 700);
  await page.click('.tab-btn[data-tab="us"]'); await wait(page, 300);
  await page.click('#usAddColBtn'); await wait(page, 250);
  const ed2 = await page.$('#usColRows [contenteditable="true"]');
  await ed2.click(); await page.keyboard.type('TF(K1)'); await wait(page, 200);
  await page.keyboard.press('Escape'); await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await wait(page, 600);
}

async function download(page, selector) {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click(selector)]);
  const file = path.join(os.tmpdir(), 'grueni-e2e-' + Date.now() + '-' + d.suggestedFilename());
  await d.saveAs(file);
  return { file, name: d.suggestedFilename() };
}
const noPicker = page => page.evaluate(() => { window.showSaveFilePicker = undefined; });

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });

  /* ---------- working copy and restore ---------- */
  let page = await newPage(ctx, errors);
  await page.click('#btnSample');
  await page.waitForFunction(() => /gesichert/.test(document.getElementById('projectInfo').textContent), null, { timeout: 20000 });
  check('the import makes a working copy', /Arbeitskopie: .* · Beispieldaten · \d+ Zeilen · gesichert/.test(await info(page)), await info(page));
  check('the project buttons are on', await page.evaluate(() => !document.getElementById('btnProjectSave').disabled && !document.getElementById('btnConfigExport').disabled));
  await configure(page);
  await wait(page, 2500);                                   // the autosave runs 1.5 s after the last action
  const before = await settings(page);
  const summaryBefore = await analysisSummary(page);
  check('the settings are not empty', /"kuerzel":"Ph1"/.test(before) && /Zustand\(K1\)/.test(before) && /TF\(K1\)/.test(before) && /"axes":\[\{/.test(before), before.slice(0, 300));
  const stored = await page.evaluate(async () => {
    const s = await GZ.localStore.open({ namespace: GZ.localStore.namespaceFromPath(location.pathname) });
    const id = await s.getMeta('current'); const p = await s.getProject(id); s.close();
    return JSON.stringify({ node: p.lsas[0].config.nodeConfig, cycle: p.lsas[0].config.cycleConfig, stats: p.lsas[0].config.statsColumns });
  });
  check('the autosave saved the settings in IndexedDB', stored === before, 'stored length ' + stored.length + ', current length ' + before.length);

  page = await (async () => { await page.reload(); await page.waitForSelector('#projectBanner', { state: 'visible', timeout: 10000 }); return page; })();
  check('after a reload the banner offers the working copy', /Arbeitskopie vom .* · \d+ Zeilen/.test(await page.textContent('#projectBannerText')), await page.textContent('#projectBannerText'));
  await page.click('#btnRestore');
  await page.waitForFunction(() => !!GZ.state.data.currentAnalysis, null, { timeout: 20000 });
  await wait(page, 800);
  check('restore gives the same recording', (await analysisSummary(page)) === summaryBefore);
  const restored = await settings(page);
  check('restore gives the same settings', restored === before, 'lengths ' + before.length + ' vs ' + restored.length);
  check('the restored page has no running import', !(await page.isVisible('#projectBanner')));
  // the restored view works: the cycle check shows the phase track and the formula
  await page.click('.tab-btn[data-tab="up"]'); await wait(page, 500);
  check('the cycle check shows rows after restore', (await page.$$('#upRows .up-group, #upRows [data-cycle]')).length > 0 || (await page.textContent('#upInfo')).length > 0);

  /* ---------- project file: download ---------- */
  await noPicker(page);
  const saved = await download(page, '#btnProjectSave');
  check('the project is downloaded with a time stamp', /^.+_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.grueni\.zip$/.test(saved.name), saved.name);
  const zipBytes = fs.readFileSync(saved.file);
  check('the file is a ZIP', zipBytes[0] === 0x50 && zipBytes[1] === 0x4B, 'first bytes ' + zipBytes.slice(0, 4).toString('hex'));
  check('the project file is small', zipBytes.length < 400 * 1024, zipBytes.length + ' bytes');

  /* ---------- project file: save in place with a fake picker ---------- */
  await page.evaluate(() => {
    window.__writes = []; window.__picks = 0;
    const handle = { name: 'mein-projekt.grueni.zip', queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      createWritable: async () => { const parts = []; return { write: async b => { parts.push(b); }, abort: async () => {}, close: async () => { window.__writes.push(parts[0].length); } }; } };
    window.showSaveFilePicker = async () => { window.__picks++; return handle; };
  });
  await page.click('#btnProjectSave'); await wait(page, 700);
  await page.click('#btnProjectSave'); await wait(page, 700);
  const w = await page.evaluate(() => ({ writes: window.__writes.length, picks: window.__picks }));
  check('save in place asks for the file once and writes twice', w.writes === 2 && w.picks === 1, JSON.stringify(w));
  check('the bar names the file', /Datei: mein-projekt\.grueni\.zip/.test(await info(page)), await info(page));

  /* ---------- project file: open in a clean browser ---------- */
  const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const page2 = await newPage(ctx2, errors);
  check('a clean browser has no banner', !(await page2.isVisible('#projectBanner')));
  await page2.setInputFiles('#projectOpenInput', saved.file);
  await page2.waitForFunction(() => !!GZ.state.data.currentAnalysis, null, { timeout: 20000 });
  await wait(page2, 1200);
  check('open gives the same recording', (await analysisSummary(page2)) === summaryBefore);
  const opened = await settings(page2);
  check('open gives the same settings', opened === before, 'lengths ' + before.length + ' vs ' + opened.length);
  check('the opened project shows the file name', /Datei: .*\.grueni\.zip/.test(await info(page2)), await info(page2));
  // the cycle check output must match: compare the markup of the rows
  await page.click('.tab-btn[data-tab="up"]'); await page2.click('.tab-btn[data-tab="up"]'); await wait(page, 600); await wait(page2, 600);
  const rowsA = await page.evaluate(() => document.getElementById('upRows').innerHTML.length);
  const rowsB = await page2.evaluate(() => document.getElementById('upRows').innerHTML.length);
  check('the cycle check output has the same size after open', rowsA === rowsB && rowsA > 1000, rowsA + ' vs ' + rowsB);
  await page2.click('.tab-btn[data-tab="gz"]'); await wait(page2, 300);
  const gzA = await page.evaluate(() => { document.querySelector('.tab-btn[data-tab="gz"]').click(); return document.getElementById('tab-gz').textContent.replace(/\s+/g, ' ').length; });
  await wait(page, 400);
  const gzB = await page2.evaluate(() => document.getElementById('tab-gz').textContent.replace(/\s+/g, ' ').length);
  check('the green time tab has the same text length after open', gzA === gzB && gzA > 500, gzA + ' vs ' + gzB);

  /* ---------- the cache of decoded recordings ---------- */
  await page.evaluate(() => {
    window.__decodes = 0;
    const original = GZ.recordingCodec.decode;
    GZ.recordingCodec.decode = function () { window.__decodes++; return original.apply(this, arguments); };
  });
  await page.setInputFiles('#projectOpenInput', saved.file);
  await wait(page, 1500);
  check('opening the saved project in the same page does not decode again', (await page.evaluate(() => window.__decodes)) === 0, 'decodes ' + await page.evaluate(() => window.__decodes));
  check('the recording of a project from the cache is the same', (await analysisSummary(page)) === summaryBefore);
  await page.click('#btnSample');
  await page.waitForFunction(() => /Beispieldaten/.test(document.getElementById('projectInfo').textContent), null, { timeout: 20000 });
  await wait(page, 800);
  await page.setInputFiles('#projectOpenInput', saved.file);
  await wait(page, 1500);
  check('the cache keeps the earlier recording after another import', (await page.evaluate(() => window.__decodes)) === 0 && (await analysisSummary(page)) === summaryBefore, 'decodes ' + await page.evaluate(() => window.__decodes));

  /* ---------- configuration files ---------- */
  const cfg = await download(page, '#btnConfigExport');
  const cfgObj = JSON.parse(fs.readFileSync(cfg.file, 'utf8'));
  check('the configuration export has the format and no recording', cfgObj.format === 'grueni-config' && !('recordings' in cfgObj) && cfgObj.config.nodeConfig && cfgObj.config.statsColumns.length === 1, JSON.stringify(Object.keys(cfgObj)));
  check('the configuration file is small', fs.statSync(cfg.file).size < 200 * 1024, fs.statSync(cfg.file).size + ' bytes');
  const ctx3 = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const page3 = await newPage(ctx3, errors);
  await page3.setInputFiles('#configImportInput', cfg.file); await wait(page3, 600);
  check('a configuration without a recording gives a clear message', /Keine Aufzeichnung geladen/.test(await page3.textContent('.snackbar-stack')), await page3.textContent('.snackbar-stack'));
  await page3.click('#btnSample'); await page3.waitForFunction(() => /gesichert/.test(document.getElementById('projectInfo').textContent), null, { timeout: 20000 });
  await page3.setInputFiles('#configImportInput', cfg.file); await wait(page3, 1500);
  const imported = await settings(page3);
  check('the configuration import gives the same settings', imported === before, 'lengths ' + before.length + ' vs ' + imported.length);

  // the older files: the node configuration and the cycle check configuration of the tabs
  await page.click('.tab-btn[data-tab="sd"]'); await wait(page, 300);
  const oldNode = await download(page, '#sdConfigSaveBtn');
  await page.click('.tab-btn[data-tab="up"]'); await wait(page, 300);
  const oldCycle = await download(page, '#upConfigSaveBtn');
  const page4 = await newPage(await browser.newContext({ viewport: { width: 1500, height: 950 } }), errors);
  await page4.click('#btnSample'); await page4.waitForFunction(() => /gesichert/.test(document.getElementById('projectInfo').textContent), null, { timeout: 20000 });
  await page4.setInputFiles('#configImportInput', oldNode.file); await wait(page4, 800);
  const nodeOnly = JSON.parse(await settings(page4));
  check('the older node configuration file is read', nodeOnly.node && nodeOnly.node.phases.length === 2 && nodeOnly.node.phases[0].members.length > 0, JSON.stringify(nodeOnly.node && nodeOnly.node.phases));
  await page4.setInputFiles('#configImportInput', oldCycle.file); await wait(page4, 1200);
  const both = JSON.parse(await settings(page4));
  check('the older cycle check file is read', both.cycle && both.cycle.formulaBuilder && both.cycle.formulaBuilder.formulas.length === 1, JSON.stringify(both.cycle && both.cycle.formulaBuilder).slice(0, 200));

  /* ---------- bad files ---------- */
  const page5 = await newPage(await browser.newContext({ viewport: { width: 1500, height: 950 } }), errors);
  const tmp = name => path.join(os.tmpdir(), 'grueni-e2e-' + Date.now() + '-' + name);
  const notZip = tmp('text.zip'); fs.writeFileSync(notZip, 'this is no ZIP file, but it is long enough to pass the size check');
  await page5.setInputFiles('#projectOpenInput', notZip); await wait(page5, 600);
  check('a file that is not a ZIP gives an error message', /konnte nicht geöffnet werden/.test(await page5.textContent('.snackbar-stack')) && /ZIP/.test(await page5.textContent('.snackbar-stack')), await page5.textContent('.snackbar-stack'));
  const damaged = Buffer.from(zipBytes); damaged[Math.floor(damaged.length / 2)] ^= 0xFF;
  const dmg = tmp('damaged.zip'); fs.writeFileSync(dmg, damaged);
  await page5.setInputFiles('#projectOpenInput', dmg); await wait(page5, 1500);
  const msg = await page5.textContent('.snackbar-stack');
  check('a damaged project file gives an error and no recording', /konnte nicht geöffnet werden|beschädigt|Prüfsumme|checksum|damaged/i.test(msg) && !(await analysisSummary(page5)), msg.slice(0, 200));
  const newer = tmp('newer.zip');
  const newerBytes = await page5.evaluate(async () => {
    const p = GZ.project.createProject(); p.schemaVersion = 99;
    const z = await GZ.zip.create([{ name: 'project.json', data: new TextEncoder().encode(JSON.stringify(p)) }]);
    return Array.from(z);
  });
  fs.writeFileSync(newer, Buffer.from(newerBytes));
  await page5.setInputFiles('#projectOpenInput', newer); await wait(page5, 800);
  check('a project from a newer version is refused with a clear text', /zu neu/.test(await page5.textContent('.snackbar-stack')) && /Version 99/.test(await page5.textContent('.snackbar-stack')), await page5.textContent('.snackbar-stack'));
  const mapFile = tmp('map.json'); fs.writeFileSync(mapFile, JSON.stringify({ mapem: {} }));
  await page5.click('#btnSample'); await page5.waitForFunction(() => /gesichert/.test(document.getElementById('projectInfo').textContent), null, { timeout: 20000 });
  await page5.setInputFiles('#configImportInput', mapFile); await wait(page5, 600);
  check('a MAP file is refused as a configuration', /MAP-Datei/.test(await page5.textContent('.snackbar-stack')), await page5.textContent('.snackbar-stack'));

  /* ---------- the storage fails ---------- */
  const ctx6 = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page6 = await ctx6.newPage();
  const errors6 = [];
  page6.on('pageerror', e => errors6.push(e.message));
  await page6.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('denied', 'SecurityError'); } }); });
  await page6.goto(URL);
  await page6.click('#btnSample'); await wait(page6, 1500);
  check('without IndexedDB the page works and says so', !!(await analysisSummary(page6)) && /nicht im Browser gesichert|nicht gesichert/.test((await info(page6)) + (await page6.textContent('.snackbar-stack'))), await info(page6));
  await noPicker(page6);
  const f6 = await download(page6, '#btnProjectSave');
  check('without IndexedDB the project file can still be saved', fs.statSync(f6.file).size > 1000);

  const csp = [];
  for (const p of [page, page2, page3, page4, page5]) csp.push(...await p.evaluate(() => window.__csp));
  check('no violation of the content security policy', csp.length === 0, JSON.stringify(csp.slice(0, 5)));
  check('no page error', errors.length === 0 && errors6.length === 0, JSON.stringify(errors.slice(0, 5)) + JSON.stringify(errors6));
  await browser.close();
  const failed = results.filter(r => !r.ok).length;
  console.log(failed ? '\n' + failed + ' of ' + results.length + ' checks failed' : '\nall ' + results.length + ' checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
