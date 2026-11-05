// Branch-scope tests: what a till may ask for, and what it is told when it
// asks for something it may not have.
//
// The reported failure was every page answering
// `Forbidden: branch not in your scope` right after a successful super-admin
// login. Nothing was wrong with the permissions — a super_admin legitimately
// holds every branch of its company. The client was sending a branch id left
// over from an *earlier pairing to a different company* (the same company name
// had been registered more than once), so `/auth/me` listed three valid
// branches while the till kept asking about a fourth that belonged elsewhere.
//
// Two things are covered here:
//   1. the guard must keep refusing a foreign branch — that part was correct and
//      must not be relaxed while fixing the client;
//   2. the refusal must say which of the two causes it is, because "not in your
//      scope" is true for both a permission boundary and a stale id, and only one
//      of them is fixable by picking another branch.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startWorld } from './harness.mjs';
import { seedCloud } from './fixtures.mjs';

/** Register a second, independent company on the same server and return its token. */
async function otherCompany(api) {
  const res = await api.cloud.post('/api/auth/register', {
    body: { company_name: 'Toko Lain', name: 'Owner Lain', email: 'lain@toko.test', password: 'rahasia-lain' },
  });
  assert.ok(res.status < 300, `second company failed: ${JSON.stringify(res.body)}`);
  const branches = await api.cloud.get('/api/branches', { token: res.body.token });
  assert.ok(branches.body.length > 0, 'the second company needs a branch');
  return { token: res.body.token, branchId: branches.body[0].id };
}

test('a foreign branch is refused, and the message names the real cause', async (t) => {
  const world = await startWorld();
  t.after(() => world.stop());

  const mine = await seedCloud(world.api);
  const theirs = await otherCompany(world.api);

  // The foreign branch id is a *valid* branch — just not of this company. That is
  // exactly the shape of the bug: nothing looks malformed, it simply belongs to
  // someone else, so no amount of retrying fixes it.
  const res = await world.api.cloud.get(
    `/api/branches/${theirs.branchId}/catalog`,
    { token: mine.token },
  );

  assert.equal(res.status, 403, 'a foreign branch must still be refused');
  assert.match(String(res.body.error), /not in your scope/);

  // The extra sentence is the fix: it tells the operator to pick another branch
  // instead of leaving them to guess whether this is a permission problem.
  assert.match(
    String(res.body.error),
    /bukan milik perusahaan Anda|pilih ulang cabang/,
    `the 403 should explain that the branch belongs to another company, got: ${res.body.error}`,
  );
});

test('a branch inside the scope is allowed even for a narrow role', async (t) => {
  const world = await startWorld();
  t.after(() => world.stop());

  const seeded = await seedCloud(world.api);

  // A cashier has no company-wide permission, so its scope is exactly one branch.
  // This is the boundary that must stay intact: narrowing the client's choice must
  // not be mistaken for allowing everything.
  const login = await world.api.cloud.post('/api/auth/login', {
    body: { email: seeded.cashierEmail, password: seeded.cashierPassword },
  });
  assert.ok(login.status < 300, `cashier login failed: ${JSON.stringify(login.body)}`);

  const ok = await world.api.cloud.get(`/api/branches/${seeded.branchId}/catalog`, {
    token: login.body.token,
  });
  assert.ok(ok.status < 300, `own branch should be allowed, got ${ok.status}: ${JSON.stringify(ok.body)}`);

  const foreign = await otherCompany(world.api);
  const denied = await world.api.cloud.get(`/api/branches/${foreign.branchId}/catalog`, {
    token: login.body.token,
  });
  assert.equal(denied.status, 403, 'a cashier must not reach another company');
});

test('/auth/me never advertises a branch the user cannot use', async (t) => {
  const world = await startWorld();
  t.after(() => world.stop());

  const seeded = await seedCloud(world.api);

  // The client is told to trust `/me` when re-picking a branch, so every id it
  // lists must actually work. If these two ever disagree the till is sent straight
  // back into the 403 loop it was just rescued from.
  const me = await world.api.cloud.get('/api/auth/me', { token: seeded.token });
  assert.ok(me.status < 300, `me failed: ${JSON.stringify(me.body)}`);
  assert.ok(me.body.branches.length > 0, 'the owner must see at least one branch');

  for (const branch of me.body.branches) {
    const res = await world.api.cloud.get(`/api/branches/${branch.id}/catalog`, { token: seeded.token });
    assert.ok(
      res.status < 300,
      `branch ${branch.name} (${branch.id}) is listed by /me but answered ${res.status}`,
    );
  }
});
