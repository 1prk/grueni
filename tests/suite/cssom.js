/* Tests of GZ.cssom. The style of an element comes from data-css and goes through the CSSOM. */
(function () {
  'use strict';
  const GZ = window.GZ, T = window.GZT, assert = T.assert;

  T.test('cssom: declarations split at semicolons outside brackets', () => {
    assert.same(GZ.cssom.declarations('a:b;c:d'), ['a:b', 'c:d']);
    assert.same(GZ.cssom.declarations(' a : b ; ; c:d; '), ['a : b', 'c:d']);
    assert.same(GZ.cssom.declarations('background:repeating-linear-gradient(45deg,red 0 3px,blue 3px 4px);opacity:.5'),
      ['background:repeating-linear-gradient(45deg,red 0 3px,blue 3px 4px)', 'opacity:.5']);
    assert.same(GZ.cssom.declarations('--chip:var(--a, b;c)'), ['--chip:var(--a, b;c)']);
    assert.same(GZ.cssom.declarations(''), []);
  });

  T.test('cssom: apply sets the styles and removes the attribute (browser only)', () => {
    if (typeof document === 'undefined') return;
    const host = document.createElement('div');
    host.innerHTML = '<span data-css="color:rgb(1, 2, 3);opacity:.5"></span><p><i data-css="--chip:#336699;border-top:2px solid red"></i></p>';
    GZ.cssom.apply(host);
    const span = host.querySelector('span'), i = host.querySelector('i');
    assert.equal(span.style.color, 'rgb(1, 2, 3)');
    assert.equal(span.style.opacity, '0.5');
    assert.equal(i.style.getPropertyValue('--chip'), '#336699');
    assert.equal(i.style.borderTopWidth, '2px');
    assert.equal(host.querySelectorAll('[data-css]').length, 0, 'the attribute must be gone');
    // the root itself can have data-css
    const root = document.createElement('div');
    root.setAttribute('data-css', 'opacity:.25');
    GZ.cssom.apply(root);
    assert.equal(root.style.opacity, '0.25');
    assert.equal(GZ.cssom.apply(null), null);
  });
})();
