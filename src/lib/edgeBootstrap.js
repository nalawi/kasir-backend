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
      `INSERT INTO companies (id, name, currency, tax_percent, timezone)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, timezone = COALESCE(excluded.timezone, timezone)`
    ).run(
      companyId,
      snapshot.company.name || 'Toko',
      snapshot.company.currency || 'IDR',
      snapshot.company.tax_percent || 0,
      snapshot.company.timezone || null
    );

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

    // Categories must land before products: `products.category_id` has a foreign
    // key to `categories(id)`, so inserting a product that references a category
    // this till has never seen fails with FOREIGN KEY constraint failed. A fresh
    // till has no categories at all, which made the first bootstrap always fail.
    if (Array.isArray(snapshot.categories) && snapshot.categories.length) {
      const upCat = db.prepare(
        `INSERT INTO categories (id, company_id, name) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name`
      );
      for (const c of snapshot.categories) upCat.run(c.id, companyId, c.name);
    }

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
      // The row id must include the branch. `id` is the PRIMARY KEY, so a
      // product-only id (`bs_<product>`) collides the moment the same catalog is
      // replicated for a second branch — "UNIQUE constraint failed:
      // branch_stocks.id". The ON CONFLICT(branch_id, product_id) clause cannot
      // save it, because SQLite checks the primary key first. That broke
      // switching a till to another branch.
      upsertStock.run(
        `bs_${branchRow}_${p.id}`, branchRow, p.id, p.stock ?? 0, p.low_stock_threshold ?? 5, nowIso()
      );
      upsertBranchPrice.run(`bp_${branchRow}_${p.id}`, branchRow, p.id, p.price);
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

    // The branch roster. Without these rows the till cannot authenticate anybody
    // while offline; with only the PIN-holders it silently dropped staff.
    let userCount = 0;
    let pinUserCount = 0;
    if (Array.isArray(users) && users.length) {
      // A till set up via "register locally, then pair" already holds its own
      // admin row for the same person, under a different id but the same email
      // (users.email is UNIQUE). Upserting by id alone then fails on the email
      // index and rolls the whole bootstrap back.
      //
      // Resolve the collision in favour of the row already on this device and
      // update it in place, rather than deleting it: that row's id is baked into
      // tokens already issued to the person standing at the till, so deleting it
      // would log them out mid-session. The cloud's roster data (name, role,
      // pin_hash) still overwrites the local copy, which is what keeps the PIN
      // identical on both sides.
      const localByEmail = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?) AND id <> ?');
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
      // Refresh the pre-existing local row instead of inserting a second one.
      //
      // `company_id` used to be left alone here, on the reasoning that
      // authRequired rejects a token whose `company_id` differs from the stored
      // row ('Tenant mismatch'), so re-pointing the row at the cloud's company
      // would 401 the admin setting the till up. That protection is real but it
      // was applied to the wrong field: this statement *does* take `branch_id`
      // from the cloud, so skipping `company_id` leaves the row straddling two
      // tenants — a branch belonging to the cloud's company, under the old one.
      //
      // The result is unrecoverable from the client: `scopedBranchIds` builds the
      // scope from `users.company_id`, which still names the previous company, so
      // every branch the user actually has is "not in your scope". A super_admin
      // could re-pick another branch, but a cashier or single-outlet manager owns
      // exactly one branch and had no way back at all.
      //
      // Updating both columns together keeps the row internally consistent, which
      // is what the token and the scope both depend on. Sessions already issued
      // here do survive: they are refreshed through /auth/refresh, which re-reads
      // the row, and a stale token only costs a re-login rather than a till that
      // cannot leave the error page. The replica's own tenant is a local concern,
      // but a *consistent* one.
      const upLocal = db.prepare(
        `UPDATE users SET company_id = ?, branch_id = ?, name = ?, pin_hash = ?, role = ?,
                          avatar_url = ?, is_active = 1, updated_at = ?
         WHERE id = ?`
      );
      for (const u of users) {
        const localDup = localByEmail.get(u.email, u.id);
        const targetId = localDup ? localDup.id : u.id;
        if (localDup) {
          upLocal.run(
            companyId, u.branch_id ?? branchRow, u.name, u.pin_hash ?? null,
            u.role ?? 'cashier', u.avatar_url ?? null, nowIso(), targetId
          );
        } else {
          upUser.run(
            u.id, companyId, u.branch_id ?? branchRow, u.name, u.email,
            // The replica never authenticates with a password: password logins are
            // an online-only path that goes to the cloud. Store an unusable value so
            // the NOT NULL column is satisfied without inventing a credential.
            '!offline-replica',
            u.pin_hash ?? null, u.role ?? 'cashier',
            u.avatar_url ?? null, nowIso(), nowIso()
          );
        }
        userCount += 1;
        if (u.pin_hash) pinUserCount += 1;
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
      // Split out deliberately: `users` is the roster size, `pin_users` is how
      // many can actually unlock this till. Reporting one number let a till look
      // provisioned while nobody could log in to it.
      pin_users: pinUserCount,
      categories: Array.isArray(snapshot.categories) ? snapshot.categories.length : 0,
      synced_at: snapshot.synced_at || nowIso(),
    };
  });

  return run();
}
