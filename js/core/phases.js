/* GZ.phases is the phase division of a traffic signal (RiLSA).
   A phase groups the signal groups that show green (release) AT THE SAME TIME.
   These signal groups have no traffic conflict with each other.
   In each cycle, a signal program runs through a fixed sequence of phases.
   Intergreen times separate the phases.
   So, by definition, two phases are never active at the same time.
   This file uses the existing green segments (stats.greens of each member signal group).
   It finds WHEN a defined phase was fully shown in the recording.
   This is pure evaluation logic and does not depend on the DOM. */
(function (GZ) {
  'use strict';

  // Categorical color palette for each phase.
  // The order is the definition order in GZ.state.data.phases.
  // The palette is different from the signal colors (--sig-*) on purpose.
  // So it is clear at first sight that these colors identify phases and are not traffic signal
  // states.
  const PHASE_COLORS = [
    '#3b7dc4', '#e08a2f', '#6c4fb0', '#2fa393',
    '#c2517a', '#8a9a2f', '#b8464a', '#4f7942',
    '#a3762f', '#4a5a8a'
  ];
  function colorForIndex(i) { return PHASE_COLORS[i % PHASE_COLORS.length]; }

  // Intersection of several sorted, disjoint interval lists (for example stats.greens of each
  // member signal group).
  // It returns the time ranges in which ALL lists cover an interval at the same time.
  // The method is a sweep line over start (+1) and end (-1) events.
  // The cost is O(m log m), where m is the total number of intervals.
  function intersectIntervals(intervalLists) {
    const n = intervalLists.length;
    if (n === 0) return [];
    const events = [];
    for (const list of intervalLists) {
      for (const iv of list) {
        events.push([iv.start, 1]);
        events.push([iv.end, -1]);
      }
    }
    if (events.length === 0) return [];
    // If events have the same time, first process the ends (-1) and then the starts (+1).
    // Then intervals that touch exactly do not count as an overlap.
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let count = 0, activeStart = null;
    const result = [];
    for (const [t, delta] of events) {
      const before = count;
      count += delta;
      if (before < n && count === n) activeStart = t;
      else if (before === n && count < n && activeStart != null) {
        if (t > activeStart) result.push({ start: activeStart, end: t });
        activeStart = null;
      }
    }
    return result;
  }

  // Union of several sorted, disjoint interval lists.
  // It returns the time ranges in which AT LEAST ONE list covers an interval.
  // The sweep-line principle is the same as in intersectIntervals above.
  // The active condition is "count > 0" and not "count === n".
  // The code needs this union to find EXACTLY the times in which a signal group that is not in the
  // phase is green (see computePhaseOccurrences below).
  function unionIntervals(intervalLists) {
    const events = [];
    for (const list of intervalLists) {
      for (const iv of list) {
        events.push([iv.start, 1]);
        events.push([iv.end, -1]);
      }
    }
    if (events.length === 0) return [];
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let count = 0, activeStart = null;
    const result = [];
    for (const [t, delta] of events) {
      const before = count;
      count += delta;
      if (before === 0 && count > 0) activeStart = t;
      else if (before > 0 && count === 0) { result.push({ start: activeStart, end: t }); activeStart = null; }
    }
    return result;
  }

  // Removes all time ranges of a second sorted, disjoint list (remove) from a sorted, disjoint
  // interval list (base).
  // The method uses two pointers. The cost is O(base + remove).
  // computePhaseOccurrences uses it to cut out sections from the "all members green" time.
  // In these sections, a signal group that is not in the phase is also green.
  // A phase counts as shown only if ONLY its members are green.
  // Without this rule, a phase whose member list is a subset of another phase is always "active"
  // during that other phase.
  function subtractIntervals(base, remove) {
    if (!remove.length) return base;
    const result = [];
    let ri = 0;
    for (const b of base) {
      let curStart = b.start;
      const curEnd = b.end;
      while (ri < remove.length && remove[ri].end <= curStart) ri++;
      let j = ri;
      while (curStart < curEnd && j < remove.length && remove[j].start < curEnd) {
        const r = remove[j];
        if (r.start > curStart) result.push({ start: curStart, end: Math.min(r.start, curEnd) });
        curStart = Math.max(curStart, r.end);
        j++;
      }
      if (curStart < curEnd) result.push({ start: curStart, end: curEnd });
    }
    return result;
  }

  function nextDefaultLabel(existingPhases) {
    const n = existingPhases.length + 1;
    return { name: `Phase ${n}`, kuerzel: `Ph${n}` };
  }

  let phaseIdSeq = 1;
  function createPhase(existingPhases) {
    const { name, kuerzel } = nextDefaultLabel(existingPhases);
    return { id: 'ph' + (phaseIdSeq++), name, kuerzel, members: new Set() };
  }

  // Like createPhase(), but with a given short name, name and members.
  // The values come from a loaded configuration file (see loadConfigFile() in stammdatenLsa.js).
  // createPhase() uses default values that it assigns automatically.
  // This function uses the same phaseIdSeq counter.
  // So the new IDs can never collide with phases that already exist in this session.
  function createPhaseFromConfig(kuerzel, name, members) {
    return { id: 'ph' + (phaseIdSeq++), name, kuerzel, members: members instanceof Set ? members : new Set(members) };
  }

  // Time ranges in which a phase was fully shown.
  // All members are green at the same time AND NO signal group that is not in the phase is green at
  // the same time.
  // The second condition is necessary.
  // Without it, a phase whose member list is a subset of another phase is automatically "active"
  // during that other phase.
  // An example: phase A = {K1,K2,K3,F1,F2} and phase B = {K1,K3,F1,F2}.
  // The condition of B is always true when the condition of A is true.
  // B cannot tell the two cases apart, because B does not look at K2.
  // Then both phases overlap in the combined phase track.
  // By definition, phases are never active at the same time (see the header comment of this file).
  function computePhaseOccurrences(phase, allStats) {
    const memberGreens = [], nonMemberGreens = [];
    allStats.forEach(entry => {
      (phase.members.has(entry.col.index) ? memberGreens : nonMemberGreens).push(entry.stats.greens);
    });
    const allMembersGreen = phase.members.size ? intersectIntervals(memberGreens) : [];
    const intervals = allMembersGreen.length ? subtractIntervals(allMembersGreen, unionIntervals(nonMemberGreens)) : [];
    return { phase, intervals };
  }

  // Discards abnormally SHORT occurrences of each phase.
  // An occurrence is abnormal if it is a statistical outlier on the low side.
  // The reference is the OTHER occurrences of THE SAME phase in the recording.
  // The method is based on the median absolute deviation (see GZ.stats.detectAnomalies).
  // It is the same method as for the green time anomalies in the green time analysis.
  // A controller can "start" a phase and, for a short time, meet its strict condition (all members
  // green, all non-members red).
  // Then the controller immediately starts ANOTHER transition and never lets the phase run.
  // At the end of a transition, the controller can also start the next transition and not the phase
  // itself.
  // Such an occurrence does NOT count as a real phase.
  // It stays part of the surrounding intergreen time.
  // The returned intervals do not include it.
  // buildCombinedSegments() below fills the gap automatically as 'NONE' (transition).
  // Only SHORT outliers are discarded. The code checks the direction and not only the size.
  // An unusually LONG occurrence is not an aborted phase.
  // It is a real, extended release (for example because of demand).
  // If there are fewer than 4 occurrences (the lower limit of detectAnomalies), no statistical
  // statement is possible.
  // Then all occurrences stay unchanged.
  function filterAbortedOccurrences(intervals) {
    if (intervals.length < 4) return intervals;
    const durations = intervals.map(iv => iv.end - iv.start);
    const flagged = GZ.stats.detectAnomalies(durations);
    const med = GZ.stats.median(durations);
    return intervals.filter((iv, i) => !(flagged[i] && durations[i] < med));
  }

  // Builds ONE common, gapless segment series from several phase occurrence lists.
  // The combined timeline uses it (one track for all phases).
  // By definition, phases are never active at the same time.
  // So it is enough to merge and sort the lists.
  // The function fills gaps with the separate category 'NONE'.
  // A gap is a time with no phase occurrence.
  // Examples are intergreen times, states that no phase covers, and discarded aborted occurrences
  // (see filterAbortedOccurrences above).
  // cat holds the phase ID (or 'NONE').
  // A change from one phase DIRECTLY to ANOTHER phase with no time gap is impossible by definition.
  // In real data, the intergreen time and the clearance and activation delays are always greater
  // than 0.
  // If such a change still occurs, the function does NOT pass it on silently as a seamless
  // phase-to-phase transition.
  // (The PÜ tool would not show such a transition at all.)
  // The function registers it as a transition with zero duration.
  // An example of the cause: the rounded raw data of two signal groups fall on exactly the same
  // time.
  // Two occurrences of THE SAME phase that touch are not changed. They need no transition.
  function buildCombinedSegments(occurrenceEntries, tMin, tMax) {
    const all = [];
    occurrenceEntries.forEach(({ phase, intervals }) => {
      filterAbortedOccurrences(intervals).forEach(iv => all.push({ cat: phase.id, start: iv.start, end: iv.end }));
    });
    all.sort((a, b) => a.start - b.start);
    const segs = [];
    let cursor = tMin;
    let lastCat = null;
    all.forEach(seg => {
      if (seg.start > cursor) {
        segs.push({ cat: 'NONE', start: cursor, end: seg.start });
      } else if (lastCat != null && seg.cat !== lastCat) {
        segs.push({ cat: 'NONE', start: cursor, end: cursor });
      }
      segs.push(seg);
      if (seg.end > cursor) cursor = seg.end;
      lastCat = seg.cat;
    });
    if (cursor < tMax) segs.push({ cat: 'NONE', start: cursor, end: tMax });
    return segs;
  }

  /* ---------------- Phasenübergänge (PÜ) ----------------
     This section belongs to two views.
     One is the phase track in Umlaufprüfung (display).
     The other is the PÜ tool in Stammdaten LSA (editing).
     For this reason, it is a common basis that does not depend on a view.
     It is not part of only one of the two views.
     This is pure evaluation and data logic.
     It always gets GZ.state.data.pueOverrides (if it needs them) as an explicit parameter.
     It does not read the global state itself. */

  // Name for an inferred phase transition gap.
  // The name comes from the short names of the two adjacent phases.
  // If both short names end with a number (the standard short name "PhN"), the name is
  // "PÜ<n1>.<n2>" (for example "PÜ1.2").
  // Otherwise the name is "PÜ k1→k2".
  // This avoids a meaningless text when the user gives free names to the short names.
  function pueLabelFor(k1, k2) {
    const m1 = /(\d+)\s*$/.exec(k1), m2 = /(\d+)\s*$/.exec(k2);
    return (m1 && m2) ? `PÜ${m1[1]}.${m2[1]}` : `PÜ ${k1}→${k2}`;
  }

  // Like buildCombinedSegments().
  // But the function also annotates the gaps (cat 'NONE') with the two directly adjacent REAL
  // phases.
  // The fields are seg.pueLabel, seg.pueFromPhaseId and seg.pueToPhaseId.
  // The gaps do not stay anonymous.
  // This is the basis of the phase track (bar and click to expand) in Umlaufprüfung.
  // If a gap has no neighbor on one side, all three fields are null.
  // This happens at the edge of the recording or when the code never detected a phase.
  function buildAnnotatedSegments(occurrenceEntries, tMin, tMax) {
    const phaseById = new Map(occurrenceEntries.map(e => [e.phase.id, e.phase]));
    const segs = buildCombinedSegments(occurrenceEntries, tMin, tMax);
    segs.forEach((seg, i) => {
      if (seg.cat !== 'NONE') return;
      const prevPhase = i > 0 ? phaseById.get(segs[i - 1].cat) : null;
      const nextPhase = i < segs.length - 1 ? phaseById.get(segs[i + 1].cat) : null;
      seg.pueLabel = (prevPhase && nextPhase) ? pueLabelFor(prevPhase.kuerzel, nextPhase.kuerzel) : null;
      seg.pueFromPhaseId = prevPhase ? prevPhase.id : null;
      seg.pueToPhaseId = nextPhase ? nextPhase.id : null;
    });
    return segs;
  }

  // All transition types that really occur in the recording.
  // Each pair of phase IDs gives exactly one entry.
  // This is the basis of the list in the PÜ tool (Stammdaten LSA).
  // The tool offers only transitions that exist in the raw data.
  // It does not offer each possible combination from the phase list.
  // For each transition type, the function keeps on purpose the occurrence NEAR THE MIDDLE of the
  // recording.
  // It uses the smallest distance to (tMin+tMax)/2.
  // It does NOT keep the literal first occurrence.
  // In practice, a recording often starts during a start-up or dark phase.
  // In this state, the signal heads are off and the controller is not yet in normal operation.
  // The very first occurrence of each transition type is in this state.
  // It has unusual or unusable On/Off values in the PÜ tool.
  function listDistinctTransitions(occurrenceEntries, tMin, tMax) {
    const segs = buildAnnotatedSegments(occurrenceEntries, tMin, tMax);
    const mid = (tMin + tMax) / 2;
    const seen = new Map();
    segs.forEach(seg => {
      if (seg.cat !== 'NONE' || !seg.pueFromPhaseId || !seg.pueToPhaseId) return;
      // A "transition" from a phase into itself is not a real phase transition.
      // An example is a short interruption or flicker of a member.
      // It cuts the phase occurrence intervals artificially into two parts (see
      // computePhaseOccurrences).
      // Such a transition would only give rows in the PÜ tool that look impossible (for example
      // "PÜ1.1").
      if (seg.pueFromPhaseId === seg.pueToPhaseId) return;
      const key = seg.pueFromPhaseId + '→' + seg.pueToPhaseId;
      const dist = Math.abs(seg.start - mid);
      const cur = seen.get(key);
      if (!cur || dist < cur.dist) {
        seen.set(key, { fromPhaseId: seg.pueFromPhaseId, toPhaseId: seg.pueToPhaseId, label: seg.pueLabel, sampleOccurrence: { start: seg.start, end: seg.end }, dist });
      }
    });
    return [...seen.values()].map(({ dist, ...rest }) => rest);
  }

  // Cycle index that contains the time t (the last cycleStarts entry <= t).
  // It converts an absolute time to the cycleIdx.
  // An example of an absolute time is sampleOccurrence.start from listDistinctTransitions().
  // autoDetectPueRows() and realCycleMetricsForSg() expect this cycleIdx.
  // The result is -1 if t is before the first cycle.
  function cycleIdxAtTime(t, cycleStarts) {
    if (!cycleStarts || !cycleStarts.length) return -1;
    let idx = -1;
    for (let i = 0; i < cycleStarts.length; i++) {
      if (cycleStarts[i] <= t) idx = i; else break;
    }
    return idx;
  }

  // Here sgIndex is ALWAYS the raw CSV column index (col.index, as in phase.members).
  // See data-member="${col.index}" in stammdatenLsa.js.
  // It is NOT the position in allStats.
  // allStats counts the SG columns separately.
  // This is the same distinction as in computePhaseOccurrences() above.
  function findSgEntryByColIndex(sgIndex, a) { return a.allStats.find(s => s.col.index === sgIndex); }

  // Real On/Off/TF/red-amber/amber values of ONE signal group for ONE cycle.
  // The basis is the same as for the per-cycle exprEngine primitives and key figures
  // (GZ.segments.computeCycleSgMetrics).
  // Here the function calculates them on demand for any signal group.
  // The signal group can be one that the user did not select at this time.
  // The phase members do not depend on the object selection in a view.
  function realCycleMetricsForSg(sgIndex, cycleIdx, a, TU_MED) {
    const entry = findSgEntryByColIndex(sgIndex, a);
    if (!entry) return null;
    const metrics = GZ.segments.computeCycleSgMetrics(entry.segs, entry.stats.greens, a.cycleStarts, a.tMax, TU_MED);
    // computeCycleSgMetrics now returns an ARRAY of occurrences for each cycle.
    // This is a result of the multiple-occurrence detection (see the header comment there).
    // The PÜ tool knows only ONE occurrence for each cycle, as before.
    // It uses the chronologically first occurrence on purpose.
    const occs = metrics[cycleIdx];
    return (occs && occs[0]) || null;
  }

  // Latest interval end of a phase (computePhaseOccurrences) that is still in [cycleStart,
  // cycleEnd].
  // This is the real limit, as the phase definition itself determines it.
  // At this limit, a phase occurrence ends (see the header comment there: all members green AND all
  // non-members red).
  // It is the basis of the PÜ reference below.
  // The code does NOT derive it again from the Off values of single signal groups (see there).
  // An occurrence can end because a starting signal group is no longer red (red-amber) too early.
  // It does not end only because a stopping signal group leaves green.
  function phaseOccurrenceEndInCycle(phase, allStats, cycleStart, cycleEnd) {
    const { intervals } = computePhaseOccurrences(phase, allStats);
    let best = null;
    intervals.forEach(iv => { if (iv.end > cycleStart && iv.end <= cycleEnd && (best == null || iv.end > best)) best = iv.end; });
    return best;
  }

  // In the PÜ tool, "An" (On) is NOT the start of the real green (cm.an).
  // At that time, the first visible signal is already past.
  // "An" is the red-to-amber change (start of red-amber) before the green.
  // At this moment, something changes for the starting signal group.
  // If the code detects no red-amber (cm.rotgelb=0, for example because of a data gap), "An" is the
  // same as cm.an.
  function rotgelbStartSec(cm) { return cm.an - (cm.rotgelb || 0); }

  // Searches the RAW segments of ONE signal group.
  // It finds the GREEN segment that is relevant for a given transition anchor.
  // The anchor (referenceAbsMs) is the TX=0 reference OF THIS transition.
  // The function does NOT use a cycle window (cycleIdx, as GZ.segments.computeCycleSgMetrics does).
  // It uses the anchor itself.
  // A signal group can be green more than once in ONE cycle.
  // Examples are traffic-actuated or multi-stage releases.
  // A cycle window then easily finds the WRONG occurrence.
  // This gives meaningless negative On/Off values and wrong neighbor segments in the bar.
  // role='outgoing': the segment that contains the anchor.
  // By the phase definition, this signal group MUST be green at this time (see
  // computePhaseOccurrences).
  // If there is no match, the function uses the last segment that ends BEFORE the anchor.
  // role='incoming': the segment with the earliest start AT or AFTER the anchor.
  // By the phase definition, this signal group MUST be red until then (see there "all non-members
  // red").
  // The result is null if no matching signal group or segment exists.
  function findAnchoredGreenSegIdx(entry, anchorAbsMs, role) {
    const segs = entry.segs;
    if (role === 'outgoing') {
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (s.cat === 'GRUEN' && s.start <= anchorAbsMs && s.end >= anchorAbsMs) return i;
      }
      let bestIdx = null, bestEnd = -Infinity;
      segs.forEach((s, i) => { if (s.cat === 'GRUEN' && s.end <= anchorAbsMs && s.end > bestEnd) { bestEnd = s.end; bestIdx = i; } });
      return bestIdx;
    }
    let bestIdx = null, bestStart = Infinity;
    segs.forEach((s, i) => { if (s.cat === 'GRUEN' && s.start >= anchorAbsMs && s.start < bestStart) { bestStart = s.start; bestIdx = i; } });
    return bestIdx;
  }

  // Key figures for ONE GREEN segment that findAnchoredGreenSegIdx() found.
  // The fields are an/ab (in real seconds relative to referenceAbsMs and not to the cycle start),
  // tf, rotgelb, gelb, segIdx, segStart and segEnd.
  // They are the same fields as GZ.segments.computeCycleSgMetrics gives.
  // But there is no cycle window binding.
  // There is also no TU modulo rounding.
  // The rounding is not necessary here, because the calculation uses absolute raw times directly.
  function metricsForAnchoredSeg(entry, role, anchorAbsMs, referenceAbsMs) {
    const segIdx = findAnchoredGreenSegIdx(entry, anchorAbsMs, role);
    if (segIdx == null) return null;
    const seg = entry.segs[segIdx];
    const extra = GZ.segments.adjacentTransitionDurations(entry.segs, segIdx);
    return {
      an: (seg.start - referenceAbsMs) / 1000, ab: (seg.end - referenceAbsMs) / 1000,
      tf: (seg.end - seg.start) / 1000, rotgelb: extra.rotgelb, gelb: extra.gelb,
      segIdx, segStart: seg.start, segEnd: seg.end
    };
  }

  // Like metricsForAnchoredSeg().
  // But the function derives the role (outgoing or incoming) from the row itself.
  // If ab is set, the role is outgoing. If an is set, the role is incoming.
  // The caller does not need to pass the role separately.
  // It is for the bar display in Stammdaten LSA and Umlaufprüfung (see buildLocalRowSegs and
  // applyRowOverrideToLocalSegs there).
  // In these places, only the row is known.
  // anchorAbsMs is ALWAYS referenceAbsMs on purpose.
  // This is the fixed TX=0 reference of THIS transition.
  // It does not depend on a manual correction of the row values.
  // So the real segment stays tied to the real transition, also if the user overwrote the displayed
  // number.
  // The result is null if there is no clear role.
  // Examples are a freely added row with no value and an "always on" row.
  function cmForRow(row, referenceAbsMs, a) {
    const entry = findSgEntryByColIndex(row.sgIndex, a);
    if (!entry) return null;
    const role = row.ab != null ? 'outgoing' : (row.an != null ? 'incoming' : null);
    if (!role) return null;
    return metricsForAnchoredSeg(entry, role, referenceAbsMs, referenceAbsMs);
  }

  // TF (release time) RELATIVE TO THE TRANSITION itself.
  // It is the amount of real green time of this row inside the defined transition window [startSec,
  // endSec].
  // It is NOT the full real duration of the underlying release.
  // For a stopping or starting row, the release is typically long.
  // It extends far BEFORE or AFTER this transition and does not belong to it.
  // An example is the whole green time of the previous or next phase.
  // A stopping row (only Ab set) "starts" its green an unknown time before the window.
  // The code clamps this start to startSec.
  // A starting row (only An set) "ends" its green an unknown time after the window.
  // The code clamps this end to endSec.
  // The real start of the green of the starting row is An + red-amber duration (cm.rotgelb).
  // It is not An itself (see rotgelbStartSec).
  // Example: An=5, red-amber=1 s, end=8 -> green start=6, TF=8-6=2.
  // If there is no value at all (neither An nor Ab, for example a new empty row), TF is not defined
  // (null).
  // If BOTH are set, there are two possible cases.
  // buildRowDisplaySegs() has the same case distinction for the bar segments.
  // An < Ab describes ONE continuous green window that is fully inside the transition (TF = its
  // duration).
  // Ab <= An describes a signal group that was green BEFORE the transition (until Ab).
  // Then it is really not green.
  // AFTER the transition, it becomes green again (from An).
  // An example is a member of both phases that does NOT stay green without a break, against the
  // usual assumption.
  // It really stops for some time (TF = sum of the two separate green parts).
  function computeRowTf(row, cm, startSec, endSec) {
    const hasAn = row.an != null, hasAb = row.ab != null;
    if (!hasAn && !hasAb) return null;
    const endAnchor = endSec != null ? endSec : startSec;
    const rotgelb = cm && Number.isFinite(cm.rotgelb) ? cm.rotgelb : 0;
    if (hasAn && hasAb && row.an < row.ab) {
      const greenStart = Math.max(row.an + rotgelb, startSec);
      const greenEnd = Math.min(row.ab, endAnchor);
      return Math.round(Math.max(0, greenEnd - greenStart));
    }
    let tf = 0;
    if (hasAb) tf += Math.max(0, Math.min(row.ab, endAnchor) - startSec);
    if (hasAn) tf += Math.max(0, endAnchor - Math.max(row.an + rotgelb, startSec));
    return Math.round(tf);
  }

  // Standard sort order for signal group names.
  // The order is K, then R, then F, then S.
  // Inside a group, the order is numerically ascending (K1, K2, ..., Kn).
  // It is for the PÜ row order (see autoDetectPueRows below) and for the SG selection lists in
  // Stammdaten LSA.
  // Other or unknown prefixes (for example special names such as "DF1") go to the end in
  // alphabetical order.
  // The code does not guess the sort order for them.
  const SG_PREFIX_ORDER = { K: 0, R: 1, F: 2, S: 3 };
  function compareSgNames(nameA, nameB) {
    const parse = n => { const m = /^([A-Za-z]+)(\d+)$/.exec(n || ''); return m ? [m[1].toUpperCase(), Number(m[2])] : null; };
    const pa = parse(nameA), pb = parse(nameB);
    const rankA = pa && SG_PREFIX_ORDER[pa[0]] != null ? SG_PREFIX_ORDER[pa[0]] : 99;
    const rankB = pb && SG_PREFIX_ORDER[pb[0]] != null ? SG_PREFIX_ORDER[pb[0]] : 99;
    if (rankA !== rankB) return rankA - rankB;
    if (rankA !== 99) return pa[1] - pb[1];
    return (nameA || '').localeCompare(nameB || '');
  }

  // Automatically detected PÜ rows for ONE occurrence (fromPhase/toPhase in EXACTLY this cycle).
  // There is ONE ROW FOR EACH SIGNAL GROUP OF THE WHOLE RECORDING.
  // It is not only for the members of the two phases.
  // The user must see the full list.
  // If necessary, the user can make it shorter (Remove button).
  // The user does not need to guess which signal group is missing.
  // For each signal group:
  //  - Member of ONLY the stopping phase -> stopping row (only Ab set).
  //    It is relative to the time at which the occurrence of the stopping phase itself ends.
  //    That time is the "TX=0" reference of this transition (see phaseOccurrenceEndInCycle above).
  //    By definition, this is "the signal group that ends first (inside the stopping phase)".
  //    This is what makes the occurrence end.
  //  - Member of ONLY the starting phase -> starting row (only An set, see rotgelbStartSec above).
  //  - Member of BOTH phases (it stays green without a break over the transition) -> "always on"
  //    row (neither An nor Ab, see setPueOverrideRowAlways).
  //    The row does not disappear.
  //  - Member of NEITHER phase -> empty row (neither An nor Ab) as a placeholder only.
  //    The user decides if and what applies to it.
  // If a stopping or starting signal group has no real segment at the anchor (for example a data
  // gap), its row also stays empty.
  // The row does not disappear.
  // The result is null (no rows at all) if no occurrence of the stopping phase ends in this cycle.
  // Then there is no reference to which a row can refer.
  function autoDetectPueRows(fromPhase, toPhase, cycleIdx, a, TU_MED) {
    const cycleStart = a.cycleStarts[cycleIdx];
    const cycleEnd = cycleIdx + 1 < a.cycleStarts.length ? a.cycleStarts[cycleIdx + 1] : a.tMax;
    const gapStartAbsMs = phaseOccurrenceEndInCycle(fromPhase, a.allStats, cycleStart, cycleEnd);
    if (gapStartAbsMs == null) return null;
    const referenceSec = (gapStartAbsMs - cycleStart) / 1000;
    // The order is K, R, F, S, and numerically ascending in each group (see compareSgNames above).
    // The code always creates the rows in this order.
    // The CSV column order does not change it.
    const sortedEntries = [...a.allStats].sort((x, y) => compareSgNames(x.col.name, y.col.name));
    const rows = [];
    const greenArrivalSecs = [];
    sortedEntries.forEach(entry => {
      const idx = entry.col.index;
      const inFrom = fromPhase.members.has(idx), inTo = toPhase.members.has(idx);
      if (inFrom && !inTo) {
        const cm = metricsForAnchoredSeg(entry, 'outgoing', gapStartAbsMs, gapStartAbsMs);
        rows.push({ sgIndex: idx, an: null, ab: cm && Number.isFinite(cm.ab) ? Math.round(cm.ab) : null, always: false });
      } else if (inTo && !inFrom) {
        const cm = metricsForAnchoredSeg(entry, 'incoming', gapStartAbsMs, gapStartAbsMs);
        if (cm && Number.isFinite(cm.an)) {
          rows.push({ sgIndex: idx, an: Math.round(rotgelbStartSec(cm)), ab: null, always: false });
          greenArrivalSecs.push(cm.an);
        } else {
          rows.push({ sgIndex: idx, an: null, ab: null, always: false });
        }
      } else if (inFrom && inTo) {
        rows.push({ sgIndex: idx, an: null, ab: null, always: true });
      } else {
        rows.push({ sgIndex: idx, an: null, ab: null, always: false });
      }
    });
    // End of the transition = the signal group of the starting phase that is the last (latest) to
    // come into REAL GREEN.
    // The value is cm.an.
    // It is NOT the earlier red-amber start (see rotgelbStartSec and "An" above).
    // By definition, it is the counterpart of the start (earliest end of the stopping phase).
    // The code keeps it independent of the row values on purpose.
    // It does not derive it from rows[].an, because "An" now shows the earlier red-amber start.
    const endSec = greenArrivalSecs.length ? Math.round(Math.max(...greenArrivalSecs)) : null;
    return { referenceSec, rows, endSec };
  }

  function pueOverrideKey(fromPhaseId, toPhaseId) { return fromPhaseId + '→' + toPhaseId; }

  // Resolved row list for the PÜ tool.
  // A manual correction has priority over the automatic detection.
  // (See pueOverrides, one for each PHASE TRANSITION TYPE. The user edits it in Stammdaten LSA.)
  // Such a correction applies to EACH occurrence of this transition in the same way.
  // It gives the same numbers for each cycle.
  // The reference time for a bar display is still calculated live for each cycle (see the caller).
  // So a bar always uses the REAL raw data of the cycle that it shows.
  // This is also true if the user overwrote the table values manually.
  // In this way, the user can check a correction visually against the real data.
  // The user does not need to trust it blindly.
  // startSec and endSec limit the transition itself (see the header comment of autoDetectPueRows).
  // startSec is FIXED at 0 (== referenceSec, the earliest Ab change to amber of the stopping
  // phase).
  // By definition, the user can never overwrite it.
  // endSec is the latest REAL green of the starting phase (auto.endSec, see there).
  // The code does NOT derive it from rows[].an.
  // Since the red-amber change, rows[].an shows an EARLIER time (see rotgelbStartSec).
  // The code always calculates endSec again from the real raw data of this cycle.
  // The exception is when pueOverrides.endSec sets it explicitly (see setPueOverrideEndSec below).
  // An example is when the user makes the transition wider on purpose than the raw data show.
  function resolvePueRows(fromPhase, toPhase, cycleIdx, a, TU_MED, pueOverrides) {
    const auto = autoDetectPueRows(fromPhase, toPhase, cycleIdx, a, TU_MED);
    const override = pueOverrides ? pueOverrides[pueOverrideKey(fromPhase.id, toPhase.id)] : null;
    const rows = override ? override.rows : (auto ? auto.rows : []);
    return {
      referenceSec: auto ? auto.referenceSec : null,
      rows,
      startSec: 0,
      endSec: (override && override.endSec != null) ? override.endSec : (auto ? auto.endSec : null),
      overridden: !!override
    };
  }

  // Mutation helpers for pueOverrides.
  // They always take the object (GZ.state.data.pueOverrides) as an explicit parameter.
  // They change it in place.
  // They do not read GZ.state themselves (see the section header comment).
  // The caller (Stammdaten LSA) must render again after the mutation.
  // ensurePueOverride() creates a correction if necessary.
  // It uses the currently DISPLAYED rows (seedRows) as the start point.
  // So a single field edit does not lose the other rows that the code only detected automatically.
  // The function is idempotent.
  // It does not change an existing correction again.
  function ensurePueOverride(pueOverrides, fromPhaseId, toPhaseId, seedRows) {
    const key = pueOverrideKey(fromPhaseId, toPhaseId);
    if (!pueOverrides[key]) pueOverrides[key] = { rows: seedRows.map(r => ({ ...r })) };
    return pueOverrides[key];
  }
  function setPueOverrideRowField(pueOverrides, fromPhaseId, toPhaseId, rowIdx, field, value, seedRows) {
    const ov = ensurePueOverride(pueOverrides, fromPhaseId, toPhaseId, seedRows);
    const row = ov.rows[rowIdx];
    if (!row) return;
    row[field] = value;
    // A real An or Ab value contradicts "always on" (see setPueOverrideRowAlways).
    // A field edit removes the mark.
    if ((field === 'an' || field === 'ab') && value != null) row.always = false;
  }
  function addPueOverrideRow(pueOverrides, fromPhaseId, toPhaseId, seedRows, sgIndex) {
    ensurePueOverride(pueOverrides, fromPhaseId, toPhaseId, seedRows).rows.push({ sgIndex, an: null, ab: null, always: false });
  }
  // Sets or clears the "always on" mark of a row.
  // "Always on" means that there is neither an An event nor an Ab event.
  // An example is a signal group that, by the design of the signal system, must stay green over
  // this transition.
  // But the tool lists it explicitly for documentation.
  // (An automatically detected common member, see autoDetectPueRows, does not need this.)
  // The function sets an/ab to null.
  // This row does not show a real change.
  function setPueOverrideRowAlways(pueOverrides, fromPhaseId, toPhaseId, rowIdx, always, seedRows) {
    const ov = ensurePueOverride(pueOverrides, fromPhaseId, toPhaseId, seedRows);
    if (ov.rows[rowIdx]) { ov.rows[rowIdx].always = always; ov.rows[rowIdx].an = null; ov.rows[rowIdx].ab = null; }
  }
  function removePueOverrideRow(pueOverrides, fromPhaseId, toPhaseId, seedRows, rowIdx) {
    ensurePueOverride(pueOverrides, fromPhaseId, toPhaseId, seedRows).rows.splice(rowIdx, 1);
  }
  // Sorts the rows of a correction PERMANENTLY in the standard order (compareSgNames).
  // The caller starts it explicitly.
  // It runs directly after each change that can affect the row order.
  // Examples are a new row, a changed signal group of a row, and a configuration that the code
  // loaded from a JSON file.
  // The saved order of a loaded configuration can be random.
  // So rowIdx (the index in ov.rows that the other mutation helpers expect) always matches the
  // displayed order.
  function sortPueOverrideRows(pueOverrides, fromPhaseId, toPhaseId, a) {
    const ov = pueOverrides[pueOverrideKey(fromPhaseId, toPhaseId)];
    if (!ov) return;
    const nameOfSg = idx => { const e = findSgEntryByColIndex(idx, a); return e ? e.col.name : ''; };
    ov.rows.sort((x, y) => compareSgNames(nameOfSg(x.sgIndex), nameOfSg(y.sgIndex)));
  }
  // value === null resets the value to "automatic" (see resolvePueRows).
  // If necessary, the function still creates a correction.
  // Also a pure end override with no row change counts as "adjusted manually".
  // The start can NOT be overwritten on purpose (see resolvePueRows).
  // By definition, it is always 0.
  function setPueOverrideEndSec(pueOverrides, fromPhaseId, toPhaseId, seedRows, value) {
    ensurePueOverride(pueOverrides, fromPhaseId, toPhaseId, seedRows).endSec = value;
  }
  function resetPueOverride(pueOverrides, fromPhaseId, toPhaseId) {
    delete pueOverrides[pueOverrideKey(fromPhaseId, toPhaseId)];
  }

  // Bar segments of ONE PÜ row.
  // The code SYNTHESIZES them DIRECTLY from the logical values of the row.
  // The values are An/Ab, plus the real red-amber and amber duration from cm, if known.
  // The code does not search the raw data and then adapt the result.
  // This is the core of the phase definition (see computePhaseOccurrences).
  // A starting signal group is continuously green from its change to AT LEAST the end.
  // It is a member of the phase that is now active.
  // The whole occurrence of that phase reaches at least to the end.
  // A stopping signal group was already continuously green until its change.
  // It was a member of the phase that was active until then.
  // At these points, the bar must NEVER show a different state.
  // This is also true after a manual correction that differs from the real release that the code
  // found first.
  // It is also true if no matching real segment exists.
  // In this case, red-amber and amber are 0, but the green span is still correct.
  // wMinMs and wMaxMs (the visible time window, not only startSec and endSec) limit how far the
  // green area goes past the real change.
  // The green area goes into the -3 s / +2 s margin.
  // All outside areas stay the implicit red baseline (baselineCat and baselineColor in renderLane).
  // If BOTH An and Ab are set, there are two different cases.
  // (See computeRowTf() for the same case distinction for the key figure.)
  // An < Ab is ONE continuous green window that is fully inside the transition.
  // An example is a freely added row that has no own relation to one of the two phase limits.
  // Ab <= An is a signal group that was green BEFORE the transition (until Ab).
  // AFTER the transition, it becomes green again (from An).
  // Between the two, there is a real gap that is not green (not only an assumed gap).
  // An example is a member of both phases that really stops.
  // The usual assumption for such a member is continuity ("always on").
  // The code then draws both sides INDEPENDENTLY of each other.
  // It does not draw one common window that wrongly runs backward.
  function buildRowDisplaySegs(row, cm, wMinMs, wMaxMs) {
    const rotgelb = cm && Number.isFinite(cm.rotgelb) ? cm.rotgelb : 0;
    const gelb = cm && Number.isFinite(cm.gelb) ? cm.gelb : 0;
    const hasAn = row.an != null, hasAb = row.ab != null;
    const segs = [];

    if (hasAn && hasAb && row.an < row.ab) {
      const greenStartMs = (row.an + rotgelb) * 1000;
      if (rotgelb > 0) segs.push({ cat: 'ROTGELB', start: row.an * 1000, end: greenStartMs });
      segs.push({ cat: 'GRUEN', start: greenStartMs, end: row.ab * 1000 });
      if (gelb > 0) segs.push({ cat: 'GELB', start: row.ab * 1000, end: (row.ab + gelb) * 1000 });
      return segs;
    }

    if (hasAb) {
      segs.push({ cat: 'GRUEN', start: Math.min(wMinMs, row.ab * 1000), end: row.ab * 1000 });
      if (gelb > 0) segs.push({ cat: 'GELB', start: row.ab * 1000, end: (row.ab + gelb) * 1000 });
    }
    if (hasAn) {
      const greenStartMs = (row.an + rotgelb) * 1000;
      if (rotgelb > 0) segs.push({ cat: 'ROTGELB', start: row.an * 1000, end: greenStartMs });
      segs.push({ cat: 'GRUEN', start: greenStartMs, end: Math.max(wMaxMs, greenStartMs) });
    }
    return segs;
  }

  // Sums the occurrence duration of a phase for each cycle (cycleStarts[i]..cycleStarts[i+1)).
  // The code uses an amortized sweep over the (sorted) occurrences.
  // It does not use a full scan for each cycle.
  // So the function stays fast also for "Alle anzeigen" with large recordings.
  function durationPerCycle(intervals, cycleStarts, tMax, fromIdx, toIdx) {
    const sweep = GZ.segments.makeIntervalSweep(intervals);
    const out = [];
    for (let i = fromIdx; i < toIdx; i++) {
      const start = cycleStarts[i];
      const end = i + 1 < cycleStarts.length ? cycleStarts[i + 1] : tMax;
      const hits = sweep(start, end);
      const sec = hits.reduce((sum, iv) => sum + (Math.min(iv.end, end) - Math.max(iv.start, start)) / 1000, 0);
      out.push(sec);
    }
    return out;
  }

  GZ.phases = {
    PHASE_COLORS, colorForIndex, intersectIntervals, unionIntervals, subtractIntervals, createPhase, createPhaseFromConfig,
    computePhaseOccurrences, filterAbortedOccurrences, buildCombinedSegments, durationPerCycle,
    pueLabelFor, buildAnnotatedSegments, listDistinctTransitions, cycleIdxAtTime,
    findSgEntryByColIndex, realCycleMetricsForSg, rotgelbStartSec, findAnchoredGreenSegIdx, metricsForAnchoredSeg, cmForRow,
    computeRowTf, compareSgNames, autoDetectPueRows, pueOverrideKey, resolvePueRows,
    ensurePueOverride, setPueOverrideRowField, setPueOverrideRowAlways, addPueOverrideRow, removePueOverrideRow, sortPueOverrideRows, resetPueOverride,
    setPueOverrideEndSec, buildRowDisplaySegs
  };
})(window.GZ = window.GZ || {});
