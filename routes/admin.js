// Admin-only: users, settings, activity log, backups.
const { db, hashPassword, getSetting, setSetting, logActivity } = require('../db');
const { wrap, str, int, requireAdmin, httpError } = require('../lib/http');
const { validateNewUser } = require('./auth');

// Currencies offered in Settings (ISO 4217 codes understood by every browser).
const CURRENCIES = ['USD', 'EUR', 'GBP', 'KES', 'UGX', 'TZS', 'RWF', 'ETB', 'NGN', 'GHS', 'ZAR', 'EGP', 'MAD', 'XOF', 'XAF',
  'AED', 'SAR', 'QAR', 'INR', 'PKR', 'BDT', 'LKR', 'NPR', 'CNY', 'JPY', 'KRW', 'PHP', 'IDR', 'MYR', 'SGD', 'THB', 'VND',
  'AUD', 'NZD', 'CAD', 'MXN', 'BRL', 'ARS', 'CLP', 'COP', 'PEN', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON',
  'TRY', 'RUB', 'UAH', 'ILS'];

module.exports = (app, { sessionStore, backups }) => {
  // ---------- users ----------
  // The main admin (the first admin account, normally "admin") owns the system: it can't be deleted,
  // demoted or have its password reset by anyone else, and only it can give or take away admin rights.
  const ownerId = () => Number(getSetting('owner_user_id',
    () => String(db.prepare("SELECT MIN(id) FROM users WHERE role = 'admin'").pluck().get() ?? 1)));
  const isOwner = (req) => req.session.user.id === ownerId();

  function findUser(id) {
    const user = db.prepare('SELECT id, username, role, status FROM users WHERE id = ?').get(int(id));
    if (!user) throw httpError(404, 'User not found');
    return user;
  }

  app.get('/api/users', requireAdmin, (req, res) => {
    const owner = ownerId();
    res.json(db.prepare('SELECT id, username, role, status, created_at FROM users ORDER BY username').all()
      .map((u) => ({ ...u, is_owner: u.id === owner }))
      .sort((a, b) => b.is_owner - a.is_owner));
  });

  // Accounts made here are active straight away (no approval step).
  app.post('/api/users', requireAdmin, wrap((req, res) => {
    const username = str(req.body.username, 40);
    const password = String(req.body.password ?? '');
    const role = req.body.role === 'admin' ? 'admin' : 'staff';
    if (role === 'admin' && !isOwner(req)) throw httpError(403, 'Only the main admin can create admin accounts');
    validateNewUser(username, password);
    const id = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, hashPassword(password), role).lastInsertRowid;
    logActivity(req.session.user, 'user.create', `${username} (${role})`);
    res.status(201).json({ id, username, role });
  }));

  app.post('/api/users/:id/approve', requireAdmin, wrap((req, res) => {
    const user = findUser(req.params.id);
    if (user.status !== 'pending') throw httpError(400, 'This account is not waiting for approval');
    db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(user.id);
    logActivity(req.session.user, 'user.approve', user.username);
    res.json({ ok: true });
  }));

  app.put('/api/users/:id/role', requireAdmin, wrap((req, res) => {
    const user = findUser(req.params.id);
    const role = req.body.role === 'admin' ? 'admin' : 'staff';
    if (user.id === ownerId()) throw httpError(400, 'The main admin is always an admin');
    if (user.id === req.session.user.id && role !== 'admin') throw httpError(400, "You can't remove your own admin role");
    if ((role === 'admin' || user.role === 'admin') && role !== user.role && !isOwner(req)) {
      throw httpError(403, 'Only the main admin can give or remove admin rights');
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
    if (role !== user.role) logActivity(req.session.user, 'user.role', `${user.username}: ${user.role} → ${role}`);
    res.json({ ...user, role });
  }));

  // Admin sets a new password for someone else; they are logged out everywhere.
  app.post('/api/users/:id/password', requireAdmin, wrap((req, res) => {
    const user = findUser(req.params.id);
    if (user.id === ownerId() && !isOwner(req)) throw httpError(403, "Only the main admin can change the main admin's password");
    const password = String(req.body.password ?? '');
    if (password.length < 6) throw httpError(400, 'Password must be at least 6 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
    if (user.id !== req.session.user.id) sessionStore.destroyUser(user.id);
    logActivity(req.session.user, 'user.password', `Reset password for ${user.username}`);
    res.json({ ok: true });
  }));

  app.delete('/api/users/:id', requireAdmin, wrap((req, res) => {
    const user = findUser(req.params.id);
    if (user.id === ownerId()) throw httpError(400, 'The main admin account cannot be deleted');
    if (user.id === req.session.user.id) throw httpError(400, "You can't delete your own account");
    if (user.role === 'admin' && !isOwner(req)) throw httpError(403, 'Only the main admin can delete admin accounts');
    db.transaction(() => {
      // Keep their history (movements, orders, sales) but without the link to the deleted account
      db.prepare('UPDATE movements SET user_id = NULL WHERE user_id = ?').run(user.id);
      db.prepare('UPDATE purchase_orders SET created_by = NULL WHERE created_by = ?').run(user.id);
      db.prepare('UPDATE sales SET created_by = NULL WHERE created_by = ?').run(user.id);
      db.prepare('UPDATE sale_payments SET created_by = NULL WHERE created_by = ?').run(user.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    })();
    sessionStore.destroyUser(user.id);
    logActivity(req.session.user, user.status === 'pending' ? 'user.reject' : 'user.delete', user.username);
    res.json({ ok: true });
  }));

  // ---------- settings ----------
  app.get('/api/currencies', (req, res) => res.json(CURRENCIES));

  app.put('/api/settings', requireAdmin, wrap((req, res) => {
    const changes = [];
    if (req.body.currency !== undefined) {
      const c = str(req.body.currency, 3).toUpperCase();
      if (!CURRENCIES.includes(c)) throw httpError(400, 'Unknown currency');
      setSetting('currency', c);
      changes.push(`currency ${c}`);
    }
    if (req.body.company_name !== undefined) {
      const n = str(req.body.company_name, 80);
      if (!n) throw httpError(400, 'Company name cannot be empty');
      setSetting('company_name', n);
      changes.push(`company name "${n}"`);
    }
    // Invoice details
    const textFields = { company_address: 200, company_phone: 40, company_email: 120, company_pin: 20, invoice_footer: 300 };
    for (const [key, max] of Object.entries(textFields)) {
      if (req.body[key] !== undefined) {
        setSetting(key, str(req.body[key], max));
        changes.push(key.replace('_', ' '));
      }
    }
    if (req.body.invoice_prefix !== undefined) {
      const p = str(req.body.invoice_prefix, 8).toUpperCase();
      if (!/^[A-Z0-9]{1,8}$/.test(p)) throw httpError(400, 'Invoice prefix must be 1–8 letters or numbers');
      setSetting('invoice_prefix', p);
      changes.push(`invoice prefix ${p}`);
    }
    if (req.body.vat_rate !== undefined) {
      const rate = Number(req.body.vat_rate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 50) throw httpError(400, 'VAT rate must be between 0 and 50');
      setSetting('vat_rate', String(rate));
      changes.push(`VAT ${rate}%`);
    }
    if (req.body.vat_inclusive !== undefined) {
      setSetting('vat_inclusive', req.body.vat_inclusive ? '1' : '0');
      changes.push(`prices ${req.body.vat_inclusive ? 'include' : 'exclude'} VAT`);
    }
    if (changes.length) logActivity(req.session.user, 'settings.update', changes.join(', '));
    res.json({ ok: true });
  }));

  // ---------- activity log ----------
  app.get('/api/activity', requireAdmin, wrap((req, res) => {
    const pageSize = 50;
    const where = [];
    const args = [];
    if (req.query.q) {
      const like = `%${str(req.query.q)}%`;
      where.push('(username LIKE ? OR action LIKE ? OR details LIKE ?)');
      args.push(like, like, like);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) FROM activity_log ${w}`).pluck().get(...args);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(int(req.query.page, 1), 1), pages);
    const rows = db.prepare(`SELECT * FROM activity_log ${w} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (page - 1) * pageSize);
    res.json({ rows, page, pages, total });
  }));

  // ---------- backups ----------
  app.get('/api/backups', requireAdmin, wrap((req, res) => {
    res.json({ dir: backups.BACKUP_DIR, keep: backups.KEEP, files: backups.list() });
  }));

  app.post('/api/backups', requireAdmin, async (req, res, next) => {
    try {
      const b = await backups.run('manual');
      logActivity(req.session.user, 'backup.create', b.name);
      res.status(201).json(b);
    } catch (e) { next(e); }
  });

  app.get('/api/backups/:name', requireAdmin, wrap((req, res) => {
    res.download(backups.pathFor(req.params.name), req.params.name);
  }));
};
