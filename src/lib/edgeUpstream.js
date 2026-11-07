// Upstream transport for the edge (till) service.
//
// The background worker and the manual "Kirim sekarang" endpoint both replay with
// the cloud token stored at pairing, because nobody is signed in when a drain runs.
// That token has the cloud's ordinary access lifetime (`JWT_EXPIRES`, 60 minutes by
// default), so within an hour of pairing every lane — sales, parked carts, kitchen
// tickets — started failing with "Invalid or expired token" and backing off forever.
// The only cure was re-pairing by hand, which is not something a cashier can do
// mid-shift.
//
// So the credential is kept alive the way the app already does it: on a 401 the
// stored refresh token is exchanged for a new pair and the request is retried once.
// The cloud rotates refresh tokens, so the replacement is persisted immediately.
// One retry only — a genuinely revoked device must fail fast, not loop.

import { db } from '../db.js';

const setting = (key) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
};

const setSetting = (key, value) =>
  db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value === null || value === undefined ? null : String(value));

/** Cloud base URL this till pushes to, or null when it is stand-alone. */
export function upstreamUrl() {
  return setting('edge_upstream_url') || process.env.EDGE_UPSTREAM_URL || null;
}

async function send(base, path, { method, bearer, body }) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: r.ok, status: r.status, data };
}

/**
 * Trade the stored refresh token for a fresh device token.
 *
 * Returns the new access token, or null when this till never stored a refresh
 * token (paired by an older build) or the cloud refuses the rotation — in which
 * case the caller reports the original 401 and the operator re-pairs once.
 */
async function refreshDeviceToken() {
  const base = upstreamUrl();
  const refresh = setting('edge_refresh_token');
  if (!base || !refresh) return null;
  const r = await fetch(`${base}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data?.token) return null;
  setSetting('edge_device_token', data.token);
  if (data.refresh_token) setSetting('edge_refresh_token', data.refresh_token);
  return data.token;
}

/**
 * Call the cloud with this till's credentials.
 *
 * The background worker has no user on screen, so it replays with the stored
 * device token. `token` lets a foreground request use the caller's own bearer
 * instead, which keeps the cloud's permission checks meaningful — and such a
 * request is never refreshed with the device's refresh token.
 */
export async function upstreamRequest(path, { method = 'GET', token = null, body, anonymous = false } = {}) {
  const base = upstreamUrl();
  if (!base) throw new Error('Server pusat belum diatur');
  let bearer = anonymous ? null : token || setting('edge_device_token');
  if (!anonymous && !bearer) throw new Error('Perangkat belum terhubung ke server pusat');

  let res = await send(base, path, { method, bearer, body });
  if (res.status === 401 && !anonymous && !token) {
    const fresh = await refreshDeviceToken().catch(() => null);
    if (fresh) {
      bearer = fresh;
      res = await send(base, path, { method, bearer, body });
    }
  }
  if (!res.ok) throw new Error((res.data && res.data.error) || `Server pusat menolak (${res.status})`);
  return res.data;
}
