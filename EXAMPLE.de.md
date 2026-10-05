# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `nina`, eines pro Skill: eine
Anfrage, die `nina`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 6. Oktober 2026 gegen 1:00 Uhr mit `nina` 0.3.0 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [nina-region-watch](#nina-region-watch) · [nina-warning-briefing](#nina-warning-briefing) · [nina-warning-map](#nina-warning-map)

## nina-region-watch

> Heute Nacht riecht es in Breitungen im Südharz nach Rauch. Gibt es eine offizielle Warnung? Bitte im Blick behalten.

```bash
nina --compact dashboard 150870000000 > dash-msh.json                       # 00:54: 1 Eintrag
nina --compact warning get mow.DE-ST-MSH-W058-20261005-000 > msh-warn.json  # areaDesc und Hinweise; kein expires
nina --compact dashboard 150870000000 > dash-msh2.json                      # 00:58: gleiche id, gleicher payload.hash
```

Breitungen (Südharz) gehört zum Landkreis Mansfeld-Südharz, wie auch das `DE-ST-MSH` in der
Warnungs-ID sagt, deshalb hat der Skill den Kreisschlüssel `150870000000` verwendet
(Sachsen-Anhalt 15, kein Regierungsbezirk 0, Kreis 87). Der Eintrag hatte kein `effective`, und
`payload.data.area` war ein kodierter Verweis (`{"type":"GRID",…}`). Die Zeit stammt deshalb aus
`sent`, Gebiet und Hinweise aus `warning get`, das kein `expires` enthielt; `instruction` und
`description` kamen mit `<br/>`-Tags und wurden zu Sätzen. Zum Beobachten hat der Skill das
Dashboard vier Minuten später erneut abgerufen und `id` und `payload.hash` verglichen.

```
Landkreis Mansfeld-Südharz (ARS 150870000000): 1 aktive Warnung

 MINOR  Rauchbelästigung durch Brand - Breitungen
        MOWAS · Alert · Dringlichkeit Immediate · gesendet 05.10. 03:31, kein Ablauf angegeben
        Gebiet: Breitungen
        Ein Strohlager brennt, Rauch und Geruch ziehen in den Ort. Es besteht keine Gefahr;
        vorsorglich Fenster und Türen geschlossen halten.
        id mow.DE-ST-MSH-W058-20261005-000

Beobachtung über das Dashboard: 1 Eintrag, payload.hash 5cb9d83b… um 00:54 gespeichert.
  00:58  gleiche id, gleicher payload.hash, msgType weiter Alert: keine neuen, geänderten oder
         aufgehobenen Warnungen.
```

Als Nächstes angeboten: eine weitere Prüfung in einigen Minuten und
`nina warning geojson mow.DE-ST-MSH-W058-20261005-000` für eine Karte des betroffenen Gebiets.

## nina-warning-briefing

> Wovor warnen die Behörden für Bevölkerungsschutz in Deutschland gerade?

```bash
nina --compact sources
nina --compact map-data mowas > mowas.json        # 11 Einträge
nina --compact map-data katwarn > katwarn.json    # []
nina --compact map-data biwapp > biwapp.json      # []
nina --compact map-data dwd > dwd.json            # []
nina --compact map-data lhp > lhp.json            # []
nina --compact map-data police > police.json      # []
```

Einer der elf MoWaS-Einträge war eine `Cancel`-Meldung (Entwarnung) und wurde verworfen. Keiner
der übrigen zehn hatte ein `expiresDate`, alle gelten also als aktiv. Alle hatten die Stufe
`Minor` und die Dringlichkeit `Immediate`, und MoWaS war die einzige Quelle mit Einträgen. Der
Skill hat sie deshalb aufgelistet, die neuesten zuerst, statt nur eine Zahl zu nennen. Keine
Warnung war `Severe` oder `Extreme`, deshalb hat er keine Details mit `warning get` abgerufen.

```
Deutschland: 10 Minor aktiv, nichts Severe oder Extreme
(11 MoWaS / 0 KATWARN / 0 BIWAPP / 0 DWD / 0 Hochwasser / 0 Polizei; 1 Entwarnung verworfen)

 MINOR  BOMBENENTSCHÄRFUNG - Strand Seebad Ahlbeck                          seit 05.10. 08:25
 MINOR  Rauchbelästigung durch Brand - Breitungen                           seit 05.10. 03:31
 MINOR  Notversorgung und Wiederherstellung der Gasversorgung - Stadt Greiz seit 02.10. 21:50
 MINOR  Warnung vor Wasserkontakt am südlichen Bleilochstausee              seit 01.10. 21:29
 MINOR  Abkochgebot für Trinkwasser … Teile von Wolnzach, Geisenfeld, Rohrbach, Ernsgaden
        & Vohburg                                                           seit 01.10. 18:29
 MINOR  Trinkwasserverunreinigung - Winzerhausen Holzweiler Hof             seit 01.10. 11:29
 MINOR  Trinkwasserverunreinigung - Abkochgebot … Geisfeld (Strullendorf)   seit 28.09. 14:46
 MINOR  Vorsorgliches Abkochgebot für Trinkwasser in Teilen Wiesbadens      seit 26.09. 14:54
 MINOR  Verunreinigung des Trink- / Leitungswassers - Hambrücken            seit 25.09. 09:01
 MINOR  1. AKTUALISIERUNG: Bakteriologische Beeinträchtigung des Trinkwassers … Gde. ReSi
                                                                            seit 04.09. 13:05
 Alle von MoWaS, Dringlichkeit Immediate, kein Ablauf angegeben.

Kürzlich aufgehoben: Rauchgase in Geldern.
```

Als Nächstes angeboten: `nina warning get <id>` für die Hinweise zu einer davon, zum Beispiel
zur Bombenentschärfung in Ahlbeck (`mow.DE-MV-HGW-W005-20261005-000`).

## nina-warning-map

> Auf einer Karte zeigen, welchen Teil von Wiesbaden das Abkochgebot betrifft.

```bash
nina --compact map-data mowas > mowas-map.json
nina --compact warning get mow.DE-HE-WI-W097-20260926-000 > wi.json   # areaDesc für die Beschriftung
nina warning geojson mow.DE-HE-WI-W097-20260926-000 -o wiesbaden-abkochgebot.geojson
```

Die Warnungs-ID stammt aus dem MoWaS-Feed, gefunden über die Überschrift zu Wiesbaden. Die CLI
bestätigte `Wrote 1377 bytes`, und die Koordinaten mussten nicht korrigiert werden.

```
wiesbaden-abkochgebot.geojson geschrieben (1.377 Bytes): eine FeatureCollection, 1 Feature

  Geometrie:   1 Polygon, 65 Stützpunkte, Reihenfolge [lon, lat]
  Ausdehnung:  Länge 8,2347–8,2610, Breite 50,0752–50,0912 (etwa 1,9 × 1,8 km)
  Properties:  warnId, fillColor #FB8C00, fillOpacity 0.5, strokeColor, strokeOpacity,
               strokeWeight, zIndex (nur Darstellungshinweise, keine Überschrift oder Schwere)
  Gebiet:      „Wiesbaden-Mitte (Teile), Wiesbaden-Nordost (Teile)" (areaDesc aus
               warning get), MoWaS, Minor
```

Als Nächstes angeboten: die Datei in https://geojson.io ziehen oder Überschrift und Schwere aus
`warning get` als Beschriftung in die Feature-Properties übernehmen.
