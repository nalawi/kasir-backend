// L7 parity check: the rest of the route matrix, and the cross-format contracts.
//
// L4 pinned the money path, L5 the offline plumbing, L6 reports/docs/backup. What is
// left is everything a shop *administers*: signing in, the org chart, the catalog,
// the stock ledger, settings, the audit trail and the terminals. Those routes are
// covered by Rust tests but never by the oracle, so a divergence in them would only
// show up when a real owner clicked it.
//
// Three parts:
//
//   A. a scripted scenario replayed against both servers — auth (login, lockout,
//      password change, PIN, refresh rotation, logout), org (branches/users/roles),
//      catalog (categories/products/variants/price overrides/uploads), stock
//      (adjust/opname/threshold/movements), settings, audit and devices. Every
//      response body and every table those routes write is diffed.
//   B. a route sweep: each route with no token and with a cashier token. This is the
//      cheap way to cover the whole matrix — authentication and permission gates are
//      where a port silently drifts (`403` vs `404` vs `500`), and it needs no
//      scenario per route.
//   C. the cross-format contracts that a single-server test can never prove: a
//      Node-minted JWT verifies in Rust and a Rust-minted one in Node (both edges
//      sign with the same `EDGE_JWT_SECRET`), a `bcryptjs` hash verifies under the
//      Rust `bcrypt` crate and a Rust hash under `bcryptjs`, and the two databases
//      have byte-identical `sqlite_master` (schema, indexes, triggers).
//
// Usage:
//   cargo build --manifest-path frontend/src-tauri/pos-edge/Cargo.toml
//   node backend/test/parity/edge-l7.mjs        # or: cd backend && npm run parity:l7

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..', '..', '..');
const NODE_SERVER = path.join(ROOT, 'backend', 'src', 'server.js');
const RUST_BIN =
  process.env.RUST_EDGE_BIN ||
  path.join(ROOT, 'frontend', 'src-tauri', 'pos-edge', 'target', 'debug', 'pos-edge');

const BOOT_TIMEOUT_MS = 20_000;
// Both edges sign with this secret, which is what makes part C possible at all.
const SECRET = 'parity-secret-l7';
const COMPANY = { company_name: 'Toko L7', name: 'Sari', email: 'owner@l7.id', password: 'rahasia123' };
const NEW_PASSWORD = 'rahasia456';

/** The fixed identities part C inserts into *both* databases. */
const CROSS = {
  company: 'c0000000-0000-4000-8000-000000000001',
  branch: 'b0000000-0000-4000-8000-000000000001',
  nodeHashUser: 'u0000000-0000-4000-8000-00000000000a',
  rustHashUser: 'u0000000-0000-4000-8000-00000000000b',
  password: 'lintas123',
};

function tempDir(tag) {
  return mkdtempSync(path.join(tmpdir(), `pos-l7-${tag}-`));
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
  call.bytes = async (uri) => {
    const res = await fetch(baseUrl + uri);
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
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
 * Replay the administered surface against one server.
 *
 * Order matters and is part of the contract: the owner's password is changed (which
 * revokes every refresh token), the rotated refresh token is then spent, and the
 * resulting access token carries the rest of the scenario. Only a throwaway account
 * ever locks itself out, so the owner can still sign in afterwards.
 */
async function runScenario(server) {
  const api = apiFor(server.baseUrl);
  const names = makeNames();
  const resp = {};

  /* ---------- 1. register: a company, a branch, an owner ---------- */
  const reg = await api('POST', '/api/auth/register', { body: COMPANY });
  names.add('owner', reg.user.id);
  const branch1 = names.add('branch-1', reg.user.branch_id);
  resp.register = reg;

  /* ---------- 2. sign-in: wrong password, then the real one ---------- */
  resp.wrongPassword = await api.raw('POST', '/api/auth/login', {
    body: { email: COMPANY.email, password: 'salah-sekali' },
  });
  const login = await api('POST', '/api/auth/login', {
    body: { email: COMPANY.email, password: COMPANY.password },
  });
  let token = login.token;
  resp.login = login;
  resp.me = await api('GET', '/api/auth/me', { token });
  resp.meNoToken = await api.raw('GET', '/api/auth/me');
  resp.meBadToken = await api.raw('GET', '/api/auth/me', { token: 'not-a-jwt' });

  /* ---------- 3. lockout: six 401s, then a 429 with the policy ---------- */
  const lockUser = await api('POST', '/api/users', {
    token,
    body: {
      name: 'Lock',
      email: 'lock@l7.id',
      password: 'terkunci123',
      role: 'cashier',
      branch_id: branch1,
    },
  });
  names.add('lock-user', lockUser.id);
  const lockStatuses = [];
  for (let i = 0; i < 6; i += 1) {
    const r = await api.raw('POST', '/api/auth/login', {
      body: { email: 'lock@l7.id', password: 'salah' },
    });
    lockStatuses.push(r.status);
  }
  resp.lockStatuses = lockStatuses;
  resp.lockout = await api.raw('POST', '/api/auth/login', {
    body: { email: 'lock@l7.id', password: 'salah' },
  });

  /* ---------- 4. password change: wrong current, too short, then ok ---------- */
  resp.passwordWrongCurrent = await api.raw('PUT', '/api/auth/me/password', {
    token,
    body: { current_password: 'bukan-ini', new_password: NEW_PASSWORD },
  });
  resp.passwordTooShort = await api.raw('PUT', '/api/auth/me/password', {
    token,
    body: { current_password: COMPANY.password, new_password: '123' },
  });
  resp.passwordChanged = await api.raw('PUT', '/api/auth/me/password', {
    token,
    body: { current_password: COMPANY.password, new_password: NEW_PASSWORD },
  });
  resp.loginOldPassword = await api.raw('POST', '/api/auth/login', {
    body: { email: COMPANY.email, password: COMPANY.password },
  });
  const relogin = await api('POST', '/api/auth/login', {
    body: { email: COMPANY.email, password: NEW_PASSWORD },
  });
  token = relogin.token;
  resp.relogin = relogin;

  /* ---------- 5. refresh rotation, reuse and logout ---------- */
  resp.refreshRotate = await api.raw('POST', '/api/auth/refresh', {
    body: { refresh_token: relogin.refresh_token },
  });
  const rotated = JSON.parse(resp.refreshRotate.text);
  resp.refreshReuse = await api.raw('POST', '/api/auth/refresh', {
    body: { refresh_token: relogin.refresh_token },
  });
  resp.rotatedMe = await api.raw('GET', '/api/auth/me', { token: rotated.token });
  resp.logout = await api.raw('POST', '/api/auth/logout', {
    body: { refresh_token: rotated.refresh_token },
  });
  resp.refreshAfterLogout = await api.raw('POST', '/api/auth/refresh', {
    body: { refresh_token: rotated.refresh_token },
  });

  /* ---------- 6. the till's PIN unlock ---------- */
  resp.pinSetWrongPassword = await api.raw('PUT', '/api/auth/me/pin', {
    token,
    body: { password: 'nope', pin: '2468' },
  });
  resp.pinSetBadFormat = await api.raw('PUT', '/api/auth/me/pin', {
    token,
    body: { password: NEW_PASSWORD, pin: 'abcd' },
  });
  resp.pinSet = await api.raw('PUT', '/api/auth/me/pin', {
    token,
    body: { password: NEW_PASSWORD, pin: '2468' },
  });
  resp.pinBranches = await api('GET', '/api/auth/pin-branches');
  resp.pinUsers = await api('GET', `/api/auth/pin-users?branch_id=${branch1}`);
  resp.pinUsersNoBranch = await api.raw('GET', '/api/auth/pin-users');
  resp.pinLogin = await api.raw('POST', '/api/auth/pin-login', {
    body: { user_id: reg.user.id, pin: '2468' },
  });
  resp.pinLoginWrong = await api.raw('POST', '/api/auth/pin-login', {
    body: { user_id: reg.user.id, pin: '0000' },
  });

  /* ---------- 7. the company profile ---------- */
  resp.company = await api('GET', '/api/auth/company', { token });
  resp.companyUpdate = await api('PUT', '/api/auth/company', {
    token,
    body: { name: 'Toko L7 Baru', tax_percent: 11, timezone: 'Asia/Jakarta' },
  });

  /* ---------- 8. org: branches, users, roles ---------- */
  resp.branches = await api('GET', '/api/branches', { token });
  const branch2 = await api('POST', '/api/branches', {
    token,
    body: { name: 'Cabang Dua', address: 'Jl. Dua 2', phone: '081200000002' },
  });
  names.add('branch-2', branch2.id);
  resp.branchCreated = branch2;
  resp.branchUpdated = await api('PUT', `/api/branches/${branch2.id}`, {
    token,
    body: { name: 'Cabang Dua Baru' },
  });
  resp.branchMissing = await api.raw('PUT', '/api/branches/nope', { token, body: { name: 'x' } });

  resp.users = await api('GET', '/api/users', { token });
  const cashier = await api('POST', '/api/users', {
    token,
    body: {
      name: 'Kasir',
      email: 'kasir@l7.id',
      password: 'kasir123',
      role: 'cashier',
      branch_id: branch2.id,
    },
  });
  names.add('cashier', cashier.id);
  resp.userCreated = cashier;
  resp.userDuplicate = await api.raw('POST', '/api/users', {
    token,
    body: { name: 'Dup', email: 'KASIR@l7.id', password: 'apapun123' },
  });
  resp.userDeactivated = await api('PUT', `/api/users/${cashier.id}`, {
    token,
    body: { is_active: false },
  });
  resp.userSelfDeactivate = await api.raw('DELETE', `/api/users/${reg.user.id}`, { token });
  resp.userReactivated = await api('PUT', `/api/users/${cashier.id}`, {
    token,
    body: { is_active: true, name: 'Kasir Pagi' },
  });
  resp.userMissing = await api.raw('PUT', '/api/users/nope', { token, body: { name: 'x' } });

  const cashierLogin = await api('POST', '/api/auth/login', {
    body: { email: 'kasir@l7.id', password: 'kasir123' },
  });
  const cashierToken = cashierLogin.token;
  resp.cashierMe = await api('GET', '/api/auth/me', { token: cashierToken });
  resp.cashierCompanyUpdate = await api.raw('PUT', '/api/auth/company', {
    token: cashierToken,
    body: { name: 'Hijack' },
  });

  resp.roleCatalog = await api('GET', '/api/roles/catalog', { token });
  const role = await api('POST', '/api/roles', {
    token,
    body: { name: 'shift_lead', permissions: ['transaction.create', 'transaction.void'] },
  });
  names.add('role-shift-lead', role.id);
  resp.roleCreated = role;
  resp.roleBadName = await api.raw('POST', '/api/roles', { token, body: { name: 'Bad Name' } });
  resp.roleSystemClash = await api.raw('POST', '/api/roles', { token, body: { name: 'cashier' } });
  const roles = await api('GET', '/api/roles', { token });
  resp.roles = roles;
  resp.roleUpdated = await api('PUT', `/api/roles/${role.id}`, {
    token,
    body: { permissions: ['transaction.create'], description: 'Shift lead' },
  });
  resp.rolePermissionsBuiltin = await api('GET', '/api/roles/cashier/permissions', { token });
  resp.rolePermissionsCustom = await api('GET', '/api/roles/shift_lead/permissions', { token });

  // A role that is still held cannot be deleted; the message names the holder count.
  const roleStaf = await api('POST', '/api/roles', {
    token,
    body: { name: 'staf', permissions: ['transaction.create'] },
  });
  names.add('role-staf', roleStaf.id);
  const staf = await api('POST', '/api/users', {
    token,
    body: {
      name: 'Staf',
      email: 'staf@l7.id',
      password: 'staf12345',
      role: 'staf',
      branch_id: branch2.id,
    },
  });
  names.add('staf', staf.id);
  resp.roleUsedDelete = await api.raw('DELETE', `/api/roles/${roleStaf.id}`, { token });
  // Built-in roles live in code, not in the table, so a system row cannot be deleted
  // here; what the route must still answer is the plain 404 for an unknown id.
  resp.roleDeleteMissing = await api.raw('DELETE', '/api/roles/nope', { token });
  resp.roleDeleted = await api.raw('DELETE', `/api/roles/${role.id}`, { token });

  /* ---------- 9. catalog: categories, products, variants, overrides ---------- */
  resp.categoriesEmpty = await api('GET', '/api/categories', { token });
  const cat = await api('POST', '/api/categories', { token, body: { name: 'Minuman' } });
  names.add('cat-drinks', cat.id);
  resp.categoryCreated = cat;
  resp.categoryUpdated = await api('PUT', `/api/categories/${cat.id}`, {
    token,
    body: { name: 'Minuman Dingin' },
  });
  const catEmpty = await api('POST', '/api/categories', { token, body: { name: 'Lain-lain' } });
  names.add('cat-other', catEmpty.id);
  resp.categoryDeleted = await api.raw('DELETE', `/api/categories/${catEmpty.id}`, { token });
  resp.categoryMissing = await api.raw('DELETE', '/api/categories/nope', { token });
  resp.categories = await api('GET', '/api/categories', { token });

  const prod = await api('POST', '/api/products', {
    token,
    body: {
      name: 'Teh',
      sku: 'TEH-01',
      unit: 'cup',
      category_id: cat.id,
      default_price: 5000,
      cost_price: 2000,
      variants: [
        { name: 'Panas' },
        { name: 'Dingin', price_adjustment: 1000, is_default: true },
      ],
    },
  });
  names.add('prod-teh', prod.id);
  resp.productCreated = prod;
  resp.products = await api('GET', '/api/products', { token });
  resp.productsQ = await api('GET', '/api/products?q=teh', { token });
  resp.productsByCategory = await api('GET', `/api/products?category_id=${cat.id}`, { token });
  resp.productOne = await api('GET', `/api/products/${prod.id}`, { token });
  resp.productMissing = await api.raw('GET', '/api/products/nope', { token });
  resp.productUpdated = await api('PUT', `/api/products/${prod.id}`, {
    token,
    body: { name: 'Teh Manis', default_price: 6000 },
  });

  resp.variants = await api('GET', `/api/products/${prod.id}/variants`, { token });
  const variant = await api('POST', `/api/products/${prod.id}/variants`, {
    token,
    body: { name: 'Jumbo', price_adjustment: 2000 },
  });
  names.add('variant-jumbo', variant.id);
  resp.variantCreated = variant;
  resp.variantUpdated = await api('PUT', `/api/variants/${variant.id}`, {
    token,
    body: { name: 'Jumbo Besar' },
  });
  resp.variantDeleted = await api.raw('DELETE', `/api/variants/${variant.id}`, { token });

  resp.branchCatalog = await api('GET', `/api/branches/${branch1}/catalog`, { token });
  resp.branchProducts = await api('GET', `/api/branches/${branch1}/products`, { token });
  resp.priceOverride = await api('PUT', `/api/branches/${branch1}/products/${prod.id}`, {
    token,
    body: { price_override: 4500 },
  });
  resp.branchCatalogAfter = await api('GET', `/api/branches/${branch1}/catalog`, { token });

  // A second product is soft-deleted, so the list route has something to hide.
  const doomed = await api('POST', '/api/products', {
    token,
    body: { name: 'Kopi Bubuk', sku: 'KOPI-02', default_price: 15000, cost_price: 9000 },
  });
  names.add('prod-doomed', doomed.id);
  resp.productDeleted = await api.raw('DELETE', `/api/products/${doomed.id}`, { token });
  resp.productsAfterDelete = await api('GET', '/api/products', { token });

  /* ---------- 10. uploads: bytes land on disk and are served back ---------- */
  const upload = await api('POST', '/api/products/upload-image', {
    token,
    body: { image: 'data:image/png;base64,iVBORw0KGgo=' },
  });
  resp.upload = upload;
  const served = await api.bytes(upload.image_url);
  resp.uploadServed = { status: served.status, bytes: served.body.length };
  // A missing photo is Express's HTML 404 on one side and an empty 404 on the other;
  // the status is the contract, the boilerplate is not.
  resp.uploadMissing = { status: (await api.raw('GET', '/uploads/tidak-ada.png')).status };
  resp.uploadBad = await api.raw('POST', '/api/products/upload-image', {
    token,
    body: { image: 'not-an-image' },
  });

  /* ---------- 11. bulk import is a cloud feature: a till refuses it ---------- */
  resp.importFields = await api.raw('GET', '/api/products/import/fields', { token });
  resp.importTemplate = await api.raw('GET', '/api/products/import/template.csv', { token });
  resp.importPreview = await api.raw('POST', '/api/products/import/preview', { token, body: {} });
  resp.importApply = await api.raw('POST', '/api/products/import', { token, body: {} });

  /* ---------- 12. the stock ledger ---------- */
  resp.stockAdjustAdd = await api('POST', `/api/branches/${branch1}/stock/adjust`, {
    token,
    body: { product_id: prod.id, quantity: 5, type: 'add', note: 'restock' },
  });
  resp.stockAdjustSet = await api('POST', `/api/branches/${branch1}/stock/adjust`, {
    token,
    body: { product_id: prod.id, quantity: 3, type: 'set' },
  });
  resp.stockAdjustBadType = await api.raw('POST', `/api/branches/${branch1}/stock/adjust`, {
    token,
    body: { product_id: prod.id, quantity: 1, type: 'nonsense' },
  });
  resp.stockLow = await api('GET', '/api/stock/low', { token });
  resp.stockOverview = await api('GET', '/api/stock/overview', { token });
  resp.branchStock = await api('GET', `/api/branches/${branch1}/stock`, { token });
  resp.opname = await api('POST', `/api/branches/${branch1}/stock/opname`, {
    token,
    body: { items: [{ product_id: prod.id, counted: 8 }], note: 'hitung ulang' },
  });
  resp.opnameEmpty = await api.raw('POST', `/api/branches/${branch1}/stock/opname`, {
    token,
    body: { items: [] },
  });
  resp.threshold = await api('PUT', `/api/branches/${branch1}/stock/${prod.id}/threshold`, {
    token,
    body: { low_stock_threshold: 10 },
  });
  resp.movements = await api('GET', `/api/branches/${branch1}/movements`, { token });
  resp.stockLowAfter = await api('GET', '/api/stock/low', { token });

  /* ---------- 12b. the kitchen board (KDS) ---------- */
  // The board's own client always sends `station=` (the picker's default is `all`), and
  // it renders the *list* while the header renders the *summary*. Those two must agree,
  // or a till shows "1 waiting" over an empty board — the exact shape of the bug this
  // section was added for.
  const barTicket = await api('POST', '/api/queue', {
    token,
    body: {
      branch_id: branch1,
      items: [{ product_id: prod.id, quantity: 2 }],
      order_label: 'Meja 4',
      table_number: '4',
    },
  });
  names.add('ticket-bar', barTicket.id);
  resp.kdsTicketBar = barTicket;
  // A walk-in line with no product belongs on every station screen.
  const walkIn = await api('POST', '/api/queue', {
    token,
    body: { branch_id: branch1, items: [{ product_name: 'Air Mineral', quantity: 1 }], customer_name: 'Budi' },
  });
  names.add('ticket-both', walkIn.id);
  resp.kdsTicketBoth = walkIn;

  resp.kdsBoardAll = await api('GET', `/api/branches/${branch1}/queue?scope=active&station=all`, { token });
  resp.kdsBoardEmptyStation = await api('GET', `/api/branches/${branch1}/queue?scope=active&station=`, { token });
  resp.kdsBoardNoStation = await api('GET', `/api/branches/${branch1}/queue`, { token });
  resp.kdsBoardBar = await api('GET', `/api/branches/${branch1}/queue?station=bar`, { token });
  resp.kdsBoardKitchen = await api('GET', `/api/branches/${branch1}/queue?station=kitchen`, { token });
  resp.kdsBoardScopeAll = await api('GET', `/api/branches/${branch1}/queue?scope=all&station=all`, { token });
  resp.kdsSummary = await api('GET', `/api/branches/${branch1}/queue/summary`, { token });
  resp.kdsTicketOne = await api('GET', `/api/queue/${barTicket.id}`, { token });

  resp.kdsStart = await api('PATCH', `/api/queue/${barTicket.id}/status`, {
    token,
    body: { status: 'preparing' },
  });
  resp.kdsLineDone = await api('PATCH', `/api/queue/${barTicket.id}/status`, {
    token,
    body: { status: 'preparing', item_id: barTicket.items[0].id, done: true },
  });
  // One step at a time: skipping straight to served is refused with Node's wording.
  resp.kdsIllegal = await api.raw('PATCH', `/api/queue/${barTicket.id}/status`, {
    token,
    body: { status: 'completed' },
  });
  resp.kdsReady = await api('PATCH', `/api/queue/${barTicket.id}/status`, {
    token,
    body: { status: 'ready' },
  });
  resp.kdsComplete = await api('PATCH', `/api/queue/${barTicket.id}/status`, {
    token,
    body: { status: 'completed' },
  });
  resp.kdsHistory = await api('GET', `/api/branches/${branch1}/queue?scope=history&station=all`, { token });
  resp.kdsCancelNoReason = await api.raw('PATCH', `/api/queue/${walkIn.id}/status`, {
    token,
    body: { status: 'cancelled' },
  });
  resp.kdsCancelled = await api('PATCH', `/api/queue/${walkIn.id}/status`, {
    token,
    body: { status: 'cancelled', reason: 'salah input' },
  });
  resp.kdsReopen = await api('PATCH', `/api/queue/${walkIn.id}/status`, {
    token,
    body: { status: 'queue' },
  });
  resp.kdsDeleteMissing = await api.raw('DELETE', '/api/queue/tidak-ada', { token });
  resp.kdsDelete = await api.raw('DELETE', `/api/queue/${walkIn.id}`, { token });
  resp.kdsBoardAfterDelete = await api('GET', `/api/branches/${branch1}/queue?station=all`, { token });
  resp.kdsSummaryAfter = await api('GET', `/api/branches/${branch1}/queue/summary`, { token });

  /* ---------- 13. settings: an allowlist, not a free-form key/value store ---------- */
  resp.settings = await api('GET', '/api/settings', { token });
  resp.settingsUpdate = await api('PUT', '/api/settings', {
    token,
    body: { allow_negative_stock: 'ignore', tax_percent: 12 },
  });
  resp.settingsUnknown = await api.raw('PUT', '/api/settings', { token, body: { bogus: 1 } });
  resp.settingsBadEnum = await api.raw('PUT', '/api/settings', {
    token,
    body: { allow_negative_stock: 'zzz' },
  });
  resp.settingsEmpty = await api.raw('PUT', '/api/settings', { token, body: {} });
  resp.settingsAfter = await api('GET', '/api/settings', { token });

  /* ---------- 14. the audit trail ---------- */
  resp.auditAll = await api('GET', '/api/audit-logs?limit=20', { token });
  resp.auditSettings = await api('GET', '/api/audit-logs?action=settings.update', { token });
  resp.auditPaged = await api('GET', '/api/audit-logs?page=2&limit=5', { token });
  resp.auditEntity = await api('GET', '/api/audit-logs?entity=product', { token });
  resp.auditQ = await api('GET', '/api/audit-logs?q=Teh', { token });
  resp.auditActions = await api('GET', '/api/audit-logs/actions', { token });

  /* ---------- 15. terminals ---------- */
  const device = await api('POST', '/api/devices/register', {
    token,
    body: {
      branch_id: branch1,
      identifier: 'till-a',
      name: 'Kasir 1',
      platform: 'macos',
      app_version: '1.0.0',
    },
  });
  names.add('device-1', device.id);
  resp.deviceRegistered = device;
  resp.deviceAgain = await api('POST', '/api/devices/register', {
    token,
    body: { branch_id: branch1, identifier: 'till-a', name: 'Kasir Depan' },
  });
  resp.deviceHeartbeat = await api('POST', `/api/devices/${device.id}/heartbeat`, {
    token,
    body: { app_version: '1.1.0' },
  });
  resp.deviceRemoteLogout = await api('POST', `/api/devices/${device.id}/remote-logout`, {
    token,
    body: { reason: 'hilang' },
  });
  resp.deviceUpdate = await api('PUT', `/api/devices/${device.id}`, {
    token,
    body: { is_active: false },
  });
  resp.deviceHeartbeatRefused = await api.raw('POST', `/api/devices/${device.id}/heartbeat`, {
    token,
    body: {},
  });
  resp.devices = await api('GET', `/api/branches/${branch1}/devices`, { token });

  const ids = {
    branch1,
    branch2: branch2.id,
    product: prod.id,
    category: cat.id,
    user: cashier.id,
    device: device.id,
  };
  return { resp, names, token, cashierToken, ids };
}

/* -------------------------------- SCRUB -------------------------------- */

/** Every column that holds an id minted by one server and referenced by another. */
const ID_KEYS = new Set([
  'id',
  'branch_id',
  'company_id',
  'companyId',
  'user_id',
  'role_id',
  'product_id',
  'category_id',
  'variant_id',
  'device_id',
  'queue_id',
  'hold_order_id',
  'reference_id',
  'entity_id',
  'approved_by',
  'created_by',
  'started_by',
  'ready_by',
  'closed_by',
  'to_user_id',
  'from_user_id',
  'parent_item_id',
  'origin_uuid',
  'client_uuid',
]);

/** Columns whose value is wall-clock: only the presence is compared. */
const TS_KEYS = new Set([
  'created_at',
  'updated_at',
  'deleted_at',
  'createdAt',
  'last_login_at',
  'last_seen',
  'pin_set_at',
  'expires_at',
  'revoked_at',
  'refresh_expires_at',
  'server_time',
  'synced_at',
  'time',
  'window_start',
]);

const BCRYPT = /^\$2[aby]\$\d\d\$/;
/** A wall-clock value under a column we have not named. */
const DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;
const FILE_URL = /\/uploads\/p_[0-9a-f]+\.\w+/g;

/**
 * A `raw` response compared by status and parsed body.
 *
 * The serialized `text` is the same JSON with its keys in a different order (Node and
 * serde each emit what they built), and `4` vs `4.0` is a cosmetic difference in
 * number formatting; the parsed body is the contract.
 */
function normalizeResponse(value) {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.status === 'number' &&
    'body' in value
  ) {
    return { status: value.status, body: value.body };
  }
  return value;
}

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

/** Replace ids, timestamps, credentials and upload names with stable placeholders. */
function scrub(value, names) {
  if (typeof value === 'string') {
    if (DATETIME.test(value)) return '<ts>';
    const cleaned = value.replace(FILE_URL, '/uploads/<file>');
    if (cleaned !== value) return cleaned;
    return value;
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
      if (key === 'device_key') {
        out[key] = raw == null ? null : '<key>';
        continue;
      }
      // The PIN lockout keys attempts by `pin:<user id>`, which is per-server.
      if (key === 'identifier' && typeof raw === 'string' && /^pin:[0-9a-f]{32}$/.test(raw)) {
        out[key] = 'pin:<user>';
        continue;
      }
      if (key === 'token_hash' && typeof raw === 'string') {
        out[key] = '<token-hash>';
        continue;
      }
      if ((key === 'password_hash' || key === 'pin_hash') && typeof raw === 'string') {
        // The salt is random on both sides; the bcrypt cost is the contract.
        out[key] = BCRYPT.test(raw) ? '<bcrypt cost=10>' : raw;
        continue;
      }
      if (key === 'image_url' && typeof raw === 'string') {
        out[key] = raw.replace(FILE_URL, '/uploads/<file>');
        continue;
      }
      out[key] = scrub(raw, names);
    }
    return out;
  }
  return value;
}

/** Read and normalize the tables these routes write. */
function tablesFor(dbPath, names) {
  const db = new Database(dbPath, { readonly: true });
  const sql = (q) => db.prepare(q);
  /** Tables with a contractual order. */
  const read = (table, order) =>
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
    companies: read('companies', 'id'),
    branches: read('branches', 'name'),
    users: read('users', 'email'),
    roles: read('roles', 'name'),
    categories: read('categories', 'name'),
    products: read('products', 'sku, name'),
    product_variants: readSorted('product_variants'),
    branch_products: readSorted('branch_products'),
    branch_stocks: readSorted('branch_stocks'),
    stock_movements: readSorted('stock_movements'),
    // The board's own tables: ticket_no, station, status and the done flags on the
    // lines are what the two screens read, so they are compared row by row.
    order_queue: readSorted('order_queue'),
    order_queue_items: readSorted('order_queue_items'),
    settings: read('settings', 'key'),
    audit_logs: readSorted('audit_logs'),
    devices: read('devices', 'identifier, name'),
    refresh_tokens: readSorted('refresh_tokens'),
    login_attempts: readSorted('login_attempts'),
  };
  db.close();
  return tables;
}

/** The schema itself: tables, indexes and triggers, in one comparable string. */
function schemaFor(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
      .all()
      // Inline SQL comments are documentation, not behaviour: strip them, so the
      // comparison is about objects, columns, types and constraints.
      .map(
        (r) =>
          `${r.type} ${r.name}: ${String(r.sql || '')
            .replace(/--[^\n]*/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()}`,
      );
  } finally {
    db.close();
  }
}

/* ----------------------------- ROUTE SWEEP ----------------------------- */

/**
 * Every route in the app, as `(method, path, body)`.
 *
 * `anon` is the status the route must answer without a token: `401` for everything
 * behind `authRequired`, `200` for the handful of genuinely public routes, and
 * `'any'` where the router has no opinion (the sweep still requires both servers to
 * agree). Nothing here may answer 5xx — that is what a half-ported route does.
 */
const NOPE = 'does-not-exist';
const SWEEP = [
  { method: 'GET', path: () => '/api/health', anon: 200 },
  { method: 'GET', path: () => '/api/openapi.json', anon: 200 },
  { method: 'GET', path: () => '/api/permissions', anon: 200 },
  { method: 'GET', path: () => '/api/auth/pin-branches', anon: 200 },
  { method: 'GET', path: (i) => `/api/auth/pin-users?branch_id=${i.branch1}`, anon: 200 },
  { method: 'GET', path: () => '/api/edge/pin-branches', anon: 'any' },
  { method: 'GET', path: () => '/api/edge/pin-users', anon: 'any' },
  { method: 'GET', path: () => '/api/edge/health', anon: 'any' },
  { method: 'GET', path: () => '/api/auth/me' },
  { method: 'PUT', path: () => '/api/auth/me/password', body: {} },
  { method: 'PUT', path: () => '/api/auth/me/pin', body: {} },
  { method: 'GET', path: () => '/api/auth/company' },
  { method: 'PUT', path: () => '/api/auth/company', body: {} },
  { method: 'GET', path: () => '/api/branches' },
  { method: 'POST', path: () => '/api/branches', body: {} },
  { method: 'PUT', path: (i) => `/api/branches/${i.branch1}`, body: {} },
  { method: 'GET', path: () => '/api/users' },
  { method: 'POST', path: () => '/api/users', body: {} },
  { method: 'PUT', path: (i) => `/api/users/${i.user}`, body: {} },
  { method: 'DELETE', path: (i) => `/api/users/${i.user}` },
  { method: 'GET', path: () => '/api/roles/catalog' },
  { method: 'GET', path: () => '/api/roles' },
  { method: 'POST', path: () => '/api/roles', body: {} },
  { method: 'PUT', path: () => `/api/roles/${NOPE}`, body: {} },
  { method: 'DELETE', path: () => `/api/roles/${NOPE}` },
  { method: 'GET', path: () => '/api/roles/cashier/permissions' },
  { method: 'GET', path: () => '/api/categories' },
  { method: 'POST', path: () => '/api/categories', body: {} },
  { method: 'PUT', path: (i) => `/api/categories/${i.category}`, body: {} },
  { method: 'DELETE', path: () => `/api/categories/${NOPE}` },
  { method: 'GET', path: () => '/api/products' },
  { method: 'POST', path: () => '/api/products', body: {} },
  { method: 'GET', path: (i) => `/api/products/${i.product}` },
  { method: 'PUT', path: (i) => `/api/products/${i.product}`, body: {} },
  { method: 'DELETE', path: () => `/api/products/${NOPE}` },
  { method: 'GET', path: (i) => `/api/products/${i.product}/variants` },
  { method: 'POST', path: (i) => `/api/products/${i.product}/variants`, body: {} },
  { method: 'PUT', path: () => `/api/variants/${NOPE}`, body: {} },
  { method: 'DELETE', path: () => `/api/variants/${NOPE}` },
  { method: 'GET', path: () => '/api/products/import/fields' },
  { method: 'GET', path: () => '/api/products/import/template.csv' },
  { method: 'POST', path: () => '/api/products/import/preview', body: {} },
  { method: 'POST', path: () => '/api/products/import', body: {} },
  { method: 'POST', path: () => '/api/products/upload-image', body: {} },
  { method: 'GET', path: (i) => `/api/branches/${i.branch1}/catalog` },
  { method: 'GET', path: (i) => `/api/branches/${i.branch1}/products` },
  { method: 'PUT', path: (i) => `/api/branches/${i.branch1}/products/${i.product}`, body: {} },
  { method: 'GET', path: (i) => `/api/branches/${i.branch1}/stock` },
  { method: 'GET', path: () => '/api/stock/overview' },
  { method: 'GET', path: () => '/api/stock/low' },
  { method: 'GET', path: (i) => `/api/branches/${i.branch1}/movements` },
  { method: 'POST', path: (i) => `/api/branches/${i.branch1}/stock/adjust`, body: {} },
  { method: 'POST', path: (i) => `/api/branches/${i.branch1}/stock/opname`, body: {} },
  { method: 'PUT', path: (i) => `/api/branches/${i.branch1}/stock/${i.product}/threshold`, body: {} },
  { method: 'GET', path: () => '/api/settings' },
  { method: 'PUT', path: () => '/api/settings', body: {} },
  { method: 'GET', path: () => '/api/audit-logs' },
  { method: 'GET', path: () => '/api/audit-logs/actions' },
  { method: 'GET', path: (i) => `/api/branches/${i.branch1}/devices` },
  { method: 'POST', path: () => '/api/devices/register', body: {} },
  { method: 'POST', path: (i) => `/api/devices/${i.device}/heartbeat`, body: {} },
  { method: 'PUT', path: (i) => `/api/devices/${i.device}`, body: {} },
  { method: 'POST', path: (i) => `/api/devices/${i.device}/remote-logout`, body: {} },
];

// The rest of the matrix: the money path, offline plumbing and reports are covered by
// L4–L6 scenario by scenario, but the sweep still walks them so a *gate* regression
// (401/403 drift) cannot hide in the corner those oracles do not touch.
SWEEP.push(
  { method: 'GET', path: () => '/api/transactions' },
  { method: 'POST', path: () => '/api/transactions', body: {} },
  { method: 'POST', path: () => '/api/transactions/quote', body: {} },
  { method: 'GET', path: () => `/api/transactions/${NOPE}` },
  { method: 'GET', path: () => `/api/transactions/${NOPE}/receipt` },
  { method: 'POST', path: () => `/api/transactions/${NOPE}/void`, body: {} },
  { method: 'GET', path: () => '/api/shifts/current' },
  { method: 'GET', path: () => '/api/shifts' },
  { method: 'POST', path: () => '/api/shifts/open', body: {} },
  { method: 'GET', path: () => `/api/shifts/${NOPE}` },
  { method: 'POST', path: () => `/api/shifts/${NOPE}/close`, body: {} },
  { method: 'POST', path: () => `/api/shifts/${NOPE}/handover`, body: {} },
  { method: 'POST', path: () => `/api/shifts/${NOPE}/reconcile`, body: {} },
  { method: 'GET', path: (i) => `/api/branches/${i.branch1}/queue` },
  { method: 'GET', path: (i) => `/api/branches/${i.branch1}/queue?scope=active&station=all` },
  { method: 'GET', path: (i) => `/api/branches/${i.branch1}/queue?scope=history&station=bar` },
  { method: 'GET', path: (i) => `/api/branches/${i.branch1}/queue/summary` },
  { method: 'POST', path: () => '/api/queue', body: {} },
  { method: 'GET', path: () => `/api/queue/${NOPE}` },
  { method: 'DELETE', path: () => `/api/queue/${NOPE}` },
  { method: 'PATCH', path: () => `/api/queue/${NOPE}/status`, body: {} },
  { method: 'GET', path: (i) => `/api/branches/${i.branch1}/holds` },
  { method: 'POST', path: () => '/api/holds', body: {} },
  { method: 'GET', path: () => `/api/holds/${NOPE}` },
  { method: 'PUT', path: () => `/api/holds/${NOPE}`, body: {} },
  { method: 'DELETE', path: () => `/api/holds/${NOPE}` },
  { method: 'GET', path: () => '/api/transfers' },
  { method: 'POST', path: () => '/api/transfers', body: {} },
  { method: 'GET', path: () => `/api/transfers/${NOPE}` },
  { method: 'POST', path: () => `/api/transfers/${NOPE}/approve`, body: {} },
  { method: 'POST', path: () => `/api/transfers/${NOPE}/ship`, body: {} },
  { method: 'POST', path: () => `/api/transfers/${NOPE}/receive`, body: {} },
  { method: 'POST', path: () => `/api/transfers/${NOPE}/reject`, body: {} },
  { method: 'GET', path: () => '/api/reports/summary' },
  { method: 'GET', path: () => '/api/reports/sales' },
  { method: 'GET', path: () => '/api/reports/products' },
  { method: 'GET', path: () => '/api/reports/cashiers' },
  { method: 'GET', path: () => '/api/reports/profit' },
  { method: 'GET', path: () => '/api/reports/daily-brief' },
  { method: 'GET', path: () => '/api/reports/daily-brief/text' },
  { method: 'GET', path: () => '/api/reports/export/transactions.csv' },
  { method: 'GET', path: () => '/api/reports/export/products.csv' },
  { method: 'GET', path: () => '/api/reports/export/stock.csv' },
  { method: 'GET', path: () => '/api/reports/export/shifts.csv' },
  { method: 'GET', path: () => '/api/backup/categories' },
  { method: 'GET', path: () => '/api/backup' },
  { method: 'POST', path: () => '/api/backup/preview', body: {} },
  { method: 'POST', path: () => '/api/backup/restore', body: {} },
  { method: 'GET', path: () => '/api/edge/info' },
  { method: 'PUT', path: () => '/api/edge/config', body: {} },
  { method: 'GET', path: () => '/api/edge/queue' },
  { method: 'GET', path: () => '/api/edge/queue/problems' },
  { method: 'POST', path: () => '/api/edge/queue/retry', body: {} },
  { method: 'POST', path: () => '/api/edge/drain', body: {} },
  { method: 'GET', path: () => '/api/edge/cloud-branches' },
  { method: 'POST', path: () => '/api/edge/pair', body: {} },
  { method: 'POST', path: () => '/api/edge/bootstrap', body: {} },
  { method: 'POST', path: () => '/api/edge/sync-assets', body: {} },
  { method: 'POST', path: () => '/api/edge/unlock', body: {} },
  { method: 'GET', path: () => '/uploads/tidak-ada.png', anon: 404 },
  { method: 'GET', path: () => '/api/does-not-exist', anon: 404 },
);

/* ------------------------------- CHECKS ------------------------------- */

/**
 * Facts that must hold on *each* server, independently of the other one.
 *
 * The diff below catches drift; this catches "both implementations are wrong in the
 * same way" — a 500 answered by both, a permission that quietly disappeared from
 * both, a lockout that stopped locking.
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

  /* auth */
  eq('register.user.email', resp.register.user.email, COMPANY.email);
  eq('register has company.manage', resp.register.permissions.includes('company.manage'), true);
  eq('wrongPassword.status', resp.wrongPassword.status, 401);
  eq('wrongPassword.error', resp.wrongPassword.body.error, 'Invalid credentials');
  eq('meNoToken.status', resp.meNoToken.status, 401);
  eq('meBadToken.status', resp.meBadToken.status, 401);
  eq('me.user.email', resp.me.user.email, COMPANY.email);
  eq('lock statuses', resp.lockStatuses, [401, 401, 401, 401, 401, 401]);
  eq('lockout.status', resp.lockout.status, 429);
  eq('lockout.max_fails', resp.lockout.body.lock.max_fails, 6);
  eq('lockout.window_minutes', resp.lockout.body.lock.window_minutes, 15);
  eq('passwordWrongCurrent.status', resp.passwordWrongCurrent.status, 400);
  eq('passwordWrongCurrent.error', resp.passwordWrongCurrent.body.error, 'Password lama salah');
  eq('passwordTooShort.status', resp.passwordTooShort.status, 400);
  eq('passwordChanged.status', resp.passwordChanged.status, 200);
  eq('loginOldPassword.status', resp.loginOldPassword.status, 401);
  eq('relogin.user.email', resp.relogin.user.email, COMPANY.email);
  eq('refreshRotate.status', resp.refreshRotate.status, 200);
  eq('refreshReuse.status', resp.refreshReuse.status, 401);
  eq('rotatedMe.status', resp.rotatedMe.status, 200);
  eq('logout.status', resp.logout.status, 200);
  eq('refreshAfterLogout.status', resp.refreshAfterLogout.status, 401);

  /* PIN */
  eq('pinSetWrongPassword.status', resp.pinSetWrongPassword.status, 400);
  eq('pinSetBadFormat.status', resp.pinSetBadFormat.status, 400);
  eq('pinSet.status', resp.pinSet.status, 200);
  eq('pinBranches.branches', resp.pinBranches.branches.length, 1);
  eq('pinUsers rows', resp.pinUsers.length, 1);
  eq('pinUsers[0].name', resp.pinUsers[0].name, 'Sari');
  eq('pinUsersNoBranch.status', resp.pinUsersNoBranch.status, 400);
  eq('pinLogin.status', resp.pinLogin.status, 200);
  eq('pinLoginWrong.status', resp.pinLoginWrong.status, 401);
  eq('pinLoginWrong.error', resp.pinLoginWrong.body.error, 'PIN salah');

  /* company */
  eq('company.name', resp.company.name, COMPANY.company_name);
  eq('companyUpdate.name', resp.companyUpdate.name, 'Toko L7 Baru');
  eq('companyUpdate.tax_percent', resp.companyUpdate.tax_percent, 11);
  eq('companyUpdate.timezone', resp.companyUpdate.timezone, 'Asia/Jakarta');

  /* org */
  eq('branches count', resp.branches.length, 1);
  eq('branchCreated.name', resp.branchCreated.name, 'Cabang Dua');
  eq('branchUpdated.name', resp.branchUpdated.name, 'Cabang Dua Baru');
  eq('branchUpdated.is_active', resp.branchUpdated.is_active, 1);
  eq('branchMissing.status', resp.branchMissing.status, 404);
  eq('users count', resp.users.length, 2);
  eq('userCreated.role', resp.userCreated.role, 'cashier');
  eq('userDuplicate.status', resp.userDuplicate.status, 409);
  eq('userDuplicate.error', resp.userDuplicate.body.error, 'Email exists');
  eq('userDeactivated.is_active', resp.userDeactivated.is_active, 0);
  eq('userSelfDeactivate.status', resp.userSelfDeactivate.status, 400);
  eq(
    'userSelfDeactivate.error',
    resp.userSelfDeactivate.body.error,
    'Tidak bisa menonaktifkan akun sendiri',
  );
  eq('userReactivated.is_active', resp.userReactivated.is_active, 1);
  eq('userReactivated.name', resp.userReactivated.name, 'Kasir Pagi');
  eq('userMissing.status', resp.userMissing.status, 404);
  eq('cashierMe.user.role', resp.cashierMe.user.role, 'cashier');
  eq('cashierMe has no company.manage', resp.cashierMe.permissions.includes('company.manage'), false);
  eq('cashierCompanyUpdate.status', resp.cashierCompanyUpdate.status, 403);
  eq('roleCreated.name', resp.roleCreated.name, 'shift_lead');
  eq('roleCreated.is_system', resp.roleCreated.is_system, 0);
  eq('roleBadName.status', resp.roleBadName.status, 400);
  eq('roleSystemClash.status', resp.roleSystemClash.status, 400);
  eq(
    'roleSystemClash.error',
    resp.roleSystemClash.body.error,
    'Nama role bentrok dengan role sistem',
  );
  eq('roles.custom count', resp.roles.custom.length, 1);
  eq('roles.builtin names', resp.roles.builtin.map((r) => r.key), [
    'super_admin',
    'manager',
    'cashier',
    'kitchen',
    'warehouse',
  ]);
  eq('roles.custom none system', resp.roles.custom.every((r) => r.is_system === false), true);
  eq('roleUpdated.permissions', resp.roleUpdated.permissions, ['transaction.create']);
  eq('roleUpdated.description', resp.roleUpdated.description, 'Shift lead');
  eq(
    'rolePermissionsBuiltin has transaction.create',
    resp.rolePermissionsBuiltin.permissions.includes('transaction.create'),
    true,
  );
  eq('rolePermissionsCustom', resp.rolePermissionsCustom.permissions, ['transaction.create']);
  eq('roleUsedDelete.status', resp.roleUsedDelete.status, 400);
  eq(
    'roleUsedDelete.error',
    resp.roleUsedDelete.body.error,
    'Role masih dipakai oleh 1 pengguna',
  );
  eq('roleDeleteMissing.status', resp.roleDeleteMissing.status, 404);
  eq('roleDeleted.status', resp.roleDeleted.status, 200);

  /* catalog */
  eq('categoriesEmpty', resp.categoriesEmpty, []);
  eq('categoryUpdated.name', resp.categoryUpdated.name, 'Minuman Dingin');
  eq('categoryDeleted.status', resp.categoryDeleted.status, 200);
  eq('categoryMissing.status', resp.categoryMissing.status, 404);
  eq('categories count', resp.categories.length, 1);
  eq('productCreated.default_price', resp.productCreated.default_price, 5000);
  eq('productCreated.cost_price', resp.productCreated.cost_price, 2000);
  eq('products count', resp.products.length, 1);
  eq('productsQ count', resp.productsQ.length, 1);
  eq('productsByCategory count', resp.productsByCategory.length, 1);
  eq('productOne.variants', resp.productOne.variants.length, 2);
  eq('productMissing.status', resp.productMissing.status, 404);
  eq('productUpdated.name', resp.productUpdated.name, 'Teh Manis');
  eq('productUpdated.default_price', resp.productUpdated.default_price, 6000);
  eq('variants count', resp.variants.length, 2);
  eq('variantCreated.name', resp.variantCreated.name, 'Jumbo');
  eq('variantUpdated.name', resp.variantUpdated.name, 'Jumbo Besar');
  eq('variantDeleted.status', resp.variantDeleted.status, 200);
  eq('priceOverride.price', resp.priceOverride.price, 4500);
  eq('productDeleted.status', resp.productDeleted.status, 200);
  eq('productsAfterDelete skus', resp.productsAfterDelete.map((p) => p.sku), ['TEH-01']);

  /* uploads + import */
  eq('upload.image_url', /^\/uploads\/p_[0-9a-f]+\.png$/.test(resp.upload.image_url), true);
  eq('uploadServed', resp.uploadServed, { status: 200, bytes: 8 });
  eq('uploadMissing.status', resp.uploadMissing.status, 404);
  eq('uploadBad.status', resp.uploadBad.status, 400);
  for (const key of ['importFields', 'importTemplate', 'importPreview', 'importApply']) {
    eq(`${key}.status`, resp[key].status, 409);
    eq(`${key}.error`, /hanya tersedia di server pusat/.test(resp[key].body.error), true);
  }

  /* stock */
  eq('stockAdjustAdd.quantity', resp.stockAdjustAdd.quantity, 5);
  eq('stockAdjustAdd.delta', resp.stockAdjustAdd.delta, 5);
  eq('stockAdjustSet.quantity', resp.stockAdjustSet.quantity, 3);
  eq('stockAdjustSet.delta', resp.stockAdjustSet.delta, -2);
  // An unknown `type` is treated as an additive adjust on both builds — pinned here
  // because it looks like a validation gap but is the shared behaviour (Node falls
  // through to its default branch).
  eq('stockAdjustBadType.status', resp.stockAdjustBadType.status, 200);
  eq('stockAdjustBadType body', resp.stockAdjustBadType.body, {
    product_id: resp.stockAdjustBadType.body.product_id,
    quantity: 4,
    delta: 1,
  });
  eq('stockLow count', resp.stockLow.length, 1);
  eq(
    'opname line',
    {
      before: resp.opname.lines[0].before,
      counted: resp.opname.lines[0].counted,
      delta: resp.opname.lines[0].delta,
    },
    { before: 4, counted: 8, delta: 4 },
  );
  eq('opnameEmpty.status', resp.opnameEmpty.status, 400);
  eq('threshold.low_stock_threshold', resp.threshold.low_stock_threshold, 10);
  eq('movements count', resp.movements.length, 4);
  eq('stockLowAfter count', resp.stockLowAfter.length, 1);
  eq(
    'branchStock line',
    [resp.branchStock[0].quantity, resp.branchStock[0].is_low, resp.branchStock[0].low_stock_threshold],
    [4, 1, 5],
  );
  eq('stockOverview rows', resp.stockOverview.rows.length, 1);
  eq('stockOverview branches', resp.stockOverview.branches.length, 2);

  /* kitchen board */
  const ticketNos = (rows) => rows.map((r) => r.ticket_no);
  eq('kdsTicketBar.station', resp.kdsTicketBar.station, 'bar');
  eq('kdsTicketBar.ticket_no', resp.kdsTicketBar.ticket_no, 1);
  eq('kdsTicketBoth.station', resp.kdsTicketBoth.station, 'both');
  eq('kdsTicketBoth.ticket_no', resp.kdsTicketBoth.ticket_no, 2);
  // `station=all` is the whole board — not a station name, which would hide everything.
  eq('kdsBoardAll ticket_nos', ticketNos(resp.kdsBoardAll), [1, 2]);
  eq('kdsBoardEmptyStation ticket_nos', ticketNos(resp.kdsBoardEmptyStation), [1, 2]);
  eq('kdsBoardNoStation ticket_nos', ticketNos(resp.kdsBoardNoStation), [1, 2]);
  // A station screen shows its own tickets plus the `both` ones, never the other's.
  eq('kdsBoardBar ticket_nos', ticketNos(resp.kdsBoardBar), [1, 2]);
  eq('kdsBoardKitchen ticket_nos', ticketNos(resp.kdsBoardKitchen), [2]);
  eq('kdsBoardScopeAll ticket_nos', ticketNos(resp.kdsBoardScopeAll), [1, 2]);
  // The header's counters have no station filter, so they track the `all` board.
  eq('kdsSummary.queue', resp.kdsSummary.queue, 2);
  eq('kdsSummary.active', resp.kdsSummary.active, resp.kdsBoardAll.length);
  eq('kdsTicketOne.status', resp.kdsTicketOne.status, 'queue');
  eq('kdsTicketOne.lines', resp.kdsTicketOne.items.length, 1);
  eq('kdsStart.status', resp.kdsStart.status, 'preparing');
  eq('kdsStart.started_by_name', resp.kdsStart.started_by_name, 'Sari');
  eq('kdsLineDone line done', resp.kdsLineDone.items.map((i) => i.done), [1]);
  eq('kdsIllegal.status', resp.kdsIllegal.status, 400);
  eq('kdsIllegal.error', resp.kdsIllegal.body.error, 'Tidak bisa mengubah status dari preparing ke completed');
  eq('kdsReady.status', resp.kdsReady.status, 'ready');
  eq('kdsComplete.status', resp.kdsComplete.status, 'completed');
  eq('kdsComplete.closed_by_name', resp.kdsComplete.closed_by_name, 'Sari');
  eq('kdsHistory ticket_nos', ticketNos(resp.kdsHistory), [1]);
  eq('kdsCancelNoReason.status', resp.kdsCancelNoReason.status, 400);
  eq('kdsCancelNoReason.error', resp.kdsCancelNoReason.body.error, 'Alasan pembatalan wajib diisi');
  eq('kdsCancelled.cancel_reason', resp.kdsCancelled.cancel_reason, 'salah input');
  // Reopening clears the closing stamps, so the ticket looks fresh again.
  eq('kdsReopen', [resp.kdsReopen.status, resp.kdsReopen.completed_at, resp.kdsReopen.cancel_reason], [
    'queue',
    null,
    null,
  ]);
  eq('kdsDeleteMissing.status', resp.kdsDeleteMissing.status, 404);
  eq('kdsDelete.status', resp.kdsDelete.status, 200);
  eq('kdsBoardAfterDelete ticket_nos', ticketNos(resp.kdsBoardAfterDelete), []);
  eq('kdsSummaryAfter.active', resp.kdsSummaryAfter.active, 0);
  eq('kdsSummaryAfter.completed', resp.kdsSummaryAfter.completed, 1);

  /* settings + audit */
  const seeded = resp.settings.find((s) => s.key === 'allow_negative_stock');
  eq('settings.allow_negative_stock', [seeded.value, seeded.numeric], ['warn', false]);
  eq('settingsUpdate.updated', resp.settingsUpdate.updated, {
    allow_negative_stock: 'ignore',
    tax_percent: '12',
  });
  eq('settingsUnknown.status', resp.settingsUnknown.status, 400);
  eq('settingsBadEnum.status', resp.settingsBadEnum.status, 400);
  eq('settingsEmpty.status', resp.settingsEmpty.status, 400);
  eq('settingsEmpty.error', resp.settingsEmpty.body.error, 'Tidak ada pengaturan yang dikirim');
  const tax = resp.settingsAfter.find((s) => s.key === 'tax_percent');
  eq('settingsAfter.tax', [tax.value, tax.numeric], ['12', true]);
  eq('auditAll.total >= 1', resp.auditAll.total >= 1, true);
  eq('auditAll.rows', resp.auditAll.rows.length, Math.min(resp.auditAll.total, 20));
  const settingsLog = resp.auditSettings.rows.find((r) => r.action === 'settings.update');
  eq('audit detail parsed', settingsLog.detail.changed.allow_negative_stock, 'ignore');
  eq('auditPaged rows', resp.auditPaged.rows.length, Math.min(Math.max(resp.auditPaged.total - 5, 0), 5));
  eq('auditPaged total', resp.auditPaged.total, resp.auditAll.total);
  eq('auditActions has settings.update', resp.auditActions.some((a) => a.action === 'settings.update'), true);
  eq('auditEntity actions', resp.auditEntity.rows.every((r) => r.entity === 'product'), true);

  /* devices */
  eq('deviceRegistered.name', resp.deviceRegistered.name, 'Kasir 1');
  eq('deviceRegistered.platform', resp.deviceRegistered.platform, 'macos');
  eq('deviceRegistered.is_active', resp.deviceRegistered.is_active, 1);
  eq('deviceRegistered.device_key', resp.deviceRegistered.device_key.length, 48);
  eq('deviceAgain.id', resp.deviceAgain.id, resp.deviceRegistered.id);
  eq('deviceAgain.name', resp.deviceAgain.name, 'Kasir Depan');
  eq('deviceAgain.platform', resp.deviceAgain.platform, 'macos');
  eq('deviceHeartbeat.ok', resp.deviceHeartbeat.ok, true);
  eq('deviceHeartbeat.server_time', resp.deviceHeartbeat.server_time.endsWith('Z'), true);
  eq('deviceRemoteLogout.revoked_sessions', resp.deviceRemoteLogout.revoked_sessions, 0);
  eq('deviceUpdate.is_active', resp.deviceUpdate.is_active, 0);
  eq('deviceHeartbeatRefused.status', resp.deviceHeartbeatRefused.status, 403);
  eq('deviceHeartbeatRefused.revoked', resp.deviceHeartbeatRefused.body.revoked, true);
  eq('deviceHeartbeatRefused.reason', resp.deviceHeartbeatRefused.body.reason, 'hilang');
  eq('devices count', resp.devices.length, 1);
  eq('devices[0].active_sessions', resp.devices[0].active_sessions, 0);

  /* the rows those routes wrote */
  const setting = tables.settings.find((s) => s.key === 'allow_negative_stock');
  eq('table settings.allow_negative_stock', setting.value, 'ignore');
  eq('table users count', tables.users.length, 4);
  eq('table users all bcrypt', tables.users.every((u) => u.password_hash === '<bcrypt cost=10>'), true);
  eq(
    'table users roles',
    tables.users.map((u) => `${u.email}:${u.role}`).sort(),
    ['kasir@l7.id:cashier', 'lock@l7.id:cashier', 'owner@l7.id:super_admin', 'staf@l7.id:staf'],
  );
  eq('table roles names', tables.roles.map((r) => r.name).sort(), ['staf']);
  eq('table products skus', tables.products.map((p) => `${p.sku}:${p.is_active}`), ['KOPI-02:0', 'TEH-01:1']);
  eq(
    'table stock_movements types',
    tables.stock_movements.map((m) => m.type).sort(),
    // Two adjusts (`add`, `set` — the unknown `type` falls through without a
    // movement row) and one opname, which writes a line row and a summary row.
    ['adjust', 'adjust', 'opname', 'opname'],
  );
  eq('table devices revoked_reason', tables.devices[0].revoked_reason, 'hilang');
  eq('table devices is_active', tables.devices[0].is_active, 0);
  eq('table audit_logs non-empty', tables.audit_logs.length > 10, true);
  eq(
    'table audit_logs has the full trail',
    [
      'company.update',
      'branch.create',
      'user.create',
      'role.delete',
      'product.delete',
      'stock.adjust',
      'settings.update',
      'device.register',
    ].every((action) => tables.audit_logs.some((row) => row.action === action)),
    true,
  );
  eq(
    'table login_attempts failures',
    tables.login_attempts.filter((row) => row.success === 0).length >= 6,
    true,
  );

  return fail;
}

/* ---------------------------- CROSS-FORMAT ---------------------------- */

/** Read one column from a database (used to lift a hash from one build into the other). */
function readHash(dbPath, email) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT password_hash FROM users WHERE email = ?').get(email).password_hash;
  } finally {
    db.close();
  }
}

/**
 * Insert the fixed identities part C needs, with the same ids in *both* databases.
 *
 * Same ids is what makes the token check possible: a token minted by one build names
 * a subject that exists in the other, so `/auth/me` answers with a real row instead
 * of a 401 that would prove nothing. Each user carries a hash produced by the
 * opposite runtime, so `POST /auth/login` is the cross-verification.
 */
function seedCross(dbPath, hashes) {
  const db = new Database(dbPath);
  try {
    const at = '2026-11-07 00:00:00';
    db.prepare("INSERT INTO companies (id, name, created_at) VALUES (?, 'Lintas', ?)").run(
      CROSS.company,
      at,
    );
    db.prepare(
      "INSERT INTO branches (id, company_id, name, created_at) VALUES (?, ?, 'Lintas', ?)",
    ).run(CROSS.branch, CROSS.company, at);
    const insertUser = db.prepare(
      `INSERT INTO users (id, company_id, branch_id, name, email, password_hash, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'super_admin', ?)`,
    );
    insertUser.run(
      CROSS.nodeHashUser,
      CROSS.company,
      CROSS.branch,
      'Lintas Node',
      'cross-node@l7.id',
      hashes.node,
      at,
    );
    insertUser.run(
      CROSS.rustHashUser,
      CROSS.company,
      CROSS.branch,
      'Lintas Rust',
      'cross-rust@l7.id',
      hashes.rust,
      at,
    );
  } finally {
    db.close();
  }
}

/**
 * The three contracts a single-server test can never prove. Returns one record per
 * check; `main` turns a false record into a failure with both sides printed.
 */
async function crossFormat(node, rust, rustHash) {
  const nodeApi = apiFor(node.baseUrl);
  const rustApi = apiFor(rust.baseUrl);
  const hashes = { node: bcrypt.hashSync(CROSS.password, 10), rust: rustHash };
  seedCross(node.dbPath, hashes);
  seedCross(rust.dbPath, hashes);

  const results = [];
  const record = (what, ok, a, b) => results.push({ what, ok, node: a, rust: b });
  const json = (res) => {
    try {
      return res.text ? JSON.parse(res.text) : null;
    } catch {
      return null;
    }
  };
  const login = (api, email) =>
    api.raw('POST', '/api/auth/login', { body: { email, password: CROSS.password } });

  const nodeLogin = await login(nodeApi, 'cross-node@l7.id');
  const rustLogin = await login(rustApi, 'cross-node@l7.id');
  // The lifted hash belongs to the owner, whose password is `NEW_PASSWORD` by now.
  const rustHashLogin = await nodeApi.raw('POST', '/api/auth/login', {
    body: { email: 'cross-rust@l7.id', password: NEW_PASSWORD },
  });
  record('bcryptjs hash verifies in Rust', rustLogin.status === 200, nodeLogin.status, rustLogin.status);
  record(
    'Rust crate hash verifies under bcryptjs',
    rustHashLogin.status === 200,
    rustHashLogin.status,
    200,
  );

  // Same secret, same claims: each build must accept the other's token.
  const nodeToken = json(nodeLogin)?.token;
  const rustToken = json(rustLogin)?.token;
  const nodeOnRust = await rustApi.raw('GET', '/api/auth/me', { token: nodeToken });
  const rustOnNode = await nodeApi.raw('GET', '/api/auth/me', { token: rustToken });
  record('node-minted JWT accepted by Rust', nodeOnRust.status === 200, nodeOnRust.status, 200);
  record('Rust-minted JWT accepted by Node', rustOnNode.status === 200, 200, rustOnNode.status);

  // The same subject read through both builds: identical session payload.
  const blank = makeNames();
  const viaNode = scrub(json(rustOnNode), blank);
  const viaRust = scrub(json(nodeOnRust), blank);
  record('session payload is identical', isDeepStrictEqual(viaNode, viaRust), viaNode, viaRust);

  // One schema, two languages: tables, indexes and triggers match verbatim.
  const nodeSchema = schemaFor(node.dbPath);
  const rustSchema = schemaFor(rust.dbPath);
  record(
    'sqlite_master is identical',
    isDeepStrictEqual(nodeSchema, rustSchema),
    nodeSchema.length ? `${nodeSchema.length} objects` : nodeSchema,
    rustSchema.length ? `${rustSchema.length} objects` : rustSchema,
  );
  return results;
}

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

  console.log('L7 parity — Node edge vs Rust edge\n');
  let checks = 0;
  let failures = 0;
  const fail = (what, left, right) => {
    failures += 1;
    showDiff(what, left, right);
  };

  const node = await startServer({ label: 'node', command: 'node', args: [NODE_SERVER], cwd: ROOT });
  const rust = await startServer({
    label: 'rust',
    command: RUST_BIN,
    args: [],
    cwd: path.dirname(RUST_BIN),
  });

  try {
    const n = await runScenario(node);
    const r = await runScenario(rust);
    const nodeTables = tablesFor(node.dbPath, n.names);
    const rustTables = tablesFor(rust.dbPath, r.names);

    /* ---- A. the scenario: invariants, then the diff ---- */
    const problems = [
      ...checkInvariants('node', n.resp, nodeTables),
      ...checkInvariants('rust', r.resp, rustTables),
    ];
    for (const problem of problems) console.error(`✗ ${problem}`);
    failures += problems.length;
    checks += 2;

    for (const key of Object.keys(n.resp)) {
      checks += 1;
      const left = scrub(normalizeResponse(n.resp[key]), n.names);
      const right = scrub(normalizeResponse(r.resp[key]), r.names);
      if (!isDeepStrictEqual(left, right)) fail(`response ${key}`, left, right);
    }
    for (const table of Object.keys(nodeTables)) {
      checks += 1;
      if (!isDeepStrictEqual(nodeTables[table], rustTables[table])) {
        fail(`table ${table}`, nodeTables[table], rustTables[table]);
      }
    }
    console.log(
      `A. scenario: ${Object.keys(n.resp).length} responses, ` +
        `${Object.keys(nodeTables).length} tables, invariants`,
    );

    /* ---- B. the sweep: every route, no token and as a cashier ---- */
    const nodeApi = apiFor(node.baseUrl);
    const rustApi = apiFor(rust.baseUrl);
    const status = async (api, method, uri, token, body) =>
      (await api.raw(method, uri, { token, body })).status;
    for (const entry of SWEEP) {
      const nodePath = entry.path(n.ids);
      const rustPath = entry.path(r.ids);
      const label = `${entry.method} ${nodePath}`;

      const nodeAnon = await status(nodeApi, entry.method, nodePath, undefined, entry.body);
      const rustAnon = await status(rustApi, entry.method, rustPath, undefined, entry.body);
      checks += 1;
      if (nodeAnon !== rustAnon) fail(`sweep anon ${label}`, nodeAnon, rustAnon);
      if (entry.anon !== undefined && entry.anon !== 'any') {
        checks += 1;
        if (nodeAnon !== entry.anon) fail(`sweep anon expectation ${label}`, nodeAnon, entry.anon);
      }

      const nodeCashier = await status(nodeApi, entry.method, nodePath, n.cashierToken, entry.body);
      const rustCashier = await status(rustApi, entry.method, rustPath, r.cashierToken, entry.body);
      checks += 1;
      if (nodeCashier !== rustCashier) fail(`sweep cashier ${label}`, nodeCashier, rustCashier);
      // A half-ported route answers 500 on one side and not the other; the diff above
      // would catch that, but pinning it keeps both-wrong from passing too.
      for (const [side, code] of [['node', nodeCashier], ['rust', rustCashier]]) {
        checks += 1;
        if (code >= 500) fail(`sweep ${side} answered 5xx for ${label}`, code, '<500');
      }
    }
    console.log(`B. route sweep: ${SWEEP.length} routes x 2 identities`);

    /* ---- C. cross-format ---- */
    const rustHash = readHash(rust.dbPath, COMPANY.email);
    for (const result of await crossFormat(node, rust, rustHash)) {
      checks += 1;
      if (!result.ok) fail(`cross-format: ${result.what}`, result.node, result.rust);
    }
    console.log('C. cross-format: JWT, bcrypt, sqlite_master');
  } finally {
    await node.stop();
    await rust.stop();
  }

  if (failures === 0) {
    console.log(
      `\n✓ L7 parity green — ${checks} checks ` +
        `(scenario, ${SWEEP.length} routes x 2 identities, cross-format)`,
    );
    for (const side of [node, rust]) rmSync(side.dataDir, { recursive: true, force: true });
    return;
  }
  console.error(`\n✗ L7 parity FAILED — ${failures} of ${checks} checks`);
  console.error(
    `  databases kept for inspection:\n    node: ${node.dbPath}\n    rust: ${rust.dbPath}`,
  );
  process.exitCode = 1;
}

await main();
