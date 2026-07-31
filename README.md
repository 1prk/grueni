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
- **Wartezeit ab Anforderung** — Zuordnung Signalgruppe ↔ Detektor(en),
  ereignisbasierte Wartezeit-Auswertung mit Kennzahlen, Streudiagramm und
  Ereignistabelle.
- **Umlaufprüfung** — je Umlauf eine Zeile im Stil des Signalzeitendiagramms,
  mit optionalen Detektor- und APW-/ÖPNV-Wert-Zusatzspuren.

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
js/views/       Verdrahtung je Reiter (Navigator, Grünzeitanalyse, Wartezeit, Umlaufprüfung)
js/app.js       Bootstrap: Dateneingabe, Tabs, Analyse-Orchestrierung
js/vendor/      lokal eingebettetes D3.js (v7, ISC-Lizenz) — kein CDN
```

Visualisierungen sind mit [D3.js](https://d3js.org/) (lokal eingebunden,
`js/vendor/d3.v7.min.js`) als SVG umgesetzt; die Signalfarben (Rot/Gelb/Grün/
Dunkel/SPL-Marker) folgen der ursprünglichen Diagrammsprache.
