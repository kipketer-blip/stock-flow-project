'use strict';
// Shared helpers used by every page: formatting, API calls, dialogs, routing.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString();
const signed = (n) => `<span class="${n >= 0 ? 'pos' : 'neg'}">${n > 0 ? '+' : ''}${num(n)}</span>`;

let me = null;
let settings = { currency: 'USD', company_name: 'StockFlow Pro' };

function money(n) {
  try {
    return Number(n || 0).toLocaleString(undefined, { style: 'currency', currency: settings.currency });
  } catch {
    return `${settings.currency} ${Number(n || 0).toFixed(2)}`;
  }
}

// SQLite stores UTC 'YYYY-MM-DD HH:MM:SS'; show it in the viewer's local time.
const toLocal = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
const fmtDate = (s) => (s ? toLocal(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtDay = (s) => (s ? new Date(s + 'T00:00:00').toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
const localDay = (d = new Date()) => d.toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
const TZ = -new Date().getTimezoneOffset(); // minutes ahead of UTC, sent so the server groups by local day

async function api(method, url, body) {
  if (method === 'GET' && url.startsWith('/api/')) url += `${url.includes('?') ? '&' : '?'}tz=${TZ}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error('Session expired, please sign in again'); }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind === true ? 'err' : kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), kind === 'warn' ? 6000 : 3000);
}

// Generic dialog. `onSubmit(formData, form)` resolves to close it, or throws to keep it open and show the error.
// Pass submitLabel = null for a dialog with only a Close button.
function openModal(title, bodyHtml, onSubmit, submitLabel = 'Save', submitClass = 'primary', { wide = false } = {}) {
  const dlg = $('#modal');
  const form = $('#modal-form');
  dlg.classList.toggle('wide', wide);
  form.innerHTML = `<h2>${esc(title)}</h2>${bodyHtml}
    <p class="error" id="modal-error"></p>
    <div class="modal-actions">
      <button type="button" class="btn" data-close>${submitLabel ? 'Cancel' : 'Close'}</button>
      ${submitLabel ? `<button type="submit" class="btn ${submitClass}">${esc(submitLabel)}</button>` : ''}
    </div>`;
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!onSubmit) return dlg.close();
    const btn = form.querySelector('[type=submit]');
    if (btn) btn.disabled = true;
    try {
      await onSubmit(Object.fromEntries(new FormData(form)), form);
      dlg.close();
    } catch (err) {
      $('#modal-error').textContent = err.message;
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  $('[data-close]', form).onclick = () => dlg.close();
  dlg.onclose = () => dlg.dispatchEvent(new Event('modal-closed'));
  dlg.showModal();
  form.querySelector('[autofocus], input:not([type=hidden]):not([type=checkbox]), select')?.focus();
  return form;
}

// "Page 2 of 9  ‹ ›" control. `go(page)` is called with the new page number.
function pager(page, pages, total, label = 'rows') {
  if (pages <= 1) return `<div class="pager muted">${num(total)} ${label}</div>`;
  return `<div class="pager">
    <span class="muted">${num(total)} ${label} · page ${page} of ${pages}</span>
    <button type="button" class="btn small" data-page="1" ${page <= 1 ? 'disabled' : ''} aria-label="First page">«</button>
    <button type="button" class="btn small" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="Previous page">‹ Prev</button>
    <button type="button" class="btn small" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="Next page">Next ›</button>
    <button type="button" class="btn small" data-page="${pages}" ${page >= pages ? 'disabled' : ''} aria-label="Last page">»</button>
  </div>`;
}
function bindPager(root, go) {
  $$('[data-page]', root).forEach((b) => { b.onclick = () => go(Number(b.dataset.page)); });
}

// Updates the current hash's query string (keeping the page name) and re-renders.
function setQuery(params) {
  const [name] = location.hash.replace(/^#\/?/, '').split('?');
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
  location.hash = `#/${name}${qs ? '?' + qs : ''}`;
}

// Minimal CSV parser (handles quotes, commas and newlines inside quotes, BOM, ; or , separators).
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

function downloadText(filename, text, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- locations ----------
let locations = []; // active locations, default first

async function loadLocations() {
  try { locations = await api('GET', '/api/locations'); } catch { locations = []; }
  return locations;
}
const defaultLocation = () => locations.find((l) => l.is_default) || locations[0];

// The location last used on this computer (falls back to the default).
function preferredLocationId() {
  let saved = null;
  try { saved = Number(localStorage.getItem('locationId')); } catch { /* storage unavailable */ }
  return locations.some((l) => l.id === saved) ? saved : defaultLocation()?.id;
}
function rememberLocation(id) {
  try { localStorage.setItem('locationId', String(id)); } catch { /* ignore */ }
}

function locationOptions(selectedId, { includeAll = false, allLabel = 'All locations' } = {}) {
  return (includeAll ? `<option value="">${allLabel}</option>` : '') + locations
    .map((l) => `<option value="${l.id}" ${String(l.id) === String(selectedId) ? 'selected' : ''}>${esc(l.name)}${l.is_default ? ' (main)' : ''}</option>`)
    .join('');
}

// "Main 40 · Westlands 10" (only when there is more than one location)
const levelsText = (p) =>
  locations.length > 1 && p.levels?.length ? p.levels.map((l) => `${esc(l.name)} ${num(l.quantity)}`).join(' · ') : '';

// Prints the given HTML on its own (labels, invoices).
function printHtml(html) {
  const area = $('#print-area');
  area.innerHTML = html;
  document.body.classList.add('print-labels');
  const done = () => { document.body.classList.remove('print-labels'); area.innerHTML = ''; };
  window.addEventListener('afterprint', done, { once: true });
  setTimeout(() => window.print(), 50);
}

// ---------- router ----------
const routes = {}; // filled in by each page file: routes.products = renderProducts, ...

function route() {
  if (!me) return;
  const [name, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const view = routes[name] ? name : 'dashboard';
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === view));
  routes[view](new URLSearchParams(query)).catch((err) => toast(err.message, true));
}
window.addEventListener('hashchange', route);
