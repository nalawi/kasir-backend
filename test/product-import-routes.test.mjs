// Route-level tests for the product import endpoints.
//
// `product-import.test.mjs` covers the engine in-process. These go through a real
// cloud server (see harness.mjs) because the things that break here are the ones
// a unit test cannot see: the base64 upload envelope, the permission gate, a
// stale client-side mapping, and the fact that a rejected file must write nothing.
//
// The CSV is built in memory and base64-encoded by hand — the same thing the
// browser wizard will do — so no fixture files need to live in the repo.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startPairedWorld, cloudCashierToken } from './fixtures.mjs';

/** Build the `{ filename, content }` envelope the import endpoints expect. */
const upload = (filename, text) => ({
  filename,
  content: Buffer.from(text, 'utf8').toString('base64'),
});

const HEADER = 'Nama Produk;Kategori;SKU;Barcode;Harga Modal;Harga Jual;Status;Varian;Stok Awal';

/* -------------------------------------------------------------------------- */
/* 1. Template + field catalogue                                              */
/* -------------------------------------------------------------------------- */

test('the template downloads as a CSV whose headers the importer maps', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token } = world.seeded;
  const res = await fetch(`${world.cloud.url}/api/products/import/template.csv`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment/);

  const raw = Buffer.from(await res.arrayBuffer());
  // The BOM is asserted on the bytes: `res.text()` would have stripped it.
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'a BOM keeps Excel from mangling accents');
  const csv = raw.toString('utf8');

  // Round-trip: feed the template straight back in. Its example row must map and
  // preview cleanly, which is only true while the template and the importer agree.
  const preview = await world.api.cloud.post('/api/products/import/preview', {
    token,
    body: upload('template-produk.csv', csv),
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.total, 1);
  assert.equal(preview.body.created, 1);
});

test('the field catalogue lists required columns', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const res = await world.api.cloud.get('/api/products/import/fields', { token: world.seeded.token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.required, ['name', 'default_price']);
  assert.ok(res.body.fields.some((f) => f.key === 'variants'));
});

/* -------------------------------------------------------------------------- */
/* 2. Preview writes nothing, apply does                                      */
/* -------------------------------------------------------------------------- */

test('a preview changes nothing and an apply creates the rows', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token } = world.seeded;
  // Names must not collide with the seeded catalog (Kopi Susu / Roti Bakar / Teh
  // Manis): a match by name would turn "create" into "update" and hide a bug.
  // The variant cell itself contains `;`, so it must be quoted — an unquoted one
  // would split the row and the import is (correctly) refused.
  const csv = [
    HEADER,
    'Kopi Gula Aren;Minuman;KOP-01;8990001;9000;18000;aktif;"Ukuran:Reguler=0;Ukuran:Large=4000";6',
    'Roti Bakar Keju;Camilan;ROT-01;;3000;12000;;;;'
  ].join('\n');
  const body = upload('produk.csv', csv);

  const before = await world.api.cloud.get('/api/products', { token });
  const preview = await world.api.cloud.post('/api/products/import/preview', { token, body });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(
    [preview.body.created, preview.body.updated, preview.body.skipped, preview.body.failed],
    [2, 0, 0, 0]
  );

  const unchanged = await world.api.cloud.get('/api/products', { token });
  assert.equal(unchanged.body.length, before.body.length, 'a preview must not write');

  const applied = await world.api.cloud.post('/api/products/import', { token, body });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.deepEqual([applied.body.created, applied.body.updated], [2, 0]);

  const after = await world.api.cloud.get('/api/products', { token });
  assert.equal(after.body.length, before.body.length + 2);
  const kopi = after.body.find((p) => p.sku === 'KOP-01');
  assert.equal(kopi.default_price, 18000);
  assert.equal(kopi.cost_price, 9000);

  const variants = await world.api.cloud.get(`/api/products/${kopi.id}/variants`, { token });
  assert.deepEqual(variants.body.map((v) => v.name).sort(), ['Large', 'Reguler']);
});

test('a second apply updates the row it matched by barcode', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token } = world.seeded;
  const first = upload('a.csv', [HEADER, 'Kopi Gula Aren;Minuman;KOP-01;8990001;9000;18000;;;;'].join('\n'));
  assert.equal((await world.api.cloud.post('/api/products/import', { token, body: first })).status, 201);

  // Same barcode, new price, every other cell blank: the blanks must not wipe the
  // SKU or category that are already stored. The barcode is the only thing that
  // identifies the row, so it has to be present.
  const second = upload('b.csv', [HEADER, 'Kopi Gula Aren Baru;;;8990001;;20000;;;;'].join('\n'));
  const out = await world.api.cloud.post('/api/products/import', { token, body: second });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.deepEqual([out.body.created, out.body.updated], [0, 1]);

  const products = await world.api.cloud.get('/api/products', { token });
  const kopi = products.body.find((p) => p.barcode === '8990001');
  assert.equal(kopi.name, 'Kopi Gula Aren Baru');
  assert.equal(kopi.default_price, 20000);
  assert.equal(kopi.cost_price, 9000, 'a blank cost cell leaves the stored cost alone');
  assert.equal(kopi.sku, 'KOP-01', 'and a blank SKU does not erase the code');
});

/* -------------------------------------------------------------------------- */
/* 3. Rejections: nothing is written                                          */
/* -------------------------------------------------------------------------- */

test('a file with one bad row is refused and writes nothing', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token } = world.seeded;
  const before = await world.api.cloud.get('/api/products', { token });

  const csv = [
    HEADER,
    'Produk Bagus;Minuman;OK-01;;1000;5000;;;;',
    'Produk Rusak;Minuman;BAD-01;;1000;bukan-angka;;;;'
  ].join('\n');
  const res = await world.api.cloud.post('/api/products/import', { token, body: upload('a.csv', csv) });

  assert.equal(res.status, 400);
  assert.equal(res.body.aborted, true);
  assert.equal(res.body.failed, 1);
  assert.equal(res.body.created, 1, 'the good row was planned…');
  assert.equal(res.body.rows.find((r) => r.row === 3).error, 'Harga jual bukan angka');

  const after = await world.api.cloud.get('/api/products', { token });
  assert.equal(after.body.length, before.body.length, '…but nothing was committed');
});

test('a stale mapping cannot point past the end of the file', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token } = world.seeded;
  // The mapping claims "Harga Jual" lives in column 20 of a 2-column sheet. Left
  // unchecked that would import every product at price 0.
  const res = await world.api.cloud.post('/api/products/import/preview', {
    token,
    body: { ...upload('a.csv', 'Nama Produk;Harga Jual\nKopi;18000'), mapping: { name: 0, default_price: 20 } },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /Harga Jual/);
});

test('an xls file is answered with an explanation, not a 500', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const res = await world.api.cloud.post('/api/products/import/preview', {
    token: world.seeded.token,
    body: { filename: 'lama.xls', content: Buffer.from('D0CF11E0A1B11AE1', 'hex').toString('base64') },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /\.xls/);
});

test('a row wider than the header is refused instead of shifting columns', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  // The variant list contains `;` inside the same file that uses `;` as the
  // delimiter, and is not quoted — so the row splits into 10 cells under 9
  // headers. Accepting it would push the stock figure into the wrong column.
  const csv = [
    HEADER,
    'Kopi Gula Aren;Minuman;KOP-01;;9000;18000;;Ukuran:Reguler=0;Ukuran:Large=4000;6'
  ].join('\n');
  const res = await world.api.cloud.post('/api/products/import/preview', { token: world.seeded.token, body: upload('a.csv', csv) });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /Baris 2/);
});

test('an empty upload is refused', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const res = await world.api.cloud.post('/api/products/import/preview', {
    token: world.seeded.token,
    body: { filename: 'a.csv', content: '' },
  });
  assert.equal(res.status, 400);
});

/* -------------------------------------------------------------------------- */
/* 4. The wizard's template contract                                          */
/* -------------------------------------------------------------------------- */

test('a template built from the field catalogue imports without touching the mapping', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  // This mirrors exactly what ProductImportModal does when the operator clicks
  // ".xlsx": take the field list from the API, write the labels as row 1 and the
  // examples as row 2. If a field's `example` ever becomes something the parser
  // rejects, the wizard would hand out a template that cannot be uploaded — so
  // the whole path is asserted here rather than left to manual testing.
  const catalogue = await world.api.cloud.get('/api/products/import/fields', { token: world.seeded.token });
  const fields = catalogue.body.fields;
  assert.ok(fields.length > 0);

  const header = fields.map((f) => f.label);
  const example = fields.map((f) => f.example);
  const csv = [header.join(';'), example.join(';')].join('\n');

  const res = await world.api.cloud.post('/api/products/import/preview', {
    token: world.seeded.token,
    body: upload('template-produk.csv', csv),
  });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  // Every catalogue column must auto-map, or the wizard would open step 2 with
  // "required columns not mapped" for a file it generated itself.
  assert.equal(res.body.failed, 0);
  assert.deepEqual(Object.keys(res.body.mapping).sort(), fields.map((f) => f.key).sort());
});

test('an empty mapping object means "auto-map", not "map nothing"', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token } = world.seeded;
  // A name that cannot collide with the seeded catalogue, so the plan is always
  // "create" and the assertion does not depend on fixture contents.
  const csv = `${HEADER}\nUji Pemetaan Kosong;Minuman;UJI-MAP-01;;9000;18000;aktif;;10\n`;

  // The wizard's first upload sends `mapping: {}` before the operator has touched
  // a dropdown. Because `{}` is truthy, this used to skip `suggestMapping()` and
  // reject the file with "Kolom wajib belum dipetakan: Nama Produk, Harga Jual" —
  // i.e. every template the user had just downloaded failed to import.
  const bodies = [{ mapping: {} }, { mapping: null }, {}];
  for (const body of bodies) {
    const res = await world.api.cloud.post('/api/products/import/preview', {
      token,
      body: { ...upload('baru.csv', csv), ...body },
    });
    assert.equal(res.status, 200, `${JSON.stringify(body)} -> ${JSON.stringify(res.body)}`);
    assert.equal(res.body.mapping.name, 0, JSON.stringify(body));
    assert.equal(res.body.mapping.default_price, 5, JSON.stringify(body));
    // A preview writes nothing, so every iteration plans the same single create.
    assert.equal(res.body.created, 1, JSON.stringify(res.body));
    assert.equal(res.body.failed, 0, JSON.stringify(res.body));
  }
});

test('the CSV template round-trips when the mapping is sent as an empty object', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const { token } = world.seeded;
  const res = await fetch(`${world.cloud.url}/api/products/import/template.csv`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const csv = Buffer.from(await res.arrayBuffer()).toString('utf8');

  // Exactly the browser's first request: the downloaded template, no mapping yet.
  const preview = await world.api.cloud.post('/api/products/import/preview', {
    token,
    body: { ...upload('template-produk.csv', csv), mapping: {} },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.total, 1);
  assert.equal(preview.body.created, 1);
});

/* -------------------------------------------------------------------------- */
/* 5. The permission gate                                                     */
/* -------------------------------------------------------------------------- */

test('a cashier cannot import products', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const cashierToken = await cloudCashierToken(world.api, world.seeded);
  const body = upload('a.csv', [HEADER, 'Selundupan;;;;;1000;;;;'].join('\n'));

  const preview = await world.api.cloud.post('/api/products/import/preview', { token: cashierToken, body });
  assert.equal(preview.status, 403, 'a cashier must not even preview an import');

  const apply = await world.api.cloud.post('/api/products/import', { token: cashierToken, body });
  assert.equal(apply.status, 403);

  const products = await world.api.cloud.get('/api/products', { token: world.seeded.token });
  assert.equal(products.body.some((p) => p.name === 'Selundupan'), false);
});

/* -------------------------------------------------------------------------- */
/* 6. The edge gate                                                           */
/* -------------------------------------------------------------------------- */

/*
 * On a till the catalogue is a replica: the outbox carries sales only, and the
 * next `/api/edge/bootstrap` replaces products and categories wholesale. An import
 * accepted there is therefore deleted at the next sync — the operator sees a
 * success message for work that cannot survive. These tests pin the two halves of
 * the fix: the server refuses, and `/api/health` tells the UI to hide the button.
 */

test('health reports which role the server plays', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  // Unauthenticated on purpose: the login screen needs this before there is a token.
  const cloud = await fetch(`${world.cloud.url}/api/health`);
  assert.equal(cloud.status, 200);
  const cloudBody = await cloud.json();
  assert.equal(cloudBody.mode, 'cloud');
  assert.equal(cloudBody.features.productImport, true, 'the cloud owns the catalogue');

  const edge = await fetch(`${world.servers.edge.url}/api/health`);
  assert.equal(edge.status, 200);
  const edgeBody = await edge.json();
  assert.equal(edgeBody.mode, 'edge');
  assert.equal(edgeBody.features.productImport, false, 'the till must not offer an import');

  // The old field stays put: tools and Settings already key off `service`.
  assert.equal(edgeBody.service, 'pos-backend');
});

test('an edge refuses to import products, even for its own admin', async (t) => {
  const world = await startPairedWorld();
  t.after(() => world.stop());

  const token = world.edge.adminToken;
  assert.ok(token, 'pairAndBootstrap returns the till admin token');
  const body = upload('hilang.csv', [HEADER, 'Produk Fana;;;;;1000;;;;'].join('\n'));

  // Every import endpoint is refused, so the wizard cannot advance at all.
  const fields = await world.api.edge.get('/api/products/import/fields', { token });
  assert.equal(fields.status, 409);

  const template = await world.api.edge.get('/api/products/import/template.csv', { token });
  assert.equal(template.status, 409);

  const preview = await world.api.edge.post('/api/products/import/preview', { token, body });
  assert.equal(preview.status, 409, 'no preview, so the wizard cannot show a plan');
  assert.match(preview.body.error, /server pusat/i, 'the message must say where to do it');

  const apply = await world.api.edge.post('/api/products/import', { token, body });
  assert.equal(apply.status, 409);

  // The decisive assertion: nothing was written locally either.
  const products = await world.api.edge.get('/api/products', { token });
  assert.equal(products.body.some((p) => p.name === 'Produk Fana'), false);
});
