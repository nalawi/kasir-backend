import crypto from 'crypto';
import { db } from '../db.js';

/** Short unique id (32 hex chars) — same format used by the original API. */
export const id = () => crypto.randomBytes(16).toString('hex');

/** SQLite-comparable UTC timestamp (`YYYY-MM-DD HH:MM:SS`) matching `datetime('now')`. */
export const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/**
 * Express a SQLite timestamp (`YYYY-MM-DD HH:MM:SS`, always UTC) as ISO 8601 with
 * a `Z`. Without this the browser parses it as *local* time and every elapsed
 * counter (ticket age, prep time) is off by the user's UTC offset.
 */
export function toIso(value) {
  if (!value) return null;
  if (/[TZ]/.test(value)) return value;
  return value.replace(' ', 'T') + 'Z';
}

/** Full ISO timestamp (with ms + Z) — only for values that are not compared in SQL. */
export const nowIso = () => new Date().toISOString();

/**
 * Normalise any client timestamp (ISO with T/Z, or `YYYY-MM-DD HH:MM:SS`) into the
 * SQLite-comparable form used across the schema. Falls back to "now" on garbage input.
 */
export function toSqlTimestamp(value) {
  if (!value) return nowSql();
  const d = new Date(typeof value === 'string' && !/[TZ]/.test(value) ? value.replace(' ', 'T') + 'Z' : value);
  if (Number.isNaN(d.getTime())) return nowSql();
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function publicUser(u) {
  return {
    id: u.id,
    company_id: u.company_id,
    branch_id: u.branch_id,
    name: u.name,
    email: u.email,
    role: u.role,
    is_active: !!u.is_active,
    multi_branch: !!u.multi_branch,
    has_pin: !!u.pin_hash
  };
}

/** Wrap an async/sync handler so thrown errors become clean 500 JSON responses. */
export function wrap(fn) {
  return (req, res, next) => {
    try {
      const out = fn(req, res, next);
      if (out && typeof out.catch === 'function') out.catch(next);
    } catch (e) {
      next(e);
    }
  };
}

export function badRequest(res, msg) {
  return res.status(400).json({ error: msg });
}

export function notFound(res, msg = 'Not found') {
  return res.status(404).json({ error: msg });
}

/** Round money to 2 decimals to avoid float noise in totals. */
export const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Resolve the effective sale price of a product for a branch
 * (branch override wins over the master default price).
 */
export function branchPrice(branchId, productId, fallback) {
  const bp = db
    .prepare('SELECT price_override FROM branch_products WHERE branch_id = ? AND product_id = ?')
    .get(branchId, productId);
  if (bp && bp.price_override != null) return Number(bp.price_override);
  return Number(fallback) || 0;
}

/** Apply a signed stock delta for one product in one branch + write the movement log. */
export function applyStockDelta({ branchId, productId, delta, type, referenceId = null, note = null, userId = null }) {
  const row = db.prepare('SELECT * FROM branch_stocks WHERE branch_id = ? AND product_id = ?').get(branchId, productId);
  if (row) {
    db.prepare("UPDATE branch_stocks SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?")
      .run(delta, row.id);
  } else {
    db.prepare(
      `INSERT INTO branch_stocks (id, branch_id, product_id, quantity, low_stock_threshold)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id(), branchId, productId, delta, 5);
  }
  db.prepare(
    `INSERT INTO stock_movements (id, branch_id, product_id, type, quantity, reference_id, note, user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id(), branchId, productId, type, delta, referenceId, note, userId);
}

/** Build a WHERE fragment for date-range + branch filters on `transactions t`. */
export function txFilter({ companyId, branchIds = [], from, to, cashierId, statuses = ['completed'] }) {
  const conds = ['t.company_id = ?'];
  const params = [companyId];
  if (branchIds.length) {
    conds.push(`t.branch_id IN (${branchIds.map(() => '?').join(',')})`);
    params.push(...branchIds);
  }
  if (statuses.length) {
    conds.push(`t.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (from) {
    conds.push('t.created_at >= ?');
    params.push(from);
  }
  if (to) {
    conds.push('t.created_at <= ?');
    params.push(to);
  }
  if (cashierId) {
    conds.push('t.user_id = ?');
    params.push(cashierId);
  }
  return { where: conds.join(' AND '), params, raw: { companyId, branchIds, from, to, cashierId } };
}

/**
 * Rewrite the status clause produced by txFilter() to a different status set.
 * Inlines the statuses as quoted literals and drops their placeholder from `params`,
 * so the caller can reuse the same params array. Returns `{ where, params }`.
 */
export function withStatuses(filter, statuses) {
  const literals = statuses.map((s) => `'${s}'`).join(',');
  // Anchor on `) AND` / end-of-string so the lazy match can't stop inside `IN (?)`.
  const where = filter.where.replace(/t\.status IN \([^)]*\)(?=\s+AND\s|$)/, `t.status IN (${literals})`);
  // Rebuild params by re-running the filter without statuses (keeps ordering intact).
  const base = txFilter({ ...filter.raw, statuses: [] });
  return { where, params: base.params, raw: filter.raw };
}

/** RFC4180-ish CSV serialiser used by every export endpoint. */
export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','));
  return [header, ...body].join('\r\n');
}

export function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + csv);
}
