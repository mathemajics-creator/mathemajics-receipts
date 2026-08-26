// format.js — how a money figure and a calendar date are written, shared by
// every surface that prints one. The PDF templates, the email bodies, the CSV
// exports and the JSON responses must never disagree about what an amount or a
// date looks like, so there is exactly one implementation of each.
//
// Nothing here is tax-related, and nothing depends on the environment.

// Money always prints with two decimals and comma-grouped thousands:
// 13812.5 -> "13,812.50", 1234567.89 -> "1,234,567.89", 250 -> "250.00".
//
// The grouping is written by hand rather than with toLocaleString because these
// documents must format identically on every machine that generates them.
// toLocaleString's output depends on the Node build's ICU data and on the host
// locale: a small-icu or --without-intl build, or a container with a different
// LANG, can silently produce "1.234.567,89" or no grouping at all. An issued
// PDF is frozen evidence, so its number format may not depend on the
// environment — this function depends on nothing but its argument.
//
// en-US grouping (a comma every three digits) is used for INR as well as AUD
// and USD: these documents go to parents in Australia and the USA, who would
// misread the Indian lakh/crore grouping ("1,38,125").
function money(v) {
  const fixed = Number(v).toFixed(2);
  const negative = fixed.startsWith('-');
  const body = negative ? fixed.slice(1) : fixed;
  const dot = body.indexOf('.');
  if (dot === -1) return fixed; // NaN / Infinity — nothing to group
  // A comma goes at every position inside the integer part that has a whole
  // number of three-digit groups after it.
  const grouped = body.slice(0, dot).replace(/\B(?=(\d{3})+$)/g, ',');
  return (negative ? '-' : '') + grouped + body.slice(dot);
}

// ── Dates ───────────────────────────────────────────────────────────────────
//
// A calendar date is not a moment in time. "25 August 2026" on an invoice is
// the same day in Sydney, London and Los Angeles — it carries no timezone, and
// pushing it through one is exactly how a date silently moves by a day on a
// financial record.
//
// Two shapes arrive here:
//
//   'YYYY-MM-DD'  — every DATE column, thanks to the type parser in db.js.
//   a Date object — rows built by hand (scripts/sample-pdfs.js, test fixtures),
//                   where `new Date(2026, 7, 25)` was written to mean the 25th
//                   in local time, so its LOCAL parts are what it meant.
//
// What is never done to a plain date string is `new Date('2026-08-25')`: that
// parses as midnight UTC and then reports the 24th anywhere west of Greenwich.
// That is the bug this module exists to make unrepresentable.
function dateParts(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return { y: value.getFullYear(), m: value.getMonth() + 1, d: value.getDate() };
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (iso) return { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
  // Anything else (a full timestamp, say) is read through the local timezone —
  // the long-standing fallback, kept so an unexpected shape still renders a
  // sensible day rather than nothing.
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// '2026-08-25' — the machine-readable form, used by the JSON responses and the
// CSV exports. Returns null for a missing date, which a CSV cell renders empty.
function ymd(value) {
  const p = dateParts(value);
  if (p === null) return null;
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// '25 Aug 2026' — the human-readable form, used by the PDFs and the emails.
function longDate(value) {
  const p = dateParts(value);
  if (p === null) return '';
  return `${String(p.d).padStart(2, '0')} ${MONTHS[p.m - 1]} ${p.y}`;
}

module.exports = { money, dateParts, ymd, longDate };
