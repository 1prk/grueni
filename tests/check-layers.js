/* Static check of the module layers.
     node tests/check-layers.js
   For each file in js/ (except js/vendor) it reads the GZ.define header and the code.
   It checks these rules:
   - every GZ.<module> that the code uses is in the deps list of the header (a comment or a text does not count),
   - every entry of the deps list is used,
   - the layer rules of GZ.define hold (a lower layer only, no view uses a view, no ui module uses the store, nothing uses the layer app),
   - the folder of the file matches its layer,
   - the scripts of index.html load a module only after its dependencies, and each file is in index.html (the list NOT_LOADED_YET has the exceptions).
   The script has no dependencies. It has its own small reader that removes comments and texts from the code. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RANK = { domain: 1, store: 2, io: 3, ui: 4, views: 5, app: 6 };
const FOLDER_LAYERS = { 'js/core': ['domain'], 'js/store': ['store'], 'js/io': ['io'], 'js/ui': ['ui'], 'js/charts': ['ui'], 'js/views': ['views'], 'js/app.js': ['app'] };

/* ---------- reader: returns the code without comments and without the content of texts ---------- */
// keep = true keeps the text of strings, templates and regular expressions. Only the comments go away.
function stripCode(src, keep) {
  let out = '';
  let i = 0;
  const n = src.length;
  // stack of template states: each entry is the brace depth where the ${ } part started
  const stack = [];
  let depth = 0;
  let lastSig = '';   // last significant character, to tell a regular expression from a division
  let lastWord = '';
  const regexAfterWord = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do']);
  function regexAllowed() {
    if (lastSig === '') return true;
    if (/[A-Za-z0-9_$]/.test(lastSig)) return regexAfterWord.has(lastWord);
    return !/[)\]}]/.test(lastSig) || false;
  }
  function readTemplate() {
    // i is after the opening backtick or after the closing brace of a ${ }
    while (i < n) {
      const c = src[i];
      if (c === '\\') { if (keep) out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { i++; if (keep) out += '`'; lastSig = '`'; return; }
      if (c === '$' && src[i + 1] === '{') { i += 2; stack.push(depth); depth++; out += '${'; lastSig = '{'; return; }
      if (keep) out += c;
      i++;
    }
  }
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
    if (c === '"' || c === "'") {
      const from = i;
      i++;
      while (i < n && src[i] !== c) { if (src[i] === '\\') i++; i++; }
      i++; out += keep ? src.slice(from, i) : c + c; lastSig = c; continue;
    }
    if (c === '`') { i++; out += keep ? '`' : '``'; readTemplate(); continue; }
    if (c === '/' && regexAllowed()) {
      const from = i;
      i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true; else if (src[i] === ']') inClass = false; else if (src[i] === '/' && !inClass) break;
        i++;
      }
      i++;
      while (i < n && /[a-z]/.test(src[i])) i++;
      out += keep ? src.slice(from, i) : '/r/'; lastSig = '/'; continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (stack.length && stack[stack.length - 1] === depth) { stack.pop(); i++; out += '}'; readTemplate(); continue; }
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i; while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      lastWord = src.slice(i, j); lastSig = src[j - 1]; out += lastWord; i = j; continue;
    }
    if (!/\s/.test(c)) lastSig = c;
    out += c;
    i++;
  }
  return out;
}

/* ---------- files ---------- */
function listJs(dir, acc) {
  for (const f of fs.readdirSync(path.join(ROOT, dir))) {
    const rel = dir + '/' + f;
    if (f === 'vendor') continue;
    if (fs.statSync(path.join(ROOT, rel)).isDirectory()) listJs(rel, acc);
    else if (f.endsWith('.js')) acc.push(rel);
  }
  return acc;
}

// Modules that the application does not load yet. The tests load them.
const NOT_LOADED_YET = ['js/io/chunkCodec.js', 'js/io/zip.js', 'js/core/project.js', 'js/io/recordingCodec.js', 'js/io/projectFile.js', 'js/io/localStore.js', 'js/io/fileAccess.js'];

const HEADER = /^GZ\.define\('([^']+)', \{ layer: '([^']+)', deps: \[([^\]]*)\] \}, function \(GZ\) \{$/m;

function check() {
  const problems = [];
  const files = listJs('js', []).concat([]);
  const modules = new Map();   // name -> { file, layer, deps, code }
  for (const file of files) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (file === 'js/core/define.js') continue;
    const m = src.match(HEADER);
    if (!m) { problems.push(file + ': no GZ.define header'); continue; }
    const deps = m[3].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    modules.set(m[1], { file, layer: m[2], deps, code: stripCode(src) });
  }
  const names = new Set(modules.keys());

  modules.forEach((mod, name) => {
    const where = mod.file + ' (' + name + ')';
    if (!(mod.layer in RANK)) { problems.push(where + ': unknown layer ' + mod.layer); return; }
    const folder = Object.keys(FOLDER_LAYERS).find(k => mod.file === k || mod.file.startsWith(k + '/'));
    if (!folder || !FOLDER_LAYERS[folder].includes(mod.layer)) problems.push(where + ': the layer ' + mod.layer + ' does not fit the folder');

    const used = new Set();
    const re = /\bGZ\s*\.\s*([A-Za-z][A-Za-z0-9]*)(?:\s*\.\s*([A-Za-z][A-Za-z0-9]*))?/g;
    let r;
    while ((r = re.exec(mod.code)) !== null) {
      let ref = r[1];
      if (ref === 'define') continue;
      if ((ref === 'charts' || ref === 'views') && r[2]) ref = ref + '.' + r[2];
      if (ref === name) continue;
      if (!names.has(ref)) { problems.push(where + ': uses the unknown module GZ.' + ref); continue; }
      used.add(ref);
    }
    used.forEach(u => { if (!mod.deps.includes(u)) problems.push(where + ': uses ' + u + ' but does not declare it'); });
    mod.deps.forEach(d => {
      if (!names.has(d)) { problems.push(where + ': declares the unknown module ' + d); return; }
      if (!used.has(d)) problems.push(where + ': declares ' + d + ' but does not use it');
      const dm = modules.get(d);
      if (RANK[dm.layer] > RANK[mod.layer]) problems.push(where + ': the layer ' + dm.layer + ' of ' + d + ' is higher than ' + mod.layer);
      if (dm.layer === 'app') problems.push(where + ': uses the layer app');
      if (mod.layer === 'ui' && dm.layer === 'store') problems.push(where + ': a ui module uses the store (' + d + ')');
      if (mod.layer === 'views' && dm.layer === 'views') problems.push(where + ': a view uses the view ' + d);
    });
  });

  // index.html: every file is loaded once, after its dependencies
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const order = Array.from(html.matchAll(/<script src="(js\/[^"]+)"><\/script>/g)).map(x => x[1]).filter(s => !s.startsWith('js/vendor/'));
  const seen = new Set();
  const nameOfFile = new Map(Array.from(modules.entries()).map(([k, v]) => [v.file, k]));
  order.forEach(f => {
    if (f === 'js/core/define.js') { seen.add('define'); return; }
    const nm = nameOfFile.get(f);
    if (!nm) { problems.push('index.html: the script ' + f + ' is not a module'); return; }
    if (seen.has(nm)) problems.push('index.html: the script ' + f + ' loads twice');
    modules.get(nm).deps.forEach(d => { if (!seen.has(d)) problems.push('index.html: ' + f + ' loads before its dependency ' + d); });
    seen.add(nm);
  });
  modules.forEach((m, nm) => { if (!seen.has(nm) && !NOT_LOADED_YET.includes(m.file)) problems.push('index.html: does not load ' + m.file); });
  if (order[0] !== 'js/core/define.js') problems.push('index.html: js/core/define.js must be the first script');
  return { problems, modules };
}

module.exports = { check, stripCode };

if (require.main === module) {
  const { problems, modules } = check();
  if (problems.length) { problems.forEach(p => console.log('FAIL ' + p)); console.log('\n' + problems.length + ' layer problem(s)'); process.exit(1); }
  console.log('ok: ' + modules.size + ' modules, layers and declared dependencies are correct');
}
