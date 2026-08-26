// Session 2c self-tests — invoices: numbering, immutability, line items and
// totals, FX block, receipt<->invoice linkage, PDF/email, CSV, auth.
// Runs against real Postgres on its own scratch database; email is ALWAYS the
// injected stub transport — never real SMTP.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const { Client, Pool } = require('pg');
const bcrypt = require('bcrypt');
const zlib = require('zlib');

const TEST_DB = 'receipts_test_invoices';
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

// ── infrastructure helpers ──────────────────────────────────────────────────

const servers = [];
function serve(app) {
  const s = app.listen(0);
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}

async function api(base, path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(base + path, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : null;
  return { status: res.status, data, res };
}

async function tokenFor(base) {
  const r = await api(base, '/api/login', { method: 'POST', body: { password: ADMIN_PASSWORD } });
  return r.data.token;
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

// Pull readable text out of a pdfkit PDF: inflate the content streams, then
// decode the hex strings inside each BT/ET text block.
function pdfText(buf) {
  const s = buf.toString('latin1');
  let content = '';
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    // Skip image XObjects: they inflate to raw pixel data, and scanning that
    // for words like 'ABN' is a false positive waiting to happen.
    const objStart = s.lastIndexOf(' obj', m.index);
    if (objStart >= 0 && s.slice(objStart, m.index).includes('/Image')) continue;
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) continue;
    const raw = Buffer.from(s.slice(start, end), 'latin1');
    try {
      content += zlib.inflateSync(raw).toString('latin1') + '\n';
    } catch {
      // not a flate stream (e.g. font data) — ignore
    }
  }
  return content
    .split(/\bBT\b/)
    .slice(1)
    .map((block) => {
      const seg = block.split(/\bET\b/)[0];
      let out = '';
      const hex = /<([0-9A-Fa-f]+)>/g;
      let h;
      while ((h = hex.exec(seg))) out += Buffer.from(h[1], 'hex').toString('latin1');
      return out;
    })
    .join('\n');
}

// ── fixtures ────────────────────────────────────────────────────────────────

function validInvoice(overrides = {}) {
  return {
    issue_date: '2026-08-25',
    due_date: '2026-09-25',
    student_name: 'Test Student',
    parent_name: 'Test Parent',
    parent_email: 'parent@example.com',
    teacher_name: 'Test Teacher',
    line_items: [{ description: 'August tuition', qty: 4, rate: 60, amount: 240 }],
    subtotal: 240,
    total: 240,
    currency: 'AUD',
    ...overrides,
  };
}

// Row-level fixture for the allocator (already-validated shape).
function invoiceRow(overrides = {}) {
  return {
    issue_date: '2026-08-25',
    due_date: '2026-09-25',
    student_name: 'Row Student',
    parent_name: 'Row Parent',
    parent_email: 'row@example.com',
    teacher_name: 'Row Teacher',
    line_items: [{ description: 'Tuition', qty: 1, rate: 100, amount: 100 }],
    subtotal: 100,
    discount_label: null,
    discount_amount: null,
    total: 100,
    currency: 'AUD',
    fx_rate: null,
    fx_source: null,
    fx_date: null,
    fx_mode: null,
    inr_amount: null,
    notes: null,
    ...overrides,
  };
}

function validReceipt(overrides = {}) {
  return {
    issue_date: '2026-08-25',
    student_name: 'Test Student',
    parent_name: 'Test Parent',
    parent_email: 'parent@example.com',
    teacher_name: 'Test Teacher',
    amount: 240,
    currency: 'AUD',
    payment_method: 'bank_transfer',
    payment_reference: 'TXN-1',
    fee_description: 'August tuition fees',
    ...overrides,
  };
}

async function insertInvoiceRow(overrides = {}) {
  const client = await db.pool.connect();
  try {
    return await db.allocateInvoiceNumberAndInsert(client, invoiceRow(overrides));
  } finally {
    client.release();
  }
}

async function invoiceCounter() {
  const { rows } = await db.pool.query('SELECT last_number FROM invoice_counter WHERE id = 1');
  return rows[0].last_number;
}
async function receiptCounter() {
  const { rows } = await db.pool.query('SELECT last_number FROM receipt_counter WHERE id = 1');
  return rows[0].last_number;
}

let base;
let token;

beforeAll(async () => {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  const setup = new Pool({ connectionString: testUrl });
  await runMigrations(setup);
  await setup.end();

  base = serve(createApp());
  token = await tokenFor(base);
  stubEmailOk();
});

afterAll(async () => {
  for (const s of servers) s.close();
  await db.pool.end().catch(() => {});
});

// ── auth ────────────────────────────────────────────────────────────────────

describe('auth — blocked', () => {
  it('every /api/invoices route returns 401 without a valid token', async () => {
    for (const [method, path] of [
      ['GET', '/api/invoices'],
      ['POST', '/api/invoices'],
      ['GET', '/api/invoices/1'],
      ['GET', '/api/invoices/1/pdf'],
      ['GET', '/api/invoices/export.csv'],
      ['POST', '/api/invoices/1/void'],
      ['POST', '/api/invoices/1/send-email'],
    ]) {
      const r = await api(base, path, { method });
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(r.data).toEqual({ error: 'unauthorized' });
    }
  });

  it('malformed token → 401', async () => {
    const r = await api(base, '/api/invoices', { token: 'not-a-real-token' });
    expect(r.status).toBe(401);
  });
});

// ── numbering ───────────────────────────────────────────────────────────────

describe('numbering — legitimate', () => {
  it('three invoices → INV-000001/2/3', async () => {
    const a = await insertInvoiceRow();
    const b = await insertInvoiceRow();
    const c = await insertInvoiceRow();
    expect([a.invoice_number, b.invoice_number, c.invoice_number]).toEqual([
      'INV-000001',
      'INV-000002',
      'INV-000003',
    ]);
    expect(await invoiceCounter()).toBe(3);
  });

  it('20 parallel creations → 20 unique consecutive numbers, no gaps', async () => {
    const before = await invoiceCounter();
    const pool = new Pool({ connectionString: testUrl, max: 20 });
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, async (_, i) => {
          const client = await pool.connect();
          try {
            return await db.allocateInvoiceNumberAndInsert(
              client,
              invoiceRow({ student_name: `Parallel ${i}` })
            );
          } finally {
            client.release();
          }
        })
      );
      const numbers = results.map((r) => r.invoice_number).sort();
      expect(new Set(numbers).size).toBe(20);
      const expected = Array.from({ length: 20 }, (_, i) =>
        'INV-' + String(before + i + 1).padStart(6, '0')
      ).sort();
      expect(numbers).toEqual(expected);
      expect(await invoiceCounter()).toBe(before + 20);
    } finally {
      await pool.end();
    }
  });

  it('receipt and invoice counters advance independently', async () => {
    const invBefore = await invoiceCounter();
    const rcptBefore = await receiptCounter();

    const inv = await api(base, '/api/invoices', {
      method: 'POST', token, body: validInvoice({ student_name: 'Counter Check' }),
    });
    expect(inv.status).toBe(201);
    expect(await receiptCounter()).toBe(rcptBefore);
    expect(await invoiceCounter()).toBe(invBefore + 1);

    const rcpt = await api(base, '/api/receipts', {
      method: 'POST', token, body: validReceipt({ student_name: 'Counter Check' }),
    });
    expect(rcpt.status).toBe(201);
    expect(await invoiceCounter()).toBe(invBefore + 1);
    expect(await receiptCounter()).toBe(rcptBefore + 1);
  });
});

describe('numbering — blocked', () => {
  it('a validation-failing request burns no number', async () => {
    const before = await invoiceCounter();
    const r = await api(base, '/api/invoices', {
      method: 'POST', token, body: validInvoice({ student_name: '   ' }),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe('validation_failed');
    expect(await invoiceCounter()).toBe(before);
  });

  it('manual +5 on invoice_counter → rejected', async () => {
    await expect(
      db.pool.query('UPDATE invoice_counter SET last_number = last_number + 5 WHERE id = 1')
    ).rejects.toThrow(/increment by exactly 1/);
  });

  it('deleting or truncating invoice_counter → rejected', async () => {
    await expect(db.pool.query('DELETE FROM invoice_counter')).rejects.toThrow(/never be deleted/);
    await expect(db.pool.query('TRUNCATE invoice_counter')).rejects.toThrow(/never be deleted/);
  });
});

// ── immutability ────────────────────────────────────────────────────────────

describe('immutability — blocked direction', () => {
  it('UPDATE of frozen columns → rejected', async () => {
    const inv = await insertInvoiceRow({
      fx_rate: 55.5, fx_source: 'ECB reference rate', fx_date: '2026-08-25',
      fx_mode: 'indicative', inr_amount: 5550,
    });
    const cases = [
      ['total', `UPDATE invoices SET total = 999 WHERE id = $1`],
      ['line_items', `UPDATE invoices SET line_items = '[]'::jsonb WHERE id = $1`],
      ['fx_rate', `UPDATE invoices SET fx_rate = 1.5 WHERE id = $1`],
      ['parent_email', `UPDATE invoices SET parent_email = 'other@example.com' WHERE id = $1`],
      ['invoice_number', `UPDATE invoices SET invoice_number = 'INV-999999' WHERE id = $1`],
      ['subtotal', `UPDATE invoices SET subtotal = 1 WHERE id = $1`],
      ['due_date', `UPDATE invoices SET due_date = '2027-01-01' WHERE id = $1`],
      ['notes', `UPDATE invoices SET notes = 'edited' WHERE id = $1`],
    ];
    for (const [label, sql] of cases) {
      await expect(db.pool.query(sql, [inv.id]), label).rejects.toThrow(/immutable/);
    }
  });

  it('DELETE and TRUNCATE → rejected', async () => {
    const inv = await insertInvoiceRow();
    await expect(db.pool.query('DELETE FROM invoices WHERE id = $1', [inv.id]))
      .rejects.toThrow(/immutable/);

    // Two independent layers stop a truncate: the receipts FK refuses it first,
    // and the trigger refuses it even once the FK is satisfied by truncating both.
    await expect(db.pool.query('TRUNCATE invoices'))
      .rejects.toThrow(/foreign key constraint/);
    await expect(db.pool.query('TRUNCATE invoices, receipts'))
      .rejects.toThrow(/truncate is not allowed/);
  });

  it('void smuggling a total change in the same statement → rejected', async () => {
    const inv = await insertInvoiceRow();
    await expect(
      db.pool.query(
        `UPDATE invoices SET status = 'voided', void_reason = 'x', voided_at = now(), total = 1
          WHERE id = $1`,
        [inv.id]
      )
    ).rejects.toThrow(/immutable/);
  });

  it('one-time pdf attach and email timestamp cannot be overwritten', async () => {
    const inv = await insertInvoiceRow();
    await db.pool.query('UPDATE invoices SET pdf_bytes = $1 WHERE id = $2', [
      Buffer.from('%PDF-first'), inv.id,
    ]);
    await expect(
      db.pool.query('UPDATE invoices SET pdf_bytes = $1 WHERE id = $2', [
        Buffer.from('%PDF-second'), inv.id,
      ])
    ).rejects.toThrow(/immutable/);

    await db.pool.query('UPDATE invoices SET email_sent_at = now() WHERE id = $1', [inv.id]);
    await expect(
      db.pool.query('UPDATE invoices SET email_sent_at = now() WHERE id = $1', [inv.id])
    ).rejects.toThrow(/immutable/);
  });

  it('UPDATE receipts.invoice_id after insert → rejected', async () => {
    const inv = await insertInvoiceRow();
    const r = await api(base, '/api/receipts', {
      method: 'POST', token, body: validReceipt({ student_name: 'Frozen Link' }),
    });
    expect(r.status).toBe(201);
    expect(r.data.receipt.invoice_id).toBe(null);
    await expect(
      db.pool.query('UPDATE receipts SET invoice_id = $1 WHERE id = $2', [inv.id, r.data.receipt.id])
    ).rejects.toThrow(/immutable/);
  });
});

describe('immutability — legitimate direction', () => {
  it('a proper void succeeds and leaves financial fields intact', async () => {
    const inv = await insertInvoiceRow({ student_name: 'Void Me' });
    await db.pool.query(
      `UPDATE invoices SET status = 'voided', void_reason = 'issued in error', voided_at = now()
        WHERE id = $1`,
      [inv.id]
    );
    const { rows } = await db.pool.query('SELECT * FROM invoices WHERE id = $1', [inv.id]);
    expect(rows[0].status).toBe('voided');
    expect(rows[0].void_reason).toBe('issued in error');
    expect(rows[0].voided_at).not.toBe(null);
    expect(Number(rows[0].total)).toBe(100);
    expect(rows[0].invoice_number).toBe(inv.invoice_number);
    expect(rows[0].line_items).toEqual(invoiceRow().line_items);
  });

  it('double void through the API → 409', async () => {
    const created = await api(base, '/api/invoices', {
      method: 'POST', token, body: validInvoice({ student_name: 'Double Void' }),
    });
    const id = created.data.invoice.id;
    const first = await api(base, `/api/invoices/${id}/void`, {
      method: 'POST', token, body: { reason: 'duplicate' },
    });
    expect(first.status).toBe(200);
    expect(first.data.invoice.status).toBe('voided');
    const second = await api(base, `/api/invoices/${id}/void`, {
      method: 'POST', token, body: { reason: 'duplicate' },
    });
    expect(second.status).toBe(409);
    expect(second.data).toEqual({ error: 'already_voided' });
  });
});

// ── line items & totals ─────────────────────────────────────────────────────

describe('line items & totals — blocked', () => {
  const bad = [
    ['amount does not equal qty x rate', validInvoice({
      line_items: [{ description: 'Tuition', qty: 4, rate: 60, amount: 200 }],
      subtotal: 200, total: 200,
    })],
    ['client subtotal disagrees with the server sum', validInvoice({ subtotal: 300, total: 300 })],
    ['client total disagrees with subtotal minus discount', validInvoice({
      discount_label: 'Sibling', discount_amount: 40, total: 240,
    })],
    ['discount equal to subtotal', validInvoice({
      discount_label: 'All of it', discount_amount: 240, total: 0,
    })],
    ['discount larger than subtotal', validInvoice({
      discount_label: 'Too much', discount_amount: 500, total: -260,
    })],
    ['discount without a label', validInvoice({ discount_amount: 40, total: 200 })],
    ['zero line items', validInvoice({ line_items: [], subtotal: 0, total: 0 })],
    ['21 line items', validInvoice({
      line_items: Array.from({ length: 21 }, () => ({
        description: 'Session', qty: 1, rate: 10, amount: 10,
      })),
      subtotal: 210, total: 210,
    })],
    ['negative qty', validInvoice({
      line_items: [{ description: 'Tuition', qty: -1, rate: 60, amount: -60 }],
      subtotal: -60, total: -60,
    })],
    ['three-decimal rate', validInvoice({
      line_items: [{ description: 'Tuition', qty: 1, rate: 60.123, amount: 60.12 }],
      subtotal: 60.12, total: 60.12,
    })],
    ['unknown field on a line item', validInvoice({
      line_items: [{ description: 'Tuition', qty: 4, rate: 60, amount: 240, tax: 10 }],
    })],
    ['unknown top-level field', validInvoice({ tax_percent: 10 })],
    ['tax field rejected outright', validInvoice({ gst_treatment: 'taxable' })],
    ['due_date before issue_date', validInvoice({ due_date: '2026-08-01' })],
    ['due_date more than 365 days ahead', validInvoice({ due_date: '2027-09-25' })],
  ];

  for (const [label, body] of bad) {
    it(`${label} → 400`, async () => {
      const before = await invoiceCounter();
      const r = await api(base, '/api/invoices', { method: 'POST', token, body });
      expect(r.status).toBe(400);
      expect(r.data.error).toBe('validation_failed');
      expect(await invoiceCounter()).toBe(before);
    });
  }
});

describe('line items & totals — legitimate', () => {
  it('multi-line invoice with a discount stores server-verified figures', async () => {
    const body = validInvoice({
      student_name: 'Discount Student',
      line_items: [
        { description: 'August tuition', qty: 4, rate: 60, amount: 240 },
        { description: 'Practice pack', qty: 2, rate: 12.5, amount: 25 },
      ],
      subtotal: 265,
      discount_label: 'Sibling discount',
      discount_amount: 15,
      total: 250,
    });
    const r = await api(base, '/api/invoices', { method: 'POST', token, body });
    expect(r.status).toBe(201);
    const inv = r.data.invoice;
    expect(Number(inv.subtotal)).toBe(265);
    expect(Number(inv.discount_amount)).toBe(15);
    expect(Number(inv.total)).toBe(250);
    expect(inv.discount_label).toBe('Sibling discount');
    expect(inv.line_items).toHaveLength(2);
    expect(inv.line_items[1]).toEqual({
      description: 'Practice pack', qty: 2, rate: 12.5, amount: 25,
    });
    expect(inv.pdf_bytes).toBeUndefined();
    expect(inv.paid).toBe(false);
    expect(inv.receipt_number).toBe(null);
  });
});

// ── FX ──────────────────────────────────────────────────────────────────────

describe('FX', () => {
  it('a complete block is accepted and stored', async () => {
    const r = await api(base, '/api/invoices', {
      method: 'POST', token,
      body: validInvoice({
        student_name: 'FX Student',
        fx_rate: 55.25, fx_source: 'ECB reference rate', fx_date: '2026-08-25',
        fx_mode: 'payable', inr_amount: 13260,
      }),
    });
    expect(r.status).toBe(201);
    const inv = r.data.invoice;
    expect(Number(inv.fx_rate)).toBe(55.25);
    expect(inv.fx_source).toBe('ECB reference rate');
    expect(inv.fx_mode).toBe('payable');
    expect(Number(inv.inr_amount)).toBe(13260);
  });

  it('an invoice with no FX succeeds with all five columns NULL', async () => {
    const r = await api(base, '/api/invoices', {
      method: 'POST', token, body: validInvoice({ student_name: 'No FX' }),
    });
    expect(r.status).toBe(201);
    for (const f of ['fx_rate', 'fx_source', 'fx_date', 'fx_mode', 'inr_amount']) {
      expect(r.data.invoice[f], f).toBe(null);
    }
  });

  const badFx = [
    ['partial block (rate without source)', { fx_rate: 55.25 }],
    ['partial block (rate + source only)', { fx_rate: 55.25, fx_source: 'ECB reference rate' }],
    ['inr_amount inconsistent with rate x total', {
      fx_rate: 55.25, fx_source: 'ECB reference rate', fx_date: '2026-08-25',
      fx_mode: 'payable', inr_amount: 9999,
    }],
    ['future fx_date', {
      fx_rate: 55.25, fx_source: 'ECB reference rate', fx_date: '2099-01-01',
      fx_mode: 'payable', inr_amount: 13260,
    }],
    ['fx_date more than 30 days before issue_date', {
      fx_rate: 55.25, fx_source: 'ECB reference rate', fx_date: '2026-06-01',
      fx_mode: 'payable', inr_amount: 13260,
    }],
    ['invalid fx_mode', {
      fx_rate: 55.25, fx_source: 'ECB reference rate', fx_date: '2026-08-25',
      fx_mode: 'estimated', inr_amount: 13260,
    }],
    ['negative fx_rate', {
      fx_rate: -1, fx_source: 'ECB reference rate', fx_date: '2026-08-25',
      fx_mode: 'payable', inr_amount: 13260,
    }],
  ];

  for (const [label, fx] of badFx) {
    it(`${label} → 400`, async () => {
      const before = await invoiceCounter();
      const r = await api(base, '/api/invoices', {
        method: 'POST', token, body: validInvoice(fx),
      });
      expect(r.status).toBe(400);
      expect(r.data.error).toBe('validation_failed');
      expect(await invoiceCounter()).toBe(before);
    });
  }

  it('rounding within 1.00 INR of rate x total is accepted', async () => {
    const r = await api(base, '/api/invoices', {
      method: 'POST', token,
      body: validInvoice({
        student_name: 'FX Rounding',
        fx_rate: 55.25, fx_source: 'ECB reference rate', fx_date: '2026-08-25',
        fx_mode: 'indicative', inr_amount: 13260.5,
      }),
    });
    expect(r.status).toBe(201);
  });
});

// ── receipt <-> invoice linkage ─────────────────────────────────────────────

describe('linkage', () => {
  async function newInvoice(overrides = {}) {
    const r = await api(base, '/api/invoices', {
      method: 'POST', token, body: validInvoice(overrides),
    });
    expect(r.status).toBe(201);
    return r.data.invoice;
  }

  it('receipt with a valid invoice_id → 201, invoice reads back paid with the receipt number', async () => {
    const inv = await newInvoice({ student_name: 'Linked Student' });
    const r = await api(base, '/api/receipts', {
      method: 'POST', token,
      body: validReceipt({ student_name: 'Linked Student', invoice_id: inv.id }),
    });
    expect(r.status).toBe(201);
    expect(r.data.receipt.invoice_id).toBe(inv.id);

    const one = await api(base, `/api/invoices/${inv.id}`, { token });
    expect(one.data.invoice.paid).toBe(true);
    expect(one.data.invoice.receipt_number).toBe(r.data.receipt.invoice_number);

    const list = await api(base, `/api/invoices?student=Linked%20Student`, { token });
    const row = list.data.invoices.find((i) => i.id === inv.id);
    expect(row.paid).toBe(true);
    expect(row.receipt_number).toBe(r.data.receipt.invoice_number);
  });

  it('a second receipt against the same invoice → 409 invoice_already_paid, no number burned', async () => {
    const inv = await newInvoice({ student_name: 'Paid Once' });
    const first = await api(base, '/api/receipts', {
      method: 'POST', token,
      body: validReceipt({ student_name: 'Paid Once', invoice_id: inv.id }),
    });
    expect(first.status).toBe(201);

    const before = await receiptCounter();
    const second = await api(base, '/api/receipts', {
      method: 'POST', token,
      body: validReceipt({ student_name: 'Paid Once', invoice_id: inv.id }),
    });
    expect(second.status).toBe(409);
    expect(second.data).toEqual({ error: 'invoice_already_paid' });
    expect(await receiptCounter()).toBe(before);
  });

  it('receipt against a voided invoice → 409 invoice_voided', async () => {
    const inv = await newInvoice({ student_name: 'Voided Invoice' });
    const v = await api(base, `/api/invoices/${inv.id}/void`, {
      method: 'POST', token, body: { reason: 'cancelled' },
    });
    expect(v.status).toBe(200);
    const r = await api(base, '/api/receipts', {
      method: 'POST', token,
      body: validReceipt({ student_name: 'Voided Invoice', invoice_id: inv.id }),
    });
    expect(r.status).toBe(409);
    expect(r.data).toEqual({ error: 'invoice_voided' });
  });

  it('receipt against a non-existent invoice → 404 invoice_not_found', async () => {
    const r = await api(base, '/api/receipts', {
      method: 'POST', token, body: validReceipt({ invoice_id: 999999 }),
    });
    expect(r.status).toBe(404);
    expect(r.data).toEqual({ error: 'invoice_not_found' });
  });

  it('currency mismatch between receipt and invoice → 400', async () => {
    const inv = await newInvoice({ student_name: 'Currency Clash', currency: 'AUD' });
    const r = await api(base, '/api/receipts', {
      method: 'POST', token,
      body: validReceipt({ student_name: 'Currency Clash', currency: 'USD', invoice_id: inv.id }),
    });
    expect(r.status).toBe(400);
    expect(r.data).toEqual({ error: 'currency_mismatch' });
  });

  it('voiding an invoice with a live receipt → 409; after voiding the receipt it voids', async () => {
    const inv = await newInvoice({ student_name: 'Has Receipt' });
    const rcpt = await api(base, '/api/receipts', {
      method: 'POST', token,
      body: validReceipt({ student_name: 'Has Receipt', invoice_id: inv.id }),
    });
    expect(rcpt.status).toBe(201);

    const blocked = await api(base, `/api/invoices/${inv.id}/void`, {
      method: 'POST', token, body: { reason: 'raised in error' },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.data).toEqual({ error: 'invoice_has_receipt' });

    const voidReceipt = await api(base, `/api/receipts/${rcpt.data.receipt.id}/void`, {
      method: 'POST', token, body: { reason: 'payment reversed' },
    });
    expect(voidReceipt.status).toBe(200);

    const now = await api(base, `/api/invoices/${inv.id}/void`, {
      method: 'POST', token, body: { reason: 'raised in error' },
    });
    expect(now.status).toBe(200);
    expect(now.data.invoice.status).toBe('voided');
    expect(now.data.invoice.paid).toBe(false);
  });

  it('paid filter splits the list correctly', async () => {
    const paidOnly = await api(base, '/api/invoices?paid=true&limit=100', { token });
    const unpaidOnly = await api(base, '/api/invoices?paid=false&limit=100', { token });
    expect(paidOnly.data.invoices.every((i) => i.paid === true)).toBe(true);
    expect(unpaidOnly.data.invoices.every((i) => i.paid === false)).toBe(true);
    expect(paidOnly.data.invoices.length).toBeGreaterThan(0);
    expect(unpaidOnly.data.invoices.length).toBeGreaterThan(0);

    const bad = await api(base, '/api/invoices?paid=maybe', { token });
    expect(bad.status).toBe(400);
    expect(bad.data).toEqual({ error: 'invalid_paid_filter' });
  });

  it('a standalone receipt (no invoice_id) still works exactly as before', async () => {
    const r = await api(base, '/api/receipts', {
      method: 'POST', token, body: validReceipt({ student_name: 'Standalone' }),
    });
    expect(r.status).toBe(201);
    expect(r.data.emailed).toBe(true);
    expect(r.data.receipt.invoice_id).toBe(null);
    expect(r.data.receipt.invoice_number).toMatch(/^RCPT-\d{6}$/);
  });

  it('invalid invoice_id shape → 400', async () => {
    const r = await api(base, '/api/receipts', {
      method: 'POST', token, body: validReceipt({ invoice_id: 'abc' }),
    });
    expect(r.status).toBe(400);
    expect(r.data.fields).toContainEqual({ field: 'invoice_id', error: 'invalid_invoice_id' });
  });
});

// ── PDF & email ─────────────────────────────────────────────────────────────

describe('PDF & email', () => {
  it('invoice PDF: %PDF header, contains the invoice number, emailed bytes are the stored bytes', async () => {
    stubEmailOk();
    const r = await api(base, '/api/invoices', {
      method: 'POST', token,
      body: validInvoice({
        student_name: 'Pdf Student',
        notes: 'Payable by bank transfer.',
        fx_rate: 55.25, fx_source: 'ECB reference rate', fx_date: '2026-08-25',
        fx_mode: 'payable', inr_amount: 13260,
      }),
    });
    expect(r.status).toBe(201);
    expect(r.data.emailed).toBe(true);
    const inv = r.data.invoice;

    expect(sentMessages).toHaveLength(1);
    const msg = sentMessages[0];
    expect(msg.to).toBe('parent@example.com');
    expect(msg.subject).toBe(`Invoice ${inv.invoice_number} — Mathemajics`);
    expect(msg.text).toContain(inv.invoice_number);
    expect(msg.text).toContain('Pdf Student');
    expect(msg.text).toContain('AUD 240.00');
    expect(msg.text).toContain('25 Sep 2026');
    expect(msg.attachments[0].filename).toBe(`${inv.invoice_number}.pdf`);

    const pdfRes = await fetch(`${base}/api/invoices/${inv.id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get('content-type')).toContain('application/pdf');
    const stored = Buffer.from(await pdfRes.arrayBuffer());
    expect(stored.subarray(0, 4).toString()).toBe('%PDF');
    expect(Buffer.compare(stored, msg.attachments[0].content)).toBe(0);

    const text = pdfText(stored);
    expect(text).toContain(inv.invoice_number);
    expect(text).toContain('INVOICE');
    expect(stored.toString('latin1')).toContain('/Subtype /Image'); // the logo lockup
    expect(text).toContain('Mathemajics');
    expect(text).toContain('TOTAL DUE');
    expect(text).toContain('DUE DATE');
    expect(text).toContain('AMOUNT PAYABLE IN INR: INR 13,260.00');
    expect(text).toContain('1 AUD = INR 55.25 (ECB reference rate, 25 Aug 2026)');
    expect(text).toContain('Payable by bank transfer.');
    expect(text).toContain('August tuition');
  });

  it('an indicative FX invoice prints the indicative wording', async () => {
    const r = await api(base, '/api/invoices', {
      method: 'POST', token,
      body: validInvoice({
        student_name: 'Indicative Student',
        fx_rate: 55.25, fx_source: 'ECB reference rate', fx_date: '2026-08-25',
        fx_mode: 'indicative', inr_amount: 13260,
      }),
    });
    expect(r.status).toBe(201);
    const pdfRes = await fetch(`${base}/api/invoices/${r.data.invoice.id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = pdfText(Buffer.from(await pdfRes.arrayBuffer()));
    expect(text).toContain('INR EQUIVALENT: INR 13,260.00');
    expect(text).toContain('Indicative only; payable amount is AUD.');
  });

  it('the invoice PDF contains no GST, Tax Invoice or ABN wording', async () => {
    const r = await api(base, '/api/invoices', {
      method: 'POST', token,
      body: validInvoice({
        student_name: 'Tax Free',
        line_items: [
          { description: 'August tuition', qty: 4, rate: 60, amount: 240 },
          { description: 'Workbook', qty: 1, rate: 20, amount: 20 },
        ],
        subtotal: 260,
        discount_label: 'Loyalty',
        discount_amount: 10,
        total: 250,
        notes: 'Thank you.',
      }),
    });
    expect(r.status).toBe(201);
    const pdfRes = await fetch(`${base}/api/invoices/${r.data.invoice.id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = pdfText(Buffer.from(await pdfRes.arrayBuffer()));
    expect(text.length).toBeGreaterThan(100);
    for (const banned of ['GST', 'Tax Invoice', 'ABN', 'TAX INVOICE']) {
      expect(text, banned).not.toContain(banned);
    }
  });

  it('a receipt linked to an invoice renders the Against Invoice line', async () => {
    const inv = await api(base, '/api/invoices', {
      method: 'POST', token, body: validInvoice({ student_name: 'Against Student' }),
    });
    const rcpt = await api(base, '/api/receipts', {
      method: 'POST', token,
      body: validReceipt({ student_name: 'Against Student', invoice_id: inv.data.invoice.id }),
    });
    expect(rcpt.status).toBe(201);
    const pdfRes = await fetch(`${base}/api/receipts/${rcpt.data.receipt.id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = pdfText(Buffer.from(await pdfRes.arrayBuffer()));
    expect(text).toContain('AGAINST INVOICE');
    expect(text).toContain(inv.data.invoice.invoice_number);
    expect(text).toContain('FEE RECEIPT');
  });

  it('an unlinked receipt PDF has no Against Invoice line', async () => {
    const rcpt = await api(base, '/api/receipts', {
      method: 'POST', token, body: validReceipt({ student_name: 'Unlinked Student' }),
    });
    const pdfRes = await fetch(`${base}/api/receipts/${rcpt.data.receipt.id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = pdfText(Buffer.from(await pdfRes.arrayBuffer()));
    expect(text).not.toContain('AGAINST INVOICE');
  });

  it('email failure leaves the invoice standing; retry reuses the stored bytes and 409s on a second send', async () => {
    stubEmailFail();
    const created = await api(base, '/api/invoices', {
      method: 'POST', token, body: validInvoice({ student_name: 'Retry Student' }),
    });
    expect(created.status).toBe(201);
    expect(created.data.emailed).toBe(false);
    expect(created.data.email_error).toBe('send_failed');
    const id = created.data.invoice.id;
    expect(created.data.invoice.email_sent_at).toBe(null);

    const beforeRes = await fetch(`${base}/api/invoices/${id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const storedBefore = Buffer.from(await beforeRes.arrayBuffer());

    stubEmailOk();
    const retry = await api(base, `/api/invoices/${id}/send-email`, { method: 'POST', token });
    expect(retry.status).toBe(200);
    expect(retry.data.emailed).toBe(true);
    expect(sentMessages).toHaveLength(1);
    expect(Buffer.compare(sentMessages[0].attachments[0].content, storedBefore)).toBe(0);

    const afterRes = await fetch(`${base}/api/invoices/${id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const storedAfter = Buffer.from(await afterRes.arrayBuffer());
    expect(Buffer.compare(storedAfter, storedBefore)).toBe(0);

    const again = await api(base, `/api/invoices/${id}/send-email`, { method: 'POST', token });
    expect(again.status).toBe(409);
    expect(again.data).toEqual({ error: 'already_sent' });
  });

  it('send-email on a voided invoice → 409; unknown id → 404', async () => {
    stubEmailFail();
    const created = await api(base, '/api/invoices', {
      method: 'POST', token, body: validInvoice({ student_name: 'Void Send' }),
    });
    stubEmailOk();
    const id = created.data.invoice.id;
    await api(base, `/api/invoices/${id}/void`, {
      method: 'POST', token, body: { reason: 'cancelled' },
    });
    const r = await api(base, `/api/invoices/${id}/send-email`, { method: 'POST', token });
    expect(r.status).toBe(409);
    expect(r.data).toEqual({ error: 'voided' });

    const missing = await api(base, '/api/invoices/999999/send-email', { method: 'POST', token });
    expect(missing.status).toBe(404);
  });

  it('pdf endpoint 404s for an unknown id and for a row with no stored PDF', async () => {
    const r = await api(base, '/api/invoices/999999/pdf', { token });
    expect(r.status).toBe(404);
    const row = await insertInvoiceRow({ student_name: 'No Pdf Invoice' });
    const none = await api(base, `/api/invoices/${row.id}/pdf`, { token });
    expect(none.status).toBe(404);
  });

  it('void requires a reason', async () => {
    const created = await api(base, '/api/invoices', {
      method: 'POST', token, body: validInvoice({ student_name: 'Reasonless' }),
    });
    const r = await api(base, `/api/invoices/${created.data.invoice.id}/void`, {
      method: 'POST', token, body: { reason: '   ' },
    });
    expect(r.status).toBe(400);
    expect(r.data).toEqual({ error: 'invalid_reason' });
  });
});

// ── CSV ─────────────────────────────────────────────────────────────────────

describe('CSV export', () => {
  it('reconciliation columns are correct and injection/quoting rules hold', async () => {
    stubEmailOk();
    const nasty = await api(base, '/api/invoices', {
      method: 'POST', token,
      body: validInvoice({
        student_name: '=SUM(A1:A9)',
        line_items: [
          { description: 'Term 1, "extra"\nsecond line', qty: 1, rate: 99, amount: 99 },
        ],
        subtotal: 99,
        total: 99,
      }),
    });
    expect(nasty.status).toBe(201);

    const paidInv = await api(base, '/api/invoices', {
      method: 'POST', token, body: validInvoice({ student_name: 'Csv Paid' }),
    });
    const rcpt = await api(base, '/api/receipts', {
      method: 'POST', token,
      body: validReceipt({ student_name: 'Csv Paid', invoice_id: paidInv.data.invoice.id }),
    });
    expect(rcpt.status).toBe(201);

    // A field holding a REAL newline (JSON escapes the one inside line_items).
    const wrapped = await api(base, '/api/invoices', {
      method: 'POST', token,
      body: validInvoice({
        student_name: 'Csv Wrapped',
        discount_label: 'Loyalty\ndiscount, "special"',
        discount_amount: 40,
        total: 200,
      }),
    });
    expect(wrapped.status).toBe(201);

    const res = await fetch(`${base}/api/invoices/export.csv`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const csv = await res.text();

    const header = csv.split('\r\n')[0];
    expect(header.endsWith('paid,receipt_number,receipt_amount,receipt_date')).toBe(true);
    expect(header).not.toMatch(/gst|tax/i);

    // Formula injection neutralised.
    expect(csv).toContain("'=SUM(A1:A9)");
    expect(csv).not.toMatch(/(^|,)=SUM\(A1:A9\)/m);

    // RFC-4180: the description's comma and quotes survive inside one quoted
    // line_items field, with every embedded quote doubled.
    expect(csv).toContain('""description"":""Term 1, \\""extra\\""\\nsecond line""');

    // A field holding a real newline is quoted, so that record wraps physical lines.
    expect(csv).toContain('"Loyalty\ndiscount, ""special"""');

    // Reconciliation values for the paid invoice.
    const paidLine = csv
      .split('\r\n')
      .find((l) => l.startsWith(paidInv.data.invoice.invoice_number + ','));
    expect(paidLine).toBeDefined();
    expect(paidLine).toContain(',true,' + rcpt.data.receipt.invoice_number + ',240.00,2026-08-25');

    // And an unpaid one reports false with empty receipt columns.
    const unpaidLine = csv
      .split('\r\n')
      .find((l) => l.startsWith(nasty.data.invoice.invoice_number + ','));
    expect(unpaidLine.endsWith(',false,,,')).toBe(true);
  });
});
