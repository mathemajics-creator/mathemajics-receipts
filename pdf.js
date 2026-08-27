// pdf.js — receipt and invoice PDF generation with pdfkit. A4, deterministic
// layout from row data only: built-in Helvetica, the local logo file, and
// nothing else — no network, no downloaded fonts.
// No tax, GST or ABN wording appears in either template, by design.
//
// Every colour and identity string comes from branding.js, and every money
// figure and date is formatted by format.js — the same formatters the emails,
// the CSV exports and the API responses use.

const fs = require('fs');
const PDFDocument = require('pdfkit');
const B = require('./branding');
const { money, longDate } = require('./format');

// ---------------------------------------------------------------------------
// Logo, loaded once at module load. A missing or unreadable file must never
// stop a document being generated: a receipt that fails to issue is a financial
// problem, a missing logo is a cosmetic one. We fall back to the text wordmark
// and warn exactly once.
// ---------------------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const logo = (() => {
  let buffer;
  try {
    buffer = fs.readFileSync(B.LOGO_PATH);
  } catch (err) {
    console.warn(
      `pdf: logo not readable at ${B.LOGO_PATH} (${err.code || err.message}) — using the text wordmark`
    );
    return null;
  }
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    console.warn(`pdf: logo at ${B.LOGO_PATH} is not a PNG — using the text wordmark`);
    return null;
  }
  // Intrinsic size straight out of the IHDR chunk, so the aspect ratio is never
  // guessed and never distorted — and so the frame drawn around the artwork
  // matches its rendered box exactly.
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) {
    console.warn(`pdf: logo at ${B.LOGO_PATH} has no readable size — using the text wordmark`);
    return null;
  }
  return { buffer, width, height };
})();

// A PNG that passes the magic-byte check can still fail inside pdfkit. Warn on
// the first such failure only, then keep quiet.
let logoRenderWarned = false;

// ── Layout constants ───────────────────────────────────────────────────────

const PAGE_W = 595.28;          // A4 portrait
const LEFT = 50;
const RIGHT = 545;
const CONTENT_W = RIGHT - LEFT; // 495

const BAND_H = 92;              // navy header band
const ACCENT_H = 3;             // cyan accent rule beneath it
const LOGO_H = 56;              // logo render height; width follows the aspect ratio

const BODY_TOP = 128;           // first body element on page 1
const CONT_TOP = 60;            // first body element on a continuation page
const BODY_BOTTOM = 730;        // last y a block may start at before a page break

const FOOTER_RULE_Y = 760;

const PAYMENT_METHOD_LABELS = {
  bank_transfer: 'Bank transfer',
  paypal: 'PayPal',
  upi: 'UPI',
  other: 'Other',
};

// ── Value formatting ──────────────────────────────────────────────────────

// Dates are written by format.js, where money() lives, for the same reason: a
// date printed on a PDF must not disagree with the one in the email beside it,
// in the CSV, or in the API. DATE columns arrive as 'YYYY-MM-DD' and the sample
// script hands over Date objects; longDate takes either without moving the day.
const formatDate = longDate;

// Trailing zeros off, but never fewer than 2 decimals (a rate reads as money).
function rateText(v) {
  const s = Number(v).toFixed(6).replace(/0+$/, '');
  const trimmed = s.endsWith('.') ? s.slice(0, -1) : s;
  const dot = trimmed.indexOf('.');
  if (dot === -1) return trimmed + '.00';
  const decimals = trimmed.length - dot - 1;
  return decimals < 2 ? Number(trimmed).toFixed(2) : trimmed;
}

// Quantities are counts far more often than fractions: show 2 as "2", 1.5 as "1.5".
function qtyText(v) {
  return String(Number(v));
}

// "2 free classes earned (Sibling)" — the reasons are optional, and the noun
// agrees with the number so a single free class does not read as a typo.
function freeClassText(invoice) {
  const n = Number(invoice.free_class_count);
  const noun = n === 1 ? 'free class' : 'free classes';
  const reasons = invoice.free_class_reasons ? ` (${invoice.free_class_reasons})` : '';
  return `${n} ${noun} earned on this invoice${reasons}`;
}

// ── Shared drawing primitives ──────────────────────────────────────────────

// Helvetica has no true small caps; uppercase at a small size with a little
// letter spacing carries the same signal.
function label(doc, text, x, y, opts = {}) {
  const { color, ...textOpts } = opts;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(color || B.MUTED)
    .text(String(text).toUpperCase(), x, y, { characterSpacing: 0.8, ...textOpts });
}

function value(doc, text, x, y, opts = {}) {
  doc.font('Helvetica').fontSize(10).fillColor(B.INK).text(String(text), x, y, opts);
}

function drawWordmark(doc) {
  doc.font('Helvetica-Bold').fontSize(21).fillColor(B.BAND_TEXT)
    .text(B.BUSINESS_NAME.toUpperCase(), LEFT, 28, { characterSpacing: 0.5 });
  doc.font('Helvetica').fontSize(8.5).fillColor(B.LIGHT_BLUE)
    .text(B.TAGLINE, LEFT, 56);
}

// The navy band that opens both documents. The logo is a self-contained lockup
// on its own navy plate — wordmark, rule and tagline — so it sits directly on
// the band (its ink is white and light blue) and no separate tagline is drawn
// beneath it; that would print the tagline twice. The wordmark fallback has no
// tagline of its own, so there it is drawn.
function drawHeaderBand(doc, docType) {
  doc.rect(0, 0, PAGE_W, BAND_H).fill(B.NAVY);
  doc.rect(0, BAND_H, PAGE_W, ACCENT_H).fill(B.CYAN);

  let drewLogo = false;
  if (logo) {
    try {
      const w = LOGO_H * (logo.width / logo.height);
      const top = (BAND_H - LOGO_H) / 2;
      doc.image(logo.buffer, LEFT, top, { height: LOGO_H });
      // The artwork carries its own opaque navy plate, a shade off the band's
      // navy. A cyan hairline sitting exactly on its edge turns what would read
      // as a mismatched patch into a deliberate framed lockup.
      doc.lineWidth(1);
      doc.roundedRect(LEFT, top, w, LOGO_H, 3).stroke(B.CYAN);
      drewLogo = true;
    } catch (err) {
      if (!logoRenderWarned) {
        logoRenderWarned = true;
        console.warn(`pdf: logo could not be rendered (${err.message}) — using the text wordmark`);
      }
    }
  }
  if (!drewLogo) drawWordmark(doc);

  // Right: document type over the contact block, both right-aligned to RIGHT.
  const blockX = 300;
  const blockW = RIGHT - blockX;
  doc.font('Helvetica-Bold').fontSize(20).fillColor(B.BAND_TEXT)
    .text(docType, blockX, 24, { width: blockW, align: 'right', characterSpacing: 1.2 });
  doc.font('Helvetica').fontSize(8).fillColor(B.LIGHT_BLUE)
    .text(B.WEBSITE, blockX, 53, { width: blockW, align: 'right' });
  doc.text(B.EMAIL, blockX, 64, { width: blockW, align: 'right' });
}

function drawFooter(doc, wording, documentNumber) {
  doc.moveTo(LEFT, FOOTER_RULE_Y).lineTo(RIGHT, FOOTER_RULE_Y)
    .lineWidth(1).strokeColor(B.HAIRLINE).stroke();
  doc.font('Helvetica').fontSize(8).fillColor(B.MUTED)
    .text(wording, LEFT, 768, { width: CONTENT_W, align: 'center' });
  doc.fontSize(7).text(documentNumber, LEFT, 780, { width: CONTENT_W, align: 'center' });
}

// A row of label-over-value pairs spread across the content width.
function drawMetaStrip(doc, pairs, y) {
  const colW = CONTENT_W / pairs.length;
  pairs.forEach(([lbl, val], i) => {
    const x = LEFT + i * colW;
    label(doc, lbl, x, y, { width: colW - 8 });
    value(doc, val, x, y + 12, { width: colW - 8 });
  });
  return y + 34;
}

// A tinted panel of label/value rows — "Bill To" on the invoice, "Received
// From" on the receipt.
function drawPartyPanel(doc, heading, rows, y) {
  const present = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  const pad = 14;
  const rowH = 16;
  const h = pad + 14 + present.length * rowH + pad - 4;

  doc.rect(LEFT, y, CONTENT_W, h).fill(B.PANEL_TINT);
  doc.rect(LEFT, y, 3, h).fill(B.CYAN);

  label(doc, heading, LEFT + pad, y + pad);
  let ry = y + pad + 16;
  for (const [lbl, val] of present) {
    doc.font('Helvetica').fontSize(9).fillColor(B.MUTED)
      .text(lbl, LEFT + pad, ry + 1, { width: 70 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(B.INK)
      .text(String(val), LEFT + pad + 78, ry, { width: CONTENT_W - pad * 2 - 78 });
    ry += rowH;
  }
  return y + h + 20;
}

// The filled navy anchor: TOTAL DUE on the invoice, AMOUNT on the receipt.
// The invoice's sits at the foot of the right-aligned totals column, so it is
// half width; the receipt has no such column and a half-width box would float,
// so that one spans the content width.
function drawAnchorBox(doc, lbl, val, y, { x = 300, w = RIGHT - x } = {}) {
  const h = 32;
  doc.rect(x, y, w, h).fill(B.NAVY);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(B.BAND_TEXT)
    .text(String(lbl).toUpperCase(), x + 14, y + 12, { characterSpacing: 0.8 });
  doc.font('Helvetica-Bold').fontSize(13).fillColor(B.BAND_TEXT)
    .text(val, x, y + 9, { width: w - 14, align: 'right' });
  return y + h;
}

// ---------------------------------------------------------------------------
// Invoice template. A flowing layout: the line-item table can be up to 20 rows
// with wrapping descriptions, so the cursor may run onto a second page. The
// footer is stamped on every page and the table header repeats on continuation
// pages.
// ---------------------------------------------------------------------------

const COL_DESC_X = 60;
const COL_DESC_W = 235;
const COL_QTY_X = 300;
const COL_QTY_W = 45;
const COL_RATE_X = 355;
const COL_RATE_W = 85;
const COL_AMT_X = 450;
const COL_AMT_W = 85;

const TABLE_HEADER_H = 22;

function drawTableHeader(doc, y) {
  doc.rect(LEFT, y, CONTENT_W, TABLE_HEADER_H).fill(B.NAVY);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(B.BAND_TEXT);
  const ty = y + 7;
  doc.text('DESCRIPTION', COL_DESC_X, ty, { width: COL_DESC_W, characterSpacing: 0.8 });
  doc.text('QTY', COL_QTY_X, ty, { width: COL_QTY_W, align: 'right', characterSpacing: 0.8 });
  doc.text('RATE', COL_RATE_X, ty, { width: COL_RATE_W, align: 'right', characterSpacing: 0.8 });
  doc.text('AMOUNT', COL_AMT_X, ty, { width: COL_AMT_W, align: 'right', characterSpacing: 0.8 });
  return y + TABLE_HEADER_H;
}

function generateInvoicePdf(invoice) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = 0;
    // Set while the cursor is inside the line-item table so a page break can
    // repeat the header row; null everywhere else.
    let onNewPage = null;

    // Adds a page when the next block would run past the footer rule.
    function ensure(height) {
      if (y + height > BODY_BOTTOM) {
        doc.addPage();
        y = CONT_TOP;
        if (onNewPage) onNewPage();
      }
    }

    function sectionTitle(text) {
      ensure(30);
      y += 6;
      label(doc, text, LEFT, y, { color: B.NAVY });
      y += 13;
      doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(1).strokeColor(B.HAIRLINE).stroke();
      y += 10;
    }

    // ── Header ──────────────────────────────────────────────────────────────
    drawHeaderBand(doc, 'INVOICE');

    // ── Meta ────────────────────────────────────────────────────────────────
    y = drawMetaStrip(
      doc,
      [
        ['Invoice No', invoice.invoice_number],
        ['Issue Date', formatDate(invoice.issue_date)],
        ['Due Date', formatDate(invoice.due_date)],
        ['Currency', invoice.currency],
      ],
      BODY_TOP
    );

    // ── Bill To ─────────────────────────────────────────────────────────────
    y = drawPartyPanel(
      doc,
      'Bill To',
      [
        ['Parent', invoice.parent_name],
        ['Student', invoice.student_name],
        ['Teacher', invoice.teacher_name], // omitted when null
      ],
      y
    );

    // ── Line items ──────────────────────────────────────────────────────────
    ensure(TABLE_HEADER_H + 30);
    y = drawTableHeader(doc, y);
    onNewPage = () => {
      y = drawTableHeader(doc, y);
    };

    const items = Array.isArray(invoice.line_items) ? invoice.line_items : [];
    items.forEach((item, i) => {
      const desc = String(item.description);
      doc.font('Helvetica').fontSize(9.5);
      const rowH = Math.max(24, doc.heightOfString(desc, { width: COL_DESC_W }) + 13);
      ensure(rowH);
      if (i % 2 === 1) doc.rect(LEFT, y, CONTENT_W, rowH).fill(B.ROW_TINT);
      doc.font('Helvetica').fontSize(9.5).fillColor(B.INK);
      const ty = y + 7;
      doc.text(desc, COL_DESC_X, ty, { width: COL_DESC_W });
      doc.text(qtyText(item.qty), COL_QTY_X, ty, { width: COL_QTY_W, align: 'right' });
      doc.text(money(item.rate), COL_RATE_X, ty, { width: COL_RATE_W, align: 'right' });
      doc.text(money(item.amount), COL_AMT_X, ty, { width: COL_AMT_W, align: 'right' });
      doc.moveTo(LEFT, y + rowH).lineTo(RIGHT, y + rowH)
        .lineWidth(0.5).strokeColor(B.HAIRLINE).stroke();
      y += rowH;
    });
    onNewPage = null;

    // ── Totals ──────────────────────────────────────────────────────────────
    y += 14;

    function totalRow(lbl, val) {
      ensure(18);
      doc.font('Helvetica').fontSize(9.5).fillColor(B.MUTED)
        .text(lbl, COL_QTY_X, y, { width: COL_RATE_X + COL_RATE_W - COL_QTY_X, align: 'right' });
      doc.fillColor(B.INK).text(val, COL_AMT_X, y, { width: COL_AMT_W, align: 'right' });
      y += 18;
    }

    totalRow('Subtotal', `${invoice.currency} ${money(invoice.subtotal)}`);
    if (invoice.discount_amount !== null && invoice.discount_amount !== undefined) {
      totalRow(
        `Discount (${invoice.discount_label})`,
        `- ${invoice.currency} ${money(invoice.discount_amount)}`
      );
    }
    y += 4;
    ensure(32);
    y = drawAnchorBox(doc, 'Total Due', `${invoice.currency} ${money(invoice.total)}`, y);

    // ── FX block ────────────────────────────────────────────────────────────
    // Wording is unchanged from Session 2c; only the surrounding box is new.
    if (invoice.fx_rate !== null && invoice.fx_rate !== undefined) {
      const headline =
        invoice.fx_mode === 'payable'
          ? `AMOUNT PAYABLE IN INR: INR ${money(invoice.inr_amount)}`
          : `INR EQUIVALENT: INR ${money(invoice.inr_amount)}`;
      const indicative =
        invoice.fx_mode === 'indicative'
          ? `Indicative only; payable amount is ${invoice.currency}.`
          : null;
      const rateLine =
        `1 ${invoice.currency} = INR ${rateText(invoice.fx_rate)} ` +
        `(${invoice.fx_source}, ${formatDate(invoice.fx_date)})`;

      const pad = 14;
      const innerW = CONTENT_W - pad * 2;
      doc.font('Helvetica-Bold').fontSize(11);
      let boxH = pad + doc.heightOfString(headline, { width: innerW });
      doc.font('Helvetica').fontSize(9);
      if (indicative) boxH += 4 + doc.heightOfString(indicative, { width: innerW });
      boxH += 4 + doc.heightOfString(rateLine, { width: innerW }) + pad;

      y += 22;
      ensure(boxH);
      doc.lineWidth(1);
      doc.rect(LEFT, y, CONTENT_W, boxH).fillAndStroke(B.PANEL_TINT, B.CYAN);

      let fy = y + pad;
      doc.font('Helvetica-Bold').fontSize(11).fillColor(B.NAVY)
        .text(headline, LEFT + pad, fy, { width: innerW });
      fy += doc.heightOfString(headline, { width: innerW }) + 4;
      doc.font('Helvetica').fontSize(9).fillColor(B.MUTED);
      if (indicative) {
        doc.text(indicative, LEFT + pad, fy, { width: innerW });
        fy += doc.heightOfString(indicative, { width: innerW }) + 4;
      }
      doc.text(rateLine, LEFT + pad, fy, { width: innerW });
      y += boxH;
    }

    // ── Free classes earned ─────────────────────────────────────────────────
    // Teaching time the family has earned, not money: it sits BELOW the total
    // and changes nothing above it. Green rather than the document's cyan, so
    // it cannot be misread as part of the amount payable.
    if (invoice.free_class_count) {
      const line = freeClassText(invoice);
      const pad = 10;
      const innerW = CONTENT_W - pad * 2;
      doc.font('Helvetica-Bold').fontSize(10);
      const boxH = pad + doc.heightOfString(line, { width: innerW }) + pad;

      y += 14;
      ensure(boxH);
      doc.lineWidth(1);
      doc.rect(LEFT, y, CONTENT_W, boxH).fillAndStroke(B.GREEN_TINT, B.GREEN);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(B.GREEN)
        .text(line, LEFT + pad, y + pad, { width: innerW });
      y += boxH;
    }

    // ── Notes (owner-supplied only) ─────────────────────────────────────────
    if (invoice.notes) {
      y += 8;
      sectionTitle('Notes');
      const notes = String(invoice.notes);
      doc.font('Helvetica').fontSize(10);
      const h = doc.heightOfString(notes, { width: CONTENT_W });
      ensure(h + 6);
      doc.fillColor(B.INK).text(notes, LEFT, y, { width: CONTENT_W });
      y += h + 6;
    }

    // ── Service terms (invoices only) ───────────────────────────────────────
    // The closing section of the document, and deliberately the quietest thing
    // on the page: small, muted, well below the weight of TOTAL DUE and the FX
    // callout. It is fine print, not a feature.
    //
    // The wording lives in branding.js. This loop iterates whatever that array
    // holds — two entries, three, or none — so changing the terms never means
    // changing this template.
    const terms = Array.isArray(B.INVOICE_TERMS) ? B.INVOICE_TERMS : [];
    if (terms.length) {
      const HEAD_SIZE = 8.5;
      const BODY_SIZE = 8;
      const BODY_GAP = 2;   // extra leading, so small type still breathes
      const HEAD_GAP = 3;   // heading to its own body
      const ENTRY_GAP = 8;  // one entry to the next
      const RULE_GAP = 12;  // separating rule to the first heading

      const headH = (t) => {
        doc.font('Helvetica-Bold').fontSize(HEAD_SIZE);
        return doc.heightOfString(t, { width: CONTENT_W });
      };
      const bodyH = (t) => {
        doc.font('Helvetica').fontSize(BODY_SIZE);
        return doc.heightOfString(t, { width: CONTENT_W, lineGap: BODY_GAP });
      };
      const entryH = (e) =>
        headH(String(e.heading)) + HEAD_GAP + bodyH(String(e.body));

      const blockH =
        RULE_GAP +
        terms.reduce((sum, e) => sum + entryH(e), 0) +
        ENTRY_GAP * (terms.length - 1);

      y += 22;

      // Terms read as one piece of fine print, so the whole block moves to the
      // next page rather than splitting across the break. Only when it could
      // not fit on an empty page either — a terms list someone has grown past a
      // full page — is it allowed to flow entry by entry instead.
      if (blockH <= BODY_BOTTOM - CONT_TOP) ensure(blockH);

      terms.forEach((entry, i) => {
        const heading = String(entry.heading);
        const body = String(entry.body);

        if (i === 0) {
          // The rule is measured together with the first entry, so it can never
          // be left orphaned at the foot of a page.
          ensure(RULE_GAP + entryH(entry));
          doc.moveTo(LEFT, y).lineTo(RIGHT, y)
            .lineWidth(1).strokeColor(B.HAIRLINE).stroke();
          y += RULE_GAP;
        } else {
          y += ENTRY_GAP;
          ensure(entryH(entry));
        }

        // Title case as written, not the small-caps field-label treatment —
        // this reads as prose, not as a data label.
        doc.font('Helvetica-Bold').fontSize(HEAD_SIZE).fillColor(B.NAVY)
          .text(heading, LEFT, y, { width: CONTENT_W });
        y += headH(heading) + HEAD_GAP;

        doc.font('Helvetica').fontSize(BODY_SIZE).fillColor(B.MUTED)
          .text(body, LEFT, y, { width: CONTENT_W, lineGap: BODY_GAP });
        y += bodyH(body);
      });
    }

    // ── Footer on every page ────────────────────────────────────────────────
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      drawFooter(
        doc,
        `This is a computer-generated invoice issued by ${B.BUSINESS_NAME}.`,
        invoice.invoice_number
      );
    }
    doc.flushPages();

    doc.end();
  });
}

// ---------------------------------------------------------------------------
// Receipt template. Same visual language as the invoice, but a field list
// rather than an item table. The Amount is the anchor, the way TOTAL DUE
// anchors the invoice.
// ---------------------------------------------------------------------------

function generateReceiptPdf(receipt) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = 0;
    function ensure(height) {
      if (y + height > BODY_BOTTOM) {
        doc.addPage();
        y = CONT_TOP;
      }
    }

    drawHeaderBand(doc, 'FEE RECEIPT');

    // PAID badge, immediately under the accent rule on the right. A receipt
    // exists only because money was received, so this is a statement of fact
    // about the document — it says nothing about tax treatment.
    const badgeText = 'PAID';
    doc.font('Helvetica-Bold').fontSize(10);
    const badgeW = doc.widthOfString(badgeText, { characterSpacing: 1.5 }) + 30;
    const badgeH = 22;
    const badgeX = RIGHT - badgeW;
    doc.roundedRect(badgeX, BODY_TOP - 26, badgeW, badgeH, 11).fill(B.CYAN);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(B.NAVY).text(
      badgeText,
      badgeX,
      BODY_TOP - 19,
      { width: badgeW, align: 'center', characterSpacing: 1.5 }
    );

    y = drawMetaStrip(
      doc,
      [
        ['Receipt No', receipt.invoice_number],
        ['Issue Date', formatDate(receipt.issue_date)],
      ],
      BODY_TOP
    );

    y = drawPartyPanel(
      doc,
      'Received From',
      [
        ['Student', receipt.student_name],
        ['Parent', receipt.parent_name],
        ['Teacher', receipt.teacher_name], // omitted when null
      ],
      y
    );

    ensure(32);
    y = drawAnchorBox(doc, 'Amount', `${receipt.currency} ${money(receipt.amount)}`, y, {
      x: LEFT,
      w: CONTENT_W,
    });
    y += 24;

    const fields = [
      ['Payment Method', PAYMENT_METHOD_LABELS[receipt.payment_method] || receipt.payment_method],
      ['Payment Reference', receipt.payment_reference],        // omitted when null
      ['Against Invoice', receipt.against_invoice_number],     // omitted when null
      ['Description', receipt.fee_description],
    ];

    for (const [lbl, val] of fields) {
      if (val === null || val === undefined || val === '') continue;
      doc.font('Helvetica').fontSize(10);
      const valW = CONTENT_W - 150;
      const rowH = Math.max(26, doc.heightOfString(String(val), { width: valW }) + 14);
      ensure(rowH);
      label(doc, lbl, LEFT, y + 9, { width: 140 });
      value(doc, val, LEFT + 150, y + 6, { width: valW });
      doc.moveTo(LEFT, y + rowH).lineTo(RIGHT, y + rowH)
        .lineWidth(0.5).strokeColor(B.HAIRLINE).stroke();
      y += rowH;
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      drawFooter(
        doc,
        `This is a computer-generated receipt issued by ${B.BUSINESS_NAME}.`,
        receipt.invoice_number
      );
    }
    doc.flushPages();

    doc.end();
  });
}

module.exports = { generateReceiptPdf, generateInvoicePdf };
