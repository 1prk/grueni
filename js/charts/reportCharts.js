/* GZ.charts.report — small charts inside the report tables of the green time
   and wait time tabs: green time histogram, position in the cycle, share
   bar, small CDF. Each function returns an SVG element. */
(function (GZ) {
  'use strict';
  const { el, text, attachTooltip } = GZ.charts.kit;
  const { fmtNum } = GZ.format;

  const HIST_W = 360, HIST_H = 52;
  const LANE_W = 380, LANE_H = 30;
  const CDF_W = 300, CDF_H = 34;

  function newSvg(w, h) { return el('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` }, null); }

  // Number axis with labels at multiples of `step` (labels use the "s" unit).
  function axis(width, xMax, step, height) {
    const svg = newSvg(width, height);
    for (let v = 0; v <= xMax; v += step) {
      text(svg, v / xMax * width, height - 3, v + ' s', { 'text-anchor': v === 0 ? 'start' : (v + step > xMax ? 'end' : 'middle') });
    }
    return svg;
  }

  /* Green time histogram: one stacked bar per 1-second class, scaled to the
     highest class of the row. o = { xMax, stackKeys: [key], keyOf(green), colorOf(key), tipPrefix(key) } */
  function histogram(st, o) {
    const svg = newSvg(HIST_W, HIST_H);
    const x = v => v / o.xMax * HIST_W, barWidth = x(1);
    const gridStep = o.xMax > 100 ? 50 : 10;
    for (let v = gridStep; v < o.xMax; v += gridStep) el('line', { x1: x(v), x2: x(v), y1: 0, y2: HIST_H, stroke: 'var(--border)' }, svg);
    el('line', { x1: 0, x2: HIST_W, y1: HIST_H - .5, y2: HIST_H - .5, stroke: 'var(--border-strong)' }, svg);
    if (!st.n) return svg;
    const bins = new Map();
    st.gs.forEach(g => {
      const bin = Math.round(g.dur), key = o.keyOf(g);
      if (!bins.has(bin)) bins.set(bin, {});
      bins.get(bin)[key] = (bins.get(bin)[key] || 0) + 1;
    });
    let top = 0;
    bins.forEach(b => { top = Math.max(top, Object.values(b).reduce((p, q) => p + q, 0)); });
    bins.forEach((b, bin) => {
      let stacked = 0;
      o.stackKeys.forEach(key => {
        const count = b[key] || 0;
        if (!count) return;
        const h = count / top * (HIST_H - 3), yy = HIST_H - 1 - stacked - h;
        stacked += h;
        const r = el('rect', { x: x(bin - .5) + .5, y: yy, width: Math.max(barWidth - 1, 1), height: h, fill: o.colorOf(key) }, svg);
        attachTooltip(r, `Grünzeit ${bin} s${o.stackKeys.length > 1 ? ' · ' + o.tipPrefix(key) : ''}<br>${count} Umläufe (${fmtNum(count / st.n * 100, 1)} %)`);
      });
    });
    return svg;
  }

  /* Position of the green window in the cycle: light bar between the median
     start and median end, whiskers (P5–P95) at both edges, dashed line at the median
     cycle time. o = { xMax } */
  function lane(st, o) {
    const svg = newSvg(LANE_W, LANE_H);
    const x = v => v / o.xMax * LANE_W, cy = LANE_H / 2;
    for (let v = 10; v < o.xMax; v += (o.xMax > 100 ? 50 : 10)) el('line', { x1: x(v), x2: x(v), y1: 0, y2: LANE_H, stroke: 'var(--border)' }, svg);
    el('line', { x1: 0, x2: LANE_W, y1: LANE_H - .5, y2: LANE_H - .5, stroke: 'var(--border-strong)' }, svg);
    if (Number.isFinite(st.tuMed)) el('line', { x1: x(st.tuMed), x2: x(st.tuMed), y1: 0, y2: LANE_H, stroke: 'var(--text-faint)', 'stroke-dasharray': '3,2' }, svg);
    if (!Number.isFinite(st.onMed)) return svg;
    const bar = el('rect', { x: x(st.onMed), y: cy - 6, width: Math.max(x(st.offMed) - x(st.onMed), 1), height: 12, fill: 'var(--sig-green)', opacity: .35 }, svg);
    const edge = (med, lo, hi) => {
      el('line', { x1: x(lo), x2: x(hi), y1: cy, y2: cy, stroke: 'var(--text)', 'stroke-width': 1.3 }, svg);
      if (hi > lo) {
        el('line', { x1: x(lo), x2: x(lo), y1: cy - 5, y2: cy + 5, stroke: 'var(--text)', 'stroke-width': 1.3 }, svg);
        el('line', { x1: x(hi), x2: x(hi), y1: cy - 5, y2: cy + 5, stroke: 'var(--text)', 'stroke-width': 1.3 }, svg);
      }
      el('line', { x1: x(med), x2: x(med), y1: cy - 8, y2: cy + 8, stroke: 'var(--sig-green)', 'stroke-width': 2.4 }, svg);
    };
    edge(st.onMed, st.onLo, st.onHi);
    edge(st.offMed, st.offLo, st.offHi);
    attachTooltip(bar, `An ${fmtNum(st.onMed)} s [${fmtNum(st.onLo)}–${fmtNum(st.onHi)}]<br>Ab ${fmtNum(st.offMed)} s [${fmtNum(st.offLo)}–${fmtNum(st.offHi)}]`);
    return svg;
  }

  function shareBar(fraction) {
    const w = 130, svg = newSvg(w, 12);
    el('rect', { x: 0, y: 2, width: w, height: 8, fill: 'var(--bg-surface-3)' }, svg);
    el('rect', { x: 0, y: 2, width: w * fraction, height: 8, fill: 'var(--sig-green)' }, svg);
    return svg;
  }

  /* Small CDF of wait times with warning (yellow) and limit (red) marks.
     o = { xMax, warn, limit } */
  function miniCdf(values, o) {
    const svg = newSvg(CDF_W, CDF_H);
    const x = v => Math.min(v, o.xMax) / o.xMax * CDF_W, y = f => CDF_H - 2 - f * (CDF_H - 6);
    const grid = o.xMax > 200 ? 100 : 40;
    for (let v = grid; v < o.xMax; v += grid) el('line', { x1: x(v), x2: x(v), y1: 0, y2: CDF_H, stroke: 'var(--border)' }, svg);
    el('line', { x1: 0, x2: CDF_W, y1: CDF_H - .5, y2: CDF_H - .5, stroke: 'var(--border-strong)' }, svg);
    if (!values.length) return svg;
    if (o.warn != null) el('line', { x1: x(o.warn), x2: x(o.warn), y1: 0, y2: CDF_H, stroke: 'var(--sig-yellow)', 'stroke-width': 1.4 }, svg);
    el('line', { x1: x(o.limit), x2: x(o.limit), y1: 0, y2: CDF_H, stroke: 'var(--sig-red)', 'stroke-width': 1.4 }, svg);
    const sorted = [...values].sort((p, q) => p - q), n = sorted.length;
    let d = `M0,${y(0)}`;
    sorted.forEach((v, i) => { d += `H${x(v)}V${y((i + 1) / n)}`; });
    el('path', { d: d + `H${CDF_W}`, fill: 'none', stroke: 'var(--sig-green)', 'stroke-width': 1.7 }, svg);
    return svg;
  }

  GZ.charts.report = { HIST_W, LANE_W, CDF_W, axis, histogram, lane, shareBar, miniCdf };
})(window.GZ = window.GZ || {});
