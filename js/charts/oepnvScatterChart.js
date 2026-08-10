/* GZ.charts.oepnvScatterChart — ÖPNV-Anmeldungen im Zeitverlauf: Streudiagramm
   der Verlustzeit (Ist-Fahrzeit An->Ab minus Sollfahrzeit) mit LOS-
   Referenzlinien (A-F) und eigenem Symbol für Zwangslöschungen (keine
   Abmeldung innerhalb der Zwangslöschzeit erhalten). */
(function (GZ) {
  'use strict';
  const { fmtTimeShort, esc } = GZ.format;
  const { LOS_LEVELS, losStufe, txAtTime } = GZ.oepnvLogic;
  const { renderTimeAxis } = GZ.charts.timelineLane;

  const LOS_COLOR = { A: 'var(--los-a)', B: 'var(--los-b)', C: 'var(--los-c)', D: 'var(--los-d)', E: 'var(--los-e)', F: 'var(--los-f)' };
  const DENIED_COLOR = 'var(--sig-dark)';
  const EXCLUDED_COLOR = 'var(--text-faint)';
  const triangle = d3.symbol().type(d3.symbolTriangle).size(64);

  // data: {tMin, tMax, abmeldungEvents, zwangsgeloeschtEvents, losBounds, splTransitions, cycleStarts, onPointClick(t)}
  function render(chartBoxEl, axisEl, data) {
    const svgEl = chartBoxEl.querySelector('svg');
    const tooltipEl = chartBoxEl.querySelector('.chart-tooltip');
    const width = svgEl.clientWidth, height = svgEl.clientHeight;
    if (!width || !height) return { rendered: false };
    const svg = d3.select(svgEl).attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'none');
    svg.selectAll('*').remove();

    const { tMin, tMax, abmeldungEvents, zwangsgeloeschtEvents, losBounds, splTransitions, cycleStarts, onPointClick } = data;
    const allVerlust = abmeldungEvents.concat(zwangsgeloeschtEvents).map(e => e.verlustSek);
    const maxVerlust = allVerlust.length ? Math.max(...allVerlust) : 0;
    const minVerlust = allVerlust.length ? Math.min(...allVerlust) : 0;
    const yMax = Math.max(losBounds[losBounds.length - 1] * 1.25, maxVerlust * 1.08, 20);
    const yMin = Math.min(0, minVerlust * 1.08);
    const x = d3.scaleLinear().domain([tMin, tMax]).range([0, width]);
    const y = d3.scaleLinear().domain([yMin, yMax]).range([height, 0]);

    if (yMin < 0) {
      svg.append('line').attr('x1', 0).attr('x2', width).attr('y1', y(0)).attr('y2', y(0)).attr('class', 'd3-gridline');
    }

    const refG = svg.append('g').attr('class', 'ref-lines');
    losBounds.forEach((bound, i) => {
      if (bound >= yMax) return;
      refG.append('line').attr('x1', 0).attr('x2', width).attr('y1', y(bound)).attr('y2', y(bound))
        .attr('class', 'd3-ref-line').style('stroke', LOS_COLOR[LOS_LEVELS[i + 1]]);
      refG.append('text').attr('x', 4).attr('y', y(bound) - 4).attr('class', 'd3-ref-label')
        .text(`LOS ${LOS_LEVELS[i + 1]} ab ${bound}s`);
    });

    if (splTransitions && splTransitions.length) {
      const divG = svg.append('g').attr('class', 'spl-dividers');
      splTransitions.filter(tr => tr.t >= tMin && tr.t <= tMax).forEach(tr => {
        const px = x(tr.t);
        divG.append('line').attr('x1', px).attr('x2', px).attr('y1', 0).attr('y2', height)
          .style('stroke', 'var(--req-marker)').style('stroke-dasharray', '3,2').style('stroke-width', 1)
          .append('title').text(`Signalprogrammwechsel ${fmtTimeShort(tr.t)}: SPL ${esc(tr.from)} → ${esc(tr.to)}`);
        divG.append('text').attr('x', px + 3).attr('y', 10).style('font-family', 'var(--mono)').style('font-size', '9px').style('fill', 'var(--req-marker)').text(tr.to);
      });
    }

    const tooltip = GZ.charts.tooltipHelper.attach(chartBoxEl, tooltipEl);
    const yPos = d => y(Math.min(Math.max(d.verlustSek, yMin), yMax));

    svg.append('g').attr('class', 'points').selectAll('circle').data(abmeldungEvents).join('circle')
      .attr('cx', d => x(d.anTime)).attr('cy', yPos)
      .attr('r', d => d.excluded ? 3.6 : (losStufe(d.verlustSek, losBounds) === 'F' ? 5 : 4))
      .style('fill', d => d.excluded ? EXCLUDED_COLOR : LOS_COLOR[losStufe(d.verlustSek, losBounds)])
      .style('opacity', d => d.excluded ? .55 : 1)
      .style('stroke', '#fff').style('stroke-width', 1)
      .style('cursor', onPointClick ? 'pointer' : 'default')
      .on('mouseenter', function (evt, d) {
        const tx = txAtTime(d.anTime, cycleStarts);
        const status = d.excluded ? `ausgeschlossen (SPL ${esc(d.spl)})` : `LOS ${losStufe(d.verlustSek, losBounds)}`;
        const sgLine = d.sgLabel ? `<div>${esc(d.sgLabel)}</div>` : '';
        tooltip.show(`${sgLine}<div>Anmeldung ${fmtTimeShort(d.anTime)} (TX ${tx ?? '–'})</div><div>Ist-Fahrzeit: ${d.istFahrzeitSek.toFixed(1)}s · Verlustzeit: ${d.verlustSek.toFixed(1)}s</div><div class="tt-dev">${status}</div>`);
        tooltip.move(evt);
      })
      .on('mousemove', evt => tooltip.move(evt))
      .on('mouseleave', () => tooltip.hide())
      .on('click', (evt, d) => { if (onPointClick) onPointClick(d.anTime); });

    svg.append('g').attr('class', 'points-denied').selectAll('path').data(zwangsgeloeschtEvents).join('path')
      .attr('d', triangle)
      .attr('transform', d => `translate(${x(d.anTime)},${yPos(d)})`)
      .style('fill', d => d.excluded ? EXCLUDED_COLOR : DENIED_COLOR)
      .style('opacity', d => d.excluded ? .55 : 1)
      .style('stroke', '#fff').style('stroke-width', 1)
      .style('cursor', onPointClick ? 'pointer' : 'default')
      .on('mouseenter', function (evt, d) {
        const tx = txAtTime(d.anTime, cycleStarts);
        const status = d.excluded ? `ausgeschlossen (SPL ${esc(d.spl)})` : 'zwangsgelöscht (keine Abmeldung)';
        const sgLine = d.sgLabel ? `<div>${esc(d.sgLabel)}</div>` : '';
        tooltip.show(`${sgLine}<div>Anmeldung ${fmtTimeShort(d.anTime)} (TX ${tx ?? '–'})</div><div>Zwangslöschung nach ${d.istFahrzeitSek.toFixed(1)}s · Verlustzeit ≥ ${d.verlustSek.toFixed(1)}s</div><div class="tt-dev">${status}</div>`);
        tooltip.move(evt);
      })
      .on('mousemove', evt => tooltip.move(evt))
      .on('mouseleave', () => tooltip.hide())
      .on('click', (evt, d) => { if (onPointClick) onPointClick(d.anTime); });

    renderTimeAxis(axisEl, tMin, tMax);
    return { rendered: true, yMax };
  }

  GZ.charts.oepnvScatterChart = { render };
})(window.GZ = window.GZ || {});
