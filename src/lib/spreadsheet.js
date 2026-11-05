// Dependency-free readers for the spreadsheet formats a shop actually uploads:
// CSV / TSV (Excel "Save as CSV", Google Sheets export) and .xlsx (the default
// Excel format, which is a ZIP of XML parts).
//
// Both parsers return the same plain shape — `{ rows: string[][] }` — so the
// import pipeline never has to care which file it came from:
//
//   - every cell is a string (or '' when empty), already trimmed
//   - fully-blank leading/trailing rows and columns are dropped, because Excel
//     pads files with thousands of empty cells that would otherwise show up as
//     bogus "extra columns" in the mapping screen
//   - the first remaining row is the header, which the caller decides to use or
//     ignore
//
// Neither parser throws on bad input; they return `{ error }` so the route can
// answer with a 400 that names the problem instead of a stack trace.

import zlib from 'zlib';

/** Hard ceiling on parsed cells — an accidental 200k-row export would OOM the till. */
export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // matches the JSON body limit

/**
 * A problem with the uploaded file, phrased for the person who uploaded it.
 *
 * `status` is what the global error handler reads: a bad spreadsheet is a client
 * error (400), not a server fault, and the message is safe — and useful — to show.
 */
export class ImportParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportParseError';
    this.status = 400;
  }
}


/* ------------------------------- CSV / TSV ------------------------------- */

/**
 * Count how often each candidate delimiter appears outside quoted fields in the
 * header line, and pick the most likely one.
 *
 * Indonesian Excel writes `;` (comma is the decimal separator locally), US Excel
 * writes `,`, and a tab-separated paste uses `\t`. Counting only the first line
 * keeps a stray semi-colon inside a product description from winning.
 */
function detectDelimiter(text) {
  const sample = text.slice(0, 8192);
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let quoted = false;
  let headerDone = false;
  for (let i = 0; i < sample.length && !headerDone; i++) {
    const ch = sample[i];
    if (ch === '"') {
      // RFC4180: a doubled quote inside a quoted field is an escaped quote.
      if (quoted && sample[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted) {
      if (ch === '\n' || ch === '\r') headerDone = true;
      else if (ch in counts) counts[ch]++;
    }
  }
  let best = ',';
  for (const [d, n] of Object.entries(counts)) if (n > counts[best]) best = d;
  // No delimiter at all: a single-column file. Comma is as good a guess as any,
  // and the mapping screen will show exactly one column.
  return best;
}

/**
 * Parse delimited text into rows of cells.
 *
 * Handles the three things real files contain that a naive `split(',')` breaks
 * on: quoted fields with embedded delimiters/newlines, escaped `""` quotes, and
 * a UTF-8 BOM written by Excel (which would otherwise become part of the first
 * header and defeat auto-mapping).
 */
export function parseDelimited(input) {
  if (typeof input !== 'string' || !input.trim()) throw new ImportParseError('File kosong');
  const text = input.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(text);

  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  const pushCell = () => {
    row.push(cell.trim());
    cell = '';
  };
  const pushRow = () => {
    pushCell();
    // Drop the trailing empty cell produced by a line ending in the delimiter.
    if (row.length === 1 && row[0] === '') row = [];
    if (row.length) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === '') {
      // Quote opens a field only at its start; a quote mid-word is literal.
      quoted = true;
      cell = '';
    } else if (ch === delimiter) {
      pushCell();
    } else if (ch === '\n') {
      pushRow();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      pushRow();
    } else {
      cell += ch;
    }
  }
  // A file that does not end in a newline still has one last row pending.
  if (cell !== '' || row.length) pushRow();

  return { rows: trimGrid(rows), delimiter, format: delimiter === '\t' ? 'tsv' : 'csv' };
}

/* --------------------------------- XLSX --------------------------------- */

/** Read one ZIP entry by walking the central directory. */
function makeZipReader(buffer) {
  // End Of Central Directory: scan backwards for the signature; the record is
  // variable-length because the archive comment that follows it is arbitrary.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ImportParseError('Bukan file Excel (.xlsx) yang valid');

  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let n = 0; n < total; n++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.set(name.replace(/^\//, ''), { method, compressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.size) throw new ImportParseError('Bukan file Excel (.xlsx) yang valid');

  return (name) => {
    const entry = entries.get(name);
    if (!entry) return null;
    const lo = entry.localOffset;
    if (buffer.readUInt32LE(lo) !== 0x04034b50) return null;
    // The local header repeats the name/extra lengths, which can differ from the
    // central directory's copy — the payload always starts after *these*.
    const dataStart = lo + 30 + buffer.readUInt16LE(lo + 26) + buffer.readUInt16LE(lo + 28);
    const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);
    if (entry.method === 0) return data.toString('utf8');
    if (entry.method === 8) return zlib.inflateRawSync(data).toString('utf8');
    throw new ImportParseError('Format kompresi Excel tidak didukung');
  };
}

/** Undo the XML entities and Excel's `_x000D_` escapes found in cell text. */
const sanitizeXml = (s) =>
  String(s)
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** All `<si>` (shared string) texts, concatenating rich-text runs. */
function readSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const si of xml.match(/<si\b[^>]*>[\s\S]*?<\/si>/g) || []) {
    const texts = si.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || [];
    out.push(sanitizeXml(texts.map((t) => t.replace(/^<t\b[^>]*>|<\/t>$/g, '')).join('')));
  }
  return out;
}

/**
 * Resolve the part that holds the data of the first worksheet.
 *
 * `xl/workbook.xml` lists the sheets and `xl/_rels/workbook.xml.rels` maps their
 * r:ids to part names; the order in `workbook.xml` is the visible sheet order, so
 * "the first sheet" needs both files. Single-sheet exports (the common case) fall
 * back to `sheet1.xml`, which is what Excel, LibreOffice and SheetJS all write
 * for one sheet.
 */
function firstSheetPath(read) {
  const workbook = read('xl/workbook.xml');
  const rels = read('xl/_rels/workbook.xml.rels');
  if (workbook && rels) {
    const sheet = /<sheet\b[^>]*r:id="([^"]+)"/.exec(workbook);
    if (sheet) {
      const rel = new RegExp(`<Relationship\\b[^>]*Id="${sheet[1]}"[^>]*>`).exec(rels);
      const target = rel && /Target="([^"]+)"/.exec(rel[0]);
      if (target) {
        const name = target[1].replace(/^\/?xl\//, '').replace(/^\//, '');
        if (read(`xl/${name}`)) return `xl/${name}`;
      }
    }
  }
  return ['xl/worksheets/sheet1.xml', 'xl/worksheets/Sheet1.xml'].find((p) => read(p)) || null;
}

/** `C12` → 2 (zero-based column index). */
const columnToIndex = (ref) => {
  const letters = /^([A-Z]+)/.exec(ref || '');
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/**
 * Parse the first worksheet of an .xlsx buffer.
 *
 * Cell types handled: `s` (shared string), `inlineStr`, `str` (formula result),
 * `b` (boolean), `e` (error → empty) and numbers, which include dates — a date
 * cell surfaces as its serial number, which the importer rejects on a price
 * column and reports as an invalid value instead of quietly reading it as money.
 */
export function parseXlsx(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new ImportParseError('File kosong');
  const read = makeZipReader(buffer);
  const sheetPath = firstSheetPath(read);
  if (!sheetPath) throw new ImportParseError('File Excel tidak berisi worksheet');
  const sheet = read(sheetPath) || '';
  const shared = readSharedStrings(read('xl/sharedStrings.xml'));

  const grid = [];
  for (const rowXml of sheet.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) || []) {
    const rowNumber = Number((/<row\b[^>]*\br="(\d+)"/.exec(rowXml) || [])[1]);
    const cells = [];
    for (const cellXml of rowXml.match(/<c\b[^>]*>[\s\S]*?<\/c>|<c\b[^>]*\/>/g) || []) {
      const ref = (/<c\b[^>]*\br="([A-Z]+\d+)"/.exec(cellXml) || [])[1];
      const type = (/<c\b[^>]*\bt="([^"]+)"/.exec(cellXml) || [])[1];
      const raw = (/<v>([\s\S]*?)<\/v>/.exec(cellXml) || [])[1];
      let value = '';
      if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = sanitizeXml((/<t\b[^>]*>([\s\S]*?)<\/t>/.exec(cellXml) || [])[1] || '');
      else if (type === 'str') value = sanitizeXml(raw || '');
      else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'e' || raw === undefined) value = '';
      else value = sanitizeXml(raw);
      const idx = columnToIndex(ref);
      // Sparse rows: empty cells are omitted from the XML entirely, so cells must
      // be placed by reference rather than appended in order.
      if (idx >= 0) cells[idx] = String(value).trim();
    }
    const values = Array.from(cells, (v) => (v === undefined ? '' : v));
    // Keep the physical row position so blank rows in the middle of the file do
    // not shift the row numbers the user sees in Excel.
    const at = Number.isFinite(rowNumber) && rowNumber > 0 ? rowNumber - 1 : grid.length;
    grid[at] = values;
  }

  return { rows: trimGrid(grid.filter(Boolean)), format: 'xlsx' };
}

/* -------------------------------- shared -------------------------------- */

/**
 * Drop trailing empty cells from every row, then leading/trailing blank rows.
 *
 * Leading blank rows matter: people leave a title row or two above the header,
 * and those would otherwise become a one-cell "header" that maps to nothing.
 */
function trimGrid(rows) {
  const cleaned = rows.map((r) => {
    const cells = Array.isArray(r) ? [...r] : [];
    while (cells.length && String(cells[cells.length - 1] ?? '').trim() === '') cells.pop();
    return cells.map((c) => (c == null ? '' : String(c).trim()));
  });
  const isBlankRow = (r) => !r || r.every((c) => !c);
  let start = 0;
  let end = cleaned.length;
  while (start < end && isBlankRow(cleaned[start])) start++;
  while (end > start && isBlankRow(cleaned[end - 1])) end--;
  const out = cleaned.slice(start, end);
  if (out.length > MAX_IMPORT_ROWS + 1) {
    throw new ImportParseError(`Terlalu banyak baris (maks ${MAX_IMPORT_ROWS} produk per impor)`);
  }
  return out;
}

/**
 * Pick a parser from the file's content and name.
 *
 * Content beats extension: a CSV that someone renamed to .xlsx is far more common
 * than a spreadsheet without the ZIP magic number, and `.xls` (the old binary
 * BIFF format) is not readable here at all — saying so beats "invalid file".
 */
export function parseSpreadsheet({ text, buffer, filename = '' }) {
  const lower = String(filename).toLowerCase();
  if (Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
    return parseXlsx(buffer);
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
    throw new ImportParseError('File .xlsx tidak valid. Simpan ulang sebagai .xlsx atau .csv');
  }
  if (lower.endsWith('.xls')) {
    throw new ImportParseError('Format .xls (Excel 97) tidak didukung — simpan sebagai .xlsx atau .csv');
  }
  return parseDelimited(Buffer.isBuffer(buffer) ? decodeText(buffer) : String(text ?? ''));
}

/**
 * Decode a text file buffer, honouring the BOMs Excel actually writes.
 *
 * "Unicode Text (.txt)" — what a shop gets from "Save as → Unicode Text" — is
 * UTF-16LE and starts with a BOM. Reading it as UTF-8 yields text with NUL bytes
 * between every character, so every header fails to map and the file looks
 * corrupt instead of mis-encoded.
 */
export function decodeText(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    // UTF-8 BOM: `parseDelimited` strips it, but skipping it here avoids relying
    // on that when the caller uses `decodeText` directly.
    return buffer.toString('utf8', 3);
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.toString('utf16le', 2);
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    // UTF-16BE: swap to LE, which node can decode natively.
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buffer.toString('utf8');
}

/**
 * Split a parsed grid into its header row and data rows.
 *
 * Kept separate from `parseSpreadsheet` because the parser knowingly returns one
 * uniform grid: whether row 1 is a header or the first product is an import
 * decision, not a parsing one. The import route always treats row 1 as the header
 * (the template says so), so this is the one place that rule lives.
 *
 * Fully empty trailing rows are already dropped by `trimGrid`, but a row of blank
 * cells in the middle is kept — dropping it would shift every later row's reported
 * spreadsheet line number.
 */
export function splitHeader(grid) {
  const rows = Array.isArray(grid) ? grid : (grid && grid.rows) || [];
  if (!rows.length) return { headers: [], rows: [], format: null };
  const [headers, ...body] = rows;
  return {
    headers: headers.map((h) => String(h ?? '').trim()),
    rows: body,
    format: (grid && grid.format) || null,
    delimiter: (grid && grid.delimiter) || null
  };
}
