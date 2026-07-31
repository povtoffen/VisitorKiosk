const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'data.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

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

  CREATE INDEX IF NOT EXISTS idx_besucher_offen ON besucher (abgemeldet_um);
  CREATE INDEX IF NOT EXISTS idx_schluessel_schluessel ON schluessel (schluessel);
`);

module.exports = db;
