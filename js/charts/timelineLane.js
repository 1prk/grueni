/* GZ.charts.timelineLane — D3-Renderer für EINE Signal-/Detektor-Spur.
   Wird sowohl vom Signalzeitendiagramm (Grünzeitanalyse) als auch von der
   Umlaufprüfung (eine Spur je Umlauf) verwendet. Arbeitet auf echten
   Pixelmaßen (viewBox = gemessene Containergröße), damit Kreise/Linien nicht
   durch nicht-uniforme Skalierung verzerrt werden. */
(function (GZ) {
  'use strict';
  const fmtTimeShort = GZ.format.fmtTimeShort;
  const esc = GZ.format.esc;

  const CAT_FILL = {
    GRUEN: 'var(--sig-green)',
    DUNKEL: 'var(--sig-dark)',
    UNBEKANNT: 'url(#gz-pat-unknown)',
    INV: 'url(#gz-pat-unknown)',
    LUECKE: 'url(#gz-pat-gap)',
    ROTGELB: 'url(#gz-pat-wedge-ry)',
    GELB: 'url(#gz-pat-wedge-y)',
    BELEGT: 'var(--accent)'
  };
  // "Minimal": Darstellung angelehnt an klassische Signalzeitenpläne (LISA+
  // u.ä.) - dünne rote Grundlinie, darüber UMRANDETE Kästen statt flächiger
  // Balken. Beide Gelbphasen (Rot-Gelb am Freigabebeginn und Gelb am
  // Freigabeende) werden voll gefüllt und tragen je EINEN Diagonalstrich,
  // genau wie im gedruckten Plan (siehe Slash-Block in renderLane()).
  const MINIMAL_FILL = {
    GRUEN: 'var(--sig-green)',
    DUNKEL: 'var(--sig-dark)',
    UNBEKANNT: 'url(#gz-pat-unknown)',
    INV: 'url(#gz-pat-unknown)',
    LUECKE: 'url(#gz-pat-gap)',
    ROTGELB: 'var(--sig-yellow)', // voll gefüllt
    GELB: 'var(--sig-yellow)',    // voll gefüllt + Diagonalstrich
    BELEGT: 'var(--accent)'
  };

  const CAT_LABEL = GZ.parser.CAT_LABEL;

  let defsInstalled = false;
  // Einmalig global installierte <defs> mit den Schraffur-Mustern - per
  // url(#id) aus jeder Spuren-SVG referenzierbar (IDs sind dokumentweit
  // eindeutig), damit nicht jede der potenziell vielen Spuren-SVGs eigene
  // Pattern-Definitionen mitschleppen muss.
  function ensurePatternDefs() {
    if (defsInstalled) return;
    defsInstalled = true;
    const svg = d3.select(document.body).append('svg')
      .attr('width', 0).attr('height', 0)
      .style('position', 'absolute').style('overflow', 'hidden');
    const defs = svg.append('defs');

    const wedge = (id, base) => {
      const p = defs.append('pattern').attr('id', id)
        .attr('width', 6).attr('height', 6)
        .attr('patternUnits', 'userSpaceOnUse').attr('patternTransform', 'rotate(45)');
      p.append('rect').attr('width', 6).attr('height', 6).style('fill', base);
      p.append('rect').attr('width', 3).attr('height', 6).style('fill', '#8a6d00');
    };
    wedge('gz-pat-wedge-ry', 'var(--sig-redyellow)');
    wedge('gz-pat-wedge-y', 'var(--sig-yellow)');

    const pUnknown = defs.append('pattern').attr('id', 'gz-pat-unknown')
      .attr('width', 8).attr('height', 8).attr('patternUnits', 'userSpaceOnUse')
      .attr('patternTransform', 'rotate(45)');
    pUnknown.append('rect').attr('width', 8).attr('height', 8).style('fill', '#ccc');
    pUnknown.append('rect').attr('width', 4).attr('height', 8).style('fill', '#999');

    const pGap = defs.append('pattern').attr('id', 'gz-pat-gap')
      .attr('width', 6).attr('height', 6).attr('patternUnits', 'userSpaceOnUse');
    pGap.append('rect').attr('width', 6).attr('height', 6).style('fill', '#f2f4f6');
    pGap.append('rect').attr('width', 3).attr('height', 6).style('fill', '#d8dce1');

    // Zwangslöschzeit-Fenster (Umlaufprüfung, ÖV-Fahrzeiten): helle
    // Referenz-Schraffur statt Volltonfarbe, um sie optisch von den
    // tatsächlich gemessenen Soll-/Verlustzeit-Segmenten abzuheben.
    const pZwl = defs.append('pattern').attr('id', 'gz-pat-zwl')
      .attr('width', 7).attr('height', 7).attr('patternUnits', 'userSpaceOnUse')
      .attr('patternTransform', 'rotate(45)');
    pZwl.append('rect').attr('width', 7).attr('height', 7).style('fill', '#fbd9ec');
    pZwl.append('rect').attr('width', 3).attr('height', 7).style('fill', 'var(--fz-verlust)');
  }

  function defaultTitle(s) {
    const label = CAT_LABEL[s.cat] || s.cat;
    const durS = Math.round((s.end - s.start) / 1000);
    return `${label}: ${fmtTimeShort(s.start)}–${fmtTimeShort(s.end)} (${durS}s)`;
  }

  // opts: {wMin, wMax, segs, baselineCat, baselineColor, baselineHeight,
  //   cycleMarks, splMarks, anomalyBands, reqPoints, segTitle, onGreenClick,
  //   fillFor, segLabelFor, segLabelColorFor, segOpacityFor, edgeLabelsFor,
  //   gridStepMs, laneStyle, highlights, width, height}
  // highlights: [{start, end, color, name}] - Formel-Hervorhebung (siehe
  // formulaBuilder.js getFormulaHighlights()): eine frei einfärbbare Markierung
  // "diese Formel war hier wahr", als halbtransparentes Band über die volle
  // Spurhöhe PLUS gestrichelte Randlinien an echten Intervallgrenzen (nicht am
  // Zeilenrand, falls das Intervall über die Zeile hinausreicht - dieselbe
  // "nur den tatsächlichen Rand zeigen"-Logik wie bei edgeLabelsFor). Rein
  // dekorativ (pointer-events:none), damit Klicks/Strg-Messung weiterhin das
  // darunterliegende Segment treffen, nicht das Overlay.
  // laneStyle: 'default' (bisherige, flächige Darstellung) oder 'minimal'
  // (umrandete Kästen auf dünner roter Grundlinie, Rot-Gelb voll, Gelb mit
  // Diagonalstrich - siehe MINIMAL_FILL oben). Rein visuell: dieselben
  // Segmentdaten, dieselben Beschriftungen/Interaktionen.
  // gridStepMs: optionales festes Zeitraster (z.B. 5000 = 5s-Schritte) als
  // dünne, helle senkrechte Hilfslinien ÜBER den Segmenten (damit sie auch
  // auf vollflächig gefüllten Segmenten wie GRUEN als Ablesehilfe sichtbar
  // bleiben) - verankert an wMin (Sekunden seit Zeilenbeginn treffen so
  // direkt runde Rasterwerte). Bewusst nur dort genutzt, wo eine Zeile einen
  // kurzen, festen Zeitausschnitt zeigt (Umlaufprüfung) - bei den langen
  // Zeitfenstern anderer renderLane()-Aufrufer (Signalzeitendiagramm,
  // Phasenauswertung) undefined lassen, sonst entstehen tausende Linien.
  // edgeLabelsFor(d)->{left,right}|null: wie segLabelFor, aber zwei an den
  // Segmenträndern verankerte Beschriftungen statt einer zentrierten (z.B.
  // An-/Ab-Sekunden einer Grünzeit) - siehe layoutEdgeLabels() unten für die
  // Behandlung zu schmaler Segmente.
  // segLabelFor(d)->string: optional centered text label per Segment (z.B.
  //   Sekundenwert) - immer sichtbar, unabhängig von der Segmentbreite/vom
  //   Zoomlevel (kann bei sehr schmalen Segmenten über Nachbarsegmente
  //   hinausragen/überlappen - das ist gewollt, besser als Werte zu
  //   verstecken).
  // segLabelColorFor(d)->string: optionale Textfarbe je Label (Default: weiß
  //   über .seg-label), z.B. für Segmente mit hellem Schraffur-Untergrund.
  // segOpacityFor(d)->number: optionale Deckkraft je Segment (z.B. für
  //   ausgeschlossene ÖPNV-Ereignisse), gilt für Segment UND Label.
  // width/height optional: wenn nicht angegeben, wird der Container gemessen
  // (clientWidth/-Height erzwingt einen synchronen Reflow). Wer renderLane in
  // einer Schleife für viele Spuren gleicher Größe aufruft (z. B. Umlauf-
  // prüfung), sollte einmalig VOR der Schleife messen und hier durchreichen -
  // sonst entsteht Layout-Thrashing (Schreiben einer Spur invalidiert das
  // Layout, die nächste Breitenmessung erzwingt es neu, x-mal in Folge).
  // Rückgabe: true wenn gerendert, false wenn der Container (noch) keine
  // messbare Größe hat (z. B. verstecktes Tab) - der Aufrufer rendert dann
  // beim nächsten Sichtbarwerden erneut.
  function renderLane(svgEl, opts) {
    ensurePatternDefs();
    const width = opts.width != null ? opts.width : svgEl.clientWidth;
    const height = opts.height != null ? opts.height : svgEl.clientHeight;
    if (!width || !height) return false;

    const {
      wMin, wMax, segs = [], baselineCat = 'ROT', baselineColor = 'var(--sig-red)',
      baselineHeight = 3, cycleMarks = [], splMarks = [], anomalyBands = [], reqPoints = [],
      segTitle = defaultTitle, onGreenClick, fillFor, segLabelFor, segLabelColorFor, segOpacityFor,
      edgeLabelsFor, gridStepMs, laneStyle = 'default', highlights = []
    } = opts;

    const minimal = laneStyle === 'minimal';
    const fillMap = minimal ? MINIMAL_FILL : CAT_FILL;
    // Im Minimal-Stil sind die Kästen etwas niedriger als die Spurhöhe, damit
    // die Umrandung frei steht und die dünne Grundlinie an den Rändern
    // sichtbar durchläuft (wie im gedruckten Plan).
    const segInset = minimal ? 3 : 1.5;
    const baseH = minimal ? 2 : baselineHeight;

    const x = d3.scaleLinear().domain([wMin, wMax]).range([0, width]);
    const svg = d3.select(svgEl).attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'none');
    svg.selectAll('*').remove();

    svg.append('rect').attr('class', 'lane-baseline')
      .attr('x', 0).attr('y', height / 2 - baseH / 2).attr('width', width).attr('height', baseH)
      .style('fill', baselineColor);

    const visSegs = segs.filter(s => s.end > wMin && s.start < wMax && s.cat !== baselineCat);
    const segSel = svg.append('g').attr('class', 'segs')
      .selectAll('rect.seg').data(visSegs).join('rect')
      .attr('class', d => 'seg seg-' + d.cat + (minimal ? ' seg-minimal' : ''))
      .attr('x', d => x(Math.max(d.start, wMin)))
      .attr('y', segInset)
      .attr('width', d => Math.max(x(Math.min(d.end, wMax)) - x(Math.max(d.start, wMin)), 1.2))
      .attr('height', height - 2 * segInset)
      .style('fill', d => (fillFor && fillFor(d)) || fillMap[d.cat] || '#9aa4b0')
      .style('opacity', d => segOpacityFor ? segOpacityFor(d) : 1)
      .style('cursor', d => (d.cat === 'GRUEN' && onGreenClick) ? 'pointer' : 'default');
    segSel.append('title').text(segTitle);

    // Einzelner Diagonalstrich in BEIDEN Gelbphasen - Rot-Gelb am Anfang wie
    // Gelb am Ende der Freigabe (siehe MINIMAL_FILL) - bewusst als echte
    // Linie je Segment statt als Schraffur-Muster: im Signalzeitenplan trägt
    // jedes Gelb-Kästchen GENAU EINEN Strich, unabhängig von seiner Breite
    // (ein Muster würde je nach Breite mal mehrere, mal gar keinen zeigen).
    if (minimal) {
      const amberSegs = visSegs.filter(d => d.cat === 'GELB' || d.cat === 'ROTGELB');
      svg.append('g').attr('class', 'seg-amber-slash').selectAll('line')
        .data(amberSegs).join('line')
        .attr('x1', d => x(Math.max(d.start, wMin))).attr('y1', height - segInset)
        .attr('x2', d => x(Math.min(d.end, wMax))).attr('y2', segInset)
        .style('pointer-events', 'none');
    }

    // Zeitraster ÜBER den Segmenten (nicht dahinter), sonst wäre es unter
    // vollflächig deckenden Füllungen (z.B. GRUEN) unsichtbar - dünn/hell
    // genug, um nicht mit dem Segmentinhalt zu konkurrieren.
    if (gridStepMs) {
      const gridTicks = [];
      const first = Math.ceil(wMin / gridStepMs) * gridStepMs;
      for (let t = first; t <= wMax; t += gridStepMs) gridTicks.push(t);
      svg.append('g').attr('class', 'lane-grid').selectAll('line')
        .data(gridTicks).join('line')
        .attr('x1', d => x(d)).attr('x2', d => x(d)).attr('y1', 0).attr('y2', height)
        .style('pointer-events', 'none');
    }

    // Zwei am Segmentrand verankerte Beschriftungen statt einer zentrierten
    // (siehe edgeLabelsFor-Kopfkommentar) - z.B. An/Ab-Sekunden einer
    // Grünzeit direkt auf dem Balken. Bei zu schmalem Segment (geschätzte
    // Textbreite beider Labels + Mindestabstand größer als die Segment-
    // breite) bleiben beide Labels an ihren äußeren Rändern (nie versteckt,
    // dieselbe Philosophie wie segLabelFor), zusätzlich markiert ein kleiner
    // Trenner in der Mitte, dass hier eng zusammengequetscht wurde, statt
    // die beiden Zahlen kommentarlos ineinanderlaufen zu lassen.
    if (edgeLabelsFor) {
      const CHAR_W = 5.4; // ~0.6 * 9px Schriftgröße (var(--mono)), grobe Schätzung
      const PAD = 3, GAP = 6, MARKER_W = 6;
      // labels.left/labels.right sind EINZELN optional (null/undefined =
      // kein Rand-Label an dieser Seite) - z.B. für ein Segment, das über
      // den sichtbaren Zeitausschnitt hinausreicht: der Aufrufer kennt dann
      // nur den WIRKLICH hier liegenden Rand (siehe umlaufpruefung.js'
      // edgeLabelsFor-Kopfkommentar zu über Umlaufgrenzen hinausreichenden
      // Grünzeiten) und darf den anderen einfach weglassen, statt einen
      // Wert zu zeigen, der zu einem ganz anderen (Nachbar-)Segment gehört.
      const edgeData = visSegs.map(d => {
        const labels = edgeLabelsFor(d);
        if (!labels) return null;
        const hasLeft = labels.left != null, hasRight = labels.right != null;
        if (!hasLeft && !hasRight) return null;
        const x0 = x(Math.max(d.start, wMin)), x1 = x(Math.min(d.end, wMax));
        const segW = x1 - x0;
        const leftW = hasLeft ? String(labels.left).length * CHAR_W : 0;
        const rightW = hasRight ? String(labels.right).length * CHAR_W : 0;
        // "Eng, aber lesbar" (Marker in der Mitte) vs. "so knapp, dass sogar
        // der Marker selbst nur zusätzlich überlappen würde" (dann lieber
        // GAR keinen Marker zeigen, statt drei Zeichen ineinander zu
        // quetschen - die beiden Zahlen bleiben trotzdem immer sichtbar,
        // auch wenn sie sich dabei selbst berühren/überlappen). Nur relevant,
        // wenn BEIDE Seiten ein Label haben - bei nur einem Label gibt es
        // keine zwei Zahlen, die kollidieren könnten.
        const overflow = hasLeft && hasRight && (leftW + rightW + GAP + 2 * PAD) > segW;
        const showMarker = overflow && (leftW + rightW + MARKER_W) <= segW;
        return { d, x0, x1, labels, hasLeft, hasRight, showMarker };
      }).filter(Boolean);

      const eg = svg.append('g').attr('class', 'seg-edge-labels');
      eg.selectAll('text.seg-edge-label-left').data(edgeData.filter(e => e.hasLeft)).join('text')
        .attr('class', 'seg-edge-label seg-edge-label-left')
        .attr('x', e => e.x0 + PAD).attr('y', height / 2).attr('dy', '0.32em')
        .style('opacity', e => segOpacityFor ? segOpacityFor(e.d) : 1)
        .text(e => e.labels.left);
      eg.selectAll('text.seg-edge-label-right').data(edgeData.filter(e => e.hasRight)).join('text')
        .attr('class', 'seg-edge-label seg-edge-label-right')
        .attr('x', e => e.x1 - PAD).attr('y', height / 2).attr('dy', '0.32em')
        .style('opacity', e => segOpacityFor ? segOpacityFor(e.d) : 1)
        .text(e => e.labels.right);
      eg.selectAll('text.seg-edge-overflow').data(edgeData.filter(e => e.showMarker)).join('text')
        .attr('class', 'seg-edge-overflow')
        .attr('x', e => (e.x0 + e.x1) / 2).attr('y', height / 2).attr('dy', '0.32em')
        .text('·'); // Mittelpunkt (U+00B7) statt "⋯" (U+22EF) - Letzteres fehlt in gängigen
        // Monospace-Schriften (leeres Glyph, siehe var(--mono)) und blieb unsichtbar.
    }

    if (segLabelFor) {
      svg.append('g').attr('class', 'seg-labels').selectAll('text').data(visSegs).join('text')
        .attr('class', 'seg-label')
        .attr('x', d => (x(Math.max(d.start, wMin)) + x(Math.min(d.end, wMax))) / 2)
        .attr('y', height / 2).attr('dy', '0.32em')
        .style('opacity', d => segOpacityFor ? segOpacityFor(d) : 1)
        .style('fill', d => (segLabelColorFor && segLabelColorFor(d)) || null)
        .style('pointer-events', 'none')
        .text(d => segLabelFor(d) || '');
    }

    if (onGreenClick) {
      segSel.filter(d => d.cat === 'GRUEN').on('click', function (event, d) {
        svg.selectAll('rect.seg-GRUEN').classed('pinned', false).style('stroke', null).style('stroke-width', null);
        d3.select(this).classed('pinned', true).style('stroke', 'var(--accent)').style('stroke-width', 2);
        onGreenClick(d);
      });
    }

    svg.append('g').attr('class', 'cycle-marks').selectAll('line')
      .data(cycleMarks.filter(t => t >= wMin && t <= wMax)).join('line')
      .attr('x1', d => x(d)).attr('x2', d => x(d)).attr('y1', 0).attr('y2', height)
      .style('stroke', 'rgba(0,0,0,.32)').style('stroke-dasharray', '3,2').style('stroke-width', 1)
      .append('title').text(d => `Umlaufbeginn (TX=0), ${fmtTimeShort(d)}`);

    svg.append('g').attr('class', 'spl-marks').selectAll('line')
      .data(splMarks.filter(m => m.t >= wMin && m.t <= wMax)).join('line')
      .attr('x1', d => x(d.t)).attr('x2', d => x(d.t)).attr('y1', 0).attr('y2', height)
      .style('stroke', 'var(--req-marker)').style('stroke-dasharray', '3,2').style('stroke-width', 1)
      .append('title').text(d => `Signalprogrammwechsel ${fmtTimeShort(d.t)}: SPL ${esc(d.from)} → ${esc(d.to)}`);

    svg.append('g').attr('class', 'anomaly-bands').selectAll('rect')
      .data(anomalyBands.filter(b => b.end > wMin && b.start < wMax)).join('rect')
      .attr('x', d => x(Math.max(d.start, wMin))).attr('y', 0)
      .attr('width', d => Math.max(x(Math.min(d.end, wMax)) - x(Math.max(d.start, wMin)), 1))
      .attr('height', 4)
      .style('fill', 'var(--sig-yellow)').style('opacity', .9)
      .append('title').text('Auffälliger Umlauf – Grünzeit weicht stark vom Median ab');

    svg.append('g').attr('class', 'req-points').selectAll('circle')
      .data(reqPoints.filter(p => p.t >= wMin && p.t <= wMax)).join('circle')
      .attr('cx', d => x(d.t)).attr('cy', height / 2).attr('r', d => d.unresolved ? 5 : 4.2)
      .style('fill', d => d.unresolved ? '#fff' : 'var(--req-marker)')
      .style('stroke', 'var(--req-marker)').style('stroke-width', d => d.unresolved ? 2 : 1.4)
      .append('title').text(d => d.unresolved
        ? `Anforderungsbeginn: ${fmtTimeShort(d.t)} – bis Datenende unaufgelöst (kein Grün erhalten)`
        : `Anforderungsbeginn (erste Detektorbelegung): ${fmtTimeShort(d.t)}`);

    // Formel-Hervorhebung ZULETZT (über allem anderen), damit die Einfärbung
    // auch auf vollflächigen Segmenten (z.B. GRUEN) sichtbar bleibt. Eine
    // Randlinie nur zeichnen, wenn die Zeile den echten Intervallrand enthält
    // (start/end >= wMin/<= wMax) - sonst entstünde am Zeilenrand eine falsche
    // Grenze, obwohl das Intervall dort in Wirklichkeit weiterläuft.
    const hlVis = highlights.filter(h => h.end > wMin && h.start < wMax);
    if (hlVis.length) {
      const hlG = svg.append('g').attr('class', 'formula-highlights');
      hlG.selectAll('rect.formula-hl-band').data(hlVis).join('rect')
        .attr('class', 'formula-hl-band')
        .attr('x', d => x(Math.max(d.start, wMin))).attr('y', 0)
        .attr('width', d => Math.max(x(Math.min(d.end, wMax)) - x(Math.max(d.start, wMin)), 1))
        .attr('height', height)
        .style('fill', d => d.color);
      hlG.selectAll('line.formula-hl-edge-start').data(hlVis.filter(d => d.start >= wMin)).join('line')
        .attr('class', 'formula-hl-edge')
        .attr('x1', d => x(d.start)).attr('x2', d => x(d.start)).attr('y1', 0).attr('y2', height)
        .style('stroke', d => d.color);
      hlG.selectAll('line.formula-hl-edge-end').data(hlVis.filter(d => d.end <= wMax)).join('line')
        .attr('class', 'formula-hl-edge')
        .attr('x1', d => x(d.end)).attr('x2', d => x(d.end)).attr('y1', 0).attr('y2', height)
        .style('stroke', d => d.color);
    }

    return true;
  }

  // Zeitachse als eigene kleine D3-Achse (x-Skala identisch zu den Spuren).
  function renderTimeAxis(svgEl, wMin, wMax) {
    const width = svgEl.clientWidth, height = svgEl.clientHeight;
    if (!width || !height) return false;
    const x = d3.scaleLinear().domain([wMin, wMax]).range([0, width]);
    const svg = d3.select(svgEl).attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'none');
    svg.selectAll('*').remove();
    const n = 6;
    const g = svg.append('g').attr('class', 'd3-axis-x');
    for (let i = 0; i <= n; i++) {
      const t = wMin + (wMax - wMin) * i / n;
      const px = x(t);
      const anchor = i === 0 ? 'start' : (i === n ? 'end' : 'middle');
      g.append('text').attr('x', px).attr('y', height - 3).attr('text-anchor', anchor).text(fmtTimeShort(t));
    }
    return true;
  }

  GZ.charts = GZ.charts || {};
  GZ.charts.timelineLane = { renderLane, renderTimeAxis, ensurePatternDefs, CAT_FILL };
})(window.GZ = window.GZ || {});
