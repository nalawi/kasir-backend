// Money-path tests for the offline edge sync.
//
// These are the flows that must never regress, because each can lose or
// duplicate real money:
//
//   1. Replay idempotency   — replaying a sale must never charge twice.
//   2. Duplicate delivery   — draining the same sale twice is one sale.
//   3. Conflict -> retry    — a refused sale must become appliable once fixed,
//                             and only after the cause is actually fixed.
//
// They run against two real servers with two real SQLite files (see harness.mjs),
// so what is asserted here is what ships, not a hand-assembled approximation.
//
// Every test spawns its own cloud + till pair (~1.5s), which is deliberate: a
// shared world would let one test's leftover stock or queue rows mask another's
// failure, and these are exactly the assertions where a masked failure lies.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  startPairedWorld,
  pairAndBootstrap,
  seedCloud,
  saleBody,
  cloudStock,
  setCloudStock,
  setSetting,
  OWNER,
} from './fixtures.mjs';
import { startWorld } from './harness.mjs';

/** Small helper: the count the till's sync badge would show. */
async function queue(api, token) {
  const res = await api.edge.get('/api/edge/queue', { token });
  assert.equal(res.status, 200, 'queue summary should be readable');
  return res.body;
}

/**
 * Read-only handle on a service's replica file.
 *
 * Some assertions are about *rows*, not routes — a branch-scoped HTTP read also
 * has to pass permission checks, which would hide what the test is actually
 * checking. Same justification (and same WAL safety) as `setSetting` in fixtures.
 */
function openReplica(dataDir) {
  return new Database(path.join(dataDir, 'pos.db'), { readonly: true });
}

/* -------------------------------------------------------------------------- */
/* 1. Replay idempotency                                                      */
/* -------------------------------------------------------------------------- */

test('replaying an applied sale never charges twice', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, products, token } = world.seeded;
  const kopi = products[0];
  const startStock = await cloudStock(api, branchId, kopi.id, token);
  assert.equal(startStock, 30);

  const clientUuid = 'replay-idempotency-1';
  const sale = await api.edge.post('/api/transactions', {
    token: world.edge.edgeToken,
    body: saleBody({ branchId, productId: kopi.id, quantity: 2, price: kopi.default_price, clientUuid }),
  });
  assert.equal(sale.status, 201, 'the sale is written locally first');
  assert.equal(sale.body.total, 36000);

  // First delivery.
  const first = await api.edge.post('/api/edge/drain', { token: world.edge.edgeToken, body: { branch_id: branchId } });
  assert.equal(first.status, 200);
  assert.equal(first.body.applied, 1, 'one sale should be applied');

  const stockAfterFirst = await cloudStock(api, branchId, kopi.id, token);
  assert.equal(stockAfterFirst, startStock - 2, 'cloud stock drops by the sold quantity, once');

  // Replay the very same client_uuid straight at the cloud.
  const replay = await api.cloud.post('/api/sync/batch', {
    token,
    body: {
      branch_id: branchId,
      transactions: [
        {
          client_uuid: clientUuid,
          items: [{ product_id: kopi.id, quantity: 2, price: kopi.default_price }],
          payment_method: 'cash',
          cash_received: 100000,
        },
      ],
    },
  });
  assert.equal(replay.status, 200);
  const result = replay.body.results.find((r) => r.client_uuid === clientUuid);
  assert.equal(result.status, 'applied');
  assert.equal(result.duplicate, true, 'a replay must be reported as a duplicate');

  // The crucial assertion: stock did not move a second time.
  const stockAfterReplay = await cloudStock(api, branchId, kopi.id, token);
  assert.equal(stockAfterReplay, stockAfterFirst, 'replay must not deduct stock again');

  // And the transaction still exists exactly once.
  const txs = await api.cloud.get(`/api/transactions?branch_id=${branchId}`, { token });
  const rows = Array.isArray(txs.body) ? txs.body : txs.body?.transactions || txs.body?.rows || [];
  const matching = rows.filter((r) => r.client_uuid === clientUuid);
  assert.equal(matching.length, 1, 'exactly one transaction row for the client_uuid');
});

/*
 * How the two idempotency layers actually relate, established by mutation
 * testing rather than by reading:
 *
 *   layer 1  sync_queue memo in /sync/batch -> short-circuits an applied uuid and
 *            returns the original transaction_id without re-inserting.
 *   layer 2  persistTransaction's client_uuid guard -> catches the replay when
 *            layer 1 does not (memo missing, cleared, or another caller path).
 *
 * Measured behaviour:
 *   - delete layer 1 only -> suite still green, because layer 2 absorbs it
 *     (verified: the replay still returns duplicate:true with the memo bypassed)
 *   - delete both        -> tests 1 and 2 fail
 *
 * So either layer alone protects the money, and the pair is genuinely redundant.
 * The test below drives real replays end to end and therefore holds whichever
 * layer is doing the work.
 */

test('repeated replays keep the outcome at one sale and one stock move', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, products, token } = world.seeded;
  const teh = products[2];
  const startStock = await cloudStock(api, branchId, teh.id, token);
  assert.equal(startStock, 30, 'fixture sanity: the product starts fully stocked');

  // The till sells one unit and syncs it, so the cloud has an applied memo.
  const clientUuid = 'layer-outcome-1';
  await api.edge.post('/api/transactions', {
    token: world.edge.edgeToken,
    body: saleBody({ branchId, productId: teh.id, quantity: 1, price: teh.default_price, clientUuid }),
  });
  const drain = await api.edge.post('/api/edge/drain', { token: world.edge.edgeToken, body: { branch_id: branchId } });
  assert.equal(drain.body.applied, 1);

  assert.equal(await cloudStock(api, branchId, teh.id, token), startStock - 1, 'one unit sold');

  // Replay several times; nothing may accumulate.
  for (let i = 0; i < 3; i += 1) {
    const replay = await api.cloud.post('/api/sync/batch', {
      token,
      body: {
        branch_id: branchId,
        transactions: [
          {
            client_uuid: clientUuid,
            items: [{ product_id: teh.id, quantity: 1, price: teh.default_price }],
            payment_method: 'cash',
            cash_received: 100000,
          },
        ],
      },
    });
    assert.equal(replay.status, 200, `replay ${i + 1} is accepted as a no-op`);
    const verdict = replay.body.results.find((r) => r.client_uuid === clientUuid);
    assert.equal(verdict.duplicate, true, `replay ${i + 1} is reported as a duplicate`);
  }

  assert.equal(await cloudStock(api, branchId, teh.id, token), startStock - 1, 'stock is still one unit down, not four');

  const txs = await api.cloud.get(`/api/transactions?branch_id=${branchId}`, { token });
  const rows = Array.isArray(txs.body) ? txs.body : txs.body?.transactions || txs.body?.rows || [];
  assert.equal(rows.filter((r) => r.client_uuid === clientUuid).length, 1, 'still exactly one transaction row');
});


/* -------------------------------------------------------------------------- */
/* 2. Duplicate delivery across drains                                        */
/* -------------------------------------------------------------------------- */

test('draining the same pending sale twice applies it once', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, products, token } = world.seeded;
  const roti = products[1];
  const startStock = await cloudStock(api, branchId, roti.id, token);

  const clientUuid = 'double-drain-1';
  await api.edge.post('/api/transactions', {
    token: world.edge.edgeToken,
    body: saleBody({ branchId, productId: roti.id, quantity: 1, price: roti.default_price, clientUuid }),
  });

  const drain1 = await api.edge.post('/api/edge/drain', { token: world.edge.edgeToken, body: { branch_id: branchId } });
  assert.equal(drain1.body.applied, 1);

  const drain2 = await api.edge.post('/api/edge/drain', { token: world.edge.edgeToken, body: { branch_id: branchId } });
  assert.equal(drain2.body.examined, 0, 'nothing is left pending, so the second drain is a no-op');
  assert.equal(drain2.body.applied, 0);

  assert.equal(await cloudStock(api, branchId, roti.id, token), startStock - 1, 'stock moved exactly once');

  const q = await queue(api, world.edge.edgeToken);
  assert.equal(q.counts.pending, undefined, 'no pending rows remain');
  assert.equal(q.counts.applied, 1);
});


/* -------------------------------------------------------------------------- */
/* 3. Conflict -> fix stock -> retry -> applied                               */
/* -------------------------------------------------------------------------- */

test('a sale refused for stock can be retried after the stock is fixed', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, products, token } = world.seeded;
  const teh = products[2];

  const setCloudStock = (qty) =>
    api.cloud.post(`/api/branches/${branchId}/stock/adjust`, {
      token,
      body: { product_id: teh.id, quantity: qty, type: 'set' },
    });

  // The till believes it has plenty, because it bootstrapped while stock was high.
  // Meanwhile the cloud goes to zero — the classic two-till stock race.
  await setCloudStock(0);

  const clientUuid = 'conflict-retry-1';
  const sale = await api.edge.post('/api/transactions', {
    token: world.edge.edgeToken,
    body: saleBody({ branchId, productId: teh.id, quantity: 1, price: teh.default_price, clientUuid }),
  });
  assert.equal(sale.status, 201, 'the till still records the sale locally');

  // Draining refuses it.
  const drain = await api.edge.post('/api/edge/drain', { token: world.edge.edgeToken, body: { branch_id: branchId } });
  assert.equal(drain.status, 200);
  assert.equal(drain.body.applied, 0, 'a sale that would go negative is not applied');
  assert.equal(drain.body.queue.counts.conflict, 1);

  // It surfaces for a human, with a readable reason.
  const problems = await api.edge.get('/api/edge/queue/problems', { token: world.edge.edgeToken });
  assert.equal(problems.status, 200);
  const stuck = problems.body.find((p) => p.client_uuid === clientUuid);
  assert.ok(stuck, 'the refused sale appears in the review list');
  assert.equal(stuck.status, 'conflict');
  assert.ok(stuck.last_error, 'the review list explains why it was refused');

  // Retrying before fixing anything must not silently succeed.
  const premature = await api.edge.post('/api/edge/queue/retry', {
    token: world.edge.edgeToken,
    body: { client_uuid: clientUuid },
  });
  assert.equal(premature.status, 403, 'requeueing is privileged (transaction.void)');
});

test('after the fix a requeued conflict is applied exactly once', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, products, token } = world.seeded;
  const teh = products[2];

  const setCloudStock = (qty) =>
    api.cloud.post(`/api/branches/${branchId}/stock/adjust`, {
      token,
      body: { product_id: teh.id, quantity: qty, type: 'set' },
    });

  await setCloudStock(0);

  const clientUuid = 'conflict-retry-2';
  await api.edge.post('/api/transactions', {
    token: world.edge.edgeToken,
    body: saleBody({ branchId, productId: teh.id, quantity: 1, price: teh.default_price, clientUuid }),
  });

  const drain = await api.edge.post('/api/edge/drain', { token: world.edge.edgeToken, body: { branch_id: branchId } });
  assert.equal(drain.body.applied, 0);
  assert.equal(drain.body.queue.counts.conflict, 1);

  // Fix the cause, then requeue as someone who may void/approve.
  await setCloudStock(5);

  const retry = await api.edge.post('/api/edge/queue/retry', {
    token: world.edge.adminToken,
    body: { client_uuid: clientUuid },
  });
  assert.equal(retry.status, 200, 'requeue succeeds once the caller is privileged');

  const finalDrain = await api.edge.post('/api/edge/drain', { token: world.edge.edgeToken, body: { branch_id: branchId } });
  assert.equal(finalDrain.body.applied, 1, 'the sale goes through once the stock is fixed');
  assert.equal(finalDrain.body.queue.counts.conflict, undefined, 'the problem list drains');

  const remaining = await api.edge.get('/api/edge/queue/problems', { token: world.edge.edgeToken });
  assert.equal(remaining.body.length, 0, 'nothing is left for review');

  assert.equal(await cloudStock(api, branchId, teh.id, token), 4, 'stock is deducted exactly once');
});

/*
 * 4. First bootstrap on a fresh till, with categorised products.
 *
 * Regression: `applyBootstrap` used to insert products before categories, so a
 * product carrying a `category_id` hit `products.category_id REFERENCES
 * categories(id)` against a replica that had no categories yet — which is every
 * fresh till. The whole transaction rolled back and the till could never be
 * provisioned offline. The other tests missed it because their fixture creates
 * products with no category.
 */
test('bootstrap replicates categorised products onto a till that has never synced', async () => {
  const world = await startWorld();
  try {
    const { api } = world;

    // A cloud company whose catalogue actually uses categories.
    const cloudReg = await api.cloud.post('/api/auth/register', {
      body: { company_name: 'Toko Uji', ...OWNER },
    });
    assert.ok(cloudReg.status < 300, `cloud register failed: ${JSON.stringify(cloudReg.body)}`);
    const cloudToken = cloudReg.body.token;
    const cloudBranchId = cloudReg.body.user.branch_id;

    const cat = await api.cloud.post('/api/categories', {
      token: cloudToken,
      body: { name: 'Minuman' },
    });
    assert.ok(cat.status < 300, `category create failed: ${JSON.stringify(cat.body)}`);

    const product = await api.cloud.post('/api/products', {
      token: cloudToken,
      body: { name: 'Es Kopi Susu', default_price: 22000, category_id: cat.body.id },
    });
    assert.ok(product.status < 300, `product create failed: ${JSON.stringify(product.body)}`);

    // Pair and bootstrap a brand-new till (register creates its own company).
    const reg = await api.edge.post('/api/auth/register', {
      body: { company_name: 'Toko Uji', ...OWNER },
    });
    const adminToken = reg.body.token;

    await api.edge.put('/api/edge/config', {
      token: adminToken,
      body: { upstream: world.cloud.url, branch_id: cloudBranchId },
    });
    const pair = await api.edge.post('/api/edge/pair', {
      token: adminToken,
      body: { email: OWNER.email, password: OWNER.password },
    });
    assert.ok(pair.status < 300, `pair failed: ${JSON.stringify(pair.body)}`);

    const boot = await api.edge.post('/api/edge/bootstrap', {
      token: adminToken,
      body: { branch_id: cloudBranchId },
    });

    assert.ok(boot.status < 300, `fresh bootstrap must not fail: ${JSON.stringify(boot.body)}`);
    assert.equal(boot.body.ok, true);
    assert.equal(boot.body.categories, 1, 'the category is replicated');
    assert.equal(boot.body.products, 1, 'the categorised product is replicated');

    // The counts come from the same transaction that hit the FK, so a successful
    // bootstrap proves categories landed before the products that reference them.
    assert.equal(boot.body.users, 1, 'the branch roster is replicated even without a PIN');
    assert.equal(boot.body.pin_users, 0, 'the owner has no PIN, so nobody can unlock yet');
    assert.equal(boot.body.users_error, null, 'the user pull did not error');
  } finally {
    await world.stop();
  }
});

/* -------------------------------------------------------------------------- */
/* 5. Branch picker + roster replication (Settings › Diagnostik)               */
/* -------------------------------------------------------------------------- */

/**
 * The setup flow a shop owner actually sees: connect, pick "Cabang Bandung" from
 * a list, press one button. These are the endpoints that screen calls, so they
 * are asserted directly rather than through the curl sequence in the README.
 */
test('branch picker offers cloud branches and replicates the chosen one', async () => {
  const world = await startWorld();
  try {
    const { api } = world;

    const cloudReg = await api.cloud.post('/api/auth/register', {
      body: { company_name: 'Toko Dua Cabang', ...OWNER },
    });
    assert.ok(cloudReg.status < 300, `cloud register failed: ${JSON.stringify(cloudReg.body)}`);
    const cloudToken = cloudReg.body.token;
    const bandung = cloudReg.body.user.branch_id;
    // `register` names the home branch 'Cabang Utama'; there is no nested branch object.
    const bandungName = 'Cabang Utama';

    const second = await api.cloud.post('/api/branches', {
      token: cloudToken,
      body: { name: 'Cabang Surabaya' },
    });
    assert.ok(second.status < 300, `branch create failed: ${JSON.stringify(second.body)}`);
    const surabaya = second.body.id;

    // A Bandung cashier WITH a PIN: this one must be able to unlock the till.
    const cashier = await api.cloud.post('/api/users', {
      token: cloudToken,
      body: { name: 'Siti Kasir', email: 'siti@toko.test', password: 'rahasia123', role: 'cashier', branch_id: bandung },
    });
    assert.ok(cashier.status < 300, `user create failed: ${JSON.stringify(cashier.body)}`);
    const cashierId = cashier.body.id || cashier.body.user?.id;
    const setPin = await api.cloud.put(`/api/users/${cashierId}`, {
      token: cloudToken,
      body: { pin: '1234' },
    });
    assert.ok(setPin.status < 300, `set pin failed: ${JSON.stringify(setPin.body)}`);

    // The owner is in Bandung too but has no PIN: still part of the roster.
    // Nobody works in Surabaya, so that branch has no staff to replicate.

    const reg = await api.edge.post('/api/auth/register', {
      body: { company_name: 'Toko Dua Cabang', ...OWNER },
    });
    const adminToken = reg.body.token;

    await api.edge.put('/api/edge/config', {
      token: adminToken,
      body: { upstream: world.cloud.url },
    });

    // Before pairing the picker must say so rather than throw: the screen shows step 1.
    const beforePair = await api.edge.get('/api/edge/cloud-branches', { token: adminToken });
    assert.equal(beforePair.status, 200);
    assert.equal(beforePair.body.paired, false, 'an unpaired till is told to connect first');
    assert.deepEqual(beforePair.body.branches, []);

    const pair = await api.edge.post('/api/edge/pair', {
      token: adminToken,
      body: { email: OWNER.email, password: OWNER.password },
    });
    assert.ok(pair.status < 300, `pair failed: ${JSON.stringify(pair.body)}`);

    // The dropdown is populated from the cloud, with names a human recognises.
    const picker = await api.edge.get('/api/edge/cloud-branches', { token: adminToken });
    assert.equal(picker.status, 200);
    assert.equal(picker.body.paired, true);
    const names = picker.body.branches.map((b) => b.name);
    assert.ok(names.includes('Cabang Surabaya'), `picker should offer every branch, got ${JSON.stringify(names)}`);
    assert.ok(names.includes(bandungName), `picker should offer the home branch, got ${JSON.stringify(names)}`);
    assert.equal(picker.body.branches.length, 2, 'only this company branches are offered');

    // Replicate the chosen branch, exactly as the button does.
    const boot = await api.edge.post('/api/edge/bootstrap', {
      token: adminToken,
      body: { branch_id: bandung },
    });
    assert.ok(boot.status < 300, `replicate failed: ${JSON.stringify(boot.body)}`);
    assert.equal(boot.body.users, 2, 'both Bandung staff are replicated, with or without a PIN');
    assert.equal(boot.body.pin_users, 1, 'exactly one of them can unlock the till');

    // The offline staff picker mirrors that roster.
    const branches = await api.edge.get('/api/edge/pin-branches', { token: adminToken });
    assert.equal(branches.status, 200);
    assert.equal(branches.body.branches.length, 1, 'only the replicated branch exists locally');
    assert.equal(branches.body.branches[0].name, bandungName);
    assert.equal(branches.body.branches[0].pin_users, 1);

    const users = await api.edge.get(`/api/edge/pin-users?branch_id=${bandung}`, { token: adminToken });
    assert.equal(users.status, 200);
    assert.equal(users.body.length, 2, 'the local registration and the cloud owner collapse into one row');
    const byName = Object.fromEntries(users.body.map((u) => [u.name, u]));
    assert.equal(byName['Siti Kasir'].can_unlock, true);
    assert.equal(byName[OWNER.name].can_unlock, false, 'a PIN-less account is listed but flagged');

    const strayUsers = await api.edge.get(`/api/edge/pin-users?branch_id=${surabaya}`, { token: adminToken });
    assert.equal(strayUsers.status, 200);
    assert.deepEqual(strayUsers.body, [], 'an un-replicated branch has no local staff');
  } finally {
    await world.stop();
  }
});

/**
 * Switching a till to a second branch must work.
 *
 * `branch_stocks.id` is the PRIMARY KEY, so a product-only row id collided as soon
 * as the same catalog was replicated for another branch: "UNIQUE constraint
 * failed: branch_stocks.id". The operator picked a branch in the dropdown and got
 * a raw SQLite error. This asserts the second replication succeeds and that each
 * branch keeps its own stock row.
 */
test('replicating a second branch does not collide on the shared catalog', async () => {
  const world = await startWorld();
  try {
    const { api } = world;

    const cloudReg = await api.cloud.post('/api/auth/register', {
      body: { company_name: 'Toko Pindah Cabang', ...OWNER },
    });
    const cloudToken = cloudReg.body.token;
    const first = cloudReg.body.user.branch_id;

    const second = await api.cloud.post('/api/branches', {
      token: cloudToken,
      body: { name: 'Cabang Kedua' },
    });
    assert.ok(second.status < 300, `branch create failed: ${JSON.stringify(second.body)}`);
    const secondBranch = second.body.id;

    // The same product must exist in both branches, which is what a real catalog
    // looks like. Stock is set per branch so the two rows are distinguishable.
    const product = await api.cloud.post('/api/products', {
      token: cloudToken,
      body: { name: 'Kopi Susu', sku: 'KS-1', default_price: 18000 },
    });
    assert.ok(product.status < 300, `product create failed: ${JSON.stringify(product.body)}`);
    const productId = product.body.id;

    // Set distinct stock in each branch: the collision was on the stock row id,
    // so the two rows must end up separate and each carry its own quantity.
    for (const [branchId, qty] of [[first, 40], [secondBranch, 7]]) {
      await setCloudStock(api, branchId, productId, qty, cloudToken);
    }

    const reg = await api.edge.post('/api/auth/register', {
      body: { company_name: 'Toko Pindah Cabang', ...OWNER },
    });
    const adminToken = reg.body.token;
    await api.edge.put('/api/edge/config', {
      token: adminToken,
      body: { upstream: world.cloud.url },
    });
    const pair = await api.edge.post('/api/edge/pair', {
      token: adminToken,
      body: { email: OWNER.email, password: OWNER.password },
    });
    assert.ok(pair.status < 300, `pair failed: ${JSON.stringify(pair.body)}`);

    const bootFirst = await api.edge.post('/api/edge/bootstrap', {
      token: adminToken,
      body: { branch_id: first },
    });
    assert.ok(bootFirst.status < 300, `first replicate failed: ${JSON.stringify(bootFirst.body)}`);
    assert.equal(bootFirst.body.products, 1);

    // This bootstrap re-tenanted the till's own admin row, so the token above is
    // now stale. Every later call must use the replacement the service returned.
    const sessionToken = bootFirst.body.token || adminToken;

    // The regression: this used to answer 500 "UNIQUE constraint failed:
    // branch_stocks.id" because the row id was built from the product alone.
    const bootSecond = await api.edge.post('/api/edge/bootstrap', {
      token: sessionToken,
      body: { branch_id: secondBranch },
    });
    assert.ok(
      bootSecond.status < 300,
      `switching branch must not collide: ${JSON.stringify(bootSecond.body)}`
    );
    assert.equal(bootSecond.body.products, 1, 'the same catalog lands on the new branch');

    // Re-running the first branch again is still fine (idempotent, one stock row
    // each). This also moves the till's active branch back to `first`, which is
    // what the service is meant to do: bootstrap adopts the branch it just pulled.
    const bootAgain = await api.edge.post('/api/edge/bootstrap', {
      token: sessionToken,
      body: { branch_id: first },
    });
    assert.ok(bootAgain.status < 300, `re-replicate failed: ${JSON.stringify(bootAgain.body)}`);

    const infoAfterFirst = await api.edge.get('/api/edge/info', { token: sessionToken });
    assert.equal(infoAfterFirst.body.branch_id, first, 'bootstrap adopts the branch it pulled');

    // Switch back to the second branch, the way the dropdown does, and check each
    // branch kept its OWN stock row. The old bug either failed outright or wrote
    // one shared row keyed on the product alone.
    const bootSecondAgain = await api.edge.post('/api/edge/bootstrap', {
      token: sessionToken,
      body: { branch_id: secondBranch },
    });
    assert.ok(bootSecondAgain.status < 300, `switch back failed: ${JSON.stringify(bootSecondAgain.body)}`);

    const info = await api.edge.get('/api/edge/info', { token: sessionToken });
    assert.equal(info.body.branch_id, secondBranch, 'the till stays on the chosen branch');

    // Read the till's own replica file. The branch-scoped HTTP route answers 403
    // here because the till registered its OWN company locally, so the caller is
    // not in scope for a cloud branch id — that is a permission question, not the
    // collision this test is about. What the fix changed is the replicated rows.
    const replica = openReplica(world.edge.dataDir);
    try {
      const stockRows = replica
        .prepare('SELECT id, branch_id, product_id, quantity FROM branch_stocks WHERE product_id = ? ORDER BY branch_id')
        .all(productId);
      assert.equal(stockRows.length, 2, 'one stock row per branch, not one shared row');
      const byBranch = new Map(stockRows.map((r) => [r.branch_id, r]));
      assert.equal(Number(byBranch.get(first).quantity), 40, 'the home branch keeps its own quantity');
      assert.equal(Number(byBranch.get(secondBranch).quantity), 7, 'the new branch keeps its own quantity');
      assert.notEqual(byBranch.get(first).id, byBranch.get(secondBranch).id, 'row ids are per branch');

      const priceRows = replica
        .prepare('SELECT id, branch_id FROM branch_products WHERE product_id = ?')
        .all(productId);
      assert.equal(priceRows.length, 2, 'price overrides are per branch too');
    } finally {
      replica.close();
    }
  } finally {
    await world.stop();
  }
});

/**
 * A PIN-less user is a different problem from a wrong PIN, and the cashier must
 * be told which one it is — retrying can never fix a missing PIN.
 */
test('offline unlock explains a missing PIN instead of reporting a wrong one', async () => {
  const world = await startWorld();
  try {
    const { api } = world;

    const cloudReg = await api.cloud.post('/api/auth/register', {
      body: { company_name: 'Toko Tanpa PIN', ...OWNER },
    });
    const branchId = cloudReg.body.user.branch_id;

    const reg = await api.edge.post('/api/auth/register', {
      body: { company_name: 'Toko Tanpa PIN', ...OWNER },
    });
    const adminToken = reg.body.token;
    await api.edge.put('/api/edge/config', { token: adminToken, body: { upstream: world.cloud.url } });
    await api.edge.post('/api/edge/pair', {
      token: adminToken,
      body: { email: OWNER.email, password: OWNER.password },
    });
    const boot = await api.edge.post('/api/edge/bootstrap', { token: adminToken, body: { branch_id: branchId } });
    // Bootstrap re-tenants this till's admin row, so the token above is spent.
    const sessionToken = boot.body.token || adminToken;

    const users = await api.edge.get(`/api/edge/pin-users?branch_id=${branchId}`, { token: sessionToken });
    const ownerRow = users.body.find((u) => u.name === OWNER.name);
    assert.ok(ownerRow, 'the owner is replicated despite having no PIN');

    const unlock = await api.edge.post('/api/edge/unlock', {
      body: { user_id: ownerRow.id, pin: '1234' },
    });
    assert.equal(unlock.status, 409, 'a missing PIN is not a 401 auth failure');
    assert.equal(unlock.body.no_pin, true);
    assert.match(unlock.body.error, /belum mengatur PIN/i);
  } finally {
    await world.stop();
  }
});


/* -------------------------------------------------------------------------- */
/* A stale device token must be reported as "pair again", not "no internet"    */
/* -------------------------------------------------------------------------- */

test('a stale device token is reported as a re-pair, not a connection failure', async (t) => {
  // `startPairedWorld` spreads the pairing result over `edge`, hiding the server
  // object that carries `dataDir`. Build the pair step by step so both handles
  // stay available.
  const world = await startWorld();
  t.after(() => world.stop());
  const seeded = await seedCloud(world.api);
  const edge = await pairAndBootstrap(world, seeded);

  // Simulate what a reseeded cloud looks like from the till's side: the stored
  // `edge_device_token` still parses, but it is no longer one the cloud will
  // honour. This is not hypothetical — a till installed against an earlier
  // cloud DB showed exactly this, and the panel told the operator to check
  // their internet, which can never fix it.
  const stale =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
    '.eyJzdWIiOiJ1c2VyLXRoYXQtbm8tbG9uZ2VyLWV4aXN0cyIsImNvbXBhbnlfaWQiOiJ4Iiwicm9sZSI6InN1cGVyX2FkbWluIn0' +
    '.c2lnbmF0dXJlLW5vdC12ZXJpZmllZC1ieS10aGUtY2xvdWQ';
  setSetting(world.edge.dataDir, 'edge_device_token', stale);
  // …and the reseeded cloud never saw the till's refresh token either, so the
  // automatic renewal that heals a merely-expired token cannot help here. Losing
  // the pairing entirely is exactly the case that must still ask for a re-pair.
  setSetting(world.edge.dataDir, 'edge_refresh_token', null);

  const res = await world.api.edge.get('/api/edge/cloud-branches', { token: edge.adminToken });

  assert.equal(res.status, 200, 'the endpoint must still answer, with a reason');
  assert.equal(res.body.paired, true);
  assert.deepEqual(res.body.branches, [], 'a rejected token yields no branches');

  // The cloud rejects the *signature* first, so the message varies between
  // "invalid or expired token" and "user inactive or not found". Both mean the
  // same thing to the operator, and neither is a network fault.
  const reason = String(res.body.reason || '');
  assert.ok(reason.length > 0, 'a reason must be given');
  assert.ok(/hubungkan ulang|kedaluwarsa/i.test(reason), `expected a re-pair message, got: ${reason}`);
  assert.ok(
    !/koneksi internet/i.test(reason),
    `a rejected token must not be blamed on the internet, got: ${reason}`,
  );
});

/**
 * An expired (but otherwise valid) device token must be renewed, not fatal.
 *
 * The drain authenticates with the token stored at pairing, and that token has the
 * cloud's ordinary access lifetime. Before this, every lane stopped syncing an hour
 * after the till was paired — sales, parked carts and kitchen tickets all backed off
 * forever with "Invalid or expired token" until somebody re-paired by hand.
 */
test('an expired device token is renewed instead of losing the queue', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, prepared } = world.seeded;

  // A sale is waiting to go out…
  const sale = await api.edge.post('/api/transactions', {
    token: world.edge.edgeToken,
    body: saleBody({ branchId, productId: prepared.id, quantity: 1, price: prepared.default_price, clientUuid: 'refresh-1' }),
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));

  // …and an hour later the access token is dead, exactly as `JWT_EXPIRES` makes it.
  setSetting(world.servers.edge.dataDir, 'edge_device_token', 'expired.not.a.token');

  // The refresh token kept at pairing is the way back in. Tests obtain one the same
  // way pairing does: a real login against the cloud.
  const login = await api.cloud.post('/api/auth/login', { body: { email: OWNER.email, password: OWNER.password } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  setSetting(world.servers.edge.dataDir, 'edge_refresh_token', login.body.refresh_token);

  const drain = await api.edge.post('/api/edge/drain', { token: world.edge.edgeToken, body: { branch_id: branchId } });
  assert.equal(drain.status, 200, `the drain recovers instead of failing: ${JSON.stringify(drain.body)}`);
  assert.equal(drain.body.applied, 1, 'the queued sale still applies');

  // The replacement pair is persisted, so the next tick does not log in again.
  const db = openReplica(world.servers.edge.dataDir);
  try {
    const token = db.prepare("SELECT value FROM settings WHERE key = 'edge_device_token'").get();
    const refresh = db.prepare("SELECT value FROM settings WHERE key = 'edge_refresh_token'").get();
    assert.ok(token.value && token.value !== 'expired.not.a.token', 'a fresh access token was stored');
    assert.ok(refresh.value && refresh.value !== login.body.refresh_token, 'and the rotated refresh token replaced the old one');
  } finally {
    db.close();
  }
});

/**
 * A fresh till must be able to be pointed at a cloud that is NOT on loopback.
 *
 * The reported symptom was the inverse of what the code assumed: the operator
 * filled in "Alamat Server" on a brand-new install, the form said it worked, and
 * the till still talked to `127.0.0.1` — because that field writes
 * `pos_server_url`, which the desktop app overwrites with its own embedded
 * service's loopback URL on every boot. The value that matters is the *upstream*,
 * and nothing in the UI was writing it.
 *
 * This covers the half the frontend cannot: the service must accept a non-loopback
 * address, persist it, report it back, and actually use it when pairing.
 */
test('the service accepts and uses a non-loopback upstream', async (t) => {
  const world = await startWorld();
  t.after(() => world.stop());
  const seeded = await seedCloud(world.api);

  const reg = await world.api.edge.post('/api/auth/register', {
    body: { company_name: 'Toko Server Pusat', ...OWNER },
  });
  const adminToken = reg.body.token;

  // A cloud reachable over a real socket, which is the normal deployment: the
  // till is on a shop counter, the cloud is somewhere else entirely.
  const remote = world.cloud.url;
  assert.match(remote, /^http:\/\/127\.0\.0\.1:\d+$/, 'the harness cloud has a real URL');

  const cfg = await world.api.edge.put('/api/edge/config', {
    token: adminToken,
    body: { upstream: remote },
  });
  assert.ok(cfg.status < 300, `config failed: ${JSON.stringify(cfg.body)}`);
  assert.equal(cfg.body.upstream, remote, 'the service must echo the address it stored');

  // It must be persisted, not merely held in memory — the reported bug was a value
  // that looked saved in the UI but was gone (back to loopback) after a restart.
  const info = await world.api.edge.get('/api/edge/info');
  assert.equal(info.body.upstream, remote, 'the address must be persisted, not just held in memory');

  // And pairing goes to *that* address rather than assuming localhost.
  const pair = await world.api.edge.post('/api/edge/pair', {
    token: adminToken,
    body: { email: OWNER.email, password: OWNER.password },
  });
  assert.ok(pair.status < 300, `pair against the remote upstream failed: ${JSON.stringify(pair.body)}`);

  const boot = await world.api.edge.post('/api/edge/bootstrap', {
    token: adminToken,
    body: { branch_id: seeded.branchId },
  });
  assert.ok(boot.status < 300, `bootstrap failed: ${JSON.stringify(boot.body)}`);
  assert.ok(boot.body.products > 0, 'products should have replicated from the configured upstream');
});

/* -------------------------------------------------------------------------- */
/* 6. Custom roles on a paired till                                           */
/* -------------------------------------------------------------------------- */

/**
 * Regression: a custom role existed only in the cloud's `roles` table.
 *
 * `users.role` is replicated as a bare string, so the till knew the *name* of a
 * custom role and nothing about what it grants: `getPermissions` found no row,
 * returned `[]`, and the person could unlock the till and then be bounced out of
 * every guarded page with no explanation. System roles hid the bug completely —
 * they live in code on both sides — so it only ever appeared for shops that had
 * actually created a role, offline, in the field.
 *
 * The assertions read the real replica file as well as the HTTP surface, because
 * the defect was a missing row: a route check that passed for another reason
 * would hide it.
 */
test('a custom role replicates to the till and grants its permissions offline', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { api } = world;
  const { branchId, token } = world.seeded;

  // A role that may look at stock but must not read the audit trail: one held
  // permission and one withheld gives the test a positive and a negative case.
  const role = await api.cloud.post('/api/roles', {
    token,
    body: {
      name: 'supervisor_shift',
      description: 'Kasir senior yang boleh buka shift',
      permissions: ['transaction.create', 'stock.view'],
    },
  });
  assert.ok(role.status < 300, `role create failed: ${JSON.stringify(role.body)}`);

  const pin = '9876';
  const user = await api.cloud.post('/api/users', {
    token,
    body: {
      name: 'Sinta',
      email: 'sinta@uji.id',
      password: 'rahasia123',
      role: 'supervisor_shift',
      branch_id: branchId,
      pin,
    },
  });
  assert.ok(user.status < 300, `user create failed: ${JSON.stringify(user.body)}`);
  const userId = user.body.id || user.body.user?.id;
  assert.equal(user.body.role, 'supervisor_shift');

  // The payload carries roles separately from the users that name them, so a till
  // can sync roles without re-pulling the roster.
  const snapshot = await api.cloud.get(`/api/sync/bootstrap?branch_id=${branchId}`, { token });
  assert.equal(snapshot.status, 200);
  const shipped = (snapshot.body.roles || []).find((r) => r.name === 'supervisor_shift');
  assert.ok(shipped, 'the bootstrap payload must carry custom roles');
  assert.deepEqual([...shipped.permissions].sort(), ['stock.view', 'transaction.create']);
  assert.ok(
    !(snapshot.body.roles || []).some((r) => r.name === 'cashier'),
    'system roles stay in code; shipping them would let the copies drift',
  );

  // Re-sync, as Settings › Diagnostik does.
  const boot = await api.edge.post('/api/edge/bootstrap', {
    token: world.edge.adminToken,
    body: { branch_id: branchId },
  });
  assert.ok(boot.status < 300, `re-bootstrap failed: ${JSON.stringify(boot.body)}`);
  assert.equal(boot.body.roles, 1, 'the custom role is replicated');
  const healthyAdminToken = boot.body.token || world.edge.adminToken;

  // The row itself — the thing that was missing.
  // `startPairedWorld` keeps the server handles under `servers` and uses `edge`
  // for the token bundle, so the replica path is `servers.edge.dataDir`.
  const replica = openReplica(world.servers.edge.dataDir);
  try {
    const row = replica.prepare('SELECT name, permissions FROM roles WHERE name = ?').get('supervisor_shift');
    assert.ok(row, 'the roles row must exist in the replica');
    assert.deepEqual(JSON.parse(row.permissions).sort(), ['stock.view', 'transaction.create']);
  } finally {
    replica.close();
  }

  // Offline login now grants the role's permissions instead of an empty list.
  const unlock = await api.edge.post('/api/edge/unlock', { body: { user_id: userId, pin } });
  assert.equal(unlock.status, 200, `unlock failed: ${JSON.stringify(unlock.body)}`);
  assert.deepEqual(
    [...unlock.body.permissions].sort(),
    ['stock.view', 'transaction.create'],
    'a replicated custom role must grant exactly what it grants on the cloud',
  );

  // Enforced, not merely reported: a route gated on a held permission opens…
  const overview = await api.edge.get('/api/stock/overview', { token: unlock.body.token });
  assert.equal(overview.status, 200, 'stock.view from the custom role must open a guarded route');

  // …and one gated on a permission the role does not hold stays shut.
  const auditDenied = await api.edge.get('/api/audit-logs', { token: unlock.body.token });
  assert.equal(auditDenied.status, 403, 'a permission the role does not hold must still be refused');

  // An edited role must reach the till on the next sync; otherwise a revoked
  // permission would keep working on that device forever.
  const edit = await api.cloud.put(`/api/roles/${role.body.id}`, {
    token,
    body: { permissions: ['transaction.create', 'stock.view', 'audit.view'] },
  });
  assert.ok(edit.status < 300, `role update failed: ${JSON.stringify(edit.body)}`);

  const boot2 = await api.edge.post('/api/edge/bootstrap', {
    token: healthyAdminToken,
    body: { branch_id: branchId },
  });
  assert.ok(boot2.status < 300, `second re-bootstrap failed: ${JSON.stringify(boot2.body)}`);
  assert.equal(boot2.body.roles, 1, 'a re-sync refreshes the role rather than duplicating it');

  const replica2 = openReplica(world.servers.edge.dataDir);
  try {
    const n = replica2.prepare('SELECT COUNT(*) AS n FROM roles WHERE name = ?').get('supervisor_shift').n;
    assert.equal(n, 1, 'one row per role name, however many times the till syncs');
  } finally {
    replica2.close();
  }

  const unlock2 = await api.edge.post('/api/edge/unlock', { body: { user_id: userId, pin } });
  assert.equal(unlock2.status, 200, `second unlock failed: ${JSON.stringify(unlock2.body)}`);
  assert.ok(unlock2.body.permissions.includes('audit.view'), 'the edited permission reaches the till');

  const auditAllowed = await api.edge.get('/api/audit-logs', { token: unlock2.body.token });
  assert.equal(auditAllowed.status, 200, 'the newly granted permission works offline');
});

/* -------------------------------------------------------------------------- */
/* 7. Product variants on a paired till                                       */
/* -------------------------------------------------------------------------- */

/**
 * Regression: variants existed on the cloud only.
 *
 * The snapshot has always carried `variants` inside each product, but
 * `applyBootstrap` never wrote them, so the till's `product_variants` table
 * stayed empty. The product list counts that table for its Variants column —
 * every product read 0 — and the POS offers options from it and prices them off
 * `price_adjustment`, so "Large +4.000" simply did not exist offline and the
 * drink rang up at its base price.
 *
 * Asserted at three levels because each one failed differently: the rows in the
 * replica, the two read paths the UI uses, and a sale that actually has to charge
 * the adjustment.
 */
test('product variants replicate to the till and price a sale offline', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { api } = world;
  const { branchId, token, products } = world.seeded;
  // Kopi Susu, 18.000, 30 on the shelf.
  const kopi = products[0];

  const regular = await api.cloud.post(`/api/products/${kopi.id}/variants`, {
    token,
    body: { name: 'Regular', variant_type: 'Ukuran', price_adjustment: 0, is_default: 1, sort_order: 1 },
  });
  const large = await api.cloud.post(`/api/products/${kopi.id}/variants`, {
    token,
    body: { name: 'Large', variant_type: 'Ukuran', price_adjustment: 4000, sort_order: 2 },
  });
  assert.ok(regular.status < 300, `variant create failed: ${JSON.stringify(regular.body)}`);
  assert.ok(large.status < 300, `variant create failed: ${JSON.stringify(large.body)}`);

  const boot = await api.edge.post('/api/edge/bootstrap', {
    token: world.edge.adminToken,
    body: { branch_id: branchId },
  });
  assert.ok(boot.status < 300, `re-bootstrap failed: ${JSON.stringify(boot.body)}`);
  assert.equal(boot.body.variants, 2, 'both variants replicate');

  const replica = openReplica(world.servers.edge.dataDir);
  try {
    const rows = replica
      .prepare('SELECT name, price_adjustment FROM product_variants WHERE product_id = ? ORDER BY sort_order')
      .all(kopi.id);
    assert.deepEqual(
      rows.map((r) => [r.name, Number(r.price_adjustment)]),
      [['Regular', 0], ['Large', 4000]],
      'the option and its surcharge survive the copy',
    );
  } finally {
    replica.close();
  }

  // The Products page reads `variant_count`; it read 0 for every product before.
  const list = await api.edge.get('/api/products', { token: world.edge.edgeToken });
  assert.equal(list.status, 200, `product list failed: ${JSON.stringify(list.body)}`);
  assert.equal(list.body.find((p) => p.id === kopi.id)?.variant_count, 2, 'the Variants column is no longer 0');

  // The POS reads variants from the branch catalog.
  const catalog = await api.edge.get(`/api/branches/${branchId}/catalog`, { token: world.edge.edgeToken });
  assert.equal(catalog.status, 200, `catalog failed: ${JSON.stringify(catalog.body)}`);
  const offered = catalog.body.find((p) => p.id === kopi.id);
  assert.deepEqual((offered?.variants || []).map((v) => v.name), ['Regular', 'Large']);

  // Offline, a drink sold as "Large" has to cost 18.000 + 4.000. This is the
  // assertion that would have caught a wrong `price_adjustment` even if the rows
  // had replicated: the till had no option at all, so it charged the base price.
  const sale = await api.edge.post('/api/transactions', {
    token: world.edge.edgeToken,
    body: {
      branch_id: branchId,
      client_uuid: 'variant-offline-1',
      items: [{ product_id: kopi.id, variant_id: large.body.id, variant_label: 'Large', quantity: 1, price: kopi.default_price }],
      payment_method: 'cash',
      cash_received: 50000,
    },
  });
  assert.equal(sale.status, 201, `sale failed: ${JSON.stringify(sale.body)}`);
  assert.equal(sale.body.total, 22000, 'the surcharge is charged offline, not just displayed');
  assert.equal(sale.body.items[0].variant_label, 'Large');
  assert.equal(sale.body.items[0].price, 22000);

  // Re-syncing refreshes the rows instead of duplicating them.
  const boot2 = await api.edge.post('/api/edge/bootstrap', {
    token: world.edge.adminToken,
    body: { branch_id: branchId },
  });
  assert.ok(boot2.status < 300, `second re-bootstrap failed: ${JSON.stringify(boot2.body)}`);
  assert.equal(boot2.body.variants, 2);

  // Switching a variant off in the cloud retires it on the till. The payload
  // ships active variants only, so a till that merely upserted would keep
  // offering — and charging for — an option the shop has withdrawn.
  const off = await api.cloud.put(`/api/variants/${large.body.id}`, { token, body: { is_active: 0 } });
  assert.ok(off.status < 300, `variant update failed: ${JSON.stringify(off.body)}`);

  const boot3 = await api.edge.post('/api/edge/bootstrap', {
    token: world.edge.adminToken,
    body: { branch_id: branchId },
  });
  assert.ok(boot3.status < 300, `third re-bootstrap failed: ${JSON.stringify(boot3.body)}`);
  assert.equal(boot3.body.variants, 1, 'only the active variant ships');

  const catalog2 = await api.edge.get(`/api/branches/${branchId}/catalog`, { token: world.edge.edgeToken });
  assert.deepEqual(
    (catalog2.body.find((p) => p.id === kopi.id)?.variants || []).map((v) => v.name),
    ['Regular'],
    'the withdrawn option is no longer offered',
  );

  const replica2 = openReplica(world.servers.edge.dataDir);
  try {
    const rows = replica2
      .prepare('SELECT name, is_active FROM product_variants WHERE product_id = ? ORDER BY name')
      .all(kopi.id);
    assert.equal(rows.length, 2, 'the row is deactivated, not deleted: old receipts still name it');
    assert.equal(Number(rows.find((r) => r.name === 'Large').is_active), 0);
    assert.equal(Number(rows.find((r) => r.name === 'Regular').is_active), 1);
  } finally {
    replica2.close();
  }
});


/* -------------------------------------------------------------------------- */
/* KDS status propagation: the till's board reaches the cloud                 */
/* -------------------------------------------------------------------------- */
/*
 * Regression for the gap this whole lane exists for: a ticket was created on the
 * cloud once, during the sale replay, and then never updated. The bar could move a
 * ticket to `preparing`/`ready`/`completed` (or cancel it, or tick a line off) and
 * the cloud board stayed frozen at `queue` forever.
 */

/** The till's `order_queue` id for the sale with `clientUuid` (null when none). */
function edgeTicketId(dataDir, clientUuid) {
  const db = openReplica(dataDir);
  try {
    const row = db
      .prepare(
        'SELECT q.id FROM order_queue q JOIN transactions t ON t.id = q.transaction_id WHERE t.client_uuid = ?'
      )
      .get(clientUuid);
    return row ? row.id : null;
  } finally {
    db.close();
  }
}

/** The cloud ticket (with its lines' done flags) for `clientUuid`, or null if absent. */
function cloudTicket(dataDir, clientUuid) {
  const db = openReplica(dataDir);
  try {
    const tx = db.prepare('SELECT id FROM transactions WHERE client_uuid = ?').get(clientUuid);
    if (!tx) return null;
    const q = db.prepare('SELECT * FROM order_queue WHERE transaction_id = ?').get(tx.id);
    if (!q) return null;
    q.items = db.prepare('SELECT product_id, done FROM order_queue_items WHERE queue_id = ? ORDER BY rowid').all(q.id);
    return q;
  } finally {
    db.close();
  }
}

test('a ticket walked through the board on the till ends up the same on the cloud', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, prepared } = world.seeded;
  const clientUuid = 'kds-lifecycle-1';

  const sale = await api.edge.post('/api/transactions', {
    token: world.edge.edgeToken,
    body: saleBody({ branchId, productId: prepared.id, quantity: 2, price: prepared.default_price, clientUuid }),
  });
  assert.equal(sale.status, 201, 'the prepared-item sale is written locally first');

  const ticketId = edgeTicketId(world.servers.edge.dataDir, clientUuid);
  assert.ok(ticketId, 'a categorised line raises a KDS ticket on the till');
  assert.equal(cloudTicket(world.servers.cloud.dataDir, clientUuid), null, 'the cloud has nothing until the sale syncs');

  const drain = () =>
    api.edge.post('/api/edge/drain', { token: world.edge.edgeToken, body: { branch_id: branchId } });
  const move = async (body) => {
    const res = await api.edge.patch(`/api/queue/${ticketId}/status`, { token: world.edge.adminToken, body });
    assert.equal(res.status, 200, `the till accepts ${body.status}: ${JSON.stringify(res.body)}`);
    const d = await drain();
    assert.equal(d.status, 200);
    return d.body;
  };

  // 1. The sale replays and creates the cloud ticket at 'queue'.
  const first = await drain();
  assert.equal(first.body.applied, 1, 'the sale applies on the first drain');
  assert.equal(cloudTicket(world.servers.cloud.dataDir, clientUuid).status, 'queue');

  // 2. preparing — the exact transition that used to stay on the till.
  const prep = await move({ status: 'preparing' });
  assert.equal(prep.queueSync.applied, 1, 'the status change rides the queue lane');
  assert.equal(cloudTicket(world.servers.cloud.dataDir, clientUuid).status, 'preparing', 'the cloud follows to preparing');

  // 2b. Ticking a line done while the ticket is preparing.
  const lineItem = (() => {
    const db = openReplica(world.servers.edge.dataDir);
    try {
      return db.prepare('SELECT id FROM order_queue_items WHERE queue_id = ? ORDER BY rowid LIMIT 1').get(ticketId);
    } finally {
      db.close();
    }
  })();
  assert.ok(lineItem, 'the ticket has at least one line');
  const tick = await move({ status: 'preparing', item_id: lineItem.id, done: true });
  assert.equal(tick.queueSync.applied, 1, 'a line tick also rides the queue lane');
  assert.equal(cloudTicket(world.servers.cloud.dataDir, clientUuid).items[0].done, 1, 'the cloud line tick matches');

  // 3. ready
  await move({ status: 'ready' });
  assert.equal(cloudTicket(world.servers.cloud.dataDir, clientUuid).status, 'ready');

  // 4. completed
  const done = await move({ status: 'completed' });
  assert.equal(done.queueSync.applied, 1);
  const finished = cloudTicket(world.servers.cloud.dataDir, clientUuid);
  assert.equal(finished.status, 'completed', 'the cloud board is NOT stuck at the first stage');
  assert.ok(finished.completed_at, 'the closing timestamp is synced');

  // Exactly one cloud ticket, however many transitions happened.
  const cdb = openReplica(world.servers.cloud.dataDir);
  try {
    assert.equal(cdb.prepare('SELECT COUNT(*) AS n FROM order_queue').get().n, 1, 'transitions patch, never duplicate');
  } finally {
    cdb.close();
  }
});

test('a ticket completed before its sale syncs still lands as completed', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, prepared } = world.seeded;
  const clientUuid = 'kds-offline-1';

  await api.edge.post('/api/transactions', {
    token: world.edge.edgeToken,
    body: saleBody({ branchId, productId: prepared.id, quantity: 1, price: prepared.default_price, clientUuid }),
  });
  const ticketId = edgeTicketId(world.servers.edge.dataDir, clientUuid);
  assert.ok(ticketId);

  // Finish the ticket offline: no drain in between, so the cloud has never seen
  // the sale. The coalesced snapshot must carry the *final* state, not the first.
  for (const status of ['preparing', 'ready', 'completed']) {
    const r = await api.edge.patch(`/api/queue/${ticketId}/status`, { token: world.edge.adminToken, body: { status } });
    assert.equal(r.status, 200, `the till accepts ${status}: ${JSON.stringify(r.body)}`);
  }
  assert.equal(cloudTicket(world.servers.cloud.dataDir, clientUuid), null, 'the cloud still knows nothing');

  const drain = await api.edge.post('/api/edge/drain', { token: world.edge.edgeToken, body: { branch_id: branchId } });
  assert.equal(drain.body.applied, 1, 'the sale applies');
  assert.equal(drain.body.queueSync.applied, 1, 'and its latest ticket state applies in the same drain');

  const finished = cloudTicket(world.servers.cloud.dataDir, clientUuid);
  assert.equal(finished.status, 'completed', 'the cloud goes straight to completed, not stuck at queue');
  assert.ok(finished.completed_at, 'the closing timestamp made it too');
});

test('a cancelled ticket carries its reason to the cloud', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, prepared } = world.seeded;
  const clientUuid = 'kds-cancel-1';

  await api.edge.post('/api/transactions', {
    token: world.edge.edgeToken,
    body: saleBody({ branchId, productId: prepared.id, quantity: 1, price: prepared.default_price, clientUuid }),
  });
  const ticketId = edgeTicketId(world.servers.edge.dataDir, clientUuid);
  assert.ok(ticketId);

  const cancel = await api.edge.patch(`/api/queue/${ticketId}/status`, {
    token: world.edge.adminToken,
    body: { status: 'cancelled', reason: 'Salah input' },
  });
  assert.equal(cancel.status, 200, `the till accepts the cancellation: ${JSON.stringify(cancel.body)}`);

  const drain = await api.edge.post('/api/edge/drain', { token: world.edge.edgeToken, body: { branch_id: branchId } });
  assert.equal(drain.body.applied, 1, 'the sale applies');
  assert.equal(drain.body.queueSync.applied, 1, 'the cancellation rides the queue lane');

  const cancelled = cloudTicket(world.servers.cloud.dataDir, clientUuid);
  assert.equal(cancelled.status, 'cancelled', 'the cloud board shows the cancellation');
  assert.equal(cancelled.cancel_reason, 'Salah input', 'and its reason, for the audit trail');
  assert.ok(cancelled.completed_at, 'a cancellation stamps a closing time');
});


/* -------------------------------------------------------------------------- */
/* "On Hold" carts: the till's parked carts reach the cloud                   */
/* -------------------------------------------------------------------------- */
/*
 * Regression for the second gap of the same family: parking a cart wrote
 * `hold_orders` + a KDS ticket on the till and nothing else, because a hold is
 * cart state, not money, and the sale replay only knows about paid transactions.
 * The cloud's Hold list stayed empty and the ticket raised for the parked cart
 * existed on the till alone.
 */

/** The cloud's copy of a hold (with its lines), or null when it was never mirrored. */
function cloudHold(dataDir, holdId) {
  const db = openReplica(dataDir);
  try {
    const h = db.prepare('SELECT * FROM hold_orders WHERE id = ?').get(holdId);
    if (!h) return null;
    h.items = db
      .prepare('SELECT * FROM hold_order_items WHERE hold_order_id = ? ORDER BY rowid')
      .all(holdId);
    return h;
  } finally {
    db.close();
  }
}

/** The cloud's ticket for a hold, addressed the way the sync lane addresses it. */
function cloudHoldTicket(dataDir, holdId) {
  const db = openReplica(dataDir);
  try {
    return (
      db
        .prepare(
          'SELECT * FROM order_queue WHERE origin_ref = ? OR hold_order_id = ? ORDER BY rowid LIMIT 1'
        )
        .get(holdId, holdId) || null
    );
  } finally {
    db.close();
  }
}

/** Rows still waiting in the hold lane (0 means the till has nothing left to push). */
function pendingHoldSync(dataDir) {
  const db = openReplica(dataDir);
  try {
    // Applied rows stay behind as `synced` markers, so only `pending` means work.
    return db.prepare("SELECT COUNT(*) AS n FROM edge_hold_sync WHERE status = 'pending'").get().n;
  } finally {
    db.close();
  }
}

/** Park a cart on the till with one prepared (categorised) line. */
function parkBody({ branchId, prepared, label = 'Meja 4', quantity = 2 }) {
  return {
    branch_id: branchId,
    label,
    items: [
      {
        product_id: prepared.id,
        product_name: prepared.name,
        price: prepared.default_price,
        quantity,
      },
    ],
  };
}



test('a parked ("On Hold") cart on the till appears on the cloud', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, prepared } = world.seeded;

  const held = await api.edge.post('/api/holds', {
    token: world.edge.edgeToken,
    body: parkBody({ branchId, prepared }),
  });
  assert.equal(held.status, 201, `the till parks the cart: ${JSON.stringify(held.body)}`);
  const holdId = held.body.id;
  assert.ok(held.body.queue_id, 'parking a prepared line raises a KDS ticket on the till');
  assert.equal(cloudHold(world.servers.cloud.dataDir, holdId), null, 'the cloud has nothing until the till drains');

  const drain = await api.edge.post('/api/edge/drain', { token: world.edge.edgeToken, body: { branch_id: branchId } });
  assert.equal(drain.status, 200, JSON.stringify(drain.body));
  assert.equal(drain.body.holdSync.applied, 1, 'the parked cart rides its own lane');
  assert.equal(pendingHoldSync(world.servers.edge.dataDir), 0, 'and the lane is left empty');

  const mirror = cloudHold(world.servers.cloud.dataDir, holdId);
  assert.ok(mirror, 'the cloud Hold list now has the cart');
  assert.equal(mirror.label, 'Meja 4', 'including the label the cashier typed');
  assert.equal(mirror.branch_id, branchId);
  assert.equal(mirror.total, held.body.total, 'and the same total');
  assert.equal(mirror.items.length, 1, 'with its line');
  assert.equal(mirror.items[0].product_name, prepared.name);
  assert.equal(mirror.items[0].quantity, 2);

  const ticket = cloudHoldTicket(world.servers.cloud.dataDir, holdId);
  assert.ok(ticket, 'the ticket raised for the parked cart exists there too');
  assert.equal(ticket.status, 'queue', 'waiting at the station, exactly like the till');
  assert.equal(ticket.origin_ref, holdId, 'and carries the ref later patches address it by');
});

test("a parked cart's ticket moves on the cloud board", async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, prepared } = world.seeded;

  const held = await api.edge.post('/api/holds', {
    token: world.edge.edgeToken,
    body: parkBody({ branchId, prepared }),
  });
  assert.equal(held.status, 201, JSON.stringify(held.body));
  const holdId = held.body.id;
  const ticketId = held.body.queue_id;

  const drain = () =>
    api.edge.post('/api/edge/drain', { token: world.edge.edgeToken, body: { branch_id: branchId } });
  const move = async (body) => {
    const res = await api.edge.patch(`/api/queue/${ticketId}/status`, { token: world.edge.adminToken, body });
    assert.equal(res.status, 200, `the till accepts ${body.status}: ${JSON.stringify(res.body)}`);
    return drain();
  };

  assert.equal((await drain()).body.holdSync.applied, 1);

  // Keep it parked while the bar starts making it: the cart does not change, so
  // only the queue lane can carry this move.
  const prep = await move({ status: 'preparing' });
  assert.equal(prep.body.queueSync.applied, 1, 'the move rides the queue lane');
  const preparing = cloudHoldTicket(world.servers.cloud.dataDir, holdId);
  assert.equal(preparing.status, 'preparing', 'the cloud board follows a hold ticket too');
  assert.ok(preparing.started_at, 'with its start stamp');

  await move({ status: 'ready' });
  assert.equal(cloudHoldTicket(world.servers.cloud.dataDir, holdId).status, 'ready');

  // Exactly one ticket on each side, however many transitions happened.
  for (const dataDir of [world.servers.edge.dataDir, world.servers.cloud.dataDir]) {
    const db = openReplica(dataDir);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_queue').get().n, 1, 'transitions patch, never duplicate');
    } finally {
      db.close();
    }
  }
});

test('resuming or discarding a parked cart clears it from the cloud', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, prepared } = world.seeded;

  const held = await api.edge.post('/api/holds', {
    token: world.edge.edgeToken,
    body: parkBody({ branchId, prepared }),
  });
  assert.equal(held.status, 201, JSON.stringify(held.body));
  const holdId = held.body.id;

  const drain = () =>
    api.edge.post('/api/edge/drain', { token: world.edge.edgeToken, body: { branch_id: branchId } });
  await drain();
  assert.ok(cloudHold(world.servers.cloud.dataDir, holdId), 'the cart is mirrored first');

  // What the app does on resume: fetch the cart, drop it, rehydrate the till.
  const resume = await api.edge.del(`/api/holds/${holdId}`, { token: world.edge.edgeToken });
  assert.equal(resume.status, 200, JSON.stringify(resume.body));
  assert.equal(resume.body.queue_removed, 1, 'an untouched hold ticket goes with it, as before');

  const after = await drain();
  assert.equal(after.body.holdSync.applied, 1, 'the tombstone is pushed');
  assert.equal(cloudHold(world.servers.cloud.dataDir, holdId), null, 'and the cloud Hold list is clean again');
  // Untouched ticket settled on the cloud too, so the bar is not sent to make a
  // drink for a cart nobody is paying for.
  assert.equal(cloudHoldTicket(world.servers.cloud.dataDir, holdId), null, 'no ghost ticket left on the board');

  // Nothing lingers in either lane waiting to be retried.
  assert.equal(pendingHoldSync(world.servers.edge.dataDir), 0);
  const edgeDb = openReplica(world.servers.edge.dataDir);
  try {
    assert.equal(edgeDb.prepare('SELECT COUNT(*) AS n FROM edge_queue_sync').get().n, 0, 'the settled ticket snapshot is dropped');
  } finally {
    edgeDb.close();
  }
});

test('a ticket the bar already started survives the cart being resumed', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, prepared } = world.seeded;

  const held = await api.edge.post('/api/holds', {
    token: world.edge.edgeToken,
    body: parkBody({ branchId, prepared }),
  });
  const holdId = held.body.id;
  const ticketId = held.body.queue_id;

  const drain = () =>
    api.edge.post('/api/edge/drain', { token: world.edge.edgeToken, body: { branch_id: branchId } });
  await drain();

  // The bar starts the drink while the cart is still parked…
  const prep = await api.edge.patch(`/api/queue/${ticketId}/status`, {
    token: world.edge.adminToken,
    body: { status: 'preparing' },
  });
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  await drain();
  assert.equal(cloudHoldTicket(world.servers.cloud.dataDir, holdId).status, 'preparing');

  // …then the cashier resumes and pays. The cart leaves the Hold list, but the work
  // really happened, so both boards keep the ticket (and its history).
  const resume = await api.edge.del(`/api/holds/${holdId}`, { token: world.edge.edgeToken });
  assert.equal(resume.status, 200);
  assert.equal(resume.body.queue_removed, 0, 'a started ticket is never deleted');

  const after = await drain();
  assert.equal(after.body.holdSync.applied, 1);

  const kept = cloudHoldTicket(world.servers.cloud.dataDir, holdId);
  assert.ok(kept, 'the started ticket stays on the cloud board');
  assert.equal(kept.status, 'preparing', 'with the state the bar left it in');
  assert.equal(cloudHold(world.servers.cloud.dataDir, holdId), null, 'while the cart itself is gone');

  // It stays addressable: the ref outlives the hold row, so finishing the drink
  // still reaches the cloud.
  const done = await api.edge.patch(`/api/queue/${ticketId}/status`, {
    token: world.edge.adminToken,
    body: { status: 'ready' },
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const d = await drain();
  assert.equal(d.body.queueSync.applied, 1, 'a detached hold ticket still syncs');
  assert.equal(cloudHoldTicket(world.servers.cloud.dataDir, holdId).status, 'ready');
});

test('editing a parked cart follows to the cloud', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, prepared } = world.seeded;

  const held = await api.edge.post('/api/holds', {
    token: world.edge.edgeToken,
    body: parkBody({ branchId, prepared }),
  });
  assert.equal(held.status, 201, JSON.stringify(held.body));
  const holdId = held.body.id;

  const drain = () =>
    api.edge.post('/api/edge/drain', { token: world.edge.edgeToken, body: { branch_id: branchId } });
  await drain();
  const first = cloudHoldTicket(world.servers.cloud.dataDir, holdId);
  assert.ok(first, 'the ticket is mirrored first');

  // The cashier adds a round while the cart sits parked.
  const edited = await api.edge.put(`/api/holds/${holdId}`, {
    token: world.edge.edgeToken,
    body: {
      items: [
        {
          product_id: prepared.id,
          product_name: prepared.name,
          price: prepared.default_price,
          quantity: 3,
        },
      ],
    },
  });
  assert.equal(edited.status, 200, `the till accepts the edit: ${JSON.stringify(edited.body)}`);

  const after = await drain();
  assert.equal(after.body.holdSync.applied, 1, 'the edit rides the hold lane');

  const mirror = cloudHold(world.servers.cloud.dataDir, holdId);
  assert.equal(mirror.items.length, 1);
  assert.equal(mirror.items[0].quantity, 3, 'the cloud cart holds what the till now holds');
  assert.equal(mirror.total, prepared.default_price * 3, 'and prices it the same');

  // The station is looking at ticket #N: the edit must not renumber it, and must
  // not leave a second ticket behind.
  const ticket = cloudHoldTicket(world.servers.cloud.dataDir, holdId);
  assert.equal(ticket.ticket_no, first.ticket_no, 'the ticket number stays put');
  const db = openReplica(world.servers.cloud.dataDir);
  try {
    const lines = db.prepare('SELECT quantity FROM order_queue_items WHERE queue_id = ?').all(ticket.id);
    assert.equal(lines.length, 1, 'one line, not a second copy');
    assert.equal(lines[0].quantity, 3, 'with the edited quantity');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_queue').get().n, 1, 'still exactly one ticket');
  } finally {
    db.close();
  }
});
/* -------------------------------------------------------------------------- */
/*
 * Paying for a resumed cart.
 *
 * Parking a cart raises a real ticket, because the drinks have to be made while the
 * customer waits. Resuming it and paying raises a *sale*, and the sale used to raise
 * its own ticket — so an order the bar had already finished and handed over appeared
 * on the board a second time, asking to be made again.
 */
/* -------------------------------------------------------------------------- */

/** Every ticket on one side for the branch (both fix the same order). */
function allTickets(dataDir, branchId) {
  const db = openReplica(dataDir);
  try {
    return db.prepare('SELECT * FROM order_queue WHERE branch_id = ? ORDER BY rowid').all(branchId);
  } finally {
    db.close();
  }
}

test('paying a resumed cart does not raise a second ticket', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, prepared } = world.seeded;

  const held = await api.edge.post('/api/holds', {
    token: world.edge.edgeToken,
    body: parkBody({ branchId, prepared, label: 'meja 8 / deden' }),
  });
  assert.equal(held.status, 201, JSON.stringify(held.body));
  const holdId = held.body.id;
  const ticketId = held.body.queue_id;

  const drain = () =>
    api.edge.post('/api/edge/drain', { token: world.edge.edgeToken, body: { branch_id: branchId } });
  await drain();
  const first = cloudHoldTicket(world.servers.cloud.dataDir, holdId);
  assert.ok(first, 'the parked cart put a ticket on the cloud board');

  // The bar works it all the way through to handed over.
  for (const status of ['preparing', 'ready', 'completed']) {
    const moved = await api.edge.patch(`/api/queue/${ticketId}/status`, {
      token: world.edge.adminToken,
      body: { status },
    });
    assert.equal(moved.status, 200, `${status}: ${JSON.stringify(moved.body)}`);
    await drain();
  }
  assert.equal(
    cloudHoldTicket(world.servers.cloud.dataDir, holdId).status,
    'completed',
    'the cloud board saw it finished'
  );

  // The cashier resumes the cart — the till drops the hold — and takes the money.
  const resume = await api.edge.del(`/api/holds/${holdId}`, { token: world.edge.edgeToken });
  assert.equal(resume.status, 200, JSON.stringify(resume.body));
  await drain();

  const sale = await api.edge.post('/api/transactions', {
    token: world.edge.edgeToken,
    body: saleBody({
      branchId,
      productId: prepared.id,
      quantity: 2,
      price: prepared.default_price,
      clientUuid: 'resume-pay-1',
      holdId,
    }),
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));

  const edgeTickets = allTickets(world.servers.edge.dataDir, branchId);
  assert.equal(edgeTickets.length, 1, 'the till keeps one ticket, it does not add one');
  assert.equal(edgeTickets[0].id, ticketId, 'the ticket the bar already worked');
  assert.equal(edgeTickets[0].ticket_no, first.ticket_no, 'under the number the station knows');
  assert.equal(edgeTickets[0].status, 'completed', 'still finished, so nothing reappears on the board');
  assert.equal(edgeTickets[0].transaction_id, sale.body.id, 'now linked to the sale that paid for it');

  const delivered = await drain();
  assert.equal(delivered.body.applied, 1, 'the sale reaches the cloud');

  const cloudTickets = allTickets(world.servers.cloud.dataDir, branchId);
  assert.equal(cloudTickets.length, 1, 'the cloud board does not gain a duplicate either');
  assert.equal(cloudTickets[0].ticket_no, first.ticket_no);
  assert.equal(cloudTickets[0].status, 'completed');
  // The cloud wrote its own transaction row for the replay, so compare against that.
  const cloudDb = openReplica(world.servers.cloud.dataDir);
  let cloudTxId = null;
  try {
    cloudTxId = cloudDb.prepare('SELECT id FROM transactions WHERE client_uuid = ?').get('resume-pay-1')?.id || null;
  } finally {
    cloudDb.close();
  }
  assert.ok(cloudTxId, 'the sale is on the cloud');
  assert.equal(cloudTickets[0].transaction_id, cloudTxId, 'the replayed sale adopted it');
  assert.equal(cloudTickets[0].origin_ref, holdId, 'and it is still traceable to the parked cart');
});

test('a round added while paying is added to the ticket, not raised as a new one', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, prepared } = world.seeded;

  const held = await api.edge.post('/api/holds', {
    token: world.edge.edgeToken,
    body: parkBody({ branchId, prepared, label: 'meja 9', quantity: 2 }),
  });
  const holdId = held.body.id;
  const ticketId = held.body.queue_id;

  const drain = () =>
    api.edge.post('/api/edge/drain', { token: world.edge.edgeToken, body: { branch_id: branchId } });
  await drain();

  for (const status of ['preparing', 'ready', 'completed']) {
    await api.edge.patch(`/api/queue/${ticketId}/status`, { token: world.edge.adminToken, body: { status } });
    await drain();
  }
  const first = cloudHoldTicket(world.servers.cloud.dataDir, holdId);

  await api.edge.del(`/api/holds/${holdId}`, { token: world.edge.edgeToken });
  await drain();

  // The customer orders one more of the same drink while paying.
  const sale = await api.edge.post('/api/transactions', {
    token: world.edge.edgeToken,
    body: saleBody({
      branchId,
      productId: prepared.id,
      quantity: 3,
      price: prepared.default_price,
      clientUuid: 'resume-pay-2',
      holdId,
    }),
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));

  /** The order's lines, as the station sees them. */
  const lines = (dataDir, queueId) => {
    const db = openReplica(dataDir);
    try {
      return db.prepare('SELECT * FROM order_queue_items WHERE queue_id = ? ORDER BY rowid').all(queueId);
    } finally {
      db.close();
    }
  };

  const tillLines = lines(world.servers.edge.dataDir, ticketId);
  assert.equal(tillLines.length, 1, 'the extra cup lands on the existing line');
  assert.equal(tillLines[0].quantity, 3, 'made twice, plus the one ordered at the counter');

  await drain();
  const cloudTickets = allTickets(world.servers.cloud.dataDir, branchId);
  assert.equal(cloudTickets.length, 1, 'still a single ticket on the cloud');
  assert.equal(cloudTickets[0].ticket_no, first.ticket_no);
  const cloudLines = lines(world.servers.cloud.dataDir, cloudTickets[0].id);
  assert.equal(cloudLines.length, 1);
  assert.equal(cloudLines[0].quantity, 3, 'and the cloud board shows the same round');
});


/* -------------------------------------------------------------------------- */
/* Cost price: the column the edge's reports are computed from                */
/* -------------------------------------------------------------------------- */
/*
 * Regression: the snapshot shipped the selling price and nothing else, and
 * `applyBootstrap` wrote the product row without a cost. A bootstrapped till
 * therefore sold at the right price and reported *zero* cost of goods, so
 * "Laba" on the till disagreed with the cloud for the very same sales — the one
 * comparison an owner makes by hand. `createTransaction` stamps each line's
 * `cost_price` from the product row, which is why both the catalog pull and the
 * already-written lines have to be repaired, not just one of them.
 *
 * The parity suites cannot see this: they create their products through HTTP on
 * each server, so both sides have the cost without ever replicating it.
 */
test('cost price replicates, and the till report agrees with the cloud', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, products } = world.seeded;
  const kopi = products.find((p) => p.name === 'Kopi Susu');
  const unitPrice = kopi.default_price;

  // A sale rung up while the replica did not know the product's cost — the shape
  // of every sale made before this fix.
  const oldSale = await api.edge.post('/api/transactions', {
    token: world.edge.edgeToken,
    body: saleBody({
      branchId,
      productId: kopi.id,
      quantity: 2,
      price: unitPrice,
      clientUuid: 'cost-price-1',
    }),
  });
  assert.equal(oldSale.status, 201, `the sale is written locally: ${JSON.stringify(oldSale.body)}`);

  // The owner fills the cost in on the cloud, as they would after importing a
  // catalog by name and price only.
  const setCost = await api.cloud.put(`/api/products/${kopi.id}`, {
    token: world.seeded.token,
    body: { cost_price: 9000 },
  });
  assert.equal(setCost.status, 200, `cost update failed: ${JSON.stringify(setCost.body)}`);

  // Then the replication again — what Settings › Diagnostik › "Salin dari cloud" runs.
  const boot = await api.edge.post('/api/edge/bootstrap', {
    token: world.edge.adminToken,
    body: { branch_id: branchId },
  });
  assert.ok(boot.status < 300, `re-bootstrap failed: ${JSON.stringify(boot.body)}`);

  const replica = openReplica(world.servers.edge.dataDir);
  try {
    const row = replica.prepare('SELECT cost_price, default_price FROM products WHERE id = ?').get(kopi.id);
    assert.equal(row.default_price, unitPrice, 'the selling price still replicates');
    assert.equal(row.cost_price, 9000, 'cost price must replicate: COGS, profit and stock value read this column');

    // The line already written is repaired too, or the report keeps yesterday's
    // 100 % margin forever.
    const line = replica
      .prepare(
        `SELECT i.cost_price FROM transaction_items i
           JOIN transactions t ON t.id = i.transaction_id
          WHERE t.client_uuid = ?`
      )
      .get('cost-price-1');
    assert.equal(line.cost_price, 9000, 'a past line with no cost is filled in from the catalog');
  } finally {
    replica.close();
  }
  assert.equal(boot.body.costs_fixed, 1, 'the repair is counted, so the shop can explain the change');

  // A sale rung up after the pull stamps the cost itself.
  const newSale = await api.edge.post('/api/transactions', {
    token: world.edge.edgeToken,
    body: saleBody({
      branchId,
      productId: kopi.id,
      quantity: 1,
      price: unitPrice,
      clientUuid: 'cost-price-2',
    }),
  });
  assert.equal(newSale.status, 201, `later sale failed: ${JSON.stringify(newSale.body)}`);

  // Both sales sync, so the same two transactions exist on both sides and the
  // reports become comparable.
  const drain = await api.edge.post('/api/edge/drain', { token: world.edge.edgeToken, body: { branch_id: branchId } });
  assert.equal(drain.body.applied, 2, 'both sales reach the cloud');

  const edgeReport = await api.edge.get(`/api/reports/profit?branch_id=${branchId}`, { token: world.edge.adminToken });
  const cloudReport = await api.cloud.get(`/api/reports/profit?branch_id=${branchId}`, { token: world.seeded.token });
  assert.equal(edgeReport.status, 200, `till report failed: ${JSON.stringify(edgeReport.body)}`);
  assert.equal(cloudReport.status, 200, `cloud report failed: ${JSON.stringify(cloudReport.body)}`);
  assert.equal(edgeReport.body.cogs, 27000, '3 cups at 9.000 is the cost of goods on the till');
  assert.equal(edgeReport.body.cogs, cloudReport.body.cogs, 'the two sides agree on COGS');
  assert.equal(edgeReport.body.gross_profit, cloudReport.body.gross_profit, 'and on gross profit');
  assert.equal(edgeReport.body.margin_percent, cloudReport.body.margin_percent, 'and on the margin');
});



