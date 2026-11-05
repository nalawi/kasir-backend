// Stale-tenant tests for the edge replica.
//
// Reported symptom: after logging in as super admin, almost every page answered
// `Forbidden: branch not in your scope`.
//
// The till had been paired to one company, and later re-paired to another one
// that had been registered under the same name. `edgeBootstrap` matches an
// existing local user by email — the admin configuring the till is always such a
// user, because registering the till creates them — and in that branch of the
// upsert it refreshed `branch_id` from the cloud but deliberately kept the local
// `company_id`. The row therefore ended up pointing at a branch of the *cloud's*
// company while still claiming to belong to the *previous* one.
//
// `scopedBranchIds` derives a user's scope from `users.company_id`, so it offered
// the old company's branches, and the branch the till actually asked for was a
// stranger to them. A super_admin could re-pick a branch, but a cashier or a
// single-outlet manager holds exactly one branch and had no route out of the
// error at all — which is why this must be prevented locally, not healed in the UI.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import Database from 'better-sqlite3';

import { startWorld } from './harness.mjs';
import { seedCloud, pairAndBootstrap, OWNER } from './fixtures.mjs';

/**
 * A paired till, keeping the *server handles* reachable.
 *
 * `startPairedWorld` spreads the world and then overwrites `edge` with the pair
 * result, so `world.edge.dataDir` — the replica's location, which these tests
 * need — is not on it. Pair step by step instead.
 */
async function paired() {
  const world = await startWorld();
  const seeded = await seedCloud(world.api);
  const pair = await pairAndBootstrap(world, seeded);
  return { ...world, seeded, pair };
}

/** Read one user row straight from the till's SQLite file. */
function edgeUser(dataDir, email) {
  const db = new Database(path.join(dataDir, 'pos.db'), { readonly: true });
  try {
    return db.prepare('SELECT id, company_id, branch_id, role FROM users WHERE lower(email) = lower(?)').get(email);
  } finally {
    db.close();
  }
}

/** The company that actually owns a branch, in the till's replica. */
function branchOwner(dataDir, branchId) {
  const db = new Database(path.join(dataDir, 'pos.db'), { readonly: true });
  try {
    return db.prepare('SELECT company_id FROM branches WHERE id = ?').get(branchId);
  } finally {
    db.close();
  }
}

/** Read a settings value from the till, e.g. the `edge_company_id` recorded at pairing. */
function edgeSetting(dataDir, key) {
  const db = new Database(path.join(dataDir, 'pos.db'), { readonly: true });
  try {
    return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
  } finally {
    db.close();
  }
}

test('a bootstrapped user never straddles two companies', async (t) => {
  const world = await paired();
  t.after(() => world.stop());

  // The paired world registers the till with the owner's email and then pairs to
  // a cloud company whose owner carries the same email, so this is precisely the
  // "already registered locally" path that used to leave `company_id` behind.
  const users = ['owner@uji.id', world.seeded.cashierEmail]
    .map((email) => edgeUser(world.edge.dataDir, email))
    .filter(Boolean);
  assert.ok(users.length > 0, 'the bootstrap should have written user rows');

  for (const user of users) {
    const owner = branchOwner(world.edge.dataDir, user.branch_id);
    if (!owner) continue; // a locally-generated branch that the cloud does not know yet
    assert.equal(
      user.company_id,
      owner.company_id,
      `user ${user.email} belongs to company ${user.company_id} but its branch ${user.branch_id} ` +
        `belongs to ${owner.company_id}; the scope would come back empty and every page would 403`,
    );
  }
});

test('the till can still work after a re-pair to a different company', async (t) => {
  const world = await paired();
  t.after(() => world.stop());

  // A cashier has no company-wide permission, so its scope is exactly one branch.
  // If that branch is foreign the scope is empty and no amount of re-picking helps
  // — the failure the user hit on every page. This token was minted on the till,
  // so it is the one its routes accept.
  const res = await world.api.edge.get(`/api/branches/${world.seeded.branchId}/catalog`, {
    token: world.pair.edgeToken,
  });
  assert.ok(
    res.status < 300,
    `a narrow role must be able to reach its own branch, got ${res.status}: ${JSON.stringify(res.body)}`,
  );

  // The endpoint above only proves the *till's own* admin still works. The
  // duplication bug showed up on the user the till already knew by email, so ask
  // the same question of that row: its company must be the one the pairing
  // recorded, and its branch must belong to that same company. The owner is the
  // account that takes the "already registered locally" path (the till is
  // registered with the owner's email, then paired to the same owner's company),
  // and it is also the super_admin the report came from.
  const owner = edgeUser(world.edge.dataDir, OWNER.email);
  assert.ok(owner, `${OWNER.email} should exist in the replica`);

  const pairedCompany = edgeSetting(world.edge.dataDir, 'edge_company_id');
  assert.equal(
    owner.company_id,
    pairedCompany,
    'a replicated user must belong to the company this till is paired to',
  );

  const branch = branchOwner(world.edge.dataDir, owner.branch_id);
  assert.ok(branch, `branch ${owner.branch_id} should exist in the replica`);
  assert.equal(
    branch.company_id,
    owner.company_id,
    'a replicated user must be assigned to a branch of its own company',
  );
});

test('a re-tenanting bootstrap hands back a usable replacement token', async (t) => {
  const world = await paired();
  t.after(() => world.stop());

  // The till is registered locally first, so its admin's row is re-pointed at the
  // cloud's company on the first bootstrap. The token minted at registration then
  // names the old company, and authRequired rejects it as a 'Tenant mismatch' — the
  // till would be locked out of its own service in the middle of setup. The
  // replacement must be present *and* accepted on the very next request.
  assert.ok(world.pair.boot.token, 'a re-tenanting bootstrap must return a replacement token');
  assert.notEqual(
    world.pair.boot.token,
    world.pair.registeredToken,
    'the replacement must differ from the token minted at registration',
  );

  // The registration token is now spent: `pair` already moved the stored company,
  // so this must be refused rather than half-honoured.
  const spent = await world.api.edge.get('/api/auth/me', { token: world.pair.registeredToken });
  assert.equal(spent.status, 401, 'the pre-pairing token must no longer be accepted');

  const me = await world.api.edge.get('/api/auth/me', { token: world.pair.adminToken });
  assert.ok(
    me.status < 300,
    `the replacement token must be accepted immediately, got ${me.status}: ${JSON.stringify(me.body)}`,
  );
});

test('every user in the replica is scoped to a branch of their own company', async (t) => {
  const world = await paired();
  t.after(() => world.stop());

  const db = new Database(path.join(world.edge.dataDir, 'pos.db'), { readonly: true });
  let users;
  let branches;
  try {
    users = db.prepare('SELECT email, company_id, branch_id FROM users WHERE branch_id IS NOT NULL').all();
    branches = db.prepare('SELECT id, company_id FROM branches').all();
  } finally {
    db.close();
  }

  const ownerOf = new Map(branches.map((b) => [b.id, b.company_id]));
  const broken = users
    .filter((u) => ownerOf.has(u.branch_id) && ownerOf.get(u.branch_id) !== u.company_id)
    .map((u) => `${u.email} (company ${u.company_id.slice(0, 8)} -> branch ${u.branch_id.slice(0, 8)})`);

  assert.deepEqual(broken, [], `users assigned to another company's branch:\n  ${broken.join('\n  ')}`);
});
