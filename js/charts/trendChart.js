/* GZ.charts.trendChart — Grünzeit-Trend je Zyklus: Zeitverlauf-Streudiagramm
   (Abweichungsklassen wie im Signalzeitendiagramm) und Verteilung als CDF-Kurve. */
(function (GZ) {
  'use strict';
  const { fmtTimeShort, esc } = GZ.format;
  const { median, percentile, countLessOrEqual } = GZ.stats;
  const { renderTimeAxis } = GZ.charts.timelineLane;

  const DEV_LABEL = { '': 'unauffällig', mild: 'leichte Abweichung', mod: 'mittlere Abweichung', hi: 'auffällig' };
  const colorFor = dc => dc === 'hi' ? 'var(--sig-red)' : dc === 'mod' ? 'var(--sig-redyellow)' : dc === 'mild' ? 'var(--sig-yellow)' : 'var(--sig-green)';
  const radiusFor = dc => dc === 'hi' ? 4.4 : dc === 'mod' ? 3.8 : dc === 'mild' ? 3.3 : 3;

  // data: {tMin, tMax, greens, gd, med, threshHi, threshLo, splWindows,
  //   splTransitions, onPointClick(t)}
  function renderScatter(chartBoxEl, axisEl, data) {
    const svgEl = chartBoxEl.querySelector('svg');
    const tooltipEl = chartBoxEl.querySelector('.chart-tooltip');
    const width = svgEl.clientWidth, height = svgEl.clientHeight;
    if (!width || !height) return false;
    const svg = d3.select(svgEl).attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'none');
    svg.selectAll('*').remove();

    const { tMin, tMax, greens, gd, med, threshHi, threshLo, splWindows, splTransitions, onPointClick } = data;
    if (!gd.length) { renderTimeAxis(axisEl, tMin, tMax); return true; }

    const madVal = median(gd.map(v => Math.abs(v - med))) || 0.001;
    const yMax = Math.max(Math.max(...gd), threshHi) * 1.08 || 1;
    const x = d3.scaleLinear().domain([tMin, tMax]).range([0, width]);
    const y = d3.scaleLinear().domain([0, yMax]).range([height, 0]);

    const windowFor = t => {
      if (!splWindows || !splWindows.length) return null;
      return splWindows.find(w => t >= w.segStart && t < w.segEnd) || splWindows[splWindows.length - 1];
    };

    const refG = svg.append('g').attr('class', 'ref-lines');
    if (splWindows && splWindows.length) {
      splWindows.forEach(w => {
        if (w.med == null) return;
        const x0 = x(Math.max(w.segStart, tMin)), x1 = x(Math.min(w.segEnd, tMax));
        refG.append('line').attr('x1', x0).attr('x2', x1).attr('y1', y(w.med)).attr('y2', y(w.med))
          .attr('class', 'd3-ref-line').style('stroke', 'var(--accent)').style('stroke-width', 1.4);
        refG.append('text').attr('x', x0 + 3).attr('y', y(w.med) - 4).attr('class', 'd3-ref-label')
          .style('fill', 'var(--accent-strong)')
          .text(`${w.spl === '(unbekannt)' ? 'SPL unbekannt' : 'SPL ' + w.spl} · Median ${w.med.toFixed(1)}s`);
      });
    } else {
      // Bei sehr geringer Streuung (z. B. Festzeitprogramme) liegen Median-
      // und Auffällig-Schwellen fast auf derselben Höhe - Beschriftungen
      // oberhalb/unterhalb der jeweiligen Linie versetzen, damit sie nicht
      // ineinander verschmelzen.
      const medY = y(med);
      refG.append('line').attr('x1', 0).attr('x2', width).attr('y1', medY).attr('y2', medY)
        .attr('class', 'd3-ref-line').style('stroke', 'var(--accent)').style('stroke-width', 1.4);
      refG.append('text').attr('x', 4).attr('y', medY - 4).attr('class', 'd3-ref-label').text(`Median ${med.toFixed(1)}s`);
      if (threshHi < yMax) {
        const hiY = y(threshHi);
        const labelY = Math.abs(hiY - medY) < 11 ? hiY + 12 : hiY - 4;
        refG.append('line').attr('x1', 0).attr('x2', width).attr('y1', hiY).attr('y2', hiY).attr('class', 'd3-ref-line').style('stroke', 'var(--text-faint)');
        refG.append('text').attr('x', 4).attr('y', labelY).attr('class', 'd3-ref-label').text(`Auffällig ab ${threshHi.toFixed(0)}s`);
      }
      if (threshLo > 0) {
        const loY = y(threshLo);
        const labelY = Math.abs(loY - medY) < 11 ? loY + 12 : loY - 4;
        refG.append('line').attr('x1', 0).attr('x2', width).attr('y1', loY).attr('y2', loY).attr('class', 'd3-ref-line').style('stroke', 'var(--text-faint)');
        refG.append('text').attr('x', 4).attr('y', labelY).attr('class', 'd3-ref-label').text(`Auffällig unter ${threshLo.toFixed(0)}s`);
      }
    }

    if (splTransitions && splTransitions.length) {
      const divG = svg.append('g').attr('class', 'spl-dividers');
      splTransitions.forEach(tr => {
        const px = x(tr.t);
        divG.append('line').attr('x1', px).attr('x2', px).attr('y1', 0).attr('y2', height)
          .style('stroke', 'var(--req-marker)').style('stroke-dasharray', '3,2').style('stroke-width', 1)
          .append('title').text(`Signalprogrammwechsel ${fmtTimeShort(tr.t)}: SPL ${esc(tr.from)} → ${esc(tr.to)}`);
        divG.append('text').attr('x', px + 3).attr('y', 10).style('font-family', 'var(--mono)').style('font-size', '9px').style('fill', 'var(--req-marker)').text(tr.to);
      });
    }

    const pointsData = gd.map((v, i) => {
      const g = greens[i];
      const win = windowFor(g.start);
      const pMed = (win && win.med != null) ? win.med : med;
      const pMad = (win && win.madVal != null) ? win.madVal : madVal;
      const r = Math.abs(v - pMed) / (1.4826 * pMad);
      const dc = r > 3 ? 'hi' : r > 2 ? 'mod' : r > 1 ? 'mild' : '';
      return { i, t: g.start, v, dc, pMed, win };
    });

    const tooltip = GZ.charts.tooltipHelper.attach(chartBoxEl, tooltipEl);
    svg.append('g').attr('class', 'points').selectAll('circle').data(pointsData).join('circle')
      .attr('cx', d => x(d.t)).attr('cy', d => y(d.v)).attr('r', d => radiusFor(d.dc))
      .style('fill', d => colorFor(d.dc)).style('stroke', '#fff').style('stroke-width', 1)
      .style('cursor', onPointClick ? 'pointer' : 'default')
      .on('mouseenter', function (evt, d) {
        const label = d.win ? `Abw. vom Median (SPL ${esc(d.win.spl)}): ` : 'Abw. vom Median: ';
        const diff = d.v - d.pMed;
        tooltip.show(`<div>Zyklus ${d.i + 1} · ${fmtTimeShort(d.t)}</div><div>Grünzeit: ${d.v.toFixed(1)}s</div><div class="tt-dev">${label}${diff >= 0 ? '+' : ''}${diff.toFixed(1)}s</div><div>${d.dc ? '<span class="tt-flag">' + DEV_LABEL[d.dc] + '</span>' : DEV_LABEL['']}</div>`);
        tooltip.move(evt);
      })
      .on('mousemove', evt => tooltip.move(evt))
      .on('mouseleave', () => tooltip.hide())
      .on('click', (evt, d) => { if (onPointClick) onPointClick(d.t); });

    renderTimeAxis(axisEl, tMin, tMax);
    return true;
  }

  function renderValueAxis(svgEl, min, max, unit) {
    const width = svgEl.clientWidth, height = svgEl.clientHeight;
    if (!width || !height) return false;
    const svg = d3.select(svgEl).attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'none');
    svg.selectAll('*').remove();
    const n = 5;
    const g = svg.append('g').attr('class', 'd3-axis-x');
    for (let i = 0; i <= n; i++) {
      const v = min + (max - min) * i / n;
      const px = width * i / n;
      const anchor = i === 0 ? 'start' : (i === n ? 'end' : 'middle');
      g.append('text').attr('x', px).attr('y', height - 3).attr('text-anchor', anchor).text(v.toFixed(0) + unit);
    }
    return true;
  }

  // data: {gd, threshHi, threshLo}
  function renderCdf(chartBoxEl, axisEl, data) {
    const svgEl = chartBoxEl.querySelector('svg');
    const tooltipEl = chartBoxEl.querySelector('.chart-tooltip');
    const width = svgEl.clientWidth, height = svgEl.clientHeight;
    if (!width || !height) return false;
    const svg = d3.select(svgEl).attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'none');
    svg.selectAll('*').remove();

    const { gd, threshHi, threshLo } = data;
    if (!gd.length) return true;
    const sorted = [...gd].sort((a, b) => a - b);
    const n = sorted.length;
    const min = sorted[0], max = sorted[n - 1], range = (max - min) || 1;
    const x = d3.scaleLinear().domain([min, max]).range([0, width]);
    const y = d3.scaleLinear().domain([0, 1]).range([height, 0]);

    const stepPoints = [[min, 0]];
    sorted.forEach((v, i) => { stepPoints.push([v, i / n]); stepPoints.push([v, (i + 1) / n]); });
    stepPoints.push([max, 1]);
    const lineGen = d3.line().x(d => x(d[0])).y(d => y(d[1]));
    const areaGen = d3.area().x(d => x(d[0])).y0(height).y1(d => y(d[1]));

    svg.append('path').attr('d', areaGen(stepPoints)).style('fill', 'var(--sig-green)').style('opacity', .09).style('stroke', 'none');
    svg.append('path').attr('d', lineGen(stepPoints)).style('fill', 'none').style('stroke', 'var(--sig-green)').style('stroke-width', 1.8);

    const guideG = svg.append('g').attr('class', 'guides');
    [50, 85, 95].forEach(p => {
      const val = percentile(sorted, p);
      guideG.append('line').attr('x1', x(val)).attr('x2', x(val)).attr('y1', 0).attr('y2', height)
        .style('stroke', 'rgba(0,0,0,.16)').style('stroke-dasharray', '2,2');
    });
    if (threshHi < max) {
      guideG.append('line').attr('x1', x(threshHi)).attr('x2', x(threshHi)).attr('y1', 0).attr('y2', height).style('stroke', 'rgba(194,42,42,.45)').style('stroke-dasharray', '2,2');
    }
    if (threshLo > min) {
      guideG.append('line').attr('x1', x(threshLo)).attr('x2', x(threshLo)).attr('y1', 0).attr('y2', height).style('stroke', 'rgba(194,42,42,.45)').style('stroke-dasharray', '2,2');
    }

    const crosshair = svg.append('g').attr('class', 'crosshair').style('display', 'none');
    const chLine = crosshair.append('line').attr('y1', 0).attr('y2', height).style('stroke', 'var(--accent)').style('stroke-width', 1);
    const chDot = crosshair.append('circle').attr('r', 4).style('fill', 'var(--accent)').style('stroke', '#fff').style('stroke-width', 1.5);

    const tooltip = GZ.charts.tooltipHelper.attach(chartBoxEl, tooltipEl);
    svg.append('rect').attr('x', 0).attr('y', 0).attr('width', width).attr('height', height).style('fill', 'transparent')
      .on('mousemove', function (evt) {
        const [mx] = d3.pointer(evt, svgEl);
        const xFrac = Math.min(Math.max(mx / width, 0), 1);
        const value = min + xFrac * range;
        const cnt = countLessOrEqual(sorted, value);
        const cumFrac = cnt / n;
        crosshair.style('display', null);
        chLine.attr('x1', mx).attr('x2', mx);
        chDot.attr('cx', mx).attr('cy', y(cumFrac));
        tooltip.show(`<div>Grünzeit ≈ ${value.toFixed(1)}s</div><div class="tt-dev">${(cumFrac * 100).toFixed(1)}% der Zyklen darunter</div><div>(${cnt} von ${n})</div>`);
        tooltip.move(evt);
      })
      .on('mouseleave', () => { crosshair.style('display', 'none'); tooltip.hide(); });

    renderValueAxis(axisEl, min, max, 's');
    return true;
  }

  GZ.charts.trendChart = { renderScatter, renderCdf, renderValueAxis };
})(window.GZ = window.GZ || {});
