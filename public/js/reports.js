'use strict';
// Reports page: stock value by category, monthly flow, top movers, slow stock, suppliers, customers.

routes.reports = async function renderReports(params) {
  const f = { from: params.get('from') || '', to: params.get('to') || '', slow_days: params.get('slow_days') || '90' };
  const r = await api('GET', `/api/reports?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`);
  const maxMonth = Math.max(1, ...r.monthly.map((m) => Math.max(m.value_in, m.value_out)));
  const totalValue = r.byCategory.reduce((s, c) => s + c.value, 0);
  const monthName = (m) => new Date(m + '-01T00:00:00').toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  const presets = [
    ['Last 30 days', localDay(new Date(Date.now() - 29 * 864e5)), localDay()],
    ['This month', localDay(new Date(new Date().getFullYear(), new Date().getMonth(), 1)), localDay()],
    ['Last 90 days', localDay(new Date(Date.now() - 89 * 864e5)), localDay()],
    ['This year', `${new Date().getFullYear()}-01-01`, localDay()],
  ];
  const table = (head, rows, empty) => `<div class="table-wrap"><table><thead><tr>${head}</tr></thead>
    <tbody>${rows || `<tr><td colspan="9" class="empty">${empty}</td></tr>`}</tbody></table></div>`;

  $('#main').innerHTML = `
    <div class="page-head"><h1>Reports</h1>
      <div class="actions"><button class="btn" onclick="window.print()">Print</button></div></div>
    <form class="filters no-print" id="r-filters">
      <label>From <input type="date" name="from" value="${esc(r.from)}"></label>
      <label>To <input type="date" name="to" value="${esc(r.to)}"></label>
      <button class="btn primary">Apply</button>
      <div class="seg">${presets.map(([l, a, b]) => `<a href="#/reports?from=${a}&to=${b}" class="${r.from === a && r.to === b ? 'active' : ''}">${l}</a>`).join('')}</div>
    </form>
    <p class="print-only"><b>${esc(settings.company_name)}</b> — inventory report, ${fmtDay(r.from)} to ${fmtDay(r.to)}</p>

    <div class="stats">
      <div class="card stat"><div class="label">Stock value now</div><div class="value">${money(totalValue)}</div></div>
      <div class="card stat"><div class="label">Received (value)</div><div class="value pos">${money(r.totals.value_in)}</div>
        <div class="muted">${num(r.totals.units_in)} units</div></div>
      <div class="card stat"><div class="label">Issued (value)</div><div class="value neg">${money(r.totals.value_out)}</div>
        <div class="muted">${num(r.totals.units_out)} units</div></div>
      <div class="card stat"><div class="label">Adjustments (value)</div><div class="value">${money(r.totals.value_adjust)}</div>
        <div class="muted">count corrections, damage, loss, voids</div></div>
    </div>

    <h2 class="section-title">Sales &amp; profit</h2>
    <div class="stats">
      <div class="card stat"><div class="label">Sales</div><div class="value">${money(r.sales.revenue)}</div>
        <div class="muted">${num(r.sales.invoices)} invoice(s)${r.sales.vat ? ` · incl. VAT ${money(r.sales.vat)}` : ''}</div></div>
      <div class="card stat"><div class="label">Cost of goods sold</div><div class="value">${money(r.sales.cost)}</div></div>
      <div class="card stat"><div class="label">Gross profit</div><div class="value ${r.sales.profit >= 0 ? 'pos' : 'neg'}">${money(r.sales.profit)}</div>
        <div class="muted">${r.sales.margin}% margin</div></div>
      <div class="card stat"><div class="label">Collected / unpaid</div><div class="value">${money(r.sales.collected)}</div>
        <div class="muted ${r.sales.outstanding > 0 ? 'neg' : ''}">${money(r.sales.outstanding)} still unpaid</div></div>
    </div>
    <div class="grid-2">
      <div class="card"><h2>Most profitable products</h2>
        ${table('<th>Product</th><th class="num">Units</th><th class="num">Sales (net)</th><th class="num">Profit</th>',
          r.topProfit.map((p) => `<tr><td>${esc(p.name)} <span class="muted">${esc(p.sku)}</span></td><td class="num">${num(p.units)}</td>
            <td class="num">${money(p.net_sales)}</td><td class="num ${p.profit >= 0 ? 'pos' : 'neg'}">${money(p.profit)}</td></tr>`).join(''),
          'No sales in this period')}
      </div>
      <div class="card"><h2>Sales by month</h2>
        ${table('<th>Month</th><th class="num">Invoices</th><th class="num">Sales</th><th class="num">Profit</th>',
          r.salesMonthly.map((m) => `<tr><td>${monthName(m.month)}</td><td class="num">${num(m.invoices)}</td>
            <td class="num">${money(m.revenue)}</td><td class="num">${money(m.profit)}</td></tr>`).join(''), 'No sales in the last 12 months')}
        ${r.byPayment.length ? `<h3>Payments received in this period</h3>
          ${table('<th>Method</th><th class="num">Payments</th><th class="num">Amount</th>',
            r.byPayment.map((p) => `<tr><td>${esc(PAY_METHODS[p.method] || p.method)}</td><td class="num">${num(p.payments)}</td><td class="num">${money(p.amount)}</td></tr>`).join(''), '')}` : ''}
      </div>
    </div>

    ${r.byLocation.length > 1 ? `<div class="card section"><h2>Stock by location (now)</h2>
      ${table('<th>Location</th><th class="num">Products</th><th class="num">Units</th><th class="num">Value</th>',
        r.byLocation.map((l) => `<tr><td><a href="#/movements?location_id=${l.id}">${esc(l.name)}</a>${l.active ? '' : ' <span class="muted">(closed)</span>'}</td>
          <td class="num">${num(l.products)}</td><td class="num">${num(l.units)}</td><td class="num">${money(l.value)}</td></tr>`).join(''), '')}</div>` : ''}

    <h2 class="section-title">Stock movement</h2>

    <div class="grid-2">
      <div class="card"><h2>Stock value by category</h2>
        ${table('<th>Category</th><th class="num">Products</th><th class="num">Units</th><th class="num">Value</th><th class="num">Share</th>',
          r.byCategory.map((c) => `<tr><td>${esc(c.category)}${c.low ? ` <span class="badge low">${c.low} low</span>` : ''}</td>
            <td class="num">${num(c.products)}</td><td class="num">${num(c.units)}</td><td class="num">${money(c.value)}</td>
            <td class="num"><div class="share"><i style="width:${totalValue ? (c.value / totalValue) * 100 : 0}%"></i></div>
              ${totalValue ? Math.round((c.value / totalValue) * 100) : 0}%</td></tr>`).join(''), 'No products')}
      </div>
      <div class="card">
        <div class="page-head" style="margin:0"><h2>Monthly flow (value)</h2>
          <div class="legend"><span><i style="background:var(--in)"></i>In</span><span><i style="background:var(--out)"></i>Out</span></div></div>
        ${r.monthly.length ? `<div class="chart">${r.monthly.map((m) => `
          <div class="day" title="${monthName(m.month)}: ${money(m.value_in)} in / ${money(m.value_out)} out">
            <div class="bars"><div class="bar in" style="height:${(m.value_in / maxMonth) * 100}%"></div>
              <div class="bar out" style="height:${(m.value_out / maxMonth) * 100}%"></div></div>
            <div class="lbl">${monthName(m.month)}</div></div>`).join('')}</div>` : '<p class="empty">No movements in the last 12 months</p>'}
      </div>
    </div>

    <div class="grid-2">
      <div class="card"><h2>Top movers <span class="muted small-note">most issued in this period</span></h2>
        ${table('<th>Product</th><th class="num">Units out</th><th class="num">Value</th><th class="num">On hand</th>',
          r.topMovers.map((p) => `<tr><td><a href="#/movements?product_id=${p.id}&type=OUT">${esc(p.name)}</a> <span class="muted">${esc(p.sku)}</span></td>
            <td class="num">${num(p.units_out)}</td><td class="num">${money(p.value_out)}</td><td class="num">${num(p.quantity)}</td></tr>`).join(''),
          'Nothing issued in this period')}
      </div>
      <div class="card">
        <div class="page-head" style="margin:0 0 8px"><h2 style="margin:0">Slow &amp; dead stock</h2>
          <label class="inline no-print">Not issued for <select id="slow-days">${[30, 60, 90, 180, 365].map((d) =>
            `<option value="${d}" ${d === r.slowDays ? 'selected' : ''}>${d} days</option>`).join('')}</select></label></div>
        ${table('<th>Product</th><th class="num">On hand</th><th class="num">Value tied up</th><th>Last issued</th>',
          r.slowStock.map((p) => `<tr><td>${esc(p.name)} <span class="muted">${esc(p.sku)}</span></td>
            <td class="num">${num(p.quantity)} ${esc(p.unit)}</td><td class="num">${money(p.value)}</td>
            <td>${p.last_out ? fmtDate(p.last_out) : '<span class="muted">never</span>'}</td></tr>`).join(''),
          `Every item in stock was issued in the last ${r.slowDays} days`)}
      </div>
    </div>

    <div class="grid-2">
      <div class="card"><h2>Top suppliers <span class="muted small-note">received in this period</span></h2>
        ${table('<th>Supplier</th><th class="num">Deliveries</th><th class="num">Units</th><th class="num">Value</th>',
          r.bySupplier.map((p) => `<tr><td><a href="#/movements?party_id=${p.id}">${esc(p.name)}</a></td><td class="num">${num(p.movements)}</td>
            <td class="num">${num(p.units)}</td><td class="num">${money(p.value)}</td></tr>`).join(''), 'Nothing received in this period')}
      </div>
      <div class="card"><h2>Top customers / departments <span class="muted small-note">issued in this period</span></h2>
        ${table('<th>Customer</th><th class="num">Issues</th><th class="num">Units</th><th class="num">Value</th>',
          r.byCustomer.map((p) => `<tr><td><a href="#/movements?party_id=${p.id}">${esc(p.name)}</a></td><td class="num">${num(p.movements)}</td>
            <td class="num">${num(p.units)}</td><td class="num">${money(p.value)}</td></tr>`).join(''), 'Nothing issued in this period')}
      </div>
    </div>
    <p class="muted small-note">Values use the unit cost at the time of each movement. "Stock value now" uses current unit costs.</p>`;

  $('#r-filters').onsubmit = (e) => { e.preventDefault(); setQuery({ ...Object.fromEntries(new FormData(e.target)), slow_days: f.slow_days }); };
  $('#slow-days').onchange = (e) => setQuery({ from: f.from, to: f.to, slow_days: e.target.value });
};
