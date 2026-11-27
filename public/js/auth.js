'use strict';
// Sign in, create account, sign out, change password, and the alerts bell.

function showLogin() {
  me = null;
  clearInterval(alertTimer);
  $('#modal').open && $('#modal').close();
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}

async function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#whoami').textContent = `${me.username} · ${me.role}`;
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', me.role !== 'admin'));
  try { settings = await api('GET', '/api/settings'); } catch { /* keep defaults */ }
  await loadLocations();
  $$('.company-name').forEach((el) => { el.textContent = settings.company_name; });
  document.title = settings.company_name;
  refreshAlerts();
  clearInterval(alertTimer);
  alertTimer = setInterval(refreshAlerts, 60 * 1000);
  route();
}

$('#login-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    me = await api('POST', '/api/login', f);
    e.target.reset();
    $('#login-error').textContent = '';
    $('#login-notice').classList.add('hidden');
    showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
};

$('#logout-btn').onclick = async () => { await api('POST', '/api/logout'); showLogin(); };

$('#pw-btn').onclick = () => openModal('Change password', `
  <div class="form-grid">
    <label class="full">Current password <input type="password" name="current" autocomplete="current-password" required></label>
    <label class="full">New password <input type="password" name="next" minlength="6" autocomplete="new-password" required></label>
  </div>`, async (f) => { await api('POST', '/api/me/password', f); toast('Password changed'); });

// ---------- alerts bell ----------
let alertTimer;
let lastAlerts = null;

async function refreshAlerts() {
  try {
    lastAlerts = await api('GET', '/api/alerts');
  } catch { return; }
  const n = lastAlerts.count;
  $('#alerts-count').textContent = n;
  $('#alerts-count').classList.toggle('hidden', !n);
  $('#alerts-btn').setAttribute('aria-label', `${n} alert${n === 1 ? '' : 's'}`);
  const pending = lastAlerts.pendingUsers.length;
  const link = $('nav a[data-route="admin"]');
  link.innerHTML = `Admin${pending ? `<span class="nav-count" title="${pending} waiting for approval">${pending}</span>` : ''}`;
}

$('#alerts-btn').onclick = async () => {
  await refreshAlerts();
  const a = lastAlerts || { lowStock: [], overduePOs: [], pendingUsers: [], overdueInvoices: [] };
  const section = (title, items, render) => (items.length ? `<h3>${title} <span class="badge low">${items.length}</span></h3>
      <ul class="alert-list">${items.map(render).join('')}</ul>` : '');
  const body = a.count === 0 ? '<p class="muted">Nothing needs attention. 🎉</p>' : `
    ${section('Low stock', a.lowStock, (p) => `<li><b>${esc(p.name)}</b> <span class="muted">${esc(p.sku)}</span><br>
        ${num(p.quantity)} ${esc(p.unit)} left · reorder at ${num(p.reorder_level)}
        <button type="button" class="btn link" data-restock="${p.id}">Restock</button></li>`)}
    ${section('Overdue purchase orders', a.overduePOs, (o) => `<li><a href="#/orders?id=${o.id}" data-go>${esc(o.number)}</a> from ${esc(o.supplier)}
        <br><span class="neg">expected ${fmtDay(o.expected_date)}</span></li>`)}
    ${section('Overdue invoices', a.overdueInvoices || [], (i) => `<li><a href="#/sales?id=${i.id}" data-go>${esc(i.number)}</a> — ${esc(i.customer_name)}
        <br><span class="neg">${money(i.balance)} due ${fmtDay(i.due_date)}</span></li>`)}
    ${section('Accounts waiting for approval', a.pendingUsers, (u) => `<li><a href="#/admin" data-go>${esc(u.username)}</a>
        <span class="muted">signed up ${fmtDate(u.created_at)}</span></li>`)}`;
  const form = openModal('Alerts', body, null, null);
  $$('[data-go]', form).forEach((l) => l.addEventListener('click', () => $('#modal').close()));
  $$('[data-restock]', form).forEach((b) => {
    b.onclick = () => { $('#modal').close(); movementDialog('IN', Number(b.dataset.restock)); };
  });
};
