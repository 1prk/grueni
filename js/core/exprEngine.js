/* GZ.exprEngine is a small formula interpreter without dependencies.
   It serves the formula builder of the cycle check (Umlaufprüfung): synthetic detectors from
   variable expressions.
   It also serves Umlaufstatistiken (key figure columns that the code calculates cycle by cycle,
   see js/views/umlaufstatistiken.js).
   It is pure calculation logic. It has no link to the DOM.

   The cycle-wise primitives (An, Ab, TF, RG, GE, Ausgeloest, AnzahlAusloesungen, see PRIMITIVES
   below)
   read from handle.cycleMetrics and not from handle.sweep.
   handle.cycleMetrics is a flat object that the caller maintains.
   It has the key figures of the "current" cycle (GZ.segments.computeCycleSgMetrics and
   computeCycleDetMetrics).
   compileValue() is like compile(), but without the BOOL rule.
   It is the entry point for Umlaufstatistiken, where the expression itself is the wanted value
   and not a filter condition.

   Grammar (precedence from low to high):
     or   := and (OR and)*
     and  := not (AND not)*
     not  := NOT not | cmp
     cmp  := add ((> | >= | < | <= | == | !=) add)?     -- cannot be chained
     add  := mul ((+|-) mul)*
     mul  := unary ((*|/) unary)*
     unary:= '-' unary | atom
     atom := NUMBER | KATLIT | IDENT | IDENT '(' (or (',' or)*)? ')' | '(' or ')'

   Types: NUM, BOOL, SG, DET (object handles to a signal group or detector variable),
   KAT_SG, KAT_DET (state constants, for example GRUEN or BELEGT),
   ANY (a placeholder for a function parameter that is not bound yet, see compileFunctionDef()).
   ANY satisfies each type check.
   So the code can check the syntax of a function definition BEFORE its first use, without the
   concrete argument types.
   Operators enforce the expected type of their operands:
   AND, OR and NOT accept only BOOL. Arithmetic accepts only NUM.
   A comparison accepts NUM==NUM OR KAT==KAT of the same kind.
   The parser finds type errors at parse time. It does not need to evaluate data.
   The whole expression of a formula (see compile()) must evaluate to BOOL.
   The body of a user-defined function (see compileFunctionDef()) can return any type.
   Only the real call in a formula decides if it fits.

   User-defined functions (the funcs parameter of compile() and parse(), form { [name]:
   {params:string[], exprText:string} }):
   the code expands a call FUNC(a,b,...) "inline".
   It parses and type-checks the body text again with a new varTypes binding
   (parameter name -> real argument type of THIS call, see parseCall()).
   So the same function body can be specialized many times with different concrete types.
   This works like C++ templates or Java generics at instantiation. The code does not compile the
   body once.
   A visiting set (function names in the current expansion stack) prevents cyclic calls (A calls
   B calls A).
   The result is a clear error and not a stack overflow.

   Built-in functions (PRIMITIVES below) turn an object handle into a value that the code can
   evaluate:
   Zustand(sg|det) -> KAT_*,
   Dauer(sg|det) -> NUM (seconds in the current state),
   DauerSeit(sg|det, category) -> NUM (seconds since the last entry into "category", 0 if the
   object is not in this state now).
   The code does NOT pass the current evaluation time as an argument.
   It runs internally and implicitly through the object handle (see scope below, handle.sweep).
   TX is still available as a normal NUM variable in the scope
   (for example for own conditions such as "TX > 60" in a function).
   But it never needs to go to a primitive. So it is nowhere a required argument.

   The scope object for run(scope): alias -> value.
   NUM variables (APW, ÖPNV) are numbers.
   A missing raw value gives NaN. In JS each comparison with NaN is automatically false.
   A division by 0 gives Infinity or NaN. This needs no special case.
   The behavior is "missing or undefined value -> the condition is not met", on purpose.
   SG and DET variables are a handle { class:'SG'|'DET', sweep }.
   sweep is a GZ.segments.makePointSegmentSweep() object.
   The caller advances advance(t) once for each row BEFORE each run() call (formulaBuilder.js
   berechnen()).
   The primitives read only sweep.segment() and sweep.time(). */
GZ.define('exprEngine', { layer: 'domain', deps: [] }, function (GZ) {
  'use strict';

  // incomplete: the expression is not WRONG, it is (not yet) NOT FINISHED.
  // Examples: "DauerSeit(K1, GRUEN) > " in the middle of typing,
  // or an expression that is valid but not yet completed to TRUE or FALSE.
  // Callers can show this neutral and not as a red error (see validateFormulaRow() in
  // formulaBuilder.js).
  // Otherwise an error message flashes all the time during normal typing, and it is not a real
  // error.
  class ExprError extends Error {
    constructor(message, pos, incomplete) { super(message); this.pos = pos; this.incomplete = !!incomplete; }
  }

  const CMP_OPS = { '>': (a, b) => a > b, '<': (a, b) => a < b, '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '==': (a, b) => a === b, '!=': (a, b) => a !== b };
  const TYPE_LABEL = t => ({
    BOOL: 'WAHR/FALSCH', NUM: 'eine Zahl', TEXT: 'einen Text',
    SG: 'eine Signalgruppe', DET: 'einen Detektor',
    KAT_SG: 'einen Signalgruppen-Zustand', KAT_DET: 'einen Detektor-Zustand',
    ANY: 'einen (noch unbestimmten) Parameterwert'
  })[t] || t;
  const isNumCompatible = t => t === 'NUM' || t === 'ANY';
  const isTextCompatible = t => t === 'TEXT' || t === 'ANY';
  // KAT_* is open for any number of concrete state categories
  // (now KAT_SG and KAT_DET from KAT_TOKENS below,
  // plus what a caller registers with extraKatTokens, for example KAT_QSV in oepnvQa.js).
  // The code finds them by the name scheme. It does not keep a fixed list.
  const isKatType = t => typeof t === 'string' && t.indexOf('KAT_') === 0;
  const isKatCompatible = t => isKatType(t) || t === 'ANY';
  const isObjCompatible = t => t === 'SG' || t === 'DET' || t === 'ANY';
  // Two types "match" if they are exactly equal or if (at least) one of them is still ANY
  // (an unspecialized function parameter OR the LEER literal, see parseAtom(). Both adapt to each
  // concrete type).
  // It is the basis of WENN() below: "then" and "else" must give the same result type.
  // Otherwise the type of the whole expression would not be unique.
  const typesMatch = (a, b) => a === b || a === 'ANY' || b === 'ANY';

  // State constants (exact spelling, see GZ.parser STATE_CAT and categorizeDetRaw).
  // UNBEKANNT, INV and LUECKE are NOT exposed as writable literals on purpose.
  // They are data quality artifacts and not "real" signal states.
  const KAT_TOKENS = {
    GRUEN: 'KAT_SG', ROT: 'KAT_SG', GELB: 'KAT_SG', ROTGELB: 'KAT_SG', DUNKEL: 'KAT_SG',
    BELEGT: 'KAT_DET', FREI: 'KAT_DET'
  };

  const katTypeForObj = t => t === 'SG' ? 'KAT_SG' : t === 'DET' ? 'KAT_DET' : 'ANY';

  // Built-in functions: object handle (plus optional category or TX) -> value.
  // check(argNodes, pos) throws ExprError for type errors and returns the result type.
  // run(argNodes) builds the run(scope) closure.
  // It accepts ANY (a function parameter that is not yet specialized) everywhere that otherwise
  // requires SG, DET, NUM or KAT_*.
  // See the file header comment about ANY.
  const PRIMITIVES = {
    Zustand: {
      arity: 1,
      check(args, pos) {
        const [obj] = args;
        if (!isObjCompatible(obj.type)) throw new ExprError('"Zustand" erwartet als Argument eine Signalgruppe oder einen Detektor', pos);
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
      arity: 1,
      check(args, pos) {
        const [obj] = args;
        if (!isObjCompatible(obj.type)) throw new ExprError('"Dauer" erwartet als Argument eine Signalgruppe oder einen Detektor', pos);
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
      arity: 2,
      check(args, pos) {
        const [obj, kat] = args;
        if (!isObjCompatible(obj.type)) throw new ExprError('"DauerSeit" erwartet als 1. Argument eine Signalgruppe oder einen Detektor', pos);
        if (obj.type === 'SG' || obj.type === 'DET') {
          const expectedKat = katTypeForObj(obj.type);
          if (kat.type !== expectedKat && kat.type !== 'ANY') {
            throw new ExprError(`"DauerSeit" (2. Argument) erwartet ${TYPE_LABEL(expectedKat)} passend zum 1. Argument, bekam ${TYPE_LABEL(kat.type)}`, pos);
          }
        } else if (!isKatCompatible(kat.type)) {
          throw new ExprError('"DauerSeit" (2. Argument) erwartet einen Zustand', pos);
        }
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
    },

    // ---- Cycle-wise primitives (An, Ab, TF, RG, GE, Ausgeloest, AnzahlAusloesungen) ----
    // They do NOT read from handle.sweep (the state at the current time).
    // They read from handle.cycleMetrics. This is a flat object that the caller maintains.
    // It has the key figures of the "current" cycle (see GZ.segments.computeCycleSgMetrics and
    // computeCycleDetMetrics).
    // For the cycle-wise evaluation (Umlaufstatistiken) the caller sets cycleMetrics once for each
    // cycle.
    // For the row-wise evaluation (formula builder, umlaufpruefung.js) the caller keeps
    // cycleMetrics current
    // when the row crosses a cycle border. Otherwise it does not change for each row.
    // If a value is missing (no green in this cycle, or no cycleMetrics set),
    // the NUM primitives return NaN. This is consistent with the NUM/NaN contract of this file (see
    // the header comment).
    // It is not a special case.
    // An, Ab, TF, RG and GE are UNIVERSAL:
    // a signal group AND a detector, APW or ÖPNV value each have exactly ONE "active" state, and
    // the start and end of it matter for each cycle.
    // It is GRUEN for a signal group and BELEGT for a detector or value (see
    // GZ.parser.categorizeSgRaw and categorizeDetRaw).
    // "An" simply means "when this active state starts" (the An of a signal group, the start of
    // occupancy for a detector).
    // "Ab" means the end of it.
    // RG and GE (red-amber and amber directly before and after the green) give a value other than 0
    // only for signal groups.
    // A detector or value does not have these intermediate categories.
    // adjacentTransitionDurations() simply never matches there. No special case is needed.
    An: {
      arity: 1,
      check(args, pos) {
        if (!isObjCompatible(args[0].type)) throw new ExprError('"An" erwartet als Argument eine Signalgruppe oder einen Detektor/Wert', pos);
        return 'NUM';
      },
      run(args) { const [objNode] = args; return scope => { const cm = objNode.run(scope).cycleMetrics; return cm ? cm.an : NaN; }; }
    },
    Ab: {
      arity: 1,
      check(args, pos) {
        if (!isObjCompatible(args[0].type)) throw new ExprError('"Ab" erwartet als Argument eine Signalgruppe oder einen Detektor/Wert', pos);
        return 'NUM';
      },
      run(args) { const [objNode] = args; return scope => { const cm = objNode.run(scope).cycleMetrics; return cm ? cm.ab : NaN; }; }
    },
    TF: {
      arity: 1,
      check(args, pos) {
        if (!isObjCompatible(args[0].type)) throw new ExprError('"TF" erwartet als Argument eine Signalgruppe oder einen Detektor/Wert', pos);
        return 'NUM';
      },
      run(args) { const [objNode] = args; return scope => { const cm = objNode.run(scope).cycleMetrics; return cm ? cm.tf : NaN; }; },
      span(args) {
        const [objNode] = args;
        return scope => {
          const cm = objNode.run(scope).cycleMetrics;
          return (cm && Number.isFinite(cm.an) && Number.isFinite(cm.ab)) ? { startSec: cm.an, endSec: cm.ab } : null;
        };
      }
    },
    RG: {
      arity: 1,
      check(args, pos) {
        if (!isObjCompatible(args[0].type)) throw new ExprError('"RG" erwartet als Argument eine Signalgruppe oder einen Detektor/Wert', pos);
        return 'NUM';
      },
      run(args) { const [objNode] = args; return scope => { const cm = objNode.run(scope).cycleMetrics; return cm ? cm.rotgelb : NaN; }; },
      span(args) {
        const [objNode] = args;
        return scope => {
          const cm = objNode.run(scope).cycleMetrics;
          return (cm && Number.isFinite(cm.an) && Number.isFinite(cm.rotgelb)) ? { startSec: cm.an - cm.rotgelb, endSec: cm.an } : null;
        };
      }
    },
    GE: {
      arity: 1,
      check(args, pos) {
        if (!isObjCompatible(args[0].type)) throw new ExprError('"GE" erwartet als Argument eine Signalgruppe oder einen Detektor/Wert', pos);
        return 'NUM';
      },
      run(args) { const [objNode] = args; return scope => { const cm = objNode.run(scope).cycleMetrics; return cm ? cm.gelb : NaN; }; },
      span(args) {
        const [objNode] = args;
        return scope => {
          const cm = objNode.run(scope).cycleMetrics;
          return (cm && Number.isFinite(cm.ab) && Number.isFinite(cm.gelb)) ? { startSec: cm.ab, endSec: cm.ab + cm.gelb } : null;
        };
      }
    },
    Ausgeloest: {
      arity: 1,
      check(args, pos) {
        if (args[0].type !== 'DET' && args[0].type !== 'ANY') throw new ExprError('"Ausgeloest" erwartet als Argument einen Detektor', pos);
        return 'BOOL';
      },
      run(args) { const [objNode] = args; return scope => { const cm = objNode.run(scope).cycleMetrics; return cm ? cm.triggered : false; }; }
    },
    AnzahlAusloesungen: {
      arity: 1,
      check(args, pos) {
        if (args[0].type !== 'DET' && args[0].type !== 'ANY') throw new ExprError('"AnzahlAusloesungen" erwartet als Argument einen Detektor', pos);
        return 'NUM';
      },
      run(args) { const [objNode] = args; return scope => { const cm = objNode.run(scope).cycleMetrics; return cm ? cm.count : 0; }; }
    },
    MOD: {
      arity: 2,
      check(args, pos) {
        const [a, b] = args;
        if (!isNumCompatible(a.type) || !isNumCompatible(b.type)) throw new ExprError('"MOD" erwartet zwei Zahlen', pos);
        return 'NUM';
      },
      run(args) {
        const [aNode, bNode] = args;
        return scope => { const x = aNode.run(scope), y = bNode.run(scope); return ((x % y) + y) % y; };
      }
    },

    // WENN: condition -> value (like WENN() in Excel or a ternary "? :").
    // It allows ONE column whose value depends on a condition, instead of several columns with
    // formulas that exclude each other.
    // Example: WENN(TF(Det1) >= 5, An(Det1), LEER) means
    // "the An of Det1, but only for cycles or events with at least 5 s of occupancy, else LEER
    // (NaN)".
    // It is especially useful together with LEER.
    // The aggregate statistics of Umlaufstatistiken already filter NaN cells out of mean, median
    // and so on
    // (see numericValues() in umlaufstatistiken.js).
    // So a WENN/LEER column gives directly "the average ONLY over the cycles that meet the
    // condition".
    // "then" and "else" must give the same result type (see typesMatch() above).
    // Otherwise the type of the whole expression is not unique.
    // LEER (type ANY) adapts to each of the two.
    WENN: {
      arity: 3,
      check(args, pos) {
        const [cond, dann, sonst] = args;
        if (cond.type !== 'BOOL' && cond.type !== 'ANY') throw new ExprError('"WENN" erwartet als 1. Argument eine Bedingung (WAHR/FALSCH)', pos);
        if (!typesMatch(dann.type, sonst.type)) {
          throw new ExprError(`"WENN" erwartet für "dann" und "sonst" denselben Ergebnistyp, bekam ${TYPE_LABEL(dann.type)} und ${TYPE_LABEL(sonst.type)}`, pos);
        }
        return dann.type !== 'ANY' ? dann.type : sonst.type;
      },
      run(args) {
        const [condNode, dannNode, sonstNode] = args;
        return scope => (condNode.run(scope) ? dannNode.run(scope) : sonstNode.run(scope));
      }
    },

    // ISTLEER: WAHR if a value is LEER (see there).
    // It tells apart "there was no event here at all" from "there was an event that did not meet a
    // condition".
    // Otherwise both look the same as NaN.
    // It is typically nested with WENN, for example
    // WENN(ISTLEER(An(Det1)), 0, WENN(TF(Det1) >= 5, An(Det1), LEER)):
    // "0 if Det1 did not trigger at all in this cycle (An(Det1) then has no value itself).
    // Otherwise the An, but only with at least 5 s of occupancy, else LEER".
    // The outer WENN keeps cycles WITHOUT an event visible (as 0).
    // The inner WENN hides cycles WITH an event that does not meet the condition.
    // Without both, the code would treat both cases the same as 0 or LEER.
    // It accepts EACH type (also text, state and WAHR/FALSCH).
    // Technically LEER always returns the raw JS value NaN, independent of the "type" that it
    // adapted with typesMatch().
    ISTLEER: {
      arity: 1,
      check() { return 'BOOL'; },
      run(args) {
        const [valNode] = args;
        return scope => { const v = valNode.run(scope); return typeof v === 'number' && Number.isNaN(v); };
      }
    },

    // WertBei: the raw value of a signal group OR of a detector, APW or ÖPNV value
    // at any time inside the current cycle [s from the cycle start].
    // The time is typically one of the cycle-wise primitives above, for example WertBei(APW_01,
    // Ab(K1)):
    // "which countdown APW_01 showed at the moment of the Ab of K1",
    // or WertBei(K2, Ab(K1)): "which signal image (raw value) K2 showed at exactly this moment".
    // Zustand() works at the current time and categorizes (GRUEN, ROT, ..., BELEGT, FREI).
    // Ausgeloest and AnzahlAusloesungen only want to know IF or HOW OFTEN the object was occupied.
    // WertBei is different. It reads the real, uncategorized raw value at ANY time.
    // See handle.rawSample (GZ.segments.makeRawValueSampler)
    // and scope.__cycleStart (the cycle start in ms, set by the caller,
    // see GZ.umlaufContext and berechnen() in formulaBuilder.js).
    WertBei: {
      arity: 2,
      check(args, pos) {
        if (!isObjCompatible(args[0].type)) throw new ExprError('"WertBei" erwartet als 1. Argument eine Signalgruppe oder einen Detektor/Wert (z. B. einen APW-Countdown)', pos);
        if (!isNumCompatible(args[1].type)) throw new ExprError('"WertBei" erwartet als 2. Argument einen Zeitpunkt in Sekunden ab Umlaufbeginn (z. B. Ab(sg))', pos);
        return 'NUM';
      },
      run(args) {
        const [objNode, tNode] = args;
        return scope => {
          const handle = objNode.run(scope);
          const t = tNode.run(scope);
          if (!handle || !handle.rawSample || !Number.isFinite(t) || !Number.isFinite(scope.__cycleStart)) return NaN;
          return handle.rawSample(scope.__cycleStart + t * 1000);
        };
      }
    },

    // DauerBei: for how long (in seconds) a signal group OR a detector, APW or ÖPNV value
    // was already in the same (current) state WITHOUT interruption, at any time.
    // It is a generic version of Dauer() with an explicit time.
    // Dauer() knows only the CURRENT time. So Umlaufstatistiken cannot use it (see perRowOnly
    // below).
    // Example: "for how long was Det1 already occupied without interruption at the moment of the Ab
    // of K1".
    // WertBei(det, Ab(sg)) gives only the raw value at this point. DauerBei gives "since when does
    // this state apply".
    // It also works for signal groups (for example "for how long was K2 already green at time X").
    // It is GENERIC on purpose.
    // It does not ask for a specific category (GRUEN, BELEGT, ...).
    // It asks for the duration of the state that applies at this time.
    // See handle.durationAt (GZ.segments.makeSegmentDurationSampler)
    // and scope.__cycleStart (as for WertBei).
    DauerBei: {
      arity: 2,
      check(args, pos) {
        if (!isObjCompatible(args[0].type)) throw new ExprError('"DauerBei" erwartet als 1. Argument eine Signalgruppe oder einen Detektor/Wert', pos);
        if (!isNumCompatible(args[1].type)) throw new ExprError('"DauerBei" erwartet als 2. Argument einen Zeitpunkt in Sekunden ab Umlaufbeginn (z. B. Ab(sg))', pos);
        return 'NUM';
      },
      run(args) {
        const [objNode, tNode] = args;
        return scope => {
          const handle = objNode.run(scope);
          const t = tNode.run(scope);
          if (!handle || !handle.durationAt || !Number.isFinite(t) || !Number.isFinite(scope.__cycleStart)) return NaN;
          return handle.durationAt(scope.__cycleStart + t * 1000);
        };
      }
    },

    // Versatz and Ueberschneidung: the real reason for An, Ab and TU_MED above.
    // "Time from the Ab of sg1 to the An of sg2" is the most frequent case.
    // So it deserves its own primitive that explains itself.
    // Then nobody must write MOD(An(sg2) - Ab(sg1), TU_MED) by hand each time.
    // It wraps internally in exactly this way (including the cycle border). See An and Ab above.
    // As An and Ab it is UNIVERSAL: "Ab" and "An" also apply to detector, APW and ÖPNV values (end
    // and start of occupancy).
    Versatz: {
      arity: 2,
      check(args, pos) {
        if (!isObjCompatible(args[0].type)) throw new ExprError('"Versatz" erwartet als 1. Argument eine Signalgruppe oder einen Detektor/Wert (die Abwurf-Seite)', pos);
        if (!isObjCompatible(args[1].type)) throw new ExprError('"Versatz" erwartet als 2. Argument eine Signalgruppe oder einen Detektor/Wert (die Anwurf-Seite)', pos);
        return 'NUM';
      },
      run(args) {
        const [fromNode, toNode] = args;
        return scope => {
          const cmFrom = fromNode.run(scope).cycleMetrics, cmTo = toNode.run(scope).cycleMetrics;
          if (!cmFrom || !cmTo) return NaN;
          const tuMed = scope.TU_MED;
          return ((cmTo.an - cmFrom.ab) % tuMed + tuMed) % tuMed;
        };
      },
      // Object-related span for the display as a bar (see the key figure track in
      // umlaufpruefung.js).
      // It is NOT normalized by modulo like run() above.
      // If the offset extends past the end of the cycle (cmTo.an < cmFrom.ab, see Ueberschneidung),
      // the result is a span that runs backward (endSec < startSec).
      // The caller detects this and falls back to the full row width.
      // It does not draw something geometrically wrong.
      span(args) {
        const [fromNode, toNode] = args;
        return scope => {
          const cmFrom = fromNode.run(scope).cycleMetrics, cmTo = toNode.run(scope).cycleMetrics;
          return (cmFrom && cmTo && Number.isFinite(cmFrom.ab) && Number.isFinite(cmTo.an)) ? { startSec: cmFrom.ab, endSec: cmTo.an } : null;
        };
      }
    },
    Ueberschneidung: {
      arity: 2,
      check(args, pos) {
        if (!isObjCompatible(args[0].type)) throw new ExprError('"Ueberschneidung" erwartet als 1. Argument eine Signalgruppe oder einen Detektor/Wert (die Abwurf-Seite)', pos);
        if (!isObjCompatible(args[1].type)) throw new ExprError('"Ueberschneidung" erwartet als 2. Argument eine Signalgruppe oder einen Detektor/Wert (die Anwurf-Seite)', pos);
        return 'BOOL';
      },
      run(args) {
        const [fromNode, toNode] = args;
        return scope => {
          const cmFrom = fromNode.run(scope).cycleMetrics, cmTo = toNode.run(scope).cycleMetrics;
          if (!cmFrom || !cmTo) return false;
          return cmTo.an < cmFrom.ab;
        };
      },
      span(args) {
        const [fromNode, toNode] = args;
        return scope => {
          const cmFrom = fromNode.run(scope).cycleMetrics, cmTo = toNode.run(scope).cycleMetrics;
          return (cmFrom && cmTo && Number.isFinite(cmFrom.ab) && Number.isFinite(cmTo.an)) ? { startSec: cmTo.an, endSec: cmFrom.ab } : null;
        };
      }
    }
  };

  // Display metadata for primitives
  // (autocomplete and function palette in formulaBuilder.js AND umlaufstatistiken.js, and the
  // tooltip and legend text there).
  // It is separate from PRIMITIVES.check and run above, because it is purely descriptive (no
  // evaluation logic).
  // desc is the only documentation that users see for each primitive
  // (autocomplete, ƒ palette, Umlaufstatistiken legend).
  // So it is detailed: what exactly the primitive returns, for which object types,
  // and how special cases behave (no event, no red-amber or amber neighbor, ...).
  //
  // objArgType (optional): the object type that the argument or arguments of this primitive expect.
  //   'SG' or 'DET' if ONLY one of the two types is valid
  //   (for example Ausgeloest and AnzahlAusloesungen: only detector or value. "How often was this
  //   signal group on" is not defined).
  //   'OBJ' if BOTH are valid
  //   (An, Ab, TF, RG, GE, Versatz, Ueberschneidung, WertBei and DauerBei are UNIVERSAL:
  //   a signal group AND a detector, APW or ÖPNV value each have exactly one "active" state with a
  //   start and an end.
  //   See the An/Ab header comment in PRIMITIVES above).
  //   It is missing for Zustand, Dauer and DauerSeit
  //   (they also accept SG OR DET, but they are perRowOnly anyway and cannot be called in
  //   Umlaufstatistiken at all)
  //   and for purely numeric primitives such as MOD.
  //   umlaufstatistiken.js uses it to suggest, inside a function call (for example "An("),
  //   only signal group names or only detector and APW names (or both for 'OBJ'), and not all known
  //   identifiers.
  //   It is the ONLY place that maintains this (there are no separate SG_ARG_FNS and DET_ARG_FNS
  //   lists there any more).
  //
  // perRowOnly (optional): true if the primitive reads from handle.sweep (the state at the CURRENT
  // time)
  //   and not from handle.cycleMetrics, handle.rawSample or handle.durationAt.
  //   So it works only row by row (formula builder) and not in Umlaufstatistiken (see
  //   findPerRowOnlyUsage() there).
  //   DauerBei is the version of Dauer with an explicit time. So it also works in
  //   Umlaufstatistiken.
  const PRIMITIVE_INFO = [
    { name: 'Zustand', params: ['objekt'], desc: 'Aktueller Zustand von objekt (Signalgruppe: GRUEN/ROT/GELB/ROTGELB/DUNKEL; Detektor/APW-/ÖPNV-Wert: BELEGT/FREI). Nur zeilenweise (Formel-Builder) - "aktuell" braucht einen konkreten Zeitpunkt.', perRowOnly: true },
    { name: 'Dauer', params: ['objekt'], desc: 'Sekunden, die objekt bereits ununterbrochen im aktuellen Zustand ist. Nur zeilenweise - siehe DauerBei für die Variante mit explizitem Zeitpunkt (auch in Umlaufstatistiken nutzbar).', perRowOnly: true },
    { name: 'DauerSeit', params: ['objekt', 'zustand'], desc: 'Sekunden seit dem letzten Eintritt von objekt in "zustand" (0, wenn objekt aktuell NICHT in diesem Zustand ist). Nur zeilenweise.', perRowOnly: true },
    { name: 'An', params: ['objekt'], desc: 'Beginn des aktiven Zustands von objekt in diesem Umlauf, als Sekunden-Offset ab Umlaufbeginn [s] - bei einer Signalgruppe der Anwurf (Beginn Grün), bei einem Detektor/APW-/ÖPNV-Wert der Belegungsbeginn. NaN, wenn objekt in diesem Umlauf keinen solchen Beginn hat (z.B. eine Signalgruppe ohne Grün, oder ein Detektor, der schon in einem früheren Umlauf belegt wurde und erst hier wieder frei wird).', objArgType: 'OBJ' },
    { name: 'Ab', params: ['objekt'], desc: 'Ende des aktiven Zustands von objekt in diesem Umlauf [s ab Umlaufbeginn] - Abwurf (Grün-Ende) bei einer Signalgruppe, Belegungsende bei einem Detektor/Wert. NaN, wenn objekt in DIESEM Umlauf nicht endet (z.B. weil es erst im nächsten endet - siehe An).', objArgType: 'OBJ' },
    { name: 'TF', params: ['objekt'], desc: 'Freigabezeit: Gesamtdauer des aktiven Zustands [s] (Grünzeit bei einer Signalgruppe, Belegungsdauer bei einem Detektor/Wert) - nur bekannt, sobald der Zustand in DIESEM Umlauf auch endet (sonst NaN, siehe Ab).', objArgType: 'OBJ' },
    { name: 'RG', params: ['objekt'], desc: 'Rotgelb-Dauer unmittelbar VOR diesem Anwurf [s] (0, falls keine) - nur für Signalgruppen sinnvoll ungleich 0; ein Detektor/Wert kennt keine Rotgelb-Kategorie und liefert daher immer 0.', objArgType: 'OBJ' },
    { name: 'GE', params: ['objekt'], desc: 'Gelb-Dauer unmittelbar NACH diesem Abwurf [s] (0, falls keine) - wie RG nur für Signalgruppen ungleich 0.', objArgType: 'OBJ' },
    { name: 'Ausgeloest', params: ['det'], desc: 'Wahr, wenn der Detektor/Wert in diesem Umlauf mindestens einmal belegt/ausgelöst war (Umlauf-weites Aggregat, unabhängig davon, wie oft).', objArgType: 'DET' },
    { name: 'AnzahlAusloesungen', params: ['det'], desc: 'Anzahl steigender Flanken (frei->belegt) des Detektors/Werts in diesem Umlauf (Umlauf-weites Aggregat).', objArgType: 'DET' },
    { name: 'WertBei', params: ['objekt', 'zeitpunktSek'], desc: 'Roher, unkategorisierter Messwert von objekt zum angegebenen Zeitpunkt [s ab Umlaufbeginn] - bei einer Signalgruppe der Signalbild-Rohcode, bei einem Detektor/APW-/ÖPNV-Wert der geloggte Rohwert (z.B. ein Countdown). zeitpunktSek ist typischerweise selbst wieder ein An/Ab-Aufruf, z.B. WertBei(APW_01, Ab(K1)): "welchen Countdown zeigte APW_01 im Moment des Abwurfs von K1".', objArgType: 'OBJ' },
    { name: 'DauerBei', params: ['objekt', 'zeitpunktSek'], desc: 'Wie lange (in Sekunden) war objekt zum angegebenen Zeitpunkt [s ab Umlaufbeginn] bereits ununterbrochen im dann jeweils AKTUELLEN Zustand - die um einen expliziten Zeitpunkt erweiterte Fassung von Dauer(), dadurch auch in Umlaufstatistiken nutzbar. Beispiel: DauerBei(Det1, Ab(K1)) = wie lange Det1 im Moment des Abwurfs von K1 schon in seinem dortigen Zustand war (meist: schon belegt). Achtung: liefert die Dauer des Zustands, der GENAU zu diesem Zeitpunkt gilt - ist objekt zu diesem Zeitpunkt bereits wieder frei, liefert es die Dauer der Freiphase, nicht der vorherigen Belegung.', objArgType: 'OBJ' },
    { name: 'MOD', params: ['zahl', 'divisor'], desc: 'Modulo (Rest der Division), stets ≥ 0 - anders als JS-"%" nie negativ. Nur für Werte sinnvoll, die als zyklisch/umlaufend verstanden werden sollen; für eine reine Differenz zwischen zwei An/Ab-Werten DERSELBEN Zeile lieber ohne MOD rechnen (siehe Versatz-Hinweis unten).', objArgType: null },
    { name: 'WENN', params: ['bedingung', 'dann', 'sonst'], desc: 'Bedingter Wert (wie Excel-WENN bzw. "? :"): liefert "dann", wenn "bedingung" wahr ist, sonst "sonst" - beide müssen denselben Ergebnistyp haben (Zahl, Text, Zustand, WAHR/FALSCH, ...). Beispiel: WENN(TF(Det1) >= 5, An(Det1), LEER) - der Anwurf von Det1, aber nur bei mindestens 5s Belegung, sonst LEER (siehe dort - wird von der Aggregatstatistik automatisch ausgeschlossen).', objArgType: null },
    { name: 'ISTLEER', params: ['wert'], desc: 'Wahr, wenn "wert" LEER ist. Unterscheidet "hier gab es gar kein Ereignis" von "es gab ein Ereignis, das eine Bedingung nicht erfüllt hat" - beide wären sonst gleichermaßen NaN. Beispiel: WENN(ISTLEER(An(Det1)), 0, WENN(TF(Det1) >= 5, An(Det1), LEER)) - 0 für Umläufe ohne jedes Ereignis (bleibt sichtbar), LEER (ausgeblendet) nur für Umläufe MIT Ereignis, das die Bedingung nicht erfüllt.', objArgType: null },
    { name: 'Versatz', params: ['objektAbwurf', 'objektAnwurf'], desc: 'Zeit vom Ende des aktiven Zustands von objektAbwurf bis zum NÄCHSTEN Beginn des aktiven Zustands von objektAnwurf [s], vorwärts/zyklisch gerechnet (kurz für MOD(An(objektAnwurf)-Ab(objektAbwurf), TU_MED)). Beginnt objektAnwurf in DIESER Zeile schon VOR objektAbwurf endet (siehe Ueberschneidung), liefert das einen Wert nahe TU_MED statt einer kleinen negativen Zahl - für eine reine, ggf. negative Differenz stattdessen einfach "Ab(objektAnwurf) - Ab(objektAbwurf)" (ohne MOD) verwenden.', objArgType: 'OBJ' },
    { name: 'Ueberschneidung', params: ['objektAbwurf', 'objektAnwurf'], desc: 'Wahr, wenn der aktive Zustand von objektAnwurf in dieser Zeile schon beginnt, BEVOR der von objektAbwurf endet (Versatz würde sonst fälschlich fast eine ganze Umlaufzeit zeigen statt einer echten Überlappung).', objArgType: 'OBJ' }
  ];

  // Character range of the FIRST parameter inside "name(argList)"
  // (relative to the start, that is including the "name(" offset).
  // formulaBuilder.js and umlaufstatistiken.js use it when they insert a function call from the
  // autocomplete or the palette.
  // They select the parameter directly as a placeholder (for example "DauerSeit(sg, GRUEN)" with
  // "sg" selected).
  function argRangesFor(name, params) {
    const prefix = name.length + 1; // "name(".length
    let pos = 0;
    return params.map((p, i) => {
      const r = { start: prefix + pos, end: prefix + pos + p.length };
      pos += p.length + (i < params.length - 1 ? 2 : 0); // ", "
      return r;
    });
  }

  // extraKatTokens: like KAT_TOKENS, but active ONLY for this one tokenize() call and not reserved
  // globally
  // (see the file header comment about KAT_TOKENS).
  // So oepnvQa.js can add its own state constants (the QSV levels A to F)
  // without the formula builder (with its free variable aliases) losing these letters as
  // identifiers.
  function tokenize(text, extraKatTokens) {
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
      if (ch === '"' || ch === "'") {
        const quote = ch;
        let j = i + 1;
        while (j < n && text[j] !== quote) j++;
        if (j >= n) throw new ExprError('Unbeendete Zeichenkette (schließendes Anführungszeichen fehlt)', start);
        tokens.push({ type: 'STRING', value: text.slice(i + 1, j), pos: start, end: j + 1 });
        i = j + 1;
        continue;
      }
      if (isDigit(ch) || (ch === '.' && isDigit(text[i + 1]))) {
        let j = i;
        while (j < n && isDigit(text[j])) j++;
        // An identifier that starts with digits (for example an OCIT signal group or junction
        // number such as "809_Koord"):
        // if a letter or an underscore follows directly, it is not a number literal.
        // The code must consume the complete identifier and not only the digits.
        // Otherwise parsing crashes: "809" as NUMBER and "_Koord" as its own, unexpected IDENT.
        if (j < n && /[A-Za-z_]/.test(text[j])) {
          let k = j;
          while (k < n && isIdentPart(text[k])) k++;
          tokens.push({ type: 'IDENT', value: text.slice(i, k), pos: start, end: k });
          i = k;
          continue;
        }
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
        const katType = KAT_TOKENS[word] || (extraKatTokens && extraKatTokens[word]);
        if (upper === 'AND' || upper === 'OR' || upper === 'NOT') tokens.push({ type: upper, pos: start, end: j });
        else if (katType) tokens.push({ type: 'KATLIT', value: word, katType, pos: start, end: j });
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
  // funcs: { [name]: {params:string[], exprText:string} } (user-defined functions, see the file
  // header comment).
  //   Optional, default {}.
  // visiting: Set<string> of the function names in the current expansion stack (detection of cycles
  // in function calls).
  //   Optional, default an empty set.
  // Returns the parsed and type-checked root node WITHOUT the BOOL rule of compile().
  // The BOOL rule applies only to the formula text itself, not to (intermediate) calls of function
  // bodies.
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
        // Concretely different KAT subtypes (for example KAT_SG and KAT_DET) are never comparable.
        // If one side is still ANY (an unspecialized function parameter), the code can decide only
        // at the real call.
        const concreteKatMismatch = isKatType(left.type) && isKatType(right.type) && left.type !== right.type;
        const bothSameKat = isKatCompatible(left.type) && isKatCompatible(right.type) && !concreteKatMismatch;
        const bothText = isTextCompatible(left.type) && isTextCompatible(right.type);
        if (!bothNum && !bothSameKat && !bothText) {
          throw new ExprError(`"${opTok.type}" erwartet zwei Zahlen, zwei gleichartige Zustände oder zwei Texte, bekam ${TYPE_LABEL(left.type)} und ${TYPE_LABEL(right.type)}`, opTok.pos);
        }
        const isConcreteKat = isKatType(left.type) || isKatType(right.type);
        const isConcreteText = left.type === 'TEXT' || right.type === 'TEXT';
        if (((bothSameKat && isConcreteKat) || (bothText && isConcreteText)) && opTok.type !== '==' && opTok.type !== '!=') {
          throw new ExprError(`"${opTok.type}" ist für Zustände/Texte nicht sinnvoll - nur == oder != verwenden`, opTok.pos);
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
        const node = { type: returnType, run: prim.run(args) };
        // span (only some primitives, see TF, RG, GE, Versatz and Ueberschneidung above):
        // the time span inside the cycle that the expression means,
        // for an object-related bar display and not a bar that fills the whole row (see
        // compileValue() and umlaufpruefung.js).
        // It is lost on each further combination (+, comparison, own function, ...) on purpose.
        // Only an expression that IS exactly one of these primitive calls has a unique span.
        if (prim.span) node.span = prim.span(args);
        return node;
      }

      const fn = funcs[name];
      if (!fn) throw new ExprError(`Unbekannte Funktion "${name}"`, namePos);
      if (args.length !== fn.params.length) {
        throw new ExprError(`"${name}" erwartet ${fn.params.length} Argument(e), bekam ${args.length}`, namePos);
      }
      if (visiting.has(name)) {
        throw new ExprError(`Zyklischer Funktionsaufruf: "${name}" ruft sich (direkt oder indirekt) selbst auf`, namePos);
      }
      // Call expansion: parse and type-check the body again with the REAL argument types of THIS
      // call
      // (specialization for each call site, see the file header comment).
      // There is no generic body that the code compiles once.
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
      if (tok.type === 'STRING') { next(); const v = tok.value; return { type: 'TEXT', run: () => v }; }
      if (tok.type === 'KATLIT') { next(); const v = tok.value, kt = tok.katType; return { type: kt, run: () => v }; }
      if (tok.type === 'IDENT') {
        next();
        if (peek().type === '(') { next(); return parseCall(tok.value, tok.pos); }
        // LEER: "no value" as a literal (always NaN).
        // Its type is ANY, so it fits at EACH place where WENN() or a comparison expects a concrete
        // type
        // (see typesMatch() at WENN above).
        // The code catches it before the varTypes check, so that a column with the same name cannot
        // hide it.
        // This is unlikely, but the intention is clear: LEER is a reserved word and not a variable.
        if (tok.value === 'LEER') return { type: 'ANY', run: () => NaN };
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

  // Parses AND type-checks (but does not evaluate) ONE FORMEL text.
  // It is for live validation and as a preliminary step of the real calculation.
  // It must evaluate to BOOL (unlike a function body, see compileFunctionDef()).
  // varTypes: { [alias]: 'BOOL'|'NUM'|'TEXT'|'SG'|'DET'|'KAT_*' }
  // funcs: { [name]: {params:string[], exprText:string} }, optional.
  // extraKatTokens: see the header comment of tokenize(), optional.
  // Returns: { ok:true, run(scope)->boolean } | { ok:false, message, pos }
  function compile(text, varTypes, funcs, extraKatTokens) {
    if (!text || !text.trim()) return { ok: false, message: 'Formel ist leer.', pos: 0, incomplete: true };
    try {
      const tokens = tokenize(text, extraKatTokens);
      const node = parse(tokens, varTypes || {}, funcs || {});
      if (node.type !== 'BOOL') {
        throw new ExprError('Die Formel muss insgesamt zu WAHR/FALSCH auswerten (z.B. mit einem Vergleich wie "<" oder einer Verknüpfung mit AND/OR)', 0, true);
      }
      return { ok: true, run: node.run };
    } catch (e) {
      if (e instanceof ExprError) {
        // An error AT the end of the text means a cut-off, not yet finished expression (see the
        // ExprError header comment).
        // It is not a real mistake in thinking.
        const incomplete = e.incomplete || (typeof e.pos === 'number' && e.pos >= text.replace(/\s+$/, '').length);
        return { ok: false, message: e.message, pos: e.pos, incomplete };
      }
      return { ok: false, message: e.message || String(e), pos: 0 };
    }
  }

  // Like compile(), but WITHOUT the BOOL rule.
  // It is for contexts where the expression itself is the wanted VALUE
  // (for example an Umlaufstatistiken column: a number, WAHR/FALSCH or text) and not a filter
  // condition.
  // resultType is the statically found type ('NUM'|'BOOL'|'TEXT'|'SG'|'DET'|'KAT_*'|'ANY').
  // For Umlaufstatistiken it is enough to decide if a column gets number aggregate statistics,
  // a true/false share or only a text display. The code does not need to inspect the values.
  // Returns: { ok:true, run(scope)->value, resultType } | { ok:false, message, pos }
  function compileValue(text, varTypes, funcs, extraKatTokens) {
    if (!text || !text.trim()) return { ok: false, message: 'Ausdruck ist leer.', pos: 0, incomplete: true };
    try {
      const tokens = tokenize(text, extraKatTokens);
      const node = parse(tokens, varTypes || {}, funcs || {});
      return { ok: true, run: node.run, resultType: node.type, spanRun: node.span || null };
    } catch (e) {
      if (e instanceof ExprError) {
        const incomplete = e.incomplete || (typeof e.pos === 'number' && e.pos >= text.replace(/\s+$/, '').length);
        return { ok: false, message: e.message, pos: e.pos, incomplete };
      }
      return { ok: false, message: e.message || String(e), pos: 0 };
    }
  }

  // Parses AND type-checks (but does not evaluate) ONE FUNCTION body, isolated from each real call
  // site.
  // Each parameter gets the placeholder type ANY (see the file header comment), because the real
  // type is known only at the call.
  // This checks the syntax and the rough structure (known identifiers and functions, number of
  // arguments) BEFORE the first use.
  // But it cannot find all real type errors, which arise only with concrete argument types.
  // They can arise at the compile() of a caller (the error message is then "In Funktion […]: …").
  // Returns: { ok:true, resultType } | { ok:false, message, pos }
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

  // tokenize, PRIMITIVE_INFO and KAT_TOKENS are also exported.
  // So formulaBuilder.js builds syntax highlighting, autocomplete and the function palette
  // on the same lexer and the same list of primitives.
  // It does not duplicate them in the UI layer (single source of truth).
  return { compile, compileValue, compileFunctionDef, tokenize, PRIMITIVE_INFO, KAT_TOKENS, argRangesFor };
});
