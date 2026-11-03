import { db } from '../db.js';
import { id, money, branchPrice, applyStockDelta, nowSql, toSqlTimestamp } from './helpers.js';
import { enqueueFromTransaction, isPreparedItem } from './kitchen.js';

/**
 * Validate a cart and compute totals against the *current* branch prices.
 * Returns { error } when the payload is invalid, otherwise { prepared, totals }.
 */
export function priceCart({ companyId, branchId, items, discount = 0, taxPercent = 0, paymentMethod = 'cash', cashReceived, payments = [] }) {
  if (!Array.isArray(items) || !items.length) return { error: 'items required' };
  const productStmt = db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?');
  const availableStmt = db.prepare('SELECT is_available FROM branch_products WHERE branch_id = ? AND product_id = ?');
  const variantStmt = db.prepare('SELECT * FROM product_variants WHERE id = ? AND product_id = ?');

  let subtotal = 0;
  const prepared = [];
  for (const it of items) {
    const prod = productStmt.get(it.product_id, companyId);
    if (!prod || !prod.is_active) return { error: `Produk tidak ditemukan / nonaktif: ${it.product_id}` };
    const avail = availableStmt.get(branchId, it.product_id);
    if (avail && avail.is_available === 0) return { error: `Produk ${prod.name} tidak tersedia di cabang ini` };

    let variant = null;
    if (it.variant_id) {
      variant = variantStmt.get(it.variant_id, prod.id);
      if (!variant) return { error: `Varian tidak valid untuk ${prod.name}` };
    }
    const unitPrice = money(branchPrice(branchId, prod.id, prod.default_price) + (variant ? Number(variant.price_adjustment) || 0 : 0));
    const qty = Number(it.quantity) || 1;
    const itemDiscount = money(Number(it.discount) || 0);
    const lineSubtotal = money(unitPrice * qty - itemDiscount);
    subtotal = money(subtotal + lineSubtotal);
    prepared.push({
      prod,
      variant,
      variantLabel: it.variant_label || (variant ? variant.name : null),
      qty,
      unitPrice,
      itemDiscount,
      lineSubtotal,
      note: it.note || null
    });
  }

  const disc = money(Number(discount) || 0);
  const tax = money(((subtotal - disc) * (Number(taxPercent) || 0)) / 100);
  const total = money(Math.max(0, subtotal - disc + tax));

  // Split payment: when `payments` is provided it must cover the total.
  // Validation is opt-in so the same function can price a cart (quote) with no payment info.
  let detail = null;
  let cashPaid = Number(cashReceived) || 0;
  if (Array.isArray(payments) && payments.length) {
    const sum = money(payments.reduce((a, p) => a + (Number(p.amount) || 0), 0));
    if (sum + 0.001 < total) return { error: `Pembayaran kurang ${money(total - sum)}` };
    detail = payments;
    cashPaid = money(payments.filter((p) => p.method === 'cash').reduce((a, p) => a + (Number(p.amount) || 0), 0));
  } else if (paymentMethod === 'cash' && cashReceived !== undefined && cashReceived !== null && cashPaid + 0.001 < total) {
    return { error: 'Uang tunai kurang dari total' };
  }

  const changeDue = paymentMethod === 'cash' || detail ? money(Math.max(0, cashPaid - total)) : 0;

  return {
    prepared,
    totals: {
      subtotal, discount: disc, tax, tax_percent: Number(taxPercent) || 0, total,
      cash_received: cashPaid, change_due: changeDue, payment_detail: detail
    }
  };
}

/**
 * Persist a priced cart.
 *  - clientUuid: idempotency key (offline sync) — a replay returns the existing row
 *  - createdAt: original timestamp when the sale happened offline
 *  - offline: flag the row as synced from an offline device
 */
export function persistTransaction({ companyId, branchId, userId, deviceId, client }) {
  if (client.client_uuid) {
    const existing = db
      .prepare('SELECT id FROM transactions WHERE company_id = ? AND client_uuid = ?')
      .get(companyId, client.client_uuid);
    if (existing) return { id: existing.id, duplicate: true };
  }

  let reference = null;
  if (client.reference_id) {
    reference = db.prepare('SELECT * FROM transactions WHERE id = ? AND company_id = ?').get(client.reference_id, companyId);
  }

  const shift = db
    .prepare("SELECT * FROM shifts WHERE branch_id = ? AND user_id = ? AND status = 'open' ORDER BY opened_at DESC")
    .get(branchId, userId);
  const txId = id();
  const code = client.code || 'TRX-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 90 + 10);
  const t = client.totals;

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO transactions (id, company_id, branch_id, user_id, shift_id, code, receipt_number, subtotal, discount, tax, tax_percent,
         total, payment_method, payment_detail, cash_received, change_due, status, note, created_at,
         client_uuid, order_label, table_number, customer_name, synced_from_offline, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      txId, companyId, branchId, userId, shift ? shift.id : null, code, code,
      t.subtotal, t.discount, t.tax, t.tax_percent, t.total, client.payment_method || 'cash',
      t.payment_detail ? JSON.stringify(t.payment_detail) : null, t.cash_received, t.change_due,
      client.note || null,
      client.created_at ? toSqlTimestamp(client.created_at) : nowSql(),
      client.client_uuid || null, client.order_label || null, client.table_number || null, client.customer_name || null,
      client.offline ? 1 : 0, deviceId || null
    );

    for (const pi of client.prepared) {
      db.prepare(
        `INSERT INTO transaction_items (id, transaction_id, product_id, product_name, variant_id, variant_label, price, cost_price, quantity, discount, subtotal, note, is_prepared)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id(), txId, pi.prod.id, pi.prod.name, pi.variant ? pi.variant.id : null, pi.variantLabel,
        pi.unitPrice, pi.prod.cost_price, pi.qty, pi.itemDiscount, pi.lineSubtotal, pi.note,
        isPreparedItem(pi.prod) ? 1 : 0
      );
      applyStockDelta({
        branchId, productId: pi.prod.id, delta: -pi.qty,
        type: client.offline ? 'offline_sale' : 'sale',
        referenceId: txId, note: reference ? `Refund of ${reference.code}` : null, userId
      });
    }
  });
  run();

  // Send the drinks/food to the kitchen display. Best-effort: a queue failure
  // must never roll back a paid sale, so it is outside the transaction above.
  let queueId = null;
  try {
    queueId = enqueueFromTransaction({
      companyId,
      branchId,
      userId,
      transactionId: txId,
      transaction: {
        order_label: client.order_label,
        table_number: client.table_number,
        customer_name: client.customer_name,
        note: client.note
      },
      prepared: client.prepared
    });
  } catch {
    queueId = null;
  }

  // Cash drawer reconciliation counters on the shift.
  if (shift) {
    const cash = t.payment_detail ? t.cash_received : client.payment_method === 'cash' ? t.total : 0;
    db.prepare('UPDATE shifts SET cash_sales = COALESCE(cash_sales,0) + ?, non_cash_sales = COALESCE(non_cash_sales,0) + ? WHERE id = ?')
      .run(cash, money(t.total - cash), shift.id);
  }
  return { id: txId, duplicate: false, queueId };
}

/** Fetch a transaction with items, branch & cashier names. */
export function getTransaction(txId, companyId = null) {
  const t = companyId
    ? db.prepare('SELECT * FROM transactions WHERE id = ? AND company_id = ?').get(txId, companyId)
    : db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId);
  if (!t) return null;
  t.items = db.prepare('SELECT * FROM transaction_items WHERE transaction_id = ?').all(txId);
  t.branch_name = db.prepare('SELECT name FROM branches WHERE id = ?').get(t.branch_id)?.name;
  t.cashier_name = db.prepare('SELECT name FROM users WHERE id = ?').get(t.user_id)?.name;
  if (t.payment_detail) {
    try {
      t.payments = JSON.parse(t.payment_detail);
    } catch {
      t.payments = null;
    }
  }
  return t;
}

