/* GZ.cssom sets styles with the CSSOM (element.style). This is allowed under the content security policy.
   A style attribute in markup is not allowed.

   A template that needs a value from the data writes the attribute data-css instead of style:
     `<span class="swatch" data-css="background:${color}"></span>`
   After the code puts the markup into the page, it calls GZ.cssom.apply(container).
   apply() sets each declaration of data-css on its element and removes the attribute.
   A declaration can be a custom property (for example "--chip:#336699"). */
GZ.define('cssom', { layer: 'ui', deps: [] }, function (GZ) {
  'use strict';

  // Splits the text of data-css into declarations. A semicolon inside brackets is part of the value.
  function declarations(text) {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i <= text.length; i++) {
      const c = text[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if ((c === ';' && depth === 0) || i === text.length) {
        const d = text.slice(start, i).trim();
        if (d) out.push(d);
        start = i + 1;
      }
    }
    return out;
  }

  // Applies data-css on the root and on all elements below it. Returns the root.
  function apply(root) {
    if (!root) return root;
    const list = root.querySelectorAll('[data-css]');
    const all = root.hasAttribute && root.hasAttribute('data-css') ? [root].concat(Array.from(list)) : list;
    for (const el of all) {
      declarations(el.getAttribute('data-css')).forEach(d => {
        const k = d.indexOf(':');
        if (k > 0) el.style.setProperty(d.slice(0, k).trim(), d.slice(k + 1).trim());
      });
      el.removeAttribute('data-css');
    }
    return root;
  }

  return { apply, declarations };
});
