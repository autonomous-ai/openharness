# Claude Code's model list fails the whole picker when Claude Code answers slowly

Date: 2026-11-17. Branch: `fix/models-list-e2e`. Component: `cli/` (the Claude Code engine's runtime profile, which runs
in the `engine-claude` worker, and the e2e fake engine). Not in the core. Platforms: macOS, Linux, Windows (the same
code everywhere; the worker's deadline is the same on each).

## Problem

Since #4413 (main `6e31e00202`), `models_list` for a Claude Code agent fails as a whole: the phone's and the dial's
model pickers show nothing, and `agent_update` cannot be offered a model. CLI end to end, run
[44072266267](https://github.com/autonomous-ai/openharness/actions/runs/44072266267), and locally on main `7a24e46a42`:

- `engineModelControl.e2e.ts`: 4 tests (`models_list` answers `INTERNAL`, or times out after 15 s in inline mode);
- `engineReaders.e2e.ts`: `claude keeps native runtime profiles in explicit inline mode`, `claude retains its accepted
  profile while its worker is frozen …`;
- `enginehomes.e2e.ts`: `claude model picker follows the login shell home`.

The daemon logs `dispatch models_list failed: Error: the core did not list the models (QUERY_FAILED)`. The run before
(`43902144004`, about 20 merges older) did not fail these.

## Cause

#4413 made the Claude Code runtime's `models()` (`cli/src/engines/claude/runtimeProfile.ts`) wait for
`listClaudeModels` (`cli/src/engines/claude/lists.ts`). It starts `claude -p … --input-format stream-json` and waits
up to **15 s** for its answer to an `initialize` control request. `models()` runs in the `engine-claude` worker, whose
answer the core waits for **5 s** (`RUNTIME_WAIT_MS`, `cli/src/engines/worker/runtimeProtocol.ts`). A Claude Code that
has not answered within 5 s fails the worker's read (`ENGINE_UNAVAILABLE`), so the core's `runtimeModels` rejects and
`models_list` fails. It does not fall back to the aliases, which is what `lists.ts` promises ("the caller keeps its own
short list then"). Worse, the worker that misses its deadline exits (`cli/src/engines/worker/runtimeRequests.ts:35`,
`process.exit(1)`), which kills the tied `claude -p` with it: the list never reaches the cache, so a Claude Code slower
than 5 s fails every ask, and every ask restarts `engine-claude`. In inline mode (`HARNESSD_SERVICES=none`) nothing
cuts the wait short, so `models_list` takes the whole 15 s.

A second constraint shapes the fix: the core sends one engine's runtime reads one at a time
(`cli/src/core/engines/runtimeSessions.ts:102-125`), not one per session. A models read that waits holds every Claude
agent's records, pane and config reads behind it, and a read queued for more than 5 s fails with `ENGINE_BUSY`. So
the wait must be short as well as bounded.

The e2e fake engine never answers `initialize`. It also treats `claude -p --input-format stream-json …` as an
interactive launch: it writes to the `launch-argv` ledger, creates a session and transcript, and runs the hooks in the
home's `settings.json`. Claude Code started that way (`--settings '{"disableAllHooks":true}'`,
`--no-session-persistence`, `--strict-mcp-config`) does none of these. So every Claude `models_list` in the suite
waits out the deadline. A real Claude Code that starts slowly (a cold start, many plugins, a slow disk) hits the same
failure: this is a product bug, which the fake shows every time.

Bisected: `b57b1c925c` (before #4413) passes these tests locally; `6e31e00202` fails them.

## Design

1. **`models()` waits for Claude Code's list for at most 1 s.** The read starts beside the `availableModels` read, so
   the second counts from the request's start. If the list has not come by then, `models()` answers from the aliases,
   as it does when Claude Code could not be asked. The read keeps going in the background, up to its own 15 s, and
   fills `lists.ts`'s cache (one read in flight per key, already), so a later ask gets the full list. Nothing is cached
   when the read fails, as today; while Claude Code cannot answer, an ask costs at most 1 s of the engine's queue.
   - Why 1 s and not more: the engine's reads queue behind it (above), and a fresh list is cached for 30 minutes, so
     only the first ask per Claude home, folder and version waits at all.
   - One timer, cleared when the list (or the unit tests' immediate `null`, `cli/vitest.setup.ts:113`) comes first.
     The background promise gets `.catch(() => null)`: the worker has no `unhandledRejection` guard.
   - Red test in `cli/src/lib/runtimeProfile.spec.ts` (where `models()` is covered today, with
     `vi.mocked(listClaudeModels)`): with `listClaudeModels` never resolving, `models()` answers the aliases once 1 s
     has passed (fake timers, `vi.advanceTimersByTimeAsync`); with it resolving within the bound, the listed rows.
   - Known edge, unchanged by this fix and not fixed here: a first ask can offer an alias (`fable@high`), and an
     `agent_update` checked after the list fills the cache is checked against the listed values
     (`cli/src/lib/runtimeControl.ts:147-151`); a value Claude Code lists only by its full id would be refused there.
     #4413 already had this edge whenever the list could not be read.
2. **The e2e fake engine answers `claude -p --input-format stream-json` as Claude Code does**
   (`cli/e2e/harness/fakeEngine.mjs`, a branch beside `claude plugin`: after the `--version`, `--help` and `without`
   checks, before the `launch-argv` line). It answers the `initialize` control request (`request_id: 'harness-lists'`)
   with `control_response` → `{ models, commands }`, and exits when its stdin ends. It writes no `launch-argv` line, no
   session, no transcript, and runs no hook. Its models are bare aliases, as Claude Code 2.1.x lists them on a
   subscription: `default`, `opus`, `sonnet`, `haiku`, each with `value`, `displayName`, `description`, and
   `supportsEffort` / `supportedEffortLevels` on the ones that take an effort (Haiku none). The suite's tests pick
   `sonnet@high`, `sonnet@low` and `sonnet@auto`, and `enginehomes.e2e.ts` expects no `haiku` under its
   `availableModels`, which the listed rows are filtered by already. This is a fidelity fix to the test harness, not a loosened
   test. With it, the e2e suite exercises the listed path that #4413 added, and the unit test covers the slow path.

No change to the core, the worker protocol, the deadline, `lists.ts`'s 15 s read or its cache. No change to
`listClaudeCommands` (the phone's `/` list): it runs in the models process, not under the worker's deadline.

## `eagerOpenCode.e2e.ts`: not this branch's

`agent_resume` answering `RESUME_UNCONFIRMED` in `eagerOpenCode.e2e.ts` is a load-dependent failure from #4356, not
#4413. It passed 4/4 runs alone both before #4413 (`b57b1c925c`) and at it (`6e31e00202`). Run beside
`engineReaders.e2e.ts` and `engineModelControl.e2e.ts` (`E2E_WORKERS=3`, two runs per commit, this Mac):

| Commit | `RESUME_UNCONFIRMED` (eagerOpenCode, or engineReaders' resume tests) |
|---|---|
| `3bde211303` (just before #4356) | 0 of 2 runs |
| `774858956e` (#4356) | 2 of 2 runs |
| `b57b1c925c` (just before #4413) | 2 of 2 runs (one of them eagerOpenCode v1, as on CI) |

#4356 ("Move registry lock waits and image preparation off the core loop") changed `resumeAgentService.ts`. Its fix is
in progress elsewhere (`fix/main-e2e-regressions`), so this branch leaves it alone (orchestrator, 2026-11-17).

## Out of scope

- `eagerOpenCode.e2e.ts`: see above.
- The other main failures being fixed elsewhere: the registry (#4356, on `fix/main-e2e-regressions`) and the viewers
  (#4390, PR #4417).
- Remembering a failed list read for a while, so that a Claude Code that never answers is not started again on every
  ask. It is a cost, not this failure; the final report proposes it.

## Verification

- Unit: the red-then-green spec above; `npm run test:core` is not affected (`src/engines/` is outside it), but the
  claude runtime and lists specs run.
- End to end, locally then on GitHub (`cli-e2e.yml`, with the PM's go): the Claude tests of `engineModelControl.e2e.ts`,
  `engineReaders.e2e.ts` and `enginehomes.e2e.ts` pass, and so do the other files that ask a Claude agent's models or
  read `launch-argv` (`models.e2e.ts`, `modelSwitch.e2e.ts`). The daemon log shows no `engine-claude` restart during a
  `models_list`.
- `compat.e2e.ts` runs only at release (`COMPAT_FROM`): listed rows carry `description` and Claude Code's names since
  #4413. Whether that needs a `CHANGED` entry is the release's check, and it is noted in the PR.
