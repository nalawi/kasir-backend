import express from 'express';
import { db } from '../db.js';
import { authRequired, requirePermission } from '../auth.js';
import { wrap } from '../lib/helpers.js';

const router = express.Router();

/** GET /audit-logs — filterable activity trail (super admin / manager with audit.view). */
router.get('/audit-logs', authRequired, requirePermission('audit.view', 'company.manage'), wrap((req, res) => {
  const { action, entity, entity_id, user_id, branch_id, from, to, q, limit = 100, offset = 0 } = req.query;
  const conds = ['a.company_id = ?'];
  const params = [req.user.company_id];
  if (action) { conds.push('a.action LIKE ?'); params.push(`%${action}%`); }
  if (entity) { conds.push('a.entity = ?'); params.push(entity); }
  if (entity_id) { conds.push('a.entity_id = ?'); params.push(entity_id); }
  if (user_id) { conds.push('a.user_id = ?'); params.push(user_id); }
  if (branch_id) { conds.push('a.branch_id = ?'); params.push(branch_id); }
  if (from) { conds.push('a.created_at >= ?'); params.push(from); }
  if (to) { conds.push('a.created_at <= ?'); params.push(to); }
  if (q) { conds.push('(a.detail LIKE ? OR u.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const where = conds.join(' AND ');

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id WHERE ${where}`)
    .get(...params).n;
  const rows = db
    .prepare(
      `SELECT a.*, u.name AS user_name, b.name AS branch_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN branches b ON b.id = a.branch_id
       WHERE ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, Number(limit), Number(offset));
  res.json({
    total,
    limit: Number(limit),
    offset: Number(offset),
    rows: rows.map((r) => {
      let detail = null;
      try {
        detail = r.detail ? JSON.parse(r.detail) : null;
      } catch {
        detail = r.detail;
      }
      return { ...r, detail };
    })
  });
}));

/** GET /audit-logs/actions — distinct action names for the filter dropdown. */
router.get('/audit-logs/actions', authRequired, requirePermission('audit.view', 'company.manage'), wrap((req, res) => {
  const rows = db
    .prepare('SELECT action, COUNT(*) AS n FROM audit_logs WHERE company_id = ? GROUP BY action ORDER BY n DESC')
    .all(req.user.company_id);
  res.json(rows);
}));

export default router;
