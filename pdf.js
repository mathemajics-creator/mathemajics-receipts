// pdf.js — receipt and invoice PDF generation with pdfkit. A4, deterministic
// layout from row data only: built-in fonts, no network, no images.
// No tax, GST or ABN wording appears in either template, by design.

const PDFDocument = require('pdfkit');

const NAVY = '#0D1B2E';
const CYAN = '#00BCD4';
const GREY = '#555555';

const PAYMENT_METHOD_LABELS = {
  bank_transfer: 'Bank transfer',
  paypal: 'PayPal',
  upi: 'UPI',
  other: 'Other',
};

function formatDate(d) {
  // issue_date arrives from Postgres as a Date at local midnight — format
  // locally (toISOString would shift the day in non-UTC timezones).
  const dt = d instanceof Date ? d : new Date(d);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${String(dt.getDate()).padStart(2, '0')} ${months[dt.getMonth()]} ${dt.getFullYear()}`;
}

function generateReceiptPdf(receipt) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 50;
    const right = 545;

    // Header
    doc.font('Helvetica-Bold').fontSize(22).fillColor(NAVY).text('MATHEMAJICS', left, 60);
    doc.font('Helvetica').fontSize(9).fillColor(GREY)
      .text('Unlocking the Magic of Maths', left, 86);
    doc.moveTo(left, 104).lineTo(right, 104).lineWidth(2).strokeColor(CYAN).stroke();
    doc.font('Helvetica-Bold').fontSize(14).fillColor(NAVY).text('FEE RECEIPT', left, 116);

    // Field rows
    const fields = [
      ['Receipt No', receipt.invoice_number],
      ['Issue Date', formatDate(receipt.issue_date)],
      ['Student', receipt.student_name],
      ['Parent', receipt.parent_name],
      ['Teacher', receipt.teacher_name],           // omitted below if null
      ['Amount', `${receipt.currency} ${Number(receipt.amount).toFixed(2)}`],
      ['Payment Method', PAYMENT_METHOD_LABELS[receipt.payment_method] || receipt.payment_method],
      ['Payment Reference', receipt.payment_reference], // omitted below if null
      ['Against Invoice', receipt.against_invoice_number], // omitted below if null
      ['Description', receipt.fee_description],
    ];

    let y = 156;
    for (const [label, value] of fields) {
      if (value === null || value === undefined || value === '') continue;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(GREY).text(label, left, y, { width: 140 });
      doc.font('Helvetica').fontSize(10).fillColor(NAVY)
        .text(String(value), left + 150, y, { width: right - left - 150 });
      const used = doc.heightOfString(String(value), { width: right - left - 150 });
      y += Math.max(20, used + 8);
    }

    // Footer
    doc.moveTo(left, 760).lineTo(right, 760).lineWidth(1).strokeColor(CYAN).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(GREY)
      .text('This is a computer-generated receipt issued by Mathemajics.', left, 768, {
        width: right - left,
        align: 'center',
      });
    doc.fontSize(7).text(receipt.invoice_number, left, 780, {
      width: right - left,
      align: 'center',
    });

    doc.end();
  });
}

// ---------------------------------------------------------------------------
// Invoice template. Same visual family as the receipt, but a flowing layout:
// the line-item table can be up to 20 rows with wrapping descriptions, so the
// cursor may run onto a second page and the footer is stamped on every page.
// ---------------------------------------------------------------------------

const LEFT = 50;
const RIGHT = 545;
const BODY_BOTTOM = 730;

function money(v) {
  return Number(v).toFixed(2);
}

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

function drawInvoiceFooter(doc, invoice) {
  doc.moveTo(LEFT, 760).lineTo(RIGHT, 760).lineWidth(1).strokeColor(CYAN).stroke();
  doc.font('Helvetica').fontSize(8).fillColor(GREY)
    .text('This is a computer-generated invoice issued by Mathemajics.', LEFT, 768, {
      width: RIGHT - LEFT,
      align: 'center',
    });
  doc.fontSize(7).text(invoice.invoice_number, LEFT, 780, {
    width: RIGHT - LEFT,
    align: 'center',
  });
}

function generateInvoicePdf(invoice) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = 0;

    // Adds a page when the next block would run past the footer rule.
    function ensure(height) {
      if (y + height > BODY_BOTTOM) {
        doc.addPage();
        y = 60;
      }
    }

    function field(label, value) {
      if (value === null || value === undefined || value === '') return;
      ensure(24);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(GREY).text(label, LEFT, y, { width: 140 });
      doc.font('Helvetica').fontSize(10).fillColor(NAVY)
        .text(String(value), LEFT + 150, y, { width: RIGHT - LEFT - 150 });
      const used = doc.heightOfString(String(value), { width: RIGHT - LEFT - 150 });
      y += Math.max(20, used + 8);
    }

    function sectionTitle(text) {
      ensure(30);
      y += 6;
      doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY).text(text, LEFT, y);
      y += 18;
    }

    // ── Header ──────────────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(22).fillColor(NAVY).text('MATHEMAJICS', LEFT, 60);
    doc.font('Helvetica').fontSize(9).fillColor(GREY)
      .text('Unlocking the Magic of Maths', LEFT, 86);
    doc.moveTo(LEFT, 104).lineTo(RIGHT, 104).lineWidth(2).strokeColor(CYAN).stroke();
    doc.font('Helvetica-Bold').fontSize(14).fillColor(NAVY).text('INVOICE', LEFT, 116);

    y = 156;
    field('Invoice No', invoice.invoice_number);
    field('Issue Date', formatDate(invoice.issue_date));
    field('Due Date', formatDate(invoice.due_date));
    field('Currency', invoice.currency);

    // ── Bill to ─────────────────────────────────────────────────────────────
    sectionTitle('Bill To');
    field('Parent', invoice.parent_name);
    field('Student', invoice.student_name);
    field('Teacher', invoice.teacher_name); // omitted when null

    // ── Line items ──────────────────────────────────────────────────────────
    const colDesc = LEFT;
    const descWidth = 250;
    const colQty = LEFT + 270;
    const colRate = LEFT + 330;
    const colAmount = LEFT + 420;
    const numWidth = 75;

    y += 10;
    ensure(30);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(GREY);
    doc.text('DESCRIPTION', colDesc, y, { width: descWidth });
    doc.text('QTY', colQty, y, { width: 50, align: 'right' });
    doc.text('RATE', colRate, y, { width: numWidth, align: 'right' });
    doc.text('AMOUNT', colAmount, y, { width: numWidth, align: 'right' });
    y += 14;
    doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(0.5).strokeColor(CYAN).stroke();
    y += 8;

    const items = Array.isArray(invoice.line_items) ? invoice.line_items : [];
    for (const item of items) {
      const desc = String(item.description);
      doc.font('Helvetica').fontSize(10);
      const rowHeight = Math.max(18, doc.heightOfString(desc, { width: descWidth }) + 6);
      ensure(rowHeight);
      doc.fillColor(NAVY).text(desc, colDesc, y, { width: descWidth });
      doc.text(qtyText(item.qty), colQty, y, { width: 50, align: 'right' });
      doc.text(money(item.rate), colRate, y, { width: numWidth, align: 'right' });
      doc.text(money(item.amount), colAmount, y, { width: numWidth, align: 'right' });
      y += rowHeight;
    }

    y += 4;
    ensure(20);
    doc.moveTo(colRate, y).lineTo(RIGHT, y).lineWidth(0.5).strokeColor(CYAN).stroke();
    y += 8;

    function totalRow(label, value, bold) {
      ensure(20);
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10)
        .fillColor(bold ? NAVY : GREY)
        .text(label, colQty - 60, y, { width: colAmount - colQty + 55, align: 'right' });
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(NAVY)
        .text(value, colAmount, y, { width: numWidth, align: 'right' });
      y += bold ? 22 : 18;
    }

    totalRow('Subtotal', `${invoice.currency} ${money(invoice.subtotal)}`, false);
    if (invoice.discount_amount !== null && invoice.discount_amount !== undefined) {
      totalRow(
        `Discount (${invoice.discount_label})`,
        `- ${invoice.currency} ${money(invoice.discount_amount)}`,
        false
      );
    }
    totalRow('TOTAL DUE', `${invoice.currency} ${money(invoice.total)}`, true);

    // ── FX block ────────────────────────────────────────────────────────────
    if (invoice.fx_rate !== null && invoice.fx_rate !== undefined) {
      y += 8;
      ensure(60);
      const headline =
        invoice.fx_mode === 'payable'
          ? `AMOUNT PAYABLE IN INR: INR ${money(invoice.inr_amount)}`
          : `INR EQUIVALENT: INR ${money(invoice.inr_amount)}`;
      doc.font('Helvetica-Bold').fontSize(11).fillColor(NAVY)
        .text(headline, LEFT, y, { width: RIGHT - LEFT });
      y += 18;
      if (invoice.fx_mode === 'indicative') {
        doc.font('Helvetica').fontSize(9).fillColor(GREY)
          .text(`Indicative only; payable amount is ${invoice.currency}.`, LEFT, y, {
            width: RIGHT - LEFT,
          });
        y += 14;
      }
      doc.font('Helvetica').fontSize(9).fillColor(GREY)
        .text(
          `1 ${invoice.currency} = INR ${rateText(invoice.fx_rate)} ` +
            `(${invoice.fx_source}, ${formatDate(invoice.fx_date)})`,
          LEFT,
          y,
          { width: RIGHT - LEFT }
        );
      y += 16;
    }

    // ── Notes (owner-supplied only) ─────────────────────────────────────────
    if (invoice.notes) {
      sectionTitle('Notes');
      const notes = String(invoice.notes);
      doc.font('Helvetica').fontSize(10);
      const h = doc.heightOfString(notes, { width: RIGHT - LEFT });
      ensure(h + 6);
      doc.fillColor(NAVY).text(notes, LEFT, y, { width: RIGHT - LEFT });
      y += h + 6;
    }

    // ── Footer on every page ────────────────────────────────────────────────
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      drawInvoiceFooter(doc, invoice);
    }
    doc.flushPages();

    doc.end();
  });
}

module.exports = { generateReceiptPdf, generateInvoicePdf };
