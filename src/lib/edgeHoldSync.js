// Edge → cloud mirror for parked ("On Hold") carts.
//
// A hold is cart state, not money: `POST /api/holds` writes `hold_orders` plus a
// kitchen ticket and nothing else, so it never entered `edge_outbox` — the sale
// replay only knows about paid transactions. The cloud therefore never saw the
// hold, its Hold list stayed empty, and the ticket raised for it existed on the
// till alone.
//
// This lane closes both gaps with one row per hold:
//   1. `holdSyncAfterMutation` writes the *absolute* current state — header, lines
//      and the ticket's own state — into `edge_hold_sync`, or a tombstone when the
//      cart was resumed into a sale or discarded. Coalescing means editing a cart
//      costs one network call, not one per keystroke.
//   2. `drainHoldsOnce` forwards due rows to POST /sync/holds. The worker runs it
//      after the sale lane and before the queue lane, so the cloud ticket exists
//      before any status patch addresses it.
//   3. The cloud applies the snapshot verbatim (last-write-wins): the till is
//      authoritative for a cart it owns, and re-sending is a no-op.
//
// The correlation key is the till's `hold_orders.id`, replayed as-is. It is also
// stamped on the ticket as `order_queue.origin_ref`, which is what keeps the
// ticket addressable after the hold row is gone.

import { db } from '../db.js';
import { isEdge } from '../edge.js';

const BATCH_SIZE = 50;
const BASE_DELAY_MS = 15_000;
const MAX_DELAY_MS = 15 * 60_000;

/**
 * The hold's kitchen ticket as an absolute snapshot, or null when it has none
 * (nothing on a parked cart needs preparing, so no ticket was raised).
 *
 * `items_done` is positional: the cloud built its lines from the same hold lines,
 * in the same order.
 */
function holdTicketSnapshot(holdId) {
  const t = db
    .prepare(
      `SELECT id, status, started_at, ready_at, completed_at, cancel_reason, created_at
         FROM order_queue
        WHERE origin_ref = ? OR hold_order_id = ?
        ORDER BY rowid LIMIT 1`
    )
    .get(holdId, holdId);
  if (!t) return null;
  const lines = db
    .prepare('SELECT done FROM order_queue_items WHERE queue_id = ? ORDER BY rowid')
    .all(t.id);
  return {
    status: t.status,
    started_at: t.started_at,
    ready_at: t.ready_at,
    completed_at: t.completed_at,
    cancel_reason: t.cancel_reason,
    created_at: t.created_at,
    items_done: lines.map((l) => (l.done ? 1 : 0)),
  };
}

/**
 * Record the hold's current state for the cloud.
 *
 * Call this AFTER the cart write (create/edit) and BEFORE the rows are deleted
 * (discard / resumed into a sale): the tombstone still has to carry the ticket's
 * last state, because the cloud settles the hold and its ticket in one shot.
 *
 * `deleted` marks that tombstone. Everything else in the payload is absolute, so a
 * late, older snapshot can never leave the cloud's Hold list half-updated.
 */
export function holdSyncAfterMutation({ holdId, branchId, deleted = false }) {
  if (!isEdge() || !holdId || !branchId) return;
  const hold = db.prepare('SELECT * FROM hold_orders WHERE id = ?').get(holdId);
  const items = hold
    ? db.prepare('SELECT * FROM hold_order_items WHERE hold_order_id = ? ORDER BY rowid').all(holdId)
    : [];

  const payload = {
    deleted: Boolean(deleted),
    hold: {
      id: holdId,
      label: hold ? hold.label : null,
      note: hold ? hold.note : null,
      subtotal: hold ? hold.subtotal : 0,
      discount: hold ? hold.discount : 0,
      tax: hold ? hold.tax : 0,
      total: hold ? hold.total : 0,
      user_id: hold ? hold.user_id : null,
      created_at: hold ? hold.created_at : null,
    },
    items: items.map((i) => ({
      product_id: i.product_id || null,
      product_name: i.product_name,
      variant_label: i.variant_label || null,
      price: i.price,
      quantity: i.quantity,
      discount: i.discount || 0,
      note: i.note || null,
    })),
    queue: holdTicketSnapshot(holdId),
  };

  db.prepare(
    `INSERT INTO edge_hold_sync (hold_id, branch_id, payload, revision, status, attempts, next_attempt_at)
     VALUES (?, ?, ?, 1, 'pending', 0, NULL)
     ON CONFLICT(hold_id) DO UPDATE SET
       payload = excluded.payload,
       branch_id = excluded.branch_id,
       revision = edge_hold_sync.revision + 1,
       status = 'pending',
       attempts = 0,
       last_error = NULL,
       next_attempt_at = NULL,
       updated_at = datetime('now')`
  ).run(holdId, branchId, JSON.stringify(payload));
}

/**
 * Queue every parked cart that has never been mirrored.
 *
 * A till that upgrades mid-day can already have holds sitting on it from before
 * the lane existed; those rows were never enqueued and would silently stay local
 * forever. Running this once at worker start closes that gap, and it is a no-op
 * afterwards because a row that already has a sync entry is skipped.
 */
export function backfillHolds() {
  if (!isEdge()) return 0;
  const rows = db
    .prepare(
      `SELECT h.id, h.branch_id FROM hold_orders h
         LEFT JOIN edge_hold_sync s ON s.hold_id = h.id
        WHERE s.hold_id IS NULL`
    )
    .all();
  for (const r of rows) holdSyncAfterMutation({ holdId: r.id, branchId: r.branch_id });
  return rows.length;
}

/** Counts for the sync badge / manual-drain response. */
export function holdSyncSummary(branchId) {
  const params = [];
  let where = '1 = 1';
  if (branchId) {
    where = 'branch_id = ?';
    params.push(branchId);
  }
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM edge_hold_sync WHERE ${where} AND status = 'pending'`)
    .get(...params);
  return { pending: row ? row.n : 0 };
}

/** Backoff schedule: 15s, 30s, 60s … capped at 15 minutes. Mirrors edgeOutbox. */
function nextDelay(attempts) {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
}

function dueHoldRows(branchId, limit) {
  const now = new Date().toISOString();
  return db
    .prepare(
      `SELECT * FROM edge_hold_sync
        WHERE branch_id = ? AND status = 'pending'
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY updated_at LIMIT ?`
    )
    .all(branchId, now, limit);
}

function deferHoldRow(row, message) {
  const attempts = Number(row.attempts || 0) + 1;
  db.prepare(
    "UPDATE edge_hold_sync SET attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = datetime('now') WHERE hold_id = ?"
  ).run(attempts, message, new Date(Date.now() + nextDelay(attempts)).toISOString(), row.hold_id);
}

/**
 * Replay one branch's pending hold snapshots to the cloud.
 *
 * `post` is injected (same transport as the sale drain):
 *   (path, body) => Promise<{ results: Array<{hold_id, status, error, settled}> }>
 *
 * On `applied` the row is marked `synced` exactly once, by revision, so a cart
 * edited while the request was in flight is resent next tick instead of being
 * swallowed. Keeping the row (rather than deleting it) is what stops the boot
 * backfill from re-pushing every parked cart. A `settled` verdict means the cloud
 * removed the hold; any ticket snapshot still queued for it has no ticket left to
 * patch there, so it is dropped here rather than retried forever.
 */
export async function drainHoldsOnce(branchId, post) {
  const rows = dueHoldRows(branchId, BATCH_SIZE);
  if (!rows.length) return { applied: 0, examined: 0 };

  const holds = rows.map((r) => ({
    ...JSON.parse(r.payload),
    hold_id: r.hold_id,
    branch_id: branchId,
  }));

  let res;
  try {
    res = await post('/api/sync/holds', { branch_id: branchId, holds });
  } catch (e) {
    // Transport failure: no response at all. Leave rows pending and back off.
    for (const r of rows) deferHoldRow(r, String(e?.message || e));
    throw e;
  }

  const byId = new Map((res?.results || []).map((r) => [r.hold_id, r]));
  let applied = 0;

  for (const r of rows) {
    const out = byId.get(r.hold_id);
    if (!out) {
      deferHoldRow(r, 'tanpa jawaban dari server');
      continue;
    }
    if (out.status === 'applied') {
      // Marked synced rather than deleted: the row is the record that this cart has
      // been mirrored at least once, which is what keeps `backfillHolds` from
      // re-pushing every parked cart on the next boot. The revision guard means a
      // cart edited mid-flight is not marked as done.
      const upd = db
        .prepare(
          `UPDATE edge_hold_sync
              SET status = 'synced', payload = '{}', attempts = 0, last_error = NULL,
                  next_attempt_at = NULL, updated_at = datetime('now')
            WHERE hold_id = ? AND revision = ?`
        )
        .run(r.hold_id, r.revision);
      if (out.settled) {
        db.prepare('DELETE FROM edge_queue_sync WHERE origin_uuid = ?').run(r.hold_id);
      }
      if (upd.changes > 0) applied += 1;
      continue;
    }
    deferHoldRow(r, out.error || out.status);
  }

  return { applied, examined: rows.length };
}
