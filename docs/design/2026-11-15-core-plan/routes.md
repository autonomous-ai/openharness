# Core routes package: notes to finish from

Package: the feature routes and the product usage code still in the daemon core's process (audit
docs/design/2026-11-12-core-audit.md section 2: "Feature routes in the two doors", "The product usage vocabulary",
"Smaller"). Follow the plan's rules and lessons (../2026-11-15-core-plan.md). One PR at a time, each on a branch of its
own (core-routes-1 and -2 are step 1's: start step 2 on core-routes-3), worktrees at .claude/worktrees/<branch> from a
fresh origin/main.

Worktree setup: run `npm ci` in the worktree's `cli/`. The main checkout's `cli/node_modules` is incomplete (no
@sindresorhus/slugify, yaml or pngjs), and the e2e daemon and bundle fail on a link to it.
e2e: `TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/<file>` (sources live: edit nothing while it runs).
zsh: in scripts write `${ref}:cli/...`, not `$ref:cli/...` (`:c` is a zsh modifier).

## Step 1, done (#4316, branch core-routes-2): the adapter and the Wi-Fi device's routes

The core's files and lines: 543 / 93,160 before (main at 5c3703b042), 543 / 93,002 after (tools/coreCount.mjs).

### The adapter (generic, in the core): what steps 2 to 4 build on
- `core/serviceRoutes.ts` `createServiceRoutes({ routes, linked, hosted })`: after the door's checks (hookServer.ts
  keeps loopback, the private socket, the credential, Host and Origin, the bearer), a path matching a
  `ServiceHttpRoute` (`core/api.ts` `SERVICE_HTTP_ROUTES`, first match wins) is asked of its service as the request
  `type`, payload `{ method, target (req.url, query too), body? (raw text, non-GET only, the door's 256 KiB bound) }`,
  asker `{ local: true, owner: true }`. `{ status (int 200-599), body (object) }` is written as given; anything else
  (down, late, SERVICE_FAILED, malformed) answers the route's `unanswered`, a malformed one logged.
- The wait: `linked` (serviceLinks) bounds it itself, from when the request is sent, after an on-demand start. Only
  `hosted` (serviceHost, inline) gets the adapter's own timer. A timer from arrival cut short a request that woke its
  process (review: a cold devices process answered `harness device receipt` 503 at 5 s).
- Convention: one `<service>_http` request a service (`GATEWAY_REQUESTS`, `WIFI_REQUESTS`, `machine_addons_http` in
  `MACHINE_ADDON_REQUESTS`), which dispatches by path itself. `serviceLinks.route(..., waitMs)` takes the route's wait.
- They are ordinary requests, so a local WebSocket client may send them too: same trust as the door (both ask the
  private socket, or loopback with no Origin and the local credential, from this account). Each handler refuses a
  remote or guest asker with the door's 403 (`deviceRoutes` in lib/autonomous-device/localHttp.ts).

### Where the Wi-Fi device's routes went
- `lib/deviceManagementHttp.ts` became `lib/autonomous-device/localHttp.ts`, out of the core's process: each service
  gives the members it answers (`Partial<AutonomousDeviceManagement>`; a missing one is 404). An error with a code maps
  as before; one without is thrown on, and the route answers `unanswered`.
- Gateway (`gateway/start.ts` `requests.gateway_http`): discover, pair/start, pair/status, list, status, revoke. Discover
  and pair wait for the Wi-Fi service through `host.wifiServing()` (in its process the `wifi_serving` query,
  core/gatewayLink.ts). `GatewayOps.wifi`, `GATEWAY_CALLS.wifi`, `GatewayRefusal` deleted.
- Wi-Fi service (`services/wifi.ts`, `wifi_http`): receipt and the add-ons. `WifiPort.receipt` and `addon`, their types
  and `WIFI_WAIT_MS` deleted.
- Machine add-ons (`machine_addons_http`): their own service's hello, publish, decision, proposals. `machine_addon` no
  longer takes those ops (only the core's old hop sent them), and refuses, as the routes do, while the machine's id is
  not known, in one place (`MachineAddons`), in both modes.

### Answers that differ (said in the PR)
- `status` during a devices-process restart: before `connected:false`, `sessions:0` (the core's `up`); now the
  gateway's live direct sessions, whose frames the core holds through the restart.
- Inline mode only: addon/propose with the Wi-Fi service off answers 504 OUTCOME_UNKNOWN, as out of process always
  did (before: 503 not running). The window before the inline Wi-Fi service starts answers each route's down words,
  not "is starting". And while this machine's id is not known (signed out), the machine add-ons refuse with 503 "not
  known yet", as out of process always did (before: they served a machine named '').
- No shim for an old core against a new service: the master starts the services from the same cli.js as the core.

### Verified
- e2e: deviceRoutes (red on main in both modes, green after), wifiDevice, robustness, gatewayProcess, devicesOnDemand.
- `npm run test:core` through `scripts/local-checks.py --run` (the PR's receipt).

## Step 2: account, desk and Store proxies, usage reports, usage vocabulary -> gateway (+ viewers)
- hookServer.ts routes: GET /api/machines, PATCH|DELETE /api/machines/:id, GET /api/harness-shares, GET /api/desk,
  POST /api/desk/ops, GET /api/agent-messages, PATCH /api/agent-messages/tabs/:id, GET|PATCH /api/auth/me,
  POST /api/auth/qr/(lookup|approve|deny), POST /api/product-usage/(report|feedback), GET|POST
  /api/product-usage/settings, /api/store/* (lib/storeProxy.ts). Agent settings + experimental settings STAY (decided
  13 Nov, core/experiments.ts). /api/auth/handoff -> step 3 or here (door: trustedLocal && x-adapter-local).
- All go to `gateway_http` (the gateway already has accountHttp.backend). Needs from the adapter: a door kind per route
  in the table (read: credential only; write: also `x-adapter-local: 1` -> 403 FORBIDDEN; socket-only), headers on
  the answer (`Retry-After` from retryAfterMs; `X-Harness-App-Usage-Vocabulary` set on EVERY answer of the report
  route, the door's 403 too: put it in the route's declared headers). Each route's own bad-JSON body differs
  (`{error:'bad json'}`, `{error:'BAD_REQUEST'}`, `{error:{code:'BAD_REQUEST',...}}`): the service parses, so keep
  each byte for byte. `proxied()` 502 PROXY_FAILED and gatewayLink's `{status:503, body:{error:'GATEWAY_UNAVAILABLE'}}`
  are the unanswered answers to keep. onSharedHarnesses signed-out answer, machines' stale fallback (gatewayLink
  `machines`) and `/api/status` (stays in the core) need care. Write goldens first, as in step 1 (e2e/deviceRoutes.e2e.ts).
- Usage vocabulary: lib/productUsageContract.ts, productUsageSignals.ts, productHealthContract.ts,
  appProductUsageReport.ts. The socket maps request outcomes to counter names (backendSocket.ts ~1041-1050); move the
  mapping to the gateway: the core sends one raw outcome (`usageCounter`/`usageLaunch` on GatewayPort). Prove the
  backend gets the same names and totals: a test on what the gateway sends (gateway/productUsage.spec.ts style) and
  e2e/productUsage.e2e.ts. hachiMetrics.ts and agentBrowserLink.ts use the allowlists too (files.tsv).

## Step 3: pairing and keys, voice, the relay to other machines
- hookServer.ts: /api/pair, /api/pairs, /api/revoke, /api/revoke-all, /api/remote-password/(set|clear|status),
  /api/link/trust-peer, /api/group, /api/group/(sync|remove), /api/devices, /api/devices/(remove|rebaseline|history|
  dismiss): each a GatewayOps call today (gatewayLink `http(...)`, unanswered `{status:503, body:{error:
  'GATEWAY_UNAVAILABLE'}}`, PAIR_WAIT_MS for pair). Move their validation into `gateway_http`; drop the GatewayOps
  members and GATEWAY_CALLS the core no longer calls.
- localWsServer.ts: route_task / route_send / voice_route_reply (to the devices; answered off the ordered chain) need
  the WS half of the adapter: a frame type -> a service request, the reply as the result frame. The relay to other
  machines (machine_select for another machine, shareId) stays transport through the gateway's WindowRelay: check what
  can leave. Desk frames (app_panes, app_unread, app_swarms, agent_seen, app_focus, dial_settings, app_*_result) feed
  core-held state the devices are told again on reconnect (devicesLink `state`): keep that state unless a better owner.

## Step 4: smaller items
Phone sign-in relay (lib/loopbackGet.ts, core/terminals/browser.ts, 127 lines -> gateway), guest rules and a guest's
engine install (core/agents/guestCreate.ts, lib/windows/guestEngine.ts -> edge shared machines), cloud agents' cards
(core/agents/cloud.ts -> cloud), the gateway's pass-throughs (core/gatewayLink.ts lane/tabKey/vault), `harness remote`
(lib/terminalHandoff.ts, backendSocket remote_terminal_handoff), lib/ownerCommands.ts (route_task/route_send slot).
