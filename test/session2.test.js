// Session 2 self-tests — auth, counter hardening, creation, PDF, email
// (stubbed transport — NEVER real SMTP), retry, void, reads, CSV export.
// Runs against real Postgres on the receipts_test scratch database.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const { Client, Pool } = require('pg');
const bcrypt = require('bcrypt');

const TEST_DB = 'receipts_test';
const ADMIN_PASSWORD = 'test-admin-password';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL missing — copy .env.example to .env first');
}

const adminUrl = (() => {
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = '/postgres';
  return u.toString();
})();
const testUrl = (() => {
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = '/' + TEST_DB;
  return u.toString();
})();

// Point every module at the scratch DB and a known admin hash BEFORE requiring.
process.env.DATABASE_URL = testUrl;
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 4);
process.env.SESSION_TTL_HOURS = '12';
delete process.env.GMAIL_USER;
delete process.env.GMAIL_APP_PASSWORD;

const db = require('../db');
const { runMigrations } = require('../migrate');
const { createApp } = require('../app');
const email = require('../email');
const { hashToken } = require('../auth');

// ── infrastructure helpers ──────────────────────────────────────────────────

const servers = [];
function serve(app) {
  const s = app.listen(0);
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}

async function api(base, path, { method = 'GET', token, body, contentType } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = contentType || 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : null;
  return { status: res.status, data, res };
}

async function loginAt(base, password = ADMIN_PASSWORD) {
  const r = await api(base, '/api/login', { method: 'POST', body: { password } });
  return r;
}

let sentMessages = [];
function stubEmailOk() {
  sentMessages = [];
  email.setTransport({
    sendMail: async (msg) => {
      sentMessages.push(msg);
      return { messageId: 'stub' };
    },
  });
}
function stubEmailFail() {
  email.setTransport({
    sendMail: async () => {
      throw new Error('stub transport failure');
    },
  });
}

function validReceipt(overrides = {}) {
  return {
    issue_date: '2026-08-25',
    student_name: 'Test Student',
    parent_name: 'Test Parent',
    parent_email: 'parent@example.com',
    teacher_name: 'Test Teacher',
    amount: 150,
    currency: 'AUD',
    payment_method: 'bank_transfer',
    payment_reference: 'TXN-1',
    fee_description: 'August tuition fees',
    ...overrides,
  };
}

async function counterValue() {
  const { rows } = await db.pool.query('SELECT last_number FROM receipt_counter WHERE id = 1');
  return rows[0].last_number;
}

// One database lifetime for the whole file; tests assert relative sequencing.
beforeAll(async () => {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  const setup = new Pool({ connectionString: testUrl });
  await runMigrations(setup);
  await setup.end();
});

afterAll(async () => {
  for (const s of servers) s.close();
  await db.pool.end().catch(() => {});
});

// ── auth ────────────────────────────────────────────────────────────────────

describe('auth — blocked', () => {
  let base;
  beforeAll(() => {
    base = serve(createApp());
  });

  it('no token → 401 on every /api route except login/health', async () => {
    for (const [method, path] of [
      ['GET', '/api/receipts'],
      ['POST', '/api/receipts'],
      ['GET', '/api/receipts/1'],
      ['GET', '/api/receipts/1/pdf'],
      ['GET', '/api/receipts/export.csv'],
      ['POST', '/api/receipts/1/void'],
      ['POST', '/api/receipts/1/send-email'],
      ['POST', '/api/logout'],
    ]) {
      const r = await api(base, path, { method });
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(r.data).toEqual({ error: 'unauthorized' });
    }
  });

  it('health stays open', async () => {
    const r = await api(base, '/health');
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
  });

  it('malformed token → 401', async () => {
    const r = await api(base, '/api/receipts', { token: 'not-a-real-token' });
    expect(r.status).toBe(401);
  });

  it('expired session → 401', async () => {
    const token = 'a'.repeat(64);
    await db.pool.query(
      "INSERT INTO sessions (token_hash, expires_at) VALUES ($1, now() - interval '1 minute')",
      [hashToken(token)]
    );
    const r = await api(base, '/api/receipts', { token });
    expect(r.status).toBe(401);
  });

  it('wrong password → 401 invalid_credentials', async () => {
    const r = await loginAt(base, 'wrong-password');
    expect(r.status).toBe(401);
    expect(r.data).toEqual({ error: 'invalid_credentials' });
  });

  it('login with ADMIN_PASSWORD_HASH unset → same 401', async () => {
    const saved = process.env.ADMIN_PASSWORD_HASH;
    delete process.env.ADMIN_PASSWORD_HASH;
    try {
      const r = await loginAt(base, ADMIN_PASSWORD);
      expect(r.status).toBe(401);
      expect(r.data).toEqual({ error: 'invalid_credentials' });
    } finally {
      process.env.ADMIN_PASSWORD_HASH = saved;
    }
  });
});

describe('auth — legitimate', () => {
  let base;
  beforeAll(() => {
    base = serve(createApp());
  });

  it('correct password → token that works; logout kills it', async () => {
    const login = await loginAt(base);
    expect(login.status).toBe(200);
    expect(login.data.token).toMatch(/^[a-f0-9]{64}$/);
    expect(login.data.expires_at).toBeTruthy();

    const ok = await api(base, '/api/receipts', { token: login.data.token });
    expect(ok.status).toBe(200);

    const out = await api(base, '/api/logout', { method: 'POST', token: login.data.token });
    expect(out.status).toBe(204);

    const after = await api(base, '/api/receipts', { token: login.data.token });
    expect(after.status).toBe(401);
  });
});

describe('auth — login rate limit', () => {
  it('11th attempt within the window → 429', async () => {
    const base = serve(createApp()); // fresh app = fresh limiter
    for (let i = 0; i < 10; i++) {
      const r = await loginAt(base, 'wrong-password');
      expect(r.status).toBe(401);
    }
    const r = await loginAt(base, 'wrong-password');
    expect(r.status).toBe(429);
    expect(r.data).toEqual({ error: 'rate_limited' });
  });
});

// ── counter hardening (migration 002) ───────────────────────────────────────

describe('counter hardening', () => {
  it('manual +5 jump → rejected', async () => {
    await expect(
      db.pool.query('UPDATE receipt_counter SET last_number = last_number + 5 WHERE id = 1')
    ).rejects.toThrow(/exactly 1/);
  });

  it('normal +1 allocation still works', async () => {
    const client = await db.pool.connect();
    try {
      const row = await db.allocateReceiptNumberAndInsert(client, {
        ...validReceipt(),
        gst_treatment: null,
      });
      expect(row.invoice_number).toBe('RCPT-000001');
    } finally {
      client.release();
    }
    expect(await counterValue()).toBe(1);
  });

  it('every migration applied exactly once; re-run is a no-op', async () => {
    const { rows } = await db.pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
    expect(rows.map((r) => r.filename)).toEqual([
      '001_init.sql',
      '002_harden_counter.sql',
      '003_sessions.sql',
      '004_invoices.sql',
      '005_receipt_invoice_link.sql',
      '006_harden_receipt_counter.sql',
    ]);
    const applied = await runMigrations(db.pool);
    expect(applied).toEqual([]);
  });
});

// ── receipt creation ────────────────────────────────────────────────────────

describe('creation — legitimate', () => {
  let base;
  let token;
  beforeAll(async () => {
    base = serve(createApp());
    token = (await loginAt(base)).data.token;
    stubEmailOk();
  });

  it('valid POST → 201, sequential number, PDF stored, email sent with exact bytes', async () => {
    const before = await counterValue();
    const r = await api(base, '/api/receipts', {
      method: 'POST',
      token,
      body: validReceipt({ student_name: 'Creation Test' }),
    });
    expect(r.status).toBe(201);
    expect(r.data.emailed).toBe(true);
    const receipt = r.data.receipt;
    expect(receipt.invoice_number).toBe('RCPT-' + String(before + 1).padStart(6, '0'));
    expect(receipt.pdf_bytes).toBeUndefined();
    expect(receipt.email_sent_at).toBeTruthy();
    expect(receipt.status).toBe('issued');
    expect(receipt.gst_treatment).toBeNull();

    // exactly one message, right address, attachment = stored bytes
    expect(sentMessages).toHaveLength(1);
    const msg = sentMessages[0];
    expect(msg.to).toBe('parent@example.com');
    expect(msg.subject).toBe(`Fee Receipt ${receipt.invoice_number} — Mathemajics`);
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0].filename).toBe(`${receipt.invoice_number}.pdf`);

    const pdfRes = await fetch(`${base}/api/receipts/${receipt.id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get('content-type')).toContain('application/pdf');
    const stored = Buffer.from(await pdfRes.arrayBuffer());
    expect(stored.length).toBeGreaterThan(500);
    expect(stored.subarray(0, 4).toString()).toBe('%PDF');
    expect(Buffer.compare(stored, msg.attachments[0].content)).toBe(0);
  });

  it('unconfigured real transport (no Gmail env) → 201, emailed false, receipt recorded', async () => {
    email.setTransport(null); // back to env-built transport; Gmail vars are unset
    const r = await api(base, '/api/receipts', {
      method: 'POST',
      token,
      body: validReceipt({ student_name: 'No Transport' }),
    });
    expect(r.status).toBe(201);
    expect(r.data.emailed).toBe(false);
    expect(r.data.email_error).toBe('send_failed');
    expect(r.data.receipt.email_sent_at).toBeNull();
    stubEmailOk();
  });
});

describe('creation — blocked (validation)', () => {
  let base;
  let token;
  let counterBefore;
  beforeAll(async () => {
    base = serve(createApp());
    token = (await loginAt(base)).data.token;
    stubEmailOk();
    counterBefore = await counterValue();
  });

  const post = (body, opts = {}) =>
    api(base, '/api/receipts', { method: 'POST', token, body, ...opts });

  const cases = [
    ['bad currency', validReceipt({ currency: 'EUR' }), 'currency'],
    ['negative amount', validReceipt({ amount: -5 }), 'amount'],
    ['zero amount', validReceipt({ amount: 0 }), 'amount'],
    ['3-decimal amount', validReceipt({ amount: 10.005 }), 'amount'],
    ['amount too large', validReceipt({ amount: 1000001 }), 'amount'],
    ['amount as string', validReceipt({ amount: '150' }), 'amount'],
    ['future issue_date', validReceipt({ issue_date: '2030-01-01' }), 'issue_date'],
    ['pre-2020 issue_date', validReceipt({ issue_date: '2019-12-31' }), 'issue_date'],
    ['garbage issue_date', validReceipt({ issue_date: '2026-13-40' }), 'issue_date'],
    ['multi-recipient email (comma)', validReceipt({ parent_email: 'a@b.com,c@d.com' }), 'parent_email'],
    ['email with newline', validReceipt({ parent_email: 'a@b.com\nBcc: x@y.com' }), 'parent_email'],
    ['bad payment method', validReceipt({ payment_method: 'cash' }), 'payment_method'],
    ['missing student_name', validReceipt({ student_name: '   ' }), 'student_name'],
    ['oversized fee_description', validReceipt({ fee_description: 'x'.repeat(501) }), 'fee_description'],
    ['unknown extra field', validReceipt({ hax: true }), 'hax'],
    ['gst_treatment supplied', validReceipt({ gst_treatment: 'export' }), 'gst_treatment'],
  ];

  for (const [name, body, field] of cases) {
    it(`${name} → 400 naming ${field}`, async () => {
      const r = await post(body);
      expect(r.status).toBe(400);
      expect(r.data.error).toBe('validation_failed');
      expect(r.data.fields.map((f) => f.field)).toContain(field);
    });
  }

  it('oversized body → 413', async () => {
    const r = await post(validReceipt({ fee_description: 'x'.repeat(200000) }));
    expect(r.status).toBe(413);
  });

  it('non-JSON body → 400', async () => {
    const r = await post('student_name=Test', { contentType: 'text/plain' });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe('json_required');
  });

  it('no numbers were burned by any rejected request', async () => {
    expect(await counterValue()).toBe(counterBefore);
  });
});

// ── email failure and retry ─────────────────────────────────────────────────

describe('email failure path + retry', () => {
  let base;
  let token;
  let failedReceipt;
  beforeAll(async () => {
    base = serve(createApp());
    token = (await loginAt(base)).data.token;
  });

  it('send failure → 201, receipt exists, email_sent_at NULL, emailed false', async () => {
    stubEmailFail();
    const r = await api(base, '/api/receipts', {
      method: 'POST',
      token,
      body: validReceipt({ student_name: 'Email Fail' }),
    });
    expect(r.status).toBe(201);
    expect(r.data.emailed).toBe(false);
    expect(r.data.email_error).toBe('send_failed');
    failedReceipt = r.data.receipt;
    expect(failedReceipt.email_sent_at).toBeNull();
  });

  it('retry sends the SAME stored bytes and sets email_sent_at', async () => {
    stubEmailOk();
    const pdfRes = await fetch(`${base}/api/receipts/${failedReceipt.id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const storedBefore = Buffer.from(await pdfRes.arrayBuffer());

    const r = await api(base, `/api/receipts/${failedReceipt.id}/send-email`, {
      method: 'POST',
      token,
    });
    expect(r.status).toBe(200);
    expect(r.data.emailed).toBe(true);
    expect(r.data.receipt.email_sent_at).toBeTruthy();
    expect(sentMessages).toHaveLength(1);
    expect(Buffer.compare(storedBefore, sentMessages[0].attachments[0].content)).toBe(0);
  });

  it('second retry → 409 already_sent', async () => {
    const r = await api(base, `/api/receipts/${failedReceipt.id}/send-email`, {
      method: 'POST',
      token,
    });
    expect(r.status).toBe(409);
    expect(r.data).toEqual({ error: 'already_sent' });
  });

  it('retry on nonexistent receipt → 404', async () => {
    const r = await api(base, '/api/receipts/999999/send-email', { method: 'POST', token });
    expect(r.status).toBe(404);
  });
});

// ── void ────────────────────────────────────────────────────────────────────

describe('void', () => {
  let base;
  let token;
  let receipt;
  beforeAll(async () => {
    base = serve(createApp());
    token = (await loginAt(base)).data.token;
    stubEmailFail(); // leave email_sent_at NULL so retry-on-voided can be tested
    const r = await api(base, '/api/receipts', {
      method: 'POST',
      token,
      body: validReceipt({ student_name: 'Void Target', amount: 333.33 }),
    });
    receipt = r.data.receipt;
  });

  it('void with empty reason → 400', async () => {
    const r = await api(base, `/api/receipts/${receipt.id}/void`, {
      method: 'POST',
      token,
      body: { reason: '   ' },
    });
    expect(r.status).toBe(400);
  });

  it('legitimate void works; financial fields unchanged', async () => {
    const r = await api(base, `/api/receipts/${receipt.id}/void`, {
      method: 'POST',
      token,
      body: { reason: 'entered twice by mistake' },
    });
    expect(r.status).toBe(200);
    expect(r.data.receipt.status).toBe('voided');
    expect(r.data.receipt.void_reason).toBe('entered twice by mistake');
    expect(r.data.receipt.voided_at).toBeTruthy();
    expect(r.data.receipt.amount).toBe(receipt.amount);
    expect(r.data.receipt.invoice_number).toBe(receipt.invoice_number);
    expect(r.data.receipt.parent_email).toBe(receipt.parent_email);
  });

  it('double void → 409', async () => {
    const r = await api(base, `/api/receipts/${receipt.id}/void`, {
      method: 'POST',
      token,
      body: { reason: 'again' },
    });
    expect(r.status).toBe(409);
  });

  it('retry-email on voided → 409 voided', async () => {
    const r = await api(base, `/api/receipts/${receipt.id}/send-email`, {
      method: 'POST',
      token,
    });
    expect(r.status).toBe(409);
    expect(r.data).toEqual({ error: 'voided' });
  });

  it('void on nonexistent receipt → 404', async () => {
    const r = await api(base, '/api/receipts/999999/void', {
      method: 'POST',
      token,
      body: { reason: 'whatever' },
    });
    expect(r.status).toBe(404);
  });
});

// ── reads ───────────────────────────────────────────────────────────────────

describe('reads', () => {
  let base;
  let token;
  beforeAll(async () => {
    base = serve(createApp());
    token = (await loginAt(base)).data.token;
    stubEmailOk();
    for (const s of ["O'Brien Search", 'Percent_Test', 'PercentXTest']) {
      const r = await api(base, '/api/receipts', {
        method: 'POST',
        token,
        body: validReceipt({ student_name: s }),
      });
      expect(r.status).toBe(201);
    }
  });

  it('list: newest first, excludes pdf_bytes, includes status/email_sent_at', async () => {
    const r = await api(base, '/api/receipts', { token });
    expect(r.status).toBe(200);
    const list = r.data.receipts;
    expect(list.length).toBeGreaterThan(3);
    for (let i = 1; i < list.length; i++) expect(list[i - 1].id).toBeGreaterThan(list[i].id);
    for (const row of list) {
      expect(row.pdf_bytes).toBeUndefined();
      expect(row.status).toBeDefined();
      expect('email_sent_at' in row).toBe(true);
    }
  });

  it('pagination limit/offset work; limit capped at 100', async () => {
    const one = await api(base, '/api/receipts?limit=1', { token });
    expect(one.data.receipts).toHaveLength(1);
    const two = await api(base, '/api/receipts?limit=1&offset=1', { token });
    expect(two.data.receipts).toHaveLength(1);
    expect(two.data.receipts[0].id).toBeLessThan(one.data.receipts[0].id);
    const capped = await api(base, '/api/receipts?limit=5000', { token });
    expect(capped.data.limit).toBe(100);
  });

  it("student filter is parameterized-safe with quotes and literal with % and _", async () => {
    const quote = await api(base, `/api/receipts?student=${encodeURIComponent("O'Brien")}`, { token });
    expect(quote.status).toBe(200);
    expect(quote.data.receipts).toHaveLength(1);
    expect(quote.data.receipts[0].student_name).toBe("O'Brien Search");

    // '_' must match literally: only Percent_Test, not PercentXTest.
    const underscore = await api(base, `/api/receipts?student=${encodeURIComponent('Percent_')}`, { token });
    expect(underscore.data.receipts).toHaveLength(1);
    expect(underscore.data.receipts[0].student_name).toBe('Percent_Test');

    const percent = await api(base, `/api/receipts?student=${encodeURIComponent('100%')}`, { token });
    expect(percent.data.receipts).toHaveLength(0);
  });

  it('status and date filters', async () => {
    const voided = await api(base, '/api/receipts?status=voided', { token });
    expect(voided.data.receipts.every((r) => r.status === 'voided')).toBe(true);
    expect(voided.data.receipts.length).toBeGreaterThan(0);
    const none = await api(base, '/api/receipts?from=2031-01-01', { token });
    expect(none.data.receipts).toHaveLength(0);
    const bad = await api(base, '/api/receipts?status=deleted', { token });
    expect(bad.status).toBe(400);
  });

  it('single receipt: no pdf_bytes; missing id → 404', async () => {
    const list = await api(base, '/api/receipts?limit=1', { token });
    const id = list.data.receipts[0].id;
    const one = await api(base, `/api/receipts/${id}`, { token });
    expect(one.status).toBe(200);
    expect(one.data.receipt.pdf_bytes).toBeUndefined();
    expect((await api(base, '/api/receipts/999999', { token })).status).toBe(404);
    expect((await api(base, '/api/receipts/abc', { token })).status).toBe(404);
  });

  it('pdf endpoint 404 when pdf_bytes is NULL', async () => {
    const client = await db.pool.connect();
    let row;
    try {
      row = await db.allocateReceiptNumberAndInsert(client, {
        ...validReceipt({ student_name: 'No Pdf Row' }),
        gst_treatment: null,
      });
    } finally {
      client.release();
    }
    const r = await api(base, `/api/receipts/${row.id}/pdf`, { token });
    expect(r.status).toBe(404);
  });
});

// ── CSV export ──────────────────────────────────────────────────────────────

describe('CSV export', () => {
  let base;
  let token;
  beforeAll(async () => {
    base = serve(createApp());
    token = (await loginAt(base)).data.token;
    stubEmailOk();
    for (const body of [
      validReceipt({ student_name: '=SUM(A1:A9)' }),
      validReceipt({ student_name: '+61 payment' }),
      validReceipt({
        student_name: 'Comma, Newline',
        fee_description: 'Line one\nLine "two", with comma',
      }),
    ]) {
      const r = await api(base, '/api/receipts', { method: 'POST', token, body });
      expect(r.status).toBe(201);
    }
  });

  it('contains all rows, formula-safe, RFC-4180 quoted', async () => {
    const res = await fetch(`${base}/api/receipts/export.csv`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(/receipts-export-\d{4}-\d{2}-\d{2}\.csv/);
    const text = await res.text();

    const total = await counterValue();
    // header + one line per receipt (embedded newlines live inside quoted cells)
    const dataRowCount = (text.match(/RCPT-\d{6}/g) || []).length;
    expect(dataRowCount).toBe(total);

    expect(text).toContain("'=SUM(A1:A9)");
    expect(text).toContain("'+61 payment");
    expect(text).toContain('"Comma, Newline"');
    expect(text).toContain('"Line one\nLine ""two"", with comma"');
  });
});
