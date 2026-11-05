// Regression tests for the transaction timestamps the UI renders.
//
// The reported bug: on the Tauri app a sale rung up at 08:50 WIB printed its
// receipt as `01.50`, and the transactions list showed `00.37` for a sale the
// owner made in the morning. Both numbers are UTC leaking to the screen.
//
// Two things went wrong together:
//   * `created_at` was serialised as `2026-11-03 17:46:08` — UTC, but with no
//     `Z`, so every browser parsed it as *local* wall clock;
//   * the formatted output used the device's zone, not the shop's.
//
// The fix has two halves, and each half is useless alone: the API must mark the
// value as UTC, and the client must format it into the company's timezone. These
// tests pin the contract the client depends on.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startPairedWorld, saleBody } from './fixtures.mjs';

/** ISO-8601 UTC with an explicit `Z` — what the client now expects. */
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

test('a transaction timestamp is serialised as UTC, not as a bare wall clock', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, products, token } = world.seeded;

  const sale = await api.cloud.post('/api/transactions', {
    token,
    body: saleBody({ branchId, productId: products[0].id, quantity: 1, price: 18000, clientUuid: 'tz-cloud-1' }),
  });
  assert.ok(sale.status < 300, `sale failed: ${sale.status} ${JSON.stringify(sale.body)}`);

  // The POST response seeds the receipt modal, which is what gets printed.
  assert.match(
    sale.body.created_at,
    UTC_ISO,
    `a transaction timestamp must say it is UTC, got ${JSON.stringify(sale.body.created_at)}`,
  );

  // The history list powers the transactions table.
  const list = await api.cloud.get('/api/transactions', { token });
  assert.equal(list.status, 200);
  assert.ok(list.body.rows.length >= 1, 'the sale just made must be listed');
  for (const row of list.body.rows) {
    assert.match(
      row.created_at,
      UTC_ISO,
      `every listed row must carry a UTC timestamp, got ${JSON.stringify(row.created_at)}`,
    );
  }

  // And the single-transaction endpoint the detail view reads.
  const one = await api.cloud.get(`/api/transactions/${sale.body.id}`, { token });
  assert.equal(one.status, 200);
  assert.match(one.body.created_at, UTC_ISO);
});

test('the same sale reads as one instant whichever endpoint returns it', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, products, token } = world.seeded;

  const created = await api.cloud.post('/api/transactions', {
    token,
    body: saleBody({ branchId, productId: products[0].id, quantity: 1, price: 15000, clientUuid: 'tz-same-1' }),
  });
  assert.ok(created.status < 300);

  const fromList = await api.cloud.get('/api/transactions', { token });
  const row = fromList.body.rows.find((r) => r.id === created.body.id);
  assert.ok(row, 'the sale must appear in the list');

  const fromOne = await api.cloud.get(`/api/transactions/${created.body.id}`, { token });
  const fromReceipt = await api.cloud.get(`/api/transactions/${created.body.id}/receipt`, { token });

  // Parsed back as instants, all three must agree exactly. This is the property
  // that broke: the same sale could show three different times on three screens.
  const at = (v) => new Date(v).getTime();
  assert.equal(at(row.created_at), at(created.body.created_at), 'list and POST must agree');
  assert.equal(at(fromOne.body.created_at), at(created.body.created_at), 'detail and POST must agree');
  assert.equal(at(fromReceipt.body.header.created_at), at(created.body.created_at), 'receipt and POST must agree');
  assert.ok(Number.isFinite(at(created.body.created_at)), 'the timestamp must parse to a real instant');
});

test('the receipt carries the shop timezone so it prints on the shop clock', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, products, token } = world.seeded;

  const sale = await api.cloud.post('/api/transactions', {
    token,
    body: saleBody({ branchId, productId: products[0].id, quantity: 1, price: 12000, clientUuid: 'tz-receipt-1' }),
  });
  assert.ok(sale.status < 300);

  const receipt = await api.cloud.get(`/api/transactions/${sale.body.id}/receipt`, { token });
  assert.equal(receipt.status, 200);
  // Without this the printer has no way to know the shop's clock and falls back
  // to the device's zone — the 08:50-shows-as-01:50 bug.
  assert.ok(receipt.body.company.timezone, 'the receipt must name the shop timezone');
  assert.equal(typeof receipt.body.company.timezone, 'string');
});

test('the session payload names the company timezone for the UI formatters', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { token } = world.seeded;

  const me = await api.cloud.get('/api/auth/me', { token });
  assert.equal(me.status, 200);
  // The UI formats every timestamp with this; a missing value silently falls
  // back to the device zone, which is what produced the wrong receipt time.
  assert.ok(me.body.company, '/auth/me must include the company profile');
  assert.equal(typeof me.body.company.timezone, 'string');
  assert.ok(me.body.company.timezone.length > 0, 'the timezone must not be empty');
});
