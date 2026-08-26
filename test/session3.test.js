// Session 3 self-tests — the static frontend: how it is served, the one CSP
// change that lets the browser look up a rate, the structural rules that keep
// the page CSP-clean, and the pure logic the screens compute with.
//
// The pure-logic half imports public/lib.js directly. The rest boots a real app
// against a scratch database. Email is ALWAYS the injected stub transport —
// nothing here sends real mail.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Client, Pool } = require('pg');
const bcrypt = require('bcrypt');

const TEST_DB = 'receipts_test_frontend';
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
const { money: serverMoney } = require('../format');

// The frontend under test. Pure module — no DOM, no network.
import {
  money as clientMoney,
  cents,
  lineAmountCents,
  subtotalCents,
  inrOffByCents,
  INR_TOLERANCE_CENTS,
  parseNumber,
  hasAtMost2dp,
  buildQuery,
  isoDate,
  fmtDate,
  addDaysIso,
  fieldMessage,
} from '../public/lib.js';

import { filenameFromDisposition } from '../public/api.js';

const REPO_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

// ── infrastructure helpers ──────────────────────────────────────────────────

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
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(base + p, { method, headers, body: payload });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : null;
  return { status: res.status, data, res };
}

function stubEmailOk() {
  email.setTransport({ sendMail: async () => ({ messageId: 'stub' }) });
}

function cspDirectives(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const [name, ...values] = trimmed.split(/\s+/);
    out[name] = values;
  }
  return out;
}

let base;
let token;
let indexHtml;
let cspHeader;

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

  const res = await fetch(base + '/');
  indexHtml = await res.text();
  cspHeader = res.headers.get('content-security-policy');

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

// ── 1. static serving ───────────────────────────────────────────────────────

describe('static serving', () => {
  it('1. GET / returns the page as HTML, with no token', async () => {
    const res = await fetch(base + '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<!doctype html>');
    expect(body).toContain('id="login-form"');
  });

  it('2. the stylesheet and every frontend script are served, unauthenticated', async () => {
    const expected = [
      ['/styles.css', 'text/css'],
      ['/app.js', 'javascript'],
      ['/lib.js', 'javascript'],
      ['/api.js', 'javascript'],
      ['/ui.js', 'javascript'],
    ];
    for (const [p, type] of expected) {
      const res = await fetch(base + p);
      expect(res.status, p).toBe(200);
      expect(res.headers.get('content-type'), p).toContain(type);
      expect((await res.text()).length, p).toBeGreaterThan(0);
    }
  });

  it('3. /app.js serves the FRONTEND file, never the server module of the same name', async () => {
    const body = await (await fetch(base + '/app.js')).text();
    expect(body).toContain("import * as api from './api.js'");
    expect(body).not.toContain("require('express')");
    expect(body).not.toContain('createApp');
  });

  it('4. serving the page changed nothing about the API: data is still behind auth', async () => {
    for (const p of [
      '/api/invoices',
      '/api/receipts',
      '/api/invoices/export.csv',
      '/api/receipts/export.csv',
    ]) {
      const r = await api(base, p);
      expect(r.status, p).toBe(401);
      expect(r.data, p).toEqual({ error: 'unauthorized' });
    }
  });

  it('5. /health is unchanged', async () => {
    const r = await api(base, '/health');
    expect(r.status).toBe(200);
    expect(r.data.ok).toBe(true);
  });

  it('6. an unknown path is still a JSON 404, not the page', async () => {
    const r = await api(base, '/no-such-thing');
    expect(r.status).toBe(404);
    expect(r.data).toEqual({ error: 'not_found' });
  });
});

// ── 2. Content-Security-Policy ──────────────────────────────────────────────

describe('CSP', () => {
  it('7. connect-src allows self and the rate service, and nothing else', () => {
    const d = cspDirectives(cspHeader);
    expect(d['connect-src']).toEqual(["'self'", 'https://api.frankfurter.dev']);
  });

  it('8. script-src is still exactly self — no external origin can run code here', () => {
    const d = cspDirectives(cspHeader);
    expect(d['script-src']).toEqual(["'self'"]);
  });

  it('9. neither script-src nor style-src names any external host', () => {
    const d = cspDirectives(cspHeader);
    // helmet's default style-src is "'self' https: data:" — scheme sources, not
    // host origins. What must never appear in either directive is a named
    // outside host: only connect-src carries one.
    for (const name of ['script-src', 'style-src']) {
      for (const value of d[name]) {
        expect(value, `${name} ${value}`).not.toContain('frankfurter');
        expect(value, `${name} ${value}`).not.toContain('//');
      }
    }
  });

  it('10. the rest of helmet stays on its defaults', () => {
    const d = cspDirectives(cspHeader);
    expect(d['default-src']).toEqual(["'self'"]);
    expect(d['object-src']).toEqual(["'none'"]);
    expect(d['script-src-attr']).toEqual(["'none'"]);
  });
});

// ── 3. structural CSP compliance of the served page ─────────────────────────

describe('the page obeys the CSP structurally', () => {
  it('11. no inline script: every <script> is empty and loads a file', () => {
    const scripts = indexHtml.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) || [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) {
      const inner = /<script\b[^>]*>([\s\S]*?)<\/script>/i.exec(tag)[1];
      expect(inner.trim(), tag).toBe('');
      expect(tag).toMatch(/\ssrc=/i);
    }
  });

  it('12. no inline <style> block and no style="" attribute', () => {
    expect(indexHtml).not.toMatch(/<style\b/i);
    expect(indexHtml).not.toMatch(/<[^>]+\sstyle\s*=/i);
  });

  it('13. no on*= event attribute anywhere in the page', () => {
    const matches = indexHtml.match(/<[^>]+\son[a-z]+\s*=/gi) || [];
    expect(matches).toEqual([]);
  });

  it('14. every frontend script parses as a module', () => {
    // These files cannot simply be imported here (app.js drives the DOM on
    // load), so each is syntax-checked as ES module source instead. A typo in
    // any of them would otherwise only show up in a browser.
    for (const name of ['app.js', 'api.js', 'ui.js', 'lib.js']) {
      const tmp = path.join(os.tmpdir(), `receipts-syntax-${process.pid}-${name}`.replace(/\.js$/, '.mjs'));
      fs.writeFileSync(tmp, fs.readFileSync(path.join(PUBLIC_DIR, name)));
      try {
        execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      } finally {
        fs.unlinkSync(tmp);
      }
    }
  });

  it('15. the frontend never builds markup out of data', () => {
    for (const name of ['app.js', 'api.js', 'ui.js', 'lib.js']) {
      const source = fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
      expect(source, name).not.toMatch(/\.innerHTML\s*=/);
      expect(source, name).not.toMatch(/insertAdjacentHTML/);
      expect(source, name).not.toMatch(/document\.write/);
    }
  });
});

// ── 4. money agreement ──────────────────────────────────────────────────────

describe('money formatting agrees with the server', () => {
  it('16. the frontend and format.js print the same figures', () => {
    for (const value of [0.5, 250, 1234.5, 13812.5, 1234567.89, -15]) {
      expect(clientMoney(value), String(value)).toBe(serverMoney(value));
    }
  });

  it('17. and keeps agreeing across the boundaries where grouping starts', () => {
    const values = [0, 0.005, 1, 99.999, 100, 999.99, 1000, 999999.99, 1000000,
      -1234.5, -0.5, 12345678901.23];
    for (const value of values) {
      expect(clientMoney(value), String(value)).toBe(serverMoney(value));
    }
  });

  it('18. grouping is comma-per-three-digits, not the lakh/crore grouping', () => {
    expect(clientMoney(138125)).toBe('138,125.00');
    expect(clientMoney(13812.5)).toBe('13,812.50');
  });
});

// ── 5. pure frontend logic ──────────────────────────────────────────────────

describe('line-item arithmetic', () => {
  it('19. a line amount matches the server expression exactly, including its float edges', () => {
    const cases = [
      [4, 60], [1, 100], [0.5, 0.05], [1.15, 0.5], [3, 33.33], [2.5, 19.99],
      [1000, 1000], [7, 0.07], [1.005, 2], [12, 8.25],
    ];
    for (const [qty, rate] of cases) {
      // validate.js computes exactly this to decide amount_mismatch.
      const server = Math.round(qty * rate * 100);
      expect(lineAmountCents(qty, rate), `${qty} x ${rate}`).toBe(server);
    }
  });

  it('20. 1.15 x 0.50 lands on the server value (57), not the integer-maths value (58)', () => {
    // The case that would break if the frontend "improved" on the server's
    // floating expression: 115 x 50 / 100 rounds to 58, the server gets 57.
    expect(lineAmountCents(1.15, 0.5)).toBe(57);
    expect(Math.round((115 * 50) / 100)).toBe(58);
  });

  it('21. totals are summed in integer cents, so 0.1 + 0.2 stays 0.30', () => {
    const lines = [{ qty: 1, rate: 0.1 }, { qty: 1, rate: 0.2 }];
    expect(subtotalCents(lines)).toBe(30);
    expect(subtotalCents(lines) / 100).toBe(0.3);
    // The float route this avoids:
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('22. twenty rows of 0.07 sum without drift', () => {
    const lines = Array.from({ length: 20 }, () => ({ qty: 1, rate: 0.07 }));
    expect(subtotalCents(lines)).toBe(140);
    expect(subtotalCents(lines) / 100).toBe(1.4);
  });

  it('23. cents() mirrors validate.js, including where floats bite', () => {
    expect(cents(0.07)).toBe(7);
    expect(cents(1234.56)).toBe(123456);
    // 0.145 is really 0.1449999..., so this rounds DOWN. That is the server's
    // answer too (validate.js runs the same expression), and agreeing with the
    // server matters more than agreeing with decimal arithmetic.
    expect(cents(0.145)).toBe(14);
    expect(cents(0.145)).toBe(Math.round(0.145 * 100));
  });
});

describe('FX consistency check', () => {
  it('24. reports the distance from total x rate, in cents', () => {
    // 250.00 at 55.30 = 13,825.00
    expect(inrOffByCents(25000, 55.3, 13825)).toBe(0);
    expect(inrOffByCents(25000, 55.3, 13825.5)).toBe(50);
    expect(inrOffByCents(25000, 55.3, 13826)).toBe(100);
    expect(inrOffByCents(25000, 55.3, 13830)).toBe(500);
  });

  it('25. the tolerance matches the 1.00 the server allows', () => {
    expect(INR_TOLERANCE_CENTS).toBe(100);
    // Rounding 13,825.00 up to 13,826.00 is exactly on the line the server
    // accepts (`> 100` is what it rejects).
    expect(inrOffByCents(25000, 55.3, 13826)).toBeLessThanOrEqual(INR_TOLERANCE_CENTS);
    expect(inrOffByCents(25000, 55.3, 13826.01)).toBeGreaterThan(INR_TOLERANCE_CENTS);
  });
});

describe('query-string builder', () => {
  it('26. drops blank filters and keeps set ones', () => {
    expect(buildQuery({ student: '', from: '', limit: 50, offset: 0 })).toBe('?limit=50&offset=0');
    expect(buildQuery({ student: 'Emma', status: 'issued' })).toBe('?student=Emma&status=issued');
    expect(buildQuery({})).toBe('');
    expect(buildQuery({ student: null, to: undefined })).toBe('');
  });

  it('27. escapes values rather than pasting them into the URL', () => {
    expect(buildQuery({ student: 'A & B' })).toBe('?student=A+%26+B');
    expect(buildQuery({ student: '100%' })).toBe('?student=100%25');
  });

  it('28. builds the filter the receipt form uses for linkable invoices', () => {
    expect(buildQuery({ paid: 'false', status: 'issued', limit: 100 }))
      .toBe('?paid=false&status=issued&limit=100');
  });
});

describe('number parsing', () => {
  it('29. blank is null, not zero', () => {
    expect(parseNumber('')).toBe(null);
    expect(parseNumber('   ')).toBe(null);
    expect(parseNumber(null)).toBe(null);
    expect(parseNumber('abc')).toBe(null);
    expect(parseNumber('0')).toBe(0);
    expect(parseNumber('12.50')).toBe(12.5);
  });

  it('30. the 2-decimal test matches validate.js', () => {
    expect(hasAtMost2dp(12.5)).toBe(true);
    expect(hasAtMost2dp(12.55)).toBe(true);
    expect(hasAtMost2dp(12.555)).toBe(false);
    expect(hasAtMost2dp(0.07)).toBe(true);
  });
});

describe('dates', () => {
  it('31. a plain YYYY-MM-DD is taken as written', () => {
    expect(isoDate('2026-08-25')).toBe('2026-08-25');
    expect(fmtDate('2026-08-25')).toBe('25 Aug 2026');
  });

  it('32. a JSON timestamp is still read back through the local timezone', () => {
    // Not how the API sends dates any more — it sends plain YYYY-MM-DD (see
    // session3b). This pins the fallback branch, which stays as a safety net.
    const local = new Date(2026, 7, 25);
    expect(isoDate(local.toISOString())).toBe('2026-08-25');
    expect(fmtDate(local.toISOString())).toBe('25 Aug 2026');
  });

  it('33. nothing in, empty string out — never "Invalid Date" on the screen', () => {
    expect(isoDate(null)).toBe('');
    expect(fmtDate(undefined)).toBe('');
    expect(fmtDate('not a date')).toBe('');
  });

  it('34. addDaysIso mirrors validate.js addDays, across a month and a year end', () => {
    expect(addDaysIso('2026-08-25', 7)).toBe('2026-09-01');
    expect(addDaysIso('2026-12-28', 7)).toBe('2027-01-04');
    expect(addDaysIso('2026-08-25', 365)).toBe('2027-08-25');
    expect(addDaysIso('2026-08-25', -30)).toBe('2026-07-26');
    expect(addDaysIso('2028-02-28', 1)).toBe('2028-02-29'); // leap year
  });
});

describe('error wording', () => {
  it('35. every server error code the forms can hit has plain-language wording', () => {
    const codes = [
      'required', 'too_long', 'invalid_email', 'invalid_date', 'in_future',
      'before_issue_date', 'too_far_ahead', 'invalid_currency', 'invalid_amount',
      'max_2_decimals', 'at_least_one_required', 'too_many', 'invalid_qty',
      'invalid_rate', 'amount_mismatch', 'not_less_than_subtotal',
      'does_not_match_line_items', 'does_not_match_subtotal_minus_discount',
      'fx_block_incomplete', 'inconsistent_with_fx_rate', 'invalid_fx_mode',
      'too_old_for_issue_date', 'required_with_discount',
    ];
    for (const code of codes) {
      const message = fieldMessage(code);
      expect(message, code).toMatch(/[a-z]/);
      expect(message, code).not.toContain('_');
    }
  });

  it('36. an unmapped code still reads as words, never raw JSON', () => {
    expect(fieldMessage('some_new_code')).toBe('some new code.');
  });

  it('37. no field, label, hint or message in the frontend mentions tax or GST', () => {
    // Comments are stripped first: several of them say, in as many words, that
    // nothing here is tax-related, and that note must not be what fails this.
    // What is scanned is everything that can reach a screen.
    const stripComments = (source) =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/^\s*\/\/.*$/gm, ' ');

    for (const name of ['app.js', 'api.js', 'ui.js', 'lib.js', 'styles.css', 'index.html']) {
      const source = stripComments(fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8'));
      expect(source, name).not.toMatch(/\bGST\b/i);
      expect(source, name).not.toMatch(/\btax\b/i);
      expect(source, name).not.toMatch(/\bABN\b/i);
      expect(source, name).not.toMatch(/\bVAT\b/);
    }
  });
});

describe('download filenames', () => {
  it('38. the CSV filename comes from Content-Disposition when present', () => {
    expect(
      filenameFromDisposition('attachment; filename="invoices-export-2026-08-26.csv"', 'x.csv')
    ).toBe('invoices-export-2026-08-26.csv');
    expect(filenameFromDisposition('attachment', 'fallback.csv')).toBe('fallback.csv');
    expect(filenameFromDisposition('', 'fallback.csv')).toBe('fallback.csv');
  });
});

// ── 6. the walk the frontend actually makes ─────────────────────────────────
//
// Exactly the sequence the screens drive, with the bodies the forms build:
// log in, issue an invoice, see it listed, record a payment against it, watch
// the invoice turn PAID, fail to void it, export both CSVs.

describe('end-to-end: the path the screens take', () => {
  let invoice;
  let receipt;

  it('39. login returns a token the rest of the calls carry', () => {
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  it('40. a wrong password is a plain 401, with nothing else leaked', async () => {
    const r = await api(base, '/api/login', { method: 'POST', body: { password: 'nope' } });
    expect(r.status).toBe(401);
    expect(r.data).toEqual({ error: 'invalid_credentials' });
  });

  it('41. the new-invoice form body is accepted, and the email goes out', async () => {
    // Built the way buildInvoiceBody() builds it, including the awkward
    // 1.15 x 0.50 line and integer-cent totals.
    const lines = [
      { description: 'August tuition', qty: 4, rate: 60 },
      { description: 'Practice pack', qty: 1.15, rate: 0.5 },
    ];
    const line_items = lines.map((l) => ({
      description: l.description,
      qty: l.qty,
      rate: l.rate,
      amount: lineAmountCents(l.qty, l.rate) / 100,
    }));
    const subtotal = subtotalCents(lines);
    const discountCents = cents(10);
    const body = {
      issue_date: isoDate(new Date()),
      due_date: addDaysIso(isoDate(new Date()), 7),
      student_name: 'Emma Example',
      parent_name: 'Parent Example',
      parent_email: 'parent@example.com',
      teacher_name: null,
      line_items,
      subtotal: subtotal / 100,
      discount_label: 'Sibling discount',
      discount_amount: 10,
      total: (subtotal - discountCents) / 100,
      currency: 'AUD',
      notes: null,
    };

    const r = await api(base, '/api/invoices', { method: 'POST', token, body });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.emailed).toBe(true);
    invoice = r.data.invoice;
    expect(invoice.invoice_number).toBe('INV-000001');
    expect(Number(invoice.subtotal)).toBe(240.57);
    expect(Number(invoice.total)).toBe(230.57);
    expect(invoice.paid).toBe(false);
  });

  it('42. the invoice list renders it: money and status read as the screen shows them', async () => {
    const r = await api(base, '/api/invoices' + buildQuery({ limit: 50, offset: 0 }), { token });
    expect(r.status).toBe(200);
    expect(r.data.invoices).toHaveLength(1);
    const row = r.data.invoices[0];
    expect(clientMoney(row.total)).toBe('230.57');
    expect(row.paid).toBe(false);
    expect(row.email_sent_at).not.toBe(null);
    expect(fmtDate(row.issue_date)).toMatch(/^\d{2} [A-Z][a-z]{2} \d{4}$/);
  });

  it('43. the receipt form loads exactly the unpaid, issued invoices', async () => {
    const r = await api(
      base,
      '/api/invoices' + buildQuery({ paid: 'false', status: 'issued', limit: 100 }),
      { token }
    );
    expect(r.status).toBe(200);
    expect(r.data.invoices.map((i) => i.invoice_number)).toEqual(['INV-000001']);
  });

  it('44. a payment recorded against it is accepted with the prefilled figures', async () => {
    const body = {
      issue_date: isoDate(new Date()),
      student_name: invoice.student_name,
      parent_name: invoice.parent_name,
      parent_email: invoice.parent_email,
      teacher_name: null,
      amount: Number(invoice.total),
      currency: invoice.currency,
      payment_method: 'bank_transfer',
      payment_reference: 'TXN-9001',
      fee_description: 'August tuition fees',
      invoice_id: invoice.id,
    };
    const r = await api(base, '/api/receipts', { method: 'POST', token, body });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.emailed).toBe(true);
    receipt = r.data.receipt;
    expect(receipt.invoice_number).toBe('RCPT-000001');
    expect(receipt.invoice_id).toBe(invoice.id);
  });

  it('45. the invoice now reads PAID, with the receipt number the row shows', async () => {
    const r = await api(base, `/api/invoices/${invoice.id}`, { token });
    expect(r.data.invoice.paid).toBe(true);
    expect(r.data.invoice.receipt_number).toBe('RCPT-000001');
  });

  it('46. a currency that differs from the invoice is refused, not corrected', async () => {
    const r = await api(base, '/api/receipts', {
      method: 'POST',
      token,
      body: {
        issue_date: isoDate(new Date()),
        student_name: 'Emma Example',
        parent_name: 'Parent Example',
        parent_email: 'parent@example.com',
        amount: 10,
        currency: 'USD',
        payment_method: 'other',
        fee_description: 'Mismatch attempt',
        invoice_id: invoice.id,
      },
    });
    // The invoice is already paid, which is checked first — either way the
    // frontend's locked currency select is the thing that keeps this off the
    // wire in normal use.
    expect([400, 409]).toContain(r.status);
  });

  it('47. voiding a paid invoice is the 409 the list explains in words', async () => {
    const r = await api(base, `/api/invoices/${invoice.id}/void`, {
      method: 'POST',
      token,
      body: { reason: 'Issued in error' },
    });
    expect(r.status).toBe(409);
    expect(r.data).toEqual({ error: 'invoice_has_receipt' });
  });

  it('48. a partial FX block is refused — which is why the form sends all five or none', async () => {
    const body = {
      issue_date: isoDate(new Date()),
      due_date: addDaysIso(isoDate(new Date()), 7),
      student_name: 'Partial FX',
      parent_name: 'Parent Example',
      parent_email: 'parent@example.com',
      line_items: [{ description: 'Tuition', qty: 1, rate: 100, amount: 100 }],
      subtotal: 100,
      total: 100,
      currency: 'AUD',
      fx_rate: 55.3,
    };
    const r = await api(base, '/api/invoices', { method: 'POST', token, body });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe('validation_failed');
    expect(r.data.fields.every((f) => f.error === 'fx_block_incomplete')).toBe(true);
  });

  it('49. a complete FX block built the way the form builds it is accepted', async () => {
    const totalCents = 25000;
    const rate = 55.3;
    const inr = Math.round((totalCents / 100) * rate * 100) / 100;
    expect(inrOffByCents(totalCents, rate, inr)).toBeLessThanOrEqual(INR_TOLERANCE_CENTS);
    const today = isoDate(new Date());
    const r = await api(base, '/api/invoices', {
      method: 'POST',
      token,
      body: {
        issue_date: today,
        due_date: addDaysIso(today, 7),
        student_name: 'FX Student',
        parent_name: 'Parent Example',
        parent_email: 'parent@example.com',
        line_items: [{ description: 'Term fees', qty: 1, rate: 250, amount: 250 }],
        subtotal: 250,
        total: 250,
        currency: 'AUD',
        fx_rate: rate,
        fx_source: 'ECB reference rate',
        fx_date: today,
        fx_mode: 'payable',
        inr_amount: inr,
      },
    });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(Number(r.data.invoice.inr_amount)).toBe(inr);
  });

  it('50. an INR figure further off than 1.00 is a field error, which is why the form blocks it', async () => {
    const today = isoDate(new Date());
    const r = await api(base, '/api/invoices', {
      method: 'POST',
      token,
      body: {
        issue_date: today,
        due_date: addDaysIso(today, 7),
        student_name: 'FX Student',
        parent_name: 'Parent Example',
        parent_email: 'parent@example.com',
        line_items: [{ description: 'Term fees', qty: 1, rate: 250, amount: 250 }],
        subtotal: 250,
        total: 250,
        currency: 'AUD',
        fx_rate: 55.3,
        fx_source: 'ECB reference rate',
        fx_date: today,
        fx_mode: 'payable',
        inr_amount: 14000,
      },
    });
    expect(r.status).toBe(400);
    expect(r.data.fields).toContainEqual({
      field: 'inr_amount',
      error: 'inconsistent_with_fx_rate',
    });
    expect(fieldMessage('inconsistent_with_fx_rate')).toContain('rupee amount');
  });

  it('51. both PDFs come back as PDFs to an authenticated fetch', async () => {
    for (const p of [`/api/invoices/${invoice.id}/pdf`, `/api/receipts/${receipt.id}/pdf`]) {
      const res = await fetch(base + p, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status, p).toBe(200);
      expect(res.headers.get('content-type'), p).toContain('application/pdf');
      const buf = Buffer.from(await res.arrayBuffer());
      expect(buf.slice(0, 5).toString('latin1'), p).toBe('%PDF-');
    }
  });

  it('52. and a PDF request WITHOUT the header is refused — the reason downloads go through fetch', async () => {
    const res = await fetch(base + `/api/invoices/${invoice.id}/pdf`);
    expect(res.status).toBe(401);
  });

  it('53. both CSV exports download, with the filename the button uses', async () => {
    for (const [p, prefix] of [
      ['/api/invoices/export.csv', 'invoices-export-'],
      ['/api/receipts/export.csv', 'receipts-export-'],
    ]) {
      const res = await fetch(base + p, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status, p).toBe(200);
      expect(res.headers.get('content-type'), p).toContain('text/csv');
      const name = filenameFromDisposition(res.headers.get('content-disposition'), 'fallback.csv');
      expect(name, p).toContain(prefix);
      expect(name, p).toMatch(/\.csv$/);
      expect((await res.text()).split('\r\n')[0], p).toContain('invoice_number');
    }
  });

  it('54. logging out kills the token, which is what returns the screen to login', async () => {
    const login = await api(base, '/api/login', {
      method: 'POST',
      body: { password: ADMIN_PASSWORD },
    });
    const temp = login.data.token;
    expect((await api(base, '/api/invoices', { token: temp })).status).toBe(200);
    expect((await api(base, '/api/logout', { method: 'POST', token: temp })).status).toBe(204);
    expect((await api(base, '/api/invoices', { token: temp })).status).toBe(401);
  });
});
