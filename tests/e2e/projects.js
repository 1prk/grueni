/* End-to-end check of projects with several LSAs and several recordings in a real browser.
   It is not part of the application. It needs Playwright.
     node tests/e2e/projects.js
   The script plays through these cases with files that it makes from the sample recording:
   - add a recording to the LSA (next day), the settings stay, and the check for a day that overlaps or has another node number
   - select recordings and LSAs, the settings belong to the LSA
   - a new LSA from a file, rename, remove, and the rules for the last recording and the last LSA
   - save the project, open it in a clean browser, restore after a reload
   - the question before a new import replaces a project with unsaved recordings
   The exit code is 1 when a case fails. */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const URL = 'file://' + path.join(__dirname, '..', '..', 'index.html');
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok || !detail ? '' : '\n     ' + detail)); };
const wait = (page, ms) => page.waitForTimeout(ms);
const tmp = name => path.join(os.tmpdir(), 'grueni-e2e-' + process.pid + '-' + name);

async function newPage(ctx, errors) {
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 200)));
  await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.effectiveDirective + ' ' + e.blockedURI)); });
  // Every question of the page is recorded. The test sets how the page gets the answer.
  await page.addInitScript(() => { window.__dialogs = []; window.__answer = true; window.confirm = m => { window.__dialogs.push(m); return window.__answer; }; });
  await page.goto(URL);
  return page;
}
const overview = page => page.evaluate(() => JSON.parse(JSON.stringify(GZ.state.request('projectOverview'))));
const summary = o => o.lsas.map(l => (l.active ? '*' : '') + l.name + '[' + l.recordings.map(r => (r.active ? '*' : '') + r.name).join(',') + ']').join(' ');
const stats = page => page.evaluate(() => JSON.stringify(GZ.state.request('statsColumns:get')));
const tMin = page => page.evaluate(() => GZ.state.data.currentAnalysis && GZ.state.data.currentAnalysis.tMin);
const dialogs = page => page.evaluate(() => window.__dialogs.slice());
const clearDialogs = page => page.evaluate(() => { window.__dialogs.length = 0; });
async function settle(page) { await wait(page, 700); }

async function addStatsColumn(page, expr) {
  await page.click('.tab-btn[data-tab="us"]'); await wait(page, 300);
  await page.click('#usAddColBtn'); await wait(page, 250);
  const eds = await page.$$('#usColRows [contenteditable="true"]');
  await eds[eds.length - 1].click(); await page.keyboard.type(expr); await wait(page, 200);
  await page.keyboard.press('Escape'); await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await wait(page, 600);
}
async function openPanel(page) {
  if (!(await page.isVisible('#projectPanel'))) await page.click('#btnProjectPanel');
  await wait(page, 150);
}
async function clickItem(page, listId, name, action) {
  const li = page.locator('#' + listId + ' .project-item', { hasText: name }).first();
  await li.locator(action ? 'button[data-action="' + action + '"]' : 'button[data-action="select"]').click();
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const page = await newPage(ctx, errors);

  // The files.
  const sample = await page.evaluate(() => GZ.sampleData.generateSampleText());
  const files = {
    day1: tmp('tag1.csv'), day2: tmp('tag2.csv'), otherNode: tmp('anderer-knoten.csv'), otherColumns: tmp('andere-spalten.csv'), newLsa: tmp('neue-lsa.csv')
  };
  fs.writeFileSync(files.day1, sample);
  fs.writeFileSync(files.day2, sample.replace(/03\.11\.26/g, '04.11.26'));
  fs.writeFileSync(files.otherNode, sample.replace(/03\.11\.26/g, '05.11.26').replace('No\t231', 'No\t999'));
  fs.writeFileSync(files.otherColumns, sample.replace(/03\.11\.26/g, '06.11.26').replace('\tK2\t', '\tK9\t'));
  fs.writeFileSync(files.newLsa, sample.replace(/03\.11\.26/g, '03.11.26').replace('No\t231', 'No\t500').replace('KNOTEN 231 - Bahnhofstr./Ringstr.', 'KNOTEN 500 - Marktplatz').replace('\tK2\t', '\tK7\t'));

  /* ---------- one recording ---------- */
  await page.setInputFiles('#fileInput', files.day1);
  await page.waitForFunction(() => /gesichert/.test(document.getElementById('projectInfo').textContent), null, { timeout: 20000 });
  await addStatsColumn(page, 'TF(K1)');
  const stats1 = await stats(page);
  check('the settings have a column', /TF\(K1\)/.test(stats1), stats1);
  let o = await overview(page);
  check('one LSA with one recording', o.lsas.length === 1 && o.lsas[0].recordings.length === 1, summary(o));
  check('the panel button shows the counts', /\(1 · 1\)/.test(await page.textContent('#btnProjectPanel')), await page.textContent('#btnProjectPanel'));
  await openPanel(page);
  check('the panel lists the LSA and the recording', (await page.$$('#lsaList .project-item')).length === 1 && (await page.$$('#recList .project-item')).length === 1);
  const t1 = await tMin(page);

  /* ---------- add the next day ---------- */
  await page.setInputFiles('#recAddInput', files.day2);
  await page.waitForFunction(() => GZ.state.request('projectOverview').lsas[0].recordings.length === 2, null, { timeout: 20000 });
  await settle(page);
  o = await overview(page);
  check('the next day is the second recording and is active', o.lsas[0].recordings.length === 2 && o.lsas[0].recordings[1].active, summary(o));
  check('no question for the next day with the same columns', (await dialogs(page)).length === 0, JSON.stringify(await dialogs(page)));
  const t2 = await tMin(page);
  check('the page shows the second day', t2 - t1 === 86400000, t1 + ' ' + t2);
  check('the settings stay for the next day', (await stats(page)) === stats1);
  const warned = await page.evaluate(() => Array.from(document.querySelectorAll('.snackbar, [class*=snack]')).map(e => e.textContent).join(' '));
  check('the next day gives no warning about the settings', !/teilweise übernommen|andere Aufzeichnung/.test(warned), warned.slice(0, 300));

  /* ---------- a day that overlaps ---------- */
  await clearDialogs(page);
  await page.evaluate(() => { window.__answer = false; });
  await page.setInputFiles('#recAddInput', files.day2);
  await wait(page, 2500);
  let d = await dialogs(page);
  check('a day that overlaps asks first', d.length === 1 && /überschneidet sich mit der Aufzeichnung „[^“]*tag2\.csv“/.test(d[0]), JSON.stringify(d));
  check('"No" keeps the recordings as they are', (await overview(page)).lsas[0].recordings.length === 2);

  /* ---------- another node number and other columns ---------- */
  await clearDialogs(page);
  await page.setInputFiles('#recAddInput', files.otherNode);
  await wait(page, 2500);
  d = await dialogs(page);
  check('another node number asks first', d.length === 1 && /Knotennummer ist 999/.test(d[0]) && /Knotennummer 231/.test(d[0]), JSON.stringify(d));
  await clearDialogs(page);
  await page.setInputFiles('#recAddInput', files.otherColumns);
  await wait(page, 2500);
  d = await dialogs(page);
  check('missing signal groups ask first', d.length === 1 && /Signalgruppen .* fehlen: K2/.test(d[0]), JSON.stringify(d));
  check('nothing was added', (await overview(page)).lsas[0].recordings.length === 2);
  await page.evaluate(() => { window.__answer = true; });
  await page.setInputFiles('#recAddInput', files.otherColumns);
  await page.waitForFunction(() => GZ.state.request('projectOverview').lsas[0].recordings.length === 3, null, { timeout: 20000 });
  await settle(page);
  check('"Yes" adds the recording', (await overview(page)).lsas[0].recordings[2].active);
  check('the new column shows up in the analysis', await page.evaluate(() => GZ.state.data.currentAnalysis.allStats.some(s => s.col.name === 'K9')));
  const snackText = await page.evaluate(() => Array.from(document.querySelectorAll('.snackbar, [class*=snack]')).map(e => e.textContent).join(' '));
  check('the note names the new column', /Neue Spalten: K9/.test(snackText), snackText.slice(0, 300));

  /* ---------- select a recording ---------- */
  await openPanel(page);
  await clickItem(page, 'recList', 'tag1.csv');
  await page.waitForFunction(t => GZ.state.data.currentAnalysis && GZ.state.data.currentAnalysis.tMin === t, t1, { timeout: 20000 });
  await settle(page);
  check('selecting the first recording shows day 1', (await tMin(page)) === t1);
  check('the settings are the same for this recording', (await stats(page)) === stats1);
  o = await overview(page);
  check('the list marks the active recording', o.lsas[0].recordings[0].active && !o.lsas[0].recordings[1].active, summary(o));

  /* ---------- a new LSA ---------- */
  await page.setInputFiles('#lsaNewInput', files.newLsa);
  await page.waitForFunction(() => GZ.state.request('projectOverview').lsas.length === 2, null, { timeout: 20000 });
  await settle(page);
  o = await overview(page);
  check('a new LSA is active and named after the node', o.lsas[1].active && /KNOTEN 500/.test(o.lsas[1].name) && o.lsas[1].nodeNo === '500', summary(o));
  check('the new LSA starts without settings', (await stats(page)) === '[]', await stats(page));
  await addStatsColumn(page, 'Ab(K1)');
  const stats2 = await stats(page);
  await openPanel(page);
  await clickItem(page, 'lsaList', 'KNOTEN 231');
  await page.waitForFunction(t => GZ.state.data.currentAnalysis && GZ.state.data.currentAnalysis.tMin === t, t1, { timeout: 20000 });
  await settle(page);
  check('back in the first LSA, its settings are back', (await stats(page)) === stats1, await stats(page));
  await clickItem(page, 'lsaList', 'KNOTEN 500');
  await settle(page);
  check('the second LSA keeps its own settings', (await stats(page)) === stats2 && /Ab\(K1\)/.test(stats2), await stats(page));
  await clickItem(page, 'lsaList', 'KNOTEN 231');
  await settle(page);

  /* ---------- rename ---------- */
  await clickItem(page, 'recList', 'tag2.csv', 'rename');
  await page.keyboard.type('Dienstag');       // the text field has the focus and the old text is selected
  await page.keyboard.press('Enter');
  await wait(page, 300);
  await clickItem(page, 'lsaList', 'KNOTEN 231', 'rename');
  await page.keyboard.type('Bahnhof');
  await page.keyboard.press('Enter');
  await wait(page, 300);
  o = await overview(page);
  check('rename works for a recording and for an LSA', o.lsas[0].name === 'Bahnhof' && o.lsas[0].recordings[1].name === 'Dienstag', summary(o));
  await clickItem(page, 'recList', 'Dienstag', 'rename');
  await page.keyboard.press('Escape');
  await wait(page, 200);
  check('Escape keeps the name', (await overview(page)).lsas[0].recordings[1].name === 'Dienstag');

  /* ---------- remove ---------- */
  await clearDialogs(page);
  await clickItem(page, 'recList', 'andere-spalten.csv', 'remove');
  await wait(page, 800);
  o = await overview(page);
  check('remove asks and then removes a recording', (await dialogs(page)).length === 1 && o.lsas[0].recordings.length === 2, summary(o));
  const chunkCount = await page.evaluate(async () => {
    const s = await GZ.localStore.open({ namespace: GZ.localStore.namespaceFromPath(location.pathname) });
    const id = await s.getMeta('current'); const p = await s.getProject(id);
    const keys = GZ.project.chunkKeys(p); let present = 0;
    for (const k of keys) if (await s.hasChunk(k)) present++;
    const total = await new Promise(res => { const r = s.db.transaction(['chunks'], 'readonly').objectStore('chunks').count(); r.onsuccess = () => res(r.result); });
    s.close();
    return { keys: keys.length, present, total };
  });
  check('the browser store has no chunk of the removed recording', chunkCount.keys === chunkCount.present && chunkCount.total === chunkCount.keys, JSON.stringify(chunkCount));
  await page.evaluate(() => { window.__answer = false; });
  await clearDialogs(page);
  await clickItem(page, 'lsaList', 'KNOTEN 500', 'remove');
  await wait(page, 300);
  check('"No" keeps the LSA', (await overview(page)).lsas.length === 2);
  await page.evaluate(() => { window.__answer = true; });
  await clickItem(page, 'lsaList', 'KNOTEN 500', 'remove');
  await wait(page, 800);
  o = await overview(page);
  check('remove takes out an LSA', o.lsas.length === 1, summary(o));
  await clearDialogs(page);
  await clickItem(page, 'lsaList', 'Bahnhof', 'remove');
  await wait(page, 300);
  check('the last LSA stays', (await overview(page)).lsas.length === 1 && (await dialogs(page)).length === 0);

  /* ---------- the question before a new import ---------- */
  await clearDialogs(page);
  await page.evaluate(() => { window.__answer = false; });
  await page.click('#btnSample');
  await wait(page, 600);
  d = await dialogs(page);
  check('a new import asks when the project has unsaved recordings', d.length === 1 && /2 Aufzeichnungen/.test(d[0]), JSON.stringify(d));
  check('"No" keeps the project', (await overview(page)).lsas[0].recordings.length === 2);

  /* ---------- project file ---------- */
  await page.evaluate(() => { window.showSaveFilePicker = undefined; });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click('#btnProjectSave')]);
  const zip = tmp('projekt.grueni.zip');
  await dl.saveAs(zip);
  await wait(page, 500);
  await clearDialogs(page);
  await page.evaluate(() => { window.__answer = true; });
  const before = JSON.stringify(await overview(page));
  const page2 = await newPage(await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true }), errors);
  await page2.setInputFiles('#projectOpenInput', zip);
  await page2.waitForFunction(() => !!GZ.state.data.currentAnalysis, null, { timeout: 20000 });
  await wait(page2, 800);
  check('open gives the same LSAs and recordings', JSON.stringify(await overview(page2)) === before, summary(await overview(page2)));
  check('open gives the same settings', (await stats(page2)) === stats1);
  const warned2 = await page2.evaluate(() => Array.from(document.querySelectorAll('.snackbar, [class*=snack]')).map(e => e.textContent).join(' '));
  check('open gives no warning about the settings', !/teilweise|Nicht gefunden/.test(warned2), warned2.slice(0, 300));
  await openPanel(page2);
  await clickItem(page2, 'recList', 'Dienstag');
  await page2.waitForFunction(t => GZ.state.data.currentAnalysis.tMin === t, t2, { timeout: 20000 });
  check('a recording of the opened file can be selected', (await tMin(page2)) === t2);

  // A saved project can be replaced without a question.
  await page.click('#btnSample');
  await page.waitForFunction(() => GZ.state.request('projectOverview').lsas[0].recordings.length === 1, null, { timeout: 20000 });
  check('after the save the import replaces the project without a question', (await dialogs(page)).length === 0);

  /* ---------- reload and restore ---------- */
  await page2.reload();
  await page2.waitForSelector('#projectBanner', { state: 'visible', timeout: 10000 });
  await page2.click('#btnRestore');
  await page2.waitForFunction(() => !!GZ.state.data.currentAnalysis, null, { timeout: 20000 });
  await wait(page2, 800);
  const restored = await overview(page2);
  check('restore gives the LSA and both recordings back', restored.lsas.length === 1 && restored.lsas[0].recordings.length === 2 && restored.lsas[0].recordings[1].active, summary(restored));

  /* ---------- no problems ---------- */
  for (const p of [page, page2]) {
    const csp = await p.evaluate(() => window.__csp);
    check('no violation of the content security policy', csp.length === 0, JSON.stringify(csp));
  }
  check('no page error', errors.length === 0, errors.join(' | '));

  await browser.close();
  Object.values(files).concat([zip]).forEach(f => { try { fs.unlinkSync(f); } catch (e) { /* not important */ } });
  const failed = results.filter(r => !r.ok);
  console.log('\n' + (failed.length ? failed.length + ' of ' + results.length + ' checks failed' : 'all ' + results.length + ' checks passed'));
  process.exit(failed.length ? 1 : 0);
})();
