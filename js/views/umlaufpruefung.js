/* GZ.views.umlaufpruefung — Tab "Umlaufprüfung": eine Zeile je Umlauf (TX=0-
   Grenze) im Erscheinungsbild des Signalzeitendiagramms, aber jede Zeile auf
   ihren eigenen Umlauf skaliert (nicht auf ein gemeinsames Zeitfenster).
   Mehrere Signalgruppen gleichzeitig (je eine Hauptzeile), Detektoren/APW-
   Werte/ÖV-Fahrzeiten sind optional zuschaltbare Zusatzspuren je Umlauf.
   Jede Spur unterstützt eine manuelle Strg+Klick-Zeitmessung (siehe unten)
   sowie ein Hover-Fadenkreuz über alle Spuren eines Umlaufs (TX in Sekunden).

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
  let lastEffectiveCount = 0; // Anzahl Umläufe nach aktuellem Filter (für Fenster-Navigation)

  // Manuelle Zeitmessung (Strg+Klick): Zustand pro (Umlauf, Spur) über
  // Render-Durchläufe hinweg - siehe wireMeasure()/measureClickHandler().
  // Schlüssel: "<Umlaufindex>|<Spurart>|<Bezeichner>", Wert: {a, b} in ms
  // (Unix-Zeit), b ist null solange nur eine Marke gesetzt ist.
  let measurements = new Map();

  function init(root) {
    els = {
      root,
      sgChecks: root.querySelector('#upSgChecks'),
      detChecks: root.querySelector('#upDetChecks'),
      apwChecks: root.querySelector('#upApwChecks'),
      fzToggle: root.querySelector('#upFzToggle'),
      filterChecks: root.querySelector('#upFilterChecks'),
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
      if (showAll) return;
      const maxStart = Math.max(0, lastEffectiveCount - 1);
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
    measurements = new Map();

    const prevSgChecked = new Set([...els.sgChecks.querySelectorAll('input:checked')].map(i => i.value));
    els.sgChecks.innerHTML = allStats.map(({ col }, i) => {
      const label = col.beschreibung && col.beschreibung !== col.name ? `${col.name} – ${col.beschreibung}` : col.name;
      const checked = prevSgChecked.size ? prevSgChecked.has(String(i)) : i === 0;
      return `<label class="det-check"><input type="checkbox" value="${i}" ${checked ? 'checked' : ''}> ${esc(label)}</label>`;
    }).join('');

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

    // Filterbare Spalten: Signalgruppen (SG, aus allStats - haben von Haus
    // aus kein "kuerzel", daher hier synthetisch getaggt) UND alle otherColumns
    // (DET/APW/OEPNV/…), damit z.B. "nur Umläufe zeigen, in denen SG S1 einen
    // Wert hat" möglich ist - vorher fehlten SG-Spalten hier komplett.
    const sgFilterCols = allStats.map(({ col }) => ({ ...col, kuerzel: 'SG' }));
    const filterableCols = sgFilterCols.concat(otherColumns);
    const prevFilterChecked = new Set([...els.filterChecks.querySelectorAll('input:checked')].map(i => i.value));
    els.filterChecks.innerHTML = filterableCols.length
      ? filterableCols.map(c => {
          const label = c.beschreibung && c.beschreibung !== c.name ? `${c.name} – ${c.beschreibung}` : c.name;
          const checked = prevFilterChecked.has(String(c.index));
          return `<label class="det-check"><input type="checkbox" value="${c.index}" ${checked ? 'checked' : ''}> <span class="filter-kuerzel">${esc(c.kuerzel)}</span> ${esc(label)}</label>`;
        }).join('')
      : '<div class="cfg-empty">Keine weiteren Spalten erkannt.</div>';

    windowStartIdx = 0;
    showAll = false;
    els.btnWinAll.textContent = 'Alle anzeigen';
    els.btnWinAll.classList.remove('primary');

    wireEvents();
    render();
  }

  function wireEvents() {
    els.sgChecks.querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = render);
    els.detChecks.querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = render);
    els.apwChecks.querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = render);
    els.fzToggle.onchange = render;
    els.filterChecks.querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = () => { windowStartIdx = 0; render(); });
  }

  function windowRange(n) {
    if (showAll || n <= 0) return { from: 0, to: n };
    const from = Math.max(0, Math.min(windowStartIdx, Math.max(0, n - 1)));
    return { from, to: Math.min(from + windowCount, n) };
  }

  /* ---------------- Manuelle Zeitmessung (Strg+Klick) ---------------- */
  // 3-Klick-Zyklus je Spur: leer -> erste Marke -> zweite Marke (Differenz
  // wird angezeigt) -> nächster Strg+Klick verwirft beide und beginnt an der
  // geklickten Stelle neu. Zeiten werden auf die volle Sekunde gerundet.
  function measureClickHandler(svgEl, wMin, wMax, key) {
    return function (event) {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      event.stopPropagation();
      const width = svgEl.clientWidth;
      if (!width) return;
      const rect = svgEl.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const x = d3.scaleLinear().domain([wMin, wMax]).range([0, width]);
      let t = Math.round(x.invert(px) / 1000) * 1000;
      t = Math.max(wMin, Math.min(wMax, t));

      const cur = measurements.get(key);
      let next;
      if (!cur || cur.a == null) next = { a: t, b: null };
      else if (cur.b == null) next = { a: cur.a, b: t };
      else next = { a: t, b: null };
      measurements.set(key, next);
      drawMeasureOverlay(svgEl, wMin, wMax, next);
    };
  }

  function drawMeasureOverlay(svgEl, wMin, wMax, mark) {
    const width = svgEl.clientWidth, height = svgEl.clientHeight;
    if (!width || !height) return;
    const x = d3.scaleLinear().domain([wMin, wMax]).range([0, width]);
    let g = d3.select(svgEl).select('g.measure-layer');
    if (g.empty()) g = d3.select(svgEl).append('g').attr('class', 'measure-layer').style('pointer-events', 'none');
    g.selectAll('*').remove();
    if (!mark || mark.a == null) return;

    const capTop = height * 0.12, capBot = height * 0.88;
    const drawCap = (t) => {
      const px = x(t);
      g.append('line').attr('class', 'measure-cap-halo').attr('x1', px).attr('x2', px).attr('y1', capTop).attr('y2', capBot);
      g.append('line').attr('class', 'measure-cap').attr('x1', px).attr('x2', px).attr('y1', capTop).attr('y2', capBot);
    };
    drawCap(mark.a);
    if (mark.b == null) return;
    drawCap(mark.b);

    const t0 = Math.min(mark.a, mark.b), t1 = Math.max(mark.a, mark.b);
    const xa = x(t0), xb = x(t1);
    [['measure-line-halo'], ['measure-line']].forEach(([cls]) => {
      g.append('line').attr('class', cls).attr('x1', xa).attr('x2', xb).attr('y1', height / 2).attr('y2', height / 2);
    });
    const secs = Math.round((t1 - t0) / 1000);
    g.append('text').attr('class', 'measure-label')
      .attr('x', (xa + xb) / 2).attr('y', height / 2).attr('dy', '-4')
      .text(`${secs}s`)
      .append('title').text(`${fmtTimeShort(t0)}–${fmtTimeShort(t1)} (${secs}s)`);
  }

  // Nach jedem renderLane()-Aufruf: Klick-Handler (neu) verdrahten und den
  // gespeicherten Messwert dieser Spur (falls vorhanden) neu einzeichnen -
  // renderLane() leert das SVG bei jedem Aufruf, daher muss die Übermalung
  // danach passieren, nicht davor.
  function wireMeasure(svgEl, wMin, wMax, key) {
    if (svgEl.__measureClickHandler) svgEl.removeEventListener('click', svgEl.__measureClickHandler, true);
    const handler = measureClickHandler(svgEl, wMin, wMax, key);
    svgEl.__measureClickHandler = handler;
    svgEl.addEventListener('click', handler, true);
    drawMeasureOverlay(svgEl, wMin, wMax, measurements.get(key));
  }

  /* ---------------- Sekunden-Fadenkreuz (Hover, alle Spuren eines Umlaufs) --------------
     Läuft je Umlauf-Gruppe (nicht je Spur) - eine senkrechte Linie in ALLEN
     Spuren-SVGs dieser Gruppe an derselben (auf volle Sekunde gerundeten,
     NICHT interpolierten) x-Position, plus ein Label darunter mit der
     seit Umlaufbeginn vergangenen Zeit (TX in Sekunden). Rein visuell/
     ephemer (kein persistenter Zustand über Render-Durchläufe hinweg nötig,
     anders als die Strg+Klick-Messung oben). */
  function wireCrosshair(groupEl, wMin, wMax) {
    if (groupEl.__crosshairMove) groupEl.removeEventListener('mousemove', groupEl.__crosshairMove);
    if (groupEl.__crosshairLeave) groupEl.removeEventListener('mouseleave', groupEl.__crosshairLeave);

    let label = groupEl.querySelector('.up-crosshair-label');
    if (!label) {
      label = document.createElement('div');
      label.className = 'up-crosshair-label';
      groupEl.appendChild(label);
    }

    const clear = () => {
      groupEl.querySelectorAll('.lane-track svg g.crosshair-layer').forEach(g => g.remove());
      label.style.display = 'none';
    };

    const onMove = (event) => {
      const trackEl = event.target.closest && event.target.closest('.lane-track');
      if (!trackEl || !groupEl.contains(trackEl)) { clear(); return; }
      const rect = trackEl.getBoundingClientRect();
      if (!rect.width) { clear(); return; }
      const px = event.clientX - rect.left;
      if (px < 0 || px > rect.width) { clear(); return; }
      const xTrack = d3.scaleLinear().domain([wMin, wMax]).range([0, rect.width]);
      let t = Math.round(xTrack.invert(px) / 1000) * 1000;
      t = Math.max(wMin, Math.min(wMax, t));

      groupEl.querySelectorAll('.lane-track svg').forEach(svg => {
        const w = svg.clientWidth, h = svg.clientHeight;
        if (!w || !h) return;
        const x = d3.scaleLinear().domain([wMin, wMax]).range([0, w]);
        const lx = x(t);
        let g = d3.select(svg).select('g.crosshair-layer');
        if (g.empty()) g = d3.select(svg).append('g').attr('class', 'crosshair-layer').style('pointer-events', 'none');
        g.selectAll('*').remove();
        g.append('line').attr('class', 'crosshair-line-halo').attr('x1', lx).attr('x2', lx).attr('y1', 0).attr('y2', h);
        g.append('line').attr('class', 'crosshair-line').attr('x1', lx).attr('x2', lx).attr('y1', 0).attr('y2', h);
      });

      const groupRect = groupEl.getBoundingClientRect();
      label.textContent = String(Math.round((t - wMin) / 1000));
      label.style.left = `${rect.left - groupRect.left + xTrack(t)}px`;
      label.style.display = 'block';
    };

    groupEl.addEventListener('mousemove', onMove);
    groupEl.addEventListener('mouseleave', clear);
    groupEl.__crosshairMove = onMove;
    groupEl.__crosshairLeave = clear;
  }

  /* ---------------- ÖV-Fahrzeiten je Signalgruppe ---------------- */
  // Übernimmt die im Tab "ÖPNV" für die gegebene Signalgruppe konfigurierten
  // Zeilen und berechnet die Anmeldung/Abmeldung-Ereignisse einmal über die
  // gesamte Aufzeichnung (wie die Detektor-Segmente), für den Sweep je
  // Umlauf-Fenster. Siehe computeOepnvEvents (GZ.oepnvLogic) für die Logik.
  function buildFzRowsForSg(sgIdx, times, seriesByCol, splValues) {
    const oepnvRows = GZ.views.oepnvQa ? GZ.views.oepnvQa.getRowsForSg(sgIdx) : [];
    return oepnvRows.map(orow => {
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
  }

  // Filtern: liefert die Indizes aller Umläufe, die JEDE gewählte Spalte
  // erfüllen (UND-Verknüpfung). Zwei Prüfarten je nach Spaltentyp:
  // - SG (Signalgruppe): Rohwert ist praktisch immer durchgängig befüllt
  //   (jede Sekunde ein Signalzustand) - "hat einen Rohwert" wäre also fast
  //   immer wahr und würde nie etwas herausfiltern. Sinnvoll ist hier
  //   stattdessen "hatte der Umlauf eine Freigabe (Grünphase) dieser SG?" -
  //   dieselbe Prüfung, die auch An/Ab/TF je Umlauf verwendet (greenSweep
  //   über die bereits vorberechneten stats.greens).
  // - DET/APW/OEPNV (otherColumns): Lücken sind hier echte Information (kein
  //   Fahrzeug/keine Anmeldung) - "mindestens ein nicht-leerer Rohwert im
  //   Umlauf" bleibt die richtige Prüfung.
  // Ein einmaliger Vollscan über die Aufzeichnung (wie die Detektor-/APW-
  // Sweeps oben) statt pro Umlauf neu zu scannen.
  function computeMatchingCycles(filterCols, allStats, cycleStarts, tMax, times, seriesByCol) {
    const n = cycleStarts.length;
    const rawCols = filterCols.filter(c => c.kuerzel !== 'SG');
    const greenSweeps = filterCols.filter(c => c.kuerzel === 'SG').map(c => {
      const sgEntry = allStats.find(s => s.col.index === c.index);
      return sgEntry ? makeIndexSweep(sgEntry.stats.greens) : () => -1;
    });
    const matches = [];
    let ptr = 0;
    for (let i = 0; i < n; i++) {
      const start = cycleStarts[i];
      const end = i + 1 < n ? cycleStarts[i + 1] : tMax;
      while (ptr < times.length && times[ptr] < start) ptr++;
      const rowFrom = ptr;
      while (ptr < times.length && times[ptr] < end) ptr++;
      const rowTo = ptr;
      const rawOk = rawCols.every(c => {
        const vals = seriesByCol.get(c.index);
        for (let k = rowFrom; k < rowTo; k++) {
          if ((vals[k] || '').trim() !== '') return true;
        }
        return false;
      });
      const greenOk = greenSweeps.every(sweep => sweep(start, end) !== -1);
      if (rawOk && greenOk) matches.push(i);
    }
    return matches;
  }

  function render() {
    const a = GZ.state.data.currentAnalysis;
    if (!a) return;
    const { allStats, cycleStarts, tMax, times, splValues, seriesByCol, otherColumns } = a;

    if (!cycleStarts || cycleStarts.length < 2) {
      els.tablePanel.style.display = 'none';
      els.diagramControls.style.display = 'none';
      els.hint.textContent = 'Zu wenige erkannte Umläufe (TX=0-Wechsel) für diese Auswertung.';
      return;
    }

    const sgIdxs = [...els.sgChecks.querySelectorAll('input:checked')].map(i => Number(i.value));
    if (sgIdxs.length === 0) {
      els.tablePanel.style.display = 'none';
      els.diagramControls.style.display = 'none';
      els.hint.textContent = 'Bitte mindestens eine Signalgruppe auswählen.';
      return;
    }

    const TU = computeGlobalTU(cycleStarts);
    const anomalyCtx = GZ.state.anomalyCtx();
    const fzEnabled = !!(els.fzToggle && els.fzToggle.checked);

    const sgData = sgIdxs.map(sgIdx => {
      const sgEntry = allStats[sgIdx];
      if (!sgEntry) return null;
      const { segs, stats } = sgEntry;
      return {
        sgIdx, sgEntry, segs, stats,
        flags: getFlaggedAnomalies(stats, anomalyCtx),
        greenSweep: makeIndexSweep(stats.greens),
        segSweep: makeIntervalSweep(segs),
        fzRows: fzEnabled ? buildFzRowsForSg(sgIdx, times, seriesByCol, splValues) : []
      };
    }).filter(Boolean);

    const missingFz = fzEnabled ? sgData.filter(sd => sd.fzRows.length === 0).map(sd => sd.sgEntry.col.name) : [];
    els.hint.textContent = missingFz.length
      ? `Keine ÖPNV-Konfiguration für: ${missingFz.join(', ')} – bitte im Tab „ÖPNV“ anlegen.`
      : '';

    const detIdxs = [...els.detChecks.querySelectorAll('input:checked')].map(i => Number(i.value));
    const apwIdxs = [...els.apwChecks.querySelectorAll('input:checked')].map(i => Number(i.value));
    const filterIdxs = [...els.filterChecks.querySelectorAll('input:checked')].map(i => Number(i.value));
    const detCols = detIdxs.map(idx => otherColumns.find(c => c.index === idx)).filter(Boolean);
    const apwCols = apwIdxs.map(idx => otherColumns.find(c => c.index === idx)).filter(Boolean);
    // Filter-Spalten können SG-Spalten (allStats) ODER otherColumns
    // (DET/APW/OEPNV/…) sein - siehe populateControls(). SG-Spalten führen
    // von Haus aus kein "kuerzel"-Feld, daher hier (wie dort) synthetisch
    // mit 'SG' getaggt - computeMatchingCycles() unterscheidet danach die
    // Prüfart (Freigabe-Sweep vs. Rohwert-Scan).
    const filterableCols = allStats.map(s => ({ ...s.col, kuerzel: 'SG' })).concat(otherColumns);
    const filterCols = filterIdxs.map(idx => filterableCols.find(c => c.index === idx)).filter(Boolean);

    const detSegsByCol = new Map();
    detCols.forEach(c => detSegsByCol.set(c.index, buildSegments(times, seriesByCol.get(c.index), categorizeDetRaw)));

    // APW/ÖPNV-Rohwert-Spalten: ein Segment je zusammenhängendem Zeitabschnitt
    // mit demselben Rohwert (cat = getrimmter Rohwert selbst statt einer
    // festen Kategorie) - zeigt den Wert direkt an, statt nur "geändert?".
    // idx je Segment (fortlaufend über die gesamte Spalte) treibt die
    // alternierende Kontrastfarbe in fillFor unten.
    const apwSegsByCol = new Map();
    apwCols.forEach(c => {
      const segs = buildSegments(times, seriesByCol.get(c.index), v => v.trim());
      segs.forEach((s, idx) => { s.idx = idx; });
      apwSegsByCol.set(c.index, segs);
    });

    const n = cycleStarts.length;
    const matchingCycles = filterCols.length ? computeMatchingCycles(filterCols, allStats, cycleStarts, tMax, times, seriesByCol) : null;
    const effectiveCount = matchingCycles ? matchingCycles.length : n;
    lastEffectiveCount = effectiveCount;
    const { from, to } = windowRange(effectiveCount);
    const cycleIdxList = matchingCycles ? matchingCycles.slice(from, to) : Array.from({ length: to - from }, (_, k) => from + k);

    els.diagramControls.style.display = 'flex';
    const filterSuffix = matchingCycles ? ` (gefiltert aus ${n})` : '';
    els.winLabel.textContent = showAll
      ? `Gesamte Aufzeichnung (${effectiveCount} Umläufe${filterSuffix})`
      : `Umlauf ${from + 1}–${to} von ${effectiveCount}${filterSuffix}`;
    els.btnWinPrev.disabled = showAll || from <= 0;
    els.btnWinNext.disabled = showAll || to >= effectiveCount;
    els.winSize.disabled = showAll;

    // Sweeps: bei aufsteigend durchlaufenen, disjunkten [start,end)-Fenstern
    // (ein Aufruf je sichtbarem Umlauf) amortisiert O(Datenmenge) statt eines
    // Vollscans pro Umlauf - siehe Datei-Kommentar oben. Bleibt auch bei
    // gefilterten (nicht-zusammenhängenden) Umlaufindizes gültig, da diese
    // weiterhin aufsteigend durchlaufen werden.
    const detSweeps = new Map();
    detCols.forEach(c => detSweeps.set(c.index, makeIntervalSweep(detSegsByCol.get(c.index))));
    const apwSweeps = new Map();
    apwCols.forEach(c => apwSweeps.set(c.index, makeIntervalSweep(apwSegsByCol.get(c.index))));

    const rowData = [];
    cycleIdxList.forEach(i => {
      const start = cycleStarts[i];
      const end = i + 1 < n ? cycleStarts[i + 1] : tMax;
      const spl = findSplAt(start, times, splValues) || '–';
      const tu = Math.round((end - start) / 1000);

      const sgRows = sgData.map(sd => {
        const gIdx = sd.greenSweep(start, end);
        let an = '–', ab = '–', tf = '–', anomClass = '';
        if (gIdx !== -1) {
          const seg = TU ? computeSegmentAnAbTf(sd.stats.greens[gIdx], cycleStarts, TU) : null;
          if (seg) { an = seg.an; ab = seg.ab; tf = seg.tf; }
          if (sd.flags[gIdx]) anomClass = 'up-anom';
        }
        return {
          sgEntry: sd.sgEntry, an, ab, tf, anomClass,
          visSegs: sd.segSweep(start, end),
          fzVisSegs: sd.fzRows.map(fd => fd.fzSweep(start, end)),
          zwlVisSegs: sd.fzRows.map(fd => fd.zwlSweep(start, end)),
          fzRows: sd.fzRows
        };
      });

      const detVisSegs = detCols.map(c => detSweeps.get(c.index)(start, end));
      const apwVisSegs = apwCols.map(c => apwSweeps.get(c.index)(start, end));

      rowData.push({ i, start, end, spl, tu, sgRows, detVisSegs, apwVisSegs });
    });

    if (rowData.length === 0) {
      els.rows.innerHTML = matchingCycles
        ? '<div class="cfg-empty" style="padding:16px;">Keine Umläufe erfüllen den Filter.</div>'
        : '';
      els.sgLabel.textContent = sgData.map(sd => sd.sgEntry.col.name).join(', ');
      els.info.textContent = `${n} Umlauf/Umläufe`;
      els.tablePanel.style.display = '';
      return;
    }

    els.rows.innerHTML = rowData.map(r => `
      <div class="up-group">
        <div class="up-group-caption" title="Start: ${esc(fmtTs(new Date(r.start)))}">Umlauf #${r.i + 1} <span class="win-label">${fmtTimeShort(r.start)} · SPL ${esc(r.spl)} · TU ${r.tu}s</span></div>
        ${r.sgRows.map(sr => `
        <div class="lane-row up-main-row">
          <div class="lane-name" title="${esc(sr.sgEntry.col.beschreibung && sr.sgEntry.col.beschreibung !== sr.sgEntry.col.name ? sr.sgEntry.col.beschreibung : sr.sgEntry.col.name)}">${esc(sr.sgEntry.col.name)}</div>
          <div class="lane-num" data-field="an" title="An [s]">${sr.an}</div>
          <div class="lane-num" data-field="ab" title="Ab [s]">${sr.ab}</div>
          <div class="lane-num ${sr.anomClass}" data-field="tf" title="TF [s]${sr.anomClass ? ' – auffällig' : ''}">${sr.tf}</div>
          <div class="lane-track"><svg></svg></div>
        </div>
        ${sr.fzRows.map(fd => `
        <div class="lane-row up-sub-row">
          <div class="lane-name" title="Theoretische Fahrzeit (${esc(sr.sgEntry.col.name)} · ${esc(fd.label)}): Soll-Anteil und Verlustzeit-Anteil">↳tFZ ${esc(fd.label)}</div>
          <div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div>
          <div class="lane-track up-sub-track"><svg></svg></div>
        </div>
        <div class="lane-row up-sub-row">
          <div class="lane-name" title="Zwangslöschzeit-Fenster (${esc(sr.sgEntry.col.name)} · ${esc(fd.label)}): Anmeldung bis Zwangslöschzeit">↳ZwL ${esc(fd.label)}</div>
          <div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div>
          <div class="lane-track up-sub-track"><svg></svg></div>
        </div>`).join('')}
        `).join('')}
        ${detCols.map(c => `
        <div class="lane-row up-sub-row">
          <div class="lane-name" title="${esc(c.beschreibung && c.beschreibung !== c.name ? c.beschreibung : c.name)}">↳${esc(c.name)}</div>
          <div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div>
          <div class="lane-track up-sub-track"><svg></svg></div>
        </div>`).join('')}
        ${apwCols.map(c => `
        <div class="lane-row up-sub-row">
          <div class="lane-name" title="${esc(c.beschreibung && c.beschreibung !== c.name ? c.beschreibung : c.name)}">↳${esc(c.name)}</div>
          <div class="lane-num"></div><div class="lane-num"></div><div class="lane-num"></div>
          <div class="lane-track up-sub-track"><svg></svg></div>
        </div>`).join('')}
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
      const mainRowEls = group.querySelectorAll('.up-main-row');
      const subRows = group.querySelectorAll('.up-sub-row');
      let subCursor = 0;

      r.sgRows.forEach((sr, si) => {
        const mainSvg = mainRowEls[si].querySelector('.lane-track svg');
        renderLane(mainSvg, {
          wMin: r.start, wMax: r.end, segs: sr.visSegs, baselineCat: 'ROT', baselineColor: 'var(--sig-red)',
          width: mainSize.width, height: mainSize.height
        });
        wireMeasure(mainSvg, r.start, r.end, `${r.i}|main|${sr.sgEntry.col.index}`);

        sr.fzRows.forEach((fd, fi) => {
          const fzSvg = subRows[subCursor].querySelector('.lane-track svg');
          renderLane(fzSvg, {
            wMin: r.start, wMax: r.end, segs: sr.fzVisSegs[fi],
            baselineCat: 'FZ_NONE', baselineColor: 'var(--text-faint)', baselineHeight: 2,
            width: subSize.width, height: subSize.height,
            fillFor: d => d.cat === 'FZ_SOLL' ? 'var(--fz-soll)' : 'var(--fz-verlust)',
            segLabelFor: d => d.cat === 'FZ_SOLL' ? String(Math.round(d.sollfahrzeitSek)) : String(Math.round(d.verlustSek)),
            segTitle: d => d.cat === 'FZ_SOLL'
              ? `Sollfahrzeit: ${d.sollfahrzeitSek}s (${fmtTimeShort(d.start)}–${fmtTimeShort(d.end)})`
              : `Verlustzeit: ${d.verlustSek.toFixed(1)}s (${fmtTimeShort(d.start)}–${fmtTimeShort(d.end)})`
          });
          wireMeasure(fzSvg, r.start, r.end, `${r.i}|fz|${sr.sgEntry.col.index}|${fi}`);
          subCursor++;

          const zwlSvg = subRows[subCursor].querySelector('.lane-track svg');
          renderLane(zwlSvg, {
            wMin: r.start, wMax: r.end, segs: sr.zwlVisSegs[fi],
            baselineCat: 'ZWL_NONE', baselineColor: 'var(--text-faint)', baselineHeight: 2,
            width: subSize.width, height: subSize.height,
            fillFor: () => 'url(#gz-pat-zwl)',
            segLabelFor: d => String(Math.round(d.zwangsloeschSek)),
            segLabelColorFor: () => 'var(--text)',
            segTitle: d => `Zwangslöschzeit-Fenster: ${d.zwangsloeschSek}s ab Anmeldung (Schwelle ${fmtTimeShort(d.end)})`
          });
          wireMeasure(zwlSvg, r.start, r.end, `${r.i}|zwl|${sr.sgEntry.col.index}|${fi}`);
          subCursor++;
        });
      });

      detCols.forEach((c, ci) => {
        const subSvg = subRows[subCursor].querySelector('.lane-track svg');
        renderLane(subSvg, {
          wMin: r.start, wMax: r.end, segs: r.detVisSegs[ci],
          baselineCat: 'FREI', baselineColor: 'var(--text-faint)', baselineHeight: 2,
          width: subSize.width, height: subSize.height,
          segTitle: s => `${esc(c.name)} – ${s.cat === 'BELEGT' ? 'Belegt' : s.cat === 'LUECKE' ? 'Datenlücke' : 'Unbekannt/INV'}: ${fmtTimeShort(s.start)}–${fmtTimeShort(s.end)} (${Math.round((s.end - s.start) / 1000)}s)`
        });
        wireMeasure(subSvg, r.start, r.end, `${r.i}|det|${c.index}`);
        subCursor++;
      });

      apwCols.forEach((c, ci) => {
        const subSvg = subRows[subCursor].querySelector('.lane-track svg');
        renderLane(subSvg, {
          wMin: r.start, wMax: r.end, segs: r.apwVisSegs[ci],
          baselineCat: '__apw_none__', baselineColor: 'var(--text-faint)', baselineHeight: 2,
          width: subSize.width, height: subSize.height,
          fillFor: d => d.cat === 'LUECKE' ? 'url(#gz-pat-gap)' : (d.idx % 2 === 0 ? 'var(--apw-a)' : 'var(--apw-b)'),
          segLabelFor: d => d.cat === 'LUECKE' ? '' : d.cat,
          segLabelColorFor: d => d.idx % 2 === 0 ? '#fff' : 'var(--text)',
          segTitle: d => d.cat === 'LUECKE'
            ? `Datenlücke: ${fmtTimeShort(d.start)}–${fmtTimeShort(d.end)}`
            : `${esc(c.name)}: ${esc(d.cat)} (${fmtTimeShort(d.start)}–${fmtTimeShort(d.end)}, ${Math.round((d.end - d.start) / 1000)}s)`
        });
        wireMeasure(subSvg, r.start, r.end, `${r.i}|apw|${c.index}`);
        subCursor++;
      });

      wireCrosshair(group, r.start, r.end);
    });

    els.sgLabel.textContent = sgData.map(sd => sd.sgEntry.col.name).join(', ');
    els.info.textContent = `${n} Umlauf/Umläufe`;
    els.tablePanel.style.display = '';
  }

  GZ.views = GZ.views || {};
  GZ.views.umlaufpruefung = { init, populateControls, render };
})(window.GZ = window.GZ || {});
