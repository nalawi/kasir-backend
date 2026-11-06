// Tests for `src/cli.js` — the operator-side way to create the company.
//
// The installers close web signup (`ALLOW_SIGNUP=0`) *and* create the company
// from the console, so this CLI is the only path to a working first install. If
// it writes a company without its branch or owner, or happily writes a second
// tenant on a second run, the deploy "works" and the shop ends up with two
// super_admins. Every case below is one of those failure modes, checked against
// the database the CLI actually wrote.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.js');
const OWNER = { company: 'PT Uji CLI', name: 'Sari', email: 'owner@uji.id', password: 'rahasia123' };

function withDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pos-cli-'));
  // A deliberately minimal environment: no inherited DB_PATH/DB_DIR from the
  // developer's shell, and nothing else that could change the outcome.
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || process.env.USERPROFILE || dir,
    DB_DIR: dir,
  };
  return { dir, env };
}

function run(env, ...args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  return { code: res.status, out: res.stdout || '', err: res.stderr || '' };
}

function openDb(dir, readonly = true) {
  const file = path.join(dir, 'pos.db');
  assert.ok(existsSync(file), 'the CLI should have created pos.db');
  return new Database(file, { readonly });
}

test('status works on an empty data directory', () => {
  const { dir, env } = withDb();
  try {
    const res = run(env, 'status');
    assert.equal(res.code, 0);
    assert.match(res.out, /mode\s+: cloud/);
    assert.match(res.out, /company\s+: \(none yet\)/);
    assert.match(res.out, /companies=0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('create-company writes the company, its first branch and a usable owner', () => {
  const { dir, env } = withDb();
  try {
    const res = run(
      env,
      'create-company',
      '--company', OWNER.company,
      '--name', OWNER.name,
      '--email', OWNER.email,
      '--password', OWNER.password
    );
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /Created company "PT Uji CLI"/);

    const db = openDb(dir);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM companies').get().n, 1);
      assert.equal(db.prepare('SELECT name FROM companies').get().name, OWNER.company);

      const branch = db.prepare('SELECT id, name, company_id FROM branches').get();
      assert.equal(branch.name, 'Cabang Utama', 'a till needs a branch to sell from');

      const user = db.prepare('SELECT * FROM users').get();
      assert.equal(user.role, 'super_admin');
      assert.equal(user.email, OWNER.email);
      assert.equal(user.branch_id, branch.id);
      assert.equal(user.company_id, branch.company_id);
      assert.equal(user.is_active, 1);
      // The hash must be the same bcryptjs the login route compares against.
      assert.ok(bcrypt.compareSync(OWNER.password, user.password_hash));
      assert.ok(!bcrypt.compareSync('salah-password', user.password_hash));
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('a second create-company is refused and leaves one company behind', () => {
  const { dir, env } = withDb();
  try {
    assert.equal(
      run(env, 'create-company', '--company', 'A', '--name', 'A', '--email', 'a@uji.id', '--password', 'rahasia123').code,
      0
    );

    const second = run(env, 'create-company', '--company', 'Phantom', '--name', 'P', '--email', 'p@uji.id', '--password', 'rahasia123');
    assert.equal(second.code, 1);
    assert.match(second.err, /refusing to create a second company/);
    // The message has to tell the operator what to do instead.
    assert.match(second.err, /set-password/);

    const db = openDb(dir);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM companies').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--force still refuses an email that already has an account', () => {
  const { dir, env } = withDb();
  try {
    run(env, 'create-company', '--company', 'A', '--name', 'A', '--email', OWNER.email, '--password', 'rahasia123');
    const forced = run(env, 'create-company', '--company', 'B', '--name', 'B', '--email', OWNER.email, '--password', 'rahasia123', '--force');
    assert.equal(forced.code, 1);
    assert.match(forced.err, /already has a user account/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('set-password replaces the hash and clears refresh tokens', () => {
  const { dir, env } = withDb();
  try {
    run(env, 'create-company', '--company', 'A', '--name', 'A', '--email', OWNER.email, '--password', 'rahasia123');

    const db = openDb(dir);
    let userId;
    try {
      userId = db.prepare('SELECT id FROM users').get().id;
    } finally {
      db.close();
    }
    // Give the user a session so we can prove it is revoked afterwards.
    const writable = openDb(dir, false);
    writable.prepare(
      "INSERT INTO refresh_tokens (token_hash, user_id, expires_at) VALUES ('hash-1', ?, datetime('now', '+30 days'))"
    ).run(userId);
    writable.close();

    // Password supplied through the environment, which is the documented way to
    // keep it out of `ps` and shell history.
    const res = run({ ...env, CLI_PASSWORD: 'password-baru' }, 'set-password', '--email', OWNER.email);
    assert.equal(res.code, 0, res.err);

    const after = openDb(dir);
    try {
      const user = after.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
      assert.ok(bcrypt.compareSync('password-baru', user.password_hash));
      assert.ok(!bcrypt.compareSync('rahasia123', user.password_hash));
      assert.equal(
        after.prepare('SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ?').get(userId).n,
        0,
        'old sessions must not survive a password change'
      );
    } finally {
      after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bad input is refused with a non-zero exit code', () => {
  const { dir, env } = withDb();
  try {
    assert.equal(run(env, 'set-password', '--email', 'nobody@uji.id', '--password', 'rahasia123').code, 1);
    assert.equal(run(env, 'create-company', '--company', 'A', '--name', 'A', '--email', 'a@uji.id').code, 2);
    assert.equal(run(env, 'create-company').code, 2);
    assert.equal(run(env, 'nonsense').code, 2);
    assert.equal(run(env, '--help').code, 0);
    assert.match(run(env, '--help').out, /create-company/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
