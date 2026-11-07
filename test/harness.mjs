// Two-database test harness: a real cloud process and a real edge process.
//
// The two roles share one codebase and differ only by `EDGE_MODE` and `DB_DIR`,
// and `src/db.js` opens its SQLite handle as a module singleton. Running both in
// one process would mean one module instance and therefore one database, so the
// harness spawns two child processes instead. That also means these tests
// exercise the real startup path — route mounting, edge-vs-cloud branching, the
// `/api/edge/*` mount being absent on the cloud — rather than a hand-assembled
// Express app that could drift from it.
//
// Ports are left to the OS (PORT=0) and read back from the startup banner, so
// parallel runs and a developer's own `npm start` never collide.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SERVER = path.join(import.meta.dirname, '..', 'src', 'server.js');

/** Fails the test run rather than hanging it if a child never reports ready. */
const BOOT_TIMEOUT_MS = 20_000;

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'pos-test-'));
}

/**
 * Ask the OS for a free loopback port.
 *
 * This mirrors `free_port()` in the Tauri supervisor (src-tauri/src/edge.rs)
 * rather than using `PORT=0`: the server's startup banner echoes the configured
 * PORT, not the bound one, so `0` would print `localhost:0`. Binding and
 * releasing is the same small race the desktop app already accepts.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Poll a /health endpoint until the child answers, like `wait_for_ready`. */
async function waitForHealth(url) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`${url} not responding after ${BOOT_TIMEOUT_MS}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Spawn one server on its own port and data directory, and resolve once healthy.
 */
async function startServer({ mode, logPrefix, env }) {
  const dataDir = tempDir();
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_DIR: dataDir,
      HOST: '127.0.0.1',
      ...(mode === 'edge' ? { EDGE_MODE: '1' } : {}),
      // Keep the run honest: tests must not inherit a developer's shell overrides
      // that would silently change behaviour under test.
      NODE_ENV: 'production',
      JWT_SECRET: 'test-secret',
      // Per-server overrides (e.g. `ALLOW_SIGNUP=0`), applied last on purpose: a
      // test that exercises a switch must win over the inherited environment.
      ...(env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (b) => {
    output += String(b);
  });
  child.stderr.on('data', (b) => {
    output += String(b);
  });

  const died = new Promise((_, reject) => {
    child.once('exit', (code) => {
      reject(new Error(`${logPrefix} exited during startup (code ${code})\n${output}`));
    });
  });

  const url = `http://127.0.0.1:${port}`;
  try {
    await Promise.race([waitForHealth(url), died]);
  } catch (e) {
    child.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
    throw e;
  }

  const stop = async () => {
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
        // A child that ignores SIGTERM must not wedge the whole suite.
        setTimeout(() => child.kill('SIGKILL'), 3_000).unref();
      });
    }
    rmSync(dataDir, { recursive: true, force: true });
  };

  return { url, dataDir, stop };
}

/**
 * Start one server only. Exported for tests about a single role's own surface
 * (static hosting, the CLI's database) where spinning up a paired world would be
 * noise — and where `startWorld`'s edge process must not run at all.
 */
export async function startSingle({ mode = 'cloud', env } = {}) {
  return startServer({ mode, logPrefix: mode, env });
}

/**
 * Start a paired world: a cloud with a fresh company, and an edge till pointed
 * at it. The till is NOT paired or bootstrapped here — tests that care about
 * those steps call the endpoints themselves.
 */
export async function startWorld({ cloudEnv, edgeEnv } = {}) {
  const [cloud, edge] = await Promise.all([
    startServer({ mode: 'cloud', logPrefix: 'cloud', env: cloudEnv }),
    startServer({ mode: 'edge', logPrefix: 'edge', env: edgeEnv }),
  ]);

  const stopAll = async () => {
    await Promise.allSettled([cloud.stop(), edge.stop()]);
  };

  return {
    cloud,
    edge,
    api: { cloud: makeClient(cloud.url), edge: makeClient(edge.url) },
    stop: stopAll,
  };
}

/** Minimal fetch wrapper. Returns {status, body} instead of throwing on 4xx/5xx. */
export function makeClient(base) {
  const call = async (method, pathname, { token, body } = {}) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  };

  return {
    get: (p, opts) => call('GET', p, opts),
    post: (p, opts) => call('POST', p, opts),
    put: (p, opts) => call('PUT', p, opts),
    patch: (p, opts) => call('PATCH', p, opts),
    del: (p, opts) => call('DELETE', p, opts),
  };
}
