/* Static check of the content security policy.
     node tests/check-csp.js
   The page index.html has a strict policy: no inline script and no inline style. The check finds code that the policy would block:
   - index.html has the meta policy, and the policy has no 'unsafe-inline' and no 'unsafe-eval'
   - index.html has no style attribute, no inline script and no event attribute (onclick and so on)
   - the code in js/ (not js/vendor) has no style attribute in a text, no setAttribute('style'), no attr('style'),
     no eval, no new Function, no javascript: URL and no <style> element
   A style value that depends on data goes through GZ.cssom (data-css). A fixed style goes into a class of a stylesheet.
   The check reads the code with the same reader as tests/check-layers.js. It ignores comments. */
'use strict';
const fs = require('fs');
const path = require('path');
const { stripCode } = require('./check-layers');

const ROOT = path.join(__dirname, '..');

function listJs(dir, acc) {
  for (const f of fs.readdirSync(path.join(ROOT, dir))) {
    const rel = dir + '/' + f;
    if (f === 'vendor') continue;
    if (fs.statSync(path.join(ROOT, rel)).isDirectory()) listJs(rel, acc);
    else if (f.endsWith('.js')) acc.push(rel);
  }
  return acc;
}

function check() {
  const problems = [];
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const htmlNoComments = html.replace(/<!--[\s\S]*?-->/g, '');

  const meta = htmlNoComments.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);
  if (!meta) problems.push('index.html: no meta Content-Security-Policy');
  else {
    const policy = meta[1];
    if (/unsafe-inline|unsafe-eval|unsafe-hashes/.test(policy)) problems.push('index.html: the policy has an unsafe keyword');
    ['default-src', 'script-src', 'style-src', 'connect-src', 'object-src', 'base-uri', 'form-action'].forEach(d => {
      if (!new RegExp('(^|; )' + d + ' ').test(policy)) problems.push('index.html: the policy has no ' + d);
    });
    if (!/default-src 'none'/.test(policy)) problems.push("index.html: default-src must be 'none'");
    if (!/connect-src 'none'/.test(policy)) problems.push("index.html: connect-src must be 'none'");
    if (/https?:|\*/.test(policy)) problems.push('index.html: the policy names a host or has a wildcard');
  }
  if (/\sstyle\s*=/.test(htmlNoComments)) problems.push('index.html: has a style attribute');
  if (/<style[\s>]/i.test(htmlNoComments)) problems.push('index.html: has a style element');
  if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(htmlNoComments)) problems.push('index.html: has an inline script');
  if (/\son[a-z]+\s*=/i.test(htmlNoComments)) problems.push('index.html: has an event attribute');
  if (/<link[^>]+rel="stylesheet"[^>]+href="(https?:|\/\/)/i.test(htmlNoComments)) problems.push('index.html: loads a stylesheet from a network');
  if (/<(script|img)[^>]+src="(https?:|\/\/)/i.test(htmlNoComments)) problems.push('index.html: loads a resource from a network');

  const rules = [
    [/\bstyle\s*=\s*["'\\]/, 'a style attribute in a text'],
    [/setAttribute\(\s*['"]style['"]/, "setAttribute('style')"],
    [/\.attr\(\s*['"]style['"]/, "attr('style')"],
    [/\beval\s*\(/, 'eval'],
    [/\bnew\s+Function\b/, 'new Function'],
    [/javascript:/, 'a javascript: URL'],
    [/<style[\s>]/, 'a style element'],
    [/\son[a-z]+\s*=\s*["'\\]/, 'an event attribute in a text'],
    [/setTimeout\(\s*['"`]/, 'setTimeout with a text'],
    [/setInterval\(\s*['"`]/, 'setInterval with a text']
  ];
  listJs('js', []).forEach(file => {
    const code = stripCode(fs.readFileSync(path.join(ROOT, file), 'utf8'), true);
    rules.forEach(([re, what]) => { if (re.test(code)) problems.push(file + ': ' + what); });
  });
  return { problems };
}

module.exports = { check };

if (require.main === module) {
  const { problems } = check();
  if (problems.length) { problems.forEach(p => console.log('FAIL ' + p)); console.log('\n' + problems.length + ' policy problem(s)'); process.exit(1); }
  console.log('ok: index.html and the code follow the content security policy');
}
