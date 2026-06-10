# nina-warnungen-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for live
German civil-protection intelligence, all powered by the **[nina](README.md)** CLI over the
open [NINA API](https://nina.api.bund.dev/) (`warnung.bund.de`) operated by the BBK.

Each skill teaches Claude how to drive the `nina` CLI to answer a specific, real-world
question — "any warnings right now?", "are there alerts for my district?", "map this
warning's affected area" — and to report the answer with evidence rather than guesswork.
They encode the parts that are easy to get wrong (Cancel/Entwarnung filtering, the
dashboard's different payload shape, the archive `.json`-suffix trap) so Claude doesn't
have to rediscover them each time.

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **nina-warning-briefing** | Merges current warnings across all six NINA sources, drops cancellations and expired entries, and ranks by severity. | "any warnings right now?", "current severe-weather warnings", "what's the BBK alert situation?" |
| **nina-region-watch** | Pulls the per-region dashboard for a place by its ARS/AGS key, ranks active warnings, and polls the data-version hash for monitoring. | "any alerts for my Landkreis?", "warnings in Rosenheim?", "keep watching my district" |
| **nina-warning-map** | Resolves a warning and exports its affected-area geometry as a valid GeoJSON `FeatureCollection`. | "map this warning", "what area does this alert cover?", "export the warning as GeoJSON" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that loads
  Agent Skills).
- **The `nina` CLI** installed globally:
  ```bash
  npm i -g @maschinenlesbar.org/nina-warnungen-cli   # installs the `nina` bin
  ```
  No API key is required — the NINA API is free, open, and read-only.

## Installation

### Plugin marketplace (recommended)

This repo is a Claude Code **plugin marketplace**, so installation is two commands inside
Claude Code:

```
/plugin marketplace add maschinenlesbar-org/nina-warnungen-cli
/plugin install nina@nina-skills
```

The first command registers the marketplace; the second installs the `nina` plugin,
which bundles all three skills. Update later with `/plugin marketplace update`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/nina-warnungen-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/` by swapping `~/.claude/skills` for
`.claude/skills`. Each skill lives in its own directory with a `SKILL.md`, e.g.
`skills/nina-warning-briefing/SKILL.md`. Start a new Claude Code session and the skills
are picked up automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from your
request. Just ask in natural language:

> Are there any civil-protection warnings in Germany right now?

> Any alerts for the Landkreis Rosenheim, most serious first?

> Map the affected area of this warning so I can open it in geojson.io.

You can also invoke a skill explicitly with its slash command, e.g. `/nina-warning-briefing`.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which
`nina` subcommands to call, in what order, and how to interpret the JSON. The skills
encode the non-obvious parts of this API, for example:

- a warning whose `type` (CAP `msgType`) is **`Cancel`** is an *Entwarnung* — the warning
  being **withdrawn**, not an active hazard; its headline reads `Entwarnung: …`. Naively
  listing one as a live warning is the most common mistake (see **nina-warning-briefing**);
- the German headline lives in **`i18nTitle.de`** (the title is a per-language map), and
  many `mowas` entries carry **no `expiresDate`** — treat those as still active rather than
  guessing an expiry;
- the **`dashboard` payload shape differs from `map-data`** — severity/msgType are nested
  under `payload.data`, and time fields (`onset`/`effective`/`expires`/`sent`) are
  top-level (see **nina-region-watch**);
- the `dashboard` endpoint is addressed by **ARS/AGS** regional key, not a place name, and
  a wrong key silently returns `[]` that reads as a false "all clear";
- `archive mapping` returns `history[].identifier` values **with a `.json` suffix** —
  passing one straight to `archive get` yields `…json.json` → 404; strip the suffix first;
- a **stale/unknown warning identifier** often comes back as an HTTP **`302`** (surfaced as
  exit `1`), not a clean `404` (exit `4`) — either way, re-fetch a fresh id;
- the `warning geojson` output is already valid GeoJSON in correct `[lon, lat]` order, but
  its feature `properties` are *rendering* hints (`fillColor`, `warnId`, …), not the
  headline/severity — pull those from `warning get` if you need map labels
  (see **nina-warning-map**);
- this CLI's **stdout pipe can come back empty** when piped straight into another process
  under some Node builds — redirect to a file (`-o`, or `> out.json`) and read it.

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md`
focused, give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md) for
the dual-licensing / commercial option.
