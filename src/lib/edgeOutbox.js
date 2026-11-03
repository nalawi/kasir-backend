// Edge outbox and upstream drain worker.
//
// Life of a sale in edge mode:
//   1. POST /api/transactions runs locally, exactly like the cloud, so the shift
//      totals, stock and receipt are all real.
//   2. The same payload is copied into `edge_outbox` with status 'pending'.
//   3. The drain worker (started only by the edge build) forwards pending rows to
//      the cloud's POST /api/sync/batch, which already dedupes on client_uuid.
//   4. Terminal outcomes (applied / conflict / rejected) are recorded for review;
//      transient failures back off exponentially and are retried.
//
// The queue lives in SQLite rather than localStorage: money must survive a webview
// cache clear or an app reinstall.

import { db } from '../db.js';

const BATCH_SIZE = 50;
const BASE_DELAY_MS = 15_000;
const MAX_DELAY_MS = 15 * 60_000;

/** Copy an accepted sale into the outbox so it can be replayed upstream. */
export function enqueueOutbox({ clientUuid, branchId, payload }) {
  if (!clientUuid) return;
  db.prepare(
    `INSERT INTO edge_outbox (client_uuid, branch_id, payload, status)
     VALUES (?, ?, ?, 'pending')
     ON CONFLICT(client_uuid) DO NOTHING`
  ).run(clientUuid, branchId, JSON.stringify(payload));
}

/** Outbox rows for one branch, newest first — feeds the sync badge in the UI. */
export function outboxSummary(branchId) {
  const params = [];
  let where = '1 = 1';
  if (branchId) {
    where = 'branch_id = ?';
    params.push(branchId);
  }
  const counts = db
    .prepare(`SELECT status, COUNT(*) AS n FROM edge_outbox WHERE ${where} GROUP BY status`)
    .all(...params);
  const last = db
    .prepare(`SELECT client_uuid, status, last_error, updated_at FROM edge_outbox WHERE ${where} ORDER BY updated_at DESC LIMIT 1`)
    .get(...params);
  return {
    counts: Object.fromEntries(counts.map((r) => [r.status, r.n])),
    pending: counts.filter((r) => r.status === 'pending' || r.status === 'applying').reduce((a, r) => a + r.n, 0),
    last: last || null,
  };
}

/** Rows needing a human decision (conflict or rejected by the cloud). */
export function outboxProblems(limit = 200) {
  return db
    .prepare("SELECT * FROM edge_outbox WHERE status IN ('conflict','rejected') ORDER BY updated_at DESC LIMIT ?")
    .all(limit)
    .map((r) => {
      let payload = null;
      try {
        payload = r.payload ? JSON.parse(r.payload) : null;
      } catch {
        payload = null;
      }
      return { ...r, payload };
    });
}

/**
 * Put a refused sale back in the queue after someone fixed the cause.
 *
 * The cloud's verdict is cleared and the backoff reset, so the next drain
 * attempts it immediately. Idempotency makes this safe: if the "conflict" was
 * really a lost response, the replay is recognised by `client_uuid` and applied
 * once instead of twice.
 *
 * Returns true when a row was actually requeued.
 */
export function retryOutboxRow(clientUuid) {
  const res = db
    .prepare(
      `UPDATE edge_outbox
       SET status = 'pending', attempts = 0, last_error = NULL,
           next_attempt_at = NULL, updated_at = datetime('now')
       WHERE client_uuid = ? AND status IN ('conflict','rejected')`
    )
    .run(clientUuid);
  return res.changes > 0;
}

/** Backoff schedule: 15s, 30s, 60s … capped at 15 minutes. */
function nextDelay(attempts) {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
}

function dueRows(branchId, limit) {
  const now = new Date().toISOString();
  return db
    .prepare(
      `SELECT * FROM edge_outbox
       WHERE branch_id = ? AND status = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at LIMIT ?`
    )
    .all(branchId, now, limit);
}

/** Push a row's retry out and record why. */
function deferRow(row, message) {
  const attempts = Number(row.attempts || 0) + 1;
  db.prepare(
    "UPDATE edge_outbox SET attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = datetime('now') WHERE client_uuid = ?"
  ).run(attempts, message, new Date(Date.now() + nextDelay(attempts)).toISOString(), row.client_uuid);
}



/**
 * Replay one branch's queue to the cloud.
 *
 * `post` is injected so this module stays transport-agnostic and testable:
 *   (path, body) => Promise<{ results: Array<{client_uuid, status, error}> }>
 *
 * Returns the number of rows the cloud accepted. Throws on a transport error so
 * the caller can distinguish "no internet" (retry later) from "cloud said no".
 */
export async function drainOnce(branchId, post) {
  const rows = dueRows(branchId, BATCH_SIZE);
  if (!rows.length) return { applied: 0, settled: 0, examined: 0 };

  const transactions = rows.map((r) => {
    const payload = JSON.parse(r.payload);
    // The outbox row is the authority on who/where/when; client_uuid ties the
    // replay to the sale that was already written locally.
    return { ...payload, client_uuid: r.client_uuid, branch_id: branchId };
  });

  let res;
  try {
    res = await post('/api/sync/batch', { branch_id: branchId, transactions });
  } catch (e) {
    // Transport failure: no response at all. Leave rows pending and back off.
    for (const r of rows) deferRow(r, String(e?.message || e));
    throw e;
  }

  const byUuid = new Map((res?.results || []).map((r) => [r.client_uuid, r]));
  let applied = 0;
  let settled = 0;

  for (const r of rows) {
    const out = byUuid.get(r.client_uuid);
    if (!out) {
      // The cloud returned no verdict for this row — retry it later.
      deferRow(r, 'tanpa jawaban dari server');
      continue;
    }
    const status = ['applied', 'conflict', 'rejected'].includes(out.status) ? out.status : 'pending';
    db.prepare(
      "UPDATE edge_outbox SET status = ?, attempts = attempts + 1, last_error = ?, next_attempt_at = NULL, updated_at = datetime('now') WHERE client_uuid = ?"
    ).run(status, out.error || null, r.client_uuid);
    settled += 1;
    if (status === 'applied') applied += 1;
  }

  return { applied, settled, examined: rows.length };
}

/**
 * Background drain, started by the edge build only. A till that is never
 * connected to a cloud is still a valid setup, so a missing upstream just means
 * rows stay pending.
 */
export function startUpstreamWorker({ post, branchIds, intervalMs = 20_000, onError = () => {}, onTick = () => {} }) {
  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    try {
      for (const branchId of branchIds()) {
        if (!branchId) continue;
        try {
          const res = await drainOnce(branchId, post);
          if (res.examined) onTick(branchId, res);
        } catch (e) {
          // No internet. The timer keeps running; rows already carry a backoff.
          onError(e);
        }
      }
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  }

  timer = setTimeout(tick, 2_000);

  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
