// Route-level tests for backup and restore.
//
// The engine (src/lib/backup.js) is exercised through a real server here, because
// the failure modes that matter are the ones only an HTTP round trip shows: the
// download envelope, the permission gate, the `confirm` handshake, and — most
// importantly — that a restore does not quietly destroy data it was not asked to
// touch. Backup is the operation an operator reaches for when everything else has
// already gone wrong, so these tests are less about the happy path than about what
// must never happen.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startPairedWorld, OWNER } from './fixtures.mjs';

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** GET /api/backup and return the parsed bundle. */
async function getBundle(url, token, categories) {
  const qs = categories ? `?categories=${encodeURIComponent(categories)}` : '';
  const res = await fetch(`${url}/api/backup${qs}`, { headers: auth(token) });
  assert.equal(res.status, 200);
  return res.json();
}

/** POST a JSON body to a backup endpoint. */
async function post(url, token, path, body) {
  const res = await fetch(`${url}/api/backup/${path}`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** Sign in on the cloud as the owner, to prove a password survived a restore. */
async function loginOwner(url) {
  const res = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.password }),
  });
  return res.status;
}

/* -------------------------------------------------------------------------- */
/* 1. Export                                                                  */
/* -------------------------------------------------------------------------- */

test('a full backup is a readable JSON download that identifies itself', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token } = world.seeded;
  const res = await fetch(`${world.cloud.url}/api/backup`, { headers: auth(token) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="backup-/);

  const bundle = await res.json();
  assert.equal(bundle.format, 'pos-backup');
  assert.equal(bundle.version, 1);
  assert.deepEqual(bundle.categories, ['master', 'transaction', 'configuration']);
  // The seeded shop has products and settings; a bundle missing them would
  // "restore" into an empty catalogue and still look successful.
  assert.equal(bundle.data.products.length, bundle.counts.products);
  assert.ok(bundle.data.products.length > 0, 'products must be in the backup');
  assert.ok(bundle.data.settings.length > 0, 'settings must be in the backup');
});

test('a backup never carries credentials or till pairing', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const bundle = await getBundle(world.cloud.url, world.seeded.token);

  // A backup file travels by email and lives on someone's desktop. It must not
  // carry a password hash, and it must not carry the edge_* pairing keys —
  // restoring those would re-point a live till at an old upstream.
  for (const user of bundle.data.users) {
    assert.equal('password_hash' in user, false, 'password hashes must not be exported');
  }
  for (const row of bundle.data.settings) {
    assert.ok(!String(row.key).startsWith('edge_'), `settings leaked pairing key ${row.key}`);
  }
});

test('restricting categories narrows the bundle instead of failing', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const bundle = await getBundle(world.cloud.url, world.seeded.token, 'configuration');
  assert.deepEqual(bundle.categories, ['configuration']);
  assert.deepEqual(Object.keys(bundle.data), ['settings']);
  assert.equal(bundle.data.transactions, undefined, 'transactions must not be included');
});

test('an unknown category is rejected rather than silently ignored', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const res = await fetch(`${world.cloud.url}/api/backup?categories=everything`, {
    headers: auth(world.seeded.token),
  });
  assert.equal(res.status, 400);
});

/* -------------------------------------------------------------------------- */
/* 2. Preview                                                                 */
/* -------------------------------------------------------------------------- */

test('the preview counts what would change but writes nothing', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token } = world.seeded;
  const bundle = await getBundle(world.cloud.url, token);

  // Rename a product directly in the database behind the API's back, so the
  // bundle is stale and the restore has something real to do.
  const product = bundle.data.products[0];
  await fetch(`${world.cloud.url}/api/products/${product.id}`, {
    method: 'PUT',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'RUSAK' }),
  });

  const { status, body } = await post(world.cloud.url, token, 'preview', { bundle });
  assert.equal(status, 200);
  assert.equal(body.tables.products.updated, bundle.counts.products);
  assert.equal(body.tables.products.added, 0);

  // The preview must be a dry run: the mangled name is still there afterwards.
  const after = await (await fetch(`${world.cloud.url}/api/products`, { headers: auth(token) })).json();
  assert.equal(after.find((p) => p.id === product.id).name, 'RUSAK', 'preview must not write');
});

test('previewing a file that is not a POS backup is a 400, not a crash', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token } = world.seeded;
  for (const bundle of [{ format: 'something-else' }, { format: 'pos-backup', data: {} }, null]) {
    const { status, body } = await post(world.cloud.url, token, 'preview', { bundle });
    assert.equal(status, 400, `expected 400 for ${JSON.stringify(bundle)}`);
    assert.ok(body.error, 'the error must explain itself');
  }
});

/* -------------------------------------------------------------------------- */
/* 3. Restore                                                                 */
/* -------------------------------------------------------------------------- */

test('restore puts back what was changed, and leaves the login password alone', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token } = world.seeded;
  const bundle = await getBundle(world.cloud.url, token);
  const product = bundle.data.products[0];

  // Damage one product, then restore.
  await fetch(`${world.cloud.url}/api/products/${product.id}`, {
    method: 'PUT',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'RUSAK' }),
  });

  const restored = await post(world.cloud.url, token, 'restore', { bundle, confirm: 'RESTORE' });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.ok, true);

  const after = await (await fetch(`${world.cloud.url}/api/products`, { headers: auth(token) })).json();
  assert.equal(after.find((p) => p.id === product.id).name, product.name);

  // The whole reason `users` is merged rather than replaced: the account keeps its
  // password, so a restore cannot lock the operator out of the tool they are
  // using to recover.
  assert.equal(await loginOwner(world.cloud.url), 200, 'restore must not reset the operator password');
});

test('restore requires the confirm handshake', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token } = world.seeded;
  const bundle = await getBundle(world.cloud.url, token);

  const { status, body } = await post(world.cloud.url, token, 'restore', { bundle });
  assert.equal(status, 400);
  assert.match(body.error, /[Kk]onfirmasi/);
});

test('restoring the same bundle twice changes nothing the second time', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token } = world.seeded;
  const bundle = await getBundle(world.cloud.url, token);

  const first = await post(world.cloud.url, token, 'restore', { bundle, confirm: 'RESTORE' });
  assert.equal(first.status, 200);
  const second = await post(world.cloud.url, token, 'restore', { bundle, confirm: 'RESTORE' });
  assert.equal(second.status, 200);

  // Idempotent: the second run adds no rows, because the upsert matches by key.
  assert.equal(second.body.summary.added, 0, 'a repeated restore must not duplicate rows');
  const products = await (await fetch(`${world.cloud.url}/api/products`, { headers: auth(token) })).json();
  assert.equal(products.length, bundle.counts.products);
});

test('a partial restore does not delete the data it did not cover', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token, branchId, products } = world.seeded;
  const full = await getBundle(world.cloud.url, token);

  // Sell something, then restore only the configuration category. The sale must
  // still be there: restoring settings is not a request to rewind the day's takings.
  const sale = await fetch(`${world.cloud.url}/api/transactions`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch_id: branchId,
      items: [{ product_id: products[0].id, quantity: 1, price: products[0].default_price }],
      payment_method: 'cash',
      cash_received: 100000,
    }),
  });
  assert.ok([200, 201].includes(sale.status), `sale failed: ${sale.status}`);

  const configOnly = { ...full, categories: ['configuration'], data: { settings: full.data.settings } };
  const { status } = await post(world.cloud.url, token, 'restore', { bundle: configOnly, confirm: 'RESTORE' });
  assert.equal(status, 200);

  const txs = await (
    await fetch(`${world.cloud.url}/api/transactions?branch_id=${branchId}`, { headers: auth(token) })
  ).json();
  assert.ok(txs.rows.length >= 1, 'a configuration restore must not delete sales');
});

test('restoring the company row does not cascade the data hanging off it', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token } = world.seeded;
  const bundle = await getBundle(world.cloud.url, token);
  const branchCount = bundle.counts.branches;
  const productCount = bundle.counts.products;

  const { status } = await post(world.cloud.url, token, 'restore', { bundle, confirm: 'RESTORE' });
  assert.equal(status, 200);

  // `companies` and `branches` are parents of nearly everything, and
  // INSERT OR REPLACE on a parent deletes the row first — which fires
  // ON DELETE CASCADE and takes the children with it. The upsert must rewrite the
  // parent in place so the tree survives.
  const products = await (await fetch(`${world.cloud.url}/api/products`, { headers: auth(token) })).json();
  assert.equal(products.length, productCount, 'products must survive a company/branch restore');
  const branches = await (await fetch(`${world.cloud.url}/api/branches`, { headers: auth(token) })).json();
  assert.equal(branches.length, branchCount, 'branches must not be duplicated or lost');
});

/* -------------------------------------------------------------------------- */
/* 4. Trust boundaries                                                        */
/* -------------------------------------------------------------------------- */

test('a cashier cannot export, preview or restore', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token, cashierEmail, cashierPassword } = world.seeded;
  const bundle = await getBundle(world.cloud.url, token);

  // Same world, a genuine cashier session: the role must be refused everywhere,
  // because an export is a complete copy of the business.
  const login = await fetch(`${world.cloud.url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: cashierEmail, password: cashierPassword }),
  });
  assert.equal(login.status, 200);
  const cashier = (await login.json()).token;
  assert.ok(cashier, 'fixture must be able to produce a cashier token');

  assert.equal((await fetch(`${world.cloud.url}/api/backup`, { headers: auth(cashier) })).status, 403);
  assert.equal((await post(world.cloud.url, cashier, 'preview', { bundle })).status, 403);
  assert.equal((await post(world.cloud.url, cashier, 'restore', { bundle, confirm: 'RESTORE' })).status, 403);
});

test('an edge till may back up but must not restore', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  // Backup is genuinely useful on a till: it is a second copy of the local data.
  const res = await fetch(`${world.servers.edge.url}/api/backup/categories`, {
    headers: auth(world.edge.adminToken),
  });
  assert.equal(res.status, 200);
  const meta = await res.json();
  assert.equal(meta.canRestore, false, 'the till must advertise that restore is cloud-only');

  const bundle = await getBundle(world.cloud.url, world.seeded.token);

  // Restoring on a till would be wiped by the next bootstrap and could overwrite
  // sales the outbox has not drained, so the server refuses rather than trusting
  // the UI to have hidden the button.
  const { status, body } = await post(world.servers.edge.url, world.edge.adminToken, 'restore', {
    bundle,
    confirm: 'RESTORE',
  });
  assert.equal(status, 409);
  assert.match(body.error, /pusat/i);
});

test('the edge backup carries no upstream credentials', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  // The till's `settings` table holds edge_device_token and the upstream URL. Those
  // must not leave in a file, or a restored bundle could repoint a till.
  const bundle = await getBundle(world.servers.edge.url, world.edge.adminToken, 'configuration');
  for (const row of bundle.data.settings || []) {
    assert.ok(!String(row.key).startsWith('edge_'), `edge backup leaked ${row.key}`);
  }
});

