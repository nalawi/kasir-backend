import express from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { authRequired, requirePermission, audit, getPermissions, scopedBranchIds, revokeAllUserTokens, ROLE_PERMISSIONS } from '../auth.js';
import { catalog, ALL_PERMISSIONS } from '../permissions.js';
import { id, wrap, badRequest, notFound } from '../lib/helpers.js';

const router = express.Router();

/* ------------------------------ BRANCHES ------------------------------ */

router.get('/branches', authRequired, (req, res) => {
  const rows = db
    .prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM users u WHERE u.branch_id = b.id) AS user_count,
              (SELECT COUNT(*) FROM devices d WHERE d.branch_id = b.id AND d.is_active = 1) AS device_count
       FROM branches b WHERE b.company_id = ? ORDER BY b.name`
    )
    .all(req.user.company_id);
  res.json(rows);
});

router.post('/branches', authRequired, requirePermission('branch.manage'), wrap((req, res) => {
  const { name, address, phone, opening_hours } = req.body;
  if (!name) return badRequest(res, 'name required');
  const bid = id();
  db.prepare('INSERT INTO branches (id, company_id, name, address, phone, opening_hours) VALUES (?, ?, ?, ?, ?, ?)')
    .run(bid, req.user.company_id, name, address || null, phone || null, opening_hours || null);
  audit({ company_id: req.user.company_id, user_id: req.user.sub, action: 'branch.create', entity: 'branch', entity_id: bid, detail: req.body, ip: req.ip });
  res.status(201).json(db.prepare('SELECT * FROM branches WHERE id = ?').get(bid));
}));

router.put('/branches/:id', authRequired, requirePermission('branch.manage'), wrap((req, res) => {
  const b = db.prepare('SELECT * FROM branches WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!b) return notFound(res);
  const { name, address, phone, opening_hours, is_active } = req.body;
  db.prepare(
    `UPDATE branches SET name=COALESCE(?,name), address=COALESCE(?,address), phone=COALESCE(?,phone),
     opening_hours=COALESCE(?,opening_hours), is_active=COALESCE(?,is_active) WHERE id = ?`
  ).run(name, address, phone, opening_hours, is_active === undefined ? null : is_active ? 1 : 0, req.params.id);
  audit({ company_id: req.user.company_id, user_id: req.user.sub, action: is_active === false ? 'branch.deactivate' : 'branch.update', entity: 'branch', entity_id: b.id, detail: req.body, ip: req.ip });
  res.json(db.prepare('SELECT * FROM branches WHERE id = ?').get(req.params.id));
}));

/* -------------------------------- USERS -------------------------------- */

router.get('/users', authRequired, requirePermission('user.manage', 'user.manage_branch'), (req, res) => {
  const scope = scopedBranchIds(req);
  const rows = db
    .prepare(
      `SELECT u.id, u.company_id, u.branch_id, u.name, u.email, u.role, u.is_active, u.multi_branch,
              u.last_login_at, u.created_at, (u.pin_hash IS NOT NULL) AS has_pin, b.name AS branch_name
       FROM users u LEFT JOIN branches b ON b.id = u.branch_id
       WHERE u.company_id = ? ORDER BY u.name`
    )
    .all(req.user.company_id);
  const canSeeAll = req.permissions.includes('user.manage');
  res.json(canSeeAll ? rows : rows.filter((u) => scope.includes(u.branch_id)));
});

router.post('/users', authRequired, requirePermission('user.manage', 'user.manage_branch'), wrap((req, res) => {
  const { name, email, password, role, branch_id, pin, multi_branch } = req.body;
  if (!name || !email || !password) return badRequest(res, 'name, email, password required');
  if (db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(email)) return res.status(409).json({ error: 'Email exists' });
  // Branch managers may only create users inside their own branch scope.
  if (!req.permissions.includes('user.manage')) {
    const scope = scopedBranchIds(req);
    if (!branch_id || !scope.includes(branch_id)) return res.status(403).json({ error: 'Cabang di luar wewenang Anda' });
    if (role === 'super_admin') return res.status(403).json({ error: 'Tidak boleh membuat Super Admin' });
  }
  const uid = id();
  db.prepare(
    `INSERT INTO users (id, company_id, branch_id, name, email, password_hash, role, pin_hash, multi_branch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uid, req.user.company_id, branch_id || null, name, email, bcrypt.hashSync(password, 10),
    role || 'cashier', pin ? bcrypt.hashSync(String(pin), 10) : null, multi_branch ? 1 : 0
  );
  audit({ company_id: req.user.company_id, user_id: req.user.sub, action: 'user.create', entity: 'user', entity_id: uid, detail: { role, branch_id }, ip: req.ip });
  res.status(201).json(db.prepare('SELECT id, name, email, role, branch_id, is_active FROM users WHERE id = ?').get(uid));
}));

router.put('/users/:id', authRequired, requirePermission('user.manage', 'user.manage_branch'), wrap((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!u) return notFound(res);
  if (!req.permissions.includes('user.manage')) {
    const scope = scopedBranchIds(req);
    if (!scope.includes(u.branch_id)) return res.status(403).json({ error: 'Cabang di luar wewenang Anda' });
  }
  const { name, role, branch_id, is_active, password, pin, multi_branch } = req.body;
  db.prepare(
    `UPDATE users SET name=COALESCE(?,name), role=COALESCE(?,role), branch_id=COALESCE(?,branch_id),
       is_active=COALESCE(?,is_active), password_hash=COALESCE(?,password_hash), pin_hash=COALESCE(?,pin_hash),
       multi_branch=COALESCE(?,multi_branch), updated_at=datetime('now') WHERE id = ?`
  ).run(
    name, role, branch_id,
    is_active === undefined ? null : is_active ? 1 : 0,
    password ? bcrypt.hashSync(password, 10) : null,
    pin ? bcrypt.hashSync(String(pin), 10) : null,
    multi_branch === undefined ? null : multi_branch ? 1 : 0,
    req.params.id
  );
  if (is_active === false || password) revokeAllUserTokens(req.params.id);
  audit({ company_id: req.user.company_id, user_id: req.user.sub, action: 'user.update', entity: 'user', entity_id: u.id, detail: { role, branch_id, is_active }, ip: req.ip });
  res.json(db.prepare('SELECT id, name, email, role, branch_id, is_active, multi_branch FROM users WHERE id = ?').get(req.params.id));
}));

router.delete('/users/:id', authRequired, requirePermission('user.manage'), wrap((req, res) => {
  if (req.params.id === req.user.sub) return badRequest(res, 'Tidak bisa menonaktifkan akun sendiri');
  const u = db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!u) return notFound(res);
  db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(u.id);
  revokeAllUserTokens(u.id);
  audit({ company_id: req.user.company_id, user_id: req.user.sub, action: 'user.deactivate', entity: 'user', entity_id: u.id, ip: req.ip });
  res.json({ ok: true });
}));

/* -------------------------------- ROLES -------------------------------- */

router.get('/roles/catalog', authRequired, (req, res) => res.json(catalog()));

router.get('/roles', authRequired, requirePermission('role.manage', 'user.manage'), (req, res) => {
  const custom = db
    .prepare('SELECT * FROM roles WHERE company_id = ? ORDER BY name')
    .all(req.user.company_id)
    .map((r) => ({ ...r, permissions: JSON.parse(r.permissions || '[]'), is_system: !!r.is_system }));
  res.json({ builtin: catalog().builtin_roles, custom });
});

router.post('/roles', authRequired, requirePermission('role.manage'), wrap((req, res) => {
  const { name, description, permissions } = req.body;
  if (!name || !/^[a-z0-9_]{2,40}$/.test(name)) return badRequest(res, 'name wajib huruf kecil/angka/underscore');
  if (ROLE_PERMISSIONS[name]) return badRequest(res, 'Nama role bentrok dengan role sistem');
  if (db.prepare('SELECT id FROM roles WHERE company_id = ? AND name = ?').get(req.user.company_id, name))
    return res.status(409).json({ error: 'Role sudah ada' });
  const perms = (Array.isArray(permissions) ? permissions : []).filter((p) => ALL_PERMISSIONS.includes(p));
  const rid = id();
  db.prepare('INSERT INTO roles (id, company_id, name, permissions, is_system, description) VALUES (?, ?, ?, ?, 0, ?)')
    .run(rid, req.user.company_id, name, JSON.stringify(perms), description || null);
  audit({ company_id: req.user.company_id, user_id: req.user.sub, action: 'role.create', entity: 'role', entity_id: rid, detail: { name, perms }, ip: req.ip });
  res.status(201).json(db.prepare('SELECT * FROM roles WHERE id = ?').get(rid));
}));

router.put('/roles/:id', authRequired, requirePermission('role.manage'), wrap((req, res) => {
  const r = db.prepare('SELECT * FROM roles WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!r) return notFound(res);
  const perms = (Array.isArray(req.body.permissions) ? req.body.permissions : []).filter((p) => ALL_PERMISSIONS.includes(p));
  db.prepare("UPDATE roles SET permissions = ?, description = COALESCE(?, description), updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(perms), req.body.description || null, r.id);
  audit({ company_id: req.user.company_id, user_id: req.user.sub, action: 'role.update', entity: 'role', entity_id: r.id, detail: { perms }, ip: req.ip });
  res.json({ ...db.prepare('SELECT * FROM roles WHERE id = ?').get(r.id), permissions: perms });
}));

router.delete('/roles/:id', authRequired, requirePermission('role.manage'), wrap((req, res) => {
  const r = db.prepare('SELECT * FROM roles WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!r) return notFound(res);
  if (r.is_system) return badRequest(res, 'Role sistem tidak bisa dihapus');
  const used = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ? AND company_id = ?').get(r.name, req.user.company_id).n;
  if (used) return badRequest(res, `Role masih dipakai oleh ${used} pengguna`);
  db.prepare('DELETE FROM roles WHERE id = ?').run(r.id);
  audit({ company_id: req.user.company_id, user_id: req.user.sub, action: 'role.delete', entity: 'role', entity_id: r.id, ip: req.ip });
  res.json({ ok: true });
}));

router.get('/roles/:name/permissions', authRequired, (req, res) => {
  res.json({ permissions: getPermissions(req.params.name, req.user.company_id) });
});

export default router;

