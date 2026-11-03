// Edge (embedded) mode for the POS backend.
//
// The same express app runs in two places:
//   * cloud  — a shared server several outlets talk to over the internet.
//   * edge   — a local service bundled inside the Tauri desktop app, bound to
//              127.0.0.1, keeping the outlet running when the internet is down.
//
// Only the transport differs; every route, price calculation and permission
// check is shared, so there is exactly one implementation of the sales rules.
// Edge mode adds the pieces the cloud build does not need: a local secret that
// mints device tokens without the user's password, and an upstream drain worker
// (see edgeUpstream.js) that replays queued sales once connectivity returns.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Directory holding the SQLite database, uploads and the edge secret. */
export function edgeDataDir() {
  return path.resolve(process.env.DB_DIR || path.join(__dirname, '..', 'data'));
}

/** True when this process is the on-device service rather than the cloud API. */
export function isEdge() {
  return process.env.EDGE_MODE === '1' || process.env.EDGE_MODE === 'true';
}

/** Loopback-only bind address for the edge service. */
export const EDGE_HOST = '127.0.0.1';

let cachedSecret = null;

/**
 * Secret used to sign local device tokens.
 *
 * Generated once and stored beside the database so a restarted edge service keeps
 * accepting the tills that are already logged in. It never leaves the machine.
 */
export function localSecret(dataDir = edgeDataDir()) {
  if (cachedSecret) return cachedSecret;
  if (process.env.EDGE_JWT_SECRET) {
    cachedSecret = process.env.EDGE_JWT_SECRET;
    return cachedSecret;
  }
  const file = path.join(dataDir, 'edge-secret.key');
  try {
    cachedSecret = fs.readFileSync(file, 'utf8').trim();
    if (cachedSecret) return cachedSecret;
  } catch {
    /* first run — generate below */
  }
  cachedSecret = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, cachedSecret, { mode: 0o600 });
  return cachedSecret;
}

/** Let browser-based edge clients (Vite on :5173) call the local service. */
export function edgeCorsOptions() {
  // Any loopback origin is allowed; the service never binds to a public address,
  // so the CORS header cannot be abused from a remote page.
  const loopback = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
  return {
    origin(origin, cb) {
      if (!origin || loopback.test(origin)) return cb(null, true);
      cb(null, false);
    },
  };
}

/**
 * Verify a 4-digit PIN against a bcrypt `pin_hash` from the local replica.
 *
 * The edge service never invents its own credential: it reuses the cloud's
 * `users.pin_hash`, so a PIN change made by an admin takes effect offline as soon
 * as the row syncs — there is no second secret to drift out of date.
 */
export function verifyPinHash(pin, pinHash) {
  if (!pinHash) return false;
  return bcrypt.compareSync(String(pin), pinHash);
}

