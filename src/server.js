import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { initSchema, db, DATA_DIR } from './db.js';
import { isEdge, EDGE_HOST, edgeCorsOptions, localSecret } from './edge.js';
import { startUpstreamWorker } from './lib/edgeOutbox.js';

import authRoutes from './routes/auth.routes.js';
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
import edgeRoutes, { upstreamUrl } from './routes/edge.routes.js';

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
app.get('/api/health', (req, res) =>
  res.json({ ok: true, service: 'pos-backend', version: '1.0.0', time: new Date().toISOString() })
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
// Edge-only surface: health/queue/unlock/config. Not mounted on the cloud, so a
// cloud deployment exposes exactly the same API it did before.
if (EDGE) app.use('/api', edgeRoutes);

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
    return startUpstreamWorker({
      branchIds: () => {
        const ids = new Set();
        const configured = db.prepare("SELECT value FROM settings WHERE key = 'edge_branch_id'").get();
        if (configured && configured.value) ids.add(configured.value);
        for (const r of db.prepare("SELECT DISTINCT branch_id FROM edge_outbox WHERE status = 'pending'").all()) {
          if (r.branch_id) ids.add(r.branch_id);
        }
        return [...ids];
      },
      post: async (path, body) => {
        const upstream = upstreamUrl();
        if (!upstream) throw new Error('Server pusat belum diatur');
        // The drain runs without a user on screen, so it authenticates with the
        // device token minted at the last successful login.
        const token = db.prepare("SELECT value FROM settings WHERE key = 'edge_device_token'").get();
        const r = await fetch(`${upstream}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token && token.value ? { Authorization: `Bearer ${token.value}` } : {}),
          },
          body: JSON.stringify(body),
        });
        const text = await r.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = null;
        }
        if (!r.ok) throw new Error((data && data.error) || `Server pusat menolak (${r.status})`);
        return data;
      },
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
