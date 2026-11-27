'use strict';
// Sales & invoices: list, new sale, invoice view/print, payments, void.

const SALE_STATUS = { unpaid: 'Unpaid', partial: 'Part paid', paid: 'Paid', void: 'Void' };
const PAY_METHODS = { cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', bank: 'Bank transfer', cheque: 'Cheque', other: 'Other' };
const saleBadge = (s) => `<span class="badge sale-${s}">${SALE_STATUS[s]}</span>`;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Same maths as the server (routes/sales.js computeTotals), used for the live preview.
function saleTotals(lines, discount) {
  const rate = Number(settings.vat_rate) || 0;
  const subtotal = round2(lines.reduce((s, l) => s + l.quantity * l.unit_price, 0));
  const disc = round2(Math.min(Math.max(Number(discount) || 0, 0), subtotal));
  const net = subtotal - disc;
  const vat = round2(settings.vat_inclusive ? (net * rate) / (100 + rate) : (net * rate) / 100);
  return { subtotal, discount: disc, vat, total: round2(settings.vat_inclusive ? net : net + vat) };
}

routes.sales = async function renderSales(params) {
  if (params.get('id')) return renderSale(Number(params.get('id')));
  const f = Object.fromEntries(['status', 'q', 'from', 'to', 'location_id', 'page'].map((k) => [k, params.get(k) || '']));
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const data = await api('GET', `/api/sales?${qs}`);

  $('#main').innerHTML = `
    <div class="page-head"><h1>Sales &amp; invoices</h1>
      <div class="actions"><button class="btn primary" id="new-sale">+ New sale</button></div></div>
    <form class="filters" id="s-filters">
      <div class="seg">${[['', 'All'], ['open', 'Unpaid'], ['paid', 'Paid'], ['void', 'Void']].map(([v, l]) =>
        `<a href="#/sales${v ? `?status=${v}` : ''}" class="${f.status === v ? 'active' : ''}">${l}</a>`).join('')}</div>
      <label>Search <input name="q" value="${esc(f.q)}" placeholder="Invoice no., customer, phone"></label>
      ${locations.length > 1 ? `<label>Location <select name="location_id">${locationOptions(f.location_id, { includeAll: true })}</select></label>` : ''}
      <label>From <input type="date" name="from" value="${esc(f.from)}"></label>
      <label>To <input type="date" name="to" value="${esc(f.to)}"></label>
      <button class="btn">Apply</button>
    </form>
    <p class="muted">${num(data.total_count)} invoice(s) · sales ${money(data.total_sales)} ·
      <span class="${data.outstanding > 0 ? 'neg' : ''}">unpaid ${money(data.outstanding)}</span></p>
    <div class="card table-wrap"><table>
      <thead><tr><th>Invoice</th><th>Date</th><th>Customer</th>${locations.length > 1 ? '<th>Location</th>' : ''}
        <th class="num">Items</th><th class="num">Total</th><th class="num">Balance</th><th>Status</th></tr></thead>
      <tbody>${data.rows.length ? data.rows.map((s) => `<tr class="clickable" data-open="${s.id}">
          <td><a href="#/sales?id=${s.id}"><b>${esc(s.number)}</b></a></td><td>${fmtDate(s.created_at)}</td>
          <td>${esc(s.customer_name)}${s.customer_phone ? `<div class="muted small-note">${esc(s.customer_phone)}</div>` : ''}</td>
          ${locations.length > 1 ? `<td>${esc(s.location_name)}</td>` : ''}
          <td class="num">${num(s.units)}</td><td class="num">${money(s.total)}</td>
          <td class="num ${s.status !== 'void' && s.total - s.amount_paid > 0.004 ? 'neg' : ''}">${s.status === 'void' ? '—' : money(s.total - s.amount_paid)}</td>
          <td>${saleBadge(s.status)}</td></tr>`).join('') : '<tr><td colspan="8" class="empty">No sales yet</td></tr>'}</tbody>
    </table></div>
    <div class="pager-row">${pager(data.page, data.pages, data.total_count, 'invoices')}</div>`;

  $('#new-sale').onclick = () => newSaleDialog();
  $('#s-filters').onsubmit = (e) => { e.preventDefault(); setQuery({ ...Object.fromEntries(new FormData(e.target)), status: f.status }); };
  bindPager($('#main'), (page) => setQuery({ ...f, page }));
  $$('[data-open]').forEach((r) => { r.onclick = (e) => { if (!e.target.closest('a')) location.hash = `#/sales?id=${r.dataset.open}`; }; });
  if (params.get('new')) newSaleDialog();
};

async function newSaleDialog() {
  const [products, customers] = await Promise.all([api('GET', '/api/products'), api('GET', '/api/parties?type=customer')]);
  if (!products.length) return toast('Add a product first', true);
  const loc = preferredLocationId();
  const stockAt = (p, id) => p.levels.find((l) => l.location_id === Number(id))?.quantity || 0;
  const productOptions = (locId) => '<option value="">Choose product…</option>' + products.map((p) =>
    `<option value="${p.id}" ${stockAt(p, locId) <= 0 ? 'disabled' : ''}>${esc(p.sku)} — ${esc(p.name)} (${num(stockAt(p, locId))} ${esc(p.unit)})</option>`).join('');

  const lineHtml = (locId) => `<tr class="sale-line">
      <td><select class="sl-product" required>${productOptions(locId)}</select></td>
      <td><input type="number" class="sl-qty" min="1" step="1" value="1" required style="width:80px"></td>
      <td><input type="number" class="sl-price" min="0" step="0.01" required style="width:110px"></td>
      <td class="num sl-total">—</td>
      <td><button type="button" class="btn link danger sl-remove" aria-label="Remove line">✕</button></td></tr>`;

  const vatNote = settings.vat_rate ? `VAT ${settings.vat_rate}% (${settings.vat_inclusive ? 'included in prices' : 'added to prices'})` : 'No VAT (set it under Admin → Invoices & tax)';

  const form = openModal('New sale', `
    <div class="form-grid">
      <label>Customer <input name="customer" list="customer-options" autocomplete="off" placeholder="Leave empty for a walk-in customer"></label>
      <label>Phone <input name="customer_phone" type="tel" placeholder="Optional"></label>
      <datalist id="customer-options">${customers.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
      ${locations.length > 1 ? `<label>Sell from <select name="location_id">${locationOptions(loc)}</select></label>` : ''}
      <label>Customer KRA PIN <input name="customer_pin" placeholder="Optional, for business customers"></label>
    </div>
    <div class="scan-row">
      <input id="sale-scan" placeholder="▥ Scan or type SKU and press Enter to add" autocomplete="off" aria-label="Scan product to add">
    </div>
    <div class="table-wrap"><table class="sale-lines">
      <thead><tr><th>Product</th><th>Qty</th><th>Unit price</th><th class="num">Line total</th><th></th></tr></thead>
      <tbody>${lineHtml(loc)}</tbody>
      <tfoot><tr><td colspan="5"><button type="button" class="btn small" id="add-line">+ Add line</button></td></tr></tfoot>
    </table></div>
    <div class="sale-bottom">
      <div class="form-grid">
        <label>Discount (${esc(settings.currency)}) <input type="number" name="discount" min="0" step="0.01" value="0"></label>
        <label>Due date <input type="date" name="due_date"></label>
        <label>Amount paid now <input type="number" name="amount_paid" min="0" step="0.01" placeholder="Full amount"></label>
        <label>Payment method <select name="payment_method">${Object.entries(PAY_METHODS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label class="full">Payment reference <input name="payment_reference" placeholder="e.g. M-Pesa code"></label>
        <label class="full">Notes on invoice <textarea name="notes" rows="2"></textarea></label>
      </div>
      <dl class="sale-sum" id="sale-sum"></dl>
    </div>
    <p class="muted small-note">${vatNote}. Leave "Amount paid now" empty if paid in full, or 0 to invoice on credit.</p>`, async (f, el) => {
    const items = $$('.sale-line', el).map((tr) => ({
      product_id: $('.sl-product', tr).value, quantity: Number($('.sl-qty', tr).value), unit_price: $('.sl-price', tr).value,
    })).filter((i) => i.product_id);
    if (!items.length) throw new Error('Add at least one product');
    const totals = saleTotals(items.map((i) => ({ quantity: i.quantity, unit_price: Number(i.unit_price) })), f.discount);
    const paid = f.amount_paid === '' ? totals.total : Number(f.amount_paid);
    const sale = await api('POST', '/api/sales', { ...f, items, amount_paid: paid });
    if (f.location_id) rememberLocation(f.location_id);
    toast(`${sale.number} saved`);
    (sale.alerts || []).forEach((a, i) => setTimeout(() => toast(`⚠ ${a}`, 'warn'), 800 + i * 3500));
    refreshAlerts();
    location.hash = `#/sales?id=${sale.id}`;
  }, 'Save sale', 'primary', { wide: true });

  const tbody = $('.sale-lines tbody', form);
  const currentLoc = () => form.location_id?.value || loc;
  const recalc = () => {
    const lines = $$('.sale-line', form).map((tr) => {
      const qty = Number($('.sl-qty', tr).value) || 0;
      const price = Number($('.sl-price', tr).value) || 0;
      $('.sl-total', tr).textContent = $('.sl-product', tr).value ? money(qty * price) : '—';
      return { quantity: qty, unit_price: price, product: $('.sl-product', tr).value };
    }).filter((l) => l.product);
    const t = saleTotals(lines, form.discount.value);
    $('#sale-sum', form).innerHTML = `
      <div><dt>Subtotal</dt><dd>${money(t.subtotal)}</dd></div>
      ${t.discount ? `<div><dt>Discount</dt><dd>− ${money(t.discount)}</dd></div>` : ''}
      ${settings.vat_rate ? `<div><dt>VAT ${settings.vat_rate}%${settings.vat_inclusive ? ' (incl.)' : ''}</dt><dd>${money(t.vat)}</dd></div>` : ''}
      <div class="grand"><dt>Total</dt><dd>${money(t.total)}</dd></div>`;
    form.amount_paid.placeholder = `Full amount (${money(t.total)})`;
  };
  const bindLine = (tr) => {
    $('.sl-product', tr).onchange = (e) => {
      const p = products.find((x) => x.id === Number(e.target.value));
      if (p) {
        $('.sl-price', tr).value = p.sell_price || '';
        $('.sl-qty', tr).max = stockAt(p, currentLoc());
        if (!p.sell_price) toast(`${p.name} has no selling price yet — enter one`, 'warn');
      }
      recalc();
    };
    $('.sl-qty', tr).oninput = recalc;
    $('.sl-price', tr).oninput = recalc;
    $('.sl-remove', tr).onclick = () => { if ($$('.sale-line', form).length > 1) tr.remove(); else $('.sl-product', tr).value = ''; recalc(); };
  };
  const addLine = (productId) => {
    let tr = $$('.sale-line', form).find((x) => !$('.sl-product', x).value);
    if (!tr) { tbody.insertAdjacentHTML('beforeend', lineHtml(currentLoc())); tr = tbody.lastElementChild; bindLine(tr); }
    if (productId) { $('.sl-product', tr).value = productId; $('.sl-product', tr).onchange({ target: $('.sl-product', tr) }); }
    return tr;
  };
  bindLine($('.sale-line', form));
  $('#add-line', form).onclick = () => $('.sl-product', addLine()).focus();
  form.discount.oninput = recalc;
  if (form.location_id) {
    form.location_id.onchange = () => {
      $$('.sl-product', form).forEach((s) => { const v = s.value; s.innerHTML = productOptions(currentLoc()); s.value = v; });
      recalc();
    };
  }
  // Scanner: adds the product (or +1 if it's already on the sale)
  $('#sale-scan', form).onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = e.target.value.trim().toLowerCase();
    e.target.value = '';
    const p = products.find((x) => x.sku.toLowerCase() === code);
    if (!p) return toast(`No product with SKU "${code}"`, true);
    const existing = $$('.sale-line', form).find((tr) => $('.sl-product', tr).value === String(p.id));
    if (existing) { $('.sl-qty', existing).value = Number($('.sl-qty', existing).value) + 1; recalc(); } else addLine(p.id);
  };
  recalc();
}

async function renderSale(id) {
  const s = await api('GET', `/api/sales/${id}`);
  const open = s.status === 'unpaid' || s.status === 'partial';

  $('#main').innerHTML = `
    <div class="page-head"><h1><a href="#/sales" class="muted no-print">Sales ›</a> ${esc(s.number)} ${saleBadge(s.status)}</h1>
      <div class="actions">
        <button class="btn" id="print-invoice">🖨 Print invoice</button>
        ${open ? '<button class="btn primary" id="add-payment">Record payment</button>' : ''}
        ${me.role === 'admin' && s.status !== 'void' ? '<button class="btn danger-outline" id="void-sale">Void sale</button>' : ''}
      </div></div>
    ${s.status === 'void' ? `<p class="notice-bad">Voided ${fmtDate(s.voided_at)}: ${esc(s.void_reason)}. The items were put back in stock.
      ${s.amount_paid > 0 ? ` <b>${money(s.amount_paid)} was paid — refund the customer.</b>` : ''}</p>` : ''}
    <div class="card invoice-view">${invoiceHtml(s)}</div>
    <div class="grid-2" style="margin-top:14px">
      <div class="card"><h2>Payments</h2>
        ${s.payments.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th class="num">Amount</th><th>By</th></tr></thead>
          <tbody>${s.payments.map((p) => `<tr><td>${fmtDate(p.created_at)}</td><td>${PAY_METHODS[p.method]}</td><td>${esc(p.reference)}</td>
            <td class="num">${money(p.amount)}</td><td class="muted">${esc(p.username || '—')}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted">No payments yet.</p>'}
      </div>
      <div class="card"><h2>Profit on this sale</h2>
        <dl class="sale-sum">
          <div><dt>Sales (excl. VAT)</dt><dd>${money(s.total - s.vat)}</dd></div>
          <div><dt>Cost of goods</dt><dd>${money(s.cost_total)}</dd></div>
          <div class="grand"><dt>Gross profit</dt><dd class="${s.profit >= 0 ? 'pos' : 'neg'}">${money(s.profit)}</dd></div>
        </dl>
        <p class="muted small-note">Sold from ${esc(s.location_name)} by ${esc(s.created_by_name || '—')}.</p>
      </div>
    </div>`;

  $('#print-invoice').onclick = () => printHtml(`<div class="invoice-print">${invoiceHtml(s)}</div>`);
  if ($('#add-payment')) {
    $('#add-payment').onclick = () => openModal(`Record payment — ${s.number}`, `
      <p>Balance due: <b>${money(s.balance)}</b></p>
      <div class="form-grid">
        <label>Amount <input type="number" name="amount" min="0.01" step="0.01" max="${s.balance}" value="${s.balance}" required autofocus></label>
        <label>Method <select name="method">${Object.entries(PAY_METHODS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label class="full">Reference <input name="reference" placeholder="e.g. M-Pesa code, cheque no."></label>
      </div>`, async (f) => {
      await api('POST', `/api/sales/${s.id}/payments`, f);
      toast('Payment recorded');
      refreshAlerts();
      route();
    }, 'Save payment');
  }
  if ($('#void-sale')) {
    $('#void-sale').onclick = () => openModal(`Void ${s.number}?`, `
      <p>All items go back into stock at ${esc(s.location_name)}. The invoice stays on record marked "Void".
      ${s.amount_paid > 0 ? `<br><b>${money(s.amount_paid)} has been paid — you will need to refund it.</b>` : ''}</p>
      <label>Reason <input name="reason" required placeholder="e.g. Customer returned the goods"></label>`, async (f) => {
      await api('POST', `/api/sales/${s.id}/void`, f);
      toast('Sale voided');
      route();
    }, 'Void sale', 'out');
  }
}

// The invoice itself — used on screen and for printing.
function invoiceHtml(s) {
  const lines = (s.items || []).map((i) => `<tr><td>${esc(i.product_name)}<div class="muted small-note">${esc(i.sku)}</div></td>
    <td class="num">${num(i.quantity)} ${esc(i.unit)}</td><td class="num">${money(i.unit_price)}</td><td class="num">${money(i.line_total)}</td></tr>`).join('');
  const contact = [settings.company_address, settings.company_phone, settings.company_email].filter(Boolean).map(esc).join(' · ');
  return `
    <div class="inv-head">
      <div><div class="inv-company">${esc(settings.company_name)}</div>
        ${contact ? `<div class="muted">${contact}</div>` : ''}
        ${settings.company_pin ? `<div class="muted">KRA PIN: ${esc(settings.company_pin)}</div>` : ''}</div>
      <div class="inv-meta"><div class="inv-title">${s.status === 'void' ? 'VOID ' : ''}INVOICE</div>
        <div>No. <b>${esc(s.number)}</b></div><div>Date: ${fmtDate(s.created_at)}</div>
        ${s.due_date ? `<div>Due: ${fmtDay(s.due_date)}</div>` : ''}</div>
    </div>
    <div class="inv-to"><span class="muted">Bill to</span><br><b>${esc(s.customer_name)}</b>
      ${s.customer_phone ? `<br>${esc(s.customer_phone)}` : ''}${s.customer_pin ? `<br>KRA PIN: ${esc(s.customer_pin)}` : ''}</div>
    <table class="inv-lines"><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
      <tbody>${lines}</tbody></table>
    <dl class="sale-sum inv-sum">
      <div><dt>Subtotal</dt><dd>${money(s.subtotal)}</dd></div>
      ${s.discount ? `<div><dt>Discount</dt><dd>− ${money(s.discount)}</dd></div>` : ''}
      ${s.vat_rate ? `<div><dt>VAT ${s.vat_rate}%${s.vat_inclusive ? ' (included)' : ''}</dt><dd>${money(s.vat)}</dd></div>` : ''}
      <div class="grand"><dt>Total</dt><dd>${money(s.total)}</dd></div>
      <div><dt>Paid</dt><dd>${money(s.amount_paid)}</dd></div>
      ${s.status !== 'void' ? `<div class="grand"><dt>Balance due</dt><dd>${money(s.balance)}</dd></div>` : ''}
    </dl>
    ${s.notes ? `<p class="inv-notes">${esc(s.notes)}</p>` : ''}
    ${settings.invoice_footer ? `<p class="inv-footer muted">${esc(settings.invoice_footer)}</p>` : ''}`;
}
