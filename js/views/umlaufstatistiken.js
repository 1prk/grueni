/* GZ.views.umlaufstatistiken — Tab "Umlaufstatistiken": beliebig viele
   selbst definierte Spalten (Bezeichnung + Formel in der GZ.exprEngine-
   Ausdruckssprache - derselben, die auch der Formel-Builder in
   Umlaufprüfung nutzt, siehe js/core/exprEngine.js/umlaufContext.js), je
   einmal ausgewertet über ALLE Umläufe der Aufzeichnung. Ergebnis: eine
   gefensterte Tabelle (Performance bei vielen Umläufen, wie
   js/views/umlaufpruefung.js) + eine Aggregatstatistik-Tabelle je Spalte
   (Zahl -> Ø/Median/StdAbw/Min/Max/P85, Wahr/Falsch -> Anteil) + Excel-
   Export (beide Tabellen, IMMER über die komplette Aufzeichnung, unabhängig
   vom sichtbaren Fenster). Dieselben Spalten erscheinen ZUSÄTZLICH als
   eigene KENNZAHL-Spur in der vereinheitlichten Objekt-Liste des Tabs
   "Umlaufprüfung" (siehe getSyntheticColumns() unten sowie dortiges
   kennzahlCols()/traceMeta) - dort als Balken im zeitlichen Kontext der
   Signalgruppen, hier als vollständige Tabelle zum genauen Ablesen/Export.

   Anders als der zeilenweise Formel-Builder (eine boolesche Rohreihe je
   Formel, Primitiven Zustand/Dauer/DauerSeit) wertet dieser Tab GENAU EINMAL
   JE UMLAUF aus und lässt beliebige Ergebnistypen zu (GZ.exprEngine.
   compileValue() statt compile()) - die Primitiven An/Ab/TF/RG/GE/
   Ausgeloest/AnzahlAusloesungen lesen dafür aus handle.cycleMetrics statt
   handle.sweep (siehe GZ.umlaufContext.buildAll()). WertBei(det, zeitpunkt)
   liest stattdessen über handle.rawSample() den tatsächlichen Rohwert (z.B.
   einen APW-Countdown) zu einem beliebigen Zeitpunkt im Umlauf - meist
   selbst wieder ein An/Ab/TF/RG/GE-Aufruf, z.B. WertBei(APW_01, Ab(K1)).
   Zustand/Dauer/DauerSeit sind hier bewusst NICHT nutzbar (kein
   wohldefinierter "aktueller Zeitpunkt" für einen ganzen Umlauf) - siehe
   findPerRowOnlyUsage().

   Einige Primitiven (TF/RG/GE/Versatz/Ueberschneidung) haben zusätzlich zu
   ihrem Zahlen-/Wahrheitswert eine eindeutige ZEITSPANNE innerhalb des
   Umlaufs (z.B. Versatz(K1,K2): von Abwurf K1 bis Anwurf K2) - exprEngine.js
   liefert die optional über compileValue().spanRun mit, hier je Umlauf
   ausgewertet (evaluated[].spans) und über getSyntheticColumns() weiter-
   gereicht, damit die Kennzahl-Spur in der Umlaufprüfung den Balken exakt
   über diese Spanne zeichnen kann statt über die ganze Zeile (siehe dortiger
   Kommentar zu tr.span). Nur vorhanden, wenn der GESAMTE Spaltenausdruck
   genau einer dieser Primitiven-Aufrufe ist (nicht etwa in eine Rechnung
   eingebettet) - sonst bleibt spans null und die Spur fällt dort auf die
   volle Zeilenbreite zurück. */
(function (GZ) {
  'use strict';
  const { esc, fmtTs, fmtTimeShort } = GZ.format;
  const { mean, median, stdDev, percentile } = GZ.stats;

  const KENNZAHL_INDEX_BASE = 2000000; // eigener Bereich, unabhängig von formulaBuilder.js' SYNTH_INDEX_BASE

  let els = null;
  let nextColId = 1;
  let ctxAll = null; // {index, cycles} - einmal je Analyse gebaut (GZ.umlaufContext.buildAll)
  let evaluated = []; // parallel zu GZ.state.data.umlaufSpalten: {col, error, incomplete, values, spans, kind, skip}
  let windowCount = 25, windowStartIdx = 0, showAll = false;

  // Aktueller Autocomplete-Zustand - es ist immer höchstens ein Dropdown
  // gleichzeitig offen (das des fokussierten Ausdrucksfelds).
  let acItems = [], acActive = -1, acRange = null;

  // Aus GZ.exprEngine.PRIMITIVE_INFO abgeleitet statt hier separat gepflegt -
  // EINZIGE Stelle, die "welche Primitive erwartet SG/DET als Argument bzw.
  // ist nur zeilenweise nutzbar" kennt, ist das objArgType/perRowOnly-Feld
  // dort (siehe Kommentar an PRIMITIVE_INFO); ein neues Primitiv wird so
  // automatisch hier mitberücksichtigt, ohne dass diese Datei angefasst
  // werden muss.
  const PRIMITIVE_INFO = GZ.exprEngine.PRIMITIVE_INFO;
  const SG_ARG_FNS = new Set(PRIMITIVE_INFO.filter(p => p.objArgType === 'SG').map(p => p.name));
  const DET_ARG_FNS = new Set(PRIMITIVE_INFO.filter(p => p.objArgType === 'DET').map(p => p.name));
  // Zeilenweise Primitiven des Formel-Builders (perRowOnly) - hier
  // syntaktisch zwar bekannt (gemeinsamer PRIMITIVES-Katalog), aber ohne
  // handle.sweep würde ihr Aufruf zur Laufzeit abstürzen statt einen Wert zu
  // liefern. Wird VOR der Auswertung geprüft (siehe findPerRowOnlyUsage()),
  // nicht erst beim Absturz bemerkt - daher aus US_FUNCTIONS ausgeschlossen.
  const PER_ROW_ONLY_FNS = new Set(PRIMITIVE_INFO.filter(p => p.perRowOnly).map(p => p.name));
  const US_FUNCTIONS = PRIMITIVE_INFO.filter(p => !p.perRowOnly).map(p => p.name);
  const US_SCALARS = ['TU', 'TU_MED', 'SPL'];

  // exprEngine.js meldet unbekannte Namen ohne Vorschlag ("Unbekannte
  // Variable/Funktion "X""). Für Umlaufstatistiken lokal um eine "meinten
  // Sie …?"-Ergänzung per Editierdistanz erweitert, statt den gemeinsamen
  // Formel-Builder-Motor dafür anzufassen.
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
      prev = cur;
    }
    return prev[n];
  }
  function nearestMatch(name, candidates) {
    if (!candidates || candidates.length === 0) return null;
    const lname = String(name).toLowerCase();
    let best = null, bestD = Infinity;
    candidates.forEach(c => { const d = levenshtein(lname, String(c).toLowerCase()); if (d < bestD) { bestD = d; best = c; } });
    return bestD <= Math.max(2, Math.ceil(lname.length * 0.4)) ? best : null;
  }
  function enhanceErrorMessage(message) {
    const mVar = message.match(/^Unbekannte Variable "(.+)"$/);
    const mFn = message.match(/^Unbekannte Funktion "(.+)"$/);
    const name = mVar ? mVar[1] : (mFn ? mFn[1] : null);
    if (!name || !ctxAll) return message;
    const candidates = mVar ? ctxAll.index.sgList.concat(ctxAll.index.detList, US_SCALARS) : US_FUNCTIONS;
    const sug = nearestMatch(name, candidates);
    return sug ? `${message} — meinten Sie „${sug}“?` : message;
  }

  function init(root) {
    els = {
      root,
      addColBtn: root.querySelector('#usAddColBtn'),
      colRows: root.querySelector('#usColRows'),
      legendBody: root.querySelector('#usLegendBody'),
      hint: root.querySelector('#usHint'),
      tablePanel: root.querySelector('#usTablePanel'),
      diagramControls: root.querySelector('#usDiagramControls'),
      btnWinPrev: root.querySelector('#usBtnWinPrev'),
      winLabel: root.querySelector('#usWinLabel'),
      btnWinNext: root.querySelector('#usBtnWinNext'),
      winSize: root.querySelector('#usWinSize'),
      btnWinAll: root.querySelector('#usBtnWinAll'),
      tableHead: root.querySelector('#usTableHead'),
      tableBody: root.querySelector('#usTableBody'),
      statsPanel: root.querySelector('#usStatsPanel'),
      statsBody: root.querySelector('#usStatsBody'),
      exportBtn: root.querySelector('#usExportBtn')
    };

    els.addColBtn.addEventListener('click', addColumn);
    els.btnWinPrev.addEventListener('click', () => {
      if (showAll || !ctxAll) return;
      windowStartIdx = Math.max(0, windowStartIdx - windowCount);
      renderResultsTable(currentValidCols());
    });
    els.btnWinNext.addEventListener('click', () => {
      if (showAll || !ctxAll) return;
      const maxStart = Math.max(0, ctxAll.cycles.length - 1);
      windowStartIdx = Math.min(maxStart, windowStartIdx + windowCount);
      renderResultsTable(currentValidCols());
    });
    els.winSize.addEventListener('change', () => {
      const v = parseInt(els.winSize.value, 10);
      windowCount = Number.isFinite(v) && v > 0 ? v : 25;
      els.winSize.value = windowCount;
      renderResultsTable(currentValidCols());
    });
    els.btnWinAll.addEventListener('click', () => {
      showAll = !showAll;
      els.btnWinAll.textContent = showAll ? 'Fenster anzeigen' : 'Alle anzeigen';
      els.btnWinAll.classList.toggle('primary', showAll);
      renderResultsTable(currentValidCols());
    });
    els.exportBtn.addEventListener('click', exportXlsx);
  }

  // Neue Analyse: Spaltenliste bewusst zurückgesetzt (wie GZ.state.data.phases
  // in Stammdaten LSA) - Formeln beziehen sich auf konkrete Signalgruppen-/
  // Detektornamen der vorherigen Aufzeichnung und wären beim Wechsel auf eine
  // andere Anlage ohnehin hinfällig.
  function populateControls() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    GZ.state.data.umlaufSpalten = [];
    windowStartIdx = 0; showAll = false;
    els.btnWinAll.textContent = 'Alle anzeigen';
    els.btnWinAll.classList.remove('primary');
    ctxAll = GZ.umlaufContext.buildAll(a);
    renderLegend();
    renderColumns();
    recompute();
  }

  function addColumn() {
    if (!GZ.state.data.currentAnalysis) return;
    GZ.state.data.umlaufSpalten.push({ id: nextColId++, label: '', expr: '' });
    renderColumns();
    recompute();
  }

  function renderLegend() {
    if (!ctxAll) { els.legendBody.innerHTML = ''; return; }
    const sg = ctxAll.index.sgList.join(', ') || '–';
    const det = ctxAll.index.detList.join(', ') || '–';
    const fns = US_FUNCTIONS.join(', ');
    const scalars = US_SCALARS.join(', ');
    els.legendBody.innerHTML =
      `<div><b>Signalgruppen:</b> ${esc(sg)}</div>` +
      `<div><b>Detektor-/APW-Namen:</b> ${esc(det)}</div>` +
      `<div><b>Funktionen:</b> ${esc(fns)}(…)</div>` +
      `<div><b>Bezeichner:</b> ${esc(scalars)}</div>` +
      `<div style="margin-top:4px;color:var(--text-faint);">Zustand/Dauer/DauerSeit (Formel-Builder in Umlaufprüfung) sind hier nicht verfügbar - kein einzelner Zeitpunkt je Umlauf.</div>`;
  }

  /* ---------------- Spaltenzeilen (Bezeichnung + Formel) ---------------- */

  function renderColumns() {
    const cols = GZ.state.data.umlaufSpalten;
    els.colRows.innerHTML = cols.length ? cols.map(col => `
      <div class="us-col-row" data-col-id="${col.id}">
        <div class="us-col-row-head">
          <input type="text" class="us-col-label" placeholder="Bezeichnung, z. B. Versatz S1→S2" value="${esc(col.label)}">
          <button type="button" class="us-row-remove">✕ entfernen</button>
        </div>
        <div class="us-expr-wrap">
          <input type="text" class="us-col-expr" placeholder="z. B. Versatz(S1, S2)" value="${esc(col.expr)}" autocomplete="off" spellcheck="false">
          <ul class="us-autocomplete" hidden></ul>
        </div>
        <div class="us-col-error" hidden><div class="us-col-error-msg"></div><div class="us-col-error-snippet"></div></div>
      </div>`).join('')
      : '<div class="cfg-empty" style="margin:12px 16px 0;">Keine Spalte definiert – „+ Spalte hinzufügen“ klicken.</div>';

    els.colRows.querySelectorAll('.us-col-row').forEach(rowEl => {
      const id = rowEl.dataset.colId;
      const labelInput = rowEl.querySelector('.us-col-label');
      const exprInput = rowEl.querySelector('.us-col-expr');
      const listEl = rowEl.querySelector('.us-autocomplete');
      const findCol = () => GZ.state.data.umlaufSpalten.find(c => String(c.id) === id);
      let debounceTimer = null;
      const scheduleRecompute = () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(recompute, 300); };

      labelInput.addEventListener('input', () => { const c = findCol(); if (c) c.label = labelInput.value; scheduleRecompute(); });
      labelInput.addEventListener('blur', () => { clearTimeout(debounceTimer); recompute(); });

      exprInput.addEventListener('input', () => {
        const c = findCol(); if (c) c.expr = exprInput.value;
        showAutocomplete(exprInput, listEl);
        scheduleRecompute();
      });
      exprInput.addEventListener('focus', () => showAutocomplete(exprInput, listEl));
      exprInput.addEventListener('blur', () => {
        // Verzögert schließen, damit ein Klick auf einen Vorschlag (mousedown
        // feuert vor blur) noch als solcher ankommt, bevor die Liste weg ist.
        setTimeout(() => { listEl.hidden = true; }, 150);
        clearTimeout(debounceTimer);
        recompute();
      });
      wireExprKeyboard(exprInput, listEl);
      listEl.addEventListener('mousedown', e => {
        const li = e.target.closest('li');
        if (!li) return;
        e.preventDefault();
        clearTimeout(debounceTimer);
        acceptSuggestion(exprInput, listEl, acItems[Number(li.dataset.idx)]);
      });

      rowEl.querySelector('.us-row-remove').addEventListener('click', () => {
        GZ.state.data.umlaufSpalten = GZ.state.data.umlaufSpalten.filter(c => String(c.id) !== id);
        renderColumns();
        recompute();
      });
    });
  }

  /* ---------------- Autocomplete ---------------- */

  const AC_KIND_LABEL = { fn: 'Funktion', sg: 'Signalgruppe', det: 'Detektor/Wert', scalar: 'Bezeichner' };

  // Kontextsensitiv: innerhalb An(/Ab(/TF(/RG(/GE( -> Signalgruppennamen,
  // innerhalb Ausgeloest(/AnzahlAusloesungen( -> Detektor-/APW-Namen, sonst
  // Funktionen + skalare Bezeichner (TU/TU_MED/SPL). tokenize() liefert bei
  // einem (seltenen, während des Tippens meist irrelevanten) Lexer-Fehler
  // keine Teil-Token-Liste - in dem Fall werden schlicht keine Vorschläge
  // gezeigt, statt eine unvollständige Liste zu raten.
  function suggestAt(text, cursorPos, index) {
    let tokens;
    try { tokens = GZ.exprEngine.tokenize(text); }
    catch (e) { return { replaceStart: cursorPos, replaceEnd: cursorPos, items: [] }; }

    let replaceStart = cursorPos, replaceEnd = cursorPos, partial = '';
    const cur = tokens.find(t => t.type === 'IDENT' && t.pos <= cursorPos && cursorPos <= t.end);
    if (cur) { replaceStart = cur.pos; replaceEnd = cur.end; partial = text.slice(cur.pos, cursorPos); }

    const stack = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.pos >= replaceStart) break;
      if (t.type === '(') {
        const prevTok = tokens[i - 1];
        stack.push(prevTok && prevTok.type === 'IDENT' && prevTok.end === t.pos ? prevTok.value : null);
      } else if (t.type === ')') {
        stack.pop();
      }
    }
    const owner = stack.length ? stack[stack.length - 1] : null;

    let candidates;
    if (owner && SG_ARG_FNS.has(owner)) candidates = index.sgList.map(n => ({ value: n, label: n, kind: 'sg' }));
    else if (owner && DET_ARG_FNS.has(owner)) candidates = index.detList.map(n => ({ value: n, label: n, kind: 'det' }));
    else candidates = US_FUNCTIONS.map(n => ({ value: n, label: n + '(…)', kind: 'fn' }))
      .concat(US_SCALARS.map(n => ({ value: n, label: n, kind: 'scalar' })));

    const p = partial.toLowerCase();
    const items = candidates.filter(c => c.value.toLowerCase().startsWith(p)).slice(0, 8);
    return { replaceStart, replaceEnd, items };
  }

  function showAutocomplete(input, listEl) {
    if (!ctxAll) { listEl.hidden = true; return; }
    const s = suggestAt(input.value, input.selectionStart, ctxAll.index);
    acRange = { start: s.replaceStart, end: s.replaceEnd };
    acItems = s.items;
    acActive = -1;
    if (!acItems.length) { listEl.hidden = true; return; }
    listEl.innerHTML = acItems.map((it, idx) =>
      `<li data-idx="${idx}"><span>${esc(it.label)}</span><span class="us-ac-kind">${esc(AC_KIND_LABEL[it.kind] || '')}</span></li>`
    ).join('');
    listEl.hidden = false;
  }

  function highlightActive(listEl) {
    [...listEl.children].forEach((li, idx) => li.classList.toggle('active', idx === acActive));
  }

  function wireExprKeyboard(input, listEl) {
    input.addEventListener('keydown', e => {
      if (!listEl.hidden && acItems.length) {
        if (e.key === 'ArrowDown') { e.preventDefault(); acActive = (acActive + 1) % acItems.length; highlightActive(listEl); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); acActive = (acActive - 1 + acItems.length) % acItems.length; highlightActive(listEl); return; }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          acceptSuggestion(input, listEl, acItems[acActive >= 0 ? acActive : 0]);
          return;
        }
        if (e.key === 'Escape') { listEl.hidden = true; return; }
      }
      if (e.key === 'Enter') input.blur();
    });
  }

  function acceptSuggestion(input, listEl, item) {
    if (!item || !acRange) return;
    const val = input.value;
    const insertText = item.kind === 'fn' ? item.value + '(' : item.value;
    const before = val.slice(0, acRange.start);
    const after = val.slice(acRange.end);
    input.value = before + insertText + after;
    const cursor = before.length + insertText.length;
    listEl.hidden = true;
    acItems = []; acActive = -1; acRange = null;
    input.focus();
    input.setSelectionRange(cursor, cursor);
    const rowEl = input.closest('.us-col-row');
    const col = GZ.state.data.umlaufSpalten.find(c => String(c.id) === rowEl.dataset.colId);
    if (col) col.expr = input.value;
    recompute();
  }

  /* ---------------- Auswertung ---------------- */

  // Position eines Fehlers (ein einzelner Zeichen-Offset, siehe ExprError in
  // exprEngine.js) auf die Spanne des dort stehenden Tokens ausgeweitet, für
  // eine lesbare <mark>-Hervorhebung statt eines einzelnen Zeichens.
  function findTokenSpanAt(text, pos) {
    try {
      const tokens = GZ.exprEngine.tokenize(text);
      const tok = tokens.find(t => t.pos <= pos && pos < t.end) || tokens.find(t => t.pos === pos);
      if (tok && tok.end > tok.pos) return { start: tok.pos, end: tok.end };
    } catch (e) { /* Text selbst nicht tokenisierbar - Einzelzeichen-Fallback unten */ }
    return { start: pos, end: Math.min(pos + 1, text.length) };
  }

  function renderErrorSnippet(expr, pos) {
    const span = findTokenSpanAt(expr, pos);
    const s = Math.max(0, Math.min(span.start, expr.length));
    const e = Math.max(s, Math.min(span.end, expr.length));
    return esc(expr.slice(0, s)) + '<mark>' + (esc(expr.slice(s, e)) || ' ') + '</mark>' + esc(expr.slice(e));
  }

  function renderColumnError(rowEl, entry) {
    const errBox = rowEl.querySelector('.us-col-error');
    const exprInput = rowEl.querySelector('.us-col-expr');
    // "incomplete" = mitten im Tippen ein für sich unfertiger, aber kein
    // wirklich falscher Ausdruck (siehe ExprError.incomplete in
    // exprEngine.js) - bewusst NICHT als roter Fehler markiert, sonst
    // blinkt bei jedem Tastendruck eine Fehlermeldung auf.
    if (!entry || !entry.error || entry.incomplete) {
      errBox.hidden = true;
      exprInput.classList.remove('invalid');
      return;
    }
    exprInput.classList.add('invalid');
    errBox.hidden = false;
    errBox.querySelector('.us-col-error-msg').textContent = entry.error.message;
    errBox.querySelector('.us-col-error-snippet').innerHTML = renderErrorSnippet(exprInput.value, entry.error.pos);
  }

  function findPerRowOnlyUsage(text) {
    try {
      const tokens = GZ.exprEngine.tokenize(text);
      for (let i = 0; i < tokens.length - 1; i++) {
        if (tokens[i].type === 'IDENT' && PER_ROW_ONLY_FNS.has(tokens[i].value) && tokens[i + 1].type === '(') return tokens[i];
      }
    } catch (e) { /* Tokenize-Fehler übernimmt compileValue() bereits */ }
    return null;
  }

  function currentValidCols() { return evaluated.filter(e => !e.error && !e.skip && e.values); }

  function recompute() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    if (!ctxAll) ctxAll = GZ.umlaufContext.buildAll(a);

    if (!ctxAll.cycles.length) {
      els.tablePanel.style.display = 'none';
      els.statsPanel.style.display = 'none';
      els.exportBtn.disabled = true;
      els.hint.textContent = 'Zu wenige erkannte Umläufe (TX=0-Wechsel) für diese Auswertung.';
      els.hint.className = 'hint warn';
      return;
    }

    const cols = GZ.state.data.umlaufSpalten;
    evaluated = cols.map(col => {
      const expr = (col.expr || '').trim();
      if (!expr) return { col, error: null, incomplete: false, values: null, kind: null, skip: true };

      const guardTok = findPerRowOnlyUsage(expr);
      if (guardTok) {
        return {
          col, incomplete: false, values: null, kind: null, skip: false,
          error: { message: `„${guardTok.value}“ ist nur zeilenweise (Formel-Builder in Umlaufprüfung) verfügbar, nicht in Umlaufstatistiken.`, pos: guardTok.pos }
        };
      }

      const compiled = GZ.exprEngine.compileValue(expr, ctxAll.index.varTypes, {});
      if (!compiled.ok) {
        const message = compiled.incomplete ? compiled.message : enhanceErrorMessage(compiled.message);
        return { col, incomplete: !!compiled.incomplete, values: null, kind: null, skip: false, error: { message, pos: compiled.pos } };
      }
      const values = ctxAll.cycles.map(cyc => compiled.run(cyc.scope));
      const spans = compiled.spanRun ? ctxAll.cycles.map(cyc => compiled.spanRun(cyc.scope)) : null;
      const kind = compiled.resultType === 'NUM' ? 'number' : compiled.resultType === 'BOOL' ? 'bool' : 'text';
      return { col, error: null, incomplete: false, values, spans, kind, skip: false };
    });

    els.colRows.querySelectorAll('.us-col-row').forEach(rowEl => {
      const id = rowEl.dataset.colId;
      const entry = evaluated.find(e => String(e.col.id) === id);
      renderColumnError(rowEl, entry && !entry.skip ? entry : null);
    });

    const validCols = currentValidCols();
    renderResultsTable(validCols);
    renderStats(validCols);
    els.statsPanel.style.display = validCols.length ? '' : 'none';
    els.exportBtn.disabled = validCols.length === 0;

    const errCount = evaluated.filter(e => e.error && !e.incomplete).length;
    els.hint.textContent = cols.length === 0
      ? 'Bitte mindestens eine Spalte definieren.'
      : `${validCols.length} von ${cols.length} Spalte(n) gültig` + (errCount ? ` · ${errCount} mit Fehler` : '') + ` · ${ctxAll.cycles.length} Umlauf/Umläufe.`;
    els.hint.className = errCount ? 'hint warn' : 'hint';

    // Umlaufprüfung zeigt die gültigen Spalten als eigene KENNZAHL-Spur je
    // Umlauf an (siehe getSyntheticColumns() unten) - Objekt-Liste + Render
    // dort nach jeder Neuberechnung auffrischen, gleiches Muster wie
    // formulaBuilder.js berechnen(). Guard, da Umlaufprüfung beim Start in
    // beliebiger Reihenfolge zu diesem Modul initialisiert werden kann.
    if (GZ.views.umlaufpruefung) GZ.views.umlaufpruefung.refreshSyntheticColumns();
  }

  // Lesezugriff für umlaufpruefung.js (siehe dort kennzahlCols()): die
  // zuletzt berechneten, gültigen Spalten als synthetische KENNZAHL-Objekte -
  // EIN vorberechneter Wert je Umlaufindex (valuesByCycleIdx), nicht eine
  // Rohreihe je Messzeile wie FORMEL (siehe formulaBuilder.js
  // getSyntheticColumns()). index bleibt über Neuberechnungen hinweg stabil
  // (col.id), solange die Spalte nicht gelöscht/neu angelegt wird.
  // spansByCycleIdx: parallel zu valuesByCycleIdx, {startSec,endSec}|null je
  // Umlauf - nur gesetzt, wenn die Formel GENAU eine der Objekt-bezogenen
  // Primitiven ist (TF/RG/GE/Versatz/Ueberschneidung, siehe exprEngine.js
  // spanRun) - für die Balkendarstellung dort (tr.span).
  function getSyntheticColumns() {
    return currentValidCols().map(e => ({
      index: KENNZAHL_INDEX_BASE + e.col.id,
      kuerzel: 'KENNZAHL',
      name: e.col.label || '(ohne Bezeichnung)',
      beschreibung: e.col.expr,
      valuesByCycleIdx: e.values,
      spansByCycleIdx: e.spans,
      valueKind: e.kind
    }));
  }

  /* ---------------- Ergebnistabelle (gefenstert) ---------------- */

  function windowRange(n) {
    if (showAll || n <= 0) return { from: 0, to: n };
    const from = Math.max(0, Math.min(windowStartIdx, Math.max(0, n - 1)));
    return { from, to: Math.min(from + windowCount, n) };
  }

  function fmtNum(v) { return Number.isInteger(v) ? String(v) : v.toFixed(1); }
  function formatCellHtml(v) {
    if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) return '<span class="us-empty-cell">–</span>';
    if (typeof v === 'boolean') return v ? '<span class="us-bool-true">Wahr</span>' : '<span class="us-bool-false">Falsch</span>';
    if (typeof v === 'number') return esc(fmtNum(v));
    return esc(String(v));
  }

  function renderResultsTable(validCols) {
    if (!ctxAll || !ctxAll.cycles.length || validCols.length === 0) {
      els.tablePanel.style.display = 'none';
      els.diagramControls.style.display = 'none';
      return;
    }
    els.tablePanel.style.display = '';
    els.diagramControls.style.display = 'flex';

    const n = ctxAll.cycles.length;
    const { from, to } = windowRange(n);
    els.winLabel.textContent = showAll ? `Gesamte Aufzeichnung (${n} Umläufe)` : `Umlauf ${from + 1}–${to} von ${n}`;
    els.btnWinPrev.disabled = showAll || from <= 0;
    els.btnWinNext.disabled = showAll || to >= n;
    els.winSize.disabled = showAll;

    els.tableHead.innerHTML = `<tr><th>#</th><th>Start</th><th>SPL</th><th>TU</th>${
      validCols.map(c => `<th>${esc(c.col.label || '(ohne Bezeichnung)')}</th>`).join('')
    }</tr>`;

    const rows = [];
    for (let i = from; i < to; i++) {
      const cyc = ctxAll.cycles[i];
      const cells = [String(i + 1), fmtTimeShort(cyc.start), esc(cyc.SPL || '–'), String(cyc.TU)]
        .concat(validCols.map(c => formatCellHtml(c.values[i])));
      rows.push(`<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`);
    }
    els.tableBody.innerHTML = rows.join('');
  }

  /* ---------------- Statistik ---------------- */

  function numStats(vals) {
    const sorted = [...vals].sort((a, b) => a - b);
    return { n: vals.length, mean: mean(vals), median: median(vals), sd: stdDev(vals), min: Math.min(...vals), max: Math.max(...vals), p85: percentile(sorted, 85) };
  }
  function numericValues(c) { return c.values.filter(v => typeof v === 'number' && !Number.isNaN(v)); }

  function renderStats(validCols) {
    const rows = validCols.map(c => {
      const label = esc(c.col.label || '(ohne Bezeichnung)');
      if (c.kind === 'number') {
        const vals = numericValues(c);
        if (!vals.length) return `<tr><td>${label}</td><td colspan="7" class="us-aggregate-note">keine numerischen Werte</td></tr>`;
        const s = numStats(vals);
        return `<tr><td>${label}</td><td>${s.n}</td><td>${s.mean.toFixed(1)}</td><td>${s.median.toFixed(1)}</td><td>${s.sd.toFixed(1)}</td><td>${s.min.toFixed(1)}</td><td>${s.max.toFixed(1)}</td><td>${s.p85.toFixed(1)}</td></tr>`;
      }
      if (c.kind === 'bool') {
        const vals = c.values.filter(v => typeof v === 'boolean');
        const nTrue = vals.filter(Boolean).length;
        const pct = vals.length ? (nTrue / vals.length * 100).toFixed(0) + '%' : '–';
        return `<tr><td>${label}</td><td colspan="7" class="us-aggregate-note">${vals.length} Umläufe: ${nTrue}× wahr (${pct})</td></tr>`;
      }
      return `<tr><td>${label}</td><td colspan="7" class="us-aggregate-note">Textwerte — keine Aggregatstatistik</td></tr>`;
    }).join('');
    els.statsBody.innerHTML = rows || '<tr><td colspan="8" class="cfg-empty">Keine gültigen Spalten.</td></tr>';
  }

  /* ---------------- Excel-Export (immer die komplette Aufzeichnung) ---------------- */

  function exportValue(v) {
    if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) return '';
    if (typeof v === 'boolean') return v ? 'Wahr' : 'Falsch';
    return v;
  }
  function round1(x) { return Math.round(x * 10) / 10; }

  function statsRowForExport(c) {
    const label = c.col.label || '(ohne Bezeichnung)';
    if (c.kind === 'number') {
      const vals = numericValues(c);
      if (!vals.length) return [label, 0, '', '', '', '', '', ''];
      const s = numStats(vals);
      return [label, s.n, round1(s.mean), round1(s.median), round1(s.sd), round1(s.min), round1(s.max), round1(s.p85)];
    }
    if (c.kind === 'bool') {
      const vals = c.values.filter(v => typeof v === 'boolean');
      const nTrue = vals.filter(Boolean).length;
      return [label, vals.length, nTrue, vals.length - nTrue, vals.length ? round1(nTrue / vals.length * 100) + '%' : '', '', '', ''];
    }
    return [label, c.values.filter(v => v != null).length, '(Text)', '', '', '', '', ''];
  }

  function exportXlsx() {
    const validCols = currentValidCols();
    if (!validCols.length || !ctxAll) return;

    const header = ['#', 'Start', 'SPL', 'TU', 'TX'].concat(validCols.map(c => c.col.label || '(ohne Bezeichnung)'));
    const rows = ctxAll.cycles.map((cyc, i) => {
      const base = [i + 1, fmtTs(new Date(cyc.start)), cyc.SPL, cyc.TU, cyc.TX];
      validCols.forEach(c => base.push(exportValue(c.values[i])));
      return base;
    });
    const statsHeader = ['Spalte', 'n', 'Ø', 'Median', 'StdAbw', 'Min', 'Max', 'P85'];
    const statsRows = validCols.map(statsRowForExport);

    const blob = GZ.xlsxWriter.buildMultiSheetWorkbookBlob([
      { name: 'Umläufe', header, rows },
      { name: 'Statistik', header: statsHeader, rows: statsRows }
    ]);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'umlaufstatistiken.xlsx';
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  GZ.views = GZ.views || {};
  GZ.views.umlaufstatistiken = { init, populateControls, recompute, getSyntheticColumns };
})(window.GZ = window.GZ || {});
