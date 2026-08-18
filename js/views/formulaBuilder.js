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
   abgesetzte Detektor-Spalte (Kürzel FORMEL) einbindet.

   Formeln können ANDERE Formeln direkt bei ihrem Namen referenzieren (z.B.
   "M1 AND NOT R1", wenn "M1"/"R1" Namen anderer Formeln sind) - dafür meldet
   currentVarTypes() jeden Formelnamen als BOOL-Bezeichner, im selben
   Namensraum wie Variablen-Aliase (Kollision = Fehler). Da eine Formel dabei
   von einer anderen abhängt, wertet berechnen() nicht mehr einfach in
   formulas-Reihenfolge aus, sondern baut zuerst einen Abhängigkeits-Graphen
   (aus den Bezeichner-Token jeder Formel) und wertet ihn topologisch
   sortiert aus - eine bereits fertige Formel steht der nächsten als echter
   JS-boolean im scope zur Verfügung. Zyklische Referenzen (direkt "M1
   referenziert M1" oder indirekt über mehrere Formeln) werden erkannt und
   alle beteiligten Formeln übersprungen (siehe skipReasonById), statt in
   eine Endlosschleife oder stillschweigend falsche Werte zu laufen - anders
   als bei benutzerdefinierten FUNKTIONEN (siehe oben) ist das hier nötig,
   weil Formel-Referenzen NICHT inline expandiert werden, sondern echte
   Datenabhängigkeiten zwischen vorab berechneten Rohreihen sind.

   Jede Formel trägt außerdem eine feste Identitätsfarbe (formulaColorFor(),
   Position in der formulas-Liste) - dieselbe Farbe erscheint als Farbpunkt
   in der Formel-Zeile, als Akzentfarbe ihres Referenz-Chips in ANDEREN
   Formeln (chipColorFor-Hook von GZ.exprEditor) und als Hervorhebungsfarbe
   auf einer Objekt-Spur, falls ein Hervorhebungsziel gesetzt ist (siehe
   getFormulaHighlights()) - eine Formel bleibt so überall wiedererkennbar. */
(function (GZ) {
  'use strict';
  const { esc } = GZ.format;
  const { buildSegments, makePointSegmentSweep, computeGlobalTU, computeCycleSgMetrics, computeCycleDetMetrics } = GZ.segments;
  const { categorizeDetRaw } = GZ.parser;
  const { compile, compileFunctionDef } = GZ.exprEngine;
  const { wzIstBelegt } = GZ.wartezeitLogic;

  const SYNTH_INDEX_BASE = 1000000; // weit jenseits jedes realen Spaltenindex

  let els = null;
  let vars = []; // {id, alias, colIndex}
  let funcs = []; // {id, name, params:string[], bodyText}
  let formulas = []; // {id, name, exprText, highlightCol, rawSeries}
  let nextVarId = 1, nextFuncId = 1, nextFormulaId = 1;
  let syntheticCols = []; // [{index, kuerzel:'FORMEL', name, beschreibung, rawSeries}]
  let debounceTimers = new Map(); // "<kind>:<id>" -> timeout handle

  // Identitätsfarbe je Formel (siehe formulaColorFor() unten, Position in
  // der formulas-Liste) - bewusst Blau-/Violett-/Pinktöne, die mit KEINEM
  // Signalzustand (Rot/Gelb/Grün) kollidieren, damit eine Hervorhebung nie
  // mit einem echten Signalbild verwechselt werden kann. Zusätzlich per
  // HSL-Abstand gegen die App-eigenen Töne geprüft (Zustand/Funktion/
  // Variable/Akzent), NICHT nur gegen die Signalfarben: die ursprüngliche
  // erste Farbe (#7c4dff) lag nur 5° Farbton von --req-marker entfernt (der
  // Funktions-/Primitiven-Chip-Farbe) und war im Farb-Schlüssel praktisch
  // nicht von ihr zu unterscheiden - jetzt hat jeder Eintrag mindestens
  // ~18° Abstand zu jedem reservierten App-Ton.
  const HIGHLIGHT_PALETTE = ['#3d5afe', '#00b8d4', '#e91e63', '#8e24aa', '#1a237e', '#ad1457'];

  // Case-insensitive (AND/OR/NOT, wie im Tokenizer) bzw. exakt (TX und die
  // Zustands-/Funktionsnamen, ebenfalls exakt wie im Tokenizer/PRIMITIVES von
  // GZ.exprEngine) reservierte Wörter - als Alias verboten, sonst wäre die
  // Variable in Formeln unerreichbar (der Tokenizer erkennt z.B. "GRUEN"
  // immer als Zustands-Literal, unabhängig davon, was in varTypes steht).
  const RESERVED_CI = new Set(['AND', 'OR', 'NOT']);
  const RESERVED_EXACT = new Set([
    'TX', 'GRUEN', 'ROT', 'GELB', 'ROTGELB', 'DUNKEL', 'BELEGT', 'FREI', 'Zustand', 'Dauer', 'DauerSeit',
    'An', 'Ab', 'TF', 'RG', 'GE', 'Ausgeloest', 'AnzahlAusloesungen', 'MOD', 'Versatz', 'Ueberschneidung'
  ]);
  const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const isReserved = alias => RESERVED_CI.has(alias.toUpperCase()) || RESERVED_EXACT.has(alias);

  // ---------- Ausdrucks-Editor: der eigentliche Chip-Editor (contenteditable,
  // DOM/Caret-Mechanik, Dropdown/Palette, Debounce) lebt jetzt in
  // GZ.exprEditor (siehe dort für das volle Modell) - wiederverwendet von
  // oepnvQa.js für den ÖPNV-Zeilenfilter. Hier bleibt nur das, was WIRKLICH
  // formulaBuilder-spezifisch ist: exprCandidates() (Kandidatenliste) und die
  // beiden setup()-Aufrufe in renderFuncRows()/renderFormulaRows().

  // Vergleichs-/Rechenoperatoren für die Palette (siehe exprCandidates()) -
  // mit umgebenden Leerzeichen eingefügt, damit ein reiner Klickweg lesbaren
  // Text erzeugt ("DauerSeit(K1, GRUEN) > 45" statt "DauerSeit(K1,GRUEN)>45").
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
    { label: '( )', insert: '()', hint: 'Klammern', desc: 'Klammern zum Gruppieren', caret: 1 } // Cursor ZWISCHEN die Klammern
  ];

  // Zeichenbereiche ALLER Parameter innerhalb von "name(argList)" (relativ
  // zum Anfang des insertText, d.h. inkl. "name(" - Offset), parallel zur
  // ", "-Verkettung von params.join(', '). Erlaubt es GZ.exprEditor, nach
  // dem Ausfüllen EINES Platzhalters automatisch zum nächsten zu springen
  // (Tabstop-Kette, siehe dortiger Kopfkommentar zu argRanges) - bei einem
  // einzigen Parameter ergibt sich daraus dieselbe einfache Selektion wie
  // zuvor, nur eben immer über argRanges[0] statt fest verdrahteter Werte.
  function argRangesFor(name, params) {
    const prefix = name.length + 1; // "name(".length
    let pos = 0;
    return params.map((p, i) => {
      const r = { start: prefix + pos, end: prefix + pos + p.length };
      pos += p.length + (i < params.length - 1 ? 2 : 0); // ", "
      return r;
    });
  }

  // Kandidaten für Autovervollständigung + Funktions-Palette: Primitiven
  // (GZ.exprEngine.PRIMITIVE_INFO), aktuell definierte Funktionen/Variablen
  // (Modul-State), Zustands-Konstanten (GZ.exprEngine.KAT_TOKENS), TX,
  // AND/OR/NOT. insertText/selStart/selEnd beschreiben, was beim Einfügen an
  // der Cursorposition eingesetzt wird und welcher Teilbereich davon
  // anschließend als Platzhalter selektiert wird, damit man ihn direkt
  // überschreiben kann (z.B. "Zustand(objekt)" mit "objekt" selektiert) -
  // argRanges (Primitiven/eigene Funktionen mit >1 Parameter) lässt
  // GZ.exprEditor nach dem Ausfüllen automatisch zum nächsten Platzhalter
  // weiterspringen (siehe argRangesFor() oben). TX wird bewusst NICHT in die
  // eingefügten Primitiven-/Funktionsaufrufe aufgenommen (siehe GZ.exprEngine
  // PRIMITIVE_INFO) - es bleibt implizit.
  function exprCandidates() {
    const items = [];
    GZ.exprEngine.PRIMITIVE_INFO.forEach(p => {
      const argList = p.params.join(', ');
      const ranges = argRangesFor(p.name, p.params);
      items.push({
        group: 'Primitiven', label: p.name, hint: `(${argList})`, desc: p.desc,
        insertText: `${p.name}(${argList})`,
        selStart: ranges[0].start, selEnd: ranges[0].end, argRanges: ranges, kind: 'func'
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
        selStart: ranges[0].start, selEnd: ranges[0].end, argRanges: ranges, kind: 'func'
      });
    });
    Object.entries(GZ.exprEngine.KAT_TOKENS).forEach(([tok, katType]) => {
      const group = katType === 'KAT_SG' ? 'Zustände (Signalgruppe)' : 'Zustände (Detektor)';
      items.push({ group, label: tok, hint: '', desc: '', insertText: tok, selStart: tok.length, selEnd: tok.length, kind: 'kat' });
    });
    items.push({ group: 'Sonstiges', label: 'TX', hint: 'reserviert', desc: 'aktueller Auswertungszeitpunkt - immer automatisch verfügbar, nicht selbst benennen/zuweisen', insertText: 'TX', selStart: 2, selEnd: 2, kind: 'var' });
    // Vergleichsoperatoren + Zahl-Platzhalter: ohne sie endete der reine
    // Klickweg zwangsläufig bei einem unvollständigen Ausdruck (z.B.
    // "DauerSeit(K1, GRUEN)"), der noch zu WAHR/FALSCH ergänzt werden MUSS -
    // fertigstellen ging also nur per Tastatur. Der Zahl-Eintrag fügt eine
    // vorselektierte "0" ein, die man direkt überschreiben kann.
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
    // Andere Formeln sind wie Variablen per bloßem Namen referenzierbar
    // (siehe Datei-Kopfkommentar zu Formel-Referenzen) - kind:'var', damit
    // sie sich nahtlos in dieselbe Kandidatenliste einreihen (Autovervoll-
    // ständigung, Palette, Chip-Austausch per Klick). Bewusst OHNE Ausschluss
    // der gerade bearbeiteten Formel selbst - eine Selbstreferenz chippt
    // dann zwar mit ein, wird aber beim Berechnen als zyklisch erkannt und
    // klar gemeldet, statt sie hier stillschweigend zu verstecken.
    formulas.forEach(f => {
      const name = f.name.trim();
      if (!name) return;
      items.push({ group: 'Formeln', label: name, hint: 'WAHR/FALSCH', desc: f.exprText, insertText: name, selStart: name.length, selEnd: name.length, kind: 'var' });
    });
    // Rohe Signalgruppen-/Detektor-/APW-/ÖPNV-Spalten - auch OHNE dass dafür
    // schon eine Variable existiert. Auswahl legt bei Bedarf (siehe onAccept,
    // GZ.exprEditor accept()) automatisch eine passende Variable an, statt
    // das vorher manuell im Abschnitt "Variablen" verlangen zu müssen.
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
      sidebar: root.querySelector('#upFormulaSidebar'),
      bausteinPanel: root.querySelector('#upBausteinPanel'),
      bausteinPanelHead: root.querySelector('#upBausteinPanelHead'),
      bausteinPanelSummary: root.querySelector('#upBausteinPanelSummary')
    };
    els.addVarBtn.onclick = () => { addVar(); renderVarRows(); };
    els.addFuncBtn.onclick = () => { addFunc(); renderFuncRows(); };
    els.addFormulaBtn.onclick = () => { addFormula(); renderFormulaRows(); };
    els.calcBtn.onclick = berechnen;

    // "Bausteine" (Variablen/Funktionen) starten eingeklappt - dieselbe
    // open-Klassen-Mechanik wie .data-panel (siehe layout.css), nur lokal
    // hier verdrahtet statt in app.js, da dieser Baustein spezifisch zum
    // Formel-Builder gehört.
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

    // Hervorhebungs-Popover (siehe renderFormulaRows()/positionHlPopover()):
    // EIN globaler Klick-Handler statt je Popover einen eigenen - schließt
    // jedes offene Popover, sobald außerhalb seines .up-formula-hl-wrap
    // geklickt wird. Da das Öffnen/Schließen rein über das hidden-Attribut
    // des bereits vorhandenen DOM-Knotens läuft (kein renderFormulaRows()-
    // Neuaufbau bei jedem Klick), bleibt e.target während der gesamten
    // Ereignisverarbeitung im Baum verankert - anders als bei einem vollen
    // Neuaufbau, der e.target mitten in der Bubble-Phase aus dem DOM lösen
    // und damit closest() fälschlich leer laufen lassen würde.
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

  // Positioniert das Hervorhebungs-Popover einer Formel-Zeile relativ zum
  // Augen-Symbol - position:fixed + hier berechnete Koordinaten statt
  // position:absolute, da .panel weiter oben overflow:hidden setzt (für die
  // abgerundeten Ecken) und ein absolut positioniertes Popover sonst am
  // Panel-Rand abgeschnitten würde (dieselbe Begründung wie bei
  // positionDropdown() in exprEditor.js).
  function positionHlPopover(rowEl) {
    const btn = rowEl.querySelector('.up-formula-hl-btn');
    const pop = rowEl.querySelector('.up-formula-hl-pop');
    if (!btn || !pop) return;
    const rect = btn.getBoundingClientRect();
    pop.style.visibility = 'hidden';
    pop.hidden = false;
    requestAnimationFrame(() => {
      if (pop.hidden) return; // in der Zwischenzeit wieder geschlossen
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
  // siehe exprCandidates() oben/onAccept-Hook in GZ.exprEditor) still eine neue an - so
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
    formulas.push({ id: nextFormulaId++, name: `F${nextFormulaId - 1}`, exprText: '', highlightCol: null, rawSeries: null });
  }

  function populateControls() {
    const cols = sourceCols();
    // Nach neuem Datenimport: Spaltenverweise, die es nicht mehr gibt (andere
    // Datei/Spaltenlayout), auf die erste verfügbare Quellspalte zurücksetzen
    // statt auf eine ungültige Spalte zu verweisen. Funktionen haben keinen
    // Spaltenbezug (siehe Datei-Kopfkommentar) und bleiben unverändert.
    vars.forEach(v => { if (!cols.find(c => c.index === v.colIndex)) v.colIndex = cols.length ? cols[0].index : null; });
    syntheticCols = [];
    // Rohreihe je Formel gehört zur vorherigen Datei - erst nach dem nächsten
    // "Berechnen" wieder gültig, sonst könnte getFormulaHighlights() stale
    // Intervalle gegen eine neue Zeitreihe falscher Länge auswerten. Ein
    // Hervorhebungs-Ziel, das es in der neuen Datei nicht mehr gibt, wird wie
    // bei vars oben stillschweigend zurückgesetzt statt auf eine falsche
    // Spalte zu verweisen.
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

  // types enthält NEBEN den Variablen-Aliasen auch jeden benannten Formelnamen
  // als BOOL-Bezeichner (siehe Datei-Kopfkommentar zu Formel-Referenzen) -
  // eine Formel kann so eine ANDERE Formel direkt beim Namen nennen
  // ("M1 AND R1"), ohne dafür eine eigene Variable anzulegen. Teilt sich mit
  // den Variablen-Aliasen dasselbe "seen"-Set (EIN gemeinsamer Bezeichner-
  // Namensraum): eine Formel darf weder den Namen einer Variable noch einer
  // anderen Formel tragen, sonst würde eine der beiden Bedeutungen im scope
  // lautlos verdeckt. Ob eine so referenzierte Formel tatsächlich BERECHENBAR
  // ist (kompiliert fehlerfrei, keine zyklische Referenz), prüft NICHT diese
  // rein syntaktische Typprüfung, sondern erst berechnen() (Abhängigkeits-
  // Graph) - eine (noch) ungültige/zyklische Formel zu referenzieren ist
  // daher kein Compile-Fehler, sondern führt beim Berechnen zu "übersprungen".
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

  // Feste Identitätsfarbe JEDER Formel (siehe HIGHLIGHT_PALETTE oben) -
  // Position in der GESAMTEN formulas-Liste, nicht nur unter den aktuell
  // hervorhebenden. Eine Formel behält so dieselbe Farbe überall, wo sie
  // auftaucht: eigener Farbpunkt in der Liste, Referenz-Chip in ANDEREN
  // Formeln (siehe chipColorFor unten) UND ihr Hervorhebungs-Band auf einer
  // Objekt-Spur (siehe getFormulaHighlights()) - unabhängig davon, ob/wie
  // viele andere Formeln gerade ein Hervorhebungsziel gesetzt haben.
  function formulaColorFor(f) {
    const idx = formulas.findIndex(x => x.id === f.id);
    return idx === -1 ? null : HIGHLIGHT_PALETTE[idx % HIGHLIGHT_PALETTE.length];
  }
  // Für chipColorFor(): Farbe der Formel MIT DIESEM NAMEN (falls vorhanden) -
  // eine Formel-Referenz in einer ANDEREN Formel trägt dieselbe Farbe wie die
  // referenzierte Formel selbst.
  function formulaColorByName(name) {
    const f = formulas.find(x => x.name.trim() === name);
    return f ? formulaColorFor(f) : null;
  }

  // Augen-Symbol fürs Hervorhebungs-Popover (siehe closeAllHlPopovers()/
  // positionHlPopover()) - dieselbe Form wie im begutachteten Redesign-
  // Mockup, damit "hier lässt sich etwas hervorheben" auch ohne Text auf
  // Anhieb erkennbar ist.
  const EYE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/></svg>';

  function renderFormulaRows() {
    const cols = sourceCols();
    els.formulaRows.innerHTML = formulas.map(f => {
      const hlTarget = f.highlightCol != null ? cols.find(c => c.index === f.highlightCol) : null;
      const hlTitle = hlTarget ? `Hervorgehoben auf: ${esc(hlTarget.kuerzel)} ${esc(hlTarget.name)}` : 'Wahr-Intervalle dieser Formel farbig auf einer Objekt-Spur hervorheben';
      return `
      <div class="up-formula-row" data-id="${f.id}">
        <div class="up-formula-head">
          <span class="up-formula-color-dot" style="background:${formulaColorFor(f)}" title="Farbe dieser Formel - auch als Referenz-Chip in anderen Formeln und als Hervorhebungs-Farbe"></span>
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

    // Formelname ändern kann ANDERE Formeln betreffen, die ihn referenzieren
    // (siehe currentVarTypes()) - wie bei Variablen-Aliasen/Funktionsnamen
    // muss das eine Neuprüfung ALLER Zeilen anstoßen, nur eben debounced
    // (150ms), damit normales Tippen des Namens nicht bei jedem Zeichen die
    // komplette Liste (inkl. Seitenleiste) neu rendert.
    const debouncedRevalidate = id => {
      clearTimeout(debounceTimers.get(`formula:${id}`));
      debounceTimers.set(`formula:${id}`, setTimeout(validateAllInline, 150));
    };

    els.formulaRows.querySelectorAll('.up-formula-row').forEach(rowEl => {
      const id = Number(rowEl.dataset.id);
      const f = formulas.find(x => x.id === id);
      rowEl.querySelector('.up-formula-name').oninput = e => { f.name = e.target.value; debouncedRevalidate(id); };
      rowEl.querySelector('.up-formula-remove').onclick = () => { formulas = formulas.filter(x => x.id !== id); renderFormulaRows(); validateAllInline(); };
      // Öffnen/Schließen rein über das hidden-Attribut des bereits
      // gerenderten Popover-Knotens (siehe closeAllHlPopovers()) - KEIN
      // renderFormulaRows()-Neuaufbau nur fürs Auf-/Zuklappen, damit der
      // globale Klick-außerhalb-Handler in init() e.target zuverlässig noch
      // im DOM vorfindet (siehe dortiger Kommentar).
      const hlBtn = rowEl.querySelector('.up-formula-hl-btn');
      // preventDefault auf mousedown verhindert, dass der Button dem gerade
      // fokussierten Ausdrucks-Editor den Fokus entzieht (siehe dieselbe
      // Absicherung bei .expr-palette-btn in exprEditor.js) - sonst löst ein
      // Klick auf das Auge zusätzlich noch den blur-Handler des Editors aus
      // (der Autovervollständigung schließt und den Editor-Inhalt neu
      // einrasten lässt), rein als Nebenwirkung des Fokuswechsels.
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
        // Andere Formeln sind wie Variablen per bloßem Namen referenzierbar
        // (siehe currentVarTypes()/Datei-Kopfkommentar zu Formel-Referenzen) -
        // daher hier ebenfalls als "bekannt" gemeldet, damit ihr Name beim
        // Tippen zum Chip einrastet. Der eigene Name bleibt bewusst mit drin
        // (keine Sonderbehandlung für Selbstreferenz) - eine versehentliche
        // Selbstreferenz chippt dann zwar auch, wird aber beim Berechnen als
        // zyklisch erkannt und klar gemeldet (siehe berechnen()).
        knownNames: () => new Set([
          ...vars.map(v => v.alias.trim()).filter(Boolean),
          ...formulas.map(x => x.name.trim()).filter(Boolean)
        ]),
        getCandidates: exprCandidates,
        // Eine referenzierte Formel trägt ihre eigene Identitätsfarbe (siehe
        // formulaColorFor()) statt der generischen Variablen-Chip-Farbe -
        // macht auf einen Blick sichtbar, DASS und WELCHE andere Formel hier
        // eingeflossen ist.
        chipColorFor: formulaColorByName,
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
    // Spiegelt den Status zusätzlich als Randfarbe der ganzen Karte (siehe
    // .up-formula-row-{ok,err,pending} in components.css) - sofort sichtbar
    // beim Überfliegen der Liste, ohne bis zum Status-Zeichen lesen zu
    // müssen. Der Fehlertext erscheint zusätzlich als Zeile unter dem
    // Ausdruck (nicht nur im Tooltip) - bewusst NUR bei "err", nicht bei
    // "pending" (siehe incomplete-Zweig unten), sonst würde beim normalen
    // Tippen ständig eine Meldung aufblitzen, die keine ist.
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
      markHighlight(null); // Fehler liegt in Alias-/Funktionsdefinitionen, nicht im Formel-Text selbst
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
      // Noch nicht fertig statt falsch (siehe exprEngine ExprError) - neutral
      // anzeigen und KEINE rote Fehlerwelle zeichnen, sonst blinkt beim
      // normalen Tippen/Zusammenklicken ständig ein Fehler auf, der keiner ist.
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
    renderBausteinSummary();
    renderSidebar();
  }

  // Ein-Zeilen-Zusammenfassung im (standardmäßig eingeklappten) Bausteine-
  // Kopf, siehe .baustein-panel in components.css - damit der Inhalt auch
  // zugeklappt auf einen Blick erkennbar bleibt, statt ihn erst aufklappen
  // zu müssen.
  function renderBausteinSummary() {
    if (!els.bausteinPanelSummary) return;
    const parts = [
      ...vars.filter(v => v.alias.trim()).map(v => v.alias.trim()),
      ...funcs.filter(f => f.name.trim()).map(f => f.name.trim() + '()')
    ];
    els.bausteinPanelSummary.textContent = parts.length ? parts.join(', ') : 'Keine Variablen/Funktionen definiert';
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

    // argRanges (Primitiven/eigene Funktionen): ermöglicht auch beim Einfügen
    // AUS DER SEITENLEISTE die Tabstop-Kette - ohne sie sprang die Auswahl
    // nach dem ersten Platzhalter nicht weiter und der nächste Klick landete
    // am Cursor statt im nächsten Argument ("DauerSeit(K1GRUEN, zustand)").
    // color (optional): Farbpunkt vor dem Namen - für Formeln (siehe unten),
    // dieselbe Identitätsfarbe wie ihr Referenz-Chip/Hervorhebungsband
    // (formulaColorFor()).
    const item = (name, meta, insertText, selStart, selEnd, muted, argRanges, color) =>
      `<div class="fsb-item${muted ? ' fsb-item-muted' : ''}" data-insert="${esc(insertText)}" data-sel-start="${selStart}" data-sel-end="${selEnd}"${argRanges ? ` data-arg-ranges="${esc(JSON.stringify(argRanges))}"` : ''} title="${esc(meta)}">
        <span class="fsb-item-label">${color ? `<span class="fsb-item-dot" style="background:${color}"></span>` : ''}<span class="fsb-item-name">${esc(name)}</span></span><span class="fsb-item-meta">${esc(meta)}</span>
      </div>`;
    // .fsb-section-body kapselt die Einträge in einen eigenen Scrollbereich
    // (siehe components.css) - eine lange Objekt-/Variablenliste schiebt so
    // nicht die nachfolgenden Abschnitte aus dem Blickfeld.
    const section = (title, inner) => `<div class="fsb-section"><div class="fsb-section-title">${esc(title)}</div><div class="fsb-section-body">${inner || '<div class="fsb-empty">–</div>'}</div></div>`;

    const varsHtml = vars.filter(v => v.alias.trim()).map(v => {
      const alias = v.alias.trim();
      const col = cols.find(c => c.index === v.colIndex);
      return item(alias, col ? `${col.kuerzel} ${col.name}` : '?', alias, alias.length, alias.length);
    }).join('');

    const formulasHtml = formulas.filter(f => f.name.trim()).map(f => {
      const name = f.name.trim();
      return item(name, 'Formel', name, name.length, name.length, false, null, formulaColorFor(f));
    }).join('');

    const funcsHtml = funcs.filter(f => f.name.trim()).map(f => {
      const name = f.name.trim();
      const params = f.params.map(p => p.trim()).filter(Boolean);
      const argList = params.join(', ');
      const ranges = params.length ? argRangesFor(name, params) : [{ start: name.length + 1, end: name.length + 1 }];
      return item(name, `(${argList})`, `${name}(${argList})`, ranges[0].start, ranges[0].end, false, ranges);
    }).join('');

    const primHtml = GZ.exprEngine.PRIMITIVE_INFO.map(p => {
      const argList = p.params.join(', ');
      const ranges = argRangesFor(p.name, p.params);
      return item(p.name, `(${argList})`, `${p.name}(${argList})`, ranges[0].start, ranges[0].end, false, ranges);
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
      section('Formeln', formulasHtml),
      section('Funktionen', funcsHtml),
      section('Primitiven', primHtml),
      section('Zustände', `<div class="fsb-chips">${katChips}</div>`),
      section('Objekte (ohne Variable)', objHtml)
    ].join('');

    els.sidebar.querySelectorAll('[data-insert]').forEach(el => {
      el.onmousedown = ev => {
        ev.preventDefault(); // Fokus im Ausdrucksfeld erhalten (siehe insertTextAtFocused())
        let ranges = null;
        try { ranges = el.dataset.argRanges ? JSON.parse(el.dataset.argRanges) : null; } catch (e) { ranges = null; }
        insertTextAtFocused(el.dataset.insert, Number(el.dataset.selStart), Number(el.dataset.selEnd), ranges);
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
  // null. Der wrap trägt __exprInsertAt (siehe GZ.exprEditor.setup()), über den
  // die Sidebar einfügt, ohne Modell-Interna der jeweiligen Zeile zu kennen.
  function activeExprWrap() {
    const el = document.activeElement;
    if (!el || !el.classList || !el.classList.contains('expr-editor')) return null;
    return el.closest('.expr-input-wrap');
  }

  // Fügt Text in das aktuell fokussierte Ausdrucksfeld ein - no-op mit
  // Hinweis, wenn gerade keins fokussiert ist (siehe activeExprWrap()).
  function insertTextAtFocused(text, selStart, selEnd, argRanges) {
    const wrap = activeExprWrap();
    const ok = wrap && wrap.__exprInsertAt && wrap.__exprInsertAt(text, selStart, selEnd, argRanges);
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
  //
  // cycleMetricsByIdx (je Umlaufindex vorberechnet, siehe GZ.segments.
  // computeCycleSgMetrics/computeCycleDetMetrics) speist die umlaufweisen
  // exprEngine-Primitiven An/Ab/TF/RG/GE/Ausgeloest/AnzahlAusloesungen -
  // cycleMetrics (der von den Primitiven gelesene Live-Wert) wird in
  // berechnen() beim Vorrücken über cyclePtr mitgeführt, analog zu sweep.
  function buildObjectHandle(a, type, col, TU_MED) {
    if (type === 'SG') {
      const sgEntry = a.allStats.find(s => s.col.index === col.index);
      const segs = sgEntry ? sgEntry.segs : [];
      const greens = sgEntry ? sgEntry.stats.greens : [];
      return {
        class: 'SG', sweep: makePointSegmentSweep(segs), cycleMetrics: null,
        cycleMetricsByIdx: computeCycleSgMetrics(segs, greens, a.cycleStarts, a.tMax, TU_MED)
      };
    }
    const segs = buildSegments(a.times, a.seriesByCol.get(col.index), categorizeDetRaw);
    const rawVals = a.seriesByCol.get(col.index);
    const occupied = a.times.map((_, k) => wzIstBelegt(rawVals[k]));
    return {
      class: 'DET', sweep: makePointSegmentSweep(segs), cycleMetrics: null,
      cycleMetricsByIdx: computeCycleDetMetrics(a.times, occupied, a.cycleStarts, a.tMax)
    };
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

    // Einmal global (nicht je Variable) - Grundlage der umlaufweisen
    // An/Ab/TF/RG/GE-Primitiven UND des TU_MED-Bezeichners im scope unten.
    const TU_MED = computeGlobalTU(cycleStarts);

    const scopeSpecs = vars.map(v => {
      const alias = v.alias.trim();
      const col = cols.find(c => c.index === v.colIndex);
      const type = col ? varTypeForCol(col) : 'NUM';
      if (type === 'SG' || type === 'DET') return { alias, type, handle: buildObjectHandle(a, type, col, TU_MED) };
      return { alias, type, series: col ? seriesByCol.get(col.index) : null };
    }).filter(s => s.alias);

    // TX = Sekunden seit Umlaufbeginn des aktuellen Zyklus, per fortlaufendem
    // Zeiger über cycleStarts (wie überall sonst im Code) statt Binärsuche
    // je Zeile - amortisiert O(n) über die gesamte Aufzeichnung. Dient den
    // Zustand/Dauer/DauerSeit-Primitiven rein deklarativ (siehe exprEngine.js
    // Kopfkommentar) - der eigentliche Auswertungszeitpunkt läuft über das
    // jeweilige Objekt-Handle (handle.sweep.advance() unten), nicht über TX.
    // TU/TU_MED/SPL ergänzen das für die umlaufweisen Primitiven relevante
    // Vokabular (aktuelle Umlaufdauer, Median-Umlaufzeit, aktives
    // Signalprogramm) - dieselben Bezeichner wie in Umlaufstatistiken.
    const varTypesWithTx = { ...types, TX: 'NUM', TU: 'NUM', TU_MED: 'NUM', SPL: 'TEXT' };

    // ---------- 1) Kompilieren (rein syntaktisch/typgeprüft) ----------
    const byId = new Map(formulas.map(f => [f.id, f]));
    const nameToId = new Map(formulas.map(f => [f.name.trim(), f.id]).filter(([n]) => n));
    const compiledById = new Map();
    const skipReasonById = new Map(); // id -> Meldung (Kompilierfehler ODER Abhängigkeits-/Zyklusproblem)
    formulas.forEach(f => {
      const compiled = compile(f.exprText, varTypesWithTx, funcDefs);
      if (compiled.ok) compiledById.set(f.id, compiled);
      else skipReasonById.set(f.id, compiled.message);
    });

    // ---------- 2) Abhängigkeiten ermitteln ----------
    // Welche ANDEREN Formelnamen referenziert diese Formel als bloßen
    // Bezeichner (kein Funktionsaufruf)? Über denselben Tokenizer wie das
    // eigentliche Parsen ermittelt (nicht per Regex) - erkennt so zuverlässig
    // NUR echte Bezeichner-Vorkommen, nie z.B. einen gleichlautenden Namen
    // innerhalb eines Text-Literals.
    const depsById = new Map();
    compiledById.forEach((_, id) => {
      const f = byId.get(id);
      const deps = new Set();
      const tokens = GZ.exprEngine.tokenize(f.exprText);
      tokens.forEach((tok, idx) => {
        if (tok.type !== 'IDENT') return;
        if (tokens[idx + 1] && tokens[idx + 1].type === '(') return; // Funktionsaufruf, keine Formel-Referenz
        const depId = nameToId.get(tok.value);
        // Absichtlich OHNE "depId !== id"-Ausschluss: eine Selbstreferenz
        // (Formel referenziert sich direkt beim eigenen Namen) muss als
        // Ein-Knoten-Zyklus im Graphen sichtbar sein, sonst erkennt visit()
        // unten (das einen Zyklus über ein erneutes Antreffen eines Knotens
        // MIT Zustand "in Bearbeitung" erkennt) ihn nie - ohne diese Kante
        // hätte die Formel schlicht keine Abhängigkeiten und würde (mit
        // ihrem eigenen, zu diesem Zeitpunkt noch undefinierten scope-Wert)
        // einfach falsch statt erkennbar zyklisch berechnet.
        if (depId != null) deps.add(depId);
      });
      depsById.set(id, deps);
    });

    // ---------- 3) Topologisch ordnen + Zyklen erkennen ----------
    // Klassische DFS mit 3 Zuständen (0 unbesucht, 1 in Bearbeitung, 2
    // fertig): ein Rücksprung auf einen Knoten MIT Zustand 1 ist ein Zyklus -
    // alle Knoten vom Zyklusbeginn bis zum Stapelende sind daran beteiligt
    // und werden komplett übersprungen (nicht nur der zuletzt besuchte).
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
    // Jede bereits fertige Formel steht nachfolgenden (die sie referenzieren)
    // als BOOL-Wert im scope zur Verfügung - dieselbe Rohreihe, die auch die
    // synthetische FORMEL-Spalte speist.
    const rawSeriesById = new Map();
    order.forEach(id => {
      const f = byId.get(id);
      const compiled = compiledById.get(id);
      const deps = depsById.get(id);
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
        const cycleEnd = cyclePtr + 1 < cycleStarts.length ? cycleStarts[cyclePtr + 1] : a.tMax;
        const tuSeconds = cycleStarts.length ? Math.round((cycleEnd - cycleStarts[cyclePtr]) / 1000) : NaN;

        const scope = { TX: txSeconds, TU: tuSeconds, TU_MED: TU_MED == null ? NaN : TU_MED, SPL: a.splValues ? (a.splValues[i] || '') : '' };
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
    // (nicht Auswertungsreihenfolge - die Objekt-/Sidebar-Liste soll stabil
    // in der vom Nutzer angelegten Formel-Reihenfolge bleiben.)
    const computed = [];
    const skippedList = []; // {name, message} - für Hint-Zeile UND Snackbar
    formulas.forEach(f => {
      const name = f.name.trim() || `F${f.id}`;
      const rawSeries = rawSeriesById.get(f.id);
      if (!rawSeries) {
        f.rawSeries = null;
        skippedList.push({ name, message: skipReasonById.get(f.id) || 'Unbekannter Fehler' });
        return;
      }
      // Für getFormulaHighlights(): dieselbe Rohreihe, die auch die
      // synthetische FORMEL-Spalte speist, direkt an der Formel selbst
      // hinterlegen - dort in WAHR/FALSCH-Intervalle zu übersetzen ist billig
      // genug, um es bei Bedarf (statt hier vorab) zu tun.
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

  // Lesezugriff für umlaufpruefung.js: zuletzt berechnete synthetische
  // Spalten (leer, solange "Berechnen" noch nicht geklickt wurde bzw. nach
  // einem neuen Datenimport - siehe populateControls()).
  function getSyntheticColumns() { return syntheticCols; }

  // Lesezugriff für umlaufpruefung.js: je Formel mit gesetztem Hervorhebungs-
  // Ziel die WAHR-Intervalle (aus derselben Rohreihe wie die synthetische
  // FORMEL-Spalte, siehe berechnen()) plus Zielspalte (Kürzel+Name - NICHT
  // Rohindex, siehe Kopfkommentar unten) und zugeteilte Farbe. Leer, solange
  // "Berechnen" noch nicht geklickt wurde (kein f.rawSeries) oder kein Ziel
  // gewählt ist.
  //
  // WICHTIG: das Ziel wird über Kürzel+Name statt Rohindex identifiziert.
  // sourceCols() liefert für Signalgruppen den ROHEN CSV-Spaltenindex
  // (col.index aus parser.js), während umlaufpruefung.js seine eigenen
  // SG-Objekte stattdessen über die POSITION im allStats-Array indiziert
  // (siehe dortiges allObjects()) - beide Zählweisen fallen nur zufällig
  // zusammen, wenn vor der ersten Signalgruppe keine andere Spalte in der
  // CSV steht. Kürzel+Name ist die einzige zwischen beiden Dateien stabile
  // Kennung (dasselbe Muster wie bei vars/getConfig() oben).
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
      formulas: formulas.map(f => {
        const col = cols.find(c => c.index === f.highlightCol);
        return {
          name: f.name, exprText: f.exprText,
          highlightColKuerzel: col ? col.kuerzel : null, highlightColName: col ? col.name : null
        };
      })
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
    formulas = (cfg.formulas || []).map(f => {
      let highlightCol = null;
      if (f.highlightColKuerzel && f.highlightColName) {
        const col = cols.find(c => c.kuerzel === f.highlightColKuerzel && c.name === f.highlightColName);
        highlightCol = col ? col.index : null; // still ohne Hervorhebung, aber kein Skip-Eintrag (rein optisch, nicht kritisch)
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
