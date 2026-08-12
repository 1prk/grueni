/* GZ.exprEditor — wiederverwendbarer Ausdrucks-Editor: echte, interaktive
   Chips (contenteditable) statt gefärbtem Text - erkannte Symbole
   (Funktionsaufrufe, Zustände, bekannte Bezeichner) werden als atomare, per
   "×"-Button entfernbare Chip-Elemente gerendert (contenteditable="false"),
   alles andere (Zahlen, Operatoren, Klammern, AND/OR/NOT, Werte, noch
   unbekannte/unfertige Bezeichner) bleibt normal editierbarer, nur
   eingefärbter Text ("freier Text für Werte etc."). Baut auf GZ.exprEngine
   auf (derselbe Lexer wie das tatsächliche Parsen), ist aber unabhängig
   davon, WAS die Ausdrücke bedeuten - formulaBuilder.js (Umlaufprüfung) und
   oepnvQa.js (ÖPNV-Zeilenfilter) nutzen dasselbe Modul mit jeweils eigenen
   Symbol-Listen/Modell-Feldern.

   Ersetzt den ursprünglichen "unsichtbarer <input> über farbigem <div>"-
   Overlay-Trick vollständig - der hatte einen strukturellen Makel: Text-
   Selektion wird von manchen Browsern trotz color:transparent sichtbar
   gerendert und lag dann als zweite, überlappende Ebene über dem Highlight
   darunter ("Offset"/"Hintergrundtext"-Effekt).

   Modell: Quelle der Wahrheit bleibt der reine Ausdruckstext beim Aufrufer
   (opts.getText()/setText()) - der Editor wird bei jeder Änderung aus
   diesem Text NEU gerendert (siehe refreshEditorContent()), nie umgekehrt.
   Ein Token wird zum Chip, wenn es eindeutig einem bekannten Symbol
   entspricht: Zustands-Literal (KATLIT, exakte Schreibweise), Funktions-
   aufruf (IDENT unmittelbar gefolgt von "("), oder ein Bezeichner, der
   exakt einem vom Aufrufer als bekannt gemeldeten Namen entspricht (siehe
   opts.knownNames()). Damit ein Bezeichner nicht MITTEN im Tippen schon
   "einrastet" (z.B. "K1" während man eigentlich "K10" schreiben will), wird
   das Token, das der Cursor GERADE berührt, von der Chip-Bildung
   ausgenommen, solange das Feld fokussiert ist (siehe "touching"-Prüfung in
   buildEditorDom()) - erst nach Verlassen der Stelle (oder beim Verlassen
   des Feldes) rastet es als Chip ein. Chips aus Dropdown/Palette/Sidebar
   (siehe accept() weiter unten) entstehen dagegen SOFORT, unabhängig von
   der Cursorposition - das ist eine bewusste, klare Handlung.

   setup(rowEl, opts) - opts:
     getText()->string, setText(string)
     knownNames()->Set<string>
     getCandidates()->[{group,label,hint,desc,insertText,selStart,selEnd,
       argRanges?, onAccept?()->string|void}] - Autovervollständigung (nach
       Bezeichner-Präfix gefiltert)/Funktions-Palette (ungefiltert). onAccept
       ist ein optionaler Hook für Kandidaten, deren Einfügen mehr als reinen
       Text braucht (z.B. formulaBuilder.js: eine Spalte auswählen legt bei
       Bedarf automatisch eine Variable an und fügt deren Alias statt des
       Spaltennamens ein) - der Rückgabewert ERSETZT insertText/selStart/
       selEnd (als reiner Bezeichner, ohne Platzhalter-Selektion/argRanges),
       wenn nicht null/undefined. argRanges (optional, [{start,end}, ...]
       relativ zum Anfang von insertText, selStart/selEnd entspricht
       argRanges[0]): bei mehr als einem Eintrag öffnet das Einfügen eine
       Tabstop-Kette - klickt man den GERADE selektierten Platzhalter direkt
       mit einem weiteren Kandidaten zu (Primitive -> Objekt -> Zustand, z.B.
       "DauerSeit(#objekt#,zustand)" -> "DauerSeit(K1,#zustand#)" ->
       "DauerSeit(K1,GRUEN)"), springt die Selektion automatisch zum
       nächsten offenen Platzhalter weiter (siehe insertAtSelection() unten)
       - Tippen oder ein Klick außerhalb der Kette gibt sie auf, ohne die
       Einfügung selbst zu beeinträchtigen.
     onRevalidate() - debounced (150ms) nach jeder inhaltlichen Änderung.
   Hängt an rowEl.querySelector('.expr-input-wrap'):
     wrap.__exprRefreshHighlight(errPos) - von außen (Validierung) genutzt,
       um nachträglich eine Fehlerposition einzuzeichnen.
     wrap.__exprInsertAt(text, selStart, selEnd)->boolean - von außen (z.B.
       einer Symbol-Sidebar) genutzt, um die AKTUELLE Selektion (Platzhalter
       oder Cursor) zu ersetzen, ohne Interna dieser Zeile zu kennen; liefert
       false, wenn das Feld gerade keine Selektion hat (z.B. nicht
       fokussiert). Nimmt an derselben Tabstop-Kette teil wie Klicks aus dem
       Dropdown/der Palette (siehe argRanges oben). */
(function (GZ) {
  'use strict';
  const { esc } = GZ.format;

  // Debounce-Zeitgeber NUR für die eigene Nachvalidierung dieses Moduls
  // (Schlüssel: das jeweilige .expr-editor-Element) - bewusst ein eigenes,
  // internes Map statt eines vom Aufrufer hereingereichten, damit dieses
  // Modul komplett unabhängig von dessen sonstigen Debounce-Zwecken bleibt.
  const debounceTimers = new Map();

  // TX ist in formulaBuilder.js reserviert (immer implizit, nie selbst zu
  // vergeben) - wie AND/OR/NOT eingefärbt statt wie eine normale Variable/
  // ein Chip, damit optisch klar bleibt, dass es nichts ist, was man selbst
  // benennen/zuweisen muss. Gilt pauschal für jeden Aufrufer dieses Moduls;
  // harmlos, falls ein anderer Aufrufer zufällig auch ein Feld "TX" nennt
  // (zeigt es dann eben als Schlüsselwort-Text statt als Chip an).
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

  // Soll dieses Token als Chip gerendert werden (siehe Kopfkommentar oben)?
  // knownNames: Set<string> - vom Aufrufer als bekannt gemeldete Namen.
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

  // Baut den Editor-Inhalt (Text + Chips) für den aktuellen Ausdruckstext
  // neu - errPos markiert (wie zuvor) das fehlerhafte Token (Chip: roter
  // Rahmen; Text: rote Wellenlinie). excludeCaret: Zeichenposition, deren
  // Token NIE zum Chip wird (siehe Kopfkommentar), oder null (alles
  // Erkannte wird Chip - für initiales Rendern/Verlassen des Feldes/
  // explizites Einfügen).
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
      eofSpan.textContent = ' ';
      frag.appendChild(eofSpan);
    }
    return frag;
  }

  // DOM -> Ausdruckstext (Chips liefern ihr eigenes Label, sonst textContent
  // - robust gegenüber leicht unordentlicher Zwischenstruktur, die der
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
  // (durch serializeEditor() gelieferten) Ausdruckstext um - null, wenn
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
  // Cursorposition abgeleitet zu werden (siehe setup()'s lastExcludeCaret -
  // der eigentliche Grund dafür steht dort). Ist preserveCaret false
  // (explizites Einfügen/Entfernen via accept()/Chip-"×"/blur), wird
  // excludeCaret IMMER ignoriert (auf null erzwungen) - der Aufrufer setzt
  // dort die neue Cursorposition ohnehin selbst (siehe setCaretOffset()/
  // setCaretRange() oben).
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
    // Klick auf den Chip SELBST (nicht auf sein "×") = "diesen Baustein
    // austauschen": Chips sehen wie greifbare Bausteine aus, verhielten sich
    // aber wie reine Einfärbung - man musste sie löschen und neu einfügen.
    // Jetzt öffnet ein Klick die Auswahlliste, auf den Chip-Bereich
    // beschränkt und auf art-gleiche Kandidaten gefiltert (siehe
    // 'gz-chip-replace' in setup()).
    el.querySelectorAll('.expr-chip').forEach(chip => {
      chip.onmousedown = ev => ev.preventDefault(); // Fokus/Selektion im Editor halten
      chip.onclick = ev => {
        if (ev.target.closest('.expr-chip-remove')) return; // "×" hat eigene Bedeutung
        ev.preventDefault();
        ev.stopPropagation();
        el.dispatchEvent(new CustomEvent('gz-chip-replace', { detail: { chip } }));
      };
    });
  }

  // Welche Kandidaten-Art passt zu einem angeklickten Chip? Leitet sich aus
  // der Token-Klasse ab, die classifyToken() ohnehin schon vergibt - so
  // braucht der Editor keinerlei Kenntnis des Typsystems seines Aufrufers.
  const CHIP_KIND_BY_CLASS = { 'expr-tok-kat': 'kat', 'expr-tok-func': 'func', 'expr-tok-var': 'var' };
  function chipKind(chipEl) {
    for (const cls in CHIP_KIND_BY_CLASS) if (chipEl.classList.contains(cls)) return CHIP_KIND_BY_CLASS[cls];
    return null;
  }

  // Verdrahtet den Chip-Editor, Fehler-Markierung, Autovervollständigung
  // (beim Tippen, gefiltert nach Bezeichner-Präfix) und die Funktions-
  // Palette (Button "ƒ", ungefiltert) für EIN Ausdrucks-Feld - siehe
  // Datei-Kopfkommentar für opts. Sollte pro Zeile bei jedem Neuaufbau des
  // umgebenden innerHTML (und damit aller DOM-Knoten) erneut aufgerufen
  // werden.
  function setup(rowEl, opts) {
    const wrap = rowEl.querySelector('.expr-input-wrap');
    if (!wrap) return;
    const el = wrap.querySelector('.expr-editor');
    const dropdown = wrap.querySelector('.expr-autocomplete');
    const paletteBtn = wrap.querySelector('.expr-palette-btn');
    const { getText, setText, knownNames, getCandidates, onRevalidate } = opts;

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
    // Externer Einfüge-Hook (z.B. für eine Symbol-Sidebar) - fügt anstelle
    // der AKTUELLEN Selektion ein (siehe insertAtSelection() unten), ohne
    // dass der Aufrufer Interna dieser Zeile (Modell-Feld, Debounce,
    // Tabstop-Kette...) kennen muss. Liefert false, wenn das Feld gerade
    // keine Selektion hat (z.B. nicht fokussiert).
    wrap.__exprInsertAt = (text, selStart, selEnd, argRanges) => {
      const sel = getCaretSelection(el);
      if (sel == null) return false;
      insertAtSelection(sel.start, sel.end, text, selStart, selEnd, argRanges || null);
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

    // Teilstring- statt reiner Präfixsuche (Treffer am Wortanfang zuerst) -
    // "seit" findet so auch "DauerSeit", ohne dass man den Namensanfang
    // kennen muss. Die Gruppenreihenfolge der Kandidatenliste bleibt
    // innerhalb der beiden Ränge erhalten (stabile Sortierung).
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
      // Ganze aktuelle Selektion (nicht nur ihren Anfang) übernehmen - steht
      // z.B. gerade ein Platzhalter wie "objekt" markiert (siehe
      // insertAtSelection()-Kopfkommentar), muss ein Klick auf einen
      // Palette-Eintrag genau IHN ersetzen, nicht bloß davor einfügen.
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
    // Der native Undo-Stack des Browsers ist hier unbrauchbar: der Editor
    // baut sein DOM bei JEDER Änderung komplett neu aus dem Modelltext auf
    // (siehe refreshEditorContent()), wodurch der Browser seine eigene
    // Historie verwirft - Ctrl+Z war schlicht wirkungslos. Stattdessen eine
    // eigene, schlanke Historie auf MODELLEBENE (Text + Cursorposition).
    // Aufeinanderfolgendes Tippen wird zeitlich zusammengefasst (COALESCE_MS),
    // damit ein Undo nicht Zeichen für Zeichen zurückgeht, sondern - wie in
    // üblichen Editoren - ganze Tippgruppen; explizite Einfügungen (Palette/
    // Sidebar/Chip entfernen) bilden dagegen immer einen eigenen Schritt.
    const HISTORY_LIMIT = 100, COALESCE_MS = 600, COALESCE_MAX_CHARS = 20;
    let undoStack = [], redoStack = [], lastPushAt = 0, groupBaseLen = 0, suppressHistory = false;
    const snapshot = () => ({ text: getText(), caret: getCaretOffset(el) });
    function pushHistory(coalesce) {
      if (suppressHistory) return;
      const now = Date.now();
      // Tippgruppe fortsetzen, solange kurz hintereinander UND nicht zu viel
      // Text seit ihrem Beginn - Letzteres verhindert, dass schnelles
      // Durchtippen eines ganzen Ausdrucks zu EINEM einzigen Undo-Schritt
      // wird (dann würde Ctrl+Z alles auf einmal wegnehmen).
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
      clearPendingArgs();
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
      lastPushAt = 0; // nächste Tippgruppe beginnt frisch
      return true;
    }
    function redo() {
      if (!redoStack.length) return false;
      undoStack.push(snapshot());
      restore(redoStack.pop());
      lastPushAt = 0;
      return true;
    }

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

    // Tabstop-Kette (VS-Code-Snippet-Gefühl): argRanges eines gerade
    // eingefügten mehrargumentigen Templates (Primitive/eigene Funktion mit
    // >1 Parameter, siehe exprCandidates() in formulaBuilder.js) - als
    // ABSOLUTE Zeichenbereiche im aktuellen Text, pendingArgIdx zeigt auf
    // den GERADE selektierten/offenen Platzhalter. Nur hier (in dieser
    // Zeile) gültig, kein modulweiter/globaler Zustand.
    // pendingEnd: Ende des GESAMTEN eingefügten Templates (z.B. hinter dem
    // ")" von "DauerSeit(...)"), fortlaufend um die Längenänderungen der
    // ausgefüllten Platzhalter korrigiert. Ist der letzte Platzhalter
    // gefüllt, springt der Cursor dorthin - sonst bliebe er INNERHALB der
    // Klammern stehen und der nächste Klick (z.B. auf ">") landete mitten im
    // Funktionsaufruf statt dahinter.
    let pendingArgs = null, pendingArgIdx = 0, pendingEnd = null;
    function clearPendingArgs() { pendingArgs = null; pendingArgIdx = 0; pendingEnd = null; }

    // Ersetzt [rStart,rEnd) im aktuellen Text durch insertText - Kernstück
    // des Klick-Workflows "Primitive wählen -> Objekt wählen -> Zustand
    // wählen" (siehe Datei-Kopfkommentar zu accept()/__exprInsertAt):
    // entspricht [rStart,rEnd) GENAU dem aktuell offenen Platzhalter einer
    // laufenden Kette (pendingArgs[pendingArgIdx]), springt die Selektion
    // nach dem Einfügen automatisch zum NÄCHSTEN offenen Platzhalter
    // DESSELBEN Templates weiter, statt nur den fest übergebenen
    // selStart/selEnd zu übernehmen - bis alle Platzhalter durch sind, dann
    // landet der Cursor (wie bisher) hinter dem zuletzt eingefügten Text.
    // Jede andere Einfügung/Bearbeitung (Klick/Tipp außerhalb der Kette)
    // gibt die Kette stillschweigend auf (clearPendingArgs()). argRanges
    // (optional, relativ zum Anfang von insertText): eröffnet bei >1
    // Einträgen eine NEUE Kette für das GERADE eingefügte Template - löst
    // eine evtl. noch laufende alte Kette dabei bewusst ab.
    function insertAtSelection(rStart, rEnd, insertText, selStart, selEnd, argRanges) {
      pushHistory(false); // explizites Einfügen = eigener Undo-Schritt
      const val = getText();
      const newText = val.slice(0, rStart) + insertText + val.slice(rEnd);
      el.focus();

      const wasPendingSlot = pendingArgs && pendingArgIdx < pendingArgs.length &&
        pendingArgs[pendingArgIdx].start === rStart && pendingArgs[pendingArgIdx].end === rEnd;
      let finishedAt = null;
      if (wasPendingSlot) {
        const delta = insertText.length - (rEnd - rStart);
        for (let k = pendingArgIdx + 1; k < pendingArgs.length; k++) {
          pendingArgs[k] = { start: pendingArgs[k].start + delta, end: pendingArgs[k].end + delta };
        }
        if (pendingEnd != null) pendingEnd += delta;
        pendingArgIdx++;
        if (pendingArgIdx >= pendingArgs.length) finishedAt = pendingEnd; // Kette fertig -> hinter das Template
      } else {
        clearPendingArgs();
      }
      if (argRanges && argRanges.length) {
        pendingArgs = argRanges.map(r => ({ start: rStart + r.start, end: rStart + r.end }));
        pendingArgIdx = 0;
        pendingEnd = rStart + insertText.length;
        finishedAt = null;
      }

      const active = (pendingArgs && pendingArgIdx < pendingArgs.length) ? pendingArgs[pendingArgIdx] : null;
      if (!active) clearPendingArgs();
      const fallback = finishedAt != null ? [finishedAt, finishedAt] : [rStart + selStart, rStart + selEnd];
      applyText(newText, { range: active ? [active.start, active.end] : fallback });
    }

    function accept(item, start, end) {
      // Kandidaten mit onAccept() (z.B. formulaBuilder.js: eine Spalte statt
      // Primitive/Funktion/Zustand/Variable - erst Alias auflösen/anlegen,
      // dann wie eine normale Variable einfügen, reiner Bezeichner ohne
      // Klammern/Platzhalter-Selektion) ERSETZEN insertText/selStart/selEnd
      // komplett durch den Rückgabewert (und tragen daher nie eigene
      // Platzhalter/argRanges).
      let insertText = item.insertText, selStart = item.selStart, selEnd = item.selEnd, argRanges = item.argRanges || null;
      if (item.onAccept) {
        const resolved = item.onAccept();
        if (resolved != null) { insertText = resolved; selStart = resolved.length; selEnd = resolved.length; argRanges = null; }
      }
      closeDropdown();
      insertAtSelection(start, end, insertText, selStart, selEnd, argRanges);
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
      clearPendingArgs(); // manuelles Entfernen ist außerhalb der Klick-Kette
      pushHistory(false);
      applyText(val.slice(0, start) + val.slice(end), { offset: start });
    });

    // Chip anklicken = austauschen (siehe wireChipRemovers()/chipKind()):
    // Auswahlliste über GENAU dem Zeichenbereich dieses Chips öffnen, auf
    // art-gleiche Kandidaten gefiltert (ein Zustands-Chip bietet Zustände an,
    // ein Funktions-Chip Funktionen, ein Variablen-Chip Variablen/Objekte).
    // Ein Funktions-Chip trägt dabei nur seinen NAMEN als Bereich - die
    // Klammern/Argumente dahinter bleiben unangetastet, weshalb für ihn
    // ausnahmsweise nur der reine Bezeichner (ohne "(...)") eingesetzt wird.
    el.addEventListener('gz-chip-replace', e => {
      const chip = e.detail.chip;
      if (!chip) return;
      const before = [];
      for (const child of el.childNodes) { if (child === chip) break; before.push(child); }
      const start = before.reduce((sum, n) => sum + nodeTextLength(n), 0);
      const end = start + nodeTextLength(chip);
      const kind = chipKind(chip);
      let items = getCandidates();
      if (kind) items = items.filter(c => c.kind === kind);
      if (kind === 'func') {
        // Nur den Namen ersetzen, vorhandene Argumentliste behalten.
        items = items.map(c => ({ ...c, insertText: c.label, selStart: c.label.length, selEnd: c.label.length, argRanges: null }));
      }
      if (!items.length) return;
      el.focus();
      clearPendingArgs();
      setCaretRange(el, start, end); // sichtbar markieren, WAS ersetzt wird
      renderDropdown(items, start, end);
    });

    el.addEventListener('input', () => {
      applyTextFromDom();
    });
    function applyTextFromDom() {
      clearPendingArgs(); // freies Tippen verlässt die Klick-Kette (siehe insertAtSelection())
      pushHistory(true);  // zusammenhängendes Tippen zu einer Gruppe zusammenfassen
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
      const sel = getCaretSelection(el);
      if (sel == null) return;
      clearPendingArgs(); // Einfügen per Zwischenablage ist außerhalb der Klick-Kette
      pushHistory(false);
      const val = getText();
      const newText = val.slice(0, sel.start) + text + val.slice(sel.end);
      applyText(newText, { offset: sel.start + text.length });
    });
    el.addEventListener('keydown', e => {
      // Rückgängig/Wiederholen vor allem anderen behandeln (siehe
      // pushHistory()/undo() oben) - der native Browser-Undo greift hier
      // nicht, da der Editor bei jeder Änderung neu aufgebaut wird.
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
      clearPendingArgs();
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

  GZ.exprEditor = { setup };
})(window.GZ = window.GZ || {});
