# Data license

> **This tool does not include, host, or redistribute any data.**
> `nina-warnungen-cli` is a *client*. It only accesses warnings served live by the
> **Bundesamt für Bevölkerungsschutz und Katastrophenhilfe (BBK)** via NINA /
> `warnung.bund.de`. That data is governed by **the BBK's** terms, summarized
> below. The license of this CLI's own source code is a separate matter — see
> [LICENSING.md](LICENSING.md).

| | |
|---|---|
| **Data provider** | Bundesamt für Bevölkerungsschutz und Katastrophenhilfe (BBK) |
| **API / source** | `https://warnung.bund.de` (NINA) · docs: https://nina.api.bund.dev/ |
| **Data license** | **No named license** — the official federal warnings are *amtliche Werke* under **§ 5 Abs. 2 UrhG**, free to reuse under that statutory regime (not CC, not `dl-de`). |
| **Authoritative terms** | https://www.bbk.bund.de/DE/Warnung-Vorsorge/Warn-App-NINA/NINA-Rechtliches/nina-rechtliches.html · statute: https://www.gesetze-im-internet.de/urhg/__5.html |
| **Attribution** | **Required**, and content **must not be altered**. |
| **Commercial use** | Effectively allowed (the statute does not distinguish commercial use; BBK states no restriction). |
| **Redistribution / modification** | Redistribution of the official warnings is **expressly permitted**; **modification of content is not**. |

## Attribution

BBK's exact rule: *"Die in der Warn-App bereitgestellten amtlichen Warnmeldungen
des Bundes können weiterverbreitet und geteilt werden, solange der Inhalt nicht
verändert und die Quelle angegeben wird gem. § 5 Abs. 2 UrhG."*

```
Warnmeldungen: Bundesamt für Bevölkerungsschutz und Katastrophenhilfe (BBK),
NINA / warnung.bund.de — amtliches Werk gem. § 5 Abs. 2 UrhG, unverändert
weitergegeben. Einzelne Meldungen stammen von Dritten (u. a. DWD, Hochwasser-
portale der Länder).
```

## Notes & caveats

- Reformatting the envelope (e.g. JSON → GeoJSON, filtering with `jq`) for
  presentation is generally fine; altering the **substantive content** of a
  warning is not.
- **NINA aggregates upstream sources** — MoWaS, KATWARN, BIWAPP, **DWD** (severe
  weather), **LHP** (cross-state flood portals), police. BBK disclaims liability
  for third-party warnings. If you specifically redistribute DWD or flood content
  pulled via NINA, attribute the originating authority too (DWD data are commonly
  under GeoNutzV / `dl-de/by-2-0`).
- Non-warning app content (graphics, texts not part of the warning) may **not** be
  reproduced without BBK consent.

## Sources

- https://www.bbk.bund.de/DE/Warnung-Vorsorge/Warn-App-NINA/NINA-Rechtliches/nina-rechtliches.html — BBK Rechtliches
- https://www.gesetze-im-internet.de/urhg/__5.html — § 5 UrhG
- https://github.com/bundesAPI/nina-api — community API docs

---

*Good-faith summary compiled 2026-06-16; not legal advice. The provider's terms
are authoritative and can change — verify at the source, and check upstream
(DWD/LHP) terms when redistributing aggregated content.*
