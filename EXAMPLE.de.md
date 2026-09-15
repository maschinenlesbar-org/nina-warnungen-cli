# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `nina`, eines pro Skill: eine
Anfrage, die `nina`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `nina` 0.0.5 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [nina-region-watch](#nina-region-watch) · [nina-warning-briefing](#nina-warning-briefing) · [nina-warning-map](#nina-warning-map)

## nina-region-watch

> Ist im Vogelsbergkreis gerade etwas los? Bitte im Blick behalten.

```bash
nina --compact dashboard 065350000000 > dash-vb.json
nina --compact reference data-version > ver.json
nina --compact reference data-version > ver2.json        # fünf Minuten später: gleicher Hash
nina --compact dashboard 065350000000 > dash-vb2.json     # trotzdem geprüft: derselbe einzelne Eintrag
```

Der Skill hat den Vogelsbergkreis zum Kreisschlüssel `065350000000` aufgelöst (Hessen 06, Gießen 5,
Kreis 35). Der Dashboard-Eintrag hatte weder `onset` noch `expires`, und `payload.data.area` war
ein kodiertes Raster (`{"type":"GRID",…}`) statt eines Ortsnamens. Für die Zeit hat der Skill
deshalb `effective` verwendet, für den Ort die Überschrift.

```
Vogelsbergkreis (ARS 065350000000): 1 aktive Warnung

 SEVERE  Vogelsbergkreis meldet: Warnung Trinkwasserunfall. Gültig ab 14.09.2026, 15:29.
         KATWARN · Alert · Dringlichkeit Unknown · gültig ab 14.09. 15:29, kein Ablauf angegeben
         id kat.6aa7f6b0995efd5eae12108e_public_topics

Beobachtung über den data-version-Hash: Version 20, Hash eab02c0a… um 17:46 gespeichert.
  17:51  Hash unverändert: nirgends etwas geändert, keine neuen oder aufgehobenen Warnungen für den Kreis.
```

Als Nächstes angeboten: `nina warning get kat.6aa7f6b0995efd5eae12108e_public_topics` für den
vollständigen Text und `nina warning geojson …` für eine Karte des betroffenen Gebiets.

## nina-warning-briefing

> Wovor warnen die Behörden für Bevölkerungsschutz in Deutschland gerade?

```bash
nina --compact sources
nina --compact map-data mowas > mowas.json        # 4 Einträge
nina --compact map-data katwarn > katwarn.json    # 1
nina --compact map-data biwapp > biwapp.json      # []
nina --compact map-data dwd > dwd.json            # []
nina --compact map-data lhp > lhp.json            # []
nina --compact map-data police > police.json      # []
nina --compact warning get kat.6aa7f6b0995efd5eae12108e_public_topics > kat.json
```

Drei der vier MoWaS-Einträge waren `Cancel`-Meldungen (Entwarnungen) und wurden verworfen. Die
einzige Warnung der Stufe Severe hatte `instruction: null`. Der Skill hat die Hinweise deshalb aus
`description` übernommen.

```
Deutschland: 1 Severe, 1 Minor aktiv
(4 MoWaS / 1 KATWARN / 0 BIWAPP / 0 DWD / 0 Hochwasser / 0 Polizei; 3 Entwarnungen verworfen)

 SEVERE  Vogelsbergkreis meldet: Warnung Trinkwasserunfall. Gültig ab 14.09.2026, 15:29. (KATWARN)
         seit 14.09. 15:29, kein Ablauf angegeben · Gebiet: Teile von Lauterbach
         Leitungswasser ist getrübt: vor dem Trinken, Kochen und Zubereiten von Getränken
         abkochen; für Körperpflege und Toilettenspülung weiter nutzbar. Voraussichtlich
         etwa 4 Tage.
 MINOR   1. AKTUALISIERUNG: Bakteriologische Beeinträchtigung des Trinkwassers - Chlorung -
         Biringen, Fürweiler, Gerlfangen und Oberesch - Gde. ReSi (MoWaS)
         seit 04.09. 13:05, kein Ablauf angegeben

Kürzlich aufgehoben: Weltkriegsbombe in Elsterwerda; Abkochgebote für Riedering und für
Ehrenberg-Wüstensachsen/Melperts.
```

Als Nächstes angeboten: `nina warning get mow.DE-SL-SLS-W038-20260904-000` für die Meldung aus dem Saarland.

## nina-warning-map

> Auf einer Karte zeigen, welchen Teil von Lauterbach die Abkochwarnung betrifft.

```bash
nina --compact map-data katwarn > katwarn.json
nina --compact warning get kat.6aa7f6b0995efd5eae12108e_public_topics > kat.json   # areaDesc für die Beschriftung
nina warning geojson kat.6aa7f6b0995efd5eae12108e_public_topics -o lauterbach-trinkwasser.geojson
```

Die Warnungs-ID stammt aus dem KATWARN-Feed, gefunden über die Überschrift zum Vogelsbergkreis.
Die CLI bestätigte `Wrote 1319 bytes`, und die Koordinaten mussten nicht korrigiert werden.

```
lauterbach-trinkwasser.geojson geschrieben (1.319 Bytes): eine FeatureCollection, 1 Feature

  Geometrie:   1 Polygon, 61 Stützpunkte, Reihenfolge [lon, lat]
  Ausdehnung:  Länge 9,4124–9,4302, Breite 50,6709–50,6822 (etwa 1,3 × 1,3 km)
  Properties:  warnId, fillColor #B01917, fillOpacity 0.5, strokeColor, strokeOpacity,
               strokeWeight, zIndex (nur Darstellungshinweise, keine Überschrift oder Schwere)
  Gebiet:      „Teile von Lauterbach" (areaDesc aus warning get), KATWARN, Severe
```

Als Nächstes angeboten: die Datei in https://geojson.io ziehen oder Überschrift und Schwere aus
`warning get` als Beschriftung in die Feature-Properties übernehmen.
