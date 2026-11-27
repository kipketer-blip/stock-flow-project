'use strict';
// Products page: list, add/edit, delete, barcode labels, CSV import/export.

routes.products = async function renderProducts(params) {
  const q = params.get('q') || '';
  const [products, categories] = await Promise.all([
    api('GET', `/api/products?q=${encodeURIComponent(q)}`), api('GET', '/api/categories'),
  ]);

  $('#main').innerHTML = `
    <div class="page-head"><h1>Products</h1>
      <div class="actions">
        <button class="btn" id="print-labels" disabled>▥ Print labels</button>
        <button class="btn" id="import-btn">Import CSV</button>
        <button class="btn" id="export-btn">Export CSV</button>
        <button class="btn primary" id="add-product">+ New product</button>
      </div></div>
    <div class="filters">
      <label>Search <input id="p-search" value="${esc(q)}" placeholder="SKU, name or category"></label>
      ${scanBox()}
    </div>
    <div class="card table-wrap"><table>
      <thead><tr><th><input type="checkbox" id="check-all" aria-label="Select all"></th>
        <th>SKU</th><th>Name</th><th>Category</th><th class="num">On hand</th><th>Unit</th>
        <th class="num">Unit cost</th><th class="num">Selling price</th><th class="num">Value</th><th>Status</th><th></th></tr></thead>
      <tbody>${products.length ? products.map((p) => `<tr>
          <td><input type="checkbox" class="pick" value="${p.id}" aria-label="Select ${esc(p.name)}"></td>
          <td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td>${esc(p.category)}</td>
          <td class="num"><b>${num(p.quantity)}</b>${levelsText(p) ? `<div class="muted small-note">${levelsText(p)}</div>` : ''}</td><td>${esc(p.unit)}</td>
          <td class="num">${money(p.unit_cost)}</td>
          <td class="num">${p.sell_price > 0 ? money(p.sell_price) : '<span class="muted">not set</span>'}</td>
          <td class="num">${money(p.quantity * p.unit_cost)}</td>
          <td>${p.quantity <= p.reorder_level ? '<span class="badge low">Low</span>' : '<span class="badge ok">OK</span>'}</td>
          <td>
            <button class="btn link" data-move="IN" data-product="${p.id}">In</button>
            <button class="btn link" data-move="OUT" data-product="${p.id}">Out</button>
            ${locations.length > 1 && p.quantity > 0 ? `<button class="btn link" data-move="TRANSFER" data-product="${p.id}">Move</button>` : ''}
            <a class="btn link" href="#/movements?product_id=${p.id}">History</a>
            <button class="btn link" data-edit="${p.id}">Edit</button>
            ${me.role === 'admin' ? `<button class="btn link danger" data-del="${p.id}">Delete</button>` : ''}
          </td></tr>`).join('') : `<tr><td colspan="11" class="empty">${q ? 'No products match your search' : 'No products yet'}</td></tr>`}
      </tbody></table></div>
    <datalist id="cat-list">${categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`;

  let t;
  $('#p-search').oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(() => { location.hash = `#/products?q=${encodeURIComponent(e.target.value)}`; }, 300);
  };
  if (q) { const s = $('#p-search'); s.focus(); s.setSelectionRange(q.length, q.length); }

  const picked = () => $$('.pick:checked').map((c) => products.find((p) => p.id === Number(c.value)));
  const updatePicked = () => {
    const n = picked().length;
    $('#print-labels').disabled = !n;
    $('#print-labels').textContent = n ? `▥ Print labels (${n})` : '▥ Print labels';
  };
  $$('.pick').forEach((c) => { c.onchange = updatePicked; });
  $('#check-all').onchange = (e) => { $$('.pick').forEach((c) => { c.checked = e.target.checked; }); updatePicked(); };
  $('#print-labels').onclick = () => labelsDialog(picked());

  $('#add-product').onclick = () => productDialog();
  $('#import-btn').onclick = importDialog;
  $('#export-btn').onclick = () => {
    const head = ['sku', 'name', 'category', 'unit', 'unit_cost', 'sell_price', 'reorder_level', 'quantity'];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    downloadText('products.csv', '﻿' + [head.join(','), ...products.map((p) => head.map((k) => cell(p[k])).join(','))].join('\r\n'));
  };
  $$('[data-edit]').forEach((b) => {
    b.onclick = () => productDialog(products.find((p) => p.id === Number(b.dataset.edit)));
  });
  $$('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const p = products.find((x) => x.id === Number(b.dataset.del));
      if (!confirm(`Delete "${p.name}"? Products with movement history are archived so their history is kept.`)) return;
      try {
        const r = await api('DELETE', `/api/products/${p.id}`);
        toast(r.archived ? 'Product archived' : 'Product deleted');
        route();
      } catch (err) { toast(err.message, true); }
    };
  });
  bindMovementButtons($('#main'));
  bindScanBox($('#main'));
};

function productDialog(p) {
  const v = (k, d = '') => esc(p ? p[k] : d);
  openModal(p ? 'Edit product' : 'New product', `
    <div class="form-grid">
      <label>SKU / barcode <input name="sku" value="${v('sku')}" required pattern="[\\x20-\\x7E]+" title="Plain letters, numbers and symbols"></label>
      <label>Category <input name="category" value="${v('category')}" list="cat-list"></label>
      <label class="full">Name <input name="name" value="${v('name')}" required></label>
      <label>Unit <input name="unit" value="${v('unit', 'pcs')}"></label>
      <label>Unit cost (${esc(settings.currency)}) <input type="number" name="unit_cost" min="0" step="0.01" value="${v('unit_cost', 0)}"></label>
      <label>Selling price (${esc(settings.currency)}) <input type="number" name="sell_price" min="0" step="0.01" value="${v('sell_price', '')}" placeholder="Used on invoices"></label>
      <label>Reorder level <input type="number" name="reorder_level" min="0" step="1" value="${v('reorder_level', 0)}"></label>
      ${p ? '' : '<label>Opening stock <input type="number" name="opening_stock" min="0" step="1" value="0"></label>'}
      ${!p && locations.length > 1 ? `<label>Opening stock at <select name="location_id">${locationOptions(preferredLocationId())}</select></label>` : ''}
    </div>
    <p class="muted">${p ? 'Stock quantity changes through Stock in / Stock out / Adjust. ' : ''}If the product already has a barcode, scan it into the SKU field.</p>`,
  async (f) => {
    await api(p ? 'PUT' : 'POST', p ? `/api/products/${p.id}` : '/api/products', f);
    toast(p ? 'Product updated' : 'Product created');
    route();
  });
}

// ---------- barcode labels ----------
function labelsDialog(products) {
  if (!products.length) return;
  const form = openModal('Print barcode labels', `
    <p class="muted" style="margin-top:0">Labels are about 50 × 30 mm, laid out on A4 / Letter paper or a label printer.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Product</th><th class="num">Labels</th></tr></thead>
      <tbody>${products.map((p) => `<tr><td>${esc(p.name)} <span class="muted">${esc(p.sku)}</span></td>
        <td class="num"><input type="number" name="copies_${p.id}" min="0" max="500" value="1" style="width:80px"></td></tr>`).join('')}</tbody>
    </table></div>
    <div class="form-grid" style="margin-top:12px">
      <label class="check"><input type="checkbox" name="show_price"> Show selling price</label>
      <label class="check"><input type="checkbox" name="show_company" checked> Show company name</label>
    </div>`, async (f) => {
    const labels = [];
    for (const p of products) {
      const copies = Math.min(500, Math.max(0, parseInt(f[`copies_${p.id}`], 10) || 0));
      for (let i = 0; i < copies; i++) labels.push(p);
    }
    if (!labels.length) throw new Error('Set at least one label to print');
    printLabels(labels, { price: !!f.show_price, company: !!f.show_company });
  }, 'Print', 'primary', { wide: true });
  form.querySelector('input[type=number]').select();
}

function printLabels(labels, opts) {
  const area = $('#print-area');
  area.innerHTML = `<div class="bc-sheet">${labels.map((p) => `<div class="bc-label">
      ${opts.company ? `<div class="bc-company">${esc(settings.company_name)}</div>` : ''}
      <div class="bc-name">${esc(p.name)}</div>
      <svg class="bc-code" data-sku="${esc(p.sku)}"></svg>
      ${opts.price && p.sell_price > 0 ? `<div class="bc-price">${money(p.sell_price)} / ${esc(p.unit)}</div>` : ''}
    </div>`).join('')}</div>`;
  $$('.bc-code', area).forEach((svg) => {
    try {
      JsBarcode(svg, svg.dataset.sku, { format: 'CODE128', width: 1.5, height: 38, fontSize: 12, margin: 0, background: 'transparent' });
    } catch {
      svg.outerHTML = `<div class="bc-sku">${esc(svg.dataset.sku)}</div>`;
    }
  });
  document.body.classList.add('print-labels');
  const done = () => { document.body.classList.remove('print-labels'); area.innerHTML = ''; };
  window.addEventListener('afterprint', done, { once: true });
  setTimeout(() => window.print(), 50);
}

// ---------- CSV import ----------
const IMPORT_COLUMNS = {
  sku: ['sku', 'code', 'item code', 'barcode', 'product code'],
  name: ['name', 'product', 'product name', 'item', 'description'],
  category: ['category', 'group', 'type'],
  unit: ['unit', 'uom', 'unit of measure'],
  unit_cost: ['unit_cost', 'unit cost', 'cost', 'cost price', 'buying price'],
  sell_price: ['sell_price', 'selling price', 'sale price', 'price', 'retail price', 'unit price'],
  reorder_level: ['reorder_level', 'reorder level', 'reorder', 'min', 'minimum', 'min stock'],
  opening_stock: ['opening_stock', 'opening stock', 'quantity', 'qty', 'stock', 'on hand'],
};

function importDialog() {
  let rows = [];
  const template = 'sku,name,category,unit,unit_cost,reorder_level,opening_stock\r\nSKU-5001,Example item,Stationery,pcs,2.50,10,100\r\n';
  const form = openModal('Import products from CSV', `
    <p class="muted" style="margin-top:0">Use a CSV file (in Excel: <i>File → Save As → CSV</i>). Columns:
      <b>sku</b>, <b>name</b>, category, unit, unit_cost, reorder_level, opening_stock.
      <button type="button" class="btn link" id="tpl">Download a template</button></p>
    <ul class="muted small-note">
      <li>New SKUs are added. Opening stock is recorded as a stock-in.</li>
      <li>Existing SKUs get their name, category, unit, cost and reorder level updated. Their stock is <b>not</b> changed.</li>
    </ul>
    <label>CSV file <input type="file" id="csv-file" accept=".csv,text/csv"></label>
    <div id="import-preview"></div>`, async (f, el) => {
    if (!rows.length) throw new Error('Choose a CSV file first');
    const r = await api('POST', '/api/products/import', { rows });
    const msg = `${r.created} added, ${r.updated} updated${r.errors.length ? `, ${r.errors.length} skipped` : ''}`;
    toast(`Import done: ${msg}`, r.errors.length ? 'warn' : '');
    route();
    if (r.errors.length) {
      setTimeout(() => openModal('Some rows were skipped', `<p>${esc(msg)}.</p>
        <div class="table-wrap"><table><thead><tr><th>Line</th><th>Problem</th></tr></thead>
        <tbody>${r.errors.map((e) => `<tr><td>${e.line}</td><td>${esc(e.error)}</td></tr>`).join('')}</tbody></table></div>`, null, null), 50);
    }
  }, 'Import', 'primary', { wide: true });

  $('#tpl', form).onclick = () => downloadText('products-template.csv', template);
  $('#csv-file', form).onchange = async (e) => {
    const file = e.target.files[0];
    const preview = $('#import-preview', form);
    rows = [];
    if (!file) { preview.innerHTML = ''; return; }
    const table = parseCSV(await file.text());
    if (table.length < 2) { preview.innerHTML = '<p class="error">The file has no data rows.</p>'; return; }
    const header = table[0].map((h) => h.trim().toLowerCase());
    const map = {};
    for (const [key, names] of Object.entries(IMPORT_COLUMNS)) {
      const idx = header.findIndex((h) => names.includes(h));
      if (idx >= 0) map[key] = idx;
    }
    if (map.sku == null || map.name == null) {
      preview.innerHTML = `<p class="error">Couldn't find the "sku" and "name" columns. Found: ${esc(table[0].join(', '))}</p>`;
      return;
    }
    rows = table.slice(1).map((r) => Object.fromEntries(Object.entries(map).map(([k, i]) => [k, (r[i] ?? '').trim()])));
    const cols = Object.keys(map);
    preview.innerHTML = `<p><b>${num(rows.length)}</b> row${rows.length === 1 ? '' : 's'} found. Matched columns: ${cols.join(', ')}.
      ${rows.length > 8 ? 'First 8 shown:' : ''}</p>
      <div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
      <tbody>${rows.slice(0, 8).map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  };
}
