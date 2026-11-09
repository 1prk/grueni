/* GZ.app — Bootstrap: Dateneingabe (Beispiel/Datei), Tabs, Analyse-
   Orchestrierung über die drei Fachansichten. Läuft vollständig lokal im
   Browser - es werden keinerlei Daten versendet (kein fetch/XHR im Code,
   keine externen Ressourcen im Dokument). */
(function (GZ) {
  'use strict';
  const { esc, fmtTimeShort } = GZ.format;

  const els = {};
  let resizeTimer = null;

  const TAB_REFRESH = {
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
    if (GZ.state.data.currentAnalysis && TAB_REFRESH[name]) TAB_REFRESH[name]();
  }

  // A time outside the recording has no cycle. A jump to it is refused with a message.
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

  // Redraws the active tab (after a log change, for example).
  function refreshActiveTab() {
    if (GZ.state.data.currentAnalysis && TAB_REFRESH[activeTab]) TAB_REFRESH[activeTab]();
  }

  // Loads a log file. A file without any usable entry does not replace a log that is already loaded.
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

  function analyze() {
    clearError();
    let parsed;
    try { parsed = GZ.parser.parseOcitText(els.rawInput.value); }
    catch (e) { showError(e.message); return; }

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

    // #contentArea muss sichtbar sein (display != none), BEVOR die Diagramme
    // gerendert werden - die D3-Charts messen die Pixelgröße ihrer Container,
    // die bei display:none immer 0 wäre.
    els.contentArea.classList.add('show');

    // Phasen zuerst zurücksetzen, damit die Grünzeitanalyse (Phasen-Overlay-
    // Sichtbarkeit) beim eigenen onAnalyzeComplete() bereits den korrekten,
    // leeren Phasenstand der neuen Analyse sieht statt der alten Phasenliste.
    GZ.views.stammdatenLsa.onAnalyzeComplete();
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
    document.getElementById('fileInput').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { els.rawInput.value = reader.result; analyze(); };
      reader.readAsText(file, 'utf-8');
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
