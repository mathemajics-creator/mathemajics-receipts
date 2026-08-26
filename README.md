# Mathemajics Receipts

A small, standalone tool for recording fee payments and issuing receipts.
It is completely separate from the main Mathemajics practice portal — its own
code, its own database.

**What it guarantees (enforced by the database itself):**

- Every receipt gets the next number in an unbroken sequence
  (RCPT-000001, RCPT-000002, ...) — no gaps, no duplicates, ever.
- Once issued, a receipt can never be edited or deleted. If one was created by
  mistake, it is *voided* — the number stays in the series with a reason recorded.

The backend now covers: admin login, recording a receipt (which generates the
PDF and emails it to the parent automatically), searching past receipts,
voiding, and a CSV export for the accountant. The screens come in Session 3.

## Setup

1. Copy `.env.example` to `.env` and fill in your real database address.
2. Install dependencies:

```bash
npm install
```

3. **Set the admin password.** Run:

```bash
npm run hash-password
```

Type your chosen password when asked (it shows as `*`). Copy the long code it
prints into `.env` as `ADMIN_PASSWORD_HASH=...`. The real password is never
stored anywhere — only this scrambled version.

4. **Connect Gmail (for emailing receipts).** In your Google account, first
turn on 2-Step Verification, then create an *App Password*
(myaccount.google.com → Security → 2-Step Verification → App passwords).
Put your Gmail address in `GMAIL_USER` and the 16-character app password in
`GMAIL_APP_PASSWORD`. If these are left empty the tool still records receipts —
emails just fail politely and can be retried later.

## Branding on the PDFs

Invoices and receipts are issued as branded PDFs: a navy header band carrying
the Mathemajics logo, the document type, and the website and email address.

The logo is read once at startup from `assets/logo.png`. If that file is ever
missing or unreadable the documents still generate — the header falls back to a
text wordmark and a warning is logged. A cosmetic asset must never stop a
receipt being issued.

Every colour and identity string lives in `branding.js`. The website and email
can be overridden per deployment with `BRAND_WEBSITE` and `BRAND_EMAIL`, and the
logo location with `BRAND_LOGO_PATH` (see `.env.example`).

Every invoice closes with the standing service terms — what a fee includes, and
which discounts are available. That wording lives in `INVOICE_TERMS` in
`branding.js`; editing it changes future invoices only, never one already
issued. Receipts do not carry the terms.

Already-issued documents are never touched. The PDF stored against a receipt or
invoice is the exact file that was emailed, and it is frozen — a design change
applies only to documents issued afterwards, so older ones keep their original
look. To see the current design without issuing anything:

```bash
node scripts/sample-pdfs.js
```

That writes `sample-invoice.pdf`, `sample-receipt-against-invoice.pdf` and
`sample-invoice-large.pdf` from fixed sample data — no database involved, no
number allocated. The large one exists to show the money formatting at scale:
figures are printed with grouped thousands (`1,234,567.89`). That formatting
lives in `format.js` and is shared by the PDFs and the emails, so a body can
never disagree with the document attached to it.

## Running migrations

Migrations set up (and later evolve) the database tables. They run
automatically whenever the server starts, or by hand with:

```bash
npm run migrate
```

Running it again is always safe — anything already applied is skipped.

## Running tests

Tests need a reachable Postgres server (they create their own scratch database
named `receipts_test`, so your real data is untouched):

```bash
npm test
```

## Starting the server

```bash
npm start
```

Then visit `http://localhost:3000/health` — it answers `{"ok":true,...}` when
the database is reachable.
