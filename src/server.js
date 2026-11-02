import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { initSchema } from './db.js';

import authRoutes from './routes/auth.routes.js';
import orgRoutes from './routes/org.routes.js';
import catalogRoutes from './routes/catalog.routes.js';
import stockRoutes from './routes/stock.routes.js';
import transferRoutes from './routes/transfer.routes.js';
import posRoutes from './routes/pos.routes.js';
import holdRoutes from './routes/hold.routes.js';
import shiftRoutes from './routes/shift.routes.js';
import deviceRoutes from './routes/device.routes.js';
import reportRoutes from './routes/report.routes.js';
import syncRoutes from './routes/sync.routes.js';
import auditRoutes from './routes/audit.routes.js';
import docsRoutes from './routes/docs.routes.js';

initSchema();

// Product photos are written to disk (not the DB) and served back under /uploads.
// The directory is created on boot so a fresh clone works without extra setup.
const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

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
app.use('/api', shiftRoutes);          // /shifts/*
app.use('/api', deviceRoutes);         // /devices/*
app.use('/api', reportRoutes);         // /reports/*
app.use('/api', syncRoutes);           // /sync/*
app.use('/api', auditRoutes);          // /audit-logs
app.use('/api', docsRoutes);           // /openapi.json, /permissions

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
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => console.log(`POS backend listening on http://localhost:${PORT} (docs: /api/openapi.json)`));
}

export default app;
