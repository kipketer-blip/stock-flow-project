// express-session store that keeps logins in the SQLite database, so they survive restarts.
const session = require('express-session');

const DEFAULT_TTL = 8 * 60 * 60 * 1000;

class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.stmts = {
      get: db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?'),
      set: db.prepare('INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires'),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      destroyUser: db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.user.id') = ?"),
      prune: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    };
    this.prune();
    setInterval(() => this.prune(), 60 * 60 * 1000).unref();
  }

  expiry(sess) {
    return sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + DEFAULT_TTL;
  }

  get(sid, cb) {
    try {
      const row = this.stmts.get.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb = () => {}) {
    try { this.stmts.set.run(sid, JSON.stringify(sess), this.expiry(sess)); cb(null); } catch (e) { cb(e); }
  }

  touch(sid, sess, cb = () => {}) {
    try { this.stmts.touch.run(this.expiry(sess), sid); cb(null); } catch (e) { cb(e); }
  }

  destroy(sid, cb = () => {}) {
    try { this.stmts.destroy.run(sid); cb(null); } catch (e) { cb(e); }
  }

  // Log a user out everywhere (after a password reset, role change or deletion).
  destroyUser(userId) {
    this.stmts.destroyUser.run(userId);
  }

  prune() {
    this.stmts.prune.run(Date.now());
  }
}

module.exports = SqliteStore;
