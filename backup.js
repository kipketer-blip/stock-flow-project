// Database backups: one automatic copy per day, plus on-demand copies from the Users page.
const fs = require('fs');
const path = require('path');
const { db, httpError } = require('./db');

const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, 'backups'));
const KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP, 10) || 14);
const DAY = 24 * 60 * 60 * 1000;
const NAME_RE = /^inventory-\d{8}-\d{6}-(auto|manual)\.db$/;

function list() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => NAME_RE.test(f))
    .map((name) => {
      const st = fs.statSync(path.join(BACKUP_DIR, name));
      return { name, size: st.size, created: st.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function pathFor(name) {
  if (!NAME_RE.test(name)) throw httpError(400, 'Invalid backup name');
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) throw httpError(404, 'Backup not found');
  return file;
}

let running = null;

// Copies the live database safely (SQLite online backup) and deletes the oldest copies beyond KEEP.
async function run(kind = 'auto') {
  if (running) return running;
  running = (async () => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const name = `inventory-${stamp}-${kind}.db`;
    await db.backup(path.join(BACKUP_DIR, name));
    for (const old of list().slice(KEEP)) fs.unlinkSync(path.join(BACKUP_DIR, old.name));
    console.log(`Backup saved: ${name}`);
    return list().find((b) => b.name === name);
  })();
  try { return await running; } finally { running = null; }
}

// Checks hourly and makes a backup when the newest one is more than a day old.
function schedule() {
  const check = () => {
    const latest = list()[0];
    if (!latest || Date.now() - new Date(latest.created).getTime() >= DAY) {
      run('auto').catch((e) => console.error('Backup failed:', e.message));
    }
  };
  check();
  setInterval(check, 60 * 60 * 1000).unref();
}

module.exports = { BACKUP_DIR, KEEP, list, pathFor, run, schedule };
