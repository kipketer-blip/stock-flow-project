// Locations (shops, warehouses, stores). Everyone can list them; admins manage them.
const { db, logActivity } = require('../db');
const { wrap, str, int, requireAdmin, httpError } = require('../lib/http');

const withStock = () => db.prepare(`SELECT l.*,
    COALESCE((SELECT SUM(s.quantity) FROM stock_levels s WHERE s.location_id = l.id), 0) AS units,
    COALESCE((SELECT SUM(s.quantity * p.unit_cost) FROM stock_levels s JOIN products p ON p.id = s.product_id
              WHERE s.location_id = l.id AND p.active = 1), 0) AS value,
    (SELECT COUNT(*) FROM stock_levels s WHERE s.location_id = l.id AND s.quantity > 0) AS products
  FROM locations l ORDER BY l.is_default DESC, l.name`).all();

module.exports = (app) => {
  app.get('/api/locations', wrap((req, res) => {
    const all = withStock();
    res.json(req.query.all ? all : all.filter((l) => l.active));
  }));

  app.post('/api/locations', requireAdmin, wrap((req, res) => {
    const name = str(req.body.name, 60);
    if (!name) throw httpError(400, 'Location name is required');
    if (db.prepare('SELECT 1 FROM locations WHERE name = ?').get(name)) throw httpError(409, 'A location with this name already exists');
    const id = db.prepare('INSERT INTO locations (name, address) VALUES (?, ?)').run(name, str(req.body.address, 200)).lastInsertRowid;
    logActivity(req.session.user, 'location.create', name);
    res.status(201).json(db.prepare('SELECT * FROM locations WHERE id = ?').get(id));
  }));

  // { name, address, active, is_default }
  app.put('/api/locations/:id', requireAdmin, wrap((req, res) => {
    const loc = db.prepare('SELECT * FROM locations WHERE id = ?').get(int(req.params.id));
    if (!loc) throw httpError(404, 'Location not found');
    const name = req.body.name !== undefined ? str(req.body.name, 60) : loc.name;
    if (!name) throw httpError(400, 'Location name is required');
    if (name.toLowerCase() !== loc.name.toLowerCase() && db.prepare('SELECT 1 FROM locations WHERE name = ? AND id <> ?').get(name, loc.id)) {
      throw httpError(409, 'A location with this name already exists');
    }
    const address = req.body.address !== undefined ? str(req.body.address, 200) : loc.address;
    let active = req.body.active !== undefined ? (req.body.active ? 1 : 0) : loc.active;
    const makeDefault = Boolean(req.body.is_default) && !loc.is_default;

    if (!active) {
      if (loc.is_default && !makeDefault) throw httpError(400, 'The default location cannot be closed. Make another location the default first.');
      const units = db.prepare('SELECT COALESCE(SUM(quantity),0) FROM stock_levels WHERE location_id = ?').pluck().get(loc.id);
      if (units > 0) throw httpError(400, `${loc.name} still holds ${units} units. Transfer them to another location before closing it.`);
    }
    db.transaction(() => {
      if (makeDefault) {
        active = 1;
        db.prepare('UPDATE locations SET is_default = 0').run();
        db.prepare('UPDATE locations SET is_default = 1 WHERE id = ?').run(loc.id);
      }
      db.prepare('UPDATE locations SET name = ?, address = ?, active = ? WHERE id = ?').run(name, address, active, loc.id);
    })();
    logActivity(req.session.user, 'location.update', `${loc.name}${name !== loc.name ? ` → ${name}` : ''}${makeDefault ? ' (now default)' : ''}${!active ? ' (closed)' : ''}`);
    res.json(db.prepare('SELECT * FROM locations WHERE id = ?').get(loc.id));
  }));
};
