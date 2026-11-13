/* GZ.charts.tooltipHelper has the shared positioning behavior of the small HTML tooltips in
   trend charts and wait time charts.
   The tooltip follows the cursor.
   At the edges of the container it flips to the other side. It is not cut off. */
(function (GZ) {
  'use strict';

  function attach(containerEl, tooltipEl) {
    function show(html) { tooltipEl.innerHTML = html; tooltipEl.style.display = 'block'; }
    function move(evt) {
      const rect = containerEl.getBoundingClientRect();
      const x = evt.clientX - rect.left, y = evt.clientY - rect.top;
      const ttW = tooltipEl.offsetWidth, ttH = tooltipEl.offsetHeight;
      let left = x + 12;
      if (left + ttW > rect.width - 4) left = x - ttW - 12;
      let top = y - ttH - 12;
      if (top < 4) top = y + 14;
      tooltipEl.style.left = Math.max(4, left) + 'px';
      tooltipEl.style.top = Math.max(4, top) + 'px';
    }
    function hide() { tooltipEl.style.display = 'none'; }
    return { show, move, hide };
  }

  GZ.charts = GZ.charts || {};
  GZ.charts.tooltipHelper = { attach };
})(window.GZ = window.GZ || {});
