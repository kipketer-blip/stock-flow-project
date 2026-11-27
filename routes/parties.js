// Suppliers and customers / departments.
const { db, logActivity } = require('../db');
const { wrap, str, int, requireAdmin, httpError } = require('../lib/http');

const TYPES = ['supplier', 'customer'];

function partyFields(body) {
  const p = {
    type: str(body.type), name: str(body.name), contact: str(body.contact), phone: str(body.phone, 50),
    email: str(body.email, 120), notes: str(body.notes, 1000),
  };
  if (!TYPES.includes(p.type)) throw httpError(400, 'Type must be supplier or customer');
  if (!p.name) throw httpError(400, 'Name is required');
  return p;
}

module.exports = (app) => {
  // ?type=supplier|customer&q=...  Each row includes how much has moved through it.
  app.get('/api/parties', wrap((req, res) => {
    const where = ['pa.active = 1'];
    const args = [];
    if (TYPES.includes(req.query.type)) { where.push('pa.type = ?'); args.push(req.query.type); }
    if (req.query.q) {
      where.push('(pa.name LIKE ? OR pa.contact LIKE ? OR pa.email LIKE ? OR pa.phone LIKE ?)');
      const like = `%${str(req.query.q)}%`;
      args.push(like, like, like, like);
    }
    res.json(db.prepare(`SELECT pa.*,
          COUNT(m.id) AS movements,
          COALESCE(SUM(ABS(m.quantity)),0) AS units,
          COALESCE(SUM(ABS(m.quantity) * m.unit_cost),0) AS value,
          MAX(m.created_at) AS last_movement
        FROM parties pa LEFT JOIN movements m ON m.party_id = pa.id
        WHERE ${where.join(' AND ')}
        GROUP BY pa.id ORDER BY pa.name`).all(...args));
  }));

  app.post('/api/parties', wrap((req, res) => {
    const p = partyFields(req.body);
    const existing = db.prepare('SELECT * FROM parties WHERE type = ? AND name = ?').get(p.type, p.name);
    if (existing?.active) throw httpError(409, `A ${p.type} called "${p.name}" already exists`);
    let id;
    if (existing) {
      db.prepare('UPDATE parties SET contact=@contact, phone=@phone, email=@email, notes=@notes, active=1 WHERE id=@id')
        .run({ ...p, id: existing.id });
      id = existing.id;
    } else {
      id = db.prepare('INSERT INTO parties (type, name, contact, phone, email, notes) VALUES (@type, @name, @contact, @phone, @email, @notes)')
        .run(p).lastInsertRowid;
    }
    logActivity(req.session.user, 'party.create', `${p.type}: ${p.name}`);
    res.status(201).json(db.prepare('SELECT * FROM parties WHERE id = ?').get(id));
  }));

  // Renaming also updates the name shown on past movements, so history stays consistent.
  app.put('/api/parties/:id', wrap((req, res) => {
    const before = db.prepare('SELECT * FROM parties WHERE id = ? AND active = 1').get(int(req.params.id));
    if (!before) throw httpError(404, 'Not found');
    const p = { ...partyFields({ ...req.body, type: before.type }), id: before.id };
    db.transaction(() => {
      db.prepare('UPDATE parties SET name=@name, contact=@contact, phone=@phone, email=@email, notes=@notes WHERE id=@id').run(p);
      if (p.name !== before.name) db.prepare('UPDATE movements SET party = ? WHERE party_id = ?').run(p.name, p.id);
    })();
    logActivity(req.session.user, 'party.update', p.name === before.name ? p.name : `${before.name} → ${p.name}`);
    res.json(db.prepare('SELECT * FROM parties WHERE id = ?').get(p.id));
  }));

  // Merging fixes duplicates such as "CleanPro" and "Clean Pro": history moves to the one kept.
  app.post('/api/parties/:id/merge', requireAdmin, wrap((req, res) => {
    const from = db.prepare('SELECT * FROM parties WHERE id = ? AND active = 1').get(int(req.params.id));
    const into = db.prepare('SELECT * FROM parties WHERE id = ? AND active = 1').get(int(req.body.into));
    if (!from || !into) throw httpError(404, 'Not found');
    if (from.id === into.id || from.type !== into.type) throw httpError(400, 'Pick a different entry of the same type');
    db.transaction(() => {
      db.prepare('UPDATE movements SET party_id = ?, party = ? WHERE party_id = ?').run(into.id, into.name, from.id);
      db.prepare('UPDATE purchase_orders SET supplier_id = ? WHERE supplier_id = ?').run(into.id, from.id);
      db.prepare('DELETE FROM parties WHERE id = ?').run(from.id);
    })();
    logActivity(req.session.user, 'party.merge', `${from.name} merged into ${into.name}`);
    res.json({ ok: true });
  }));

  // Entries that have history are hidden (archived) instead of deleted.
  app.delete('/api/parties/:id', requireAdmin, wrap((req, res) => {
    const p = db.prepare('SELECT * FROM parties WHERE id = ? AND active = 1').get(int(req.params.id));
    if (!p) throw httpError(404, 'Not found');
    const used = db.prepare('SELECT 1 FROM movements WHERE party_id = ? UNION SELECT 1 FROM purchase_orders WHERE supplier_id = ? LIMIT 1')
      .get(p.id, p.id);
    if (used) db.prepare('UPDATE parties SET active = 0 WHERE id = ?').run(p.id);
    else db.prepare('DELETE FROM parties WHERE id = ?').run(p.id);
    logActivity(req.session.user, used ? 'party.archive' : 'party.delete', `${p.type}: ${p.name}`);
    res.json({ ok: true, archived: !!used });
  }));
};
