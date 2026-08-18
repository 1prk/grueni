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
      loadHint: root.querySelector('#sdLoadHint')
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
    renderLoadHint();
  }

  function notifyChanged() {
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
        .map(r => ({ sg: sgNameByIndex.get(r.sgIndex), an: r.an != null ? r.an : null, ab: r.ab != null ? r.ab : null }))
        .filter(r => r.sg);
      if (rows.length) pueOverrides[fromKuerzel + '→' + toKuerzel] = { rows };
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
      const rows = (ov.rows || []).map(r => {
        const sgIndex = sgIndexByName.get(r.sg);
        if (sgIndex == null) { skipped.push(`Signalgruppe „${r.sg}“ (PÜ ${key})`); return null; }
        return { sgIndex, an: r.an != null ? r.an : null, ab: r.ab != null ? r.ab : null };
      }).filter(Boolean);
      if (rows.length) newOverrides[fromId + '→' + toId] = { rows };
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

  GZ.views = GZ.views || {};
  GZ.views.stammdatenLsa = { init, onAnalyzeComplete };
})(window.GZ = window.GZ || {});
