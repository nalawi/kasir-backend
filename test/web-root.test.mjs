// Tests for serving the built web app from the API process (`WEB_ROOT`).
//
// This is the switch that makes a deployment one process instead of "nginx for
// the SPA, node for the API". It is easy to get wrong in two ways that only show
// up in production: swallowing `/api/*` (the browser then receives index.html
// where it expects JSON, and every page reports a syntax error), and caching
// index.html (an upgrade leaves clients on the previous bundle until they clear
// storage). Both are asserted here against a real server process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startSingle } from './harness.mjs';

/** A tiny stand-in for `frontend/dist`. */
function makeWebRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pos-web-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>shell</title>');
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  return dir;
}

test('WEB_ROOT serves the SPA, its deep links and the API from one port', async (t) => {
  const webRoot = makeWebRoot();
  const server = await startSingle({ env: { WEB_ROOT: webRoot } });
  t.after(async () => {
    await server.stop();
    rmSync(webRoot, { recursive: true, force: true });
  });

  const home = await fetch(`${server.url}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /shell/);
  // The shell must not be cached, or a deploy leaves browsers on the old bundle.
  assert.match(home.headers.get('cache-control') || '', /no-cache/);

  // Client-side route: no such file on disk, so the shell has to answer.
  const deep = await fetch(`${server.url}/transactions/abc123`);
  assert.equal(deep.status, 200);
  assert.match(await deep.text(), /shell/);

  // Hashed assets are immutable; that is the reason the build emits hashes.
  const asset = await fetch(`${server.url}/assets/index-abc123.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control') || '', /immutable/);

  // The API keeps working exactly as before.
  const health = await fetch(`${server.url}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, 'pos-backend');

  // An unknown API path must stay JSON. A shell response here would break every
  // client that parses error bodies.
  const unknown = await fetch(`${server.url}/api/does-not-exist`);
  assert.equal(unknown.status, 404);
  assert.match(unknown.headers.get('content-type') || '', /json/);

  // A missing upload must not turn into the SPA shell either (an <img> would
  // render a broken image from HTML rather than reporting a clean 404).
  const upload = await fetch(`${server.url}/uploads/nope.png`);
  assert.equal(upload.status, 404);
  assert.doesNotMatch(await upload.text(), /shell/);
});

test('without WEB_ROOT the server stays API-only', async (t) => {
  const server = await startSingle();
  t.after(() => server.stop());

  const home = await fetch(`${server.url}/`);
  assert.equal(home.status, 404, 'a bare install must not grow a static file server');

  const health = await fetch(`${server.url}/api/health`);
  assert.equal(health.status, 200);
});
