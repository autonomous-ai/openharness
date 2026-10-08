# The Harness CLI and daemon (harnessd)

Read this before changing anything under `cli/`. The repository-wide process rules (validation,
merging, releases) are in [../AGENTS.md](../AGENTS.md). The design, and why, is in
[../docs/design/2026-10-03-harnessd.md](../docs/design/2026-10-03-harnessd.md). The one-page picture
for new contributors is [../docs/design/2026-10-04-harnessd-before-after.md](../docs/design/2026-10-04-harnessd-before-after.md).

## The shape: master, core, services

```
MASTER   src/harnessd/     supervises: starts, watches, restarts. No feature code, no network.
CORE     src/core/         owns sessions: agents, terminals, transcripts, turns, input, questions.
                           Must never go down. Grows only for what every session needs.
SERVICES src/services/     everything else: search, viewers, models, workspaces, … and new features.
                           Reaches the core only through core/api.ts; can fail without the core.
```

### The processes

The master runs the core and every service process (`SERVICE_HOSTS` in `src/harnessd/services.ts`). Each
service process runs one or more services, each on its own link to the core. In Activity Monitor and `ps`
they show as `harnessd`, `harnessd-core` and `harnessd-<process>` (`src/harnessd/processName.ts`).

| Process | Runs | Started |
|---|---|---|
| master | supervision only (`src/harnessd/`) | by `harness start`, `harness start -f`, or launchd or systemd after `harness service install` |
| core | sessions (`src/core/`) | always |
| engine-claude, engine-codex | history, last-turn readers, live transcript parsers, runtime profiles/catalogs, screen interpretation and model control | on demand: an attach or read for that engine |
| search | session search | always |
| viewers | the harness viewers, their remote streams and rendered surfaces, and the Store | always |
| edge | the shell service, workspaces, usage, the monitor, the project readers, the change-agent handoff, the recaps | always |
| gateway | the relay and its E2EE (`src/gateway/`) | on demand: as the core starts when signed in or anything is paired here, or when something needs it (a pairing, a window's E2EE request, a key command, the Wi-Fi device) |
| models | grid, local models, the Model Manager | on demand: once grid is in use here (a managed grid, saved grid pictures, local models), or on a models request |
| updater | checks, downloads and stages a new build (`src/services/updaterProcess.ts`) | by the master, for the installed copy only |
| devices | the dials, the window bridges, the fleet, the voice router, the Wi-Fi device | on demand: once there is a device |
| orchestrator, teams (with Tab collaboration), sharing, commandBar | the experiments | on demand: on a request, or saved state at start |

`HARNESSD_SERVICES` names a subset to run in their own processes, by service or by process.
`HARNESSD_SERVICES=none` runs every service in the core's process, for debugging or a quick way back. How
to add a service, and how to make one start on demand, is in [src/services/AGENTS.md](src/services/AGENTS.md).

`src/core/main.ts` `runForeground()` is the composition root: it creates the modules and wires them
together. It is the core's own entry (`harness __run`), which the master starts; `src/cli.ts` is the CLI,
and calls in for `__run`. `harness start -f` runs the master in the foreground, as launchd and systemd do.
The updater is the master's, in a process of its own (`src/services/updaterProcess.ts`): the core never
downloads a build. When it stages one, the master has the core hand over (`harnessd:update`) and judges the
new build. A core with no master gets no updates: one an older release's own handoff started hands itself
to a master once that release has gone, and one `HARNESS_NO_MASTER=1` asked for runs as it is
(`src/core/updateHandoff.ts`). A core under a master too old to run the updater starts it beside itself, in
its own process (`src/core/updaterBeside.ts`). `src/backendSocket.ts` is the transport: it receives frames and dispatches
them.
`src/gateway/` is the relay: the backend link, the E2EE sessions and keys, and every rule about what a
remote client may send and how what it is sent is sealed. It runs in a process of its own
(`src/gateway/gatewayProcess.ts`; the core's side is `src/core/gatewayLink.ts`), or in the core's with
`HARNESSD_SERVICES=none` (`src/gateway/start.ts`). The socket speaks to it in the clear through
`GatewayPort` and hears it through `GatewayEvents` (`src/core/api.ts`), and never holds a key. The
gateway also holds the other sockets that sign in to the backend for this machine's sake: the windows'
sessions to the owner's other machines, the Share relay for a harness shared with this account
(`WindowRelay`), and the fleet's lane's E2EE sessions, which the lane asks it to seal and open through
`core.account.lane` (`src/gateway/lane.ts`).

## Where new code goes

| You are adding | Put it in | Not in |
|---|---|---|
| A new feature (anything a session can run without) | a new service, `src/services/<name>.ts` | the core, `core/main.ts`, `backendSocket.ts` |
| A request the apps send to a feature | the service's start returns its handler ([src/services/AGENTS.md](src/services/AGENTS.md)) | a case in `backendSocket.ts`, a slot on `BackendSocket` |
| Behaviour of agents, terminals, transcripts, turns, input or questions | the module under `src/core/` that owns it | `core/main.ts` |
| Support for an engine (Claude Code, Codex, …) | `src/engines/<engine>/` | the core |
| A pure helper with no daemon state | `src/lib/` | the core |
| Supervision of processes | `src/harnessd/` | anywhere else |

## Rules

1. **No logic in `runForeground` or the `backendSocket.ts` request switch.** Wiring and dispatch only:
   a handler there is one call into a module or service. Review changes for that responsibility.
   `src/architecture.spec.ts` enforces import boundaries and walks the imports from `src/core/main.ts`:
   no file from an edge folder (a service, the dial, the relay, …) but those it lists, each with the
   reason and the step that ends it. New exceptions need a separate architecture review; remove an
   exception as soon as it is no longer reached. Source line counts are informational, never a merge
   gate or a proxy for runtime cost
   ([../docs/design/2026-10-06-core-boundary-next.md](../docs/design/2026-10-06-core-boundary-next.md)).
2. **A feature is a service.** It runs against `CoreApi` and is reached through a port in `CorePorts`,
   both in `src/core/api.ts`. A service never imports core modules, the registry, `cli.ts` or
   `backendSocket.ts` (`src/architecture.spec.ts` checks it). See [src/services/AGENTS.md](src/services/AGENTS.md).
3. **The core does not wait on a service and does not crash with one.** Services start through
   `serviceHost.start()`; every port declares fallbacks beside it in `core/api.ts`.
4. **100% coverage, per file,** for `src/core/`, `src/services/` (`npm run test:core`) and `src/harnessd/`
   (`npm run test:harnessd`). PR CI does not run these gates: run them locally when you change those
   files and record the result in the PR. Write the test that fails without your change. The one
   file outside it is `src/core/main.ts`, the wiring, which the end-to-end suite runs.
5. **End to end for every user-facing flow** (`npm run test:e2e`, `e2e/`): the real daemon, a private
   tmux server and fake Claude Code and Codex engines (`e2e/harness/fakeEngine.mjs`). Prefer extending
   the fake engine faithfully over loosening a test.
6. **Never test against the developer's own machine.** Tests use a throwaway home and data folder:
   never the real `~/.claude`, `~/.codex`, daemon (port 18473) or tmux server. In tmux tests unset
   `TMUX` and `TMUX_PANE`, and point `TMUX_TMPDIR` at a folder that exists (`src/testing/isolatedTmux.ts`).
7. **Comments say why, in plain sentences.** Name the incident or the measurement that made the code
   the way it is; that history is what keeps the next change from undoing it.
8. **Measure runtime cost with the workload it affects.** For changes to startup, the input path or
   recurring work, compare CPU, memory and latency on the same workload and toolchain against a
   recorded baseline. `e2e/perf.e2e.ts` provides an opt-in workload and JSON measurements; these are not
   an automatic performance gate. Keep failure-isolation and deadline tests mandatory. A new numerical
   performance limit needs measured evidence, not a source-size estimate.

## Commands

```bash
npm run typecheck        # tsc
npm test                 # the unit suite
npm run test:core        # src/core and src/services at 100%
npm run test:harnessd    # src/harnessd at 100%
npm run test:e2e         # the real daemon, end to end
```
