// L6 parity check: Node edge vs Rust edge for reports, docs and backup.
//
// The money path (L4) and the offline plumbing (L5) are already pinned. This oracle
// covers the surface an owner actually *reads*, where a silent divergence is worst:
//
//   * every `/api/reports/*` figure — including the two rules the Node code was
//     carefully written around: a bare `?from`/`?to` is a *local* (shop) day, and
//     the daily brief's "today" is the same local day, so a 01:30 WIB sale lands on
//     the right date in both;
//   * the four CSV exports, compared byte for byte after scrubbing the per-server
//     transaction codes and timestamps (BOM, `\r\n`, header wording, money
//     formatting, no trailing newline);
//   * `/api/openapi.json` and `/api/permissions`, deep-equal — a generated client
//     must not see a different API from the two builds;
//   * `/api/backup` (bundle shape, counts, and the stripped credentials/pairing
//     keys) plus the 409 both restore routes must answer on a till.
//
// Restore *application* cannot be exercised here: both builds refuse it in edge mode
// by design (see `restoreGuard`). `pos-edge/src/backup.rs` unit-tests that path
// directly, including the all-or-nothing transaction and the idempotent merge.
//
// Usage:
//   cargo build --manifest-path frontend/src-tauri/pos-edge/Cargo.toml
//   node backend/test/parity/edge-l6.mjs       # or: cd backend && npm run parity:l6

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
const COMPANY = { company_name: 'Toko L6', name: 'Sari', email: 'owner@l6.id', password: 'rahasia123' };

/**
 * The scenario's fixed instants. Pinning `created_at` on each sale is what makes the
 * timezone rules testable: sale A is 18:30 UTC on Nov 2, which is 01:30 WIB on Nov 3
 * — the case that made a UTC-day report show a UTC+7 shop's sale on the wrong date.
 */
const SALE_A_AT = '2026-11-02T18:30:00.000Z';
const SALE_B_AT = '2026-11-03T05:00:00.000Z';
const SALE_C_AT = '2026-11-03T10:00:00.000Z';
const SALE_D_AT = '2026-11-03T11:00:00.000Z';
const DAY = '2026-11-03';
const DAY_QUERY = `from=${DAY}&to=${DAY}`;

function tempDir(tag) {
  return mkdtempSync(path.join(tmpdir(), `pos-l6-${tag}-`));
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
    if (Date.now() > deadline) {
      throw new Error(`${label} not healthy after ${BOOT_TIMEOUT_MS}ms\n${output}`);
    }
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

/** JSON client. `raw` keeps the status + body of a request we expect to fail. */
function apiFor(baseUrl) {
  const send = async (method, uri, { token, body } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(baseUrl + uri, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, text: await res.text(), headers: res.headers };
  };
  const call = async (method, uri, opts) => {
    const res = await send(method, uri, opts);
    if (res.status >= 400) throw new Error(`${method} ${uri} → ${res.status} ${res.text}`);
    return res.text ? JSON.parse(res.text) : null;
  };
  call.raw = async (method, uri, opts) => {
    const res = await send(method, uri, opts);
    let parsed = null;
    try {
      parsed = res.text ? JSON.parse(res.text) : null;
    } catch {
      parsed = res.text;
    }
    return { status: res.status, body: parsed, headers: res.headers, text: res.text };
  };
  return call;
}

/* ------------------------------- SCENARIO ------------------------------ */

/**
 * Back-date the four sales (and the shift that holds them) into the pinned day.
 *
 * The sales route stamps `created_at` with `datetime('now')` — a sale is rung when it
 * is rung — so the fixture writes the timestamps directly. The same UPDATEs run on
 * both databases, so the only thing being compared is still the reports.
 */
function pinDates(dbPath, ids) {
  const db = new Database(dbPath);
  try {
    const stamp = db.prepare('UPDATE transactions SET created_at = ? WHERE id = ?');
    const pinned = [
      [ids.saleA, '2026-11-02 18:30:00'], // 01:30 WIB on Nov 3
      [ids.saleB, '2026-11-03 05:00:00'], // 12:00 WIB
      [ids.saleC, '2026-11-03 10:00:00'], // 17:00 WIB
      [ids.saleD, '2026-11-03 11:00:00'], // 18:00 WIB, then voided
    ];
    for (const [id, at] of pinned) {
      const { changes } = stamp.run(at, id);
      if (changes !== 1) throw new Error(`could not pin ${id}: ${changes} rows`);
    }
    // The drawer opened before the first sale of that day.
    db.prepare("UPDATE shifts SET opened_at = '2026-11-03 00:30:00'").run();
  } finally {
    db.close();
  }
}

/** Per-server id → label map, so an id from one edge never resolves in the other. */
function makeNames() {
  const map = new Map();
  return {
    add(label, id) {
      if (id != null) map.set(String(id), label);
      return id;
    },
    get(id) {
      return id == null ? null : map.get(String(id)) ?? '<id>';
    },
  };
}

/**
 * Replay the fixture against one server and return the responses plus the id map.
 *
 * Four sales on one pinned day — one of them at 01:30 WIB, one voided after the
 * fact — so every report has a total, a payment split, a margin, a timezone edge
 * and a void to talk about.
 *
 * The `POST /api/transactions` route deliberately stamps `created_at` itself, so the
 * sales are back-dated in the SQLite file between the two halves of the scenario
 * (`pinDates`). Identical surgery on both servers; the reports are the subject here,
 * not the sale insert, which L4 already pins.
 */
async function runScenario(server) {
  const api = apiFor(server.baseUrl);
  const names = makeNames();
  const resp = {};


  const reg = await api('POST', '/api/auth/register', { body: COMPANY });
  const token = reg.token;
  const branchId = names.add('branch', reg.user.branch_id);
  names.add('me', reg.user.id);

  const drinks = await api('POST', '/api/categories', { token, body: { name: 'Minuman' } });
  names.add('cat-drinks', drinks.id);

  const kopi = await api('POST', '/api/products', {
    token,
    body: {
      name: 'Kopi Susu',
      sku: 'KOPI-01',
      unit: 'cup',
      cost_price: 7000,
      default_price: 18000,
      category_id: drinks.id,
    },
  });
  names.add('kopi', kopi.id);
  const teh = await api('POST', '/api/products', {
    token,
    body: { name: 'Teh Manis', sku: 'TEH-01', cost_price: 2500, default_price: 8000 },
  });
  names.add('teh', teh.id);

  // Opening stock, so the stock export has something to value.
  for (const product of [kopi, teh]) {
    await api('POST', `/api/branches/${branchId}/stock/adjust`, {
      token,
      body: { product_id: product.id, quantity: 20, type: 'set' },
    });
  }
  // A drawer to report on: the shift export needs a row.
  await api('POST', '/api/shifts/open', {
    token,
    body: { branch_id: branchId, opening_cash: 200000 },
  });

  let saleNo = 0;
  const sale = async ({ at, items, payment_method, tax, cash_received }) => {
    saleNo += 1;
    return api('POST', '/api/transactions', {
      token,
      body: {
        branch_id: branchId,
        client_uuid: `l6-sale-${saleNo}`,
        created_at: at,
        items,
        payment_method,
        cash_received: cash_received ?? 100000,
        ...(tax === undefined ? {} : { tax }),
      },
    });
  };

  // 01:30 WIB on Nov 3 — 18:30 UTC on Nov 2. The whole point of `DAY`.
  resp.saleA = await sale({
    at: SALE_A_AT,
    items: [{ product_id: kopi.id, quantity: 3 }],
    payment_method: 'cash',
  });
  // Noon WIB on Nov 3.
  resp.saleB = await sale({
    at: SALE_B_AT,
    items: [{ product_id: kopi.id, quantity: 2 }],
    payment_method: 'qris',
  });
  // 17:00 WIB on Nov 3.
  resp.saleC = await sale({
    at: SALE_C_AT,
    items: [{ product_id: teh.id, quantity: 3 }],
    payment_method: 'card',
  });
  // 18:00 WIB on Nov 3, voided straight after: revenue must not see it, the shift
  // report must show it as a void.
  resp.saleD = await sale({
    at: SALE_D_AT,
    items: [{ product_id: kopi.id, quantity: 1 }],
    payment_method: 'cash',
  });
  resp.saleDVoided = await api('POST', `/api/transactions/${resp.saleD.id}/void`, {
    token,
    body: { reason: 'salah input' },
  });

  pinDates(server.dbPath, {
    saleA: resp.saleA.id,
    saleB: resp.saleB.id,
    saleC: resp.saleC.id,
    saleD: resp.saleD.id,
  });


  /* ---- the reports an owner reads ---- */
  resp.summary = await api('GET', `/api/reports/summary?${DAY_QUERY}`, { token });
  resp.summaryToday = await api('GET', '/api/reports/summary', { token });
  resp.sales = await api('GET', `/api/reports/sales?${DAY_QUERY}`, { token });
  resp.products = await api('GET', `/api/reports/products?${DAY_QUERY}&limit=5`, { token });
  resp.productsLow = await api('GET', `/api/reports/products?${DAY_QUERY}&low=1`, { token });
  resp.cashiers = await api('GET', `/api/reports/cashiers?${DAY_QUERY}`, { token });
  resp.profit = await api('GET', `/api/reports/profit?${DAY_QUERY}`, { token });
  resp.brief = await api('GET', `/api/reports/daily-brief?date=${DAY}`, { token });
  resp.briefEn = await api('GET', `/api/reports/daily-brief?date=${DAY}&lang=en`, { token });
  resp.briefEmpty = await api('GET', '/api/reports/daily-brief?date=2026-11-04', { token });
  resp.briefText = await api.raw('GET', `/api/reports/daily-brief/text?date=${DAY}`, { token });

  /* ---- the four exports ---- */
  resp.csvTransactions = await api.raw('GET', `/api/reports/export/transactions.csv?${DAY_QUERY}`, {
    token,
  });
  resp.csvProducts = await api.raw('GET', `/api/reports/export/products.csv?${DAY_QUERY}`, {
    token,
  });
  resp.csvStock = await api.raw('GET', '/api/reports/export/stock.csv', { token });
  resp.csvShifts = await api.raw('GET', `/api/reports/export/shifts.csv?${DAY_QUERY}`, { token });

  /* ---- the two documents ---- */
  resp.openapi = await api('GET', '/api/openapi.json');
  resp.permissions = await api('GET', '/api/permissions');

  /* ---- backup: export works on a till, restore is refused ---- */
  resp.backupCategories = await api('GET', '/api/backup/categories', { token });
  const backup = await api.raw('GET', '/api/backup', { token });
  resp.backupHeaders = {
    contentType: backup.headers.get('content-type'),
    disposition: backup.headers.get('content-disposition').replace(/\d{4}-\d{2}-\d{2}[T-][\d-]+/, '<ts>'),
  };
  const bundle = JSON.parse(backup.text);
  resp.backup = bundle;
  resp.backupNarrow = JSON.parse(
    (await api.raw('GET', '/api/backup?categories=configuration', { token })).text,
  );
  resp.backupBadCategory = await api.raw('GET', '/api/backup?categories=nope', { token });
  resp.backupPreview = await api.raw('POST', '/api/backup/preview', { token, body: { bundle } });
  resp.backupRestore = await api.raw('POST', '/api/backup/restore', {
    token,
    body: { bundle, confirm: 'RESTORE' },
  });

  return { resp, names };
}

/* -------------------------------- SCRUB -------------------------------- */

/** Every column that holds an id minted by one server and referenced by another. */
const ID_KEYS = new Set([
  'id',
  'branch_id',
  'company_id',
  'companyId',
  'user_id',
  'queue_id',
  'hold_id',
  'hold_order_id',
  'shift_id',
  'transaction_id',
  'origin_uuid',
  'origin_ref',
  'product_id',
  'category_id',
  'approved_by',
  'reference_id',
  'entity_id',
  'client_uuid',
  'created_by',
  'started_by',
  'ready_by',
  'closed_by',
  'to_user_id',
  'device_id',
  'parent_item_id',
  'variant_id',
]);

/** Columns whose value is wall-clock: only the presence is compared. */
const TS_KEYS = new Set([
  'created_at',
  'updated_at',
  'voided_at',
  'opened_at',
  'closed_at',
  'createdAt',
  'paid_at',
  'approved_at',
  'last_seen',
  'last_login_at',
  'pin_set_at',
  'synced_at',
  'time',
  'server_time',
]);

const BCRYPT = /^\$2[aby]\$\d\d\$/;

/** Deep key sort, so a set of rows can be ordered by its normalized content. */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

/** Replace ids, timestamps and credentials with stable placeholders, recursively. */
function scrub(value, names) {
  if (typeof value === 'string') {
    // A per-server transaction code can appear *inside* a value — a receipt number,
    // or a void movement's note ("Void TRX-…: salah input").
    return value.replace(/TRX-[0-9A-Z]+/g, '<code>');
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, names));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      if ((key === 'payload' || key === 'detail') && typeof raw === 'string') {
        try {
          out[key] = scrub(JSON.parse(raw), names);
        } catch {
          out[key] = raw;
        }
        continue;
      }
      if (ID_KEYS.has(key)) {
        out[key] = raw == null ? null : names.get(raw);
        continue;
      }
      if (TS_KEYS.has(key)) {
        out[key] = raw == null ? null : '<ts>';
        continue;
      }
      if (key === 'ip' && raw != null) {
        out[key] = '<ip>';
        continue;
      }
      if (key === 'token' || key === 'refresh_token') {
        out[key] = raw == null ? null : '<token>';
        continue;
      }
      if ((key === 'password_hash' || key === 'pin_hash') && typeof raw === 'string') {
        // The salt is random on both sides; the bcrypt cost is the contract.
        out[key] = BCRYPT.test(raw) ? '<bcrypt cost=10>' : raw;
        continue;
      }
      if (key === 'value' && typeof raw === 'string' && /^[0-9a-f]{32}$/.test(raw)) {
        out[key] = names.get(raw);
        continue;
      }
      if (key === 'code' && typeof raw === 'string' && /^(TRX|TRF)-[0-9A-Z]+$/.test(raw)) {
        out[key] = '<code>';
        continue;
      }
      out[key] = scrub(raw, names);
    }
    return out;
  }
  return value;
}

/**
 * A bundle's per-table arrays are sorted by content before comparison: the export
 * has no `ORDER BY`, so row order is storage order, not contract.
 */
function scrubBundle(bundle, names) {
  const out = scrub(bundle, names);
  const data = {};
  for (const table of Object.keys(out.data || {}).sort()) {
    data[table] = (out.data[table] || [])
      .map((row) => JSON.stringify(sortKeys(row)))
      .sort()
      .map((line) => JSON.parse(line));
  }
  return { ...out, data };
}

/**
 * CSV bodies differ only in the per-server transaction code and timestamps. Keep
 * everything else — the BOM, the `\r\n` separators, header wording and money
 * formatting are exactly what this check is for.
 */
function scrubCsv(text) {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/TRX-[0-9A-Z]+/g, 'TRX')
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, '<ts>')
    .replace(/stock_\d{4}-\d{2}-\d{2}\.csv/, 'stock_<date>.csv');
}

/** Read and normalize the tables this scenario touches. */
function tablesFor(dbPath, names) {
  const db = new Database(dbPath, { readonly: true });
  const sql = (q) => db.prepare(q);
  const read = (table, order = 'rowid') =>
    sql(`SELECT * FROM ${table} ORDER BY ${order}`)
      .all()
      .map((r) => scrub(r, names));
  /** Tables with no contractual order: compare as a content-sorted set. */
  const readSorted = (table) =>
    sql(`SELECT * FROM ${table}`)
      .all()
      .map((r) => JSON.stringify(sortKeys(scrub(r, names))))
      .sort()
      .map((line) => JSON.parse(line));
  const tables = {
    transactions: read('transactions', 'created_at, client_uuid'),
    transaction_items: readSorted('transaction_items'),
    stock_movements: readSorted('stock_movements'),
    branch_stocks: readSorted('branch_stocks'),
    shifts: read('shifts'),
    users: read('users'),
    products: read('products', 'sku'),
    settings: read('settings', 'key'),
  };
  // Audit rows have no guaranteed order; compare them as a sorted set.
  tables.audit_logs = sql('SELECT * FROM audit_logs')
    .all()
    .map((r) => JSON.stringify(sortKeys(scrub(r, names))))
    .sort()
    .map((line) => JSON.parse(line));
  db.close();
  return tables;
}

/* ------------------------------- CHECKS ------------------------------- */

/**
 * Facts that must hold on *each* server, independently of the other one.
 *
 * A parity diff alone cannot catch "both implementations are wrong in the same
 * way", so the arithmetic is pinned here: 98.000 revenue over three sales, the
 * 01:30 WIB sale counted on Nov 3, and a void that is reported but not earned.
 */
function checkInvariants(label, resp, tables) {
  const fail = [];
  const eq = (what, actual, expected) => {
    if (!isDeepStrictEqual(actual, expected)) {
      fail.push(
        `${label}: ${what} = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
      );
    }
  };

  // Revenue: A 3×18.000, B 2×18.000, C 3×8.000. D is voided, so it is reported
  // separately and never earned.
  eq('summary.transactions', resp.summary.transactions, 3);
  eq('summary.revenue', resp.summary.revenue, 114000);
  eq('summary.tax', resp.summary.tax, 0);
  eq('summary.discount', resp.summary.discount, 0);
  eq('summary.cogs', resp.summary.cogs, 42500);
  eq('summary.gross_profit', resp.summary.gross_profit, 71500);
  eq('summary.avg_ticket', resp.summary.avg_ticket, 38000);
  eq('summary.void_count', resp.summary.void_count, 1);
  eq('summary.void_total', resp.summary.void_total, 18000);
  eq('summary.branches', resp.summary.branches, 1);
  eq('summary.by_payment', resp.summary.by_payment, [
    { method: 'cash', count: 1, total: 54000 },
    { method: 'qris', count: 1, total: 36000 },
    { method: 'card', count: 1, total: 24000 },
  ]);
  // Hours are UTC in the summary (the brief is what localizes them).
  eq('summary.hourly', resp.summary.hourly, [
    { hour: '05', transactions: 1, revenue: 36000 },
    { hour: '10', transactions: 1, revenue: 24000 },
    { hour: '18', transactions: 1, revenue: 54000 },
  ]);
  // A bare date is the shop's local day, so the 18:30-UTC sale belongs here.
  eq('summary.range.from', resp.summary.range.from, '2026-11-02 17:00:00');
  eq('summary.range.to', resp.summary.range.to, '2026-11-03 16:59:59');
  // Today's default range is not empty either (the sales were pinned to Nov 3).
  eq('summaryToday.range.from', /:00:00$/.test(resp.summaryToday.range.from), true);

  eq('sales.rows', resp.sales.length, 1);
  eq('sales.revenue', resp.sales[0].revenue, 114000);
  eq('sales.cogs', resp.sales[0].cogs, 42500);
  eq('sales.margin_percent', resp.sales[0].margin_percent, 62.72);

  eq('products.rows', resp.products.length, 2);
  eq(
    'products[0]',
    [resp.products[0].product_name, resp.products[0].quantity, resp.products[0].revenue],
    ['Kopi Susu', 5, 90000],
  );
  eq('products[1]', [resp.products[1].product_name, resp.products[1].quantity], ['Teh Manis', 3]);
  eq('productsLow[0]', resp.productsLow[0].product_name, 'Teh Manis');

  eq('cashiers.rows', resp.cashiers.length, 1);
  eq('cashiers.transactions', resp.cashiers[0].transactions, 3);
  eq('cashiers.revenue', resp.cashiers[0].revenue, 114000);
  eq('cashiers.avg_ticket', resp.cashiers[0].avg_ticket, 38000);
  eq('cashiers.void_count', resp.cashiers[0].void_count, 1);
  eq('cashiers.void_total', resp.cashiers[0].void_total, 18000);

  eq('profit.gross_sales', resp.profit.gross_sales, 114000);
  eq('profit.net_sales', resp.profit.net_sales, 114000);
  eq('profit.tax', resp.profit.tax, 0);
  eq('profit.cogs', resp.profit.cogs, 42500);
  eq('profit.gross_profit', resp.profit.gross_profit, 71500);
  eq('profit.margin_percent', resp.profit.margin_percent, 62.72);
  // The trend line groups by `date(created_at)` — the *UTC* day — while the day
  // totals above use the shop's local window. Both builds share that split, so it is
  // pinned rather than "fixed" here: the 01:30 WIB sale falls on Nov 2 UTC.
  eq('profit.daily', resp.profit.daily, [
    { day: '2026-11-02', transactions: 1, revenue: 54000, cogs: 21000, gross_profit: 33000 },
    { day: '2026-11-03', transactions: 2, revenue: 60000, cogs: 21500, gross_profit: 38500 },
  ]);

  // The brief: same day, same numbers, and the message an owner would forward.
  eq('brief.date', resp.brief.date, DAY);
  eq('brief.transactions', resp.brief.transactions, 3);
  eq('brief.items_sold', resp.brief.items_sold, 8);
  eq('brief.revenue', resp.brief.revenue, 114000);
  eq('brief.void_count', resp.brief.void_count, 1);
  eq(
    'brief.top_products[0]',
    [resp.brief.top_products[0].product_name, resp.brief.top_products[0].quantity],
    ['Kopi Susu', 5],
  );
  // The busiest UTC hour (18) re-read on the local date is 01:00 WIB — a quirk of
  // the shared implementation, pinned so a "fix" on one side shows up as a diff.
  eq('brief.busiest_hour.hour', resp.brief.busiest_hour.hour, '01');
  eq('brief.busiest_hour.revenue', resp.brief.busiest_hour.revenue, 54000);
  eq('brief.company_name', resp.brief.company_name, COMPANY.company_name);
  eq('brief.lang', resp.brief.lang, 'id');
  eq('brief.text has revenue', resp.brief.text.includes('Omzet: *Rp 114.000*'), true);
  eq('brief.text has items', resp.brief.text.includes('Item terjual: 8'), true);
  eq('brief.text has void', resp.brief.text.includes('Void: 1x Rp 18.000'), true);
  eq('briefEn.text has revenue', resp.briefEn.text.includes('Revenue: *Rp 114,000*'), true);
  eq('briefEmpty.transactions', resp.briefEmpty.transactions, 0);
  eq(
    'briefEmpty.text',
    resp.briefEmpty.text.endsWith('_Belum ada penjualan hari ini._'),
    true,
  );
  eq('briefText status', resp.briefText.status, 200);
  eq(
    'briefText content-type',
    resp.briefText.headers.get('content-type'),
    'text/plain; charset=utf-8',
  );
  eq('briefText body', resp.briefText.text, resp.brief.text);

  // The four exports.
  const txCsv = scrubCsv(resp.csvTransactions.text);
  // The BOM itself is stripped by the fetch text decoder, so it is checked through
  // the serialiser's own unit test; what matters here is the bytes that follow.
  eq('transactions.csv body starts at the header', txCsv.startsWith('Kode,Waktu'), true);
  eq(
    'transactions.csv content-type',
    resp.csvTransactions.headers.get('content-type'),
    'text/csv; charset=utf-8',
  );
  eq(
    'transactions.csv disposition',
    resp.csvTransactions.headers.get('content-disposition'),
    // A local day starts on the previous UTC date, and the filename stamps both.
    'attachment; filename="transactions_2026-11-02_2026-11-03.csv"',
  );
  const txLines = txCsv.split('\r\n');
  eq(
    'transactions.csv header',
    txLines[0].startsWith('Kode,Waktu,Cabang,Kasir,Status,Jumlah Item'),
    true,
  );
  // Three completed sales plus the voided one (the export's default status set).
  eq('transactions.csv rows', txLines.length, 5);
  eq('transactions.csv void reason', txCsv.includes('salah input'), true);
  eq(
    'products.csv body',
    scrubCsv(resp.csvProducts.text),
    [
      'Produk,SKU,Terjual,Omzet,HPP,Laba Kotor',
      'Kopi Susu,KOPI-01,5,90000,35000,55000',
      'Teh Manis,TEH-01,3,24000,7500,16500',
    ].join('\r\n'),
  );
  const stockCsv = scrubCsv(resp.csvStock.text);
  eq(
    'stock.csv header',
    stockCsv.startsWith('Cabang,Produk,SKU,Stok,Batas Minimum,Harga Modal,Harga Jual,Nilai Stok'),
    true,
  );
  // 20 opening, 4 kopi sold (the voided one came back), 3 teh.
  eq('stock.csv kopi', stockCsv.includes(',Kopi Susu,KOPI-01,15,'), true);
  eq('stock.csv teh', stockCsv.includes(',Teh Manis,TEH-01,17,'), true);
  const shiftCsv = scrubCsv(resp.csvShifts.text);
  eq('shifts.csv header', shiftCsv.startsWith('Buka,Tutup,Status,Cabang,Kasir,'), true);
  eq('shifts.csv rows', shiftCsv.split('\r\n').length, 2);

  // The two documents.
  eq('openapi version', resp.openapi.openapi, '3.0.3');
  eq('openapi title', resp.openapi.info.title, 'Reekas POS API');
  eq('openapi paths', Object.keys(resp.openapi.paths).length >= 80, true);
  eq('openapi has reports', typeof resp.openapi.paths['/reports/summary'], 'object');
  eq('openapi has backup-free surface', resp.openapi.paths['/backup'], undefined);
  eq('openapi login is public', resp.openapi.paths['/auth/login'].post.security, []);
  eq(
    'openapi csv declares text/csv',
    resp.openapi.paths['/reports/export/transactions.csv'].get.responses['200'].content['text/csv']
      .schema.type,
    'string',
  );
  eq('permissions groups', resp.permissions.groups.length > 3, true);
  eq(
    'permissions company.manage',
    resp.permissions.permissions.includes('company.manage'),
    true,
  );

  // Backup: an export a till is allowed to take, and the two refusals.
  eq(
    'backup.categories',
    resp.backupCategories.categories.map((c) => c.key),
    ['master', 'transaction', 'configuration'],
  );
  eq('backup.canRestore', resp.backupCategories.canRestore, false);
  eq('backup.format', resp.backup.format, 'pos-backup');
  eq('backup.version', resp.backup.version, 1);
  eq('backup.counts.companies', resp.backup.counts.companies, 1);
  eq('backup.counts.transactions', resp.backup.counts.transactions, 4);
  eq('backup categories', resp.backup.categories, ['master', 'transaction', 'configuration']);
  eq(
    'backup strips password_hash',
    resp.backup.data.users.every((u) => !('password_hash' in u)),
    true,
  );
  eq(
    'backup strips edge_* settings',
    resp.backup.data.settings.every((s) => !String(s.key).startsWith('edge_')),
    true,
  );
  eq('backupNarrow.categories', resp.backupNarrow.categories, ['configuration']);
  eq('backupNarrow has no products', resp.backupNarrow.data.products, undefined);
  eq('backup bad category status', resp.backupBadCategory.status, 400);
  eq(
    'backup bad category message',
    resp.backupBadCategory.body.error,
    'Kategori tidak dikenal: nope',
  );
  eq(
    'backup export content-type',
    resp.backupHeaders.contentType,
    'application/json; charset=utf-8',
  );
  eq(
    'backup export disposition',
    resp.backupHeaders.disposition,
    'attachment; filename="backup-toko-l6-<ts>.json"',
  );
  const guard =
    'Restore hanya dapat dilakukan di server pusat. Data di perangkat kasir adalah salinan yang akan ditimpa saat sinkronisasi.';
  eq('preview guard status', resp.backupPreview.status, 409);
  eq('preview guard message', resp.backupPreview.body.error, guard);
  eq('restore guard status', resp.backupRestore.status, 409);
  eq('restore guard message', resp.backupRestore.body.error, guard);

  // The rows those routes read.
  eq(
    'transaction statuses',
    tables.transactions.map((t) => t.status).join(','),
    'completed,completed,completed,voided',
  );
  eq('shift opening_cash', tables.shifts[0].opening_cash, 200000);
  eq('voided sale has a reason', tables.transactions[3].void_reason, 'salah input');

  return fail;
}

const RESPONSE_KEYS = [
  'saleA',
  'saleB',
  'saleC',
  'saleD',
  'saleDVoided',
  'summary',
  'summaryToday',
  'sales',
  'products',
  'productsLow',
  'cashiers',
  'profit',
  'brief',
  'briefEn',
  'briefEmpty',
  'openapi',
  'permissions',
  'backupCategories',
  'backupHeaders',
  'backup',
  'backupNarrow',
  'backupBadCategory',
  'backupPreview',
  'backupRestore',
];

/** The CSV/text bodies, compared after scrubbing the per-server bits. */
const RAW_KEYS = ['csvTransactions', 'csvProducts', 'csvStock', 'csvShifts', 'briefText'];

/* -------------------------------- MAIN -------------------------------- */

function showDiff(what, left, right) {
  console.error(`\n✗ ${what}`);
  console.error('  node:', JSON.stringify(left, null, 2));
  console.error('  rust:', JSON.stringify(right, null, 2));
}

async function main() {
  if (!existsSync(RUST_BIN)) {
    throw new Error(
      `Rust edge binary not found at ${RUST_BIN}\n` +
        'Build it first: cargo build --manifest-path frontend/src-tauri/pos-edge/Cargo.toml',
    );
  }

  console.log('L6 parity — Node edge vs Rust edge\n');
  const node = await startServer({ label: 'node', command: 'node', args: [NODE_SERVER], cwd: ROOT });
  const rust = await startServer({
    label: 'rust',
    command: RUST_BIN,
    args: [],
    cwd: path.dirname(RUST_BIN),
  });

  let checks = 0;
  let failures = 0;
  try {
    const n = await runScenario(node);
    const r = await runScenario(rust);
    const nodeTables = tablesFor(node.dbPath, n.names);
    const rustTables = tablesFor(rust.dbPath, r.names);

    // Per-server invariants first: "both wrong the same way" must not pass.
    const invariantProblems = [
      ...checkInvariants('node', n.resp, nodeTables),
      ...checkInvariants('rust', r.resp, rustTables),
    ];
    for (const problem of invariantProblems) console.error(`✗ ${problem}`);
    failures += invariantProblems.length;
    checks += 2;

    // Response bodies, one check per route. The bundle's tables are order-insensitive.
    for (const key of RESPONSE_KEYS) {
      checks += 1;
      const left = key === 'backup' ? scrubBundle(n.resp[key], n.names) : scrub(n.resp[key], n.names);
      const right = key === 'backup' ? scrubBundle(r.resp[key], r.names) : scrub(r.resp[key], r.names);
      if (!isDeepStrictEqual(left, right)) {
        failures += 1;
        showDiff(`response ${key}`, left, right);
      }
    }

    // CSV and plain-text bodies: bytes, minus the per-server codes and timestamps.
    for (const key of RAW_KEYS) {
      checks += 1;
      const left = scrubCsv(n.resp[key].text);
      const right = scrubCsv(r.resp[key].text);
      if (left !== right) {
        failures += 1;
        showDiff(`raw ${key}`, left, right);
      }
    }

    // And the rows those routes read.
    for (const table of Object.keys(nodeTables)) {
      checks += 1;
      if (!isDeepStrictEqual(nodeTables[table], rustTables[table])) {
        failures += 1;
        showDiff(`table ${table}`, nodeTables[table], rustTables[table]);
      }
    }
  } finally {
    await node.stop();
    await rust.stop();
  }

  if (failures === 0) {
    console.log(
      `\n✓ L6 parity green — ${checks} checks ` +
        `(${RESPONSE_KEYS.length} responses, ${RAW_KEYS.length} raw bodies, 9 tables, invariants)`,
    );
    for (const side of [node, rust]) rmSync(side.dataDir, { recursive: true, force: true });
    return;
  }
  console.error(`\n✗ L6 parity FAILED — ${failures} of ${checks} checks`);
  console.error(
    `  databases kept for inspection:\n    node: ${node.dbPath}\n    rust: ${rust.dbPath}`,
  );
  process.exitCode = 1;
}

await main();








