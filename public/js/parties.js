'use strict';
// Suppliers & customers page.

routes.contacts = async function renderContacts(params) {
  const type = params.get('type') === 'customer' ? 'customer' : 'supplier';
  const q = params.get('q') || '';
  const list = await api('GET', `/api/parties?type=${type}&q=${encodeURIComponent(q)}`);
  const label = type === 'supplier' ? 'supplier' : 'customer / department';

  $('#main').innerHTML = `
    <div class="page-head"><h1>Suppliers &amp; customers</h1>
      <div class="actions"><button class="btn primary" id="add-party">+ New ${label}</button></div></div>
    <div class="filters">
      <div class="seg" role="tablist">
        <a href="#/contacts?type=supplier" class="${type === 'supplier' ? 'active' : ''}">Suppliers</a>
        <a href="#/contacts?type=customer" class="${type === 'customer' ? 'active' : ''}">Customers / departments</a>
      </div>
      <label>Search <input id="c-search" value="${esc(q)}" placeholder="Name, contact, phone, email"></label>
    </div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Name</th><th>Contact</th><th>Phone</th><th>Email</th>
        <th class="num">Movements</th><th class="num">Units ${type === 'supplier' ? 'received' : 'issued'}</th>
        <th class="num">Value</th><th>Last movement</th><th></th></tr></thead>
      <tbody>${list.length ? list.map((p) => `<tr>
          <td><b>${esc(p.name)}</b>${p.notes ? `<br><span class="muted">${esc(p.notes)}</span>` : ''}</td>
          <td>${esc(p.contact)}</td><td>${esc(p.phone)}</td>
          <td>${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : ''}</td>
          <td class="num">${num(p.movements)}</td><td class="num">${num(p.units)}</td><td class="num">${money(p.value)}</td>
          <td>${fmtDate(p.last_movement)}</td>
          <td>
            <a class="btn link" href="#/movements?party_id=${p.id}">History</a>
            ${type === 'supplier' ? `<a class="btn link" href="#/orders?supplier_id=${p.id}">Orders</a>` : ''}
            <button class="btn link" data-edit="${p.id}">Edit</button>
            ${me.role === 'admin' ? `<button class="btn link" data-merge="${p.id}">Merge</button>
              <button class="btn link danger" data-del="${p.id}">Delete</button>` : ''}
          </td></tr>`).join('') : `<tr><td colspan="9" class="empty">No ${label}s yet. They are also added automatically when you type a new name on a stock movement.</td></tr>`}
      </tbody></table></div>`;

  let t;
  $('#c-search').oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(() => setQuery({ type, q: e.target.value }), 300);
  };
  if (q) { const s = $('#c-search'); s.focus(); s.setSelectionRange(q.length, q.length); }

  const find = (id) => list.find((p) => p.id === Number(id));
  $('#add-party').onclick = () => partyDialog(type);
  $$('[data-edit]').forEach((b) => { b.onclick = () => partyDialog(type, find(b.dataset.edit)); });
  $$('[data-merge]').forEach((b) => {
    b.onclick = () => {
      const from = find(b.dataset.merge);
      const others = list.filter((p) => p.id !== from.id);
      if (!others.length) return toast(`There is no other ${label} to merge into`, true);
      openModal(`Merge "${from.name}"`, `
        <p>Use this to fix duplicates (for example "CleanPro" and "Clean Pro"). All movements and orders of
          <b>${esc(from.name)}</b> move to the one you pick, and <b>${esc(from.name)}</b> is removed.</p>
        <label>Merge into <select name="into" required>${others.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>`,
      async (f) => { await api('POST', `/api/parties/${from.id}/merge`, f); toast('Merged'); route(); }, 'Merge');
    };
  });
  $$('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const p = find(b.dataset.del);
      if (!confirm(`Delete "${p.name}"? If it has history it is hidden instead, and its history is kept.`)) return;
      try { const r = await api('DELETE', `/api/parties/${p.id}`); toast(r.archived ? 'Hidden (history kept)' : 'Deleted'); route(); }
      catch (err) { toast(err.message, true); }
    };
  });
};

function partyDialog(type, p) {
  const v = (k) => esc(p ? p[k] : '');
  openModal(p ? `Edit ${p.name}` : `New ${type === 'supplier' ? 'supplier' : 'customer / department'}`, `
    <div class="form-grid">
      <label class="full">Name <input name="name" value="${v('name')}" required></label>
      <label>Contact person <input name="contact" value="${v('contact')}"></label>
      <label>Phone <input name="phone" type="tel" value="${v('phone')}"></label>
      <label class="full">Email <input name="email" type="email" value="${v('email')}"></label>
      <label class="full">Notes <textarea name="notes" rows="2">${v('notes')}</textarea></label>
    </div>
    ${p ? '<p class="muted">Renaming also updates the name on past movements.</p>' : ''}`,
  async (f) => {
    await api(p ? 'PUT' : 'POST', p ? `/api/parties/${p.id}` : '/api/parties', { ...f, type });
    toast(p ? 'Saved' : 'Added');
    route();
  });
}
