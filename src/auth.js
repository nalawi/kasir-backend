import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { db } from './db.js';
import { ROLE_PERMISSIONS } from './permissions.js';
import { isEdge, localSecret } from './edge.js';

// In edge mode the signing key is the machine's own persisted secret, so tokens
// minted by the offline unlock (and any token this service re-signs) verify here
// with no shared configuration. The cloud deployment keeps JWT_SECRET.
const JWT_SECRET = isEdge() ? localSecret() : process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '60m';
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TTL_DAYS || 30);

// Brute-force protection: lock an identifier for LOCK_MINUTES after MAX_FAILS
// failed attempts inside the rolling window.
const MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS || 6);
const WINDOW_MINUTES = Number(process.env.LOGIN_WINDOW_MINUTES || 15);
const LOCK_MINUTES = Number(process.env.LOGIN_LOCK_MINUTES || 15);

export { ROLE_PERMISSIONS };

/* ----------------------------- tokens ----------------------------- */

export function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      company_id: user.company_id,
      branch_id: user.branch_id,
      role: user.role,
      name: user.name,
      email: user.email
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function issueRefreshToken(user, deviceId = null) {
  const raw = crypto.randomBytes(48).toString('hex');
  const expires = new Date(Date.now() + REFRESH_TTL_DAYS * 86400_000).toISOString();
  db.prepare(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, device_id, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), user.id, hashToken(raw), deviceId, expires);
  return { refresh_token: raw, refresh_expires_at: expires };
}

export function rotateRefreshToken(rawToken) {
  const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(hashToken(rawToken || ''));
  if (!row || row.revoked || row.expires_at < new Date().toISOString()) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user || !user.is_active) return null;
  db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?').run(row.id);
  return { user, ...issueRefreshToken(user, row.device_id) };
}

export function revokeRefreshToken(rawToken) {
  if (!rawToken) return;
  db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?').run(hashToken(rawToken));
}

export function revokeAllUserTokens(userId) {
  db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(userId);
}

/* ------------------------- rate limiting -------------------------- */

export function isLocked(identifier) {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
  const fails = db
    .prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE identifier = ? AND success = 0 AND created_at >= ?')
    .get(String(identifier || '').toLowerCase(), since).n;
  return fails >= MAX_FAILS;
}

export function recordAttempt(identifier, success, ip) {
  const key = String(identifier || '').toLowerCase();
  db.prepare('INSERT INTO login_attempts (id, identifier, success, ip) VALUES (?, ?, ?, ?)').run(
    crypto.randomUUID(),
    key,
    success ? 1 : 0,
    ip || null
  );
  if (success) db.prepare('DELETE FROM login_attempts WHERE identifier = ?').run(key);
  // Housekeeping: keep the attempts table small.
  db.prepare("DELETE FROM login_attempts WHERE created_at < datetime('now', '-1 day')").run();
}

export const lockInfo = () => ({ max_fails: MAX_FAILS, window_minutes: WINDOW_MINUTES, lock_minutes: LOCK_MINUTES });

/* --------------------------- permissions --------------------------- */

export function getPermissions(role, companyId = null) {
  if (ROLE_PERMISSIONS[role]) return ROLE_PERMISSIONS[role];
  // Custom role stored in the DB (company scoped).
  const row = companyId
    ? db.prepare('SELECT permissions FROM roles WHERE name = ? AND (company_id = ? OR company_id IS NULL)').get(role, companyId)
    : db.prepare('SELECT permissions FROM roles WHERE name = ? AND company_id IS NULL').get(role);
  if (!row) return [];
  try {
    const perms = JSON.parse(row.permissions || '[]');
    return Array.isArray(perms) ? perms : [];
  } catch {
    return [];
  }
}


export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db
      .prepare('SELECT id, is_active, company_id, role, branch_id FROM users WHERE id = ?')
      .get(payload.sub);
    if (!user || !user.is_active) return res.status(401).json({ error: 'User inactive or not found' });
    if (user.company_id !== payload.company_id) return res.status(401).json({ error: 'Tenant mismatch' });
    req.user = { ...payload, role: user.role, branch_id: user.branch_id };
    req.permissions = getPermissions(user.role, user.company_id);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requirePermission(...perms) {
  return (req, res, next) => {
    const userPerms = req.permissions || getPermissions(req.user.role, req.user.company_id);
    const ok = perms.some((p) => userPerms.includes(p));
    if (!ok) return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    next();
  };
}

/**
 * Branch scope resolution.
 * - Roles with `company.manage` / `report.view_all` => every branch of the company.
 * - Users flagged `multi_branch = 1` (manager assigned to several outlets) => every branch.
 * - Everyone else => only their assigned branch.
 */
export function scopedBranchIds(req) {
  const all = db.prepare('SELECT id FROM branches WHERE company_id = ?').all(req.user.company_id).map((b) => b.id);
  const perms = req.permissions || getPermissions(req.user.role, req.user.company_id);
  if (perms.includes('company.manage') || perms.includes('report.view_all')) return all;
  const user = db.prepare('SELECT branch_id, multi_branch FROM users WHERE id = ?').get(req.user.sub);
  if (!user) return [];
  if (user.multi_branch) return all;
  return user.branch_id ? [user.branch_id] : [];
}

export function canAccessBranch(req, branchId) {
  return scopedBranchIds(req).includes(branchId);
}

/** Guard for write endpoints. Sends the 403 itself and returns false when denied. */
export function assertBranchAccess(req, res, branchId) {
  if (!canAccessBranch(req, branchId)) {
    res.status(403).json({ error: 'Forbidden: branch not in your scope' });
    return false;
  }
  return true;
}

export function audit({ company_id, branch_id, user_id, action, entity, entity_id, detail, ip }) {
  db.prepare(
    `INSERT INTO audit_logs (id, company_id, branch_id, user_id, action, entity, entity_id, detail, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    crypto.randomUUID(),
    company_id || null,
    branch_id || null,
    user_id || null,
    action,
    entity || null,
    entity_id || null,
    detail ? JSON.stringify(detail) : null,
    ip || null
  );
}

export function auditFromReq(req, action, entity, entityId, detail) {
  audit({
    company_id: req.user.company_id,
    branch_id: (detail && detail.branch_id) || req.user.branch_id,
    user_id: req.user.sub,
    action,
    entity,
    entity_id: entityId,
    detail,
    ip: req.ip
  });
}
