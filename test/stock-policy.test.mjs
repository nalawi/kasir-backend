// Stock-policy tests: the checkout guard added in Phase 3 (Option A).
//
// Before this landed, nothing enforced stock quantity at the point of sale.
// `priceCart` only read the `branch_products.is_available` on/off flag, so a
// single cashier could drive branch stock to -5 online, while an offline replay
// of that same sale was refused as a `conflict`. These tests pin both halves of
// that asymmetry down, so the two paths can never drift apart again.
//
// `settings.allow_negative_stock` selects the behaviour:
//
//   warn   — sale succeeds, response carries `stock_warnings`   (the default)
//   block  — sale refused with 409 + `shortfalls`
//   ignore — no check at all
//
// Same two-process harness as edge-sync.test.mjs; see that file's header for why
// every test builds its own world.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startPairedWorld, saleBody, cloudStock, setCloudStock, setSetting } from './fixtures.mjs';

/* -------------------------------------------------------------------------- */
/* 1. Default policy preserves existing behaviour                              */
/* -------------------------------------------------------------------------- */

test('default policy (warn) lets an oversell through but reports it', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, products, token } = world.seeded;
  const kopi = products[0];

  // Stock 0, sell 3. This exact scenario was silently returning 201 with stock
  // -3 before the guard existed; the sale must still succeed (warn is the
  // default, so an upgrade cannot start refusing sales at a busy counter), but
  // the shortfall must now be visible to the caller.
  await setCloudStock(api, branchId, kopi.id, 0, token);

  const res = await api.cloud.post('/api/transactions', {
    token,
    body: saleBody({ branchId, productId: kopi.id, quantity: 3, price: kopi.default_price }),
  });

  assert.equal(res.status, 201, 'warn must not refuse the sale');
  assert.equal(res.body.stock_warnings?.length, 1, 'oversell should be reported');
  assert.deepEqual(res.body.stock_warnings[0], {
    product_id: kopi.id,
    product_name: kopi.name,
    requested: 3,
    available: 0,
  });

  // The sale really happened: stock went negative, matching the warning.
  assert.equal(await cloudStock(api, branchId, kopi.id, token), -3);
});

/* -------------------------------------------------------------------------- */
/* 2. 'block' refuses cleanly and writes nothing                              */
/* -------------------------------------------------------------------------- */

test('block policy refuses an oversell without creating a transaction', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, products, token } = world.seeded;
  const kopi = products[0];
  setSetting(world.cloud.dataDir, 'allow_negative_stock', 'block');

  await setCloudStock(api, branchId, kopi.id, 2, token);

  const res = await api.cloud.post('/api/transactions', {
    token,
    body: saleBody({ branchId, productId: kopi.id, quantity: 5, price: kopi.default_price }),
  });

  assert.equal(res.status, 409, 'block must refuse the sale');
  assert.equal(res.body.code, 'INSUFFICIENT_STOCK');
  assert.equal(res.body.error, 'Stok tidak cukup');
  assert.equal(res.body.shortfalls[0].requested, 5);
  assert.equal(res.body.shortfalls[0].available, 2);

  // The 409 is thrown from inside db.transaction(), so nothing may be committed:
  // no stock movement and no negative count. This is the property that matters —
  // a refused sale that still debited stock would be worse than no guard at all.
  assert.equal(await cloudStock(api, branchId, kopi.id, token), 2, 'stock must be untouched');
});

test('block policy allows a sale that exactly drains stock to zero', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, products, token } = world.seeded;
  const kopi = products[0];
  setSetting(world.cloud.dataDir, 'allow_negative_stock', 'block');

  await setCloudStock(api, branchId, kopi.id, 4, token);

  const res = await api.cloud.post('/api/transactions', {
    token,
    body: saleBody({ branchId, productId: kopi.id, quantity: 4, price: kopi.default_price }),
  });

  assert.equal(res.status, 201, 'selling the last unit is allowed');
  assert.equal(await cloudStock(api, branchId, kopi.id, token), 0);
});

/* -------------------------------------------------------------------------- */
/* 3. 'ignore' skips the check entirely                                       */
/* -------------------------------------------------------------------------- */

test('ignore policy neither refuses nor reports', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, products, token } = world.seeded;
  const kopi = products[0];
  setSetting(world.cloud.dataDir, 'allow_negative_stock', 'ignore');

  await setCloudStock(api, branchId, kopi.id, 0, token);

  const res = await api.cloud.post('/api/transactions', {
    token,
    body: saleBody({ branchId, productId: kopi.id, quantity: 2, price: kopi.default_price }),
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.stock_warnings, undefined, 'ignore must not report a shortfall');
  assert.equal(await cloudStock(api, branchId, kopi.id, token), -2);
});

test('block policy checks every line, not just the first', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, products, token } = world.seeded;
  const [kopi, roti] = products;
  setSetting(world.cloud.dataDir, 'allow_negative_stock', 'block');

  // Line 1 is comfortably in stock; only line 2 oversells. A guard that checks
  // just the first item would let this through, which is the bug most likely to
  // appear if this loop is ever "optimised".
  await setCloudStock(api, branchId, kopi.id, 10, token);
  await setCloudStock(api, branchId, roti.id, 1, token);

  const res = await api.cloud.post('/api/transactions', {
    token,
    body: {
      branch_id: branchId,
      items: [
        { product_id: kopi.id, quantity: 2, price: kopi.default_price },
        { product_id: roti.id, quantity: 5, price: roti.default_price },
      ],
      payment_method: 'cash',
      cash_received: 200000,
    },
  });

  assert.equal(res.status, 409, 'a shortfall on any line must refuse the sale');
  assert.equal(res.body.shortfalls.length, 1, 'only the short line should be reported');
  assert.equal(res.body.shortfalls[0].product_id, roti.id);
  assert.equal(res.body.shortfalls[0].requested, 5);
  assert.equal(res.body.shortfalls[0].available, 1);

  // Neither line may be debited — the whole sale rolled back.
  assert.equal(await cloudStock(api, branchId, kopi.id, token), 10);
  assert.equal(await cloudStock(api, branchId, roti.id, token), 1);
});

/* -------------------------------------------------------------------------- */
/* 4. The sync path honours the same policy                                   */
/* -------------------------------------------------------------------------- */

test('ignore lets an offline replay apply instead of clogging the conflict queue', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, products, token } = world.seeded;
  const kopi = products[0];
  setSetting(world.cloud.dataDir, 'allow_negative_stock', 'ignore');

  // The till believes it has stock; the cloud has none. Same shape as the
  // conflict test in edge-sync.test.mjs, but with the check switched off.
  await setCloudStock(api, branchId, kopi.id, 0, token);

  const clientUuid = 'policy-ignore-replay-1';
  const res = await api.cloud.post('/api/sync/batch', {
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

  assert.equal(res.status, 200);
  const result = res.body.results.find((r) => r.client_uuid === clientUuid);
  assert.equal(result.status, 'applied', 'ignore must not park the replay as a conflict');
});
