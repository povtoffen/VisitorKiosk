require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const KIOSK_API_KEY = process.env.KIOSK_API_KEY || '';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const STANDORTE = (process.env.STANDORTE || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!KIOSK_API_KEY || !ADMIN_API_KEY) {
  console.warn(
    '[WARN] KIOSK_API_KEY und/oder ADMIN_API_KEY sind nicht gesetzt. ' +
    'Bitte in der .env-Datei bzw. den Coolify-Umgebungsvariablen konfigurieren.'
  );
}
if (KIOSK_API_KEY && ADMIN_API_KEY && KIOSK_API_KEY === ADMIN_API_KEY) {
  console.warn('[WARN] KIOSK_API_KEY und ADMIN_API_KEY sind identisch. Bitte unterschiedliche Werte verwenden.');
}
if (!STANDORTE.length) {
  console.warn('[WARN] STANDORTE ist nicht gesetzt. Es wird ein einzelner Standort "Standort" verwendet.');
}
const STANDORT_LISTE = STANDORTE.length ? STANDORTE : ['Standort'];

const app = express();
app.use(express.json());
app.use(cors({ origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',') }));

function requireKioskKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!KIOSK_API_KEY || key !== KIOSK_API_KEY) {
    return res.status(401).json({ error: 'Ungültiger oder fehlender API-Key.' });
  }
  next();
}

function requireAdminKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!ADMIN_API_KEY || key !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Ungültiger oder fehlender Admin-API-Key.' });
  }
  next();
}

function validStandort(standort) {
  return typeof standort === 'string' && standort.trim() && STANDORT_LISTE.includes(standort.trim());
}

const kioskLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
const kioskReadLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
// Grober Schutz gegen automatisiertes Durchprobieren des Admin-Keys.
const adminLoginLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/standorte', (req, res) => res.json(STANDORT_LISTE));

// --- Besucher ---------------------------------------------------------

app.post('/api/besucher', kioskLimiter, requireKioskKey, (req, res) => {
  const { standort, name, firma, ansprechpartner, grund } = req.body || {};
  if (!validStandort(standort)) {
    return res.status(400).json({ error: 'Unbekannter oder fehlender Standort.' });
  }
  if (!name || !ansprechpartner) {
    return res.status(400).json({ error: 'name und ansprechpartner sind erforderlich.' });
  }
  const angemeldet_um = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO besucher (standort, name, firma, ansprechpartner, grund, angemeldet_um)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(standort.trim(), name.trim(), firma?.trim() || null, ansprechpartner.trim(), grund?.trim() || null, angemeldet_um);
  res.status(201).json({ id: info.lastInsertRowid, angemeldet_um });
});

app.get('/api/besucher', adminLoginLimiter, requireAdminKey, (req, res) => {
  const { offen, standort } = req.query;
  const clauses = [];
  const params = [];
  if (offen === 'true') clauses.push('abgemeldet_um IS NULL');
  if (standort) { clauses.push('standort = ?'); params.push(standort); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM besucher ${where} ORDER BY angemeldet_um DESC LIMIT 500`).all(...params);
  res.json(rows);
});

app.patch('/api/besucher/:id/abmelden', requireAdminKey, (req, res) => {
  const abgemeldet_um = new Date().toISOString();
  const info = db.prepare('UPDATE besucher SET abgemeldet_um = ? WHERE id = ? AND abgemeldet_um IS NULL')
    .run(abgemeldet_um, req.params.id);
  if (info.changes === 0) {
    return res.status(404).json({ error: 'Besucher nicht gefunden oder bereits abgemeldet.' });
  }
  res.json({ id: Number(req.params.id), abgemeldet_um });
});

// --- Schlüssel ----------------------------------------------------------

// Liefert dem Kiosk die aktuell ausgegebenen Schlüssel eines Standorts, damit
// bei der Rückgabe nur tatsächlich ausgegebene Schlüssel auswählbar sind.
app.get('/api/schluessel/offene-liste', kioskReadLimiter, requireKioskKey, (req, res) => {
  const { standort } = req.query;
  if (!validStandort(standort)) {
    return res.status(400).json({ error: 'Unbekannter oder fehlender Standort.' });
  }
  const rows = db.prepare(`
    SELECT s.schluessel, s.name, s.firma
    FROM schluessel s
    INNER JOIN (
      SELECT schluessel, MAX(id) AS max_id
      FROM schluessel
      WHERE standort = ?
      GROUP BY schluessel
    ) latest ON latest.schluessel = s.schluessel AND latest.max_id = s.id
    WHERE s.standort = ? AND s.richtung = 'ausgabe'
    ORDER BY s.schluessel ASC
  `).all(standort, standort);
  res.json(rows);
});

function findOffenenSchluessel(standort, schluessel) {
  return db.prepare(`
    SELECT s.*
    FROM schluessel s
    INNER JOIN (
      SELECT schluessel, MAX(id) AS max_id
      FROM schluessel
      WHERE standort = ? AND schluessel = ?
      GROUP BY schluessel
    ) latest ON latest.schluessel = s.schluessel AND latest.max_id = s.id
    WHERE s.standort = ? AND s.schluessel = ? AND s.richtung = 'ausgabe'
  `).get(standort, schluessel, standort, schluessel);
}

app.post('/api/schluessel', kioskLimiter, requireKioskKey, (req, res) => {
  const { standort, name, firma, schluessel, richtung } = req.body || {};
  if (!validStandort(standort)) {
    return res.status(400).json({ error: 'Unbekannter oder fehlender Standort.' });
  }
  if (!name || !schluessel || !['ausgabe', 'rueckgabe'].includes(richtung)) {
    return res.status(400).json({ error: 'name, schluessel und richtung (ausgabe|rueckgabe) sind erforderlich.' });
  }

  const standortTrim = standort.trim();
  const schluesselTrim = schluessel.trim();
  const offenerEintrag = findOffenenSchluessel(standortTrim, schluesselTrim);

  if (richtung === 'ausgabe' && offenerEintrag) {
    return res.status(409).json({ error: `Schlüssel "${schluesselTrim}" ist bereits ausgegeben und noch nicht zurückgegeben.` });
  }
  if (richtung === 'rueckgabe' && !offenerEintrag) {
    return res.status(400).json({ error: `Schlüssel "${schluesselTrim}" ist aktuell nicht als ausgegeben erfasst.` });
  }

  const zeitpunkt = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO schluessel (standort, name, firma, schluessel, richtung, zeitpunkt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(standortTrim, name.trim(), firma?.trim() || null, schluesselTrim, richtung, zeitpunkt);
  res.status(201).json({ id: info.lastInsertRowid, zeitpunkt });
});

app.get('/api/schluessel', adminLoginLimiter, requireAdminKey, (req, res) => {
  const { offen, standort } = req.query;
  if (offen === 'true') {
    const clauses = ["s.richtung = 'ausgabe'"];
    const params = [];
    if (standort) { clauses.push('latest.standort = ?'); params.push(standort); }
    const rows = db.prepare(`
      SELECT s.*
      FROM schluessel s
      INNER JOIN (
        SELECT standort, schluessel, MAX(id) AS max_id
        FROM schluessel
        GROUP BY standort, schluessel
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
  const rows = db.prepare(`SELECT * FROM schluessel ${where} ORDER BY zeitpunkt DESC LIMIT 500`).all(...params);
  res.json(rows);
});

// Erlaubt der Verwaltung, einen ausgegebenen Schlüssel direkt im Portal zurückzunehmen,
// ohne dass der Handwerker erneut am Kiosk-Terminal vorbeikommen muss.
app.patch('/api/schluessel/:id/zurueckgeben', requireAdminKey, (req, res) => {
  const ausgabe = db.prepare(`SELECT * FROM schluessel WHERE id = ? AND richtung = 'ausgabe'`).get(req.params.id);
  if (!ausgabe) {
    return res.status(404).json({ error: 'Ausgabe-Eintrag nicht gefunden.' });
  }
  const offenerEintrag = findOffenenSchluessel(ausgabe.standort, ausgabe.schluessel);
  if (!offenerEintrag || offenerEintrag.id !== ausgabe.id) {
    return res.status(409).json({ error: 'Dieser Schlüssel wurde bereits zurückgegeben.' });
  }
  const zeitpunkt = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO schluessel (standort, name, firma, schluessel, richtung, zeitpunkt)
    VALUES (?, ?, ?, ?, 'rueckgabe', ?)
  `).run(ausgabe.standort, ausgabe.name, ausgabe.firma, ausgabe.schluessel, zeitpunkt);
  res.status(201).json({ id: info.lastInsertRowid, zeitpunkt });
});

// --- Frontend -------------------------------------------------------------

// Kiosk-Seite: KIOSK_API_KEY und die Standort-Liste werden erst hier aus den
// Umgebungsvariablen eingesetzt, stehen also nicht im Git-Repo.
app.get('/', (req, res) => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    .replace('__KIOSK_API_KEY__', KIOSK_API_KEY)
    .replace('"__STANDORTE__"', JSON.stringify(STANDORT_LISTE));
  res.type('html').send(html);
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.use(express.static(PUBLIC_DIR, { index: false }));

app.use((req, res) => res.status(404).json({ error: 'Nicht gefunden.' }));

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
