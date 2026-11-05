import express from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { authRequired, requirePermission, audit, assertBranchAccess, scopedBranchIds } from '../auth.js';
import { wrap, badRequest, notFound, money, txFilter, applyStockDelta, toIso } from '../lib/helpers.js';
import { priceCart, persistTransaction, getTransaction, stockPolicy, stockShortfalls } from '../lib/transactions.js';
import { isEdge } from '../edge.js';
import { enqueueOutbox } from '../lib/edgeOutbox.js';

const router = express.Router();

/**
 * Mark a stored timestamp as UTC on the way out.
 *
 * `transactions.created_at` holds `YYYY-MM-DD HH:MM:SS` in UTC, with no offset
 * marker. Sent as-is, every browser parses it as *local* wall-clock time, so a
 * till in Jakarta reads an 08:50 WIB sale (01:50 UTC) as 01:50 and prints a
 * receipt an hour and seven hours off. `toIso()` appends the `Z` that says
 * "this is UTC"; the client then formats it in the shop's timezone.
 *
 * Values that already carry `T`/`Z` (edge payloads, hand-built rows) pass through.
 */
function stamp(value) {
  return toIso(value);
}

/** Rewrite the timestamp columns of a transaction row so the client can trust them. */
function stampRow(row) {
  if (!row) return row;
  if (row.created_at) row.created_at = stamp(row.created_at);
  if (row.updated_at) row.updated_at = stamp(row.updated_at);
  if (row.voided_at) row.voided_at = stamp(row.voided_at);
  return row;
}


/** POST /transactions — live checkout from the POS screen. */
router.post('/transactions', authRequired, wrap((req, res) => {
  const { branch_id } = req.body;
  if (!branch_id) return badRequest(res, 'branch_id required');
  if (!assertBranchAccess(req, res, branch_id)) return;

  const priced = priceCart({
    companyId: req.user.company_id,
    branchId: branch_id,
    items: req.body.items,
    discount: req.body.discount,
    taxPercent: req.body.tax_percent,
    paymentMethod: req.body.payment_method || 'cash',
    cashReceived: req.body.cash_received,
    payments: req.body.payments
  });
  if (priced.error) return badRequest(res, priced.error);

  // Checkout (unlike /quote) must be fully paid: either split payments or cash tendered.
  const hasPayments = Array.isArray(req.body.payments) && req.body.payments.length > 0;
  const method = req.body.payment_method || 'cash';
  if (!hasPayments && (method === 'cash') && (req.body.cash_received === undefined || req.body.cash_received === null)) {
    return badRequest(res, 'cash_received atau payments wajib diisi untuk pembayaran tunai');
  }

  // Stock policy: 'block' throws a 409 from inside persistTransaction (the check
  // and the decrement must share one SQLite transaction). Translate it into the
  // same JSON shape /sync/batch uses for its conflict, so the UI has one shape to
  // handle. 'warn' returns shortfalls on the success path instead.
  let persisted;
  try {
    persisted = persistTransaction({
      companyId: req.user.company_id,
      branchId: branch_id,
      userId: req.user.sub,
      deviceId: req.body.device_id,
      client: {
        totals: priced.totals,
        prepared: priced.prepared,
        payment_method: req.body.payment_method || 'cash',
        note: req.body.note,
        client_uuid: req.body.client_uuid || null,
        order_label: req.body.order_label,
        table_number: req.body.table_number,
        customer_name: req.body.customer_name,
        reference_id: req.body.reference_id,
        code: req.body.code
      }
    });
  } catch (e) {
    if (e && e.code === 'INSUFFICIENT_STOCK') {
      return res.status(409).json({ error: e.message, code: e.code, shortfalls: e.shortfalls });
    }
    throw e;
  }
  const { id: txId, duplicate, stockShortfalls } = persisted;

  // Edge mode: the sale is real locally, but the cloud has not seen it yet. Copy
  // the replay payload into the outbox. This is the same shape POST /sync/batch
  // accepts, so the cloud applies it through the existing, idempotent path.
  // Skipped on duplicates (an order replayed twice must not be queued twice) and
  // on the cloud build, where the sale is already authoritative.
  if (isEdge() && !duplicate && req.body.client_uuid) {
    enqueueOutbox({
      clientUuid: req.body.client_uuid,
      branchId: branch_id,
      payload: {
        created_at: req.body.created_at || new Date().toISOString(),
        items: req.body.items,
        discount: req.body.discount,
        tax_percent: req.body.tax_percent,
        payment_method: req.body.payment_method || 'cash',
        cash_received: req.body.cash_received,
        payments: req.body.payments,
        note: req.body.note,
        order_label: req.body.order_label,
        table_number: req.body.table_number,
        customer_name: req.body.customer_name,
      },
    });
  }

  audit({ company_id: req.user.company_id, branch_id, user_id: req.user.sub, action: 'transaction.create', entity: 'transaction', entity_id: txId, detail: { total: priced.totals.total, duplicate }, ip: req.ip });
  const body = { ...stampRow(getTransaction(txId, req.user.company_id)), duplicate };
  // 'warn' mode only: the sale went through, but it oversold. The UI can toast
  // this without treating the sale as failed.
  if (stockShortfalls && stockShortfalls.length) body.stock_warnings = stockShortfalls;
  res.status(duplicate ? 200 : 201).json(body);
}));

/** POST /transactions/quote — price a cart without persisting (cart preview / validation). */
router.post('/transactions/quote', authRequired, wrap((req, res) => {
  const { branch_id } = req.body;
  if (!branch_id) return badRequest(res, 'branch_id required');
  if (!assertBranchAccess(req, res, branch_id)) return;
  const priced = priceCart({
    companyId: req.user.company_id,
    branchId: branch_id,
    items: req.body.items,
    discount: req.body.discount,
    taxPercent: req.body.tax_percent,
    paymentMethod: req.body.payment_method || 'cash',
    // Only forward when supplied — a quote may omit payment info entirely.
    cashReceived: req.body.cash_received ?? undefined,
    payments: Array.isArray(req.body.payments) && req.body.payments.length ? req.body.payments : undefined
  });
  if (priced.error) return badRequest(res, priced.error);
  res.json({
    totals: priced.totals,
    lines: priced.prepared.map((p) => ({
      product_id: p.prod.id, product_name: p.prod.name, variant_label: p.variantLabel,
      quantity: p.qty, price: p.unitPrice, discount: p.itemDiscount, subtotal: p.lineSubtotal
    }))
  });
}));

/** GET /transactions — paginated history with filters. */
router.get('/transactions', authRequired, wrap((req, res) => {
  const { from, to, cashier_id, status, payment_method, q, limit = 50, offset = 0 } = req.query;
  const scope = scopedBranchIds(req);
  const branchIds = req.query.branch_id ? [req.query.branch_id] : scope;
  if (req.query.branch_id && !assertBranchAccess(req, res, req.query.branch_id)) return;
  const { where, params } = txFilter({
    companyId: req.user.company_id,
    branchIds,
    from,
    to,
    cashierId: cashier_id,
    statuses: status ? status.split(',') : ['completed', 'voided', 'void_pending', 'refunded']
  });
  const extra = [];
  const extraParams = [];
  if (payment_method) { extra.push('t.payment_method = ?'); extraParams.push(payment_method); }
  if (q) { extra.push('(t.code LIKE ? OR t.customer_name LIKE ? OR t.receipt_number LIKE ?)'); extraParams.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const fullWhere = [where, ...extra].join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) AS n FROM transactions t WHERE ${fullWhere}`).get(...params, ...extraParams).n;
  const rows = db
    .prepare(
      `SELECT t.*, b.name AS branch_name, u.name AS cashier_name,
              (SELECT COUNT(*) FROM transaction_items i WHERE i.transaction_id = t.id) AS item_count
       FROM transactions t
       LEFT JOIN branches b ON b.id = t.branch_id
       LEFT JOIN users u ON u.id = t.user_id
       WHERE ${fullWhere} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, ...extraParams, Number(limit), Number(offset));
  // Timestamps leave as ISO-8601 UTC (`...Z`) — see `stampRow`.
  res.json({ total, limit: Number(limit), offset: Number(offset), rows: rows.map(stampRow) });
}));

router.get('/transactions/:id', authRequired, wrap((req, res) => {
  const t = getTransaction(req.params.id, req.user.company_id);
  if (!t) return notFound(res, 'Transaction not found');
  if (!assertBranchAccess(req, res, t.branch_id)) return;
  res.json(stampRow(t));
}));

/** POST /transactions/:id/void — request a void. Cashiers need manager approval. */
router.post('/transactions/:id/void', authRequired, wrap((req, res) => {
  const t = getTransaction(req.params.id, req.user.company_id);
  if (!t) return notFound(res, 'Transaction not found');
  if (!assertBranchAccess(req, res, t.branch_id)) return;
  if (t.status !== 'completed') return badRequest(res, `Transaksi sudah ${t.status}`);
  const { reason, pin } = req.body;
  if (!reason) return badRequest(res, 'Alasan void wajib diisi');

  const canVoidDirect = req.permissions.includes('transaction.void');
  let approvedBy = null;
  if (!canVoidDirect) {
    // Manager override using their PIN at the till.
    const manager = pin
      ? db
          .prepare(
            `SELECT u.* FROM users u WHERE u.company_id = ? AND u.is_active = 1
             AND u.pin_hash IS NOT NULL AND u.role IN ('manager','super_admin')`
          )
          .all(req.user.company_id)
          .find((u) => bcrypt.compareSync(String(pin), u.pin_hash))
      : null;
    if (!manager) return res.status(403).json({ error: 'Butuh PIN manager untuk void transaksi' });
    approvedBy = manager.id;
  }

  const run = db.transaction(() => {
    // Restore stock for every line.
    const items = db.prepare('SELECT * FROM transaction_items WHERE transaction_id = ?').all(t.id);
    for (const it of items) {
      if (!it.product_id) continue;
      applyStockDelta({
        branchId: t.branch_id, productId: it.product_id, delta: it.quantity, type: 'void',
        referenceId: t.id, note: `Void ${t.code}: ${reason}`, userId: req.user.sub
      });
    }
    db.prepare(
      "UPDATE transactions SET status = 'voided', void_reason = ?, approved_by = ? WHERE id = ?"
    ).run(reason, approvedBy, t.id);
  });
  run();
  audit({ company_id: req.user.company_id, branch_id: t.branch_id, user_id: req.user.sub, action: 'transaction.void', entity: 'transaction', entity_id: t.id, detail: { reason, approved_by: approvedBy, total: t.total }, ip: req.ip });
  res.json(stampRow(getTransaction(t.id, req.user.company_id)));
}));

/** GET /transactions/:id/receipt — structured receipt for 58/80mm thermal printing. */
router.get('/transactions/:id/receipt', authRequired, wrap((req, res) => {
  const t = getTransaction(req.params.id, req.user.company_id);
  if (!t) return notFound(res, 'Transaction not found');
  if (!assertBranchAccess(req, res, t.branch_id)) return;
  const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(t.branch_id) || {};
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.user.company_id) || {};
  res.json({
    // `timezone` travels with the receipt so the printer renders the sale on the
    // shop's clock even when the printing device is set to another one.
    company: { name: company.name, address: company.address, phone: company.phone, logo_url: company.logo_url, currency: company.currency, timezone: company.timezone || 'UTC' },
    branch: { name: branch.name, address: branch.address, phone: branch.phone },
    header: {
      code: t.code,
      receipt_number: t.receipt_number || t.code,
      cashier: t.cashier_name,
      created_at: stamp(t.created_at),
      order_label: t.order_label,
      table_number: t.table_number,
      customer_name: t.customer_name
    },
    items: t.items.map((i) => ({
      name: i.product_name,
      variant: i.variant_label,
      quantity: i.quantity,
      price: i.price,
      discount: i.discount,
      subtotal: i.subtotal,
      note: i.note
    })),
    totals: {
      subtotal: t.subtotal, discount: t.discount, tax: t.tax, tax_percent: t.tax_percent,
      total: t.total, cash_received: t.cash_received, change_due: t.change_due
    },
    payment_method: t.payment_method,
    payments: t.payments || null,
    status: t.status,
    note: t.note,
    footer: 'Terima kasih atas kunjungan Anda'
  });
}));

export default router;
