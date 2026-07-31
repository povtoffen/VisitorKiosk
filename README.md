# Besucher- & Schlüssel-Terminal

Komplettpaket aus Kiosk-Formular (Frontend) und Node.js/Express-Backend mit
SQLite-Datenbank. Ein einziger Container liefert beides aus:

- `/` — Kiosk-Formular (Besucheranmeldung + Schlüsselausgabe an Handwerker)
- `/admin` — geschützte Verwaltungsansicht (anwesende Besucher abmelden, offene Schlüssel einsehen)
- `/api/*` — REST-API

## Mehrere Standorte

Über die Umgebungsvariable `STANDORTE` (kommagetrennt) lässt sich dieselbe
Installation an mehreren Standorten nutzen:

- Im Kiosk-Formular erscheint eine Standort-Auswahl. Das Terminal merkt sich
  die letzte Auswahl im Browser (`localStorage`) — ein Gerät, das dauerhaft an
  einem Standort steht, muss den Standort also nur einmal einstellen.
- Jeder Besucher- und Schlüssel-Eintrag wird mit seinem Standort gespeichert.
- Die Verwaltungsansicht (`/admin`) kann nach Standort filtern.
- Schlüssel werden **pro Standort** getrackt: Ein Schlüssel "Raum 1" in
  "Hauptgebäude" ist unabhängig von einem gleichnamigen Schlüssel in
  "Lager Nord".

Ist `STANDORTE` nicht gesetzt, gibt es einen einzelnen Standort ("Standort").

Falls die Datenbank aus einer früheren Version ohne Standort-Feld stammt,
wird die Spalte beim Start automatisch nachgerüstet (bestehende Einträge
erhalten den Platzhalter-Standort "Unbekannt"). Kein manueller Eingriff
nötig, ein Redeploy reicht.

## Schlüssel-Rückgabe nur für tatsächlich ausgegebene Schlüssel

- Beim Anlegen einer Rückgabe zeigt das Kiosk-Formular nur Schlüssel zur
  Auswahl an, die am gewählten Standort aktuell als ausgegeben erfasst sind
  (Dropdown statt Freitext) — abgefragt über `GET /api/schluessel/offene-liste`.
- Der Server validiert zusätzlich serverseitig: Eine Rückgabe wird abgelehnt,
  wenn für diesen Schlüssel/Standort keine offene Ausgabe existiert. Eine
  erneute Ausgabe wird abgelehnt, solange der Schlüssel noch als ausgegeben
  gilt.
- In der Verwaltung (`/admin`, Tab "Schlüssel", Filter "nur offene Schlüssel")
  kann ein Schlüssel auch direkt per Klick auf "Zurückgeben" erfasst werden,
  ohne dass der Handwerker noch einmal zum Kiosk-Terminal muss.

## Absicherung

Es gibt zwei getrennte Keys, damit ein kompromittierter Kiosk-Key nicht auch
die Verwaltung offenlegt:

- **`ADMIN_API_KEY`** schützt `/api/besucher` (GET), `/api/schluessel` (GET) und
  das Abmelden von Besuchern. Das ist der eigentliche Schutz sensibler Daten
  (Namen, Firmen, Anwesenheit) — diesen Key nur an berechtigte Personen geben.
  Die `/admin`-Seite fragt ihn beim Aufruf ab und hält ihn nur im
  `sessionStorage` des Browsers (nicht im Code).
- **`KIOSK_API_KEY`** schützt die Schreib-Endpunkte (`POST /api/besucher`,
  `POST /api/schluessel`) vor wahllosem Bot-Traffic von außen und wird beim
  Laden von `/` serverseitig aus der Umgebungsvariable ins HTML eingesetzt —
  er steht also **nicht** im Git-Repo. Wichtig zu wissen: Da das Kiosk-Terminal
  öffentlich zugänglich ist, ist dieser Key über "Seitenquelltext anzeigen"
  trotzdem einsehbar. Er verhindert automatisierten Missbrauch (zusätzlich per
  Rate-Limit begrenzt), ist aber kein Geheimnis gegenüber jemandem, der direkt
  am Terminal steht. Für vollen Schutz gegen Missbrauch am Terminal selbst
  (z. B. physisches Absichern des Geräts, Kiosk-Modus im Browser ohne
  Adressleiste/Entwicklertools) sollte zusätzlich am Gerät selbst angesetzt werden.

Beide Keys sollten lang und zufällig sein, z. B. per `openssl rand -hex 24`
erzeugt. Setze niemals `KIOSK_API_KEY` und `ADMIN_API_KEY` auf denselben Wert.

## Lokal starten

```bash
cp .env.example .env
# .env anpassen: KIOSK_API_KEY und ADMIN_API_KEY setzen
npm install
npm start
```

Kiosk: `http://localhost:3000/`
Verwaltung: `http://localhost:3000/admin`

## Deployment via Coolify

1. Projekt in ein Git-Repository pushen.
2. In Coolify eine neue Ressource per Git-Deployment anlegen, `docker-compose.yml`
   als Compose-Datei auswählen (analog zum bestehenden VisitorPortal-Setup).
3. Umgebungsvariablen in Coolify setzen: `KIOSK_API_KEY`, `ADMIN_API_KEY`, `CORS_ORIGIN`.
4. Das Volume `besucher-data` sorgt für persistente Speicherung der SQLite-Datei
   über Neustarts/Deployments hinweg.
5. Domain/Reverse-Proxy mit HTTPS einrichten (in Coolify Standard) — ohne HTTPS
   werden beide API-Keys unverschlüsselt übertragen.

## API

| Methode | Pfad | Auth | Zweck |
|---|---|---|---|
| GET | `/api/health` | — | Health-Check |
| GET | `/api/standorte` | — | Konfigurierte Standort-Liste |
| POST | `/api/besucher` | `KIOSK_API_KEY` | Neue Besucheranmeldung |
| GET | `/api/besucher?offen=true&standort=` | `ADMIN_API_KEY` | Aktuell anwesende Besucher |
| PATCH | `/api/besucher/:id/abmelden` | `ADMIN_API_KEY` | Besucher abmelden |
| POST | `/api/schluessel` | `KIOSK_API_KEY` | Schlüsselvorgang (ausgabe/rueckgabe), serverseitig validiert |
| GET | `/api/schluessel?offen=true&standort=` | `ADMIN_API_KEY` | Aktuell ausgegebene Schlüssel |
| GET | `/api/schluessel/offene-liste?standort=` | `KIOSK_API_KEY` | Offene Schlüssel für das Rückgabe-Dropdown im Kiosk |
| PATCH | `/api/schluessel/:id/zurueckgeben` | `ADMIN_API_KEY` | Schlüssel direkt im Portal zurücknehmen |

Auth erfolgt jeweils über den Header `x-api-key`. `/api/standorte` ist
bewusst ohne Auth, da nur Standort-Namen (keine personenbezogenen Daten)
zurückgegeben werden.

## Struktur

```
server.js        Express-App: API + Ausliefern des Frontends
db.js             SQLite-Schema und Verbindung
public/index.html Kiosk-Formular
public/admin.html Verwaltungsansicht
Dockerfile         Multi-Stage-Build (kompiliert better-sqlite3)
docker-compose.yml Für Coolify-Deployment mit persistentem Volume
```
