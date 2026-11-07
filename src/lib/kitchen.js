import { db } from '../db.js';
import { isEdge } from '../edge.js';
import { id, toIso } from './helpers.js';
import { enqueueQueueSnapshot } from './edgeQueueSync.js';

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
  holdOrderId = null,
  originRef = null,
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
      `INSERT INTO order_queue (id, company_id, branch_id, transaction_id, hold_order_id, origin_ref, ticket_no, order_label, table_number,
         customer_name, station, status, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queue', ?, ?)`
    ).run(
      queueId, companyId, branchId, transactionId, holdOrderId, originRef, nextTicketNo(branchId), orderLabel, tableNumber,
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
 * Enqueue the prepared lines of a parked (held) order.
 *
 * A hold is an unpaid cart, but the drinks/food still have to be made — so the
 * ticket has to exist at hold time, not only after payment. Mirrors
 * `enqueueFromTransaction`: same `isPreparedItem` filter, so retail lines never
 * reach the bar. The ticket keeps `hold_order_id` instead of `transaction_id`,
 * which is what lets `settleHoldTicket` retire it once the cart is resumed and
 * paid (otherwise the same order would be prepared twice).
 *
 * Returns the new queue id, or null when the hold has nothing to prepare.
 */
/**
 * The lines of a parked cart that the station actually has to make.
 *
 * Same `isPreparedItem` filter a paid sale uses, so retail lines never reach the
 * bar. A custom line with no product link has no category to route on, but it is
 * still something the counter asked for — keep it, as a waiter ticket would.
 */
function preparedHoldLines(items = []) {
  const prodStmt = db.prepare('SELECT category_id, is_variant_parent FROM products WHERE id = ?');
  return (items || [])
    .filter((i) => {
      if (!i || !(i.product_name || i.product_id)) return false;
      if (!i.product_id) return true;
      return isPreparedItem(prodStmt.get(i.product_id));
    })
    .map((i) => ({
      product_id: i.product_id || null,
      product_name: i.product_name || 'Item',
      variant_label: i.variant_label || null,
      quantity: Number(i.quantity) || 1,
      note: i.note || null
    }));
}

/**
 * Rewrite a still-untouched ticket's lines from the cart's current contents.
 *
 * Editing a parked cart re-raises its ticket on the till, so the mirrored copy has
 * to follow — but ticket ids are local to each side, so the record cannot simply be
 * replaced. Rewriting the lines in place keeps the number the bar is already looking
 * at. Idempotent by construction: identical input leaves the identical end state,
 * which matters because a snapshot is replayed whenever a response is lost.
 *
 * Returns the number of tickets touched (0 when the hold has no ticket).
 */
export function replaceHoldTicketLines({ companyId, holdId, items = [] }) {
  const row = db
    .prepare(
      `SELECT id, status FROM order_queue
        WHERE company_id = ? AND transaction_id IS NULL AND (origin_ref = ? OR hold_order_id = ?)
        ORDER BY rowid LIMIT 1`
    )
    .get(companyId, holdId, holdId);
  if (!row) return 0;
  // Once the bar has started, the original ticket is the record of what was
  // actually made — rewriting it would falsify that history (same rule as the till).
  if (row.status !== 'queue') return 0;

  const lines = preparedHoldLines(items);
  if (!lines.length) return 0;
  const run = db.transaction(() => {
    db.prepare('DELETE FROM order_queue_items WHERE queue_id = ?').run(row.id);
    const stmt = db.prepare(
      'INSERT INTO order_queue_items (id, queue_id, product_id, product_name, variant_label, quantity, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const l of lines) {
      stmt.run(id(), row.id, l.product_id, l.product_name, l.variant_label, l.quantity, l.note);
    }
  });
  run();
  return 1;
}

export function enqueueFromHold({ companyId, branchId, userId, holdId, hold, items = [] }) {
  const lines = preparedHoldLines(items);
  if (!lines.length) return null;

  const queueId = createTicket({
    companyId,
    branchId,
    userId,
    holdOrderId: holdId,
    // The cross-side identity for this ticket: the hold id. The cloud raises the
    // ticket from the mirrored hold and stamps the same ref, so later status moves
    // can still address it once the hold row is gone.
    originRef: holdId,
    orderLabel: hold.label || null,
    tableNumber: hold.table_number || null,
    customerName: hold.customer_name || null,
    note: hold.note || null,
    items: lines
  });
  if (!queueId) return null;

  // Stamp the ticket with when the order was actually parked, so the board's
  // turnaround timer reflects the customer's wait rather than the insert time.
  if (hold.created_at) {
    db.prepare('UPDATE order_queue SET created_at = ? WHERE id = ?').run(hold.created_at, queueId);
  }
  return queueId;
}

/**
 * Retire the ticket raised for a hold, once that hold has become a paid sale.
 *
 * Only deletes tickets nobody has touched yet (`status = 'queue'`). If the bar
 * already started or finished the drinks that work is real, so its history is
 * left intact — deleting it would also erase the audit trail of who made what.
 *
 * Returns the number of tickets removed.
 */
export function settleHoldTicket({ companyId, holdId }) {
  if (!companyId || !holdId) return 0;
  const rows = db
    .prepare("SELECT id FROM order_queue WHERE company_id = ? AND hold_order_id = ? AND status = 'queue' AND transaction_id IS NULL")
    .all(companyId, holdId);
  for (const r of rows) db.prepare('DELETE FROM order_queue WHERE id = ?').run(r.id);
  return rows.length;
}

/**
 * Take over the ticket a parked cart already raised, instead of raising a second one.
 *
 * Parking a cart raises a real ticket, because the drinks have to be made while the
 * customer is still at the table. When the cart is resumed and finally paid, the sale
 * must *continue* that ticket: raising a fresh one tells the bar to make an order it
 * has already finished and handed over.
 *
 * The ticket is found by `origin_ref` — the hold id, which survives the hold row being
 * deleted on resume (the foreign key is nulled, the ref is not) and is mirrored to the
 * cloud by the hold lane, so the same ticket exists on both sides.
 *
 * Lines the sale has that the ticket does not (a drink added at the counter while
 * paying) are added, so nothing goes un-made: more of a drink already on the ticket
 * bumps that line's quantity, an entirely new item becomes a new line. Matching is by
 * product + variant + note, because "less ice" is a different cup. Quantities already
 * on the ticket are never reduced — they were produced.
 *
 * A cancelled ticket is not adopted: the bar refused that order, and a sale that pays
 * for it needs a ticket somebody will actually work.
 *
 * Returns the adopted queue id, or null when there is nothing to adopt.
 */
export function adoptHoldTicket({ companyId, branchId, transactionId, holdId, prepared = [] }) {
  if (!companyId || !branchId || !transactionId || !holdId) return null;
  const ticket = db
    .prepare(
      `SELECT * FROM order_queue
        WHERE company_id = ? AND branch_id = ? AND transaction_id IS NULL AND status <> 'cancelled'
          AND (origin_ref = ? OR hold_order_id = ?)
        ORDER BY rowid DESC LIMIT 1`
    )
    .get(companyId, branchId, holdId, holdId);
  if (!ticket) return null;

  const sameLine = (line, p) =>
    (line.product_id || '') === (p.prod.id || '') &&
    (line.variant_label || '') === (p.variantLabel || '') &&
    (line.note || '') === (p.note || '');

  const lines = db.prepare('SELECT * FROM order_queue_items WHERE queue_id = ? ORDER BY rowid').all(ticket.id);
  // How much of each line the sale is already covered by, consumed as we go.
  const remaining = lines.map((l) => Number(l.quantity) || 0);
  const bumps = [];
  const additions = [];

  for (const p of prepared) {
    let want = Number(p.qty) || 1;
    let firstMatch = -1;
    for (let i = 0; i < lines.length && want > 0; i += 1) {
      if (!sameLine(lines[i], p)) continue;
      if (firstMatch < 0) firstMatch = i;
      if (remaining[i] <= 0) continue;
      const taken = Math.min(remaining[i], want);
      remaining[i] -= taken;
      want -= taken;
    }
    if (want <= 0) continue;
    if (firstMatch >= 0) {
      bumps.push({ itemId: lines[firstMatch].id, add: want });
    } else {
      additions.push({
        product_id: p.prod.id,
        product_name: p.prod.name,
        variant_label: p.variantLabel || null,
        quantity: want,
        note: p.note || null
      });
    }
  }

  const run = db.transaction(() => {
    // Keep ticket_no, status and timestamps: the station's copy of the order is the
    // record of what was actually made, and the cashier paid for exactly that.
    db.prepare('UPDATE order_queue SET transaction_id = ?, hold_order_id = NULL WHERE id = ?').run(transactionId, ticket.id);
    const bump = db.prepare('UPDATE order_queue_items SET quantity = quantity + ? WHERE id = ?');
    for (const b of bumps) bump.run(b.add, b.itemId);
    const insert = db.prepare(
      'INSERT INTO order_queue_items (id, queue_id, product_id, product_name, variant_label, quantity, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const a of additions) insert.run(id(), ticket.id, a.product_id, a.product_name, a.variant_label, a.quantity, a.note);
  });
  run();
  return ticket.id;
}

/**
 * Enqueue the prepared lines of a committed sale. Called from the checkout path
 * so every channel (till, offline replay, waiter) produces a ticket.
 *
 * `holdId` is set when the sale pays for a cart that was parked earlier: the sale
 * adopts that cart's ticket instead of raising a duplicate (see `adoptHoldTicket`).
 *
 * Returns the queue id, or null when the sale had nothing to prepare.
 */
export function enqueueFromTransaction({ companyId, branchId, userId, transactionId, transaction, prepared, holdId = null }) {
  const lines = (prepared || []).filter((p) => isPreparedItem(p.prod));
  if (!lines.length) return null;
  const adopted = adoptHoldTicket({ companyId, branchId, transactionId, holdId, prepared: lines });
  if (adopted) return adopted;
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

/**
 * Fold a ticket's new state into the edge→cloud queue lane.
 *
 * The lane needs a key that exists on both sides. Two kinds of ticket have one:
 *
 *   sale  — `transactions.client_uuid`, the id the sale replay already dedupes on.
 *   hold  — `order_queue.origin_ref` (the till's hold id). The ticket was raised
 *           from a parked cart, which the hold lane mirrored, so the cloud has the
 *           same ticket under the same ref.
 *
 * A walk-in ticket (no sale, no hold) has neither: it was never sent anywhere, so
 * there is nothing on the cloud to patch and it stays local by design.
 *
 * `items_done` is positional — both sides created the lines from the same
 * `prepared`/hold lines, in the same order.
 */
function queueSyncAfterMutation(row, updated) {
  if (!isEdge()) return;
  let originUuid = null;
  let kind = 'sale';

  if (row.transaction_id) {
    const tx = db.prepare('SELECT client_uuid FROM transactions WHERE id = ?').get(row.transaction_id);
    if (!tx || !tx.client_uuid) return;
    originUuid = tx.client_uuid;
  } else {
    // `origin_ref` survives the hold being resumed and deleted; `hold_order_id`
    // is only there for a ticket raised before this column existed.
    originUuid = updated?.origin_ref || row.origin_ref || row.hold_order_id || null;
    if (!originUuid) return;
    kind = 'hold';
  }

  enqueueQueueSnapshot({
    originUuid,
    branchId: row.branch_id,
    payload: {
      kind,
      status: updated.status,
      started_at: updated.started_at,
      ready_at: updated.ready_at,
      completed_at: updated.completed_at,
      cancel_reason: updated.cancel_reason,
      items_done: (updated.items || []).map((i) => (i.done ? 1 : 0)),
    },
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
  const updated = getQueueItem(row.id, companyId);
  queueSyncAfterMutation(row, updated);
  return { row: updated };
}

/** Hard-delete a ticket (mistakes only — normal completion keeps history). */
export function deleteTicket({ queueId, companyId }) {
  const row = db.prepare('SELECT id FROM order_queue WHERE id = ? AND company_id = ?').get(queueId, companyId);
  if (!row) return false;
  db.prepare('DELETE FROM order_queue WHERE id = ?').run(row.id);
  return true;
}
