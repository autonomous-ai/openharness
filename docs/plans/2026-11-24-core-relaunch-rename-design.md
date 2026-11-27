# A relaunch publishes an engine that named itself after the last look

Date: 2026-11-24. Branch: `fix/core-relaunch-engine-rename`. Component: CLI daemon core (`cli/`).

## Problem

A restart, a retarget, a move, a resume and a restore each relaunch an engine in a pane, wait for its process, then
publish it with `registry.confirmLaunch`. The publication's `refresh` reads the pane again and refuses unless the
process has the same pid, the same start time **and** the same `executable`.

A Node engine started through `#!/usr/bin/env node` (Claude Code installed with npm) starts as `node` and renames itself
(`process.title`) while it settles. #4584 made `waitForProcess` return the later of its two looks, which covers a rename
between the looks. A rename after the second look, before the refresh (a slow machine), still makes the refresh throw
`IdentityReadUnavailable` ("the replacement process changed before publication"). Nothing is written: the row keeps the
old, dead pid, the restart answers INTERNAL, and discovery creates a second agent for the pane about 1.5 s later.

Create does not fail this way: its watcher (`core/agents/newPane.ts`) catches the changed pane and looks again.

### Where the rename is seen (measured 2026-11-24, on processes the probe started)

| Platform | Launch | `executable` before → after `process.title = 'claude'` |
|---|---|---|
| Linux (Debian, node 22) | `#!/usr/bin/env node` script | `node` → `claude` (`/proc/<pid>/comm` and `ps -o comm=`) |
| Linux | `#!/abs/path/node` script (the e2e fake engine's shim, `e2e/harness/daemon.ts` `fakeEngineShim`) | `codex` → `codex` + padding, which `parseProcessRow`'s lazy match trims: unchanged |
| macOS 26 | either | the node binary's path, unchanged (the title does not reach `comm`) |
| Windows | any | the image name, unchanged (the title does not reach it) |

So the failure, and this fix, are Linux's; macOS and Windows never see the executable change and keep working as
today. The rule is written platform-free (`programName` reads `node.exe` as `node`) so it holds wherever a title does
reach the executable. The e2e fake engine never shows `node` first, so no end-to-end test can show this rename (below).

Not covered: an engine whose Node wrapper starts a separate child (a Codex npm wrapper and its native binary): those are
two pids, and a different pid is never the same process.

## The same cause, everywhere it occurs

| Site | Operation | Check today |
|---|---|---|
| `core/agents/restart.ts` `commitRelaunchedEngine` | restart; a move's fallback to its old pane (`core/agents/hostMove.ts` `relaunchOld`) | no engine → `NO_ENGINE`; other pid, start or executable → `ANOTHER_PROCESS` |
| `core/agents/retarget.ts` (~line 322) | retarget onto or off a grid | pid, start, executable |
| `core/agents/hostMove.ts` `swap` (~line 125) | a move's destination pane | pid, start, executable |
| `lib/resumeAgentService.ts` (~line 155) | resume of a stopped agent | pid, start, executable |
| `lib/restoreAgents.ts` (~line 946) | a restored agent's relaunch, published at first sight; a refused refresh there ends the watch ("watch failed"), skipping its settle window, fresh-relaunch fallback and hold release | pid, start, executable |
| `core/agents/discovery.ts` (~line 84) | discovery's own publication | left as it is: a refused publication is read again on discovery's next pass |

Restart's terminal branch (no identity: the pane's shell is checked, `NO_SHELL`) is not a process publication and stays
as it is.

## Rule (decided by the orchestrator, 2026-11-24)

A refresh accepts the process it sees as **the recorded engine, renamed** only when all hold:

1. the same pid and the same start time (`sameProcessIdentity`);
2. the recorded `executable` is a Node runtime: its program name (`programName`, `lib/processTable.ts`) is `node` or
   `nodejs` (`node.exe` reads as `node`);
3. the observed `executable`'s program name is not a Node runtime;
4. the observed process is the one the pane's engine lookup selects for the row's engine, which every refresh already
   reads it through (`resolvePaneEngineProcess`; hostMove's and restore's `probeProcess` are the same lookup,
   `restoreTerminals.ts`).

A different pid, a different start time, or a change from anything other than a Node runtime (`/bin/claude` to `other`)
is refused as today. Clause 2 also bounds the re-write: once published, the identity is no longer a Node runtime's, so
a second rename never matches.

## Design

One shared piece in `lib/paneEngineProcess.ts` (already in the core's file list, `architecture.coreFiles.txt`; it
already imports `processTable` and `registry`, and `engines/kit/identityScan.ts` imports only `node:fs`: no cycle, no new
core file):

- `renamedEngine(recorded, observed): boolean`: clauses 1-3.
- `EngineRenamed extends IdentityReadUnavailable` (as `newPane.ts`'s `PaneChanged` does), carrying the observed
  identity. If it ever escapes, callers that treat `IdentityReadUnavailable` as "held" keep doing so; the registry
  passes it through (`persistenceFailure`).
- `publishEngine(identity, look, reasons, publish)`, where `reasons` is `{ gone, changed }`: it computes
  `expires = performance.now() + REGISTRY_WRITE_DEADLINE_MS` once, then runs `publish(identity, refresh, expires)`.
  `refresh` calls `look()`: no process → `IdentityReadUnavailable(reasons.gone)`; the same pid, start and executable →
  passes; `renamedEngine` → `EngineRenamed(observed)`; anything else → `IdentityReadUnavailable(reasons.changed)`. On
  `EngineRenamed` it calls `publish` **once more** with the observed identity and the same `expires`; that write's
  refresh checks again against the renamed identity, so any further change is refused. No wait between the two: the
  refresh has just looked. It returns the publication it got, so each caller keeps its own handling of the result.

Each site passes its existing reason words (restart keeps `NO_ENGINE` and `ANOTHER_PROCESS`, so `HELD_BY` still names
the check; sites with one reason pass it for both) and its existing `confirmLaunch` call as `publish`, adding `expires`
to the authority it passes (none of the four sites passes one today; restore already computes its own `expires`, which
`publishEngine` takes in place of its default, so the re-write shares restore's budget too; newPane-style retries on
`RegistryOwnershipChanged` inside a site stay as they are). A re-write logs one fixed line, `[<operation>] publication ·
engine renamed`, with the agent's short id as the site's other lines do and nothing else (no executable, no pid).

**Registry and its lock.** Both writes go through `registry.confirmLaunch` and so through the existing persistence and
its cross-process lock. The refresh runs inside the lock after the registry image is prepared (a temp file written and
fsynced, `registry.ts` ~3597-3600) and before it is installed: a refused refresh leaves nothing durable (the temp file is
discarded) but has spent one prepare out of the budget. The shared `expires` means the re-write never extends the
budget (`RegistryAuthority.expires`: "retries never renew it"; #4593's lock budget semantics unchanged). A re-write that
runs out of the budget propagates the registry's own error unchanged (`RegistryPersistenceUnavailable`), which each site
handles as it handles that error from its first write today (orchestrator, 2026-11-24), and a test covers it.

**Ownership on the second write.** `confirmLaunch` builds its owners list from the unchanged row plus the requested
identity (`registry.ts` ~1994), so the renamed identity is accepted as owner. Restart's `current` and
`matchesLaunchReceipt`, `swap.ts`'s `ownsOriginal` (the original row's identity) and hostMove's `owns` (`recorded`
until confirmed) compare snapshots the first write did not change; resume's `confirmedResume` compares the new row.
hostMove's swap sends `runtimes` again, harmless since the first write never landed.

**After publication.** A rename that lands after the publication is not this fix's: discovery's next pass, while the
route is no longer held, writes the pane's current identity (`registry.updateProcessIdentity`, `discovery.ts` ~250), as
it does today. Until then, the checks that compare the row's `executable` (`core/engines/nativeControls.ts`,
`lib/processEvidence.ts`, `core/agents/forget.ts`, `lib/stoppedAgents.ts`) see the old name, as today.

**Core rules.** Identity correctness of the core's own sessions only: no new file, list, record or setting; the only
list is the two Node runtime names the rule needs, beside the existing `programName`.

**Measures.** The fixed log line is the measure (count of re-writes per operation); no content or identifier.

## Tests (red first, at the layer where the behavior lives)

- `lib/paneEngineProcess.spec.ts`: `renamedEngine` for node→claude, nodejs→codex, `/usr/bin/node`→claude,
  node.exe→claude.exe, same executable, a different pid, a different start, `/bin/claude`→`other`, node→node,
  claude→node. `publishEngine`: same process publishes once; a rename publishes twice, the second with the observed
  identity and the same `expires`; a second rename on the re-write is refused with `reasons.changed`; no process →
  `reasons.gone`; a different pid → `reasons.changed`; a failed re-write (deadline) propagates.
- `core/agents/restart.spec.ts`: the refresh sees node→claude: published with the new executable, announced, hold
  released, one fixed log line; `replaced`, `gone` and `/bin/claude`→`other` still held with their `HELD_BY` words.
- `core/agents/retarget.spec.ts`, `core/agents/hostMove.spec.ts` (swap and `relaunchOld`),
  `lib/resumeAgentService.spec.ts`, `lib/restoreAgents.spec.ts`: the same rename between the look and the refresh
  publishes with the new executable; a changed pid or start is still refused.
- Gates: `npm run test:core` (100% per file, src/core) and `npm run test:resume` (100%, includes
  `resumeAgentService.ts`); the unit suite for `paneEngineProcess` and `restoreAgents`.

No new end-to-end test: the e2e fake engine never starts as `node` (table above), and the window between the second look
and the refresh cannot be hit deterministically (a timed rename would be a flaky test), so the behavior is proven at the
unit layer above.

## Verification

- `npm run test:core` and `npm run test:resume` before the push; `npm run typecheck`.
- On this Mac, with the PM's e2e turn: `e2e/stall.e2e.ts`, the restart, retarget and resume end-to-end files, and
  `e2e/restoreInput.e2e.ts` and `e2e/adopt.e2e.ts` for restore stay green (fake engines only, `TMPDIR=/tmp`).
- The same files once on Linux, run by hand: Actions → CI → Run workflow, `scope=linux-e2e`, `e2e_files` (PR CI runs
  only the e2e files a PR changes, and Linux is the one platform whose behavior changes), with the PM's turn for heavy
  workflows.
- PR CI's full suites (Linux, macOS, Windows) on the head.

## Out of scope

- Discovery's publication and create's watcher (both already look again).
- A rename that is not from a Node runtime; a Node wrapper with a separate child process.
- A rename after publication (discovery repairs it, as today).
