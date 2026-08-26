// Session 3b self-tests — DATE columns leave this API as plain 'YYYY-MM-DD'.
//
// The bug being closed: node-postgres turned a DATE into a Date at the server's
// local midnight, which JSON then stringified as a full UTC timestamp. Whoever
// read it had to guess which timezone to undo, and a reader west of the server
// undid it into the previous day — a silently wrong date on a financial record.
//
// These tests pin the fix at every layer it has to hold: the driver, the JSON
// responses (list and single, invoices and receipts), both CSV exports, and the
// PDF and email templates, which must be UNCHANGED by it. Email is always the
// injected stub transport — nothing here sends real mail.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { Client, Pool } = require('pg');
const bcrypt = require('bcrypt');

const TEST_DB = 'receipts_test_dates';
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
process.env.SESSION_TTL_HOURS = '12';
delete process.env.GMAIL_USER;
delete process.env.GMAIL_APP_PASSWORD;

const db = require('../db');
const { runMigrations } = require('../migrate');
const { createApp } = require('../app');
const email = require('../email');
const { ymd, longDate, dateParts } = require('../format');
const { generateInvoicePdf, generateReceiptPdf } = require('../pdf');

// ── helpers ─────────────────────────────────────────────────────────────────

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const servers = [];
function serve(app) {
  const s = app.listen(0);
  servers.push(s);
  return `http://127.0.0.1:${s.address().port}`;
}

async function api(base, p, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + p, { method, headers, body: payload });
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

// Minimal RFC-4180 row parser — the export quotes fields, so splitting on
// commas would break on any quoted cell.
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { quoted = false; }
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

function csvColumn(text, column) {
  const lines = text.split('\r\n').filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  const index = header.indexOf(column);
  if (index === -1) throw new Error('no such CSV column: ' + column);
  return lines.slice(1).map((l) => parseCsvLine(l)[index]);
}

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
    try {
      content += zlib.inflateSync(Buffer.from(s.slice(start, end), 'latin1')).toString('latin1') + '\n';
    } catch { /* not a flate stream */ }
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

const ISSUE = '2026-08-25';
const DUE = '2026-09-25';
const FX_DATE = '2026-08-25';

let base;
let token;
let invoice;
let receipt;
let voidedInvoice;

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

  // One invoice carrying all three DATE columns, paid by one receipt.
  const created = await api(base, '/api/invoices', {
    method: 'POST',
    token,
    body: {
      issue_date: ISSUE,
      due_date: DUE,
      student_name: 'Emma Example',
      parent_name: 'Parent, Example', // a comma, to exercise CSV quoting
      parent_email: 'parent@example.com',
      line_items: [{ description: 'August tuition', qty: 4, rate: 60, amount: 240 }],
      subtotal: 240,
      total: 240,
      currency: 'AUD',
      fx_rate: 55.25,
      fx_source: 'ECB reference rate',
      fx_date: FX_DATE,
      fx_mode: 'payable',
      inr_amount: 13260,
    },
  });
  expect(created.status, JSON.stringify(created.data)).toBe(201);
  invoice = created.data.invoice;

  const paid = await api(base, '/api/receipts', {
    method: 'POST',
    token,
    body: {
      issue_date: ISSUE,
      student_name: 'Emma Example',
      parent_name: 'Parent, Example',
      parent_email: 'parent@example.com',
      amount: 240,
      currency: 'AUD',
      payment_method: 'bank_transfer',
      fee_description: 'August tuition fees',
      invoice_id: invoice.id,
    },
  });
  expect(paid.status, JSON.stringify(paid.data)).toBe(201);
  receipt = paid.data.receipt;

  // A voided invoice, so the timestamp columns have real values to check.
  const second = await api(base, '/api/invoices', {
    method: 'POST',
    token,
    body: {
      issue_date: ISSUE,
      due_date: DUE,
      student_name: 'Void Student',
      parent_name: 'Parent Example',
      parent_email: 'parent@example.com',
      line_items: [{ description: 'Tuition', qty: 1, rate: 100, amount: 100 }],
      subtotal: 100,
      total: 100,
      currency: 'AUD',
    },
  });
  voidedInvoice = second.data.invoice;
  await api(base, `/api/invoices/${voidedInvoice.id}/void`, {
    method: 'POST',
    token,
    body: { reason: 'Issued in error' },
  });
});

afterAll(async () => {
  for (const s of servers) s.close();
  await db.pool.end().catch(() => {});
});

// ── 1. the driver ───────────────────────────────────────────────────────────

describe('the type parser', () => {
  it('1. a DATE comes out of the driver as a plain string, not a Date', async () => {
    const { rows } = await db.pool.query(
      'SELECT issue_date, due_date, fx_date FROM invoices WHERE id = $1',
      [invoice.id]
    );
    for (const field of ['issue_date', 'due_date', 'fx_date']) {
      expect(typeof rows[0][field], field).toBe('string');
      expect(rows[0][field] instanceof Date, field).toBe(false);
      expect(rows[0][field], field).toMatch(DATE_ONLY);
    }
    expect(rows[0].issue_date).toBe(ISSUE);
    expect(rows[0].due_date).toBe(DUE);
    expect(rows[0].fx_date).toBe(FX_DATE);
  });

  it('2. TIMESTAMPTZ columns are untouched — they really are moments in time', async () => {
    const { rows } = await db.pool.query(
      'SELECT created_at, email_sent_at FROM invoices WHERE id = $1',
      [invoice.id]
    );
    expect(rows[0].created_at).toBeInstanceOf(Date);
    expect(rows[0].email_sent_at).toBeInstanceOf(Date);
  });
});

// ── 2. JSON responses ───────────────────────────────────────────────────────

function expectPlainDate(value, label) {
  expect(typeof value, label).toBe('string');
  expect(value, label).toMatch(DATE_ONLY);
  expect(value, label).not.toContain('T');
  expect(value, label).not.toContain('Z');
  expect(value, label).not.toContain(':');
}

describe('JSON responses', () => {
  it('3. the invoice list emits YYYY-MM-DD for every date field', async () => {
    const r = await api(base, '/api/invoices', { token });
    expect(r.status).toBe(200);
    expect(r.data.invoices.length).toBeGreaterThan(0);
    for (const row of r.data.invoices) {
      expectPlainDate(row.issue_date, 'issue_date');
      expectPlainDate(row.due_date, 'due_date');
      if (row.fx_date !== null) expectPlainDate(row.fx_date, 'fx_date');
    }
  });

  it('4. the single invoice emits YYYY-MM-DD, byte-identical to what was sent', async () => {
    const r = await api(base, `/api/invoices/${invoice.id}`, { token });
    expect(r.status).toBe(200);
    expectPlainDate(r.data.invoice.issue_date, 'issue_date');
    expect(r.data.invoice.issue_date).toBe(ISSUE);
    expect(r.data.invoice.due_date).toBe(DUE);
    expect(r.data.invoice.fx_date).toBe(FX_DATE);
  });

  it('5. the receipt list emits YYYY-MM-DD', async () => {
    const r = await api(base, '/api/receipts', { token });
    expect(r.status).toBe(200);
    expect(r.data.receipts.length).toBeGreaterThan(0);
    for (const row of r.data.receipts) expectPlainDate(row.issue_date, 'issue_date');
  });

  it('6. the single receipt emits YYYY-MM-DD', async () => {
    const r = await api(base, `/api/receipts/${receipt.id}`, { token });
    expect(r.status).toBe(200);
    expect(r.data.receipt.issue_date).toBe(ISSUE);
    expectPlainDate(r.data.receipt.issue_date, 'issue_date');
  });

  it('7. the create response emits YYYY-MM-DD too — not only the read paths', () => {
    // `invoice` and `receipt` are the 201 bodies captured in beforeAll.
    expectPlainDate(invoice.issue_date, 'invoice.issue_date');
    expectPlainDate(invoice.due_date, 'invoice.due_date');
    expectPlainDate(invoice.fx_date, 'invoice.fx_date');
    expectPlainDate(receipt.issue_date, 'receipt.issue_date');
  });

  it('8. the void response emits YYYY-MM-DD as well', async () => {
    const r = await api(base, `/api/invoices/${voidedInvoice.id}`, { token });
    expectPlainDate(r.data.invoice.issue_date, 'issue_date');
    expectPlainDate(r.data.invoice.due_date, 'due_date');
  });

  it('9. timestamps in JSON are STILL full ISO timestamps — the change is scoped', async () => {
    const r = await api(base, `/api/invoices/${voidedInvoice.id}`, { token });
    const row = r.data.invoice;
    for (const field of ['created_at', 'voided_at']) {
      expect(row[field], field).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }
    expect(row.voided_at).not.toMatch(DATE_ONLY);
  });

  it('10. no date field anywhere in a response body still looks like a timestamp', async () => {
    const r = await api(base, '/api/invoices', { token });
    const raw = JSON.stringify(r.data);
    // Whatever else the payload holds, no *_date key may carry a "T...Z" value.
    const offenders = [...raw.matchAll(/"(\w*date)":"([^"]+)"/g)].filter(
      ([, , value]) => value.includes('T')
    );
    expect(offenders.map((o) => o[1] + '=' + o[2])).toEqual([]);
  });
});

// ── 3. CSV exports ──────────────────────────────────────────────────────────

describe('CSV exports', () => {
  it('11. the invoice export writes YYYY-MM-DD in every date column', async () => {
    const res = await fetch(base + '/api/invoices/export.csv', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const column of ['issue_date', 'due_date']) {
      const cells = csvColumn(text, column);
      expect(cells.length).toBeGreaterThan(0);
      for (const cell of cells) expect(cell, column).toMatch(DATE_ONLY);
    }
    // fx_date and receipt_date are empty on rows that have none.
    for (const column of ['fx_date', 'receipt_date']) {
      for (const cell of csvColumn(text, column)) {
        if (cell !== '') expect(cell, column).toMatch(DATE_ONLY);
      }
    }
    expect(csvColumn(text, 'fx_date')).toContain(FX_DATE);
    expect(csvColumn(text, 'receipt_date')).toContain(ISSUE);
  });

  it('12. the receipt export writes YYYY-MM-DD', async () => {
    const res = await fetch(base + '/api/receipts/export.csv', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const cells = csvColumn(text, 'issue_date');
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(cell).toMatch(DATE_ONLY);
    expect(cells).toContain(ISSUE);
  });

  it('13. the CSV timestamp columns keep their full ISO form', async () => {
    const res = await fetch(base + '/api/invoices/export.csv', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    for (const cell of csvColumn(text, 'created_at')) {
      expect(cell).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }
  });

  it('14. the CSV date and the JSON date agree, row for row', async () => {
    const res = await fetch(base + '/api/invoices/export.csv', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    const numbers = csvColumn(text, 'invoice_number');
    const issues = csvColumn(text, 'issue_date');
    const list = (await api(base, '/api/invoices', { token })).data.invoices;
    for (const row of list) {
      const at = numbers.indexOf(row.invoice_number);
      expect(at, row.invoice_number).toBeGreaterThanOrEqual(0);
      expect(issues[at], row.invoice_number).toBe(row.issue_date);
    }
  });
});

// ── 4. the documents must be UNCHANGED ──────────────────────────────────────

describe('PDFs and emails are unaffected', () => {
  it('15. a PDF built from string dates prints the same day as from Date objects', async () => {
    const row = {
      invoice_number: 'INV-000999',
      issue_date: '2026-08-25',
      due_date: '2026-09-25',
      student_name: 'Emma Example',
      parent_name: 'Parent Example',
      parent_email: 'parent@example.com',
      teacher_name: null,
      line_items: [{ description: 'Tuition', qty: 1, rate: 100, amount: 100 }],
      subtotal: 100, discount_label: null, discount_amount: null, total: 100,
      currency: 'AUD',
      fx_rate: null, fx_source: null, fx_date: null, fx_mode: null, inr_amount: null,
      notes: null, status: 'issued',
    };
    const fromStrings = pdfText(await generateInvoicePdf(row));
    const fromDates = pdfText(
      await generateInvoicePdf({
        ...row,
        issue_date: new Date(2026, 7, 25),
        due_date: new Date(2026, 8, 25),
      })
    );
    expect(fromStrings).toContain('25 Aug 2026');
    expect(fromStrings).toContain('25 Sep 2026');
    expect(fromDates).toContain('25 Aug 2026');
    expect(fromDates).toContain('25 Sep 2026');
  });

  it('16. the real stored invoice PDF still prints the issue date as before', async () => {
    const res = await fetch(base + `/api/invoices/${invoice.id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = pdfText(Buffer.from(await res.arrayBuffer()));
    expect(text).toContain('25 Aug 2026');
    expect(text).toContain('25 Sep 2026');
    // The FX line still carries its rate date, ungrouped, as 2d/2e pinned it.
    expect(text).toContain('1 AUD = INR 55.25 (ECB reference rate, 25 Aug 2026)');
  });

  it('17. a receipt PDF from a string date prints the day unchanged', async () => {
    const res = await fetch(base + `/api/receipts/${receipt.id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = pdfText(Buffer.from(await res.arrayBuffer()));
    expect(text).toContain('25 Aug 2026');
  });

  it('18. the invoice email still names the due date in words', () => {
    const body = sentMessages.map((m) => m.text).join('\n');
    expect(body).toContain('due on 25 Sep 2026');
  });
});

// ── 5. format.js ────────────────────────────────────────────────────────────

describe('the one date writer', () => {
  it('19. reads a plain date string exactly as written', () => {
    expect(ymd('2026-08-25')).toBe('2026-08-25');
    expect(longDate('2026-08-25')).toBe('25 Aug 2026');
    expect(dateParts('2026-01-01')).toEqual({ y: 2026, m: 1, d: 1 });
  });

  it('20. reads a Date object by its local parts, which is what it was built to mean', () => {
    expect(ymd(new Date(2026, 7, 25))).toBe('2026-08-25');
    expect(longDate(new Date(2026, 0, 1))).toBe('01 Jan 2026');
  });

  it('21. never turns a date string into a Date — the shift that caused this', () => {
    // `new Date('2026-08-25')` is midnight UTC; west of Greenwich its local
    // parts are the 24th. The string path must not go anywhere near that.
    for (const iso of ['2026-01-01', '2026-08-25', '2026-12-31', '2028-02-29']) {
      expect(ymd(iso), iso).toBe(iso);
    }
  });

  it('22. a missing date is empty, not 01 Jan 1970', () => {
    expect(ymd(null)).toBe(null);
    expect(ymd(undefined)).toBe(null);
    expect(longDate(null)).toBe('');
    expect(longDate('')).toBe('');
    expect(dateParts('not a date')).toBe(null);
  });

  it('23. a full timestamp still resolves, as the kept fallback', () => {
    expect(ymd(new Date(2026, 7, 25).toISOString())).toBe('2026-08-25');
  });
});

// ── 6. the bug itself: a reader west of the server ──────────────────────────

describe('timezone independence', () => {
  it('24. a westward process reads back exactly the same day', () => {
    // The actual reported failure: a browser (or any consumer) west of the
    // server rendering the previous day. This runs the whole read path —
    // driver, format.js, the CSV writer — in a child process pinned to
    // Los Angeles, and requires the day not to move.
    const script = `
      process.env.DATABASE_URL = ${JSON.stringify(testUrl)};
      const db = require(${JSON.stringify(path.join(__dirname, '..', 'db.js'))});
      const { ymd, longDate } = require(${JSON.stringify(path.join(__dirname, '..', 'format.js'))});
      (async () => {
        const { rows } = await db.pool.query(
          "SELECT issue_date, due_date, fx_date FROM invoices WHERE invoice_number = 'INV-000001'"
        );
        const r = rows[0];
        console.log(JSON.stringify({
          offsetMinutes: new Date().getTimezoneOffset(),
          raw: r.issue_date,
          json: JSON.parse(JSON.stringify(r)),
          viaYmd: ymd(r.issue_date),
          viaLong: longDate(r.due_date),
          fx: ymd(r.fx_date),
        }));
        await db.pool.end();
      })();
    `;
    const file = path.join(os.tmpdir(), `receipts-tz-${process.pid}.js`);
    fs.writeFileSync(file, script);
    let out;
    try {
      out = execFileSync(process.execPath, [file], {
        env: { ...process.env, TZ: 'America/Los_Angeles', DATABASE_URL: testUrl },
        encoding: 'utf8',
      });
    } finally {
      fs.unlinkSync(file);
    }
    const result = JSON.parse(out);

    // Guard against a false pass: if the child ignored TZ, this proves nothing.
    expect(result.offsetMinutes, 'TZ did not take effect in the child process')
      .toBeGreaterThan(0); // west of UTC => positive getTimezoneOffset

    expect(result.raw).toBe(ISSUE);
    expect(result.json.issue_date).toBe(ISSUE);
    expect(result.json.due_date).toBe(DUE);
    expect(result.json.fx_date).toBe(FX_DATE);
    expect(result.viaYmd).toBe(ISSUE);
    expect(result.viaLong).toBe('25 Sep 2026');
    expect(result.fx).toBe(FX_DATE);
  });

  it('25. and the API itself serves the same day whatever the reader assumes', async () => {
    // Nothing timezone-dependent is left in the payload for a client to undo:
    // the date is the same characters the invoice was created with.
    const r = await api(base, `/api/invoices/${invoice.id}`, { token });
    expect(r.data.invoice.issue_date).toBe(ISSUE);
    expect(new Date(r.data.invoice.issue_date + 'T00:00:00').getDate()).toBe(25);
  });
});

// ── 7. the wire format does not depend on the server's configuration ────────
//
// The type parser hands back the raw string Postgres sent, so the SHAPE of
// that string is Postgres's choice — governed by DateStyle, which a server, a
// database, a role or a connection can change. db.js pins it in the startup
// packet so the format belongs to this application, not to the host.

describe('DateStyle is pinned on the connection', () => {
  it('26. the application pool reports ISO, MDY', async () => {
    const { rows } = await db.pool.query('SHOW DateStyle');
    expect(rows[0].DateStyle).toBe('ISO, MDY');
  });

  it('27. the pin is actually configured on the pool, not inherited by luck', () => {
    expect(db.pool.options.options).toBe('-c datestyle=ISO,MDY');
  });

  it('28. the pin beats a database-level DateStyle that would reshape every date', async () => {
    // Make the database hostile: any new connection defaults to German style,
    // which renders the same DATE as '25.08.2026'. An unpinned pool picks that
    // up — that is the failure being guarded against — and the pinned pool,
    // configured exactly as db.js configures its own, does not.
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    let unpinned;
    let pinned;
    try {
      await admin.query(`ALTER DATABASE ${TEST_DB} SET DateStyle = 'German, DMY'`);

      unpinned = new Pool({ connectionString: testUrl });
      const loose = await unpinned.query(
        "SELECT issue_date FROM invoices WHERE invoice_number = 'INV-000001'"
      );
      expect(await unpinned.query('SHOW DateStyle').then((r) => r.rows[0].DateStyle))
        .toBe('German, DMY');
      expect(loose.rows[0].issue_date).toBe('25.08.2026');
      expect(loose.rows[0].issue_date).not.toMatch(DATE_ONLY);

      pinned = new Pool({ connectionString: testUrl, options: db.pool.options.options });
      const held = await pinned.query(
        "SELECT issue_date FROM invoices WHERE invoice_number = 'INV-000001'"
      );
      expect(await pinned.query('SHOW DateStyle').then((r) => r.rows[0].DateStyle))
        .toBe('ISO, MDY');
      expect(held.rows[0].issue_date).toBe(ISSUE);
      expect(held.rows[0].issue_date).toMatch(DATE_ONLY);
    } finally {
      await admin.query(`ALTER DATABASE ${TEST_DB} RESET DateStyle`).catch(() => {});
      await admin.end().catch(() => {});
      if (unpinned) await unpinned.end().catch(() => {});
      if (pinned) await pinned.end().catch(() => {});
    }
  });

  it('29. and the live API still serves ISO dates afterwards', async () => {
    // The database default is reset; prove the app pool was never disturbed.
    const r = await api(base, `/api/invoices/${invoice.id}`, { token });
    expectPlainDate(r.data.invoice.issue_date, 'issue_date');
    expect(r.data.invoice.issue_date).toBe(ISSUE);
  });
});
