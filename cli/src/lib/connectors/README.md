# Harness connections

Connect a service once on a computer; every local agent (Claude Code, Codex, OpenCode) can then use it.
Modelled on the Grid app's connectors: the same token format, the same two sign-in paths and the same
local bridge. One implementation for every Harness: macOS, Linux, Windows and Harness OS.

- `harness connections`: the Connectors page in the browser (the CLI, `command.ts`, `page.ts`).
- The desktop app: Settings → Connectors, over the `connectors` request (`services/connectors.ts`).
- The MCP bridge on 127.0.0.1:51793 runs in the daemon (`services/connectors.ts`, edge host).

## Commands

```sh
harness connections                     # open the Connectors page; returns at once
harness connections connect linear      # sign in from a terminal instead
harness connections list --json         # no secrets; shared by all local agents
harness connections info linear
harness connections refresh [linear]    # renew tokens that are due (or this one now)
harness connections sync                # write the agents' MCP entries again
harness connections disconnect linear
harness connections call github GET https://api.github.com/user
```

## Which services

The list is the Grid app's, bundled as `assets/catalog.json`. Signed in (`harness login`), the Harness
connector gateway's `GET /api/connectors` adds which `app` services it signs in to; signed out, those
wait for `harness login`. `scripts/update-connector-catalog.ts` rebuilds the snapshot and its icons from
Grid's catalog; `scripts/connector-assets.mjs` turns `assets/` into `generated/` (cli.js carries them; a spec
keeps the two in step). Codes are Grid's; a connection saved under an earlier code (`apollo`,
`supermetrics_marketing`) is read under Grid's (`apollo_io`, `supermetrics`).

## Two ways to sign in

**`dcr`: this computer signs in on its own** (`oauth.ts`). The service's MCP server publishes OAuth
metadata (RFC 9728/8414) with a registration endpoint, so Harness registers a public client for this
computer (RFC 7591, `clients.json`), opens the consent page with PKCE S256 and receives the code on
`http://127.0.0.1:51789-51792/callback`. No client secret ships with Harness and no Autonomous server is
involved. Renewal goes straight to the service's token endpoint. 78 of Grid's 86 services (2026-10-09):
every one Grid marks `dcr`, plus Linear, Notion, Amplitude and monday.com, which Grid signs in through
its gateway but whose MCP servers also allow self-registration.

**`app`: through the Harness connector gateway** (`gateway.ts`; backend `routes/connectors.ts`, the same
requests as Grid's). These services let no computer register itself, so the OAuth app Autonomous
registered with them is used: `POST /api/connectors/start`, the browser signs in, then
`/api/connectors/poll` returns the token once. The gateway holds the app's secret and renews tokens
(`/api/connectors/refresh`); a grant it no longer holds marks the connection "Reconnect". It asks with
the Harness sign-in (`~/.harness/auth/session.json`, `lib/controlPlane.ts`). GitHub, Slack, Asana,
HubSpot, Gmail, Google Calendar, Google Drive, Figma (`figma-api-app`). Signed out, they are listed with
Connect disabled and "Needs harness login".

**REST tools as MCP** (`rest.ts`). Gmail, Google Drive, Google Calendar and Figma have no MCP server the
grant can use. As in the Grid app, the gateway sends their `rest_entry` (each tool one HTTPS request
template) with `transport: rest`, and the bridge is their MCP server: `tools/list` from the entry,
`tools/call` sent from this computer with the token in the entry's header. Path values are
percent-encoded, an optional parameter left out is left out, Gmail's message is RFC 2822 (UTF-8, no header
injection) in base64url, a Drive upload is `multipart/related`, and a failed call is a result the model
reads (`isError`), in words a person can act on.

**Add custom** takes any remote MCP server URL: one that asks for sign-in uses the `dcr` path, one with
static headers (a personal token) is saved as given.

## Storage

`~/.harness/connections` (`HARNESS_CONNECTIONS_DIR` moves it), beside the computer id and outside
`cli/data`, so `harness reset` does not sign anyone out of their services: directory 0700, files 0600,
written atomically under one lock shared by every agent, the bridge and the page. Harness OS 0.1.2 kept
them in `~/.local/share/harness-os/connections`; they are moved here the first time.

- `tokens.json`: per connection, Grid's format: `access_token`, `refresh_token`, `expires_at`, `scope`,
  `account_name`, `source` (`dcr`/`gateway`/`custom`), `mcp_entry {url, headers}`, or `rest_entry` and
  `transport` for a REST-backed service.
- `clients.json`: this computer's registered OAuth clients, by issuer.
- `bridge.json`: the bridge capability; `projections.json`: which agent entries Harness wrote;
  `page.json`: the running page.

## Agents and the bridge

Agent configs never hold a token (`agents.ts`). Each connection with tools (an MCP server, or REST tools
the bridge serves) becomes an entry
pointing at `http://127.0.0.1:51793/<capability>/<code>/mcp`:

| Agent | File | Entry |
| --- | --- | --- |
| Claude Code | `~/.claude.json` (`$CLAUDE_CONFIG_DIR`) | `mcpServers.<code> = {type: http, url}` |
| Codex | `~/.codex/config.toml` (`$CODEX_HOME`) | `[mcp_servers.<code>] url = …` |
| OpenCode | `~/.config/opencode/opencode.json` | `mcp.<code> = {type: remote, url, enabled}` |

Only names recorded in `projections.json` are changed or removed; a server the person added keeps its
name and contents, a config that is not plain JSON is left alone, and a symlinked config is written
through its link. The daemon writes the entries again as it starts, so an agent installed after a
service was connected gets it too. An agent reads its MCP servers when it starts: one already running
sees a new connection after it is restarted.

The bridge (`bridge.ts`) checks the capability, refuses browser requests (any `Origin`), renews a token
within five minutes of expiry, forwards the MCP request with the stored headers and streams the answer,
event streams included. A token the service rejects is renewed once; a revoked grant marks the
connection "Reconnect" and the agent gets that message, never the service's own sign-in challenge.
Because the address never changes, a renewed token needs no agent config change.

## Page

`harness connections serve` binds 127.0.0.1 only, requires an unpredictable per-process capability for
every API request, validates Host/Origin, serves no CORS access and does not log requests. The
capability is delivered in a URL fragment and kept in that tab's session storage. Nothing is loaded
from the network. It exits after 15 minutes without requests or sign-ins in progress.

## Provenance

`call.ts` is adapted from [Autonomous Intern](https://github.com/autonomous-ai/Physical-AI-Operating-System)
at `57faee5d8e7ee094701120c9bff4ce6ef8001fb2` (`skills/connectors/scripts/connector.py`), Apache-2.0;
see LICENSE. Harness changes: per-user paths, the shared token store, the official-host allowlist per
service, response size checks and redaction.

## Local review

```sh
HARNESS_CONNECTIONS_DIR=/tmp/harness-connections-review npx tsx src/cli.ts connections serve
```

Open the printed local URL. The specs (`connectors.spec.ts`, `services/connectors.spec.ts`) run every
path against fake OAuth, MCP and gateway servers (`testing/connectorServers.ts`); real provider sign-in
remains a manual acceptance step.
