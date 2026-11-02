import fs from 'fs';
import path from 'path';
import express from 'express';
import { db } from '../db.js';
import { authRequired, requirePermission, audit, assertBranchAccess } from '../auth.js';
import { id, wrap, badRequest, notFound, branchPrice } from '../lib/helpers.js';

const router = express.Router();

/* --------------------------- PRODUCT IMAGES --------------------------- */

// Same directory server.js serves statically. Resolved from cwd so both agree.
const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads');

const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB — plenty for a product thumbnail
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

/**
 * Saves a base64 data URI (`data:image/png;base64,....`) to disk.
 * Returns the public `/uploads/<file>` path, or null when the input is not an image.
 *
 * Base64 is used instead of multipart so the frontend needs no extra dependency
 * and the existing 5 MB JSON body limit covers a 2 MB image.
 */
function saveDataUri(dataUri) {
  if (typeof dataUri !== 'string') return null;
  const match = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUri.trim());
  if (!match) return null;
  const [, mime, b64] = match;
  const ext = IMAGE_EXT[mime.toLowerCase()];
  if (!ext) return null;
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const filename = `p_${id()}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
  return `/uploads/${filename}`;
}

/** Best-effort removal of an uploaded file so replaced photos don't leak. */
function removeUpload(imageUrl) {
  if (typeof imageUrl !== 'string' || !imageUrl.startsWith('/uploads/')) return;
  // Strip the prefix and any query/hash, then confirm the result stays inside UPLOAD_DIR.
  const name = path.basename(imageUrl.split('?')[0].split('#')[0]);
  const full = path.join(UPLOAD_DIR, name);
  if (!full.startsWith(UPLOAD_DIR + path.sep)) return;
  try {
    fs.unlinkSync(full);
  } catch {
    /* already gone — nothing to do */
  }
}

/**
 * POST /products/upload-image
 * Body: { image: "data:image/png;base64,..." }
 * Returns: { image_url: "/uploads/p_xxx.png" }
 */
router.post('/products/upload-image', authRequired, requirePermission('product.manage'), wrap((req, res) => {
  const imageUrl = saveDataUri(req.body?.image);
  if (!imageUrl) return badRequest(res, 'Format gambar tidak didukung (jpg, png, webp, gif maks 2MB)');
  audit({
    company_id: req.user.company_id, user_id: req.user.sub, action: 'product.image_upload',
    entity: 'product', entity_id: null, detail: { image_url: imageUrl }, ip: req.ip,
  });
  res.status(201).json({ image_url: imageUrl });
}));

/* ----------------------------- CATEGORIES ----------------------------- */

router.get('/categories', authRequired, (req, res) => {
  res.json(db.prepare('SELECT * FROM categories WHERE company_id = ? ORDER BY name').all(req.user.company_id));
});

router.post('/categories', authRequired, requirePermission('product.manage'), wrap((req, res) => {
  if (!req.body.name) return badRequest(res, 'name required');
  const cid = id();
  db.prepare('INSERT INTO categories (id, company_id, name) VALUES (?, ?, ?)').run(cid, req.user.company_id, req.body.name);
  audit({ company_id: req.user.company_id, user_id: req.user.sub, action: 'category.create', entity: 'category', entity_id: cid, detail: req.body, ip: req.ip });
  res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(cid));
}));

router.put('/categories/:id', authRequired, requirePermission('product.manage'), wrap((req, res) => {
  const c = db.prepare('SELECT * FROM categories WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!c) return notFound(res);
  db.prepare('UPDATE categories SET name = COALESCE(?, name) WHERE id = ?').run(req.body.name || null, c.id);
  audit({ company_id: req.user.company_id, user_id: req.user.sub, action: 'category.update', entity: 'category', entity_id: c.id, detail: req.body, ip: req.ip });
  res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(c.id));
}));

router.delete('/categories/:id', authRequired, requirePermission('product.manage'), wrap((req, res) => {
  const c = db.prepare('SELECT * FROM categories WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!c) return notFound(res);
  db.prepare('DELETE FROM categories WHERE id = ?').run(c.id);
  audit({ company_id: req.user.company_id, user_id: req.user.sub, action: 'category.delete', entity: 'category', entity_id: c.id, detail: { name: c.name }, ip: req.ip });
  res.json({ ok: true });
}));

/* ------------------------------ PRODUCTS ------------------------------ */

/** Cost price is only exposed to roles holding `product.view_cost`. */
function stripCost(rows, req) {
  if (req.permissions.includes('product.view_cost')) return rows;
  const strip = (r) => ({ ...r, cost_price: undefined });
  return Array.isArray(rows) ? rows.map(strip) : rows && strip(rows);
}

router.get('/products', authRequired, (req, res) => {
  const { q, category_id, include_inactive } = req.query;
  const conds = ['p.company_id = ?'];
  const params = [req.user.company_id];
  if (!include_inactive) conds.push('p.is_active = 1');
  if (category_id) {
    conds.push('p.category_id = ?');
    params.push(category_id);
  }
  if (q) {
    conds.push("(lower(p.name) LIKE ? OR lower(COALESCE(p.sku,'')) LIKE ? OR lower(COALESCE(p.barcode,'')) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  const rows = db
    .prepare(
      `SELECT p.*, c.name AS category_name,
        (SELECT COUNT(*) FROM product_variants v WHERE v.product_id = p.id AND v.is_active = 1) AS variant_count
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${conds.join(' AND ')} ORDER BY p.name`
    )
    .all(...params);
  res.json(stripCost(rows, req));
});

/** POS catalog: only products available (and priced) for the given branch. */
router.get('/branches/:branchId/catalog', authRequired, wrap((req, res) => {
  if (!assertBranchAccess(req, res, req.params.branchId)) return;
  const branch = db.prepare('SELECT * FROM branches WHERE id = ? AND company_id = ?').get(req.params.branchId, req.user.company_id);
  if (!branch) return notFound(res, 'Branch not found');
  const rows = db
    .prepare(
      `SELECT p.*, c.name AS category_name,
        COALESCE(bp.price_override, p.default_price) AS price,
        bp.price_override, COALESCE(bp.is_available, 1) AS is_available,
        COALESCE(bs.quantity, 0) AS stock,
        COALESCE(bs.low_stock_threshold, 5) AS low_stock_threshold
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN branch_products bp ON bp.product_id = p.id AND bp.branch_id = ?
       LEFT JOIN branch_stocks bs ON bs.product_id = p.id AND bs.branch_id = ?
       WHERE p.company_id = ? AND p.is_active = 1 AND COALESCE(bp.is_available, 1) = 1
       ORDER BY p.name`
    )
    .all(req.params.branchId, req.params.branchId, req.user.company_id);

  const variantStmt = db.prepare(
    'SELECT * FROM product_variants WHERE product_id = ? AND is_active = 1 ORDER BY variant_type, sort_order, name'
  );
  res.json(stripCost(rows.map((r) => ({ ...r, variants: variantStmt.all(r.id) })), req));
}));

router.get('/products/:id', authRequired, (req, res) => {
  const p = db
    .prepare(
      `SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.id = ? AND p.company_id = ?`
    )
    .get(req.params.id, req.user.company_id);
  if (!p) return notFound(res);
  p.variants = db
    .prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY variant_type, sort_order, name')
    .all(p.id);
  p.branch_overrides = db
    .prepare(
      `SELECT bp.*, b.name AS branch_name FROM branch_products bp JOIN branches b ON b.id = bp.branch_id
       WHERE bp.product_id = ?`
    )
    .all(p.id);
  res.json(stripCost(p, req));
});

router.post('/products', authRequired, requirePermission('product.manage'), wrap((req, res) => {
  const { name, category_id, sku, barcode, description, unit, cost_price, default_price, brand, variants } = req.body;
  // image_url may be a `/uploads/...` path or a base64 data URI (uploaded inline).
  const image_url = saveDataUri(req.body.image_url) || req.body.image_url;
  if (!name || default_price === undefined) return badRequest(res, 'name and default_price required');
  const pid = id();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO products (id, company_id, category_id, name, sku, barcode, description, image_url, unit, cost_price, default_price, brand)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(pid, req.user.company_id, category_id || null, name, sku || null, barcode || null, description || null,
      image_url || null, unit || 'pcs', cost_price || 0, default_price, brand || null);
    insertVariants(pid, req.user.company_id, variants);
  });
  tx();
  audit({ company_id: req.user.company_id, user_id: req.user.sub, action: 'product.create', entity: 'product', entity_id: pid, detail: { name, default_price }, ip: req.ip });
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(pid));
}));

router.put('/products/:id', authRequired, requirePermission('product.manage'), wrap((req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!p) return notFound(res);
  const { name, category_id, sku, barcode, description, unit, cost_price, default_price, is_active, brand } = req.body;
  // image_url accepts a `/uploads/...` path, a base64 data URI, or '' to clear.
  const image_url = saveDataUri(req.body.image_url) || req.body.image_url;
  db.prepare(
    `UPDATE products SET name=COALESCE(?,name), category_id=COALESCE(?,category_id), sku=COALESCE(?,sku),
     barcode=COALESCE(?,barcode), description=COALESCE(?,description), image_url=COALESCE(?,image_url),
     unit=COALESCE(?,unit), cost_price=COALESCE(?,cost_price), default_price=COALESCE(?,default_price),
     is_active=COALESCE(?,is_active), brand=COALESCE(?,brand) WHERE id = ?`
  ).run(name, category_id, sku, barcode, description, image_url, unit, cost_price, default_price,
    is_active === undefined ? null : is_active ? 1 : 0, brand, p.id);
  // Drop the previous photo once it has been replaced or explicitly cleared.
  if (image_url !== undefined && image_url !== p.image_url) removeUpload(p.image_url);
  if (Array.isArray(req.body.variants)) {
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM product_variants WHERE product_id = ?').run(p.id);
      insertVariants(p.id, req.user.company_id, req.body.variants);
    });
    tx();
  }
  audit({
    company_id: req.user.company_id, user_id: req.user.sub, action: 'product.update', entity: 'product', entity_id: p.id,
    detail: {
      price_change: default_price !== undefined && Number(default_price) !== p.default_price
        ? { from: p.default_price, to: Number(default_price) } : undefined,
      cost_change: cost_price !== undefined && Number(cost_price) !== p.cost_price
        ? { from: p.cost_price, to: Number(cost_price) } : undefined
    },
    ip: req.ip
  });
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(p.id));
}));

router.delete('/products/:id', authRequired, requirePermission('product.manage'), wrap((req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!p) return notFound(res);
  // Soft delete keeps historical transactions intact.
  db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run(p.id);
  audit({ company_id: req.user.company_id, user_id: req.user.sub, action: 'product.delete', entity: 'product', entity_id: p.id, detail: { name: p.name }, ip: req.ip });
  res.json({ ok: true });
}));

/* --------------------------- PRODUCT VARIANTS -------------------------- */

function insertVariants(productId, companyId, variants) {
  if (!Array.isArray(variants)) return;
  const stmt = db.prepare(
    `INSERT INTO product_variants (id, company_id, product_id, name, variant_type, price_adjustment, is_default, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  variants.forEach((v, i) => {
    if (!v || !v.name) return;
    stmt.run(id(), companyId, productId, v.name, v.variant_type || 'option', Number(v.price_adjustment) || 0,
      v.is_default ? 1 : 0, Number(v.sort_order ?? i));
  });
}

router.get('/products/:id/variants', authRequired, wrap((req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!p) return notFound(res);
  res.json(db.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY variant_type, sort_order').all(p.id));
}));

router.post('/products/:id/variants', authRequired, requirePermission('product.manage'), wrap((req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!p) return notFound(res);
  const { name, variant_type, price_adjustment, is_default, sort_order } = req.body;
  if (!name) return badRequest(res, 'name required');
  const vid = id();
  db.prepare(
    `INSERT INTO product_variants (id, company_id, product_id, name, variant_type, price_adjustment, is_default, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(vid, req.user.company_id, p.id, name, variant_type || 'option', Number(price_adjustment) || 0, is_default ? 1 : 0, Number(sort_order) || 0);
  audit({ company_id: req.user.company_id, user_id: req.user.sub, action: 'variant.create', entity: 'variant', entity_id: vid, detail: req.body, ip: req.ip });
  res.status(201).json(db.prepare('SELECT * FROM product_variants WHERE id = ?').get(vid));
}));

router.put('/variants/:id', authRequired, requirePermission('product.manage'), wrap((req, res) => {
  const v = db.prepare('SELECT * FROM product_variants WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!v) return notFound(res);
  const { name, variant_type, price_adjustment, is_default, is_active, sort_order } = req.body;
  db.prepare(
    `UPDATE product_variants SET name=COALESCE(?,name), variant_type=COALESCE(?,variant_type),
     price_adjustment=COALESCE(?,price_adjustment), is_default=COALESCE(?,is_default),
     is_active=COALESCE(?,is_active), sort_order=COALESCE(?,sort_order) WHERE id = ?`
  ).run(name, variant_type, price_adjustment === undefined ? null : Number(price_adjustment),
    is_default === undefined ? null : is_default ? 1 : 0,
    is_active === undefined ? null : is_active ? 1 : 0, sort_order === undefined ? null : Number(sort_order), v.id);
  res.json(db.prepare('SELECT * FROM product_variants WHERE id = ?').get(v.id));
}));

router.delete('/variants/:id', authRequired, requirePermission('product.manage'), wrap((req, res) => {
  const v = db.prepare('SELECT * FROM product_variants WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!v) return notFound(res);
  db.prepare('DELETE FROM product_variants WHERE id = ?').run(v.id);
  audit({ company_id: req.user.company_id, user_id: req.user.sub, action: 'variant.delete', entity: 'variant', entity_id: v.id, detail: { name: v.name }, ip: req.ip });
  res.json({ ok: true });
}));

/* --------------------- BRANCH PRICE / AVAILABILITY OVERRIDES --------------------- */

router.get('/branches/:branchId/products', authRequired, wrap((req, res) => {
  if (!assertBranchAccess(req, res, req.params.branchId)) return;
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.sku, p.default_price, p.is_active,
        COALESCE(bp.price_override, p.default_price) AS price, bp.price_override,
        COALESCE(bp.is_available, 1) AS is_available
       FROM products p LEFT JOIN branch_products bp ON bp.product_id = p.id AND bp.branch_id = ?
       WHERE p.company_id = ? AND p.is_active = 1 ORDER BY p.name`
    )
    .all(req.params.branchId, req.user.company_id);
  res.json(rows);
}));

router.put('/branches/:branchId/products/:productId', authRequired, requirePermission('product.manage', 'stock.manage'), wrap((req, res) => {
  if (!assertBranchAccess(req, res, req.params.branchId)) return;
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND company_id = ?').get(req.params.productId, req.user.company_id);
  if (!product) return notFound(res, 'Product not found');
  const { price_override, is_available } = req.body;
  const override = price_override === undefined || price_override === '' || price_override === null ? null : Number(price_override);
  const avail = is_available === undefined ? 1 : is_available ? 1 : 0;
  const existing = db
    .prepare('SELECT id FROM branch_products WHERE branch_id = ? AND product_id = ?')
    .get(req.params.branchId, req.params.productId);
  if (existing) {
    db.prepare('UPDATE branch_products SET price_override = ?, is_available = ? WHERE id = ?').run(override, avail, existing.id);
  } else {
    db.prepare('INSERT INTO branch_products (id, branch_id, product_id, price_override, is_available) VALUES (?, ?, ?, ?, ?)')
      .run(id(), req.params.branchId, req.params.productId, override, avail);
  }
  audit({
    company_id: req.user.company_id, branch_id: req.params.branchId, user_id: req.user.sub,
    action: 'branch_product.update', entity: 'product', entity_id: product.id,
    detail: { branch_id: req.params.branchId, price_override: override, is_available: avail, default_price: product.default_price },
    ip: req.ip
  });
  res.json({ ok: true, price: branchPrice(req.params.branchId, product.id, product.default_price) });
}));

export default router;



