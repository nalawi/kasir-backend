import express from 'express';
import { db } from '../db.js';
import { authRequired, assertBranchAccess } from '../auth.js';
import { id, wrap, badRequest, notFound, money } from '../lib/helpers.js';

const router = express.Router();

function loadHold(hid, companyId) {
  const h = db.prepare('SELECT * FROM hold_orders WHERE id = ? AND company_id = ?').get(hid, companyId);
  if (!h) return null;
  h.items = db.prepare('SELECT * FROM hold_order_items WHERE hold_order_id = ?').all(h.id);
  h.branch_name = db.prepare('SELECT name FROM branches WHERE id = ?').get(h.branch_id)?.name;
  h.cashier_name = db.prepare('SELECT name FROM users WHERE id = ?').get(h.user_id)?.name;
  return h;
}

/** GET /branches/:branchId/holds — parked carts for the current outlet. */
router.get('/branches/:branchId/holds', authRequired, wrap((req, res) => {
  if (!assertBranchAccess(req, res, req.params.branchId)) return;
  const rows = db
    .prepare(
      `SELECT h.*, u.name AS cashier_name,
              (SELECT COUNT(*) FROM hold_order_items i WHERE i.hold_order_id = h.id) AS item_count
       FROM hold_orders h LEFT JOIN users u ON u.id = h.user_id
       WHERE h.branch_id = ? AND h.company_id = ? ORDER BY h.created_at DESC LIMIT 100`
    )
    .all(req.params.branchId, req.user.company_id);
  res.json(rows);
}));

router.get('/holds/:id', authRequired, wrap((req, res) => {
  const h = loadHold(req.params.id, req.user.company_id);
  if (!h) return notFound(res, 'Hold order not found');
  if (!assertBranchAccess(req, res, h.branch_id)) return;
  res.json(h);
}));

/** POST /holds — park the current cart (order label / table number). */
router.post('/holds', authRequired, wrap((req, res) => {
  const { branch_id, items = [], label, note, discount = 0, tax = 0 } = req.body;
  if (!branch_id) return badRequest(res, 'branch_id required');
  if (!assertBranchAccess(req, res, branch_id)) return;
  if (!Array.isArray(items) || !items.length) return badRequest(res, 'items required');

  const hid = id();
  let subtotal = 0;
  const prepared = items.map((it) => {
    const prod = db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(it.product_id, req.user.company_id);
    const price = money(Number(it.price) || (prod ? prod.default_price : 0));
    const qty = Number(it.quantity) || 1;
    const lineDisc = money(Number(it.discount) || 0);
    subtotal = money(subtotal + price * qty - lineDisc);
    return {
      product_id: it.product_id || null,
      product_name: it.product_name || (prod ? prod.name : 'Item'),
      variant_label: it.variant_label || null,
      price,
      quantity: qty,
      discount: lineDisc,
      note: it.note || null
    };
  });
  const total = money(subtotal - (Number(discount) || 0) + (Number(tax) || 0));

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO hold_orders (id, company_id, branch_id, user_id, label, subtotal, discount, tax, total, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(hid, req.user.company_id, branch_id, req.user.sub, label || null, subtotal, Number(discount) || 0, Number(tax) || 0, total, note || null);
    const stmt = db.prepare(
      'INSERT INTO hold_order_items (id, hold_order_id, product_id, product_name, variant_label, price, quantity, discount, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const p of prepared) {
      stmt.run(id(), hid, p.product_id, p.product_name, p.variant_label, p.price, p.quantity, p.discount, p.note);
    }
  });
  run();
  res.status(201).json(loadHold(hid, req.user.company_id));
}));

/** PUT /holds/:id — update a parked cart (add/remove items before resuming). */
router.put('/holds/:id', authRequired, wrap((req, res) => {
  const h = loadHold(req.params.id, req.user.company_id);
  if (!h) return notFound(res, 'Hold order not found');
  if (!assertBranchAccess(req, res, h.branch_id)) return;
  const { items, label, note, discount, tax } = req.body;
  const run = db.transaction(() => {
    if (Array.isArray(items)) {
      db.prepare('DELETE FROM hold_order_items WHERE hold_order_id = ?').run(h.id);
      let subtotal = 0;
      const stmt = db.prepare(
        'INSERT INTO hold_order_items (id, hold_order_id, product_id, product_name, variant_label, price, quantity, discount, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      for (const it of items) {
        const price = money(Number(it.price) || 0);
        const qty = Number(it.quantity) || 1;
        const lineDisc = money(Number(it.discount) || 0);
        subtotal = money(subtotal + price * qty - lineDisc);
        stmt.run(id(), h.id, it.product_id || null, it.product_name || 'Item', it.variant_label || null, price, qty, lineDisc, it.note || null);
      }
      const disc = discount === undefined ? h.discount : Number(discount) || 0;
      const taxAmt = tax === undefined ? h.tax : Number(tax) || 0;
      db.prepare('UPDATE hold_orders SET subtotal = ?, discount = ?, tax = ?, total = ? WHERE id = ?')
        .run(subtotal, disc, taxAmt, money(subtotal - disc + taxAmt), h.id);
    }
    if (label !== undefined) db.prepare('UPDATE hold_orders SET label = ? WHERE id = ?').run(label, h.id);
    if (note !== undefined) db.prepare('UPDATE hold_orders SET note = ? WHERE id = ?').run(note, h.id);
  });
  run();
  res.json(loadHold(h.id, req.user.company_id));
}));

/** DELETE /holds/:id — discard a parked cart (or after it was resumed into a sale). */
router.delete('/holds/:id', authRequired, wrap((req, res) => {
  const h = loadHold(req.params.id, req.user.company_id);
  if (!h) return notFound(res, 'Hold order not found');
  if (!assertBranchAccess(req, res, h.branch_id)) return;
  db.prepare('DELETE FROM hold_orders WHERE id = ?').run(h.id);
  res.json({ ok: true });
}));

export default router;
