// db.js — PostgreSQL access layer. All queries parameterized; no string-built SQL.

require('dotenv').config();
const { Pool, types } = require('pg');

// ---------------------------------------------------------------------------
// DATE columns come back as plain 'YYYY-MM-DD' strings, not Date objects.
//
// By default node-postgres turns a DATE into a JS Date at the *server's* local
// midnight. That object then serializes to JSON as a full UTC timestamp
// ("2026-08-25T00:00:00.000Z", or "2026-08-24T14:00:00.000Z" from a UTC+10
// host), and whoever reads it has to guess which timezone to undo. A browser
// west of the server would render the previous day — a silently wrong date on
// a financial record, which is the one kind of wrong these documents may never
// be.
//
// A DATE has no time and no timezone: 25 August 2026 is the same day
// everywhere. Handing the string straight through is the only representation
// that cannot drift, and it is what every surface already wants — the JSON
// responses, the CSV exports, and format.js for the PDFs and emails.
//
// This changes nothing in the database and nothing about what is stored; only
// how a value is handed to this process. TIMESTAMPTZ columns (created_at,
// voided_at, email_sent_at) are a different OID and keep their Date objects —
// those really are moments in time.
//
// The parser hands back the RAW string the server sent, so the format of that
// string must not depend on a server-side setting. Postgres renders a DATE
// according to DateStyle: the default is ISO ('2026-08-25'), but a server, a
// database, a role or a connection can be set to German ('25.08.2026') or SQL
// ('08/25/2026'), and then every date this API emits changes shape without a
// line of code changing. DATESTYLE below pins it on the connection itself, so
// the wire format is a property of this application rather than of whatever
// host it happens to be pointed at — the same argument format.js makes for not
// using toLocaleString.
types.setTypeParser(types.builtins.DATE, (value) => value); // OID 1082

// Sent in the startup packet, which means it is in force before the first query
// can run. A `SET` in a pool 'connect' handler would leave a window: node-pg
// does not await that handler before handing the client out.
const DATESTYLE = '-c datestyle=ISO,MDY';

// TLS to the database.
//
// The default follows NODE_ENV, which is what a real deployment wants: Railway
// reaches Postgres over TLS with a certificate no public CA signed, so
// verification is off while the connection is still encrypted.
//
// An explicit `sslmode` in DATABASE_URL overrides that default. It is the
// standard libpq parameter, so it is what anyone would reach for, and it earns
// its place twice: a local Postgres normally has SSL switched off altogether
// and refuses the negotiation outright ("The server does not support SSL
// connections"), so `?sslmode=disable` is what lets the deployment simulation
// run the real production code path against a throwaway local database; and a
// deployment whose database does not offer TLS can say so without a code edit.
function databaseSsl(url = process.env.DATABASE_URL || '') {
  const mode = (/[?&]sslmode=([^&]+)/.exec(url) || [])[1];
  if (mode === 'disable') return false;
  if (mode !== undefined) return { rejectUnauthorized: mode === 'verify-full' };
  return process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: databaseSsl(),
  keepAlive: true,
  options: DATESTYLE,
});

// Without this, an error on an idle pooled connection (e.g. the DB dropping
// it) is an unhandled 'error' event and kills the whole process.
pool.on('error', (err) => {
  console.error('pg pool: idle client error:', err.message);
});

function formatInvoiceNumber(n) {
  return 'RCPT-' + String(n).padStart(6, '0');
}

function formatInvoiceDocNumber(n) {
  return 'INV-' + String(n).padStart(6, '0');
}

// ---------------------------------------------------------------------------
// Sequential document numbering.
//
// Race-safe allocation + insert, all in one transaction on the caller's client.
// The row lock on the counter serializes concurrent allocations; a failed insert
// rolls the counter back too, so a number is never consumed without a document
// existing for it (no gaps, no reuse).
//
// Receipts and invoices share this helper — only the counter table, prefix,
// target table and column list differ. Those are the internal constants below,
// never request data, so interpolating them into the SQL adds no injection
// surface; every value is still passed as a bound parameter.
// ---------------------------------------------------------------------------

const RECEIPT_SERIES = {
  counterTable: 'receipt_counter',
  table: 'receipts',
  format: formatInvoiceNumber,
  columns: [
    'issue_date', 'student_name', 'parent_name', 'parent_email', 'teacher_name',
    'amount', 'currency', 'payment_method', 'payment_reference', 'fee_description',
    'gst_treatment', 'invoice_id',
  ],
};

const INVOICE_SERIES = {
  counterTable: 'invoice_counter',
  table: 'invoices',
  format: formatInvoiceDocNumber,
  columns: [
    'issue_date', 'due_date', 'student_name', 'parent_name', 'parent_email',
    'teacher_name', 'line_items', 'subtotal', 'discount_label', 'discount_amount',
    'total', 'currency', 'fx_rate', 'fx_source', 'fx_date', 'fx_mode',
    'inr_amount', 'notes',
  ],
};

// line_items is JSONB: node-pg would render a JS array as a Postgres array
// literal, so it is serialized explicitly.
function bindValue(column, value) {
  if (column === 'line_items') return value === null ? null : JSON.stringify(value);
  return value;
}

// opts.beforeInsert(client) runs INSIDE the transaction, before the counter is
// locked. It is how a caller enforces a cross-document invariant (e.g. "this
// invoice is not already paid") atomically: throwing from it rolls the whole
// transaction back, so no number is burned and no racing request can slip
// between the check and the insert.
async function allocateNumberAndInsert(series, client, data, opts = {}) {
  try {
    await client.query('BEGIN');

    if (typeof opts.beforeInsert === 'function') {
      await opts.beforeInsert(client);
    }

    const { rows } = await client.query(
      `SELECT last_number FROM ${series.counterTable} WHERE id = 1 FOR UPDATE`
    );
    const next = rows[0].last_number + 1;
    const documentNumber = series.format(next);

    await client.query(
      `UPDATE ${series.counterTable} SET last_number = $1 WHERE id = 1`,
      [next]
    );

    const columns = ['invoice_number', ...series.columns];
    const placeholders = columns.map((_, i) => '$' + (i + 1)).join(', ');
    const values = [
      documentNumber,
      ...series.columns.map((c) => bindValue(c, data[c] ?? null)),
    ];

    const inserted = await client.query(
      `INSERT INTO ${series.table} (${columns.join(', ')})
       VALUES (${placeholders})
       RETURNING *`,
      values
    );

    await client.query('COMMIT');
    return inserted.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

function allocateReceiptNumberAndInsert(client, receiptData, opts) {
  return allocateNumberAndInsert(RECEIPT_SERIES, client, receiptData, opts);
}

function allocateInvoiceNumberAndInsert(client, invoiceData, opts) {
  return allocateNumberAndInsert(INVOICE_SERIES, client, invoiceData, opts);
}

async function ping() {
  await pool.query('SELECT 1');
}

module.exports = {
  pool,
  allocateReceiptNumberAndInsert,
  allocateInvoiceNumberAndInsert,
  ping,
  formatInvoiceNumber,
  formatInvoiceDocNumber,
  databaseSsl, // exported for the deployment tests
};
