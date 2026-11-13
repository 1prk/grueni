/* GZ.views.wartezeit is the tab "Wartezeit ab Anforderung".
   1  Which detector belongs to which signal group? (automatic by name rule,
      checked against the data, manual override, see GZ.detectors)
   2  How long do requests wait for green? (all signal groups at once)
   3  Wait times over time or as CDF (whole recording, for each signal plan, for each hour)
   4  The longest waits (with log lines around them, if a log is loaded)
   GZ.wartezeitLogic.computeWartezeitEvents does the calculation. */
GZ.define('views.wartezeit', { layer: 'views', deps: ['charts.kit', 'charts.logMarkers', 'charts.report', 'cssom', 'detectors', 'format', 'logs', 'segments', 'slices', 'state', 'stats', 'wartezeitLogic'] }, function (GZ) {
  'use strict';
  const { esc, fmtNum, fmtTs, fmtTimeShort } = GZ.format;
  const D = GZ.detectors;
  const WL = GZ.wartezeitLogic;
  const R = GZ.charts.report;
  const kit = GZ.charts.kit;
  const { parseNumListe } = GZ.stats;

  const VIA_LABEL = { name: 'Name', data: 'Daten', manual: 'manuell' };
  const SG_CLASS_LABEL = { veh: 'Kfz', ped: 'Fuß', bike: 'Rad', transit: 'ÖPNV' };
  const KIND_LABEL = { presence: 'Präsenz', pulse: 'Taster (Impuls)' };
  const CDF_X_MAX = 160;
  const LOG_MARGIN_MS = 60000;

  let els = null;
  let slices = null;
  let results = new Map();   // sg column index -> { events, cancelledTimes, unresolved }
  const state = { scope: 'total', mode: 'time', selected: null };
  const params = { vehWarn: 90, vehLimit: 120, vulnWarn: null, vulnLimit: 85, gapSec: 3, blink: false, excludedPlans: '0,-1,-2' };

  const analysis = () => GZ.state.data.currentAnalysis;
  const entryOf = idx => analysis().allStats.find(s => s.col.index === idx);

  function init(root) {
    // The master data view tells the store when it changes the detector assignment.
    GZ.state.on('detectors:changed', populate);
    els = {
      root,
      context: root.querySelector('#wzContext'),
      scopeGroup: root.querySelector('#wzScopeGroup'),
      empty: root.querySelector('#wzEmpty'),
      content: root.querySelector('#wzContent'),
      claim1: root.querySelector('#wzClaim1'),
      table1: root.querySelector('#wzTable1'),
      unassigned: root.querySelector('#wzUnassigned'),
      note1: root.querySelector('#wzNote1'),
      claim2: root.querySelector('#wzClaim2'),
      table2: root.querySelector('#wzTable2'),
      note2: root.querySelector('#wzNote2'),
      sgPick: root.querySelector('#wzSgPick'),
      modeGroup: root.querySelector('#wzModeGroup'),
      trendLegend: root.querySelector('#wzTrendLegend'),
      trendBlock: root.querySelector('#wzTrendBlock'),
      title4: root.querySelector('#wzTitle4'),
      table4: root.querySelector('#wzTable4'),
      note4: root.querySelector('#wzNote4')
    };
    els.scopeGroup.addEventListener('click', e => {
      const b = e.target.closest('button[data-scope]');
      if (!b || b.disabled) return;
      state.scope = b.dataset.scope;
      els.scopeGroup.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      renderTable2(); renderTrend();
    });
    els.modeGroup.addEventListener('click', e => {
      const b = e.target.closest('button[data-mode]');
      if (!b) return;
      state.mode = b.dataset.mode;
      els.modeGroup.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      renderTrend();
    });
    // Parameters. A change of the limits only redraws.
    // A change of the gap tolerance, green blinking or excluded plans changes the events.
    const bind = (id, apply, recomputeEvents) => root.querySelector(id).addEventListener('input', e => { apply(e.target); if (recomputeEvents) recompute(); renderAfterParams(); });
    const number = (el, min) => { const v = Number(el.value); return Number.isFinite(v) && v >= min ? v : null; };
    bind('#wzParamVehWarn', el => { params.vehWarn = el.value.trim() === '' ? null : number(el, 0); });
    bind('#wzParamVehLimit', el => { const v = number(el, 1); if (v != null) params.vehLimit = v; });
    bind('#wzParamVulnWarn', el => { params.vulnWarn = el.value.trim() === '' ? null : number(el, 0); });
    bind('#wzParamVulnLimit', el => { const v = number(el, 1); if (v != null) params.vulnLimit = v; });
    bind('#wzParamGap', el => { const v = number(el, 0); if (v != null) params.gapSec = v; }, true);
    bind('#wzParamBlink', el => { params.blink = el.checked; }, true);
    bind('#wzParamExcl', el => { params.excludedPlans = el.value; }, true);
    root.addEventListener('click', onAssignmentClick);
    root.addEventListener('change', onAssignmentChange);
  }

  function renderAfterParams() { renderTable2(); renderTrend(); renderTable4(); }

  /* ---------------- Calculation ---------------- */
  function thresholdsOf(entry) {
    return D.sgClass(entry.col) === 'veh' ? { warn: params.vehWarn, limit: params.vehLimit } : { warn: params.vulnWarn, limit: params.vulnLimit };
  }

  // Events of each signal group that has detectors.
  function recompute() {
    const a = analysis();
    if (!a) return;
    results = new Map();
    const exclPlans = parseNumListe(params.excludedPlans);
    D.eligibleSgs(a).forEach(entry => {
      const dets = D.detectorsOf(entry.col.index);
      if (!dets.length) return;
      const hold = dets.every(d => d.kind === 'pulse');
      const occupied = D.occupancy(a, dets);
      const r = WL.computeWartezeitEvents(a.times, a.table.byIndex.get(entry.col.index), occupied, a.splValues, params.blink, params.gapSec, hold, exclPlans);
      r.events.forEach(e => {
        e.plan = e.spl || GZ.slices.UNKNOWN_PLAN;
        e.detector = WL.auslosenderDetektor(dets.map(d => d.col), a.table, e.reqIdx);
      });
      results.set(entry.col.index, { events: r.events, cancelledTimes: r.cancelledTimes, unresolved: r.unresolved, dets });
    });
  }

  // Statistics of one signal group in one slice (key null = whole recording).
  function waitStats(entry, sliceKey) {
    const res = results.get(entry.col.index);
    if (!res) return { none: true };
    const t = thresholdsOf(entry);
    const inSlice = (time, plan) => GZ.slices.contains(sliceKey, time, plan);
    const valid = res.events.filter(e => !e.excluded && inSlice(e.reqTime, e.plan));
    const excluded = res.events.filter(e => e.excluded && inSlice(e.reqTime, e.plan)).length;
    const planOfTime = time => GZ.segments.findSplAt(time, analysis().times, analysis().splValues) || GZ.slices.UNKNOWN_PLAN;
    const cancelled = res.cancelledTimes.filter(tm => inSlice(tm, planOfTime(tm))).length;
    if (!valid.length) return { n: 0, events: valid, excluded, cancelled, t };
    const waits = valid.map(e => e.waitSec);
    const pct = p => GZ.stats.percentile([...waits].sort((x, y) => x - y), p);
    return {
      n: waits.length, events: valid, waits, excluded, cancelled, t,
      med: pct(50), p85: pct(85), p95: pct(95), max: Math.max(...waits),
      nWarn: t.warn != null ? waits.filter(w => w > t.warn && w <= t.limit).length : 0,
      nCrit: waits.filter(w => w > t.limit).length
    };
  }
  const grade = (wait, t) => wait > t.limit ? 'crit' : (t.warn != null && wait > t.warn ? 'warn' : 'ok');

  /* ---------------- Slices ---------------- */
  function scopeSlices() { return state.scope === 'total' ? [{ key: null }] : GZ.slices.forScope(slices, state.scope); }
  function allSlices() { return [...slices.plans, ...slices.hours]; }
  function sliceColor(key) { const s = allSlices().find(x => x.key === key); return s ? GZ.slices.colorOf(slices, s) : 'var(--plan-b)'; }
  function groupTitle(slice) {
    const head = slice.kind === 'hour' ? `${slice.label} Uhr` : `Signalzeitenplan ${slice.key}`;
    return esc(head);
  }

  /* ---------------- 1 · Assignment ---------------- */
  function chipHtml(det, entry) {
    const link = det.links.find(l => l.sg === entry.col.index);
    const sc = D.score(analysis(), det, entry.col.index), pulse = det.kind === 'pulse', bad = !pulse && sc < D.CONTRADICTED;
    const scoreHtml = pulse
      ? '<span class="score" title="Taster haben keine Belegungsdauer – Zuordnung nur über Name oder manuell">Taster</span>'
      : `<span class="score ${bad ? 'bad' : (sc >= D.CONFIRMED ? 'ok' : '')}" title="Anteil der Belegungen, die einen Grünbeginn von ${esc(entry.col.name)} überdecken">${fmtNum(sc * 100)} %</span>`;
    return `<span class="chip ${bad ? 'bad' : ''}"><b>${esc(det.name)}</b><span class="source">${VIA_LABEL[link.via]}</span>${scoreHtml}<button type="button" class="remove" data-act="unlink" data-det="${det.col.index}" data-sg="${entry.col.index}" title="Zuordnung entfernen">×</button></span>`;
  }

  function kindLabel(dets) {
    if (!dets.length) return '–';
    const pulses = dets.filter(d => d.kind === 'pulse').length;
    return pulses === dets.length ? KIND_LABEL.pulse : (pulses ? 'gemischt' : KIND_LABEL.presence);
  }

  function checkHtml(entry, dets) {
    const a = analysis();
    if (D.sgClass(entry.col) === 'transit') return '<span class="inline">Anmeldung über ÖPNV-Detektoren, siehe Tab „ÖPNV“</span>';
    if (!dets.length) return '<span class="inline bad">kein Detektor zugeordnet</span>';
    const bad = dets.filter(d => d.kind === 'presence' && D.score(a, d, entry.col.index) < D.CONTRADICTED);
    if (!bad.length) return `<span class="inline">${dets.every(d => d.kind === 'pulse') ? 'Taster: Zuordnung über den Namen' : 'Daten bestätigen die Zuordnung'}</span>`;
    return bad.map(d => {
      const best = D.bestMatch(a, d), own = D.score(a, d, entry.col.index);
      const target = best ? entryOf(best.sg) : null;
      const moveOk = best && best.score >= D.CONFIRMED && best.sg !== entry.col.index;
      return `<div class="inline bad"><b>${esc(d.name)}</b>: nur ${fmtNum(own * 100)} % der Belegungen enden nach Grün von ${esc(entry.col.name)}; ${moveOk ? `${fmtNum(best.score * 100)} % nach Grün von <b>${esc(target.col.name)}</b>` : 'kein anderer Treffer'}.
        ${moveOk ? `<button type="button" class="action" data-act="move" data-det="${d.col.index}" data-from="${entry.col.index}" data-to="${best.sg}">auf ${esc(target.col.name)} umhängen</button>` : ''}<button type="button" class="action" data-act="unlink" data-det="${d.col.index}" data-sg="${entry.col.index}">entfernen</button></div>`;
    }).join('');
  }

  function renderTable1() {
    const a = analysis();
    els.table1.innerHTML = '<thead><tr><th>Signalgruppe</th><th class="left">Typ</th><th class="left">Detektoren</th><th class="left">Detektortyp</th><th class="left">Prüfung</th></tr></thead>';
    const body = document.createElement('tbody');
    els.table1.appendChild(body);
    const detectors = D.list();
    a.allStats.forEach(entry => {
      const cls = D.sgClass(entry.col), dets = D.detectorsOf(entry.col.index), tr = document.createElement('tr');
      const chips = dets.length ? dets.map(d => chipHtml(d, entry)).join('') : '<span class="dim">–</span>';
      const addable = detectors.filter(d => !D.isLinked(d, entry.col.index));
      const addSelect = cls === 'transit' || !addable.length ? '' :
        `<select data-add-sg="${entry.col.index}"><option value="">Detektor hinzufügen …</option>${addable.map(d => `<option value="${d.col.index}">${esc(d.name)}${d.links.length ? ' (bei ' + esc(d.links.map(l => entryOf(l.sg).col.name).join(', ')) + ')' : ''}</option>`).join('')}</select>`;
      tr.innerHTML = `<td><span class="name">${esc(entry.col.name)}</span>${entry.col.beschreibung && entry.col.beschreibung !== entry.col.name ? `<span class="sub">${esc(entry.col.beschreibung)}</span>` : ''}</td>` +
        `<td class="left sans">${SG_CLASS_LABEL[cls]}</td><td class="left sans">${chips} ${addSelect}</td><td class="left sans">${kindLabel(dets)}</td><td class="left sans">${checkHtml(entry, dets)}</td>`;
      body.appendChild(tr);
    });

    const open = detectors.filter(d => !d.links.length);
    els.unassigned.innerHTML = open.length ? '<table class="unassigned"><thead><tr><th>Nicht zugeordneter Detektor</th><th class="left">Beschreibung</th><th class="left">Befund aus den Daten</th><th class="left">Zuordnen</th></tr></thead><tbody>' +
      open.map(d => {
        const best = D.bestMatch(a, d), ok = best && best.score >= D.CONFIRMED, target = best ? entryOf(best.sg) : null;
        const select = `<select data-assign-det="${d.col.index}"><option value="">Signalgruppe wählen …</option>${D.eligibleSgs(a).map(s => `<option value="${s.col.index}">${esc(s.col.name)}</option>`).join('')}</select>`;
        let finding;
        if (d.ignored) finding = '<span class="dim">ignoriert</span>';
        else if (!best) finding = `<span class="dim">Taster: keine Datenprüfung möglich, Name passt zu keiner Signalgruppe</span>`;
        else if (ok) finding = `${fmtNum(best.score * 100)} % der Belegungen enden nach Grün von <b>${esc(target.col.name)}</b> <span class="dim">(Name passt zu keiner Signalgruppe)</span>` +
          (best.ties.length ? `<br><span class="dim">gleich hoch bei ${esc(best.ties.map(i => entryOf(i).col.name).join(', '))} – läuft parallel, ${esc(target.col.name)} bevorzugt, weil noch ohne Detektor</span>` : '');
        else finding = `kein Treffer – höchstens ${fmtNum(best.score * 100)} % bei ${esc(target.col.name)}`;
        const actions = d.ignored ? `<button type="button" class="action" data-act="unignore" data-det="${d.col.index}">rückgängig</button>`
          : (ok ? `<button type="button" class="action" data-act="link-data" data-det="${d.col.index}" data-to="${best.sg}">Übernehmen: ${esc(target.col.name)}</button>` : '') + select + `<button type="button" class="action" data-act="ignore" data-det="${d.col.index}">ignorieren</button>`;
        return `<tr><td><span class="name">${esc(d.name)}</span></td><td class="left sans dim">${esc(d.desc)}</td><td class="left sans">${finding}</td><td class="left sans">${actions}</td></tr>`;
      }).join('') + '</tbody></table>' : '';

    const links = detectors.flatMap(d => d.links.map(l => ({ d, l })));
    const count = via => links.filter(x => x.l.via === via).length;
    const contradicted = links.filter(({ d, l }) => d.kind === 'presence' && D.score(a, d, l.sg) < D.CONTRADICTED).length;
    const openCount = detectors.filter(d => !d.links.length && !d.ignored).length;
    const parts = [`${count('name')} über den Namen`];
    if (count('data')) parts.push(`${count('data')} aus den Daten`);
    if (count('manual')) parts.push(`${count('manual')} manuell`);
    els.claim1.textContent = !detectors.length ? 'Keine Detektor-Spalten (DET) in den Daten erkannt.'
      : `${detectors.filter(d => d.links.length).length} von ${detectors.length} Detektoren zugeordnet (${parts.join(', ')}).` +
        (contradicted ? ` ${contradicted} Zuordnung${contradicted > 1 ? 'en widersprechen' : ' widerspricht'} den Daten.` : '') +
        (openCount ? ` ${openCount} Detektor${openCount > 1 ? 'en sind' : ' ist'} offen.` : '');
    els.note1.innerHTML = '<b>Namensregeln</b> <span class="rule">IS | DF | RD + {n}[_{m}] → K{n}, R{n}</span> Präsenz · <span class="rule">FT | BT | FTV + {n}[_{m}] → F{n}</span> Taster. ' +
      'Mehrere Detektoren einer Signalgruppe werden mit ODER verknüpft; ein Detektor darf mehreren Signalgruppen zugeordnet sein. Alles andere ordnet die Datenprüfung vor oder Sie manuell. ' +
      '<b>Prüfung</b> = Anteil der Belegungen (≥ 3 s), die einen Grünbeginn der Signalgruppe überdecken: echte Zuordnungen liegen bei 90–100 %, zufällige unter ca. 15 %. Bei Tastern ist keine Datenprüfung möglich. ' +
      'Die Zuordnung wird in der Knotenkonfiguration gespeichert (Tab „Stammdaten LSA“).';
  }

  function assignmentChanged() {
    recompute();
    renderTable1(); renderTable2(); renderPicker(); renderTrend(); renderTable4();
  }
  function detectorByIndex(idx) { return D.list().find(d => d.col.index === Number(idx)); }
  function onAssignmentClick(e) {
    const b = e.target.closest('button[data-act]');
    if (!b || !els.root.contains(b)) return;
    const d = detectorByIndex(b.dataset.det), act = b.dataset.act;
    if (!d) return;
    if (act === 'link-data') D.link(d, Number(b.dataset.to), 'data');
    if (act === 'move') { D.unlink(d, Number(b.dataset.from)); D.link(d, Number(b.dataset.to), 'data'); }
    if (act === 'unlink') D.unlink(d, Number(b.dataset.sg));
    if (act === 'ignore') d.ignored = true;
    if (act === 'unignore') d.ignored = false;
    assignmentChanged();
  }
  function onAssignmentChange(e) {
    const sel = e.target.closest('select');
    if (!sel || !sel.value || !els.root.contains(sel)) return;
    if (sel.dataset.assignDet) D.link(detectorByIndex(sel.dataset.assignDet), Number(sel.value), 'manual');
    else if (sel.dataset.addSg) D.link(detectorByIndex(sel.value), Number(sel.dataset.addSg), 'manual');
    else return;
    assignmentChanged();
  }

  /* ---------------- 2 · Table ---------------- */
  function renderTable2() {
    const a = analysis();
    els.table2.innerHTML = '<thead><tr><th>Signalgruppe</th><th>Anforderungen</th><th>Median</th><th>P85</th><th>P95</th><th>Max</th><th>&gt; Warnung</th><th>&gt; Grenzwert</th><th>Aufgelöst ohne Grün</th><th class="chart" id="wzAxisHead"></th></tr></thead>';
    els.table2.querySelector('#wzAxisHead').appendChild(R.axis(R.CDF_W, CDF_X_MAX, 40, 14));
    const body = document.createElement('tbody');
    els.table2.appendChild(body);
    scopeSlices().forEach(slice => {
      if (slice.key != null) { const g = document.createElement('tr'); g.className = 'group'; g.innerHTML = `<td colspan="10">${groupTitle(slice)}</td>`; body.appendChild(g); }
      a.allStats.forEach(entry => {
        const st = waitStats(entry, slice.key), tr = document.createElement('tr');
        tr.dataset.sg = entry.col.index;
        if (state.selected === entry.col.index) tr.className = 'selected';
        tr.innerHTML = `<td><span class="name">${esc(entry.col.name)}</span>${entry.col.beschreibung && entry.col.beschreibung !== entry.col.name ? `<span class="sub">${esc(entry.col.beschreibung)}</span>` : ''}</td>`;
        if (st.none) tr.innerHTML += `<td class="left sans dim" colspan="9">${D.sgClass(entry.col) === 'transit' ? 'keine Detektoren – siehe Tab „ÖPNV“' : 'kein Detektor zugeordnet (siehe 1)'}</td>`;
        else if (!st.n) tr.innerHTML += `<td>0</td><td class="dim" colspan="8">${st.excluded ? st.excluded + ' Anforderung(en) in ausgeschlossenem SPL' : ''}</td>`;
        else {
          tr.innerHTML += `<td>${st.n}</td><td>${fmtNum(st.med)} s</td><td>${fmtNum(st.p85)} s</td><td>${fmtNum(st.p95)} s</td><td>${fmtNum(st.max)} s</td>` +
            `<td class="${st.nWarn ? 'warn' : 'dim'}">${st.t.warn == null ? '–' : st.nWarn}</td><td class="${st.nCrit ? 'crit' : 'dim'}">${st.nCrit}</td><td class="${st.cancelled ? '' : 'dim'}">${st.cancelled}</td><td class="chart"></td>`;
          tr.querySelector('.chart').appendChild(R.miniCdf(st.waits, { xMax: CDF_X_MAX, warn: st.t.warn, limit: st.t.limit }));
        }
        body.appendChild(tr);
      });
    });
    body.querySelectorAll('tr[data-sg]').forEach(tr => tr.addEventListener('click', () => {
      state.selected = Number(tr.dataset.sg);
      renderPicker(); renderTable2(); renderTrend(); renderTable4();
      els.sgPick.closest('section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));

    // Claim
    const rows = a.allStats.map(entry => ({ entry, st: waitStats(entry, null) })).filter(r => r.st.n);
    const violating = rows.filter(r => r.st.nCrit), fine = rows.filter(r => !r.st.nCrit);
    const missing = a.allStats.filter(e => D.sgClass(e.col) !== 'transit' && !results.has(e.col.index)).map(e => e.col.name);
    let claim = violating.map(r => `${r.entry.col.name} überschreitet den Grenzwert (${r.st.t.limit} s) bei ${r.st.nCrit} von ${r.st.n} Anforderungen`).join('; ');
    if (fine.length) claim += (claim ? '; ' : '') + fine.map(r => `${r.entry.col.name} längste Wartezeit ${fmtNum(r.st.max)} s`).join(', ') + (violating.length ? '' : ' – kein Grenzwert überschritten');
    if (claim) claim += '.';
    if (missing.length) claim += (claim ? ' ' : '') + `Ohne Detektor: ${missing.join(', ')}.`;
    els.claim2.textContent = rows.length ? claim : (claim || 'Noch keine Signalgruppe mit Detektor.');

    const unresolved = [...results.entries()].filter(([, r]) => r.unresolved).map(([idx, r]) => `${entryOf(idx).col.name} (${fmtNum(r.unresolved.durationSec)} s)`);
    els.note2.innerHTML = '<b>Wartezeit</b> = Zeit vom Beginn der Detektorbelegung (bzw. Tastendruck) bei nicht grüner Signalgruppe bis zum Grünbeginn. <b>Aufgelöst ohne Grün</b> = die Belegung endete länger als die Lückentoleranz, bevor Grün kam (nur Präsenzdetektoren). ' +
      'Kurve = Verteilung der Wartezeiten (Anteil 0–100 %), gelb = Warnung, rot = Grenzwert. Die Scheibe richtet sich nach dem Zeitpunkt der Anforderung.' +
      (unresolved.length ? ` Unaufgelöst bis Datenende: ${esc(unresolved.join(', '))}.` : '');
  }

  /* ---------------- 3 · Trend ---------------- */
  function pickableSgs() { return analysis().allStats.filter(e => D.sgClass(e.col) !== 'transit'); }
  function renderPicker() {
    els.sgPick.innerHTML = '';
    pickableSgs().forEach(entry => {
      const label = document.createElement('label');
      label.innerHTML = `<input type="radio" name="wzSg" value="${entry.col.index}" ${state.selected === entry.col.index ? 'checked' : ''}><span class="name">${esc(entry.col.name)}</span>`;
      label.querySelector('input').addEventListener('change', () => { state.selected = entry.col.index; renderTable2(); renderTrend(); renderTable4(); });
      els.sgPick.appendChild(label);
    });
  }

  function renderTimeTrend(host, entry, st, height) {
    const a = analysis(), t = st.t, logs = GZ.logs.visible(a.tMin, a.tMax);
    const runs = GZ.slices.planRuns(a.times, a.splValues, a.tMin, a.tMax);
    const sliceBands = state.scope === 'hour'
      ? slices.hours.map(h => ({ key: h.key, t0: h.t0, t1: Math.min(h.t1, a.tMax), name: h.label }))
      : state.scope === 'spl' ? runs.map(r => ({ key: r.plan, t0: r.t0, t1: r.t1, name: GZ.slices.planLabel(r.plan) })) : [];
    const bands = sliceBands.map((b, i) => ({ t0: b.t0, t1: b.t1, tint: i % 2 === 0 ? 'plain' : null, label: { long: b.name, short: b.name } }));
    const windows = sliceBands.map(b => { const q = waitStats(entry, b.key); return { t0: b.t0, t1: b.t1, med: q.n ? q.med : null, lo: q.med, hi: q.med }; });
    if (state.scope === 'total') windows.push({ t0: a.tMin, t1: a.tMax, med: st.med, lo: st.med, hi: st.med });
    const yMax = Math.ceil(Math.max(t.limit * 1.12, st.max * 1.08) / 10) * 10;
    const hLines = [];
    if (t.warn != null) hLines.push({ y: t.warn, color: 'var(--sig-yellow)', label: `Warnung ${t.warn} s`, labelColor: 'var(--warn-text)' });
    hLines.push({ y: t.limit, color: 'var(--sig-red)', label: `Grenzwert ${t.limit} s`, labelColor: 'var(--crit-text)' });
    const all = results.get(entry.col.index).events;
    const points = all.map(e => {
      const g = e.excluded ? 'ex' : grade(e.waitSec, t);
      return {
        t: e.reqTime, y: e.waitSec, r: g === 'crit' ? 3.8 : (g === 'warn' ? 3.4 : 2.6),
        color: g === 'ex' ? 'var(--text-faint)' : g === 'crit' ? 'var(--sig-red)' : g === 'warn' ? 'var(--sig-yellow)' : 'var(--sig-green)', opacity: g === 'ex' ? .55 : 1,
        tip: `Anforderung ${fmtTimeShort(e.reqTime)} (${esc(e.detector)})<br>Grünbeginn ${fmtTimeShort(e.greenTime)} · ${esc(GZ.slices.planLabel(e.plan))}<br>Wartezeit ${fmtNum(e.waitSec, 1)} s${e.excluded ? '<br>ausgeschlossen (SPL)' : ''}`
      };
    });
    kit.timeChart(host, {
      tMin: a.tMin, tMax: a.tMax, height, yMin: 0, yMax, yStep: yMax > 100 ? 30 : 20,
      bands, dividers: runs.slice(1).map(r => r.t0), hours: state.scope === 'hour' ? slices.hours.map(h => h.t0) : [],
      hLines, windows, points, logs, drawLogs: GZ.charts.logMarkers.draw
    });
  }

  function renderCdfTrend(host, entry, st, height) {
    const t = st.t, xMax = Math.ceil(Math.max(t.limit * 1.12, st.max * 1.05) / 10) * 10;
    const vLines = [];
    if (t.warn != null) vLines.push({ x: t.warn, color: 'var(--sig-yellow)', label: `Warnung ${t.warn} s`, labelColor: 'var(--warn-text)' });
    vLines.push({ x: t.limit, color: 'var(--sig-red)', label: `Grenzwert ${t.limit} s`, labelColor: 'var(--crit-text)' });
    const keys = state.scope === 'total' ? [] : scopeSlices();
    if (!keys.length) { kit.cdfChart(host, { height, xMin: 0, xMax, fill: true, vLines, series: [{ values: st.waits, color: 'var(--sig-green)' }] }); return; }
    const series = [{ values: st.waits, color: 'var(--text-faint)', width: 1.2, dash: '4,3' }];
    keys.forEach(sl => {
      const q = waitStats(entry, sl.key);
      if (!q.n) return;
      series.push({ values: q.waits, color: sliceColor(sl.key), width: 2, tip: `${esc(sl.label)} · n = ${q.n}<br>P50 ${fmtNum(q.med)} s · P85 ${fmtNum(q.p85)} s · P95 ${fmtNum(q.p95)} s` });
    });
    kit.cdfChart(host, { height, xMin: 0, xMax, vLines, series });
  }

  function renderTrend() {
    const a = analysis(), entry = entryOf(state.selected);
    els.trendBlock.innerHTML = ''; els.trendLegend.innerHTML = '';
    if (!entry) return;
    const st = waitStats(entry, null);
    if (st.none || !st.n) {
      els.trendBlock.innerHTML = `<div class="report-empty"><span class="name">${esc(entry.col.name)}</span> – ${st.none ? (D.sgClass(entry.col) === 'transit' ? 'keine Detektoren (siehe Tab „ÖPNV“).' : 'noch kein Detektor zugeordnet – siehe 1.') : 'keine Anforderung ausgewertet.'}</div>`;
      return;
    }
    const keys = state.scope === 'total' ? [] : scopeSlices();
    els.trendLegend.innerHTML = state.mode === 'time'
      ? `<span class="item"><span class="dot u-bg-sig-green"></span>OK</span><span class="item"><span class="dot u-bg-sig-yellow"></span>Warnung</span><span class="item"><span class="dot u-bg-sig-red"></span>Grenzwert überschritten</span><span class="item"><span class="dot u-bg-text-faint-60"></span>ausgeschlossen (SPL)</span><span class="item"><span class="line u-bt-1_4-solid-accent"></span>Median</span><span class="item"><span class="line vertical u-bl-1-dashed-req-marker"></span>Signalprogrammwechsel</span>`
      : (keys.length ? `<span class="item">Anteil der Anforderungen mit höchstens dieser Wartezeit</span>` + keys.map(k => `<span class="item"><span class="line" data-css="border-top:2px solid ${sliceColor(k.key)}"></span>${esc(k.label)}</span>`).join('') + `<span class="item"><span class="line u-bt-1_2-dashed-text-faint"></span>gesamt</span>`
        : `<span class="item"><span class="line u-bt-1_9-solid-sig-green"></span>Anteil der Anforderungen mit höchstens dieser Wartezeit</span>`);
    GZ.cssom.apply(els.trendLegend);
    const dets = results.get(entry.col.index).dets;
    const block = document.createElement('div');
    block.innerHTML = `<div class="trend-head"><span class="name">${esc(entry.col.name)}</span><span class="sub inline">${esc(entry.col.beschreibung && entry.col.beschreibung !== entry.col.name ? entry.col.beschreibung + ' · ' : '')}${esc(dets.map(d => d.name).join(' + '))}</span></div><div class="host"></div><div class="caption"></div>`;
    els.trendBlock.appendChild(block);
    (state.mode === 'time' ? renderTimeTrend : renderCdfTrend)(block.querySelector('.host'), entry, st, 250);
    let caption = `n = ${st.n} Anforderungen · Median ${fmtNum(st.med)} s · P85 ${fmtNum(st.p85)} s · P95 ${fmtNum(st.p95)} s · Max ${fmtNum(st.max)} s`;
    if (state.mode === 'cdf' && keys.length) caption += '\nP50 / P95: ' + keys.map(k => { const q = waitStats(entry, k.key); return q.n ? `${k.label} ${fmtNum(q.med)} / ${fmtNum(q.p95)} s` : null; }).filter(Boolean).join(' · ');
    block.querySelector('.caption').textContent = caption;
  }

  /* ---------------- 4 · Longest waits ---------------- */
  function renderTable4() {
    const a = analysis(), entry = entryOf(state.selected);
    els.title4.textContent = entry ? entry.col.name : '';
    const st = entry ? waitStats(entry, null) : { none: true };
    if (!entry || st.none || !st.n) { els.table4.innerHTML = ''; els.note4.textContent = ''; return; }
    const hasLog = GZ.logs.hasEntries();
    const longest = st.events.map((e, i) => Object.assign({ nr: i + 1 }, e)).sort((p, q) => q.waitSec - p.waitSec).slice(0, 10);
    els.table4.innerHTML = `<thead><tr><th>Nr</th><th>Anforderung</th><th>TX</th><th>Grünbeginn</th><th>SPL</th><th>Wartezeit</th><th class="left">Bewertung</th><th class="left">Detektor</th>${hasLog ? '<th class="left">Log ± 60 s</th>' : ''}</tr></thead><tbody>` +
      longest.map(e => {
        const g = grade(e.waitSec, st.t), tx = WL.txAtTime(e.reqTime, a.cycleStarts);
        let logCell = '';
        if (hasLog) {
          const near = GZ.logs.around(e.reqTime, e.greenTime, LOG_MARGIN_MS);
          const full = near.map(x => `${fmtTimeShort(x.t)} ${x.level} ${x.text}`).join('\n');
          const first = near[0];
          const hasCritical = near.some(x => x.severity === 'critical'), hasError = near.some(x => x.severity === 'error');
          logCell = `<td class="left sans log-cell${hasCritical ? ' has-critical' : hasError ? ' has-error' : ''}" title="${esc(full)}">${near.length ? `<span class="log-count-badge">${near.length}</span> ${esc(first.text.length > 48 ? first.text.slice(0, 47) + '…' : first.text)}` : '<span class="dim">–</span>'}</td>`;
        }
        return `<tr data-t="${e.reqTime}" class="${g === 'crit' ? 'event-crit' : g === 'warn' ? 'event-warn' : ''}"><td>${e.nr}</td><td>${esc(fmtTs(new Date(e.reqTime)))}</td><td>${tx ?? '–'}</td><td>${esc(fmtTs(new Date(e.greenTime)))}</td><td>${esc(e.spl)}</td><td>${fmtNum(e.waitSec, 1)} s</td><td class="left sans">${g === 'crit' ? 'Grenzwert überschritten' : g === 'warn' ? 'Warnung' : 'OK'}</td><td class="left">${esc(e.detector)}</td>${logCell}</tr>`;
      }).join('') + '</tbody>';
    els.table4.querySelectorAll('tr[data-t]').forEach(tr => tr.addEventListener('click', () => GZ.state.command('nav:jumpToTime', { t: Number(tr.dataset.t) })));
    els.note4.textContent = `Die 10 längsten von ${st.n} Anforderungen, absteigend; Nr = Reihenfolge im Mitschnitt. Zeile anklicken: Umlauf in der Umlaufprüfung öffnen.` + (hasLog ? ' Die Log-Spalte zeigt Einträge von 60 s vor der Anforderung bis 60 s nach dem Grünbeginn (Tooltip: alle).' : '');
  }

  /* ---------------- Tab ---------------- */
  function renderContext() {
    const a = analysis(), hm = GZ.format.fmtHm;
    els.context.innerHTML = `${a.knotenName || a.knotenNr ? `<b>${esc(a.knotenName || 'Knoten ' + a.knotenNr)}</b> · ` : ''}${new Date(a.tMin).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })} · ${hm(a.tMin)}–${hm(a.tMax)} · ${a.allStats.length} Signalgruppen · ${D.list().length} Detektoren`;
  }

  function refresh() {
    if (!analysis() || !slices) return;
    if (!D.list().length) return;
    renderTrend(); renderTable4();
  }

  function onAnalyzeComplete() {
    const a = analysis();
    D.init(a);
    slices = GZ.slices.build(a);
    state.scope = 'total'; state.mode = 'time';
    els.scopeGroup.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.scope === 'total'));
    els.modeGroup.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === 'time'));
    const hourBtn = els.scopeGroup.querySelector('button[data-scope="hour"]');
    hourBtn.disabled = !slices.hoursAvailable;
    const planBtn = els.scopeGroup.querySelector('button[data-scope="spl"]');
    planBtn.disabled = slices.plans.length < 2;
    populate();
  }

  // Rebuilds everything after a new analysis or after a loaded configuration.
  function populate() {
    const a = analysis();
    if (!a) return;
    const hasDetectors = D.list().length > 0;
    els.empty.style.display = hasDetectors ? 'none' : '';
    els.content.style.display = hasDetectors ? '' : 'none';
    renderContext();
    if (!hasDetectors) return;
    recompute();
    // Start with the signal group that has the most requests
    const withEvents = [...results.entries()].sort((p, q) => q[1].events.length - p[1].events.length);
    const stillValid = state.selected != null && pickableSgs().some(e => e.col.index === state.selected);
    if (!stillValid) state.selected = withEvents.length ? withEvents[0][0] : (pickableSgs()[0] ? pickableSgs()[0].col.index : null);
    renderTable1(); renderTable2(); renderPicker(); renderTrend(); renderTable4();
  }

  return { init, onAnalyzeComplete, populate, refresh };
});
