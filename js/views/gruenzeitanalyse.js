/* GZ.views.gruenzeitanalyse is the tab "Grünzeitanalyse": quantitative assessment of the green
   time quality.
   It is one report with four sections:
   1  Fixed time or actuated?  (cycle time, green time distribution for each signal group)
   2  Green time trend for each cycle (time plot or CDF)
   3  Where in the cycle does the green window move?  (start and end)
   4  How often and how much green? (share of cycles, share of the cycle, red time)
   The user can evaluate each section for the whole recording, for each signal plan (SPL) or for
   each clock hour.
   Log markers appear in the time charts. */
GZ.define('views.gruenzeitanalyse', { layer: 'views', deps: ['charts.kit', 'charts.logMarkers', 'charts.report', 'format', 'greenTime', 'logs', 'slices', 'state'] }, function (GZ) {
  'use strict';
  const { esc, fmtNum, fmtTimeShort, fmtHoursMinutes, fmtDauer, fmtTs } = GZ.format;
  const GT = GZ.greenTime;
  const R = GZ.charts.report;
  const kit = GZ.charts.kit;

  let els = null;
  let model = null;       // GZ.greenTime model of the current analysis
  let slices = null;      // GZ.slices.build() of the current analysis
  let xMaxGreen = 60;     // Common x axis of the green time histograms
  let tuMax = 100;        // Common x axis of the cycle position charts
  const state = { scope: 'total', mode: 'time', selected: [] };

  const analysis = () => GZ.state.data.currentAnalysis;
  const sgIndex = sg => sg.col.index;

  function init(root) {
    // The master data view tells the store when the phases change.
    GZ.state.on('phases:changed', refresh);
    els = {
      root,
      context: root.querySelector('#gzContext'),
      scopeGroup: root.querySelector('#gzScopeGroup'),
      notice: root.querySelector('#gzNotice'),
      claim1: root.querySelector('#gzClaim1'),
      cycleChart: root.querySelector('#gzCycleChart'),
      paramShare: root.querySelector('#gzParamShare'),
      paramTol: root.querySelector('#gzParamTol'),
      table1: root.querySelector('#gzTable1'),
      note1: root.querySelector('#gzNote1'),
      sgPick: root.querySelector('#gzSgPick'),
      modeGroup: root.querySelector('#gzModeGroup'),
      trendLegend: root.querySelector('#gzTrendLegend'),
      trendStack: root.querySelector('#gzTrendStack'),
      claim3: root.querySelector('#gzClaim3'),
      table3: root.querySelector('#gzTable3'),
      note3: root.querySelector('#gzNote3'),
      claim4: root.querySelector('#gzClaim4'),
      table4: root.querySelector('#gzTable4'),
      note4: root.querySelector('#gzNote4'),
      darkSection: root.querySelector('#gzDarkSection'),
      claimDark: root.querySelector('#gzClaimDark'),
      tableDark: root.querySelector('#gzTableDark'),
      noteDark: root.querySelector('#gzNoteDark')
    };
    // A dark period in the list opens its start in the cycle check.
    root.addEventListener('click', e => {
      const b = e.target.closest('button[data-jump-t]');
      if (b) GZ.state.command('nav:jumpToTime', { t: Number(b.dataset.jumpT) });
    });
    els.scopeGroup.addEventListener('click', e => {
      const b = e.target.closest('button[data-scope]');
      if (!b || b.disabled) return;
      setScope(b.dataset.scope);
    });
    els.modeGroup.addEventListener('click', e => {
      const b = e.target.closest('button[data-mode]');
      if (!b) return;
      state.mode = b.dataset.mode;
      els.modeGroup.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      renderTrend();
    });
    els.paramShare.addEventListener('input', () => { readParams(); renderAll(); });
    els.paramTol.addEventListener('input', () => { readParams(); renderAll(); });
  }

  function readParams() {
    const share = Number(els.paramShare.value), tol = Number(els.paramTol.value);
    if (Number.isFinite(share) && share > 0) GT.params.fixedShare = share;
    if (Number.isFinite(tol) && tol >= 0) GT.params.tolerance = tol;
  }

  function setScope(scope) {
    state.scope = scope;
    GZ.state.data.statsScope = scope === 'spl' ? 'spl' : 'total';   // Other tabs use it for their own flags.
    els.scopeGroup.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.scope === scope));
    renderAll();
  }

  /* ---------------- Slices of the current scope ---------------- */
  // Returns [{ key, kind, label }]. The whole recording is one slice with the key null.
  function scopeSlices() {
    return state.scope === 'total' ? [{ key: null }] : GZ.slices.forScope(slices, state.scope);
  }
  function sliceColor(key) {
    if (key == null) return 'var(--sig-green)';
    const slice = [...slices.plans, ...slices.hours].find(s => s.key === key);
    return slice ? GZ.slices.colorOf(slices, slice) : 'var(--plan-b)';
  }
  function sliceLabel(key) {
    const slice = [...slices.plans, ...slices.hours].find(s => s.key === key);
    return slice ? slice.label : String(key);
  }
  function groupTitle(slice) {
    const key = slice.key;
    const cyc = GT.cyclesInSlice(model, key);
    const plansHere = [...new Set(cyc.map(c => c.plan))];
    const head = slice.kind === 'hour' ? `${slice.label} Uhr` : `Signalzeitenplan ${key}`;
    const parts = [];
    if (model.hasCycles) parts.push(`${cyc.length} Umläufe`);
    if (slice.kind === 'hour' && plansHere.length) parts.push('SPL ' + plansHere.join(' → '));
    if (GT.plantHasData(model, key)) parts.push(GT.plantActuated(model, key) ? 'verkehrsabhängig' : 'Festzeit');
    return `${esc(head)}<span class="rest">${esc(parts.join(' · '))}</span>`;
  }

  /* ---------------- Section 1 ---------------- */
  function renderCycleChart() {
    const a = analysis();
    if (!model.hasCycles) { els.cycleChart.innerHTML = '<div class="report-empty">Keine Umlaufgrenzen (TX) erkannt – Umlaufzeit nicht darstellbar.</div>'; return; }
    const runs = GZ.slices.planRuns(a.times, a.splValues, a.tMin, a.tMax);
    const bands = runs.map(r => {
      const tus = model.cycles.filter(c => c.regular && c.t >= r.t0 && c.t < r.t1).map(c => c.tu);
      const actuated = GT.plantActuated(model, r.plan), has = GT.plantHasData(model, r.plan);
      const range = tus.length ? (Math.min(...tus) === Math.max(...tus) ? `${fmtNum(Math.min(...tus))} s` : `${fmtNum(Math.min(...tus))}–${fmtNum(Math.max(...tus))} s`) : '–';
      return {
        t0: r.t0, t1: r.t1, tint: has ? (actuated ? 'actuated' : 'fixed') : null,
        label: { long: `${GZ.slices.planLabel(r.plan)}${has ? ' · ' + (actuated ? 'verkehrsabhängig' : 'Festzeit') : ''} · TU ${range}`, short: GZ.slices.planLabel(r.plan) }
      };
    });
    const regular = model.cycles.filter(c => c.regular);
    const tus = regular.map(c => c.tu);
    const lo = Math.min(...tus), hi = Math.max(...tus);
    const yMin = Math.max(0, Math.floor(lo * 0.85 / 10) * 10), yMax = Math.max(yMin + 20, Math.ceil(hi * 1.1 / 10) * 10);
    kit.timeChart(els.cycleChart, {
      tMin: a.tMin, tMax: a.tMax, height: 158, yMin, yMax,
      bands, dividers: runs.slice(1).map(r => r.t0),
      steps: regular.map(c => ({ t0: c.t, t1: c.t + c.tu * 1000, y: c.tu, tip: `Umlauf ${c.i + 1} · ${fmtTimeShort(c.t)}<br>TU ${fmtNum(c.tu)} s · ${esc(GZ.slices.planLabel(c.plan))}` })),
      logs: GZ.logs.visible(a.tMin, a.tMax), drawLogs: GZ.charts.logMarkers.draw
    });
  }

  function histKeys() {
    // Without a slice the bars stack by signal plan.
    return state.scope === 'total' ? { stackKeys: slices.plans.map(p => p.key), keyOf: g => g.plan } : null;
  }

  function table1Row(sg, slice) {
    const st = GT.stats(model, sg, slice.key);
    const tr = document.createElement('tr');
    tr.dataset.sg = sgIndex(sg);
    if (state.selected.includes(sgIndex(sg))) tr.className = 'selected';
    const nameCell = `<td><span class="name">${esc(sg.col.name)}</span>${sg.col.beschreibung && sg.col.beschreibung !== sg.col.name ? `<span class="sub">${esc(sg.col.beschreibung)}</span>` : ''}</td>`;
    if (!st.n) { tr.innerHTML = nameCell + '<td class="left verdict none">kein Grün</td><td class="chart"></td>' + '<td></td>'.repeat(7); return tr; }
    const verdict = !st.enough ? '<span class="verdict none">zu wenig Daten</span>'
      : `<span class="verdict ${st.isFixed ? '' : 'actuated'}">${st.isFixed ? 'Festzeit' : 'verkehrsabhängig'}</span>`;
    tr.innerHTML = nameCell + `<td class="left">${verdict}</td><td class="chart"></td>` +
      `<td>${st.n}</td><td>${fmtNum(st.min)} s</td><td>${fmtNum(st.med)} s</td><td>${fmtNum(st.max)} s</td><td>${fmtNum(st.sd, 1)} s</td>` +
      `<td>${fmtNum(st.share * 100, 1)} %</td><td class="${st.isFixed || !st.enough ? 'dim' : ''}">${st.isFixed || !st.enough ? '–' : fmtNum(st.atMax * 100, 1) + ' %'}</td>`;
    const keys = histKeys();
    tr.querySelector('.chart').appendChild(R.histogram(st, keys
      ? { xMax: xMaxGreen, stackKeys: keys.stackKeys, keyOf: keys.keyOf, colorOf: sliceColor, tipPrefix: k => 'SPL ' + k }
      : { xMax: xMaxGreen, stackKeys: [slice.key], keyOf: () => slice.key, colorOf: sliceColor, tipPrefix: sliceLabel }));
    return tr;
  }

  function renderTable1() {
    const a = analysis();
    els.table1.innerHTML = '';
    const head = document.createElement('thead');
    head.innerHTML = `<tr><th>Signalgruppe</th><th class="left">Betriebsart</th><th class="chart"></th><th>Grünphasen</th><th>Min</th><th>Median</th><th>Max</th><th class="keep-case">σ</th><th>im Median ± ${fmtNum(GT.params.tolerance)} s</th><th>bei Max</th></tr>`;
    head.querySelector('th.chart').appendChild(R.axis(R.HIST_W, xMaxGreen, xMaxGreen > 100 ? 50 : 10, 14));
    els.table1.appendChild(head);
    const body = document.createElement('tbody');
    els.table1.appendChild(body);
    scopeSlices().forEach(slice => {
      if (slice.key != null) { const g = document.createElement('tr'); g.className = 'group'; g.innerHTML = `<td colspan="10">${groupTitle(slice)}</td>`; body.appendChild(g); }
      model.sgs.forEach(sg => body.appendChild(table1Row(sg, slice)));
    });
    body.querySelectorAll('tr[data-sg]').forEach(tr => tr.addEventListener('click', () => {
      state.selected = [Number(tr.dataset.sg)];
      renderPicker(); renderTrend(); renderTable1();
      els.sgPick.closest('section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));

    // Claim: one statement for each signal plan
    const parts = slices.plans.filter(p => GT.plantHasData(model, p.key)).map(p => {
      const cyc = GT.cyclesInSlice(model, p.key);
      return { label: p.label, actuated: GT.plantActuated(model, p.key), count: cyc.length, duration: cyc.reduce((s, c) => s + c.tu, 0) };
    });
    const detail = p => model.hasCycles ? ` (${p.count} Umläufe, ${fmtHoursMinutes(p.duration)})` : '';
    els.claim1.textContent = !parts.length ? 'Zu wenige Grünphasen für eine Aussage.'
      : parts.every(p => p.actuated) ? 'Die Anlage lief durchgehend verkehrsabhängig.'
      : parts.every(p => !p.actuated) ? 'Die Anlage lief durchgehend in Festzeit.'
      : 'Gemischter Betrieb: ' + parts.map(p => `${p.label} ${p.actuated ? 'verkehrsabhängig' : 'in Festzeit'}${detail(p)}`).join(', ') + '.';

    const legend = state.scope === 'total' && slices.plans.length > 1
      ? '<div class="legend"><span class="item">Balkenfarbe</span>' + slices.plans.map(p => `<span class="item"><span class="swatch" style="background:${sliceColor(p.key)}"></span>${esc(p.label)}</span>`).join('') + '</div>' : '';
    els.note1.innerHTML = `${legend}Balken = Anteil der Grünphasen je 1-s-Klasse, Maßstab je Zeile auf die höchste Klasse normiert. Gemeinsame Zeitachse für alle Zeilen. ` +
      `<b>Verkehrsabhängig</b> heißt: die Grünzeit streut. <b>Festzeit</b> heißt: sie streut nicht. Die Anlage gilt als verkehrsabhängig, sobald eine Signalgruppe streut. ` +
      `Signalgruppen mit weniger als ${GT.MIN_GREENS} Grünphasen werden nicht eingestuft. ` +
      (model.irregularCount ? `${model.irregularCount === 1 ? '1 Umlauf, der länger' : model.irregularCount + ' Umläufe, die länger'} als das ${fmtNum(GT.IRREGULAR_CYCLE_FACTOR, 1)}-Fache des Median-Umlaufs ${model.irregularCount === 1 ? 'dauert' : 'dauern'} (meist Dunkelzeit, siehe 5), ${model.irregularCount === 1 ? 'fließt' : 'fließen'} nicht in die Statistik ein. ` : '') +
      `„bei Max“ = Anteil der Grünphasen, die genau das beobachtete Maximum erreichen (Hinweis auf Deckelung durch die Maximalgrünzeit).`;
  }

  /* ---------------- Section 2: trend ---------------- */
  function selectableSgs() { return model.sgs.filter(sg => sg.greens.length); }

  function renderPicker() {
    els.sgPick.innerHTML = '';
    selectableSgs().forEach(sg => {
      const label = document.createElement('label');
      label.innerHTML = `<input type="checkbox" value="${sgIndex(sg)}" ${state.selected.includes(sgIndex(sg)) ? 'checked' : ''}><span class="name">${esc(sg.col.name)}</span>`;
      label.querySelector('input').addEventListener('change', e => {
        const idx = sgIndex(sg);
        if (e.target.checked) state.selected.push(idx);
        else if (state.selected.length > 1) state.selected = state.selected.filter(i => i !== idx);
        else e.target.checked = true;
        state.selected.sort((p, q) => model.sgs.findIndex(s => sgIndex(s) === p) - model.sgs.findIndex(s => sgIndex(s) === q));
        renderTrend(); renderTable1();
      });
      els.sgPick.appendChild(label);
    });
  }

  function verdictWord(st) { return !st.n || !st.enough ? '' : (st.isFixed ? 'Festzeit' : 'verkehrsabhängig'); }

  function renderTimeTrend(host, sg, height) {
    const a = analysis();
    const all = GT.stats(model, sg, null);
    const runs = GZ.slices.planRuns(a.times, a.splValues, a.tMin, a.tMax);
    // Background bands: one for each clock hour or one for each signal plan run
    const bandSource = state.scope === 'hour'
      ? slices.hours.map(h => ({ key: h.key, t0: h.t0, t1: Math.min(h.t1, a.tMax), name: h.label }))
      : runs.map(r => ({ key: r.plan, t0: r.t0, t1: r.t1, name: GZ.slices.planLabel(r.plan) }));
    const bands = bandSource.map(b => {
      const st = GT.stats(model, sg, b.key), word = verdictWord(st);
      return { t0: b.t0, t1: b.t1, tint: st.n && st.enough ? (st.isFixed ? 'fixed' : 'actuated') : null, label: { long: b.name + (word ? ' · ' + word : ''), short: b.name } };
    });
    const windows = state.scope === 'total'
      ? [{ t0: a.tMin, t1: a.tMax, med: all.med, lo: all.p5, hi: all.p95 }]
      : bandSource.map(b => { const st = GT.stats(model, sg, b.key); return { t0: b.t0, t1: b.t1, med: st.n ? st.med : null, lo: st.p5, hi: st.p95 }; });
    const windowAt = t => windows.find(w => t >= w.t0 && t < w.t1) || windows[windows.length - 1];
    const points = sg.greens.map(g => {
      const w = windowAt(g.t), diff = g.dur - w.med;
      return { t: g.t, y: g.dur, tip: `${g.cycle >= 0 ? 'Umlauf ' + (g.cycle + 1) + ' · ' : ''}${fmtTimeShort(g.t)}<br>Grünzeit ${fmtNum(g.dur, 1)} s (${diff >= 0 ? '+' : '−'}${fmtNum(Math.abs(diff), 1)} s zum Median)<br>${esc(GZ.slices.planLabel(g.plan))}` };
    });
    const withGreen = new Set(sg.greens.map(g => g.cycle));
    const crosses = model.hasCycles ? model.cycles.filter(c => c.regular && !withGreen.has(c.i))
      .map(c => ({ t: c.t + c.tu * 500, tip: `Umlauf ${c.i + 1} · ${fmtTimeShort(c.t)}<br>kein Grün · ${esc(GZ.slices.planLabel(c.plan))}` })) : [];
    const yMax = Math.max(20, Math.ceil(all.max * 1.1 / 10) * 10);
    kit.timeChart(host, {
      tMin: a.tMin, tMax: a.tMax, height, yMin: 0, yMax, yStep: yMax <= 30 ? 5 : (yMax > 100 ? 20 : 10),
      bands, dividers: runs.slice(1).map(r => r.t0), hours: state.scope === 'hour' ? slices.hours.map(h => h.t0) : [],
      windows, points, crosses, logs: GZ.logs.visible(a.tMin, a.tMax), drawLogs: GZ.charts.logMarkers.draw
    });
  }

  function renderCdfTrend(host, sg, height) {
    const all = GT.stats(model, sg, null);
    let lo = Math.floor(all.min) - 1, hi = Math.ceil(all.max) + 1;
    if (hi - lo < 10) { const c = (hi + lo) / 2; lo = Math.floor(c - 5); hi = lo + 10; }
    const slicesNow = state.scope === 'total' ? [] : scopeSlices();
    if (!slicesNow.length) {
      const pcts = [50, 85, 95].map(p => ({ x: GT.percentile(all.durs, p), label: `P${p}` }));
      kit.cdfChart(host, {
        height, xMin: lo, xMax: hi, fill: true,
        vLines: pcts.map(p => ({ x: p.x, color: 'var(--text-faint)', dash: '2,2', label: `${p.label} ${fmtNum(p.x)} s` })),
        series: [{ values: all.durs, color: 'var(--sig-green)' }]
      });
      return;
    }
    const series = [{ values: all.durs, color: 'var(--text-faint)', width: 1.2, dash: '4,3' }];
    slicesNow.forEach(sl => {
      const st = GT.stats(model, sg, sl.key);
      if (!st.n) return;
      series.push({ values: st.durs, color: sliceColor(sl.key), width: 2, tip: `${esc(sl.label)} · n = ${st.n}<br>P50 ${fmtNum(GT.percentile(st.durs, 50))} s · P85 ${fmtNum(GT.percentile(st.durs, 85))} s · P95 ${fmtNum(GT.percentile(st.durs, 95))} s` });
    });
    kit.cdfChart(host, { height, xMin: lo, xMax: hi, hLines: [.5, .85, .95], series });
  }

  function renderTrend() {
    els.trendStack.innerHTML = '';
    const sgs = state.selected.map(i => model.sgs.find(s => sgIndex(s) === i)).filter(Boolean);
    if (!sgs.length) { els.trendStack.innerHTML = '<div class="report-empty">Keine Signalgruppe mit Grünphasen.</div>'; els.trendLegend.innerHTML = ''; return; }
    const height = sgs.length === 1 ? 250 : 175;
    const keys = state.scope === 'total' ? [] : scopeSlices();
    els.trendLegend.innerHTML = state.mode === 'time'
      ? `<span class="item"><span class="dot" style="background:var(--text)"></span>Grünzeit je Zyklus</span>
         <span class="item"><span class="line" style="border-top:1.4px solid var(--accent)"></span>Median</span>
         <span class="item"><span class="swatch" style="background:rgba(47,111,163,.13);border:none"></span>P5–P95</span>
         <span class="item"><span class="dim">×</span>Zyklus ohne Grün</span>
         <span class="item"><span class="swatch actuated"></span>verkehrsabhängig</span><span class="item"><span class="swatch fixed"></span>Festzeit</span>
         <span class="item"><span class="line vertical" style="border-left:1px dashed var(--req-marker)"></span>Signalprogrammwechsel</span>`
      : (keys.length
          ? `<span class="item">Anteil der Zyklen mit höchstens dieser Grünzeit</span>` + keys.map(k => `<span class="item"><span class="line" style="border-top:2px solid ${sliceColor(k.key)}"></span>${esc(k.label)}</span>`).join('') + `<span class="item"><span class="line" style="border-top:1.2px dashed var(--text-faint)"></span>gesamt</span>`
          : `<span class="item"><span class="line" style="border-top:1.9px solid var(--sig-green)"></span>Anteil der Zyklen mit höchstens dieser Grünzeit</span>`);

    sgs.forEach(sg => {
      const st = GT.stats(model, sg, null);
      const block = document.createElement('div');
      block.className = 'trend-block';
      block.innerHTML = `<div class="trend-head"><span class="name">${esc(sg.col.name)}</span><span class="sub inline">${esc(sg.col.beschreibung && sg.col.beschreibung !== sg.col.name ? sg.col.beschreibung : '')}</span></div><div class="host"></div><div class="caption"></div>`;
      els.trendStack.appendChild(block);
      (state.mode === 'time' ? renderTimeTrend : renderCdfTrend)(block.querySelector('.host'), sg, height);
      let caption = `n = ${st.n} Grünphasen${model.hasCycles ? ' in ' + st.total + ' Umläufen' : ''} · Median ${fmtNum(st.med)} s · P5–P95 ${fmtNum(st.p5)}–${fmtNum(st.p95)} s · Min ${fmtNum(st.min)} s · Max ${fmtNum(st.max)} s · σ ${fmtNum(st.sd, 1)} s`;
      if (state.mode === 'cdf' && keys.length) {
        caption += '\nP50 / P95: ' + keys.map(k => { const q = GT.stats(model, sg, k.key); return q.n ? `${k.label} ${fmtNum(GT.percentile(q.durs, 50))} / ${fmtNum(GT.percentile(q.durs, 95))} s` : null; }).filter(Boolean).join(' · ');
      }
      block.querySelector('.caption').textContent = caption;
    });
  }

  /* ---------------- Section 3: position in the cycle ---------------- */
  const rangeText = (lo, hi) => Math.abs(hi - lo) < 0.5 ? '–' : `${fmtNum(lo)}–${fmtNum(hi)} s`;

  function renderTable3() {
    els.table3.innerHTML = '';
    if (!model.hasCycles) { els.claim3.textContent = ''; els.note3.textContent = 'Diese Auswertung braucht Umlaufgrenzen (TX in der Aufzeichnung).'; return; }
    const head = document.createElement('thead');
    head.innerHTML = `<tr><th>Signalgruppe</th><th class="left">Verhalten</th><th class="chart"></th><th>An · Median</th><th>An · P5–P95</th><th>Ab · Median</th><th>Ab · P5–P95</th></tr>`;
    head.querySelector('th.chart').appendChild(R.axis(R.LANE_W, tuMax, tuMax > 100 ? 50 : 10, 14));
    els.table3.appendChild(head);
    const body = document.createElement('tbody');
    els.table3.appendChild(body);
    const groups = [];
    scopeSlices().forEach(slice => {
      if (slice.key != null) { const g = document.createElement('tr'); g.className = 'group'; g.innerHTML = `<td colspan="7">${groupTitle(slice)}</td>`; body.appendChild(g); }
      const byBehaviour = {};
      model.sgs.forEach(sg => {
        const st = GT.stats(model, sg, slice.key), tr = document.createElement('tr');
        tr.innerHTML = `<td><span class="name">${esc(sg.col.name)}</span>${sg.col.beschreibung && sg.col.beschreibung !== sg.col.name ? `<span class="sub">${esc(sg.col.beschreibung)}</span>` : ''}</td>`;
        if (!st.n || !st.hasCycleData) { tr.innerHTML += '<td class="left verdict none">kein Grün</td>' + '<td></td>'.repeat(5); body.appendChild(tr); return; }
        const b = GT.behaviour(st);
        (byBehaviour[b] = byBehaviour[b] || []).push(sg.col.name);
        tr.innerHTML += `<td class="left">${b}</td><td class="chart"></td><td>${fmtNum(st.onMed)} s</td><td>${rangeText(st.onLo, st.onHi)}</td><td>${fmtNum(st.offMed)} s</td><td>${rangeText(st.offLo, st.offHi)}</td>`;
        tr.querySelector('.chart').appendChild(R.lane(st, { xMax: tuMax }));
        body.appendChild(tr);
      });
      groups.push({ slice, byBehaviour });
    });
    els.claim3.innerHTML = groups.map(g => {
      const lines = Object.entries(g.byBehaviour).map(([b, names]) => `<div>${esc(b)}: <span class="mono">${esc(names.join(', '))}</span></div>`).join('');
      return g.slice.key != null ? `<div class="claim-group"><div class="claim-group-label">${esc(g.slice.label)}</div>${lines}</div>` : lines;
    }).join('');
    els.note3.innerHTML = '<b>An / Ab</b> = Sekunden seit Umlaufbeginn (TX = 0) bis Grünbeginn bzw. Grünende. Hellgrüner Balken = Median-Grünfenster; Strich mit Kappen = P5–P95 des jeweiligen Rands; gestrichelte Linie = Median-Umlaufzeit. ' +
      'Zeigt, welcher Rand der Grünzeit sich bewegt – die Grünzeit selbst steht in 1.';
  }

  /* ---------------- Section 4: frequency and share ---------------- */
  function renderTable4() {
    els.table4.innerHTML = '';
    if (!model.hasCycles) { els.claim4.textContent = ''; els.note4.textContent = 'Diese Auswertung braucht Umlaufgrenzen (TX in der Aufzeichnung).'; return; }
    els.table4.innerHTML = `<thead><tr><th>Signalgruppe</th><th class="chart">Umläufe mit Grün</th><th>Anteil</th><th>Grünanteil am Umlauf</th><th>Rot · Median</th><th>Rot · Max</th><th>Rot-Gelb · Gelb</th></tr></thead>`;
    const body = document.createElement('tbody');
    els.table4.appendChild(body);
    const summary = [];
    scopeSlices().forEach(slice => {
      if (slice.key != null) { const g = document.createElement('tr'); g.className = 'group'; g.innerHTML = `<td colspan="7">${groupTitle(slice)}</td>`; body.appendChild(g); }
      const everyCycle = [], onDemand = [];
      model.sgs.forEach(sg => {
        const st = GT.stats(model, sg, slice.key), tr = document.createElement('tr');
        tr.innerHTML = `<td><span class="name">${esc(sg.col.name)}</span>${sg.col.beschreibung && sg.col.beschreibung !== sg.col.name ? `<span class="sub">${esc(sg.col.beschreibung)}</span>` : ''}</td>`;
        if (!st.n) { tr.innerHTML += `<td class="chart dim">0 von ${st.total}</td>` + '<td></td>'.repeat(5); body.appendChild(tr); onDemand.push(`${sg.col.name} (0 %)`); return; }
        const f = Math.min(1, st.cyclesWithGreen / st.total);
        if (f > 0.995) everyCycle.push(sg.col.name); else onDemand.push(`${sg.col.name} (${fmtNum(f * 100)} %)`);
        const trans = sg.redAmber || sg.amber ? `${fmtNum(sg.redAmber)} · ${fmtNum(sg.amber)} s` : '–';
        tr.innerHTML += `<td class="chart"><span class="share-cell"><span class="bar"></span><span class="mono">${st.cyclesWithGreen} von ${st.total}</span></span></td>` +
          `<td>${fmtNum(f * 100, 1)} %</td><td>${fmtNum(st.greenShare * 100)} %</td><td>${fmtNum(st.redMed)} s</td><td>${fmtNum(st.redMax)} s</td><td>${trans}</td>`;
        tr.querySelector('.bar').appendChild(R.shareBar(f));
        body.appendChild(tr);
      });
      summary.push({ slice, everyCycle, onDemand });
    });
    els.claim4.innerHTML = summary.map(l => {
      const a = l.everyCycle.length ? `Grün in jedem Umlauf: ${esc(l.everyCycle.join(', '))}.` : '';
      const b = l.onDemand.length ? ` Nur auf Anforderung: ${esc(l.onDemand.join(', '))}.` : '';
      return `<div>${l.slice.key != null ? `<span class="claim-group-label inline">${esc(l.slice.label)}</span> ` : ''}${a}${b}</div>`;
    }).join('');
    els.note4.innerHTML = '<b>Umläufe mit Grün</b> = Umläufe, in denen die Signalgruppe mindestens einmal Grün zeigt. <b>Grünanteil</b> = Median von Grünzeit ÷ Umlaufzeit. ' +
      '<b>Rot</b> = Dauer des Rot-Zustands zwischen zwei Grünphasen (ohne Rot-Gelb und Gelb); Umläufe ohne Grün verlängern sie. Rot ist nicht die Wartezeit eines Fahrzeugs – die steht im Tab „Wartezeit ab Anforderung“.';
  }

  /* ---------------- Section 5: dark periods ----------------
     Background (VwV-StVO on § 37 paragraph 2): traffic signals must normally stay in operation
     also at night.
     Switching them off is justified only after a check of each case. */
  function darkPeriods(segs) {
    return segs.filter(s => s.cat === 'DUNKEL').map(s => ({ start: s.start, end: s.end, sec: (s.end - s.start) / 1000 }));
  }
  function renderDark() {
    const a = analysis();
    const rows = a.allStats.map(({ col, segs }) => {
      const periods = darkPeriods(segs);
      return { col, periods, total: periods.reduce((s, p) => s + p.sec, 0), longest: periods.reduce((m, p) => Math.max(m, p.sec), 0) };
    }).filter(r => r.periods.length);
    els.darkSection.style.display = rows.length ? '' : 'none';
    if (!rows.length) return;
    const span = (a.tMax - a.tMin) / 1000;
    els.tableDark.innerHTML = '<thead><tr><th>Signalgruppe</th><th>Dunkel gesamt</th><th>Anteil an der Aufzeichnung</th><th>Zeiträume</th><th>Längster Zeitraum</th></tr></thead><tbody>' +
      rows.map(r => `<tr><td><span class="name">${esc(r.col.name)}</span></td><td>${fmtDauer(r.total)}</td><td>${fmtNum(r.total / span * 100, 1)} %</td><td>${r.periods.length}</td><td>${fmtDauer(r.longest)}</td></tr>`).join('') + '</tbody>';
    // The longest periods of the signal group with the most dark time, as links into the cycle
    // check
    const lead = rows.slice().sort((p, q) => q.total - p.total)[0];
    const longest = lead.periods.slice().sort((p, q) => q.sec - p.sec).slice(0, 8).sort((p, q) => p.start - q.start);
    els.claimDark.innerHTML = `Dunkel bei ${rows.length} von ${a.allStats.length} Signalgruppen, längster Zeitraum ${fmtDauer(Math.max(...rows.map(r => r.longest)))}.`;
    els.noteDark.innerHTML = `<b>Längste Zeiträume (${esc(lead.col.name)})</b> – Klick öffnet den Beginn in der Umlaufprüfung:<br>` +
      longest.map(p => `<button type="button" class="action" data-jump-t="${p.start}">${esc(fmtTs(new Date(p.start)))} – ${esc(GZ.format.fmtTimeShort(p.end))} (${fmtDauer(p.sec)})</button>`).join(' ') +
      '<br>Erkannte Zeiträume ohne Signalbild (Zustand „Dunkel“), z. B. Nachtabschaltung oder Programmwechsel. Ein Abschalten von Lichtzeichenanlagen ist nach VwV-StVO zu § 37 Abs. 2 nur nach eingehender Einzelfallprüfung zu verantworten.';
  }

  /* ---------------- Whole tab ---------------- */
  function renderContext() {
    const a = analysis();
    const hm = GZ.format.fmtHm;
    els.context.innerHTML = `${a.knotenName || a.knotenNr ? `<b>${esc(a.knotenName || 'Knoten ' + a.knotenNr)}</b> · ` : ''}${new Date(a.tMin).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })} · ${hm(a.tMin)}–${hm(a.tMax)}` +
      `${model.hasCycles ? ' · ' + model.cycles.filter(c => c.regular).length + ' Umläufe' : ''} · ${model.sgs.length} Signalgruppen · SPL ${esc(a.splList.join(', '))}`;
  }

  function renderAll() {
    if (!model) return;
    renderCycleChart(); renderTable1(); renderTrend(); renderTable3(); renderTable4(); renderDark();
  }

  // Redraw after a size change, a tab switch or a log change. The tables do not depend on the
  // width.
  function refresh() {
    if (!model || !analysis()) return;
    renderCycleChart(); renderTrend();
  }

  /* ---------------- CSV export ---------------- */
  function exportStatsCSV() {
    if (!model) return;
    const head = ['Auswertung', 'Signalgruppe', 'Betriebsart', 'Grünphasen', 'Min (s)', 'Median (s)', 'Max (s)', 'Sigma (s)', 'im Median ± Toleranz (%)',
      'An Median (s)', 'Ab Median (s)', 'Umläufe mit Grün', 'Umläufe gesamt', 'Grünanteil Median (%)', 'Rot Median (s)', 'Rot Max (s)'];
    const rows = [head];
    const num = (v, d = 1) => Number.isFinite(v) ? v.toFixed(d).replace('.', ',') : '';
    scopeSlices().forEach(slice => {
      model.sgs.forEach(sg => {
        const st = GT.stats(model, sg, slice.key);
        const label = slice.key == null ? 'Gesamter Mitschnitt' : slice.label;
        if (!st.n) { rows.push([label, sg.col.name, 'kein Grün', 0]); return; }
        rows.push([label, sg.col.name, !st.enough ? 'zu wenig Daten' : (st.isFixed ? 'Festzeit' : 'verkehrsabhängig'), st.n, num(st.min, 0), num(st.med), num(st.max, 0), num(st.sd), num(st.share * 100),
          num(st.onMed), num(st.offMed), st.cyclesWithGreen, st.total, num(st.greenShare * 100, 0), num(st.redMed), num(st.redMax)]);
      });
    });
    const csv = rows.map(r => r.join(';')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'gruenzeitanalyse_kennzahlen.csv';
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /* ---------------- Entry point after an analysis ---------------- */
  function onAnalyzeComplete() {
    const a = analysis();
    readParams();
    model = GT.build(a);
    slices = GZ.slices.build(a);
    state.scope = 'total'; state.mode = 'time';
    GZ.state.data.statsScope = 'total';
    els.scopeGroup.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.scope === 'total'));
    els.modeGroup.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === 'time'));
    const hourBtn = els.scopeGroup.querySelector('button[data-scope="hour"]');
    hourBtn.disabled = !slices.hoursAvailable;
    hourBtn.title = slices.hoursAvailable ? '' : `Mehr als ${GZ.slices.MAX_HOUR_SLICES} Stunden – nicht darstellbar`;
    const planBtn = els.scopeGroup.querySelector('button[data-scope="spl"]');
    planBtn.disabled = slices.plans.length < 2;
    planBtn.title = slices.plans.length < 2 ? 'Nur ein Signalzeitenplan in der Aufzeichnung' : '';

    const all = model.sgs.flatMap(sg => sg.greens.map(g => g.dur));
    xMaxGreen = Math.max(20, Math.ceil(((all.length ? Math.max(...all) : 20) + 1) / 10) * 10);
    const offs = model.sgs.flatMap(sg => sg.greens.filter(g => g.cycle >= 0).map(g => g.off));
    const tus = model.cycles.filter(c => c.regular).map(c => c.tu);
    tuMax = Math.max(20, Math.ceil(Math.max(...tus, ...offs, 0) / 10) * 10);

    // Start with the signal group whose green time varies most
    const ranked = selectableSgs().map(sg => ({ sg, sd: GT.stats(model, sg, null).sd || 0 })).sort((p, q) => q.sd - p.sd);
    state.selected = ranked.length ? [sgIndex(ranked[0].sg)] : [];

    els.notice.style.display = model.hasCycles ? 'none' : '';
    els.notice.textContent = model.hasCycles ? '' : 'Keine Umlaufgrenzen (TX) in der Aufzeichnung erkannt: Umlaufzeit, Lage im Umlauf und Umläufe mit Grün sind nicht verfügbar.';
    renderContext();
    renderPicker();
    renderAll();
  }

  return { init, onAnalyzeComplete, refresh, exportStatsCSV };
});
