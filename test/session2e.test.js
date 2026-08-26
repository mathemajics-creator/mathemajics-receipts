// Session 2e self-tests — thousands separators on every money figure, and the
// standing service-terms block that closes an invoice.
//
// Everything here drives format.js, pdf.js, email.js and branding.js directly
// with row-shaped objects. The templates are pure functions of a row, so no
// database and no HTTP server is involved; the email tests use an injected stub
// transport, so no real mail is ever sent.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const B = require('../branding');
const emailer = require('../email');
const { money } = require('../format');
const { generateInvoicePdf, generateReceiptPdf } = require('../pdf');

const REPO_ROOT = path.join(__dirname, '..');
const PAGE_H = 841.89;        // A4 portrait
const FOOTER_RULE_Y = 760;    // must match pdf.js

// ── PDF inspection helpers ──────────────────────────────────────────────────

// Every decodable non-image content stream, in document order. Helvetica is a
// standard-14 font, so nothing else is embedded: these are the page contents,
// one per page.
function pageStreams(buf) {
  const s = buf.toString('latin1');
  const out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const objStart = s.lastIndexOf(' obj', m.index);
    const dict = objStart < 0 ? '' : s.slice(objStart, m.index);
    if (dict.includes('/Image')) continue;
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) continue;
    let inflated;
    try {
      inflated = zlib.inflateSync(Buffer.from(s.slice(start, end), 'latin1')).toString('latin1');
    } catch {
      continue; // not a flate stream
    }
    if (inflated.includes('BT')) out.push(inflated);
  }
  return out;
}

// Text runs on one page as { y, text }, y measured from the top of the page in
// the same coordinates pdf.js lays out in (PDF space counts from the bottom).
function runs(stream) {
  const res = [];
  for (const block of stream.split(/\bBT\b/).slice(1)) {
    const seg = block.split(/\bET\b/)[0];
    const tm = seg.match(/1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/);
    let text = '';
    const hex = /<([0-9A-Fa-f]+)>/g;
    let h;
    while ((h = hex.exec(seg))) text += Buffer.from(h[1], 'hex').toString('latin1');
    if (!text.trim()) continue;
    res.push({ y: tm ? PAGE_H - parseFloat(tm[2]) : null, text });
  }
  return res;
}

function pdfText(buf) {
  return pageStreams(buf)
    .map((st) => runs(st).map((r) => r.text).join('\n'))
    .join('\n');
}

function pageCount(buf) {
  const m = buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return m ? m.length : 0;
}

// Straight-line strokes drawn anywhere in the document — every rule in either
// template is a moveTo/lineTo/stroke, which pdfkit emits as "<x> <y> l".
function ruleCount(buf) {
  return (pageStreams(buf).join('\n').match(/^\S+ \S+ l$/gm) || []).length;
}

function maskVolatile(buf) {
  return buf
    .toString('latin1')
    .replace(/\(D:\d{4,14}[^)]*\)/g, '(D:MASKED)')
    .replace(/\/ID\s*\[[^\]]*\]/g, '/ID [MASKED]');
}

// ── row fixtures ────────────────────────────────────────────────────────────

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

// Phrases taken from the middle of a rendered line, so a wrap can never split
// them: the text extractor joins wrapped lines with no separator.
const TERMS_PHRASES = ['Weekly practice questions', 'refer a friend and get 2 free classes'];
const TERMS_HEADINGS = ["What's included", 'Discounts available'];

// Run a body of work with INVOICE_TERMS temporarily replaced. Mutating the
// exported array is the point of the test: pdf.js must read it at draw time.
async function withTerms(replacement, fn) {
  const saved = B.INVOICE_TERMS;
  B.INVOICE_TERMS = replacement;
  try {
    return await fn();
  } finally {
    B.INVOICE_TERMS = saved;
  }
}

// ── Part 1: thousands separators ────────────────────────────────────────────

describe('money formatting', () => {
  it('groups thousands and always keeps two decimals', () => {
    expect(money(1234567.89)).toBe('1,234,567.89');
    expect(money(13812.5)).toBe('13,812.50');
    expect(money(9999.5)).toBe('9,999.50');
    expect(money(1000)).toBe('1,000.00');
    expect(money(250)).toBe('250.00');
    expect(money(15)).toBe('15.00');
    expect(money(0)).toBe('0.00');
    expect(money(999.999)).toBe('1,000.00');
  });

  it('keeps the sign on a negative value ahead of the grouping', () => {
    expect(money(-1500)).toBe('-1,500.00');
  });

  it('never uses Indian lakh/crore grouping', () => {
    expect(money(138125)).toBe('138,125.00');
    expect(money(138125)).not.toBe('1,38,125.00');
  });

  it('is computed without Intl, so no ICU build or host locale can change it', () => {
    // The name appears in format.js's comment explaining why it is not used;
    // what must not appear anywhere is a call.
    for (const file of ['format.js', 'pdf.js', 'email.js']) {
      const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(src, file).not.toMatch(/\.toLocaleString\s*\(/);
      expect(src, file).not.toMatch(/\bIntl\s*\./);
    }
  });

  it('has exactly one implementation, which the PDF and the email both use', () => {
    const shared = fs.readFileSync(path.join(REPO_ROOT, 'format.js'), 'utf8');
    expect(shared).toMatch(/function money\(/);

    for (const file of ['pdf.js', 'email.js']) {
      const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(src, file).toMatch(/require\('\.\/format'\)/);
      expect(src, file).not.toMatch(/function money\(/);
    }

    // No hand-rolled amount formatting left in the email bodies. (pdf.js keeps
    // a toFixed in rateText — an exchange rate is not an amount and is not
    // grouped.)
    const emailSrc = fs.readFileSync(path.join(REPO_ROOT, 'email.js'), 'utf8');
    expect(emailSrc).not.toMatch(/toFixed/);
  });

  it('formats identically in a process running under a German locale', () => {
    const out = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(require("./format").money(1234567.89))'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8', LANGUAGE: 'de_DE' },
      }
    );
    expect(out).toBe('1,234,567.89');
    expect(out).not.toBe('1.234.567,89');
  });

  it('groups the invoice total, the line rate and the amount column', async () => {
    const text = pdfText(
      await generateInvoicePdf(
        invoiceRow({
          line_items: [{ description: 'Tuition', qty: 123, rate: 9999.5, amount: 1229938.5 }],
          subtotal: 1234567.89,
          total: 1234567.89,
        })
      )
    );
    expect(text).toContain('AUD 1,234,567.89');   // TOTAL DUE and Subtotal
    expect(text).toContain('9,999.50');           // RATE
    expect(text).toContain('1,229,938.50');       // AMOUNT
    expect(text).not.toContain('1234567.89');
  });

  it('groups the receipt AMOUNT anchor', async () => {
    const text = pdfText(await generateReceiptPdf(receiptRow({ amount: 1234567.89 })));
    expect(text).toContain('AUD 1,234,567.89');
    expect(text).not.toContain('1234567.89');
  });

  it('leaves small values untouched apart from the two decimals', async () => {
    const text = pdfText(
      await generateInvoicePdf(
        invoiceRow({
          subtotal: 265,
          discount_label: 'Sibling discount',
          discount_amount: 15,
          total: 250,
        })
      )
    );
    expect(text).toContain('AUD 250.00');
    expect(text).toContain('- AUD 15.00');
    expect(text).toContain('AUD 265.00');
  });

  it('groups the discount figure too, keeping its leading minus', async () => {
    const text = pdfText(
      await generateInvoicePdf(
        invoiceRow({
          subtotal: 3900,
          discount_label: 'Group discount',
          discount_amount: 1500,
          total: 2400,
        })
      )
    );
    expect(text).toContain('- AUD 1,500.00');
  });

  it('groups the INR figure in the FX callout but never the exchange rate', async () => {
    const text = pdfText(
      await generateInvoicePdf(
        invoiceRow({
          subtotal: 23639.14,
          total: 23639.14,
          fx_rate: 55.25,
          fx_source: 'ECB reference rate',
          fx_date: new Date(2026, 7, 25),
          fx_mode: 'payable',
          inr_amount: 1306050,
        })
      )
    );
    expect(text).toContain('AMOUNT PAYABLE IN INR: INR 1,306,050.00');
    expect(text).toContain('1 AUD = INR 55.25 (ECB reference rate, 25 Aug 2026)');
    expect(text).not.toContain('INR 55,25');
    expect(text).not.toContain('1306050');
  });
});

// ── the email bodies use the same formatter as the document they carry ──────

// Capture what would have been sent, without a transport or a network.
async function captureMail(send) {
  const sent = [];
  emailer.setTransport({
    sendMail: async (msg) => {
      sent.push(msg);
      return { messageId: 'stub' };
    },
  });
  try {
    await send();
  } finally {
    emailer.setTransport(null); // back to the env-built real transport
  }
  return sent;
}

const STUB_PDF = Buffer.from('%PDF-stub');

describe('email bodies', () => {
  it('groups a large amount in the invoice email, matching the attached PDF', async () => {
    const invoice = { ...invoiceRow({ subtotal: 1234567.89, total: 1234567.89 }) };
    const [msg] = await captureMail(() => emailer.sendInvoiceEmail(invoice, STUB_PDF));

    expect(msg.to).toBe(invoice.parent_email);
    expect(msg.text).toContain('AUD 1,234,567.89');
    expect(msg.text).not.toContain('1234567.89');
    expect(msg.text).toContain('25 Sep 2026');   // the due date is untouched

    // The figure in the body is exactly the figure on the document.
    const pdf = pdfText(await generateInvoicePdf(invoice));
    expect(pdf).toContain('AUD 1,234,567.89');
  });

  it('groups a large amount in the receipt email, matching the attached PDF', async () => {
    const receipt = { ...receiptRow({ amount: 1234567.89 }) };
    const [msg] = await captureMail(() => emailer.sendReceiptEmail(receipt, STUB_PDF));

    expect(msg.to).toBe(receipt.parent_email);
    expect(msg.text).toContain('AUD 1,234,567.89');
    expect(msg.text).not.toContain('1234567.89');

    const pdf = pdfText(await generateReceiptPdf(receipt));
    expect(pdf).toContain('AUD 1,234,567.89');
  });

  it('leaves small amounts reading exactly as they did before', async () => {
    const [invoiceMsg] = await captureMail(() =>
      emailer.sendInvoiceEmail(invoiceRow({ subtotal: 250, total: 250 }), STUB_PDF)
    );
    expect(invoiceMsg.text).toContain('AUD 250.00');

    const [receiptMsg] = await captureMail(() =>
      emailer.sendReceiptEmail(receiptRow({ amount: 250 }), STUB_PDF)
    );
    expect(receiptMsg.text).toContain('AUD 250.00');
  });

  it('adds no tax, GST or ABN wording to either body', async () => {
    const [invoiceMsg] = await captureMail(() =>
      emailer.sendInvoiceEmail(invoiceRow(), STUB_PDF)
    );
    const [receiptMsg] = await captureMail(() =>
      emailer.sendReceiptEmail(receiptRow(), STUB_PDF)
    );
    for (const banned of BANNED) {
      expect(invoiceMsg.text, banned).not.toContain(banned);
      expect(receiptMsg.text, banned).not.toContain(banned);
    }
  });
});

// ── Part 2: invoice service terms ───────────────────────────────────────────

describe('invoice service terms', () => {
  it('branding.js is the only place the wording lives', () => {
    expect(Array.isArray(B.INVOICE_TERMS)).toBe(true);
    expect(B.INVOICE_TERMS.length).toBeGreaterThan(0);
    for (const entry of B.INVOICE_TERMS) {
      expect(typeof entry.heading).toBe('string');
      expect(typeof entry.body).toBe('string');
    }

    const src = fs.readFileSync(path.join(REPO_ROOT, 'pdf.js'), 'utf8');
    for (const heading of TERMS_HEADINGS) expect(src, heading).not.toContain(heading);
    for (const phrase of TERMS_PHRASES) expect(src, phrase).not.toContain(phrase);
    expect(src).not.toContain('tutoring');
  });

  it('an invoice prints every heading and body', async () => {
    const text = pdfText(await generateInvoicePdf(invoiceRow()));
    for (const heading of TERMS_HEADINGS) expect(text, heading).toContain(heading);
    for (const phrase of TERMS_PHRASES) expect(text, phrase).toContain(phrase);
  });

  it('a receipt prints neither heading nor any of the body text', async () => {
    const text = pdfText(await generateReceiptPdf(receiptRow()));
    for (const heading of TERMS_HEADINGS) expect(text, heading).not.toContain(heading);
    for (const phrase of TERMS_PHRASES) expect(text, phrase).not.toContain(phrase);
  });

  it('an empty terms array omits the section entirely — no orphan heading or rule', async () => {
    const row = invoiceRow({ notes: 'Payable by bank transfer.' });
    const withEntries = await generateInvoicePdf(row);
    const withNone = await withTerms([], () => generateInvoicePdf(row));

    const text = pdfText(withNone);
    for (const heading of TERMS_HEADINGS) expect(text, heading).not.toContain(heading);
    for (const phrase of TERMS_PHRASES) expect(text, phrase).not.toContain(phrase);
    expect(text).toContain('TOTAL DUE');           // the rest of the document is intact
    expect(text).toContain('Payable by bank transfer.');

    // The separating rule goes with the section: exactly one fewer stroke.
    expect(ruleCount(withEntries)).toBeGreaterThan(0);
    expect(ruleCount(withNone)).toBe(ruleCount(withEntries) - 1);
    expect(pageCount(withNone)).toBe(1);
  });

  it('renders three entries when three are configured — the renderer iterates', async () => {
    const text = await withTerms(
      [
        { heading: 'First heading', body: 'First body sentinel.' },
        { heading: 'Second heading', body: 'Second body sentinel.' },
        { heading: 'Third heading', body: 'Third body sentinel.' },
      ],
      async () => pdfText(await generateInvoicePdf(invoiceRow()))
    );
    for (const s of [
      'First heading', 'First body sentinel.',
      'Second heading', 'Second body sentinel.',
      'Third heading', 'Third body sentinel.',
    ]) {
      expect(text, s).toContain(s);
    }
    // And the stock two are gone, so this really used the replacement.
    for (const heading of TERMS_HEADINGS) expect(text, heading).not.toContain(heading);
  });

  it('adds no tax, GST or ABN wording', async () => {
    const text = pdfText(await generateInvoicePdf(invoiceRow()));
    for (const banned of BANNED) expect(text, banned).not.toContain(banned);
  });
});

// ── layout safety ───────────────────────────────────────────────────────────

describe('terms layout safety', () => {
  const bigInvoice = invoiceRow({
    line_items: Array.from({ length: 20 }, (_, i) => ({
      description: `Item ${i + 1}: ` + 'long wrapping description text that runs on. '.repeat(4),
      qty: 3,
      rate: 40,
      amount: 120,
    })),
    subtotal: 2400,
    total: 2400,
    notes: 'Payable by bank transfer.',
  });

  const isTerms = (t) =>
    TERMS_HEADINGS.some((h) => t.includes(h)) || TERMS_PHRASES.some((p) => t.includes(p));

  it('a 20-item invoice runs to several pages with the terms once, on the last page', async () => {
    const buf = await generateInvoicePdf(bigInvoice);
    const pages = pageCount(buf);
    expect(pages).toBeGreaterThan(1);

    const streams = pageStreams(buf);
    expect(streams.length).toBe(pages);

    const termPages = new Set();
    streams.forEach((st, i) => {
      for (const r of runs(st)) if (isTerms(r.text)) termPages.add(i + 1);
    });
    expect([...termPages]).toEqual([pages]);

    const text = pdfText(buf);
    for (const heading of TERMS_HEADINGS) {
      expect(text.split(heading).length - 1, heading).toBe(1);
    }
  });

  it('keeps the footer on every page and never lets the terms reach it', async () => {
    for (const row of [invoiceRow(), bigInvoice]) {
      const buf = await generateInvoicePdf(row);
      const pages = pageCount(buf);
      const text = pdfText(buf);

      const footers =
        text.split('This is a computer-generated invoice issued by Mathemajics.').length - 1;
      expect(footers).toBe(pages);

      for (const st of pageStreams(buf)) {
        for (const r of runs(st)) {
          if (!isTerms(r.text)) continue;
          expect(r.y).not.toBeNull();
          expect(r.y).toBeGreaterThan(0);            // on the page, not above it
          expect(r.y).toBeLessThan(FOOTER_RULE_Y);   // clear of the footer band
        }
      }
    }
  });

  it('holds across every invoice length, from no line items to a full three pages', async () => {
    for (const n of [0, 1, 5, 9, 10, 14, 18, 20, 24]) {
      const buf = await generateInvoicePdf(
        invoiceRow({
          line_items: Array.from({ length: n }, (_, i) => ({
            description: `Item ${i + 1} ` + 'x'.repeat(120),
            qty: 3,
            rate: 40,
            amount: 120,
          })),
          subtotal: 120 * n,
          total: 120 * n,
          notes: 'Payable by bank transfer.',
        })
      );
      const pages = pageCount(buf);
      const termPages = new Set();
      let lowest = 0;
      pageStreams(buf).forEach((st, i) => {
        for (const r of runs(st)) {
          if (!isTerms(r.text)) continue;
          termPages.add(i + 1);
          lowest = Math.max(lowest, r.y);
        }
      });
      // One unbroken block, at the foot of the final page, clear of the footer.
      expect([...termPages], `n=${n}`).toEqual([pages]);
      expect(lowest, `n=${n}`).toBeLessThan(FOOTER_RULE_Y);
    }
  });
});

// ── determinism is unaffected by either change ──────────────────────────────

describe('determinism', () => {
  it('the same invoice twice is byte-identical apart from the masked timestamps', async () => {
    const row = invoiceRow({
      subtotal: 1234567.89,
      total: 1234567.89,
      fx_rate: 55.25,
      fx_source: 'ECB reference rate',
      fx_date: new Date(2026, 7, 25),
      fx_mode: 'payable',
      inr_amount: 68209875.92,
      notes: 'Payable by bank transfer.',
    });
    const a = await generateInvoicePdf(row);
    const b = await generateInvoicePdf(row);
    expect(maskVolatile(a)).toContain('(D:MASKED)');
    expect(maskVolatile(a)).toContain('/ID [MASKED]');
    expect(a.length).toBe(b.length);
    expect(maskVolatile(a)).toBe(maskVolatile(b));
  });
});

// ── the frozen-evidence rule is untouched by a cosmetic change ──────────────

describe('issued documents stay frozen', () => {
  it('no route regenerates or overwrites an existing pdf_bytes', () => {
    for (const file of ['receipts.js', 'invoices.js']) {
      const src = fs.readFileSync(path.join(REPO_ROOT, 'routes', file), 'utf8');
      const guarded = src.replace(/if \(!pdfBuffer\) \{[\s\S]*?\n    \}/g, '');
      const writes = guarded.match(/SET pdf_bytes/g) || [];
      expect(writes.length, file).toBeLessThanOrEqual(1);
    }
  });
});
