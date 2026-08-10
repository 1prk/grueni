/* GZ.views.umlaufpruefung — Tab "Umlaufprüfung": eine Zeile je Umlauf (TX=0-
   Grenze) im Erscheinungsbild des Signalzeitendiagramms, aber jede Zeile auf
   ihren eigenen Umlauf skaliert (nicht auf ein gemeinsames Zeitfenster).
   Detektoren/APW-Werte sind optional zuschaltbare Zusatzspuren je Umlauf.

   Performance bei großen Aufzeichnungen (viele Umläufe/Messzeilen):
   - Alle Nachschlagevorgänge je Umlauf (Grünsegment, Signal-/Detektor-
     segmente, APW-Rohwerte) laufen über einen fortlaufenden Sweep
     (GZ.segments.makeIntervalSweep/-IndexSweep bzw. ein lokaler Zeilen-
     zeiger) statt über einen Vollscan pro Umlauf - amortisiert O(n) über
     die gesamte Aufzeichnung statt O(n²)/O(Umläufe × Messzeilen).
   - Die Breite/Höhe der Spuren-SVGs wird einmal je Render-Durchlauf
     gemessen (nicht je Zeile) und an renderLane durchgereicht, um
     Layout-Thrashing (abwechselnd DOM-Schreiben/erzwungenes Neu-Layout)
     bei vielen Zeilen zu vermeiden.
   - Ein Umlauf-Fenster (wie im Signalzeitendiagramm) begrenzt die Anzahl
     gleichzeitig gerenderter DOM-/SVG-Knoten, damit auch sehr lange
     Aufzeichnungen (tausende Umläufe) flüssig bleiben. */
(function (GZ) {
  'use strict';
  const { esc, fmtTs, fmtTimeShort } = GZ.format;
  const {
    buildSegments, computeGlobalTU, findSplAt, computeSegmentAnAbTf, getFlaggedAnomalies,
    makeIntervalSweep, makeIndexSweep
  } = GZ.segments;
  const { categorizeDetRaw } = GZ.parser;
  const { renderLane } = GZ.charts.timelineLane;
  const { wzIstBelegt, computeOepnvEvents } = GZ.oepnvLogic;

  let els = null;
  let windowCount = 20, windowStartIdx = 0, showAll = false;

  function init(root) {
    els = {
      root,
      sgSelect: root.querySelector('#upSgSelect'),
      detChecks: root.querySelector('#upDetChecks'),
      apwChecks: root.querySelector('#upApwChecks'),
      fzToggle: root.querySelector('#upFzToggle'),
      hint: root.querySelector('#upHint'),
      tablePanel: root.querySelector('#upTablePanel'),
      sgLabel: root.querySelector('#upSgLabel'),
      info: root.querySelector('#upInfo'),
      rows: root.querySelector('#upRows'),
      diagramControls: root.querySelector('#upDiagramControls'),
      btnWinPrev: root.querySelector('#upBtnWinPrev'),
      winLabel: root.querySelector('#upWinLabel'),
      btnWinNext: root.querySelector('#upBtnWinNext'),
      winSize: root.querySelector('#upWinSize'),
      btnWinAll: root.querySelector('#upBtnWinAll')
    };

    els.btnWinPrev.addEventListener('click', () => {
      if (showAll) return;
      windowStartIdx = Math.max(0, windowStartIdx - windowCount);
      render();
    });
    els.btnWinNext.addEventListener('click', () => {
      const a = GZ.state.data.currentAnalysis;
      if (showAll || !a || !a.cycleStarts) return;
      const maxStart = Math.max(0, a.cycleStarts.length - 1);
      windowStartIdx = Math.min(maxStart, windowStartIdx + windowCount);
      render();
    });
    els.winSize.addEventListener('change', () => {
      const v = parseInt(els.winSize.value, 10);
      windowCount = Number.isFinite(v) && v > 0 ? v : 20;
      els.winSize.value = windowCount;
      render();
    });
    els.btnWinAll.addEventListener('click', () => {
      showAll = !showAll;
      els.btnWinAll.textContent = showAll ? 'Fenster anzeigen' : 'Alle anzeigen';
      els.btnWinAll.classList.toggle('primary', showAll);
      render();
    });
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

    windowStartIdx = 0;
    showAll = false;
    els.btnWinAll.textContent = 'Alle anzeigen';
    els.btnWinAll.classList.remove('primary');

    wireEvents();
    render();
  }

  function wireEvents() {
    els.sgSelect.onchange = render;
    els.detChecks.querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = render);
    els.apwChecks.querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = render);
    els.fzToggle.onchange = render;
  }

  function windowRange(n) {
    if (showAll || n <= 0) return { from: 0, to: n };
    const from = Math.max(0, Math.min(windowStartIdx, Math.max(0, n - 1)));
    return { from, to: Math.min(from + windowCount, n) };
  }

  function render() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const { allStats, cycleStarts, tMax, times, splValues, seriesByCol, otherColumns } = a;
    const sgIdx = Number(els.sgSelect.value);
    const sgEntry = allStats[sgIdx];

    if (!sgEntry || !cycleStarts || cycleStarts.length < 2) {
      els.tablePanel.style.display = 'none';
      els.diagramControls.style.display = 'none';
      els.hint.textContent = 'Zu wenige erkannte Umläufe (TX=0-Wechsel) für diese Auswertung.';
      return;
    }

    const TU = computeGlobalTU(cycleStarts);
    const { segs, stats } = sgEntry;
    const flags = getFlaggedAnomalies(stats, GZ.state.anomalyCtx()); // parallel zu stats.greens

    const detIdxs = [...els.detChecks.querySelectorAll('input:checked')].map(i => Number(i.value));
    const apwIdxs = [...els.apwChecks.querySelectorAll('input:checked')].map(i => Number(i.value));
    const detCols = detIdxs.map(idx => otherColumns.find(c => c.index === idx)).filter(Boolean);
    const apwCols = apwIdxs.map(idx => otherColumns.find(c => c.index === idx)).filter(Boolean);

    const detSegsByCol = new Map();
    detCols.forEach(c => detSegsByCol.set(c.index, buildSegments(times, seriesByCol.get(c.index), categorizeDetRaw)));

    // ÖV-Fahrzeiten (tFZ/ZwL): übernimmt die im Tab "ÖPNV" für diese
    // Signalgruppe konfigurierten Zeilen (Sollfahrzeit/Zwangslöschzeit,
    // An-/Abmeldedetektoren) und berechnet die Anmeldung/Abmeldung-Ereignisse
    // einmal über die gesamte Aufzeichnung (wie die Detektor-Segmente oben),
    // um sie anschließend je Umlauf-Fenster einzuschwenken.
    const fzEnabled = !!(els.fzToggle && els.fzToggle.checked);
    const oepnvRows = (fzEnabled && GZ.views.oepnvQa) ? GZ.views.oepnvQa.getRowsForSg(sgIdx) : [];
    const fzData = oepnvRows.map(orow => {
      const anOccupied = times.map((_, i) => orow.anDetCols.some(c => wzIstBelegt(seriesByCol.get(c.index)[i])));
      const abOccupied = times.map((_, i) => orow.abDetCols.some(c => wzIstBelegt(seriesByCol.get(c.index)[i])));
      const { events, unresolved } = computeOepnvEvents(times, anOccupied, abOccupied, splValues, [], orow.sollfahrzeitSek, orow.zwangsloeschSek);

      const fzSegs = [];
      const zwlSegs = [];
      const addPair = (anTime, endTime) => {
        const sollEnd = anTime + orow.sollfahrzeitSek * 1000;
        fzSegs.push({ start: anTime, end: Math.min(sollEnd, endTime), cat: 'FZ_SOLL', sollfahrzeitSek: orow.sollfahrzeitSek });
        if (endTime > sollEnd) {
          fzSegs.push({ start: sollEnd, end: endTime, cat: 'FZ_VERLUST', verlustSek: (endTime - sollEnd) / 1000 });
        }
        zwlSegs.push({ start: anTime, end: anTime + orow.zwangsloeschSek * 1000, cat: 'ZWL_WINDOW', zwangsloeschSek: orow.zwangsloeschSek });
      };
      events.forEach(e => addPair(e.anTime, e.endTime));
      if (unresolved) addPair(unresolved.startTime, unresolved.startTime + orow.sollfahrzeitSek * 1000);

      return {
        label: orow.anDetCols.map(c => c.name).join('+'),
        fzSweep: makeIntervalSweep(fzSegs), zwlSweep: makeIntervalSweep(zwlSegs)
      };
    });
    els.hint.textContent = (fzEnabled && oepnvRows.length === 0)
      ? `Keine ÖPNV-Konfiguration für „${sgEntry.col.name}“ gefunden – bitte im Tab „ÖPNV“ eine Signalgruppe mit dieser Auswahl anlegen.`
      : '';

    const n = cycleStarts.length;
    const { from, to } = windowRange(n);

    els.diagramControls.style.display = 'flex';
    els.winLabel.textContent = showAll ? `Gesamte Aufzeichnung (${n} Umläufe erkannt)` : `Umlauf ${from + 1}–${to} von ${n}`;
    els.btnWinPrev.disabled = showAll || from <= 0;
    els.btnWinNext.disabled = showAll || to >= n;
    els.winSize.disabled = showAll;

    // Sweeps: bei aufsteigend durchlaufenen, disjunkten [start,end)-Fenstern
    // (ein Aufruf je sichtbarem Umlauf) amortisiert O(Datenmenge) statt eines
    // Vollscans pro Umlauf - siehe Datei-Kommentar oben.
    const greenSweep = makeIndexSweep(stats.greens);
    const segSweep = makeIntervalSweep(segs);
    const detSweeps = new Map();
    detCols.forEach(c => detSweeps.set(c.index, makeIntervalSweep(detSegsByCol.get(c.index))));
    let rowPtr = 0; // Zeiger in times[] für den APW-Rohwert-Sweep

    const rowData = [];
    for (let i = from; i < to; i++) {
      const start = cycleStarts[i];
      const end = i + 1 < n ? cycleStarts[i + 1] : tMax;
      const spl = findSplAt(start, times, splValues) || '–';
      const tu = Math.round((end - start) / 1000);

      const gIdx = greenSweep(start, end);
      let an = '–', ab = '–', tf = '–', anomClass = '';
      if (gIdx !== -1) {
        const seg = TU ? computeSegmentAnAbTf(stats.greens[gIdx], cycleStarts, TU) : null;
        if (seg) { an = seg.an; ab = seg.ab; tf = seg.tf; }
        if (flags[gIdx]) anomClass = 'up-anom';
      }

      const visSegs = segSweep(start, end);
      const detVisSegs = detCols.map(c => detSweeps.get(c.index)(start, end));
      const fzVisSegs = fzData.map(fd => fd.fzSweep(start, end));
      const zwlVisSegs = fzData.map(fd => fd.zwlSweep(start, end));

      // Zeilenbereich [rowPtr, rowEnd) dieses Umlaufs in times[] - EIN
      // fortlaufender Sweep für alle APW-Spalten zusammen (statt je Spalte
      // einen Vollscan über times[]).
      while (rowPtr < times.length && times[rowPtr] < start) rowPtr++;
      const rowFrom = rowPtr;
      while (rowPtr < times.length && times[rowPtr] < end) rowPtr++;
      const rowTo = rowPtr;

      const apwHtml = apwCols.length ? `<div class="up-apw-row">${apwCols.map(c => {
        const vals = seriesByCol.get(c.index);
        let first = null, last = null;
        const seen = new Set();
        for (let k = rowFrom; k < rowTo; k++) {
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

      rowData.push({ i, start, end, spl, tu, an, ab, tf, anomClass, visSegs, detVisSegs, fzVisSegs, zwlVisSegs, apwHtml });
    }

    els.rows.innerHTML = rowData.map(r => `
      <div class="up-group">
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
        <div class="lane-row up-sub-row">
          <div class="lane-name" title="${esc(c.beschreibung && c.beschreibung !== c.name ? c.beschreibung : c.name)}">↳${esc(c.name)}</div>
          <div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div>
          <div class="lane-track up-sub-track"><svg></svg></div>
        </div>`).join('')}
        ${fzData.map(fd => `
        <div class="lane-row up-sub-row">
          <div class="lane-name" title="Theoretische Fahrzeit (${esc(fd.label)}): Soll-Anteil und Verlustzeit-Anteil">↳tFZ ${esc(fd.label)}</div>
          <div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div>
          <div class="lane-track up-sub-track"><svg></svg></div>
        </div>
        <div class="lane-row up-sub-row">
          <div class="lane-name" title="Zwangslöschzeit-Fenster (${esc(fd.label)}): Anmeldung bis Zwangslöschzeit">↳ZwL ${esc(fd.label)}</div>
          <div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div>
          <div class="lane-track up-sub-track"><svg></svg></div>
        </div>`).join('')}
        ${r.apwHtml}
      </div>`).join('');

    // Größe je EINMAL messen (erzwingt Reflow) statt je Zeile - sonst
    // Layout-Thrashing bei vielen Umläufen (Schreiben+Messen im Wechsel).
    const groupEls = els.rows.querySelectorAll('.up-group');
    const firstMainTrack = els.rows.querySelector('.up-main-row .lane-track');
    const mainSize = firstMainTrack ? { width: firstMainTrack.clientWidth, height: firstMainTrack.clientHeight } : { width: 0, height: 0 };
    const firstSubTrack = els.rows.querySelector('.up-sub-track');
    const subSize = firstSubTrack ? { width: firstSubTrack.clientWidth, height: firstSubTrack.clientHeight } : mainSize;

    rowData.forEach((r, idx) => {
      const group = groupEls[idx];
      const mainSvg = group.querySelector('.up-main-row .lane-track svg');
      renderLane(mainSvg, {
        wMin: r.start, wMax: r.end, segs: r.visSegs, baselineCat: 'ROT', baselineColor: 'var(--sig-red)',
        width: mainSize.width, height: mainSize.height
      });
      const subRows = group.querySelectorAll('.up-sub-row');
      if (detCols.length) {
        detCols.forEach((c, ci) => {
          const subSvg = subRows[ci].querySelector('.lane-track svg');
          renderLane(subSvg, {
            wMin: r.start, wMax: r.end, segs: r.detVisSegs[ci],
            baselineCat: 'FREI', baselineColor: 'var(--text-faint)', baselineHeight: 2,
            width: subSize.width, height: subSize.height,
            segTitle: s => `${esc(c.name)} – ${s.cat === 'BELEGT' ? 'Belegt' : s.cat === 'LUECKE' ? 'Datenlücke' : 'Unbekannt/INV'}: ${fmtTimeShort(s.start)}–${fmtTimeShort(s.end)} (${Math.round((s.end - s.start) / 1000)}s)`
          });
        });
      }
      fzData.forEach((fd, fi) => {
        const fzSvg = subRows[detCols.length + fi * 2].querySelector('.lane-track svg');
        renderLane(fzSvg, {
          wMin: r.start, wMax: r.end, segs: r.fzVisSegs[fi],
          baselineCat: 'FZ_NONE', baselineColor: 'var(--text-faint)', baselineHeight: 2,
          width: subSize.width, height: subSize.height,
          fillFor: d => d.cat === 'FZ_SOLL' ? 'var(--fz-soll)' : 'var(--fz-verlust)',
          segLabelFor: d => d.cat === 'FZ_SOLL' ? String(Math.round(d.sollfahrzeitSek)) : String(Math.round(d.verlustSek)),
          segTitle: d => d.cat === 'FZ_SOLL'
            ? `Sollfahrzeit: ${d.sollfahrzeitSek}s (${fmtTimeShort(d.start)}–${fmtTimeShort(d.end)})`
            : `Verlustzeit: ${d.verlustSek.toFixed(1)}s (${fmtTimeShort(d.start)}–${fmtTimeShort(d.end)})`
        });
        const zwlSvg = subRows[detCols.length + fi * 2 + 1].querySelector('.lane-track svg');
        renderLane(zwlSvg, {
          wMin: r.start, wMax: r.end, segs: r.zwlVisSegs[fi],
          baselineCat: 'ZWL_NONE', baselineColor: 'var(--text-faint)', baselineHeight: 2,
          width: subSize.width, height: subSize.height,
          fillFor: () => 'url(#gz-pat-zwl)',
          segLabelFor: d => String(Math.round(d.zwangsloeschSek)),
          segLabelColorFor: () => 'var(--text)',
          segTitle: d => `Zwangslöschzeit-Fenster: ${d.zwangsloeschSek}s ab Anmeldung (Schwelle ${fmtTimeShort(d.end)})`
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
