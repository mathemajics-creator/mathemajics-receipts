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

  // Railway terminates TLS at its edge proxy, so every request reaches this
  // process from the proxy's address. Without this, express-rate-limit sees one
  // client for the whole internet: the login limiter's ten attempts per fifteen
  // minutes would be shared by everybody, and one person fumbling their
  // password would lock the owner out.
  //
  // Exactly one hop, never `true`. `true` tells Express to believe the whole of
  // X-Forwarded-For, including the part a client wrote itself — so an attacker
  // could put a fresh fake address on every request and never trip the login
  // limiter at all. `1` trusts only the last hop, which is Railway's proxy, and
  // that is the only hop in front of this app.
  app.set('trust proxy', 1);

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

// Things worth saying out loud when the process starts in production, where
// nobody is watching a terminal and a missing variable otherwise shows up as a
// mystery later. Returns the messages rather than printing them, so it can be
// tested without capturing console output.
//
// It reports only WHETHER a variable is set. No value is ever returned, logged
// or interpolated — not the hash, not the app password, not the database URL.
//
// Nothing here throws or exits. A missing secret must still leave /health and
// the login page serving, or a broken deployment cannot be diagnosed from the
// outside at all.
function checkStartupConfig(env = process.env) {
  const warnings = [];

  if (!env.ADMIN_PASSWORD_HASH) {
    warnings.push(
      'ADMIN_PASSWORD_HASH is not set — login is disabled and every attempt ' +
        'will be rejected. Generate one with `npm run hash-password` and set it ' +
        'in the Railway dashboard.'
    );
  }

  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    warnings.push(
      'GMAIL_USER and GMAIL_APP_PASSWORD are not both set — invoices and ' +
        'receipts will still be recorded, but the email will fail and each one ' +
        'will land on the "Retry email" path.'
    );
  }

  if (!env.DATABASE_URL) {
    warnings.push('DATABASE_URL is not set — migrations will fail and the server will not start.');
  }

  return warnings;
}

module.exports = { createApp, checkStartupConfig };
