import express from 'express';
import fs from 'fs';
import { db } from '../db.js';
import { authRequired, requirePermission, audit, assertBranchAccess } from '../auth.js';
import { id, wrap, badRequest, notFound, toSqlTimestamp } from '../lib/helpers.js';
import { priceCart, persistTransaction, stockPolicy, stockShortfalls } from '../lib/transactions.js';
import { QUEUE_STATUSES, enqueueFromHold, settleHoldTicket, replaceHoldTicketLines } from '../lib/kitchen.js';
import { contentTypeOf, nameFromUrl, uploadPath } from '../lib/uploads.js';

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
          // The till paid for a cart it had parked; its ticket already exists here
          // (mirrored by the hold lane), so the sale adopts it instead of raising a
          // second ticket the bar would have to work twice.
          hold_id: tx.hold_id || null,
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

/**
 * Apply a ticket snapshot verbatim: status, timestamps, reason and line ticks.
 *
 * Absolute by design — the snapshot is the till's whole current state, so an older
 * one that arrives late cannot leave the board half-updated. A reopened ticket
 * ('queue') clears its closing stamps exactly like the till does, so the two boards
 * agree. `items_done` is positional: both sides built the lines from the same source
 * list (the `prepared` lines of a sale, or the lines of a hold), in the same order.
 */
function applyTicketState(ticketId, state, companyId) {
  db.prepare(
    `UPDATE order_queue
        SET status = ?, started_at = ?, ready_at = ?, completed_at = ?, cancel_reason = ?
      WHERE id = ? AND company_id = ?`
  ).run(
    state.status,
    state.started_at ? toSqlTimestamp(state.started_at) : null,
    state.ready_at ? toSqlTimestamp(state.ready_at) : null,
    state.completed_at ? toSqlTimestamp(state.completed_at) : null,
    state.cancel_reason != null ? String(state.cancel_reason) : null,
    ticketId,
    companyId
  );

  if (!Array.isArray(state.items_done)) return;
  const lines = db.prepare('SELECT id FROM order_queue_items WHERE queue_id = ? ORDER BY rowid').all(ticketId);
  const n = Math.min(lines.length, state.items_done.length);
  const setDone = db.prepare('UPDATE order_queue_items SET done = ? WHERE id = ?');
  for (let i = 0; i < n; i += 1) setDone.run(state.items_done[i] ? 1 : 0, lines[i].id);
}

/**
 * POST /sync/queue
 * Body: { branch_id, tickets: [ {origin_uuid, kind, status, started_at, ready_at, completed_at, cancel_reason, items_done} ] }
 *
 * Apply the edge's *absolute* state for tickets it originated. The sale replay in
 * /sync/batch creates the ticket exactly once and never revisits it, so this is the
 * only path that moves a cloud ticket past its first stage.
 *
 * `origin_uuid` identifies the ticket's origin, and `kind` says which:
 *   (absent) / 'sale' -> `transactions.client_uuid`, the key the replay dedupes on.
 *                        Resolved to the cloud's transaction, then to its ticket.
 *   'hold'            -> the till's hold id, mirrored by /sync/holds and stamped on
 *                        the ticket as `origin_ref`. A parked cart has no sale, and
 *                        this is what lets its ticket keep moving on the cloud.
 *
 * Outcomes:
 *   applied  -> the ticket's status, timestamps, reason and line ticks are replaced
 *   pending  -> the sale/hold itself has not applied yet (or its ticket isn't
 *               created), so the till retries later; we never invent a ticket here
 *   rejected -> malformed payload / unknown status / branch mismatch
 *
 * The edge is authoritative for a ticket it originated, so the write is verbatim:
 * an older snapshot cannot leave the board half-updated. Re-sending is a no-op.
 */
router.post('/sync/queue', authRequired, wrap((req, res) => {
  const { branch_id, tickets = [] } = req.body;
  if (!branch_id) return badRequest(res, 'branch_id required');
  if (!assertBranchAccess(req, res, branch_id)) return;
  if (!Array.isArray(tickets) || !tickets.length) return badRequest(res, 'tickets required');

  const txStmt = db.prepare('SELECT id, branch_id FROM transactions WHERE company_id = ? AND client_uuid = ?');
  const saleTicketStmt = db.prepare('SELECT id, branch_id FROM order_queue WHERE company_id = ? AND transaction_id = ?');
  // A hold ticket has no sale to resolve through, so it is addressed by the ref the
  // hold lane stamped on it. `hold_order_id` is the fallback for a ticket created
  // before that ref existed.
  const holdTicketStmt = db.prepare(
    `SELECT id, branch_id FROM order_queue
      WHERE company_id = ? AND transaction_id IS NULL
        AND (origin_ref = ? OR hold_order_id = ?)
      ORDER BY rowid LIMIT 1`
  );

  const results = [];
  for (const t of tickets) {
    const origin = t.origin_uuid;
    if (!origin) {
      results.push({ origin_uuid: null, status: 'rejected', error: 'origin_uuid required' });
      continue;
    }
    if (!QUEUE_STATUSES.includes(t.status)) {
      results.push({ origin_uuid: origin, status: 'rejected', error: `Status tidak dikenal: ${t.status}` });
      continue;
    }

    let ticket = null;
    if (t.kind === 'hold') {
      ticket = holdTicketStmt.get(req.user.company_id, origin, origin);
      if (!ticket) {
        // The hold (and the ticket raised with it) has not been mirrored yet.
        results.push({ origin_uuid: origin, status: 'pending', error: 'tiket hold belum tersinkron' });
        continue;
      }
    } else {
      const tx = txStmt.get(req.user.company_id, origin);
      if (!tx) {
        // The sale is still in the till's outbox (or was parked in conflict).
        results.push({ origin_uuid: origin, status: 'pending', error: 'transaksi belum tersinkron' });
        continue;
      }
      if (tx.branch_id !== branch_id) {
        results.push({ origin_uuid: origin, status: 'rejected', error: 'cabang tidak cocok' });
        continue;
      }
      ticket = saleTicketStmt.get(req.user.company_id, tx.id);
      if (!ticket) {
        results.push({ origin_uuid: origin, status: 'pending', error: 'tiket belum tersinkron' });
        continue;
      }
    }
    if (ticket.branch_id !== branch_id) {
      results.push({ origin_uuid: origin, status: 'rejected', error: 'cabang tidak cocok' });
      continue;
    }

    applyTicketState(ticket.id, t, req.user.company_id);
    results.push({ origin_uuid: origin, status: 'applied', queue_id: ticket.id });
  }

  res.json({
    total: results.length,
    applied: results.filter((r) => r.status === 'applied').length,
    results
  });
}));

/**
 * POST /sync/holds
 * Body: { branch_id, holds: [ {hold_id, deleted, hold, items, queue} ] }
 *
 * Mirror the till's parked ("On Hold") carts. A hold is cart state, not money, so
 * it never rode the sale replay: before this lane existed the cloud's Hold list
 * stayed empty and the kitchen ticket raised for a parked cart existed only on the
 * till that parked it.
 *
 * Every entry is absolute and the till owns the row, so replay is last-write-wins:
 *   applied  -> the cart (and, when the till had one, its ticket) now matches the till
 *   rejected -> malformed payload, unknown ticket status, branch mismatch, or a
 *               hold id already owned by another company
 *
 * `deleted: true` is the tombstone the till writes when a cart is resumed into a
 * sale or discarded: the hold is removed and its untouched ticket settled, exactly
 * as the till does. A ticket the bar already started is kept — that work really
 * happened — and is merely detached from the hold, staying reachable through
 * `origin_ref` for later status patches.
 */
router.post('/sync/holds', authRequired, wrap((req, res) => {
  const { branch_id, holds = [] } = req.body;
  if (!branch_id) return badRequest(res, 'branch_id required');
  if (!assertBranchAccess(req, res, branch_id)) return;
  if (!Array.isArray(holds) || !holds.length) return badRequest(res, 'holds required');

  const companyId = req.user.company_id;
  const ownerStmt = db.prepare('SELECT company_id FROM hold_orders WHERE id = ?');
  // The hold id is replayed verbatim, so the same row is addressed by every update
  // (and by the tombstone) without the cloud minting an id of its own.
  const upsertHold = db.prepare(
    `INSERT INTO hold_orders (id, company_id, branch_id, user_id, label, subtotal, discount, tax, total, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
     ON CONFLICT(id) DO UPDATE SET
       branch_id = excluded.branch_id,
       user_id = excluded.user_id,
       label = excluded.label,
       subtotal = excluded.subtotal,
       discount = excluded.discount,
       tax = excluded.tax,
       total = excluded.total,
       note = excluded.note`
  );
  const delItems = db.prepare('DELETE FROM hold_order_items WHERE hold_order_id = ?');
  const insItem = db.prepare(
    'INSERT INTO hold_order_items (id, hold_order_id, product_id, product_name, variant_label, price, quantity, discount, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const ticketByRef = db.prepare(
    `SELECT id FROM order_queue
      WHERE company_id = ? AND transaction_id IS NULL
        AND (origin_ref = ? OR hold_order_id = ?)
      ORDER BY rowid LIMIT 1`
  );
  const stampRef = db.prepare('UPDATE order_queue SET origin_ref = ? WHERE id = ?');
  const detach = db.prepare('UPDATE order_queue SET hold_order_id = NULL WHERE company_id = ? AND hold_order_id = ?');
  const delHold = db.prepare('DELETE FROM hold_orders WHERE id = ? AND company_id = ?');

  const num = (v) => Number(v) || 0;
  const results = [];

  for (const entry of holds) {
    const holdId = entry.hold_id || entry.hold?.id;
    if (!holdId) {
      results.push({ hold_id: null, status: 'rejected', error: 'hold_id required' });
      continue;
    }
    const owner = ownerStmt.get(holdId);
    if (owner && owner.company_id !== companyId) {
      results.push({ hold_id: holdId, status: 'rejected', error: 'hold milik perusahaan lain' });
      continue;
    }
    const ticketState = entry.queue && entry.queue.status ? entry.queue : null;
    if (entry.queue && !ticketState) {
      results.push({ hold_id: holdId, status: 'rejected', error: 'status tiket tidak dikenal' });
      continue;
    }
    if (ticketState && !QUEUE_STATUSES.includes(ticketState.status)) {
      results.push({ hold_id: holdId, status: 'rejected', error: `Status tidak dikenal: ${ticketState.status}` });
      continue;
    }

    if (entry.deleted) {
      // Settle before detaching: `settleHoldTicket` finds the ticket through the
      // hold link, which the detach below clears.
      settleHoldTicket({ companyId, holdId });
      const kept = ticketByRef.get(companyId, holdId, holdId);
      if (kept && ticketState) applyTicketState(kept.id, ticketState, companyId);
      detach.run(companyId, holdId);
      delItems.run(holdId);
      delHold.run(holdId, companyId);
      results.push({ hold_id: holdId, status: 'applied', settled: true, ticket_id: kept ? kept.id : null });
      continue;
    }

    const hold = entry.hold || {};
    upsertHold.run(
      holdId, companyId, branch_id, hold.user_id || null, hold.label ?? null,
      num(hold.subtotal), num(hold.discount), num(hold.tax), num(hold.total), hold.note ?? null,
      hold.created_at ? toSqlTimestamp(hold.created_at) : null
    );
    delItems.run(holdId);
    for (const it of entry.items || []) {
      insItem.run(
        id(), holdId, it.product_id || null, it.product_name || 'Item', it.variant_label || null,
        num(it.price), num(it.quantity) || 1, num(it.discount), it.note || null
      );
    }

    // Raise the same ticket the till raised (same lines, same station routing) the
    // first time we hear about it, then fold in the till's current state below.
    let ticketId = null;
    if (ticketState) {
      const existing = ticketByRef.get(companyId, holdId, holdId);
      ticketId = existing ? existing.id : null;
      if (ticketId) {
        // An edit to a parked cart changes what the station has to make. The till
        // re-raises its ticket for that; here the same number is kept and only the
        // lines are rewritten — and only while the bar has not started them.
        replaceHoldTicketLines({ companyId, holdId, items: entry.items || [] });
      } else {
        ticketId = enqueueFromHold({
          companyId,
          branchId: branch_id,
          userId: hold.user_id || null,
          holdId,
          hold: { label: hold.label ?? null, note: hold.note ?? null, created_at: hold.created_at || null },
          items: entry.items || []
        });
        if (ticketId) stampRef.run(holdId, ticketId);
      }
      if (ticketId) applyTicketState(ticketId, ticketState, companyId);
    }

    results.push({ hold_id: holdId, status: 'applied', settled: false, ticket_id: ticketId });
  }

  res.json({
    total: results.length,
    applied: results.filter((r) => r.status === 'applied').length,
    results
  });
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

/* ------------------------------- ASSETS ------------------------------- */
// Product photos and staff avatars are files, not columns: `products.image_url` holds
// `/uploads/p_<uuid>.png`. The bootstrap payload ships that path, and a till serves
// `/uploads` from its own data directory — which starts empty. So a fresh till had a
// complete catalog whose every photo rendered as a broken image, with no error
// anywhere: the browser was asking the local service for a file nobody had copied.
//
// Two endpoints fix that, and they are deliberately separate from the snapshot. Inline
// base64 in `/sync/bootstrap` would multiply a 200 KB photo by 1.37 and push a shop's
// whole catalogue through one JSON body on every sync; a manifest plus per-file pull
// instead lets the till fetch only the files it is missing, cache them on disk, and
// re-check cheaply next time.

/**
 * GET /sync/assets?branch_id=
 *
 * Manifest of the image files the snapshot for this branch refers to: each active,
 * branch-available product's photo plus every active staff avatar. Sized in bytes so
 * the till can tell a file it already has (same size, same random name) from one it
 * must download.
 *
 * Scoped exactly like `/sync/bootstrap`, so the till is never told about a file for a
 * product it does not sell. `missing` names files a row points at but that are gone
 * from disk — reported rather than hidden, because a product page showing a broken
 * image is the visible symptom of exactly that.
 */
router.get('/sync/assets', authRequired, wrap((req, res) => {
  const { branch_id } = req.query;
  if (!branch_id) return badRequest(res, 'branch_id required');
  if (!assertBranchAccess(req, res, branch_id)) return;

  const rows = db
    .prepare(
      `SELECT p.image_url AS url
         FROM products p
         LEFT JOIN branch_products bp ON bp.product_id = p.id AND bp.branch_id = ?
        WHERE p.company_id = ? AND p.is_active = 1 AND COALESCE(bp.is_available, 1) = 1
          AND p.image_url LIKE '/uploads/%'
       UNION
       SELECT u.avatar_url AS url
         FROM users u
        WHERE u.branch_id = ? AND u.is_active = 1 AND u.avatar_url LIKE '/uploads/%'`
    )
    .all(branch_id, req.user.company_id, branch_id);

  const files = [];
  const missing = [];
  let bytes = 0;
  for (const { url } of rows) {
    // `image_url` is free text: anything that is not a plain `/uploads/<name>` (an
    // absolute URL, a stray data URI, a path traversal attempt) simply has no file
    // here, so it is skipped instead of being guessed at.
    const name = nameFromUrl(url);
    const full = name ? uploadPath(name) : null;
    if (!name || !full) continue;
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      missing.push(name);
      continue;
    }
    files.push({ name, url: `/uploads/${name}`, size });
    bytes += size;
  }

  res.json({ branch_id, files, count: files.length, bytes, missing });
}));

/**
 * GET /sync/assets/:name — one image, as bytes.
 *
 * Authenticated rather than taking the `/uploads` shortcut: the static mount is public
 * (a till renders `<img src>` without a token), but a *replication* pull is a device
 * action, so it runs with the till's paired credential and stays inside the same
 * permission story as the rest of the sync surface. The name comes off the URL, so it
 * goes through `uploadPath`, which refuses separators, `..` and anything that is not a
 * bare file name.
 */
router.get('/sync/assets/:name', authRequired, wrap((req, res) => {
  const full = uploadPath(req.params.name);
  if (!full) return badRequest(res, 'Nama file tidak valid');
  let size = 0;
  try {
    size = fs.statSync(full).size;
  } catch {
    return notFound(res, 'Gambar tidak ditemukan di server pusat');
  }
  res.setHeader('Content-Type', contentTypeOf(req.params.name));
  res.setHeader('Content-Length', String(size));
  res.send(fs.readFileSync(full));
}));

/**
 * Settings a till needs to operate, and nothing more.
 *
 * `/sync/bootstrap` used to return every row in `settings` to any caller with
 * branch access. That is harmless only for as long as the table holds nothing
 * sensitive — the moment a payment key or the edge upstream credentials land
 * there, they would silently ship to every till. An allowlist keeps that from
 * becoming someone's bad afternoon later.
 *
 * Keys are grouped by who consumes them:
 *  - till identity/display: currency, locale, receipt_footer, tax_percent
 *  - till-side policy:      allow_negative_stock (the till enforces it locally)
 */
const TILL_SETTING_KEYS = [
  'currency',
  'locale',
  'receipt_footer',
  'tax_percent',
  'allow_negative_stock',
  'low_stock_default'
];

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
  // Nested under each product by the response below. `is_active = 1` only: a
  // variant the shop switched off must not reach the till, and the till
  // deactivates any local variant the snapshot no longer lists, so a toggle here
  // takes effect on the next sync instead of lingering as a stale option.
  const variants = db
    .prepare(
      `SELECT v.* FROM product_variants v JOIN products p ON p.id = v.product_id
       WHERE p.company_id = ? AND v.is_active = 1 ORDER BY v.sort_order`
    )
    .all(req.user.company_id);
  const categories = db.prepare('SELECT * FROM categories WHERE company_id = ? ORDER BY name').all(req.user.company_id);

  // Custom roles, shipped because `users.role` is only a string.
  //
  // Without this, the till replicated the roster but nobody's permissions: a
  // staff member assigned a custom role unlocked the till and then had every
  // guarded page bounce them to the dashboard, with nothing on screen explaining
  // why. The role resolved to `[]` because the replica had no `roles` row to
  // resolve it against — a failure that only appears offline, in the field.
  //
  // System roles are deliberately absent: they live in code (`permissions.js`) on
  // both sides, so shipping them would only invite the two copies to drift.
  // `company_id IS NULL` is included for parity with `getPermissions`, which
  // accepts a global role row as a fallback.
  const roles = db
    .prepare('SELECT name, permissions FROM roles WHERE company_id = ? OR company_id IS NULL ORDER BY name')
    .all(req.user.company_id)
    .map((r) => {
      let permissions = [];
      try {
        const parsed = JSON.parse(r.permissions || '[]');
        if (Array.isArray(parsed)) permissions = parsed;
      } catch {
        // A corrupt row must not take the whole bootstrap down: the till then
        // sees a role that grants nothing, which is the safe direction.
        permissions = [];
      }
      return { name: r.name, permissions };
    });

  res.json({
    synced_at: new Date().toISOString(),
    company: {
      id: company.id,
      name: company.name,
      currency: company.currency || 'IDR',
      tax_percent: company.tax_percent || 0,
      // The till resolves "today" for its reports with this, so dropping it here
      // made every edge report fall back to UTC and disagree with the cloud.
      timezone: company.timezone || null
    },
    branch: { id: branch.id, name: branch.name, address: branch.address, phone: branch.phone },
    categories,
    roles,
    products: products.map((p) => ({ ...p, variants: variants.filter((v) => v.product_id === p.id) })),
    settings: Object.fromEntries(
      db
        .prepare(`SELECT key, value FROM settings WHERE key IN (${TILL_SETTING_KEYS.map(() => '?').join(',')})`)
        .all(...TILL_SETTING_KEYS)
        .map((s) => [s.key, s.value])
    )
  });
}));

/**
 * GET /sync/pin-users?branch_id=
 *
 * The branch's staff roster for a till's replica: every active user in the
 * branch, with `pin_hash` when they have set one. This is the only place a
 * `pin_hash` leaves the cloud.
 *
 * It returns users *without* a PIN too, on purpose. Replicating only PIN-holders
 * meant a manager who had never set a PIN silently vanished from the till: they
 * could not unlock it, and the offline staff picker omitted them with no
 * explanation. The till now mirrors the branch roster and the offline screen
 * shows who can actually be used.
 *
 * `password_hash` is deliberately absent and must stay that way. A PIN is 10,000
 * candidates, but an account password is the real credential — shipping its hash
 * would make every till's SQLite file an offline-crackable credential store. The
 * replica stores an unusable sentinel instead, so offline login is PIN-only.
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
       WHERE branch_id = ? AND is_active = 1
       ORDER BY name`
    )
    .all(branch_id);

  res.json(rows);
}));

export default router;

