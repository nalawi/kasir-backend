// L5 edge-plumbing parity check: Node edge vs Rust edge.
//
// The L4 oracle (`golden-sale.mjs`) proves the money path. This one proves the
// *plumbing* that surrounds it, because those routes are where an offline till
// disagrees with its cloud most quietly:
//
//   * a parked cart (POST/PUT/DELETE /api/holds) and the kitchen ticket it raises,
//   * the bar's side of that ticket (/api/queue, PATCH status), including the
//     "the bar already started it" rule and the cancel-reason requirement,
//   * a shift that opens, hands over, closes with a deliberate 4.000 shortfall and
//     gets a manager sign-off (/api/shifts*),
//   * an inter-branch transfer that ships four and receives three, so a loss has to
//     be booked on both sides (/api/transfers*),
//   * the edge-only surface itself (/api/edge/health, /queue, /config, /unlock,
//     /pin-*),
//   * and the three sync lanes those mutations feed (`edge_hold_sync`,
//     `edge_queue_sync`, plus the shift/ticket counters they read).
//
// Both servers run on their own temp database, replay the identical scenario, and
// the affected tables + normalized response bodies are diffed field by field.
//
// Usage:
//   cargo build --manifest-path frontend/src-tauri/pos-edge/Cargo.toml
//   node backend/test/parity/edge-l5.mjs       # or: cd backend && npm run parity:l5

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
const COMPANY = { company_name: 'Toko L5', name: 'Sari', email: 'owner@l5.id', password: 'rahasia123' };

function tempDir(tag) {
  return mkdtempSync(path.join(tmpdir(), `pos-l5-${tag}-`));
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
  const call = async function call(method, uri, { token, body } = {}) {
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
  call.raw = async (method, uri, { token, body } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(baseUrl + uri, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  };
  return call;
}

/* ------------------------------- SCENARIO ------------------------------ */

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
 * The bodies are identical for both servers except for the ids each one minted —
 * which is exactly what the comparison is meant to be blind to.
 */
async function runScenario(baseUrl) {
  const api = apiFor(baseUrl);
  const names = makeNames();
  const resp = {};

  const reg = await api('POST', '/api/auth/register', { body: COMPANY });
  const token = reg.token;
  const branchId = names.add('branch', reg.user.branch_id);
  const me = names.add('me', reg.user.id);

  const drinks = await api('POST', '/api/categories', { token, body: { name: 'Minuman' } });
  names.add('cat-drinks', drinks.id);

  const createProduct = (body) => api('POST', '/api/products', { token, body });
  const kopi = await createProduct({
    name: 'Kopi Susu',
    sku: 'KOPI-01',
    unit: 'cup',
    cost_price: 7000,
    default_price: 18000,
    category_id: drinks.id,
  });
  names.add('kopi', kopi.id);
  // No category on purpose: a bag of beans never lands on the barista screen.
  const teh = await createProduct({
    name: 'Teh Manis',
    sku: 'TEH-01',
    cost_price: 2500,
    default_price: 8000,
  });
  names.add('teh', teh.id);

  /* ---- a parked cart raises the ticket the bar has to make ---- */
  const hold = await api('POST', '/api/holds', {
    token,
    body: {
      branch_id: branchId,
      items: [
        { product_id: kopi.id, quantity: 2 },
        { product_id: teh.id, quantity: 1, price: 8000 },
      ],
      label: 'Meja 3',
      note: 'tanpa gula',
      tax: 2000,
    },
  });
  names.add('hold', hold.id);
  const ticketId = names.add('ticket', hold.queue_id);
  resp.hold = hold;

  resp.holdList = await api('GET', `/api/branches/${branchId}/holds`, { token });
  resp.holdRead = await api('GET', `/api/holds/${hold.id}`, { token });
  resp.ticket = await api('GET', `/api/queue/${ticketId}`, { token });

  /* ---- the bar works the ticket to the end ---- */
  const setStatus = (status, extra = {}) =>
    api('PATCH', `/api/queue/${ticketId}/status`, { token, body: { status, ...extra } });
  resp.ticketPreparing = await setStatus('preparing');
  resp.ticketReady = await setStatus('ready');
  // An illegal backwards jump is refused with the till's own wording.
  resp.ticketIllegal = await api.raw('PATCH', `/api/queue/${ticketId}/status`, {
    token,
    body: { status: 'queue' },
  });
  resp.ticketDone = await setStatus('completed');
  resp.queueSummary = await api('GET', `/api/branches/${branchId}/queue/summary`, { token });
  resp.queueHistory = await api('GET', `/api/branches/${branchId}/queue?scope=history`, { token });

  /* ---- editing a cart the bar already made does not falsify history ---- */
  resp.holdEdited = await api('PUT', `/api/holds/${hold.id}`, {
    token,
    body: { items: [{ product_id: kopi.id, price: 18000, quantity: 3 }], label: 'Meja 5' },
  });

  /* ---- a shift: open, hand over, close short, sign off ---- */
  const shift = await api('POST', '/api/shifts/open', {
    token,
    body: { branch_id: branchId, opening_cash: 200000, note: 'buka pagi' },
  });
  names.add('shift', shift.id);
  resp.shiftOpen = shift;
  resp.shiftReopen = await api.raw('POST', '/api/shifts/open', {
    token,
    body: { branch_id: branchId, opening_cash: 1000 },
  });
  await api('PUT', '/api/auth/me/pin', { token, body: { password: COMPANY.password, pin: '1234' } });
  resp.shiftHandover = await api('POST', `/api/shifts/${shift.id}/handover`, {
    token,
    body: { to_user_id: me, amount: 50000, pin: '1234' },
  });
  resp.shiftCurrent = await api('GET', `/api/shifts/current?branch_id=${branchId}`, { token });
  resp.shiftClose = await api('POST', `/api/shifts/${shift.id}/close`, {
    token,
    body: { closing_cash: 190000, note: 'hitung laci' },
  });
  resp.shiftReconcile = await api('POST', `/api/shifts/${shift.id}/reconcile`, {
    token,
    body: { note: 'selisih kecil' },
  });

  /* ---- an inter-branch transfer that loses one unit on the way ---- */
  const second = await api('POST', '/api/branches', { token, body: { name: 'Cabang Dua' } });
  const secondId = names.add('branch-2', second.id);
  const transfer = await api('POST', '/api/transfers', {
    token,
    body: {
      from_branch_id: branchId,
      to_branch_id: secondId,
      items: [
        { product_id: kopi.id, quantity: 5 },
        { product_id: teh.id, quantity: 2 },
      ],
      note: 'restock',
    },
  });
  names.add('transfer', transfer.id);
  names.add('ti-kopi', transfer.items.find((i) => i.product_id === kopi.id)?.id);
  resp.transfer = transfer;
  resp.transferApproved = await api('POST', `/api/transfers/${transfer.id}/approve`, { token });
  resp.transferShipped = await api('POST', `/api/transfers/${transfer.id}/ship`, { token });
  resp.transferReceived = await api('POST', `/api/transfers/${transfer.id}/receive`, {
    token,
    body: { items: [{ id: transfer.items.find((i) => i.product_id === kopi.id).id, received_quantity: 4 }] },
  });
  resp.transferList = await api('GET', '/api/transfers', { token });
  resp.transferRead = await api('GET', `/api/transfers/${transfer.id}`, { token });

  /* ---- the edge-only surface ---- */
  resp.edgeHealth = await api('GET', '/api/edge/health');
  resp.edgeConfig = await api('PUT', '/api/edge/config', {
    token,
    body: { upstream: 'https://cloud.l5.test/' },
  });
  resp.edgeQueue = await api('GET', `/api/edge/queue?branch_id=${branchId}`, { token });
  resp.edgeUnlock = await api('POST', '/api/edge/unlock', { body: { user_id: me, pin: '1234' } });
  resp.edgeUnlockWrong = await api.raw('POST', '/api/edge/unlock', { body: { user_id: me, pin: '0000' } });
  resp.edgePinBranches = await api('GET', '/api/edge/pin-branches');
  resp.edgePinUsers = await api('GET', `/api/edge/pin-users?branch_id=${branchId}`);

  /* ---- and finally discard the cart ---- */
  resp.holdDeleted = await api('DELETE', `/api/holds/${hold.id}`, { token });

  return { resp, names };
}

/* ------------------------------ NORMALIZE ------------------------------ */

/** Columns whose value is an id: replaced by the label the scenario gave it. */
const ID_KEYS = new Set([
  'id',
  'branch_id',
  'company_id',
  'user_id',
  'queue_id',
  'hold_id',
  'hold_order_id',
  'transaction_id',
  'origin_uuid',
  'origin_ref',
  'product_id',
  'category_id',
  'from_branch_id',
  'to_branch_id',
  'transfer_id',
  'requested_by',
  'approved_by',
  'created_by',
  'started_by',
  'ready_by',
  'closed_by',
  'reference_id',
  'entity_id',
  'to_user_id',
  'parent_item_id',
  'device_id',
  'client_uuid',
]);

/** Columns whose value is wall-clock: only the presence is compared. */
const TS_KEYS = new Set([
  'created_at',
  'updated_at',
  'opened_at',
  'closed_at',
  'started_at',
  'ready_at',
  'completed_at',
  'shipped_at',
  'received_at',
  'last_seen',
  'last_login_at',
  'synced_at',
  'time',
  'server_time',
  'locked_until',
  'paired_at',
  'edge_paired_at',
  'edge_last_bootstrap_at',
  'edge_assets_synced_at',
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
      if (key === 'attempts' || key === 'last_error' || key === 'next_attempt_at') {
        // Written by the drain worker, which ticks while the scenario runs: whether a
        // lane has deferred yet is timing, not contract.
        out[key] = '<volatile>';
        continue;
      }
      if (key === 'ip' && raw != null) {
        // Node records Express's `req.ip` ("::ffff:127.0.0.1"); the shape is what matters.
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
      if (key === 'code' && typeof raw === 'string' && /^TRF-[0-9A-Z]+$/.test(raw)) {
        out[key] = '<code>';
        continue;
      }
      out[key] = scrub(raw, names);
    }
    return out;
  }
  return value;
}

/** Read and normalize the tables this scenario touches. */
function tablesFor(dbPath, names) {
  const db = new Database(dbPath, { readonly: true });
  const sql = (q) => db.prepare(q);
  const read = (table, order = 'rowid') => {
    const rows = sql(`SELECT * FROM ${table} ORDER BY ${order}`).all();
    return rows.map((r) => scrub(r, names));
  };
  const tables = {
    categories: read('categories'),
    products: read('products'),
    branches: read('branches'),
    users: read('users'),
    hold_orders: read('hold_orders'),
    hold_order_items: read('hold_order_items'),
    order_queue: read('order_queue'),
    order_queue_items: read('order_queue_items'),
    edge_hold_sync: read('edge_hold_sync', 'hold_id'),
    edge_queue_sync: read('edge_queue_sync', 'origin_uuid'),
    edge_login_attempts: read('edge_login_attempts', 'id'),
    shifts: read('shifts'),
    stock_transfers: read('stock_transfers'),
    stock_transfer_items: read('stock_transfer_items'),
    stock_movements: read('stock_movements'),
    branch_stocks: read('branch_stocks'),
    settings: read('settings', 'key'),
  };
  // Sorted by a normalized key so row order never matters where it should not.
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
 * A parity diff alone cannot catch "both implementations are wrong in the same
 * way", so the cart arithmetic and the ticket/stock rules are pinned here.
 */
function checkInvariants(label, resp, tables) {
  const fail = [];
  const eq = (what, actual, expected) => {
    if (actual !== expected) {
      fail.push(`${label}: ${what} = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  };
  const stockOf = (branch, product) =>
    tables.branch_stocks.find((s) => s.branch_id === branch && s.product_id === product)?.quantity ?? null;

  // 2 × 18000 + 1 × 8000 = 44000, + 2000 tax = 46000.
  eq('hold.subtotal', resp.hold.subtotal, 44000);
  eq('hold.tax', resp.hold.tax, 2000);
  eq('hold.total', resp.hold.total, 46000);
  eq('hold.lines', resp.hold.items.length, 2);
  eq('hold.label', resp.hold.label, 'Meja 3');
  // Parking raised a ticket for the drinks only: the uncategorised line is retail.
  eq('hold.queue_id', typeof resp.hold.queue_id, 'string');
  eq('ticket.lines', resp.ticket.items.length, 1);
  eq('ticket.station', resp.ticket.station, 'bar');
  eq('ticket.status', resp.ticket.status, 'queue');
  eq('ticket.ticket_no', resp.ticket.ticket_no, 1);
  eq('ticket.quantity', resp.ticket.items[0].quantity, 2);
  // The board shows the cart's wait time, not the insert time.
  eq(
    'ticket.created_at = hold.created_at',
    Date.parse(resp.ticket.created_at),
    Date.parse(`${resp.hold.created_at.replace(' ', 'T')}Z`),
  );

  eq('holdList rows', resp.holdList.length, 1);
  eq('holdList item_count', resp.holdList[0].item_count, 2);
  eq('holdRead lines', resp.holdRead.items.length, 2);

  eq('preparing sets started_at', resp.ticketPreparing.started_at === null, false);
  eq('ready sets ready_at', resp.ticketReady.ready_at === null, false);
  eq('illegal jump status', resp.ticketIllegal.status, 400);
  eq(
    'illegal jump message',
    resp.ticketIllegal.body.error,
    'Tidak bisa mengubah status dari ready ke queue',
  );
  eq('completed sets completed_at', resp.ticketDone.completed_at === null, false);
  eq('summary active', resp.queueSummary.active, 0);
  eq('summary completed', resp.queueSummary.completed, 1);
  eq('history rows', resp.queueHistory.length, 1);

  // Editing after the bar finished must not re-raise (or rewrite) the ticket: 3 × 18000
  // = 54000, the tax the caller omitted is kept, total 56000.
  eq('edited subtotal', resp.holdEdited.subtotal, 54000);
  eq('edited tax', resp.holdEdited.tax, 2000);
  eq('edited total', resp.holdEdited.total, 56000);
  eq('edited label', resp.holdEdited.label, 'Meja 5');
  eq('tickets for the hold', tables.order_queue.filter((q) => q.origin_ref === 'hold').length, 1);
  eq('ticket still completed', tables.order_queue[0].status, 'completed');
  eq('ticket lines after edit', tables.order_queue_items.length, 1);

  // Shift: float 200.000, no sales, drawer 190.000 → 10.000 short, flagged.
  eq('shift expected_cash', resp.shiftOpen.expected_cash, 200000);
  eq('shift reopen status', resp.shiftReopen.status, 400);
  eq(
    'shift reopen message',
    resp.shiftReopen.body.error,
    'Shift masih terbuka. Tutup shift terlebih dahulu.',
  );
  eq('handover amount', resp.shiftHandover.handover.amount, 50000);
  eq('current shift cash', resp.shiftCurrent.cash_sales, 0);
  eq('close difference', resp.shiftClose.difference, -10000);
  eq('close needs_review', resp.shiftClose.needs_review, true);
  eq('close tolerance', resp.shiftClose.tolerance, 5000);
  eq('reconcile ok', resp.shiftReconcile.ok, true);

  // Transfer: 5 kopi + 2 teh shipped, 4 kopi received → one unit lost on the road.
  eq('transfer status', resp.transfer.status, 'requested');
  eq('transfer code shape', /^TRF-[0-9A-Z]+$/.test(resp.transfer.code), true);
  eq('transfer lines', resp.transfer.items.length, 2);
  eq('transfer product_name', resp.transfer.items[0].product_name, 'Kopi Susu');
  eq('approved', resp.transferApproved.status, 'approved');
  eq('shipped', resp.transferShipped.status, 'shipped');
  eq('received', resp.transferReceived.status, 'received');
  eq('received quantity', resp.transferReceived.items[0].received_quantity, 4);
  eq('origin kopi after loss', stockOf('branch', 'kopi'), -6);
  eq('origin teh after ship', stockOf('branch', 'teh'), -2);
  eq('destination kopi', stockOf('branch-2', 'kopi'), 4);
  eq('destination teh', stockOf('branch-2', 'teh'), 2);
  eq('transfer list rows', resp.transferList.length, 1);
  eq('transfer list item_count', resp.transferList[0].item_count, 2);
  const movementTypes = tables.stock_movements.map((m) => `${m.type}:${m.quantity}`);
  eq(
    'stock movements',
    movementTypes.join(','),
    'transfer_out:-5,transfer_out:-2,transfer_in:4,transfer_loss:-1,transfer_in:2',
  );

  // The edge surface itself.
  eq('edge health mode', resp.edgeHealth.mode, 'edge');
  eq('edge health pending', resp.edgeHealth.queue.pending, 0);
  eq('edge config normalised', resp.edgeConfig.upstream, 'https://cloud.l5.test');
  eq('edge unlock offline', resp.edgeUnlock.offline, true);
  eq('edge unlock email', resp.edgeUnlock.user.email, COMPANY.email);
  eq(
    'edge unlock permissions',
    resp.edgeUnlock.permissions.includes('transaction.void'),
    true,
  );
  eq('wrong pin status', resp.edgeUnlockWrong.status, 401);
  eq('wrong pin remaining', resp.edgeUnlockWrong.body.remaining, 4);
  eq('pin branches', resp.edgePinBranches.branches.length, 1);
  eq('pin users', resp.edgePinUsers.length, 1);
  eq('pin users can_unlock', resp.edgePinUsers[0].can_unlock, true);

  // Discarding a cart whose ticket the bar already finished keeps the ticket: that work
  // is real, and deleting it would erase the production record.
  eq('delete queue_removed', resp.holdDeleted.queue_removed, 0);

  // The two sync lanes the mutations fed.
  eq('hold lane rows', tables.edge_hold_sync.length, 1);
  eq('hold lane tombstoned', tables.edge_hold_sync[0].payload.deleted, true);
  eq('hold lane ticket status', tables.edge_hold_sync[0].payload.queue.status, 'completed');
  eq('hold lane status', tables.edge_hold_sync[0].status, 'pending');
  eq('ticket lane rows', tables.edge_queue_sync.length, 1);
  eq('ticket lane kind', tables.edge_queue_sync[0].payload.kind, 'hold');
  eq('ticket lane status', tables.edge_queue_sync[0].payload.status, 'completed');

  return fail;
}

const RESPONSE_KEYS = [
  'hold',
  'holdList',
  'holdRead',
  'ticket',
  'ticketPreparing',
  'ticketReady',
  'ticketIllegal',
  'ticketDone',
  'queueSummary',
  'queueHistory',
  'holdEdited',
  'shiftOpen',
  'shiftReopen',
  'shiftHandover',
  'shiftCurrent',
  'shiftClose',
  'shiftReconcile',
  'transfer',
  'transferApproved',
  'transferShipped',
  'transferReceived',
  'transferList',
  'transferRead',
  'edgeHealth',
  'edgeConfig',
  'edgeQueue',
  'edgeUnlock',
  'edgeUnlockWrong',
  'edgePinBranches',
  'edgePinUsers',
  'holdDeleted',
];

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

  console.log('L5 parity — Node edge vs Rust edge\n');
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
    const n = await runScenario(node.baseUrl);
    const r = await runScenario(rust.baseUrl);
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

    // Response bodies, one check per route.
    for (const key of RESPONSE_KEYS) {
      checks += 1;
      const left = scrub(n.resp[key], n.names);
      const right = scrub(r.resp[key], r.names);
      if (!isDeepStrictEqual(left, right)) {
        failures += 1;
        showDiff(`response ${key}`, left, right);
      }
    }

    // And the rows those routes wrote.
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
    console.log(`\n✓ L5 parity green — ${checks} checks (${RESPONSE_KEYS.length} responses, 18 tables, invariants)`);
    for (const side of [node, rust]) rmSync(side.dataDir, { recursive: true, force: true });
    return;
  }
  console.error(`\n✗ L5 parity FAILED — ${failures} of ${checks} checks`);
  console.error(`  databases kept for inspection:\n    node: ${node.dbPath}\n    rust: ${rust.dbPath}`);
  process.exitCode = 1;
}

await main();
