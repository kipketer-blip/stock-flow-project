// Purchase orders: order from a supplier, then receive the goods (all at once or in parts).
// Receiving records a normal "stock in" movement for each line, referenced by the PO number.
const { db, recordMovement, resolveParty, resolveLocation, logActivity } = require('../db');
const { wrap, str, int, dateParam, httpError } = require('../lib/http');

const STATUSES = ['open', 'partial', 'received', 'cancelled'];

function loadPO(id) {
  const po = db.prepare(`SELECT po.*, s.name AS supplier, u.username AS created_by_name, l.name AS location_name
                         FROM purchase_orders po JOIN parties s ON s.id = po.supplier_id
                         LEFT JOIN users u ON u.id = po.created_by
                         LEFT JOIN locations l ON l.id = po.location_id WHERE po.id = ?`).get(id);
  if (!po) throw httpError(404, 'Purchase order not found');
  po.items = db.prepare(`SELECT i.*, p.sku, p.name AS product_name, p.unit
                         FROM po_items i JOIN products p ON p.id = i.product_id WHERE i.po_id = ? ORDER BY i.id`).all(po.id);
  po.total = po.items.reduce((s, i) => s + i.qty_ordered * i.unit_cost, 0);
  po.receipts = db.prepare(`SELECT m.created_at, m.quantity, p.sku, p.name AS product_name, u.username
                            FROM movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id
                            WHERE m.type = 'IN' AND m.reference = ? ORDER BY m.id`).all(po.number);
  return po;
}

module.exports = (app) => {
  app.get('/api/purchase-orders', wrap((req, res) => {
    const where = [];
    const args = [];
    if (STATUSES.includes(req.query.status)) { where.push('po.status = ?'); args.push(req.query.status); }
    if (req.query.status === 'active') where.push("po.status IN ('open','partial')");
    if (req.query.supplier_id) { where.push('po.supplier_id = ?'); args.push(int(req.query.supplier_id)); }
    res.json(db.prepare(`SELECT po.*, s.name AS supplier,
          COUNT(i.id) AS lines,
          COALESCE(SUM(i.qty_ordered),0) AS qty_ordered,
          COALESCE(SUM(i.qty_received),0) AS qty_received,
          COALESCE(SUM(i.qty_ordered * i.unit_cost),0) AS total
        FROM purchase_orders po JOIN parties s ON s.id = po.supplier_id
        LEFT JOIN po_items i ON i.po_id = po.id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        GROUP BY po.id ORDER BY po.id DESC LIMIT 500`).all(...args));
  }));

  app.get('/api/purchase-orders/:id', wrap((req, res) => res.json(loadPO(int(req.params.id)))));

  // { supplier: "name", expected_date, note, items: [{ product_id, qty, unit_cost }] }
  app.post('/api/purchase-orders', wrap((req, res) => {
    const supplierName = str(req.body.supplier);
    if (!supplierName) throw httpError(400, 'Supplier is required');
    const items = (Array.isArray(req.body.items) ? req.body.items : [])
      .map((i) => ({ product_id: int(i.product_id), qty: int(i.qty), unit_cost: Number(i.unit_cost) }))
      .filter((i) => i.product_id);
    if (!items.length) throw httpError(400, 'Add at least one product');
    for (const i of items) {
      if (i.qty <= 0) throw httpError(400, 'Each quantity must be at least 1');
      if (!(i.unit_cost >= 0)) throw httpError(400, 'Unit cost cannot be negative');
      if (!db.prepare('SELECT 1 FROM products WHERE id = ? AND active = 1').get(i.product_id)) throw httpError(400, 'Unknown product');
    }
    if (new Set(items.map((i) => i.product_id)).size !== items.length) throw httpError(400, 'Each product can only appear once');

    const id = db.transaction(() => {
      const supplier = resolveParty(supplierName, 'supplier');
      const next = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 FROM purchase_orders').pluck().get();
      const number = `PO-${String(next).padStart(5, '0')}`;
      const location = resolveLocation(req.body.location_id);
      const poId = db.prepare(`INSERT INTO purchase_orders (number, supplier_id, expected_date, note, created_by, location_id)
                               VALUES (?, ?, ?, ?, ?, ?)`)
        .run(number, supplier.id, dateParam(req.body.expected_date) || null, str(req.body.note, 500), req.session.user.id, location.id)
        .lastInsertRowid;
      const add = db.prepare('INSERT INTO po_items (po_id, product_id, qty_ordered, unit_cost) VALUES (?, ?, ?, ?)');
      for (const i of items) add.run(poId, i.product_id, i.qty, i.unit_cost);
      return poId;
    })();
    const po = loadPO(id);
    logActivity(req.session.user, 'po.create', `${po.number} for ${po.supplier}, ${po.items.length} line(s)`);
    res.status(201).json(po);
  }));

  // { items: [{ item_id, qty }], note }  — qty may be less than what is still outstanding (partial delivery).
  app.post('/api/purchase-orders/:id/receive', wrap((req, res) => {
    const po = loadPO(int(req.params.id));
    if (!['open', 'partial'].includes(po.status)) throw httpError(400, `This order is ${po.status}`);
    const lines = (Array.isArray(req.body.items) ? req.body.items : [])
      .map((l) => ({ item: po.items.find((i) => i.id === int(l.item_id)), qty: int(l.qty) }))
      .filter((l) => l.qty !== 0);
    if (!lines.length) throw httpError(400, 'Enter how many of at least one item arrived');

    db.transaction(() => {
      for (const { item, qty } of lines) {
        if (!item) throw httpError(400, 'Unknown order line');
        const outstanding = item.qty_ordered - item.qty_received;
        if (qty < 0 || qty > outstanding) throw httpError(400, `${item.product_name}: you can receive 0–${outstanding}`);
        recordMovement({
          productId: item.product_id, type: 'IN', quantity: qty, party: po.supplier, reference: po.number,
          note: str(req.body.note, 500) || 'Received against purchase order', userId: req.session.user.id, unitCost: item.unit_cost,
          locationId: po.location_id || undefined,
        });
        db.prepare('UPDATE po_items SET qty_received = qty_received + ? WHERE id = ?').run(qty, item.id);
      }
      const left = db.prepare('SELECT COALESCE(SUM(qty_ordered - qty_received),0) FROM po_items WHERE po_id = ?').pluck().get(po.id);
      db.prepare("UPDATE purchase_orders SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(left === 0 ? 'received' : 'partial', po.id);
    })();
    const updated = loadPO(po.id);
    logActivity(req.session.user, 'po.receive',
      `${po.number}: ${lines.map((l) => `${l.qty} × ${l.item.sku}`).join(', ')} (now ${updated.status})`);
    res.json(updated);
  }));

  app.post('/api/purchase-orders/:id/cancel', wrap((req, res) => {
    const po = loadPO(int(req.params.id));
    if (!['open', 'partial'].includes(po.status)) throw httpError(400, `This order is already ${po.status}`);
    db.prepare("UPDATE purchase_orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(po.id);
    logActivity(req.session.user, 'po.cancel', `${po.number}${po.status === 'partial' ? ' (partly received; received stock kept)' : ''}`);
    res.json(loadPO(po.id));
  }));
};
