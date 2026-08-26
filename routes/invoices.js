// routes/invoices.js — all invoice endpoints. Mounted at /api/invoices behind
// requireAdmin. Like receipts, the invoice row is the source of truth: once
// inserted it is never rolled back or deleted, whatever happens to PDF or email
// afterwards.
//
// "Paid" is DERIVED, never stored: an invoice is paid when a non-voided receipt
// references it. That is what keeps the invoice row write-once.

const express = require('express');
const db = require('../db');
const { validateInvoiceInput } = require('../validate');
const { generateInvoicePdf } = require('../pdf');
const { sendInvoiceEmail } = require('../email');
const { csvCell, isoDate } = require('../csv');

const router = express.Router();

// Every column except pdf_bytes — used by every read path.
const PUBLIC_COLUMNS = [
  'id', 'invoice_number', 'issue_date', 'due_date', 'student_name', 'parent_name',
  'parent_email', 'teacher_name', 'line_items', 'subtotal', 'discount_label',
  'discount_amount', 'total', 'currency', 'fx_rate', 'fx_source', 'fx_date',
  'fx_mode', 'inr_amount', 'notes', 'status', 'void_reason', 'voided_at',
  'email_sent_at', 'created_at',
];
const PUBLIC_SELECT = PUBLIC_COLUMNS.map((c) => 'i.' + c).join(', ');

// The one live receipt against each invoice (voided ones do not count as payment).
const PAYMENT_JOIN = `
  LEFT JOIN LATERAL (
    SELECT id, invoice_number, amount, issue_date
      FROM receipts
     WHERE invoice_id = i.id AND status <> 'voided'
     ORDER BY id
     LIMIT 1
  ) r ON TRUE`;

function parseId(raw) {
  return /^\d+$/.test(raw) ? parseInt(raw, 10) : null;
}

async function fetchPublicRow(id) {
  const { rows } = await db.pool.query(
    `SELECT ${PUBLIC_SELECT}, (r.id IS NOT NULL) AS paid, r.invoice_number AS receipt_number
       FROM invoices i ${PAYMENT_JOIN}
      WHERE i.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// ── CREATE ──────────────────────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { errors, data } = validateInvoiceInput(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ error: 'validation_failed', fields: errors });
    }

    // 1. Allocate number + insert (its own committed transaction).
    const client = await db.pool.connect();
    let invoice;
    try {
      invoice = await db.allocateInvoiceNumberAndInsert(client, data);
    } finally {
      client.release();
    }

    // 2. PDF, then 3. email — failures leave the invoice standing (by design).
    let pdfOk = false;
    let pdfBuffer = null;
    let emailed = false;
    let emailFailed = false;
    try {
      pdfBuffer = await generateInvoicePdf(invoice);
      await db.pool.query('UPDATE invoices SET pdf_bytes = $1 WHERE id = $2', [
        pdfBuffer,
        invoice.id,
      ]);
      pdfOk = true;
    } catch (err) {
      console.error(`invoices: PDF generation failed for ${invoice.invoice_number}: ${err.message}`);
    }

    if (pdfOk) {
      try {
        await sendInvoiceEmail(invoice, pdfBuffer);
        await db.pool.query('UPDATE invoices SET email_sent_at = now() WHERE id = $1', [
          invoice.id,
        ]);
        emailed = true;
      } catch (err) {
        emailFailed = true;
        console.error(`invoices: email send failed for ${invoice.invoice_number}: ${err.message}`);
      }
    }

    const row = await fetchPublicRow(invoice.id);
    const payload = { invoice: row, emailed };
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
      `SELECT ${PUBLIC_SELECT}, (r.id IS NOT NULL) AS paid,
              r.invoice_number AS receipt_number, r.amount AS receipt_amount,
              r.issue_date AS receipt_date
         FROM invoices i ${PAYMENT_JOIN}
        ORDER BY i.id`
    );
    const header = [
      'invoice_number', 'issue_date', 'due_date', 'student_name', 'parent_name',
      'parent_email', 'teacher_name', 'line_items', 'subtotal', 'discount_label',
      'discount_amount', 'total', 'currency', 'fx_rate', 'fx_source', 'fx_date',
      'fx_mode', 'inr_amount', 'status', 'void_reason', 'voided_at',
      'email_sent_at', 'created_at',
      // Reconciliation columns — what the accountant matches payments on.
      'paid', 'receipt_number', 'receipt_amount', 'receipt_date',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.invoice_number, isoDate(r.issue_date), isoDate(r.due_date), r.student_name,
          r.parent_name, r.parent_email, r.teacher_name, JSON.stringify(r.line_items),
          r.subtotal, r.discount_label, r.discount_amount, r.total, r.currency,
          r.fx_rate, r.fx_source, isoDate(r.fx_date), r.fx_mode, r.inr_amount,
          r.status, r.void_reason,
          r.voided_at ? new Date(r.voided_at).toISOString() : null,
          r.email_sent_at ? new Date(r.email_sent_at).toISOString() : null,
          new Date(r.created_at).toISOString(),
          r.paid, r.receipt_number, r.receipt_amount, isoDate(r.receipt_date),
        ]
          .map(csvCell)
          .join(',')
      );
    }
    const today = isoDate(new Date());
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="invoices-export-${today}.csv"`);
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
    let paid = null;
    if (req.query.paid !== undefined) {
      if (!['true', 'false'].includes(req.query.paid)) {
        return res.status(400).json({ error: 'invalid_paid_filter' });
      }
      paid = req.query.paid === 'true';
    }
    // Escape LIKE wildcards so the search matches literally.
    const pattern = student === null ? null : '%' + student.replace(/[\\%_]/g, '\\$&') + '%';

    const { rows } = await db.pool.query(
      `SELECT ${PUBLIC_SELECT}, (r.id IS NOT NULL) AS paid, r.invoice_number AS receipt_number
         FROM invoices i ${PAYMENT_JOIN}
        WHERE ($1::text IS NULL OR i.student_name ILIKE $1 ESCAPE '\\')
          AND ($2::date IS NULL OR i.issue_date >= $2)
          AND ($3::date IS NULL OR i.issue_date <= $3)
          AND ($4::text IS NULL OR i.status = $4)
          AND ($5::boolean IS NULL OR (r.id IS NOT NULL) = $5)
        ORDER BY i.id DESC
        LIMIT $6 OFFSET $7`,
      [pattern, from, to, status, paid, limit, offset]
    );
    res.json({ invoices: rows, limit, offset });
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
    res.json({ invoice: row });
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
      'SELECT invoice_number, pdf_bytes FROM invoices WHERE id = $1',
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
// An invoice with a live receipt against it must not be voidable: an
// unpaid-looking invoice with a real payment attached is exactly the
// inconsistency an audit would flag. The invoice row is locked for the check so
// a receipt cannot be created in the gap between check and void.
router.post('/:id/void', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: 'not_found' });
    const reason =
      req.body && typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length === 0 || reason.length > 500) {
      return res.status(400).json({ error: 'invalid_reason' });
    }

    const client = await db.pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT id, status FROM invoices WHERE id = $1 FOR UPDATE',
        [id]
      );
      if (existing.rows.length === 0) {
        result = { status: 404, body: { error: 'not_found' } };
      } else if (existing.rows[0].status === 'voided') {
        result = { status: 409, body: { error: 'already_voided' } };
      } else {
        const live = await client.query(
          "SELECT 1 FROM receipts WHERE invoice_id = $1 AND status <> 'voided' LIMIT 1",
          [id]
        );
        if (live.rows.length > 0) {
          result = { status: 409, body: { error: 'invoice_has_receipt' } };
        } else {
          await client.query(
            `UPDATE invoices SET status = 'voided', void_reason = $1, voided_at = now()
              WHERE id = $2 AND status = 'issued'`,
            [reason, id]
          );
          result = null;
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (result) return res.status(result.status).json(result.body);
    const row = await fetchPublicRow(id);
    res.json({ invoice: row });
  } catch (err) {
    next(err);
  }
});

// ── RETRY EMAIL ─────────────────────────────────────────────────────────────
router.post('/:id/send-email', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (id === null) return res.status(404).json({ error: 'not_found' });
    const { rows } = await db.pool.query('SELECT * FROM invoices WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const invoice = rows[0];
    if (invoice.status === 'voided') return res.status(409).json({ error: 'voided' });
    if (invoice.email_sent_at) return res.status(409).json({ error: 'already_sent' });

    // Reuse stored bytes; only generate when the original PDF step failed.
    let pdfBuffer = invoice.pdf_bytes;
    if (!pdfBuffer) {
      pdfBuffer = await generateInvoicePdf(invoice);
      await db.pool.query('UPDATE invoices SET pdf_bytes = $1 WHERE id = $2', [pdfBuffer, id]);
    }

    // Double-send guard: re-check immediately before sending.
    const check = await db.pool.query('SELECT email_sent_at FROM invoices WHERE id = $1', [id]);
    if (check.rows[0].email_sent_at) return res.status(409).json({ error: 'already_sent' });

    try {
      await sendInvoiceEmail(invoice, pdfBuffer);
    } catch (err) {
      console.error(`invoices: retry email failed for ${invoice.invoice_number}: ${err.message}`);
      return res.status(502).json({ error: 'send_failed' });
    }
    await db.pool.query('UPDATE invoices SET email_sent_at = now() WHERE id = $1', [id]);
    const row = await fetchPublicRow(id);
    res.json({ invoice: row, emailed: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
