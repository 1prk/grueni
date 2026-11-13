/* GZ.charts.logMarkers draws log entries as a marker lane under a time chart.
   Entries that are close together (in pixels) form one marker with a count.
   The color shows the highest severity of the cluster.
   Hovering shows the entries (time, level, text) and a guide line up into the chart.
   The code escapes the log text before it goes into the tooltip. */
GZ.define('charts.logMarkers', { layer: 'ui', deps: ['charts.kit', 'format'] }, function (GZ) {
  'use strict';
  const { esc, fmtTimeShort } = GZ.format;

  const SEVERITY_RANK = { critical: 5, error: 4, warning: 3, info: 2, other: 1, debug: 0 };
  const SEVERITY_COLOR = {
    critical: 'var(--log-critical)', error: 'var(--sig-red)', warning: 'var(--sig-redyellow)', info: 'var(--accent)',
    other: 'var(--req-marker)', debug: 'var(--text-faint)'
  };
  const CLUSTER_PX = 6;
  const MAX_LINES = 8;
  const MAX_TEXT = 160;

  function shorten(s) { return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT - 1) + '…' : s; }

  function tooltipHtml(cluster) {
    const lines = cluster.entries.slice(0, MAX_LINES).map(e =>
      `<div class="log-line"><span class="log-time">${fmtTimeShort(e.t)}</span> <b class="log-${esc(e.severity)}">${esc(e.level || '–')}</b> ${esc(shorten(e.text))}</div>`);
    if (cluster.entries.length > MAX_LINES) lines.push(`<div class="log-line dim">+ ${cluster.entries.length - MAX_LINES} weitere</div>`);
    return lines.join('');
  }

  // o = { x(t), entries, laneTop, plotTop, plotBottom, left, right }
  function draw(svg, o) {
    const kit = GZ.charts.kit;
    const clusters = [];
    o.entries.forEach(e => {
      const px = o.x(e.t);
      if (px < o.left || px > o.right) return;
      const last = clusters[clusters.length - 1];
      if (last && px - last.px < CLUSTER_PX) last.entries.push(e);
      else clusters.push({ px, entries: [e] });
    });
    const laneBottom = o.laneTop + 10;
    kit.el('line', { x1: o.left, x2: o.right, y1: laneBottom, y2: laneBottom, stroke: 'var(--border)' }, svg);
    kit.text(svg, o.left - 6, laneBottom - 1, 'Log', { 'text-anchor': 'end' });

    clusters.forEach(c => {
      const top = c.entries.reduce((a, e) => SEVERITY_RANK[e.severity] > SEVERITY_RANK[a] ? e.severity : a, c.entries[0].severity);
      const color = SEVERITY_COLOR[top] || SEVERITY_COLOR.other;
      const guide = kit.el('line', { x1: c.px, x2: c.px, y1: o.plotTop, y2: o.laneTop, stroke: color, 'stroke-width': 1, 'stroke-dasharray': '2,2', visibility: 'hidden' }, svg);
      kit.el('path', { d: `M${c.px - 3.5},${laneBottom} L${c.px + 3.5},${laneBottom} L${c.px},${laneBottom - 8} Z`, fill: color }, svg);
      if (c.entries.length > 1) kit.text(svg, c.px + 5, laneBottom - 1, String(c.entries.length), { style: `fill:${color}`, class: 'log-count' });
      const hit = kit.el('rect', { x: c.px - 5, y: o.laneTop - 2, width: 10, height: 14, fill: 'transparent', style: 'cursor:default' }, svg);
      hit.addEventListener('mouseenter', () => guide.setAttribute('visibility', 'visible'));
      hit.addEventListener('mouseleave', () => guide.setAttribute('visibility', 'hidden'));
      kit.attachTooltip(hit, tooltipHtml(c), true);
    });
  }

  // Thin marker strip for one time window (one row for each cycle in the cycle check).
  // svgEl is the target <svg>. o = { wMin, wMax, width, height, entries }
  function drawStrip(svgEl, o) {
    const kit = GZ.charts.kit;
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
    svgEl.setAttribute('viewBox', `0 0 ${o.width} ${o.height}`);
    svgEl.setAttribute('preserveAspectRatio', 'none');
    const x = t => (t - o.wMin) / (o.wMax - o.wMin) * o.width;
    const clusters = [];
    o.entries.forEach(e => {
      const px = x(e.t), last = clusters[clusters.length - 1];
      if (last && px - last.px < CLUSTER_PX) last.entries.push(e); else clusters.push({ px, entries: [e] });
    });
    kit.el('line', { x1: 0, x2: o.width, y1: o.height - .5, y2: o.height - .5, stroke: 'var(--border)' }, svgEl);
    // Entries after the end of a shortened window: one marker at the right edge.
    if (o.beyond && o.beyond.length) {
      const top = o.beyond.reduce((a, e) => SEVERITY_RANK[e.severity] > SEVERITY_RANK[a] ? e.severity : a, o.beyond[0].severity);
      const color = SEVERITY_COLOR[top] || SEVERITY_COLOR.other, mid = o.height / 2;
      kit.el('path', { d: `M${o.width - 2},${mid} L${o.width - 9},${mid - 5} L${o.width - 9},${mid + 5} Z`, fill: color }, svgEl);
      kit.text(svgEl, o.width - 12, o.height - 2, String(o.beyond.length), { style: `fill:${color}`, class: 'log-count', 'text-anchor': 'end' });
      const hit = kit.el('rect', { x: o.width - 40, y: 0, width: 40, height: o.height, fill: 'transparent' }, svgEl);
      const html = '<div class="log-line dim">Hinter dem dargestellten Ausschnitt („volle Länge anzeigen“):</div>' + tooltipHtml({ entries: o.beyond });
      kit.attachTooltip(hit, html, true);
    }
    clusters.forEach(c => {
      const top = c.entries.reduce((a, e) => SEVERITY_RANK[e.severity] > SEVERITY_RANK[a] ? e.severity : a, c.entries[0].severity);
      const color = SEVERITY_COLOR[top] || SEVERITY_COLOR.other, h = Math.min(o.height - 1, 10);
      kit.el('path', { d: `M${c.px - 3.5},${o.height - 1} L${c.px + 3.5},${o.height - 1} L${c.px},${o.height - 1 - h} Z`, fill: color }, svgEl);
      if (c.entries.length > 1) kit.text(svgEl, c.px + 5, o.height - 2, String(c.entries.length), { style: `fill:${color}`, class: 'log-count' });
      const hit = kit.el('rect', { x: c.px - 5, y: 0, width: 10, height: o.height, fill: 'transparent' }, svgEl);
      kit.attachTooltip(hit, tooltipHtml(c), true);
    });
  }

  return { draw, drawStrip, SEVERITY_COLOR };
});
