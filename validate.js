// validate.js — whitelist validation for receipt creation. Unknown fields are
// rejected (including gst_treatment, which stays NULL pending CA confirmation).

const ALLOWED = new Set([
  'issue_date', 'student_name', 'parent_name', 'parent_email', 'teacher_name',
  'amount', 'currency', 'payment_method', 'payment_reference', 'fee_description',
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

  // gst_treatment is never accepted from the request (rejected above as an
  // unknown field); it is always inserted as NULL this session.
  data.gst_treatment = null;

  return { errors, data };
}

module.exports = { validateReceiptInput };
