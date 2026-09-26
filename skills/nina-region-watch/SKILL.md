---
name: nina-region-watch
description: >
  Check or monitor civil-protection warnings for a specific German region using
  the nina-warnungen-cli. Trigger when the user asks "are there warnings in
  Heidelberg?", "any alerts for my area / Landkreis / Kreis?", "warnings
  near me", "is it safe in the Ahrtal?", or wants ongoing monitoring of one place.
  Resolves the place to its district-level ARS regional key, pulls the
  per-region dashboard feed, and can re-check it periodically, reporting new,
  changed and cleared warnings.
compatibility: >
  Requires the `nina` CLI (npm package @maschinenlesbar.org/nina-warnungen-cli)
  on PATH, installed by the user; the skill never installs it. Uses jq for JSON
  filtering. Network access to warnung.bund.de.
---

# NINA Region Watch

Answer "what's being warned about **in this specific place**?" by querying NINA's
per-region dashboard, and support lightweight monitoring by re-checking that dashboard —
instead of fetching national feeds and filtering by hand.

## Tooling

This skill drives the `nina` command. **Before anything else, validate it is available** — run `command -v nina` (or `nina --version`). If it is not on your PATH, STOP and inform the user that the `nina` CLI (`@maschinenlesbar.org/nina-warnungen-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

Pass `--compact`. An empty `[]` (exit `0`) means **no active warnings for that region** —
a valid, reassuring answer, not an error.

> **Shell trap.** Piping this CLI's stdout straight into another process can yield an
> empty read under some Node builds. If `nina … | jq …` returns nothing, redirect to a
> file first (`nina --compact dashboard <ars> > out.json`) and read the file.

## Step 1 — Resolve the region to a district ARS

The `dashboard` command is addressed by a **district-level ARS** (Amtlicher
Regionalschlüssel): 12 digits, the first five for the district (`SS` state, `R`
Regierungsbezirk, `KK` Kreis) and the **last seven always `0000000`** — NINA publishes the
dashboard only per Kreis / kreisfreie Stadt. It is not a place name. The CLI checks the
shape before sending and refuses anything else (exit `1`, no request), naming the district
key when it is clear.

- If the user gave a 12-digit district key, use it.
- If they gave an **8-digit AGS** (Amtlicher Gemeindeschlüssel) or a 12-digit
  municipality ARS, keep its **first five digits and append `0000000`** — e.g. AGS
  `06535011` (Lauterbach (Hessen)) → `065350000000` (Vogelsbergkreis). Passed as is, an
  AGS or a municipality ARS is refused by the CLI (exit `1`, the message names the
  district key).
- If they gave a town/district name, map it to its district, e.g. `091870000000` =
  Landkreis Rosenheim, `055620000000` = Kreis Recklinghausen, `055150000000` = Münster.
  If you can resolve the key confidently, proceed; otherwise **ask the user for the
  district** rather than guessing.
  A **state-level** key (digits 3–5 `000`, e.g. `050000000000` for NRW) is refused by the
  CLI (exit `1`, no request), because the API answers it with `[]` even while a district
  in that state has warnings — pick the district instead. Hamburg (`020000000000`) and
  Berlin (`110000000000`) are their own district. Most other keys that don't exist fail
  (HTTP 404, exit `4`), but a *wrong existing* district answers with that district's
  warnings — or `[]`, which reads as "all clear" for the wrong place.

## Step 2 — Pull the region dashboard

```bash
nina --compact dashboard 091870000000 > dash.json
```

Returns an array of `DashboardEntry` objects. **Its shape differs from `map-data`** — do
not assume the summary fields. The fields that matter (checked live on 2026-09-15):

| Field | Meaning |
|---|---|
| `id` | The warning identifier — pass to `nina warning get <id>` / `geojson <id>`. |
| `i18nTitle.de` | The headline for this region (also `.en`, …). `payload.data.headline` can be cut off with `...`. |
| `payload.data.severity` | `Minor`/`Moderate`/`Severe`/`Extreme`/`Unknown` — **ranking key** (note it's nested under `payload.data`, not top-level). |
| `payload.data.msgType` | `Alert`/`Update`/**`Cancel`** (all-clear). (`payload.type` is a different field — it said `ALERT` on an `Update`.) |
| `payload.data.urgency` | `Immediate`/`Expected`/`Future`/`Past`, and **`Unknown`** (seen on KATWARN). |
| `payload.data.provider` | Which source it came from (DWD, MOWAS, KATWARN, …). |
| `payload.data.area` | **Not a readable place.** An encoded area reference, e.g. `{"type":"GRID","data":"268119,268731+1,500001"}` or `{"type":"ZGEM","data":"5981,100001"}`. The readable area is in `nina warning get <id>` → `info[].area[].areaDesc` (e.g. `Teile von Lauterbach`). |
| `payload.hash` | A per-entry hash — compare it between checks to spot a changed entry (Step 5). |
| `sent` / `effective` | Top-level ISO timestamps: when the message was sent, and (not on every entry) when it takes effect. **There is no `onset` or `expires` on dashboard entries.** |

## Step 3 — Filter and rank

Same triage as a national briefing, but scoped to this region:

- **Drop `payload.data.msgType === "Cancel"`** (Entwarnung) — withdrawn, not active.
- **Expiry isn't on the dashboard.** If the end time matters, look it up per entry:
  `nina warning get <id>` → `info[].expires`, or the entry's `expiresDate` in
  `nina map-data <source>`. Both are often missing or `null` — then say "no expiry given"
  and treat the warning as active; don't guess one.
- Rank survivors by `payload.data.severity` (`Extreme`→`Minor`→`Unknown`), then
  `urgency === "Immediate"` first, then most recent `sent`.

## Step 4 — Report

```
Lkr. Rosenheim (091870000000) — ⚠ 1 active warning

 🟠 MODERATE  Amtliche WARNUNG vor DAUERREGEN (DWD)
              effective 09.06 06:00 · expires 11.06 00:00 (from warning get) · Immediate
```

Rules:
- **Name the region and its key** so the user can confirm you resolved it correctly.
- Empty `[]` → "No active warnings for <region> right now." Be explicit it's a real
  all-clear, not a lookup failure — and that it depends on the key being right.
- Lead with severity; show `effective` (or `sent`), an expiry only if you looked one up
  (Step 3), and the `provider`.
- For a readable area, use `info[].area[].areaDesc` from `nina warning get <id>`, never
  the encoded `payload.data.area`.
- Offer `nina warning get <id>` for the full CAP detail (instructions, area descriptions)
  of any entry, and `nina warning geojson <id>` to map its affected area.

## Step 5 — Monitoring / polling (when asked to "keep watching")

Re-check the region's dashboard itself — it is one small file — a few minutes apart, not
on a tight loop:

```bash
nina --compact dashboard 091870000000 > dash-new.json
```

Compare with the previous result: an `id` that is new is a new warning, an `id` that is
gone has been cleared, and the same `id` with a different `payload.hash` (or a
`payload.data.msgType` that is now `Update`/`Cancel`) has changed. Report only those
differences.

> **Don't use `nina reference data-version` as the trigger.** It is not a warnings change
> hash: its only entry is named `labels` (no warning data), and on 2026-09-15 its file
> was last modified (HTTP `Last-Modified`) on 12 September, while the `mowas` and `dwd`
> warning feeds had changed that evening. An unchanged data-version hash says nothing
> about warnings.
