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
