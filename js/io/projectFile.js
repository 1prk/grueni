/* GZ.projectFile reads and writes the project file (io layer, no DOM).

   The project file is a ZIP (see GZ.zip) with these entries:
     project.json                    the model of GZ.project (the text is deflate packed)
     chunks/<recording id>/<name>.chunk   one entry for each chunk (see GZ.chunkCodec). The chunks are stored as they are, because they are already packed.
   Any ZIP tool can open the file.

   pack(project, getChunk, opts) -> Promise<Uint8Array>
     getChunk(key) must return a promise for the bytes of the chunk. The key is GZ.project.chunkKey(recording id, name).
     opts.now sets the date of the ZIP entries.
   unpack(bytes, opts) -> Promise<{ project, keys, getChunk }>
     The project is migrated to the current version and validated.
     The error for a file from a newer version has the code 'newer'.
     getChunk(key) reads one chunk from the ZIP file and checks its checksum.
     unpack() checks that every chunk that the project names is in the file. It does not read the chunks.

   Extra entries in the file are ignored. This lets later versions add data. */
GZ.define('projectFile', { layer: 'io', deps: ['project', 'zip'] }, function (GZ) {
  'use strict';
  const P = GZ.project, Z = GZ.zip;

  const PROJECT_ENTRY = 'project.json';
  const entryName = key => 'chunks/' + key + '.chunk';

  async function pack(project, getChunk, opts) {
    P.validate(project);
    const encoder = new TextEncoder();
    const entries = [{ name: PROJECT_ENTRY, data: encoder.encode(JSON.stringify(project)), deflate: true }];
    for (const key of P.chunkKeys(project)) {
      const bytes = await getChunk(key);
      if (!(bytes instanceof Uint8Array) && !ArrayBuffer.isView(bytes)) throw new Error('Projektdatei: der Datenblock ' + key + ' fehlt im Speicher');
      entries.push({ name: entryName(key), data: bytes });
    }
    return Z.create(entries, { now: opts && opts.now });
  }

  async function unpack(bytes, opts) {
    let zip;
    try { zip = await Z.read(bytes, opts); } catch (e) { throw new Error('Keine gültige Projektdatei: ' + e.message.replace(/^zip: /, '')); }
    if (!zip.has(PROJECT_ENTRY)) throw new Error('Keine gültige Projektdatei: "' + PROJECT_ENTRY + '" fehlt.');
    let doc;
    try { doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await zip.get(PROJECT_ENTRY))); }
    catch (e) { throw new Error('Projektdatei beschädigt: ' + PROJECT_ENTRY + ' ist nicht lesbar (' + e.message.replace(/^zip: /, '') + ').'); }
    const project = P.validate(P.migrate(doc));
    const keys = P.chunkKeys(project);
    const missing = keys.filter(k => !zip.has(entryName(k)));
    if (missing.length) throw new Error('Projektdatei beschädigt: ' + missing.length + ' Datenblock/Datenblöcke fehlen, zum Beispiel ' + missing[0] + '.');
    const known = new Set(keys);
    async function getChunk(key) {
      if (!known.has(key)) throw new Error('Projektdatei: unbekannter Datenblock ' + key);
      return zip.get(entryName(key));
    }
    return { project, keys, getChunk };
  }

  return { pack, unpack, PROJECT_ENTRY };
});
