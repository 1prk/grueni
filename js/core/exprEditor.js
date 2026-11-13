/* GZ.exprEditor is a reusable expression editor.
   It shows text in a contenteditable field. The color depends on the token kind.
   It uses the same lexer as the real parsing (GZ.exprEngine).
   formulaBuilder.js (Umlaufprüfung), oepnvQa.js (ÖPNV row filter) and umlaufstatistiken.js use
   the same module.
   Each one has its own symbol lists and model fields.

   An earlier version had chips, tab stop chains and a symbol sidebar. The editor has NONE of
   them now.
   Each token is plain, colored text.
   A candidate from the dropdown or the palette simply replaces the current selection when the
   user inserts it.
   This also removes the earlier exception "the cursor still touches the token".
   The exception was only necessary to protect the atomicity of the chips.
   The user can delete each character normally with Backspace or Delete, also in the middle of a
   colored token.

   Model: the source of truth stays the plain expression text in the caller (opts.getText() and
   setText()).
   The editor renders again from this text after each change (see refreshEditorContent()). It
   never works the other way.
   The native undo stack of the browser does not survive this rebuild.
   It would need incremental DOM patching and not a full rebuild at each key press.
   So the module has its own slim undo and redo history below.

   setup(rowEl, opts), with opts:
     getText() -> string, setText(string)
     knownNames() -> Set<string>: identifiers that get an individual accent color
       instead of the generic variable color, if identColorFor gives a color.
       An example is formulaBuilder.js: a referenced formula has the same color as its own row.
     getCandidates() -> [{group,label,hint,desc,insertText,selStart,selEnd,
       onAccept?() -> string|void,kind}]: autocomplete (filtered by identifier prefix)
       and function palette (not filtered, button .expr-palette-btn, if it exists).
       onAccept is an optional hook for candidates whose insertion needs more than plain text.
       An example is formulaBuilder.js: the selection of a column creates a variable if needed
       and inserts its alias.
       If the return value is not null or undefined, it REPLACES insertText, selStart and selEnd.
     identColorFor(label) -> string|null: optional. An individual accent color for a plain
     identifier (in knownNames()).
     onRevalidate(): debounced (150 ms) after each change of the content.
   The module attaches to rowEl.querySelector('.expr-input-wrap'):
     wrap.__exprRefreshHighlight(errPos): an outside caller (validation) uses it to add an error
     position (red wavy line) later. */
(function (GZ) {
  'use strict';
  const { esc } = GZ.format;

  // Debounce timer ONLY for the own revalidation of this module.
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

  // Builds the editor content (plain, colored text) again for the current expression text.
  // errPos marks the faulty token (red wavy line).
  // identColorFor colors known identifier references individually (see the header comment).
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

  // DOM -> expression text. expr-tok-err-eof is a purely decorative end mark (see
  // buildEditorDom()). It is not real content.
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

  // Converts a native DOM position (node plus child node or character index, as a Range or
  // Selection end point gives it)
  // into a character index in the expression text.
  // Returns null if the container is not inside el.
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
    } catch (e) { /* The selection stays at the end. This is not a hard error. */ }
  }

  // Builds the editor content again from `text`.
  // If the field keeps the focus AND preserveCaret is true (default, for normal typing and
  // revalidation),
  // the code keeps the cursor position.
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

  // Wires the expression editor, the error marking, the autocomplete
  // (while typing, filtered by identifier prefix) and the function palette (button "ƒ", not
  // filtered)
  // for ONE expression field. For opts, see the file header comment.
  // Call it again for each row each time the surrounding innerHTML is rebuilt (and so all DOM
  // nodes).
  function setup(rowEl, opts) {
    const wrap = rowEl.querySelector('.expr-input-wrap');
    if (!wrap) return;
    const el = wrap.querySelector('.expr-editor');
    const dropdown = wrap.querySelector('.expr-autocomplete');
    // It searches rowEl and not wrap (a superset).
    // So the caller can put the ƒ button outside of .expr-input-wrap
    // (for example in formulaBuilder.js: in the card head and not next to the editor).
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

    // .expr-autocomplete is position:fixed and not :absolute on purpose (see components.css).
    // This avoids the overflow:hidden of .panel (for the rounded corners).
    // That overflow would cut off an absolutely positioned dropdown hard at the panel edge.
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

    // Substring search and not only a prefix search (matches at the start of a word come first).
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

    // ---------- Undo and redo (Ctrl+Z / Ctrl+Y or Ctrl+Shift+Z)
    // The native undo stack of the browser is not usable here (see the file header comment).
    // The module has its own slim history on MODEL level (text plus cursor position).
    // Typing in sequence is grouped by time (COALESCE_MS).
    // So an undo does not go back character by character, but by whole typing groups.
    // An explicit insertion (dropdown or palette) is always its own step.
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

    // The central place for EVERY change of the content (typing, insertion from the dropdown or
    // palette):
    // synchronize the model, render the editor again, trigger the revalidation.
    // caretMode 'preserve' = keep the current cursor position (normal typing).
    // {offset} or {range:[start,end]} = set the cursor explicitly (insertion).
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

    // Replaces [rStart,rEnd) in the current text with insertText.
    // Then it selects [selStart,selEnd) of it, so the user can overwrite placeholders directly.
    function insertAtSelection(rStart, rEnd, insertText, selStart, selEnd) {
      pushHistory(false); // An explicit insertion is its own undo step.
      const val = getText();
      const newText = val.slice(0, rStart) + insertText + val.slice(rEnd);
      el.focus();
      applyText(newText, { range: [rStart + selStart, rStart + selEnd] });
    }

    function accept(item, start, end) {
      // Candidates with onAccept() (for example formulaBuilder.js: a column and not a primitive,
      // function, state or variable:
      // first resolve or create the alias, then insert it like a normal variable)
      // COMPLETELY REPLACE insertText, selStart and selEnd with the return value.
      let insertText = item.insertText, selStart = item.selStart, selEnd = item.selEnd;
      if (item.onAccept) {
        const resolved = item.onAccept();
        if (resolved != null) { insertText = resolved; selStart = resolved.length; selEnd = resolved.length; }
      }
      closeDropdown();
      insertAtSelection(start, end, insertText, selStart, selEnd);
    }

    el.addEventListener('input', () => {
      pushHistory(true); // Merge continuous typing into one group.
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
      // Handle undo and redo before everything else. The native browser undo does not work here
      // (see the file header comment).
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) { e.preventDefault(); closeDropdown(); undo(); return; }
      if (mod && ((e.key === 'y' || e.key === 'Y') || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))) { e.preventDefault(); closeDropdown(); redo(); return; }
      if (!dropdown.hidden) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { if (acceptActiveOrFirst()) { e.preventDefault(); return; } }
        else if (e.key === 'Escape') { closeDropdown(); return; }
      }
      if (e.key === 'Enter') { e.preventDefault(); return; } // Single line. No line break.
    });
    el.addEventListener('blur', () => {
      setTimeout(closeDropdown, 150);
      refresh(null, { preserveCaret: false });
    });
    if (paletteBtn) {
      // preventDefault on mousedown stops the button from taking the focus from the editor.
      // Otherwise the blur handler would close the list, which openPalette() just opened, about 150
      // ms later.
      paletteBtn.addEventListener('mousedown', e => e.preventDefault());
      paletteBtn.onclick = openPalette;
    }

    refresh(null, { preserveCaret: false });
  }

  GZ.exprEditor = { setup };
})(window.GZ = window.GZ || {});
