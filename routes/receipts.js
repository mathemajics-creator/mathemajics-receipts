// routes/receipts.js — all receipt endpoints. Mounted at /api/receipts behind
// requireAdmin. The receipt row is the source of truth: once inserted it is
// never rolled back or deleted, whatever happens to PDF or email afterwards.

const express = require('express');
const db = require('../db');
const { validateReceiptInput } = require('../validate');
const { generateReceiptPdf } = require('../pdf');
const { sendReceiptEmail } = require('../email');
const { csvCell, isoDate } = require('../csv');

const router = express.Router();

// Every column except pdf_bytes — used by every read path.
const PUBLIC_COLUMNS =
  'id, invoice_number, issue_date, student_name, parent_name, parent_email, ' +
  'teacher_name, amount, currency, payment_method, payment_reference, ' +
  'fee_description, gst_treatment, invoice_id, status, void_reason, voided_at, ' +
  'email_sent_at, created_at';

// The PDF prints the invoice this payment settles, so the number (not just the
// id) has to travel with the row into the template.
async function withInvoiceNumber(receipt) {
  if (!receipt.invoice_id) return receipt;
  const { rows } = await db.pool.query('SELECT invoice_number FROM invoices WHERE id = $1', [
    receipt.invoice_id,
  ]);
  return rows.length === 0
    ? receipt
    : { ...receipt, against_invoice_number: rows[0].invoice_number };
}

async function fetchPublicRow(id) {
  const { rows } = await db.pool.query(
    `SELECT ${PUBLIC_COLUMNS} FROM receipts WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

function parseId(raw) {
  return /^\d+$/.test(raw) ? parseInt(raw, 10) : null;
}

function httpError(status, code) {
  const err = new Error(code);
  err.httpStatus = status;
  err.code = code;
  return err;
}

// Runs inside the insert transaction. Locking the invoice row here is what
// makes "one live receipt per invoice" hold under concurrency; throwing rolls
// the whole transaction back, so no receipt number is consumed.
async function checkInvoice(client, data) {
  const { rows } = await client.query(
    'SELECT id, status, currency FROM invoices WHERE id = $1 FOR UPDATE',
    [data.invoice_id]
  );
  if (rows.length === 0) throw httpError(404, 'invoice_not_found');
  const invoice = rows[0];
  if (invoice.status === 'voided') throw httpError(409, 'invoice_voided');
  if (invoice.currency !== data.currency) throw httpError(400, 'currency_mismatch');
  const live = await client.query(
    "SELECT 1 FROM receipts WHERE invoice_id = $1 AND status <> 'voided' LIMIT 1",
    [data.invoice_id]
  );
  if (live.rows.length > 0) throw httpError(409, 'invoice_already_paid');
}

// ── CREATE ──────────────────────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { errors, data } = validateReceiptInput(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ error: 'validation_failed', fields: errors });
    }

    // 1. Allocate number + insert (its own committed transaction). When the
    // payment settles an invoice, the invoice checks run inside that same
    // transaction with the invoice row locked, so a racing second receipt
    // cannot slip between the "already paid?" check and the insert — and a
    // failed check burns no receipt number.
    const client = await db.pool.connect();
    let receipt;
    try {
      receipt = await db.allocateReceiptNumberAndInsert(client, data, {
        beforeInsert: data.invoice_id === null ? undefined : (c) => checkInvoice(c, data),
      });
    } catch (err) {
      if (err && err.httpStatus) {
        return res.status(err.httpStatus).json({ error: err.code });
      }
      throw err;
    } finally {
      client.release();
    }

    // 2. PDF, then 3. email — failures leave the receipt standing (by design).
    const forPdf = await withInvoiceNumber(receipt);
    let pdfOk = false;
    let pdfBuffer = null;
    let emailed = false;
    let emailFailed = false;
    try {
      pdfBuffer = await generateReceiptPdf(forPdf);
      await db.pool.query('UPDATE receipts SET pdf_bytes = $1 WHERE id = $2', [
        pdfBuffer,
        receipt.id,
      ]);
      pdfOk = true;
    } catch (err) {
      console.error(`receipts: PDF generation failed for ${receipt.invoice_number}: ${err.message}`);
    }

    if (pdfOk) {
      try {
        await sendReceiptEmail(receipt, pdfBuffer);
        await db.pool.query(
          'UPDATE receipts SET email_sent_at = now() WHERE id = $1',
          [receipt.id]
        );
        emailed = true;
      } catch (err) {
        emailFailed = true;
        console.error(`receipts: email send failed for ${receipt.invoice_number}: ${err.message}`);
      }
    }

    const row = await fetchPublicRow(receipt.id);
    const payload = { receipt: row, emailed };
    if (!pdfOk) payload.pdf = false;
    if (emailFailed || (!emailed && pdfOk)) payload.email_error = 'send_failed';
    res.status(201).json(payload);
  } catch (err) {
    next(err);
  }
});

// ── CSV EXPORT (before /:id so "export.csv" is never read as an id) ─────────
router.get('/export.csv', async (req, res, next) => {
  try {
    const { rows } = await db.pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM receipts ORDER BY id`
    );
    const header = [
      'invoice_number', 'issue_date', 'student_name', 'parent_name', 'parent_email',
      'teacher_name', 'amount', 'currency', 'payment_method', 'payment_reference',
      'fee_description', 'gst_treatment', 'status', 'void_reason', 'voided_at',
      'email_sent_at', 'created_at',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.invoice_number, isoDate(r.issue_date), r.student_name, r.parent_name,
          r.parent_email, r.teacher_name, r.amount, r.currency, r.payment_method,
          r.payment_reference, r.fee_description, r.gst_treatment, r.status,
          r.void_reason,
          r.voided_at ? new Date(r.voided_at).toISOString() : null,
          r.email_sent_at ? new Date(r.email_sent_at).toISOString() : null,
          new Date(r.created_at).toISOString(),
        ]
          .map(csvCell)
          .join(',')
      );
    }
    const today = isoDate(new Date());
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="receipts-export-${today}.csv"`);
    res.send(lines.join('\r\n') + '\r\n');
  } catch (err) {
    next(err);
  }
});

// ── LIST ────────────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    let limit = 50;
    if (req.query.limit !== undefined) {
      if (!/^\d+$/.test(req.query.limit)) return res.status(400).json({ error: 'invalid_limit' });
      limit = Math.min(parseInt(req.query.limit, 10), 100);
      if (limit < 1) return res.status(400).json({ error: 'invalid_limit' });
    }
    let offset = 0;
    if (req.query.offset !== undefined) {
      if (!/^\d+$/.test(req.query.offset)) return res.status(400).json({ error: 'invalid_offset' });
      offset = parseInt(req.query.offset, 10);
    }
    const student = typeof req.query.student === 'string' && req.query.student.trim().length > 0
      ? req.query.student.trim()
      : null;
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const from = typeof req.query.from === 'string' && dateRe.test(req.query.from) ? req.query.from : null;
    const to = typeof req.query.to === 'string' && dateRe.test(req.query.to) ? req.query.to : null;
    if ((req.query.from !== undefined && !from) || (req.query.to !== undefined && !to)) {
      return res.status(400).json({ error: 'invalid_date_filter' });
    }
    let status = null;
    if (req.query.status !== undefined) {
      if (!['issued', 'voided'].includes(req.query.status)) {
        return res.status(400).json({ error: 'invalid_status' });
      }
      status = req.query.status;
    }
    // Escape LIKE wildcards so the search matches literally.
    const pattern = student === null ? null : '%' + student.replace(/[\\%_]/g, '\\$&') + '%';

    const { rows } = await db.pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM receipts
        WHERE ($1::text IS NULL OR student_name ILIKE $1 ESCAPE '\\')
          AND ($2::date IS NULL OR issue_date >= $2)
          AND ($3::date IS NULL OR issue_date <= $3)
          AND ($4::text IS NULL OR status = $4)
        ORDER BY id DESC
        LIMIT $5 OFFSET $6`,
      [pattern, from, to, status, limit, offset]
    );
    res.json({ receipts: rows, limit, offset });
  } catch (err) {
    next(err);
  }
});

// ── SINGLE ROW ──────────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: 'not_found' });
    const row = await fetchPublicRow(id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ receipt: row });
  } catch (err) {
    next(err);
  }
});

// ── PDF ─────────────────────────────────────────────────────────────────────
router.get('/:id/pdf', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: 'not_found' });
    const { rows } = await db.pool.query(
      'SELECT invoice_number, pdf_bytes FROM receipts WHERE id = $1',
      [id]
    );
    if (rows.length === 0 || !rows[0].pdf_bytes) {
      return res.status(404).json({ error: 'not_found' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${rows[0].invoice_number}.pdf"`);
    res.send(rows[0].pdf_bytes);
  } catch (err) {
    next(err);
  }
});

// ── VOID ────────────────────────────────────────────────────────────────────
router.post('/:id/void', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: 'not_found' });
    const reason =
      req.body && typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length === 0 || reason.length > 500) {
      return res.status(400).json({ error: 'invalid_reason' });
    }
    const existing = await fetchPublicRow(id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    if (existing.status === 'voided') return res.status(409).json({ error: 'already_voided' });

    await db.pool.query(
      `UPDATE receipts SET status = 'voided', void_reason = $1, voided_at = now()
        WHERE id = $2 AND status = 'issued'`,
      [reason, id]
    );
    const row = await fetchPublicRow(id);
    res.json({ receipt: row });
  } catch (err) {
    next(err);
  }
});

// ── RETRY EMAIL ─────────────────────────────────────────────────────────────
router.post('/:id/send-email', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: 'not_found' });
    const { rows } = await db.pool.query('SELECT * FROM receipts WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const receipt = rows[0];
    if (receipt.status === 'voided') return res.status(409).json({ error: 'voided' });
    if (receipt.email_sent_at) return res.status(409).json({ error: 'already_sent' });

    // Reuse stored bytes; only generate when the original PDF step failed.
    let pdfBuffer = receipt.pdf_bytes;
    if (!pdfBuffer) {
      pdfBuffer = await generateReceiptPdf(await withInvoiceNumber(receipt));
      await db.pool.query('UPDATE receipts SET pdf_bytes = $1 WHERE id = $2', [pdfBuffer, id]);
    }

    // Double-send guard: re-check immediately before sending.
    const check = await db.pool.query('SELECT email_sent_at FROM receipts WHERE id = $1', [id]);
    if (check.rows[0].email_sent_at) return res.status(409).json({ error: 'already_sent' });

    try {
      await sendReceiptEmail(receipt, pdfBuffer);
    } catch (err) {
      console.error(`receipts: retry email failed for ${receipt.invoice_number}: ${err.message}`);
      return res.status(502).json({ error: 'send_failed' });
    }
    await db.pool.query('UPDATE receipts SET email_sent_at = now() WHERE id = $1', [id]);
    const row = await fetchPublicRow(id);
    res.json({ receipt: row, emailed: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
