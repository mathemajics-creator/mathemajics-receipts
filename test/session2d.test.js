// Session 2d self-tests — the branded document redesign plus migration 006.
// Most of these drive pdf.js directly with row-shaped objects: the templates
// are pure functions of a row, so no database or HTTP server is needed. The
// migration and immutability checks do use a scratch database.
// Email is never involved here, so no transport is ever constructed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const { Client, Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TEST_DB = 'receipts_test_branding';

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

const { runMigrations } = require('../migrate');
const B = require('../branding');
const { generateInvoicePdf, generateReceiptPdf } = require('../pdf');

const REPO_ROOT = path.join(__dirname, '..');

// ── helpers ─────────────────────────────────────────────────────────────────

// Same extraction as Session 2c, with one addition: image XObject streams are
// skipped. They inflate to raw pixel data, and scanning ~700KB of that for
// words like "ABN" is a false-positive waiting to happen.
function pdfText(buf) {
  const s = buf.toString('latin1');
  let content = '';
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    // Only this stream's own object dictionary, not whatever precedes it.
    const objStart = s.lastIndexOf(' obj', m.index);
    const dict = objStart < 0 ? '' : s.slice(objStart, m.index);
    if (dict.includes('/Image')) continue;
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      content += zlib.inflateSync(Buffer.from(s.slice(start, end), 'latin1')).toString('latin1') + '\n';
    } catch {
      // not a flate stream — ignore
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

function pageCount(buf) {
  const m = buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return m ? m.length : 0;
}

// Exactly two things in a pdfkit file are not a function of the row, and both
// are PDF envelope metadata rather than document content:
//
//   1. CreationDate — a wall-clock stamp, written as an indirect object holding
//      a date literal (`14 0 obj (D:20260826093105Z)`), not as an inline
//      /CreationDate entry.
//   2. /ID — the trailer's file identifier, which pdfkit fills with random bytes
//      on every generation.
//
// Masking those two lets everything else be compared byte for byte. Nothing
// that appears on the page is masked.
function maskVolatile(buf) {
  return buf
    .toString('latin1')
    .replace(/\(D:\d{4,14}[^)]*\)/g, '(D:MASKED)')
    .replace(/\/ID\s*\[[^\]]*\]/g, '/ID [MASKED]');
}

function invoiceRow(overrides = {}) {
  return {
    invoice_number: 'INV-000042',
    issue_date: new Date(2026, 7, 25),
    due_date: new Date(2026, 8, 25),
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

function receiptRow(overrides = {}) {
  return {
    invoice_number: 'RCPT-000042',
    issue_date: new Date(2026, 7, 25),
    student_name: 'Row Student',
    parent_name: 'Row Parent',
    parent_email: 'row@example.com',
    teacher_name: 'Row Teacher',
    amount: 250,
    currency: 'AUD',
    payment_method: 'bank_transfer',
    payment_reference: 'TXN-9',
    against_invoice_number: null,
    fee_description: 'August tuition fees',
    ...overrides,
  };
}

const BANNED = ['GST', 'gst', 'Tax Invoice', 'TAX INVOICE', 'tax invoice', 'ABN'];

// ── branding.js is the only home for colours and contact strings ────────────

describe('branding constants', () => {
  it('exposes every colour and identity value the templates need', () => {
    for (const k of [
      'NAVY', 'CYAN', 'LIGHT_BLUE', 'INK', 'MUTED', 'HAIRLINE', 'BAND_TEXT',
      'BUSINESS_NAME', 'TAGLINE', 'WEBSITE', 'EMAIL',
    ]) {
      expect(B[k], k).toBeTruthy();
    }
    expect(B.NAVY).toBe('#0D1B2E');
    expect(B.CYAN).toBe('#00BCD4');
    expect(B.LIGHT_BLUE).toBe('#4FC3F7');
    expect(B.BUSINESS_NAME).toBe('Mathemajics');
    expect(B.TAGLINE).toBe('Unlocking the Magic of Maths');
  });

  it('pdf.js hard-codes no hex colour and no contact string', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'pdf.js'), 'utf8');
    expect(src).not.toMatch(/#[0-9A-Fa-f]{6}\b/);
    expect(src).not.toContain('mathemajics.com');
    expect(src).not.toContain('@gmail.com');
  });

  it('contact details fall back to the real values and can be overridden', () => {
    expect(B.WEBSITE).toBe('www.mathemajics.com');
    expect(B.EMAIL).toBe('mathemajics@gmail.com');

    const key = require.resolve('../branding');
    const saved = { ...process.env };
    process.env.BRAND_WEBSITE = 'www.example.test';
    process.env.BRAND_EMAIL = 'someone@example.test';
    delete require.cache[key];
    const overridden = require('../branding');
    expect(overridden.WEBSITE).toBe('www.example.test');
    expect(overridden.EMAIL).toBe('someone@example.test');

    delete process.env.BRAND_WEBSITE;
    delete process.env.BRAND_EMAIL;
    Object.assign(process.env, saved);
    delete require.cache[key];
    require('../branding');
  });
});

// ── invoice template ────────────────────────────────────────────────────────

describe('invoice PDF', () => {
  it('is a PDF, carries the invoice number, and uses no tax wording', async () => {
    const buf = await generateInvoicePdf(invoiceRow());
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    const text = pdfText(buf);
    expect(text.length).toBeGreaterThan(100);
    expect(text).toContain('INV-000042');
    expect(text).toContain('INVOICE');
    expect(text).toContain('TOTAL DUE');
    for (const banned of BANNED) expect(text, banned).not.toContain(banned);
  });

  it('carries the brand identity and the contact block', async () => {
    const text = pdfText(await generateInvoicePdf(invoiceRow()));
    expect(text).toContain(B.BUSINESS_NAME);
    expect(text).toContain(B.WEBSITE);
    expect(text).toContain(B.EMAIL);
  });

  it('embeds the logo as an image rather than drawing the text wordmark', async () => {
    const buf = await generateInvoicePdf(invoiceRow());
    expect(buf.toString('latin1')).toContain('/Subtype /Image');
    // The logo lockup already contains the tagline, so it must not also be
    // typeset beneath — that would print it twice.
    expect(pdfText(buf)).not.toContain(B.TAGLINE);
  });

  it('renders the FX block wording unchanged, in both modes', async () => {
    const payable = pdfText(
      await generateInvoicePdf(
        invoiceRow({
          fx_rate: 55.25,
          fx_source: 'ECB reference rate',
          fx_date: new Date(2026, 7, 25),
          fx_mode: 'payable',
          inr_amount: 5525,
        })
      )
    );
    expect(payable).toContain('AMOUNT PAYABLE IN INR: INR 5,525.00');
    expect(payable).toContain('1 AUD = INR 55.25 (ECB reference rate, 25 Aug 2026)');
    expect(payable).not.toContain('Indicative only');

    const indicative = pdfText(
      await generateInvoicePdf(
        invoiceRow({
          fx_rate: 55.25,
          fx_source: 'ECB reference rate',
          fx_date: new Date(2026, 7, 25),
          fx_mode: 'indicative',
          inr_amount: 5525,
        })
      )
    );
    expect(indicative).toContain('INR EQUIVALENT: INR 5,525.00');
    expect(indicative).toContain('Indicative only; payable amount is AUD.');
  });

  it('omits the discount row when there is no discount, and shows it when there is', async () => {
    // The discount ROW, specifically: the standing service terms that close
    // every invoice carry a "Discounts available" heading of their own.
    expect(pdfText(await generateInvoicePdf(invoiceRow()))).not.toContain('Discount (');
    const withDiscount = pdfText(
      await generateInvoicePdf(
        invoiceRow({ discount_label: 'Sibling discount', discount_amount: 15, total: 85 })
      )
    );
    expect(withDiscount).toContain('Discount (Sibling discount)');
    expect(withDiscount).toContain('- AUD 15.00');
  });

  it('omits the Teacher row when null', async () => {
    const text = pdfText(await generateInvoicePdf(invoiceRow({ teacher_name: null })));
    expect(text).not.toContain('Teacher');
    expect(text).toContain('Row Parent');
  });
});

// ── receipt template ────────────────────────────────────────────────────────

describe('receipt PDF', () => {
  it('is a PDF, carries the receipt number and the PAID badge, and uses no tax wording', async () => {
    const buf = await generateReceiptPdf(receiptRow());
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    const text = pdfText(buf);
    expect(text.length).toBeGreaterThan(100);
    expect(text).toContain('RCPT-000042');
    expect(text).toContain('FEE RECEIPT');
    expect(text).toContain('PAID');
    expect(text).toContain('AMOUNT');
    for (const banned of BANNED) expect(text, banned).not.toContain(banned);
  });

  it('shows Against Invoice only when the receipt is linked', async () => {
    const linked = pdfText(
      await generateReceiptPdf(receiptRow({ against_invoice_number: 'INV-000007' }))
    );
    expect(linked).toContain('AGAINST INVOICE');
    expect(linked).toContain('INV-000007');

    const unlinked = pdfText(await generateReceiptPdf(receiptRow()));
    expect(unlinked).not.toContain('AGAINST INVOICE');
  });

  it('omits Payment Reference and Teacher when null', async () => {
    const text = pdfText(
      await generateReceiptPdf(receiptRow({ payment_reference: null, teacher_name: null }))
    );
    expect(text).not.toContain('PAYMENT REFERENCE');
    expect(text).not.toContain('Teacher');
    expect(text).toContain('PAYMENT METHOD');
  });
});

// ── logo fail-soft ──────────────────────────────────────────────────────────

describe('logo handling', () => {
  it('the real logo file is present, readable and a PNG', () => {
    const buf = fs.readFileSync(B.LOGO_PATH);
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('a missing logo file still produces a PDF, falling back to the text wordmark', async () => {
    const brandingKey = require.resolve('../branding');
    const pdfKey = require.resolve('../pdf');
    const saved = process.env.BRAND_LOGO_PATH;

    process.env.BRAND_LOGO_PATH = path.join(REPO_ROOT, 'assets', 'definitely-not-here.png');
    delete require.cache[brandingKey];
    delete require.cache[pdfKey];
    const degraded = require('../pdf');

    const buf = await degraded.generateInvoicePdf(invoiceRow());
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    expect(buf.toString('latin1')).not.toContain('/Subtype /Image');
    const text = pdfText(buf);
    expect(text).toContain('MATHEMAJICS');   // the wordmark fallback
    expect(text).toContain(B.TAGLINE);       // typeset here, since no logo carries it
    expect(text).toContain('INV-000042');

    const receipt = await degraded.generateReceiptPdf(receiptRow());
    expect(receipt.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdfText(receipt)).toContain('RCPT-000042');

    // Restore the real modules for every later test.
    if (saved === undefined) delete process.env.BRAND_LOGO_PATH;
    else process.env.BRAND_LOGO_PATH = saved;
    delete require.cache[brandingKey];
    delete require.cache[pdfKey];
    require('../pdf');
  });

  it('a file that is not a PNG falls back too, rather than throwing', async () => {
    const brandingKey = require.resolve('../branding');
    const pdfKey = require.resolve('../pdf');
    const saved = process.env.BRAND_LOGO_PATH;

    process.env.BRAND_LOGO_PATH = path.join(REPO_ROOT, 'package.json');
    delete require.cache[brandingKey];
    delete require.cache[pdfKey];
    const degraded = require('../pdf');

    const buf = await degraded.generateInvoicePdf(invoiceRow());
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdfText(buf)).toContain('MATHEMAJICS');

    if (saved === undefined) delete process.env.BRAND_LOGO_PATH;
    else process.env.BRAND_LOGO_PATH = saved;
    delete require.cache[brandingKey];
    delete require.cache[pdfKey];
    require('../pdf');
  });
});

// ── overflow ────────────────────────────────────────────────────────────────

describe('invoice overflow', () => {
  const bigInvoice = invoiceRow({
    line_items: Array.from({ length: 20 }, (_, i) => ({
      description: `Item ${i + 1} — ` + 'long wrapping description text '.repeat(7),
      qty: 3,
      rate: 40,
      amount: 120,
    })),
    subtotal: 2400,
    total: 2400,
    notes: 'Payable by bank transfer.',
  });

  it('20 wrapping line items flow onto more than one page without crashing', async () => {
    const buf = await generateInvoicePdf(bigInvoice);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pageCount(buf)).toBeGreaterThan(1);
  });

  it('stamps the footer on every page and repeats the table header on continuation pages', async () => {
    const buf = await generateInvoicePdf(bigInvoice);
    const pages = pageCount(buf);
    const text = pdfText(buf);

    const footers = text.split('This is a computer-generated invoice issued by Mathemajics.').length - 1;
    expect(footers).toBe(pages);

    const headers = text.split('DESCRIPTION').length - 1;
    expect(headers).toBe(pages);

    expect(text).toContain('Item 20');
    expect(text).toContain('TOTAL DUE');
    for (const banned of BANNED) expect(text, banned).not.toContain(banned);
  });

  it('a long receipt description does not break the receipt footer', async () => {
    const buf = await generateReceiptPdf(
      receiptRow({ fee_description: 'Tuition detail. '.repeat(200) })
    );
    const pages = pageCount(buf);
    const text = pdfText(buf);
    const footers = text.split('This is a computer-generated receipt issued by Mathemajics.').length - 1;
    expect(footers).toBe(pages);
  });
});

// ── determinism ─────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('the same invoice row twice produces identical bytes apart from the timestamps', async () => {
    const row = invoiceRow({
      fx_rate: 55.25,
      fx_source: 'ECB reference rate',
      fx_date: new Date(2026, 7, 25),
      fx_mode: 'payable',
      inr_amount: 5525,
      notes: 'Payable by bank transfer.',
    });
    const a = await generateInvoicePdf(row);
    const b = await generateInvoicePdf(row);
    // Guard against a mask that silently matches nothing and makes this test
    // vacuous: it must actually find the date literal.
    expect(maskVolatile(a)).toContain('(D:MASKED)');
    expect(maskVolatile(a)).toContain('/ID [MASKED]');
    // The timestamp is fixed width, so even the length must be identical.
    expect(a.length).toBe(b.length);
    expect(maskVolatile(a)).toBe(maskVolatile(b));
  });

  it('stays deterministic across repeated and concurrent generation', async () => {
    const row = invoiceRow({ notes: 'Payable by bank transfer.' });
    const sequential = [];
    for (let i = 0; i < 3; i++) sequential.push(await generateInvoicePdf(row));
    const concurrent = await Promise.all([
      generateInvoicePdf(row),
      generateInvoicePdf(row),
      generateInvoicePdf(row),
    ]);
    const masked = new Set([...sequential, ...concurrent].map(maskVolatile));
    expect(masked.size).toBe(1);
  });

  it('the same receipt row twice produces identical bytes apart from the timestamps', async () => {
    const row = receiptRow({ against_invoice_number: 'INV-000007' });
    const a = await generateReceiptPdf(row);
    const b = await generateReceiptPdf(row);
    expect(maskVolatile(a)).toBe(maskVolatile(b));
  });
});

// ── migration 006 and the immutability invariant ────────────────────────────

describe('migration 006 — receipt_counter TRUNCATE guard', () => {
  let pool;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();
    pool = new Pool({ connectionString: testUrl });
    await runMigrations(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end().catch(() => {});
  });

  it('006 is recorded and the runner stays idempotent', async () => {
    const { rows } = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
    expect(rows.map((r) => r.filename)).toContain('006_harden_receipt_counter.sql');
    expect(await runMigrations(pool)).toEqual([]);
  });

  it('TRUNCATE receipt_counter is rejected', async () => {
    await expect(pool.query('TRUNCATE receipt_counter')).rejects.toThrow(/can never be deleted/);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM receipt_counter');
    expect(rows[0].n).toBe(1);
  });

  it('TRUNCATE invoice_counter is still rejected too', async () => {
    await expect(pool.query('TRUNCATE invoice_counter')).rejects.toThrow();
  });

  it('001_init.sql was not edited to add the guard', () => {
    const init = fs.readFileSync(path.join(REPO_ROOT, 'migrations', '001_init.sql'), 'utf8');
    expect(init).not.toContain('trg_receipt_counter_no_truncate');
  });

  it('an attached pdf_bytes can never be overwritten, and no route regenerates one', async () => {
    const { rows } = await pool.query(
      `INSERT INTO receipts (invoice_number, issue_date, student_name, parent_name,
         parent_email, amount, currency, payment_method, fee_description)
       VALUES ('RCPT-999999', '2026-08-25', 'S', 'P', 'p@example.com', 10, 'AUD',
         'bank_transfer', 'd')
       RETURNING id`
    );
    const id = rows[0].id;
    await pool.query('UPDATE receipts SET pdf_bytes = $1 WHERE id = $2', [Buffer.from('first'), id]);
    await expect(
      pool.query('UPDATE receipts SET pdf_bytes = $1 WHERE id = $2', [Buffer.from('second'), id])
    ).rejects.toThrow();

    // The only regeneration path in either router is guarded by "no bytes yet".
    for (const file of ['receipts.js', 'invoices.js']) {
      const src = fs.readFileSync(path.join(REPO_ROOT, 'routes', file), 'utf8');
      const guarded = src.replace(/if \(!pdfBuffer\) \{[\s\S]*?\n    \}/g, '');
      const writes = guarded.match(/SET pdf_bytes/g) || [];
      // What remains is the one write on the freshly-created row.
      expect(writes.length, file).toBeLessThanOrEqual(1);
    }
  });
});
