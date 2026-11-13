/* GZ.views.umlaufstatistiken is the tab "Umlaufstatistiken".
   It has any number of columns that the user defines.
   Each column has a name and a formula.
   The formula is in the expression language of GZ.exprEngine.
   The formula builder in Umlaufprüfung uses the same language (see js/core/exprEngine.js and
   umlaufContext.js).
   The code evaluates each column once for ALL cycles of the recording.
   The result is a windowed table (for performance with many cycles, as in
   js/views/umlaufpruefung.js).
   There is also an aggregate statistics table for each column.
   For a number, it shows mean, median, standard deviation, min, max and P85.
   For true or false, it shows the share.
   The Excel export has both tables.
   The export ALWAYS covers the complete recording, not only the visible window.
   The same columns ALSO appear as a separate KENNZAHL track in the unified object list of the
   tab "Umlaufprüfung".
   (See getSyntheticColumns() below and kennzahlCols() and traceMeta there.)
   There the columns are bars in the time context of the signal groups.
   Here they are a full table for exact reading and export.

   The row-based formula builder is different.
   It uses one boolean raw series for each formula and the primitives Zustand, Dauer and
   DauerSeit.
   This tab evaluates EXACTLY ONCE FOR EACH CYCLE and allows any result type
   (GZ.exprEngine.compileValue() and not compile()).
   For this, the primitives An, Ab, TF, RG, GE, Ausgeloest and AnzahlAusloesungen read from
   handle.cycleMetrics and not from handle.sweep (see GZ.umlaufContext.buildAll()).
   WertBei(object, time) uses handle.rawSample() instead.
   It reads the real raw value at any time in the cycle.
   The value can be an APW countdown OR the signal image of a signal group.
   Most of the time, the time is again an An, Ab, TF, RG or GE call.
   Examples are WertBei(APW_01, Ab(K1)) and WertBei(K2, Ab(K1)).
   Zustand, Dauer and DauerSeit are NOT usable here on purpose.
   A whole cycle has no well-defined "current time" (see findPerRowOnlyUsage()).

   Some primitives have a unique TIME SPAN in the cycle in addition to their number or truth
   value.
   The primitives are TF, RG, GE, Versatz and Ueberschneidung.
   An example is Versatz(K1,K2): from the stop of K1 to the start of K2.
   exprEngine.js gives the span as an option through compileValue().spanRun.
   This module evaluates it for each cycle (evaluated[].spans).
   getSyntheticColumns() passes it on.
   So the Kennzahl track in Umlaufprüfung can draw the bar exactly over this span and not over
   the whole row (see the comment there about tr.span).
   The span exists only if the WHOLE column expression is exactly one of these primitive calls.
   It does not exist if the call is part of a calculation.
   In that case, spans stays null and the track in Umlaufprüfung uses the full row width. */
GZ.define('views.umlaufstatistiken', { layer: 'views', deps: ['exprEditor', 'exprEngine', 'format', 'state', 'stats', 'umlaufContext', 'xlsxWriter'] }, function (GZ) {
  'use strict';
  const { esc, fmtTs, fmtTimeShort } = GZ.format;
  const { mean, median, stdDev, percentile } = GZ.stats;

  const KENNZAHL_INDEX_BASE = 2000000; // separate range, independent of SYNTH_INDEX_BASE in formulaBuilder.js

  let els = null;
  let nextColId = 1;
  let ctxAll = null; // {index, cycles} - the code builds it once for each analysis (GZ.umlaufContext.buildAll)
  let evaluated = []; // parallel to GZ.state.data.umlaufSpalten: {col, error, incomplete, values, spans, kind, skip}
  // Indices in ctxAll.cycles that a LEER column did NOT hide (see usesLeer() and recompute()).
  // The table, the statistics, the export and the Kennzahl track loop over these indices.
  // They do not loop over ctxAll.cycles directly.
  let visibleIdx = [];
  let windowCount = 25, windowStartIdx = 0, showAll = false;

  // The code derives this from GZ.exprEngine.PRIMITIVE_INFO.
  // It does not keep a separate copy here.
  // The only place that knows "which primitive expects SG or DET as argument" or "which primitive
  // works only row by row" is the objArgType and perRowOnly field there (see the comment at
  // PRIMITIVE_INFO).
  // So this file includes a new primitive automatically.
  // Nobody must change this file.
  const PRIMITIVE_INFO = GZ.exprEngine.PRIMITIVE_INFO;
  const SG_ARG_FNS = new Set(PRIMITIVE_INFO.filter(p => p.objArgType === 'SG').map(p => p.name));
  const DET_ARG_FNS = new Set(PRIMITIVE_INFO.filter(p => p.objArgType === 'DET').map(p => p.name));
  // objArgType 'OBJ' (for example An, Ab, TF, Versatz, WertBei, ...): SG OR DET is valid.
  // The suggestion list combines both and not only one (see candidatesFor()).
  const OBJ_ARG_FNS = new Set(PRIMITIVE_INFO.filter(p => p.objArgType === 'OBJ').map(p => p.name));
  // Row-by-row primitives of the formula builder (perRowOnly).
  // The shared PRIMITIVES catalog knows them syntax-wise.
  // But without handle.sweep, a call would crash at run time and not give a value.
  // The code checks for them BEFORE the evaluation (see findPerRowOnlyUsage()).
  // It does not find them only at the crash.
  // So US_FUNCTIONS does not include them.
  const PER_ROW_ONLY_FNS = new Set(PRIMITIVE_INFO.filter(p => p.perRowOnly).map(p => p.name));
  const US_FUNCTIONS = PRIMITIVE_INFO.filter(p => !p.perRowOnly).map(p => p.name);
  const US_SCALARS = ['TU', 'TU_MED', 'SPL', 'LEER', 'EREIGNIS'];

  // exprEngine.js reports unknown names with no suggestion ("Unbekannte Variable/Funktion "X"").
  // For Umlaufstatistiken, this file adds a local "meinten Sie …?" text with an edit distance.
  // This avoids a change to the shared formula builder engine.
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
    GZ.state.provide('kennzahlColumns', getSyntheticColumns);
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

  // New analysis: the code resets the column list on purpose (as it does for GZ.state.data.phases
  // in Stammdaten LSA).
  // The formulas refer to signal group names and detector names of the previous recording.
  // They are invalid anyway when the user changes to a different intersection.
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
      `<div class="u-mt-4-faint">Zustand/Dauer/DauerSeit (Formel-Builder in Umlaufprüfung) sind hier nicht verfügbar - kein einzelner Zeitpunkt je Umlauf.</div>`;
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
        <span class="expr-input-wrap">
          <div class="us-col-expr expr-editor mono-input" contenteditable="true" spellcheck="false" data-placeholder="z. B. Versatz(S1, S2)" role="textbox" aria-multiline="false"></div>
          <button type="button" class="expr-palette-btn" title="Funktionen/Signalgruppen/Detektoren einfügen">ƒ</button>
          <div class="expr-autocomplete" hidden></div>
        </span>
        <div class="us-col-error" hidden><div class="us-col-error-msg"></div><div class="us-col-error-snippet"></div></div>
      </div>`).join('')
      : '<div class="cfg-empty u-m-12-16-0">Keine Spalte definiert – „+ Spalte hinzufügen“ klicken.</div>';

    els.colRows.querySelectorAll('.us-col-row').forEach(rowEl => {
      const id = rowEl.dataset.colId;
      const col = GZ.state.data.umlaufSpalten.find(c => String(c.id) === id);
      if (!col) return;
      const labelInput = rowEl.querySelector('.us-col-label');
      let debounceTimer = null;
      const scheduleRecompute = () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(recompute, 300); };

      labelInput.addEventListener('input', () => { col.label = labelInput.value; scheduleRecompute(); });
      labelInput.addEventListener('blur', () => { clearTimeout(debounceTimer); recompute(); });

      GZ.exprEditor.setup(rowEl, {
        getText: () => col.expr,
        setText: v => { col.expr = v; },
        knownNames: () => new Set(),
        getCandidates: candidatesFor(col),
        onRevalidate: recompute
      });

      rowEl.querySelector('.us-row-remove').addEventListener('click', () => {
        GZ.state.data.umlaufSpalten = GZ.state.data.umlaufSpalten.filter(c => String(c.id) !== id);
        renderColumns();
        recompute();
      });
    });
  }

  /* ---------------- Autocomplete ---------------- */
  // This uses GZ.exprEditor, which formulaBuilder.js and oepnvQa.js share (see there).
  // Only the candidate list stays here.
  // It depends on the function in which the cursor is at this time (see objArgType at
  // PRIMITIVE_INFO).
  // Inside an OBJ primitive (An, Ab, TF, RG, GE, Versatz, Ueberschneidung, WertBei, DauerBei, ...),
  // the list shows signal group names AND detector or APW names.
  // Inside a DET primitive (Ausgeloest, AnzahlAusloesungen), the list shows only detector or APW
  // names.
  // In all other cases, the list shows functions and scalar identifiers (TU, TU_MED, SPL, LEER,
  // EREIGNIS).
  const US_PRIMITIVE_INFO = GZ.exprEngine.PRIMITIVE_INFO.filter(p => US_FUNCTIONS.includes(p.name));

  // Name of the function whose argument list encloses caretPos.
  // The result is null at top level or after a lexer error.
  // While the user types, this is mostly not important.
  // Then there is no context restriction.
  function ownerFnAt(text, caretPos) {
    let tokens;
    try { tokens = GZ.exprEngine.tokenize(text); } catch (e) { return null; }
    const stack = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.pos >= caretPos) break;
      if (t.type === '(') {
        const prevTok = tokens[i - 1];
        stack.push(prevTok && prevTok.type === 'IDENT' && prevTok.end === t.pos ? prevTok.value : null);
      } else if (t.type === ')') {
        stack.pop();
      }
    }
    return stack.length ? stack[stack.length - 1] : null;
  }

  // Returns the getCandidates() function for ONE column row.
  // See the header comment of GZ.exprEditor. It passes caretPos from there.
  function candidatesFor(col) {
    return caretPos => {
      const text = col.expr || '';
      const owner = ctxAll ? ownerFnAt(text, caretPos == null ? text.length : caretPos) : null;
      if (owner && SG_ARG_FNS.has(owner)) {
        return ctxAll.index.sgList.map(n => ({ group: 'Signalgruppen', label: n, insertText: n, selStart: n.length, selEnd: n.length, kind: 'sg' }));
      }
      if (owner && DET_ARG_FNS.has(owner)) {
        return ctxAll.index.detList.map(n => ({ group: 'Detektor-/APW-Werte', label: n, insertText: n, selStart: n.length, selEnd: n.length, kind: 'det' }));
      }
      if (owner && OBJ_ARG_FNS.has(owner)) {
        return ctxAll.index.sgList.map(n => ({ group: 'Signalgruppen', label: n, insertText: n, selStart: n.length, selEnd: n.length, kind: 'sg' }))
          .concat(ctxAll.index.detList.map(n => ({ group: 'Detektor-/APW-Werte', label: n, insertText: n, selStart: n.length, selEnd: n.length, kind: 'det' })));
      }
      const items = US_PRIMITIVE_INFO.map(p => {
        const argList = p.params.join(', ');
        const ranges = GZ.exprEngine.argRangesFor(p.name, p.params);
        return {
          group: 'Funktionen', label: p.name, hint: `(${argList})`, desc: p.desc,
          insertText: `${p.name}(${argList})`, selStart: ranges[0].start, selEnd: ranges[0].end, kind: 'fn'
        };
      });
      US_SCALARS.forEach(s => items.push({ group: 'Bezeichner', label: s, insertText: s, selStart: s.length, selEnd: s.length, kind: 'scalar' }));
      return items;
    };
  }

  /* ---------------- Auswertung ---------------- */

  // Position of an error (one character offset, see ExprError in exprEngine.js), widened to the
  // span of the token at that position.
  // This gives a readable <mark> highlight and not a single character.
  function findTokenSpanAt(text, pos) {
    try {
      const tokens = GZ.exprEngine.tokenize(text);
      const tok = tokens.find(t => t.pos <= pos && pos < t.end) || tokens.find(t => t.pos === pos);
      if (tok && tok.end > tok.pos) return { start: tok.pos, end: tok.end };
    } catch (e) { /* The text itself cannot be tokenized. Use the single-character fallback below. */ }
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
    const exprEl = rowEl.querySelector('.us-col-expr');
    const wrap = rowEl.querySelector('.expr-input-wrap');
    // "incomplete" is an expression that is not finished in the middle of typing, but it is not
    // really wrong (see ExprError.incomplete in exprEngine.js).
    // The code does NOT mark it as a red error on purpose.
    // Otherwise an error message flashes at each key press.
    if (!entry || !entry.error || entry.incomplete) {
      errBox.hidden = true;
      exprEl.classList.remove('invalid');
      if (wrap && wrap.__exprRefreshHighlight) wrap.__exprRefreshHighlight(null);
      return;
    }
    exprEl.classList.add('invalid');
    errBox.hidden = false;
    errBox.querySelector('.us-col-error-msg').textContent = entry.error.message;
    errBox.querySelector('.us-col-error-snippet').innerHTML = renderErrorSnippet(entry.col.expr, entry.error.pos);
    if (wrap && wrap.__exprRefreshHighlight) wrap.__exprRefreshHighlight(entry.error.pos);
  }

  function findPerRowOnlyUsage(text) {
    try {
      const tokens = GZ.exprEngine.tokenize(text);
      for (let i = 0; i < tokens.length - 1; i++) {
        if (tokens[i].type === 'IDENT' && PER_ROW_ONLY_FNS.has(tokens[i].value) && tokens[i + 1].type === '(') return tokens[i];
      }
    } catch (e) { /* compileValue() already takes over tokenize errors. */ }
    return null;
  }

  // Does the column expression use the LEER literal anywhere (see exprEngine.js)?
  // The code checks this by syntax with the tokenizer (no evaluation is necessary).
  // It is the basis of the row hiding in recompute() and visibleRows.
  // A column that references LEER says explicitly: "a row for which I give LEER does not belong in
  // the table".
  // A column WITHOUT LEER still shows NaN as a normal "–" cell.
  // For example, An(K1) with no green in this cycle stays visible.
  // This is not a deliberate filter.
  function usesLeer(text) {
    try { return GZ.exprEngine.tokenize(text).some(t => t.type === 'IDENT' && t.value === 'LEER'); }
    catch (e) { return false; }
  }

  function isEmptyValue(v) { return v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v)); }

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

    // Row hiding: each column whose expression references LEER works as a filter.
    // A row for which such a column gives LEER (NaN) disappears from the WHOLE table, the
    // statistics, the export and the Kennzahl track.
    // It does not appear there as a "–" cell (see the comment at usesLeer()).
    // Columns WITHOUT LEER do not change the visibility.
    // Their NaN (for example An(K1) with no green in this cycle) stays a normal "–" cell in a row
    // that is still visible.
    const filterCols = validCols.filter(c => usesLeer(c.col.expr));
    visibleIdx = [];
    for (let i = 0; i < ctxAll.cycles.length; i++) {
      if (!filterCols.some(c => isEmptyValue(c.values[i]))) visibleIdx.push(i);
    }

    renderResultsTable(validCols);
    renderStats(validCols);
    els.statsPanel.style.display = validCols.length ? '' : 'none';
    els.exportBtn.disabled = validCols.length === 0;

    const errCount = evaluated.filter(e => e.error && !e.incomplete).length;
    // The code shows the number of cycles separately from the number of rows.
    // Since the multiple-event split (see GZ.umlaufContext.buildAll()), a cycle can have more than
    // one row.
    // This happens when a signal group occurs more than once in this cycle.
    // Without a separate count, a row count that is higher than the real number of detected cycles
    // looks like a counting error.
    const umlaufCount = ctxAll.cycles.reduce((n, c) => n + (c.eventIdx === 0 ? 1 : 0), 0);
    const zusatzZeilen = ctxAll.cycles.length - umlaufCount;
    const umlaufInfo = zusatzZeilen > 0
      ? `${umlaufCount} Umlauf/Umläufe, ${ctxAll.cycles.length} Zeilen (${zusatzZeilen} zusätzliche Ereignis-Zeile(n) durch Umläufe mit Mehrfach-Vorkommen)`
      : `${umlaufCount} Umlauf/Umläufe`;
    const ausgeblendet = ctxAll.cycles.length - visibleIdx.length;
    const filterInfo = ausgeblendet > 0 ? ` · ${ausgeblendet} Zeile(n) durch LEER ausgeblendet` : '';
    els.hint.textContent = cols.length === 0
      ? 'Bitte mindestens eine Spalte definieren.'
      : `${validCols.length} von ${cols.length} Spalte(n) gültig` + (errCount ? ` · ${errCount} mit Fehler` : '') + ` · ${umlaufInfo}${filterInfo}.`;
    els.hint.className = errCount ? 'hint warn' : 'hint';

    // Umlaufprüfung shows the valid columns as a separate KENNZAHL track for each cycle (see
    // getSyntheticColumns() below).
    // After each new calculation, the cycle check must refresh its object list and its render.
    // The store tells it (the same pattern as berechnen() in formulaBuilder.js).
    GZ.state.commit('syntheticColumns:changed');
  }

  // Read access for umlaufpruefung.js (see kennzahlCols() there).
  // It returns the valid columns that the code calculated last, as synthetic KENNZAHL objects.
  // It has ONE precalculated value for each cycle index (valuesByCycleIdx).
  // It does not have one raw series for each measurement row, as FORMEL has (see
  // getSyntheticColumns() in formulaBuilder.js).
  // index stays stable over recalculations (col.id), as long as the user does not delete the column
  // or create it again.
  // spansByCycleIdx is parallel to valuesByCycleIdx.
  // For each cycle, it is {startSec,endSec} or null.
  // It is set only if the formula is EXACTLY one of the object-related primitives (TF, RG, GE,
  // Versatz, Ueberschneidung, see spanRun in exprEngine.js).
  // It is for the bar display there (tr.span).
  //
  // Since the multiple-event split (see GZ.umlaufContext.buildAll()), ctxAll.cycles is NO LONGER
  // 1:1 with the cycle indices.
  // But Umlaufprüfung expects EXACTLY ONE value for each cycle index (Kennzahl track, one row for
  // each cycle).
  // So this function returns on purpose only the FIRST event of each cycle (cyc.eventIdx === 0).
  // The Kennzahl track in Umlaufprüfung does not yet show more events of the same cycle (unlike the
  // table here).
  // Rows that a LEER column hid (see visibleIdx and recompute()) give NaN on purpose.
  // They do not give the value that the code really calculated.
  // A row that is hidden in the table must also not appear in the Kennzahl track.
  function getSyntheticColumns() {
    if (!ctxAll) return [];
    const visibleSet = new Set(visibleIdx);
    const firstEventIdxs = [];
    ctxAll.cycles.forEach((cyc, idx) => { if (cyc.eventIdx === 0) firstEventIdxs.push(idx); });
    return currentValidCols().map(e => ({
      index: KENNZAHL_INDEX_BASE + e.col.id,
      kuerzel: 'KENNZAHL',
      name: e.col.label || '(ohne Bezeichnung)',
      beschreibung: e.col.expr,
      valuesByCycleIdx: firstEventIdxs.map(idx => visibleSet.has(idx) ? e.values[idx] : NaN),
      spansByCycleIdx: e.spans ? firstEventIdxs.map(idx => visibleSet.has(idx) ? e.spans[idx] : null) : null,
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
    if (isEmptyValue(v)) return '<span class="us-empty-cell">–</span>';
    if (typeof v === 'boolean') return v ? '<span class="us-bool-true">Wahr</span>' : '<span class="us-bool-false">Falsch</span>';
    if (typeof v === 'number') return esc(fmtNum(v));
    return esc(String(v));
  }

  function renderResultsTable(validCols) {
    if (!ctxAll || !visibleIdx.length || validCols.length === 0) {
      els.tablePanel.style.display = 'none';
      els.diagramControls.style.display = 'none';
      return;
    }
    els.tablePanel.style.display = '';
    els.diagramControls.style.display = 'flex';

    const n = visibleIdx.length;
    const { from, to } = windowRange(n);
    els.winLabel.textContent = showAll ? `Gesamte Aufzeichnung (${n} Zeilen)` : `Zeile ${from + 1}–${to} von ${n}`;
    els.btnWinPrev.disabled = showAll || from <= 0;
    els.btnWinNext.disabled = showAll || to >= n;
    els.winSize.disabled = showAll;

    els.tableHead.innerHTML = `<tr><th>#</th><th>Umlauf</th><th>Ereignis</th><th>Start</th><th>SPL</th><th>TU</th>${
      validCols.map(c => `<th>${esc(c.col.label || '(ohne Bezeichnung)')}</th>`).join('')
    }</tr>`;

    const rows = [];
    for (let i = from; i < to; i++) {
      const realIdx = visibleIdx[i];
      const cyc = ctxAll.cycles[realIdx];
      // Event: the code shows it only if this cycle has more than one row (multiple occurrence of a
      // signal group, see GZ.umlaufContext.buildAll()).
      // Otherwise it shows "-". It does not show a "1" on each row.
      // It is a plain number (1, 2, 3, ...) and not "1/3".
      // The total number is already in the cycle info line.
      // It is not necessary in each cell.
      const ereignis = cyc.eventCount > 1 ? String(cyc.eventIdx + 1) : '–';
      const cells = [String(i + 1), String(cyc.cycleIdx + 1), ereignis, fmtTimeShort(cyc.start), esc(cyc.SPL || '–'), String(cyc.TU)]
        .concat(validCols.map(c => formatCellHtml(c.values[realIdx])));
      rows.push(`<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`);
    }
    els.tableBody.innerHTML = rows.join('');
  }

  /* ---------------- Statistik ---------------- */

  function numStats(vals) {
    const sorted = [...vals].sort((a, b) => a - b);
    return { n: vals.length, mean: mean(vals), median: median(vals), sd: stdDev(vals), min: Math.min(...vals), max: Math.max(...vals), p85: percentile(sorted, 85) };
  }
  // Use only visibleIdx (see recompute()) and not c.values directly.
  // So rows that a LEER column hid are in NO column of the aggregate statistics.
  // This is not only true for the column that hides them.
  // A hidden row is hidden for the whole table.
  function visibleValues(c) { return visibleIdx.map(i => c.values[i]); }
  function numericValues(c) { return visibleValues(c).filter(v => typeof v === 'number' && !Number.isNaN(v)); }

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
        const vals = visibleValues(c).filter(v => typeof v === 'boolean');
        const nTrue = vals.filter(Boolean).length;
        const pct = vals.length ? (nTrue / vals.length * 100).toFixed(0) + '%' : '–';
        return `<tr><td>${label}</td><td colspan="7" class="us-aggregate-note">${vals.length} Umläufe: ${nTrue}× wahr (${pct})</td></tr>`;
      }
      return `<tr><td>${label}</td><td colspan="7" class="us-aggregate-note">Textwerte — keine Aggregatstatistik</td></tr>`;
    }).join('');
    els.statsBody.innerHTML = rows || '<tr><td colspan="8" class="cfg-empty">Keine gültigen Spalten.</td></tr>';
  }

  /* ---------------- Excel-Export (immer die komplette, sichtbare Aufzeichnung) ---------------- */

  function exportValue(v) {
    if (isEmptyValue(v)) return '';
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
      const vals = visibleValues(c).filter(v => typeof v === 'boolean');
      const nTrue = vals.filter(Boolean).length;
      return [label, vals.length, nTrue, vals.length - nTrue, vals.length ? round1(nTrue / vals.length * 100) + '%' : '', '', '', ''];
    }
    return [label, visibleValues(c).filter(v => v != null).length, '(Text)', '', '', '', '', ''];
  }

  function exportXlsx() {
    const validCols = currentValidCols();
    if (!validCols.length || !ctxAll) return;

    const header = ['#', 'Start', 'SPL', 'TU', 'TX', 'Ereignis'].concat(validCols.map(c => c.col.label || '(ohne Bezeichnung)'));
    const rows = visibleIdx.map((realIdx, i) => {
      const cyc = ctxAll.cycles[realIdx];
      // Event: plain number and not "1/3" (see renderResultsTable).
      // Here there is no "-" special case for the normal case.
      // In the export, each row must be readable alone.
      // The reader must not need the neighbor rows to understand it.
      const base = [i + 1, fmtTs(new Date(cyc.start)), cyc.SPL, cyc.TU, cyc.TX, cyc.eventIdx + 1];
      validCols.forEach(c => base.push(exportValue(c.values[realIdx])));
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

  return { init, populateControls, recompute };
});
