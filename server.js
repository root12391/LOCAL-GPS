'use strict';
/**
 * Localizador antirrobo para TU teléfono.
 *  - Cuentas con verificación de correo (código de 6 dígitos)
 *  - Vinculación del teléfono con un código de un solo uso (el dueño lo instala a la vista)
 *  - Ubicación GPS + respaldo por IP cuando el GPS está apagado o denegado
 *  - Comandos remotos: localizar ahora, hacer sonar, modo perdido (mensaje + botón de llamar)
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) { /* opcional */ }

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const SMTP_URL = process.env.SMTP_URL || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Localizador <no-reply@localhost>';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

/* ------------------------------ almacenamiento ------------------------------ */
let db = { users: {}, sessions: {}, devices: {}, pairing: {}, locations: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (_) { /* primera vez */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) { console.error('No se pudo guardar:', e.message); }
  }, 150);
}

/* --------------------------------- utilidades -------------------------------- */
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
function safeEq(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const normEmail = (e) => {
  const v = String(e || '').trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(v) && v.length <= 254 ? v : null;
};
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const clientIp = (req) => String(req.ip || '').replace(/^::ffff:/, '');

const hits = new Map();
function limit(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length <= max;
}
const rl = (name, max, win) => (req, res, next) =>
  limit(name + ':' + clientIp(req), max, win) ? next() : res.status(429).json({ error: 'Demasiados intentos. Espera un momento.' });
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

/* --------------------------------- correo ----------------------------------- */
const transporter = nodemailer && SMTP_URL ? nodemailer.createTransport(SMTP_URL) : null;
async function sendCode(email, code) {
  if (!transporter) {
    console.log(`\n  [CÓDIGO DE VERIFICACIÓN] ${email}  →  ${code}   (configura SMTP_URL para enviarlo por correo)\n`);
    return;
  }
  await transporter.sendMail({
    from: MAIL_FROM, to: email, subject: 'Tu código de verificación',
    text: `Tu código de verificación es ${code}. Vence en 15 minutos.`,
  });
}

/* ------------------------------ ubicación por IP ----------------------------- */
const ipCache = new Map();
const PRIVATE_IP = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fc|fd|fe80)/i;
async function geoIp(ip) {
  if (!ip || PRIVATE_IP.test(ip)) return null;
  const c = ipCache.get(ip);
  if (c && Date.now() - c.t < 3600e3) return c.v;
  try {
    const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    if (j && j.success) {
      const v = { lat: j.latitude, lng: j.longitude, city: j.city, region: j.region, country: j.country, isp: j.connection && j.connection.isp };
      ipCache.set(ip, { t: Date.now(), v });
      return v;
    }
  } catch (_) { /* sin red o servicio caído */ }
  return null;
}

/* --------------------------------- sesiones ---------------------------------- */
function getCookie(req, name) {
  const part = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
}
function startSession(req, res, email) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha(token)] = { email, exp: Date.now() + 30 * 864e5 };
  save();
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${req.secure ? '; Secure' : ''}`);
}
function requireUser(req, res, next) {
  const tok = getCookie(req, 'sid');
  const s = tok && db.sessions[sha(tok)];
  if (!s || s.exp < Date.now()) return res.status(401).json({ error: 'Sesión no iniciada' });
  req.user = s.email;
  req.sessionKey = sha(tok);
  next();
}

/* ---------------------------------- app ------------------------------------- */
const app = express();
app.set('trust proxy', 1); // ngrok envía X-Forwarded-For / X-Forwarded-Proto
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(self)');
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true, smtp: !!transporter }));

/* ------------------------------ cuentas / correo ------------------------------ */
app.post('/api/register', rl('reg', 10, 3600e3), async (req, res) => {
  const email = normEmail(req.body.email);
  const pw = String(req.body.password || '');
  if (!email) return res.status(400).json({ error: 'Correo inválido' });
  if (pw.length < 8 || pw.length > 200) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  const existing = db.users[email];
  if (existing && existing.verified) return res.status(409).json({ error: 'Ese correo ya está registrado. Inicia sesión.' });
  const salt = crypto.randomBytes(16).toString('hex');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.users[email] = {
    email, salt, hash: hashPw(pw, salt), verified: false,
    codeHash: sha(code), codeExp: Date.now() + 15 * 60e3, attempts: 0, createdAt: Date.now(),
  };
  save();
  try { await sendCode(email, code); } catch (e) {
    console.error('Error enviando correo:', e.message);
    return res.status(502).json({ error: 'No se pudo enviar el correo de verificación' });
  }
  res.json({ ok: true });
});

app.post('/api/verify', rl('ver', 20, 3600e3), (req, res) => {
  const email = normEmail(req.body.email);
  const u = email && db.users[email];
  if (!u || u.verified || Date.now() > u.codeExp || u.attempts >= 5) {
    return res.status(400).json({ error: 'Código inválido o vencido. Vuelve a registrarte para recibir otro.' });
  }
  u.attempts++;
  if (!safeEq(sha(String(req.body.code || '').trim()), u.codeHash)) {
    save();
    return res.status(400).json({ error: 'Código incorrecto' });
  }
  u.verified = true;
  delete u.codeHash;
  save();
  startSession(req, res, email);
  res.json({ ok: true, email });
});

app.post('/api/login', rl('login', 15, 15 * 60e3), (req, res) => {
  const email = normEmail(req.body.email);
  const u = email && db.users[email];
  const ok = u && u.verified && safeEq(hashPw(String(req.body.password || ''), u.salt), u.hash);
  if (!ok) return res.status(401).json({ error: 'Correo o contraseña incorrectos (o correo sin verificar)' });
  startSession(req, res, email);
  res.json({ ok: true, email });
});

app.post('/api/logout', requireUser, (req, res) => {
  delete db.sessions[req.sessionKey];
  save();
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => res.json({ email: req.user }));

/* ------------------------------ panel del dueño ------------------------------- */
function pub(d) {
  return {
    id: d.id, name: d.name, phone: d.phone, paired: !!d.tokenHash,
    lastSeen: d.lastSeen || null, online: !!d.lastSeen && Date.now() - d.lastSeen < 45000,
    battery: d.battery == null ? null : d.battery, lastIp: d.lastIp || null,
    gpsOn: d.gpsOn == null ? null : d.gpsOn,
    lastLocation: d.lastLocation || null, lastGps: d.lastGps || null, lost: d.lost || null,
  };
}
function ownDevice(req, res) {
  const d = db.devices[req.params.id];
  if (!d || d.owner !== req.user) { res.status(404).json({ error: 'Teléfono no encontrado' }); return null; }
  return d;
}
function baseUrl(req) { return PUBLIC_URL || `${req.protocol}://${req.get('host')}`; }
function newPairing(d, req) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[crypto.randomInt(0, alphabet.length)];
  for (const [k, v] of Object.entries(db.pairing)) if (v.deviceId === d.id || v.exp < Date.now()) delete db.pairing[k];
  db.pairing[code] = { deviceId: d.id, exp: Date.now() + 15 * 60e3 };
  save();
  return { code, expiresInMinutes: 15, link: `${baseUrl(req)}/device.html?code=${code}` };
}

app.get('/api/devices', requireUser, (req, res) => {
  res.json({ devices: Object.values(db.devices).filter((d) => d.owner === req.user).map(pub) });
});

app.post('/api/devices', requireUser, (req, res) => {
  const mine = Object.values(db.devices).filter((d) => d.owner === req.user);
  if (mine.length >= 10) return res.status(400).json({ error: 'Máximo 10 teléfonos por cuenta' });
  const name = clean(req.body.name, 40);
  const phone = clean(req.body.phone, 30).replace(/[^\d+\s()-]/g, '');
  if (!name) return res.status(400).json({ error: 'Ponle un nombre al teléfono' });
  const d = { id: crypto.randomBytes(8).toString('hex'), owner: req.user, name, phone, createdAt: Date.now(), pending: [], lost: null };
  db.devices[d.id] = d;
  save();
  res.json({ device: pub(d), pairing: newPairing(d, req) });
});

app.post('/api/devices/:id/pair', requireUser, (req, res) => {
  const d = ownDevice(req, res); if (!d) return;
  res.json({ pairing: newPairing(d, req) });
});

app.delete('/api/devices/:id', requireUser, (req, res) => {
  const d = ownDevice(req, res); if (!d) return;
  delete db.devices[d.id];
  db.locations = db.locations.filter((l) => l.deviceId !== d.id);
  save();
  res.json({ ok: true });
});

app.post('/api/devices/:id/command', requireUser, rl('cmd', 120, 3600e3), (req, res) => {
  const d = ownDevice(req, res); if (!d) return;
  const t = String(req.body.type || '');
  d.pending = d.pending || [];
  if (t === 'locate' || t === 'ring') {
    d.pending = d.pending.filter((x) => x !== t).concat(t).slice(-10);
  } else if (t === 'stopring') {
    d.pending = d.pending.filter((x) => x !== 'ring').concat('stopring').slice(-10);
  } else if (t === 'lost') {
    d.lost = {
      active: true,
      message: clean(req.body.message, 200) || 'Este teléfono fue perdido o robado. Por favor llama a su dueño.',
      contact: clean(req.body.contact, 30).replace(/[^\d+\s()-]/g, '') || d.phone || '',
      since: Date.now(),
    };
    d.pending = d.pending.filter((x) => x !== 'locate').concat('locate').slice(-10);
  } else if (t === 'found') {
    d.lost = null;
  } else {
    return res.status(400).json({ error: 'Comando desconocido' });
  }
  save();
  res.json({ ok: true });
});

app.get('/api/devices/:id/locations', requireUser, (req, res) => {
  const d = ownDevice(req, res); if (!d) return;
  const n = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 300);
  const out = [];
  for (let i = db.locations.length - 1; i >= 0 && out.length < n; i--) if (db.locations[i].deviceId === d.id) out.push(db.locations[i]);
  res.json({ locations: out });
});

/* ------------------------------ lado del teléfono ----------------------------- */
app.post('/api/device/pair', rl('pair', 20, 3600e3), (req, res) => {
  const code = String(req.body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const p = db.pairing[code];
  const d = p && p.exp > Date.now() && db.devices[p.deviceId];
  if (!d) return res.status(400).json({ error: 'Código inválido o vencido. Genera uno nuevo en el panel.' });
  delete db.pairing[code];
  const token = crypto.randomBytes(32).toString('hex');
  d.tokenHash = sha(token);
  d.pairedAt = Date.now();
  save();
  res.json({ token, deviceId: d.id, name: d.name });
});

function deviceAuth(req, res, next) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  const h = m && sha(m[1]);
  const d = h && Object.values(db.devices).find((x) => x.tokenHash && x.tokenHash === h);
  if (!d) return res.status(401).json({ error: 'Teléfono no vinculado' });
  req.device = d;
  next();
}
function drain(d) {
  const c = d.pending || [];
  d.pending = [];
  return c;
}
function pruneLocations() {
  if (db.locations.length < 4000) return;
  const seen = {};
  const keep = [];
  for (let i = db.locations.length - 1; i >= 0; i--) {
    const l = db.locations[i];
    seen[l.deviceId] = (seen[l.deviceId] || 0) + 1;
    if (seen[l.deviceId] <= 500) keep.push(l);
  }
  db.locations = keep.reverse();
}

app.get('/api/device/poll', deviceAuth, (req, res) => {
  const d = req.device;
  d.lastSeen = Date.now();
  d.lastIp = clientIp(req);
  const commands = drain(d);
  if (commands.length) save();
  res.json({ ok: true, commands, lost: d.lost || null });
});

app.post('/api/device/ping', deviceAuth, rl('ping', 600, 3600e3), async (req, res) => {
  const d = req.device;
  const b = req.body || {};
  const ip = clientIp(req);
  d.lastSeen = Date.now();
  d.lastIp = ip;
  if (typeof b.battery === 'number' && b.battery >= 0 && b.battery <= 1) d.battery = Math.round(b.battery * 100);

  const g = await geoIp(ip);
  const rec = { deviceId: d.id, ts: Date.now(), ip, battery: d.battery == null ? null : d.battery };
  if (g) Object.assign(rec, { city: g.city, region: g.region, country: g.country, isp: g.isp });

  const lat = Number(b.lat); const lng = Number(b.lng);
  const validGps = b.gps === true && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  d.gpsOn = validGps;
  if (validGps) {
    Object.assign(rec, { source: 'gps', lat, lng, acc: Number(b.acc) || null });
    d.lastGps = { ts: rec.ts, lat, lng, acc: rec.acc };
    d.lastLocation = { ts: rec.ts, lat, lng, acc: rec.acc, source: 'gps', ip, city: rec.city || null, country: rec.country || null };
  } else if (g && g.lat != null) {
    // GPS apagado / denegado / sin señal: caemos a la ubicación aproximada por IP
    Object.assign(rec, { source: 'ip', lat: g.lat, lng: g.lng, acc: 5000, gpsError: clean(b.gpsError, 40) });
    d.lastLocation = { ts: rec.ts, lat: g.lat, lng: g.lng, acc: 5000, source: 'ip', ip, city: g.city || null, country: g.country || null };
  } else {
    Object.assign(rec, { source: 'none', gpsError: clean(b.gpsError, 40) });
  }
  db.locations.push(rec);
  pruneLocations();
  const commands = drain(d);
  save();
  res.json({ ok: true, commands, lost: d.lost || null });
});

/* ---------------------------------- estáticos --------------------------------- */
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  console.error(err);
  res.status(500).json({ error: 'Error interno' });
});

app.listen(PORT, () => {
  console.log(`\n  Localizador listo en http://localhost:${PORT}`);
  console.log('  Para exponerlo con HTTPS (necesario para el GPS del navegador):  ngrok http ' + PORT + '\n');
});
