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

## Sub-batches

| | Scope | Leaves the core |
| --- | --- | --- |
| **(L1) Grid and API launches** | `ModelsPort` gains the grid launch and the API target. Callers: create, every relaunch (restart, resume, restore, fork), retarget's check before it touches the pane, and the socket's `api` selection. | the grid launch builders, `gridWebMcp.ts`, `apiModels.ts`: about 1,750 lines |
| **(L2) Grid assignment and the saved APIs** | Discovery, restart and retarget ask models for the assignments of a pass's processes in one call. The saved APIs' endpoints, and the instructions an agent's folder gets when any are saved, are models' to keep, told to the core so a launch on the engine's own login still asks models nothing. | `gridAssignment.ts`, `apiConnections.ts`, `apiInstructions.ts`: about 490 lines |
| **(L3) DSH launches** | `StorePort` gains the DSH launch. Callers: create (materialize, then the env and args), every relaunch, fork. The request's package check reads the installed index, a small file the core keeps reading. | `dsh/runtime.ts`, `materialize.ts`, `shell.ts` and most of `manifest.ts`: about 700 lines |

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
  launch with no grid never asks, so it never starts models (on demand) either.
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

## (L2) and (L3), as designed after (L1)

Each has a choice the owner or the coordinator should confirm before it is built.

### (L2) Grid assignment and the saved APIs

- **Ask only for a process that could be on a grid.** Discovery reads every agent's process each pass, and models
  is started on demand. So the core asks models (`ModelsPort.gridAssignments`, one call per pass) only for a
  process that carries what a grid launch writes:
  - the engine's endpoint variable;
  - Pi's config folder or OpenCode's config file;
  - a `model_providers.….base_url` argument.

  Those names are declared in the wire and pinned to the classifier. Any other process is on no grid, which is
  what the classifier answers today, so discovery of agents on their own login never starts models. Only the
  variables the classifier reads are sent, never a key. If models is down, the answer is unknown (`undefined`),
  and the row keeps its assignment, as a failed process read does today.
- **Choice: no cache.** A process's environment cannot change, but the saved APIs that make an endpoint count can.
  Today every pass classifies again, so an agent already on an API saved later is recognised. To stay identical,
  the answer is not cached, so models stays started while an agent runs on a grid, or with its own
  `ANTHROPIC_BASE_URL`. Caching by process would let it sleep, at the cost of that recognition.
- **The saved APIs' endpoints are models'.** The core stops reading `connections.json` at start and stops
  remembering endpoints (`rememberApiBase` leaves with the classifier).
- **Choice: API instructions.** Every non-terminal launch writes the saved-API instructions into the agent's folder
  when any API is saved (`apiInstructions.ts`). Moved to models, either:
  - the core asks models only when `connections.json` exists, so users who never saved an API never start models
    at launch; a launch while models is down goes ahead without the instructions and logs the warning it logs
    today; or
  - the instructions stay in the core, which keeps reading the list of saved APIs (no keys) for this.

### (L3) Harness packages (DSH)

- **A Store port.** The Store runs beside the viewers, always on. It gains two port calls:
  - `dshMaterialize({ dsh, workspace, engine, account })` (create only): the template and the init. It answers
    what it laid out and its warnings, which the core logs and uses for folder trust as today. Bound: the init's
    5 minutes plus a margin, in `LONG_ANSWERS`.
  - `dshLaunch({ dsh, workspace, engine, key, account, forkOf })`: the session's runtime, its env and its args.
    Callers: create, every relaunch and fork.
- **What the core keeps.**
  - The installed index (`installed.ts`), and from `manifest.ts` the checks it makes before asking: the id's
    shape, the engines a package supports, a pinned permission mode.
  - `compatibility.ts`, and the session variables a launch clears (`launch.ts`).
- **What leaves.** `runtime.ts`, `materialize.ts`, `shell.ts`, `adapters.ts`, and `dshLaunch`: about 560 lines.
  `PROJECT_INSTRUCTION_FILES`, which `scm/scmProjects.ts` reads, moves beside it.
- **Errors.** `DSH_UNAVAILABLE`: "The Store is not running, so Blender cannot be prepared for this agent. Try again
  in a moment."
- **Choice: restore at boot.** Restoring a harness agent now asks the Store. Today the core waits 5 s for the Store
  at boot and then restores anyway. Proposed: wait up to 30 s when harness agents are to be restored. One the
  Store still cannot prepare stays stopped, with the reason.
- **Proof.**
  - A DSH launch shapes golden first: create, relaunch and fork across the harness adapters, the workspace's files
    with their bytes, the logs and every refusal.
  - End to end, the Store's host killed: plain launches work; a harness create or restart is refused at once; once
    the Store is back, it works.
