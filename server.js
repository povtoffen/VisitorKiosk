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

const kioskLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
// Grober Schutz gegen automatisiertes Durchprobieren des Admin-Keys.
const adminLoginLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// --- Besucher ---------------------------------------------------------

app.post('/api/besucher', kioskLimiter, requireKioskKey, (req, res) => {
  const { name, firma, ansprechpartner, grund } = req.body || {};
  if (!name || !ansprechpartner) {
    return res.status(400).json({ error: 'name und ansprechpartner sind erforderlich.' });
  }
  const angemeldet_um = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO besucher (name, firma, ansprechpartner, grund, angemeldet_um)
    VALUES (?, ?, ?, ?, ?)
  `).run(name.trim(), firma?.trim() || null, ansprechpartner.trim(), grund?.trim() || null, angemeldet_um);
  res.status(201).json({ id: info.lastInsertRowid, angemeldet_um });
});

app.get('/api/besucher', adminLoginLimiter, requireAdminKey, (req, res) => {
  const rows = req.query.offen === 'true'
    ? db.prepare('SELECT * FROM besucher WHERE abgemeldet_um IS NULL ORDER BY angemeldet_um DESC').all()
    : db.prepare('SELECT * FROM besucher ORDER BY angemeldet_um DESC LIMIT 500').all();
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

app.post('/api/schluessel', kioskLimiter, requireKioskKey, (req, res) => {
  const { name, firma, schluessel, richtung } = req.body || {};
  if (!name || !schluessel || !['ausgabe', 'rueckgabe'].includes(richtung)) {
    return res.status(400).json({ error: 'name, schluessel und richtung (ausgabe|rueckgabe) sind erforderlich.' });
  }
  const zeitpunkt = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO schluessel (name, firma, schluessel, richtung, zeitpunkt)
    VALUES (?, ?, ?, ?, ?)
  `).run(name.trim(), firma?.trim() || null, schluessel.trim(), richtung, zeitpunkt);
  res.status(201).json({ id: info.lastInsertRowid, zeitpunkt });
});

app.get('/api/schluessel', adminLoginLimiter, requireAdminKey, (req, res) => {
  if (req.query.offen === 'true') {
    const rows = db.prepare(`
      SELECT s.*
      FROM schluessel s
      INNER JOIN (
        SELECT schluessel, MAX(id) AS max_id FROM schluessel GROUP BY schluessel
      ) latest ON latest.schluessel = s.schluessel AND latest.max_id = s.id
      WHERE s.richtung = 'ausgabe'
      ORDER BY s.zeitpunkt DESC
    `).all();
    return res.json(rows);
  }
  const rows = db.prepare('SELECT * FROM schluessel ORDER BY zeitpunkt DESC LIMIT 500').all();
  res.json(rows);
});

// --- Frontend -------------------------------------------------------------

// Kiosk-Seite: KIOSK_API_KEY wird erst hier aus der Umgebungsvariable eingesetzt,
// steht also nicht im Git-Repo, sondern nur zur Laufzeit im ausgelieferten HTML.
app.get('/', (req, res) => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    .replace('__KIOSK_API_KEY__', KIOSK_API_KEY);
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
