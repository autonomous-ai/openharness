# An agent whose bound process execs into another name stays tracked (#4259): Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3**. Each task commits its failing test, then the
> code; Task 4 is temporary and is one commit. A task starts as soon as the tasks it depends on are done and no running
> task shares its files. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent launched through a wrapper that `exec`s into another process name is no longer reported stopped
while it runs: it stays while the process Harness bound is alive in its pane, and moves to the real engine process
below it with the same agent id, session and name.

**Architecture:** The probe (`terminalAgentDiscovery.ts`) says two more things about each pane from the process table
it already reads: every process in the pane's tree, and, for the pane's engine, its ancestors inside the pane as
`formerProcesses`. The reconciler counts no engine miss for an agent whose recorded process is among its pane's
processes; its existing `formerProcesses` match then re-records the agent to the engine below. Restore and the two
backends' `validate` ask the same question through the pane lookup they already make (`lookupPaneEngineProcess`),
which now names the pane's processes when no engine is among them. The question itself is one function,
`processAmong` (`terminalRuntime.ts`), used by all four.

**Tech Stack:** TypeScript, Vitest. No Rust (nothing under `pty/` or `term/`), no new dependency, file in the core's
process, setting or process.

**Spec:** [docs/plans/2026-11-13-4259-wrapper-exec-design.md](2026-11-13-4259-wrapper-exec-design.md). Read it with
this plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority.

## Global Constraints

- No time-based grace, no new setting, no change to `MISS_LIMIT` (2).
- Identity is pid plus start, compared with `sameProcessIdentity` (`cli/src/lib/terminalRuntime.ts`) and nothing
  else: a pid reused by another process is never the agent's.
- Only processes inside the agent's own pane count, for both rules. The pane's root is included.
- An agent with no recorded process (still starting) keeps today's behavior.
- `archivedOwner` (`cli/src/core/agents/discovery.ts`) and `checkSessionRuntime` do not change, nor do
  `cli/src/core/agents/swap.ts` and `newPane.ts`.
- One way to ask "is the recorded process still in its pane": `processAmong` (Task 3). No task compares a pane's
  processes with a recorded identity any other way.
- Source files that may change: `cli/src/lib/terminalAgentDiscovery.ts`, `cli/src/lib/terminalAgentReconciler.ts`,
  `cli/src/lib/terminalRuntime.ts`, `cli/src/lib/paneEngineProcess.ts`, `cli/src/lib/restoreAgents.ts`,
  `cli/src/lib/tmuxBackend.ts`, `cli/src/lib/ptyHostBackend.ts`. Nothing under `cli/src/core/`, `cli/src/services/`,
  `cli/src/harnessd/`, `pty/` or `term/`, and no `terminalBackend*` or `resumeAgentService*` file. The two backend
  files make one local gate required, `cli-pty` (see Verification); any other of these paths would add another.
- The core's process gains no file: `cli/src/architecture.coreFiles.txt` does not change. The one new import is the
  name `processAmong` from `./terminalRuntime.js`, in four files that already import from that module
  (`terminalAgentReconciler.ts`, `restoreAgents.ts`, `tmuxBackend.ts`, `ptyHostBackend.ts`): no new import edge, and
  none across the door.
- All platforms run the same code (the rules read `ProcessRow`s, whichever table they came from). No new platform
  branch: the one difference is `ptyHostBackend`'s existing Windows check of the pane's Job, which the recorded
  process goes through as an engine does.
- No release. Comments say why and name the incident (lamp-9adf, 2026-11-13, #4259).
- Two files live only on the feature branch and are removed before the pull request (Task 4):
  `.github/workflows/tmp-4259-wrapper-exec.yml` and `cli/e2e/tmp4259WrapperExec.e2e.ts`.

## Found while reading the code

Checked at `070205ac86`.

- **The door.** All seven source files are lines of `cli/src/architecture.coreFiles.txt` (`lib/paneEngineProcess.ts`
  415, `lib/ptyHostBackend.ts` 442, `lib/restoreAgents.ts` 452, `lib/terminalAgentDiscovery.ts` 495,
  `lib/terminalAgentReconciler.ts` 496, `lib/terminalRuntime.ts` 504, `lib/tmuxBackend.ts` 510): they run inside the
  core's process. What that means here: the list must not grow (`src/architecture.spec.ts` fails on one more file,
  and it runs in PR CI's `cli-tests`), so no new module is imported; and since no file under `cli/src/core/`
  changes, the files `npm run test:core` holds to 100% are untouched.
- **The reconciler never sees a process row.** It reads a `TerminalAgentProbe` (targets, agents, ambiguous
  placements). Rule 1 needs the probe to carry each pane's processes. `rootOwner` already walks every pane's whole
  tree on every pass, so listing the rows it visits adds no walk.
- **Rule 2 is one half built.** The reconciler already matches a row whose identity is one of the observed agent's
  `formerProcesses` (`terminalAgentReconciler.ts:339-341`), and `onObserved` re-records it
  (`core/agents/discovery.ts:195`). Only the probe changes for rule 2.
- **Restore's lookup already holds the pane's tree.** `lookupPaneEngineProcess` computes
  `processTreePids(rows, [rootPid])` before it looks for the engine (`paneEngineProcess.ts:42`), so it can name the
  pane's processes in its "no engine" answer with no second tmux or `ps` read. `restoreTerminals.ts` hands that
  answer to `terminalSurvey` unchanged, so it does not change.
- **Both backends' `validate` already go through that lookup** (`tmuxBackend.ts:581`, `ptyHostBackend.ts:694`), and
  both specs mock it (`tmuxBackendValidate.spec.ts`, `ptyHostBackend.spec.ts`). So `validate` needs no process read
  of its own and no Rust: it reads the `paneProcesses` Task 3 puts on the "no engine" answer. On Windows the pty
  host's `validateOn` then asks the pane's Job (`jobPids`, an op the host already has) for the engine's pid; the
  recorded process's pid goes the same way.
- **Who reads `validate`'s `gone`.** The message writer (`core/input.ts:110`, the message is refused), the control
  lease (`terminalBackendCoordinator.ts` `acquireLease`/`validateLease`), and attach's `terminalGone`
  (`core/transcripts/attach.ts:205`: an attach that fails costs a just-woken agent its place among the active,
  `core/agents/discovery.ts:261`). The reconciler's own call (`terminalAgentReconciler.ts:375`) passes no recorded
  process, so it answers as today. After `validate` passes, the message writer still reads the screen and holds a
  message while no composer is on it (`prompt_hidden` or `screen_unreadable`, the holds `lib/messageHolds.ts` calls
  passing: the message waits a little, as for an engine starting, before it is refused). Read in the code, not run:
  what a pane that holds only `unshare` reads as is the engine's own screen reader's answer.
- **The new probe field is optional.** Five spec files build a `TerminalAgentProbe` by hand (`core/agents/bind`,
  `restart`, `retarget`, `lib/initialLaunch.golden`, `lib/terminalAgentReconciler`): a probe without the field
  behaves as today, and none of them changes.
- **No existing spec compares a whole discovered agent**, so `formerProcesses` on every engine below a shell breaks
  none.
- **Tried while planning (2026-11-13, this Mac, then discarded), in two passes.** First pass: the tests in Tasks
  1-3 were run against `070205ac86` and fail as each task says; against a throwaway version of the three changes
  (the comparison written inline, before `processAmong` existed) they pass, `tsc --noEmit` is clean, and the
  neighbouring specs pass (17 files, 463 tests around the probe and reconciler; 448 tests around restore, the
  backends and resume; `architecture.spec.ts` in both). One discovery pass over 40 panes and 1,520 rows took a median
  7.3 ms before and 7.3 ms after. Second pass, for `validate`: the tests of Tasks 3 and 5 as written below fail
  against `070205ac86` as the tasks say (6 red in 5 files); against a throwaway version of Tasks 3 and 5 with
  `processAmong` they pass (220 tests in the 5 files), `tsc --noEmit` is clean, the neighbours pass (20 files, 535
  tests: the backends, their coordinator, restore, resume, the reconciler, `core/terminals`, `core/input`,
  `architecture.spec.ts`), and `npm run test:terminal-contract` passes (6 tests; the pty host half skips itself
  without `HARNESS_PTY_BIN`). Task 5's own diff was 77 changed lines (21 code, 56 tests). Not re-run: Task 2 with
  `processAmong` in place of the inline comparison (it needs Task 1's code; the expression is the same), and Task
  4's scenario, which needs Linux.
- **A fresh worktree has no `cli/node_modules`:** run `npm ci --no-audit --no-fund` in `cli/` first.

## Review Focus

Failure modes the spec implies and its test list does not name, each pinned by a test:

1. **A reused pid in the pane** (same pid, another start), as the bound process or as an ancestor of a new engine.
   Expected: it neither keeps the agent nor hands it that engine. Task 2, `counts a reused pid as a miss…`.
2. **The bound process alive, but outside the agent's pane.** Expected: misses count. Task 2, `counts a miss when
   that process runs outside…`.
3. **On Windows, the recorded process under the pane's root by parent pid but not in the pane's Job** (another
   process that has a parent's number). Expected: `validate` answers `gone`, as it does for an engine. Task 5,
   `on Windows holds that process to the pane's Job…`.
4. **`validate` asked with no recorded process** (the reconciler's own check of a placement). Expected: `gone` as
   today, whatever the pane holds. Task 5, `is gone when that process left the pane, its pid was reused, or none was
   recorded`.
5. **The pane's root is the wrapper itself**, no shell above it. Expected: the root is a former process. Task 1,
   `include the root when it is the pane's own command`.
6. **The pane root's row is missing from the table** (it left between tmux's answer and `ps`). Expected: no throw,
   the ancestors stop at the last row there is. Task 1, `stop at the last row the table has…`.
7. **One engine seen from two panes** (a pane inside a pane). Expected: its ancestors reach the outer root, each
   once. Task 1, `reach the outer root…`.

## Decided at plan review (2026-11-13)

1. No permanent end-to-end test. Task 4's scenario runs once on the branch through the temporary workflow, and both
   of its files are removed before the pull request.
2. `validate` is in: Task 5, and the spec's paragraph and "Done when" line for it.
3. The by-hand **CLI end to end** run stays (Verification check 3). It is a heavy run: the main session asks the
   orchestrator for it before pushing.

Open questions: none.

## Files

| Task | Files (tests included) | Depends on | Effort |
|---|---|---|---|
| 1 The probe | `cli/src/lib/terminalAgentDiscovery.ts`, `cli/src/lib/terminalAgentDiscovery.wrapperExec.spec.ts` (new) | none | high |
| 2 The reconciler | `cli/src/lib/terminalAgentReconciler.ts`, `cli/src/lib/terminalAgentReconciler.wrapperExec.spec.ts` (new) | 1, 3 | xhigh |
| 3 The one question, the lookup, restore | `cli/src/lib/terminalRuntime.ts`, `cli/src/lib/terminalRuntime.spec.ts`, `cli/src/lib/paneEngineProcess.ts`, `cli/src/lib/paneEngineProcess.spec.ts`, `cli/src/lib/restoreAgents.ts`, `cli/src/lib/restoreAgents.spec.ts` | none | high |
| 4 Temporary scenario | `.github/workflows/tmp-4259-wrapper-exec.yml` (new), `cli/e2e/tmp4259WrapperExec.e2e.ts` (new) | 1, 2, 3, 5 | high |
| 5 `validate` | `cli/src/lib/tmuxBackend.ts`, `cli/src/lib/tmuxBackendValidate.spec.ts`, `cli/src/lib/ptyHostBackend.ts`, `cli/src/lib/ptyHostBackend.spec.ts` | 3 | xhigh |

Tasks 1 and 3 share no file and start together; Tasks 2 and 5 share no file and start as soon as their own
dependencies are done. Longest chain: three tasks (1, 2, 4; or 3, 2, 4; or 3, 5, 4). Test commands run from `cli/`.

---

### Task 1: The probe names a pane's processes and its engine's ancestors

**Depends on:** nothing. **Effort:** high.

**Files:**
- Modify: `cli/src/lib/terminalAgentDiscovery.ts` (`formerProcesses` doc 60-62, `TerminalAgentProbe` 104-109,
  `RootOwner` 111-115, `rootOwner` 146-199, `discoverTerminalAgentsFromSnapshot` 207-261, the gateways 321-324)
- Test (create): `cli/src/lib/terminalAgentDiscovery.wrapperExec.spec.ts`

**Interfaces:**
- Produces, for Task 2: `TerminalAgentProbe.paneProcesses?: ReadonlyMap<string, readonly ProcessIdentity[]>`, keyed
  by `terminalPlacementKey(runtime)`; and `DiscoveredTerminalAgent.formerProcesses` now also holding the engine's
  ancestors inside its pane.

- [ ] **Step 1: Record the pass before the change.** Save this as `cli/bench-discovery.tmp.ts`, run
  `npx tsx bench-discovery.tmp.ts` twice, note the medians. Never commit the file.

```ts
import { agentCommandOwnershipSnapshot } from './src/lib/engineBin.js'
import { discoverTerminalAgentsFromSnapshot } from './src/lib/terminalAgentDiscovery.js'
const START = 'Fri Nov 13 14:22:00 2026'
const rows: any[] = [], roots: any[] = []
for (let pane = 0; pane < 40; pane++) {
  const root = 10_000 + pane * 100
  roots.push({ runtime: { backend: 'tmux', paneId: `%${pane}` }, rootPid: root, cwd: '/work' })
  rows.push({ pid: root, parentPid: 1, executable: 'zsh', startMarker: START, args: '-zsh' })
  rows.push({ pid: root + 1, parentPid: root, executable: 'claude', startMarker: START, args: 'claude' })
  for (let n = 2; n < 12; n++) rows.push({ pid: root + n, parentPid: root + 1, executable: 'node', startMarker: START, args: 'node tool.js' })
}
for (let pid = 100; pid < 1100; pid++) rows.push({ pid, parentPid: 1, executable: 'daemon', startMarker: START, args: 'daemon' })
const ownership = agentCommandOwnershipSnapshot()
const times: number[] = []
for (let n = 0; n < 600; n++) {
  const from = process.hrtime.bigint()
  discoverTerminalAgentsFromSnapshot(roots, rows, 999, ['tmux'], new Map(), ownership)
  if (n >= 100) times.push(Number(process.hrtime.bigint() - from) / 1000)
}
times.sort((a, b) => a - b)
console.log(`median ${times[times.length >> 1].toFixed(0)} µs · p95 ${times[Math.floor(times.length * 0.95)].toFixed(0)} µs per pass`)
```

- [ ] **Step 2: Write the failing test** `cli/src/lib/terminalAgentDiscovery.wrapperExec.spec.ts`

```ts
/**
 * What the probe says of a pane for an agent whose bound process `exec`ed into another name (#4259): the engine's
 * ancestors inside its pane, root included, are its former processes, and every process in a pane's tree is listed.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ProcessRow } from './processTable.js'
import type { TerminalBackend } from './terminalBackend.js'
import { terminalPlacementKey } from './terminalRuntime.js'
import type { TerminalRootObservation } from './terminalTypes.js'

const processRows = vi.hoisted(() => vi.fn())
vi.mock('./gatewayRuntime.js', () => ({ probeGatewayRuntime: vi.fn(async () => ({ kind: null })) }))
vi.mock('./processEnv.js', async (real) => ({ ...await real<object>(), readProcessEnv: vi.fn(async () => null) }))
vi.mock('./processMounts.js', async (real) => ({ ...await real<object>(), processView: vi.fn(async () => ({ state: 'same' })) }))
vi.mock('./processTable.js', async (real) => ({ ...await real<typeof import('./processTable.js')>(), processRows, enrichProcessRows: vi.fn(async (rows: unknown) => rows) }))

const { discoverTerminalAgentsFromSnapshot, probeTerminalAgents } = await import('./terminalAgentDiscovery.js')

const START = 'Fri Nov 13 14:22:00 2026'
const LATER = 'Fri Nov 13 15:00:00 2026'
const row = (pid: number, parentPid: number, executable: string, args = executable, startMarker = START): ProcessRow =>
  ({ pid, parentPid, executable, startMarker, args })
const id = (process: ProcessRow) => ({ pid: process.pid, executable: process.executable, startMarker: process.startMarker })
const pane = (paneId: string, rootPid: number): TerminalRootObservation => ({ runtime: { backend: 'tmux', paneId }, rootPid, cwd: '/work' })
const probe = (roots: TerminalRootObservation[], rows: ProcessRow[]) => {
  processRows.mockResolvedValue(rows)
  const backend = { name: 'tmux', instanceId: 'tmux:default', inventory: async () => ({ state: 'available', roots }) } as unknown as TerminalBackend
  return probeTerminalAgents([backend], ['tmux'], 999)
}
/** The pids and starts the probe lists for a pane, by pid. */
const listed = (found: Awaited<ReturnType<typeof probe>>, paneId: string) =>
  [...found.paneProcesses?.get(terminalPlacementKey({ backend: 'tmux', paneId })) ?? []]
    .map((process) => [process.pid, process.startMarker]).sort(([a], [b]) => Number(a) - Number(b))

const TMUX = row(5, 1, 'tmux')
const SHELL = row(10, 5, 'zsh', '-zsh')
const UNSHARE = row(11, 10, 'unshare', '/usr/bin/unshare --fork -- /usr/local/bin/hermes-ns')
const HERMES = row(12, 11, 'python3', '/opt/hermes-agent/hermes')
const GATEWAY = row(13, 12, 'python3', 'python3 -m hermes_cli.main gateway run')

describe('the former processes of a pane\'s engine', () => {
  it('are its ancestors inside the pane, root included, and the Hermes gateway under it: nothing outside the pane', async () => {
    const { agents } = await probe([pane('%1', 10)], [TMUX, SHELL, UNSHARE, HERMES, GATEWAY])
    expect(agents.map((agent) => agent.processIdentity.pid)).toEqual([12])
    expect(agents[0].formerProcesses).toEqual([id(UNSHARE), id(SHELL), id(GATEWAY)])
  })

  it('include the root when it is the pane\'s own command', async () => {
    const root = { ...UNSHARE, parentPid: 5 }
    const { agents } = await probe([pane('%1', 11)], [TMUX, root, HERMES])
    expect(agents[0].formerProcesses).toEqual([id(root)])
  })

  it('are none for an engine that is its pane\'s root, and the shell above it for any other engine', async () => {
    const shell = row(20, 5, 'zsh', '-zsh')
    const { agents } = await probe([pane('%1', 12), pane('%2', 20)], [TMUX, { ...HERMES, parentPid: 5 }, shell, row(21, 20, 'claude')])
    const by = Object.fromEntries(agents.map((agent) => [agent.engine, agent]))
    expect(by.hermes).not.toHaveProperty('formerProcesses')
    expect(by.claude.formerProcesses).toEqual([id(shell)])
  })

  it('stop at the last row the table has when the pane\'s root is not in it', async () => {
    const found = await probe([pane('%1', 10)], [TMUX, UNSHARE, HERMES])
    expect(found.agents[0].formerProcesses).toEqual([id(UNSHARE)])
    expect(listed(found, '%1')).toEqual([[11, START], [12, START]])
  })

  it('reach the outer root for an engine two panes see', () => {
    const { agents } = discoverTerminalAgentsFromSnapshot([pane('%1', 10), pane('%2', 20)],
      [SHELL, row(20, 10, 'zsh', '-zsh'), row(30, 20, 'claude')], 999, ['tmux'])
    expect(agents).toHaveLength(1)
    expect(agents[0].formerProcesses?.map((process) => process.pid)).toEqual([20, 10])
  })
})

describe('the processes of a pane', () => {
  it('are every process in its tree, an engine among them or not, and none outside it', async () => {
    const found = await probe([pane('%1', 10), pane('%2', 20)],
      [TMUX, SHELL, UNSHARE, HERMES, row(20, 5, 'zsh', '-zsh'), row(21, 20, 'unshare', 'unshare', LATER), row(30, 1, 'unshare')])
    expect(listed(found, '%1')).toEqual([[10, START], [11, START], [12, START]])
    expect(listed(found, '%2')).toEqual([[20, START], [21, LATER]])
    expect(found.agents.map((agent) => agent.processIdentity.pid)).toEqual([12])
  })
})
```

- [ ] **Step 3: Run it and see it fail**

Run: `npx vitest run src/lib/terminalAgentDiscovery.wrapperExec.spec.ts`
Expected: 6 failed. The first: `expected [ { pid: 13, … } ] to deeply equal [ { pid: 11, … }, … ]` (only the gateway
is a former process today); the last: `expected [] to deeply equal [ …(3) ]`.

- [ ] **Step 4: Commit the red test**

```bash
git add cli/src/lib/terminalAgentDiscovery.wrapperExec.spec.ts
git commit -m "Test: the probe names a pane's processes and its engine's ancestors (#4259)"
```

- [ ] **Step 5: Implement in `cli/src/lib/terminalAgentDiscovery.ts`**

- `TerminalAgentProbe` gains `paneProcesses?: ReadonlyMap<string, readonly ProcessIdentity[]>`: every process in each
  pane's tree in this snapshot, by `terminalPlacementKey`. Optional: a probe that read no process table has none.
- `RootOwner` gains `processes: ProcessRow[]` (each row the walk visits, in walk order, whatever the pane holds) and
  `ancestors: ProcessIdentity[]` (the chosen engine's parents by `parentPid`, nearest first, `processIdentityOf`
  each, at most `depth` of them so the root is the last, stopping at the first pid the table has no row for; empty on
  every answer with no agent). All four `return`s of `rootOwner` carry both.
- `discoverTerminalAgentsFromSnapshot` returns `paneProcesses: Map<string, ProcessIdentity[]>` too: one entry per
  root, set before the ambiguous and no-agent `continue`s, holding the walk's own rows (no copy per pass). An agent's
  `formerProcesses` is the union of its observations' `ancestors`, one entry per pid, nearest first; the property is
  absent when there is none. (Give the group's map its type, `new Map<number, ProcessIdentity>()`: left bare,
  TypeScript infers the group's `observations` as `never[]`.)
- `probeTerminalAgents` appends Hermes's gateways after the ancestors instead of replacing them. Its result already
  spreads the snapshot's, so `paneProcesses` rides along; the `processTableAvailable: false` answer stays as it is.
- Rewrite the `formerProcesses` doc: what a row may hold in this process's place, the pane ancestors of a wrapper
  that `exec`ed (#4259) and the gateways (as today), and that a row holding one is this agent, re-recorded.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/lib/terminalAgentDiscovery src/lib/terminalAgentReconciler.spec.ts src/lib/processTable.hermesGateway.spec.ts src/lib/initialLaunch.golden.spec.ts src/engines/otherAdmission.golden.spec.ts src/architecture.spec.ts`
Expected: all pass, the new file's 6 among them. Then `npm run typecheck`: no output.

- [ ] **Step 7: Record the pass after the change, and remove the script**

Run `npx tsx bench-discovery.tmp.ts` twice, then `rm bench-discovery.tmp.ts`; `git status --short` must not list it.
Expected: the median within noise of Step 1's (planning measured 7.3 ms both sides). Put both numbers in the task
report: the pull request carries them.

- [ ] **Step 8: Commit**

```bash
git add cli/src/lib/terminalAgentDiscovery.ts
git commit -m "Discovery: a pane's processes, and its engine's pane ancestors as former processes (#4259)"
```

---

### Task 2: The reconciler counts no miss while the bound process runs in its pane

**Depends on:** Task 1 (`paneProcesses`, and the ancestors the re-record needs) and Task 3 (`processAmong`).
**Effort:** xhigh (the liveness decision, raced by probes and binds).

**Files:**
- Modify: `cli/src/lib/terminalAgentReconciler.ts` (the `engineMisses` doc 121-123, the miss branches 404-426)
- Test (create): `cli/src/lib/terminalAgentReconciler.wrapperExec.spec.ts`

**Interfaces:**
- Consumes: `TerminalAgentProbe.paneProcesses` and `formerProcesses` from Task 1; `processAmong` from Task 3.

- [ ] **Step 1: Write the test** `cli/src/lib/terminalAgentReconciler.wrapperExec.spec.ts`

Process rows through the real probe (the reconciler is given no `probe`), a row that already has a `sessionId`.

```ts
/**
 * An agent launched through a wrapper that `exec`s into another name (#4259): `sh hermes` is bound, becomes `unshare`
 * with the same pid and start, and the real Hermes shows up later as its child. Process rows through the real probe.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ProcessRow } from './processTable.js'
import type { RegisteredSession } from './registry.js'
import type { DiscoveredTerminalAgent } from './terminalAgentDiscovery.js'
import type { TerminalBackend } from './terminalBackend.js'
import { terminalRouteKey } from './terminalRuntime.js'
import type { TerminalRuntimeRef } from './terminalTypes.js'

const processRows = vi.hoisted(() => vi.fn())
vi.mock('./gatewayRuntime.js', () => ({ probeGatewayRuntime: vi.fn(async () => ({ kind: null })) }))
vi.mock('./processEnv.js', async (real) => ({ ...await real<object>(), readProcessEnv: vi.fn(async () => null) }))
vi.mock('./processMounts.js', async (real) => ({ ...await real<object>(), processView: vi.fn(async () => ({ state: 'same' })) }))
vi.mock('./processTable.js', async (real) => ({ ...await real<typeof import('./processTable.js')>(), processRows, enrichProcessRows: vi.fn(async (rows: unknown) => rows) }))

const { TerminalAgentReconciler } = await import('./terminalAgentReconciler.js')

const START = 'Fri Nov 13 14:22:00 2026'
const row = (pid: number, parentPid: number, executable: string, args = executable, startMarker = START): ProcessRow =>
  ({ pid, parentPid, executable, startMarker, args })
const pane: TerminalRuntimeRef = { backend: 'tmux', paneId: '%1' }
const SHELL = row(10, 5, 'zsh', '-zsh')
const WRAPPER = row(11, 10, 'hermes', '/bin/sh /usr/local/bin/hermes')
/** The wrapper after its `exec`: the same pid and start, a name no engine has. */
const UNSHARE = row(11, 10, 'unshare', '/usr/bin/unshare --fork -- /usr/local/bin/hermes-ns')
const HERMES = row(12, 11, 'python3', '/opt/hermes-agent/hermes')

function rig() {
  const current = {
    schemaVersion: 2, active: true, agentId: 'agent-1', sessionId: 'local-4259', boundAt: 1, engine: 'hermes',
    transcriptPath: null, projectDir: 'work', cwd: '/work', runtimes: [pane], primaryRuntimeKey: terminalRouteKey(pane),
    tmuxPane: '%1', source: null, title: null, model: null, cliVersion: null, launch: { state: 'ready' },
    processIdentity: { pid: 11, executable: 'hermes', startMarker: START },
    registeredAt: 1, touchedAt: 1, lastHookAt: 1, lastTranscriptAt: 1,
  } as RegisteredSession
  const onDiscovered = vi.fn()
  const onObserved = vi.fn((observed: DiscoveredTerminalAgent) => { current.processIdentity = observed.processIdentity })
  const onDormant = vi.fn(() => { current.active = false })
  const backend = { name: 'tmux', instanceId: 'tmux:default',
    inventory: async () => ({ state: 'available', roots: [{ runtime: pane, rootPid: 10, cwd: '/work' }] }) } as unknown as TerminalBackend
  const reconciler = new TerminalAgentReconciler({ current: () => [current], backends: [backend], backendOrder: ['tmux'],
    daemonPid: 999, onDiscovered, onObserved, onDormant, onRemoved: vi.fn() })
  const pass = async (...rows: ProcessRow[]) => { processRows.mockResolvedValue(rows); await reconciler.trigger() }
  return { current, onDiscovered, onObserved, onDormant, pass }
}

describe('an agent whose bound process execs into another name', () => {
  it('stays while that process runs in its pane, then is re-recorded to the engine below it', async () => {
    const r = rig()
    await r.pass(SHELL, WRAPPER)
    for (let n = 0; n < 3; n++) await r.pass(SHELL, UNSHARE)
    expect(r.onDormant).not.toHaveBeenCalled()
    await r.pass(SHELL, UNSHARE, HERMES)
    expect(r.current.processIdentity).toMatchObject({ pid: 12, startMarker: START })
    expect(r.onObserved).toHaveBeenLastCalledWith(expect.objectContaining({ engine: 'hermes' }), r.current)
    expect(r.onDiscovered).not.toHaveBeenCalled()
    // Hermes ends, and `unshare` with it: stopped as before, after two passes.
    await r.pass(SHELL)
    expect(r.onDormant).not.toHaveBeenCalled()
    await r.pass(SHELL)
    expect(r.onDormant).toHaveBeenCalledOnce()
  })

  it('counts a reused pid as a miss, and does not take the engine below it for its own', async () => {
    const r = rig()
    const reused = row(11, 10, 'unshare', UNSHARE.args, 'Fri Nov 13 15:00:00 2026')
    await r.pass(SHELL, reused, HERMES)
    await r.pass(SHELL, reused, HERMES)
    expect(r.onDormant).toHaveBeenCalledOnce()
    expect(r.onObserved).not.toHaveBeenCalled()
    expect(r.onDiscovered).toHaveBeenCalledWith(expect.objectContaining({ processIdentity: expect.objectContaining({ pid: 12 }) }))
  })

  it('counts a miss when that process runs outside the agent\'s pane', async () => {
    const r = rig()
    const elsewhere = { ...UNSHARE, parentPid: 5 }
    await r.pass(SHELL, elsewhere)
    await r.pass(SHELL, elsewhere)
    expect(r.onDormant).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run it and see the first test fail**

Run: `npx vitest run src/lib/terminalAgentReconciler.wrapperExec.spec.ts`
Expected: 1 failed, 2 passed. The failure is the first test, at the first `expect(r.onDormant).not.toHaveBeenCalled()`:
called once with `engine process absent after 2 confirmed scans` (the issue). The other two are guards: they pass
before and after.

- [ ] **Step 3: Commit the red test**

```bash
git add cli/src/lib/terminalAgentReconciler.wrapperExec.spec.ts
git commit -m "Test: an agent whose bound process execs into another name stays, then follows the engine (#4259)"
```

- [ ] **Step 4: Implement in `cli/src/lib/terminalAgentReconciler.ts`**

- Add a module function
  `boundProcessRuns(current: Pick<RegisteredSession, 'processIdentity' | 'runtimes'>, probe: Pick<TerminalAgentProbe, 'paneProcesses'>): boolean`:
  true when `processAmong(current.processIdentity, probe.paneProcesses?.get(terminalPlacementKey(runtime)))` holds
  for one of `current.runtimes` (import `processAmong` beside the other `./terminalRuntime.js` names; no
  `sameProcessIdentity` loop of its own). Its comment says why: the wrapper's pid lived on as `unshare` while Hermes
  loaded, and two passes with no engine archived a running agent (lamp-9adf, 2026-11-13, #4259).
- In the miss branches, the first condition (`observed || (processKey === null && …)`, line 405) also holds when
  `boundProcessRuns(current, probe)`: the miss count is dropped, as for an observed engine, so two fresh misses are
  needed once that process is gone. Nothing else in the chain changes: the `else if` keeps its `probedAs` guard.
- Update the `engineMisses` doc: a pass in which the recorded process still runs in the agent's pane is no miss.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/terminalAgentReconciler src/lib/initialLaunch.golden.spec.ts src/core/agents/bind.spec.ts src/core/agents/restart.spec.ts src/core/agents/retarget.spec.ts`
Expected: all pass, the new file's 3 among them. Then `npm run typecheck`: no output.

- [ ] **Step 6: Commit**

```bash
git add cli/src/lib/terminalAgentReconciler.ts
git commit -m "Discovery: no engine miss while the agent's bound process runs in its pane (#4259)"
```

---

### Task 3: One question, the pane lookup's answer to it, and restore

**Depends on:** nothing. **Effort:** high.

**Files:**
- Modify: `cli/src/lib/terminalRuntime.ts` (a function after `sameProcessIdentity`, 89-94)
- Modify: `cli/src/lib/paneEngineProcess.ts` (`PaneProcessLookup` 22-24, `lookupPaneEngineProcess` 42-44)
- Modify: `cli/src/lib/restoreAgents.ts` (`terminalSurvey` 219-242, the import on line 44)
- Test: `cli/src/lib/terminalRuntime.spec.ts`, `cli/src/lib/paneEngineProcess.spec.ts`,
  `cli/src/lib/restoreAgents.spec.ts`

**Interfaces:**
- Produces, for Tasks 2 and 5:
  `processAmong(recorded: ProcessStart | undefined | null, processes: readonly ProcessStart[] | undefined): boolean`,
  exported from `terminalRuntime.ts` (`ProcessStart` is that file's own type: pid, start marker, start ticks).
- Produces, for Task 5: `PaneProcessLookup`'s negative answer gains `paneProcesses?: readonly ProcessIdentity[]`;
  `terminalSurvey`'s `lookup` parameter's negative answer gains the same optional field.

- [ ] **Step 1: Write the failing tests**

In `cli/src/lib/terminalRuntime.spec.ts`, add `processAmong` to the import and, before
`it('rejects separator injection into stable keys', …)`:

```ts
  it('finds a process among a pane\'s by its pid and start, whatever its name now', () => {
    const bound = { pid: 11, executable: 'hermes', startMarker: 'Fri Nov 13 14:22:00 2026' }
    const pane = [{ pid: 10, executable: 'zsh', startMarker: 'Fri Nov 13 14:00:00 2026' }, { ...bound, executable: 'unshare' }]
    expect(processAmong(bound, pane)).toBe(true)
    // The same pid started later is another process.
    expect(processAmong({ ...bound, startMarker: 'Fri Nov 13 15:00:00 2026' }, pane)).toBe(false)
    expect(processAmong(bound, [pane[0]])).toBe(false)
    expect(processAmong(bound, undefined)).toBe(false)
    expect(processAmong(null, pane)).toBe(false)
  })
```

In `cli/src/lib/paneEngineProcess.spec.ts`, before `describe('checkSessionRuntime', …)`:

```ts
describe('lookupPaneEngineProcess, a pane with no engine in it', () => {
  it('names the processes in the pane, and none outside it', async () => {
    setProcessTableSource(async () => [
      { pid: 10, parentPid: 1, executable: 'zsh', startMarker: 'm10', args: '-zsh' },
      { pid: 11, parentPid: 10, executable: 'unshare', startMarker: 'm11', args: 'unshare --fork hermes-ns' },
      { pid: 30, parentPid: 1, executable: 'unshare', startMarker: 'm30', args: 'unshare' },
    ])
    try {
      const found = await lookupPaneEngineProcess(backendWithRoot(10), runtime, 'hermes')
      expect(found).toMatchObject({ ok: false, unknown: false, reason: 'no hermes process under tmux:%1' })
      expect(found.ok ? null : found.paneProcesses?.map((process) => [process.pid, process.startMarker])).toEqual([[10, 'm10'], [11, 'm11']])
    } finally { setProcessTableSource(null) }
  })
})
```

At the end of `cli/src/lib/restoreAgents.spec.ts`:

```ts
describe('restoreAgents — a pane that holds only the recorded process (#4259)', () => {
  it('keeps the agent whose recorded process still runs in its pane under another name, and archives the one whose process is gone', async () => {
    const bound = identity(11)
    const kept = row({ agentId: 'kept', processIdentity: bound })
    const gone = row({ agentId: 'gone', sessionId: 'session-b', tmuxPane: '%4', runtimes: [{ backend: 'tmux', paneId: '%4' }],
      primaryRuntimeKey: 'tmux\u0000%4', processIdentity: identity(21) })
    const h = harness([kept, gone])
    const retainStopped = h.deps.retainStopped = vi.fn()
    const panes: TerminalRuntimeRef[] = [{ backend: 'tmux', paneId: '%3' }, { backend: 'tmux', paneId: '%4' }]
    h.deps.survey = () => terminalSurvey(async () => ({ ok: true, panes }), async (runtime) => ({
      ok: false, unknown: false,
      paneProcesses: runtime.paneId === '%3'
        ? [identity(10), { ...bound, executable: 'unshare' }]
        // The same pid started later is another process.
        : [identity(20), { ...identity(21), startMarker: 'start later' }],
    }))
    const summary = await restoreAgents(h.deps)
    expect(retainStopped.mock.calls.map(([entry, paneAlive]) => [entry.agentId, paneAlive])).toEqual([['gone', true]])
    expect(summary).toEqual({ restored: [], skipped: [], failed: [], held: [], unsurveyed: [] })
    expect(h.paneCreates).toBe(0)
    expect(h.rows.get('kept')!.processIdentity).toEqual(bound)
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run src/lib/terminalRuntime.spec.ts src/lib/paneEngineProcess.spec.ts src/lib/restoreAgents.spec.ts`
Expected: 3 failed. `processAmong is not a function`, `expected undefined to deeply equal [ [ 10, 'm10' ], [ 11, 'm11' ] ]`,
and `expected [ [ 'kept', true ], [ 'gone', true ] ] to deeply equal [ [ 'gone', true ] ]` (today both are archived).

- [ ] **Step 3: Commit the red tests**

```bash
git add cli/src/lib/terminalRuntime.spec.ts cli/src/lib/paneEngineProcess.spec.ts cli/src/lib/restoreAgents.spec.ts
git commit -m "Test: restore keeps an agent whose pane holds only its recorded process (#4259)"
```

- [ ] **Step 4: Implement**

- `cli/src/lib/terminalRuntime.ts`: export `processAmong` (signature in Interfaces), after `sameProcessIdentity`:
  true when `recorded` is set and `sameProcessIdentity` finds it in `processes`. Its doc says what it asks (the
  process an agent was bound to still runs in its pane, whatever its name now) and why (a wrapper that `exec`s keeps
  its pid and start under another name; lamp-9adf, 2026-11-13, #4259).
- `cli/src/lib/paneEngineProcess.ts`: `PaneProcessLookup`'s negative answer gains
  `paneProcesses?: readonly ProcessIdentity[]`. `lookupPaneEngineProcess` sets it on one answer only, "no engine
  process under the pane": `processIdentityOf` each enriched row whose pid is in the pane's tree (the
  `processTreePids(rows, [rootPid])` it already computes, kept in a variable). The "has no pane", "could not be
  resolved" and "table could not be read" answers carry none (their existing `toEqual` tests must stay green).
  `checkSessionRuntime` and `resolvePaneEngineProcess` do not change.
- `cli/src/lib/restoreAgents.ts`, `terminalSurvey`: the `lookup` parameter's negative answer type gains
  `paneProcesses?: readonly ProcessIdentity[]`. `liveProcess` answers as today for a found engine and for `unknown`;
  otherwise, when `processAmong(entry.processIdentity, found.paneProcesses)`, it answers that recorded identity (the
  agent is still running, and `restoreAgents` then leaves the row as it is); else `null`. Import `processAmong`
  beside the other `./terminalRuntime.js` names. Add to the function's doc why: a daemon that restarted while the
  pane held only `unshare` archived a running agent (#4259).
- `restoreAgents()` itself and `restoreTerminals.ts` do not change.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/terminalRuntime.spec.ts src/lib/restoreAgents.spec.ts src/lib/paneEngineProcess.spec.ts src/lib/restoreTerminals.spec.ts src/lib/tmuxBackend src/lib/ptyHostBackend.spec.ts src/lib/resumeAgentService.spec.ts src/architecture.spec.ts`
Expected: all pass (one file skips by itself). Then `npm run typecheck`: no output.

- [ ] **Step 6: Commit**

```bash
git add cli/src/lib/terminalRuntime.ts cli/src/lib/paneEngineProcess.ts cli/src/lib/restoreAgents.ts
git commit -m "Restore: an agent whose recorded process still runs in its pane is kept, not archived (#4259)"
```

---

### Task 4: Temporary: the scenario on a real Linux process table

**Depends on:** Tasks 1, 2, 3 and 5: the scenario is the one check of the whole change on a real kernel, and an
attach made while the pane holds only `unshare` reads `validate` (`terminalGone`, Task 5). Whether the scenario's
own attach falls in that window was not run, so its result is read only with all four in. **Effort:** high.

**Temporary.** One commit, no red test. Both files are removed in ken15dev phase 4, after Verification checks 2 and 3
pass and before the pull request (`git rm .github/workflows/tmp-4259-wrapper-exec.yml cli/e2e/tmp4259WrapperExec.e2e.ts`,
one commit). The pull request carries neither, and no permanent end-to-end test replaces them (decided at plan
review).

Why: the unit tests model the process rows by hand. Only a real kernel shows that the wrapper is bound before its
`exec`, that the pid keeps its start across it, and that the daemon's own watcher, reconciler and restore follow it.
`unshare` exists on Linux only, and **CLI end to end** has no input to run one file.

**Files:**
- Create: `.github/workflows/tmp-4259-wrapper-exec.yml`
- Create: `cli/e2e/tmp4259WrapperExec.e2e.ts`
- Test: none (a temporary check).

- [ ] **Step 1: Write the scenario** `cli/e2e/tmp4259WrapperExec.e2e.ts`

The repo's end-to-end harness, as `cli/e2e/hermesTerminalRecord.e2e.ts` uses it: `IsolatedDaemon`, `LocalClient`,
the fake Hermes at `HERMES_PATH`. Not run while planning; if a step below is wrong about the harness, fix the
scenario, never the product code for it.

```ts
/**
 * TEMPORARY: removed before the pull request, with .github/workflows/tmp-4259-wrapper-exec.yml.
 * #4259 on a real Linux process table: `hermes` is a wrapper that stays `hermes` for 2 s, then execs `unshare`,
 * under which the fake Hermes (e2e/harness/fakeHermes.mjs) starts only after it has "loaded".
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { fakeHermesScript } from './harness/fakeHermes.mjs'

const VERSION = 'Hermes Agent v0.23.1 (2026.11.1)'
type Agent = { id: string; status?: string }
type Saved = { agentId: string; processIdentity?: { pid: number } | null }

let daemon: IsolatedDaemon | undefined
let client: LocalClient | undefined
afterEach(async () => { client?.close(); await daemon?.close(); client = undefined; daemon = undefined })

/** A started daemon whose Hermes loads for [loads] seconds under `unshare`, and one Hermes agent created on it. */
async function rig(loads: number) {
  const d = daemon = await IsolatedDaemon.create()
  onTestFailed(() => console.log(d.log()))
  d.env.HERMES_HOME = join(d.root, 'hermes')
  d.env.HERMES_PATH = join(d.root, 'bin', 'hermes')
  d.env.HOOK_INSTALL_ENGINES = 'hermes'
  mkdirSync(d.env.HERMES_HOME, { recursive: true })
  const script = join(d.root, 'hermes-script.jsonl')
  writeFileSync(script, '')
  // The fake's text without its `#!node` line, under a /bin/sh head: each line sh runs is a comment to Node, which
  // then runs this same file, so the engine the daemon finds is `node <HERMES_PATH>` (fakeHermes.mjs).
  const fake = fakeHermesScript({ version: VERSION, script }).split('\n').slice(1).join('\n')
  const sh = [
    `case "$1" in --version) echo '${VERSION}'; exit 0;; esac`,
    'sleep 2',
    `exec unshare --fork -- /bin/sh -c 'sleep ${loads} && exec "$@"' sh '${process.execPath}' "$0" "$@"`,
  ]
  writeFileSync(d.env.HERMES_PATH, `#!/bin/sh\n${sh.map((line) => `// 2>/dev/null; ${line}`).join('\n')}\n${fake}`, { mode: 0o755 })
  const cwd = join(d.projectsDir, 'p1')
  mkdirSync(cwd, { recursive: true })
  await d.start()
  const connect = async () => { client?.close(); return client = await LocalClient.connect(d) }
  const created = await (await connect()).request('agent_create', { engine: 'hermes', cwd }, 60_000)
  expect(created.error, JSON.stringify(created)).toBeUndefined()
  const agentId: string = created.agent.id
  const pane = String(created.agent.terminal?.runtimes?.[0]?.paneId ?? created.agent.tmuxPane)
  const boundPid = () => (JSON.parse(readFileSync(join(d.dataDir, 'registry.json'), 'utf8')) as Saved[])
    .find((row) => row.agentId === agentId)?.processIdentity?.pid
  /** The pid the new-pane watcher bound: the wrapper's, while it was still `hermes`. */
  const wrapper = await until('the wrapper bound', () => boundPid(), 30_000, 50)
  const loaded = async () => {
    await until('the fake Hermes', async () => (await d.capture(pane)).includes('fake-hermes-ready') || null, 120_000, 100)
    return until('the agent on the engine', () => { const pid = boundPid(); return pid && pid !== wrapper ? pid : null }, 30_000, 100)
  }
  const agents = async () => (await client!.request<{ agents: Agent[] }>('agents_list', { includeStopped: true })).agents
  return { d, connect, agentId, wrapper, loaded, agents }
}
const ps = (field: 'comm' | 'ppid', pid: number) => execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim()

describe.runIf(process.platform === 'linux')('an agent launched through a wrapper that execs into another name', () => {
  it('stays while its engine loads, moves to the engine, and is stopped when the engine ends', async () => {
    const r = await rig(15)
    const engine = await r.loaded()
    // The scenario's own ground: what was bound first is `unshare` now, and the engine is its child.
    expect(ps('comm', r.wrapper)).toBe('unshare')
    expect(ps('ppid', engine)).toBe(String(r.wrapper))
    expect((await r.agents()).map((agent) => [agent.id, agent.status === 'stopped'])).toEqual([[r.agentId, false]])
    expect(r.d.log()).not.toMatch(/retained · engine process absent/)
    process.kill(engine)
    await until('the agent stopped', async () => (await r.agents()).find((agent) => agent.id === r.agentId)?.status === 'stopped' || null, 60_000, 250)
  })

  it('is kept by a daemon that restarts while only the wrapper\'s process is in its pane', async () => {
    const r = await rig(40)
    await until('the wrapper\'s exec', () => ps('comm', r.wrapper) === 'unshare' || null, 15_000, 100)
    await r.d.stop()
    const mark = r.d.log().length
    await r.d.start()
    await r.connect()
    const engine = await r.loaded()
    expect(ps('ppid', engine)).toBe(String(r.wrapper))
    expect(r.d.log().slice(mark)).not.toContain('its engine exited while the daemon was down')
    expect((await r.agents()).map((agent) => [agent.id, agent.status === 'stopped'])).toEqual([[r.agentId, false]])
  })
})
```

- [ ] **Step 2: Create the workflow** `.github/workflows/tmp-4259-wrapper-exec.yml` with exactly this content

The install step is `cli-e2e.yml`'s, so the pane's zsh starts as it does there.

```yaml
name: tmp 4259 wrapper exec

# TEMPORARY: lives only on this feature branch and is removed before the pull request.
# One end-to-end scenario on a real Linux process table (#4259): an agent launched through a wrapper that execs
# into another name. CLI end to end has no input to run one file.
on:
  push:
    branches: ['fix/4259-wrapper-exec']

concurrency:
  group: tmp-4259-wrapper-exec
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  wrapper-exec:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    defaults:
      run:
        working-directory: cli
    env:
      LANG: C.UTF-8
      SHELL: /bin/zsh
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24.22.2
          cache: npm
          cache-dependency-path: cli/package-lock.json
      - name: Install tmux, the shells the tests launch through, and lsof
        run: |
          sudo bash ../scripts/apt-install.sh tmux zsh tcsh dash lsof
          sudo sysctl -w fs.inotify.max_user_instances=1024 fs.inotify.max_user_watches=524288
          insecure=$(zsh -fc 'autoload -U compaudit && compaudit' 2>/dev/null | grep '^/' | sort -u || true)
          if [ -n "$insecure" ]; then
            echo "$insecure" | xargs sudo chown root:root
            echo "$insecure" | xargs sudo chmod g-w,o-w
          fi
          zsh -fc 'autoload -U compaudit && compaudit'
      - run: npm ci --no-audit --no-fund
      - name: The wrapper exec scenario
        env:
          E2E_BUNDLE: '1'
          E2E_ARTIFACTS_DIR: ${{ runner.temp }}/e2e-daemon-logs
        run: npx vitest run --config vitest.e2e.config.ts e2e/tmp4259WrapperExec.e2e.ts
      - name: Preserve the failing tests' daemon logs
        if: ${{ failure() }}
        uses: actions/upload-artifact@v4
        with:
          name: tmp-4259-daemon-logs
          path: ${{ runner.temp }}/e2e-daemon-logs/
          if-no-files-found: ignore
          retention-days: 7
```

It holds no secret, no `workflow_dispatch`, no other trigger, and nothing that releases, publishes, deploys or writes
outside its run.

- [ ] **Step 3: Check both files**

Run: `actionlint .github/workflows/tmp-4259-wrapper-exec.yml` (no output, exit 0), and from `cli/`
`npx vitest run --config vitest.e2e.config.ts e2e/tmp4259WrapperExec.e2e.ts` on the Mac: the file loads and its two
tests are skipped (not Linux).

- [ ] **Step 4: Commit** (the one commit)

```bash
git add .github/workflows/tmp-4259-wrapper-exec.yml cli/e2e/tmp4259WrapperExec.e2e.ts
git commit -m "TEMPORARY: the wrapper exec scenario on Linux (removed before the pull request)"
```

- [ ] **Step 5: After the branch is pushed, read the run** (Verification check 2's commands)

A red run is one of two things. The scenario's own ground failed (`the wrapper bound`, `the wrapper's exec`, the
`ps` lines, or the harness): fix this file and push once. Anything else (the agent stopped, a second agent, the
restart archived it) is a result: it goes back to the task that owns the code, with the daemon log from the run's
artifact.

---

### Task 5: `validate` does not answer `gone` while the recorded process runs in its pane

**Depends on:** Task 3 (`processAmong`, and `paneProcesses` on the lookup's "no engine" answer). **Effort:** xhigh
(it decides whether a message or a key is written into a pane: the reused-pid guard, and on Windows the pane's Job).

**Files:**
- Modify: `cli/src/lib/tmuxBackend.ts` (`validate` 579-602, the import on line 67)
- Modify: `cli/src/lib/ptyHostBackend.ts` (`validateOn` and its doc 685-711, the import on line 42)
- Test: `cli/src/lib/tmuxBackendValidate.spec.ts`, `cli/src/lib/ptyHostBackend.spec.ts`

**Interfaces:**
- Consumes: `processAmong` and `PaneProcessLookup`'s `paneProcesses` from Task 3. Both specs mock
  `lookupPaneEngineProcess`, so the tests hand `validate` the answer Task 3's own test proves the lookup gives.

- [ ] **Step 1: Write the tests**

At the end of `cli/src/lib/tmuxBackendValidate.spec.ts`:

```ts
describe('TmuxBackend.validate and a pane that holds only the recorded process (#4259)', () => {
  const BOUND = { pid: 11, executable: 'hermes', startMarker: 'Fri Nov 13 14:22:00 2026' }
  const SHELL = { pid: 10, executable: 'zsh', startMarker: 'Fri Nov 13 14:00:00 2026' }
  const UNSHARE = { ...BOUND, executable: 'unshare' }
  const noEngine = (...paneProcesses: object[]) => ({ ok: false, unknown: false, reason: 'no hermes process under tmux:%42', paneProcesses })
  const GONE = { state: 'gone', reason: 'no hermes process under tmux:%42' }

  it('is alive while the recorded process runs in the pane under another name', async () => {
    lookupPaneEngineProcess.mockResolvedValue(noEngine(SHELL, UNSHARE))
    expect(await new TmuxBackend().validate(PANE, { engine: 'hermes', processIdentity: BOUND })).toEqual({ state: 'alive' })
  })

  it('is gone when that process left the pane, its pid was reused, or none was recorded', async () => {
    lookupPaneEngineProcess.mockResolvedValue(noEngine(SHELL))
    expect(await new TmuxBackend().validate(PANE, { engine: 'hermes', processIdentity: BOUND })).toEqual(GONE)
    lookupPaneEngineProcess.mockResolvedValue(noEngine(SHELL, { ...UNSHARE, startMarker: 'Fri Nov 13 15:00:00 2026' }))
    expect(await new TmuxBackend().validate(PANE, { engine: 'hermes', processIdentity: BOUND })).toEqual(GONE)
    lookupPaneEngineProcess.mockResolvedValue(noEngine(SHELL, UNSHARE))
    expect(await new TmuxBackend().validate(PANE, { engine: 'hermes' })).toEqual(GONE)
  })
})
```

In `cli/src/lib/ptyHostBackend.spec.ts`, before `describe('PtyHostBackend validate on Windows', …)`:

```ts
describe('PtyHostBackend validate, a pane that holds only the recorded process (#4259)', () => {
  const BOUND = { pid: 11, executable: 'hermes', startMarker: 'Fri Nov 13 14:22:00 2026' }
  const SHELL = { pid: 10, executable: 'zsh', startMarker: 'Fri Nov 13 14:00:00 2026' }
  const UNSHARE = { ...BOUND, executable: 'unshare' }
  const noEngine = (...paneProcesses: object[]) => ({ ok: false, unknown: false, reason: 'no hermes process under ptyhost:p1:%1', paneProcesses })
  const GONE = { state: 'gone', reason: 'no hermes process under ptyhost:p1:%1' }

  it('is alive while the recorded process runs in the pane under another name', async () => {
    const { backend } = await ready()
    lookupPaneEngineProcess.mockResolvedValue(noEngine(SHELL, UNSHARE))
    expect(await backend.validate(PANE, { engine: 'hermes', processIdentity: BOUND })).toEqual({ state: 'alive' })
  })

  it('is gone when that process left the pane, its pid was reused, or none was recorded', async () => {
    const { backend } = await ready()
    lookupPaneEngineProcess.mockResolvedValue(noEngine(SHELL))
    expect(await backend.validate(PANE, { engine: 'hermes', processIdentity: BOUND })).toEqual(GONE)
    lookupPaneEngineProcess.mockResolvedValue(noEngine(SHELL, { ...UNSHARE, startMarker: 'Fri Nov 13 15:00:00 2026' }))
    expect(await backend.validate(PANE, { engine: 'hermes', processIdentity: BOUND })).toEqual(GONE)
    lookupPaneEngineProcess.mockResolvedValue(noEngine(SHELL, UNSHARE))
    expect(await backend.validate(PANE, { engine: 'hermes' })).toEqual(GONE)
  })

  it('on Windows holds that process to the pane\'s Job, as it does an engine', async () => {
    const bound = { pid: 11, executable: 'hermes.exe', startMarker: 'w:5' }
    lookupPaneEngineProcess.mockResolvedValue(noEngine({ pid: 10, executable: 'pwsh', startMarker: 'w:1' }, bound))
    const inJob = await ready({ jobPids: { state: 'ok', value: { pids: [10, 11] } } })
    expect(await inJob.backend.validateOn('win32', PANE, { engine: 'hermes', processIdentity: bound })).toEqual({ state: 'alive' })
    const outside = await ready({ jobPids: { state: 'ok', value: { pids: [10] } } })
    expect(await outside.backend.validateOn('win32', PANE, { engine: 'hermes', processIdentity: bound }))
      .toEqual({ state: 'gone', reason: 'process is not in the pane job' })
  })
})
```

- [ ] **Step 2: Run them and see three fail**

Run: `npx vitest run src/lib/tmuxBackendValidate.spec.ts src/lib/ptyHostBackend.spec.ts`
Expected: 3 failed, each `expected { state: 'gone', …(1) } to deeply equal { state: 'alive' }`: the two
`is alive while the recorded process runs…` tests and the Windows one. The two `is gone when…` tests are guards: they
pass before and after.

- [ ] **Step 3: Commit the red tests**

```bash
git add cli/src/lib/tmuxBackendValidate.spec.ts cli/src/lib/ptyHostBackend.spec.ts
git commit -m "Test: validate does not answer gone while the recorded process runs in its pane (#4259)"
```

- [ ] **Step 4: Implement**

- `cli/src/lib/tmuxBackend.ts`, `validate`: on a lookup that found no engine, answer `{ state: 'alive' }` when
  `processAmong(expected.processIdentity, found.paneProcesses)`, before the `unknown`/`gone` answer, which stays as
  it is. Nothing below that line changes (the marker allowance and the `replaced` answer are for a found engine).
  Import `processAmong` beside `sameProcessIdentity`. The comment says why: the process the agent was bound to still
  runs in the pane under another name while its engine loads, and a message sent then was refused as sent to a
  stopped agent (#4259).
- `cli/src/lib/ptyHostBackend.ts`, `validateOn`: the same answer for the same condition. On `win32` the recorded
  process's pid then goes through the Job check that an engine's pid goes through, unchanged: a failed `jobPids` is
  `unknown`, a pid the Job does not hold is `gone` with `process is not in the pane job`. The `replaced` comparison
  is made only for a found engine. Import `processAmong` beside `sameProcessIdentity`, and add one sentence to
  `validateOn`'s doc: the recorded process of a pane with no engine in it is held to the Job as an engine is.
- No other method of either backend changes, nor `terminalBackend.ts`, `terminalBackendCoordinator.ts` or
  `paneEngineProcess.ts`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/tmuxBackend src/lib/ptyHostBackend src/lib/terminalBackend src/lib/terminalAgentReconciler.spec.ts src/core/terminals src/core/input.spec.ts src/architecture.spec.ts`
Expected: all pass, the 5 new tests among them (the contract files skip by themselves). Then `npm run typecheck`:
no output. The `cli-pty` gate is not run here: it runs once, at the final head (Verification check 4).

- [ ] **Step 6: Commit**

```bash
git add cli/src/lib/tmuxBackend.ts cli/src/lib/ptyHostBackend.ts
git commit -m "Terminal backends: validate is alive while the agent's recorded process runs in its pane (#4259)"
```

---

## Verification

Isolation: the repository's guide (`docs/development.md`, "Isolated end-to-end testing") asks for a daemon with its
own `ADAPTER_DATA_DIR`, `HARNESS_AUTH_DIR`, `ADAPTER_COMPUTER_ID_FILE` and port. The CLI's end-to-end harness
(`cli/e2e/harness/daemon.ts`, `IsolatedDaemon`) gives every daemon those, a throwaway home, a private tmux server and
a backend address nothing listens on (`ws://127.0.0.1:9`, signed out); the Hermes is a fake at `HERMES_PATH`. Both
end-to-end checks run on GitHub-hosted Linux runners with a read-only token and no secret. Nothing touches
production, the developer's daemon (port 18473), tmux server or engine homes.

Order: the branch is pushed with the two temporary files (check 2 starts by itself; check 3 once, by hand); then
the one commit that removes them; then check 4 on that final head, before it is pushed. The removal deletes only
those two files, and PR CI runs the unit suite again on the final head.

| # | What to run | Where | What a person should see |
|---|---|---|---|
| 1 | The four code tasks' spec files: `npx vitest run src/lib/terminalAgentDiscovery.wrapperExec.spec.ts src/lib/terminalAgentReconciler.wrapperExec.spec.ts src/lib/terminalRuntime.spec.ts src/lib/paneEngineProcess.spec.ts src/lib/restoreAgents.spec.ts src/lib/tmuxBackendValidate.spec.ts src/lib/ptyHostBackend.spec.ts` in `cli/` | this Mac; PR CI's `cli-tests` and `cli-typecheck` run them and the whole default suite on Linux, nothing to start by hand | all pass; each task's red commit then green commit in the branch history. |
| 2 | The temporary workflow `tmp 4259 wrapper exec` (Task 4). The push of the branch starts it; nothing is started by hand. Read its result for the pushed head (snippet below) | GitHub, `ubuntu-latest` | one run whose head is the pushed head, conclusion `success`, 2 tests passed, none skipped: the agent kept its id through the wrapper's `exec` and the engine's load, moved to the engine, was stopped when the engine ended, and survived a daemon restart taken while only `unshare` was in its pane. Report the run link. |
| 3 | **CLI end to end**, once, by hand, on the same head: `gh workflow run cli-e2e.yml --ref fix/4259-wrapper-exec` (the repo's rule for a change to a user-facing CLI flow, `docs/validation-and-release.md`, "What PR CI does not run"). A heavy run: the main session asks the orchestrator for it before pushing, and starts it only on a yes | GitHub, eight Linux shards and one macOS job | `e2e-summary` green; or, since the suite is advisory, no failing file that the latest nightly run on `main` did not also fail (`gh run list --workflow cli-e2e.yml --branch main --event schedule --limit 1`). It shows that every existing flow that reports an agent stopped, or refuses a message to one, still does. Report the run link, and never start a second run. |
| 4 | The local gate `cli-pty`, required because Task 5 changes `tmuxBackend*` and `ptyHost*` files: `python3 scripts/local-checks.py --run` from the repository root, on a clean tree (nothing uncommitted or untracked) at the final head, after the temporary files are removed. It runs `npm run test:terminal-contract` in `cli/` | this Mac (the gate's platform is macOS); a real tmux server of the test's own, no daemon and no backend | exit 0 and one `harness-local-checks` fence naming `cli-pty`, the final head, `passed` and a test count (6 when planning; the pty host half of the contract skips itself unless `HARNESS_PTY_BIN` names a built host). Paste the fence into the pull request body. A commit after it voids it: run it again. |

```bash
# 2: from the feature worktree, after the push; HEAD is the pushed head
gh run list --workflow tmp-4259-wrapper-exec.yml --branch fix/4259-wrapper-exec --commit "$(git rev-parse HEAD)" \
  --json databaseId,headSha,status,conclusion,url
gh run watch RUN_ID --exit-status          # RUN_ID is the databaseId above; waits, exit 0 on success
gh run view RUN_ID --log | grep -E "Tests +[0-9]+|skipped|✓|×"
```

Checks the repository requires and PR CI does not run: one, `cli-pty` (check 4).
`python3 scripts/local-checks.py --list` on every file of this plan (the seven source files, their specs, the two
temporary files and the two `docs/plans` files) prints `cli-pty` alone, `npm run test:terminal-contract` in `cli/`
on macOS (checked 2026-11-13). The four backend files of Task 5 select it (`cli/src/lib/tmuxBackend*`,
`cli/src/lib/ptyHost*`); no other path here selects a gate: `terminalRuntime*`, `paneEngineProcess*`,
`restoreAgents*`, `terminalAgentDiscovery*` and `terminalAgentReconciler*` print `{}`, so the coverage gates
(`test:core`, `test:harnessd`, `test:resume` and the rest) and `cli-shell` are not required. If a task ever touches
a file under `cli/src/core/`, `cli/src/services/`, or a `resumeAgentService*` file, the same command then also runs
`cli-core` or `cli-resume` and prints their receipts in the same fence.

Not checked end to end, and why: `validate` by itself (its three readers are covered at their own layer: the two
backends' tests in Task 5, the lookup's answer in Task 3, and check 3 for the flows that type into an agent; a
message sent while the pane holds only `unshare` then meets the message writer's own hold for a screen with no
composer on it, read in the code and not run, so what a person would see of it depends on how long the engine
loads, not on this change alone); Windows (it has no `exec`, the rules are plain
functions over the rows every platform's table gives, and the one Windows branch, the pane's Job, is tested with the
platform handed in, `validateOn('win32', …)`; the unit tests are the evidence); a real lamp and a real Hermes
(lampOS's own handling of `stopped` is lampOS #6432, and the fake runs the same process shape: `sh hermes`, then
`unshare` with the same pid, then the engine as its child). The pull request names the platforms (macOS and Linux by
the unit suite, Linux by check 2, macOS by check 4, Windows not run), each task's red then green commits, the
discovery pass's before and after numbers from Task 1, the run links of checks 2 and 3, and check 4's fence.
