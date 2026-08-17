/* GZ.exprEngine — kleine Ausdruckssprache für Umlaufstatistiken. Tokenizer,
   rekursiver-Abstieg-Parser, Auswertung, Funktionskatalog. Reine Logik, kein
   DOM, keine Abhängigkeit von der Analyse-Datenstruktur - Aufrufer liefern
   einen Kontext ({index, cycle}, siehe umlaufContext.js) und einen einmal
   geparsten AST (parse() einmal je Spaltendefinition, evaluate() einmal je
   Umlauf - kein erneutes Tokenisieren pro Zeile).

   Fehlende Werte (kein Grün in diesem Umlauf, Division durch 0, offener
   IF-Zweig unbekannt) werden als JS `null` durchgereicht ("–" in der
   Tabelle, aus der Statistik ausgeschlossen) statt als Fehler behandelt.
   Nur strukturelle Probleme (Syntax, unbekannter Name, falscher Typ) werfen
   einen Error mit {pos:{start,end}, suggestion}. */
(function (GZ) {
  'use strict';

  const SCALAR_KEYWORDS = new Set(['TU', 'TU_MED', 'TX', 'SPL', 'START']);
  const ARITY = {
    AN: [1, 1], AB: [1, 1], TF: [1, 1], RG: [1, 1], GE: [1, 1],
    DET: [1, 1], DETCOUNT: [1, 1], DETFIRST: [1, 1], DETLAST: [1, 1],
    IF: [3, 3], AND: [2, Infinity], OR: [2, Infinity],
    ABS: [1, 1], MOD: [2, 2], MIN: [1, Infinity], MAX: [1, Infinity], ROUND: [1, 2]
  };
  const FUNCTION_NAMES = Object.keys(ARITY);
  const SG_NAME_FNS = new Set(['AN', 'AB', 'TF', 'RG', 'GE']);
  const DET_NAME_FNS = new Set(['DET', 'DETCOUNT', 'DETFIRST', 'DETLAST']);
  const KEYWORD_CANDIDATES = FUNCTION_NAMES.concat([...SCALAR_KEYWORDS], ['NOT', 'TRUE', 'FALSE']);

  const TWO_CHAR = { '&&': 'ANDOP', '||': 'OROP', '==': 'EQ', '!=': 'NEQ', '<=': 'LTE', '>=': 'GTE' };
  const ONE_CHAR = { '(': 'LPAREN', ')': 'RPAREN', '+': 'PLUS', '-': 'MINUS', '*': 'STAR', '/': 'SLASH', '%': 'PERCENT', ',': 'COMMA', '<': 'LT', '>': 'GT', '!': 'NOTOP' };

  function isDigit(c) { return c >= '0' && c <= '9'; }
  function isIdentStart(c) { return /[A-Za-z_]/.test(c); }
  function isIdentPart(c) { return /[A-Za-z0-9_]/.test(c); }

  function fail(message, pos, tokensSoFar, suggestion) {
    const e = new Error(message);
    e.pos = pos;
    e.tokens = tokensSoFar;
    if (suggestion) e.suggestion = suggestion;
    throw e;
  }

  // Tokenisiert den kompletten Ausdruckstext. Wirft bei ungültigem Zeichen
  // oder nicht geschlossener Zeichenkette; e.tokens enthält die bis dahin
  // erkannten Token (für suggestAt() im Bearbeitungszustand nutzbar).
  function tokenize(text) {
    const tokens = [];
    const n = text.length;
    let i = 0;
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      const start = i;
      if (isDigit(c) || (c === '.' && isDigit(text[i + 1] || ''))) {
        let j = i + 1;
        while (j < n && isDigit(text[j])) j++;
        if (text[j] === '.') { j++; while (j < n && isDigit(text[j])) j++; }
        tokens.push({ type: 'NUM', value: Number(text.slice(i, j)), start, end: j });
        i = j; continue;
      }
      if (c === '"') {
        let j = i + 1, out = '';
        while (j < n && text[j] !== '"') {
          if (text[j] === '\\' && j + 1 < n) { out += text[j + 1]; j += 2; }
          else { out += text[j]; j++; }
        }
        if (j >= n) fail('Zeichenkette nicht geschlossen (fehlendes „"“)', { start: i, end: n }, tokens);
        tokens.push({ type: 'STR', value: out, start, end: j + 1 });
        i = j + 1; continue;
      }
      if (isIdentStart(c)) {
        let j = i + 1;
        while (j < n && isIdentPart(text[j])) j++;
        tokens.push({ type: 'IDENT', value: text.slice(i, j), start, end: j });
        i = j; continue;
      }
      const two = text.slice(i, i + 2);
      if (TWO_CHAR[two]) { tokens.push({ type: TWO_CHAR[two], value: two, start, end: i + 2 }); i += 2; continue; }
      if (ONE_CHAR[c]) { tokens.push({ type: ONE_CHAR[c], value: c, start, end: i + 1 }); i++; continue; }
      fail(`Unerwartetes Zeichen „${c}“`, { start: i, end: i + 1 }, tokens);
    }
    tokens.push({ type: 'EOF', value: null, start: n, end: n });
    return tokens;
  }

  // Rekursiver-Abstieg-Parser. Bindungsstärke (lose -> fest): OR, AND, NOT,
  // Vergleich (nicht verkettend), + -, * / %, unäres -. Funktionsname und
  // Argumentzahl werden hier geprüft (rein syntaktisch, ohne Kenntnis der
  // Aufzeichnung) - unbekannte Signalgruppen-/Detektornamen erst in evaluate().
  function parse(text) {
    const tokens = tokenize(text);
    let p = 0;
    const at = type => tokens[p].type === type;
    const atKeyword = word => tokens[p].type === 'IDENT' && tokens[p].value.toUpperCase() === word;
    const advance = () => tokens[p++];
    const expect = (type, msg) => { if (!at(type)) fail(msg, { start: tokens[p].start, end: tokens[p].end }, tokens); return advance(); };

    function parseExpr() { return parseOr(); }
    function parseOr() {
      let left = parseAnd();
      while (atKeyword('OR') || at('OROP')) {
        advance();
        const right = parseAnd();
        left = { type: 'call', fn: 'OR', args: [left, right], start: left.start, end: right.end };
      }
      return left;
    }
    function parseAnd() {
      let left = parseNot();
      while (atKeyword('AND') || at('ANDOP')) {
        advance();
        const right = parseNot();
        left = { type: 'call', fn: 'AND', args: [left, right], start: left.start, end: right.end };
      }
      return left;
    }
    function parseNot() {
      if (atKeyword('NOT') || at('NOTOP')) {
        const t = advance();
        const arg = parseNot();
        return { type: 'un', op: 'NOT', arg, start: t.start, end: arg.end };
      }
      return parseCompare();
    }
    function parseCompare() {
      let left = parseAdd();
      if (at('LT') || at('LTE') || at('GT') || at('GTE') || at('EQ') || at('NEQ')) {
        const opTok = advance();
        const right = parseAdd();
        left = { type: 'bin', op: opTok.type, left, right, start: left.start, end: right.end };
      }
      return left;
    }
    function parseAdd() {
      let left = parseMul();
      while (at('PLUS') || at('MINUS')) {
        const opTok = advance();
        const right = parseMul();
        left = { type: 'bin', op: opTok.type, left, right, start: left.start, end: right.end };
      }
      return left;
    }
    function parseMul() {
      let left = parseUnary();
      while (at('STAR') || at('SLASH') || at('PERCENT')) {
        const opTok = advance();
        const right = parseUnary();
        left = { type: 'bin', op: opTok.type, left, right, start: left.start, end: right.end };
      }
      return left;
    }
    function parseUnary() {
      if (at('MINUS')) {
        const t = advance();
        const arg = parseUnary();
        return { type: 'un', op: 'NEG', arg, start: t.start, end: arg.end };
      }
      return parsePrimary();
    }
    function parsePrimary() {
      const t = tokens[p];
      if (t.type === 'NUM' || t.type === 'STR') { advance(); return { type: 'lit', value: t.value, start: t.start, end: t.end }; }
      if (t.type === 'LPAREN') {
        advance();
        const inner = parseExpr();
        expect('RPAREN', 'schließende Klammer „)“ erwartet');
        return inner;
      }
      if (t.type === 'IDENT') {
        const upper = t.value.toUpperCase();
        if (upper === 'TRUE' || upper === 'FALSE') { advance(); return { type: 'lit', value: upper === 'TRUE', start: t.start, end: t.end }; }
        advance();
        if (at('LPAREN')) {
          advance();
          const args = [];
          if (!at('RPAREN')) {
            args.push(parseExpr());
            while (at('COMMA')) { advance(); args.push(parseExpr()); }
          }
          const closeTok = expect('RPAREN', 'schließende Klammer „)“ erwartet');
          const ar = ARITY[upper];
          if (!ar) {
            const sug = GZ.exprEngine.nearestMatch(t.value, KEYWORD_CANDIDATES);
            const msg = sug ? `Unbekannte Funktion „${t.value}“ — meinten Sie „${sug}“?` : `Unbekannte Funktion „${t.value}“.`;
            fail(msg, { start: t.start, end: t.end }, tokens, sug);
          }
          if (args.length < ar[0] || args.length > ar[1]) {
            const need = ar[0] === ar[1] ? `genau ${ar[0]}` : (ar[1] === Infinity ? `mindestens ${ar[0]}` : `${ar[0]}–${ar[1]}`);
            fail(`${upper}(...) erwartet ${need} Argument(e), hat ${args.length}`, { start: t.start, end: closeTok.end }, tokens);
          }
          return { type: 'call', fn: upper, args, start: t.start, end: closeTok.end };
        }
        if (SCALAR_KEYWORDS.has(upper)) return { type: 'ref', name: upper, start: t.start, end: t.end };
        return { type: 'word', value: t.value, start: t.start, end: t.end };
      }
      fail('Ausdruck erwartet', { start: t.start, end: t.end }, tokens);
    }

    const ast = parseExpr();
    if (!at('EOF')) fail('unerwartetes Zeichen nach Ausdrucksende', { start: tokens[p].start, end: tokens[p].end }, tokens);
    return { ast, tokens };
  }

  function truthy(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    return Boolean(v);
  }
  function requireNum(v, node) {
    if (typeof v !== 'number') fail(`erwartet eine Zahl, nicht „${v}“`, { start: node.start, end: node.end });
  }
  function mod(a, b) { return b === 0 ? null : ((a % b) + b) % b; }
  function looseEquals(a, b) {
    if (typeof a === typeof b) return a === b;
    const na = Number(a), nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
    return String(a) === String(b);
  }
  function resolveNameArg(node) {
    if (node.type === 'word') return node.value;
    if (node.type === 'lit' && typeof node.value === 'string') return node.value;
    fail('erwartet einen Namen (z. B. S1), keinen Ausdruck', { start: node.start, end: node.end });
  }
  function throwUnknown(name, node, displayList, messagePrefix) {
    const sug = nearestMatch(name, displayList);
    const msg = sug ? `${messagePrefix} „${name}“ nicht gefunden — meinten Sie „${sug}“?` : `${messagePrefix} „${name}“ nicht gefunden.`;
    fail(msg, { start: node.start, end: node.end }, null, sug);
  }

  function evalNode(node, ctx) {
    switch (node.type) {
      case 'lit': return node.value;
      case 'word': throwUnknown(node.value, node, KEYWORD_CANDIDATES, 'Unbekannter Bezeichner'); return;
      case 'ref': return ctx.cycle[node.name] ?? null;
      case 'un': {
        if (node.op === 'NEG') { const v = evalNode(node.arg, ctx); if (v == null) return null; requireNum(v, node.arg); return -v; }
        const v = evalNode(node.arg, ctx);
        return v == null ? null : !truthy(v);
      }
      case 'bin': return evalBin(node, ctx);
      case 'call': return evalCall(node, ctx);
      default: return null;
    }
  }

  function evalBin(node, ctx) {
    const l = evalNode(node.left, ctx);
    const r = evalNode(node.right, ctx);
    const op = node.op;
    if (op === 'EQ') return (l == null || r == null) ? null : looseEquals(l, r);
    if (op === 'NEQ') return (l == null || r == null) ? null : !looseEquals(l, r);
    if (l == null || r == null) return null;
    if (op === 'LT' || op === 'LTE' || op === 'GT' || op === 'GTE') {
      requireNum(l, node.left); requireNum(r, node.right);
      if (op === 'LT') return l < r; if (op === 'LTE') return l <= r; if (op === 'GT') return l > r; return l >= r;
    }
    requireNum(l, node.left); requireNum(r, node.right);
    if (op === 'PLUS') return l + r;
    if (op === 'MINUS') return l - r;
    if (op === 'STAR') return l * r;
    if (op === 'SLASH') return r === 0 ? null : l / r;
    return mod(l, r); // PERCENT
  }

  function evalCall(node, ctx) {
    const fn = node.fn;
    if (fn === 'IF') {
      const c = evalNode(node.args[0], ctx);
      if (c == null) return null;
      return truthy(c) ? evalNode(node.args[1], ctx) : evalNode(node.args[2], ctx);
    }
    if (fn === 'AND' || fn === 'OR') {
      let sawNull = false;
      for (const a of node.args) {
        const v = evalNode(a, ctx);
        if (v == null) { sawNull = true; continue; }
        const b = truthy(v);
        if (fn === 'AND' && b === false) return false;
        if (fn === 'OR' && b === true) return true;
      }
      return sawNull ? null : (fn === 'AND');
    }
    if (SG_NAME_FNS.has(fn)) {
      const name = resolveNameArg(node.args[0]);
      const lname = name.toLowerCase();
      if (!ctx.index.sg.has(lname)) throwUnknown(name, node.args[0], ctx.index.sgList, 'Signalgruppe');
      const entry = ctx.cycle.sg.get(lname);
      const key = { AN: 'an', AB: 'ab', TF: 'tf', RG: 'rotgelb', GE: 'gelb' }[fn];
      return entry ? entry[key] : null;
    }
    if (DET_NAME_FNS.has(fn)) {
      const name = resolveNameArg(node.args[0]);
      const lname = name.toLowerCase();
      if (!ctx.index.det.has(lname)) throwUnknown(name, node.args[0], ctx.index.detList, 'Detektor/Wert');
      const entry = ctx.cycle.det.get(lname);
      if (fn === 'DET') return entry ? entry.triggered : false;
      if (fn === 'DETCOUNT') return entry ? entry.count : 0;
      if (fn === 'DETFIRST') return entry ? entry.first : null;
      return entry ? entry.last : null; // DETLAST
    }
    const vals = node.args.map(a => evalNode(a, ctx));
    if (fn === 'ABS') { if (vals[0] == null) return null; requireNum(vals[0], node.args[0]); return Math.abs(vals[0]); }
    if (fn === 'MOD') { if (vals[0] == null || vals[1] == null) return null; requireNum(vals[0], node.args[0]); requireNum(vals[1], node.args[1]); return mod(vals[0], vals[1]); }
    if (fn === 'MIN' || fn === 'MAX') {
      if (vals.some(v => v == null)) return null;
      vals.forEach((v, i) => requireNum(v, node.args[i]));
      return fn === 'MIN' ? Math.min(...vals) : Math.max(...vals);
    }
    if (fn === 'ROUND') {
      if (vals[0] == null) return null;
      requireNum(vals[0], node.args[0]);
      const d = vals[1] == null ? 0 : vals[1];
      const f = Math.pow(10, d);
      return Math.round(vals[0] * f) / f;
    }
    return null;
  }

  function evaluate(ast, ctx) { return evalNode(ast, ctx); }

  // Klassische Editierdistanz - Grundlage für "meinten Sie …?" sowohl bei
  // Auswertungsfehlern als auch (indirekt) für die Sortierung in suggestAt().
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
      }
      prev = cur;
    }
    return prev[n];
  }

  // Nächstliegender Kandidat per Editierdistanz, nur wenn "nah genug" -
  // lieber keine Vermutung als eine irreführende.
  function nearestMatch(name, candidates) {
    if (!candidates || candidates.length === 0) return null;
    const lname = String(name).toLowerCase();
    let best = null, bestD = Infinity;
    for (const c of candidates) {
      const d = levenshtein(lname, String(c).toLowerCase());
      if (d < bestD) { bestD = d; best = c; }
    }
    const threshold = Math.max(2, Math.ceil(lname.length * 0.4));
    return bestD <= threshold ? best : null;
  }

  // Kontextsensitive Vorschläge für die Eingabeposition cursorPos in text:
  // innerhalb An(/Ab(/Tf(/Rg(/Ge( -> Signalgruppennamen, innerhalb Det(/
  // DetCount(/DetFirst(/DetLast( -> Detektor-/APW-Namen, sonst Funktionen +
  // skalare Bezeichner (TU, TU_MED, TX, SPL, START). index wie in evaluate().
  function suggestAt(text, cursorPos, index) {
    let tokens;
    try { tokens = tokenize(text); }
    catch (e) { tokens = (e.tokens || []).concat([{ type: 'EOF', start: text.length, end: text.length }]); }

    let replaceStart = cursorPos, replaceEnd = cursorPos, partial = '';
    const cur = tokens.find(t => t.type === 'IDENT' && t.start <= cursorPos && cursorPos <= t.end);
    if (cur) { replaceStart = cur.start; replaceEnd = cur.end; partial = text.slice(cur.start, cursorPos); }

    const stack = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.start >= replaceStart) break;
      if (t.type === 'LPAREN') {
        const prevTok = tokens[i - 1];
        stack.push(prevTok && prevTok.type === 'IDENT' && prevTok.end === t.start ? prevTok.value.toUpperCase() : null);
      } else if (t.type === 'RPAREN') {
        stack.pop();
      }
    }
    const owner = stack.length ? stack[stack.length - 1] : null;

    let candidates;
    if (owner && SG_NAME_FNS.has(owner)) candidates = index.sgList.map(n => ({ value: n, label: n, kind: 'sg' }));
    else if (owner && DET_NAME_FNS.has(owner)) candidates = index.detList.map(n => ({ value: n, label: n, kind: 'det' }));
    else candidates = FUNCTION_NAMES.map(n => ({ value: n, label: n + '(…)', kind: 'fn' }))
      .concat([...SCALAR_KEYWORDS].map(n => ({ value: n, label: n, kind: 'scalar' })));

    const p = partial.toLowerCase();
    const items = candidates.filter(c => c.value.toLowerCase().startsWith(p)).slice(0, 8);
    return { replaceStart, replaceEnd, items };
  }

  // Spaltentyp aus den tatsächlich ausgewerteten Werten ableiten (statt
  // manueller Formatwahl) - 'number'/'bool' bekommen Aggregatstatistik,
  // 'text' nur die Tabellenanzeige, 'empty' wenn nichts auswertbar war.
  function inferKind(values) {
    const present = values.filter(v => v !== null && v !== undefined);
    if (present.length === 0) return 'empty';
    if (present.every(v => typeof v === 'boolean')) return 'bool';
    if (present.every(v => typeof v === 'number')) return 'number';
    return 'text';
  }

  GZ.exprEngine = {
    FUNCTION_NAMES, SCALAR_KEYWORDS, ARITY,
    tokenize, parse, evaluate, suggestAt, nearestMatch, levenshtein, inferKind
  };
})(window.GZ = window.GZ || {});
