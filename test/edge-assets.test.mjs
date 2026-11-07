// Product photos must reach the till, not just the catalogue rows.
//
// The bug these lock down is a silent one: `applyBootstrap` replicates
// `products.image_url` as `/uploads/p_x.png`, the till serves `/uploads` from its own
// data directory, and on a fresh install that directory is empty. Every test about
// prices, stock or variants still passed — the replica was complete; the *files* were
// missing, so the till showed a full catalogue of broken thumbnails and reported
// nothing anywhere.
//
// So these assert the thing a cashier sees: the image an `<img src>` on the till points
// at really is served, byte for byte, and re-syncing does not fetch it again.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { startWorld, startSingle } from './harness.mjs';
import { seedCloud, pairAndBootstrap, OWNER } from './fixtures.mjs';

/** 1×1 PNG — the smallest thing `saveDataUri` will accept as a real image. */
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/** Upload a photo on the cloud and attach it to a product. Returns `/uploads/<name>`. */
async function attachPhoto(api, token, productId) {
  const up = await api.cloud.post('/api/products/upload-image', { token, body: { image: PNG_1PX } });
  assert.equal(up.status, 201, `upload failed: ${JSON.stringify(up.body)}`);
  const imageUrl = up.body.image_url;
  const put = await api.cloud.put(`/api/products/${productId}`, { token, body: { image_url: imageUrl } });
  assert.equal(put.status, 200, `attach failed: ${JSON.stringify(put.body)}`);
  return imageUrl;
}

/** The file name behind a `/uploads/<name>` path. */
const nameOf = (url) => url.split('/').pop();

test('the till serves the product photo its catalogue refers to', async (t) => {
  const world = await startWorld();
  t.after(() => world.stop());

  const seeded = await seedCloud(world.api);
  const imageUrl = await attachPhoto(world.api, seeded.token, seeded.products[0].id);
  const name = nameOf(imageUrl);

  const edge = await pairAndBootstrap(world, seeded);

  // The bootstrap reports the photo lane separately from the catalogue, because one
  // can succeed while the other fails (offline mid-pull, or an upstream that refuses).
  assert.equal(edge.boot.assets?.files, 1, 'the manifest should list the one photo');
  assert.equal(edge.boot.assets.downloaded, 1, 'the photo should have been copied');
  assert.equal(edge.boot.assets.failed, 0);

  const onDisk = path.join(world.edge.dataDir, 'uploads', name);
  assert.ok(fs.existsSync(onDisk), `expected ${onDisk} on the till`);

  // The end the cashier sees: an <img src> on the till resolves against the local
  // service, so that is what has to answer with image bytes.
  const served = await fetch(`${world.edge.url}/uploads/${name}`);
  assert.equal(served.status, 200, 'the till must serve the replicated photo');
  assert.equal(served.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await served.arrayBuffer());
  assert.deepEqual(bytes, fs.readFileSync(onDisk), 'the served bytes are the file on disk');
  assert.ok(bytes.length > 0);

  // And the till itself reports it, which is what the diagnostics panel shows.
  const info = await world.api.edge.get('/api/edge/info', { token: edge.adminToken });
  assert.equal(info.status, 200);
  assert.equal(info.body.assets.files, 1);
  assert.ok(info.body.assets.synced_at, 'a completed pull records when it ran');

  // Idempotent: a name is generated per upload, so the content behind it never changes
  // and a size match is enough to skip the download. The second run must transfer
  // nothing — otherwise every bootstrap would re-download a shop's whole photo library.
  const again = await world.api.edge.post('/api/edge/sync-assets', {
    token: edge.adminToken,
    body: { branch_id: seeded.branchId },
  });
  assert.equal(again.status, 200, `re-sync failed: ${JSON.stringify(again.body)}`);
  assert.equal(again.body.present, 1, 'the existing photo is recognised, not re-fetched');
  assert.equal(again.body.downloaded, 0);
});

test('a photo deleted on the till is restored by the next pull', async (t) => {
  const world = await startWorld();
  t.after(() => world.stop());

  const seeded = await seedCloud(world.api);
  const imageUrl = await attachPhoto(world.api, seeded.token, seeded.products[0].id);
  const name = nameOf(imageUrl);
  const edge = await pairAndBootstrap(world, seeded);

  // The case that made this feature worth having: a till whose database is fine and
  // whose files are missing. Deleting one reproduces a fresh install exactly.
  fs.unlinkSync(path.join(world.edge.dataDir, 'uploads', name));

  const res = await world.api.edge.post('/api/edge/sync-assets', {
    token: edge.adminToken,
    body: { branch_id: seeded.branchId },
  });
  assert.equal(res.status, 200, `re-sync failed: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.downloaded, 1, 'the missing file is fetched again');
  assert.equal(res.body.present, 0);
  assert.ok(fs.existsSync(path.join(world.edge.dataDir, 'uploads', name)));
});

test('a row pointing at a photo that is gone from disk does not break the pull', async (t) => {
  const world = await startWorld();
  t.after(() => world.stop());

  const seeded = await seedCloud(world.api);
  // A product may name a file the upload folder no longer holds (deleted by hand, or
  // restored from a database-only backup). It must be reported, not fatal: the rest of
  // the catalogue still has to reach the till.
  const missingUrl = '/uploads/p_00000000000000000000000000000000.png';
  await world.api.cloud.put(`/api/products/${seeded.products[0].id}`, {
    token: seeded.token,
    body: { image_url: missingUrl },
  });
  const okUrl = await attachPhoto(world.api, seeded.token, seeded.products[1].id);

  const manifest = await world.api.cloud.get(`/api/sync/assets?branch_id=${seeded.branchId}`, {
    token: seeded.token,
  });
  assert.equal(manifest.status, 200);
  assert.equal(manifest.body.count, 1, 'only the photo that exists is offered');
  assert.deepEqual(manifest.body.missing, [nameOf(missingUrl)]);
  assert.equal(manifest.body.files[0].name, nameOf(okUrl));

  const edge = await pairAndBootstrap(world, seeded);
  assert.equal(edge.boot.assets.downloaded, 1);
  assert.ok(fs.existsSync(path.join(world.edge.dataDir, 'uploads', nameOf(okUrl))));
});

test('the asset endpoints refuse what they should', async (t) => {
  const cloud = await startSingle({ mode: 'cloud' });
  t.after(() => cloud.stop());

  const reg = await cloud.url;
  const registered = await fetch(`${reg}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company_name: 'Toko Uji', ...OWNER }),
  });
  const owner = await registered.json();
  const token = owner.token;
  const branchId = owner.user.branch_id;

  const noToken = await fetch(`${reg}/api/sync/assets?branch_id=${branchId}`);
  assert.equal(noToken.status, 401, 'the manifest is not public');

  const noBranch = await fetch(`${reg}/api/sync/assets`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(noBranch.status, 400, 'branch_id is required, like every other sync read');

  // The name comes off the URL, so it is the one place a request could try to walk out
  // of the upload folder. `uploadPath` refuses separators and `..` before any fs call.
  for (const evil of ['..%2Fpos.db', '..%2F..%2Fpackage.json', '%2E%2E%2Fpos.db']) {
    const res = await fetch(`${reg}/api/sync/assets/${evil}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 400, `traversal must be refused, got ${res.status} for ${evil}`);
  }

  const absent = await fetch(`${reg}/api/sync/assets/p_nope.png`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(absent.status, 404, 'a name that is not a file on disk is a 404');
});

test('an unpaired till says why it could not fetch photos', async (t) => {
  const world = await startWorld();
  t.after(() => world.stop());

  const reg = await world.api.edge.post('/api/auth/register', { body: { company_name: 'Toko Uji', ...OWNER } });
  const edgeAdmin = reg.body.token;

  // Nothing configured upstream yet: the manual pull has to say so, because an operator
  // pressing "Salin gambar" on a fresh till needs the real reason, not an empty result.
  const res = await world.api.edge.post('/api/edge/sync-assets', { token: edgeAdmin, body: {} });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Server pusat belum diatur/i);
});
