// Reports. Date range (?from=YYYY-MM-DD&to=YYYY-MM-DD) is in the viewer's local days; default is the last 30 days.
const { db } = require('../db');
const { wrap, int, tzModifier, dateParam } = require('../lib/http');

module.exports = (app) => {
  app.get('/api/reports', wrap((req, res) => {
    const tz = tzModifier(req);
    const today = db.prepare('SELECT date(\'now\', ?)').pluck().get(tz);
    const to = dateParam(req.query.to) || today;
    const from = dateParam(req.query.from) || db.prepare("SELECT date(?, '-29 days')").pluck().get(to);
    const slowDays = Math.min(Math.max(int(req.query.slow_days, 90), 7), 3650);
    const inRange = 'date(m.created_at, ?) BETWEEN ? AND ?';
    const range = [tz, from, to];

    // Current stock value by category.
    const byCategory = db.prepare(`SELECT CASE WHEN category = '' THEN 'Uncategorised' ELSE category END AS category,
          COUNT(*) AS products, SUM(quantity) AS units, SUM(quantity * unit_cost) AS value,
          SUM(CASE WHEN quantity <= reorder_level THEN 1 ELSE 0 END) AS low
        FROM products WHERE active = 1 GROUP BY 1 ORDER BY value DESC`).all();

    // In / out per month for the 12 months up to `to`.
    const monthly = db.prepare(`SELECT strftime('%Y-%m', m.created_at, ?) AS month,
          COALESCE(SUM(CASE WHEN m.type='IN' THEN m.quantity END),0) AS units_in,
          COALESCE(SUM(CASE WHEN m.type='OUT' THEN -m.quantity END),0) AS units_out,
          COALESCE(SUM(CASE WHEN m.type='IN' THEN m.quantity * m.unit_cost END),0) AS value_in,
          COALESCE(SUM(CASE WHEN m.type='OUT' THEN -m.quantity * m.unit_cost END),0) AS value_out
        FROM movements m
        WHERE date(m.created_at, ?) > date(?, 'start of month', '-12 months') AND date(m.created_at, ?) <= ?
        GROUP BY month ORDER BY month`).all(tz, tz, to, tz, to);

    // Products that moved out the most in the range.
    const topMovers = db.prepare(`SELECT p.id, p.sku, p.name, p.unit, p.quantity,
          SUM(-m.quantity) AS units_out, SUM(-m.quantity * m.unit_cost) AS value_out, COUNT(*) AS times
        FROM movements m JOIN products p ON p.id = m.product_id
        WHERE m.type = 'OUT' AND p.active = 1 AND ${inRange}
        GROUP BY p.id ORDER BY units_out DESC LIMIT 10`).all(...range);

    // In stock but nothing issued for `slowDays` days (or ever).
    const slowStock = db.prepare(`SELECT p.id, p.sku, p.name, p.unit, p.quantity, p.quantity * p.unit_cost AS value,
          (SELECT MAX(created_at) FROM movements WHERE product_id = p.id AND type = 'OUT') AS last_out,
          p.created_at
        FROM products p
        WHERE p.active = 1 AND p.quantity > 0
          AND COALESCE((SELECT MAX(created_at) FROM movements WHERE product_id = p.id AND type = 'OUT'), p.created_at)
              < datetime('now', ?)
        ORDER BY value DESC`).all(`-${slowDays} days`);

    const byParty = (type) => db.prepare(`SELECT pa.id, pa.name, COUNT(*) AS movements,
          SUM(ABS(m.quantity)) AS units, SUM(ABS(m.quantity) * m.unit_cost) AS value
        FROM movements m JOIN parties pa ON pa.id = m.party_id
        WHERE m.type = ? AND ${inRange}
        GROUP BY pa.id ORDER BY value DESC LIMIT 10`).all(type, ...range);

    const totals = db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN m.type='IN' THEN m.quantity END),0) AS units_in,
          COALESCE(SUM(CASE WHEN m.type='OUT' THEN -m.quantity END),0) AS units_out,
          COALESCE(SUM(CASE WHEN m.type='IN' THEN m.quantity * m.unit_cost END),0) AS value_in,
          COALESCE(SUM(CASE WHEN m.type='OUT' THEN -m.quantity * m.unit_cost END),0) AS value_out,
          COALESCE(SUM(CASE WHEN m.type='ADJUST' THEN m.quantity * m.unit_cost END),0) AS value_adjust
        FROM movements m WHERE ${inRange}`).get(...range);

    // ----- sales & profit (non-void sales in the range). Profit = total − VAT − cost of the goods.
    const saleRange = "s.status <> 'void' AND date(s.created_at, ?) BETWEEN ? AND ?";
    const sales = db.prepare(`SELECT COUNT(*) AS invoices, COALESCE(SUM(s.total),0) AS revenue, COALESCE(SUM(s.vat),0) AS vat,
          COALESCE(SUM(s.cost_total),0) AS cost, COALESCE(SUM(s.total - s.vat - s.cost_total),0) AS profit,
          COALESCE(SUM(s.discount),0) AS discounts, COALESCE(SUM(s.amount_paid),0) AS collected,
          COALESCE(SUM(s.total - s.amount_paid),0) AS outstanding
        FROM sales s WHERE ${saleRange}`).get(...range);
    sales.margin = sales.revenue - sales.vat > 0 ? Math.round((sales.profit / (sales.revenue - sales.vat)) * 1000) / 10 : 0;

    const salesMonthly = db.prepare(`SELECT strftime('%Y-%m', s.created_at, ?) AS month, COUNT(*) AS invoices,
          SUM(s.total) AS revenue, SUM(s.total - s.vat - s.cost_total) AS profit
        FROM sales s WHERE s.status <> 'void' AND date(s.created_at, ?) > date(?, 'start of month', '-12 months')
          AND date(s.created_at, ?) <= ?
        GROUP BY month ORDER BY month`).all(tz, tz, to, tz, to);

    // Line profit uses the line's share of the invoice after discount and VAT.
    const topProfit = db.prepare(`SELECT p.id, p.sku, p.name, SUM(i.quantity) AS units,
          SUM(i.line_total * (1 - s.discount / NULLIF(s.subtotal, 0))
              / (CASE WHEN s.vat_inclusive = 1 THEN 1 + s.vat_rate / 100.0 ELSE 1 END)) AS net_sales,
          SUM(i.quantity * i.unit_cost) AS cost
        FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN products p ON p.id = i.product_id
        WHERE ${saleRange}
        GROUP BY p.id ORDER BY (net_sales - cost) DESC LIMIT 10`).all(...range)
      .map((r) => ({ ...r, net_sales: Math.round(r.net_sales * 100) / 100, profit: Math.round((r.net_sales - r.cost) * 100) / 100 }));

    const byPayment = db.prepare(`SELECT sp.method, COUNT(*) AS payments, SUM(sp.amount) AS amount
        FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
        WHERE s.status <> 'void' AND date(sp.created_at, ?) BETWEEN ? AND ?
        GROUP BY sp.method ORDER BY amount DESC`).all(...range);

    // ----- stock held at each location (now)
    const byLocation = db.prepare(`SELECT l.id, l.name, l.active, COUNT(CASE WHEN st.quantity > 0 THEN 1 END) AS products,
          COALESCE(SUM(st.quantity),0) AS units, COALESCE(SUM(st.quantity * p.unit_cost),0) AS value
        FROM locations l LEFT JOIN stock_levels st ON st.location_id = l.id
        LEFT JOIN products p ON p.id = st.product_id AND p.active = 1
        GROUP BY l.id ORDER BY l.is_default DESC, l.name`).all();

    res.json({
      from, to, slowDays, totals, byCategory, monthly, topMovers, slowStock,
      bySupplier: byParty('IN'), byCustomer: byParty('OUT'),
      sales, salesMonthly, topProfit, byPayment, byLocation,
    });
  }));
};
