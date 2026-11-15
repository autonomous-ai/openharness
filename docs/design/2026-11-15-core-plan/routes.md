# Core routes package: notes to finish from

Package: the feature routes and the product usage code still in the daemon core's process (audit
docs/design/2026-11-12-core-audit.md section 2: "Feature routes in the two doors", "The product usage vocabulary",
"Smaller"). Follow the plan's rules and lessons (../2026-11-15-core-plan.md). One PR at a time, each on a branch of its
own (core-routes-1 and -2 are step 1's, core-routes-3 step 2's, core-routes-4 step 3's: start step 4 on core-routes-5),
worktrees at .claude/worktrees/<branch> from a fresh origin/main.

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

## Step 3, draft (#4324, branch core-routes-4): the keys' routes and the phone's code to the gateway, ⌘K's frames to the devices

### Design
- Growth: no new persistent records. Pending requests retain the existing service-link bounds; inline deadlines release
  their timers on an answer or a failure. Request bodies retain the door's 256 KiB bound and WebSocket frame limit.
- Concurrency: the gateway remains the sole key-state writer. This changes transport, not the key store's locks.
  Window replies remain correlated by request id and never block the connection's terminal-input chain.
- Read cost: one request and answer per command, with no new scan or polling. A frame type has one map lookup.
- Scale: the routing tables are fixed by the build; ten times the traffic adds requests, not retained per-agent state.
  Service deadlines, unavailable replies and request latency expose saturation first.
- Compatibility: existing clients retain their paths, methods, result frames and byte-for-byte answers, except the
  explicitly listed differences below. No backend contract changes. The master starts core and services from one build;
  the socket provenance field is internal to that build, never supplied by a client payload.
- Migration and rollback: no disk migration or backend rollout is needed; reverting restores the old route owners.
- Audience: the local door still checks socket/credential, loopback, Host, Origin and the local-write header before
  routing. The gateway separately refuses remote/guest callers and grants a phone code only for socket provenance.
- Identity: commands use this daemon owner's existing gateway identity. No account fallback or agent launch changes.
- Failure: unavailable, slow or failed services get the route's named fallback; router exceptions are logged. A service
  failure never stops the core. No new retries or replay of key writes.
- Platforms: macOS/Linux sockets and Windows pipes keep the same public contract. macOS validation is local; Linux CI
  and native Windows acceptance must be recorded separately.

The core's files and lines: 542 / 92,562 before (main at 0b15482b55), 542 / 92,283 after (tools/coreCount.mjs).

### The adapter, extended (core/serviceRoutes.ts, core/api.ts)
- A door kind: `ServiceHttpRoute.door: 'socket'`. Over the TCP port the door answers its 403 `{error:'FORBIDDEN'}` before
  the service is asked; over the daemon's own socket (Windows: its pipe, with the token's proof) it asks with
  `asker.door: 'socket'` (`Asker.door`, set only by the door, for every route asked over the socket). No client of the
  local WebSocket is ever given it (backendSocket `askerFor`), so a `gateway_http` sent over the WebSocket for a socket's
  route is refused by the service: `gatewayHttp` passes `asker.door === 'socket'` to the handoff's own route, which reads
  the path once and refuses without it (gateway/accountRoutes.ts). hookServer.ts passes `trustedLocal` as `socket`; a
  service's own process keeps `door` when it rebuilds the asker (services/process.ts; the e2e found it dropped).
- The adapter never rejects: a router that throws while asked is the route's own answer, logged (`could not be asked`).
- Like step 2's, the keys' routes are ordinary requests a client of the local WebSocket may send, at the door's trust: no
  browser can open the WebSocket (it refuses any Origin), and over TCP it takes the local credential from this account. The
  local header, the door's guard against a browser page, is not asked there.
- The WebSocket half: `SERVICE_WS_FRAMES` (`ServiceWsFrame`: `frame`, `type`, `result?`, `waitMs`, `unanswered?`) and
  `serviceRoutes.frame(frame, asker)`: the frame is asked of its service as `{ frame, payload }` (the window's payload as it
  came, nested: serviceLinks puts its own `requestId` on the request), off the connection's ordered chain, and the answer
  goes back as `{ type: result, payload: { requestId, ...answer } }` (the window's requestId, `''` when it sent none, first,
  as before). An answer with a string `error` (down, failing, slow) is the frame's `unanswered`. No `result`: told, nothing
  goes back. localWsServer.ts's `onServiceFrame` takes it wherever the connection's terminals are (relayed ones too);
  main.ts asks with `backend.askerFor(connId, true)`.
- Convention: one `<service>_ws` request a service (`devices_ws` in `DEVICES_REQUESTS`), which dispatches by `frame`.

### Where the routes went
- Gateway, `gateway_http` -> gateway/keyRoutes.ts (`keyRoutes(KeyOps)`): POST /api/pair (wait PAIR_WAIT_MS, now in api.ts),
  GET /api/pairs, POST /api/revoke, /api/revoke-all, /api/remote-password/(set|clear), GET /api/remote-password/status,
  POST /api/link/trust-peer, GET /api/group, POST /api/group/(sync|remove), GET /api/devices, POST
  /api/devices/(remove|rebaseline|dismiss), GET /api/devices/history (a read that needs the local header: `writes: ['GET']`).
  Each validates in the door's words; a pairing's or a password's own failure is the old 500 `{error: message}`, any other
  throw the old 500 INTERNAL, logged (never a throw: SERVICE_FAILED would count against the gateway). Unanswered: 503
  `{error:'GATEWAY_UNAVAILABLE'}`, as gatewayLink's `http` answered; wait 30 s (serviceLinks' default) and 120 s for a pairing.
  The 16 `GatewayOps` members, their `GATEWAY_CALLS`, gatewayLink's ops, gatewayProcess's handlers and hookServer's
  handlers are deleted; gateway/start.ts holds them as `keyOps`.
- POST /api/auth/handoff -> gateway/accountRoutes.ts (`forward('/api/auth/handoff', {})`), `door: 'socket'`, wait 25 s.
- Devices, `devices_ws` (services/devices.ts `windowFrame`): `route_task` -> `route_result` (an empty task is the
  'empty task' answer), `route_send` -> `route_send_result` (`nothing to send` without both), `voice_route_reply` (told; a
  state other than taken/sent/cancelled, or no voiceId, is dropped). A window's only (`asker.local && owner`, else
  `LOCAL_ONLY`). Unanswered: the old DEVICES_UNAVAILABLE answers. `DevicesPort.voiceReply`, its devicesLink event and
  devicesProcess handler, `VoiceRouteReply`, and localWsServer's `onRouteTask`/`onRouteSend`/`onVoiceRouteReply` are deleted.

### Stay in the core, said why
- `DevicesPort.routeTask`/`routeSend`: lib/ownerCommands.ts (⌘K from the owner's app over the relay, `route_task_result`,
  its BUSY bound and INVALID_REQUEST) still asks them; step 4 moves ownerCommands to a devices request and deletes both.
- The relay to other machines (localWsServer's `machine_select` for another machine, `shareId`, `forceReconnect`,
  `withLocalClient`): transport, the window's own WebSocket handed to the gateway's `WindowRelay` frame by frame. It can only
  leave if the gateway held the window's socket itself, a door of a component's own: package 14's question.
- The desk frames (app_panes, app_unread, app_swarms, agent_seen, app_focus, dial_settings, app_*_result): they feed state
  the core holds and tells the devices again each time they connect (devicesLink `state`); no better owner yet.

### Answers that differ (said in the PR)
- A client of the local WebSocket sending `gateway_http` for /api/auth/handoff: 403 FORBIDDEN now, 404 not found before
  (no such gateway route). Both refuse; the backend is never asked (e2e/keyRoutes).
- Inline mode: the key routes are now bounded (30 s, 120 s for a pairing) by the adapter's timer; before, the door waited
  for the gateway's call however long. Out of process: a key command that throws is the door's old 500 (inline's), not 503.
- ⌘K's frames with a router that throws: the devices' DEVICES_UNAVAILABLE answer (as the guarded port gave in practice), not
  localWsServer's old `reason: <the error>`, which nothing reached.

### Verified
- e2e/keyRoutes.e2e.ts: the goldens (every key route, the code over the socket, ⌘K's frames) green on main and after, in
  both modes; the faults (`gateway.gateway_http`, `devices.devices_ws`) and the WebSocket's refusal red on main, green after.
- Unit: core/serviceRoutes.spec.ts (socket door, frames), gateway/keyRoutes.spec.ts, gateway/accountRoutes.spec.ts,
  services/devices.spec.ts, hookServer.spec.ts, localWsServer.spec.ts, core/api.spec.ts.

### Continuation (2026-11-15)
- Worktree `/tmp/harness-core-routes-continue`, branch `codex/core-routes-continue`, from `core-routes-4` at
  `18523b4710`. Integrated main `aad8dcd535` in `e7f7509005`. The API spec keeps both sets of imports; the shared plan
  table keeps main's version for the coordinating root to update.
- Review found the adapter left its inline deadline armed when a router threw. The timeout is now cleared on that
  path, with a regression checking HTTP and WebSocket answers and zero pending timers.
- The preceding Verified section records the original step's evidence, not fresh validation of this continuation.
  No tests or compilers ran here: after the performance marker appeared, root held the shared validation lock for
  Browser #4320. Red/green for the added regression, typecheck, the affected unit/architecture tests, `test:core`, and
  isolated route e2e remain pending. The regression against `e7f7509005` should demonstrate the retained timer first.
- `scripts/local-checks.py --list` selects `cli-core` only. Run its exact-head receipt after the final source commit.
  The public route contracts also need `keyRoutes`, `accountRoutes`, `deviceRoutes`, `gatewayProcess`, `devicesProcess`
  and `devicesOnDemand` e2e. Full Linux unit CI, independent review and native Windows acceptance remain unverified.
- Current core count: main `aad8dcd535` has 539 files / 92,691 lines; this continuation has 539 / 92,414. No new file
  enters the core. The original PR's frame microbenchmark reports 5.9 → 8.0 ns; it is not evidence of no regression.
  Root must resolve or accept that measured increase explicitly before calling the hot-path requirement satisfied.
- PR #4324 is still a draft with no CI runs. Root alone updates its body (currently containing `E2E_RESULTS`,
  `CORE_AFTER` and `RECEIPTS` placeholders), pushes, marks ready, merges and publishes. Step 4 remains out of scope.

## Step 4: smaller items
Phone sign-in relay (lib/loopbackGet.ts, core/terminals/browser.ts, 127 lines -> gateway), guest rules and a guest's
engine install (core/agents/guestCreate.ts, lib/windows/guestEngine.ts -> edge shared machines), cloud agents' cards
(core/agents/cloud.ts -> cloud), the gateway's pass-throughs (core/gatewayLink.ts lane/tabKey/vault), `harness remote`
(lib/terminalHandoff.ts, backendSocket remote_terminal_handoff), lib/ownerCommands.ts (route_task/route_send slot).
