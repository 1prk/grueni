/* GZ.views.umlaufpruefung is the tab "Umlaufprüfung".
   It shows one row for each cycle (TX=0 limit).
   The look is the same as the signal time diagram.
   But each row is scaled to its own cycle and not to a common time window.
   The user selects signal groups, detectors, APW/ÖPNV values and synthetic formula columns
   (formula builder, see formulaBuilder.js).
   The selection uses ONE unified, searchable object list (see allObjects() and #upObjList).
   The user can sort the list freely with the handle on the left (objectOrder and wireObjDrag()).
   This order directly sets the track order in the cycle output below.
   Signal groups stay main rows with An/Ab/TF values.
   All other objects are narrower side tracks.
   The user can nest both kinds freely.
   The filter that decides WHICH cycles the tab shows is a separate list on purpose.
   It has its own conditions that depend on the type (state equality or number comparison, see
   filterRows and computeMatchingCycles()).
   It does not depend on the object selection or order.
   Each track supports a manual Ctrl+click time measurement (see below).
   A hover crosshair goes over all tracks of a cycle (TX in seconds).

   Performance with large recordings (many cycles or measurement rows):
   - All lookups for each cycle run over a continuous sweep.
     The lookups are the green segment, the signal and detector segments and the APW raw values.
     The sweep is GZ.segments.makeIntervalSweep, makeIndexSweep or a local row pointer.
     This avoids a full scan for each cycle.
     The cost is amortized O(n) over the whole recording and not O(n²) or O(cycles × measurement
     rows).
   - The code measures the width and height of the track SVGs once for each render pass (not for
     each row).
     It passes them to renderLane.
     This avoids layout thrashing (DOM writes and forced layout in turns) with many rows.
   - A cycle window (as in the signal time diagram) limits the number of DOM and SVG nodes that
     the code renders at the same time.
     So the view stays smooth also for very long recordings (thousands of cycles). */
GZ.define('views.umlaufpruefung', { layer: 'views', deps: ['charts.logMarkers', 'charts.timelineLane', 'configIO', 'exprEngine', 'format', 'greenTime', 'logs', 'oepnvLogic', 'parser', 'phases', 'segments', 'snackbar', 'state'] }, function (GZ) {
  'use strict';
  const { esc, fmtTs, fmtTimeShort } = GZ.format;
  const {
    buildSegments, computeGlobalTU, findSplAt, computeSegmentAnAbTf, getFlaggedAnomalies,
    makeIntervalSweep, makeIndexSweep
  } = GZ.segments;
  const { categorizeDetRaw } = GZ.parser;
  const { renderLane, renderTimeAxis } = GZ.charts.timelineLane;
  const { wzIstBelegt, computeOepnvEvents } = GZ.oepnvLogic;

  let els = null;
  let windowCount = 20, windowStartIdx = 0, showAll = false;
  // Irregular cycles are much longer than the median cycle time (for example a dark period without
  // TX).
  // The view shows them shortened.
  // This set holds the cycles that the user expanded to full length.
  let expandedCycles = new Set();
  // jumpTo() sets it. The next render() handles it.
  let pendingJump = null;
  // Cycles whose log ribbon shows all entries (otherwise it shows the first few).
  let expandedLogs = new Set();
  const RIBBON_LINES = 4;
  const CROP_FACTOR = 1.5; // shortened cycles show the first 1.5 x median cycle time
  let lastEffectiveCount = 0; // number of cycles after the current filter (for the window navigation)

  // Unified object list (SG, DET, APW, ÖPNV and FORMEL in ONE list, see allObjects()).
  // objectOrder is the display and output order of ALL known objects (checked or not).
  // It is an array of keys ("<short name>|<index>", see objKey()).
  // The user can change the order with the handle on the left (wireObjDrag()).
  // Selected means checked in the DOM.
  // There is no separate JS selection set.
  // This is the same convention as the earlier checklists.
  // The array stays over render passes.
  // The code resets it only at a new data import (populateControls()).
  // The code reconciles it for new formula columns or a configuration import
  // (reconcileObjectOrder()).
  let objectOrder = [];
  // Multiple selection in the object list (Ctrl+click).
  // It is only to drag several rows TOGETHER at the same time (see wireObjDrag()).
  // It does not depend on the checked state.
  // Checked means "in the cycle output". This set means "move together".
  // The set stays over render passes (as objectOrder does).
  // The code compares it with the known objects (renderObjList()).
  let multiSelectKeys = new Set();
  // Filter conditions (separate from the object selection and order above).
  // Each row is combined with AND: {id, key, op, value}.
  // The meaning of op and value depends on the object type.
  // For SG, DET and FORMEL, it is state equality.
  // For APW and ÖPNV, it is a comparison operator and a number.
  // See defaultCondFor() and computeMatchingCycles().
  let filterRows = [];
  let nextFilterId = 1;

  // Manual time measurement (Ctrl+click).
  // The state is for each (cycle, track) and stays over render passes.
  // See wireMeasure() and measureClickHandler().
  // Key: "<cycle index>|<track kind>|<identifier>".
  // Value: {a, b} in ms (Unix time).
  // b is null as long as only one mark exists.
  let measurements = new Map();

  // PÜ detail tool (see togglePueDetail() and renderPueDetailPanel() below).
  // At most ONE detail panel is open at the same time.
  // It is tied to a specific occurrence of a cycle and a phase transition.
  // cycleIdx is the index in cycleStarts.
  // It is NOT the position in the window that is visible now.
  // So it stays valid when the user pages or filters, also if the row is not visible at this time.
  // null means closed.
  let openPueDetail = null; // {cycleIdx, fromPhaseId, toPhaseId} | null

  function init(root) {
    els = {
      root,
      objList: root.querySelector('#upObjList'),
      objSearch: root.querySelector('#upObjSearch'),
      fzToggle: root.querySelector('#upFzToggle'),
      laneStyle: root.querySelector('#upLaneStyle'),
      filterRowsEl: root.querySelector('#upFilterRows'),
      addFilterBtn: root.querySelector('#upAddFilterBtn'),
      hint: root.querySelector('#upHint'),
      tablePanel: root.querySelector('#upTablePanel'),
      sgLabel: root.querySelector('#upSgLabel'),
      info: root.querySelector('#upInfo'),
      rows: root.querySelector('#upRows'),
      diagramControls: root.querySelector('#upDiagramControls'),
      btnWinPrev: root.querySelector('#upBtnWinPrev'),
      winLabel: root.querySelector('#upWinLabel'),
      btnWinNext: root.querySelector('#upBtnWinNext'),
      winSize: root.querySelector('#upWinSize'),
      btnWinAll: root.querySelector('#upBtnWinAll'),
      configSaveBtn: root.querySelector('#upConfigSaveBtn'),
      configLoadInput: root.querySelector('#upConfigLoadInput'),
      logFilter: root.querySelector('#upLogFilter'),
      logFilterLevel: root.querySelector('#upLogFilterLevel'),
      logFilterHint: root.querySelector('#upLogFilterHint')
    };
    els.logFilter.addEventListener('change', render);
    els.logFilterLevel.addEventListener('change', render);

    // Other views tell the store when formula columns, key figures or phases change.
    GZ.state.on('syntheticColumns:changed', refreshSyntheticColumns);
    GZ.state.on('phases:changed', refreshSyntheticColumns);

    // Buttons inside the cycle list: expand or shorten an irregular cycle, and close a jump note.
    els.rows.addEventListener('click', e => {
      const close = e.target.closest('button.up-jump-close');
      if (close) { close.closest('.up-jump-note').remove(); return; }
      const more = e.target.closest('button.up-log-more');
      if (more) {
        const ci = Number(more.dataset.cycle);
        if (expandedLogs.has(ci)) expandedLogs.delete(ci); else expandedLogs.add(ci);
        render();
        return;
      }
      const b = e.target.closest('button.up-expand');
      if (!b) return;
      const i = Number(b.dataset.cycle);
      if (expandedCycles.has(i)) expandedCycles.delete(i); else expandedCycles.add(i);
      render();
    });

    els.objSearch.addEventListener('input', applyObjSearch);
    els.addFilterBtn.addEventListener('click', () => {
      // The phase track and the key figures have no raw series. A filter cannot use them.
      const objs = allObjects().filter(o => o.kuerzel !== 'PHASE' && o.kuerzel !== 'KENNZAHL');
      if (!objs.length) return;
      const first = objs[0];
      filterRows.push({ id: nextFilterId++, key: objKey(first), ...defaultCondFor(first.kuerzel) });
      renderFilterRows();
      windowStartIdx = 0; render();
    });

    els.configSaveBtn.addEventListener('click', saveConfig);
    els.configLoadInput.addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) loadConfigFile(file);
      e.target.value = '';
    });

    els.btnWinPrev.addEventListener('click', () => {
      if (showAll) return;
      windowStartIdx = Math.max(0, windowStartIdx - windowCount);
      render();
    });
    els.btnWinNext.addEventListener('click', () => {
      if (showAll) return;
      const maxStart = Math.max(0, lastEffectiveCount - 1);
      windowStartIdx = Math.min(maxStart, windowStartIdx + windowCount);
      render();
    });
    els.winSize.addEventListener('change', () => {
      const v = parseInt(els.winSize.value, 10);
      windowCount = Number.isFinite(v) && v > 0 ? v : 20;
      els.winSize.value = windowCount;
      render();
    });
    els.btnWinAll.addEventListener('click', () => {
      showAll = !showAll;
      els.btnWinAll.textContent = showAll ? 'Fenster anzeigen' : 'Alle anzeigen';
      els.btnWinAll.classList.toggle('primary', showAll);
      render();
    });
  }

  // Results of the formula builder (see formulaBuilder.js).
  // This is read-only access.
  // The code does NOT change the shared analysis (the same pattern as
  // the provider 'oepnvRows').
  // The result is empty as long as no formulas are calculated or no view provides them (yet).
  function formulaCols() {
    return GZ.state.request('formulaColumns') || [];
  }

  // Key figures of Umlaufstatistiken (see umlaufstatistiken.js).
  // This is read-only access, as for formulaCols() above. The pattern is the same.
  // Unlike FORMEL, key figures are NOT always TRUE or FALSE (a number or text is possible).
  // The code already precalculates them for each cycle and not for each row.
  // They have no rawSeries for each row.
  // They have valuesByCycleIdx, which is one value for each cycle index.
  function kennzahlCols() {
    return GZ.state.request('kennzahlColumns') || [];
  }

  // Display of a key figure value on the track (bar label and tooltip) and in the legend.
  // The result types are the same as in GZ.exprEngine.compileValue() (number, true or false, text).
  // NaN means "no value in this cycle" (see the cycleMetrics convention in exprEngine.js).
  function formatKennzahlValue(v) {
    if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) return '–';
    if (typeof v === 'boolean') return v ? 'Wahr' : 'Falsch';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(1);
    return String(v);
  }

  // Phase track (Stammdaten LSA and Phasenauswertung, see GZ.phases).
  // Unlike FORMEL and KENNZAHL, it is not a list.
  // By definition, phases are never active at the same time (see the header comment of phases.js).
  // It is ONE single pseudo object for the combined timeline of all phases.
  // It exists only if at least one phase is defined.
  // index stays 0 (only one entry).
  function phaseCols() {
    const phases = GZ.state.data.currentAnalysis ? GZ.state.data.phases : [];
    if (!phases || !phases.length) return [];
    return [{ kuerzel: 'PHASE', index: 0, name: 'Phasen', beschreibung: 'Kombinierte Phasenspur (Stammdaten LSA) mit inferierten Phasenübergängen' }];
  }

  // Combined phase track (see GZ.phases).
  // The basis is the same as in js/views/phasenauswertung.js.
  // There is one list for each phase that shows when the phase was fully shown (all member signal
  // groups green at the same time).
  // The code merges the lists into ONE gapless, annotated segment series
  // (GZ.phases.buildAnnotatedSegments).
  // The gaps already have pueLabel, pueFromPhaseId and pueToPhaseId there (see the header comment
  // there).
  // The code builds it once for each render() pass (as it does for sgData) and not for each row.
  // The underlying occurrences do not depend on the visible cycle window.
  // The PÜ TOOL ITSELF (editing the correction table) is now in the tab "Stammdaten LSA" (see
  // renderPueSection() there).
  // Here there is only read and display access through GZ.phases.resolvePueRows() (see
  // renderPueDetailPanel() below).
  function buildPhaseTrack(a) {
    const phases = GZ.state.data.phases;
    if (!phases || !phases.length) return null;
    const occEntries = phases.map((phase, i) => ({ ...GZ.phases.computePhaseOccurrences(phase, a.allStats), color: GZ.phases.colorForIndex(i) }));
    const phaseById = new Map(occEntries.map(e => [e.phase.id, e.phase]));
    const colorByPhaseId = new Map(occEntries.map(e => [e.phase.id, e.color]));
    const segs = GZ.phases.buildAnnotatedSegments(occEntries, a.tMin, a.tMax);
    return { segs, phaseById, colorByPhaseId };
  }

  // Opens or closes the PÜ detail panel for ONE occurrence.
  // A second click on the same transition closes it.
  // At most one panel is open at the same time.
  function togglePueDetail(cycleIdx, fromPhaseId, toPhaseId) {
    const same = openPueDetail && openPueDetail.cycleIdx === cycleIdx
      && openPueDetail.fromPhaseId === fromPhaseId && openPueDetail.toPhaseId === toPhaseId;
    openPueDetail = same ? null : { cycleIdx, fromPhaseId, toPhaseId };
    render();
  }

  function formatPueNum(v) { return v != null ? v : '–'; }

  // PÜ detail panel.
  // The code adds it to exactly ONE cycle group AFTER the regular two-step render (template and
  // SVG).
  // It is not part of the generic track system.
  // At most one panel can be open at the same time.
  // A separate, independent path is simpler here.
  // The other option is to add an "expandable" special case to the existing object-related row
  // system.
  function renderPueDetailPanel(rowData, groupEls, a, TU_MED) {
    if (!openPueDetail) return;
    const rowPos = rowData.findIndex(r => r.i === openPueDetail.cycleIdx);
    if (rowPos === -1) return; // The occurrence is not visible at this time (window or filter). The state stays.
    const { cycleIdx, fromPhaseId, toPhaseId } = openPueDetail;
    const fromPhase = GZ.state.data.phases.find(p => p.id === fromPhaseId);
    const toPhase = GZ.state.data.phases.find(p => p.id === toPhaseId);
    if (!fromPhase || !toPhase) { openPueDetail = null; return; }

    const resolved = GZ.phases.resolvePueRows(fromPhase, toPhase, cycleIdx, a, TU_MED, GZ.state.data.pueOverrides);
    const referenceSec = resolved.referenceSec != null ? resolved.referenceSec : 0;
    const cycleStart = a.cycleStarts[cycleIdx];
    const referenceAbsMs = cycleStart + referenceSec * 1000;

    const label = GZ.phases.pueLabelFor(fromPhase.kuerzel, toPhase.kuerzel);
    const fromLabel = fromPhase.name && fromPhase.name !== fromPhase.kuerzel ? `${fromPhase.kuerzel} – ${fromPhase.name}` : fromPhase.kuerzel;
    const toLabel = toPhase.name && toPhase.name !== toPhase.kuerzel ? `${toPhase.kuerzel} – ${toPhase.name}` : toPhase.kuerzel;

    const panel = document.createElement('div');
    panel.className = 'up-pue-panel';
    // TF is NO LONGER fixed here.
    // The code reads it below from the segment that is really rendered (it can be overwritten).
    // See "TF relative to the diagram, never derived from the raw data" in
    // renderTransitionBlockHtml() in stammdatenLsa.js.
    const rowsHtml = resolved.rows.map(row => {
      const sgEntry = GZ.phases.findSgEntryByColIndex(row.sgIndex, a);
      const sgName = sgEntry ? sgEntry.col.name : '?';
      // The An and Ab numbers are NO LONGER separate text next to the bar.
      // They are directly on the green bar itself (edgeLabelsFor below).
      // The pattern is the same as the main tracks in Umlaufprüfung.
      return `
        <div class="up-pue-row">
          <span class="up-pue-sg-label">${esc(sgName)}${row.always ? ' <span class="up-pue-always-tag">immer an</span>' : ''}</span>
          <span class="up-pue-tf">TF –</span>
          <div class="up-pue-track"><svg></svg></div>
        </div>`;
    }).join('');

    const startEndText = `Start ${esc(formatPueNum(resolved.startSec))}s · Ende ${esc(formatPueNum(resolved.endSec))}s`;
    // Common axis row (5 s ticks).
    // It has the same grid column layout as .up-pue-row (see the CSS).
    // So the ticks are exactly over the bars.
    const axisRowHtml = resolved.rows.length ? `
        <div class="up-pue-axis-row">
          <span></span><span></span>
          <div class="up-pue-track up-pue-axis-track"><svg></svg></div>
        </div>` : '';
    panel.innerHTML = `
      <div class="up-pue-panel-head">
        <span><b>${esc(label)}</b><span class="up-pue-panel-sub"> · ${esc(fromLabel)} → ${esc(toLabel)} · ${startEndText}${resolved.overridden ? ' · manuell angepasst' : ''}</span></span>
        <div class="up-pue-panel-actions">
          <button type="button" class="up-pue-edit">Bearbeiten in Stammdaten LSA</button>
          <button type="button" class="up-pue-close" title="Schließen">✕</button>
        </div>
      </div>
      ${resolved.rows.length ? `${axisRowHtml}<div class="up-pue-rows">${rowsHtml}</div>` : '<div class="up-pue-empty">Keine Daten für diesen Umlauf (z. B. Datenlücke).</div>'}
    `;

    groupEls[rowPos].appendChild(panel);

    // As in Stammdaten LSA, the window width is tied to the transition.
    // It is -3 s before the start and +2 s after the end.
    // It is not a general padding around the row values.
    // See the header comment at the same place there (it includes the Math.max clamp against an
    // inverted window).
    const startSec = resolved.startSec != null ? resolved.startSec : 0;
    const endSec = Math.max(resolved.endSec != null ? resolved.endSec : 0, startSec);
    // Find cm for each row once in advance. See stammdatenLsa.js.
    const cmByRow = resolved.rows.map(row => row.always ? null : GZ.phases.cmForRow(row, referenceAbsMs, a));
    // The window also covers the real green end point of each row (An + real red-amber duration, or
    // Ab + real amber duration).
    // It does not cover only the logical end.
    // See stammdatenLsa.js.
    // Include both sides independently. See stammdatenLsa.js.
    const rowMaxSec = resolved.rows.reduce((m, r, i) => {
      const cm = cmByRow[i];
      const rotgelb = cm && Number.isFinite(cm.rotgelb) ? cm.rotgelb : 0;
      const gelb = cm && Number.isFinite(cm.gelb) ? cm.gelb : 0;
      const abExtent = r.ab != null ? r.ab + gelb : -Infinity;
      const anExtent = r.an != null ? r.an + rotgelb : -Infinity;
      return Math.max(m, abExtent, anExtent);
    }, -Infinity);
    const windowEndSec = Number.isFinite(rowMaxSec) ? Math.max(endSec, rowMaxSec) : endSec;
    const localWMin = (startSec - 3) * 1000, localWMax = (windowEndSec + 2) * 1000;
    const endMarks = resolved.endSec != null ? [{ t: resolved.endSec * 1000, label: `Übergangsende (Ende), ${resolved.endSec}s` }] : [];
    const axisSvg = panel.querySelector('.up-pue-axis-track svg');
    if (axisSvg) renderTimeAxis(axisSvg, localWMin, localWMax, 5000, resolved.endSec != null ? resolved.endSec * 1000 : null);
    panel.querySelectorAll('.up-pue-row').forEach((rowEl, i) => {
      const row = resolved.rows[i];
      const svg = rowEl.querySelector('.up-pue-track svg');
      const tfEl = rowEl.querySelector('.up-pue-tf');

      if (row.always) {
        renderLane(svg, {
          wMin: localWMin, wMax: localWMax, segs: [{ cat: 'GRUEN', start: localWMin, end: localWMax }],
          baselineCat: 'ROT', baselineColor: 'var(--sig-red)', baselineHeight: 3,
          gridStepMs: 5000, laneStyle: currentLaneStyle(), endMarks
        });
        tfEl.textContent = 'TF –';
        return;
      }

      const cm = cmByRow[i];
      // The code synthesizes the bar DIRECTLY from the row values (buildRowDisplaySegs).
      // See stammdatenLsa.js for the detailed reason.
      // The bar never shows a state other than green where the phase definition requires green.
      const rowSegs = GZ.phases.buildRowDisplaySegs(row, cm, localWMin, localWMax);
      renderLane(svg, {
        wMin: localWMin, wMax: localWMax, segs: rowSegs,
        baselineCat: 'ROT', baselineColor: 'var(--sig-red)', baselineHeight: 3,
        gridStepMs: 5000, laneStyle: currentLaneStyle(), endMarks,
        // "An" marks the red-to-amber change (ROTGELB segment, if it exists).
        // Otherwise it falls back to the start of GRUEN.
        // "Ab" stays the end of the GRUEN segment (start of GELB).
        // See stammdatenLsa.js.
        edgeLabelsFor: d => {
          const nearAn = row.an != null && (d.cat === 'ROTGELB' || d.cat === 'GRUEN') && Math.abs(d.start - row.an * 1000) < 500;
          const nearAb = row.ab != null && d.cat === 'GRUEN' && Math.abs(d.end - row.ab * 1000) < 500;
          if (!nearAn && !nearAb) return null;
          return { left: nearAn ? row.an : null, right: nearAb ? row.ab : null };
        }
      });
      // TF is relative to the transition. See stammdatenLsa.js and GZ.phases.computeRowTf().
      const tf = GZ.phases.computeRowTf(row, cm, startSec, endSec);
      tfEl.textContent = 'TF ' + formatPueNum(tf);
    });

    panel.querySelector('.up-pue-close').addEventListener('click', () => { openPueDetail = null; render(); });
    panel.querySelector('.up-pue-edit').addEventListener('click', () => {
      GZ.state.command('nav:switchTab', { tab: 'sd' });
      GZ.state.command('transition:show', { fromPhaseId, toPhaseId });
    });
  }

  // Unique key for an object. The key is stable inside one session.
  // SG columns have no "kuerzel" field.
  // So, as in the earlier filter, the code tags them synthetically with 'SG'.
  // Their "index" is the position in allStats (not the raw column index).
  // For DET, APW, OEPNV and FORMEL, it is the real column index.
  // For FORMEL, it is SYNTH_INDEX_BASE+id (see berechnen() in formulaBuilder.js).
  // It stays stable over recalculations, as long as the user does not delete the formula row or
  // create it again.
  function objKey(c) { return c.kuerzel + '|' + c.index; }

  // All objects that are known at this time and that the user can select in the unified object
  // list.
  // They are signal groups, detectors, APW and ÖPNV values, and synthetic formula columns.
  // This is ONE common list and not three separate lists.
  // It replaces the earlier separate SG, DET and APW checklists.
  // The order here is only the "natural" base order (data columns first, formulas at the end).
  // objectOrder gives the real display and output order (see reconcileObjectOrder()).
  function allObjects() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return [];
    const sg = a.allStats.map(({ col }, i) => ({ kuerzel: 'SG', index: i, name: col.name, beschreibung: col.beschreibung }));
    const det = a.otherColumns.filter(c => c.kuerzel === 'DET').concat(formulaCols(), kennzahlCols());
    const apw = a.otherColumns.filter(c => c.kuerzel === 'APW' || c.kuerzel === 'OEPNV');
    return phaseCols().concat(sg, det, apw);
  }

  function isNumericKuerzel(kuerzel) { return kuerzel === 'APW' || kuerzel === 'OEPNV'; }
  // DET and FORMEL share the same occupancy logic (categorizeDetRaw), which is like TRUE or FALSE.
  // So they have the same states (BELEGT and FREI).
  function stateOptionsFor(kuerzel) {
    const want = kuerzel === 'SG' ? 'KAT_SG' : 'KAT_DET';
    return Object.keys(GZ.exprEngine.KAT_TOKENS).filter(k => GZ.exprEngine.KAT_TOKENS[k] === want);
  }
  function defaultCondFor(kuerzel) {
    return isNumericKuerzel(kuerzel) ? { op: '>', value: 0 } : { op: '==', value: stateOptionsFor(kuerzel)[0] };
  }

  // Reconciles objectOrder with the objects that are known at this time.
  // The existing order stays, also for objects that are not checked.
  // The code adds new objects at the end.
  // Examples are formulas that the code just calculated and objects that remain from a loaded
  // configuration.
  // The code removes objects that no longer exist.
  // Examples are a deleted formula and a new data import with different columns.
  // The function is idempotent. The code can call it any number of times.
  function reconcileObjectOrder(objs) {
    const known = new Set(objs.map(objKey));
    const kept = objectOrder.filter(k => known.has(k));
    const keptSet = new Set(kept);
    objs.forEach(o => {
      const k = objKey(o);
      if (keptSet.has(k)) return;
      // The phase track must be at the TOP when it appears for the first time.
      // It does not matter if this is at the first render after a data import or because the user
      // created a phase later in Stammdaten LSA.
      // The code does not add it at the end, as it does for newly calculated formulas and key
      // figures.
      // After that, the user can sort it freely by dragging, as any other object.
      if (o.kuerzel === 'PHASE') kept.unshift(k); else kept.push(k);
    });
    objectOrder = kept;
    return objectOrder;
  }

  // Builds the unified object list (#upObjList) again from objectOrder.
  // explicitSelected (a set of keys) can overwrite the selection state completely.
  // Only applyConfig() uses it, when it loads a configuration.
  // Normally the code keeps the earlier DOM state (checked checkboxes), as in the earlier
  // checklists.
  // With no history at all (first render after a data import), only the first signal group is
  // preselected.
  function renderObjList(explicitSelected) {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const objs = allObjects();
    const hasExplicit = explicitSelected instanceof Set;
    const hadRows = els.objList.querySelectorAll('.obj-row').length > 0;
    const prevChecked = hasExplicit ? explicitSelected
      : new Set([...els.objList.querySelectorAll('input:checked')].map(cb => cb.closest('.obj-row').dataset.key));
    reconcileObjectOrder(objs);
    const byKey = new Map(objs.map(o => [objKey(o), o]));
    multiSelectKeys = new Set([...multiSelectKeys].filter(k => byKey.has(k)));
    const rows = objectOrder.map(k => byKey.get(k)).filter(Boolean);

    els.objList.innerHTML = rows.length ? rows.map(c => {
      const key = objKey(c);
      const label = c.beschreibung && c.beschreibung !== c.name ? `${c.name} – ${c.beschreibung}` : c.name;
      const checked = (hasExplicit || hadRows) ? prevChecked.has(key) : (c.kuerzel === 'SG' && c.index === 0);
      const selected = multiSelectKeys.has(key);
      return `<div class="obj-row${selected ? ' obj-row-selected' : ''}" data-key="${esc(key)}">
        <span class="obj-drag" title="Ziehen zum Sortieren (mehrere: erst mit Strg-Klick auswählen)">⠿</span>
        <label class="obj-row-label">
          <input type="checkbox" ${checked ? 'checked' : ''}>
          <span class="filter-kuerzel">${esc(c.kuerzel)}</span>
          <span class="obj-row-name">${esc(label)}</span>
        </label>
      </div>`;
    }).join('') : '<div class="obj-list-empty">Keine Objekte erkannt.</div>';

    els.objList.querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = render);
    wireObjDrag();
    applyObjSearch();
  }

  // Pure visibility filter of the list by name or short name.
  // It does NOT change the selection or the order.
  // (See the user requirement: the search only helps to find an object in the list faster.)
  function applyObjSearch() {
    if (!els || !els.objSearch) return;
    const q = els.objSearch.value.trim().toLowerCase();
    els.objList.querySelectorAll('.obj-row').forEach(row => {
      const hay = row.querySelector('.obj-row-name').textContent.toLowerCase() + ' ' + row.querySelector('.filter-kuerzel').textContent.toLowerCase();
      row.classList.toggle('obj-row-hidden', !!q && !hay.includes(q));
    });
  }

  // Updates only the .obj-row-selected class from multiSelectKeys.
  // This is lightweight. The code does NOT call render().
  // The multiple selection only decides which rows the user drags together later.
  // It does not change the cycle output.
  function updateObjSelectionHighlight() {
    els.objList.querySelectorAll('.obj-row').forEach(row => {
      row.classList.toggle('obj-row-selected', multiSelectKeys.has(row.dataset.key));
    });
  }

  // Drag to sort with native HTML5 drag and drop.
  // Only the handle (.obj-drag) can start it.
  // By default, the row itself is NOT draggable.
  // Otherwise a click on the checkbox or the name can start a drag by mistake.
  // It must toggle the checkbox or select text.
  // Only a mousedown on the handle makes this one row draggable. dragend turns it off again.
  // During the drag, the code moves the dragged (anchor) row LIVE to the target position.
  // This is a simple, robust pattern with no additional library.
  // At the drop, the code takes the order that is now visible in the DOM into objectOrder.
  // Then it renders the cycle output again.
  //
  // Multiple selection (Ctrl+click, see multiSelectKeys):
  // If the dragged row is part of a multiple selection with more than one element, the code only
  // darkens the OTHER selected rows during the drag (.dragging-group).
  // It does not move them live.
  // A full multi-element drag is not necessary.
  // At the drop (dragend), the code inserts ALL selected keys together at the position of the
  // anchor row.
  // They keep their earlier relative order (see objectOrder.filter()).
  // If the user drags a row that is NOT part of the current multiple selection, it replaces the
  // selection (it drags alone).
  // This is the same as in usual file manager lists.
  //
  // The row handlers and the list handlers are separate.
  // The code creates the rows again at each renderObjList().
  // So the code must wire mousedown and click again each time.
  // The list container itself stays.
  // The code wires drag, dragover and dragend only ONCE, with event delegation through
  // e.target.closest().
  let dragAnchorKey = null;
  function wireObjDrag() {
    els.objList.querySelectorAll('.obj-drag').forEach(handle => {
      handle.onmousedown = () => { const row = handle.closest('.obj-row'); if (row) row.draggable = true; };
    });
    els.objList.querySelectorAll('.obj-row').forEach(row => {
      row.onclick = e => {
        if (!(e.ctrlKey || e.metaKey)) { if (multiSelectKeys.size) { multiSelectKeys.clear(); updateObjSelectionHighlight(); } return; }
        if (e.target.closest('.obj-drag')) return; // The handle has its own meaning (it starts the drag)
        e.preventDefault(); // prevents the click from also toggling the checkbox
        const key = row.dataset.key;
        if (multiSelectKeys.has(key)) multiSelectKeys.delete(key); else multiSelectKeys.add(key);
        updateObjSelectionHighlight();
      };
    });
    if (els.objList.__dragWired) return;
    els.objList.__dragWired = true;
    els.objList.addEventListener('dragstart', e => {
      const row = e.target.closest('.obj-row');
      if (!row || !row.draggable) { e.preventDefault(); return; }
      dragAnchorKey = row.dataset.key;
      if (!multiSelectKeys.has(dragAnchorKey)) { multiSelectKeys = new Set([dragAnchorKey]); updateObjSelectionHighlight(); }
      row.classList.add('dragging');
      if (multiSelectKeys.size > 1) {
        els.objList.querySelectorAll('.obj-row').forEach(r => {
          if (r !== row && multiSelectKeys.has(r.dataset.key)) r.classList.add('dragging-group');
        });
      }
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragAnchorKey); } catch (err) { /* Firefox needs data. Chrome accepts a drag with no data. */ }
    });
    els.objList.addEventListener('dragover', e => {
      const draggingRow = els.objList.querySelector('.obj-row.dragging');
      if (!draggingRow) return;
      e.preventDefault();
      const overRow = e.target.closest('.obj-row');
      if (!overRow || overRow === draggingRow) return;
      const rect = overRow.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      overRow.parentNode.insertBefore(draggingRow, before ? overRow : overRow.nextSibling);
    });
    els.objList.addEventListener('dragend', () => {
      // During dragover, the code moved only the anchor row live in the DOM (see the header
      // comment).
      // The other group members are still at their OLD position there.
      // So the code does NOT take the order directly from the DOM (as it does for a single drag).
      // It calculates the order.
      // It removes all group keys from the DOM order.
      // Then it inserts them together again at the anchor position.
      // The anchor position is converted to the remaining rows.
      // After that, the code builds #upObjList completely again from the new objectOrder
      // (renderObjList()).
      // So the DOM and objectOrder match again.
      // This must happen BEFORE render() reads the checkbox order from the DOM.
      const domOrder = [...els.objList.querySelectorAll('.obj-row')].map(r => r.dataset.key);
      const groupKeys = multiSelectKeys.size > 1 && multiSelectKeys.has(dragAnchorKey)
        ? objectOrder.filter(k => multiSelectKeys.has(k)) // keep the earlier relative order of the keys
        : [dragAnchorKey];
      const anchorDomIdx = domOrder.indexOf(dragAnchorKey);
      let insertAt = 0;
      for (let i = 0; i < anchorDomIdx; i++) { if (!groupKeys.includes(domOrder[i])) insertAt++; }
      const rest = domOrder.filter(k => !groupKeys.includes(k));
      rest.splice(insertAt, 0, ...groupKeys);
      objectOrder = rest;
      dragAnchorKey = null;
      renderObjList();
      render();
    });
  }

  // Builds the filter condition rows (#upFilterRows) again.
  // This is separate from the object list above.
  // Each row has its own object selection with a <select>.
  // The sort order and the search of the list do not affect it.
  // Each row has a condition that depends on the type.
  // It is state equality (SG, DET, FORMEL) or an operator and a number (APW, ÖPNV).
  // See filterCondHtml() and computeMatchingCycles().
  function renderFilterRows() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const objs = allObjects();
    const objsByKey = new Map(objs.map(o => [objKey(o), o]));
    // Remove orphan rows silently (the object does not exist anymore, for example after a deleted
    // formula or a new data import).
    // Do not show them in a broken state.
    filterRows = filterRows.filter(fr => objsByKey.has(fr.key));

    const groups = [
      { label: 'Signalgruppen', items: objs.filter(o => o.kuerzel === 'SG') },
      { label: 'Detektoren', items: objs.filter(o => o.kuerzel === 'DET') },
      { label: 'Formeln', items: objs.filter(o => o.kuerzel === 'FORMEL') },
      { label: 'APW/ÖPNV-Werte', items: objs.filter(o => isNumericKuerzel(o.kuerzel)) }
    ].filter(g => g.items.length);

    els.filterRowsEl.innerHTML = filterRows.length ? filterRows.map(fr => {
      const c = objsByKey.get(fr.key);
      const objOptions = groups.map(g => `<optgroup label="${esc(g.label)}">${g.items.map(o =>
        `<option value="${esc(objKey(o))}" ${objKey(o) === fr.key ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</optgroup>`).join('');
      return `<div class="up-filter-row" data-id="${fr.id}">
        <select class="up-filter-obj">${objOptions}</select>
        <span class="up-filter-cond">${filterCondHtml(c.kuerzel, fr)}</span>
        <button type="button" class="oe-row-remove up-filter-remove">✕</button>
      </div>`;
    }).join('') : '<div class="cfg-empty">Keine Filterbedingungen – alle Umläufe werden angezeigt.</div>';

    els.filterRowsEl.querySelectorAll('.up-filter-row').forEach(rowEl => {
      const id = Number(rowEl.dataset.id);
      const fr = filterRows.find(x => x.id === id);
      if (!fr) return;
      rowEl.querySelector('.up-filter-obj').onchange = e => {
        const newC = objsByKey.get(e.target.value);
        fr.key = e.target.value;
        // The condition type can change when the object changes (state or number).
        // Reset the operator and the value to a default that is useful for the NEW type.
        // Do not keep an old value that has no meaning now.
        Object.assign(fr, defaultCondFor(newC.kuerzel));
        renderFilterRows();
        windowStartIdx = 0; render();
      };
      const opSel = rowEl.querySelector('.up-filter-op');
      if (opSel) opSel.onchange = e => { fr.op = e.target.value; windowStartIdx = 0; render(); };
      const valNum = rowEl.querySelector('.up-filter-val');
      if (valNum) valNum.onchange = e => { fr.value = Number(e.target.value); windowStartIdx = 0; render(); };
      const valState = rowEl.querySelector('.up-filter-val-state');
      if (valState) valState.onchange = e => { fr.value = e.target.value; windowStartIdx = 0; render(); };
      rowEl.querySelector('.up-filter-remove').onclick = () => {
        filterRows = filterRows.filter(x => x.id !== id);
        renderFilterRows();
        windowStartIdx = 0; render();
      };
    });
  }

  function filterCondHtml(kuerzel, fr) {
    if (isNumericKuerzel(kuerzel)) {
      const ops = ['=', '!=', '>', '>=', '<', '<='];
      return `<select class="up-filter-op">${ops.map(o => `<option value="${esc(o)}" ${o === fr.op ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>
        <input type="number" class="up-filter-val" value="${esc(String(fr.value ?? 0))}" step="any">`;
    }
    const opts = stateOptionsFor(kuerzel);
    return `<span class="filter-kuerzel">Zustand =</span>
      <select class="up-filter-val-state">${opts.map(o => `<option value="${esc(o)}" ${o === fr.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }

  // Called after "Berechnen" in the formula builder OR after a change to the key figures of
  // Umlaufstatistiken.
  // It builds the object list and the filter rows again and renders again.
  // The synthetic columns that they contain or reference can be new or changed.
  // It does NOT reset the window position or the measurements on purpose.
  // (populateControls() does reset them at a completely new data import.)
  function refreshSyntheticColumns() {
    if (!els) return;
    renderObjList();
    renderFilterRows();
    render();
  }

  /* ---------------- Konfiguration speichern/laden (JSON) ----------------
     The configuration has column references (short name and name, not the raw index, see
     GZ.configIO) and not raw data.
     So a saved configuration stays usable for new exports of the same intersection.
     This is also true if the column indices or the number of rows change.
     It does NOT include the CSV itself (up to 100k rows). */
  // objects: ONE array (not three separate lists) in objectOrder order.
  // Each entry has "selected" (checked or not).
  // So it covers both the selection and the order.
  // filters: one row for each filter condition (object, operator and value).
  function getConfig() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return null;
    const objs = allObjects();
    const objsByKey = new Map(objs.map(o => [objKey(o), o]));
    const checkedKeys = new Set([...els.objList.querySelectorAll('input:checked')].map(cb => cb.closest('.obj-row').dataset.key));
    const objectsCfg = objectOrder.map(k => objsByKey.get(k)).filter(Boolean).map(c => ({
      kuerzel: c.kuerzel, name: c.name, selected: checkedKeys.has(objKey(c))
    }));
    const filtersCfg = filterRows.map(fr => {
      const c = objsByKey.get(fr.key);
      return c ? { kuerzel: c.kuerzel, name: c.name, op: fr.op, value: fr.value } : null;
    }).filter(Boolean);
    return {
      objects: objectsCfg,
      filters: filtersCfg,
      fzEnabled: !!(els.fzToggle && els.fzToggle.checked),
      laneStyle: currentLaneStyle(),
      windowSize: windowCount
    };
  }

  // The order is important.
  // loadConfigFile() calls this only AFTER GZ.views.formulaBuilder.applyConfig().
  // So saved FORMEL selections find the columns that already exist and that the code calculated
  // again.
  // The code resolves column references as before with short name and name.
  // It does not use the raw index, which can change between recordings.
  // Objects in the saved configuration that do not (or no longer) exist in the current data set go
  // to "skipped".
  // The current data set can have objects that the saved configuration does not know (for example a
  // formula that the code calculated since then).
  // renderObjList() and reconcileObjectOrder() add them automatically at the end.
  function applyConfig(cfg) {
    if (!cfg) return { skipped: [] };
    const a = GZ.state.data.currentAnalysis;
    if (!a) return { skipped: ['Keine Daten geladen'] };
    const skipped = [];
    const objs = allObjects();
    const byNameKey = new Map(objs.map(o => [o.kuerzel + '|' + o.name, o]));

    const orderedKeys = [];
    const selectedKeys = new Set();
    (cfg.objects || []).forEach(ref => {
      const c = byNameKey.get(ref.kuerzel + '|' + ref.name);
      if (!c) { skipped.push(`Objekt „${ref.name}“`); return; }
      orderedKeys.push(objKey(c));
      if (ref.selected) selectedKeys.add(objKey(c));
    });
    objectOrder = orderedKeys;

    filterRows = (cfg.filters || []).map(f => {
      const c = byNameKey.get(f.kuerzel + '|' + f.name);
      if (!c) { skipped.push(`Filter „${f.name}“`); return null; }
      return { id: nextFilterId++, key: objKey(c), op: f.op, value: f.value };
    }).filter(Boolean);

    if (els.fzToggle) els.fzToggle.checked = !!cfg.fzEnabled;
    if (els.laneStyle && cfg.laneStyle) els.laneStyle.value = cfg.laneStyle;
    if (cfg.windowSize) { windowCount = cfg.windowSize; els.winSize.value = windowCount; }
    windowStartIdx = 0;

    renderObjList(selectedKeys);
    renderFilterRows();
    render();
    return { skipped };
  }

  function saveConfig() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const cfg = {
      version: 1,
      fingerprint: GZ.configIO.buildFingerprint(a),
      umlaufpruefung: getConfig(),
      formulaBuilder: GZ.state.request('formulaConfig:get') || null
    };
    GZ.configIO.downloadJson('umlaufpruefung_konfiguration.json', cfg);
  }

  async function loadConfigFile(file) {
    const a = GZ.state.data.currentAnalysis;
    if (!a) {
      els.hint.textContent = 'Bitte zuerst Daten laden/analysieren.'; els.hint.className = 'hint warn';
      if (GZ.snackbar) GZ.snackbar.show('Konfiguration kann nicht geladen werden', { type: 'warning', description: 'Bitte zuerst Daten laden/analysieren.' });
      return;
    }
    let cfg;
    try { cfg = await GZ.configIO.readJsonFile(file); }
    catch (e) {
      els.hint.textContent = e.message; els.hint.className = 'hint warn';
      if (GZ.snackbar) GZ.snackbar.show('Konfiguration konnte nicht gelesen werden', { type: 'error', description: e.message });
      return;
    }

    const match = GZ.configIO.fingerprintMatches(cfg.fingerprint, a);
    const notes = [];
    if (!match.exact) {
      notes.push(match.columnsMatch
        ? 'Spaltenstruktur passt, aber andere Aufzeichnung (Zeitraum/Zeilenzahl weichen ab) – Zuordnung erfolgte über Spaltennamen.'
        : 'Spaltenstruktur weicht von der gespeicherten Konfiguration ab – ggf. nicht alle Einstellungen übernommen.');
    }

    // Apply and calculate the formulas FIRST.
    // So applyConfig() below can find the saved FORMEL selections in the detector list and filter
    // list that the code already updated.
    const applied = GZ.state.request('formulaConfig:apply', cfg.formulaBuilder);
    const formulaSkipped = applied ? applied.skipped : [];
    const upSkipped = applyConfig(cfg.umlaufpruefung).skipped;

    const allSkipped = formulaSkipped.concat(upSkipped);
    els.hint.textContent = ['Konfiguration geladen.', ...notes, allSkipped.length ? `Nicht gefunden: ${allSkipped.join(', ')}.` : '']
      .filter(Boolean).join(' ');
    els.hint.className = 'hint' + ((notes.length || allSkipped.length) ? ' warn' : '');
    if ((notes.length || allSkipped.length) && GZ.snackbar) {
      GZ.snackbar.show('Konfiguration teilweise geladen', {
        type: 'warning',
        description: [...notes, allSkipped.length ? `Nicht gefunden: ${allSkipped.join(', ')}.` : ''].filter(Boolean).join(' ')
      });
    }
  }

  function populateControls() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    measurements = new Map();
    // Complete restart of the object order, the selection and the filters at a new data import.
    // reconcileObjectOrder() would discard keys that do not exist anymore.
    // But an explicit reset is clearer than a dependence on this behavior.
    objectOrder = [];
    filterRows = [];

    renderObjList();
    renderFilterRows();

    windowStartIdx = 0;
    showAll = false;
    expandedCycles = new Set();
    expandedLogs = new Set();
    pendingJump = null;
    els.logFilter.checked = false;
    els.btnWinAll.textContent = 'Alle anzeigen';
    els.btnWinAll.classList.remove('primary');

    wireEvents();
    render();
  }

  function wireEvents() {
    els.fzToggle.onchange = render;
    if (els.laneStyle) els.laneStyle.onchange = render;
  }

  function windowRange(n) {
    if (showAll || n <= 0) return { from: 0, to: n };
    const from = Math.max(0, Math.min(windowStartIdx, Math.max(0, n - 1)));
    return { from, to: Math.min(from + windowCount, n) };
  }

  /* ---------------- Manuelle Zeitmessung (Strg+Klick) ---------------- */
  // 3-click cycle for each track: empty -> first mark -> second mark (the view shows the
  // difference) -> the next Ctrl+click discards both and starts again at the clicked position.
  // The code rounds the times to the full second.
  function measureClickHandler(svgEl, wMin, wMax, key) {
    return function (event) {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      event.stopPropagation();
      const width = svgEl.clientWidth;
      if (!width) return;
      const rect = svgEl.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const x = d3.scaleLinear().domain([wMin, wMax]).range([0, width]);
      let t = Math.round(x.invert(px) / 1000) * 1000;
      t = Math.max(wMin, Math.min(wMax, t));

      const cur = measurements.get(key);
      let next;
      if (!cur || cur.a == null) next = { a: t, b: null };
      else if (cur.b == null) next = { a: cur.a, b: t };
      else next = { a: t, b: null };
      measurements.set(key, next);
      drawMeasureOverlay(svgEl, wMin, wMax, next);
    };
  }

  function drawMeasureOverlay(svgEl, wMin, wMax, mark) {
    const width = svgEl.clientWidth, height = svgEl.clientHeight;
    if (!width || !height) return;
    const x = d3.scaleLinear().domain([wMin, wMax]).range([0, width]);
    let g = d3.select(svgEl).select('g.measure-layer');
    if (g.empty()) g = d3.select(svgEl).append('g').attr('class', 'measure-layer').style('pointer-events', 'none');
    g.selectAll('*').remove();
    if (!mark || mark.a == null) return;

    const capTop = height * 0.12, capBot = height * 0.88;
    const drawCap = (t) => {
      const px = x(t);
      g.append('line').attr('class', 'measure-cap-halo').attr('x1', px).attr('x2', px).attr('y1', capTop).attr('y2', capBot);
      g.append('line').attr('class', 'measure-cap').attr('x1', px).attr('x2', px).attr('y1', capTop).attr('y2', capBot);
    };
    drawCap(mark.a);
    if (mark.b == null) return;
    drawCap(mark.b);

    const t0 = Math.min(mark.a, mark.b), t1 = Math.max(mark.a, mark.b);
    const xa = x(t0), xb = x(t1);
    [['measure-line-halo'], ['measure-line']].forEach(([cls]) => {
      g.append('line').attr('class', cls).attr('x1', xa).attr('x2', xb).attr('y1', height / 2).attr('y2', height / 2);
    });
    const secs = Math.round((t1 - t0) / 1000);
    g.append('text').attr('class', 'measure-label')
      .attr('x', (xa + xb) / 2).attr('y', height / 2).attr('dy', '-4')
      .text(`${secs}s`)
      .append('title').text(`${fmtTimeShort(t0)}–${fmtTimeShort(t1)} (${secs}s)`);
  }

  // After each renderLane() call: wire the click handler again and draw the saved measurement of
  // this track again (if it exists).
  // renderLane() clears the SVG at each call.
  // So the overlay must happen after it and not before it.
  function wireMeasure(svgEl, wMin, wMax, key) {
    if (svgEl.__measureClickHandler) svgEl.removeEventListener('click', svgEl.__measureClickHandler, true);
    const handler = measureClickHandler(svgEl, wMin, wMax, key);
    svgEl.__measureClickHandler = handler;
    svgEl.addEventListener('click', handler, true);
    drawMeasureOverlay(svgEl, wMin, wMax, measurements.get(key));
  }

  /* ---------------- Sekunden-Fadenkreuz (Hover, alle Spuren eines Umlaufs) --------------
     This runs for each cycle group and not for each track.
     It shows a vertical line in ALL track SVGs of this group.
     The line is at the same x position.
     The x position is rounded to the full second and NOT interpolated.
     A label below shows the time since the cycle start (TX in seconds).
     This is purely visual and temporary.
     It needs no persistent state over render passes (unlike the Ctrl+click measurement above). */
  function wireCrosshair(groupEl, wMin, wMax) {
    if (groupEl.__crosshairMove) groupEl.removeEventListener('mousemove', groupEl.__crosshairMove);
    if (groupEl.__crosshairLeave) groupEl.removeEventListener('mouseleave', groupEl.__crosshairLeave);

    let label = groupEl.querySelector('.up-crosshair-label');
    if (!label) {
      label = document.createElement('div');
      label.className = 'up-crosshair-label';
      groupEl.appendChild(label);
    }

    const clear = () => {
      groupEl.querySelectorAll('.lane-track svg g.crosshair-layer').forEach(g => g.remove());
      label.style.display = 'none';
    };

    const onMove = (event) => {
      const trackEl = event.target.closest && event.target.closest('.lane-track');
      if (!trackEl || !groupEl.contains(trackEl)) { clear(); return; }
      const rect = trackEl.getBoundingClientRect();
      if (!rect.width) { clear(); return; }
      const px = event.clientX - rect.left;
      if (px < 0 || px > rect.width) { clear(); return; }
      const xTrack = d3.scaleLinear().domain([wMin, wMax]).range([0, rect.width]);
      let t = Math.round(xTrack.invert(px) / 1000) * 1000;
      t = Math.max(wMin, Math.min(wMax, t));

      groupEl.querySelectorAll('.lane-track svg').forEach(svg => {
        const w = svg.clientWidth, h = svg.clientHeight;
        if (!w || !h) return;
        const x = d3.scaleLinear().domain([wMin, wMax]).range([0, w]);
        const lx = x(t);
        let g = d3.select(svg).select('g.crosshair-layer');
        if (g.empty()) g = d3.select(svg).append('g').attr('class', 'crosshair-layer').style('pointer-events', 'none');
        g.selectAll('*').remove();
        g.append('line').attr('class', 'crosshair-line-halo').attr('x1', lx).attr('x2', lx).attr('y1', 0).attr('y2', h);
        g.append('line').attr('class', 'crosshair-line').attr('x1', lx).attr('x2', lx).attr('y1', 0).attr('y2', h);
      });

      const groupRect = groupEl.getBoundingClientRect();
      label.textContent = String(Math.round((t - wMin) / 1000));
      label.style.left = `${rect.left - groupRect.left + xTrack(t)}px`;
      label.style.display = 'block';
    };

    groupEl.addEventListener('mousemove', onMove);
    groupEl.addEventListener('mouseleave', clear);
    groupEl.__crosshairMove = onMove;
    groupEl.__crosshairLeave = clear;
  }

  /* ---------------- ÖV-Fahrzeiten je Signalgruppe ---------------- */
  // Takes the rows that the user configured in the tab "ÖPNV" for the given signal group.
  // It calculates the Anmeldung and Abmeldung events once over the whole recording (as for the
  // detector segments), for the sweep of each cycle window.
  // See computeOepnvEvents (GZ.oepnvLogic) for the logic.
  function buildFzRowsForSg(sgIdx, times, seriesByCol, splValues) {
    const oepnvRows = GZ.state.request('oepnvRows', sgIdx) || [];
    return oepnvRows.map(orow => {
      const anOccupied = times.map((_, i) => orow.anDetCols.some(c => wzIstBelegt(seriesByCol.get(c.index)[i])));
      const abOccupied = times.map((_, i) => orow.abDetCols.some(c => wzIstBelegt(seriesByCol.get(c.index)[i])));
      const { events, unresolved } = computeOepnvEvents(times, anOccupied, abOccupied, splValues, [], orow.sollfahrzeitSek, orow.zwangsloeschSek);

      const fzSegs = [];
      const zwlSegs = [];
      const addPair = (anTime, endTime) => {
        const sollEnd = anTime + orow.sollfahrzeitSek * 1000;
        fzSegs.push({ start: anTime, end: Math.min(sollEnd, endTime), cat: 'FZ_SOLL', sollfahrzeitSek: orow.sollfahrzeitSek });
        if (endTime > sollEnd) {
          fzSegs.push({ start: sollEnd, end: endTime, cat: 'FZ_VERLUST', verlustSek: (endTime - sollEnd) / 1000 });
        }
        zwlSegs.push({ start: anTime, end: anTime + orow.zwangsloeschSek * 1000, cat: 'ZWL_WINDOW', zwangsloeschSek: orow.zwangsloeschSek });
      };
      events.forEach(e => addPair(e.anTime, e.endTime));
      if (unresolved) addPair(unresolved.startTime, unresolved.startTime + orow.sollfahrzeitSek * 1000);

      return {
        label: orow.anDetCols.map(c => c.name).join('+'),
        fzSweep: makeIntervalSweep(fzSegs), zwlSweep: makeIntervalSweep(zwlSegs)
      };
    });
  }

  // Filter: returns the indices of all cycles that meet EACH filter condition (AND, see filterRows
  // and renderFilterRows()).
  // There are two check types, by object type:
  // - State (SG, DET, FORMEL):
  //   Filter the segments by the selected category.
  //   Then check for existence: "was the object in this state at any time in the cycle?" (with
  //   makeIntervalSweep).
  //   For SG, it is enough to filter the existing allStats[i].segs (ALL states, not only the
  //   precalculated green phases).
  //   For DET and FORMEL, the code builds the segments again, as before, with categorizeDetRaw.
  // - Number (APW, ÖPNV):
  //   A linear raw value scan over the rows of the cycle against the selected comparison operator.
  //   Gaps and non-numeric raw values never meet a condition.
  //   (Number('') is NaN, and each comparison with NaN gives false.)
  // The code does one full scan over the recording (as for the detector and APW sweeps above).
  // It does not scan again for each cycle.
  function computeMatchingCycles(conditions, objsByKey, allStats, cycleStarts, tMax, times, seriesByCol) {
    const n = cycleStarts.length;
    const numCmp = { '=': (a, b) => a === b, '!=': (a, b) => a !== b, '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b };
    const stateSweeps = [];
    const numChecks = [];
    conditions.forEach(fr => {
      const c = objsByKey.get(fr.key);
      if (!c) return;
      if (isNumericKuerzel(c.kuerzel)) {
        numChecks.push({ index: c.index, op: fr.op, value: Number(fr.value) });
      } else {
        const segs = c.kuerzel === 'SG'
          ? allStats[c.index].segs.filter(s => s.cat === fr.value)
          : buildSegments(times, seriesByCol.get(c.index), categorizeDetRaw).filter(s => s.cat === fr.value);
        stateSweeps.push(makeIntervalSweep(segs));
      }
    });

    const matches = [];
    let ptr = 0;
    for (let i = 0; i < n; i++) {
      const start = cycleStarts[i];
      const end = i + 1 < n ? cycleStarts[i + 1] : tMax;
      while (ptr < times.length && times[ptr] < start) ptr++;
      const rowFrom = ptr;
      while (ptr < times.length && times[ptr] < end) ptr++;
      const rowTo = ptr;
      const stateOk = stateSweeps.every(sweep => sweep(start, end).length > 0);
      const numOk = numChecks.every(({ index, op, value }) => {
        const vals = seriesByCol.get(index);
        const cmp = numCmp[op];
        for (let k = rowFrom; k < rowTo; k++) {
          const num = Number((vals[k] || '').trim());
          if (!Number.isNaN(num) && cmp(num, value)) return true;
        }
        return false;
      });
      if (stateOk && numOk) matches.push(i);
    }
    return matches;
  }

  // Track style of the SIGNAL GROUP main rows (purely visual, see laneStyle of renderLane in
  // timelineLane.js).
  // "minimal" looks like a printed signal time plan. It is the default.
  // It applies ONLY to the signal group rows on purpose.
  // The detector, APW and formula tracks and the ÖV travel time side tracks keep their usual
  // display.
  // They are not part of a signal time plan.
  function currentLaneStyle() {
    return (els && els.laneStyle && els.laneStyle.value === 'default') ? 'default' : 'minimal';
  }

  // Seconds in the dark state ("Dunkel") of a segment list inside [start, end).
  function darkSeconds(segs, start, end) {
    let lo = 0, hi = segs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (segs[mid].end <= start) lo = mid + 1; else hi = mid; }
    let sum = 0;
    for (let i = lo; i < segs.length && segs[i].start < end; i++) {
      if (segs[i].cat === 'DUNKEL') sum += Math.min(segs[i].end, end) - Math.max(segs[i].start, start);
    }
    return sum / 1000;
  }
  // Index of the last cycle that starts at or before t (-1 if there is none).
  function cycleIndexAt(cycleStarts, t) {
    let lo = 0, hi = cycleStarts.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (cycleStarts[mid] <= t) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    return found;
  }

  function render() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const { allStats, cycleStarts, tMax, times, splValues, seriesByCol: seriesByColReal, otherColumns: otherColumnsReal } = a;

    // Do NOT change the shared analysis with synthetic formula columns.
    // Mix them in locally here.
    // If the formulaCols() list is empty, seriesByCol stays the same Map reference. There is no
    // unnecessary copy.
    const fCols = formulaCols();
    const otherColumns = fCols.length ? otherColumnsReal.concat(fCols) : otherColumnsReal;
    const seriesByCol = fCols.length ? new Map(seriesByColReal) : seriesByColReal;
    fCols.forEach(c => seriesByCol.set(c.index, c.rawSeries));

    if (!cycleStarts || cycleStarts.length < 2) {
      els.tablePanel.style.display = 'none';
      els.diagramControls.style.display = 'none';
      els.hint.textContent = 'Zu wenige erkannte Umläufe (TX=0-Wechsel) für diese Auswertung.';
      return;
    }

    // ONE common, ordered list of checked objects (SG AND DET, APW, OEPNV and FORMEL mixed).
    // It replaces three separate checklists.
    // The order comes directly from the DOM order of the checked checkboxes in #upObjList.
    // The user can sort them by dragging the handle (see wireObjDrag()).
    // sgRefs and traceRefs are pure .filter() subsets of it.
    // So they keep the same relative order.
    // This drives the nested row order further below.
    const objsNow = allObjects();
    const objsByKey = new Map(objsNow.map(o => [objKey(o), o]));
    const objRefs = [...els.objList.querySelectorAll('input:checked')]
      .map(cb => objsByKey.get(cb.closest('.obj-row').dataset.key))
      .filter(Boolean);
    const sgRefs = objRefs.filter(r => r.kuerzel === 'SG');
    const traceRefs = objRefs.filter(r => r.kuerzel !== 'SG');

    // Formula highlights (see getFormulaHighlights() in formulaBuilder.js).
    // For each target column, they are the TRUE intervals of all formulas that point to it.
    // The assignment is BY SHORT NAME AND NAME and not by raw index.
    // formulaBuilder.js uses the raw CSV column index for signal groups.
    // Here objKey() counts signal groups by their position in the allStats array.
    // The two counts are the same only by chance (see the comment there).
    const highlightsByObjKey = new Map();
    const formulaHighlights = GZ.state.request('formulaHighlights') || [];
    if (formulaHighlights.length) {
      const targetKeyByName = new Map(objsNow.map(o => [o.kuerzel + '|' + o.name, objKey(o)]));
      formulaHighlights.forEach(h => {
        const targetKey = targetKeyByName.get(h.colKuerzel + '|' + h.colName);
        if (!targetKey) return;
        const entries = h.intervals.map(iv => ({ start: iv.start, end: iv.end, color: h.color, name: h.name }));
        if (!highlightsByObjKey.has(targetKey)) highlightsByObjKey.set(targetKey, []);
        highlightsByObjKey.get(targetKey).push(...entries);
      });
    }

    if (sgRefs.length === 0) {
      els.tablePanel.style.display = 'none';
      els.diagramControls.style.display = 'none';
      els.hint.textContent = 'Bitte mindestens eine Signalgruppe auswählen.';
      return;
    }

    const TU = computeGlobalTU(cycleStarts);
    const irregularLimitSec = TU ? TU * GZ.greenTime.IRREGULAR_CYCLE_FACTOR : Infinity;
    const cropSec = TU ? TU * CROP_FACTOR : Infinity;
    const anomalyCtx = GZ.state.anomalyCtx();
    const fzEnabled = !!(els.fzToggle && els.fzToggle.checked);
    const laneStyle = currentLaneStyle();
    // Container class for the label color that depends on the style (see .lane-minimal in
    // charts.css).
    // The segments themselves get their classes directly from renderLane().
    if (els.rows) els.rows.classList.toggle('lane-minimal', laneStyle === 'minimal');

    const sgData = sgRefs.map(r => {
      const sgIdx = r.index;
      const sgEntry = allStats[sgIdx];
      if (!sgEntry) return null;
      const { segs, stats } = sgEntry;
      return {
        sgIdx, sgEntry, segs, stats,
        flags: getFlaggedAnomalies(stats, anomalyCtx),
        greenSweep: makeIndexSweep(stats.greens),
        segSweep: makeIntervalSweep(segs),
        fzRows: fzEnabled ? buildFzRowsForSg(sgIdx, times, seriesByCol, splValues) : []
      };
    }).filter(Boolean);

    const missingFz = fzEnabled ? sgData.filter(sd => sd.fzRows.length === 0).map(sd => sd.sgEntry.col.name) : [];
    els.hint.textContent = missingFz.length
      ? `Keine ÖPNV-Konfiguration für: ${missingFz.join(', ')} – bitte im Tab „ÖPNV“ anlegen.`
      : '';

    const phaseTrack = buildPhaseTrack(a);

    // Non-SG tracks (DET, FORMEL, APW, OEPNV, PHASE).
    // The code handles them in the same way, except for the segmentation function.
    // (kind also decides the display when the SVG renders further below.)
    // So the user can nest them freely with the signal groups.
    const traceMeta = new Map();
    traceRefs.forEach(r => {
      if (r.kuerzel === 'KENNZAHL') {
        traceMeta.set(objKey(r), {
          col: r, kind: 'kennzahl', valuesByCycleIdx: r.valuesByCycleIdx || [],
          spansByCycleIdx: r.spansByCycleIdx || null, valueKind: r.valueKind
        });
        return;
      }
      if (r.kuerzel === 'PHASE') {
        // phaseTrack can be null if the phase list is empty.
        // The object entry can still be checked in objectOrder.
        // An example: the user just deleted the last phase in Stammdaten LSA.
        // In this case, use an empty track and do not crash.
        traceMeta.set(objKey(r), { col: r, kind: 'phase', sweep: makeIntervalSweep(phaseTrack ? phaseTrack.segs : []), phaseById: phaseTrack ? phaseTrack.phaseById : new Map(), colorByPhaseId: phaseTrack ? phaseTrack.colorByPhaseId : new Map() });
        return;
      }
      const kind = isNumericKuerzel(r.kuerzel) ? 'apw' : (r.kuerzel === 'FORMEL' ? 'formula' : 'det');
      const catFn = kind === 'apw' ? (v => v.trim()) : categorizeDetRaw;
      const segs = buildSegments(times, seriesByCol.get(r.index), catFn);
      if (kind === 'apw') segs.forEach((s, idx) => { s.idx = idx; });
      traceMeta.set(objKey(r), { col: r, kind, sweep: makeIntervalSweep(segs) });
    });

    const n = cycleStarts.length;
    let matchingCycles = filterRows.length ? computeMatchingCycles(filterRows, objsByKey, allStats, cycleStarts, tMax, times, seriesByCol) : null;

    // Log filter: only cycles that contain at least one log entry (the log bar filters and the
    // level that the user chose here apply).
    // The controls are disabled while no log is loaded.
    const hasLog = GZ.logs.hasEntries();
    els.logFilter.disabled = !hasLog;
    els.logFilterLevel.disabled = !hasLog;
    els.logFilterHint.style.display = hasLog ? 'none' : '';
    if (hasLog && els.logFilter.checked) {
      const minRank = Number(els.logFilterLevel.value);
      const withLog = new Set();
      GZ.logs.visible(a.tMin, a.tMax).forEach(e => {
        if (GZ.logs.RANK[e.severity] < minRank) return;
        const ci = cycleIndexAt(cycleStarts, e.t);
        if (ci >= 0) withLog.add(ci);
      });
      const base = matchingCycles || Array.from({ length: n }, (_, i) => i);
      matchingCycles = base.filter(i => withLog.has(i));
    }
    // A jump (for example from the log list) shows the cycle that contains the time.
    // It does not change the selection, the filter or "Alle anzeigen".
    // With a window, the window moves to the cycle.
    // A cycle that the filter hides is shown anyway ("pinned").
    let jump = null;
    if (pendingJump) {
      const ci = Math.max(0, cycleIndexAt(cycleStarts, pendingJump.t));
      const pos = matchingCycles ? matchingCycles.indexOf(ci) : ci;
      const hidden = pos < 0;
      if (!showAll) {
        const at = hidden ? matchingCycles.findIndex(c => c > ci) : pos;
        windowStartIdx = Math.max(0, (at < 0 ? matchingCycles.length : at) - Math.floor(windowCount / 2));
      }
      jump = { cycle: ci, t: pendingJump.t, entry: pendingJump.entry, hidden };
      pendingJump = null;
    }
    const effectiveCount = matchingCycles ? matchingCycles.length : n;
    lastEffectiveCount = effectiveCount;
    const { from, to } = windowRange(effectiveCount);
    const cycleIdxList = matchingCycles ? matchingCycles.slice(from, to) : Array.from({ length: to - from }, (_, k) => from + k);
    if (jump && !cycleIdxList.includes(jump.cycle)) {
      // The filter hides it, or it is outside the window while "Alle anzeigen" is off: show it as
      // well
      cycleIdxList.push(jump.cycle);
      cycleIdxList.sort((p, q) => p - q);
      jump.pinned = true;
    }

    els.diagramControls.style.display = 'flex';
    const filterSuffix = matchingCycles ? ` (gefiltert aus ${n})` : '';
    els.winLabel.textContent = showAll
      ? `Gesamte Aufzeichnung (${effectiveCount} Umläufe${filterSuffix})`
      : `Umlauf ${from + 1}–${to} von ${effectiveCount}${filterSuffix}`;
    els.btnWinPrev.disabled = showAll || from <= 0;
    els.btnWinNext.disabled = showAll || to >= effectiveCount;
    els.winSize.disabled = showAll;

    // Green segments that go past a cycle limit (the green starts in cycle A and ends only in cycle
    // B).
    // stats.greens and greenSweep (makeIndexSweep, based on the start point) assign such a segment
    // ONLY to cycle A (where it starts).
    // Without this tracking, cycle B has no relation to this segment.
    // But its bar still draws green there, because segSweep is based on overlap.
    // carrySegs keeps, for each signal group, the segment that started in ONE cycle but goes past
    // its end.
    // It also keeps the Ab value that the code already calculated for it.
    // carrySegs passes it on to the NEXT cycle that follows directly in time.
    // The code checks this with a real time overlap and not with the list index.
    // So it correctly skips a row that the filter or the window hides, with no replacement.
    const carrySegs = sgData.map(() => null);

    const rowData = [];
    cycleIdxList.forEach(i => {
      const start = cycleStarts[i];
      const end = i + 1 < n ? cycleStarts[i + 1] : tMax;
      const spl = findSplAt(start, times, splValues) || '–';
      const tu = Math.round((end - start) / 1000);
      const irregular = tu > irregularLimitSec;
      const cropped = irregular && !expandedCycles.has(i);
      const viewEnd = cropped ? Math.min(end, start + Math.round(cropSec * 1000)) : end;

      const sgRows = sgData.map((sd, sgIdx) => {
        const gIdx = sd.greenSweep(start, end);
        let an = '–', ab = '–', tf = '–', anomClass = '', greenSeg = null;
        let carryGreenSeg = null, carryAb = null;

        const prevCarry = carrySegs[sgIdx];
        if (prevCarry && prevCarry.seg.end > start && prevCarry.seg.end <= end) {
          carryGreenSeg = prevCarry.seg;
          carryAb = prevCarry.ab;
          carrySegs[sgIdx] = null; // ends in this cycle - done for the other rows
        } else if (prevCarry && prevCarry.seg.end <= start) {
          carrySegs[sgIdx] = null; // ended earlier (for example the code skipped the row) - not valid anymore
        }

        if (gIdx !== -1) {
          // This is the same object reference as in visSegs.
          // stats.greens comes from the same segment objects as segs through .filter() (see
          // computeCycleStats()).
          // So edgeLabelsFor() below can identify EXACTLY this green segment.
          // Otherwise it would assign An and Ab to each GRUEN segment of the row, if there are
          // several in each cycle.
          greenSeg = sd.stats.greens[gIdx];
          const seg = TU ? computeSegmentAnAbTf(greenSeg, cycleStarts, TU) : null;
          if (seg) { an = seg.an; ab = seg.ab; tf = seg.tf; }
          if (sd.flags[gIdx]) anomClass = 'up-anom';
          if (greenSeg.end > end) carrySegs[sgIdx] = { seg: greenSeg, ab }; // goes past this row
        }
        return {
          sgEntry: sd.sgEntry, an, ab, tf, anomClass, greenSeg, carryGreenSeg, carryAb,
          visSegs: sd.segSweep(start, viewEnd),
          fzVisSegs: sd.fzRows.map(fd => fd.fzSweep(start, viewEnd)),
          zwlVisSegs: sd.fzRows.map(fd => fd.zwlSweep(start, viewEnd)),
          fzRows: sd.fzRows
        };
      });

      const traceRows = traceRefs.map(r => {
        const m = traceMeta.get(objKey(r));
        if (m.kind === 'kennzahl') {
          return {
            col: m.col, kind: m.kind, value: m.valuesByCycleIdx[i], valueKind: m.valueKind,
            span: m.spansByCycleIdx ? m.spansByCycleIdx[i] : null
          };
        }
        return { col: m.col, kind: m.kind, visSegs: m.sweep(start, viewEnd) };
      });

      // end = end of the drawn window, fullEnd = real end of the cycle
      rowData.push({ i, start, end: viewEnd, fullEnd: end, spl, tu, irregular, cropped, sgRows, traceRows,
        darkShare: irregular && sgData.length ? darkSeconds(sgData[0].segs, start, end) / Math.max(1, (end - start) / 1000) : 0 });
    });

    if (rowData.length === 0) {
      els.rows.innerHTML = matchingCycles
        ? '<div class="cfg-empty u-pad-16">Keine Umläufe erfüllen den Filter.</div>'
        : '';
      els.sgLabel.textContent = sgData.map(sd => sd.sgEntry.col.name).join(', ');
      els.info.textContent = `${n} Umlauf/Umläufe`;
      els.tablePanel.style.display = '';
      return;
    }

    // Row HTML for each cycle group.
    // It runs ONCE over objRefs (the display order that the user set).
    // It takes from sgRows and traceRows in turns.
    // Their relative order is exactly the same as sgRefs and traceRefs.
    // The reason is that the code derives both with .filter() from the same objRefs list.
    // So the user can nest signal groups and detector, APW and formula tracks freely.
    // They do not appear in three fixed blocks.
    // The ÖV travel time sub rows (tFZ and ZwL) stay tied to their signal group.
    // They have no own entry in the object list.
    // So they still have the "↳" mark.
    // DET, APW and FORMEL are now equal tracks and no longer "under" a specific signal group.
    // So they have no arrow prefix.
    const laneRowsHtml = r => {
      let sgCursor = 0, traceCursor = 0;
      return objRefs.map(ref => {
        if (ref.kuerzel === 'SG') {
          const sr = r.sgRows[sgCursor++];
          return `
        <div class="lane-row up-main-row">
          <div class="lane-name" title="${esc(sr.sgEntry.col.beschreibung && sr.sgEntry.col.beschreibung !== sr.sgEntry.col.name ? sr.sgEntry.col.beschreibung : sr.sgEntry.col.name)}">${esc(sr.sgEntry.col.name)}</div>
          <div class="lane-num" data-field="an" title="An [s]">${sr.an}</div>
          <div class="lane-num" data-field="ab" title="Ab [s]">${sr.ab}</div>
          <div class="lane-num ${sr.anomClass}" data-field="tf" title="TF [s]${sr.anomClass ? ' – auffällig' : ''}">${sr.tf}</div>
          <div class="lane-track"><svg></svg></div>
        </div>` + sr.fzRows.map(fd => `
        <div class="lane-row up-sub-row">
          <div class="lane-name" title="Theoretische Fahrzeit (${esc(sr.sgEntry.col.name)} · ${esc(fd.label)}): Soll-Anteil und Verlustzeit-Anteil">↳tFZ ${esc(fd.label)}</div>
          <div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div>
          <div class="lane-track up-sub-track"><svg></svg></div>
        </div>
        <div class="lane-row up-sub-row">
          <div class="lane-name" title="Zwangslöschzeit-Fenster (${esc(sr.sgEntry.col.name)} · ${esc(fd.label)}): Anmeldung bis Zwangslöschzeit">↳ZwL ${esc(fd.label)}</div>
          <div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div>
          <div class="lane-track up-sub-track"><svg></svg></div>
        </div>`).join('');
        }
        const tr = r.traceRows[traceCursor++];
        const c = tr.col;
        return `
        <div class="lane-row up-sub-row">
          <div class="lane-name" title="${esc(c.beschreibung && c.beschreibung !== c.name ? c.beschreibung : c.name)}">${esc(c.name)}</div>
          <div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div>
          <div class="lane-track up-sub-track"><svg></svg></div>
        </div>`;
      }).join('');
    };

    // Log markers: a thin row at the top of each cycle that has log entries.
    // The row has no "up-sub-row" class.
    // The code below finds the lane rows of a group with that class (in DOM order).
    const logRowHtml = r => {
      const all = GZ.logs.hasEntries() ? GZ.logs.visible(r.start, r.fullEnd) : [];
      r.logs = all;
      r.logsInView = all.filter(e => e.t <= r.end);
      r.logsBeyond = all.filter(e => e.t > r.end);
      if (!all.length) return '';
      return `${logRibbonHtml(r)}
        <div class="lane-row up-log-row">
          <div class="lane-name" title="Log-Einträge in diesem Umlauf">Log (${all.length})</div>
          <div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div>
          <div class="lane-track up-sub-track"><svg></svg></div>
        </div>`;
    };
    // Ribbon with the log entries of the cycle: time, level, text and seconds after the cycle
    // start.
    // The color follows the most severe entry.
    // The ribbon shows only the first lines.
    // The exception is when the cycle is expanded or when an entry that the user opened from the
    // log list is among the hidden ones.
    const jumpedEntry = jump ? jump.entry : null;
    const logRibbonHtml = r => {
      const rank = GZ.logs.RANK;
      const worst = r.logs.reduce((w, e) => rank[e.severity] > rank[w] ? e.severity : w, r.logs[0].severity);
      const showAll = expandedLogs.has(r.i) || (jumpedEntry && r.logs.includes(jumpedEntry)) || r.logs.length <= RIBBON_LINES;
      const shown = showAll ? r.logs : r.logs.slice(0, RIBBON_LINES);
      const lines = shown.map(e => {
        const offset = Math.round((e.t - r.start) / 1000);
        return `<div class="up-log-line" data-i="${r.logs.indexOf(e)}"><span class="log-time">${esc(fmtTimeShort(e.t))}</span> <b class="log-sev log-sev-${esc(e.severity)}">${esc(e.level || '–')}</b> <span class="up-log-text">${esc(e.text)}</span> <span class="dim">${offset >= 0 ? '+' + offset + ' s' : ''}${e.t > r.end ? ' · hinter dem Ausschnitt' : ''}</span></div>`;
      }).join('');
      const more = r.logs.length > RIBBON_LINES
        ? `<button type="button" class="up-log-more" data-cycle="${r.i}">${showAll ? 'weniger anzeigen' : `alle ${r.logs.length} anzeigen`}</button>` : '';
      return `<div class="up-log-ribbon sev-${esc(worst)}"><div class="up-log-label">${r.logs.length === 1 ? 'Log-Eintrag' : `Log-Einträge (${r.logs.length})`}</div><div class="up-log-lines">${lines}${more}</div></div>`;
    };

    // Caption of an irregular cycle: it explains the length and offers a full length view or a
    // shortened view.
    const irregularHtml = r => {
      if (!r.irregular) return '';
      const dark = r.darkShare > 0.05 ? ` · davon ${Math.round(r.darkShare * 100)} % Dunkel` : '';
      return ` <span class="up-irregular" title="Länger als das ${GZ.format.fmtNum(GZ.greenTime.IRREGULAR_CYCLE_FACTOR, 1)}-Fache des Median-Umlaufs. Meist Dunkelzeit oder Abschaltung: TX läuft dann nicht, daher kommt keine Umlaufgrenze.">unregelmäßig · ${GZ.format.fmtDauer(r.tu)}${dark}</span>` +
        `<button type="button" class="up-expand" data-cycle="${r.i}">${r.cropped ? 'volle Länge anzeigen' : 'kürzen'}</button>` +
        (r.cropped ? ` <span class="win-label">dargestellt: erste ${Math.round((r.end - r.start) / 1000)} s</span>` : '');
    };

    els.rows.innerHTML = rowData.map(r => `
      <div class="up-group" data-cycle="${r.i}">
        <div class="up-group-caption" title="Start: ${esc(fmtTs(new Date(r.start)))}">Umlauf #${r.i + 1} <span class="win-label">${fmtTimeShort(r.start)} · SPL ${esc(r.spl)} · TU ${r.tu}s</span>${irregularHtml(r)}</div>
        ${logRowHtml(r)}
        ${laneRowsHtml(r)}
      </div>`).join('');

    // Measure the size ONCE (this forces a reflow) and not for each row.
    // Otherwise there is layout thrashing with many cycles (write and measure in turns).
    const groupEls = els.rows.querySelectorAll('.up-group');
    const firstMainTrack = els.rows.querySelector('.up-main-row .lane-track');
    const mainSize = firstMainTrack ? { width: firstMainTrack.clientWidth, height: firstMainTrack.clientHeight } : { width: 0, height: 0 };
    const firstSubTrack = els.rows.querySelector('.up-sub-track');
    const subSize = firstSubTrack ? { width: firstSubTrack.clientWidth, height: firstSubTrack.clientHeight } : mainSize;

    rowData.forEach((r, idx) => {
      const group = groupEls[idx];
      const mainRowEls = group.querySelectorAll('.up-main-row');
      const subRows = group.querySelectorAll('.up-sub-row');
      let sgCursor = 0, subCursor = 0, traceCursor = 0;

      // Use the same objRefs order as in the template above.
      // The row DOM (by class selector in document order) and the data access (sgRows and traceRows
      // cursors) run in step.
      objRefs.forEach(ref => {
        if (ref.kuerzel === 'SG') {
          const sr = r.sgRows[sgCursor];
          const mainSvg = mainRowEls[sgCursor].querySelector('.lane-track svg');
          sgCursor++;
          renderLane(mainSvg, {
            wMin: r.start, wMax: r.end, segs: sr.visSegs, baselineCat: 'ROT', baselineColor: 'var(--sig-red)',
            width: mainSize.width, height: mainSize.height, gridStepMs: 5000, laneStyle,
            highlights: highlightsByObjKey.get(objKey(ref)) || [],
            // A green segment that goes past the cycle limit is visible in TWO rows.
            // The bar fill is in both rows (through segSweep, see carrySegs above).
            // But in each row, show only the label(s) that REALLY belong to its visible edge.
            // An (left) only if the segment also starts AND ends here.
            // Otherwise the segment goes on and there is no right edge here.
            // Ab (right) is separate, for the continuation row in which the segment really ends
            // (carryGreenSeg and carryAb).
            edgeLabelsFor: d => {
              if (sr.greenSeg && d === sr.greenSeg) return { left: sr.an, right: sr.greenSeg.end <= r.end ? sr.ab : null };
              if (sr.carryGreenSeg && d === sr.carryGreenSeg) return { right: sr.carryAb };
              return null;
            }
          });
          wireMeasure(mainSvg, r.start, r.end, `${r.i}|main|${sr.sgEntry.col.index}`);

          sr.fzRows.forEach((fd, fi) => {
            const fzSvg = subRows[subCursor++].querySelector('.lane-track svg');
            renderLane(fzSvg, {
              wMin: r.start, wMax: r.end, segs: sr.fzVisSegs[fi],
              baselineCat: 'FZ_NONE', baselineColor: 'var(--text-faint)', baselineHeight: 2,
              width: subSize.width, height: subSize.height, gridStepMs: 5000,
              fillFor: d => d.cat === 'FZ_SOLL' ? 'var(--fz-soll)' : 'var(--fz-verlust)',
              segLabelFor: d => d.cat === 'FZ_SOLL' ? String(Math.round(d.sollfahrzeitSek)) : String(Math.round(d.verlustSek)),
              segTitle: d => d.cat === 'FZ_SOLL'
                ? `Sollfahrzeit: ${d.sollfahrzeitSek}s (${fmtTimeShort(d.start)}–${fmtTimeShort(d.end)})`
                : `Verlustzeit: ${d.verlustSek.toFixed(1)}s (${fmtTimeShort(d.start)}–${fmtTimeShort(d.end)})`
            });
            wireMeasure(fzSvg, r.start, r.end, `${r.i}|fz|${sr.sgEntry.col.index}|${fi}`);

            const zwlSvg = subRows[subCursor++].querySelector('.lane-track svg');
            renderLane(zwlSvg, {
              wMin: r.start, wMax: r.end, segs: sr.zwlVisSegs[fi],
              baselineCat: 'ZWL_NONE', baselineColor: 'var(--text-faint)', baselineHeight: 2,
              width: subSize.width, height: subSize.height, gridStepMs: 5000,
              fillFor: () => 'url(#gz-pat-zwl)',
              segLabelFor: d => String(Math.round(d.zwangsloeschSek)),
              segLabelColorFor: () => 'var(--text)',
              segTitle: d => `Zwangslöschzeit-Fenster: ${d.zwangsloeschSek}s ab Anmeldung (Schwelle ${fmtTimeShort(d.end)})`
            });
            wireMeasure(zwlSvg, r.start, r.end, `${r.i}|zwl|${sr.sgEntry.col.index}|${fi}`);
          });
          return;
        }

        const tr = r.traceRows[traceCursor++];
        const c = tr.col;
        const subSvg = subRows[subCursor++].querySelector('.lane-track svg');
        if (tr.kind === 'apw') {
          renderLane(subSvg, {
            wMin: r.start, wMax: r.end, segs: tr.visSegs,
            baselineCat: '__apw_none__', baselineColor: 'var(--text-faint)', baselineHeight: 2,
            width: subSize.width, height: subSize.height, gridStepMs: 5000,
            highlights: highlightsByObjKey.get(objKey(c)) || [],
            fillFor: d => d.cat === 'LUECKE' ? 'url(#gz-pat-gap)' : (d.idx % 2 === 0 ? 'var(--apw-a)' : 'var(--apw-b)'),
            segLabelFor: d => d.cat === 'LUECKE' ? '' : d.cat,
            segLabelColorFor: d => d.idx % 2 === 0 ? '#fff' : 'var(--text)',
            segTitle: d => d.cat === 'LUECKE'
              ? `Datenlücke: ${fmtTimeShort(d.start)}–${fmtTimeShort(d.end)}`
              : `${esc(c.name)}: ${esc(d.cat)} (${fmtTimeShort(d.start)}–${fmtTimeShort(d.end)}, ${Math.round((d.end - d.start) / 1000)}s)`
          });
          wireMeasure(subSvg, r.start, r.end, `${r.i}|apw|${c.index}`);
        } else if (tr.kind === 'kennzahl') {
          // Key figure (see umlaufstatistiken.js).
          // The code does not use a raw series sweep.
          // It uses ONE precalculated value for the whole cycle.
          // Object-related formulas (Versatz, Ueberschneidung, TF, RG, GE) have a UNIQUE time span
          // INSIDE the cycle.
          // (See tr.span, from compileValue().spanRun in exprEngine.js.)
          // An example is Versatz(K1,K2): from the stop of K1 to the start of K2.
          // Then the code draws the bar exactly over this span and not over the whole row.
          // So the user can place the key figure visually against the signal group tracks above it.
          // tr.span.endSec < startSec means that the span goes past the end of the cycle (see the
          // Versatz header comment in exprEngine.js).
          // In this case, use the full row width.
          // A geometrically wrong (backward) mark is not acceptable.
          // The same applies to each formula with no visible span (for example TU or a MOD(...)
          // formula that the user wrote by hand).
          // The code handles TRUE or FALSE key figures (kind: 'bool') like a formula track.
          // Only FALSE stays the baseline.
          // TRUE gets a color.
          // There is no extra text label, because it has the same color as the bar.
          const v = tr.value;
          const isBool = tr.valueKind === 'bool';
          const on = isBool ? v === true : !(v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v)));
          const sp = tr.span;
          const hasSpan = sp && Number.isFinite(sp.startSec) && Number.isFinite(sp.endSec) && sp.endSec > sp.startSec;
          const segStart = hasSpan ? r.start + sp.startSec * 1000 : r.start;
          const segEnd = hasSpan ? r.start + sp.endSec * 1000 : r.end;
          const segs = on ? [{ start: segStart, end: segEnd, cat: 'WERT' }] : [];
          renderLane(subSvg, {
            wMin: r.start, wMax: r.end, segs,
            baselineCat: '__kennzahl_none__', baselineColor: 'var(--text-faint)', baselineHeight: 2,
            width: subSize.width, height: subSize.height, gridStepMs: 5000,
            fillFor: () => 'var(--kennzahl-bg)',
            segLabelFor: isBool ? undefined : () => formatKennzahlValue(v),
            segTitle: () => `${esc(c.name)}: ${formatKennzahlValue(v)}`
          });
          wireMeasure(subSvg, r.start, r.end, `${r.i}|kennzahl|${c.index}`);
        } else if (tr.kind === 'phase') {
          // Phase track (see buildPhaseTrack() above).
          // Real phase segments (cat = phase ID) have their category color, as in Phasenauswertung.
          // Inferred transitions (cat 'NONE', see seg.pueLabel there) have the same hatch pattern
          // as data gaps (url(#gz-pat-gap)).
          // It means "this is not a defined state, it is derived".
          // It is not another solid color.
          const m = traceMeta.get(objKey(c));
          renderLane(subSvg, {
            wMin: r.start, wMax: r.end, segs: tr.visSegs,
            baselineCat: '__phase_baseline__', baselineColor: 'var(--text-faint)', baselineHeight: 2,
            width: subSize.width, height: subSize.height, gridStepMs: 5000,
            fillFor: d => d.cat === 'NONE' ? 'url(#gz-pat-gap)' : (m.colorByPhaseId.get(d.cat) || '#9aa4b0'),
            segLabelFor: d => d.cat === 'NONE' ? (d.pueLabel || '') : (m.phaseById.get(d.cat) ? m.phaseById.get(d.cat).kuerzel : ''),
            segLabelColorFor: d => d.cat === 'NONE' ? 'var(--text-muted)' : '#fff',
            segTitle: d => {
              const durS = Math.round((d.end - d.start) / 1000);
              if (d.cat === 'NONE') {
                const openHint = d.pueFromPhaseId && d.pueToPhaseId ? ' – klicken für PÜ-Werkzeug' : '';
                return `${d.pueLabel || 'Kein Phase aktiv'}${openHint}: ${fmtTimeShort(d.start)}–${fmtTimeShort(d.end)} (${durS}s)`;
              }
              const ph = m.phaseById.get(d.cat);
              const label = ph ? (ph.name && ph.name !== ph.kuerzel ? `${ph.kuerzel} – ${ph.name}` : ph.kuerzel) : d.cat;
              return `${label}: ${fmtTimeShort(d.start)}–${fmtTimeShort(d.end)} (${durS}s)`;
            },
            // Only named transitions are clickable (real neighbors on both sides, see
            // buildPhaseTrack()).
            // An edge segment with no pueFromPhaseId or pueToPhaseId has nothing to open.
            segCursor: d => (d.cat === 'NONE' && d.pueFromPhaseId && d.pueToPhaseId) ? 'pointer' : 'default',
            onSegClick: d => { if (d.cat === 'NONE' && d.pueFromPhaseId && d.pueToPhaseId) togglePueDetail(r.i, d.pueFromPhaseId, d.pueToPhaseId); }
          });
          wireMeasure(subSvg, r.start, r.end, `${r.i}|phase|${c.index}`);
        } else {
          const isFormula = tr.kind === 'formula';
          renderLane(subSvg, {
            wMin: r.start, wMax: r.end, segs: tr.visSegs,
            baselineCat: 'FREI', baselineColor: 'var(--text-faint)', baselineHeight: 2,
            width: subSize.width, height: subSize.height, gridStepMs: 5000,
            highlights: highlightsByObjKey.get(objKey(c)) || [],
            fillFor: isFormula ? (d => d.cat === 'BELEGT' ? 'var(--formula-on)' : undefined) : undefined,
            segTitle: s => `${esc(c.name)}${isFormula ? ` (Formel: ${esc(c.beschreibung)})` : ''} – ${s.cat === 'BELEGT' ? (isFormula ? 'Formel wahr' : 'Belegt') : s.cat === 'LUECKE' ? 'Datenlücke' : 'Unbekannt/INV'}: ${fmtTimeShort(s.start)}–${fmtTimeShort(s.end)} (${Math.round((s.end - s.start) / 1000)}s)`
          });
          wireMeasure(subSvg, r.start, r.end, `${r.i}|det|${c.index}`);
        }
      });

      if (r.logsInView.length || r.logsBeyond.length) {
        GZ.charts.logMarkers.drawStrip(group.querySelector('.up-log-row .lane-track svg'), {
          wMin: r.start, wMax: r.end, width: subSize.width, height: subSize.height, entries: r.logsInView, beyond: r.logsBeyond
        });
      }
      wireCrosshair(group, r.start, r.end);
    });

    renderPueDetailPanel(rowData, groupEls, a, TU);

    els.sgLabel.textContent = sgData.map(sd => sd.sgEntry.col.name).join(', ');
    els.info.textContent = `${n} Umlauf/Umläufe`;
    els.tablePanel.style.display = '';
    if (jump) showJumpTarget(jump, rowData);
  }

  /* ---------------- Jump from a log entry (or any time) ---------------- */
  // Highlights the target cycle.
  // If the user opened a log entry, the code marks its line in the ribbon.
  // The line then gets the extra hints (why the cycle is shown, entry behind the drawn part).
  // A jump to a time with no log entry gets a note under the caption.
  function showJumpTarget(jump, rowData) {
    const group = els.rows.querySelector(`.up-group[data-cycle="${jump.cycle}"]`);
    if (!group) return;
    const r = rowData.find(x => x.i === jump.cycle);
    const extras = [];
    if (r.cropped && jump.t > r.end) extras.push(`<span class="up-warn-text">liegt hinter dem dargestellten Ausschnitt</span> <button type="button" class="up-expand" data-cycle="${r.i}">volle Länge anzeigen</button>`);
    if (jump.pinned) extras.push('<span class="dim">angezeigt trotz Filter/Fenster</span>');
    if (jump.t < r.start) extras.push('<span class="dim">vor dem ersten erkannten Umlaufbeginn</span>');
    const line = jump.entry ? group.querySelector(`.up-log-line[data-i="${r.logs ? r.logs.indexOf(jump.entry) : -1}"]`) : null;
    if (line) {
      line.classList.add('active');
      if (extras.length) line.insertAdjacentHTML('beforeend', ' <span class="up-log-extra">' + extras.join(' · ') + '</span>');
    } else {
      const note = document.createElement('div');
      note.className = 'up-jump-note';
      note.innerHTML = `<b>Sprung zu</b> <span class="log-time">${esc(fmtTimeShort(jump.t))}</span> <span class="dim">· ${Math.round((jump.t - r.start) / 1000)} s nach Umlaufbeginn</span> ${extras.join(' · ')}<button type="button" class="up-jump-close" title="Schließen">✕</button>`;
      group.querySelector('.up-group-caption').after(note);
    }
    group.classList.add('jump-target');
    group.scrollIntoView({ block: 'center' });
  }

  // Opens the cycle that contains the time t.
  // It selects all signal groups only when none is selected.
  function jumpTo(t, entry) {
    const a = GZ.state.data.currentAnalysis;
    if (!a || !a.cycleStarts || a.cycleStarts.length < 2) return;
    if (t < a.tMin || t > a.tMax) return;   // outside the recording: no cycle (see jumpToLog in app.js)
    const hasSg = [...els.objList.querySelectorAll('.obj-row input:checked')].some(cb => cb.closest('.obj-row').dataset.key.startsWith('SG|'));
    if (!hasSg) {
      els.objList.querySelectorAll('.obj-row').forEach(row => { if (row.dataset.key.startsWith('SG|')) row.querySelector('input').checked = true; });
    }
    pendingJump = { t, entry: entry || null };
    render();
  }

  return { init, populateControls, render, refreshSyntheticColumns, jumpTo };
});
