/* GZ.exprEngine — kleiner, abhängigkeitsfreier Formel-Interpreter für den
   Umlaufprüfung-Formel-Builder (synthetische Detektoren aus Variablen-
   Ausdrücken). Reine Berechnungslogik, kein DOM-Bezug.

   Grammatik (Präzedenz niedrig -> hoch):
     or   := and (OR and)*
     and  := not (AND not)*
     not  := NOT not | cmp
     cmp  := add ((> | >= | < | <= | == | !=) add)?     -- nicht verkettbar
     add  := mul ((+|-) mul)*
     mul  := unary ((*|/) unary)*
     unary:= '-' unary | atom
     atom := NUMBER | KATLIT | IDENT | IDENT '(' (or (',' or)*)? ')' | '(' or ')'

   Typen: NUM, BOOL, SG, DET (Objekt-Handles auf eine Signalgruppen-/
   Detektor-Variable), KAT_SG, KAT_DET (Zustands-Konstanten, z.B. GRUEN/
   BELEGT), ANY (Platzhalter für einen noch nicht gebundenen Funktions-
   parameter, siehe compileFunctionDef() - erfüllt jede Typprüfung, damit
   eine Funktionsdefinition VOR ihrer ersten Verwendung syntaktisch geprüft
   werden kann, ohne die konkreten Argumenttypen zu kennen). Operatoren
   erzwingen den erwarteten Typ ihrer Operanden (AND/OR/NOT nur BOOL,
   Arithmetik nur NUM, Vergleich NUM==NUM ODER gleichartiges KAT==KAT) -
   Typfehler werden beim Parsen erkannt, ohne dass Daten ausgewertet werden
   müssen. Der Gesamtausdruck einer Formel (siehe compile()) muss zu BOOL
   auswerten; der Rumpf einer benutzerdefinierten Funktion (siehe
   compileFunctionDef()) darf einen beliebigen Typ liefern - erst der
   tatsächliche Aufruf an einer Formel entscheidet, ob das passt.

   Benutzerdefinierte Funktionen (funcs-Parameter von compile()/parse(), Form
   { [name]: {params:string[], exprText:string} }): ein Aufruf FUNC(a,b,...)
   wird "inline" expandiert - der Rumpftext wird mit einer neuen varTypes-
   Bindung (Parametername -> tatsächlicher Argumenttyp DIESES Aufrufs) neu
   geparst/typgeprüft (siehe parseCall()). Das bedeutet: derselbe Funktions-
   rumpf wird potenziell mehrfach mit unterschiedlichen konkreten Typen
   spezialisiert (wie C++-Templates/Java-Generics bei der Instanziierung),
   nicht einmalig kompiliert. Ein visiting-Set (Funktionsnamen im aktuellen
   Expansions-Stack) verhindert zyklische Aufrufe (A ruft B ruft A) mit
   einem klaren Fehler statt eines Stapelüberlaufs.

   Eingebaute Funktionen (PRIMITIVES unten) verwandeln ein Objekt-Handle in
   einen auswertbaren Wert - Zustand(sg|det, TX)->KAT_*, Dauer(sg|det, TX)
   ->NUM (Sekunden im aktuellen Zustand), DauerSeit(sg|det, kategorie, TX)
   ->NUM (Sekunden seit dem letzten Eintritt in "kategorie", 0 wenn gerade
   nicht in diesem Zustand). TX ist rein deklarativ (self-dokumentierend,
   "an dieser Stelle ausgewertet") - der aktuelle Auswertungspunkt wird
   NICHT über den TX-Wert selbst durchgereicht, sondern über das jeweilige
   Objekt-Handle (siehe scope unten), daher ignorieren die Primitiven TX
   zur Laufzeit; es wird nur typgeprüft (muss NUM sein).

   scope-Objekt bei run(scope): Alias -> Wert. NUM-Variablen (APW/ÖPNV) sind
   number (NaN bei fehlendem Rohwert - jeder Vergleich mit NaN ist in JS
   automatisch false, Division durch 0 ergibt Infinity/NaN - kein Sonderfall
   nötig, das Verhalten ist bewusst "fehlender/undefinierter Wert ->
   Bedingung nicht erfüllt"). SG-/DET-Variablen sind ein Handle
   { class:'SG'|'DET', sweep }, wobei sweep ein GZ.segments.
   makePointSegmentSweep()-Objekt ist, dessen advance(t) VOR jedem run()-
   Aufruf einmal je Zeile vom Aufrufer (formulaBuilder.js berechnen())
   vorgerückt wird - die Primitiven lesen nur sweep.segment()/sweep.time(). */
(function (GZ) {
  'use strict';

  class ExprError extends Error {
    constructor(message, pos) { super(message); this.pos = pos; }
  }

  const CMP_OPS = { '>': (a, b) => a > b, '<': (a, b) => a < b, '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '==': (a, b) => a === b, '!=': (a, b) => a !== b };
  const TYPE_LABEL = t => ({
    BOOL: 'WAHR/FALSCH', NUM: 'eine Zahl',
    SG: 'eine Signalgruppe', DET: 'einen Detektor',
    KAT_SG: 'einen Signalgruppen-Zustand', KAT_DET: 'einen Detektor-Zustand',
    ANY: 'einen (noch unbestimmten) Parameterwert'
  })[t] || t;
  const isNumCompatible = t => t === 'NUM' || t === 'ANY';
  const isKatCompatible = t => t === 'KAT_SG' || t === 'KAT_DET' || t === 'ANY';
  const isObjCompatible = t => t === 'SG' || t === 'DET' || t === 'ANY';

  // Zustands-Konstanten (exakte Schreibweise, siehe GZ.parser STATE_CAT/
  // categorizeDetRaw) - UNBEKANNT/INV/LUECKE sind bewusst NICHT als
  // schreibbare Literale exponiert (Datenqualitäts-Artefakte, keine
  // "echten" Signalzustände).
  const KAT_TOKENS = {
    GRUEN: 'KAT_SG', ROT: 'KAT_SG', GELB: 'KAT_SG', ROTGELB: 'KAT_SG', DUNKEL: 'KAT_SG',
    BELEGT: 'KAT_DET', FREI: 'KAT_DET'
  };

  const katTypeForObj = t => t === 'SG' ? 'KAT_SG' : t === 'DET' ? 'KAT_DET' : 'ANY';

  // Eingebaute Funktionen: Objekt-Handle (+ optional Kategorie/TX) -> Wert.
  // check(argNodes, pos) wirft ExprError bei Typfehlern und liefert den
  // Ergebnistyp; run(argNodes) baut den run(scope)-Closure. Akzeptiert ANY
  // (noch unspezialisierter Funktionsparameter) überall dort, wo sonst SG/
  // DET/NUM/KAT_* verlangt wird - siehe Datei-Kopfkommentar zu ANY.
  const PRIMITIVES = {
    Zustand: {
      arity: 2,
      check(args, pos) {
        const [obj, tx] = args;
        if (!isObjCompatible(obj.type)) throw new ExprError('"Zustand" erwartet als 1. Argument eine Signalgruppe oder einen Detektor', pos);
        if (!isNumCompatible(tx.type)) throw new ExprError(`"Zustand" (2. Argument TX) erwartet eine Zahl, bekam ${TYPE_LABEL(tx.type)}`, pos);
        return katTypeForObj(obj.type);
      },
      run(args) {
        const [objNode] = args;
        return scope => {
          const seg = objNode.run(scope).sweep.segment();
          return seg ? seg.cat : null;
        };
      }
    },
    Dauer: {
      arity: 2,
      check(args, pos) {
        const [obj, tx] = args;
        if (!isObjCompatible(obj.type)) throw new ExprError('"Dauer" erwartet als 1. Argument eine Signalgruppe oder einen Detektor', pos);
        if (!isNumCompatible(tx.type)) throw new ExprError(`"Dauer" (2. Argument TX) erwartet eine Zahl, bekam ${TYPE_LABEL(tx.type)}`, pos);
        return 'NUM';
      },
      run(args) {
        const [objNode] = args;
        return scope => {
          const handle = objNode.run(scope);
          const seg = handle.sweep.segment();
          return seg ? (handle.sweep.time() - seg.start) / 1000 : 0;
        };
      }
    },
    DauerSeit: {
      arity: 3,
      check(args, pos) {
        const [obj, kat, tx] = args;
        if (!isObjCompatible(obj.type)) throw new ExprError('"DauerSeit" erwartet als 1. Argument eine Signalgruppe oder einen Detektor', pos);
        if (obj.type === 'SG' || obj.type === 'DET') {
          const expectedKat = katTypeForObj(obj.type);
          if (kat.type !== expectedKat && kat.type !== 'ANY') {
            throw new ExprError(`"DauerSeit" (2. Argument) erwartet ${TYPE_LABEL(expectedKat)} passend zum 1. Argument, bekam ${TYPE_LABEL(kat.type)}`, pos);
          }
        } else if (!isKatCompatible(kat.type)) {
          throw new ExprError('"DauerSeit" (2. Argument) erwartet einen Zustand', pos);
        }
        if (!isNumCompatible(tx.type)) throw new ExprError(`"DauerSeit" (3. Argument TX) erwartet eine Zahl, bekam ${TYPE_LABEL(tx.type)}`, pos);
        return 'NUM';
      },
      run(args) {
        const [objNode, katNode] = args;
        return scope => {
          const handle = objNode.run(scope);
          const seg = handle.sweep.segment();
          if (!seg || seg.cat !== katNode.run(scope)) return 0;
          return (handle.sweep.time() - seg.start) / 1000;
        };
      }
    }
  };

  // Anzeige-Metadaten für Primitiven (Autovervollständigung/Funktions-Palette
  // in formulaBuilder.js) - getrennt von PRIMITIVES.check/run oben, da rein
  // beschreibend (keine Auswertungslogik).
  const PRIMITIVE_INFO = [
    { name: 'Zustand', params: ['objekt', 'TX'], desc: 'aktueller Zustand (GRUEN/ROT/GELB/ROTGELB/DUNKEL bzw. BELEGT/FREI)' },
    { name: 'Dauer', params: ['objekt', 'TX'], desc: 'Sekunden im aktuellen Zustand' },
    { name: 'DauerSeit', params: ['objekt', 'zustand', 'TX'], desc: 'Sekunden seit letztem Eintritt in "zustand" (0, wenn nicht aktuell darin)' }
  ];

  function tokenize(text) {
    const tokens = [];
    const n = text.length;
    let i = 0;
    const isDigit = ch => ch >= '0' && ch <= '9';
    const isIdentStart = ch => /[A-Za-z_]/.test(ch);
    const isIdentPart = ch => /[A-Za-z0-9_]/.test(ch);
    while (i < n) {
      const ch = text[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
      const start = i;
      if (isDigit(ch) || (ch === '.' && isDigit(text[i + 1]))) {
        let j = i;
        while (j < n && isDigit(text[j])) j++;
        if (text[j] === '.') { j++; while (j < n && isDigit(text[j])) j++; }
        tokens.push({ type: 'NUMBER', value: Number(text.slice(i, j)), pos: start, end: j });
        i = j;
        continue;
      }
      if (isIdentStart(ch)) {
        let j = i + 1;
        while (j < n && isIdentPart(text[j])) j++;
        const word = text.slice(i, j);
        const upper = word.toUpperCase();
        if (upper === 'AND' || upper === 'OR' || upper === 'NOT') tokens.push({ type: upper, pos: start, end: j });
        else if (KAT_TOKENS[word]) tokens.push({ type: 'KATLIT', value: word, katType: KAT_TOKENS[word], pos: start, end: j });
        else tokens.push({ type: 'IDENT', value: word, pos: start, end: j });
        i = j;
        continue;
      }
      const two = text.slice(i, i + 2);
      if (two === '>=' || two === '<=' || two === '==' || two === '!=') { tokens.push({ type: two, pos: start, end: start + 2 }); i += 2; continue; }
      if ('+-*/(),><'.includes(ch)) { tokens.push({ type: ch, pos: start, end: start + 1 }); i++; continue; }
      throw new ExprError(`Unerwartetes Zeichen "${ch}"`, start);
    }
    tokens.push({ type: 'EOF', pos: n, end: n });
    return tokens;
  }

  // varTypes: { [alias]: 'BOOL'|'NUM'|'SG'|'DET'|'ANY' }
  // funcs: { [name]: {params:string[], exprText:string} } (benutzerdefinierte
  // Funktionen, siehe Datei-Kopfkommentar) - optional, Default {}.
  // visiting: Set<string> der Funktionsnamen im aktuellen Expansions-Stack
  // (Zyklenerkennung bei Funktionsaufrufen) - optional, Default leeres Set.
  // Liefert den geparsten/typgeprüften Wurzelknoten OHNE die BOOL-Pflicht
  // von compile() - die gilt nur für den Formel-Text selbst, nicht für
  // (Zwischen-)Aufrufe von Funktionsrümpfen.
  function parse(tokens, varTypes, funcs, visiting) {
    funcs = funcs || {};
    visiting = visiting || new Set();
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    const expect = type => {
      if (peek().type !== type) throw new ExprError(`Erwartet "${type}", gefunden "${peek().type === 'EOF' ? 'Ende' : peek().type}"`, peek().pos);
      return next();
    };
    const requireType = (node, expected, atPos, opLabel) => {
      if (node.type !== expected && node.type !== 'ANY') {
        throw new ExprError(`"${opLabel}" erwartet ${TYPE_LABEL(expected)}, bekam ${TYPE_LABEL(node.type)}`, atPos);
      }
    };

    function parseOr() {
      let left = parseAnd();
      while (peek().type === 'OR') {
        const opTok = next();
        requireType(left, 'BOOL', opTok.pos, 'OR');
        const right = parseAnd();
        requireType(right, 'BOOL', opTok.pos, 'OR');
        const l = left, r = right;
        left = { type: 'BOOL', run: scope => l.run(scope) || r.run(scope) };
      }
      return left;
    }
    function parseAnd() {
      let left = parseNot();
      while (peek().type === 'AND') {
        const opTok = next();
        requireType(left, 'BOOL', opTok.pos, 'AND');
        const right = parseNot();
        requireType(right, 'BOOL', opTok.pos, 'AND');
        const l = left, r = right;
        left = { type: 'BOOL', run: scope => l.run(scope) && r.run(scope) };
      }
      return left;
    }
    function parseNot() {
      if (peek().type === 'NOT') {
        const opTok = next();
        const child = parseNot();
        requireType(child, 'BOOL', opTok.pos, 'NOT');
        return { type: 'BOOL', run: scope => !child.run(scope) };
      }
      return parseComparison();
    }
    function parseComparison() {
      const left = parseAdd();
      if (Object.prototype.hasOwnProperty.call(CMP_OPS, peek().type)) {
        const opTok = next();
        const right = parseAdd();
        const bothNum = isNumCompatible(left.type) && isNumCompatible(right.type);
        // Konkret unterschiedliche KAT-Subtypen (KAT_SG vs. KAT_DET) sind nie
        // vergleichbar; ist eine Seite noch ANY (unspezialisierter Funktions-
        // parameter), lässt sich das erst am tatsächlichen Aufruf entscheiden.
        const concreteKatMismatch = (left.type === 'KAT_SG' && right.type === 'KAT_DET') || (left.type === 'KAT_DET' && right.type === 'KAT_SG');
        const bothSameKat = isKatCompatible(left.type) && isKatCompatible(right.type) && !concreteKatMismatch;
        if (!bothNum && !bothSameKat) {
          throw new ExprError(`"${opTok.type}" erwartet zwei Zahlen oder zwei gleichartige Zustände, bekam ${TYPE_LABEL(left.type)} und ${TYPE_LABEL(right.type)}`, opTok.pos);
        }
        const isConcreteKat = left.type === 'KAT_SG' || left.type === 'KAT_DET' || right.type === 'KAT_SG' || right.type === 'KAT_DET';
        if (bothSameKat && isConcreteKat && opTok.type !== '==' && opTok.type !== '!=') {
          throw new ExprError(`"${opTok.type}" ist für Zustände nicht sinnvoll - nur == oder != verwenden`, opTok.pos);
        }
        const fn = CMP_OPS[opTok.type], l = left, r = right;
        return { type: 'BOOL', run: scope => fn(l.run(scope), r.run(scope)) };
      }
      return left;
    }
    function parseAdd() {
      let left = parseMul();
      while (peek().type === '+' || peek().type === '-') {
        const opTok = next();
        requireType(left, 'NUM', opTok.pos, opTok.type);
        const right = parseMul();
        requireType(right, 'NUM', opTok.pos, opTok.type);
        const l = left, r = right, isPlus = opTok.type === '+';
        left = { type: 'NUM', run: scope => isPlus ? l.run(scope) + r.run(scope) : l.run(scope) - r.run(scope) };
      }
      return left;
    }
    function parseMul() {
      let left = parseUnary();
      while (peek().type === '*' || peek().type === '/') {
        const opTok = next();
        requireType(left, 'NUM', opTok.pos, opTok.type);
        const right = parseUnary();
        requireType(right, 'NUM', opTok.pos, opTok.type);
        const l = left, r = right, isMul = opTok.type === '*';
        left = { type: 'NUM', run: scope => isMul ? l.run(scope) * r.run(scope) : l.run(scope) / r.run(scope) };
      }
      return left;
    }
    function parseUnary() {
      if (peek().type === '-') {
        const opTok = next();
        const child = parseUnary();
        requireType(child, 'NUM', opTok.pos, '-');
        const c = child;
        return { type: 'NUM', run: scope => -c.run(scope) };
      }
      return parseAtom();
    }
    function parseArgs() {
      const args = [];
      if (peek().type !== ')') {
        args.push(parseOr());
        while (peek().type === ',') { next(); args.push(parseOr()); }
      }
      expect(')');
      return args;
    }

    function parseCall(name, namePos) {
      const args = parseArgs();
      const prim = PRIMITIVES[name];
      if (prim) {
        if (args.length !== prim.arity) {
          throw new ExprError(`"${name}" erwartet ${prim.arity} Argument(e), bekam ${args.length}`, namePos);
        }
        const returnType = prim.check(args, namePos);
        return { type: returnType, run: prim.run(args) };
      }

      const fn = funcs[name];
      if (!fn) throw new ExprError(`Unbekannte Funktion "${name}"`, namePos);
      if (args.length !== fn.params.length) {
        throw new ExprError(`"${name}" erwartet ${fn.params.length} Argument(e), bekam ${args.length}`, namePos);
      }
      if (visiting.has(name)) {
        throw new ExprError(`Zyklischer Funktionsaufruf: "${name}" ruft sich (direkt oder indirekt) selbst auf`, namePos);
      }
      // Aufruf-Expansion: Rumpf mit den TATSÄCHLICHEN Argumenttypen DIESES
      // Aufrufs neu parsen/typprüfen (Spezialisierung je Aufrufstelle, siehe
      // Datei-Kopfkommentar) - kein einmalig kompilierter, generischer Rumpf.
      const localVarTypes = { TX: 'NUM' };
      fn.params.forEach((p, i) => { localVarTypes[p] = args[i].type; });
      const nextVisiting = new Set(visiting);
      nextVisiting.add(name);
      let bodyNode;
      try {
        bodyNode = parse(tokenize(fn.exprText), localVarTypes, funcs, nextVisiting);
      } catch (e) {
        const msg = e instanceof ExprError ? e.message : (e.message || String(e));
        throw new ExprError(`In Funktion "${name}": ${msg}`, namePos);
      }
      const params = fn.params, argNodes = args;
      return {
        type: bodyNode.type,
        run: scope => {
          const paramScope = { TX: scope.TX };
          params.forEach((p, i) => { paramScope[p] = argNodes[i].run(scope); });
          return bodyNode.run(paramScope);
        }
      };
    }

    function parseAtom() {
      const tok = peek();
      if (tok.type === 'NUMBER') { next(); const v = tok.value; return { type: 'NUM', run: () => v }; }
      if (tok.type === 'KATLIT') { next(); const v = tok.value, kt = tok.katType; return { type: kt, run: () => v }; }
      if (tok.type === 'IDENT') {
        next();
        if (peek().type === '(') { next(); return parseCall(tok.value, tok.pos); }
        const varType = varTypes[tok.value];
        if (!varType) throw new ExprError(`Unbekannte Variable "${tok.value}"`, tok.pos);
        const alias = tok.value;
        return { type: varType, run: scope => scope[alias] };
      }
      if (tok.type === '(') {
        next();
        const inner = parseOr();
        expect(')');
        return inner;
      }
      throw new ExprError(`Unerwarteter Ausdruck bei "${tok.type === 'EOF' ? 'Ende' : tok.type}"`, tok.pos);
    }

    const result = parseOr();
    expect('EOF');
    return result;
  }

  // Parst UND typprüft (aber wertet nicht aus) EINEN FORMEL-Text - für Live-
  // Validierung sowie als Vorstufe der eigentlichen Berechnung. Muss zu BOOL
  // auswerten (anders als ein Funktionsrumpf, siehe compileFunctionDef()).
  // varTypes: { [alias]: 'BOOL'|'NUM'|'SG'|'DET' }
  // funcs: { [name]: {params:string[], exprText:string} }, optional.
  // Rückgabe: { ok:true, run(scope)->boolean } | { ok:false, message, pos }
  function compile(text, varTypes, funcs) {
    if (!text || !text.trim()) return { ok: false, message: 'Formel ist leer.', pos: 0 };
    try {
      const tokens = tokenize(text);
      const node = parse(tokens, varTypes || {}, funcs || {});
      if (node.type !== 'BOOL') {
        throw new ExprError('Die Formel muss insgesamt zu WAHR/FALSCH auswerten (z.B. mit einem Vergleich wie "<" oder einer Verknüpfung mit AND/OR)', 0);
      }
      return { ok: true, run: node.run };
    } catch (e) {
      if (e instanceof ExprError) return { ok: false, message: e.message, pos: e.pos };
      return { ok: false, message: e.message || String(e), pos: 0 };
    }
  }

  // Parst UND typprüft (aber wertet nicht aus) EINEN FUNKTIONS-Rumpf, isoliert
  // von jeder konkreten Aufrufstelle - jeder Parameter erhält den Platzhalter-
  // Typ ANY (siehe Datei-Kopfkommentar), da der tatsächliche Typ erst am
  // jeweiligen Aufruf bekannt ist. Das prüft Syntax + grobe Struktur (bekannte
  // Bezeichner/Funktionen, Argumentanzahl) VOR der ersten Verwendung, kann
  // aber echte Typfehler (die erst mit konkreten Argumenttypen entstehen)
  // naturgemäß nicht abschließend erkennen - die entstehen ggf. erst bei
  // compile() eines Aufrufers (Fehlermeldung dann "In Funktion […]: …").
  // Rückgabe: { ok:true, resultType } | { ok:false, message, pos }
  function compileFunctionDef(params, text, funcs) {
    if (!text || !text.trim()) return { ok: false, message: 'Ausdruck ist leer.', pos: 0 };
    const varTypes = { TX: 'NUM' };
    (params || []).forEach(p => { varTypes[p] = 'ANY'; });
    try {
      const tokens = tokenize(text);
      const node = parse(tokens, varTypes, funcs || {});
      return { ok: true, resultType: node.type };
    } catch (e) {
      if (e instanceof ExprError) return { ok: false, message: e.message, pos: e.pos };
      return { ok: false, message: e.message || String(e), pos: 0 };
    }
  }

  // tokenize/PRIMITIVE_INFO/KAT_TOKENS werden zusätzlich exportiert, damit
  // formulaBuilder.js Syntax-Highlighting/Autovervollständigung/Funktions-
  // Palette auf demselben Lexer/derselben Primitiven-Liste aufbaut statt sie
  // in der UI-Schicht zu duplizieren (Single Source of Truth).
  GZ.exprEngine = { compile, compileFunctionDef, tokenize, PRIMITIVE_INFO, KAT_TOKENS };
})(window.GZ = window.GZ || {});
