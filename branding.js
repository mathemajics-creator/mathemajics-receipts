// branding.js — the single source of truth for the brand colours and identity
// strings used by the PDF templates. No hex literal and no contact string may
// live in pdf.js.
//
// Nothing here is tax-related, and nothing is fetched at runtime: the contact
// details and the logo path may be overridden by environment variables so a
// deployment can change them without a code edit, but the defaults are the
// real Mathemajics values.

const path = require('path');

// ── Colours ────────────────────────────────────────────────────────────────
const NAVY = '#0D1B2E';
const CYAN = '#00BCD4';
const LIGHT_BLUE = '#4FC3F7';
const INK = '#1A1A1A';
const MUTED = '#6B7280';
const HAIRLINE = '#E5E7EB';
const BAND_TEXT = '#FFFFFF';

// The two very-light fills the layout needs (Bill To panel, FX callout, and the
// alternating table rows). Here rather than in pdf.js for the same reason as
// everything above.
const PANEL_TINT = '#F1F5F9';
const ROW_TINT = '#F8FAFC';

// The free-classes note is the one thing on an invoice that is good news, so it
// is the one place the document leaves the navy/cyan palette. Green rather than
// cyan keeps it from being mistaken for the FX callout, which sits right above
// it and is about money.
const GREEN = '#2E9E5B';
const GREEN_TINT = '#EAFAF0';

// ── Identity ───────────────────────────────────────────────────────────────
const BUSINESS_NAME = 'Mathemajics';
const TAGLINE = 'Unlocking the Magic of Maths';
const WEBSITE = process.env.BRAND_WEBSITE || 'www.mathemajics.com';
const EMAIL = process.env.BRAND_EMAIL || 'mathemajics@gmail.com';

// ── Invoice service terms ──────────────────────────────────────────────────
// The standing fine print that closes every invoice. This array is the single
// source of truth for that wording — no terms string lives in pdf.js, and the
// renderer iterates whatever it finds here, so entries can be added, reworded
// or removed without touching the template. An empty array omits the section
// entirely.
//
// Editing this changes FUTURE invoices only. Documents already issued keep the
// terms they were issued with: their PDF bytes are frozen evidence and are
// never regenerated.
//
// Receipts do not carry these terms — a receipt records money already received.
const INVOICE_TERMS = [
  {
    heading: "What's included",
    body: 'Live interactive tutoring sessions · Worksheets and learning material · Weekly practice questions · Monthly assessment / feedback · Live Doubt-clearing support.',
  },
  {
    heading: 'Discounts available',
    body: 'Referral — refer a friend and get 2 free classes; Sibling — 1 free class for each sibling enrolled; Group — form a group of 2 or 3 students, each child gets 1 free class. Free classes are added in the next month after enrolment confirmation.',
  },
];

// ── Logo ───────────────────────────────────────────────────────────────────
// Overridable so the fail-soft path can be exercised in a test, and so a
// deployment can mount the asset elsewhere.
const LOGO_PATH = process.env.BRAND_LOGO_PATH || path.join(__dirname, 'assets', 'logo.png');

module.exports = {
  NAVY,
  CYAN,
  LIGHT_BLUE,
  INK,
  MUTED,
  HAIRLINE,
  BAND_TEXT,
  PANEL_TINT,
  ROW_TINT,
  GREEN,
  GREEN_TINT,
  BUSINESS_NAME,
  TAGLINE,
  WEBSITE,
  EMAIL,
  LOGO_PATH,
  INVOICE_TERMS,
};
