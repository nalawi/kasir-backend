import express from 'express';
import { db } from '../db.js';
import { authRequired, requirePermission, audit, assertBranchAccess, scopedBranchIds } from '../auth.js';
import { id, wrap, badRequest, notFound, applyStockDelta } from '../lib/helpers.js';

const router = express.Router();

/* ------------------------------- STOCK -------------------------------- */

// Stock lines for one branch.
//
// Driven from `products`, not from `branch_stocks`. A stock row is created
// lazily — by the first sale, the first adjust or the first opname — so a
// product that has just been created has no row yet. An INNER JOIN from
// `branch_stocks` therefore hid every new product from the stock page, and from
// the opname sheet, which is exactly where you go to give it an opening
// quantity. A missing row means "zero on hand", which is also what
// `stockShortfalls()` assumes at checkout, so the two now agree.
//
// A deleted product must disappear from this list. The first version of the
// LEFT JOIN fix kept a line whenever `bs.id IS NOT NULL`, meaning "this product
// has a stock row" — but a row is created by the first sale, adjust or opname and
// then survives the delete, so a product that had ever been touched stayed on the
// stock page after being deleted. The row's quantity is what matters, not its
// existence: `COALESCE(bs.quantity, 0) <> 0` keeps a deleted product only while it
// still holds stock (so the quantity is not stranded off-screen) and drops it once
// the count is zero. `<> 0` rather than `> 0` because negative stock is a real
// state here — `allow_negative_stock` can leave a line below zero, and hiding it
// would make the shortfall impossible to find and correct.
router.get('/branches/:branchId/stock', authRequired, wrap((req, res) => {
  if (!assertBranchAccess(req, res, req.params.branchId)) return;
  const rows = db
    .prepare(
      `SELECT bs.id, bs.branch_id, p.id AS product_id, p.name AS product_name,
              p.sku, p.unit, p.default_price, bs.updated_at,
              COALESCE(bs.quantity, 0) AS quantity,
              COALESCE(bs.low_stock_threshold, 5) AS low_stock_threshold,
              CASE WHEN COALESCE(bs.quantity, 0) <= COALESCE(bs.low_stock_threshold, 5)
                   THEN 1 ELSE 0 END AS is_low
       FROM products p
       LEFT JOIN branch_stocks bs ON bs.product_id = p.id AND bs.branch_id = ?
       WHERE p.company_id = ? AND (p.is_active = 1 OR COALESCE(bs.quantity, 0) <> 0)
       ORDER BY p.name`
    )
    .all(req.params.branchId, req.user.company_id);
  res.json(rows);
}));

// Consolidated matrix: every product x every branch in the user's scope.
router.get('/stock/overview', authRequired, requirePermission('stock.view', 'stock.manage', 'report.view_all'), wrap((req, res) => {
  const scope = scopedBranchIds(req);
  if (!scope.length) return res.json({ branches: [], products: [], rows: [] });
  const ph = scope.map(() => '?').join(',');
  const branches = db.prepare(`SELECT id, name FROM branches WHERE id IN (${ph}) ORDER BY name`).all(...scope);
  const products = db
    .prepare('SELECT id, name, sku, unit FROM products WHERE company_id = ? AND is_active = 1 ORDER BY name')
    .all(req.user.company_id);
  const rows = db
    .prepare(
      `SELECT bs.branch_id, bs.product_id, bs.quantity, bs.low_stock_threshold,
              CASE WHEN bs.quantity <= bs.low_stock_threshold THEN 1 ELSE 0 END AS is_low
       FROM branch_stocks bs JOIN products p ON p.id = bs.product_id
       WHERE p.company_id = ? AND bs.branch_id IN (${ph})`
    )
    .all(req.user.company_id, ...scope);
  res.json({ branches, products, rows });
}));

// Low stock alert feed (sidebar badge + dashboard widget).
router.get('/stock/low', authRequired, wrap((req, res) => {
  const scope = scopedBranchIds(req);
  if (!scope.length) return res.json([]);
  const rows = db
    .prepare(
      `SELECT bs.branch_id, b.name AS branch_name, bs.product_id, p.name AS product_name, p.sku,
              bs.quantity, bs.low_stock_threshold
       FROM branch_stocks bs
       JOIN branches b ON b.id = bs.branch_id
       JOIN products p ON p.id = bs.product_id
       WHERE bs.quantity <= bs.low_stock_threshold AND p.is_active = 1
         AND bs.branch_id IN (${scope.map(() => '?').join(',')})
       ORDER BY (bs.quantity - bs.low_stock_threshold) ASC LIMIT 100`
    )
    .all(...scope);
  res.json(rows);
}));

router.get('/branches/:branchId/movements', authRequired, wrap((req, res) => {
  if (!assertBranchAccess(req, res, req.params.branchId)) return;
  const { product_id, type, limit = 100 } = req.query;
  const conds = ['sm.branch_id = ?'];
  const params = [req.params.branchId];
  if (product_id) {
    conds.push('sm.product_id = ?');
    params.push(product_id);
  }
  if (type) {
    conds.push('sm.type = ?');
    params.push(type);
  }
  params.push(Number(limit));
  res.json(
    db
      .prepare(
        `SELECT sm.*, p.name AS product_name, u.name AS user_name
         FROM stock_movements sm JOIN products p ON p.id = sm.product_id
         LEFT JOIN users u ON u.id = sm.user_id
         WHERE ${conds.join(' AND ')} ORDER BY sm.created_at DESC LIMIT ?`
      )
      .all(...params)
  );
}));

router.post('/branches/:branchId/stock/adjust', authRequired, requirePermission('stock.manage'), wrap((req, res) => {
  if (!assertBranchAccess(req, res, req.params.branchId)) return;
  const { product_id, quantity, type = 'add', note } = req.body; // type: set | add | subtract
  if (!product_id || quantity === undefined) return badRequest(res, 'product_id & quantity required');
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(product_id, req.user.company_id);
  if (!product) return notFound(res, 'Product not found');
  const row = db.prepare('SELECT * FROM branch_stocks WHERE branch_id = ? AND product_id = ?').get(req.params.branchId, product_id);
  const qty = Number(quantity) || 0;
  let delta;
  if (type === 'set') delta = qty - (row ? row.quantity : 0);
  else if (type === 'subtract') delta = -qty;
  else delta = qty;
  applyStockDelta({
    branchId: req.params.branchId, productId: product_id, delta,
    type: type === 'set' ? 'opname' : 'adjust', note: note || null, userId: req.user.sub
  });
  const updated = db.prepare('SELECT * FROM branch_stocks WHERE branch_id = ? AND product_id = ?').get(req.params.branchId, product_id);
  audit({ company_id: req.user.company_id, branch_id: req.params.branchId, user_id: req.user.sub, action: 'stock.adjust', entity: 'product', entity_id: product_id, detail: { type, quantity: qty, delta, note }, ip: req.ip });
  res.json({ product_id, quantity: updated.quantity, delta });
}));

// Stock opname: submit counted quantities; the system records the variance per line.
router.post('/branches/:branchId/stock/opname', authRequired, requirePermission('stock.manage'), wrap((req, res) => {
  if (!assertBranchAccess(req, res, req.params.branchId)) return;
  const { items = [], note } = req.body;
  if (!Array.isArray(items) || !items.length) return badRequest(res, 'items required');
  const results = [];
  const tx = db.transaction(() => {
    for (const it of items) {
      if (!it.product_id || it.counted === undefined) continue;
      const row = db.prepare('SELECT * FROM branch_stocks WHERE branch_id = ? AND product_id = ?').get(req.params.branchId, it.product_id);
      const before = row ? row.quantity : 0;
      const delta = Number(it.counted) - before;
      if (delta === 0) {
        results.push({ product_id: it.product_id, before, counted: Number(it.counted), delta: 0 });
        continue;
      }
      applyStockDelta({
        branchId: req.params.branchId, productId: it.product_id, delta, type: 'opname',
        note: note || 'Stok opname', userId: req.user.sub
      });
      results.push({ product_id: it.product_id, before, counted: Number(it.counted), delta });
    }
  });
  tx();
  audit({ company_id: req.user.company_id, branch_id: req.params.branchId, user_id: req.user.sub, action: 'stock.opname', entity: 'branch', entity_id: req.params.branchId, detail: { lines: results.length, note }, ip: req.ip });
  res.status(201).json({ lines: results });
}));

router.put('/branches/:branchId/stock/:productId/threshold', authRequired, requirePermission('stock.manage'), wrap((req, res) => {
  if (!assertBranchAccess(req, res, req.params.branchId)) return;
  const threshold = Number(req.body.low_stock_threshold);
  if (Number.isNaN(threshold)) return badRequest(res, 'low_stock_threshold required');
  const row = db.prepare('SELECT * FROM branch_stocks WHERE branch_id = ? AND product_id = ?').get(req.params.branchId, req.params.productId);
  if (row) db.prepare('UPDATE branch_stocks SET low_stock_threshold = ? WHERE id = ?').run(threshold, row.id);
  else
    db.prepare('INSERT INTO branch_stocks (id, branch_id, product_id, quantity, low_stock_threshold) VALUES (?, ?, ?, 0, ?)')
      .run(id(), req.params.branchId, req.params.productId, threshold);
  audit({ company_id: req.user.company_id, branch_id: req.params.branchId, user_id: req.user.sub, action: 'stock.threshold', entity: 'product', entity_id: req.params.productId, detail: { threshold }, ip: req.ip });
  res.json({ ok: true, low_stock_threshold: threshold });
}));

export default router;

