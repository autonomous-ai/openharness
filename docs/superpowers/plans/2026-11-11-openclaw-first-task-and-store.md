# OpenClaw first task and store Implementation Plan

> **For agentic workers:** REQUIRED: execute with **ken15dev phase 3** (wave by wave, one Opus subagent per task, a red
> test commit then a code commit). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first task given to an OpenClaw harness is typed into it at most once, once its Gateway answers, and
confirmed like every later message; an OpenClaw harness whose store Harness cannot find says so; Harness's default
state folder is OpenClaw's own.

**Architecture:** The first task leaves argv (`--message` goes) and is kept on the agent's registry row; the bind pass
that already reads the pane removes it durably and hands it to the session input on the first `ready` reading. The
store stream (`engines/openclaw/live.ts`) learns from that same pass whether a run is in progress, and after 30 s of a
run with no session node raises one more store hold, which `core/transcripts/attach.ts` says on the agent. The default
state folder is one pure function of `OPENCLAW_STATE_DIR` and `OPENCLAW_HOME`, used where `env.OPENCLAW_STATE_DIR` is
read today.

**Tech Stack:** TypeScript (daemon core, `cli/src`), vitest, `node:sqlite` (Node 24), tmux.

**Spec:** [docs/superpowers/specs/2026-11-11-openclaw-first-task-and-store-design.md](../specs/2026-11-11-openclaw-first-task-and-store-design.md).
Read it with this plan, and `AGENTS.md`, `cli/AGENTS.md`, `docs/naming-system.md`.

## Global Constraints

- Platforms: macOS, Linux, Windows; daemon only. No client, backend or wire change. No new switch or setting.
- `--message` is removed: one way to hand OpenClaw its first task. `supportsFirstPrompt('openclaw')` stays `true`.
- The first task is typed **at most once**: the row's field is removed, and that removal saved, **before** the task
  reaches the session input. Never typed twice; no timeout while it waits.
- OpenClaw's submit confirmation gives the user row **30 s** in total, for every OpenClaw message.
- Store hold: pane status `running` or `streaming` (not `connecting`) and no session node for the key,
  continuously **30 s**. Exact copy: `Harness cannot find this OpenClaw's sessions. Start Harness with the Gateway's
  OPENCLAW_STATE_DIR, then restart this agent.`
- Default state folder: `OPENCLAW_STATE_DIR` (trimmed, `~` expanded against the home below), else
  `<OPENCLAW_HOME (~ expanded) or OS home>/.openclaw`.
- Log lines name the agent by its short id (`sid`, `lib/log.ts`) and the outcome (`kept`, `handed over`); never the
  task's text. The folder Harness looked in goes to the local log only.
- Every task: a test that fails without the change, committed red, then the code. Comments say why. No dead code.
  `src/core/**` keeps 100% coverage per file (`npm run test:core`), `core/main.ts` excepted.
- Tests never touch the developer's machine: throwaway folders, no real `~/.harness`, `~/.openclaw`, daemon or tmux.

**Running tests** (from `cli/`; a fresh worktree needs `npm ci` there first). Node 24 is required (FTS5):

```bash
export PATH=/private/tmp/claude-502/-Users-nqhieu84-go-src-github-com-autonomous-ai-openharness/eda5be6b-d279-4af2-91a6-3f2174568699/scratchpad/node-v24.22.2-darwin-arm64/bin:$PATH
npx vitest run <spec paths>
```

**Every task's steps:** write the tests named → run them, see them fail for the reason given → commit the red tests →
implement what **Interfaces** states → run the task's specs, see them pass → commit the code. A task touches only the
files it lists and runs only the specs its steps name (another task of the wave may be mid-edit in the rest); a
failing spec outside its files is reported to the lead, not edited.

## Review Focus

Failure modes the spec implies that are most likely to bite, each pinned by a test in the task that owns the code:

1. **The daemon stops, or the reconcile pass still holds registry saves, between the removal and the typing.** The
   task must be typed zero or one time, never two. Tasks 3 and 8 (`takeFirstTask` saves strictly; the bind pass waits
   for `afterTransaction`).
2. **The task is typed before the store stream is attached.** Its user row is then history, nothing confirms it, the
   person reads "did not accept" and sends it again. Task 8 (no stream took the reading: nothing handed over).
3. **The task's text leaves the machine or reaches a log.** Tasks 3 and 8 (the agent frame and every log line).
4. **An agent archived with its task still on the row leaves a shell that carries a copy.** Both would type it.
   Task 3 (`releaseEngine(..., true)`).
5. **The person runs `/new` before the task is typed.** The pane shows another key than the bound session. Task 8
   (binds first, hands over on the next pass).

## Files

| File | What changes | Task |
|---|---|---|
| `cli/src/engines/openclaw/contract.ts` | launch contract (typed first prompt, daemon variables), `running`, the new state, the default folder | 1 |
| `cli/src/lib/sessionInput.ts` | `OPENCLAW_SUBMIT_VERIFY_MS` | 2 |
| `cli/src/lib/registry.ts` | `firstTask` on the row: kept, carried, taken | 3 |
| `cli/src/lib/engineLaunch.ts` | no argv for a typed first prompt; the daemon's variables in a launch's environment | 4 |
| `cli/src/config/env.ts`, `cli/src/engines/kit/nativeLocations.ts`, `cli/src/engines/nativeLaunch.ts`, `cli/src/lib/openclawStore.ts` | the default folder, `OPENCLAW_HOME` as a launch location | 5 |
| `cli/src/engines/openclaw/reader.ts`, `live.ts`, `cli/src/core/agents/bind.ts`, `cli/src/core/main.ts` | the stream is told a run is in progress, and notices a store with no session | 6 |
| `cli/src/core/transcripts/attach.ts`, `cli/src/engines/README.md` | the store hold on the agent | 7 |
| `cli/src/core/agents/bind.ts` | the handover | 8 |
| `cli/src/lib/createAgentPane.ts`, `cli/src/core/agents/create.ts`, `fork.ts`, `cli/src/lib/restoreAgents.ts`, `cli/src/core/main.ts` | every launch keeps the task on the row | 9 |
| `cli/src/core/agents/bind.ts` | a relaunched TUI's state folder replaces the row's | 10 |

## Waves

A wave's tasks depend on nothing in the same wave and share no file, tests included.

| Wave | Tasks |
|---|---|
| 1 | 1 Contract · 2 Confirmation window · 3 Registry row |
| 2 | 4 Launch argv and environment · 5 Default folder · 6 Stream notices a store with no session |
| 3 | 7 Store hold on the agent · 8 Handover · 9 Launches keep the task |
| 4 | 10 Relaunched TUI's folder |
| 5 | 11 Gates · 12 End to end |

---

### Task 1: OpenClaw contract

**Depends on:** nothing.

**Files:**
- Modify: `cli/src/engines/openclaw/contract.ts`
- Test: `cli/src/engines/openclaw/contract.spec.ts`

**Interfaces (produces):**
- `OPENCLAW_LAUNCH.firstPrompt: 'typed'`: the first prompt is typed into the pane, never given in argv (the TUI sends
  `--message` once, after its first Gateway connection, and never again: OpenClaw 2026.11.2 `state.autoMessageSent`).
- `OPENCLAW_LAUNCH.environment: ['OPENCLAW_STATE_DIR', 'OPENCLAW_HOME']`: the daemon's variables a TUI starts with.
- `OpenclawScreen.running: boolean`: the status line reads `running` or `streaming` (`STATUS.running`,
  `/^\S{1,2} (?:running|streaming)\b/`). `state` is unchanged (`busy` still covers `connecting`).
- `OPENCLAW_STATES.noSessions`: the exact copy in Global Constraints.
- `openclawDefaultStateDir(vars: Readonly<Record<string, string | undefined>>, osHome: string): string`, beside
  `openclawAgentDb`. As OpenClaw's `resolveStateDir`: home is `OPENCLAW_HOME` trimmed (a leading `~`, `~/` or `~\`
  replaced by `osHome`), else `osHome`; the result is `OPENCLAW_STATE_DIR` trimmed (a leading `~` replaced by that
  home), else `<home>/.openclaw`; both through `path.resolve`.

- [ ] **Step 1: Write the failing tests** in `contract.spec.ts`

```ts
it('reads a run in progress off the status line: running and streaming, never connecting', () => {
  const running = fixture('screen-abort-running.txt')
  expect(readOpenclawScreen(running)).toMatchObject({ state: 'busy', running: true })
  expect(readOpenclawScreen(running.replace('running •', 'streaming •'))).toMatchObject({ state: 'busy', running: true })
  expect(readOpenclawScreen(running.replace('running •', 'connecting •'))).toMatchObject({ state: 'busy', running: false })
  for (const idle of ['screen-plain.txt', 'screen-no-gateway.txt', 'screen-no-token.txt']) expect(readOpenclawScreen(fixture(idle)).running, idle).toBe(false)
})

it('the default state folder is the one OpenClaw resolves', () => {
  const at = (vars: Record<string, string>) => openclawDefaultStateDir(vars, '/home/u')
  expect(at({})).toBe('/home/u/.openclaw')
  expect(at({ OPENCLAW_HOME: '/h' })).toBe('/h/.openclaw')
  expect(at({ OPENCLAW_STATE_DIR: '~/x' })).toBe('/home/u/x')
  expect(at({ OPENCLAW_STATE_DIR: '~/x', OPENCLAW_HOME: '/h' })).toBe('/h/x')
  expect(at({ OPENCLAW_STATE_DIR: '  /s  ' })).toBe('/s')
  expect(at({ OPENCLAW_STATE_DIR: '~' })).toBe('/home/u')
  expect(at({ OPENCLAW_HOME: '~/claw' })).toBe('/home/u/claw/.openclaw')
  expect(at({ OPENCLAW_STATE_DIR: '   ', OPENCLAW_HOME: ' ' })).toBe('/home/u/.openclaw')
})

it('the launch contract types the first prompt, names the daemon variables, and the store state reads as written', () => {
  expect(OPENCLAW_LAUNCH.firstPrompt).toBe('typed')
  expect(OPENCLAW_LAUNCH.environment).toEqual(['OPENCLAW_STATE_DIR', 'OPENCLAW_HOME'])
  expect(OPENCLAW_STATES.noSessions).toBe("Harness cannot find this OpenClaw's sessions. Start Harness with the Gateway's OPENCLAW_STATE_DIR, then restart this agent.")
})
```

- [ ] **Step 2:** `npx vitest run src/engines/openclaw/contract.spec.ts` → FAIL (`running` undefined,
  `openclawDefaultStateDir` not exported, `firstPrompt` undefined). Commit: `OpenClaw contract: a typed first prompt, a run in progress, the store state, the default folder (red)`.
- [ ] **Step 3:** Implement the Interfaces. `NOTHING` gains `running: false`.
- [ ] **Step 4:** `npx vitest run src/engines/openclaw` → PASS. Commit: `OpenClaw contract: a typed first prompt, a run in progress, the store state, the default folder`.

### Task 2: Confirmation window

**Depends on:** nothing.

**Files:**
- Modify: `cli/src/lib/sessionInput.ts` (`OPENCLAW_SUBMIT_VERIFY_MS`)
- Test: `cli/src/lib/sessionInput.spec.ts`

**Interfaces:** `OPENCLAW_SUBMIT_VERIFY_MS = 10_000`. With `SUBMIT_MAX_RETRIES = 2` that is three windows: Enter again
at 10 s and 20 s, given up at 30 s. Its comment names why: a Gateway short of memory stalled 18 s at a time before
writing the run's user row (lamp, 2026-11-11).

- [ ] **Step 1: Write the failing tests** (widen the spec's `session()` helper to take `'openclaw'`; `capture: async () => null`)

```ts
it('an OpenClaw message waits 30 s for its user row before it is given up', async () => {
  // controller as in 'retries Enter then errors for Claude…', with getSession: () => session('openclaw')
  controller.submit('s1', 'hello')
  await vi.advanceTimersByTimeAsync(29_900)
  expect(sendKey).toHaveBeenCalledTimes(2)          // Enter again at 10 s and at 20 s
  expect(onError).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(200)
  expect(onError).toHaveBeenCalledWith('s1', expect.stringContaining('did not accept'))
})

it('a user row 25 s after the paste confirms an OpenClaw message', async () => {
  controller.submit('s1', 'hello')
  await vi.advanceTimersByTimeAsync(25_000)
  controller.onTurnStarted('s1', 'hello')
  await vi.advanceTimersByTimeAsync(30_000)
  expect(onError).not.toHaveBeenCalled()
})
```

- [ ] **Step 2:** `npx vitest run src/lib/sessionInput.spec.ts` → FAIL (given up at 7.5 s). Commit red: `OpenClaw: a message waits 30 s for its user row (red)`.
- [ ] **Step 3:** Set the constant and its comment.
- [ ] **Step 4:** `npx vitest run src/lib/sessionInput.spec.ts src/core/transcripts/openclaw.spec.ts` → PASS. Commit: `OpenClaw: a message waits 30 s for its user row`.

### Task 3: Registry row

**Depends on:** nothing.

**Files:**
- Modify: `cli/src/lib/registry.ts`
- Test: `cli/src/lib/registry.firstTask.spec.ts` (create; set up as `registry.homes.spec.ts` does: `ADAPTER_DATA_DIR`
  stubbed to a temp folder, the module imported after), `cli/src/lib/registry.externalResume.spec.ts`,
  `cli/src/lib/agentFrame.spec.ts`

**Interfaces (produces):**
- `RegisteredSession.firstTask?: string`: the first task its launch carried, until it is typed into the pane. Saved
  with the row (`persistedRow` keeps it).
- `openPendingAgent({ …, firstTask?: string })` creates the row with it.
- `beginExternalDispatch(agentId: string, firstTask?: string)`: sets it in the same strict save as `dispatched: true`,
  and rolls it back with the rest when that save fails.
- `takeFirstTask(agentId: string): { sessionId: string; task: string } | null`: null when the agent is gone, unbound
  or has none. Otherwise deletes the field, saves **strictly** (`this.save(true)`), then returns; a save that throws
  puts the field back and rethrows. A strict save throws inside a registry transaction: callers use `afterTransaction`.
- Carried where a row is rebuilt: `load()` and `strictPersistedRow` (only a non-empty string; out of the `...rest`
  spread), `register()` (`existing.firstTask`). `resumePendingAgent` and `reinstateArchived` spread the saved row.
- `releaseEngine(agentId, true)` deletes it from the shell's new row: the task stays the archived agent's.
- Setting it logs `[agent] <short id> first task kept`, never the text.

- [ ] **Step 1: Write the failing tests** in `registry.firstTask.spec.ts`

| Test | Asserts |
|---|---|
| `a first task is saved on the row and read back by the next daemon` | after `openPendingAgent({ engine: 'openclaw', runtimes, firstTask: 'Fix the parser' })`: `row.firstTask`, the same in `registry.json`; after `vi.resetModules()` and `load()`: `byAgent(id).firstTask === 'Fix the parser'`; the log says `first task kept` and no log line contains `Fix the parser` |
| `a bind keeps it` | `register({ engine: 'openclaw', sessionId: 'agent:main:harness-1', runtimes, … })` on that agent: `entry.firstTask === 'Fix the parser'` |
| `taking it removes it from the file before it is returned, once` | `takeFirstTask(id)` equals `{ sessionId: 'agent:main:harness-1', task: 'Fix the parser' }`; `registry.json` then has no `firstTask`; a second call is `null`; after a reload the row has none |
| `an unbound agent keeps its task` | before any `register`: `takeFirstTask(id) === null`, `byAgent(id).firstTask` still set |
| `a registry that cannot save keeps the task` | with `registry.json` made unreadable (as `registry.externalResume.spec.ts` does, `'{unreadable'`): `takeFirstTask(id)` throws and `byAgent(id).firstTask === 'Fix the parser'` |
| `inside a reconcile transaction it is taken only after the commit` | in `registry.transaction(...)`: `takeFirstTask(id)` throws and the row keeps it; `afterTransaction(() => registry.takeFirstTask(id))` resolves to the task once the transaction ends |
| `the shell an archived agent leaves behind carries no task` | `releaseEngine(id, true)!.firstTask` is `undefined` |
| `a saved row keeps only a text task` | `strictPersistedRow({ ...row, firstTask: 42 })!.firstTask` is `undefined`; with `'x'` it is `'x'` |

In `registry.externalResume.spec.ts`: `a dispatch that carries a first task commits both together`:
`beginExternalDispatch(row.agentId, 'continue')` matches `{ firstTask: 'continue', externalResume: { dispatched: true } }`,
the file's row has both; made to fail, the row has neither; without the argument there is no `firstTask`.

In `agentFrame.spec.ts`: `a first task never rides the agent's frame`: the frame of a row with
`firstTask: 'Fix the parser'`, as JSON, does not contain `Fix the parser` (passes before the change; it pins the wire).

- [ ] **Step 2:** `npx vitest run src/lib/registry.firstTask.spec.ts src/lib/registry.externalResume.spec.ts src/lib/agentFrame.spec.ts` → FAIL (`takeFirstTask` is not a function; the field dropped by `load()`). Commit red: `Registry: an agent's first task is kept on its row until it is typed (red)`.
- [ ] **Step 3:** Implement the Interfaces.
- [ ] **Step 4:** `npx vitest run src/lib/registry*.spec.ts src/lib/agentFrame.spec.ts` → PASS. Commit: `Registry: an agent's first task is kept on its row until it is typed`.

### Task 4: Launch argv and environment

**Depends on:** Task 1.

**Files:**
- Modify: `cli/src/lib/engineLaunch.ts`
- Test: `cli/src/engines/openclaw/launch.spec.ts`, `cli/src/lib/engineLaunch.spec.ts`

**Interfaces:**
- Consumes: `OPENCLAW_LAUNCH.firstPrompt`, `OPENCLAW_LAUNCH.environment`.
- Produces:
  - `FIRST_PROMPT_ARGS: Readonly<Record<AgentEngine, readonly string[] | 'typed' | null>>`, `openclaw: OPENCLAW_LAUNCH.firstPrompt`.
    `supportsFirstPrompt` is unchanged (`!== null`). `firstPromptArgs(engine, prompt)` returns `[]` for `'typed'`, so
    `buildEngineCommandArgv` never puts the task in argv. `LaunchCommandOptions.firstPrompt` is still passed by callers
    (the install progress line reads it).
  - `typedFirstPrompt(engine: AgentEngine, prompt: string | undefined): string | undefined`: the prompt when the
    engine's first prompt is typed and there is one; else `undefined`. The one place a launch decides.
  - `engineLaunchEnv(engine, native?, platform = process.platform, daemon: NodeJS.ProcessEnv = process.env)`: on every
    platform, the daemon's non-empty values of the variables the engine's launch names (`OPENCLAW_LAUNCH.environment`);
    on Windows also what it returns today; `undefined` when there are none. Its callers (`create.ts`, `fork.ts`,
    `swap.ts`, `resumeAgentService.ts`, restore in `main.ts`) already merge it into the pane's environment.

- [ ] **Step 1: Write the failing tests.** In `launch.spec.ts`, replace `a first task goes in --message`:

```ts
it('a first task is typed, never given in argv', () => {
  expect(buildEngineCommandArgv('openclaw', { agentId: AGENT, firstPrompt: 'Fix the parser' }))
    .toEqual(['openclaw', 'tui', '--session', `harness-${AGENT}`])
  expect(supportsFirstPrompt('openclaw')).toBe(true)
  expect(typedFirstPrompt('openclaw', 'Fix the parser')).toBe('Fix the parser')
  expect(typedFirstPrompt('openclaw', undefined)).toBeUndefined()
  expect(typedFirstPrompt('claude', 'Fix the parser')).toBeUndefined()
})

it('a launched TUI gets the daemon\'s OPENCLAW_STATE_DIR and OPENCLAW_HOME', () => {
  const daemon = { OPENCLAW_STATE_DIR: '/gw/state', OPENCLAW_HOME: '/gw', PATH: '/bin' }
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    expect(engineLaunchEnv('openclaw', undefined, platform, daemon)).toEqual({ OPENCLAW_STATE_DIR: '/gw/state', OPENCLAW_HOME: '/gw' })
  }
  expect(engineLaunchEnv('openclaw', undefined, 'linux', { OPENCLAW_STATE_DIR: '' })).toBeUndefined()
  expect(engineLaunchEnv('claude', undefined, 'linux', daemon)).toBeUndefined()
  expect(engineLaunchEnv('openclaw', { token: 't' }, 'win32', { OPENCLAW_HOME: '/gw' })).toEqual({ OPENCLAW_HOME: '/gw', HARNESS_NATIVE_LAUNCH_TOKEN: 't' })
})
```

- [ ] **Step 2:** `npx vitest run src/engines/openclaw/launch.spec.ts` → FAIL (argv ends `--message Fix the parser`; `typedFirstPrompt` not exported). Commit red: `OpenClaw launch: the first task leaves argv, and a TUI starts with the daemon's state variables (red)`.
- [ ] **Step 3:** Implement. Remove the `--message` entry and its comment; the `FIRST_PROMPT_ARGS` doc says what `'typed'` means.
- [ ] **Step 4:** `npx vitest run src/engines/openclaw/launch.spec.ts src/lib/engineLaunch.spec.ts src/lib/engineLaunch.windows.spec.ts src/engines/launchArgv.golden.spec.ts src/engines/launches.spec.ts` → PASS (fix `engineLaunch.spec.ts` cases that spread a `FIRST_PROMPT_ARGS` entry). Commit: `OpenClaw launch: the first task leaves argv, and a TUI starts with the daemon's state variables`.

### Task 5: Default folder

**Depends on:** Task 1.

**Files:**
- Modify: `cli/src/config/env.ts`, `cli/src/engines/kit/nativeLocations.ts`, `cli/src/engines/nativeLaunch.ts`,
  `cli/src/lib/openclawStore.ts` (header comment only)
- Test: `cli/src/config/env.spec.ts`, `cli/src/engines/nativeLaunch.spec.ts`

**Interfaces:**
- Consumes: `openclawDefaultStateDir`.
- `env.OPENCLAW_STATE_DIR` becomes
  `(raw) => openclawDefaultStateDir({ OPENCLAW_STATE_DIR: raw, OPENCLAW_HOME: process.env.OPENCLAW_HOME }, homedir())`.
  Its three readers follow with no change of their own: `lib/openclawStore.ts` (the fallback after the TUI's open
  file, which still wins), `lib/sessionSearch/externals/index.ts`, `lib/worktreeDeletion.ts`.
- `LAUNCH_LOCATION_VARIABLES` gains `'OPENCLAW_HOME'`: `inspectNativeLaunch` sees only the variables this list captures.
- `ENGINE_LOCATIONS.openclaw = ['OPENCLAW_STATE_DIR', 'OPENCLAW_HOME']`.
- `nativeHookLocations(vars).OPENCLAW_STATE_DIR = vars.OPENCLAW_STATE_DIR || join(vars.OPENCLAW_HOME || home, '.openclaw')`.

- [ ] **Step 1: Write the failing tests.** `env.spec.ts` (add `OPENCLAW_STATE_DIR` to `READ`; the existing exact
  expectation gains `OPENCLAW_STATE_DIR: join(plain.home, '.openclaw')`):

```ts
it('the OpenClaw state folder is the one OpenClaw would use', () => {
  expect(load({ OPENCLAW_HOME: '/h' }).env).toMatchObject({ OPENCLAW_STATE_DIR: '/h/.openclaw' })
  expect(load({ OPENCLAW_STATE_DIR: ' ~/x ', OPENCLAW_HOME: '/h' }).env).toMatchObject({ OPENCLAW_STATE_DIR: '/h/x' })
  expect(load({ OPENCLAW_STATE_DIR: '/s' }).env).toMatchObject({ OPENCLAW_STATE_DIR: '/s' })
})
```

`nativeLaunch.spec.ts`:

```ts
it('refuses an OpenClaw launch whose OPENCLAW_HOME is a network path on Windows', async () => {
  host.win32 = true
  try {
    vi.mocked(captureLaunchExecutable).mockResolvedValueOnce({ state: 'ready', executable: { command: '/fixture/engine', identity: 'fixture', current: () => true },
      environment: { HOME: '/fixture/home', PATH: '/fixture/bin', OPENCLAW_HOME: '\\\\server\\share\\h' } } as never)
    const result = await inspectNativeLaunch('openclaw')
    expect(result).toMatchObject({ ok: false, refusal: 'ENGINE_LAUNCH_REFUSED' })
    expect((result as { detail: string }).detail).toMatch(/^OPENCLAW_HOME names a network or device path/)
  } finally { host.win32 = false }
})
it('OPENCLAW_HOME is a launch location, and moves the state folder a launch derives', () => {
  expect(LAUNCH_LOCATION_VARIABLES).toContain('OPENCLAW_HOME')     // imported from './kit/nativeLocations.js'
  expect(nativeHookLocations({ HOME: '/home/u', OPENCLAW_HOME: '/h' }).OPENCLAW_STATE_DIR).toBe('/h/.openclaw')
  expect(nativeHookLocations({ HOME: '/home/u' }).OPENCLAW_STATE_DIR).toBe('/home/u/.openclaw')
})
```

- [ ] **Step 2:** `npx vitest run src/config/env.spec.ts src/engines/nativeLaunch.spec.ts` → FAIL (`/h/.openclaw` expected, the OS home's received; no refusal). Commit red: `OpenClaw: the default state folder follows OPENCLAW_HOME (red)`.
- [ ] **Step 3:** Implement. `openclawStore.ts`'s header says the default is `env.OPENCLAW_STATE_DIR`, OpenClaw's own resolution.
- [ ] **Step 4:** `npx vitest run src/config src/engines/nativeLaunch.spec.ts src/engines/nativeLaunchLocations.spec.ts src/engines/nativeLaunchCompatibility.golden.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts` → PASS. Commit: `OpenClaw: the default state folder follows OPENCLAW_HOME`.

### Task 6: The stream notices a store with no session

**Depends on:** Task 1.

**Files:**
- Modify: `cli/src/engines/openclaw/reader.ts`, `cli/src/engines/openclaw/live.ts`, `cli/src/core/agents/bind.ts`
  (the `openclawPaneRead` call and its `BindDeps` type only), `cli/src/core/main.ts` (the `openclawPaneRead` wiring)
- Test: `cli/src/engines/openclaw/live.spec.ts`, `cli/src/core/agents/bind.spec.ts`

**Interfaces:**
- Consumes: `OpenclawScreen.running`.
- Produces:
  - `OpenclawReader.keyFound: boolean`: whether the last read that reached the store found the key's node. `false`
    until one does, so also for a store that cannot be opened (the lamp: no agent database in the TUI's folder).
  - `OpenclawPaneReading.running: boolean`; `NO_SESSION_MS = 30_000` in `live.ts`.
  - `OpenclawLiveDeps.onSessionMissing?(): void` and `onSessionFound?(): void`. Decided in `paneRead`, before its
    turn checks: while `reading.running && !reader.keyFound` the time is counted from the first such pass; at
    `NO_SESSION_MS` `onSessionMissing` is said once. A pass that reads no run, or a found key, starts the count again;
    a found key after `onSessionMissing` says `onSessionFound` once. `Date.now()`, as `paneSeen` uses.
  - `BindDeps.openclawPaneRead(sessionId, reading: { ready: boolean; gatewayLost: boolean; running: boolean }, capture): boolean`:
    whether a stream took the reading (an agent bound but not yet attached has none). `main.ts` returns
    `!!normalizers.openclawReaders.get(sessionId)`. Task 8 uses the answer.

- [ ] **Step 1: Write the failing tests.** `live.spec.ts` (fake clock; stores as the spec builds them: the schema
  alone holds no node for the key):

| Test | Asserts |
|---|---|
| `a run in progress for 30 s with no session in the store is said once` | `paneRead({ ready: false, gatewayLost: false, running: true })` at 0 s and 29 s: `onSessionMissing` not called; at 30 s: called once; at 35 s: still once |
| `a store file that is not there counts as no session` | the same on a `db` path that does not exist |
| `connecting or ready with no session says nothing` | `running: false` passes over 60 s: never called |
| `a pass that reads no run starts the 30 s again` | running at 0 s, not at 20 s, running at 25 s and 50 s: not called; at 55 s: called |
| `a Gateway that is only slow writes the session within 30 s` | node written at 20 s, reader polled: at 30 s not called |
| `it clears once the store shows the session` | after `onSessionMissing`, the `plain` scenario written and one poll: the next `paneRead` calls `onSessionFound` once, and a later running pass does not call `onSessionMissing` |

`bind.spec.ts`: `tells the stream when the pane reads a run in progress`: a bound pane showing
`screen-abort-running.txt`: `openclawPaneRead` called with `{ ready: false, gatewayLost: false, running: true }`; with
`running •` replaced by `connecting •`: `running: false`. Existing `openclawPaneRead` expectations gain `running: false`.

- [ ] **Step 2:** `npx vitest run src/engines/openclaw/live.spec.ts src/core/agents/bind.spec.ts` → FAIL (`onSessionMissing` never called; `running` missing from the reading). Commit red: `OpenClaw: the store stream notices a run with no session in its store (red)`.
- [ ] **Step 3:** Implement the Interfaces. The header comment of `live.ts` gains the rule.
- [ ] **Step 4:** `npx vitest run src/engines/openclaw/live.spec.ts src/engines/openclaw/reader.spec.ts src/core/agents/bind.spec.ts src/core/transcripts/openclaw.spec.ts` → PASS. Commit: `OpenClaw: the store stream notices a run with no session in its store`.

### Task 7: The store hold on the agent

**Depends on:** Tasks 1, 6.

**Files:**
- Modify: `cli/src/core/transcripts/attach.ts`, `cli/src/engines/README.md` (OpenClaw notes: one line each for the
  typed first task and for a store that is the TUI's but not the Gateway's)
- Test: `cli/src/core/transcripts/openclaw.spec.ts`

**Interfaces:**
- Consumes: `OPENCLAW_STATES.noSessions`, `onSessionMissing`, `onSessionFound`.
- `OPENCLAW_STORE_HOLDS` gains `OPENCLAW_STATES.noSessions`. In the OpenClaw branch, `onSessionMissing` logs
  `[openclaw] <short agent id> <the state> · looked in <dirname(db)>` (`console.warn`, the local log) and calls
  `say(OPENCLAW_STATES.noSessions)`; `onSessionFound` calls `say(undefined)`. `say` already leaves another reason's
  hold alone. Logged each time the agent enters the state: once per attached stream.

- [ ] **Step 1: Write the failing tests** (beside `a store this OpenClaw cannot be read from is said on the agent…`, with its harness)

| Test | Asserts |
|---|---|
| `a pane working for 30 s on a store with no session says so on the agent, and clears once the session shows` | schema-only store, pane `agent:main:plain`, fake clock; the attached stream's `paneRead({ ready: false, gatewayLost: false, running: true })` at 0 s and 30 s: `setIdentityHold(agentId, OPENCLAW_STATES.noSessions)` and `announceSession`; `console.warn` once, containing `dirname(path)`; then the `plain` scenario written, 1.5 s on, one more `paneRead`: `setIdentityHold(agentId, undefined)` |
| `a store with no session never replaces or clears a state another reason said` | as the existing `unreadable store never replaces…` test, for this hold |

- [ ] **Step 2:** `npx vitest run src/core/transcripts/openclaw.spec.ts` → FAIL (`setIdentityHold` not called with the state). Commit red: `OpenClaw: an agent whose store holds no session says so (red)`.
- [ ] **Step 3:** Implement; add the two README lines.
- [ ] **Step 4:** `npx vitest run src/core/transcripts src/engines/openclaw` → PASS. Commit: `OpenClaw: an agent whose store holds no session says so`.

### Task 8: The handover

**Depends on:** Tasks 3, 6 (shares `bind.ts` with 6).

**Files:**
- Modify: `cli/src/core/agents/bind.ts`
- Test: `cli/src/core/agents/bind.spec.ts`

**Interfaces:**
- Consumes: `registry.takeFirstTask`, `registry.afterTransaction`, `openclawPaneRead`'s answer, `agent.firstTask`.
- `BindDeps.registry` adds `'takeFirstTask' | 'afterTransaction'`; `BindDeps.input` adds `'submit'`.
- In the OpenClaw branch of `bindObservedAgent`, after the screen holds are settled and before the key is compared:
  when the stream took the reading, `agent.firstTask` is set, `screen.state === 'ready'` and
  `screen.key === agent.sessionId`, hand it over. The order is the whole point:

```ts
void registry.afterTransaction(() => registry.takeFirstTask(agent.agentId)).then((taken) => {
  if (!taken) return
  console.log(`[agent] ${sid(agent.agentId)} first task handed over`)
  input.submit(taken.sessionId, taken.task)   // no delivery id: the person's own message
}, (error) => console.error(`[agent] ${sid(agent.agentId)} first task kept · ${error instanceof Error ? error.message : String(error)}`))
```

  The reconcile pass runs inside `registry.transaction` (`core/main.ts`), which holds saves back: `afterTransaction`
  is what makes the removal durable before the typing. No poll, no timer, no timeout.

- [ ] **Step 1: Write the failing tests** (the OpenClaw describe; `setup` gains `registry.afterTransaction: vi.fn(async (run) => run())`,
  `registry.takeFirstTask: vi.fn()`, `input.submit: vi.fn()`; a bound pane is `pane({ sessionId: 'agent:main:plain', firstTask: 'Fix the parser' })` showing `screen-plain`, with `openclawPaneRead: vi.fn(() => true)`)

| Test | Asserts |
|---|---|
| `a first task is handed over on the first pass that reads the pane ready` | `takeFirstTask` returns `{ sessionId: 'agent:main:plain', task: 'Fix the parser' }`: `input.submit.mock.calls` equals `[['agent:main:plain', 'Fix the parser']]`; `afterTransaction` was called; `takeFirstTask` ran before `submit` (`invocationCallOrder`); a log line reads `first task handed over`; no `console.log`/`console.error` argument contains `Fix the parser` |
| `not while the pane reads no Gateway or a run, before a stream is attached, or unbound` | for `screen-no-gateway`, `screen-abort-running`, `openclawPaneRead: () => false`, and `sessionId: ''`: `takeFirstTask` not called |
| `ready, busy, ready hands it over once` | three passes over the same row; `takeFirstTask` returns the task, then `null`: `submit` called once |
| `a row whose task was handed over before a restart types nothing` | a row with no `firstTask`: `afterTransaction` not called |
| `a registry that cannot save keeps the task and types nothing` | `takeFirstTask` throws: `submit` not called, `console.error` reads `first task kept` |
| `the removal waits for the reconcile pass to commit` | `afterTransaction` held open: `submit` not called until it is released |
| `a pane that moved to another key binds first` | the screen shows another key than `agent.sessionId`: `takeFirstTask` not called on that pass, and the key is registered |

- [ ] **Step 2:** `npx vitest run src/core/agents/bind.spec.ts` → FAIL (`submit` never called). Commit red: `OpenClaw: the bind pass hands the first task to the session input once the pane reads ready (red)`.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run src/core/agents/bind.spec.ts` → PASS. Commit: `OpenClaw: the bind pass hands the first task to the session input once the pane reads ready`.

### Task 9: Launches keep the task

**Depends on:** Tasks 3, 4.

**Files:**
- Modify: `cli/src/lib/createAgentPane.ts`, `cli/src/core/agents/create.ts`, `cli/src/core/agents/fork.ts`,
  `cli/src/lib/restoreAgents.ts`, `cli/src/core/main.ts` (the restore launch only)
- Test: `cli/src/lib/createAgentPane.spec.ts`, `cli/src/core/agents/create.spec.ts`, `cli/src/core/agents/fork.spec.ts`,
  `cli/src/lib/restoreAgents.spec.ts`

**Interfaces:**
- Consumes: `typedFirstPrompt`, `openPendingAgent({ firstTask })`, `beginExternalDispatch(agentId, firstTask?)`.
- `CreateAgentPaneDeps.firstTask?: string`, handed to `registry.openPendingAgent` when set.
- `create.ts` and `fork.ts` pass `firstTask: typedFirstPrompt(engine, firstPrompt)` to `createAndRegisterPane` when it
  is defined (New, `harness new`, a Swarm launch, and a handoff fork, which OpenClaw already takes). `launchOptions`
  keeps `firstPrompt`.
- `RestoreLaunch.firstTask?: string`. In `main.ts`'s restore launch, the `continue` it decides today is named once
  (`const firstPrompt = … ? 'continue' : undefined`), given to `buildEngineLaunchArgv` as now, and returned as
  `firstTask: typedFirstPrompt(entry.engine, firstPrompt)` when defined. `restoreAgents.ts` commits it with the
  dispatch: `deps.registry.beginExternalDispatch?.(entry.agentId, launch.firstTask)`; its deps type takes the argument.

- [ ] **Step 1: Write the failing tests**

| Spec | Test | Asserts |
|---|---|---|
| `createAgentPane.spec.ts` | `a first task goes onto the row the pane is registered as` | `openPendingAgent` called with `objectContaining({ firstTask: 'Fix the parser' })`; without the dep, its argument has no `firstTask` key |
| `create.spec.ts` | `an OpenClaw first task is kept for typing, not launched with` | `create(request({ engine: 'openclaw', prompt: 'Fix the parser' }))`: the pane's `firstTask === 'Fix the parser'`, and its `argv` contains neither `Fix the parser` nor `--message` |
| `create.spec.ts` | `a Swarm launch takes the same path` | the same with `swarmRole: 'agent'` |
| `create.spec.ts` | `an engine that takes its first prompt in argv keeps none` | `engine: 'claude'`: the pane has no `firstTask`; its `argv` holds the prompt |
| `fork.spec.ts` | `a fork of an OpenClaw agent keeps its handoff for typing` | source `engine: 'openclaw'`, `prompt: 'next'`: the pane's `firstTask` is a string containing `next`; no `argv` element contains it |
| `restoreAgents.spec.ts` | `an external resume that continues commits its first task with the dispatch` | a launch built with `firstTask: 'continue'` on an admitted row: `beginExternalDispatch` called with `(agentId, 'continue')`; a launch without it: `(agentId, undefined)` |

- [ ] **Step 2:** `npx vitest run src/lib/createAgentPane.spec.ts src/core/agents/create.spec.ts src/core/agents/fork.spec.ts src/lib/restoreAgents.spec.ts` → FAIL (`firstTask` undefined on the pane). Commit red: `OpenClaw: every launch that carries a first task keeps it on the agent's row (red)`.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** the same specs, plus `src/core/agents/restoreLaunch.spec.ts src/core/agents/launches.spec.ts` → PASS. Commit: `OpenClaw: every launch that carries a first task keeps it on the agent's row`.

### Task 10: A relaunched TUI's state folder

**Depends on:** Task 8 (shares `bind.ts`).

Why it is here: the state tells the person to restart the agent, and the spec's end-to-end check expects that to
clear it. Today the folder is read only when a session is first bound (`bind.ts`, after `bound.isNew`), the row's
saved folder wins in `openclawSessionDb`, and a restart resumes the same key, so the pass returns at
`key === agent.sessionId`: a restarted TUI in the right folder would still be read from the old one.

**Files:**
- Modify: `cli/src/core/agents/bind.ts`
- Test: `cli/src/core/agents/bind.spec.ts`

**Interfaces:**
- `createBinding` remembers, per agent, the TUI process whose folder it read (`pid:startMarker`; a `Map` cleared when
  it reaches 256 entries, which costs one more read per agent). The read after a new binding records it too.
- In the OpenClaw branch, for a bound agent whose pane shows its own key and whose process is not the remembered one:
  `openclawStateDir(pid)` once; when it answers a folder and `registry.setOpenclawStateDir(agentId, folder)` returns
  `true` (it changed): log `[discovery] <short id> openclaw · state folder changed`, call
  `forgetSession(agent.sessionId, { force: true, keepAgent: true })` and return. The next pass binds the key again from
  the footer and attaches its stream on the saved folder. Before the handover of Task 8, so a task is typed only
  into a session Harness reads. A pending `firstTask` stays on the row (Task 3: a bind keeps it).

- [ ] **Step 1: Write the failing tests**

| Test | Asserts |
|---|---|
| `a relaunched TUI that holds another state folder: the row takes it and the session is read again` | bound row, `openclawStateDir` resolves `/new`, `setOpenclawStateDir` returns `true`: called with `('a1', '/new')`; `forgetSession` called with `(sessionId, { force: true, keepAgent: true })`; no handover on that pass |
| `the folder is read once per TUI process` | two passes with one `processIdentity`: `openclawStateDir` called once; a third with another `startMarker`: twice |
| `the same folder, or open files that cannot be read, change nothing` | `setOpenclawStateDir` returns `false`, then `openclawStateDir` resolves `null`: `forgetSession` not called |

- [ ] **Step 2:** `npx vitest run src/core/agents/bind.spec.ts` → FAIL (`setOpenclawStateDir` not called for a bound agent). Commit red: `OpenClaw: a relaunched TUI's state folder replaces the one its agent kept (red)`.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run src/core/agents/bind.spec.ts src/core/transcripts/openclaw.spec.ts` → PASS. Commit: `OpenClaw: a relaunched TUI's state folder replaces the one its agent kept`.

### Task 11: Gates

**Depends on:** Tasks 1 to 10. **Files:** none (fixes go back to the task that owns the file).

- [ ] `npm run typecheck` → no errors.
- [ ] `npx vitest run src/architecture.spec.ts src/leanEntry.spec.ts src/asciiOnly.spec.ts` → PASS.
- [ ] `npx vitest run src/engines/openclaw src/engines/nativeLaunch.spec.ts src/core/agents src/core/transcripts src/config src/lib/registry.firstTask.spec.ts src/lib/registry.externalResume.spec.ts src/lib/sessionInput.spec.ts src/lib/engineLaunch.spec.ts src/lib/createAgentPane.spec.ts src/lib/restoreAgents.spec.ts` → PASS.
- [ ] `npm run test:core` → 100% per file; record the result for the pull request (PR CI does not run it).
- [ ] `grep -rn -- "--message" cli/src --include='*.ts'` → no OpenClaw launch line left.

### Task 12: End to end, on this Mac

**Depends on:** Tasks 1 to 10. **Files:** none in the repository; everything lives under one scratch folder.

OpenClaw 2026.11.2 is installed at `/opt/homebrew/lib/node_modules/openclaw` (`/opt/homebrew/bin/openclaw`).

**Never:** touch the real `~/.harness`, the live daemon (ports 18473 and 51793), its LaunchAgent or Harness.app's
data; `pkill` or `killall` by name (stop only the PIDs this task started); change `~/.openclaw` (read it to copy;
never write it, never print a copy's contents).

**The isolated daemon** follows the repo's recipe: `docs/development.md` ("Isolated end-to-end testing") and the
environment `cli/e2e/harness/daemon.ts` builds for `IsolatedDaemon` (throwaway `HOME` and `ZDOTDIR`, its own `PORT`,
`ADAPTER_DATA_DIR`, `ADAPTER_RUNTIME_DIR`, `ADAPTER_COMPUTER_ID_FILE`, `HARNESS_AUTH_DIR`, `HARNESS_HOOK_ROUTES_DIR`
under that home, `BACKEND_WS_URL=ws://127.0.0.1:9`, `WEB_URL=http://127.0.0.1:9`, `DISABLE_HOOK_INSTALL=true`,
`ADAPTER_UPDATE_DISABLE=true`, `ANALYTICS_ENABLED=false`, `CABLE_DISABLE=true`, `CABLE_FW_DISABLE=true`,
`TERMINAL_BACKENDS=tmux`, a private tmux server as `src/testing/isolatedTmux.ts` makes one: `TMUX_TMPDIR` in the
scratch folder, `TMUX` and `TMUX_PANE` unset). `PATH` starts with the Node 24 folder above, then `/opt/homebrew/bin`.
Started from `cli/` as the harness starts it (`npx tsx src/cli.ts start -f`), the `harness` commands run with the same
environment (`npx tsx src/cli.ts new openclaw -- …`).

- [ ] **Step 1: Before.** Note the PIDs listening on 18473 and 51793 and on the person's Gateway port, if any
  (`lsof -nP -iTCP:<port> -sTCP:LISTEN`). Make the scratch root with `home/`, `data/`, `tmux/`, `claw/`, `gw/`.
- [ ] **Step 2: A Gateway of its own.** Copy from `~/.openclaw` into `claw/` only what a Gateway and a TUI need to
  run (its `openclaw.json` and the model credentials it names); in the copy, give the Gateway a free port. Check
  `openclaw gateway --help` for the flags; do not start it yet.
- [ ] **Step 3: The first task, with the Gateway late.** Start the daemon with `OPENCLAW_STATE_DIR=<root>/claw`.
  `harness new openclaw -- "Reply with exactly: first-task-ok"`. Expect: the harness is created; it says
  `OpenClaw Gateway is not running. Start it with openclaw gateway.`; the daemon log has `first task kept`; the row in
  `data/registry.json` has `firstTask`; the pane shows nothing typed. 60 s later start the Gateway
  (`OPENCLAW_STATE_DIR=<root>/claw`), noting its PID. Expect within a few passes: the log has `first task handed over`;
  the row has no `firstTask`; the pane shows the task once and `first-task-ok` answered; the agent's turn shows
  (`harness` history or its frame), with no "did not accept" error. Stop and start the daemon: nothing is typed again.
- [ ] **Step 4: A store that is not the Gateway's.** Stop the daemon and that Gateway (their PIDs). Start a Gateway
  with `OPENCLAW_STATE_DIR=<root>/gw` (the same copied config and port), and the daemon **without**
  `OPENCLAW_STATE_DIR`, its home's `.openclaw/openclaw.json` a copy that reaches that Gateway. `harness new openclaw --
  "Run sleep 45 in the shell, then reply done"`. Expect, 30 s into the run: the agent says exactly
  `Harness cannot find this OpenClaw's sessions. Start Harness with the Gateway's OPENCLAW_STATE_DIR, then restart this agent.`;
  the log names `<root>/home/.openclaw/agents/main/agent` once. (The message itself ends "did not accept" at 30 s
  here: Harness reads a store that never gets its row. Note it; the spec does not cover it.)
- [ ] **Step 5: The remedy.** Stop the daemon; start it with `OPENCLAW_STATE_DIR=<root>/gw`; restart the agent. Expect:
  the state goes; the turn shows; a new message is confirmed.
- [ ] **Step 6: After.** Stop only the PIDs started (daemon, Gateways) and the private tmux server by its socket;
  remove the scratch root, the copied credentials with it. Confirm the listeners on 18473 and 51793 are the PIDs
  noted in Step 1, and that `~/.openclaw/openclaw.json` is unchanged (`shasum` before and after).
- [ ] **Step 7: Evidence** for the pull request: the log lines (no task text beyond this test's own), the pane
  captures, the registry row before and after, the platforms run (macOS here; Linux and Windows by the unit specs).

## Self-review

- **Spec coverage.** First task: Tasks 2, 3, 4, 8, 9 (New, `harness new`, Swarm, fork, restore's `continue`). Store
  hold: Tasks 1, 6, 7, 10. Default folder and the TUI's environment: Tasks 1, 4, 5. Spec tests: each has its named
  test above; the end-to-end check is Task 12.
- **Beyond the spec, and why:** Task 10 (the restart the state asks for must change what Harness reads);
  `OPENCLAW_HOME` in `LAUNCH_LOCATION_VARIABLES` (else `ENGINE_LOCATIONS` never sees it); the handover also waits for
  an attached stream, the pane's key and the pass's commit (Review Focus 1, 2, 5).
- **Left as the spec has it:** a run shorter than 30 s never raises the store hold; with a wrong store a message ends
  "did not accept" although OpenClaw took it; a `~` in `OPENCLAW_HOME` or `OPENCLAW_STATE_DIR` as the launch shell
  reports it holds a native launch, as every location variable that is not absolute does today.
