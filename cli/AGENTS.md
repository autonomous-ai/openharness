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

`src/cli.ts` `runForeground()` is the composition root: it creates the modules and wires them
together. `src/backendSocket.ts` is the transport: it receives frames and dispatches them.

## Where new code goes

| You are adding | Put it in | Not in |
|---|---|---|
| A new feature (anything a session can run without) | a new service, `src/services/<name>.ts` | the core, `cli.ts`, `backendSocket.ts` |
| Behaviour of agents, terminals, transcripts, turns, input or questions | the module under `src/core/` that owns it | `cli.ts` |
| Support for an engine (Claude Code, Codex, …) | `src/engines/<engine>/` | the core |
| A pure helper with no daemon state | `src/lib/` | the core |
| Supervision of processes | `src/harnessd/` | anywhere else |

## Rules

1. **No logic in `runForeground` or the `backendSocket.ts` request switch.** Wiring and dispatch only:
   a handler there is one call into a module or service. `src/architecture.spec.ts` fails when either
   grows; move the logic out instead of raising the budget.
2. **A feature is a service.** It runs against `CoreApi` and is reached through a port in `CorePorts`,
   both in `src/core/api.ts`. A service never imports core modules, the registry, `cli.ts` or
   `backendSocket.ts` (`src/architecture.spec.ts` checks it). See [src/services/AGENTS.md](src/services/AGENTS.md).
3. **The core does not wait on a service and does not crash with one.** Services start through
   `serviceHost.start()`; every port declares fallbacks beside it in `core/api.ts`.
4. **100% coverage, per file,** for `src/core/`, `src/services/` (`npm run test:core`) and `src/harnessd/`
   (`npm run test:harnessd`). CI enforces both. Write the test that fails without your change.
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
