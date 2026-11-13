/* GZT.fixtures has deterministic test recordings in the OCIT table layout.
   - synthetic() builds a wide recording (100 value columns) from a controller cycle model.
     The recording has a fixed-time plan first and then an actuated plan.
     The only source of random numbers is the seeded generator.
   - edgeCases() gives small hand-made texts for the odd cases of the parser.
   The code runs in Node (vm) and in the browser. It does not read files. */
(function (root) {
  'use strict';
  const pad2 = n => (n < 10 ? '0' : '') + n;

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // Returns the date and time i seconds after 06:00:00 on 03.11.26. This day has no clock change.
  function clock(i) {
    const s = 6 * 3600 + i;
    return ['03.11.26', pad2(Math.floor(s / 3600) % 24) + ':' + pad2(Math.floor(s / 60) % 60) + ':' + pad2(s % 60)];
  }

  // o: {longname, no, cols:[{type,name,desc}], rows:[[...fields]], delim, eol, quoteHeader,
  // noFinalEol}
  // Every row starts with date, time, TX, TC and SP. Then it has one field for each column.
  function build(o) {
    const cols = o.cols, N = cols.length, d = o.delim || '\t', eol = o.eol || '\n';
    const pad = n => new Array(Math.max(0, n)).fill('');
    const head = [
      ['Longname', o.longname || 'KNOTEN 1', 'No', o.no || '1'].concat(pad(N + 1)),
      pad(N + 5), pad(N + 5),
      pad(5).concat(cols.map(c => c.type)),
      pad(5).concat(cols.map(c => c.name)),
      ['Beschreibung', '', 'TX', 'TC', 'SP'].concat(cols.map(c => c.desc || c.name)),
      pad(N + 5)
    ];
    const q = s => (o.quoteHeader && s !== '' ? '"' + String(s).replace(/"/g, '""') + '"' : s);
    const lines = head.map(r => r.map(q).join(d)).concat(o.rows.map(r => r.join(d)));
    return lines.join(eol) + (o.noFinalEol ? '' : eol);
  }

  /* ---------- wide synthetic recording ---------- */
  function synthetic(opts) {
    opts = opts || {};
    const rows = opts.rows || 3600;
    const fixedUntil = opts.fixedUntil === undefined ? 1800 : opts.fixedUntil;
    const rand = mulberry32(opts.seed || 4242);
    const randInt = (a, b) => a + Math.floor(rand() * (b - a + 1));
    const S = { t: 0, tx: 0, L: 90, a: 35, b: 60, cyc: 0, fixed: true, planStart: 0, R: [], J: [] };

    function newCycle(t) {
      const fixed = t < fixedUntil;
      if (t === 0 || fixed !== S.fixed) { S.fixed = fixed; S.planStart = t; }
      S.cyc++;
      if (fixed) {
        S.L = 90; S.a = 35; S.b = 60; S.J = [2, 2, 2, 2, 2, 2, 2, 2]; S.R = [10, 20, 30, 40, 50, 25, 15, 35];
      } else {
        S.L = randInt(70, 110); S.a = randInt(20, 45); S.b = S.a + randInt(10, 30);
        if (S.b > S.L - 10) S.b = S.L - 10;
        S.J = Array.from({ length: 8 }, () => randInt(0, 5));
        S.R = Array.from({ length: 8 }, () => randInt(0, S.L - 1));
      }
    }
    const PS = () => [0, S.a, S.b];
    const PE = () => [S.a, S.b, S.L];
    const PH = () => (S.tx < S.a ? 0 : S.tx < S.b ? 1 : 2);

    const cols = [];
    const add = (type, name, desc, fn) => cols.push({ type, name, desc, fn });
    for (let i = 0; i < 15; i++) {
      const k = i % 3, off = i % 3;
      add(i % 5 === 4 ? 'ped' : 'veh', 'K' + (i + 1), 'Signalgruppe ' + (i + 1), () => {
        const gs = PS()[k] + 2 + off, ge = PE()[k], tx = S.tx;
        if (tx >= gs && tx < ge) return 48;
        if (tx >= ge && tx < ge + 3) return 12;
        if (tx >= gs - 2 && tx < gs) return 15;
        return 3;
      });
    }
    for (let j = 0; j < 20; j++) {
      const k = j % 3;
      if (j < 15) {
        add('single_loop', 'B' + (j + 1), 'Zustand ' + (j + 1), () => {
          const x = PS()[k] + S.J[j % 8], y = PE()[k] - S.J[(j + 3) % 8];
          return S.tx >= x && S.tx < y ? 1 : 0;
        });
      } else {
        add('single_loop', 'B' + (j + 1), 'Anforderung ' + (j + 1), () => {
          const gs = PS()[k] + 2, r = S.R[j % 8];
          return S.tx >= r && (r >= gs || S.tx < gs) ? 1 : 0;
        });
      }
    }
    for (let i = 0; i < 35; i++) {
      const k = i % 3, kind = i % 5;
      add('ta', 'TA' + (i + 1), 'Countdown ' + (i + 1), () => {
        const gs = PS()[k] + 2, ge = PE()[k], tx = S.tx, ph = PH();
        switch (kind) {
          case 0: return tx < gs ? gs - tx : (S.L - tx) + gs;
          case 1: return tx >= gs && tx < ge ? ge - tx : 0;
          case 2: return S.L - tx;
          case 3: return ph === k ? PE()[k] - tx : 65535;
          default: return PE()[ph] - tx;
        }
      });
    }
    for (let i = 0; i < 25; i++) {
      const kind = i % 5;
      add('firmware', 'ST' + (i + 1), 'Zustandsindex ' + (i + 1), () => {
        const ph = PH();
        switch (kind) {
          case 0: return 30 + ph;
          case 1: return S.fixed ? 30 : 31;
          case 2: return S.cyc;
          case 3: return 30 + ((ph + 1) % 3);
          default: return 30 + (S.cyc % 3);
        }
      });
    }
    for (let i = 0; i < 5; i++) {
      add('pt_dir', 'UP' + (i + 1), 'Zaehler ' + (i + 1), () => {
        const ph = PH();
        switch (i) {
          case 0: return S.tx - PS()[ph];
          case 1: return S.tx;
          case 2: return S.t - S.planStart;
          case 3: return S.tx - PS()[ph] + 100;
          default: return S.L;
        }
      });
    }

    newCycle(0);
    const out = [];
    for (let t = 0; t < rows; t++) {
      if (S.tx >= S.L) { S.tx = 0; newCycle(t); }
      S.t = t;
      const c = clock(t);
      const row = [c[0], c[1], S.tx, t === 0 ? '4' : '', t % 1800 === 0 ? ((t / 1800) % 2 === 0 ? '12' : '14') : ''];
      for (let k = 0; k < cols.length; k++) row.push(cols[k].fn());
      out.push(row);
      S.tx++;
    }
    return build({ longname: 'SYNTH 1', no: '1', cols, rows: out });
  }

  /* ---------- edge cases ---------- */
  const sgVal = i => (i % 20 < 8 ? 48 : i % 20 < 11 ? 12 : i % 20 < 18 ? 3 : 15);
  const detVal = i => (i % 7 < 2 ? 1 : 0);
  const SG_DET = [{ type: 'veh', name: 'K1' }, { type: 'single_loop', name: 'IS1' }];
  function simpleRows(n, tcsp) {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const c = clock(i), t = tcsp ? tcsp(i) : (i === 0 ? ['4', '12'] : ['', '']);
      rows.push([c[0], c[1], i % 20, t[0], t[1], sgVal(i), detVal(i)]);
    }
    return rows;
  }

  function edgeCases() {
    const cases = {};
    cases.crlf = build({ cols: SG_DET, rows: simpleRows(60), eol: '\r\n' });
    cases.noFinalEol = build({ cols: SG_DET, rows: simpleRows(30), noFinalEol: true });
    cases.quotedHeader = build({
      longname: 'Knoten Nord, West', no: '12', quoteHeader: true,
      cols: [{ type: 'veh', name: 'K1', desc: 'Kfz, Haupt' }, { type: 'single_loop', name: 'IS1', desc: 'Schleife "A"' }],
      rows: simpleRows(40)
    });
    cases.sparseTcSp = build({ cols: SG_DET, rows: simpleRows(90, i => (i === 0 ? ['4', '12'] : i === 45 ? ['5', '14'] : ['', ''])) });
    cases.comma = build({ cols: SG_DET, rows: simpleRows(40), delim: ',' });

    const ta = ['0', '65535', '65536', '70000', '007', '', '12', '-1', '1.5', '1e3', '0', '5'];
    const wide = ['0', '65534', '65535', '', 'INV', '12', '12', '12', '12', '12', '12', '12'];
    const tokRows = [];
    for (let i = 0; i < 12; i++) {
      const c = clock(i);
      tokRows.push([c[0], c[1], i, '', '', i >= 3 && i <= 5 ? 'INV' : i === 6 ? ' 3 ' : sgVal(i), i === 2 ? 'INV' : detVal(i), ta[i], 30 + i % 3, wide[i]]);
    }
    cases.tokens = build({
      cols: [{ type: 'veh', name: 'K1' }, { type: 'single_loop', name: 'IS1' }, { type: 'ta', name: 'TA1' }, { type: 'firmware', name: 'ST1' }, { type: 'pt_dir', name: 'W1' }],
      rows: tokRows
    });

    const bad = [];
    const good = i => { const c = clock(i); return [c[0], c[1], i, '', '', sgVal(i), detVal(i)]; };
    for (let i = 0; i < 5; i++) bad.push(good(i));
    bad.push(['', '06:00:05', 5, '', '', 48, 0]);               // Empty date.
    bad.push(['xx.yy.zz', '06:00:06', 6, '', '', 48, 0]);       // Unreadable date.
    bad.push(['   ', '06:00:07', 7, '', '', 48, 0]);            // Blank date.
    bad.push(['03.11.26', '06:00:08', '8']);                    // Short row.
    bad.push(['03.11.26', '06:00:04', 4, '', '', 48, 1]);       // Duplicate time.
    for (let i = 9; i < 13; i++) bad.push(good(i));
    cases.badRows = build({ cols: SG_DET, rows: bad });

    const tx = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 8, 9, 2, 3, 4, '', '', 5, 6, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
    cases.txWrap = build({
      cols: SG_DET,
      rows: tx.map((v, i) => { const c = clock(i); return [c[0], c[1], v, '', '', sgVal(i), detVal(i)]; })
    });

    cases.timestampInColumnA = build({
      cols: SG_DET,
      rows: simpleRows(30).map(r => [r[0] + ' ' + r[1], ''].concat(r.slice(2)))
    });

    cases.errTooShort = 'a\tb\n1\t2\n';
    cases.errNoSignalGroup = build({ cols: [{ type: 'none', name: 'X' }], rows: [['03.11.26', '06:00:00', 0, '', '', 1]] });
    cases.errNoTimestamp = build({ cols: SG_DET, rows: [['', '', 0, '', '', 1, 0], ['xx', 'yy', 1, '', '', 1, 0]] });
    return cases;
  }

  root.GZT = root.GZT || {};
  root.GZT.fixtures = Object.assign(root.GZT.fixtures || {}, { build, synthetic, edgeCases, clock });
})(window);
