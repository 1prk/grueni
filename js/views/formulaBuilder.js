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

  // ---------- Ausdrucks-Editor: echte, interaktive Chips (contenteditable)
  // statt gefärbtem Text - erkannte Symbole (Funktionsaufrufe, Zustände,
  // Variablen) werden als atomare, per "×"-Button entfernbare Chip-Elemente
  // gerendert (contenteditable="false"), alles andere (Zahlen, Operatoren,
  // Klammern, AND/OR/NOT, Werte, noch unbekannte/unfertige Bezeichner)
  // bleibt normal editierbarer, nur eingefärbter Text ("freier Text für
  // Werte etc."). Ersetzt den früheren "unsichtbarer <input> über farbigem
  // <div>"-Overlay-Trick vollständig - der hatte einen strukturellen Makel:
  // Text-Selektion wird von manchen Browsern trotz color:transparent
  // sichtbar gerendert und lag dann als zweite, überlappende Ebene über dem
  // Highlight darunter ("Offset"/"Hintergrundtext"-Effekt).
  //
  // Modell: Quelle der Wahrheit bleibt der reine Formeltext (f.bodyText/
  // f.exprText), GENAU wie vorher - der Editor wird bei jeder Änderung aus
  // diesem Text NEU gerendert (siehe refreshEditorContent()), nie umgekehrt.
  // Ein Token wird zum Chip, wenn es eindeutig einem bekannten Symbol
  // entspricht: Zustands-Literal (KATLIT, exakte Schreibweise), Funktions-
  // aufruf (IDENT unmittelbar gefolgt von "("), oder ein Bezeichner, der
  // exakt einer aktuell bekannten Variable (Formel-Zeilen) bzw. einem
  // Parameter der eigenen Funktion (Funktions-Zeilen) entspricht - siehe
  // knownNames-Parameter. Damit ein Bezeichner nicht MITTEN im Tippen schon
  // "einrastet" (z.B. "K1" während man eigentlich "K10" schreiben will),
  // wird das Token, das der Cursor GERADE berührt, von der Chip-Bildung
  // ausgenommen, solange das Feld fokussiert ist (siehe getCaretOffset()/
  // "touching"-Prüfung in buildEditorDom()) - erst nach Verlassen der
  // Stelle (oder beim Verlassen des Feldes) rastet es als Chip ein. Chips
  // aus Dropdown/Palette/Sidebar (siehe accept() weiter unten) entstehen
  // dagegen SOFORT, unabhängig von der Cursorposition - das ist eine
  // bewusste, klare Handlung.
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

  // Soll dieses Token als Chip gerendert werden (siehe Kopfkommentar oben)?
  // knownNames: Set<string> - Variablen-Aliase (Formel-Zeile) bzw. eigene
  // Parameter (Funktions-Zeile).
  function isChipToken(tok, nextTok, knownNames) {
    if (tok.type === 'KATLIT') return true;
    if (tok.type === 'IDENT' && tok.value !== 'TX') {
      if (nextTok && nextTok.type === '(') return true;
      if (knownNames && knownNames.has(tok.value)) return true;
    }
    return false;
  }

  // Zeichenlänge des Tokens, das dieser Chip repräsentiert - explizit als
  // data-len hinterlegt (nicht aus start/end-Positionen berechnet, die sich
  // bei jedem Edit ohnehin verschieben würden): das ist die Länge des
  // Chip-LABELs (ohne den "×"-Button), exakt der Text, den serializeEditor()
  // für diesen Chip zurückgibt.
  function chipTokenLength(chipEl) {
    return Number(chipEl.dataset.len) || 0;
  }
  function nodeTextLength(node) {
    if (node.classList && node.classList.contains('expr-tok-err-eof')) return 0; // rein dekorativ, kein echter Inhalt
    if (node.classList && node.classList.contains('expr-chip')) return chipTokenLength(node);
    return node.textContent.length;
  }

  function buildChipEl(text, kindClass, isErr) {
    const chip = document.createElement('span');
    chip.className = 'expr-chip ' + kindClass + (isErr ? ' expr-chip-err' : '');
    chip.contentEditable = 'false';
    chip.dataset.len = text.length;
    const label = document.createElement('span');
    label.className = 'expr-chip-label';
    label.textContent = text;
    chip.appendChild(label);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'expr-chip-remove';
    del.tabIndex = -1;
    del.setAttribute('aria-label', 'Entfernen');
    del.textContent = '×';
    chip.appendChild(del);
    return chip;
  }

  // Baut den Editor-Inhalt (Text + Chips) für den aktuellen Formeltext neu -
  // errPos markiert (wie zuvor) das fehlerhafte Token (Chip: roter Rahmen;
  // Text: rote Wellenlinie). excludeCaret: Zeichenposition, deren Token NIE
  // zum Chip wird (siehe Kopfkommentar), oder null (alles Erkannte wird
  // Chip - für initiales Rendern/Verlassen des Feldes/explizites Einfügen).
  function buildEditorDom(text, { errPos, knownNames, excludeCaret } = {}) {
    const frag = document.createDocumentFragment();
    if (!text) return frag;
    let tokens;
    try {
      tokens = GZ.exprEngine.tokenize(text);
    } catch (e) {
      const failPos = (e && typeof e.pos === 'number') ? e.pos : 0;
      if (failPos > 0) frag.appendChild(document.createTextNode(text.slice(0, failPos)));
      const errSpan = document.createElement('span');
      errSpan.className = 'expr-tok-err';
      errSpan.textContent = text.slice(failPos);
      frag.appendChild(errSpan);
      return frag;
    }
    let cursor = 0;
    let markedErr = false;
    tokens.forEach((tok, idx) => {
      if (tok.type === 'EOF') return;
      if (tok.pos > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, tok.pos)));
      const nextTok = tokens[idx + 1];
      const raw = text.slice(tok.pos, tok.end);
      const isErr = errPos != null && tok.pos === errPos;
      if (isErr) markedErr = true;
      const touching = excludeCaret != null && excludeCaret > tok.pos && excludeCaret <= tok.end;
      if (isChipToken(tok, nextTok, knownNames) && !touching) {
        frag.appendChild(buildChipEl(raw, classifyToken(tok, nextTok), isErr));
      } else {
        const span = document.createElement('span');
        span.className = classifyToken(tok, nextTok) + (isErr ? ' expr-tok-err' : '');
        span.textContent = raw;
        frag.appendChild(span);
      }
      cursor = tok.end;
    });
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    if (errPos != null && !markedErr) {
      const eofSpan = document.createElement('span');
      eofSpan.className = 'expr-tok-err expr-tok-err-eof';
      eofSpan.contentEditable = 'false';
      eofSpan.textContent = ' ';
      frag.appendChild(eofSpan);
    }
    return frag;
  }

  // DOM -> Formeltext (Chips liefern ihr eigenes Label, sonst textContent -
  // robust gegenüber leicht unordentlicher Zwischenstruktur, die der
  // Browser bei einer nativen contenteditable-Bearbeitung erzeugen kann,
  // weil bei jeder Änderung ohnehin komplett aus dem String neu gerendert
  // wird, siehe refreshEditorContent()).
  function serializeEditor(el) {
    let out = '';
    el.childNodes.forEach(node => {
      if (node.classList && node.classList.contains('expr-tok-err-eof')) return; // rein dekorativ, siehe nodeTextLength()
      if (node.classList && node.classList.contains('expr-chip')) {
        const label = node.querySelector('.expr-chip-label');
        out += label ? label.textContent : '';
      } else {
        out += node.textContent;
      }
    });
    return out;
  }

  // Wandelt eine native DOM-Position (Node + Kindknoten-/Zeichenindex, wie
  // sie ein Range/Selection-Endpunkt liefert) in einen Zeichenindex im
  // (durch serializeEditor() gelieferten) Formeltext um - null, wenn
  // container nicht innerhalb von el liegt.
  function containerOffsetToCharOffset(el, container, offset) {
    if (!el.contains(container)) return null;
    let topLevel = container;
    if (topLevel.nodeType === Node.TEXT_NODE) {
      while (topLevel.parentNode && topLevel.parentNode !== el) topLevel = topLevel.parentNode;
      let sum = 0;
      for (const child of el.childNodes) { if (child === topLevel) break; sum += nodeTextLength(child); }
      return sum + offset;
    }
    // Container ist ein Element (meist el selbst) - offset ist ein
    // Kindknoten-Index, d.h. die Position VOR diesem Kind.
    let sum = 0;
    const children = Array.from(container.childNodes);
    for (let i = 0; i < offset && i < children.length; i++) sum += nodeTextLength(children[i]);
    if (container === el) return sum;
    // Container ist ein Text-tragender Span (kommt bei uns nicht vor, da
    // Spans nur EIN Textkind haben, aber sicherheitshalber): addiere die
    // Länge vorangehender Geschwister von el aus.
    let outer = container;
    while (outer.parentNode && outer.parentNode !== el) outer = outer.parentNode;
    let precedingLen = 0;
    for (const child of el.childNodes) { if (child === outer) break; precedingLen += nodeTextLength(child); }
    return precedingLen + sum;
  }

  // Aktuelle Cursorposition (Selektionsanfang) als Zeichenindex - null, wenn
  // keine Selektion im Editor liegt.
  function getCaretOffset(el) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    return containerOffsetToCharOffset(el, range.startContainer, range.startOffset);
  }

  // Wie getCaretOffset(), liefert aber Anfang UND Ende der aktuellen
  // Selektion (bei einem reinen Cursor ist start===end) - wird gebraucht,
  // um z.B. eine per accept() eingefügte und selektierte Platzhalter-
  // Selektion ("objekt" in "Zustand(objekt)") über einen zwischenzeitlichen
  // refreshEditorContent()-Aufruf hinweg zu erhalten (siehe dort) - sonst
  // würde z.B. der debounced Validierungs-Refresh sie fälschlich auf einen
  // reinen Cursor an ihrem Anfang zusammenklappen, noch bevor der Nutzer
  // dazu kommt, den Platzhalter zu überschreiben.
  function getCaretSelection(el) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const start = containerOffsetToCharOffset(el, range.startContainer, range.startOffset);
    const end = containerOffsetToCharOffset(el, range.endContainer, range.endOffset);
    if (start == null || end == null) return null;
    return { start, end };
  }

  // Setzt den Cursor auf die gegebene Zeichenposition (Inverse zu
  // getCaretOffset()) - fällt eine Position MITTEN in einen Chip (kann bei
  // schnellen Änderungen passieren), wird auf dessen Ende ausgewichen, da
  // Chips atomar sind (kein Cursor "im Inneren").
  function setCaretOffset(el, offset) {
    let remaining = Math.max(0, offset);
    let targetNode = null, targetOffset = 0;
    const children = Array.from(el.childNodes);
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const len = nodeTextLength(child);
      if (child.classList && child.classList.contains('expr-chip')) {
        if (remaining <= 0) { targetNode = el; targetOffset = i; break; }
        if (remaining < len) { targetNode = el; targetOffset = i + 1; break; }
        remaining -= len;
        if (remaining === 0 && i === children.length - 1) { targetNode = el; targetOffset = i + 1; break; }
        continue;
      }
      if (remaining <= len) {
        const textNode = child.nodeType === Node.TEXT_NODE ? child : child.firstChild;
        if (textNode) { targetNode = textNode; targetOffset = remaining; }
        else { targetNode = el; targetOffset = i; }
        break;
      }
      remaining -= len;
    }
    if (!targetNode) { targetNode = el; targetOffset = el.childNodes.length; }
    const range = document.createRange();
    try { range.setStart(targetNode, targetOffset); range.collapse(true); }
    catch (e) { range.selectNodeContents(el); range.collapse(false); }
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Selektiert einen Zeichenbereich [start,end) (für Platzhalter-Argumente
  // beim Einfügen, z.B. "objekt" in "Zustand(objekt)" - siehe accept()).
  function setCaretRange(el, start, end) {
    setCaretOffset(el, start);
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || start === end) return;
    const anchorNode = sel.anchorNode, anchorOffset = sel.anchorOffset;
    setCaretOffset(el, end);
    const focusNode = sel.focusNode, focusOffset = sel.focusOffset;
    const range = document.createRange();
    try {
      range.setStart(anchorNode, anchorOffset);
      range.setEnd(focusNode, focusOffset);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* Selektion bleibt beim Ende - kein harter Fehler */ }
  }

  // Baut den Editor-Inhalt neu aus `text`. Bleibt das Feld fokussiert UND
  // preserveCaret ist true (Standard, für normales Tippen/Nachvalidieren),
  // wird die Cursorposition erhalten - UNABHÄNGIG davon, ob die "touching"-
  // Ausnahme greift: excludeCaret (welches Token NIE zum Chip wird) wird
  // vom Aufrufer explizit übergeben statt hier aus der aktuellen
  // Cursorposition abgeleitet zu werden (siehe setupExprEditor()'s
  // lastExcludeCaret - der eigentliche Grund dafür steht dort). Ist
  // preserveCaret false (explizites Einfügen/Entfernen via accept()/Chip-
  // "×"/blur), wird excludeCaret IMMER ignoriert (auf null erzwungen) - der
  // Aufrufer setzt dort die neue Cursorposition ohnehin selbst (siehe
  // setCaretOffset()/setCaretRange() oben).
  function refreshEditorContent(el, text, { errPos = null, knownNames = null, preserveCaret = true, excludeCaret = null } = {}) {
    const isFocused = document.activeElement === el;
    const selNow = (preserveCaret && isFocused) ? getCaretSelection(el) : null;
    const effectiveExclude = preserveCaret ? excludeCaret : null;
    el.innerHTML = '';
    el.appendChild(buildEditorDom(text, { errPos, knownNames, excludeCaret: effectiveExclude }));
    wireChipRemovers(el);
    // Volle Selektion (nicht nur ihren Anfang) wiederherstellen - relevant,
    // wenn z.B. eine per accept() eingefügte Platzhalter-Selektion noch
    // aktiv ist, während dieser Refresh läuft (siehe getCaretSelection()).
    if (selNow != null) {
      if (selNow.start === selNow.end) setCaretOffset(el, selNow.start);
      else setCaretRange(el, selNow.start, selNow.end);
    }
  }

  function wireChipRemovers(el) {
    el.querySelectorAll('.expr-chip-remove').forEach(btn => {
      btn.onmousedown = ev => ev.preventDefault(); // Fokus/Selektion im Editor nicht verlieren
      btn.onclick = ev => {
        ev.preventDefault();
        ev.stopPropagation();
        el.dispatchEvent(new CustomEvent('gz-chip-remove', { detail: { chip: btn.closest('.expr-chip') } }));
      };
    });
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

  // Verdrahtet den Chip-Editor, Fehler-Markierung, Autovervollständigung
  // (beim Tippen, gefiltert nach Bezeichner-Präfix) und die Funktions-
  // Palette (Button "ƒ", ungefiltert) für EIN Ausdrucks-Feld. Wird pro Zeile
  // bei jedem Render neu aufgerufen, da renderFuncRows()/renderFormulaRows()
  // das komplette innerHTML (und damit alle DOM-Knoten) neu aufbauen.
  // opts: { getText()->string, setText(string), knownNames()->Set<string>,
  //   onRevalidate() } - onRevalidate wird debounced (150ms) nach jeder
  // inhaltlichen Änderung aufgerufen (Aufrufer entscheidet, was das ist -
  // validateFormulaRow() bzw. die volle validateAllInline()). Hängt
  // refresh als wrap.__exprRefreshHighlight an, das validateAllInline()/
  // validateFormulaRow() nutzen, um nach der (debounced) Validierung die
  // Fehlerposition nachträglich einzuzeichnen.
  function setupExprEditor(rowEl, opts) {
    const wrap = rowEl.querySelector('.expr-input-wrap');
    if (!wrap) return;
    const el = wrap.querySelector('.expr-editor');
    const dropdown = wrap.querySelector('.expr-autocomplete');
    const paletteBtn = wrap.querySelector('.expr-palette-btn');
    const { getText, setText, knownNames, onRevalidate } = opts;

    // Zeichenposition, deren Token gerade NICHT chippen soll (siehe
    // buildEditorDom()-Kopfkommentar), zuletzt gesetzt von einer echten
    // Texteinfügung (applyTextFromDom()). Bewusst NICHT bei jedem refresh()-
    // Aufruf frisch aus der aktuellen Cursorposition abgeleitet: der
    // debounced Validierungs-Refresh (__exprRefreshHighlight, 150ms nach der
    // letzten Änderung) läuft oft GENAU zwischen zwei Tastenanschlägen und
    // würde sonst z.B. nach einem Löschvorgang, bei dem der Cursor zufällig
    // auf der Endgrenze eines fertigen Nachbar-Chips landet (")" nach "K1)"
    // löschen -> Cursor exakt hinter "K1"), diesen Chip fälschlich wieder in
    // reinen Text zurückverwandeln. Stattdessen bleibt hier der zuletzt per
    // Einfügen gesetzte Ausschluss bestehen, bis die nächste Änderung ihn
    // aktualisiert (weiter tippen) oder auf null setzt (löschen - siehe
    // applyTextFromDom()) bzw. refresh() ihn bei jedem preserveCaret:false
    // ("jetzt alles einrasten lassen") ohnehin verwirft.
    let lastExcludeCaret = null;
    const refresh = (errPos, options) => {
      if (options && options.preserveCaret === false) lastExcludeCaret = null;
      return refreshEditorContent(el, getText(), { errPos, knownNames: knownNames(), excludeCaret: lastExcludeCaret, ...options });
    };
    wrap.__exprRefreshHighlight = errPos => refresh(errPos);
    // Externer Einfüge-Hook für die Symbol-Sidebar (siehe insertTextAtFocused()
    // unten im Modul) - fügt an der AKTUELLEN Cursorposition ein, ohne dass
    // die Sidebar Interna dieser Zeile (Modell-Feld, Debounce...) kennen muss.
    // Liefert false, wenn das Feld gerade keine Selektion hat (z.B. nicht
    // fokussiert).
    wrap.__exprInsertAt = (text, selStart, selEnd) => {
      const caret = getCaretOffset(el);
      if (caret == null) return false;
      const val = getText();
      const newText = val.slice(0, caret) + text + val.slice(caret);
      el.focus();
      applyText(newText, { range: [caret + selStart, caret + selEnd] });
      return true;
    };

    // Schließt bei Bedarf mitlaufende Scroll-/Resize-Listener (siehe unten) -
    // nur EIN Listener-Paar pro Dropdown-Öffnung, selbst-entfernend, damit
    // beim wiederholten Öffnen/Schließen nichts an window hängen bleibt.
    let scrollCloseHandler = null;
    const closeDropdown = () => {
      dropdown.hidden = true; dropdown.innerHTML = '';
      if (scrollCloseHandler) {
        window.removeEventListener('scroll', scrollCloseHandler, true);
        window.removeEventListener('resize', scrollCloseHandler);
        scrollCloseHandler = null;
      }
    };

    // .expr-autocomplete ist bewusst position:fixed statt :absolute (siehe
    // components.css) - das umgeht das overflow:hidden von .panel (für die
    // abgerundeten Ecken), das ein absolut positioniertes Dropdown sonst am
    // Panel-Rand hart abschneiden würde. Position wird daher hier per JS aus
    // der tatsächlichen Bildschirmposition berechnet, inkl. Umklappen nach
    // oben, wenn unterhalb kein Platz mehr ist, und horizontalem Clamping.
    const positionDropdown = () => {
      const rect = wrap.getBoundingClientRect();
      dropdown.style.left = Math.round(rect.left) + 'px';
      dropdown.style.top = Math.round(rect.bottom + 3) + 'px';
      dropdown.style.visibility = 'hidden';
      requestAnimationFrame(() => {
        if (dropdown.hidden) return; // in der Zwischenzeit wieder geschlossen
        const dw = dropdown.offsetWidth, dh = dropdown.offsetHeight;
        let top = rect.bottom + 3;
        if (top + dh > window.innerHeight - 8) top = Math.max(8, rect.top - dh - 3);
        let left = rect.left;
        if (left + dw > window.innerWidth - 8) left = window.innerWidth - dw - 8;
        if (left < 8) left = 8;
        dropdown.style.top = Math.round(top) + 'px';
        dropdown.style.left = Math.round(left) + 'px';
        dropdown.style.visibility = '';
      });
    };

    const currentPrefix = () => {
      const val = getText(), caret = getCaretOffset(el);
      if (caret == null) return { start: 0, end: 0, text: '' };
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
      dropdown.querySelectorAll('.expr-ac-item').forEach(itemEl => {
        itemEl.onmousedown = ev => { ev.preventDefault(); accept(items[Number(itemEl.dataset.idx)], start, end); };
      });
      positionDropdown();
      if (!scrollCloseHandler) {
        // capture:true faengt auch das native 'scroll'-Event der Liste SELBST
        // ab, wenn sie wegen max-height/overflow-y:auto (siehe components.css)
        // mehr Einträge hat als sichtbar sind ('scroll' bubbelt zwar nicht,
        // aber Capturing-Listener auf window sehen es trotzdem auf dem Weg
        // nach unten) - ohne den contains()-Check würde ein simples
        // Herunterscrollen INNERHALB der Liste, um einen weiter unten
        // stehenden Eintrag zu erreichen, das Dropdown sofort schließen.
        scrollCloseHandler = ev => { if (dropdown.contains(ev.target)) return; closeDropdown(); };
        window.addEventListener('scroll', scrollCloseHandler, true);
        window.addEventListener('resize', scrollCloseHandler);
      }
    };

    const updateAutocomplete = () => {
      const { start, end, text } = currentPrefix();
      if (!text) { closeDropdown(); return; }
      const items = exprCandidates().filter(c => c.label.toUpperCase().startsWith(text.toUpperCase()));
      renderDropdown(items, start, end);
    };

    const openPalette = () => {
      el.focus();
      const caret = getCaretOffset(el);
      const pos = caret == null ? getText().length : caret;
      renderDropdown(exprCandidates(), pos, pos);
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

    const debouncedRevalidate = () => {
      clearTimeout(debounceTimers.get(el));
      debounceTimers.set(el, setTimeout(onRevalidate, 150));
    };

    // Zentrale Stelle für JEDE inhaltliche Änderung (Tippen, Chip entfernen,
    // Einfügen aus Dropdown/Palette/Sidebar): Modell synchronisieren, Editor
    // neu rendern, Nachvalidierung anstoßen. caretMode 'preserve' = aktuelle
    // Cursorposition beibehalten (inkl. "touching"-Ausnahme, normales
    // Tippen); {offset} bzw. {range:[start,end]} = Cursor explizit setzen
    // (Einfügen/Entfernen - siehe refreshEditorContent() Kopfkommentar).
    function applyText(newText, caretMode) {
      setText(newText);
      if (caretMode === 'preserve') {
        refresh(null);
      } else {
        refresh(null, { preserveCaret: false });
        if (caretMode && caretMode.range) setCaretRange(el, caretMode.range[0], caretMode.range[1]);
        else if (caretMode && typeof caretMode.offset === 'number') setCaretOffset(el, caretMode.offset);
      }
      debouncedRevalidate();
    }

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
      closeDropdown();
      const val = getText();
      const newText = val.slice(0, start) + insertText + val.slice(end);
      el.focus();
      applyText(newText, { range: [start + selStart, start + selEnd] });
    }

    // Chip per "×"-Button entfernen (siehe wireChipRemovers()) - Token-
    // Zeichenbereich aus dem Text herausschneiden, Cursor bleibt an dessen
    // ehemaligem Anfang stehen.
    el.addEventListener('gz-chip-remove', e => {
      const chip = e.detail.chip;
      if (!chip) return;
      // Zeichenposition des Chips im aktuellen Text bestimmen (Chips selbst
      // tragen keine Positions-Attribute mehr, siehe buildChipEl() - stabiler
      // ist, den DOM-Offset frisch über getCaretOffset()-Logik zu berechnen).
      const before = [];
      for (const child of el.childNodes) { if (child === chip) break; before.push(child); }
      const start = before.reduce((sum, n) => sum + nodeTextLength(n), 0);
      const end = start + nodeTextLength(chip);
      const val = getText();
      el.focus();
      applyText(val.slice(0, start) + val.slice(end), { offset: start });
    });

    el.addEventListener('input', () => {
      applyTextFromDom();
    });
    function applyTextFromDom() {
      const oldText = getText();
      const newText = serializeEditor(el);
      setText(newText);
      // Wird der Text länger (Einfügen), Cursorposition NACH dem Edit als
      // Ausschluss merken (siehe lastExcludeCaret oben) - VOR refresh()
      // lesen, solange el noch die native, ungerenderte DOM des Browsers
      // trägt. Wird er nicht länger (Löschen/Ersetzen), sofort auf null
      // setzen: sonst kann der Cursor zufällig auf der Endgrenze eines
      // fertigen Nachbar-Chips landen und ihn fälschlich entchippen.
      lastExcludeCaret = (newText.length > oldText.length) ? getCaretOffset(el) : null;
      refresh(null);
      debouncedRevalidate();
      if (el.dataset.suppressAc) { delete el.dataset.suppressAc; return; }
      updateAutocomplete();
    }

    el.addEventListener('click', () => closeDropdown());
    el.addEventListener('paste', e => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      if (!text) return;
      const caret = getCaretOffset(el);
      if (caret == null) return;
      const val = getText();
      const newText = val.slice(0, caret) + text + val.slice(caret);
      applyText(newText, { offset: caret + text.length });
    });
    el.addEventListener('keydown', e => {
      if (!dropdown.hidden) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { if (acceptActiveOrFirst()) { e.preventDefault(); return; } }
        else if (e.key === 'Escape') { closeDropdown(); return; }
      }
      if (e.key === 'Enter') { e.preventDefault(); return; } // einzeilig - kein Zeilenumbruch
      // Backspace/Delete unmittelbar an einem Chip entfernen ihn atomar als
      // Ganzes, statt eines (browserabhängig unzuverlässigen) nativen
      // Versuchs, in ein contenteditable="false"-Element hineinzulöschen.
      if (e.key === 'Backspace' || e.key === 'Delete') {
        const caret = getCaretOffset(el);
        if (caret == null) return;
        const sel = window.getSelection();
        if (!sel || !sel.isCollapsed) return; // echte Selektion: native Löschung ist hier unproblematisch
        const children = Array.from(el.childNodes);
        let acc = 0, hitChip = null;
        for (const child of children) {
          const len = nodeTextLength(child);
          const isChip = child.classList && child.classList.contains('expr-chip');
          if (e.key === 'Backspace' && isChip && caret === acc + len) { hitChip = child; break; }
          if (e.key === 'Delete' && isChip && caret === acc) { hitChip = child; break; }
          acc += len;
        }
        if (hitChip) {
          e.preventDefault();
          el.dispatchEvent(new CustomEvent('gz-chip-remove', { detail: { chip: hitChip } }));
        }
      }
    });
    el.addEventListener('blur', () => {
      setTimeout(closeDropdown, 150);
      refresh(null, { preserveCaret: false }); // beim Verlassen: alles Erkannte einrasten lassen
    });
    if (paletteBtn) {
      // preventDefault auf mousedown verhindert, dass der Button dem Editor
      // den Fokus entzieht - sonst würde der oben registrierte blur-Handler
      // die gerade per openPalette() geöffnete Liste ~150ms später wieder
      // zumachen (Fokus wäre kurz weg- und wieder hergesprungen).
      paletteBtn.addEventListener('mousedown', e => e.preventDefault());
      paletteBtn.onclick = openPalette;
    }

    refresh(null, { preserveCaret: false });
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
      sidebar: root.querySelector('#upFormulaSidebar')
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
      setupExprEditor(rowEl, {
        getText: () => f.bodyText,
        setText: v => { f.bodyText = v; },
        knownNames: () => new Set(f.params.map(p => p.trim()).filter(Boolean)),
        onRevalidate: validateAllInline
      });
    });
    validateAllInline();
  }

  function renderFormulaRows() {
    els.formulaRows.innerHTML = formulas.map(f => `
      <div class="up-formula-row" data-id="${f.id}">
        <input type="text" class="up-formula-name mono-input" value="${esc(f.name)}" placeholder="Name">
        <span class="expr-input-wrap">
          <div class="up-formula-expr expr-editor mono-input" contenteditable="true" spellcheck="false" data-placeholder="z.B. DauerSeit(K1, GRUEN) &gt; 45 AND Zustand(D1) == BELEGT" role="textbox" aria-multiline="false"></div>
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
      rowEl.querySelector('.up-formula-remove').onclick = () => { formulas = formulas.filter(x => x.id !== id); renderFormulaRows(); };
      setupExprEditor(rowEl, {
        getText: () => f.exprText,
        setText: v => { f.exprText = v; },
        knownNames: () => new Set(vars.map(v => v.alias.trim()).filter(Boolean)),
        onRevalidate: () => validateFormulaRow(rowEl, f)
      });
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
    renderSidebar();
  }

  // Live-Symbolübersicht ("IDE-Gefühl") neben Variablen/Funktionen/Formeln -
  // rein lesend/anzeigend, außer: Klick auf einen Eintrag fügt ihn in das
  // GERADE FOKUSSIERTE Ausdrucksfeld ein (siehe insertTextAtInput()). Wird
  // aus validateAllInline() heraus bei jeder Variablen-/Funktionsänderung
  // neu aufgebaut (Formeln selbst tauchen hier nicht auf, sie beeinflussen
  // die Symbolliste nicht).
  function renderSidebar() {
    if (!els.sidebar) return;
    const cols = sourceCols();
    const boundIdx = new Set(vars.map(v => v.colIndex));
    const unboundCols = cols.filter(c => !boundIdx.has(c.index));

    const item = (name, meta, insertText, selStart, selEnd, muted) =>
      `<div class="fsb-item${muted ? ' fsb-item-muted' : ''}" data-insert="${esc(insertText)}" data-sel-start="${selStart}" data-sel-end="${selEnd}" title="${esc(meta)}">
        <span class="fsb-item-name">${esc(name)}</span><span class="fsb-item-meta">${esc(meta)}</span>
      </div>`;
    const section = (title, inner) => `<div class="fsb-section"><div class="fsb-section-title">${esc(title)}</div>${inner || '<div class="fsb-empty">–</div>'}</div>`;

    const varsHtml = vars.filter(v => v.alias.trim()).map(v => {
      const alias = v.alias.trim();
      const col = cols.find(c => c.index === v.colIndex);
      return item(alias, col ? `${col.kuerzel} ${col.name}` : '?', alias, alias.length, alias.length);
    }).join('');

    const funcsHtml = funcs.filter(f => f.name.trim()).map(f => {
      const name = f.name.trim();
      const params = f.params.map(p => p.trim()).filter(Boolean);
      const argList = params.join(', ');
      return item(name, `(${argList})`, `${name}(${argList})`, name.length + 1, name.length + 1 + (params[0] ? params[0].length : 0));
    }).join('');

    const primHtml = GZ.exprEngine.PRIMITIVE_INFO.map(p => {
      const argList = p.params.join(', ');
      return item(p.name, `(${argList})`, `${p.name}(${argList})`, p.name.length + 1, p.name.length + 1 + p.params[0].length);
    }).join('');

    const katChips = Object.entries(GZ.exprEngine.KAT_TOKENS).map(([tok, katType]) =>
      `<span class="fsb-chip${katType === 'KAT_DET' ? ' fsb-chip-det' : ''}" data-insert="${esc(tok)}" data-sel-start="${tok.length}" data-sel-end="${tok.length}" title="${katType === 'KAT_SG' ? 'Signalgruppen-Zustand' : 'Detektor-Zustand'}">${esc(tok)}</span>`
    ).join('');

    const objHtml = unboundCols.map(c =>
      `<div class="fsb-item fsb-item-muted" data-col-index="${c.index}" title="${esc(c.kuerzel)}">
        <span class="fsb-item-name">${esc(c.name)}</span><span class="fsb-item-meta">${esc(c.kuerzel)}</span>
      </div>`
    ).join('');

    els.sidebar.innerHTML = [
      section('Variablen', varsHtml),
      section('Funktionen', funcsHtml),
      section('Primitiven', primHtml),
      section('Zustände', `<div class="fsb-chips">${katChips}</div>`),
      section('Objekte (ohne Variable)', objHtml)
    ].join('');

    els.sidebar.querySelectorAll('[data-insert]').forEach(el => {
      el.onmousedown = ev => {
        ev.preventDefault(); // Fokus im Ausdrucksfeld erhalten (siehe insertTextAtFocused())
        insertTextAtFocused(el.dataset.insert, Number(el.dataset.selStart), Number(el.dataset.selEnd));
      };
    });
    els.sidebar.querySelectorAll('[data-col-index]').forEach(el => {
      el.onmousedown = ev => {
        ev.preventDefault();
        // Erst prüfen, OB überhaupt eingefügt werden kann - sonst würde ein
        // Klick ohne fokussiertes Feld still (nur mit Hinweis, aber ohne
        // sichtbaren Effekt) trotzdem eine Variable anlegen, was wie ein
        // Bug wirkt (Seiteneffekt ohne Ergebnis).
        if (!activeExprWrap()) {
          if (GZ.snackbar) GZ.snackbar.show('Kein Eingabefeld aktiv', { type: 'info', description: 'Zuerst in ein Funktions- oder Formelfeld klicken, dann aus der Übersicht auswählen.' });
          return;
        }
        const col = cols.find(c => c.index === Number(el.dataset.colIndex));
        if (!col) return;
        const alias = resolveOrCreateVarForCol(col);
        insertTextAtFocused(alias, alias.length, alias.length);
      };
    });
  }

  // Liefert den .expr-input-wrap des aktuell fokussierten Ausdrucksfelds
  // (document.activeElement bleibt dank preventDefault auf mousedown der
  // Sidebar-Klicks das zuvor fokussierte Feld, siehe renderSidebar()) oder
  // null. Der wrap trägt __exprInsertAt (siehe setupExprEditor()), über den
  // die Sidebar einfügt, ohne Modell-Interna der jeweiligen Zeile zu kennen.
  function activeExprWrap() {
    const el = document.activeElement;
    if (!el || !el.classList || !el.classList.contains('expr-editor')) return null;
    return el.closest('.expr-input-wrap');
  }

  // Fügt Text in das aktuell fokussierte Ausdrucksfeld ein - no-op mit
  // Hinweis, wenn gerade keins fokussiert ist (siehe activeExprWrap()).
  function insertTextAtFocused(text, selStart, selEnd) {
    const wrap = activeExprWrap();
    const ok = wrap && wrap.__exprInsertAt && wrap.__exprInsertAt(text, selStart, selEnd);
    if (!ok && GZ.snackbar) {
      GZ.snackbar.show('Kein Eingabefeld aktiv', { type: 'info', description: 'Zuerst in ein Funktions- oder Formelfeld klicken, dann aus der Übersicht auswählen.' });
    }
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
      // scopeSpecs (und damit die Objekt-Handles/Sweeps) sind über ALLE
      // Formeln hinweg dieselben Instanzen (einmal vor der Schleife gebaut,
      // siehe oben) - vor jedem neuen Formel-Durchlauf müssen ihre Sweeps
      // daher zurückgesetzt werden, sonst bliebe der Zeiger vom vorherigen
      // Durchlauf am Ende der Zeitreihe stehen und jede Formel AUSSER der
      // ersten, die eine bestimmte Variable nutzt, würde fälschlich "kein
      // Segment" (Zustand/Dauer/DauerSeit -> 0/null) für die gesamte
      // Aufzeichnung liefern.
      scopeSpecs.forEach(s => { if (s.handle) s.handle.sweep.reset(); });
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
