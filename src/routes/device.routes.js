import express from 'express';
import crypto from 'crypto';
import { db } from '../db.js';
import { authRequired, requirePermission, audit, assertBranchAccess } from '../auth.js';
import { wrap, badRequest, notFound } from '../lib/helpers.js';

const router = express.Router();

/** GET /branches/:branchId/devices — registered POS terminals. */
router.get('/branches/:branchId/devices', authRequired, wrap((req, res) => {
  if (!assertBranchAccess(req, res, req.params.branchId)) return;
  const rows = db
    .prepare(
      `SELECT d.*, (SELECT COUNT(DISTINCT user_id) FROM refresh_tokens r
                    WHERE r.device_id = d.id AND r.revoked = 0 AND r.expires_at > datetime('now')) AS active_sessions
       FROM devices d WHERE d.branch_id = ? ORDER BY d.created_at DESC`
    )
    .all(req.params.branchId);
  res.json(rows);
}));

/**
 * POST /devices/register — called by the Tauri client on first run.
 * Re-registering the same `identifier` reuses the row (keeps sessions intact).
 */
router.post('/devices/register', authRequired, wrap((req, res) => {
  const { branch_id, name, identifier, platform, app_version } = req.body;
  if (!branch_id || !identifier) return badRequest(res, 'branch_id & identifier required');
  if (!assertBranchAccess(req, res, branch_id)) return;

  const existing = db.prepare('SELECT * FROM devices WHERE identifier = ? AND branch_id = ?').get(identifier, branch_id);
  if (existing) {
    db.prepare(
      "UPDATE devices SET name = COALESCE(?, name), platform = COALESCE(?, platform), app_version = COALESCE(?, app_version), is_active = 1, last_seen = datetime('now') WHERE id = ?"
    ).run(name || null, platform || null, app_version || null, existing.id);
    audit({ company_id: req.user.company_id, branch_id, user_id: req.user.sub, action: 'device.register', entity: 'device', entity_id: existing.id, detail: { identifier, re_registered: true }, ip: req.ip });
    return res.json(db.prepare('SELECT * FROM devices WHERE id = ?').get(existing.id));
  }

  const did = crypto.randomUUID();
  const deviceKey = crypto.randomBytes(24).toString('hex');
  db.prepare(
    `INSERT INTO devices (id, branch_id, name, identifier, platform, app_version, device_key, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(did, branch_id, name || identifier, identifier, platform || null, app_version || null, deviceKey);
  audit({ company_id: req.user.company_id, branch_id, user_id: req.user.sub, action: 'device.register', entity: 'device', entity_id: did, detail: { identifier, platform }, ip: req.ip });
  res.status(201).json(db.prepare('SELECT * FROM devices WHERE id = ?').get(did));
}));

/** POST /devices/:id/heartbeat — keeps `last_seen` fresh + reports the version. */
router.post('/devices/:id/heartbeat', authRequired, wrap((req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!d) return notFound(res, 'Device not found');
  if (!assertBranchAccess(req, res, d.branch_id)) return;
  db.prepare("UPDATE devices SET last_seen = datetime('now'), app_version = COALESCE(?, app_version) WHERE id = ?")
    .run(req.body.app_version || null, d.id);
  if (d.is_active === 0) {
    return res.status(403).json({ error: 'Perangkat dinonaktifkan admin', revoked: true, reason: d.revoked_reason });
  }
  res.json({ ok: true, server_time: new Date().toISOString() });
}));

/** POST /devices/:id/remote-logout — force logout: revokes every token of that device. */
router.post('/devices/:id/remote-logout', authRequired, requirePermission('device.manage', 'company.manage'), wrap((req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!d) return notFound(res, 'Device not found');
  if (!assertBranchAccess(req, res, d.branch_id)) return;
  const result = db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE device_id = ? AND revoked = 0").run(d.id);
  db.prepare("UPDATE devices SET revoked_reason = ? WHERE id = ?").run(req.body.reason || 'remote logout', d.id);
  audit({ company_id: req.user.company_id, branch_id: d.branch_id, user_id: req.user.sub, action: 'device.remote_logout', entity: 'device', entity_id: d.id, detail: { sessions: result.changes }, ip: req.ip });
  res.json({ ok: true, revoked_sessions: result.changes });
}));

/** PUT /devices/:id — rename / enable / disable a terminal. */
router.put('/devices/:id', authRequired, requirePermission('device.manage', 'company.manage'), wrap((req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!d) return notFound(res, 'Device not found');
  if (!assertBranchAccess(req, res, d.branch_id)) return;
  const { name, is_active, revoked_reason } = req.body;
  db.prepare('UPDATE devices SET name = COALESCE(?, name), is_active = COALESCE(?, is_active), revoked_reason = COALESCE(?, revoked_reason) WHERE id = ?')
    .run(name || null, is_active === undefined ? null : is_active ? 1 : 0, revoked_reason || null, d.id);
  if (is_active === false || is_active === 0) {
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE device_id = ? AND revoked = 0').run(d.id);
  }
  audit({ company_id: req.user.company_id, branch_id: d.branch_id, user_id: req.user.sub, action: 'device.update', entity: 'device', entity_id: d.id, detail: { name, is_active }, ip: req.ip });
  res.json(db.prepare('SELECT * FROM devices WHERE id = ?').get(d.id));
}));

export default router;
