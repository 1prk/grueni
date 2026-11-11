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
    triTip: 1.6,         // m, width of the nose of the triangle island
    cornerRadius: 8,     // m, kerb radius of a junction corner (circle tangent to both arm edges)
    rightRadius: 12.5,   // m, radius of a right turn (its tangent length is limited by it)
    triDepth: 0.6        // the tip of the triangle island is cut at this depth (times the base) behind its base
    ,collideSlack: 0.2   // m, a path may come this much closer to an island or kerb than half its lane width
  };

  const LANE_TYPES = {
    vehicle: { label: 'Fahrzeug', width: 3.25 },
    bike: { label: 'Radfahrstreifen', width: 1.85 },
    bus: { label: 'Busspur', width: 3.25 },
    tram: { label: 'Straßenbahn', width: 3.0 }
  };
  // Lanes for motor vehicles (the free right turn and the proposals use only these).
  const isVehicle = g => g.lane.type === 'vehicle' || g.lane.type === 'bus';

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
  // Keeps the part of a polygon where (p - o) . n <= depth (Sutherland-Hodgman with one edge).
  function clipHalfPlane(pts, o, n, depth) {
    const f = p => (p.x - o.x) * n.x + (p.y - o.y) * n.y - depth, out = [];
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length], fp = f(p), fq = f(q);
      if (fp <= 0) out.push(p);
      if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) {
        const t = fp / (fp - fq);
        out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    });
    return out;
  }

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
      background: null,  // { name, src (data URL), wPx, hPx, mPerPx, x, y (world position of the top left corner), opacity }
      planOpacity: 1,    // opacity of the drawn plan over the background
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
    return { id: nextId(model, 'L'), armKey, dir, order, type, width: LANE_TYPES[type].width, length: null, stopOffset: 0, sgs: [], detectors: [] };
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
      arm.cornerRadius = cfg.cornerRadius != null ? cfg.cornerRadius : DEFAULTS.cornerRadius;
      arm.outStart = Math.max(0, +cfg.outStart || 0);
      buildArmGeometry(model, arm);
    });
    // Free right turn: the slip lane leaves its arm slipBack m before the stop line and joins the
    // egress lane slipAhead m after the stop line of the target arm. The kerb of the corner and the
    // triangle island follow. kerbFrom: the arm edge has no kerb (and no footway) before this distance.
    const derived = { center, autoCenter: autoC, arms, axes: entries };
    arms.forEach(arm => { arm.kerbFromIn = 0; arm.kerbFromOut = 0; arm.corner = null; arm.slipShared = false; });
    // A slip lane that also has other movements (e.g. straight on) is shared: the slip lane branches off
    // it, and the lane itself goes on to the stop line.
    arms.forEach(arm => {
      if (!arm.freeRight) return;
      const prev = freeRightTarget(derived, arm), ins = arm.in.filter(isVehicle);
      if (!prev || !ins.length) return;
      const outer = ins[ins.length - 1].lane.id, prevOut = new Set(prev.out.map(g => g.lane.id));
      arm.slipShared = model.connections.some(c => c.from === outer && !prevOut.has(c.to));
    });
    arms.forEach(arm => {
      if (!arm.freeRight) return;
      const pair = freeRightPair(derived, arm);
      if (!pair) return;
      const cfg = model.arms[arm.key] || {};
      const room = a => Math.max(0, a.length - a.stopDist - 3);
      arm.slipBack = Math.min(room(arm), Math.max(0, +cfg.slipBack || 0));
      arm.slipAhead = Math.min(room(pair.prev), Math.max(0, +cfg.slipAhead || 0));
      arm.kerbFromIn = arm.slipBack;
      pair.prev.kerbFromOut = arm.slipAhead;
      if (!arm.slipShared) pair.slip.slipStart = arm.slipBack;
    });
    // kerb arcs of the other corners; the arm edges have no kerb before the arc touches them
    const usable = arms.filter(a => a.widthIn + a.widthOut > 0);
    if (usable.length > 2) usable.forEach((a, i) => {
      const b = usable[(i + 1) % usable.length];
      if (b.freeRight && b.slipBack != null) return;
      b.corner = cornerArc(a, b, b.cornerRadius);
      if (!b.corner) return;
      a.kerbFromOut = Math.max(a.kerbFromOut, b.corner.sa - a.stopDist);
      b.kerbFromIn = Math.max(b.kerbFromIn, b.corner.sb - b.stopDist);
    });
    return derived;
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
        // An ingress lane can have its own stop line, set back from the stop line of the arm by stopOffset.
        // Its centre line (and so its connections) starts there.
        // The egress lanes of an arm can start further out (outStart), e.g. behind a large corner.
        const stopOff = Math.max(0, Math.min(subTotal - 2, dir === 'in' ? lane.stopOffset || 0 : arm.outStart || 0));
        const part = subPoly(sub, scl, stopOff, cut ? Math.min(subTotal, cut.len + DEFAULTS.taper / 2) : subTotal);
        const path = offsetPoly(part, side * (inner + lane.width / 2));
        const g = {
          lane, arm, dir, index: i, path, cut, stopOff,
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


  // Stop line pieces of an arm: one per group of neighbouring ingress lanes with the same stop line
  // offset. skipId: a lane without stop line (the slip lane of a free right turn). Returns [[a, b]].
  function stopLineSegments(arm, skipId) {
    const out = [];
    let cur = null;
    arm.in.forEach((g, i) => {
      if (g.lane.id === skipId) { cur = null; return; }
      const p = pointAt(arm.path, arm.cl, arm.stopDist + g.stopOff), nl = { x: -p.ty, y: p.tx };
      const from = i === 0 ? arm.gap / 2 : g.inner, to = g.outer;
      const at = d => ({ x: p.x + nl.x * d, y: p.y + nl.y * d });
      if (cur && cur.off === g.stopOff) cur.seg[1] = at(to);
      else { cur = { off: g.stopOff, seg: [at(from), at(to)] }; out.push(cur.seg); }
    });
    return out;
  }

  // Outline of a lane. A short lane gets a taper at its end: its free boundary moves
  // toward the anchored boundary until the width is zero.
  function laneOutline(g) {
    if (g._outline) return g._outline;
    const arm = g.arm, side = g.dir === 'in' ? 1 : -1;
    const total = arm.subCl[arm.subCl.length - 1];
    const end = g.cut ? Math.min(total, g.cut.len + DEFAULTS.taper) : total;
    // an ingress lane is filled up to the stop line of the arm; an egress lane from where it starts
    const s0 = g.dir === 'out' ? Math.min(g.stopOff || 0, end) : 0;
    const poly = subPoly(arm.sub, arm.subCl, s0, end);
    if (poly.length < 2) return (g._outline = { pts: [], innerEdge: [], outerEdge: [], poly, cl: [] });
    const cl = cumLen(poly).map(v => v + s0), w = g.lane.width;   // distance from the stop line
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
    const out = { walk: null, gapBase: null, outBase: null, island: null, freed: [], kerbs: [], kerbPolys: [] };
    if (arm.sub.length < 2) return out;
    const half = arm.gap / 2, W = DEFAULTS.walk;
    const total = arm.subCl[arm.subCl.length - 1];
    const fromIn = Math.min(total, arm.kerbFromIn || 0), fromOut = Math.min(total, arm.kerbFromOut || 0);
    const walkIn = subPoly(arm.sub, arm.subCl, fromIn, total), walkOut = subPoly(arm.sub, arm.subCl, fromOut, total);
    out.walk = offsetPoly(walkIn, half + arm.widthIn + W).concat(offsetPoly(walkOut, -(half + arm.widthOut + W)).reverse());
    if (arm.gap > 0.05) out.gapBase = offsetPoly(arm.sub, half).concat(offsetPoly(arm.sub, -half).reverse());
    // road between the stop line and the start of the egress lanes (outStart)
    if (arm.outStart > 0.05 && arm.widthOut > 0) {
      const part = subPoly(arm.sub, arm.subCl, 0, Math.min(total, arm.outStart + 0.05));
      if (part.length >= 2) out.outBase = offsetPoly(part, -half).concat(offsetPoly(part, -(half + arm.widthOut)).reverse());
    }
    if (arm.gap > 0.3 && arm.islandLen > 0) {
      // the round end lies at the stop line of the innermost ingress lane (it may be set back)
      const back = arm.in.length ? arm.in[0].stopOff : 0;
      const a = Math.max(0, arm.stopDist + back - DEFAULTS.islandBack), b = Math.min(arm.length, arm.stopDist + back + arm.islandLen);
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
        if (i === lanes.length - 1) {
          // a free right turn leaves (or joins) here: the kerb starts where its corner kerb ends
          const from = dir === 'in' ? fromIn : fromOut;
          const k = from > 0 ? o.outerEdge.filter((_, j) => o.cl[j] >= from) : o.outerEdge;
          if (k.length > 1) out.kerbs.push(k);
        }
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

  // Kerb of the corner between the right edge of arm a and the left edge of the next arm b: a circle of
  // radius R that touches both edges (as in road design, "Eckausrundung"). The edges follow the arm
  // axes, so the circle also fits curved arms. Returns { pts, sa, sb } or null:
  //   pts  outline from the stop line corner of a, along the edge of a, the arc, along the edge of b, to
  //        the stop line corner of b
  //   kerb the kerb line of the corner (the arc, and the edge parts on the junction side of the stop lines)
  //   sa, sb  distance (along the arm axis from the centre) of the points where the arc touches the edges
  function cornerArc(a, b, R) {
    if (!(R > 0.5) || a.path.length < 2 || b.path.length < 2) return null;
    const wa = a.gap / 2 + a.widthOut, wb = b.gap / 2 + b.widthIn;
    // the circle centre lies at R from both edges, on the footway side
    const xs = polyCrossings(offsetPoly(a.path, -(wa + R)), offsetPoly(b.path, wb + R));
    if (!xs.length) return null;
    let best = null;
    xs.forEach(O => {
      const pa = projectOnPoly(a.path, a.cl, O), pb = projectOnPoly(b.path, b.cl, O);
      const cost = Math.abs(pa.s - a.stopDist) + Math.abs(pb.s - b.stopDist);
      if (!best || cost < best.cost) best = { O, sa: pa.s, sb: pb.s, cost };
    });
    const { O, sa, sb } = best;
    if (sa < 0.5 || sb < 0.5 || sa > a.length - 1 || sb > b.length - 1) return null;
    const edgePt = (arm, sv, w) => { const p = pointAt(arm.path, arm.cl, sv); return { x: p.x - p.ty * w, y: p.y + p.tx * w }; };
    const Pa = edgePt(a, sa, -wa), Pb = edgePt(b, sb, wb);
    // the shorter arc from Pa to Pb
    const t0 = Math.atan2(Pa.y - O.y, Pa.x - O.x);
    let dt = Math.atan2(Pb.y - O.y, Pb.x - O.x) - t0;
    while (dt > Math.PI) dt -= 2 * Math.PI;
    while (dt < -Math.PI) dt += 2 * Math.PI;
    if (Math.abs(dt) < 0.03) return null;
    const n = Math.max(4, Math.ceil(Math.abs(dt) * R / 0.5)), arc = [];
    for (let i = 0; i <= n; i++) { const t = t0 + dt * i / n; arc.push({ x: O.x + R * Math.cos(t), y: O.y + R * Math.sin(t) }); }
    // edge parts between the stop line corners and the arc
    const edge = (arm, s0, s1, w) => offsetPoly(subPoly(arm.path, arm.cl, Math.min(s0, s1), Math.max(s0, s1)), w);
    let ea = edge(a, a.stopDist, sa, -wa); if (sa < a.stopDist) ea = ea.reverse();
    let eb = edge(b, b.stopDist, sb, wb); if (sb >= b.stopDist) eb = eb.reverse();
    const join = parts => { const o = []; parts.forEach(q => { if (!o.length || dist(o[o.length - 1], q) > 0.02) o.push(q); }); return o; };
    // the outline goes along the edges to the arc; an edge part is kerb only on the junction side of the
    // stop line (beyond the stop line, the edge borders the road of the corner, not the footway)
    const pts = join(ea.concat(arc, eb));
    const kerb = join((sa < a.stopDist ? ea : []).concat(arc, sb < b.stopDist ? eb : []));
    return { pts, kerb, sa, sb };
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
      const F = b.freeRight && b.slipBack != null && usable.length > 2 ? freeRightSlip(b, a) : null;
      if (F) {
        // the corner kerb is the kerb of the slip lane ('kerb': the kerb line, for drawing and collision checks)
        cmds.push({ type: 'L', pts: F.kerb, kerb: F.kerb }, { type: 'L', pts: [b.cornerLeft] });
        return;
      }
      if (b.corner && usable.length > 2) {
        cmds.push({ type: 'L', pts: b.corner.pts, kerb: b.corner.kerb }, { type: 'L', pts: [b.cornerLeft] });
        return;
      }
      const ctrl = lineIntersect(a.cornerRight, a.dir, b.cornerLeft, b.dir);
      const span = dist(a.cornerRight, b.cornerLeft);
      const ok = ctrl && dist(ctrl, a.cornerRight) < Math.max(25, span) && dist(ctrl, b.cornerLeft) < Math.max(25, span) &&
        // the kerb corner lies on the intersection side of both stop lines
        ((ctrl.x - a.cornerRight.x) * a.dir.x + (ctrl.y - a.cornerRight.y) * a.dir.y) < 0.01 &&
        ((ctrl.x - b.cornerLeft.x) * b.dir.x + (ctrl.y - b.cornerLeft.y) * b.dir.y) < 0.01;
      if (usable.length > 2 && ok) cmds.push({ type: 'Q', pts: [ctrl, b.cornerLeft] });
      // no curve (e.g. two arms of the same axis with different widths): a straight kerb between the corners
      else if (usable.length > 2) cmds.push({ type: 'L', pts: [b.cornerLeft], kerb: [a.cornerRight, b.cornerLeft] });
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
    const angle = turnAngle(h0, h1), turn = Math.abs(angle), chord = dist(p0, p1);
    // the sweep grows with the turn angle, so a turn stays clear of the islands in the corners
    const k = Math.max(2, chord * (0.42 + 0.2 * Math.min(1, turn / 90)));
    const k0 = k, k1 = k;
    return {
      p0, p1,
      c0: { x: p0.x + h0.x * k0, y: p0.y + h0.y * k0 },
      c1: { x: p1.x - h1.x * k1, y: p1.y - h1.y * k1 },
      h0, h1, angle
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
    const reserved = new Set(), reservedBy = new Map();
    derived.arms.forEach(a => {
      const pair = a.freeRight ? freeRightPair(derived, a) : null;
      if (pair) { reserved.add(pair.target.lane.id); reservedBy.set(pair.target.lane.id, pair.slip.lane.id); }
    });
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
      let throughIdx = 0;      // number of through lanes before the lane that is handled now
      const pick = (g, targetArm, m) => {
        // the egress lane of a free right turn belongs to the slip lane only
        const free = targetArm.out.filter(o => !reserved.has(o.lane.id) || g.lane.id === reservedBy.get(o.lane.id));
        const outs = free.length ? free : targetArm.out;
        const same = outs.filter(o => o.lane.type === g.lane.type);
        // a motor vehicle may use a shared tram lane, never a bike lane
        const motor = outs.filter(o => o.lane.type !== 'bike');
        const pool = same.length ? same : (g.lane.type !== 'bike' && motor.length ? motor : outs);
        let idx = m === 'left' ? 0 : m === 'right' ? pool.length - 1 : Math.min(throughIdx, pool.length - 1);
        return pool[Math.max(0, idx)];
      };
      const vehicleIns = ins.filter(isVehicle);
      ins.forEach(g => {
        let wanted;
        if (g.lane.type === 'tram') return;          // tracks are connected by hand
        if (g.lane.type === 'bike') wanted = ['straight'];
        else {
          const k = vehicleIns.indexOf(g), n = vehicleIns.length;
          const has = mv => !!targets[mv];
          if (n === 1) wanted = ['left', 'straight', 'right'];
          else if (k === n - 1) {
            // outermost lane: a free right turn or a short (widened) lane turns right only
            wanted = arm.freeRight || (g.cut && g.cut.anchor === 'inner') ? ['right'] : ['straight', 'right'];
          } else if (k === 0 && has('left')) {
            // innermost lane: a short lane turns left only
            wanted = g.cut && g.cut.anchor === 'outer' ? ['left'] : (n === 2 && !arm.freeRight ? ['left', 'straight'] : ['left']);
          } else wanted = ['straight'];
          // only movements that exist at this junction; a lane without any keeps the nearest one
          wanted = wanted.filter(has);
          if (!wanted.length) wanted = ['straight', 'right', 'left'].filter(has).slice(0, 1);
        }
        wanted.forEach(m => {
          if (!targets[m]) return;
          const to = pick(g, targets[m].arm, m);
          if (to) out.push({ from: g.lane.id, to: to.lane.id });
        });
        if (wanted.includes('straight') && isVehicle(g)) throughIdx++;
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
    const veh = lanes => lanes.filter(isVehicle);
    const ins = veh(arm.in), outs = veh(prev.out);
    // The island lies between the slip lane and the next lane inside it. So the slip lane and its egress
    // lane must not be the innermost lanes (another lane of any type, e.g. a tram lane, lies inside).
    if (!ins.length || !outs.length) return null;
    const slip = ins[ins.length - 1], target = outs[outs.length - 1];
    if ((slip.index < 1 && !arm.slipShared) || target.index < 1) return null;
    return { prev, slip, target };
  }

  // Slip lane of a free right turn between arm (slip lane) and prev (target arm). Its centre line S leaves
  // the slip lane slipBack m before the stop line and joins the egress lane slipAhead m after the stop
  // line of the target arm. S is straight - arc - straight like every right turn (radius
  // DEFAULTS.rightRadius at most). The kerb (right of S) and the island edge (left of S) keep the lane
  // width; the width goes smoothly from the slip lane to the egress lane.
  // Returns { slip, target, S, curve (island edge), kerb (from prev to arm), dSlip, dEgress } or null.
  function freeRightSlip(arm, prev) {
    const veh = l => l.filter(isVehicle);
    const ins = veh(arm.in), outs = veh(prev.out);
    if (!ins.length || !outs.length) return null;
    const slip = ins[ins.length - 1], target = outs[outs.length - 1];
    if ((slip.index < 1 && !arm.slipShared) || target.index < 1) return null;
    const q0 = pointAt(slip.path, slip.cl, Math.min(arm.slipBack || 0, slip.cl[slip.cl.length - 1]));
    const q1 = pointAt(target.path, target.cl, Math.min(arm.slipAhead || 0, target.cl[target.cl.length - 1]));
    const p0 = { x: q0.x, y: q0.y }, h0 = { x: -q0.tx, y: -q0.ty }, p1 = { x: q1.x, y: q1.y }, h1 = { x: q1.tx, y: q1.ty };
    const X = lineIntersect(p0, h0, p1, h1);
    if (!X) return null;
    const d0 = (X.x - p0.x) * h0.x + (X.y - p0.y) * h0.y, d1 = (p1.x - X.x) * h1.x + (p1.y - X.y) * h1.y;
    if (d0 < 0.5 || d1 < 0.5) return null;
    const angle = Math.abs(turnAngle(h0, h1));
    const Lmax = DEFAULTS.rightRadius * Math.tan(angle * Math.PI / 360);
    const S = arcPath(p0, h0, p1, h1, X, Math.min(d0, 1.3 * d1, Lmax), Math.min(d1, 1.3 * d0, Lmax), rightHandle(angle));
    const scl = cumLen(S), total = scl[scl.length - 1];
    const dSlip = (arm.gap / 2 + arm.widthIn) - slip.inner;            // kerb to the inner edge of the slip lane
    const dEgress = (prev.gap / 2 + prev.widthOut) - target.inner;     // kerb to the inner edge of the egress lane
    const wS = slip.lane.width, wT = target.lane.width;
    const f = sv => sv / total;
    const curve = offsetPoly(S, scl.map(sv => (wS + (wT - wS) * f(sv)) / 2));                       // left of S
    const kerb = offsetPoly(S, scl.map(sv => -((dSlip - wS / 2) + ((dEgress - wT / 2) - (dSlip - wS / 2)) * f(sv)))).reverse();
    return { slip, target, S, curve, kerb, dSlip, dEgress };
  }

  // Inner handle position of a right turn: 0.5 up to 65 degrees, rounder (down to 0.3) for sharper turns.
  // Fitted to hand-drawn driving lines.
  const rightHandle = angle => Math.max(0.3, Math.min(0.5, 0.7 - 0.0031 * angle));

  // Straight - arc - straight from p0 (heading h0) to p1 (heading h1). X: where the two headings meet;
  // L0, L1: tangent lengths of the arc at X; b: position of the inner handles of the quintic arc.
  function arcPath(p0, h0, p1, h1, X, L0, L1, b) {
    const a = 0.15, A = along(X, h0, -L0), B = along(X, h1, L1);
    const arc = quintic([A, along(A, h0, a * L0), along(A, h0, b * L0), along(B, h1, -b * L1), along(B, h1, -a * L1), B], 48);
    const pts = straightPart(p0, A).slice(0, -1).concat(arc, straightPart(B, p1)), line = [p0];
    pts.forEach(q => { if (dist(line[line.length - 1], q) > 0.02) line.push(q); });
    return line;
  }

  // Island between the slip lane and the other lanes: a triangle with a concave long side.
  function freeRightIslands(derived) {
    const out = [];
    derived.arms.forEach(arm => {
      if (!arm.freeRight) return;
      const pair = freeRightPair(derived, arm);
      if (!pair) return;
      const { prev, slip, target } = pair;
      // the island starts at the inner edge of the slip lane, or at its outer edge when the lane is shared
      const legIn = arm.slipShared ? slip.outer : slip.inner;
      const v1 = { x: arm.stopPt.x + arm.normal.x * legIn, y: arm.stopPt.y + arm.normal.y * legIn };
      const v2 = { x: prev.stopPt.x - prev.normal.x * target.inner, y: prev.stopPt.y - prev.normal.y * target.inner };
      const apex = lineIntersect(v1, arm.dir, v2, prev.dir);
      if (!apex) return;
      const inward = (p, from, dir) => (p.x - from.x) * dir.x + (p.y - from.y) * dir.y < -0.5;
      if (!inward(apex, v1, arm.dir) || !inward(apex, v2, prev.dir)) return;

      const F = freeRightSlip(arm, prev);
      if (!F) return;
      const { curve, kerb, dSlip, dEgress } = F;

      // The island must never reach into a lane: its straight legs lie on the lane boundaries and
      // its curved side keeps the lane width to the kerb. The thin ends are cut where the island is
      // DEFAULTS.triTip wide (a thinner end can not be rounded); the flat ends are then rounded.
      // signed distance of q to the line through v along d, positive on the island side (sgn)
      const gapTo = (q, v, d, sgn) => sgn * ((q.y - v.y) * d.x - (q.x - v.x) * d.y);
      // the slip lane turns toward the kerb, so the island lies on the kerb side of the ingress leg and on
      // the outer side of the egress leg (a shared slip lane starts on the wrong side of its leg)
      const k = curve.findIndex(q => gapTo(q, v1, arm.dir, 1) >= DEFAULTS.triTip);
      let m = -1;
      curve.forEach((q, i) => { if (gapTo(q, v2, prev.dir, -1) >= DEFAULTS.triTip) m = i; });
      if (k < 0 || m <= k) return;
      const onLine = (q, v, d) => { const t = (q.x - v.x) * d.x + (q.y - v.y) * d.y; return { x: v.x + d.x * t, y: v.y + d.y * t }; };
      const pa = onLine(curve[k], v1, arm.dir), pb = onLine(curve[m], v2, prev.dir);
      let pts = [pa].concat(curve.slice(k, m + 1), [pb, apex]);
      // When the slip lane leaves before the stop line (or joins after it), the island lies between the
      // slip lane and the two stop lines: its side toward the junction is the line from v2 to v1.
      const outward = (q, v, dir) => (q.x - v.x) * dir.x + (q.y - v.y) * dir.y > 0.5;
      const chord = (arm.slipBack || 0) > 0 || (arm.slipAhead || 0) > 0;
      if (chord) pts = (outward(pa, v1, arm.dir) ? [v1, pa] : [pa]).concat(curve.slice(k, m + 1), outward(pb, v2, prev.dir) ? [pb, v2] : [pb]);
      // When the two arms meet at a sharp angle, the legs are long and the tip reaches into the through
      // lanes. The tip is then cut flat: no point lies deeper than DEFAULTS.triDepth times the base
      // (the line from v1 to v2) behind the base.
      const base = dist(v1, v2);
      if (base > 0.5 && !chord) {
        let n = { x: -(v2.y - v1.y) / base, y: (v2.x - v1.x) / base };
        if ((apex.x - v1.x) * n.x + (apex.y - v1.y) * n.y < 0) n = { x: -n.x, y: -n.y };
        pts = clipHalfPlane(pts, v1, n, DEFAULTS.triDepth * base);
        if (pts.length < 3) return;
      }
      // the radius must stay below half the width of the noses, or the inset polygon folds over
      const r = Math.min(fitRadius(pts, DEFAULTS.triRound), DEFAULTS.triTip * 0.47);
      const slipPath = F.S;
      out.push({ armKey: arm.key, polygon: insetPolygon(pts, r), r, outline: pts, curve, kerb, widths: [dSlip, dEgress], slipPath, slipFrom: slip.lane.id, slipTo: target.lane.id });
    });
    return out;
  }

  // The arm that receives the free right turn of an arm (the next arm counterclockwise, on the kerb side).
  function freeRightTarget(derived, arm) {
    const arms = derived.arms;
    if (arms.length < 2) return null;
    const prev = arms[(arms.indexOf(arm) - 1 + arms.length) % arms.length];
    return prev && prev !== arm ? prev : null;
  }
  // True when a free right turn can be switched on: the arm has a vehicle ingress lane and a neighbour arm.
  // Missing lanes are added when it is switched on (see applyFreeRight).
  function freeRightPossible(derived, arm) {
    return !!freeRightPair(derived, arm) || (!!freeRightTarget(derived, arm) && arm.in.some(isVehicle));
  }

  // Inserts a lane after the last vehicle lane of an arm side (a bike lane at the kerb stays outside).
  function insertVehicleLane(model, derived, armKey, dir, length) {
    const arm = derived.arms.find(a => a.key === armKey);
    const list = arm ? arm[dir] : [];
    let at = 0;
    list.forEach((g, i) => { if (isVehicle(g)) at = i + 1; });
    lanesOf(model, armKey, dir).forEach(l => { if (l.order >= at) l.order += 1; });
    const lane = newLane(model, armKey, dir, at, 'vehicle');
    // only the outermost lane can be short (it ends with a taper)
    lane.length = at === list.length ? length : null;
    model.lanes.push(lane);
    return lane;
  }

  // Switches the free right turn of an arm. The slip lane then only turns right.
  // When switched on and lanes are missing, they are added:
  //  - a short slip lane at the kerb, when the arm has only one vehicle ingress lane, or when its
  //    outermost vehicle lane also has movements that are not a right turn into the target arm;
  //  - a short merge lane at the target arm, when that arm has only one vehicle egress lane.
  // Returns the list of added lanes.
  function applyFreeRight(model, derived, armKey, on) {
    const cfg = model.arms[armKey] || (model.arms[armKey] = {});
    cfg.freeRight = !!on;
    const added = [];
    if (!on) return added;
    let arm = derived.arms.find(a => a.key === armKey);
    const prev = arm && freeRightTarget(derived, arm);
    if (!arm || !prev || !arm.in.some(isVehicle)) return added;
    const ins = arm.in.filter(isVehicle), outs = prev.out.filter(isVehicle);
    const outer = ins[ins.length - 1];
    const prevOut = new Set(prev.out.map(g => g.lane.id));
    const otherMoves = model.connections.some(c => c.from === outer.lane.id && !prevOut.has(c.to));
    if (outer.index < 1 || otherMoves) added.push(insertVehicleLane(model, derived, arm.key, 'in', 25));
    if (!outs.length || outs[outs.length - 1].index < 1) added.push(insertVehicleLane(model, derived, prev.key, 'out', 20));
    const d = added.length ? derive(model) : derived;
    arm = d.arms.find(a => a.key === armKey);
    const pair = arm ? freeRightPair(d, arm) : null;
    if (!pair) return added;
    model.connections = model.connections.filter(c => c.from !== pair.slip.lane.id);
    addConnection(model, pair.slip.lane.id, pair.target.lane.id);
    return added;
  }


  /* ---------------- Connection paths and collisions ---------------- */
  // Sampled centre line of a connection. A free right turn follows the slip lane (kerb curve moved
  // inward), every other connection is the cubic curve between its two lanes.
  function connectionPolyline(model, derived, conn, islands) {
    const geoms = allLaneGeoms(derived);
    const a = geoms.get(conn.from), b = geoms.get(conn.to);
    if (!a || !b) return [];
    const isl = (islands || freeRightIslands(derived)).find(i => i.slipFrom === conn.from && i.slipTo === conn.to);
    if (isl) return isl.slipPath;
    const cands = drivingPaths(a, b);
    // the first shape that keeps the lane clear of islands and kerbs; else the one with the most room
    const need = clearanceNeed(a, b), obst = obstacles(derived, islands);
    let best = null, bestRoom = -Infinity;
    for (const make of cands) {
      const line = make(), room = clearance(line, obst);
      if (room >= need) return line;
      if (room > bestRoom + 0.05) { best = line; bestRoom = room; }
    }
    return best;
  }

  // Islands (polygons) and curved kerbs (polylines) a connection must not touch. Cached on the derived data.
  function obstacles(derived, islands) {
    if (derived._obstacles) return derived._obstacles;
    const solid = [];
    (islands || freeRightIslands(derived)).forEach(i => solid.push(i.outline));
    derived.arms.forEach(arm => {
      const sf = armSurfaces(arm);
      if (sf.island) solid.push(sf.island);
      sf.freed.forEach(f => solid.push(f));
    });
    return (derived._obstacles = { solid, kerbs: kerbPolylines(derived) });
  }
  // The path ends in the middle of its egress lane: a narrow egress lane may be closer to the kerb.
  const clearanceNeed = (g, h) => Math.min(g.lane.width, h.lane.width) / 2 - DEFAULTS.collideSlack - 0.01;
  // Smallest distance of a centre line to the obstacles: { island, kerb } and min of both as a number.
  function clearanceParts(line, obst) {
    let island = Infinity, kerb = Infinity;
    line.forEach(p => {
      obst.solid.forEach(poly => { island = Math.min(island, pointPolygonDistance(p, poly)); });
      obst.kerbs.forEach(k => { kerb = Math.min(kerb, pointPolylineDistance(p, k)); });
    });
    return { island, kerb };
  }
  function clearance(line, obst) { const c = clearanceParts(line, obst); return Math.min(c.island, c.kerb); }

  // Quintic Bezier curve through 6 control points, sampled at n + 1 points.
  function quintic(P, n) {
    const W = [1, 5, 10, 10, 5, 1], out = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, u = 1 - t;
      let x = 0, y = 0;
      for (let j = 0; j < 6; j++) {
        const w = W[j] * Math.pow(t, j) * Math.pow(u, 5 - j);
        x += P[j].x * w; y += P[j].y * w;
      }
      out.push({ x, y });
    }
    return out;
  }
  const along = (p, h, s) => ({ x: p.x + h.x * s, y: p.y + h.y * s });

  // Straight line from a to b, sampled about every metre (start point not included).
  function straightPart(a, b) {
    const n = Math.max(1, Math.ceil(dist(a, b))), out = [];
    for (let i = 1; i <= n; i++) out.push({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n });
    return out;
  }

  // Driving line of a connection, like a vehicle drives it: straight out of the ingress lane, one
  // smooth arc, straight into the egress lane.
  //  - The two lane headings meet at the corner point X. The arc uses a tangent length on each side
  //    (L0 toward the ingress lane, L1 toward the egress lane); the rest of each leg is straight.
  //  - The arc is a quintic Bezier curve with its inner handles on the lane headings. Its curvature is
  //    zero at both ends, so the line has no kinks and no jumps in curvature. Handles of 0.15 L and
  //    about 0.6 L give a peak curvature near that of a circle with the same tangent length.
  //  - When the egress lane starts very close to the corner, the arc continues into the egress lane,
  //    so the turning radius stays realistic (a vehicle finishes the turn after the crossing).
  //  - A movement without a usable corner (straight on, with or without a small sideways shift) is
  //    one symmetric S curve.
  // Returns candidate lines as functions (computed only when needed), the preferred shape first;
  // connectionPolyline uses the first that is clear.
  function drivingPaths(fromG, toG) {
    const p0 = fromG.startPt;
    const h0 = { x: -fromG.arm.dir.x, y: -fromG.arm.dir.y };
    let p1 = toG.startPt, h1 = { x: toG.arm.dir.x, y: toG.arm.dir.y };
    const angle = Math.abs(turnAngle(h0, h1));
    const corner = (q, hq) => {
      const X = lineIntersect(p0, h0, q, hq);
      if (!X) return null;
      const d0 = (X.x - p0.x) * h0.x + (X.y - p0.y) * h0.y, d1 = (q.x - X.x) * hq.x + (q.y - X.y) * hq.y;
      return { X, d0, d1 };
    };
    // Straight on (below 45 degrees): a nearly direct line between the two lane ends, with short
    // handles (a smooth bend only near each end), like a vehicle drives across. Fitted to hand-drawn
    // driving lines. Other S curves follow as fallbacks (islands at the far or near side).
    const sLines = [];
    if (angle < 45) {
      const q = toG.startPt, hq = { x: toG.arm.dir.x, y: toG.arm.dir.y }, D = dist(p0, q);
      const sLine = (a0, b0, b1, a1) => quintic([p0, along(p0, h0, a0 * D), along(p0, h0, b0 * D), along(q, hq, -b1 * D), along(q, hq, -a1 * D), q], 60);
      [[0.05, 0.2, 0.2, 0.05], [0.02, 0.08, 0.2, 0.05], [0.05, 0.2, 0.08, 0.02], [0.15, 0.42, 0.42, 0.15], [0.06, 0.25, 1.0, 0.3], [0.03, 0.2, 1.2, 0.3], [0.3, 1.0, 0.25, 0.06]]
        .forEach(f => sLines.push(() => sLine(...f)));
    }
    let c = angle >= 12 && angle <= 160 ? corner(p1, h1) : null;
    const right = turnAngle(h0, h1) < 0;
    // A right turn sweeps with a radius of about DEFAULTS.rightRadius: its tangent length is limited.
    const Lmax = right && angle >= 45 ? DEFAULTS.rightRadius * Math.tan(angle * Math.PI / 360) : Infinity;
    if (c && c.d0 > 0.5 && angle >= 45) {
      // The turn continues into the egress lane when the egress leg is shorter than the wanted tangent
      // (a vehicle finishes the turn after the crossing).
      const want = right ? Math.min(c.d0, Lmax) : 0.6 * c.d0;
      const avail = (toG.cut ? Math.min(toG.cut.len, toG.cl[toG.cl.length - 1]) : toG.cl[toG.cl.length - 1]) - 1;
      if (c.d1 < want && avail > 0) {
        const q = pointAt(toG.path, toG.cl, Math.min(avail, want - c.d1, 15));
        p1 = { x: q.x, y: q.y }; h1 = { x: q.tx, y: q.ty };
        c = corner(p1, h1);
      }
    }
    if (c && c.d0 > 0.5 && c.d1 > 0.5) {
      // The line is straight - arc - straight. The arc has the tangent lengths L0 (toward the ingress
      // lane) and L1 (toward the egress lane) at the corner point X, where the two lane headings meet.
      //  - left turn: the arc uses nearly the whole of both legs (each at most 1.3 times the other);
      //  - right turn: both tangents are at most Lmax (radius DEFAULTS.rightRadius);
      //  - small bend (below 45 degrees): one long, gentle curve over both legs.
      // b: position of the inner handles (0.5 to 0.75 gives a near-circular arc with zero curvature at
      // its ends; the values for turns are fitted to hand-drawn driving lines). Other shapes follow as fallbacks, for lines that would touch an island or a kerb.
      const b = angle < 45 ? Math.max(0.5, Math.min(0.75, 0.8 - 0.0025 * angle)) : right ? rightHandle(angle) : 0.6;
      // run: a straight part before the arc (and after it), so the line can pass the round end of a
      // median island next to the lane. Lines with a shorter run are tried first.
      const island = g => g.index === 0 && g.arm.gap > 0.3 && g.arm.islandLen > 0;
      const arcLine = (lengths, bb, run) => {
        const e0 = Math.max(0.5, c.d0 - (island(fromG) ? run : 0)), e1 = Math.max(0.5, c.d1 - (island(toG) ? run : 0));
        const [L0, L1] = lengths(e0, e1);
        return arcPath(p0, h0, p1, h1, c.X, L0, L1, bb);
      };
      const ratio = r => (e0, e1) => [Math.min(e0, r * e1, Lmax), Math.min(e1, r * e0, Lmax)];
      const main = angle >= 45 ? ratio(1.3) : ratio(10);
      const b2 = Math.min(0.92, b + 0.15), out = sLines.slice();
      const maxRun = DEFAULTS.islandBack + 1 + (fromG.stopOff || 0);
      [0, 1, 2, maxRun / 2, maxRun].forEach((run, k) => {
        if (k && (!island(fromG) && !island(toG) || (k > 2 && run <= 2))) return;
        out.push(() => arcLine(main, b, run), () => arcLine(main, b2, run), () => arcLine(main, 0.82, run));
        [1, 1.6, 10].forEach(r => [b, b2].forEach(bb => out.push(() => arcLine(ratio(r), bb, run))));
      });
      return out;
    }
    // no usable corner: the S curves (a U-turn has none: it uses the direct curve)
    if (sLines.length) return sLines;
    const D = dist(p0, p1);
    return [() => quintic([p0, along(p0, h0, 0.4 * D), along(p0, h0, 0.8 * D), along(p1, h1, -0.8 * D), along(p1, h1, -0.4 * D), p1], 60)];
  }

  function pointPolygonDistance(p, poly) {
    let inside = false, best = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      best = Math.min(best, distToSegment(p, a, b));
    }
    return inside ? 0 : best;
  }
  function pointPolylineDistance(p, line) {
    let best = Infinity;
    for (let i = 0; i < line.length - 1; i++) best = Math.min(best, distToSegment(p, line[i], line[i + 1]));
    return best;
  }

  // The curved kerbs of the junction as polylines.
  function kerbPolylines(derived) {
    const cmds = junctionOutline(derived.arms), out = [];
    cmds.forEach((c, i) => {
      if (c.kerb) { if (c.kerb.length > 1) out.push(c.kerb.slice()); return; }
      if (c.type !== 'Q') return;
      const p0 = cmds[i - 1].pts[cmds[i - 1].pts.length - 1], q = c.pts[0], p2 = c.pts[1], line = [];
      for (let j = 0; j <= 24; j++) { const t = j / 24, u = 1 - t; line.push({ x: u * u * p0.x + 2 * u * t * q.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * q.y + t * t * p2.y }); }
      out.push(line);
    });
    return out;
  }

  // Rule: the lane of a connection must never touch an island or a kerb inside the junction.
  // Returns [{ connId, kind: 'island'|'kerb', dist }] (dist = smallest distance of the centre line).
  function connectionIssues(model, derived) {
    const islands = freeRightIslands(derived), obst = obstacles(derived, islands);
    const geoms = allLaneGeoms(derived), out = [];
    model.connections.forEach(conn => {
      const g = geoms.get(conn.from), h = geoms.get(conn.to);
      if (!g || !h) return;
      const need = clearanceNeed(g, h);
      const c = clearanceParts(connectionPolyline(model, derived, conn, islands), obst);
      if (c.island < need) out.push({ connId: conn.id, kind: 'island', dist: c.island });
      else if (c.kerb < need) out.push({ connId: conn.id, kind: 'kerb', dist: c.kerb });
    });
    return out;
  }

  /* ---------------- Example ---------------- */
  // Four arms with two ingress lanes, one egress lane and a crossing each.
  function exampleCrossing(model) {
    const ew = addAxis(model, [{ x: -95, y: -7 }, { x: -45, y: -1 }, { x: 0, y: 0 }, { x: 45, y: 1 }, { x: 95, y: 6 }]);
    const ns = addAxis(model, [{ x: 4, y: -95 }, { x: 1, y: -45 }, { x: 0, y: 0 }, { x: -1, y: 45 }, { x: -5, y: 95 }]);
    ew.name = 'Hauptstraße'; ns.name = 'Querstraße';
    let d = derive(model);
    ensureDefaults(model, d);
    const arm = name => derive(model).arms.find(a => a.name === name);
    const lanes = (name, dir, types) => {            // lane types from the median outward
      const key = arm(name).key;
      setLaneCount(model, key, dir, types.length);
      lanesOf(model, key, dir).forEach((l, i) => setLaneType(l, types[i]));
    };
    const V = 'vehicle', B = 'bike';
    // Main road: median island, left turning lane (35 m), bike lane along the south kerb.
    lanes('West', 'in', [V, V, V, B]);  lanes('West', 'out', [V, V, V]);   // the third egress lane belongs to the free right turn
    lanes('Ost', 'in', [V, V, V]);      lanes('Ost', 'out', [V, V, B]);
    ['West', 'Ost'].forEach(n => {
      const cfg = model.arms[arm(n).key];
      cfg.gap = 3; cfg.islandLen = 40; cfg.stopDist = 18;
      lanesOf(model, arm(n).key, 'in')[0].length = 35;
    });
    // Side street: free right turn from the north (triangle island in the north-west corner), bike lane along the east kerb.
    lanes('Nord', 'in', [V, V]);        lanes('Nord', 'out', [V, B]);
    lanes('Süd', 'in', [V, V, B]);      lanes('Süd', 'out', [V]);
    ['Nord', 'Süd'].forEach(n => { model.arms[arm(n).key].stopDist = 20; });
    model.arms[arm('Nord').key].freeRight = true;
    derive(model).arms.forEach(a => setCrosswalk(model, a.key, true));
    d = derive(model);
    proposeConnections(model, d).forEach(c => addConnection(model, c.from, c.to));
    return derive(model);
  }


  /* ---------------- Background image (plan, aerial photo, PDF page) ---------------- */
  // Places a new background. When the old background has the same pixel size, its position and scale are kept
  // (the same plan imported again, or a configuration saved without the image data).
  function placeBackground(model, img, center) {
    const old = model.background;
    if (old && old.wPx === img.wPx && old.hPx === img.hPx) {
      model.background = Object.assign({}, old, { name: img.name, src: img.src });
      return false;
    }
    const mPerPx = 0.1;
    model.background = {
      name: img.name, src: img.src, wPx: img.wPx, hPx: img.hPx, mPerPx,
      x: center.x - (img.wPx * mPerPx) / 2, y: center.y + (img.hPx * mPerPx) / 2, opacity: 0.6
    };
    return true;
  }

  // Scale tool: the two points a and b (world metres, measured on the image) are "realLength" metres apart.
  // The image is scaled around a, so a stays where it is.
  function scaleBackground(model, a, b, realLength) {
    const bg = model.background;
    const measured = dist(a, b);
    if (!bg || !(measured > 1e-6) || !(realLength > 0)) return null;
    const f = realLength / measured;
    bg.mPerPx *= f;
    bg.x = a.x + (bg.x - a.x) * f;
    bg.y = a.y + (bg.y - a.y) * f;
    return f;
  }

  // World position of an image pixel and back (y of the world points north, y of the image points down).
  function bgPixelToWorld(bg, px, py) { return { x: bg.x + px * bg.mPerPx, y: bg.y - py * bg.mPerPx }; }
  function bgWorldToPixel(bg, p) { return { px: (p.x - bg.x) / bg.mPerPx, py: (bg.y - p.y) / bg.mPerPx }; }

  /* ---------------- Persistence (part of the node configuration file) ---------------- */
  function toConfig(model) {
    return JSON.parse(JSON.stringify({
      version: 1, name: model.name, refLat: model.refLat, refLon: model.refLon,
      axes: model.axes, center: model.center, arms: model.arms, lanes: model.lanes,
      crosswalks: model.crosswalks, connections: model.connections,
      background: model.background, planOpacity: model.planOpacity
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
      stopOffset: num(l.stopOffset) > 0 ? l.stopOffset : 0,
      sgs: strList(l.sgs), detectors: strList(l.detectors)
    }));
    m.crosswalks = (cfg.crosswalks || []).filter(c => c && c.id && c.armKey).map(c => ({
      id: String(c.id), armKey: String(c.armKey), width: num(c.width) || DEFAULTS.crossWidth,
      sgs: strList(c.sgs), detectors: strList(c.detectors)
    }));
    const b = cfg.background;
    if (b && typeof b === 'object' && num(b.wPx) > 0 && num(b.hPx) > 0 && num(b.mPerPx) > 0) {
      m.background = {
        name: typeof b.name === 'string' ? b.name : '',
        src: typeof b.src === 'string' && /^data:(image\/|application\/pdf)/.test(b.src) ? b.src : null,
        wPx: b.wPx, hPx: b.hPx, mPerPx: b.mPerPx, x: num(b.x) || 0, y: num(b.y) || 0,
        opacity: num(b.opacity) != null ? Math.max(0, Math.min(1, b.opacity)) : 0.6
      };
    }
    m.planOpacity = num(cfg.planOpacity) != null ? Math.max(0, Math.min(1, cfg.planOpacity)) : 1;
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
            laneType: { [g.lane.type === 'bike' ? 'bikeLane' : g.lane.type === 'tram' ? 'trackedVehicle' : 'vehicle']: {} }
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
    sampleSpline, cleanPoly, resamplePoly, stadiumPolygon, roundCorners, laneOutline, armSurfaces, freeRightPair, freeRightPossible, freeRightSlip, arcPath, cornerArc, drivingPaths, stopLineSegments, freeRightIslands, applyFreeRight, insetPolygon, fitRadius, connectionPolyline, connectionIssues, pointPolygonDistance, kerbPolylines, cumLen, polyLength, pointAt, subPoly, offsetPoly, projectOnPoly,
    segIntersect, lineIntersect, polyCrossings, closestApproach, bearingOf, compassName, turnAngle, maneuverOfAngle, simplify,
    // model
    placeBackground, scaleBackground, bgPixelToWorld, bgWorldToPixel,
    create, addAxis, removeAxis, setLaneCount, setLaneType, setCrosswalk, addConnection, removeConnection, ensureDefaults,
    lanesOf, derive, junctionOutline, allLaneGeoms, connectionCurve, cubicPoint, connectionManeuver, laneManeuvers, connectionSg,
    proposeConnections, exampleCrossing, toConfig, fromConfig, signalGroupIds, toMapem
  };
})(window.GZ = window.GZ || {});
