import express from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { authRequired, requirePermission, audit, assertBranchAccess, scopedBranchIds } from '../auth.js';
import { id, wrap, badRequest, notFound, money } from '../lib/helpers.js';

const router = express.Router();

function shiftSummary(shift) {
  const sales = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total,
              COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total ELSE 0 END),0) AS cash_total,
              COALESCE(SUM(CASE WHEN payment_method <> 'cash' THEN total ELSE 0 END),0) AS non_cash_total
       FROM transactions WHERE shift_id = ? AND status = 'completed'`
    )
    .get(shift.id);
  const voids = db
    .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total FROM transactions WHERE shift_id = ? AND status = 'voided'")
    .get(shift.id);
  const byMethod = db
    .prepare(
      `SELECT payment_method AS method, COUNT(*) AS count, COALESCE(SUM(total),0) AS total
       FROM transactions WHERE shift_id = ? AND status = 'completed' GROUP BY payment_method`
    )
    .all(shift.id);
  const expected = money(Number(shift.opening_cash || 0) + sales.cash_total);
  return {
    ...shift,
    cashier_name: db.prepare('SELECT name FROM users WHERE id = ?').get(shift.user_id)?.name,
    branch_name: db.prepare('SELECT name FROM branches WHERE id = ?').get(shift.branch_id)?.name,
    transactions: sales.count,
    sales_total: money(sales.total),
    cash_sales: money(sales.cash_total),
    non_cash_sales: money(sales.non_cash_total),
    void_count: voids.count,
    void_total: money(voids.total),
    expected_cash: expected,
    by_method: byMethod,
    difference: shift.closing_cash == null ? null : money(Number(shift.closing_cash) - expected)
  };
}

/** GET /shifts/current — the caller's open shift (used to gate the POS screen). */
router.get('/shifts/current', authRequired, wrap((req, res) => {
  const { branch_id } = req.query;
  const shift = branch_id
    ? db.prepare("SELECT * FROM shifts WHERE user_id = ? AND branch_id = ? AND status = 'open' ORDER BY opened_at DESC").get(req.user.sub, branch_id)
    : db.prepare("SELECT * FROM shifts WHERE user_id = ? AND status = 'open' ORDER BY opened_at DESC").get(req.user.sub);
  res.json(shift ? shiftSummary(shift) : null);
}));

router.get('/shifts', authRequired, wrap((req, res) => {
  const scope = scopedBranchIds(req);
  const { branch_id, from, to, status } = req.query;
  const conds = [];
  const params = [];
  const branchIds = branch_id ? [branch_id] : scope;
  if (branch_id && !assertBranchAccess(req, res, branch_id)) return;
  conds.push(`s.branch_id IN (${branchIds.map(() => '?').join(',') || 'NULL'})`);
  params.push(...branchIds);
  if (from) { conds.push('s.opened_at >= ?'); params.push(from); }
  if (to) { conds.push('s.opened_at <= ?'); params.push(to); }
  if (status) { conds.push('s.status = ?'); params.push(status); }
  const rows = db
    .prepare(
      `SELECT s.*, u.name AS cashier_name, b.name AS branch_name
       FROM shifts s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN branches b ON b.id = s.branch_id
       WHERE ${conds.join(' AND ')} ORDER BY s.opened_at DESC LIMIT 200`
    )
    .all(...params);
  res.json(rows);
}));

/** POST /shifts/open — open the till with a counted opening cash float. */
router.post('/shifts/open', authRequired, wrap((req, res) => {
  const { branch_id, opening_cash = 0, note } = req.body;
  if (!branch_id) return badRequest(res, 'branch_id required');
  if (!assertBranchAccess(req, res, branch_id)) return;
  const existing = db
    .prepare("SELECT * FROM shifts WHERE user_id = ? AND branch_id = ? AND status = 'open'")
    .get(req.user.sub, branch_id);
  if (existing) return badRequest(res, 'Shift masih terbuka. Tutup shift terlebih dahulu.');
  const sid = id();
  db.prepare('INSERT INTO shifts (id, branch_id, user_id, opening_cash, note) VALUES (?, ?, ?, ?, ?)')
    .run(sid, branch_id, req.user.sub, Number(opening_cash) || 0, note || null);
  audit({ company_id: req.user.company_id, branch_id, user_id: req.user.sub, action: 'shift.open', entity: 'shift', entity_id: sid, detail: { opening_cash: Number(opening_cash) || 0 }, ip: req.ip });
  res.status(201).json(shiftSummary(db.prepare('SELECT * FROM shifts WHERE id = ?').get(sid)));
}));

/** GET /shifts/:id — full recap incl. expected cash (X-report). */
router.get('/shifts/:id', authRequired, wrap((req, res) => {
  const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!s) return notFound(res, 'Shift not found');
  if (!assertBranchAccess(req, res, s.branch_id)) return;
  res.json(shiftSummary(s));
}));

/**
 * POST /shifts/:id/close — Z-report close.
 * body: { closing_cash, note }
 * A cash difference beyond the configured tolerance is flagged for manager review.
 */
router.post('/shifts/:id/close', authRequired, wrap((req, res) => {
  const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!s) return notFound(res, 'Shift not found');
  if (!assertBranchAccess(req, res, s.branch_id)) return;
  if (s.status !== 'open') return badRequest(res, 'Shift sudah ditutup');
  const { closing_cash, note } = req.body;
  if (closing_cash === undefined || closing_cash === null) return badRequest(res, 'closing_cash required');

  const summary = shiftSummary(s);
  const expected = summary.expected_cash;
  const closing = money(Number(closing_cash));
  const difference = money(closing - expected);

  const tolerance = Number(
    db.prepare("SELECT value FROM settings WHERE key = 'cash_tolerance'").get()?.value || 0
  );
  const needsReview = Math.abs(difference) > tolerance;

  db.prepare(
    `UPDATE shifts SET closing_cash = ?, expected_cash = ?, cash_difference = ?, closed_at = datetime('now'),
       status = 'closed', note = COALESCE(?, note) WHERE id = ?`
  ).run(closing, expected, difference, note || null, s.id);

  audit({
    company_id: req.user.company_id, branch_id: s.branch_id, user_id: req.user.sub,
    action: 'shift.close', entity: 'shift', entity_id: s.id,
    detail: { expected, closing, difference, needs_review: needsReview, sales_total: summary.sales_total }, ip: req.ip
  });
  const closed = db.prepare('SELECT * FROM shifts WHERE id = ?').get(s.id);
  res.json({ ...shiftSummary(closed), needs_review: needsReview, tolerance });
}));

/**
 * POST /shifts/:id/handover — cash handover to the next cashier / manager.
 * Verifies the receiving user's PIN and records the amount handed over.
 */
router.post('/shifts/:id/handover', authRequired, wrap((req, res) => {
  const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!s) return notFound(res, 'Shift not found');
  if (!assertBranchAccess(req, res, s.branch_id)) return;
  if (s.status !== 'open') return badRequest(res, 'Shift sudah ditutup');
  const { to_user_id, amount, pin } = req.body;
  if (!to_user_id || amount === undefined) return badRequest(res, 'to_user_id & amount required');
  const receiver = db.prepare('SELECT * FROM users WHERE id = ? AND company_id = ?').get(to_user_id, req.user.company_id);
  if (!receiver) return notFound(res, 'User penerima tidak ditemukan');
  if (!receiver.pin_hash || !bcrypt.compareSync(String(pin || ''), receiver.pin_hash)) {
    return res.status(403).json({ error: 'PIN penerima salah' });
  }
  const detail = { to_user_id, to_user_name: receiver.name, amount: money(Number(amount)) };
  audit({ company_id: req.user.company_id, branch_id: s.branch_id, user_id: req.user.sub, action: 'shift.handover', entity: 'shift', entity_id: s.id, detail, ip: req.ip });
  db.prepare("UPDATE shifts SET note = TRIM(COALESCE(note,'') || ' | handover ' || ? || ' to ' || ?) WHERE id = ?")
    .run(String(detail.amount), receiver.name, s.id);
  res.json({ ok: true, handover: detail });
}));

/**
 * POST /shifts/:id/reconcile — manager sign-off after a cash discrepancy.
 * Requires the `shift.reconcile` permission (manager / super admin).
 */
router.post('/shifts/:id/reconcile', authRequired, requirePermission('shift.reconcile'), wrap((req, res) => {
  const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!s) return notFound(res, 'Shift not found');
  if (!assertBranchAccess(req, res, s.branch_id)) return;
  if (s.status !== 'closed') return badRequest(res, 'Shift belum ditutup');
  const { note } = req.body;
  audit({
    company_id: req.user.company_id, branch_id: s.branch_id, user_id: req.user.sub,
    action: 'shift.reconcile', entity: 'shift', entity_id: s.id,
    detail: { difference: s.cash_difference, note }, ip: req.ip
  });
  db.prepare("UPDATE shifts SET note = TRIM(COALESCE(note,'') || ' | reconciled: ' || ?) WHERE id = ?")
    .run(note || 'ok', s.id);
  res.json({ ok: true });
}));

export default router;
