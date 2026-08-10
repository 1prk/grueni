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
  //   fillFor, segLabelFor, segLabelColorFor, segOpacityFor, width, height}
  // segLabelFor(d)->string: optional centered text label per Segment (z.B.
  //   Sekundenwert), automatisch ausgeblendet wenn das Segment zu schmal ist.
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
      segTitle = defaultTitle, onGreenClick, fillFor, segLabelFor, segLabelColorFor, segOpacityFor
    } = opts;

    const x = d3.scaleLinear().domain([wMin, wMax]).range([0, width]);
    const svg = d3.select(svgEl).attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'none');
    svg.selectAll('*').remove();

    svg.append('rect').attr('class', 'lane-baseline')
      .attr('x', 0).attr('y', height / 2 - baselineHeight / 2).attr('width', width).attr('height', baselineHeight)
      .style('fill', baselineColor);

    const visSegs = segs.filter(s => s.end > wMin && s.start < wMax && s.cat !== baselineCat);
    const segSel = svg.append('g').attr('class', 'segs')
      .selectAll('rect.seg').data(visSegs).join('rect')
      .attr('class', d => 'seg seg-' + d.cat)
      .attr('x', d => x(Math.max(d.start, wMin)))
      .attr('y', 1.5)
      .attr('width', d => Math.max(x(Math.min(d.end, wMax)) - x(Math.max(d.start, wMin)), 1.2))
      .attr('height', height - 3)
      .style('fill', d => (fillFor && fillFor(d)) || CAT_FILL[d.cat] || '#9aa4b0')
      .style('opacity', d => segOpacityFor ? segOpacityFor(d) : 1)
      .style('cursor', d => (d.cat === 'GRUEN' && onGreenClick) ? 'pointer' : 'default');
    segSel.append('title').text(segTitle);

    if (segLabelFor) {
      svg.append('g').attr('class', 'seg-labels').selectAll('text').data(visSegs).join('text')
        .attr('class', 'seg-label')
        .attr('x', d => (x(Math.max(d.start, wMin)) + x(Math.min(d.end, wMax))) / 2)
        .attr('y', height / 2).attr('dy', '0.32em')
        .style('opacity', d => (x(Math.min(d.end, wMax)) - x(Math.max(d.start, wMin))) >= 18 ? (segOpacityFor ? segOpacityFor(d) : 1) : 0)
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
