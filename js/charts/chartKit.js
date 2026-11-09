/* GZ.charts.kit — drawing helpers for the report style charts of the green
   time and wait time tabs. Plain SVG, no d3. One generic time chart
   (`timeChart`) and one generic CDF chart (`cdfChart`) serve both tabs. */
(function (GZ) {
  'use strict';
  const { esc, pad } = GZ.format;

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function text(parent, x, y, str, attrs) {
    const e = el('text', Object.assign({ x, y }, attrs || {}), parent);
    e.textContent = str;
    return e;
  }
  function createSvg(host, width, height) {
    host.innerHTML = '';
    return el('svg', { width, height, viewBox: `0 0 ${width} ${height}` }, host);
  }
  const hostWidth = host => host.clientWidth || host.getBoundingClientRect().width || 900;

  /* ---------------- Tooltip (one shared element) ---------------- */
  function tooltipEl() {
    let t = document.getElementById('gzTooltip');
    if (!t) { t = document.createElement('div'); t.id = 'gzTooltip'; document.body.appendChild(t); }
    return t;
  }
  function showTooltip(evt, html, wide) {
    const t = tooltipEl();
    t.innerHTML = html;
    t.classList.toggle('wide', !!wide);
    t.style.display = 'block';
    const w = t.offsetWidth, h = t.offsetHeight;
    let left = evt.clientX + 12, top = evt.clientY + 12;
    if (left + w > window.innerWidth - 6) left = evt.clientX - w - 12;
    if (top + h > window.innerHeight - 6) top = evt.clientY - h - 12;
    t.style.left = Math.max(4, left) + 'px';
    t.style.top = Math.max(4, top) + 'px';
  }
  function hideTooltip() { tooltipEl().style.display = 'none'; }
  // html: string or function(evt) returning a string
  function attachTooltip(node, html, wide) {
    node.addEventListener('mousemove', e => showTooltip(e, typeof html === 'function' ? html(e) : html, wide));
    node.addEventListener('mouseleave', hideTooltip);
  }

  /* ---------------- Time axis ---------------- */
  const TICK_STEPS_MS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map(m => m * 60000);

  // Tick times aligned to local clock time, about one label per 90 px.
  function timeTicks(tMin, tMax, widthPx) {
    const span = tMax - tMin;
    const wanted = Math.max(2, widthPx / 90);
    const step = TICK_STEPS_MS.find(s => span / s <= wanted) || TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
    const day = new Date(tMin); day.setHours(0, 0, 0, 0);
    const base = day.getTime();
    const ticks = [];
    for (let t = base + Math.ceil((tMin - base) / step) * step; t <= tMax; t += step) ticks.push(t);
    return ticks;
  }
  function tickLabel(t, multiDay) {
    const d = new Date(t);
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return multiDay ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${hm}` : hm;
  }
  function drawTimeAxis(svg, o) {
    // o: { x, tMin, tMax, left, right, y }
    const multiDay = (o.tMax - o.tMin) > 36 * 3600000;
    const ticks = timeTicks(o.tMin, o.tMax, o.right - o.left);
    ticks.forEach(t => {
      const px = o.x(t);
      text(svg, px, o.y, tickLabel(t, multiDay), { 'text-anchor': px < o.left + 22 ? 'start' : (px > o.right - 22 ? 'end' : 'middle') });
    });
    return ticks;
  }

  /* ---------------- Number axis helper ---------------- */
  function niceStep(range, targetCount) {
    const raw = range / targetCount;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / pow;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
  }

  /* ---------------- Generic time chart ----------------
     o = {
       tMin, tMax, height,
       yMin (default 0), yMax, yStep,
       bands:    [{ t0, t1, tint: 'actuated' | 'fixed' | 'plain' | null, label }]  background bands
       dividers: [t]                               signal plan changes (dashed)
       hours:    [t]                               hour borders (solid, light)
       hLines:   [{ y, color, label, labelColor }]  horizontal reference lines
       windows:  [{ t0, t1, med, lo, hi }]         median line and P5–P95 band per window
       steps:    [{ t0, t1, y }]                   step line segments (cycle time)
       points:   [{ t, y, color, r, tip }]
       crosses:  [{ t, tip }]                      "no green in this cycle" marks on the baseline
       logs:     [log entries]                     drawn as marker lane
       yUnit: 's'
     } */
  function timeChart(host, o) {
    const W = hostWidth(host), H = o.height;
    const logLane = o.logs && o.logs.length ? 20 : 0;
    const m = { l: 44, r: 12, t: 24, b: 22 + logLane };
    const svg = createSvg(host, W, H);
    const x = t => m.l + (t - o.tMin) / (o.tMax - o.tMin) * (W - m.l - m.r);
    const yMin = o.yMin || 0, y = v => H - m.b - (v - yMin) / (o.yMax - yMin) * (H - m.t - m.b);
    const plotBottom = H - m.b;

    (o.bands || []).forEach(b => {
      const fill = b.tint === 'actuated' ? 'var(--actuated-tint)' : b.tint === 'fixed' ? 'var(--fixed-tint)' : b.tint === 'plain' ? 'var(--band)' : 'none';
      const x0 = Math.max(x(b.t0), m.l), x1 = Math.min(x(b.t1), W - m.r);
      if (fill !== 'none') el('rect', { x: x0, y: m.t, width: Math.max(x1 - x0, 0), height: plotBottom - m.t, fill }, svg);
      if (b.label) text(svg, x0 + 6, m.t - 8, (x1 - x0) > b.label.long.length * 6.2 ? b.label.long : b.label.short, { class: 'label', style: 'fill:var(--text)' });
    });
    (o.hours || []).forEach(t => { if (t > o.tMin) el('line', { x1: x(t), x2: x(t), y1: m.t - 14, y2: plotBottom, stroke: 'var(--border-strong)' }, svg); });
    (o.dividers || []).forEach(t => { if (t > o.tMin && t < o.tMax) el('line', { x1: x(t), x2: x(t), y1: m.t - 14, y2: plotBottom, stroke: 'var(--req-marker)', 'stroke-dasharray': '3,2' }, svg); });

    const yStep = o.yStep || niceStep(o.yMax - yMin, 5);
    for (let v = yMin; v <= o.yMax + 1e-9; v += yStep) {
      el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: 'var(--border)' }, svg);
      text(svg, m.l - 6, y(v) + 3, Math.round(v) + ' s', { 'text-anchor': 'end' });
    }
    drawTimeAxis(svg, { x, tMin: o.tMin, tMax: o.tMax, left: m.l, right: W - m.r, y: H - 6 });

    (o.hLines || []).forEach(l => {
      if (l.y > o.yMax) return;
      el('line', { x1: m.l, x2: W - m.r, y1: y(l.y), y2: y(l.y), stroke: l.color, 'stroke-dasharray': '5,3', 'stroke-width': 1.3 }, svg);
      text(svg, W - m.r - 3, y(l.y) - 4, l.label, { 'text-anchor': 'end', style: `fill:${l.labelColor || l.color}` });
    });
    (o.windows || []).forEach(w => {
      if (w.med == null || !Number.isFinite(w.med)) return;
      if (w.hi - w.lo > 0) el('rect', { x: x(w.t0), y: y(w.hi), width: Math.max(x(w.t1) - x(w.t0), 0), height: y(w.lo) - y(w.hi), fill: 'var(--accent)', opacity: .13 }, svg);
      el('line', { x1: x(w.t0), x2: x(w.t1), y1: y(w.med), y2: y(w.med), stroke: 'var(--accent)', 'stroke-width': 1.4 }, svg);
      text(svg, x(w.t1) - 4, y(w.med) - 4, `Median ${GZ.format.fmtNum(w.med)} s`, { 'text-anchor': 'end', style: 'fill:var(--accent-strong)' });
    });

    if (o.steps && o.steps.length) {
      let d = '', prev = null;
      o.steps.forEach(s => {
        d += (prev && Math.abs(prev.t1 - s.t0) < 1 ? `V${y(s.y)}` : `M${x(s.t0)},${y(s.y)}`) + `H${x(s.t1)}`;
        prev = s;
      });
      el('path', { d, fill: 'none', stroke: 'var(--text)', 'stroke-width': 1.3 }, svg);
      const hit = el('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: plotBottom - m.t, fill: 'transparent' }, svg);
      attachTooltip(hit, e => {
        const box = svg.getBoundingClientRect();
        const t = o.tMin + (e.clientX - box.left - m.l) / (W - m.l - m.r) * (o.tMax - o.tMin);
        const s = o.steps.find(q => t >= q.t0 && t < q.t1);
        return s && s.tip ? s.tip : '';
      });
    }
    (o.crosses || []).forEach(c => {
      const cx = x(c.t);
      const mark = el('path', { d: `M${cx - 2.5},${plotBottom - 5}l5,5m0,-5l-5,5`, stroke: 'var(--text-faint)', 'stroke-width': 1, fill: 'none' }, svg);
      if (c.tip) attachTooltip(mark, c.tip);
    });
    (o.points || []).forEach(p => {
      const dot = el('circle', { cx: x(p.t), cy: y(Math.min(p.y, o.yMax)), r: p.r || 2.6, fill: p.color || 'var(--text)', stroke: '#fff', 'stroke-width': .8, opacity: p.opacity == null ? 1 : p.opacity }, svg);
      if (p.tip) attachTooltip(dot, p.tip);
    });

    if (logLane) GZ.charts.logMarkers.draw(svg, { x, entries: o.logs, laneTop: plotBottom + 8, plotTop: m.t, plotBottom, left: m.l, right: W - m.r });
    return svg;
  }

  /* ---------------- Generic CDF chart ----------------
     o = { height, xMin, xMax, xStep, series: [{ values, color, width, dash, tip }],
           vLines: [{ x, color, label, labelColor }], hLines: [fraction], fill: bool } */
  function cdfPath(values, x, y, xMin, xMax) {
    const a = [...values].sort((p, q) => p - q), n = a.length;
    let d = `M${x(xMin)},${y(0)}`;
    a.forEach((v, i) => { d += `H${x(v)}V${y((i + 1) / n)}`; });
    return d + `H${x(xMax)}`;
  }
  function cdfChart(host, o) {
    const W = hostWidth(host), H = o.height, m = { l: 44, r: 12, t: 20, b: 22 };
    const svg = createSvg(host, W, H);
    const x = v => m.l + (v - o.xMin) / (o.xMax - o.xMin) * (W - m.l - m.r), y = f => H - m.b - f * (H - m.t - m.b);
    [0, .25, .5, .75, 1].forEach(f => {
      el('line', { x1: m.l, x2: W - m.r, y1: y(f), y2: y(f), stroke: 'var(--border)' }, svg);
      text(svg, m.l - 6, y(f) + 3, Math.round(f * 100) + ' %', { 'text-anchor': 'end' });
    });
    const step = o.xStep || niceStep(o.xMax - o.xMin, 6);
    for (let v = Math.ceil(o.xMin / step) * step; v <= o.xMax + 1e-9; v += step) {
      text(svg, x(v), H - 6, Math.round(v) + ' s', { 'text-anchor': x(v) < m.l + 18 ? 'start' : (x(v) > W - m.r - 18 ? 'end' : 'middle') });
    }
    (o.hLines || []).forEach(f => el('line', { x1: m.l, x2: W - m.r, y1: y(f), y2: y(f), stroke: 'var(--text-faint)', 'stroke-dasharray': '2,2' }, svg));
    (o.vLines || []).forEach(l => {
      if (l.x < o.xMin || l.x > o.xMax) return;
      el('line', { x1: x(l.x), x2: x(l.x), y1: m.t, y2: H - m.b, stroke: l.color, 'stroke-dasharray': l.dash || '5,3', 'stroke-width': 1.3 }, svg);
      if (l.label) text(svg, x(l.x) + 3, m.t - 6, l.label, { style: `fill:${l.labelColor || l.color}` });
    });
    (o.series || []).forEach(s => {
      const d = cdfPath(s.values, x, y, o.xMin, o.xMax);
      if (o.fill && !s.dash) el('path', { d: d + `V${y(0)}Z`, fill: s.color, opacity: .09 }, svg);
      const path = el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 1.9, 'stroke-dasharray': s.dash || '' }, svg);
      if (s.tip) attachTooltip(path, s.tip);
    });
    return svg;
  }

  GZ.charts = GZ.charts || {};
  GZ.charts.kit = { el, text, createSvg, hostWidth, showTooltip, hideTooltip, attachTooltip, timeTicks, drawTimeAxis, niceStep, timeChart, cdfChart, esc };
})(window.GZ = window.GZ || {});
