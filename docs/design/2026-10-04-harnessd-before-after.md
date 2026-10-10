# harnessd: before and after the refactor

A one-page picture of what changed in the daemon between the last release (v0.3.57, 2 October 2026)
and the harnessd rebuild, for explaining the refactor to the team. The full design, its rules and
its plan are in [2026-10-03-harnessd.md](2026-10-03-harnessd.md). Paths are under `cli/src/`.

The "after" picture below is the rebuild as it was on 4 October. [Today](#today-one-process-per-risk)
shows where it went next: most services now run in processes of their own
([2026-10-06-core-boundary-next.md](2026-10-06-core-boundary-next.md)).

## Before: one process, one function

```
            desktop app · hn · harness CLI · engine hooks · phone/web (via relay)
                                       │
┌──────────────────────────────────────┴──────────────────────────────────────┐
│ ONE PROCESS  ·  harness __run                                               │
│                                                                             │
│  cli.ts  runForeground()   one function, 5,306 lines, shared variables      │
│  backendSocket.ts          ~70 request types, 53 callbacks wired by hand    │
│                                                                             │
│  agents · tmux · discovery · hooks · transcripts · turns · input · questions│
│   relay · E2EE · sharing · dial · Wi-Fi device · search · viewers · grid    │
│   workspaces · teams · recap model pool · …                                 │
│        everything inside one function: every part can touch every other     │
│                                                                             │
│  ✗ one bug anywhere (exception, hang, memory) takes the whole daemon down   │
│  ✗ no supervisor: back only when the desktop app respawned it (up to ~70 s) │
│  ✗ no part can be tested alone: it exists only inside that function         │
│  ✗ every feature edits the same file: conflicts and risky reviews           │
└─────────────────────────────────────────────────────────────────────────────┘
```

On 3 October an 803 MB Codex transcript was read whole on attach, ran the process out of memory,
and it crash-looped: every agent on the machine lost its daemon at once.

## After: three layers, with walls between them

```
            desktop app · hn · harness CLI · engine hooks · phone/web (via relay)
                                       │
┌──────────────────────────────────────┴──────────────────────────────────────┐
│ ① MASTER: the supervisor          src/harnessd/      harness __harnessd     │
│   supervisor.ts  starts, watches and restarts the core · memory budget ·    │
│                  crash-loop safe mode · update probation and rollback       │
│   no feature code, no network: almost nothing in it can fail                │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ spawn channel  (harnessd/protocol.ts)
┌──────────────────────────────────────┴──────────────────────────────────────┐
│ ② CORE: must never go down        src/core/          harness __run          │
│                                                                             │
│  core/agents/       create · fork · restart · stop · resume · close ·       │
│                     discovery · bind                              15 files  │
│  core/transcripts/  attach · live tail · relaunch marks · normalizers  6    │
│  core/turns/        working/idle · event funnel · cancel · recaps      7    │
│  core/terminals/    who controls a tmux pane (the control lease)       1    │
│  core/engines/      engine hooks (13 engines)                          2    │
│  core/input.ts      typed messages into the pane, in order                  │
│  core/questions.ts  an agent's question to you, and your answer back        │
│                                                                             │
│  cli.ts runForeground() only wires these together: 5,306 → 2,663 lines      │
│  each module: one factory, explicit dependencies, 100% test coverage        │
│                                                                             │
│  core/api.ts          the contract between core and services:               │
│                       CoreApi   = what a service may ask of the core        │
│                       CorePorts = what the core asks of a service           │
│  core/serviceHost.ts  the circuit breaker: a service that fails to start is │
│                       left off · every call is guarded, with a fallback ·   │
│                       5 failures in 60 s switch it off                      │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ only through CoreApi / CorePorts
┌──────────────────────────────────────┴──────────────────────────────────────┐
│ ③ SERVICES: the extendable part    src/services/                            │
│    in the core's process behind the host, or each in its own process        │
│    (HARNESSD_SERVICES=search: harnessd/services.ts runs it, the core routes │
│    to it through core/serviceLinks.ts) — search is the first                │
│    each answers its own requests from the apps: declared, routed to it      │
│                                                                             │
│  services/store.ts       the Harness Store         uses dsh/                │
│  services/search.ts      session search            uses lib/sessionSearch/  │
│  services/viewers.ts     harness viewers (DSH)     uses dsh/                │
│  services/models.ts      Grid and local models     uses lib/grid*           │
│  services/workspaces.ts  worktrees, branch names                            │
│  teams                   prompt scopes             teams/ via ports.teams   │
│  ─ not yet behind the host ─                                                │
│  devices      dial, Wi-Fi device   cable/, lib/autonomous-device/           │
│               every call into them is guarded                               │
│  relay        backend link, E2EE   backendSocket.ts, lib/e2ee/              │
│  sharing      shared harnesses     sharing/            next to move         │
└─────────────────────────────────────────────────────────────────────────────┘
            agents live in tmux: they keep running through every restart
```

## Why the subsystems are better than the monolith

| What happens | Before (monolith) | After (subsystems) |
|---|---|---|
| A bug in search, viewers, models, workspaces or teams | The whole daemon goes down, for every agent. | That request gets a retryable error (`SERVICE_UNAVAILABLE`). After 5 failures the service is switched off, and agents are unaffected. |
| The core crashes, hangs or runs out of memory | Down until the desktop app respawns it, up to about 70 s. | The master restarts it in about a second. Agents keep running in tmux. |
| A bad release | Every machine crash-loops. | The update is rolled back and never tried again. |
| One huge transcript | It was read whole, which caused the October 3 crash loop. | Reads are bounded, proven under a 256 MiB memory cap. |
| Testing a part | Only through the whole daemon. | Each module is unit-tested to 100% (`npm run test:core`). An end-to-end suite of 160 tests runs on the real daemon (`npm run test:e2e`). |
| Building a feature | Everyone edits the same 5,300-line function. | A feature is a new service with its own folder and tests, written against `CoreApi`, and the core doesn't change. |

## How to add a service

1. Put it in `services/<name>.ts` as `start<Name>(core: CoreApi, ports: CorePorts)`. It may only
   ask the core what `CoreApi` offers.
2. If the apps call it, declare its requests (`<NAME>_REQUESTS`) and return their handlers from its
   start. The core routes each request to it, with who asked. Nothing changes in `backendSocket.ts`
   or `core/main.ts` but the one line that starts the service. While it is off, its requests are answered
   `SERVICE_UNAVAILABLE`.
3. If the core must call it, add a port to `CorePorts` in `core/api.ts`, with fallbacks beside it:
   what the core does while the service is off or failing. Most features need no port.
4. Start it in `core/main.ts` through `serviceHost.serve(...)`, or `serviceHost.start(...)` when it has a
   port; never directly. The host guards its start, every call and every request, and switches it off
   when it keeps failing.
5. Hold the file to 100% (`npm run test:core` covers `src/services/`). For the end-to-end suite,
   `HARNESSD_TEST_FAULTS=<name>` makes its start fail, and `<name>.<member>` or `<name>.<request>`
   makes one call or one request fail.

`services/store.ts`, the Harness Store, is the example: no port, four requests, about 60 lines.

The same rules are written for coding agents in `AGENTS.md` files, one per layer: `cli/`, `src/core/`,
`src/services/` and `src/harnessd/`. Codex reads them directly. Claude Code reads them through a
`CLAUDE.md` beside each one that imports it, so every agent gets one set of rules. `src/architecture.spec.ts`
fails the build when code crosses a wall. A service that imports a core module fails it. So does a core
module that imports a service, feature code in the master, or a `runForeground` or `backendSocket.ts`
that grows past its budget. Each failure message says where the code belongs.

## What the end-to-end suite has found

20 real bugs, each fixed with a test that fails without the fix. They include:

- a corrupt registry that blocked every agent create;
- a pane killed from outside that stayed "active" forever;
- a message sent just after a resume or restart that was lost;
- rapid messages typed into one prompt, out of order;
- an agent created alongside others that was retired the moment its engine started;
- a turn taken just after a resume or restart that no window ever saw;
- a Stop pressed during start that was refused, and the ghost agent it could leave;
- a compaction that showed every window its turn starting twice;
- a Codex fork that never bound its conversation after a daemon restart;
- hn's `terminal_info`, which no build had ever answered (found by comparing with v0.3.57);
- a tmux server that died, after which dead agents showed as active;
- turns replayed live after a daemon restart;
- on a full disk: a rename lost to a restart, and a binding the windows never heard of.

Comparing every answer with the released v0.3.57 found no other difference across 90 answers. A
desk of 50 agents runs in 268 MiB, and all of them are back 8.3 s after a restart.

The full list is in the design doc's "Found while mapping".

## Today: one process per risk

Most services now run in processes of their own, which the master starts and watches beside the core.
The core keeps sessions, and reaches each service only through its link. Measured on `main` at b4027cbd1:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ MASTER  harnessd            starts, watches and restarts every process below │
└───────┬──────────────────────────────────────────────────────────────────────┘
        │ spawn channel, heartbeats, memory budgets, crash-loop parking
        ├── CORE  harnessd-core    sessions: agents · terminals · transcripts ·
        │                          turns · input · questions   (71,244 lines loaded,
        │                          from 114,622; runForeground 2,211 lines)
        ├── search                 session search
        ├── viewers                harness viewers, their remote streams · the Store
        ├── edge                   workspaces · usage · monitor · project readers ·
        │                          change-agent handoff · recaps
        ├── gateway                the relay and its E2EE: every remote client
        ├── models                 grid · local models · the Model Manager
        ├── updater                checks and stages a new build (installed copy only)
        │
        │   on demand: no process until it is needed
        ├── devices                dials · window bridges · fleet · Wi-Fi device
        ├── orchestrator           experiment
        ├── teams                  experiment: Tab collaboration
        ├── sharing                experiment: Share
        └── memory                 experiment: Memories across machines
```

One service failing costs its own process, and the master restarts it. The core answers its requests
`SERVICE_UNAVAILABLE` meanwhile, and every agent goes on. `HARNESSD_SERVICES=none` still runs every service
inside the core's process, for debugging. The end-to-end suite has 82 files.

## Next

The core still loads the engines' own code: the engine-interface refactor
([2026-10-05-engine-interface.md](2026-10-05-engine-interface.md)) is paused. The core's process still
parses all of cli.js, so its memory falls only with a lean core bundle, which is in progress.
