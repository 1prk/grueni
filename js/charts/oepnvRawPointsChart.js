/* GZ.charts.oepnvRawPointsChart — Rohpunkte-Ansicht für den ÖPNV-Tab: zwei
   schmale Spuren (Anmeldung/Abmeldung) mit je einem Tick pro erkannter
   Detektorflanke auf gemeinsamer Zeitachse - unabhängig von der Anmeldung-
   /Abmeldung-Paarungslogik, zum schnellen Sichtprüfen der Rohdaten. */
(function (GZ) {
  'use strict';
  const { fmtTimeShort } = GZ.format;
  const { renderTimeAxis } = GZ.charts.timelineLane;

  function renderLaneTicks(svgEl, tMin, tMax, points, color) {
    const width = svgEl.clientWidth, height = svgEl.clientHeight;
    if (!width || !height) return;
    const svg = d3.select(svgEl).attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'none');
    svg.selectAll('*').remove();
    const x = d3.scaleLinear().domain([tMin, tMax]).range([0, width]);
    svg.append('g').selectAll('circle').data(points).join('circle')
      .attr('cx', d => x(d)).attr('cy', height / 2).attr('r', 3.6)
      .style('fill', color).style('stroke', '#fff').style('stroke-width', 1)
      .append('title').text(d => fmtTimeShort(d));
  }

  // data: {tMin, tMax, anTimes, abTimes}
  function render(anSvgEl, abSvgEl, axisEl, data) {
    const { tMin, tMax, anTimes, abTimes } = data;
    renderLaneTicks(anSvgEl, tMin, tMax, anTimes, 'var(--req-marker)');
    renderLaneTicks(abSvgEl, tMin, tMax, abTimes, 'var(--sig-dark)');
    renderTimeAxis(axisEl, tMin, tMax);
  }

  GZ.charts = GZ.charts || {};
  GZ.charts.oepnvRawPointsChart = { render };
})(window.GZ = window.GZ || {});
