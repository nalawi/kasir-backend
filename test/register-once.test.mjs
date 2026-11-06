// Registration is a cloud action, but the till runs the same route against its
// own replica.
//
// Symptom: anyone in the shop could open the app, pick "Daftar Perusahaan" and
// create a *second* company inside the till's database — with themselves as its
// `super_admin`. That account is not a real signup: it is a phantom tenant
// holding every permission over the local service (pair, bootstrap, drain, the
// outbox, and the paired owner's cloud token), and no bootstrap ever removes the
// row because the applier only upserts the cloud's company.
//
// So a till allows registration exactly once — during first-run setup, while its
// `companies` table is still empty, which is also the only way to obtain the
// `device.manage` session that `/api/edge/pair` needs. The cloud keeps ordinary
// self-service signup unless the operator closes it with `ALLOW_SIGNUP=0`.
//
// Second hole, same page: `PUT /api/edge/config` was `authRequired` only, so any
// cashier could repoint the till at their own host — and `upstreamFetch` would
// then present the *cloud-issued* device token to it. A genuine address change now
// needs `device.manage` and wipes the stored cloud credentials.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import Database from 'better-sqlite3';

import { startWorld } from './harness.mjs';
import { startPairedWorld, OWNER } from './fixtures.mjs';

/** Read one row from the till's SQLite file (a setting, or a count query). */
function edgeDb(dataDir, sql, ...params) {
  const db = new Database(path.join(dataDir, 'pos.db'), { readonly: true });
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

test('a till accepts company registration once, then refuses and writes nothing', async () => {
  const world = await startWorld();
  try {
    const { api } = world;

    // First run: the owner registers the device. This is legitimate — it is how
    // the till gets a session that may call /api/edge/pair.
    const first = await api.edge.post('/api/auth/register', {
      body: { company_name: 'Toko Uji', ...OWNER },
    });
    assert.equal(first.status, 201, `first registration failed: ${JSON.stringify(first.body)}`);
    assert.ok(first.body.token);

    // ...and the door is now shut, and the login page is told so.
    const health = await api.edge.get('/api/health');
    assert.equal(health.body.mode, 'edge');
    assert.equal(health.body.features.register, false, 'till still advertises registration');

    // A second "signup" — the exact thing any staff member could do before.
    const second = await api.edge.post('/api/auth/register', {
      body: { company_name: 'Toko Lain', name: 'Penyusup', email: 'lain@uji.id', password: 'rahasia123' },
    });
    assert.equal(second.status, 409);
    assert.match(second.body.error, /sudah terdaftar/i);
    assert.match(second.body.error, /Toko Uji/);

    // Nothing was written: no second company, no second branch, and the rejected
    // account does not exist.
    assert.equal(edgeDb(world.edge.dataDir, 'SELECT COUNT(*) AS n FROM companies').n, 1);
    const branches = await api.edge.get('/api/edge/pin-branches');
    assert.equal(branches.body.branches.length, 1, 'a refused registration created a branch');
    const intruder = await api.edge.post('/api/auth/login', {
      body: { email: 'lain@uji.id', password: 'rahasia123' },
    });
    assert.equal(intruder.status, 401);

    // The cloud side of the same world is untouched: it still offers signup.
    const cloudHealth = await api.cloud.get('/api/health');
    assert.equal(cloudHealth.body.mode, 'cloud');
    assert.equal(cloudHealth.body.features.register, true);
  } finally {
    await world.stop();
  }
});

test('cloud signup stays open by default and ALLOW_SIGNUP=0 closes it', async () => {
  const open = await startWorld();
  try {
    const a = await open.api.cloud.post('/api/auth/register', {
      body: { company_name: 'Toko A', name: 'A', email: 'a@uji.id', password: 'rahasia123' },
    });
    const b = await open.api.cloud.post('/api/auth/register', {
      body: { company_name: 'Toko B', name: 'B', email: 'b@uji.id', password: 'rahasia123' },
    });
    assert.ok(a.status < 300, `register A failed: ${JSON.stringify(a.body)}`);
    assert.ok(b.status < 300, `register B failed: ${JSON.stringify(b.body)}`);
  } finally {
    await open.stop();
  }

  // A single-tenant install: the company already exists, so the signup route is
  // closed on the cloud. The till in the same deployment must still be able to run
  // its one-time local registration, or it could never be paired.
  const closed = await startWorld({ cloudEnv: { ALLOW_SIGNUP: '0' } });
  try {
    const res = await closed.api.cloud.post('/api/auth/register', {
      body: { company_name: 'Toko C', name: 'C', email: 'c@uji.id', password: 'rahasia123' },
    });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /dinonaktifkan/i);

    const cloudHealth = await closed.api.cloud.get('/api/health');
    assert.equal(cloudHealth.body.features.register, false);

    const edgeReg = await closed.api.edge.post('/api/auth/register', {
      body: { company_name: 'Toko Uji', ...OWNER },
    });
    assert.equal(edgeReg.status, 201, 'ALLOW_SIGNUP must not block till setup');
    const edgeHealth = await closed.api.edge.get('/api/health');
    assert.equal(edgeHealth.body.features.register, false, 'till must close after setup');
  } finally {
    await closed.stop();
  }
});

test('repointing a paired till needs device.manage and drops the cloud token', async () => {
  const world = await startPairedWorld();
  try {
    const { api } = world;
    const edgeDir = world.servers.edge.dataDir;
    const cloudUrl = world.cloud.url;
    const elsewhere = 'http://127.0.0.1:9';

    // Sanity: paired, and the stored cloud token reaches the cloud.
    const before = await api.edge.get('/api/edge/cloud-branches', { token: world.edge.adminToken });
    assert.equal(before.status, 200);
    assert.equal(before.body.branches.length, 1, 'till should see the cloud branch list');
    assert.ok(edgeDb(edgeDir, "SELECT value FROM settings WHERE key = 'edge_device_token'").value);

    // A cashier on the till: a real password, but no `device.manage`.
    const created = await api.edge.post('/api/users', {
      token: world.edge.adminToken,
      body: {
        name: 'Kasir Uji',
        email: 'kasir@uji.id',
        password: 'rahasia123',
        role: 'cashier',
        branch_id: world.seeded.branchId,
      },
    });
    assert.equal(created.status, 201, `cashier create failed: ${JSON.stringify(created.body)}`);
    const login = await api.edge.post('/api/auth/login', {
      body: { email: 'kasir@uji.id', password: 'rahasia123' },
    });
    assert.ok(login.status < 300, `cashier login failed: ${JSON.stringify(login.body)}`);
    const cashier = login.body.token;

    // Re-sending the address the till already has is what the app does on every
    // login, so it must keep working for a cashier — and must not wipe anything.
    const resend = await api.edge.put('/api/edge/config', { token: cashier, body: { upstream: cloudUrl } });
    assert.equal(resend.status, 200, 'same-value re-send must stay open to any session');
    assert.ok(edgeDb(edgeDir, "SELECT value FROM settings WHERE key = 'edge_device_token'").value);

    // Pointing the till somewhere else is device management, not a preference:
    // otherwise the next drain would hand the owner's cloud bearer to that host.
    const hijack = await api.edge.put('/api/edge/config', { token: cashier, body: { upstream: elsewhere } });
    assert.equal(hijack.status, 403);
    assert.equal(edgeDb(edgeDir, "SELECT value FROM settings WHERE key = 'edge_upstream_url'").value, cloudUrl);

    // The owner may move it — but the token minted by the old host must not
    // survive, or `upstreamFetch` would present it to the new one.
    const moved = await api.edge.put('/api/edge/config', {
      token: world.edge.adminToken,
      body: { upstream: elsewhere },
    });
    assert.equal(moved.status, 200, `owner repoint failed: ${JSON.stringify(moved.body)}`);
    assert.equal(edgeDb(edgeDir, "SELECT value FROM settings WHERE key = 'edge_upstream_url'").value, elsewhere);
    assert.equal(edgeDb(edgeDir, "SELECT value FROM settings WHERE key = 'edge_device_token'").value, null);
    assert.equal(edgeDb(edgeDir, "SELECT value FROM settings WHERE key = 'edge_paired_at'").value, null);

    // Which is exactly what the till then reports: it needs pairing again.
    const after = await api.edge.get('/api/edge/cloud-branches', { token: world.edge.adminToken });
    assert.equal(after.body.branches.length, 0);
    assert.match(String(after.body.reason), /belum terhubung/i);
  } finally {
    await world.stop();
  }
});

