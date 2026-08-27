// validate.js — whitelist validation for receipt and invoice creation. Unknown
// fields are rejected (including gst_treatment, which stays NULL pending CA
// confirmation, and any tax/GST field, which this tool does not accept at all).

const ALLOWED = new Set([
  'issue_date', 'student_name', 'parent_name', 'parent_email', 'teacher_name',
  'amount', 'currency', 'payment_method', 'payment_reference', 'fee_description',
  'invoice_id',
]);
const REQUIRED_STRINGS = [
  ['student_name', 200],
  ['parent_name', 200],
  ['fee_description', 500],
];
const OPTIONAL_STRINGS = [
  ['teacher_name', 200],
  ['payment_reference', 200],
];
const CURRENCIES = new Set(['USD', 'AUD', 'INR']);
const PAYMENT_METHODS = new Set(['bank_transfer', 'paypal', 'upi', 'other']);

// Single syntactically-plausible address; commas/semicolons/whitespace rejected
// outright, which also forecloses recipient-list and header injection.
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isRealDate(iso) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(y, mo - 1, da);
  return d.getFullYear() === y && d.getMonth() === mo - 1 && d.getDate() === da;
}

// Returns { errors, data }. data only meaningful when errors is empty.
function validateReceiptInput(body) {
  const errors = [];
  const data = {};

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [{ field: 'body', error: 'must_be_json_object' }], data };
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED.has(key)) errors.push({ field: key, error: 'unknown_field' });
  }

  for (const [field, maxLen] of REQUIRED_STRINGS) {
    const v = body[field];
    if (typeof v !== 'string' || v.trim().length === 0) {
      errors.push({ field, error: 'required' });
    } else if (v.trim().length > maxLen) {
      errors.push({ field, error: 'too_long' });
    } else {
      data[field] = v.trim();
    }
  }

  for (const [field, maxLen] of OPTIONAL_STRINGS) {
    const v = body[field];
    if (v === undefined || v === null) { data[field] = null; continue; }
    if (typeof v !== 'string') { errors.push({ field, error: 'must_be_string' }); continue; }
    const t = v.trim();
    if (t.length > maxLen) { errors.push({ field, error: 'too_long' }); continue; }
    data[field] = t.length > 0 ? t : null;
  }

  const email = body.parent_email;
  if (typeof email !== 'string' || email.trim().length === 0) {
    errors.push({ field: 'parent_email', error: 'required' });
  } else if (email.trim().length > 200 || !EMAIL_RE.test(email.trim())) {
    errors.push({ field: 'parent_email', error: 'invalid_email' });
  } else {
    data.parent_email = email.trim();
  }

  const issueDate = body.issue_date;
  if (typeof issueDate !== 'string' || !isRealDate(issueDate)) {
    errors.push({ field: 'issue_date', error: 'invalid_date' });
  } else if (issueDate > localToday()) {
    errors.push({ field: 'issue_date', error: 'in_future' });
  } else if (issueDate < '2020-01-01') {
    errors.push({ field: 'issue_date', error: 'too_old' });
  } else {
    data.issue_date = issueDate;
  }

  const amount = body.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    errors.push({ field: 'amount', error: 'invalid_amount' });
  } else if (amount > 1000000) {
    errors.push({ field: 'amount', error: 'too_large' });
  } else if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
    errors.push({ field: 'amount', error: 'max_2_decimals' });
  } else {
    data.amount = amount;
  }

  if (!CURRENCIES.has(body.currency)) {
    errors.push({ field: 'currency', error: 'invalid_currency' });
  } else {
    data.currency = body.currency;
  }

  if (!PAYMENT_METHODS.has(body.payment_method)) {
    errors.push({ field: 'payment_method', error: 'invalid_payment_method' });
  } else {
    data.payment_method = body.payment_method;
  }

  // Optional link back to the invoice this payment settles. Existence,
  // void-state, already-paid and currency checks happen in the route, inside
  // the insert transaction.
  const invoiceId = body.invoice_id;
  if (invoiceId === undefined || invoiceId === null) {
    data.invoice_id = null;
  } else if (!Number.isInteger(invoiceId) || invoiceId < 1) {
    errors.push({ field: 'invoice_id', error: 'invalid_invoice_id' });
  } else {
    data.invoice_id = invoiceId;
  }

  // gst_treatment is never accepted from the request (rejected above as an
  // unknown field); it is always inserted as NULL this session.
  data.gst_treatment = null;

  return { errors, data };
}

// ── invoices ────────────────────────────────────────────────────────────────

const INVOICE_ALLOWED = new Set([
  'issue_date', 'due_date', 'student_name', 'parent_name', 'parent_email',
  'teacher_name', 'line_items', 'discount_label', 'discount_amount',
  'subtotal', 'total', 'currency', 'notes',
  'fx_rate', 'fx_source', 'fx_date', 'fx_mode', 'inr_amount',
  'free_class_count', 'free_class_reasons',
]);
const INVOICE_REQUIRED_STRINGS = [
  ['student_name', 200],
  ['parent_name', 200],
];
const INVOICE_OPTIONAL_STRINGS = [
  ['teacher_name', 200],
  ['notes', 2000],
];
// Free classes earned on this invoice. Teaching time owed, never money: no
// total moves because of it. The reasons are a fixed vocabulary, joined in this
// order however the client sends them, so the printed note reads the same way
// every time and the column never fills with free text.
const FREE_CLASS_REASONS = ['Referral', 'Sibling', 'Group'];
const MAX_FREE_CLASSES = 100;

const FX_MODES = new Set(['indicative', 'payable']);
const FX_FIELDS = ['fx_rate', 'fx_source', 'fx_date', 'fx_mode', 'inr_amount'];
const LINE_ITEM_KEYS = new Set(['description', 'qty', 'rate', 'amount']);

// Column widths, so an out-of-range figure is a clean 400 rather than a
// numeric-overflow 500 from Postgres.
const MAX_NUMERIC_12_2 = 9999999999.99;
const MAX_NUMERIC_14_2 = 999999999999.99;

function isMoney(v, max) {
  return (
    typeof v === 'number' &&
    Number.isFinite(v) &&
    v <= max &&
    Math.abs(v * 100 - Math.round(v * 100)) < 1e-6
  );
}

function cents(v) {
  return Math.round(v * 100);
}

function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// Returns { errors, data }. data only meaningful when errors is empty.
// Every money figure the client sends is re-derived here and compared; a
// disagreement is rejected, never silently corrected.
function validateInvoiceInput(body) {
  const errors = [];
  const data = {};

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [{ field: 'body', error: 'must_be_json_object' }], data };
  }

  for (const key of Object.keys(body)) {
    if (!INVOICE_ALLOWED.has(key)) errors.push({ field: key, error: 'unknown_field' });
  }

  for (const [field, maxLen] of INVOICE_REQUIRED_STRINGS) {
    const v = body[field];
    if (typeof v !== 'string' || v.trim().length === 0) {
      errors.push({ field, error: 'required' });
    } else if (v.trim().length > maxLen) {
      errors.push({ field, error: 'too_long' });
    } else {
      data[field] = v.trim();
    }
  }

  for (const [field, maxLen] of INVOICE_OPTIONAL_STRINGS) {
    const v = body[field];
    if (v === undefined || v === null) { data[field] = null; continue; }
    if (typeof v !== 'string') { errors.push({ field, error: 'must_be_string' }); continue; }
    const t = v.trim();
    if (t.length > maxLen) { errors.push({ field, error: 'too_long' }); continue; }
    data[field] = t.length > 0 ? t : null;
  }

  const email = body.parent_email;
  if (typeof email !== 'string' || email.trim().length === 0) {
    errors.push({ field: 'parent_email', error: 'required' });
  } else if (email.trim().length > 200 || !EMAIL_RE.test(email.trim())) {
    errors.push({ field: 'parent_email', error: 'invalid_email' });
  } else {
    data.parent_email = email.trim();
  }

  const issueDate = body.issue_date;
  if (typeof issueDate !== 'string' || !isRealDate(issueDate)) {
    errors.push({ field: 'issue_date', error: 'invalid_date' });
  } else if (issueDate > localToday()) {
    errors.push({ field: 'issue_date', error: 'in_future' });
  } else if (issueDate < '2020-01-01') {
    errors.push({ field: 'issue_date', error: 'too_old' });
  } else {
    data.issue_date = issueDate;
  }

  const dueDate = body.due_date;
  if (typeof dueDate !== 'string' || !isRealDate(dueDate)) {
    errors.push({ field: 'due_date', error: 'invalid_date' });
  } else if (data.issue_date === undefined) {
    // issue_date already failed; nothing to compare against.
  } else if (dueDate < data.issue_date) {
    errors.push({ field: 'due_date', error: 'before_issue_date' });
  } else if (dueDate > addDays(data.issue_date, 365)) {
    errors.push({ field: 'due_date', error: 'too_far_ahead' });
  } else {
    data.due_date = dueDate;
  }

  if (!CURRENCIES.has(body.currency)) {
    errors.push({ field: 'currency', error: 'invalid_currency' });
  } else {
    data.currency = body.currency;
  }

  // ── line items ────────────────────────────────────────────────────────────
  let subtotalCents = null;
  const items = body.line_items;
  if (!Array.isArray(items)) {
    errors.push({ field: 'line_items', error: 'required' });
  } else if (items.length < 1) {
    errors.push({ field: 'line_items', error: 'at_least_one_required' });
  } else if (items.length > 20) {
    errors.push({ field: 'line_items', error: 'too_many' });
  } else {
    const clean = [];
    let sum = 0;
    items.forEach((item, i) => {
      const at = `line_items[${i}]`;
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        errors.push({ field: at, error: 'must_be_object' });
        return;
      }
      for (const key of Object.keys(item)) {
        if (!LINE_ITEM_KEYS.has(key)) errors.push({ field: `${at}.${key}`, error: 'unknown_field' });
      }
      let bad = false;

      const desc = item.description;
      let description = null;
      if (typeof desc !== 'string' || desc.trim().length === 0) {
        errors.push({ field: `${at}.description`, error: 'required' });
        bad = true;
      } else if (desc.trim().length > 200) {
        errors.push({ field: `${at}.description`, error: 'too_long' });
        bad = true;
      } else {
        description = desc.trim();
      }

      const qty = item.qty;
      if (!isMoney(qty, 1000) || qty <= 0) {
        errors.push({ field: `${at}.qty`, error: 'invalid_qty' });
        bad = true;
      }

      const rate = item.rate;
      if (!isMoney(rate, 1000000) || rate <= 0) {
        errors.push({ field: `${at}.rate`, error: 'invalid_rate' });
        bad = true;
      }

      const amount = item.amount;
      if (!isMoney(amount, MAX_NUMERIC_12_2) || amount <= 0) {
        errors.push({ field: `${at}.amount`, error: 'invalid_amount' });
        bad = true;
      }

      if (bad) return;

      // The client's amount must match qty x rate exactly — never recomputed
      // silently, because the figure it sent is the figure it showed the owner.
      const expected = Math.round(qty * rate * 100);
      if (cents(amount) !== expected) {
        errors.push({ field: `${at}.amount`, error: 'amount_mismatch' });
        return;
      }
      sum += expected;
      clean.push({ description, qty, rate, amount });
    });

    if (clean.length === items.length) {
      subtotalCents = sum;
      data.line_items = clean;
    }
  }

  // ── totals ────────────────────────────────────────────────────────────────
  let discountCents = 0;
  const discount = body.discount_amount;
  if (discount === undefined || discount === null) {
    data.discount_amount = null;
    if (body.discount_label !== undefined && body.discount_label !== null) {
      errors.push({ field: 'discount_label', error: 'discount_amount_required' });
    }
    data.discount_label = null;
  } else if (!isMoney(discount, MAX_NUMERIC_12_2) || discount < 0) {
    errors.push({ field: 'discount_amount', error: 'invalid_discount' });
  } else {
    const label = body.discount_label;
    if (typeof label !== 'string' || label.trim().length === 0) {
      errors.push({ field: 'discount_label', error: 'required_with_discount' });
    } else if (label.trim().length > 200) {
      errors.push({ field: 'discount_label', error: 'too_long' });
    } else {
      data.discount_label = label.trim();
    }
    if (subtotalCents !== null && cents(discount) >= subtotalCents) {
      errors.push({ field: 'discount_amount', error: 'not_less_than_subtotal' });
    } else {
      discountCents = cents(discount);
      data.discount_amount = discount;
    }
  }

  let totalCents = null;
  if (subtotalCents !== null) {
    const claimedSubtotal = body.subtotal;
    if (!isMoney(claimedSubtotal, MAX_NUMERIC_12_2)) {
      errors.push({ field: 'subtotal', error: 'invalid_subtotal' });
    } else if (cents(claimedSubtotal) !== subtotalCents) {
      errors.push({ field: 'subtotal', error: 'does_not_match_line_items' });
    } else {
      data.subtotal = subtotalCents / 100;
    }

    const expectedTotal = subtotalCents - discountCents;
    const claimedTotal = body.total;
    if (!isMoney(claimedTotal, MAX_NUMERIC_12_2)) {
      errors.push({ field: 'total', error: 'invalid_total' });
    } else if (cents(claimedTotal) !== expectedTotal) {
      errors.push({ field: 'total', error: 'does_not_match_subtotal_minus_discount' });
    } else if (expectedTotal <= 0) {
      errors.push({ field: 'total', error: 'must_be_positive' });
    } else {
      totalCents = expectedTotal;
      data.total = expectedTotal / 100;
    }
  }

  // ── FX block (all five together, or none) ─────────────────────────────────
  const present = FX_FIELDS.filter((f) => body[f] !== undefined && body[f] !== null);
  if (present.length === 0) {
    for (const f of FX_FIELDS) data[f] = null;
  } else if (present.length < FX_FIELDS.length) {
    for (const f of FX_FIELDS) {
      if (!present.includes(f)) errors.push({ field: f, error: 'fx_block_incomplete' });
    }
  } else {
    // NUMERIC(18,6): 12 integer digits, 6 decimals. Anything wider would be
    // silently rounded by Postgres, which must never happen to frozen evidence.
    const rate = body.fx_rate;
    if (
      typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 ||
      rate > 999999999999 || Math.abs(rate * 1e6 - Math.round(rate * 1e6)) > 1e-3
    ) {
      errors.push({ field: 'fx_rate', error: 'invalid_fx_rate' });
    } else {
      data.fx_rate = rate;
    }

    const source = body.fx_source;
    if (typeof source !== 'string' || source.trim().length === 0) {
      errors.push({ field: 'fx_source', error: 'required' });
    } else if (source.trim().length > 100) {
      errors.push({ field: 'fx_source', error: 'too_long' });
    } else {
      data.fx_source = source.trim();
    }

    const fxDate = body.fx_date;
    if (typeof fxDate !== 'string' || !isRealDate(fxDate)) {
      errors.push({ field: 'fx_date', error: 'invalid_date' });
    } else if (fxDate > localToday()) {
      errors.push({ field: 'fx_date', error: 'in_future' });
    } else if (data.issue_date !== undefined && fxDate < addDays(data.issue_date, -30)) {
      errors.push({ field: 'fx_date', error: 'too_old_for_issue_date' });
    } else {
      data.fx_date = fxDate;
    }

    if (!FX_MODES.has(body.fx_mode)) {
      errors.push({ field: 'fx_mode', error: 'invalid_fx_mode' });
    } else {
      data.fx_mode = body.fx_mode;
    }

    const inr = body.inr_amount;
    if (!isMoney(inr, MAX_NUMERIC_14_2) || inr <= 0) {
      errors.push({ field: 'inr_amount', error: 'invalid_inr_amount' });
    } else if (totalCents !== null && data.fx_rate !== undefined) {
      // Tolerance of 1.00 INR absorbs the owner's own rounding.
      const expected = Math.round((totalCents / 100) * data.fx_rate * 100);
      if (Math.abs(cents(inr) - expected) > 100) {
        errors.push({ field: 'inr_amount', error: 'inconsistent_with_fx_rate' });
      } else {
        data.inr_amount = inr;
      }
    }
  }

  // ── Free classes earned (optional; never touches a total) ─────────────────
  //
  // The count is what makes the block present: a bonus note with no number
  // would print as a promise with no content. The reasons are optional detail
  // and are normalised into one canonical string here, so the document, the
  // export and the database all read identically.
  const rawReasons = body.free_class_reasons;
  let reasons = null;
  if (rawReasons !== undefined && rawReasons !== null) {
    if (!Array.isArray(rawReasons) || rawReasons.some((r) => typeof r !== 'string')) {
      errors.push({ field: 'free_class_reasons', error: 'invalid_free_class_reasons' });
    } else {
      const chosen = FREE_CLASS_REASONS.filter((name) => rawReasons.includes(name));
      const unknown = rawReasons.filter((name) => !FREE_CLASS_REASONS.includes(name));
      // Comparing against the raw length, not a de-duplicated set: a repeated
      // reason is a client that has lost track of what it is sending, and the
      // canonical string would silently swallow it.
      if (unknown.length > 0 || chosen.length !== rawReasons.length) {
        errors.push({ field: 'free_class_reasons', error: 'invalid_free_class_reasons' });
      } else if (chosen.length > 0) {
        reasons = chosen.join(' + ');
      }
    }
  }

  const freeCount = body.free_class_count;
  if (freeCount === undefined || freeCount === null) {
    data.free_class_count = null;
    data.free_class_reasons = null;
    if (reasons !== null) {
      errors.push({ field: 'free_class_count', error: 'free_class_count_required' });
    }
  } else if (
    typeof freeCount !== 'number' ||
    !Number.isInteger(freeCount) ||
    freeCount < 1 ||
    freeCount > MAX_FREE_CLASSES
  ) {
    errors.push({ field: 'free_class_count', error: 'invalid_free_class_count' });
  } else {
    data.free_class_count = freeCount;
    data.free_class_reasons = reasons;
  }

  return { errors, data };
}

module.exports = { validateReceiptInput, validateInvoiceInput };
