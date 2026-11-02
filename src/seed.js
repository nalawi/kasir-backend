import bcrypt from 'bcryptjs';
import { db, initSchema } from './db.js';
import { id, nowSql } from './lib/helpers.js';

initSchema();

function reset() {
  const tables = [
    'transaction_items', 'transactions', 'stock_movements', 'branch_stocks',
    'branch_products', 'shifts', 'devices', 'audit_logs', 'products',
    'categories', 'users', 'branches', 'companies',
    // newer tables
    'product_variants', 'hold_orders', 'stock_transfers', 'stock_transfer_items',
    'sync_queue', 'refresh_tokens', 'roles', 'settings'
  ];
  for (const t of tables) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist yet */ }
  }
}

reset();
console.log('Seeding demo data...');

const companyId = id();
db.prepare('INSERT INTO companies (id, name, address, phone, email, legal_info, plan) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(companyId, 'PT Kopi Nusantara', 'Jl. Sudirman No. 1, Jakarta', '021-5551234', 'admin@kopinusantara.id', 'NPWP 01.234.567.8', 'pro');

const branch1 = id();
const branch2 = id();
const branch3 = id();
const insertBranch = db.prepare('INSERT INTO branches (id, company_id, name, address, phone, opening_hours) VALUES (?, ?, ?, ?, ?, ?)');
insertBranch.run(branch1, companyId, 'Cabang Jakarta Pusat', 'Jl. MH Thamrin 10, Jakarta', '021-1111', '08:00-22:00');
insertBranch.run(branch2, companyId, 'Cabang Bandung', 'Jl. Braga 5, Bandung', '022-2222', '09:00-21:00');
insertBranch.run(branch3, companyId, 'Cabang Surabaya', 'Jl. Tunjungan 8, Surabaya', '031-3333', '08:00-22:00');

const pass = bcrypt.hashSync('password123', 10);
const insertUser = db.prepare('INSERT INTO users (id, company_id, branch_id, name, email, password_hash, role, pin_hash, multi_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
const adminId = id();
insertUser.run(adminId, companyId, branch1, 'Super Admin', 'admin@kopinusantara.id', pass, 'super_admin', bcrypt.hashSync('1234', 10), 1);
const managerId = id();
insertUser.run(managerId, companyId, branch1, 'Manager Jakarta', 'manager.jkt@kopinusantara.id', pass, 'manager', bcrypt.hashSync('2222', 10), 1);
const cashierId = id();
insertUser.run(cashierId, companyId, branch1, 'Kasir Jakarta', 'kasir.jkt@kopinusantara.id', pass, 'cashier', bcrypt.hashSync('1111', 10), 0);
const cashierBdg = id();
insertUser.run(cashierBdg, companyId, branch2, 'Kasir Bandung', 'kasir.bdg@kopinusantara.id', pass, 'cashier', bcrypt.hashSync('1112', 10), 0);
insertUser.run(id(), companyId, branch2, 'Manager Bandung', 'manager.bdg@kopinusantara.id', pass, 'manager', bcrypt.hashSync('2223', 10), 0);
insertUser.run(id(), companyId, branch3, 'Manager Surabaya', 'manager.sby@kopinusantara.id', pass, 'manager', bcrypt.hashSync('2224', 10), 0);

/* ------------------------------- SETTINGS ------------------------------- */
// Global defaults consumed by shift close (cash_tolerance) and checkout (tax).
const insertSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
const settings = {
  cash_tolerance: '5000',
  tax_percent: '0',
  currency: 'IDR',
  locale: 'id-ID',
  receipt_footer: 'Terima kasih atas kunjungan Anda!',
  low_stock_default: '10'
};
for (const [k, v] of Object.entries(settings)) insertSetting.run(k, v);

const catKopi = id();
const catNonKopi = id();
const catMakanan = id();
const insertCat = db.prepare('INSERT INTO categories (id, company_id, name) VALUES (?, ?, ?)');
insertCat.run(catKopi, companyId, 'Kopi');
insertCat.run(catNonKopi, companyId, 'Non-Kopi');
insertCat.run(catMakanan, companyId, 'Makanan');

const products = [
  { name: 'Espresso', cat: catKopi, sku: 'KOP-001', cost: 5000, price: 18000 },
  { name: 'Americano', cat: catKopi, sku: 'KOP-002', cost: 6000, price: 22000 },
  { name: 'Cappuccino', cat: catKopi, sku: 'KOP-003', cost: 8000, price: 28000 },
  { name: 'Latte', cat: catKopi, sku: 'KOP-004', cost: 8500, price: 30000 },
  { name: 'Kopi Susu Gula Aren', cat: catKopi, sku: 'KOP-005', cost: 9000, price: 32000 },
  { name: 'Matcha Latte', cat: catNonKopi, sku: 'NKP-001', cost: 10000, price: 30000 },
  { name: 'Chocolate', cat: catNonKopi, sku: 'NKP-002', cost: 7000, price: 25000 },
  { name: 'Teh Tarik', cat: catNonKopi, sku: 'NKP-003', cost: 5000, price: 18000 },
  { name: 'Croissant', cat: catMakanan, sku: 'MKN-001', cost: 8000, price: 20000 },
  { name: 'Roti Bakar', cat: catMakanan, sku: 'MKN-002', cost: 6000, price: 15000 },
  { name: 'French Fries', cat: catMakanan, sku: 'MKN-003', cost: 9000, price: 22000 }
];

const insertProd = db.prepare(`INSERT INTO products (id, company_id, category_id, name, sku, cost_price, default_price, unit)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'pcs')`);
const prodIds = [];
for (const p of products) {
  const pid = id();
  prodIds.push(pid);
  insertProd.run(pid, companyId, p.cat, p.name, p.sku, p.cost, p.price);
}

/* ------------------------------ VARIANTS ------------------------------ */
// Size / temperature options for the coffee line — exercises variant pricing.
const insertVariant = db.prepare(
  `INSERT INTO product_variants (id, company_id, product_id, name, variant_type, price_adjustment, is_default, sort_order)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const variantSpec = {
  0: [ // Espresso
    ['Single', 'Shot', 0, 1], ['Double', 'Shot', 4000, 0]
  ],
  1: [ // Americano
    ['Regular', 'Ukuran', 0, 1], ['Large', 'Ukuran', 5000, 0]
  ],
  2: [ // Cappuccino
    ['Regular', 'Ukuran', 0, 1], ['Large', 'Ukuran', 5000, 0]
  ],
  3: [ // Latte
    ['Regular', 'Ukuran', 0, 1], ['Large', 'Ukuran', 6000, 0],
    ['Hot', 'Suhu', 0, 1], ['Iced', 'Suhu', 3000, 0]
  ],
  4: [ // Kopi Susu Gula Aren
    ['Regular', 'Ukuran', 0, 1], ['Jumbo', 'Ukuran', 8000, 0]
  ]
};
for (const [idx, variants] of Object.entries(variantSpec)) {
  variants.forEach(([name, type, adj, isDefault], i) => {
    insertVariant.run(id(), companyId, prodIds[idx], name, type, adj, isDefault, i);
  });
}

const insertStock = db.prepare('INSERT INTO branch_stocks (id, branch_id, product_id, quantity, low_stock_threshold) VALUES (?, ?, ?, ?, ?)');
for (const b of [branch1, branch2, branch3]) {
  for (const p of prodIds) {
    insertStock.run(id(), b, p, Math.floor(Math.random() * 80) + 20, 10);
  }
}

const insertBP = db.prepare('INSERT INTO branch_products (id, branch_id, product_id, price_override, is_available) VALUES (?, ?, ?, ?, ?)');
insertBP.run(id(), branch2, prodIds[3], 32000, 1);

const branchUsers = { [branch1]: cashierId, [branch2]: managerId, [branch3]: adminId };

function makeTx(branchId, userId, daysAgo) {
  const nItems = Math.floor(Math.random() * 3) + 1;
  const chosen = [];
  for (let i = 0; i < nItems; i++) {
    chosen.push({ prodId: prodIds[Math.floor(Math.random() * prodIds.length)], qty: Math.floor(Math.random() * 3) + 1 });
  }
  const txId = id();
  let subtotal = 0;
  const prepared = chosen.map((c) => {
    const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(c.prodId);
    const line = prod.default_price * c.qty;
    subtotal += line;
    return { prod, qty: c.qty, line };
  });
  db.prepare(`INSERT INTO transactions (id, company_id, branch_id, user_id, code, subtotal, total, payment_method, cash_received, change_due, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'cash', ?, 0, datetime('now', ?))`)
    .run(txId, companyId, branchId, userId, 'TRX-' + Math.random().toString(36).slice(2, 8).toUpperCase(), subtotal, subtotal, subtotal, `-${daysAgo} days`);
  for (const p of prepared) {
    db.prepare(`INSERT INTO transaction_items (id, transaction_id, product_id, product_name, price, cost_price, quantity, subtotal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id(), txId, p.prod.id, p.prod.name, p.prod.default_price, p.prod.cost_price, p.qty, p.line);
  }
}

for (let d = 0; d < 30; d++) {
  const count = Math.floor(Math.random() * 5) + 1;
  for (let i = 0; i < count; i++) {
    const b = [branch1, branch2, branch3][Math.floor(Math.random() * 3)];
    makeTx(b, branchUsers[b], d);
  }
}

/* ------------------------------- SHIFTS ------------------------------- */
// One closed shift per branch covering the seeded history, plus an open shift today.
const insertShift = db.prepare(
  `INSERT INTO shifts (id, branch_id, user_id, opening_cash, closing_cash, expected_cash, cash_difference,
     opened_at, closed_at, status, cash_sales, non_cash_sales, note)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
for (const b of [branch1, branch2, branch3]) {
  const cashTotal = db
    .prepare("SELECT COALESCE(SUM(total),0) AS t FROM transactions WHERE branch_id = ? AND payment_method = 'cash' AND status = 'completed'")
    .get(b).t;
  insertShift.run(
    id(), b, branchUsers[b], 500000, 500000 + cashTotal, 500000 + cashTotal, 0,
    nowSql(), nowSql(), 'closed', cashTotal, 0, 'Shift demo (seed)'
  );
}
insertShift.run(
  id(), branch1, cashierId, 300000, null, 300000, null,
  nowSql(), null, 'open', 0, 0, null
);

/* ----------------------------- HOLD ORDERS ---------------------------- */
const insertHold = db.prepare(
  'INSERT INTO hold_orders (id, company_id, branch_id, user_id, label, subtotal, discount, tax, total, note) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)'
);
insertHold.run(id(), companyId, branch1, cashierId, 'Meja 3 - 2 org', 50000, 50000, 'Menunggu teman');
insertHold.run(id(), companyId, branch2, cashierBdg, 'Take away - Budi', 32000, 32000, null);

/* ------------------------------- DEVICES ------------------------------ */
const insertDevice = db.prepare(
  'INSERT INTO devices (id, branch_id, name, identifier, is_active, app_version, platform, device_key) VALUES (?, ?, ?, ?, 1, ?, ?, ?)'
);
insertDevice.run(id(), branch1, 'Kasir Depan 1', 'POS-JKT-01', '1.0.0', 'tauri-windows', id());
insertDevice.run(id(), branch1, 'Kasir Depan 2', 'POS-JKT-02', '1.0.0', 'tauri-windows', id());
insertDevice.run(id(), branch2, 'Kasir Bandung 1', 'POS-BDG-01', '1.0.0', 'tauri-macos', id());

console.log('\n=== Demo accounts (password: password123) ===');
console.log('Super Admin : admin@kopinusantara.id');
console.log('Manager     : manager.jkt@kopinusantara.id');
console.log('Kasir       : kasir.jkt@kopinusantara.id');
console.log('==============================================\n');
console.log('Seed complete.');