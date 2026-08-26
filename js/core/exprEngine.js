/* GZ.exprEngine — kleiner, abhängigkeitsfreier Formel-Interpreter für den
   Umlaufprüfung-Formel-Builder (synthetische Detektoren aus Variablen-
   Ausdrücken) UND für Umlaufstatistiken (umlaufweise berechnete Kennzahlen-
   Spalten, siehe js/views/umlaufstatistiken.js). Reine Berechnungslogik,
   kein DOM-Bezug.

   Umlaufweise Primitiven (An/Ab/TF/RG/GE/Ausgeloest/AnzahlAusloesungen,
   siehe PRIMITIVES weiter unten) lesen aus handle.cycleMetrics statt aus
   handle.sweep - einem vom Aufrufer gepflegten, flachen Objekt mit den
   Kennzahlen des jeweils "aktuellen" Umlaufs (GZ.segments.
   computeCycleSgMetrics/computeCycleDetMetrics). compileValue() (wie
   compile(), aber ohne die BOOL-Pflicht) ist der Einstiegspunkt für
   Umlaufstatistiken, wo der Ausdruck selbst der gesuchte Wert ist statt
   einer Filterbedingung.

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
   einen auswertbaren Wert - Zustand(sg|det)->KAT_*, Dauer(sg|det)->NUM
   (Sekunden im aktuellen Zustand), DauerSeit(sg|det, kategorie)->NUM
   (Sekunden seit dem letzten Eintritt in "kategorie", 0 wenn gerade nicht
   in diesem Zustand). Der aktuelle Auswertungszeitpunkt wird NICHT als
   Argument übergeben, sondern läuft intern/implizit über das jeweilige
   Objekt-Handle (siehe scope unten, handle.sweep) - TX bleibt zwar als
   normale NUM-Variable im scope verfügbar (z.B. für eigene Bedingungen wie
   "TX > 60" in einer Funktion), muss aber nie an eine Primitive übergeben
   werden und ist daher nirgends ein Pflichtargument.

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

  // incomplete: der Ausdruck ist nicht FALSCH, sondern (noch) NICHT FERTIG -
  // z.B. "DauerSeit(K1, GRUEN) > " mitten im Tippen oder ein für sich
  // gültiger, nur noch nicht zu WAHR/FALSCH ergänzter Ausdruck. Aufrufer
  // können das neutral statt als roten Fehler anzeigen (siehe
  // validateFormulaRow() in formulaBuilder.js) - sonst blinkt beim normalen
  // Tippen dauernd eine Fehlermeldung auf, die gar keine ist.
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
  // KAT_* ist offen für beliebig viele konkrete Zustands-Kategorien (aktuell
  // KAT_SG/KAT_DET aus KAT_TOKENS unten, plus was ein Aufrufer per
  // extraKatTokens registriert, z.B. KAT_QSV in oepnvQa.js) - generisch am
  // Namensschema erkannt statt eine feste Liste zu pflegen.
  const isKatType = t => typeof t === 'string' && t.indexOf('KAT_') === 0;
  const isKatCompatible = t => isKatType(t) || t === 'ANY';
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

    // ---- Umlaufweise Primitiven (An/Ab/TF/RG/GE/Ausgeloest/AnzahlAusloesungen) ----
    // Lesen NICHT aus handle.sweep (Zustand am aktuellen Zeitpunkt), sondern
    // aus handle.cycleMetrics - einem vom Aufrufer gepflegten, flachen
    // Objekt mit den Kennzahlen des jeweils "aktuellen" Umlaufs (siehe
    // GZ.segments.computeCycleSgMetrics/computeCycleDetMetrics). Für die
    // umlaufweise Auswertung (Umlaufstatistiken) wird cycleMetrics einmal je
    // Umlauf gesetzt; für die zeilenweise Auswertung (Formel-Builder,
    // umlaufpruefung.js) hält der Aufrufer cycleMetrics beim Überschreiten
    // einer Umlaufgrenze aktuell (ändert sich sonst nicht pro Zeile). Fehlt
    // ein Wert (kein Grün in diesem Umlauf bzw. kein cycleMetrics gesetzt),
    // liefern die NUM-Primitiven NaN (konsistent mit dem NUM/NaN-Vertrag
    // dieser Datei, siehe Kopfkommentar) statt eines Sonderfalls.
    // An/Ab/TF/RG/GE sind UNIVERSELL: eine Signalgruppe UND ein Detektor/APW-/
    // ÖPNV-Wert haben beide genau EINEN "aktiven" Zustand, dessen Beginn/Ende
    // je Umlauf interessiert - GRUEN bei einer Signalgruppe, BELEGT bei einem
    // Detektor/Wert (siehe GZ.parser.categorizeSgRaw/categorizeDetRaw). "An"
    // ist dabei einfach "wann beginnt dieser aktive Zustand" (Anwurf bei einer
    // Signalgruppe, Belegungsbeginn bei einem Detektor), "Ab" entsprechend
    // dessen Ende. RG/GE (Rotgelb/Gelb unmittelbar vor/nach der Freigabe)
    // ergeben nur für Signalgruppen einen Wert ungleich 0 - ein Detektor/Wert
    // kennt diese Zwischenkategorien nicht (adjacentTransitionDurations()
    // trifft dort schlicht nie, kein Sonderfall nötig).
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

    // WertBei: der Rohwert einer Signalgruppe ODER eines Detektors/APW-/
    // ÖPNV-Werts zu einem beliebigen Zeitpunkt innerhalb des aktuellen
    // Umlaufs [s ab Umlaufbeginn] - typischerweise selbst wieder eine der
    // Umlaufweisen Primitiven oben, z.B. WertBei(APW_01, Ab(K1)): "welchen
    // Countdown zeigte APW_01 im Moment des Abwurfs von K1", oder
    // WertBei(K2, Ab(K1)): "welches Signalbild (Rohwert) zeigte K2 in genau
    // diesem Moment". Anders als Zustand() (aktueller Zeitpunkt, kategorisiert
    // zu GRUEN/ROT/.../BELEGT/FREI) oder Ausgeloest/AnzahlAusloesungen (die
    // nur wissen wollen, OB/WIE OFT belegt) liest dies den tatsächlichen,
    // unkategorisierten Rohwert zu einem BELIEBIGEN Zeitpunkt - siehe
    // handle.rawSample (GZ.segments.makeRawValueSampler) und
    // scope.__cycleStart (Umlaufbeginn in ms, vom Aufrufer gesetzt, siehe
    // GZ.umlaufContext/formulaBuilder.js berechnen()).
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

    // DauerBei: wie lange (in Sekunden) war eine Signalgruppe ODER ein
    // Detektor/APW-/ÖPNV-Wert zu einem beliebigen Zeitpunkt bereits
    // UNUNTERBROCHEN im selben (jeweils aktuellen) Zustand - generische,
    // um einen expliziten Zeitpunkt erweiterte Fassung von Dauer() (das nur
    // den JEWEILS AKTUELLEN Zeitpunkt kennt und deshalb in Umlaufstatistiken
    // nicht nutzbar ist, siehe perRowOnly unten). Beantwortet z.B. "wie lange
    // war Det1 im Moment des Abwurfs von K1 schon ununterbrochen belegt" -
    // WertBei(det, Ab(sg)) liefert nur den Rohwert an dieser Stelle, DauerBei
    // dagegen "seit wann gilt dieser Zustand" - für Signalgruppen ebenso
    // (z.B. "wie lange war K2 zum Zeitpunkt X schon grün"). Bewusst
    // GENERISCH: fragt nicht nach einer bestimmten Kategorie (GRUEN/BELEGT/
    // ...), sondern nach der Dauer des Zustands, der zu diesem Zeitpunkt
    // eben gerade gilt - siehe handle.durationAt (GZ.segments.
    // makeSegmentDurationSampler) und scope.__cycleStart (wie bei WertBei).
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

    // Versatz/Ueberschneidung: die eigentliche Motivation für An/Ab/TU_MED
    // oben - "Zeit von Abwurf sg1 bis Anwurf sg2" ist der häufigste Fall,
    // verdient also eine eigene, selbsterklärende Primitive statt jedes Mal
    // MOD(An(sg2) - Ab(sg1), TU_MED) von Hand auszuschreiben. Wrapt intern
    // exakt so (inkl. Umlaufgrenze) - siehe An/Ab oben. Wie An/Ab UNIVERSELL:
    // "Abwurf"/"Anwurf" gilt sinngemäß auch für Detektor/APW-/ÖPNV-Werte
    // (Belegungsende/-beginn).
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
      // Objekt-bezogene Spanne für die Darstellung als Balken (siehe
      // umlaufpruefung.js Kennzahl-Spur): NICHT modulo-normalisiert wie
      // run() oben - reicht der Versatz über das Umlaufende hinaus
      // (cmTo.an < cmFrom.ab, siehe Ueberschneidung), liefert das eine
      // rückwärtslaufende Spanne (endSec < startSec); der Aufrufer erkennt
      // das und fällt auf die volle Zeilenbreite zurück statt geometrisch
      // falsch zu zeichnen.
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

  // Anzeige-Metadaten für Primitiven (Autovervollständigung/Funktions-Palette
  // in formulaBuilder.js UND umlaufstatistiken.js, sowie Tooltip-/Legende-
  // Text dort) - getrennt von PRIMITIVES.check/run oben, da rein
  // beschreibend (keine Auswertungslogik). desc ist die einzige Doku, die
  // Nutzer je Primitive zu sehen bekommen (Autovervollständigung, ƒ-Palette,
  // Umlaufstatistiken-Legende) - entsprechend ausführlich: was genau
  // geliefert wird, für welche Objekt-Typen, und wie sich Sonderfälle
  // (kein Ereignis, keine Rotgelb-/Gelb-Nachbarschaft, ...) verhalten.
  //
  // objArgType (optional): welchen Objekt-Typ das/die Argument(e) dieser
  // Primitive erwarten - 'SG' oder 'DET', wenn NUR einer der beiden Typen
  // gültig ist (z.B. Ausgeloest/AnzahlAusloesungen: nur Detektor/Wert, kein
  // "wie oft war diese Signalgruppe an" definiert); 'OBJ', wenn BEIDES
  // gültig ist (An/Ab/TF/RG/GE/Versatz/Ueberschneidung/WertBei/DauerBei sind
  // UNIVERSELL - eine Signalgruppe UND ein Detektor/APW-/ÖPNV-Wert haben
  // beide genau einen "aktiven" Zustand mit Beginn/Ende, siehe An/Ab-
  // Kopfkommentar in PRIMITIVES oben); fehlt bei Zustand/Dauer/DauerSeit
  // (akzeptieren ebenfalls SG ODER DET, sind aber ohnehin perRowOnly und in
  // Umlaufstatistiken gar nicht erst aufrufbar) sowie bei rein numerischen
  // Primitiven wie MOD. umlaufstatistiken.js nutzt dies, um innerhalb eines
  // Funktionsaufrufs (z.B. "An(") gezielt nur Signalgruppen- bzw. Detektor-/
  // APW-Namen (bzw. bei 'OBJ' beide) vorzuschlagen, statt aller bekannten
  // Bezeichner - EINZIGE Stelle, die das pflegt (nicht länger separate
  // SG_ARG_FNS/DET_ARG_FNS-Listen dort).
  //
  // perRowOnly (optional): true, wenn die Primitive aus handle.sweep liest
  // (Zustand am jeweils AKTUELLEN Zeitpunkt) statt aus handle.cycleMetrics/
  // handle.rawSample/handle.durationAt - funktioniert daher nur zeilenweise
  // (Formel-Builder), nicht in Umlaufstatistiken (siehe dortiges
  // findPerRowOnlyUsage()). DauerBei ist die um einen expliziten Zeitpunkt
  // erweiterte, dadurch auch in Umlaufstatistiken nutzbare Fassung von Dauer.
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
    { name: 'Versatz', params: ['objektAbwurf', 'objektAnwurf'], desc: 'Zeit vom Ende des aktiven Zustands von objektAbwurf bis zum NÄCHSTEN Beginn des aktiven Zustands von objektAnwurf [s], vorwärts/zyklisch gerechnet (kurz für MOD(An(objektAnwurf)-Ab(objektAbwurf), TU_MED)). Beginnt objektAnwurf in DIESER Zeile schon VOR objektAbwurf endet (siehe Ueberschneidung), liefert das einen Wert nahe TU_MED statt einer kleinen negativen Zahl - für eine reine, ggf. negative Differenz stattdessen einfach "Ab(objektAnwurf) - Ab(objektAbwurf)" (ohne MOD) verwenden.', objArgType: 'OBJ' },
    { name: 'Ueberschneidung', params: ['objektAbwurf', 'objektAnwurf'], desc: 'Wahr, wenn der aktive Zustand von objektAnwurf in dieser Zeile schon beginnt, BEVOR der von objektAbwurf endet (Versatz würde sonst fälschlich fast eine ganze Umlaufzeit zeigen statt einer echten Überlappung).', objArgType: 'OBJ' }
  ];

  // extraKatTokens: wie KAT_TOKENS, aber NUR für diesen einen tokenize()-
  // Aufruf aktiv statt global reserviert (siehe Datei-Kopfkommentar zu
  // KAT_TOKENS) - damit z.B. oepnvQa.js eigene Zustands-Konstanten (QSV-
  // Stufen A-F) einführen kann, ohne dass diese Buchstaben dem Formel-
  // Builder (mit seinen frei wählbaren Variablen-Aliasen) als Bezeichner
  // verloren gehen.
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
        // Konkret unterschiedliche KAT-Subtypen (z.B. KAT_SG vs. KAT_DET)
        // sind nie vergleichbar; ist eine Seite noch ANY (unspezialisierter
        // Funktionsparameter), lässt sich das erst am tatsächlichen Aufruf
        // entscheiden.
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
        // span (nur einige Primitiven, siehe TF/RG/GE/Versatz/Ueberschneidung
        // oben): die vom Ausdruck gemeinte Zeitspanne innerhalb des Umlaufs,
        // für eine objekt-bezogene Balkendarstellung statt eines die ganze
        // Zeile füllenden Balkens (siehe compileValue()/umlaufpruefung.js).
        // Geht bei jeder weiteren Verknüpfung (+, Vergleich, eigene Funktion,
        // ...) bewusst verloren - nur ein Ausdruck, der GENAU einer dieser
        // Primitiven-Aufrufe IST, hat eine eindeutige Spanne.
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
      if (tok.type === 'STRING') { next(); const v = tok.value; return { type: 'TEXT', run: () => v }; }
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
  // varTypes: { [alias]: 'BOOL'|'NUM'|'TEXT'|'SG'|'DET'|'KAT_*' }
  // funcs: { [name]: {params:string[], exprText:string} }, optional.
  // extraKatTokens: siehe tokenize()-Kopfkommentar, optional.
  // Rückgabe: { ok:true, run(scope)->boolean } | { ok:false, message, pos }
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
        // Fehler AM Textende = abgeschnittener, noch unfertiger Ausdruck
        // (siehe ExprError-Kopfkommentar) - kein echter Denkfehler.
        const incomplete = e.incomplete || (typeof e.pos === 'number' && e.pos >= text.replace(/\s+$/, '').length);
        return { ok: false, message: e.message, pos: e.pos, incomplete };
      }
      return { ok: false, message: e.message || String(e), pos: 0 };
    }
  }

  // Wie compile(), aber OHNE die BOOL-Pflicht - für Kontexte, in denen der
  // Ausdruck selbst der gesuchte WERT ist (z.B. eine Umlaufstatistiken-
  // Spalte: Zahl, WAHR/FALSCH oder Text), nicht eine Filterbedingung.
  // resultType ist der statisch ermittelte Typ ('NUM'|'BOOL'|'TEXT'|'SG'|
  // 'DET'|'KAT_*'|'ANY') - für Umlaufstatistiken bereits ausreichend, um zu
  // entscheiden, ob eine Spalte Zahlen-Aggregatstatistik, einen Wahr/Falsch-
  // Anteil oder nur Textanzeige bekommt, ohne die Werte selbst inspizieren
  // zu müssen.
  // Rückgabe: { ok:true, run(scope)->Wert, resultType } | { ok:false, message, pos }
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
  GZ.exprEngine = { compile, compileValue, compileFunctionDef, tokenize, PRIMITIVE_INFO, KAT_TOKENS };
})(window.GZ = window.GZ || {});
