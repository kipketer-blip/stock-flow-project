const { db, recordMovement, logActivity } = require('../db');
const { wrap, str, int, requireAdmin, httpError } = require('../lib/http');

// Reads numbers typed by people or exported from spreadsheets: "2.5", "2,5", "1,234.50", "1 234", "$3".
// Empty means 0; anything else that isn't a number is an error.
function parseNumber(v, label) {
  if (typeof v === 'number') return v;
  const raw = String(v ?? '').trim();
  if (raw === '') return 0;
  let s = raw.replace(/[\s ']/g, '').replace(/^[^\d.,-]+/, ''); // drop a leading currency symbol or code
  if (s === '') throw httpError(400, `${label} must be a number (got "${v}")`);
  if (/^-?\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.'); // decimal comma
  else s = s.replace(/,/g, ''); // thousands separators
  const n = Number(s);
  if (!Number.isFinite(n)) throw httpError(400, `${label} must be a number (got "${v}")`);
  return n;
}
const parseWhole = (v, label) => {
  const n = parseNumber(v, label);
  if (!Number.isInteger(n)) throw httpError(400, `${label} must be a whole number (got "${v}")`);
  return n;
};

function productFields(body) {
  const p = {
    sku: str(body.sku, 50), name: str(body.name), category: str(body.category, 80), unit: str(body.unit, 20) || 'pcs',
    unit_cost: parseNumber(body.unit_cost, 'Unit cost'), reorder_level: parseWhole(body.reorder_level, 'Reorder level'),
    // null = not sent (e.g. an import file without a price column): keep the current selling price
    sell_price: body.sell_price === undefined ? null : parseNumber(body.sell_price, 'Selling price'),
  };
  if (p.reorder_level < 0) throw httpError(400, 'Reorder level cannot be negative');
  if (p.sell_price != null && p.sell_price < 0) throw httpError(400, 'Selling price cannot be negative');
  if (!p.sku || !p.name) throw httpError(400, 'SKU and name are required');
  if (!/^[\x20-\x7E]+$/.test(p.sku)) throw httpError(400, 'SKU may only use plain letters, numbers and symbols (it is printed as a barcode)');
  if (p.unit_cost < 0) throw httpError(400, 'Unit cost cannot be negative');
  return p;
}

const insertProduct = () => db.prepare(`INSERT INTO products (sku, name, category, unit, unit_cost, reorder_level, sell_price)
                                        VALUES (@sku, @name, @category, @unit, @unit_cost, @reorder_level, COALESCE(@sell_price, 0))`);

module.exports = (app) => {
  // Each product includes `levels`: units per location. ?location_id=N adds `here` (units at that location).
  app.get('/api/products', wrap((req, res) => {
    const q = `%${str(req.query.q)}%`;
    const products = db.prepare(`SELECT * FROM products WHERE active = 1 AND (sku LIKE ? OR name LIKE ? OR category LIKE ?)
                                 ORDER BY name`).all(q, q, q);
    const levels = db.prepare(`SELECT s.product_id, s.location_id, l.name, s.quantity FROM stock_levels s
                               JOIN locations l ON l.id = s.location_id WHERE s.quantity > 0 ORDER BY l.is_default DESC, l.name`).all();
    const byProduct = new Map();
    for (const l of levels) {
      if (!byProduct.has(l.product_id)) byProduct.set(l.product_id, []);
      byProduct.get(l.product_id).push({ location_id: l.location_id, name: l.name, quantity: l.quantity });
    }
    const here = req.query.location_id ? Number(req.query.location_id) : null;
    res.json(products.map((p) => {
      const lv = byProduct.get(p.id) || [];
      return { ...p, levels: lv, ...(here && { here: lv.find((l) => l.location_id === here)?.quantity || 0 }) };
    }));
  }));

  app.get('/api/categories', wrap((req, res) => {
    res.json(db.prepare("SELECT DISTINCT category FROM products WHERE active = 1 AND category <> '' ORDER BY category").pluck().all());
  }));

  app.post('/api/products', wrap((req, res) => {
    const p = productFields(req.body);
    const opening = parseWhole(req.body.opening_stock, 'Opening stock');
    if (opening < 0) throw httpError(400, 'Opening stock cannot be negative');
    const id = db.transaction(() => {
      const newId = insertProduct().run(p).lastInsertRowid;
      if (opening > 0) {
        recordMovement({
          productId: newId, type: 'IN', quantity: opening, note: 'Opening stock', userId: req.session.user.id, locationId: req.body.location_id,
        });
      }
      return newId;
    })();
    logActivity(req.session.user, 'product.create', `${p.sku} ${p.name}`);
    res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
  }));

  app.put('/api/products/:id', wrap((req, res) => {
    const before = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(req.params.id);
    if (!before) throw httpError(404, 'Product not found');
    const p = productFields(req.body);
    db.prepare(`UPDATE products SET sku=@sku, name=@name, category=@category, unit=@unit, unit_cost=@unit_cost,
                reorder_level=@reorder_level, sell_price=COALESCE(@sell_price, sell_price), updated_at=datetime('now') WHERE id=@id`)
      .run({ ...p, id: before.id });
    const changes = Object.keys(p).filter((k) => p[k] != null && String(p[k]) !== String(before[k])).map((k) => `${k}: ${before[k]} → ${p[k]}`);
    if (changes.length) logActivity(req.session.user, 'product.update', `${p.sku}: ${changes.join(', ')}`);
    res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(before.id));
  }));

  // Products with history are archived rather than deleted so the movement log stays intact.
  app.delete('/api/products/:id', requireAdmin, wrap((req, res) => {
    const p = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(req.params.id);
    if (!p) throw httpError(404, 'Product not found');
    const hasHistory = db.prepare('SELECT 1 FROM movements WHERE product_id = ? UNION SELECT 1 FROM po_items WHERE product_id = ? LIMIT 1')
      .get(p.id, p.id);
    if (hasHistory) {
      db.prepare("UPDATE products SET active = 0, sku = sku || '#' || id, updated_at = datetime('now') WHERE id = ?").run(p.id);
    } else {
      db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
    }
    logActivity(req.session.user, hasHistory ? 'product.archive' : 'product.delete', `${p.sku} ${p.name}`);
    res.json({ ok: true, archived: !!hasHistory });
  }));

  // Bulk import: new SKUs are created (with optional opening stock); existing SKUs have their details updated.
  // Stock quantities of existing products are never changed by an import. Valid rows are saved even if others fail.
  app.post('/api/products/import', wrap((req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) throw httpError(400, 'No rows to import');
    if (rows.length > 5000) throw httpError(400, 'Import at most 5000 rows at a time');

    const result = { created: 0, updated: 0, errors: [] };
    const findSku = db.prepare('SELECT * FROM products WHERE sku = ? AND active = 1');
    const update = db.prepare(`UPDATE products SET name=@name, category=@category, unit=@unit, unit_cost=@unit_cost,
                               reorder_level=@reorder_level, sell_price=COALESCE(@sell_price, sell_price),
                               updated_at=datetime('now') WHERE id=@id`);
    const insert = insertProduct();
    const seen = new Set();

    db.transaction(() => {
      rows.forEach((raw, i) => {
        const line = i + 2; // row 1 is the header
        try {
          const p = productFields(raw);
          if (seen.has(p.sku.toLowerCase())) throw httpError(400, `SKU ${p.sku} appears more than once in the file`);
          seen.add(p.sku.toLowerCase());
          const opening = parseWhole(raw.opening_stock, 'Opening stock');
          if (opening < 0) throw httpError(400, 'Opening stock cannot be negative');
          const existing = findSku.get(p.sku);
          if (existing) {
            update.run({ ...p, id: existing.id });
            result.updated++;
          } else {
            const id = insert.run(p).lastInsertRowid;
            if (opening > 0) {
              recordMovement({
                productId: id, type: 'IN', quantity: opening, note: 'Opening stock (import)', userId: req.session.user.id, locationId: req.body.location_id,
              });
            }
            result.created++;
          }
        } catch (e) {
          if (!e.status && !String(e.code).startsWith('SQLITE_CONSTRAINT')) throw e;
          result.errors.push({ line, error: e.message });
        }
      });
    })();

    logActivity(req.session.user, 'product.import', `${result.created} created, ${result.updated} updated, ${result.errors.length} skipped`);
    res.json(result);
  }));
};
