import crypto from 'crypto';
import { db } from '../db.js';

const { randomUUID } = crypto;

/**
 * Backup and restore for the operational database.
 *
 * Deliberately a JSON document rather than a copy of the SQLite file. A file copy
 * carries `refresh_tokens`, password hashes and the `edge_*` credentials, so
 * restoring one would silently resurrect revoked sessions and could re-point a
 * till at an upstream it was unpaired from. A JSON bundle is reviewable, diffable,
 * and lets restore merge by primary key instead of replacing the world.
 *
 * The three categories an operator picks from:
 *
 *   master        what the business *is*   — company, outlets, catalogue, staff
 *   transaction   what the business *did*  — sales, shifts, stock movements
 *   configuration how the system *behaves* — settings, taxes, receipt text
 *
 * The split is not cosmetic: it is what makes "restore my catalogue after a bad
 * import" possible without also rolling back yesterday's takings, and what keeps a
 * configuration restore from duplicating sales.
 */

export const CATEGORIES = ['master', 'transaction', 'configuration'];

/**
 * Which table belongs to which category, in insert order.
 *
 * Order matters on restore: `products` references `categories`, and
 * `transaction_items` references both. Keeping one ordered list per category means
 * a restore can enable `foreign_keys` and still satisfy every constraint, instead
 * of switching FK enforcement off and hoping.
 *
 * Every table listed here has a stable TEXT primary key, so `INSERT OR REPLACE`
 * is a true upsert. Tables keyed by an autoincrement integer (`login_attempts`,
 * `edge_login_attempts`) are absent on purpose — a backup is not a log archive.
 */
export const TABLES = {
  master: [
    'companies',
    'branches',
    'roles',
    'users',
    'categories',
    'products',
    'product_variants',
    'branch_products',
    'branch_stocks',
    'devices'
  ],
  transaction: [
    'shifts',
    'transactions',
    'transaction_items',
    'stock_movements',
    'stock_transfers',
    'stock_transfer_items',
    'hold_orders',
    'hold_order_items',
    'order_queue',
    'order_queue_items'
  ],
  configuration: ['settings']
};

/**
 * Settings keys a backup must never carry.
 *
 * `edge_*` holds the till's pairing: upstream URL, device token, company/branch
 * ids. Restoring those from an old bundle would silently re-point a live till at
 * a previous upstream (or a previous company) — the exact authority that
 * `POST /edge/pair` gates behind `device.manage`. They are excluded on *export*
 * so they cannot leak into a file that travels by email, and filtered again on
 * *import* so a hand-edited bundle cannot inject them.
 */
export const SECRET_SETTING_PREFIX = 'edge_';

/** Columns never written from a bundle, on top of the table allowlist. */
const SECRET_COLUMNS = {
  users: ['password_hash']
};

/** Human label + what it covers, so the UI need not hardcode the table lists. */
export const CATEGORY_META = {
  master: {
    label: 'Data master',
    hint: 'Perusahaan, cabang, kategori, produk, varian, stok, pengguna, peran, dan perangkat',
    tables: TABLES.master
  },
  transaction: {
    label: 'Data transaksi',
    hint: 'Penjualan, item, shift, pergerakan stok, transfer, pesanan tertahan, dan antrean dapur',
    tables: TABLES.transaction
  },
  configuration: {
    label: 'Data konfigurasi',
    hint: 'Pengaturan sistem, pajak, mata uang, dan teks struk',
    tables: TABLES.configuration
  }
};

/** Expand a caller's selection into a validated list of categories. */
export function normalizeCategories(input) {
  const wanted = Array.isArray(input) && input.length ? input : CATEGORIES;
  const unknown = wanted.filter((c) => !CATEGORIES.includes(c));
  if (unknown.length) {
    const e = new Error(`Kategori tidak dikenal: ${unknown.join(', ')}`);
    e.status = 400;
    throw e;
  }
  // Canonical order, so two callers asking for the same set get byte-identical
  // output and the same insert order.
  return CATEGORIES.filter((c) => wanted.includes(c));
}

const tableExists = (name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

/** True when a settings row is machine-managed pairing state, not operator config. */
const isSecretSetting = (row) => String(row.key || '').startsWith(SECRET_SETTING_PREFIX);

/**
 * Read every selected table into a plain object.
 *
 * `company_id` scoping is applied wherever the column exists, so a multi-tenant
 * cloud exports one company rather than the whole database. A till holds exactly
 * one company, so the same query is a no-op there.
 */
export function dumpData({ categories, companyId }) {
  const out = {};
  for (const category of normalizeCategories(categories)) {
    for (const table of TABLES[category]) {
      if (!tableExists(table)) continue;
      const cols = columnsOf(table);
      const scoped = cols.includes('company_id') && companyId;
      const rows = scoped
        ? db.prepare(`SELECT * FROM ${table} WHERE company_id = ?`).all(companyId)
        : db.prepare(`SELECT * FROM ${table}`).all();

      out[table] = rows
        .map((row) => {
          const clean = { ...row };
          // A credential must never leave the building inside a backup file.
          for (const col of SECRET_COLUMNS[table] || []) delete clean[col];
          return clean;
        })
        // `settings` is key/value, so secret rows are dropped, not columns.
        .filter((row) => table !== 'settings' || !isSecretSetting(row));
    }
  }
  return out;
}

/** Per-table row counts, without materialising rows. Used by the dry run. */
export function countData({ categories, companyId }) {
  const out = {};
  for (const category of normalizeCategories(categories)) {
    for (const table of TABLES[category]) {
      if (!tableExists(table)) continue;
      const cols = columnsOf(table);
      const scoped = cols.includes('company_id') && companyId;
      out[table] = scoped
        ? db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE company_id = ?`).get(companyId).n
        : db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    }
  }
  return out;
}

/**
 * Build the downloadable bundle.
 *
 * `format`/`version` let a future build recognise an old file and refuse it
 * politely instead of importing something with a half-matching schema. The counts
 * travel with the file so a restore preview can be checked against the file the
 * operator *thinks* they picked.
 */
export function buildBundle({ categories, companyId, companyName } = {}) {
  const selected = normalizeCategories(categories);
  const data = dumpData({ categories: selected, companyId });
  const counts = Object.fromEntries(Object.entries(data).map(([t, rows]) => [t, rows.length]));
  return {
    format: 'pos-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    companyId: companyId || null,
    companyName: companyName || null,
    categories: selected,
    counts,
    data
  };
}

/** `backup-<company>-<date>.json`, safe as a filename on every OS. */
export function backupFilename(companyName) {
  const slug =
    String(companyName || 'pos')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'pos';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `backup-${slug}-${stamp}.json`;
}

/**
 * Validate the envelope of an uploaded bundle.
 *
 * Kept separate from the write path so the preview and the apply agree on what is
 * acceptable: an operator must never see "12 products ready" and then a rejection.
 */
export function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') {
    throw Object.assign(new Error('File backup tidak valid'), { status: 400 });
  }
  if (bundle.format !== 'pos-backup' || !bundle.data || typeof bundle.data !== 'object') {
    throw Object.assign(new Error('File ini bukan backup POS'), { status: 400 });
  }
  if (!Array.isArray(bundle.categories) || !bundle.categories.length) {
    throw Object.assign(new Error('File backup tidak menyebutkan kategori datanya'), { status: 400 });
  }
  for (const table of Object.keys(bundle.data)) {
    const known = Object.values(TABLES).some((list) => list.includes(table));
    if (!known) {
      // Refuse rather than ignore: a bundle naming a table this build does not
      // know is from a newer version, and restoring the rest would look successful
      // while quietly dropping part of the data.
      throw Object.assign(new Error(`File backup berisi tabel yang tidak dikenal: ${table}`), { status: 400 });
    }
  }
  return bundle;
}

/**
 * Build the plan for a restore without writing anything.
 *
 * Returns per-table `{ incoming, existing, added, updated }` so the operator can
 * see the blast radius — "this bundle adds 340 transactions and overwrites 12
 * products" — before committing. The same rows feed the apply, so the numbers
 * shown are the numbers written.
 */
export function planRestore(bundle, { categories, companyId } = {}) {
  validateBundle(bundle);
  // The caller's selection can narrow the bundle but never widen it.
  const requested = normalizeCategories(categories && categories.length ? categories : bundle.categories);
  const selected = bundle.categories.filter((c) => requested.includes(c));

  const tables = {};
  for (const category of selected) {
    for (const table of TABLES[category]) {
      const incoming = Array.isArray(bundle.data[table]) ? bundle.data[table] : [];
      if (!incoming.length) continue;
      if (!tableExists(table)) continue;

      const cols = columnsOf(table);
      const scoped = cols.includes('company_id') && companyId;
      // `settings` is keyed by `key`; every other table has a TEXT `id`.
      const keyCol = table === 'settings' ? 'key' : 'id';
      const existing = new Set(
        (scoped
          ? db.prepare(`SELECT ${keyCol} AS k FROM ${table} WHERE company_id = ?`).all(companyId)
          : db.prepare(`SELECT ${keyCol} AS k FROM ${table}`).all()
        ).map((r) => r.k)
      );

      let added = 0;
      let updated = 0;
      let skipped = 0;
      for (const row of incoming) {
        const key = row[keyCol];
        if (!key) {
          skipped++;
          continue;
        }
        if (table === 'settings' && isSecretSetting(row)) {
          skipped++;
          continue;
        }
        if (existing.has(key)) updated++;
        else added++;
      }
      tables[table] = { incoming: incoming.length, existing: existing.size, added, updated, skipped };
    }
  }
  return { categories: selected, tables };
}
/**
 * Restore one user row without touching its password.
 *
 * Restoring `users` is the one place a naive upsert is actively harmful, and it
 * fails loudly rather than silently: `password_hash` is NOT NULL, so the export
 * strips it (a backup must not carry credentials) and `INSERT OR REPLACE` would
 * then try to write a row with no hash at all.
 *
 * The right semantic is a field-level merge. An existing account keeps its current
 * password and only has its profile/role/branch/flags restored, so a restore never
 * resets anyone's password — and never locks the operator out mid-recovery. An
 * account that does not exist yet is created with a hash that matches no password,
 * so it cannot be logged into until an owner sets one deliberately.
 */
const UNUSABLE_PASSWORD_HASH = '!restored-without-password';

function upsertUser(row, keys) {
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(row.id);
  const cols = keys.filter((k) => k !== 'password_hash');

  if (existing) {
    const sets = cols.filter((k) => k !== 'id');
    if (!sets.length) return false;
    db.prepare(`UPDATE users SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(
      ...sets.map((k) => row[k]),
      row.id
    );
    return true;
  }

  // New account: keep every field the file offered, plus an unusable password.
  const insertCols = [...cols, 'password_hash'];
  db.prepare(
    `INSERT INTO users (${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(', ')})`
  ).run(...cols.map((k) => row[k]), UNUSABLE_PASSWORD_HASH);
  return true;
}



/**
 * Apply a restore, all-or-nothing.
 *
 * One SQLite transaction wraps every table: a constraint failure halfway through
 * rolls the whole thing back, so the database is never left half-restored. Rows are
 * merged by primary key (`INSERT OR REPLACE`), which makes a restore idempotent —
 * running the same bundle twice changes nothing the second time — and means a
 * partial backup (say, master only) does not delete the sales it never mentioned.
 */
export function applyRestore(bundle, { categories, userId, companyId } = {}) {
  const plan = planRestore(bundle, { categories, companyId });

  const written = {};
  const run = db.transaction(() => {
    for (const category of plan.categories) {
      for (const table of TABLES[category]) {
        const rows = bundle.data[table];
        if (!Array.isArray(rows) || !rows.length) continue;
        if (!tableExists(table)) continue;

        const valid = new Set(columnsOf(table));
        let n = 0;
        for (const row of rows) {
          if (table === 'settings' && isSecretSetting(row)) continue;

          // Only columns this build actually has. A bundle from a newer version may
          // carry extra fields; dropping them is safer than failing the restore.
          const keys = Object.keys(row).filter((k) => valid.has(k));
          if (!keys.length) continue;
          // Rows keyed by `key` (settings) or `id`; one without either is unusable.
          const keyCol = table === 'settings' ? 'key' : 'id';
          if (!keys.includes(keyCol)) continue;

          if (table === 'users') {
            if (upsertUser(row, keys)) n++;
            continue;
          }

          // Nothing to update (key-only row): the insert alone is the whole job.
          const sets = keys.filter((k) => k !== keyCol);
          if (!sets.length) {
            db.prepare(`INSERT OR IGNORE INTO ${table} (${keyCol}) VALUES (?)`).run(row[keyCol]);
            n++;
            continue;
          }

          // A true upsert, NOT `INSERT OR REPLACE`.
          //
          // REPLACE deletes the conflicting row and inserts a new one, which fires
          // ON DELETE CASCADE: replacing `companies` would wipe every branch, user
          // and product hanging off it, and `transactions` would take their items
          // with them. `ON CONFLICT ... DO UPDATE` rewrites the existing row in
          // place, so dependent rows are untouched.
          const stmt = db.prepare(
            `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})
             ON CONFLICT(${keyCol}) DO UPDATE SET ${sets.map((k) => `${k} = excluded.${k}`).join(', ')}`
          );
          stmt.run(...keys.map((k) => row[k]));
          n++;
        }
        if (n) written[table] = n;
      }
    }
    // Record who did it inside the same transaction, so the audit trail cannot
    // claim a restore that was then rolled back.
    if (userId) {
      db.prepare(
        `INSERT INTO audit_logs (id, company_id, branch_id, user_id, action, entity, detail)
         VALUES (?, ?, NULL, ?, 'backup.restore', 'backup', ?)`
      ).run(
        randomUUID(),
        companyId || null,
        userId,
        JSON.stringify({ categories: plan.categories, tables: written })
      );
    }
  });

  run();
  return { categories: plan.categories, written, plan };
}
