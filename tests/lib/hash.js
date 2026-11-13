/* GZT.hash is a fast 53-bit string hash (cyrb53). It is not for security.
   It makes compact golden values for long arrays.
   The result is the same in every browser and in Node. */
(function (root) {
  'use strict';
  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }
  // Hash of a list of values. The separator cannot occur in the data.
  function hashList(list) { return hash(Array.prototype.join.call(list, '\u0001')); }

  root.GZT = root.GZT || {};
  root.GZT.hash = hash;
  root.GZT.hashList = hashList;
})(window);
