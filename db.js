// db.js — PostgreSQL access layer. All queries parameterized; no string-built SQL.

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  keepAlive: true,
});

function formatInvoiceNumber(n) {
  return 'RCPT-' + String(n).padStart(6, '0');
}

// Race-safe sequential allocation + insert, all in one transaction on the
// caller's client. The row lock on receipt_counter serializes concurrent
// allocations; a failed insert rolls the counter back too, so a number is
// never consumed without a receipt existing for it (no gaps, no reuse).
async function allocateReceiptNumberAndInsert(client, receiptData) {
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT last_number FROM receipt_counter WHERE id = 1 FOR UPDATE'
    );
    const next = rows[0].last_number + 1;
    const invoiceNumber = formatInvoiceNumber(next);

    await client.query('UPDATE receipt_counter SET last_number = $1 WHERE id = 1', [next]);

    const inserted = await client.query(
      `INSERT INTO receipts
         (invoice_number, issue_date, student_name, parent_name, parent_email,
          teacher_name, amount, currency, payment_method, payment_reference,
          fee_description, gst_treatment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        invoiceNumber,
        receiptData.issue_date,
        receiptData.student_name,
        receiptData.parent_name,
        receiptData.parent_email,
        receiptData.teacher_name ?? null,
        receiptData.amount,
        receiptData.currency,
        receiptData.payment_method,
        receiptData.payment_reference ?? null,
        receiptData.fee_description,
        receiptData.gst_treatment ?? null,
      ]
    );

    await client.query('COMMIT');
    return inserted.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function ping() {
  await pool.query('SELECT 1');
}

module.exports = { pool, allocateReceiptNumberAndInsert, ping, formatInvoiceNumber };
