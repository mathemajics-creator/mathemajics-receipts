# Mathemajics Receipts

A small, standalone tool for recording fee payments and issuing receipts.
It is completely separate from the main Mathemajics practice portal — its own
code, its own database.

**What it guarantees (enforced by the database itself):**

- Every receipt gets the next number in an unbroken sequence
  (RCPT-000001, RCPT-000002, ...) — no gaps, no duplicates, ever.
- Once issued, a receipt can never be edited or deleted. If one was created by
  mistake, it is *voided* — the number stays in the series with a reason recorded.

This session contains only the database layer and a health check. Receipt
entry, PDF generation, and emailing come in later sessions.

## Setup

1. Copy `.env.example` to `.env` and fill in your real database address.
2. Install dependencies:

```bash
npm install
```

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
