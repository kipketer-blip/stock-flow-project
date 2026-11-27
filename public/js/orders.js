'use strict';
// Purchase orders: list, create, view, receive (full or partial), cancel, print.

const PO_STATUS = { open: 'Open', partial: 'Partly received', received: 'Received', cancelled: 'Cancelled' };
const poBadge = (s) => `<span class="badge po-${s}">${PO_STATUS[s]}</span>`;

routes.orders = async function renderOrders(params) {
  if (params.get('id')) return renderOrder(Number(params.get('id')));
  const status = params.get('status') || '';
  const supplierId = params.get('supplier_id') || '';
  const qs = new URLSearchParams(Object.entries({ status, supplier_id: supplierId }).filter(([, v]) => v)).toString();
  const orders = await api('GET', `/api/purchase-orders?${qs}`);
  const today = localDay();

  $('#main').innerHTML = `
    <div class="page-head"><h1>Purchase orders</h1>
      <div class="actions"><button class="btn primary" id="new-po">+ New purchase order</button></div></div>
    <div class="filters">
      <div class="seg">
        ${[['', 'All'], ['active', 'Open'], ['received', 'Received'], ['cancelled', 'Cancelled']].map(([v, l]) =>
          `<a href="#/orders${v ? `?status=${v}` : ''}" class="${status === v ? 'active' : ''}">${l}</a>`).join('')}
      </div>
      ${supplierId && orders[0] ? `<span class="muted">Supplier: <b>${esc(orders[0].supplier)}</b> · <a href="#/orders">show all</a></span>` : ''}
    </div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Number</th><th>Supplier</th><th>Status</th><th>Ordered</th><th>Expected</th>
        <th class="num">Lines</th><th class="num">Received</th><th class="num">Total</th></tr></thead>
      <tbody>${orders.length ? orders.map((o) => {
        const overdue = ['open', 'partial'].includes(o.status) && o.expected_date && o.expected_date < today;
        return `<tr class="clickable" data-open="${o.id}">
          <td><a href="#/orders?id=${o.id}"><b>${esc(o.number)}</b></a></td><td>${esc(o.supplier)}</td><td>${poBadge(o.status)}</td>
          <td>${fmtDate(o.created_at)}</td>
          <td class="${overdue ? 'neg' : ''}">${fmtDay(o.expected_date)}${overdue ? ' · overdue' : ''}</td>
          <td class="num">${o.lines}</td><td class="num">${num(o.qty_received)} / ${num(o.qty_ordered)}</td>
          <td class="num">${money(o.total)}</td></tr>`;
      }).join('') : '<tr><td colspan="8" class="empty">No purchase orders</td></tr>'}</tbody>
    </table></div>`;

  $('#new-po').onclick = () => newOrderDialog();
  $$('[data-open]').forEach((r) => { r.onclick = (e) => { if (!e.target.closest('a')) location.hash = `#/orders?id=${r.dataset.open}`; }; });
};

async function newOrderDialog() {
  const [products, suppliers] = await Promise.all([api('GET', '/api/products'), api('GET', '/api/parties?type=supplier')]);
  if (!products.length) return toast('Add a product first', true);
  const productOptions = `<option value="">Choose product…</option>` + products.map((p) =>
    `<option value="${p.id}" data-cost="${p.unit_cost}">${esc(p.sku)} — ${esc(p.name)} (${num(p.quantity)} ${esc(p.unit)} on hand)</option>`).join('');
  const lineHtml = () => `<tr class="po-line">
      <td><select class="po-product" required>${productOptions}</select></td>
      <td><input type="number" class="po-qty" min="1" step="1" required style="width:90px"></td>
      <td><input type="number" class="po-cost" min="0" step="0.01" required style="width:110px"></td>
      <td class="num po-subtotal">—</td>
      <td><button type="button" class="btn link danger po-remove" aria-label="Remove line">✕</button></td></tr>`;
  // Suggest low-stock items first: reorder up to twice the reorder level.
  const low = products.filter((p) => p.quantity <= p.reorder_level);

  const form = openModal('New purchase order', `
    <div class="form-grid">
      <label>Supplier <input name="supplier" list="supplier-options" required autocomplete="off" placeholder="Pick or type a new supplier"></label>
      <label>Expected delivery <input type="date" name="expected_date" min="${localDay()}"></label>
      ${locations.length > 1 ? `<label>Deliver to <select name="location_id">${locationOptions(preferredLocationId())}</select></label>` : ''}
      <datalist id="supplier-options">${suppliers.map((s) => `<option value="${esc(s.name)}">`).join('')}</datalist>
    </div>
    <div class="table-wrap" style="margin-top:12px"><table class="po-lines">
      <thead><tr><th>Product</th><th>Qty</th><th>Unit cost</th><th class="num">Subtotal</th><th></th></tr></thead>
      <tbody>${lineHtml()}</tbody>
      <tfoot><tr><td colspan="3">
          <button type="button" class="btn small" id="add-line">+ Add line</button>
          ${low.length ? `<button type="button" class="btn small" id="add-low">+ Add low-stock items (${low.length})</button>` : ''}
        </td><td class="num"><b id="po-total">—</b></td><td></td></tr></tfoot>
    </table></div>
    <label style="margin-top:12px">Note <textarea name="note" rows="2"></textarea></label>`, async (f, el) => {
    const items = $$('.po-line', el).map((tr) => ({
      product_id: $('.po-product', tr).value, qty: $('.po-qty', tr).value, unit_cost: $('.po-cost', tr).value,
    })).filter((i) => i.product_id);
    const po = await api('POST', '/api/purchase-orders', { ...f, items });
    toast(`${po.number} created`);
    refreshAlerts();
    location.hash = `#/orders?id=${po.id}`;
  }, 'Create order', 'primary', { wide: true });

  const tbody = $('.po-lines tbody', form);
  const recalc = () => {
    let total = 0;
    $$('.po-line', form).forEach((tr) => {
      const sub = (Number($('.po-qty', tr).value) || 0) * (Number($('.po-cost', tr).value) || 0);
      total += sub;
      $('.po-subtotal', tr).textContent = sub ? money(sub) : '—';
    });
    $('#po-total', form).textContent = money(total);
  };
  const bindLine = (tr) => {
    $('.po-product', tr).onchange = (e) => {
      const opt = e.target.selectedOptions[0];
      if (opt?.dataset.cost && !$('.po-cost', tr).value) $('.po-cost', tr).value = opt.dataset.cost;
      recalc();
    };
    $('.po-qty', tr).oninput = recalc;
    $('.po-cost', tr).oninput = recalc;
    $('.po-remove', tr).onclick = () => { if ($$('.po-line', form).length > 1) tr.remove(); recalc(); };
  };
  const addLine = (p, qty) => {
    let tr = $$('.po-line', form).find((x) => !$('.po-product', x).value);
    if (!tr) { tbody.insertAdjacentHTML('beforeend', lineHtml()); tr = tbody.lastElementChild; bindLine(tr); }
    if (p) {
      $('.po-product', tr).value = p.id;
      $('.po-qty', tr).value = qty;
      $('.po-cost', tr).value = p.unit_cost;
    }
    return tr;
  };
  bindLine($('.po-line', form));
  $('#add-line', form).onclick = () => $('.po-product', addLine()).focus();
  const addLow = $('#add-low', form);
  if (addLow) {
    addLow.onclick = () => {
      const chosen = $$('.po-product', form).map((s) => Number(s.value));
      low.filter((p) => !chosen.includes(p.id))
        .forEach((p) => addLine(p, Math.max(1, p.reorder_level * 2 - p.quantity)));
      recalc();
    };
  }
}

async function renderOrder(id) {
  const po = await api('GET', `/api/purchase-orders/${id}`);
  const canReceive = ['open', 'partial'].includes(po.status);
  const overdue = canReceive && po.expected_date && po.expected_date < localDay();

  $('#main').innerHTML = `
    <div class="page-head"><h1><a href="#/orders" class="muted no-print">Purchase orders ›</a> ${esc(po.number)} ${poBadge(po.status)}</h1>
      <div class="actions">
        <button class="btn" onclick="window.print()">Print</button>
        ${canReceive ? '<button class="btn danger-outline" id="cancel-po">Cancel order</button>' : ''}
      </div></div>
    <div class="card po-head">
      <div class="print-only"><h2>${esc(settings.company_name)} — Purchase order ${esc(po.number)}</h2></div>
      <div class="kv"><span>Supplier</span><b><a href="#/contacts?type=supplier&q=${encodeURIComponent(po.supplier)}">${esc(po.supplier)}</a></b></div>
      <div class="kv"><span>Ordered</span><b>${fmtDate(po.created_at)}${po.created_by_name ? ` by ${esc(po.created_by_name)}` : ''}</b></div>
      <div class="kv"><span>Expected</span><b class="${overdue ? 'neg' : ''}">${fmtDay(po.expected_date)}${overdue ? ' (overdue)' : ''}</b></div>
      ${locations.length > 1 ? `<div class="kv"><span>Deliver to</span><b>${esc(po.location_name || '—')}</b></div>` : ''}
      <div class="kv"><span>Total</span><b>${money(po.total)}</b></div>
      ${po.note ? `<div class="kv full"><span>Note</span><b>${esc(po.note)}</b></div>` : ''}
    </div>
    <form id="receive-form" class="card table-wrap" style="margin-top:14px">
      <table>
        <thead><tr><th>SKU</th><th>Product</th><th class="num">Ordered</th><th class="num">Received</th>
          <th class="num">Outstanding</th><th class="num">Unit cost</th><th class="num">Subtotal</th>
          ${canReceive ? '<th class="num no-print">Arrived now</th>' : ''}</tr></thead>
        <tbody>${po.items.map((i) => {
          const left = i.qty_ordered - i.qty_received;
          return `<tr><td>${esc(i.sku)}</td><td>${esc(i.product_name)}</td>
            <td class="num">${num(i.qty_ordered)} ${esc(i.unit)}</td><td class="num">${num(i.qty_received)}</td>
            <td class="num ${left ? '' : 'muted'}">${num(left)}</td>
            <td class="num">${money(i.unit_cost)}</td><td class="num">${money(i.qty_ordered * i.unit_cost)}</td>
            ${canReceive ? `<td class="num no-print">${left ? `<input type="number" name="item_${i.id}" min="0" max="${left}" step="1" value="${left}" style="width:90px" aria-label="Arrived now: ${esc(i.product_name)}">` : '<span class="pos">✓</span>'}</td>` : ''}</tr>`;
        }).join('')}</tbody>
      </table>
      ${canReceive ? `<div class="receive-bar no-print">
          <label class="grow">Note <input name="note" placeholder="Delivery note no., condition…"></label>
          <button class="btn in" type="submit">Receive into stock</button>
        </div>
        <p class="muted no-print" style="margin-bottom:0">Change "Arrived now" for a partial delivery. Anything left stays on the order.</p>` : ''}
    </form>
    ${po.receipts.length ? `<div class="card" style="margin-top:14px"><h2>Deliveries received</h2>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Product</th><th class="num">Qty</th><th>By</th></tr></thead>
      <tbody>${po.receipts.map((r) => `<tr><td>${fmtDate(r.created_at)}</td><td>${esc(r.product_name)} <span class="muted">${esc(r.sku)}</span></td>
        <td class="num">${signed(r.quantity)}</td><td class="muted">${esc(r.username || '—')}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`;

  if (!canReceive) return;
  $('#receive-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const items = po.items.filter((i) => fd[`item_${i.id}`] !== undefined)
      .map((i) => ({ item_id: i.id, qty: Number(fd[`item_${i.id}`]) || 0 })).filter((i) => i.qty > 0);
    if (!items.length) return toast('Enter how many arrived for at least one line', true);
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const r = await api('POST', `/api/purchase-orders/${po.id}/receive`, { items, note: fd.note });
      toast(r.status === 'received' ? `${po.number} fully received` : `Delivery recorded, ${po.number} partly received`);
      refreshAlerts();
      route();
    } catch (err) { toast(err.message, true); btn.disabled = false; }
  };
  $('#cancel-po').onclick = async () => {
    const msg = po.status === 'partial'
      ? `Cancel ${po.number}? Stock already received stays in stock; the rest will not be expected any more.`
      : `Cancel ${po.number}?`;
    if (!confirm(msg)) return;
    try { await api('POST', `/api/purchase-orders/${po.id}/cancel`); toast('Order cancelled'); refreshAlerts(); route(); }
    catch (err) { toast(err.message, true); }
  };
}
