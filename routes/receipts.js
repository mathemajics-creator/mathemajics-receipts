// routes/receipts.js — all receipt endpoints. Mounted at /api/receipts behind
// requireAdmin. The receipt row is the source of truth: once inserted it is
// never rolled back or deleted, whatever happens to PDF or email afterwards.

const express = require('express');
const db = require('../db');
const { validateReceiptInput } = require('../validate');
const { generateReceiptPdf } = require('../pdf');
const { sendReceiptEmail } = require('../email');

const router = express.Router();

// Every column except pdf_bytes — used by every read path.
const PUBLIC_COLUMNS =
  'id, invoice_number, issue_date, student_name, parent_name, parent_email, ' +
  'teacher_name, amount, currency, payment_method, payment_reference, ' +
  'fee_description, gst_treatment, status, void_reason, voided_at, ' +
  'email_sent_at, created_at';

function isoDate(d) {
  if (d === null || d === undefined) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
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

// ── CREATE ──────────────────────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { errors, data } = validateReceiptInput(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ error: 'validation_failed', fields: errors });
    }

    // 1. Allocate number + insert (its own committed transaction).
    const client = await db.pool.connect();
    let receipt;
    try {
      receipt = await db.allocateReceiptNumberAndInsert(client, data);
    } finally {
      client.release();
    }

    // 2. PDF, then 3. email — failures leave the receipt standing (by design).
    let pdfOk = false;
    let pdfBuffer = null;
    let emailed = false;
    let emailFailed = false;
    try {
      pdfBuffer = await generateReceiptPdf(receipt);
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
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // Formula-injection defense first, then RFC-4180 quoting.
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

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
      pdfBuffer = await generateReceiptPdf(receipt);
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
