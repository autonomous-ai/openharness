# CLI end-to-end regressions on main: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **devcrew phase 3**. Two pull requests, two branches: Tasks 1 to 6
> are PR1, Tasks 7 and 8 are PR2. Tasks 1, 2, 3, 4, 5 and 7 are test-first: a red commit (the tests alone), then the
> code commit. Tasks 6 and 8 change tests only and are one commit each. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `cli-e2e.yml` is green on `main` again: races, modelSwitch, adopt, hookclient, diskfull and updateHostile
(PR1), viewersProcess and workspacesProcess (PR2).

**Architecture:** PR1 keeps every intent of #4356 (strict saves, explicit choices wait for a durable save) and
removes five side effects of it: a launch marked `ready` no longer reads as another launch; restore records the
engine it probed before its settle window; the reconciler outlives a storage outage; a full disk is named by its
error code; a create the storage refuses answers so, with one pane. PR2 stops the viewers process from restarting
every viewer at a core restart, and fixes one test's order. No change to the core's files list, to `register`, to
`namesTheDisk`, or to any stored format.

**Tech Stack:** TypeScript, Vitest 4.1.10, Node (CI pins 24.22.2), tmux, zsh; `hdiutil` for the full-disk tests
(macOS). No new dependency.

**Spec:** [docs/plans/2026-11-17-main-e2e-regressions-design.md](2026-11-17-main-e2e-regressions-design.md). Read it
with this plan, the root `AGENTS.md`, `cli/AGENTS.md` and `docs/design/2026-11-16-registry-persistence.md`. The spec
is the authority; where this plan differs from it, "Found while reading the code" says why and "Open questions"
asks. PR1: branch `fix/main-e2e-regressions`, on `main` at `1e17b388ce`.

## Decided

By the PM, 2026-11-17 (the spec and the brief). Not reopened:

1. Keep #4356's rule: a rename while the disk is full is refused with `PERSISTENCE_UNCONFIRMED` and applies nothing.
   `e2e/diskfull.e2e.ts` is fixed to that.
2. A create while the disk is full answers `PERSISTENCE_UNCONFIRMED` naming the disk, not `REGISTRATION_FAILED`
   after three panes. The "name storage" `unhandledRejection` goes.
3. Three pull requests. PR1, `fix/main-e2e-regressions`: causes A to E. PR2, `fix/viewers-core-restart`, cut from
   `origin/main` in a worktree of its own: causes F and G. PR3 (macOS only) is not in this plan.
4. Cause B is high risk: red test first, effort `xhigh`.

The plan's own, each from what the code showed (5 to 8 from prototypes run and reverted, "Dry run" below):

5. **B, ownership after the record:** the watch follows the published row by its receipt (`matchesLaunchReceipt`),
   not by `restoreOwner`. `restoreOwner` compares `boundAt`, and a reopened or adopted conversation (session set,
   `boundAt` null: the adopt test's row) is stamped by its own hook in the settle window. With `restoreOwner` the
   watch then ended in silence and the pane's hold was never cleared.
6. **B, the fallback:** an engine that dies in the settle window is forgotten (`clearProcessIdentity`) before the
   fresh launch. Left on the row, the watcher's own guard (`restoreAgents.ts:938`) took the fresh engine for a
   stranger: the row ended with no conversation, a dead process and `ready`, its hold never cleared.
7. **C, "once per outage" is per pass, not per batch.** A pass has two batches, and the first has usually nothing
   of its own to save. Reset per batch, the line printed every 5 s.
8. **C says no "saved again" line.** A batch that resolves may have written nothing; the reconciler cannot know.
9. **E gap 2 is cause C** (below). It has its own red case in Task 3 and its end-to-end assertion in Task 6.
10. **E gap 1 covers every create, not `agent_create` alone:** the three-pane retry is in
    `createAndRegisterPane`, shared by create, fork, guest create, terminal open and external resume. Resume
    (`resumePendingAgent`, one attempt, `RESUME_UNCONFIRMED`) is left as it is.
11. **New spec files** where it keeps tasks apart: `registry.launchIdentity.spec.ts` (A),
    `restoreAgents.settle.spec.ts` (B), `registry.diskFailure.spec.ts` (D).
12. `e2e/diskfull.e2e.ts` loses its fixed 15 s sleep: the rename is durable at its reply now. It waits for the
    full disk's holds to clear instead, as `e2e/hookclient.e2e.ts` does.

## Questions, answered

Answered by the PM on 2026-11-17: 1, the draft (the PR states that it reverses #4356's "settle first" rule, and
why); 2, yes; 3, `failed`; 4, the draft. Each "draft assumes" below is therefore the decision.

1. **B reverses a rule #4356 wrote down on purpose.** `docs/design/2026-11-16-registry-persistence.md:404` says of
   this watcher: "Settle first, then strictly publish". Two tests pin it (`restoreAgents.spec.ts:906` and `:1127`).
   The spec says #4356's intents stay, and also says to publish before the settle window. **The draft assumes** the
   spec: the strict `confirmLaunch` moves before the settle window, the doc row and both tests are corrected in
   Task 2. The smaller alternative: record only the process first (the plain `updateProcessIdentity`, as before
   #4356 and as restore still does for a live engine, `restoreAgents.ts:483`) and keep the strict `ready` after
   settle. Which? **Recommended:** the draft. It is one writer of the process, as #4356 wanted, and it is the
   shape the dry run below proved.
2. **`e2e/updateHostile.e2e.ts:618` pins `(listen ENOSPC`, and the spec does not name it.** Since #4356 the core's
   strict startup save (`core/main.ts:611`) fails before the socket claim, so the reason is the registry's. D
   alone gets the test past its wait and fails it on that line. **The draft assumes** the line is relaxed to "the
   reason carries `ENOSPC`" (Task 4). Agreed? **Recommended:** yes; without it updateHostile stays red.
3. **A create the storage refuses, sent with a `creationId`:** the receipt records it `failed` with code
   `PERSISTENCE_UNCONFIRMED` (**the draft's assumption**: no change to `core/agents/launches.ts:204`), or
   `unconfirmed`, as `REGISTRATION_FAILED` is? The pane's close is best effort either way. **Recommended:**
   `failed`: nothing was saved, and a person who frees room should be told they may try again.
4. **Each branch's run is red on the other pull request's tests.** On PR1's branch viewersProcess and
   workspacesProcess still fail (shards 2 and 7 in run 44045512447); on PR2's the six of PR1 do. **The draft
   assumes** each run is judged on its own named tests and on no failure outside the other's list, and the
   nightly run on `main` after both merge shows the workflow green: two runs by hand. Or: merge the first, rebase
   the second, and wait for its all-green run? **Recommended:** the draft; neither pull request waits on the other.

## Global Constraints

- #4356's intents stay: saves are strict, an explicit choice is answered after its durable save.
- `register` is not changed (spec, A). `namesTheDisk` is not changed (spec, D). F changes the viewers process only.
- No file is added to the core's process: `cli/src/architecture.coreFiles.txt` is not touched (new files are specs).
- Error and log text carries fixed categories only: no path, no file content, no name (`registry.ts:567`).
- No fixed sleeps: a deadline with `until`, a gate, or a clock the test moves. A flaky test is a bug.
- Comments say why, in plain sentences, with the incident and its date (`cli/AGENTS.md`, rule 7).
- `cli/src/core/` and `cli/src/services/` stay at 100% per file (`npm run test:core`).
- Tests use a throwaway home and data folder and a private tmux server: never the developer's daemon (port
  18473), `~/.claude`, `~/.codex` or tmux server (`cli/AGENTS.md`, rule 6). End-to-end daemons are `IsolatedDaemon`.
- Platforms: shared TypeScript, so macOS, Linux and Windows. The full-disk tests run on macOS only.
- The spec and this plan ship with PR1. PR2's branch does not carry them: its workers read them at this checkout.

## Found while reading the code

Each of the spec's claims, against the code at `1e17b388ce`.

- **A, confirmed.** `confirmLaunch` writes `launch: { state: 'ready' }` (`registry.ts:2005`); `register` rebuilds
  the row with no `launch` (`:2335`; a `resumeOnly` row keeps `ready`, `:2412`). `launchIdentity` (`:91`) and the
  launch authority (`core/agents/launchAuthority.ts:5`) compare `launch` whole. The sketch
  `zzScratchLaunchFlip.spec.ts` is red: the receipt's launch is `ready`, the row's is gone.
- **A, `restoreOwner`:** the watcher itself starts from `starting` (`restoreAgents.ts:751`), so there the rule
  changes nothing. It matters at the survey (`:438`): a live engine's hook during the survey drops `ready`, the
  row is skipped and not re-identified. Red test found (Task 1).
- **B, confirmed, with the path corrected:** the file is `cli/src/lib/restoreAgents.ts`, not `core/agents/`. Settle
  at `:944`, `confirmLaunch` at `:959`. Hooks wait on the row's recorded process, up to 20 s
  (`core/engines/hooks.ts:47`, `recordChanged`). CI run 44045512447: restore at `:28.733`, message at `:29.119`,
  SessionStart handled at `:39.340`, "engine up · 10620ms".
- **C, confirmed.** `setInterval(() => { void this.trigger() })` (`terminalAgentReconciler.ts:170`); the two
  `transaction` calls (`:321`, `:495`); `resolveHookAgent` rethrows all but `RegistryOwnershipChanged`
  (`core/engines/hooks.ts:164`). The same rejection is dropped at `core/main.ts:1296`, `core/engines/hooks.ts:242`
  and `lib/stopAgentService.ts:261`: one fix in the pass covers all four.
- **D, confirmed.** `persistenceFailure` (`registry.ts:568`), `namesTheDisk` (`harnessd/supervisor.ts:225`). See
  open question 2 for the line the spec missed.
- **E gap 1, wider than the spec says.** Two places make it: `openPendingAgent` turns every failure into `null`
  (`registry.ts:1946`), and `createAndRegisterPane` reads `null` as a taken route and tries three panes
  (`lib/createAgentPane.ts:27`, `:183`). Two tests pin the `null` (`registry.persistence.spec.ts:334`,
  `registry.externalResume.spec.ts:194`).
- **E gap 2 is cause C, not a second caller.** The stack in the daemon's log is `persistNames` ←
  `persist` (`registry.ts:3353`) ← the transaction's batch save (`:3142`). A refused rename leaves the names marked
  unsaved (`:3681`), so the next batch tries the names first and fails under that subject. Its promise is the
  reconcile pass's. `saveNames`, `rename`, `flush` and `afterTransaction`'s callers all handle theirs.
- **F, confirmed.** `services/viewers.ts:153-157`. `DshViewerManager.start` is a no-op for the same harness and
  folder and replaces on another (`dsh/viewer.ts:213-217`); `DshVerdictWatcher.watch` is a no-op for the same file.
- **G, confirmed.** The fault exits 200 ms after start (`services/process.ts:169`); the test creates its agent
  before the park (`e2e/workspacesProcess.e2e.ts:168-169`).

**Dry run.** Every unit test in this plan was put in place as written and run at `1e17b388ce`: 18 fail, the ones
each task names. With a throwaway version of each change, and the corrections to existing cases that Tasks 2 and 5
list, the 118 spec files nearest the changes pass and `tsc` is clean. All of it was reverted: none of it is in the
tree. No end-to-end file was run in planning.

Sketches from the diagnosis (not committed, a reboot may clear them): `zzScratchLaunchFlip.spec.ts`,
`zzScratchOutage.spec.ts` and `zzScratchRestoreSettle.spec.ts` under
`/private/tmp/claude-503/-Users-duynguyen-orca-workspaces-autonomous-harness-main-e2e-regress/3fa64f66-1088-4d39-bb71-97c19dd03370/scratchpad/red-specs/`.
This plan carries what it needs of them.

## File map

| Task | PR | File | What |
|---|---|---|---|
| 1 | 1 | `cli/src/lib/registry.launchIdentity.spec.ts` (new) | red: a receipt outlives the engine's own re-registration |
| 1 | 1 | `cli/src/core/agents/launchAuthority.spec.ts`, `cli/src/lib/restoreAgents.spec.ts` | red: the authority, the survey |
| 1 | 1 | `cli/src/lib/registry.ts` (`launchIdentity`), `cli/src/core/agents/launchAuthority.ts`, `cli/src/lib/restoreAgents.ts` (`restoreOwner`) | the rule, three times |
| 2 | 1 | `cli/src/lib/restoreAgents.settle.spec.ts` (new) | red: the settle window |
| 2 | 1 | `cli/src/lib/restoreAgents.spec.ts`, `cli/src/lib/registry.launchCallers.spec.ts` | two cases that pinned the old order; one title |
| 2 | 1 | `cli/src/lib/restoreAgents.ts` (`watchRestoredPane`) | record first, settle after |
| 2 | 1 | `docs/design/2026-11-16-registry-persistence.md` | the watcher's row |
| 3 | 1 | `cli/src/lib/terminalAgentReconciler.spec.ts`, `cli/src/lib/terminalAgentReconciler.ts` | a pass outlives a storage outage |
| 4 | 1 | `cli/src/lib/registry.diskFailure.spec.ts` (new), `cli/src/lib/registry.ts` (`persistenceFailure`) | the code in the category |
| 4 | 1 | `cli/e2e/updateHostile.e2e.ts` | one assertion, one comment |
| 5 | 1 | `cli/src/lib/createAgentPane.spec.ts`, `cli/src/lib/createAgentPane.ts`, `cli/src/lib/registry.ts` (`openPendingAgent`) | one pane, a named answer |
| 5 | 1 | `cli/src/lib/registry.persistence.spec.ts`, `cli/src/lib/registry.externalResume.spec.ts` | two cases that pinned `null` |
| 6 | 1 | `cli/e2e/diskfull.e2e.ts` | the PM's rule |
| 7 | 2 | `cli/src/services/viewers.spec.ts`, `cli/src/services/viewers.ts`, `docs/design/2026-11-16-frame-parts.md` | a new lease keeps the viewer |
| 8 | 2 | `cli/e2e/workspacesProcess.e2e.ts` | the agent is created after the park |

Shared files, and the order that keeps them apart: `registry.ts` is Tasks 1, 4, 5 (in that order);
`restoreAgents.ts` and `restoreAgents.spec.ts` are Tasks 1, 2. Nothing else is shared. PR1 and PR2 share no file.

```
PR1:  1 ──► 2            3 ─────────┐
      └───► 4 ──► 5 ────────────────┴──► 6
PR2:  7      8
```

## Review Focus

Most likely first. Each has its test in the task that owns the code.

1. **A reopened or adopted conversation in the settle window** (session set, `boundAt` null): its hook stamps the
   row, and the watch must still clear the hold. Task 2, "a reopened conversation, bound but never stamped…".
2. **An engine that dies in the settle window after it was recorded:** the fresh engine must be recorded in its
   place, not taken for a stranger. Task 2, "an engine that dies in the settle window is forgotten…".
3. **A pass whose first batch saves and whose second is refused,** the real shape of an outage: one log line for
   the outage, not one a pass. Task 3, "says so once for an outage, and again for the next one".
4. **The catch swallowing what must still fail:** an owner that changed (the hook path waits on it,
   `core/engines/hooks.ts:164`) or any other error. Task 3, "still fails the pass for…"; Task 5, "a taken route
   still answers null" and the existing three-attempt case.
5. **A rule reaching too far.** A launch that is `starting`, `held` or `failed` must still read as another
   launch: Task 1, "a launch that did change still ends the receipt", and `launchAuthority.spec.ts`'s existing
   `held`. A storage failure that is not the disk (`EIO`, `EACCES`) must not name it, or the master keeps a broken
   build: Task 4, "a save refused with %s still does not name the disk".

One the plan does not pin, for the reviewer: a fresh engine whose first hook also brings a Codex profile home the
row did not have changes `origin` (`restoreAgents.ts:784`) and is refused by `selectFirstHook`. That is today's
rule; B makes a first hook in the settle window the usual case. See "Left out".

---

# PR1: registry persistence (#4356)

Branch `fix/main-e2e-regressions`. All commands from `cli/`.

### Task 1: A launch marked `ready` and no launch are the same launch (cause A)

**Depends on:** nothing. **Effort:** high.

**Files:**
- Create: `cli/src/lib/registry.launchIdentity.spec.ts`
- Modify: `cli/src/core/agents/launchAuthority.spec.ts`
- Modify: `cli/src/lib/restoreAgents.spec.ts` (one new case in "restoreAgents — which agents get a pane back")
- Modify: `cli/src/lib/registry.ts:91-94`, `cli/src/core/agents/launchAuthority.ts:5-10`,
  `cli/src/lib/restoreAgents.ts:273-282`

**The tests that fail before the change:** `registry.launchIdentity.spec.ts`, "a relaunched engine
re-registering…"; `launchAuthority.spec.ts`, "keeps its target when a ready launch…" (both rows);
`restoreAgents.spec.ts`, "re-identifies a live row whose engine's hook dropped its ready launch…".

**Interfaces:**
- Produces: `matchesLaunchReceipt(row, receipt)` (`registry.ts:97`) is true across `launch: { state: 'ready' }`
  and no `launch`. Task 2 relies on it.

- [ ] **Step 1: The registry's red test.** `cli/src/lib/registry.launchIdentity.spec.ts`, on the real `registry`:

```ts
import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registry, matchesLaunchReceipt } from './registry.js'
import { removeRegistryAgent } from '../testing/registryFixtures.js'

const runtime = { backend: 'tmux' as const, paneId: '%70' }
const first = { pid: 7001, startMarker: 'one', executable: '/fixture/codex' }
const second = { pid: 7002, startMarker: 'two', executable: '/fixture/codex' }
const id = '33333333-3333-4333-8333-333333333333'
let directory = ''
afterEach(async () => {
  for (const entry of registry.list()) await removeRegistryAgent(registry, entry.agentId)
  await registry.flush()
  rmSync(directory, { recursive: true, force: true })
})

/** An agent bound to a conversation, then relaunched: its launch is published `ready` (restart.ts). */
async function relaunched() {
  directory = mkdtempSync(join(tmpdir(), 'launch-identity-'))
  const home = join(directory, 'codex'), transcript = join(home, 'sessions', `rollout-${id}.jsonl`)
  mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id, cwd: directory, source: 'cli' } }) + '\n')
  const hook = (processIdentity: typeof first) => registry.register({ engine: 'codex', sessionId: id, transcriptPath: transcript,
    codexHome: home, cwd: directory, runtimes: [runtime], processIdentity }, { verifiedNativeSource: true })
  const admitted = (await registry.openPendingAgent({ engine: 'codex', runtimes: [runtime], cwd: directory, codexHome: home }))!
  registry.updateProcessIdentity(admitted.agentId, first)
  await registry.flush()
  expect(await hook(first)).not.toBeNull()
  expect((await registry.confirmLaunch(admitted.agentId, { processIdentity: second, grid: null })).state).toBe('confirmed')
  return { agentId: admitted.agentId, hook }
}

it('a relaunched engine re-registering its own conversation leaves the next request\'s target unchanged', async () => {
  const { agentId, hook } = await relaunched()
  // A second restart, queued behind the first, captures its target now (restart.ts).
  const target = structuredClone(registry.byAgent(agentId)!)
  expect(target.launch).toEqual({ state: 'ready' })
  // The relaunched engine's own SessionStart commits after (hookServer.ts).
  expect(await hook(second)).not.toBeNull()
  expect(registry.byAgent(agentId)!.launch).toBeUndefined()
  expect(matchesLaunchReceipt(registry.byAgent(agentId), target)).toBe(true)
})

it('a launch that did change still ends the receipt', async () => {
  const { agentId } = await relaunched()
  const target = structuredClone(registry.byAgent(agentId)!)
  registry.setLaunch(agentId, { state: 'starting', nativeToken: '11111111-1111-1111-1111-111111111111' })
  expect(matchesLaunchReceipt(registry.byAgent(agentId), target)).toBe(false)
})
```

- [ ] **Step 2: The authority's red test.** In `launchAuthority.spec.ts`, beside "revokes after changed launch facts":

```ts
  it.each([
    [{ state: 'ready' }, undefined],
    [undefined, { state: 'ready' }],
  ] as const)('keeps its target when a ready launch is written %j and read %j', (before, after) => {
    const row = agent()
    if (before) row.launch = { ...before }
    const current = createLaunchAuthority({ byAgent: () => row, revision: () => 1, cancelled: () => false })(row.agentId)
    if (after) row.launch = { ...after }; else delete row.launch
    expect(current()).toBe(true)
  })
```

- [ ] **Step 3: The survey's red test.** In `restoreAgents.spec.ts`, after "leaves a pane that still runs its engine alone…":

```ts
  it('re-identifies a live row whose engine\'s hook dropped its ready launch during the survey', async () => {
    const h = harness([row()], { livePanes: ['%3'], alivePanes: ['%3'] })
    const live = h.deps.liveProcess
    // What a hook's registration does to the row (registry.ts `register`): no `launch`.
    h.deps.liveProcess = async (entry, runtime) => { delete h.rows.get('agent-a')!.launch; return live(entry, runtime) }
    await restoreAgents(h.deps)
    expect(h.calls).toContain('updateIdentity:agent-a:1003')
  })
```

- [ ] **Step 4: See them fail.**

Run: `npx vitest run src/lib/registry.launchIdentity.spec.ts src/core/agents/launchAuthority.spec.ts src/lib/restoreAgents.spec.ts`
Expected: 4 failed (the first registry case with `expected false to be true`; the two authority rows; the survey
case with `expected [] to include 'updateIdentity:agent-a:1003'`). "a launch that did change…" passes. Commit the
three spec files (red).

- [ ] **Step 5: The rule, in the three places that compare a launch.** In each, `launch` is read as

```ts
row.launch?.state === 'ready' ? undefined : row.launch
```

(`row?.launch` in `launchIdentity`, where `row` may be undefined). One comment, on `launchIdentity`, says why: a
launch published `ready` and the row a hook's registration rebuilds without one are the same launch; read apart,
the second of two restarts took the engine down and answered `AGENT_CHANGED` (e2e/races.e2e.ts, 2026-11-17). The
other two name `launchIdentity` in a short comment. Nothing else changes: not `register`, not `ownershipIdentity`.

- [ ] **Step 6: See them pass, and nothing else move.**

Run: `npx vitest run src/lib/registry src/core/agents src/lib/restoreAgents.spec.ts && npm run typecheck`
Expected: every file passed. Commit.

---

### Task 2: Restore records the engine it probed before the settle window (cause B)

**Depends on:** Task 1 (the receipt must outlive the engine's own registration; and both edit `restoreAgents.ts`).
**Effort:** xhigh (concurrency in the restore path: a watcher, the engine's hooks, Stop and discovery on one row).

**Files:**
- Create: `cli/src/lib/restoreAgents.settle.spec.ts`
- Modify: `cli/src/lib/restoreAgents.spec.ts:906-918`, `:1127-1147`
- Modify: `cli/src/lib/registry.launchCallers.spec.ts:567` (the title only)
- Modify: `cli/src/lib/restoreAgents.ts:934-974` (`watchRestoredPane`, the branch that found an engine)
- Modify: `docs/design/2026-11-16-registry-persistence.md:404`

**The tests that fail before the change** (with Task 1 in): in `restoreAgents.settle.spec.ts`, "records the probed
engine before the settle window…", "the restored engine registering its own conversation…", "a reopened
conversation, bound but never stamped…", "an engine that dies in the settle window is forgotten…". The other two
cases there pass before and after: they are the fences.

**Interfaces:**
- Consumes: Task 1's `matchesLaunchReceipt`.
- Produces: no new name. From first sight of its engine a restored row has `processIdentity` and
  `launch: { state: 'ready' }`; the pane's hold (`clearRemainOnExit`) and the route's hold (`release`) last
  through the settle window as today.

- [ ] **Step 1: The red tests.** `cli/src/lib/restoreAgents.settle.spec.ts`, on the real `registry`. Only the settle
window's own `sleep` moves the clock, and it waits for the test:

```ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registry, type RegisteredSession } from './registry.js'
import { removeRegistryAgent } from '../testing/registryFixtures.js'
import { restoreAgents, type RestoreAgentsDeps } from './restoreAgents.js'

const runtime = { backend: 'tmux' as const, paneId: '%70' }
const before = { pid: 7001, startMarker: 'before', executable: '/fixture/codex' }
const engine = { pid: 7002, startMarker: 'restored', executable: '/fixture/codex' }
const fresh = { pid: 7003, startMarker: 'fresh', executable: '/fixture/codex' }
const token = '11111111-1111-1111-1111-111111111111'
const id = '33333333-3333-4333-8333-333333333333'
let directory = '', home = '', transcript = ''

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  directory = mkdtempSync(join(tmpdir(), 'restore-settle-'))
  home = join(directory, 'codex'); transcript = join(home, 'sessions', `rollout-${id}.jsonl`)
  mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id, cwd: directory, source: 'cli' } }) + '\n')
})
afterEach(async () => {
  vi.useRealTimers()
  for (const entry of registry.list()) await removeRegistryAgent(registry, entry.agentId)
  await registry.flush()
  rmSync(directory, { recursive: true, force: true })
})

const gate = () => { let open!: () => void; const reached = new Promise<void>(resolve => { open = resolve }); return { reached, open } }
/** The engine's own hook, as the hook server commits it. */
const hook = (process = engine) => registry.register({ engine: 'codex', sessionId: id, transcriptPath: transcript, codexHome: home,
  cwd: directory, runtimes: [runtime], processIdentity: process }, { verifiedNativeSource: true })

/** A pane whose launch an earlier daemon dispatched: restore watches it for its engine. */
async function starting(bound: boolean): Promise<RegisteredSession> {
  const row = (await registry.openPendingAgent({ engine: 'codex', runtimes: [runtime], cwd: directory, codexHome: home, nativeToken: token }))!
  if (bound) {
    registry.updateProcessIdentity(row.agentId, before)
    expect(await hook(before)).not.toBeNull()
    registry.clearProcessIdentity(row.agentId)
    registry.setLaunch(row.agentId, { state: 'starting', nativeToken: token })
  }
  await registry.flush()
  return registry.byAgent(row.agentId)!
}

function watch(over: Partial<RestoreAgentsDeps> = {}) {
  const settling = gate(), settle = gate(), finished = gate()
  const deps = {
    registry, livePane: async () => true, liveProcess: async () => null, waitingPane: async () => false,
    buildLaunch: async () => ({ argv: ['fixture-engine'] }), createPane: async () => ({ ok: true, runtime }),
    respawn: async () => ({ ok: true }), probeProcess: async () => engine, paneState: async () => ({ dead: false, engineExit: null }),
    clearRemainOnExit: vi.fn(async () => {}), holdRoute: () => finished.open, releaseRoute: finished.open, triggerHint: async () => {},
    log: vi.fn(), settleMs: 10_000,
    sleep: async (ms: number) => { settling.open(); await settle.reached; vi.setSystemTime(Date.now() + ms) },
    ...over,
  } as RestoreAgentsDeps
  return { deps, settling: settling.reached, settle: settle.open, finished: finished.reached }
}

it('records the probed engine before the settle window, and keeps the terminal held through it', async () => {
  const row = await starting(true)
  const w = watch()
  await restoreAgents(w.deps)
  await w.settling
  expect(registry.byAgent(row.agentId)).toMatchObject({ processIdentity: engine, launch: { state: 'ready' } })
  expect(w.deps.clearRemainOnExit).not.toHaveBeenCalled()
  let released = false
  void w.finished.then(() => { released = true })
  await Promise.resolve()
  expect(released).toBe(false)
  w.settle(); await w.finished
  expect(w.deps.clearRemainOnExit).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(w.deps.log).toHaveBeenCalledWith(expect.stringContaining('engine up')))
})

it('the restored engine registering its own conversation in the settle window does not end the watch', async () => {
  const row = await starting(true)
  const w = watch()
  await restoreAgents(w.deps)
  await w.settling
  expect(await hook()).not.toBeNull()
  expect(registry.byAgent(row.agentId)?.launch).toBeUndefined()
  w.settle(); await w.finished
  expect(w.deps.clearRemainOnExit).toHaveBeenCalledOnce()
})

it('a reopened conversation, bound but never stamped, keeps its watch when its hook stamps it in the settle window', async () => {
  const bound = await starting(true)
  const saved = structuredClone(bound)
  await removeRegistryAgent(registry, bound.agentId)
  expect(await registry.resumePendingAgent(saved, [runtime], token)).toMatchObject({ sessionId: id, boundAt: null })
  const w = watch()
  await restoreAgents(w.deps)
  await w.settling
  expect(await hook()).not.toBeNull()
  expect(registry.byAgent(bound.agentId)?.boundAt).not.toBeNull()
  w.settle(); await w.finished
  expect(w.deps.clearRemainOnExit).toHaveBeenCalledOnce()
})

it('a fresh engine whose first hook binds in the settle window is accepted', async () => {
  const row = await starting(false)
  const w = watch()
  await restoreAgents(w.deps)
  await w.settling
  expect(await hook()).not.toBeNull()
  w.settle(); await w.finished
  expect(w.deps.clearRemainOnExit).toHaveBeenCalledOnce()
  expect(registry.byAgent(row.agentId)).toMatchObject({ sessionId: id, processIdentity: engine })
})

it('an engine that dies in the settle window is forgotten, and the fresh launch is recorded in its place', async () => {
  const row = await starting(true)
  let died = false, respawned = false
  const w = watch({
    probeProcess: async () => respawned ? fresh : died ? null : engine,
    paneState: async () => { if (respawned) return { dead: false, engineExit: null }; died = true; return { dead: true, engineExit: 1 } },
    respawn: async (_runtime, _launch, control) => { await control?.onDispatch?.(); respawned = true; return { ok: true } },
  })
  await restoreAgents(w.deps)
  await w.settling
  expect(registry.byAgent(row.agentId)?.processIdentity).toEqual(engine)
  w.settle(); await w.finished
  expect(registry.byAgent(row.agentId)).toMatchObject({ sessionId: '', processIdentity: fresh, launch: { state: 'ready' } })
  expect(w.deps.clearRemainOnExit).toHaveBeenCalledOnce()
})

it('another conversation taking the row in the settle window ends the watch with the terminal still held', async () => {
  const row = await starting(true)
  const w = watch()
  await restoreAgents(w.deps)
  await w.settling
  registry.byAgent(row.agentId)!.sessionId = 'replacement-conversation'
  w.settle(); await w.finished
  expect(w.deps.clearRemainOnExit).not.toHaveBeenCalled()
  expect(registry.byAgent(row.agentId)?.sessionId).toBe('replacement-conversation')
})
```

- [ ] **Step 2: See them fail.**

Run: `npx vitest run src/lib/restoreAgents.settle.spec.ts`
Expected: 4 failed, 2 passed, in under 2 s (no real wait). The first fails on `processIdentity`: `null`. Commit (red).

- [ ] **Step 3: Record first, settle after.** In `watchRestoredPane`, the branch `if (identity) { … }`. The guard at
its top (`:937-939`) and `relaunchFresh` are not changed. The rest runs in this order:

```ts
        const expires = …                                  // as today
        const refresh = async () => { … }                  // as today
        let publication: LaunchPublication
        try { publication = await deps.registry.confirmLaunch(agentId, { processIdentity: identity, grid }, { current, refresh, expires }) }
        catch (error) { … }                                // as today: the first-hook retry
        const ready = publication.state === 'confirmed' ? publication.entry : null
        if (!lifecycle() || !ready || !matchesLaunchReceipt(deps.registry.byAgent(agentId), ready)) return
        // From here the watch follows the row it published.
        current = () => lifecycle() && matchesLaunchReceipt(deps.registry.byAgent(agentId), ready)
        const settled = await waitForSettle(deps, runtime, settleMs)
        if (!current() && !selectFirstHook(identity)) return
        if (settled === 'gone') {
          current = restoreOwner(deps, deps.registry.byAgent(agentId)!)
          deps.registry.clearProcessIdentity(agentId)
          if (!await relaunchFresh()) return
          delayMs = 50
          continue
        }
        await deps.clearRemainOnExit(runtime, current)
        if (!current()) return
        release()                                          // then the hint and the log, as today
```

Three comments carry the why:
- at the publication: hooks wait for a recorded process (`core/engines/hooks.ts`), so recorded only after the
  settle window, a turn sent in it was folded as history and no live `turn_ended` reached the window
  (e2e/adopt.e2e.ts, 2026-11-17). The hold and the route stay through the window: that, not the record, is what
  keeps a rejected resume's pane.
- at `current = …receipt`: the receipt, not `restoreOwner`, because a reopened conversation's hook stamps `boundAt`.
- at `clearProcessIdentity`: left on the row, the guard above took the fresh engine for a stranger's.

- [ ] **Step 4: The two cases that pinned the old order.** In `restoreAgents.spec.ts`:

`:916` ("launches a held agent into the pane it waits in…"): the row can read `ready` by this line now. Assert the
dispatch's own mark instead:

```ts
    expect(h.calls).toContain('setLaunch:gridded:starting')
```

`:1139-1142` ("treats an engine that appears and then exits inside the settling window…"): the first engine is
recorded, then forgotten. Replace the `slice(0, 4)` assertion and the `not.toContain` line with:

```ts
    expect(tail.slice(0, 6)).toEqual(['updateIdentity:agent-a:7', 'clearIdentity:agent-a',
      'inheritName:session-a->agent-a', 'unbind:session-a', 'hold:tmux\u0000%0', 'respawn:%0:claude'])
```

The lines after it (`updateIdentity:agent-a:8`, `clearRemainOnExit:%0` after the respawn, `ready`) stay.

In `registry.launchCallers.spec.ts:567`, the title becomes `'restore keeps the probed process held until its
publication completes'`. Its body is not changed.

- [ ] **Step 5: See everything pass.**

Run: `npx vitest run src/lib/restoreAgents.settle.spec.ts src/lib/restoreAgents.spec.ts src/lib/registry.launchCallers.spec.ts src/core/agents src/lib/hostMove src/lib/resume src/lib/stopAgent && npm run typecheck`
Expected: every file passed. In planning, the two cases of Step 4 were the only ones this change failed.

- [ ] **Step 6: The design's row.** `docs/design/2026-11-16-registry-persistence.md:404`, third column, becomes:

> Strictly publish the exact process/ready state at first sight, with a fresh probe, so the engine's own hooks
> bind while it settles (2026-11-17: published after the window, a turn sent in it was folded as history,
> e2e/adopt.e2e.ts). Keep the terminal hold and the route through the settle window; an engine that dies in it is
> forgotten and falls back. Shell success/fallback must publish before clearing its hold. The earlier
> `summary.restored` means allocation/dispatch began; it must not be represented as ready.

Commit (code, the two specs, the doc).

---

### Task 3: A reconcile pass outlives a storage outage (cause C, and E's unhandled rejection)

**Depends on:** nothing. **Effort:** high.

**Files:**
- Modify: `cli/src/lib/terminalAgentReconciler.spec.ts` (a new `describe` at the end)
- Modify: `cli/src/lib/terminalAgentReconciler.ts:170`, `:265-270`, `:321`, `:495`

**The tests that fail before the change:** "finishes and answers the hook that asked for it when %s cannot be
saved" (three rows) and "says so once for an outage, and again for the next one". "still fails the pass for %s"
(two rows) passes before and after.

**Interfaces:**
- Produces: `trigger()` and `triggerHint()` resolve `true` for a pass whose batch the storage refused. One log
  line an outage: `[discovery] observations not saved, kept for the next pass · <the storage error's message>`.

- [ ] **Step 1: The red tests.** In `terminalAgentReconciler.spec.ts`, importing `RegistryOwnershipChanged` from
`./registry.js` and `AtomicWriteUnconfirmed, RegistryPersistenceUnavailable` from `./registryPersistence.js`:

```ts
describe('a pass whose observations cannot be saved', () => {
  afterEach(() => { vi.restoreAllMocks() })
  const live = (): TerminalAgentProbe => probe([{ instanceId: 'tmux:default', result: { state: 'available', roots: [{ runtime: tmux, rootPid: 1, cwd: '/work' }] } }])
  /** `save` is what each batch's durable save answers, in turn; the last entry repeats. */
  function outage(save: Array<Error | null>) {
    let batch = 0
    const onProbeStatus = vi.fn(), onTerminalAvailability = vi.fn()
    const reconciler = new TerminalAgentReconciler({
      current: () => [session()], backends: [], backendOrder: ['tmux'], probe: async () => live(),
      onDiscovered: vi.fn(), onObserved: vi.fn(), onDormant: vi.fn(), onRemoved: vi.fn(), onTerminalAvailability, onProbeStatus,
      transaction: async (apply) => {
        const result = await apply()
        const failure = save[Math.min(batch++, save.length - 1)]
        if (failure) throw failure
        return result
      },
    })
    return { reconciler, onProbeStatus, onTerminalAvailability }
  }
  const full = () => new RegistryPersistenceUnavailable('registry storage has no available space (ENOSPC)')
  const said = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter(([line]) => String(line).startsWith('[discovery] observations not saved'))

  it.each([
    ['the registry', () => full()],
    // What a refused rename leaves behind: the next batch tries the names first (e2e/diskfull.e2e.ts).
    ['the names file', () => new RegistryPersistenceUnavailable('name storage has no available space (ENOSPC)')],
    ['an unconfirmed write', () => new AtomicWriteUnconfirmed(full())],
  ])('finishes and answers the hook that asked for it when %s cannot be saved', async (_what, failure) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = outage([failure()])
    await expect(run.reconciler.triggerHint(tmux, 'claude')).resolves.toBe(true)
    expect(run.onTerminalAvailability).toHaveBeenCalled()
    expect(run.onProbeStatus).toHaveBeenLastCalledWith({ ready: true, error: null })
    expect(said(warn)).toHaveLength(1)
  })

  it('says so once for an outage, and again for the next one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Two batches a pass. Three passes whose second batch is refused, as a pass with nothing of its own to save
    // first is; one pass saved; one more refused.
    const run = outage([null, full(), null, full(), null, full(), null, null, null, full()])
    for (let pass = 0; pass < 3; pass++) await run.reconciler.trigger()
    expect(said(warn)).toEqual([['[discovery] observations not saved, kept for the next pass · Registry persistence unavailable: registry storage has no available space (ENOSPC)']])
    await run.reconciler.trigger()
    await run.reconciler.trigger()
    expect(said(warn)).toHaveLength(2)
  })

  it.each([
    ['an owner that changed', () => new RegistryOwnershipChanged('the registry owner changed while its write was being prepared')],
    ['any other failure', () => new Error('fixture')],
  ])('still fails the pass for %s', async (_what, failure) => {
    const error = failure()
    await expect(outage([error]).reconciler.trigger()).rejects.toBe(error)
  })
})
```

`trigger()` is the promise the 5 s timer drops (`:170`): resolved here, it cannot be an unhandled rejection there.

- [ ] **Step 2: See them fail.**

Run: `npx vitest run src/lib/terminalAgentReconciler.spec.ts`
Expected: 4 failed (`RegistryPersistenceUnavailable` rejected out of `triggerHint`), the rest passed. Commit (red).

- [ ] **Step 3: The pass catches a storage refusal of its batch.** In `TerminalAgentReconciler`:

```ts
  /** A batch of this pass was refused by storage. */
  private refused = false
  /** The outage has been said: one line until a pass is refused nothing. */
  private outageSaid = false
  /** One batch of a pass. Storage that refuses it ends neither the pass nor the hook waiting on it. */
  private async batch(saved: Promise<void>): Promise<void>
```

`batch` awaits `saved`. On `RegistryPersistenceUnavailable` or `AtomicWriteUnconfirmed` (imported from
`./registryPersistence.js`) it sets `refused`, warns once per outage with the line above (`error.message`: a fixed
category, `registry.ts:567`), sets `outageSaid`, and returns. Anything else it rethrows. Both call sites become
`await this.batch(this.deps.transaction(…))` (`:321`, `:495`). `drain()` clears `refused` before each
`reconcileOnce()` and, after it, clears `outageSaid` when `refused` is still false.

The comment on `batch` says why: a pass that rejected was an HTTP 500 for the hook that asked for it, before its
admission could show its hold, and an unhandled rejection every 5 s from the timer for as long as the outage
lasted (e2e/hookclient.e2e.ts, e2e/diskfull.e2e.ts, 2026-11-17). What the pass observed stays in the registry's
rows and is saved by a later pass.

- [ ] **Step 4: See them pass.**

Run: `npx vitest run src/lib/terminalAgentReconciler.spec.ts src/lib/terminalAgentReconciler.wrapperExec.spec.ts src/architecture.spec.ts && npm run typecheck`
Expected: every file passed. Commit.

---

### Task 4: A full disk is named by its error code (cause D)

**Depends on:** Task 1 (order only: both edit `registry.ts`). **Effort:** medium.

**Files:**
- Create: `cli/src/lib/registry.diskFailure.spec.ts`
- Modify: `cli/src/lib/registry.ts:568-579` (`persistenceFailure`)
- Modify: `cli/e2e/updateHostile.e2e.ts:609-618`

**The tests that fail before the change:** "a strict save refused with %s says so in words the master reads as
the disk" (`ENOSPC`, `EDQUOT`, `EROFS`). "a save refused with %s still does not name the disk" passes before and
after.

**Interfaces:**
- Produces: the messages `Registry persistence unavailable: registry storage has no available space (ENOSPC)`,
  `… (EDQUOT)`, `… is read-only (EROFS)`; the same with `name storage`. Tasks 5 and 6 read them.

- [ ] **Step 1: The red test.** `cli/src/lib/registry.diskFailure.spec.ts`. Its own registry module and data folder
(as `registry.persistence.spec.ts:43-52`), and the temporary image's `open` refused with a chosen code:

```ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { namesTheDisk } from '../harnessd/supervisor.js'
import type { registry as Registry } from './registry.js'

const refuse = vi.hoisted(() => ({ code: undefined as string | undefined }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (refuse.code && /\/(registry|agent-names)\.json\..*\.tmp$/.test(String(args[0]))) {
      throw Object.assign(new Error(`${refuse.code}: fixture, open '${String(args[0])}'`), { code: refuse.code })
    }
    return actual.open(...args)
  } }
})

let directory: string
let registry: typeof Registry
const input = { agentId: 'persisted-agent', engine: 'claude' as const, tmuxPane: '%1',
  processIdentity: { pid: 101, executable: '/fixture/claude', startMarker: 'fixture-101' } }
beforeEach(async () => {
  vi.resetModules()
  directory = mkdtempSync(join(tmpdir(), 'registry-disk-'))
  for (const key of ['ADAPTER_DATA_DIR', 'CLAUDE_PROJECTS_DIR', 'CODEX_HOME', 'CURSOR_HOME']) vi.stubEnv(key, directory)
  registry = (await import('./registry.js')).registry
  registry.load()
  await registry.openProcessAgent(input)
  await registry.flush()
})
afterEach(async () => {
  refuse.code = undefined
  await registry.flush().catch(() => {})
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

it.each([
  ['ENOSPC', 'registry storage has no available space (ENOSPC)'],
  ['EDQUOT', 'registry storage has no available space (EDQUOT)'],
  ['EROFS', 'registry storage is read-only (EROFS)'],
])('a strict save refused with %s says so in words the master reads as the disk', async (code, words) => {
  refuse.code = code
  // The core's own startup save (core/main.ts): every row marked dormant, in one transaction.
  const failure = await registry.transaction(() => { registry.setActive(input.agentId, false) }).catch((error: Error) => error)
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toBe(`Registry persistence unavailable: ${words}`)
  expect(namesTheDisk((failure as Error).message)).toBe(true)
  expect((failure as Error).message).not.toContain(directory)
})

it.each([['EIO', 'registry storage write failed'], ['EACCES', 'registry storage access was refused']])(
  'a save refused with %s still does not name the disk', async (code, words) => {
    refuse.code = code
    const failure = await registry.transaction(() => { registry.setActive(input.agentId, false) }).catch((error: Error) => error)
    expect((failure as Error).message).toBe(`Registry persistence unavailable: ${words}`)
    expect(namesTheDisk((failure as Error).message)).toBe(false)
  })
```

- [ ] **Step 2: See it fail.**

Run: `npx vitest run src/lib/registry.diskFailure.spec.ts`
Expected: 3 failed (`…has no available space` with no code; `EROFS` reads `write failed`), 2 passed. Commit (red).

- [ ] **Step 3: The code in the category.** In `persistenceFailure`, `ENOSPC` and `EDQUOT` become
`` `has no available space (${code})` `` and a new branch makes `EROFS` `'is read-only (EROFS)'`. The other
categories keep their text. A comment says why: the master tells a full disk from a broken build by these codes
(`harnessd/supervisor.ts` `namesTheDisk`); without them a good build that could not save on a full disk was rolled
back (e2e/updateHostile.e2e.ts, 2026-11-17). A code names no path.

- [ ] **Step 4: See it pass.**

Run: `npx vitest run src/lib/registry.diskFailure.spec.ts src/lib/registry src/harnessd/supervisor.spec.ts`
Expected: every file passed.

- [ ] **Step 5: The end-to-end line that named which write failed** (open question 2). In
`e2e/updateHostile.e2e.ts`, the comment at `:609` says what fails now: the core's strict save of its registry
finds no room (before #4356 it was the socket's claim, `listen ENOSPC`). `:618` becomes:

```ts
    expect(machine.log().slice(from)).toMatch(/could not start on the new bundle for want of room on the disk \([^\n]*ENOSPC/)
```

It runs on macOS only (Verification, checks 4 and 5). Commit (code and the end-to-end line).

---

### Task 5: A create the storage refuses says so, with one pane (cause E, gap 1)

**Depends on:** Task 4 (order only: both edit `registry.ts`). **Effort:** high.

**Files:**
- Modify: `cli/src/lib/createAgentPane.spec.ts`
- Modify: `cli/src/lib/registry.persistence.spec.ts:334`, `cli/src/lib/registry.externalResume.spec.ts:194`
- Modify: `cli/src/lib/registry.ts:1946` (`openPendingAgent`'s catch)
- Modify: `cli/src/lib/createAgentPane.ts:1-13` (header), `:127`, `:154-186`

**The tests that fail before the change:** in `createAgentPane.spec.ts`, "a create whose pending row cannot be
saved closes its one pane…" and "a pending admission the storage refuses rejects…".

**Interfaces:**
- Produces: `registry.openPendingAgent` rejects with `RegistryPersistenceUnavailable` or `AtomicWriteUnconfirmed`
  when storage refuses it; every other refusal is still `null`. `CreateAgentPaneResult`'s failure gains
  `'PERSISTENCE_UNCONFIRMED'`, its `detail` the storage error's message. Task 6 reads both through `agent_create`.

- [ ] **Step 1: The red tests.** In `createAgentPane.spec.ts` (add `writeFileSync` to its `fs` import), after "gives
up with REGISTRATION_FAILED…":

```ts
  it('a create whose pending row cannot be saved closes its one pane and says the registry could not be written', async () => {
    const { registry } = await loadRegistryModule()
    // Loaded after the reset, so it tells a storage refusal by the registry's own copy of the error classes.
    const { createAndRegisterPane } = await import('./createAgentPane.js')
    registry.load()
    // A registry file that cannot be read back refuses every save, as a full disk does.
    writeFileSync(join(dataDir, 'registry.json'), '{unreadable', { mode: 0o600 })
    const tmuxBackend = fakeTmux([succeeded('%1'), succeeded('%2'), succeeded('%3')])

    const result = await createAndRegisterPane({
      tmuxBackend, registry, engine: 'claude', cwd: '/tmp/demo', sessionLabel: 'harness-claude-1', argv: ['claude'],
    })

    expect(result).toEqual({ ok: false, error: 'PERSISTENCE_UNCONFIRMED',
      detail: 'Registry persistence unavailable: registry storage contains invalid JSON' })
    expect(tmuxBackend.create).toHaveBeenCalledTimes(1)
    expect(tmuxBackend.kill).toHaveBeenCalledTimes(1)
    expect(tmuxBackend.kill).toHaveBeenCalledWith({ backend: 'tmux', paneId: '%1' })
  })

  it('a pending admission the storage refuses rejects with the storage category, and a taken route still answers null', async () => {
    const { registry } = await loadRegistryModule()
    registry.load()
    ;(await registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%1' }], cwd: '/tmp/other' }))
    expect(await registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%1' }] })).toBeNull()
    writeFileSync(join(dataDir, 'registry.json'), '{unreadable', { mode: 0o600 })
    await expect(registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%2' }] }))
      .rejects.toThrow('registry storage contains invalid JSON')
  })
```

- [ ] **Step 2: See them fail.**

Run: `npx vitest run src/lib/createAgentPane.spec.ts`
Expected: 2 failed (`REGISTRATION_FAILED` after three `create` calls; `null` where a rejection is expected).
Commit (red).

- [ ] **Step 3: The registry says which refusal it was.** `openPendingAgent`'s `.catch` keeps its log line, then
rethrows a `RegistryPersistenceUnavailable` or an `AtomicWriteUnconfirmed` and answers `null` for the rest. Comment:
read as a taken route, a storage refusal opened and closed three panes and answered "tmux pane could not be
registered" (e2e/diskfull.e2e.ts, 2026-11-17). `resumePendingAgent` (`:1979`) is not changed.

- [ ] **Step 4: The pane helper answers it.** In `createAndRegisterPane`, around the `openPendingAgent` call: on a
rejection, `await deps.tmuxBackend.kill(spawned.runtime)` first, whatever was thrown. A storage refusal (the same
two classes, imported from `./registryPersistence.js`) then logs
`` `[agent] create ${deps.engine} not saved · pane ${spawned.runtime.paneId} closed` `` and returns
`{ ok: false, error: 'PERSISTENCE_UNCONFIRMED', detail: error.message }`: no second pane. Anything else is
rethrown. The result type (`:127`) gains the code. The header gains one sentence: a storage refusal is neither a
taken route nor tmux's, and is answered at once.

- [ ] **Step 5: The two cases that pinned `null`.** Both now expect the rejection:

`registry.persistence.spec.ts:334`:

```ts
      const refused = await registry.openPendingAgent({ engine: 'claude', runtimes: [{ backend: 'tmux', paneId: '%2' }] }).catch(error => error)
      expect(String(refused)).toContain('registry storage contains invalid JSON')
      expect(String(refused)).not.toContain(sentinel)
```

`registry.externalResume.spec.ts:194`: the `expect(await reloaded.openPendingAgent({…})).toBeNull()` becomes
`await expect(reloaded.openPendingAgent({…})).rejects.toThrow('registry storage contains invalid JSON')`. The line
after it (`byPaneEngine('%3', 'claude')` undefined) stays.

- [ ] **Step 6: See everything pass.**

Run: `npx vitest run src/lib/createAgentPane.spec.ts src/lib/registry src/core/agents src/core/terminals src/lib/resumeAgentService.spec.ts && npm run typecheck`
Expected: every file passed. Commit.

---

### Task 6: `e2e/diskfull.e2e.ts` asserts the PM's rule (cause E, the test)

**Depends on:** Task 3 (no unhandled rejection), Task 4 (`ENOSPC` in the answer), Task 5 (the create's answer).
**Effort:** medium. **No red test:** a test-only change, one commit. It is red on `main` today and green only
with Tasks 3 to 5 in.

**Files:**
- Modify: `cli/e2e/diskfull.e2e.ts:1-10` (header), `:64` (title), `:89-132`

- [ ] **Step 1: The first case, from "The disk fills" to its end.** Its title (`:64`) becomes `'agents keep working
while the data folder is full, a rename and a create are refused by name, and once there is room again a rename
holds'`. Keep `:89-92` (the disk fills, a turn on each agent while full). Replace `:93-132` with:

```ts
    // A rename is a choice that must be written down before it is answered: refused, and nothing is renamed.
    const refusedName = await client.request('agent_update', { agentId: agents[0].id, name: 'Named while full' }, 30_000)
    if (process.env.DISKFULL_REPORT) writeFileSync(process.env.DISKFULL_REPORT, `rename while full: ${JSON.stringify(refusedName.error ?? refusedName.agent?.name)}\n`)
    expect(refusedName.error, JSON.stringify(refusedName)).toBe('PERSISTENCE_UNCONFIRMED')
    expect((await row(client, agents[0].id))?.name).toBe(agents[0].name)
    // A new agent's binding must be saved before it is acknowledged: refused, naming the disk, its one pane closed.
    const cwd = join(d.projectsDir, 'made-while-full')
    mkdirSync(cwd, { recursive: true })
    const panes = async () => (await d.tmux.run('list-panes', '-a', '-F', '#{pane_id}')).split('\n').filter(Boolean).length
    const panesBefore = await panes()
    const made = await client.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
    expect(made.error, JSON.stringify(made)).toBe('PERSISTENCE_UNCONFIRMED')
    expect(String(made.detail)).toContain('ENOSPC')
    await until('the refused create\'s pane to be closed', async () => await panes() === panesBefore || null, 15_000, 200)
    expect((await rows(client)).map((agent) => agent.id).sort()).toEqual(agents.map((agent) => agent.id).sort())
    expect(d.log()).not.toContain('could not be registered after')
    for (const agent of agents) await turn(client, agent.id, `after a create was refused (${agent.engine})`)
    expect(d.coresStarted()).toBe(1)

    // Space comes back: a rename is written down, and survives a restart.
    rmSync(filler, { force: true })
    rmSync(join(volume, 'filler-tail'), { force: true })
    const renamed = await client.request('agent_update', { agentId: agents[0].id, name: 'Named once there is room' }, 30_000)
    expect(renamed.error, JSON.stringify(renamed)).toBeUndefined()
    expect(renamed.agent?.name).toBe('Named once there is room')
    await until('the full disk\'s holds to clear', async () => (await rows(client)).every((agent) => !agent.identityHold) || null, 60_000, 500)
    client.close()
    await d.restart()
    client = await LocalClient.connect(d)
    const after = await until('both agents back after the restart', async () => {
      const now = await rows(client)
      return agents.every((agent) => now.some((one) => one.id === agent.id && one.status === 'active')) ? now : null
    }, 90_000, 500)
    expect(after.find((one) => one.id === agents[0].id)?.name).toBe('Named once there is room')
    for (const agent of agents) await turn(client, agent.id, `after the space came back (${agent.engine})`)
    expect(d.log()).not.toContain('unhandledRejection')
    if (process.env.DISKFULL_LOG) writeFileSync(process.env.DISKFULL_LOG, d.log())
    client.close()
```

The fixed 15 s sleep goes (decision 12). The header's first paragraph says what the core must do now: keep
serving the agents it has, refuse by name what must be written down first (a rename, a new agent), not restart
over it, and write again once space is back. The second case of the file is not changed.

- [ ] **Step 2: Run it, on macOS.**

Run: `DISKFULL=1 caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/diskfull.e2e.ts`
Expected: `2 passed`. Before Tasks 3 to 5 the first case fails at `made.error` (`REGISTRATION_FAILED`). Commit.

---

# PR2: viewers across a core restart, and one test's order (#4390)

Branch `fix/viewers-core-restart`, cut from `origin/main`, in a worktree of its own. No task here depends on PR1,
and no file is shared with it. All commands from that worktree's `cli/`.

### Task 7: A new core lease keeps the running viewer (cause F)

**Depends on:** nothing. **Effort:** high.

**Files:**
- Modify: `cli/src/services/viewers.spec.ts:104-118`
- Modify: `cli/src/services/viewers.ts:153-157`
- Modify: `docs/design/2026-11-16-frame-parts.md:124-125`

**The test that fails before the change:** "a new core lease keeps the running viewer and republishes its URL
under the new lease".

**Interfaces:**
- Produces: nothing new. A `running` event under another `frameEpoch` leaves the viewer and its verdict watch up.

- [ ] **Step 1: The red test.** Replace "a new core lease replaces producers before accepting their next
asynchronous result" with:

```ts
  it('a new core lease keeps the running viewer and republishes its URL under the new lease', () => {
    const { attach, viewers, verdicts, core } = setup()
    const old = { ...agent(), frameEpoch: 'old-core:1' }, next = { ...agent(), frameEpoch: 'new-core:1' }
    attach(old)
    viewers.deps.onUrl('a1', 'http://127.0.0.1:8000')
    vi.mocked(core.agents.publishFrame!).mockClear()
    attach(next)
    expect(viewers.stop).not.toHaveBeenCalled()
    expect(verdicts.unwatch).not.toHaveBeenCalled()
    expect(core.agents.publishFrame).toHaveBeenCalledTimes(1)
    expect(core.agents.publishFrame).toHaveBeenLastCalledWith(next, expect.objectContaining({ viewerUrl: 'http://127.0.0.1:8000' }))
    // What the same producer says next goes out under the new lease too.
    viewers.deps.onUrl('a1', 'http://127.0.0.1:8001')
    expect(core.agents.publishFrame).toHaveBeenLastCalledWith(next, expect.objectContaining({ viewerUrl: 'http://127.0.0.1:8001' }))
    // Another folder is the manager's to replace (dsh/viewer.ts): it is asked with the new one.
    attach({ ...next, cwd: '/work/other' })
    expect(viewers.start).toHaveBeenLastCalledWith('a1', blender, '/work/other')
    expect(viewers.stop).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: See it fail.**

Run: `npx vitest run src/services/viewers.spec.ts`
Expected: 1 failed (`viewers.stop` was called with `'a1'`). Commit (red).

- [ ] **Step 3: Remove the replacement.** In the `running` branch, delete `const prior` and the `if (prior && …)`
block (`:153-157`): the session is stored, attached and published, as for any `running`. A comment says why: a new
core's lease is the same agent's, and replaced here, every viewer restarted under a new URL at each core restart
(e2e/viewersProcess.e2e.ts, 2026-11-17). `ended` is not changed.

- [ ] **Step 4: The design's sentence.** `docs/design/2026-11-16-frame-parts.md:124-125`, "Viewers replace old
producers on lease replacement; a mere disconnect keeps the same lease and does not restart them." becomes:

> Viewers keep their producers across a lease replacement: a new core's lease is the same agent's, so its viewer
> stays up on its port and its URL is published again under the new lease. Only `ended`, or another folder or
> harness, replaces a viewer.

- [ ] **Step 5: See it pass, at 100%.**

Run: `npx vitest run src/services/viewers.spec.ts && npm run typecheck && npm run test:core`
Expected: the spec passed; `test:core` passed with `src/services/viewers.ts` at 100% in every column. Commit.

---

### Task 8: `workspacesProcess` creates its agent after the park (cause G)

**Depends on:** nothing. **Effort:** medium. **No red test:** a test-only change, one commit. Its evidence is a
run with the fault's delay raised by hand, recorded in the pull request and not committed.

**Files:**
- Modify: `cli/e2e/workspacesProcess.e2e.ts:167-170`

- [ ] **Step 1: The evidence before.** Raise the fault's delay for this run only: `cli/src/services/process.ts:169`,
`200` to `2000`. Then:

Run: `npx vitest run --config vitest.e2e.config.ts e2e/workspacesProcess.e2e.ts -t 'crashing on every start'`
Expected: 1 failed, `expected { kind: 'git', … } to match object { kind: 'none', … }`. Keep the output.

- [ ] **Step 2: The order.** The agent is created once the master has parked workspaces:

```ts
    const cwd = worktree(d, repository(d), 'brave-otter', true)
    // Parked first. A start that lived long enough to reach the core reported this agent's Git facts, and a frame
    // keeps the last ones reported (docs/design/2026-11-16-frame-parts.md): then a service had observed it.
    await until('the master to park workspaces', () => d.log().includes('[harnessd] service edge ended 3 times') || null, 60_000, 250)
    const agent = await create(d, client, cwd)
    await turn(client, agent.id, 'workspaces is parked and nothing else cares')
```

- [ ] **Step 3: The evidence after, then the delay back.** The same command, still at `2000`: `1 passed`. Then
`git checkout -- src/services/process.ts`, and once more at `200`: `1 passed`. `git status` shows the test file
alone. Both outputs go in the pull request body. Commit the test file.

---

## Left out

- **PR3**, macOS only: the sandbox (#4181), the serviceProcesses memory budget, the handoff's
  `IDENTITY_UNAVAILABLE`. Its addendum to the spec comes with its diagnosis.
- `register`, `namesTheDisk`, `resumePendingAgent`, `core/agents/launches.ts` (open question 3), the apps' copy
  for the new create code, `lib/productUsageSignals.ts`' kinds.
- Windows: no end-to-end suite runs there; the change is shared TypeScript with no branch of its own.
- **Proposals, not built:**
  1. A refused rename leaves the names marked unsaved (`registry.ts:3681`), so every later registry save tries the
     names file first and fails under "name storage" before it reaches the registry file. With only the names
     file broken, nothing of the registry is saved either.
  2. `selectFirstHook` refuses a first hook that also brings a profile home the row did not have (`origin`
     compares `codexHome`). After Task 2 a first hook in the settle window is the usual case for a fresh restore:
     that watch would end with its hold kept.
  3. `PERSISTENCE_UNCONFIRMED` on a create is counted as `other` by `productUsageSignals.ts`; a kind of its own
     would show full disks in the health numbers.

## Verification

On each pull request's final head, after the review. Isolation is the repo's own (`cli/AGENTS.md`, rules 5 and
6): every end-to-end file boots its own `IsolatedDaemon` under a throwaway root, with a private tmux server and
fake Claude Code and Codex engines, signed out, its backend at `127.0.0.1:9`. No account, no production, nothing
of the developer's daemon. The full-disk tests fill a 64 MB disk image of their own (`hdiutil`, mounted under the
test's temporary folder), never the machine's disk. No temporary workflow: the long checks have the repo's own,
`.github/workflows/cli-e2e.yml`, started by hand. No check needs the user themselves.

### PR1, `fix/main-e2e-regressions`

On this Mac (macOS, arm64, tmux, zsh), in `cli/`, after `npm ci`:

1. **The unit specs and the typecheck.**

   ```bash
   npx vitest run src/lib/registry.launchIdentity.spec.ts src/core/agents/launchAuthority.spec.ts \
     src/lib/restoreAgents.spec.ts src/lib/restoreAgents.settle.spec.ts src/lib/registry.launchCallers.spec.ts \
     src/lib/terminalAgentReconciler.spec.ts src/lib/registry.diskFailure.spec.ts src/lib/createAgentPane.spec.ts \
     src/lib/registry.persistence.spec.ts src/lib/registry.externalResume.spec.ts
   npm run typecheck
   ```

   To see: ten files passed, no error from the typecheck. Pull request CI runs the whole unit suite on Linux.

2. **The local gates pull request CI does not run.** From the repository root, clean tree, final commit:

   ```bash
   python3 scripts/local-checks.py --run
   ```

   To see: `cli-core` (`npm run test:core`, 100% in every file) and `cli-portability` (`npm run test:portability`)
   passed. Its output goes in the pull request body.

3. **The targeted end-to-end files, first.**

   ```bash
   caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/races.e2e.ts e2e/modelSwitch.e2e.ts \
     e2e/adopt.e2e.ts e2e/hookclient.e2e.ts
   ```

   To see: four files passed. Among them: "two restarts at once leave one engine…" (claude and codex) and "two
   restarts at once, as the engine's first hook reaches the daemon 700, 1100, 1500 ms late…" (causes A); "moves
   onto a grid model and back in the same conversation…" (A); "opens a terminal conversation, refuses archives…"
   (B); "keeps a real native prompt visibly held through an unavailable registry…" (C).

4. **The full disk, on macOS** (it mounts a disk image; the same command as the workflow's macOS job):

   ```bash
   DISKFULL=1 caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/diskfull.e2e.ts e2e/updateHostile.e2e.ts \
     -t 'a full disk|an update on a disk that fills'
   ```

   To see: both files passed, with "agents keep working while the data folder is full, a rename and a create are
   refused by name…" (C, D, E) and "the disk fills just after the swap: the new build cannot start for want of
   room…" (D). Long: the workflow's job allows 30 minutes.

On GitHub, by hand, once, in the slot the PM gives (one heavy run at a time):

5. **CLI end to end on the branch.** Actions, "CLI end to end", Run workflow, branch `fix/main-e2e-regressions`,
   `agent_browser_podman` unticked (`gh workflow run cli-e2e.yml --ref fix/main-e2e-regressions`). All eight
   Linux shards, "e2e (macOS, full disk)" and `e2e-summary` run. **PR1 must turn green:** `e2e/races.e2e.ts`,
   `e2e/modelSwitch.e2e.ts`, `e2e/adopt.e2e.ts`, `e2e/hookclient.e2e.ts`, and in the macOS job
   `e2e/diskfull.e2e.ts` and `e2e/updateHostile.e2e.ts`. Until PR2 is in, `e2e/viewersProcess.e2e.ts` and
   `e2e/workspacesProcess.e2e.ts` still fail, and their shards and `e2e-summary` with them (open question 4): no
   other file may. A red file outside those two is compared with run 44045512447 before it is called this
   change's. The run's link goes in the pull request.

### PR2, `fix/viewers-core-restart`

On this Mac, in its worktree's `cli/`, after `npm ci`:

6. **The unit spec and the typecheck.** `npx vitest run src/services/viewers.spec.ts && npm run typecheck`. To see:
   one file passed, no error.

7. **The local gate.** `python3 scripts/local-checks.py --run` from that worktree's root, clean tree, final commit.
   To see: `cli-core` passed, 100% in every file. Its output goes in the pull request body.

8. **The targeted end-to-end files, first.**

   ```bash
   caffeinate -i npx vitest run --config vitest.e2e.config.ts e2e/viewersProcess.e2e.ts e2e/workspacesProcess.e2e.ts
   ```

   To see: two files passed, with "a core that restarts leaves the viewers running: the new core answers with the
   same viewer" (F) and "crashing on every start, it is parked; agents work, and their frames keep their launch
   folders" (G).

On GitHub, by hand, once, in the PM's slot:

9. **CLI end to end on the branch.** Run workflow, branch `fix/viewers-core-restart`
   (`gh workflow run cli-e2e.yml --ref fix/viewers-core-restart`). **PR2 must turn green:**
   `e2e/viewersProcess.e2e.ts` and `e2e/workspacesProcess.e2e.ts`. Until PR1 is in, PR1's six files still fail
   there: no other file may. The run's link goes in the pull request.

After both have merged:

10. **The goal.** One run of "CLI end to end" on `main` (the nightly, or by hand in the PM's slot): all eight
    shards, "e2e (macOS, full disk)" and `e2e-summary` green.

Windows: none. No end-to-end suite runs there, and nothing here is specific to it.

**Each pull request names:** the platforms (macOS, Linux and Windows: shared TypeScript; the full-disk tests on
macOS); each task's red and green runs; check 2's or 7's output; check 5's or 9's link. PR1 also names open
questions 1 to 3 as answered; PR2, Task 8's two outputs.
