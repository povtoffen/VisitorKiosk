require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, verifyPassword, hashPassword, DATA_DIR } = require('./db');

const PORT = process.env.PORT || 3000;
const KIOSK_API_KEY = process.env.KIOSK_API_KEY || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

if (!KIOSK_API_KEY) console.warn('[WARN] KIOSK_API_KEY ist nicht gesetzt.');
if (!SESSION_SECRET) console.warn('[WARN] SESSION_SECRET ist nicht gesetzt. Admin-Logins funktionieren nicht sicher.');

// --- SMTP (optional, für E-Mail-Exporte) -------------------------------------

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = process.env.SMTP_SECURE === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const smtpKonfiguriert = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
const transporter = smtpKonfiguriert
  ? nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE, auth: { user: SMTP_USER, pass: SMTP_PASS } })
  : null;
if (!smtpKonfiguriert) console.warn('[WARN] SMTP ist nicht konfiguriert — E-Mail-Export ist deaktiviert.');

const app = express();
app.set('trust proxy', 1); // hinter Coolify/Traefik: X-Forwarded-* korrekt auswerten
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(','), credentials: true }));

// --- Hilfsfunktionen: Standort ------------------------------------------------

function validStandort(name) {
  if (typeof name !== 'string' || !name.trim()) return false;
  return !!db.prepare('SELECT id FROM standorte WHERE name = ?').get(name.trim());
}

// Ermittelt den fest zugeordneten Standort (inkl. Kiosk-Design) für einen
// Hostnamen. Gibt null zurück, wenn er nicht eindeutig bestimmbar ist.
function resolveKioskStandort(hostname) {
  const host = (hostname || '').toLowerCase();
  const perDomain = db.prepare(`
    SELECT st.* FROM domains d JOIN standorte st ON st.id = d.standort_id WHERE d.hostname = ?
  `).get(host);
  if (perDomain) return perDomain;
  const alle = db.prepare('SELECT * FROM standorte').all();
  if (alle.length === 1) return alle[0];
  return null;
}

// --- Hilfsfunktionen: Admin-Session (signierter Cookie, kein extra Paket) ----

function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
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

function requireKioskKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!KIOSK_API_KEY || key !== KIOSK_API_KEY) {
    return res.status(401).json({ error: 'Ungültiger oder fehlender API-Key.' });
  }
  next();
}

// Admin-Auth über signierten, httpOnly-Cookie. Da alle verändernden Endpunkte
// POST/PATCH/DELETE verwenden und der Cookie SameSite=Lax gesetzt ist, wird er
// bei websiteübergreifenden Anfragen (CSRF) von modernen Browsern nicht
// mitgeschickt — ein zusätzliches CSRF-Token ist damit nicht nötig.
function requireAdminSession(req, res, next) {
  const payload = verifySession(req.cookies[SESSION_COOKIE]);
  if (!payload) return res.status(401).json({ error: 'Nicht angemeldet oder Sitzung abgelaufen.' });
  req.admin = { username: payload.username, standort_id: payload.standort_id ?? null, standort: payload.standort ?? null };
  next();
}

function requireSuperadmin(req, res, next) {
  if (req.admin.standort_id !== null) return res.status(403).json({ error: 'Diese Funktion ist nur für Superadmins verfügbar.' });
  next();
}

function adminDarfZugreifen(req, standort) {
  return !req.admin.standort || req.admin.standort === standort;
}

function protokolliere(username, aktion, detail) {
  db.prepare('INSERT INTO audit_log (zeitpunkt, username, aktion, detail) VALUES (?, ?, ?, ?)')
    .run(new Date().toISOString(), username, aktion, detail || null);
}

const kioskLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
const kioskReadLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const loginLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

// --- Allgemein -----------------------------------------------------------------

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// --- Admin-Login -----------------------------------------------------------------

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich.' });
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username.trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Benutzername oder Passwort falsch.' });
  }
  let standortName = null;
  if (user.standort_id) {
    const s = db.prepare('SELECT name FROM standorte WHERE id = ?').get(user.standort_id);
    standortName = s ? s.name : null;
  }
  const token = signSession({ username: user.username, standort_id: user.standort_id, standort: standortName, exp: Date.now() + SESSION_DAUER_MS });
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAUER_MS });
  res.json({ username: user.username, standort_id: user.standort_id, standort: standortName });
});

app.post('/api/admin/logout', (req, res) => { res.clearCookie(SESSION_COOKIE); res.json({ ok: true }); });

app.get('/api/admin/me', requireAdminSession, (req, res) => {
  res.json({ username: req.admin.username, standort_id: req.admin.standort_id, standort: req.admin.standort });
});

app.post('/api/admin/passwort', requireAdminSession, (req, res) => {
  const { neuesPasswort } = req.body || {};
  if (!neuesPasswort || neuesPasswort.length < 8) return res.status(400).json({ error: 'Neues Passwort muss mindestens 8 Zeichen haben.' });
  db.prepare('UPDATE admin_users SET password_hash = ? WHERE username = ?').run(hashPassword(neuesPasswort), req.admin.username);
  protokolliere(req.admin.username, 'eigenes_passwort_geaendert', null);
  res.json({ ok: true });
});

// --- Besucher --------------------------------------------------------------------

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
  const { offen, von, bis } = req.query;
  const standort = req.admin.standort || req.query.standort;
  const clauses = [];
  const params = [];
  if (offen === 'true') clauses.push('abgemeldet_um IS NULL');
  if (standort) { clauses.push('standort = ?'); params.push(standort); }
  if (von) { clauses.push('angemeldet_um >= ?'); params.push(von); }
  if (bis) { clauses.push('angemeldet_um <= ?'); params.push(bis + 'T23:59:59'); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  res.json(db.prepare(`SELECT * FROM besucher ${where} ORDER BY angemeldet_um DESC LIMIT 500`).all(...params));
});

app.patch('/api/besucher/:id', requireAdminSession, (req, res) => {
  const row = db.prepare('SELECT * FROM besucher WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nicht gefunden.' });
  if (!adminDarfZugreifen(req, row.standort)) return res.status(403).json({ error: 'Kein Zugriff auf diesen Standort.' });

  const { name, firma, ansprechpartner, grund } = req.body || {};
  db.prepare(`
    UPDATE besucher SET name = COALESCE(?, name), firma = ?, ansprechpartner = COALESCE(?, ansprechpartner), grund = ? WHERE id = ?
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

// --- Handwerker ------------------------------------------------------------------

function offenerSchluessel(standort, schluessel) {
  return db.prepare(`
    SELECT s.* FROM schluessel s
    INNER JOIN (SELECT schluessel, MAX(id) AS max_id FROM schluessel WHERE standort = ? AND schluessel = ? GROUP BY schluessel) latest
      ON latest.schluessel = s.schluessel AND latest.max_id = s.id
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
    INSERT INTO handwerker (standort, name, firma, schluessel, angemeldet_um) VALUES (?, ?, ?, ?, ?)
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
  const { offen, von, bis } = req.query;
  const standort = req.admin.standort || req.query.standort;
  const clauses = [];
  const params = [];
  if (offen === 'true') clauses.push('abgemeldet_um IS NULL');
  if (standort) { clauses.push('standort = ?'); params.push(standort); }
  if (von) { clauses.push('angemeldet_um >= ?'); params.push(von); }
  if (bis) { clauses.push('angemeldet_um <= ?'); params.push(bis + 'T23:59:59'); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  res.json(db.prepare(`SELECT * FROM handwerker ${where} ORDER BY angemeldet_um DESC LIMIT 500`).all(...params));
});

app.patch('/api/handwerker/:id', requireAdminSession, (req, res) => {
  const row = db.prepare('SELECT * FROM handwerker WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nicht gefunden.' });
  if (!adminDarfZugreifen(req, row.standort)) return res.status(403).json({ error: 'Kein Zugriff auf diesen Standort.' });

  const { name, firma, schluessel } = req.body || {};
  db.prepare('UPDATE handwerker SET name = COALESCE(?, name), firma = ?, schluessel = ? WHERE id = ?').run(
    name?.trim() || null,
    firma !== undefined ? (firma?.trim() || null) : row.firma,
    schluessel !== undefined ? (schluessel?.trim() || null) : row.schluessel,
    req.params.id
  );
  res.json({ ok: true, hinweis: 'Änderung wirkt sich nicht rückwirkend auf bereits erfasste Schlüsselbewegungen aus.' });
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

// --- Selbst-Abmeldung am Kiosk (Besucher + Handwerker zusammen) -----------------

// Bewusst eine Suche statt einer Voll-Liste: liefert erst ab 2 Zeichen und nur
// wenige Treffer, damit am Kiosk niemand die komplette Anwesenheitsliste
// einsehen kann (auch nicht über direkte API-Aufrufe mit dem Kiosk-Key).
app.get('/api/checkins/suche', kioskReadLimiter, requireKioskKey, (req, res) => {
  const { standort, q } = req.query;
  if (!validStandort(standort)) return res.status(400).json({ error: 'Unbekannter oder fehlender Standort.' });
  const suchbegriff = (q || '').trim();
  if (suchbegriff.length < 2) return res.json([]);
  const muster = '%' + suchbegriff.replace(/[%_\\]/g, '\\$&') + '%';

  const besucherRows = db.prepare(`
    SELECT id, name, firma, angemeldet_um FROM besucher
    WHERE standort = ? AND abgemeldet_um IS NULL AND (LOWER(name) LIKE LOWER(?) ESCAPE '\\' OR LOWER(firma) LIKE LOWER(?) ESCAPE '\\')
    LIMIT 8
  `).all(standort, muster, muster).map(r => ({ ...r, typ: 'besucher' }));

  const handwerkerRows = db.prepare(`
    SELECT id, name, firma, schluessel, angemeldet_um FROM handwerker
    WHERE standort = ? AND abgemeldet_um IS NULL AND (LOWER(name) LIKE LOWER(?) ESCAPE '\\' OR LOWER(firma) LIKE LOWER(?) ESCAPE '\\')
    LIMIT 8
  `).all(standort, muster, muster).map(r => ({ ...r, typ: 'handwerker' }));

  const alle = [...besucherRows, ...handwerkerRows].sort((a, b) => a.name.localeCompare(b.name, 'de')).slice(0, 8);
  res.json(alle);
});

app.patch('/api/checkins/:typ/:id/abmelden', kioskLimiter, requireKioskKey, (req, res) => {
  const { typ, id } = req.params;
  const { standort, schluessel_zurueck } = req.body || {};
  if (!validStandort(standort)) return res.status(400).json({ error: 'Unbekannter oder fehlender Standort.' });

  let ergebnis;
  if (typ === 'besucher') ergebnis = besucherAbmelden(id);
  else if (typ === 'handwerker') ergebnis = handwerkerAbmelden(id, schluessel_zurueck);
  else return res.status(400).json({ error: 'Unbekannter Typ.' });

  if (ergebnis.status === 200 && ergebnis.standort !== standort.trim()) {
    return res.status(403).json({ error: 'Standort stimmt nicht überein.' });
  }
  res.status(ergebnis.status).json(ergebnis.body);
});

// --- Schlüssel-Log -----------------------------------------------------------------

app.get('/api/schluessel', requireAdminSession, (req, res) => {
  const { offen } = req.query;
  const standort = req.admin.standort || req.query.standort;
  if (offen === 'true') {
    const clauses = ["s.richtung = 'ausgabe'"];
    const params = [];
    if (standort) { clauses.push('latest.standort = ?'); params.push(standort); }
    const rows = db.prepare(`
      SELECT s.* FROM schluessel s
      INNER JOIN (SELECT standort, schluessel, MAX(id) AS max_id FROM schluessel GROUP BY standort, schluessel) latest
        ON latest.standort = s.standort AND latest.schluessel = s.schluessel AND latest.max_id = s.id
      WHERE ${clauses.join(' AND ')} ORDER BY s.zeitpunkt DESC
    `).all(...params);
    return res.json(rows);
  }
  const clauses = [];
  const params = [];
  if (standort) { clauses.push('standort = ?'); params.push(standort); }
  if (req.query.von) { clauses.push('zeitpunkt >= ?'); params.push(req.query.von); }
  if (req.query.bis) { clauses.push('zeitpunkt <= ?'); params.push(req.query.bis + 'T23:59:59'); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  res.json(db.prepare(`SELECT * FROM schluessel ${where} ORDER BY zeitpunkt DESC LIMIT 500`).all(...params));
});

app.patch('/api/schluessel/:id/zurueckgeben', requireAdminSession, (req, res) => {
  const ausgabe = db.prepare(`SELECT * FROM schluessel WHERE id = ? AND richtung = 'ausgabe'`).get(req.params.id);
  if (!ausgabe) return res.status(404).json({ error: 'Ausgabe-Eintrag nicht gefunden.' });
  if (!adminDarfZugreifen(req, ausgabe.standort)) return res.status(403).json({ error: 'Kein Zugriff auf diesen Standort.' });
  const offen = offenerSchluessel(ausgabe.standort, ausgabe.schluessel);
  if (!offen || offen.id !== ausgabe.id) return res.status(409).json({ error: 'Dieser Schlüssel wurde bereits zurückgegeben.' });

  const zeitpunkt = new Date().toISOString();
  db.prepare(`
    INSERT INTO schluessel (standort, handwerker_id, name, firma, schluessel, richtung, zeitpunkt) VALUES (?, ?, ?, ?, ?, 'rueckgabe', ?)
  `).run(ausgabe.standort, ausgabe.handwerker_id, ausgabe.name, ausgabe.firma, ausgabe.schluessel, zeitpunkt);
  if (ausgabe.handwerker_id) {
    db.prepare('UPDATE handwerker SET abgemeldet_um = COALESCE(abgemeldet_um, ?) WHERE id = ? AND abgemeldet_um IS NULL').run(zeitpunkt, ausgabe.handwerker_id);
  }
  res.status(201).json({ zeitpunkt });
});

// --- Export & Kunden --------------------------------------------------------------

function csvZeile(felder) {
  return felder.map(f => {
    const s = f == null ? '' : String(f);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',') + '\r\n';
}

function formatZeitDe(iso) {
  return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function slugifyDateiname(s) {
  return (s || 'export').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9-_]+/g, '-').toLowerCase();
}

function schluesselExportZeilen(standort, firma, von, bis) {
  const clauses = ['standort = ?'];
  const params = [standort];
  if (firma) { clauses.push('firma = ?'); params.push(firma); }
  if (von) { clauses.push('zeitpunkt >= ?'); params.push(von); }
  if (bis) { clauses.push('zeitpunkt <= ?'); params.push(bis + 'T23:59:59'); }
  return db.prepare(`SELECT * FROM schluessel WHERE ${clauses.join(' AND ')} ORDER BY zeitpunkt ASC`).all(...params);
}

function schluesselExportCsv(rows) {
  let csv = '\uFEFF' + csvZeile(['Standort', 'Firma', 'Name', 'Schlüssel', 'Vorgang', 'Zeitpunkt']);
  for (const r of rows) {
    csv += csvZeile([r.standort, r.firma || '', r.name, r.schluessel, r.richtung === 'ausgabe' ? 'Ausgabe' : 'Rückgabe', formatZeitDe(r.zeitpunkt)]);
  }
  return csv;
}

app.get('/api/export/firmen', requireAdminSession, (req, res) => {
  const standort = req.admin.standort || req.query.standort;
  if (!standort) return res.json([]);
  if (!adminDarfZugreifen(req, standort)) return res.status(403).json({ error: 'Kein Zugriff auf diesen Standort.' });
  const rows = db.prepare(`SELECT DISTINCT firma FROM schluessel WHERE standort = ? AND firma IS NOT NULL AND firma != '' ORDER BY firma`).all(standort);
  res.json(rows.map(r => r.firma));
});

app.get('/api/smtp-status', requireAdminSession, (req, res) => res.json({ konfiguriert: smtpKonfiguriert }));

app.get('/api/export/schluessel', requireAdminSession, (req, res) => {
  const standort = req.admin.standort || req.query.standort;
  if (!standort) return res.status(400).json({ error: 'Standort erforderlich.' });
  if (!adminDarfZugreifen(req, standort)) return res.status(403).json({ error: 'Kein Zugriff auf diesen Standort.' });
  const rows = schluesselExportZeilen(standort, req.query.firma, req.query.von, req.query.bis);
  const csv = schluesselExportCsv(rows);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="schluessel-export-${slugifyDateiname(standort)}.csv"`);
  res.send(csv);
});

app.post('/api/export/schluessel/senden', requireAdminSession, async (req, res) => {
  if (!smtpKonfiguriert) return res.status(400).json({ error: 'E-Mail-Versand ist nicht konfiguriert (SMTP_* Variablen fehlen).' });
  const standort = req.admin.standort || req.body?.standort;
  if (!standort) return res.status(400).json({ error: 'Standort erforderlich.' });
  if (!adminDarfZugreifen(req, standort)) return res.status(403).json({ error: 'Kein Zugriff auf diesen Standort.' });

  const { firma, von, bis } = req.body || {};
  let email = (req.body?.email || '').trim();
  if (!email && firma) {
    const kunde = db.prepare('SELECT email FROM kunden WHERE firma = ?').get(firma);
    if (kunde?.email) email = kunde.email;
  }
  if (!email) return res.status(400).json({ error: 'Keine E-Mail-Adresse angegeben oder für diese Firma hinterlegt.' });

  const rows = schluesselExportZeilen(standort, firma, von, bis);
  const csv = schluesselExportCsv(rows);

  try {
    await transporter.sendMail({
      from: SMTP_FROM,
      to: email,
      subject: `Schlüssel-Übersicht ${standort}${firma ? ' — ' + firma : ''}`,
      text: `Anbei die Schlüssel-Übersicht für ${firma || standort}.`,
      attachments: [{ filename: `schluessel-export-${slugifyDateiname(standort)}.csv`, content: csv }]
    });
  } catch (err) {
    return res.status(502).json({ error: 'E-Mail konnte nicht gesendet werden. SMTP-Einstellungen prüfen.' });
  }

  protokolliere(req.admin.username, 'export_gesendet', `${standort} / ${firma || 'alle Firmen'} → ${email}`);
  res.json({ ok: true, email });
});

app.get('/api/dashboard/kunden', requireAdminSession, requireSuperadmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM kunden ORDER BY firma').all());
});
app.post('/api/dashboard/kunden', requireAdminSession, requireSuperadmin, (req, res) => {
  const firma = (req.body?.firma || '').trim();
  if (!firma) return res.status(400).json({ error: 'Firma erforderlich.' });
  try {
    const info = db.prepare('INSERT INTO kunden (firma, email, notiz, erstellt_um) VALUES (?, ?, ?, ?)')
      .run(firma, req.body?.email?.trim() || null, req.body?.notiz?.trim() || null, new Date().toISOString());
    protokolliere(req.admin.username, 'kunde_erstellt', firma);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) { res.status(409).json({ error: 'Diese Firma ist bereits als Kunde hinterlegt.' }); }
});
app.patch('/api/dashboard/kunden/:id', requireAdminSession, requireSuperadmin, (req, res) => {
  const row = db.prepare('SELECT * FROM kunden WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nicht gefunden.' });
  db.prepare('UPDATE kunden SET email = ?, notiz = ? WHERE id = ?').run(
    req.body?.email !== undefined ? (req.body.email?.trim() || null) : row.email,
    req.body?.notiz !== undefined ? (req.body.notiz?.trim() || null) : row.notiz,
    req.params.id
  );
  res.json({ ok: true });
});
app.delete('/api/dashboard/kunden/:id', requireAdminSession, requireSuperadmin, (req, res) => {
  const row = db.prepare('SELECT * FROM kunden WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nicht gefunden.' });
  db.prepare('DELETE FROM kunden WHERE id = ?').run(req.params.id);
  protokolliere(req.admin.username, 'kunde_geloescht', row.firma);
  res.json({ ok: true });
});

// --- Dashboard: Standorte ----------------------------------------------------------

app.get('/api/dashboard/standorte', requireAdminSession, requireSuperadmin, (req, res) => {
  const rows = db.prepare(`
    SELECT st.*,
      (SELECT COUNT(*) FROM domains d WHERE d.standort_id = st.id) AS domain_anzahl,
      (SELECT COUNT(*) FROM admin_users u WHERE u.standort_id = st.id) AS nutzer_anzahl
    FROM standorte st ORDER BY st.name
  `).all();
  res.json(rows);
});

app.post('/api/dashboard/standorte', requireAdminSession, requireSuperadmin, (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name erforderlich.' });
  try {
    const info = db.prepare('INSERT INTO standorte (name, erstellt_um) VALUES (?, ?)').run(name, new Date().toISOString());
    protokolliere(req.admin.username, 'standort_erstellt', name);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) { res.status(409).json({ error: 'Ein Standort mit diesem Namen existiert bereits.' }); }
});

app.patch('/api/dashboard/standorte/:id', requireAdminSession, requireSuperadmin, (req, res) => {
  const row = db.prepare('SELECT * FROM standorte WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nicht gefunden.' });
  const { name, willkommenstext } = req.body || {};
  try {
    db.prepare('UPDATE standorte SET name = COALESCE(?, name), willkommenstext = ? WHERE id = ?').run(
      name?.trim() || null,
      willkommenstext !== undefined ? (willkommenstext?.trim() || null) : row.willkommenstext,
      req.params.id
    );
    protokolliere(req.admin.username, 'standort_bearbeitet', row.name);
    res.json({ ok: true });
  } catch (e) { res.status(409).json({ error: 'Ein Standort mit diesem Namen existiert bereits.' }); }
});

app.delete('/api/dashboard/standorte/:id', requireAdminSession, requireSuperadmin, (req, res) => {
  const row = db.prepare('SELECT * FROM standorte WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nicht gefunden.' });
  const domainAnzahl = db.prepare('SELECT COUNT(*) AS n FROM domains WHERE standort_id = ?').get(req.params.id).n;
  const nutzerAnzahl = db.prepare('SELECT COUNT(*) AS n FROM admin_users WHERE standort_id = ?').get(req.params.id).n;
  if (domainAnzahl > 0 || nutzerAnzahl > 0) {
    return res.status(409).json({ error: `Standort kann nicht gelöscht werden: noch ${domainAnzahl} Domain(s) und ${nutzerAnzahl} Nutzer zugeordnet.` });
  }
  if (row.hintergrund_dateiname) fs.unlink(path.join(UPLOADS_DIR, row.hintergrund_dateiname), () => {});
  db.prepare('DELETE FROM standorte WHERE id = ?').run(req.params.id);
  protokolliere(req.admin.username, 'standort_geloescht', row.name);
  res.json({ ok: true });
});

// Kiosk-Hintergrundbild: Upload validiert Dateityp & Größe, Dateiname wird
// zufällig vergeben (verhindert Pfad-Kollisionen & Erraten von Dateinamen).
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) return cb(new Error('Nur PNG, JPEG oder WebP sind erlaubt.'));
    cb(null, true);
  }
});
function handleUpload(req, res, next) {
  upload.single('bild')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message || 'Datei-Upload fehlgeschlagen.' });
    next();
  });
}

app.post('/api/dashboard/standorte/:id/hintergrund', requireAdminSession, requireSuperadmin, handleUpload, (req, res) => {
  const row = db.prepare('SELECT * FROM standorte WHERE id = ?').get(req.params.id);
  if (!row) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(404).json({ error: 'Nicht gefunden.' }); }
  if (!req.file) return res.status(400).json({ error: 'Keine Datei erhalten.' });
  if (row.hintergrund_dateiname) fs.unlink(path.join(UPLOADS_DIR, row.hintergrund_dateiname), () => {});
  db.prepare('UPDATE standorte SET hintergrund_dateiname = ? WHERE id = ?').run(req.file.filename, req.params.id);
  protokolliere(req.admin.username, 'kiosk_hintergrund_geaendert', row.name);
  res.json({ ok: true, url: `/uploads/${req.file.filename}` });
});

app.delete('/api/dashboard/standorte/:id/hintergrund', requireAdminSession, requireSuperadmin, (req, res) => {
  const row = db.prepare('SELECT * FROM standorte WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nicht gefunden.' });
  if (row.hintergrund_dateiname) fs.unlink(path.join(UPLOADS_DIR, row.hintergrund_dateiname), () => {});
  db.prepare('UPDATE standorte SET hintergrund_dateiname = NULL WHERE id = ?').run(req.params.id);
  protokolliere(req.admin.username, 'kiosk_hintergrund_entfernt', row.name);
  res.json({ ok: true });
});

// --- Dashboard: Domains --------------------------------------------------------------

app.get('/api/dashboard/domains', requireAdminSession, requireSuperadmin, (req, res) => {
  res.json(db.prepare(`
    SELECT d.id, d.hostname, d.standort_id, st.name AS standort_name, d.erstellt_um
    FROM domains d JOIN standorte st ON st.id = d.standort_id ORDER BY d.hostname
  `).all());
});

app.post('/api/dashboard/domains', requireAdminSession, requireSuperadmin, (req, res) => {
  const hostname = (req.body?.hostname || '').trim().toLowerCase();
  const standort_id = Number(req.body?.standort_id);
  if (!hostname || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(hostname)) return res.status(400).json({ error: 'Bitte einen gültigen Hostnamen angeben (z. B. standort.example.com).' });
  const standort = db.prepare('SELECT * FROM standorte WHERE id = ?').get(standort_id);
  if (!standort) return res.status(400).json({ error: 'Standort nicht gefunden.' });
  try {
    const info = db.prepare('INSERT INTO domains (hostname, standort_id, erstellt_um) VALUES (?, ?, ?)').run(hostname, standort_id, new Date().toISOString());
    protokolliere(req.admin.username, 'domain_erstellt', `${hostname} → ${standort.name}`);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) { res.status(409).json({ error: 'Diese Domain ist bereits einem Standort zugeordnet.' }); }
});

app.delete('/api/dashboard/domains/:id', requireAdminSession, requireSuperadmin, (req, res) => {
  const row = db.prepare('SELECT * FROM domains WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nicht gefunden.' });
  db.prepare('DELETE FROM domains WHERE id = ?').run(req.params.id);
  protokolliere(req.admin.username, 'domain_geloescht', row.hostname);
  res.json({ ok: true });
});

// --- Dashboard: Nutzer ---------------------------------------------------------------

app.get('/api/dashboard/nutzer', requireAdminSession, requireSuperadmin, (req, res) => {
  res.json(db.prepare(`
    SELECT u.id, u.username, u.standort_id, st.name AS standort_name, u.erstellt_um
    FROM admin_users u LEFT JOIN standorte st ON st.id = u.standort_id ORDER BY u.username
  `).all());
});

app.post('/api/dashboard/nutzer', requireAdminSession, requireSuperadmin, (req, res) => {
  const username = (req.body?.username || '').trim();
  const password = req.body?.password || '';
  const standort_id = req.body?.standort_id ? Number(req.body.standort_id) : null;
  if (!username || password.length < 8) return res.status(400).json({ error: 'Benutzername erforderlich, Passwort mindestens 8 Zeichen.' });
  if (standort_id && !db.prepare('SELECT id FROM standorte WHERE id = ?').get(standort_id)) {
    return res.status(400).json({ error: 'Standort nicht gefunden.' });
  }
  try {
    const info = db.prepare('INSERT INTO admin_users (username, password_hash, standort_id, erstellt_um) VALUES (?, ?, ?, ?)')
      .run(username, hashPassword(password), standort_id, new Date().toISOString());
    protokolliere(req.admin.username, 'nutzer_erstellt', username);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) { res.status(409).json({ error: 'Dieser Benutzername existiert bereits.' }); }
});

app.patch('/api/dashboard/nutzer/:id', requireAdminSession, requireSuperadmin, (req, res) => {
  const row = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nicht gefunden.' });
  const { password, standort_id } = req.body || {};
  if (password && password.length < 8) return res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen haben.' });

  const neuerStandortId = standort_id !== undefined ? (standort_id ? Number(standort_id) : null) : row.standort_id;
  if (neuerStandortId && !db.prepare('SELECT id FROM standorte WHERE id = ?').get(neuerStandortId)) {
    return res.status(400).json({ error: 'Standort nicht gefunden.' });
  }
  if (row.standort_id === null && neuerStandortId !== null) {
    const superadminAnzahl = db.prepare('SELECT COUNT(*) AS n FROM admin_users WHERE standort_id IS NULL').get().n;
    if (superadminAnzahl <= 1) return res.status(409).json({ error: 'Der letzte Superadmin kann nicht auf einen Standort eingeschränkt werden.' });
  }

  db.prepare('UPDATE admin_users SET password_hash = COALESCE(?, password_hash), standort_id = ? WHERE id = ?')
    .run(password ? hashPassword(password) : null, neuerStandortId, req.params.id);
  protokolliere(req.admin.username, 'nutzer_bearbeitet', row.username);
  res.json({ ok: true });
});

app.delete('/api/dashboard/nutzer/:id', requireAdminSession, requireSuperadmin, (req, res) => {
  const row = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Nicht gefunden.' });
  if (row.standort_id === null) {
    const superadminAnzahl = db.prepare('SELECT COUNT(*) AS n FROM admin_users WHERE standort_id IS NULL').get().n;
    if (superadminAnzahl <= 1) return res.status(409).json({ error: 'Der letzte Superadmin kann nicht gelöscht werden.' });
  }
  db.prepare('DELETE FROM admin_users WHERE id = ?').run(req.params.id);
  protokolliere(req.admin.username, 'nutzer_geloescht', row.username);
  res.json({ ok: true });
});

app.get('/api/dashboard/audit-log', requireAdminSession, requireSuperadmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all());
});

// --- Frontend -------------------------------------------------------------------------

app.get('/', (req, res) => {
  const standort = resolveKioskStandort(req.hostname);
  res.set('Cache-Control', 'no-store');
  if (!standort) return res.redirect(302, '/admin');
  const hintergrundUrl = standort.hintergrund_dateiname ? `/uploads/${standort.hintergrund_dateiname}` : '';
  const willkommenstext = (standort.willkommenstext || '').replace(/"/g, '\\"');
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    .replace('__KIOSK_API_KEY__', KIOSK_API_KEY)
    .replace('__STANDORT__', standort.name.replace(/"/g, '\\"'))
    .replace('__HINTERGRUND_URL__', hintergrundUrl)
    .replace('__WILLKOMMENSTEXT__', willkommenstext);
  res.type('html').send(html);
});

app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d' }));
app.use(express.static(PUBLIC_DIR, { index: false }));
app.use((req, res) => res.status(404).json({ error: 'Nicht gefunden.' }));

app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
