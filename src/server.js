import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { initSchema, db, DATA_DIR } from './db.js';
import { isEdge, EDGE_HOST, edgeCorsOptions, localSecret } from './edge.js';
import { startUpstreamWorker } from './lib/edgeOutbox.js';
import { backfillHolds } from './lib/edgeHoldSync.js';

import authRoutes, { registrationState } from './routes/auth.routes.js';
import orgRoutes from './routes/org.routes.js';
import catalogRoutes from './routes/catalog.routes.js';
import stockRoutes from './routes/stock.routes.js';
import transferRoutes from './routes/transfer.routes.js';
import posRoutes from './routes/pos.routes.js';
import holdRoutes from './routes/hold.routes.js';
import kitchenRoutes from './routes/kitchen.routes.js';
import shiftRoutes from './routes/shift.routes.js';
import deviceRoutes from './routes/device.routes.js';
import reportRoutes from './routes/report.routes.js';
import syncRoutes from './routes/sync.routes.js';
import auditRoutes from './routes/audit.routes.js';
import docsRoutes from './routes/docs.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import backupRoutes from './routes/backup.routes.js';
import edgeRoutes, { upstreamUrl } from './routes/edge.routes.js';
import { upstreamRequest } from './lib/edgeUpstream.js';

initSchema();

// The edge service signs its own device tokens with a per-machine secret. Reading
// it at boot also creates the file, so a rotated/removed secret fails loudly here
// rather than at the first offline unlock.
const EDGE = isEdge();
const secret = EDGE ? localSecret() : null;

// Product photos are written to disk (not the DB) and served back under /uploads.
// The directory is created on boot so a fresh clone works without extra setup.
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();

app.disable('x-powered-by');
// A local service is reachable from any page in the same browser, so it answers
// only to loopback origins; the cloud build keeps its open CORS policy.
app.use(EDGE ? cors(edgeCorsOptions()) : cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== 'test' && !EDGE) app.use(morgan('dev'));

/* ------------------------------- STATIC ------------------------------- */
// Product images: public read-only, no auth so the till can render <img> tags
// directly. Filenames are random UUIDs, so they are not enumerable.
app.use(
  '/uploads',
  express.static(UPLOAD_DIR, {
    maxAge: '7d',
    fallthrough: true,
    setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'),
  })
);

/* ------------------------------- HEALTH ------------------------------- */
// `mode` and `features` let a client tell the two roles apart. The till's own
// service and the cloud API share every route, so without this the Products page
// cannot know that a catalog import would land in a replica that the next
// bootstrap overwrites (see the import gate in ProductsPage).
app.get('/api/health', (req, res) =>
  res.json({
    ok: true,
    service: 'pos-backend',
    version: '1.0.0',
    mode: EDGE ? 'edge' : 'cloud',
    features: {
      // Product import writes the local catalogue. On a till that copy is a
      // replica: it is never pushed upstream and is replaced wholesale on the
      // next bootstrap, so the import is offered on the cloud only.
      productImport: !EDGE,
      // Whether `POST /api/auth/register` still accepts a new company. On a till
      // that is true exactly once — during first-run setup, while the replica has
      // no company yet (see `registrationState` in auth.routes) — because a second
      // company row would be a phantom tenant with `super_admin` over the local
      // service. On the cloud it is the operator's `ALLOW_SIGNUP` switch. The login
      // page hides the Register tab when this is false, and the route refuses
      // regardless; the read is one indexed row on the till, and the supervisor's
      // hot probe is `/api/edge/health`, which does not touch it.
      register: registrationState().open,
    },
    time: new Date().toISOString(),
  })
);

/* ------------------------------- ROUTES ------------------------------- */
// Each module declares paths relative to its own prefix.
app.use('/api/auth', authRoutes);      // /register, /login, /pin-login, /me, /company
app.use('/api', orgRoutes);            // /branches, /users, /roles
app.use('/api', catalogRoutes);        // /categories, /products, /variants, /branches/:id/catalog
app.use('/api', stockRoutes);          // /branches/:id/stock, /stock/*, /movements
app.use('/api', transferRoutes);       // /transfers/*
app.use('/api', posRoutes);            // /transactions/*
app.use('/api', holdRoutes);           // /holds/*
app.use('/api', kitchenRoutes);        // /branches/:id/queue, /queue/*
app.use('/api', shiftRoutes);          // /shifts/*
app.use('/api', deviceRoutes);         // /devices/*
app.use('/api', reportRoutes);         // /reports/*
app.use('/api', syncRoutes);           // /sync/*
app.use('/api', auditRoutes);          // /audit-logs
app.use('/api', docsRoutes);           // /openapi.json, /permissions
app.use('/api', settingsRoutes);       // /settings
// Restore uploads a whole bundle in one JSON body, which for a real shop runs to
// tens of megabytes — well past the global 5mb parser above. Registered ahead of
// the router so its own limit wins for these two paths only.
app.use(
  '/api',
  express.json({ limit: process.env.BACKUP_BODY_LIMIT || '200mb' }),
  backupRoutes
);
// Edge-only surface: health/queue/unlock/config. Not mounted on the cloud, so a
// cloud deployment exposes exactly the same API it did before.
if (EDGE) app.use('/api', edgeRoutes);

/* ------------------------------ WEB APP ------------------------------ */
// A web deployment gets one process and one port: the built SPA is served from
// here, so the browser's origin is the API and CORS never applies. Nothing is
// mounted when `WEB_ROOT` is unset, which is every till and every API-only
// install — the surface they expose is unchanged.
//
// Deliberately after the API routers: `/api/*` must keep answering JSON for
// unknown paths (the 404 below) instead of handing back index.html.
if (!EDGE && process.env.WEB_ROOT) {
  const WEB_ROOT = path.resolve(process.env.WEB_ROOT);
  const indexFile = path.join(WEB_ROOT, 'index.html');
  if (fs.existsSync(indexFile)) {
    app.use(
      express.static(WEB_ROOT, {
        index: false, // the fallback below sets the cache headers we want
        setHeaders: (res, filePath) => {
          // Vite emits content-hashed asset names, so they can be cached hard;
          // index.html must not be, or an upgrade leaves clients on old JS.
          if (/\/assets\//.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        },
      })
    );
    // Client-side routes (/transactions/:id, /products, ...) are not files on
    // disk. Any GET that is not API or uploads returns the shell and lets the
    // router resolve it.
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexFile);
    });
    if (process.env.NODE_ENV !== 'test') console.log(`POS web app served from ${WEB_ROOT}`);
  } else if (process.env.NODE_ENV !== 'test') {
    console.warn(`[web] WEB_ROOT is set to ${WEB_ROOT} but it has no index.html — serving the API only`);
  }
}

/* ------------------------------ 404 + ERRORS ------------------------------ */

app.use('/api', (req, res) => res.status(404).json({ error: `Endpoint not found: ${req.method} ${req.originalUrl}` }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[api error]', err);
  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : err.message,
    ...(process.env.NODE_ENV === 'development' && status >= 500 ? { detail: err.message } : {})
  });
});

const PORT = process.env.PORT || 4000;
// Edge mode binds loopback only: the till's own service must never be reachable
// from the network. It also prints a single machine-readable line the Tauri
// supervisor watches for, so the UI knows the service is really up.
const HOST = EDGE ? EDGE_HOST : process.env.HOST || '0.0.0.0';
if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, HOST, () => {
    if (EDGE) {
      console.log(`POS edge service ready on http://${HOST}:${PORT} unit=1`);
      const code = upstreamUrl() ? 'upstream=1' : 'upstream=0';
      console.log(`POS edge upstream ${code} queue=${JSON.stringify({ secret_bytes: secret.length })}`);
    } else {
      console.log(`POS backend listening on http://localhost:${PORT} (docs: /api/openapi.json)`);
    }
  });

  // Drain queued sales to the cloud in the background. Started only in edge mode
  // and only when an upstream is configured; a stand-alone till keeps its rows
  // pending forever, which is the intended behaviour.
  const stopWorker = EDGE ? startDrainWorker() : null;

  function startDrainWorker() {
    // Carts parked before the hold lane existed were never queued for the cloud;
    // pick them up once so an upgrade mid-shift does not strand them.
    backfillHolds();
    return startUpstreamWorker({
      branchIds: () => {
        const ids = new Set();
        const configured = db.prepare("SELECT value FROM settings WHERE key = 'edge_branch_id'").get();
        if (configured && configured.value) ids.add(configured.value);
        for (const r of db.prepare("SELECT DISTINCT branch_id FROM edge_outbox WHERE status = 'pending'").all()) {
          if (r.branch_id) ids.add(r.branch_id);
        }
        // Ticket status changes ride a second lane; a branch with one still needs the
        // worker to run even when no sale is pending.
        for (const r of db.prepare("SELECT DISTINCT branch_id FROM edge_queue_sync WHERE status = 'pending'").all()) {
          if (r.branch_id) ids.add(r.branch_id);
        }
        // Same for parked ("On Hold") carts: they were never in the sale outbox.
        for (const r of db.prepare("SELECT DISTINCT branch_id FROM edge_hold_sync WHERE status = 'pending'").all()) {
          if (r.branch_id) ids.add(r.branch_id);
        }
        return [...ids];
      },
      post: async (path, body) => upstreamRequest(path, { method: 'POST', body }),
      onTick: (branchId, res) => {
        if (res.applied) console.log(`POS edge synced branch=${branchId} applied=${res.applied}`);
      },
      onError: () => {
        /* offline — rows keep their backoff, nothing to report */
      },
    });
  }

  const shutdown = () => {
    if (stopWorker) stopWorker();
    server.close(() => process.exit(0));
    // Never hang a supervisor that expects the child to die promptly.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export default app;
