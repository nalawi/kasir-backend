import { db } from '../db.js';
import { money, txFilter, withStatuses } from './helpers.js';

/**
 * Daily "quick summary" report for the owner.
 *
 * Kept separate from the generic report endpoints because its job is different:
 * it is a *message*, not a table. Everything here is built from the same
 * `txFilter()` helper the dashboard uses, so the numbers on the owner's phone
 * always agree with the numbers on the Reports page.
 *
 * `buildDailyBrief()` returns the structured data and `renderBriefText()` turns
 * it into WhatsApp-friendly plain text. Both the JSON endpoint
 * (`/reports/daily-brief`) and the text endpoint (`/reports/daily-brief/text`)
 * go through them, so the browser preview and any future scheduled sender
 * produce byte-identical wording.
 */

/** Money grouped like the POS UI ("Rp 1.250.000") so the message matches the app. */
export function formatRp(value, lang = 'id') {
  const n = Number(value) || 0;
  const digits = new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'id-ID', {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0
  }).format(Math.abs(n));
  return `${n < 0 ? '-' : ''}Rp ${digits}`;
}

/**
 * Convert a *local* calendar day into the UTC window that contains it.
 *
 * Transactions are stored in UTC, but "today" for the owner means today in the
 * shop's timezone. Filtering `'2026-11-03 00:00:00'..'23:59:59'` (UTC) is wrong
 * outside UTC: a 01:30 WIB sale on Nov 3 is stored as `2026-11-02 18:30 UTC`
 * and would be reported on Nov 2 instead of Nov 3.
 *
 * So take the requested day's 00:00 and 24:00 *in the company's zone*, then
 * convert both bounds to UTC. Falls back to a plain UTC day when no zone is set.
 */
function dayBounds(date, timeZone = null) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : new Date().toISOString().slice(0, 10);
  const utcDay = { day: d, from: `${d} 00:00:00`, to: `${d} 23:59:59` };
  if (!timeZone) return utcDay;

  const offsetMinutes = zoneOffset(d, timeZone);
  if (offsetMinutes === null) return utcDay;

  // Local midnight is `offset` ahead of UTC, so subtract it to get the UTC instant.
  const start = new Date(Date.parse(`${d}T00:00:00Z`) - offsetMinutes * 60000);
  const end = new Date(start.getTime() + 24 * 3600 * 1000 - 1000);
  const sql = (x) => x.toISOString().slice(0, 19).replace('T', ' ');
  return { day: d, from: sql(start), to: sql(end) };
}

/**
 * Offset in minutes of `timeZone` from UTC at 12:00 on `dateStr`.
 *
 * Reads the zone's wall-clock time back via `Intl` (so DST transitions are
 * handled) and diffs it against the same instant in UTC. Returns null if the
 * zone is unknown, letting callers fall back to UTC rather than throwing.
 */
function zoneOffset(dateStr, timeZone) {
  try {
    const inst = new Date(`${dateStr}T12:00:00Z`);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(inst);
    const get = (t) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return Math.round((asUtc - inst.getTime()) / 60000);
  } catch {
    return null;
  }
}

/**
 * Shift a stored UTC hour into the company's local hour.
 *
 * Transactions are stored in UTC, so `strftime('%H', created_at)` on a sale at
 * 08:14 WIB returns "01". Reporting that to an owner in Jakarta as the "busiest
 * hour" is simply wrong, so the busiest hour is converted before it is rendered.
 *
 * Uses the IANA zone from `companies.timezone` rather than a fixed offset so
 * zones with DST (and future changes) stay correct. Falls back to UTC when the
 * zone is missing or the runtime rejects it.
 */
function localHour(utcHour, dateStr, timeZone) {
  const h = Number(utcHour);
  if (!Number.isFinite(h)) return utcHour;
  if (!timeZone) return utcHour;
  try {
    // Build the UTC instant for that day+hour, then read the hour back in the
    // target zone. `hour12: false` keeps midnight as "00" instead of "24".
    const inst = new Date(`${dateStr}T${String(h).padStart(2, '0')}:30:00Z`);
    const out = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(inst);
    return out === '24' ? '00' : out;
  } catch {
    return utcHour;
  }
}

const DAY_NAMES = {
  id: ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
};

const MONTH_NAMES = {
  id: ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
};

/** "Senin, 2 November 2026" — spelled out because WhatsApp readers skim. */
function longDate(day, lang = 'id') {
  const d = new Date(`${day}T00:00:00Z`);
  const days = DAY_NAMES[lang] || DAY_NAMES.id;
  const months = MONTH_NAMES[lang] || MONTH_NAMES.id;
  return `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export const PAYMENT_LABELS = {
  cash: { id: 'Tunai', en: 'Cash' },
  card: { id: 'Kartu', en: 'Card' },
  qris: { id: 'QRIS', en: 'QRIS' },
  transfer: { id: 'Transfer', en: 'Transfer' },
  ewallet: { id: 'E-Wallet', en: 'E-Wallet' },
  other: { id: 'Lainnya', en: 'Other' }
};

export function paymentLabel(method, lang = 'id') {
  const set = PAYMENT_LABELS[method];
  if (set) return set[lang] || set.id;
  if (!method) return lang === 'en' ? 'Other' : 'Lainnya';
  return String(method);
}

/**
 * Collect every figure the brief needs for one branch (or the whole scope) on
 * one day.
 *
 * `topProducts` is capped at 3 — a WhatsApp message that needs scrolling gets
 * ignored. `busiestHour` is included because "rame jam berapa" is the question
 * owners actually ask after the revenue number.
 */
export function buildDailyBrief({ companyId, branchIds, date, timeZone = null }) {
  const { day, from, to } = dayBounds(date, timeZone);
  const { where, params } = txFilter({ companyId, branchIds, from, to });

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS transactions,
              COALESCE(SUM(t.subtotal),0) AS gross,
              COALESCE(SUM(t.discount),0) AS discount,
              COALESCE(SUM(t.tax),0) AS tax,
              COALESCE(SUM(t.total),0) AS revenue,
              COALESCE(AVG(t.total),0) AS avg_ticket,
              COUNT(DISTINCT t.user_id) AS cashiers,
              COALESCE(SUM((SELECT COALESCE(SUM(i.cost_price * i.quantity),0)
                            FROM transaction_items i WHERE i.transaction_id = t.id)),0) AS cogs
       FROM transactions t WHERE ${where}`
    )
    .get(...params);

  // Items sold is a better "how busy were we" signal than transaction count
  // for a coffee shop, so it rides along with the totals.
  const items = db
    .prepare(
      `SELECT COALESCE(SUM(i.quantity),0) AS qty
       FROM transaction_items i JOIN transactions t ON t.id = i.transaction_id
       WHERE ${where}`
    )
    .get(...params);

  const payments = db
    .prepare(
      `SELECT t.payment_method AS method, COUNT(*) AS count, COALESCE(SUM(t.total),0) AS total
       FROM transactions t WHERE ${where}
       GROUP BY t.payment_method ORDER BY total DESC`
    )
    .all(...params);

  const topProducts = db
    .prepare(
      `SELECT i.product_name, COALESCE(SUM(i.quantity),0) AS quantity,
              COALESCE(SUM(i.subtotal),0) AS revenue
       FROM transaction_items i JOIN transactions t ON t.id = i.transaction_id
       WHERE ${where}
       GROUP BY i.product_id, i.product_name
       ORDER BY quantity DESC, revenue DESC LIMIT 3`
    )
    .all(...params);

  const hours = db
    .prepare(
      `SELECT strftime('%H', t.created_at) AS hour, COUNT(*) AS transactions,
              COALESCE(SUM(t.total),0) AS revenue
       FROM transactions t WHERE ${where}
       GROUP BY hour ORDER BY revenue DESC LIMIT 1`
    )
    .all(...params);

  // Voids are reported separately: they are excluded from `completed` revenue, so
  // an owner who sees a small revenue number needs to know money was voided.
  const voidFilter = withStatuses(txFilter({ companyId, branchIds, from, to }), ['voided']);
  const voided = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(t.total),0) AS total
       FROM transactions t WHERE ${voidFilter.where}`
    )
    .get(...voidFilter.params);

  const branchName =
    branchIds?.length === 1
      ? db.prepare('SELECT name FROM branches WHERE id = ?').get(branchIds[0])?.name || null
      : null;

  const busiest = hours[0] || null;

  return {
    date: day,
    branch_id: branchIds?.length === 1 ? branchIds[0] : null,
    branch_name: branchName,
    transactions: totals.transactions,
    items_sold: Math.round(Number(items.qty) || 0),
    gross: money(totals.gross),
    discount: money(totals.discount),
    tax: money(totals.tax),
    revenue: money(totals.revenue),
    cogs: money(totals.cogs),
    gross_profit: money(totals.revenue - totals.cogs),
    margin_percent: totals.revenue ? money(((totals.revenue - totals.cogs) / totals.revenue) * 100) : 0,
    avg_ticket: money(totals.avg_ticket),
    cashiers: totals.cashiers,
    void_count: voided.n,
    void_total: money(voided.total),
    by_payment: payments.map((p) => ({ ...p, total: money(p.total) })),
    top_products: topProducts.map((p) => ({
      ...p,
      quantity: Math.round(Number(p.quantity) || 0),
      revenue: money(p.revenue)
    })),
    busiest_hour: busiest
      ? {
          hour: localHour(busiest.hour, day, timeZone),
          transactions: busiest.transactions,
          revenue: money(busiest.revenue)
        }
      : null
  };
}

/**
 * Render the brief as plain text for WhatsApp.
 * Uses WhatsApp's own formatting (`*bold*`) rather than Markdown, since `**` shows
 * up literally there. Lines are short and the whole thing stays under ~900
 * characters so it fits one phone screen.
 */
export function renderBriefText(brief, { lang = 'id', companyName = null, branchName = null } = {}) {
  const en = lang === 'en';
  const rp = (n) => formatRp(n, lang);
  const scope = branchName || brief.branch_name;
  const L = [];

  L.push(`*${en ? 'DAILY SUMMARY' : 'RINGKASAN HARIAN'}*`);
  if (companyName) L.push(companyName);
  if (scope) L.push(scope);
  L.push(longDate(brief.date, lang));
  L.push('');

  if (!brief.transactions) {
    L.push(en ? '_No sales recorded today._' : '_Belum ada penjualan hari ini._');
    return L.join('\n');
  }

  L.push(`${en ? 'Revenue' : 'Omzet'}: *${rp(brief.revenue)}*`);
  L.push(`${en ? 'Transactions' : 'Transaksi'}: ${brief.transactions}`);
  L.push(`${en ? 'Items sold' : 'Item terjual'}: ${brief.items_sold}`);
  L.push(`${en ? 'Avg / receipt' : 'Rata-rata / nota'}: ${rp(brief.avg_ticket)}`);

  if (brief.by_payment?.length) {
    L.push('');
    L.push(`*${en ? 'Payment' : 'Pembayaran'}*`);
    for (const p of brief.by_payment) {
      L.push(`• ${paymentLabel(p.method, lang)}: ${rp(p.total)} (${p.count}x)`);
    }
  }

  if (brief.top_products?.length) {
    L.push('');
    L.push(`*${en ? 'Top sellers' : 'Terlaris'}*`);
    brief.top_products.forEach((p, i) => {
      L.push(`${i + 1}. ${p.product_name} — ${p.quantity}${en ? ' sold' : ' pcs'}`);
    });
  }

  if (brief.busiest_hour) {
    L.push('');
    L.push(
      `${en ? 'Busiest hour' : 'Jam tersibuk'}: ${brief.busiest_hour.hour}:00 (${rp(brief.busiest_hour.revenue)})`
    );
  }

  // Profit only when it is meaningful — an owner reading a 0.0% margin due to
  // missing cost prices would draw the wrong conclusion.
  if (brief.cogs > 0) {
    L.push('');
    L.push(`${en ? 'Gross profit' : 'Laba kotor'}: ${rp(brief.gross_profit)} (${Number(brief.margin_percent).toFixed(1)}%)`);
  }

  if (brief.void_count > 0) {
    L.push('');
    L.push(`⚠️ ${en ? 'Voided' : 'Void'}: ${brief.void_count}x ${rp(brief.void_total)}`);
  }

  L.push('');
  L.push(`_${en ? 'Sent from POS Multi-Cabang' : 'Dikirim dari POS Multi-Cabang'}_`);
  return L.join('\n');
}


