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
     atom := NUMBER | IDENT | '(' or ')'

   Jeder Knoten trägt einen Typ ('NUM' oder 'BOOL'); Operatoren erzwingen den
   erwarteten Typ ihrer Operanden (z.B. AND/OR/NOT nur auf BOOL, Vergleiche/
   Arithmetik nur auf NUM) - Typfehler werden beim Parsen erkannt, ohne dass
   Daten ausgewertet werden müssen (siehe compile()). Der Gesamtausdruck muss
   zu BOOL auswerten.

   scope-Objekt bei run(scope): Alias -> Wert. BOOL-Variablen (Detektoren)
   sind true/false, NUM-Variablen (APW/ÖPNV) sind number (NaN bei fehlendem
   Rohwert - jeder Vergleich mit NaN ist in JS automatisch false, Division
   durch 0 ergibt Infinity/NaN - kein Sonderfall nötig, das Verhalten ist
   bewusst "fehlender/undefinierter Wert -> Bedingung nicht erfüllt"). */
(function (GZ) {
  'use strict';

  class ExprError extends Error {
    constructor(message, pos) { super(message); this.pos = pos; }
  }

  const CMP_OPS = { '>': (a, b) => a > b, '<': (a, b) => a < b, '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '==': (a, b) => a === b, '!=': (a, b) => a !== b };
  const TYPE_LABEL = t => t === 'BOOL' ? 'WAHR/FALSCH' : 'eine Zahl';

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
        tokens.push({ type: 'NUMBER', value: Number(text.slice(i, j)), pos: start });
        i = j;
        continue;
      }
      if (isIdentStart(ch)) {
        let j = i + 1;
        while (j < n && isIdentPart(text[j])) j++;
        const word = text.slice(i, j);
        const upper = word.toUpperCase();
        if (upper === 'AND' || upper === 'OR' || upper === 'NOT') tokens.push({ type: upper, pos: start });
        else tokens.push({ type: 'IDENT', value: word, pos: start });
        i = j;
        continue;
      }
      const two = text.slice(i, i + 2);
      if (two === '>=' || two === '<=' || two === '==' || two === '!=') { tokens.push({ type: two, pos: start }); i += 2; continue; }
      if ('+-*/()><'.includes(ch)) { tokens.push({ type: ch, pos: start }); i++; continue; }
      throw new ExprError(`Unerwartetes Zeichen "${ch}"`, start);
    }
    tokens.push({ type: 'EOF', pos: n });
    return tokens;
  }

  // varTypes: { [alias]: 'BOOL' | 'NUM' }
  function parse(tokens, varTypes) {
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    const expect = type => {
      if (peek().type !== type) throw new ExprError(`Erwartet "${type}", gefunden "${peek().type === 'EOF' ? 'Ende' : peek().type}"`, peek().pos);
      return next();
    };
    const requireType = (node, expected, atPos, opLabel) => {
      if (node.type !== expected) throw new ExprError(`"${opLabel}" erwartet ${TYPE_LABEL(expected)}, bekam ${TYPE_LABEL(node.type)}`, atPos);
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
        requireType(left, 'NUM', opTok.pos, opTok.type);
        const right = parseAdd();
        requireType(right, 'NUM', opTok.pos, opTok.type);
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
    function parseAtom() {
      const tok = peek();
      if (tok.type === 'NUMBER') { next(); const v = tok.value; return { type: 'NUM', run: () => v }; }
      if (tok.type === 'IDENT') {
        next();
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
    if (result.type !== 'BOOL') {
      throw new ExprError('Die Formel muss insgesamt zu WAHR/FALSCH auswerten (z.B. mit einem Vergleich wie "<" oder einer Verknüpfung mit AND/OR)', 0);
    }
    return result;
  }

  // Parst UND typprüft (aber wertet nicht aus) - für Live-Validierung sowie
  // als Vorstufe der eigentlichen Berechnung.
  // varTypes: { [alias]: 'BOOL' | 'NUM' }
  // Rückgabe: { ok:true, run(scope)->boolean } | { ok:false, message, pos }
  function compile(text, varTypes) {
    if (!text || !text.trim()) return { ok: false, message: 'Formel ist leer.', pos: 0 };
    try {
      const tokens = tokenize(text);
      const node = parse(tokens, varTypes || {});
      return { ok: true, run: node.run };
    } catch (e) {
      if (e instanceof ExprError) return { ok: false, message: e.message, pos: e.pos };
      return { ok: false, message: e.message || String(e), pos: 0 };
    }
  }

  GZ.exprEngine = { compile };
})(window.GZ = window.GZ || {});
