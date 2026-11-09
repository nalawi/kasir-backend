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
 * The snapshot carries the company's custom roles as well as the catalog: a till
 * that replicated `users.role` strings without the roles they name left every
 * custom-role user able to unlock the till and unable to open a single page.
 *
 * It also carries each product's variants, which the POS needs in order to offer
 * "Large +4.000" and to price it: without the rows the catalog looked correct and
 * every variant silently disappeared.
 *
 * Returns a summary for the UI and logs.
 */
export function applyBootstrap({ snapshot, users = [], branchId }) {
  if (!snapshot || !snapshot.products) throw new Error('Snapshot tidak valid');

  const run = db.transaction(() => {
    const productIds = [];
    let variantCount = 0;

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

    // `cost_price` is replicated alongside the selling price. It is not decoration:
    // `createTransaction` stamps each line's `cost_price` from the product row, and
    // every report on this till (profit, COGS, stock value) sums those columns. The
    // snapshot used to carry only the selling price, so a bootstrapped till sold at
    // the right price and reported a 100 % margin — numbers that disagreed with the
    // cloud for the same day's sales.
    const upsertProduct = db.prepare(
      `INSERT INTO products (id, company_id, name, sku, barcode, category_id, unit, image_url,
                             cost_price, default_price, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, sku = excluded.sku, barcode = excluded.barcode,
         category_id = excluded.category_id, unit = excluded.unit,
         image_url = excluded.image_url, cost_price = excluded.cost_price,
         default_price = excluded.default_price,
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

    // Variants: the third thing a till sells, and the one it used to have to
    // guess. The POS offers "Large +4.000" out of `product_variants`, `GET
    // /products` counts them for the Variants column, and `priceCart` adds
    // `price_adjustment` to the branch price. None of that worked offline because
    // the rows were never copied: every product arrived with a variant count of
    // 0 and the POS silently charged the base price. The snapshot has carried
    // `variants` inside each product since it was written; this is the half that
    // applies it.
    const variantById = db.prepare('SELECT id FROM product_variants WHERE id = ?');
    const variantByTwin = db.prepare(
      'SELECT id FROM product_variants WHERE product_id = ? AND name = ? AND variant_type = ? LIMIT 1'
    );
    const localActiveVariants = db.prepare(
      'SELECT id FROM product_variants WHERE product_id = ? AND is_active = 1'
    );
    const deactivateVariant = db.prepare('UPDATE product_variants SET is_active = 0 WHERE id = ?');
    const upsertVariant = db.prepare(
      `INSERT INTO product_variants (id, company_id, product_id, name, variant_type,
                                     price_adjustment, is_default, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET
         company_id = excluded.company_id,
         product_id = excluded.product_id,
         name = excluded.name,
         variant_type = excluded.variant_type,
         price_adjustment = excluded.price_adjustment,
         is_default = excluded.is_default,
         is_active = 1,
         sort_order = excluded.sort_order`
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
        // A snapshot from a service that predates the column omits it; write 0
        // rather than NULL, which is the value the till used to produce anyway and
        // keeps the report arithmetic (`SUM(cost_price * quantity)`) numeric.
        Number(p.cost_price) || 0,
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

      // Variants of this product. Kept per product so a variant is only ever
      // written for a product this replica actually holds: `product_id` is a
      // foreign key, and the snapshot still lists variants of products that were
      // filtered out here (inactive, or hidden at this branch).
      const keptVariantIds = new Set();
      for (const v of Array.isArray(p.variants) ? p.variants : []) {
        if (!v || typeof v.name !== 'string' || !v.name) continue;
        const type = v.variant_type || 'option';
        // Prefer the cloud's id, but adopt a row this till already holds under
        // the same (product, name, type): a till lets a manager create variants
        // locally, and a second row for one option would leave the POS charging
        // whichever of the two it happened to read. Same reasoning as custom
        // roles, which are keyed on name for the same reason.
        let variantId = v.id;
        if (!variantId || !variantById.get(variantId)) {
          const twin = variantByTwin.get(p.id, v.name, type);
          if (twin && !keptVariantIds.has(twin.id)) variantId = twin.id;
        }
        if (!variantId) variantId = `pv_${p.id}_${keptVariantIds.size}`;
        keptVariantIds.add(variantId);
        upsertVariant.run(
          variantId, companyId, p.id, v.name, type,
          Number(v.price_adjustment) || 0, v.is_default ? 1 : 0, Number(v.sort_order) || 0
        );
        variantCount += 1;
      }

      // A variant switched off (or deleted) in the cloud is absent from the
      // snapshot, so the loop above cannot see it. Deactivate rather than delete:
      // yesterday's receipts and transaction_items still name it, and a row left
      // active would keep offering — and charging — an option the shop has
      // already withdrawn.
      for (const row of localActiveVariants.all(p.id)) {
        if (!keptVariantIds.has(row.id)) deactivateVariant.run(row.id);
      }
    }

    // Sales rung up while the replica had no cost were stamped `cost_price = 0`
    // (that is what `createTransaction` copies off the product row), and the profit
    // report sums exactly that column. Fixing the catalog alone would leave every
    // sale made before this bootstrap reporting a 100 % margin forever, so repair
    // the lines that carry no cost now that the replica finally knows one.
    //
    // Deliberately narrow: only lines whose cost is absent (`0`/NULL), only for
    // products this snapshot prices above zero (a genuine giveaway item keeps its
    // zero), only inside the company this snapshot belongs to (a re-paired till may
    // still hold another tenant's history), and only once — after this the guard no
    // longer matches. Costs are not versioned per line, so the current cost is the
    // best available approximation; it is strictly closer to the cloud's figure than
    // the zero it replaces.
    const costsFixed = db
      .prepare(
        `UPDATE transaction_items
            SET cost_price = (SELECT p.cost_price FROM products p WHERE p.id = transaction_items.product_id)
          WHERE (transaction_items.cost_price IS NULL OR transaction_items.cost_price = 0)
            AND transaction_items.product_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM products p
                         WHERE p.id = transaction_items.product_id AND p.cost_price > 0)
            AND EXISTS (SELECT 1 FROM transactions t
                         WHERE t.id = transaction_items.transaction_id AND t.company_id = ?)`
      )
      .run(companyId).changes;

    // Hide products the cloud no longer sells at this branch. Deleting would
    // orphan the sales history that points at them.
    if (productIds.length) {
      const marks = productIds.map(() => '?').join(',');
      db.prepare(
        `UPDATE products SET is_active = 0
         WHERE company_id = ? AND is_active = 1 AND id NOT IN (${marks})`
      ).run(companyId, ...productIds);
    }

    // Custom roles land before the roster, and they are what makes a replicated
    // `users.role` mean anything. `users.role` is a bare string: without a `roles`
    // row to resolve it against, `getPermissions` returns `[]`, so a staff member
    // on a custom role could unlock the till and then have every guarded page
    // bounce them to the dashboard with no explanation. That failure only shows up
    // offline, in the field, which is exactly where it hurts most.
    //
    // System roles are not in the payload: they live in code (`permissions.js`) on
    // both sides, so replicating them would only let two copies drift.
    //
    // Keyed on the role *name*, because name is what `users.role` stores. A till
    // that created the same role locally has a row with a different id, so the id
    // is derived from (company, name) — the same trick `bs_`/`bp_` above use — and
    // an existing local row is reused rather than duplicated. Two rows for one
    // name would let `getPermissions`' single-row lookup return either.
    //
    // Rows deleted in the cloud are left alone rather than pruned: a role cannot
    // be deleted while a user holds it, so a leftover row is unreferenced, and
    // deleting blindly would also wipe roles this replica legitimately created.
    let roleCount = 0;
    if (Array.isArray(snapshot.roles) && snapshot.roles.length) {
      const findRole = db.prepare('SELECT id FROM roles WHERE company_id = ? AND name = ? LIMIT 1');
      const upsertRole = db.prepare(
        `INSERT INTO roles (id, company_id, name, permissions, is_system)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           permissions = excluded.permissions,
           company_id = excluded.company_id`
      );
      for (const r of snapshot.roles) {
        if (!r || typeof r.name !== 'string' || !r.name) continue;
        const permissions = JSON.stringify(Array.isArray(r.permissions) ? r.permissions : []);
        const local = findRole.get(companyId, r.name);
        upsertRole.run(local ? local.id : `role_${companyId}_${r.name}`, companyId, r.name, permissions);
        roleCount += 1;
      }
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
      // Variants replicated. Separate from `products` because a catalog can look
      // complete (every product, every price) while the POS still cannot sell
      // "Large": that is what happened when the count was silently zero.
      variants: variantCount,
      // Custom roles replicated. Split out so a shop can tell the difference
      // between "the roster came over" and "the roster can actually do its job":
      // with 6 users and 0 roles, everybody on a custom role is locked out.
      roles: roleCount,
      // Past sale lines that had no cost and now carry the product's. Reported
      // separately from `products` because it is history being repaired, not the
      // catalog being copied, and a shop checking why yesterday's margin moved
      // deserves to see it counted.
      costs_fixed: costsFixed,
      synced_at: snapshot.synced_at || nowIso(),
    };
  });

  return run();
}
