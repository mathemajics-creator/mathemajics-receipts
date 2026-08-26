// format.js — how a money figure is written, shared by every surface that
// prints one. The PDF templates and the email bodies must never disagree about
// what an amount looks like, so there is exactly one implementation.
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

module.exports = { money };
