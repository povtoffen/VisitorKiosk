# Besucher- & Schlüssel-Terminal

Komplettpaket aus Kiosk-Formular (Frontend) und Node.js/Express-Backend mit
SQLite-Datenbank. Ein einziger Container liefert beides aus:

- `/` — Kiosk-Formular (Besucheranmeldung + Schlüsselausgabe an Handwerker)
- `/admin` — geschützte Verwaltungsansicht (anwesende Besucher abmelden, offene Schlüssel einsehen)
- `/api/*` — REST-API

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
| POST | `/api/besucher` | `KIOSK_API_KEY` | Neue Besucheranmeldung |
| GET | `/api/besucher?offen=true` | `ADMIN_API_KEY` | Aktuell anwesende Besucher |
| PATCH | `/api/besucher/:id/abmelden` | `ADMIN_API_KEY` | Besucher abmelden |
| POST | `/api/schluessel` | `KIOSK_API_KEY` | Schlüsselvorgang (ausgabe/rueckgabe) |
| GET | `/api/schluessel?offen=true` | `ADMIN_API_KEY` | Aktuell ausgegebene Schlüssel |

Auth erfolgt jeweils über den Header `x-api-key`.

## Struktur

```
server.js        Express-App: API + Ausliefern des Frontends
db.js             SQLite-Schema und Verbindung
public/index.html Kiosk-Formular
public/admin.html Verwaltungsansicht
Dockerfile         Multi-Stage-Build (kompiliert better-sqlite3)
docker-compose.yml Für Coolify-Deployment mit persistentem Volume
```
