// public/ui.js — the small DOM toolkit the screens are built from: element
// creation, the message banner, the confirm/reason dialog, and busy buttons.
//
// One rule runs through the whole file: every value that came from the database
// or from a person is written with textContent. Nothing is ever assembled into
// an HTML string. These documents carry parents' and children's names, and a
// name is not markup.

export function $(id) {
  return document.getElementById(id);
}

// el('span', { class: 'pill paid', text: 'PAID' })
// `text` goes in as textContent, always.
export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
  if (options.type) node.type = options.type;
  if (options.title) node.title = options.title;
  if (options.attrs) {
    for (const key of Object.keys(options.attrs)) node.setAttribute(key, options.attrs[key]);
  }
  if (options.onClick) node.addEventListener('click', options.onClick);
  for (const child of children) {
    if (child) node.appendChild(child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function show(node, visible) {
  node.hidden = !visible;
}

// ── Busy buttons ────────────────────────────────────────────────────────────
//
// A disabled button during a request, plus the confirm step in front of every
// document-creating action, is what makes a double submission impossible from
// this side of the wire.

export function setBusy(button, busy, busyLabel) {
  if (busy) {
    if (button.dataset.idleLabel === undefined) button.dataset.idleLabel = button.textContent;
    button.disabled = true;
    if (busyLabel) button.textContent = busyLabel;
  } else {
    button.disabled = false;
    if (button.dataset.idleLabel !== undefined) {
      button.textContent = button.dataset.idleLabel;
      delete button.dataset.idleLabel;
    }
  }
}

// Runs fn with the button disabled, restoring it whatever happens.
export async function withBusy(button, busyLabel, fn) {
  setBusy(button, true, busyLabel);
  try {
    return await fn();
  } finally {
    setBusy(button, false);
  }
}

// ── Banner ──────────────────────────────────────────────────────────────────

let bannerAction = null;

export function initBanner() {
  $('banner-close').addEventListener('click', hideBanner);
  $('banner-action').addEventListener('click', () => {
    if (bannerAction) bannerAction();
  });
}

// kind: 'ok' | 'warn' | 'error'. action is an optional { label, run }.
export function banner(kind, text, action) {
  const node = $('banner');
  node.className = 'banner ' + kind;
  $('banner-text').textContent = text;
  const actionButton = $('banner-action');
  if (action) {
    bannerAction = action.run;
    actionButton.textContent = action.label;
    actionButton.hidden = false;
  } else {
    bannerAction = null;
    actionButton.textContent = '';
    actionButton.hidden = true;
  }
  node.hidden = false;
  node.scrollIntoView({ block: 'nearest' });
}

export function hideBanner() {
  const node = $('banner');
  node.hidden = true;
  bannerAction = null;
  $('banner-action').hidden = true;
}

// ── Dialog ──────────────────────────────────────────────────────────────────
//
// One dialog serves both jobs: a plain confirmation, and a confirmation that
// also requires a typed reason (voiding). It resolves to false/null on cancel,
// so a caller can never mistake "the owner backed out" for "go ahead".

let dialogResolve = null;
let dialogNeedsInput = false;

export function initDialog() {
  $('dialog-cancel').addEventListener('click', () => settleDialog(null));
  $('dialog-confirm').addEventListener('click', () => {
    if (!dialogNeedsInput) return settleDialog(true);
    const value = $('dialog-input').value.trim();
    if (value.length === 0) {
      $('dialog-input-error').textContent = 'Please give a reason — it is kept with the record.';
      $('dialog-input').focus();
      return;
    }
    settleDialog(value);
  });
  // Escape cancels; clicking the backdrop cancels.
  $('dialog-overlay').addEventListener('click', (event) => {
    if (event.target === $('dialog-overlay')) settleDialog(null);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('dialog-overlay').hidden) settleDialog(null);
  });
}

function settleDialog(value) {
  const resolve = dialogResolve;
  dialogResolve = null;
  $('dialog-overlay').hidden = true;
  if (resolve) resolve(value);
}

// lines: array of { text, class? } — each becomes its own paragraph, written
// with textContent.
//
// Resolves to true (plain confirm) or the trimmed reason string (when
// options.input is given); null when cancelled.
export function askConfirm(title, lines, options = {}) {
  if (dialogResolve) settleDialog(null); // never stack dialogs

  $('dialog-title').textContent = title;
  const body = $('dialog-body');
  clear(body);
  for (const line of lines) {
    body.appendChild(el('p', { class: line.class || '', text: line.text }));
  }

  dialogNeedsInput = Boolean(options.input);
  const wrap = $('dialog-input-wrap');
  wrap.hidden = !dialogNeedsInput;
  $('dialog-input-error').textContent = '';
  $('dialog-input').value = '';
  if (dialogNeedsInput) $('dialog-input-label').textContent = options.input;

  $('dialog-confirm').textContent = options.confirmLabel || 'Confirm';
  $('dialog-cancel').textContent = options.cancelLabel || 'Cancel';
  $('dialog-overlay').hidden = false;

  const focusTarget = dialogNeedsInput ? $('dialog-input') : $('dialog-confirm');
  focusTarget.focus();

  return new Promise((resolve) => {
    dialogResolve = resolve;
  });
}
