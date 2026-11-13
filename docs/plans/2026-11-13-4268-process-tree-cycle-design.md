# Process tree walks visit each pid once (#4268)

## Intent

A walk down a pane's process tree must end, whatever the process table says. On Windows a process is never re-parented
and pids are reused, so a row's `parentPid` can name one of its own descendants: the `parentPid → children` map then
has a cycle. A breadth-first walk with no visited set never empties its queue. Discovery's walk (`rootOwner`) runs
synchronously in the daemon core on every pass, so one such cycle blocks the core's event loop for good; the pass
deadline (`RECONCILE_PASS_DEADLINE_MS`) cannot cut a synchronous loop. Not seen in the field; found by reading the code.

A cycle reachable from a walk's root always runs through the root: every row on a cycle has its parent on the cycle,
and a row reached from the root has the root among its ancestors. So the case is a pane root whose `parentPid` is
one of its own descendants (its parent exited and the pid went to a process the root started).

## Goals

- Every walk over a pane's (or an engine's) process tree visits a pid at most once, as `processTreePids`
  (`cli/src/lib/processTable.ts`) does already.
- With a cycle, each walk returns what it returns for the same tree without the cycle: the same engine, the same
  processes, no pid twice.

## Non-goals

- No shared walker or new module: each walk keeps its own rules (what it skips, where it stops, its bound).
- No change to the walks that are already safe: `processTreePids`, `daemonDescendants`
  (`terminalAgentDiscovery.ts`), `measure` (`harnessResources.ts`), `generations` (`windows/treeKill.ts`), the
  ancestry walks in `core/engines/hooks.ts`, `windowsChain` (`callerPane.ts`), `ancestors` (`signOut.ts`, bounded by
  depth), and the one-level child reads (`processEvidence.ts`, `windows/gitBashTree.ts`).
- No change to what any walk picks when the table has no cycle.

## The walks with the same cause

| Walk | File | Today with a cycle |
|---|---|---|
| `rootOwner` | `cli/src/lib/terminalAgentDiscovery.ts` | never ends: the core hangs (every discovery pass) |
| `selectEngineProcess` | `cli/src/lib/processTable.ts` | never ends: hangs its caller (`paneEngineProcess.ts`) |
| `engineDescendants` | `cli/src/lib/processTree.ts` | ends at `TREE_LIMIT` (1024) rows, but lists the same pids again, the engine's own pid among them, as its tree to stop |
| `tmuxPaneProcessTree` | `cli/src/lib/tmux.ts` | ends at its `limit`, but repeats the same processes in the diagnosis |

`engineDescendants` and `tmuxPaneProcessTree` do not run on Windows, and a Unix `ps` snapshot rarely shows a cycle,
but they have the same missing visited set, so they get the same fix (Ken: cover every walk of the same cause).

## Approaches

1. **A visited set in each walk (chosen).** Each of the four walks keeps a `Set<number>` of pids it has taken and
   skips one it has seen, as `processTreePids` does. Four small edits; each walk keeps its own skip rules and bounds.
2. **One shared breadth-first walker** that all walks call. Rejected: the walks differ in what they skip
   (`daemonDescendants` stops at pane roots, `engineDescendants` neither lists nor descends into shared servers,
   `rootOwner` descends through excluded rows), so the walker would need options for each, a larger change than the
   bug, in files the core loads.

## Design

- `rootOwner`: a pid already taken is skipped before it is matched or its children queued. The root is seen at
  depth 0, so the depths, the shallowest match, and #4266's `processes` list and parent chain are what they are
  without the cycle.
- `selectEngineProcess`: the same; depths and the chosen engine are unchanged.
- `engineDescendants`: the engine's own pid starts as seen, and a row already seen is not listed or descended into
  again; the tree never holds the engine or a pid twice.
- `tmuxPaneProcessTree`: the pane root starts the walk; a pid already seen is skipped.

## Tests

Each walk gets a test that fails before the fix (without hanging the runner, see below), then passes:

- the pane root's `parentPid` names its child (two rows whose `parentPid` point at each other), and the engine sits
  below them;
- the walk returns, and returns what it returns for the same rows with the root's `parentPid` set to 1: the same
  engine for `rootOwner` (through `discoverTerminalAgentsFromSnapshot`) and `selectEngineProcess`, the same tree for
  `engineDescendants`, the same processes for `tmuxPaneProcessTree`.

## Order with #4266

PR #4266 (#4259) changes `rootOwner` (its `processes` list and the chosen engine's parent chain). This branch is
rebased onto `origin/main` after #4266 merges and before implementation, so the fix is written on top of it.
After the rebase, the walks #4266 adds (the pane's `processes` list, the chosen engine's in-pane parent chain
`ancestors`, and the union of those chains across panes) are checked against the same cycle: the `rootOwner` test
also checks that `processes` holds no pid twice and that `ancestors` ends at the root with no pid twice. Any of them
that does not hold is fixed in the same task.

## Left to the builder

- Which spec file each test goes in (beside each walk's existing tests).
- How the red test of a walk that never ends fails instead of hanging the runner: a synchronous loop blocks the
  test's own timeout too. For example a row of the cycle whose field getter counts its reads and throws past a
  bound far above one visit (each walk reads its rows' fields on every visit). No fixed sleeps.
