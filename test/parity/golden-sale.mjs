// Golden-sale parity check: Node edge vs Rust edge.
//
// One scripted scenario — register, catalogue, branch price override, stock,
// a sale with a variant line, an item discount, a cart discount, tax, cash
// tender, a kitchen ticket and an outbox row — is replayed against the Node edge
// and the Rust edge on separate temp databases. Then both SQLite files and both
// sets of HTTP responses are compared field by field.
//
// This is the L4 exit check from `PARITY_PLAN.md`: the two implementations must
// agree on money, stock, kitchen and sync state, not merely on status codes.
// Volatile values (row ids, generated transaction codes, wall-clock "now",
// the client IP, bcrypt salts) are normalized to placeholders — but only their
// value: an id must still look like an id, a timestamp must still be a UTC
// timestamp, a hash must still carry the same bcrypt cost. Money, stock, ticket
// and outbox state must match exactly.
//
// Usage, from anywhere:
//   cargo build --manifest-path frontend/src-tauri/pos-edge/Cargo.toml
//   node backend/test/parity/golden-sale.mjs      # or: cd backend && npm run parity:golden
//
// Exits 0 when every table and response matches, 1 otherwise (printing the
// mismatching tables side by side and keeping both databases for inspection).

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Database from 'better-sqlite3';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..', '..', '..');
const NODE_SERVER = path.join(ROOT, 'backend', 'src', 'server.js');
const RUST_BIN =
  process.env.RUST_EDGE_BIN ||
  path.join(ROOT, 'frontend', 'src-tauri', 'pos-edge', 'target', 'debug', 'pos-edge');

const BOOT_TIMEOUT_MS = 20_000;
const SECRET = 'parity-secret';

// The fixture itself. Deliberately Indonesian, deliberately mixed: a variant
// line, an item discount, a cart discount, tax, and a line whose price comes from
// a branch override rather than `products.default_price`.
const COMPANY = { company_name: 'Toko Uji', name: 'Sari', email: 'owner@uji.id', password: 'rahasia123' };
const CLIENT_UUID = 'golden-sale-0001';
const SALE_AT = '2026-01-02T03:04:05.000Z';

function tempDir(tag) {
  return mkdtempSync(path.join(tmpdir(), `pos-parity-${tag}-`));
}

/** Ask the OS for a free loopback port (same trick as test/harness.mjs). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, label, child) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let output = '';
  child.stdout.on('data', (b) => (output += String(b)));
  child.stderr.on('data', (b) => (output += String(b)));
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited during startup (code ${child.exitCode})\n${output}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`${label} not healthy after ${BOOT_TIMEOUT_MS}ms\n${output}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Boot one server (Node or Rust) on its own port and empty data directory.
 * Both honour the same contract: `EDGE_MODE=1`, `PORT`, `DB_DIR`, `EDGE_JWT_SECRET`.
 */
async function startServer({ label, command, args, cwd }) {
  const dataDir = tempDir(label);
  const port = await freePort();
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      EDGE_MODE: '1',
      PORT: String(port),
      DB_DIR: dataDir,
      EDGE_JWT_SECRET: SECRET,
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl, label, child);
  } catch (e) {
    child.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
    throw e;
  }
  const stop = async () => {
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3_000).unref();
      });
    }
  };
  return { baseUrl, dataDir, dbPath: path.join(dataDir, 'pos.db'), stop };
}

/** Minimal JSON client: throws on any non-2xx so a fixture slip is never silent. */
function apiFor(baseUrl) {
  return async function call(method, uri, { token, body } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(baseUrl + uri, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${uri} → ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
}

/* ------------------------------- SCENARIO ------------------------------ */

/**
 * Drive one server through the fixture and return the raw HTTP responses.
 * The sale body is identical for both servers except for the ids the server
 * itself minted, which is what makes the comparison meaningful.
 */
async function runScenario(baseUrl) {
  const api = apiFor(baseUrl);
  const reg = await api('POST', '/api/auth/register', { body: COMPANY });
  const token = reg.token;
  const branchId = reg.user.branch_id;
  if (!token || !branchId) throw new Error(`register returned no token/branch: ${JSON.stringify(reg)}`);

  const drinks = await api('POST', '/api/categories', { token, body: { name: 'Minuman' } });
  const food = await api('POST', '/api/categories', { token, body: { name: 'Makanan' } });

  const createProduct = (body) => api('POST', '/api/products', { token, body });

  const kopi = await createProduct({
    name: 'Kopi Susu',
    sku: 'KOPI-01',
    unit: 'cup',
    cost_price: 7000,
    default_price: 18000,
    category_id: drinks.id,
    variants: [
      { name: 'Regular', price_adjustment: 0, is_default: true },
      { name: 'Large', price_adjustment: 3000 },
    ],
  });
  const roti = await createProduct({
    name: 'Roti Bakar',
    sku: 'ROTI-01',
    cost_price: 5000,
    default_price: 12000,
    category_id: food.id,
  });
  // No category on purpose: an uncategorised line is "retail", so it must not
  // reach the kitchen ticket (`isPreparedItem` keys off `category_id`).
  const teh = await createProduct({
    name: 'Teh Manis',
    sku: 'TEH-01',
    cost_price: 2500,
    default_price: 8000,
  });
  const esKopi = await createProduct({
    name: 'Es Kopi Susu',
    sku: 'ESKOPI-01',
    cost_price: 9000,
    default_price: 20000,
    category_id: drinks.id,
  });

  // The variant id is only known after the create, and the endpoint echoes the
  // product row without its variants — so read it back, as the till does.
  const kopiFull = await api('GET', `/api/products/${kopi.id}`, { token });
  const large = kopiFull.variants.find((v) => v.name === 'Large');
  if (!large) throw new Error('Large variant missing from product read-back');

  // Branch price override: Teh Manis sells for 8500 here, not the catalogue 8000.
  await api('PUT', `/api/branches/${branchId}/products/${teh.id}`, {
    token,
    body: { price_override: 8500 },
  });

  for (const p of [kopi, roti, teh, esKopi]) {
    await api('POST', `/api/branches/${branchId}/stock/adjust`, {
      token,
      body: { product_id: p.id, quantity: 30, type: 'set' },
    });
  }

  const saleBody = {
    branch_id: branchId,
    client_uuid: CLIENT_UUID,
    created_at: SALE_AT,
    items: [
      { product_id: kopi.id, variant_id: large.id, quantity: 2 },
      { product_id: esKopi.id, quantity: 1 },
      { product_id: roti.id, quantity: 1, discount: 500 },
      { product_id: teh.id, quantity: 3 },
    ],
    discount: 2000,
    tax_percent: 11,
    payment_method: 'cash',
    cash_received: 120000,
    note: 'Meja 4 - tanpa gula',
    order_label: 'A-1',
    table_number: '4',
    customer_name: 'Budi',
  };

  const sale = await api('POST', '/api/transactions', { token, body: saleBody });
  // Idempotency: the very same client_uuid must be recognised, not rung up twice.
  const replay = await api('POST', '/api/transactions', { token, body: saleBody });
  const fetched = await api('GET', `/api/transactions/${sale.id}`, { token });
  const list = await api('GET', `/api/transactions?branch_id=${branchId}`, { token });
  const stock = await api('GET', `/api/branches/${branchId}/stock`, { token });
  const catalog = await api('GET', `/api/branches/${branchId}/catalog`, { token });
  const low = await api('GET', '/api/stock/low', { token });

  return { sale, replay, fetched, list, stock, catalog, low, branchId };
}


/* ----------------------------- NORMALIZERS ----------------------------- */

// SQLite's `datetime('now')` (`YYYY-MM-DD HH:MM:SS`) and the API's ISO UTC
// (`YYYY-MM-DDTHH:MM:SSZ`, with or without millis) — the receipt/stamp formats.
const TS_SQL = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?$/;
const CODE = /^[A-Z0-9-]{6,}$/; // TRX-…; receipt_number mirrors code
const ID = /^[0-9a-f]{32}$/;

/** A timestamp we do not pin (a "now" default): compare shape, not value. */
const ts = (v) => (v == null ? null : TS_SQL.test(v) ? '<timestamp>' : `NOT-A-TIMESTAMP:${v}`);
/** A generated sale code: shape only, it embeds Date.now(). */
const code = (v) => (v == null ? null : CODE.test(v) ? '<code>' : `NOT-A-CODE:${v}`);
/** bcrypt output: the salt and digest differ per row, the cost must not. */
const hash = (v) => {
  if (v == null) return null;
  const m = /^\$2([aby])\$(\d{2})\$[./A-Za-z0-9]{53}$/.exec(v);
  return m ? `<bcrypt cost=${m[2]}>` : `NOT-A-HASH:${v}`;
};

/**
 * Recursively sort object keys.
 *
 * Used where the two stacks legitimately disagree on key order but not on
 * meaning: a JS object keeps insertion order, `serde_json`'s map is sorted, so the
 * bytes of a re-serialized payload differ while the data is identical.
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

/** Deep scrub for JSON where only the shape of ids/volatile fields matters. */
const VOLATILE_KEYS = new Set([
  'id', 'company_id', 'branch_id', 'product_id', 'category_id', 'variant_id', 'user_id',
  'transaction_id', 'queue_id', 'hold_order_id', 'entity_id', 'parent_item_id', 'device_id',
  'created_at', 'updated_at', 'opened_at', 'closed_at', 'started_at', 'ready_at', 'completed_at',
  'voided_at', 'last_login_at', 'created_by', 'started_by', 'ready_by', 'closed_by', 'client_uuid',
]);

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_KEYS.has(key)) out[key] = value[key] == null ? null : '<id>';
      else out[key] = scrub(value[key]);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (ID.test(value)) return '<id>';
    if (TS_SQL.test(value)) return '<timestamp>';
    if (value.startsWith('TRX-')) return '<code>';
    return value;
  }
  return value;
}

/** One transaction line, as both the row and the API present it. */
function normItem(it) {
  return {
    product_name: it.product_name,
    variant_label: it.variant_label ?? null,
    price: it.price,
    cost_price: it.cost_price ?? null,
    quantity: it.quantity,
    discount: it.discount ?? 0,
    subtotal: it.subtotal,
    note: it.note ?? null,
    is_prepared: it.is_prepared ?? null,
  };
}

/** A transaction as `getTransaction` returns it (sale, replay and GET :id). */
function normTx(t) {
  return {
    duplicate: t.duplicate ?? null,
    code: code(t.code),
    receipt_number: code(t.receipt_number),
    subtotal: t.subtotal,
    discount: t.discount,
    tax: t.tax,
    tax_percent: t.tax_percent ?? null,
    total: t.total,
    payment_method: t.payment_method,
    payment_detail: t.payment_detail ?? null,
    payments: t.payments ?? null,
    cash_received: t.cash_received,
    change_due: t.change_due,
    status: t.status,
    note: t.note ?? null,
    order_label: t.order_label ?? null,
    table_number: t.table_number ?? null,
    customer_name: t.customer_name ?? null,
    synced_from_offline: t.synced_from_offline ?? null,
    device_id: t.device_id ?? null,
    branch_name: t.branch_name ?? null,
    cashier_name: t.cashier_name ?? null,
    // Stamped at checkout ("now"): compared by shape here and by recency in
    // `checkInvariants`, because the two servers run seconds apart.
    created_at: ts(t.created_at),
    client_uuid: t.client_uuid ?? null,
    items: (t.items || []).map(normItem),
  };
}

/** A row of `GET /transactions` (the list projection, stamped to ISO). */
function normListRow(t) {
  return {
    code: code(t.code),
    receipt_number: code(t.receipt_number),
    subtotal: t.subtotal,
    discount: t.discount,
    tax: t.tax,
    tax_percent: t.tax_percent ?? null,
    total: t.total,
    payment_method: t.payment_method,
    cash_received: t.cash_received,
    change_due: t.change_due,
    status: t.status,
    item_count: t.item_count,
    branch_name: t.branch_name,
    cashier_name: t.cashier_name,
    created_at: ts(t.created_at),
  };
}


/* ------------------------------ DB DUMPING ----------------------------- */

/** Read every table the sale touches and rewrite ids/timestamps into stable labels. */
function normalizeTables(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const all = (sql) => db.prepare(sql).all();
  const branchName = new Map(all('SELECT id, name FROM branches').map((r) => [r.id, r.name]));
  const userName = new Map(all('SELECT id, name FROM users').map((r) => [r.id, r.name]));
  const productName = new Map(all('SELECT id, name FROM products').map((r) => [r.id, r.name]));
  const variantName = new Map(all('SELECT id, name FROM product_variants').map((r) => [r.id, r.name]));
  const categoryName = new Map(all('SELECT id, name FROM categories').map((r) => [r.id, r.name]));
  const txOrder = new Map(all('SELECT id FROM transactions ORDER BY rowid').map((r, i) => [r.id, `tx#${i + 1}`]));
  const queueOrder = new Map(all('SELECT id FROM order_queue ORDER BY rowid').map((r, i) => [r.id, `queue#${i + 1}`]));
  const name = (map, id) => (id == null ? null : map.get(id) ?? `unknown:${id}`);
  const byJson = (rows) => rows.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

  const tables = {};

  tables.companies = byJson(
    all('SELECT * FROM companies').map((r) => ({
      name: r.name,
      currency: r.currency ?? null,
      timezone: r.timezone ?? null,
      tax_percent: r.tax_percent ?? null,
      plan: r.plan ?? null,
    }))
  );

  tables.branches = byJson(
    all('SELECT * FROM branches').map((r) => ({ name: r.name, is_active: r.is_active }))
  );

  tables.roles = byJson(
    all('SELECT * FROM roles').map((r) => ({
      name: r.name,
      permissions: JSON.parse(r.permissions || '[]').slice().sort(),
      is_system: r.is_system,
    }))
  );

  tables.users = byJson(
    all('SELECT * FROM users').map((r) => ({
      name: r.name,
      email: r.email,
      role: r.role,
      branch: r.branch_id == null ? null : name(branchName, r.branch_id),
      is_active: r.is_active,
      multi_branch: r.multi_branch ?? null,
      pin: r.pin ?? null,
      pin_hash: hash(r.pin_hash ?? null),
      password_hash: hash(r.password_hash),
    }))
  );

  tables.categories = byJson(all('SELECT * FROM categories').map((r) => ({ name: r.name })));

  tables.products = byJson(
    all('SELECT * FROM products').map((r) => ({
      name: r.name,
      sku: r.sku ?? null,
      unit: r.unit ?? null,
      category: r.category_id == null ? null : name(categoryName, r.category_id),
      cost_price: r.cost_price ?? null,
      default_price: r.default_price,
      is_active: r.is_active,
      is_variant_parent: r.is_variant_parent ?? null,
      brand: r.brand ?? null,
      image_url: r.image_url ?? null,
    }))
  );

  tables.product_variants = byJson(
    all('SELECT * FROM product_variants').map((r) => ({
      product: name(productName, r.product_id),
      name: r.name,
      variant_type: r.variant_type,
      price_adjustment: r.price_adjustment,
      is_default: r.is_default,
      is_active: r.is_active,
      sort_order: r.sort_order,
    }))
  );

  tables.branch_products = byJson(
    all('SELECT * FROM branch_products').map((r) => ({
      branch: name(branchName, r.branch_id),
      product: name(productName, r.product_id),
      price_override: r.price_override ?? null,
      is_available: r.is_available,
    }))
  );

  tables.branch_stocks = byJson(
    all('SELECT * FROM branch_stocks').map((r) => ({
      branch: name(branchName, r.branch_id),
      product: name(productName, r.product_id),
      quantity: r.quantity,
      low_stock_threshold: r.low_stock_threshold,
    }))
  );

  tables.stock_movements = byJson(
    all('SELECT * FROM stock_movements').map((r) => ({
      branch: name(branchName, r.branch_id),
      product: name(productName, r.product_id),
      type: r.type,
      quantity: r.quantity,
      note: r.note ?? null,
      user: r.user_id == null ? null : name(userName, r.user_id),
      reference: r.reference_id == null ? null : txOrder.get(r.reference_id) ?? 'unknown-ref',
      created_at: ts(r.created_at),
    }))
  );

  tables.transactions = all('SELECT * FROM transactions ORDER BY rowid').map((r) => ({
    code: code(r.code),
    receipt_number: code(r.receipt_number),
    branch: name(branchName, r.branch_id),
    user: name(userName, r.user_id),
    shift_id: r.shift_id == null ? null : '<shift>',
    subtotal: r.subtotal,
    discount: r.discount,
    tax: r.tax,
    tax_percent: r.tax_percent ?? null,
    total: r.total,
    payment_method: r.payment_method,
    payment_detail: r.payment_detail ?? null,
    cash_received: r.cash_received,
    change_due: r.change_due,
    status: r.status,
    note: r.note ?? null,
    order_label: r.order_label ?? null,
    table_number: r.table_number ?? null,
    customer_name: r.customer_name ?? null,
    client_uuid: r.client_uuid ?? null,
    synced_from_offline: r.synced_from_offline ?? null,
    device_id: r.device_id ?? null,
    approved_by: r.approved_by ?? null,
    void_reason: r.void_reason ?? null,
    // Live checkout stamps the server clock: `created_at` in the request body is
    // only honoured by the offline replay lane (`POST /sync/batch`), so the value
    // is compared by shape here and by "is it now?" in `checkInvariants`.
    created_at: ts(r.created_at),
  }));

  // Insertion order on purpose: both sides build the lines from the same payload,
  // so a reordered receipt is a real difference, not noise.
  tables.transaction_items = all('SELECT * FROM transaction_items ORDER BY rowid').map((r) => ({
    product: name(productName, r.product_id),
    product_name: r.product_name,
    variant: r.variant_id == null ? null : name(variantName, r.variant_id),
    variant_label: r.variant_label ?? null,
    price: r.price,
    cost_price: r.cost_price,
    quantity: r.quantity,
    discount: r.discount,
    subtotal: r.subtotal,
    note: r.note ?? null,
    is_prepared: r.is_prepared ?? null,
  }));

  tables.shifts = byJson(
    all('SELECT * FROM shifts').map((r) => ({
      branch: name(branchName, r.branch_id),
      user: name(userName, r.user_id),
      opening_cash: r.opening_cash,
      closing_cash: r.closing_cash ?? null,
      cash_sales: r.cash_sales ?? null,
      non_cash_sales: r.non_cash_sales ?? null,
      status: r.status,
    }))
  );

  tables.order_queue = byJson(
    all('SELECT * FROM order_queue').map((r) => ({
      transaction: r.transaction_id == null ? null : txOrder.get(r.transaction_id) ?? 'unknown-tx',
      hold_order_id: r.hold_order_id == null ? null : '<hold>',
      origin_ref: r.origin_ref == null ? null : '<origin>',
      ticket_no: r.ticket_no,
      order_label: r.order_label ?? null,
      table_number: r.table_number ?? null,
      customer_name: r.customer_name ?? null,
      station: r.station,
      status: r.status,
      note: r.note ?? null,
      created_by: r.created_by == null ? null : name(userName, r.created_by),
      created_at: ts(r.created_at),
      started_at: ts(r.started_at),
      ready_at: ts(r.ready_at),
      completed_at: ts(r.completed_at),
      cancel_reason: r.cancel_reason ?? null,
    }))
  );

  tables.order_queue_items = all('SELECT * FROM order_queue_items ORDER BY rowid').map((r) => ({
    queue: queueOrder.get(r.queue_id) ?? 'unknown-queue',
    product_name: r.product_name,
    variant_label: r.variant_label ?? null,
    quantity: r.quantity,
    note: r.note ?? null,
    done: r.done,
  }));

  tables.edge_outbox = byJson(
    all('SELECT * FROM edge_outbox').map((r) => {
      let payload = null;
      try {
        payload = JSON.parse(r.payload);
      } catch {
        payload = '<unparsable>';
      }
      if (payload && typeof payload === 'object') {
        payload = canonical({
          ...payload,
          items: Array.isArray(payload.items)
            ? payload.items.map((i) => ({
                ...i,
                product_id: name(productName, i.product_id),
                ...(i.variant_id ? { variant_id: name(variantName, i.variant_id) } : {}),
              }))
            : payload.items,
        });
      }
      return {
        client_uuid: r.client_uuid,
        branch: name(branchName, r.branch_id),
        status: r.status,
        attempts: r.attempts,
        last_error: r.last_error ?? null,
        next_attempt_at: ts(r.next_attempt_at),
        created_at: ts(r.created_at),
        updated_at: ts(r.updated_at),
        payload,
      };
    })
  );

  tables.audit_logs = byJson(
    all('SELECT * FROM audit_logs').map((r) => {
      let detail = null;
      try {
        detail = r.detail ? scrub(JSON.parse(r.detail)) : null;
      } catch {
        detail = r.detail;
      }
      return {
        action: r.action,
        entity: r.entity ?? null,
        entity_id: r.entity_id == null ? null : '<id>',
        user: r.user_id == null ? null : name(userName, r.user_id),
        branch: r.branch_id == null ? null : name(branchName, r.branch_id),
        detail,
        // Node records Express's `req.ip` ("::ffff:127.0.0.1"); the shape is what matters.
        ip: r.ip == null ? null : '<ip>',
      };
    })
  );

  tables.settings = byJson(all('SELECT * FROM settings').map((r) => ({ key: r.key, value: r.value })));

  db.close();
  return tables;
}


/* ------------------------------ RESPONSES ------------------------------ */

/** Normalize the HTTP bodies the scenario captured (ids and "now" scrubbed). */
function normalizeResponses(r) {
  return {
    sale: normTx(r.sale),
    replay: normTx(r.replay),
    fetched: normTx(r.fetched),
    list: {
      total: r.list.total,
      limit: r.list.limit,
      offset: r.list.offset,
      rows: r.list.rows.map(normListRow),
    },
    stock: scrub(r.stock),
    catalog: scrub(r.catalog),
    low: scrub(r.low),
  };
}

/**
 * Facts that must hold on *each* server, independently of the other one.
 * A parity diff alone cannot catch "both implementations are wrong in the same
 * way", so the money and the stock are pinned to hand-computed values here.
 */
function checkInvariants(label, resp, tables) {
  const fail = [];
  const eq = (what, actual, expected) => {
    if (actual !== expected) {
      fail.push(`${label}: ${what} = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  };
  const line = (productName) => (resp.sale.items || []).find((i) => i.product_name === productName);
  const stockOf = (productName) => tables.branch_stocks.find((s) => s.product === productName)?.quantity;

  // Idempotency: the replay returns the first sale instead of ringing a second.
  eq('sale.duplicate', resp.sale.duplicate, false);
  eq('replay.duplicate', resp.replay.duplicate, true);
  eq('replay.id === sale.id', resp.replay.id === resp.sale.id, true);
  eq('GET :id returns the same sale', resp.fetched.id === resp.sale.id, true);
  eq('history total', resp.list.total, 1);
  eq('history rows', resp.list.rows.length, 1);

  // Money, computed by hand:
  //   2 × (18000 + 3000 variant) = 42000
  //   1 × 20000                  = 20000
  //   1 × 12000 − 500 discount   = 11500
  //   3 × 8500 (branch override) = 25500
  //   subtotal 99000 − 2000 cart discount = 97000, +11% tax 10670 = 107670
  //   cash 120000 → change 12330
  eq('subtotal', resp.sale.subtotal, 99000);
  eq('discount', resp.sale.discount, 2000);
  eq('item discount', line('Roti Bakar')?.discount, 500);
  eq('tax', resp.sale.tax, 10670);
  eq('tax_percent', resp.sale.tax_percent, 11);
  eq('total', resp.sale.total, 107670);
  eq('cash_received', resp.sale.cash_received, 120000);
  eq('change_due', resp.sale.change_due, 12330);
  eq('items', resp.sale.items.length, 4);
  eq('variant surcharge in line price', line('Kopi Susu')?.price, 21000);
  eq('variant label', line('Kopi Susu')?.variant_label, 'Large');
  eq('branch override in line price', line('Teh Manis')?.price, 8500);
  eq('line subtotal', line('Teh Manis')?.subtotal, 25500);
  // Live checkout stamps "now" in ISO-8601 UTC. The historic receipt bug was a
  // missing `Z` (so browsers read UTC as local wall-clock), so assert the shape
  // and the drift, not a fixed value.
  const stamped = String(resp.sale.created_at || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(stamped)) {
    fail.push(`${label}: sale created_at ${JSON.stringify(stamped)} is not ISO-8601 UTC with a Z`);
  } else if (Math.abs(Date.now() - Date.parse(stamped)) > 120_000) {
    fail.push(`${label}: sale created_at ${stamped} is not "now" (clock or timezone slip)`);
  }

  // Stock sold down by exactly the quantities on the receipt.
  eq('stock Kopi Susu', stockOf('Kopi Susu'), 28);
  eq('stock Roti Bakar', stockOf('Roti Bakar'), 29);
  eq('stock Teh Manis', stockOf('Teh Manis'), 27);
  eq('stock Es Kopi Susu', stockOf('Es Kopi Susu'), 29);
  eq('movements (4 set + 4 sale)', tables.stock_movements.length, 8);

  // Kitchen: one ticket for the three categorised lines; the retail tea stays off.
  eq('kitchen tickets', tables.order_queue.length, 1);
  eq('kitchen ticket lines', tables.order_queue_items.length, 3);
  eq('kitchen station (bar + kitchen)', tables.order_queue[0]?.station, 'both');
  eq('kitchen ticketNo', tables.order_queue[0]?.ticket_no, 1);

  // Sync lane: one pending replay row, keyed by the sale's client_uuid.
  eq('outbox rows', tables.edge_outbox.length, 1);
  eq('outbox status', tables.edge_outbox[0]?.status, 'pending');
  eq('outbox client_uuid', tables.edge_outbox[0]?.client_uuid, CLIENT_UUID);

  // No shift was opened, so nothing may have invented one.
  eq('shifts', tables.shifts.length, 0);
  return fail;
}



/* -------------------------------- MAIN --------------------------------- */

const indent = (text, spaces) =>
  text
    .split('\n')
    .map((line) => ' '.repeat(spaces) + line)
    .join('\n');

async function main() {
  if (!existsSync(RUST_BIN)) {
    throw new Error(
      `Rust edge binary not found: ${RUST_BIN}\n` +
        'Build it first:\n  cargo build --manifest-path frontend/src-tauri/pos-edge/Cargo.toml'
    );
  }

  let keepDirs = false;
  const nodeServer = await startServer({
    label: 'node',
    command: process.execPath,
    args: [NODE_SERVER],
    cwd: path.join(ROOT, 'backend'),
  });
  let rustServer = null;
  try {
    rustServer = await startServer({
      label: 'rust',
      command: RUST_BIN,
      args: [],
      cwd: path.dirname(RUST_BIN),
    });

    console.log(`node edge  ${nodeServer.baseUrl}`);
    console.log(`rust edge  ${rustServer.baseUrl}\n`);

    const nodeResp = await runScenario(nodeServer.baseUrl);
    const rustResp = await runScenario(rustServer.baseUrl);

    // Close both before reading the files, so every write has landed.
    await Promise.all([nodeServer.stop(), rustServer.stop()]);

    const nodeTables = normalizeTables(nodeServer.dbPath);
    const rustTables = normalizeTables(rustServer.dbPath);

    const checks = [];
    const nodeBodies = normalizeResponses(nodeResp);
    const rustBodies = normalizeResponses(rustResp);
    for (const key of Object.keys(nodeBodies)) {
      checks.push({ name: `response.${key}`, left: nodeBodies[key], right: rustBodies[key] });
    }
    for (const table of Object.keys({ ...nodeTables, ...rustTables }).sort()) {
      checks.push({ name: `db.${table}`, left: nodeTables[table] ?? null, right: rustTables[table] ?? null });
    }

    const invariants = [
      ...checkInvariants('node', nodeResp, nodeTables),
      ...checkInvariants('rust', rustResp, rustTables),
    ];

    let mismatches = 0;
    console.log('Node vs Rust');
    for (const check of checks) {
      if (isDeepStrictEqual(check.left, check.right)) {
        const shape = Array.isArray(check.left) ? `${check.left.length} row(s)` : 'matches';
        console.log(`  ok    ${check.name.padEnd(28)} ${shape}`);
      } else {
        mismatches++;
        console.log(`  DIFF  ${check.name}`);
        console.log('        --- node ---');
        console.log(indent(JSON.stringify(check.left, null, 2), 8));
        console.log('        --- rust ---');
        console.log(indent(JSON.stringify(check.right, null, 2), 8));
      }
    }

    if (invariants.length) {
      console.log('\nInvariant failures');
      for (const line of invariants) console.log(`  FAIL  ${line}`);
    }

    if (mismatches || invariants.length) {
      keepDirs = true;
      console.log(
        `\nPARITY FAILED: ${mismatches} mismatch(es), ${invariants.length} invariant failure(s).\n` +
          `databases kept for inspection:\n  node: ${nodeServer.dbPath}\n  rust: ${rustServer.dbPath}`
      );
      process.exitCode = 1;
      return;
    }

    console.log(`\nPARITY OK: ${checks.length} response/table checks and all invariants agree.`);
  } finally {
    await Promise.all([nodeServer.stop(), rustServer?.stop()].filter(Boolean));
    if (!keepDirs) {
      rmSync(nodeServer.dataDir, { recursive: true, force: true });
      if (rustServer) rmSync(rustServer.dataDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
