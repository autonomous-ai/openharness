# The launch port

The owner's item 4. The features a launch can carry — a grid model, a saved API, a harness package (DSH) — take
their own code out of the core and hand their part of a launch to it through one port. The core still owns
spawning the pane, assembling the argv and the session record. The service that owns a feature contributes that
feature's launch settings before the spawn: env, args, files to write, MCP configuration. A launch that needs a
service that is down fails at once, with a clear error. A launch that does not need it never asks it.

At `9f8435573` the core loads about 3,300 lines of this:

| | Files | Lines |
| --- | --- | --- |
| Grid | `lib/gridLaunch.ts`, `lib/gridWebMcp.ts`, `lib/gridAssignment.ts` | 1,854 |
| API connections | `lib/apiConnections.ts`, `lib/apiModels.ts`, `lib/apiInstructions.ts` | 377 |
| DSH | `dsh/runtime.ts`, `manifest.ts`, `materialize.ts`, `shell.ts`, `installed.ts` | 872 |

## What stays in the core

- **Spawning and assembling.** The pane, the argv (`lib/engineLaunch.ts`), the order of the parts (grid or own
  login, then DSH, then SCM, then the named agent), and the session record (`gridLaunch`, `dsh`, `dshRuntime`).
- **The checks that need nothing from a service.** Whether this tmux can give a pane its own environment, and
  whether the engine can be pointed at a grid at all.
- **Writing what a service hands it.** A file-configured engine's directory in the core's data folder
  (`lib/gridConfigDir.ts`), keyed on the agent as today. Services return files, and the core writes them.
- **The wire.** Parsing and checking a grid launch the desktop sends or the registry kept (`parseGridLaunchOverride`,
  its types, `isApiLaunch`). These are small and are what the core validates its input with.
- **Data that every launch reads.** The vendor variables a grid launch clears, the variables each engine's grid
  launch sets (cleared when an agent leaves a grid, which needs no service), and the engines a grid can run. Each
  is declared in the core. A spec pins it equal to what the service's builders produce.

## The port

Each owner adds launch methods to its existing port in `core/api.ts`, so the transport, waits and fallbacks are
the ones every service call already uses (`core/serviceLinks.ts` `call`, `LONG_ANSWERS`, `PortFallbacks`):

| Owner | Already owns | Contributes |
| --- | --- | --- |
| Models (`services/models.ts`, its own process) | grid, the saved APIs | **Grid launch:** an engine's settings for a grid or API launch (env, args, config files, web-search MCP wiring, session model), with an API's key as saved now. **API target:** where an agent moved onto a saved API's model sends its inference. **Grid assignment:** which grid each running agent is on, and the saved APIs' endpoints that say so. |
| Store (`services/store.ts`, its own process) | installing and updating harness packages | **DSH launch:** the workspace materialized at create, and the package's env and args at every launch. |

**A launch never hangs on a service.** A call waits at most its declared bound, and a service that is down
answers `SERVICE_UNAVAILABLE` at once. The launch then fails with the feature's error:

- `GRID_UNAVAILABLE`: "The models service is not running, so this agent cannot be put on grid `<name>`. Try again in a
  moment.";
- `API_UNAVAILABLE` for a saved API;
- `DSH_UNAVAILABLE` for a harness package.

An agent on its own login, with no package, asks no service. A grid assignment that cannot be read is unknown,
and the row keeps what it had, as a failed process read does today.

A launch someone is waiting on (create, retarget, restart, fork, the socket's API selection) is refused at once.
A launch nobody asked for, a restore, is never refused for a service: the agent is **held** until the service is
ready (next section).

## Held until the service is ready

The owner's bar is safe, reliable and dependable. A restore after a reboot must bring every agent back, and the core
must report ready on time whatever a service does. Built once, generically (`core/agents/heldLaunches.ts`,
`lib/restoreAgents.ts`). (L3) reuses it for the Store.

- **(a) Readiness never waits on a service.** The boot's restore launches agents on their own login as before. An
  agent whose launch asks a service (`needs`: a grid or a saved API asks `models`) is not launched then: it is put in
  a pane of its own, in the boot's one registry transaction, running only a line that says what it waits for
  (`heldPaneArgv`), and its row's launch is `{ state: 'held', service, detail }`. After `coreLink.ready()` a second
  pass launches the held agents into those panes (`respawn`), outside any registry transaction.
- **(b) A service that cannot be asked never fails an agent.** A launch that answers `unavailable: 'models'` (core
  `gridLaunchThrough`, via `launchOverrides.ts`) holds the agent instead of failing it. Held is never `failed`, never
  skipped by the next restore, and never archived by discovery: its pane is alive and runs no engine, and the row is
  inactive. It is launched when the service connects (serviceLinks `connected` → `restoreHeld(service)`), unless the
  person stopped or closed it meanwhile (the row is then gone or no longer held). A person's restart of a held agent
  launches it now (`restart.ts` → `restartHeld`).
- **(c) One pass, one deadline.** After the first unavailable answer in a pass, every later agent that needs the
  same service is held without asking. A pass waits on a service at most once, for that call's bound.
- **Why a pane, not no pane.** Every registry row must keep a pane (`strictPersistedRow`), and an older release reads
  the same file after a rollback. A held row that kept its dead pane id could collide with a pane the new tmux server
  hands out (`%0` again), and the registry would refuse to save. A waiting pane opened in the boot's transaction
  cannot collide, keeps discovery from retiring the row, and shows the person the reason.
- **What an older app shows.** It reads an unknown launch state as ready, so a held agent shows offline with its
  waiting pane. The reason is in the pane and in the row (`launch.detail`).
- **Proof.** `lib/restoreAgents.spec.ts` (held at boot without asking, launched into its pane outside a transaction,
  one ask per pass, never skipped or archived, a fresh relaunch held), `core/agents/heldLaunches.spec.ts` (the boot
  gate, passes by service, one at a time, restart, stopped or closed meanwhile), and end to end
  (`e2e/serviceProcesses.e2e.ts`): two grid agents across a reboot with models killed, and with models hung. The core
  reports ready within 15 s, both agents are held, never failed or archived, and both come back with their
  conversations once models is there. `HARNESSD_TEST_HOLD_CONNECT` holds a service off the core while a file
  exists, for those tests.

## Sub-batches

| | Scope | Leaves the core |
| --- | --- | --- |
| **(L1) Grid and API launches** | `ModelsPort` gains the grid launch and the API target. Callers: create, every relaunch (restart, resume, restore, fork), retarget's check before it touches the pane, and the socket's `api` selection. | the grid launch builders, `gridWebMcp.ts`, `apiModels.ts`: about 1,750 lines |
| **(L2) Grid assignment** | Discovery, restart and retarget ask models for the assignments of the processes that carry grid-launch markers, in one call a pass. The saved APIs' endpoints are models'. The saved-API instructions stay in the core. | most of `gridAssignment.ts`: about 290 lines |
| **(L3) DSH launches** | `StorePort` gains the DSH launch. Callers: create (materialize, then the env and args), every relaunch, fork. The core keeps the installed index and its checks. | `dsh/runtime.ts`, `materialize.ts`, `shell.ts`: about 500 lines |

Each sub-batch is its own PR, stacked, each green on its own.

## Proof, for each

- **A golden record first, in its own commit, from the former code.** It covers every launch shape that uses the
  feature: create, restart, resume, restore, fork and retarget, on each engine that takes it. Each records the
  argv, the env, the cleared variables, the files written with their bytes, the log lines, and every refusal. It
  runs on darwin and on linux, also under `TZ=UTC TMPDIR=/tmp`, through a composition that stays fixed across the
  move. Mutations of the moved code must fail it.
- **The models service down at launch, end to end.** A plain Claude Code and Codex launch works. A grid launch
  fails at once with `GRID_UNAVAILABLE`, and the agents already running go on.
- **The core's closure, before and after**, with `architecture.spec.ts` listing the moved files as edge files.

## Coordination

(o6) moves OpenCode's version check and the other engines' launch data out of `core/agents/{launches,create}.ts`
and `engines/launches.ts`. The grid block in `create.ts` sits beside them, so small conflicts are expected. Both
sides keep their lines.

## (L1) as built

- **The wire stays, the builders go.** `lib/gridLaunchWire.ts` (473 lines) is what the core checks a launch with
  and reads at every launch: `GridLaunchOverride` and its parser, `isApiLaunch`, the vendor variables a grid
  launch clears, the variables each engine's grid launch sets, the engines a grid can run, and the line a grid
  launch is logged with (the core logs it from the launch it holds: create's, or the record a relaunch built).
  `lib/gridLaunch.ts` keeps the contracts and builds; `contractEnvVarNames` and `contractEngines` are what the
  declared lists are held equal to (`lib/gridLaunch.spec.ts`).
- **One question, one answer.** `ModelsPort.gridLaunch({ engine, override, machine, refresh })` answers the launch,
  the override it was built from (a relaunch's saved API as saved now) and the endpoint of a saved API it read;
  or the refusal. `ModelsPort.apiTarget({ connectionId, model })` answers the socket's `api` selection. Both take
  the half-minute bound every service call has (`LONG_ANSWERS` lists neither).
- **Down is a refusal.** `core/agents/launch.ts` `gridLaunchThrough` turns anything but an answer into
  `GRID_UNAVAILABLE` (`API_UNAVAILABLE` for a saved API): "The models service is not running, so claude cannot be
  put on Home grid. Try again in a moment." The socket's `api` selection answers `API_UNAVAILABLE` likewise. A
  launch with no grid never asks, so it never starts models (on demand) either. The refusal names the service
  (`unavailable: 'models'`), which a restore reads to hold the agent instead (above).
- **From the review.**
  - A create of a harness on a grid asks models before the workspace is laid out or trusted, so a refused create
    leaves the folder as it was.
  - `GRID_CONFLICTING_ENV_VARS` is pinned to what the contracts set, with each exception named.
  - A socket spec fails if the API selection loses the target or the endpoint it remembers.
- **What the core still remembers.** A saved API's endpoint an answer carries is added to the core's grid
  assignment (`rememberApiBase`), as when the core read the store itself. The store stays in the core until (L2).
- **Proof.** The golden (`engines/launchShapes.golden.spec.ts`, recorded first from the former code) passes
  unchanged on darwin and linux, also under `TZ=UTC TMPDIR=/tmp`, with every grid launch crossing the process
  boundary as JSON and checked as each side checks it (`testing/launchShapes.ts`); so does the earlier launch
  argv golden. Sixteen mutations of the moved wiring each fail a golden or a spec. End to end, models killed:
  Claude Code and Codex on their own login launch and take turns; a create, a restart and a retarget on a grid,
  and a retarget onto a saved API, are refused at once; the agent on the grid keeps running; and its restart
  works once models is back (`e2e/serviceProcesses.e2e.ts`).
- **Closure** (`core/main.ts`): 67,045 lines in 370 files before, 65,858 in 367 after. `gridLaunch.ts` (1,121),
  `gridWebMcp.ts` (446), `apiModels.ts` (171) and `codingContext.ts` (12) left; `gridLaunchWire.ts` (473) came
  in. `architecture.spec.ts` lists the three as edge files.

## (L2) and (L3): decisions, and where the work stands

The owner's decisions, through the coordinator. Line count is "just a number"; what matters is a good
architecture: safe, reliable, dependable.

### (L3) Harness packages (DSH): next

- **Decided.**
  - A restore of a harness agent goes through the held mechanism above with `service: 'store'`. The core never
    waits for the Store before it is ready. An agent the Store cannot prepare is never launched unprepared: it is
    held, with the reason, and launched once the Store says it is ready (the Store's `prepared` notice,
    core/storeLink.ts, or its `connected`), unless the person stopped or closed it. A manual restart works too.
  - The coordinator's earlier "wait up to 30 s for the Store at boot" is superseded by rule (a): the wait moves to the
    pass after ready.
  - Pin the never-launched-unprepared rule with a spec, and add an e2e with the Store killed.
- **Recorded.** The golden, from the code as it stood after (L1), is on branch `claude-recovery/launch-port-dsh`
  (pushed, no PR): `engines/dshLaunchShapes.golden.spec.ts` and its fixture. It has 61 cases (create 27, relaunch 25,
  fork 9) across the harness adapters, with the workspace files and their bytes, folder trust, the init asked for,
  logs and refusals. It gives the same result run after run and under `TZ=UTC TMPDIR=/tmp`.
  - **Re-record it before L3's move.** Its commit came before two changes on this PR: `create.ts` now asks models
    before it lays a workspace out, and restore defers service launches. Rebase that branch on this PR's head, run
    `RECORD_DSH_LAUNCH_SHAPES_GOLDEN=1`, and check that the only differences are those two (the DSH + grid create's
    log order).
- **Design for the move, already drafted.** It is not on any branch; rebuild it from this list.
  - `dsh/launchWire.ts` (core): `DshMaterializeRequest/Answer`, `DshLaunchRequest/Answer` (with `forkOf` and `thrown`,
    the text a relaunch always gave), and `dshUnavailable(name)`. Make that refusal carry `unavailable: 'store'`, as
    `gridUnavailable` carries `'models'`.
  - `StorePort { dshMaterialize, dshLaunch }`, `STORE_FALLBACKS` (`later(FAIL)`), `STORE_OFF`, and `store` in
    `CorePorts`. `LONG_ANSWERS.store.dshMaterialize = 6 min`: the init is given 5.
  - `services/storeLaunch.ts` (`storeLaunchPort`, built on `materializeWorkspace`, `forkRuntimeKey` and
    `prepareHarnessLaunch`). `services/storeProcess.ts` answers it as port calls (`dshMaterializeRequestIn`,
    `dshLaunchRequestIn`). `startStoreInCore(core, ports)` fills `ports.store` in-process. `core/storeLink.ts` gains
    `port` (`dshMaterializeAnswerIn`, `dshLaunchAnswerIn`) and `onReady`.
  - `core/agents/dshThrough.ts`: `materialize` and `launch` (unavailable → `DSH_UNAVAILABLE`), and `relaunch` for
    `launchOverrides.ts`, whose `dshLaunch` dep becomes async. A refusal ends the launch. Keep the
    not-installed log line in the core.
  - `create.ts`, `fork.ts` and `main.ts` ask through it. `incompatibleHarnessEngine` moves to `dsh/compatibility.ts`.
    `harnessLaunchOrRefusal` goes. `adapters.ts` stays in the core: `scm/scmProjects.ts` reads
    `PROJECT_INSTRUCTION_FILES`.
  - Restore: `needs: (entry) => entry.gridLaunch ? 'models' : entry.dsh ? 'store' : null`. A grid harness needs both:
    hold for `models` first. Then wire `storeLink.onReady` → `restoreHeld('store')`.
  - Proof: the golden passes unchanged, with every Store answer crossing the wire as JSON. Mutations; 100% core; the
    e2e with the Store killed (its process is the viewers', `harnessd-viewers`).

### (L2) Grid assignment: after (L3)

- **Decided.**
  - **No cache.** Keep today's recognition exactly: every pass classifies again. Models staying up while a grid agent
    exists is fine, because those agents need it anyway.
  - **Ask models only for processes that carry grid-launch markers.** These are the engine's endpoint variable
    (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` for Hermes, `GROK_MODELS_BASE_URL`, `COPILOT_PROVIDER_BASE_URL`), Pi's
    `PI_CODING_AGENT_DIR`, OpenCode's `OPENCODE_CONFIG`, or a `model_providers.….base_url` argument. Any other
    process is on no grid, which is what the classifier answers today. Declare the markers in the wire and pin them
    to the classifier with a spec. Send only the variables the classifier reads, never a key.
  - **Never wait, never clear.** If models is down or slow, discovery and binding go ahead without waiting. The
    assignment shows as unknown (`undefined`) or keeps its last known value; it is never cleared. Spec both.
  - **The saved-API instructions stay in the core,** which reads the list of saved APIs (no keys). A launch never
    depends on models for them and gains no new silent failure. Nothing changes there beyond what the port needs.
- **Next steps.**
  - `ModelsPort.gridAssignments(processes)`, one call a discovery pass, restart and retarget (`probeGridAssignment`
    callers: `lib/terminalAgentDiscovery.ts`, `core/agents/restart.ts`, `core/agents/retarget.ts`), bounded by the call's
    wait.
  - The saved APIs' endpoints (`rememberApiBase`, `rememberSavedApis`, the socket's and `gridLaunchThrough`'s
    `apiBase`) move to models with the classifier.
  - A golden of every assignment shape first, from the former code (env, argv, Pi's and OpenCode's config files, a
    saved API's endpoint, the router id), then the move. Specs for down and slow models, and an e2e with models
    killed during discovery.
