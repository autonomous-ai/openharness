# Process tree walks visit each pid once (#4268): Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3**. Each task is two commits: the failing test,
> then the code that passes it. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every walk down a pane's or an engine's process tree ends and takes each pid once, so a parent-pid cycle
through the walk's root (Windows never re-parents and reuses pids) can no longer hang the daemon core or list a
process twice.

**Architecture:** Four walks each get a visited set of their own, as `processTreePids` already has: `rootOwner`,
`selectEngineProcess`, `engineDescendants`, `tmuxPaneProcessTree`. Each keeps its own skip rules and bounds; nothing
is shared, and no signature, export or import changes. Each fix has a test that fails first, in milliseconds, without
hanging the runner.

**Tech Stack:** TypeScript, vitest 4, run from `cli/`. No new dependency.

**Spec:** [docs/plans/2026-11-13-4268-process-tree-cycle-design.md](2026-11-13-4268-process-tree-cycle-design.md).
Read it with this plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority.

## Global Constraints

- Only the four walks change. Each gets its own `Set<number>` named `seen`: no shared walker, no new module.
- Unchanged, as the spec lists them: `processTreePids`, `daemonDescendants`, `measure` (`harnessResources.ts`),
  `generations` (`windows/treeKill.ts`), the ancestry walks in `core/engines/hooks.ts`, `windowsChain`, `ancestors`
  (`signOut.ts`), the one-level child reads. `paneEngineProcess.ts` does not change either.
- No walk returns anything else for a table without a cycle. No existing test is edited; tests are only added.
- The new tests use no sleep and no timer. A red run fails in milliseconds; one that does not return is a wrong test.
- No file is added to the core's process. The four source files are already lines of
  `cli/src/architecture.coreFiles.txt`; the two new files are specs.
- Each added check has a comment that says why and names #4268 (`cli/AGENTS.md` rule 7).
- Platforms: Windows is where a cycle can arise (`rootOwner`, `selectEngineProcess`); `engineDescendants` and
  `tmuxPaneProcessTree` run on macOS and Linux only. The walks are pure functions over rows, the same on each.
- Locally, run only the spec files a task names, from `cli/`: `npx vitest run <file>`. Never a whole suite.

## Found while reading the code

Checked at the branch base `9dc73beea2` and at PR #4266's head `4e87544d71` (open and mergeable on 2026-11-13). Every
test below was run on a copy of that head: red without the change, green with it.

- **#4266 touches one of the four files.** `terminalAgentDiscovery.ts` only. `processTable.ts`, `processTree.ts`,
  `tmux.ts` and their specs are identical at both commits.
- **#4266's additions hold once `rootOwner` takes each pid once; no other line changes.** `processes` gets a row per
  visit, so the skip must sit above `if (row) processes.push(row)`. `ancestors` climbs `shallowest` parents from the
  engine: breadth first with a visited set, `shallowest` is the fewest steps from the root, so the climb ends at the
  root and passes no pid twice. The union across panes is keyed by pid. No other file of #4266 adds a walk
  (`paneEngineProcess.ts` filters by `processTreePids`).
- **A red test for a walk with no end.** `rootOwner` and `selectEngineProcess` read a visited row's `args` on every
  visit (55 times and 3 times: `engineProcessMatchScore`). A cycle row whose `args` getter throws past 10,000 reads
  ends the unfixed walk in about 25 ms.
- **`engineDescendants` starts at the engine,** so only a cycle through the engine reaches it: its test gives the
  engine a parent pid that names its own child. A cycle above the engine never enters this walk.
- **`tmuxPaneProcessTree` has no spec today.** Its one caller is `cli/scripts/resume-native-e2e.ts`. Its test mocks
  `tmux display-message` as `tmux.paneLookup.spec.ts` does and gives rows through `setProcessTableSource`.
- **Numbers (code standard 4, discovery is idle daemon work).** `discoverTerminalAgentsFromSnapshot` over 20 panes
  of 6 processes each, median of 15 rounds of 200 passes, Mac, Node 23.11: 2.03 to 2.07 ms a pass before, 2.04 to
  2.07 ms after. The set costs nothing that can be measured. The pull request quotes these.
- **Required local checks:** `python3 scripts/local-checks.py --list` with the eight paths below prints `{}`.

## Before the first task

Once, before any task starts (the tasks may then all run at the same time):

- The branch is rebased onto an `origin/main` that holds #4266:
  `grep -c "paneProcesses" cli/src/lib/terminalAgentDiscovery.ts` prints a number above 0. If it prints 0, stop.
- `cli/node_modules` exists (it does not in this worktree today): `npm ci --no-audit --no-fund` in `cli/`.

## Review Focus

Inputs the spec implies beyond its one test shape; each is pinned by the test named.

- The root's parent names a deeper descendant (a three-row cycle), not its child: the same result. Second row of
  each `it.each`: the engine itself in Tasks 1, 2 and 4, a grandchild in Task 3.
- Two panes whose roots both sit on the cycle see one engine: one agent, the nearer pane first, each parent named
  once in the union. Task 1, second test.
- A repeated pid must not use up `tmuxPaneProcessTree`'s limit of 4: the engine below is still listed. Task 4.
- `engineDescendants` never lists the engine as its own tree to stop, and still leaves out a Hermes gateway and a
  Codex shared server below an engine on the cycle. Task 3 (its table holds both).
- A pane root that has no row in the table still starts the walk: the set holds pids, not rows. Already pinned by
  #4266's "stop at the last row the table has when the pane's root is not in it"; Task 1 step 5 runs it.

---

### Task 1: `rootOwner` takes each pid once

**Depends on:** nothing. **Effort:** high (written on #4266's code, which is not on the branch yet).
**Core:** `lib/terminalAgentDiscovery.ts` is loaded by the daemon core and already listed; no line is added.

**Files:**
- Modify: `cli/src/lib/terminalAgentDiscovery.ts` (`rootOwner`)
- Create (test): `cli/src/lib/terminalAgentDiscovery.cycle.spec.ts`

- [ ] **Step 1: Write the failing test**, the whole new file:

```ts
/**
 * A pane root whose parent pid names one of its own descendants (#4268). Windows never re-parents a process and
 * reuses pids, so the pid of a root's dead parent can go to a process the root started: the parent-to-children map
 * then has a cycle through the root. The walk down the pane had no end, in the daemon core, on every discovery pass.
 */
import { describe, expect, it } from 'vitest'
import type { ProcessRow } from './processTable.js'
import { discoverTerminalAgentsFromSnapshot } from './terminalAgentDiscovery.js'
import { terminalPlacementKey, terminalRouteKey } from './terminalRuntime.js'
import type { TerminalRootObservation } from './terminalTypes.js'

const row = (pid: number, parentPid: number, executable: string): ProcessRow =>
  ({ pid, parentPid, executable, startMarker: `w:${pid}`, args: executable })
const id = (process: ProcessRow) => ({ pid: process.pid, executable: process.executable, startMarker: process.startMarker })
const pane = (paneId: string, rootPid: number): TerminalRootObservation =>
  ({ runtime: { backend: 'ptyhost', instance: 'default', paneId }, rootPid, cwd: 'C:\\work' })

/**
 * [process], throwing once its command line was read 10,000 times: one visit reads it 55 times (each engine's match).
 * A walk with no end is synchronous, so it would hold the runner's own timeout too and the test would never fail.
 */
function counted(process: ProcessRow): ProcessRow {
  let reads = 0
  return Object.defineProperty({ ...process }, 'args', {
    enumerable: true,
    get: () => {
      if (++reads > 10_000) throw new Error(`pid ${process.pid} was read ${reads} times: the walk does not end`)
      return process.args
    },
  })
}

const ROOT = row(10, 1, 'cmd.exe')
const SHELL = row(11, 10, 'powershell.exe')
const CLAUDE = row(12, 11, 'claude.exe')
/** What discovery finds for [roots] when the table says the root's parent is [rootParent]. */
const discover = (roots: TerminalRootObservation[], rootParent: number) =>
  discoverTerminalAgentsFromSnapshot(roots, [counted({ ...ROOT, parentPid: rootParent }), SHELL, CLAUDE], 999, ['ptyhost'])
const listed = (found: ReturnType<typeof discover>, paneId: string) =>
  found.paneProcesses.get(terminalPlacementKey(pane(paneId, 0).runtime))?.map((process) => process.pid)

describe('a pane root whose parent pid names one of its own descendants', () => {
  it.each([
    ['its child', SHELL.pid],
    ['the engine below', CLAUDE.pid],
  ])('holds what it holds without the cycle: %s', (_name, rootParent) => {
    const cycle = discover([pane('p1', 10)], rootParent)
    const plain = discover([pane('p1', 10)], ROOT.parentPid)
    expect(cycle.agents.map((agent) => agent.processIdentity.pid)).toEqual([CLAUDE.pid])
    expect(cycle.agents).toEqual(plain.agents)
    expect(cycle.ambiguousPlacements).toEqual(plain.ambiguousPlacements)
    // #4266's lists: each process of the pane once, and the engine's parents up to the root, each once.
    expect(listed(cycle, 'p1')).toEqual([10, 11, 12])
    expect(cycle.agents[0].formerProcesses).toEqual([id(SHELL), id(ROOT)])
  })

  it('names each parent once for an engine two panes on the cycle see, the nearer pane first', () => {
    const found = discover([pane('p1', 10), pane('p2', 11)], SHELL.pid)
    expect(found.agents).toHaveLength(1)
    expect(found.agents[0].primaryRuntimeKey).toBe(terminalRouteKey(pane('p2', 11).runtime))
    expect(found.agents[0].formerProcesses).toEqual([id(SHELL), id(ROOT)])
    expect(listed(found, 'p1')).toEqual([10, 11, 12])
    // The inner pane's root is the shell, and the table says the outer root is its child.
    expect(listed(found, 'p2')).toEqual([11, 10, 12])
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run src/lib/terminalAgentDiscovery.cycle.spec.ts`
Expected, within a second: 3 failed, each with `Error: pid 10 was read 10001 times: the walk does not end`.

- [ ] **Step 3: Commit the red test**

```bash
git add cli/src/lib/terminalAgentDiscovery.cycle.spec.ts
git commit -m "Test: discovery's walk ends under a pane root whose parent is its own descendant (#4268)"
```

- [ ] **Step 4: Take each pid once in `rootOwner`**

Declare `const seen = new Set<number>()` beside `processes`. As the first statements of the loop body, right after
`const current = queue.shift()!`: `continue` for a `current.pid` in `seen`, else add it. The skip sits above
`if (row) processes.push(row)`, so a pid is listed, matched and has its children queued once. The comment above it
says why: Windows never re-parents and reuses pids, so a root's parent pid can name its own descendant, and this walk
then had no end, in the core, on every pass (#4268).

If `rootOwner` on the rebased branch differs from #4266's head, keep that rule and the test as written. If a
`listed` or `formerProcesses` assertion still fails with the set in place, the cause is the climb to `ancestors` or
the union in `discoverTerminalAgentsFromSnapshot`: fix it in this file, in this commit, and say so in the report
(spec, "Order with #4266"). At #4266's head neither needs a change.

- [ ] **Step 5: Run the discovery specs and see them pass**

Run: `npx vitest run src/lib/terminalAgentDiscovery`
Expected: every file passes, the new one with 3 tests (9 files, 145 tests at #4266's head).

- [ ] **Step 6: Commit the code**

```bash
git add cli/src/lib/terminalAgentDiscovery.ts
git commit -m "Discovery: the walk down a pane takes each pid once (#4268)"
```

Report both commits, and the red (Step 2) and green (Step 5) outputs.

---

### Task 2: `selectEngineProcess` takes each pid once

**Depends on:** nothing. **Effort:** medium.
**Core:** `lib/processTable.ts` is loaded by the daemon core and already listed; no line is added.

**Files:**
- Modify: `cli/src/lib/processTable.ts` (`selectEngineProcess`, line 813)
- Modify (test): `cli/src/lib/windows/engineProcessMatch.spec.ts`

- [ ] **Step 1: Write the failing test**, in `describe('engine recognition on Windows')`, after
  `'finds OpenCode under its npm shim, from a pane and from PowerShell'` (line 83), which pins the same rows without
  a cycle at pid 1972:

```ts
  // Windows never re-parents a process and reuses pids: the pid of the root's dead parent can go to a process the
  // root started, and the walk down the pane had no end (#4268).
  it.each([
    ['its child', 10336],
    ['the engine below', 1972],
  ])('finds the engine below a pane root whose parent pid names %s, as below any other root', (_name, rootParent) => {
    const [powershell, cmd, engine] = opencodeFromPowerShell
    // One visit reads the row's command line 3 times. A walk with no end is synchronous: it would hold the runner's
    // own timeout too, so the row ends it.
    let reads = 0
    const root = Object.defineProperty({ ...powershell, parentPid: rootParent }, 'args', {
      enumerable: true,
      get: () => {
        if (++reads > 10_000) throw new Error(`pid ${powershell.pid} was read ${reads} times: the walk does not end`)
        return powershell.args
      },
    })
    expect(selectEngineProcess([root, cmd, engine], powershell.pid, 'opencode')?.pid).toBe(1972)
  })
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run src/lib/windows/engineProcessMatch.spec.ts`
Expected, within a second: 2 failed with `Error: pid 6896 was read 10001 times: the walk does not end`, 11 passed.

- [ ] **Step 3: Commit the red test**

```bash
git add cli/src/lib/windows/engineProcessMatch.spec.ts
git commit -m "Test: the engine lookup ends under a pane root whose parent is its own descendant (#4268)"
```

- [ ] **Step 4: Take each pid once in `selectEngineProcess`**

Declare `const seen = new Set<number>()` beside `queue`. Right after `const current = queue.shift()!`: `continue`
for a `current.pid` in `seen`, else add it, before the row is scored or its children queued. The comment says why,
as in the spec's Intent, and names #4268.

- [ ] **Step 5: Run the specs of `selectEngineProcess` and see them pass**

Run: `npx vitest run src/lib/windows/engineProcessMatch.spec.ts src/lib/processTable.hermesGateway.spec.ts src/lib/paneEngineProcess.spec.ts`
Expected: 3 files pass (39 tests at #4266's head; 13 in `engineProcessMatch.spec.ts`).

- [ ] **Step 6: Commit the code**

```bash
git add cli/src/lib/processTable.ts
git commit -m "Engine lookup: the walk down a pane takes each pid once (#4268)"
```

Report both commits, and the red and green outputs.

---

### Task 3: `engineDescendants` lists each process once, never the engine

**Depends on:** nothing. **Effort:** medium.
**Core:** `lib/processTree.ts` is loaded by the daemon core and already listed; no line is added.

**Files:**
- Modify: `cli/src/lib/processTree.ts` (`engineDescendants`, line 53)
- Modify (test): `cli/src/lib/processTree.spec.ts`

- [ ] **Step 1: Write the failing test**, in `describe('an engine\'s process tree')`, before
  `'stops at 1024 processes'` (line 84). The walk starts at the engine, so the cycle runs through the engine (pid 500
  of `PS`); `'walks down from the engine in one read, …'` pins the same table without a cycle at `[501, 502]`:

```ts
  // A `ps` table rarely says so, but the walk is discovery's (#4268): it listed the engine itself as its tree to stop,
  // and the same processes again up to the limit.
  it.each([
    ['its child', 501],
    ['a grandchild', 502],
  ])('lists each process once, and never the engine, when the engine\'s parent pid names %s', async (_name, parent) => {
    const cycle = PS.replace('  500   499   500 ', `  500   ${parent}   500 `)
    const found = await engineDescendants(ENGINE, 'darwin', async () => cycle)
    expect(found!.map((p) => p.pid)).toEqual([501, 502])
  })
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run src/lib/processTree.spec.ts`
Expected: 2 failed with `expected [ 501, 500, 502, 501, 500, …(1019) ] to deeply equal [ 501, 502 ]` (the second
starts `[ 501, 502, 500, …`), 7 passed.

- [ ] **Step 3: Commit the red test**

```bash
git add cli/src/lib/processTree.spec.ts
git commit -m "Test: an engine's tree names no process twice when its parent is its own descendant (#4268)"
```

- [ ] **Step 4: Take each pid once in `engineDescendants`**

Declare `const seen = new Set([root.pid])` beside `queue`: the engine is never in its own tree. Right after
`const row = queue[next]!`: `continue` for a `row.pid` in `seen`, else add it, above the shared-server check, so no
row is listed or descended into twice. The comment says why and names #4268.

- [ ] **Step 5: Run the spec and see it pass**

Run: `npx vitest run src/lib/processTree.spec.ts`
Expected: 9 passed (on Windows the "real processes" case is skipped).

- [ ] **Step 6: Commit the code**

```bash
git add cli/src/lib/processTree.ts
git commit -m "Stop: an engine's tree lists each process once, never the engine (#4268)"
```

Report both commits, and the red and green outputs.

---

### Task 4: `tmuxPaneProcessTree` takes each pid once

**Depends on:** nothing. **Effort:** medium.
**Core:** `lib/tmux.ts` is loaded by the daemon core and already listed; no line is added.

**Files:**
- Modify: `cli/src/lib/tmux.ts` (`tmuxPaneProcessTree`, line 194)
- Create (test): `cli/src/lib/tmux.paneProcessTree.spec.ts`

- [ ] **Step 1: Write the failing test**, the whole new file:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessRow } from './processTable.js'

// `tmux display-message` names the pane's root, pid 10; the process table is the test's own rows.
vi.mock('child_process', async (real) => {
  const actual = await real<typeof import('child_process')>()
  return {
    ...actual,
    execFile: (file: string, args: string[], _options: unknown, done: (err: Error | null, stdout: string, stderr: string) => void) => {
      if (file === 'tmux' && args[0] === 'display-message') { queueMicrotask(() => done(null, '10\n', '')); return {} }
      return (actual.execFile as unknown as (...a: unknown[]) => unknown)(file, args, _options, done)
    },
  }
})

const { setProcessTableSource } = await import('./processTable.js')
const { tmuxPaneProcessTree } = await import('./tmux.js')

const row = (pid: number, parentPid: number, executable: string): ProcessRow =>
  ({ pid, parentPid, executable, startMarker: 'Fri Nov 13 10:00:00 2026', args: executable })
/** The pane's tree when the table says the root's parent is [rootParent]: the root, a launcher, the engine below. */
const tree = (rootParent: number) => {
  setProcessTableSource(async () => [row(10, rootParent, 'zsh'), row(11, 10, 'node'), row(12, 11, 'claude')])
  return tmuxPaneProcessTree('%1')
}

describe('the processes under a pane', () => {
  afterEach(() => setProcessTableSource(null))

  // The same walk as discovery's (#4268): the root was listed again, in place of a process below it.
  it.each([
    ['its child', 11],
    ['the engine below', 12],
  ])('are each listed once when the root\'s parent pid names %s', async (_name, rootParent) => {
    const cycle = await tree(rootParent)
    expect(cycle.map((process) => process.executable)).toEqual(['zsh', 'node', 'claude'])
    expect(cycle).toEqual(await tree(1))
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run src/lib/tmux.paneProcessTree.spec.ts`
Expected: 2 failed, with `expected [ 'zsh', 'node', 'zsh', 'claude' ] to deeply equal [ 'zsh', 'node', 'claude' ]`
and `expected [ 'zsh', 'node', 'claude', 'zsh' ] …`.

- [ ] **Step 3: Commit the red test**

```bash
git add cli/src/lib/tmux.paneProcessTree.spec.ts
git commit -m "Test: a pane's process list names no process twice when the root's parent is its own descendant (#4268)"
```

- [ ] **Step 4: Take each pid once in `tmuxPaneProcessTree`**

Declare `const seen = new Set<number>()` beside `queue`. Right after `const pid = queue.shift()!`: `continue` for a
`pid` in `seen`, else add it, before the row is listed or its children queued. The comment says why and names #4268.

- [ ] **Step 5: Run the spec and see it pass**

Run: `npx vitest run src/lib/tmux.paneProcessTree.spec.ts`
Expected: 2 passed.

- [ ] **Step 6: Commit the code**

```bash
git add cli/src/lib/tmux.ts
git commit -m "tmux: a pane's process list takes each pid once (#4268)"
```

Report both commits, and the red and green outputs.

---

## Verification

**End-to-end checks: none.** A cycle needs a pane root's parent to exit and Windows to hand that pid to one of the
root's own descendants; no machine, VM or test account can be made to do that on demand, and the issue was found by
reading the code. The four walks are pure functions over process rows, and the unit tests give them exactly those
rows. So there is no build to install, no backend, account, device, port or state directory, nothing for Ken to look
at, nothing against production, and no temporary workflow: the checks below take seconds and PR CI runs them.

On the final head, on the Mac, from `cli/`:

1. **Typecheck:** `npm run typecheck`. A person sees no output and exit 0.
2. **The specs of the four walks, and the core's file list:**
   `npx vitest run src/lib/terminalAgentDiscovery src/lib/windows/engineProcessMatch.spec.ts src/lib/processTable.hermesGateway.spec.ts src/lib/paneEngineProcess.spec.ts src/lib/processTree.spec.ts src/lib/tmux.paneProcessTree.spec.ts src/architecture.spec.ts`.
   A person sees every file pass in about 4 s (15 files, 220 tests at #4266's head); `architecture.spec.ts` passing
   means no file joined the core's process.
3. **Required local checks:** from the repository root,
   `python3 scripts/local-checks.py --list cli/src/lib/terminalAgentDiscovery.ts cli/src/lib/terminalAgentDiscovery.cycle.spec.ts cli/src/lib/processTable.ts cli/src/lib/windows/engineProcessMatch.spec.ts cli/src/lib/processTree.ts cli/src/lib/processTree.spec.ts cli/src/lib/tmux.ts cli/src/lib/tmux.paneProcessTree.spec.ts`.
   A person sees `{}`: no local receipt is required, so the pull request body carries no `harness-local-checks`
   fence. `npm run test:core` and `npm run test:harnessd` are not run: no file under `src/core/`, `src/services/` or
   `src/harnessd/` changes.

On GitHub, the push starts PR CI by itself: `cli-typecheck` and `cli-tests` (the whole unit suite on Linux, the new
cases among them) under `ci/required`. Start no manual run beside it. The on-demand **Windows** workflow would run
Task 2's case on Windows runners (`src/lib/windows`), but it builds and contract-tests the PTY host, and these walks
start no process and read no platform: it is not run for this change.

The pull request carries, per task, the red and the green output with the commit each ran on, the numbers above, and
the platforms line of Global Constraints.
