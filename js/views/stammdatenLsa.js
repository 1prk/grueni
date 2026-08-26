/* GZ.views.stammdatenLsa — Tab "Stammdaten LSA": Phaseneinteilung festlegen.
   Eine Phase = eine Menge von Signalgruppen, die gleichzeitig Grün zeigen
   (siehe RiLSA-Erläuterung im Panel-Hinweistext). Editiert direkt
   GZ.state.data.phases; die Auswertung selbst passiert im Tab
   "Phasenauswertung" (js/views/phasenauswertung.js), das nach jeder
   Änderung hier aufgefrischt wird. */
(function (GZ) {
  'use strict';
  const { esc } = GZ.format;
  const { createPhase } = GZ.phases;
  const { renderLane, renderTimeAxis } = GZ.charts.timelineLane;

  let els = null;

  function init(root) {
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
    if (GZ.views.phasenauswertung) GZ.views.phasenauswertung.refresh();
    if (GZ.views.gruenzeitanalyse) GZ.views.gruenzeitanalyse.refresh();
    // Umlaufprüfung zeigt dieselben Phasen als eigene Spur (PHASE-Objekt,
    // siehe umlaufpruefung.js phaseCols()/buildPhaseTrack()) - deren
    // Objekt-Liste (Checkbox erscheint/verschwindet mit der ersten/letzten
    // Phase) UND Spuren-Rendering müssen nach jeder Änderung hier
    // mitziehen, exakt wie schon bei Formel-Builder-/Umlaufstatistiken-
    // Änderungen (refreshSyntheticColumns()).
    if (GZ.views.umlaufpruefung) GZ.views.umlaufpruefung.refreshSyntheticColumns();
  }

  /* ---------------- Speichern/Laden je Knoten (JSON) ----------------
     Phasen + manuelle PÜ-Korrekturen (GZ.state.data.pueOverrides, siehe
     umlaufpruefung.js PÜ-Detailwerkzeug) gemeinsam in EINER Datei, benannt
     nach der Knotenkennung (Feld "No" im CSV-Kopf, siehe parser.js) - anders
     als die bestehende Umlaufprüfung-Konfiguration (js/core/configIO.js)
     bewusst NICHT über einen Datenfingerabdruck geprüft, sondern über diese
     Kennung: eine Phaseneinteilung soll über verschiedene Aufzeichnungen
     DESSELBEN Knotens hinweg wiederverwendbar sein (andere Uhrzeit/Dauer,
     ggf. sogar andere Spaltenzahl bei einer Anlagenänderung), nicht nur bei
     exakt identischer Aufzeichnung. Referenzen (Signalgruppen-Mitglieder,
     PÜ-Korrektur-Zeilen) daher über den SPALTENNAMEN, nie den rohen Index -
     der ist nur innerhalb einer geparsten CSV stabil (dasselbe Prinzip wie
     GZ.configIO, siehe dortiger Kopfkommentar). PÜ-Korrekturen werden über
     das KÜRZEL-Paar der beiden Phasen referenziert (nicht die nur innerhalb
     dieser Sitzung gültige phase.id).
  */
  function saveConfig() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const sgNameByIndex = new Map(a.allStats.map(s => [s.col.index, s.col.name]));
    const phases = GZ.state.data.phases;
    const kuerzelById = new Map(phases.map(p => [p.id, p.kuerzel]));

    const pueOverrides = {};
    Object.entries(GZ.state.data.pueOverrides).forEach(([key, ov]) => {
      const [fromId, toId] = key.split('→');
      const fromKuerzel = kuerzelById.get(fromId), toKuerzel = kuerzelById.get(toId);
      if (!fromKuerzel || !toKuerzel) return; // referenziert eine inzwischen gelöschte Phase
      const rows = ov.rows
        .map(r => ({ sg: sgNameByIndex.get(r.sgIndex), an: r.an != null ? r.an : null, ab: r.ab != null ? r.ab : null, always: !!r.always }))
        .filter(r => r.sg);
      const entry = { rows };
      if (ov.endSec != null) entry.endSec = ov.endSec;
      // Auch ein reines Ende-Override ohne Zeilenänderung persistieren
      // (nicht nur, wenn zusätzlich Zeilen vorhanden sind).
      if (rows.length || entry.endSec != null) pueOverrides[fromKuerzel + '→' + toKuerzel] = entry;
    });

    const cfg = {
      version: 1,
      knotenNr: a.knotenNr || null,
      knotenName: a.knotenName || null,
      phases: phases.map(p => ({
        kuerzel: p.kuerzel, name: p.name,
        members: [...p.members].map(idx => sgNameByIndex.get(idx)).filter(Boolean)
      })),
      pueOverrides
    };
    const idPart = a.knotenNr ? String(a.knotenNr).trim().replace(/[^A-Za-z0-9_-]+/g, '-') : 'unbekannt';
    GZ.configIO.downloadJson(`phasen_knoten-${idPart}.json`, cfg);
  }

  async function loadConfigFile(file) {
    const a = GZ.state.data.currentAnalysis;
    if (!a) {
      els.loadHint.textContent = 'Bitte zuerst eine Aufzeichnung laden.';
      els.loadHint.className = 'hint warn';
      els.loadHint.style.display = '';
      return;
    }
    let cfg;
    try { cfg = await GZ.configIO.readJsonFile(file); }
    catch (e) {
      els.loadHint.textContent = e.message;
      els.loadHint.className = 'hint warn';
      els.loadHint.style.display = '';
      return;
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
      // Permanent in kanonischer Reihenfolge (K vor R vor F vor S, je Gruppe
      // numerisch) unabhängig davon, in welcher Reihenfolge die Datei sie
      // gespeichert hat.
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
    renderTable();
    notifyChanged();

    const msgs = notes.concat(skipped.length ? [`${skipped.length} Referenz(en) übersprungen: ${skipped.join('; ')}`] : []);
    els.loadHint.textContent = msgs.length ? msgs.join(' ') : `Phasenkonfiguration geladen (${newPhases.length} Phase(n)).`;
    els.loadHint.className = msgs.length ? 'hint warn' : 'hint';
    els.loadHint.style.display = '';
  }

  // Dezenter Hinweis nach jedem neuen Datenimport, WENN der Knoten aus dem
  // CSV-Kopf erkannt wurde (siehe parser.js "No"-Feld) - echtes automatisches
  // Laden ist im Browser ohne Nutzeraktion nicht möglich (kein Dateisystem-
  // zugriff), daher nur ein Zeiger auf den Laden-Knopf statt eines
  // tatsächlichen Ladevorgangs.
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
     Editierbare Korrektur je tatsächlich vorkommendem Übergangstyp (nicht je
     Vorkommen, siehe GZ.phases.listDistinctTransitions()) - die eigentliche
     Auswertungslogik lebt in js/core/phases.js (view-unabhängig), hier nur
     Darstellung + Verdrahtung. Die Lese-Ansicht in Umlaufprüfung
     (renderPueDetailPanel dort) nutzt dieselbe GZ.phases-Logik rein lesend
     und verlinkt hierher zurück (siehe jumpToTransition() unten). */
  function phaseLabelText(p) {
    return p.name && p.name !== p.kuerzel ? `${p.kuerzel} – ${p.name}` : p.kuerzel;
  }

  function formatPueNum(v) { return v != null ? v : '–'; }

  // Sortiert Übergänge nach Nomenklatur (PÜ1.2, PÜ1.3, PÜ2.1, ...) statt nach
  // Reihenfolge des ersten Vorkommens in der Aufzeichnung (siehe
  // listDistinctTransitions) - numerischer Vergleich der beiden Zahlen im
  // Standard-Label (GZ.phases.pueLabelFor), damit z.B. PÜ1.10 nicht vor
  // PÜ1.2 einsortiert wird. Frei benannte Kürzel (Fallback-Label "PÜ k1→k2")
  // fallen danach, alphabetisch, zurück.
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
    // Bis zu 3 Spalten, so viele wie Blöcke vorhanden sind (statt einer
    // auto-fit/minmax-Rasterbreite) - so nutzt z.B. ein einzelner Übergang
    // die volle verfügbare Breite statt auf der Mindestbreite einer
    // möglichen Mehrspalten-Aufteilung stehenzubleiben. Zusätzlich an der
    // tatsächlich verfügbaren Breite gedeckelt (MIN_BLOCK_W je Spalte,
    // inkl. Gap) - sonst könnte die Spur-Spalte (1fr) einer einzelnen Zeile
    // bei zu vielen erzwungenen Spalten auf einem schmalen Fenster auf 0px
    // zusammenschrumpfen (die festen Spalten - SG, "immer an", An, Ab, TF,
    // Entfernen-Button - allein brauchen bereits ca. 480px).
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

    // K vor R vor F vor S, je Gruppe numerisch (GZ.phases.compareSgNames) -
    // dieselbe Reihenfolge wie die Zeilen selbst (siehe autoDetectPueRows),
    // damit die Auswahlliste nicht in der rohen CSV-Spaltenreihenfolge bleibt.
    const sortedStats = [...a.allStats].sort((x, y) => GZ.phases.compareSgNames(x.col.name, y.col.name));
    const rowsHtml = resolved.rows.map((row, i) => {
      const sgOptions = sortedStats.map(s =>
        `<option value="${s.col.index}" ${s.col.index === row.sgIndex ? 'selected' : ''}>${esc(s.col.name)}</option>`
      ).join('');
      // TF wird NICHT hier vorausberechnet, sondern erst in
      // wirePueSectionEvents() aus dem tatsächlich gerenderten (ggf.
      // überschriebenen) Segment abgelesen (siehe dort) - "TF relativ zum
      // Diagramm, nie aus den Rohdaten hergeleitet".
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
    // Achsen-Zeile teilt sich das Grid-Spaltenraster mit den echten Zeilen
    // (siehe CSS .sd-pue-row/.sd-pue-axis-row) - dieselben leeren Platzhalter-
    // Zellen wie eine Zeile, nur die Spur-Zelle trägt die Sekunden-Ticks
    // (renderTimeAxis mit stepMs=5000, siehe wirePueSectionEvents).
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

      // Fensterbreite fest an den Übergang selbst gekoppelt statt an eine
      // pauschale Polsterung um die Zeilenwerte: -3s vor dem Start (früheste
      // Signalgruppe der abwerfenden Phase auf Gelb), damit sichtbar bleibt,
      // dass sie davor tatsächlich durchgehend grün war, +2s hinter dem Ende
      // (späteste Signalgruppe der anwerfenden Phase im Grün). Ende bewusst
      // nie VOR Start geklemmt (Math.max) - bei einer entarteten/falsch
      // erkannten Übergangsdefinition (z.B. eine anwerfende Signalgruppe kam
      // laut Rohdaten schon vor der abwerfenden Referenz ins Grün) wäre das
      // Fenster sonst invertiert (wMax < wMin) und die Spur bliebe leer statt
      // wenigstens das -3/+2s-Basisfenster um die Referenz zu zeigen.
      const startSec = resolved.startSec != null ? resolved.startSec : 0;
      const endSec = Math.max(resolved.endSec != null ? resolved.endSec : 0, startSec);
      // cm je Zeile einmal vorab bestimmen (statt später im Render-Loop
      // erneut) - wird sowohl für die Fensterbreite unten als auch für die
      // Balken selbst gebraucht, so bleiben beide garantiert konsistent.
      const cmByRow = resolved.rows.map(row => row.always ? null : GZ.phases.cmForRow(row, referenceAbsMs, a));
      // Das FENSTER (localWMax) muss zusätzlich den tatsächlichen Grün-
      // Endpunkt jeder Zeile abdecken (An + reale Rotgelb-Dauer bzw. Ab +
      // reale Gelb-Dauer), nicht nur das logische Ende - sonst könnte eine
      // manuelle Korrektur, die über das (unverändert am echten Grünbeginn
      // hängende) Ende hinausgeht, eine Zeile aus dem sichtbaren Fenster
      // schieben und ihr synthetisierter Grün-Balken (buildRowDisplaySegs)
      // würde als Nullbreite unsichtbar - obwohl er laut Phasendefinition da
      // sein MUSS.
      // Beide Seiten unabhängig einrechnen (nicht exklusiv An ODER Ab) -
      // eine Zeile kann beides gleichzeitig gesetzt haben (siehe
      // buildRowDisplaySegs: Ab<=An = zwei getrennte Grün-Abschnitte mit
      // echter Lücke dazwischen), dann muss das Fenster auch den späteren
      // der beiden Endpunkte abdecken.
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

      // Ende-Markierung (siehe renderLane()'s endMarks) - eine durchgezogene
      // senkrechte Linie bei Ende, sowohl je Zeile als auch auf der
      // Achsen-Zeile, damit der definierte Übergangs-Stopp im Diagramm
      // sichtbar bleibt, nicht nur als Zahl im Kopf.
      const endMarks = resolved.endSec != null ? [{ t: resolved.endSec * 1000, label: `Übergangsende (Ende), ${resolved.endSec}s` }] : [];

      // Eine gemeinsame Achse für den ganzen Block (nicht je Zeile) - Ticks
      // alle 5s (stepMs=5000), exakt über den Balken dank identischem Grid-
      // Spaltenraster (siehe CSS .sd-pue-row/.sd-pue-axis-row).
      const axisSvg = block.querySelector('.sd-pue-axis-track svg');
      if (axisSvg) renderTimeAxis(axisSvg, localWMin, localWMax, 5000, resolved.endSec != null ? resolved.endSec * 1000 : null);

      block.querySelectorAll('.sd-pue-row').forEach((rowEl, i) => {
        const row = resolved.rows[i];
        const svg = rowEl.querySelector('.sd-pue-track svg');
        const tfEl = rowEl.querySelector('.sd-pue-tf');

        if (row.always) {
          // "Immer an" - bewusst KEINE Rohdaten (siehe setPueOverrideRowAlways),
          // ein durchgehend voller Grün-Balken über das ganze Fenster.
          renderLane(svg, {
            wMin: localWMin, wMax: localWMax, segs: [{ cat: 'GRUEN', start: localWMin, end: localWMax }],
            baselineCat: 'ROT', baselineColor: 'var(--sig-red)', baselineHeight: 3,
            gridStepMs: 5000, laneStyle: 'minimal', endMarks
          });
          tfEl.textContent = 'TF –';
        } else {
          const cm = cmByRow[i];
          // Balken wird DIREKT aus den (ggf. manuell überschriebenen)
          // Zeilenwerten synthetisiert (buildRowDisplaySegs), nicht aus den
          // Rohdaten gesucht und angepasst - eine anwerfende Zeile MUSS ab
          // ihrem Wechsel bis mindestens Ende grün sein, eine abwerfende war
          // bis zu ihrem Wechsel bereits durchgehend grün (Kern der
          // Phasendefinition) - der Balken darf dort NIE einen anderen
          // Zustand zeigen, unabhängig davon, was die Rohdaten an exakt
          // dieser Stelle gerade hergeben.
          const rowSegs = GZ.phases.buildRowDisplaySegs(row, cm, localWMin, localWMax);
          renderLane(svg, {
            wMin: localWMin, wMax: localWMax, segs: rowSegs,
            baselineCat: 'ROT', baselineColor: 'var(--sig-red)', baselineHeight: 3,
            gridStepMs: 5000, laneStyle: 'minimal', endMarks,
            // An/Ab-Sekunden direkt auf dem Balken (gleiches Muster wie die
            // Hauptspuren in Umlaufprüfung) statt separat daneben. "An"
            // markiert den Rot→Gelb-Wechsel (ROTGELB-Segment, sofern
            // vorhanden - sonst fällt es auf den GRUEN-Beginn zurück),
            // "Ab" bleibt das Ende des GRUEN-Segments (Beginn GELB).
            edgeLabelsFor: d => {
              const nearAn = row.an != null && (d.cat === 'ROTGELB' || d.cat === 'GRUEN') && Math.abs(d.start - row.an * 1000) < 500;
              const nearAb = row.ab != null && d.cat === 'GRUEN' && Math.abs(d.end - row.ab * 1000) < 500;
              if (!nearAn && !nearAb) return null;
              return { left: nearAn ? row.an : null, right: nearAb ? row.ab : null };
            }
          });
          // TF relativ zum ÜBERGANG (nicht die volle reale Freigabedauer,
          // die sich weit vor/nach diesem Übergang erstreckt) - siehe
          // GZ.phases.computeRowTf().
          const tf = GZ.phases.computeRowTf(row, cm, startSec, endSec);
          tfEl.textContent = 'TF ' + formatPueNum(tf);
        }

        rowEl.querySelector('.sd-pue-sg').addEventListener('change', e => {
          GZ.phases.setPueOverrideRowField(GZ.state.data.pueOverrides, fromPhaseId, toPhaseId, i, 'sgIndex', Number(e.target.value), seedRows);
          // Andere Signalgruppe kann die kanonische Sortierposition der
          // Zeile ändern (siehe sortPueOverrideRows) - im Gegensatz zu
          // An/Ab/immer-an bleibt die Reihenfolge hier nicht automatisch
          // stimmig.
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

  // Vom "Bearbeiten in Stammdaten LSA"-Knopf in Umlaufprüfung aufgerufen
  // (siehe dort renderPueDetailPanel()) - scrollt zum passenden Block und
  // hebt ihn kurz hervor (siehe .sd-pue-highlight in css/charts.css), damit
  // der Sprung aus der anderen Ansicht sichtbar ankommt statt nur stumm die
  // Tabs zu wechseln.
  function jumpToTransition(fromPhaseId, toPhaseId) {
    const domId = 'sd-pue-' + fromPhaseId + '-' + toPhaseId;
    const el = document.getElementById(domId);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('sd-pue-highlight');
    setTimeout(() => el.classList.remove('sd-pue-highlight'), 1500);
  }

  GZ.views = GZ.views || {};
  GZ.views.stammdatenLsa = { init, onAnalyzeComplete, jumpToTransition };
})(window.GZ = window.GZ || {});
