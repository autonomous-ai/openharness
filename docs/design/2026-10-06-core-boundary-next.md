# The core boundary, next

> **Status, 2026-10-07.** Steps 1 to 11 have landed, and so have moves the plan did not list: the recaps,
> the viewers' remote serving and the updater. The core's closure went from 114,622 lines in 488 files
> (walked from `cli.ts`) to **71,244 lines in 332 files** on `main` at b4027cbd1. That is measured by
> the import walk in `cli/src/architecture.spec.ts`. The original estimate was 61,000.
>
> **Policy update, 2026-10-07.** Source line counts are informational. The TUI merge added no loaded
> module but exceeded the old cap, showing that the cap did not measure architectural coupling or
> runtime cost. The tests now report sizes and enforce dependency boundaries, explicit exceptions,
> service failure isolation and coverage. Performance uses measured workloads and a recorded baseline.
> This replaces the line caps for the core's import closure, `runForeground` and `backendSocket.ts`.
>
> | Step | Landed as | Note |
> |---|---|---|
> | 1 The core's own entry, and its size test | #871 | |
> | 2 Dead code | #845, #919 | #919 deleted the web dashboard (`webui.ts`): nothing opened it |
> | 3 Slow work off the event loop | #826 | |
> | 4 Requests into services | #851, #931, #937 | The change-agent handoff runs in the edge host (#931). The command bar is an on-demand experiment (#937). A routed request knows its connection, and its service hears when that connection closes (#927) |
> | 5 Several services per process, the edge host | #875 | The edge host now runs workspaces, usage, the monitor, the project readers, the handoff and the recaps |
> | 6 The Store into the viewers' process | #879, #922 | The viewer forwarder and the rendered viewer surfaces followed the viewers (#922) |
> | 7 Models in its own process | #896 | Found: routed requests were cut off at 30 s (`LONG_ANSWERS`) |
> | 8 The experimental host, move only | #921, #924, #932, #933, #937 | One on-demand process per experiment: the orchestrator, Tab collaboration, Share, the command bar. Found: a cold experiment got its first request before it was welcomed (#940) |
> | 9 Devices in their own process | #918, #928, #929, #946 | One devices process, with a guard per device, and the Wi-Fi device beside the dials. It starts only once there is a device (protocol 4, #946). A dial's port is streamed over its own descriptor (#953) |
> | 10 The relay: the gateway process | #899, #905, #911 | |
> | 11 The unsupervised handoff | #895, #925 | `harness start -f` runs the master. The updater runs in a process the master runs; the core never downloads a build (#925) |
> | Recaps (not in the plan) | #923 | The plan kept the commander mirror in the core. The recaps now run in the edge host, and the core only tells them each turn's lifecycle |
>
> The processes now: the master, the core, search, the viewers with the Store, the edge host, the gateway,
> models, and the updater (the master's, for the installed copy). Five more start on demand: the devices,
> the orchestrator, the teams with Tab collaboration, Share and the command bar. Each process and what it
> hosts is in [../../cli/src/services/AGENTS.md](../../cli/src/services/AGENTS.md).
>
> **Boundary follow-through, 2026-10-07.** Account/backend HTTP and `machines.json` move to the
> gateway; the core reads reported state with an account-bound stale fallback. Bundled harness setup
> moves to the Store; one shared lean asset file avoids duplicating bundled bytes. Shell request policy
> and receipts move to the edge host; live terminal identity and literal-argv launch remain in the core.
> The device HTTP adapter and transcript reader are shared helpers under `lib/`, not device/search
> implementations. `CORE_MAY_REACH` is now empty. The lean core bundle has landed.
>
> What is left:
> - **The engines' own code still loads in the core.** The engine-interface refactor
>   ([2026-10-05-engine-interface.md](2026-10-05-engine-interface.md)) has resumed with Claude Code and Codex first, a few engines per batch.
> - **The core grew where every session needs it.** #950 added a gate for tmux before 3.7, whose server
>   crashes when a terminal attaches during a notification (`lib/tmuxControlGate.ts`).

A plan, not a change. It takes stock of everything that still runs in the core's process and is not
session handling, decides where each piece goes, and orders the moves so that each lands green on its
own. The design it continues is [2026-10-03-harnessd.md](2026-10-03-harnessd.md); what changed
since the last release is in [2026-10-04-harnessd-before-after.md](2026-10-04-harnessd-before-after.md).
Paths are under `cli/src/`; line numbers are from `main` at 3ac2aea57.

The owner's direction, verbatim: "the goal is to build a stable, safe, reliable daemon core.
everything else lives outside of the daemon as subsystems/services. stable at core. extendible at the
edges via subsystems." The core owns sessions only: agents, terminals, transcripts, turns, input and
questions ([../../cli/AGENTS.md](../../cli/AGENTS.md)).

## In short

- **The core's process loads 111,892 lines in 472 files today.** Files that are session handling and
  its plumbing come to about 66,700 of them, and about 6,000 inside those (the CLI's commands in
  `cli.ts`, the relay half of the socket, feature wiring) leave too. The rest is a dozen other areas,
  the biggest being the devices (9,800), the relay and E2EE (7,350), the models (6,400) and the CLI's
  own commands (6,200, there only because `cli.ts` is both the CLI and the daemon).
- **Target: service implementations stay outside the core's import closure.** A test walks the imports
  and rejects forbidden dependencies, with explicit temporary exceptions. The original estimate of
  61,000 lines, about 45% smaller, describes the planned extractions; it is not an acceptance limit.
- **Seven service processes at the end,** two of them on demand: relay, devices, models, search,
  viewers with the Store, an edge host for the light services, and an experimental host that starts
  only when an experimental feature is used. At about 50 MiB each after the lean work, that is
  about 250 MiB always on and 350 MiB at most.
- **First, five steps that move nothing risky:** give the core an entry of its own and the test that
  measures it; delete what is dead; take the slow work off the core's event loop; move the request
  handlers that only answer the apps out of the socket's switch; and let one process host several light
  services. The relay, the largest and most coupled move, comes last.
- **Defects found on the way,** some to fix before anything moves: a 15 s synchronous canary and a
  120 s synchronous `tar` on the core's event loop, the orchestrator built on every daemon at its first
  turn end, device code unguarded on the per-transcript-line path, and a reconcile pass with no
  deadline (see [Found on the way](#found-on-the-way)).

## How it was measured

The core is what `harness __run` loads: `cli.ts`, whose `runForeground` (lines 1576–4152, 2,577
lines) is the composition root, and everything it imports. The count follows every static and
dynamic `import` under `cli/src`, leaves out `import type` (types cost nothing at run time) and test
files, and puts each file in one area by what it is for. The walk is the one the proposed test makes
([The target, and its test](#the-target-and-its-test)).

Three caveats keep the numbers honest:

- **`cli.ts` is also the CLI.** About 3,160 of its 5,739 lines are commands (`harness login`, `grid
  setup`, `link`, …) that `__run` loads and never calls. Their imports, with the master's and the
  services' own entries, add 6,214 lines in 37 files that the core's process never runs.
- **A file can be two things.** `backendSocket.ts` (2,353) is the local client hub and request
  dispatch, which are core, and the upstream relay link, about 1,000 lines, which is not.
  `hookServer.ts` (938) binds sessions in about 430 lines and serves other routes in about 340.
  Such files are counted where most of them belong, and split in the text.
- **One bundle.** A service in its own process loads the same bundle today. Leaving the core's
  closure is what makes a separate entry per process possible; until then, moving code out changes
  what the core runs, not what it loads.

The four inventories behind this plan read every call site; their evidence is cited inline as
`file:line`.

## The core today, by area

| Area | Lines | Files | Where it goes |
| --- | ---: | ---: | --- |
| Sessions: agents, terminals, transcripts, turns, input, questions, and their plumbing | 66,700 | 262 | stays (less about 6,000 lines inside mixed files) |
| Relay and E2EE (backend link, pairing, trust group, device log, P2P terminals, remote relay pool) | 7,350 | 21 | relay process |
| Devices (USB dial, Wi-Fi device, firmware push, voice router) | 9,800 | 40 | devices process |
| Models (Grid, local models, API connections, Codex profiles, the managed Grid pin) | 6,400 | 26 | models process |
| The CLI's own commands, and the master's and services' entries | 6,200 | 37 | leaves the core's entry |
| Session search, the index half | 2,200 | 7 | search process (done) |
| Light features (account usage, machine monitor, command bar, "Change agent" handoff) | 3,000 | 15 | edge host |
| Teams (Tab collaboration) and the orchestrator | 2,200 | 16 | experimental host |
| Sharing (Share) | 780 | 7 | experimental host |
| Workspaces, git context and previews | 1,750 | 13 | edge host |
| Fleet (the machine list, the lane to other machines, the router) | 1,800 | 4 | devices process, with its main caller |
| Store installs | 1,440 | 11 | viewers process |
| Viewers and verdicts | 1,290 | 8 | viewers process (done) |
| Updaters (the CLI's, hn's) | 660 | 4 | stay for now; later one updater service under the master |
| The web dashboard (`webui.ts`) | 270 | 1 | delete, if unused (below) |

"Sessions" holds more than the six areas' own folders, by decision: the engines' adapters and
normalizers (10,241), the launch builders (Grid's environment and argv, the DSH workspace and snapshot,
API launches: about 3,840), the runtime profiles (each agent's model and effort, 3,090), the commander
mirror (each turn's recap and asks, 1,022), discovery and restore (2,860), the hook routes and hook
install, and the readers of other engines' sessions that adoption uses (3,635, half of
`lib/sessionSearch`). Each is argued below.

## Inventory

For each area: what the core calls it for, what it needs from the core, what a person notices if it
dies, and the decision. "Hot" means per transcript line, per turn event, per keystroke or terminal
byte, or per frame sent to the apps; everything else is per request, per timer or at start.

### Relay and E2EE — its own process (the "gateway")

- **Lines.** `lib/e2ee/*` (4,647, less `deviceDisplay.ts`, a CLI command), `lib/remoteRelay.ts` (1,249),
  `lib/terminalP2p.ts` (806), `lib/stunSelect.ts` (338), `lib/wsLiveness.ts`, `lib/remoteViewerProxy.ts`
  (285), `lib/viewerForwarder.ts`, `lib/ownerCommands.ts`, and about 1,000 lines of `backendSocket.ts`:
  the constructor, connect and backoff (827–969), the outbound queue (992–1163, 1223–1241,
  1363–1428), P2P routing (1243–1319), reply sealing (1430–1482) and the gates and backend control
  frames in `dispatchDown` (1504–1712).
- **The core calls it, hot and synchronous.** Every event the funnel sends is sealed in pure JS on
  the core's thread (`funnel.ts:128` → `send` → `e2ee.wrapUp`, `backendSocket.ts:1001`), as is every
  terminal frame of a remote connection (`:1062–1101`, `:1369`) and every remote request and reply.
  Occasional: `relayPool.acquire` on `machine_select` (`localWsServer.ts:428–450`), pairing over the
  hook server's HTTP (`cli.ts:2688–2758`), the trust group and the device log every 10 minutes
  (`cli.ts:3000–3012`), and `connect()` at start when signed in (`cli.ts:3710`).
- **It needs from the core.** None of it goes through `CoreApi`: it uses `BackendSocket`'s members
  directly: the local clients and `sendLocal` for device-key notices (`cli.ts:2964–2986`),
  `terminalStreams.closeConnection` on link loss, and three callbacks (`onRevoked`, `onMachineMeta`,
  `onCommanderJoin`). Each connection's session role decides `Asker.owner`.
- **If it dies.** The phone, the web, other desktops, Share observers and the Wi-Fi device lose this
  machine; local windows and agents should not. Today it runs inside the core, so a throw in
  `wrapUp` aborts the funnel's batch for everyone (the funnel's `outside()` guard does not cover
  `clients.send`), and werift's pure-JS WebRTC stack and the crypto run on the core's event loop.
  Signed out, the daemon never dials (`cli.ts:3709`), yet seals and queues every event up to 2,000 and
  then drops them (`backendSocket.ts:124`, `:1223`).
- **Decision: its own process,** the gateway. It holds the upstream connection, the E2EE manager and
  its stores, pairing, the trust group and device log, P2P with STUN, the remote relay pool with the
  viewer proxy, and the Share relay transport. The core speaks plaintext to it over the local socket,
  and each remote client becomes a connection the gateway registers with the asker stamped. What the
  move must handle:
  - one more local hop on the remote hot paths (events, terminal bytes), and none for local windows;
  - the synchronous reads the core makes (commander counts, each connection's role and label, the
    Grid name, the machine's name) answered from what the gateway reports, the viewers' pattern;
  - the backend's control frames (`machine_revoked`, `machine_meta`, desk, machines and device-key
    changes, a client gone) becoming typed events the core accepts only on the master-tokened link;
  - the local socket handing a window's connection to another machine over to the gateway
    (`localWsServer.ts:428`).
- **Account and cloud proxies go with it, or to the edge host.** `proxyBackend` (`cli.ts:2496–2533`,
  20 callers), the machine-list cache (`cli.ts:2589–2635`) and Grid-name minting are async, already
  time-limited and need nothing from the core but the session token.
- **What looks like cloud sync and is not.** The commander mirror (`lib/commander.ts`, each turn's
  recap, asks and busy state, which heartbeats, cancel, fork and `CoreApi.turns` read; hot, every event
  batch, `funnel.ts:168`), `sessionSync.ts` (agent frames), `machineNames.ts`, `computerIdentity.ts`
  and `agentNotifications.ts` are turn and agent state. They stay. Only `commanderReplay.ts` and
  `deviceRecentTrim.ts`, which shape what goes up the link, leave with the gateway.

### Devices — its own process

- **Lines.** `cable/*` (5,561), `device/machineList.ts` (294), `lib/autonomous-device/*` less the pane
  writer lock (1,960), `lib/harnessDevices.ts`, `lib/deviceRecap.ts`, and the voice router
  (`lib/voiceRouter.ts` 492 with `lib/oneshot.ts` 1,034 and `lib/disposableOneShotPool.ts` 318,
  which nothing else uses). `devices/client.ts` and `lib/flash.ts` are CLI commands.
- **The core calls it, hot.** Every transcript line, synchronously and unguarded
  (`core/transcripts/ingest.ts:58–61`, `attach.ts:161`); every pane write (`core/input.ts:62, 120`);
  every card for the Wi-Fi device, teed to the dial, heartbeats included
  (`backendSocket.ts:1134` → `cli.ts:4084–4114`); presence reads on every mirror card
  (`cli.ts:1999–2003`). In the background, an `ioreg` spawn every 2 s with nothing plugged in; with a
  dial, an agent sync every second and a pane capture every 3 s. The voice router is fed on every
  bind and forget, keeps a warm engine process while a device is connected
  (`setVoiceRouterDeviceConnected`, `cli.ts:3481`) and answers `voice_route` on the asking
  connection's ordered chain for up to about 12 s (`backendSocket.ts:2002`).
- **It needs from the core.** The dial already reaches the fleet's router through `ports.fleet` and
  the core through `CoreApi`, but also bypasses both: the registry (`cableHost.ts:22`), an
  `AuthSessionManager` of its own (`cableHost.ts:95–120`, a credential) and `backend.sendLocal` for
  the `dial_*` frames. The Wi-Fi device uses closures (`cli.ts:4027–4057`), the core's E2EE manager
  and the hook server's pairing routes.
- **If it dies.** The dial and the Wi-Fi device stop; nothing else should. Runtime faults are
  contained (serial reopen, the `devices()` guard), but a corrupt state file makes the Wi-Fi device's
  constructors throw, unguarded (`direct.ts:37–40`, `cli.ts:4027, 4060`), and that puts the whole core
  into safe mode. A native crash in the serial code costs every session.
- **Decision: its own process,** the singleton owner of the serial ports (`O_EXLOCK` already makes the
  port single-owner, `serial.ts:166`). This is D1's remainder and D2 in the harnessd design, sized there
  at about fifteen calls from the core and twenty-five back. The pane writer lock
  (`lib/autonomous-device/input.ts`, 310) and the card text (`deviceErrors.ts`) are the core's and
  move into `core/input.ts` first. The fleet's router moves into this process too: its synchronous
  readers (`machineOf`, `knows`, `describe`, `cableHost.ts:414–578`) are the dial's, and ⌘K's calls
  are already asynchronous. The Wi-Fi device stays in the core's process behind `serviceHost` until
  the gateway exists, since it rides the E2EE sessions, then joins this process. The voice router comes
  here because its workers are engine processes and its callers are the dial and the fleet.

### Models — its own process

- **Lines.** The Grid service code (`gridAttach`, `gridCredentials`, `gridDerive`, `gridEnsure`,
  `gridExec`, `gridFleetRpc`, `gridHandoff`, `gridInstall`, `gridMcpUrl`, `gridModels` 793,
  `gridModelsPayload`, `gridPicture`, `gridPresence`, `gridReader`, `gridTarget`, `gridWake`: 3,333),
  `localModels.ts` (1,199), `appModels`, `newAgentModel`, the API connections (`apiConnections`,
  `apiModels`, `apiInstructions`), the Codex profiles (519) and `runtimeInstall.ts` (351, the managed
  Grid pin), with `services/models.ts` (316).
- **What stays in the core, and why.** The launch builders (`gridLaunch` 1,121, `gridConfigDir`,
  `gridWebMcp`, `harnessWebTools`, `launchOverrides`, `subscriptionModel`), the process probes
  (`gridAssignment`, `gatewayRuntime`) and `core/agents/retarget.ts`. Create, restart, restore and
  retarget build an engine's command line from them, and restart and restore need no service at all:
  the registry row keeps `gridLaunch` (the credential included), `gridWebSearch`,
  `subscriptionModel`, `codexHome` and the DSH snapshot. The runtime profiles stay too
  (`runtimeProfile` 1,786, `runtimeProfileController` 1,304): they read the model and effort from
  every transcript line (`ingest.ts:62`) and pane footer, and type `/model` into the pane.
- **The core calls it.** Hot: the keystroke prewarm (`cli.ts:2022–2028`, guarded and debounced) and
  `gridAnnotation()` on every agent frame, read straight off the module's singleton
  (`agentFrame.ts:232`, unguarded). Per discovery pass: the cached probes. Per create: the model target
  (`launches.ts:243, 304`), `ensureGrid` for the Model Manager (`create.ts:156–162`). Per request, in
  the socket's own switch, against rule 1 of `cli/AGENTS.md`: `api_connections`, `codex_profiles_*`,
  `grid_fleet_*` and `agent_retarget`'s target resolution. Every 10 minutes: the Grid pin.
- **It needs from the core.** `core.account` and two client pushes, through `CoreApi` already. But
  its state is a module singleton the socket, `agentFrame.ts` and `launches.ts` read in process,
  bypassing `ports.models`.
- **If it dies.** Model pictures and the Model Manager go; agents keep working on what they were
  launched with. A throw is contained by the service host; a hang is not, and there is one:
  `ensureManagedGrid` runs `tar` (up to 120 s) and `grid --version` (up to 60 s) synchronously on the
  core's event loop (`runtimeInstall.ts:52–54, 135`) whenever the pin moves, freezing every terminal
  for that long.
- **Decision: its own process,** after every direct read goes through the port: the annotation pushed
  by the service and cached in the core, the target resolution asynchronous with a `FAIL` fallback,
  the prewarm sent only when the cached annotation says the machine is asleep (so no keystroke crosses
  a process), and the Model Manager's run requests given a connection-closed notice. The API and
  Codex-profile requests move into it as declared requests. The core keeps reading `apis` and
  `codexHome` from their files and the row at relaunch, so a restart never waits on models.

### Session search — done, and the half that is not search

`services/search.ts` runs in its own process with `HARNESSD_SERVICES` (default on the
`services-default` branch). Only its index half (about 2,200 lines) is search. The readers of other
engines' stored sessions (`lib/sessionSearch/external.ts` and `externals/*`, 3,635 lines) are used by
the core itself: adoption (`cli.ts:1817`, `core/agents/adopt.ts:41–106`), create
(`stopSessionOwner`, `create.ts:38`) and repair (`sessionRepair.ts:29`). **Decision:** the readers
become a library beside the engines' adapters, which both the core and search import; nothing else
moves. In the core's process today, search's `node:sqlite` queries run on the core's thread, and a
native crash there costs every session: the reason to make its own process the default.

### Store and DSH — the Store to the viewers' process; the launch path stays

- **Three parts.** The launch path (`installed`, `manifest`, `launch`, `runtime`, `adapters`,
  `compatibility`, `materialize`, `probe`, `shell`: 1,024) is how create, relaunch and fork prepare a
  harness agent's workspace and snapshot; it stays, as a file contract the core reads. The Store
  (`catalog`, `install`, `update`, `updates`, `registry`, `wire`, `service`, `lock`, `builtins`: 1,501,
  with `services/store.ts` and `storeProxy.ts`) installs and updates harnesses. The viewers
  (`viewer`, `viewerLedger`, `verdict`, `artifacts`: 741) already run in their own process.
- **Decision.** The Store joins the viewers' process: it has no port, its installs take minutes, and
  installs are already locked across processes (`dsh/lock.ts`). It needs a service-to-core kind for
  the install status push, `ensureBundledCoreHarnesses` moved into its start, and the Wi-Fi device's
  bypass (`autonomous-device/storeRuntime.ts:12`) routed through it. The viewer forwarder and the
  interactive viewers (headless Chrome) follow the viewers once relay frames can reach them.

### Teams (Tab collaboration) and the orchestrator — the experimental host

- **Lines.** `teams/*` (1,705 less the CLI commands), the team half of `backendSocket.ts` (345–430,
  1728–1753), `cli.ts:3683–3695`, `core/teamsLink.ts`, `services/teamsProcess.ts`; `orchestrator/*`
  (746) and its construction inside the socket (`backendSocket.ts:435–577`).
- **The core calls teams, hot.** The prompt scopes see every keystroke for every agent, whether or not
  Tab collaboration is on (`terminalStreamManager.ts:651, 726`), every message written
  (`sessionInput.ts:448, 514`) and every turn start (`funnel.ts:134`); they already run in their own
  process with `HARNESSD_SERVICES=teams`. But the rest of teams (`TeamService`, the mailbox, the
  channel directory) runs in the core and polls the backend's tab channels every 15 s on every daemon
  (`channels.ts:42–50`).
- **The core calls the orchestrator, hot, and it should not exist yet.** `send()` feeds it every frame
  sent to the apps, `text_delta` included (`backendSocket.ts:994–996`), "only once open". But
  `isSubagentSession` asks its `roleOf` at every turn end (`core/turns/recaps.ts:63–68`), and `roleOf`
  constructs the service (`backendSocket.ts:432–435`): a `mkdirSync`, a directory read and a
  synchronous parse of every saved run, on every daemon, after its first turn. If that load throws,
  it throws out of `send()` and out of the funnel, and the apps stop receiving frames.
- **Decision: move only, to one experimental host.** Teams' service, mailbox and channels join the
  prompt scopes; the orchestrator gets a port (`roleOf` answered from a cache the service reports,
  never by building it; frames filtered in the core to director agents and four event types). Both
  need one new `CoreApi` member they share with the device: send a turn with a delivery id, hear its
  delivery, cancel it. `serviceRouter` runs after the socket's early `team`, `orchestrator` and `pair`
  branches (`backendSocket.ts:1728, 1775, 1786, 1835`): each move deletes its early branch.

### Sharing (Share) — the experimental host

`sharing/*` (776) is built on every daemon (`cli.ts:2539–2560`), with a 1 s authorization timer and a
30 s publish, though Share is off by default in the app. It reads panes through a second
`TerminalStreamManager` of its own (`owner.ts:39–46`), seals every byte for every observer, and spawns
headless Chrome for shared viewers (`viewer.ts:38–60`). **Decision, move only:** first behind
`serviceHost`, then in the experimental host, once `CoreApi` has a read-only terminal subscription,
with observers arriving through the gateway. The Chrome capture belongs with the viewers. Its timers
then run only while the experimental host does.

### Workspaces, git context and previews — the edge host

The service already runs in its own process (`HARNESSD_SERVICES=workspaces`). Five requests still live
in the socket: `git_pull_request`, `git_project_info`, `project_preview` (detached), `fs_list_dir`
(synchronous `readdirSync`, `backendSocket.ts:2188`) and `agent_read_file` (awaited on the request
chain, `:2220`). They move into the service, which needs a `CoreApi` lookup by agent or session id
and the work ledger. The git context on every agent frame (`agentFrame.ts:186–197`: the project, the
branch history, up to eight git lookups, cached) stays in the core, or becomes a reported cache.
`projectFolder`, `openFiles`, `projectFiles` and `worktreeDeletion` are launch and purge code: core.

### Light features — the edge host

- **Account usage** (`usage_read`, `accountUsage.ts`): per request, detached, reads the vendor
  Keychain through `security` (`accountUsage.ts:161–175`). A service with no port; first decide
  whether reading the Keychain is "holding a credential".
- **The machine monitor** (`harnessResources`, `machineHardware`, `machineResources`,
  `macosProcessGpu`, `harnessTelemetry`: 716): `machine_resources` and the `monitor` part of
  `agents_list` spawn `ps`, `nvidia-smi` and `ioreg`, and parse up to 8 MB of `ioreg` output on the
  core's thread at every Monitor poll (`macosProcessGpu.ts:97`). A service, with a port and an empty
  fallback for the list's merge.
- **The command bar** (`commandBar`, `commandBarHttp`: 287) answers `/api/command-bar/*` on the hook
  server and `command_bar` on the socket; it reads its own OpenRouter key. A service with no port; the
  HTTP route forwards to it.
- **"Change agent" handoff** (`agentHandoff` 952, `handoffDiscovery`, `core/agents/handoff.ts`): writes
  a handoff file for another engine; detached, bounded to 5 s. A service for `agent_handoff_prepare`,
  with `CoreApi` additions (stopped agents, recaps by session).
- **Token usage, titles and output stats stay:** they are built from transcripts and read on every
  agent frame.

### The hook server — the session routes stay, the rest leaves

- **Session routes stay** (about 430 lines): `session-start` (SessionStart and UserPromptSubmit),
  `turn-stop`, `turn-start`, `tool-start`, `session-end`. They bind sessions, answer inside the
  engine's 500 ms budget and touch the registry. `lib/hooks.ts` (1,193, which installs the engines'
  hooks and holds their plugin sources) and `core/engines/hooks.ts` stay: create installs Codex's
  hooks synchronously (`create.ts:231`).
- **The server stays as transport.** It is the core's control port: the local WebSocket for the
  desktop and hn is attached to it (`cli.ts:3051`), as are `/api/status` and the safe-mode status.
- **The other routes leave** (about 340 lines, with their bodies at `cli.ts:2658–2856`): the command
  bar, the backend proxies (machines, `auth/me`, the auth handoff, shares, the desk, experimental
  settings, the Store), and pairing and the trust group. They move through one adapter in the hook
  server that turns an HTTP route into a service request, keeping the URLs the CLI and the desktop
  use. Pairing waits for the E2EE manager to leave `BackendSocket`.

### The local WebSocket server (the desktop and hn) — stays, less about 400 lines

`localWsServer.ts` (781), `terminalStreamManager.ts` (1,374), `tmuxStream.ts` (821) and
`terminalBinary.ts` (317) stream panes to the desktop and hn: every keystroke goes from the socket to
tmux, and every output byte is compressed on the core's thread (`terminalStreamManager.ts:192`). That
is terminals, and stays. About 400 lines of `localWsServer.ts` are not: the dial and app callbacks,
⌘K and the voice route, the remote relay pool and the Share relay. They become events on ports.
`lib/ownerCommands.ts` mixes the command bar with the fleet's `route_task` and `route_send` and is a
`BackendSocket` slot, against rule 2: the command bar goes to the edge host, the routing to the fleet.
The retired `daemon_*` frames are refused there (`localWsServer.ts:19–21, 650–681`) and stay until no
app sends them.

### Discovery and reconcile — stays, with a deadline

`terminalAgentReconciler.ts`, `tmuxAgentDiscovery.ts`, `terminalAgentDiscovery.ts`,
`core/agents/discovery.ts`, `core/agents/adopt.ts`, `sessionRepair.ts`, `restoreAgents.ts` (2,860):
they decide which agents exist and are alive, which is session handling. Two things to fix in place:
a pass has no deadline (`reconcileOnce`), so a stuck one blocks every hook (each awaits
`triggerHint`, `core/engines/hooks.ts:117`) and holds a registry transaction open so nothing saves;
and about 285 lines of `tmuxAgentDiscovery.ts` (212–497) are reached only from tests.

### Updaters — stay for now; the unsupervised handoff goes

The CLI's self-update (`selfUpdate.ts`, 485) and hn's (`tui/update.ts`, `install.ts`) tick every
60 s. The CLI's runs its canary with `spawnSync`, up to 15 s, on the core's event loop
(`selfUpdate.ts:192`): terminal bytes, hooks and heartbeats stop meanwhile. Under the master a core
staging an update just exits 75 and the master does the rest (`supervisor.ts:147, 418`), so the
spawn, supervise and roll-back handoff in `runForeground` (about 180 lines) runs only unsupervised
(`harness start -f`, `HARNESS_NO_MASTER=1`). **Decision:** make the canary asynchronous now; make
`-f` run the master in the foreground, as launchd does, and delete the handoff; later, one updater
for the CLI and hn under the master's supervision, so that safe mode is "no core started" rather than
"a broken core runs its updater". The master's no-network rule means the updater is a service, not
the master.

### Companions and Coding memory — already out; the refusals stay until no app sends them

Since #684 they are a package (`companions/`) that nothing starts. What remains in the daemon is the
refusal of their requests: `pair` and `PLATE_REQUEST` (`backendSocket.ts:1786–1791`),
`daemon_plate_get` (`localWsServer.ts:650–658`), the `pair` frame types and `admitRelayedPairFrame`
in `lib/e2ee/applicationFrames.ts:23–42, 62, 100`, and `'builtin:pair'` in `isHiddenBuiltin`
(`dsh/builtins.ts:61`). The desktop still sends `pair` (verb `memory`) and `daemon_plate_get`, so the
refusals stay until it does not.

### The Devices tab — moves with the dial

`harness_devices_list` and `harness_device_settings` (`backendSocket.ts:2289–2299`, through
`lib/harnessDevices.ts`), the `dialStatus` push and the bundled Devices harness
(`ensureBundledDevices`, `cli.ts:1954`). Nothing hot. They go with whoever owns the cable; the bundled
install goes to the Store.

### The web dashboard — delete if unused

`webui.ts` (269) serves `GET /`. Its port is sent to the web (`e2ee/manager.ts:487`), but no app,
website or backend reads it. Confirm, then delete.

### What stays, and why

| In the core | Why it cannot leave |
| --- | --- |
| Registry, stopped agents, create, fork, restart, retarget, resume, stop, close, purge | The agent lifecycle is session handling |
| tmux backend, terminal streams to the desktop and hn (`terminalStreamManager`, `tmuxStream`, `terminalBinary`, `localWsServer`) | Every keystroke and output byte; a process hop would add latency to typing |
| Engine adapters and normalizers (10,241) | Transcripts |
| Attach, ingest, history, the watcher | Transcripts |
| Activity, funnel, heartbeats, cancel, recap excerpts, the commander mirror | Turns: each turn's last answer and asks, which heartbeats, cancel, fork and notifications read |
| Runtime profiles | The agent's model and effort, read from every transcript line and pane footer |
| Input and its pane writer lock, questions | Input and questions |
| Discovery, reconcile, restore after reboot | Decide which agents exist |
| The hook session routes and hook install | Bind sessions; create installs hooks |
| Launch builders: Grid environment and argv, DSH launch path, API launches, Codex homes | Restart and restore must work with every service down |
| The local socket, the request gate, `serviceHost`, `serviceLinks`, each service's link | Transport and the boundary itself |

## The target shape

| Process | Holds | Why its own | Started |
| --- | --- | --- | --- |
| **core** | Sessions, as above | Must never go down | always |
| **relay** (the gateway) | Backend link, E2EE, pairing, trust group, device log, P2P, remote relay pool, viewer proxy; account proxies | Network, crypto and WebRTC in pure JS; the attack surface | always (signed in) |
| **devices** | USB dial, Wi-Fi device, firmware push, voice router, the fleet's router and lane, Devices tab requests | Native serial code; one owner per port; spawns engine workers | on demand (below) |
| **models** | Grid, local models, API connections, Codex profiles, the Grid pin | Downloads, model servers, long installs | always |
| **search** | Session index | `node:sqlite`, memory | always (done) |
| **viewers** | Viewer servers, verdicts, Store installs; later headless Chrome | Spawns servers and Chrome; minutes-long installs | always (done) |
| **edge host** | Workspaces, account usage, machine monitor, command bar, handoff | Light, pure JS, request-only: isolated from the core, not from each other | always |
| **experimental host** | Teams and Tab collaboration, the orchestrator, Share, and Companions and Coding memory when they return | Experimental code never shares a process with stable code | on demand (below) |

**Grouping, and what isolation it keeps.** A process per risk, not per feature. Native crashes
(serial, `sqlite`), memory (the index, model downloads), child-process herds (viewer servers, Chrome,
engine workers) and the network each get their own process, because each is a way one feature can
take another down. The edge host's services are pure JavaScript answering requests: a fault in one
can cost the others in its host, never the core, and the master restarts the host. The experimental
host keeps experiments away from both. That needs one new capability, a process hosting several
services (`harness __service workspaces,usage,monitor,…`), which `services/process.ts` and
`harnessd/services.ts` grow in step 5.

**Memory.** About 50 MiB per process after the lean work (the harnessd design measured 40 MiB for an
idle Node and up to 125 MiB for one that loads today's whole bundle). Today, with the
`services-default` branch, the core runs four: search, viewers, workspaces and teams, about 200 MiB.
The target is five always on (relay, models, search, viewers, edge host: about 250 MiB) and two on
demand: devices (about 50 MiB more for someone with a dial or a Wi-Fi device) and the experimental
host (about 50 MiB more for someone using an experiment). Merging workspaces into the edge host and
teams into the experimental host is what keeps the always-on count at five.

**On demand.** The master starts a service only when it has work: the devices when a dial is plugged
in or a Wi-Fi device is paired, the experimental host when the account turns an experiment on or an
app sends one of its requests. Today the dial's USB watch is itself the devices' code (an `ioreg`
spawn every 2 s); the cheap watch would run in the edge host and ask the master to start the devices.
This is a decision for the owner (below); without it, both run always, at 350 MiB in all.

*Decided and done (6 October):* the devices are on demand. The cheap watch runs in the core
(core/devicesWake.ts: a listing of /dev every two seconds, no `ioreg`, no open), with a paired Wi-Fi
device, its session, a pairing and the Devices tab's and ⌘K's requests. Idle with no device, the
daemon's processes went from 660–669 to 592–594 MiB RSS.

## The order

Each step is one pull request that keeps every client working, with its end-to-end proof, and removes
the dependency exceptions it no longer needs. The first five move nothing risky.

1. **The core's own entry, and the test that measures it.** `runForeground` and the helpers only it
   uses move verbatim from `cli.ts` into `src/core/main.ts`; `cli.ts` keeps the commands and calls it
   for `__run`. The master's and services' entries leave the core's closure the same way. Then the
   import test (below) reports the new size, about 103,000 lines, and checks the list of
   today's exceptions to the edge-folder rule. No behaviour changes; the unit and e2e suites prove it.
   (Moving code into a service in the core's process, as step 4 does, changes no number: the closure
   shrinks only when a service runs in its own process and the core stops importing it, step 5 on.)
2. **Delete what is dead.** `tmuxAgentDiscovery.ts:212–497` and `adoptVerified` (reached only from
   tests), `readStartupProfile` (`runtimeProfile.ts:626`), the spec-only exports in `gatewayRuntime`,
   `gridAssignment`, `apiModels`, `subscriptionModel` and `dsh/*`, the herdr hints the hook server still
   accepts (`hookServer.ts:212`), the `voice_route` case if the backend's legacy `deviceWs.ts:1379` is
   its only sender (the gate already refuses it unsealed), `speaking` if nothing sends it, and the
   comments that describe deleted code. About 600 lines.
3. **Take slow work off the core's event loop.** Each is a defect in a stable core, fixed in place:
   the canary asynchronous (`selfUpdate.ts:192`); `ensureManagedGrid` asynchronous
   (`runtimeInstall.ts:54, 135`); `viewerLedger`'s `ps` asynchronous; the `ioreg` parse off the
   request path; `orchestratorRoleOf` answering "no role" without building the service; the device's
   `observeTranscript` and the runtime profiles' `ingest` guarded on the per-line path; the Wi-Fi
   device's constructors guarded; a deadline on each reconcile pass and on a hook's wait for one;
   signed out, no sealing and no queue. Each with a test that fails without it. Experimental features
   are left as they are (move only): their always-on timers leave with them in step 8.
4. **Requests out of the socket's switch, into services in the core's process.** `usage_read`,
   `machine_resources` and the list's monitor merge, the command bar (both doors), `agent_handoff_prepare`,
   `api_connections` and `codex_profiles_*` (into models), and the five workspace requests. Each is a
   declared request of its service (`services/AGENTS.md`), so the switch shrinks and nothing about
   processes changes. About 1,500 lines leave `backendSocket.ts` and `runForeground`.
5. **One process, several services.** The master starts `harness __service <a>,<b>` and
   `services/process.ts` hosts each on its own core link and token, with the heartbeat and memory
   budget per process. The in-process start paths move into `services/inline.ts`, loaded only with
   `HARNESSD_SERVICES=none`, so a service that runs in its own process by default (search and the
   viewers already) leaves the core's closure. Then the edge host: workspaces, usage, monitor, command
   bar and handoff, proven by `e2e/serviceProcesses.e2e.ts`'s kill, hang, leak and crash loop against
   the host.
6. **The Store into the viewers' process,** with the install-status push and the bundled installs.
7. **Models in its own process.** First every direct read of the `gridModels` singleton through the
   port (the annotation cache, the asynchronous target, the prewarm gated on "asleep", the push
   payloads), then `models` in `KNOWN_SERVICES`. Proven with the Model Manager and a create on a grid
   while models is killed: the create answers `GRID_UNAVAILABLE` and every running agent works on.
8. **The experimental host, move only.** Teams' service, mailbox and channels beside the prompt scopes;
   the orchestrator with its port; Share behind `serviceHost`, started when on. The shared `CoreApi`
   member for delivered turns lands first, in its own change. No feature changes; the teams and
   orchestrator e2e files pass as they are.
9. **Devices in their own process** (D1's remainder, then D2): the pane lock and card text into the
   core first; the card tee as a stream with questions replayed on connect; presence cached in the
   core; `clients.sendToWindow` in `CoreApi`; the fleet's router beside the dial; the voice router.
   Proven with the fake dial on a pseudo-terminal and the two-machine fleet from D0.
10. **The relay, in three steps.** R1: the upstream link out of `BackendSocket` behind an interface,
    and the E2EE manager out of it, still in process; sealing guarded. R2: the gateway process, with
    remote clients registered through it, the cached reads and the control-frame events. R3: the
    Wi-Fi device into the devices process over the gateway, Share's observers through it, and the
    fleet's lane signed and sealed through `core.account` and the gateway instead of the credential
    it holds today (`services/fleet.ts:39–62`). Proven with the fake backend and the two-machine
    fleet (`e2e/harness/fakeBackend.ts`, `e2e/fleet.e2e.ts`).
11. **The unsupervised handoff goes**, and with it about 180 lines of `runForeground`, once `-f`
    runs the master in the foreground.

The original source-size estimates after each step, roughly: 103,000 after step 1, 102,000 after steps 2
to 4, 93,000 after step 5, 92,000 after step 6, 85,000 after step 7, 82,000 after step 8, 71,000
after step 9, 62,000 after step 10, and 61,000 at the end.

## Experimental features: move only

Settings → Experimental lists the Focus-bar creature, the Share button and the Devices tab (account
experiments), Coding memory (local to the computer) and Tab collaboration. None of them is worked on
here: each moves with its code as it is, and its existing tests pass unchanged. Their timers that run
on every daemon today (Share's, the tab-channel poll) move with them; on demand, the experimental host
is what makes them cost nothing for someone who does not use an experiment.

| Experiment | In the daemon today | The move |
| --- | --- | --- |
| Focus-bar creature (Companions) | Refusals only: `pair`, `daemon_plate_get`, frame types in `applicationFrames.ts` | Nothing to move. When Companions returns, it is a service in the experimental host that declares `pair`, `pair_*` and `daemon_plate_get`, and the core deletes its refusals (`daemon_plate_get` is intercepted in `localWsServer.ts` before routing, so it needs routing too) |
| Coding memory | The `pair` refusal (verb `memory`) | As Companions; Memory never depends on Companions |
| Share | `sharing/*`, built on every daemon, with its timers | Behind `serviceHost`, then the experimental host as it is (step 8); observers through the gateway (step 10) |
| Tab collaboration (teams) | Prompt scopes (own process possible), team service, mailbox, channel poll, team branches in the socket | The rest of teams joins the prompt scopes in the experimental host (step 8); the early `team` branch in the socket goes |
| Devices tab | Two requests, the status push, the bundled harness | With the dial (step 9); the bundled install with the Store (step 6) |

Two things are not features and still need care: every keystroke goes to the prompt scopes whether or
not Tab collaboration is on, and the Wi-Fi device and the orchestrator share one delivery path with
teams. A pure move keeps the keystrokes flowing (batched across the process, never gated: gating is
a feature change) and lands the delivery member once for all three.

## The target, and its test

**The core owns sessions; feature implementations stay in services, reached through declared ports.**
`src/architecture.spec.ts` enforces those dependencies. Counts remain useful review information, but
adding a comment or a session-safety check cannot violate an architecture rule by changing a total.

- It walks the imports from `src/core/main.ts` (step 1) exactly as this plan's count did: every
  static and dynamic `import` under `src`, without `import type` or tests. That is the code the core's
  process runs. The one edge it does not follow is the dynamic import of `services/inline.ts`
  (step 5), which runs services in the core's process only with `HARNESSD_SERVICES=none`.
- It reports the closure's source lines and file count, plus the sizes of `runForeground` and
  `backendSocket.ts`, in the test output. These numbers have no pass/fail threshold and are not memory,
  CPU or latency measurements.
- It fails when the walk reaches an edge folder (`lib/e2ee`, `cable`, `device`, `lib/autonomous-device`,
  `sharing`, `teams`, `orchestrator`, the Grid service files, `lib/localModels.ts`, the Store and viewer
  parts of `dsh`, the index half of `lib/sessionSearch`, `services/*` implementations), except through
  an exception listed by file, each with the step that removes it. Like the services' exception list
  today, an exception no longer needed fails the test, so the list only shrinks.
- The core reaches a service only through its link and its manifest (name, request types, port
  fallbacks), never its implementation. `HARNESSD_SERVICES=none` stays as a debugging switch until
  every service has run out of process by default for a release, and then goes, with
  `services/inline.ts`.
- `runForeground` remains wiring and the socket remains transport. Review new behavior for where it
  belongs; line counts cannot distinguish feature logic from legitimate wiring. Services and the
  gateway use `CoreApi`, core modules use ports, and the master imports no feature code. The existing
  import checks enforce these boundaries; new exceptions require a separate architecture review.
- Keep the per-file 100% coverage gates for the core, services and master. The real-daemon tests in
  `e2e/services.e2e.ts` and `e2e/serviceProcesses.e2e.ts` must still prove that unavailable, crashing,
  hung or leaking services leave agents and terminals working, with bounded fallback answers.
- For a change to runtime cost, compare CPU, memory and latency against a recorded baseline on the
  same workload and toolchain. `e2e/perf.e2e.ts` emits those measurements when explicitly enabled;
  it does not silently impose a universal performance threshold. Record the environment and noise
  before proposing a numerical performance gate.

The original 61,000 estimate was the sum of what stays: about 66,700 lines of files that stay whole, less the commands
in `cli.ts` (the core's entry is about 2,900 lines of it), less the parts of the socket, the hook
server and the local WebSocket server that leave (about 2,200), less the feature wiring in
`runForeground` (about 900), the dead code (about 600) and the unsupervised update handoff (about
180), plus about 600 lines of new links: about 60,600.

## Found on the way

Fix in place, in step 3 unless noted.

- `selfUpdate.ts:192`: the canary's `spawnSync` blocks the core's event loop for up to 15 s.
- `runtimeInstall.ts:54, 135`: `execFileSync` of `tar` (120 s) and `grid --version` (60 s) on the core's
  event loop at every Grid pin move.
- `backendSocket.ts:432–435`: `orchestratorRoleOf` builds the orchestrator at the first turn end of
  every daemon, with synchronous disk reads; if it throws, the apps stop receiving frames.
- `core/transcripts/ingest.ts:58–62`: the device's transcript observer and the runtime profiles'
  ingest run unguarded on every transcript line.
- `cli.ts:4027, 4060`: the Wi-Fi device's constructors throw on a corrupt state file, unguarded, and
  put the whole core in safe mode.
- `reconcileOnce` has no deadline: a stuck pass stops every hook from binding and every registry save.
- `backendSocket.ts:124, 1223`: signed out, every event is sealed and queued for a link that never opens.
- `channels.ts:42–50`: the tab-channel poll runs every 15 s on every daemon, Tab collaboration or not;
  Share's timers likewise (`sharing/owner.ts:47–53`). Not fixed here (move only): they leave the core
  with the experimental host (step 8).
- `services/fleet.ts:39–62`: the fleet service is handed the `AuthSessionManager` and the E2EE
  identity, against "a service holds no credential" (step 10).
- `cableHost.ts:95–120`: the dial's host holds an `AuthSessionManager` of its own (step 9).
- The relaunch takes the private Grid name from `backend.gridName()`, not the row: a restore before
  `machine_meta` arrives may drop `HARNESS_PRIVATE_GRID` (unconfirmed; worth an e2e check).
- `restartForUpdate` does not stop the cable or the fleet as `shutdown` does: unsupervised, the old
  process holds the serial port while it waits on its child (gone with step 11).
- `hook/notify.mjs`: a 4xx or 5xx from a core that is up still triggers the hook's offline registry
  write, racing the core (`notify.mjs:1393, 1547`; round 35 stopped the timeout case).

## Open decisions

1. **On-demand services.** Start the devices and the experimental host only when used (250 MiB always
   on), or run all seven always (350 MiB)?
2. **Where the fleet lives.** Beside the dial (its synchronous reader, as proposed) or in the gateway
   (its lane is a relay client)? Either way its credentials go through `core.account`.
3. **Credentials.** Services ask `core.account` for every token (today's rule), or the gateway and the
   account proxies refresh the session themselves, which the file lock (`authSession.ts:149–186`)
   already makes safe? And whether reading the vendor Keychain for account usage counts as holding a
   credential.
4. **The lane follows the dial** (from the harnessd design): with no dial, ⌘K never sees another
   machine. Opening the lane for ⌘K changes what the backend counts as watching each machine.
5. **Keystrokes to the prompt scopes** cross a process once teams leaves: batched, or gated on Tab
   collaboration being on (a feature change, so not in a move-only step).

## Appendix: the count

The walk: start at the core's entry; for each file, read every `import … from '…'`, `export … from
'…'`, `import '…'` and `import('…')` that is not `import type`; resolve relative specifiers (`.js` to
`.ts`, `index.ts`); keep files under `cli/src` that are not tests; sum their lines. Run on 3ac2aea57
from `cli/src/cli.ts`, it gives 472 files and 111,892 lines. The area of each file, and whether it
stays, leaves or is a CLI command, is the table above; the classification is by path, file by file,
corrected where the inventories found a file serving another area than its name says.
