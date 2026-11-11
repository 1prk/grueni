/* GZ.views.stammdatenTopologie — sub-tab "Topologie" in "Stammdaten LSA".

   The user draws the intersection in four steps and attaches signal groups and
   detectors to the lanes:
   1. Axes   2. Arms   3. Lanes   4. Connections
   The model and all geometry live in GZ.topology (js/core/topology.js). This
   file only draws it (d3, SVG, units in metres) and handles the input.

   The canvas needs no recording. Signal groups and detectors come from the
   loaded recording when there is one; otherwise names can be typed. */
(function (GZ) {
  'use strict';
  const T = GZ.topology;
  const { esc } = GZ.format;

  const STEPS = [
    { no: 1, title: 'Achsen', hint: '<b>Straßenachsen zeichnen.</b> „Achse zeichnen“ wählen, Punkte anklicken, mit Doppelklick oder Enter beenden. Punkte ziehen; Doppelklick auf die Linie fügt einen Punkt ein.' },
    { no: 2, title: 'Arme', hint: '<b>Zufahrtsarme festlegen.</b> Der Mittelpunkt liegt, wo sich die Achsen kreuzen. Die Haltlinie (rosa Punkt) entlang des Arms ziehen; Namen und Abstand in der Liste ändern.' },
    { no: 3, title: 'Fahrstreifen', hint: '<b>Fahrstreifen je Arm.</b> Zufahrten und Ausfahrten, Typ, Breite, Mittelinsel und Länge von Abbiegestreifen einstellen. Fahrstreifen anklicken und rechts <b>Signalgruppen und Detektoren zuordnen</b>.' },
    { no: 4, title: 'Verbindungen', hint: '<b>Verbindungen zeichnen.</b> Zufahrt anklicken, dann Ausfahrt anklicken (nochmal klicken löscht). „Vorschlag“ erzeugt typische Beziehungen. Signalgruppen werden je Verbindung oder je Fahrstreifen zugeordnet.' }
  ];
  const MANEUVER_LABEL = { straight: 'geradeaus', left: 'links', right: 'rechts', uturn: 'wenden' };
  const CLASS_COLOR = { veh: 'var(--topo-sg-veh)', bike: 'var(--topo-sg-bike)', ped: 'var(--topo-sg-ped)', transit: 'var(--topo-sg-transit)' };
  const f2 = n => Math.round(n * 100) / 100;

  let els = null;
  let svg = null, worldG = null, layers = {}, hudG = null, zoomBehavior = null;
  let tr = d3.zoomIdentity.translate(300, 300).scale(7);
  let step = 1;
  let sel = null;            // { kind:'lane'|'cross'|'axis'|'conn', id }
  let armSel = null;         // key of the arm shown in step 3
  let draft = null;          // axis being drawn: { points:[{x,y}], cursor:{x,y} }
  let derived = null;
  let fitted = false;
let linkStops = false;     // move all stop lines together
  const manualSg = new Set(), manualDet = new Set();

  const M = () => GZ.state.data.topology;

  /* ---------------- Init ---------------- */
  function init(root) {
    els = {
      root,
      subBtns: root.querySelectorAll('.subnav-btn'),
      panePhasen: root.querySelector('#sdPanePhasen'),
      paneTopo: root.querySelector('#sdPaneTopo'),
      steps: root.querySelector('#topoSteps'),
      stepHint: root.querySelector('#topoStepHint'),
      canvas: root.querySelector('#topoCanvas'),
      svg: root.querySelector('#topoSvg'),
      empty: root.querySelector('#topoEmpty'),
      drawBar: root.querySelector('#topoDrawBar'),
      side: root.querySelector('#topoSide')
    };
    els.subBtns.forEach(b => b.addEventListener('click', () => showSub(b.dataset.sub)));
    root.querySelector('#topoExample').addEventListener('click', loadExample);
    root.querySelector('#topoMapExport').addEventListener('click', exportMap);
    root.querySelector('#topoConfigSaveBtn').addEventListener('click', () => GZ.views.stammdatenLsa.saveConfig());
    root.querySelector('#topoConfigLoadInput').addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) GZ.views.stammdatenLsa.loadConfigFile(file);
      e.target.value = '';
    });
    root.querySelector('#topoFit').addEventListener('click', fitView);
    els.linkStops = root.querySelector('#topoLinkStops');
    els.linkStops.addEventListener('change', () => { linkStops = els.linkStops.checked; });
    root.querySelector('#topoZoomIn').addEventListener('click', () => svg.transition().duration(150).call(zoomBehavior.scaleBy, 1.4));
    root.querySelector('#topoZoomOut').addEventListener('click', () => svg.transition().duration(150).call(zoomBehavior.scaleBy, 1 / 1.4));
    root.querySelector('#topoDrawDone').addEventListener('click', finishDraft);
    root.querySelector('#topoDrawCancel').addEventListener('click', cancelDraft);

    els.steps.innerHTML = STEPS.map(s => `<button type="button" class="topo-step" data-step="${s.no}"><span class="no">${s.no}</span>${s.title}</button>`).join('');
    els.steps.addEventListener('click', e => {
      const b = e.target.closest('[data-step]');
      if (b) setStep(Number(b.dataset.step));
    });

    initCanvas();
    initSideEvents();
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', () => { if (isVisible()) renderCanvas(); });
    setStep(1);
  }

  function isVisible() { return !!els && els.paneTopo.style.display !== 'none' && els.canvas.offsetParent !== null; }

  function showSub(name) {
    const topo = name === 'topologie';
    els.panePhasen.style.display = topo ? 'none' : '';
    els.paneTopo.style.display = topo ? '' : 'none';
    els.subBtns.forEach(b => b.classList.toggle('active', b.dataset.sub === name));
    if (topo) refresh();
  }

  // Called from the tab switch and after the configuration was loaded.
  function refresh() {
    if (!els || els.paneTopo.style.display === 'none') return;
    update();
    if (!fitted && isVisible()) { fitView(); fitted = true; }
    renderStepBar();
    renderCanvas();
    renderSide();
  }

  function onAnalyzeComplete() {
    if (isVisible()) renderSide();
  }

  /* ---------------- Model updates ---------------- */
  function update() {
    derived = T.derive(M());
    if (T.ensureDefaults(M(), derived)) derived = T.derive(M());
    validateSelection();
    if (!armSel || !derived.arms.some(a => a.key === armSel)) armSel = derived.arms.length ? derived.arms[0].key : null;
  }

  function validateSelection() {
    if (!sel) return;
    const m = M();
    const ok = sel.kind === 'lane' ? m.lanes.some(l => l.id === sel.id)
      : sel.kind === 'cross' ? m.crosswalks.some(c => c.id === sel.id) && derived.arms.some(a => a.cross && a.cross.cw.id === sel.id)
      : sel.kind === 'axis' ? m.axes.some(a => a.id === sel.id)
      : sel.kind === 'conn' ? m.connections.some(c => c.id === sel.id) : false;
    if (!ok) sel = null;
  }

  function changed(sideToo) {
    update();
    renderCanvas();
    if (sideToo !== false) renderSide();
  }

  function setStep(n) {
    step = n;
    if (draft) cancelDraft(true);
    if (step === 1 && sel && sel.kind !== 'axis') sel = null;
    if (step === 2 && sel) sel = null;
    if (step >= 3 && sel && sel.kind === 'axis') sel = null;
    renderStepBar();
    if (derived) { renderCanvas(); renderSide(); }
  }

  function renderStepBar() {
    els.steps.querySelectorAll('.topo-step').forEach(b => b.classList.toggle('active', Number(b.dataset.step) === step));
    els.stepHint.innerHTML = STEPS[step - 1].hint;
    els.linkStops.closest('label').style.display = step === 2 || step === 3 ? '' : 'none';
  }

  /* ---------------- Canvas ---------------- */
  function initCanvas() {
    svg = d3.select(els.svg);
    svg.attr('tabindex', 0);
    const defs = svg.append('defs');
    defs.append('clipPath').attr('id', 'topoClip').append('rect').attr('id', 'topoClipRect');
    worldG = svg.append('g').attr('class', 'topo-world');
    ['grid', 'walk', 'roads', 'laneFill', 'marks', 'cross', 'conns', 'lanes', 'labels', 'axes', 'handles', 'overlay'].forEach(name => {
      layers[name] = worldG.append('g').attr('class', 'layer-' + name);
    });
    hudG = svg.append('g').attr('class', 't-hud');

    zoomBehavior = d3.zoom().scaleExtent([1.2, 80]).on('zoom', e => {
      tr = e.transform;
      renderCanvas();
    }).on('start', e => { if (e.sourceEvent && e.sourceEvent.type === 'mousedown') els.canvas.classList.add('panning'); })
      .on('end', () => els.canvas.classList.remove('panning'));
    svg.call(zoomBehavior).on('dblclick.zoom', null);
    svg.call(zoomBehavior.transform, tr);

    svg.on('click', onCanvasClick);
    svg.on('dblclick', onCanvasDblClick);
    svg.on('mousemove', e => {
      if (!draft) return;
      draft.cursor = snap(worldOf(e));
      renderOverlay();
    });
  }

  function size() {
    const r = els.svg.getBoundingClientRect();
    return { w: Math.max(r.width, 200), h: Math.max(r.height, 200) };
  }

  function worldOf(e) {
    const [sx, sy] = d3.pointer(e, els.svg);
    return { x: (sx - tr.x) / tr.k, y: -(sy - tr.y) / tr.k };
  }
  const snap = p => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });

  function fitView() {
    const { w, h } = size();
    let pts = [];
    if (derived) {
      derived.axes.forEach(e => pts = pts.concat(e.poly));
      derived.arms.forEach(a => { pts = pts.concat(a.edgeLeft, a.edgeRight); });
    }
    if (!pts.length) pts = [{ x: -70, y: -45 }, { x: 70, y: 45 }];
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const k = Math.max(1.5, Math.min(40, Math.min((w - 80) / Math.max(x1 - x0, 20), (h - 80) / Math.max(y1 - y0, 20))));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(w / 2 - cx * k, h / 2 + cy * k).scale(k));
  }

  /* --- path helpers: world (x east, y north, metres) to SVG (y down) --- */
  const pt = p => `${f2(p.x)},${f2(-p.y)}`;
  const polyD = poly => poly.length ? 'M' + poly.map(pt).join(' L') : '';
  const polyPts = poly => poly.map(pt).join(' ');
  function lanePoly(g) {
    const side = g.dir === 'in' ? 1 : -1;
    const a = T.offsetPoly(g.arm.sub, side * g.inner), b = T.offsetPoly(g.arm.sub, side * g.outer);
    return a.concat(b.reverse());
  }

  /* --- colours --- */
  function sgInfo(name) {
    const a = GZ.state.data.currentAnalysis;
    const hit = a ? a.allStats.find(s => s.col.name === name) : null;
    if (hit) return { cls: GZ.detectors.sgClass(hit.col), index: hit.col.index, desc: hit.col.beschreibung };
    const p = /^([A-Za-z]+)/.exec(name || '');
    const prefix = p ? p[1].toUpperCase() : '';
    return { cls: prefix === 'F' ? 'ped' : prefix === 'R' ? 'bike' : prefix === 'S' ? 'transit' : 'veh', index: null, desc: '' };
  }
  function sgColor(name) {
    const info = sgInfo(name);
    if (info.index != null) {
      const i = GZ.state.data.phases.findIndex(p => p.members.has(info.index));
      if (i >= 0) return GZ.phases.colorForIndex(i);
    }
    return CLASS_COLOR[info.cls];
  }

  /* --- drawing --- */
  function renderCanvas() {
    if (!els || !derived || !isVisible()) return;
    const { w, h } = size();
    worldG.attr('transform', `translate(${f2(tr.x)},${f2(tr.y)}) scale(${tr.k})`);
    renderGrid(w, h);
    renderRoads();
    renderLaneLayers();
    renderCross();
    renderConnections();
    renderLabels();
    renderAxes();
    renderHandles();
    renderOverlay();
    renderHud(w, h);
    els.empty.style.display = M().axes.length || draft ? 'none' : '';
    els.canvas.classList.toggle('drawing', !!draft);
    els.drawBar.style.display = draft ? '' : 'none';
  }

  function renderGrid(w, h) {
    const x0 = -tr.x / tr.k, x1 = (w - tr.x) / tr.k, y1 = tr.y / tr.k, y0 = (tr.y - h) / tr.k;
    const step = tr.k > 9 ? 10 : tr.k > 3 ? 20 : 50;
    let html = '';
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) html += `<line class="${x % (step * 5) === 0 ? 'major' : ''}" x1="${x}" x2="${x}" y1="${-y1}" y2="${-y0}"/>`;
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) html += `<line class="${y % (step * 5) === 0 ? 'major' : ''}" x1="${x0}" x2="${x1}" y1="${-y}" y2="${-y}"/>`;
    layers.grid.attr('class', 'layer-grid t-grid').html(html);
  }

  function junctionPath() {
    const cmds = T.junctionOutline(derived.arms);
    return { cmds, d: cmds.map(c => c.type === 'Z' ? 'Z' : c.type + c.pts.map(pt).join(' ')).join(' ') };
  }

  function renderRoads() {
    const surf = derived.arms.map(arm => ({ arm, s: T.armSurfaces(arm) }));
    const jp = junctionPath();

    // Gehweg: a band beside every arm and a wide stroke along the kerb of the junction.
    let walk = '';
    surf.forEach(({ s: sf }) => { if (sf.walk && sf.walk.length) walk += `<polygon class="t-walkfill" points="${polyPts(sf.walk)}"/>`; });
    if (jp.cmds.length) walk += `<path class="t-walk" d="${jp.d}"/>`;
    layers.walk.html(walk);

    // road surface: junction, median base, one polygon per lane, then islands on top
    let html = '';
    if (jp.cmds.length) html += `<path class="t-road" d="${jp.d}"/>`;
    const dark = [];
    surf.forEach(({ arm, s: sf }) => {
      if (sf.gapBase) html += `<polygon class="t-road" points="${polyPts(sf.gapBase)}"/>`;
      arm.in.concat(arm.out).forEach(g => {
        const o = T.laneOutline(g);
        if (o.pts.length >= 3) html += `<polygon class="t-road" points="${polyPts(o.pts)}"/>`;
      });
      if (sf.island) dark.push(sf.island);
      sf.freed.forEach(poly => dark.push(poly));
    });
    T.freeRightIslands(derived).forEach(i => dark.push(i.polygon));
    // Islands: one kerb outline under all fills, so no line shows where two islands meet.
    dark.forEach(poly => { html += `<polygon class="t-island-edge" points="${polyPts(poly)}"/>`; });
    dark.forEach(poly => { html += `<polygon class="t-island" points="${polyPts(poly)}"/>`; });
    // kerb lines
    jp.cmds.forEach((c, i) => {
      if (c.type !== 'Q') return;
      const prev = jp.cmds[i - 1];
      html += `<path class="t-kerb" d="M${pt(prev.pts[prev.pts.length - 1])} Q${c.pts.map(pt).join(' ')}"/>`;
    });
    surf.forEach(({ s: sf }) => {
      sf.kerbs.forEach(line => { if (line.length > 1) html += `<path class="t-kerb" d="${polyD(line)}"/>`; });
    });
    layers.roads.html(html);

    // markings
    let mk = '';
    const D = T.DEFAULTS;
    derived.arms.forEach(arm => {
      if (arm.sub.length < 2) return;
      const total = arm.subCl[arm.subCl.length - 1];
      const line = (off, cls, lim) => {
        const part = lim != null ? T.subPoly(arm.sub, arm.subCl, 0, Math.min(total, lim)) : arm.sub;
        return part.length > 1 ? `<path class="t-mark ${cls}" d="${polyD(T.offsetPoly(part, off))}"/>` : '';
      };
      const half = arm.gap / 2;
      if (arm.in.length && arm.out.length && arm.gap <= 0.3) mk += line(0, '');
      ['in', 'out'].forEach(dir => {
        const side = dir === 'in' ? 1 : -1;
        const lanes = arm[dir];
        lanes.forEach((g, i) => {
          if (i < lanes.length - 1) {
            const nx = lanes[i + 1];
            const solid = g.lane.type === 'bike' || nx.lane.type === 'bike';
            const cut = g.cut || nx.cut;
            mk += line(side * g.outer, solid ? '' : 'dash', cut ? cut.len : null);
          } else if (!(g.cut)) {
            mk += line(side * (g.outer - 0.2), '');
          }
        });
        // bicycle pictogram on bike lanes
        lanes.forEach(g => {
          if (g.lane.type !== 'bike' || g.path.length < 2) return;
          const len = g.cl[g.cl.length - 1];
          const p = T.pointAt(g.path, g.cl, Math.min(len * 0.5, 12.5));
          const h = dir === 'in' ? { x: -g.arm.dir.x, y: -g.arm.dir.y } : { x: g.arm.dir.x, y: g.arm.dir.y };
          mk += `<g class="t-bike" transform="translate(${f2(p.x)},${f2(-p.y)}) rotate(${f2(T.bearingOf(h.x, h.y))})">` +
            '<ellipse cx="0" cy="-.72" rx=".13" ry=".46"/><ellipse cx="0" cy=".72" rx=".13" ry=".46"/>' +
            '<path d="M0,-.3 L0,.3 M-.34,-.5 L.34,-.5 M-.12,.1 L.12,.1"/></g>';
        });
      });
      void half; void D;
      if (arm.in.length) {
        const a = { x: arm.stopPt.x + arm.normal.x * (arm.gap / 2), y: arm.stopPt.y + arm.normal.y * (arm.gap / 2) };
        let b = { x: arm.cornerLeft.x, y: arm.cornerLeft.y };
        const fr = arm.freeRight ? T.freeRightPair(derived, arm) : null;
        if (fr) b = { x: arm.stopPt.x + arm.normal.x * fr.slip.inner, y: arm.stopPt.y + arm.normal.y * fr.slip.inner };
        mk += `<line class="t-stop" x1="${f2(a.x)}" y1="${f2(-a.y)}" x2="${f2(b.x)}" y2="${f2(-b.y)}"/>`;
      }
    });
    layers.marks.html(mk);
  }

  // Tinted lane areas (bike, bus) and the click areas of the lanes.
  function renderLaneLayers() {
    let fill = '', hit = '';
    const showLanes = step >= 3;
    const src = step === 4 && sel && sel.kind === 'lane' ? M().lanes.find(l => l.id === sel.id) : null;
    derived.arms.forEach(arm => arm.in.concat(arm.out).forEach(g => {
      if (g.arm.sub.length < 2) return;
      const poly = T.laneOutline(g).pts;
      if (poly.length < 3) return;
      if (g.lane.type !== 'vehicle') fill += `<polygon class="t-lane-fill ${g.lane.type}" points="${polyPts(poly)}"/>`;
      if (!showLanes) return;
      let cls = 't-lane-hit';
      if (sel && sel.kind === 'lane' && sel.id === g.lane.id) cls += src && src.dir === 'in' ? ' source' : ' sel';
      else if (src && src.dir === 'in' && g.dir === 'out') cls += ' target';
      hit += `<polygon class="${cls}" data-kind="lane" data-id="${g.lane.id}" points="${polyPts(poly)}"/>`;
    }));
    layers.laneFill.html(fill);
    layers.lanes.html(hit);
  }

  function renderCross() {
    let html = '';
    derived.arms.forEach(arm => {
      const c = arm.cross;
      if (!c) return;
      const w = c.cw.width;
      const isSel = sel && sel.kind === 'cross' && sel.id === c.cw.id;
      // two thin dashed lines (1 m dash, 1 m gap) across the road, "width" apart
      [1, -1].forEach(side => {
        const o = { x: c.dir.x * w / 2 * side, y: c.dir.y * w / 2 * side };
        html += `<path class="t-crossline" d="M${pt({ x: c.a.x + o.x, y: c.a.y + o.y })} L${pt({ x: c.b.x + o.x, y: c.b.y + o.y })}"/>`;
      });
      if (step >= 3) {
        const corners = [
          { x: c.a.x + c.dir.x * w / 2, y: c.a.y + c.dir.y * w / 2 }, { x: c.b.x + c.dir.x * w / 2, y: c.b.y + c.dir.y * w / 2 },
          { x: c.b.x - c.dir.x * w / 2, y: c.b.y - c.dir.y * w / 2 }, { x: c.a.x - c.dir.x * w / 2, y: c.a.y - c.dir.y * w / 2 }
        ];
        html += `<polygon class="t-lane-hit ${isSel ? 'sel' : ''}" data-kind="cross" data-id="${c.cw.id}" points="${polyPts(corners)}"/>`;
      }
    });
    layers.cross.html(html);
  }

  // Lane arrows (pointing up, units in metres). A branch leaves the stem to the left or right.
  function arrowGlyphs(mans) {
    const has = m => mans.includes(m);
    const head = (x, y, rot) => `<path class="t-arrow" transform="translate(${x},${y}) rotate(${rot})" d="M-.55,.15 L0,-.85 L.55,.15 Z"/>`;
    const branch = (sign, fromY) => {
      const g = `<path class="t-arrow-line" d="M0,${fromY} Q0,${fromY - 0.75} ${-0.95 * sign},${fromY - 1.25}"/>` + head(-1.0 * sign, f2(fromY - 1.32), -58 * sign);
      return g;
    };
    let out = '';
    const straight = '<path class="t-arrow" d="M-.19,1.7 L-.19,-.5 L-.68,-.5 L0,-1.75 L.68,-.5 L.19,-.5 L.19,1.7 Z"/>';
    if (has('straight')) {
      out += straight;
      if (has('left')) out += branch(1, 0.55);
      if (has('right')) out += branch(-1, 0.55);
    } else {
      // turn only: the stem runs up to the bend
      const turn = sign => `<path class="t-arrow-line" d="M0,1.7 L0,.35 Q0,-.45 ${-1.0 * sign},-.95"/>` + head(-1.08 * sign, -1.02, -58 * sign);
      if (has('left')) out += turn(1);
      if (has('right')) out += turn(-1);
    }
    return out;
  }

  const LANE_S = { arrow: 3.4, sg: 7.2, sgGap: 1.75 };

  function renderLabels() {
    const showText = tr.k >= 3.5;
    const fs = n => f2(n / tr.k);
    let html = '';
    const m = M();
    derived.arms.forEach(arm => {
      // arm name at the far end
      const p = T.pointAt(arm.path, arm.cl, Math.max(arm.stopDist + 4, arm.length - 6));
      const label = `${arm.approachId} · ${esc(arm.name)}`;
      html += `<text class="t-label dark" x="${f2(p.x)}" y="${f2(-p.y)}" text-anchor="middle" dominant-baseline="central" font-size="${fs(12.5)}" stroke-width="${fs(3)}">${label}</text>`;
      if (step < 3) return;
      arm.in.concat(arm.out).forEach(g => {
        const len = g.cl[g.cl.length - 1];
        const lp = T.pointAt(g.path, g.cl, Math.min(len - 1.5, 22));
        if (showText) html += `<text class="t-label light" x="${f2(lp.x)}" y="${f2(-lp.y)}" text-anchor="middle" dominant-baseline="central" font-size="${fs(9.5)}" stroke-width="${fs(2)}">${g.label}</text>`;
        if (g.dir !== 'in') return;
        // arrows from the connections
        const heading = { x: -g.arm.dir.x, y: -g.arm.dir.y };
        const mans = [...T.laneManeuvers(m, derived, g.lane.id)].filter(x => x !== 'uturn');
        const ap = T.pointAt(g.path, g.cl, LANE_S.arrow);
        if (mans.length) {
          const rot = T.bearingOf(heading.x, heading.y);
          html += `<g transform="translate(${f2(ap.x)},${f2(-ap.y)}) rotate(${f2(rot)})">${arrowGlyphs(mans)}</g>`;
        }
        // signal group pills
        const sgs = laneSgNames(g.lane);
        sgs.forEach((name, i) => {
          const sp = T.pointAt(g.path, g.cl, LANE_S.sg + i * LANE_S.sgGap);
          html += sgPill(sp, name);
        });
        const dets = g.lane.detectors;
        dets.forEach((name, i) => {
          const dp = T.pointAt(g.path, g.cl, LANE_S.sg + sgs.length * LANE_S.sgGap + 1.2 + i * 2.2);
          html += detMark(dp, name, showText, fs);
        });
      });
      // crossing: signal groups on the zebra, detectors beside it
      if (arm.cross) {
        const c = arm.cross, cw = c.cw;
        const len = Math.hypot(c.a.x - c.b.x, c.a.y - c.b.y) || 1;
        const u = { x: (c.a.x - c.b.x) / len, y: (c.a.y - c.b.y) / len };
        cw.sgs.forEach((name, i) => {
          const off = (i - (cw.sgs.length - 1) / 2) * 3;
          html += sgPill({ x: c.center.x + u.x * off, y: c.center.y + u.y * off }, name);
        });
        cw.detectors.forEach((name, i) => {
          const d = len / 2 + 1.6 + i * 2.2;
          html += detMark({ x: c.center.x + u.x * d, y: c.center.y + u.y * d }, name, showText, fs);
        });
      }
    });
    layers.labels.html(html);
  }

  function laneSgNames(lane) {
    const m = M();
    const names = new Set(lane.sgs);
    m.connections.filter(c => c.from === lane.id && c.sg).forEach(c => names.add(c.sg));
    return [...names].sort(GZ.phases.compareSgNames);
  }

  function sgPill(p, name) {
    const w = Math.max(1.9, name.length * 0.72 + 0.8);
    return `<g class="t-sg" transform="translate(${f2(p.x)},${f2(-p.y)})"><rect x="${f2(-w / 2)}" y="-.75" width="${f2(w)}" height="1.5" rx=".75" style="fill:${sgColor(name)}"/><text font-size="1.05">${esc(name)}</text></g>`;
  }
  function detMark(p, name, showText, fs) {
    return `<g class="t-det" transform="translate(${f2(p.x)},${f2(-p.y)})"><rect x="-.7" y="-.7" width="1.4" height="1.4" rx=".25"/>` +
      (showText ? `<text class="t-label dark" x="1.1" y="0" dominant-baseline="central" font-size="${fs(8.5)}" stroke-width="${fs(2)}">${esc(name)}</text>` : '') + '</g>';
  }

  function connPath(c) { return `M${pt(c.p0)} C${pt(c.c0)} ${pt(c.c1)} ${pt(c.p1)}`; }

  function renderConnections() {
    const geoms = T.allLaneGeoms(derived);
    const m = M();
    if (step < 4) {
      // thin dashed guide lines, as on a plan
      layers.conns.html(m.connections.map(conn => {
        const a = geoms.get(conn.from), b = geoms.get(conn.to);
        return a && b ? `<path class="t-guide" d="${connPath(T.connectionCurve(a, b))}"/>` : '';
      }).join(''));
      return;
    }
    let html = '';
    m.connections.forEach(conn => {
      const a = geoms.get(conn.from), b = geoms.get(conn.to);
      if (!a || !b) return;
      const curve = T.connectionCurve(a, b);
      const sg = T.connectionSg(m, conn);
      const color = sg ? sgColor(sg) : '#f1f4f7';
      const isSel = sel && sel.kind === 'conn' && sel.id === conn.id;
      const fromSel = sel && sel.kind === 'lane' && sel.id === conn.from;
      const dim = sel && sel.kind === 'lane' && !fromSel && sel.id !== conn.to;
      const wd = sg ? (isSel || fromSel ? 0.62 : 0.46) : (isSel || fromSel ? 0.46 : 0.3);
      // arrow head at the end
      const tx = curve.h1.x, ty = curve.h1.y;
      const head = [{ x: curve.p1.x, y: curve.p1.y }, { x: curve.p1.x - tx * 1.1 - ty * 0.55, y: curve.p1.y - ty * 1.1 + tx * 0.55 }, { x: curve.p1.x - tx * 1.1 + ty * 0.55, y: curve.p1.y - ty * 1.1 - tx * 0.55 }];
      if (isSel) html += `<path class="t-conn-halo" stroke-width="${wd + 0.5}" d="${connPath(curve)}"/>`;
      html += `<g style="opacity:${dim ? 0.3 : 1}"><path class="t-conn-hit" data-kind="conn" data-id="${conn.id}" d="${connPath(curve)}"/>` +
 `${sg ? `<path class="t-conn-case" stroke-width="${wd + 0.34}" d="${connPath(curve)}"/>` : ''}` +
        `<path class="t-conn ${sg ? '' : 'unassigned'}" stroke="${color}" stroke-width="${wd}" d="${connPath(curve)}"/>` +
        `<polygon points="${polyPts(head)}" fill="${color}"/></g>`;
    });
    layers.conns.html(html);
  }

  function renderAxes() {
    let html = '';
    derived.axes.forEach(e => {
      const isSel = sel && sel.kind === 'axis' && sel.id === e.axis.id;
      if (step === 1) {
        html += `<path class="t-axis-hit" data-kind="axis" data-id="${e.axis.id}" stroke-width="${f2(14 / tr.k)}" d="${polyD(e.poly)}"/>`;
        html += `<path class="t-axis ${isSel ? 'sel' : ''}" stroke-width="${f2((isSel ? 2.6 : 1.8) / tr.k)}" d="${polyD(e.poly)}"/>`;
      } else if (step === 2) {
        html += `<path class="t-axis" stroke-width="${f2(1.2 / tr.k)}" stroke-dasharray="${f2(6 / tr.k)} ${f2(5 / tr.k)}" opacity=".7" d="${polyD(e.poly)}"/>`;
      }
    });
    layers.axes.html(html);
  }

  function renderHandles() {
    const r = 5.5 / tr.k, sw = 1.8 / tr.k;
    const data = [];
    if (step === 1 && !draft) {
      M().axes.forEach(a => a.points.forEach((p, i) => data.push({ key: `p:${a.id}:${i}`, type: 'point', axisId: a.id, i, x: p.x, y: p.y, sel: sel && sel.kind === 'axis' && sel.id === a.id })));
    }
    if (step === 2 && derived.center && !draft) data.push({ key: 'center', type: 'center', x: derived.center.x, y: derived.center.y });
    if ((step === 2 || step === 3) && !draft) derived.arms.forEach(arm => data.push({ key: 'stop:' + arm.key, type: 'stop', armKey: arm.key, x: arm.stopPt.x, y: arm.stopPt.y }));

    const g = layers.handles.selectAll('circle.topo-handle').data(data, d => d.key);
    g.join('circle')
      .attr('class', d => 'topo-handle ' + d.type + (d.sel ? ' sel' : ''))
      .attr('cx', d => f2(d.x)).attr('cy', d => f2(-d.y))
      .attr('r', d => d.type === 'center' ? r * 1.4 : r).attr('stroke-width', sw)
      .call(d3.drag().container(els.svg)
        .on('start', e => { e.sourceEvent.stopPropagation(); })
        .on('drag', (e, d) => onHandleDrag(e, d))
        .on('end', () => changed(true)));
    g.each(function (d) {
      d3.select(this).on('dblclick', ev => {
        ev.stopPropagation();
        if (d.type === 'point') removePoint(d.axisId, d.i);
      }).on('click', ev => {
        ev.stopPropagation();
        if (d.type === 'point') { sel = { kind: 'axis', id: d.axisId }; renderCanvas(); renderSide(); }
      });
    });
  }

  function onHandleDrag(e, d) {
    const p = snap(worldOf(e.sourceEvent));
    const m = M();
    if (d.type === 'point') {
      const axis = m.axes.find(a => a.id === d.axisId);
      if (!axis) return;
      axis.points[d.i] = { x: p.x, y: p.y };
      if (!sel || sel.id !== d.axisId) sel = { kind: 'axis', id: d.axisId };
    } else if (d.type === 'center') {
      m.center = { x: p.x, y: p.y };
    } else if (d.type === 'stop') {
      const arm = derived.arms.find(a => a.key === d.armKey);
      if (!arm) return;
      const pr = T.projectOnPoly(arm.path, arm.cl, worldOf(e.sourceEvent));
      setStopDist(arm, pr.s);
    }
    update();
    renderCanvas();
    // keep the same element data for the running drag
    d.x = d.type === 'stop' ? derived.arms.find(a => a.key === d.armKey).stopPt.x : p.x;
    d.y = d.type === 'stop' ? derived.arms.find(a => a.key === d.armKey).stopPt.y : p.y;
  }

  // Sets the stop line distance of one arm. With "koppeln" every arm moves by the same amount.
  function setStopDist(arm, dist) {
    const clamp = (a, v) => Math.round(Math.max(2, Math.min(a.length - 3, v)) * 10) / 10;
    const delta = dist - arm.stopDist;
    const targets = linkStops ? derived.arms.map(a => ({ a, v: a.stopDist + delta })) : [{ a: arm, v: dist }];
    targets.forEach(t => { (M().arms[t.a.key] || (M().arms[t.a.key] = {})).stopDist = clamp(t.a, t.v); });
  }

  function renderOverlay() {
    let html = '';
    if (draft) {
      const pts = draft.points.concat(draft.cursor ? [draft.cursor] : []);
      if (pts.length >= 2) {
        const poly = T.cleanPoly(T.sampleSpline(pts, 1));
        html += `<path class="t-axis" stroke-width="${f2(2 / tr.k)}" stroke-dasharray="${f2(6 / tr.k)} ${f2(4 / tr.k)}" d="${polyD(poly)}"/>`;
      }
      draft.points.forEach(p => { html += `<circle class="topo-handle" cx="${f2(p.x)}" cy="${f2(-p.y)}" r="${f2(5 / tr.k)}" stroke-width="${f2(1.8 / tr.k)}" style="pointer-events:none"/>`; });
    }
    if (step === 2 && derived.center) {
      const c = derived.center, s = 1.6;
      html += `<path class="t-center-mark" stroke-width="${f2(2 / tr.k)}" d="M${f2(c.x - s)},${f2(-c.y)} L${f2(c.x + s)},${f2(-c.y)} M${f2(c.x)},${f2(-c.y - s)} L${f2(c.x)},${f2(-c.y + s)}" style="pointer-events:none"/>`;
    }
    layers.overlay.html(html);
  }

  function renderHud(w, h) {
    const nice = [1, 2, 5, 10, 20, 50, 100, 200];
    const len = nice.find(n => n * tr.k >= 70) || 200;
    const px = len * tr.k;
    hudG.html(
      `<g transform="translate(${w - px - 20},${h - 22})"><path class="bar" d="M0,-5 L0,0 L${px},0 L${px},-5"/><text x="${px / 2}" y="-8" text-anchor="middle">${len} m</text></g>` +
      `<g transform="translate(${w - 34},34)"><circle r="15" fill="var(--bg-surface)" stroke="var(--border-strong)"/><path d="M0,-11 L5,5 L0,2 L-5,5 Z" fill="var(--text-muted)"/><text y="-17" text-anchor="middle" font-weight="700">N</text></g>`
    );
  }

  /* ---------------- Canvas input ---------------- */
  function onCanvasClick(e) {
    if (e.defaultPrevented) return;
    if (draft) { draftAdd(snap(worldOf(e))); return; }
    const t = e.target.closest ? e.target.closest('[data-kind]') : null;
    if (!t) { if (sel) { sel = null; renderCanvas(); renderSide(); } return; }
    const kind = t.dataset.kind, id = t.dataset.id;
    if (kind === 'arm') { armSel = id; if (step >= 3) renderSide(); return; }
    if (kind === 'lane' && step === 4) {
      const lane = M().lanes.find(l => l.id === id);
      const cur = sel && sel.kind === 'lane' ? M().lanes.find(l => l.id === sel.id) : null;
      if (lane && lane.dir === 'out' && cur && cur.dir === 'in') {
        const ex = M().connections.find(c => c.from === cur.id && c.to === lane.id);
        if (ex) T.removeConnection(M(), ex.id); else T.addConnection(M(), cur.id, lane.id);
        changed(true);
        return;
      }
    }
    sel = { kind, id };
    if (kind === 'lane') { const l = M().lanes.find(x => x.id === id); if (l) armSel = l.armKey; }
    if (kind === 'cross') { const c = M().crosswalks.find(x => x.id === id); if (c) armSel = c.armKey; }
    renderCanvas();
    renderSide();
  }

  function onCanvasDblClick(e) {
    if (draft) { e.preventDefault(); finishDraft(); return; }
    if (step !== 1) return;
    const t = e.target.closest ? e.target.closest('[data-kind="axis"]') : null;
    if (!t) return;
    const axis = M().axes.find(a => a.id === t.dataset.id);
    if (!axis) return;
    const entry = derived.axes.find(x => x.axis.id === axis.id);
    const w = worldOf(e);
    const pr = T.projectOnPoly(entry.poly, T.cumLen(entry.poly), w);
    const seg = entry.poly[Math.min(pr.seg, entry.poly.length - 1)].seg;
    axis.points.splice(seg + 1, 0, snap({ x: pr.x, y: pr.y }));
    sel = { kind: 'axis', id: axis.id };
    changed(true);
  }

  function removePoint(axisId, i) {
    const axis = M().axes.find(a => a.id === axisId);
    if (!axis) return;
    if (axis.points.length <= 2) T.removeAxis(M(), axisId);
    else axis.points.splice(i, 1);
    changed(true);
  }

  /* --- drawing an axis --- */
  function startDraft() {
    if (step !== 1) setStep(1);
    sel = null;
    draft = { points: [], cursor: null };
    els.svg.focus();
    renderCanvas(); renderSide();
  }
  function draftAdd(p) {
    const last = draft.points[draft.points.length - 1];
    if (last && Math.hypot(last.x - p.x, last.y - p.y) < 0.05) return;
    draft.points.push(p);
    renderCanvas();
  }
  function finishDraft() {
    if (!draft) return;
    const pts = draft.points;
    draft = null;
    if (pts.length >= 2) {
      const axis = T.addAxis(M(), pts);
      sel = { kind: 'axis', id: axis.id };
    }
    changed(true);
  }
  function cancelDraft(silent) {
    draft = null;
    if (!silent) changed(true);
  }

  function onKey(e) {
    if (!isVisible()) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    if (e.key === 'Escape' && draft) { cancelDraft(); return; }
    if (e.key === 'Enter' && draft) { finishDraft(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
      if (sel.kind === 'axis') { T.removeAxis(M(), sel.id); sel = null; changed(true); }
      else if (sel.kind === 'conn') { T.removeConnection(M(), sel.id); sel = null; changed(true); }
    }
  }

  /* ---------------- Inspector ---------------- */
  function renderSide() {
    if (!els || !derived || !isVisible()) return;
    const m = M();
    let html = `<div class="ts-sec"><div class="ts-title">Knoten</div>
      <div class="ts-row"><label>Bezeichnung</label><input type="text" data-field="topoName" value="${esc(m.name)}" placeholder="z. B. Hauptstr. / Querstr."></div></div>`;
    if (step === 1) html += sideAxes();
    if (step === 2) html += sideArms();
    if (step === 3) html += sideLanes();
    if (step === 4) html += sideConnections();
    if (step >= 3) html += sideAssign();
    if (step === 4) html += sideCoverage();
    els.side.innerHTML = html;
  }

  function sideAxes() {
    const m = M();
    const rows = m.axes.map(a => `<div class="ts-item ${sel && sel.kind === 'axis' && sel.id === a.id ? 'sel' : ''}" data-action="axis-select" data-id="${a.id}">
        <input type="text" data-field="axisName" data-id="${a.id}" value="${esc(a.name)}">
        <span class="ts-note">${a.points.length} Pkt.</span>
        <button type="button" class="x" data-action="axis-del" data-id="${a.id}" title="Achse löschen">✕</button></div>`).join('');
    return `<div class="ts-sec"><div class="ts-title">Achsen</div>
      <div class="ts-btns" style="margin-bottom:10px">
        <button type="button" class="primary" data-action="axis-new" ${draft ? 'disabled' : ''}>+ Achse zeichnen</button>
      </div>
      <div class="ts-list">${rows || '<div class="ts-note">Noch keine Achse.</div>'}</div>
      <div class="ts-note" style="margin-top:10px">Die Achse legt Verlauf und Länge der Straße fest. Zwei sich kreuzende Achsen ergeben vier Arme. Eine Achse, die an einer anderen endet (Einmündung), ergibt drei Arme.</div></div>`;
  }

  function sideArms() {
    const m = M();
    const c = derived.center;
    const rows = derived.arms.map(arm => `<div class="ts-row" style="gap:6px">
        <span class="ts-man">${arm.approachId}</span>
        <input type="text" data-field="armName" data-key="${arm.key}" value="${esc(arm.name)}" style="min-width:0">
        <input type="number" step="0.5" min="2" data-field="stopDist" data-key="${arm.key}" value="${f2(arm.stopDist)}" title="Abstand der Haltlinie vom Mittelpunkt in m">
        <span class="ts-note">m</span></div>`).join('');
    return `<div class="ts-sec"><div class="ts-title">Mittelpunkt ${m.center ? '<button type="button" data-action="center-auto" style="font-size:11px;padding:2px 8px">Automatisch</button>' : ''}</div>
      <div class="ts-note">${c ? (m.center ? 'Von Hand gesetzt (gelben Punkt ziehen).' : 'Automatisch aus dem Kreuzungspunkt der Achsen. Der gelbe Punkt lässt sich ziehen.') : 'Kein Mittelpunkt: mindestens eine Achse zeichnen (Schritt 1).'}</div></div>
      <div class="ts-sec"><div class="ts-title">Arme <span class="ts-note">Name · Haltlinie</span></div>${rows || '<div class="ts-note">Noch keine Arme.</div>'}
      <div class="ts-note">Die Nummer ist die Zufahrts-ID (im Uhrzeigersinn ab Nord). Haltlinien lassen sich einzeln ziehen oder mit „Haltlinien koppeln“ (unten links im Plan) gemeinsam verschieben.</div></div>`;
  }

  function sideLanes() {
    const m = M();
    if (!derived.arms.length) return '<div class="ts-sec"><div class="ts-note">Noch keine Arme. Zuerst Achsen zeichnen (Schritt 1).</div></div>';
    const arm = derived.arms.find(a => a.key === armSel) || derived.arms[0];
    const chips = derived.arms.map(a => `<button type="button" class="ts-chip ${a.key === arm.key ? 'on' : ''}" data-action="arm-select" data-key="${a.key}">${a.approachId} ${esc(a.name)}</button>`).join('');
    const stepper = (dir, label) => `<div class="ts-row"><label>${label}</label><span class="ts-stepper">
        <button type="button" data-action="lanes-dec" data-key="${arm.key}" data-dir="${dir}">−</button><b>${arm[dir].length}</b>
        <button type="button" data-action="lanes-inc" data-key="${arm.key}" data-dir="${dir}">+</button></span></div>`;
    const laneRow = g => {
      const n = arm[g.dir].length;
      const canCut = n >= 2 && (g.index === 0 || g.index === n - 1);
      const cutTip = g.index === 0 ? 'Abbiegestreifen: endet nach dieser Länge mit Verzug, die freie Breite wird Mittelinsel' : 'Abbiegestreifen: endet nach dieser Länge mit Verzug, die freie Breite wird Gehweg';
      return `<div class="ts-item ${sel && sel.kind === 'lane' && sel.id === g.lane.id ? 'sel' : ''}" data-action="lane-select" data-id="${g.lane.id}" style="flex-wrap:wrap">
        <b style="min-width:24px">${g.label}</b>
        <select data-field="laneType" data-id="${g.lane.id}">${Object.entries(T.LANE_TYPES).map(([k, v]) => `<option value="${k}" ${g.lane.type === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
        <input type="number" step="0.05" min="1" max="6" style="width:62px" data-field="laneWidth" data-id="${g.lane.id}" value="${g.lane.width}"><span class="ts-note">m</span>
        ${canCut ? `<span class="ts-note" style="flex-basis:100%;display:flex;align-items:center;gap:6px" title="${cutTip}">Länge <input type="number" step="1" min="5" style="width:62px" data-field="laneLength" data-id="${g.lane.id}" value="${g.lane.length || ''}" placeholder="ganz"> m (leer = bis Armende)</span>` : ''}</div>`;
    };
    const cw = arm.cross ? arm.cross.cw : null;
    return `<div class="ts-sec"><div class="ts-title">Arm</div><div class="ts-chips">${chips}</div></div>
      <div class="ts-sec"><div class="ts-title">Fahrstreifen · ${esc(arm.name)}</div>
        ${stepper('in', 'Zufahrten')}${stepper('out', 'Ausfahrten')}
        <div class="ts-row"><label>Mittelinsel</label><input type="number" step="0.5" min="0" max="12" data-field="gap" data-key="${arm.key}" value="${arm.gap}" title="Breite zwischen Zu- und Ausfahrt. 0 = keine Insel"><span class="ts-note">m breit</span></div>
        ${arm.gap > 0.3 ? `<div class="ts-row"><label></label><input type="number" step="1" min="5" data-field="islandLen" data-key="${arm.key}" value="${arm.islandLen}"><span class="ts-note">m lang</span></div>` : ''}
        <div class="ts-row"><label>Freie Rechtsabb.</label><input type="checkbox" data-field="freeRight" data-key="${arm.key}" ${arm.freeRight ? 'checked' : ''} ${T.freeRightPair(derived, arm) ? '' : 'disabled'}><span class="ts-note">${T.freeRightPair(derived, arm) ? 'Dreiecksinsel, Rechtsabbiegestreifen' : 'braucht mind. 2 Zufahrten'}</span></div>
        <div class="ts-row"><label>Fußgängerfurt</label><input type="checkbox" data-field="cross" data-key="${arm.key}" ${cw ? 'checked' : ''}>
          ${cw ? `<input type="number" step="0.5" min="1.5" max="8" data-field="crossWidth" data-id="${cw.id}" value="${cw.width}"><span class="ts-note">m Linienabstand</span>` : ''}</div>
        <div class="ts-list" style="margin-top:6px">${arm.in.map(laneRow).join('')}${arm.out.map(laneRow).join('')}</div>
        ${cw ? `<div class="ts-list" style="margin-top:4px"><div class="ts-item ${sel && sel.kind === 'cross' && sel.id === cw.id ? 'sel' : ''}" data-action="cross-select" data-id="${cw.id}"><b class="grow">Fußgängerfurt</b></div></div>` : ''}
      </div>`;
  }

  function laneTitle(lane) {
    const g = T.allLaneGeoms(derived).get(lane.id);
    return g ? `${g.arm.name} · ${g.dir === 'in' ? 'Zufahrt' : 'Ausfahrt'} ${g.index + 1}` : lane.id;
  }

  function sideConnections() {
    const m = M();
    const geoms = T.allLaneGeoms(derived);
    const label = id => { const g = geoms.get(id); return g ? `${esc(g.arm.name)} ${g.label}` : id; };
    const sgNames = allSgNames();
    const rows = m.connections.map(c => {
      const a = geoms.get(c.from), b = geoms.get(c.to);
      if (!a || !b) return '';
      const man = MANEUVER_LABEL[T.connectionManeuver(a, b)];
      const cur = T.connectionSg(m, c);
      const opts = ['<option value="">– von Fahrstreifen –</option>'].concat(sgNames.map(n => `<option value="${esc(n)}" ${c.sg === n ? 'selected' : ''}>${esc(n)}</option>`)).join('');
      return `<div class="ts-item ${sel && sel.kind === 'conn' && sel.id === c.id ? 'sel' : ''}" data-action="conn-select" data-id="${c.id}" style="flex-wrap:wrap">
        <span class="ts-dot" style="background:${cur ? sgColor(cur) : '#9aa5b1'}"></span>
        <span class="grow" title="${label(c.from)} → ${label(c.to)}">${label(c.from)} → ${label(c.to)}</span>
        <span class="ts-note">${man}</span>
        <button type="button" class="x" data-action="conn-del" data-id="${c.id}" title="Verbindung löschen">✕</button>
        <select data-field="connSg" data-id="${c.id}" style="flex-basis:100%">${opts}</select></div>`;
    }).join('');
    const has = m.lanes.some(l => l.dir === 'in');
    return `<div class="ts-sec"><div class="ts-title">Verbindungen <span class="ts-note">${m.connections.length}</span></div>
      <div class="ts-btns" style="margin-bottom:10px">
        <button type="button" class="primary" data-action="conn-propose" ${has ? '' : 'disabled'}>Vorschlag erzeugen</button>
        <button type="button" data-action="conn-clear" ${m.connections.length ? '' : 'disabled'}>Alle löschen</button></div>
      <div class="ts-list">${rows || '<div class="ts-note">Noch keine Verbindung. Zufahrt anklicken, dann Ausfahrt anklicken.</div>'}</div></div>`;
  }

  /* --- assignment (signal groups and detectors) --- */
  function recordingSgs() {
    const a = GZ.state.data.currentAnalysis;
    return a ? a.allStats.map(s => s.col.name) : [];
  }
  function usedSgNames() {
    const m = M(), set = new Set();
    m.lanes.forEach(l => l.sgs.forEach(n => set.add(n)));
    m.crosswalks.forEach(c => c.sgs.forEach(n => set.add(n)));
    m.connections.forEach(c => { if (c.sg) set.add(c.sg); });
    return set;
  }
  function allSgNames() {
    return [...new Set([...recordingSgs(), ...usedSgNames(), ...manualSg])].sort(GZ.phases.compareSgNames);
  }
  function detectorOptions() {
    const a = GZ.state.data.currentAnalysis;
    const names = new Map();
    GZ.detectors.list().forEach(d => {
      const links = a ? d.links.map(l => (a.allStats.find(s => s.col.index === l.sg) || { col: {} }).col.name).filter(Boolean) : [];
      names.set(d.name, { name: d.name, links });
    });
    const m = M();
    const add = n => { if (!names.has(n)) names.set(n, { name: n, links: [] }); };
    m.lanes.forEach(l => l.detectors.forEach(add));
    m.crosswalks.forEach(c => c.detectors.forEach(add));
    manualDet.forEach(add);
    return [...names.values()].sort((x, y) => x.name.localeCompare(y.name, 'de', { numeric: true }));
  }

  function selectedTarget() {
    if (!sel) return null;
    const m = M();
    if (sel.kind === 'lane') return m.lanes.find(l => l.id === sel.id) || null;
    if (sel.kind === 'cross') return m.crosswalks.find(c => c.id === sel.id) || null;
    return null;
  }

  function sideAssign() {
    const target = selectedTarget();
    if (!target) return `<div class="ts-sec"><div class="ts-title">Zuordnung</div><div class="ts-note">Einen Fahrstreifen oder eine Furt anklicken, um Signalgruppen und Detektoren zuzuordnen.</div></div>`;
    const isCross = sel.kind === 'cross';
    const title = isCross ? `${(derived.arms.find(a => a.key === target.armKey) || {}).name || ''} · Fußgängerfurt` : laneTitle(target);
    const usage = {};
    const m = M();
    m.lanes.concat(m.crosswalks).forEach(x => (x.sgs || []).forEach(n => { usage[n] = (usage[n] || 0) + 1; }));
    const dusage = {};
    m.lanes.concat(m.crosswalks).forEach(x => (x.detectors || []).forEach(n => { dusage[n] = (dusage[n] || 0) + 1; }));
    const sgChip = n => {
      const on = target.sgs.includes(n);
      const info = sgInfo(n);
      const title = info.desc && info.desc !== n ? `${n} – ${info.desc}` : n;
      return `<button type="button" class="ts-chip ${on ? 'on' : ''}" style="--chip:${sgColor(n)}" data-action="sg-toggle" data-name="${esc(n)}" title="${esc(title)}">${esc(n)}${usage[n] ? `<small>${usage[n]}</small>` : ''}</button>`;
    };
    // proposals: detectors that the detector assignment already links to the chosen signal groups
    const a = GZ.state.data.currentAnalysis;
    const dets = detectorOptions();
    const proposed = new Set();
    target.sgs.forEach(n => {
      const info = sgInfo(n);
      if (a && info.index != null) GZ.detectors.detectorsOf(info.index).forEach(d => { if (!target.detectors.includes(d.name)) proposed.add(d.name); });
    });
    const detChip = d => {
      const on = target.detectors.includes(d.name);
      const hint = !on && proposed.has(d.name);
      const tt = d.links.length ? `${d.name} → ${d.links.join(', ')}` : d.name;
      return `<button type="button" class="ts-chip ${on ? 'on' : ''} ${hint ? 'hint' : ''}" data-action="det-toggle" data-name="${esc(d.name)}" title="${esc(tt)}">${esc(d.name)}${dusage[d.name] ? `<small>${dusage[d.name]}</small>` : ''}</button>`;
    };
    const sgs = allSgNames();
    const ordered = dets.slice().sort((x, y) => (proposed.has(y.name) ? 1 : 0) - (proposed.has(x.name) ? 1 : 0));
    return `<div class="ts-sec"><div class="ts-title">Zuordnung · ${esc(title)}</div>
      <div class="ts-title" style="margin-top:4px">Signalgruppen</div>
      <div class="ts-chips">${sgs.map(sgChip).join('') || '<span class="ts-note">Keine Signalgruppen – Aufzeichnung laden oder Name eingeben.</span>'}</div>
      <div class="ts-add"><input type="text" data-field="sgAdd" placeholder="Signalgruppe hinzufügen (z. B. K5)"><button type="button" data-action="sg-add">+</button></div>
      <div class="ts-title" style="margin-top:16px">Detektoren</div>
      <div class="ts-chips">${ordered.map(detChip).join('') || '<span class="ts-note">Keine Detektoren in der Aufzeichnung – Name eingeben.</span>'}</div>
      <div class="ts-add"><input type="text" data-field="detAdd" placeholder="Detektor hinzufügen (z. B. DF3)"><button type="button" data-action="det-add">+</button></div>
      <div class="ts-note" style="margin-top:10px">Die kleine Zahl zeigt, auf wie vielen Spuren der Eintrag schon verwendet wird. Gestrichelt: der Detektor ist im Tab „Wartezeit“ bereits mit einer gewählten Signalgruppe verknüpft.</div></div>`;
  }

  function sideCoverage() {
    const used = new Set();
    const m = M();
    m.lanes.concat(m.crosswalks).forEach(x => x.sgs.forEach(n => used.add(n)));
    m.connections.forEach(c => { if (c.sg) used.add(c.sg); });
    const rec = recordingSgs();
    if (!rec.length) return '';
    const missing = rec.filter(n => !used.has(n)).sort(GZ.phases.compareSgNames);
    const usedDet = new Set();
    m.lanes.concat(m.crosswalks).forEach(x => x.detectors.forEach(n => usedDet.add(n)));
    const missingDet = GZ.detectors.list().map(d => d.name).filter(n => !usedDet.has(n));
    const list = arr => arr.length ? arr.slice(0, 40).join(', ') + (arr.length > 40 ? ' …' : '') : '–';
    return `<div class="ts-sec"><div class="ts-title">Abdeckung</div>
      <div class="ts-note ${missing.length ? 'warn' : ''}"><b>Signalgruppen ohne Fahrstreifen (${missing.length}):</b> ${esc(list(missing))}</div>
      ${GZ.detectors.list().length ? `<div class="ts-note ${missingDet.length ? 'warn' : ''}" style="margin-top:6px"><b>Detektoren ohne Fahrstreifen (${missingDet.length}):</b> ${esc(list(missingDet))}</div>` : ''}</div>`;
  }

  function toggle(arr, v) {
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1); else arr.push(v);
  }

  function initSideEvents() {
    els.side.addEventListener('click', e => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      const act = b.dataset.action, m = M();
      // A click on a form field inside a row only selects the row. Other actions ignore it.
      const onField = ['INPUT', 'SELECT', 'OPTION'].includes(e.target.tagName);
      if (onField && !['lane-select', 'axis-select', 'conn-select'].includes(act)) return;
      if (onField && sel && sel.id === b.dataset.id) return;     // already selected: keep the open field
      switch (act) {
        case 'axis-new': startDraft(); return;
        case 'axis-select': sel = { kind: 'axis', id: b.dataset.id }; renderCanvas(); renderSide(); return;
        case 'axis-del': e.stopPropagation(); T.removeAxis(m, b.dataset.id); if (sel && sel.id === b.dataset.id) sel = null; changed(true); return;
        case 'center-auto': m.center = null; changed(true); return;
        case 'arm-select': armSel = b.dataset.key; sel = null; renderCanvas(); renderSide(); return;
        case 'lanes-inc': case 'lanes-dec': {
          const cur = T.lanesOf(m, b.dataset.key, b.dataset.dir).length;
          T.setLaneCount(m, b.dataset.key, b.dataset.dir, cur + (act === 'lanes-inc' ? 1 : -1));
          changed(true); return;
        }
        case 'lane-select': sel = { kind: 'lane', id: b.dataset.id }; renderCanvas(); renderSide(); return;
        case 'cross-select': sel = { kind: 'cross', id: b.dataset.id }; renderCanvas(); renderSide(); return;
        case 'conn-select': sel = { kind: 'conn', id: b.dataset.id }; renderCanvas(); renderSide(); return;
        case 'conn-del': e.stopPropagation(); T.removeConnection(m, b.dataset.id); changed(true); return;
        case 'conn-propose': T.proposeConnections(m, derived).forEach(c => T.addConnection(m, c.from, c.to)); changed(true); return;
        case 'conn-clear': m.connections = []; changed(true); return;
        case 'sg-toggle': { const t = selectedTarget(); if (t) { toggle(t.sgs, b.dataset.name); changed(true); } return; }
        case 'det-toggle': { const t = selectedTarget(); if (t) { toggle(t.detectors, b.dataset.name); changed(true); } return; }
        case 'sg-add': case 'det-add': addTypedName(act === 'sg-add' ? 'sg' : 'det'); return;
        default: return;
      }
    });
    els.side.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const f = e.target.dataset ? e.target.dataset.field : null;
      if (f === 'sgAdd') addTypedName('sg');
      if (f === 'detAdd') addTypedName('det');
    });
    els.side.addEventListener('change', e => {
      const el = e.target, f = el.dataset.field;
      if (!f) return;
      const m = M();
      const num = () => { const v = Number(String(el.value).replace(',', '.')); return isFinite(v) ? v : null; };
      switch (f) {
        case 'topoName': m.name = el.value.trim(); renderSide(); return;
        case 'axisName': { const a = m.axes.find(x => x.id === el.dataset.id); if (a) a.name = el.value.trim() || a.name; return; }
        case 'armName': { (m.arms[el.dataset.key] || (m.arms[el.dataset.key] = {})).name = el.value.trim() || undefined; changed(true); return; }
        case 'stopDist': { const v = num(); const arm = derived.arms.find(a => a.key === el.dataset.key); if (v != null && arm) setStopDist(arm, v); changed(true); return; }
        case 'gap': { const v = num(); if (v != null) (m.arms[el.dataset.key] || (m.arms[el.dataset.key] = {})).gap = Math.max(0, Math.min(12, v)); changed(true); return; }
        case 'freeRight': T.applyFreeRight(m, derived, el.dataset.key, el.checked); changed(true); return;
        case 'cross': T.setCrosswalk(m, el.dataset.key, el.checked); changed(true); return;
        case 'crossWidth': { const c = m.crosswalks.find(x => x.id === el.dataset.id); const v = num(); if (c && v != null) c.width = Math.max(1.5, Math.min(8, v)); changed(true); return; }
        case 'laneType': { const l = m.lanes.find(x => x.id === el.dataset.id); if (l) T.setLaneType(l, el.value); changed(true); return; }
        case 'islandLen': { const v = num(); if (v != null) (m.arms[el.dataset.key] || (m.arms[el.dataset.key] = {})).islandLen = Math.max(5, v); changed(true); return; }
        case 'laneLength': { const l = m.lanes.find(x => x.id === el.dataset.id); const v = num(); if (l) l.length = el.value.trim() === '' || v == null ? null : Math.max(5, v); changed(true); return; }
        case 'laneWidth': { const l = m.lanes.find(x => x.id === el.dataset.id); const v = num(); if (l && v != null) l.width = Math.max(1, Math.min(6, v)); changed(true); return; }
        case 'connSg': { const c = m.connections.find(x => x.id === el.dataset.id); if (c) c.sg = el.value || null; changed(true); return; }
        default: return;
      }
    });
  }

  function addTypedName(kind) {
    const input = els.side.querySelector(`[data-field="${kind}Add"]`);
    const name = input ? input.value.trim() : '';
    const t = selectedTarget();
    if (!name || !t) return;
    if (kind === 'sg') { manualSg.add(name); if (!t.sgs.includes(name)) t.sgs.push(name); }
    else { manualDet.add(name); if (!t.detectors.includes(name)) t.detectors.push(name); }
    changed(true);
  }

  /* ---------------- Commands ---------------- */
  function loadExample() {
    const m = M();
    if (m.axes.length && !window.confirm('Die vorhandene Topologie wird durch das Beispiel ersetzt. Fortfahren?')) return;
    GZ.state.data.topology = T.create();
    T.exampleCrossing(M());
    sel = null; armSel = null; draft = null;
    update();
    fitView();
    setStep(step === 1 ? 3 : step);
    refresh();
  }

  function exportMap() {
    const m = M();
    update();
    if (!derived.arms.length) { GZ.snackbar.show('Keine Topologie zum Exportieren', { type: 'warning', description: 'Zuerst Achsen zeichnen und Fahrstreifen anlegen.' }); return; }
    const out = T.toMapem(m, derived, { sortFn: GZ.phases.compareSgNames });
    const id = (m.name || 'knoten').replace(/[^A-Za-z0-9_-]+/g, '-');
    GZ.configIO.downloadJson(`map_${id}.json`, out);
  }

  // Replaces the model (after a configuration was loaded) and redraws.
  function setModel(model) {
    GZ.state.data.topology = model;
    sel = null; armSel = null; draft = null; fitted = false;
    if (els && els.paneTopo.style.display !== 'none') { update(); refresh(); }
  }

  GZ.views = GZ.views || {};
  GZ.views.stammdatenTopologie = { init, refresh, onAnalyzeComplete, setModel, showSub };
})(window.GZ = window.GZ || {});
