/* GZ.charts.oepnvScatterChart — ÖPNV-Anmeldungen im Zeitverlauf: Streudiagramm
   mit LOS-Referenzlinien (A-F) und eigenem Symbol für "abgemeldet ohne Grün". */
(function (GZ) {
  'use strict';
  const { fmtTimeShort, esc } = GZ.format;
  const { LOS_LEVELS, losStufe, txAtTime } = GZ.oepnvLogic;
  const { renderTimeAxis } = GZ.charts.timelineLane;

  const LOS_COLOR = { A: 'var(--los-a)', B: 'var(--los-b)', C: 'var(--los-c)', D: 'var(--los-d)', E: 'var(--los-e)', F: 'var(--los-f)' };
  const DENIED_COLOR = 'var(--sig-dark)';
  const EXCLUDED_COLOR = 'var(--text-faint)';
  const triangle = d3.symbol().type(d3.symbolTriangle).size(64);

  // data: {tMin, tMax, successEvents, deniedEvents, losBounds, splTransitions, cycleStarts, onPointClick(t)}
  function render(chartBoxEl, axisEl, data) {
    const svgEl = chartBoxEl.querySelector('svg');
    const tooltipEl = chartBoxEl.querySelector('.chart-tooltip');
    const width = svgEl.clientWidth, height = svgEl.clientHeight;
    if (!width || !height) return { rendered: false };
    const svg = d3.select(svgEl).attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'none');
    svg.selectAll('*').remove();

    const { tMin, tMax, successEvents, deniedEvents, losBounds, splTransitions, cycleStarts, onPointClick } = data;
    const maxWait = Math.max(
      successEvents.length ? Math.max(...successEvents.map(e => e.waitSec)) : 0,
      deniedEvents.length ? Math.max(...deniedEvents.map(e => e.waitSec)) : 0
    );
    const yMax = Math.max(losBounds[losBounds.length - 1] * 1.25, maxWait * 1.08, 20);
    const x = d3.scaleLinear().domain([tMin, tMax]).range([0, width]);
    const y = d3.scaleLinear().domain([0, yMax]).range([height, 0]);

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

    svg.append('g').attr('class', 'points').selectAll('circle').data(successEvents).join('circle')
      .attr('cx', d => x(d.reqTime)).attr('cy', d => y(Math.min(d.waitSec, yMax)))
      .attr('r', d => d.excluded ? 3.6 : (losStufe(d.waitSec, losBounds) === 'F' ? 5 : 4))
      .style('fill', d => d.excluded ? EXCLUDED_COLOR : LOS_COLOR[losStufe(d.waitSec, losBounds)])
      .style('opacity', d => d.excluded ? .55 : 1)
      .style('stroke', '#fff').style('stroke-width', 1)
      .style('cursor', onPointClick ? 'pointer' : 'default')
      .on('mouseenter', function (evt, d) {
        const tx = txAtTime(d.reqTime, cycleStarts);
        const status = d.excluded ? `ausgeschlossen (SPL ${esc(d.spl)})` : `LOS ${losStufe(d.waitSec, losBounds)}`;
        tooltip.show(`<div>Anmeldung ${fmtTimeShort(d.reqTime)} (TX ${tx ?? '–'})</div><div>Wartezeit: ${d.waitSec.toFixed(1)}s</div><div class="tt-dev">${status}</div>`);
        tooltip.move(evt);
      })
      .on('mousemove', evt => tooltip.move(evt))
      .on('mouseleave', () => tooltip.hide())
      .on('click', (evt, d) => { if (onPointClick) onPointClick(d.reqTime); });

    svg.append('g').attr('class', 'points-denied').selectAll('path').data(deniedEvents).join('path')
      .attr('d', triangle)
      .attr('transform', d => `translate(${x(d.reqTime)},${y(Math.min(d.waitSec, yMax))})`)
      .style('fill', d => d.excluded ? EXCLUDED_COLOR : DENIED_COLOR)
      .style('opacity', d => d.excluded ? .55 : 1)
      .style('stroke', '#fff').style('stroke-width', 1)
      .style('cursor', onPointClick ? 'pointer' : 'default')
      .on('mouseenter', function (evt, d) {
        const tx = txAtTime(d.reqTime, cycleStarts);
        const status = d.excluded ? `ausgeschlossen (SPL ${esc(d.spl)})` : 'abgemeldet ohne Grün';
        tooltip.show(`<div>Anmeldung ${fmtTimeShort(d.reqTime)} (TX ${tx ?? '–'})</div><div>Anmeldedauer: ${d.waitSec.toFixed(1)}s</div><div class="tt-dev">${status}</div>`);
        tooltip.move(evt);
      })
      .on('mousemove', evt => tooltip.move(evt))
      .on('mouseleave', () => tooltip.hide())
      .on('click', (evt, d) => { if (onPointClick) onPointClick(d.reqTime); });

    renderTimeAxis(axisEl, tMin, tMax);
    return { rendered: true, yMax };
  }

  GZ.charts.oepnvScatterChart = { render };
})(window.GZ = window.GZ || {});
