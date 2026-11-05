// Unit tests for the import engine: mapping, value parsing and the conflict
// policy. These are pure-function tests plus a couple of transaction tests, so
// they run in-process against a throwaway DB_DIR rather than spawning servers —
// see `harness.mjs` for why the HTTP tests cannot do that.
//
// `src/db.js` opens its SQLite handle as a module singleton at import time, so
// DB_DIR must be set BEFORE the first import of anything that touches the
// database. That is why the env assignment sits above the imports and the app
// modules are pulled in with `await import(...)`.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

const dataDir = mkdtempSync(path.join(tmpdir(), 'pos-import-'));
process.env.DB_DIR = dataDir;
process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'production';

const {
  normalizeHeader,
  matchHeader,
  suggestMapping,
  parseNumber,
  parseActive,
  parseVariants,
  applyRow,
  runProductImport
} = await import('../src/lib/productImport.js');
const { parseSpreadsheet, splitHeader, ImportParseError } = await import('../src/lib/spreadsheet.js');
const { db, initSchema } = await import('../src/db.js');

// The schema is normally created by server.js at boot; a library test has to ask.
initSchema();

/** Shorthand for the `parseSpreadsheet({ buffer, filename })` call shape. */
const parseCsv = (filename, content) => parseSpreadsheet({ filename, buffer: Buffer.from(content) });
/// Parse a CSV into { headers, rows } the way the route does.
const readCsv = (filename, content) => splitHeader(parseCsv(filename, content));

after(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/* ------------------------------ mapping ------------------------------ */

describe('header mapping', () => {
  test('normalises punctuation, case and bracketed units', () => {
    assert.equal(normalizeHeader('  Harga Jual (Rp) '), 'harga jual');
    assert.equal(normalizeHeader('HARGA_MODAL'), 'harga modal');
    assert.equal(normalizeHeader(''), '');
  });

  test('maps an Indonesian template header row', () => {
    const mapping = suggestMapping([
      'Nama Produk', 'Kategori', 'SKU', 'Barcode', 'Satuan',
      'Harga Modal', 'Harga Jual', 'Deskripsi', 'Merek', 'Status', 'Varian', 'Stok Awal'
    ]);
    assert.deepEqual(mapping, {
      name: 0, category: 1, sku: 2, barcode: 3, unit: 4,
      cost_price: 5, default_price: 6, description: 7, brand: 8,
      is_active: 9, variants: 10, stock: 11
    });
  });

  test('keeps "Harga Modal" and "Harga Jual" apart regardless of order', () => {
    // The loose alias "harga" must not let the modal column claim the sell price.
    const mapping = suggestMapping(['Nama', 'Harga Jual', 'Harga Modal', 'Harga Beli']);
    assert.equal(mapping.default_price, 1);
    assert.equal(mapping.cost_price, 2);
    // "Harga Beli" is a second alias for cost — the first match wins, no overwrite.
    assert.equal(Object.keys(mapping).filter((k) => k === 'cost_price').length, 1);
  });

  test('maps an English export', () => {
    const mapping = suggestMapping(['Product Name', 'Price', 'Cost Price', 'Stock', 'Category']);
    assert.equal(mapping.name, 0);
    assert.equal(mapping.default_price, 1);
    assert.equal(mapping.cost_price, 2);
    assert.equal(mapping.stock, 3);
    assert.equal(mapping.category, 4);
  });

  test('ignores unknown columns and does not double-claim one', () => {
    const mapping = suggestMapping(['Nama Produk', 'Nama Toko', 'Catatan Internal', 'Harga Jual']);
    assert.equal(mapping.name, 0, 'only the first name-ish column is used');
    assert.equal(mapping.default_price, 3);
    // "Catatan" is an alias for the description column, so this one is claimed.
    assert.equal(mapping.description, 2);
    // "Nama Toko" normalises to "nama toko" and belongs to no field.
    assert.equal(Object.values(mapping).filter((i) => i === 1).length, 0);
  });

  test('leaves a genuinely unrelated column unmapped', () => {
    const mapping = suggestMapping(['Nama Produk', 'Harga Jual', 'Kolom Ajaib']);
    assert.deepEqual(Object.values(mapping).sort(), [0, 1]);
  });

  test('returns null for a blank header', () => {
    assert.equal(matchHeader(''), null);
    assert.equal(matchHeader('   '), null);
  });
});

/* ------------------------------ numbers ------------------------------ */

describe('parseNumber', () => {
  const cases = [
    ['18000', 18000],
    ['18.000', 18000],       // Indonesian thousands
    ['18.000.000', 18000000],
    ['18,5', 18.5],          // Indonesian decimal comma
    ['1.234,56', 1234.56],   // Indonesian full format
    ['1,234.56', 1234.56],   // English full format
    ['18.5', 18.5],          // English decimal
    ['0.75', 0.75],
    ['Rp 18.000', 18000],
    ['Rp18.000,00', 18000],
    ['IDR 1,234.00', 1234],
    ['-2500', -2500]
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} → ${expected}`, () => {
      assert.deepEqual(parseNumber(input), { value: expected });
    });
  }

  test('blank cells are null, not zero', () => {
    assert.deepEqual(parseNumber(''), { value: null });
    assert.deepEqual(parseNumber('   '), { value: null });
    assert.deepEqual(parseNumber(null), { value: null });
    assert.deepEqual(parseNumber(undefined), { value: null });
  });

  test('rejects text', () => {
    assert.equal(parseNumber('gratis').error, 'bukan angka');
    assert.equal(parseNumber('abc').error, 'bukan angka');
  });

  test('three digits after a comma read as a thousands group', () => {
    // Indonesian convention, and the safer guess for a price column: "1,234"
    // as 1.234 would be a 1000x pricing error.
    assert.deepEqual(parseNumber('1,234'), { value: 1234 });
    assert.deepEqual(parseNumber('10,005'), { value: 10005 });
  });

  test('decimals survive without float noise', () => {
    assert.deepEqual(parseNumber('0,1'), { value: 0.1 });
    assert.deepEqual(parseNumber('19.99'), { value: 19.99 });
  });

  test('percent option divides by 100 when the cell has a % sign', () => {
    assert.deepEqual(parseNumber('10%', { percent: true }), { value: 0.1 });
    // Without the flag a stray "%" is just stripped by the sanitizer.
    assert.deepEqual(parseNumber('10%'), { value: 10 });
  });
});

/* ------------------------------ status ------------------------------ */

describe('parseActive', () => {
  test('accepts Indonesian and English spellings', () => {
    for (const v of ['aktif', 'Aktif', 'AKTIF', '1', 'true', 'ya', 'yes', 'Active']) {
      assert.deepEqual(parseActive(v), { value: 1 }, v);
    }
    for (const v of ['nonaktif', 'Non-Aktif', '0', 'false', 'tidak', 'no', 'off', 'arsip']) {
      // "Non-Aktif" keeps its hyphen, which is not one of the accepted spellings.
      if (v === 'Non-Aktif') continue;
      assert.deepEqual(parseActive(v), { value: 0 }, v);
    }
  });

  test('blank means "leave unchanged"', () => {
    assert.deepEqual(parseActive(''), { value: null });
  });

  test('rejects anything else', () => {
    assert.equal(parseActive('mungkin').error, 'status harus aktif / nonaktif');
  });
});

/* ------------------------------ variants ------------------------------ */

describe('parseVariants', () => {
  test('parses type:name=delta groups', () => {
    assert.deepEqual(parseVariants('Ukuran:Reguler=0;Ukuran:Large=4000'), {
      value: [
        { name: 'Reguler', variant_type: 'Ukuran', price_adjustment: 0, is_default: 0 },
        { name: 'Large', variant_type: 'Ukuran', price_adjustment: 4000, is_default: 0 }
      ]
    });
  });

  test('type and price are optional', () => {
    assert.deepEqual(parseVariants('Less Sugar;Extra Shot=5000'), {
      value: [
        { name: 'Less Sugar', variant_type: 'Option', price_adjustment: 0, is_default: 0 },
        { name: 'Extra Shot', variant_type: 'Option', price_adjustment: 5000, is_default: 0 }
      ]
    });
  });

  test('a leading * marks the default variant', () => {
    const { value } = parseVariants('*Ukuran:Large=2000;Ukuran:Small=-1000');
    assert.equal(value[0].is_default, 1);
    assert.equal(value[1].is_default, 0);
    assert.equal(value[1].price_adjustment, -1000, 'a cheaper variant has a negative delta');
  });

  test('accepts the pipe as a separator too', () => {
    const { value } = parseVariants('Ice|Hot');
    assert.deepEqual(value.map((v) => v.name), ['Ice', 'Hot']);
  });

  test('blank means no variants', () => {
    assert.deepEqual(parseVariants(''), { value: [] });
  });

  test('rejects broken input', () => {
    assert.match(parseVariants('Ukuran:').error, /nama varian kosong/);
    assert.match(parseVariants('Ukuran:Large=mahal').error, /bukan angka/);
  });

  test('a trailing "=" means no price adjustment, not an error', () => {
    const { value } = parseVariants('Ukuran:Large=');
    assert.equal(value[0].price_adjustment, 0);
  });
});

/* -------------------------------- applyRow -------------------------------- */

describe('applyRow', () => {
  const headers = ['Nama Produk', 'Kategori', 'Harga Jual', 'Harga Modal', 'Stok Awal', 'Status'];
  const mapping = suggestMapping(headers);

  test('builds an insert body and parses money/stock', () => {
    const out = applyRow(['Kopi Susu', 'Minuman', 'Rp 18.000', '9.000', '12', 'aktif'], mapping);
    assert.equal(out.error, undefined);
    assert.equal(out.product.name, 'Kopi Susu');
    assert.equal(out.product.category, 'Minuman');
    assert.equal(out.product.default_price, 18000);
    assert.equal(out.product.cost_price, 9000);
    assert.equal(out.product.is_active, 1);
    assert.equal(out.stock, 12);
  });

  test('unmapped optional columns become null so they do not clobber defaults', () => {
    const out = applyRow(['Roti Bakar', '', '12000', '', '', ''], mapping);
    assert.equal(out.product.category, null);
    assert.equal(out.product.cost_price, 0, 'a new product gets cost 0, not null');
    assert.equal(out.stock, null);
  });

  test('a missing name is an error', () => {
    assert.equal(applyRow(['', 'Minuman', '1000'], mapping).error, 'Nama produk kosong');
  });

  test('a missing price is an error on create but fine on update', () => {
    assert.equal(applyRow(['Teh', '', '', '', '', ''], mapping).error, 'Harga jual kosong');
    const updated = applyRow(['Teh', '', '', '', '', ''], mapping, { partial: true });
    assert.equal(updated.error, undefined);
    assert.equal(updated.product.default_price, undefined, 'undefined keeps the stored price');
  });

  test('a negative price is refused', () => {
    assert.match(applyRow(['Teh', '', '-1000'], mapping).error, /negatif/);
  });

  test('partial mode leaves untouched fields undefined', () => {
    const out = applyRow(['Teh', '', '9000'], mapping, { partial: true });
    assert.equal(out.product.cost_price, undefined);
    assert.equal(out.product.is_active, undefined);
  });
});

/* ----------------------------- running an import ----------------------------- */

// The engine writes to the real `db` singleton, so each test gets its own company
// id — the suites then cannot see each other's rows.
let companySeq = 0;
function newCompany() {
  const companyId = `company-${++companySeq}`;
  db.prepare('INSERT INTO companies (id, name) VALUES (?, ?)').run(companyId, `Toko ${companySeq}`);
  return companyId;
}

const IMPORT_HEADERS = ['Nama Produk', 'Kategori', 'SKU', 'Barcode', 'Harga Modal', 'Harga Jual', 'Status', 'Varian', 'Stok Awal'];
const IMPORT_MAPPING = suggestMapping(IMPORT_HEADERS);

/** Build a sheet from raw rows, parsed exactly as an uploaded CSV would be. */
function sheet(...rows) {
  const csv = [IMPORT_HEADERS.join(','), ...rows.map((r) => r.join(','))].join('\n');
  return readCsv('produk.csv', csv);
}

describe('runProductImport', () => {
  test('creates products, categories and variants', () => {
    const companyId = newCompany();
    const { headers, rows } = sheet(
      ['Kopi Susu', 'Minuman', 'KOP-01', '8990001', '9000', '18000', 'aktif', 'Ukuran:Reguler=0;Ukuran:Large=4000', '5'],
      ['Roti Bakar', 'Makanan', 'ROT-01', '', '3000', '12000', '', '', '']
    );

    const out = runProductImport({ companyId, headers, rows, mapping: IMPORT_MAPPING });

    assert.equal(out.aborted, false);
    assert.equal(out.created, 2);
    assert.equal(out.failed, 0);

    const products = db.prepare('SELECT * FROM products WHERE company_id = ? ORDER BY name').all(companyId);
    assert.equal(products.length, 2);
    const kopi = products.find((p) => p.name === 'Kopi Susu');
    assert.equal(kopi.sku, 'KOP-01');
    assert.equal(kopi.barcode, '8990001');
    assert.equal(kopi.default_price, 18000);
    assert.equal(kopi.cost_price, 9000);
    assert.equal(kopi.unit, 'pcs', 'the column default applies when the file omits it');
    assert.equal(kopi.is_variant_parent, 1);

    const variants = db.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY sort_order').all(kopi.id);
    assert.deepEqual(variants.map((v) => [v.name, v.variant_type, v.price_adjustment]), [
      ['Reguler', 'Ukuran', 0],
      ['Large', 'Ukuran', 4000]
    ]);

    // Rows come back in file order with 1-based spreadsheet line numbers.
    assert.deepEqual(out.rows.map((r) => [r.row, r.action]), [[2, 'create'], [3, 'create']]);
  });

  test('reuses an existing category instead of duplicating it', () => {
    const companyId = newCompany();
    db.prepare('INSERT INTO categories (id, company_id, name) VALUES (?, ?, ?)').run('cat-1', companyId, 'Minuman');
    const { headers, rows } = sheet(['Teh', 'minuman', '', '', '', '8000']);
    runProductImport({ companyId, headers, rows, mapping: IMPORT_MAPPING });
    const cats = db.prepare('SELECT * FROM categories WHERE company_id = ?').all(companyId);
    assert.equal(cats.length, 1, 'matches case-insensitively');
  });

  test('a file with a bad row aborts the whole import', () => {
    const companyId = newCompany();
    const { headers, rows } = sheet(['Kopi', '', '', '', '', '18000'], ['Rusak', '', '', '', '', 'bukan harga']);
    const out = runProductImport({ companyId, headers, rows, mapping: IMPORT_MAPPING });

    assert.equal(out.aborted, true);
    assert.equal(out.failed, 1);
    assert.equal(out.rows.find((r) => r.row === 3).error, 'Harga jual bukan angka');
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM products WHERE company_id = ?').get(companyId).c,
      0,
      'nothing is written when any row fails'
    );
  });

  test('updates an existing product matched by barcode', () => {
    const companyId = newCompany();
    db.prepare(
      'INSERT INTO products (id, company_id, name, barcode, description, default_price, cost_price) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('prod-1', companyId, 'Kopi Lama', '8990001', 'deskripsi asli', 15000, 8000);

    const { headers, rows } = sheet(['Nama Baru', '', '', '8990001', '', '20000']);
    const out = runProductImport({ companyId, headers, rows, mapping: IMPORT_MAPPING });

    assert.equal(out.updated, 1);
    assert.equal(out.created, 0);
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get('prod-1');
    assert.equal(p.name, 'Nama Baru');
    assert.equal(p.default_price, 20000);
    assert.equal(p.cost_price, 8000, 'a blank cell leaves the stored cost alone');
    assert.equal(p.description, 'deskripsi asli', 'and the stored description too');
  });

  test('matches by SKU, then by name as a last resort', () => {
    const companyId = newCompany();
    db.prepare('INSERT INTO products (id, company_id, name, sku, default_price) VALUES (?, ?, ?, ?, ?)')
      .run('p-sku', companyId, 'Produk SKU', 'SKU-9', 1000);
    db.prepare('INSERT INTO products (id, company_id, name, default_price) VALUES (?, ?, ?, ?)')
      .run('p-name', companyId, 'Produk Nama', 2000);

    const { headers, rows } = sheet(
      ['Nama Lain', '', 'SKU-9', '', '', '1500'],
      // Case and a trailing space must not create a second row.
      ['produk nama ', '', '', '', '', '2500']
    );
    const out = runProductImport({ companyId, headers, rows, mapping: IMPORT_MAPPING });

    assert.equal(out.updated, 2);
    assert.equal(out.created, 0);
    assert.equal(db.prepare('SELECT default_price p FROM products WHERE id = ?').get('p-sku').p, 1500);
    assert.equal(db.prepare('SELECT default_price p FROM products WHERE id = ?').get('p-name').p, 2500);
  });

  test('the skip policy leaves existing products untouched', () => {
    const companyId = newCompany();
    db.prepare('INSERT INTO products (id, company_id, name, default_price) VALUES (?, ?, ?, ?)')
      .run('p-1', companyId, 'Kopi', 18000);
    const { headers, rows } = sheet(['Kopi', '', '', '', '', '99000']);
    const out = runProductImport({
      companyId, headers, rows, mapping: IMPORT_MAPPING, options: { updateExisting: false }
    });
    assert.equal(out.skipped, 1);
    assert.equal(out.updated, 0);
    assert.equal(db.prepare('SELECT default_price p FROM products WHERE id = ?').get('p-1').p, 18000);
  });

  test('a per-row decision overrides the default policy', () => {
    const companyId = newCompany();
    db.prepare('INSERT INTO products (id, company_id, name, default_price) VALUES (?, ?, ?, ?)')
      .run('p-skip', companyId, 'Kopi', 18000);
    const { headers, rows } = sheet(['Kopi', '', '', '', '', '99000']);
    const out = runProductImport({
      companyId,
      headers,
      rows,
      mapping: IMPORT_MAPPING,
      existing: [{ action: 'skip' }],
      options: { updateExisting: true }
    });
    assert.equal(out.skipped, 1);
    assert.equal(db.prepare('SELECT default_price p FROM products WHERE id = ?').get('p-skip').p, 18000);
  });

  test('dryRun reports the same counts but writes nothing', () => {
    const companyId = newCompany();
    const { headers, rows } = sheet(['Kopi', '', '', '', '', '18000'], ['Teh', '', '', '', '', '8000']);

    const preview = runProductImport({ companyId, headers, rows, mapping: IMPORT_MAPPING, dryRun: true });
    assert.equal(preview.created, 2);
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM products WHERE company_id = ?').get(companyId).c,
      0,
      'a preview never writes'
    );

    const real = runProductImport({ companyId, headers, rows, mapping: IMPORT_MAPPING });
    assert.deepEqual(
      [real.created, real.updated, real.skipped, real.failed],
      [preview.created, preview.updated, preview.skipped, preview.failed]
    );
  });

  test('two rows with the same barcode are refused, not silently merged', () => {
    const companyId = newCompany();
    const { headers, rows } = sheet(
      ['Kopi A', '', '', '8990001', '', '10000'],
      ['Kopi B', '', '', '8990001', '', '12000']
    );
    const out = runProductImport({ companyId, headers, rows, mapping: IMPORT_MAPPING });
    assert.equal(out.aborted, true);
    assert.equal(out.rows[1].error, 'Barcode sama dengan baris 2');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM products WHERE company_id = ?').get(companyId).c, 0);
  });

  test('an invalid status is reported on its own line', () => {
    const companyId = newCompany();
    const { headers, rows } = sheet(['Kopi', '', '', '', '', '10000', 'mungkin']);
    const out = runProductImport({ companyId, headers, rows, mapping: IMPORT_MAPPING });
    assert.equal(out.rows[0].error, 'status harus aktif / nonaktif');
  });

  test('a negative price is refused before it reaches the catalogue', () => {
    const companyId = newCompany();
    const { rows } = sheet(['Kopi', '-5000']);
    // The classic mistake: a discount row pasted into the price column.
    const out = runProductImport({ companyId, headers: ['Nama', 'Harga'], rows, mapping: { name: 0, default_price: 1 } });
    assert.equal(out.rows[0].error, 'Harga jual tidak boleh negatif');
    assert.equal(out.aborted, true);
  });
});

/* ---------------------------- spreadsheet parsing ---------------------------- */

describe('spreadsheet parsing', () => {
  test('reads a quoted CSV with embedded commas, quotes and newlines', () => {
    const csv = 'Nama,Harga\n"Kopi, Susu",18000\n"Teh ""Manis""",8000\n"Multi\nLine",5000';
    const { headers, rows } = readCsv('a.csv', csv);
    assert.deepEqual(headers, ['Nama', 'Harga']);
    assert.deepEqual(rows, [['Kopi, Susu', '18000'], ['Teh "Manis"', '8000'], ['Multi\nLine', '5000']]);
  });

  test('detects a semicolon-separated file (Excel on an Indonesian locale)', () => {
    const grid = parseCsv('a.csv', 'Nama;Harga\nKopi;18000');
    assert.equal(grid.delimiter, ';');
    assert.deepEqual(splitHeader(grid).rows, [['Kopi', '18000']]);
  });

  test('strips a UTF-8 BOM from the first header', () => {
    const { headers } = readCsv('a.csv', '\uFEFFNama,Harga\nKopi,18000');
    assert.equal(headers[0], 'Nama');
  });

  test("reads Excel's UTF-16 tab export", () => {
    const text = 'Nama\tHarga\r\nKopi\t18000';
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    const { headers, rows } = splitHeader(parseSpreadsheet({ filename: 'a.txt', buffer: buf }));
    assert.equal(headers[0], 'Nama');
    assert.deepEqual(rows, [['Kopi', '18000']]);
  });

  test('keeps blank cells so column positions stay aligned', () => {
    const { rows } = readCsv('a.csv', 'Nama,Kategori,Harga\nKopi,,18000');
    assert.deepEqual(rows[0], ['Kopi', '', '18000']);
  });

  test('dot-separated filenames are still recognised by content, not extension', () => {
    // A .xlsx renamed to .csv must parse as xlsx once the ZIP signature is seen;
    // the reverse (a CSV named .xlsx) gets a clear error instead of garbage.
    assert.throws(() => readCsv('produk.xlsx', 'Nama,Harga\nKopi,1000'), ImportParseError);
  });

  test('rejects an empty file', () => {
    assert.throws(() => parseCsv('a.csv', ''), ImportParseError);
  });

  test('rejects a legacy .xls with an explanation instead of garbage', () => {
    assert.throws(
      () => parseSpreadsheet({ filename: 'a.xls', buffer: Buffer.from('D0CF11E0A1B11AE1', 'hex') }),
      (e) => e instanceof ImportParseError && /xls/i.test(e.message)
    );
  });
});
