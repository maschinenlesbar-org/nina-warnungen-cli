# Examples

Real examples for the Claude Code skills of the `nina` plugin, one per skill: a request,
the `nina` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `nina` 0.0.5.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [nina-region-watch](#nina-region-watch) · [nina-warning-briefing](#nina-warning-briefing) · [nina-warning-map](#nina-warning-map)

## nina-region-watch

> Is anything going on in the Vogelsbergkreis? Keep an eye on it for me.

```bash
nina --compact dashboard 065350000000 > dash-vb.json
nina --compact reference data-version > ver.json
nina --compact reference data-version > ver2.json        # five minutes later: same hash
nina --compact dashboard 065350000000 > dash-vb2.json     # checked anyway: same single entry
```

The skill resolved Vogelsbergkreis to the district key `065350000000` (Hessen 06, Gießen 5,
district 35). The dashboard entry had no `onset` or `expires`, and `payload.data.area` was an
encoded grid (`{"type":"GRID",…}`) rather than a place name. So the skill used `effective` for the
time and the headline for the place.

```
Vogelsbergkreis (ARS 065350000000): 1 active warning

 SEVERE  Vogelsbergkreis meldet: Warnung Trinkwasserunfall. Gültig ab 14.09.2026, 15:29.
         KATWARN · Alert · urgency Unknown · effective 14.09. 15:29, no expiry given
         id kat.6aa7f6b0995efd5eae12108e_public_topics

Watching via the data-version hash: version 20, hash eab02c0a… stored at 17:46.
  17:51  hash unchanged: nothing changed anywhere, no new or cleared warnings for the district.
```

Next steps offered: `nina warning get kat.6aa7f6b0995efd5eae12108e_public_topics` for the full
text and `nina warning geojson …` to map the affected area.

## nina-warning-briefing

> What are the civil-protection authorities warning about in Germany right now?

```bash
nina --compact sources
nina --compact map-data mowas > mowas.json        # 4 entries
nina --compact map-data katwarn > katwarn.json    # 1
nina --compact map-data biwapp > biwapp.json      # []
nina --compact map-data dwd > dwd.json            # []
nina --compact map-data lhp > lhp.json            # []
nina --compact map-data police > police.json      # []
nina --compact warning get kat.6aa7f6b0995efd5eae12108e_public_topics > kat.json
```

Three of the four MoWaS entries were `Cancel` messages (Entwarnung) and were dropped. The one
Severe warning had `instruction: null`, so the skill took the advice from its `description`.

```
Germany: 1 Severe, 1 Minor active
(4 MoWaS / 1 KATWARN / 0 BIWAPP / 0 DWD / 0 flood / 0 police; 3 cancellations dropped)

 SEVERE  Vogelsbergkreis meldet: Warnung Trinkwasserunfall. Gültig ab 14.09.2026, 15:29. (KATWARN)
         started 14.09. 15:29, no expiry given · area: Teile von Lauterbach
         Tap water is cloudy: boil it before drinking, cooking or making drinks; fine for
         washing and flushing. Expected to last about 4 days.
 MINOR   1. AKTUALISIERUNG: Bakteriologische Beeinträchtigung des Trinkwassers - Chlorung -
         Biringen, Fürweiler, Gerlfangen und Oberesch - Gde. ReSi (MoWaS)
         started 04.09. 13:05, no expiry given

Recently cleared: Weltkriegsbombe in Elsterwerda; boil-water notices for Riedering and for
Ehrenberg-Wüstensachsen/Melperts.
```

Next steps offered: `nina warning get mow.DE-SL-SLS-W038-20260904-000` for the Saarland notice.

## nina-warning-map

> Show me on a map which part of Lauterbach the boil-water warning covers.

```bash
nina --compact map-data katwarn > katwarn.json
nina --compact warning get kat.6aa7f6b0995efd5eae12108e_public_topics > kat.json   # areaDesc for the label
nina warning geojson kat.6aa7f6b0995efd5eae12108e_public_topics -o lauterbach-trinkwasser.geojson
```

The warning id came from the KATWARN feed by matching the Vogelsbergkreis headline. The CLI
confirmed `Wrote 1319 bytes`, and the file needed no coordinate fix-up.

```
Wrote lauterbach-trinkwasser.geojson (1,319 bytes): one FeatureCollection, 1 feature

  geometry:    1 Polygon, 61 vertices, [lon, lat] order
  extent:      lon 9.4124–9.4302, lat 50.6709–50.6822 (roughly 1.3 × 1.3 km)
  properties:  warnId, fillColor #B01917, fillOpacity 0.5, strokeColor, strokeOpacity,
               strokeWeight, zIndex (rendering hints only, no headline or severity)
  covers:      „Teile von Lauterbach" (areaDesc from warning get), KATWARN, Severe
```

Next steps offered: drag the file into https://geojson.io, or merge the headline and severity
from `warning get` into the feature properties as map labels.
