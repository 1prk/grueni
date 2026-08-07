# Grünzeitanalyse

Client-seitiges Auswertungswerkzeug für OCIT-Signalzeiten-Exporte einer
Lichtsignalanlage. Läuft vollständig im Browser — es werden keinerlei Daten
versendet (kein Server, kein `fetch`/`XHR`, keine externen Ressourcen).

## Verwenden

`index.html` direkt im Browser öffnen (Doppelklick genügt, `file://`
funktioniert ohne lokalen Server). Danach entweder "Beispieldaten laden"
klicken oder eine eigene OCIT-Export-Datei über "Datei öffnen …" einlesen.

Erwartetes Datenformat: 7 Kopfzeilen (Knoten-Metadaten, Spaltenkürzel,
Beschreibung) gefolgt von den Messzeilen — siehe Hinweistext im Reiter
„Rohdaten“ der Anwendung für die genaue Spaltenbelegung.

## Funktionsumfang

- **Grünzeitanalyse** — Signalzeitendiagramm je Signalgruppe mit Umlauf-
  Fenster, SPL-Programmleiste, Kennzahlen-Tabelle (gesamt/je Signalzeitenplan),
  Dunkel-/Abschaltzeiträume und Grünzeit-Trend (Zeitverlauf + Verteilung/CDF).
  Optional per Checkbox einblendbar: ein Phasen-Overlay über dem gesamten
  Spuren-Stapel, das je Phasen-Vorkommen eine gestrichelte Klammer
  („┊----Ph2----┊“, in der Phasenfarbe) über die volle Höhe zeichnet.
- **Stammdaten LSA** — Phaseneinteilung: legt fest, welche Signalgruppen
  gleichzeitig Grün zeigen und damit ohne Verkehrskonflikt eine gemeinsame
  Phase bilden (RiLSA). Phasen sind frei benennbar (Kürzel + Bezeichnung,
  Standard „Ph1“/„Phase 1“ usw.), beliebig hinzufügbar/entfernbar.
- **Phasenauswertung** — wertet aus, wann und wie oft jede definierte Phase
  in der Aufzeichnung tatsächlich vollständig angezeigt wurde (alle
  Mitglieds-Signalgruppen gleichzeitig grün): ein kombiniertes Phasendiagramm
  (eine Farbe je Phase, da Phasen nie gleichzeitig aktiv sind), eine
  Kennzahlen-Tabelle und "Phasendauer pro Umlauf" (gruppiertes Balkendiagramm,
  alle Phasen je Umlauf im Vergleich).
- **Wartezeit ab Anforderung** — Zuordnung Signalgruppe ↔ Detektor(en),
  ereignisbasierte Wartezeit-Auswertung mit Kennzahlen, Streudiagramm und
  Ereignistabelle.
- **ÖPNV — Anmeldung/Abmeldung** — QA-Modul für ÖPNV-Priorisierung, strukturell
  identisch zu „Wartezeit ab Anforderung“, aber mit getrennten, frei
  wählbaren Anmelde- und Abmeldedetektor(en) je Signalgruppe (z. B. Signalgruppe
  S1 über Hauptanmelder S1_HA oder Türkontakt S1_TS als Anmeldung, S1_AB als
  Abmeldung). Eine Anmeldung endet entweder mit Erfolg (Signalgruppe wird
  Dauergrün) oder wird ohne Grün wieder abgemeldet (Prioritätsfehlschlag,
  eigenes Symbol im Diagramm). Bewertung über manuell justierbare LOS-Stufen
  A–F (Obergrenzen in Sekunden) statt der zweistufigen Warn-/Grenzwertlogik.
- **Umlaufprüfung** — je Umlauf eine Zeile im Stil des Signalzeitendiagramms,
  mit optionalen Detektor- und APW-/ÖPNV-Wert-Zusatzspuren. Fenster-Steuerung
  wie im Signalzeitendiagramm, damit auch sehr lange Aufzeichnungen (viele
  tausend Umläufe) flüssig bleiben.

## Architektur

Keine Build-Pipeline, keine Bundler — klassische `<script>`-Tags (kein
`type="module"`, da ES-Module unter `file://` von den meisten Browsern aus
CORS-Gründen blockiert werden). Jede Datei kapselt sich in einer IIFE und
hängt sich an den gemeinsamen `GZ`-Namespace:

```
css/            Design-Tokens, Basis-Layout, Komponenten, Diagramm-Styles
js/core/        reine Auswertungslogik (Parser, Statistik, Segmentierung, …)
js/state.js     zentraler Analyse-Zustand
js/charts/      D3-Diagramm-Komponenten (Zeitleiste, Trend, Wartezeit-Scatter)
js/views/       Verdrahtung je Reiter (Navigator, Grünzeitanalyse, Stammdaten
                LSA, Phasenauswertung, Wartezeit, Umlaufprüfung)
js/app.js       Bootstrap: Dateneingabe, Tabs, Analyse-Orchestrierung
js/vendor/      lokal eingebettetes D3.js (v7, ISC-Lizenz) — kein CDN
```

Visualisierungen sind mit [D3.js](https://d3js.org/) (lokal eingebunden,
`js/vendor/d3.v7.min.js`) als SVG umgesetzt; die Signalfarben (Rot/Gelb/Grün/
Dunkel/SPL-Marker) folgen der ursprünglichen Diagrammsprache.
