// One place that knows where uploaded photos live and how a name becomes a path.
//
// Three callers need the same answer: `server.js` mounts the directory at
// `/uploads`, `catalog.routes.js` writes new photos into it, and `edgeAssets.js`
// fills it from the cloud. They used to compute it separately, and the route module
// resolved it against `process.cwd()` — which is *not* the data directory on the
// embedded edge service (its cwd is the app's Resources folder while `DB_DIR`
// points at the application-support folder). A photo uploaded on a till therefore
// landed in a directory nobody served, so it appeared in the form and was 404 on
// the screen. `DATA_DIR` honours `DB_DIR`, so routing everything through here makes
// the writer, the reader and the replicator agree by construction.
//
// `uploadPath`/`safeUploadName` are also the boundary for `/api/sync/assets/:name`,
// where the name arrives straight off a URL. Names on disk are random UUIDs, never
// user-chosen, so a whitelist of `[A-Za-z0-9._-]` costs nothing and removes any way
// to walk out of the directory.

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../db.js';

export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

/** Public prefix these files are served under. */
export const UPLOAD_URL_PREFIX = '/uploads/';

const CONTENT_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** Create the directory if needed and return it. Called on boot and before writes. */
export function ensureUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  return UPLOAD_DIR;
}

/** Extension (lowercase, no dot) of a file name; '' when it has none. */
export function extOf(name) {
  const i = String(name).lastIndexOf('.');
  return i > 0 ? String(name).slice(i + 1).toLowerCase() : '';
}

/** MIME type for a stored file, by extension. */
export function contentTypeOf(name) {
  return CONTENT_TYPES[extOf(name)] || 'application/octet-stream';
}

/**
 * Validate a bare file name.
 *
 * Returns the name, or null when it is not something this module will touch: no
 * separators, no `..`, no leading dot, nothing exotic. Applied to names coming from
 * a URL as well as from a manifest, because neither is trusted to be a file name.
 */
export function safeUploadName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 128) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) return null;
  if (trimmed.includes('..')) return null;
  return trimmed;
}

/** Absolute path of a stored file, or null when `name` is not a valid file name. */
export function uploadPath(name) {
  const safe = safeUploadName(name);
  if (!safe) return null;
  const full = path.join(UPLOAD_DIR, safe);
  // Belt and braces — `safeUploadName` already forbids separators.
  if (!full.startsWith(UPLOAD_DIR + path.sep)) return null;
  return full;
}

/**
 * File name behind a `/uploads/<name>` URL.
 *
 * Absolute URLs and data URIs are *not* handled on purpose: a product photo stored
 * as an external link or an inline data URI needs no file on the till, and silently
 * mapping it to a local name would invent content that does not exist.
 */
export function nameFromUrl(url) {
  if (typeof url !== 'string' || !url.startsWith(UPLOAD_URL_PREFIX)) return null;
  const name = url.slice(UPLOAD_URL_PREFIX.length).split('?')[0].split('#')[0];
  return safeUploadName(name);
}
