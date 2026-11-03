import express from 'express';
import { db } from '../db.js';
import { authRequired, requirePermission, scopedBranchIds } from '../auth.js';
import { wrap, money, txFilter, withStatuses, toCsv, sendCsv } from '../lib/helpers.js';
import { buildDailyBrief, renderBriefText } from '../lib/dailyBrief.js';

const router = express.Router();

/**
 * Normalise one range bound into a SQLite-comparable timestamp.
 *
 * `txFilter()` compares `t.created_at` (`YYYY-MM-DD HH:MM:SS`, UTC) against the
 * bound as a string, so a bare date is not enough:
 *   - `to=2026-11-02` would sort *before* `2026-11-02 15:24:00`, so an
 *     upper bound silently excluded the whole day (dashboard "Hari ini" = 0).
 *   - `from=2026-11-02` works, but pinning it to 00:00:00 keeps it symmetric
 *     and explicit.
 * Timezone: the app stores UTC and the client formats dates for display, so
 * expand a date-only bound to the full UTC day.
 */
function bound(value, endOfDay) {
  const v = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v} ${endOfDay ? '23:59:59' : '00:00:00'}`;
  return v;
}

/** Default range: today (UTC) when from/to are omitted. */
function range(q) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    from: q.from ? bound(q.from, false) : `${today} 00:00:00`,
    to: q.to ? bound(q.to, true) : `${today} 23:59:59`
  };
}

function scopeFor(req, res, branchId) {
  const scope = scopedBranchIds(req);
  if (branchId) {
    if (!scope.includes(branchId)) {
      res.status(403).json({ error: 'Forbidden: branch not in your scope' });
      return null;
    }
    return [branchId];
  }
  return scope;
}

/** GET /reports/summary — dashboard KPIs (today vs. previous period). */
router.get('/reports/summary', authRequired, requirePermission('report.view_all', 'report.view_branch'), wrap((req, res) => {
  const branchIds = scopeFor(req, res, req.query.branch_id);
  if (!branchIds) return;
  const { from, to } = range(req.query);

  const { where, params } = txFilter({ companyId: req.user.company_id, branchIds, from, to });
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS transactions, COALESCE(SUM(t.total),0) AS revenue,
              COALESCE(SUM(t.discount),0) AS discount, COALESCE(SUM(t.tax),0) AS tax,
              COALESCE(AVG(t.total),0) AS avg_ticket,
              COALESCE(SUM((SELECT COALESCE(SUM(i.cost_price * i.quantity),0) FROM transaction_items i WHERE i.transaction_id = t.id)),0) AS cogs
       FROM transactions t WHERE ${where}`
    )
    .get(...params);

  const voidedFilter = withStatuses(txFilter({ companyId: req.user.company_id, branchIds, from, to }), ['voided']);
  const voided = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(t.total),0) AS total FROM transactions t
       WHERE ${voidedFilter.where}`
    )
    .get(...voidedFilter.params);

  const byPayment = db
    .prepare(
      `SELECT t.payment_method AS method, COUNT(*) AS count, COALESCE(SUM(t.total),0) AS total
       FROM transactions t WHERE ${where} GROUP BY t.payment_method ORDER BY total DESC`
    )
    .all(...params);

  const byBranch = db
    .prepare(
      `SELECT t.branch_id, b.name AS branch_name, COUNT(*) AS transactions, COALESCE(SUM(t.total),0) AS revenue
       FROM transactions t LEFT JOIN branches b ON b.id = t.branch_id
       WHERE ${where} GROUP BY t.branch_id ORDER BY revenue DESC`
    )
    .all(...params);

  const hourly = db
    .prepare(
      `SELECT strftime('%H', t.created_at) AS hour, COUNT(*) AS transactions, COALESCE(SUM(t.total),0) AS revenue
       FROM transactions t WHERE ${where} GROUP BY hour ORDER BY hour`
    )
    .all(...params);

  const revenue = money(agg.revenue);
  res.json({
    range: { from, to },
    branches: branchIds.length,
    transactions: agg.transactions,
    revenue,
    discount: money(agg.discount),
    tax: money(agg.tax),
    cogs: money(agg.cogs),
    gross_profit: money(revenue - agg.cogs),
    avg_ticket: money(agg.avg_ticket),
    void_count: voided.n,
    void_total: money(voided.total),
    by_payment: byPayment.map((p) => ({ ...p, total: money(p.total) })),
    by_branch: byBranch.map((b) => ({ ...b, revenue: money(b.revenue) })),
    hourly: hourly.map((h) => ({ ...h, revenue: money(h.revenue) }))
  });
}));

/** GET /reports/sales — per-branch comparison table. */
router.get('/reports/sales', authRequired, requirePermission('report.view_all', 'report.view_branch'), wrap((req, res) => {
  const branchIds = scopeFor(req, res, req.query.branch_id);
  if (!branchIds) return;
  const { from, to } = range(req.query);
  const { where, params } = txFilter({ companyId: req.user.company_id, branchIds, from, to });
  const rows = db
    .prepare(
      `SELECT b.id AS branch_id, b.name AS branch_name,
              COUNT(t.id) AS transactions,
              COALESCE(SUM(t.total),0) AS revenue,
              COALESCE(SUM(t.discount),0) AS discount,
              COALESCE(SUM((SELECT COALESCE(SUM(i.cost_price * i.quantity),0) FROM transaction_items i WHERE i.transaction_id = t.id)),0) AS cogs,
              COALESCE(AVG(t.total),0) AS avg_ticket
       FROM branches b LEFT JOIN transactions t ON t.branch_id = b.id AND ${where}
       WHERE b.id IN (${branchIds.map(() => '?').join(',') || 'NULL'})
       GROUP BY b.id ORDER BY revenue DESC`
    )
    .all(...params, ...branchIds);
  res.json(
    rows.map((r) => ({
      ...r,
      revenue: money(r.revenue),
      discount: money(r.discount),
      cogs: money(r.cogs),
      gross_profit: money(r.revenue - r.cogs),
      margin_percent: r.revenue ? money(((r.revenue - r.cogs) / r.revenue) * 100) : 0,
      avg_ticket: money(r.avg_ticket)
    }))
  );
}));

/**
 * GET /reports/products — best sellers with revenue, cost of goods and margin.
 * Optional ?low=1 returns the slowest movers instead.
 */
router.get('/reports/products', authRequired, requirePermission('report.view_all', 'report.view_branch'), wrap((req, res) => {
  const branchIds = scopeFor(req, res, req.query.branch_id);
  if (!branchIds) return;
  const { from, to } = range(req.query);
  const { where, params } = txFilter({ companyId: req.user.company_id, branchIds, from, to });
  const order = req.query.low === '1' ? 'quantity ASC' : 'quantity DESC';
  const rows = db
    .prepare(
      `SELECT i.product_id, i.product_name,
              COALESCE(SUM(i.quantity),0) AS quantity,
              COALESCE(SUM(i.subtotal),0) AS revenue,
              COALESCE(SUM(i.cost_price * i.quantity),0) AS cogs,
              COUNT(DISTINCT t.id) AS transactions
       FROM transaction_items i JOIN transactions t ON t.id = i.transaction_id
       WHERE ${where}
       GROUP BY i.product_id, i.product_name ORDER BY ${order} LIMIT ?`
    )
    .all(...params, Number(req.query.limit) || 50);
  res.json(
    rows.map((r) => ({
      ...r,
      revenue: money(r.revenue),
      cogs: money(r.cogs),
      gross_profit: money(r.revenue - r.cogs),
      margin_percent: r.revenue ? money(((r.revenue - r.cogs) / r.revenue) * 100) : 0
    }))
  );
}));

/** GET /reports/cashiers — cashier performance (sales, avg ticket, voids, shifts). */
router.get('/reports/cashiers', authRequired, requirePermission('report.view_all', 'report.view_branch'), wrap((req, res) => {
  const branchIds = scopeFor(req, res, req.query.branch_id);
  if (!branchIds) return;
  const { from, to } = range(req.query);
  const { where, params } = txFilter({ companyId: req.user.company_id, branchIds, from, to });
  const rows = db
    .prepare(
      `SELECT u.id AS user_id, u.name AS cashier_name, b.name AS branch_name,
              COUNT(t.id) AS transactions,
              COALESCE(SUM(t.total),0) AS revenue,
              COALESCE(AVG(t.total),0) AS avg_ticket
       FROM transactions t JOIN users u ON u.id = t.user_id LEFT JOIN branches b ON b.id = t.branch_id
       WHERE ${where} GROUP BY u.id, t.branch_id ORDER BY revenue DESC`
    )
    .all(...params);
  const voidFilter = withStatuses(txFilter({ companyId: req.user.company_id, branchIds, from, to }), ['voided']);
  const voids = db
    .prepare(
      `SELECT t.user_id, COUNT(*) AS n, COALESCE(SUM(t.total),0) AS total FROM transactions t
       WHERE ${voidFilter.where} GROUP BY t.user_id`
    )
    .all(...voidFilter.params);
  const voidMap = new Map(voids.map((v) => [v.user_id, v]));
  res.json(
    rows.map((r) => ({
      ...r,
      revenue: money(r.revenue),
      avg_ticket: money(r.avg_ticket),
      void_count: voidMap.get(r.user_id)?.n || 0,
      void_total: money(voidMap.get(r.user_id)?.total || 0)
    }))
  );
}));

/** GET /reports/profit — profit & loss for the range (requires report.view_profit). */
router.get('/reports/profit', authRequired, requirePermission('report.view_profit', 'report.view_all'), wrap((req, res) => {
  const branchIds = scopeFor(req, res, req.query.branch_id);
  if (!branchIds) return;
  const { from, to } = range(req.query);
  const { where, params } = txFilter({ companyId: req.user.company_id, branchIds, from, to });
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(t.subtotal),0) AS gross_sales,
              COALESCE(SUM(t.discount),0) AS discount,
              COALESCE(SUM(t.tax),0) AS tax,
              COALESCE(SUM(t.total),0) AS net_sales,
              COALESCE(SUM((SELECT COALESCE(SUM(i.cost_price * i.quantity),0) FROM transaction_items i WHERE i.transaction_id = t.id)),0) AS cogs,
              COUNT(*) AS transactions
       FROM transactions t WHERE ${where}`
    )
    .get(...params);
  const daily = db
    .prepare(
      `SELECT date(t.created_at) AS day, COUNT(*) AS transactions, COALESCE(SUM(t.total),0) AS revenue,
              COALESCE(SUM((SELECT COALESCE(SUM(i.cost_price * i.quantity),0) FROM transaction_items i WHERE i.transaction_id = t.id)),0) AS cogs
       FROM transactions t WHERE ${where} GROUP BY day ORDER BY day`
    )
    .all(...params);
  res.json({
    range: { from, to },
    gross_sales: money(totals.gross_sales),
    discount: money(totals.discount),
    tax: money(totals.tax),
    net_sales: money(totals.net_sales),
    cogs: money(totals.cogs),
    gross_profit: money(totals.net_sales - totals.cogs),
    margin_percent: totals.net_sales ? money(((totals.net_sales - totals.cogs) / totals.net_sales) * 100) : 0,
    transactions: totals.transactions,
    daily: daily.map((d) => ({
      ...d,
      revenue: money(d.revenue),
      cogs: money(d.cogs),
      gross_profit: money(d.revenue - d.cogs)
    }))
  });
}));

/** GET /reports/export/transactions.csv — transaction ledger export. */
/**
 * GET /reports/daily-brief — one-day recap tailored for sharing with the owner.
 * Query: date (YYYY-MM-DD, default today), branch_id, lang (id|en).
 *
 * Returns the structured brief plus the ready-to-send WhatsApp text, so the UI
 * can show a live preview and the share button from a single request.
 */
router.get('/reports/daily-brief', authRequired, requirePermission('report.view_all', 'report.view_branch', 'report.export'), wrap((req, res) => {
  const branchIds = scopeFor(req, res, req.query.branch_id);
  if (!branchIds) return;
  const lang = req.query.lang === 'en' ? 'en' : 'id';

  const company = db.prepare('SELECT name, timezone FROM companies WHERE id = ?').get(req.user.company_id);
  const brief = buildDailyBrief({
    companyId: req.user.company_id,
    branchIds,
    date: req.query.date,
    timeZone: company?.timezone || null
  });
  const text = renderBriefText(brief, { lang, companyName: company?.name || null });

  res.json({ ...brief, company_name: company?.name || null, lang, text });
}));

/** GET /reports/daily-brief/text — same brief as plain text, for cron jobs / bots. */
router.get('/reports/daily-brief/text', authRequired, requirePermission('report.view_all', 'report.view_branch', 'report.export'), wrap((req, res) => {
  const branchIds = scopeFor(req, res, req.query.branch_id);
  if (!branchIds) return;
  const lang = req.query.lang === 'en' ? 'en' : 'id';

  const company = db.prepare('SELECT name, timezone FROM companies WHERE id = ?').get(req.user.company_id);
  const brief = buildDailyBrief({
    companyId: req.user.company_id,
    branchIds,
    date: req.query.date,
    timeZone: company?.timezone || null
  });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(renderBriefText(brief, { lang, companyName: company?.name || null }));
}));


router.get('/reports/export/transactions.csv', authRequired, requirePermission('report.export', 'report.view_all', 'report.view_branch'), wrap((req, res) => {
  const branchIds = scopeFor(req, res, req.query.branch_id);
  if (!branchIds) return;
  const { from, to } = range(req.query);
  const { where, params } = txFilter({
    companyId: req.user.company_id, branchIds, from, to,
    statuses: req.query.status ? req.query.status.split(',') : ['completed', 'voided', 'refunded']
  });
  const rows = db
    .prepare(
      `SELECT t.code, t.created_at, b.name AS branch, u.name AS cashier, t.status,
              t.subtotal, t.discount, t.tax, t.total, t.payment_method, t.cash_received, t.change_due,
              t.customer_name, t.order_label, t.table_number, t.void_reason,
              (SELECT COUNT(*) FROM transaction_items i WHERE i.transaction_id = t.id) AS items
       FROM transactions t
       LEFT JOIN branches b ON b.id = t.branch_id
       LEFT JOIN users u ON u.id = t.user_id
       WHERE ${where} ORDER BY t.created_at`
    )
    .all(...params);
  const csv = toCsv(rows, [
    { key: 'code', label: 'Kode' },
    { key: 'created_at', label: 'Waktu' },
    { key: 'branch', label: 'Cabang' },
    { key: 'cashier', label: 'Kasir' },
    { key: 'status', label: 'Status' },
    { key: 'items', label: 'Jumlah Item' },
    { key: 'subtotal', label: 'Subtotal' },
    { key: 'discount', label: 'Diskon' },
    { key: 'tax', label: 'Pajak' },
    { key: 'total', label: 'Total' },
    { key: 'payment_method', label: 'Metode Bayar' },
    { key: 'cash_received', label: 'Dibayar' },
    { key: 'change_due', label: 'Kembali' },
    { key: 'customer_name', label: 'Pelanggan' },
    { key: 'order_label', label: 'Label Order' },
    { key: 'table_number', label: 'Meja' },
    { key: 'void_reason', label: 'Alasan Void' }
  ]);
  sendCsv(res, `transactions_${from.slice(0, 10)}_${to.slice(0, 10)}.csv`, csv);
}));

/** GET /reports/export/products.csv — per-SKU sales export. */
router.get('/reports/export/products.csv', authRequired, requirePermission('report.export', 'report.view_all', 'report.view_branch'), wrap((req, res) => {
  const branchIds = scopeFor(req, res, req.query.branch_id);
  if (!branchIds) return;
  const { from, to } = range(req.query);
  const { where, params } = txFilter({ companyId: req.user.company_id, branchIds, from, to });
  const rows = db
    .prepare(
      `SELECT i.product_name, p.sku, COALESCE(SUM(i.quantity),0) AS quantity,
              COALESCE(SUM(i.subtotal),0) AS revenue, COALESCE(SUM(i.cost_price * i.quantity),0) AS cogs
       FROM transaction_items i JOIN transactions t ON t.id = i.transaction_id
       LEFT JOIN products p ON p.id = i.product_id
       WHERE ${where} GROUP BY i.product_id, i.product_name ORDER BY quantity DESC`
    )
    .all(...params);
  const csv = toCsv(rows, [
    { key: 'product_name', label: 'Produk' },
    { key: 'sku', label: 'SKU' },
    { key: 'quantity', label: 'Terjual' },
    { key: 'revenue', label: 'Omzet' },
    { key: 'cogs', label: 'HPP' },
    { label: 'Laba Kotor', value: (r) => money(r.revenue - r.cogs) }
  ]);
  sendCsv(res, `products_${from.slice(0, 10)}_${to.slice(0, 10)}.csv`, csv);
}));

/** GET /reports/export/stock.csv — current stock snapshot across branches. */
router.get('/reports/export/stock.csv', authRequired, requirePermission('report.export', 'stock.view', 'stock.manage', 'report.view_all'), wrap((req, res) => {
  const branchIds = scopeFor(req, res, req.query.branch_id);
  if (!branchIds) return;
  const rows = db
    .prepare(
      `SELECT p.name AS product, p.sku, b.name AS branch, bs.quantity, bs.low_stock_threshold,
              p.cost_price, p.default_price
       FROM branch_stocks bs
       JOIN products p ON p.id = bs.product_id
       JOIN branches b ON b.id = bs.branch_id
       WHERE p.company_id = ? AND bs.branch_id IN (${branchIds.map(() => '?').join(',') || 'NULL'})
       ORDER BY b.name, p.name`
    )
    .all(req.user.company_id, ...branchIds);
  const csv = toCsv(rows, [
    { key: 'branch', label: 'Cabang' },
    { key: 'product', label: 'Produk' },
    { key: 'sku', label: 'SKU' },
    { key: 'quantity', label: 'Stok' },
    { key: 'low_stock_threshold', label: 'Batas Minimum' },
    { key: 'cost_price', label: 'Harga Modal' },
    { key: 'default_price', label: 'Harga Jual' },
    { label: 'Nilai Stok', value: (r) => money(r.quantity * r.cost_price) }
  ]);
  sendCsv(res, `stock_${new Date().toISOString().slice(0, 10)}.csv`, csv);
}));

/** GET /reports/export/shifts.csv — shift / cash drawer recap export. */
router.get('/reports/export/shifts.csv', authRequired, requirePermission('report.export', 'report.view_all', 'report.view_branch'), wrap((req, res) => {
  const branchIds = scopeFor(req, res, req.query.branch_id);
  if (!branchIds) return;
  const { from, to } = range(req.query);
  const rows = db
    .prepare(
      `SELECT s.opened_at, s.closed_at, s.status, b.name AS branch, u.name AS cashier,
              s.opening_cash, s.expected_cash, s.closing_cash, s.cash_difference
       FROM shifts s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN branches b ON b.id = s.branch_id
       WHERE s.branch_id IN (${branchIds.map(() => '?').join(',') || 'NULL'}) AND s.opened_at BETWEEN ? AND ?
       ORDER BY s.opened_at`
    )
    .all(...branchIds, from, to);
  const csv = toCsv(rows, [
    { key: 'opened_at', label: 'Buka' },
    { key: 'closed_at', label: 'Tutup' },
    { key: 'status', label: 'Status' },
    { key: 'branch', label: 'Cabang' },
    { key: 'cashier', label: 'Kasir' },
    { key: 'opening_cash', label: 'Kas Awal' },
    { key: 'expected_cash', label: 'Kas Seharusnya' },
    { key: 'closing_cash', label: 'Kas Aktual' },
    { key: 'cash_difference', label: 'Selisih' }
  ]);
  sendCsv(res, `shifts_${from.slice(0, 10)}_${to.slice(0, 10)}.csv`, csv);
}));

export default router;


