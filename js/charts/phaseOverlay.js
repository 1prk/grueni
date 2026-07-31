/* GZ.charts.phaseOverlay — toggelbare Overlay-Ebene über dem gesamten
   Spuren-Stapel des Signalzeitendiagramms (Grünzeitanalyse): zeigt je
   sichtbarem Phasen-Vorkommen eine gestrichelte Klammer
   "┊----Ph2----┊" (linker/rechter Tick über die volle Höhe, Label oben),
   in derselben Farbe wie in der Phasenauswertung. Eigene SVG-Ebene, nicht
   Teil der einzelnen Spuren-SVGs - dadurch unabhängig von der Anzahl/
   Reihenfolge der Signalgruppen-Spuren. */
(function (GZ) {
  'use strict';
  const { fmtTimeShort } = GZ.format;

  const TOP_Y = 11;
  const ROW_STEP = 15; // vertikaler Versatz je Stufe, gegen Label-Kollisionen bei eng aufeinanderfolgenden Phasen

  // opts: {wMin, wMax, occEntries: [{phase, intervals, color}]}
  function render(svgEl, opts) {
    const width = svgEl.clientWidth, height = svgEl.clientHeight;
    if (!width || !height) return false;
    const svg = d3.select(svgEl).attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'none');
    svg.selectAll('*').remove();

    const { wMin, wMax, occEntries } = opts;
    const x = d3.scaleLinear().domain([wMin, wMax]).range([0, width]);

    const brackets = [];
    occEntries.forEach(({ phase, intervals, color }) => {
      intervals.forEach(iv => {
        if (iv.end <= wMin || iv.start >= wMax) return;
        brackets.push({ phase, color, cStart: Math.max(iv.start, wMin), cEnd: Math.min(iv.end, wMax), start: iv.start, end: iv.end });
      });
    });
    if (!brackets.length) return true;

    // Zeitlich sortieren und die Beschriftungshöhe zweistufig alternieren -
    // bei eng aufeinanderfolgenden Phasen (kaum Zwischenzeit) würden sich
    // sonst die Labels auf gleicher Höhe überlappen.
    brackets.sort((a, b) => a.cStart - b.cStart);
    brackets.forEach((d, i) => { d.labelY = TOP_Y + (i % 2) * ROW_STEP; });

    const groups = svg.append('g').attr('class', 'phase-overlay')
      .selectAll('g.bracket').data(brackets).join('g').attr('class', 'bracket');

    groups.append('line')
      .attr('x1', d => x(d.cStart)).attr('x2', d => x(d.cStart)).attr('y1', 0).attr('y2', height)
      .style('stroke', d => d.color).style('stroke-width', 1.4).style('stroke-dasharray', '4,3').style('opacity', .85);
    groups.append('line')
      .attr('x1', d => x(d.cEnd)).attr('x2', d => x(d.cEnd)).attr('y1', 0).attr('y2', height)
      .style('stroke', d => d.color).style('stroke-width', 1.4).style('stroke-dasharray', '4,3').style('opacity', .85);
    groups.append('line')
      .attr('x1', d => x(d.cStart)).attr('x2', d => x(d.cEnd)).attr('y1', d => d.labelY).attr('y2', d => d.labelY)
      .style('stroke', d => d.color).style('stroke-width', 1.4).style('stroke-dasharray', '4,3').style('opacity', .85);

    groups.append('title').text(d => {
      const label = d.phase.name && d.phase.name !== d.phase.kuerzel ? `${d.phase.kuerzel} – ${d.phase.name}` : d.phase.kuerzel;
      return `${label}: ${fmtTimeShort(d.start)}–${fmtTimeShort(d.end)}`;
    });

    // Label mittig auf der horizontalen Klammer, mit heller Hinterlegung
    // (per getBBox() passend zur tatsächlichen Textbreite) für Lesbarkeit
    // über farbigen Segmenten.
    const labelG = groups.append('g')
      .attr('transform', d => `translate(${(x(d.cStart) + x(d.cEnd)) / 2}, ${d.labelY})`);
    const labelText = labelG.append('text')
      .attr('text-anchor', 'middle').attr('dy', '.32em')
      .style('font-family', 'var(--mono)').style('font-size', '10px').style('font-weight', '700')
      .style('fill', d => d.color)
      .text(d => d.phase.kuerzel);
    labelText.each(function (d) {
      const bbox = this.getBBox();
      d3.select(this.parentNode).insert('rect', 'text')
        .attr('x', bbox.x - 4).attr('y', bbox.y - 2)
        .attr('width', bbox.width + 8).attr('height', bbox.height + 4)
        .attr('rx', 3)
        .style('fill', 'rgba(255,255,255,.92)').style('stroke', d.color).style('stroke-width', 1);
    });

    return true;
  }

  GZ.charts = GZ.charts || {};
  GZ.charts.phaseOverlay = { render };
})(window.GZ = window.GZ || {});
