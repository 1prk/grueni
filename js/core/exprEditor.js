/* GZ.exprEditor — wiederverwendbarer Ausdrucks-Editor: farblich nach
   Token-Art eingefärbter Text in einem contenteditable-Feld, auf demselben
   Lexer wie das tatsächliche Parsen (GZ.exprEngine). formulaBuilder.js
   (Umlaufprüfung), oepnvQa.js (ÖPNV-Zeilenfilter) und umlaufstatistiken.js
   nutzen dasselbe Modul mit jeweils eigenen Symbol-Listen/Modell-Feldern.

   Bewusst KEINE Chips/Tabstop-Ketten/Symbol-Sidebar (frühere Version) mehr -
   jedes Token ist reiner, eingefärbter Text, ein Kandidat aus Dropdown/
   Palette ersetzt beim Einfügen einfach die aktuelle Selektion. Das macht
   auch die frühere "Cursor berührt das Token noch"-Ausnahme überflüssig
   (nur zum Schutz der Chip-Atomarität nötig) - jedes Zeichen bleibt normal
   mit Backspace/Delete löschbar, auch mitten in einem eingefärbten Token.

   Modell: Quelle der Wahrheit bleibt der reine Ausdruckstext beim Aufrufer
   (opts.getText()/setText()) - der Editor wird bei jeder Änderung aus
   diesem Text neu gerendert (siehe refreshEditorContent()), nie umgekehrt.
   Der native Undo-Stack des Browsers überlebt diesen Neuaufbau nicht (dafür
   bräuchte es inkrementelles DOM-Patchen statt eines vollen Neuaufbaus je
   Tastendruck) - daher die eigene, schlanke Undo/Redo-Historie unten.

   setup(rowEl, opts) - opts:
     getText()->string, setText(string)
     knownNames()->Set<string> - Bezeichner, die (wenn identColorFor eine
       Farbe liefert) eine individuelle Akzentfarbe statt der generischen
       Variablen-Farbe bekommen (z.B. formulaBuilder.js: eine referenzierte
       Formel trägt dieselbe Farbe wie ihre eigene Zeile).
     getCandidates()->[{group,label,hint,desc,insertText,selStart,selEnd,
       onAccept?()->string|void,kind}] - Autovervollständigung (nach
       Bezeichner-Präfix gefiltert)/Funktions-Palette (ungefiltert, Button
       .expr-palette-btn, falls vorhanden). onAccept ist ein optionaler Hook
       für Kandidaten, deren Einfügen mehr als reinen Text braucht (z.B.
       formulaBuilder.js: eine Spalte auswählen legt bei Bedarf automatisch
       eine Variable an und fügt deren Alias ein) - der Rückgabewert ERSETZT
       insertText/selStart/selEnd, wenn nicht null/undefined.
     identColorFor(label)->string|null - optional: individuelle Akzentfarbe
       für einen bloßen (in knownNames() enthaltenen) Bezeichner.
     onRevalidate() - debounced (150ms) nach jeder inhaltlichen Änderung.
   Hängt an rowEl.querySelector('.expr-input-wrap'):
     wrap.__exprRefreshHighlight(errPos) - von außen (Validierung) genutzt,
       um nachträglich eine Fehlerposition (rote Wellenlinie) einzuzeichnen. */
(function (GZ) {
  'use strict';
  const { esc } = GZ.format;

  // Debounce-Zeitgeber NUR für die eigene Nachvalidierung dieses Moduls.
  const debounceTimers = new Map();

  function classifyToken(tok, nextTok) {
    switch (tok.type) {
      case 'NUMBER': return 'expr-tok-num';
      case 'STRING': return 'expr-tok-text';
      case 'KATLIT': return 'expr-tok-kat';
      case 'AND': case 'OR': case 'NOT': return 'expr-tok-kw';
      case 'IDENT':
        if (tok.value === 'TX') return 'expr-tok-kw';
        return (nextTok && nextTok.type === '(') ? 'expr-tok-func' : 'expr-tok-var';
      case '+': case '-': case '*': case '/': case '>': case '<': case '>=': case '<=': case '==': case '!=':
        return 'expr-tok-op';
      case '(': case ')': case ',': return 'expr-tok-punc';
      default: return '';
    }
  }

  // Baut den Editor-Inhalt (reiner, eingefärbter Text) für den aktuellen
  // Ausdruckstext neu - errPos markiert (rote Wellenlinie) das fehlerhafte
  // Token, identColorFor färbt bekannte Bezeichner-Referenzen individuell
  // (siehe Kopfkommentar).
  function buildEditorDom(text, { errPos, knownNames, identColorFor } = {}) {
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
      let cls = classifyToken(tok, nextTok);
      const isBareIdent = tok.type === 'IDENT' && tok.value !== 'TX' && (!nextTok || nextTok.type !== '(');
      const accentColor = (isBareIdent && knownNames && knownNames.has(tok.value) && identColorFor) ? identColorFor(tok.value) : null;
      if (accentColor) cls += ' expr-tok-accent';
      if (isErr) cls += ' expr-tok-err';
      const span = document.createElement('span');
      span.className = cls;
      if (accentColor) span.style.setProperty('--ident-accent', accentColor);
      span.textContent = raw;
      frag.appendChild(span);
      cursor = tok.end;
    });
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    if (errPos != null && !markedErr) {
      const eofSpan = document.createElement('span');
      eofSpan.className = 'expr-tok-err expr-tok-err-eof';
      eofSpan.contentEditable = 'false';
      eofSpan.textContent = ' ';
      frag.appendChild(eofSpan);
    }
    return frag;
  }

  // DOM -> Ausdruckstext. expr-tok-err-eof ist eine rein dekorative Endpunkt-
  // Markierung (siehe buildEditorDom()), kein echter Inhalt.
  function serializeEditor(el) {
    let out = '';
    el.childNodes.forEach(node => {
      if (node.classList && node.classList.contains('expr-tok-err-eof')) return;
      out += node.textContent;
    });
    return out;
  }
  function nodeTextLength(node) {
    if (node.classList && node.classList.contains('expr-tok-err-eof')) return 0;
    return node.textContent.length;
  }

  // Wandelt eine native DOM-Position (Node + Kindknoten-/Zeichenindex, wie
  // sie ein Range/Selection-Endpunkt liefert) in einen Zeichenindex im
  // Ausdruckstext um - null, wenn container nicht innerhalb von el liegt.
  function containerOffsetToCharOffset(el, container, offset) {
    if (!el.contains(container)) return null;
    let topLevel = container;
    if (topLevel.nodeType === Node.TEXT_NODE) {
      while (topLevel.parentNode && topLevel.parentNode !== el) topLevel = topLevel.parentNode;
      let sum = 0;
      for (const child of el.childNodes) { if (child === topLevel) break; sum += nodeTextLength(child); }
      return sum + offset;
    }
    let sum = 0;
    const children = Array.from(container.childNodes);
    for (let i = 0; i < offset && i < children.length; i++) sum += nodeTextLength(children[i]);
    if (container === el) return sum;
    let outer = container;
    while (outer.parentNode && outer.parentNode !== el) outer = outer.parentNode;
    let precedingLen = 0;
    for (const child of el.childNodes) { if (child === outer) break; precedingLen += nodeTextLength(child); }
    return precedingLen + sum;
  }

  function getCaretOffset(el) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    return containerOffsetToCharOffset(el, range.startContainer, range.startOffset);
  }
  function getCaretSelection(el) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const start = containerOffsetToCharOffset(el, range.startContainer, range.startOffset);
    const end = containerOffsetToCharOffset(el, range.endContainer, range.endOffset);
    if (start == null || end == null) return null;
    return { start, end };
  }
  function setCaretOffset(el, offset) {
    let remaining = Math.max(0, offset);
    let targetNode = null, targetOffset = 0;
    const children = Array.from(el.childNodes);
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const len = nodeTextLength(child);
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
  // wird die Cursorposition erhalten.
  function refreshEditorContent(el, text, { errPos = null, knownNames = null, preserveCaret = true, identColorFor = null } = {}) {
    const isFocused = document.activeElement === el;
    const selNow = (preserveCaret && isFocused) ? getCaretSelection(el) : null;
    el.innerHTML = '';
    el.appendChild(buildEditorDom(text, { errPos, knownNames, identColorFor }));
    if (selNow != null) {
      if (selNow.start === selNow.end) setCaretOffset(el, selNow.start);
      else setCaretRange(el, selNow.start, selNow.end);
    }
  }

  // Verdrahtet den Ausdrucks-Editor, Fehler-Markierung, Autovervollständigung
  // (beim Tippen, gefiltert nach Bezeichner-Präfix) und die Funktions-Palette
  // (Button "ƒ", ungefiltert) für EIN Ausdrucks-Feld - siehe Datei-
  // Kopfkommentar für opts. Sollte pro Zeile bei jedem Neuaufbau des
  // umgebenden innerHTML (und damit aller DOM-Knoten) erneut aufgerufen
  // werden.
  function setup(rowEl, opts) {
    const wrap = rowEl.querySelector('.expr-input-wrap');
    if (!wrap) return;
    const el = wrap.querySelector('.expr-editor');
    const dropdown = wrap.querySelector('.expr-autocomplete');
    // rowEl statt wrap durchsucht (Superset) - lässt Aufrufer den ƒ-Button
    // außerhalb von .expr-input-wrap platzieren (z.B. formulaBuilder.js: im
    // Kartenkopf statt neben dem Editor selbst).
    const paletteBtn = rowEl.querySelector('.expr-palette-btn');
    const { getText, setText, knownNames, getCandidates, onRevalidate, identColorFor } = opts;

    const refresh = (errPos, options) =>
      refreshEditorContent(el, getText(), { errPos, knownNames: knownNames(), identColorFor, ...options });
    wrap.__exprRefreshHighlight = errPos => refresh(errPos);

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
    // Panel-Rand hart abschneiden würde.
    const positionDropdown = () => {
      const rect = wrap.getBoundingClientRect();
      dropdown.style.left = Math.round(rect.left) + 'px';
      dropdown.style.top = Math.round(rect.bottom + 3) + 'px';
      dropdown.style.visibility = 'hidden';
      requestAnimationFrame(() => {
        if (dropdown.hidden) return;
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
        scrollCloseHandler = ev => { if (dropdown.contains(ev.target)) return; closeDropdown(); };
        window.addEventListener('scroll', scrollCloseHandler, true);
        window.addEventListener('resize', scrollCloseHandler);
      }
    };

    // Teilstring- statt reiner Präfixsuche (Treffer am Wortanfang zuerst).
    const matchCandidates = (items, text) => {
      const q = text.toUpperCase();
      const pre = [], sub = [];
      items.forEach(c => {
        const l = String(c.label).toUpperCase();
        if (l.startsWith(q)) pre.push(c);
        else if (l.includes(q)) sub.push(c);
      });
      return pre.concat(sub);
    };

    const updateAutocomplete = () => {
      const { start, end, text } = currentPrefix();
      if (!text) { closeDropdown(); return; }
      renderDropdown(matchCandidates(getCandidates(), text), start, end);
    };

    const openPalette = () => {
      el.focus();
      const sel = getCaretSelection(el);
      const pos = sel ? sel.start : getText().length;
      const endPos = sel ? sel.end : pos;
      renderDropdown(getCandidates(), pos, endPos);
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

    // ---------- Rückgängig/Wiederholen (Ctrl+Z / Ctrl+Y bzw. Ctrl+Shift+Z)
    // Der native Undo-Stack des Browsers ist hier unbrauchbar (siehe Datei-
    // Kopfkommentar) - stattdessen eine eigene, schlanke Historie auf
    // MODELLEBENE (Text + Cursorposition). Aufeinanderfolgendes Tippen wird
    // zeitlich zusammengefasst (COALESCE_MS), damit ein Undo nicht Zeichen
    // für Zeichen zurückgeht, sondern ganze Tippgruppen; explizite
    // Einfügungen (Dropdown/Palette) bilden dagegen immer einen eigenen
    // Schritt.
    const HISTORY_LIMIT = 100, COALESCE_MS = 600, COALESCE_MAX_CHARS = 20;
    let undoStack = [], redoStack = [], lastPushAt = 0, groupBaseLen = 0, suppressHistory = false;
    const snapshot = () => ({ text: getText(), caret: getCaretOffset(el) });
    function pushHistory(coalesce) {
      if (suppressHistory) return;
      const now = Date.now();
      const grown = Math.abs(getText().length - groupBaseLen);
      if (coalesce && undoStack.length && (now - lastPushAt) < COALESCE_MS && grown < COALESCE_MAX_CHARS) {
        lastPushAt = now;
        return;
      }
      undoStack.push(snapshot());
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      redoStack = [];
      lastPushAt = now;
      groupBaseLen = getText().length;
    }
    function restore(entry) {
      suppressHistory = true;
      setText(entry.text);
      refresh(null, { preserveCaret: false });
      if (entry.caret != null) setCaretOffset(el, entry.caret);
      suppressHistory = false;
      debouncedRevalidate();
    }
    function undo() {
      if (!undoStack.length) return false;
      redoStack.push(snapshot());
      restore(undoStack.pop());
      lastPushAt = 0;
      return true;
    }
    function redo() {
      if (!redoStack.length) return false;
      undoStack.push(snapshot());
      restore(redoStack.pop());
      lastPushAt = 0;
      return true;
    }

    // Zentrale Stelle für JEDE inhaltliche Änderung (Tippen, Einfügen aus
    // Dropdown/Palette): Modell synchronisieren, Editor neu rendern,
    // Nachvalidierung anstoßen. caretMode 'preserve' = aktuelle
    // Cursorposition beibehalten (normales Tippen); {offset} bzw.
    // {range:[start,end]} = Cursor explizit setzen (Einfügen).
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

    // Ersetzt [rStart,rEnd) im aktuellen Text durch insertText, selektiert
    // anschließend [selStart,selEnd) davon (Platzhalter direkt überschreibbar).
    function insertAtSelection(rStart, rEnd, insertText, selStart, selEnd) {
      pushHistory(false); // explizites Einfügen = eigener Undo-Schritt
      const val = getText();
      const newText = val.slice(0, rStart) + insertText + val.slice(rEnd);
      el.focus();
      applyText(newText, { range: [rStart + selStart, rStart + selEnd] });
    }

    function accept(item, start, end) {
      // Kandidaten mit onAccept() (z.B. formulaBuilder.js: eine Spalte statt
      // Primitive/Funktion/Zustand/Variable - erst Alias auflösen/anlegen,
      // dann wie eine normale Variable einfügen) ERSETZEN insertText/
      // selStart/selEnd komplett durch den Rückgabewert.
      let insertText = item.insertText, selStart = item.selStart, selEnd = item.selEnd;
      if (item.onAccept) {
        const resolved = item.onAccept();
        if (resolved != null) { insertText = resolved; selStart = resolved.length; selEnd = resolved.length; }
      }
      closeDropdown();
      insertAtSelection(start, end, insertText, selStart, selEnd);
    }

    el.addEventListener('input', () => {
      pushHistory(true); // zusammenhängendes Tippen zu einer Gruppe zusammenfassen
      setText(serializeEditor(el));
      refresh(null);
      debouncedRevalidate();
      updateAutocomplete();
    });

    el.addEventListener('click', () => closeDropdown());
    el.addEventListener('paste', e => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      if (!text) return;
      const sel = getCaretSelection(el);
      if (sel == null) return;
      pushHistory(false);
      const val = getText();
      const newText = val.slice(0, sel.start) + text + val.slice(sel.end);
      applyText(newText, { offset: sel.start + text.length });
    });
    el.addEventListener('keydown', e => {
      // Rückgängig/Wiederholen vor allem anderen behandeln - der native
      // Browser-Undo greift hier nicht (siehe Datei-Kopfkommentar).
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) { e.preventDefault(); closeDropdown(); undo(); return; }
      if (mod && ((e.key === 'y' || e.key === 'Y') || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))) { e.preventDefault(); closeDropdown(); redo(); return; }
      if (!dropdown.hidden) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { if (acceptActiveOrFirst()) { e.preventDefault(); return; } }
        else if (e.key === 'Escape') { closeDropdown(); return; }
      }
      if (e.key === 'Enter') { e.preventDefault(); return; } // einzeilig - kein Zeilenumbruch
    });
    el.addEventListener('blur', () => {
      setTimeout(closeDropdown, 150);
      refresh(null, { preserveCaret: false });
    });
    if (paletteBtn) {
      // preventDefault auf mousedown verhindert, dass der Button dem Editor
      // den Fokus entzieht - sonst würde der blur-Handler die gerade per
      // openPalette() geöffnete Liste ~150ms später wieder zumachen.
      paletteBtn.addEventListener('mousedown', e => e.preventDefault());
      paletteBtn.onclick = openPalette;
    }

    refresh(null, { preserveCaret: false });
  }

  GZ.exprEditor = { setup };
})(window.GZ = window.GZ || {});
