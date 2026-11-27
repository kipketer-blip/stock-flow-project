const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { db, getSetting } = require('./db');
const SqliteStore = require('./session-store');
const backups = require('./backup');
const { requireAuth } = require('./lib/http');

const app = express();
const PORT = process.env.PORT || 3000;
const sessionStore = new SqliteStore(db);

app.use(express.json({ limit: '5mb' })); // large enough for CSV imports
app.use(session({
  // Generated once and kept in the database, so logins survive restarts.
  secret: process.env.SESSION_SECRET || getSetting('session_secret', () => crypto.randomBytes(32).toString('hex')),
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true, // stay logged in while active; log out after 8 hours idle
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'public')));
const barcodeLib = require.resolve('jsbarcode/dist/JsBarcode.all.min.js');
app.get('/vendor/jsbarcode.js', (req, res) => res.sendFile(barcodeLib));

// Public routes (login, sign-up), then everything else requires a signed-in user.
require('./routes/auth')(app, { sessionStore });
app.use('/api', requireAuth);
require('./routes/dashboard')(app);
require('./routes/products')(app);
require('./routes/movements')(app);
require('./routes/parties')(app);
require('./routes/purchase-orders')(app);
require('./routes/reports')(app);
require('./routes/locations')(app);
require('./routes/sales')(app);
require('./routes/email')(app);
require('./routes/admin')(app, { sessionStore, backups });

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
    return res.status(409).json({ error: err.message.includes('UNIQUE') ? 'That name or code already exists' : 'Invalid data' });
  }
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'File is too large' });
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
});

app.listen(PORT, () => {
  console.log(`StockFlow Pro running at http://localhost:${PORT}`);
  backups.schedule();
  require('./lib/alerts').schedule();
});
