// public/lib.js — the pure, DOM-free logic behind the screens: money
// formatting, cent arithmetic, query strings, dates, FX consistency.
//
// Nothing here touches the DOM, the network or sessionStorage, so every
// function is directly unit-testable from Node (test/session3.test.js imports
// this file). Nothing here is tax-related.
//
// IMPORTANT: several functions below deliberately mirror a server function
// character for character. The frontend cannot `require` the server modules,
// so agreement is enforced by tests that run both and compare, not by sharing
// code. If you change one side, change the other and the test will tell you.

// ── Money formatting — mirrors format.js money() ────────────────────────────
//
// Same hand-rolled grouping, and for the same reason: an amount shown on the
// screen must read exactly like the amount on the PDF and in the email.
// toLocaleString is not used on either side because its output depends on the
// host's ICU data and locale.
export function money(v) {
  const fixed = Number(v).toFixed(2);
  const negative = fixed.startsWith('-');
  const body = negative ? fixed.slice(1) : fixed;
  const dot = body.indexOf('.');
  if (dot === -1) return fixed; // NaN / Infinity — nothing to group
  const grouped = body.slice(0, dot).replace(/\B(?=(\d{3})+$)/g, ',');
  return (negative ? '-' : '') + grouped + body.slice(dot);
}

// ── Cent arithmetic ─────────────────────────────────────────────────────────

// Mirrors cents() in validate.js.
export function cents(v) {
  return Math.round(v * 100);
}

// A line's amount, in cents.
//
// This mirrors validate.js's `Math.round(qty * rate * 100)` EXACTLY — the same
// floating expression, not merely the same mathematics. That looks like the
// drift this module otherwise avoids, and it is deliberate: the server
// re-derives the amount with that expression and rejects any disagreement
// (`amount_mismatch`), so computing it "more correctly" here — say from
// integer sub-units — would produce a figure the server refuses for inputs like
// qty 1.15 x rate 0.50, where the two disagree by one cent. The owner would see
// a rejected invoice and no way to fix it.
//
// Everything downstream of this single multiply — subtotal, discount, total —
// is integer-cent arithmetic, which is where 0.1 + 0.2 drift would otherwise
// accumulate across up to twenty rows.
export function lineAmountCents(qty, rate) {
  return Math.round(qty * rate * 100);
}

// Sum of line amounts, in cents. Integers throughout.
export function subtotalCents(lines) {
  return lines.reduce((sum, l) => sum + lineAmountCents(l.qty, l.rate), 0);
}

// How far a typed INR figure sits from total x rate, in cents. The server
// allows 100 (1.00 INR) either way; anything wider is warned about here rather
// than left to become a 400.
export function inrOffByCents(totalCentsValue, rate, inrAmount) {
  const expected = Math.round((totalCentsValue / 100) * rate * 100);
  return Math.abs(cents(inrAmount) - expected);
}

export const INR_TOLERANCE_CENTS = 100;

// ── Number parsing ──────────────────────────────────────────────────────────

// A form input's string to a number, or null when it is blank or not a number.
// Blank is null (not 0) so "no discount" and "a discount of zero" stay
// distinguishable.
export function parseNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// True when a number has at most 2 decimal places, using the same tolerance
// test as validate.js.
export function hasAtMost2dp(n) {
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
}

// ── Query strings ───────────────────────────────────────────────────────────

// Builds "?a=1&b=2" from a plain object, dropping empty values so a blank
// filter box is the same as no filter at all. Returns '' when nothing is set.
export function buildQuery(params) {
  const q = new URLSearchParams();
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (value === undefined || value === null || value === '') continue;
    q.set(key, String(value));
  }
  const s = q.toString();
  return s === '' ? '' : '?' + s;
}

// ── Dates ───────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The API serializes Postgres DATE columns through JSON, which turns them into
// full timestamps ("2026-08-25T00:00:00.000Z"). Plain "YYYY-MM-DD" strings are
// taken as written; anything else is read back through the browser's local
// timezone, which is the inverse of how the server wrote it.
export function dateParts(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return { y, m, d };
  }
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
}

// "YYYY-MM-DD" — what the API wants and what <input type="date"> holds.
export function isoDate(value) {
  const p = dateParts(value);
  if (p === null) return '';
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// "25 Aug 2026" — what a person reads.
export function fmtDate(value) {
  const p = dateParts(value);
  if (p === null) return '';
  return `${String(p.d).padStart(2, '0')} ${MONTHS[p.m - 1]} ${p.y}`;
}

// Today in the browser's timezone. Matches how validate.js builds its own
// "today" from the server clock.
export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Mirrors addDays() in validate.js — UTC arithmetic, so no daylight-saving
// transition can shift the result by a day.
export function addDaysIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// ── Display helpers ─────────────────────────────────────────────────────────

export const PAYMENT_METHOD_LABELS = {
  bank_transfer: 'Bank transfer',
  paypal: 'PayPal',
  upi: 'UPI',
  other: 'Other',
};

// "AUD 1,234.50"
export function amountWithCurrency(currency, value) {
  return `${currency} ${money(value)}`;
}

// The API answers a failed create/update with { error, fields: [{field, error}] }.
// These are the plain-language versions; anything unmapped falls back to a
// readable rendering of the code rather than raw JSON.
const FIELD_MESSAGES = {
  required: 'This is needed.',
  too_long: 'This is too long.',
  must_be_string: 'This does not look right.',
  invalid_email: 'That does not look like an email address.',
  invalid_date: 'Enter a valid date.',
  in_future: 'This date cannot be in the future.',
  too_old: 'This date is too far in the past.',
  before_issue_date: 'The due date cannot be before the issue date.',
  too_far_ahead: 'The due date is more than a year after the issue date.',
  invalid_currency: 'Choose a currency.',
  invalid_payment_method: 'Choose a payment method.',
  invalid_amount: 'Enter an amount greater than zero.',
  too_large: 'That amount is too large.',
  max_2_decimals: 'Use at most two decimal places.',
  at_least_one_required: 'Add at least one item.',
  too_many: 'There is a limit of 20 items.',
  must_be_object: 'This item is incomplete.',
  invalid_qty: 'Enter a quantity greater than zero (up to two decimals).',
  invalid_rate: 'Enter a rate greater than zero (up to two decimals).',
  amount_mismatch: 'The amount does not match quantity times rate.',
  invalid_discount: 'Enter a discount of zero or more.',
  required_with_discount: 'Give the discount a label.',
  discount_amount_required: 'Enter a discount amount, or clear the label.',
  not_less_than_subtotal: 'The discount must be less than the subtotal.',
  invalid_subtotal: 'The subtotal does not look right.',
  does_not_match_line_items: 'The subtotal does not match the items.',
  invalid_total: 'The total does not look right.',
  does_not_match_subtotal_minus_discount: 'The total does not match subtotal minus discount.',
  must_be_positive: 'The total must be more than zero.',
  fx_block_incomplete: 'Fill in every rupee field, or untick "Show INR amount".',
  invalid_fx_rate: 'Enter a valid exchange rate.',
  invalid_fx_mode: 'Choose how the rupee figure is used.',
  invalid_inr_amount: 'Enter a rupee amount greater than zero.',
  inconsistent_with_fx_rate: 'The rupee amount does not match the total times the rate.',
  too_old_for_issue_date: 'The rate date is more than 30 days before the issue date.',
  invalid_invoice_id: 'That invoice could not be used.',
  unknown_field: 'This field is not accepted.',
};

export function fieldMessage(code) {
  if (FIELD_MESSAGES[code]) return FIELD_MESSAGES[code];
  return String(code).replace(/_/g, ' ') + '.';
}
