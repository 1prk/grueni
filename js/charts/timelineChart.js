/* GZ.charts.timelineChart — komplettes Signalzeitendiagramm: Programmleiste
   (SPL), eine Spur je Signalgruppe (via timelineLane) und die gemeinsame
   Zeitachse. Baut die Spuren-Zeilen (Label/An/Ab/TF/Track) bei jedem Render
   neu auf - Datengrößen sind klein genug, dass Diffing keinen Mehrwert bringt. */
(function (GZ) {
  'use strict';
  const { fmtTimeShort, esc } = GZ.format;
  const { computeSplTransitions, computeSignalplanRow, computeSegmentAnAbTf } = GZ.segments;
  const { renderLane, renderTimeAxis } = GZ.charts.timelineLane;

  function renderSplBar(svgEl, wMin, wMax, times, splValues) {
    const width = svgEl.clientWidth, height = svgEl.clientHeight;
    if (!width || !height) return false;
    const svg = d3.select(svgEl).attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'none');
    svg.selectAll('*').remove();
    if (!times || !splValues || !times.length) return true;
    const x = d3.scaleLinear().domain([wMin, wMax]).range([0, width]);

    let activeSpl = '';
    for (let i = 0; i < times.length; i++) {
      if (times[i] > wMin) break;
      if (splValues[i] !== '') activeSpl = splValues[i];
    }
    const transitions = computeSplTransitions(times, splValues).filter(tr => tr.t > wMin && tr.t <= wMax);
    const bounds = [wMin, ...transitions.map(tr => tr.t), wMax];
    const values = [activeSpl, ...transitions.map(tr => tr.to)];

    const segs = values.map((v, i) => ({ start: bounds[i], end: bounds[i + 1], v, tint: i % 2 === 1 }));
    svg.selectAll('rect.tint').data(segs.filter(s => s.tint)).join('rect')
      .attr('x', d => x(d.start)).attr('y', 0)
      .attr('width', d => Math.max(x(d.end) - x(d.start), 0)).attr('height', height)
      .style('fill', 'var(--req-marker-bg)');

    svg.selectAll('text.spl-label').data(segs).join('text')
      .attr('class', 'spl-label')
      .attr('x', d => x(d.start) + 4).attr('y', height / 2 + 3.5)
      .style('font-family', 'var(--mono)').style('font-size', '9.5px').style('fill', 'var(--text-muted)')
      .text(d => d.v !== '' ? `SPL ${d.v}` : 'SPL –')
      .append('title').text(d => `${d.v !== '' ? 'SPL ' + d.v : 'SPL –'}: ${fmtTimeShort(d.start)}–${fmtTimeShort(d.end)}`);

    svg.selectAll('line.trans').data(transitions).join('line')
      .attr('x1', d => x(d.t)).attr('x2', d => x(d.t)).attr('y1', 0).attr('y2', height)
      .style('stroke', 'var(--req-marker)').style('stroke-dasharray', '3,2').style('stroke-width', 1)
      .append('title').text(d => `Signalprogrammwechsel ${fmtTimeShort(d.t)}: SPL ${esc(d.from)} → ${esc(d.to)}`);
    return true;
  }

  // ctx: {allStats, wMin, wMax, cycleStarts, times, splValues, TU, selectedIdx,
  //   reqPointsByCol(colIndex)->[{t,unresolved}], anomalyBandsFor(stats)->[{start,end}],
  //   onGreenClick(rowIdx, an, ab, tf)}
  function render(els, ctx) {
    const { allStats, wMin, wMax, cycleStarts, times, splValues, TU } = ctx;
    const range = (wMax - wMin) || 1;
    const marks = (cycleStarts || []).filter(t => t >= wMin && t <= wMax);
    const splMarksRaw = (times && splValues) ? computeSplTransitions(times, splValues) : [];

    els.timelineEl.innerHTML = allStats.map((entry, i) => `
      <div class="lane-row" data-idx="${i}">
        <div class="lane-name" title="${esc((entry.col.beschreibung && entry.col.beschreibung !== entry.col.name) ? entry.col.beschreibung : '')}">${esc(entry.col.name)}</div>
        <div class="lane-num" data-field="an">–</div>
        <div class="lane-num" data-field="ab">–</div>
        <div class="lane-num" data-field="tf">–</div>
        <div class="lane-track" data-idx="${i}"><svg></svg></div>
      </div>`).join('');

    allStats.forEach((entry, i) => {
      const { col, segs, stats } = entry;
      const row = els.timelineEl.querySelector(`.lane-row[data-idx="${i}"]`);
      const track = row.querySelector('.lane-track');
      const svgEl = track.querySelector('svg');
      const planRow = TU ? computeSignalplanRow(segs, cycleStarts, TU) : null;
      if (planRow) {
        row.querySelector('[data-field="an"]').textContent = planRow.an;
        row.querySelector('[data-field="ab"]').textContent = planRow.ab;
        row.querySelector('[data-field="tf"]').textContent = planRow.tf;
      }
      if (i === ctx.selectedIdx) track.classList.add('highlight');

      const anomalyBands = ctx.anomalyBandsFor ? ctx.anomalyBandsFor(entry) : [];
      const reqPoints = ctx.reqPointsFor ? ctx.reqPointsFor(col) : [];

      renderLane(svgEl, {
        wMin, wMax, segs, cycleMarks: marks, splMarks: splMarksRaw, anomalyBands, reqPoints,
        onGreenClick: TU ? (seg) => {
          const anAbTf = computeSegmentAnAbTf(seg, cycleStarts, TU);
          if (!anAbTf) return;
          ['an', 'ab', 'tf'].forEach(f => {
            const el = row.querySelector(`[data-field="${f}"]`);
            el.textContent = anAbTf[f];
            el.classList.add('flash');
            setTimeout(() => el.classList.remove('flash'), 500);
          });
          if (ctx.onGreenClick) ctx.onGreenClick(i, anAbTf);
        } : null
      });
    });

    renderSplBar(els.splBarSvgEl, wMin, wMax, times, splValues);
    renderTimeAxis(els.axisSvgEl, wMin, wMax);
  }

  GZ.charts.timelineChart = { render, renderSplBar };
})(window.GZ = window.GZ || {});
