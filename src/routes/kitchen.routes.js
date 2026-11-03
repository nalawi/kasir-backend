import express from 'express';
import { authRequired, requirePermission, audit, assertBranchAccess } from '../auth.js';
import { wrap, badRequest, notFound } from '../lib/helpers.js';
import {
  QUEUE_STATUSES,
  ACTIVE_STATUSES,
  listQueue,
  queueSummary,
  getQueueItem,
  createTicket,
  setStatus,
  deleteTicket
} from '../lib/kitchen.js';

const router = express.Router();

/** `?scope=active|ready|history|all` → the statuses to return. */
function statusesFromScope(scope) {
  switch (String(scope || 'active')) {
    case 'history':
      return ['completed', 'cancelled'];
    case 'ready':
      return ['ready'];
    case 'all':
      return QUEUE_STATUSES;
    case 'active':
    default:
      return ACTIVE_STATUSES;
  }
}

/** GET /branches/:branchId/queue — the board. Defaults to active tickets. */
router.get('/branches/:branchId/queue', authRequired, requirePermission('kitchen.view', 'kitchen.manage'), wrap((req, res) => {
  if (!assertBranchAccess(req, res, req.params.branchId)) return;
  const station = req.query.station ? String(req.query.station) : null;
  const rows = listQueue({
    branchId: req.params.branchId,
    companyId: req.user.company_id,
    statuses: statusesFromScope(req.query.scope),
    station,
    limit: Number(req.query.limit) || 200
  });
  res.json(rows);
}));

/** GET /branches/:branchId/queue/summary — counters for the tab badges. */
router.get('/branches/:branchId/queue/summary', authRequired, requirePermission('kitchen.view', 'kitchen.manage'), wrap((req, res) => {
  if (!assertBranchAccess(req, res, req.params.branchId)) return;
  res.json(queueSummary(req.params.branchId, req.user.company_id));
}));

router.get('/queue/:id', authRequired, requirePermission('kitchen.view', 'kitchen.manage'), wrap((req, res) => {
  const row = getQueueItem(req.params.id, req.user.company_id);
  if (!row) return notFound(res, 'Tiket antrian tidak ditemukan');
  if (!assertBranchAccess(req, res, row.branch_id)) return;
  res.json(row);
}));

/**
 * POST /queue — raise a ticket by hand (waiter taking a dine-in order, or the
 * cashier re-sending a ticket). Checkout normally creates these automatically.
 */
router.post('/queue', authRequired, requirePermission('kitchen.manage'), wrap((req, res) => {
  const { branch_id, items, order_label, table_number, customer_name, station, note } = req.body;
  if (!branch_id) return badRequest(res, 'branch_id required');
  if (!assertBranchAccess(req, res, branch_id)) return;
  if (!Array.isArray(items) || !items.length) return badRequest(res, 'items required');

  const queueId = createTicket({
    companyId: req.user.company_id,
    branchId: branch_id,
    userId: req.user.sub,
    orderLabel: order_label || null,
    tableNumber: table_number || null,
    customerName: customer_name || null,
    station: station || null,
    note: note || null,
    items: items.map((i) => ({
      product_id: i.product_id || null,
      product_name: i.product_name || null,
      variant_label: i.variant_label || null,
      quantity: i.quantity,
      note: i.note || null
    }))
  });
  if (!queueId) return badRequest(res, 'items required');

  audit({ company_id: req.user.company_id, branch_id, user_id: req.user.sub, action: 'queue.create', entity: 'order_queue', entity_id: queueId, detail: { items: items.length }, ip: req.ip });
  res.status(201).json(getQueueItem(queueId, req.user.company_id));
}));

/**
 * PATCH /queue/:id/status — the single action the board buttons call.
 * Transitions are validated by the state machine in lib/kitchen.js.
 */
router.patch('/queue/:id/status', authRequired, requirePermission('kitchen.manage'), wrap((req, res) => {
  const row = getQueueItem(req.params.id, req.user.company_id);
  if (!row) return notFound(res, 'Tiket antrian tidak ditemukan');
  if (!assertBranchAccess(req, res, row.branch_id)) return;

  const result = setStatus({
    queueId: row.id,
    companyId: req.user.company_id,
    userId: req.user.sub,
    status: req.body.status,
    reason: req.body.reason,
    lineDone: req.body.item_id ? { item_id: req.body.item_id, done: req.body.done !== false } : null
  });
  if (result.error === 'notfound') return notFound(res, 'Tiket antrian tidak ditemukan');
  if (result.error) return badRequest(res, result.error);

  audit({
    company_id: req.user.company_id, branch_id: row.branch_id, user_id: req.user.sub,
    action: `queue.${req.body.status}`, entity: 'order_queue', entity_id: row.id,
    detail: { from: row.status, ticket_no: row.ticket_no, reason: req.body.reason || null }, ip: req.ip
  });
  res.json(result.row);
}));

/** DELETE /queue/:id — remove a ticket raised by mistake. */
router.delete('/queue/:id', authRequired, requirePermission('kitchen.manage'), wrap((req, res) => {
  const row = getQueueItem(req.params.id, req.user.company_id);
  if (!row) return notFound(res, 'Tiket antrian tidak ditemukan');
  if (!assertBranchAccess(req, res, row.branch_id)) return;
  deleteTicket({ queueId: row.id, companyId: req.user.company_id });
  audit({ company_id: req.user.company_id, branch_id: row.branch_id, user_id: req.user.sub, action: 'queue.delete', entity: 'order_queue', entity_id: row.id, ip: req.ip });
  res.json({ ok: true });
}));

export default router;
