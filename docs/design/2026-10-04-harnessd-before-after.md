# harnessd: before and after the refactor

A one-page picture of what changed in the daemon between the last release (v0.3.57, 2 October 2026)
and the harnessd rebuild, for explaining the refactor to the team. The full design, its rules and
its plan are in [2026-10-03-harnessd.md](2026-10-03-harnessd.md). Paths are under `cli/src/`.

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
│   agents · tmux · discovery · hooks · transcripts · turns · input · questions│
│   relay · E2EE · sharing · dial · Wi-Fi device · search · viewers · grid    │
│   workspaces · teams · recap model pool · …                                 │
│        everything inside one function: every part can touch every other    │
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
│  core/agents/       create · fork · restart · stop · resume · close ·      │
│                     discovery · bind                              15 files  │
│  core/transcripts/  attach · live tail · relaunch marks · normalizers  6    │
│  core/turns/        working/idle · event funnel · cancel · recaps      7    │
│  core/terminals/    who controls a tmux pane (the control lease)       1    │
│  core/engines/      engine hooks (13 engines)                          2    │
│  core/input.ts      typed messages into the pane, in order                  │
│  core/questions.ts  an agent's question to you, and your answer back        │
│                                                                             │
│  cli.ts runForeground() only wires these together: 5,306 → 2,636 lines      │
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
│    in the core's process behind the host, or each in its own process       │
│    (HARNESSD_SERVICES=search: harnessd/services.ts runs it, the core routes │
│    to it through core/serviceLinks.ts) — search is the first                │
│                                                                             │
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
2. If the core must call it, add a port to `CorePorts` in `core/api.ts`, with fallbacks beside it:
   what the core does while the service is off or failing.
3. Start it in `cli.ts` through `serviceHost.start(...)`, never directly. The host guards its start
   and every call, and switches it off when it keeps failing.
4. Hold the file to 100% (`npm run test:core` covers `src/services/`). For the end-to-end suite,
   `HARNESSD_TEST_FAULTS=<name>` makes its start fail, and `<name>.<member>` makes one call fail.

The same rules are written for coding agents in `AGENTS.md` files, one per layer: `cli/`, `src/core/`,
`src/services/` and `src/harnessd/`. Codex reads them directly. Claude Code reads them through a
`CLAUDE.md` beside each one that imports it, so every agent gets one set of rules. `src/architecture.spec.ts`
fails the build when code crosses a wall. A service that imports a core module fails it. So does a core
module that imports a service, feature code in the master, or a `runForeground` or `backendSocket.ts`
that grows past its budget. Each failure message says where the code belongs.

## What the end-to-end suite has found

15 real bugs, each fixed with a test that fails without the fix. They include:

- a corrupt registry that blocked every agent create;
- a pane killed from outside that stayed "active" forever;
- a message sent just after a resume or restart that was lost;
- rapid messages typed into one prompt, out of order;
- an agent created alongside others that was retired the moment its engine started;
- a turn taken just after a resume or restart that no window ever saw;
- a Stop pressed during start that was refused, and the ghost agent it could leave;
- a compaction that showed every window its turn starting twice;
- a Codex fork that never bound its conversation after a daemon restart.

The full list is in the design doc's "Found while mapping".

## Next

Search already runs in its own process when `HARNESSD_SERVICES=search` is set. Killed, hung, leaking
or crash-looping, it costs search alone (`e2e/serviceProcesses.e2e.ts`). It is off by default until
it has been run for real. The other services follow the same way, devices next, so that a native crash
or a memory leak in any of them cannot touch the core either. After that come platform supervision
(launchd, systemd) and the state directory move.
