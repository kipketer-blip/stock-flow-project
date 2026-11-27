// Email alerts: one email when items drop to their reorder level (grouped, at most once a day per item),
// and an optional daily summary of everything that needs attention.
const { db, getSetting, setSetting } = require('../db');
const mailer = require('./mailer');

const GROUP_DELAY_MS = 30 * 1000; // wait a little so several items sold together arrive in one email
const REPEAT_HOURS = 24;

const pending = new Map();
let timer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const company = () => getSetting('company_name', () => 'StockFlow Pro');

const table = (rows) => `<table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">
  <tr style="background:#f3f4f6"><th align="left">Product</th><th align="left">SKU</th><th align="right">In stock</th><th align="right">Reorder at</th></tr>
  ${rows.map((p) => `<tr style="border-top:1px solid #e5e7eb"><td>${esc(p.name)}</td><td>${esc(p.sku)}</td>
    <td align="right" style="color:#b91c1c"><b>${p.quantity} ${esc(p.unit)}</b></td><td align="right">${p.reorder_level}</td></tr>`).join('')}
</table>`;

// Called after a movement or sale takes a product down to its reorder level.
function lowStock(product) {
  try {
    const c = mailer.readConfig();
    if (c.alert_low_stock !== '1' || !mailer.isConfigured(c)) return;
    const last = db.prepare('SELECT sent_at FROM alert_log WHERE product_id = ?').pluck().get(product.id);
    if (last && Date.now() - Date.parse(`${last.replace(' ', 'T')}Z`) < REPEAT_HOURS * 3600 * 1000) return;
    pending.set(product.id, product);
    if (!timer) {
      timer = setTimeout(flushLowStock, GROUP_DELAY_MS);
      timer.unref?.();
    }
  } catch (e) {
    console.error('Low-stock alert failed:', e.message);
  }
}

async function flushLowStock() {
  timer = null;
  const items = [...pending.values()];
  pending.clear();
  if (!items.length) return;
  // Use the latest stock numbers
  const fresh = items.map((p) => db.prepare('SELECT id, sku, name, unit, quantity, reorder_level FROM products WHERE id = ?').get(p.id)).filter(Boolean);
  const subject = fresh.length === 1
    ? `Low stock: ${fresh[0].name} (${fresh[0].quantity} ${fresh[0].unit} left)`
    : `Low stock: ${fresh.length} items need reordering`;
  try {
    await mailer.send({
      kind: 'low_stock',
      subject: `[${company()}] ${subject}`,
      text: `These items have reached their reorder level:\n\n${fresh.map((p) => `- ${p.name} (${p.sku}): ${p.quantity} ${p.unit} left, reorder at ${p.reorder_level}`).join('\n')}\n`,
      html: `<p>These items have reached their reorder level:</p>${table(fresh)}<p style="color:#6b7280;font-size:12px">Sent by ${esc(company())} inventory.</p>`,
    });
    const mark = db.prepare("INSERT INTO alert_log (product_id, sent_at) VALUES (?, datetime('now')) ON CONFLICT(product_id) DO UPDATE SET sent_at = excluded.sent_at");
    fresh.forEach((p) => mark.run(p.id));
  } catch (e) {
    console.error('Low-stock email not sent:', e.message);
  }
}

// Builds the daily summary (also used for "Send summary now").
function buildDigest() {
  const low = db.prepare(`SELECT id, sku, name, unit, quantity, reorder_level FROM products
                          WHERE active = 1 AND quantity <= reorder_level ORDER BY quantity - reorder_level`).all();
  const pos = db.prepare(`SELECT po.number, s.name AS supplier, po.expected_date FROM purchase_orders po JOIN parties s ON s.id = po.supplier_id
                          WHERE po.status IN ('open','partial') AND po.expected_date IS NOT NULL AND po.expected_date < date('now','localtime')`).all();
  const invoices = db.prepare(`SELECT number, customer_name, due_date, total - amount_paid AS balance FROM sales
                               WHERE status IN ('unpaid','partial') AND due_date IS NOT NULL AND due_date < date('now','localtime')`).all();
  const yesterday = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM sales
                                WHERE status <> 'void' AND date(created_at,'localtime') = date('now','localtime','-1 day')`).get();
  const currency = getSetting('currency', () => 'USD');
  const money = (n) => `${currency} ${Number(n).toFixed(2)}`;

  const html = `
    <h2 style="font-family:Arial,sans-serif">${esc(company())} — daily summary</h2>
    <p style="font-family:Arial,sans-serif">Yesterday's sales: <b>${yesterday.n}</b> invoice(s), <b>${money(yesterday.total)}</b>.</p>
    <h3 style="font-family:Arial,sans-serif">Low or out of stock (${low.length})</h3>
    ${low.length ? table(low) : '<p>All items are above their reorder level.</p>'}
    ${pos.length ? `<h3 style="font-family:Arial,sans-serif">Overdue purchase orders (${pos.length})</h3><ul>${pos.map((p) => `<li>${esc(p.number)} from ${esc(p.supplier)}, expected ${esc(p.expected_date)}</li>`).join('')}</ul>` : ''}
    ${invoices.length ? `<h3 style="font-family:Arial,sans-serif">Overdue invoices (${invoices.length})</h3><ul>${invoices.map((i) => `<li>${esc(i.number)} — ${esc(i.customer_name)}: ${money(i.balance)} due ${esc(i.due_date)}</li>`).join('')}</ul>` : ''}`;
  const text = [
    `${company()} — daily summary`, `Yesterday's sales: ${yesterday.n} invoice(s), ${money(yesterday.total)}`, '',
    `Low or out of stock (${low.length}):`, ...low.map((p) => `- ${p.name} (${p.sku}): ${p.quantity} ${p.unit}, reorder at ${p.reorder_level}`),
    ...(pos.length ? ['', 'Overdue purchase orders:', ...pos.map((p) => `- ${p.number} from ${p.supplier}, expected ${p.expected_date}`)] : []),
    ...(invoices.length ? ['', 'Overdue invoices:', ...invoices.map((i) => `- ${i.number} ${i.customer_name}: ${money(i.balance)} due ${i.due_date}`)] : []),
  ].join('\n');
  return { subject: `[${company()}] Daily summary: ${low.length} low-stock item(s)`, html, text };
}

async function sendDigest() {
  const d = buildDigest();
  await mailer.send({ kind: 'daily_summary', ...d });
}

// Checks every 10 minutes whether today's summary is due (server's local time).
function schedule() {
  const check = async () => {
    try {
      const c = mailer.readConfig();
      if (c.alert_digest !== '1' || !mailer.isConfigured(c)) return;
      const now = new Date();
      const today = now.toLocaleDateString('en-CA');
      if (now.getHours() < Number(c.alert_digest_hour)) return;
      if (getSetting('last_digest_date', () => '') === today) return;
      setSetting('last_digest_date', today);
      await sendDigest();
    } catch (e) {
      console.error('Daily summary not sent:', e.message);
    }
  };
  setInterval(check, 10 * 60 * 1000).unref();
  check();
}

module.exports = { lowStock, flushLowStock, sendDigest, buildDigest, schedule };
