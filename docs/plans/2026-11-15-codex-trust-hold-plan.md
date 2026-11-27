# A failed native read no longer holds an agent for good: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **diegodev phase 3**. One task, test-first: a red commit (the tests
> alone), then the code commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A discovery pass that reads an agent's native evidence completely releases the identity hold an earlier
pass's failed read set, so a Codex at its folder-trust question reads as needing the person within one pass (about
5 s) and `harness wait` exits 3 instead of waiting out its timeout.

**Architecture:** One file of product code, `cli/src/core/agents/bind.ts`, in the core's process. `createBinding`
remembers, per agent, the hold a failed `read()` set: its reason as the row stored it and the row's
`evidenceRevision` right after. `bindObservedAgent` notes whether the pass ran a native read and whether one failed,
and after the pass releases that hold when the row still carries it and is still the row the pass began with. A
released agent that has a conversation has its stream attached, as OpenClaw's own clear does. The pass's
engine-by-engine body moves, unchanged and at the same indentation, into `bindPass`, so the release has one place
after every one of its returns.

**Tech Stack:** TypeScript, Vitest 4.1.10 (mocked lookups, promises the test resolves, fake timers for the repair's
rhythm), the CLI end-to-end suite on GitHub Actions. No new dependency, no new file, no new import.

**Spec:** [docs/plans/2026-11-15-codex-trust-hold-design.md](2026-11-15-codex-trust-hold-design.md). Read it with
this plan, the root `AGENTS.md`, `cli/AGENTS.md` and `cli/src/core/AGENTS.md`. The spec is the authority.

## Global Constraints

- Fix (a) only. Not touched: `cli/src/core/agents/close.ts`, `cli/src/lib/registry.ts`,
  `cli/e2e/agentClient.e2e.ts`, anything under `cli/e2e/`. No test fault inside the core's native read.
- Files: `cli/src/core/agents/bind.ts`, `cli/src/core/agents/bind.spec.ts` and two keys of one test's fakes in
  `cli/src/lib/nativeLocations.control.spec.ts`. No new file, so `cli/src/architecture.coreFiles.txt` does not change
  (`core/agents/bind.ts` is its line 16). `BindDeps` and what `createBinding` returns do not change.
- Released: only the hold a failed `read()` in `bindObservedAgent` set, recognised by its token: the reason as the
  row stored it, and the row's `evidenceRevision` right after it was set.
- Kept, exactly as today: a hold from a refused `register` (`commit`), from `revalidateBinding`
  (`BINDING_RECOVERY_HOLD`, a saved binding that could not be checked), from a registry load, the OpenClaw screen and
  store holds, the Hermes sandbox hold, and a hold Hermes's own follower sets.
- A release needs all four: the pass ran at least one read through `read()`, none failed, the row still carries the
  token, and `current()` is true. A pass that read nothing releases nothing.
- The log line, verbatim: `[discovery] <agent> binding released · its native evidence was read completely`, with
  `<agent>` as `sid(agentId)`.
- A release of an agent whose row has a `sessionId` then attaches its stream: `attachSession(row)`, the row alone,
  after the hold is cleared and not awaited, as OpenClaw's own clear does (`bind.ts:380`). A rejection is logged
  with `console.error`, verbatim as there: `[agent] <agent> transcript attachment is unavailable: <message>`, and
  changes nothing else. An agent with no conversation attaches nothing. Nothing is attached without a release.
- `hold()`'s line, `[discovery] <agent> binding held · <reason>`, is logged on every failed read, as today.
- The map of remembered holds: an entry is written only by a failed read that set a hold; before each write the
  entries whose agent the registry no longer has, or whose row no longer carries the token, are dropped; at 256
  entries it is cleared; an entry goes on release and when its row no longer carries its token at the end of a pass.
  In memory only.
- Cost, as the spec states it and the pull request repeats it: one map lookup per agent per pass, the registry asked
  only when a hold is remembered, at most one registry write. No new read, timer or process. The pull request adds
  what the spec's Cost section leaves out: one attach, started once, when a held agent with a conversation is let go.
- `bind.ts` stays at 100% statements, branches, functions and lines (`npm run test:core`).
- No fixed sleeps: the tests use mocked lookups, promises they resolve themselves, and fake timers.
- Comments say why, in plain sentences, and name the incident: `e2e/agentClient.e2e.ts`, "an agent is told, not left
  waiting…", CLI end to end runs 43670913136 (shard 5) and 43503224991.
- A failing test is a product bug: fix it where the behavior lives. Never skip or loosen a test. If a step's
  expected output does not match, stop and report.
- A commit adds its files by name. The two documents under `docs/plans/` are untracked here and are no task's.
- Platforms: macOS, Linux and Windows; core logic only, the same on each. Tested on macOS and Linux; no Windows job
  runs `bind.spec.ts`, and none is added. One pull request; its body names the platforms and where each was tested,
  and carries the red and green output, the `harness-local-checks` fence and the end-to-end run's link.

## Found while reading the code

Checked at `85d8e61897`. The change was rehearsed in a copy of `cli/` outside this worktree; nothing here was changed.

- **Baseline.** `cd cli && npx vitest run src/core/agents/bind.spec.ts`: `Tests 119 passed (119)`. This worktree has
  `cli/node_modules`.
- **Rehearsed**, twice, from this plan's own code blocks applied to the base by a script; the copy was removed
  after. The second time, with the attach: Step 1 alone, `13 failed | 130 passed (143)` and `npx tsc --noEmit`
  clean. With Steps 4 and 5: Step 6's eight files pass (`430 passed`), the typecheck is clean, and `bind.ts` is at
  100% in all four measures under the gate's config (351 statements, 379 branches, 35 functions, 271 lines). The
  whole `npm run test:core` on that final code: 247 files, 4128 tests, 100% everywhere, 2 min 46 s on this Mac.
  Eight wrong versions of the attach each failed at least one of the new tests: no attach, an attach whatever the
  row, no `.catch`, an attach before the hold is cleared, an attach the pass waits for, an attach on every complete
  pass, an attach when a hold is only forgotten, and the failure logged with `console.log`. The first time, without
  the attach, ten wrong versions of the release (the token without its revision, no `current()` check, a record
  made in `hold()` for every caller, no pruning, no cap, and so on) each failed at least one; those tests are
  unchanged but for added assertions.
- **`current()` already carries rule 6.** `paneReadIdentity` (`core/transcripts/readIdentity.ts`) includes
  `identityHold` and `evidenceRevision`. A pass that began before a hold was set is not current once it is set, so
  it can never release it. For the same reason the release is the last thing a pass does: after it, the pass is no
  longer current.
- **Every failed read ends its pass** (`if (!located) return`), so a failed read is always a pass's last read. The
  one pass with two reads is a bound Copilot's (`bind.ts:473` and `477`).
- **`hold` has three callers:** `read` (a failed native read), `commit` (a refused register) and Hermes's follower,
  which gets it as `pass.hold` (`bind.ts:446`, `hermesTerminal.ts:159`). Only `read`'s is remembered.
- **Which agents the release reaches.** A bound agent with a transcript never gets this far held:
  `revalidateBinding` at the top of the pass (`bind.ts:293`) deals with its hold first. That leaves unbound agents
  (the repair, a resume lookup) and bound agents whose row has no transcript file: OpenClaw always, and a Copilot
  bound before its transcript was found (`transcriptPath: transcript ?? undefined`, `bind.ts:491`). Those two are
  the ones a release attaches.
- **A held agent's stream is not attached, and a held row attaches nothing.** Discovery skips the attach of an
  agent that wakes held (`discovery.ts:245`), `handleRegistered` returns before it (`bind.ts:241`), and
  `attachSession` itself answers `true` and does nothing for a row that carries a hold
  (`core/transcripts/attach.ts:733`). So the release clears the hold first and attaches after. OpenClaw's own clear
  attaches the same way (`bind.ts:380`): `attachSession(agent)` with no reset, not awaited, its rejection logged.
- **Attaching a stream that is already attached changes nothing.** With no reset, `attachSessionNow` finds the
  session's parser state and only re-adds its watch (`attach.ts:225`, logged `re-attached`), and a plain attach
  joins one already in flight for the session (`lib/attachTracker.ts`). A release in the same pass as discovery's
  own attach of a waking agent (`discovery.ts:254`) is therefore safe, as OpenClaw's clear already is. The attach's
  answer is not used, as at `bind.ts:380`.
- **The registry replaces a row's object on a register** (`registry.ts:3366`, `replaceLive`). The token is read from
  `registry.byAgent(agentId)`, never from the pass's own `agent`.
- **`setIdentityHold` (`registry.ts:2040`)** returns `false` and changes nothing when the row already carries that
  reason; every real change raises `evidenceRevision`. It stores the reason cut to 1024 characters, which is why the
  token is read back from the row.
- **The fake registry in `bind.spec.ts`** (`setup()`, lines 56-102) changes `identityHold` but never
  `evidenceRevision`, and its `byAgent` knows only rows put in `run.byAgent`. Step 1 makes the first faithful; the
  new tests put their rows in both lookups. All 119 existing tests pass with the faithful fake.
- **Two other specs build the real binding over a hand-made registry cast to `BindDeps`.**
  `cli/src/engines/kit/storePool.spec.ts:412` sets no hold, and stays untouched as long as the end of a pass asks
  the registry nothing when no hold is remembered. `cli/src/lib/nativeLocations.control.spec.ts:81` holds a bound
  Copilot on a failed read, and its second pass reads completely and registers through a fake that answers `null`
  and clears nothing, so that pass lets the agent go and attaches its stream. Its fakes have no `registry.byAgent`
  and no `attachSession`: with the change it throws `TypeError: registry.byAgent is not a function`, and with that
  one given, `TypeError: attachSession is not a function`. Step 5 gives the fakes both. (The real registry's
  register clears the hold itself and raises the revision, so a real pass that binds releases nothing here.)
- **A string flag fails the typecheck.** `let reads = 'none'` set inside `read` and compared after the `await` is
  refused by `tsc` (TS2367: it narrows the flag to its first value). Two booleans compile.
- **The end-to-end test on a Mac needs the process-image helper.** On macOS the process inspection goes through a
  native helper that only a bundle built with `HARNESS_PROCESS_IMAGES_ARTIFACT` embeds
  (`lib/nativeProcessControl.ts:236`, `build-bundle.mjs:45`). A daemon from the sources has none: every repair read
  of a Codex agent fails with "the native control helper is unavailable", the hold stays as the spec says it must,
  and the test's last `harness wait` exits 124 where 3 is expected (seen here with the change: 156 s, a hold logged
  on every pass; the base releases nothing, so it fails the same way). With the helper built and embedded the test
  passes on this Mac, at the base and with the change, the attach included (46 to 50 s each). Linux reads `/proc` and needs no helper.
  Verification 3 runs it with the helper.
- **`cli-e2e.yml` does not run on pull requests**: nightly and on demand from a branch, with no input for one file
  or one shard. The latest nightly on main is green (run 43600733799, 2026-11-14), and so are recent branch runs
  (43670975185).
- **Required local check for these paths** (`python3 scripts/local-checks.py --list …`): `cli-core`
  (`npm run test:core`) only. PR CI does not run it.

## Decisions

From the PM, approving the spec (2026-11-15):

1. Fix (a) as the spec words it. Not (b): close inspection is not changed.
2. The end-to-end test stays as it is, with no core test fault. Red-then-green unit tests in `bind.spec.ts` cover
   every case the spec's Tests section lists.
3. The map is pruned on each write, cleared at 256, and an entry goes on release and on a token that no longer
   matches at the end of a pass.
4. `bind.ts` stays at 100%.

From the PM, deciding for Diego on the first draft's three questions (2026-11-15):

5. The `binding held` line stays as today: logged on each failed read. Nothing is changed in it.
6. A release attaches the stream of an agent that has a `sessionId`, as OpenClaw's own clear does (`bind.ts:380`),
   with the same `.catch` log. An agent with no conversation attaches nothing. Red tests in Task 1.
7. No Windows run, and `bind.spec.ts` does not join `windows.yml`.

Read from the spec's own words, and pinned by a test each (Review Focus 2 and 4):

8. A hold is remembered only when the failed read's `setIdentityHold` changed the row ("a call that leaves the row
   as it was … changes no token either"). A read that fails in the same words as a hold another path set leaves that
   hold the other path's.
9. A read failed only if it threw. One that answers "nothing" (no session, no transcript, a pane that reads `null`)
   completed.

From the shape of the change:

10. A pass that throws releases nothing: the release comes after the pass, not in a `finally`. No test pins it,
    because no step of a pass throws by design; Review Focus 7 checks it by eye.
11. The attach is handed the registry's row, the one the release announces, and its `sessionId` decides. `current()`
    has just said that row is the one the pass began with.
12. The `.catch` log is written out as at `bind.ts:380`, not shared with it: sharing would put lines of the pass's
    body in the diff.

## Review Focus

Each line names the test in Task 1 that pins it.

1. A pass that began before the hold was set and completes after it: nothing is released (core rule 6)
   (`stays when the pass that read completely began before the hold was set`).
2. A read that fails in the same words as a hold a refused register set: the hold is still the register's, and stays
   (`leaves a hold a refused register set, also once a read fails with the same words`).
3. Hermes's follower sets its hold through the same `hold` the reads use: kept through a complete repair pass
   (`leaves a hold Hermes's own follower set`).
4. An OpenClaw pane whose capture answers `null` after a failed capture is let go; one that shows No Gateway is let
   go on one pass and held by the screen's own state on the next, never stuck between the two
   (`a hold a failed capture set goes once the pane is read again: null`, `… gives way to the screen's own state …`).
5. The attach begins only once the hold is gone: a held row attaches nothing (`attach.ts:733`), so an attach before
   the clear would leave the stream off for good
   (`attaches the stream of an agent let go with a conversation: once, after the hold is gone, and without waiting
   for it`).
6. A pass that keeps the hold, and every pass after a release, attaches nothing: one attach per release, never one
   per pass. And the pass does not wait for the attach, which reads the agent's whole history: a slow store must
   not hold the discovery pass (the same test, and `stays through a pass with one read that completes and one that
   fails`).
7. By eye: the lines of the pass's body (old `bind.ts:339-611`) are not in the diff; the release sits after
   `await bindPass(…)` and the attach is its last line, not awaited; `nativeLocations.control.spec.ts` gained two
   keys and no assertion changed; no existing test in `bind.spec.ts` changed.

---

### Task 1: A pass that reads completely releases the hold a failed read set

**Depends on:** nothing. **Effort:** xhigh (the daemon core; the order of evidence between passes).

**Files:**
- Modify: `cli/src/core/agents/bind.ts` (after `BindDeps`, line 105; after `readOpenclawStateDir`, line 131; `hold`
  and `read`, lines 311-329; after `mayClaim`, line 337)
- Test (must fail before the change): `cli/src/core/agents/bind.spec.ts` (`setup()`, lines 56-72; a new `describe`
  before line 1004; three tests before line 1239)
- Modify: `cli/src/lib/nativeLocations.control.spec.ts` (lines 92 and 94, one test's fakes only)

Every line number in this task is the base's (`85d8e61897`), before any edit of the task.

**Interfaces:**
- Consumes: `registry.setIdentityHold(agentId: string, reason?: string): boolean` and
  `registry.byAgent(agentId: string): RegisteredSession | undefined`, both already in `BindDeps['registry']`, and
  `attachSession(session: RegisteredSession): Promise<boolean>`, already in `BindDeps` and already destructured in
  `createBinding`.
- Produces: nothing outside `bind.ts`. Inside `createBinding`: `readHolds`, `readHeld(agentId)`,
  `rememberReadHold(agentId)` and `bindPass(observed, agent, pass)`; `hold` now returns `boolean`.

- [ ] **Step 1: Write the tests in `cli/src/core/agents/bind.spec.ts`**

Make the fake registry raise the revision as the real one does. In `setup()`, add `let revision = 0` beside the two
maps, and in the `setIdentityHold` fake, after the line that returns `false`:

```ts
        // As the registry does (registry.ts `setIdentityHold`): every change to a hold raises the row's revision.
        row.evidenceRevision = ++revision
```

Add this `describe` as the last block of `describe('binding a running process to its session')`, after the Hermes
block (before the closing `})` on line 1004). It uses that block's `observed()`:

```ts
  // A Codex started in a folder it does not trust stops at its trust question with no conversation. Its first process
  // read failed while the npm wrapper was still starting its native child, and nothing let that hold go: `harness wait`
  // waited out its two minutes instead of saying the agent needs the person (e2e/agentClient.e2e.ts, CLI end to end
  // runs 43670913136 shard 5 and 43503224991).
  describe('a hold a failed native read set', () => {
    const unsettled = new Error('a native child changed during inspection')
    const codex = (over: Partial<DiscoveredTerminalAgent> = {}) => observed({ engine: 'codex', ...over })
    /** An agent as the registry holds it: found by its process and by its id. Unbound unless told otherwise. */
    const inRegistry = (run: ReturnType<typeof setup>, over: Partial<RegisteredSession> = {}): RegisteredSession => {
      const row = agent({ engine: 'codex', sessionId: '', ...over })
      run.byAgent.set(row.agentId, row)
      vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
      return row
    }
    /** Several unbound Codex agents, each found by its own process. */
    const several = (run: ReturnType<typeof setup>, ids: string[]) => {
      const rows = ids.map((agentId, at) => agent({ engine: 'codex', agentId, sessionId: '',
        processIdentity: { pid: 1000 + at, startMarker: '2026-10-04T10:00:00Z', executable: 'codex' } }))
      for (const row of rows) run.byAgent.set(row.agentId, row)
      vi.mocked(run.deps.registry.byProcess).mockImplementation((_, identity) => rows.find(row => row.processIdentity?.pid === identity.pid))
      return { rows, pass: (at: number) => run.binding.bindObservedAgent(codex({ processIdentity: rows[at]!.processIdentity! })) }
    }
    const said = (): string[] => vi.mocked(console.log).mock.calls.map(([line]) => String(line))

    it('is let go by the next pass that reads completely and finds nothing, and set again by a read that fails again', async () => {
      const run = setup(), row = inRegistry(run)
      vi.mocked(findLiveSession).mockRejectedValueOnce(unsettled)
      await run.binding.bindObservedAgent(codex())
      expect(row.identityHold).toBe('a native child changed during inspection')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
      await run.binding.bindObservedAgent(codex())
      expect(row).not.toHaveProperty('identityHold')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(2)
      expect(run.deps.announceSession).toHaveBeenLastCalledWith(row)
      expect(said()).toEqual([
        '[discovery] a1 binding held · a native child changed during inspection',
        '[discovery] a1 binding released · its native evidence was read completely',
      ])
      // Nothing more is said while its reads go on completing.
      await run.binding.bindObservedAgent(codex())
      expect(run.deps.announceSession).toHaveBeenCalledTimes(2)
      // A read that fails again is a new hold, let go the same way: each change announced once.
      vi.mocked(findLiveSession).mockRejectedValueOnce(unsettled)
      await run.binding.bindObservedAgent(codex())
      expect(row.identityHold).toBe('a native child changed during inspection')
      await run.binding.bindObservedAgent(codex())
      expect(row).not.toHaveProperty('identityHold')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(4)
      expect(run.deps.registry.register).not.toHaveBeenCalled()
    })

    it('is let go when the resume lookup that failed completes and finds no transcript', async () => {
      const run = setup(), row = inRegistry(run)
      vi.mocked(findResumedTranscript).mockRejectedValueOnce(unsettled).mockResolvedValue(null)
      await run.binding.bindObservedAgent(codex({ resumeSessionId: 'resumed' }))
      expect(row.identityHold).toBe('a native child changed during inspection')
      await run.binding.bindObservedAgent(codex({ resumeSessionId: 'resumed' }))
      expect(row).not.toHaveProperty('identityHold')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(2)
      expect(run.deps.registry.register).not.toHaveBeenCalled()
    })

    // An agent bound or woken while held never had its stream attached (discovery.ts skips a held agent as it wakes):
    // let go without it, its pane would work while the apps and devices showed nothing.
    it('attaches the stream of an agent let go with a conversation: once, after the hold is gone, and without waiting for it', async () => {
      const heldAtAttach: unknown[] = []
      // An attach reads the agent's whole history: this one never answers, and the pass ends all the same.
      const run = setup({ attachSession: vi.fn((session: RegisteredSession) => { heldAtAttach.push(session.identityHold); return new Promise<boolean>(() => {}) }) })
      const row = inRegistry(run, { engine: 'copilot', sessionId: 's1' }), seen = observed({ engine: 'copilot' })
      vi.mocked(processSessionOf).mockRejectedValueOnce(unsettled)
      await run.binding.bindObservedAgent(seen)
      expect(run.deps.attachSession).not.toHaveBeenCalled()
      await run.binding.bindObservedAgent(seen)
      expect(row).not.toHaveProperty('identityHold')
      expect(run.deps.attachSession).toHaveBeenCalledTimes(1)
      expect(run.deps.attachSession).toHaveBeenCalledWith(row)
      // A row still held attaches nothing (transcripts/attach.ts): the hold was gone when the attach began.
      expect(heldAtAttach).toEqual([undefined])
      await run.binding.bindObservedAgent(seen)
      expect(run.deps.attachSession).toHaveBeenCalledTimes(1)
    })

    it('attaches nothing for an agent let go with no conversation', async () => {
      const run = setup(), row = inRegistry(run)
      vi.mocked(findLiveSession).mockRejectedValueOnce(unsettled)
      await run.binding.bindObservedAgent(codex())
      await run.binding.bindObservedAgent(codex())
      expect(row).not.toHaveProperty('identityHold')
      expect(run.deps.attachSession).not.toHaveBeenCalled()
    })

    it.each([new Error('reader unavailable'), 'reader unavailable'])('logs a stream that cannot attach, and the agent stays let go: %s', async error => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const run = setup({ attachSession: vi.fn(async () => { throw error }) })
      const row = inRegistry(run, { engine: 'copilot', sessionId: 's1' }), seen = observed({ engine: 'copilot' })
      vi.mocked(processSessionOf).mockRejectedValueOnce(unsettled)
      await run.binding.bindObservedAgent(seen)
      await run.binding.bindObservedAgent(seen)
      expect(said().at(-1)).toBe('[discovery] a1 binding released · its native evidence was read completely')
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith('[agent] a1 transcript attachment is unavailable: reader unavailable'))
      expect(log).toHaveBeenCalledTimes(1)
      expect(row).not.toHaveProperty('identityHold')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(2)
    })

    it('stays through a pass that read nothing: the repair in its slow rhythm', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(Date.parse('2026-10-04T10:00:00Z'))
      const run = setup(), row = inRegistry(run)
      vi.mocked(findLiveSession).mockRejectedValue(unsettled)
      for (let sweep = 0; sweep < 24; sweep++) await run.binding.bindObservedAgent(codex())
      // The read would complete now, but the repair asks once a minute from here.
      vi.mocked(findLiveSession).mockResolvedValue(null)
      await run.binding.bindObservedAgent(codex())
      expect(findLiveSession).toHaveBeenCalledTimes(24)
      expect(row.identityHold).toBe('a native child changed during inspection')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(60_000)
      await run.binding.bindObservedAgent(codex())
      expect(row).not.toHaveProperty('identityHold')
    })

    it('stays through a pass with one read that completes and one that fails', async () => {
      const run = setup(), row = inRegistry(run, { engine: 'copilot', sessionId: 's1' }), seen = observed({ engine: 'copilot' })
      vi.mocked(processSessionOf).mockRejectedValueOnce(unsettled).mockResolvedValue('s2')
      await run.binding.bindObservedAgent(seen)
      expect(row.identityHold).toBe('a native child changed during inspection')
      vi.mocked(transcriptOf).mockRejectedValueOnce(unsettled)
      await run.binding.bindObservedAgent(seen)
      expect(processSessionOf).toHaveBeenCalledTimes(2)
      expect(row.identityHold).toBe('a native child changed during inspection')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
      expect(run.deps.attachSession).not.toHaveBeenCalled()
      // Both complete: let go.
      await run.binding.bindObservedAgent(seen)
      expect(row).not.toHaveProperty('identityHold')
    })

    it('leaves a hold a refused register set, also once a read fails with the same words', async () => {
      const run = setup(), row = inRegistry(run), seen = codex({ resumeSessionId: 'resumed' })
      vi.mocked(run.deps.registry.register).mockImplementationOnce(() => { throw new Error('binding evidence changed') })
      await run.binding.bindObservedAgent(seen)
      expect(row.identityHold).toBe('binding evidence changed')
      vi.mocked(findResumedTranscript).mockResolvedValue(null)
      await run.binding.bindObservedAgent(seen)
      expect(row.identityHold).toBe('binding evidence changed')
      // The same words from a failed read change nothing on the row: the hold is still the register's.
      vi.mocked(findResumedTranscript).mockRejectedValueOnce(new Error('binding evidence changed'))
      await run.binding.bindObservedAgent(seen)
      await run.binding.bindObservedAgent(seen)
      expect(row.identityHold).toBe('binding evidence changed')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['hermes', HERMES_SANDBOX_HOLD],
      ['codex', 'Waiting for native evidence after a concurrent binding write.'],
    ] as const)('leaves a hold the binding did not set: %s, %s', async (engine, reason) => {
      const run = setup(), row = inRegistry(run, { engine, identityHold: reason })
      await run.binding.bindObservedAgent(observed({ engine }))
      expect(findLiveSession).toHaveBeenCalledOnce()
      expect(row.identityHold).toBe(reason)
      expect(run.deps.announceSession).not.toHaveBeenCalled()
    })

    it('leaves a hold Hermes\'s own follower set', async () => {
      const follow = vi.fn<NonNullable<BindDeps['hermesTerminal']>['follow']>(async (_agent, _observed, pass) => {
        pass.hold(new Error('its store could not be read'))
        return 'none'
      })
      const run = setup({ hermesTerminal: { follow, fellBack: vi.fn() } }), row = inRegistry(run, { engine: 'hermes' })
      await run.binding.bindObservedAgent(observed({ engine: 'hermes' }))
      expect(row.identityHold).toBe('its store could not be read')
      follow.mockResolvedValue('none')
      await run.binding.bindObservedAgent(observed({ engine: 'hermes' }))
      expect(findLiveSession).toHaveBeenCalledOnce()
      expect(row.identityHold).toBe('its store could not be read')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
    })

    it.each(['another reason', 'the same words, set again'] as const)('leaves a hold another path changed since: %s', async change => {
      const run = setup(), row = inRegistry(run)
      vi.mocked(findLiveSession).mockRejectedValueOnce(unsettled)
      await run.binding.bindObservedAgent(codex())
      const recorded = row.evidenceRevision
      if (change === 'another reason') run.deps.registry.setIdentityHold('a1', 'This OpenClaw version is not supported yet.')
      else {
        run.deps.registry.setIdentityHold('a1', undefined)
        run.deps.registry.setIdentityHold('a1', 'a native child changed during inspection')
      }
      const changed = row.identityHold
      await run.binding.bindObservedAgent(codex())
      expect(row.identityHold).toBe(changed)
      expect(row.evidenceRevision).not.toBe(recorded)
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
      // What was remembered went with that pass: not even the row as it was then is let go now.
      Object.assign(row, { identityHold: 'a native child changed during inspection', evidenceRevision: recorded })
      await run.binding.bindObservedAgent(codex())
      expect(row.identityHold).toBe('a native child changed during inspection')
    })

    it('forgets an agent the registry no longer has, when the next hold is remembered', async () => {
      const run = setup(), { rows, pass } = several(run, ['gone', 'stays'])
      vi.mocked(findLiveSession).mockRejectedValueOnce(unsettled).mockRejectedValueOnce(unsettled)
      await pass(0)
      run.byAgent.delete('gone')
      await pass(1)
      // Back under its id with the very row it had: nothing is remembered of it, so nothing is let go.
      run.byAgent.set('gone', rows[0]!)
      await pass(0)
      await pass(1)
      expect(rows[0]!.identityHold).toBe('a native child changed during inspection')
      expect(rows[1]).not.toHaveProperty('identityHold')
    })

    it('remembers 256 holds at most: one more starts over, and the holds before it stay as they were', async () => {
      const run = setup(), { rows, pass } = several(run, Array.from({ length: 257 }, (_, at) => `agent-${at}`))
      vi.mocked(findLiveSession).mockRejectedValue(unsettled)
      for (let at = 0; at < 257; at++) await pass(at)
      vi.mocked(findLiveSession).mockResolvedValue(null)
      await pass(0)
      await pass(256)
      expect(rows[0]!.identityHold).toBe('a native child changed during inspection')
      expect(rows[256]).not.toHaveProperty('identityHold')
    })

    it.each(['changing', 'deleted', 'process', 'binding'] as const)('stays when the agent changed during the pass: %s', async change => {
      const run = setup(), row = inRegistry(run)
      vi.mocked(findLiveSession).mockRejectedValueOnce(unsettled)
      await run.binding.bindObservedAgent(codex())
      let answer!: (found: null) => void
      vi.mocked(findLiveSession).mockReturnValueOnce(new Promise(resolve => { answer = resolve }))
      const pending = run.binding.bindObservedAgent(codex())
      if (change === 'changing') run.binding.whileChanging(() => true)
      if (change === 'deleted') vi.mocked(isRecentlyDeleted).mockImplementation(id => id === row.agentId)
      if (change === 'process') vi.mocked(run.deps.registry.byProcess).mockReturnValue(undefined)
      if (change === 'binding') row.cwd = '/elsewhere'
      answer(null); await pending
      expect(row.identityHold).toBe('a native child changed during inspection')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
    })

    // Core rule 6: a read that began before the hold cannot undo it.
    it('stays when the pass that read completely began before the hold was set', async () => {
      const run = setup(), row = inRegistry(run)
      let answer!: (found: null) => void
      vi.mocked(findLiveSession).mockReturnValueOnce(new Promise(resolve => { answer = resolve })).mockRejectedValueOnce(unsettled)
      const earlier = run.binding.bindObservedAgent(codex())
      await run.binding.bindObservedAgent(codex())
      expect(row.identityHold).toBe('a native child changed during inspection')
      answer(null); await earlier
      expect(row.identityHold).toBe('a native child changed during inspection')
      expect(run.deps.announceSession).toHaveBeenCalledTimes(1)
    })
  })
```

Add these to `describe('binding an OpenClaw pane, read from its screen')`, after
`never takes over a hold another reason set` (before line 1239). They use that block's `tui()`, `pane()` and
`screen()`:

```ts
  // Its own screen states are its to clear (above); a capture that failed is the binding's, and nothing let it go.
  it.each(['screen-plain', null] as const)('a hold a failed capture set goes once the pane is read again: %s', async shown => {
    const capturePane = vi.fn<BindDeps['capturePane']>().mockRejectedValueOnce(new Error('the pane could not be captured'))
      .mockResolvedValue(shown && screen(shown))
    const run = setup({ capturePane })
    const row = pane({ sessionId: 'agent:main:plain' })
    run.byAgent.set('a1', row)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    await run.binding.bindObservedAgent(tui())
    expect(row.identityHold).toBe('the pane could not be captured')
    await run.binding.bindObservedAgent(tui())
    expect(row).not.toHaveProperty('identityHold')
    expect(run.deps.announceSession).toHaveBeenCalledTimes(2)
    expect(console.log).toHaveBeenLastCalledWith('[discovery] a1 binding released · its native evidence was read completely')
    // Bound while held, its stream was never attached: let go, it is, as when the screen's own state clears.
    expect(run.deps.attachSession).toHaveBeenCalledTimes(1)
    expect(run.deps.attachSession).toHaveBeenCalledWith(row)
  })

  it('a hold a failed capture set gives way to the screen\'s own state: let go on one pass, No Gateway said on the next', async () => {
    const capturePane = vi.fn<BindDeps['capturePane']>().mockRejectedValueOnce(new Error('the pane could not be captured'))
      .mockResolvedValue(screen('screen-no-gateway-attached'))
    const run = setup({ capturePane })
    const row = pane({ sessionId: 'agent:main:plain' })
    run.byAgent.set('a1', row)
    vi.mocked(run.deps.registry.byProcess).mockReturnValue(row)
    await run.binding.bindObservedAgent(tui())
    await run.binding.bindObservedAgent(tui())
    expect(row).not.toHaveProperty('identityHold')
    await run.binding.bindObservedAgent(tui())
    expect(row.identityHold).toBe('OpenClaw Gateway is not running. Start it with openclaw gateway.')
    expect(run.deps.announceSession).toHaveBeenCalledTimes(3)
    expect(run.deps.attachSession).toHaveBeenCalledTimes(1)
  })
```

- [ ] **Step 2: Run the spec and see it fail**

From `cli/`:

```bash
npx vitest run src/core/agents/bind.spec.ts
npx tsc --noEmit
```

Expected: `Tests  13 failed | 130 passed (143)`, and `tsc` prints nothing. Eleven of the thirteen fail on
`expected … to not have property "identityHold"`:

- `is let go by the next pass that reads completely and finds nothing, and set again by a read that fails again`
- `is let go when the resume lookup that failed completes and finds no transcript`
- `attaches the stream of an agent let go with a conversation: once, after the hold is gone, and without waiting for it`
- `attaches nothing for an agent let go with no conversation`
- `stays through a pass that read nothing: the repair in its slow rhythm` (its last line)
- `stays through a pass with one read that completes and one that fails` (its last line)
- `forgets an agent the registry no longer has, when the next hold is remembered`
- `remembers 256 holds at most: one more starts over, and the holds before it stay as they were`
- `a hold a failed capture set goes once the pane is read again` (both cases)
- `a hold a failed capture set gives way to the screen's own state: let go on one pass, No Gateway said on the next`

and two on `expected '[discovery] a1 binding held · …' to be '[discovery] a1 binding released · …'`:

- `logs a stream that cannot attach, and the agent stays let go` (both cases)

The other eleven new cases pass already: they pin what must stay held, which nothing releases yet. Each fails
against a release that is too wide (Found while reading the code, Rehearsed). All 119 existing tests pass.

- [ ] **Step 3: Commit the red tests**

```bash
git add cli/src/core/agents/bind.spec.ts
git commit -m "Core: tests for the hold a failed native read set, let go once a pass reads completely"
```

- [ ] **Step 4: Release the hold in `cli/src/core/agents/bind.ts`**

Four edits. No line of the pass's body changes.

**(a)** After `BindDeps` (line 105), what a pass is handed:

```ts
/** What one pass over a process works with: its authority check, its holds, and its contained native reads and registrations. */
interface BindPass {
  current: () => boolean
  hold: (error: unknown) => boolean
  commit: (input: Parameters<BindDeps['registry']['register']>[0]) => ReturnType<BindDeps['registry']['register']> | null
  read: <T>(work: () => Promise<T>) => Promise<{ value: T } | null>
  mayClaim: (id: string) => boolean
}
```

**(b)** In `createBinding`, after `readOpenclawStateDir` (line 131):

```ts
  const readHolds = new Map<string, { reason: string; revision: number | undefined }>()
  /** The agent's row, while it still carries the hold remembered for it. */
  const readHeld = (agentId: string): RegisteredSession | undefined => {
    const remembered = readHolds.get(agentId)
    if (!remembered) return undefined
    const row = registry.byAgent(agentId)
    return row?.identityHold === remembered.reason && row.evidenceRevision === remembered.revision ? row : undefined
  }
  const rememberReadHold = (agentId: string): void => {
    for (const id of readHolds.keys()) if (!readHeld(id)) readHolds.delete(id)
    if (readHolds.size >= 256) readHolds.clear()
    const row = registry.byAgent(agentId)
    if (row?.identityHold) readHolds.set(agentId, { reason: row.identityHold, revision: row.evidenceRevision })
  }
```

`readHeld` asks the registry nothing when no hold is remembered: that is the cost the spec states, and
`storePool.spec.ts` builds the binding over a registry with no `byAgent`.

Doc comments, in plain sentences. On `readHolds`: it maps an agent to the hold a failed native read set, as the row
stored it (its reason and the row's `evidenceRevision` right after); nothing else let that hold go, because a Codex
at its folder-trust question has no conversation to check or register, so one process read that failed while the
npm wrapper was still starting its native child held it for good and `harness wait` never saw the question (the
incident, as in Global Constraints); every later change to the row's evidence raises its revision, so a hold another
reason set since, or the same words set again by another path, is never this one; in memory only, as holds are. On
`rememberReadHold`: first goes every entry whose agent is gone or whose row moved on, so none outlives its agent; at
256 the map starts over, as `openclawFolderReads` does, and a hold forgotten that way stays until its own reason
clears it, as every hold did before.

**(c)** `hold` says whether it set a hold, and `read` notes what the pass read (lines 311-329):

```ts
    /** Whether this set a hold on the row: one already there in the same words is left as it is. */
    const hold = (error: unknown): boolean => {
      if (!current()) return false
      const reason = error instanceof Error ? error.message : String(error)
      const set = registry.setIdentityHold(agent.agentId, reason)
      if (set) announceSession(agent)
      console.log(`[discovery] ${sid(agent.agentId)} binding held · ${reason}`)
      return set
    }
```

```ts
    let ran = false, failed = false
    const read = async <T>(work: () => Promise<T>): Promise<{ value: T } | null> => {
      ran = true
      try { return { value: await work() } }
      catch (error) {
        failed = true
        if (hold(error)) rememberReadHold(agent.agentId)
        return null
      }
    }
```

`commit` and its comment stay as they are, and so does the comment above `read`.

**(d)** After `mayClaim` (line 337), end `bindObservedAgent` with the pass and the release, and open `bindPass`
where the pass's body begins (the blank line 338 goes; the Copilot comment on line 339 is the body's first line):

```ts
    await bindPass(observed, agent, { current, hold, commit, read, mayClaim })
    // A pass whose native reads all completed lets go of the hold an earlier pass's failed read set, and of no other: the
    // row must still carry that very hold, and be the row this pass began with (`current`), so every read here began
    // after the hold was set (core rule 6). A pass that read nothing, or that threw, proves nothing.
    const row = readHeld(agent.agentId)
    if (!row) { readHolds.delete(agent.agentId); return }
    if (!ran || failed || !current()) return
    readHolds.delete(agent.agentId)
    registry.setIdentityHold(agent.agentId, undefined)
    announceSession(row)
    console.log(`[discovery] ${sid(agent.agentId)} binding released · its native evidence was read completely`)
    // An agent bound or woken while held never had its stream attached: discovery skips a held agent as it wakes, and a
    // held row attaches nothing. So it is attached now, with the hold gone and without waiting; one already attached is
    // left as it is.
    if (row.sessionId) void attachSession(row).catch((error) => console.error(
      `[agent] ${sid(row.agentId)} transcript attachment is unavailable: ${error instanceof Error ? error.message : error}`))
  }
  /** One pass over a process an agent runs: what it reads, and the session it binds from that. */
  const bindPass = async (observed: DiscoveredTerminalAgent, agent: RegisteredSession, { current, hold, commit, read, mayClaim }: BindPass): Promise<void> => {
```

Everything from the Copilot comment to the function's closing `}` (old lines 339-611) is now `bindPass`'s body, as it
was. `bindPass` is declared after `bindObservedAgent`; it is called only when a pass runs, long after both exist.

- [ ] **Step 5: Give the fakes in `cli/src/lib/nativeLocations.control.spec.ts` what a release asks for**

In `Copilot binding retains its previous conversation when native ownership moves during transcript lookup`, two
keys and nothing else in the file:

- line 92: add `byAgent: () => row,` after `byProcess: () => row,`;
- line 94: add `attachSession: vi.fn(async () => true),` after `announceSession: vi.fn(),`.

The binding has always declared both; these fakes left them out while no path in the test asked for them. Its
second pass now lets the bound Copilot go (its fake register clears nothing) and attaches its stream.

- [ ] **Step 6: Run the specs and see them pass**

From `cli/`:

```bash
npx vitest run src/core/agents/bind.spec.ts src/lib/nativeLocations.control.spec.ts src/engines/kit/storePool.spec.ts src/core/agents/discovery.spec.ts src/core/transcripts/attach.spec.ts src/engines/otherIdentity.golden.spec.ts src/lib/registry.binding.spec.ts src/architecture.spec.ts
npm run typecheck
npx vitest run --config vitest.core.config.ts src/core/agents/bind.spec.ts --coverage.include=src/core/agents/bind.ts
git status --short
```

Expected: `Test Files  8 passed (8)`, `Tests  430 passed (430)` (`bind.spec.ts` is 143 of them), with no skipped
test that was not skipped before; `tsc` prints nothing; the coverage summary reads 100% for statements, branches,
functions and lines; `git status` lists `bind.ts` and `nativeLocations.control.spec.ts` as modified and, the
documents under `docs/plans/` aside, nothing else. The eight files are every spec that builds the real binding, and
the architecture check. The whole gate runs in Verification, once, on the final head.

- [ ] **Step 7: Commit the code**

```bash
git add cli/src/core/agents/bind.ts cli/src/lib/nativeLocations.control.spec.ts
git commit -m "Core: a pass that reads an agent's native evidence completely lets go of the hold a failed read set"
```

Report both commits, and the Step 2 (red) and Step 6 (green) outputs with the commit each ran on.

---

## Verification

All on the final head, after the review. Nothing here needs an account, a sign-in, a device or Diego himself, and
nothing touches production: every daemon under test is the end-to-end harness's own (`e2e/harness/daemon.ts`: a
throwaway home and data folder, its own port, a private tmux server, fake Claude Code and Codex engines, a fake
backend in the test's process), as `cli/AGENTS.md` rules 5 and 6 require. Nothing of the developer's daemon (port
18473), `~/.harness`, `~/.claude` or `~/.codex` is read.

PR CI runs `cli-typecheck` and `cli-tests` on Linux by itself, with `bind.spec.ts` and
`nativeLocations.control.spec.ts` in the default suite: start no run for them. No temporary workflow is needed: the
one long check has its own workflow.

1. **The core's coverage gate, on the developer Mac** (PR CI does not run it; the repo makes it a local receipt).
   From the repository root, on a clean tree at the final commit:

   ```bash
   python3 scripts/local-checks.py --run
   ```

   It runs `npm run test:core` in `cli/` (the only check these paths need) and prints one `harness-local-checks`
   fence. A person sees `"check": "cli-core"` with `"status": "passed"`, which means 100% in every file of
   `src/core/` and `src/services/`, `bind.ts` among them. Three to four minutes (the rehearsal: 247 files, 4128 tests,
   2 min 46 s). The script refuses a tree with untracked files, so it runs once the two documents under `docs/plans/`
   are committed. Paste the fence into the pull request body before pushing the tested commit or marking the pull
   request ready.

2. **The CLI end-to-end suite on Linux, on GitHub**, where the failure was seen. After the branch is pushed, start
   one run of the repo's own workflow, `.github/workflows/cli-e2e.yml`, with `agent_browser_podman` left off:

   ```bash
   gh workflow run cli-e2e.yml --ref fix/codex-trust-hold
   gh run list --workflow cli-e2e.yml --branch fix/codex-trust-hold --event workflow_dispatch --limit 1 --json databaseId,url,headSha
   gh run watch <id>
   gh run view <id> --log | grep -E "agentClient\.e2e\.ts"
   ```

   It runs on GitHub's `ubuntu-latest` runners: eight shards (45 minutes each at most), the macOS full-disk job and
   the summary; the workflow cannot run one file or one shard. A person sees the run end `success` (the latest
   nightly on main and recent branch runs are green), a `✓ e2e/agentClient.e2e.ts` line and no
   `FAIL  e2e/agentClient.e2e.ts` line: `an agent is told, not left waiting, when Claude Code or Codex would ask the
   person to trust its folder` passes, its last `harness wait` exiting 3 with `checker: needs the person`. If the run
   ends red, list its failures (`gh run view <id> --log-failed | grep " FAIL "`) and the latest nightly's
   (`gh run list --workflow cli-e2e.yml --event schedule --limit 1`, then the same command): a failure that is not in
   the nightly is this branch's to explain. One run only, and not beside another heavy workflow. Report the run link.
   The failure was a race, so this run shows the flow holds; the red-then-green unit tests in Task 1 are what prove
   the rule. Red evidence: runs 43670913136 (`e2e (5)`) and 43503224991.

3. **The same test on macOS, on the developer Mac**, from a bundle that embeds the process-image helper, as a
   release does. The workflow runs this file on Linux only. From `cli/` in this worktree, with tmux and Xcode's
   command line tools installed:

   ```bash
   python3 scripts/build-process-images.py --output "$TMPDIR/process-images.json"
   env -u TMUX -u TMUX_PANE HARNESS_PROCESS_IMAGES_ARTIFACT="$TMPDIR/process-images.json" E2E_BUNDLE=1 \
     npx vitest run --config vitest.e2e.config.ts e2e/agentClient.e2e.ts -t 'told, not left waiting'
   rm "$TMPDIR/process-images.json"
   ```

   A person sees `Tests  1 passed | 11 skipped (12)` in about a minute (the rehearsals: 48 s and 46 s). The harness isolates
   it and removes its bundle; nothing else is set up or cleaned by hand. Without the artifact the test fails on a
   Mac whatever the code (the last `harness wait` exits 124): a daemon with no helper fails every process read
   there, and that hold rightly stays. Never report that as this change failing; if the helper cannot be built,
   report the macOS row as unverified. Local because it needs a Mac, and too short for a workflow.

The attach of a released agent's stream has no end-to-end check: it needs a bound OpenClaw or Copilot whose native
read fails once, and forcing that needs a test fault inside the core's native read, which the spec rules out. Task
1's tests pin it, and the suite in check 2 shows that nothing else that attaches a stream changed.

Windows gets no check of its own (Decision 7): the change is in a loop every platform shares, it reads only
injected lookups, and no workflow runs this spec or the CLI end-to-end suite on Windows.
