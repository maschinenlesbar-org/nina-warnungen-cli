# Examples

Real examples for the Claude Code skills of the `nina` plugin, one per skill: a request,
the `nina` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 6 October 2026 around 1:00 with `nina` 0.3.0.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [nina-region-watch](#nina-region-watch) · [nina-warning-briefing](#nina-warning-briefing) · [nina-warning-map](#nina-warning-map)

## nina-region-watch

> It smells of smoke in Breitungen in the Südharz tonight. Is there an official warning? Keep an eye on it for me.

```bash
nina --compact dashboard 150870000000 > dash-msh.json                       # 00:54: 1 entry
nina --compact warning get mow.DE-ST-MSH-W058-20261005-000 > msh-warn.json  # areaDesc and advice; no expires
nina --compact dashboard 150870000000 > dash-msh2.json                      # 00:58: same id, same payload.hash
```

Breitungen (Südharz) belongs to the Landkreis Mansfeld-Südharz, as the warning id's `DE-ST-MSH`
also says, so the skill used the district key `150870000000` (Sachsen-Anhalt 15, no
Regierungsbezirk 0, district 87). The entry had no `effective`, and `payload.data.area` was an
encoded reference (`{"type":"GRID",…}`), so the time came from `sent` and the area and advice
from `warning get`, which gave no `expires`; its `instruction` and `description` came with
`<br/>` tags, turned into sentences. To keep watching, the skill fetched the dashboard again four
minutes later and compared `id` and `payload.hash`.

```
Landkreis Mansfeld-Südharz (ARS 150870000000): 1 active warning

 MINOR  Rauchbelästigung durch Brand - Breitungen
        MOWAS · Alert · urgency Immediate · sent 05.10. 03:31, no expiry given
        area: Breitungen
        A straw store is on fire and smoke and smell reach the village. There is no danger;
        keep windows and doors closed as a precaution.
        id mow.DE-ST-MSH-W058-20261005-000

Watching the dashboard: 1 entry, payload.hash 5cb9d83b… stored at 00:54.
  00:58  same id, same payload.hash, msgType still Alert: no new, changed or cleared warnings.
```

Next steps offered: another check in a few minutes, and
`nina warning geojson mow.DE-ST-MSH-W058-20261005-000` to map the affected area.

## nina-warning-briefing

> What are the civil-protection authorities warning about in Germany right now?

```bash
nina --compact sources
nina --compact map-data mowas > mowas.json        # 11 entries
nina --compact map-data katwarn > katwarn.json    # []
nina --compact map-data biwapp > biwapp.json      # []
nina --compact map-data dwd > dwd.json            # []
nina --compact map-data lhp > lhp.json            # []
nina --compact map-data police > police.json      # []
```

One of the eleven MoWaS entries was a `Cancel` (Entwarnung) and was dropped. None of the other
ten had an `expiresDate`, so all count as active. All were `Minor` and `Immediate`, and MoWaS was
the only source with entries, so the skill listed them, most recent first, instead of giving only
a count. No warning was `Severe` or `Extreme`, so it fetched no detail with `warning get`.

```
Germany: 10 Minor active, nothing Severe or Extreme
(11 MoWaS / 0 KATWARN / 0 BIWAPP / 0 DWD / 0 flood / 0 police; 1 cancellation dropped)

 MINOR  BOMBENENTSCHÄRFUNG - Strand Seebad Ahlbeck                          since 05.10. 08:25
 MINOR  Rauchbelästigung durch Brand - Breitungen                           since 05.10. 03:31
 MINOR  Notversorgung und Wiederherstellung der Gasversorgung - Stadt Greiz since 02.10. 21:50
 MINOR  Warnung vor Wasserkontakt am südlichen Bleilochstausee              since 01.10. 21:29
 MINOR  Abkochgebot für Trinkwasser … Teile von Wolnzach, Geisenfeld, Rohrbach, Ernsgaden
        & Vohburg                                                           since 01.10. 18:29
 MINOR  Trinkwasserverunreinigung - Winzerhausen Holzweiler Hof             since 01.10. 11:29
 MINOR  Trinkwasserverunreinigung - Abkochgebot … Geisfeld (Strullendorf)   since 28.09. 14:46
 MINOR  Vorsorgliches Abkochgebot für Trinkwasser in Teilen Wiesbadens      since 26.09. 14:54
 MINOR  Verunreinigung des Trink- / Leitungswassers - Hambrücken            since 25.09. 09:01
 MINOR  1. AKTUALISIERUNG: Bakteriologische Beeinträchtigung des Trinkwassers … Gde. ReSi
                                                                            since 04.09. 13:05
 All from MoWaS, urgency Immediate, no expiry given.

Recently cleared: Rauchgase in Geldern.
```

Next steps offered: `nina warning get <id>` for the advice of any of them, for example the
Ahlbeck bomb disposal (`mow.DE-MV-HGW-W005-20261005-000`).

## nina-warning-map

> Show me on a map which part of Wiesbaden the boil-water notice covers.

```bash
nina --compact map-data mowas > mowas-map.json
nina --compact warning get mow.DE-HE-WI-W097-20260926-000 > wi.json   # areaDesc for the label
nina warning geojson mow.DE-HE-WI-W097-20260926-000 -o wiesbaden-abkochgebot.geojson
```

The warning id came from the MoWaS feed by matching the Wiesbaden headline. The CLI confirmed
`Wrote 1377 bytes`, and the file needed no coordinate fix-up.

```
Wrote wiesbaden-abkochgebot.geojson (1,377 bytes): one FeatureCollection, 1 feature

  geometry:    1 Polygon, 65 vertices, [lon, lat] order
  extent:      lon 8.2347–8.2610, lat 50.0752–50.0912 (roughly 1.9 × 1.8 km)
  properties:  warnId, fillColor #FB8C00, fillOpacity 0.5, strokeColor, strokeOpacity,
               strokeWeight, zIndex (rendering hints only, no headline or severity)
  covers:      „Wiesbaden-Mitte (Teile), Wiesbaden-Nordost (Teile)" (areaDesc from
               warning get), MoWaS, Minor
```

Next steps offered: drag the file into https://geojson.io, or merge the headline and severity
from `warning get` into the feature properties as map labels.
