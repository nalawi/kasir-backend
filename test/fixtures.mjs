// Shared fixtures: build a realistic paired world in one call.
//
// Every test here starts from a fresh cloud company and a fresh till, because
// that is the state that actually breaks: a till whose replica has never seen the
// cloud's ids, and a sale that leaves the till before the cloud knows about it.

import path from 'node:path';
import Database from 'better-sqlite3';
import { startWorld } from './harness.mjs';

export const OWNER = { name: 'Sari', email: 'owner@uji.id', password: 'rahasia123' };
export const CASHIER_PIN = '4321';

/**
 * Register a company on the cloud and seed a small catalog plus one PIN cashier.
 * Returns ids the tests need and the owner's token.
 */
export async function seedCloud(api) {
  const reg = await api.cloud.post('/api/auth/register', {
    body: { company_name: 'Toko Uji', ...OWNER },
  });
  if (reg.status !== 200 && reg.status !== 201) {
    throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  }

  const token = reg.body.token;
  const branchId = reg.body.user.branch_id;

  const catalog = [
    { name: 'Kopi Susu', default_price: 18000, stock: 30 },
    { name: 'Roti Bakar', default_price: 12000, stock: 30 },
    { name: 'Teh Manis', default_price: 8000, stock: 30 },
  ];

  const products = [];
  for (const p of catalog) {
    const created = await api.cloud.post('/api/products', {
      token,
      body: { name: p.name, default_price: p.default_price },
    });
    if (created.status >= 300) throw new Error(`product failed: ${JSON.stringify(created.body)}`);
    const productId = created.body.id;
    const adj = await api.cloud.post(`/api/branches/${branchId}/stock/adjust`, {
      token,
      body: { product_id: productId, quantity: p.stock, type: 'set' },
    });
    if (adj.status >= 300) throw new Error(`stock failed: ${JSON.stringify(adj.body)}`);
    products.push({ ...p, id: productId });
  }

  const cashierEmail = 'budi@uji.id';
  const cashierPassword = 'rahasia123';
  const cashier = await api.cloud.post('/api/users', {
    token,
    body: { name: 'Budi', email: cashierEmail, password: cashierPassword, role: 'cashier', branch_id: branchId },
  });
  const cashierId = cashier.body.id || cashier.body.user?.id;
  await api.cloud.put(`/api/users/${cashierId}`, { token, body: { pin: CASHIER_PIN } });

  return { token, branchId, products, cashierId, cashierEmail, cashierPassword };
}

/**
 * Pair the till to the cloud and pull the replica, exactly as the Diagnostik tab
 * does. Returns the edge session token and the bootstrap summary.
 */
export async function pairAndBootstrap(world, seeded) {
  const edgeReg = await world.api.edge.post('/api/auth/register', {
    body: { company_name: 'Toko Uji', ...OWNER },
  });
  const edgeAdmin = edgeReg.body.token;

  const cfg = await world.api.edge.put('/api/edge/config', {
    token: edgeAdmin,
    body: { upstream: world.cloud.url, branch_id: seeded.branchId },
  });
  if (cfg.status >= 300) throw new Error(`config failed: ${JSON.stringify(cfg.body)}`);

  const pair = await world.api.edge.post('/api/edge/pair', {
    token: edgeAdmin,
    body: { email: OWNER.email, password: OWNER.password },
  });
  if (pair.status >= 300) throw new Error(`pair failed: ${JSON.stringify(pair.body)}`);

  const boot = await world.api.edge.post('/api/edge/bootstrap', {
    token: edgeAdmin,
    body: { branch_id: seeded.branchId },
  });
  if (boot.status >= 300) throw new Error(`bootstrap failed: ${JSON.stringify(boot.body)}`);

  // Bootstrap can re-point this till's own admin row at the cloud's company (the
  // till is registered locally first, under the same email). The token minted at
  // registration then names the previous company and the service rejects it as a
  // 'Tenant mismatch', so the service hands back a replacement — exactly as the
  // app does. Deliberately no fallback: if the service stops issuing one, the
  // tests must fail instead of quietly carrying on with a spent token.
  const adminToken = boot.body.token;
  if (!adminToken) throw new Error('bootstrap did not return a replacement token');

  // After bootstrap the till's replica holds the CLOUD's branch id and users, and
  // a sale must be entered as a real till operator. Selling as the till's own
  // bootstrap-admin would be scoped to the local branch id it generated at
  // registration, which is not the branch being synced. The cashier unlocks with
  // a PIN — the same path a cashier uses offline — so this also keeps the tests
  // honest about which credential actually runs the till.
  const unlock = await world.api.edge.post('/api/edge/unlock', {
    body: { user_id: seeded.cashierId, pin: CASHIER_PIN },
  });
  if (unlock.status >= 300) throw new Error(`unlock failed: ${JSON.stringify(unlock.body)}`);

  return {
    edgeToken: unlock.body.token,
    adminToken,
    // The bearer minted at local registration, before pairing. Bootstrap is
    // supposed to invalidate it, so tests need it to prove that happened.
    registeredToken: edgeAdmin,
    pair: pair.body,
    boot: boot.body,
    unlock: unlock.body,
  };
}

/**
 * A paired world: cloud seeded, till paired and bootstrapped.
 *
 * `edge` is the token bundle from `pairAndBootstrap`, the shape nearly every test
 * wants. The server handles keep their original names under `servers`, because
 * the spread below would otherwise bury `url`/`stop` under the bundle — and a test
 * that talks HTTP to the till needs the URL.
 */
export async function startPairedWorld() {
  const world = await startWorld();
  const seeded = await seedCloud(world.api);
  const edge = await pairAndBootstrap(world, seeded);
  return { ...world, seeded, edge, servers: { cloud: world.cloud, edge: world.edge } };
}

/** Build a checkout body for one product line. */
export function saleBody({ branchId, productId, quantity, price, clientUuid, cashReceived = 100000 }) {
  return {
    branch_id: branchId,
    client_uuid: clientUuid,
    items: [{ product_id: productId, quantity, price }],
    payment_method: 'cash',
    cash_received: cashReceived,
  };
}

/** Current branch stock for a product, read from the cloud. */
export async function cloudStock(api, branchId, productId, token) {
  const res = await api.cloud.get(`/api/branches/${branchId}/stock`, { token });
  const rows = Array.isArray(res.body) ? res.body : res.body?.stocks || res.body?.items || [];
  const row = rows.find((r) => r.product_id === productId);
  return row ? row.quantity : null;
}

/**
 * Log in to the CLOUD as the seeded cashier and return that token.
 *
 * Distinct from `edge.edgeToken`: that one is minted by the till with the local
 * secret, so the cloud rejects it outright. A test asserting a permission
 * boundary on a cloud route needs a cloud-signed token for that role, or it
 * would pass by 401 rather than by the check under test.
 */
export async function cloudCashierToken(api, seeded) {
  const res = await api.cloud.post('/api/auth/login', {
    body: { email: seeded.cashierEmail, password: seeded.cashierPassword },
  });
  if (res.status >= 300) throw new Error(`cashier login failed: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

/**
 * Set a branch's stock to an exact quantity, via the real adjust endpoint so the
 * movement log stays consistent with what the app would produce.
 */
export async function setCloudStock(api, branchId, productId, quantity, token) {
  return api.cloud.post(`/api/branches/${branchId}/stock/adjust`, {
    token,
    body: { product_id: productId, quantity, type: 'set' },
  });
}

/**
 * Write a row into `settings` on the given service.
 *
 * There is no settings write endpoint (the table is seeded, not editable over the
 * API), so tests that need a non-default setting open their own connection to the
 * service's SQLite file. That is safe here because the running service already
 * uses WAL: a short write from another connection is visible immediately without
 * taking the write lock away from the app.
 */
export function setSetting(dataDir, key, value) {
  const db = new Database(path.join(dataDir, 'pos.db'));
  try {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  } finally {
    db.close();
  }
}
