/* GZ.app is the bootstrap. It handles data input (sample or file) and the tabs.
   It also controls the analysis across the three technical views.
   It runs fully local in the browser. The application sends no data.
   The code has no fetch or XHR. The document has no external resources. */
(function (GZ) {
  'use strict';
  const { esc, fmtTimeShort } = GZ.format;

  const els = {};
  let resizeTimer = null;

  const TAB_REFRESH = {
    sd: () => GZ.views.stammdatenTopologie.refresh(),
    gz: () => GZ.views.gruenzeitanalyse.refresh(),
    pa: () => GZ.views.phasenauswertung.refresh(),
    wz: () => GZ.views.wartezeit.refresh(),
    oe: () => GZ.views.oepnvQa.recompute(),
    up: () => GZ.views.umlaufpruefung.render(),
    us: () => GZ.views.umlaufstatistiken.recompute()
  };
  let activeTab = 'gz';

  function switchTab(name) {
    activeTab = name;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
    // The topology editor (tab "sd") works without a recording. All other tabs need a recording.
    const hasData = !!GZ.state.data.currentAnalysis;
    els.contentArea.classList.toggle('show', hasData || name === 'sd');
    if ((hasData || name === 'sd') && TAB_REFRESH[name]) TAB_REFRESH[name]();
  }

  // A time outside the recording has no cycle. The application refuses a jump to it and shows a
  // message.
  function inRecording(t) {
    const a = GZ.state.data.currentAnalysis;
    return !!a && t >= a.tMin && t <= a.tMax;
  }
  function refuseOutside(t) {
    const a = GZ.state.data.currentAnalysis;
    if (!a) { GZ.snackbar.show('Keine Aufzeichnung geladen', { type: 'warning' }); return true; }
    if (inRecording(t)) return false;
    const f = GZ.format.fmtTs;
    GZ.snackbar.show('Außerhalb der Aufzeichnung', { type: 'warning', description: `${f(new Date(t))} liegt nicht im Zeitraum ${f(new Date(a.tMin))} – ${f(new Date(a.tMax))}.` });
    return true;
  }

  // Opens the cycle that contains a log entry (or any time) in the cycle check.
  function jumpToLog(entry) {
    if (refuseOutside(entry.t)) return;
    switchTab('up');
    GZ.views.umlaufpruefung.jumpTo(entry.t, entry);
    GZ.views.logBar.markActive(entry);
  }
  function jumpToTime(t) {
    if (refuseOutside(t)) return;
    switchTab('up');
    GZ.views.umlaufpruefung.jumpTo(t, null);
  }

  // Redraws the active tab, for example after a log change.
  function refreshActiveTab() {
    if (GZ.state.data.currentAnalysis && TAB_REFRESH[activeTab]) TAB_REFRESH[activeTab]();
  }

  // Loads a log file. A file without a usable entry does not replace a log that is already loaded.
  function loadLogText(text, fileName) {
    const parsed = GZ.logs.parse(text);
    if (!parsed.entries.length) return parsed;
    GZ.logs.load(text, fileName);
    GZ.views.logBar.render();
    refreshActiveTab();
    return parsed;
  }

  function showError(msg) {
    els.errorBox.textContent = msg;
    els.errorBox.style.display = 'block';
    els.contentArea.classList.remove('show');
    els.dataPanel.classList.add('open');
    els.btnExport.disabled = true;
  }
  function clearError() { els.errorBox.style.display = 'none'; }

  // Pasted text or sample data: the text box is the source.
  function analyze() {
    clearError();
    let parsed;
    try { parsed = GZ.csvImport.importText(els.rawInput.value); }
    catch (e) { showError(e.message); return; }
    analyzeParsed(parsed);
  }

  // `parsed` comes from GZ.csvImport. It has the same shape as the result of
  // GZ.parser.parseOcitText, plus `table`.
  function analyzeParsed(parsed) {
    const { columns, otherColumns, times, seriesByCol, totalRows, skippedRows, knotenName, knotenNr, cycleStarts } = parsed;
    const tMin = times[0], tMax = times[times.length - 1] + GZ.parser.estimateStep(times);

    const allStats = columns.map(col => {
      const segs = GZ.segments.buildSegments(times, seriesByCol.get(col.index));
      const stats = GZ.segments.computeCycleStats(segs);
      stats.bySpl = GZ.segments.computeCycleStatsBySpl(segs, times, parsed.splValues);
      return { col, segs, stats };
    });
    const splSet = new Set();
    allStats.forEach(({ stats }) => stats.bySpl.forEach((_, spl) => splSet.add(spl)));
    const splList = GZ.stats.sortSplList(splSet);

    GZ.state.data.currentAnalysis = {
      allStats, tMin, tMax, cycleStarts, otherColumns, times, seriesByCol,
      splValues: parsed.splValues, tcValues: parsed.tcValues, splList, knotenName, knotenNr
    };

    const durationMin = ((tMax - tMin) / 60000).toFixed(0);
    const otherInfo = otherColumns.length
      ? ` · ${otherColumns.length} weitere Spalte(n) erkannt (${[...new Set(otherColumns.map(o => o.kuerzel))].join(', ')}) – siehe Tab „Wartezeit ab Anforderung“`
      : '';
    const knotenInfo = (knotenName || knotenNr)
      ? ` · Knoten <b>${esc(knotenName) || '–'}</b>${knotenNr ? ' (Nr. ' + esc(knotenNr) + ')' : ''}`
      : '';
    els.statusLine.innerHTML = `Datenprüfung: <span class="ok">OK</span>${knotenInfo} · <b>${totalRows}</b> Zeilen verarbeitet, <b>${skippedRows}</b> übersprungen · Zeitraum <b>${fmtTimeShort(tMin)}–${fmtTimeShort(tMax)}</b> (${durationMin} min) · <b>${columns.length}</b> Signalgruppe(n)${otherInfo}`;
    els.statusLine.style.display = 'block';
    els.dataPanelSummary.innerHTML = `<span class="ok">OK</span> · ${columns.length} Signalgruppe(n) · ${fmtTimeShort(tMin)}–${fmtTimeShort(tMax)}`;
    els.dataPanel.classList.remove('open');

    // #contentArea must be visible (display is not none) BEFORE the charts render.
    // The D3 charts measure the pixel size of their containers.
    // With display:none this size is always 0.
    els.contentArea.classList.add('show');

    // Reset the phases first.
    // Then the green time analysis (visibility of the phase overlay) sees the correct, empty phase
    // state
    // of the new analysis in its own onAnalyzeComplete(). It does not see the old phase list.
    GZ.views.stammdatenLsa.onAnalyzeComplete();
    GZ.views.stammdatenTopologie.onAnalyzeComplete();
    GZ.views.gruenzeitanalyse.onAnalyzeComplete();
    GZ.views.phasenauswertung.onAnalyzeComplete();
    GZ.views.wartezeit.onAnalyzeComplete();
    GZ.views.oepnvQa.populateControls();
    GZ.views.formulaBuilder.populateControls();
    GZ.views.umlaufpruefung.populateControls();
    GZ.views.umlaufstatistiken.populateControls();

    GZ.views.logBar.render();
    els.btnExport.disabled = false;
  }

  function init() {
    els.rawInput = document.getElementById('rawInput');
    els.errorBox = document.getElementById('errorBox');
    els.statusLine = document.getElementById('statusLine');
    els.contentArea = document.getElementById('contentArea');
    els.btnExport = document.getElementById('btnExport');
    els.dataPanel = document.getElementById('dataPanel');
    els.dataPanelHead = document.getElementById('dataPanelHead');
    els.dataPanelSummary = document.getElementById('dataPanelSummary');

    GZ.views.logBar.init(refreshActiveTab);
    GZ.views.gruenzeitanalyse.init(document.getElementById('tab-gz'));
    GZ.views.stammdatenLsa.init(document.getElementById('tab-sd'));
    GZ.views.stammdatenTopologie.init(document.getElementById('tab-sd'));
    GZ.views.phasenauswertung.init(document.getElementById('tab-pa'));
    GZ.views.wartezeit.init(document.getElementById('tab-wz'));
    GZ.views.oepnvQa.init(document.getElementById('tab-oe'));
    GZ.views.formulaBuilder.init(document.getElementById('tab-up'));
    GZ.views.umlaufpruefung.init(document.getElementById('tab-up'));
    GZ.views.umlaufstatistiken.init(document.getElementById('tab-us'));

    document.getElementById('btnAnalyze').addEventListener('click', analyze);
    document.getElementById('btnSample').addEventListener('click', () => {
      els.rawInput.value = GZ.sampleData.generateSampleText();
      analyze();
      loadLogText(GZ.sampleData.generateSampleLog(), 'Beispiel-Log');
    });
    document.getElementById('logInput').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const parsed = loadLogText(reader.result, file.name);
        if (!parsed.entries.length) GZ.snackbar.show('Keine Log-Einträge erkannt', { type: 'warning', description: 'Erwartet: Stufe, Zeitstempel (TT.MM.JJJJ, HH:MM:SS), Text – je Zeile.' });
      };
      reader.readAsText(file, 'utf-8');
      e.target.value = '';
    });
    // A file goes straight to the importer. It does not pass through the text box.
    // So the page does not keep a big recording twice.
    document.getElementById('fileInput').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      clearError();
      const previousSummary = els.dataPanelSummary.innerHTML;
      els.rawInput.value = '';
      els.dataPanelSummary.textContent = 'Lese ' + file.name + ' …';
      let parsed;
      try {
        parsed = await GZ.csvImport.importFile(file, {
          onProgress: p => { els.dataPanelSummary.textContent = 'Lese ' + file.name + ' … ' + Math.round(p * 100) + ' %'; }
        });
      } catch (err) {
        els.dataPanelSummary.innerHTML = previousSummary;
        showError(err.message);
        e.target.value = '';
        return;
      }
      analyzeParsed(parsed);
      e.target.value = '';
    });
    els.btnExport.addEventListener('click', () => GZ.views.gruenzeitanalyse.exportStatsCSV());
    els.dataPanelHead.addEventListener('click', () => els.dataPanel.classList.toggle('open'));

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (GZ.state.data.currentAnalysis && TAB_REFRESH[activeTab]) TAB_REFRESH[activeTab]();
      }, 150);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
  GZ.app = { switchTab, analyze, refreshActiveTab, jumpToLog, jumpToTime, inRecording };
})(window.GZ = window.GZ || {});
