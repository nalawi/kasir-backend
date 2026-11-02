import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

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
    ['parent_item_id', 'TEXT']
  ],
  shifts: [['note', 'TEXT'], ['cash_sales', 'REAL DEFAULT 0'], ['non_cash_sales', 'REAL DEFAULT 0']],
  devices: [['app_version', 'TEXT'], ['platform', 'TEXT'], ['device_key', 'TEXT'], ['revoked_reason', 'TEXT']],
  stock_transfers: [['rejected_reason', 'TEXT']],
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
}