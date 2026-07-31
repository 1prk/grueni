/* GZ.charts.phaseDurationChart — "Phasendauer pro Umlauf": gruppiertes
   Balkendiagramm, ein Balken je Phase und Umlauf, um die Dauer der Phasen
   umlaufweise zu vergleichen (statt eines Zeitverlauf-Streudiagramms - bei
   Phasen ist der Bezug zum Umlauf aussagekräftiger als der reine Zeitpunkt). */
(function (GZ) {
  'use strict';

  // opts: {umlaufNumbers:number[], phases:[{id,label,color}],
  //   durationsByPhase: Map(phaseId -> number[] parallel zu umlaufNumbers),
  //   onBarClick(phaseId, umlaufIdxInWindow)}
  function render(chartBoxEl, axisEl, opts) {
    const svgEl = chartBoxEl.querySelector('svg');
    const tooltipEl = chartBoxEl.querySelector('.chart-tooltip');
    const width = svgEl.clientWidth, height = svgEl.clientHeight;
    if (!width || !height) return false;
    const svg = d3.select(svgEl).attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'none');
    svg.selectAll('*').remove();

    const { umlaufNumbers, phases, durationsByPhase, onBarClick } = opts;
    if (!umlaufNumbers.length || !phases.length) return true;

    let maxDur = 0;
    phases.forEach(p => (durationsByPhase.get(p.id) || []).forEach(v => { if (v > maxDur) maxDur = v; }));
    if (maxDur === 0) maxDur = 10;

    const x0 = d3.scaleBand().domain(umlaufNumbers.map(String)).range([0, width]).paddingInner(0.3).paddingOuter(0.15);
    const x1 = d3.scaleBand().domain(phases.map(p => p.id)).range([0, x0.bandwidth()]).padding(0.12);
    const y = d3.scaleLinear().domain([0, maxDur * 1.12]).range([height, 0]);

    const gridG = svg.append('g').attr('class', 'grid');
    const nTicksY = 4;
    for (let i = 0; i <= nTicksY; i++) {
      const v = maxDur * 1.12 * i / nTicksY;
      gridG.append('line').attr('class', 'd3-gridline').attr('x1', 0).attr('x2', width).attr('y1', y(v)).attr('y2', y(v));
    }

    const tooltip = GZ.charts.tooltipHelper.attach(chartBoxEl, tooltipEl);
    const barsData = [];
    umlaufNumbers.forEach((num, idx) => {
      phases.forEach(p => {
        const v = (durationsByPhase.get(p.id) || [])[idx] || 0;
        barsData.push({ num, idx, phase: p, v });
      });
    });

    svg.append('g').attr('class', 'bars').selectAll('rect').data(barsData.filter(d => d.v > 0)).join('rect')
      .attr('x', d => x0(String(d.num)) + x1(d.phase.id))
      .attr('y', d => y(d.v))
      .attr('width', Math.max(x1.bandwidth(), 1))
      .attr('height', d => height - y(d.v))
      .style('fill', d => d.phase.color)
      .style('cursor', onBarClick ? 'pointer' : 'default')
      .on('mouseenter', function (evt, d) {
        tooltip.show(`<div>${d.phase.label}</div><div>Umlauf #${d.num}</div><div class="tt-dev">Dauer: ${d.v.toFixed(1)}s</div>`);
        tooltip.move(evt);
      })
      .on('mousemove', evt => tooltip.move(evt))
      .on('mouseleave', () => tooltip.hide())
      .on('click', (evt, d) => { if (onBarClick) onBarClick(d.phase.id, d.idx); });

    renderOrdinalAxis(axisEl, x0, umlaufNumbers);
    return true;
  }

  function renderOrdinalAxis(svgEl, x0, umlaufNumbers) {
    const width = svgEl.clientWidth, height = svgEl.clientHeight;
    if (!width || !height) return false;
    const svg = d3.select(svgEl).attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'none');
    svg.selectAll('*').remove();
    const g = svg.append('g').attr('class', 'd3-axis-x');
    // Bei vielen Umläufen im Fenster nicht jede Beschriftung zeichnen, sonst
    // überlappen sich die Labels.
    const maxLabels = Math.max(4, Math.floor(width / 42));
    const step = Math.max(1, Math.ceil(umlaufNumbers.length / maxLabels));
    umlaufNumbers.forEach((num, i) => {
      if (i % step !== 0 && i !== umlaufNumbers.length - 1) return;
      const cx = x0(String(num)) + x0.bandwidth() / 2;
      g.append('text').attr('x', cx).attr('y', height - 3).attr('text-anchor', 'middle').text('#' + num);
    });
    return true;
  }

  GZ.charts = GZ.charts || {};
  GZ.charts.phaseDurationChart = { render };
})(window.GZ = window.GZ || {});
