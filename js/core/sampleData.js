/* GZ.sampleData — synthetic OCIT export for the demo ("Beispieldaten laden").
   One node, 4 hours (06:00–10:00), cycle based:
   - SPL 12: traffic-actuated, free-running cycle time (Mo–Fr off-peak).
   - SPL 14 (07:15–09:15): fixed time, cycle time 90 s, with one single
     intervention (K1 and S1 shortened).
   Signal groups K1, K2 (vehicles), F1 (pedestrians, on demand in SPL 12),
   S1 (bus, on demand in SPL 12).
   Detectors (all OCIT type "single_loop"):
   - IS1_1, IS1_2: induction loops of K1; IS2: induction loop of K2.
   - RD2: radar, named like a K2 detector but it really measures K1 (naming trap
     for the data check).
   - FT1: pedestrian push button of F1 (pulse detector).
   - DF3: camera field of K2, no naming rule fits (indexed incrementally).
   - IS9: counting loop, belongs to no signal group.
   A matching synthetic log file ("Beispiel-Log") is generated as well.
   Nothing here is measured data. */
(function (GZ) {
  'use strict';
  const { fmtDate, fmtTimeOnly, pad } = GZ.format;

  const SEED = 231;
  const START = new Date(2026, 10, 3, 6, 0, 0);          // 03.11.2026 06:00:00
  const DURATION_S = 4 * 3600;
  const PLAN_CHANGE_1_S = 1 * 3600 + 15 * 60;            // 07:15
  const PLAN_CHANGE_2_S = 3 * 3600 + 15 * 60;            // 09:15

  // Signal state raw values (see GZ.parser.STATE_CAT)
  const RED = 3, RED_AMBER = 15, GREEN = 48, AMBER = 12;

  const SIGNAL_GROUPS = [
    { id: 'K1', type: 'veh',  desc: 'K1 Hauptrichtung Kfz',          redAmber: 2, amber: 3 },
    { id: 'K2', type: 'veh',  desc: 'K2 Nebenrichtung Kfz',          redAmber: 2, amber: 3 },
    { id: 'F1', type: 'ped',  desc: 'F1 Fußgänger quer Hauptstraße', redAmber: 0, amber: 0 },
    { id: 'S1', type: 'tram', desc: 'S1 Bus Hauptrichtung',          redAmber: 2, amber: 3 }
  ];
  // truth = signal groups the detector really measures. Only the simulation reads it.
  const DETECTORS = [
    { id: 'IS1_1', desc: 'Induktionsschleife K1, Fahrstreifen 1', truth: ['K1'], mean: 5,  dur: [6, 20] },
    { id: 'IS1_2', desc: 'Induktionsschleife K1, Fahrstreifen 2', truth: ['K1'], mean: 9,  dur: [3, 12] },
    { id: 'IS2',   desc: 'Induktionsschleife K2',                  truth: ['K2'], mean: 12, dur: [3, 10] },
    { id: 'RD2',   desc: 'Radar Zufahrt Nebenrichtung',            truth: ['K1'], mean: 7,  dur: [5, 15] },
    { id: 'FT1',   desc: 'Fußgängertaster Furt Hauptstraße',       truth: ['F1'], pulse: true },
    { id: 'DF3',   desc: 'Kamerafeld Haltlinie Nebenrichtung',     truth: ['K2'], mean: 10, dur: [3, 8] },
    { id: 'IS9',   desc: 'Zählschleife Zufahrt Süd',               truth: [] }
  ];

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // Builds the whole scenario once: cycles, signal states per second, detector states per second.
  let scenario = null;
  function buildScenario() {
    if (scenario) return scenario;
    const rand = mulberry32(SEED);
    const randn = () => { let u = 0; while (!u) u = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand()); };
    const expRand = mean => -mean * Math.log(1 - rand());
    const randInt = (a, b) => a + Math.floor(rand() * (b - a + 1));
    const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
    const planAt = t => (t >= PLAN_CHANGE_1_S && t < PLAN_CHANGE_2_S) ? '14' : '12';

    // Cycles. sg[id] = { on, off } in seconds after cycle start, or null.
    const cycles = [];
    let t = 0, fixedCount = 0;
    for (;;) {
      const plan = planAt(t);
      let cycle;
      if (plan === '12') {
        const g1 = clamp(Math.round(36 + 9 * randn()), 18, 52);
        const pedDemand = rand() < 0.55;
        let g2 = clamp(Math.round(17 + 6 * randn()), 10, 30);
        if (pedDemand) g2 = Math.max(g2, 16);
        const sg = { K1: { on: 0, off: g1 }, K2: { on: g1 + 5, off: g1 + 5 + g2 }, F1: null, S1: null };
        if (pedDemand) sg.F1 = { on: g1 + 6, off: g1 + 18 };
        if (rand() < 0.32) { const a = Math.floor(rand() * 6), b = Math.floor(rand() * 4); sg.S1 = { on: a, off: Math.max(a + 8, g1 - b) }; }
        cycle = { plan, tu: Math.max(50, g1 + g2 + 10), sg };
      } else {
        const intervention = (fixedCount === 37);
        cycle = { plan, tu: 90, intervention, sg: {
          K1: { on: 0, off: intervention ? 22 : 48 }, K2: { on: 53, off: 75 },
          F1: { on: 54, off: 66 }, S1: { on: 2, off: intervention ? 20 : 46 } } };
        fixedCount++;
      }
      if (t + cycle.tu > DURATION_S) break;
      cycle.t = t; cycles.push(cycle); t += cycle.tu;
    }
    const rows = t;                                       // whole cycles only

    // Signal states per second
    const sig = {};
    SIGNAL_GROUPS.forEach(s => {
      const a = new Uint8Array(rows).fill(RED);
      cycles.forEach(c => {
        const g = c.sg[s.id];
        if (!g) return;
        for (let k = c.t + g.on - s.redAmber; k < c.t + g.on; k++) if (k >= 0) a[k] = RED_AMBER;
        for (let k = c.t + g.on; k < c.t + g.off; k++) a[k] = GREEN;
        for (let k = c.t + g.off; k < c.t + g.off + s.amber && k < rows; k++) a[k] = AMBER;
      });
      sig[s.id] = a;
    });

    // Detector states per second
    const det = {};
    const greensOf = id => cycles.filter(c => c.sg[id]).map(c => ({ start: c.t + c.sg[id].on, end: c.t + c.sg[id].off, tu: c.tu }));
    DETECTORS.forEach(d => {
      const a = new Uint8Array(rows);
      const mark = (from, to) => { for (let k = Math.max(0, Math.round(from)); k <= Math.min(rows - 1, Math.round(to)); k++) a[k] = 1; };
      det[d.id] = a;
      if (d.id === 'IS9') { for (let k = 0; k < 90; k++) { const s = randInt(0, rows - 20); mark(s, s + randInt(3, 9)); } return; }
      d.truth.forEach(sgId => {
        const sgDef = SIGNAL_GROUPS.find(s => s.id === sgId), greens = greensOf(sgId);
        greens.forEach((g, k) => {
          if (d.pulse) {
            // One button press before each green. About 8 % of the presses just miss a green.
            const gapStart = k ? greens[k - 1].end + 1 : 0;
            const wait = rand() < 0.08 ? g.tu + rand() * g.tu : 3 + rand() * (g.tu - 8);
            const press = Math.max(gapStart, g.start - wait);
            mark(press, press + 2);
            if (rand() < 0.3) { const again = press + randInt(5, 15); if (again < g.start - 2) mark(again, again + 2); }
            return;
          }
          // Presence: a vehicle arrives during red and stays until shortly after the green start.
          if (!k) return;
          const arrival = greens[k - 1].end + sgDef.amber + 1 + Math.floor(expRand(d.mean));
          if (arrival >= g.start - 1) return;
          mark(arrival, g.start + randInt(d.dur[0], d.dur[1]));
        });
      });
    });

    scenario = { cycles, rows, sig, det };
    return scenario;
  }

  function stamp(secondsAfterStart) {
    const d = new Date(START.getTime() + secondsAfterStart * 1000);
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${fmtTimeOnly(d)}`;
  }

  function generateSampleText() {
    const sc = buildScenario();
    const cols = 5 + SIGNAL_GROUPS.length + DETECTORS.length;
    const empty = () => Array(cols).fill('');
    const typeRow = ['', '', '', '', ''].concat(SIGNAL_GROUPS.map(s => s.type), DETECTORS.map(() => 'single_loop'));
    const nameRow = ['', '', '', '', ''].concat(SIGNAL_GROUPS.map(s => s.id), DETECTORS.map(d => d.id));
    const descRow = ['Beschreibung', '', 'TX', 'TC', 'SP'].concat(SIGNAL_GROUPS.map(s => s.desc), DETECTORS.map(d => d.desc));
    const lines = [];
    const first = empty(); first[0] = 'Longname'; first[1] = 'KNOTEN 231 - Bahnhofstr./Ringstr.'; first[2] = 'No'; first[3] = '231';
    lines.push(first.join('\t'));
    lines.push(empty().join('\t'));
    lines.push(empty().join('\t'));
    lines.push(typeRow.join('\t'));
    lines.push(nameRow.join('\t'));
    lines.push(descRow.join('\t'));
    lines.push(empty().join('\t'));                       // header line 7 is empty in the raw CSV

    let cycleIndex = 0, lastPlan = '';
    for (let i = 0; i < sc.rows; i++) {
      while (cycleIndex + 1 < sc.cycles.length && i >= sc.cycles[cycleIndex + 1].t) cycleIndex++;
      const cycle = sc.cycles[cycleIndex];
      // TC and SP are logged only when they change (the parser forward-fills them).
      const tc = i === 0 ? '4' : '';
      const plan = cycle.plan, sp = plan !== lastPlan ? plan : '';
      lastPlan = plan;
      const ts = new Date(START.getTime() + i * 1000);
      lines.push([fmtDate(ts), fmtTimeOnly(ts), String(i - cycle.t), tc, sp]
        .concat(SIGNAL_GROUPS.map(s => sc.sig[s.id][i]), DETECTORS.map(d => sc.det[d.id][i])).join('\t'));
    }
    return lines.join('\n');
  }

  // Synthetic log lines for the same period: level; timestamp; text; two extra columns.
  function generateSampleLog() {
    const sc = buildScenario();
    const intervention = sc.cycles.find(c => c.intervention);
    const rows = [
      [0, 'Info', 'Steuergerät gestartet'],
      [1, 'Info', 'Signalprogramm 12 aktiv (Tagesplan)'],
      [30 * 60, 'Info', 'Verbindung zur Zentrale geprüft'],
      [PLAN_CHANGE_1_S, 'Info', 'Signalprogrammwechsel 12 → 14 (Zeitplan)'],
      [PLAN_CHANGE_1_S + 311, 'Warnung', 'Detektor RD2: Belegungsdauer über 60 s'],
      [intervention ? intervention.t + 4 : 2 * 3600, 'Fehler', 'Eingriff: Freigabe K1 vorzeitig beendet'],
      [intervention ? intervention.t + 6 : 2 * 3600 + 1, 'Schwerer Fehler', 'Freigabezeit K1 unter Mindestgrün'],
      [2 * 3600 + 30 * 60, 'Info', 'Verbindung zur Zentrale geprüft'],
      [PLAN_CHANGE_2_S, 'Info', 'Signalprogrammwechsel 14 → 12 (Zeitplan)'],
      [PLAN_CHANGE_2_S + 1500, 'Warnung', 'Fußgängertaster FT1: Dauerbelegung'],
      [3 * 3600 + 45 * 60, 'Debug', 'Speicherstand geprüft']
    ];
    // Semicolon separated. The last two columns are extra columns, they are ignored on import.
    return ['Stufe;Zeit;Text;Quelle;Nr'].concat(rows.map((r, i) => `${r[1]};${stamp(r[0])};${r[2]};Steuergerät;${1000 + i}`)).join('\n');
  }

  GZ.sampleData = { generateSampleText, generateSampleLog };
})(window.GZ = window.GZ || {});
