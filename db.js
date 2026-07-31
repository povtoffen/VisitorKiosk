const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'data.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Tabellen anlegen, falls sie noch nicht existieren (frische Installation).
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

  CREATE TABLE IF NOT EXISTS admin_users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    standort TEXT
  );
`);

// Migration: bestehende Installationen bekommen fehlende Spalten nachgerüstet,
// statt beim Start abzustürzen.
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

// --- Admin-Benutzer aus Umgebungsvariable synchronisieren -------------------
// ADMIN_USERS="username:passwort:standort;username2:passwort2:standort2"
// Standort leer lassen => Zugriff auf alle Standorte (Superadmin).
// Die Umgebungsvariable ist die Quelle der Wahrheit: bestehende Nutzer werden
// aktualisiert, nicht mehr in der Variable enthaltene Nutzer werden entfernt.
function syncAdminUsers() {
  const raw = process.env.ADMIN_USERS || '';
  const eintraege = raw.split(';').map(s => s.trim()).filter(Boolean);
  const aktuelleUsernames = [];

  for (const eintrag of eintraege) {
    const teile = eintrag.split(':');
    const username = (teile[0] || '').trim();
    const passwort = (teile[1] || '').trim();
    const standort = (teile[2] || '').trim() || null;
    if (!username || !passwort) continue;
    aktuelleUsernames.push(username);
    const hash = hashPassword(passwort);
    db.prepare(`
      INSERT INTO admin_users (username, password_hash, standort)
      VALUES (?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, standort = excluded.standort
    `).run(username, hash, standort);
  }

  if (aktuelleUsernames.length) {
    const platzhalter = aktuelleUsernames.map(() => '?').join(',');
    db.prepare(`DELETE FROM admin_users WHERE username NOT IN (${platzhalter})`).run(...aktuelleUsernames);
  } else {
    db.exec('DELETE FROM admin_users');
  }

  if (!eintraege.length) {
    console.warn('[WARN] ADMIN_USERS ist nicht gesetzt. Es existieren aktuell keine Admin-Zugänge.');
  }
}

syncAdminUsers();

module.exports = { db, verifyPassword };
