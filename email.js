// email.js — Gmail SMTP sending via nodemailer. The transport is injectable so
// tests substitute a stub; real SMTP is only built from env vars at runtime.

const nodemailer = require('nodemailer');

// The same formatters the PDF uses. An email body that disagreed with the
// document attached to it — about an amount or about a day — would read as an
// error to the parent.
const { money, longDate } = require('./format');

let transport = null;

// Tests inject a fake here ({ sendMail: async (msg) => ... }). Pass null to
// reset back to the env-built real transport.
function setTransport(t) {
  transport = t;
}

function getTransport() {
  if (transport) return transport;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    // Fail closed into the generic send-failure path; the receipt is still recorded.
    throw new Error('email transport not configured');
  }
  transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  });
  return transport;
}

async function sendReceiptEmail(receipt, pdfBuffer) {
  const t = getTransport();
  const from = `"Mathemajics" <${process.env.GMAIL_USER || 'receipts@mathemajics.invalid'}>`;
  await t.sendMail({
    from,
    to: receipt.parent_email,
    subject: `Fee Receipt ${receipt.invoice_number} — Mathemajics`,
    text:
      `Dear ${receipt.parent_name},\n\n` +
      `Thank you for your payment. Receipt ${receipt.invoice_number} for ` +
      `${receipt.student_name} — ${receipt.currency} ${money(receipt.amount)} ` +
      `(${receipt.fee_description}) — is attached as a PDF.\n\n` +
      `Warm regards,\nMathemajics`,
    attachments: [
      {
        filename: `${receipt.invoice_number}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });
}

const formatDueDate = longDate;

async function sendInvoiceEmail(invoice, pdfBuffer) {
  const t = getTransport();
  const from = `"Mathemajics" <${process.env.GMAIL_USER || 'receipts@mathemajics.invalid'}>`;
  await t.sendMail({
    from,
    to: invoice.parent_email,
    subject: `Invoice ${invoice.invoice_number} — Mathemajics`,
    text:
      `Dear ${invoice.parent_name},\n\n` +
      `Invoice ${invoice.invoice_number} for ${invoice.student_name} — ` +
      `${invoice.currency} ${money(invoice.total)} — is due on ` +
      `${formatDueDate(invoice.due_date)}. The invoice is attached as a PDF.\n\n` +
      `Warm regards,\nMathemajics`,
    attachments: [
      {
        filename: `${invoice.invoice_number}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });
}

module.exports = { setTransport, sendReceiptEmail, sendInvoiceEmail };
