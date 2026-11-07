import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DB_DIR lets the edge (embedded) service point at the app's local data folder,
// which keeps the SQLite file off cloud-synced paths such as OneDrive that would
// corrupt the WAL journal. The cloud build keeps the default.
const dataDir = path.resolve(process.env.DB_DIR || path.join(__dirname, '..', 'data'));
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
export const DATA_DIR = dataDir;

const dbPath = process.env.DB_PATH || path.join(dataDir, 'pos.db');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initSchema() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT,
    phone TEXT,
    email TEXT,
    legal_info TEXT,
    plan TEXT DEFAULT 'free',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS branches (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    address TEXT,
    phone TEXT,
    opening_hours TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    company_id TEXT REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    permissions TEXT NOT NULL DEFAULT '[]',
    is_system INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'cashier',
    pin TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    sku TEXT,
    barcode TEXT,
    description TEXT,
    image_url TEXT,
    unit TEXT DEFAULT 'pcs',
    cost_price REAL DEFAULT 0,
    default_price REAL NOT NULL DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS branch_products (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    price_override REAL,
    is_available INTEGER DEFAULT 1,
    UNIQUE(branch_id, product_id)
  );

  CREATE TABLE IF NOT EXISTS branch_stocks (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity REAL DEFAULT 0,
    low_stock_threshold REAL DEFAULT 5,
    UNIQUE(branch_id, product_id)
  );

  CREATE TABLE IF NOT EXISTS stock_movements (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    quantity REAL NOT NULL,
    reference_id TEXT,
    note TEXT,
    user_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    shift_id TEXT,
    code TEXT,
    subtotal REAL DEFAULT 0,
    discount REAL DEFAULT 0,
    tax REAL DEFAULT 0,
    total REAL DEFAULT 0,
    payment_method TEXT,
    payment_detail TEXT,
    cash_received REAL DEFAULT 0,
    change_due REAL DEFAULT 0,
    status TEXT DEFAULT 'completed',
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transaction_items (
    id TEXT PRIMARY KEY,
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
    product_name TEXT NOT NULL,
    price REAL NOT NULL,
    cost_price REAL DEFAULT 0,
    quantity REAL NOT NULL,
    discount REAL DEFAULT 0,
    subtotal REAL NOT NULL,
    note TEXT
  );

  CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    opening_cash REAL DEFAULT 0,
    closing_cash REAL,
    expected_cash REAL,
    cash_difference REAL,
    opened_at TEXT DEFAULT (datetime('now')),
    closed_at TEXT,
    status TEXT DEFAULT 'open'
  );

  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    name TEXT,
    identifier TEXT,
    is_active INTEGER DEFAULT 1,
    last_seen TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    company_id TEXT,
    branch_id TEXT,
    user_id TEXT,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id TEXT,
    detail TEXT,
    ip TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    device_id TEXT,
    expires_at TEXT NOT NULL,
    revoked INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS product_variants (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    variant_type TEXT NOT NULL DEFAULT 'option',
    price_adjustment REAL DEFAULT 0,
    is_default INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS stock_transfers (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    code TEXT,
    from_branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    to_branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'requested',
    note TEXT,
    requested_by TEXT,
    approved_by TEXT,
    shipped_at TEXT,
    received_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stock_transfer_items (
    id TEXT PRIMARY KEY,
    transfer_id TEXT NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity REAL NOT NULL,
    received_quantity REAL
  );

  CREATE TABLE IF NOT EXISTS hold_orders (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    user_id TEXT,
    label TEXT,
    subtotal REAL DEFAULT 0,
    discount REAL DEFAULT 0,
    tax REAL DEFAULT 0,
    total REAL DEFAULT 0,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS hold_order_items (
    id TEXT PRIMARY KEY,
    hold_order_id TEXT NOT NULL REFERENCES hold_orders(id) ON DELETE CASCADE,
    product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
    product_name TEXT NOT NULL,
    variant_label TEXT,
    price REAL NOT NULL,
    quantity REAL NOT NULL,
    discount REAL DEFAULT 0,
    note TEXT
  );

  -- Kitchen / barista display queue.
  -- One row per *prepared* ticket (drinks & food sold at the till), separate from
  -- hold_orders (unpaid parked carts) and from transactions (money). A ticket may
  -- be paid (transaction_id) or raised directly by a waiter (null), because
  -- dine-in orders are often sent to the bar before the bill is settled.
  CREATE TABLE IF NOT EXISTS order_queue (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
    hold_order_id TEXT REFERENCES hold_orders(id) ON DELETE SET NULL,
    -- Cross-side identity for a ticket that has no sale behind it (a hold ticket).
    -- It is the till's hold id, so the edge can keep patching this ticket on the
    -- cloud even after the hold row is gone (resumed into a sale) and the foreign
    -- key above has been nulled.
    origin_ref TEXT,
    ticket_no INTEGER,
    order_label TEXT,
    table_number TEXT,
    customer_name TEXT,
    station TEXT DEFAULT 'both',             -- kitchen | bar | both
    status TEXT NOT NULL DEFAULT 'queue',    -- queue | preparing | ready | completed | cancelled
    note TEXT,
    created_by TEXT,
    started_by TEXT,
    ready_by TEXT,
    closed_by TEXT,
    cancel_reason TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    ready_at TEXT,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS order_queue_items (
    id TEXT PRIMARY KEY,
    queue_id TEXT NOT NULL REFERENCES order_queue(id) ON DELETE CASCADE,
    product_id TEXT,
    product_name TEXT NOT NULL,
    variant_label TEXT,
    quantity REAL NOT NULL DEFAULT 1,
    note TEXT,
    done INTEGER DEFAULT 0
  );

  -- Offline-first batch sync log (idempotency + conflict resolution audit)
  CREATE TABLE IF NOT EXISTS sync_queue (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    branch_id TEXT,
    kind TEXT NOT NULL,
    client_uuid TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'applied', -- applied | conflict | rejected
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(client_uuid)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- Edge (embedded) mode only. A sale rung up against the local service is
  -- written straight into the transactions table so the receipt and shift totals
  -- are real, and its payload is mirrored here so the drain worker can replay it
  -- to the cloud. The client_uuid is the shared idempotency key, so a replay that
  -- lands twice is still applied once.
  CREATE TABLE IF NOT EXISTS edge_outbox (
    client_uuid TEXT PRIMARY KEY,
    branch_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | applying | applied | conflict | rejected
    attempts INTEGER DEFAULT 0,
    last_error TEXT,
    next_attempt_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Edge mode only: the latest known state of each kitchen ticket, waiting to be
  -- pushed to the cloud. The sale itself syncs through edge_outbox, but that lane
  -- is terminal once the cloud says "applied" — it never revisits a ticket. Every
  -- later status change (preparing/ready/completed/cancelled), cancel reason and
  -- per-line "done" tick is folded into ONE row per ticket here and drained after
  -- the sale lane, so the cloud board reflects what the bar is actually doing.
  --
  -- origin_uuid is transactions.client_uuid: the same id the sale replay dedupes
  -- on, which already exists on both sides (so no new column on order_queue and no
  -- fan-out duplicates). The revision counter is bumped on every change so a drain
  -- only clears the row it actually sent — a tap that happens mid-flight is resent
  -- next tick instead of being swallowed.
  CREATE TABLE IF NOT EXISTS edge_queue_sync (
    origin_uuid TEXT PRIMARY KEY,           -- transactions.client_uuid
    branch_id TEXT NOT NULL,
    payload TEXT NOT NULL,                  -- latest absolute ticket snapshot
    revision INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | synced
    attempts INTEGER DEFAULT 0,
    last_error TEXT,
    next_attempt_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Edge mode only: parked ("On Hold") carts waiting to be mirrored to the cloud.
  -- A hold is pure cart state — no money moves — so it has no client_uuid and did
  -- not travel with the sale replay at all: the cloud's Hold list stayed empty and
  -- the kitchen ticket raised for it never existed there. One row per hold carries
  -- the whole absolute cart (header + lines + the ticket's current state), drained
  -- before the queue lane so the cloud ticket exists before it is patched.
  --
  -- hold_id is the till's own hold id, replayed verbatim, so updates and the
  -- tombstone written when the cart is resumed or discarded address the same row.
  CREATE TABLE IF NOT EXISTS edge_hold_sync (
    hold_id TEXT PRIMARY KEY,               -- hold_orders.id, mirrored as-is
    branch_id TEXT NOT NULL,
    payload TEXT NOT NULL,                  -- latest absolute hold snapshot (or tombstone)
    revision INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | synced
    attempts INTEGER DEFAULT 0,
    last_error TEXT,
    next_attempt_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Edge mode only: rate limiting for the offline PIN unlock. Mirrors the cloud's
  -- login_attempts so a till cannot be brute-forced faster just because it is
  -- dialled back to the local service.
  CREATE TABLE IF NOT EXISTS edge_login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS login_attempts (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    success INTEGER DEFAULT 0,
    ip TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);
  CREATE INDEX IF NOT EXISTS idx_products_company ON products(company_id);
  CREATE INDEX IF NOT EXISTS idx_tx_company ON transactions(company_id);
  CREATE INDEX IF NOT EXISTS idx_tx_branch ON transactions(branch_id);
  CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at);
  CREATE INDEX IF NOT EXISTS idx_stock_branch ON branch_stocks(branch_id);
  CREATE INDEX IF NOT EXISTS idx_movements_branch ON stock_movements(branch_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);
  CREATE INDEX IF NOT EXISTS idx_transfers_from ON stock_transfers(from_branch_id);
  CREATE INDEX IF NOT EXISTS idx_transfers_to ON stock_transfers(to_branch_id);
  CREATE INDEX IF NOT EXISTS idx_hold_branch ON hold_orders(branch_id);
  CREATE INDEX IF NOT EXISTS idx_queue_branch ON order_queue(branch_id, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_queue_tx ON order_queue(transaction_id);
  CREATE INDEX IF NOT EXISTS idx_queue_items ON order_queue_items(queue_id);
  CREATE INDEX IF NOT EXISTS idx_edge_queue_sync_branch ON edge_queue_sync(branch_id, status);
  CREATE INDEX IF NOT EXISTS idx_edge_hold_sync_branch ON edge_hold_sync(branch_id, status);
  CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_attempts_identifier ON login_attempts(identifier, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_logs(company_id, created_at);
  `);

  // ---------------------------------------------------------------------------
  // Idempotent migrations for databases created by earlier versions.
  // SQLite cannot add a UNIQUE constraint via ALTER TABLE, so those columns are
  // plain TEXT here; uniqueness for client_uuid is enforced in application code.
  // ---------------------------------------------------------------------------
  migrate();
  seedDefaultSettings();
}

/**
 * Guarantee the money-path settings rows exist.
 *
 * `settings` starts empty: it is populated by `npm run seed`, which is a demo
 * script and is not run by the service. Application code falls back to the same
 * defaults, so behaviour is correct either way — but without the rows an operator
 * opening the settings screen would see blanks instead of the values actually in
 * force, and PUT /settings would report no previous value in the audit trail.
 *
 * INSERT OR IGNORE, so an existing value is never overwritten.
 */
function seedDefaultSettings() {
  const defaults = {
    allow_negative_stock: 'warn',
    tax_percent: '0',
    currency: 'IDR',
    locale: 'id-ID',
    receipt_footer: 'Terima kasih atas kunjungan Anda!',
    low_stock_default: '10',
    cash_tolerance: '5000'
  };
  const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
    for (const [k, v] of Object.entries(defaults)) stmt.run(k, v);
  })();
}

const MIGRATIONS = {
  users: [
    ['pin_hash', 'TEXT'],
    ['multi_branch', 'INTEGER DEFAULT 0'],
    ['avatar_url', 'TEXT'],
    ['last_login_at', 'TEXT'],
    ['updated_at', 'TEXT']
  ],
  products: [
    ['brand', 'TEXT'],
    ['is_variant_parent', 'INTEGER DEFAULT 0']
  ],
  branch_stocks: [['updated_at', 'TEXT']],
  transactions: [
    ['client_uuid', 'TEXT'],
    ['order_label', 'TEXT'],
    ['table_number', 'TEXT'],
    ['customer_name', 'TEXT'],
    ['tax_percent', 'REAL DEFAULT 0'],
    ['receipt_number', 'TEXT'],
    ['approved_by', 'TEXT'],
    ['void_reason', 'TEXT'],
    ['synced_from_offline', 'INTEGER DEFAULT 0'],
    ['device_id', 'TEXT']
  ],
  transaction_items: [
    ['variant_id', 'TEXT'],
    ['variant_label', 'TEXT'],
    ['parent_item_id', 'TEXT'],
    ['is_prepared', 'INTEGER DEFAULT 0']
  ],
  shifts: [['note', 'TEXT'], ['cash_sales', 'REAL DEFAULT 0'], ['non_cash_sales', 'REAL DEFAULT 0']],
  devices: [['app_version', 'TEXT'], ['platform', 'TEXT'], ['device_key', 'TEXT'], ['revoked_reason', 'TEXT']],
  stock_transfers: [['rejected_reason', 'TEXT']],
  order_queue: [['hold_order_id', 'TEXT'], ['origin_ref', 'TEXT']],
  companies: [['currency', "TEXT DEFAULT 'IDR'"], ['timezone', "TEXT DEFAULT 'Asia/Jakarta'"], ['tax_percent', 'REAL DEFAULT 0'], ['logo_url', 'TEXT']],
  roles: [['description', 'TEXT'], ['updated_at', 'TEXT']]
};

function migrate() {
  for (const [table, columns] of Object.entries(MIGRATIONS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, type] of columns) {
      if (existing.has(name)) continue;
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      } catch (e) {
        // Table may not exist yet on very old databases — ignore and let initSchema handle it.
        if (!/no such table/i.test(e.message)) throw e;
      }
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_tx_client_uuid ON transactions(client_uuid);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_outbox_status ON edge_outbox(branch_id, status);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_edge_attempts ON edge_login_attempts(user_id, created_at);');
  // Indexed here, not with the schema above: `origin_ref` only exists after the
  // ALTER TABLE loop for databases created by an earlier version.
  db.exec('CREATE INDEX IF NOT EXISTS idx_queue_origin_ref ON order_queue(origin_ref);');
}