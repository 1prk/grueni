/* GZ.views.umlaufpruefung — Tab "Umlaufprüfung": eine Zeile je Umlauf (TX=0-
   Grenze) im Erscheinungsbild des Signalzeitendiagramms, aber jede Zeile auf
   ihren eigenen Umlauf skaliert (nicht auf ein gemeinsames Zeitfenster).
   Detektoren/APW-Werte sind optional zuschaltbare Zusatzspuren je Umlauf. */
(function (GZ) {
  'use strict';
  const { esc, fmtTs } = GZ.format;
  const { buildSegments, computeGlobalTU, findSplAt, computeSegmentAnAbTf, getFlaggedAnomalies } = GZ.segments;
  const { categorizeDetRaw } = GZ.parser;
  const { renderLane } = GZ.charts.timelineLane;

  let els = null;

  function init(root) {
    els = {
      root,
      sgSelect: root.querySelector('#upSgSelect'),
      detChecks: root.querySelector('#upDetChecks'),
      apwChecks: root.querySelector('#upApwChecks'),
      hint: root.querySelector('#upHint'),
      tablePanel: root.querySelector('#upTablePanel'),
      sgLabel: root.querySelector('#upSgLabel'),
      info: root.querySelector('#upInfo'),
      rows: root.querySelector('#upRows')
    };
  }

  function populateControls() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const { allStats, otherColumns } = a;

    const prevSg = els.sgSelect.value;
    els.sgSelect.innerHTML = allStats.map(({ col }, i) => {
      const label = col.beschreibung && col.beschreibung !== col.name ? `${col.name} – ${col.beschreibung}` : col.name;
      return `<option value="${i}">${esc(label)}</option>`;
    }).join('');
    if (prevSg && allStats[prevSg]) els.sgSelect.value = prevSg;

    const detCols = otherColumns.filter(c => c.kuerzel === 'DET');
    els.detChecks.innerHTML = detCols.length
      ? detCols.map((c, i) => {
          const label = c.beschreibung && c.beschreibung !== c.name ? `${c.name} – ${c.beschreibung}` : c.name;
          return `<label class="det-check"><input type="checkbox" value="${c.index}" ${i === 0 ? 'checked' : ''}> ${esc(label)}</label>`;
        }).join('')
      : '<div class="cfg-empty">Keine Detektor-Spalten (DET) in den Daten erkannt.</div>';

    const apwCols = otherColumns.filter(c => c.kuerzel === 'APW' || c.kuerzel === 'OEPNV');
    els.apwChecks.innerHTML = apwCols.length
      ? apwCols.map(c => {
          const label = c.beschreibung && c.beschreibung !== c.name ? `${c.name} – ${c.beschreibung}` : c.name;
          return `<label class="det-check"><input type="checkbox" value="${c.index}"> ${esc(label)}</label>`;
        }).join('')
      : '<div class="cfg-empty">Keine APW-/ÖPNV-Wert-Spalten erkannt.</div>';

    wireEvents();
    render();
  }

  let wired = false;
  function wireEvents() {
    els.sgSelect.onchange = render;
    els.detChecks.querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = render);
    els.apwChecks.querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = render);
  }

  function render() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const { allStats, cycleStarts, tMax, times, splValues, seriesByCol, otherColumns } = a;
    const sgIdx = Number(els.sgSelect.value);
    const sgEntry = allStats[sgIdx];

    if (!sgEntry || !cycleStarts || cycleStarts.length < 2) {
      els.tablePanel.style.display = 'none';
      els.hint.textContent = 'Zu wenige erkannte Umläufe (TX=0-Wechsel) für diese Auswertung.';
      return;
    }
    els.hint.textContent = '';

    const TU = computeGlobalTU(cycleStarts);
    const { segs, stats } = sgEntry;
    const flags = getFlaggedAnomalies(stats, GZ.state.anomalyCtx()); // parallel zu stats.greens

    const detIdxs = [...els.detChecks.querySelectorAll('input:checked')].map(i => Number(i.value));
    const apwIdxs = [...els.apwChecks.querySelectorAll('input:checked')].map(i => Number(i.value));
    const detCols = detIdxs.map(idx => otherColumns.find(c => c.index === idx)).filter(Boolean);
    const apwCols = apwIdxs.map(idx => otherColumns.find(c => c.index === idx)).filter(Boolean);

    const detSegCache = new Map();
    detCols.forEach(c => detSegCache.set(c.index, buildSegments(times, seriesByCol.get(c.index), categorizeDetRaw)));

    const n = cycleStarts.length;
    const rowData = [];
    for (let i = 0; i < n; i++) {
      const start = cycleStarts[i];
      const end = i + 1 < n ? cycleStarts[i + 1] : tMax;
      const spl = findSplAt(start, times, splValues) || '–';
      const tu = Math.round((end - start) / 1000);

      const gIdx = stats.greens.findIndex(g => g.start >= start && g.start < end);
      let an = '–', ab = '–', tf = '–', anomClass = '';
      if (gIdx !== -1) {
        const seg = TU ? computeSegmentAnAbTf(stats.greens[gIdx], cycleStarts, TU) : null;
        if (seg) { an = seg.an; ab = seg.ab; tf = seg.tf; }
        if (flags[gIdx]) anomClass = 'up-anom';
      }

      const apwHtml = apwCols.length ? `<div class="up-apw-row">${apwCols.map(c => {
        const vals = seriesByCol.get(c.index);
        let first = null, last = null;
        const seen = new Set();
        for (let k = 0; k < times.length; k++) {
          if (times[k] < start || times[k] >= end) continue;
          const v = (vals[k] || '').trim();
          if (v === '') continue;
          if (first === null) first = v;
          last = v;
          seen.add(v);
        }
        const changed = seen.size > 1;
        const label = c.beschreibung && c.beschreibung !== c.name ? c.beschreibung : c.name;
        const cls = first === null ? 'empty' : (changed ? 'changed' : '');
        const info = first === null ? 'kein Wert im Umlauf' : (changed ? `geändert: ${esc(first)} → ${esc(last)}` : `unverändert (${esc(first)})`);
        const symbol = first === null ? '–' : (changed ? '●' : '○');
        return `<span class="up-apw-pill ${cls}" title="${esc(label)}: ${info}">${esc(c.name)} ${symbol}</span>`;
      }).join(' ')}</div>` : '';

      rowData.push({ i, start, end, spl, tu, an, ab, tf, anomClass, apwHtml });
    }

    els.rows.innerHTML = rowData.map(r => `
      <div class="up-group" data-idx="${r.i}">
        <div class="lane-row up-main-row">
          <div class="lane-name" title="Start: ${esc(fmtTs(new Date(r.start)))}">#${r.i + 1}</div>
          <div class="lane-num" title="Signalprogramm (SPL)">${esc(r.spl)}</div>
          <div class="lane-num" title="Umlaufzeit [s]">${r.tu}</div>
          <div class="lane-num" data-field="an" title="An [s]">${r.an}</div>
          <div class="lane-num" data-field="ab" title="Ab [s]">${r.ab}</div>
          <div class="lane-num ${r.anomClass}" data-field="tf" title="TF [s]${r.anomClass ? ' – auffällig' : ''}">${r.tf}</div>
          <div class="lane-track"><svg></svg></div>
        </div>
        ${detCols.map(c => `
        <div class="lane-row up-sub-row" data-idx="${r.i}" data-det="${c.index}">
          <div class="lane-name" title="${esc(c.beschreibung && c.beschreibung !== c.name ? c.beschreibung : c.name)}">↳${esc(c.name)}</div>
          <div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div>
          <div class="lane-track up-sub-track"><svg></svg></div>
        </div>`).join('')}
        ${r.apwHtml}
      </div>`).join('');

    rowData.forEach(r => {
      const group = els.rows.querySelector(`.up-group[data-idx="${r.i}"]`);
      const mainSvg = group.querySelector('.up-main-row .lane-track svg');
      renderLane(mainSvg, { wMin: r.start, wMax: r.end, segs, baselineCat: 'ROT', baselineColor: 'var(--sig-red)' });
      detCols.forEach(c => {
        const subSvg = group.querySelector(`.up-sub-row[data-det="${c.index}"] .lane-track svg`);
        renderLane(subSvg, {
          wMin: r.start, wMax: r.end, segs: detSegCache.get(c.index),
          baselineCat: 'FREI', baselineColor: 'var(--text-faint)', baselineHeight: 2,
          segTitle: s => `${esc(c.name)} – ${s.cat === 'BELEGT' ? 'Belegt' : s.cat === 'LUECKE' ? 'Datenlücke' : 'Unbekannt/INV'}: ${GZ.format.fmtTimeShort(s.start)}–${GZ.format.fmtTimeShort(s.end)} (${Math.round((s.end - s.start) / 1000)}s)`
        });
      });
    });

    els.sgLabel.textContent = sgEntry.col.beschreibung && sgEntry.col.beschreibung !== sgEntry.col.name
      ? `${sgEntry.col.name} – ${sgEntry.col.beschreibung}` : sgEntry.col.name;
    els.info.textContent = `${n} Umlauf/Umläufe`;
    els.tablePanel.style.display = '';
  }

  GZ.views = GZ.views || {};
  GZ.views.umlaufpruefung = { init, populateControls, render };
})(window.GZ = window.GZ || {});
