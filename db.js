const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'inventory.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','staff')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sku           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT '',
  unit          TEXT NOT NULL DEFAULT 'pcs',
  unit_cost     REAL NOT NULL DEFAULT 0,
  reorder_level INTEGER NOT NULL DEFAULT 0,
  quantity      INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Suppliers and customers / departments
CREATE TABLE IF NOT EXISTS parties (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL CHECK (type IN ('supplier','customer')),
  name       TEXT NOT NULL COLLATE NOCASE,
  contact    TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (type, name)
);

CREATE TABLE IF NOT EXISTS movements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id),
  type          TEXT NOT NULL CHECK (type IN ('IN','OUT','ADJUST')),
  quantity      INTEGER NOT NULL,          -- signed change applied to stock
  balance_after INTEGER NOT NULL,
  party         TEXT NOT NULL DEFAULT '',  -- supplier (IN) / customer (OUT) name, or reason (ADJUST)
  reference     TEXT NOT NULL DEFAULT '',  -- PO / invoice / delivery note no.
  note          TEXT NOT NULL DEFAULT '',
  user_id       INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_movements_product ON movements(product_id);
CREATE INDEX IF NOT EXISTS idx_movements_created ON movements(created_at);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  number        TEXT NOT NULL UNIQUE,
  supplier_id   INTEGER NOT NULL REFERENCES parties(id),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','received','cancelled')),
  expected_date TEXT,
  note          TEXT NOT NULL DEFAULT '',
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS po_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id        INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  qty_ordered  INTEGER NOT NULL CHECK (qty_ordered > 0),
  qty_received INTEGER NOT NULL DEFAULT 0,
  unit_cost    REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS activity_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  username   TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,
  details    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  data    TEXT NOT NULL,
  expires INTEGER NOT NULL
);

-- Shops / warehouses / stores where stock is kept
CREATE TABLE IF NOT EXISTS locations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  address    TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Units of each product at each location. products.quantity is always the total of these.
CREATE TABLE IF NOT EXISTS stock_levels (
  product_id  INTEGER NOT NULL REFERENCES products(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  quantity    INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  PRIMARY KEY (product_id, location_id)
);

-- Sales / invoices. Selling records a stock-out for every line.
CREATE TABLE IF NOT EXISTS sales (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  number         TEXT NOT NULL UNIQUE,
  customer_id    INTEGER REFERENCES parties(id),
  customer_name  TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  customer_pin   TEXT NOT NULL DEFAULT '',
  location_id    INTEGER NOT NULL REFERENCES locations(id),
  status         TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','partial','paid','void')),
  subtotal       REAL NOT NULL DEFAULT 0,
  discount       REAL NOT NULL DEFAULT 0,
  vat_rate       REAL NOT NULL DEFAULT 0,
  vat_inclusive  INTEGER NOT NULL DEFAULT 1,
  vat            REAL NOT NULL DEFAULT 0,
  total          REAL NOT NULL DEFAULT 0,
  amount_paid    REAL NOT NULL DEFAULT 0,
  cost_total     REAL NOT NULL DEFAULT 0,
  due_date       TEXT,
  notes          TEXT NOT NULL DEFAULT '',
  void_reason    TEXT NOT NULL DEFAULT '',
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);

CREATE TABLE IF NOT EXISTS sale_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id    INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  unit_price REAL NOT NULL DEFAULT 0,
  unit_cost  REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sale_payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id    INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  amount     REAL NOT NULL CHECK (amount > 0),
  method     TEXT NOT NULL CHECK (method IN ('cash','mpesa','card','bank','cheque','other')),
  reference  TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Emails sent (alerts, daily summaries, tests)
CREATE TABLE IF NOT EXISTS email_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  recipients TEXT NOT NULL DEFAULT '',
  subject    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL CHECK (status IN ('sent','failed')),
  error      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- When each product last triggered a low-stock email (to avoid repeats)
CREATE TABLE IF NOT EXISTS alert_log (
  product_id INTEGER PRIMARY KEY REFERENCES products(id),
  sent_at    TEXT NOT NULL
);
`);

// ---------- migrations for databases created by earlier versions ----------
const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

// Accounts created from the sign-up form start as 'pending' until an admin approves them.
if (!hasColumn('users', 'status')) {
  db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending'))");
}
// Cost per unit at the time of the movement, for value reports.
if (!hasColumn('movements', 'unit_cost')) {
  db.exec('ALTER TABLE movements ADD COLUMN unit_cost REAL NOT NULL DEFAULT 0');
  db.exec('UPDATE movements SET unit_cost = (SELECT unit_cost FROM products WHERE products.id = movements.product_id)');
}
// Link movements to the supplier / customer list; build the list from names typed so far.
if (!hasColumn('movements', 'party_id')) {
  db.exec('ALTER TABLE movements ADD COLUMN party_id INTEGER REFERENCES parties(id)');
  db.transaction(() => {
    const rows = db.prepare("SELECT DISTINCT type, party FROM movements WHERE party <> '' AND type IN ('IN','OUT')").all();
    for (const r of rows) {
      const id = resolveParty(r.party, r.type === 'IN' ? 'supplier' : 'customer').id;
      db.prepare('UPDATE movements SET party_id = ? WHERE type = ? AND party = ?').run(id, r.type, r.party);
    }
  })();
}
db.exec('CREATE INDEX IF NOT EXISTS idx_movements_party ON movements(party_id)');

// Locations: make sure there is a default one ("Main Store") that existing stock belongs to.
if (!db.prepare('SELECT 1 FROM locations WHERE is_default = 1').get()) {
  const any = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 1').get();
  if (any) db.prepare('UPDATE locations SET is_default = 1 WHERE id = ?').run(any.id);
  else db.prepare("INSERT INTO locations (name, is_default) VALUES ('Main Store', 1)").run();
}
const DEFAULT_LOCATION = () => db.prepare('SELECT id FROM locations WHERE is_default = 1').pluck().get();

// Movements gain a location, a per-location balance and a TRANSFER type. SQLite can't change a CHECK
// constraint in place, so the table is rebuilt once (all existing rows are kept, at the default location).
const movementsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'movements'").pluck().get();
if (!movementsSql.includes('TRANSFER')) {
  const loc = DEFAULT_LOCATION();
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`CREATE TABLE movements_v4 (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id             INTEGER NOT NULL REFERENCES products(id),
      type                   TEXT NOT NULL CHECK (type IN ('IN','OUT','ADJUST','TRANSFER')),
      quantity               INTEGER NOT NULL,          -- signed change at this location
      balance_after          INTEGER NOT NULL,          -- product total after the change
      location_id            INTEGER REFERENCES locations(id),
      location_balance_after INTEGER NOT NULL DEFAULT 0, -- units left at this location
      transfer_id            INTEGER,                    -- links the two halves of a transfer
      party                  TEXT NOT NULL DEFAULT '',
      party_id               INTEGER REFERENCES parties(id),
      reference              TEXT NOT NULL DEFAULT '',
      note                   TEXT NOT NULL DEFAULT '',
      unit_cost              REAL NOT NULL DEFAULT 0,
      user_id                INTEGER REFERENCES users(id),
      created_at             TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.prepare(`INSERT INTO movements_v4 (id, product_id, type, quantity, balance_after, location_id, location_balance_after,
                  party, party_id, reference, note, unit_cost, user_id, created_at)
                SELECT id, product_id, type, quantity, balance_after, ?, balance_after,
                  party, party_id, reference, note, unit_cost, user_id, created_at FROM movements`).run(loc);
    db.exec('DROP TABLE movements');
    db.exec('ALTER TABLE movements_v4 RENAME TO movements');
  })();
  db.pragma('foreign_keys = ON');
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_movements_product ON movements(product_id);
         CREATE INDEX IF NOT EXISTS idx_movements_created ON movements(created_at);
         CREATE INDEX IF NOT EXISTS idx_movements_party ON movements(party_id);
         CREATE INDEX IF NOT EXISTS idx_movements_location ON movements(location_id);`);

// Every product has a stock row per location it holds stock in; existing stock goes to the default location.
db.prepare(`INSERT INTO stock_levels (product_id, location_id, quantity)
            SELECT p.id, ?, p.quantity FROM products p
            WHERE NOT EXISTS (SELECT 1 FROM stock_levels s WHERE s.product_id = p.id)`).run(DEFAULT_LOCATION());

// Selling price for invoices (0 = not set yet).
if (!hasColumn('products', 'sell_price')) db.exec('ALTER TABLE products ADD COLUMN sell_price REAL NOT NULL DEFAULT 0');
// Purchase orders are received into a location.
if (!hasColumn('purchase_orders', 'location_id')) {
  db.exec('ALTER TABLE purchase_orders ADD COLUMN location_id INTEGER REFERENCES locations(id)');
  db.prepare('UPDATE purchase_orders SET location_id = ?').run(DEFAULT_LOCATION());
}

// ---------- helpers ----------
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// A stored setting, created with `makeDefault()` the first time it is asked for.
function getSetting(key, makeDefault) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row) return row.value;
  const value = makeDefault();
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
  return value;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === test.length && crypto.timingSafeEqual(known, test);
}

// Finds a supplier/customer by name (ignoring case), creating it if new. Returns null for a blank name.
function resolveParty(name, type) {
  const clean = String(name ?? '').trim().slice(0, 200);
  if (!clean) return null;
  const found = db.prepare('SELECT id, name, active FROM parties WHERE type = ? AND name = ?').get(type, clean);
  if (found) {
    if (!found.active) db.prepare('UPDATE parties SET active = 1 WHERE id = ?').run(found.id);
    return found;
  }
  const id = db.prepare('INSERT INTO parties (type, name) VALUES (?, ?)').run(type, clean).lastInsertRowid;
  return { id, name: clean };
}

function logActivity(user, action, details = '') {
  db.prepare('INSERT INTO activity_log (user_id, username, action, details) VALUES (?, ?, ?, ?)')
    .run(user?.id ?? null, user?.username ?? '', action, String(details).slice(0, 1000));
}

const defaultLocationId = DEFAULT_LOCATION;

// The location to use: the given active one, or the default when none is given.
function resolveLocation(locationId) {
  if (locationId === undefined || locationId === null || locationId === '') {
    return db.prepare('SELECT * FROM locations WHERE is_default = 1').get();
  }
  const loc = db.prepare('SELECT * FROM locations WHERE id = ? AND active = 1').get(Number(locationId));
  if (!loc) throw httpError(400, 'Choose an active location');
  return loc;
}

const levelAt = (productId, locationId) =>
  db.prepare('SELECT quantity FROM stock_levels WHERE product_id = ? AND location_id = ?').pluck().get(productId, locationId) ?? 0;

const setLevel = (productId, locationId, quantity) =>
  db.prepare(`INSERT INTO stock_levels (product_id, location_id, quantity) VALUES (?, ?, ?)
              ON CONFLICT(product_id, location_id) DO UPDATE SET quantity = excluded.quantity`).run(productId, locationId, quantity);

// Applies a stock movement atomically at one location. `quantity` is positive for IN/OUT and signed for ADJUST.
// partyType overrides who the party is (default: supplier for IN, customer for OUT).
// Returns { id, product, location, becameLow } — becameLow is true when this movement dropped the item
// (in total) to its reorder level.
const recordMovement = db.transaction(({
  productId, type, quantity, party = '', partyType, reference = '', note = '', userId = null, unitCost, locationId,
}) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product) throw httpError(404, 'Product not found');
  const location = resolveLocation(locationId);

  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty === 0) throw httpError(400, 'Quantity must be a non-zero whole number');
  if (type !== 'ADJUST' && qty < 0) throw httpError(400, 'Quantity must be positive');

  const change = type === 'OUT' ? -qty : qty;
  const here = levelAt(product.id, location.id);
  const hereAfter = here + change;
  if (hereAfter < 0) {
    throw httpError(400, `Not enough stock at ${location.name}: ${here} ${product.unit} of ${product.name} available`);
  }
  const balance = product.quantity + change;

  const pType = partyType || (type === 'IN' ? 'supplier' : 'customer');
  const partyRow = type === 'ADJUST' ? null : resolveParty(party, pType);
  const cost = unitCost != null ? Number(unitCost) : product.unit_cost;

  setLevel(product.id, location.id, hereAfter);
  db.prepare("UPDATE products SET quantity = ?, updated_at = datetime('now') WHERE id = ?").run(balance, product.id);
  const id = db.prepare(`INSERT INTO movements (product_id, type, quantity, balance_after, location_id, location_balance_after,
                           party, party_id, reference, note, user_id, unit_cost)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(product.id, type, change, balance, location.id, hereAfter, partyRow ? partyRow.name : String(party).trim(),
      partyRow?.id ?? null, reference, note, userId, cost).lastInsertRowid;

  const becameLow = product.quantity > product.reorder_level && balance <= product.reorder_level;
  return { id, product: { ...product, quantity: balance }, location, becameLow };
});

// Moves units between two locations. The product total does not change.
const transferStock = db.transaction(({ productId, fromId, toId, quantity, reference = '', note = '', userId = null }) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product) throw httpError(404, 'Product not found');
  const from = resolveLocation(fromId);
  const to = resolveLocation(toId);
  if (from.id === to.id) throw httpError(400, 'Choose two different locations');
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) throw httpError(400, 'Quantity must be a positive whole number');

  const fromQty = levelAt(product.id, from.id);
  if (fromQty < qty) throw httpError(400, `Not enough stock at ${from.name}: ${fromQty} ${product.unit} of ${product.name} available`);
  const toQty = levelAt(product.id, to.id) + qty;
  setLevel(product.id, from.id, fromQty - qty);
  setLevel(product.id, to.id, toQty);

  const insert = db.prepare(`INSERT INTO movements (product_id, type, quantity, balance_after, location_id, location_balance_after,
                               transfer_id, party, reference, note, user_id, unit_cost)
                             VALUES (?, 'TRANSFER', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const outId = insert.run(product.id, -qty, product.quantity, from.id, fromQty - qty, null, `To ${to.name}`, reference, note, userId, product.unit_cost).lastInsertRowid;
  const inId = insert.run(product.id, qty, product.quantity, to.id, toQty, outId, `From ${from.name}`, reference, note, userId, product.unit_cost).lastInsertRowid;
  db.prepare('UPDATE movements SET transfer_id = ? WHERE id = ?').run(outId, outId);
  return { outId, inId, product, from, to };
});

// ---------- first run: admin account and sample data ----------
function seed() {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;

  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const adminId = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('admin', ?, 'admin')")
    .run(hashPassword(adminPassword)).lastInsertRowid;

  const samples = [
    ['SKU-1001', 'A4 Copy Paper (500 sheets)', 'Stationery', 'ream', 4.5, 20, 6.5],
    ['SKU-1002', 'Ballpoint Pen, Blue', 'Stationery', 'box', 3.2, 10, 4.8],
    ['SKU-2001', 'USB-C Charging Cable 1m', 'Electronics', 'pcs', 6.0, 15, 9.99],
    ['SKU-2002', 'Wireless Mouse', 'Electronics', 'pcs', 12.75, 8, 19.5],
    ['SKU-3001', 'Hand Sanitizer 500ml', 'Cleaning', 'bottle', 2.9, 25, 4.5],
    ['SKU-3002', 'Microfiber Cloth (pack of 10)', 'Cleaning', 'pack', 7.4, 5, 11],
  ];
  const insert = db.prepare('INSERT INTO products (sku, name, category, unit, unit_cost, reorder_level, sell_price) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const ids = samples.map((s) => insert.run(...s).lastInsertRowid);

  const flows = [
    [0, 'IN', 120, 'Office Supplies Co.', 'PO-0001'], [1, 'IN', 40, 'Office Supplies Co.', 'PO-0001'],
    [2, 'IN', 60, 'TechSource Ltd', 'PO-0002'], [3, 'IN', 20, 'TechSource Ltd', 'PO-0002'],
    [4, 'IN', 50, 'CleanPro', 'PO-0003'], [5, 'IN', 12, 'CleanPro', 'PO-0003'],
    [0, 'OUT', 35, 'Accounts Dept', 'REQ-101'], [2, 'OUT', 48, 'IT Dept', 'REQ-102'],
    [3, 'OUT', 14, 'Sales Team', 'REQ-103'], [4, 'OUT', 30, 'Front Desk', 'REQ-104'],
    [5, 'OUT', 9, 'Facilities', 'REQ-105'], [1, 'OUT', 6, 'HR Dept', 'REQ-106'],
  ];
  for (const [i, type, quantity, party, reference] of flows) {
    recordMovement({ productId: ids[i], type, quantity, party, reference, note: 'Sample data', userId: adminId });
  }
}
seed();

module.exports = {
  db, httpError, getSetting, setSetting, hashPassword, verifyPassword, resolveParty, logActivity, recordMovement,
  transferStock, resolveLocation, defaultLocationId, levelAt,
};
