/* GZ.views.formulaBuilder — Tab "Umlaufprüfung": Formel-Builder für
   synthetische Detektoren. Variablen sind Aliase auf bestehende Signalgruppen-
   (SG), Detektor- (DET) bzw. APW-/ÖPNV-Spalten. SG/DET sind Objekt-Handles
   (siehe GZ.exprEngine): kein direkter WAHR/FALSCH-Wert mehr, sondern über
   die Primitiven Zustand/Dauer/DauerSeit auszuwerten (z.B. "Zustand(D1)
   == BELEGT" statt früher bloß "D1"). APW/ÖPNV bleiben Zahl (roher Wert).
   Der aktuelle Auswertungszeitpunkt (früher als explizites TX-Argument
   mitgegeben) ist jetzt vollständig implizit - keine Primitive verlangt
   TX mehr als Argument, TX bleibt aber als normale NUM-Variable im scope
   verfügbar (für eigene, fortgeschrittene Bedingungen in Funktionsrümpfen).

   Funktionen sind benutzerdefinierte, parametrisierte Ausdrücke aus den
   Primitiven (z.B. "LangGenug(sg, schwelle) := DauerSeit(sg, GRUEN) >
   schwelle"), aufrufbar aus Formeln (oder anderen Funktionen) mit konkreten
   Argumenten ("LangGenug(K1, 30)"). Parameter sind generisch (kein fester
   SG/DET/NUM-Typ in der Definition) - jeder Aufruf spezialisiert den Rumpf
   neu mit den tatsächlichen Argumenttypen (siehe GZ.exprEngine.compile()/
   compileFunctionDef()). Funktionen selbst haben KEINEN Spaltenbezug (nur
   Formeln/Variablen haben den) und sind daher 1:1 über Konfigurationen
   hinweg portabel.

   Formeln kombinieren alles über +,-,*,/,Vergleiche,AND/OR/NOT/Klammern und
   Funktionsaufrufe und müssen zu WAHR/FALSCH auswerten. Tippen validiert nur
   (Syntax/Typen, keine Datenauswertung) - erst "Berechnen" wertet über alle
   TX aus und liefert je gültiger Formel eine boolesche Rohreihe, die
   umlaufpruefung.js über getSyntheticColumns() als zusätzliche, farblich
   abgesetzte Detektor-Spalte (Kürzel FORMEL) einbindet. */
(function (GZ) {
  'use strict';
  const { esc } = GZ.format;
  const { buildSegments, makePointSegmentSweep } = GZ.segments;
  const { categorizeDetRaw } = GZ.parser;
  const { compile, compileFunctionDef } = GZ.exprEngine;

  const SYNTH_INDEX_BASE = 1000000; // weit jenseits jedes realen Spaltenindex

  let els = null;
  let vars = []; // {id, alias, colIndex}
  let funcs = []; // {id, name, params:string[], bodyText}
  let formulas = []; // {id, name, exprText}
  let nextVarId = 1, nextFuncId = 1, nextFormulaId = 1;
  let syntheticCols = []; // [{index, kuerzel:'FORMEL', name, beschreibung, rawSeries}]
  let debounceTimers = new Map(); // "<kind>:<id>" -> timeout handle

  // Case-insensitive (AND/OR/NOT, wie im Tokenizer) bzw. exakt (TX und die
  // Zustands-/Funktionsnamen, ebenfalls exakt wie im Tokenizer/PRIMITIVES von
  // GZ.exprEngine) reservierte Wörter - als Alias verboten, sonst wäre die
  // Variable in Formeln unerreichbar (der Tokenizer erkennt z.B. "GRUEN"
  // immer als Zustands-Literal, unabhängig davon, was in varTypes steht).
  const RESERVED_CI = new Set(['AND', 'OR', 'NOT']);
  const RESERVED_EXACT = new Set(['TX', 'GRUEN', 'ROT', 'GELB', 'ROTGELB', 'DUNKEL', 'BELEGT', 'FREI', 'Zustand', 'Dauer', 'DauerSeit']);
  const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const isReserved = alias => RESERVED_CI.has(alias.toUpperCase()) || RESERVED_EXACT.has(alias);

  // ---------- Ausdrucks-Editor: Syntax-Highlighting / Fehler-Markierung /
  // Autovervollständigung / Funktions-Palette für .up-func-body und .up-
  // formula-expr - reine UI-"Eye Candy", keine eigene Parsing-Logik: nutzt
  // GZ.exprEngine.tokenize() (denselben Lexer wie compile()) für die
  // Einfärbung, damit Highlighting und tatsächliches Parsen nie ausein-
  // anderlaufen. Technik: ein unsichtbarer <input> (color:transparent,
  // sichtbarer Cursor) liegt über einem <div>, das denselben Text farbig
  // gerendert anzeigt ("Overlay"-Trick, siehe .expr-input-wrap/.expr-
  // highlight in components.css).
  function classifyToken(tok, nextTok) {
    switch (tok.type) {
      case 'NUMBER': return 'expr-tok-num';
      case 'KATLIT': return 'expr-tok-kat';
      case 'AND': case 'OR': case 'NOT': return 'expr-tok-kw';
      // TX ist reserviert (siehe RESERVED_EXACT/isTxCol) - wie AND/OR/NOT
      // eingefärbt statt wie eine normale Variable, damit optisch klar
      // bleibt, dass es nichts ist, was man selbst benennen/zuweisen muss.
      case 'IDENT':
        if (tok.value === 'TX') return 'expr-tok-kw';
        return (nextTok && nextTok.type === '(') ? 'expr-tok-func' : 'expr-tok-var';
      case '+': case '-': case '*': case '/': case '>': case '<': case '>=': case '<=': case '==': case '!=':
        return 'expr-tok-op';
      case '(': case ')': case ',': return 'expr-tok-punc';
      default: return '';
    }
  }

  // errPos: Zeichenposition eines aktuellen Validierungsfehlers (siehe
  // GZ.exprEngine compile()/compileFunctionDef() Rückgabe .pos) oder null -
  // markiert das betroffene Token mit einer roten Wellenlinie (.expr-tok-
  // err). Bei Tokenizer-Fehlern (unbekanntes Zeichen) wird der Rest des
  // Textes ab der Fehlerstelle unstrukturiert markiert.
  function renderExprHighlight(text, errPos) {
    if (!text) return '';
    let tokens;
    try {
      tokens = GZ.exprEngine.tokenize(text);
    } catch (e) {
      const failPos = (e && typeof e.pos === 'number') ? e.pos : 0;
      return `${esc(text.slice(0, failPos))}<span class="expr-tok-err">${esc(text.slice(failPos))}</span>`;
    }
    let html = '';
    let cursor = 0;
    let markedErr = false;
    tokens.forEach((tok, idx) => {
      if (tok.type === 'EOF') return;
      if (tok.pos > cursor) html += esc(text.slice(cursor, tok.pos));
      const cls = classifyToken(tok, tokens[idx + 1]);
      const isErr = errPos != null && tok.pos === errPos;
      if (isErr) markedErr = true;
      html += `<span class="${cls}${isErr ? ' expr-tok-err' : ''}">${esc(text.slice(tok.pos, tok.end))}</span>`;
      cursor = tok.end;
    });
    if (cursor < text.length) html += esc(text.slice(cursor));
    if (errPos != null && !markedErr) html += '<span class="expr-tok-err expr-tok-err-eof">&nbsp;</span>';
    return html;
  }

  // Kandidaten für Autovervollständigung + Funktions-Palette: Primitiven
  // (GZ.exprEngine.PRIMITIVE_INFO), aktuell definierte Funktionen/Variablen
  // (Modul-State), Zustands-Konstanten (GZ.exprEngine.KAT_TOKENS), TX,
  // AND/OR/NOT. insertText/selStart/selEnd beschreiben, was beim Einfügen an
  // der Cursorposition eingesetzt wird und welcher Teilbereich davon
  // anschließend als Platzhalter selektiert wird, damit man ihn direkt
  // überschreiben kann (z.B. "Zustand(objekt)" mit "objekt" selektiert). TX
  // wird bewusst NICHT in die eingefügten Primitiven-/Funktionsaufrufe
  // aufgenommen (siehe GZ.exprEngine PRIMITIVE_INFO) - es bleibt implizit.
  function exprCandidates() {
    const items = [];
    GZ.exprEngine.PRIMITIVE_INFO.forEach(p => {
      const argList = p.params.join(', ');
      items.push({
        group: 'Primitiven', label: p.name, hint: `(${argList})`, desc: p.desc,
        insertText: `${p.name}(${argList})`,
        selStart: p.name.length + 1, selEnd: p.name.length + 1 + p.params[0].length
      });
    });
    funcs.forEach(f => {
      const name = f.name.trim();
      if (!name) return;
      const params = f.params.map(p => p.trim()).filter(Boolean);
      const argList = params.join(', ');
      items.push({
        group: 'Eigene Funktionen', label: name, hint: `(${argList})`, desc: f.bodyText,
        insertText: `${name}(${argList})`,
        selStart: name.length + 1, selEnd: name.length + 1 + (params[0] ? params[0].length : 0)
      });
    });
    Object.entries(GZ.exprEngine.KAT_TOKENS).forEach(([tok, katType]) => {
      const group = katType === 'KAT_SG' ? 'Zustände (Signalgruppe)' : 'Zustände (Detektor)';
      items.push({ group, label: tok, hint: '', desc: '', insertText: tok, selStart: tok.length, selEnd: tok.length });
    });
    items.push({ group: 'Sonstiges', label: 'TX', hint: 'reserviert', desc: 'aktueller Auswertungszeitpunkt - immer automatisch verfügbar, nicht selbst benennen/zuweisen', insertText: 'TX', selStart: 2, selEnd: 2 });
    ['AND', 'OR', 'NOT'].forEach(kw => {
      items.push({ group: 'Verknüpfung', label: kw, hint: '', desc: '', insertText: kw, selStart: kw.length, selEnd: kw.length });
    });
    vars.forEach(v => {
      const alias = v.alias.trim();
      if (!alias) return;
      items.push({ group: 'Variablen', label: alias, hint: '', desc: '', insertText: alias, selStart: alias.length, selEnd: alias.length });
    });
    // Rohe Signalgruppen-/Detektor-/APW-/ÖPNV-Spalten - auch OHNE dass dafür
    // schon eine Variable existiert. Auswahl legt bei Bedarf (siehe accept()
    // in setupExprEditor()) automatisch eine passende Variable an, statt das
    // vorher manuell im Abschnitt "Variablen" verlangen zu müssen.
    sourceCols().forEach(col => {
      const existing = vars.find(v => v.colIndex === col.index);
      items.push({
        group: 'Objekte (Spalten)', label: col.name,
        hint: existing && existing.alias.trim() ? `${col.kuerzel} · Variable „${existing.alias.trim()}“` : `${col.kuerzel} · neue Variable`,
        desc: col.beschreibung || `${col.kuerzel} ${col.name}`,
        isObject: true, col
      });
    });
    return items;
  }

  // Verdrahtet Syntax-Highlighting, Fehler-Markierung, Autovervollständigung
  // (beim Tippen, gefiltert nach Bezeichner-Präfix) und die Funktions-
  // Palette (Button "ƒ", ungefiltert) für EIN Ausdrucks-Eingabefeld. Wird pro
  // Zeile bei jedem Render neu aufgerufen, da renderFuncRows()/render
  // FormulaRows() das komplette innerHTML (und damit alle DOM-Knoten) neu
  // aufbauen. Hängt refreshHighlight als wrap.__exprRefreshHighlight an, das
  // validateAllInline()/validateFormulaRow() nutzen, um nach einer
  // (debounced) Validierung die Fehlerposition nachträglich einzuzeichnen.
  function setupExprEditor(rowEl) {
    const wrap = rowEl.querySelector('.expr-input-wrap');
    if (!wrap) return;
    const input = wrap.querySelector('.expr-input');
    const hl = wrap.querySelector('.expr-highlight');
    const dropdown = wrap.querySelector('.expr-autocomplete');
    const paletteBtn = wrap.querySelector('.expr-palette-btn');

    const syncScroll = () => { hl.scrollLeft = input.scrollLeft; };
    const refreshHighlight = errPos => { hl.innerHTML = renderExprHighlight(input.value, errPos == null ? null : errPos); syncScroll(); };
    wrap.__exprRefreshHighlight = refreshHighlight;

    const closeDropdown = () => { dropdown.hidden = true; dropdown.innerHTML = ''; };

    const currentPrefix = () => {
      const val = input.value, caret = input.selectionStart;
      let start = caret;
      while (start > 0 && /[A-Za-z0-9_]/.test(val[start - 1])) start--;
      return { start, end: caret, text: val.slice(start, caret) };
    };

    const renderDropdown = (items, start, end) => {
      if (!items.length) { closeDropdown(); return; }
      let html = '', lastGroup = null;
      items.forEach((it, i) => {
        if (it.group !== lastGroup) { html += `<div class="expr-ac-group">${esc(it.group)}</div>`; lastGroup = it.group; }
        html += `<div class="expr-ac-item" data-idx="${i}" title="${esc(it.desc || '')}">
          <span class="expr-ac-label">${esc(it.label)}</span>
          <span class="expr-ac-hint">${esc(it.hint || '')}</span>
        </div>`;
      });
      dropdown.innerHTML = html;
      dropdown.hidden = false;
      dropdown.dataset.activeIdx = '-1';
      dropdown._items = items; dropdown._start = start; dropdown._end = end;
      dropdown.querySelectorAll('.expr-ac-item').forEach(el => {
        el.onmousedown = ev => { ev.preventDefault(); accept(items[Number(el.dataset.idx)], start, end); };
      });
    };

    const updateAutocomplete = () => {
      const { start, end, text } = currentPrefix();
      if (!text) { closeDropdown(); return; }
      const items = exprCandidates().filter(c => c.label.toUpperCase().startsWith(text.toUpperCase()));
      renderDropdown(items, start, end);
    };

    const openPalette = () => {
      input.focus();
      const caret = input.selectionStart;
      renderDropdown(exprCandidates(), caret, caret);
    };

    const moveActive = delta => {
      const optEls = Array.from(dropdown.querySelectorAll('.expr-ac-item'));
      if (!optEls.length) return;
      let idx = Number(dropdown.dataset.activeIdx || '-1') + delta;
      if (idx < 0) idx = optEls.length - 1;
      if (idx >= optEls.length) idx = 0;
      optEls.forEach(e => e.classList.remove('active'));
      optEls[idx].classList.add('active');
      optEls[idx].scrollIntoView({ block: 'nearest' });
      dropdown.dataset.activeIdx = String(idx);
    };

    const acceptActiveOrFirst = () => {
      if (dropdown.hidden) return false;
      const idx = Number(dropdown.dataset.activeIdx || '-1');
      const items = dropdown._items || [];
      const chosen = items[idx >= 0 ? idx : 0];
      if (!chosen) return false;
      accept(chosen, dropdown._start, dropdown._end);
      return true;
    };

    function accept(item, start, end) {
      // Objekt-Kandidat (Spalte statt Primitive/Funktion/Zustand/Variable):
      // erst Alias auflösen/anlegen (siehe resolveOrCreateVarForCol()), dann
      // wie eine normale Variable einfügen (reiner Bezeichner, ohne Klammern
      // /Platzhalter-Selektion).
      let insertText = item.insertText, selStart = item.selStart, selEnd = item.selEnd;
      if (item.isObject) {
        const alias = resolveOrCreateVarForCol(item.col);
        insertText = alias;
        selStart = alias.length;
        selEnd = alias.length;
      }
      const val = input.value;
      input.value = val.slice(0, start) + insertText + val.slice(end);
      const absSelStart = start + selStart, absSelEnd = start + selEnd;
      closeDropdown();
      input.focus();
      input.setSelectionRange(absSelStart, absSelEnd);
      input.dataset.suppressAc = '1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    input.addEventListener('input', () => {
      refreshHighlight(null);
      if (input.dataset.suppressAc) { delete input.dataset.suppressAc; return; }
      updateAutocomplete();
    });
    input.addEventListener('scroll', syncScroll);
    input.addEventListener('click', () => { syncScroll(); closeDropdown(); });
    input.addEventListener('keydown', e => {
      if (dropdown.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
      else if (e.key === 'Enter' || e.key === 'Tab') { if (acceptActiveOrFirst()) e.preventDefault(); }
      else if (e.key === 'Escape') { closeDropdown(); }
    });
    input.addEventListener('blur', () => setTimeout(closeDropdown, 150));
    if (paletteBtn) {
      // preventDefault auf mousedown verhindert, dass der Button dem Input
      // den Fokus entzieht - sonst würde der oben registrierte blur-Handler
      // die gerade per openPalette() geöffnete Liste ~150ms später wieder
      // zumachen (Fokus wäre kurz weg- und wieder hergesprungen).
      paletteBtn.addEventListener('mousedown', e => e.preventDefault());
      paletteBtn.onclick = openPalette;
    }

    refreshHighlight(null);
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
      helpClose: root.querySelector('#upFormulaHelpClose')
    };
    els.addVarBtn.onclick = () => { addVar(); renderVarRows(); };
    els.addFuncBtn.onclick = () => { addFunc(); renderFuncRows(); };
    els.addFormulaBtn.onclick = () => { addFormula(); renderFormulaRows(); };
    els.calcBtn.onclick = berechnen;

    if (els.helpBtn && els.helpModal) {
      const closeHelp = () => { els.helpModal.hidden = true; };
      els.helpBtn.onclick = () => { els.helpModal.hidden = false; };
      if (els.helpClose) els.helpClose.onclick = closeHelp;
      els.helpModal.addEventListener('click', e => { if (e.target === els.helpModal) closeHelp(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && !els.helpModal.hidden) closeHelp(); });
    }
  }

  // Quellspalten für Variablen: Signalgruppen (SG) und Detektoren (DET) als
  // Objekt-Handles, APW/ÖPNV als Zahl. Bewusst OHNE bereits berechnete
  // Formel-Spalten selbst (keine Formeln-referenzieren-Formeln-Verkettung -
  // hält Auswertungsreihenfolge und Zyklen-Vermeidung trivial).
  // TX ist der reservierte, immer implizit verfügbare Auswertungszeitpunkt
  // (siehe RESERVED_EXACT/GZ.exprEngine) - niemals eine normale Spalte, die
  // man als Variable/Objekt auswählen oder zuordnen müsste. Der Filter ist
  // ein Sicherheitsnetz (case-insensitiv, unabhängig von kuerzel): sollte
  // eine Roh-CSV ausnahmsweise doch eine Spalte namens "TX" unter SG/DET/
  // APW/ÖPNV führen, darf sie hier nie auftauchen - sonst könnte man ihr
  // versehentlich eine Variable zuordnen bzw. sie im Ausdrucks-Editor als
  // "Objekt" auswählen, was mit dem echten, reservierten TX kollidieren
  // würde.
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

  // Wandelt einen beliebigen Spaltennamen in einen gültigen, noch nicht
  // vergebenen Bezeichner um (Basis für "Objekt aus dem Dropdown wählen" -
  // siehe exprCandidates()/resolveOrCreateVarForCol() unten). Spaltennamen
  // aus der OCIT-Kopfzeile sind i.d.R. bereits kurz und identifiergleich
  // (z.B. "K1", "D1") - die Bereinigung ist nur ein Sicherheitsnetz für
  // Ausnahmefälle (Leerzeichen, führende Ziffer, Duplikate).
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

  // Liefert den Alias einer bereits existierenden Variable für diese Spalte,
  // oder legt (bei Auswahl eines "Objekts" aus dem Ausdrucks-Editor-Dropdown,
  // siehe exprCandidates()/setupExprEditor() unten) still eine neue an - so
  // muss man beim Formulieren einer Formel nicht erst manuell im Abschnitt
  // "Variablen" eine Zeile anlegen. Rendert die Variablen-Liste neu, damit
  // die neue/wiederverwendete Zuordnung dort sichtbar ist.
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
    formulas.push({ id: nextFormulaId++, name: `F${nextFormulaId - 1}`, exprText: '' });
  }

  function populateControls() {
    const cols = sourceCols();
    // Nach neuem Datenimport: Spaltenverweise, die es nicht mehr gibt (andere
    // Datei/Spaltenlayout), auf die erste verfügbare Quellspalte zurücksetzen
    // statt auf eine ungültige Spalte zu verweisen. Funktionen haben keinen
    // Spaltenbezug (siehe Datei-Kopfkommentar) und bleiben unverändert.
    vars.forEach(v => { if (!cols.find(c => c.index === v.colIndex)) v.colIndex = cols.length ? cols[0].index : null; });
    syntheticCols = [];
    renderVarRows();
    renderFuncRows();
    renderFormulaRows();
    els.hint.textContent = '';
    els.hint.className = 'hint';
  }

  // Baut die Funktionstabelle für GZ.exprEngine (Form { [name]: {params,
  // exprText} }) aus allen STRUKTURELL gültigen Funktionsdefinitionen
  // (gültiger, eindeutiger Name; gültige, eindeutige Parameter) - bewusst
  // OHNE den Rumpf selbst hier zu validieren: eine Funktion mit defektem
  // Rumpf bleibt aufrufbar, der Fehler taucht dann erst (klar zugeordnet)
  // an der jeweiligen Aufrufstelle auf ("In Funktion „X“: …", siehe
  // GZ.exprEngine parseCall()) statt die gesamte Funktionstabelle wegen
  // einer einzelnen kaputten Definition zu verwerfen.
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
          <span class="expr-input-box">
            <div class="expr-highlight" aria-hidden="true"></div>
            <input type="text" class="up-func-body expr-input mono-input" value="${esc(f.bodyText)}" placeholder="Ausdruck, z.B. DauerSeit(sg, GRUEN) &gt; schwelle" autocomplete="off" spellcheck="false">
          </span>
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
      rowEl.querySelector('.up-func-body').oninput = e => { f.bodyText = e.target.value; debouncedRevalidate(id); };
      rowEl.querySelector('.up-func-remove').onclick = () => { funcs = funcs.filter(x => x.id !== id); renderFuncRows(); validateAllInline(); };
      setupExprEditor(rowEl);
    });
    validateAllInline();
  }

  function renderFormulaRows() {
    els.formulaRows.innerHTML = formulas.map(f => `
      <div class="up-formula-row" data-id="${f.id}">
        <input type="text" class="up-formula-name mono-input" value="${esc(f.name)}" placeholder="Name">
        <span class="expr-input-wrap">
          <span class="expr-input-box">
            <div class="expr-highlight" aria-hidden="true"></div>
            <input type="text" class="up-formula-expr expr-input mono-input" value="${esc(f.exprText)}" placeholder="z.B. DauerSeit(K1, GRUEN) &gt; 45 AND Zustand(D1) == BELEGT" autocomplete="off" spellcheck="false">
          </span>
          <button type="button" class="expr-palette-btn" title="Primitiven/Funktionen/Zustände einfügen">ƒ</button>
          <div class="expr-autocomplete" hidden></div>
        </span>
        <span class="up-formula-status"></span>
        <button type="button" class="oe-row-remove up-formula-remove">✕</button>
      </div>`).join('') || '<div class="cfg-empty">Keine Formeln definiert.</div>';

    els.formulaRows.querySelectorAll('.up-formula-row').forEach(rowEl => {
      const id = Number(rowEl.dataset.id);
      const f = formulas.find(x => x.id === id);
      rowEl.querySelector('.up-formula-name').oninput = e => { f.name = e.target.value; };
      rowEl.querySelector('.up-formula-expr').oninput = e => {
        f.exprText = e.target.value;
        clearTimeout(debounceTimers.get(`f:${id}`));
        debounceTimers.set(`f:${id}`, setTimeout(() => validateFormulaRow(rowEl, f), 150));
      };
      rowEl.querySelector('.up-formula-remove').onclick = () => { formulas = formulas.filter(x => x.id !== id); renderFormulaRows(); };
      setupExprEditor(rowEl);
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
    const { defs: funcDefs, errors: funcErrors } = currentFuncDefs();
    const wrap = rowEl.querySelector('.expr-input-wrap');
    const markHighlight = pos => { if (wrap && wrap.__exprRefreshHighlight) wrap.__exprRefreshHighlight(pos); };
    if (aliasErrors.length || funcErrors.length) {
      statusEl.textContent = '✕';
      statusEl.className = 'up-formula-status err';
      statusEl.title = [...aliasErrors, ...funcErrors].join('; ');
      markHighlight(null); // Fehler liegt in Alias-/Funktionsdefinitionen, nicht im Formel-Text selbst
      return;
    }
    const result = compile(f.exprText, { ...types, TX: 'NUM' }, funcDefs);
    if (result.ok) {
      statusEl.textContent = '✓';
      statusEl.className = 'up-formula-status ok';
      statusEl.title = 'Gültig';
      markHighlight(null);
    } else {
      statusEl.textContent = '✕';
      statusEl.className = 'up-formula-status err';
      statusEl.title = result.message;
      markHighlight(result.pos);
    }
  }

  // Revalidiert Funktionen, Formeln UND Variablen gemeinsam - eine Änderung
  // an EINER Variable/Funktion kann die Gültigkeit jeder Formel (und, bei
  // Funktionen, auch anderer Funktionen) beeinflussen, daher kein isoliertes
  // Neuprüfen nur der geänderten Zeile.
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
  }

  // Baut für eine SG-/DET-Variable EINMAL (nicht pro Zeile) ihre Segmente +
  // einen fortlaufenden Punkt-Sweep (GZ.segments.makePointSegmentSweep) - SG
  // nutzt die in allStats bereits vorberechneten Segmente, DET wird einmal
  // frisch gebaut (analog zu umlaufpruefung.js' detSegsByCol). Das Handle-
  // Objekt selbst bleibt über den gesamten Berechnen()-Durchlauf stabil; nur
  // sein interner Sweep-Zeiger rückt pro Zeile vor (siehe advance() unten).
  function buildObjectHandle(a, type, col) {
    if (type === 'SG') {
      const sgEntry = a.allStats.find(s => s.col.index === col.index);
      return { class: 'SG', sweep: makePointSegmentSweep(sgEntry ? sgEntry.segs : []) };
    }
    const segs = buildSegments(a.times, a.seriesByCol.get(col.index), categorizeDetRaw);
    return { class: 'DET', sweep: makePointSegmentSweep(segs) };
  }

  // Wertet ALLE aktuell gültigen Formeln über die gesamte Aufzeichnung aus
  // (eine boolesche Rohreihe je TX) und ersetzt syntheticCols vollständig -
  // erst hier, nicht während des Tippens (siehe validateFormulaRow oben).
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

    const scopeSpecs = vars.map(v => {
      const alias = v.alias.trim();
      const col = cols.find(c => c.index === v.colIndex);
      const type = col ? varTypeForCol(col) : 'NUM';
      if (type === 'SG' || type === 'DET') return { alias, type, handle: buildObjectHandle(a, type, col) };
      return { alias, type, series: col ? seriesByCol.get(col.index) : null };
    }).filter(s => s.alias);

    // TX = Sekunden seit Umlaufbeginn des aktuellen Zyklus, per fortlaufendem
    // Zeiger über cycleStarts (wie überall sonst im Code) statt Binärsuche
    // je Zeile - amortisiert O(n) über die gesamte Aufzeichnung. Dient den
    // Zustand/Dauer/DauerSeit-Primitiven rein deklarativ (siehe exprEngine.js
    // Kopfkommentar) - der eigentliche Auswertungszeitpunkt läuft über das
    // jeweilige Objekt-Handle (handle.sweep.advance() unten), nicht über TX.
    const varTypesWithTx = { ...types, TX: 'NUM' };

    const computed = [];
    const skippedList = []; // {name, message} - für Hint-Zeile UND Snackbar
    formulas.forEach(f => {
      const name = f.name.trim() || `F${f.id}`;
      const compiled = compile(f.exprText, varTypesWithTx, funcDefs);
      if (!compiled.ok) { skippedList.push({ name, message: compiled.message }); return; }
      const rawSeries = new Array(times.length);
      let cyclePtr = 0;
      for (let i = 0; i < times.length; i++) {
        const t = times[i];
        while (cyclePtr + 1 < cycleStarts.length && cycleStarts[cyclePtr + 1] <= t) cyclePtr++;
        const txSeconds = cycleStarts.length ? Math.round((t - cycleStarts[cyclePtr]) / 1000) : 0;

        const scope = { TX: txSeconds };
        scopeSpecs.forEach(s => {
          if (s.handle) { s.handle.sweep.advance(t); scope[s.alias] = s.handle; return; }
          const raw = s.series ? (s.series[i] || '') : '';
          scope[s.alias] = raw.trim() === '' ? NaN : Number(raw);
        });
        rawSeries[i] = compiled.run(scope) ? '1' : '0';
      }
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
      // Funktionen haben keinen Spaltenbezug (siehe Datei-Kopfkommentar) -
      // params als Kopie speichern, nicht die Live-Referenz.
      funcs: funcs.map(f => ({ name: f.name, params: f.params.slice(), bodyText: f.bodyText })),
      formulas: formulas.map(f => ({ name: f.name, exprText: f.exprText }))
    };
  }

  // Setzt Variablen/Funktionen/Formeln aus einer geladenen Konfiguration und
  // berechnet sofort (damit umlaufpruefung.js im Anschluss die dann
  // existierenden FORMEL-Spalten in seiner eigenen applyConfig() by-Name
  // auswählen kann - siehe dortige Aufrufreihenfolge). Spalten, die es in der
  // aktuell geladenen CSV nicht (mehr) gibt, werden übersprungen und gemeldet
  // statt die restliche Konfiguration abzubrechen - Funktionen betrifft das
  // nicht (kein Spaltenbezug, immer vollständig übernehmbar).
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
    formulas = (cfg.formulas || []).map(f => ({ id: nextFormulaId++, name: f.name, exprText: f.exprText }));
    renderVarRows();
    renderFuncRows();
    renderFormulaRows();
    berechnen();
    return { skipped };
  }

  GZ.views = GZ.views || {};
  GZ.views.formulaBuilder = { init, populateControls, getSyntheticColumns, getConfig, applyConfig };
})(window.GZ = window.GZ || {});
