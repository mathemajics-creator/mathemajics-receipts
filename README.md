# Mathemajics Receipts

A small, standalone tool for recording fee payments and issuing receipts.
It is completely separate from the main Mathemajics practice portal — its own
code, its own database.

**What it guarantees (enforced by the database itself):**

- Every receipt gets the next number in an unbroken sequence
  (RCPT-000001, RCPT-000002, ...) — no gaps, no duplicates, ever.
- Once issued, a receipt can never be edited or deleted. If one was created by
  mistake, it is *voided* — the number stays in the series with a reason recorded.

The tool covers: admin login, issuing invoices, recording payments against them,
branded PDFs emailed to the parent automatically, searching past documents,
voiding, and CSV exports for the accountant — all through the screens described
below.

## Using the tool

Open the address the tool is running at (locally, `http://localhost:3000`).
Everything happens on one page with three tabs: **Invoices**, **Receipts** and
**New**.

### Logging in

Type your password and press Enter. That is the only login — there are no
usernames and no other accounts. You stay logged in until you close the browser
tab or press **Log out**; after that you log in again.

If you get "Wrong password", the password is wrong. If you get "Too many
attempts — wait 15 minutes", the tool has locked out guessing for a while; the
wait is the whole fix.

### Issuing an invoice

**New → New invoice.** The issue date is today and the due date a week later;
change either if you need to. Fill in the student, the parent and the parent's
email address, then add the items — a description, a quantity and a rate for
each. The amount for each line, the subtotal and the total work themselves out
as you type. You can add up to 20 items, and take one away with **Remove**.

A discount is optional. Give it a label (the label is printed on the invoice)
and an amount. The discount has to be smaller than the subtotal.

When you press **Review and issue invoice** you get a summary first — who it is
going to, for how much, for which student, and when it is due. **Nothing is sent
until you press "Issue and email".** Cancel leaves everything exactly as it was,
and nothing is recorded.

Once you confirm, the invoice is recorded, the PDF is made, and **the parent is
emailed immediately.** You will see either a green message with the invoice
number, or an orange one saying the invoice was recorded but the email failed —
in which case use **Retry email** from the Invoices tab.

### Showing an amount in rupees

Tick **Show INR amount** on the invoice form. Most invoices do not need this, so
it starts unticked.

When you tick it, the tool looks up today's rate and fills in the rate, where it
came from, and the date. **Check the rate before you issue the invoice** — it is
your figure, not the tool's, and every one of those boxes can be changed.

Then choose one of two things:

- **Parent is paying in INR** — the rupee figure is the amount actually being paid.
- **Just showing the equivalent** — payment is still in the invoice's own
  currency, and the rupee figure is only there for information.

The rupee amount is worked out for you and you may round it, by up to 1.00. If
you type something further off than that, the tool says so before you send
anything.

If the rate lookup fails — no internet, the rate service is down, or the invoice
is already in rupees — you will see "Couldn't fetch a rate — enter it manually".
**This never stops you issuing an invoice.** Type the rate in yourself and carry on.

### Recording a payment

The quickest way: find the invoice on the **Invoices** tab and press **Record
payment**. That opens the receipt form with the invoice already chosen and the
student, parent, email and amount already filled in. Everything stays editable
except the currency, which has to match the invoice.

Otherwise go to **New → New receipt** and pick the invoice from the **Against
invoice** list (it shows only unpaid invoices; type in the search box to narrow
it down). If the payment does not relate to an invoice at all, choose **No
invoice — standalone receipt** — that is perfectly normal and fully supported.

Fill in how the money arrived (bank transfer, PayPal, UPI or other), a reference
if you have one, and what the payment was for. You get the same summary to
confirm, and the parent is emailed the receipt straight away.

Once the receipt exists, that invoice reads **PAID** with the receipt number
beside it.

### Retrying a failed email

If a row shows **Email failed**, press **Retry email** on it and confirm. The
invoice or receipt itself is not changed — only the email is sent again. If it
fails once more, the Gmail settings need looking at (see Setup below); the
document is safely recorded either way.

### Fixing a mistake — voiding

Nothing is ever deleted. If you issued something by mistake, press **Void** on
its row and type a reason.

The document stays in the records marked **VOIDED**, keeps its number in the
sequence, and keeps your reason attached to it. This is deliberate: an
accountant or an auditor has to be able to see that a number existed and what
happened to it. A gap in the numbering would look like something being hidden.

If you try to void an invoice that has a payment against it, the tool refuses
and tells you to void the receipt first — otherwise the books would show a
payment against an invoice that supposedly never existed. Void the receipt, and
the invoice goes back to reading **Unpaid**.

### Finding things, and the CSVs for the accountant

Both tabs list newest first, 50 at a time, with **Previous** and **Next** at the
bottom. You can narrow the list by student name, by date range, by status, and
(for invoices) by paid or unpaid.

**Download CSV for accountant** on either tab gives you a spreadsheet of
everything — every invoice, or every receipt, voided ones included. The invoice
export also carries the matching receipt number, amount and date, which is what
the accountant reconciles payments against.

### A note on the figures

The screens add things up as you type, but the server works out every total
again by itself and refuses anything that disagrees. If you ever see a figure
rejected, that is the check doing its job — the tool will never quietly change a
number to make it fit.

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

Then visit `http://localhost:3000` for the screens, or
`http://localhost:3000/health` for the machine check — it answers
`{"ok":true,...}` when the database is reachable.

The screens are plain HTML, CSS and JavaScript in `public/`, served by the same
server as the API. There is no build step: edit a file in `public/` and reload
the page. The page is allowed to load scripts and styles only from this server,
which is why every handler is attached in `public/app.js` rather than written
into the HTML. The single exception is the currency-rate lookup, which the
browser makes directly to `api.frankfurter.dev` — the server itself never calls
out for a rate, so recording a document never depends on an outside service.

## Settings the tool reads

Every setting is an environment variable. Locally they live in a `.env` file
(copied from `.env.example`, never committed). **In production they are not a
file at all** — they are typed into the Railway dashboard, under the app
service's **Variables** tab.

**No password, hash or app password belongs in this repository, in a commit, or
in a chat message. Ever.** The only place they go is the Railway dashboard and
your password manager.

| Variable | Needed? | What it is |
|---|---|---|
| `DATABASE_URL` | **Required** | Railway fills this in for you once a Postgres database is added. Don't type it by hand. |
| `NODE_ENV` | **Required** | Set to `production` in Railway. |
| `PORT` | **Required** | Railway fills this in for you. Don't type it by hand. |
| `ADMIN_PASSWORD_HASH` | **Required** | The scrambled version of your login password, from `npm run hash-password`. Without it the site still loads but nobody can log in. |
| `GMAIL_USER` | Required for email | The Gmail address invoices are sent from. |
| `GMAIL_APP_PASSWORD` | Required for email | A Gmail **App Password**, not your normal password. Without these two, documents are still recorded correctly — the email just fails and you use **Retry email**. |
| `SESSION_TTL_HOURS` | Optional | How long a login lasts. Defaults to 12. |
| `BRAND_WEBSITE` | Optional | Overrides the website printed on the PDFs. |
| `BRAND_EMAIL` | Optional | Overrides the email address printed on the PDFs. |
| `BRAND_LOGO_PATH` | Optional | Where the logo file is. Defaults to the one in this repo. |

## Deploying to Railway

The app runs as one Railway service: it serves the API **and** the screens, so
there is nothing else to deploy. `railway.toml` tells Railway how to build and
run it, and Node is pinned to version 20 by `engines` in `package.json`.

### Putting it live

1. In Railway, create a project from the GitHub repo, then add a **PostgreSQL**
   database to the same project. Railway links `DATABASE_URL` automatically.
2. In the app service → **Variables**, set the required variables from the table
   above. Save — Railway redeploys by itself.
3. App service → **Settings** → **Networking** → **Generate Domain**.
4. Visit that address with `/health` on the end.

The database tables are created automatically the first time the app starts, and
every time after that it checks whether anything new needs applying. **If that
step fails the app deliberately refuses to start**, so it can never serve pages
on a half-finished database.

### Checking it worked

Open **your address + `/health`**. You want:

```json
{"ok":true,"uptime":12.3}
```

- **`{"ok":false,"error":"db_unreachable"}`** — the app is running but cannot
  reach the database. Check the Postgres service is running and that
  `DATABASE_URL` is set on the app service.
- **The page won't load at all** — look at the service's **Deploy Logs** in
  Railway. If migrations failed, the reason is the last thing printed.

Then open the address itself; you should get the login screen.

### If it boots but you can't log in

Look at the top of the deploy log for a line starting `startup:`. If it says
`ADMIN_PASSWORD_HASH is not set`, that variable is missing or empty — generate
one with `npm run hash-password` and add it in Railway. The log only ever names
the setting; it never prints its value.

### If it boots but email fails

This is the common one, and nothing is lost when it happens: the invoice or
receipt is fully recorded, and its row shows **Email failed** with a **Retry
email** button. Check, in order:

1. `GMAIL_APP_PASSWORD` is the 16-character **App Password**, not your ordinary
   Gmail password.
2. It was pasted without spaces.
3. 2-Step Verification is still switched on for that Google account — turning it
   off silently invalidates every app password.
4. `GMAIL_USER` is the full address.

Fix the variable, let Railway redeploy, then press **Retry email** on the rows
that failed. Nothing needs re-issuing.

### Rolling back

In the Railway dashboard, open the app service, go to **Deployments**, find the
last deployment that worked, and choose **Redeploy**. That puts the previous
code back.

Rolling back the **code** does not undo **data** — issued invoices and receipts
stay exactly as they are. That is deliberate: they are permanent records, and
nothing in this tool deletes one.
