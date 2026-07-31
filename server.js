require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, verifyPassword } = require('./db');

const PORT = process.env.PORT || 3000;
const KIOSK_API_KEY = process.env.KIOSK_API_KEY || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const STANDORTE = (process.env.STANDORTE || '').split(',').map(s => s.trim()).filter(Boolean);
const STANDORT_LISTE = STANDORTE.length ? STANDORTE : ['Standort'];
const PUBLIC_DIR = path.join(__dirname, 'public');

// STANDORT_DOMAINS="hauptgebaeude.example.com=Hauptgebäude,lager-nord.example.com=Lager Nord"
const STANDORT_DOMAIN_MAP = {};
(process.env.STANDORT_DOMAINS || '').split(',').map(s => s.trim()).filter(Boolean).forEach(eintrag => {
  const idx = eintrag.indexOf('=');
  if (idx === -1) return;
  const host = eintrag.slice(0, idx).trim().toLowerCase();
  const standort = eintrag.slice(idx + 1).trim();
  if (host && standort) STANDORT_DOMAIN_MAP[host] = standort;
});

if (!KIOSK_API_KEY) console.warn('[WARN] KIOSK_API_KEY ist nicht gesetzt.');
if (!SESSION_SECRET) console.warn('[WARN] SESSION_SECRET ist nicht gesetzt. Admin-Logins funktionieren nicht sicher.');
if (!process.env.ADMIN_USERS) console.warn('[WARN] ADMIN_USERS ist nicht gesetzt. Es gibt keine Admin-Zugänge.');

const app = express();
app.set('trust proxy', 1); // hinter Coolify/Traefik: X-Forwarded-* korrekt auswerten
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',') }));

// --- Hilfsfunktionen: Standort ---------------------------------------------

function validStandort(standort) {
  return typeof standort === 'string' && standort.trim() && STANDORT_LISTE.includes(standort.trim());
}

// Ermittelt den fest zugeordneten Standort für einen Kiosk anhand des Hostnamens.
// Gibt null zurück, wenn er nicht eindeutig bestimmbar ist (Konfigurationsfehler).
function resolveKioskStandort(hostname) {
  const host = (hostname || '').toLowerCase();
  if (STANDORT_DOMAIN_MAP[host]) return STANDORT_DOMAIN_MAP[host];
  if (STANDORT_LISTE.length === 1) return STANDORT_LISTE[0];
  return null;
}

// --- Hilfsfunktionen: Admin-Session (signierter Cookie, kein extra Paket) --

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signSession(payload) {
  const data = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySession(token) {
  if (!token || !SESSION_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

const SESSION_COOKIE = 'admin_session';
const SESSION_DAUER_MS = 12 * 60 * 60 * 1000; // 12 Stunden

// --- Middleware -------------------------------------------------------------

function requireKioskKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!KIOSK_API_KEY || key !== KIOSK_API_KEY) {
    return res.status(401).json({ error: 'Ungültiger oder fehlender API-Key.' });
  }
  next();
}

function requireAdminSession(req, res, next) {
  const payload = verifySession(req.cookies[SESSION_COOKIE]);
  if (!payload) {
    return res.status(401).json({ error: 'Nicht angemeldet oder Sitzung abgelaufen.' });
  }
  req.admin = { username: payload.username, standort: payload.standort || null };
  next();
}

// Ein standortgebundener Admin darf nur auf seinen eigenen Standort zugreifen.
// null bei admin.standort bedeutet Superadmin (alle Standorte).
function adminDarfZugreifen(req, standort) {
  return !req.admin.standort || req.admin.standort === standort;
}

const kioskLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
const kioskReadLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const loginLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

// --- Allgemein ---------------------------------------------------------------

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/standorte', (req, res) => res.json(STANDORT_LISTE));

// --- Admin-Login --------------------------------------------------------------

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich.' });
  }
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username.trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Benutzername oder Passwort falsch.' });
  }
  const token = signSession({ username: user.username, standort: user.standort, exp: Date.now() + SESSION_DAUER_MS });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_DAUER_MS
  });
  res.json({ username: user.username, standort: user.standort });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdminSession, (req, res) => {
  res.json({ username: req.admin.username, standort: req.admin.standort });
});

// --- Besucher -----------------------------------------------------------------

app.post('/api/besucher', kioskLimiter, requireKioskKey, (req, res) => {
  const { standort, name, firma, ansprechpartner, grund } = req.body || {};
  if (!validStandort(standort)) return res.status(400).json({ error: 'Unbekannter oder fehlender Standort.' });
  if (!name || !ansprechpartner) return res.status(400).json({ error: 'name und ansprechpartner sind erforderlich.' });

  const angemeldet_um = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO besucher (standort, name, firma, ansprechpartner, grund, angemeldet_um)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(standort.trim(), name.trim(), firma?.trim() || null, ansprechpartner.trim(), grund?.trim() || null, angemeldet_um);
  res.status(201).json({ id: info.lastInsertRowid, angemeldet_um });
});

app.get('/api/besucher', requireAdminSession, (req, res) => {
  const { offen } = req.query;
  const standort = req.admin.standort || req.query.standort;
  const clauses = [];
  const params = [];
  if (offen === 'true') clauses.push('abgemeldet_um IS NULL');
  if (standort) { clauses.push('standort = ?'); params.push(standort); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  res.json(db.prepare(`SELECT * FROM besucher ${where} ORDER BY angemeldet_um DESC LIMIT 500`).all(...params));
});

app.patch('/api/besucher/:id', requireAdminSession, (req, res) => {
  const row = db.prepare('SELECT * FROM besucher WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nicht gefunden.' });
  if (!adminDarfZugreifen(req, row.standort)) return res.status(403).json({ error: 'Kein Zugriff auf diesen Standort.' });

  const { name, firma, ansprechpartner, grund } = req.body || {};
  db.prepare(`
    UPDATE besucher SET
      name = COALESCE(?, name),
      firma = ?,
      ansprechpartner = COALESCE(?, ansprechpartner),
      grund = ?
    WHERE id = ?
  `).run(
    name?.trim() || null,
    firma !== undefined ? (firma?.trim() || null) : row.firma,
    ansprechpartner?.trim() || null,
    grund !== undefined ? (grund?.trim() || null) : row.grund,
    req.params.id
  );
  res.json({ ok: true });
});

function besucherAbmelden(id) {
  const row = db.prepare('SELECT * FROM besucher WHERE id = ?').get(id);
  if (!row) return { status: 404, body: { error: 'Besucher nicht gefunden.' } };
  if (row.abgemeldet_um) return { status: 409, body: { error: 'Besucher ist bereits abgemeldet.' } };
  const abgemeldet_um = new Date().toISOString();
  db.prepare('UPDATE besucher SET abgemeldet_um = ? WHERE id = ?').run(abgemeldet_um, id);
  return { status: 200, body: { id: Number(id), abgemeldet_um }, standort: row.standort };
}

app.patch('/api/besucher/:id/abmelden', requireAdminSession, (req, res) => {
  const row = db.prepare('SELECT * FROM besucher WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Besucher nicht gefunden.' });
  if (!adminDarfZugreifen(req, row.standort)) return res.status(403).json({ error: 'Kein Zugriff auf diesen Standort.' });
  const ergebnis = besucherAbmelden(req.params.id);
  res.status(ergebnis.status).json(ergebnis.body);
});

// --- Handwerker -----------------------------------------------------------------

function offenerSchluessel(standort, schluessel) {
  return db.prepare(`
    SELECT s.*
    FROM schluessel s
    INNER JOIN (
      SELECT schluessel, MAX(id) AS max_id FROM schluessel WHERE standort = ? AND schluessel = ? GROUP BY schluessel
    ) latest ON latest.schluessel = s.schluessel AND latest.max_id = s.id
    WHERE s.standort = ? AND s.schluessel = ? AND s.richtung = 'ausgabe'
  `).get(standort, schluessel, standort, schluessel);
}

app.post('/api/handwerker', kioskLimiter, requireKioskKey, (req, res) => {
  const { standort, name, firma, schluessel } = req.body || {};
  if (!validStandort(standort)) return res.status(400).json({ error: 'Unbekannter oder fehlender Standort.' });
  if (!name) return res.status(400).json({ error: 'name ist erforderlich.' });

  const standortTrim = standort.trim();
  const schluesselTrim = schluessel?.trim() || null;

  if (schluesselTrim && offenerSchluessel(standortTrim, schluesselTrim)) {
    return res.status(409).json({ error: `Schlüssel "${schluesselTrim}" ist bereits ausgegeben und noch nicht zurückgegeben.` });
  }

  const angemeldet_um = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO handwerker (standort, name, firma, schluessel, angemeldet_um)
    VALUES (?, ?, ?, ?, ?)
  `).run(standortTrim, name.trim(), firma?.trim() || null, schluesselTrim, angemeldet_um);

  if (schluesselTrim) {
    db.prepare(`
      INSERT INTO schluessel (standort, handwerker_id, name, firma, schluessel, richtung, zeitpunkt)
      VALUES (?, ?, ?, ?, ?, 'ausgabe', ?)
    `).run(standortTrim, info.lastInsertRowid, name.trim(), firma?.trim() || null, schluesselTrim, angemeldet_um);
  }

  res.status(201).json({ id: info.lastInsertRowid, angemeldet_um });
});

app.get('/api/handwerker', requireAdminSession, (req, res) => {
  const { offen } = req.query;
  const standort = req.admin.standort || req.query.standort;
  const clauses = [];
  const params = [];
  if (offen === 'true') clauses.push('abgemeldet_um IS NULL');
  if (standort) { clauses.push('standort = ?'); params.push(standort); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  res.json(db.prepare(`SELECT * FROM handwerker ${where} ORDER BY angemeldet_um DESC LIMIT 500`).all(...params));
});

app.patch('/api/handwerker/:id', requireAdminSession, (req, res) => {
  const row = db.prepare('SELECT * FROM handwerker WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nicht gefunden.' });
  if (!adminDarfZugreifen(req, row.standort)) return res.status(403).json({ error: 'Kein Zugriff auf diesen Standort.' });

  const { name, firma, schluessel } = req.body || {};
  db.prepare(`
    UPDATE handwerker SET
      name = COALESCE(?, name),
      firma = ?,
      schluessel = ?
    WHERE id = ?
  `).run(
    name?.trim() || null,
    firma !== undefined ? (firma?.trim() || null) : row.firma,
    schluessel !== undefined ? (schluessel?.trim() || null) : row.schluessel,
    req.params.id
  );
  res.json({ ok: true, hinweis: 'Änderung am Namen des Schlüssels wirkt sich nicht rückwirkend auf bereits erfasste Schlüsselbewegungen aus.' });
});

function handwerkerAbmelden(id, schluesselZurueckgeben) {
  const row = db.prepare('SELECT * FROM handwerker WHERE id = ?').get(id);
  if (!row) return { status: 404, body: { error: 'Handwerker nicht gefunden.' } };
  if (row.abgemeldet_um) return { status: 409, body: { error: 'Handwerker ist bereits abgemeldet.' } };

  let schluesselZurueckgegeben = false;
  if (row.schluessel && schluesselZurueckgeben !== false) {
    const offen = offenerSchluessel(row.standort, row.schluessel);
    if (offen) {
      db.prepare(`
        INSERT INTO schluessel (standort, handwerker_id, name, firma, schluessel, richtung, zeitpunkt)
        VALUES (?, ?, ?, ?, ?, 'rueckgabe', ?)
      `).run(row.standort, row.id, row.name, row.firma, row.schluessel, new Date().toISOString());
      schluesselZurueckgegeben = true;
    }
  }

  const abgemeldet_um = new Date().toISOString();
  db.prepare('UPDATE handwerker SET abgemeldet_um = ? WHERE id = ?').run(abgemeldet_um, id);
  return { status: 200, body: { id: Number(id), abgemeldet_um, schluesselZurueckgegeben }, standort: row.standort };
}

app.patch('/api/handwerker/:id/abmelden', requireAdminSession, (req, res) => {
  const row = db.prepare('SELECT * FROM handwerker WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Handwerker nicht gefunden.' });
  if (!adminDarfZugreifen(req, row.standort)) return res.status(403).json({ error: 'Kein Zugriff auf diesen Standort.' });
  const ergebnis = handwerkerAbmelden(req.params.id, req.body?.schluessel_zurueck);
  res.status(ergebnis.status).json(ergebnis.body);
});

// --- Selbst-Abmeldung am Kiosk (Besucher + Handwerker zusammen) ---------------

app.get('/api/checkins/offene-liste', kioskReadLimiter, requireKioskKey, (req, res) => {
  const { standort } = req.query;
  if (!validStandort(standort)) return res.status(400).json({ error: 'Unbekannter oder fehlender Standort.' });

  const besucherRows = db.prepare(`
    SELECT id, name, firma, angemeldet_um FROM besucher WHERE standort = ? AND abgemeldet_um IS NULL
  `).all(standort).map(r => ({ ...r, typ: 'besucher' }));

  const handwerkerRows = db.prepare(`
    SELECT id, name, firma, schluessel, angemeldet_um FROM handwerker WHERE standort = ? AND abgemeldet_um IS NULL
  `).all(standort).map(r => ({ ...r, typ: 'handwerker' }));

  const alle = [...besucherRows, ...handwerkerRows].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  res.json(alle);
});

app.patch('/api/checkins/:typ/:id/abmelden', kioskLimiter, requireKioskKey, (req, res) => {
  const { typ, id } = req.params;
  const { standort, schluessel_zurueck } = req.body || {};
  if (!validStandort(standort)) return res.status(400).json({ error: 'Unbekannter oder fehlender Standort.' });

  let ergebnis;
  if (typ === 'besucher') {
    ergebnis = besucherAbmelden(id);
  } else if (typ === 'handwerker') {
    ergebnis = handwerkerAbmelden(id, schluessel_zurueck);
  } else {
    return res.status(400).json({ error: 'Unbekannter Typ.' });
  }

  if (ergebnis.status === 200 && ergebnis.standort !== standort.trim()) {
    return res.status(403).json({ error: 'Standort stimmt nicht überein.' });
  }
  res.status(ergebnis.status).json(ergebnis.body);
});

// --- Schlüssel-Log (Verwaltungsübersicht) -------------------------------------

app.get('/api/schluessel', requireAdminSession, (req, res) => {
  const { offen } = req.query;
  const standort = req.admin.standort || req.query.standort;
  if (offen === 'true') {
    const clauses = ["s.richtung = 'ausgabe'"];
    const params = [];
    if (standort) { clauses.push('latest.standort = ?'); params.push(standort); }
    const rows = db.prepare(`
      SELECT s.*
      FROM schluessel s
      INNER JOIN (
        SELECT standort, schluessel, MAX(id) AS max_id FROM schluessel GROUP BY standort, schluessel
      ) latest ON latest.standort = s.standort AND latest.schluessel = s.schluessel AND latest.max_id = s.id
      WHERE ${clauses.join(' AND ')}
      ORDER BY s.zeitpunkt DESC
    `).all(...params);
    return res.json(rows);
  }
  const clauses = [];
  const params = [];
  if (standort) { clauses.push('standort = ?'); params.push(standort); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  res.json(db.prepare(`SELECT * FROM schluessel ${where} ORDER BY zeitpunkt DESC LIMIT 500`).all(...params));
});

// Manuelles Zurücknehmen im Portal (z. B. wenn ein Handwerker nicht selbst
// über den Kiosk abgemeldet wurde).
app.patch('/api/schluessel/:id/zurueckgeben', requireAdminSession, (req, res) => {
  const ausgabe = db.prepare(`SELECT * FROM schluessel WHERE id = ? AND richtung = 'ausgabe'`).get(req.params.id);
  if (!ausgabe) return res.status(404).json({ error: 'Ausgabe-Eintrag nicht gefunden.' });
  if (!adminDarfZugreifen(req, ausgabe.standort)) return res.status(403).json({ error: 'Kein Zugriff auf diesen Standort.' });

  const offen = offenerSchluessel(ausgabe.standort, ausgabe.schluessel);
  if (!offen || offen.id !== ausgabe.id) return res.status(409).json({ error: 'Dieser Schlüssel wurde bereits zurückgegeben.' });

  const zeitpunkt = new Date().toISOString();
  db.prepare(`
    INSERT INTO schluessel (standort, handwerker_id, name, firma, schluessel, richtung, zeitpunkt)
    VALUES (?, ?, ?, ?, ?, 'rueckgabe', ?)
  `).run(ausgabe.standort, ausgabe.handwerker_id, ausgabe.name, ausgabe.firma, ausgabe.schluessel, zeitpunkt);

  if (ausgabe.handwerker_id) {
    db.prepare('UPDATE handwerker SET abgemeldet_um = COALESCE(abgemeldet_um, ?) WHERE id = ? AND abgemeldet_um IS NULL')
      .run(zeitpunkt, ausgabe.handwerker_id);
  }

  res.status(201).json({ zeitpunkt });
});

// --- Frontend -------------------------------------------------------------

function fehlerseiteStandort(hostname) {
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><title>Standort nicht konfiguriert</title>
  <style>body{font-family:sans-serif;background:#1B2430;color:#F4F0E6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}
  .box{max-width:480px}code{background:#232D3A;padding:2px 6px;border-radius:4px}</style></head>
  <body><div class="box"><h1>Standort nicht konfiguriert</h1>
  <p>Für den Hostnamen <code>${hostname}</code> ist kein Standort hinterlegt.</p>
  <p>Bitte <code>STANDORT_DOMAINS</code> (bei mehreren Standorten) oder <code>STANDORTE</code>
  (bei genau einem Standort) in den Umgebungsvariablen konfigurieren.</p></div></body></html>`;
}

app.get('/', (req, res) => {
  const standort = resolveKioskStandort(req.hostname);
  res.set('Cache-Control', 'no-store');
  if (!standort) return res.status(500).type('html').send(fehlerseiteStandort(req.hostname));
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    .replace('__KIOSK_API_KEY__', KIOSK_API_KEY)
    .replace('__STANDORT__', standort.replace(/"/g, '\\"'));
  res.type('html').send(html);
});

app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.use(express.static(PUBLIC_DIR, { index: false }));
app.use((req, res) => res.status(404).json({ error: 'Nicht gefunden.' }));

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
