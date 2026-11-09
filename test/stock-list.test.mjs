// Stock-list tests: a product with no `branch_stocks` row must still be listed.
//
// The reported failure was "I created a product, then opened stock opname, and the
// new product was not there to be counted". Nothing was wrong with the opname
// route: `GET /branches/:id/stock` was driven from `branch_stocks` with an INNER
// JOIN to `products`, and a stock row is only created lazily — by the first sale,
// the first adjust or the first opname. A product that had just been created had
// no row, so it was invisible on the stock page and therefore absent from the
// opname sheet, which is precisely where an opening quantity would be entered.
//
// The fix drives the list from `products` with a LEFT JOIN, so a missing row reads
// as "zero on hand" — the same assumption `stockShortfalls()` already makes at
// checkout. These tests pin that down, plus the two things the change must not
// break: a soft-deleted product that still holds stock stays visible, and a
// soft-deleted product with no stock does not appear.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startWorld } from './harness.mjs';
import { seedCloud } from './fixtures.mjs';

/** Create a product on the cloud and return it. */
async function createProduct(api, token, body) {
  const res = await api.cloud.post('/api/products', { token, body });
  assert.ok(res.status < 300, `product create failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

/** The branch stock list, as the stock page and the opname sheet read it. */
async function branchStock(api, branchId, token) {
  const res = await api.cloud.get(`/api/branches/${branchId}/stock`, { token });
  assert.equal(res.status, 200, `stock list failed: ${JSON.stringify(res.body)}`);
  assert.ok(Array.isArray(res.body), 'the stock list is a bare array');
  return res.body;
}

test('a newly created product is listed with zero stock and can be counted', async (t) => {
  const world = await startWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, token } = await seedCloud(api);

  // Created the way the Products page creates one: no stock anywhere yet.
  const fresh = await createProduct(api, token, { name: 'Produk Baru', default_price: 9000 });

  const rows = await branchStock(api, branchId, token);
  const line = rows.find((r) => r.product_id === fresh.id);

  assert.ok(line, 'a product with no stock row must still be listed');
  assert.equal(line.product_name, 'Produk Baru');
  assert.equal(line.quantity, 0, 'a missing stock row means zero on hand');
  assert.equal(line.low_stock_threshold, 5, 'the schema default applies');
  assert.equal(line.is_low, 1, 'zero is at or below the default threshold');

  // The opname sheet is built from this list, so the line is now countable. This is
  // the exact action that failed: the product was not in the sheet at all.
  const opname = await api.cloud.post(`/api/branches/${branchId}/stock/opname`, {
    token,
    body: { items: [{ product_id: fresh.id, counted: 12 }], note: 'stok awal' },
  });
  assert.equal(opname.status, 201, `opname failed: ${JSON.stringify(opname.body)}`);
  assert.deepEqual(opname.body.lines[0], {
    product_id: fresh.id,
    before: 0,
    counted: 12,
    delta: 12,
  });

  // And the count stuck: the same line now reports the counted quantity.
  const after = (await branchStock(api, branchId, token)).find((r) => r.product_id === fresh.id);
  assert.equal(after.quantity, 12);
  assert.equal(after.is_low, 0, '12 is above the default threshold of 5');
});

test('a soft-deleted product keeps its line only while it still holds stock', async (t) => {
  const world = await startWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, token } = await seedCloud(api);

  // Three products, then all soft-deleted. Only the one that still holds stock may
  // stay on the list: the others have nothing left to report, and listing them
  // would put a deleted product back in front of the operator.
  const withStock = await createProduct(api, token, { name: 'Ada Stok', default_price: 1000 });
  const empty = await createProduct(api, token, { name: 'Tanpa Stok', default_price: 1000 });
  // The reported bug: this one is adjusted to a real quantity and then zeroed, so
  // it has a `branch_stocks` row of its own. Deleting it left the row behind, and
  // the list kept the line because it only checked that a row existed.
  const zeroed = await createProduct(api, token, { name: 'Stok Nol', default_price: 1000 });

  for (const [p, qty] of [
    [withStock, 4],
    [zeroed, 9],
  ]) {
    await api.cloud.post(`/api/branches/${branchId}/stock/adjust`, {
      token,
      body: { product_id: p.id, quantity: qty, type: 'set' },
    });
  }
  // Opname down to zero: the row survives, the quantity does not.
  const zeroing = await api.cloud.post(`/api/branches/${branchId}/stock/opname`, {
    token,
    body: { items: [{ product_id: zeroed.id, counted: 0 }], note: 'habis' },
  });
  assert.equal(zeroing.status, 201, `opname failed: ${JSON.stringify(zeroing.body)}`);

  // Before the delete it is listed — at zero, and flagged low.
  const beforeDelete = (await branchStock(api, branchId, token)).find((r) => r.product_id === zeroed.id);
  assert.ok(beforeDelete, 'an active product is listed even at zero');
  assert.equal(beforeDelete.quantity, 0);

  for (const p of [withStock, empty, zeroed]) {
    const del = await api.cloud.del(`/api/products/${p.id}`, { token });
    assert.equal(del.status, 200, `delete failed: ${JSON.stringify(del.body)}`);
  }

  const rows = await branchStock(api, branchId, token);
  const kept = rows.find((r) => r.product_id === withStock.id);
  const gone = rows.find((r) => r.product_id === empty.id);
  const goneZeroed = rows.find((r) => r.product_id === zeroed.id);

  assert.ok(kept, 'a deleted product that still holds stock must stay visible');
  assert.equal(kept.quantity, 4);
  assert.equal(gone, undefined, 'a deleted product that never had a row must not be listed');
  assert.equal(
    goneZeroed,
    undefined,
    'a deleted product whose stock row only exists at quantity 0 must not be listed',
  );
});

test('a deleted product with negative stock stays listed so the shortfall is visible', async (t) => {
  const world = await startWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, token } = await seedCloud(api);

  // Negative stock is a real state when `allow_negative_stock` is permissive, and a
  // hidden negative line is a loss nobody can find or correct. The list keeps it.
  const negative = await createProduct(api, token, { name: 'Stok Minus', default_price: 1000 });
  await api.cloud.post(`/api/branches/${branchId}/stock/adjust`, {
    token,
    body: { product_id: negative.id, quantity: -3, type: 'set' },
  });

  const del = await api.cloud.del(`/api/products/${negative.id}`, { token });
  assert.equal(del.status, 200, `delete failed: ${JSON.stringify(del.body)}`);

  const line = (await branchStock(api, branchId, token)).find((r) => r.product_id === negative.id);
  assert.ok(line, 'a deleted product at negative stock must stay visible');
  assert.equal(line.quantity, -3);
});

test('the list stays scoped to the branch and the company', async (t) => {
  const world = await startWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, token } = await seedCloud(api);

  // A second branch of the same company: its stock must not leak into the first.
  const second = await api.cloud.post('/api/branches', { token, body: { name: 'Cabang Dua' } });
  assert.ok(second.status < 300, `branch create failed: ${JSON.stringify(second.body)}`);

  const shared = await createProduct(api, token, { name: 'Produk Bersama', default_price: 5000 });
  await api.cloud.post(`/api/branches/${second.body.id}/stock/adjust`, {
    token,
    body: { product_id: shared.id, quantity: 7, type: 'set' },
  });

  const first = (await branchStock(api, branchId, token)).find((r) => r.product_id === shared.id);
  const other = (await branchStock(api, second.body.id, token)).find((r) => r.product_id === shared.id);

  assert.equal(first.quantity, 0, 'the first branch has no stock of its own');
  assert.equal(other.quantity, 7, 'the second branch reports its own quantity');
});
