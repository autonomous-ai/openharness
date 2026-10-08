# Harness connections

Connect a service once on this computer; every local agent (Claude Code, Codex,
OpenCode) can then use it. Modelled on the Grid app's connectors: the same token
format, the same two sign-in paths and the same local bridge. Python standard
library only; no always-on process.

## Commands

```sh
harness connections                     # open the Connectors page; exits immediately
harness connections connect linear      # sign in from a terminal instead
harness connections list --json         # no secrets; shared by all local agents
harness connections info linear
harness connections refresh [linear]    # renew tokens that are due (or this one now)
harness connections sync                # write the agents' MCP entries again
harness connections disconnect linear
harness connections call github GET https://api.github.com/user
```

## Two ways to sign in

`catalog.json` lists every service with its `auth`.

**`dcr`: this computer signs in on its own.** The service's MCP server publishes
OAuth metadata (RFC 9728/8414) with a registration endpoint, so Harness
registers a public client for this computer (RFC 7591, `clients.json`), opens
the service's consent page with PKCE S256 and receives the code on
`http://127.0.0.1:51789-51792/callback`. No client secret ships with Harness and
no Autonomous server is involved. Renewal goes straight to the service's token
endpoint. 21 services, checked against their live metadata on 2026-10-08:

Ahrefs, Airtable, Amplitude, Apollo.io, Atlassian (Jira, Confluence), Attio,
Canva, ClickUp, Datadog, Figma, GitLab, Intercom, Klaviyo, Linear, monday.com,
Notion, Sentry, Stripe, Supabase, Supermetrics, Vercel.

**`app`: through the Autonomous connector gateway.** These services do not let
a computer register itself, so the OAuth app Autonomous registered with them is
used: `POST /v1/grid/connectors/start`, the browser signs in, then
`/connectors/poll` returns the token once. The gateway holds the app's secret and
renews tokens (`/connectors/refresh`). It needs the Harness sign-in
(`harness login` keeps the Grid session in `~/.grid/credentials.toml`); signed
out, the page says so instead of offering Connect. A service the gateway does
not offer to this account shows "Not available yet".

GitHub, Slack, Asana, HubSpot, PagerDuty, Gmail, Google Calendar, Google Drive,
BigQuery, Microsoft 365.

**Add custom** takes any remote MCP server URL: one that asks for sign-in uses the
`dcr` path, one with static headers (a personal token) is saved as given.

## Storage

`$XDG_DATA_HOME/harness-os/connections` (normally
`~/.local/share/harness-os/connections`): directory 0700, files 0600, written
atomically under one lock shared by every agent and the bridge.

- `tokens.json`: per connection, Grid's format: `access_token`,
  `refresh_token`, `expires_at`, `scope`, `account_name`, `source`
  (`dcr`/`gateway`/`custom`) and `mcp_entry {url, headers}`.
- `clients.json`: this computer's registered OAuth clients, by issuer.
- `bridge.json`: the bridge capability; `projections.json`: which agent entries
  Harness wrote; `page.json`: the running page.

## Agents and the bridge

Agent configs never hold a token. Each connection with an MCP server becomes an
entry pointing at `http://127.0.0.1:51793/<capability>/<code>/mcp`:

| Agent | File | Entry |
| --- | --- | --- |
| Claude Code | `~/.claude.json` | `mcpServers.<code> = {type: http, url}` |
| Codex | `~/.codex/config.toml` | `[mcp_servers.<code>] url = …` |
| OpenCode | `~/.config/opencode/opencode.json` | `mcp.<code> = {type: remote, url, enabled}` |

Only names recorded in `projections.json` are changed or removed; a server the
user added keeps its name and contents, and a config that is not plain JSON is
left alone.

`harness-connections.socket` listens on 127.0.0.1:51793; systemd starts
`bridge.py` on the first request and it exits after ten quiet minutes. The
bridge checks the capability, refuses browser requests (any `Origin`), renews a
token within five minutes of expiry (once, under the lock, so concurrent agents
and rotating refresh tokens are safe), forwards the MCP request with the stored
headers and streams the answer, event streams included. A token the service
rejects is renewed once; a revoked grant marks the connection "Reconnect" and the
agent gets that message, never the service's own sign-in challenge. Because the
address never changes, a renewed token needs no agent config change and running
agents keep working.

## Page

`connections.py serve` binds 127.0.0.1 only, requires an unpredictable
per-process capability for every API request, validates Host/Origin, serves no
CORS access and does not log requests. The capability is delivered in a URL
fragment and kept in that tab's session storage. Nothing is loaded from a CDN.
It exits after 15 minutes without requests or sign-ins in progress.

## Provenance

`connector.py` (`call`) and `../tests/test_connector_upstream.py` are adapted from
[Autonomous Intern](https://github.com/autonomous-ai/Physical-AI-Operating-System)
at `57faee5d8e7ee094701120c9bff4ce6ef8001fb2` (`skills/connectors/scripts/connector.py`,
`skills/connectors/tests/test_connector.py`), Apache-2.0; see LICENSE. Harness
changes: per-user paths, the shared token store, official-host allowlist per
service, response size checks and redaction.

## Local review

```sh
CONNECTOR_CONFIGS_DIR=/tmp/harness-connections-review \
  python3 os/connectors/connections.py serve
```

Open the printed local URL. Unit tests run every path against fake OAuth, MCP
and gateway servers; real provider sign-in remains a manual acceptance step.
