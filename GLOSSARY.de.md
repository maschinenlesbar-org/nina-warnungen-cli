# Glossar

Ein Nachschlagewerk für die Fachbegriffe und projektspezifischen Begriffe, die in
`nina-warnungen-cli` verwendet werden. Die Fachdomäne von NINA ist der deutsche
Bevölkerungsschutz; dieses Glossar nennt den in CLI und API verwendeten Begriff, wo
vorhanden neben dem deutschen Originalbegriff.

---

## NINA & Betreiber

**NINA – Notfall-Informations- und Nachrichten-App.** Die Warn-App des Bundes, mit der
die Bevölkerung Notfallinformationen und Meldungen erhält. Dieselben Warndaten, die die
App speisen, werden über die offene REST-API veröffentlicht, die dieses Tool kapselt.

**warnung.bund.de.** Das öffentliche Warnportal und der Host der offenen API (Basis-URL
`https://warnung.bund.de`, Pfadpräfix `/api31`). Weder Authentifizierung noch
API-Schlüssel sind nötig; jeder Endpoint ist ein rein lesender `GET`.

**BBK – Bundesamt für Bevölkerungsschutz und Katastrophenhilfe.** Die Bundesbehörde, die
NINA und die Warninfrastruktur betreibt.

---

## Warnquellen

NINA bündelt mehrere unabhängige Warn-„Anbieter“, von denen jeder als eigene
`mapData.json`-Liste veröffentlicht wird. Die CLI zeigt die gültigen Werte über
`nina sources` an, und `nina map-data <source>` ruft die aktuellen Warnungen einer
Quelle ab.

**Quelle (NinaSource).** Einer der gebündelten Anbieter. Gültige Werte sind:

| Quelle | Bedeutung |
| --- | --- |
| `mowas` | **MoWaS – Modulares Warnsystem.** Das modulare Warnsystem von Bund und Ländern für den Bevölkerungsschutz. |
| `katwarn` | **KATWARN.** Kommunaler bzw. regionaler Warndienst. |
| `biwapp` | **BIWAPP – Bürger-Info- und Warn-App.** Kommunaler Warndienst. |
| `dwd` | **DWD – Deutscher Wetterdienst.** Unwetterwarnungen des nationalen Wetterdienstes. |
| `lhp` | **LHP – Länderübergreifendes Hochwasser Portal.** Länderübergreifende Hochwasserwarnungen. |
| `police` | Polizeiliche Lagemeldungen. |

---

## Ressourcen & Endpoints

Die CLI bildet die Ressourcen der API ab. Diese Endpoints stellt der Client bereit:

**map-data (`/{source}/mapData.json`).** Die aktuellen Warnungen einer Quelle als Liste
von Warnungszusammenfassungen (`MapWarning[]`). CLI: `nina map-data <source>`.

**warning get (`/warnings/{identifier}.json`).** Die vollständigen, aus CAP abgeleiteten
Daten einer Warnung zu einer einzelnen Kennung. Sie sind tief verschachtelt und
standardspezifisch und werden daher als unverändertes rohes JSON-Objekt zurückgegeben.
CLI: `nina warning get <identifier>`.

**warning geojson (`/warnings/{identifier}.geojson`).** Die Geometrie des betroffenen
Gebiets als GeoJSON (`application/geo+json`), zurückgegeben als rohe Bytes. CLI:
`nina warning geojson <identifier>` (mit `-o` in eine Datei speichern).

**dashboard (`/dashboard/{ARS}.json`).** Alle Warnungen, die aktuell einen Kreis
betreffen, adressiert über seinen Regionalschlüssel auf Kreisebene (siehe ARS unten).
CLI: `nina dashboard <ars>`.

**archive – MoWaS-Archiv.** Frühere MoWaS-Warnungen und ihr Revisionsverlauf:
- **mapping (`/archive.mowas/{identifier}-mapping.json`)** – der Revisionsverlauf
  (`ArchiveMapping`) einer archivierten Kennung. CLI: `nina archive mapping <id>`.
- **get (`/archive.mowas/{identifier}.json`)** – eine bestimmte archivierte
  MoWaS-Warnung, in derselben Form wie eine aktuelle Warnung. CLI: `nina archive get <id>`.

**reference – statische Referenzdaten**, die zusammen mit den Warnungen veröffentlicht
werden:
- **notfalltipps (`/appdata/gsb/notfalltipps/DE/notfalltipps.json`)** –
  **Notfalltipps**, die Hinweise zur Notfallvorsorge (auf Deutsch). CLI:
  `nina reference notfalltipps`.
- **event-codes (`/appdata/gsb/eventCodes/eventCodes.json`)** – der Katalog der
  CAP-Ereigniscodes, der Ereignisschlüssel Icons und Bezeichnungen zuordnet. CLI:
  `nina reference event-codes`.
- **data-version (`/dynamic/version/dataVersion.json`)** – eine Versionsnummer mit
  Hash, deren einziger Eintrag `labels` ist. Sie ändert sich nicht, wenn sich Warnungen
  ändern, und ersetzt daher nicht das erneute Abrufen eines Warn-Feeds oder Dashboards.
  CLI: `nina reference data-version`.

---

## Kennungen & Regionalschlüssel

**identifier.** Die opake ID einer einzelnen Warnung (z. B. eine MoWaS-ID `mow.…` aus der
`id` eines `map-data`-Eintrags). Wird als Pfadargument für `warning get`/`geojson` und
`archive mapping`/`get` verwendet. Der Client URL-codiert sie vor der Anfrage.

**ARS – Amtlicher Regionalschlüssel.** Der 12-stellige Schlüssel einer deutschen
Verwaltungseinheit (Land → Kreis → Gemeinde), mit dem der `dashboard`-Endpoint
angesprochen wird (z. B. `055150000000`).

**AGS – Amtlicher Gemeindeschlüssel.** Der kürzere (8-stellige) Gemeindeschlüssel. Der
Endpoint `dashboard` akzeptiert ihn nicht (HTTP 400) und auch keinen ARS auf
Gemeindeebene (HTTP 404): Er erwartet den ARS auf Kreisebene, also die ersten fünf
Stellen gefolgt von `0000000`. Die CLI reicht den Schlüssel unverändert weiter.

---

## Begriffe der Warnungsdaten (CAP)

NINA-Warnungen sind aus **CAP – dem Common Alerting Protocol** abgeleitet, dem
OASIS-Standard für den Austausch von Warnmeldungen. Die folgenden Felder kommen in der
typisierten Warnungszusammenfassung (`MapWarning`) oder in den vollständigen Daten vor.

**id / version.** Die Kennung der Warnung und ihre monoton steigende Revisionsnummer.

**startDate / expiresDate.** Wann die Warnung in Kraft tritt und (bei Quellen, die das
angeben) wann sie abläuft.

**type (msgType).** Der CAP-Meldungstyp eines Eintrags – `Alert` (neu), `Update`
(ersetzt eine frühere Meldung) oder `Cancel` (zieht sie zurück).

**Severity.** Die CAP-Schwerestufe einer Warnung. Der vom Client bereitgestellte
Wertebereich ist `Minor`, `Moderate`, `Severe`, `Extreme`, `Unknown` (in aufsteigender
Schwere, dazu der Auffangwert `Unknown`).

**i18nTitle / I18nText.** Eine lokalisierte Titel-Map mit Sprachcodes als Schlüssel,
z. B. `{ "de": "Hochwasser" }`.

**transKeys / event.** Übersetzungsschlüssel in einer Zusammenfassung; `event` verweist
auf einen Eintrag im Katalog der Ereigniscodes (siehe `reference event-codes`).

**headline / sent.** In Einträgen des Archivverlaufs (`ArchiveMappingEntry`) und des
Dashboards (`DashboardEntry`): die menschenlesbare Überschrift und der Zeitpunkt, zu dem
die Meldung versendet wurde.

---

## API-Verhalten

**Keine Authentifizierung.** Jeder Endpoint ist ein offener, rein lesender `GET`; der
Client sendet nie Zugangsdaten.

**GeoJSON-Downloads.** `warning geojson` fordert `application/geo+json` an und liefert
rohe Bytes (`RawResponse`), statt sie zu parsen, sodass die Geometrie Byte für Byte
unverändert ankommt.

**Rate-Limiting / vorübergehende Fehler.** Die API kann **429** (zu viele Anfragen) oder
**503** (vorübergehend nicht verfügbar) liefern; der Client behandelt beide als
wiederholbar und versucht es mit linearem Backoff erneut (`--max-retries`).

**Keine Weiterleitungen.** Der Transport sendet genau eine Anfrage und folgt keinen
`3xx`-Weiterleitungen – eine Weiterleitung wird wie jeder andere Nicht-2xx-Status als
Fehler gemeldet; so werden Header nicht erneut an ein Weiterleitungsziel gesendet.

---

> **Bibliothek & Interna.** Begriffe zum TypeScript-Client und seinen Interna –
> `NinaClient`, Ressourcengruppen, die Request-Engine, Transport, Retry/Backoff,
> Fehlertypen, Query-Builder – stehen jetzt in **[DEVELOPING.md](DEVELOPING.md)**.
