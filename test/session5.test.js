// Session 5 self-tests — free classes earned on an invoice.
//
// The feature is teaching time, not money. So the tests fall into three groups:
// it is recorded and printed correctly; it CANNOT move any total; and it is
// frozen at issue exactly like every other invoice column, including through
// the database's own trigger rather than only through the API.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const { Client, Pool } = require('pg');
const bcrypt = require('bcrypt');
const zlib = require('zlib');

const TEST_DB = 'receipts_test_freeclasses';
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

process.env.DATABASE_URL = testUrl;
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 4);

const db = require('../db');
const { runMigrations } = require('../migrate');
const { createApp } = require('../app');
const email = require('../email');
const { validateInvoiceInput } = require('../validate');

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

// Readable text out of a pdfkit PDF — the same extractor as session 2c, decoded
// the same way. The hex strings in a content stream are BYTES: decoding them
// four digits at a time fuses each pair of ASCII letters into one high code
// point ("INV-000123" comes back as "䥎Vⴰ〰ㄲ3") and every assertion about the
// words on the page then quietly means nothing.
function pdfText(buf) {
  const s = buf.toString('latin1');
  let content = '';
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const objStart = s.lastIndexOf(' obj', m.index);
    if (objStart >= 0 && s.slice(objStart, m.index).includes('/Image')) continue;
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) continue;
    const raw = Buffer.from(s.slice(start, end), 'latin1');
    try {
      content += zlib.inflateSync(raw).toString('latin1') + '\n';
    } catch {
      content += raw.toString('latin1') + '\n';
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

// One CSV line into cells, honouring RFC-4180 quoting. A plain split on commas
// would be wrong here: line_items is a JSON blob and carries its own.
function splitCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

function validInvoice(overrides = {}) {
  return {
    issue_date: '2026-08-25',
    due_date: '2026-09-25',
    student_name: 'Free Student',
    parent_name: 'Free Parent',
    parent_email: 'parent@example.com',
    line_items: [{ description: 'August tuition', qty: 4, rate: 60, amount: 240 }],
    subtotal: 240,
    total: 240,
    currency: 'AUD',
    ...overrides,
  };
}

async function fetchPdf(base, token, id) {
  const res = await fetch(`${base}/api/invoices/${id}/pdf`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return Buffer.from(await res.arrayBuffer());
}

// Every assertion about what the parent sees reads the page through here.
async function pdfWords(base, token, id) {
  return pdfText(await fetchPdf(base, token, id));
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
  stubEmailOk();
  const login = await api(base, '/api/login', {
    method: 'POST',
    body: { password: ADMIN_PASSWORD },
  });
  token = login.data.token;
});

afterAll(async () => {
  for (const s of servers) s.close();
  await db.pool.end().catch(() => {});
});

// ── recorded and printed ────────────────────────────────────────────────────

describe('free classes — recorded', () => {
  it('1. count and reasons are stored, and come back on every read path', async () => {
    const r = await api(base, '/api/invoices', {
      method: 'POST',
      token,
      body: validInvoice({ free_class_count: 2, free_class_reasons: ['Sibling'] }),
    });
    expect(r.status).toBe(201);
    expect(r.data.invoice.free_class_count).toBe(2);
    expect(r.data.invoice.free_class_reasons).toBe('Sibling');

    const one = await api(base, `/api/invoices/${r.data.invoice.id}`, { token });
    expect(one.data.invoice.free_class_count).toBe(2);

    const list = await api(base, '/api/invoices', { token });
    const found = list.data.invoices.find((i) => i.id === r.data.invoice.id);
    expect(found.free_class_reasons).toBe('Sibling');
  });

  it('2. reasons are joined in a fixed order however they arrive', () => {
    const { errors, data } = validateInvoiceInput(
      validInvoice({ free_class_count: 3, free_class_reasons: ['Group', 'Referral', 'Sibling'] })
    );
    expect(errors).toEqual([]);
    expect(data.free_class_reasons).toBe('Referral + Sibling + Group');
  });

  it('3. an invoice with no free classes stores nulls, as before', async () => {
    const r = await api(base, '/api/invoices', {
      method: 'POST',
      token,
      body: validInvoice(),
    });
    expect(r.status).toBe(201);
    expect(r.data.invoice.free_class_count).toBeNull();
    expect(r.data.invoice.free_class_reasons).toBeNull();
  });

  it('4. the note prints on the PDF, with the noun agreeing with the number', async () => {
    const two = await api(base, '/api/invoices', {
      method: 'POST',
      token,
      body: validInvoice({ free_class_count: 2, free_class_reasons: ['Referral', 'Group'] }),
    });
    const text = await pdfWords(base, token, two.data.invoice.id);
    expect(text).toContain('2 free classes earned on this invoice');
    expect(text).toContain('Referral + Group');

    const one = await api(base, '/api/invoices', {
      method: 'POST',
      token,
      body: validInvoice({ free_class_count: 1 }),
    });
    const singular = await pdfWords(base, token, one.data.invoice.id);
    expect(singular).toContain('1 free class earned on this invoice');
    expect(singular).not.toContain('1 free classes');
  });

  it('5. an invoice without the block prints no note at all', async () => {
    const r = await api(base, '/api/invoices', {
      method: 'POST',
      token,
      body: validInvoice(),
    });
    const text = await pdfWords(base, token, r.data.invoice.id);
    expect(text).not.toContain('earned on this invoice');
  });

  it('6. both columns appear in the CSV export', async () => {
    const res = await fetch(`${base}/api/invoices/export.csv`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const [header, ...rows] = (await res.text()).trim().split('\r\n');
    const columns = splitCsvLine(header);
    expect(columns).toContain('free_class_count');
    expect(columns).toContain('free_class_reasons');
    // The first invoice created above carried 2 (Sibling). Parsed rather than
    // split on commas: line_items is a JSON blob full of them.
    const first = splitCsvLine(rows[0]);
    expect(first[columns.indexOf('free_class_count')]).toBe('2');
    expect(first[columns.indexOf('free_class_reasons')]).toBe('Sibling');
  });
});

// ── it is not money ─────────────────────────────────────────────────────────

describe('free classes — never money', () => {
  it('7. no total moves: the same invoice with and without the block agrees exactly', async () => {
    const without = await api(base, '/api/invoices', {
      method: 'POST',
      token,
      body: validInvoice(),
    });
    const with_ = await api(base, '/api/invoices', {
      method: 'POST',
      token,
      body: validInvoice({ free_class_count: 5, free_class_reasons: ['Group'] }),
    });
    for (const field of ['subtotal', 'total', 'discount_amount', 'currency']) {
      expect(with_.data.invoice[field], field).toEqual(without.data.invoice[field]);
    }
  });

  it('8. the email body says nothing about free classes — the document carries it', async () => {
    stubEmailOk();
    await api(base, '/api/invoices', {
      method: 'POST',
      token,
      body: validInvoice({ free_class_count: 2, free_class_reasons: ['Sibling'] }),
    });
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).not.toMatch(/free class/i);
    expect(sentMessages[0].text).toContain('AUD 240.00');
  });

  it('9. no tax wording rides in on the new note', async () => {
    const r = await api(base, '/api/invoices', {
      method: 'POST',
      token,
      body: validInvoice({ free_class_count: 2, free_class_reasons: ['Sibling'] }),
    });
    const text = await pdfWords(base, token, r.data.invoice.id);
    expect(text).not.toMatch(/\bGST\b/i);
    expect(text).not.toMatch(/\btax\b/i);
    expect(text).not.toMatch(/\bABN\b/i);
  });
});

// ── rejected input ──────────────────────────────────────────────────────────

describe('free classes — blocked', () => {
  const bad = [
    ['zero classes', { free_class_count: 0 }, 'free_class_count'],
    ['a negative count', { free_class_count: -2 }, 'free_class_count'],
    ['a fractional count', { free_class_count: 1.5 }, 'free_class_count'],
    ['a count above the ceiling', { free_class_count: 101 }, 'free_class_count'],
    ['a count as a string', { free_class_count: '2' }, 'free_class_count'],
    ['reasons with no count', { free_class_reasons: ['Sibling'] }, 'free_class_count'],
    [
      'a reason outside the vocabulary',
      { free_class_count: 1, free_class_reasons: ['Loyalty'] },
      'free_class_reasons',
    ],
    [
      'a duplicated reason',
      { free_class_count: 1, free_class_reasons: ['Sibling', 'Sibling'] },
      'free_class_reasons',
    ],
    [
      'reasons that are not an array',
      { free_class_count: 1, free_class_reasons: 'Sibling' },
      'free_class_reasons',
    ],
  ];

  for (const [name, overrides, field] of bad) {
    it(`10. ${name} is a 400 naming ${field}, and burns no number`, async () => {
      const before = await db.pool.query('SELECT last_number FROM invoice_counter WHERE id = 1');
      const r = await api(base, '/api/invoices', {
        method: 'POST',
        token,
        body: validInvoice(overrides),
      });
      expect(r.status).toBe(400);
      expect(r.data.error).toBe('validation_failed');
      expect(r.data.fields.some((f) => f.field === field)).toBe(true);
      const after = await db.pool.query('SELECT last_number FROM invoice_counter WHERE id = 1');
      expect(after.rows[0].last_number).toBe(before.rows[0].last_number);
    });
  }
});

// ── frozen after issue ──────────────────────────────────────────────────────

describe('free classes — immutable', () => {
  it('11. the database itself refuses to change either column', async () => {
    const r = await api(base, '/api/invoices', {
      method: 'POST',
      token,
      body: validInvoice({ free_class_count: 2, free_class_reasons: ['Sibling'] }),
    });
    const id = r.data.invoice.id;

    await expect(
      db.pool.query('UPDATE invoices SET free_class_count = 9 WHERE id = $1', [id])
    ).rejects.toThrow(/immutable/);
    await expect(
      db.pool.query("UPDATE invoices SET free_class_reasons = 'Group' WHERE id = $1", [id])
    ).rejects.toThrow(/immutable/);
    await expect(
      db.pool.query('UPDATE invoices SET free_class_count = NULL WHERE id = $1', [id])
    ).rejects.toThrow(/immutable/);

    const check = await db.pool.query(
      'SELECT free_class_count, free_class_reasons FROM invoices WHERE id = $1',
      [id]
    );
    expect(check.rows[0].free_class_count).toBe(2);
    expect(check.rows[0].free_class_reasons).toBe('Sibling');
  });

  it('12. voiding still works, and leaves the free-class record intact', async () => {
    const r = await api(base, '/api/invoices', {
      method: 'POST',
      token,
      body: validInvoice({ free_class_count: 3, free_class_reasons: ['Referral'] }),
    });
    const voided = await api(base, `/api/invoices/${r.data.invoice.id}/void`, {
      method: 'POST',
      token,
      body: { reason: 'issued in error' },
    });
    expect(voided.status).toBe(200);
    expect(voided.data.invoice.status).toBe('voided');
    expect(voided.data.invoice.free_class_count).toBe(3);
    expect(voided.data.invoice.free_class_reasons).toBe('Referral');
  });

  it('13. the check constraint rejects a bad row inserted straight into the table', async () => {
    // Belt and braces: the API validates, but the column rules must stand on
    // their own for anything that reaches the database another way.
    await expect(
      db.pool.query(
        `INSERT INTO invoices (invoice_number, issue_date, due_date, student_name,
           parent_name, parent_email, line_items, subtotal, total, currency, free_class_count)
         VALUES ('INV-999001', '2026-08-25', '2026-09-25', 'S', 'P', 'p@e.com',
           '[]'::jsonb, 100, 100, 'AUD', 0)`
      )
    ).rejects.toThrow();

    await expect(
      db.pool.query(
        `INSERT INTO invoices (invoice_number, issue_date, due_date, student_name,
           parent_name, parent_email, line_items, subtotal, total, currency, free_class_reasons)
         VALUES ('INV-999002', '2026-08-25', '2026-09-25', 'S', 'P', 'p@e.com',
           '[]'::jsonb, 100, 100, 'AUD', 'Sibling')`
      )
    ).rejects.toThrow();
  });
});
