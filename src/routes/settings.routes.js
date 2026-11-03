import express from 'express';
import { db } from '../db.js';
import { authRequired, requirePermission, audit } from '../auth.js';
import { wrap, badRequest } from '../lib/helpers.js';

const router = express.Router();

/**
 * Settings an operator may read and change over the API.
 *
 * Deliberately an allowlist rather than "whatever is in the table". `settings`
 * also holds machine-managed keys (the edge_* upstream credentials), and a
 * blanket writer would let a caller point a till at an arbitrary upstream — which
 * is precisely the authority POST /edge/pair gates behind device.manage.
 *
 * Adding a key here is a conscious decision to expose it; see also
 * TILL_SETTING_KEYS in sync.routes.js, which is the (smaller) set a till needs.
 */
export const EDITABLE_SETTINGS = {
  allow_negative_stock: {
    values: ['warn', 'block', 'ignore'],
    label: 'Perilaku saat stok tidak cukup'
  },
  cash_tolerance: { numeric: true, label: 'Toleransi selisih kas saat tutup shift' },
  tax_percent: { numeric: true, label: 'Pajak default (%)' },
  currency: { label: 'Mata uang' },
  locale: { label: 'Bahasa / locale' },
  receipt_footer: { label: 'Teks catatan kaki struk' },
  low_stock_default: { numeric: true, label: 'Ambang stok menipis default' }
};

/** GET /settings — current values of the editable keys, with their metadata. */
router.get('/settings', authRequired, requirePermission('company.manage'), wrap((req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const current = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  res.json(
    Object.entries(EDITABLE_SETTINGS).map(([key, meta]) => ({
      key,
      value: current[key] ?? null,
      label: meta.label,
      values: meta.values || null,
      numeric: !!meta.numeric
    }))
  );
}));

/**
 * PUT /settings — update one or more editable keys.
 *
 * Body: { allow_negative_stock: 'block', cash_tolerance: 5000 }
 *
 * Unknown keys are rejected rather than ignored: silently dropping a typo'd key
 * would leave an operator believing a money-path policy is in force when it is
 * not.
 */
router.put('/settings', authRequired, requirePermission('company.manage'), wrap((req, res) => {
  const body = req.body || {};
  const keys = Object.keys(body);
  if (!keys.length) return badRequest(res, 'Tidak ada pengaturan yang dikirim');

  const unknown = keys.filter((k) => !Object.hasOwn(EDITABLE_SETTINGS, k));
  if (unknown.length) return badRequest(res, `Pengaturan tidak dikenal: ${unknown.join(', ')}`);

  const updates = [];
  for (const key of keys) {
    const meta = EDITABLE_SETTINGS[key];
    const raw = body[key];

    if (raw === null || raw === undefined || raw === '') {
      return badRequest(res, `${key} tidak boleh kosong`);
    }

    let value;
    if (meta.values) {
      // Enum: reject an out-of-range value instead of falling back to a default.
      value = String(raw).trim().toLowerCase();
      if (!meta.values.includes(value)) {
        return badRequest(res, `${key} harus salah satu dari: ${meta.values.join(', ')}`);
      }
    } else if (meta.numeric) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return badRequest(res, `${key} harus angka >= 0`);
      value = String(n);
    } else {
      value = String(raw).slice(0, 500);
    }
    updates.push([key, value]);
  }

  const previous = Object.fromEntries(
    db.prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`).all(...keys).map((r) => [r.key, r.value])
  );

  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.transaction(() => {
    for (const [key, value] of updates) stmt.run(key, value);
  })();

  // Settings are money-path configuration; record what changed and from what.
  audit({
    company_id: req.user.company_id,
    user_id: req.user.sub,
    action: 'settings.update',
    entity: 'settings',
    entity_id: null,
    detail: { changed: Object.fromEntries(updates), previous },
    ip: req.ip
  });

  res.json({ updated: Object.fromEntries(updates) });
}));

export default router;
