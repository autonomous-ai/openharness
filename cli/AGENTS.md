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

`src/core/main.ts` `runForeground()` is the composition root: it creates the modules and wires them
together. It is the core's own entry (`harness __run`), which the master starts; `src/cli.ts` is the CLI,
and calls in for `__run`. `harness start -f` runs the master in the foreground, as launchd and systemd do.
A core with no master (`HARNESS_NO_MASTER=1`, or one an older release's handoff started) hands each update
to a master that judges it (`src/core/updateHandoff.ts`). `src/backendSocket.ts` is the transport: it
receives frames and dispatches them.
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
   a handler there is one call into a module or service. `src/architecture.spec.ts` fails when either
   grows; move the logic out instead of raising the budget. It also walks the imports from
   `src/core/main.ts` and holds what the core's process loads to `CORE_CLOSURE_BUDGET`, with no file from
   an edge folder (a service, the dial, the relay, …) but those it lists, each with the step that ends it
   ([../docs/design/2026-10-06-core-boundary-next.md](../docs/design/2026-10-06-core-boundary-next.md)).
2. **A feature is a service.** It runs against `CoreApi` and is reached through a port in `CorePorts`,
   both in `src/core/api.ts`. A service never imports core modules, the registry, `cli.ts` or
   `backendSocket.ts` (`src/architecture.spec.ts` checks it). See [src/services/AGENTS.md](src/services/AGENTS.md).
3. **The core does not wait on a service and does not crash with one.** Services start through
   `serviceHost.start()`; every port declares fallbacks beside it in `core/api.ts`.
4. **100% coverage, per file,** for `src/core/`, `src/services/` (`npm run test:core`) and `src/harnessd/`
   (`npm run test:harnessd`). CI enforces both. Write the test that fails without your change. The one
   file outside it is `src/core/main.ts`, the wiring, which the end-to-end suite runs.
5. **End to end for every user-facing flow** (`npm run test:e2e`, `e2e/`): the real daemon, a private
   tmux server and fake Claude Code and Codex engines (`e2e/harness/fakeEngine.mjs`). Prefer extending
   the fake engine faithfully over loosening a test.
6. **Never test against the developer's own machine.** Tests use a throwaway home and data folder:
   never the real `~/.claude`, `~/.codex`, daemon (port 18473) or tmux server. In tmux tests unset
   `TMUX` and `TMUX_PANE`, and point `TMUX_TMPDIR` at a folder that exists (`src/testing/isolatedTmux.ts`).
7. **Comments say why, in plain sentences.** Name the incident or the measurement that made the code
   the way it is; that history is what keeps the next change from undoing it.

## Commands

```bash
npm run typecheck        # tsc
npm test                 # the unit suite
npm run test:core        # src/core and src/services at 100%
npm run test:harnessd    # src/harnessd at 100%
npm run test:e2e         # the real daemon, end to end
```
