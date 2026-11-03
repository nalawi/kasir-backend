import { db } from '../db.js';
import { id, toIso } from './helpers.js';

/**
 * Kitchen / barista display (KDS) queue.
 *
 * Lifecycle (one row in `order_queue`):
 *
 *   queue ──▶ preparing ──▶ ready ──▶ completed
 *     └──────────┴───────────┴──▶ cancelled (reason required)
 *
 * `completed` means "handed to the customer / picked up by the waiter". It is
 * deliberately separate from the transaction status (`completed` / `voided`):
 * a ticket can be finished at the bar while the bill is still open.
 */

export const QUEUE_STATUSES = ['queue', 'preparing', 'ready', 'completed', 'cancelled'];

/** Statuses that still occupy the board (not yet served or dropped). */
export const ACTIVE_STATUSES = ['queue', 'preparing', 'ready'];

/**
 * Legal transitions. Linear forward movement keeps the board honest — you cannot
 * jump queue → completed without the bar making it — but one step back is
 * allowed to undo a mis-tap.
 */
const NEXT = {
  queue: ['preparing', 'ready', 'cancelled'],
  preparing: ['ready', 'queue', 'cancelled'],
  ready: ['completed', 'preparing', 'cancelled'],
  completed: [],
  cancelled: ['queue']
};

export function canTransition(from, to) {
  return (NEXT[from] || []).includes(to);
}

/**
 * Which station a product belongs to, derived from its category name.
 *
 * The catalogue has no station column, so this maps the vocabulary a cafe
 * actually uses ("Kopi", "Makanan", "Snack"). Anything unrecognised becomes
 * `both`, a safe default: it appears on every screen rather than vanishing.
 */
export function stationFor(categoryName) {
  const c = String(categoryName || '').toLowerCase();
  if (/kopi|coffee|minum|drink|teh|tea|juice|jus|bar|smoothie|shake/.test(c)) return 'bar';
  if (/makan|food|nasi|mie|rice|burger|pasta|snack|cemilan|roti|dessert|kue/.test(c)) return 'kitchen';
  return 'both';
}

/**
 * Should a sold line appear on the preparation queue?
 *
 * Only items somebody actually *makes*: drinks/food carry a category, and
 * variant parents (product families) are always made to order. Untagged retail
 * (beans, merchandise) has no category and is not a variant parent, so a bag of
 * coffee beans never lands on the barista screen.
 */
export function isPreparedItem(product) {
  if (!product) return false;
  if (Number(product.is_variant_parent)) return true;
  return Boolean(product.category_id);
}

/** Join rows with their line items and the names of the people who touched them. */
function decorate(rows, companyId) {
  if (!rows.length) return rows;
  const userStmt = db.prepare('SELECT name FROM users WHERE id = ?');
  const itemStmt = db.prepare('SELECT * FROM order_queue_items WHERE queue_id = ? ORDER BY rowid');
  return rows.map((r) => ({
    ...r,
    // Timestamps are emitted as ISO with `Z` (see helpers.toIso) so the client can
    // compute elapsed time correctly regardless of its timezone.
    created_at: toIso(r.created_at),
    started_at: toIso(r.started_at),
    ready_at: toIso(r.ready_at),
    completed_at: toIso(r.completed_at),
    created_by_name: r.created_by ? userStmt.get(r.created_by)?.name || null : null,
    started_by_name: r.started_by ? userStmt.get(r.started_by)?.name || null : null,
    ready_by_name: r.ready_by ? userStmt.get(r.ready_by)?.name || null : null,
    closed_by_name: r.closed_by ? userStmt.get(r.closed_by)?.name || null : null,
    items: itemStmt.all(r.id)
  }));
}

/** Fetch queue rows for a branch. `statuses` empty → the active board only. */
export function listQueue({ branchId, companyId, statuses = ACTIVE_STATUSES, station = null, limit = 200 }) {
  const wanted = Array.isArray(statuses) && statuses.length ? statuses : ACTIVE_STATUSES;
  const placeholders = wanted.map(() => '?').join(',');
  const params = [branchId, companyId, ...wanted];
  let sql = `SELECT * FROM order_queue WHERE branch_id = ? AND company_id = ? AND status IN (${placeholders})`;
  if (station && station !== 'all') {
    // A `both` ticket shows on either station screen.
    sql += " AND (station = ? OR station = 'both')";
    params.push(station);
  }
  sql += ' ORDER BY created_at ASC, rowid ASC LIMIT ?';
  params.push(Number(limit) || 200);
  return decorate(db.prepare(sql).all(...params), companyId);
}

/** Board counters for the header (one query instead of five). */
export function queueSummary(branchId, companyId) {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS n FROM order_queue WHERE branch_id = ? AND company_id = ? GROUP BY status')
    .all(branchId, companyId);
  const out = { queue: 0, preparing: 0, ready: 0, completed: 0, cancelled: 0, active: 0 };
  for (const r of rows) out[r.status] = r.n;
  out.active = out.queue + out.preparing + out.ready;
  return out;
}

/** Next per-branch ticket number for today (the human-facing "#12"). */
function nextTicketNo(branchId) {
  const day = new Date().toISOString().slice(0, 10);
  const row = db
    .prepare('SELECT MAX(ticket_no) AS mx FROM order_queue WHERE branch_id = ? AND date(created_at) = ?')
    .get(branchId, day);
  return (row?.mx || 0) + 1;
}

export function getQueueItem(queueId, companyId) {
  const row = db.prepare('SELECT * FROM order_queue WHERE id = ? AND company_id = ?').get(queueId, companyId);
  if (!row) return null;
  return decorate([row], companyId)[0];
}

/**
 * Create a ticket. Lines are stored denormalised (name/variant/note) so history
 * survives a product rename or deletion — the same approach as
 * `transaction_items`, and required here because a ticket is a production record.
 */
export function createTicket({
  companyId,
  branchId,
  userId = null,
  transactionId = null,
  orderLabel = null,
  tableNumber = null,
  customerName = null,
  station = null,
  note = null,
  items = []
}) {
  const clean = (items || [])
    .filter((i) => i && (i.product_name || i.product_id))
    .map((i) => ({
      product_id: i.product_id || null,
      product_name: i.product_name || 'Item',
      variant_label: i.variant_label || null,
      quantity: Number(i.quantity) || 1,
      note: i.note || null
    }));
  if (!clean.length) return null;

  // Route by category; a ticket spanning bar + kitchen falls back to `both`.
  const catStmt = db.prepare('SELECT c.name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?');
  const stations = new Set(clean.map((i) => (i.product_id ? stationFor(catStmt.get(i.product_id)?.name) : 'both')));
  const resolvedStation = station || (stations.size === 1 ? [...stations][0] : 'both');

  const queueId = id();
  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO order_queue (id, company_id, branch_id, transaction_id, ticket_no, order_label, table_number,
         customer_name, station, status, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queue', ?, ?)`
    ).run(
      queueId, companyId, branchId, transactionId, nextTicketNo(branchId), orderLabel, tableNumber,
      customerName, resolvedStation, note, userId
    );
    const stmt = db.prepare(
      'INSERT INTO order_queue_items (id, queue_id, product_id, product_name, variant_label, quantity, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const it of clean) {
      stmt.run(id(), queueId, it.product_id, it.product_name, it.variant_label, it.quantity, it.note);
    }
  });
  run();
  return queueId;
}

/**
 * Enqueue the prepared lines of a committed sale. Called from the checkout path
 * so every channel (till, offline replay, waiter) produces a ticket.
 * Returns the new queue id, or null when the sale had nothing to prepare.
 */
export function enqueueFromTransaction({ companyId, branchId, userId, transactionId, transaction, prepared }) {
  const lines = (prepared || []).filter((p) => isPreparedItem(p.prod));
  if (!lines.length) return null;
  return createTicket({
    companyId,
    branchId,
    userId,
    transactionId,
    orderLabel: transaction.order_label || null,
    tableNumber: transaction.table_number || null,
    customerName: transaction.customer_name || null,
    note: transaction.note || null,
    items: lines.map((p) => ({
      product_id: p.prod.id,
      product_name: p.prod.name,
      variant_label: p.variantLabel,
      quantity: p.qty,
      note: p.note || null
    }))
  });
}

/** Advance / rewind a ticket, stamping the actor and the matching timestamp. */
export function setStatus({ queueId, companyId, userId, status, reason = null, lineDone = null }) {
  const row = db.prepare('SELECT * FROM order_queue WHERE id = ? AND company_id = ?').get(queueId, companyId);
  if (!row) return { error: 'notfound' };
  if (!QUEUE_STATUSES.includes(status)) return { error: `Status tidak dikenal: ${status}` };
  if (status !== row.status && !canTransition(row.status, status)) {
    return { error: `Tidak bisa mengubah status dari ${row.status} ke ${status}` };
  }
  if (status === 'cancelled' && !String(reason || '').trim()) {
    return { error: 'Alasan pembatalan wajib diisi' };
  }

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const run = db.transaction(() => {
    // Ticking off individual lines is independent of the ticket status.
    if (lineDone && lineDone.item_id) {
      db.prepare('UPDATE order_queue_items SET done = ? WHERE id = ? AND queue_id = ?')
        .run(lineDone.done ? 1 : 0, lineDone.item_id, row.id);
    }
    if (status === row.status) return;
    const sets = ['status = ?'];
    const vals = [status];
    // Timestamps are written only on first entry, so undoing a mis-tap doesn't
    // erase how long a ticket actually sat at the station.
    if (status === 'preparing' && !row.started_at) {
      sets.push('started_at = ?', 'started_by = ?');
      vals.push(now, userId);
    }
    if (status === 'ready' && !row.ready_at) {
      sets.push('ready_at = ?', 'ready_by = ?');
      vals.push(now, userId);
    }
    if ((status === 'completed' || status === 'cancelled') && !row.completed_at) {
      sets.push('completed_at = ?', 'closed_by = ?');
      vals.push(now, userId);
    }
    if (status === 'cancelled') {
      sets.push('cancel_reason = ?');
      vals.push(String(reason).trim());
    }
    if (status === 'queue') {
      // Reopened: clear the closing stamps so the ticket looks fresh again.
      sets.push('completed_at = NULL', 'cancel_reason = NULL');
    }
    db.prepare(`UPDATE order_queue SET ${sets.join(', ')} WHERE id = ?`).run(...vals, row.id);
  });
  run();
  return { row: getQueueItem(row.id, companyId) };
}

/** Hard-delete a ticket (mistakes only — normal completion keeps history). */
export function deleteTicket({ queueId, companyId }) {
  const row = db.prepare('SELECT id FROM order_queue WHERE id = ? AND company_id = ?').get(queueId, companyId);
  if (!row) return false;
  db.prepare('DELETE FROM order_queue WHERE id = ?').run(row.id);
  return true;
}
