/* GZ.charts.timelineLane is the D3 renderer for ONE signal or detector track.
   Both the signal time chart (Grünzeitanalyse) and the cycle check (one track for each cycle)
   use it.
   It works with real pixel sizes (viewBox = measured container size).
   So circles and lines are not distorted by a non-uniform scale. */
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
  // "Minimal": a look that follows classic signal timing plans (LISA+ and similar).
  // It has a thin red baseline and OUTLINED boxes above it, not area bars.
  // Both amber phases (red-amber at the start of the green and amber at the end of the green)
  // are fully filled. Each has ONE diagonal stroke, as in the printed plan (see the slash block in
  // renderLane()).
  const MINIMAL_FILL = {
    GRUEN: 'var(--sig-green)',
    DUNKEL: 'var(--sig-dark)',
    UNBEKANNT: 'url(#gz-pat-unknown)',
    INV: 'url(#gz-pat-unknown)',
    LUECKE: 'url(#gz-pat-gap)',
    ROTGELB: 'var(--sig-yellow)', // Fully filled
    GELB: 'var(--sig-yellow)',    // Fully filled plus a diagonal stroke
    BELEGT: 'var(--accent)'
  };

  const CAT_LABEL = GZ.parser.CAT_LABEL;

  let defsInstalled = false;
  // <defs> with the hatch patterns. The code installs them once, globally.
  // Each track SVG can reference them with url(#id). The IDs are unique in the whole document.
  // So each of the many track SVGs does not need to carry its own pattern definitions.
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

    // Forced clearance time window (cycle check, public transport travel times):
    // a light reference hatch and not a solid color.
    // It looks different from the measured planned-time and lost-time segments.
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
  //   cycleMarks, splMarks, anomalyBands, reqPoints, endMarks, segTitle,
  //   onGreenClick, onSegClick, fillFor, segLabelFor, segLabelColorFor,
  //   segOpacityFor, edgeLabelsFor, gridStepMs, laneStyle, highlights,
  //   width, height}
  // endMarks: [{t, label}]. Solid vertical marker lines at a fixed point in time. They do not
  // depend on the segments.
  //   An example is the end of a phase transition in the PÜ tool (see stammdatenLsa.js and
  //   umlaufpruefung.js).
  //   They look different from cycleMarks and splMarks (dashed) on purpose.
  //   They are not a cycle start or a signal plan change.
  // onSegClick(d, event): like onGreenClick, but for EVERY segment (not only by cat) and without
  // the "pinned" edge marker.
  //   An example is the cycle check: a click on a phase transition opens the PÜ detail tool (see
  //   togglePueDetail() there).
  // segCursor(d) -> 'pointer' | 'default' | undefined: tells which segments show a clickable
  // cursor.
  //   Without this option, only GRUEN with onGreenClick is clickable (the earlier behavior).
  //   With onSegClick, usually only a REAL subset of the segments is clickable
  //   (for example only named phase transitions, not each segment of the track).
  //   So this is its own function and not a general rule.
  // highlights: [{start, end, color, name}]. Formula highlight (see getFormulaHighlights() in
  // formulaBuilder.js).
  //   It is a free-color marker for "this formula was true here".
  //   It is a semi-transparent band over the full track height PLUS dashed border lines at real
  //   interval borders.
  //   The border lines are not at the row edge when the interval extends past the row.
  //   This is the same logic "show only the real edge" as for edgeLabelsFor.
  //   It is purely decorative (pointer-events:none).
  //   So clicks and the Ctrl measurement still hit the segment below, not the overlay.
  // laneStyle: 'default' (the earlier area display) or 'minimal'
  //   (outlined boxes on a thin red baseline, red-amber fully filled, amber with a diagonal stroke,
  //   see MINIMAL_FILL above).
  //   It is purely visual: the same segment data, the same labels and the same interactions.
  // gridStepMs: an optional fixed time grid (for example 5000 = steps of 5 s).
  //   It is drawn as thin, light vertical help lines ABOVE the segments,
  //   so they stay visible as a reading aid also on fully filled segments such as GRUEN.
  //   The anchor is wMin, so seconds since the row start hit round grid values.
  //   Use it only where a row shows a short, fixed time section (cycle check).
  //   Leave it undefined for the long time windows of other renderLane() callers (signal time
  //   chart, Phasenauswertung).
  //   Otherwise there are thousands of lines.
  // edgeLabelsFor(d) -> {left,right} | null: like segLabelFor, but two labels at the segment edges
  // and not one in the center
  //   (for example the An and Ab seconds of a green time).
  //   See layoutEdgeLabels() below for how it handles segments that are too narrow.
  // segLabelFor(d) -> string: an optional centered text label for each segment (for example a
  // seconds value).
  //   It is always visible, independent of the segment width and of the zoom level.
  //   For very narrow segments it can extend over neighboring segments or overlap them.
  //   This is intended. It is better than to hide values.
  // segLabelColorFor(d) -> string: an optional text color for each label (default: white through
  // .seg-label),
  //   for example for segments with a light hatch background.
  // segOpacityFor(d) -> number: an optional opacity for each segment (for example for excluded ÖPNV
  // events).
  //   It applies to the segment AND the label.
  // width and height are optional. If you do not give them, the code measures the container.
  //   clientWidth and clientHeight force a synchronous reflow.
  //   If you call renderLane in a loop for many tracks of the same size (for example the cycle
  //   check),
  //   measure once BEFORE the loop and pass the values here.
  //   Otherwise you get layout thrashing: writing one track invalidates the layout,
  //   the next width measurement forces it again, many times in a row.
  // Returns true if it rendered, and false if the container has no measurable size (yet), for
  // example in a hidden tab.
  //   The caller then renders again when the container becomes visible.
  function renderLane(svgEl, opts) {
    ensurePatternDefs();
    const width = opts.width != null ? opts.width : svgEl.clientWidth;
    const height = opts.height != null ? opts.height : svgEl.clientHeight;
    if (!width || !height) return false;

    const {
      wMin, wMax, segs = [], baselineCat = 'ROT', baselineColor = 'var(--sig-red)',
      baselineHeight = 3, cycleMarks = [], splMarks = [], anomalyBands = [], reqPoints = [], endMarks = [],
      segTitle = defaultTitle, onGreenClick, onSegClick, segCursor, fillFor, segLabelFor, segLabelColorFor, segOpacityFor,
      edgeLabelsFor, gridStepMs, laneStyle = 'default', highlights = []
    } = opts;

    const minimal = laneStyle === 'minimal';
    const fillMap = minimal ? MINIMAL_FILL : CAT_FILL;
    // In the Minimal style the boxes are a little lower than the track height.
    // So the outline stands free, and the thin baseline runs through visibly at the edges (as in
    // the printed plan).
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
      .style('cursor', d => segCursor ? (segCursor(d) || 'default') : ((d.cat === 'GRUEN' && onGreenClick) ? 'pointer' : 'default'));
    segSel.append('title').text(segTitle);

    // One single diagonal stroke in BOTH amber phases: red-amber at the start and amber at the end
    // of the green (see MINIMAL_FILL).
    // It is a real line for each segment on purpose and not a hatch pattern.
    // In the signal timing plan each amber box has EXACTLY ONE stroke, independent of its width.
    // A pattern would show many strokes or none, depending on the width.
    if (minimal) {
      const amberSegs = visSegs.filter(d => d.cat === 'GELB' || d.cat === 'ROTGELB');
      svg.append('g').attr('class', 'seg-amber-slash').selectAll('line')
        .data(amberSegs).join('line')
        .attr('x1', d => x(Math.max(d.start, wMin))).attr('y1', height - segInset)
        .attr('x2', d => x(Math.min(d.end, wMax))).attr('y2', segInset)
        .style('pointer-events', 'none');
    }

    // The time grid is ABOVE the segments (not behind them).
    // Otherwise it would be invisible under fully opaque fills (for example GRUEN).
    // It is thin and light enough not to compete with the segment content.
    if (gridStepMs) {
      const gridTicks = [];
      const first = Math.ceil(wMin / gridStepMs) * gridStepMs;
      for (let t = first; t <= wMax; t += gridStepMs) gridTicks.push(t);
      svg.append('g').attr('class', 'lane-grid').selectAll('line')
        .data(gridTicks).join('line')
        .attr('x1', d => x(d)).attr('x2', d => x(d)).attr('y1', 0).attr('y2', height)
        .style('pointer-events', 'none');
    }

    // Two labels at the segment edge and not one centered label (see the header comment of
    // edgeLabelsFor).
    // An example is the An and Ab seconds of a green time directly on the bar.
    // If the segment is too narrow, both labels stay at their outer edges. They are never hidden.
    // This is the same idea as segLabelFor.
    // "Too narrow" means: the estimated text width of both labels plus the minimum gap is larger
    // than the segment width.
    // In addition, a small divider in the middle shows that the labels are squeezed together.
    // The code does not let the two numbers run into each other without a sign.
    if (edgeLabelsFor) {
      const CHAR_W = 5.4; // About 0.6 * 9px font size (var(--mono)), a rough estimate
      const PAD = 3, GAP = 6, MARKER_W = 6;
      // labels.left and labels.right are each optional (null or undefined = no edge label on this
      // side).
      // An example is a segment that extends past the visible time section.
      // The caller then knows only the edge that is REALLY here
      // (see the header comment of edgeLabelsFor in umlaufpruefung.js about green times that extend
      // past cycle borders).
      // The caller can simply omit the other label.
      // It must not show a value that belongs to a completely different (neighbor) segment.
      const edgeData = visSegs.map(d => {
        const labels = edgeLabelsFor(d);
        if (!labels) return null;
        const hasLeft = labels.left != null, hasRight = labels.right != null;
        if (!hasLeft && !hasRight) return null;
        const x0 = x(Math.max(d.start, wMin)), x1 = x(Math.min(d.end, wMax));
        const segW = x1 - x0;
        const leftW = hasLeft ? String(labels.left).length * CHAR_W : 0;
        const rightW = hasRight ? String(labels.right).length * CHAR_W : 0;
        // "Tight, but readable" (marker in the middle) versus "so tight that even the marker itself
        // would only overlap more".
        // In the second case, it is better to show NO marker than to squeeze three characters into
        // each other.
        // The two numbers stay visible in all cases, also when they touch or overlap.
        // This is relevant only if BOTH sides have a label.
        // With only one label there are no two numbers that can collide.
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
        .text('·'); // Middle dot (U+00B7) and not "⋯" (U+22EF).
        // The second one is missing in common monospace fonts (empty glyph, see var(--mono)). It
        // stayed invisible.
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

    // onSegClick (general, EVERY segment) and onGreenClick (only GRUEN, with the "pin" edge marker
    // for the manual measurement)
    // share the same D3 'click' handler.
    // They do not overwrite each other with two .on('click', ...) calls.
    // D3 keeps only ONE handler for each event type and selection, without a namespace.
    if (onGreenClick || onSegClick) {
      segSel.on('click', function (event, d) {
        if (onGreenClick && d.cat === 'GRUEN') {
          svg.selectAll('rect.seg-GRUEN').classed('pinned', false).style('stroke', null).style('stroke-width', null);
          d3.select(this).classed('pinned', true).style('stroke', 'var(--accent)').style('stroke-width', 2);
          onGreenClick(d);
        }
        if (onSegClick) onSegClick(d, event);
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

    // endMarks: solid marker lines (not dashed, to tell them from cycle marks and SPL marks) for a
    // fixed point in time
    // (for example the end of a phase transition in the PÜ tool).
    // See the header comment about opts above.
    svg.append('g').attr('class', 'end-marks').selectAll('line')
      .data(endMarks.filter(m => m.t >= wMin && m.t <= wMax)).join('line')
      .attr('x1', d => x(d.t)).attr('x2', d => x(d.t)).attr('y1', 0).attr('y2', height)
      .style('stroke', 'var(--accent)').style('stroke-width', 1.5)
      .append('title').text(d => d.label || fmtTimeShort(d.t));

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

    // Draw the formula highlight LAST (above everything else),
    // so that the coloring stays visible also on fully filled segments (for example GRUEN).
    // Draw a border line only if the row contains the real interval edge (start/end >= wMin / <=
    // wMax).
    // Otherwise a false border appears at the row edge, although the interval really continues
    // there.
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

  // The time axis is its own small D3 axis (the x scale is the same as for the tracks).
  // stepMs (optional): a fixed tick step (for example 5000 = every 5 s).
  //   The ticks are a plain number of seconds relative to wMin/wMax=0, not a time of day.
  //   This is for short, local time windows (for example the PÜ tool),
  //   where fmtTimeShort() (time-of-day format) makes no sense.
  //   Without stepMs, the axis stays as before:
  //   a 6-part division of the visible range with times of day (signal time chart and others).
  // markMs (optional, useful only with stepMs): the same marker line as endMarks of renderLane(),
  // here on the axis row itself.
  //   So the end marker in the PÜ tool stays visible also with no visible row (for example with
  //   "Keine Daten").
  function renderTimeAxis(svgEl, wMin, wMax, stepMs, markMs) {
    const width = svgEl.clientWidth, height = svgEl.clientHeight;
    if (!width || !height) return false;
    const x = d3.scaleLinear().domain([wMin, wMax]).range([0, width]);
    const svg = d3.select(svgEl).attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'none');
    svg.selectAll('*').remove();
    const g = svg.append('g').attr('class', 'd3-axis-x');
    if (stepMs) {
      const first = Math.ceil(wMin / stepMs) * stepMs;
      for (let t = first; t <= wMax; t += stepMs) {
        const px = x(t);
        const anchor = px < 12 ? 'start' : (px > width - 12 ? 'end' : 'middle');
        g.append('text').attr('x', px).attr('y', height - 2).attr('text-anchor', anchor).text(String(Math.round(t / 1000)));
      }
      if (markMs != null && markMs >= wMin && markMs <= wMax) {
        svg.append('line').attr('class', 'end-marks')
          .attr('x1', x(markMs)).attr('x2', x(markMs)).attr('y1', 0).attr('y2', height)
          .style('stroke', 'var(--accent)').style('stroke-width', 1.5);
      }
      return true;
    }
    const n = 6;
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
