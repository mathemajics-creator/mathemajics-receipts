// public/api.js — everything that talks to the server, and the one place the
// session token is read or written.
//
// The token lives in sessionStorage: it survives a page refresh and dies with
// the tab. Deliberately NOT localStorage (it would outlive the browsing
// session) and NOT a cookie (nothing here needs one, and a bearer header has no
// cross-site request forgery surface).

const TOKEN_KEY = 'receipts_token';

let unauthorizedHandler = null;

// app.js registers what should happen when any call comes back 401: drop the
// token and return to the login screen.
export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = fn;
}

export function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // storage blocked — the session simply will not persist
  }
}

export function setToken(token) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore — the in-memory session still works for this page load */
  }
}

export function clearToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  constructor(status, code, fields) {
    super(code || 'request_failed');
    this.status = status;
    this.code = code || 'request_failed';
    this.fields = fields || null;
  }
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: 'Bearer ' + token } : {};
}

// A 401 from any call except login means the session is gone. Handled in one
// place so no caller can forget it.
function handleUnauthorized() {
  clearToken();
  if (unauthorizedHandler) unauthorizedHandler();
}

// opts.allow401 is set only by login(), where a 401 means "wrong password"
// rather than "your session expired".
async function request(path, { method = 'GET', body, allow401 = false } = {}) {
  const headers = Object.assign({}, authHeaders());
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, 'network_error');
  }

  if (res.status === 401 && !allow401) {
    handleUnauthorized();
    throw new ApiError(401, 'unauthorized');
  }

  if (res.status === 204) return null;

  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    throw new ApiError(res.status, data && data.error, data && data.fields);
  }
  return data;
}

// ── Session ─────────────────────────────────────────────────────────────────

export async function login(password) {
  const data = await request('/api/login', {
    method: 'POST',
    body: { password },
    allow401: true,
  });
  setToken(data.token);
  return data;
}

export async function logout() {
  try {
    await request('/api/logout', { method: 'POST' });
  } catch {
    // A failed logout must never strand the owner on a screen they cannot
    // leave; the local token is dropped either way.
  }
  clearToken();
}

// ── Invoices ────────────────────────────────────────────────────────────────

export function listInvoices(query) {
  return request('/api/invoices' + query);
}

export function createInvoice(body) {
  return request('/api/invoices', { method: 'POST', body });
}

export function voidInvoice(id, reason) {
  return request(`/api/invoices/${id}/void`, { method: 'POST', body: { reason } });
}

export function resendInvoiceEmail(id) {
  return request(`/api/invoices/${id}/send-email`, { method: 'POST' });
}

// ── Receipts ────────────────────────────────────────────────────────────────

export function listReceipts(query) {
  return request('/api/receipts' + query);
}

export function createReceipt(body) {
  return request('/api/receipts', { method: 'POST', body });
}

export function voidReceipt(id, reason) {
  return request(`/api/receipts/${id}/void`, { method: 'POST', body: { reason } });
}

export function resendReceiptEmail(id) {
  return request(`/api/receipts/${id}/send-email`, { method: 'POST' });
}

// ── Authenticated file downloads ────────────────────────────────────────────
//
// PDFs and CSVs sit behind requireAdmin, so a plain <a href> cannot fetch them
// — a link carries no Authorization header. Everything below fetches the bytes
// with the header, wraps them in an object URL, hands that to the browser, and
// revokes it afterwards.

async function fetchBlob(path) {
  let res;
  try {
    res = await fetch(path, { headers: authHeaders() });
  } catch {
    throw new ApiError(0, 'network_error');
  }
  if (res.status === 401) {
    handleUnauthorized();
    throw new ApiError(401, 'unauthorized');
  }
  if (!res.ok) {
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json().catch(() => null) : null;
    throw new ApiError(res.status, data && data.error);
  }
  return {
    blob: await res.blob(),
    disposition: res.headers.get('content-disposition') || '',
  };
}

// Content-Disposition: attachment; filename="invoices-export-2026-08-26.csv"
export function filenameFromDisposition(disposition, fallback) {
  const match = /filename="?([^";]+)"?/i.exec(disposition || '');
  return match ? match[1] : fallback;
}

// Opens a PDF in a new tab. Returns the object URL when the browser's popup
// blocker refused the window, so the caller can offer a link the owner clicks
// directly — a fresh gesture always gets through. Returns null on success.
export async function openPdf(path) {
  const { blob } = await fetchBlob(path);
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank', 'noopener');
  // The tab holds the URL open while it loads; a minute is far longer than any
  // load needs and short enough not to leak for a whole session.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return win ? null : url;
}

export async function downloadCsv(path, fallbackName) {
  const { blob, disposition } = await fetchBlob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filenameFromDisposition(disposition, fallbackName);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
