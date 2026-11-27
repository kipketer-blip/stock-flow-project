'use strict';
// Stock in / out / adjust dialog, barcode quick-scan, and the Movements page.

const TYPE_TITLES = { IN: 'Record stock in', OUT: 'Record stock out', ADJUST: 'Adjust stock' };

async function movementDialog(type, productId, { quantity = '' } = {}) {
  const partyType = type === 'IN' ? 'supplier' : 'customer';
  const [products, parties] = await Promise.all([
    api('GET', '/api/products'),
    type === 'ADJUST' ? [] : api('GET', `/api/parties?type=${partyType}`),
  ]);
  if (!products.length) return toast('Add a product first', true);
  const partyLabel = type === 'IN' ? 'Supplier' : type === 'OUT' ? 'Issued to (customer / department)' : 'Reason (required)';
  const options = products.map((p) => `<option value="${p.id}" ${p.id === productId ? 'selected' : ''}>${esc(p.sku)} — ${esc(p.name)}</option>`).join('');
  const multi = locations.length > 1;

  const form = openModal(TYPE_TITLES[type], `
    <div class="form-grid">
      <label class="full">Product <select name="product_id" required>${options}</select></label>
      ${multi ? `<label class="full">Location <select name="location_id">${locationOptions(preferredLocationId())}</select></label>` : ''}
      <p class="muted full" id="stock-hint" style="margin:0"></p>
      <label>Quantity ${type === 'ADJUST' ? '(use − to reduce)' : ''}
        <input type="number" name="quantity" step="1" ${type === 'ADJUST' ? '' : 'min="1"'} value="${esc(quantity)}" required autofocus></label>
      <label>Reference no. <input name="reference" placeholder="${type === 'IN' ? 'PO / invoice' : type === 'OUT' ? 'Request / delivery note' : 'Count sheet no.'}"></label>
      <label class="full">${partyLabel}
        <input name="party" ${type === 'ADJUST' ? 'required placeholder="e.g. Stock count, damaged, expired"' : `list="party-options" autocomplete="off"
          placeholder="Pick from the list or type a new name"`}></label>
      ${type === 'ADJUST' ? '' : `<datalist id="party-options">${parties.map((p) => `<option value="${esc(p.name)}">`).join('')}</datalist>
        <p class="muted full small-note">New names are added to Suppliers &amp; customers automatically.</p>`}
      <label class="full">Note <textarea name="note" rows="2"></textarea></label>
    </div>`, async (f) => {
    const r = await api('POST', '/api/movements', { ...f, type });
    if (f.location_id) rememberLocation(f.location_id);
    toast(`${TYPE_TITLES[type].replace('Record ', '')} saved`);
    if (r.alert) setTimeout(() => toast(`⚠ ${r.alert}`, 'warn'), 800);
    refreshAlerts();
    route();
  }, 'Save', type === 'IN' ? 'in' : type === 'OUT' ? 'out' : 'primary');

  const sel = $('select[name=product_id]', form);
  const locSel = $('select[name=location_id]', form);
  const hint = () => {
    const p = products.find((x) => x.id === Number(sel.value));
    const low = p.quantity <= p.reorder_level;
    const here = locSel ? p.levels.find((l) => l.location_id === Number(locSel.value))?.quantity || 0 : null;
    $('#stock-hint', form).innerHTML = (locSel
      ? `At this location: <b>${num(here)} ${esc(p.unit)}</b> · total <b class="${low ? 'neg' : ''}">${num(p.quantity)}</b>`
      : `Current stock: <b class="${low ? 'neg' : ''}">${num(p.quantity)} ${esc(p.unit)}</b>`) +
      ` <span class="muted">(reorder at ${num(p.reorder_level)})</span>`;
  };
  sel.onchange = hint;
  if (locSel) locSel.onchange = hint;
  hint();
  if (productId) $('input[name=quantity]', form).focus();
}

// Move stock between two locations.
async function transferDialog(productId) {
  if (locations.length < 2) return toast('Add a second location under Admin → Locations first', true);
  const products = await api('GET', '/api/products');
  const options = products.filter((p) => p.quantity > 0)
    .map((p) => `<option value="${p.id}" ${p.id === productId ? 'selected' : ''}>${esc(p.sku)} — ${esc(p.name)}</option>`).join('');
  const from = preferredLocationId();
  const to = locations.find((l) => l.id !== from)?.id;
  const form = openModal('Transfer stock', `
    <div class="form-grid">
      <label class="full">Product <select name="product_id" required>${options}</select></label>
      <label>From <select name="from_id">${locationOptions(from)}</select></label>
      <label>To <select name="to_id">${locationOptions(to)}</select></label>
      <p class="muted full" id="transfer-hint" style="margin:0"></p>
      <label>Quantity <input type="number" name="quantity" min="1" step="1" required autofocus></label>
      <label>Reference no. <input name="reference" placeholder="Transfer note no."></label>
      <label class="full">Note <textarea name="note" rows="2"></textarea></label>
    </div>`, async (f) => {
    if (f.from_id === f.to_id) throw new Error('Choose two different locations');
    const r = await api('POST', '/api/movements/transfer', f);
    toast(r.message);
    route();
  }, 'Transfer');
  const hint = () => {
    const p = products.find((x) => x.id === Number(form.product_id.value));
    if (!p) return;
    const at = (id) => p.levels.find((l) => l.location_id === Number(id))?.quantity || 0;
    $('#transfer-hint', form).innerHTML = `Available at source: <b>${num(at(form.from_id.value))} ${esc(p.unit)}</b> · at destination: ${num(at(form.to_id.value))}`;
    form.quantity.max = at(form.from_id.value);
  };
  ['product_id', 'from_id', 'to_id'].forEach((n) => { form[n].onchange = hint; });
  hint();
}

function movementButtons() {
  return `<button class="btn in" data-move="IN">+ Stock in</button>
          <button class="btn out" data-move="OUT">− Stock out</button>
          ${locations.length > 1 ? '<button class="btn" data-move="TRANSFER">⇄ Transfer</button>' : ''}
          ${me.role === 'admin' ? '<button class="btn" data-move="ADJUST">Adjust</button>' : ''}`;
}
function bindMovementButtons(root) {
  $$('[data-move]', root).forEach((b) => {
    b.onclick = () => (b.dataset.move === 'TRANSFER'
      ? transferDialog(Number(b.dataset.product) || undefined)
      : movementDialog(b.dataset.move, Number(b.dataset.product) || undefined));
  });
}

// ---------- barcode quick scan ----------
// USB barcode scanners type the code and press Enter, so a plain text box works with any scanner.
function scanBox() {
  return `<form class="scan-box" data-scan title="Scan a barcode or type a SKU, then press Enter">
    <span aria-hidden="true">▥</span>
    <input name="sku" placeholder="Scan / type SKU" autocomplete="off" aria-label="Scan or type SKU">
    <select name="mode" aria-label="What to record">
      <option value="OUT">Stock out</option><option value="IN">Stock in</option><option value="VIEW">Find</option>
    </select>
    ${'BarcodeDetector' in window ? '<button type="button" class="btn small" data-camera title="Scan with camera">📷</button>' : ''}
  </form>`;
}

function bindScanBox(root) {
  const form = $('[data-scan]', root);
  if (!form) return;
  try { form.mode.value = localStorage.getItem('scanMode') || 'OUT'; } catch { /* storage unavailable */ }
  form.mode.onchange = () => { try { localStorage.setItem('scanMode', form.mode.value); } catch { /* ignore */ } };
  const handle = async (code) => {
    code = code.trim();
    if (!code) return;
    const matches = await api('GET', `/api/products?q=${encodeURIComponent(code)}`);
    const p = matches.find((x) => x.sku.toLowerCase() === code.toLowerCase());
    form.sku.value = '';
    if (!p) return toast(`No product with SKU "${code}"`, true);
    if (form.mode.value === 'VIEW') { location.hash = `#/products?q=${encodeURIComponent(p.sku)}`; return; }
    movementDialog(form.mode.value, p.id, { quantity: 1 });
  };
  form.onsubmit = (e) => { e.preventDefault(); handle(form.sku.value).catch((err) => toast(err.message, true)); };
  const cam = $('[data-camera]', form);
  if (cam) cam.onclick = () => cameraScan((code) => handle(code).catch((err) => toast(err.message, true)));
}

// Camera scanning where the browser supports it (Chrome on Android, Safari/Chrome on macOS).
async function cameraScan(onCode) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    return toast('Camera not available or permission denied', true);
  }
  const detector = new BarcodeDetector({ formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code'] });
  const form = openModal('Scan barcode', '<video id="scan-video" playsinline muted></video><p class="muted">Point the camera at a barcode.</p>', null, null);
  const video = $('#scan-video', form);
  video.srcObject = stream;
  await video.play();
  let done = false;
  const stop = () => { done = true; stream.getTracks().forEach((t) => t.stop()); };
  $('#modal').addEventListener('modal-closed', stop, { once: true });
  const tick = async () => {
    if (done) return;
    try {
      const codes = await detector.detect(video);
      if (codes.length) { $('#modal').close(); onCode(codes[0].rawValue); return; }
    } catch { /* frame not ready */ }
    setTimeout(tick, 250);
  };
  tick();
}

// ---------- movements table + page ----------
// Table header matching movementRows (the Location column appears once there are several locations).
function movementHead() {
  return `<tr><th>Date</th><th>Type</th>${locations.length > 1 ? '<th>Location</th>' : ''}<th>Product</th><th class="num">Change</th>
    <th class="num">${locations.length > 1 ? 'Left here / total' : 'Balance'}</th><th>Party / reason</th><th>Ref</th><th>Note</th><th>By</th></tr>`;
}

function movementRows(rows) {
  const multi = locations.length > 1;
  if (!rows.length) return `<tr><td colspan="10" class="empty">No movements found</td></tr>`;
  return rows.map((m) => `<tr>
      <td>${fmtDate(m.created_at)}</td>
      <td><span class="badge ${m.type}">${m.type === 'TRANSFER' ? 'MOVE' : m.type}</span></td>
      ${multi ? `<td>${esc(m.location_name || '')}</td>` : ''}
      <td>${esc(m.product_name)} <span class="muted">${esc(m.sku)}</span></td>
      <td class="num">${signed(m.quantity)}</td>
      <td class="num">${multi ? `${num(m.location_balance_after)} <span class="muted">/ ${num(m.balance_after)}</span>` : num(m.balance_after)}</td>
      <td>${m.party_id ? `<a href="#/movements?party_id=${m.party_id}">${esc(m.party)}</a>` : esc(m.party)}</td>
      <td>${esc(m.reference)}</td>
      <td class="muted">${esc(m.note)}</td>
      <td class="muted">${esc(m.username || '—')}</td>
    </tr>`).join('');
}

routes.movements = async function renderMovements(params) {
  const keys = ['type', 'product_id', 'party_id', 'location_id', 'from', 'to', 'q', 'page', 'page_size'];
  const f = Object.fromEntries(keys.map((k) => [k, params.get(k) || '']));
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const [data, products, parties] = await Promise.all([
    api('GET', `/api/movements?${qs}`), api('GET', '/api/products'), api('GET', '/api/parties'),
  ]);
  const exportQs = new URLSearchParams(Object.entries({ ...f, page: '', page_size: '', tz: TZ }).filter(([, v]) => v !== '')).toString();
  const partyOpt = (type, label) => `<optgroup label="${label}">${parties.filter((p) => p.type === type)
    .map((p) => `<option value="${p.id}" ${String(p.id) === f.party_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>`;

  $('#main').innerHTML = `
    <div class="page-head"><h1>Stock movements</h1>
      <div class="actions">${scanBox()}${movementButtons()}<a class="btn" href="/api/movements/export.csv?${exportQs}">Export CSV</a></div></div>
    <form class="filters" id="m-filters">
      <label>Type <select name="type">
        <option value="">All</option>${[['IN', 'In'], ['OUT', 'Out'], ['ADJUST', 'Adjust'], ['TRANSFER', 'Transfer']]
          .map(([t, l]) => `<option value="${t}" ${f.type === t ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
      ${locations.length > 1 ? `<label>Location <select name="location_id">${locationOptions(f.location_id, { includeAll: true })}</select></label>` : ''}
      <label>Product <select name="product_id"><option value="">All products</option>
        ${products.map((p) => `<option value="${p.id}" ${String(p.id) === f.product_id ? 'selected' : ''}>${esc(p.sku)} — ${esc(p.name)}</option>`).join('')}
      </select></label>
      <label>Supplier / customer <select name="party_id"><option value="">Anyone</option>
        ${partyOpt('supplier', 'Suppliers')}${partyOpt('customer', 'Customers')}</select></label>
      <label>From <input type="date" name="from" value="${esc(f.from)}"></label>
      <label>To <input type="date" name="to" value="${esc(f.to)}"></label>
      <label>Search <input name="q" value="${esc(f.q)}" placeholder="Reference, note…"></label>
      <button class="btn primary">Apply</button>
      <a class="btn" href="#/movements">Clear</a>
    </form>
    <p class="muted">${num(data.total)} movement${data.total === 1 ? '' : 's'} ·
      <span class="pos">${num(data.sum_in)} in</span> · <span class="neg">${num(data.sum_out)} out</span>
      ${data.sum_adjust ? ` · adjusted ${signed(data.sum_adjust)}` : ''}
      ${data.sum_transfer ? ` · ${num(data.sum_transfer)} moved between locations` : ''}</p>
    <div class="card table-wrap"><table>
      <thead>${movementHead()}</thead>
      <tbody>${movementRows(data.rows)}</tbody></table></div>
    <div class="pager-row">${pager(data.page, data.pages, data.total, 'movements')}
      <label class="inline">Per page <select id="page-size">${[25, 50, 100, 200].map((n) => `<option ${n === data.page_size ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    </div>`;

  $('#m-filters').onsubmit = (e) => {
    e.preventDefault();
    setQuery({ ...Object.fromEntries(new FormData(e.target)), page_size: f.page_size });
  };
  bindPager($('#main'), (page) => setQuery({ ...f, page }));
  $('#page-size').onchange = (e) => setQuery({ ...f, page: '', page_size: e.target.value });
  bindMovementButtons($('#main'));
  bindScanBox($('#main'));
};
