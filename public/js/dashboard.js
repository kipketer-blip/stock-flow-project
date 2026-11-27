'use strict';

routes.dashboard = async function renderDashboard() {
  const d = await api('GET', '/api/dashboard');
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const day = localDay(new Date(Date.now() - i * 864e5));
    const row = d.daily.find((r) => r.day === day) || { stock_in: 0, stock_out: 0 };
    days.push({ day, ...row });
  }
  const max = Math.max(1, ...days.map((x) => Math.max(x.stock_in, x.stock_out)));

  $('#main').innerHTML = `
    <div class="page-head"><h1>Dashboard</h1><div class="actions">${scanBox()}<a class="btn primary" href="#/sales?new=1">+ New sale</a>${movementButtons()}</div></div>
    <div class="stats">
      <a class="card stat link-card" href="#/sales"><div class="label">Sales today</div><div class="value">${money(d.sales.today)}</div>
        <div class="muted">${num(d.sales.today_count)} invoice(s)</div></a>
      <a class="card stat link-card" href="#/reports"><div class="label">Profit (30 days)</div><div class="value pos">${money(d.sales.profit30)}</div>
        <div class="muted">on ${money(d.sales.last30)} sales</div></a>
      <a class="card stat link-card" href="#/sales?status=open"><div class="label">Unpaid invoices</div>
        <div class="value ${d.sales.outstanding > 0 ? 'neg' : ''}">${money(d.sales.outstanding)}</div></a>
      <div class="card stat"><div class="label">Active products</div><div class="value">${num(d.totals.products)}</div></div>
      <div class="card stat"><div class="label">Units on hand</div><div class="value">${num(d.totals.units)}</div></div>
      <div class="card stat"><div class="label">Stock value</div><div class="value">${money(d.totals.value)}</div></div>
      <a class="card stat link-card" href="#/reports"><div class="label">Low stock items</div><div class="value ${d.totals.low ? 'neg' : ''}">${num(d.totals.low)}</div></a>
      <div class="card stat"><div class="label">In / out (30 days)</div>
        <div class="value"><span class="pos">${num(d.flow30.stock_in)}</span> / <span class="neg">${num(d.flow30.stock_out)}</span></div></div>
      <a class="card stat link-card" href="#/orders?status=active"><div class="label">Open purchase orders</div><div class="value">${num(d.openPOs)}</div></a>
    </div>
    <div class="grid-2">
      <div class="card">
        <div class="page-head" style="margin:0"><h2>Movement flow — last 14 days</h2>
          <div class="legend"><span><i style="background:var(--in)"></i>In</span><span><i style="background:var(--out)"></i>Out</span></div></div>
        <div class="chart">${days.map((x) => `
          <div class="day" title="${fmtDay(x.day)}: +${x.stock_in} in / −${x.stock_out} out">
            <div class="bars">
              <div class="bar in" style="height:${(x.stock_in / max) * 100}%"></div>
              <div class="bar out" style="height:${(x.stock_out / max) * 100}%"></div>
            </div>
            <div class="lbl">${x.day.slice(8)}</div>
          </div>`).join('')}
        </div>
      </div>
      <div class="card">
        <h2>Low stock</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Product</th><th class="num">On hand</th><th class="num">Reorder at</th><th></th></tr></thead>
          <tbody>${d.lowStock.length ? d.lowStock.map((p) => `<tr>
              <td>${esc(p.name)}<br><span class="muted">${esc(p.sku)}</span></td>
              <td class="num neg">${num(p.quantity)}</td><td class="num">${num(p.reorder_level)}</td>
              <td><button class="btn link" data-move="IN" data-product="${p.id}">Restock</button></td></tr>`).join('')
            : '<tr><td colspan="4" class="empty">All stock levels are healthy</td></tr>'}</tbody>
        </table></div>
      </div>
    </div>
    <div class="card">
      <div class="page-head" style="margin-bottom:6px"><h2 style="margin:0">Recent movements</h2><a href="#/movements">View all →</a></div>
      <div class="table-wrap"><table>
        <thead>${movementHead()}</thead>
        <tbody>${movementRows(d.recent)}</tbody>
      </table></div>
    </div>`;
  bindMovementButtons($('#main'));
  bindScanBox($('#main'));
};
