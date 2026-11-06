import express from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import {
  authRequired, requirePermission, signToken, getPermissions, audit, issueRefreshToken,
  revokeRefreshToken, rotateRefreshToken, isLocked, recordAttempt, lockInfo, revokeAllUserTokens
} from '../auth.js';
import { publicUser, badRequest, wrap } from '../lib/helpers.js';
import { bootstrapCompany } from '../lib/bootstrap.js';
import { isEdge } from '../edge.js';

const router = express.Router();

function authPayload(user, deviceId = null) {
  return {
    token: signToken(user),
    ...issueRefreshToken(user, deviceId),
    user: publicUser(user),
    permissions: getPermissions(user.role, user.company_id)
  };
}

/**
 * Whether this server may still create a company.
 *
 * The till runs the very same route, but its `companies` table is a *replica* of
 * the cloud's: a second row there is not a new signup, it is a phantom tenant
 * holding `super_admin` over the local service — every permission, the paired
 * cloud token, the outbox — and no bootstrap ever removes it. So a till allows
 * registration exactly once, during first-run setup while the table is still
 * empty; that one registration is the only way to obtain the `device.manage`
 * session which `/api/edge/pair` requires, so it cannot simply be switched off.
 *
 * The cloud keeps ordinary self-service signup unless the operator closes it with
 * `ALLOW_SIGNUP=0`, which is what a single-tenant install (the company is already
 * registered) wants.
 *
 * Exported because `GET /api/health` reports it: the login page hides the Register
 * tab when it is false, and the route refuses anyway.
 */
export function registrationState() {
  if (isEdge()) {
    const company = db.prepare('SELECT name FROM companies LIMIT 1').get();
    return company
      ? { open: false, mode: 'edge', reason: 'perangkat-sudah-terdaftar', company: company.name }
      : { open: true, mode: 'edge', reason: null, company: null };
  }
  const closed = /^(0|false|off|no)$/i.test(String(process.env.ALLOW_SIGNUP ?? ''));
  return { open: !closed, mode: 'cloud', reason: closed ? 'signup-diminta-oleh-operator' : null, company: null };
}

router.post('/register', wrap((req, res) => {
  // Refused before touching `companies`, so a blocked attempt leaves no trace.
  const state = registrationState();
  if (!state.open) {
    return res.status(state.mode === 'edge' ? 409 : 403).json({
      error:
        state.mode === 'edge'
          ? `Perangkat ini sudah terdaftar${state.company ? ` pada perusahaan "${state.company}"` : ''}. ` +
            'Pendaftaran hanya bisa dilakukan sekali saat penyiapan awal perangkat. ' +
            'Tambahkan pengguna dari server pusat.'
          : 'Pendaftaran perusahaan baru dinonaktifkan oleh administrator server.'
    });
  }
  const { company_name, name, email, password } = req.body;
  if (!company_name || !name || !email || !password)
    return badRequest(res, 'company_name, name, email, password required');
  if (String(password).length < 6) return badRequest(res, 'Password minimal 6 karakter');
  if (db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(email))
    return res.status(409).json({ error: 'Email already registered' });
  const user = bootstrapCompany({ companyName: company_name, name, email, password });
  audit({ company_id: user.company_id, user_id: user.id, action: 'company.register', entity: 'company', entity_id: user.company_id, ip: req.ip });
  res.status(201).json(authPayload(user));
}));

router.post('/login', wrap((req, res) => {
  const { email, password, device_id } = req.body;
  if (!email || !password) return badRequest(res, 'email & password required');
  if (isLocked(email)) return res.status(429).json({ error: 'Terlalu banyak percobaan login. Coba lagi nanti.', lock: lockInfo() });

  const user = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email);
  if (!user || !user.is_active || !bcrypt.compareSync(password, user.password_hash)) {
    recordAttempt(email, false, req.ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  recordAttempt(email, true, req.ip);
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  // Device binding: refuse login from a device revoked by the head office.
  if (device_id) {
    const dev = db.prepare('SELECT * FROM devices WHERE id = ?').get(device_id);
    if (dev && !dev.is_active) return res.status(403).json({ error: 'Perangkat ini dinonaktifkan oleh pusat' });
    if (dev) db.prepare("UPDATE devices SET last_seen = datetime('now') WHERE id = ?").run(dev.id);
  }
  audit({ company_id: user.company_id, branch_id: user.branch_id, user_id: user.id, action: 'login', entity: 'user', entity_id: user.id, ip: req.ip });
  res.json(authPayload(user, device_id || null));
}));

// PIN quick login / shift handover — the cashier screen stays unlocked on the device.
router.post('/pin-login', wrap((req, res) => {
  const { user_id, pin } = req.body;
  if (!user_id || !pin) return badRequest(res, 'user_id & pin required');
  if (isLocked(`pin:${user_id}`)) return res.status(429).json({ error: 'PIN terkunci sementara karena percobaan gagal' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
  if (!user || !user.is_active || !user.pin_hash || !bcrypt.compareSync(String(pin), user.pin_hash)) {
    recordAttempt(`pin:${user_id}`, false, req.ip);
    return res.status(401).json({ error: 'PIN salah' });
  }
  recordAttempt(`pin:${user_id}`, true, req.ip);
  audit({ company_id: user.company_id, branch_id: user.branch_id, user_id: user.id, action: 'login.pin', entity: 'user', entity_id: user.id, ip: req.ip });
  res.json(authPayload(user));
}));

// Cashiers available for PIN handover on a given device/branch.
router.get('/pin-users', wrap((req, res) => {
  const branchId = req.query.branch_id;
  if (!branchId) return badRequest(res, 'branch_id required');
  const rows = db.prepare(
    `SELECT id, name, role, avatar_url FROM users
     WHERE branch_id = ? AND is_active = 1 AND pin_hash IS NOT NULL ORDER BY name`
  ).all(branchId);
  res.json(rows);
}));

// Public branch list for the PIN unlock screen (only outlets that have PIN users).
// Exposes nothing beyond id + name so the till can show a branch picker before login.
router.get('/pin-branches', wrap((req, res) => {
  const rows = db
    .prepare(
      `SELECT DISTINCT b.id, b.name FROM branches b
       JOIN users u ON u.branch_id = b.id
       WHERE b.is_active = 1 AND u.is_active = 1 AND u.pin_hash IS NOT NULL
       ORDER BY b.name`
    )
    .all();
  res.json({ branches: rows });
}));


router.post('/refresh', wrap((req, res) => {
  const rotated = rotateRefreshToken(req.body.refresh_token);
  if (!rotated) return res.status(401).json({ error: 'Invalid refresh token' });
  res.json(authPayload(rotated.user));
}));

router.post('/logout', wrap((req, res) => {
  revokeRefreshToken(req.body.refresh_token);
  res.json({ ok: true });
}));

router.get('/me', authRequired, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const branches = db.prepare('SELECT id, name FROM branches WHERE company_id = ? AND is_active = 1 ORDER BY name').all(user.company_id);
  // The company's timezone belongs in the session payload: every screen formats
  // timestamps on the shop's clock, and a till whose OS is set to another zone
  // must not shift the day or the receipt time. One fetch, cached with the
  // session so offline boot keeps the right zone too.
  const company = db.prepare('SELECT name, timezone FROM companies WHERE id = ?').get(user.company_id) || {};
  res.json({
    user: publicUser(user),
    permissions: getPermissions(user.role, user.company_id),
    branches,
    lock: lockInfo(),
    company: { name: company.name || null, timezone: company.timezone || 'UTC' }
  });
});

router.put('/me/password', authRequired, wrap((req, res) => {
  const { current_password, new_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!bcrypt.compareSync(current_password || '', user.password_hash))
    return res.status(400).json({ error: 'Password lama salah' });
  if (!new_password || String(new_password).length < 6) return badRequest(res, 'Password baru minimal 6 karakter');
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .run(bcrypt.hashSync(new_password, 10), user.id);
  revokeAllUserTokens(user.id);
  audit({ company_id: user.company_id, user_id: user.id, action: 'user.password_change', entity: 'user', entity_id: user.id, ip: req.ip });
  res.json({ ok: true });
}));

router.put('/me/pin', authRequired, wrap((req, res) => {
  const { password, pin } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!bcrypt.compareSync(password || '', user.password_hash))
    return res.status(400).json({ error: 'Password salah' });
  if (!/^\d{4,6}$/.test(String(pin || ''))) return badRequest(res, 'PIN harus 4–6 digit angka');
  db.prepare("UPDATE users SET pin_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .run(bcrypt.hashSync(String(pin), 10), user.id);
  audit({ company_id: user.company_id, user_id: user.id, action: 'user.pin_set', entity: 'user', entity_id: user.id });
  res.json({ ok: true });
}));

/* --------------------------- company profile --------------------------- */

router.get('/company', authRequired, (req, res) => {
  res.json(db.prepare('SELECT * FROM companies WHERE id = ?').get(req.user.company_id));
});

router.put('/company', authRequired, requirePermission('company.manage'), wrap((req, res) => {
  const { name, address, phone, legal_info, currency, timezone, tax_percent, logo_url } = req.body;
  db.prepare(
    `UPDATE companies SET name = COALESCE(?, name), address = COALESCE(?, address), phone = COALESCE(?, phone),
       legal_info = COALESCE(?, legal_info), currency = COALESCE(?, currency), timezone = COALESCE(?, timezone),
       tax_percent = COALESCE(?, tax_percent), logo_url = COALESCE(?, logo_url) WHERE id = ?`
  ).run(name, address, phone, legal_info, currency, timezone, tax_percent, logo_url, req.user.company_id);
  audit({ company_id: req.user.company_id, user_id: req.user.sub, action: 'company.update', entity: 'company', entity_id: req.user.company_id, detail: req.body, ip: req.ip });
  res.json(db.prepare('SELECT * FROM companies WHERE id = ?').get(req.user.company_id));
}));

export default router;

