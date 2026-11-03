import express from 'express';
import { db } from '../db.js';
import { authRequired, requirePermission, audit, assertBranchAccess } from '../auth.js';
import { id, wrap, badRequest } from '../lib/helpers.js';
import { priceCart, persistTransaction, stockPolicy, stockShortfalls } from '../lib/transactions.js';

const router = express.Router();

const logSync = (row) =>
  db
    .prepare('INSERT INTO sync_queue (id, company_id, branch_id, kind, client_uuid, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id(), row.companyId, row.branchId, row.kind || 'transaction', row.clientUuid, row.status, row.detail ? JSON.stringify(row.detail) : null);

/**
 * POST /sync/batch
 * Body: { branch_id, device_id, transactions: [ {client_uuid, created_at, items, ...} ] }
 *
 * Offline-first replay. Each row is processed independently so one bad item never
 * blocks the rest of the batch:
 *   applied  -> inserted (or already present thanks to the client_uuid idempotency key)
 *   conflict -> replay would push branch stock negative
 *   rejected -> payload invalid (missing items, unparseable cart)
 */
router.post('/sync/batch', authRequired, wrap((req, res) => {
  const { branch_id, device_id, transactions = [] } = req.body;
  if (!branch_id) return badRequest(res, 'branch_id required');
  if (!assertBranchAccess(req, res, branch_id)) return;
  if (!Array.isArray(transactions) || !transactions.length) return badRequest(res, 'transactions required');

  const results = [];
  for (const tx of transactions) {
    const uuid = tx.client_uuid;
    if (!uuid) {
      results.push({ client_uuid: null, status: 'rejected', error: 'client_uuid required' });
      continue;
    }
    const seen = db.prepare('SELECT * FROM sync_queue WHERE client_uuid = ?').get(uuid);
    // `applied` is terminal: that sale already exists, so replaying it returns the
    // original result and never double-charges. A `conflict`/`rejected` is only a
    // past verdict — re-evaluate it, because the cause (usually stock) may have
    // been fixed since. Replaying the memo forever would strand the sale.
    if (seen && seen.status === 'applied') {
      let detail = null;
      try {
        detail = seen.detail ? JSON.parse(seen.detail) : null;
      } catch {
        detail = null;
      }
      results.push({
        client_uuid: uuid,
        status: 'applied',
        transaction_id: detail && detail.transaction_id,
        code: detail && detail.code,
        duplicate: true
      });
      continue;
    }
    if (seen) {
      // Clear the stale refusal so the attempt below can record a fresh verdict.
      db.prepare('DELETE FROM sync_queue WHERE id = ?').run(seen.id);
    }

    const priced = priceCart({
      companyId: req.user.company_id,
      branchId: branch_id,
      items: tx.items,
      discount: tx.discount,
      taxPercent: tx.tax_percent,
      paymentMethod: tx.payment_method || 'cash',
      cashReceived: tx.cash_received,
      payments: tx.payments
    });

    if (priced.error) {
      logSync({ companyId: req.user.company_id, branchId: branch_id, clientUuid: uuid, status: 'rejected', detail: { error: priced.error } });
      results.push({ client_uuid: uuid, status: 'rejected', error: priced.error });
      continue;
    }

    // Conflict detection: replaying the sale would push branch stock below zero.
    //
    // This is the only stock guard that existed before the checkout policy was
    // added, and it applies whichever mode is configured — an offline replay is
    // reconciled after the fact, so 'warn' cannot be honoured by showing a toast
    // to a cashier who has already gone home. 'ignore' is the one mode that turns
    // it off, because a shop that does not track stock must not have every replay
    // parked in the conflict queue.
    const policy = stockPolicy();
    const shortfalls = policy === 'ignore' ? [] : stockShortfalls({ branchId: branch_id, prepared: priced.prepared });

    if (shortfalls.length) {
      const detail = { error: 'Stok tidak cukup saat sinkronisasi', shortfalls };
      logSync({ companyId: req.user.company_id, branchId: branch_id, clientUuid: uuid, status: 'conflict', detail });
      results.push({ client_uuid: uuid, status: 'conflict', ...detail });
      continue;
    }

    try {
      const { id: txId, duplicate } = persistTransaction({
        companyId: req.user.company_id,
        branchId: branch_id,
        userId: req.user.sub,
        deviceId: device_id || null,
        client: {
          totals: priced.totals,
          prepared: priced.prepared,
          payment_method: tx.payment_method || 'cash',
          note: tx.note,
          client_uuid: uuid,
          created_at: tx.created_at,
          order_label: tx.order_label,
          table_number: tx.table_number,
          customer_name: tx.customer_name,
          code: tx.code,
          offline: true
        }
      });
      logSync({ companyId: req.user.company_id, branchId: branch_id, clientUuid: uuid, status: 'applied', detail: { transaction_id: txId, code: tx.code || null } });
      results.push({ client_uuid: uuid, status: 'applied', transaction_id: txId, code: tx.code || null, duplicate });
    } catch (e) {
      logSync({ companyId: req.user.company_id, branchId: branch_id, clientUuid: uuid, status: 'rejected', detail: { error: e.message } });
      results.push({ client_uuid: uuid, status: 'rejected', error: e.message });
    }
  }

  const applied = results.filter((r) => r.status === 'applied').length;
  const conflicts = results.filter((r) => r.status === 'conflict').length;
  const rejected = results.filter((r) => r.status === 'rejected').length;
  audit({
    company_id: req.user.company_id, branch_id, user_id: req.user.sub, action: 'sync.batch',
    entity: 'sync_queue', entity_id: null,
    detail: { total: results.length, applied, conflicts, rejected }, ip: req.ip
  });
  res.json({ total: results.length, applied, conflicts, rejected, results });
}));

/** GET /sync/status — queue health for the current branch (sync badge). */
router.get('/sync/status', authRequired, wrap((req, res) => {
  const params = [req.user.company_id];
  let where = 'company_id = ?';
  if (req.query.branch_id) {
    if (!assertBranchAccess(req, res, req.query.branch_id)) return;
    where += ' AND branch_id = ?';
    params.push(req.query.branch_id);
  }
  const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM sync_queue WHERE ${where} GROUP BY status`).all(...params);
  const last = db
    .prepare(`SELECT client_uuid, status, detail, created_at FROM sync_queue WHERE ${where} ORDER BY created_at DESC LIMIT 1`)
    .get(...params);
  res.json({
    counts: Object.fromEntries(rows.map((r) => [r.status, r.n])),
    last_sync_at: last ? last.created_at : null,
    last
  });
}));

/** GET /sync/conflicts — rows that need manual review. */
router.get('/sync/conflicts', authRequired, wrap((req, res) => {
  const rows = db
    .prepare("SELECT * FROM sync_queue WHERE company_id = ? AND status <> 'applied' ORDER BY created_at DESC LIMIT 200")
    .all(req.user.company_id);
  res.json(
    rows.map((r) => {
      let detail = null;
      try {
        detail = r.detail ? JSON.parse(r.detail) : null;
      } catch {
        detail = null;
      }
      return { ...r, detail };
    })
  );
}));

/** GET /sync/bootstrap — full offline snapshot for a branch (catalog + stock + settings). */
router.get('/sync/bootstrap', authRequired, wrap((req, res) => {
  const { branch_id } = req.query;
  if (!branch_id) return badRequest(res, 'branch_id required');
  if (!assertBranchAccess(req, res, branch_id)) return;
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.user.company_id) || {};
  const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(branch_id) || {};
  const products = db
    .prepare(
      `SELECT p.id, p.name, p.sku, p.barcode, p.category_id, p.unit, p.image_url,
              COALESCE(bp.price_override, p.default_price) AS price,
              COALESCE(bs.quantity, 0) AS stock, COALESCE(bs.low_stock_threshold, 5) AS low_stock_threshold
       FROM products p
       LEFT JOIN branch_products bp ON bp.product_id = p.id AND bp.branch_id = ?
       LEFT JOIN branch_stocks bs ON bs.product_id = p.id AND bs.branch_id = ?
       WHERE p.company_id = ? AND p.is_active = 1 AND COALESCE(bp.is_available, 1) = 1
       ORDER BY p.name`
    )
    .all(branch_id, branch_id, req.user.company_id);
  const variants = db
    .prepare(
      `SELECT v.* FROM product_variants v JOIN products p ON p.id = v.product_id
       WHERE p.company_id = ? AND v.is_active = 1 ORDER BY v.sort_order`
    )
    .all(req.user.company_id);
  const categories = db.prepare('SELECT * FROM categories WHERE company_id = ? ORDER BY name').all(req.user.company_id);
  res.json({
    synced_at: new Date().toISOString(),
    company: { id: company.id, name: company.name, currency: company.currency || 'IDR', tax_percent: company.tax_percent || 0 },
    branch: { id: branch.id, name: branch.name, address: branch.address, phone: branch.phone },
    categories,
    products: products.map((p) => ({ ...p, variants: variants.filter((v) => v.product_id === p.id) })),
    settings: Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((s) => [s.key, s.value]))
  });
}));

/**
 * GET /sync/pin-users?branch_id=
 *
 * PIN hashes for a branch, so a desktop till can verify PINs locally when the
 * internet drops. This is the only place a `pin_hash` leaves the cloud.
 *
 * Guarded tighter than the public /auth/pin-users list: it needs a real session
 * (authRequired), a branch the caller may access, and `device.manage`.
 *
 * `device.manage` is not decoration. A bcrypt hash of a 4-digit PIN has only
 * 10,000 candidates, so handing one out is equivalent to handing out the PIN —
 * and a PIN authorises manager-level actions (void approval, cash handover).
 * Without the permission check any cashier could pull a manager's hash from
 * their own low-privilege session and crack it offline. Provisioning a till is a
 * device-management action, so it is gated like one.
 */
router.get('/sync/pin-users', authRequired, requirePermission('device.manage'), wrap((req, res) => {
  const { branch_id } = req.query;
  if (!branch_id) return badRequest(res, 'branch_id required');
  if (!assertBranchAccess(req, res, branch_id)) return;

  const rows = db
    .prepare(
      `SELECT id, company_id, branch_id, name, email, role, avatar_url, pin_hash
       FROM users
       WHERE branch_id = ? AND is_active = 1 AND pin_hash IS NOT NULL
       ORDER BY name`
    )
    .all(branch_id);

  res.json(rows);
}));

export default router;

