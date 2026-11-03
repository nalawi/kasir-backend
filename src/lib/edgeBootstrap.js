// Pull the cloud's snapshot into the edge replica.
//
// A till that has never synced can ring up a sale but nobody can log in to it:
// `users` is empty, so `/edge/unlock` has nothing to verify a PIN against, and
// the catalog is blank. This module fills that gap by copying the cloud's
// `/sync/bootstrap` payload and the PIN-capable user list into the local database.
//
// Design notes:
//   * Idempotent. Every write is an UPSERT keyed on the cloud's own ids, so
//     syncing twice is harmless and re-running after a catalog change just
//     refreshes the rows.
//   * Never destructive. Products missing from the snapshot are marked inactive
//     rather than deleted, so a historical sale that references one still shows
//     its name in reports.
//   * Stock is replaced, not added. The cloud is the authority on what is on the
//     shelf; a partial merge would double-count.
//   * One transaction. A half-applied catalog is worse than no catalog, so a
//     failure anywhere rolls the whole pull back and the till keeps its old data.

import { db } from '../db.js';

const nowIso = () => new Date().toISOString();


/**
 * Copy one branch's snapshot into the replica.
 *
 * `snapshot` is the body of the cloud's GET /sync/bootstrap. `users` is the array
 * of PIN-capable users including `pin_hash`, so offline login verifies against
 * the same bcrypt hash the cloud checks.
 *
 * Returns a summary for the UI and logs.
 */
export function applyBootstrap({ snapshot, users = [], branchId }) {
  if (!snapshot || !snapshot.products) throw new Error('Snapshot tidak valid');

  const run = db.transaction(() => {
    const productIds = [];

    // Parents first: every replicated row references companies/branches, and on a
    // till paired to a different cloud those rows do not exist yet. UPSERT keeps
    // an existing company's name edits from being clobbered by an older snapshot.
    const companyId = snapshot.company.id;
    const branch = snapshot.branch || {};
    const branchRow = branch.id || branchId;

    db.prepare(
      `INSERT INTO companies (id, name, currency, tax_percent)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`
    ).run(companyId, snapshot.company.name || 'Toko', snapshot.company.currency || 'IDR', snapshot.company.tax_percent || 0);

    db.prepare(
      `INSERT INTO branches (id, company_id, name, address, phone, is_active)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`
    ).run(branchRow, companyId, branch.name || 'Cabang', branch.address ?? null, branch.phone ?? null);

    const upsertProduct = db.prepare(
      `INSERT INTO products (id, company_id, name, sku, barcode, category_id, unit, image_url,
                             default_price, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, sku = excluded.sku, barcode = excluded.barcode,
         category_id = excluded.category_id, unit = excluded.unit,
         image_url = excluded.image_url, default_price = excluded.default_price,
         is_active = 1`
    );

    const upsertStock = db.prepare(
      `INSERT INTO branch_stocks (id, branch_id, product_id, quantity, low_stock_threshold, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(branch_id, product_id) DO UPDATE SET
         quantity = excluded.quantity,
         low_stock_threshold = excluded.low_stock_threshold,
         updated_at = excluded.updated_at`
    );

    const upsertBranchPrice = db.prepare(
      `INSERT INTO branch_products (id, branch_id, product_id, price_override, is_available)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(branch_id, product_id) DO UPDATE SET
         price_override = excluded.price_override, is_available = 1`
    );

    for (const p of snapshot.products) {
      productIds.push(p.id);
      // The cloud sends the branch-effective price, so the replica stores the
      // base price and an explicit branch override — otherwise a branch that
      // later clears its override would keep the stale effective price.
      upsertProduct.run(
        p.id, companyId, p.name, p.sku ?? null, p.barcode ?? null,
        p.category_id ?? null, p.unit ?? null, p.image_url ?? null,
        p.price, nowIso()
      );
      upsertStock.run(
        `bs_${p.id}`, branchRow, p.id, p.stock ?? 0, p.low_stock_threshold ?? 5, nowIso()
      );
      upsertBranchPrice.run(`bp_${p.id}`, branchRow, p.id, p.price);
    }


    // Hide products the cloud no longer sells at this branch. Deleting would
    // orphan the sales history that points at them.
    if (productIds.length) {
      const marks = productIds.map(() => '?').join(',');
      db.prepare(
        `UPDATE products SET is_active = 0
         WHERE company_id = ? AND is_active = 1 AND id NOT IN (${marks})`
      ).run(companyId, ...productIds);
    }

    if (Array.isArray(snapshot.categories) && snapshot.categories.length) {
      const upCat = db.prepare(
        `INSERT INTO categories (id, company_id, name) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`
      );
      for (const c of snapshot.categories) upCat.run(c.id, companyId, c.name);
    }

    // PIN-capable users: the whole point of the pull. Without these rows the
    // till cannot authenticate anybody while offline.
    let userCount = 0;
    if (Array.isArray(users) && users.length) {
      const upUser = db.prepare(
        `INSERT INTO users (id, company_id, branch_id, name, email, password_hash, pin_hash,
                            role, is_active, avatar_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           email = excluded.email,
           pin_hash = excluded.pin_hash,
           role = excluded.role,
           branch_id = excluded.branch_id,
           avatar_url = excluded.avatar_url,
           is_active = 1,
           updated_at = excluded.updated_at`
      );
      for (const u of users) {
        upUser.run(
          u.id, companyId, u.branch_id ?? branchRow, u.name, u.email,
          // The replica never authenticates with a password: password logins are
          // an online-only path that goes to the cloud. Store an unusable value so
          // the NOT NULL column is satisfied without inventing a credential.
          '!offline-replica',
          u.pin_hash ?? null, u.role ?? 'cashier',
          u.avatar_url ?? null, nowIso(), nowIso()
        );
        userCount += 1;
      }
    }

    // Record when we last heard from the cloud so the UI can show staleness.
    const setSetting = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    setSetting.run('edge_last_bootstrap_at', nowIso());
    setSetting.run('edge_company_id', companyId);
    setSetting.run('edge_branch_id', branchRow);

    return {
      products: productIds.length,
      users: userCount,
      categories: Array.isArray(snapshot.categories) ? snapshot.categories.length : 0,
      synced_at: snapshot.synced_at || nowIso(),
    };
  });

  return run();
}
