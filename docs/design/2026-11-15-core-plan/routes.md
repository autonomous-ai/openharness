# Core routes package: notes to finish from

Package: the feature routes and the product usage code still in the daemon core's process (audit
docs/design/2026-11-12-core-audit.md section 2: "Feature routes in the two doors", "The product usage vocabulary",
"Smaller"). Follow the plan's rules and lessons (../2026-11-15-core-plan.md). One PR at a time, branches core-routes-1, -2, ...,
worktrees at .claude/worktrees/<branch> from a fresh origin/main.

Worktree setup: run `npm ci` in the worktree's `cli/`. The main checkout's `cli/node_modules` is incomplete (no
@sindresorhus/slugify, yaml or pngjs), and the e2e daemon and bundle fail on a link to it.
e2e: `TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/<file>` (sources live: edit nothing while it runs).
zsh: in scripts write `${ref}:cli/...`, not `$ref:cli/...` (`:c` is a zsh modifier).

## PR 1 (branch core-routes-1, pushed, no PR yet): the adapter + the Wi-Fi device's routes

Commits: 41021812e1 golden e2e only (recorded on main, green there), 55bde80b21 WIP: the move. Base d50957ac3c;
origin/main has moved (b5070936bb), no overlap with these files: rebase is clean so far.

### The adapter (generic, in the core)
- `cli/src/core/serviceRoutes.ts` (`createServiceRoutes({ routes, routers })`): after the door's checks
  (hookServer.ts keeps loopback, private socket, credential, Host/Origin, bearer), a path matching a
  `ServiceHttpRoute` is asked of its service as request `type` with payload `{ method, target (req.url, with query),
  body? (raw text, non-GET only, read with the door's 256 KiB bound) }`, asker `{ local: true, owner: true }`, through
  `[serviceLinks, serviceHost]` (out of process, then in process). Reply `{ status (int 200-599), body (object) }` is
  written as given; anything else (down, timeout, SERVICE_FAILED, malformed) answers the route's `unanswered`. Own
  timer bound too (an in-process handler is bounded by nothing else). Malformed answers are logged.
- `core/api.ts`: `ServiceHttpRoute` type, `SERVICE_HTTP_ROUTES` table (first match wins), `GATEWAY_REQUESTS =
  ['gateway_http']`, `WIFI_REQUESTS = ['wifi_http']`, `MACHINE_ADDON_REQUESTS += 'machine_addons_http'`. Convention:
  one `<service>_http` request a service, which dispatches by path itself.
- `core/serviceLinks.ts` `route(..., waitMs?)`: the route's wait overrides the type's.
- `core/main.ts`: `serviceRoutes` built after serviceLinks; `onServiceRoute` on the hook server; `requestsOf` gets
  gateway and wifi; inline wifi starts with `WIFI_REQUESTS`; inline gateway's `requests` served via
  `serviceHost.serve('gateway', ...)`; `wifiServing: () => wifiCore.serving(WIFI_START_MS)` given to the gateway link
  and the inline gateway; `devicePartsBuilt` gone.
- HTTP types are ordinary service requests, so a WS client could send them too: every handler refuses a non-local or
  non-owner or guest asker with the door's 403 (`deviceRoutes` in localHttp.ts). Same trust as the door.

### Where the Wi-Fi device's routes went
- `lib/deviceManagementHttp.ts` -> `lib/autonomous-device/localHttp.ts` (out of the core's process). New: members are
  optional per service (`Partial<AutonomousDeviceManagement>`, a missing one is 404); an error WITHOUT a string code is
  thrown on (the request fails, SERVICE_FAILED, the route's `unanswered`), with a code it maps as before (unknown code
  -> 500 INTERNAL_ERROR). `deviceRoutes(members)` is the `<service>_http` handler (asker check, JSON body parse ->
  400 "Invalid JSON body"). `deviceRefusal(code, message)`. deviceAddonRoutes/machineAddonRoutes deleted.
- Gateway (`gateway/start.ts` `requests.gateway_http`): discover, pair/start, pair/status, list, status, revoke, and
  any unknown path (its 404/405). Discover/pair wait for the Wi-Fi service first through `host.wifiServing()` (process:
  `service_query wifi_serving`, answered in `core/gatewayLink.ts answer`). Gateway errors without a code are coded
  INTERNAL (500, as before). `status.sessions` is now the gateway's own count (`RelayGateway.directDeviceSessions`:
  deviceClients on a direct sink, same identity, device role). `GatewayOps.wifi`, `GATEWAY_CALLS.wifi`,
  `GatewayRefusal` deleted.
- Wi-Fi service (`services/wifi.ts` `startWifi` now returns `{ wifi_http }`): receipt, addon/state|propose|proposal.
  `WifiPort.receipt/addon`, `WifiReceipt`, `WifiAddon*`, `WIFI_ADDON_OPS`, `wifiLink` call+`WIFI_WAIT_MS` deleted.
  wifiProcess answers `wifi_http` after `heardSoFar`; not built -> `{ error: 'SERVICE_UNAVAILABLE' }` (route words).
- Machine add-ons (`lib/autonomous-device/machineAddons.ts requests().machine_addons_http`): checks first, then
  "This machine's id is not known yet" 503 while the id is unknown (machineAddonsProcess waits `known()` first).
- `core/wifi.ts`: `directSessions` gone. `serving()` stays (the gateway asks it).
- Core files: architecture.coreFiles.txt drops lib/deviceManagementHttp.ts, adds core/serviceRoutes.ts. Measured
  at the base: 543 files / 92,451 lines before, 543 / 92,291 after (tools/coreCount.mjs on each tree).

### Decisions and the few answers that differ (say them in the PR)
- Pairing routes stay answerable with the devices' process down (gateway), as before; robustness.e2e relies on it.
- `status` counts during a devices-process restart: before 0 (the core's `up`), now the live sessions (gateway).
- Inline mode only, Wi-Fi service off: addon/propose answers 504 OUTCOME_UNKNOWN (before 503 not running).
- Startup window before the inline wifi starts: 503 "not running" instead of "is starting".
- No shims for an old core against a new service: core and services always run one build (master re-exec on update
  since 2026-10-05, services restarted in the gap). Clients' paths/answers unchanged.

### Verified
- tsc clean; touched specs green: core (wifi, wifiLink, gatewayLink, serviceLinks, serviceRoutes 100%, api),
  services (wifi, wifiProcess, machineAddonsProcess, inline), gateway/, lib/autonomous-device/, hookServer,
  architecture.spec, leanEntry.spec. Touched core/services files at 100% coverage.
- e2e/deviceRoutes.e2e.ts 6/6 green after the move (4 goldens recorded on main + 2 new: per-service request faults
  `gateway.gateway_http,wifi.wifi_http,machineAddons.machine_addons_http` answer the route's words at once, both modes).
- Red on main (a worktree at b5070936bb with the new e2e and coreFiles list copied in):
  architecture.spec fails "lib/deviceManagementHttp.ts, imported by core/main.ts"; the fault e2e fails
  "GET /api/autonomous-device/list: expected 200 {"devices":[]} to equal 503 ...not reachable..." in both modes.

### Left for PR 1, in order
1. `git fetch && git rebase origin/main` in the worktree; tsc.
2. e2e that cover the move, one at a time: wifiDevice.e2e.ts (was started, stopped unfinished), robustness.e2e.ts
   ("state files that are garbage" exercises discover's wifiServing wait), gatewayProcess.e2e.ts, devicesOnDemand.e2e.ts,
   deviceRoutes.e2e.ts again.
3. Gates once: `npm run test:core` (100% per file), `python3 scripts/local-checks.py --list <paths>` and what it names.
4. Audit doc: add a "Left since" row (date, the change, core files/lines after) only; mark the routes row partly done.
5. `/code-review high` on the diff; fix findings.
6. Squash the WIP commit into a real message (keep the golden commit first), push, `python3 scripts/local-checks.py --run
   --base origin/main` from the clean head, draft PR with: what/why, red-then-green output above, core files/lines,
   receipts (in the body before the push CI judges), platforms (macOS run; Linux by CI). Then `gh pr ready`.

## PR 2 (core-routes-2): account, desk and Store proxies, usage reports, usage vocabulary -> gateway (+ viewers)
- hookServer.ts routes: GET /api/machines, PATCH|DELETE /api/machines/:id, GET /api/harness-shares, GET /api/desk,
  POST /api/desk/ops, GET /api/agent-messages, PATCH /api/agent-messages/tabs/:id, GET|PATCH /api/auth/me,
  POST /api/auth/qr/(lookup|approve|deny), POST /api/product-usage/(report|feedback), GET|POST
  /api/product-usage/settings, /api/store/* (lib/storeProxy.ts). Agent settings + experimental settings STAY (decided
  13 Nov, core/experiments.ts). /api/auth/handoff -> PR 3 or here (door: trustedLocal && x-adapter-local).
- All go to `gateway_http` (the gateway already has accountHttp.backend). Needs from the adapter: a door kind per route
  in the table (read: credential only; write: also `x-adapter-local: 1` -> 403 FORBIDDEN; socket-only), headers on
  the answer (`Retry-After` from retryAfterMs; `X-Harness-App-Usage-Vocabulary` set on EVERY answer of the report
  route, the door's 403 too: put it in the route's declared headers). Each route's own bad-JSON body differs
  (`{error:'bad json'}`, `{error:'BAD_REQUEST'}`, `{error:{code:'BAD_REQUEST',...}}`): the service parses, so keep
  each byte for byte. `proxied()` 502 PROXY_FAILED and gatewayLink's `{status:503, body:{error:'GATEWAY_UNAVAILABLE'}}`
  are the unanswered answers to keep. onSharedHarnesses signed-out answer, machines' stale fallback (gatewayLink
  `machines`) and `/api/status` (stays in the core) need care. Write goldens first, as in PR 1.
- Usage vocabulary: lib/productUsageContract.ts, productUsageSignals.ts, productHealthContract.ts,
  appProductUsageReport.ts. The socket maps request outcomes to counter names (backendSocket.ts ~1041-1050); move the
  mapping to the gateway: the core sends one raw outcome (`usageCounter`/`usageLaunch` on GatewayPort). Prove the
  backend gets the same names and totals: a test on what the gateway sends (gateway/productUsage.spec.ts style) and
  e2e/productUsage.e2e.ts. hachiMetrics.ts and agentBrowserLink.ts use the allowlists too (files.tsv).

## PR 3 (core-routes-3): pairing and keys, voice, the relay to other machines
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

## PR 4 (core-routes-4): smaller items
Phone sign-in relay (lib/loopbackGet.ts, core/terminals/browser.ts, 127 lines -> gateway), guest rules and a guest's
engine install (core/agents/guestCreate.ts, lib/windows/guestEngine.ts -> edge shared machines), cloud agents' cards
(core/agents/cloud.ts -> cloud), the gateway's pass-throughs (core/gatewayLink.ts lane/tabKey/vault), `harness remote`
(lib/terminalHandoff.ts, backendSocket remote_terminal_handoff), lib/ownerCommands.ts (route_task/route_send slot).
