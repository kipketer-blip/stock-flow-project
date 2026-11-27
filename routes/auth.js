const { db, hashPassword, verifyPassword, logActivity } = require('../db');
const { wrap, str, requireAuth, httpError } = require('../lib/http');

function validateNewUser(username, password) {
  if (!/^[\w.-]{3,40}$/.test(username)) throw httpError(400, 'Username must be 3+ letters, numbers, . _ or -');
  if (password.length < 6) throw httpError(400, 'Password must be at least 6 characters');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw httpError(409, 'That username is already taken');
}

module.exports = (app) => {
  app.post('/api/login', wrap((req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(str(req.body.username));
    if (!user || !verifyPassword(String(req.body.password ?? ''), user.password_hash)) {
      throw httpError(401, 'Invalid username or password');
    }
    if (user.status !== 'active') throw httpError(403, 'This account is not active. Ask the admin to activate it.');
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Session error' });
      req.session.user = { id: user.id, username: user.username, role: user.role };
      res.json(req.session.user);
    });
  }));

  // Public sign-up is turned off: the main admin creates every account on the Admin page,
  // and those accounts can sign in straight away.
  app.post('/api/register', (req, res) => {
    res.status(403).json({ error: 'Accounts are created by the admin. Ask the admin for a username and password.' });
  });

  app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

  app.get('/api/me', requireAuth, (req, res) => res.json(req.session.user));

  app.post('/api/me/password', requireAuth, wrap((req, res) => {
    const { current, next: newPassword } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    if (!verifyPassword(String(current ?? ''), user.password_hash)) throw httpError(400, 'Current password is wrong');
    if (String(newPassword ?? '').length < 6) throw httpError(400, 'New password must be at least 6 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
    logActivity(req.session.user, 'user.password', 'Changed own password');
    res.json({ ok: true });
  }));
};

module.exports.validateNewUser = validateNewUser;
