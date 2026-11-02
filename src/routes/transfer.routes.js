import express from 'express';
import { db } from '../db.js';
import { authRequired, requirePermission, audit, scopedBranchIds } from '../auth.js';
import { id, wrap, badRequest, notFound, applyStockDelta } from '../lib/helpers.js';

const router = express.Router();

export function loadTransfer(tid, companyId) {
  const t = db.prepare('SELECT * FROM stock_transfers WHERE id = ? AND company_id = ?').get(tid, companyId);
  if (!t) return null;
  t.items = db
    .prepare(
      `SELECT sti.*, p.name AS product_name, p.sku FROM stock_transfer_items sti
       JOIN products p ON p.id = sti.product_id WHERE sti.transfer_id = ?`
    )
    .all(t.id);
  t.from_branch_name = db.prepare('SELECT name FROM branches WHERE id = ?').get(t.from_branch_id)?.name;
  t.to_branch_name = db.prepare('SELECT name FROM branches WHERE id = ?').get(t.to_branch_id)?.name;
  return t;
}

router.get('/transfers', authRequired, requirePermission('stock.transfer', 'stock.manage', 'report.view_all'), wrap((req, res) => {
  const scope = scopedBranchIds(req);
  const { status } = req.query;
  const conds = ['t.company_id = ?'];
  const params = [req.user.company_id];
  if (status) {
    conds.push('t.status = ?');
    params.push(status);
  }
  if (!req.permissions.includes('report.view_all')) {
    const ph = scope.map(() => '?').join(',') || 'NULL';
    conds.push(`(t.from_branch_id IN (${ph}) OR t.to_branch_id IN (${ph}))`);
    params.push(...scope, ...scope);
  }
  const rows = db
    .prepare(
      `SELECT t.*, bf.name AS from_branch_name, bt.name AS to_branch_name,
        (SELECT COUNT(*) FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS item_count
       FROM stock_transfers t
       JOIN branches bf ON bf.id = t.from_branch_id
       JOIN branches bt ON bt.id = t.to_branch_id
       WHERE ${conds.join(' AND ')} ORDER BY t.created_at DESC LIMIT 200`
    )
    .all(...params);
  res.json(rows);
}));

router.get('/transfers/:id', authRequired, wrap((req, res) => {
  const t = loadTransfer(req.params.id, req.user.company_id);
  if (!t) return notFound(res);
  res.json(t);
}));

// Create a transfer request (status: requested).
router.post('/transfers', authRequired, requirePermission('stock.transfer', 'stock.manage'), wrap((req, res) => {
  const { from_branch_id, to_branch_id, items = [], note } = req.body;
  if (!from_branch_id || !to_branch_id) return badRequest(res, 'from_branch_id & to_branch_id required');
  if (from_branch_id === to_branch_id) return badRequest(res, 'Cabang asal dan tujuan tidak boleh sama');
  if (!Array.isArray(items) || !items.length) return badRequest(res, 'items required');
  const branches = db
    .prepare('SELECT id FROM branches WHERE company_id = ? AND id IN (?, ?)')
    .all(req.user.company_id, from_branch_id, to_branch_id);
  if (branches.length !== 2) return badRequest(res, 'Cabang tidak valid');

  const tid = id();
  const code = 'TRF-' + Date.now().toString(36).toUpperCase();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO stock_transfers (id, company_id, code, from_branch_id, to_branch_id, status, note, requested_by)
       VALUES (?, ?, ?, ?, ?, 'requested', ?, ?)`
    ).run(tid, req.user.company_id, code, from_branch_id, to_branch_id, note || null, req.user.sub);
    const stmt = db.prepare('INSERT INTO stock_transfer_items (id, transfer_id, product_id, quantity) VALUES (?, ?, ?, ?)');
    for (const it of items) {
      if (!it.product_id || !it.quantity) continue;
      stmt.run(id(), tid, it.product_id, Number(it.quantity));
    }
  });
  tx();
  audit({ company_id: req.user.company_id, branch_id: from_branch_id, user_id: req.user.sub, action: 'transfer.request', entity: 'stock_transfer', entity_id: tid, detail: { from_branch_id, to_branch_id, items: items.length }, ip: req.ip });
  res.status(201).json(loadTransfer(tid, req.user.company_id));
}));

// requested -> approved
router.post('/transfers/:id/approve', authRequired, requirePermission('stock.transfer'), wrap((req, res) => {
  const t = loadTransfer(req.params.id, req.user.company_id);
  if (!t) return notFound(res);
  if (t.status !== 'requested') return badRequest(res, `Status tidak valid: ${t.status}`);
  db.prepare("UPDATE stock_transfers SET status = 'approved', approved_by = ? WHERE id = ?").run(req.user.sub, t.id);
  audit({ company_id: req.user.company_id, branch_id: t.from_branch_id, user_id: req.user.sub, action: 'transfer.approve', entity: 'stock_transfer', entity_id: t.id, ip: req.ip });
  res.json(loadTransfer(t.id, req.user.company_id));
}));

// approved -> shipped (deducts stock at the origin branch)
router.post('/transfers/:id/ship', authRequired, requirePermission('stock.transfer'), wrap((req, res) => {
  const t = loadTransfer(req.params.id, req.user.company_id);
  if (!t) return notFound(res);
  if (!['approved', 'requested'].includes(t.status)) return badRequest(res, `Status tidak valid: ${t.status}`);
  const tx = db.transaction(() => {
    for (const it of t.items) {
      applyStockDelta({
        branchId: t.from_branch_id, productId: it.product_id, delta: -it.quantity,
        type: 'transfer_out', referenceId: t.id, note: `Transfer ke ${t.to_branch_name}`, userId: req.user.sub
      });
    }
    db.prepare("UPDATE stock_transfers SET status = 'shipped', shipped_at = datetime('now') WHERE id = ?").run(t.id);
  });
  tx();
  audit({ company_id: req.user.company_id, branch_id: t.from_branch_id, user_id: req.user.sub, action: 'transfer.ship', entity: 'stock_transfer', entity_id: t.id, ip: req.ip });
  res.json(loadTransfer(t.id, req.user.company_id));
}));

// shipped -> received (adds stock at the destination; supports partial quantities)
router.post('/transfers/:id/receive', authRequired, requirePermission('stock.transfer', 'stock.manage'), wrap((req, res) => {
  const t = loadTransfer(req.params.id, req.user.company_id);
  if (!t) return notFound(res);
  if (t.status !== 'shipped') return badRequest(res, 'Transfer belum dikirim');
  const receivedMap = new Map((req.body.items || []).map((i) => [i.id, Number(i.received_quantity)]));
  const tx = db.transaction(() => {
    for (const it of t.items) {
      const recv = receivedMap.has(it.id) ? receivedMap.get(it.id) : it.quantity;
      db.prepare('UPDATE stock_transfer_items SET received_quantity = ? WHERE id = ?').run(recv, it.id);
      if (recv > 0) {
        applyStockDelta({
          branchId: t.to_branch_id, productId: it.product_id, delta: recv,
          type: 'transfer_in', referenceId: t.id, note: `Transfer dari ${t.from_branch_name}`, userId: req.user.sub
        });
      }
      // Record shrinkage so the origin branch ledger stays balanced.
      if (recv < it.quantity) {
        applyStockDelta({
          branchId: t.from_branch_id, productId: it.product_id, delta: -(it.quantity - recv),
          type: 'transfer_loss', referenceId: t.id, note: 'Selisih saat penerimaan', userId: req.user.sub
        });
      }
    }
    db.prepare("UPDATE stock_transfers SET status = 'received', received_at = datetime('now') WHERE id = ?").run(t.id);
  });
  tx();
  audit({ company_id: req.user.company_id, branch_id: t.to_branch_id, user_id: req.user.sub, action: 'transfer.receive', entity: 'stock_transfer', entity_id: t.id, ip: req.ip });
  res.json(loadTransfer(t.id, req.user.company_id));
}));

router.post('/transfers/:id/reject', authRequired, requirePermission('stock.transfer'), wrap((req, res) => {
  const t = loadTransfer(req.params.id, req.user.company_id);
  if (!t) return notFound(res);
  if (!['requested', 'approved'].includes(t.status)) return badRequest(res, 'Transfer sudah diproses');
  db.prepare("UPDATE stock_transfers SET status = 'rejected', rejected_reason = ? WHERE id = ?").run(req.body.reason || null, t.id);
  audit({ company_id: req.user.company_id, branch_id: t.from_branch_id, user_id: req.user.sub, action: 'transfer.reject', entity: 'stock_transfer', entity_id: t.id, detail: { reason: req.body.reason }, ip: req.ip });
  res.json(loadTransfer(t.id, req.user.company_id));
}));

export default router;

