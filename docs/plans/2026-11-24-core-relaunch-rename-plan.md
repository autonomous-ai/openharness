# A relaunch publishes an engine that named itself after the last look Implementation Plan

> **For agentic workers:** REQUIRED: run this plan with devcrew phase 3, task by task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** A restart, a retarget, a move, a resume and a restore publish the engine they relaunched when it renamed
itself from a Node runtime between the last look and the publication's refresh, instead of refusing it and leaving the
row on a dead pid.

**Architecture:** One shared piece in `cli/src/lib/paneEngineProcess.ts` (already a core file): the rule
(`renamedEngine`), the error a refresh throws for it (`EngineRenamed`), and `publishEngine`, which runs a site's own
`registry.confirmLaunch` call and, on `EngineRenamed`, runs it exactly once more with the observed identity and the
same deadline. Each of the five sites swaps its hand-written refresh for `publishEngine`; nothing else about a site's
handling of the publication changes. The registry, its persistence and its lock are not touched.

**Tech Stack:** TypeScript (Node 22.15 or later), Vitest 4. Gates: `npm run typecheck`, `npm run test:core` (100% per
file), `npm run test:resume` (100%). All commands run in `cli/`.

**Spec:** `docs/plans/2026-11-24-core-relaunch-rename-design.md` (read it with this plan). The orchestrator's decisions
of 2026-11-24 are final: the accept rule, one re-write under one shared `expires`, the five sites, Linux-only effect
with a platform-free rule, fixed-word logs, no new end-to-end test, no new core file or list; and its answers to the
draft's four questions: the log line's shape, where `relaunchOld`'s test lives, the error of a re-write that runs out of
the budget, the eight e2e files and their one run on Linux.

## Global Constraints

- **Accept rule.** A refresh reads the process it sees as the recorded engine, renamed, only when all hold: the same
  pid and the same start (`sameProcessIdentity`); the recorded `executable`'s `programName` is `node` or `nodejs`; the
  observed `executable`'s `programName` is neither; the observed process is the one the pane's engine lookup selects for
  the row's engine. A different pid, a different start, or a change from anything but a Node runtime is refused as today.
- **The look is the engine lookup.** Every site's `look` is `resolvePaneEngineProcess(backend, runtime, engine)` or
  restore's `probeProcess(runtime, engine)` (the same lookup, `lib/restoreTerminals.ts`), for the row's engine. Never the
  process table read directly.
- **One re-write.** At most two `registry.confirmLaunch` calls for the rename: the second with the observed identity. No
  loop, no wait between them. A second rename is refused.
- **A re-write out of budget.** It propagates the registry's own error, `RegistryPersistenceUnavailable`, unchanged:
  `publishEngine` converts nothing (never to `IdentityReadUnavailable`), and each site handles it as it handles that
  error from its first write today.
- **One deadline.** `expires = performance.now() + REGISTRY_WRITE_DEADLINE_MS` (5 000 ms), computed once before the
  first write and handed to both; restore hands in its own existing `expires` instead. Read the global `performance`,
  as `registry.confirmLaunch` does; do not import `node:perf_hooks` (`registry.launchCallers.spec.ts` holds that
  module's clock at 0).
- **Registry.** Writes go only through the site's existing `registry.confirmLaunch` call. `lib/registry.ts` and
  `lib/registryPersistence.ts` do not change.
- **Core.** No new file in the core's process: `src/architecture.coreFiles.txt` does not change. The only new list is
  the two names `node`, `nodejs`. No setting, no record.
- **Untouched.** `core/agents/discovery.ts`, `core/agents/newPane.ts`, `core/agents/swap.ts`, restart's terminal branch
  (`NO_SHELL`) and resume's shell branch: these two still publish with no `expires` and never look for an engine.
- **Reason words stay.** Restart: `NO_ENGINE` for no process, `ANOTHER_PROCESS` for a change (so `HELD_BY` names the
  check). The others pass their one sentence for both: `the retargeted process changed before publication`, `the move
  destination changed before publication`, `the resumed process changed before readiness was saved`, `the restored
  process changed before publication`.
- **Log.** One fixed line per re-write, `[<operation>] publication · engine renamed · <sid(agentId)>` (`sid`,
  `lib/log.ts`), operations `restart`, `retarget`, `move`, `resume`, `restore`, logged by the site; a move's fallback
  to its old pane logs as `[restart]`. No executable, no pid, no path.
- **Platform-free.** No `process.platform` branch: `programName` already reads `node.exe` as `node`.
- **Tests.** Red first. No fixed sleeps. Existing fixtures only (throwaway homes and data folders). No new e2e file.
- **Comments say why:** the helper's comment names the cause (Claude Code installed with npm starts as `node` and sets
  `process.title`, which on Linux changes `comm`; measured 2026-11-24) and what a refused refresh cost (the row kept a
  dead pid, the restart answered INTERNAL, discovery made a second agent about 1.5 s later; #4584 covered only a rename
  between the wait's two looks).
- **Commits.** Each task: one commit of its failing tests, then one of the change. Stage only the files the task names.

## What this plan decides from the spec's words

- `publishEngine` takes a fifth, optional `expires`: restore's (spec: "which `publishEngine` takes in place of its
  default").
- `EngineRenamed` is built with `reasons.changed`, so one that ever escaped reads as that site's "changed" hold.
- **Who logs** (orchestrator, 2026-11-24). The site, inside the `publish` callback it hands to `publishEngine`: the
  callback is called a second time only for a rename, with an identity other than the one the site passed in, and logs
  then. `publishEngine` keeps the spec's four parameters and learns no operation name or agent id. Restart, retarget
  and resume log with `console.log`; a move with `w.log`; restore with `deps.log`. A move's fallback (`relaunchOld`)
  goes through `commitRelaunchedEngine`, so it logs as `[restart]`.
- **A re-write that runs out of the budget propagates unchanged** (orchestrator, 2026-11-24; spec, Design, "Registry
  and its lock"): the registry's `RegistryPersistenceUnavailable` leaves `publishEngine` as it came, and each site
  handles it as it handles that error from its first write today. It is not an identity hold: a restart logs no
  `publication held` line for it, and a resume does not answer `RESUME_UNCONFIRMED` for it. No site gains a branch.
- **`relaunchOld`'s test sits in `restart.spec.ts`** (orchestrator, 2026-11-24), where `commitRelaunchedEngine`'s tests
  are, so the restart task and the move task share no file and run together.
- **Restore keeps the identity it published.** After a re-write the watch's later first-hook check
  (`selectFirstHook`, after the settle window) compares the row with the published identity, not the look's.
- Not a hot path: a relaunch's publication, and one more registry write only when a rename is seen. No numbers needed.

## Review Focus

Each line is a case the spec implies and its test list does not exercise; the test is in the task named.

1. **The real registry must hand `EngineRenamed` back as it is, and keep nothing of the refused write.** The restart,
   retarget and move specs, and restore's main one, fake the registry: a registry that wrapped the error would switch
   the fix off there with every one of their tests green. Task 1, `registry.launchCallers.spec.ts`.
2. **Linux keys a start by its ticks, and its marker moves when the wall clock is stepped** (`terminalTypes.ts`
   `startTicks`); Linux is the one platform that sees the rename. Same ticks with a moved marker is the same process;
   other ticks are not. Task 1, `renamedEngine`.
3. **Restore: the engine's first hook binds the renamed process during the settle window.** The watch must still hand
   the pane over. Task 6, `restoreAgents.settle.spec.ts`.
4. **Restore: its own retry after `RegistryOwnershipChanged` is the look that sees the new name.** `EngineRenamed` then
   leaves the site's callback, not `confirmLaunch`; it must still lead to exactly one re-write. Task 6,
   `restoreAgents.spec.ts`.
5. **The look itself fails** (restore's `probeProcess` throws when the pane's backend is gone). Refused as today: never
   read as a rename, never retried. Task 1, `publishEngine`.

## Task graph

| # | Task | Effort | Depends on |
|---|---|---|---|
| 1 | The rename rule and the one re-write (`lib/paneEngineProcess.ts`) | xhigh | - |
| 2 | Restart, and a move's fallback to its old pane | high | 1 |
| 3 | Retarget | high | 1 |
| 4 | A move's destination pane (`swap`) | high | 1 |
| 5 | Resume | high | 1 |
| 6 | Restore | xhigh | 1 |

Longest chain: two tasks (1, then any of 2-6). Tasks 2-6 share no file and run together once Task 1 is in. Files, all
under `cli/src/`:

- 1: `lib/paneEngineProcess.ts`, `lib/paneEngineProcess.spec.ts`, `lib/registry.launchCallers.spec.ts`.
- 2: `core/agents/restart.ts`, `core/agents/restart.spec.ts`.
- 3: `core/agents/retarget.ts`, `core/agents/retarget.spec.ts`.
- 4: `core/agents/hostMove.ts`, `core/agents/hostMove.spec.ts`.
- 5: `lib/resumeAgentService.ts`, `lib/resumeAgentService.spec.ts`, `lib/controlResume.golden.spec.ts`.
- 6: `lib/restoreAgents.ts`, `lib/restoreAgents.spec.ts`, `lib/restoreAgents.settle.spec.ts`.

Tasks 2-6 run `registry.launchCallers.spec.ts` (the callers against real registry images) and do not edit it.

---

### Task 1: The rename rule and the one re-write

**Files:** Modify `cli/src/lib/paneEngineProcess.ts`; Test `cli/src/lib/paneEngineProcess.spec.ts`,
`cli/src/lib/registry.launchCallers.spec.ts`.

**Depends on:** nothing. **Effort:** xhigh (process identity, the registry's durable row).

**Interfaces:** Produces, all exported from `lib/paneEngineProcess.ts`:

```ts
export function renamedEngine(recorded: ProcessIdentity, observed: ProcessIdentity): boolean
export class EngineRenamed extends IdentityReadUnavailable {
  constructor(readonly observed: ProcessIdentity, reason: string)   // super(reason)
}
export async function publishEngine(
  identity: ProcessIdentity,
  look: () => Promise<ProcessIdentity | null>,
  reasons: { gone: string; changed: string },
  publish: (identity: ProcessIdentity, refresh: () => Promise<void>, expires: number) => Promise<LaunchPublication>,
  expires: number = performance.now() + REGISTRY_WRITE_DEADLINE_MS,
): Promise<LaunchPublication>
```

- [ ] **Step 1: Write the failing unit tests** in `paneEngineProcess.spec.ts` (new imports: `publishEngine`,
  `renamedEngine`, `EngineRenamed`; `IdentityReadUnavailable` from `../engines/kit/identityScan.js`;
  `RegistryPersistenceUnavailable`, `REGISTRY_WRITE_DEADLINE_MS` from `./registryPersistence.js`;
  `RegistryOwnershipChanged` and the types `LaunchPublication`, `ProcessIdentity` from `./registry.js`).

```ts
describe('renamedEngine', () => {
  const at = (executable: string, over: Partial<ProcessIdentity> = {}): ProcessIdentity => ({ pid: 11, startMarker: 'm11', executable, ...over })
  it.each([
    ['node', 'claude'], ['nodejs', 'codex'], ['/usr/bin/node', 'claude'], ['node.exe', 'claude.exe'],
    ['C:\\Program Files\\nodejs\\NODE.EXE', 'C:\\tools\\claude.exe'],
  ])('reads %s, now %s, as the recorded engine renamed', (recorded, observed) => {
    expect(renamedEngine(at(recorded), at(observed))).toBe(true)
  })
  it.each([
    ['the same name', at('claude'), at('claude')],
    ['a Node runtime still', at('node'), at('node')],
    ['one Node runtime for another', at('node'), at('nodejs')],
    ['a different pid', at('node'), at('claude', { pid: 12 })],
    ['a different start', at('node'), at('claude', { startMarker: 'm12' })],
    ['a rename from another program', at('/bin/claude'), at('other')],
    ['a rename to a Node runtime', at('claude'), at('node')],
  ])('refuses %s', (_case, recorded, observed) => {
    expect(renamedEngine(recorded, observed)).toBe(false)
  })
  // Linux: the start is the ticks; the marker moves when the wall clock is stepped (terminalTypes.ts `startTicks`).
  it('compares the start as sameProcessIdentity does: the ticks, over a marker the clock moved', () => {
    expect(renamedEngine(at('node', { startTicks: 500, startMarker: 'before the step' }),
      at('claude', { startTicks: 500, startMarker: 'after the step' }))).toBe(true)
    expect(renamedEngine(at('node', { startTicks: 500 }), at('claude', { startTicks: 501 }))).toBe(false)
  })
})

describe('publishEngine', () => {
  const node: ProcessIdentity = { pid: 11, startMarker: 'm11', executable: 'node' }
  const claude: ProcessIdentity = { ...node, executable: 'claude' }
  const reasons = { gone: 'the engine is gone', changed: 'the engine changed' }
  const held = (reason: string) => new IdentityReadUnavailable(reason).message
  /** Stands in for `registry.confirmLaunch`: runs the refresh, then confirms the identity it was handed. */
  const registryWrite = () => vi.fn(async (identity: ProcessIdentity, refresh: () => Promise<void>, _expires: number): Promise<LaunchPublication> => {
    await refresh()
    return { state: 'confirmed', entry: { processIdentity: identity } as RegisteredSession }
  })

  it('publishes once when the look still sees the recorded process', async () => {
    const publish = registryWrite()
    expect(await publishEngine(node, async () => ({ ...node }), reasons, publish)).toEqual({ state: 'confirmed', entry: { processIdentity: node } })
    expect(publish).toHaveBeenCalledExactlyOnceWith(node, expect.any(Function), expect.any(Number))
  })

  it('writes once more, the observed identity under the same expires, when the engine named itself before the refresh', async () => {
    const publish = registryWrite(), look = vi.fn(async () => claude)
    const before = performance.now()
    expect(await publishEngine(node, look, reasons, publish)).toEqual({ state: 'confirmed', entry: { processIdentity: claude } })
    expect(publish.mock.calls.map(([identity]) => identity)).toEqual([node, claude])
    const [first, second] = publish.mock.calls.map(call => call[2])
    expect(second).toBe(first)   // computed once, before the first write: never renewed
    expect(first).toBeGreaterThanOrEqual(before + REGISTRY_WRITE_DEADLINE_MS)
    expect(first).toBeLessThanOrEqual(performance.now() + REGISTRY_WRITE_DEADLINE_MS)
    expect(look).toHaveBeenCalledTimes(2)   // each write's refresh looks; nothing waits between them
  })

  it('takes the caller\'s expires in place of its own, for both writes', async () => {
    const publish = registryWrite()
    await publishEngine(node, async () => claude, reasons, publish, 42)
    expect(publish.mock.calls.map(call => call[2])).toEqual([42, 42])
  })

  it('refuses a second rename on the re-write, in the changed words', async () => {
    const publish = registryWrite()
    const look = vi.fn<() => Promise<ProcessIdentity | null>>().mockResolvedValueOnce(claude).mockResolvedValue({ ...node, executable: 'codex' })
    const refused = await publishEngine(node, look, reasons, publish).catch(error => error)
    expect(refused).toBeInstanceOf(IdentityReadUnavailable)
    expect(refused).not.toBeInstanceOf(EngineRenamed)
    expect(refused.message).toBe(held(reasons.changed))
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['no process', node, null, reasons.gone],
    ['a different pid', node, { ...claude, pid: 12 }, reasons.changed],
    ['a different start', node, { ...claude, startMarker: 'm12' }, reasons.changed],
    ['a rename from another program', { ...node, executable: '/bin/claude' }, { ...node, executable: 'other' }, reasons.changed],
  ])('refuses %s as today, with one write', async (_case, recorded, observed, reason) => {
    const publish = registryWrite()
    const refused = await publishEngine(recorded, async () => observed, reasons, publish).catch(error => error)
    expect(refused).toBeInstanceOf(IdentityReadUnavailable)
    expect(refused).not.toBeInstanceOf(EngineRenamed)
    expect(refused).toMatchObject({ code: 'IDENTITY_UNAVAILABLE', message: held(reason) })
    expect(publish).toHaveBeenCalledOnce()
  })

  it('throws, from the refresh, an EngineRenamed that carries the observed identity and reads as the changed hold', async () => {
    let seen: unknown
    await publishEngine(node, async () => claude, reasons, async (identity, refresh) => {
      seen = await refresh().catch(error => error)
      return { state: 'confirmed', entry: { processIdentity: identity } as RegisteredSession }
    })
    expect(seen).toBeInstanceOf(EngineRenamed)
    expect(seen).toMatchObject({ observed: claude, code: 'IDENTITY_UNAVAILABLE', message: held(reasons.changed) })
  })

  it('lets a re-write that ran out of the budget through as the registry\'s own error: not a hold, no third write', async () => {
    // The registry's words for a write past `expires` (registryPersistence.ts). The same object must come out.
    const expired = new RegistryPersistenceUnavailable('write deadline exceeded')
    const publish = registryWrite()
    publish.mockImplementationOnce(publish.getMockImplementation()!).mockRejectedValueOnce(expired)
    await expect(publishEngine(node, async () => claude, reasons, publish)).rejects.toBe(expired)
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('retries nothing but a rename: another failure, a look that throws, a write that published nothing', async () => {
    const owner = new RegistryOwnershipChanged('the registry owner changed while its write was being prepared')
    const failing = vi.fn(async (): Promise<LaunchPublication> => { throw owner })
    await expect(publishEngine(node, async () => node, reasons, failing)).rejects.toBe(owner)
    expect(failing).toHaveBeenCalledOnce()
    const probe = new Error('no terminal backend restores tmux:%1'), publish = registryWrite()
    await expect(publishEngine(node, async () => { throw probe }, reasons, publish)).rejects.toBe(probe)
    expect(publish).toHaveBeenCalledOnce()
    const unpublished = vi.fn(async (): Promise<LaunchPublication> => ({ state: 'not-published' }))
    expect(await publishEngine(node, async () => node, reasons, unpublished)).toEqual({ state: 'not-published' })
    expect(unpublished).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Write the failing real-registry test** in `registry.launchCallers.spec.ts` (import `publishEngine`
  beside `resolvePaneEngineProcess`: the file's mock of `./paneEngineProcess.js` spreads the real module, so
  `publishEngine` is the real one). It uses the file's `row`, `terminal`, `runtime`, `oldProcess`, `newProcess`,
  `persisted()`.

```ts
it('an engine that named itself before the refresh is durable under its new name after one re-write', async () => {
  const started = { ...newProcess, executable: 'node' }, named = { ...newProcess, executable: 'claude' }
  vi.mocked(resolvePaneEngineProcess).mockResolvedValue(named)
  const confirm = vi.spyOn(registry, 'confirmLaunch')
  const durable: unknown[] = []
  const publication = await publishEngine(started, () => resolvePaneEngineProcess(terminal, runtime, 'claude'),
    { gone: 'fixture engine gone', changed: 'fixture engine changed' }, (identity, refresh, expires) => {
      durable.push(persisted().find(entry => entry.agentId === row.agentId)?.processIdentity)
      return registry.confirmLaunch(row.agentId, { processIdentity: identity }, { current: () => true, refresh, expires })
    })
  expect(publication).toMatchObject({ state: 'confirmed', entry: { processIdentity: named, launch: { state: 'ready' } } })
  // The refused write left nothing durable: the re-write began from the row the first one began from.
  expect(durable).toEqual([oldProcess, oldProcess])
  expect(confirm.mock.calls.map(call => call[1].processIdentity)).toEqual([started, named])
  expect(confirm.mock.calls[1]![2]!.expires).toBe(confirm.mock.calls[0]![2]!.expires)
  expect(persisted().find(entry => entry.agentId === row.agentId)).toMatchObject({ processIdentity: named, launch: { state: 'ready' } })
})
```

- [ ] **Step 3: Run them and see them fail.**
  `npx vitest run src/lib/paneEngineProcess.spec.ts src/lib/registry.launchCallers.spec.ts`
  Expected: the new tests fail with `renamedEngine is not a function` / `publishEngine is not a function`; every test
  that was there passes.
- [ ] **Step 4: Commit the failing tests** (the two spec files):
  `Relaunch: the rule for an engine that named itself, and its one re-write (failing tests)`.
- [ ] **Step 5: Implement** in `lib/paneEngineProcess.ts`, below `checkSessionRuntime`:
  - `renamedEngine`: `sameProcessIdentity(recorded, observed)`, and `programName(recorded.executable)` is in the
    two-name set `node`, `nodejs` (a module constant beside it), and `programName(observed.executable)` is not.
  - `EngineRenamed`: as the signature says; nothing else on it.
  - `publishEngine`: a `refresh` bound to a recorded identity calls `look()`; null throws
    `IdentityReadUnavailable(reasons.gone)`; the same pid, start and `executable` passes; `renamedEngine` throws
    `EngineRenamed(observed, reasons.changed)`; anything else throws `IdentityReadUnavailable(reasons.changed)`. It
    awaits `publish(identity, refresh, expires)`; one `catch` for `EngineRenamed` only, which returns
    `publish(error.observed, <a refresh bound to error.observed>, expires)`. Every other error and every publication
    passes through, the re-write's own included: its `RegistryPersistenceUnavailable` is not caught or wrapped. No
    loop.
  - New imports: `programName` (`./processTable.js`), `IdentityReadUnavailable` (`../engines/kit/identityScan.js`),
    `REGISTRY_WRITE_DEADLINE_MS` (`./registryPersistence.js`), the type `LaunchPublication` (`./registry.js`). All four
    files are in `architecture.coreFiles.txt` already.
  - The comment above `publishEngine` says why (Global Constraints, "Comments say why").
- [ ] **Step 6: Run and see them pass.**
  `npx vitest run src/lib/paneEngineProcess.spec.ts src/lib/registry.launchCallers.spec.ts src/architecture.spec.ts`
  Expected: all pass (`architecture.spec.ts`: no new core file, no boundary broken). `npm run typecheck`: exit 0.
  `git diff --stat src/architecture.coreFiles.txt`: empty.
- [ ] **Step 7: Commit** `lib/paneEngineProcess.ts`:
  `Relaunch: an engine that named itself before the refresh is published once more, under its new name`.

---

### Task 2: Restart, and a move's fallback to its old pane

**Files:** Modify `cli/src/core/agents/restart.ts`; Test `cli/src/core/agents/restart.spec.ts`.

**Depends on:** Task 1. **Effort:** high.

**Interfaces:** Consumes `publishEngine` (Task 1). `commitRelaunchedEngine`'s signature and results do not change;
`core/agents/hostMove.ts` `relaunchOld` calls it and is not edited.

- [ ] **Step 1: Make the spec's mock keep the real helper.** `restart.spec.ts` line 34 becomes
  `vi.mock('../../lib/paneEngineProcess.js', async (real) => ({ ...await real<object>(), resolvePaneEngineProcess: vi.fn() }))`
  (a mock without `publishEngine` would fail every publication once `restart.ts` imports it).
- [ ] **Step 2: Write the failing tests** in `describe('durable restart publication')` (new imports: `hostMoveDeps`,
  `type HostMoveWiring` from `./hostMove.js`; `MoveGate` from `../../lib/hostMove/gate.js`).

```ts
const started = { ...newProcess, executable: 'node' }
/** The registry runs the refresh before it publishes, as `confirmLaunch` does. */
const refreshing = (run: ReturnType<typeof setup>) => {
  const publish = vi.mocked(run.deps.registry.confirmLaunch).getMockImplementation()!
  vi.mocked(run.deps.registry.confirmLaunch).mockImplementation(async (id, input, authority) => { await authority?.refresh?.(); return publish(id, input, authority) })
}

it('publishes an engine that named itself between the look and the refresh, under its new name', async () => {
  const run = setup()
  refreshing(run)
  vi.mocked(resolvePaneEngineProcess).mockResolvedValue(newProcess)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const result = await commitRelaunchedEngine(run.deps, 'a1', started, null, { runtime, backend: run.tmuxBackend } as unknown as RestartTarget, () => true)
  expect(result).toMatchObject({ processIdentity: newProcess, launch: { state: 'ready' } })
  const calls = vi.mocked(run.deps.registry.confirmLaunch).mock.calls
  expect(calls.map(call => call[1].processIdentity)).toEqual([started, newProcess])
  expect(calls[0]![2]!.expires).toEqual(expect.any(Number))
  expect(calls[1]![2]!.expires).toBe(calls[0]![2]!.expires)
  expect(resolvePaneEngineProcess).toHaveBeenCalledWith(run.tmuxBackend, runtime, 'claude')
  expect(releaseHold).toHaveBeenCalledWith(runtime, expect.any(Function))
  expect(run.deps.announceSession).toHaveBeenCalledWith(expect.objectContaining({ processIdentity: newProcess }))
  expect(log.mock.calls).toEqual([['[restart] publication · engine renamed · a1']])
  expect(warn).not.toHaveBeenCalled()
})

it('a move\'s fallback to its old pane publishes the renamed engine the same way (hostMove.ts relaunchOld)', async () => {
  const row = agent({ registeredAt: 1 } as Partial<RegisteredSession>)
  const run = setup(row)
  refreshing(run)
  vi.mocked(restartAgent).mockResolvedValueOnce({ ok: true, resumed: true, processIdentity: started })
  vi.mocked(resolvePaneEngineProcess).mockResolvedValue(newProcess)
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const w = { registry: run.deps.registry, terminals: run.deps.terminals, paneSwapDeps: run.deps.paneSwapDeps, gate: new MoveGate(),
    buildLaunch: async () => ({ argv: ['claude'], grid: null, deferred: { prepare: vi.fn(), overrides: {}, permission: { bypassPermission: false } } }),
    announce: run.deps.announceSession, log: vi.fn() } as unknown as HostMoveWiring
  const move = hostMoveDeps(row, () => true, w)
  await move.buildLaunch(row, { resumeSessionId: 's1', current: () => true, prepare: false })
  expect(await move.relaunchOld(row)).toBe(true)
  expect(vi.mocked(run.deps.registry.confirmLaunch).mock.calls.map(call => call[1].processIdentity)).toEqual([started, newProcess])
  expect(run.deps.announceSession).toHaveBeenCalledWith(expect.objectContaining({ processIdentity: newProcess }))
  expect(log.mock.calls).toEqual([['[restart] publication · engine renamed · a1']])
})
```

  Two pins, green before and after the change (they hold the rule's edges at this site):
  - `it.each` `pid` (`{ pid: 3 }`) and `start` (`{ startMarker: 'replacement' }`), `still holds a Node runtime whose
    %s changed, whatever it is named now`: `refreshing(run)`, `commitRelaunchedEngine` with `started`, the lookup
    answering `{ ...newProcess, ...change }`: rejects with `code: 'IDENTITY_UNAVAILABLE'`; `confirmLaunch` called
    once; `console.warn`'s calls equal `[['[restart] publication held · refresh found another process']]`; no
    `console.log`, no `releaseHold`, no `announceSession`.
  - `a terminal's shell is published as it was: no engine looked for, no deadline of its own`: `setup(terminal())`,
    `refreshing(run)`, identity `null`, a backend whose `paneState` answers `{ dead: false, engineExit: null }`:
    `resolvePaneEngineProcess` is not called, and the authority `confirmLaunch` got has no `expires` property.

  The existing `rechecks native readiness before publication: %s` cases (`gone`, `replaced`, `executable`:
  `/bin/claude` to `other`) are not edited: they must pass before and after, with their `HELD_BY` words.
- [ ] **Step 3: Run and see the two new tests fail.** `npx vitest run src/core/agents/restart.spec.ts`
  Expected: both rename tests fail on `IDENTITY_UNAVAILABLE` (`…the replacement process changed before publication.`);
  the pins and every existing test pass.
- [ ] **Step 4: Commit the failing tests** (`restart.spec.ts`): `Restart: an engine that named itself before the refresh (failing tests)`.
- [ ] **Step 5: Implement** in `commitRelaunchedEngine`:
  - With `identity` set: `publishEngine(identity, () => resolvePaneEngineProcess(place.backend, place.runtime, engine),
    { gone: NO_ENGINE, changed: ANOTHER_PROCESS }, publish)`, where `publish(process, refresh, expires)` is today's
    `deps.registry.confirmLaunch(agentId, { ...input, processIdentity: process, grid }, { current, refresh, expires })`
    and first logs `console.log(\`[restart] publication · engine renamed · ${sid(agentId)}\`)` when
    `process !== identity`.
  - With `identity` null (a terminal): today's call, unchanged: the `NO_SHELL` refresh, no `expires`.
  - The `.catch` that logs `[restart] publication held · <HELD_BY label>` stays around both.
  - Import `publishEngine` beside `resolvePaneEngineProcess`; drop the `sameProcessIdentity` import, which nothing
    uses now. Add to the function's comment, in a sentence, why an engine may be published under another name.
- [ ] **Step 6: Run and see them pass.**
  `npx vitest run src/core/agents/restart.spec.ts src/core/agents/hostMove.spec.ts src/lib/registry.launchCallers.spec.ts`: all pass.
  `npm run typecheck`: exit 0. `npm run test:core`: exit 0, `core/agents/restart.ts` at 100% in every column.
- [ ] **Step 7: Commit** `restart.ts`: `Restart: an engine that named itself before the refresh is published under its new name`.

---

### Task 3: Retarget

**Files:** Modify `cli/src/core/agents/retarget.ts`; Test `cli/src/core/agents/retarget.spec.ts`.

**Depends on:** Task 1. **Effort:** high.

**Interfaces:** Consumes `publishEngine` (Task 1). `retargetAgent`'s answers do not change.

- [ ] **Step 1: Make the spec's mock keep the real helper.** `retarget.spec.ts` line 18 becomes
  `vi.mock('../../lib/paneEngineProcess.js', async (real) => ({ ...await real<object>(), resolvePaneEngineProcess: vi.fn() }))`.
- [ ] **Step 2: Write the failing test,** beside `rechecks the retargeted process before durable readiness`, and the pin under it.

```ts
const named = { pid: 2, startMarker: 'new', executable: '/bin/claude' }, started = { ...named, executable: 'node' }
const refreshing = (run: ReturnType<typeof setup>) => {
  const publish = vi.mocked(run.deps.registry.confirmLaunch).getMockImplementation()!
  vi.mocked(run.deps.registry.confirmLaunch).mockImplementation(async (id, input, authority) => { await authority?.refresh?.(); return publish(id, input, authority) })
}

it('publishes a retargeted engine that named itself between the look and the refresh, under its new name', async () => {
  const run = setup()
  refreshing(run)
  vi.mocked(restartAgent).mockResolvedValueOnce({ ok: true, resumed: true, processIdentity: started })
  vi.mocked(resolvePaneEngineProcess).mockResolvedValue(named)
  expect(await run.retarget({ agentId: 'a1', grid })).toEqual({ ok: true })
  const calls = vi.mocked(run.deps.registry.confirmLaunch).mock.calls
  expect(calls.map(call => call[1].processIdentity)).toEqual([started, named])
  expect(calls[1]![1]).toMatchObject({ grid: { baseUrl: grid.baseUrl, model: grid.model }, gridLaunchRecord: { override: grid, webSearch: 'off' } })
  expect(calls[0]![2]!.expires).toEqual(expect.any(Number))
  expect(calls[1]![2]!.expires).toBe(calls[0]![2]!.expires)
  expect(resolvePaneEngineProcess).toHaveBeenCalledWith(run.tmux, pane, 'claude')
  expect(run.tmux.releaseHold).toHaveBeenCalledTimes(1)
  expect(run.deps.announceSession).toHaveBeenCalledWith(expect.objectContaining({ processIdentity: named }))
  expect(console.log).toHaveBeenCalledWith('[retarget] publication · engine renamed · a1')
})
```

  A pin, green before and after: `it.each` `pid` (`{ pid: 3 }`) and `start` (`{ startMarker: 'other' }`), `still
  refuses a retargeted Node runtime whose %s changed`: `refreshing(run)`, `restartAgent` answers `started`, the
  lookup `{ ...named, ...change }`: the answer matches `{ ok: false, error: 'RETARGET_FAILED' }`; `confirmLaunch`
  called once; no `releaseHold`, no `announceSession`, no `console.log` line containing `engine renamed`.

- [ ] **Step 3: Run and see the rename test fail.** `npx vitest run src/core/agents/retarget.spec.ts`
  Expected: it fails with `{ ok: false, error: 'RETARGET_FAILED', … }` where `{ ok: true }` was expected; the rest pass.
- [ ] **Step 4: Commit the failing test** (`retarget.spec.ts`): `Retarget: an engine that named itself before the refresh (failing test)`.
- [ ] **Step 5: Implement.** The `registry.confirmLaunch` call at `retarget.ts` ~322-330 becomes
  `publishEngine(outcome.processIdentity, () => resolvePaneEngineProcess(backend, pane, session.engine), reasons, publish)`:
  both reasons are `the retargeted process changed before publication`; `publish(process, refresh, expires)` is
  today's call with `processIdentity: process` and `{ current: dispatchCurrent, refresh, expires }`, every other input
  field as it is, and first logs `console.log(\`[retarget] publication · engine renamed · ${sid(session.agentId)}\`)`
  when `process !== outcome.processIdentity`. Drop the `IdentityReadUnavailable` import and `sameProcessIdentity` from
  the `terminalRuntime.js` import: nothing uses them now.
- [ ] **Step 6: Run and see them pass.**
  `npx vitest run src/core/agents/retarget.spec.ts src/lib/registry.launchCallers.spec.ts src/engines/opencodeLaunch.golden.spec.ts`: all pass.
  `npm run typecheck`: exit 0. `npm run test:core`: exit 0, `core/agents/retarget.ts` at 100%.
- [ ] **Step 7: Commit** `retarget.ts`: `Retarget: an engine that named itself before the refresh is published under its new name`.

---

### Task 4: A move's destination pane

**Files:** Modify `cli/src/core/agents/hostMove.ts`; Test `cli/src/core/agents/hostMove.spec.ts`.

**Depends on:** Task 1. **Effort:** high.

**Interfaces:** Consumes `publishEngine` (Task 1). `MoveAgentDeps.swap` still answers the `LaunchPublication` it got;
`lib/hostMove/moveAgent.ts` is not edited.

- [ ] **Step 1: Write the failing test,** beside `refreshes the exact destination before publishing`, and the pin under it.

```ts
const STARTED: ProcessIdentity = { ...NEW_ID, executable: 'node' }
const refreshing = (w: HostMoveWiring) => {
  const publish = vi.mocked(w.registry.confirmLaunch).getMockImplementation()!
  vi.mocked(w.registry.confirmLaunch).mockImplementation(async (id, input, authority) => { await authority?.refresh?.(); return publish(id, input, authority) })
}

it('publishes a destination engine that named itself between the look and the refresh, under its new name', async () => {
  const { w, row } = wiring()
  refreshing(w)   // probeProcess answers NEW_ID: `claude`
  const deps = hostMoveDeps(row, () => true, w)
  expect(await deps.swap('a1', NEW, STARTED)).toMatchObject({ state: 'confirmed', entry: { processIdentity: NEW_ID, runtimes: [NEW] } })
  const calls = vi.mocked(w.registry.confirmLaunch).mock.calls
  expect(calls.map(call => call[1].processIdentity)).toEqual([STARTED, NEW_ID])
  expect(calls.map(call => call[1].runtimes)).toEqual([[NEW], [NEW]])
  expect(calls[0]![2]!.expires).toEqual(expect.any(Number))
  expect(calls[1]![2]!.expires).toBe(calls[0]![2]!.expires)
  expect(w.restore.probeProcess).toHaveBeenCalledWith(NEW, 'claude')
  expect(w.invalidateControl).toHaveBeenCalledExactlyOnceWith('a1')
  expect(w.log).toHaveBeenCalledWith('[move] publication · engine renamed · a1')
  deps.complete()
  expect(w.announce).toHaveBeenCalledWith(expect.objectContaining({ processIdentity: NEW_ID }))
})
```

  A pin, green before and after: `it.each` `pid` (`{ pid: 99 }`) and `start` (`{ startMarker: 'other' }`), `still
  refuses a destination Node runtime whose %s changed`: `refreshing(w)`, `probeProcess` answers
  `{ ...NEW_ID, ...change }`: `swap('a1', NEW, STARTED)` rejects with `code: 'IDENTITY_UNAVAILABLE'`; `confirmLaunch`
  called once; `row.runtimes` is still `[OLD]`; no `invalidateControl`, no `w.log`.

- [ ] **Step 2: Run and see the rename test fail.** `npx vitest run src/core/agents/hostMove.spec.ts`
  Expected: it fails on `IDENTITY_UNAVAILABLE` (`…the move destination changed before publication.`); the rest pass.
- [ ] **Step 3: Commit the failing test** (`hostMove.spec.ts`): `Move: a destination engine that named itself before the refresh (failing test)`.
- [ ] **Step 4: Implement** in `swap`: the `w.registry.confirmLaunch` call becomes
  `publishEngine(identity, () => w.restore.probeProcess(runtime, recorded.engine), reasons, publish)`: both reasons are
  `the move destination changed before publication`; `publish(process, refresh, expires)` is today's call with
  `processIdentity: process`, the same `runtimes: [runtime]` and `grid`, and
  `{ current: <today's>, refresh, expires }`, and first logs
  `w.log(\`[move] publication · engine renamed · ${sid(id)}\`)` when `process !== identity`. What follows the
  publication (`confirmed`, `invalidateControl`, the return) does not change. Import `publishEngine`
  (`../../lib/paneEngineProcess.js`) and `sid` (beside `codeOrLength`); drop the `IdentityReadUnavailable` import and
  `sameProcessIdentity` from the `terminalRuntime.js` import.
- [ ] **Step 5: Run and see them pass.**
  `npx vitest run src/core/agents/hostMove.spec.ts src/lib/hostMove src/lib/registry.launchCallers.spec.ts src/architecture.spec.ts`: all pass.
  `npm run typecheck`: exit 0. `npm run test:core`: exit 0, `core/agents/hostMove.ts` at 100%.
- [ ] **Step 6: Commit** `hostMove.ts`: `Move: a destination engine that named itself before the refresh is published under its new name`.

---

### Task 5: Resume

**Files:** Modify `cli/src/lib/resumeAgentService.ts`; Test `cli/src/lib/resumeAgentService.spec.ts`,
`cli/src/lib/controlResume.golden.spec.ts` (its mock only).

**Depends on:** Task 1. **Effort:** high.

**Interfaces:** Consumes `publishEngine` (Task 1). The resume's answers do not change.

- [ ] **Step 1: Make both specs' mocks keep the real helper** (each runs a resume through to its publication).
  `resumeAgentService.spec.ts` line 83:
  `vi.mock('./paneEngineProcess.js', async (real) => ({ ...await real<object>(), checkSessionRuntime: vi.fn(), resolvePaneEngineProcess: vi.fn(), ENGINE_SETTLE_MS: 0 }))`.
  `controlResume.golden.spec.ts` line 27: the same spread in front of its three fields. Nothing else in the golden
  spec or its recorded file changes.
- [ ] **Step 2: Write the failing test and the pin** in `resumeAgentService.spec.ts`, beside
  `revokes resumed authority when %s changes during durable preparation`. The spec's registry is the real one;
  `identity` is `{ pid: 54321, startMarker: 'new-process', executable: 'codex' }`.

```ts
const started = { ...identity, executable: 'node' }

it('publishes a resumed engine that named itself between the look and the refresh, under its new name', async () => {
  // The wait's look, then each write's refresh.
  vi.mocked(resolvePaneEngineProcess).mockReset().mockResolvedValueOnce(started).mockResolvedValue(identity)
  const confirm = vi.spyOn(registry, 'confirmLaunch')
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  expect(await start()).toMatchObject({ ok: true, session: { processIdentity: identity, launch: { state: 'ready' } } })
  expect(confirm.mock.calls.map(call => call[1].processIdentity)).toEqual([started, identity])
  expect(confirm.mock.calls[0]![2]!.expires).toEqual(expect.any(Number))
  expect(confirm.mock.calls[1]![2]!.expires).toBe(confirm.mock.calls[0]![2]!.expires)
  expect(resolvePaneEngineProcess).toHaveBeenLastCalledWith(tmuxTerminal, { backend: 'tmux', paneId: pane }, 'codex')
  expect(releaseHold).toHaveBeenCalledOnce()
  expect(deps.stoppedAgents.resumeReservedAt(saved.agentId)).toBeNull()
  expect(log).toHaveBeenCalledWith(`[resume] publication · engine renamed · ${saved.agentId.slice(0, 8)}`)
  registry.load()
  expect(registry.byAgent(saved.agentId)?.processIdentity).toEqual(identity)
})
```

  A pin, green before and after: `it.each` `pid` (`{ pid: 54322 }`) and `start`
  (`{ startMarker: 'replacement-process' }`), `keeps a resumed Node runtime whose %s changed unconfirmed`: the lookup
  answers `started` once, then `{ ...identity, ...change }`: `start()` matches
  `{ ok: false, error: 'RESUME_UNCONFIRMED' }`; `registry.confirmLaunch` called once; no `releaseHold`; the resume's
  reservation is kept (`resumeReservedAt` not null); the row's launch is not `ready`.

  The existing `keeps a resumed shell unconfirmed when final publication sees it %s` cases are not edited: the shell
  branch must pass before and after.
- [ ] **Step 3: Run and see the rename test fail.** `npx vitest run src/lib/resumeAgentService.spec.ts`
  Expected: it fails with `{ ok: false, error: 'RESUME_UNCONFIRMED', … }` where `ok: true` was expected; the rest pass.
- [ ] **Step 4: Commit the failing test** (both spec files): `Resume: an engine that named itself before the refresh (failing test)`.
- [ ] **Step 5: Implement** in `waitForResume` (~line 153):
  - An engine (`!shell`): `publishEngine(process, () => resolvePaneEngineProcess(terminal, runtime, saved.engine),
    reasons, publish)`: both reasons are `the resumed process changed before readiness was saved`;
    `publish(identity, refresh, expires)` is today's call with `processIdentity: identity`, the same `grid` and
    `launchArgs`, and `{ current: ownsRoute, refresh, expires }`, and first logs
    `console.log(\`[resume] publication · engine renamed · ${sid(saved.agentId)}\`)` (the file's own `sid`) when
    `identity !== process`.
  - A shell: today's call, unchanged: its pane-state refresh, no `expires`.
  - The `try`/`catch` around the publication (`resumeChanged`, `resumeUnconfirmed`, rethrow) and all that follows
    (`confirmedResume`, `releaseHold`, the log, the attach) do not change.
- [ ] **Step 6: Run and see them pass.**
  `npx vitest run src/lib/resumeAgentService.spec.ts src/lib/controlResume.golden.spec.ts src/lib/controlTranscript.spec.ts`: all pass.
  `npm run typecheck`: exit 0. `npm run test:resume`: exit 0, `resumeAgentService.ts` at 100% in every column.
- [ ] **Step 7: Commit** `resumeAgentService.ts`: `Resume: an engine that named itself before the refresh is published under its new name`.

---

### Task 6: Restore

**Files:** Modify `cli/src/lib/restoreAgents.ts`; Test `cli/src/lib/restoreAgents.spec.ts`,
`cli/src/lib/restoreAgents.settle.spec.ts`.

**Depends on:** Task 1. **Effort:** xhigh (the watch's first-hook selection, its own ownership retry and the settle
window all meet this publication).

**Interfaces:** Consumes `publishEngine` (Task 1). `watchRestoredPane`'s outcomes do not change for a process that did
not rename.

- [ ] **Step 1: Write the failing tests** in `restoreAgents.spec.ts`, in
  `describe('restoreAgents — waiting for the engine')` (new import: `RegistryOwnershipChanged` from `./registry.js`).
  The harness's `identity(7)` is `{ pid: 7, executable: 'claude', startMarker: 'start 7' }`.

```ts
const started = { ...identity(7), executable: 'node' }
/** Records each write, and runs its refresh before it publishes, as `confirmLaunch` does. */
const refreshing = (h: Harness) => {
  const publish = h.deps.registry.confirmLaunch
  const writes: Array<[string | undefined, number | undefined]> = []
  h.deps.registry.confirmLaunch = async (id, input, authority) => {
    writes.push([input.processIdentity?.executable, authority?.expires])
    await authority?.refresh?.()
    return publish(id, input, authority)
  }
  return writes
}

it('publishes an engine that named itself between the look and the refresh, then settles and hands the pane over', async () => {
  const h = harness([row()])
  h.probes.set('%0', [started, identity(7), identity(7)])   // the look, the refused refresh, the re-write's refresh
  const writes = refreshing(h), log = vi.fn()
  h.deps.log = log
  await restoreAgents(h.deps)
  await settled(h, 1, 1)
  expect(writes.map(([executable]) => executable)).toEqual(['node', 'claude'])
  expect(writes[0]![1]).toEqual(expect.any(Number))
  expect(writes[1]![1]).toBe(writes[0]![1])   // restore's own expires, for both
  expect(h.rows.get('agent-a')).toMatchObject({ processIdentity: identity(7), launch: { state: 'ready' } })
  expect(h.calls).toContain('clearRemainOnExit:%0')
  const lines = log.mock.calls.map(call => call.join(' '))
  expect(lines).toContain('[restore] publication · engine renamed · agent-a')
  expect(lines.some(line => line.includes('engine up'))).toBe(true)
  expect(lines.some(line => line.includes('watch failed'))).toBe(false)
})

it('re-writes once when its own retry after a first hook is the look that sees the new name', async () => {
  const h = harness([row({ sessionId: '' })])
  h.probes.set('%0', [started, identity(7), identity(7)])   // the look, the retry's own refresh, the re-write's refresh
  const publish = h.deps.registry.confirmLaunch
  const writes: Array<string | undefined> = []
  h.deps.registry.confirmLaunch = async (id, input, authority) => {
    writes.push(input.processIdentity?.executable)
    if (writes.length === 1) {
      // The engine's first hook bound this process while the write was prepared.
      Object.assign(h.rows.get(id)!, { sessionId: 'hooked', processIdentity: started })
      throw new RegistryOwnershipChanged('the registry owner changed while its write was being prepared')
    }
    await authority?.refresh?.()
    return publish(id, input, authority)
  }
  await restoreAgents(h.deps)
  await settled(h, 1, 1)
  expect(writes).toEqual(['node', 'claude'])
  expect(h.rows.get('agent-a')).toMatchObject({ sessionId: 'hooked', processIdentity: identity(7), launch: { state: 'ready' } })
  expect(h.calls).toContain('clearRemainOnExit:%0')
})
```

  A pin, green before and after: `it.each` `pid` (`identity(8)`) and `start`
  (`{ ...identity(7), startMarker: 'start again' }`), `ends the watch, as before, when a Node runtime's %s changed
  before the refresh`: probes `[started, changed]` with `refreshing(h)`: after `settled(h, 1)`, one write; the row's
  launch is not `{ state: 'ready' }`; `h.calls` has no `clearRemainOnExit:%0`; a log line contains `watch failed`,
  none `engine renamed`.

- [ ] **Step 2: Write the failing settle-window test** in `restoreAgents.settle.spec.ts` (the real registry), after
  `a fresh engine whose first hook binds in the settle window is accepted`. `engine` is
  `{ pid: 7002, startMarker: 'restored', executable: '/fixture/codex' }`.

```ts
it('a fresh engine that named itself before the refresh, whose first hook binds it in the settle window, is accepted', async () => {
  const row = await starting(false)
  let looks = 0
  const w = watch({ probeProcess: async () => looks++ ? engine : { ...engine, executable: 'node' } })
  await restoreAgents(w.deps)
  await Promise.race([w.settling, w.finished])   // a watch that ended at the refresh never settles
  expect(registry.byAgent(row.agentId)).toMatchObject({ processIdentity: engine, launch: { state: 'ready' } })
  expect(await hook()).not.toBeNull()
  w.settle(); await w.finished
  expect(w.deps.clearRemainOnExit).toHaveBeenCalledOnce()
  expect(registry.byAgent(row.agentId)).toMatchObject({ sessionId: id, processIdentity: engine })
  expect(w.deps.log).toHaveBeenCalledWith(`[restore] publication · engine renamed · ${row.agentId.slice(0, 8)}`)
})
```

- [ ] **Step 3: Run and see them fail.**
  `npx vitest run src/lib/restoreAgents.spec.ts src/lib/restoreAgents.settle.spec.ts`
  Expected: the two rename tests in `restoreAgents.spec.ts` fail waiting for the second release (the watch ended at
  `watch failed`); the settle test fails on a row that is not `ready` (its watch ended too); the pin and every existing
  test pass.
- [ ] **Step 4: Commit the failing tests** (both spec files): `Restore: an engine that named itself before the refresh (failing tests)`.
- [ ] **Step 5: Implement** in `watchRestoredPane` (~lines 945-961):
  - `expires` is computed as today. The hand-written `refresh` and the `let publication` / `try` / `catch` become one
    `publishEngine(identity, () => deps.probeProcess(runtime, engine), reasons, publish, expires)`: both reasons are
    `the restored process changed before publication`.
  - `publish(process, refresh, expires)` keeps the site's own retry, on the identity it is publishing: it awaits
    `deps.registry.confirmLaunch(agentId, { processIdentity: process, grid }, { current, refresh, expires })`; on
    `RegistryOwnershipChanged` with `selectFirstHook(process)` true it awaits `refresh()` and calls `confirmLaunch`
    once more the same way; any other error is rethrown. It first logs
    `deps.log(\`[restore] publication · engine renamed · ${sid(agentId)}\`)` when `process !== identity`, and
    remembers `process` as the identity published.
  - After the settle window, `selectFirstHook` takes that published identity (today's `selectFirstHook(identity)` at
    ~line 973). The check before the publication (~lines 942-944) and everything else in the loop stay as they are.
  - Import `publishEngine` (`./paneEngineProcess.js`) and `sid` (beside `codeOrLength`, `errorKind`). Keep the comment
    "Recorded at first sight…" above the publication.
- [ ] **Step 6: Run and see them pass.**
  `npx vitest run src/lib/restoreAgents.spec.ts src/lib/restoreAgents.settle.spec.ts src/lib/registry.launchCallers.spec.ts src/lib/restoreTerminals.spec.ts src/architecture.spec.ts`: all pass.
  `npm run typecheck`: exit 0.
- [ ] **Step 7: Commit** `restoreAgents.ts`: `Restore: an engine that named itself before the refresh is published under its new name`.

---

## Verification

No new end-to-end test (decided): the e2e fake engine never starts as `node` (its shim's `comm` is `codex` before and
after), and the window between the last look and the refresh cannot be hit on purpose, so a timed rename would be a
flaky test. The behavior is proven by the unit specs above, three of them on the real registry (Task 1's, the resume
spec, the restore settle spec). The checks below show that nothing else moved.

Isolation: unit specs use fakes and each spec's own throwaway data folder. The e2e files follow the repo's e2e rules
(`cli/AGENTS.md` rules 5 and 6, `cli/e2e/harness/daemon.ts`): each `IsolatedDaemon` has a throwaway home and data
folder, its own socket and port (never 18473), a private tmux server and the fake Claude Code and Codex engines
(`e2e/harness/fakeEngine.mjs`). On GitHub the runner is disposable, and what its setup action starts
(`.github/actions/cli-e2e-setup`: the repo's backend on an in-memory Mongo and Redis) lives and dies on it. Nothing
signs in; no account, no backend of a person's, no production. No check needs Diego himself.

The eight e2e files, the same in checks 2 and 3, and what each is here for:

| File (`cli/e2e/`) | Path it holds still |
|---|---|
| `stall.e2e.ts` | a restart, a resume and a restore after a daemon restart, with the core held still around each publication |
| `restartIdentity.e2e.ts` | restart |
| `races.e2e.ts` | two restarts at once, two resumes at once |
| `updates.e2e.ts` | a restart and a resume after the engine was replaced on disk |
| `modelSwitch.e2e.ts` | retarget |
| `eagerOpenCode.e2e.ts` | discovery racing a publication (retarget, resume) |
| `restoreInput.e2e.ts` | a restore's relaunch of a Claude Code and a Codex agent after their tmux server was lost, a message sent before the engine starts |
| `adopt.e2e.ts` | an adopted Codex conversation: a restart, restores after the tmux server was lost, a resume |

A move has no e2e file. The fake engine shows no rename on either platform, so both runs prove only that the five
paths still publish as before.

1. **Local gates, the tester on this Mac, final head, clean tree.** `cd cli && npm run typecheck`; `npx vitest run
   src/lib/paneEngineProcess.spec.ts src/lib/registry.launchCallers.spec.ts src/lib/restoreAgents.spec.ts
   src/lib/restoreAgents.settle.spec.ts src/lib/controlResume.golden.spec.ts src/architecture.spec.ts`; `npm run
   test:core` (100% per file: `restart.ts`, `retarget.ts`, `hostMove.ts` changed); `npm run test:resume` (100%:
   `resumeAgentService.ts` changed); then `python3 scripts/local-checks.py --run` from the repo root, its output pasted
   into the PR body (PR CI runs neither coverage gate). Seen: all green; `git diff main -- cli/src/architecture.coreFiles.txt`
   is empty. These specs carry the platforms: the rule on Linux names (`node`, `nodejs`, `/usr/bin/node`), on Windows
   names (`node.exe`, a backslash path), and "unchanged" for macOS and Windows, whose executable never changes.
2. **macOS e2e, the tester on this Mac, only when the PM gives this branch the Mac's e2e turn** (one e2e run at a time;
   an arm64 Node, Xcode's command line tools, `tmux`). The eight files, as Vitest takes them from `cli/`:

   ```bash
   cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/stall.e2e.ts e2e/restartIdentity.e2e.ts e2e/races.e2e.ts e2e/updates.e2e.ts e2e/modelSwitch.e2e.ts e2e/eagerOpenCode.e2e.ts e2e/restoreInput.e2e.ts e2e/adopt.e2e.ts
   ```

   Seen: every file passes, none skipped. macOS never shows the rename.
3. **Linux e2e on GitHub, once, by hand: a check group of its own in phase 4, started only on the orchestrator's
   heavy-workflow turn** (never beside another heavy workflow; `docs/validation-and-release.md`, "Heavy workflows").
   Why: PR CI's `linux-e2e` runs only the e2e files a PR changes, this one changes none, and Linux is the one platform
   whose behavior changes. The workflow is `CI` (`.github/workflows/ci.yml`), its `workflow_dispatch` inputs `scope`
   and `e2e_files`. The final head is pushed to the branch first: the run tests the branch's head, and its `plan` job
   refuses a file that is not at that head. From the repo root:

   ```bash
   gh workflow run ci.yml --ref fix/core-relaunch-engine-rename -f scope=linux-e2e -f e2e_files="cli/e2e/stall.e2e.ts cli/e2e/restartIdentity.e2e.ts cli/e2e/races.e2e.ts cli/e2e/updates.e2e.ts cli/e2e/modelSwitch.e2e.ts cli/e2e/eagerOpenCode.e2e.ts cli/e2e/restoreInput.e2e.ts cli/e2e/adopt.e2e.ts"
   gh run list --workflow ci.yml --branch fix/core-relaunch-engine-rename --event workflow_dispatch --limit 1 --json databaseId,headSha,url
   gh run watch <databaseId> --exit-status
   ```

   `e2e_files` is one string of repository paths separated by spaces: `cli/e2e/…`, not check 2's `e2e/…`
   (`scripts/ci-plan.py` splits on spaces and fails the plan on any path that is not a `cli/e2e` file `linux-e2e`
   runs). The same from the page: **Actions → CI → Run workflow**, the branch, `scope=linux-e2e`, `e2e_files` that
   string. It runs on `ubuntu-24.04` with the CI e2e config (`cli/vitest.e2e.ci.config.ts`). Seen: `headSha` is the
   final head; `plan` green; `linux-e2e (1)` and `linux-e2e (2)` green (two runners by today's timing hints,
   `cli/ci-e2e-durations.json`: seven files at the 60 s default and `races` at 264 s, above one runner's 10 minutes);
   `linux-e2e-summary` green, which holds the run to the eight files, each run and passed, and its job summary lists
   no file whose every case skipped. The run link goes into the PR. A failing shard leaves its daemons' logs in the
   artifact `linux-e2e-daemon-logs-<shard>`.
4. **PR CI on the head, on its own:** `ci/required` with the jobs its plan selects for a `cli/src` change, on Linux,
   macOS and Windows as selected. Seen: green. No run is started beyond check 3's. The PR names the platforms: Linux
   (the one that sees the rename), macOS and Windows unchanged.

No workflow is proposed: every check here either runs locally by rule (the coverage gates) or already has a by-hand
workflow (the e2e files).
