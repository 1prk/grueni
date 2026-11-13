/* Tests of GZ.fileAccess with a fake file picker and a fake downloader. */
(function () {
  'use strict';
  const GZ = window.GZ, T = window.GZT, assert = T.assert;
  const F = GZ.fileAccess;

  function fakeHandle(name, log, opts) {
    const o = opts || {};
    return {
      name,
      async queryPermission() { return o.permission || 'granted'; },
      async requestPermission() { return o.request || 'granted'; },
      async createWritable() {
        if (o.failOpen) throw new Error('gone');
        const parts = [];
        return { async write(b) { parts.push(b); }, async abort() { log.push('abort'); }, async close() { log.push({ file: name, bytes: parts[0] }); } };
      }
    };
  }
  async function withPicker(picker, fn) {
    const had = Object.prototype.hasOwnProperty.call(window, 'showSaveFilePicker'), old = window.showSaveFilePicker;
    window.showSaveFilePicker = picker;
    try { await fn(); } finally { if (had) window.showSaveFilePicker = old; else delete window.showSaveFilePicker; }
  }
  async function withoutPicker(fn) {
    const had = Object.prototype.hasOwnProperty.call(window, 'showSaveFilePicker'), old = window.showSaveFilePicker;
    delete window.showSaveFilePicker;
    try { await fn(); } finally { if (had) window.showSaveFilePicker = old; }
  }

  T.test('fileAccess: the time stamp goes before the extension', () => {
    const d = new Date(2026, 10, 3, 6, 5, 9);
    assert.equal(F.timestampedName('projekt.zip', d), 'projekt_2026-11-03_06-05-09.zip');
    assert.equal(F.timestampedName('knoten.grueni.zip', d), 'knoten_2026-11-03_06-05-09.grueni.zip');
    assert.equal(F.timestampedName('ohne', d), 'ohne_2026-11-03_06-05-09');
  });

  T.test('fileAccess: file names are made safe', () => {
    assert.equal(F.safeName('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
    assert.equal(F.safeName('..hidden'), 'hidden');
    assert.equal(F.safeName(''), 'datei');
    assert.equal(F.safeName('x'.repeat(300)).length, 120);
    assert.equal(F.safeName('Knoten Köln ✓.zip'), 'Knoten Köln ✓.zip');
  });

  T.test('fileAccess: without a picker the file is downloaded with a time stamp', async () => {
    await withoutPicker(async () => {
      const calls = [];
      F.setDownloader((bytes, name, mime) => calls.push({ bytes, name, mime }));
      const r = await F.save(Uint8Array.from([1, 2]), { suggestedName: 'p.zip', mime: 'application/zip' });
      assert.equal(r.mode, 'download');
      assert.equal(calls.length, 1);
      assert.ok(/^p_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.zip$/.test(calls[0].name), calls[0].name);
      assert.equal(calls[0].mime, 'application/zip');
      assert.equal(r.handle, null);
    });
  });

  T.test('fileAccess: with a picker the file is written and the handle comes back', async () => {
    const log = [], seen = [];
    await withPicker(async o => { seen.push(o); return fakeHandle('mein.zip', log); }, async () => {
      const r = await F.save(Uint8Array.from([7, 8, 9]), { suggestedName: 'a/b.zip', mime: 'application/zip', extensions: ['.zip'], description: 'Projekt' });
      assert.equal(r.mode, 'file-system');
      assert.equal(r.name, 'mein.zip');
      assert.ok(r.handle);
      assert.equal(seen[0].suggestedName, 'a-b.zip');
      assert.same(seen[0].types, [{ description: 'Projekt', accept: { 'application/zip': ['.zip'] } }]);
      assert.same(Array.from(log[0].bytes), [7, 8, 9]);
    });
  });

  T.test('fileAccess: a second save writes into the same file without a picker', async () => {
    const log = []; let pickerCalls = 0;
    const handle = fakeHandle('same.zip', log);
    await withPicker(async () => { pickerCalls++; return fakeHandle('new.zip', log); }, async () => {
      const r = await F.save(Uint8Array.from([1]), { suggestedName: 'x.zip', handle });
      assert.equal(pickerCalls, 0);
      assert.ok(r.handle === handle);
      assert.equal(log[0].file, 'same.zip');
    });
  });

  T.test('fileAccess: a handle that cannot be used leads to the picker', async () => {
    const log = []; let pickerCalls = 0;
    await withPicker(async () => { pickerCalls++; return fakeHandle('new.zip', log); }, async () => {
      let r = await F.save(Uint8Array.from([1]), { suggestedName: 'x.zip', handle: fakeHandle('old.zip', log, { permission: 'prompt', request: 'denied' }) });
      assert.equal(pickerCalls, 1); assert.equal(r.name, 'new.zip');
      r = await F.save(Uint8Array.from([1]), { suggestedName: 'x.zip', handle: fakeHandle('old.zip', log, { failOpen: true }) });
      assert.equal(pickerCalls, 2); assert.equal(r.name, 'new.zip');
    });
  });

  T.test('fileAccess: closing the picker is not an error and saves nothing', async () => {
    const log = [];
    await withPicker(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); }, async () => {
      const r = await F.save(Uint8Array.from([1]), { suggestedName: 'x.zip' });
      assert.equal(r.cancelled, true);
      assert.equal(log.length, 0);
    });
  });

  T.test('fileAccess: a picker or write error gives a clear message', async () => {
    await withPicker(async () => { throw Object.assign(new Error('disk'), { name: 'NotAllowedError' }); }, async () => {
      let err = null; try { await F.save(Uint8Array.from([1]), { suggestedName: 'x.zip' }); } catch (e) { err = e; }
      assert.ok(err && /Speichern nicht möglich: disk/.test(err.message));
    });
    await withPicker(async () => fakeHandle('f.zip', [], { failOpen: true }), async () => {
      let err = null; try { await F.save(Uint8Array.from([1]), { suggestedName: 'x.zip' }); } catch (e) { err = e; }
      assert.ok(err && /Speichern nicht möglich: gone/.test(err.message));
    });
  });
})();
