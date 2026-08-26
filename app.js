// app.js — builds the Express app. A factory so tests can create fresh
// instances (rate-limiter counters are per-instance).

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const auth = require('./auth');
const receiptsRouter = require('./routes/receipts');
const invoicesRouter = require('./routes/invoices');

const PUBLIC_DIR = path.join(__dirname, 'public');

function createApp() {
  const app = express();

  // helmet's defaults, with exactly ONE directive extended: connect-src.
  //
  // The new-invoice screen offers to look up today's currency rate so the owner
  // can confirm it rather than type it from memory. That lookup happens in the
  // BROWSER, not here — the server never makes an outbound rate call, so the
  // path that writes a record stays entirely offline and no outside service can
  // stand between the owner and an issued invoice.
  //
  // Because the fetch is made by the page, the page's CSP has to allow it, and
  // helmet's default connect-src falls back to default-src 'self'. Only the one
  // origin is added. script-src, style-src, img-src, default-src and the rest
  // keep helmet's defaults untouched — in particular script-src stays 'self',
  // so no external code can ever run on this page.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'connect-src': ["'self'", 'https://api.frankfurter.dev'],
        },
      },
    })
  );
  app.use(express.json({ limit: '100kb' }));

  // The screens. Deliberately NOT behind requireAdmin: an HTML page, a
  // stylesheet and some JavaScript are not secrets, and gating them would only
  // mean the login screen could not load. Every piece of DATA stays behind the
  // API's auth, which is where the guarantee belongs.
  app.use(express.static(PUBLIC_DIR, { index: false }));
  app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  // Unauthenticated health check — unchanged from Session 1.
  app.get('/health', async (req, res) => {
    try {
      await db.ping();
      res.status(200).json({ ok: true, uptime: process.uptime() });
    } catch (err) {
      res.status(503).json({ ok: false, error: 'db_unreachable' });
    }
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'rate_limited' }),
  });
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'rate_limited' }),
  });
  app.use('/api', apiLimiter);

  // JSON endpoints only accept JSON bodies.
  app.use('/api', (req, res, next) => {
    const hasBody = Number(req.headers['content-length'] || 0) > 0;
    if (req.method === 'POST' && hasBody && !req.is('application/json')) {
      return res.status(400).json({ error: 'json_required' });
    }
    next();
  });

  app.post('/api/login', loginLimiter, auth.login);
  app.use('/api', auth.requireAdmin);
  app.post('/api/logout', auth.logout);
  app.use('/api/receipts', receiptsRouter);
  app.use('/api/invoices', invoicesRouter);

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Last: generic error responses; details stay in server logs (no secrets,
  // no stack traces to clients).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'payload_too_large' });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json' });
    }
    console.error('unhandled error:', err && err.message);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

module.exports = { createApp };
