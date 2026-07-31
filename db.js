const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'data.db');
const DATA_DIR = path.dirname(DB_PATH);

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// --- Grundschema (frische Installation) -------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS besucher (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    firma TEXT,
    ansprechpartner TEXT NOT NULL,
    grund TEXT,
    angemeldet_um TEXT NOT NULL,
    abgemeldet_um TEXT
  );

  CREATE TABLE IF NOT EXISTS handwerker (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    standort TEXT NOT NULL,
    name TEXT NOT NULL,
    firma TEXT,
    schluessel TEXT,
    angemeldet_um TEXT NOT NULL,
    abgemeldet_um TEXT
  );

  CREATE TABLE IF NOT EXISTS schluessel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    firma TEXT,
    schluessel TEXT NOT NULL,
    richtung TEXT NOT NULL CHECK (richtung IN ('ausgabe', 'rueckgabe')),
    zeitpunkt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS standorte (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    hintergrund_dateiname TEXT,
    willkommenstext TEXT,
    erstellt_um TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hostname TEXT NOT NULL UNIQUE,
    standort_id INTEGER NOT NULL REFERENCES standorte(id) ON DELETE CASCADE,
    erstellt_um TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    standort_id INTEGER REFERENCES standorte(id) ON DELETE SET NULL,
    erstellt_um TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kunden (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firma TEXT NOT NULL UNIQUE,
    email TEXT,
    notiz TEXT,
    erstellt_um TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zeitpunkt TEXT NOT NULL,
    username TEXT NOT NULL,
    aktion TEXT NOT NULL,
    detail TEXT
  );
`);

// --- Migration: fehlende Spalten an bestehenden Installationen nachrüsten ---

function spalteHinzufuegenFallsFehlt(tabelle, spalte, definition) {
  const vorhandeneSpalten = db.prepare(`PRAGMA table_info(${tabelle})`).all().map(c => c.name);
  if (!vorhandeneSpalten.includes(spalte)) {
    db.exec(`ALTER TABLE ${tabelle} ADD COLUMN ${spalte} ${definition}`);
    console.log(`[MIGRATION] Spalte "${spalte}" zu "${tabelle}" hinzugefügt.`);
  }
}

spalteHinzufuegenFallsFehlt('besucher', 'standort', `TEXT NOT NULL DEFAULT 'Unbekannt'`);
spalteHinzufuegenFallsFehlt('schluessel', 'standort', `TEXT NOT NULL DEFAULT 'Unbekannt'`);
spalteHinzufuegenFallsFehlt('schluessel', 'handwerker_id', `INTEGER REFERENCES handwerker(id)`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_besucher_offen ON besucher (abgemeldet_um);
  CREATE INDEX IF NOT EXISTS idx_besucher_standort ON besucher (standort);
  CREATE INDEX IF NOT EXISTS idx_handwerker_offen ON handwerker (abgemeldet_um);
  CREATE INDEX IF NOT EXISTS idx_handwerker_standort ON handwerker (standort);
  CREATE INDEX IF NOT EXISTS idx_schluessel_standort_schluessel ON schluessel (standort, schluessel);
  CREATE INDEX IF NOT EXISTS idx_schluessel_standort_firma ON schluessel (standort, firma);
  CREATE INDEX IF NOT EXISTS idx_admin_users_standort ON admin_users (standort_id);
`);

// --- Passwort-Hashing (Node-eigenes crypto, keine zusätzliche Abhängigkeit) ---

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const berechnet = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(berechnet, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Liefert die ID eines Standorts anhand des Namens, legt ihn bei Bedarf an
// (genutzt bei Migration/Import, wo Standorte bislang nur als Text existierten).
function sicherstellenStandort(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return null;
  const bestehend = db.prepare('SELECT id FROM standorte WHERE name = ?').get(trimmed);
  if (bestehend) return bestehend.id;
  const info = db.prepare('INSERT INTO standorte (name, erstellt_um) VALUES (?, ?)').run(trimmed, new Date().toISOString());
  return info.lastInsertRowid;
}

// --- Migration: admin_users vom alten Schema (username als Primärschlüssel,
// Standort als Text) auf das neue Schema (ID-Nutzer, Standorte-Tabelle) heben.

function migriereAdminUsersFallsNoetig() {
  const spalten = db.prepare(`PRAGMA table_info(admin_users)`).all().map(c => c.name);
  const hatAltesFormat = spalten.includes('standort') && !spalten.includes('standort_id');
  if (!hatAltesFormat) return;

  console.log('[MIGRATION] admin_users wird auf das neue Schema (Standorte-Tabelle) migriert.');
  const alteZeilen = db.prepare('SELECT username, password_hash, standort FROM admin_users').all();
  db.exec('ALTER TABLE admin_users RENAME TO admin_users_alt_migration');
  db.exec(`
    CREATE TABLE admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      standort_id INTEGER REFERENCES standorte(id) ON DELETE SET NULL,
      erstellt_um TEXT NOT NULL
    )
  `);
  const jetzt = new Date().toISOString();
  for (const alt of alteZeilen) {
    const standort_id = alt.standort ? sicherstellenStandort(alt.standort) : null;
    db.prepare('INSERT INTO admin_users (username, password_hash, standort_id, erstellt_um) VALUES (?, ?, ?, ?)')
      .run(alt.username, alt.password_hash, standort_id, jetzt);
  }
  db.exec('DROP TABLE admin_users_alt_migration');
  console.log(`[MIGRATION] ${alteZeilen.length} Admin-Nutzer migriert (Passwörter blieben erhalten).`);
}

migriereAdminUsersFallsNoetig();

// --- Einmaliger Import aus Umgebungsvariablen (nur wenn Tabellen noch leer) --
// Danach ist die Datenbank die Quelle der Wahrheit; Verwaltung läuft über
// das Dashboard (/admin), nicht mehr über diese Variablen.

function seedFallsLeer() {
  const standortAnzahlVorher = db.prepare('SELECT COUNT(*) AS n FROM standorte').get().n;
  if (standortAnzahlVorher === 0 && process.env.STANDORTE) {
    process.env.STANDORTE.split(',').map(s => s.trim()).filter(Boolean).forEach(name => {
      sicherstellenStandort(name);
    });
    console.log('[SEED] Standorte aus STANDORTE importiert.');
  }

  const domainAnzahl = db.prepare('SELECT COUNT(*) AS n FROM domains').get().n;
  if (domainAnzahl === 0 && process.env.STANDORT_DOMAINS) {
    process.env.STANDORT_DOMAINS.split(',').map(s => s.trim()).filter(Boolean).forEach(eintrag => {
      const idx = eintrag.indexOf('=');
      if (idx === -1) return;
      const host = eintrag.slice(0, idx).trim().toLowerCase();
      const standortName = eintrag.slice(idx + 1).trim();
      if (!host || !standortName) return;
      const standortId = sicherstellenStandort(standortName);
      db.prepare('INSERT OR IGNORE INTO domains (hostname, standort_id, erstellt_um) VALUES (?, ?, ?)')
        .run(host, standortId, new Date().toISOString());
    });
    console.log('[SEED] Domains aus STANDORT_DOMAINS importiert.');
  }

  const nutzerAnzahlVorher = db.prepare('SELECT COUNT(*) AS n FROM admin_users').get().n;
  if (nutzerAnzahlVorher === 0 && process.env.ADMIN_USERS) {
    process.env.ADMIN_USERS.split(';').map(s => s.trim()).filter(Boolean).forEach(eintrag => {
      const teile = eintrag.split(':');
      const username = (teile[0] || '').trim();
      const passwort = (teile[1] || '').trim();
      const standortName = (teile[2] || '').trim();
      if (!username || !passwort) return;
      const standortId = standortName ? sicherstellenStandort(standortName) : null;
      db.prepare('INSERT OR IGNORE INTO admin_users (username, password_hash, standort_id, erstellt_um) VALUES (?, ?, ?, ?)')
        .run(username, hashPassword(passwort), standortId, new Date().toISOString());
    });
    console.log('[SEED] Admin-Nutzer aus ADMIN_USERS importiert.');
  }

  if (nutzerAnzahlVorher === 0 && !process.env.ADMIN_USERS) {
    console.warn('[WARN] Keine Admin-Nutzer vorhanden und ADMIN_USERS nicht gesetzt. Ohne Zugang ist das Dashboard nicht erreichbar.');
  }
}

seedFallsLeer();

module.exports = { db, verifyPassword, hashPassword, sicherstellenStandort, DATA_DIR };
