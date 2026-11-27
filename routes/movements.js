const { db, recordMovement, transferStock, logActivity } = require('../db');
const { wrap, str, int, tzModifier, dateParam, csv, httpError } = require('../lib/http');
const alerts = require('../lib/alerts');

// Builds the WHERE clause shared by the list, totals and CSV export. Dates are the viewer's local days.
function movementFilter(req) {
  const q = req.query;
  const where = [];
  const args = [];
  const tz = tzModifier(req);
  if (['IN', 'OUT', 'ADJUST', 'TRANSFER'].includes(q.type)) { where.push('m.type = ?'); args.push(q.type); }
  if (q.product_id) { where.push('m.product_id = ?'); args.push(int(q.product_id)); }
  if (q.party_id) { where.push('m.party_id = ?'); args.push(int(q.party_id)); }
  if (q.location_id) { where.push('m.location_id = ?'); args.push(int(q.location_id)); }
  const from = dateParam(q.from);
  const to = dateParam(q.to);
  if (from) { where.push('date(m.created_at, ?) >= ?'); args.push(tz, from); }
  if (to) { where.push('date(m.created_at, ?) <= ?'); args.push(tz, to); }
  if (q.q) {
    where.push('(p.name LIKE ? OR p.sku LIKE ? OR m.party LIKE ? OR m.reference LIKE ? OR m.note LIKE ?)');
    const like = `%${str(q.q)}%`;
    args.push(like, like, like, like, like);
  }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

const FROM = `FROM movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id
              LEFT JOIN locations l ON l.id = m.location_id`;
const COLUMNS = `m.*, p.name AS product_name, p.sku, p.unit, u.username, l.name AS location_name`;

module.exports = (app) => {
  // Paged list: ?page=1&page_size=50 plus filters. Totals cover all matching rows, not just this page.
  app.get('/api/movements', wrap((req, res) => {
    const { where, args } = movementFilter(req);
    const pageSize = Math.min(Math.max(int(req.query.page_size, 50), 10), 500);
    const summary = db.prepare(`SELECT COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN m.type='IN' THEN m.quantity END),0) AS sum_in,
          COALESCE(SUM(CASE WHEN m.type='OUT' THEN -m.quantity END),0) AS sum_out,
          COALESCE(SUM(CASE WHEN m.type='ADJUST' THEN m.quantity END),0) AS sum_adjust,
          COALESCE(SUM(CASE WHEN m.type='TRANSFER' AND m.quantity > 0 THEN m.quantity END),0) AS sum_transfer
        ${FROM} ${where}`).get(...args);
    const pages = Math.max(1, Math.ceil(summary.total / pageSize));
    const page = Math.min(Math.max(int(req.query.page, 1), 1), pages);
    const rows = db.prepare(`SELECT ${COLUMNS} ${FROM} ${where} ORDER BY m.id DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (page - 1) * pageSize);
    res.json({ rows, page, pages, page_size: pageSize, ...summary });
  }));

  app.get('/api/movements/export.csv', wrap((req, res) => {
    const { where, args } = movementFilter(req);
    const tz = tzModifier(req);
    const rows = db.prepare(`SELECT ${COLUMNS}, datetime(m.created_at, ?) AS local_time ${FROM} ${where} ORDER BY m.id DESC`)
      .all(tz, ...args);
    csv(res, 'stock-movements.csv',
      ['Date', 'Type', 'Location', 'SKU', 'Product', 'Change', 'Left at location', 'Total after', 'Unit', 'Unit Cost',
        'Party', 'Reference', 'Note', 'User'],
      rows.map((r) => [r.local_time, r.type, r.location_name, r.sku, r.product_name, r.quantity, r.location_balance_after,
        r.balance_after, r.unit, r.unit_cost, r.party, r.reference, r.note, r.username]));
  }));

  app.post('/api/movements', wrap((req, res) => {
    const type = String(req.body.type || '').toUpperCase();
    if (!['IN', 'OUT', 'ADJUST'].includes(type)) throw httpError(400, 'Type must be IN, OUT or ADJUST');
    if (type === 'ADJUST' && req.session.user.role !== 'admin') throw httpError(403, 'Only admins can adjust stock');
    if (type === 'ADJUST' && !str(req.body.party)) throw httpError(400, 'Give a reason for the adjustment');
    const result = recordMovement({
      productId: int(req.body.product_id), type, quantity: Number(req.body.quantity),
      party: str(req.body.party), reference: str(req.body.reference, 80), note: str(req.body.note, 500),
      userId: req.session.user.id, locationId: req.body.location_id,
    });
    const movement = db.prepare('SELECT * FROM movements WHERE id = ?').get(result.id);
    const p = result.product;
    if (result.becameLow) alerts.lowStock(p);
    res.status(201).json({
      ...movement,
      // Shown to the user as an alert when this movement takes the item to (or below) its reorder level.
      alert: result.becameLow ? `${p.name} is low on stock: ${p.quantity} ${p.unit} left (reorder at ${p.reorder_level})` : null,
    });
  }));

  // Move units between locations: { product_id, from_id, to_id, quantity, reference, note }
  app.post('/api/movements/transfer', wrap((req, res) => {
    const t = transferStock({
      productId: int(req.body.product_id), fromId: req.body.from_id, toId: req.body.to_id, quantity: Number(req.body.quantity),
      reference: str(req.body.reference, 80), note: str(req.body.note, 500), userId: req.session.user.id,
    });
    logActivity(req.session.user, 'stock.transfer', `${req.body.quantity} × ${t.product.sku} from ${t.from.name} to ${t.to.name}`);
    res.status(201).json({ ok: true, message: `Moved ${req.body.quantity} ${t.product.unit} of ${t.product.name} from ${t.from.name} to ${t.to.name}` });
  }));
};
