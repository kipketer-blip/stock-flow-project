const { db, getSetting } = require('../db');
const { wrap, tzModifier } = require('../lib/http');

module.exports = (app) => {
  app.get('/api/dashboard', wrap((req, res) => {
    const tz = tzModifier(req);
    const totals = db.prepare(`SELECT COUNT(*) AS products, COALESCE(SUM(quantity),0) AS units,
                                      COALESCE(SUM(quantity * unit_cost),0) AS value,
                                      COALESCE(SUM(CASE WHEN quantity <= reorder_level THEN 1 ELSE 0 END),0) AS low
                               FROM products WHERE active = 1`).get();
    const flow30 = db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN type='IN'  THEN quantity END),0) AS stock_in,
          COALESCE(SUM(CASE WHEN type='OUT' THEN -quantity END),0) AS stock_out
        FROM movements WHERE created_at >= datetime('now','-30 days')`).get();
    // Grouped by the viewer's local day.
    const daily = db.prepare(`SELECT date(created_at, ?) AS day,
          COALESCE(SUM(CASE WHEN type='IN'  THEN quantity END),0) AS stock_in,
          COALESCE(SUM(CASE WHEN type='OUT' THEN -quantity END),0) AS stock_out
        FROM movements WHERE created_at >= datetime('now','-15 days')
        GROUP BY day ORDER BY day`).all(tz);
    const lowStock = db.prepare(`SELECT id, sku, name, quantity, reorder_level, unit FROM products
                                 WHERE active = 1 AND quantity <= reorder_level ORDER BY quantity - reorder_level LIMIT 10`).all();
    const recent = db.prepare(`SELECT m.*, p.name AS product_name, p.sku, p.unit, u.username, l.name AS location_name
                               FROM movements m JOIN products p ON p.id = m.product_id
                               LEFT JOIN users u ON u.id = m.user_id
                               LEFT JOIN locations l ON l.id = m.location_id
                               ORDER BY m.id DESC LIMIT 8`).all();
    const openPOs = db.prepare("SELECT COUNT(*) FROM purchase_orders WHERE status IN ('open','partial')").pluck().get();
    const sales = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN date(created_at, ?) = date('now', ?) THEN total END),0) AS today,
        COALESCE(SUM(CASE WHEN date(created_at, ?) = date('now', ?) THEN 1 END),0) AS today_count,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now','-30 days') THEN total END),0) AS last30,
        COALESCE(SUM(CASE WHEN created_at >= datetime('now','-30 days') THEN total - vat - cost_total END),0) AS profit30,
        COALESCE(SUM(total - amount_paid),0) AS outstanding
      FROM sales WHERE status <> 'void'`).get(tz, tz, tz, tz);
    const locations = db.prepare('SELECT COUNT(*) FROM locations WHERE active = 1').pluck().get();
    res.json({ totals, flow30, daily, lowStock, recent, openPOs, sales, locations });
  }));

  // Everything that needs attention, for the bell in the sidebar.
  app.get('/api/alerts', wrap((req, res) => {
    const tz = tzModifier(req);
    const lowStock = db.prepare(`SELECT id, sku, name, quantity, reorder_level, unit FROM products
                                 WHERE active = 1 AND quantity <= reorder_level ORDER BY quantity - reorder_level`).all();
    const overduePOs = db.prepare(`SELECT po.id, po.number, po.expected_date, s.name AS supplier
                                   FROM purchase_orders po JOIN parties s ON s.id = po.supplier_id
                                   WHERE po.status IN ('open','partial') AND po.expected_date IS NOT NULL
                                     AND po.expected_date < date('now', ?) ORDER BY po.expected_date`).all(tz);
    const pendingUsers = req.session.user.role === 'admin'
      ? db.prepare("SELECT id, username, created_at FROM users WHERE status = 'pending' ORDER BY created_at").all() : [];
    const overdueInvoices = db.prepare(`SELECT id, number, customer_name, due_date, total - amount_paid AS balance FROM sales
                                        WHERE status IN ('unpaid','partial') AND due_date IS NOT NULL AND due_date < date('now', ?)
                                        ORDER BY due_date`).all(tz);
    res.json({
      lowStock, overduePOs, pendingUsers, overdueInvoices,
      count: lowStock.length + overduePOs.length + pendingUsers.length + overdueInvoices.length,
    });
  }));

  // Settings every signed-in user needs (currency for prices, company name for labels and reports).
  app.get('/api/settings', (req, res) => {
    const s = (key, def = '') => getSetting(key, () => def);
    res.json({
      currency: s('currency', 'USD'),
      company_name: s('company_name', 'StockFlow Pro'),
      company_address: s('company_address'),
      company_phone: s('company_phone'),
      company_email: s('company_email'),
      company_pin: s('company_pin'),
      invoice_footer: s('invoice_footer', 'Thank you for your business.'),
      invoice_prefix: s('invoice_prefix', 'INV'),
      vat_rate: Number(s('vat_rate', '0')) || 0,
      vat_inclusive: s('vat_inclusive', '1') === '1',
    });
  });
};
