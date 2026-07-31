/* GZ.views.navigator — Signalgruppen-Auswahlkarten mit Umlauf-"Fingerabdruck"
   (Miniaturansicht des typischen Zyklus) am linken Rand der Grünzeitanalyse. */
(function (GZ) {
  'use strict';
  const { esc } = GZ.format;
  const { mean } = GZ.stats;
  const { typicalCycleSegments, getFlaggedAnomalies } = GZ.segments;

  function renderFingerprint(typicalSegs, cStart, cEnd) {
    const range = cEnd - cStart || 1;
    return typicalSegs.map(s => {
      const w = Math.max(((s.end - s.start) / range * 100), 0.5);
      return `<div class="fp-seg seg-${s.cat}" style="width:${w}%;background:${fpColor(s.cat)}"></div>`;
    }).join('');
  }
  function fpColor(cat) {
    switch (cat) {
      case 'GRUEN': return 'var(--sig-green)';
      case 'ROT': return 'var(--sig-red)';
      case 'ROTGELB': return 'var(--sig-redyellow)';
      case 'GELB': return 'var(--sig-yellow)';
      case 'DUNKEL': return 'var(--sig-dark)';
      default: return 'var(--border-strong)';
    }
  }

  function render(containerEl, allStats, selectedIdx, anomalyCtx, onSelect) {
    containerEl.innerHTML = allStats.map(({ col, segs, stats }, i) => {
      const gd = stats.greenDurations;
      const flagged = gd.length ? getFlaggedAnomalies(stats, anomalyCtx).some(Boolean) : false;
      const typical = typicalCycleSegments(segs, stats);
      const cStart = typical.length ? typical[0].start : 0;
      const cEnd = typical.length ? (stats.greens[1] ? stats.greens[1].start : segs[segs.length - 1].end) : 1;
      const fpHtml = typical.length ? renderFingerprint(typical, cStart, cEnd) : '<div class="fp-seg" style="width:100%;background:var(--border)"></div>';
      const descHtml = (col.beschreibung && col.beschreibung !== col.name) ? `<div class="nc-desc">${esc(col.beschreibung)}</div>` : '';
      return `<div class="nav-card${i === selectedIdx ? ' active' : ''}" data-idx="${i}">
        <div class="nc-head"><span class="nc-kuerzel">${esc(col.name)}</span>${flagged ? '<span class="nc-flag">⚠</span>' : ''}</div>
        ${descHtml}
        <div class="fingerprint">${fpHtml}</div>
        <div class="nc-foot"><span>Ø Grün</span><span>${gd.length ? mean(gd).toFixed(1) + 's' : '–'}</span></div>
      </div>`;
    }).join('');
    containerEl.querySelectorAll('.nav-card').forEach(card => {
      card.addEventListener('click', () => onSelect(Number(card.dataset.idx)));
    });
  }

  GZ.views = GZ.views || {};
  GZ.views.navigator = { render };
})(window.GZ = window.GZ || {});
