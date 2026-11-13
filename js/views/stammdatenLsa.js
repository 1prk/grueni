/* GZ.views.stammdatenLsa is the tab "Stammdaten LSA": it sets the phase division.
   A phase is a set of signal groups that show green at the same time (see the RiLSA explanation
   in the hint text of the panel).
   The view edits GZ.state.data.phases directly.
   The evaluation itself runs in the tab "Phasenauswertung" (js/views/phasenauswertung.js).
   The code refreshes that tab after each change here. */
GZ.define('views.stammdatenLsa', { layer: 'views', deps: ['charts.timelineLane', 'configIO', 'detectors', 'format', 'phases', 'segments', 'snackbar', 'state', 'topology'] }, function (GZ) {
  'use strict';
  const { esc } = GZ.format;
  const { createPhase } = GZ.phases;
  const { renderLane, renderTimeAxis } = GZ.charts.timelineLane;

  let els = null;

  function init(root) {
    // Other views ask for these actions through the store.
    GZ.state.on('nodeConfig:save', () => saveConfig());
    GZ.state.on('nodeConfig:load', p => loadConfigFile(p.file));
    GZ.state.on('transition:show', p => jumpToTransition(p.fromPhaseId, p.toPhaseId));
    GZ.state.provide('nodeConfig:get', buildConfig);
    GZ.state.provide('nodeConfig:apply', applyConfig);
    els = {
      root,
      table: root.querySelector('#sdPhaseTable'),
      emptyHint: root.querySelector('#sdEmptyHint'),
      addBtn: root.querySelector('#sdAddPhase'),
      noSgHint: root.querySelector('#sdNoSgHint'),
      configSaveBtn: root.querySelector('#sdConfigSaveBtn'),
      configLoadInput: root.querySelector('#sdConfigLoadInput'),
      loadHint: root.querySelector('#sdLoadHint'),
      pueSection: root.querySelector('#sdPueSection'),
      pueBody: root.querySelector('#sdPueBody')
    };
    els.addBtn.addEventListener('click', () => {
      const a = GZ.state.data.currentAnalysis;
      if (!a) return;
      GZ.state.data.phases.push(createPhase(GZ.state.data.phases));
      renderTable();
      notifyChanged();
    });
    els.configSaveBtn.addEventListener('click', saveConfig);
    els.configLoadInput.addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) loadConfigFile(file);
      e.target.value = '';
    });
  }

  function onAnalyzeComplete() {
    GZ.state.data.phases = [];
    GZ.state.data.pueOverrides = {};
    renderTable();
    renderPueSection();
    renderLoadHint();
  }

  function notifyChanged() {
    renderPueSection();
    // Umlaufprüfung shows the same phases as a separate track (PHASE object, see phaseCols() and
    // buildPhaseTrack() in umlaufpruefung.js).
    // After each change here, its object list and its track rendering must follow.
    // The object list has a checkbox that appears with the first phase and disappears with the last
    // phase.
    // The views Phasenauswertung, Grünzeitanalyse and Umlaufprüfung subscribe to this topic.
    GZ.state.commit('phases:changed');
  }

  /* ---------------- Speichern/Laden je Knoten (JSON) ----------------
     Phases and manual PÜ corrections (GZ.state.data.pueOverrides, see the PÜ detail tool in
     umlaufpruefung.js) go together in ONE file.
     The file name is the node identifier (field "No" in the CSV header, see parser.js).
     This is different from the existing Umlaufprüfung configuration (js/io/configIO.js).
     That configuration does NOT use a data fingerprint check on purpose.
     This file uses the node identifier for the check.
     A phase division must be reusable over different recordings of THE SAME node.
     Time of day or duration can be different.
     Also the number of columns can be different, if the intersection changed.
     It must not work only for a recording that is exactly identical.
     So references (signal group members, PÜ correction rows) use the COLUMN NAME and never the
     raw index.
     The raw index is stable only inside one parsed CSV.
     This is the same principle as GZ.configIO (see its header comment).
     PÜ corrections refer to the pair of SHORT NAMES of the two phases.
     They do not refer to phase.id, which is valid only in this session. */
  // Builds the node configuration object from the state. Returns null when there is nothing to save.
  function buildConfig() {
    const a = GZ.state.data.currentAnalysis;
    const topo = GZ.state.data.topology;
    const hasTopology = !!(topo && topo.axes.length);
    // Phases and detectors refer to recording columns.
    // Without a recording, the user can save only the topology.
    if (!a && !hasTopology) return null;
    const sgNameByIndex = a ? new Map(a.allStats.map(s => [s.col.index, s.col.name])) : new Map();
    const phases = a ? GZ.state.data.phases : [];
    const kuerzelById = new Map(phases.map(p => [p.id, p.kuerzel]));

    const pueOverrides = {};
    Object.entries(a ? GZ.state.data.pueOverrides : {}).forEach(([key, ov]) => {
      const [fromId, toId] = key.split('→');
      const fromKuerzel = kuerzelById.get(fromId), toKuerzel = kuerzelById.get(toId);
      if (!fromKuerzel || !toKuerzel) return; // refers to a phase that the user deleted in the meantime
      const rows = ov.rows
        .map(r => ({ sg: sgNameByIndex.get(r.sgIndex), an: r.an != null ? r.an : null, ab: r.ab != null ? r.ab : null, always: !!r.always }))
        .filter(r => r.sg);
      const entry = { rows };
      if (ov.endSec != null) entry.endSec = ov.endSec;
      // Also save a pure end override with no row change.
      // It is not necessary that rows also exist.
      if (rows.length || entry.endSec != null) pueOverrides[fromKuerzel + '→' + toKuerzel] = entry;
    });

    // version 2 = version 1 + "topology" (see GZ.topology.toConfig)
    const cfg = {
      version: 2,
      knotenNr: a ? (a.knotenNr || null) : null,
      knotenName: a ? (a.knotenName || null) : null,
      phases: phases.map(p => ({
        kuerzel: p.kuerzel, name: p.name,
        members: [...p.members].map(idx => sgNameByIndex.get(idx)).filter(Boolean)
      })),
      pueOverrides,
      detectors: a ? GZ.detectors.toConfig(a) : { links: [], ignored: [] }
    };
    if (hasTopology) {
      cfg.topology = GZ.topology.toConfig(topo);
      // MAPEM JSON, derived from the topology (the editor model above is the source)
      const d = GZ.topology.derive(topo);
      if (d.arms.length) cfg.mapem = GZ.topology.toMapem(topo, d, { sortFn: GZ.phases.compareSgNames });
    }
    return cfg;
  }

  function saveConfig() {
    const cfg = buildConfig();
    if (!cfg) return;
    const a = GZ.state.data.currentAnalysis;
    const topo = GZ.state.data.topology;
    const rawId = a && a.knotenNr ? String(a.knotenNr).trim() : (topo && topo.axes.length && topo.name ? topo.name : '');
    const idPart = rawId ? rawId.replace(/[^A-Za-z0-9_-]+/g, '-') : 'unbekannt';
    GZ.configIO.downloadJson(`phasen_knoten-${idPart}.json`, cfg);
  }

  // Applies a node configuration object to the state and the view.
  // Returns { loaded, topoNote, notes, skipped, phaseCount, message, warn }.
  // loaded is false when the recording is missing. Then only the topology could be applied.
  // message and warn are the text and the kind of the hint for the user.
  function applyConfig(cfg) {
    const a = GZ.state.data.currentAnalysis;
    // The topology does not depend on a recording. Load it first.
    let topoNote = '';
    if (cfg.topology) {
      GZ.state.command('topology:setModel', { model: GZ.topology.fromConfig(cfg.topology) });
      topoNote = 'Topologie geladen. ';
    }
    if (!a) {
      const message = topoNote
        ? topoNote + 'Phasen und Detektorzuordnung werden erst nach dem Laden einer Aufzeichnung übernommen – Datei dann erneut laden.'
        : 'Bitte zuerst eine Aufzeichnung laden.';
      return { loaded: false, topoNote, notes: [], skipped: [], phaseCount: 0, message, warn: true };
    }

    const notes = [];
    if (cfg.knotenNr != null && a.knotenNr != null && String(cfg.knotenNr) !== String(a.knotenNr)) {
      notes.push(`Achtung: Datei ist für Knoten ${cfg.knotenNr}, aktuell geladen ist Knoten ${a.knotenNr}.`);
    }

    const sgIndexByName = new Map(a.allStats.map(s => [s.col.name, s.col.index]));
    const skipped = [];
    const newPhases = (cfg.phases || []).map(p => {
      const memberIndices = (p.members || []).map(name => {
        const idx = sgIndexByName.get(name);
        if (idx == null) skipped.push(`Signalgruppe „${name}“ (Phase ${p.kuerzel})`);
        return idx;
      }).filter(idx => idx != null);
      return GZ.phases.createPhaseFromConfig(p.kuerzel, p.name, memberIndices);
    });
    const idByKuerzel = new Map(newPhases.map(p => [p.kuerzel, p.id]));

    const newOverrides = {};
    Object.entries(cfg.pueOverrides || {}).forEach(([key, ov]) => {
      const [fromKuerzel, toKuerzel] = key.split('→');
      const fromId = idByKuerzel.get(fromKuerzel), toId = idByKuerzel.get(toKuerzel);
      if (!fromId || !toId) { skipped.push(`PÜ-Korrektur „${key}“ (Phase fehlt)`); return; }
      // Permanent in standard order (K, R, F, S, and numerically ascending in each group).
      // The order in which the file saved them does not matter.
      const rows = (ov.rows || []).slice().sort((r1, r2) => GZ.phases.compareSgNames(r1.sg, r2.sg)).map(r => {
        const sgIndex = sgIndexByName.get(r.sg);
        if (sgIndex == null) { skipped.push(`Signalgruppe „${r.sg}“ (PÜ ${key})`); return null; }
        return { sgIndex, an: r.an != null ? r.an : null, ab: r.ab != null ? r.ab : null, always: !!r.always };
      }).filter(Boolean);
      const entry = { rows };
      if (ov.endSec != null) entry.endSec = ov.endSec;
      if (rows.length || entry.endSec != null) newOverrides[fromId + '→' + toId] = entry;
    });

    GZ.state.data.phases = newPhases;
    GZ.state.data.pueOverrides = newOverrides;
    if (cfg.detectors) {
      GZ.detectors.fromConfig(a, cfg.detectors).forEach(msg => skipped.push(msg));
      GZ.state.commit('detectors:changed');
    }
    renderTable();
    notifyChanged();

    const msgs = notes.concat(skipped.length ? [`${skipped.length} Referenz(en) übersprungen: ${skipped.join('; ')}`] : []);
    const message = msgs.length ? topoNote + msgs.join(' ') : `${topoNote}Phasenkonfiguration geladen (${newPhases.length} Phase(n)).`;
    return { loaded: true, topoNote, notes, skipped, phaseCount: newPhases.length, message, warn: msgs.length > 0 };
  }

  function showLoadHint(message, warn) {
    els.loadHint.textContent = message;
    els.loadHint.className = warn ? 'hint warn' : 'hint';
    els.loadHint.style.display = '';
  }

  async function loadConfigFile(file) {
    let cfg;
    try { cfg = await GZ.configIO.readJsonFile(file); }
    catch (e) {
      showLoadHint(e.message, true);
      GZ.snackbar.show('Konfiguration konnte nicht geladen werden', { type: 'warning', description: e.message });
      return;
    }
    const r = applyConfig(cfg);
    showLoadHint(r.message, r.warn);
    if (!r.loaded) GZ.snackbar.show(r.topoNote ? 'Topologie geladen' : 'Keine Aufzeichnung geladen', { type: r.topoNote ? 'info' : 'warning', description: r.message });
  }

  // A discreet hint after each new data import.
  // The code shows it IF it detected the node from the CSV header (see the "No" field in
  // parser.js).
  // A real automatic load is not possible in the browser without a user action, because there is no
  // file system access.
  // So the hint only points to the Load button.
  // It does not load anything.
  function renderLoadHint() {
    if (!els.loadHint) return;
    const a = GZ.state.data.currentAnalysis;
    if (a && a.knotenNr) {
      els.loadHint.textContent = `Knoten ${a.knotenNr} erkannt – falls zuvor eine Phasenkonfiguration für diesen Knoten gespeichert wurde, oben laden.`;
      els.loadHint.className = 'hint';
      els.loadHint.style.display = '';
    } else {
      els.loadHint.style.display = 'none';
    }
  }

  function renderTable() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) { els.table.innerHTML = ''; els.emptyHint.style.display = 'none'; return; }
    const sgCols = a.allStats.map(({ col }) => col);
    els.noSgHint.style.display = sgCols.length ? 'none' : '';

    const phases = GZ.state.data.phases;
    if (phases.length === 0) {
      els.table.innerHTML = '';
      els.emptyHint.style.display = '';
      return;
    }
    els.emptyHint.style.display = 'none';

    const headCells = sgCols.map(col => {
      const title = col.beschreibung && col.beschreibung !== col.name ? `${col.name} – ${col.beschreibung}` : col.name;
      return `<th title="${esc(title)}">${esc(col.name)}</th>`;
    }).join('');

    const bodyRows = phases.map(phase => {
      const cells = sgCols.map(col => {
        const checked = phase.members.has(col.index) ? 'checked' : '';
        return `<td class="phase-check-cell"><input type="checkbox" data-member="${col.index}" ${checked}></td>`;
      }).join('');
      const count = phase.members.size;
      const countHint = count === 0
        ? '<span class="phase-count-hint warn">keine Signalgruppe gewählt</span>'
        : `<span class="phase-count-hint">${count} Signalgruppe${count === 1 ? '' : 'n'}</span>`;
      return `<tr data-phase="${phase.id}">
        <td class="phase-label-cell">
          <input type="text" class="phase-kuerzel" data-field="kuerzel" value="${esc(phase.kuerzel)}" title="Kürzel (z. B. Ph1)" maxlength="12">
          <input type="text" class="phase-name" data-field="name" value="${esc(phase.name)}" title="Bezeichnung">
          ${countHint}
        </td>
        ${cells}
        <td class="phase-del-cell"><button type="button" class="phase-del" title="Phase löschen">✕</button></td>
      </tr>`;
    }).join('');

    els.table.innerHTML = `
      <thead><tr><th>Phase</th>${headCells}<th></th></tr></thead>
      <tbody>${bodyRows}</tbody>`;

    wireRowEvents();
  }

  function wireRowEvents() {
    els.table.querySelectorAll('tbody tr[data-phase]').forEach(tr => {
      const phase = GZ.state.data.phases.find(p => p.id === tr.dataset.phase);
      if (!phase) return;

      tr.querySelectorAll('input[data-field]').forEach(inp => {
        inp.addEventListener('change', () => {
          const val = inp.value.trim();
          phase[inp.dataset.field] = val || (inp.dataset.field === 'kuerzel' ? phase.kuerzel : phase.name);
          inp.value = phase[inp.dataset.field];
          notifyChanged();
        });
      });

      tr.querySelectorAll('input[data-member]').forEach(cb => {
        cb.addEventListener('change', () => {
          const idx = Number(cb.dataset.member);
          if (cb.checked) phase.members.add(idx); else phase.members.delete(idx);
          const hint = tr.querySelector('.phase-count-hint');
          const count = phase.members.size;
          hint.className = 'phase-count-hint' + (count === 0 ? ' warn' : '');
          hint.textContent = count === 0 ? 'keine Signalgruppe gewählt' : `${count} Signalgruppe${count === 1 ? '' : 'n'}`;
          notifyChanged();
        });
      });

      tr.querySelector('.phase-del').addEventListener('click', () => {
        GZ.state.data.phases = GZ.state.data.phases.filter(p => p.id !== phase.id);
        renderTable();
        notifyChanged();
      });
    });
  }

  /* ---------------- Phasenübergänge (PÜ) ----------------
     This is an editable correction for each transition type that really occurs.
     It is not for each occurrence (see GZ.phases.listDistinctTransitions()).
     The evaluation logic itself is in js/core/phases.js and does not depend on a view.
     This file has only the display and the wiring.
     The read-only view in Umlaufprüfung (renderPueDetailPanel there) uses the same GZ.phases
     logic for reading only.
     It has a link back to this view (see jumpToTransition() below). */
  function phaseLabelText(p) {
    return p.name && p.name !== p.kuerzel ? `${p.kuerzel} – ${p.name}` : p.kuerzel;
  }

  function formatPueNum(v) { return v != null ? v : '–'; }

  // Sorts transitions by nomenclature (PÜ1.2, PÜ1.3, PÜ2.1, ...).
  // It does not use the order of the first occurrence in the recording (see
  // listDistinctTransitions).
  // It compares the two numbers in the standard label (GZ.phases.pueLabelFor) as numbers.
  // So, for example, PÜ1.10 does not come before PÜ1.2.
  // Short names with free names (fallback label "PÜ k1→k2") come after them, in alphabetical order.
  function comparePueTransitionLabels(t1, t2) {
    const parse = t => { const m = /^PÜ(\d+)\.(\d+)$/.exec(t.label); return m ? [Number(m[1]), Number(m[2])] : null; };
    const p1 = parse(t1), p2 = parse(t2);
    if (p1 && p2) return p1[0] - p2[0] || p1[1] - p2[1];
    if (p1) return -1;
    if (p2) return 1;
    return t1.label.localeCompare(t2.label);
  }

  function renderPueSection() {
    const a = GZ.state.data.currentAnalysis;
    const phases = GZ.state.data.phases;
    if (!els.pueSection) return;
    if (!a || !phases.length || !a.cycleStarts || a.cycleStarts.length < 2) {
      els.pueSection.style.display = 'none';
      return;
    }
    const TU_MED = GZ.segments.computeGlobalTU(a.cycleStarts);
    const occEntries = phases.map((phase, i) => ({
      ...GZ.phases.computePhaseOccurrences(phase, a.allStats),
      color: GZ.phases.colorForIndex(i)
    }));
    const transitions = GZ.phases.listDistinctTransitions(occEntries, a.tMin, a.tMax).sort(comparePueTransitionLabels);
    if (!transitions.length) {
      els.pueSection.style.display = 'none';
      return;
    }
    els.pueSection.style.display = '';
    els.pueBody.innerHTML = transitions.map(t => renderTransitionBlockHtml(t, phases, a, TU_MED)).join('');
    // Up to 3 columns, as many as there are blocks.
    // It does not use an auto-fit or minmax grid width.
    // So, for example, a single transition uses the full available width.
    // It does not stay at the minimum width of a possible multi-column layout.
    // The number of columns also has a limit from the real available width (MIN_BLOCK_W for each
    // column, including the gap).
    // Without this limit, too many forced columns on a narrow window can make the track column
    // (1fr) of a single row shrink to 0 px.
    // The fixed columns alone need about 480 px.
    // They are SG, "immer an", An, Ab, TF and the Remove button.
    const MIN_BLOCK_W = 560, GAP = 16;
    const containerW = els.pueBody.clientWidth || 0;
    const maxColsByWidth = containerW ? Math.max(1, Math.floor((containerW + GAP) / (MIN_BLOCK_W + GAP))) : 3;
    els.pueBody.style.gridTemplateColumns = `repeat(${Math.min(transitions.length, 3, maxColsByWidth)}, 1fr)`;
    wirePueSectionEvents(a, TU_MED);
  }

  function renderTransitionBlockHtml(t, phases, a, TU_MED) {
    const fromPhase = phases.find(p => p.id === t.fromPhaseId);
    const toPhase = phases.find(p => p.id === t.toPhaseId);
    if (!fromPhase || !toPhase) return '';
    const cycleIdx = GZ.phases.cycleIdxAtTime(t.sampleOccurrence.start, a.cycleStarts);
    const resolved = GZ.phases.resolvePueRows(fromPhase, toPhase, cycleIdx, a, TU_MED, GZ.state.data.pueOverrides);

    // The order is K, R, F, S, and numerically ascending in each group (GZ.phases.compareSgNames).
    // It is the same order as the rows themselves (see autoDetectPueRows).
    // So the selection list does not stay in the raw CSV column order.
    const sortedStats = [...a.allStats].sort((x, y) => GZ.phases.compareSgNames(x.col.name, y.col.name));
    const rowsHtml = resolved.rows.map((row, i) => {
      const sgOptions = sortedStats.map(s =>
        `<option value="${s.col.index}" ${s.col.index === row.sgIndex ? 'selected' : ''}>${esc(s.col.name)}</option>`
      ).join('');
      // The code does NOT precalculate TF here.
      // wirePueSectionEvents() reads it later from the segment that is really rendered (it can be
      // overwritten).
      // See there: "TF relative to the diagram, never derived from the raw data".
      return `
        <div class="sd-pue-row" data-row="${i}">
          <select class="sd-pue-sg" ${row.always ? 'disabled' : ''}>${sgOptions}</select>
          <label class="sd-pue-always" title="Bleibt über diesen Übergang hinweg durchgehend grün (kein An-/Ab-Ereignis)"><input type="checkbox" class="sd-pue-always-cb" ${row.always ? 'checked' : ''}> immer an</label>
          <label class="sd-pue-field">An <input type="number" class="sd-pue-an" step="1" value="${row.an != null ? row.an : ''}" ${row.always ? 'disabled' : ''}></label>
          <label class="sd-pue-field">Ab <input type="number" class="sd-pue-ab" step="1" value="${row.ab != null ? row.ab : ''}" ${row.always ? 'disabled' : ''}></label>
          <span class="sd-pue-tf">TF –</span>
          <div class="sd-pue-track"><svg></svg></div>
          <button type="button" class="sd-pue-row-remove" title="Zeile entfernen">✕</button>
        </div>`;
    }).join('');

    const fromLabel = phaseLabelText(fromPhase), toLabel = phaseLabelText(toPhase);
    // The axis row shares the grid column layout with the real rows (see the CSS .sd-pue-row and
    // .sd-pue-axis-row).
    // It has the same empty placeholder cells as a row.
    // Only the track cell has the second ticks (renderTimeAxis with stepMs=5000, see
    // wirePueSectionEvents).
    const axisRowHtml = resolved.rows.length ? `
        <div class="sd-pue-axis-row">
          <span></span><span></span><span></span><span></span><span></span>
          <div class="sd-pue-track sd-pue-axis-track"><svg></svg></div>
          <span></span>
        </div>` : '';
    return `
      <div class="sd-pue-block" id="sd-pue-${fromPhase.id}-${toPhase.id}" data-from="${fromPhase.id}" data-to="${toPhase.id}" data-cycle-idx="${cycleIdx}">
        <div class="sd-pue-block-head">
          <span><b>${esc(t.label)}</b><span class="sd-pue-block-sub"> · ${esc(fromLabel)} → ${esc(toLabel)}${resolved.overridden ? ' · manuell angepasst' : ''}</span></span>
          <span class="sd-pue-start-label" title="Frühester Gelbbeginn der abwerfenden Phase - per Definition TX=0, nicht änderbar">Start 0s</span>
          <label class="sd-pue-field" title="Spätestes echtes Grün der anwerfenden Phase - markiert als Linie im Diagramm">Ende <input type="number" class="sd-pue-end" step="1" value="${resolved.endSec != null ? resolved.endSec : ''}"> s</label>
          <button type="button" class="sd-pue-reset" ${resolved.overridden ? '' : 'disabled'}>Automatisch erkannt zurücksetzen</button>
        </div>
        ${resolved.rows.length ? `${axisRowHtml}<div class="sd-pue-rows">${rowsHtml}</div>` : '<div class="sd-pue-empty">Keine Daten für das erste Vorkommen (z. B. Datenlücke).</div>'}
        <button type="button" class="sd-pue-addrow">+ Zeile hinzufügen</button>
      </div>`;
  }

  function wirePueSectionEvents(a, TU_MED) {
    els.pueBody.querySelectorAll('.sd-pue-block').forEach(block => {
      const fromPhaseId = block.dataset.from, toPhaseId = block.dataset.to;
      const fromPhase = GZ.state.data.phases.find(p => p.id === fromPhaseId);
      const toPhase = GZ.state.data.phases.find(p => p.id === toPhaseId);
      if (!fromPhase || !toPhase) return;
      const cycleIdx = Number(block.dataset.cycleIdx);
      const resolved = GZ.phases.resolvePueRows(fromPhase, toPhase, cycleIdx, a, TU_MED, GZ.state.data.pueOverrides);
      const seedRows = resolved.rows;
      const referenceAbsMs = a.cycleStarts[cycleIdx] + (resolved.referenceSec != null ? resolved.referenceSec : 0) * 1000;

      // The window width is tied to the transition itself.
      // It is not a general padding around the row values.
      // The window starts 3 s before the start.
      // The start is the earliest signal group of the stopping phase that goes to amber.
      // So it stays visible that the group was really continuously green before.
      // The window ends 2 s after the end.
      // The end is the latest signal group of the starting phase that is in green.
      // The code never clamps the end to a value BEFORE the start (Math.max).
      // A transition definition can be degenerate or wrongly detected.
      // An example: according to the raw data, a starting signal group was already green before the
      // stopping reference.
      // Then the window would be inverted (wMax < wMin).
      // The track would stay empty.
      // With the clamp, the track at least shows the basic -3/+2 s window around the reference.
      const startSec = resolved.startSec != null ? resolved.startSec : 0;
      const endSec = Math.max(resolved.endSec != null ? resolved.endSec : 0, startSec);
      // Find cm for each row once in advance and not again later in the render loop.
      // The code needs it for the window width below and for the bars themselves.
      // So both are always consistent.
      const cmByRow = resolved.rows.map(row => row.always ? null : GZ.phases.cmForRow(row, referenceAbsMs, a));
      // The WINDOW (localWMax) must also cover the real green end point of each row.
      // That is An + the real red-amber duration, or Ab + the real amber duration.
      // It must not cover only the logical end.
      // Otherwise a manual correction can go past the end that stays tied to the real green start.
      // Such a correction can push a row out of the visible window.
      // Then its synthesized green bar (buildRowDisplaySegs) has zero width and is invisible.
      // But by the phase definition, it MUST be there.
      // Include both sides independently (not An EXCLUSIVE-OR Ab).
      // A row can have both values set at the same time (see buildRowDisplaySegs: Ab<=An = two
      // separate green parts with a real gap between them).
      // Then the window must also cover the later of the two end points.
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

      // End mark (see endMarks in renderLane()).
      // It is a solid vertical line at the end, for each row and also on the axis row.
      // So the defined transition stop stays visible in the diagram and not only as a number in the
      // header.
      const endMarks = resolved.endSec != null ? [{ t: resolved.endSec * 1000, label: `Übergangsende (Ende), ${resolved.endSec}s` }] : [];

      // One common axis for the whole block (not for each row).
      // The ticks are every 5 s (stepMs=5000).
      // They are exactly over the bars because the grid column layout is identical (see the CSS
      // .sd-pue-row and .sd-pue-axis-row).
      const axisSvg = block.querySelector('.sd-pue-axis-track svg');
      if (axisSvg) renderTimeAxis(axisSvg, localWMin, localWMax, 5000, resolved.endSec != null ? resolved.endSec * 1000 : null);

      block.querySelectorAll('.sd-pue-row').forEach((rowEl, i) => {
        const row = resolved.rows[i];
        const svg = rowEl.querySelector('.sd-pue-track svg');
        const tfEl = rowEl.querySelector('.sd-pue-tf');

        if (row.always) {
          // "Immer an" uses NO raw data on purpose (see setPueOverrideRowAlways).
          // It is a continuous full green bar over the whole window.
          renderLane(svg, {
            wMin: localWMin, wMax: localWMax, segs: [{ cat: 'GRUEN', start: localWMin, end: localWMax }],
            baselineCat: 'ROT', baselineColor: 'var(--sig-red)', baselineHeight: 3,
            gridStepMs: 5000, laneStyle: 'minimal', endMarks
          });
          tfEl.textContent = 'TF –';
        } else {
          const cm = cmByRow[i];
          // The code synthesizes the bar DIRECTLY from the row values (buildRowDisplaySegs).
          // The row values can be manually overwritten.
          // The code does not search the raw data and then adapt the result.
          // A starting row MUST be green from its change to at least the end.
          // A stopping row was already continuously green until its change.
          // This is the core of the phase definition.
          // At these points, the bar must NEVER show a different state.
          // It does not matter what the raw data give at exactly this position.
          const rowSegs = GZ.phases.buildRowDisplaySegs(row, cm, localWMin, localWMax);
          renderLane(svg, {
            wMin: localWMin, wMax: localWMax, segs: rowSegs,
            baselineCat: 'ROT', baselineColor: 'var(--sig-red)', baselineHeight: 3,
            gridStepMs: 5000, laneStyle: 'minimal', endMarks,
            // The An and Ab seconds are directly on the bar (the same pattern as the main tracks in
            // Umlaufprüfung).
            // They are not separate next to it.
            // "An" marks the red-to-amber change (ROTGELB segment, if it exists).
            // Otherwise it falls back to the start of GRUEN.
            // "Ab" stays the end of the GRUEN segment (start of GELB).
            edgeLabelsFor: d => {
              const nearAn = row.an != null && (d.cat === 'ROTGELB' || d.cat === 'GRUEN') && Math.abs(d.start - row.an * 1000) < 500;
              const nearAb = row.ab != null && d.cat === 'GRUEN' && Math.abs(d.end - row.ab * 1000) < 500;
              if (!nearAn && !nearAb) return null;
              return { left: nearAn ? row.an : null, right: nearAb ? row.ab : null };
            }
          });
          // TF is relative to the TRANSITION.
          // It is not the full real release duration, which extends far before and after this
          // transition.
          // See GZ.phases.computeRowTf().
          const tf = GZ.phases.computeRowTf(row, cm, startSec, endSec);
          tfEl.textContent = 'TF ' + formatPueNum(tf);
        }

        rowEl.querySelector('.sd-pue-sg').addEventListener('change', e => {
          GZ.phases.setPueOverrideRowField(GZ.state.data.pueOverrides, fromPhaseId, toPhaseId, i, 'sgIndex', Number(e.target.value), seedRows);
          // A different signal group can change the standard sort position of the row (see
          // sortPueOverrideRows).
          // This is different from An, Ab and "immer an".
          // Here the order does not stay correct automatically.
          GZ.phases.sortPueOverrideRows(GZ.state.data.pueOverrides, fromPhaseId, toPhaseId, a);
          notifyChanged();
        });
        rowEl.querySelector('.sd-pue-always-cb').addEventListener('change', e => {
          GZ.phases.setPueOverrideRowAlways(GZ.state.data.pueOverrides, fromPhaseId, toPhaseId, i, e.target.checked, seedRows);
          notifyChanged();
        });
        rowEl.querySelector('.sd-pue-an').addEventListener('change', e => {
          const v = e.target.value.trim();
          GZ.phases.setPueOverrideRowField(GZ.state.data.pueOverrides, fromPhaseId, toPhaseId, i, 'an', v === '' ? null : Number(v), seedRows);
          notifyChanged();
        });
        rowEl.querySelector('.sd-pue-ab').addEventListener('change', e => {
          const v = e.target.value.trim();
          GZ.phases.setPueOverrideRowField(GZ.state.data.pueOverrides, fromPhaseId, toPhaseId, i, 'ab', v === '' ? null : Number(v), seedRows);
          notifyChanged();
        });
        rowEl.querySelector('.sd-pue-row-remove').addEventListener('click', () => {
          GZ.phases.removePueOverrideRow(GZ.state.data.pueOverrides, fromPhaseId, toPhaseId, seedRows, i);
          notifyChanged();
        });
      });

      const endInput = block.querySelector('.sd-pue-end');
      if (endInput) endInput.addEventListener('change', e => {
        const v = e.target.value.trim();
        GZ.phases.setPueOverrideEndSec(GZ.state.data.pueOverrides, fromPhaseId, toPhaseId, seedRows, v === '' ? null : Number(v));
        notifyChanged();
      });

      const addBtn = block.querySelector('.sd-pue-addrow');
      if (addBtn) addBtn.addEventListener('click', () => {
        const defaultSgIndex = a.allStats.length ? a.allStats[0].col.index : 0;
        GZ.phases.addPueOverrideRow(GZ.state.data.pueOverrides, fromPhaseId, toPhaseId, seedRows, defaultSgIndex);
        GZ.phases.sortPueOverrideRows(GZ.state.data.pueOverrides, fromPhaseId, toPhaseId, a);
        notifyChanged();
      });

      const resetBtn = block.querySelector('.sd-pue-reset');
      if (resetBtn) resetBtn.addEventListener('click', () => {
        if (resetBtn.disabled) return;
        GZ.phases.resetPueOverride(GZ.state.data.pueOverrides, fromPhaseId, toPhaseId);
        notifyChanged();
      });
    });
  }

  // The "Bearbeiten in Stammdaten LSA" button in Umlaufprüfung calls this (see
  // renderPueDetailPanel() there).
  // It scrolls to the matching block and highlights it for a short time (see .sd-pue-highlight in
  // css/charts.css).
  // So the jump from the other view is visible.
  // Without it, only the tabs would change, and the user would not see it.
  function jumpToTransition(fromPhaseId, toPhaseId) {
    const domId = 'sd-pue-' + fromPhaseId + '-' + toPhaseId;
    const el = document.getElementById(domId);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('sd-pue-highlight');
    setTimeout(() => el.classList.remove('sd-pue-highlight'), 1500);
  }

  return { init, onAnalyzeComplete, jumpToTransition, saveConfig, loadConfigFile };
});
