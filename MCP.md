# nina-mcp

An [MCP](https://modelcontextprotocol.io/) server for NINA, the federal civil-protection warning
system of the Bundesamt für Bevölkerungsschutz und Katastrophenhilfe (BBK): the live warnings of
MoWaS (federal and state civil protection), KATWARN and BIWAPP (municipal), the Deutscher
Wetterdienst (severe weather), the states' flood portals (LHP) and the police, as tools for AI
agents. Read-only, no API key.

The data comes from `warnung.bund.de/api31`, the backend of the NINA app, documented by the
community at [nina.api.bund.dev](https://nina.api.bund.dev/), not by the BBK: it can change
without notice. The official warnings are amtliche Werke (§ 5 UrhG): free to pass on with the
source named and the content unaltered.

It is the MCP side of [nina-warnungen-cli](https://github.com/maschinenlesbar-org/nina-warnungen-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/nina-warnungen-mcp
```

This installs the **`nina-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/nina-warnungen-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add nina -- nina-mcp
# or with the image:
claude mcp add nina -- docker run -i --rm ghcr.io/maschinenlesbar-org/nina-warnungen-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "nina": { "command": "nina-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "nina": { "type": "stdio", "command": "nina-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
nina-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http nina http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/nina-warnungen-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/nina-warnungen-cli/releases) instead of
`latest`: `…/nina-warnungen-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/nina-warnungen-mcp:<version> --repo maschinenlesbar-org/nina-warnungen-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `getWarningBriefing` | The warnings in force in Germany from all six sources (or some) in one list, most severe first, then the most urgent and newest; cancellations (Entwarnung) and expired entries dropped and counted, never shown as active; the same headline over several areas counted once; a source that could not be read named. |
| `getRegionWarnings` | The warnings in force for one Kreis or kreisfreie Stadt, by its 12-digit regional key (an AGS or a municipality's key is taken to its district; state keys and place names are refused), with the readable area and the advice of the top five, and on request what is new, changed or cleared since an earlier answer. |
| `getWarningArea` | The affected area of one to five warnings as one GeoJSON FeatureCollection, checked, optionally labelled with headline and severity, a page of features at a time; ids no longer live are named. |
| `getWarningDetail` | One warning in full in one language (German by default, easy German for MoWaS): times, description, advice, areas, sender; an id no longer live is answered with the reason and its archive address. |
| `listSourceWarnings` | One source's feed as it sends it, cancellations included, a page at a time. |
| `getWarningHistory` | The MoWaS archive: a warning's revisions, or one archived revision in full. |

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from and the data licence. A failure is a tool error that says what to change.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API base URL (default https://warnung.bund.de)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages; a page on one of
  those origins gets CORS (its preflight answered, the answers readable). With `--auth-token-file
  <path>` every request must send `Authorization: Bearer <token>` (the file holds one token of at
  least 32 characters, mode 600, owned by the user the server runs as; read once at start; `(umask
  077; openssl rand -hex 32 > mcp-token)` makes one); anything else is answered 401. Exposed beyond
  localhost (it logs a warning then), it belongs behind a proxy that authenticates or at least
  terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses on HTTP 429 (as long as its Retry-After asks, at most 30 s), and stops a
  tool call after its deadline (a tool that has read part of its answer by then may answer with that
  part, and says so). A request those limits would hold longer than it or its call may wait is not
  sent: the call fails at once, naming the limit and when to ask again (and the log says so).
- **Results are data.** Text from the API is cleaned (control, bidi and zero-width characters
  removed), but it is still other people's text: a model can be told things in it. The server
  can't act on that (it has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new
  connection and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal
  ends it at once. On stdio it ends at once, and when stdin ends.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol. A call that fails
  upstream or reaches its deadline leaves a WARN record naming the tool.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/nina-warnungen-cli/blob/main/LICENSING.md)).
Data: the BBK's official warnings are amtliche Werke under § 5 Abs. 2 UrhG, free to reuse and
pass on, also commercially, as long as the source is named and the content is not altered
([DATA_LICENSE.md](https://github.com/maschinenlesbar-org/nina-warnungen-cli/blob/main/DATA_LICENSE.md),
[the BBK's terms](https://www.bbk.bund.de/DE/Warnung-Vorsorge/Warn-App-NINA/NINA-Rechtliches/nina-rechtliches.html)).
The tools select, rank, group and reformat warnings (only `<br/>` becomes a line break) but pass
their texts on as published, and every result's `licence` field carries the BBK's attribution
and that rule. Single warnings come from third parties (the DWD, the states' flood portals, the
police): name them too. The BBK's own app content (the emergency tips, graphics) is not part of
the warnings and is left out. Running this server as a service for others passes the warnings
on: the attribution and the no-alteration rule go with them.
