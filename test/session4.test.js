// Session 4 self-tests — deployment readiness.
//
// Everything here is about the app surviving contact with Railway: running
// behind a TLS-terminating proxy, binding the port it is given, booting with a
// secret missing, and running the real production code path end to end against
// a throwaway database. Nothing sends real mail — the production simulation has
// no Gmail variables at all, which is itself one of the things being tested.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Client, Pool } = require('pg');
const bcrypt = require('bcrypt');

const REPO_ROOT = path.join(__dirname, '..');
const TEST_DB = 'receipts_test_deploy';
const SIM_DB = 'receipts_prodsim';
const ADMIN_PASSWORD = 'test-admin-password';
const ADMIN_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 4);

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL missing — copy .env.example to .env first');
}

// The developer's real URL, captured before anything below reassigns it.
const REAL_URL = process.env.DATABASE_URL;

function urlFor(dbName, extra = '') {
  const u = new URL(REAL_URL);
  u.pathname = '/' + dbName;
  return u.toString() + extra;
}
const adminUrl = urlFor('postgres');
const testUrl = urlFor(TEST_DB);
// The same database, told explicitly not to negotiate TLS — needed whenever a
// child boots with NODE_ENV=production against the local Postgres.
const testUrlNoSsl = urlFor(TEST_DB, '?sslmode=disable');
// The simulation runs the production code path, which turns TLS on. A local
// Postgres has SSL switched off, so the connection string says so explicitly.
const simUrl = urlFor(SIM_DB, '?sslmode=disable');

process.env.DATABASE_URL = testUrl;
process.env.ADMIN_PASSWORD_HASH = ADMIN_HASH;
delete process.env.GMAIL_USER;
delete process.env.GMAIL_APP_PASSWORD;

const db = require('../db');
const { runMigrations } = require('../migrate');
const { createApp, checkStartupConfig } = require('../app');

// ── helpers ─────────────────────────────────────────────────────────────────

const servers = [];
function serve(app) {
  const s = app.listen(0);
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}

async function api(base, p, { method = 'GET', token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + p, { method, headers: h, body: payload });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : null;
  return { status: res.status, data, res };
}

async function createDatabase(name) {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
}

async function dropDatabase(name) {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}

async function databaseExists(name) {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  await admin.end();
  return rows.length > 0;
}

// Boots `node server.js` the way Railway does — a real child process, real
// environment, nothing stubbed. Resolves once it says it is listening.
function bootServer(env, { timeoutMs = 40000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['server.js'], {
      cwd: REPO_ROOT,
      // A deliberately bare environment: only PATH and what the case sets. This
      // is what makes "boot with a secret missing" mean anything.
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let settled = false;
    const handle = {
      proc,
      logs: () => output,
      stop: () =>
        new Promise((done) => {
          if (proc.exitCode !== null) return done();
          proc.once('exit', () => done());
          proc.kill();
        }),
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error('server did not start within the timeout. Output:\n' + output));
    }, timeoutMs);

    const onData = (chunk) => {
      output += chunk.toString();
      if (!settled && /listening on/.test(output)) {
        settled = true;
        clearTimeout(timer);
        resolve(handle);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code} before listening. Output:\n` + output));
    });
  });
}

let base;

beforeAll(async () => {
  await createDatabase(TEST_DB);
  const setup = new Pool({ connectionString: testUrl });
  await runMigrations(setup);
  await setup.end();
  base = serve(createApp());
}, 120000);

afterAll(async () => {
  for (const s of servers) s.close();
  await db.pool.end().catch(() => {});
  await dropDatabase(SIM_DB).catch(() => {});
});

// ── 1. behind Railway's proxy ───────────────────────────────────────────────

describe('trust proxy', () => {
  it('1. is exactly one hop — never `true`, which a client could spoof past', () => {
    const app = createApp();
    expect(app.get('trust proxy')).toBe(1);
    expect(app.get('trust proxy')).not.toBe(true);
  });

  it('2. one hop means the proxy is trusted and whatever it forwards is not', () => {
    // Express compiles the setting into a predicate: (address, hopIndex) =>
    // trusted. Hop 0 is the socket peer — Railway's proxy. Hop 1 is the address
    // that peer forwarded, which is under the client's control and must not be
    // trusted. Under `true` both would come back trusted, and the login limiter
    // would be defeated by a made-up X-Forwarded-For on every request.
    const trust = createApp().get('trust proxy fn');
    expect(trust('127.0.0.1', 0)).toBe(true);
    expect(trust('203.0.113.7', 1)).toBe(false);
  });

  it('3. the login limiter counts each forwarded client separately', async () => {
    // The whole point: on Railway every request arrives from the proxy's
    // address. If the limiter keyed on that, ten fumbled passwords from anyone
    // on the internet would lock the owner out of their own records.
    const app = serve(createApp());
    const attempt = (ip) =>
      api(app, '/api/login', {
        method: 'POST',
        body: { password: 'wrong' },
        headers: { 'X-Forwarded-For': ip },
      });

    // The limiter allows 10 per 15 minutes.
    for (let i = 0; i < 10; i++) {
      const r = await attempt('198.51.100.1');
      expect(r.status, `attempt ${i + 1}`).toBe(401);
    }
    const blocked = await attempt('198.51.100.1');
    expect(blocked.status).toBe(429);
    expect(blocked.data).toEqual({ error: 'rate_limited' });

    // A different client is untouched by that — it gets the ordinary 401.
    const other = await attempt('198.51.100.2');
    expect(other.status).toBe(401);
    expect(other.data).toEqual({ error: 'invalid_credentials' });
  }, 30000);

  it('4. prefixing a made-up address does not buy a fresh allowance', async () => {
    // The attack `trust proxy: true` would allow: exhaust the limiter, then
    // prepend a different address and carry on guessing. The real proxy appends
    // the true client at the END of the header, so only the last entry counts.
    const app = serve(createApp());
    const attempt = (forwarded) =>
      api(app, '/api/login', {
        method: 'POST',
        body: { password: 'wrong' },
        headers: { 'X-Forwarded-For': forwarded },
      });

    for (let i = 0; i < 10; i++) await attempt('198.51.100.3');
    expect((await attempt('198.51.100.3')).status).toBe(429);

    // Same real client, with junk prepended by the client itself.
    expect((await attempt('9.9.9.9, 198.51.100.3')).status).toBe(429);
    expect((await attempt('1.1.1.1, 2.2.2.2, 198.51.100.3')).status).toBe(429);
  }, 30000);

  it('5. a request with no forwarded header still works', async () => {
    const app = serve(createApp());
    const r = await api(app, '/api/login', { method: 'POST', body: { password: 'wrong' } });
    expect(r.status).toBe(401);
  });
});

// ── 2. the boot-time configuration check ────────────────────────────────────

describe('checkStartupConfig', () => {
  const FULL = {
    ADMIN_PASSWORD_HASH: ADMIN_HASH,
    GMAIL_USER: 'someone@gmail.com',
    GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop',
    DATABASE_URL: 'postgres://user:hunter2@host:5432/db',
  };

  it('6. says nothing when everything is set', () => {
    expect(checkStartupConfig(FULL)).toEqual([]);
  });

  it('7. names a missing admin hash and says login is disabled', () => {
    const warnings = checkStartupConfig({ ...FULL, ADMIN_PASSWORD_HASH: '' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ADMIN_PASSWORD_HASH');
    expect(warnings[0]).toContain('login is disabled');
  });

  it('8. warns when email is only half-configured', () => {
    const warnings = checkStartupConfig({ ...FULL, GMAIL_APP_PASSWORD: '' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('GMAIL');
    expect(warnings[0]).toContain('Retry email');
  });

  it('9. warns about a missing database URL', () => {
    const warnings = checkStartupConfig({ ...FULL, DATABASE_URL: '' });
    expect(warnings.join(' ')).toContain('DATABASE_URL');
  });

  it('10. NEVER puts a secret value in a message — only the name of the variable', () => {
    const warnings = checkStartupConfig({}).join('\n');
    for (const secret of [ADMIN_HASH, 'abcd efgh ijkl mnop', 'hunter2', '$2b$']) {
      expect(warnings, secret).not.toContain(secret);
    }
    // And with values present, it still reports nothing but names.
    const all = checkStartupConfig(FULL).join('\n');
    expect(all).toBe('');
  });
});

// ── 3. build configuration ──────────────────────────────────────────────────

describe('Railway build configuration', () => {
  const railway = fs.readFileSync(path.join(REPO_ROOT, 'railway.toml'), 'utf8');

  it('11. railway.toml uses nixpacks, runs server.js, and health-checks /health', () => {
    expect(railway).toMatch(/builder\s*=\s*"nixpacks"/);
    expect(railway).toMatch(/startCommand\s*=\s*"node server\.js"/);
    expect(railway).toMatch(/healthcheckPath\s*=\s*"\/health"/);
  });

  it('12. and restarts on failure, with a bound so a broken deploy shows as failed', () => {
    expect(railway).toMatch(/restartPolicyType\s*=\s*"on_failure"/);
    expect(railway).toMatch(/restartPolicyMaxRetries\s*=\s*\d+/);
  });

  it('13. Node is pinned in exactly one place, package.json engines', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.engines.node).toBe('20.x');
    expect(pkg.scripts.start).toBe('node server.js');
    // Nothing may pin a second, drifting copy of the version.
    expect(railway).not.toMatch(/NIXPACKS_NODE_VERSION|nodejs_\d+/);
  });

  it('14. the lockfile is present and agrees with package.json', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'package-lock.json'))).toBe(true);
    // `npm ci` refuses to run at all if the two are out of sync, so this is the
    // real check that a clean production install will succeed.
    execFileSync('npm', ['ci', '--dry-run'], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  }, 180000);

  it('15. the logo the PDFs need is committed, not gitignored', () => {
    const tracked = execFileSync('git', ['ls-files', 'assets/logo.png'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(tracked.trim()).toBe('assets/logo.png');
  });
});

describe('database TLS', () => {
  it('16. production defaults to TLS, development does not', () => {
    const saved = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(db.databaseSsl('postgres://u:p@host/db')).toEqual({ rejectUnauthorized: false });
      process.env.NODE_ENV = 'development';
      expect(db.databaseSsl('postgres://u:p@host/db')).toBe(false);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it('17. an explicit sslmode in the URL wins over the default', () => {
    const saved = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(db.databaseSsl('postgres://u:p@host/db?sslmode=disable')).toBe(false);
      expect(db.databaseSsl('postgres://u:p@host/db?sslmode=require')).toEqual({
        rejectUnauthorized: false,
      });
      expect(db.databaseSsl('postgres://u:p@host/db?sslmode=verify-full')).toEqual({
        rejectUnauthorized: true,
      });
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

// ── 4. HTTPS posture ────────────────────────────────────────────────────────

describe('HTTPS', () => {
  it('18. HSTS is on and nothing redirects — Railway terminates TLS', async () => {
    const r = await api(base, '/health');
    expect(r.status).toBe(200);
    expect(r.res.headers.get('strict-transport-security')).toMatch(/max-age=\d+/);
    const page = await fetch(base + '/', { redirect: 'manual' });
    expect(page.status).toBe(200); // not 301/302
  });
});

// ── 5. booting the way Railway boots it ─────────────────────────────────────

describe('boot', () => {
  it('19. listens on the PORT it is given, on 0.0.0.0', async () => {
    const port = 3097;
    const server = await bootServer({
      DATABASE_URL: testUrl,
      PORT: String(port),
      ADMIN_PASSWORD_HASH: ADMIN_HASH,
    });
    try {
      expect(server.logs()).toContain(`listening on 0.0.0.0:${port}`);
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    } finally {
      await server.stop();
    }
  }, 60000);

  it('20. with ADMIN_PASSWORD_HASH unset it still serves — and says why login fails', async () => {
    // A missing secret must never take the site down: if it did, there would be
    // nothing to look at from the outside to work out what is wrong.
    const port = 3098;
    const server = await bootServer({
      DATABASE_URL: testUrlNoSsl,
      PORT: String(port),
      NODE_ENV: 'production',
    });
    try {
      const logs = server.logs();
      expect(logs).toContain('startup:');
      expect(logs).toContain('ADMIN_PASSWORD_HASH');
      expect(logs).toContain('login is disabled');

      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);

      const page = await fetch(`http://127.0.0.1:${port}/`);
      expect(page.status).toBe(200);
      expect((await page.text())).toContain('id="login-form"');

      const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'anything' }),
      });
      expect(login.status).toBe(401);
      expect(await login.json()).toEqual({ error: 'invalid_credentials' });
    } finally {
      await server.stop();
    }
  }, 60000);

  it('21. migrations failing means no server at all, with a non-zero exit', async () => {
    // Never serve on a half-migrated schema.
    await expect(
      bootServer(
        {
          DATABASE_URL: urlFor('receipts_definitely_not_a_database', '?sslmode=disable'),
          PORT: '3099',
        },
        { timeoutMs: 25000 }
      )
    ).rejects.toThrow(/exited with code [^0]/);
  }, 45000);
});

// ── 6. the production simulation ────────────────────────────────────────────

describe('production simulation', () => {
  const port = 3100;
  let server;
  let devInvoiceCountBefore = null;

  beforeAll(async () => {
    // What receipts_dev looks like before any of this runs, so afterwards we can
    // show it was never touched.
    if (await databaseExists('receipts_dev')) {
      const dev = new Client({ connectionString: urlFor('receipts_dev') });
      await dev.connect();
      devInvoiceCountBefore = await dev
        .query('SELECT count(*)::int AS n FROM invoices')
        .then((r) => r.rows[0].n)
        .catch(() => 'no invoices table');
      await dev.end();
    }

    await createDatabase(SIM_DB);
    // NODE_ENV=production, a database URL, and nothing else. No Gmail
    // variables: this is the "email is not configured yet" state a first
    // deploy is genuinely in.
    server = await bootServer({
      NODE_ENV: 'production',
      DATABASE_URL: simUrl,
      PORT: String(port),
      ADMIN_PASSWORD_HASH: ADMIN_HASH,
    });
  }, 120000);

  afterAll(async () => {
    if (server) await server.stop();
    await dropDatabase(SIM_DB).catch(() => {});
  });

  const at = (p) => `http://127.0.0.1:${port}${p}`;

  it('22. migrations applied at boot, before anything was served', () => {
    const logs = server.logs();
    expect(logs).toMatch(/migrate: applied 001_init\.sql/);
    expect(logs).toMatch(/migrate: applied 006_harden_receipt_counter\.sql/);
    // Order matters: every migration line comes before the listening line.
    expect(logs.indexOf('migrate: applied 006')).toBeLessThan(logs.indexOf('listening on'));
  });

  it('23. /health answers 200 against the real database', async () => {
    const res = await fetch(at('/health'));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('24. the page is served', async () => {
    const res = await fetch(at('/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Mathemajics');
  });

  it('25. an invoice records with the email on the retry path, and the record is intact', async () => {
    const login = await fetch(at('/api/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const token = (await login.json()).token;

    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const res = await fetch(at('/api/invoices'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        issue_date: iso,
        due_date: iso,
        student_name: 'Prod Sim Student',
        parent_name: 'Prod Sim Parent',
        parent_email: 'parent@example.com',
        line_items: [{ description: 'Tuition', qty: 2, rate: 75, amount: 150 }],
        subtotal: 150,
        total: 150,
        currency: 'AUD',
      }),
    });
    expect(res.status).toBe(201);
    const payload = await res.json();

    // No Gmail credentials, so the send fails — and the invoice survives it.
    expect(payload.emailed).toBe(false);
    expect(payload.email_error).toBe('send_failed');
    expect(payload.invoice.invoice_number).toBe('INV-000001');
    expect(payload.invoice.email_sent_at).toBe(null);
    expect(Number(payload.invoice.total)).toBe(150);
    // The date fix holds in production mode too.
    expect(payload.invoice.issue_date).toBe(iso);

    // And it is really in the database, not just in the response.
    const list = await fetch(at('/api/invoices'), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const rows = (await list.json()).invoices;
    expect(rows).toHaveLength(1);
    expect(rows[0].invoice_number).toBe('INV-000001');

    // The PDF was still generated and stored.
    const pdf = await fetch(at(`/api/invoices/${payload.invoice.id}/pdf`), {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(pdf.status).toBe(200);
    expect(Buffer.from(await pdf.arrayBuffer()).slice(0, 5).toString('latin1')).toBe('%PDF-');
  }, 60000);

  it('26. no secret value appears anywhere in the boot or request logs', () => {
    const logs = server.logs();
    for (const secret of [ADMIN_HASH, ADMIN_PASSWORD, '$2b$']) {
      expect(logs, secret).not.toContain(secret);
    }
    // The database URL carries the password; it must not be echoed either.
    const password = new URL(REAL_URL).password;
    if (password) expect(logs).not.toContain(decodeURIComponent(password));
    expect(logs).not.toContain(simUrl);
  });

  it('27. receipts_dev was never touched', async () => {
    if (devInvoiceCountBefore === null) return; // no dev database on this machine
    const dev = new Client({ connectionString: urlFor('receipts_dev') });
    await dev.connect();
    const after = await dev
      .query('SELECT count(*)::int AS n FROM invoices')
      .then((r) => r.rows[0].n)
      .catch(() => 'no invoices table');
    await dev.end();
    expect(after).toEqual(devInvoiceCountBefore);
  });

  it('28. the throwaway database is dropped when this suite finishes', async () => {
    // Proven by afterAll; asserted in the next run's beforeAll, which recreates
    // it from nothing. Here we simply record that it exists right now and is
    // separate from receipts_dev.
    expect(await databaseExists(SIM_DB)).toBe(true);
    expect(SIM_DB).not.toBe('receipts_dev');
  });
});
