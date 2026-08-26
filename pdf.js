// pdf.js — receipt PDF generation with pdfkit. One A4 page, deterministic
// layout from row data only: built-in fonts, no network, no images.

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

module.exports = { generateReceiptPdf };
