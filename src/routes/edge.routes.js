// Edge-only endpoints. Mounted by server.js exclusively when EDGE_MODE is on, so
// the cloud API surface is unchanged.
//
//   GET  /api/edge/health      liveness + queue depth (polled by the Tauri supervisor)
//   GET  /api/edge/info        which mode/upstream/device this service runs as
//   GET  /api/edge/cloud-branches  the cloud's branch list, for the setup picker
//   PUT  /api/edge/config      set the cloud address this till should sync to
//                              (changing it needs device.manage and drops the pairing)
//   POST /api/edge/pair        log in to the cloud once, keep its token for sync
//   POST /api/edge/bootstrap   pull catalog + stock + PIN users into the replica
//   GET  /api/edge/queue       outbox summary (sync badge)
//   GET  /api/edge/queue/problems  rows stuck in conflict/rejected for review
//   POST /api/edge/queue/retry requeue a refused sale after a manual fix
//   POST /api/edge/drain       replay now instead of waiting for the timer
//   POST /api/edge/unlock      offline PIN login from the cached credentials
//   POST /api/auth/cache-logins  mirror the cloud's device-login list locally

import express from 'express';
import { db, DATA_DIR } from '../db.js';
import { authRequired, getPermissions, audit, signToken, requirePermission } from '../auth.js';
import { publicUser, wrap, badRequest } from '../lib/helpers.js';
import { outboxSummary, outboxProblems, retryOutboxRow, drainOnce } from '../lib/edgeOutbox.js';
import { drainQueueOnce, queueSyncSummary } from '../lib/edgeQueueSync.js';
import { drainHoldsOnce, holdSyncSummary } from '../lib/edgeHoldSync.js';
import { upstreamUrl, upstreamRequest } from '../lib/edgeUpstream.js';
import { applyBootstrap } from '../lib/edgeBootstrap.js';
import { verifyPinHash } from '../edge.js';

const router = express.Router();

const setting = (key) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
};

const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value === null || value === undefined ? null : String(value));

/** Cloud base URL this till pushes to, or null when it is stand-alone. */
export { upstreamUrl };

/** Address as stored/compared: no trailing slash, so `x/` and `x` are one value. */
const normUpstream = (u) => (u ? String(u).replace(/\/+$/, '') : null);

/**
 * Call the cloud with this till's credentials (see lib/edgeUpstream.js).
 *
 * `token` lets a foreground request use the caller's own token instead of the
 * paired device token, which keeps the cloud's permission checks meaningful.
 */
async function upstreamFetch(path, opts = {}) {
  return upstreamRequest(path, opts);
}

/**
 * A transport failure means "no internet", which needs a different message to a
 * refusal.
 *
 * A cloud-side `401` is singled out because it is the one refusal that looks
 * like an internet problem but is not: the stored `edge_device_token` is
 * rejected because the paired admin no longer exists (the cloud DB was
 * reseeded) or the token expired. Retrying will never fix it — the till has to
 * pair again — so saying so beats telling the operator to check their Wi-Fi.
 */
function transportMessage(e) {
  const raw = String(e?.message || e);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|socket/i.test(raw)) {
    return 'Tidak dapat menghubungi server pusat. Periksa koneksi internet.';
  }
  if (/user inactive or not found|invalid or expired token|tenant mismatch/i.test(raw)) {
    return 'Kredensial perangkat ditolak server pusat (akun tidak ada lagi atau sudah kedaluwarsa). Hubungkan ulang perangkat ini.';
  }
  return raw;
}

/* ------------------------------ HEALTH ------------------------------ */

router.get('/edge/health', (req, res) =>
  res.json({
    ok: true,
    service: 'pos-backend',
    mode: 'edge',
    time: new Date().toISOString(),
    upstream: upstreamUrl(),
    queue: outboxSummary(req.query.branch_id || null),
  })
);

router.get('/edge/info', (req, res) =>
  res.json({
    mode: 'edge',
    data_dir: DATA_DIR,
    upstream: upstreamUrl(),
    device_id: setting('edge_device_id'),
    company_id: setting('edge_company_id'),
    branch_id: setting('edge_branch_id'),
    cached_logins: db.prepare('SELECT COUNT(*) AS n FROM users WHERE pin_hash IS NOT NULL AND is_active = 1').get().n,
    queue: outboxSummary(null),
  })
);

/* ------------------------------ CONFIG ------------------------------ */

router.put('/edge/config', authRequired, wrap((req, res) => {
  const { upstream, device_id, branch_id } = req.body || {};
  const next = upstream === undefined ? undefined : normUpstream(upstream);

  // Repointing the till is device management, not a preference.
  //
  // The stored `edge_device_token` is a *cloud-issued* bearer for the paired
  // owner, and `upstreamFetch` presents it to whatever address is stored here. If
  // any signed-in employee could change that address, the next drain or
  // `/edge/cloud-branches` call would hand the owner's cloud token to whatever host
  // they typed in. So a genuine change needs `device.manage` AND drops the old
  // credentials: a token minted by one host is never presented to another. Sync
  // resumes after `/edge/pair`.
  //
  // A same-value re-send stays open to any session, because that is exactly what
  // the app does on every login (`configureEdgeUpstream`) and on branch switch.
  if (next !== undefined && next !== normUpstream(upstreamUrl())) {
    const perms = req.permissions || getPermissions(req.user.role, req.user.company_id);
    if (!perms.includes('device.manage'))
      return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    setSetting('edge_upstream_url', next);
    setSetting('edge_device_token', null);
    setSetting('edge_refresh_token', null);
    setSetting('edge_device_user', null);
    setSetting('edge_paired_at', null);
  } else if (next !== undefined) {
    setSetting('edge_upstream_url', next);
  }

  if (device_id !== undefined) setSetting('edge_device_id', device_id || null);
  if (branch_id !== undefined) setSetting('edge_branch_id', branch_id || null);
  // The authoritative writers are `/edge/pair` and the bootstrap snapshot. A
  // login-time call must not overwrite this with the caller's own company.
  if (!setting('edge_company_id')) setSetting('edge_company_id', req.user.company_id);

  // Deliberately does NOT store the caller's token: it was minted by this service
  // with the local secret and the cloud would reject it. Cloud credentials come
  // from POST /edge/pair, which logs in upstream and keeps that token instead.

  res.json({ ok: true, upstream: upstreamUrl() });
}));

/* ------------------------------ QUEUE ------------------------------ */

router.get('/edge/queue', authRequired, wrap((req, res) =>
  res.json(outboxSummary(req.query.branch_id || null))
));

router.get('/edge/queue/problems', authRequired, wrap((req, res) => res.json(outboxProblems())));

/**
 * POST /edge/queue/retry  { client_uuid }
 *
 * Requeues a sale the cloud refused, after the cause was fixed (typically stock,
 * which is what most `conflict` rows are). The UI's queue review calls this.
 */
router.post('/edge/queue/retry', authRequired, requirePermission('transaction.void'), wrap((req, res) => {
  const { client_uuid } = req.body || {};
  if (!client_uuid) return badRequest(res, 'client_uuid required');
  const ok = retryOutboxRow(client_uuid);
  if (!ok) return res.status(404).json({ error: 'Transaksi tidak ditemukan atau sudah terkirim' });
  res.json({ ok: true, queue: outboxSummary(null) });
}));

router.post('/edge/drain', authRequired, wrap(async (req, res) => {
  const upstream = upstreamUrl();
  if (!upstream) return badRequest(res, 'Server pusat belum diatur');
  const branchId = req.body && req.body.branch_id ? req.body.branch_id : setting('edge_branch_id');
  if (!branchId) return badRequest(res, 'branch_id required');

  // Replay with the paired cloud token. The caller's bearer was minted locally,
  // so the cloud would reject it — a manual "Kirim sekarang" therefore works as
  // long as the till was paired once, with or without a user logged in.
  const post = (path, body) => upstreamFetch(path, { method: 'POST', body });

  try {
    const result = await drainOnce(branchId, post);
    // Then parked carts, then ticket status changes. A hiccup in either must not fail
    // the sale drain the caller asked for — the worker retries each lane on its own
    // schedule. Holds go first so a hold ticket exists before it is patched.
    let holdSync = { applied: 0, examined: 0 };
    try {
      holdSync = await drainHoldsOnce(branchId, post);
    } catch {
      /* keep the sale result; the hold lane backs off and retries */
    }
    let queueSync = { applied: 0, examined: 0 };
    try {
      queueSync = await drainQueueOnce(branchId, post);
    } catch {
      /* keep the sale result; the queue lane backs off and retries */
    }
    res.json({
      ...result,
      holdSync,
      holdSyncPending: holdSyncSummary(branchId).pending,
      queueSync,
      queueSyncPending: queueSyncSummary(branchId).pending,
      queue: outboxSummary(branchId)
    });
  } catch (e) {
    res.status(502).json({ error: transportMessage(e), queue: outboxSummary(branchId) });
  }
}));

/**
 * GET /edge/cloud-branches
 *
 * The cloud's branch list, so the setup screen can offer a dropdown instead of
 * asking someone to paste a branch id. Reads through the paired token: whoever
 * provisioned this till can only see the branches they may already reach.
 *
 * Requires pairing, because that is what provides the credential. Callers get a
 * `paired: false` flag rather than an error so the UI can prompt for step one
 * instead of showing a raw failure.
 */
router.get('/edge/cloud-branches', authRequired, wrap(async (req, res) => {
  if (!upstreamUrl()) {
    return res.json({ paired: false, upstream: null, branches: [], reason: 'Server pusat belum diatur' });
  }
  if (!setting('edge_device_token')) {
    return res.json({ paired: false, upstream: upstreamUrl(), branches: [], reason: 'Perangkat belum terhubung' });
  }
  try {
    const rows = await upstreamFetch('/api/branches');
    const list = Array.isArray(rows) ? rows : [];
    res.json({
      paired: true,
      upstream: upstreamUrl(),
      current_branch_id: setting('edge_branch_id'),
      paired_user: setting('edge_device_user'),
      branches: list.map((b) => ({
        id: b.id,
        name: b.name,
        address: b.address ?? null,
        user_count: b.user_count ?? 0,
      })),
    });
  } catch (e) {
    res.json({ paired: true, upstream: upstreamUrl(), branches: [], reason: transportMessage(e) });
  }
}));

/**
 * POST /edge/pair  { email, password }   (runs on the TILL)
 *
 * The one-time online step that makes offline mode work.
 *
 * The till's own access tokens are minted with the *local* secret, so they mean
 * nothing to the cloud. The background worker therefore needs a cloud-issued
 * token, obtained here once while the internet is up and stored beside the
 * database. From then on the till can bootstrap catalog + PINs and replay queued
 * sales without anyone logging in again.
 *
 * Re-running this refreshes the stored token (e.g. after a password change or
 * when the old one expires).
 */
/**
 * POST /edge/pair  { email, password }
 *
 * Provisioning a till is device management, so it needs a `device.manage`
 * session. Pairing also decides *whose* cloud token the till syncs with, which
 * is too much authority to hand to any cashier who can reach the settings
 * screen. The paired user's cloud token is what bootstrap then uses to fetch
 * PIN hashes, so gating both keeps them in step: whoever may pair may also
 * provision offline logins.
 */
router.post('/edge/pair', authRequired, requirePermission('device.manage'), wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return badRequest(res, 'email & password required');
  if (!upstreamUrl()) return badRequest(res, 'Server pusat belum diatur');

  let data;
  try {
    data = await upstreamFetch('/api/auth/login', { method: 'POST', body: { email, password }, token: null, anonymous: true });
  } catch (e) {
    return res.status(401).json({ error: transportMessage(e) });
  }
  if (!data?.token) return res.status(401).json({ error: 'Server pusat tidak mengembalikan token' });

  setSetting('edge_device_token', data.token);
  // The cloud rotates refresh tokens, and this is the one that keeps the drain
  // alive after the access token expires (see lib/edgeUpstream.js). An older cloud
  // that does not issue one just leaves the key unset.
  if (data.refresh_token) setSetting('edge_refresh_token', data.refresh_token);
  setSetting('edge_device_user', email);
  setSetting('edge_company_id', data.user?.company_id || null);
  if (data.user?.branch_id) setSetting('edge_branch_id', data.user.branch_id);
  setSetting('edge_paired_at', new Date().toISOString());

  res.json({ ok: true, user: data.user?.name || email, branch_id: data.user?.branch_id || null });
}));

/**
 * POST /edge/bootstrap  { branch_id? }
 *
 * Pull the cloud's catalog, stock, custom roles and PIN users into the local
 * replica. This is the step that makes a fresh till usable offline: without it
 * `users` is empty and `/edge/unlock` cannot verify anybody's PIN, without the
 * roles a custom-role user resolves to zero permissions, and without each
 * product's variants the POS loses every "Large +4.000" option and charges the
 * base price instead.
 *
 * Requires both an online connection and a valid cloud token, so it only ever
 * succeeds while the device is genuinely reachable.
 */
router.post('/edge/bootstrap', authRequired, wrap(async (req, res) => {
  if (!upstreamUrl()) return badRequest(res, 'Server pusat belum diatur');
  const branchId = (req.body && req.body.branch_id) || setting('edge_branch_id');
  if (!branchId) return badRequest(res, 'branch_id required');

  // No `token` passed: upstreamFetch falls back to the paired cloud token. The
  // caller's own bearer was minted locally and the cloud rejects it.
  try {
    const snapshot = await upstreamFetch(`/api/sync/bootstrap?branch_id=${encodeURIComponent(branchId)}`);
    // The PIN list carries hashes, so the cloud only returns it to a caller with
    // access to this branch. A user who lacks it still bootstraps the catalog;
    // they simply cannot enable offline login for the till.
    let users = [];
    let usersError = null;
    try {
      users = await upstreamFetch(`/api/sync/pin-users?branch_id=${encodeURIComponent(branchId)}`);
      if (!Array.isArray(users)) users = [];
    } catch (e) {
      usersError = transportMessage(e);
    }

    // Remember which company the caller's token was signed for *before* the
    // bootstrap runs. `pair` has already stored the cloud's company in
    // `edge_company_id`, so that setting cannot tell us whether the caller's own
    // bearer went stale — only the caller's token can.
    const callerCompany = req.user.company_id;

    const summary = applyBootstrap({ snapshot, users, branchId });
    setSetting('edge_branch_id', branchId);

    // Bootstrap can re-point the caller's own row at the cloud's company (see
    // applyBootstrap: leaving `company_id` stale is what made every page 403). The
    // bearer that arrived here was signed with the *old* company, so authRequired
    // compares it against the row on the next request and rejects it as a 'Tenant
    // mismatch' — the till would be locked out of its own service mid-setup. Hand
    // back a token signed for the row as it is now, so the caller just swaps it in.
    let token;
    const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
    if (me && me.company_id !== callerCompany) token = signToken(me);

    res.json({ ok: true, ...summary, users_error: usersError, token });
  } catch (e) {
    res.status(502).json({ error: transportMessage(e) });
  }
}));

/* ------------------------------ OFFLINE LOGIN ------------------------------ */

const MAX_FAILS = 5;
const WINDOW_MINUTES = 15;
const LOCK_MINUTES = 15;

function recentFails(userId) {
  return db
    .prepare(
      "SELECT COUNT(*) AS n FROM edge_login_attempts WHERE user_id = ? AND success = 0 AND created_at > datetime('now', ?)"
    )
    .get(userId, `-${WINDOW_MINUTES} minutes`).n;
}

function lockedUntil(userId) {
  const last = db
    .prepare(
      "SELECT created_at FROM edge_login_attempts WHERE user_id = ? AND success = 0 AND created_at > datetime('now', ?) ORDER BY created_at DESC LIMIT 1"
    )
    .get(userId, `-${WINDOW_MINUTES} minutes`);
  if (!last || recentFails(userId) < MAX_FAILS) return null;
  const until = new Date(new Date(last.created_at.replace(' ', 'T') + 'Z').getTime() + LOCK_MINUTES * 60_000);
  return until.getTime() > Date.now() ? until.toISOString() : null;
}

/**
 * POST /edge/unlock  { user_id, pin }
 *
 * The offline cold-start equivalent of POST /auth/pin-login. The edge service
 * holds a replica of the cloud database, so it verifies against the very same
 * bcrypt `pin_hash` the cloud uses — no second credential to keep in sync.
 *
 * PRECONDITION: the row must have been pulled from the cloud at least once while
 * online (see /api/sync/bootstrap). A till that has never synced has no users and
 * therefore cannot authenticate anybody, which is the correct failure mode.
 */
router.post('/edge/unlock', wrap((req, res) => {
  const { user_id, pin } = req.body || {};
  if (!user_id || !pin) return badRequest(res, 'user_id & pin required');

  const locked = lockedUntil(user_id);
  if (locked) return res.status(429).json({ error: 'Terlalu banyak percobaan PIN. Coba lagi nanti.', locked_until: locked });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
  const ok = Boolean(user && user.is_active && verifyPinHash(pin, user.pin_hash));
  db.prepare('INSERT INTO edge_login_attempts (user_id, success) VALUES (?, ?)').run(user_id, ok ? 1 : 0);
  if (!ok) {
    // A user replicated without a PIN is a distinct failure from a wrong PIN:
    // no amount of retrying helps, they have to set a PIN in the cloud. Say so
    // rather than charging their lockout counter for an impossible attempt.
    if (user && user.is_active && !user.pin_hash) {
      return res.status(409).json({
        error: 'Pengguna ini belum mengatur PIN. Atur PIN di server pusat, lalu sinkronkan ulang perangkat ini.',
        no_pin: true,
      });
    }
    return res.status(401).json({
      error: user ? 'PIN salah' : 'Pengguna ini belum tersedia di perangkat ini. Login online sekali dulu.',
      remaining: Math.max(0, MAX_FAILS - recentFails(user_id)),
    });
  }

  // Mirror the audit trail the cloud would have written, so a shift handover done
  // offline still shows up in the local audit log.
  audit({
    company_id: user.company_id,
    branch_id: user.branch_id,
    user_id: user.id,
    action: 'login.pin.offline',
    entity: 'user',
    entity_id: user.id,
    ip: req.ip,
  });

  res.json({
    token: signToken(user),
    user: publicUser(user),
    permissions: getPermissions(user.role, user.company_id),
    offline: true,
  });
}));

/**
 * GET /edge/pin-branches and /edge/pin-users
 *
 * Offline copies of the public PIN-login screens. They read the replicated
 * database, so the branch picker and cashier list render with no network.
 *
 * The branch list includes any branch that has staff, not just branches where
 * somebody holds a PIN: a branch whose staff have not set PINs yet still has to
 * appear, so the operator can see it and fix the PIN in the cloud instead of
 * concluding the replication failed.
 */
router.get('/edge/pin-branches', wrap((req, res) => {
  const rows = db
    .prepare(
      `SELECT b.id, b.name,
              (SELECT COUNT(*) FROM users u
                WHERE u.branch_id = b.id AND u.is_active = 1 AND u.pin_hash IS NOT NULL) AS pin_users
       FROM branches b
       JOIN users u ON u.branch_id = b.id
       WHERE b.is_active = 1 AND u.is_active = 1
       GROUP BY b.id, b.name
       ORDER BY b.name`
    )
    .all();
  res.json({ branches: rows });
}));

router.get('/edge/pin-users', wrap((req, res) => {
  const branchId = req.query.branch_id;
  if (!branchId) return badRequest(res, 'branch_id required');
  const rows = db
    .prepare(
      `SELECT id, name, role, avatar_url, (pin_hash IS NOT NULL) AS can_unlock
       FROM users
       WHERE branch_id = ? AND is_active = 1 ORDER BY name`
    )
    .all(branchId);
  res.json(rows.map((r) => ({ ...r, can_unlock: Boolean(r.can_unlock) })));
}));

export default router;

