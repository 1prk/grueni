/* GZ.charts.logMarkers — draws log entries as a marker lane under a time chart.
   Entries close together (in pixels) form one marker with a count.
   Colour shows the highest severity of the cluster. Hovering shows the
   entries (time, level, text) and a guide line up into the chart.
   The log text is escaped before it goes into the tooltip. */
(function (GZ) {
  'use strict';
  const { esc, fmtTimeShort } = GZ.format;

  const SEVERITY_RANK = { error: 4, warning: 3, info: 2, other: 1, debug: 0 };
  const SEVERITY_COLOR = {
    error: 'var(--sig-red)', warning: 'var(--sig-redyellow)', info: 'var(--accent)',
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

  GZ.charts = GZ.charts || {};
  GZ.charts.logMarkers = { draw, SEVERITY_COLOR };
})(window.GZ = window.GZ || {});
