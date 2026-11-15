# Core routes package: notes to finish from

Package: the feature routes and the product usage code still in the daemon core's process (audit
docs/design/2026-11-12-core-audit.md section 2: "Feature routes in the two doors", "The product usage vocabulary",
"Smaller"). Follow the plan's rules and lessons (../2026-11-15-core-plan.md). One PR at a time, each on a branch of its
own (core-routes-1 and -2 are step 1's, core-routes-3 step 2's: start step 3 on core-routes-4), worktrees at
.claude/worktrees/<branch> from a fresh origin/main.

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

### The cost (tools-free micro-benchmark on this Mac, the link's JSON counted)
- A measured request (session_search, answered): 3.1 µs of the core's CPU and 5 frames to the gateway before; 2.0 µs
  and 2 frames after. A frame the report does not measure (terminal input): 43 ns before, 8 ns after.

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

## Step 2, done (#4321, branch core-routes-3): the account's routes and the usage report's names, to the gateway

The core's files and lines: 544 / 92,925 before (main at 20534f8822), 542 / 92,562 after (tools/coreCount.mjs). Out of
the core's process: lib/appProductUsageReport.ts, lib/productUsageSignals.ts, lib/storeProxy.ts (deleted). In:
core/usageOutcomes.ts.

### The adapter, extended (core/serviceRoutes.ts, `ServiceHttpRoute` in core/api.ts)
- `methods`: the methods a route takes; another goes on to the door's own routes and its 404, as before.
- `writes`: the methods that need `x-adapter-local: 1`; without it the door answers its own 403 `{error:'FORBIDDEN'}`
  before the service is asked (hookServer.ts passes `localOk` to `onServiceRoute`).
- `headers`: on every answer of the route, the door's 403 and `unanswered` too (the report's
  `x-harness-usage-vocabulary`, `APP_USAGE_VOCABULARY` in core/api.ts). `answerHeaders`: the ones a service's answer may
  set (`answer.headers`, one printable line of at most 128 characters each); the report's `retry-after`.
- `maxBodyBytes`: the most of a body the door reads for the route (the report's 8 KiB, as before); the door's own
  256 KiB bound when absent. The body is read only once a route took the request and let it in (`DoorRequest.readBody`).
- The door asks `onServiceRoute` (one helper, `serviceRoute` in hookServer.ts, for the device branch too) for every path
  its own routes did not take, just before its 404, and only with the local credential: an open path (a hook's) never
  reaches a service.

### Where the routes went: `gateway_http` (gateway/accountRoutes.ts)
- GET /api/desk, POST /api/desk/ops, GET /api/agent-messages, PATCH /api/agent-messages/tabs/:id, GET|PATCH /api/auth/me,
  POST /api/auth/qr/(lookup|approve|deny), POST /api/product-usage/(feedback|report), GET|POST /api/product-usage/settings,
  PATCH|DELETE /api/machines/:id, /api/store/* (`STORE_PATH_RE` moved there). Each keeps its own bad-JSON words; a
  backend call that throws is the old 502 PROXY_FAILED (the report's 502 USAGE_UNAVAILABLE); what threw in the door's
  own code (a machine id that does not decode, a rename body of `null`) is the old 500 `{error:'INTERNAL'}`.
- Unanswered (gateway down, slow, failing): 503 `{error:'GATEWAY_UNAVAILABLE'}`, as gatewayLink answered. Wait 25 s.
- `gatewayHttp` (accountRoutes.ts) dispatches: `/api/autonomous-device/*` to the device handler, the rest only for a
  local owner that is no guest (403 `{error:'FORBIDDEN'}` otherwise: a remote client may send `gateway_http` too).
- The Store's routes went to the gateway, not the viewers: the Store's process has no way to the backend, and one would
  be a backend allowlist for the Store in the core (rule 7); the gateway holds the account's HTTP already.

### Stay in the core, said why
- GET /api/machines: signed out its answer is the guest list without starting the gateway (gatewayWake's design), and
  while the gateway is away the core's own copy (gatewayLink `machines`, kept for models' labels anyway).
- GET /api/harness-shares: signed out its empty list, without starting the gateway, as above.
- POST /api/auth/handoff -> step 3: its door is the private socket only, and `gateway_http` also comes over the local
  WebSocket on loopback TCP, which would reach it from TCP. Step 3 needs a door kind the WebSocket path honours too.

### The usage report's names (core/usageOutcomes.ts -> gateway/usageEvents.ts)
- The core sends `GatewayPort.usage(event)`: one `request` event as a measured request comes (its type, local/tool/
  role, and the facts its counters read: creationId, engine, startedBy, userAction, usageSurface, usageIntent, agentId,
  each bounded), one `answer` per reply (error, state, agent, ok, reason, held, raw and bounded; `first` for the one its
  counters count; elapsed on the core's clock), and `observed` for hn's `product_observe`. `usageLaunch` is gone.
- Told only when it counts: a durable create's status and cancel (polls) send no `request` event and nothing at all
  without a durable id; a later reply is told only for the three launch requests, whose later replies say what became
  of a launch. `MEASURED_REQUESTS` (core) is held equal to the reductions' own list by gateway/usageEvents.spec.ts.
- The gateway runs the same reductions, unchanged (lib/productUsageSignals.ts), and keeps nothing between a request and
  its answer. A failed count is said in the gateway's log, at most once a minute. gateway/usageEvents.spec.ts holds the old path and the new side by side: the same names in the same order,
  the same launch signals, and the same report totals at the backend. The backendSocket specs' exact counter names pass
  unchanged through the real gateway.
- Left in the core's process: lib/productUsageContract.ts and lib/productHealthContract.ts, only for the two allowlists
  of what a service may count (core/agentQueries.ts via lib/hachiMetrics.ts, and core/agentBrowserLink.ts, package 2's
  file). They leave when those checks do: the core passes the counting service's name and the gateway checks it.

### Answers that differ (said in the PR)
- A Store write (PUT, DELETE) without the local header to a path the Store refuses: 403 now, 400 BAD_PATH before (the
  door asks the header before the service reads the path). Every other answer is byte for byte (e2e/accountRoutes).

### Verified
- e2e: accountRoutes (its fault test red on main in both modes, green after; goldens green before and after),
  productUsage, deviceRoutes. Unit: core/serviceRoutes.spec.ts (its new cases red on main's adapter),
  core/usageOutcomes.spec.ts, gateway/accountRoutes.spec.ts, gateway/usageEvents.spec.ts; the backendSocket specs'
  exact counter names pass unchanged through the real gateway.
- The vocabulary revision stays in the core's route table, on purpose: the door's own answers (its 403, and the answer
  while the gateway is away) must carry it, because the Desktop reads it off every answer and one without it would stop
  its newer names until the next report. appProductUsageReport.spec.ts reads it from core/api.ts beside the names.

## Step 3: pairing and keys, voice, the relay to other machines
- /api/auth/handoff from step 2 (above: a socket-only door).
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
