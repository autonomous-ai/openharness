# Skill-run isolation Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3** (wave by wave; each task commits its failing
> test, then the code). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `harness new openclaw --local <folder>` runs OpenClaw with its runtime and tools inside the process Harness
started, on that folder, and a stop ends that process's whole tree; `harness delete <name>` erases everything Harness
keeps of a harness and says what it kept.

**Architecture:** The folder is one optional field, `openclawLocal`, on `agent_create` and on the registry row. Every
launch reaches the engine through the native launch (`engines/nativeLaunch.ts`), so the folder rides it: it pins
`OPENCLAW_STATE_DIR`, clears the other OpenClaw path variables, and tells the argv builder to add `--local`. No launch
site learns about it. Stop lists the engine's descendants once and signals them with it. `harness delete` is a CLI
door to the existing `agent_purge`, which now also erases the ledger's `Told` lines, the receipt's request, and
recaps, checkpoints and search rows under every session key, and keeps OpenClaw's store instead of refusing.

**Tech Stack:** TypeScript (`cli/src`, daemon core and CLI), vitest, `node:sqlite` (Node 24), tmux, the pty host.

**Spec:** [docs/plans/2026-11-12-skill-run-isolation-design.md](2026-11-12-skill-run-isolation-design.md).
Read it with this plan, and `AGENTS.md`, `cli/AGENTS.md`, `cli/src/services/AGENTS.md`, `docs/naming-system.md`. The
spec is the authority, its "(my call)" decisions included.

## Global Constraints

- Platforms: macOS, Linux, Windows. CLI and daemon only: no Desktop, phone, backend or relay change. No new
  dependency, switch or setting. No `--no-save`, no MCP tool for delete, no `--local` for another engine.
- Harness never creates, seeds or deletes the `--local` folder, and never falls back to the shared state folder for a
  row that has one.
- The field is `openclawLocal` everywhere: the `agent_create` payload, `RegisteredSession`, `NativeLaunchSource`,
  `NativeLaunch`, `LaunchSource`. An absolute path. It is not the existing `openclawStateDir` (the folder a TUI was
  seen holding), which a local row sets to the same value from the start.
- OpenClaw facts (2026.11.2, read from `/opt/homebrew/lib/node_modules/openclaw/dist`, read-only): `tui --local`
  refuses a positional target and takes `--session <key>`; its title is `openclaw tui - local embedded - agent … -
  session …` (no URL); status lines are `starting local runtime`, `local ready` or `local ready | idle`,
  `⠏ running • 6s | local ready`, `local runtime stopped[: <reason>] | idle` for 5 s, then `local stopped | idle`; a
  folder a Gateway holds exits with `A Gateway is running for this state directory (pid …`, one another local TUI
  holds with `failed to acquire gateway state ownership`, both before anything is drawn.
- Exact copy from the spec: `--local is for OpenClaw only.` · `<folder> is not a folder.` ·
  `This Harness daemon is too old for --local. Restart Harness.` · `This run cannot be forked.` ·
  `OpenClaw's local run stopped: <reason>` · `OpenClaw's local run stopped.` ·
  `Another OpenClaw is using this folder. Give each run its own --local folder.` ·
  `This run's OpenClaw folder is gone.` · `OpenClaw's store is kept: delete its session with OpenClaw.`
- Copy this plan adds (the spec left it open): `--local runs on this computer only.` ·
  `harness delete works on this computer only.` · `The agent ledger is busy. Try again.` ·
  `This Harness could not prepare the --local folder. Nothing was started.` · the delete output and usage in Task 11.
- Wire codes this plan adds: `INVALID_LOCAL_FOLDER`, `OPENCLAW_FOLDER_GONE`, `OPENCLAW_FOLDER_IN_USE`,
  `OPENCLAW_LOCAL_UNPREPARED`; a local fork answers the existing `FORK_UNSUPPORTED`.
- Nothing of a run reaches a log or a measure: no task text, no stop reason, no folder path. The launch's log line
  says `local`; product-usage counters do not change (their list is shared with the backend).
- Tests never touch the real `~/.harness`, `~/.openclaw`, daemon (18473) or tmux server; no fixed sleeps.
- `cli/src/core/**` stays at 100% per file: every branch a task adds there is covered by that task's own spec.
  The gates run once, in Task 16, not per task.
- Compatibility: daemon and CLI ship together. `agent_purge` keeps its request shape; its answer gains `kept`.
  The search index keeps its schema version (one more table, one more index, both additive).
- Data this plan adds to the spec's "Data and design": `earlierSessionIds`, at most 32 keys a row; `excluded`, one
  row per deleted conversation still on disk, dropped by the sweep; the ledger lock, waited for 2 s at most; one
  streamed pass of the receipts folder per delete.
- Windows: read `docs/windows-rules.md` first. No task adds a process start there: Task 3's read of the process
  table is not run on Windows, and Task 5's lock uses the helper the registry's lock already uses.

## Review Focus

Failure modes the spec implies that are most likely to bite, each pinned by a test in the task that owns the code:

1. **Delete says done while words remain.** The ledger lock is held, or a receipt cannot be rewritten. Expected: the
   delete is refused and says so, the archive stays, a second `harness delete` finishes it. Task 12.
2. **The tree kill hits something that is not the run's.** A descendant in the pane shell's process group, or Hermes's
   gateway, which serves every Hermes session from under one pane. Expected: the shell and the gateway live. Task 3.
3. **Deleting an outside conversation empties the index.** Conversations Harness did not start all have an empty
   agent id. Expected: only the one named goes. Task 4.
4. **A stop reason that wraps onto two lines, or carries a key.** Expected: the hold still shows, with the reason's
   text; no log line has the reason. Tasks 1 and 9.
5. **A folder path with a space or a quote, relative, with a trailing slash, or a link to a folder.** Expected: one
   absolute path, accepted, and exported intact in the pane script. Tasks 7 and 8.

## Files

| File | What changes | Task |
|---|---|---|
| `cli/src/engines/openclaw/contract.ts` | local launch words, local status lines, the stopped hold, the lock refusal, copy | 1 |
| `cli/src/lib/registry.ts` | `openclawLocal` and `earlierSessionIds` on the row | 2 |
| `cli/src/lib/processTree.ts` (new), `lib/deleteAgentFallback.ts`, `lib/stopAgentService.ts` | stop ends the engine's tree | 3 |
| `cli/src/lib/sessionSearch/store.ts`, `indexer.ts` | secure delete, the persisted exclusion, every session of an agent | 4 |
| `cli/src/agentClient/ledger.ts` | one lock for every writer, `forgetTold` | 5 |
| `cli/src/lib/agentCreationReceipt.ts` | `scrubCreated` | 6 |
| `cli/src/lib/newCommand.ts`, `cli/src/localWsServer.ts` | `--local`, and how the daemon says it knows it | 7 |
| `cli/src/lib/engineLaunch.ts`, `cli/src/engines/nativeLaunch.ts` | argv, pane environment, cleared variables | 8 |
| `cli/src/core/agents/bind.ts`, `cli/src/lib/agentFrame.ts` | local screen states on the agent; the folder is never re-read | 9 |
| `cli/src/core/agents/newPane.ts` | folder in use; `local` in the launch's log line | 10 |
| `cli/src/agentClient/commands.ts`, `cli/src/cli.ts` | `harness delete` | 11 |
| `cli/src/lib/purgeAgentService.ts`, `cli/src/core/agents/lifecycle.ts`, `cli/src/core/main.ts` | purge erases every record, keeps OpenClaw's store | 12 |
| `cli/src/core/agents/launches.ts`, `create.ts`, `cli/src/lib/createAgentPane.ts`, `cli/src/backendSocket.ts` | the field on the wire and into the row | 13 |
| `cli/src/lib/launchOverrides.ts`, `cli/src/core/agents/launch.ts`, `fork.ts` | relaunch keeps it, folder gone, no fork | 14 |
| `cli/e2e/skillRun.e2e.ts` (new) | the real daemon: a deleted harness leaves no word | 15 |

## Waves

A wave's tasks depend on nothing in the same wave and share no file, tests included.

| Wave | Tasks |
|---|---|
| 1 | 1 Contract · 2 Registry row · 3 Stop ends the tree · 4 Search index · 5 Ledger lock · 6 Receipt scrub · 7 `harness new --local` |
| 2 | 8 Launch argv and environment · 9 Bind and frame · 10 New pane watcher · 11 `harness delete` · 12 Purge |
| 3 | 13 Wire and create · 14 Relaunch and fork · 15 End-to-end spec |
| 4 | 16 Gates |
| 5 | 17 End to end, on this Mac |

Every command below runs from `cli/`.

---

### Task 1: OpenClaw contract

**Depends on:** nothing.

**Files:**
- Modify: `cli/src/engines/openclaw/contract.ts`
- Test: `cli/src/engines/openclaw/contract.spec.ts`

**Interfaces (produces):**
- `OPENCLAW_LAUNCH.local: ['--local']`, `OPENCLAW_LAUNCH.resumeLocal: (key: string) => ['--session', key]`,
  `OPENCLAW_LAUNCH.localClear: ['OPENCLAW_CONFIG_PATH', 'OPENCLAW_AGENT_DIR', 'OPENCLAW_OAUTH_DIR', 'OPENCLAW_WORKSPACE_DIR']`.
- `OpenclawPaneState` gains `'local-stopped'`. `OpenclawScreen.stopped: string | null`: the reason on a
  `local runtime stopped` line (`''` when it gives none), `null` on every other screen, `local stopped` included.
  The reason is the text after `local runtime stopped: ` up to a trailing ` | idle`, control characters removed,
  trimmed, at most 200 characters. The line is looked for in the 4 non-blank lines above the footer and joined with
  the lines under it, so a wrapped reason still reads.
- `local ready` alone or before ` | idle|aborted|error` reads `state: 'ready'`. `starting local runtime` reads as
  `connecting` does today: `state: 'busy'`, `running: false`. `⠏ running • 6s | local ready` already reads busy and
  running. The local title is not a URL title: `url` stays `null`, the key comes from the footer.
- `OPENCLAW_LOCAL`: `{ notOpenclaw, notFolder(folder), folderInUse, folderGone, noFork, unprepared }`, the copy in
  Global Constraints. `OPENCLAW_STORE_KEPT`: the store copy. Neither joins `OPENCLAW_STATES` (those are holds).
- `openclawLocalStopped(reason: string | null): string`: `OpenClaw's local run stopped: <reason>`, or
  `OpenClaw's local run stopped.` for `null` or `''`. `isOpenclawLocalStopped(hold: string | null | undefined): boolean`.
- `openclawFolderInUse(capture: string): boolean`: a line starts `A Gateway is running for this state directory`
  or holds `failed to acquire gateway state ownership`.

- [ ] **Step 1: Write the failing tests** in `contract.spec.ts`

```ts
const local = (status: string) => fixture('screen-plain.txt')
  .replace('openclaw tui - ws://127.0.0.1:18789 - ', 'openclaw tui - local embedded - ').replace(' connected | idle', ` ${status}`)

it('reads a local run off its status line', () => {
  expect(readOpenclawScreen(local('local ready | idle'))).toMatchObject({ key: 'agent:main:plain', url: null, state: 'ready', running: false, stopped: null })
  expect(readOpenclawScreen(local('local ready')).state).toBe('ready')
  expect(readOpenclawScreen(local('starting local runtime'))).toMatchObject({ state: 'busy', running: false })
  expect(readOpenclawScreen(local('⠏ running • 6s | local ready'))).toMatchObject({ state: 'busy', running: true })
  expect(readOpenclawScreen(local('local runtime stopped: boom | idle'))).toMatchObject({ state: 'local-stopped', stopped: 'boom' })
  expect(readOpenclawScreen(local('local runtime stopped | idle'))).toMatchObject({ state: 'local-stopped', stopped: '' })
  expect(readOpenclawScreen(local('local stopped | idle'))).toMatchObject({ state: 'local-stopped', stopped: null })
  expect(readOpenclawScreen(local('local runtime stopped: model relay refused the\n request | idle')))
    .toMatchObject({ state: 'local-stopped', stopped: 'model relay refused the request' })
  expect(readOpenclawScreen(fixture('screen-plain.txt')).stopped).toBeNull()
})

it('says a stopped local run, with its reason when it has one', () => {
  expect(openclawLocalStopped('boom')).toBe("OpenClaw's local run stopped: boom")
  expect(openclawLocalStopped('')).toBe("OpenClaw's local run stopped.")
  expect(openclawLocalStopped(null)).toBe("OpenClaw's local run stopped.")
  expect(isOpenclawLocalStopped("OpenClaw's local run stopped: boom")).toBe(true)
  expect(isOpenclawLocalStopped(OPENCLAW_STATES.noGateway)).toBe(false)
  expect(Object.values(OPENCLAW_STATES).some(isOpenclawLocalStopped)).toBe(false)
})

it('knows the words OpenClaw leaves when its folder is taken', () => {
  expect(openclawFolderInUse('A Gateway is running for this state directory (pid 7, port 18789). Run without --local to use it')).toBe(true)
  expect(openclawFolderInUse('Error: failed to acquire gateway state ownership')).toBe(true)
  expect(openclawFolderInUse(fixture('screen-no-token.txt'))).toBe(false)
})

it('the local launch words and copy read as written', () => {
  expect(OPENCLAW_LAUNCH.local).toEqual(['--local'])
  expect(OPENCLAW_LAUNCH.resumeLocal('agent:main:harness-1')).toEqual(['--session', 'agent:main:harness-1'])
  expect(OPENCLAW_LAUNCH.localClear).toEqual(['OPENCLAW_CONFIG_PATH', 'OPENCLAW_AGENT_DIR', 'OPENCLAW_OAUTH_DIR', 'OPENCLAW_WORKSPACE_DIR'])
  expect(OPENCLAW_LOCAL).toMatchObject({ notOpenclaw: '--local is for OpenClaw only.',
    folderInUse: 'Another OpenClaw is using this folder. Give each run its own --local folder.',
    folderGone: "This run's OpenClaw folder is gone.", noFork: 'This run cannot be forked.',
    unprepared: 'This Harness could not prepare the --local folder. Nothing was started.' })
  expect(OPENCLAW_LOCAL.notFolder('/nowhere')).toBe('/nowhere is not a folder.')
  expect(OPENCLAW_STORE_KEPT).toBe("OpenClaw's store is kept: delete its session with OpenClaw.")
})
```

- [ ] **Step 2:** `npx vitest run src/engines/openclaw/contract.spec.ts` → FAIL (`stopped` undefined, the exports
  missing). Commit: `OpenClaw contract: a local run's launch words, screen and copy (red)`.
- [ ] **Step 3:** Implement the Interfaces. `NOTHING` gains `stopped: null`.
- [ ] **Step 4:** `npx vitest run src/engines/openclaw` → PASS. Commit: `OpenClaw contract: a local run's launch words, screen and copy`.

### Task 2: Registry row

**Depends on:** nothing.

**Files:**
- Modify: `cli/src/lib/registry.ts` (the row type near `openclawStateDir`; `strictPersistedRow`; `load()`'s literal;
  `openPendingAgent`; `register`'s carry-forward and its `rebound`; `setOpenclawStateDir`)
- Test: `cli/src/lib/registry.local.spec.ts` (create; set up as `registry.firstTask.spec.ts` does),
  `cli/src/lib/stoppedAgents.spec.ts`

**Interfaces (produces):**
- `RegisteredSession.openclawLocal?: string`: the `--local` folder. Kept when it is a non-empty string, as written (a
  path that is not there is refused at launch, never dropped here). `openPendingAgent({ openclawLocal })` sets it and
  sets `openclawStateDir` to the same value. `register` carries it forward; `resumePendingAgent` already spreads the
  saved row. `setOpenclawStateDir` returns `false` for a row that has it.
- `RegisteredSession.earlierSessionIds?: string[]`: the session keys the agent moved off, newest first, no
  duplicates, at most `EARLIER_SESSIONS_MAX = 32`, each a non-empty string of at most 256 characters. `register`
  puts the key it moves off (`rebound`) at the front and carries the list forward. Never on the agent's frame.
- No reader changes: history, the live stream, the last turn, the checkpoint and the usage read already take the
  row's `openclawStateDir` (`core/transcripts/attach.ts`, `history.ts`, `lastTurn.ts`, `lib/sessionCheckpoint.ts`,
  `lib/databaseHistory.ts`), and `openclawSessionDb` reads no open files when it is given one.

- [ ] **Step 1: Write the failing tests**

```ts
it('a local row keeps its folder through a save, a load, a bind and a resume, and reads its store there from the start', async () => {
  const { registry, strictPersistedRow } = await load()
  const row = registry.openPendingAgent({ engine: 'openclaw', cwd: root, runtimes, openclawLocal: '/run/skill-1' })!
  expect(row).toMatchObject({ openclawLocal: '/run/skill-1', openclawStateDir: '/run/skill-1' })
  expect(strictPersistedRow(disk()[0])).toMatchObject({ openclawLocal: '/run/skill-1', openclawStateDir: '/run/skill-1' })
  expect(registry.register({ engine: 'openclaw', sessionId: SESSION, runtimes, cwd: root })!.entry)
    .toMatchObject({ openclawLocal: '/run/skill-1', openclawStateDir: '/run/skill-1' })
  expect(registry.setOpenclawStateDir(row.agentId, '/elsewhere')).toBe(false)
  const again = (await load()).registry
  const saved = { ...again.byAgent(row.agentId)! }
  expect(saved).toMatchObject({ openclawLocal: '/run/skill-1', openclawStateDir: '/run/skill-1' })
  again.removeAgent(row.agentId)
  expect(again.resumePendingAgent(saved, [{ backend: 'tmux', paneId: '%2' }])).toMatchObject({ openclawLocal: '/run/skill-1' })
})

it('a row with no folder has no field, and its state folder is still set off the TUI', async () => {
  const { registry, row } = await pending()   // openPendingAgent without openclawLocal
  expect(row).not.toHaveProperty('openclawLocal')
  expect(registry.setOpenclawStateDir(row.agentId, '/gw/state')).toBe(true)
})

it('keeps the session keys a harness moved off, newest first, at most 32, across a load', async () => {
  const { registry, row } = await bound()
  const move = (key: string) => registry.register({ engine: 'openclaw', sessionId: key, runtimes, cwd: root })!.entry
  expect(move('agent:main:tui-2').earlierSessionIds).toEqual([SESSION])
  expect(move('agent:main:tui-3').earlierSessionIds).toEqual(['agent:main:tui-2', SESSION])
  for (let i = 4; i < 44; i++) move(`agent:main:tui-${i}`)
  const kept = (await load()).registry.byAgent(row.agentId)!.earlierSessionIds!
  expect(kept).toHaveLength(32)
  expect(kept[0]).toBe('agent:main:tui-42')
  expect(new Set(kept).size).toBe(32)
})
```

In `stoppedAgents.spec.ts`: `'the archive keeps a local row's folder and its earlier session keys'`: `save` a row with
both, `get` it back, both are there.

- [ ] **Step 2:** `npx vitest run src/lib/registry.local.spec.ts src/lib/stoppedAgents.spec.ts` → FAIL (the fields are
  dropped). Commit: `Registry: a row keeps its --local folder and its earlier session keys (red)`.
- [ ] **Step 3:** Implement the Interfaces.
- [ ] **Step 4:** `npx vitest run src/lib/registry.local.spec.ts src/lib/registry.firstTask.spec.ts src/lib/registry.spec.ts src/lib/stoppedAgents.spec.ts`
  → PASS. Commit: `Registry: a row keeps its --local folder and its earlier session keys`.

### Task 3: Stop ends the engine's whole tree

**Depends on:** nothing.

**Files:**
- Create: `cli/src/lib/processTree.ts`
- Modify: `cli/src/lib/deleteAgentFallback.ts` (`TerminateDeps`, `terminateDeletedAgent`),
  `cli/src/lib/stopAgentService.ts` (the `terminateDeletedAgent` call)
- Test: `cli/src/lib/processTree.spec.ts` (create), `cli/src/lib/deleteAgentFallback.spec.ts`,
  `cli/src/lib/stopAgentService.spec.ts`

**Interfaces (produces):**
- `interface TreeProcess { pid: number; pgid: number; startMarker: string }`
- `engineDescendants(engine: ProcessIdentity, platform?: NodeJS.Platform, read?: () => Promise<string | null>): Promise<TreeProcess[] | null>`:
  one read of the process table (`ps -axo pid=,ppid=,pgid=,lstart=,args=`, 3 s timeout), then a walk down from the
  engine. `[]` on `win32` without reading (the pty host's process group and the hidden-run tree kill end the tree
  there) and when the engine's row is not there with the same start marker; `null` when the table cannot be read.
  At most `TREE_LIMIT = 1024` processes. A Hermes gateway (`hermesGatewayProcess`) and everything below it is left
  out. Start markers are made as `parseProcessRow` makes them, so `sameProcessIdentity` compares them.
- `treeTargets(tree: readonly TreeProcess[]): { groups: number[]; pids: number[] }`: `groups` are the distinct
  process groups whose leader (`pid === pgid`) is in `tree`; `pids` are the processes of `tree` in no such group.
- `treeSurvivors(tree: readonly TreeProcess[], read?): Promise<TreeProcess[] | null>`: those still running with the
  same pid and start marker; a row `liveProcessRows` would drop (a zombie) is gone.
- `TerminateDeps.descendants?: () => Promise<TreeProcess[] | null>` and
  `TerminateDeps.survivors?: (tree: readonly TreeProcess[]) => Promise<TreeProcess[] | null>`. Without them the
  function behaves as today (the swap in `core/agents/swap.ts` passes neither).
- `StopAgentServiceDeps.processTree?: { descendants: typeof engineDescendants; survivors: typeof treeSurvivors }`,
  the real two by default.

**What `terminateDeletedAgent` does with a tree** (the signature and tests do not determine the order):

1. After the first check says the engine is alive, list the tree once. `null`: log
   `[delete] could not list <engine>'s processes` and go on with the engine alone.
2. SIGTERM the engine by pid, as today; then each group of `treeTargets` with `deps.kill(-pgid, 'SIGTERM')` and each
   of its `pids` by pid. `ESRCH` is not a failure. The engine's own group is never signalled as a group (its
   children in that group are in `pids`), so the engine gets one SIGTERM.
3. Wait for the engine as today. Once it is gone, or at the grace's end, ask `survivors`; none left ends the wait.
4. At the end of the existing grace (`killGraceMs`, counted from the SIGTERM), SIGKILL each survivor by pid, never by
   group, then the engine as today.
5. A survivor still there after its SIGKILL: log `[delete] <engine> pid <n> is STILL running after SIGKILL`, outcome
   `'failed'`. Otherwise the outcome is what the engine's own stop gave.

- [ ] **Step 1: Write the failing tests**

`processTree.spec.ts`:

```ts
const tree: TreeProcess[] = [
  { pid: 10, pgid: 4242, startMarker: 'm10' },   // in the engine's own group
  { pid: 20, pgid: 20, startMarker: 'm20' },     // left the session: leads its own group
  { pid: 21, pgid: 20, startMarker: 'm21' },
  { pid: 30, pgid: 77, startMarker: 'm30' },     // in a group led from outside the tree (the pane's shell)
]
it('signals a group only when one of the tree leads it', () => {
  expect(treeTargets(tree)).toEqual({ groups: [20], pids: [10, 30] })
})
it('walks down from the engine in one read, and leaves out a Hermes gateway and what it started', async () => {
  let reads = 0
  const found = await engineDescendants(ENGINE, 'darwin', async () => { reads++; return PS })   // PS: the engine, two
  expect(found!.map((p) => p.pid)).toEqual([501, 502])   // children, a grandchild in its own session, a gateway + child
  expect(reads).toBe(1)
})
it('lists nothing on Windows, nothing for an engine that is not there, and null when the table cannot be read', async () => {
  expect(await engineDescendants(ENGINE, 'win32', async () => { throw new Error('never read') })).toEqual([])
  expect(await engineDescendants({ ...ENGINE, startMarker: 'another start' }, 'darwin', async () => PS)).toEqual([])
  expect(await engineDescendants(ENGINE, 'darwin', async () => null)).toBeNull()
})
it('stops at 1024 processes', async () => { /* a table of 2000 children → length TREE_LIMIT */ })

describe.skipIf(process.platform === 'win32')('real processes', () => {
  it('a child that left the engine\'s session is gone after the stop', async () => {
    // A node "engine" that starts `sleep 600` detached (its own session), prints that pid, and waits.
    const engine = spawn(process.execPath, ['-e', ENGINE_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'] })
    const child = Number(await firstLine(engine.stdout))
    const identity = await identityOf(engine.pid!)                       // its row in processRows()
    const listed = await engineDescendants(identity)
    expect(listed!.find((p) => p.pid === child)!.pgid).toBe(child)
    const outcome = await terminateDeletedAgent({ engine: 'claude', processIdentity: identity } as RegisteredSession, {
      checkRuntime: checkPidRuntime, kill: (pid, signal) => process.kill(pid, signal), log: () => {},
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      descendants: () => engineDescendants(identity), survivors: treeSurvivors })
    expect(['terminated', 'killed']).toContain(outcome)
    await until(() => !alive(child))                                    // condition, bounded at 5 s
  })
})
```

`deleteAgentFallback.spec.ts`, with the file's own `deps()`; `sequence(true, false)` answers the engine's checks in
turn (`runtime(true)`, then `runtime(false)` from then on):

```ts
it('SIGTERMs the engine once, each group one of its tree leads, and the rest by pid', async () => {
  const d = deps({ checkRuntime: sequence(true, false), descendants: async () => tree, survivors: async () => [] })
  expect(await terminateDeletedAgent(SESSION, d)).toBe('terminated')
  expect(d.kills).toEqual([[4242, 'SIGTERM'], [-20, 'SIGTERM'], [10, 'SIGTERM'], [30, 'SIGTERM']])
})
it('SIGKILLs what is left of the tree after the grace, by pid', async () => {
  const left = [[tree[2]], []]
  const d = deps({ checkRuntime: sequence(true, false), descendants: async () => tree, survivors: async () => left.shift() ?? [] })
  expect(await terminateDeletedAgent(SESSION, d)).toBe('terminated')
  expect(d.kills).toContainEqual([21, 'SIGKILL'])
  expect(d.kills.some(([pid, signal]) => pid < 0 && signal === 'SIGKILL')).toBe(false)
})
it('fails the stop when one of the tree outlives its SIGKILL, and says which', async () => {
  const d = deps({ checkRuntime: sequence(true, false), descendants: async () => tree, survivors: async () => [tree[2]] })
  expect(await terminateDeletedAgent(SESSION, d)).toBe('failed')
  expect(d.logs.join('\n')).toContain('pid 21 is STILL running after SIGKILL')
})
it('stops the engine alone, and says so, when its tree cannot be listed', async () => {
  const d = deps({ checkRuntime: sequence(true, false), descendants: async () => null })
  expect(await terminateDeletedAgent(SESSION, d)).toBe('terminated')
  expect(d.kills).toEqual([[4242, 'SIGTERM']])
  expect(d.logs.join('\n')).toContain("could not list claude's processes")
})
it('lists the tree once, before the first signal', async () => { /* descendants called once; d.kills empty at that call */ })
```

`stopAgentService.spec.ts`: `'a stop hands the engine's tree to the termination'`: a `processTree` whose
`descendants` returns one process in its own group; the signaller the spec already installs saw `-pgid` with
`SIGTERM`. And `'a terminal and a guest's harness list no tree'`: `descendants` not called.

- [ ] **Step 2:** `npx vitest run src/lib/processTree.spec.ts src/lib/deleteAgentFallback.spec.ts src/lib/stopAgentService.spec.ts`
  → FAIL (no module; no group signal). Commit: `Stop: an engine's descendants end with it, in any session (red)`.
- [ ] **Step 3:** Implement. `stopAgentService.ts` passes `descendants: () => processTree.descendants(s.processIdentity!)`
  and `survivors: processTree.survivors`; group signals go through `signalAgentProcess` like the engine's.
- [ ] **Step 4:** the same command → PASS; `npx vitest run src/core/agents/swap.spec.ts` → PASS (unchanged).
  Commit: `Stop: an engine's descendants end with it, in any session`.

### Task 4: The search index forgets for good

**Depends on:** nothing.

**Files:**
- Modify: `cli/src/lib/sessionSearch/store.ts` (`openOnce`, after `migrate`), `cli/src/lib/sessionSearch/indexer.ts`
  (`deletedSessions`, `deleteHistory`, `sweepSources`, `refreshSources`)
- Test: `cli/src/lib/sessionSearch/store.spec.ts`, `cli/src/lib/sessionSearch/indexer.spec.ts`

**Interfaces (produces):**
- The writer's connection runs `PRAGMA secure_delete = ON` and sets FTS5's own option,
  `INSERT INTO turns_fts (turns_fts, rank) VALUES ('secure-delete', 1)`, at every open after `migrate`. Both are
  needed: measured on Node 24.3 (SQLite 3.50.1), the pragma alone leaves every deleted word in the FTS index.
- At every open, additive, with no schema version change: `CREATE TABLE IF NOT EXISTS excluded (session_id TEXT
  PRIMARY KEY)` and `CREATE INDEX IF NOT EXISTS sessions_by_agent ON sessions (agent_id)`. `migrate` never drops
  `excluded`.
- `store.sessionsOf(agentId: string): string[]` (`[]` for `''`), `store.exclude(sessionId)`, `store.include(sessionId)`,
  `store.excluded(): Set<string>`, `store.checkpoint(): void` (`PRAGMA wal_checkpoint(TRUNCATE)`).
- `SessionSearchIndex.deleteHistory(sessionId)` keeps its name and signature (the search port and its process do not
  change). It now removes and excludes that session and every session filed under the same non-empty agent id, then
  checkpoints. The index starts with `store.excluded()` as its deleted set.
- A sweep whose discovery did not fail drops the exclusion (`store.include`) of every excluded id no source lists.

- [ ] **Step 1: Write the failing tests**

`store.spec.ts` (on a file in a temp folder, not `:memory:`):

```ts
it('erased turns leave none of their words in the database files', () => {
  const store = SessionSearchStore.open(path)!
  for (let i = 0; i < 50; i++) store.writeSession(session(`s${i}`, 'a-other'), 0, [turn(0, `filler ask ${i}`, `filler answer ${i}`)])
  store.writeSession(session('gone', 'a1'), 0, [turn(0, 'email zanzibarquokka about the dentist', 'sent to quokkazanzibar')])
  store.checkpoint()
  store.removeSession('gone')
  store.checkpoint()
  const bytes = Buffer.concat(['', '-wal'].filter((s) => existsSync(path + s)).map((s) => readFileSync(path + s)))
  for (const word of ['zanzibarquokka', 'quokkazanzibar', 'dentist']) expect(bytes.includes(word), word).toBe(false)
})
it('lists an agent\'s sessions by its id, and none for a conversation Harness did not start', () => {
  expect(store.sessionsOf('a1').sort()).toEqual(['s1', 's2'])
  expect(store.sessionsOf('')).toEqual([])
})
it('keeps what is excluded across a reopen and a rebuild of the index', () => {
  store.exclude('agent:main:harness-1'); store.close()
  expect(SessionSearchStore.open(path)!.excluded()).toEqual(new Set(['agent:main:harness-1']))
  // meta.schema set to another value, reopened (migrate drops and recreates the index): still excluded
  // include('agent:main:harness-1') → excluded() is empty
})
```

`indexer.spec.ts`, with the file's own sources and store:

```ts
it('deleting a harness\'s conversation removes every session filed under its agent, and no one else\'s', () => {
  // a1 has s1 (current) and s0 (before a /new); a2 has s2; two outside conversations e1, e2 (agent id '')
  index.deleteHistory('s1')
  expect(store.sessionIds().sort()).toEqual(['e1', 'e2', 's2'])
  index.deleteHistory('e1')
  expect(store.sessionIds().sort()).toEqual(['e2', 's2'])
})
it('a deleted conversation still on disk is not indexed again, by this index or by a new one on the same store', async () => {
  index.deleteHistory('s1')                       // its source is still listed (OpenClaw's kept store)
  index.sweep(); await drained(index)
  expect(store.session('s1')).toBeUndefined()
  const restarted = new SessionSearchIndex({ ...options, store: SessionSearchStore.open(path)! })
  restarted.sweep(); await drained(restarted)
  expect(restarted.session('s1')).toBeUndefined()
})
it('the exclusion goes once the conversation is gone from disk, never after a discovery that failed', async () => {
  index.deleteHistory('s1')
  sources = sources.filter((s) => s.sessionId !== 's1')
  discover = async () => { throw new Error('scan failed') }
  index.sweep(); await drained(index)
  expect(store.excluded().has('s1')).toBe(true)
  discover = async () => {}
  index.sweep(); await drained(index)
  expect(store.excluded().has('s1')).toBe(false)
})
```

- [ ] **Step 2:** `npx vitest run src/lib/sessionSearch/store.spec.ts src/lib/sessionSearch/indexer.spec.ts` → FAIL
  (the words are in the file; `sessionsOf` is not a function). Commit: `Search: erased turns are gone from the file, and stay out (red)`.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same command plus `src/services/search.spec.ts src/services/searchProcess.spec.ts` → PASS.
- [ ] **Step 5: Numbers.** The index's passes run while the daemon is idle. Time 500 `writeSession` calls that each
  replace the last 2 turns of a 400-turn session, on `main` and on this branch, same machine, same Node. Put both in
  the pull request. Not slower beyond 5%: otherwise stop and report, do not ship the option off.
- [ ] **Step 6:** Commit: `Search: erased turns are gone from the file, and stay out`.

### Task 5: One lock for the agent ledger

**Depends on:** nothing.

**Files:**
- Modify: `cli/src/agentClient/ledger.ts`
- Test: `cli/src/agentClient/ledger.spec.ts`

**Interfaces (produces):**
- `class LedgerBusyError extends Error`, message `The agent ledger is busy. Try again.`
- `LEDGER_LOCK_WAIT_MS = 2_000`. `new Ledger(path, lockWaitMs = LEDGER_LOCK_WAIT_MS)`.
- The lock is `<path>.lock`, made with `O_EXCL`, mode `0600`, holding `{ pid, ...processLockIdentity(pid) }`
  (`lib/processLiveness.ts`), removed when the writer is done. A lock whose owner is gone (`lockOwnerAlive` false) is
  taken over. A live owner is waited for in 10 ms steps (`Atomics.wait`, as the registry's lock does) up to the wait,
  then `LedgerBusyError`, with nothing written. The shape is the registry lock's; no age rule.
- `append(row)` writes and rotates under the lock.
- `forgetTold(agentId: string): number`: under the lock, rewrites the previous file and the current one without the
  `Told` lines whose `told.agentId` is `agentId` (temp file, then rename, mode `0600`); returns how many went. Every
  other line, unparsed ones included, stays byte for byte. A file that is not there is skipped.

- [ ] **Step 1: Write the failing tests** in `ledger.spec.ts`

```ts
it('forgets what a harness was told, in both files, and keeps every other line', () => {
  // previous: Started(kid), Told(kid, 'email zanzibar'), Told(other, 'keep me'); current: Closed(kid), Told(kid, 'again'), 'not json'
  expect(ledger.forgetTold('kid')).toBe(2)
  const text = readFileSync(ledger.previous, 'utf8') + readFileSync(ledger.path, 'utf8')
  expect(text).not.toContain('zanzibar'); expect(text).not.toContain('again')
  expect(text).toContain('keep me'); expect(text).toContain('not json')
  expect(ledger.parentOf(KID)).not.toBeNull()
  expect(ledger.closedBy(ME, KID)).not.toBeNull()
  expect(ledger.toldBy(ME, KID)).toBeNull()
  expect(statSync(ledger.path).mode & 0o777).toBe(0o600)
  expect(existsSync(`${ledger.path}.lock`)).toBe(false)
})
it('an append made while another process holds the lock lands once it is released', async () => {
  // A node child writes the lock file naming itself, and removes it 300 ms later. No TypeScript in the child.
  const holder = spawn(process.execPath, ['-e', HOLD_LOCK, `${ledger.path}.lock`])
  await until(() => existsSync(`${ledger.path}.lock`))
  ledger.append(STARTED)                                  // waits, then writes
  expect(ledger.all()).toHaveLength(1)
  await exited(holder)
})
it('takes over a lock whose owner is gone', () => {
  writeFileSync(`${ledger.path}.lock`, JSON.stringify({ pid: deadPid(), startMarker: '' }))
  ledger.append(STARTED)
  expect(ledger.all()).toHaveLength(1)
})
it('gives up after its wait with nothing written, an append and a rewrite alike', () => {
  const held = new Ledger(path, 50)
  writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.ppid, startMarker: '' }))
  expect(() => held.append(STARTED)).toThrow(new LedgerBusyError())
  expect(() => held.forgetTold('kid')).toThrow('The agent ledger is busy. Try again.')
  expect(existsSync(path)).toBe(false)
})
```

- [ ] **Step 2:** `npx vitest run src/agentClient/ledger.spec.ts` → FAIL (`forgetTold` is not a function). Commit:
  `Agent ledger: every writer takes one lock, and a harness's told lines can be forgotten (red)`.
- [ ] **Step 3:** Implement. Update the module comment: the file is no longer only appended to.
- [ ] **Step 4:** `npx vitest run src/agentClient/ledger.spec.ts src/agentClient/commands.spec.ts` → PASS. Commit:
  `Agent ledger: every writer takes one lock, and a harness's told lines can be forgotten`.

### Task 6: A creation receipt gives up its request

**Depends on:** nothing.

**Files:**
- Modify: `cli/src/lib/agentCreationReceipt.ts`
- Test: `cli/src/lib/agentCreationReceipt.spec.ts`

**Interfaces (produces):**
- `AgentCreationReceipts.scrubCreated(agentId: string): Promise<number>`: one streamed pass of the receipts folder
  (`opendir`, as `pendingIntents` reads it). For each intent receipt (version 2, not cancelled) whose outcome is
  `created` with that `agentId`, the receipt is replaced, atomically (temp file, rename, folder synced, as `write`
  does), by the same receipt with `request: { scrubbed: true }` and
  `checksum: creationFingerprint({ fingerprint, request: { scrubbed: true }, held })`. `fingerprint` and `held` stay.
  Returns how many it scrubbed; one already scrubbed is not counted. A receipt it cannot read is skipped as
  `pendingIntents` skips it; one it cannot write rejects with `AgentCreationReceiptError('CREATION_STORAGE_FAILED')`.
  Version 1 receipts hold no request and are left alone.

- [ ] **Step 1: Write the failing tests**

```ts
it('scrubs the request of the receipt that made a harness, keeps the receipt, and a retried create still does not launch', async () => {
  const request = { kind: 'native-create-v1', input: { engine: 'openclaw', prompt: 'email zanzibarquokka', openclawLocal: '/run/skill-1' } }
  await receipts.runIntent(ID, FP, request, HELD, async () => async () => ({ state: 'created', agentId: 'a1' }))
  expect(await receipts.scrubCreated('a1')).toBe(1)
  const saved = readFileSync(join(dir, `${ID}.json`), 'utf8')
  expect(saved).not.toContain('zanzibarquokka'); expect(saved).not.toContain('/run/skill-1')
  expect(JSON.parse(saved).request).toEqual({ scrubbed: true })
  const reopened = new AgentCreationReceipts(dir)
  expect(reopened.status(ID)).toEqual({ state: 'created', agentId: 'a1' })
  const again = vi.fn()
  expect(await reopened.runIntent(ID, FP, request, HELD, again)).toEqual({ state: 'created', agentId: 'a1' })
  expect(again).not.toHaveBeenCalled()
  expect(await reopened.scrubCreated('a1')).toBe(0)
})
it('leaves another harness\'s receipt, a create that made none, and a legacy receipt as they are', async () => {
  // a2 created; one still pending; one failed; one version 1 created for a1 → scrubCreated('a1') is 0, files unchanged
})
it('a receipt that cannot be rewritten fails the scrub', async () => { /* rejects CREATION_STORAGE_FAILED; set up as the file's own storage-failure test */ })
```

- [ ] **Step 2:** `npx vitest run src/lib/agentCreationReceipt.spec.ts` → FAIL (`scrubCreated` is not a function).
  Commit: `Creation receipts: a deleted harness's request is scrubbed, the receipt kept (red)`.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same command plus `src/core/agents/pendingLaunches.spec.ts` → PASS. Commit:
  `Creation receipts: a deleted harness's request is scrubbed, the receipt kept`.

### Task 7: `harness new openclaw --local <folder>`

**Depends on:** nothing.

**Files:**
- Modify: `cli/src/lib/newCommand.ts` (`NewArgs`, `NEW_USAGE`, `parseNewArgs`, `newAgentPayload`, `daemonSession`,
  `newCommand`), `cli/src/localWsServer.ts` (the tool's `connected` frame)
- Test: `cli/src/lib/newCommand.spec.ts`, `cli/src/localWsServer.spec.ts`

**Interfaces (produces):**
- `NewArgs.local: string | null`: the folder, absolute. `parseNewArgs(argv, env)` takes
  `env.isFolder?: (path: string) => boolean` (default: `statSync(path).isDirectory()`, `false` when it throws) and
  resolves the word against `env.cwd` (`path.resolve`, so a trailing slash goes). Refusals, each a `NewUsageError`,
  in this order: no value → `--local needs a value.`; the agent is not `openclaw` → `--local is for OpenClaw only.`;
  `--machine` given → `--local runs on this computer only.`; not a folder → `<resolved path> is not a folder.`
- `NEW_USAGE` gains, after `--model`:
  `  --local <dir>  OpenClaw only: run it and its tools in this process, on the state folder <dir> (you make it)`
- `newAgentPayload` sends `openclawLocal: args.local` only when set.
- `LOCAL_TOOL_FEATURES = ['openclaw-local'] as const` in `localWsServer.ts`; the `connected` frame of a tool
  connection (`payload.tool === true`) carries `features: [...LOCAL_TOOL_FEATURES]`. A window's frame is unchanged.
- `daemonSession(...)` resolves `{ request, close, features: string[] }` (`[]` when the frame has none).
  `newCommand`, right after the session opens and before any request: `args.local` and no `'openclaw-local'` →
  `This Harness daemon is too old for --local. Restart Harness.`, exit 1, nothing sent.

- [ ] **Step 1: Write the failing tests**

```ts
const at = { cwd: '/work', home: '/home/u', isFolder: (p: string) => ['/run/skill-1', '/work/run it', "/run/it's"].includes(p) }
it('--local names the folder an OpenClaw run lives in', () => {
  expect(parseNewArgs(['openclaw', '--local', '/run/skill-1', '--', 'do it'], at)).toMatchObject({ agent: 'openclaw', local: '/run/skill-1', prompt: 'do it', cwd: '/work' })
  expect(parseNewArgs(['openclaw', '--local', 'run it'], at).local).toBe('/work/run it')
  expect(parseNewArgs(['openclaw', '--local', '/run/skill-1/'], at).local).toBe('/run/skill-1')
  expect(parseNewArgs(['openclaw', '--local', "/run/it's"], at).local).toBe("/run/it's")
  expect(parseNewArgs(['openclaw'], at).local).toBeNull()
})
it('--local is refused for another agent, another machine, a folder that is not there, and with no value', () => {
  expect(() => parseNewArgs(['codex', '--local', '/run/skill-1'], at)).toThrow('--local is for OpenClaw only.')
  expect(() => parseNewArgs(['--local', '/run/skill-1'], at)).toThrow('--local is for OpenClaw only.')
  expect(() => parseNewArgs(['openclaw', '--machine', 'office', '--local', '/run/skill-1'], at)).toThrow('--local runs on this computer only.')
  expect(() => parseNewArgs(['openclaw', '--local', '/nowhere'], at)).toThrow('/nowhere is not a folder.')
  expect(() => parseNewArgs(['openclaw', '--local', '--json'], at)).toThrow('--local needs a value.')
})
it('the folder goes with the create, and only then', () => {
  expect(newAgentPayload({ ...ARGS, agent: 'openclaw', local: '/run/skill-1' }, '/work')).toMatchObject({ engine: 'openclaw', openclawLocal: '/run/skill-1' })
  expect(newAgentPayload({ ...ARGS, agent: 'openclaw', local: null }, '/work')).not.toHaveProperty('openclawLocal')
})
it('refuses --local against a daemon that does not say it knows it, before anything is sent', async () => {
  const run = await newWith(['openclaw', '--local', FOLDER], { connected: { machineId: ME } })          // a real temp folder
  expect(run.code).toBe(1)
  expect(run.errors).toEqual(['This Harness daemon is too old for --local. Restart Harness.'])
  expect(run.sent.filter((frame) => frame.type !== 'machine_select')).toEqual([])
})
it('sends --local to a daemon that knows it', async () => {
  const run = await newWith(['openclaw', '--local', FOLDER], { connected: { machineId: ME, features: ['openclaw-local'] } })
  expect(run.sent.find((frame) => frame.type === 'agent_create')!.payload).toMatchObject({ engine: 'openclaw', openclawLocal: FOLDER })
})
```

`localWsServer.spec.ts`: `'tells a tool what this daemon can do, and a window nothing new'`: a `machine_select` with
`tool: true` is answered `connected` with `features: ['openclaw-local']`; one without `tool` has no `features` key.

- [ ] **Step 2:** `npx vitest run src/lib/newCommand.spec.ts src/localWsServer.spec.ts` → FAIL (`Unknown option
  --local.`). Commit: `harness new: --local <folder> for OpenClaw, refused against an older daemon (red)`.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same command → PASS. Commit: `harness new: --local <folder> for OpenClaw, refused against an older daemon`.

### Task 8: Launch argv and environment

**Depends on:** Task 1.

**Files:**
- Modify: `cli/src/engines/nativeLaunch.ts` (`NativeLaunchSource`, `NativeLaunch`, `inspectNativeLaunch`),
  `cli/src/lib/engineLaunch.ts` (`buildEngineCommandArgv`, `engineLaunchEnv`)
- Test: `cli/src/engines/openclaw/launch.spec.ts`, `cli/src/engines/nativeLaunch.spec.ts`

**Interfaces:**
- Consumes: `OPENCLAW_LAUNCH.local`, `.resumeLocal`, `.localClear` (Task 1).
- Produces: `NativeLaunchSource.openclawLocal?: string | null` and `NativeLaunch.openclawLocal?: string` (readonly).
  For engine `openclaw` with a source folder, `inspectNativeLaunch` sets `selected.OPENCLAW_STATE_DIR` to it (as
  `source.claudeHome` sets `CLAUDE_CONFIG_DIR`), adds `OPENCLAW_LAUNCH.localClear` to `clearEnvironment`, and puts
  the folder on the launch. Any other engine ignores the field. The pane script already exports
  `native.environment` after the rc files and unsets `native.clearEnvironment`; Windows already clears
  `native.clearEnvironment` from the pane (`windowsPaneLaunch`).
- `buildEngineCommandArgv('openclaw', opts)`: with `opts.native?.openclawLocal`, `--local` follows `tui`; a new
  session is still `--session harness-<agentId>`; a resume is `--session <full key>`, never the positional.
- `engineLaunchEnv(engine, native?: Pick<NativeLaunch, 'token' | 'openclawLocal'>, platform?, daemon?)`: for a local
  launch `OPENCLAW_STATE_DIR` is the folder, over the daemon's value; `OPENCLAW_HOME` is still the daemon's.

- [ ] **Step 1: Write the failing tests**

`launch.spec.ts`:

```ts
const local = (folder: string): NativeLaunch => ({ opencodeMajor: null, environment: {}, proofs: [], current: () => true,
  prepareHooks: async () => true, permission: async () => 'supported', openclawLocal: folder })
it('a local run starts with --local and names its session with --session, new or reopened', () => {
  const native = local('/run/skill-1')
  expect(buildEngineCommandArgv('openclaw', { agentId: AGENT, native })).toEqual(['openclaw', 'tui', '--local', '--session', `harness-${AGENT}`])
  expect(buildEngineCommandArgv('openclaw', { agentId: AGENT, native, resumeSessionId: `agent:main:harness-${AGENT}` }))
    .toEqual(['openclaw', 'tui', '--local', '--session', `agent:main:harness-${AGENT}`])
  expect(buildEngineCommandArgv('openclaw', { agentId: AGENT, native, firstPrompt: 'Fix the parser' }))
    .toEqual(['openclaw', 'tui', '--local', '--session', `harness-${AGENT}`])
})
it('a local pane gets its folder over the daemon\'s', () => {
  const daemon = { OPENCLAW_STATE_DIR: '/gw/state', OPENCLAW_HOME: '/gw' }
  for (const platform of ['darwin', 'linux'] as const) {
    expect(engineLaunchEnv('openclaw', { token: 't', openclawLocal: '/run/skill-1' }, platform, daemon))
      .toEqual({ OPENCLAW_STATE_DIR: '/run/skill-1', OPENCLAW_HOME: '/gw' })
  }
  expect(engineLaunchEnv('openclaw', { token: 't', openclawLocal: '/run/skill-1' }, 'win32', daemon))
    .toMatchObject({ OPENCLAW_STATE_DIR: '/run/skill-1', HARNESS_NATIVE_LAUNCH_TOKEN: 't' })
})
```

`nativeLaunch.spec.ts`, set up as the file's `claudeHome` case (a launch shell that reports its own
`OPENCLAW_STATE_DIR=/shell/state`):

```ts
it('a local OpenClaw launch pins its folder and clears the other OpenClaw paths', async () => {
  const found = await inspectNativeLaunch('openclaw', { openclawLocal: "/run/it's" })
  if (!found.ok) throw new Error(found.detail)
  expect(found.launch.openclawLocal).toBe("/run/it's")
  expect(found.launch.environment.OPENCLAW_STATE_DIR).toBe("/run/it's")
  expect(found.launch.clearEnvironment).toEqual(expect.arrayContaining(['OPENCLAW_CONFIG_PATH', 'OPENCLAW_AGENT_DIR', 'OPENCLAW_OAUTH_DIR', 'OPENCLAW_WORKSPACE_DIR']))
  const script = paneScript(buildEngineLaunchArgv('openclaw', { native: found.launch, agentId: AGENT }, '/bin/zsh', '/opt/node', 'grid', null))
  expect(script).toContain(`export OPENCLAW_STATE_DIR=${shellSingleQuote("/run/it's")}`)
  expect(script.indexOf('OPENCLAW_CONFIG_PATH')).toBeLessThan(script.indexOf('export OPENCLAW_STATE_DIR='))
})
it('a launch with no folder, and another engine given one, are as before', async () => {
  // openclaw, {} → openclawLocal undefined, OPENCLAW_STATE_DIR the shell's, none of the four cleared
  // claude, { openclawLocal: '/run/skill-1' } → no openclawLocal on the launch, environment unchanged
})
```

- [ ] **Step 2:** `npx vitest run src/engines/openclaw/launch.spec.ts src/engines/nativeLaunch.spec.ts` → FAIL (no
  `--local`; `OPENCLAW_STATE_DIR` is `/gw/state`). Commit: `OpenClaw: a local run's argv, folder and cleared paths (red)`.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run src/engines/openclaw src/engines/nativeLaunch.spec.ts src/lib/engineLaunch.spec.ts src/lib/engineLaunch.windows.spec.ts`
  → PASS. Commit: `OpenClaw: a local run's argv, folder and cleared paths`.

### Task 9: Bind and frame

**Depends on:** Tasks 1, 2.

**Files:**
- Modify: `cli/src/core/agents/bind.ts` (the OpenClaw branch of `bindObservedAgent`), `cli/src/lib/agentFrame.ts`
  (`namedState`)
- Test: `cli/src/core/agents/bind.spec.ts`, `cli/src/lib/agentFrame.spec.ts`

**Interfaces:**
- Consumes: `OpenclawScreen.stopped`, state `'local-stopped'`, `openclawLocalStopped`, `isOpenclawLocalStopped`
  (Task 1); `RegisteredSession.openclawLocal` (Task 2).
- Produces, in the bind pass:
  - A screen that reads `local-stopped` holds the agent with `openclawLocalStopped(screen.stopped)` when the line
    gave a reason or none (`stopped !== null`); on `local stopped` (`stopped === null`) the hold the agent already
    has is kept when it is a local-stopped one, else `openclawLocalStopped(null)`. The harness is not closed.
  - That hold is one of the pass's own: it is set and cleared under the same rule as the Gateway holds (cleared once
    a footer shows and the screen says something else).
  - A local row (`agent.openclawLocal`) is never held by `no-gateway`, `no-token` or `remote`.
  - A local row's state folder is never read off its TUI (`openclawStateDir` dep not called) and never replaced.
  - The first task is handed over on `local ready` exactly as on `connected` (no new code path: the state is `ready`).
  - The log line for the hold is `openclaw · OpenClaw's local run stopped`, with no reason.
- `agentFrame`: a local-stopped hold is a `namedState`.

- [ ] **Step 1: Write the failing tests** in `bind.spec.ts`, with the file's own OpenClaw setup (a bound agent, a
  fake `capturePane`, `openclawPaneRead` answering `true`)

```ts
it('a local run\'s first task is typed once its pane reads local ready', async () => {
  // row: openclawLocal '/run/skill-1', firstTask 'Fix the parser'; pane: local('local ready | idle') → submitAgent called once with the task
})
it('a local run that stopped says so with its reason, keeps it under the later footer, and logs no reason', async () => {
  await pass(local('local runtime stopped: boom | idle'))
  expect(registry.byAgent(id)!.identityHold).toBe("OpenClaw's local run stopped: boom")
  await pass(local('local stopped | idle'))
  expect(registry.byAgent(id)!.identityHold).toBe("OpenClaw's local run stopped: boom")
  expect(logs.join('\n')).not.toContain('boom')
  expect(registry.byAgent(id)).toMatchObject({ active: true })     // held, not closed
})
it('a stopped local run first seen under its later footer says it stopped, with no reason', async () => {
  await pass(local('local stopped | idle'))
  expect(registry.byAgent(id)!.identityHold).toBe("OpenClaw's local run stopped.")
})
it('the hold goes when the pane reads local ready again', async () => { /* stopped, then local ready | idle → identityHold undefined, announced */ })
it('the Gateway states never hold a local row', async () => {
  for (const screen of ['screen-no-gateway.txt', 'screen-no-token.txt', 'screen-remote.txt']) { /* local row → identityHold undefined */ }
})
it('a local row\'s folder is never read off its TUI nor replaced', async () => {
  // bind a local row, then a pass under a new TUI process: openclawStateDir (the dep) not called; row.openclawStateDir is still '/run/skill-1'
})
```

`agentFrame.spec.ts`: `'a stopped local run is a named state'`: `identityHold: "OpenClaw's local run stopped: boom"`
→ `namedState` is the same string.

- [ ] **Step 2:** `npx vitest run src/core/agents/bind.spec.ts src/lib/agentFrame.spec.ts` → FAIL (no hold; the dep is
  called). Commit: `OpenClaw: a local run's ready, stopped and store on its agent (red)`.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same command plus `src/core/transcripts/openclaw.spec.ts` → PASS. Commit:
  `OpenClaw: a local run's ready, stopped and store on its agent`.

### Task 10: The new pane watcher

**Depends on:** Tasks 1, 2.

**Files:**
- Modify: `cli/src/core/agents/newPane.ts` (`watchNewPane`)
- Test: `cli/src/core/agents/newPane.spec.ts`

**Interfaces:**
- Consumes: `readOpenclawScreen`, `openclawFolderInUse`, `OPENCLAW_LOCAL.folderInUse` (Task 1); `pending.openclawLocal`
  (Task 2).
- Produces:
  - A local row is `ready` only once its engine process is seen **and** its pane shows the TUI's footer
    (`readOpenclawScreen(await captureTerminal(agentId, 40)).footer`). OpenClaw takes the folder's lock before it
    draws anything, so a launch that will leave on the lock is still `starting` when it leaves.
  - A local row whose engine left before ready (`paneState.engineExit !== null`) with `openclawFolderInUse` true of
    the captured lines: `registry.setLaunch(agentId, { state: 'failed', error: 'OPENCLAW_FOLDER_IN_USE', detail:
    OPENCLAW_LOCAL.folderInUse })`, announced, logged (`[agent] create failed · openclaw · <detail>`), and the row is
    not released to a terminal. Any other exit goes on as today.
  - The ready line of a local row: `[agent] create ready · openclaw · local · agent <id> · <n>ms`. No path.

- [ ] **Step 1: Write the failing tests**, with the file's own fakes

```ts
it('a local OpenClaw launch is not ready until its TUI has drawn', async () => {
  // process seen on every look; captures: '' twice, then a local('local ready | idle') screen
  // → setLaunch({ state: 'ready' }) called once, after the third capture
})
it('a local launch that left on OpenClaw\'s lock says another OpenClaw is using the folder', async () => {
  // process seen, no footer; then no process and paneState.engineExit 1; capture: 'A Gateway is running for this state directory (pid 7, port 18789). …'
  expect(registry.setLaunch).toHaveBeenCalledWith(id, { state: 'failed', error: 'OPENCLAW_FOLDER_IN_USE',
    detail: 'Another OpenClaw is using this folder. Give each run its own --local folder.' })
  expect(registry.releaseEngine).not.toHaveBeenCalled()
  expect(announced.at(-1)!.launch).toMatchObject({ state: 'failed', error: 'OPENCLAW_FOLDER_IN_USE' })
})
it('any other early exit of a local launch leaves a terminal, as for every engine', async () => { /* capture 'error: unknown option' → releaseEngine called */ })
it('the ready line says local, and no folder', async () => {
  expect(logs.find((line) => line.includes('create ready'))).toMatch(/create ready · openclaw · local · agent /)
  expect(logs.join('\n')).not.toContain('/run/skill-1')
})
it('a launch with no folder is ready as soon as its process is seen', async () => { /* unchanged */ })
```

- [ ] **Step 2:** `npx vitest run src/core/agents/newPane.spec.ts` → FAIL (ready at the first look; released to a
  terminal). Commit: `OpenClaw: a --local folder in use is said, not a bare exit (red)`.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same command → PASS. Commit: `OpenClaw: a --local folder in use is said, not a bare exit`.

### Task 11: `harness delete <name>`

**Depends on:** nothing in code (it reads `kept` from the answer Task 12 adds; absent is none kept).

**Files:**
- Modify: `cli/src/agentClient/commands.ts` (`DELETE_USAGE`, `deleteCommand`), `cli/src/cli.ts` (the import, the
  `case 'delete'` beside `close`, one help line under `harness close`)
- Test: `cli/src/agentClient/commands.spec.ts`

**Interfaces (produces):**
- `deleteCommand(argv: readonly string[], deps?: ClientDeps): Promise<number>`, run through `run(DELETE_USAGE, …)`.
- `DELETE_USAGE`:

```
Usage: harness delete <name> [--json]

Stops the harness and erases its conversation and everything Harness keeps of it: its saved screen, recaps, search
rows and task records. Its folder is kept. An engine's own store Harness cannot erase is kept, and the output says so.
A closed harness can be deleted too. An agent may delete only harnesses it started: deleting another's exits 5.
This computer only.
```

- `cli.ts` help line: `  harness delete <name>        stop a harness and erase its conversation and what Harness kept of it`
- Behaviour: one name (`Name the harness to delete.` / `Delete one harness at a time.`); `--machine` →
  `harness delete works on this computer only.` (usage, exit 2); the target is found with `opened(s, true)` and
  `target`, stopped ones included; a cloud harness → usage error `<name> runs in its maker's cloud: delete it there.`;
  the same three `NOT_YOURS` refusals as `close` (an orphan pane, its own harness, one it did not start), worded with
  `delete`. Then two requests on the local daemon:
  1. `agent_purge { agentId, sessionId: frame.sessionId ?? null, createdAt: Date.parse(frame.createdAt), mode: 'inspect' }`, 60 s.
  2. `agent_purge { …the same three…, mode: 'delete', reviewId, choices: { sessionData: true, worktreeData: false } }`, 120 s.
  An `error` in either answer is an `AgentClientError(error, detail || 'Could not delete <name>.')`: purge's own
  words (`LEAD_PROTECTED`, `DELETE_IN_PROGRESS`, `DELETE_REFUSED`, `IDENTITY_UNAVAILABLE`), exit 1.
- Output. Nothing kept: `<name> on <machine>: deleted. Its conversation and everything Harness kept of it are erased.`
  Something kept: `<name> on <machine>: deleted. Everything Harness kept of it is erased.` then each `kept[].reason`
  on its own line. `--json`: `{ name, id, deleted: true, kept }` (`kept` is `[]` when none).
- No prompt, no ledger line, no MCP tool, not in the agents' help (`agentClient/help.ts`), not in the commands an
  engine runs without asking.

- [ ] **Step 1: Write the failing tests** in a `describe('harness delete', …)`, with the file's own fake daemon

```ts
it('deletes a running harness and a closed one: inspect, then delete with its session data and the folder kept', async () => {
  // frames: kid (live, sessionId 's1', createdAt ISO), old (status 'stopped'); daemon answers inspect { reviewId: 'r1' }, delete { deleted: true }
  expect(await run(['kid'])).toMatchObject({ code: 0, out: ['kid on studio: deleted. Its conversation and everything Harness kept of it are erased.'] })
  expect(requests('agent_purge')).toEqual([
    { agentId: KID, sessionId: 's1', createdAt: Date.parse(CREATED), mode: 'inspect' },
    { agentId: KID, sessionId: 's1', createdAt: Date.parse(CREATED), mode: 'delete', reviewId: 'r1', choices: { sessionData: true, worktreeData: false } },
  ])
  expect((await run(['old'])).code).toBe(0)
})
it('says what was kept and why', async () => {
  // delete answers { deleted: true, kept: [{ what: 'engine-store', reason: "OpenClaw's store is kept: delete its session with OpenClaw." }] }
  expect((await run(['claw'])).out).toEqual(['claw on studio: deleted. Everything Harness kept of it is erased.',
    "OpenClaw's store is kept: delete its session with OpenClaw."])
  expect(JSON.parse((await run(['claw', '--json'])).out[0])).toMatchObject({ name: 'claw', deleted: true, kept: [{ what: 'engine-store' }] })
})
it('refuses an agent a harness it did not start, and its own; the person deletes anything', async () => {
  // as the close test of the same name: exit 5, NOT_YOURS, and no agent_purge sent
})
it('says purge\'s own refusals as they are', async () => {
  // inspect answers { error: 'LEAD_PROTECTED', detail: LEAD_PROTECTED_DETAIL } → exit 1, err is the detail, no delete sent
  // delete answers { error: 'DELETE_REFUSED', detail: 'The harness did not stop. No session data was deleted.' } → exit 1, that detail
})
it('works on this computer only, one harness at a time, and never a cloud one', async () => {
  expect(await run(['--machine', 'office', 'kid'])).toMatchObject({ code: 2 })     // err[0]: 'harness delete works on this computer only.'
  expect((await run([])).err[0]).toBe('Name the harness to delete.')
  expect((await run(['a', 'b'])).err[0]).toBe('Delete one harness at a time.')
  expect((await run(['devin-1'])).err[0]).toBe("devin-1 runs in its maker's cloud: delete it there.")
})
```

- [ ] **Step 2:** `npx vitest run src/agentClient/commands.spec.ts -t "harness delete"` → FAIL (`deleteCommand` is not
  exported). Commit: `harness delete: the CLI door to the deletion Harness already has (red)`.
- [ ] **Step 3:** Implement, and wire `cli.ts`.
- [ ] **Step 4:** `npx vitest run src/agentClient/commands.spec.ts src/agentClient/help.spec.ts` → PASS. Commit:
  `harness delete: the CLI door to the deletion Harness already has`.

### Task 12: Purge erases every record, and keeps OpenClaw's store

**Depends on:** Tasks 1, 2, 4, 5, 6.

**Files:**
- Modify: `cli/src/lib/purgeAgentService.ts` (`History`, `inspectNativeHistory`, `PurgeDeps`, `request`),
  `cli/src/core/agents/lifecycle.ts` (`LifecycleDeps`, the purge service's `deleted`),
  `cli/src/core/main.ts` (wiring only: one receipts object for the launch requests and the purge)
- Test: `cli/src/lib/purgeAgentService.spec.ts`, `cli/src/core/agents/lifecycle.spec.ts`

**Interfaces:**
- Consumes: `OPENCLAW_STORE_KEPT` (Task 1); `earlierSessionIds` (Task 2); the index's `deleteHistory` (Task 4);
  `Ledger.forgetTold` (Task 5); `AgentCreationReceipts.scrubCreated` (Task 6).
- Produces:
  - `inspectNativeHistory` for `openclaw`: `{ bytes: 0, kept: { what: 'engine-store', reason: OPENCLAW_STORE_KEPT } }`
    instead of the refusal. `History.kept?: { what: 'engine-store'; reason: string }`. Nothing of the store is read or
    written.
  - The answer to a delete gains `kept: [history.kept]` when there is one. `historyKept` keeps its meaning.
  - Checkpoint files, at inspect and at delete, are those of every session key:
    `[s.sessionId, ...(s.earlierSessionIds ?? [])]`, each through `checkpoints.deletionFiles({ ...s, sessionId })`.
  - `PurgeDeps.eraseRecords?(session: RegisteredSession): Promise<void>` (optional there, as `atFolderTrust` is, so
    the other specs that build a purge service stand): awaited after the native history and the checkpoint files are
    erased and before `deleted`. It rejecting refuses the delete (`DELETE_REFUSED`, with its message): `deleted` is
    not called and the archive is not removed, so the delete can be asked again.
  - `LifecycleDeps.eraseRecords`, required, handed to the purge service. `core/main.ts` gives it:
    `new Ledger(ledgerPath(env.ADAPTER_DATA_DIR)).forgetTold(s.agentId)`, then `await receipts.scrubCreated(s.agentId)`.
  - The purge service's `deleted(s)` in `lifecycle.ts` forgets under every session key: `mirror.deleteHistory(id)` and
    `sessionSearch?.deleteHistory(id)` for each of `[s.sessionId, ...(s.earlierSessionIds ?? [])]`, and
    `registry.deleteSavedNames([s.agentId, ...those])`.

- [ ] **Step 1: Write the failing tests**

`purgeAgentService.spec.ts`, with the file's own deps:

```ts
it('an OpenClaw harness is deleted: what Harness keeps goes, its store is kept and said', async () => {
  expect(await inspectNativeHistory(row({ engine: 'openclaw', sessionId: 'agent:main:harness-1' })))
    .toEqual({ bytes: 0, kept: { what: 'engine-store', reason: "OpenClaw's store is kept: delete its session with OpenClaw." } })
  const { reviewId } = await purge.request({ ...ID, mode: 'inspect' })
  expect(await purge.request({ ...ID, mode: 'delete', reviewId, choices: { sessionData: true, worktreeData: false } }))
    .toMatchObject({ deleted: true, sessionDeleted: true, historyKept: false,
      kept: [{ what: 'engine-store', reason: "OpenClaw's store is kept: delete its session with OpenClaw." }] })
  expect(deps.deleted).toHaveBeenCalledOnce()
  expect(deps.stopped.remove).toHaveBeenCalledWith(ID.agentId)
})
it('a harness whose engine\'s history Harness erases keeps nothing', async () => { /* claude: the answer has no `kept` */ })
it('erases the checkpoints saved under every session key the harness had', async () => {
  // row: sessionId 'k2', earlierSessionIds ['k1']; checkpoints.deletionFiles answers one file per key → both unlinked
})
it('is refused, and says why, when its other records cannot be erased; asked again, it finishes', async () => {
  deps.eraseRecords.mockRejectedValueOnce(new Error('The agent ledger is busy. Try again.'))
  const refused = await deleteOnce()
  expect(refused).toMatchObject({ error: 'DELETE_REFUSED', sessionDeleted: false })
  expect(String(refused.detail)).toContain('The agent ledger is busy. Try again.')
  expect(deps.deleted).not.toHaveBeenCalled()
  expect(deps.stopped.remove).not.toHaveBeenCalled()
  expect(await deleteOnce()).toMatchObject({ deleted: true, sessionDeleted: true })
})
it('never deletes a Lead', async () => { /* leadProtected → { error: 'LEAD_PROTECTED' }; keep or extend the file's own */ })
```

`lifecycle.spec.ts`: `'a purge forgets the recaps, the search rows and the names under every session key, then its
other records'`: a stopped row with `sessionId: 'k2'`, `earlierSessionIds: ['k1']`; after a delete,
`mirror.deleteHistory` and `sessionSearch.deleteHistory` were each called with `'k2'` and `'k1'`,
`registry.deleteSavedNames` with the agent id and both keys, and `eraseRecords` with the row, before `agent_deleted`
was sent.

- [ ] **Step 2:** `npx vitest run src/lib/purgeAgentService.spec.ts src/core/agents/lifecycle.spec.ts` → FAIL
  (`This engine does not support verified history deletion yet.`). Commit:
  `Purge: every record of a harness goes, and OpenClaw's store is kept and said (red)`.
- [ ] **Step 3:** Implement, and wire `core/main.ts`.
- [ ] **Step 4:** the same command plus `src/architecture.spec.ts` → PASS. Commit:
  `Purge: every record of a harness goes, and OpenClaw's store is kept and said`.

### Task 13: The field on the wire and into the row

**Depends on:** Tasks 1, 2, 8.

**Files:**
- Modify: `cli/src/backendSocket.ts` (the `onCreateAgent` input type), `cli/src/core/agents/launches.ts` (the
  `agent_create` validation beside `claudeHome`, and `input`), `cli/src/core/agents/create.ts` (`prepare`),
  `cli/src/lib/createAgentPane.ts` (`CreateAgentPaneDeps`, the `openPendingAgent` call)
- Test: `cli/src/core/agents/launches.spec.ts`, `cli/src/core/agents/create.spec.ts`,
  `cli/src/lib/createAgentPane.spec.ts`

**Interfaces:**
- Consumes: `OPENCLAW_LOCAL` (Task 1); `openPendingAgent({ openclawLocal })` (Task 2); `NativeLaunch.openclawLocal`
  (Task 8).
- Produces:
  - `onCreateAgent` input: `openclawLocal?: string | null`.
  - `agent_create`: `payload.openclawLocal`, when present and not null, must be a string, absolute
    (`homeIsAbsolute`), at most 4096 characters, with no control character, for engine `openclaw`, and an existing
    folder. Otherwise `{ error: 'INVALID_LOCAL_FOLDER', detail }`, with `OPENCLAW_LOCAL.notOpenclaw` for another
    engine and `OPENCLAW_LOCAL.notFolder(value)` for the rest. It joins `input` only when set, so every other
    create keeps its fingerprint.
  - `create.ts` `prepare`: the folder is checked again (a saved launch can run later): gone →
    `{ ok: false, error: 'OPENCLAW_FOLDER_GONE', detail: OPENCLAW_LOCAL.folderGone }`, before anything is prepared.
    `inspectNative` already receives the input, the field with it. After it, a local create whose launch is missing
    or names another folder (`native?.openclawLocal !== openclawLocal`) is refused:
    `{ ok: false, error: 'OPENCLAW_LOCAL_UNPREPARED', detail: OPENCLAW_LOCAL.unprepared }`. The folder goes to
    `createAndRegisterPane({ openclawLocal })`, which hands it to `openPendingAgent`.

- [ ] **Step 1: Write the failing tests**

`launches.spec.ts`:

```ts
it('agent_create takes a --local folder for OpenClaw only, absolute and there', async () => {
  expect(await create({ engine: 'codex', cwd, openclawLocal: folder })).toEqual({ error: 'INVALID_LOCAL_FOLDER', detail: '--local is for OpenClaw only.' })
  expect(await create({ engine: 'openclaw', cwd, openclawLocal: '/nowhere' })).toEqual({ error: 'INVALID_LOCAL_FOLDER', detail: '/nowhere is not a folder.' })
  expect(await create({ engine: 'openclaw', cwd, openclawLocal: 'relative' })).toMatchObject({ error: 'INVALID_LOCAL_FOLDER' })
  expect(await create({ engine: 'openclaw', cwd, openclawLocal: 7 })).toMatchObject({ error: 'INVALID_LOCAL_FOLDER' })
  await create({ engine: 'openclaw', cwd, openclawLocal: folder })
  expect(createAgent.mock.calls.at(-1)![0]).toMatchObject({ engine: 'openclaw', openclawLocal: folder })
  await create({ engine: 'openclaw', cwd })
  expect(createAgent.mock.calls.at(-1)![0]).not.toHaveProperty('openclawLocal')
})
```

`create.spec.ts`:

```ts
it('a local create hands its folder to the native launch and to the row', async () => {
  // native: (engine, source) => ok launch with openclawLocal: source.openclawLocal
  expect(native.mock.calls[0][1]).toMatchObject({ openclawLocal: folder })
  expect(registry.byAgent(result.session.agentId)).toMatchObject({ openclawLocal: folder, openclawStateDir: folder })
})
it('a folder gone by the time a saved launch runs is refused, and nothing is launched', async () => {
  rmSync(folder, { recursive: true })
  expect(await prepare({ ...INPUT, openclawLocal: folder })).toEqual({ ok: false, error: 'OPENCLAW_FOLDER_GONE', detail: "This run's OpenClaw folder is gone." })
  expect(backend.create).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled()
})
it('a local create never starts on a launch that was not prepared for its folder', async () => {
  // native answers an ok launch with no openclawLocal; and a creator made with no native at all
  expect(await prepare({ ...INPUT, openclawLocal: folder })).toEqual({ ok: false, error: 'OPENCLAW_LOCAL_UNPREPARED',
    detail: 'This Harness could not prepare the --local folder. Nothing was started.' })
  expect(backend.create).not.toHaveBeenCalled()
})
```

`createAgentPane.spec.ts`: `'a local launch's folder goes on its row'`: `openPendingAgent` was called with
`openclawLocal`.

- [ ] **Step 2:** `npx vitest run src/core/agents/launches.spec.ts src/core/agents/create.spec.ts src/lib/createAgentPane.spec.ts`
  → FAIL (the field is ignored). Commit: `agent_create: a --local folder, checked, on the launch and the row (red)`.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same command plus `src/core/agents/launchRequests.golden.spec.ts src/core/agents/nativeCreate.spec.ts`
  → PASS. Commit: `agent_create: a --local folder, checked, on the launch and the row`.

### Task 14: Relaunch, restore, resume and fork

**Depends on:** Tasks 1, 2, 8.

**Files:**
- Modify: `cli/src/lib/launchOverrides.ts` (`LaunchSource`, `prepareLaunchOverrides`),
  `cli/src/core/agents/launch.ts` (`relaunchOverrides`), `cli/src/core/agents/fork.ts` (`prepare`)
- Test: `cli/src/lib/launchOverrides.spec.ts`, `cli/src/core/agents/launch.spec.ts`, `cli/src/core/agents/fork.spec.ts`

**Interfaces:**
- Consumes: `OPENCLAW_LOCAL` (Task 1); the row's field (Task 2); `NativeLaunch.openclawLocal` (Task 8).
- Produces:
  - `LaunchSource.openclawLocal?: string | null` (declared on `LaunchSource` itself, as `codexHome` is).
  - `prepareLaunchOverrides`, first thing for a source with the folder: not an existing folder →
    `{ ok: false, error: 'OPENCLAW_FOLDER_GONE', detail: OPENCLAW_LOCAL.folderGone }`, with no `unavailable` (so a
    restore fails the row with these words and launches nothing, a restart and a resume answer them), and nothing
    asked of any service. After the native inspection: a launch missing, or one whose `openclawLocal` is not the
    source's → `{ ok: false, error: 'OPENCLAW_LOCAL_UNPREPARED', detail: OPENCLAW_LOCAL.unprepared }`.
  - `relaunchOverrides` in `core/agents/launch.ts` takes the folder from the row, like the row's DSH and named
    agent, whatever the source: `openclawLocal: session.openclawLocal ?? null` is set after `...source`.
  - `fork.ts` `prepare`: a source row with the folder → `{ ok: false, error: 'FORK_UNSUPPORTED', detail:
    OPENCLAW_LOCAL.noFork }`, before the native inspection and before any pane.

- [ ] **Step 1: Write the failing tests**

`launchOverrides.spec.ts`:

```ts
it('a local row whose folder is gone is refused before anything is asked, and never held', async () => {
  const built = await buildLaunchOverrides(deps, 'openclaw', { cwd, openclawLocal: '/gone' }, KEY)
  expect(built).toEqual({ ok: false, error: 'OPENCLAW_FOLDER_GONE', detail: "This run's OpenClaw folder is gone." })
  expect(deps.native).not.toHaveBeenCalled()
})
it('a local row relaunches only on a launch prepared for its folder', async () => {
  // native answers a launch with openclawLocal: folder → ok, overrides.native.openclawLocal is folder, env.OPENCLAW_STATE_DIR is folder
  // native answers a launch without it, or deps has no native → { ok: false, error: 'OPENCLAW_LOCAL_UNPREPARED', detail: 'This Harness could not prepare the --local folder. Nothing was started.' }
})
```

`launch.spec.ts`: `'a relaunch from another source keeps the row's --local folder'`: `relaunchOverrides(row, { gridLaunch: null })`
with a row that has the folder → the native dep's source has `openclawLocal` equal to the row's.

`fork.spec.ts`:

```ts
it('a local run is not forked', async () => {
  expect(await prepare({ agentId: local.agentId, name: null, prompt: null }, authority))
    .toEqual({ ok: false, error: 'FORK_UNSUPPORTED', detail: 'This run cannot be forked.' })
  expect(native).not.toHaveBeenCalled(); expect(backend.create).not.toHaveBeenCalled()
})
```

- [ ] **Step 2:** `npx vitest run src/lib/launchOverrides.spec.ts src/core/agents/launch.spec.ts src/core/agents/fork.spec.ts`
  → FAIL (the launch is built; the fork goes on). Commit: `OpenClaw: a local row relaunches local or not at all, and is not forked (red)`.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same command plus `src/core/agents/restoreLaunch.spec.ts src/core/agents/restart.spec.ts src/core/agents/swap.spec.ts src/lib/resumeAgentService.spec.ts`
  → PASS. Commit: `OpenClaw: a local row relaunches local or not at all, and is not forked`.

### Task 15: End-to-end spec, the real daemon

**Depends on:** Tasks 11, 12 (and what they depend on).

**Files:**
- Create: `cli/e2e/skillRun.e2e.ts` (set up as `e2e/agentClient.e2e.ts`'s signed-out test: `IsolatedDaemon`, the
  fake Claude Code, its `harness(d, pane, args)` helper)

- [ ] **Step 1: Write the test**

```ts
it('the person starts a harness with a task, closes it and deletes it: none of its words are left in the daemon\'s folder', async () => {
  const task = 'email zanzibarquokka about the dentist'
  expect((await harness(d, '', ['new', 'claude', '--name', 'run-1', '--', task])).code).toBe(0)
  expect((await harness(d, '', ['wait', 'run-1', '--timeout', '90s'])).code).toBe(0)
  expect((await harness(d, '', ['close', 'run-1'])).code).toBe(0)
  expect(wordsUnder(d.dataDir, ['zanzibarquokka', 'dentist'])).not.toEqual([])        // saved before the delete
  const deleted = await harness(d, '', ['delete', 'run-1', '--json'])
  expect(deleted.code).toBe(0)
  expect(JSON.parse(deleted.out)).toMatchObject({ name: 'run-1', deleted: true, kept: [] })
  await until(() => wordsUnder(d.dataDir, ['zanzibarquokka', 'dentist']).length === 0)   // the search process forgets when told
  expect((await harness(d, '', ['ps', '--all'])).out).not.toContain('run-1')
  expect((await harness(d, '', ['delete', 'run-1'])).code).toBe(1)                     // gone: no harness by that name
})
it('a running harness is deleted in one step', async () => { /* new, wait, delete (no close) → exit 0, no word left, its pane gone */ })
```

`wordsUnder(folder, words)`: every regular file under `folder` (the daemon's log left out: it never holds task text,
and its own assertion is `expect(d.log()).not.toContain('zanzibarquokka')`), read as bytes; returns the paths that
hold any word.

- [ ] **Step 2:** `npx vitest run --config vitest.e2e.config.ts e2e/skillRun.e2e.ts` → PASS on this branch. Show it red
  against `main` for the pull request (`harness delete` is `Unknown command`). Commit:
  `e2e: a deleted harness leaves none of its words in the daemon's folder`.

### Task 16: Gates

**Depends on:** Tasks 1 to 15. **Files:** none (a fix goes back to the task that owns the file).

- [ ] `npm run typecheck` → no errors.
- [ ] `npx vitest run src/architecture.spec.ts src/leanEntry.spec.ts src/asciiOnly.spec.ts` → PASS.
- [ ] `npx vitest run src/engines/openclaw src/engines/nativeLaunch.spec.ts src/core/agents src/core/transcripts src/lib/registry.local.spec.ts src/lib/registry.spec.ts src/lib/stoppedAgents.spec.ts src/lib/processTree.spec.ts src/lib/deleteAgentFallback.spec.ts src/lib/stopAgentService.spec.ts src/lib/sessionSearch src/services/search.spec.ts src/services/searchProcess.spec.ts src/agentClient src/lib/agentCreationReceipt.spec.ts src/lib/newCommand.spec.ts src/localWsServer.spec.ts src/lib/engineLaunch.spec.ts src/lib/engineLaunch.windows.spec.ts src/lib/launchOverrides.spec.ts src/lib/createAgentPane.spec.ts src/lib/purgeAgentService.spec.ts src/lib/agentFrame.spec.ts`
  → PASS.
- [ ] `npm run test:core` → 100% per file; `npm run test:resume` → 100% (it covers `stopAgentService.ts`). Record both
  for the pull request (PR CI does not run them).
- [ ] `grep -rn "does not support verified history deletion" cli/src --include='*.ts'` → no OpenClaw case left.
- [ ] The pull request names the platforms (macOS, Linux, Windows), the red then green commit of each task, Task 4's
  numbers, and Task 17's evidence.

### Task 17: End to end, on this Mac

**Depends on:** Task 16. **Files:** none in the repository; everything lives under one scratch folder. Run by the main
session.

OpenClaw 2026.11.2 is installed at `/opt/homebrew/lib/node_modules/openclaw` (`/opt/homebrew/bin/openclaw`).

**Never:** touch the real `~/.harness`, the live daemon (ports 18473 and 51793), its LaunchAgent or Harness.app's
data; `pkill` or `killall` by name (stop only the PIDs this task started); use `~/.openclaw` as a state folder or
write to it (read it to copy a model config; never print a copy's contents).

**The isolated daemon** follows the repo's recipe: `docs/development.md` ("Isolated end-to-end testing") and the
environment `cli/e2e/harness/daemon.ts` builds for `IsolatedDaemon` (throwaway `HOME` and `ZDOTDIR`, its own `PORT`,
`ADAPTER_DATA_DIR`, `ADAPTER_RUNTIME_DIR`, `ADAPTER_COMPUTER_ID_FILE`, `HARNESS_AUTH_DIR`, `HARNESS_HOOK_ROUTES_DIR`
under that home, `BACKEND_WS_URL=ws://127.0.0.1:9`, `WEB_URL=http://127.0.0.1:9`, `DISABLE_HOOK_INSTALL=true`,
`ADAPTER_UPDATE_DISABLE=true`, `ANALYTICS_ENABLED=false`, `CABLE_DISABLE=true`, `CABLE_FW_DISABLE=true`,
`TERMINAL_BACKENDS=tmux`, a private tmux server: `TMUX_TMPDIR` in the scratch folder, `TMUX` and `TMUX_PANE` unset).
`PATH` starts with a Node 24 folder, then `/opt/homebrew/bin`. Started from `cli/` (`npx tsx src/cli.ts start -f`);
the `harness` commands run with the same environment. No `OPENCLAW_STATE_DIR` in the daemon's environment, and no
Gateway started by this task.

- [ ] **Step 1: Before.** Note the PIDs listening on 18473 and 51793 and `shasum ~/.openclaw/openclaw.json`. Make the
  scratch root with `home/`, `data/`, `tmux/`, `run1/`, `run2/`. Into `run1/` and `run2/` copy only what a local run
  needs to reach a model (the `openclaw.json` model section and the credential it names). Check no Gateway holds
  either folder.
- [ ] **Step 2: Typed and answered, with no Gateway.**
  `harness new openclaw --local <root>/run1 --name skill-1 -- "Reply with exactly: local-ok"`. Expect: created; the
  pane's process is `openclaw tui --local --session harness-<id>`; its environment (`ps eww <pid>`) has
  `OPENCLAW_STATE_DIR=<root>/run1` and none of `OPENCLAW_CONFIG_PATH`, `OPENCLAW_AGENT_DIR`, `OPENCLAW_OAUTH_DIR`,
  `OPENCLAW_WORKSPACE_DIR`; the status line reads `local ready`; the log has `create ready · openclaw · local` and
  `first task handed over`, once; `harness wait skill-1` exits 0 and `harness show skill-1` has `local-ok`; the row in
  `data/registry.json` has `openclawLocal` and `openclawStateDir` both `<root>/run1`; no hold was ever said.
- [ ] **Step 3: A relaunch stays local.** Stop the daemon (its PID) and the private tmux server (by its socket), as a
  reboot does; start the daemon and let it restore the row. Expect the new pane's process is
  `openclaw tui --local --session agent:main:harness-<id>` with `OPENCLAW_STATE_DIR=<root>/run1`, and nothing typed
  again.
- [ ] **Step 4: Folder in use.** While `skill-1` runs, `harness new openclaw --local <root>/run1 --name skill-dup`.
  Expect: its agent's launch is `failed`, `OPENCLAW_FOLDER_IN_USE`, with
  `Another OpenClaw is using this folder. Give each run its own --local folder.` (`harness ps --all --json`, or its
  row in `data/registry.json`), and the log has `create failed · openclaw`; `skill-1` is untouched. Delete
  `skill-dup`.
- [ ] **Step 5: Close ends the tool.**
  `harness new openclaw --local <root>/run2 --name skill-2 -- "Run this shell command and wait for it: sleep 300. Then reply done."`.
  Once the pane reads `running`, find the `sleep 300` process (`ps -axo pid,ppid,pgid,sess,args`) and note its PID
  and that its process group is not the TUI's. `harness close skill-2 --now`. Expect within 5 s: that PID and the
  TUI's PID are gone (`kill -0` fails), and no process is left whose ancestor was the TUI.
- [ ] **Step 6: Delete leaves nothing.** Pick a marker no other file holds:
  `harness new openclaw --local <root>/run1 --name skill-3 -- "Reply with exactly: zanzibarquokka-ok"` after closing
  `skill-1`; wait; `harness delete skill-3`. Expect exit 0 and
  `skill-3 on <machine>: deleted. Everything Harness kept of it is erased.` then
  `OpenClaw's store is kept: delete its session with OpenClaw.`; `grep -rl zanzibarquokka <root>/data` finds nothing
  (the search database and its `-wal` included); the receipt in `data/agent-creations/` reads `"scrubbed":true`;
  `harness ps --all` does not list it; `<root>/run1` still holds OpenClaw's store. Restart the daemon and wait one
  sweep (15 s after start): `harness search zanzibarquokka` finds nothing, though the store is still on disk.
  Also `harness delete skill-2` (closed): exit 0.
- [ ] **Step 7: Folder gone.** Start `skill-4` on a fresh `<root>/run3` (seeded the same way). Stop the daemon and the
  private tmux server as in Step 3, remove `<root>/run3`, start the daemon. Expect: the row's launch failed with
  `This run's OpenClaw folder is gone.`, and no `openclaw` process was started (none under the private tmux server,
  none on the shared state folder).
- [ ] **Step 8: The real-process spec on macOS.** `npx vitest run src/lib/processTree.spec.ts` → PASS (Linux runs it
  in PR CI).
- [ ] **Step 9: After.** Stop only the PIDs started (the daemon, any TUI left) and the private tmux server by its
  socket; remove the scratch root, the copied credentials with it. Confirm the listeners on 18473 and 51793 are the
  PIDs of Step 1 and `~/.openclaw/openclaw.json` has the same `shasum`.
- [ ] **Step 10: Evidence** for the pull request: the argv and environment read in Step 2, the log lines (no task text
  beyond this test's own), the process listings before and after the close, the `grep` of Step 6, the platforms run
  (macOS here; Linux and Windows by the unit specs).

## Self-review

- **Spec coverage.** `--local`: the option and old daemons (Task 7), the wire and the row (2, 13), launch (1, 8),
  relaunch, folder gone and fork (14), store (2, 9), screen (1, 9), folder in use (1, 10), the tree (3), measures
  (10). `harness delete`: the command (11), OpenClaw and every session key and the words left behind (2, 5, 6, 12),
  the search index (4). Each test in the spec's list has its named test above; the end-to-end check is Task 17.
- **Ruled where the spec left it open:**
  1. The folder rides the native launch (environment, cleared variables, argv), so no launch site names it; a local
     row with no such launch is refused (`OPENCLAW_LOCAL_UNPREPARED`), never started on the shared folder.
  2. The daemon says it knows `--local` with `features: ['openclaw-local']` in the `connected` frame of a tool
     connection, which the CLI already reads; a window's frame is untouched.
  3. `--local` with `--machine` is refused; `harness delete` takes no `--machine`.
  4. Folder in use: a local launch is ready only once its TUI has drawn, and an exit before that with OpenClaw's
     lock words is a failed launch with the spec's sentence.
  5. `starting local runtime` reads as `connecting` does today (`busy`, not running); the local title is not read.
  6. The tree: a process group is signalled only when one of the tree leads it (a group led by the pane's shell
     would take the shell); Hermes's gateway and what it started are left out; a descendant that outlives SIGKILL
     fails the stop. The swap in `core/agents/swap.ts` (restart, retarget) is not given the tree: the spec names stop.
  7. Earlier session keys: the row keeps them (at most 32) for recaps and checkpoints, which are keyed by session
     alone; search rows also go by agent id inside the index. Keys a harness left before this ships are covered for
     search rows only.
  8. Secure delete is the pragma **and** FTS5's own `secure-delete` option (measured: the pragma alone leaves the
     words in the index). The exclusion is a table in the search database, with no schema version change.
  9. Receipts are found by one streamed pass of their folder per delete: nothing maps an agent to its receipt, and
     the core already streams that folder every minute.
  10. The "launch measure" is the launch's log line (`· local ·`); the product-usage counters are a list shared with
      the backend, and the spec adds none.
  11. A delete whose ledger or receipt cleanup fails is refused and can be asked again, rather than answered done.
  12. Checkpoints saved under an earlier session key are erased too (the spec names recaps and search rows).
  13. The delete's output, usage and help line; a cloud harness is refused; the verb is not in the agents' help.
  14. An end-to-end spec on the fake engine (Task 15), which `cli/AGENTS.md` asks of every user-facing flow.
- **Left as the spec has it:** OpenClaw's own store is never erased; a descendant that re-parented away before the
  list is out of reach; a harness still starting is refused by purge in its own words; a new harness bound to a
  deleted conversation's key that is still on disk stays out of search; `Told` lines kept by another machine's
  ledger are not this machine's to erase.
