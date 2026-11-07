// Pull the photos the catalog refers to onto this till.
//
// `applyBootstrap` copies `products.image_url` verbatim, and the value is a path into
// the cloud's upload directory: `/uploads/p_085ff1….png`. The till serves `/uploads`
// from its *own* data directory, which on a fresh install is empty — so the replica
// was complete (every product, price, stock and variant) while every product photo
// rendered as a broken thumbnail, with nothing in any log to say why: the browser
// asked the local service for a file that had never been copied.
//
// The replica decides *which* files are needed (it holds the rows that name them) and
// the cloud supplies the bytes. So the till asks for a manifest and pulls only what it
// does not already have. That is safe to make incremental because uploaded photo names
// are random per upload (`p_<uuid>.<ext>`): a name's content never changes, so a size
// match is a sound "already here" test and no checksum round trip is needed.
//
// Never destructive. A file the manifest no longer lists is left on disk: rows of
// deactivated products still point at their photo (reports and history show it), and
// the operator never asked for a cache eviction. The cost of keeping them is a few
// hundred kilobytes per replaced photo.
//
// Nothing here is on the money path: it runs after the catalogue has been applied, it
// is retried by the next bootstrap, and a failure is reported as a count rather than
// thrown at whoever pressed "Salin data cabang".

import fs from 'fs';
import path from 'path';
import { db } from '../db.js';
import { ensureUploadDir, safeUploadName } from './uploads.js';
import { upstreamFetchBytes, upstreamRequest } from './edgeUpstream.js';

/**
 * Ignore anything implausibly large.
 *
 * The cloud refuses uploads over 2 MB, so a manifest entry bigger than this is not a
 * product photo — a misconfigured or hostile upstream should not be able to fill a
 * till's disk one "image" at a time.
 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const setSetting = (key, value) =>
  db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value === null || value === undefined ? null : String(value));

/** Size of a local file, or 0 when it is not there. */
function localSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Write through a temporary name, then rename.
 *
 * A sync interrupted halfway (app quit, power cut) must not leave a truncated file
 * that the next run mistakes for a finished download just because its name exists.
 */
function writeAtomic(target, buffer) {
  const tmp = `${target}.${process.pid}.part`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, target);
}

/**
 * Copy the branch's product/user photos into the local upload directory.
 *
 * Returns `{ files, present, downloaded, failed, bytes }` — `files` is the manifest
 * size, so a caller can tell "nothing needed" from "nothing fetched". Throws only
 * when the manifest itself cannot be read (no upstream, not paired, offline), which
 * is the signal a caller should report as a connection problem rather than a
 * partial-copy warning.
 */
export async function syncAssets({ branchId } = {}) {
  if (!branchId) throw new Error('branch_id required');

  const dir = ensureUploadDir();
  const manifest = await upstreamRequest(`/api/sync/assets?branch_id=${encodeURIComponent(branchId)}`);
  const files = Array.isArray(manifest?.files) ? manifest.files : [];

  let present = 0;
  let downloaded = 0;
  let failed = 0;
  let bytes = 0;

  for (const entry of files) {
    const name = safeUploadName(entry?.name);
    // A name the manifest invented is a bug on the other side; count it and move on
    // rather than writing outside the upload directory.
    if (!name) {
      failed += 1;
      continue;
    }
    const expected = Number(entry.size) || 0;
    const target = path.join(dir, name);

    if (expected > 0 && localSize(target) === expected) {
      present += 1;
      continue;
    }
    if (expected > MAX_FILE_BYTES) {
      failed += 1;
      continue;
    }

    try {
      const got = await upstreamFetchBytes(`/api/sync/assets/${encodeURIComponent(name)}`);
      // The manifest and the download are two round trips, so a size mismatch means
      // the file changed underneath us (a photo replaced mid-sync). Treat it as a
      // miss: the next pull picks up the new version.
      if (expected > 0 && got.buffer.length !== expected) throw new Error('ukuran tidak cocok');
      writeAtomic(target, got.buffer);
      downloaded += 1;
      bytes += got.buffer.length;
    } catch {
      failed += 1;
    }
  }

  // Recorded even when some files failed: the timestamp says when the till last
  // talked to the cloud about photos, which is what the diagnostics panel shows.
  setSetting('edge_assets_synced_at', new Date().toISOString());
  setSetting('edge_assets_pending', String(failed));

  return { files: files.length, present, downloaded, failed, bytes };
}

/** How many photos this till is currently holding — for the diagnostics panel. */
export function localAssetCount() {
  try {
    return fs.readdirSync(ensureUploadDir()).filter((name) => !name.endsWith('.part')).length;
  } catch {
    return 0;
  }
}
