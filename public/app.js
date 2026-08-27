// public/app.js — the screens: login, the two lists, and the two creation
// forms. Loaded as a module from index.html; every handler is attached here
// with addEventListener, because helmet's CSP forbids inline script and inline
// event attributes.
//
// Two rules run through this file:
//   1. Every value that came from the database or from a person is written
//      with textContent, never assembled into HTML.
//   2. This file may compute a figure to SHOW, but the server re-derives every
//      money figure and rejects a disagreement. A 400 is surfaced to the owner
//      as-is; numbers are never quietly adjusted to make one go away.

import * as api from './api.js';
import { coursesFor, feeLine } from './fees.js';
import {
  $, el, clear, banner, hideBanner, initBanner, initDialog, askConfirm,
  withBusy,
} from './ui.js';
import {
  money, amountWithCurrency, cents, lineAmountCents, parseNumber, hasAtMost2dp,
  buildQuery, isoDate, fmtDate, todayIso, addDaysIso, fieldMessage,
  inrOffByCents, INR_TOLERANCE_CENTS, PAYMENT_METHOD_LABELS, documentFileName,
} from './lib.js';

const PAGE_SIZE = 50;
const FX_TIMEOUT_MS = 3000;
const FX_SOURCE = 'ECB reference rate';

const state = {
  tab: 'invoices',
  invoices: { rows: [], offset: 0, filters: {} },
  receipts: { rows: [], offset: 0, filters: {} },
  // The unpaid, issued invoices offered in the receipt form's dropdown.
  linkable: [],
  linkableLoaded: false,
  // id -> invoice_number, so a receipt row can name the invoice it settles.
  // A receipt row carries invoice_id but not the number, and the invoice it
  // points at is by definition PAID — so the unpaid dropdown list can never
  // supply it. Filled from every invoice list that goes past.
  invoiceNumbers: new Map(),
  numbersBackfilled: false,
  selectedInvoice: null,
  inrTouched: false,
  fxCurrency: null,
};

// ── View switching ──────────────────────────────────────────────────────────

function showLogin(message) {
  $('main-view').hidden = true;
  $('login-view').hidden = false;
  $('login-error').textContent = message || '';
  $('login-password').value = '';
  $('login-password').focus();
}

function showMain() {
  $('login-view').hidden = true;
  $('main-view').hidden = false;
  selectTab('invoices');
}

function selectTab(name) {
  state.tab = name;
  for (const tab of ['invoices', 'receipts', 'new']) {
    const button = $('tab-btn-' + tab);
    button.setAttribute('aria-selected', String(tab === name));
    $('panel-' + tab).hidden = tab !== name;
  }
  if (name === 'invoices') loadInvoices();
  if (name === 'receipts') loadReceipts();
}

// ── Error plumbing ──────────────────────────────────────────────────────────

// Clears every field-level message under one form.
function clearFieldErrors(form) {
  for (const node of form.querySelectorAll('.field-error')) node.textContent = '';
}

// Renders the server's { fields: [{ field, error }] } next to the matching
// input. `prefix` is 'iv' or 'rc'; anything with no matching element falls back
// to the form-level line, so no error can silently vanish.
function renderServerErrors(form, prefix, fields, formErrorId) {
  clearFieldErrors(form);
  const leftovers = [];
  for (const item of fields || []) {
    const message = fieldMessage(item.error);
    const lineMatch = /^line_items\[(\d+)\](?:\.(.+))?$/.exec(item.field);
    if (lineMatch) {
      const row = $('iv-items').children[Number(lineMatch[1])];
      const target = row && row.querySelector('[data-li="error"]');
      if (target) {
        target.textContent = (lineMatch[2] ? lineMatch[2] + ': ' : '') + message;
        continue;
      }
    }
    const node = $(`err-${prefix}-${item.field}`);
    if (node) node.textContent = message;
    else leftovers.push(`${item.field}: ${message}`);
  }
  $(formErrorId).textContent = leftovers.length
    ? 'Please check: ' + leftovers.join(' ')
    : 'Some details need fixing — see the messages above.';
}

// Plain language for the codes the API can answer with. Never raw JSON.
function explain(err) {
  switch (err.code) {
    case 'network_error':
      return 'Could not reach the server. Check your connection and try again.';
    case 'rate_limited':
      return 'Too many requests in a short time — wait a minute and try again.';
    case 'not_found':
      return 'That record could not be found.';
    case 'already_voided':
      return 'That one is already voided.';
    case 'already_sent':
      return 'That email has already been sent.';
    case 'voided':
      return 'This document is voided, so no email is sent.';
    case 'invoice_has_receipt':
      return 'This invoice has a payment against it. Void the receipt first.';
    case 'invoice_already_paid':
      return 'That invoice already has a payment recorded against it.';
    case 'invoice_voided':
      return 'That invoice has been voided, so a payment cannot be recorded against it.';
    case 'invoice_not_found':
      return 'That invoice could not be found.';
    case 'currency_mismatch':
      return 'The currency must match the invoice.';
    case 'send_failed':
      return 'The email did not go out. Check the Gmail settings, then try again.';
    case 'invalid_reason':
      return 'A reason is needed, and it must be under 500 characters.';
    default:
      return err.status >= 500
        ? 'Something went wrong on the server. Try again in a moment.'
        : 'That did not work. Please check the details and try again.';
  }
}

function reportError(err) {
  if (err && err.status === 401) return; // already handled: back to login
  banner('error', explain(err || {}));
}

// ── Login ───────────────────────────────────────────────────────────────────

function initLogin() {
  const form = $('login-form');
  form.noValidate = true; // our own messages, not the browser's bubbles
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = $('login-password').value;
    $('login-error').textContent = '';
    if (password.length === 0) {
      $('login-error').textContent = 'Enter your password.';
      return;
    }
    await withBusy($('login-submit'), 'Logging in…', async () => {
      try {
        await api.login(password);
        hideBanner();
        showMain();
      } catch (err) {
        if (err.status === 401) $('login-error').textContent = 'Wrong password.';
        else if (err.status === 429) $('login-error').textContent = 'Too many attempts — wait 15 minutes.';
        else $('login-error').textContent = explain(err);
      }
    });
  });

  $('logout').addEventListener('click', async () => {
    await api.logout();
    showLogin('');
  });
}

// ── Shared row pieces ───────────────────────────────────────────────────────

function emailIndicator(row) {
  return row.email_sent_at
    ? el('span', { class: 'sub', text: 'Sent ✓' })
    : el('span', { class: 'sub bad', text: 'Email failed' });
}

function actionButton(label, run, extraClass) {
  return el('button', {
    class: 'btn tiny' + (extraClass ? ' ' + extraClass : ''),
    type: 'button',
    text: label,
    onClick: run,
  });
}

// ── Invoices list ───────────────────────────────────────────────────────────

function invoiceFilters() {
  return {
    student: $('inv-f-student').value.trim(),
    from: $('inv-f-from').value,
    to: $('inv-f-to').value,
    status: $('inv-f-status').value,
    paid: $('inv-f-paid').value,
  };
}

function anyFilterSet(filters) {
  return Object.keys(filters).some((k) => filters[k] !== '' && filters[k] !== undefined);
}

async function loadInvoices() {
  const view = state.invoices;
  $('inv-state').textContent = 'Loading…';
  const query = buildQuery(
    Object.assign({}, view.filters, { limit: PAGE_SIZE, offset: view.offset })
  );
  try {
    const data = await api.listInvoices(query);
    view.rows = data.invoices;
    rememberInvoiceNumbers(data.invoices);
    renderInvoices();
  } catch (err) {
    $('inv-state').textContent = '';
    clear($('inv-rows'));
    reportError(err);
  }
}

function renderInvoices() {
  const view = state.invoices;
  const body = $('inv-rows');
  clear(body);

  if (view.rows.length === 0) {
    $('inv-state').textContent = anyFilterSet(view.filters)
      ? 'No invoices match those filters.'
      : view.offset > 0
        ? 'No more invoices.'
        : 'No invoices yet.';
  } else {
    $('inv-state').textContent = '';
  }

  for (const row of view.rows) {
    const tr = el('tr');
    tr.appendChild(el('td', { class: 'docnum', text: row.invoice_number }));
    tr.appendChild(el('td', { text: fmtDate(row.issue_date) }));
    tr.appendChild(el('td', { text: row.student_name }));
    tr.appendChild(el('td', { class: 'num', text: amountWithCurrency(row.currency, row.total) }));

    const statusCell = el('td');
    const statusLine = el('div', { class: 'status-line' });
    if (row.status === 'voided') {
      statusLine.appendChild(el('span', { class: 'pill voided', text: 'VOIDED' }));
      if (row.void_reason) statusLine.appendChild(el('span', { class: 'sub', text: row.void_reason }));
    } else if (row.paid) {
      statusLine.appendChild(
        el('span', { class: 'pill paid', text: 'PAID · ' + row.receipt_number })
      );
    } else {
      statusLine.appendChild(el('span', { class: 'pill unpaid', text: 'Unpaid' }));
      statusLine.appendChild(el('span', { class: 'sub', text: 'Due ' + fmtDate(row.due_date) }));
    }
    statusLine.appendChild(emailIndicator(row));
    statusCell.appendChild(statusLine);
    tr.appendChild(statusCell);

    const actions = el('td', { class: 'actions' });
    actions.appendChild(
      actionButton('View PDF', () => viewPdf('invoices', row.id, row.invoice_number))
    );
    actions.appendChild(actionButton('Save PDF', () => savePdf('invoices', row)));
    if (!row.email_sent_at && row.status !== 'voided') {
      actions.appendChild(actionButton('Retry email', () => retryEmail('invoices', row)));
    }
    if (row.status !== 'voided') {
      actions.appendChild(actionButton('Void', () => voidDocument('invoices', row), 'danger'));
    }
    if (row.status === 'issued' && !row.paid) {
      actions.appendChild(actionButton('Record payment', () => startReceiptFor(row)));
    }
    tr.appendChild(actions);

    body.appendChild(tr);
  }

  $('inv-page').textContent = pagerLabel(view.offset, view.rows.length);
  $('inv-prev').disabled = view.offset === 0;
  $('inv-next').disabled = view.rows.length < PAGE_SIZE;
}

function pagerLabel(offset, count) {
  if (count === 0) return offset === 0 ? '' : `From ${offset + 1}`;
  return `${offset + 1}–${offset + count}`;
}

// ── Receipts list ───────────────────────────────────────────────────────────

function receiptFilters() {
  return {
    student: $('rcp-f-student').value.trim(),
    from: $('rcp-f-from').value,
    to: $('rcp-f-to').value,
    status: $('rcp-f-status').value,
  };
}

async function loadReceipts() {
  const view = state.receipts;
  $('rcp-state').textContent = 'Loading…';
  const query = buildQuery(
    Object.assign({}, view.filters, { limit: PAGE_SIZE, offset: view.offset })
  );
  try {
    const data = await api.listReceipts(query);
    view.rows = data.receipts;
    renderReceipts();
    if (await backfillInvoiceNumbers(view.rows)) renderReceipts();
  } catch (err) {
    $('rcp-state').textContent = '';
    clear($('rcp-rows'));
    reportError(err);
  }
}

function rememberInvoiceNumbers(rows) {
  for (const row of rows) state.invoiceNumbers.set(row.id, row.invoice_number);
}

function againstLabel(row) {
  if (!row.invoice_id) return null;
  const number = state.invoiceNumbers.get(row.invoice_id);
  return number ? 'Against ' + number : 'Against an invoice';
}

// Receipts name the invoice they settle, and the receipts endpoint does not
// carry that number. Rather than one lookup per row, the most recent invoices
// are pulled once and cached — a single request that covers every linked
// receipt at this business's volume. Anything still unknown after that keeps
// the unnumbered wording rather than firing a request storm at a 100/min API.
async function backfillInvoiceNumbers(rows) {
  const missing = rows.some(
    (row) => row.invoice_id && !state.invoiceNumbers.has(row.invoice_id)
  );
  if (!missing || state.numbersBackfilled) return false;
  state.numbersBackfilled = true; // set first: one attempt, never a loop
  try {
    const data = await api.listInvoices(buildQuery({ limit: 100 }));
    rememberInvoiceNumbers(data.invoices);
    return true;
  } catch {
    return false; // the rows still render, just without the invoice number
  }
}

function renderReceipts() {
  const view = state.receipts;
  const body = $('rcp-rows');
  clear(body);

  if (view.rows.length === 0) {
    $('rcp-state').textContent = anyFilterSet(view.filters)
      ? 'No receipts match those filters.'
      : view.offset > 0
        ? 'No more receipts.'
        : 'No receipts yet.';
  } else {
    $('rcp-state').textContent = '';
  }

  for (const row of view.rows) {
    const tr = el('tr');
    tr.appendChild(el('td', { class: 'docnum', text: row.invoice_number }));
    tr.appendChild(el('td', { text: fmtDate(row.issue_date) }));
    tr.appendChild(el('td', { text: row.student_name }));
    tr.appendChild(el('td', { class: 'num', text: amountWithCurrency(row.currency, row.amount) }));

    const statusCell = el('td');
    const statusLine = el('div', { class: 'status-line' });
    if (row.status === 'voided') {
      statusLine.appendChild(el('span', { class: 'pill voided', text: 'VOIDED' }));
      if (row.void_reason) statusLine.appendChild(el('span', { class: 'sub', text: row.void_reason }));
    } else {
      statusLine.appendChild(el('span', { class: 'pill issued', text: 'Issued' }));
    }
    const against = againstLabel(row);
    if (against) statusLine.appendChild(el('span', { class: 'sub', text: against }));
    statusLine.appendChild(emailIndicator(row));
    statusCell.appendChild(statusLine);
    tr.appendChild(statusCell);

    const actions = el('td', { class: 'actions' });
    actions.appendChild(
      actionButton('View PDF', () => viewPdf('receipts', row.id, row.invoice_number))
    );
    actions.appendChild(actionButton('Save PDF', () => savePdf('receipts', row)));
    if (!row.email_sent_at && row.status !== 'voided') {
      actions.appendChild(actionButton('Retry email', () => retryEmail('receipts', row)));
    }
    if (row.status !== 'voided') {
      actions.appendChild(actionButton('Void', () => voidDocument('receipts', row), 'danger'));
    }
    tr.appendChild(actions);

    body.appendChild(tr);
  }

  $('rcp-page').textContent = pagerLabel(view.offset, view.rows.length);
  $('rcp-prev').disabled = view.offset === 0;
  $('rcp-next').disabled = view.rows.length < PAGE_SIZE;
}

// ── Row actions ─────────────────────────────────────────────────────────────

async function viewPdf(kind, id, number) {
  try {
    const blockedUrl = await api.openPdf(`/api/${kind}/${id}/pdf`);
    if (blockedUrl) {
      banner('warn', `Your browser blocked the new tab for ${number}.`, {
        label: 'Open it now',
        run: () => {
          window.open(blockedUrl, '_blank', 'noopener');
          hideBanner();
        },
      });
    }
  } catch (err) {
    if (err.status === 404) {
      banner('warn', `The PDF for ${number} was never stored. "Retry email" rebuilds it.`);
      return;
    }
    reportError(err);
  }
}

// Saves the stored PDF to the downloads folder as "INV-000123 - Aarav
// Sharma.pdf", ready to attach to an email by hand. The document itself is not
// touched and nothing is sent — this is the manual alternative to the automatic
// email, not a replacement for it.
async function savePdf(kind, row) {
  const filename = documentFileName(row.invoice_number, row.student_name);
  try {
    await api.savePdf(`/api/${kind}/${row.id}/pdf`, filename);
    banner('ok', `Saved as ${filename} — attach it to your email.`);
  } catch (err) {
    if (err.status === 404) {
      banner('warn', `The PDF for ${row.invoice_number} was never stored. "Retry email" rebuilds it.`);
      return;
    }
    reportError(err);
  }
}

async function retryEmail(kind, row) {
  const noun = kind === 'invoices' ? 'invoice' : 'receipt';
  const ok = await askConfirm('Send this email again?', [
    { text: `Send ${row.invoice_number} to ${row.parent_email}.`, class: 'emph' },
    { text: `The ${noun} is not changed — only the email is sent again.` },
  ], { confirmLabel: 'Send email' });
  if (!ok) return;

  try {
    if (kind === 'invoices') await api.resendInvoiceEmail(row.id);
    else await api.resendReceiptEmail(row.id);
    banner('ok', `${row.invoice_number} was emailed to ${row.parent_email}.`);
  } catch (err) {
    reportError(err);
  }
  await refreshList(kind);
}

async function voidDocument(kind, row) {
  const noun = kind === 'invoices' ? 'invoice' : 'receipt';
  const reason = await askConfirm(`Void ${row.invoice_number}?`, [
    { text: `The ${noun} stays in the records marked VOIDED — nothing is deleted.` },
    { text: 'The number stays in the sequence, with your reason attached to it.' },
  ], { input: 'Reason', confirmLabel: 'Void it' });
  if (!reason) return;

  try {
    if (kind === 'invoices') await api.voidInvoice(row.id, reason);
    else await api.voidReceipt(row.id, reason);
    banner('ok', `${row.invoice_number} is now marked VOIDED.`);
  } catch (err) {
    reportError(err);
  }
  await refreshList(kind);
}

async function refreshList(kind) {
  if (kind === 'invoices') await loadInvoices();
  else await loadReceipts();
  state.linkableLoaded = false; // the unpaid list may have changed
}

// ── Line items ──────────────────────────────────────────────────────────────

function lineRows() {
  return Array.from($('iv-items').children);
}

function lineInput(row, name) {
  return row.querySelector(`[data-li="${name}"]`);
}

// Returns the new row, or null when the twenty-item ceiling is already reached,
// so quick add can tell the difference rather than silently doing nothing.
function addLineItem() {
  const rows = lineRows();
  if (rows.length >= 20) return null;
  const fragment = $('tpl-line-item').content.cloneNode(true);
  const row = fragment.firstElementChild;
  for (const name of ['description', 'qty', 'rate']) {
    lineInput(row, name).addEventListener('input', recalcInvoice);
  }
  row.querySelector('.li-remove').addEventListener('click', () => {
    if (lineRows().length <= 1) return;
    row.remove();
    recalcInvoice();
  });
  $('iv-items').appendChild(row);
  recalcInvoice();
  return row;
}

// ── Quick add from the fee structure ────────────────────────────────────────
//
// A shortcut into the line items, never an authority over them: it writes the
// published description, quantity and price into a row and stops there. All
// three stay editable, because an invoice sometimes has to depart from the
// price list. The server is not involved and never sees the fee table — it
// still re-derives every total from whatever the line items end up saying.

function renderCourseOptions() {
  const currency = $('iv-currency').value;
  const courses = coursesFor(currency);
  const select = $('iv-qa-course');
  const previous = select.value;

  clear(select);
  for (const course of courses) {
    select.appendChild(el('option', { text: course.name, attrs: { value: course.name } }));
  }

  // No published table for this currency (INR) — hide the shortcut rather than
  // offer an empty dropdown or invent a price.
  $('iv-quickadd').hidden = courses.length === 0;
  if (courses.some((c) => c.name === previous)) select.value = previous;
  $('iv-qa-note').textContent = '';
}

function quickAdd() {
  const line = feeLine($('iv-currency').value, $('iv-qa-course').value, $('iv-qa-package').value);
  if (!line) return;

  // Fill the first wholly untouched row — a fresh form has exactly one — so the
  // common case does not leave an empty line behind. Anything part-filled is
  // left alone; that is the owner's work in progress.
  let row = lineRows().find((r) =>
    ['description', 'qty', 'rate'].every((name) => lineInput(r, name).value.trim() === '')
  );
  if (!row) {
    row = addLineItem();
    if (!row) {
      $('iv-qa-note').textContent = 'There is a limit of 20 items.';
      return;
    }
  }

  lineInput(row, 'description').value = line.description;
  lineInput(row, 'qty').value = String(line.qty);
  lineInput(row, 'rate').value = String(line.rate);
  $('iv-qa-note').textContent =
    `Added ${line.description} at ${amountWithCurrency($('iv-currency').value, line.rate)}. ` +
    'Change anything you need to.';
  recalcInvoice();
}

function readLineItems() {
  return lineRows().map((row) => ({
    row,
    description: lineInput(row, 'description').value.trim(),
    qty: parseNumber(lineInput(row, 'qty').value),
    rate: parseNumber(lineInput(row, 'rate').value),
  }));
}

// ── Live totals ─────────────────────────────────────────────────────────────

function recalcInvoice() {
  const currency = $('iv-currency').value;
  const items = readLineItems();

  let subtotal = 0;
  for (const item of items) {
    const usable =
      item.qty !== null && item.rate !== null && item.qty > 0 && item.rate > 0 &&
      hasAtMost2dp(item.qty) && hasAtMost2dp(item.rate);
    const display = lineInput(item.row, 'amount');
    if (usable) {
      const amount = lineAmountCents(item.qty, item.rate);
      subtotal += amount;
      display.textContent = money(amount / 100);
    } else {
      display.textContent = '—';
    }
  }

  const discount = parseNumber($('iv-discount-amount').value);
  const discountCents = discount !== null && discount > 0 ? cents(discount) : 0;
  const label = $('iv-discount-label').value.trim();
  $('iv-discount-line').hidden = discountCents === 0;
  $('iv-discount-name').textContent = label || 'Discount';
  $('iv-discount-display').textContent = '-' + money(discountCents / 100);

  const total = subtotal - discountCents;
  $('iv-subtotal').textContent = amountWithCurrency(currency, subtotal / 100);
  $('iv-total').textContent = amountWithCurrency(currency, total / 100);

  // Remove is pointless with a single row, and the API caps items at 20.
  const rows = lineRows();
  for (const row of rows) row.querySelector('.li-remove').disabled = rows.length <= 1;
  $('iv-add-item').disabled = rows.length >= 20;
  $('iv-items-note').textContent =
    rows.length >= 20 ? 'That is the maximum of 20 items.' : `${rows.length} of 20 items.`;

  recalcInr(total);
  return { subtotalCents: subtotal, discountCents, totalCents: total };
}

// The rupee figure the rate implies, alongside whatever the owner typed.
function recalcInr(totalCents) {
  if ($('iv-fx').hidden) return;
  const rate = parseNumber($('iv-fx-rate').value);
  const calcNode = $('iv-inr-calc');
  const warn = $('iv-fx-warn');

  if (rate === null || rate <= 0 || totalCents <= 0) {
    calcNode.textContent = '—';
    warn.hidden = true;
    return;
  }

  const expected = (totalCents / 100) * rate;
  calcNode.textContent = 'INR ' + money(expected);

  // Until the owner edits the field themselves, it tracks the calculation.
  if (!state.inrTouched) $('iv-inr-amount').value = expected.toFixed(2);

  const typed = parseNumber($('iv-inr-amount').value);
  if (typed === null || typed <= 0) {
    warn.hidden = true;
    return;
  }
  const off = inrOffByCents(totalCents, rate, typed);
  if (off > INR_TOLERANCE_CENTS) {
    warn.hidden = false;
    warn.textContent =
      `The rupee amount is ${money(off / 100)} away from total × rate. ` +
      `The invoice can only round by up to 1.00 — use something near INR ${money(expected)}.`;
  } else {
    warn.hidden = true;
  }
}

// ── Rate lookup ─────────────────────────────────────────────────────────────
//
// The lookup happens HERE, in the browser, not on the server: the record-writing
// path stays entirely offline, so no outside service can be in the way of an
// invoice being issued. helmet's CSP is extended by exactly one origin
// (connect-src) to allow this call — see app.js in the repo root.
//
// Whatever comes back is a suggestion. Every field stays editable, and a failed
// lookup never blocks anything.
async function fetchRate() {
  const currency = $('iv-currency').value;
  state.fxCurrency = currency;
  const status = $('iv-fx-status');

  if (currency === 'INR') {
    status.textContent = 'This invoice is already in rupees — no conversion needed.';
    return;
  }

  status.textContent = 'Fetching today’s rate…';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FX_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(currency)}&symbols=INR`,
      { signal: controller.signal }
    );
    if (!res.ok) throw new Error('lookup failed');
    const data = await res.json();
    const rate = data && data.rates && data.rates.INR;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new Error('no rate');
    }
    // NUMERIC(18,6) on the server — anything finer would be rounded there.
    const rounded = Math.round(rate * 1e6) / 1e6;
    $('iv-fx-rate').value = String(rounded);
    $('iv-fx-source').value = FX_SOURCE;
    $('iv-fx-date').value = isoDate(data.date) || todayIso();
    status.textContent =
      `1 ${currency} = ${rounded} INR (${FX_SOURCE}, ${fmtDate(data.date)}). ` +
      'Check it and change it if you need to.';
    state.inrTouched = false;
    recalcInvoice();
  } catch {
    $('iv-fx-rate').value = '';
    $('iv-fx-source').value = '';
    $('iv-fx-date').value = '';
    status.textContent = 'Couldn’t fetch a rate — enter it manually.';
    recalcInvoice();
  } finally {
    clearTimeout(timer);
  }
}

// ── Invoice form ────────────────────────────────────────────────────────────

function resetInvoiceForm() {
  const form = $('invoice-form');
  clearFieldErrors(form);
  const today = todayIso();
  $('iv-issue-date').value = today;
  $('iv-due-date').value = addDaysIso(today, 7);
  for (const id of ['iv-student', 'iv-parent', 'iv-email', 'iv-teacher',
    'iv-discount-label', 'iv-discount-amount', 'iv-notes']) {
    $(id).value = '';
  }
  $('iv-currency').value = 'AUD';
  $('iv-show-inr').checked = false;
  $('iv-fx').hidden = true;
  $('iv-fx-status').textContent = '';
  for (const id of ['iv-fx-rate', 'iv-fx-source', 'iv-fx-date', 'iv-inr-amount']) $(id).value = '';
  $('iv-fx-warn').hidden = true;
  $('iv-free-on').checked = false;
  $('iv-free').hidden = true;
  $('iv-free-count').value = '';
  for (const [id] of FREE_CLASS_REASONS) $(id).checked = false;
  $('iv-free-note').textContent = '';
  state.inrTouched = false;
  state.fxCurrency = null;
  clear($('iv-items'));
  addLineItem();
  renderCourseOptions();
  updateIndicativeLabel();
}

function updateIndicativeLabel() {
  $('iv-fx-indicative-label').textContent =
    `Just showing the equivalent — payment is in ${$('iv-currency').value}`;
}

// The three reasons, always in this order however they were ticked, so the note
// on the document reads the same way every time. The server enforces the same
// vocabulary and the same ordering — this is only what the form offers.
const FREE_CLASS_REASONS = [
  ['iv-free-referral', 'Referral'],
  ['iv-free-sibling', 'Sibling'],
  ['iv-free-group', 'Group'],
];

function selectedFreeClassReasons() {
  return FREE_CLASS_REASONS.filter(([id]) => $(id).checked).map(([, name]) => name);
}

// A live plain-language echo of what will print on the invoice, so the wording
// is never a surprise when the PDF arrives.
function updateFreeClassNote() {
  const count = parseNumber($('iv-free-count').value);
  if (count === null || count < 1) {
    $('iv-free-note').textContent = '';
    return;
  }
  const reasons = selectedFreeClassReasons();
  const noun = count === 1 ? 'free class' : 'free classes';
  $('iv-free-note').textContent =
    `The invoice will say: ${count} ${noun} earned on this invoice` +
    (reasons.length > 0 ? ` (${reasons.join(' + ')})` : '') +
    '. It does not change any amount.';
}

function selectedFxMode() {
  const chosen = document.querySelector('input[name="iv-fx-mode"]:checked');
  return chosen ? chosen.value : null;
}

// Client-side validation. Returns the request body, or null when something is
// wrong (messages have already been written next to the fields).
function buildInvoiceBody() {
  const form = $('invoice-form');
  clearFieldErrors(form);
  let ok = true;

  const fail = (id, message) => {
    $(id).textContent = message;
    ok = false;
  };

  const issueDate = $('iv-issue-date').value;
  const dueDate = $('iv-due-date').value;
  if (!issueDate) fail('err-iv-issue_date', 'Choose an issue date.');
  else if (issueDate > todayIso()) fail('err-iv-issue_date', 'The issue date cannot be in the future.');
  if (!dueDate) fail('err-iv-due_date', 'Choose a due date.');
  else if (issueDate && dueDate < issueDate) fail('err-iv-due_date', 'The due date cannot be before the issue date.');
  else if (issueDate && dueDate > addDaysIso(issueDate, 365)) {
    fail('err-iv-due_date', 'The due date is more than a year after the issue date.');
  }

  const student = $('iv-student').value.trim();
  const parent = $('iv-parent').value.trim();
  const email = $('iv-email').value.trim();
  const teacher = $('iv-teacher').value.trim();
  const notes = $('iv-notes').value.trim();
  if (!student) fail('err-iv-student_name', 'Enter the student’s name.');
  if (!parent) fail('err-iv-parent_name', 'Enter the parent’s name.');
  if (!email) fail('err-iv-parent_email', 'Enter the parent’s email address.');
  else if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email)) {
    fail('err-iv-parent_email', 'That does not look like an email address.');
  }

  const items = readLineItems();
  const lineItems = [];
  for (const item of items) {
    const target = lineInput(item.row, 'error');
    target.textContent = '';
    const problems = [];
    if (!item.description) problems.push('a description');
    if (item.qty === null || item.qty <= 0 || !hasAtMost2dp(item.qty) || item.qty > 1000) {
      problems.push('a quantity above zero (up to two decimals, max 1000)');
    }
    if (item.rate === null || item.rate <= 0 || !hasAtMost2dp(item.rate)) {
      problems.push('a rate above zero (up to two decimals)');
    }
    if (problems.length > 0) {
      target.textContent = 'This item needs ' + problems.join(', ') + '.';
      ok = false;
      continue;
    }
    const amountCents = lineAmountCents(item.qty, item.rate);
    if (amountCents <= 0) {
      target.textContent = 'This item works out to nothing — check the quantity and rate.';
      ok = false;
      continue;
    }
    lineItems.push({
      description: item.description,
      qty: item.qty,
      rate: item.rate,
      amount: amountCents / 100,
    });
  }
  if (lineItems.length === 0 && items.length > 0 && ok) {
    fail('err-iv-line_items', 'Add at least one item.');
  }

  const totals = recalcInvoice();
  const discount = parseNumber($('iv-discount-amount').value);
  const discountLabel = $('iv-discount-label').value.trim();
  if (discount !== null) {
    if (discount < 0 || !hasAtMost2dp(discount)) {
      fail('err-iv-discount_amount', 'Enter a discount of zero or more, with at most two decimals.');
    } else if (discount > 0 && !discountLabel) {
      fail('err-iv-discount_label', 'Give the discount a label so it can be printed.');
    } else if (cents(discount) >= totals.subtotalCents) {
      fail('err-iv-discount_amount', 'The discount must be less than the subtotal.');
    }
  } else if (discountLabel) {
    fail('err-iv-discount_amount', 'Enter a discount amount, or clear the label.');
  }

  if (ok && totals.totalCents <= 0) fail('err-iv-total', 'The total must be more than zero.');

  const body = {
    issue_date: issueDate,
    due_date: dueDate,
    student_name: student,
    parent_name: parent,
    parent_email: email,
    teacher_name: teacher || null,
    line_items: lineItems,
    subtotal: totals.subtotalCents / 100,
    discount_label: discount !== null && discount > 0 ? discountLabel : null,
    discount_amount: discount !== null && discount > 0 ? discount : null,
    total: totals.totalCents / 100,
    currency: $('iv-currency').value,
    notes: notes || null,
  };

  // The five FX fields travel together or not at all — a partial block is a
  // guaranteed 400.
  if ($('iv-show-inr').checked) {
    const rate = parseNumber($('iv-fx-rate').value);
    const source = $('iv-fx-source').value.trim();
    const fxDate = $('iv-fx-date').value;
    const inr = parseNumber($('iv-inr-amount').value);
    if (rate === null || rate <= 0) fail('err-iv-fx_rate', 'Enter the exchange rate, or untick "Show INR amount".');
    if (!source) fail('err-iv-fx_source', 'Say where the rate came from.');
    if (!fxDate) fail('err-iv-fx_date', 'Give the date the rate is from.');
    else if (fxDate > todayIso()) fail('err-iv-fx_date', 'The rate date cannot be in the future.');
    else if (issueDate && fxDate < addDaysIso(issueDate, -30)) {
      fail('err-iv-fx_date', 'The rate date is more than 30 days before the issue date.');
    }
    if (!selectedFxMode()) fail('err-iv-fx_mode', 'Choose how the rupee figure is used.');
    if (inr === null || inr <= 0 || !hasAtMost2dp(inr)) {
      fail('err-iv-inr_amount', 'Enter the rupee amount (up to two decimals).');
    } else if (rate !== null && rate > 0 && totals.totalCents > 0) {
      const off = inrOffByCents(totals.totalCents, rate, inr);
      if (off > INR_TOLERANCE_CENTS) {
        fail(
          'err-iv-inr_amount',
          `This is ${money(off / 100)} away from total × rate — the invoice can only round by up to 1.00.`
        );
      }
    }
    if (ok) {
      body.fx_rate = rate;
      body.fx_source = source;
      body.fx_date = fxDate;
      body.fx_mode = selectedFxMode();
      body.inr_amount = inr;
    }
  }

  // Free classes earned. Nothing here touches a total — it is teaching time,
  // not money — so it is checked after the figures and cannot disturb them.
  if ($('iv-free-on').checked) {
    const count = parseNumber($('iv-free-count').value);
    if (count === null || !Number.isInteger(count) || count < 1 || count > 100) {
      fail('err-iv-free_class_count', 'Enter how many free classes were earned (a whole number, 1 to 100).');
    } else if (ok) {
      body.free_class_count = count;
      const reasons = selectedFreeClassReasons();
      if (reasons.length > 0) body.free_class_reasons = reasons;
    }
  }

  if (!ok) {
    $('iv-form-error').textContent = 'Some details need fixing — see the messages above.';
    return null;
  }
  $('iv-form-error').textContent = '';
  return body;
}

async function submitInvoice() {
  const body = buildInvoiceBody();
  if (!body) return;

  const lines = [
    { text: `Issue invoice to ${body.parent_email} for ${amountWithCurrency(body.currency, body.total)}`, class: 'emph' },
    { text: `Student: ${body.student_name}` },
    { text: `Due ${fmtDate(body.due_date)}` },
  ];
  if (body.inr_amount !== undefined) {
    lines.push({
      text:
        `Shows INR ${money(body.inr_amount)} — ` +
        (body.fx_mode === 'payable'
          ? 'the parent is paying in rupees.'
          : `for reference only; payment is in ${body.currency}.`),
    });
  }
  if (body.free_class_count !== undefined) {
    const noun = body.free_class_count === 1 ? 'free class' : 'free classes';
    lines.push({
      text:
        `Records ${body.free_class_count} ${noun}` +
        (body.free_class_reasons ? ` (${body.free_class_reasons.join(' + ')})` : '') +
        ' — this does not change the amount.',
    });
  }
  lines.push({ text: 'The invoice will be EMAILED to the parent immediately.', class: 'caution' });

  const confirmed = await askConfirm('Issue this invoice?', lines, { confirmLabel: 'Issue and email' });
  if (!confirmed) return;

  await withBusy($('iv-submit'), 'Issuing…', async () => {
    try {
      const result = await api.createInvoice(body);
      const invoice = result.invoice;
      if (result.emailed) {
        banner('ok', `Invoice ${invoice.invoice_number} issued and emailed to ${invoice.parent_email}.`, {
          label: 'View PDF',
          run: () => viewPdf('invoices', invoice.id, invoice.invoice_number),
        });
      } else {
        banner(
          'warn',
          `Invoice ${invoice.invoice_number} is recorded, but the email did not go out. ` +
            'Save the PDF and send it yourself, or use Retry email from the list.',
          { label: 'Save PDF', run: () => savePdf('invoices', invoice) }
        );
      }
      resetInvoiceForm();
      state.linkableLoaded = false;
      state.invoices.offset = 0;
      await loadInvoices();
    } catch (err) {
      if (err.status === 400 && err.fields) {
        renderServerErrors($('invoice-form'), 'iv', err.fields, 'iv-form-error');
        banner('error', 'The invoice was not issued — some details need fixing.');
      } else {
        reportError(err);
      }
    }
  });
}

// ── Receipt form ────────────────────────────────────────────────────────────

async function loadLinkableInvoices() {
  if (state.linkableLoaded) return;
  $('rc-invoice-note').textContent = 'Loading unpaid invoices…';
  try {
    const data = await api.listInvoices(
      buildQuery({ paid: 'false', status: 'issued', limit: 100 })
    );
    state.linkable = data.invoices;
    state.linkableLoaded = true;
    rememberInvoiceNumbers(data.invoices);
    $('rc-invoice-note').textContent = '';
  } catch (err) {
    state.linkable = [];
    $('rc-invoice-note').textContent =
      'Could not load the unpaid invoices — you can still record a standalone receipt.';
    if (err.status === 401) return;
  }
  renderInvoiceOptions();
}

function invoiceOptionLabel(invoice) {
  return [
    invoice.invoice_number,
    invoice.student_name,
    amountWithCurrency(invoice.currency, invoice.total),
    fmtDate(invoice.issue_date),
  ].join(' · ');
}

function renderInvoiceOptions() {
  const select = $('rc-invoice');
  const term = $('rc-invoice-search').value.trim().toLowerCase();
  const previous = select.value;
  clear(select);

  select.appendChild(
    el('option', { text: 'No invoice — standalone receipt', attrs: { value: '' } })
  );

  const matches = state.linkable.filter((invoice) => {
    if (term === '') return true;
    return (
      invoice.invoice_number.toLowerCase().includes(term) ||
      invoice.student_name.toLowerCase().includes(term)
    );
  });

  for (const invoice of matches) {
    select.appendChild(
      el('option', { text: invoiceOptionLabel(invoice), attrs: { value: String(invoice.id) } })
    );
  }

  // Keep the current choice when it survived the filter.
  if (previous && matches.some((i) => String(i.id) === previous)) select.value = previous;
  else if (previous && state.selectedInvoice && String(state.selectedInvoice.id) === previous) {
    // The selected invoice was filtered out — put it back rather than silently
    // unlinking a receipt the owner already set up.
    select.appendChild(
      el('option', {
        text: invoiceOptionLabel(state.selectedInvoice),
        attrs: { value: previous },
      })
    );
    select.value = previous;
  }

  if (state.linkable.length === 0 && state.linkableLoaded) {
    $('rc-invoice-note').textContent = 'No unpaid invoices — this will be a standalone receipt.';
  } else if (term !== '' && matches.length === 0) {
    $('rc-invoice-note').textContent = 'No unpaid invoice matches that search.';
  }
}

function applyInvoiceSelection() {
  const value = $('rc-invoice').value;
  const invoice = state.linkable.find((i) => String(i.id) === value) || null;
  state.selectedInvoice = invoice;

  const currency = $('rc-currency');
  if (!invoice) {
    currency.disabled = false;
    $('rc-invoice-note').textContent = 'This receipt is not linked to an invoice.';
    return;
  }

  $('rc-student').value = invoice.student_name;
  $('rc-parent').value = invoice.parent_name;
  $('rc-email').value = invoice.parent_email;
  $('rc-teacher').value = invoice.teacher_name || '';
  $('rc-amount').value = Number(invoice.total).toFixed(2);
  currency.value = invoice.currency;
  currency.disabled = true; // the API rejects a currency that differs
  $('rc-invoice-note').textContent =
    `Prefilled from ${invoice.invoice_number}. Everything stays editable except the currency, ` +
    `which must match the invoice (${invoice.currency}).`;
}

function resetReceiptForm() {
  const form = $('receipt-form');
  clearFieldErrors(form);
  $('rc-issue-date').value = todayIso();
  for (const id of ['rc-student', 'rc-parent', 'rc-email', 'rc-teacher',
    'rc-amount', 'rc-reference', 'rc-description']) {
    $(id).value = '';
  }
  $('rc-currency').value = 'AUD';
  $('rc-currency').disabled = false;
  $('rc-method').value = 'bank_transfer';
  $('rc-invoice-search').value = '';
  state.selectedInvoice = null;
  renderInvoiceOptions();
  $('rc-invoice').value = '';
  $('rc-invoice-note').textContent = '';
}

function buildReceiptBody() {
  const form = $('receipt-form');
  clearFieldErrors(form);
  let ok = true;
  const fail = (id, message) => {
    $(id).textContent = message;
    ok = false;
  };

  const issueDate = $('rc-issue-date').value;
  if (!issueDate) fail('err-rc-issue_date', 'Choose a date.');
  else if (issueDate > todayIso()) fail('err-rc-issue_date', 'The date cannot be in the future.');

  const student = $('rc-student').value.trim();
  const parent = $('rc-parent').value.trim();
  const email = $('rc-email').value.trim();
  const teacher = $('rc-teacher').value.trim();
  const description = $('rc-description').value.trim();
  const reference = $('rc-reference').value.trim();
  if (!student) fail('err-rc-student_name', 'Enter the student’s name.');
  if (!parent) fail('err-rc-parent_name', 'Enter the parent’s name.');
  if (!email) fail('err-rc-parent_email', 'Enter the parent’s email address.');
  else if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email)) {
    fail('err-rc-parent_email', 'That does not look like an email address.');
  }
  if (!description) fail('err-rc-fee_description', 'Say what the payment was for.');

  const amount = parseNumber($('rc-amount').value);
  if (amount === null || amount <= 0) fail('err-rc-amount', 'Enter an amount greater than zero.');
  else if (!hasAtMost2dp(amount)) fail('err-rc-amount', 'Use at most two decimal places.');

  if (!ok) {
    $('rc-form-error').textContent = 'Some details need fixing — see the messages above.';
    return null;
  }
  $('rc-form-error').textContent = '';

  return {
    issue_date: issueDate,
    student_name: student,
    parent_name: parent,
    parent_email: email,
    teacher_name: teacher || null,
    amount,
    currency: $('rc-currency').value,
    payment_method: $('rc-method').value,
    payment_reference: reference || null,
    fee_description: description,
    invoice_id: state.selectedInvoice ? state.selectedInvoice.id : null,
  };
}

async function submitReceipt() {
  const body = buildReceiptBody();
  if (!body) return;

  const lines = [
    { text: `Issue receipt to ${body.parent_email} for ${amountWithCurrency(body.currency, body.amount)}`, class: 'emph' },
    { text: `Student: ${body.student_name}` },
    {
      text:
        `Payment: ${PAYMENT_METHOD_LABELS[body.payment_method]}` +
        (body.payment_reference ? ` · ${body.payment_reference}` : ''),
    },
    {
      text: state.selectedInvoice
        ? `Against ${state.selectedInvoice.invoice_number} — that invoice will then read PAID.`
        : 'Standalone receipt — not linked to any invoice.',
    },
    { text: 'The receipt will be EMAILED to the parent immediately.', class: 'caution' },
  ];

  const confirmed = await askConfirm('Issue this receipt?', lines, { confirmLabel: 'Issue and email' });
  if (!confirmed) return;

  await withBusy($('rc-submit'), 'Issuing…', async () => {
    try {
      const result = await api.createReceipt(body);
      const receipt = result.receipt;
      if (result.emailed) {
        banner('ok', `Receipt ${receipt.invoice_number} issued and emailed to ${receipt.parent_email}.`, {
          label: 'View PDF',
          run: () => viewPdf('receipts', receipt.id, receipt.invoice_number),
        });
      } else {
        banner(
          'warn',
          `Receipt ${receipt.invoice_number} is recorded, but the email did not go out. ` +
            'Save the PDF and send it yourself, or use Retry email from the list.',
          { label: 'Save PDF', run: () => savePdf('receipts', receipt) }
        );
      }
      state.linkableLoaded = false;
      resetReceiptForm();
      await loadLinkableInvoices();
      state.receipts.offset = 0;
    } catch (err) {
      if (err.status === 400 && err.fields) {
        renderServerErrors($('receipt-form'), 'rc', err.fields, 'rc-form-error');
        banner('error', 'The receipt was not issued — some details need fixing.');
      } else {
        reportError(err);
      }
    }
  });
}

// Jumps from an invoice row straight into the receipt form with that invoice
// already chosen.
async function startReceiptFor(invoice) {
  selectTab('new');
  showNewForm('receipt');
  state.linkableLoaded = false;
  await loadLinkableInvoices();
  resetReceiptForm();
  // The invoice is unpaid and issued, so it is in the list; if a race removed
  // it, put it in explicitly rather than quietly falling back to standalone.
  if (!state.linkable.some((i) => i.id === invoice.id)) {
    state.linkable.push(invoice);
    renderInvoiceOptions();
  }
  $('rc-invoice').value = String(invoice.id);
  applyInvoiceSelection();
  $('rc-description').focus();
}

// ── "New" tab ───────────────────────────────────────────────────────────────

function showNewForm(which) {
  $('invoice-form').hidden = which !== 'invoice';
  $('receipt-form').hidden = which !== 'receipt';
  $('new-choice-invoice').setAttribute('aria-pressed', String(which === 'invoice'));
  $('new-choice-receipt').setAttribute('aria-pressed', String(which === 'receipt'));
  if (which === 'receipt') loadLinkableInvoices();
}

// ── Wiring ──────────────────────────────────────────────────────────────────

function initTabs() {
  for (const name of ['invoices', 'receipts', 'new']) {
    $('tab-btn-' + name).addEventListener('click', () => selectTab(name));
  }
}

function initInvoiceList() {
  $('inv-filters').addEventListener('submit', (event) => {
    event.preventDefault();
    state.invoices.filters = invoiceFilters();
    state.invoices.offset = 0;
    loadInvoices();
  });
  $('inv-f-clear').addEventListener('click', () => {
    for (const id of ['inv-f-student', 'inv-f-from', 'inv-f-to']) $(id).value = '';
    $('inv-f-status').value = '';
    $('inv-f-paid').value = '';
    state.invoices.filters = {};
    state.invoices.offset = 0;
    loadInvoices();
  });
  $('inv-prev').addEventListener('click', () => {
    state.invoices.offset = Math.max(0, state.invoices.offset - PAGE_SIZE);
    loadInvoices();
  });
  $('inv-next').addEventListener('click', () => {
    state.invoices.offset += PAGE_SIZE;
    loadInvoices();
  });
  $('inv-export').addEventListener('click', (event) =>
    withBusy(event.currentTarget, 'Preparing…', async () => {
      try {
        await api.downloadCsv('/api/invoices/export.csv', 'invoices-export.csv');
      } catch (err) {
        reportError(err);
      }
    })
  );
}

function initReceiptList() {
  $('rcp-filters').addEventListener('submit', (event) => {
    event.preventDefault();
    state.receipts.filters = receiptFilters();
    state.receipts.offset = 0;
    loadReceipts();
  });
  $('rcp-f-clear').addEventListener('click', () => {
    for (const id of ['rcp-f-student', 'rcp-f-from', 'rcp-f-to']) $(id).value = '';
    $('rcp-f-status').value = '';
    state.receipts.filters = {};
    state.receipts.offset = 0;
    loadReceipts();
  });
  $('rcp-prev').addEventListener('click', () => {
    state.receipts.offset = Math.max(0, state.receipts.offset - PAGE_SIZE);
    loadReceipts();
  });
  $('rcp-next').addEventListener('click', () => {
    state.receipts.offset += PAGE_SIZE;
    loadReceipts();
  });
  $('rcp-export').addEventListener('click', (event) =>
    withBusy(event.currentTarget, 'Preparing…', async () => {
      try {
        await api.downloadCsv('/api/receipts/export.csv', 'receipts-export.csv');
      } catch (err) {
        reportError(err);
      }
    })
  );
}

function initInvoiceForm() {
  const form = $('invoice-form');
  form.noValidate = true;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitInvoice();
  });

  $('iv-add-item').addEventListener('click', addLineItem);
  $('iv-qa-add').addEventListener('click', quickAdd);
  $('iv-discount-amount').addEventListener('input', recalcInvoice);
  $('iv-discount-label').addEventListener('input', recalcInvoice);
  $('iv-currency').addEventListener('change', () => {
    // The fee tables are per currency, so the course list follows it. Lines
    // already added keep the prices they were added at — changing currency has
    // never rewritten an existing line and must not start.
    renderCourseOptions();
    updateIndicativeLabel();
    recalcInvoice();
    if (!$('iv-fx').hidden && state.fxCurrency !== $('iv-currency').value) fetchRate();
  });

  $('iv-issue-date').addEventListener('change', () => {
    // Keep the usual week's grace unless the owner has moved the due date away
    // from it themselves.
    const issue = $('iv-issue-date').value;
    if (issue && $('iv-due-date').value < issue) $('iv-due-date').value = addDaysIso(issue, 7);
  });

  $('iv-show-inr').addEventListener('change', () => {
    const on = $('iv-show-inr').checked;
    $('iv-fx').hidden = !on;
    if (on) {
      state.inrTouched = false;
      fetchRate();
    } else {
      $('iv-fx-warn').hidden = true;
    }
  });
  $('iv-free-on').addEventListener('change', () => {
    const on = $('iv-free-on').checked;
    $('iv-free').hidden = !on;
    if (!on) {
      $('iv-free-count').value = '';
      for (const [id] of FREE_CLASS_REASONS) $(id).checked = false;
    }
    updateFreeClassNote();
  });
  $('iv-free-count').addEventListener('input', updateFreeClassNote);
  for (const [id] of FREE_CLASS_REASONS) {
    $(id).addEventListener('change', updateFreeClassNote);
  }

  $('iv-fx-rate').addEventListener('input', recalcInvoice);
  $('iv-inr-amount').addEventListener('input', () => {
    state.inrTouched = true;
    recalcInvoice();
  });
}

function initReceiptForm() {
  const form = $('receipt-form');
  form.noValidate = true;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitReceipt();
  });
  $('rc-invoice-search').addEventListener('input', renderInvoiceOptions);
  $('rc-invoice').addEventListener('change', applyInvoiceSelection);
  $('new-choice-invoice').addEventListener('click', () => showNewForm('invoice'));
  $('new-choice-receipt').addEventListener('click', () => showNewForm('receipt'));
}

function init() {
  initBanner();
  initDialog();
  initLogin();
  initTabs();
  initInvoiceList();
  initReceiptList();
  initInvoiceForm();
  initReceiptForm();

  api.setUnauthorizedHandler(() => showLogin('Session expired — log in again.'));

  resetInvoiceForm();
  resetReceiptForm();
  showNewForm('invoice');

  if (api.getToken()) showMain();
  else showLogin('');
}

init();
