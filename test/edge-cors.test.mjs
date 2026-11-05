// Tests for the edge service's CORS policy.
//
// The packaged app's page is served from `tauri://localhost` (macOS) or
// `http://tauri.localhost` (Windows/Linux), neither of which is an http(s)
// loopback. The allowlist used to accept only http(s) loopback origins, so the
// app was refused `Access-Control-Allow-Origin`; WebKit discarded every
// response and `fetch` threw, which the frontend reports as
// "Tidak ada koneksi ke server" even though the service was healthy. That made
// login and company registration impossible inside the shipped .app, while
// `curl` (which sends no Origin) kept working — so the bug was invisible to
// manual API checks.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startWorld } from './harness.mjs';

/** Origins the local service must answer with an ACAO header. */
const ALLOWED = [
  'tauri://localhost', // macOS packaged app
  'http://tauri.localhost', // Windows / Linux packaged app
  'http://localhost:5173', // Vite dev server
  'http://127.0.0.1:5173',
];

/** Origins that must NOT get an ACAO header. */
const REJECTED = ['https://evil.example.com', 'http://localhost.evil.com'];

/**
 * Read just the CORS header from a real response.
 *
 * `fetch` itself already enforces CORS in Node/undici, but it does so by
 * succeeding while hiding the response — reading the header directly is what
 * distinguishes "no header" (browser blocks) from "header for another origin".
 */
async function corsFor(url, origin) {
  const res = await fetch(url, { headers: { Origin: origin } });
  await res.arrayBuffer().catch(() => {});
  return res.headers.get('access-control-allow-origin');
}

test('the edge service allows the packaged app origin', async (t) => {
  const world = await startWorld();
  t.after(() => world.stop());

  const health = `${world.edge.url}/api/health`;

  for (const origin of ALLOWED) {
    const acao = await corsFor(health, origin);
    assert.ok(
      acao,
      `no Access-Control-Allow-Origin for ${origin} — the packaged app cannot call the service`,
    );
  }
});

test('a preflight from the packaged app is permitted', async (t) => {
  const world = await startWorld();
  t.after(() => world.stop());

  // Company registration is the first thing a fresh till does, and it is a
  // JSON POST, so the browser sends a preflight before it.
  const res = await fetch(`${world.edge.url}/api/auth/register`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'tauri://localhost',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.ok(res.status < 400, `preflight rejected with HTTP ${res.status}`);
  assert.ok(
    res.headers.get('access-control-allow-origin'),
    'preflight for the packaged app got no Access-Control-Allow-Origin',
  );
});

test('a remote origin is still refused', async (t) => {
  const world = await startWorld();
  t.after(() => world.stop());

  const health = `${world.edge.url}/api/health`;
  for (const origin of REJECTED) {
    const acao = await corsFor(health, origin);
    assert.equal(acao, null, `a remote origin (${origin}) must not be allowed`);
  }
});
