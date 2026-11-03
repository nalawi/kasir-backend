// Tests for PUT /settings and the /sync/bootstrap settings allowlist.
//
// `settings` was previously seed-only, which made `allow_negative_stock`
// unreachable for a real operator: the stock policy (see stock-policy.test.mjs)
// could only be changed by touching SQLite. These tests cover the endpoint that
// makes it reachable, and the two ways that endpoint can go wrong: letting the
// wrong role change money-path policy, and letting a caller write a key it should
// not (the edge_* upstream credentials live in the same table).

import test from 'node:test';
import assert from 'node:assert/strict';

import { startPairedWorld, setSetting, cloudCashierToken } from './fixtures.mjs';

/* -------------------------------------------------------------------------- */
/* 1. Only a company-wide admin may touch settings                            */
/* -------------------------------------------------------------------------- */

test('a cashier cannot read or change settings', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token } = world.seeded;
  const api = world.api;
  const cashierToken = await cloudCashierToken(api, world.seeded);

  const read = await api.cloud.get('/api/settings', { token: cashierToken });
  assert.equal(read.status, 403, 'a cashier must not read settings');

  const write = await api.cloud.put('/api/settings', {
    token: cashierToken,
    body: { allow_negative_stock: 'ignore' },
  });
  assert.equal(write.status, 403, 'a cashier must not change the stock policy');

  // The policy is unchanged: the refusal happened before any write.
  const after = await api.cloud.get('/api/settings', { token });
  const policy = after.body.find((s) => s.key === 'allow_negative_stock');
  assert.equal(policy.value, 'warn', 'policy must still be the default');
});

/* -------------------------------------------------------------------------- */
/* 2. The happy path, and that it actually drives checkout                    */
/* -------------------------------------------------------------------------- */

test('changing the policy over the API changes checkout behaviour', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, products, token } = world.seeded;
  const kopi = products[0];

  const put = await api.cloud.put('/api/settings', {
    token,
    body: { allow_negative_stock: 'block' },
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.updated.allow_negative_stock, 'block');

  // Stock 0, sell 1: must now be refused. This is the assertion that proves the
  // endpoint is wired to the guard, not merely storing a value.
  await api.cloud.post(`/api/branches/${branchId}/stock/adjust`, {
    token,
    body: { product_id: kopi.id, quantity: 0, type: 'set' },
  });
  const sale = await api.cloud.post('/api/transactions', {
    token,
    body: {
      branch_id: branchId,
      items: [{ product_id: kopi.id, quantity: 1, price: kopi.default_price }],
      payment_method: 'cash',
      cash_received: 100000,
    },
  });
  assert.equal(sale.status, 409, 'block mode set over the API must be in force');
  assert.equal(sale.body.code, 'INSUFFICIENT_STOCK');
});

/* -------------------------------------------------------------------------- */
/* 3. Validation: bad values and unknown keys are rejected, not ignored       */
/* -------------------------------------------------------------------------- */

test('an out-of-range policy value is rejected', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token } = world.seeded;
  const res = await world.api.cloud.put('/api/settings', {
    token,
    body: { allow_negative_stock: 'yolo' },
  });

  assert.equal(res.status, 400, 'an unknown mode must not silently fall back');
  assert.match(res.body.error, /allow_negative_stock/);

  const after = await world.api.cloud.get('/api/settings', { token });
  assert.equal(
    after.body.find((s) => s.key === 'allow_negative_stock').value,
    'warn',
    'a rejected write must leave the previous value intact',
  );
});

/* -------------------------------------------------------------------------- */
/* 4. The allowlist: edge credentials must not be writable via /settings      */
/* -------------------------------------------------------------------------- */

test('settings cannot write the edge upstream credentials', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token } = world.seeded;

  const res = await world.api.cloud.put('/api/settings', {
    token,
    body: { edge_upstream_url: 'http://attacker.example' },
  });

  assert.equal(res.status, 400, 'edge_* keys must be outside the allowlist');
  assert.match(res.body.error, /tidak dikenal/i);
});

/* -------------------------------------------------------------------------- */
/* 5. /sync/bootstrap must not leak the whole settings table                  */
/* -------------------------------------------------------------------------- */

test('bootstrap returns only the settings a till needs', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token, branchId } = world.seeded;

  // Put a secret-looking row in the table, in the same shape a real integration
  // would use. Before the allowlist this was returned to every caller with
  // branch access.
  setSetting(world.cloud.dataDir, 'payment_gateway_secret', 'sk_live_do_not_leak');

  const res = await world.api.cloud.get(`/api/sync/bootstrap?branch_id=${branchId}`, { token });

  assert.equal(res.status, 200);
  assert.equal(
    res.body.settings.payment_gateway_secret,
    undefined,
    'bootstrap must not ship arbitrary settings to a till',
  );
  // The keys a till genuinely needs are still present.
  assert.equal(res.body.settings.currency, 'IDR');
  assert.ok('allow_negative_stock' in res.body.settings, 'the till needs the stock policy');
});
