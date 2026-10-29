# autonomous-harness-backend — central product API + single-port reverse proxy

The **central, public-facing** backend for the distributed deployment. It is the **one port** the
web connects to. It:

1. **Manages users + auth** — `POST /api/auth/login {email,password}` issues a JWT. An unknown email
   is **created on the spot** (login doubles as signup). Admin-only user CRUD under `/api/users`.
2. **Provisions agent-nodes** — `POST /api/agents` generates a per-agent api-key, **picks a
   manager by capacity** (reads `maxNodes`/`nodeCount` from the shared `managers` collection;
   best-fit = the live manager with the least free room, 503 if all full), calls that manager's
   control API to create the node, and stores the `user → agentId/apiKey/managerUrl` binding.
   `DELETE /api/agents/:agentId` tears it down. The data-plane proxy then targets the binding's
   manager.
3. **Reverse-proxies the data plane** — every other `/api/*` request and the `/api/ws` WebSocket are
   authenticated by the **agent api key** (NOT the JWT): the client sends it (`x-api-key` for HTTP,
   the WS subprotocol) on a **`/proxy/...`** path, the backend derives `agentId = sha256(key)[:32]`,
   looks up the owning manager, and forwards the path verbatim to it (the manager mounts its data
   plane under `/proxy` and strips it before the node). So any client (a CLI, another app, the web
   chat page) can reach an agent with **only its api key**. The owner obtains that key from the
   control plane (#2); possessing it is the auth (128-bit preimage).

```
control:  web ──(JWT)──────────────────────▶ backend :8085 /api/auth|users|agents ──(x-api-key: MANAGER_API_KEY)──▶ manager :8090/api
data:     client ──(agent api key: x-api-key / WS subprotocol)──▶ backend :8085 /proxy/api/* ──▶ manager :8090/proxy/api/* ──▶ agent-node/api/*
```

## One port, two planes

A single `http.Server` (`server.ts` `serverFactory`) splits traffic by an explicit path prefix:

- **Data plane (reverse-proxied):** everything under **`/proxy/*`** (incl. the `/proxy/api/ws`
  upgrade) → `lib/proxy.ts`.
- **Local (Fastify control API):** everything else — `/api/health`, `/api/auth/*`, `/api/users/*`,
  `/api/agents*`. A stray `/api/*` that isn't a control route now 404s here instead of being proxied.

## Run

```bash
npm install            # runs `prisma generate`

# Needs MongoDB (shared with the agent-manager) + a running agent-manager:
#   cd ../autonomous-code/apps/mongodb && docker compose up -d
#   cd ../autonomous-code/apps/machine-manager && npm run dev
npm run dev            # tsx watch, :8085 by default
```

Copy `.env.example` → `.env` and set at least `MANAGER_API_KEY` (to match the manager) and a
`DATABASE_URL` pointing at the **same** MongoDB the manager uses. Production SSO/profile URLs are
the defaults; override `SSO_ISSUER`, `SSO_PROFILE_URL` and `SSO_IDENTITY_URL` with the staging hosts for local testing
(the identity URL is asked first — leave it on production and staging tokens are refused there).

| dev | build | other |
|-----|-------|-------|
| `npm run dev` (tsx watch) | `npm run build` (esbuild via `build.mjs`) | `npm run typecheck`; `npm run test` (vitest) |

### CLI terminal P2P canary

Remote CLI-to-CLI terminals can use an ordered WebRTC DataChannel while authentication, encrypted
signaling, chat/RPC, and fallback remain on the existing WebSocket path. This mode is STUN-only and
does not require or use TURN. Configure `TERMINAL_P2P_ROLLOUT_PERCENT` (default `100`; set `0` as the kill switch),
`TERMINAL_P2P_STUN_URLS` (default Cloudflare STUN), and `TERMINAL_P2P_OPEN_WAIT_MS` (default `1500`).
When direct ICE fails, the terminal opens on WebSocket relay automatically.

## Deploy

`../.github/workflows/production-be-build.yaml` builds and pushes the production Docker image on
tag push. Backend releases are tagged **`vX.Y.Z_backend`** — the `_backend` suffix is what routes the push
to this workflow instead of the CLI's `../.github/workflows/release.yml` (which only reacts to
`vX.Y.Z_cli`), now that both live in this one repo. Cut one with:

```bash
make release-backend                      # patch bump
make release-backend ARGS=minor           # or major
make release-backend ARGS="1.4.1"         # exact version
make release-backend ARGS=--dry-run       # preview, tags/pushes nothing
```

(equivalent to `bash backend/scripts/release-be.sh`, see that script for details).

The script refuses a checkout that lacks the last `vX.Y.Z_backend` release's commit: it would deploy
older code under a newer version. Update the checkout first; `ARGS=--allow-older` is for a rollback.

### Memory sizing and Redis limits

The `backend` app runs as a pm2 cluster: every worker has its own V8 heap. `ecosystem.config.cjs`
pins the heap with `--max-old-space-size` (`BACKEND_HEAP_MB`, default 1024) and recycles a worker at
`BACKEND_MAX_MEMORY` (default `1536M`), so size the container roughly as
`instances × BACKEND_MAX_MEMORY × 1.25`. `Dockerfile.k8s` runs one plain `node` per container — pass
`NODE_OPTIONS=--max-old-space-size=…` there and set the pod limit ~1.5× that.

Per-process ceilings that bound WebSocket memory (all in `src/lib`): `wsServer.ts` `WS_LIMITS`
(inbound frame size per endpoint), `wsSend.ts` `SEND_HIGH_WATER` / `SEND_KILL_WATER` (outbound
backpressure: droppable frames skipped, slow consumers closed 1013), `orderedInbox.ts`
`DEFAULT_MAX_INFLIGHT` (queued frames per socket), `VOICE_INFLIGHT_MAX_BYTES` (PCM held for STT across
all device sockets) and `APP_PROXY_MAX_RELAY_FRAME_BYTES` (largest app-proxy frame relayed cross-instance).

App-proxy bodies can cross instances through Redis pub/sub in multi-MiB messages. Redis' default
`client-output-buffer-limit pubsub 32mb 8mb 60` disconnects a subscriber that falls behind, so on the
Redis side set it to at least `64mb 16mb 60` and alert on `client_recent_max_output_buffer`. The
app-proxy channels ride their own subscriber connection (`appSub` in `bus.ts`), so a disconnect there
cannot take the chat / presence subscriptions down with it.

### Liveness, readiness and drain

`/api/health` is liveness: the process answers, with no dependency calls, so a Mongo or Redis outage
never makes Kubernetes restart pods. `/api/ready` is readiness (`src/lib/readiness.ts`): 200 while Mongo
answers a `ping` and Redis a `PING` (Redis only where `REDIS_URL` is set), each within 1 s; 503 naming
the failed or timed-out one otherwise. One answer serves every probe for 1 s, so probes add at most one
ping per dependency per second per process. From the moment a process gets SIGTERM, `/api/ready` answers
503 `draining`, and it keeps serving for `DRAIN_DELAY_MS` (default 0, closing at once as before) before it
closes its listeners, drains its WebSockets and disconnects Mongo and Redis.

Set `DRAIN_DELAY_MS` only on the Kubernetes image (`Dockerfile.k8s`), never under pm2: in cluster mode a probe
reaches whichever worker the master picks, so one worker's 503 says nothing, and pm2 kills a worker that has not
exited within `kill_timeout` (10 s, `ecosystem.config.cjs`).

Settings for the `api` Deployment (the `job` Deployment serves no HTTP and has no probes):

```yaml
terminationGracePeriodSeconds: 30   # DRAIN_DELAY_MS + up to ~10 s of socket drain and close, plus margin
containers:
  - name: backend
    env:
      - name: DRAIN_DELAY_MS
        value: "15000"              # readiness needs up to 10 s to fail, then the ingress a few more to drop
                                    # the pod. No preStop sleep: the process keeps serving on its own
    startupProbe:
      httpGet: { path: /api/health, port: 8085 }
      periodSeconds: 2
      timeoutSeconds: 2
      failureThreshold: 30          # up to 60 s to start listening
    livenessProbe:
      httpGet: { path: /api/health, port: 8085 }
      periodSeconds: 10
      timeoutSeconds: 3
      failureThreshold: 3           # restart only after ~30 s without an answer (a stuck event loop)
    readinessProbe:
      httpGet: { path: /api/ready, port: 8085 }
      periodSeconds: 5
      timeoutSeconds: 2             # above the 1 s dependency timeout
      successThreshold: 1
      failureThreshold: 2           # out of rotation within ~10 s of an outage or a drain
```

## Connector gateway

`routes/connectors.ts`, `lib/connectorGateway.ts`: sign-in to GitHub, Slack, Asana, HubSpot, Gmail,
Google Calendar, Google Drive and Figma for `harness connections` and the desktop app's Settings ▸
Connectors. These services let no computer register its own OAuth client, so the OAuth apps Autonomous
registered with them are used, with the same requests and answers as the Grid control plane
(`autonomous-grid-be` `grid_networks/connectors.py`). Every other service signs in from the computer.

To turn it on:

1. **`CONNECTOR_REDIRECT_URI`**: the page every one of those apps allows. Production keeps the default,
   `https://www.autonomous.ai/connector/callback`; staging,
   `https://staging.autonomousdev.xyz/connector/callback`.
2. **The collections**: `prisma db push` (run at startup) creates `connector_apps` and
   `connector_credentials` with their unique indexes. Both are kept as they are, not encrypted: the
   database is private.
3. **The apps**, one row per service in `connector_apps` (`code`, `clientId`, `clientSecret`, `authUrl`,
   `tokenUrl`, `scopes`, `extra: {mcp_url, token_field, mcp_auth_header, rest_entry, transport}`, `enabled`…).
   A service with no MCP server the grant can use (Gmail, Google Drive, Calendar, Figma) has `rest_entry`, its
   REST tools: the gateway hands it over with the token, untouched, and the computer's bridge serves those
   tools to agents as MCP, calling the service itself. The rows are edited in
   Compass, or written from a file with `npm run connectors:import <config-connector-auth.json>` (the
   backend's `DATABASE_URL`). The file is the Grid control plane's shape; only `auth_type: app` entries
   are written. Production's are the `app` entries of Grid prod's
   `/var/lib/grid-apis/config-connector-auth.json`; staging's, Grid dev's. The file is never in git.
   Running it again replaces those services; the gateway sees any change within a minute.
   `enabled: false` switches a service off.
4. **The Autonomous web callback page** forwards a state that starts `harness_` to
   `POST /api/connectors/callback`, as it forwards `grid_` to Grid (ecm-website v1.28.18).

With no row in `connector_apps`, the gateway lists no service and starts no sign-in; nothing else changes.

## Persistence

Prisma over the **same MongoDB** as the agent-manager (no migration files — `prisma db push` at
startup). The backend owns the `users` + `agent_bindings` collections; it never manages the
manager-owned `agent_nodes`/`managers` (read those via raw queries when status enrichment is needed).

### Product usage with an account-wide privacy control

**Settings → Privacy → Share product usage data** on desktop and phone, or
`harness privacy status|on|off [--json]`, controls the signed-in account. New accounts default on;
an existing legacy opt-out stays off until the person explicitly enables sharing. Guest computers
send no product reports. This control does not disable operational records needed to run the service.

The gateway reduces lifecycle signals locally to a fixed vocabulary: active/working installation
days, first measured work and response, repeat work, D1/D7 and consecutive-week returns, app opens,
launch attempts and outcomes, request refusals, response waits, matched turn ends/interruption,
error-event counts, and coarse duration buckets. A first-launch cohort counts work and a text response
within 24 hours of an installation's first measured launch attempt. Only day and counts leave the
computer; its bounded local state keeps the follow-up flags. These are updated installations, not
necessarily new people, and a response is not a judgment of task success.

Launch outcomes follow the existing durable creation receipt. Status polling adds no attempts;
install/model/native waits stay pending until an observed created, failed, cancelled or unconfirmed
reply. A 15-minute observation bound or memory-cap eviction records an unknown outcome, not a
failure. A daemon restart loses in-flight matches. Fixed request counters also cover resume, restart,
model changes and history. Only exact known error codes select a fixed failure category; messages
are never read. The response timer measures the first text event after an observed turn start,
not model tokens or output quality; tool-only turns can have no text response.

hn (the `tui` surface) adds fixed `ui_tui_*` flow and `health_tui_*` milestone counters through its
local daemon's queue, under the same account choice: connections, computer linking, viewer opening,
app start, workspace ready, resume recovery, and once-per-session workspace-ready, first-work and
first-response milestones. It records only while signed in and sends nothing observed before sign-in.
Its counters go in reports of their own, so a backend without the `tui` names rejects only those; the
daemon then drops them until the next UTC day or its restart, and records no delivery failure for it.

No prompt, response text, transcript, code, file or project name, path, tool argument, error text,
engine name, or stable user/device/agent identifier is a report field. Agent and launch identifiers
exist only in bounded in-memory maps (1,000 entries each) and never enter disk queues or HTTP reports.
The server authenticates requests to check the preference; this is **not anonymous network traffic**.
No analytics SDK, session replay, fingerprinting, or third-party destination is added.

With sharing on, Privacy settings also offers optional feedback: Useful, Couldn't finish, Slow,
Confusing, or Missing a feature. A deliberate button press sends only the fixed choice and a random
retry receipt. It cannot include text, a task identifier or content. Ambiguous retries keep the same
receipt and answer. This is self-selected feedback, not the task success rate of all users.

The product usage collections have distinct purposes:

| Collection | Fields retained | Lifetime |
| --- | --- | --- |
| `product_usage_preferences` | Account ID, enabled flag, revision | Saved account preference; no usage history |
| `product_usage_totals` | UTC day, allowlisted metric, sum (plus DB primary key) | 396 days, approximately 13 months |
| `product_usage_receipts` | Random report UUID and expiration date | Scheduled expiry 36 days from the report day |
| `product_usage_activity` | HMAC subject (`PRODUCT_USAGE_SUBJECT_KEY`), UTC day, surfaces, worked flag, sign-up day, staff flag, expiry | 10 days (TTL); deleted on opt-out and `/api/analytics/delete`; written only while sharing is on and the key is set |

No individual report body or arrival timestamp is stored. Receipt insertion and increments share a
Mongo transaction so ambiguous retries cannot count twice. Saving a preference advances its revision;
an old queued report is refused even after an off/on cycle. The client checks the choice before each
upload, polls at most once a minute, and stops collecting if it cannot confirm the choice. The server
checks every ingestion without caching an enabled answer. Already admitted in-flight operations can
finish; previously combined totals cannot be selectively removed for one person. Turning off clears
the local queue on its next successful preference check. Queued counters older than 35 days are
discarded when the app next runs; no task content is read to reconstruct missing metrics.

The worker installs Mongo TTL indexes after schema setup. Expiry is asynchronous: the Mongo
[TTL background worker](https://www.mongodb.com/docs/manual/core/index-ttl/) may delete later than
the configured threshold. It also expires the eight legacy daily
history collections after 35 days. The old collector endpoint accepts no new rows, relay tracking
writes global event totals and, while sharing is on, the 10-day people marks, and the existing account deletion control covers the six former
presence collections as well as the old collector tables. These database lifetimes do not assert
anything about infrastructure access logs or backup retention; verify those separately before rollout.

Read daily totals with a read-only database identity, supplying `DATABASE_URL` through the environment:

```bash
cd backend
npm run usage:daily -- 14
```

The JSON includes daily headlines, the last complete week's return rate, and a `review` section
with launch and response friction, fixed feedback counts, matured first-launch and D1/D7 cohorts,
and equal seven-day descriptive comparisons. Each comparison includes its numerator, denominator,
coverage limits and evidence caveats. Today and immature cohorts are excluded from comparisons.
Low counts or incomplete windows are explicitly marked; no causal improvement is inferred.
Suggested investigations use synthetic reproductions and benchmarks, never user content. Missing client data is
unknown, and today is explicitly incomplete. Population is participating signed-in **computers**,
including staff and both service environments, not unique people or an external-user cohort.
Relay connection/turn totals from old clients stay separate from new client counters. Background
windows can count as active, and human/automated work is combined. First measured work is not signup
activation; a turn ending is not task success. The report deliberately makes no signup-to-value
activation claim. Weekly return compares locally counted consecutive-week working computers with
the preceding complete week's working computers; opt-outs, reinstallations, preference changes,
offline gaps and client upgrades affect coverage. Do not compare this estimate directly with the
legacy account-cohort retention percentage or an industry benchmark.

Ship the backend and its worker together, verify the unique and TTL indexes using synthetic reports,
then ship the CLI and settings surfaces with a visible release note explaining the default and switch.
The worker installs measurement keys explicitly even when the general Prisma schema push declines
an unrelated change. It transactionally combines duplicate day/metric totals from a deployment race
before creating their unique index; this bounded repair touches only aggregate counters and preserves
their sum. A missing key or failed repair stops worker startup rather than claiming readiness.
The daily decision workflow and release note are in [the measurement guide](../docs/product-measurement.md).
Mixed-version coverage remains explicit until clients update. The existing `usage:report` command
below reads the bounded **historical** tables; its current-day counts cease when new history writes stop.

### Client country (Cloudflare)

Production DNS is proxied through Cloudflare, so every request and WebSocket upgrade arrives with a
`CF-IPCountry` header. `src/lib/clientGeo.ts` is the only reader; it feeds:

- `users.lastCountryCode` / `lastCountryAt` — from the owner's own control-plane calls
  (`middlewares/authMiddleware.ts`), rate-floored to one write per user per hour unless the country
  changes. This is the "where is the user" answer.
- `machines.countryCode` — the computer's country on its last `/api/adapter-ws` connect.
- Legacy `machine_daily_presence.countryCode` / `user_daily_device_presence.countryCode` — same header on the
  daily presence rows. `user_daily_presence` deliberately has none: it is keyed by
  (user, machine, day) and its socket is the daemon's, so the machine's country is the one on
  `machine_daily_presence` for that `machineId`.

Off Cloudflare (local dev, direct origin hits) the header is absent and nothing is written; a value
is only ever set, never cleared.

Historical architecture notes still live in `autonomous-code/docs`.

## Product usage report

`npm run usage:report` reads the existing relay presence and turn counters and prints an
aggregate JSON report. It covers observed app users, owners doing agent work, surfaces,
complete UTC day/week/month windows, weekly return, exact-day return after first observed
work, seven-day signup activation, and workload concentration. It also shows collection
coverage and reconciles machine and agent turn counters, which must never be added together.

Use a database account with **read-only** privileges. In Bash, from `backend/`:

```bash
read -r -s -p 'Read-only MongoDB URL: ' READ_ONLY_DATABASE_URL
export READ_ONLY_DATABASE_URL
mkdir -p ../.harness/usage
npm run usage:report -- --days 30 --out ../.harness/usage/report.json
unset READ_ONLY_DATABASE_URL
```

The command deliberately requires `READ_ONLY_DATABASE_URL`, does not load `.env`, and does
not import server startup, migrations, or the application database singleton. It issues
read-only aggregates with a 15-second server limit, bounded connection timeouts, and a
100,000-row result ceiling; exceeding the ceiling fails instead of returning partial figures.
It exports no emails, account IDs, machine IDs, agent IDs, hostnames, or credentials. Keep
production reports under ignored `.harness/usage/`, not in source control. Output files use
mode `0600` and are never overwritten.

Options:

- `--as-of YYYY-MM-DD`: exclusive UTC cutoff, default today; the current partial day is excluded.
- `--days N`: reported daily range, 1–365 days. The loader reads at least 90 days for historical
  context; `range.historyFrom` records the exact boundary.
- `--exclude-email-domain example.com`: repeatable, case-insensitive exact account-domain filter.
  Exclusions apply before all metrics and denominators. This is an account-domain segment,
  not a verified employee/customer classification; unmatched historical owners stay in the report
  and are counted under `observedUsersWithoutAccountRow`.

Interpretation limits are part of the output. App presence can mean an idle window, connected
computers can run without an open app, and turns include automation. Surface user counts overlap.
P2P offers measure attempts, not confirmed sessions or all remote usage. A cohort's first
observed turn is not necessarily its first-ever use. Retention excludes the initial observation
day and only includes accounts old enough for the requested return day; signup activation also
requires a full seven-day follow-up and signup after the observation boundary.

Coverage describes earliest/latest stored rows across all accounts, including accounts removed
by a segment filter; it does not certify uninterrupted collection. A missing row means no observed
activity, not proven inactivity. In particular, do not compare new surface instrumentation with
older desktop history as if both had equal coverage. The collector-based account dashboard
(`src/lib/analyticsQuery.ts`) is separate: stale collector rows cannot establish current engine
mix, completion rate, runtime, or token cost.


The expanded measurement contract adds fixed app-flow and feature-use counts, D28 and calendar-month
installation returns, and voluntary task outcomes. Native signed-out setup is a separate explicit
session opt-in at `POST /api/product-usage/setup`; it rejects credentials and arbitrary fields and
has a process-wide admission budget without storing IP addresses. Web app signed-out setup reporting
is disabled. Anonymous Hub totals, shared links' (`/s/:id`) included, arrive at `POST /api/product-usage/hub`, forwarded by the website's
server without cookies or auth; the route accepts only the Hub vocabulary (`src/lib/hubMetricsContract.ts`)
and has its own admission budget.
Daily reports keep these populations separate, show unmatched outcomes and measurement loss, and
compare only mature periods. See [measurement definitions and runtime bounds](../docs/product-measurement.md).
Deploy this additive allowlist before releasing the new clients. This change does not add identity
markers or make installation counts comparable to people-based DAU or retention benchmarks.

<!-- CI reuse demo (#1107): unrelated base move, never merged to main. -->
