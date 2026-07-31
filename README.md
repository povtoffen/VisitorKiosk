# Besucher- & Schlüssel-Terminal

Kiosk-Formular (Multi-Step-Assistent) + Node.js/Express-Backend mit SQLite.
Ein einziger Container liefert beides aus:

- `/` — Kiosk-Assistent, fest an einen Standort gebunden (Besucher- und
  Handwerker-Anmeldung, Selbst-Abmeldung)
- `/admin` — Verwaltungsportal mit Benutzer/Passwort-Login, editierbaren
  Einträgen und optionaler Standort-Einschränkung pro Zugang
- `/api/*` — REST-API

## Der Kiosk-Ablauf

Start-Bildschirm mit drei großen Buttons:

- **Ich bin Besucher** → Name → Firma → Ansprechpartner/Grund → Bestätigen
- **Ich bin Handwerker** → Name → Firma → „Brauchen Sie einen Schlüssel?"
  (Ja/Nein) → ggf. welchen → Bestätigen
- **Ich möchte mich abmelden** → Liste aller aktuell anwesenden Besucher und
  Handwerker am Standort → auswählen → ggf. Schlüsselrückgabe bestätigen →
  fertig

Der **Standort ist am Kiosk nicht wechselbar** — er wird serverseitig anhand
des aufgerufenen Hostnamens fest zugeordnet (siehe unten), damit niemand
versehentlich den falschen Standort einträgt.

## Standort-Zuordnung (mit Vorbereitung für Subdomains/Wildcard)

- **Ein einziger Standort:** `STANDORTE` auf genau einen Eintrag setzen —
  der Kiosk verwendet ihn automatisch, `STANDORT_DOMAINS` wird nicht benötigt.
- **Mehrere Standorte über Subdomains:** `STANDORTE` mit allen Standorten
  befüllen und zusätzlich `STANDORT_DOMAINS` setzen, z. B.:
  ```
  STANDORT_DOMAINS=hauptgebaeude.empfang.example.com=Hauptgebäude,lager-nord.empfang.example.com=Lager Nord
  ```
  Jedes Kiosk-Gerät ruft dann nur seine eigene, feste Subdomain auf (als
  Startseite im Kiosk-Modus des Browsers hinterlegen) und bekommt darüber
  automatisch den richtigen Standort — ganz ohne Auswahl.

  **Hinweis zu "Wildcard":** Ein echtes Wildcard-TLS-Zertifikat (`*.example.com`)
  ist dafür nicht zwingend nötig. Es reicht, in Coolify für dieselbe Ressource
  mehrere Domains einzutragen (eine pro Standort) — Coolify/Traefik stellt für
  jede davon automatisch ein eigenes Let's-Encrypt-Zertifikat aus. Ein echtes
  Wildcard-Zertifikat lohnt sich nur, wenn ihr Standorte spontan hinzufügen
  wollt, ohne jedes Mal eine neue Domain in Coolify einzutragen — dafür braucht
  euer DNS-Anbieter dann einen von Coolify unterstützten DNS-01-Provider.
- Ist ein Hostname weder in `STANDORT_DOMAINS` hinterlegt noch der einzige
  konfigurierte Standort, zeigt `/` eine Fehlerseite statt zu raten.

## Admin-Zugänge pro Standort

Über `ADMIN_USERS` (Format `username:passwort:standort`, mehrere getrennt mit
`;`) werden Zugänge angelegt:

```
ADMIN_USERS=chef:geheim1:;hauptgebaeude:geheim2:Hauptgebäude;lagernord:geheim3:Lager Nord
```

- Ein Zugang mit **leerem Standort** ist ein Superadmin und sieht/verwaltet
  alle Standorte (inkl. Standort-Filter im Portal).
- Ein Zugang mit **gesetztem Standort** sieht und bearbeitet ausschließlich
  Einträge dieses Standorts — Zugriffsversuche auf andere Standorte werden
  serverseitig abgelehnt (nicht nur in der Oberfläche versteckt).
- Die Umgebungsvariable ist die Quelle der Wahrheit: Passwörter werden bei
  jedem Start neu gehasht und synchronisiert, nicht mehr gelistete Zugänge
  werden entfernt. Ein Passwort ändern = Env-Variable anpassen + Redeploy.
- Passwörter werden nie im Klartext gespeichert (scrypt-Hash), Logins laufen
  über eine signierte, httpOnly-Session-Cookie (`SESSION_SECRET` erforderlich).

## Verwaltungsportal (`/admin`)

- Drei Tabs: **Besucher**, **Handwerker**, **Schlüssel-Log**
- „Bearbeiten" pro Zeile: Name, Firma und weitere Felder direkt inline
  korrigierbar (z. B. Tippfehler)
- „Abmelden" pro Zeile: meldet den Eintrag ab; bei Handwerkern mit offenem
  Schlüssel wird dieser automatisch mit zurückgenommen
- Tab „Schlüssel-Log": vollständige Historie aller Schlüsselbewegungen,
  mit manuellem „Zurückgeben" als Fallback (falls doch mal nicht über den
  Kiosk abgemeldet wurde)

## Absicherung

- **`SESSION_SECRET`** signiert die Admin-Login-Sessions (httpOnly-Cookie,
  12 Stunden gültig). Ohne diesen Wert funktionieren Admin-Logins nicht sicher.
- **`ADMIN_USERS`** ersetzt den früheren einzelnen Admin-Key durch echte,
  standortgebundene Zugänge (siehe oben).
- **`KIOSK_API_KEY`** schützt weiterhin die Schreib-Endpunkte vor Bot-Traffic
  (plus Rate-Limit). Da das Kiosk-Terminal öffentlich zugänglich ist, ist
  dieser Key über "Seitenquelltext anzeigen" einsehbar — kein Geheimnis
  gegenüber jemandem direkt am Gerät, aber wirksam gegen automatisierten
  Missbrauch von außen.
- HTTPS über den Reverse-Proxy nicht vergessen (in Coolify Standard) — sonst
  gehen Passwörter und Keys unverschlüsselt raus.

## Lokal starten

```bash
cp .env.example .env
# .env anpassen: KIOSK_API_KEY, SESSION_SECRET, STANDORTE, ADMIN_USERS setzen
npm install
npm start
```

Kiosk: `http://localhost:3000/` (nutzt den einzigen konfigurierten Standort,
falls `STANDORTE` nur einen Eintrag hat)
Verwaltung: `http://localhost:3000/admin`

## Deployment via Coolify

1. Projekt in ein Git-Repository pushen.
2. In Coolify eine neue Ressource per Git-Deployment anlegen,
   `docker-compose.yml` als Compose-Datei auswählen.
3. Umgebungsvariablen setzen: `KIOSK_API_KEY`, `SESSION_SECRET`, `STANDORTE`,
   `STANDORT_DOMAINS` (falls mehrere Standorte), `ADMIN_USERS`, `CORS_ORIGIN`.
4. Bei mehreren Standorten: alle Subdomains als Domains dieser Ressource in
   Coolify eintragen (siehe oben).
5. Das Volume `besucher-data` sorgt für persistente Speicherung der
   SQLite-Datei über Neustarts/Deployments hinweg.

## API (Auswahl)

| Methode | Pfad | Auth | Zweck |
|---|---|---|---|
| GET | `/api/health` | — | Health-Check |
| GET | `/api/standorte` | — | Konfigurierte Standort-Liste |
| POST | `/api/admin/login` | — | Admin-Login (setzt Session-Cookie) |
| POST | `/api/admin/logout` | — | Admin-Logout |
| GET | `/api/admin/me` | Session | Eigene Zugangsdaten (Username, Standort) |
| POST | `/api/besucher` / `/api/handwerker` | `KIOSK_API_KEY` | Neue Anmeldung |
| GET | `/api/besucher` / `/api/handwerker` / `/api/schluessel` | Session | Listen (standortgefiltert) |
| PATCH | `/api/besucher/:id` / `/api/handwerker/:id` | Session | Eintrag bearbeiten |
| PATCH | `/api/besucher/:id/abmelden` / `/api/handwerker/:id/abmelden` | Session | Abmelden (Portal) |
| GET | `/api/checkins/offene-liste` | `KIOSK_API_KEY` | Liste für Selbst-Abmeldung am Kiosk |
| PATCH | `/api/checkins/:typ/:id/abmelden` | `KIOSK_API_KEY` | Selbst-Abmeldung am Kiosk |
| PATCH | `/api/schluessel/:id/zurueckgeben` | Session | Schlüssel manuell zurücknehmen |

Kiosk-Endpunkte nutzen den Header `x-api-key`, Admin-Endpunkte die
Session-Cookie (nach Login automatisch vom Browser mitgeschickt).

## Struktur

```
server.js          Express-App: API, Auth, Standort-Auflösung, Ausliefern des Frontends
db.js               SQLite-Schema, Migrationen, Admin-Benutzer-Synchronisierung
public/index.html   Kiosk-Assistent
public/admin.html   Verwaltungsportal
Dockerfile          Multi-Stage-Build (kompiliert better-sqlite3)
docker-compose.yml  Für Coolify-Deployment mit persistentem Volume
```

## Bekannte Grenzen

- Das Bearbeiten des Schlüssel-Namens an einem Handwerker-Eintrag wirkt sich
  nicht rückwirkend auf bereits erfasste Schlüsselbewegungen im Schlüssel-Log
  aus (das Log bleibt eine unveränderliche Historie).
- Ein Passwort-Reset-Self-Service existiert nicht — Passwörter werden über
  `ADMIN_USERS` verwaltet.
