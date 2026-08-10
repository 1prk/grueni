/* GZ.views.formulaBuilder — Tab "Umlaufprüfung": Formel-Builder für
   synthetische Detektoren. Variablen sind Aliase auf bestehende Detektor-
   (WAHR/FALSCH über die Belegungslogik) bzw. APW-/ÖPNV-Spalten (Zahl, roher
   Wert); Formeln kombinieren sie über +,-,*,/,Vergleiche,AND/OR/NOT/Klammern
   (siehe GZ.exprEngine) und müssen zu WAHR/FALSCH auswerten. Tippen validiert
   nur (Syntax/Typen, keine Datenauswertung) - erst "Berechnen" wertet über
   alle TX aus und liefert je gültiger Formel eine boolesche Rohreihe, die
   umlaufpruefung.js über getSyntheticColumns() als zusätzliche, farblich
   abgesetzte Detektor-Spalte (Kürzel FORMEL) einbindet. */
(function (GZ) {
  'use strict';
  const { esc } = GZ.format;
  const { wzIstBelegt } = GZ.wartezeitLogic;
  const { compile } = GZ.exprEngine;

  const SYNTH_INDEX_BASE = 1000000; // weit jenseits jedes realen Spaltenindex

  let els = null;
  let vars = []; // {id, alias, colIndex}
  let formulas = []; // {id, name, exprText}
  let nextVarId = 1, nextFormulaId = 1;
  let syntheticCols = []; // [{index, kuerzel:'FORMEL', name, beschreibung, rawSeries}]
  let debounceTimers = new Map(); // formulaId -> timeout handle

  const RESERVED = new Set(['AND', 'OR', 'NOT']);
  const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  function init(root) {
    els = {
      root,
      varRows: root.querySelector('#upVarRows'),
      addVarBtn: root.querySelector('#upAddVarBtn'),
      formulaRows: root.querySelector('#upFormulaRows'),
      addFormulaBtn: root.querySelector('#upAddFormulaBtn'),
      calcBtn: root.querySelector('#upFormulaCalcBtn'),
      hint: root.querySelector('#upFormulaHint')
    };
    els.addVarBtn.onclick = () => { addVar(); renderVarRows(); };
    els.addFormulaBtn.onclick = () => { addFormula(); renderFormulaRows(); };
    els.calcBtn.onclick = berechnen;
  }

  // Quellspalten für Variablen: Detektoren (-> WAHR/FALSCH) und APW/ÖPNV
  // (-> Zahl). Bewusst OHNE bereits berechnete Formel-Spalten selbst (keine
  // Formeln-referenzieren-Formeln-Verkettung - hält Auswertungsreihenfolge
  // und Zyklen-Vermeidung trivial).
  function sourceCols() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return [];
    return a.otherColumns.filter(c => c.kuerzel === 'DET' || c.kuerzel === 'APW' || c.kuerzel === 'OEPNV');
  }

  function varTypeForCol(col) { return col.kuerzel === 'DET' ? 'BOOL' : 'NUM'; }

  function addVar() {
    const cols = sourceCols();
    vars.push({ id: nextVarId++, alias: `VAR${nextVarId - 1}`, colIndex: cols.length ? cols[0].index : null });
  }

  function addFormula() {
    formulas.push({ id: nextFormulaId++, name: `F${nextFormulaId - 1}`, exprText: '' });
  }

  function populateControls() {
    const cols = sourceCols();
    // Nach neuem Datenimport: Spaltenverweise, die es nicht mehr gibt (andere
    // Datei/Spaltenlayout), auf die erste verfügbare Quellspalte zurücksetzen
    // statt auf eine ungültige Spalte zu verweisen.
    vars.forEach(v => { if (!cols.find(c => c.index === v.colIndex)) v.colIndex = cols.length ? cols[0].index : null; });
    syntheticCols = [];
    renderVarRows();
    renderFormulaRows();
    els.hint.textContent = '';
    els.hint.className = 'hint';
  }

  function currentVarTypes() {
    const types = {};
    const aliasErrors = [];
    const seen = new Set();
    const cols = sourceCols();
    vars.forEach(v => {
      const alias = v.alias.trim();
      if (!alias) return;
      if (!ALIAS_RE.test(alias) || RESERVED.has(alias.toUpperCase())) { aliasErrors.push(`"${alias}" ist kein gültiger Bezeichner`); return; }
      if (seen.has(alias)) { aliasErrors.push(`"${alias}" doppelt vergeben`); return; }
      seen.add(alias);
      const col = cols.find(c => c.index === v.colIndex);
      types[alias] = col ? varTypeForCol(col) : 'BOOL';
    });
    return { types, aliasErrors };
  }

  function renderVarRows() {
    const cols = sourceCols();
    const colOptions = selectedIdx => cols.length
      ? cols.map(c => `<option value="${c.index}" ${c.index === selectedIdx ? 'selected' : ''}>${esc(c.kuerzel)} ${esc(c.name)}</option>`).join('')
      : '<option value="">– keine Detektor-/APW-/ÖPNV-Spalten –</option>';
    els.varRows.innerHTML = vars.map(v => `
      <div class="up-var-row" data-id="${v.id}">
        <input type="text" class="up-var-alias mono-input" value="${esc(v.alias)}" placeholder="Alias, z.B. RFZ_S1">
        <select class="up-var-col">${colOptions(v.colIndex)}</select>
        <span class="up-var-status"></span>
        <button type="button" class="oe-row-remove up-var-remove">✕</button>
      </div>`).join('') || '<div class="cfg-empty">Keine Variablen definiert.</div>';

    els.varRows.querySelectorAll('.up-var-row').forEach(rowEl => {
      const id = Number(rowEl.dataset.id);
      const v = vars.find(x => x.id === id);
      rowEl.querySelector('.up-var-alias').oninput = e => { v.alias = e.target.value; validateAllInline(); };
      rowEl.querySelector('.up-var-col').onchange = e => { v.colIndex = e.target.value === '' ? null : Number(e.target.value); validateAllInline(); };
      rowEl.querySelector('.up-var-remove').onclick = () => { vars = vars.filter(x => x.id !== id); renderVarRows(); validateAllInline(); };
    });
    validateAllInline();
  }

  function renderFormulaRows() {
    els.formulaRows.innerHTML = formulas.map(f => `
      <div class="up-formula-row" data-id="${f.id}">
        <input type="text" class="up-formula-name mono-input" value="${esc(f.name)}" placeholder="Name">
        <input type="text" class="up-formula-expr mono-input" value="${esc(f.exprText)}" placeholder="z.B. RFZ_S1 < 999 AND D1">
        <span class="up-formula-status"></span>
        <button type="button" class="oe-row-remove up-formula-remove">✕</button>
      </div>`).join('') || '<div class="cfg-empty">Keine Formeln definiert.</div>';

    els.formulaRows.querySelectorAll('.up-formula-row').forEach(rowEl => {
      const id = Number(rowEl.dataset.id);
      const f = formulas.find(x => x.id === id);
      rowEl.querySelector('.up-formula-name').oninput = e => { f.name = e.target.value; };
      rowEl.querySelector('.up-formula-expr').oninput = e => {
        f.exprText = e.target.value;
        clearTimeout(debounceTimers.get(id));
        debounceTimers.set(id, setTimeout(() => validateFormulaRow(rowEl, f), 150));
      };
      rowEl.querySelector('.up-formula-remove').onclick = () => { formulas = formulas.filter(x => x.id !== id); renderFormulaRows(); };
      validateFormulaRow(rowEl, f);
    });
  }

  // Live-Validierung: parst + typprüft nur (siehe exprEngine.compile) - wertet
  // NICHT gegen Daten aus. Aktualisiert ausschließlich den Status-Span, nicht
  // die gesamte Zeile, damit Eingabefokus/Cursorposition beim Tippen erhalten
  // bleibt (kein voller renderFormulaRows()-Aufruf pro Tastendruck).
  function validateFormulaRow(rowEl, f) {
    const statusEl = rowEl.querySelector('.up-formula-status');
    const { types, aliasErrors } = currentVarTypes();
    if (aliasErrors.length) {
      statusEl.textContent = '✕';
      statusEl.className = 'up-formula-status err';
      statusEl.title = 'Variablen-Fehler: ' + aliasErrors.join('; ');
      return;
    }
    const result = compile(f.exprText, types);
    if (result.ok) {
      statusEl.textContent = '✓';
      statusEl.className = 'up-formula-status ok';
      statusEl.title = 'Gültig';
    } else {
      statusEl.textContent = '✕';
      statusEl.className = 'up-formula-status err';
      statusEl.title = result.message;
    }
  }

  function validateAllInline() {
    if (!els.formulaRows) return;
    els.formulaRows.querySelectorAll('.up-formula-row').forEach(rowEl => {
      const id = Number(rowEl.dataset.id);
      const f = formulas.find(x => x.id === id);
      if (f) validateFormulaRow(rowEl, f);
    });
    els.varRows.querySelectorAll('.up-var-row').forEach(rowEl => {
      const id = Number(rowEl.dataset.id);
      const v = vars.find(x => x.id === id);
      const statusEl = rowEl.querySelector('.up-var-status');
      if (!v || !statusEl) return;
      const alias = v.alias.trim();
      let msg = '';
      if (!alias) msg = 'Alias fehlt';
      else if (!ALIAS_RE.test(alias) || RESERVED.has(alias.toUpperCase())) msg = 'Ungültiger Bezeichner';
      else {
        const dupCount = vars.filter(x => x.alias.trim() === alias).length;
        if (dupCount > 1) msg = 'Alias doppelt vergeben';
      }
      statusEl.textContent = msg ? '✕' : '✓';
      statusEl.className = 'up-var-status ' + (msg ? 'err' : 'ok');
      statusEl.title = msg || 'Gültig';
    });
  }

  // Wertet ALLE aktuell gültigen Formeln über die gesamte Aufzeichnung aus
  // (eine boolesche Rohreihe je TX) und ersetzt syntheticCols vollständig -
  // erst hier, nicht während des Tippens (siehe validateFormulaRow oben).
  function berechnen() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const { times, seriesByCol } = a;
    const { types, aliasErrors } = currentVarTypes();
    const cols = sourceCols();

    if (aliasErrors.length) {
      els.hint.textContent = 'Variablen-Fehler: ' + aliasErrors.join('; ') + ' – bitte zuerst beheben.';
      els.hint.className = 'hint warn';
      return;
    }

    const scopeSpecs = vars.map(v => {
      const alias = v.alias.trim();
      const col = cols.find(c => c.index === v.colIndex);
      const type = col ? varTypeForCol(col) : 'BOOL';
      return { alias, type, series: col ? seriesByCol.get(col.index) : null };
    }).filter(s => s.alias);

    const computed = [];
    let skipped = 0;
    formulas.forEach(f => {
      const name = f.name.trim() || `F${f.id}`;
      const compiled = compile(f.exprText, types);
      if (!compiled.ok) { skipped++; return; }
      const rawSeries = new Array(times.length);
      for (let i = 0; i < times.length; i++) {
        const scope = {};
        scopeSpecs.forEach(s => {
          const raw = s.series ? (s.series[i] || '') : '';
          scope[s.alias] = s.type === 'BOOL' ? wzIstBelegt(raw) : (raw.trim() === '' ? NaN : Number(raw));
        });
        rawSeries[i] = compiled.run(scope) ? '1' : '0';
      }
      computed.push({
        index: SYNTH_INDEX_BASE + f.id, kuerzel: 'FORMEL', name,
        beschreibung: f.exprText, rawSeries
      });
    });

    syntheticCols = computed;
    els.hint.textContent = formulas.length
      ? `${computed.length} von ${formulas.length} Formel(n) berechnet` + (skipped ? `, ${skipped} übersprungen (ungültig)` : '') + '.'
      : 'Keine Formeln definiert.';
    els.hint.className = 'hint' + (skipped ? ' warn' : '');

    if (GZ.views.umlaufpruefung) GZ.views.umlaufpruefung.refreshFormulaColumns();
  }

  // Lesezugriff für umlaufpruefung.js: zuletzt berechnete synthetische
  // Spalten (leer, solange "Berechnen" noch nicht geklickt wurde bzw. nach
  // einem neuen Datenimport - siehe populateControls()).
  function getSyntheticColumns() { return syntheticCols; }

  // Für die Konfiguration speichern/laden (siehe umlaufpruefung.js): Spalten
  // werden über Kürzel+Name statt Rohindex referenziert (siehe GZ.configIO)
  // - bleibt über neue Exports derselben Anlage hinweg gültig.
  function getConfig() {
    const cols = sourceCols();
    return {
      vars: vars.map(v => {
        const col = cols.find(c => c.index === v.colIndex);
        return { alias: v.alias, colKuerzel: col ? col.kuerzel : null, colName: col ? col.name : null };
      }),
      formulas: formulas.map(f => ({ name: f.name, exprText: f.exprText }))
    };
  }

  // Setzt Variablen/Formeln aus einer geladenen Konfiguration und berechnet
  // sofort (damit umlaufpruefung.js im Anschluss die dann existierenden
  // FORMEL-Spalten in seiner eigenen applyConfig() by-Name auswählen kann -
  // siehe dortige Aufrufreihenfolge). Spalten, die es in der aktuell
  // geladenen CSV nicht (mehr) gibt, werden übersprungen und gemeldet statt
  // die restliche Konfiguration abzubrechen.
  function applyConfig(cfg) {
    if (!cfg) return { skipped: [] };
    const cols = sourceCols();
    const skipped = [];
    vars = (cfg.vars || []).map(v => {
      const col = cols.find(c => c.kuerzel === v.colKuerzel && c.name === v.colName);
      if (!col) skipped.push(`Variable „${v.alias}“ (Spalte „${v.colName}“ nicht gefunden)`);
      return { id: nextVarId++, alias: v.alias, colIndex: col ? col.index : (cols.length ? cols[0].index : null) };
    });
    formulas = (cfg.formulas || []).map(f => ({ id: nextFormulaId++, name: f.name, exprText: f.exprText }));
    renderVarRows();
    renderFormulaRows();
    berechnen();
    return { skipped };
  }

  GZ.views = GZ.views || {};
  GZ.views.formulaBuilder = { init, populateControls, getSyntheticColumns, getConfig, applyConfig };
})(window.GZ = window.GZ || {});
