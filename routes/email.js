// Admin: email alert settings, test email, send summary now, and the log of sent emails.
const { db, logActivity } = require('../db');
const { wrap, requireAdmin } = require('../lib/http');
const mailer = require('../lib/mailer');
const alerts = require('../lib/alerts');

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = (app) => {
  app.get('/api/email-settings', requireAdmin, wrap((req, res) => {
    res.json({
      ...mailer.publicConfig(),
      log: db.prepare('SELECT * FROM email_log ORDER BY id DESC LIMIT 20').all(),
    });
  }));

  app.put('/api/email-settings', requireAdmin, wrap((req, res) => {
    const saved = mailer.saveConfig(req.body);
    logActivity(req.session.user, 'settings.email', `Email alerts ${saved.configured ? 'configured' : 'updated (not complete)'}`);
    res.json(saved);
  }));

  // { to } optional: defaults to the alert recipients
  app.post('/api/email-settings/test', requireAdmin, asyncRoute(async (req, res) => {
    await mailer.send({
      kind: 'test',
      to: req.body.to,
      subject: 'StockFlow Pro test email',
      text: 'Your email alerts are working. You will get low-stock alerts at this address.',
      html: '<p>Your email alerts are working. You will get low-stock alerts at this address.</p>',
    });
    res.json({ ok: true, message: 'Test email sent. Check the inbox (and spam folder).' });
  }));

  app.post('/api/email-settings/summary', requireAdmin, asyncRoute(async (req, res) => {
    await alerts.sendDigest();
    res.json({ ok: true, message: 'Summary sent.' });
  }));
};
