# Besucher- & Schlüssel-Terminal

Kiosk-Formular (Multi-Step-Assistent) + zentrales Verwaltungs-Dashboard,
Node.js/Express-Backend mit SQLite. Ein einziger Container liefert alles aus:

- **`/`** — Kiosk-Assistent, fest an einen Standort gebunden. Auf einem
  Hostnamen, dem kein Standort zugeordnet ist (z. B. eure Haupt-App-URL aus
  Coolify), leitet `/` automatisch auf `/admin` weiter.
- **`/admin`** — Dashboard mit Benutzer/Passwort-Login. Jeder Zugang sieht
  Besucher/Handwerker/Schlüssel-Log/Export für seinen Standort. Ein
  **Superadmin**-Zugang (kein Standort zugewiesen) sieht zusätzlich die
  zentrale Verwaltung: Standorte, Domains, Nutzer, Kunden, Aktivitätsprotokoll.
- **`/api/*`** — REST-API

## Der Kiosk-Ablauf

Start-Bildschirm mit drei Buttons — **Ich bin Besucher** / **Ich bin
Handwerker** (mit optionaler Schlüsselvergabe) / **Ich möchte mich
abmelden** — jeweils als kurzer Multi-Step-Assistent. Der **Standort ist am
Kiosk nicht wechselbar**, sondern wird serverseitig über den aufgerufenen
Hostnamen fest zugeordnet. Optional lässt sich pro Standort ein
Hintergrundbild und ein individueller Willkommenstext hinterlegen (Dashboard
→ Tab „Standorte").

## Alles wird jetzt über das Dashboard verwaltet

Diese Version hat einen wichtigen Unterschied zur vorherigen: **Standorte,
Domains und Admin-Zugänge werden nicht mehr über Umgebungsvariablen
gepflegt**, sondern in der Datenbank und über das Dashboard unter `/admin`
(Tabs „Standorte", „Domains", „Nutzer" für Superadmins).

`STANDORTE`, `STANDORT_DOMAINS` und `ADMIN_USERS` in der `.env` werden nur
noch **einmalig beim allerersten Start** eingelesen, falls die jeweilige
Tabelle in der Datenbank noch leer ist — das erleichtert die Ersteinrichtung
bzw. den Umstieg von einer älteren Version. Ist eine Tabelle einmal befüllt
(egal ob durch den Import oder manuell über das Dashboard), haben diese
Variablen keine Wirkung mehr. Ihr könnt sie nach der Ersteinrichtung aus
Coolify entfernen.

**Für dieses Update reicht es, `ADMIN_USERS` einmal mit einem Superadmin zu
setzen** (Standort-Teil leer lassen), z. B.:
```
ADMIN_USERS=admin:EuerSicheresPasswort:
```
Danach meldet ihr euch unter `/admin` an und richtet Standorte, Domains und
weitere Nutzer bequem über die Oberfläche ein. Eure bereits vorhandene
`admin_users`-Tabelle aus der vorherigen Version wird beim Start automatisch
migriert — bestehende Passwörter bleiben dabei erhalten.

## Zentrale Verwaltung (Superadmin-Bereich im Dashboard)

- **Standorte**: anlegen, umbenennen, löschen (nur möglich, wenn keine
  Domain und kein Nutzer mehr zugeordnet ist — verhindert versehentliches
  Verwaisen von Zugängen). Pro Standort: Kiosk-Hintergrundbild hochladen
  (PNG/JPEG/WebP, max. 6 MB) und individuellen Willkommenstext setzen.
- **Domains**: Hostnamen einem Standort zuordnen (siehe unten zu Subdomains).
- **Nutzer**: Zugänge anlegen, Passwort zurücksetzen, Standort zuweisen oder
  entfernen, löschen. Der letzte verbleibende Superadmin ist geschützt und
  kann weder gelöscht noch auf einen Standort eingeschränkt werden, damit ihr
  euch nicht selbst aussperrt.
- **Kunden**: E-Mail-Kontakt pro Firma hinterlegen, für den Ein-Klick-Versand
  von Exporten.
- **Aktivität**: Protokoll aller verwaltenden Aktionen (wer hat wann was an
  Standorten/Domains/Nutzern geändert).

Jeder eingeloggte Zugang (auch standortgebunden) kann außerdem im Tab
„Export" die Schlüssel-Historie seines Standorts als CSV herunterladen oder
direkt per E-Mail an eine hinterlegte oder eingetippte Adresse senden.

## Mehrere Standorte über Subdomains

1. Im Dashboard unter „Standorte" die gewünschten Standorte anlegen.
2. Unter „Domains" jeden Hostnamen (z. B. `hauptgebaeude.empfang.example.com`)
   dem passenden Standort zuordnen.
3. Denselben Hostnamen zusätzlich **in Coolify** als Domain dieser Ressource
   eintragen — sonst ist er von außen nicht erreichbar.

**Zu „Wildcard":** Ein echtes Wildcard-TLS-Zertifikat ist dafür nicht
zwingend nötig. Es reicht, in Coolify mehrere Domains für dieselbe Ressource
einzutragen — Traefik stellt dafür automatisch je ein eigenes
Let's-Encrypt-Zertifikat aus. Ein echtes Wildcard-Zertifikat lohnt sich nur,
wenn ihr Standorte sehr häufig hinzufügt und die Domain-Pflege in Coolify
vermeiden wollt; dafür braucht euer DNS-Anbieter einen von Coolify
unterstützten DNS-01-Provider.

Ruft ihr die App-URL auf, die keinem Standort zugeordnet ist (typischerweise
die Haupt-Domain aus Coolify), landet ihr automatisch im Dashboard.

## Sicherheit

- **`SESSION_SECRET`** signiert die Admin-Login-Sessions (httpOnly-Cookie,
  12 Stunden gültig, `SameSite=Lax`). Da alle verändernden Endpunkte
  POST/PATCH/DELETE verwenden, schützt `SameSite=Lax` bereits wirksam gegen
  CSRF-Angriffe — ein zusätzliches CSRF-Token ist dadurch nicht nötig.
- Passwörter werden nie im Klartext gespeichert (scrypt-Hash mit Salt).
- Der letzte Superadmin kann nicht gelöscht oder eingeschränkt werden
  (verhindert Selbst-Aussperrung).
- Standort-Löschung ist blockiert, solange noch Domains oder Nutzer daran
  hängen.
- Hochgeladene Kiosk-Hintergrundbilder werden mit zufälligem Dateinamen
  gespeichert, auf Bild-MIME-Typen beschränkt (PNG/JPEG/WebP) und auf 6 MB
  begrenzt.
- **`KIOSK_API_KEY`** schützt weiterhin die Schreib-Endpunkte vor Bot-Traffic
  (plus Rate-Limit). Da das Kiosk-Terminal öffentlich zugänglich ist, ist
  dieser Key über "Seitenquelltext anzeigen" einsehbar — kein Geheimnis
  gegenüber jemandem direkt am Gerät, aber wirksam gegen automatisierten
  Missbrauch von außen.
- Jede verändernde Aktion im Superadmin-Bereich wird im Aktivitätsprotokoll
  festgehalten (wer, was, wann).
- HTTPS über den Reverse-Proxy nicht vergessen (in Coolify Standard) — sonst
  gehen Passwörter und Keys unverschlüsselt raus.
- SMTP-Zugangsdaten liegen bewusst nur in Umgebungsvariablen, nicht in der
  Datenbank oder im Dashboard editierbar — ein kompromittierter Admin-Zugang
  kann damit keine SMTP-Zugangsdaten auslesen oder ändern.

## Lokal starten

```bash
cp .env.example .env
# .env anpassen: KIOSK_API_KEY, SESSION_SECRET, ADMIN_USERS setzen
npm install
npm start
```

Dashboard: `http://localhost:3000/admin`
Kiosk: `http://localhost:3000/` (nutzt automatisch den einzigen vorhandenen Standort)

## Deployment via Coolify

1. Projekt in ein Git-Repository pushen.
2. In Coolify eine neue Ressource per Git-Deployment anlegen,
   `docker-compose.yml` als Compose-Datei auswählen.
3. Umgebungsvariablen setzen: mindestens `KIOSK_API_KEY`, `SESSION_SECRET`,
   `ADMIN_USERS` (siehe oben). Optional `SMTP_*` für den E-Mail-Export.
4. Bei mehreren Standorten: alle Subdomains zusätzlich als Domains dieser
   Ressource in Coolify eintragen.
5. Das Volume `besucher-data` sorgt für persistente Speicherung von
   SQLite-Datenbank **und** hochgeladenen Kiosk-Hintergrundbildern
   (`/app/data/uploads`) über Neustarts/Deployments hinweg.

## API (Auswahl)

| Methode | Pfad | Auth | Zweck |
|---|---|---|---|
| GET | `/api/health` | — | Health-Check |
| POST | `/api/admin/login` / `/api/admin/logout` | — | Admin-Login/-Logout |
| GET | `/api/admin/me` | Session | Eigene Zugangsdaten |
| POST | `/api/admin/passwort` | Session | Eigenes Passwort ändern |
| POST | `/api/besucher` / `/api/handwerker` | `KIOSK_API_KEY` | Neue Anmeldung |
| GET | `/api/besucher` / `/api/handwerker` / `/api/schluessel` | Session | Listen (standortgefiltert) |
| PATCH | `/api/besucher/:id` / `/api/handwerker/:id` | Session | Eintrag bearbeiten |
| PATCH | `…/abmelden` | Session bzw. `KIOSK_API_KEY` | Abmelden (Portal bzw. Kiosk-Selbstbedienung) |
| GET | `/api/export/schluessel` | Session | CSV-Export |
| POST | `/api/export/schluessel/senden` | Session | Export per E-Mail senden |
| GET/POST/PATCH/DELETE | `/api/dashboard/standorte` | Session (Superadmin) | Standorte verwalten |
| POST/DELETE | `/api/dashboard/standorte/:id/hintergrund` | Session (Superadmin) | Kiosk-Hintergrundbild |
| GET/POST/DELETE | `/api/dashboard/domains` | Session (Superadmin) | Domain-Zuordnung |
| GET/POST/PATCH/DELETE | `/api/dashboard/nutzer` | Session (Superadmin) | Admin-Zugänge |
| GET/POST/PATCH/DELETE | `/api/dashboard/kunden` | Session (Superadmin) | Kunden-Kontakte |
| GET | `/api/dashboard/audit-log` | Session (Superadmin) | Aktivitätsprotokoll |

## Struktur

```
server.js          Express-App: API, Auth, Standort-Auflösung, Uploads, Ausliefern des Frontends
db.js               SQLite-Schema, Migrationen, einmaliger Env-Import
public/index.html   Kiosk-Assistent
public/admin.html   Dashboard (operativ + zentrale Verwaltung)
Dockerfile          Multi-Stage-Build (kompiliert better-sqlite3)
docker-compose.yml  Für Coolify-Deployment mit persistentem Volume
```

## Bekannte Grenzen

- Das Bearbeiten des Schlüssel-Namens an einem Handwerker-Eintrag wirkt sich
  nicht rückwirkend auf bereits erfasste Schlüsselbewegungen im Schlüssel-Log
  aus (das Log bleibt eine unveränderliche Historie).
- Ein Standort-Umbenennen ändert nicht die `standort`-Angabe an bereits
  bestehenden Besucher-/Handwerker-/Schlüssel-Einträgen (bewusst — die
  Historie bleibt so, wie sie erfasst wurde).
- Passwort-Reset-Self-Service für Nutzer selbst gibt es nicht (nur der
  Superadmin kann Passwörter anderer Nutzer setzen); jeder Nutzer kann aber
  im Dashboard über „Mein Passwort ändern" sein eigenes Passwort setzen.
