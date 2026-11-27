// Sends email through the SMTP account set on the Admin page (Gmail, Outlook, your host's mail server…).
const nodemailer = require('nodemailer');
const { db, getSetting, setSetting } = require('../db');

const KEYS = ['smtp_host', 'smtp_port', 'smtp_security', 'smtp_user', 'smtp_pass', 'smtp_from', 'alert_to',
  'alert_low_stock', 'alert_digest', 'alert_digest_hour'];

const DEFAULTS = {
  smtp_host: '', smtp_port: '587', smtp_security: 'starttls', smtp_user: '', smtp_pass: '', smtp_from: '', alert_to: '',
  alert_low_stock: '1', alert_digest: '0', alert_digest_hour: '8',
};

function readConfig() {
  return Object.fromEntries(KEYS.map((k) => [k, getSetting(k, () => DEFAULTS[k])]));
}

// Settings as shown in the Admin page: the password is never sent back, only whether one is saved.
function publicConfig() {
  const c = readConfig();
  return { ...c, smtp_pass: '', smtp_pass_set: Boolean(c.smtp_pass), configured: isConfigured(c) };
}

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const parseRecipients = (text) => [...new Set(String(text || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean))];

function isConfigured(c = readConfig()) {
  return Boolean(c.smtp_host && c.smtp_from && parseRecipients(c.alert_to).length);
}

// Validates and saves settings from the Admin page. An empty password keeps the saved one.
function saveConfig(body) {
  const c = readConfig();
  const next = { ...c };
  const text = (k, max) => { if (body[k] !== undefined) next[k] = String(body[k] ?? '').trim().slice(0, max); };
  text('smtp_host', 120);
  text('smtp_user', 120);
  text('smtp_from', 160);
  text('alert_to', 500);
  if (body.smtp_port !== undefined) {
    const port = Number(body.smtp_port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('Port must be a number like 587 or 465'), { status: 400 });
    next.smtp_port = String(port);
  }
  if (body.smtp_security !== undefined) {
    if (!['ssl', 'starttls', 'none'].includes(body.smtp_security)) throw Object.assign(new Error('Unknown security option'), { status: 400 });
    next.smtp_security = body.smtp_security;
  }
  if (body.smtp_pass) next.smtp_pass = String(body.smtp_pass).slice(0, 200);
  if (body.clear_password) next.smtp_pass = '';
  if (body.alert_low_stock !== undefined) next.alert_low_stock = body.alert_low_stock ? '1' : '0';
  if (body.alert_digest !== undefined) next.alert_digest = body.alert_digest ? '1' : '0';
  if (body.alert_digest_hour !== undefined) {
    const h = Number(body.alert_digest_hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw Object.assign(new Error('Summary hour must be 0–23'), { status: 400 });
    next.alert_digest_hour = String(h);
  }
  if (next.smtp_host && !/^[A-Za-z0-9.-]+$/.test(next.smtp_host)) throw Object.assign(new Error('Mail server should look like smtp.gmail.com'), { status: 400 });
  const fromAddress = (next.smtp_from.match(/<([^>]+)>/)?.[1] || next.smtp_from).trim();
  if (next.smtp_from && !EMAIL_RE.test(fromAddress)) throw Object.assign(new Error('"From" must be an email address, e.g. alerts@yourshop.co.ke'), { status: 400 });
  const bad = parseRecipients(next.alert_to).filter((e) => !EMAIL_RE.test(e));
  if (bad.length) throw Object.assign(new Error(`Not a valid email: ${bad.join(', ')}`), { status: 400 });

  for (const k of KEYS) if (next[k] !== c[k]) setSetting(k, next[k]);
  return publicConfig();
}

function transport(c = readConfig()) {
  return nodemailer.createTransport({
    host: c.smtp_host,
    port: Number(c.smtp_port) || 587,
    secure: c.smtp_security === 'ssl',
    requireTLS: c.smtp_security === 'starttls',
    ignoreTLS: c.smtp_security === 'none',
    auth: c.smtp_user ? { user: c.smtp_user, pass: c.smtp_pass } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
}

const logEmail = (kind, to, subject, status, error = '') =>
  db.prepare('INSERT INTO email_log (kind, recipients, subject, status, error) VALUES (?, ?, ?, ?, ?)')
    .run(kind, to.join(', '), subject, status, String(error).slice(0, 500));

// Sends one email to the alert recipients. Throws with a readable message on failure (and logs it).
async function send({ kind, subject, text, html, to }) {
  const c = readConfig();
  if (!isConfigured(c)) throw Object.assign(new Error('Email is not set up yet (mail server, From address and recipients are required).'), { status: 400 });
  const recipients = to ? parseRecipients(to) : parseRecipients(c.alert_to);
  try {
    await transport(c).sendMail({ from: c.smtp_from, to: recipients, subject, text, html });
    logEmail(kind, recipients, subject, 'sent');
  } catch (e) {
    const message = friendlyError(e);
    logEmail(kind, recipients, subject, 'failed', message);
    throw Object.assign(new Error(message), { status: 502 });
  }
}

function friendlyError(e) {
  const m = e?.message || String(e);
  if (e?.code === 'EAUTH') return `The mail server rejected the username or password. (${m}) For Gmail, use an "App password".`;
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS'].includes(e?.code)) return `Could not connect to the mail server — check the server name, port and security. (${m})`;
  return m;
}

module.exports = { readConfig, publicConfig, saveConfig, isConfigured, send, parseRecipients };
