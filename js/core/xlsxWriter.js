/* GZ.xlsxWriter — minimaler, abhängigkeitsfreier XLSX-Schreiber (ZIP im
   "store"-Verfahren + das kleinstmögliche gültige OOXML-Spreadsheet-Paket:
   Content-Types, Beziehungen, Workbook, ein Worksheet mit Inline-Strings).
   Kein Vendoring einer Fremdbibliothek, passend zum Rest der Anwendung
   (kein Build-Schritt, keine externen Ressourcen). */
(function (GZ) {
  'use strict';

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function u16(v) { return [v & 0xff, (v >> 8) & 0xff]; }
  function u32(v) { return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]; }

  // Feste, plausible DOS-Zeit/-Datum (kosmetisch, Excel wertet das nicht aus).
  const DOS_TIME = 0, DOS_DATE = 0x5821; // 2024-01-01

  function buildZip(files) {
    const localChunks = [];
    const centralChunks = [];
    let offset = 0;
    const encoder = new TextEncoder();

    files.forEach(f => {
      const nameBytes = encoder.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      const size = data.length;

      const local = new Uint8Array([
        ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
        ...u16(DOS_TIME), ...u16(DOS_DATE), ...u32(crc), ...u32(size), ...u32(size),
        ...u16(nameBytes.length), ...u16(0)
      ]);
      localChunks.push(local, nameBytes, data);

      const central = new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
        ...u16(DOS_TIME), ...u16(DOS_DATE), ...u32(crc), ...u32(size), ...u32(size),
        ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
        ...u32(offset)
      ]);
      centralChunks.push(central, nameBytes);

      offset += local.length + nameBytes.length + data.length;
    });

    const centralStart = offset;
    const centralSize = centralChunks.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array([
      ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
      ...u32(centralSize), ...u32(centralStart), ...u16(0)
    ]);

    const allChunks = [...localChunks, ...centralChunks, eocd];
    const total = allChunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    allChunks.forEach(c => { out.set(c, p); p += c.length; });
    return out;
  }

  function xmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function colLetter(idx0) {
    let n = idx0 + 1, s = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function cellXml(colIdx0, rowIdx1, value) {
    const ref = colLetter(colIdx0) + rowIdx1;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return `<c r="${ref}"><v>${value}</v></c>`;
    }
    const text = value == null ? '' : String(value);
    if (text === '') return `<c r="${ref}"/>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
  }

  function rowXml(rowIdx1, cells) {
    return `<row r="${rowIdx1}">${cells.map((v, i) => cellXml(i, rowIdx1, v)).join('')}</row>`;
  }

  function sanitizeSheetName(name) {
    let s = String(name || '').replace(/[[\]:*?/\\]/g, ' ').trim();
    if (!s) s = 'Tabelle1';
    return s.slice(0, 31);
  }

  // headerRow: string[]. dataRows: array of arrays, each cell number|string|null.
  function buildWorkbookBlob(sheetName, headerRow, dataRows) {
    const enc = new TextEncoder();
    const rowsXml = [rowXml(1, headerRow)];
    dataRows.forEach((r, i) => rowsXml.push(rowXml(i + 2, r)));
    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml.join('')}</sheetData></worksheet>`;

    const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="${xmlEscape(sanitizeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `</Types>`;

    const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`;

    const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `</Relationships>`;

    const files = [
      { name: '[Content_Types].xml', data: enc.encode(contentTypesXml) },
      { name: '_rels/.rels', data: enc.encode(rootRelsXml) },
      { name: 'xl/workbook.xml', data: enc.encode(workbookXml) },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRelsXml) },
      { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml) }
    ];
    const zipBytes = buildZip(files);
    return new Blob([zipBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  GZ.xlsxWriter = { buildWorkbookBlob };
})(window.GZ = window.GZ || {});
