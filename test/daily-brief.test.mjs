// Regression tests for "today" in the reports endpoints.
//
// The reported bug: on the Tauri app the "Ringkasan Harian" WhatsApp text said
// "Belum ada penjualan hari ini" while the KPI card right above it showed
// Rp 166.500. Both numbers were read from the same SQLite file, so the two
// endpoints must have disagreed about *which day* they were reporting:
//
//   /reports/summary     resolved `from`/`to` as a plain UTC day
//   /reports/daily-brief resolved `date` as a day in the company's timezone
//
// For an Asia/Jakarta shop (UTC+7) those diverge every night between 17:00 and
// 24:00 UTC: the KPI card counted the sales, the WhatsApp text asked for
// yesterday's UTC date and found none.
//
// These tests pin the two endpoints to one definition of a day.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startPairedWorld, saleBody } from './fixtures.mjs';

/** The empty-sales line the owner saw, in both languages. */

test('the KPI card and the WhatsApp brief agree on today', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, products, token } = world.seeded;
  const kopi = products[0];

  // Ring it up on the till, then let it sync: this is the state the owner is in
  // when the WhatsApp button gets pressed.
  const sale = await api.edge.post('/api/transactions', {
    token: world.edge.edgeToken,
    body: saleBody({ branchId, productId: kopi.id, quantity: 2, price: 18000, clientUuid: 'brief-today-1' }),
  });
  assert.ok(sale.status < 300, `sale failed: ${sale.status} ${JSON.stringify(sale.body)}`);

  const drain = await api.edge.post('/api/edge/drain', {
    token: world.edge.adminToken,
    body: { branch_id: branchId },
  });
  assert.equal(drain.status, 200);
  assert.equal(drain.body.applied, 1, 'the sale must reach the cloud before the reports are compared');

  // Today's date per the brief — the endpoint the WhatsApp card actually calls.
  const brief = await api.cloud.get('/api/reports/daily-brief', { token });
  assert.equal(brief.status, 200);
  assert.match(brief.body.date, /^\d{4}-\d{2}-\d{2}$/, 'the brief must report which day it covers');

  // Ask the KPI endpoint for exactly that day. This is the assertion that failed:
  // `summary` treated the date as UTC and returned zero.
  const today = brief.body.date;
  const summary = await api.cloud.get(`/api/reports/summary?from=${today}&to=${today}`, { token });
  assert.equal(summary.status, 200);
  assert.equal(
    summary.body.transactions,
    brief.body.transactions,
    'the KPI card and the brief must count the same transactions',
  );
  assert.equal(
    summary.body.revenue,
    brief.body.revenue,
    'the KPI card and the brief must report the same revenue',
  );
  assert.ok(brief.body.transactions >= 1, 'the sale just rung up must be in the brief');
  assert.doesNotMatch(brief.body.text, NO_SALES, 'the brief must not claim there were no sales');
});

test('a default (no-query) summary reports the same day as the brief', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { token } = world.seeded;
  const summary = await api.cloud.get('/api/reports/summary', { token });
  const brief = await api.cloud.get('/api/reports/daily-brief', { token });

  assert.equal(summary.status, 200);
  assert.equal(brief.status, 200);
  assert.equal(
    summary.body.transactions,
    brief.body.transactions,
    'omitting from/to must not land on a different day than omitting date',
  );
  assert.equal(summary.body.revenue, brief.body.revenue);
  // `range.from` is the UTC instant the local day starts at (e.g. 17:00 the day
  // before for UTC+7), so compare the window's *end* date — the calendar day the
  // owner sees — rather than the raw lower bound.
  assert.equal(
    summary.body.range.to.slice(0, 10),
    brief.body.date,
    'both endpoints must resolve "today" to the same calendar date',
  );
});

test('the till reports its own sale today rather than an empty UTC day', async (t) => {
  // This is the failure as the owner saw it: the edge replica *has* the sales,
  // but the brief asked for a day that contained none of them.
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const api = world.api;
  const { branchId, products } = world.seeded;
  const kopi = products[0];

  const sale = await api.edge.post('/api/transactions', {
    token: world.edge.edgeToken,
    body: saleBody({ branchId, productId: kopi.id, quantity: 1, price: 18000, clientUuid: 'brief-edge-1' }),
  });
  assert.ok(sale.status < 300, `sale failed: ${sale.status} ${JSON.stringify(sale.body)}`);

  const edgeBrief = await api.edge.get('/api/reports/daily-brief', { token: world.edge.adminToken });
  assert.equal(edgeBrief.status, 200);
  assert.equal(edgeBrief.body.transactions, 1, 'the till must see the sale it just made');
  assert.doesNotMatch(edgeBrief.body.text, NO_SALES, 'the till must not claim there were no sales');

  // The same day, read through the KPI endpoint on the same till.
  const today = edgeBrief.body.date;
  const edgeSummary = await api.edge.get(`/api/reports/summary?from=${today}&to=${today}`, {
    token: world.edge.adminToken,
  });
  assert.equal(edgeSummary.status, 200);
  assert.equal(
    edgeSummary.body.transactions,
    edgeBrief.body.transactions,
    'on the edge, the KPI card and the WhatsApp text must agree',
  );
  assert.equal(edgeSummary.body.revenue, edgeBrief.body.revenue);
});

const NO_SALES = /Belum ada penjualan hari ini|No sales recorded today/;
