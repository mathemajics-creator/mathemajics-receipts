// auth.js — admin login/logout and the requireAdmin middleware.
// One admin, password checked against ADMIN_PASSWORD_HASH (bcrypt) from env.
// Session tokens are opaque random values; only their SHA-256 hash is stored.

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('./db');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function login(req, res, next) {
  try {
    const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    const adminHash = process.env.ADMIN_PASSWORD_HASH;
    if (!adminHash) {
      console.warn('auth: ADMIN_PASSWORD_HASH is not set — rejecting all logins');
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    const ok = password.length > 0 && (await bcrypt.compare(password, adminHash));
    if (!ok) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }

    // Opportunistic cleanup of expired sessions (no cron needed at this scale).
    await db.pool.query('DELETE FROM sessions WHERE expires_at < now()');

    const token = crypto.randomBytes(32).toString('hex');
    const ttlHours = parseFloat(process.env.SESSION_TTL_HOURS) || 12;
    const { rows } = await db.pool.query(
      `INSERT INTO sessions (token_hash, expires_at)
       VALUES ($1, now() + ($2 * interval '1 hour'))
       RETURNING expires_at`,
      [hashToken(token), ttlHours]
    );
    res.json({ token, expires_at: rows[0].expires_at });
  } catch (err) {
    next(err);
  }
}

async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer ([a-f0-9]{64})$/i);
    if (!match) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const { rows } = await db.pool.query(
      'SELECT token_hash FROM sessions WHERE token_hash = $1 AND expires_at > now()',
      [hashToken(match[1])]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    req.sessionTokenHash = rows[0].token_hash;
    next();
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    await db.pool.query('DELETE FROM sessions WHERE token_hash = $1', [req.sessionTokenHash]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

module.exports = { login, logout, requireAdmin, hashToken };
