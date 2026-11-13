/* GZ.views.formulaBuilder is the formula builder for synthetic detectors in the tab
   "Umlaufprüfung".
   Variables are aliases for existing signal group (SG), detector (DET) and APW/ÖPNV columns.
   SG and DET are object handles (see GZ.exprEngine).
   They have no direct TRUE or FALSE value any more.
   The user evaluates them with the primitives Zustand, Dauer and DauerSeit.
   An example is "Zustand(D1) == BELEGT". Before, it was only "D1".
   APW and ÖPNV stay numbers (raw value).
   The current evaluation time was an explicit TX argument before.
   It is now fully implicit.
   No primitive needs TX as an argument.
   But TX stays available as a normal NUM variable in the scope.
   It is for own, advanced conditions in function bodies.

   Functions are user-defined, parameterized expressions made from the primitives.
   An example is "LangGenug(sg, schwelle) := DauerSeit(sg, GRUEN) > schwelle".
   A formula (or another function) can call a function with concrete arguments ("LangGenug(K1,
   30)").
   Parameters are generic.
   The definition has no fixed SG, DET or NUM type.
   Each call specializes the body again with the real argument types (see GZ.exprEngine.compile()
   and compileFunctionDef()).
   Functions have NO column reference (only formulas and variables have it).
   So functions are portable 1:1 over configurations.

   Formulas combine everything with +, -, *, /, comparisons, AND, OR, NOT, brackets and function
   calls.
   They must evaluate to TRUE or FALSE.
   Typing only validates (syntax and types, no data evaluation).
   Only "Berechnen" evaluates over all TX.
   For each valid formula, it gives one boolean raw series.
   umlaufpruefung.js adds it through getSyntheticColumns() as an additional detector column with
   a different color (short name FORMEL).

   Formulas can reference OTHER formulas directly by name (for example "M1 AND NOT R1", if "M1"
   and "R1" are names of other formulas).
   For this, currentVarTypes() reports each formula name as a BOOL identifier.
   It is in the same namespace as the variable aliases (a collision is an error).
   One formula can depend on another.
   So berechnen() does not evaluate in the order of the formulas list any more.
   It first builds a dependency graph (from the identifier tokens of each formula).
   Then it evaluates the graph in topological order.
   A formula that is already finished is available to the next formula as a real JS boolean in
   the scope.
   The code finds cyclic references (direct, "M1 references M1", or indirect over several
   formulas).
   It skips all formulas that are part of a cycle (see skipReasonById).
   This avoids an endless loop and silently wrong values.
   This is different from user-defined FUNCTIONS (see above).
   Here it is necessary because the code does NOT expand formula references inline.
   They are real data dependencies between precalculated raw series.

   Each formula also has a fixed identity color (formulaColorFor(), position in the formulas
   list).
   The same color appears in these places:
   - as a color dot in the formula row,
   - as an accent under its name, where another formula references it (identColorFor hook of
     GZ.exprEditor),
   - as a highlight color on an object track, if a highlight target is set (see
     getFormulaHighlights()).
   So the user can recognize a formula everywhere. */
(function (GZ) {
  'use strict';
  const { esc } = GZ.format;
  const { buildSegments, makePointSegmentSweep, computeGlobalTU, computeCycleSgMetrics, computeCycleDetMetrics, makeRawValueSampler, makeSegmentDurationSampler } = GZ.segments;
  const { categorizeDetRaw } = GZ.parser;
  const { compile, compileFunctionDef, argRangesFor } = GZ.exprEngine;
  const { wzIstBelegt } = GZ.wartezeitLogic;

  const SYNTH_INDEX_BASE = 1000000; // far above each real column index

  let els = null;
  let vars = []; // {id, alias, colIndex}
  let funcs = []; // {id, name, params:string[], bodyText}
  let formulas = []; // {id, name, exprText, highlightCol, rawSeries}
  let nextVarId = 1, nextFuncId = 1, nextFormulaId = 1;
  let syntheticCols = []; // [{index, kuerzel:'FORMEL', name, beschreibung, rawSeries}]
  let debounceTimers = new Map(); // "<kind>:<id>" -> timeout handle

  // Identity color for each formula (see formulaColorFor() below, position in the formulas list).
  // The colors are blue, violet and pink tones on purpose.
  // They do not collide with ANY signal state (red, amber, green).
  // So a highlight can never be confused with a real signal image.
  // The code also checks them with an HSL distance against the own tones of the app (state,
  // function, variable, accent).
  // It does NOT check them only against the signal colors.
  // The first original color (#7c4dff) was only 5° of hue away from --req-marker (the function and
  // primitive chip color).
  // In the color key, it was practically the same as that color.
  // Now each entry has a distance of at least about 18° to each reserved app tone.
  const HIGHLIGHT_PALETTE = ['#3d5afe', '#00b8d4', '#e91e63', '#8e24aa', '#1a237e', '#ad1457'];

  // Reserved words.
  // Case-insensitive (AND, OR, NOT, as in the tokenizer).
  // Exact (TX and the state and function names, also exact as in the tokenizer and PRIMITIVES of
  // GZ.exprEngine).
  // An alias must not use them.
  // Otherwise the variable is unreachable in formulas.
  // The tokenizer always recognizes, for example, "GRUEN" as a state literal.
  // It does not matter what is in varTypes.
  const RESERVED_CI = new Set(['AND', 'OR', 'NOT']);
  // Derived from GZ.exprEngine.PRIMITIVE_INFO and KAT_TOKENS and not kept separately here.
  // This is the same lesson as for SG_ARG_FNS and DET_ARG_FNS in umlaufstatistiken.js.
  // A list that someone copied by hand is forgotten when a new primitive appears.
  // WertBei and DauerBei were really missing here.
  // The team found that they were missing only at the WENN and LEER addition.
  // TX and LEER are not PRIMITIVE_INFO functions (bare identifiers with no brackets).
  // So they are separate.
  const RESERVED_EXACT = new Set([
    'TX', 'LEER',
    ...Object.keys(GZ.exprEngine.KAT_TOKENS),
    ...GZ.exprEngine.PRIMITIVE_INFO.map(p => p.name)
  ]);
  const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const isReserved = alias => RESERVED_CI.has(alias.toUpperCase()) || RESERVED_EXACT.has(alias);

  // ---------- Ausdrucks-Editor:
  // The editor mechanics (contenteditable, caret mechanics, dropdown and palette, undo and redo)
  // are in GZ.exprEditor.
  // See there for the full model.
  // oepnvQa.js (ÖPNV row filter) and umlaufstatistiken.js reuse it.
  // Only what is REALLY specific to formulaBuilder stays here.
  // That is exprCandidates() (candidate list) and the two setup() calls in renderFuncRows() and
  // renderFormulaRows().

  // Comparison and arithmetic operators for the palette (see exprCandidates()).
  // The code inserts them with spaces around them.
  // So a pure click path gives readable text ("DauerSeit(K1, GRUEN) > 45" and not
  // "DauerSeit(K1,GRUEN)>45").
  const OPERATOR_INFO = [
    { label: '>', insert: ' > ', hint: 'größer als', desc: 'Zahlenvergleich: größer als' },
    { label: '>=', insert: ' >= ', hint: 'größer/gleich', desc: 'Zahlenvergleich: größer oder gleich' },
    { label: '<', insert: ' < ', hint: 'kleiner als', desc: 'Zahlenvergleich: kleiner als' },
    { label: '<=', insert: ' <= ', hint: 'kleiner/gleich', desc: 'Zahlenvergleich: kleiner oder gleich' },
    { label: '==', insert: ' == ', hint: 'gleich', desc: 'Gleichheit - für Zahlen UND Zustände (z.B. Zustand(K1) == GRUEN)' },
    { label: '!=', insert: ' != ', hint: 'ungleich', desc: 'Ungleichheit - für Zahlen UND Zustände' },
    { label: '+', insert: ' + ', hint: 'plus', desc: 'Addition' },
    { label: '-', insert: ' - ', hint: 'minus', desc: 'Subtraktion' },
    { label: '*', insert: ' * ', hint: 'mal', desc: 'Multiplikation' },
    { label: '/', insert: ' / ', hint: 'geteilt', desc: 'Division' },
    // cursor BETWEEN the brackets
    { label: '( )', insert: '()', hint: 'Klammern', desc: 'Klammern zum Gruppieren', caret: 1 }
  ];

  // Candidates for the autocomplete and the function palette.
  // They are:
  // - primitives (GZ.exprEngine.PRIMITIVE_INFO),
  // - the functions and variables that are defined at this time (module state),
  // - state constants (GZ.exprEngine.KAT_TOKENS),
  // - TX, AND, OR and NOT.
  // insertText, selStart and selEnd describe what the editor inserts at the cursor position.
  // They also describe which part of it the editor then selects as a placeholder.
  // So the user can overwrite it directly.
  // An example is "Zustand(objekt)" with "objekt" selected.
  // The code does NOT put TX in the inserted primitive and function calls on purpose (see
  // GZ.exprEngine PRIMITIVE_INFO).
  // It stays implicit.
  function exprCandidates() {
    const items = [];
    GZ.exprEngine.PRIMITIVE_INFO.forEach(p => {
      const argList = p.params.join(', ');
      const ranges = argRangesFor(p.name, p.params);
      items.push({
        group: 'Primitiven', label: p.name, hint: `(${argList})`, desc: p.desc,
        insertText: `${p.name}(${argList})`,
        selStart: ranges[0].start, selEnd: ranges[0].end, kind: 'func'
      });
    });
    funcs.forEach(f => {
      const name = f.name.trim();
      if (!name) return;
      const params = f.params.map(p => p.trim()).filter(Boolean);
      const argList = params.join(', ');
      const ranges = params.length ? argRangesFor(name, params) : [{ start: name.length + 1, end: name.length + 1 }];
      items.push({
        group: 'Eigene Funktionen', label: name, hint: `(${argList})`, desc: f.bodyText,
        insertText: `${name}(${argList})`,
        selStart: ranges[0].start, selEnd: ranges[0].end, kind: 'func'
      });
    });
    Object.entries(GZ.exprEngine.KAT_TOKENS).forEach(([tok, katType]) => {
      const group = katType === 'KAT_SG' ? 'Zustände (Signalgruppe)' : 'Zustände (Detektor)';
      items.push({ group, label: tok, hint: '', desc: '', insertText: tok, selStart: tok.length, selEnd: tok.length, kind: 'kat' });
    });
    items.push({ group: 'Sonstiges', label: 'TX', hint: 'reserviert', desc: 'aktueller Auswertungszeitpunkt - immer automatisch verfügbar, nicht selbst benennen/zuweisen', insertText: 'TX', selStart: 2, selEnd: 2, kind: 'var' });
    items.push({ group: 'Sonstiges', label: 'LEER', hint: 'reserviert', desc: '"kein Wert" (NaN) - passt sich jedem Ergebnistyp an, z.B. als "sonst"-Zweig von WENN()', insertText: 'LEER', selStart: 4, selEnd: 4, kind: 'var' });
    // Comparison operators and a number placeholder.
    // Without them, a pure click path always ended at an incomplete expression (for example
    // "DauerSeit(K1, GRUEN)").
    // The user MUST still complete it to TRUE or FALSE.
    // So the user could only finish it with the keyboard.
    // The number entry inserts a preselected "0".
    // The user can overwrite it directly.
    OPERATOR_INFO.forEach(op => {
      const caret = op.caret != null ? op.caret : op.insert.length;
      items.push({ group: 'Operatoren', label: op.label, hint: op.hint, desc: op.desc, insertText: op.insert, selStart: caret, selEnd: caret, kind: 'op' });
    });
    items.push({ group: 'Operatoren', label: '0', hint: 'Zahl', desc: 'Zahlenwert einfügen (vorselektiert - direkt überschreibbar)', insertText: '0', selStart: 0, selEnd: 1, kind: 'op' });
    ['AND', 'OR', 'NOT'].forEach(kw => {
      items.push({ group: 'Verknüpfung', label: kw, hint: '', desc: '', insertText: ` ${kw} `, selStart: kw.length + 2, selEnd: kw.length + 2, kind: 'op' });
    });
    vars.forEach(v => {
      const alias = v.alias.trim();
      if (!alias) return;
      items.push({ group: 'Variablen', label: alias, hint: '', desc: '', insertText: alias, selStart: alias.length, selEnd: alias.length, kind: 'var' });
    });
    // Other formulas are referenceable like variables by their plain name (see the file header
    // comment about formula references).
    // Use kind:'var'.
    // So they join the same candidate list (autocomplete and palette) with no break.
    // The code does NOT exclude the formula that the user edits at this time, on purpose.
    // The calculation finds a self-reference as cyclic and reports it clearly.
    // The code does not hide it silently here.
    formulas.forEach(f => {
      const name = f.name.trim();
      if (!name) return;
      items.push({ group: 'Formeln', label: name, hint: 'WAHR/FALSCH', desc: f.exprText, insertText: name, selStart: name.length, selEnd: name.length, kind: 'var' });
    });
    // Raw signal group, detector, APW and ÖPNV columns.
    // They are available also WHEN no variable exists for them yet.
    // If necessary, the selection automatically creates a matching variable (see onAccept,
    // GZ.exprEditor accept()).
    // The user does not need to create it manually first in the section "Variablen".
    sourceCols().forEach(col => {
      const existing = vars.find(v => v.colIndex === col.index);
      items.push({
        group: 'Objekte (Spalten)', label: col.name,
        hint: existing && existing.alias.trim() ? `${col.kuerzel} · Variable „${existing.alias.trim()}“` : `${col.kuerzel} · neue Variable`,
        desc: col.beschreibung || `${col.kuerzel} ${col.name}`,
        kind: 'var',
        onAccept: () => resolveOrCreateVarForCol(col)
      });
    });
    return items;
  }

  function init(root) {
    els = {
      root,
      varRows: root.querySelector('#upVarRows'),
      addVarBtn: root.querySelector('#upAddVarBtn'),
      funcRows: root.querySelector('#upFuncRows'),
      addFuncBtn: root.querySelector('#upAddFuncBtn'),
      formulaRows: root.querySelector('#upFormulaRows'),
      addFormulaBtn: root.querySelector('#upAddFormulaBtn'),
      calcBtn: root.querySelector('#upFormulaCalcBtn'),
      hint: root.querySelector('#upFormulaHint'),
      helpBtn: root.querySelector('#upFormulaHelpBtn'),
      helpModal: root.querySelector('#upFormulaHelpModal'),
      helpClose: root.querySelector('#upFormulaHelpClose'),
      bausteinPanel: root.querySelector('#upBausteinPanel'),
      bausteinPanelHead: root.querySelector('#upBausteinPanelHead'),
      bausteinPanelSummary: root.querySelector('#upBausteinPanelSummary')
    };
    els.addVarBtn.onclick = () => { addVar(); renderVarRows(); };
    els.addFuncBtn.onclick = () => { addFunc(); renderFuncRows(); };
    els.addFormulaBtn.onclick = () => { addFormula(); renderFormulaRows(); };
    els.calcBtn.onclick = berechnen;

    // The "Bausteine" (variables and functions) start collapsed.
    // The mechanism is the same open class as for .data-panel (see layout.css).
    // It is wired locally here and not in app.js, because this block is specific to the formula
    // builder.
    if (els.bausteinPanel && els.bausteinPanelHead) {
      els.bausteinPanelHead.onclick = () => els.bausteinPanel.classList.toggle('open');
    }

    if (els.helpBtn && els.helpModal) {
      const closeHelp = () => { els.helpModal.hidden = true; };
      els.helpBtn.onclick = () => { els.helpModal.hidden = false; };
      if (els.helpClose) els.helpClose.onclick = closeHelp;
      els.helpModal.addEventListener('click', e => { if (e.target === els.helpModal) closeHelp(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && !els.helpModal.hidden) closeHelp(); });
    }

    // Highlight popover (see renderFormulaRows() and positionHlPopover()).
    // There is ONE global click handler and not one for each popover.
    // It closes each open popover as soon as the user clicks outside its .up-formula-hl-wrap.
    // Opening and closing runs only through the hidden attribute of the DOM node that already
    // exists.
    // There is no renderFormulaRows() rebuild at each click.
    // So e.target stays attached to the tree during the whole event handling.
    // A full rebuild is different.
    // It can detach e.target from the DOM in the middle of the bubble phase.
    // Then closest() wrongly finds nothing.
    document.addEventListener('click', e => {
      if (!e.target.closest('.up-formula-hl-wrap')) closeAllHlPopovers();
    });
    window.addEventListener('scroll', () => closeAllHlPopovers(), true);
    window.addEventListener('resize', () => closeAllHlPopovers());
  }

  function closeAllHlPopovers() {
    if (!els || !els.formulaRows) return;
    els.formulaRows.querySelectorAll('.up-formula-hl-pop').forEach(pop => { pop.hidden = true; });
  }

  // Positions the highlight popover of a formula row relative to the eye icon.
  // It uses position:fixed with coordinates that the code calculates here.
  // It does not use position:absolute.
  // The reason is that .panel above sets overflow:hidden (for the rounded corners).
  // A popover with absolute position is cut off at the panel edge.
  // The reason is the same as for positionDropdown() in exprEditor.js.
  function positionHlPopover(rowEl) {
    const btn = rowEl.querySelector('.up-formula-hl-btn');
    const pop = rowEl.querySelector('.up-formula-hl-pop');
    if (!btn || !pop) return;
    const rect = btn.getBoundingClientRect();
    pop.style.visibility = 'hidden';
    pop.hidden = false;
    requestAnimationFrame(() => {
      if (pop.hidden) return; // closed again in the meantime
      const pw = pop.offsetWidth, ph = pop.offsetHeight;
      let left = rect.right - pw;
      if (left < 8) left = 8;
      if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
      let top = rect.bottom + 4;
      if (top + ph > window.innerHeight - 8) top = Math.max(8, rect.top - ph - 4);
      pop.style.left = Math.round(left) + 'px';
      pop.style.top = Math.round(top) + 'px';
      pop.style.visibility = '';
    });
  }

  // Source columns for variables.
  // Signal groups (SG) and detectors (DET) are object handles. APW and ÖPNV are numbers.
  // The list does NOT include the formula columns that the code already calculated.
  // So there is no chain of formulas that reference formulas.
  // This keeps the evaluation order and the cycle avoidance simple.
  // TX is the reserved evaluation time that is always implicitly available (see RESERVED_EXACT and
  // GZ.exprEngine).
  // It is never a normal column that the user must select or assign as a variable or object.
  // The filter is a safety net (case-insensitive, independent of kuerzel).
  // A raw CSV can, in an exceptional case, have a column with the name "TX" under SG, DET, APW or
  // ÖPNV.
  // This column must never appear here.
  // Otherwise the user can assign a variable to it by mistake.
  // The user can also select it as an "object" in the expression editor.
  // This collides with the real, reserved TX.
  const isTxCol = c => (c.name || '').trim().toUpperCase() === 'TX';
  function sourceCols() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return [];
    const sgCols = a.allStats.map(({ col }) => ({ ...col, kuerzel: 'SG' })).filter(c => !isTxCol(c));
    return sgCols.concat(a.otherColumns.filter(c => (c.kuerzel === 'DET' || c.kuerzel === 'APW' || c.kuerzel === 'OEPNV') && !isTxCol(c)));
  }

  function varTypeForCol(col) {
    if (col.kuerzel === 'SG') return 'SG';
    if (col.kuerzel === 'DET') return 'DET';
    return 'NUM'; // APW/OEPNV
  }

  function addVar() {
    const cols = sourceCols();
    vars.push({ id: nextVarId++, alias: `VAR${nextVarId - 1}`, colIndex: cols.length ? cols[0].index : null });
  }

  // Converts any column name into a valid identifier that is not yet in use.
  // It is the basis for "select an object from the dropdown" (see exprCandidates() and
  // resolveOrCreateVarForCol() below).
  // Column names from the OCIT header line are usually already short and the same as identifiers
  // (for example "K1", "D1").
  // The cleanup is only a safety net for exceptional cases (spaces, a leading digit, duplicates).
  function sanitizeIdent(base) {
    let s = (base || '').replace(/[^A-Za-z0-9_]/g, '_');
    if (!/^[A-Za-z_]/.test(s)) s = '_' + s;
    return s || 'VAR';
  }
  function uniqueAlias(base) {
    const root = sanitizeIdent(base);
    const taken = alias => isReserved(alias) || vars.some(v => v.alias.trim() === alias);
    if (!taken(root)) return root;
    let i = 2;
    while (taken(`${root}${i}`)) i++;
    return `${root}${i}`;
  }

  // Returns the alias of a variable that already exists for this column.
  // Otherwise it silently creates a new variable.
  // This happens when the user selects an "object" from the expression editor dropdown (see
  // exprCandidates() above and the onAccept hook in GZ.exprEditor).
  // So the user does not need to create a row in the section "Variablen" manually first when
  // writing a formula.
  // The function renders the variable list again.
  // So the new or reused assignment is visible there.
  function resolveOrCreateVarForCol(col) {
    const existing = vars.find(v => v.colIndex === col.index);
    if (existing && existing.alias.trim()) return existing.alias.trim();
    const alias = uniqueAlias(col.name);
    if (existing) existing.alias = alias;
    else vars.push({ id: nextVarId++, alias, colIndex: col.index });
    renderVarRows();
    return alias;
  }

  function addFunc() {
    funcs.push({ id: nextFuncId++, name: `Func${nextFuncId - 1}`, params: ['x'], bodyText: '' });
  }

  function addFormula() {
    formulas.push({ id: nextFormulaId++, name: `F${nextFormulaId - 1}`, exprText: '', highlightCol: null, rawSeries: null });
  }

  function populateControls() {
    const cols = sourceCols();
    // After a new data import: reset column references that do not exist any more (other file or
    // column layout) to the first available source column.
    // Do not refer to an invalid column.
    // Functions have no column reference (see the file header comment). They stay unchanged.
    vars.forEach(v => { if (!cols.find(c => c.index === v.colIndex)) v.colIndex = cols.length ? cols[0].index : null; });
    syntheticCols = [];
    // The raw series of each formula belongs to the previous file.
    // It is valid again only after the next "Berechnen".
    // Otherwise getFormulaHighlights() can evaluate stale intervals against a new time series of a
    // wrong length.
    // A highlight target that does not exist in the new file is silently reset, as for vars above.
    // It does not point to a wrong column.
    formulas.forEach(f => {
      if (f.highlightCol != null && !cols.find(c => c.index === f.highlightCol)) f.highlightCol = null;
      f.rawSeries = null;
    });
    renderVarRows();
    renderFuncRows();
    renderFormulaRows();
    renderBausteinSummary();
    els.hint.textContent = '';
    els.hint.className = 'hint';
  }

  // Builds the function table for GZ.exprEngine (form { [name]: {params, exprText} }).
  // It uses all STRUCTURALLY valid function definitions (valid, unique name and valid, unique
  // parameters).
  // The code does NOT validate the body itself here, on purpose.
  // A function with a defective body stays callable.
  // The error then appears only at the call site, with a clear assignment ("In Funktion „X“: …",
  // see parseCall() in GZ.exprEngine).
  // The code does not discard the whole function table because of one broken definition.
  function currentFuncDefs() {
    const defs = {};
    const errors = [];
    const seen = new Set();
    funcs.forEach(f => {
      const name = f.name.trim();
      if (!name) return;
      if (!ALIAS_RE.test(name) || isReserved(name)) { errors.push(`Funktion "${name}" ist kein gültiger Name`); return; }
      if (seen.has(name)) { errors.push(`Funktion "${name}" doppelt vergeben`); return; }
      seen.add(name);
      const params = f.params.map(p => p.trim());
      const validParams = params.every(p => p && ALIAS_RE.test(p) && !isReserved(p));
      const uniqueParams = new Set(params).size === params.length;
      if (!validParams || !uniqueParams) { errors.push(`Funktion "${name}": ungültige oder doppelte Parameter`); return; }
      defs[name] = { params, exprText: f.bodyText };
    });
    return { defs, errors };
  }

  // types contains, in addition to the variable aliases, each named formula name as a BOOL
  // identifier (see the file header comment about formula references).
  // So a formula can name ANOTHER formula directly ("M1 AND R1").
  // It does not need its own variable for this.
  // It shares the same "seen" set with the variable aliases (ONE common identifier namespace).
  // A formula must not have the name of a variable or of another formula.
  // Otherwise one of the two meanings is silently hidden in the scope.
  // This purely syntactic type check does NOT check whether a referenced formula is really
  // CALCULABLE (it compiles with no error and has no cyclic reference).
  // Only berechnen() checks it (dependency graph).
  // So a reference to a formula that is (still) invalid or cyclic is not a compile error.
  // At calculation, it gives "übersprungen".
  function currentVarTypes() {
    const types = {};
    const aliasErrors = [];
    const seen = new Set();
    const cols = sourceCols();
    vars.forEach(v => {
      const alias = v.alias.trim();
      if (!alias) return;
      if (!ALIAS_RE.test(alias) || isReserved(alias)) { aliasErrors.push(`"${alias}" ist kein gültiger Bezeichner`); return; }
      if (seen.has(alias)) { aliasErrors.push(`"${alias}" doppelt vergeben`); return; }
      seen.add(alias);
      const col = cols.find(c => c.index === v.colIndex);
      types[alias] = col ? varTypeForCol(col) : 'NUM';
    });
    formulas.forEach(f => {
      const name = f.name.trim();
      if (!name) return;
      if (!ALIAS_RE.test(name) || isReserved(name)) { aliasErrors.push(`Formel "${name}" ist kein gültiger Bezeichner`); return; }
      if (seen.has(name)) { aliasErrors.push(`Formel "${name}" doppelt vergeben oder kollidiert mit einer Variable`); return; }
      seen.add(name);
      types[name] = 'BOOL';
    });
    return { types, aliasErrors };
  }

  function renderVarRows() {
    const cols = sourceCols();
    const colOptions = selectedIdx => cols.length
      ? cols.map(c => `<option value="${c.index}" ${c.index === selectedIdx ? 'selected' : ''}>${esc(c.kuerzel)} ${esc(c.name)}</option>`).join('')
      : '<option value="">– keine Signalgruppen-/Detektor-/APW-/ÖPNV-Spalten –</option>';
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

  function renderFuncRows() {
    els.funcRows.innerHTML = funcs.map(f => `
      <div class="up-func-row" data-id="${f.id}">
        <input type="text" class="up-func-name mono-input" value="${esc(f.name)}" placeholder="Name">
        <span class="up-func-params">
          ${f.params.map((p, i) => `
            <span class="up-func-param-chip">
              <input type="text" class="up-func-param-input mono-input" data-idx="${i}" value="${esc(p)}" placeholder="param">
              <button type="button" class="up-func-param-remove" data-idx="${i}" title="Parameter entfernen">✕</button>
            </span>`).join('')}
          <button type="button" class="up-func-param-add btn" title="Parameter hinzufügen">+ Parameter</button>
        </span>
        <span class="expr-input-wrap">
          <div class="up-func-body expr-editor mono-input" contenteditable="true" spellcheck="false" data-placeholder="Ausdruck, z.B. DauerSeit(sg, GRUEN) &gt; schwelle" role="textbox" aria-multiline="false"></div>
          <button type="button" class="expr-palette-btn" title="Primitiven/Funktionen/Zustände einfügen">ƒ</button>
          <div class="expr-autocomplete" hidden></div>
        </span>
        <span class="up-func-status"></span>
        <button type="button" class="oe-row-remove up-func-remove">✕</button>
      </div>`).join('') || '<div class="cfg-empty">Keine Funktionen definiert.</div>';

    const debouncedRevalidate = id => {
      clearTimeout(debounceTimers.get(`fn:${id}`));
      debounceTimers.set(`fn:${id}`, setTimeout(validateAllInline, 150));
    };

    els.funcRows.querySelectorAll('.up-func-row').forEach(rowEl => {
      const id = Number(rowEl.dataset.id);
      const f = funcs.find(x => x.id === id);
      rowEl.querySelector('.up-func-name').oninput = e => { f.name = e.target.value; debouncedRevalidate(id); };
      rowEl.querySelectorAll('.up-func-param-input').forEach(inp => {
        inp.oninput = e => { f.params[Number(e.target.dataset.idx)] = e.target.value; debouncedRevalidate(id); };
      });
      rowEl.querySelectorAll('.up-func-param-remove').forEach(btn => {
        btn.onclick = () => { f.params.splice(Number(btn.dataset.idx), 1); renderFuncRows(); validateAllInline(); };
      });
      rowEl.querySelector('.up-func-param-add').onclick = () => { f.params.push(''); renderFuncRows(); validateAllInline(); };
      rowEl.querySelector('.up-func-remove').onclick = () => { funcs = funcs.filter(x => x.id !== id); renderFuncRows(); validateAllInline(); };
      GZ.exprEditor.setup(rowEl, {
        getText: () => f.bodyText,
        setText: v => { f.bodyText = v; },
        knownNames: () => new Set(f.params.map(p => p.trim()).filter(Boolean)),
        getCandidates: exprCandidates,
        onRevalidate: validateAllInline
      });
    });
    validateAllInline();
  }

  // Fixed identity color of EACH formula (see HIGHLIGHT_PALETTE above).
  // It uses the position in the WHOLE formulas list and not only among those that highlight at this
  // time.
  // So a formula keeps the same color everywhere it appears:
  // - its own color dot in the list,
  // - the reference accent in OTHER formulas (see identColorFor below),
  // - its highlight band on an object track (see getFormulaHighlights()).
  // It does not matter if or how many other formulas have a highlight target at this time.
  function formulaColorFor(f) {
    const idx = formulas.findIndex(x => x.id === f.id);
    return idx === -1 ? null : HIGHLIGHT_PALETTE[idx % HIGHLIGHT_PALETTE.length];
  }
  // For identColorFor(): the color of the formula WITH THIS NAME (if it exists).
  // A formula reference in ANOTHER formula has the same color as the referenced formula itself.
  function formulaColorByName(name) {
    const f = formulas.find(x => x.name.trim() === name);
    return f ? formulaColorFor(f) : null;
  }

  // Eye icon for the highlight popover (see closeAllHlPopovers() and positionHlPopover()).
  // It has the same shape as in the reviewed redesign mockup.
  // So the user can see at first sight, also with no text, that "something can be highlighted
  // here".
  const EYE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/></svg>';

  function renderFormulaRows() {
    const cols = sourceCols();
    els.formulaRows.innerHTML = formulas.map(f => {
      const hlTarget = f.highlightCol != null ? cols.find(c => c.index === f.highlightCol) : null;
      const hlTitle = hlTarget ? `Hervorgehoben auf: ${esc(hlTarget.kuerzel)} ${esc(hlTarget.name)}` : 'Wahr-Intervalle dieser Formel farbig auf einer Objekt-Spur hervorheben';
      return `
      <div class="up-formula-row" data-id="${f.id}">
        <div class="up-formula-head">
          <span class="up-formula-color-dot" style="background:${formulaColorFor(f)}" title="Farbe dieser Formel - auch als Referenz-Akzent in anderen Formeln und als Hervorhebungs-Farbe"></span>
          <input type="text" class="up-formula-name mono-input" value="${esc(f.name)}" placeholder="Name">
          <span class="up-formula-status"></span>
          <span class="up-formula-head-spacer"></span>
          <button type="button" class="expr-palette-btn" title="Primitiven/Funktionen/Zustände einfügen">ƒ</button>
          <span class="up-formula-hl-wrap">
            <button type="button" class="icon-btn up-formula-hl-btn${f.highlightCol != null ? ' active' : ''}" title="${hlTitle}">${EYE_SVG}</button>
            <div class="up-formula-hl-pop" hidden>
              <div class="up-formula-hl-pop-title">Auf Spur hervorheben</div>
              <button type="button" class="up-formula-hl-opt${f.highlightCol == null ? ' active' : ''}" data-col="">– kein Highlight –</button>
              ${cols.map(c => `<button type="button" class="up-formula-hl-opt${f.highlightCol === c.index ? ' active' : ''}" data-col="${c.index}">${esc(c.kuerzel)} ${esc(c.name)}</button>`).join('')}
            </div>
          </span>
          <button type="button" class="icon-btn up-formula-remove" title="Formel entfernen">✕</button>
        </div>
        <span class="expr-input-wrap">
          <div class="up-formula-expr expr-editor mono-input" contenteditable="true" spellcheck="false" data-placeholder="z.B. DauerSeit(K1, GRUEN) &gt; 45 AND Zustand(D1) == BELEGT" role="textbox" aria-multiline="false"></div>
          <div class="expr-autocomplete" hidden></div>
        </span>
      </div>`;
    }).join('') || '<div class="cfg-empty">Keine Formeln definiert.</div>';

    // A change of a formula name can affect OTHER formulas that reference it (see
    // currentVarTypes()).
    // As for variable aliases and function names, it must start a new check of ALL rows.
    // But the check is debounced (150 ms).
    // So normal typing of the name does not render the complete list (with the sidebar) again at
    // each character.
    const debouncedRevalidate = id => {
      clearTimeout(debounceTimers.get(`formula:${id}`));
      debounceTimers.set(`formula:${id}`, setTimeout(validateAllInline, 150));
    };

    els.formulaRows.querySelectorAll('.up-formula-row').forEach(rowEl => {
      const id = Number(rowEl.dataset.id);
      const f = formulas.find(x => x.id === id);
      rowEl.querySelector('.up-formula-name').oninput = e => { f.name = e.target.value; debouncedRevalidate(id); };
      rowEl.querySelector('.up-formula-remove').onclick = () => { formulas = formulas.filter(x => x.id !== id); renderFormulaRows(); validateAllInline(); };
      // Opening and closing runs only through the hidden attribute of the popover node that the
      // code already rendered (see closeAllHlPopovers()).
      // There is NO renderFormulaRows() rebuild only to open or close.
      // So the global click-outside handler in init() always finds e.target still in the DOM (see
      // the comment there).
      const hlBtn = rowEl.querySelector('.up-formula-hl-btn');
      // preventDefault on mousedown stops the button from taking the focus from the expression
      // editor that has the focus.
      // (See the same protection at .expr-palette-btn in exprEditor.js.)
      // Without it, a click on the eye also starts the blur handler of the editor.
      // The blur handler closes the autocomplete and makes the editor content settle again.
      // This is only a side effect of the focus change.
      hlBtn.addEventListener('mousedown', ev => ev.preventDefault());
      hlBtn.onclick = ev => {
        ev.stopPropagation();
        const pop = rowEl.querySelector('.up-formula-hl-pop');
        const willOpen = pop.hidden;
        closeAllHlPopovers();
        if (willOpen) positionHlPopover(rowEl);
      };
      rowEl.querySelectorAll('.up-formula-hl-opt').forEach(optEl => {
        optEl.addEventListener('mousedown', ev => ev.preventDefault());
        optEl.onclick = ev => {
          ev.stopPropagation();
          f.highlightCol = optEl.dataset.col === '' ? null : Number(optEl.dataset.col);
          closeAllHlPopovers();
          renderFormulaRows();
          if (GZ.views.umlaufpruefung) GZ.views.umlaufpruefung.refreshSyntheticColumns();
        };
      });
      GZ.exprEditor.setup(rowEl, {
        getText: () => f.exprText,
        setText: v => { f.exprText = v; },
        // Other formulas are referenceable like variables by their plain name (see
        // currentVarTypes() and the file header comment about formula references).
        // So the code also reports them as "known" here.
        // Then their name gets the reference accent color while the user types (see identColorFor
        // below).
        // The own name stays in the set on purpose (no special handling for a self-reference).
        // The calculation finds an accidental self-reference as cyclic and reports it clearly (see
        // berechnen()).
        knownNames: () => new Set([
          ...vars.map(v => v.alias.trim()).filter(Boolean),
          ...formulas.map(x => x.name.trim()).filter(Boolean)
        ]),
        getCandidates: exprCandidates,
        // A referenced formula has its own identity color (see formulaColorFor()) and not the
        // generic variable color.
        // So it is visible at first sight THAT another formula is part of this one, and WHICH
        // formula it is.
        identColorFor: formulaColorByName,
        onRevalidate: () => validateFormulaRow(rowEl, f)
      });
      validateFormulaRow(rowEl, f);
    });
  }

  // Live validation.
  // It only parses and checks types (see exprEngine.compile).
  // It does NOT evaluate against data.
  // It updates only the status span and not the whole row.
  // So the input focus and the cursor position stay while the user types.
  // There is no full renderFormulaRows() call for each key press.
  function validateFormulaRow(rowEl, f) {
    const statusEl = rowEl.querySelector('.up-formula-status');
    const { types, aliasErrors } = currentVarTypes();
    const { defs: funcDefs, errors: funcErrors } = currentFuncDefs();
    const wrap = rowEl.querySelector('.expr-input-wrap');
    const markHighlight = pos => { if (wrap && wrap.__exprRefreshHighlight) wrap.__exprRefreshHighlight(pos); };
    // Also mirrors the status as the border color of the whole card (see
    // .up-formula-row-{ok,err,pending} in components.css).
    // It is visible immediately when the user scans the list.
    // The user does not need to read to the status character.
    // The error text also appears as a line under the expression (not only in the tooltip).
    // This is ONLY for "err" and not for "pending" (see the incomplete branch below).
    // Otherwise a message flashes all the time during normal typing, and it is not a real error.
    const setRowState = (state, errMsg) => {
      rowEl.classList.remove('up-formula-row-ok', 'up-formula-row-err', 'up-formula-row-pending');
      rowEl.classList.add('up-formula-row-' + state);
      let msgEl = rowEl.querySelector('.up-formula-msg');
      if (state !== 'err') { if (msgEl) msgEl.remove(); return; }
      if (!msgEl) { msgEl = document.createElement('div'); rowEl.appendChild(msgEl); }
      msgEl.className = 'up-formula-msg err';
      msgEl.textContent = errMsg;
    };
    if (aliasErrors.length || funcErrors.length) {
      const desc = [...aliasErrors, ...funcErrors].join('; ');
      statusEl.textContent = '✕';
      statusEl.className = 'up-formula-status err';
      statusEl.title = desc;
      markHighlight(null); // The error is in the alias or function definitions and not in the formula text itself
      setRowState('err', desc);
      return;
    }
    const result = compile(f.exprText, { ...types, TX: 'NUM' }, funcDefs);
    if (result.ok) {
      statusEl.textContent = '✓';
      statusEl.className = 'up-formula-status ok';
      statusEl.title = 'Gültig';
      markHighlight(null);
      setRowState('ok');
    } else if (result.incomplete) {
      // Not finished yet and not wrong (see ExprError in exprEngine).
      // Show it neutral.
      // Do NOT draw a red error wave.
      // Otherwise an error that is not an error flashes all the time during normal typing or
      // clicking together.
      statusEl.textContent = '…';
      statusEl.className = 'up-formula-status pending';
      statusEl.title = result.message;
      markHighlight(null);
      setRowState('pending');
    } else {
      statusEl.textContent = '✕';
      statusEl.className = 'up-formula-status err';
      statusEl.title = result.message;
      markHighlight(result.pos);
      setRowState('err', result.message);
    }
  }

  // Validates functions, formulas AND variables together again.
  // A change to ONE variable or function can affect the validity of each formula (and, for
  // functions, also of other functions).
  // So the code does not check only the changed row in isolation.
  function validateAllInline() {
    if (!els.formulaRows) return;
    const { defs: funcDefs } = currentFuncDefs();

    els.funcRows.querySelectorAll('.up-func-row').forEach(rowEl => {
      const id = Number(rowEl.dataset.id);
      const f = funcs.find(x => x.id === id);
      const statusEl = rowEl.querySelector('.up-func-status');
      if (!f || !statusEl) return;
      const name = f.name.trim();
      let msg = '';
      let bodyErrPos = null;
      if (!name || !ALIAS_RE.test(name) || isReserved(name)) msg = 'Ungültiger Funktionsname';
      else if (funcs.filter(x => x.name.trim() === name).length > 1) msg = 'Name doppelt vergeben';
      else {
        const params = f.params.map(p => p.trim());
        if (params.some(p => !p || !ALIAS_RE.test(p) || isReserved(p))) msg = 'Ungültiger Parametername';
        else if (new Set(params).size !== params.length) msg = 'Parameter doppelt vergeben';
      }
      if (!msg) {
        const result = compileFunctionDef(f.params.map(p => p.trim()), f.bodyText, funcDefs);
        if (!result.ok) { msg = result.message; bodyErrPos = result.pos; }
      }
      statusEl.textContent = msg ? '✕' : '✓';
      statusEl.className = 'up-func-status ' + (msg ? 'err' : 'ok');
      statusEl.title = msg || 'Gültig';
      const wrap = rowEl.querySelector('.expr-input-wrap');
      if (wrap && wrap.__exprRefreshHighlight) wrap.__exprRefreshHighlight(bodyErrPos);
    });

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
      else if (!ALIAS_RE.test(alias) || isReserved(alias)) msg = 'Ungültiger Bezeichner';
      else {
        const dupCount = vars.filter(x => x.alias.trim() === alias).length;
        if (dupCount > 1) msg = 'Alias doppelt vergeben';
      }
      statusEl.textContent = msg ? '✕' : '✓';
      statusEl.className = 'up-var-status ' + (msg ? 'err' : 'ok');
      statusEl.title = msg || 'Gültig';
    });
    renderBausteinSummary();
  }

  // One-line summary in the header of the Bausteine block (collapsed by default), see
  // .baustein-panel in components.css.
  // So the content is recognizable at first sight also when the block is collapsed.
  // The user does not need to expand it first.
  function renderBausteinSummary() {
    if (!els.bausteinPanelSummary) return;
    const parts = [
      ...vars.filter(v => v.alias.trim()).map(v => v.alias.trim()),
      ...funcs.filter(f => f.name.trim()).map(f => f.name.trim() + '()')
    ];
    els.bausteinPanelSummary.textContent = parts.length ? parts.join(', ') : 'Keine Variablen/Funktionen definiert';
  }

  // Builds, for an SG or DET variable, its segments and a continuous point sweep
  // (GZ.segments.makePointSegmentSweep) ONCE (not for each row).
  // SG uses the segments that allStats already precalculated.
  // DET is built fresh once (like detSegsByCol in umlaufpruefung.js).
  // The handle object itself stays stable over the whole berechnen() pass.
  // Only its internal sweep pointer advances for each row (see advance() below).
  //
  // cycleMetricsByIdx (precalculated for each cycle index, see GZ.segments.computeCycleSgMetrics
  // and computeCycleDetMetrics) feeds the per-cycle exprEngine primitives An, Ab, TF, RG, GE,
  // Ausgeloest and AnzahlAusloesungen.
  // cycleMetrics is the live value that the primitives read.
  // berechnen() moves it along through cyclePtr when it advances, like sweep.
  function buildObjectHandle(a, type, col, TU_MED) {
    if (type === 'SG') {
      const sgEntry = a.allStats.find(s => s.col.index === col.index);
      const segs = sgEntry ? sgEntry.segs : [];
      const greens = sgEntry ? sgEntry.stats.greens : [];
      // computeCycleSgMetrics now returns an array of occurrences for each cycle (see the header
      // comment there).
      // This is a result of the multiple-occurrence detection.
      // The row-by-row formula builder knows only ONE occurrence for each cycle, as before.
      // It uses the chronologically first occurrence on purpose.
      // The multiple detection applies only to Umlaufstatistiken for now (see
      // GZ.umlaufContext.buildAll()).
      const sgMetricsByIdx = computeCycleSgMetrics(segs, greens, a.cycleStarts, a.tMax, TU_MED).map(occs => occs[0] || null);
      return {
        class: 'SG', sweep: makePointSegmentSweep(segs), cycleMetrics: null,
        cycleMetricsByIdx: sgMetricsByIdx,
        // rawSample: for the WertBei() primitive (see exprEngine.js), for example WertBei(K2,
        // Ab(K1)).
        // It is the raw signal image of K2 at the time of the stop of K1.
        // It is not the categorized Zustand() at the CURRENT time.
        rawSample: makeRawValueSampler(a.times, a.seriesByCol.get(col.index)),
        // durationAt: for the DauerBei() primitive.
        // It is like Dauer(objekt), but for any time and not for the CURRENT time.
        durationAt: makeSegmentDurationSampler(segs)
      };
    }
    const segs = buildSegments(a.times, a.seriesByCol.get(col.index), categorizeDetRaw);
    const rawVals = a.seriesByCol.get(col.index);
    const occupied = a.times.map((_, k) => wzIstBelegt(rawVals[k]));
    // An, Ab, TF, RG and GE are universal (see the PRIMITIVES header comment in exprEngine.js).
    // A detector or value has, with BELEGT, exactly the same idea of an "active state" as a signal
    // group with GRUEN.
    // So the code uses the same computeCycleSgMetrics() basis (only the first occurrence for each
    // cycle, as for SG above).
    // It does not use its own calculation.
    // Ausgeloest and AnzahlAusloesungen stay own, cycle-wide aggregates (computeCycleDetMetrics).
    // The code merges both kinds of key figures here into ONE cycleMetrics object for each cycle.
    const belegtSegs = segs.filter(s => s.cat === 'BELEGT');
    const anAbByIdx = computeCycleSgMetrics(segs, belegtSegs, a.cycleStarts, a.tMax, TU_MED).map(occs => occs[0] || null);
    const aggByIdx = computeCycleDetMetrics(a.times, occupied, a.cycleStarts, a.tMax);
    const detMetricsByIdx = aggByIdx.map((agg, idx) => {
      const anab = anAbByIdx[idx];
      return {
        an: anab ? anab.an : NaN, ab: anab ? anab.ab : NaN, tf: anab ? anab.tf : NaN,
        rotgelb: anab ? anab.rotgelb : 0, gelb: anab ? anab.gelb : 0,
        segIdx: anab ? anab.segIdx : null, segStart: anab ? anab.segStart : null, segEnd: anab ? anab.segEnd : null,
        triggered: agg.triggered, count: agg.count
      };
    });
    return {
      class: 'DET', sweep: makePointSegmentSweep(segs), cycleMetrics: null,
      cycleMetricsByIdx: detMetricsByIdx,
      // rawSample: for the WertBei() primitive (see exprEngine.js).
      // Unlike cycleMetrics, it stays unchanged over the whole berechnen() pass.
      // It does not need to advance for each row, because sample() itself resolves any time with a
      // binary search.
      rawSample: makeRawValueSampler(a.times, rawVals),
      // durationAt: for the DauerBei() primitive.
      // An example is "how long was this detector already occupied at the time of the stop of K1".
      durationAt: makeSegmentDurationSampler(segs)
    };
  }

  // Evaluates ALL formulas that are valid at this time over the whole recording (one boolean raw
  // series for each TX).
  // It replaces syntheticCols completely.
  // This happens only here and not while the user types (see validateFormulaRow above).
  function berechnen() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const { times, seriesByCol, cycleStarts } = a;
    const { types, aliasErrors } = currentVarTypes();
    const { defs: funcDefs, errors: funcErrors } = currentFuncDefs();
    const cols = sourceCols();

    if (aliasErrors.length || funcErrors.length) {
      const desc = [...aliasErrors, ...funcErrors].join('; ');
      els.hint.textContent = desc + ' – bitte zuerst beheben.';
      els.hint.className = 'hint warn';
      if (GZ.snackbar) GZ.snackbar.show('Formeln können nicht berechnet werden', { type: 'error', description: desc });
      return;
    }

    // Once globally (not for each variable).
    // It is the basis of the per-cycle primitives An, Ab, TF, RG and GE AND of the TU_MED
    // identifier in the scope below.
    const TU_MED = computeGlobalTU(cycleStarts);

    const scopeSpecs = vars.map(v => {
      const alias = v.alias.trim();
      const col = cols.find(c => c.index === v.colIndex);
      const type = col ? varTypeForCol(col) : 'NUM';
      if (type === 'SG' || type === 'DET') return { alias, type, handle: buildObjectHandle(a, type, col, TU_MED) };
      return { alias, type, series: col ? seriesByCol.get(col.index) : null };
    }).filter(s => s.alias);

    // TX = seconds since the cycle start of the current cycle.
    // The code uses a continuous pointer over cycleStarts (as everywhere else in the code).
    // It does not use a binary search for each row.
    // The cost is amortized O(n) over the whole recording.
    // It serves the primitives Zustand, Dauer and DauerSeit in a purely declarative way (see the
    // header comment of exprEngine.js).
    // The real evaluation time runs through the object handle of each object
    // (handle.sweep.advance() below) and not through TX.
    // TU, TU_MED and SPL add the vocabulary that is relevant for the per-cycle primitives.
    // They are the current cycle duration, the median cycle time and the active signal program.
    // They are the same identifiers as in Umlaufstatistiken.
    const varTypesWithTx = { ...types, TX: 'NUM', TU: 'NUM', TU_MED: 'NUM', SPL: 'TEXT' };

    // ---------- 1) Kompilieren (rein syntaktisch/typgeprüft) ----------
    const byId = new Map(formulas.map(f => [f.id, f]));
    const nameToId = new Map(formulas.map(f => [f.name.trim(), f.id]).filter(([n]) => n));
    const compiledById = new Map();
    const skipReasonById = new Map(); // id -> message (compile error OR dependency or cycle problem)
    formulas.forEach(f => {
      const compiled = compile(f.exprText, varTypesWithTx, funcDefs);
      if (compiled.ok) compiledById.set(f.id, compiled);
      else skipReasonById.set(f.id, compiled.message);
    });

    // ---------- 2) Abhängigkeiten ermitteln ----------
    // Which OTHER formula names does this formula reference as a plain identifier (not a function
    // call)?
    // The code finds this with the same tokenizer as the real parsing (not with a regex).
    // So it finds reliably ONLY real identifier occurrences.
    // It never finds, for example, the same name inside a text literal.
    const depsById = new Map();
    compiledById.forEach((_, id) => {
      const f = byId.get(id);
      const deps = new Set();
      const tokens = GZ.exprEngine.tokenize(f.exprText);
      tokens.forEach((tok, idx) => {
        if (tok.type !== 'IDENT') return;
        if (tokens[idx + 1] && tokens[idx + 1].type === '(') return; // function call, not a formula reference
        const depId = nameToId.get(tok.value);
        // This has NO "depId !== id" exclusion on purpose.
        // A self-reference (a formula references its own name directly) must be visible in the
        // graph as a cycle with one node.
        // Otherwise visit() below never finds it.
        // visit() finds a cycle when it meets a node again that has the state "in progress".
        // Without this edge, the formula has no dependencies.
        // Then the code calculates it wrongly (with its own scope value, which is not yet defined
        // at this time) and not as a recognizable cycle.
        if (depId != null) deps.add(depId);
      });
      depsById.set(id, deps);
    });

    // ---------- 3) Topologisch ordnen + Zyklen erkennen ----------
    // This is a classic DFS with 3 states (0 not visited, 1 in progress, 2 finished).
    // A jump back to a node WITH state 1 is a cycle.
    // All nodes from the start of the cycle to the end of the stack are part of it.
    // The code skips all of them completely (not only the node that it visited last).
    const order = [], resolved = new Set(), cyclic = new Set(), state = new Map();
    function visit(id, stack) {
      if (state.get(id) === 2) return resolved.has(id);
      if (state.get(id) === 1) {
        const cycleStart = stack.indexOf(id);
        for (let k = cycleStart; k < stack.length; k++) cyclic.add(stack[k]);
        return false;
      }
      if (!compiledById.has(id)) { state.set(id, 2); return false; }
      state.set(id, 1);
      stack.push(id);
      let ok = true;
      depsById.get(id).forEach(depId => { if (!visit(depId, stack)) ok = false; });
      stack.pop();
      state.set(id, 2);
      if (ok && !cyclic.has(id)) { resolved.add(id); order.push(id); return true; }
      return false;
    }
    formulas.forEach(f => { if (compiledById.has(f.id) && !state.has(f.id)) visit(f.id, []); });

    formulas.forEach(f => {
      if (resolved.has(f.id) || skipReasonById.has(f.id)) return;
      if (cyclic.has(f.id)) {
        skipReasonById.set(f.id, `Zyklische Formel-Referenz (Kreislauf über "${f.name.trim()}")`);
      } else {
        const badId = [...(depsById.get(f.id) || [])].find(depId => !resolved.has(depId));
        const badName = badId != null ? (byId.get(badId).name.trim() || `F${badId}`) : '?';
        skipReasonById.set(f.id, `Hängt von ungültiger/nicht berechenbarer Formel "${badName}" ab`);
      }
    });

    // ---------- 4) In Abhängigkeitsreihenfolge auswerten ----------
    // Each formula that is already finished is available as a BOOL value in the scope to the next
    // formulas that reference it.
    // It is the same raw series that also feeds the synthetic FORMEL column.
    const rawSeriesById = new Map();
    order.forEach(id => {
      const f = byId.get(id);
      const compiled = compiledById.get(id);
      const deps = depsById.get(id);
      // scopeSpecs (and with them the object handles and sweeps) are the same instances over ALL
      // formulas.
      // The code builds them once before the loop (see above).
      // So the code must reset their sweeps before each new formula pass.
      // Otherwise the pointer from the previous pass stays at the end of the time series.
      // Then each formula that uses a specific variable, EXCEPT the first one, wrongly gives "no
      // segment" (Zustand, Dauer and DauerSeit -> 0 or null) for the whole recording.
      scopeSpecs.forEach(s => { if (s.handle) s.handle.sweep.reset(); });
      const rawSeries = new Array(times.length);
      let cyclePtr = 0;
      for (let i = 0; i < times.length; i++) {
        const t = times[i];
        while (cyclePtr + 1 < cycleStarts.length && cycleStarts[cyclePtr + 1] <= t) cyclePtr++;
        const txSeconds = cycleStarts.length ? Math.round((t - cycleStarts[cyclePtr]) / 1000) : 0;
        const cycleEnd = cyclePtr + 1 < cycleStarts.length ? cycleStarts[cyclePtr + 1] : a.tMax;
        const tuSeconds = cycleStarts.length ? Math.round((cycleEnd - cycleStarts[cyclePtr]) / 1000) : NaN;

        // __cycleStart: see GZ.umlaufContext.buildAll().
        // It is the same internal convention that user formulas cannot reference.
        // Here the code updates it for each row to the start of the current cycle (cyclePtr).
        const scope = { TX: txSeconds, TU: tuSeconds, TU_MED: TU_MED == null ? NaN : TU_MED, SPL: a.splValues ? (a.splValues[i] || '') : '', __cycleStart: cycleStarts.length ? cycleStarts[cyclePtr] : NaN };
        scopeSpecs.forEach(s => {
          if (s.handle) {
            s.handle.sweep.advance(t);
            s.handle.cycleMetrics = s.handle.cycleMetricsByIdx[cyclePtr] || null;
            scope[s.alias] = s.handle;
            return;
          }
          const raw = s.series ? (s.series[i] || '') : '';
          scope[s.alias] = raw.trim() === '' ? NaN : Number(raw);
        });
        deps.forEach(depId => { scope[byId.get(depId).name.trim()] = rawSeriesById.get(depId)[i] === '1'; });
        rawSeries[i] = compiled.run(scope) ? '1' : '0';
      }
      rawSeriesById.set(id, rawSeries);
    });

    // ---------- 5) Ergebnis in ORIGINALER Reihenfolge zusammenstellen ----------
    // (Not in evaluation order.
    // The object list in umlaufpruefung.js must stay stable in the formula order that the user
    // created.)
    const computed = [];
    const skippedList = []; // {name, message} - for the hint line AND the snackbar
    formulas.forEach(f => {
      const name = f.name.trim() || `F${f.id}`;
      const rawSeries = rawSeriesById.get(f.id);
      if (!rawSeries) {
        f.rawSeries = null;
        skippedList.push({ name, message: skipReasonById.get(f.id) || 'Unbekannter Fehler' });
        return;
      }
      // For getFormulaHighlights().
      // The code stores the same raw series that also feeds the synthetic FORMEL column directly at
      // the formula itself.
      // It is cheap enough to translate it there into TRUE and FALSE intervals when needed.
      // So the code does not do this in advance here.
      f.rawSeries = rawSeries;
      computed.push({
        index: SYNTH_INDEX_BASE + f.id, kuerzel: 'FORMEL', name,
        beschreibung: f.exprText, rawSeries
      });
    });

    syntheticCols = computed;
    const skipped = skippedList.length;
    els.hint.textContent = formulas.length
      ? `${computed.length} von ${formulas.length} Formel(n) berechnet` + (skipped ? `, ${skipped} übersprungen (ungültig)` : '') + '.'
      : 'Keine Formeln definiert.';
    els.hint.className = 'hint' + (skipped ? ' warn' : '');
    if (skipped && GZ.snackbar) {
      GZ.snackbar.show(`${skipped} Formel(n) übersprungen (ungültig)`, {
        type: 'warning',
        description: skippedList.map(s => `${s.name}: ${s.message}`).join(' · ')
      });
    }

    if (GZ.views.umlaufpruefung) GZ.views.umlaufpruefung.refreshSyntheticColumns();
  }

  // Read access for umlaufpruefung.js.
  // It returns the synthetic columns that the code calculated last.
  // The result is empty as long as the user has not clicked "Berechnen", and after a new data
  // import (see populateControls()).
  function getSyntheticColumns() { return syntheticCols; }

  // Read access for umlaufpruefung.js.
  // For each formula with a highlight target, it returns the TRUE intervals (from the same raw
  // series as the synthetic FORMEL column, see berechnen()).
  // It also returns the target column (short name and name, NOT raw index, see the header comment
  // below) and the assigned color.
  // The result is empty as long as the user has not clicked "Berechnen" (no f.rawSeries) or no
  // target is selected.
  //
  // IMPORTANT: the code identifies the target by short name and name and not by raw index.
  // For signal groups, sourceCols() returns the RAW CSV column index (col.index from parser.js).
  // umlaufpruefung.js indexes its own SG objects by the POSITION in the allStats array instead (see
  // allObjects() there).
  // The two counts are the same only by chance.
  // This happens when no other column is before the first signal group in the CSV.
  // Short name and name are the only identifier that is stable between the two files.
  // The pattern is the same as for vars and getConfig() above.
  function getFormulaHighlights() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return [];
    const cols = sourceCols();
    return formulas
      .filter(f => f.highlightCol != null && f.rawSeries && f.rawSeries.length === a.times.length)
      .map(f => {
        const col = cols.find(c => c.index === f.highlightCol);
        if (!col) return null;
        const intervals = buildSegments(a.times, f.rawSeries, v => v === '1' ? 'WAHR' : 'FALSCH')
          .filter(s => s.cat === 'WAHR');
        if (!intervals.length) return null;
        return {
          formulaId: f.id, name: f.name.trim() || `F${f.id}`,
          colKuerzel: col.kuerzel, colName: col.name,
          color: formulaColorFor(f), intervals
        };
      })
      .filter(Boolean);
  }

  // For saving and loading the configuration (see umlaufpruefung.js).
  // The code references columns by short name and name and not by raw index (see GZ.configIO).
  // It stays valid over new exports of the same intersection.
  function getConfig() {
    const cols = sourceCols();
    return {
      vars: vars.map(v => {
        const col = cols.find(c => c.index === v.colIndex);
        return { alias: v.alias, colKuerzel: col ? col.kuerzel : null, colName: col ? col.name : null };
      }),
      // Functions have no column reference (see the file header comment).
      // Save params as a copy and not as the live reference.
      funcs: funcs.map(f => ({ name: f.name, params: f.params.slice(), bodyText: f.bodyText })),
      formulas: formulas.map(f => {
        const col = cols.find(c => c.index === f.highlightCol);
        return {
          name: f.name, exprText: f.exprText,
          highlightColKuerzel: col ? col.kuerzel : null, highlightColName: col ? col.name : null
        };
      })
    };
  }

  // Sets variables, functions and formulas from a loaded configuration and calculates immediately.
  // So umlaufpruefung.js can then select the FORMEL columns that now exist by name in its own
  // applyConfig() (see the call order there).
  // The code skips columns that do not exist (any more) in the CSV that is loaded at this time and
  // reports them.
  // It does not stop the rest of the configuration.
  // This does not affect functions.
  // They have no column reference and the code can always take them over completely.
  function applyConfig(cfg) {
    if (!cfg) return { skipped: [] };
    const cols = sourceCols();
    const skipped = [];
    vars = (cfg.vars || []).map(v => {
      const col = cols.find(c => c.kuerzel === v.colKuerzel && c.name === v.colName);
      if (!col) skipped.push(`Variable „${v.alias}“ (Spalte „${v.colName}“ nicht gefunden)`);
      return { id: nextVarId++, alias: v.alias, colIndex: col ? col.index : (cols.length ? cols[0].index : null) };
    });
    funcs = (cfg.funcs || []).map(f => ({ id: nextFuncId++, name: f.name, params: (f.params || []).slice(), bodyText: f.bodyText || '' }));
    formulas = (cfg.formulas || []).map(f => {
      let highlightCol = null;
      if (f.highlightColKuerzel && f.highlightColName) {
        const col = cols.find(c => c.kuerzel === f.highlightColKuerzel && c.name === f.highlightColName);
        // silently with no highlight, but no skip entry (purely visual, not critical)
        highlightCol = col ? col.index : null;
      }
      return { id: nextFormulaId++, name: f.name, exprText: f.exprText, highlightCol, rawSeries: null };
    });
    renderVarRows();
    renderFuncRows();
    renderFormulaRows();
    berechnen();
    return { skipped };
  }

  GZ.views = GZ.views || {};
  GZ.views.formulaBuilder = { init, populateControls, getSyntheticColumns, getFormulaHighlights, getConfig, applyConfig };
})(window.GZ = window.GZ || {});
