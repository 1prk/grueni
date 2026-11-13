/* GZ.recordingCache keeps decoded recordings in memory (io layer).

   A project can have many recordings, one for each day. A decoded recording needs about 10 MB for 100 columns.
   The cache keeps the recordings that the code used last. When the total size is above the limit, it drops the recording
   that the code used least recently. The cache always keeps the last recording, also when this one alone is above the limit.
   A caller that shows a recording must keep its own reference. A recording that the cache drops stays valid for the caller.

   create({ maxBytes }) -> Cache   (default limit: 256 MiB)
   A Cache has these methods:
     get(id, sig?)        the decoded recording or undefined. The recording counts as used.
                          sig is a text that describes the content (for example the row count and the size of the chunks).
                          A cache entry with another sig is dropped. Then get() returns undefined.
     set(id, parsed, sig?)  keeps a recording.
     load(id, loader, sig?) -> Promise  gives the cached recording. Without it, the cache calls loader() one time,
                          keeps the result and gives it back. Two calls for the same id at the same time share one loader() call.
                          A loader that fails does not leave an entry.
     has(id), delete(id), clear()
     keys()               the ids, the one that was used least recently first.
     bytes                the estimated size of all entries.
     size                 the number of entries.
   sizeOf(parsed) estimates the memory of a decoded recording in bytes (the typed data of the table and the text arrays). */
GZ.define('recordingCache', { layer: 'io', deps: [] }, function (GZ) {
  'use strict';

  const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

  // A text array or a plain number array needs about 8 bytes for each element. The strings are shared and are not counted.
  function sizeOf(parsed) {
    let bytes = 0;
    const t = parsed && parsed.table;
    if (t) {
      bytes += t.times ? (t.times.byteLength || t.times.length * 8) : 0;
      (t.columns || []).forEach(c => {
        bytes += c.data ? c.data.byteLength : 0;
        if (c.exc) bytes += c.exc.idx.byteLength + c.exc.tok.byteLength;
      });
    }
    ['times', 'splValues', 'tcValues', 'cycleStarts'].forEach(k => { if (parsed && parsed[k]) bytes += parsed[k].length * 8; });
    return bytes;
  }

  function create(opts) {
    const maxBytes = opts && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX_BYTES;
    // A Map keeps the order of insertion. The first entry is the one that the code used least recently.
    const entries = new Map();   // id -> { parsed, sig, bytes }
    const loading = new Map();   // id -> Promise
    let total = 0;

    function drop(id) {
      const e = entries.get(id);
      if (e) { total -= e.bytes; entries.delete(id); }
    }
    function trim() {
      // The last recording stays.
      while (total > maxBytes && entries.size > 1) drop(entries.keys().next().value);
    }
    function touch(id) {
      const e = entries.get(id);
      entries.delete(id);
      entries.set(id, e);
    }

    const cache = {
      get(id, sig) {
        const e = entries.get(id);
        if (!e) return undefined;
        if (sig !== undefined && e.sig !== sig) { drop(id); return undefined; }
        touch(id);
        return e.parsed;
      },
      set(id, parsed, sig) {
        drop(id);
        const bytes = sizeOf(parsed);
        entries.set(id, { parsed, sig, bytes });
        total += bytes;
        trim();
      },
      load(id, loader, sig) {
        const hit = cache.get(id, sig);
        if (hit !== undefined) return Promise.resolve(hit);
        // A running load must have the same sig. Another sig means another content. It starts its own load.
        const running = loading.get(id);
        if (running && running.sig === sig) return running.promise;
        const promise = Promise.resolve().then(loader).then(parsed => {
          if (loading.get(id) && loading.get(id).promise === promise) loading.delete(id);
          cache.set(id, parsed, sig);
          return parsed;
        }, err => {
          if (loading.get(id) && loading.get(id).promise === promise) loading.delete(id);
          throw err;
        });
        loading.set(id, { promise, sig });
        return promise;
      },
      has(id) { return entries.has(id); },
      delete(id) { drop(id); },
      clear() { entries.clear(); total = 0; },
      keys() { return Array.from(entries.keys()); },
      get bytes() { return total; },
      get size() { return entries.size; }
    };
    return cache;
  }

  return { create, sizeOf, DEFAULT_MAX_BYTES };
});
