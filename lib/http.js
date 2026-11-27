// Shared helpers for route handlers.
const { db, httpError } = require('../db');

// Runs a sync handler and forwards thrown errors to Express.
const wrap = (fn) => (req, res, next) => { try { fn(req, res, next); } catch (e) { next(e); } };

// Trimmed, length-capped string from user input.
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

const int = (v, fallback = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

// Re-reads the user on each request so deleted accounts and role changes take effect at once.
function requireAuth(req, res, next) {
  const current = req.session.user &&
    db.prepare("SELECT id, username, role FROM users WHERE id = ? AND status = 'active'").get(req.session.user.id);
  if (!current) return res.status(401).json({ error: 'Please log in' });
  req.session.user = current;
  next();
}

function requireAdmin(req, res, next) {
  if (req.session.user?.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

// The browser sends its UTC offset in minutes (?tz=180), so dates are grouped and filtered by local day.
// Returns an SQLite date modifier such as '+180 minutes'.
function tzModifier(req) {
  const minutes = Math.max(-840, Math.min(840, int(req.query.tz, 0)));
  return `${minutes >= 0 ? '+' : ''}${minutes} minutes`;
}

// Validates a YYYY-MM-DD date string (or returns '' when empty).
function dateParam(v) {
  const s = str(v, 10);
  if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw httpError(400, 'Dates must be YYYY-MM-DD');
  return s;
}

function csv(res, filename, header, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + [header.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n'));
}

module.exports = { wrap, str, int, requireAuth, requireAdmin, tzModifier, dateParam, csv, httpError };
