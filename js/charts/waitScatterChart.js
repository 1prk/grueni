/* GZ.charts.waitScatterChart — Wartezeit-Ereignisse im Zeitverlauf
   (Wartezeit ab Anforderung): Streudiagramm mit Warn-/Grenzwertlinien. */
(function (GZ) {
  'use strict';
  const { fmtTimeShort, esc } = GZ.format;
  const { qualitaetsstufe, WZ_QUAL_LABEL, txAtTime } = GZ.wartezeitLogic;
  const { renderTimeAxis } = GZ.charts.timelineLane;

  const COLOR = { OK: 'var(--sig-green)', WARNUNG: 'var(--sig-yellow)', GRENZWERT: 'var(--sig-red)', excluded: 'var(--text-faint)' };

  // data: {tMin, tMax, events, warnSek, grenzSek, splTransitions, cycleStarts, onPointClick(t)}
  function render(chartBoxEl, axisEl, data) {
    const svgEl = chartBoxEl.querySelector('svg');
    const tooltipEl = chartBoxEl.querySelector('.chart-tooltip');
    const width = svgEl.clientWidth, height = svgEl.clientHeight;
    if (!width || !height) return { rendered: false };
    const svg = d3.select(svgEl).attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'none');
    svg.selectAll('*').remove();

    const { tMin, tMax, events, warnSek, grenzSek, splTransitions, cycleStarts, onPointClick } = data;
    const maxWait = events.length ? Math.max(...events.map(e => e.waitSec)) : 0;
    const yMax = Math.max(grenzSek * 1.25, maxWait * 1.08, 20);
    const x = d3.scaleLinear().domain([tMin, tMax]).range([0, width]);
    const y = d3.scaleLinear().domain([0, yMax]).range([height, 0]);

    const refG = svg.append('g').attr('class', 'ref-lines');
    if (warnSek != null && warnSek < yMax) {
      refG.append('line').attr('x1', 0).attr('x2', width).attr('y1', y(warnSek)).attr('y2', y(warnSek)).attr('class', 'd3-ref-line').style('stroke', 'var(--sig-yellow)');
      refG.append('text').attr('x', 4).attr('y', y(warnSek) - 4).attr('class', 'd3-ref-label').text(`Warnung ${warnSek}s`);
    }
    if (grenzSek < yMax) {
      refG.append('line').attr('x1', 0).attr('x2', width).attr('y1', y(grenzSek)).attr('y2', y(grenzSek)).attr('class', 'd3-ref-line').style('stroke', 'var(--sig-red)');
      refG.append('text').attr('x', 4).attr('y', y(grenzSek) - 4).attr('class', 'd3-ref-label').text(`Grenzwert ${grenzSek}s`);
    }

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
    svg.append('g').attr('class', 'points').selectAll('circle').data(events).join('circle')
      .attr('cx', d => x(d.reqTime)).attr('cy', d => y(Math.min(d.waitSec, yMax))).attr('r', d => d.excluded ? 3.6 : (qualitaetsstufe(d.waitSec, warnSek, grenzSek) === 'GRENZWERT' ? 5 : 4))
      .style('fill', d => d.excluded ? COLOR.excluded : COLOR[qualitaetsstufe(d.waitSec, warnSek, grenzSek)])
      .style('opacity', d => d.excluded ? .55 : 1)
      .style('stroke', '#fff').style('stroke-width', 1)
      .style('cursor', onPointClick ? 'pointer' : 'default')
      .on('mouseenter', function (evt, d) {
        const tx = txAtTime(d.reqTime, cycleStarts);
        const status = d.excluded ? `ausgeschlossen (SPL ${esc(d.spl)})` : WZ_QUAL_LABEL[qualitaetsstufe(d.waitSec, warnSek, grenzSek)];
        tooltip.show(`<div>Anforderung ${fmtTimeShort(d.reqTime)} (TX ${tx ?? '–'})</div><div>Wartezeit: ${d.waitSec.toFixed(1)}s</div><div class="tt-dev">${status}</div>`);
        tooltip.move(evt);
      })
      .on('mousemove', evt => tooltip.move(evt))
      .on('mouseleave', () => tooltip.hide())
      .on('click', (evt, d) => { if (onPointClick) onPointClick(d.reqTime); });

    renderTimeAxis(axisEl, tMin, tMax);
    return { rendered: true, yMax };
  }

  GZ.charts.waitScatterChart = { render };
})(window.GZ = window.GZ || {});
