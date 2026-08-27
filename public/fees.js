// public/fees.js — the published fee structure, and the only place it lives.
//
// Carried across verbatim from the old browser-based invoice generator
// (MathemajicsInvoiceGenerator, D:\MATHEMAJICS\Invoices), confirmed current by
// Piyush on 2026-08-27. Every price is the TOTAL for the whole class block, not
// a per-class rate: "Year 3-4, 16 Classes" is one line of qty 1 at 256.
//
// This is a convenience for filling the form, never an authority over it. Quick
// add writes a description, a quantity and a rate into the line item and then
// gets out of the way — all three stay editable, because a real invoice
// sometimes has to depart from the price list and the tool must not fight that.
// Nothing here reaches the server: the server sees only the line items that end
// up in the form, and re-derives every total from them as it always has.
//
// There is deliberately no INR table. The old generator priced USD and AUD
// only, and inventing rupee prices here would be inventing a fee.

export const PACKAGES = [
  { classes: 8, key: 'c8' },
  { classes: 16, key: 'c16' },
];

export const FEES = {
  USD: [
    { name: 'K–3', c8: 112, c16: 208 },
    { name: 'Grade 4–5', c8: 120, c16: 224 },
    { name: 'Grade 6–7', c8: 128, c16: 240 },
    { name: 'Grade 8–9', c8: 144, c16: 272 },
    { name: 'Grade 10–11', c8: 160, c16: 304 },
    { name: 'PSAT', c8: 176, c16: 320 },
    { name: 'SAT', c8: 176, c16: 320 },
  ],
  AUD: [
    { name: 'K–2', c8: 120, c16: 224 },
    { name: 'Year 3–4', c8: 136, c16: 256 },
    { name: 'Year 5–6', c8: 144, c16: 272 },
    { name: 'Year 7–8', c8: 160, c16: 304 },
    { name: 'Year 9–10', c8: 184, c16: 352 },
    { name: 'NAPLAN (Y 3, 5, 7, 9)', c8: 184, c16: 352 },
    { name: 'Selective Exam Prep', c8: 184, c16: 352 },
  ],
};

// The courses on offer in a currency, or an empty list where there is no
// published table. An empty list is the signal to hide quick add rather than
// show an empty dropdown.
export function coursesFor(currency) {
  return FEES[currency] || [];
}

// The line a chosen course and package should produce: "Year 3–4 — 16 Classes",
// one of them, at the block price. Returns null when the pairing does not exist,
// so a caller can never turn a missing price into a zero-rated line.
export function feeLine(currency, courseName, classes) {
  const course = coursesFor(currency).find((c) => c.name === courseName);
  const pkg = PACKAGES.find((p) => p.classes === Number(classes));
  if (!course || !pkg) return null;
  const rate = course[pkg.key];
  if (typeof rate !== 'number' || !(rate > 0)) return null;
  return {
    description: `${course.name} — ${pkg.classes} Classes`,
    qty: 1,
    rate,
  };
}
