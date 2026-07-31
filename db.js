const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

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

  CREATE TABLE IF NOT EXISTS schluessel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    firma TEXT,
    schluessel TEXT NOT NULL,
    richtung TEXT NOT NULL CHECK (richtung IN ('ausgabe', 'rueckgabe')),
    zeitpunkt TEXT NOT NULL
  );
`);

// Migration: bestehende Installationen (vor Einführung von "standort") bekommen
// die Spalte nachträglich hinzugefügt, statt beim Start abzustürzen.
function spalteHinzufuegenFallsFehlt(tabelle, spalte, definition) {
  const vorhandeneSpalten = db.prepare(`PRAGMA table_info(${tabelle})`).all().map(c => c.name);
  if (!vorhandeneSpalten.includes(spalte)) {
    db.exec(`ALTER TABLE ${tabelle} ADD COLUMN ${spalte} ${definition}`);
    console.log(`[MIGRATION] Spalte "${spalte}" zu "${tabelle}" hinzugefügt.`);
  }
}

spalteHinzufuegenFallsFehlt('besucher', 'standort', `TEXT NOT NULL DEFAULT 'Unbekannt'`);
spalteHinzufuegenFallsFehlt('schluessel', 'standort', `TEXT NOT NULL DEFAULT 'Unbekannt'`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_besucher_offen ON besucher (abgemeldet_um);
  CREATE INDEX IF NOT EXISTS idx_besucher_standort ON besucher (standort);
  CREATE INDEX IF NOT EXISTS idx_schluessel_standort_schluessel ON schluessel (standort, schluessel);
`);

module.exports = db;
