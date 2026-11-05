import express from 'express';
import { db } from '../db.js';
import { authRequired, requirePermission, auditFromReq } from '../auth.js';
import { wrap, badRequest } from '../lib/helpers.js';
import { isEdge } from '../edge.js';
import {
  CATEGORY_META,
  buildBundle,
  backupFilename,
  planRestore,
  applyRestore,
  validateBundle,
  countData
} from '../lib/backup.js';

const router = express.Router();

/**
 * Backup and restore of the operational database.
 *
 * Both halves need `company.manage`: an export is a complete copy of the business
 * (customers' sales, staff emails), and a restore can overwrite it. `product.manage`
 * would be far too broad a key for either.
 */

/**
 * Describe what can be backed up, so the UI does not hardcode the table lists.
 * Counts make the choice concrete: "data transaksi (1.204 baris)" is a decision,
 * "data transaksi" is a guess.
 */
router.get(
  '/backup/categories',
  authRequired,
  requirePermission('company.manage'),
  wrap((req, res) => {
    const counts = countData({ categories: undefined, companyId: req.user.company_id });
    res.json({
      // A till may take a snapshot (it is a genuine second copy of the local
      // data) but must never restore over its replica; see the guard below.
      canRestore: !isEdge(),
      categories: Object.entries(CATEGORY_META).map(([key, meta]) => ({
        key,
        label: meta.label,
        hint: meta.hint,
        tables: meta.tables,
        rows: meta.tables.reduce((n, t) => n + (counts[t] || 0), 0)
      }))
    });
  })
);

/**
 * GET /backup?categories=master,configuration
 *
 * Returns the bundle as a download. Defaults to everything when no category is
 * named, so "full backup" is one call and its behaviour cannot drift from the
 * list the UI shows.
 */
router.get(
  '/backup',
  authRequired,
  requirePermission('company.manage'),
  wrap((req, res) => {
    const categories = req.query.categories
      ? String(req.query.categories)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    const company = db
      .prepare('SELECT name FROM companies WHERE id = ?')
      .get(req.user.company_id);

    const bundle = buildBundle({
      categories,
      companyId: req.user.company_id,
      companyName: company?.name || null
    });

    auditFromReq(req, 'backup.export', 'backup', null, {
      categories: bundle.categories,
      counts: bundle.counts
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${backupFilename(company?.name)}"`);
    // Pretty-printed on purpose: a backup an operator can open and read is one
    // they can sanity-check before trusting it with a restore.
    res.send(JSON.stringify(bundle, null, 2));
  })
);

/**
 * A till holds a replica of the catalogue and the next bootstrap replaces it, so
 * a restore there would be silently discarded — and would also overwrite sales the
 * outbox has not drained yet. Backup stays allowed (a local snapshot is a genuine
 * second copy); restore does not.
 */
function restoreGuard(req, res, next) {
  if (isEdge()) {
    return res.status(409).json({
      error:
        'Restore hanya dapat dilakukan di server pusat. Data di perangkat kasir ' +
        'adalah salinan yang akan ditimpa saat sinkronisasi.'
    });
  }
  next();
}

/**
 * POST /backup/preview — dry run.
 *
 * Body: { bundle, categories? }
 *
 * Returns per-table `{ incoming, existing, added, updated, skipped }` and writes
 * nothing. Restore is destructive by nature, so the operator gets to see the blast
 * radius ("adds 340 sales, overwrites 12 products") before committing; the apply
 * runs the same planner, so the numbers shown are the numbers written.
 */
router.post(
  '/backup/preview',
  authRequired,
  requirePermission('company.manage'),
  restoreGuard,
  wrap((req, res) => {
    const { bundle, categories } = req.body || {};
    if (!bundle) return badRequest(res, 'File backup tidak dikirim');

    try {
      validateBundle(bundle);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }

    const plan = planRestore(bundle, { categories, companyId: req.user.company_id });
    const summary = Object.values(plan.tables).reduce(
      (acc, t) => ({
        added: acc.added + t.added,
        updated: acc.updated + t.updated,
        skipped: acc.skipped + t.skipped
      }),
      { added: 0, updated: 0, skipped: 0 }
    );

    res.json({
      ...plan,
      summary,
      // Echo the file's provenance so the operator can confirm they picked the
      // right file — a wrong bundle is the likeliest way to lose real data here.
      meta: {
        createdAt: bundle.createdAt || null,
        companyName: bundle.companyName || null,
        version: bundle.version ?? null,
        declaredCategories: bundle.categories,
        counts: bundle.counts || null
      }
    });
  })
);

/**
 * POST /backup/restore — apply.
 *
 * Body: { bundle, categories?, confirm }
 *
 * `confirm` must be the literal string `RESTORE`. That is not security — the
 * permission gate is — but it stops a stray request (or a mis-wired button) from
 * rewriting the database. Merged by primary key inside one transaction, so a
 * failure leaves the database exactly as it was.
 */
router.post(
  '/backup/restore',
  authRequired,
  requirePermission('company.manage'),
  restoreGuard,
  wrap((req, res) => {
    const { bundle, categories, confirm } = req.body || {};
    if (!bundle) return badRequest(res, 'File backup tidak dikirim');
    if (confirm !== 'RESTORE') {
      return badRequest(res, 'Konfirmasi restore tidak sah');
    }

    try {
      validateBundle(bundle);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }

    const result = applyRestore(bundle, {
      categories,
      userId: req.user.sub,
      companyId: req.user.company_id
    });

    res.json({
      ok: true,
      categories: result.categories,
      written: result.written,
      summary: Object.values(result.plan.tables).reduce(
        (acc, t) => ({
          added: acc.added + t.added,
          updated: acc.updated + t.updated
        }),
        { added: 0, updated: 0 }
      )
    });
  })
);

export default router;
