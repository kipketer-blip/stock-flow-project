'use strict';
// Admin page: sign-up approvals, users, settings, activity log, backups.

const ACTION_LABELS = {
  'user.signup': 'Sign-up request', 'user.approve': 'Approved account', 'user.reject': 'Rejected sign-up',
  'user.create': 'Created user', 'user.delete': 'Deleted user', 'user.role': 'Changed role', 'user.password': 'Password',
  'product.create': 'Added product', 'product.update': 'Edited product', 'product.delete': 'Deleted product',
  'product.archive': 'Archived product', 'product.import': 'Imported products',
  'party.create': 'Added contact', 'party.update': 'Edited contact', 'party.merge': 'Merged contacts',
  'party.delete': 'Deleted contact', 'party.archive': 'Hid contact',
  'po.create': 'Created PO', 'po.receive': 'Received PO', 'po.cancel': 'Cancelled PO',
  'settings.update': 'Settings', 'backup.create': 'Backup', 'settings.email': 'Email alerts',
  'location.create': 'Added location', 'location.update': 'Edited location', 'stock.transfer': 'Transfer',
  'sale.create': 'Sale', 'sale.payment': 'Payment', 'sale.void': 'Voided sale',
};

routes.admin = async function renderAdmin(params) {
  if (me.role !== 'admin') { location.hash = '#/dashboard'; return; }
  const logQ = params.get('log_q') || '';
  const logPage = params.get('log_page') || 1;
  const [allUsers, bk, currencies, log] = await Promise.all([
    api('GET', '/api/users'), api('GET', '/api/backups'), api('GET', '/api/currencies'),
    api('GET', `/api/activity?page=${logPage}&q=${encodeURIComponent(logQ)}`),
  ]);
  const pending = allUsers.filter((u) => u.status === 'pending');
  const users = allUsers.filter((u) => u.status !== 'pending');
  const iAmOwner = allUsers.some((u) => u.is_owner && u.id === me.id);
  const size = (b) => (b < 1024 * 1024 ? `${Math.ceil(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
  const currencyName = (c) => { try { return new Intl.DisplayNames(undefined, { type: 'currency' }).of(c); } catch { return c; } };

  $('#main').innerHTML = `
    <div class="page-head"><h1>Admin</h1></div>
    ${pending.length ? `<div class="card section">
      <h2>Old sign-up requests <span class="badge pending">${pending.length}</span></h2>
      <p class="muted" style="margin-top:0">Sign-up from the login page is turned off. These requests were made before; approve or reject them.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Username</th><th>Signed up</th><th></th></tr></thead>
        <tbody>${pending.map((u) => `<tr><td>${esc(u.username)}</td><td>${fmtDate(u.created_at)}</td>
          <td><button class="btn in small" data-approve="${u.id}">Approve</button>
              <button class="btn link danger" data-reject="${u.id}" data-name="${esc(u.username)}">Reject</button></td></tr>`).join('')}
        </tbody></table></div>
      <p class="muted" style="margin-bottom:0">Approved accounts get staff access. You can make them admins afterwards.</p>
    </div>` : ''}

    <div class="card section">
      <div class="page-head" style="margin-bottom:6px"><h2 style="margin:0">Users <span class="muted small-note">(${users.length})</span></h2>
        <button class="btn primary small" id="add-user">+ New user</button></div>
      <div class="table-wrap"><table class="users-table">
        <thead><tr><th>Username</th><th>Role</th><th>Created</th><th class="num">Actions</th></tr></thead>
        <tbody>${users.map((u) => {
          const locked = u.id === me.id || u.is_owner || (u.role === 'admin' && !iAmOwner);
          const why = u.is_owner ? 'The main admin cannot be deleted' : u.id === me.id ? 'This is your own account'
            : 'Only the main admin can delete other admins';
          return `<tr><td><b>${esc(u.username)}</b>${u.is_owner ? ' <span class="badge ok">Main admin</span>' : ''}${u.id === me.id ? ' <span class="muted">(you)</span>' : ''}</td>
          <td>${locked || !iAmOwner ? esc(u.role) : `<select data-role="${u.id}" aria-label="Role for ${esc(u.username)}">
              <option value="staff" ${u.role === 'staff' ? 'selected' : ''}>staff</option>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option></select>`}</td>
          <td>${fmtDate(u.created_at)}</td>
          <td class="num user-actions">${locked ? `<span class="muted small-note">${why}</span>`
            : `<button class="btn small" data-reset="${u.id}" data-name="${esc(u.username)}">Reset password</button>
               <button class="btn small danger-outline" data-del-user="${u.id}" data-name="${esc(u.username)}">🗑 Delete user</button>`}</td></tr>`;
        }).join('')}
        </tbody></table></div>
      <p class="muted" style="margin-bottom:0">Only admins create accounts — new users can sign in straight away with the username and password you give them.
        Deleting a user signs them out at once; the stock movements, sales and orders they recorded stay on record.
        Staff can record stock and sales, and manage products, contacts and purchase orders. Admins can also adjust stock, void sales,
        delete things, manage users, change settings and download backups. The main admin can't be deleted or demoted.</p>
    </div>

    <div class="section">
      <form class="card" id="settings-form">
        <h2>Settings</h2>
        <div class="form-grid">
          <label class="full">Company name <span class="muted small-note">(shown on labels, reports and printed orders)</span>
            <input name="company_name" value="${esc(settings.company_name)}" required maxlength="80"></label>
          <label class="full">Currency <select name="currency">${currencies.map((c) =>
            `<option value="${c}" ${c === settings.currency ? 'selected' : ''}>${c} — ${esc(currencyName(c))}</option>`).join('')}</select></label>
        </div>
        <p class="muted">Changing the currency only changes how amounts are shown. It does not convert existing costs.</p>
        <button class="btn primary">Save settings</button>
      </form>
    </div>

    <div id="admin-extras"></div>

    <div class="card section">
      <div class="page-head" style="margin-bottom:6px"><h2 style="margin:0">Activity log</h2>
        <form id="log-search" class="inline-form"><input name="log_q" value="${esc(logQ)}" placeholder="Search user, action, details" aria-label="Search activity">
          <button class="btn small">Search</button></form></div>
      <p class="muted" style="margin-top:0">Changes to products, contacts, orders, users and settings. Stock movements have their own log on the Movements page.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
        <tbody>${log.rows.length ? log.rows.map((a) => `<tr><td>${fmtDate(a.created_at)}</td><td>${esc(a.username || '—')}</td>
          <td>${esc(ACTION_LABELS[a.action] || a.action)}</td><td class="wrap">${esc(a.details)}</td></tr>`).join('')
          : '<tr><td colspan="4" class="empty">No activity yet</td></tr>'}</tbody></table></div>
      <div class="pager-row">${pager(log.page, log.pages, log.total, 'entries')}</div>
    </div>

    <div class="card section">
      <div class="page-head" style="margin-bottom:6px"><h2 style="margin:0">Backups</h2>
        <button class="btn small" id="backup-now">Back up now</button></div>
      <p class="muted" style="margin-top:0">A backup is made automatically once a day. The newest ${bk.keep} are kept in <code>${esc(bk.dir)}</code>.
        For safety, also download one now and then and keep it on another drive.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>File</th><th>Made</th><th class="num">Size</th><th></th></tr></thead>
        <tbody>${bk.files.length ? bk.files.map((b) => `<tr><td>${esc(b.name)}</td>
            <td>${new Date(b.created).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
            <td class="num">${size(b.size)}</td>
            <td><a class="btn link" href="/api/backups/${encodeURIComponent(b.name)}">Download</a></td></tr>`).join('')
          : '<tr><td colspan="4" class="empty">No backups yet</td></tr>'}</tbody>
      </table></div>
    </div>`;

  const act = (fn, msg) => async () => {
    try { await fn(); if (msg) toast(msg); refreshAlerts(); route(); } catch (err) { toast(err.message, true); route(); }
  };

  $$('[data-approve]').forEach((b) => { b.onclick = act(() => api('POST', `/api/users/${b.dataset.approve}/approve`), 'Account approved'); });
  $$('[data-reject]').forEach((b) => {
    b.onclick = () => confirm(`Reject and delete the account "${b.dataset.name}"?`) &&
      act(() => api('DELETE', `/api/users/${b.dataset.reject}`), 'Sign-up rejected')();
  });
  $$('[data-del-user]').forEach((b) => {
    b.onclick = () => openModal(`Delete user "${b.dataset.name}"?`, `
      <p>This permanently removes the account <b>${esc(b.dataset.name)}</b>. They are signed out at once and can no longer log in.</p>
      <p class="muted">Their stock movements, sales, payments and purchase orders stay on record (shown without a user name). This cannot be undone.</p>
      <label>Type <b>${esc(b.dataset.name)}</b> to confirm <input name="confirm_name" autocomplete="off" required></label>`,
    async (f) => {
      if (f.confirm_name.trim() !== b.dataset.name) throw new Error('The name does not match');
      await api('DELETE', `/api/users/${b.dataset.delUser}`);
      toast(`User ${b.dataset.name} deleted`);
      refreshAlerts();
      route();
    }, 'Delete user', 'out');
  });
  $$('[data-role]').forEach((sel) => {
    sel.onchange = act(() => api('PUT', `/api/users/${sel.dataset.role}/role`, { role: sel.value }), 'Role updated');
  });
  $$('[data-reset]').forEach((b) => {
    b.onclick = () => openModal(`Reset password for ${b.dataset.name}`, `
      <div class="form-grid">
        <label class="full">New password <input type="password" name="password" minlength="6" autocomplete="new-password" required></label>
      </div>
      <p class="muted">They will be signed out and must use the new password.</p>`,
    async (f) => { await api('POST', `/api/users/${b.dataset.reset}/password`, f); toast('Password reset'); }, 'Reset password');
  });
  $('#add-user').onclick = () => openModal('New user', `
    <div class="form-grid">
      <label>Username <input name="username" required></label>
      <label>Role <select name="role"><option value="staff">Staff</option>${iAmOwner ? '<option value="admin">Admin</option>' : ''}</select></label>
      <label class="full">Password <input type="password" name="password" minlength="6" autocomplete="new-password" required></label>
    </div>`, async (f) => { await api('POST', '/api/users', f); toast('User created'); route(); });

  $('#settings-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/settings', Object.fromEntries(new FormData(e.target)));
      settings = await api('GET', '/api/settings');
      $$('.company-name').forEach((el) => { el.textContent = settings.company_name; });
      document.title = settings.company_name;
      toast('Settings saved');
      route();
    } catch (err) { toast(err.message, true); }
  };

  $('#log-search').onsubmit = (e) => { e.preventDefault(); setQuery({ log_q: e.target.log_q.value }); };
  bindPager($('#main'), (page) => setQuery({ log_q: logQ, log_page: page }));

  $('#backup-now').onclick = async (e) => {
    e.target.disabled = true;
    try { await api('POST', '/api/backups'); toast('Backup saved'); route(); }
    catch (err) { toast(err.message, true); e.target.disabled = false; }
  };

  await renderAdminExtras();
};

// Locations, invoice & tax settings, and email alerts (added in version 4).
async function renderAdminExtras() {
  const [allLocations, email] = await Promise.all([api('GET', '/api/locations?all=1'), api('GET', '/api/email-settings')]);
  const box = $('#admin-extras');
  if (!box) return;
  const hours = Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${String(h) === email.alert_digest_hour ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');

  box.innerHTML = `
    <div class="card section">
      <div class="page-head" style="margin-bottom:6px"><h2 style="margin:0">Locations</h2>
        <button class="btn primary small" id="add-location">+ Add location</button></div>
      <p class="muted" style="margin-top:0">Shops, stores or warehouses where you keep stock. Each stock movement and sale happens at one location.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Address</th><th class="num">Products</th><th class="num">Units</th><th class="num">Value</th><th>Status</th><th></th></tr></thead>
        <tbody>${allLocations.map((l) => `<tr>
          <td><b>${esc(l.name)}</b>${l.is_default ? ' <span class="badge ok">Main</span>' : ''}</td><td>${esc(l.address)}</td>
          <td class="num">${num(l.products)}</td><td class="num">${num(l.units)}</td><td class="num">${money(l.value)}</td>
          <td>${l.active ? 'Open' : '<span class="muted">Closed</span>'}</td>
          <td><button class="btn link" data-edit-loc="${l.id}">Edit</button>
            ${!l.is_default && l.active ? `<button class="btn link" data-default-loc="${l.id}">Make main</button>` : ''}
            ${!l.is_default ? `<button class="btn link ${l.active ? 'danger' : ''}" data-toggle-loc="${l.id}">${l.active ? 'Close' : 'Reopen'}</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>
    </div>

    <div class="grid-2">
      <form class="card" id="invoice-form">
        <h2>Invoices &amp; tax</h2>
        <div class="form-grid">
          <label class="full">Business address <input name="company_address" value="${esc(settings.company_address)}" maxlength="200"></label>
          <label>Phone <input name="company_phone" value="${esc(settings.company_phone)}" maxlength="40"></label>
          <label>Email <input name="company_email" type="email" value="${esc(settings.company_email)}" maxlength="120"></label>
          <label>KRA PIN / tax number <input name="company_pin" value="${esc(settings.company_pin)}" maxlength="20"></label>
          <label>Invoice prefix <input name="invoice_prefix" value="${esc(settings.invoice_prefix)}" maxlength="8" pattern="[A-Za-z0-9]{1,8}"></label>
          <label>VAT rate (%) <input name="vat_rate" type="number" min="0" max="50" step="0.01" value="${settings.vat_rate}"></label>
          <label>Prices <select name="vat_inclusive"><option value="1" ${settings.vat_inclusive ? 'selected' : ''}>include VAT</option>
            <option value="0" ${settings.vat_inclusive ? '' : 'selected'}>exclude VAT (added on top)</option></select></label>
          <label class="full">Invoice footer <input name="invoice_footer" value="${esc(settings.invoice_footer)}" maxlength="300"></label>
        </div>
        <p class="muted small-note">Kenya's standard VAT rate is 16%. Set 0 if you are not VAT-registered. Changes apply to new invoices only.</p>
        <button class="btn primary">Save invoice settings</button>
      </form>

      <form class="card" id="email-form" autocomplete="off">
        <h2>Email alerts ${email.configured ? '<span class="badge ok">On</span>' : '<span class="badge low">Not set up</span>'}</h2>
        <p class="muted" style="margin-top:0">Get an email when items drop to their reorder level, and an optional daily summary.</p>
        <div class="form-grid">
          <label>Mail server (SMTP) <input name="smtp_host" value="${esc(email.smtp_host)}" placeholder="smtp.gmail.com"></label>
          <label>Port <input name="smtp_port" type="number" value="${esc(email.smtp_port)}"></label>
          <label>Security <select name="smtp_security">
            ${[['starttls', 'STARTTLS (port 587)'], ['ssl', 'SSL/TLS (port 465)'], ['none', 'None (local servers only)']]
              .map(([v, l]) => `<option value="${v}" ${email.smtp_security === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Username <input name="smtp_user" value="${esc(email.smtp_user)}" autocomplete="off"></label>
          <label>Password <input name="smtp_pass" type="password" autocomplete="new-password"
            placeholder="${email.smtp_pass_set ? 'Saved — leave empty to keep' : 'App password'}"></label>
          <label>From <input name="smtp_from" value="${esc(email.smtp_from)}" placeholder="Shop Alerts &lt;alerts@yourshop.co.ke&gt;"></label>
          <label class="full">Send alerts to <input name="alert_to" value="${esc(email.alert_to)}" placeholder="owner@yourshop.co.ke, manager@yourshop.co.ke"></label>
          <label class="check full"><input type="checkbox" name="alert_low_stock" ${email.alert_low_stock === '1' ? 'checked' : ''}> Email me when an item reaches its reorder level (at most once a day per item)</label>
          <label class="check"><input type="checkbox" name="alert_digest" ${email.alert_digest === '1' ? 'checked' : ''}> Daily summary at</label>
          <label><select name="alert_digest_hour" aria-label="Summary time">${hours}</select></label>
        </div>
        <p class="muted small-note">Gmail: turn on 2-step verification, create an <i>App password</i> and use smtp.gmail.com, port 587, STARTTLS.
          The password is stored in this app's database on this computer.</p>
        <div class="actions" style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary">Save email settings</button>
          <button type="button" class="btn" id="email-test" ${email.configured ? '' : 'disabled'}>Send test email</button>
          <button type="button" class="btn" id="email-summary" ${email.configured ? '' : 'disabled'}>Send summary now</button>
        </div>
        ${email.log.length ? `<h3>Recent emails</h3><div class="table-wrap"><table>
          <thead><tr><th>When</th><th>Type</th><th>Subject</th><th>Result</th></tr></thead>
          <tbody>${email.log.slice(0, 8).map((m) => `<tr><td>${fmtDate(m.created_at)}</td><td>${esc(m.kind.replace('_', ' '))}</td>
            <td class="wrap">${esc(m.subject)}</td><td class="wrap">${m.status === 'sent' ? '<span class="pos">Sent</span>' : `<span class="neg">Failed</span> <span class="muted small-note">${esc(m.error)}</span>`}</td></tr>`).join('')}</tbody>
        </table></div>` : ''}
      </form>
    </div>`;

  const locDialog = (l) => openModal(l ? `Edit ${l.name}` : 'Add location', `
    <div class="form-grid">
      <label class="full">Name <input name="name" value="${esc(l?.name || '')}" required maxlength="60" placeholder="e.g. Westlands Shop"></label>
      <label class="full">Address <input name="address" value="${esc(l?.address || '')}" maxlength="200"></label>
    </div>`, async (f) => {
    await api(l ? 'PUT' : 'POST', l ? `/api/locations/${l.id}` : '/api/locations', f);
    toast(l ? 'Location saved' : 'Location added');
    await loadLocations();
    route();
  });
  const updateLoc = async (id, body, msg) => {
    try { await api('PUT', `/api/locations/${id}`, body); toast(msg); await loadLocations(); route(); } catch (err) { toast(err.message, true); }
  };

  $('#add-location').onclick = () => locDialog(null);
  $$('[data-edit-loc]', box).forEach((b) => { b.onclick = () => locDialog(allLocations.find((l) => l.id === Number(b.dataset.editLoc))); });
  $$('[data-default-loc]', box).forEach((b) => { b.onclick = () => updateLoc(b.dataset.defaultLoc, { is_default: true }, 'Main location changed'); });
  $$('[data-toggle-loc]', box).forEach((b) => {
    const l = allLocations.find((x) => x.id === Number(b.dataset.toggleLoc));
    b.onclick = () => (l.active ? confirm(`Close ${l.name}? It must have no stock left.`) : true) &&
      updateLoc(l.id, { active: !l.active }, l.active ? 'Location closed' : 'Location reopened');
  });

  $('#invoice-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      await api('PUT', '/api/settings', { ...f, vat_inclusive: f.vat_inclusive === '1' });
      settings = await api('GET', '/api/settings');
      toast('Invoice settings saved');
    } catch (err) { toast(err.message, true); }
  };

  const emailForm = $('#email-form');
  emailForm.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(emailForm));
    try {
      await api('PUT', '/api/email-settings', { ...f, alert_low_stock: Boolean(f.alert_low_stock), alert_digest: Boolean(f.alert_digest) });
      toast('Email settings saved');
      route();
    } catch (err) { toast(err.message, true); }
  };
  const run = (btnId, url, busyText) => {
    const b = $(btnId);
    b.onclick = async () => {
      const label = b.textContent;
      b.disabled = true;
      b.textContent = busyText;
      try { const r = await api('POST', url, {}); toast(r.message); } catch (err) { toast(err.message, true); }
      b.disabled = false;
      b.textContent = label;
      route();
    };
  };
  run('#email-test', '/api/email-settings/test', 'Sending…');
  run('#email-summary', '/api/email-settings/summary', 'Sending…');
}
