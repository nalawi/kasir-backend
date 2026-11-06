#!/usr/bin/env node
// Operator CLI for a deployed server.
//
// Why this exists: a production install ships with `ALLOW_SIGNUP=0` (see README),
// so `POST /api/auth/register` is closed — including for the very first company.
// That is deliberate: an internet-reachable box that accepts signup is a box where
// the first stranger to find it owns it. The installers therefore create the
// company here, on the console, with no HTTP surface involved.
//
// It talks to the same SQLite file the service uses (`DB_DIR`/`DB_PATH`), so it
// can be run while the service is up; `bootstrapCompany` writes in one transaction
// and SQLite serialises it against the running process.
//
//   node src/cli.js create-company --company "PT Kopi" --name "Sari" \
//        --email owner@kopi.id --password "rahasia123"
//   node src/cli.js set-password --email owner@kopi.id --password "baru123"
//   node src/cli.js status
//
// Every write is refused rather than silently duplicated: an operator who expects
// a fresh company reads an error instead of discovering a second tenant later.

import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { parseArgs } from 'util';
import { fileURLToPath } from 'url';

import { db, initSchema, DATA_DIR } from './db.js';
import { bootstrapCompany } from './lib/bootstrap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `Reekas POS — server administration

Usage:
  node src/cli.js status
  node src/cli.js create-company --company <name> --name <owner> --email <email> --password <password> [--force]
  node src/cli.js set-password --email <email> --password <password>

Options:
  --company    Company (tenant) display name            [create-company]
  --name       Owner's full name                        [create-company]
  --email      Owner's login email                      [create-company, set-password]
  --password   Owner's password, min 6 characters       [create-company, set-password]
               May also be given as CLI_PASSWORD to keep it out of shell history.
  --force      Create a company even though one exists  [create-company]
  -h, --help   Show this help

Notes:
  * The database is whatever DB_DIR / DB_PATH point at; nothing else is touched.
  * create-company also creates the first branch ("Cabang Utama") and a
    super_admin user, exactly like self-service registration does.
  * set-password signs the user out everywhere by dropping their refresh tokens.
`;

function die(message, code = 2) {
  process.stderr.write(`error: ${message}\n\n${USAGE}`);
  process.exit(code);
}

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Password from `--password` or `CLI_PASSWORD`, so it can stay out of `ps`. */
function resolvePassword(values) {
  const value = values.password ?? process.env.CLI_PASSWORD ?? '';
  if (!value) die('--password is required (or set CLI_PASSWORD in the environment)');
  if (String(value).length < 6) die('password must be at least 6 characters', 1);
  return String(value);
}

function existingCompany() {
  // `rowid` rather than `created_at`: the companies table is the one table old
  // deployments may have without a timestamp column.
  return db.prepare('SELECT id, name, email FROM companies ORDER BY rowid LIMIT 1').get();
}

/* ------------------------------- commands ------------------------------- */

function cmdStatus() {
  const company = existingCompany();
  const counts = ['companies', 'branches', 'users', 'products', 'transactions'].map((table) => {
    let n = 0;
    try {
      n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    } catch {
      /* table not created yet */
    }
    return `${table}=${n}`;
  });
  const mode = process.env.EDGE_MODE === '1' ? 'edge' : 'cloud';

  console.log(`Reekas POS ${readVersion()}`);
  console.log(`  mode        : ${mode}`);
  console.log(`  data dir    : ${DATA_DIR}`);
  console.log(`  database    : ${process.env.DB_PATH || path.join(DATA_DIR, 'pos.db')}`);
  console.log(`  company     : ${company ? `${company.name} <${company.email || '-'}>` : '(none yet)'}`);
  console.log(`  rows        : ${counts.join(' ')}`);
  if (mode === 'cloud') {
    const flag = process.env.ALLOW_SIGNUP;
    console.log(`  signup      : ${flag === undefined ? 'open (ALLOW_SIGNUP unset)' : `ALLOW_SIGNUP=${flag}`}`);
  }
  return 0;
}

function cmdCreateCompany(values) {
  const companyName = String(values.company || '').trim();
  const ownerName = String(values.name || '').trim();
  const email = String(values.email || '').trim();
  if (!companyName || !ownerName || !email) die('create-company needs --company, --name and --email');

  const company = existingCompany();
  if (company && !values.force) {
    process.stderr.write(
      `refusing to create a second company: this server already holds "${company.name}".\n` +
        'A POS deployment is single-tenant; a second company here would be a second set of\n' +
        'users with super_admin over the same data. Pass --force only if you really mean it.\n' +
        `Existing owner email: ${company.email || '(none recorded)'}\n` +
        "To reset that owner's password instead:\n" +
        '  node src/cli.js set-password --email <email> --password <password>\n'
    );
    return 1;
  }

  if (db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(email)) {
    process.stderr.write(`refusing to create a company: the email ${email} already has a user account.\n`);
    return 1;
  }

  const password = resolvePassword(values);
  const user = bootstrapCompany({ companyName, name: ownerName, email, password });

  console.log(`Created company "${companyName}" (${user.company_id})`);
  console.log(`  branch : Cabang Utama (${user.branch_id})`);
  console.log(`  owner  : ${email} (super_admin, ${user.id})`);
  console.log('Sign in with that email and password. Add branches and cashiers from the web UI.');
  return 0;
}

function cmdSetPassword(values) {
  const email = String(values.email || '').trim();
  if (!email) die('set-password needs --email');

  const user = db.prepare('SELECT id, email, is_active FROM users WHERE lower(email) = lower(?)').get(email);
  if (!user) {
    process.stderr.write(`no user with email ${email} in this database\n`);
    return 1;
  }
  const password = resolvePassword(values);

  // Same bcryptjs cost as the server's own hashing, so `POST /api/auth/login`
  // compares against a hash it would have written itself.
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), user.id);
  // Changing a password must not leave old sessions alive.
  try {
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(user.id);
  } catch {
    /* table absent on a pre-refresh-token schema */
  }

  console.log(`Password updated for ${user.email}${user.is_active ? '' : ' (note: this user is deactivated)'}`);
  return 0;
}

/* --------------------------------- main --------------------------------- */

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        company: { type: 'string' },
        name: { type: 'string' },
        email: { type: 'string' },
        password: { type: 'string' },
        force: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    die(err.message);
  }

  const { values, positionals } = parsed;
  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  // Tables are created before every command, so `status` reports zeros on a fresh
  // data directory instead of failing on "no such table".
  initSchema();

  switch (command) {
    case 'status':
      return cmdStatus();
    case 'create-company':
      return cmdCreateCompany(values);
    case 'set-password':
      return cmdSetPassword(values);
    default:
      die(`unknown command "${command}"`);
  }
}

process.exitCode = main(process.argv.slice(2));

