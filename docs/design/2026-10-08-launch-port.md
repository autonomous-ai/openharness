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
| Models (`services/models.ts`, its own process) | grid, the saved APIs | **Grid launch:** an engine's settings for a grid or API launch (env, args, config files, web-search MCP wiring, session model, the log line), with an API's key as saved now. **API target:** where a new agent on a saved API's model sends its inference. **API tools:** the saved-API instructions an agent's folder gets. **Grid assignment:** which grid each running agent is on. |
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
| **(L1) Grid and API launches** | `ModelsPort` gains the grid launch, API target and API tools. Callers: create, every relaunch (restart, resume, restore, fork), retarget's check before it touches the pane, and the socket's `api` selection. | the grid launch builders and `gridWebMcp.ts`, `apiConnections.ts`, `apiModels.ts`, `apiInstructions.ts`: about 2,000 lines |
| **(L2) Grid assignment** | Discovery, restart and retarget ask models for the assignments of a pass's processes in one call. The saved APIs' endpoints are models' to remember. | `gridAssignment.ts`: about 290 lines |
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
