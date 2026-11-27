// Sales & invoices. Creating a sale takes the items out of stock (one OUT movement per line, referenced
// by the invoice number). Payments can be recorded in parts. Admins can void a sale, which puts the stock back.
const { db, recordMovement, resolveParty, resolveLocation, getSetting, logActivity } = require('../db');
const { wrap, str, int, tzModifier, dateParam, requireAdmin, httpError } = require('../lib/http');
const alerts = require('../lib/alerts');

const METHODS = ['cash', 'mpesa', 'card', 'bank', 'cheque', 'other'];
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const statusFor = (total, paid) => (paid <= 0 ? 'unpaid' : paid + 0.005 >= total ? 'paid' : 'partial');

function loadSale(id) {
  const sale = db.prepare(`SELECT s.*, l.name AS location_name, u.username AS created_by_name
                           FROM sales s JOIN locations l ON l.id = s.location_id
                           LEFT JOIN users u ON u.id = s.created_by WHERE s.id = ?`).get(id);
  if (!sale) throw httpError(404, 'Sale not found');
  sale.items = db.prepare(`SELECT i.*, p.sku, p.name AS product_name, p.unit FROM sale_items i
                           JOIN products p ON p.id = i.product_id WHERE i.sale_id = ? ORDER BY i.id`).all(sale.id);
  sale.payments = db.prepare(`SELECT sp.*, u.username FROM sale_payments sp LEFT JOIN users u ON u.id = sp.created_by
                              WHERE sp.sale_id = ? ORDER BY sp.id`).all(sale.id);
  sale.balance = round2(sale.status === 'void' ? 0 : sale.total - sale.amount_paid);
  sale.profit = round2(sale.total - sale.vat - sale.cost_total);
  return sale;
}

// Works out totals the same way for the preview and the saved sale.
function computeTotals(lines, discount, vatRate, inclusive) {
  const subtotal = round2(lines.reduce((s, l) => s + l.quantity * l.unit_price, 0));
  const disc = round2(Math.min(Math.max(discount, 0), subtotal));
  const net = subtotal - disc;
  const vat = round2(inclusive ? (net * vatRate) / (100 + vatRate) : (net * vatRate) / 100);
  const total = round2(inclusive ? net : net + vat);
  return { subtotal, discount: disc, vat, total };
}

const readPayment = (body) => {
  const amount = round2(Number(body.amount ?? body.amount_paid ?? 0));
  if (!Number.isFinite(amount) || amount < 0) throw httpError(400, 'Amount paid must be 0 or more');
  const method = METHODS.includes(body.method || body.payment_method) ? (body.method || body.payment_method) : 'cash';
  return { amount, method, reference: str(body.reference || body.payment_reference, 60) };
};

module.exports = (app) => {
  // ?status=unpaid|partial|paid|void|open&q=&from=&to=&location_id=&page=
  app.get('/api/sales', wrap((req, res) => {
    const where = [];
    const args = [];
    const tz = tzModifier(req);
    if (['unpaid', 'partial', 'paid', 'void'].includes(req.query.status)) { where.push('s.status = ?'); args.push(req.query.status); }
    if (req.query.status === 'open') where.push("s.status IN ('unpaid','partial')");
    if (req.query.location_id) { where.push('s.location_id = ?'); args.push(int(req.query.location_id)); }
    if (req.query.customer_id) { where.push('s.customer_id = ?'); args.push(int(req.query.customer_id)); }
    const from = dateParam(req.query.from);
    const to = dateParam(req.query.to);
    if (from) { where.push('date(s.created_at, ?) >= ?'); args.push(tz, from); }
    if (to) { where.push('date(s.created_at, ?) <= ?'); args.push(tz, to); }
    if (req.query.q) {
      const like = `%${str(req.query.q)}%`;
      where.push('(s.number LIKE ? OR s.customer_name LIKE ? OR s.customer_phone LIKE ?)');
      args.push(like, like, like);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const pageSize = 50;
    const summary = db.prepare(`SELECT COUNT(*) AS total_count,
        COALESCE(SUM(CASE WHEN s.status <> 'void' THEN s.total END),0) AS total_sales,
        COALESCE(SUM(CASE WHEN s.status <> 'void' THEN s.total - s.amount_paid END),0) AS outstanding
      FROM sales s ${w}`).get(...args);
    const pages = Math.max(1, Math.ceil(summary.total_count / pageSize));
    const page = Math.min(Math.max(int(req.query.page, 1), 1), pages);
    const rows = db.prepare(`SELECT s.*, l.name AS location_name,
        (SELECT COALESCE(SUM(quantity),0) FROM sale_items WHERE sale_id = s.id) AS units
      FROM sales s JOIN locations l ON l.id = s.location_id ${w} ORDER BY s.id DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (page - 1) * pageSize);
    res.json({ rows, page, pages, ...summary });
  }));

  app.get('/api/sales/:id', wrap((req, res) => res.json(loadSale(int(req.params.id)))));

  // { customer, customer_phone, customer_pin, location_id, items: [{ product_id, quantity, unit_price }],
  //   discount, notes, due_date, amount_paid, payment_method, payment_reference }
  app.post('/api/sales', wrap((req, res) => {
    const location = resolveLocation(req.body.location_id);
    const raw = Array.isArray(req.body.items) ? req.body.items : [];
    if (!raw.length) throw httpError(400, 'Add at least one product');
    if (raw.length > 200) throw httpError(400, 'Too many lines on one sale');

    const lines = raw.map((i) => {
      const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(int(i.product_id));
      if (!product) throw httpError(400, 'Unknown product on the sale');
      const quantity = Number(i.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) throw httpError(400, `${product.name}: quantity must be a whole number above 0`);
      const price = i.unit_price === undefined || i.unit_price === '' ? product.sell_price : Number(i.unit_price);
      if (!Number.isFinite(price) || price < 0) throw httpError(400, `${product.name}: enter a valid price`);
      return { product, quantity, unit_price: round2(price) };
    });

    const vatRate = Number(getSetting('vat_rate', () => '0')) || 0;
    const inclusive = getSetting('vat_inclusive', () => '1') === '1';
    const totals = computeTotals(lines, Number(req.body.discount) || 0, vatRate, inclusive);
    const pay = readPayment(req.body);
    if (pay.amount > totals.total + 0.005) throw httpError(400, 'Amount paid is more than the invoice total');

    const customerName = str(req.body.customer, 120);
    const lowItems = [];
    const id = db.transaction(() => {
      const customer = customerName ? resolveParty(customerName, 'customer') : null;
      const prefix = getSetting('invoice_prefix', () => 'INV');
      const next = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 FROM sales').pluck().get();
      const number = `${prefix}-${String(next).padStart(5, '0')}`;
      const costTotal = round2(lines.reduce((s, l) => s + l.quantity * l.product.unit_cost, 0));

      const saleId = db.prepare(`INSERT INTO sales (number, customer_id, customer_name, customer_phone, customer_pin, location_id,
            subtotal, discount, vat_rate, vat_inclusive, vat, total, amount_paid, cost_total, due_date, notes, created_by, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(number, customer?.id ?? null, customer?.name || 'Walk-in customer', str(req.body.customer_phone, 30),
          str(req.body.customer_pin, 20).toUpperCase(), location.id, totals.subtotal, totals.discount, vatRate, inclusive ? 1 : 0,
          totals.vat, totals.total, pay.amount, costTotal, dateParam(req.body.due_date) || null, str(req.body.notes, 500),
          req.session.user.id, statusFor(totals.total, pay.amount)).lastInsertRowid;

      const addItem = db.prepare(`INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, unit_cost, line_total)
                                  VALUES (?, ?, ?, ?, ?, ?)`);
      for (const l of lines) {
        const r = recordMovement({
          productId: l.product.id, type: 'OUT', quantity: l.quantity, party: customer?.name || '', reference: number,
          note: 'Sale', userId: req.session.user.id, locationId: location.id,
        });
        if (r.becameLow) lowItems.push(r.product);
        addItem.run(saleId, l.product.id, l.quantity, l.unit_price, l.product.unit_cost, round2(l.quantity * l.unit_price));
      }
      if (pay.amount > 0) {
        db.prepare('INSERT INTO sale_payments (sale_id, amount, method, reference, created_by) VALUES (?, ?, ?, ?, ?)')
          .run(saleId, pay.amount, pay.method, pay.reference, req.session.user.id);
      }
      return saleId;
    })();

    lowItems.forEach((p) => alerts.lowStock(p));
    const sale = loadSale(id);
    logActivity(req.session.user, 'sale.create', `${sale.number} ${sale.customer_name}, ${sale.total}`);
    res.status(201).json({
      ...sale,
      alerts: lowItems.map((p) => `${p.name} is low on stock: ${p.quantity} ${p.unit} left (reorder at ${p.reorder_level})`),
    });
  }));

  // { amount, method, reference }
  app.post('/api/sales/:id/payments', wrap((req, res) => {
    const sale = loadSale(int(req.params.id));
    if (sale.status === 'void') throw httpError(400, 'This sale was voided');
    if (sale.balance <= 0) throw httpError(400, 'This invoice is already fully paid');
    const pay = readPayment(req.body);
    if (pay.amount <= 0) throw httpError(400, 'Enter the amount received');
    if (pay.amount > sale.balance + 0.005) throw httpError(400, `The balance is only ${sale.balance}`);
    db.transaction(() => {
      db.prepare('INSERT INTO sale_payments (sale_id, amount, method, reference, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(sale.id, pay.amount, pay.method, pay.reference, req.session.user.id);
      const paid = round2(sale.amount_paid + pay.amount);
      db.prepare('UPDATE sales SET amount_paid = ?, status = ? WHERE id = ?').run(paid, statusFor(sale.total, paid), sale.id);
    })();
    logActivity(req.session.user, 'sale.payment', `${sale.number}: ${pay.amount} by ${pay.method}${pay.reference ? ` (${pay.reference})` : ''}`);
    res.json(loadSale(sale.id));
  }));

  // Voiding puts every item back into stock at the sale's location.
  app.post('/api/sales/:id/void', requireAdmin, wrap((req, res) => {
    const sale = loadSale(int(req.params.id));
    if (sale.status === 'void') throw httpError(400, 'This sale is already void');
    const reason = str(req.body.reason, 200);
    if (!reason) throw httpError(400, 'Give a reason for voiding the sale');
    db.transaction(() => {
      for (const item of sale.items) {
        recordMovement({
          productId: item.product_id, type: 'ADJUST', quantity: item.quantity, party: `Void of ${sale.number}`,
          reference: sale.number, note: reason, userId: req.session.user.id, locationId: sale.location_id, unitCost: item.unit_cost,
        });
      }
      db.prepare("UPDATE sales SET status = 'void', void_reason = ?, voided_at = datetime('now') WHERE id = ?").run(reason, sale.id);
    })();
    logActivity(req.session.user, 'sale.void', `${sale.number}: ${reason}${sale.amount_paid > 0 ? ` (refund ${sale.amount_paid} due)` : ''}`);
    res.json(loadSale(sale.id));
  }));
};

module.exports.computeTotals = computeTotals;
