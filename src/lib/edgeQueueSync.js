// Edge → cloud breadcrumb for the kitchen display (KDS).
//
// The sale replay (`edge_outbox` → POST /sync/batch) creates the ticket on the
// cloud exactly once. It never returns to that ticket, so a ticket that the bar
// later moves to `preparing`, `ready` or `completed` (or cancels with a reason, or
// ticks a line done) stayed frozen at whatever state `createTicket` produced during
// the replay. The cloud board then lies about what is happening on the floor.
//
// This module closes that gap with a second, tiny lane:
//   1. On every local ticket mutation, `enqueueQueueSnapshot` writes the ticket's
//      *absolute current state* into `edge_queue_sync`, one row per ticket.
//      Coalescing means a flurry of taps costs one network call, not one each.
//   2. `drainQueueOnce` forwards due rows to POST /sync/queue after the sale lane,
//      so the sale exists on the cloud before its ticket is patched.
//   3. The cloud applies the snapshot verbatim — the edge is authoritative for a
//      ticket it originated.
//
// The correlation key is `transactions.client_uuid`, which already exists on both
// sides and is what the sale replay dedupes on. No new column on `order_queue`, and
// re-sending is idempotent because it always carries the latest whole state.

import { db } from '../db.js';

const BATCH_SIZE = 100;
const BASE_DELAY_MS = 15_000;
const MAX_DELAY_MS = 15 * 60_000;

/**
 * Record (or refresh) the pending snapshot for one ticket.
 *
 * `payload` must be the complete absolute state, not a diff: the cloud applies it
 * as-is, so an older snapshot that arrives late can never leave the board half
 * updated. Return value is not significant; a no-op when `originUuid` is missing
 * (a ticket with no synced sale — a hold or walk-in — has nothing to patch).
 */
export function enqueueQueueSnapshot({ originUuid, branchId, payload }) {
  if (!originUuid || !branchId) return;
  db.prepare(
    `INSERT INTO edge_queue_sync (origin_uuid, branch_id, payload, revision, status, attempts, next_attempt_at)
     VALUES (?, ?, ?, 1, 'pending', 0, NULL)
     ON CONFLICT(origin_uuid) DO UPDATE SET
       payload = excluded.payload,
       branch_id = excluded.branch_id,
       revision = edge_queue_sync.revision + 1,
       status = 'pending',
       attempts = 0,
       last_error = NULL,
       next_attempt_at = NULL,
       updated_at = datetime('now')`
  ).run(originUuid, branchId, JSON.stringify(payload));
}

/** Counts for the sync badge / manual-drain response. */
export function queueSyncSummary(branchId) {
  const params = [];
  let where = '1 = 1';
  if (branchId) {
    where = 'branch_id = ?';
    params.push(branchId);
  }
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM edge_queue_sync WHERE ${where} AND status = 'pending'`)
    .get(...params);
  return { pending: row ? row.n : 0 };
}

/** Backoff schedule: 15s, 30s, 60s … capped at 15 minutes. Mirrors edgeOutbox. */
function nextDelay(attempts) {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
}

function dueQueueRows(branchId, limit) {
  const now = new Date().toISOString();
  return db
    .prepare(
      `SELECT * FROM edge_queue_sync
       WHERE branch_id = ? AND status = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY updated_at LIMIT ?`
    )
    .all(branchId, now, limit);
}

function deferQueueRow(row, message) {
  const attempts = Number(row.attempts || 0) + 1;
  db.prepare(
    "UPDATE edge_queue_sync SET attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = datetime('now') WHERE origin_uuid = ?"
  ).run(attempts, message, new Date(Date.now() + nextDelay(attempts)).toISOString(), row.origin_uuid);
}

/**
 * Replay one branch's pending ticket snapshots to the cloud.
 *
 * `post` is injected (same transport as the sale drain):
 *   (path, body) => Promise<{ results: Array<{origin_uuid, status, error}> }>
 *
 * A cloud `pending` verdict means the sale itself has not applied yet, so the
 * ticket does not exist there; the row backs off and is retried. Returning
 * `{ applied, examined }` keeps the caller (worker / manual drain) simple.
 */
export async function drainQueueOnce(branchId, post) {
  const rows = dueQueueRows(branchId, BATCH_SIZE);
  if (!rows.length) return { applied: 0, examined: 0 };

  const tickets = rows.map((r) => ({
    ...JSON.parse(r.payload),
    origin_uuid: r.origin_uuid,
    branch_id: branchId,
  }));

  let res;
  try {
    res = await post('/api/sync/queue', { branch_id: branchId, tickets });
  } catch (e) {
    // Transport failure: no response at all. Leave rows pending and back off.
    for (const r of rows) deferQueueRow(r, String(e?.message || e));
    throw e;
  }

  const byUuid = new Map((res?.results || []).map((r) => [r.origin_uuid, r]));
  let applied = 0;

  for (const r of rows) {
    const out = byUuid.get(r.origin_uuid);
    if (!out) {
      deferQueueRow(r, 'tanpa jawaban dari server');
      continue;
    }
    if (out.status === 'applied') {
      // Clear only the revision we actually sent. If a tap landed while the
      // request was in flight the row's revision has moved on, so the DELETE
      // matches nothing and the newer snapshot goes out next tick.
      const del = db
        .prepare('DELETE FROM edge_queue_sync WHERE origin_uuid = ? AND revision = ?')
        .run(r.origin_uuid, r.revision);
      if (del.changes > 0) applied += 1;
      continue;
    }
    // `pending` (sale not applied yet) or an explicit error: retry with backoff.
    deferQueueRow(r, out.error || (out.status === 'pending' ? 'menunggu transaksi' : out.status));
  }

  return { applied, examined: rows.length };
}
