// Column mapping, value normalisation and conflict handling for the product
// import — the part that turns "whatever the shop's spreadsheet looks like" into
// rows the products table accepts.
//
// Three jobs, deliberately separated from the route so they can be unit tested
// without a server:
//
//   1. suggestMapping()  — guess which column is which from its header text.
//   2. applyRow()        — turn one mapped row into an insert/update decision,
//                          or into a list of human-readable problems.
//   3. runProductImport()— resolve conflicts against the existing catalogue and
//                          write everything in one transaction.

import { db } from '../db.js';
import { id } from './helpers.js';
import { PRODUCT_IMPORT_FIELDS } from './productImportColumns.js';

export { PRODUCT_IMPORT_FIELDS };

/** Normalise a header for fuzzy comparison: lowercase, no punctuation, single spaces. */
export function normalizeHeader(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)/g, ' ') // "Harga Jual (Rp)" → "harga jual"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Guess the field for one header.
 *
 * Two passes so a precise header always beats a loose one regardless of column
 * order: first an exact match against a label/alias, then a whole-word match.
 * Matching is "the field's name appears as a word sequence in the header", not
 * the reverse — otherwise "Harga Modal" would claim "Harga Jual" because both
 * contain "harga".
 */
export function matchHeader(header) {
  const h = normalizeHeader(header);
  if (!h) return null;
  const exact = PRODUCT_IMPORT_FIELDS.find((f) =>
    [f.label, ...f.aliases].some((c) => normalizeHeader(c) === h)
  );
  if (exact) return exact.key;
  const words = h.split(' ');
  let best = null;
  let bestScore = 0;
  for (const f of PRODUCT_IMPORT_FIELDS) {
    for (const candidate of [f.label, ...f.aliases]) {
      const cw = normalizeHeader(candidate).split(' ').filter(Boolean);
      if (!cw.length || !cw.every((w) => words.includes(w))) continue;
      // Longer candidate = more specific field, e.g. "harga jual" over "harga".
      if (cw.length > bestScore) {
        bestScore = cw.length;
        best = f.key;
      }
    }
  }
  return best;
}

/**
 * Suggest a `{ field: columnIndex }` mapping for the given header row.
 *
 * A column is claimed at most once, and the first column wins ties so the primary
 * "Harga Jual" column is not shadowed by a later duplicate header — which is what
 * Excel produces when two people append price columns to the same file.
 */
export function suggestMapping(headers) {
  const mapping = {};
  const taken = new Set();
  headers.forEach((header, index) => {
    const key = matchHeader(header);
    if (!key || taken.has(key)) return;
    taken.add(key);
    mapping[key] = index;
  });
  return mapping;
}

/* --------------------------- value normalisation --------------------------- */

/**
 * Parse a number the way Excel and a human write one.
 *
 * The hard case is `18.000`: Indonesian uses `.` as the thousands separator, but
 * a spreadsheet exported in English uses it as the decimal point. Guessing wrong
 * is a 1000× pricing error, so the rule is explicit:
 *
 *   - both `,` and `.` present → the LAST one is the decimal separator
 *   - only `,` → decimal separator when followed by 1-2 digits, else thousands
 *   - only `.` → thousands separator when it splits the digits into even groups of
 *     three (1.234.567 / 18.000), otherwise a decimal point (18.5 / 0.75)
 *
 * Returns `{ value }` (null for a blank cell) or `{ error }`.
 */
export function parseNumber(raw, { percent = false } = {}) {
  if (raw === null || raw === undefined) return { value: null };
  let s = String(raw).trim();
  if (!s) return { value: null };
  const isPercent = percent && s.endsWith('%');
  s = s
    .replace(/%/g, '')
    .replace(/\b(rp|idr|usd|sgd|myr)\b\.?/gi, '')
    .replace(/[^\d.,\-+]/g, '')
    .trim();
  if (!s || !/\d/.test(s)) return { error: 'bukan angka' };

  const negative = s.startsWith('-') || s.endsWith('-');
  s = s.replace(/[-+]/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma >= 0 && lastDot >= 0) {
    // Both separators present: whichever comes last is the decimal point.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const decimals = s.length - lastComma - 1;
    s = decimals > 0 && decimals <= 2 ? s.replace(/,/g, '.') : s.replace(/,/g, '');
  } else if (lastDot >= 0) {
    const groups = s.split('.');
    const thousands = groups.length > 1 && groups.slice(1).every((g) => g.length === 3);
    if (thousands) s = groups.join('');
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return { error: 'bukan angka' };
  const value = Math.round((negative ? -n : n) * 100) / 100;
  return { value: isPercent ? value / 100 : value };
}

const ACTIVE_WORDS = new Set(['1', 'true', 'ya', 'yes', 'y', 'aktif', 'active', 'on']);
const INACTIVE_WORDS = new Set(['0', 'false', 'tidak', 'no', 'n', 'nonaktif', 'inactive', 'off', 'arsip', 'draft']);

/** `aktif` / `1` / `yes` → 1; `nonaktif` / `0` / `no` → 0; blank → null (leave as is). */
export function parseActive(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return { value: null };
  if (ACTIVE_WORDS.has(s)) return { value: 1 };
  if (INACTIVE_WORDS.has(s)) return { value: 0 };
  return { error: 'status harus aktif / nonaktif' };
}

/**
 * Parse the `Varian` cell.
 *
 * Format: `Jenis:Nama=SelisihHarga` groups separated by `;` or `|`, where both
 * the type and the price are optional — `Large=4000;Medium=2000` or
 * `Ukuran:Large=4000`. A leading `*` marks the default variant. The format is
 * shown on the template's second sheet because it is the one column people get
 * wrong.
 */
export function parseVariants(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { value: [] };
  const variants = [];
  for (const part of s.split(/[;|]/)) {
    const chunk = part.trim();
    if (!chunk) continue;
    const [head, pricePart] = chunk.split('=');
    const isDefault = head.trim().startsWith('*');
    const body = head.replace(/^\*/, '').trim();
    if (!body) return { error: `varian "${chunk}" tidak valid` };
    const colon = body.indexOf(':');
    const type = colon >= 0 ? body.slice(0, colon).trim() || 'Option' : 'Option';
    const name = colon >= 0 ? body.slice(colon + 1).trim() : body;
    if (!name) return { error: `nama varian kosong pada "${chunk}"` };
    const price = pricePart === undefined || pricePart.trim() === '' ? { value: 0 } : parseNumber(pricePart);
    if (price.error) return { error: `selisih harga varian "${name}" bukan angka` };
    variants.push({
      name,
      variant_type: type,
      price_adjustment: Number(price.value) || 0,
      is_default: isDefault ? 1 : 0,
    });
  }
  return { value: variants };
}

/* ------------------------------ one row ------------------------------ */

/** Read the cell mapped to `key` from a row, or '' when the field is unmapped. */
function cell(row, mapping, key) {
  const index = mapping[key];
  if (index === undefined || index === null || index < 0) return '';
  return row[index] === undefined || row[index] === null ? '' : String(row[index]).trim();
}

/**
 * Turn one spreadsheet row into a product body — the same shape `POST /products`
 * and `PUT /products/:id` accept, so imported rows go through identical column
 * semantics as hand-typed ones.
 *
 * `partial` is set when updating an existing product: an empty cell then means
 * "leave this field alone" rather than "clear it", which is what an update file
 * that only carries prices is supposed to do.
 *
 * Returns `{ product, variants, stock, error }`.
 */
export function applyRow(row, mapping, { partial = false } = {}) {
  const name = cell(row, mapping, 'name');
  if (!name) return { error: 'Nama produk kosong' };

  const price = parseNumber(cell(row, mapping, 'default_price'));
  if (price.error) return { error: 'Harga jual bukan angka' };
  if (price.value === null && !partial) return { error: 'Harga jual kosong' };

  // A negative price cannot be a typo worth guessing at — it would break margin
  // reporting and let a sale return money to the customer.
  if (price.value !== null && price.value < 0) return { error: 'Harga jual tidak boleh negatif' };

  const cost = parseNumber(cell(row, mapping, 'cost_price'));
  if (cost.error) return { error: 'Harga modal bukan angka' };

  const stock = parseNumber(cell(row, mapping, 'stock'));
  if (stock.error) return { error: 'Stok awal bukan angka' };

  const active = parseActive(cell(row, mapping, 'is_active'));
  if (active.error) return { error: active.error };

  const variants = parseVariants(cell(row, mapping, 'variants'));
  if (variants.error) return { error: variants.error };

  // On a partial (update) parse a blank cell means "leave this column alone", so
  // it maps to `undefined` — the sentinel `updateProduct` skips. An explicitly
  // cleared cell is indistinguishable from an omitted one in a spreadsheet, and
  // keeping the old value is far safer than wiping a description the shop typed.
  const text = (key) => {
    const value = cell(row, mapping, key);
    if (value !== '') return value;
    return partial ? undefined : null;
  };

  return {
    product: {
      name,
      category: text('category'),
      sku: text('sku'),
      barcode: text('barcode'),
      unit: text('unit'),
      brand: text('brand'),
      description: text('description'),
      // `undefined` keeps the existing value on update; null/0 sets it.
      cost_price: cost.value === null ? (partial ? undefined : 0) : cost.value,
      default_price: price.value === null ? undefined : price.value,
      is_active: active.value === null ? (partial ? undefined : 1) : active.value
    },
    variants: variants.value,
    stock: stock.value
  };
}

/* ------------------------- conflicts + writing ------------------------- */

/**
 * Decide what an imported row does to the catalogue.
 *
 * Matching order is barcode → SKU → name, because that is the order that goes
 * from "unambiguous" to "the user typed the same product name twice": a barcode
 * identifies a physical item, a SKU is the shop's own code, and a name is only
 * unique by convention. Names compare case-insensitively on the trimmed value so
 * `Kopi Susu` and `kopi susu ` do not become two rows.
 *
 * Mirrors the matching `runProductImport` uses, so the preview's "update/skip"
 * badges always agree with what the apply call does.
 */
export function findExisting(companyId, product, indexes) {
  const { byBarcode, bySku, byName } = indexes;
  if (product.barcode && byBarcode.has(product.barcode)) return byBarcode.get(product.barcode);
  if (product.sku && bySku.has(product.sku)) return bySku.get(product.sku);
  if (product.name && byName.has(product.name.toLowerCase())) return byName.get(product.name.toLowerCase());
  return null;
}

/** Load the catalogue once so per-row conflict checks are O(1) instead of a query per row. */
export function loadProductIndexes(companyId) {
  const rows = db
    .prepare(
      `SELECT id, name, sku, barcode, category_id, unit, cost_price, default_price, description, is_active
       FROM products WHERE company_id = ?`
    )
    .all(companyId);
  const byBarcode = new Map();
  const bySku = new Map();
  const byName = new Map();
  for (const r of rows) {
    if (r.barcode) byBarcode.set(String(r.barcode), r);
    if (r.sku) bySku.set(String(r.sku), r);
    // The list is ordered by insertion; first wins so the oldest row keeps the name.
    const key = String(r.name || '').trim().toLowerCase();
    if (key && !byName.has(key)) byName.set(key, r);
  }
  return { all: rows, byBarcode, bySku, byName };
}

/** Resolve a category name to an id, creating it when `createMissing` is on. */
export function resolveCategory(companyId, name, cache, createMissing) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const key = clean.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  const found = db
    .prepare('SELECT id FROM categories WHERE company_id = ? AND lower(name) = ?')
    .get(companyId, key);
  if (found) {
    cache.set(key, found.id);
    return found.id;
  }
  if (!createMissing) return null;
  const cid = id();
  db.prepare('INSERT INTO categories (id, company_id, name) VALUES (?, ?, ?)').run(cid, companyId, clean);
  cache.set(key, cid);
  return cid;
}

/* -------------------------------- writing -------------------------------- */

function insertVariants(productId, companyId, variants) {
  const stmt = db.prepare(
    `INSERT INTO product_variants (id, company_id, product_id, name, variant_type, price_adjustment, is_default, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  variants.forEach((v, i) => {
    stmt.run(id(), companyId, productId, v.name, v.variant_type || 'option', Number(v.price_adjustment) || 0,
      v.is_default ? 1 : 0, i);
  });
}

/** Raise a product's stock in one branch to `quantity` (never lowers it). */
function ensureStock(branchId, productId, quantity) {
  const current = db
    .prepare('SELECT id, quantity FROM branch_stocks WHERE branch_id = ? AND product_id = ?')
    .get(branchId, productId);
  if (!current) {
    db.prepare(
      'INSERT INTO branch_stocks (id, branch_id, product_id, quantity, low_stock_threshold) VALUES (?, ?, ?, ?, 5)'
    ).run(id(), branchId, productId, quantity);
    return;
  }
  const delta = quantity - Number(current.quantity || 0);
  if (delta > 0) {
    db.prepare("UPDATE branch_stocks SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?")
      .run(delta, current.id);
  }
}

/** Insert a new product row + its variants + optional opening stock. */
function createProduct(companyId, p, categoryId, variants, branchId, stock) {
  const productId = id();
  db.prepare(
    `INSERT INTO products (id, company_id, category_id, name, sku, barcode, description, image_url, unit,
       cost_price, default_price, is_active, brand, is_variant_parent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(productId, companyId, categoryId, p.name, p.sku, p.barcode, p.description, null,
    p.unit || 'pcs', p.cost_price || 0, p.default_price || 0, p.is_active === undefined ? 1 : p.is_active,
    p.brand || null, variants.length ? 1 : 0);
  insertVariants(productId, companyId, variants);
  if (branchId && stock > 0) ensureStock(branchId, productId, stock);
  return productId;
}

/**
 * Update an existing product, touching only the columns the file actually
 * supplied. A blank cell must not wipe a description that was typed in the UI,
 * which is why this builds the SET list instead of reusing the NULL-skipping
 * COALESCE UPDATE from the hand-edit endpoint (that one cannot *clear* a field).
 */
function updateProduct(companyId, existingId, p, categoryId, variants, branchId, stock) {
  const sets = [];
  const params = [];
  const put = (column, value) => {
    if (value === undefined) return;
    sets.push(`${column} = ?`);
    params.push(value);
  };
  put('name', p.name || undefined);
  put('category_id', categoryId);
  put('sku', p.sku);
  put('barcode', p.barcode);
  put('description', p.description);
  put('unit', p.unit);
  put('brand', p.brand);
  put('cost_price', p.cost_price);
  put('default_price', p.default_price);
  put('is_active', p.is_active);
  if (sets.length) {
    params.push(existingId);
    db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }
  if (variants.length) {
    db.prepare('DELETE FROM product_variants WHERE product_id = ?').run(existingId);
    insertVariants(existingId, companyId, variants);
    // Variants now exist, so the kitchen/KDS treats this as a variant parent.
    db.prepare('UPDATE products SET is_variant_parent = 1 WHERE id = ?').run(existingId);
  }
  if (branchId && stock > 0) ensureStock(branchId, existingId, stock);
}

/** Which columns the mapping actually supplies — used to explain skipped updates. */
export function mappedKeys(mapping) {
  return Object.entries(mapping || {})
    .filter(([, index]) => Number.isInteger(index) && index >= 0)
    .map(([key]) => key);
}

/**
 * Work out what every row would do, without writing anything.
 *
 * This is the single source of truth for both the preview endpoint and the apply
 * endpoint (which runs it again), so the "12 baru / 3 update" a user sees before
 * clicking Import is exactly what the import will do — even if another till
 * changed the catalogue in between.
 *
 * Per-row outcome:
 *   - `error`  — the row cannot be imported (named reason)
 *   - `skip`   — matched an existing product and the operator chose to skip it
 *   - `update` — matched an existing product and will be overwritten
 *   - `create` — new product
 */
export function computeImportPlan({ companyId, rows = [], mapping = {}, existing: decisions = [], options = {} }) {
  const { updateExisting = true } = options;
  const indexes = loadProductIndexes(companyId);
  const seenBarcode = new Map();
  const seenSku = new Map();
  const plan = [];
  const summary = { created: 0, updated: 0, skipped: 0, failed: 0 };

  const finish = (entry) => {
    plan.push(entry);
    if (entry.action === 'create') summary.created++;
    else if (entry.action === 'update') summary.updated++;
    else if (entry.action === 'skip') summary.skipped++;
    else summary.failed++;
  };

  rows.forEach((row, i) => {
    // Spreadsheet line number: +1 because rows are 0-based here, +1 for the header
    // line the UI already dropped, so errors quote the line Excel shows.
    const rowNumber = i + 2;
    const decision = decisions[i];
    const name = String(row[mapping.name] ?? '').trim();
    const base = { row: rowNumber, name, match: null, product: null, variants: [], stock: null };

    if (decision && decision.action === 'skip') {
      finish({ ...base, action: 'skip', error: null });
      return;
    }

    const forced = decision && (decision.action === 'update' || decision.action === 'create') ? decision.action : null;

    // First parse without `partial` so the row always has a name/barcode/SKU to
    // match on. The partial re-parse only happens once we know the row is an
    // update — otherwise a "price only" update file would report "Harga jual
    // kosong" on every row before the match is even attempted.
    const parsed = applyRow(row, mapping, { partial: forced === 'update' });
    if (parsed.error && forced !== 'update') {
      finish({ ...base, action: 'error', error: parsed.error });
      return;
    }

    const match = forced === 'create' ? null : findExisting(companyId, parsed.product, indexes);
    if (match && !updateExisting && !forced) {
      finish({ ...base, action: 'skip', error: null, match: match.id });
      return;
    }

    const action = forced || (match ? 'update' : 'create');
    // "Always create" must still create something new: reusing an existing row's
    // barcode/SKU would violate the unique index mid-transaction. Clear those two
    // fields on the copy so the operator gets a second product, not a stack trace.
    if (action === 'create' && match) {
      delete parsed.product.barcode;
      delete parsed.product.sku;
    }
    // An update may legitimately omit the price; a create may not. Re-parse with
    // `partial` so an update's blank cells stay "leave unchanged" (undefined)
    // instead of being written back as a zero.
    const final = action === 'update' ? applyRow(row, mapping, { partial: true }) : parsed;
    if (final.error) {
      finish({ ...base, action: 'error', error: final.error });
      return;
    }

    // Two rows carrying the same barcode/SKU would either create duplicates or make
    // the second silently overwrite the first. Flag the later row instead.
    const barcode = final.product.barcode;
    const sku = final.product.sku;
    if (barcode && seenBarcode.has(barcode)) {
      finish({ ...base, action: 'error', error: `Barcode sama dengan baris ${seenBarcode.get(barcode)}` });
      return;
    }
    if (sku && seenSku.has(sku)) {
      finish({ ...base, action: 'error', error: `SKU sama dengan baris ${seenSku.get(sku)}` });
      return;
    }
    if (barcode) seenBarcode.set(barcode, rowNumber);
    if (sku) seenSku.set(sku, rowNumber);

    finish({
      ...base,
      action,
      error: null,
      match: match ? match.id : null,
      product: final.product,
      variants: final.variants,
      stock: final.stock
    });
  });

  return { plan, summary };
}

/** Strip the internal fields the browser has no business seeing. */
function publicRows(plan) {
  return plan.map(({ row, action, name, error }) => ({ row, action, name, error }));
}

/**
 * Apply a mapped import.
 *
 * `dryRun` returns the plan and its counts without touching the database; the
 * preview endpoint uses it so preview and apply can never disagree about what a
 * row means.
 *
 * A real run is one transaction: either every valid row lands or none does. A
 * half-imported price list is worse than a rejected one because the operator
 * cannot tell which rows applied, so a single bad row aborts the whole file and
 * the failure is reported with its spreadsheet line number.
 */
export function runProductImport({ companyId, rows = [], mapping = {}, existing = [], options = {}, dryRun = false }) {
  const { createMissingCategories = true, branchId = null } = options;
  const { plan, summary } = computeImportPlan({ companyId, rows, mapping, existing, options });

  if (dryRun) return { dryRun: true, ...summary, rows: publicRows(plan), aborted: false };
  if (summary.failed) return { dryRun: false, ...summary, rows: publicRows(plan), aborted: true };

  const categoryCache = new Map();
  db.transaction(() => {
    for (const item of plan) {
      if (item.action !== 'create' && item.action !== 'update') continue;
      const categoryId = resolveCategory(companyId, item.product.category, categoryCache, createMissingCategories);
      if (item.action === 'create') {
        createProduct(companyId, item.product, categoryId, item.variants, branchId, item.stock);
      } else {
        updateProduct(companyId, item.match, item.product, categoryId, item.variants, branchId, item.stock);
      }
    }
  })();

  return { dryRun: false, ...summary, rows: publicRows(plan), aborted: false };
}
