/* GZ.fileAccess saves a file for the user (io layer).

   Two ways:
   - File System Access (Edge and other Chromium browsers). The user picks a file once. Later saves write into the same file.
   - Download (Firefox, and every browser without File System Access). Each save makes a new file with a time stamp in the name.

   save(bytes, opts) -> Promise<{ mode, name, handle, cancelled }>
     opts.suggestedName  the name for the picker, or the base of the download name
     opts.handle         the handle from an earlier save. The file is written in place when the browser allows it.
     opts.mime           the media type (default application/octet-stream)
     opts.extensions     for the picker, for example ['.zip']
     opts.description    the text of the picker
     mode is 'file-system' or 'download'. cancelled is true when the user closes the picker. Then nothing was saved.
   timestampedName(name, date) puts the time stamp before the extension.
   The extension is the last dot with up to 8 letters or digits. The part ".grueni" before it belongs to it.
   So "a.grueni.zip" becomes "a_2026-11-13_10-15-30.grueni.zip" and "Str. 5.zip" becomes "Str. 5_2026-11-13_10-15-30.zip".
   setDownloader(fn) replaces the download function. The tests use it. */
GZ.define('fileAccess', { layer: 'io', deps: [] }, function (GZ) {
  'use strict';

  const pad = n => (n < 10 ? '0' : '') + n;
  function timestampedName(name, date) {
    const d = date || new Date();
    const stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '_' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds());
    const m = String(name).match(/^(.*?)((?:\.grueni)?\.[A-Za-z0-9]{1,8})?$/);
    return m[1] + '_' + stamp + (m[2] || '');
  }

  // A file name that is safe on Windows and Linux. The folder separators and other special characters become "-".
  function safeName(name) {
    return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^\.+/, '').slice(0, 120) || 'datei';
  }

  let downloader = function (bytes, name, mime) {
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = name;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    // The browser needs a moment to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  const setDownloader = fn => { downloader = fn; };

  const canPick = () => typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';

  async function writeHandle(handle, bytes) {
    const w = await handle.createWritable();
    try { await w.write(bytes); } catch (e) { try { await w.abort(); } catch (e2) { /* the first error is the important one */ } throw e; }
    await w.close();
  }

  async function ensurePermission(handle) {
    if (typeof handle.queryPermission !== 'function') return true;
    const opt = { mode: 'readwrite' };
    if ((await handle.queryPermission(opt)) === 'granted') return true;
    return typeof handle.requestPermission === 'function' && (await handle.requestPermission(opt)) === 'granted';
  }

  async function save(bytes, opts) {
    const o = opts || {};
    const mime = o.mime || 'application/octet-stream';
    const name = safeName(o.suggestedName || 'datei');
    if (canPick()) {
      // First try the file of an earlier save.
      if (o.handle) {
        try {
          if (await ensurePermission(o.handle)) { await writeHandle(o.handle, bytes); return { mode: 'file-system', name: o.handle.name || name, handle: o.handle, cancelled: false }; }
        } catch (e) { /* the file is gone or not writable. Ask the user for a new place. */ }
      }
      let handle;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: o.extensions ? [{ description: o.description || 'Datei', accept: { [mime]: o.extensions } }] : undefined
        });
      } catch (e) {
        if (e && e.name === 'AbortError') return { mode: 'file-system', name, handle: null, cancelled: true };
        throw new Error('Speichern nicht möglich: ' + ((e && e.message) || e));
      }
      try { await writeHandle(handle, bytes); } catch (e) { throw new Error('Speichern nicht möglich: ' + ((e && e.message) || e)); }
      return { mode: 'file-system', name: handle.name || name, handle, cancelled: false };
    }
    const downloadName = timestampedName(name);
    downloader(bytes, downloadName, mime);
    return { mode: 'download', name: downloadName, handle: null, cancelled: false };
  }

  return { save, timestampedName, safeName, canPick, setDownloader };
});
