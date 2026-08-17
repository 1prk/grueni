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
    wz: () => GZ.views.wartezeit.recompute(),
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

  function jumpToGruenzeit(t) {
    switchTab('gz');
    GZ.views.gruenzeitanalyse.jumpTo(t);
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
      splValues: parsed.splValues, tcValues: parsed.tcValues, splList
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
    GZ.views.wartezeit.populateControls();
    GZ.views.oepnvQa.populateControls();
    GZ.views.formulaBuilder.populateControls();
    GZ.views.umlaufpruefung.populateControls();
    GZ.views.umlaufstatistiken.populateControls();

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
  GZ.app = { switchTab, jumpToGruenzeit, analyze };
})(window.GZ = window.GZ || {});
