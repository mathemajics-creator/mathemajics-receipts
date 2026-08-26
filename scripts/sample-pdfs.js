// scripts/sample-pdfs.js — regenerate the two sample PDFs in the repo root
// from fixed sample data. Nothing here touches the database: these are design
// samples, not issued documents, so no number is allocated and no row is read
// or written.
//
//   node scripts/sample-pdfs.js [outputDir]

const fs = require('fs');
const path = require('path');
const { generateInvoicePdf, generateReceiptPdf } = require('../pdf');

const SAMPLE_INVOICE = {
  invoice_number: 'INV-000001',
  issue_date: new Date(2026, 7, 1),   // 01 Aug 2026, local midnight
  due_date: new Date(2026, 7, 15),    // 15 Aug 2026
  student_name: 'Sample Student',
  parent_name: 'Sample Parent',
  parent_email: 'parent@example.com',
  teacher_name: 'Sample Teacher',
  line_items: [
    { description: 'August tuition — weekly 1:1 sessions', qty: 4, rate: 60, amount: 240 },
    { description: 'NAPLAN practice pack', qty: 2, rate: 12.5, amount: 25 },
  ],
  subtotal: 265,
  discount_label: 'Sibling discount',
  discount_amount: 15,
  total: 250,
  currency: 'AUD',
  fx_rate: 55.25,
  fx_source: 'ECB reference rate',
  fx_date: new Date(2026, 7, 1),
  fx_mode: 'payable',
  inr_amount: 13812.5,
  notes: 'Payable by bank transfer. Please quote the invoice number as the reference.',
};

// A second invoice whose only purpose is to show the thousands separators at a
// scale the ordinary sample never reaches. The figures are internally
// consistent (subtotal - discount = total, qty x rate = amount) so the sheet
// reads as a real document rather than a test fixture.
const SAMPLE_INVOICE_LARGE = {
  ...SAMPLE_INVOICE,
  invoice_number: 'INV-000002',
  line_items: [
    { description: 'Full-year 1:1 tuition programme', qty: 123, rate: 9999.5, amount: 1229938.5 },
    { description: 'Assessment and reporting package', qty: 2, rate: 8000, amount: 16000 },
  ],
  subtotal: 1245938.5,
  discount_label: 'Group discount',
  discount_amount: 11370.61,
  total: 1234567.89,
  inr_amount: 68209875.92,   // 1,234,567.89 x 55.25
};

const SAMPLE_RECEIPT = {
  invoice_number: 'RCPT-000001',
  issue_date: new Date(2026, 7, 16),  // 16 Aug 2026
  student_name: 'Sample Student',
  parent_name: 'Sample Parent',
  parent_email: 'parent@example.com',
  teacher_name: 'Sample Teacher',
  amount: 250,
  currency: 'AUD',
  payment_method: 'bank_transfer',
  payment_reference: 'TXN-SAMPLE-0001',
  against_invoice_number: 'INV-000001',
  fee_description: 'August tuition fees',
};

async function main() {
  const outDir = process.argv[2] || path.join(__dirname, '..');
  fs.mkdirSync(outDir, { recursive: true });

  const targets = [
    ['sample-invoice.pdf', await generateInvoicePdf(SAMPLE_INVOICE)],
    ['sample-receipt-against-invoice.pdf', await generateReceiptPdf(SAMPLE_RECEIPT)],
    ['sample-invoice-large.pdf', await generateInvoicePdf(SAMPLE_INVOICE_LARGE)],
  ];
  for (const [name, buf] of targets) {
    const dest = path.join(outDir, name);
    fs.writeFileSync(dest, buf);
    console.log(`wrote ${dest} (${buf.length} bytes)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

module.exports = { SAMPLE_INVOICE, SAMPLE_INVOICE_LARGE, SAMPLE_RECEIPT };
