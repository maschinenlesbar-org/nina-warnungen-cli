---
name: nina-region-watch
description: >
  Check or monitor civil-protection warnings for a specific German region using
  the nina-warnungen-cli. Trigger when the user asks "are there warnings in
  <town/district>?", "any alerts for my area / Landkreis / Kreis?", "warnings
  near me", "is it safe in <region>?", or wants ongoing monitoring of one place.
  Resolves the place to its ARS/AGS regional key, pulls the per-region dashboard
  feed, and can poll the cheap data-version hash so it only re-checks when
  something actually changed.
version: 1.0.0
userInvocable: true
---

# NINA Region Watch

Answer "what's being warned about **in this specific place**?" by querying NINA's
per-region dashboard, and support lightweight monitoring via the data-version hash —
instead of fetching national feeds and filtering by hand.

## Tooling

This skill drives the `nina` command. **Before anything else, validate it is available** — run `command -v nina` (or `nina --version`). If it is not on your PATH, STOP and inform the user that the `nina` CLI (`@maschinenlesbar.org/nina-warnungen-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Pass `--compact`. An empty `[]` (exit `0`) means **no active warnings for that region** —
a valid, reassuring answer, not an error.

> **Shell trap.** Piping this CLI's stdout straight into another process can yield an
> empty read under some Node builds. If `nina … | jq …` returns nothing, redirect to a
> file first (`nina --compact dashboard <ars> > out.json`) and read the file.

## Step 1 — Resolve the region to an ARS/AGS key

The `dashboard` command is addressed by **ARS** (Amtlicher Regionalschlüssel, 12 digits)
or **AGS** (Amtlicher Gemeindeschlüssel, 8 digits) — the official German regional key, not
a place name.

- If the user already gave a numeric key, use it.
- If they gave a town/district name, you must map it to its ARS. The structure is
  `SS RR KK GGGG` (state, Regierungsbezirk, district, municipality), zero-padded to 12,
  e.g. `091870000000` = Landkreis Rosenheim, `055150000000` = Kreis Recklinghausen.
  If you can resolve the key confidently, proceed; otherwise **ask the user for the ARS
  or the exact district name** rather than guessing — a wrong key silently returns `[]`
  and reads as "all clear" when it isn't.
- A district-level key (`…0000` municipality digits = 0) covers the whole district and is
  the safest default for "my area".

## Step 2 — Pull the region dashboard

```bash
nina --compact dashboard 091870000000 > dash.json
```

Returns an array of `DashboardEntry` objects. **Its shape differs from `map-data`** — do
not assume the summary fields. The fields that matter:

| Field | Meaning |
|---|---|
| `id` | The warning identifier — pass to `nina warning get <id>` / `geojson <id>`. |
| `i18nTitle.de` | The headline for this region (also `.en`, …). |
| `payload.data.severity` | `Minor`/`Moderate`/`Severe`/`Extreme`/`Unknown` — **ranking key** (note it's nested under `payload.data`, not top-level). |
| `payload.data.msgType` | `Alert`/`Update`/**`Cancel`** (all-clear). |
| `payload.data.urgency` | `Immediate`/`Expected`/… |
| `payload.data.provider` | Which source it came from (DWD, MOWAS, …). |
| `payload.data.area` | Human area string for the warning. |
| `onset` / `effective` / `expires` / `sent` | Time window (top-level ISO timestamps). |

## Step 3 — Filter and rank

Same triage as a national briefing, but scoped to this region:

- **Drop `payload.data.msgType === "Cancel"`** (Entwarnung) — withdrawn, not active.
- **Drop entries whose `expires` is in the past** relative to now.
- Rank survivors by `payload.data.severity` (`Extreme`→`Minor`→`Unknown`), then
  `urgency === "Immediate"` first, then most recent `sent`.

## Step 4 — Report

```
Lkr. Rosenheim (091870000000) — ⚠ 1 active warning

 🟠 MODERATE  Amtliche WARNUNG vor DAUERREGEN (DWD)
              onset 09.06 06:00 → expires 11.06 00:00 · Immediate
```

Rules:
- **Name the region and its key** so the user can confirm you resolved it correctly.
- Empty `[]` → "No active warnings for <region> right now." Be explicit it's a real
  all-clear, not a lookup failure — and that it depends on the key being right.
- Lead with severity; show the `onset`→`expires` window and the `provider`.
- Offer `nina warning get <id>` for the full CAP detail (instructions, area descriptions)
  of any entry, and `nina warning geojson <id>` to map its affected area.

## Step 5 — Monitoring / polling (when asked to "keep watching")

Don't re-pull dashboards on a tight loop. NINA publishes a cheap global change hash:

```bash
nina --compact reference data-version > ver.json   # { "version": N, "hash": "…", "entries":[…] }
```

Store the `hash`; on each poll, fetch `data-version` again and **only re-run the
`dashboard` query when the hash changed**. The hash is global (covers all regions/sources),
so a change doesn't guarantee *this* region changed — but an unchanged hash guarantees
nothing changed anywhere, so you can safely skip the dashboard call. Report new/cleared
warnings between polls by diffing entry `id`s.
