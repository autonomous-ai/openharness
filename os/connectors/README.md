# Harness connections

An OS-owned CLI and on-demand local settings page. No new engine integration,
MCP server, desktop release, always-on daemon or third-party Python dependency.

## Provenance

`connector.py` and `../tests/test_connector_upstream.py` are adapted from
[Autonomous Intern](https://github.com/autonomous-ai/Physical-AI-Operating-System)
at `57faee5d8e7ee094701120c9bff4ce6ef8001fb2`:

- `skills/connectors/scripts/connector.py`
- `skills/connectors/tests/test_connector.py`

Licensed under Apache-2.0; see LICENSE. Harness changes: per-user paths, private
atomic storage shared across agents, JSON discovery, expiry
handling, Figma/Linear personal-token headers, response size checks and local
connection management. The small service guide adapts Intern's connector
instructions; it omits Intern hardware, MQTT and agent-runtime setup.

Provider-specific authentication was checked against
[Figma](https://developers.figma.com/docs/rest-api/personal-access-tokens/),
[Linear](https://linear.app/developers/graphql) and their account identity
endpoints. Provider account tests remain a separate acceptance requirement.

## Commands

```sh
harness connections                 # opens local settings; exits immediately
harness connections list --json     # no secrets; shared by all local agents
harness connections info github
harness connections call github GET https://api.github.com/user
harness connections disconnect github
```

State is under `$XDG_DATA_HOME/harness-os/connections`, normally
`~/.local/share/harness-os/connections`: directory 0700, files 0600. The
per-service JSON shape stays compatible with Intern. Credentials are not copied
into projects or agent config. This avoids routine token exposure; it is not a
sandbox against an agent running arbitrary code as the same Unix user.

The page binds only 127.0.0.1, requires an unpredictable per-process capability
for every API request, validates Host/Origin, serves no CORS access and does not
log requests. Its capability is delivered in a URL fragment and retained only
in that browser tab's session storage so refreshing the page works.
Nothing is loaded from a CDN. The process exits after 15 minutes without
authenticated requests; reopening the CLI reuses a live instance or starts one.

## Architecture

Connections belong to the local user on an ordinary computer running Harness.
Connect an account once, then Claude Code, Codex, OpenCode, pi or another agent
can use the same CLI and service instructions. Agents name a connection; the CLI
reads its credentials. Changing agents does not require reconnecting accounts.
Another computer or Unix user has a separate connection store.

Intern is the source of the reusable connector code. There is no Intern device,
MQTT connection, device key, hardware registration or additional agent runtime.
No provider app secret belongs in an OS image, project or agent configuration.
The settings page runs only when needed and does not require a cloud account for
manual token connections.

## Browser sign-in — not implemented yet

Manual tokens work for GitHub, Notion, Linear, Asana and Figma. Browser OAuth and
automatic renewal are not enabled. Expired credentials remain saved but cannot
be used; the CLI asks the user to reconnect. A `backend.json` from an earlier
development draft is ignored and cannot enable Intern device authentication.

The remaining integration must deliver the result of browser consent to the
local connection request, without an Intern device record. For providers that
require a confidential OAuth client, its secret stays on the authorization
server. The computer receives the user's authorized credentials and stores them
locally. Credential delivery must be short-lived, single-use and bound to the
requesting client; renewal must handle concurrent agents and rotated tokens.
Disconnecting local access and revoking access at the provider are different
operations and must be described accurately.

The existing Intern server code was reviewed read-only. Its provider integration
can inform this work, but its hardware delivery mechanism is not an OS
requirement. No private backend implementation or configuration is included.
Do not add device enrollment or require a different product account to bridge
that gap. Complete real browser sign-in, renewal, disconnect and cross-agent
acceptance before enabling OAuth-only services such as Gmail, Calendar and Drive.

## Local review

```sh
CONNECTOR_CONFIGS_DIR=/tmp/harness-connections-review \
  python3 os/connectors/connections.py serve
```

Open the printed local URL. This creates only isolated review state; enter a
real token only when intentionally testing that account. Unit tests use mocked
provider responses and disposable credentials. Packaging includes the CLI,
page, guide and license in the normal OS package, so installed machines receive
it via an OS update without an ISO. No update has been published by this change.
