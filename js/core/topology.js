/* GZ.topology — topology of one intersection (geometry and model, no DOM).

   Drawing steps:
   1. Axes: splines through control points (metres, x = east, y = north).
   2. Arms: an arm is one half of an axis, from the centre of the intersection outward.
      The centre is the crossing point of the axes (or set by hand).
   3. Lanes: ingress ("in") and egress ("out") lanes per arm, built as parallel
      offset curves of the arm axis. A lane starts at the stop line and runs
      away from the intersection (same order as the MAP node list).
   4. Connections: ingress lane -> egress lane (MAP "connectsTo").

   Signal groups and detectors are attached to lanes by NAME (never by column
   index; indices are stable only inside one parsed file, same rule as GZ.configIO).

   Traffic drives on the right. Looking outward along an arm, ingress lanes are
   on the left side and egress lanes on the right side. */
(function (GZ) {
  'use strict';

  const DEFAULTS = {
    stopDist: 12,        // m from the centre to the stop line
    gap: 0,              // m between the ingress side and the egress side (median)
    minArmLen: 4,        // m; shorter arms are ignored
    maxCenterDist: 30,   // m; an axis farther away from the centre is not part of the intersection
    crossWidth: 4,       // m, distance between the two dashed lines of a pedestrian crossing
    corridorTol: 8,      // m; axes that do not cross but come this close still form an intersection
    islandLen: 30,       // m, length of a median island (Mittelinsel) from the stop line outward
    islandBack: 2,       // m, the island starts this far before the stop line (round end)
    taper: 8,            // m, length of the taper at the end of a short (turning) lane
    walk: 2.5,           // m, width of the footway drawn beside the road
    triRound: 0.9,       // m, radius of its rounded corners
    triTip: 1.7          // m, width of the nose of the triangle island
  };

  const LANE_TYPES = {
    vehicle: { label: 'Fahrzeug', width: 3.25 },
    bike: { label: 'Radfahrstreifen', width: 1.85 },
    bus: { label: 'Busspur', width: 3.25 }
  };

  /* ---------------- Vector and polyline helpers ---------------- */
  const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

  // Centripetal Catmull-Rom spline (Barry-Goldman form), one segment point.
  function splinePoint(p0, p1, p2, p3, t) {
    const knot = (a, b) => Math.max(Math.sqrt(dist(a, b)), 1e-4);
    const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
    const tt = t1 + (t2 - t1) * t;
    const mix = (a, b, ta, tb) => {
      const u = (tb - tt) / (tb - ta), v = (tt - ta) / (tb - ta);
      return { x: a.x * u + b.x * v, y: a.y * u + b.y * v };
    };
    const a1 = mix(p0, p1, t0, t1), a2 = mix(p1, p2, t1, t2), a3 = mix(p2, p3, t2, t3);
    const b1 = mix(a1, a2, t0, t2), b2 = mix(a2, a3, t1, t3);
    return mix(b1, b2, t1, t2);
  }

  // Dense polyline of a spline through the control points.
  // Each sample has "seg": the index of the control segment it belongs to.
  function sampleSpline(pts, step) {
    step = step || 1;
    const n = pts.length;
    if (n < 2) return pts.map(p => ({ x: p.x, y: p.y, seg: 0 }));
    const mirror = (a, b) => ({ x: 2 * b.x - a.x, y: 2 * b.y - a.y });
    const P = [mirror(pts[1], pts[0])].concat(pts, [mirror(pts[n - 2], pts[n - 1])]);
    const out = [];
    for (let i = 0; i < n - 1; i++) {
      const steps = Math.max(2, Math.ceil(dist(P[i + 1], P[i + 2]) / step));
      for (let k = 0; k < steps; k++) {
        const p = splinePoint(P[i], P[i + 1], P[i + 2], P[i + 3], k / steps);
        out.push({ x: p.x, y: p.y, seg: i });
      }
    }
    out.push({ x: pts[n - 1].x, y: pts[n - 1].y, seg: n - 2 });
    return out;
  }

  // Removes points that repeat the previous point.
  function cleanPoly(poly) {
    const out = [];
    poly.forEach(p => { if (!out.length || dist(out[out.length - 1], p) > 1e-6) out.push(p); });
    return out;
  }


  // Points at equal arc length distance (the last point is always kept).
  function resamplePoly(poly, step) {
    if (poly.length < 2) return poly.map(p => ({ x: p.x, y: p.y }));
    const cl = cumLen(poly), total = cl[cl.length - 1];
    const n = Math.max(1, Math.ceil(total / step));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const p = pointAt(poly, cl, (total * i) / n);
      out.push({ x: p.x, y: p.y });
    }
    return out;
  }

  // Outline of a stadium: the path with half circles at both ends (radius r).
  function stadiumPolygon(path, r) {
    const dense = resamplePoly(path, 0.15);
    if (dense.length < 2) return [];
    const cl = cumLen(dense), L = cl[cl.length - 1];
    r = Math.min(r, L / 2);
    const cap = d => (d >= r ? r : Math.sqrt(Math.max(0, 2 * r * d - d * d)));   // circle: height at distance d from the end
    const hw = cl.map(s => Math.min(cap(s), cap(L - s)));
    return offsetPoly(dense, hw).concat(offsetPoly(dense, hw.map(h => -h)).reverse());
  }

  // Rounds the corners of a polygon. pts: [{x,y,round?}]. Only points with round = true are rounded.
  function roundCorners(pts, r) {
    const n = pts.length, out = [];
    for (let i = 0; i < n; i++) {
      const v = pts[i];
      if (!v.round) { out.push({ x: v.x, y: v.y }); continue; }
      const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
      const la = dist(v, a), lb = dist(v, b);
      const k = Math.min(r, la * 0.45, lb * 0.45);
      const p1 = { x: v.x + (a.x - v.x) / la * k, y: v.y + (a.y - v.y) / la * k };
      const p2 = { x: v.x + (b.x - v.x) / lb * k, y: v.y + (b.y - v.y) / lb * k };
      for (let j = 0; j <= 6; j++) {
        const t = j / 6, u = 1 - t;
        out.push({ x: u * u * p1.x + 2 * u * t * v.x + t * t * p2.x, y: u * u * p1.y + 2 * u * t * v.y + t * t * p2.y });
      }
    }
    return out;
  }


  // Ring (closed polygon) moved inward by d with mitre joins. Used to build rounded shapes:
  // draw the inset ring with a round stroke of width 2*d and every corner becomes a true arc.
  function polygonArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
    return a / 2;
  }
  function insetPolygon(pts, d) {
    const n = pts.length;
    const ccw = polygonArea(pts) > 0;
    const nrm = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      const dx = q.x - p.x, dy = q.y - p.y, l = Math.hypot(dx, dy) || 1;
      nrm.push(ccw ? { x: -dy / l, y: dx / l } : { x: dy / l, y: -dx / l });   // points into the polygon
    }
    return pts.map((v, i) => {
      const a = nrm[(i - 1 + n) % n], b = nrm[i];
      const mx = a.x + b.x, my = a.y + b.y, m2 = mx * mx + my * my;
      if (m2 < 0.01) return { x: v.x + b.x * d, y: v.y + b.y * d };
      const k = (2 * d) / m2;
      return { x: v.x + mx * k, y: v.y + my * k };
    });
  }
  // Radius that fits into a polygon (about the radius of the biggest inscribed circle).
  function fitRadius(pts, r) {
    let per = 0;
    for (let i = 0; i < pts.length; i++) per += dist(pts[i], pts[(i + 1) % pts.length]);
    return Math.max(0.05, Math.min(r, 0.8 * (2 * Math.abs(polygonArea(pts))) / per));
  }

  function cumLen(poly) {
    const c = [0];
    for (let i = 1; i < poly.length; i++) c.push(c[i - 1] + dist(poly[i - 1], poly[i]));
    return c;
  }
  const polyLength = poly => (poly.length < 2 ? 0 : cumLen(poly)[poly.length - 1]);

  // Point and unit tangent at arc length s (clamped to the polyline).
  function pointAt(poly, cl, s) {
    const n = poly.length;
    if (n === 0) return null;
    if (n === 1) return { x: poly[0].x, y: poly[0].y, tx: 1, ty: 0 };
    s = Math.max(0, Math.min(cl[n - 1], s));
    let i = 0;
    while (i < n - 2 && cl[i + 1] < s) i++;
    const a = poly[i], b = poly[i + 1], l = cl[i + 1] - cl[i];
    const t = l > 0 ? (s - cl[i]) / l : 0;
    const tx = l > 0 ? (b.x - a.x) / l : 1, ty = l > 0 ? (b.y - a.y) / l : 0;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, tx, ty };
  }

  // Part of the polyline between the arc lengths s0 and s1.
  function subPoly(poly, cl, s0, s1) {
    const total = cl[cl.length - 1];
    s0 = Math.max(0, s0); s1 = Math.min(total, s1);
    if (!(s1 > s0)) return [];
    const out = [pointAt(poly, cl, s0)];
    for (let i = 0; i < poly.length; i++) if (cl[i] > s0 && cl[i] < s1) out.push({ x: poly[i].x, y: poly[i].y });
    const e = pointAt(poly, cl, s1);
    out.push({ x: e.x, y: e.y });
    out[0] = { x: out[0].x, y: out[0].y };
    return out;
  }

  // Parallel curve. d > 0 is to the left of the direction of the polyline.
  // d is one distance, or an array with one distance per vertex.
  function offsetPoly(poly, d) {
    const n = poly.length;
    const dAt = i => (Array.isArray(d) ? d[i] : d);
    if (n < 2 || d === 0) return poly.map(p => ({ x: p.x, y: p.y }));
    const nrm = [];
    for (let i = 0; i < n - 1; i++) {
      const dx = poly[i + 1].x - poly[i].x, dy = poly[i + 1].y - poly[i].y, l = Math.hypot(dx, dy);
      nrm.push(l > 0 ? { x: -dy / l, y: dx / l } : (nrm[i - 1] || { x: 0, y: 1 }));
    }
    return poly.map((p, i) => {
      const a = nrm[Math.max(0, i - 1)], b = nrm[Math.min(n - 2, i)];
      let mx = a.x + b.x, my = a.y + b.y;
      const m2 = mx * mx + my * my;
      if (m2 < 0.09) { mx = b.x * dAt(i); my = b.y * dAt(i); }       // sharp corner: do not spike
      else { const k = (2 * dAt(i)) / m2; mx *= k; my *= k; }          // mitre join
      return { x: p.x + mx, y: p.y + my };
    });
  }

  // Closest point of the polyline to p: { s, d, x, y }.
  function projectOnPoly(poly, cl, p) {
    let best = { s: 0, d: Infinity, x: 0, y: 0 };
    for (let i = 0; i < poly.length - 1; i++) {
      const a = poly[i], b = poly[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
      const x = a.x + dx * t, y = a.y + dy * t, d = Math.hypot(p.x - x, p.y - y);
      if (d < best.d) best = { s: cl[i] + Math.sqrt(l2) * t, d, x, y, seg: i };
    }
    return best;
  }

  function segIntersect(a, b, c, d) {
    const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: d.x - c.x, y: d.y - c.y };
    const den = r.x * s.y - r.y * s.x;
    if (Math.abs(den) < 1e-12) return null;
    const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
    const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { x: a.x + r.x * t, y: a.y + r.y * t };
  }

  // Intersection of two infinite lines (point + direction). Null if parallel.
  function lineIntersect(p, dp, q, dq) {
    const den = dp.x * dq.y - dp.y * dq.x;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((q.x - p.x) * dq.y - (q.y - p.y) * dq.x) / den;
    return { x: p.x + dp.x * t, y: p.y + dp.y * t };
  }

  function polyCrossings(pa, pb) {
    const out = [];
    for (let i = 0; i < pa.length - 1; i++) {
      for (let j = 0; j < pb.length - 1; j++) {
        const x = segIntersect(pa[i], pa[i + 1], pb[j], pb[j + 1]);
        if (x) out.push(x);
      }
    }
    return out;
  }

  function closestApproach(pa, pb) {
    let best = null;
    pa.forEach(p => pb.forEach(q => {
      const d = dist(p, q);
      if (!best || d < best.d) best = { d, x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    }));
    return best;
  }

  // Compass bearing in degrees (0 = north, clockwise) of a direction vector.
  function bearingOf(tx, ty) {
    return (Math.atan2(tx, ty) * 180 / Math.PI + 360) % 360;
  }
  const COMPASS = ['Nord', 'Nordost', 'Ost', 'Südost', 'Süd', 'Südwest', 'West', 'Nordwest'];
  function compassName(bearing) { return COMPASS[Math.round(bearing / 45) % 8]; }

  // Signed turn angle in degrees (counter-clockwise is positive = left) from heading a to heading b.
  function turnAngle(a, b) {
    return Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y) * 180 / Math.PI;
  }
  function maneuverOfAngle(deg) {
    const m = Math.abs(deg);
    if (m < 30) return 'straight';
    if (m > 150) return 'uturn';
    return deg > 0 ? 'left' : 'right';
  }

  /* ---------------- Model ---------------- */
  function create() {
    return {
      version: 1, name: '', refLat: null, refLon: null,
      axes: [],          // { id, name, points:[{x,y}] }
      center: null,      // manual centre { x, y }; null = automatic
      arms: {},          // key "<axisId>:s|e" -> { name?, stopDist?, gap? }
      lanes: [],         // { id, armKey, dir:'in'|'out', order, type, width, sgs:[], detectors:[] }
      crosswalks: [],    // { id, armKey, width, sgs:[], detectors:[] }
      connections: [],   // { id, from, to, sg|null }
      seq: {}
    };
  }

  function nextId(model, prefix) {
    model.seq[prefix] = (model.seq[prefix] || 0) + 1;
    return prefix + model.seq[prefix];
  }

  function addAxis(model, points) {
    const id = nextId(model, 'A');
    const axis = { id, name: 'Achse ' + id.slice(1), points: points.map(p => ({ x: p.x, y: p.y })) };
    model.axes.push(axis);
    return axis;
  }

  function removeAxis(model, axisId) {
    model.axes = model.axes.filter(a => a.id !== axisId);
    const gone = key => key.split(':')[0] === axisId;
    Object.keys(model.arms).forEach(k => { if (gone(k)) delete model.arms[k]; });
    const laneIds = new Set(model.lanes.filter(l => gone(l.armKey)).map(l => l.id));
    model.lanes = model.lanes.filter(l => !laneIds.has(l.id));
    model.crosswalks = model.crosswalks.filter(c => !gone(c.armKey));
    model.connections = model.connections.filter(c => !laneIds.has(c.from) && !laneIds.has(c.to));
  }

  function newLane(model, armKey, dir, order, type) {
    type = LANE_TYPES[type] ? type : 'vehicle';
    return { id: nextId(model, 'L'), armKey, dir, order, type, width: LANE_TYPES[type].width, length: null, sgs: [], detectors: [] };
  }

  const lanesOf = (model, armKey, dir) =>
    model.lanes.filter(l => l.armKey === armKey && l.dir === dir).sort((a, b) => a.order - b.order);

  // Adds or removes lanes at the outer side until the arm has n lanes in this direction.
  function setLaneCount(model, armKey, dir, n) {
    n = Math.max(0, Math.min(8, Math.round(n)));
    const cur = lanesOf(model, armKey, dir);
    for (let i = cur.length; i < n; i++) model.lanes.push(newLane(model, armKey, dir, i, 'vehicle'));
    if (cur.length > n) {
      const drop = new Set(cur.slice(n).map(l => l.id));
      model.lanes = model.lanes.filter(l => !drop.has(l.id));
      model.connections = model.connections.filter(c => !drop.has(c.from) && !drop.has(c.to));
    }
  }

  function setLaneType(lane, type) {
    if (!LANE_TYPES[type]) return;
    lane.type = type;
    lane.width = LANE_TYPES[type].width;
  }

  function setCrosswalk(model, armKey, on) {
    const cur = model.crosswalks.find(c => c.armKey === armKey);
    if (on && !cur) model.crosswalks.push({ id: nextId(model, 'C'), armKey, width: DEFAULTS.crossWidth, sgs: [], detectors: [] });
    if (!on && cur) model.crosswalks = model.crosswalks.filter(c => c !== cur);
  }

  function addConnection(model, fromId, toId) {
    const from = model.lanes.find(l => l.id === fromId), to = model.lanes.find(l => l.id === toId);
    if (!from || !to || from.dir !== 'in' || to.dir !== 'out') return null;
    const dup = model.connections.find(c => c.from === fromId && c.to === toId);
    if (dup) return dup;
    const conn = { id: nextId(model, 'V'), from: fromId, to: toId, sg: null };
    model.connections.push(conn);
    return conn;
  }
  function removeConnection(model, id) { model.connections = model.connections.filter(c => c.id !== id); }

  // Every new arm gets one ingress and one egress lane. Call after the axes changed.
  function ensureDefaults(model, derived) {
    let changed = false;
    derived.arms.forEach(arm => {
      const cfg = model.arms[arm.key] || (model.arms[arm.key] = {});
      if (!cfg.init) {
        cfg.init = true;
        setLaneCount(model, arm.key, 'in', 1);
        setLaneCount(model, arm.key, 'out', 1);
        changed = true;
      }
    });
    return changed;
  }

  /* ---------------- Derived geometry ---------------- */
  function axisPoly(axis) { return cleanPoly(sampleSpline(axis.points, 1)); }

  function autoCenter(entries) {
    if (!entries.length) return null;
    if (entries.length === 1) {
      const cl = cumLen(entries[0].poly);
      const p = pointAt(entries[0].poly, cl, cl[cl.length - 1] / 2);
      return { x: p.x, y: p.y };
    }
    const crossings = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) crossings.push(...polyCrossings(entries[i].poly, entries[j].poly));
    }
    if (crossings.length) {
      const n = crossings.length;
      return { x: crossings.reduce((s, p) => s + p.x, 0) / n, y: crossings.reduce((s, p) => s + p.y, 0) / n };
    }
    let best = null;
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const c = closestApproach(entries[i].poly, entries[j].poly);
        if (c && (!best || c.d < best.d)) best = c;
      }
    }
    return best && best.d <= DEFAULTS.corridorTol ? { x: best.x, y: best.y } : null;
  }

  // Builds everything the drawing needs: centre, arms, lanes with their curves.
  function derive(model) {
    const entries = model.axes.map(axis => ({ axis, poly: axisPoly(axis) })).filter(e => e.poly.length >= 2);
    const autoC = autoCenter(entries);
    const center = model.center || autoC;
    const arms = [];
    if (center) {
      entries.forEach(({ axis, poly }) => {
        const cl = cumLen(poly), total = cl[cl.length - 1];
        const pr = projectOnPoly(poly, cl, center);
        if (pr.d > DEFAULTS.maxCenterDist) return;
        const startPart = subPoly(poly, cl, 0, pr.s).reverse();
        const endPart = subPoly(poly, cl, pr.s, total);
        [['s', startPart], ['e', endPart]].forEach(([end, path]) => {
          if (path.length < 2 || polyLength(path) < DEFAULTS.minArmLen) return;
          const pcl = cumLen(path), length = pcl[pcl.length - 1];
          const dir = pointAt(path, pcl, Math.min(8, length));
          arms.push({
            key: axis.id + ':' + end, axisId: axis.id, end, path, cl: pcl, length,
            bearing: bearingOf(dir.tx, dir.ty)
          });
        });
      });
    }
    // clockwise from north; an arm up to 22.5 degrees left of north still counts as the first one
    const sector = arm => (arm.bearing + 22.5) % 360;
    arms.sort((a, b) => sector(a) - sector(b));
    const used = {};
    arms.forEach((arm, i) => {
      const cfg = model.arms[arm.key] || {};
      arm.approachId = i + 1;
      const base = compassName(arm.bearing);
      used[base] = (used[base] || 0) + 1;
      arm.name = cfg.name || (used[base] > 1 ? base + ' ' + used[base] : base);
      arm.stopDist = Math.max(1, Math.min(cfg.stopDist != null ? cfg.stopDist : DEFAULTS.stopDist, arm.length - 2));
      arm.gap = cfg.gap != null ? cfg.gap : DEFAULTS.gap;
      arm.islandLen = cfg.islandLen != null ? cfg.islandLen : DEFAULTS.islandLen;
      arm.freeRight = !!cfg.freeRight;
      buildArmGeometry(model, arm);
    });
    return { center, autoCenter: autoC, arms, axes: entries };
  }

  function buildArmGeometry(model, arm) {
    const sub = subPoly(arm.path, arm.cl, arm.stopDist, arm.length);
    const scl = cumLen(sub);
    const stop = pointAt(arm.path, arm.cl, arm.stopDist);
    arm.dir = { x: stop.tx, y: stop.ty };                   // outward direction at the stop line
    arm.normal = { x: -stop.ty, y: stop.tx };               // left of the outward direction
    arm.stopPt = { x: stop.x, y: stop.y };
    let widthIn = 0, widthOut = 0;
    ['in', 'out'].forEach(dir => {
      const side = dir === 'in' ? 1 : -1;
      let inner = arm.gap / 2;
      const laneList = lanesOf(model, arm.key, dir);
      const subTotal = scl[scl.length - 1];
      arm[dir] = laneList.map((lane, i) => {
        // A short lane (turning lane) is only possible for the innermost and the outermost lane.
        // It ends with a taper. The width it leaves becomes island (inner lane) or footway (outer lane).
        const n = laneList.length;
        const len = lane.length > 0 && n >= 2 && (i === 0 || i === n - 1) && lane.length < subTotal ? lane.length : null;
        const cut = len ? { len, anchor: i === 0 ? 'outer' : 'inner' } : null;
        const part = cut ? subPoly(sub, scl, 0, Math.min(subTotal, cut.len + DEFAULTS.taper / 2)) : sub;
        const path = offsetPoly(part, side * (inner + lane.width / 2));
        const g = {
          lane, arm, dir, index: i, path, cut,
          label: (dir === 'in' ? 'Z' : 'A') + (i + 1),
          inner, outer: inner + lane.width,
          startPt: { x: path[0].x, y: path[0].y },
          cl: cumLen(path)
        };
        inner += lane.width;
        return g;
      });
      if (dir === 'in') widthIn = inner - arm.gap / 2; else widthOut = inner - arm.gap / 2;
    });
    arm.widthIn = widthIn; arm.widthOut = widthOut;
    arm.edgeLeft = offsetPoly(sub, arm.gap / 2 + widthIn);
    arm.edgeRight = offsetPoly(sub, -(arm.gap / 2 + widthOut));
    arm.sub = sub; arm.subCl = scl;
    const left = arm.gap / 2 + widthIn, right = arm.gap / 2 + widthOut;
    arm.cornerLeft = { x: stop.x + arm.normal.x * left, y: stop.y + arm.normal.y * left };
    arm.cornerRight = { x: stop.x - arm.normal.x * right, y: stop.y - arm.normal.y * right };
    const cw = model.crosswalks.find(c => c.armKey === arm.key);
    arm.cross = null;
    if (cw) {
      const s = Math.max(cw.width / 2 + 0.3, arm.stopDist - cw.width / 2 - 0.8);
      const p = pointAt(arm.path, arm.cl, s);
      const nl = { x: -p.ty, y: p.tx };
      arm.cross = {
        cw, s, center: { x: p.x, y: p.y }, dir: { x: p.tx, y: p.ty },
        a: { x: p.x + nl.x * (left + 0.3), y: p.y + nl.y * (left + 0.3) },
        b: { x: p.x - nl.x * (right + 0.3), y: p.y - nl.y * (right + 0.3) }
      };
    }
  }


  // Outline of a lane. A short lane gets a taper at its end: its free boundary moves
  // toward the anchored boundary until the width is zero.
  function laneOutline(g) {
    if (g._outline) return g._outline;
    const arm = g.arm, side = g.dir === 'in' ? 1 : -1;
    const total = arm.subCl[arm.subCl.length - 1];
    const end = g.cut ? Math.min(total, g.cut.len + DEFAULTS.taper) : total;
    const poly = subPoly(arm.sub, arm.subCl, 0, end);
    if (poly.length < 2) return (g._outline = { pts: [], innerEdge: [], outerEdge: [], poly, cl: [] });
    const cl = cumLen(poly), w = g.lane.width;
    const f = s => (!g.cut || s <= g.cut.len ? 1 : Math.max(0, 1 - (s - g.cut.len) / DEFAULTS.taper));
    const dIn = cl.map(s => side * (g.cut && g.cut.anchor === 'outer' ? g.outer - w * f(s) : g.inner));
    const dOut = cl.map(s => side * (g.cut && g.cut.anchor === 'inner' ? g.inner + w * f(s) : g.outer));
    const innerEdge = offsetPoly(poly, dIn), outerEdge = offsetPoly(poly, dOut);
    return (g._outline = { pts: innerEdge.concat(outerEdge.slice().reverse()), innerEdge, outerEdge, poly, cl });
  }

  
  // Areas around the lanes of one arm (all polygons in world coordinates):
  //   walk    footway band beside the road
  //   gapBase road colour under the median
  //   island  median island with pointed ends (when the median is wider than 0.3 m)
  //   freed   area an inner short lane leaves behind (also island)
  //   kerbs   polylines and polygons that get a kerb line
  function armSurfaces(arm) {
    const out = { walk: null, gapBase: null, island: null, freed: [], kerbs: [], kerbPolys: [] };
    if (arm.sub.length < 2) return out;
    const half = arm.gap / 2, W = DEFAULTS.walk;
    const total = arm.subCl[arm.subCl.length - 1];
    out.walk = offsetPoly(arm.sub, half + arm.widthIn + W).concat(offsetPoly(arm.sub, -(half + arm.widthOut + W)).reverse());
    if (arm.gap > 0.05) out.gapBase = offsetPoly(arm.sub, half).concat(offsetPoly(arm.sub, -half).reverse());
    if (arm.gap > 0.3 && arm.islandLen > 0) {
      const a = Math.max(0, arm.stopDist - DEFAULTS.islandBack), b = Math.min(arm.length, arm.stopDist + arm.islandLen);
      const path = subPoly(arm.path, arm.cl, a, b);
      if (path.length >= 2) {
        out.island = stadiumPolygon(path, half);
        out.kerbPolys.push(out.island);
      }
    }
    ['in', 'out'].forEach(dir => {
      const side = dir === 'in' ? 1 : -1, lanes = arm[dir];
      lanes.forEach((g, i) => {
        const o = laneOutline(g);
        if (!o.pts.length) return;
        if (i === lanes.length - 1) out.kerbs.push(o.outerEdge);
        const next = lanes[i + 1];
        if (next && next.cut && next.cut.anchor === 'inner') {
          // the outer lane has ended: the edge of this lane is now the road edge
          const from = next.cut.len + DEFAULTS.taper;
          if (from < total) out.kerbs.push(offsetPoly(subPoly(arm.sub, arm.subCl, from, total), side * g.outer));
        }
        if (g.cut && g.cut.anchor === 'outer') {
          // the inner lane has ended: its free area becomes island
          const part = subPoly(arm.sub, arm.subCl, g.cut.len, total);
          if (part.length >= 2) {
            const cl = cumLen(part), w = g.lane.width;
            const dB = cl.map(s => side * (g.outer - w * Math.max(0, 1 - s / DEFAULTS.taper)));
            const edgeB = offsetPoly(part, dB);
            out.freed.push(offsetPoly(part, side * g.inner).concat(edgeB.slice().reverse()));
            out.kerbs.push(edgeB);
          }
        }
      });
    });
    return out;
  }

  // Closed outline of the junction area: arm corners joined by kerb curves.
  // Returns an array of path commands [{ type:'M'|'L'|'Q', pts:[...] }].
  function junctionOutline(arms) {
    const usable = arms.filter(a => a.widthIn + a.widthOut > 0);
    if (usable.length < 2) return [];
    const cmds = [];
    usable.forEach((a, i) => {
      const b = usable[(i + 1) % usable.length];
      // clockwise: right corner of arm a to left corner of the next arm b
      if (i === 0) cmds.push({ type: 'M', pts: [a.cornerLeft] }, { type: 'L', pts: [a.cornerRight] });
      else cmds.push({ type: 'L', pts: [a.cornerLeft] }, { type: 'L', pts: [a.cornerRight] });
      const ctrl = lineIntersect(a.cornerRight, a.dir, b.cornerLeft, b.dir);
      const span = dist(a.cornerRight, b.cornerLeft);
      const ok = ctrl && dist(ctrl, a.cornerRight) < Math.max(25, span) && dist(ctrl, b.cornerLeft) < Math.max(25, span) &&
        // the kerb corner lies on the intersection side of both stop lines
        ((ctrl.x - a.cornerRight.x) * a.dir.x + (ctrl.y - a.cornerRight.y) * a.dir.y) < 0.01 &&
        ((ctrl.x - b.cornerLeft.x) * b.dir.x + (ctrl.y - b.cornerLeft.y) * b.dir.y) < 0.01;
      if (usable.length > 2 && ok) cmds.push({ type: 'Q', pts: [ctrl, b.cornerLeft] });
      else if (usable.length > 2) cmds.push({ type: 'L', pts: [b.cornerLeft] });
      else cmds.push({ type: 'L', pts: [b.cornerLeft] });
    });
    cmds.push({ type: 'Z', pts: [] });
    return cmds;
  }

  /* ---------------- Connections ---------------- */
  function allLaneGeoms(derived) {
    const map = new Map();
    derived.arms.forEach(arm => arm.in.concat(arm.out).forEach(g => map.set(g.lane.id, g)));
    return map;
  }

  // Cubic curve from the stop line of an ingress lane to the start of an egress lane.
  function connectionCurve(fromG, toG) {
    const p0 = fromG.startPt, p1 = toG.startPt;
    const h0 = { x: -fromG.arm.dir.x, y: -fromG.arm.dir.y };   // heading when entering the intersection
    const h1 = { x: toG.arm.dir.x, y: toG.arm.dir.y };         // heading when leaving
    const k = Math.max(2, dist(p0, p1) * 0.42);
    return {
      p0, p1,
      c0: { x: p0.x + h0.x * k, y: p0.y + h0.y * k },
      c1: { x: p1.x - h1.x * k, y: p1.y - h1.y * k },
      h0, h1, angle: turnAngle(h0, h1)
    };
  }
  function cubicPoint(c, t) {
    const u = 1 - t;
    return {
      x: u * u * u * c.p0.x + 3 * u * u * t * c.c0.x + 3 * u * t * t * c.c1.x + t * t * t * c.p1.x,
      y: u * u * u * c.p0.y + 3 * u * u * t * c.c0.y + 3 * u * t * t * c.c1.y + t * t * t * c.p1.y
    };
  }
  function connectionManeuver(fromG, toG) {
    return maneuverOfAngle(connectionCurve(fromG, toG).angle);
  }

  // Maneuvers a lane has, from its connections.
  function laneManeuvers(model, derived, laneId) {
    const geoms = allLaneGeoms(derived);
    const from = geoms.get(laneId);
    const set = new Set();
    if (!from) return set;
    model.connections.filter(c => c.from === laneId).forEach(c => {
      const to = geoms.get(c.to);
      if (to) set.add(connectionManeuver(from, to));
    });
    return set;
  }

  // Signal groups of a connection: its own, or the ones of the ingress lane.
  function connectionSg(model, conn) {
    if (conn.sg) return conn.sg;
    const lane = model.lanes.find(l => l.id === conn.from);
    return lane && lane.sgs.length === 1 ? lane.sgs[0] : null;
  }

  // Proposes connections by geometry. Does not change the model; returns [{from,to}].
  function proposeConnections(model, derived) {
    const out = [];
    derived.arms.forEach(arm => {
      const ins = arm.in;
      if (!ins.length) return;
      // target arm per maneuver: the arm whose direction is closest to the ideal one
      const targets = {};
      derived.arms.forEach(other => {
        if (other === arm || !other.out.length) return;
        const curve = connectionCurve(ins[0], other.out[0]);
        const m = maneuverOfAngle(curve.angle), ang = Math.abs(curve.angle);
        if (m === 'uturn') return;
        const score = m === 'straight' ? ang : Math.abs(ang - 90);
        if (!targets[m] || score < targets[m].score) targets[m] = { arm: other, score };
      });
      const pick = (g, targetArm, m) => {
        const outs = targetArm.out;
        const same = outs.filter(o => o.lane.type === g.lane.type);
        const pool = same.length ? same : outs;
        let idx = m === 'left' ? 0 : m === 'right' ? pool.length - 1 : Math.min(g.index, pool.length - 1);
        return pool[Math.max(0, idx)];
      };
      const vehicleIns = ins.filter(g => g.lane.type !== 'bike');
      ins.forEach(g => {
        let wanted;
        if (g.lane.type === 'bike') wanted = ['straight'];
        else {
          const k = vehicleIns.indexOf(g), n = vehicleIns.length;
          if (arm.freeRight && n >= 2) wanted = k === n - 1 ? ['right'] : (k === 0 ? ['left'] : ['straight']);
          else if (n === 1) wanted = ['left', 'straight', 'right'];
          else if (k === 0) wanted = ['left'];
          else if (k === n - 1) wanted = ['straight', 'right'];
          else wanted = ['straight'];
          if (n === 2 && k === 0 && !arm.freeRight) wanted = ['left', 'straight'];
        }
        wanted.forEach(m => {
          if (!targets[m]) return;
          const to = pick(g, targets[m].arm, m);
          if (to) out.push({ from: g.lane.id, to: to.lane.id });
        });
      });
    });
    return out;
  }


  /* ---------------- Free right turn (Dreiecksinsel) ---------------- */
  // The slip lane is the outermost vehicle lane of the arm. It turns into the outermost
  // vehicle egress lane of the arm that comes before it in clockwise order (the kerb side).
  function freeRightPair(derived, arm) {
    const arms = derived.arms;
    if (arms.length < 2) return null;
    const prev = arms[(arms.indexOf(arm) - 1 + arms.length) % arms.length];
    if (!prev || prev === arm) return null;
    const veh = lanes => lanes.filter(g => g.lane.type !== 'bike');
    const ins = veh(arm.in), outs = veh(prev.out);
    if (arm.in.length < 2 || !ins.length || !outs.length) return null;
    return { prev, slip: ins[ins.length - 1], target: outs[outs.length - 1] };
  }

  // Island between the slip lane and the other lanes: a triangle with a concave long side.
  function freeRightIslands(derived) {
    const out = [];
    derived.arms.forEach(arm => {
      if (!arm.freeRight) return;
      const pair = freeRightPair(derived, arm);
      if (!pair) return;
      const { prev, slip, target } = pair;
      const v1 = { x: arm.stopPt.x + arm.normal.x * slip.inner, y: arm.stopPt.y + arm.normal.y * slip.inner };
      const v2 = { x: prev.stopPt.x - prev.normal.x * target.inner, y: prev.stopPt.y - prev.normal.y * target.inner };
      const apex = lineIntersect(v1, arm.dir, v2, prev.dir);
      if (!apex) return;
      const inward = (p, from, dir) => (p.x - from.x) * dir.x + (p.y - from.y) * dir.y < -0.5;
      if (!inward(apex, v1, arm.dir) || !inward(apex, v2, prev.dir)) return;
      // Shape: tip at the stop line, straight leg along the lane boundary, a flat base,
      // a straight leg along the egress lane and a gently curved side facing the slip lane.
      // The legs are cut after DEFAULTS.triLeg metres, so the island stays small.
      // The curved side leaves the tip at an angle (about 10 to 15 degrees), not along the leg:
      // its control point is halfway between the apex and the middle of the chord.
      const c = { x: (apex.x + (v1.x + v2.x) / 2) / 2, y: (apex.y + (v1.y + v2.y) / 2) / 2 };
      const curve = [];
      for (let i = 0; i <= 18; i++) {
        const t = i / 18, u = 1 - t;
        curve.push({ x: u * u * v1.x + 2 * u * t * c.x + t * t * v2.x, y: u * u * v1.y + 2 * u * t * c.y + t * t * v2.y });
      }
      // Both thin ends are cut where the island is DEFAULTS.triTip wide (a thinner end can not
      // be rounded). The flat ends are then rounded, so the noses look like bullets.
      const gapTo = (q, v, d) => Math.abs((q.x - v.x) * d.y - (q.y - v.y) * d.x);   // distance of q to the line through v along d
      const k = curve.findIndex(q => gapTo(q, v1, arm.dir) >= DEFAULTS.triTip);
      let m = -1;
      curve.forEach((q, i) => { if (gapTo(q, v2, prev.dir) >= DEFAULTS.triTip) m = i; });
      if (k < 0 || m <= k) return;
      const onLine = (q, v, d) => { const t = (q.x - v.x) * d.x + (q.y - v.y) * d.y; return { x: v.x + d.x * t, y: v.y + d.y * t }; };
      const pa = onLine(curve[k], v1, arm.dir), pb = onLine(curve[m], v2, prev.dir);
      const pts = [pa].concat(curve.slice(k, m + 1), [pb, apex]);
      const r = fitRadius(pts, DEFAULTS.triRound);
      out.push({ armKey: arm.key, polygon: insetPolygon(pts, r), r, outline: pts });
    });
    return out;
  }

  // Switches the free right turn of an arm. The slip lane then only turns right.
  function applyFreeRight(model, derived, armKey, on) {
    const cfg = model.arms[armKey] || (model.arms[armKey] = {});
    cfg.freeRight = !!on;
    if (!on) return;
    const arm = derived.arms.find(a => a.key === armKey);
    const pair = arm ? freeRightPair(derived, arm) : null;
    if (!pair) return;
    model.connections = model.connections.filter(c => c.from !== pair.slip.lane.id);
    addConnection(model, pair.slip.lane.id, pair.target.lane.id);
  }

  /* ---------------- Example ---------------- */
  // Four arms with two ingress lanes, one egress lane and a crossing each.
  function exampleCrossing(model) {
    const ew = addAxis(model, [{ x: -95, y: -7 }, { x: -45, y: -1 }, { x: 0, y: 0 }, { x: 45, y: 1 }, { x: 95, y: 6 }]);
    const ns = addAxis(model, [{ x: 4, y: -95 }, { x: 1, y: -45 }, { x: 0, y: 0 }, { x: -1, y: 45 }, { x: -5, y: 95 }]);
    ew.name = 'Hauptstraße'; ns.name = 'Querstraße';
    const d = derive(model);
    ensureDefaults(model, d);
    d.arms.forEach(arm => {
      const main = arm.axisId === ew.id;
      setLaneCount(model, arm.key, 'in', main ? 4 : 2);
      setCrosswalk(model, arm.key, true);
      if (!main) { model.arms[arm.key].stopDist = 17; model.arms[arm.key].freeRight = true; return; }   // behind the wide main road
      // main road: median island, left turning lane (35 m), bike lanes on both sides
      const cfg = model.arms[arm.key];
      cfg.gap = 3; cfg.islandLen = 40; cfg.stopDist = 14;
      const ins = lanesOf(model, arm.key, 'in');
      ins[0].length = 35;
      setLaneType(ins[ins.length - 1], 'bike');
      setLaneCount(model, arm.key, 'out', 2);
      setLaneType(lanesOf(model, arm.key, 'out')[1], 'bike');
    });
    const d2 = derive(model);
    proposeConnections(model, d2).forEach(c => addConnection(model, c.from, c.to));
    return derive(model);
  }

  /* ---------------- Persistence (part of the node configuration file) ---------------- */
  function toConfig(model) {
    return JSON.parse(JSON.stringify({
      version: 1, name: model.name, refLat: model.refLat, refLon: model.refLon,
      axes: model.axes, center: model.center, arms: model.arms, lanes: model.lanes,
      crosswalks: model.crosswalks, connections: model.connections
    }));
  }

  function fromConfig(cfg) {
    const m = create();
    if (!cfg || typeof cfg !== 'object') return m;
    const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
    m.name = typeof cfg.name === 'string' ? cfg.name : '';
    m.refLat = num(cfg.refLat); m.refLon = num(cfg.refLon);
    m.axes = (cfg.axes || []).filter(a => a && a.id && Array.isArray(a.points))
      .map(a => ({ id: String(a.id), name: String(a.name || a.id), points: a.points.filter(p => num(p.x) != null && num(p.y) != null).map(p => ({ x: p.x, y: p.y })) }))
      .filter(a => a.points.length >= 2);
    m.center = cfg.center && num(cfg.center.x) != null && num(cfg.center.y) != null ? { x: cfg.center.x, y: cfg.center.y } : null;
    m.arms = cfg.arms && typeof cfg.arms === 'object' ? JSON.parse(JSON.stringify(cfg.arms)) : {};
    const strList = v => (Array.isArray(v) ? v.filter(s => typeof s === 'string') : []);
    m.lanes = (cfg.lanes || []).filter(l => l && l.id && l.armKey && (l.dir === 'in' || l.dir === 'out')).map(l => ({
      id: String(l.id), armKey: String(l.armKey), dir: l.dir, order: num(l.order) || 0,
      type: LANE_TYPES[l.type] ? l.type : 'vehicle', width: num(l.width) || LANE_TYPES.vehicle.width,
      length: num(l.length) > 0 ? l.length : null,
      sgs: strList(l.sgs), detectors: strList(l.detectors)
    }));
    m.crosswalks = (cfg.crosswalks || []).filter(c => c && c.id && c.armKey).map(c => ({
      id: String(c.id), armKey: String(c.armKey), width: num(c.width) || DEFAULTS.crossWidth,
      sgs: strList(c.sgs), detectors: strList(c.detectors)
    }));
    const laneIds = new Set(m.lanes.map(l => l.id));
    m.connections = (cfg.connections || []).filter(c => c && c.id && laneIds.has(c.from) && laneIds.has(c.to))
      .map(c => ({ id: String(c.id), from: c.from, to: c.to, sg: typeof c.sg === 'string' && c.sg ? c.sg : null }));
    // continue the id counters after the highest stored id
    const bump = (prefix, items) => items.forEach(x => {
      const n = parseInt(String(x.id).slice(prefix.length), 10);
      if (String(x.id).startsWith(prefix) && n > (m.seq[prefix] || 0)) m.seq[prefix] = n;
    });
    bump('A', m.axes); bump('L', m.lanes); bump('C', m.crosswalks); bump('V', m.connections);
    return m;
  }

  /* ---------------- MAP export (MAPEM JSON, simplified) ---------------- */
  // Reduces a polyline with the Douglas-Peucker rule (tolerance in metres).
  function simplify(poly, tol) {
    if (poly.length < 3) return poly.slice();
    const keep = new Array(poly.length).fill(false);
    keep[0] = keep[poly.length - 1] = true;
    const stack = [[0, poly.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let maxD = 0, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = distToSegment(poly[i], poly[a], poly[b]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (idx >= 0 && maxD > tol) { keep[idx] = true; stack.push([a, idx], [idx, b]); }
    }
    return poly.filter((_, i) => keep[i]);
  }
  function distToSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
  }

  const MANEUVER_FLAG = { straight: 'maneuverStraightAllowed', left: 'maneuverLeftAllowed', right: 'maneuverRightAllowed', uturn: 'maneuverUTurnAllowed' };

  // sgIds: Map name -> number (MAP signalGroup id). Build it with signalGroupIds().
  function signalGroupIds(model, sortFn) {
    const names = new Set();
    model.lanes.forEach(l => l.sgs.forEach(n => names.add(n)));
    model.crosswalks.forEach(c => c.sgs.forEach(n => names.add(n)));
    model.connections.forEach(c => { if (c.sg) names.add(c.sg); });
    const sorted = [...names].sort(sortFn || ((a, b) => a.localeCompare(b, 'de', { numeric: true })));
    return new Map(sorted.map((n, i) => [n, i + 1]));
  }

  // Local metres to centimetres, relative to the previous node (first node: relative to the reference point).
  function nodeList(poly, origin) {
    const out = [];
    let prev = origin;
    simplify(poly, 0.1).forEach(p => {
      out.push({ delta: { 'node-XY': { x: Math.round((p.x - prev.x) * 100), y: Math.round((p.y - prev.y) * 100) } } });
      prev = p;
    });
    return out;
  }

  function toMapem(model, derived, opts) {
    opts = opts || {};
    const center = derived.center || { x: 0, y: 0 };
    const sgIds = signalGroupIds(model, opts.sortFn);
    const geoms = allLaneGeoms(derived);
    const laneIdOf = new Map();
    let counter = 0;
    derived.arms.forEach(arm => arm.in.concat(arm.out).forEach(g => laneIdOf.set(g.lane.id, ++counter)));
    derived.arms.forEach(arm => { if (arm.cross) laneIdOf.set(arm.cross.cw.id, ++counter); });

    const laneSet = [];
    derived.arms.forEach(arm => {
      arm.in.concat(arm.out).forEach(g => {
        const isIn = g.dir === 'in';
        const connectsTo = isIn ? model.connections.filter(c => c.from === g.lane.id).map(c => {
          const to = geoms.get(c.to);
          const sg = connectionSg(model, c);
          const entry = {
            connectingLane: { lane: laneIdOf.get(c.to), maneuver: { [MANEUVER_FLAG[connectionManeuver(g, to)]]: true } },
            connectionID: Number(c.id.slice(1))
          };
          if (sg && sgIds.has(sg)) entry.signalGroup = sgIds.get(sg);
          return entry;
        }) : [];
        const mans = {};
        laneManeuvers(model, derived, g.lane.id).forEach(m => { mans[MANEUVER_FLAG[m]] = true; });
        const lane = {
          laneID: laneIdOf.get(g.lane.id),
          name: arm.name + ' ' + g.label,
          laneAttributes: {
            directionalUse: isIn ? { ingressPath: true } : { egressPath: true },
            laneType: { [g.lane.type === 'bike' ? 'bikeLane' : 'vehicle']: {} }
          },
          nodeList: { nodes: nodeList(g.path, center) }
        };
        lane[isIn ? 'ingressApproach' : 'egressApproach'] = arm.approachId;
        if (isIn) { lane.maneuvers = mans; lane.connectsTo = connectsTo; }
        laneSet.push(lane);
      });
      if (arm.cross) {
        const cw = arm.cross.cw;
        const sg = cw.sgs.length ? cw.sgs[0] : null;
        const lane = {
          laneID: laneIdOf.get(cw.id), name: arm.name + ' Furt', ingressApproach: arm.approachId, egressApproach: arm.approachId,
          laneAttributes: { directionalUse: { ingressPath: true, egressPath: true }, laneType: { crosswalk: {} } },
          nodeList: { nodes: nodeList([arm.cross.a, arm.cross.b], center) }
        };
        if (sg && sgIds.has(sg)) lane.connectsTo = [{ connectingLane: { lane: laneIdOf.get(cw.id) }, signalGroup: sgIds.get(sg), connectionID: Number(cw.id.slice(1)) }];
        laneSet.push(lane);
      }
    });

    const ref = {
      lat: model.refLat != null ? Math.round(model.refLat * 1e7) : 0,
      long: model.refLon != null ? Math.round(model.refLon * 1e7) : 0
    };
    return {
      map: {
        msgIssueRevision: 1,
        intersections: [{
          id: { region: opts.region || 0, id: opts.intersectionId || 0 },
          name: model.name || undefined,
          revision: 1,
          refPoint: ref,
          laneWidth: Math.round(LANE_TYPES.vehicle.width * 100),
          laneSet
        }]
      },
      signalGroups: [...sgIds].map(([name, id]) => ({ id, name }))
    };
  }

  GZ.topology = {
    DEFAULTS, LANE_TYPES, COMPASS,
    // geometry
    sampleSpline, cleanPoly, resamplePoly, stadiumPolygon, roundCorners, laneOutline, armSurfaces, freeRightPair, freeRightIslands, applyFreeRight, insetPolygon, fitRadius, cumLen, polyLength, pointAt, subPoly, offsetPoly, projectOnPoly,
    segIntersect, lineIntersect, polyCrossings, closestApproach, bearingOf, compassName, turnAngle, maneuverOfAngle, simplify,
    // model
    create, addAxis, removeAxis, setLaneCount, setLaneType, setCrosswalk, addConnection, removeConnection, ensureDefaults,
    lanesOf, derive, junctionOutline, allLaneGeoms, connectionCurve, cubicPoint, connectionManeuver, laneManeuvers, connectionSg,
    proposeConnections, exampleCrossing, toConfig, fromConfig, signalGroupIds, toMapem
  };
})(window.GZ = window.GZ || {});
