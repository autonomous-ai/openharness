# A close says none was kept when none was, and the fake Codex's help reads as a probe: Implementation Plan

> **For agentic workers:** REQUIRED: execute with **diegodev phase 3**. Four tasks. Tasks 1, 2 and 3 share no file and
> depend on nothing: they can run at once. Task 4 waits for Task 1. Tasks 1 to 3 are test-first: a red commit, then the
> code commit. Task 4 is one commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A close that stops a harness whose saved record holds no conversation a resume could bring back answers
`{ closed: true, withoutConversation: true }`, so `harness close` and the cleanup's log line say "It had not started a
conversation, so none was kept." And the fake Codex's `--help` child is read by discovery as a probe from its first
instant, as the real one is, with both end-to-end rows holding that probe open 400 ms so the race runs on every run.

**Architecture:** The daemon change only reports. `CloseAgentService.attempt` (`cli/src/lib/closeAgentService.ts`, in
the core's process) wraps the `checkpoint` it hands the stop: on phase `'before'` it reads the record the stop saved
and sets the flag it already keeps for "closed without a conversation". What a close stops, saves or waits for does not
change. The cleanup (`cli/src/services/agentCleanup.ts`, in the edge host) picks the last sentence of its log line by
the field the core already forwards whole. The fixture (`cli/e2e/harness/fakeEngine.mjs`) starts a probe's child under
Node's own name and gains `helpDelayMs`; the two rows of `cli/e2e/agentClient.e2e.ts` pass `helpDelayMs: 400`.

**Tech Stack:** TypeScript and one `.mjs` fixture, Node 22.15 or later (rehearsed on v22.23.5, arm64), Vitest 4.1.10;
tmux and `/bin/zsh` for the end-to-end rows. No new dependency.

**Spec:** [docs/plans/2026-11-16-codex-help-race-design.md](2026-11-16-codex-help-race-design.md). Read it with this
plan, the root `AGENTS.md` and `cli/AGENTS.md`. The spec is the authority; the decisions in it (option B, the probe
child under Node's own name, `helpDelayMs` for both fake engines, the cleanup's log line, the listed specs updated to
the true answer) are made and are not reopened here.

## Decisions

1. **Devin** (PM, 2026-11-16): Devin resumes by id (`LAUNCH_RESUME_FLAG.devin`), so it follows the rule like
   Claude Code and Codex; the `fresh` row is `omp`. The spec says so.

Not a question: the CLI end to end does not run on pull requests ("Found", below). Verification 4 runs it once by hand.

## Global Constraints

- Option B, verbatim from the spec: "a close reports the truth, and its behavior does not change." No waiting, no
  refusal, no change to what is stopped or saved. Not touched: `lib/processTable.ts` (discovery),
  `lib/captureResumeIdentity.ts`, `lib/stopAgentService.ts`, `whileStarting` in `closeAgentService.ts`, and
  `agentClient/commands.ts` (its wording and its code).
- The rule, verbatim: `resumeMode(engine) === 'conversation' && !sessionId`, on the record the stop passes to
  `checkpoint(s, 'before')`. A close that saved no record keeps `{ closed: true }`.
- The two sentences, verbatim: `It had not started a conversation, so none was kept.` and `Its conversation is kept.`
- A probe is exactly one argument: `--help`, `-h`, `--version` or `-V` (what `engineCapabilityProbe` skips), not
  `run`'s wider `args.includes('--help')`. The engine run keeps `argv0: 'codex'`.
- `helpDelayMs` is read in `run`'s help branch for both fake engines. The end-to-end rows use `400`.
- The core gains no file, import, rule or record: `cli/src/architecture.coreFiles.txt` stays as it is.
- No fixed sleeps in a new test. A test uses throwaway folders only: never `~/.codex`, `~/.claude`, the daemon on port
  18473 or the developer's tmux server.
- Comments say why, in plain sentences, and name the incident: CLI end to end run 43746252131, shard 4, and the spec.
- A task runs only the commands it names. No full local suite: PR CI runs it.
- A commit adds its files by name. The two documents under `docs/plans/` are untracked and are no task's.
- Platforms: macOS and Linux (the fixture and discovery; Windows has no launch-script probe). The close's answer is
  the same on every platform. One pull request; its body names the platforms and carries each task's red and green
  output, the receipt and the run link from Verification.

## Found while reading the code

Checked at `8fcfa7de5c` on an Apple Silicon Mac (Node v22.23.5 arm64, tmux 3.6b). Every change below was rehearsed
there and put back; the numbers are from those runs.

- **Devin is not `fresh`.** `resumeMode` over every engine: `omp` is `fresh`, `terminal` is `shell`, the other fifteen
  are `conversation`, Devin among them. The comment in `lib/resumeCapability.ts` ("today: `devin`") is older than
  Devin's `--resume`. Open question 1.
- **The CLI end to end is not PR CI.** `.github/workflows/cli-e2e.yml` runs on `schedule` (nightly) and
  `workflow_dispatch` only: "ADVISORY until it has stayed green, and so it does not run on pull requests". Run
  43746252131 was started by hand on `fix/e2e-isolation-2`; its `e2e (4)` failed. Eight Linux shards, one macOS job and
  a summary: ten jobs, 25 minutes. The duration sequencer picks the shard for `agentClient.e2e.ts`, which has no hint.
- **Task 1's red needs `helpDelayMs` in the same commit.** Without it the fake's help ends in a few milliseconds: the
  codex rows fail on a timeout (`expected [] to have a length of 2`) and the claude row passes by luck. With it:
  `expected [ false, true ] to deeply equal [ false, false ]`, which is the bug.
- **The row on main.** `ps` shows the fake's help child as `codex <...>/fakeEngine.mjs --help`. Its entrypoint is
  `codex`, the next token is the script, so `engineCapabilityProbe` says no and it scores 3 by name. Started without
  `argv0` it is `<node> <...>/fakeEngine.mjs --help`: an interpreter, its script, the probe. The wrapper,
  `<node> <root>/bin/codex --help`, was a probe already. The fake sets `process.title` only after its probe branches
  (`fakeEngine.mjs:253`), so `ps` shows a probe's real argv.
- **The shim helper exists.** `fakeEngineShim` (`cli/e2e/harness/daemon.ts:262`) writes the text the spec describes;
  `src/testing/fakeCodexAppServer.spec.ts` loads it untyped. The new spec does the same: one way to write a shim.
- **The five lines the spec lists are the only ones that move.** With Task 2's code in:
  `closeAgentService.spec.ts:395` (two rows) and `:736`, `unusedCodexClose.spec.ts:76` (two rows), `:111`, and `:149`,
  which runs only with `RUN_REAL_TMUX_DISCOVERY=1`: seven cases. The other specs that close through the real service keep
  `{ closed: true }`: their records have a `sessionId` or are a terminal's.
- **The flag is there.** `attempt` has `let unkept = false`, set by the `withoutConversation` callback and read only
  after the stop is confirmed (line 350). The `checkpoint` wrapper sets the same flag: one answer, one variable.
- **The field reaches the cleanup.** `core/agentCleanupLink.ts:58` answers `{ ...result }` whole. Nothing outside
  `cli/src` reads `withoutConversation`; the windows' Close reads nothing from it. Every `agent_close` expectation in
  `cli/e2e` is a `toMatchObject`.
- **The end-to-end rows need Task 1 only.** With Tasks 1 and 4 alone both rows pass, and with all four tasks too. With
  the help delayed and the wrapper unchanged, one row fails either way: on main the "never binds" row (3 of 3, the
  spec); with Task 2 in, the "binds a few seconds in" row
  (`Received: "pong on studio: closed. It had not started a conversation, so none was kept."`).
- **Gates.** `python3 scripts/local-checks.py --list` on this plan's eight files names one check, `cli-core`
  (`npm run test:core`), selected by `cli/src/services/*`. `closeAgentService.ts` selects none; `test:core` still runs
  the core specs that import it. `src/architecture.spec.ts` (in PR CI's `cli-tests`) holds the core to the files in
  `architecture.coreFiles.txt`, where `lib/closeAgentService.ts` is line 318: no import is added, so no line changes.
- **Measured.** `npm run typecheck` 29 s. `npm run test:core` 66 to 68 s, `Test Files  251 passed (251)`,
  `Tests  4561 passed (4561)`, every coverage figure 100%, with Task 3 alone and with all four tasks. The two
  end-to-end rows 30 s, green 3 of 3.

## File map

| File | Change | Task |
| --- | --- | --- |
| `cli/src/testing/fakeEngineHelpProbe.spec.ts` | new: four rows, the fake's help as discovery reads it | 1 |
| `cli/e2e/harness/fakeEngine.mjs` | `helpDelayMs`; a probe's child without `argv0`; two comments | 1 |
| `cli/src/lib/closeAgentService.spec.ts` | one new `describe` (nine cases); two expectations changed | 2 |
| `cli/src/lib/unusedCodexClose.spec.ts` | three expectations changed | 2 |
| `cli/src/lib/closeAgentService.ts` | the `checkpoint` wrapper in `attempt`; the `AgentCloseResult` comment | 2 |
| `cli/src/services/agentCleanup.spec.ts` | one new case | 3 |
| `cli/src/services/agentCleanup.ts` | the last sentence of `close`'s log line; the header comment | 3 |
| `cli/e2e/agentClient.e2e.ts` | `helpDelayMs: 400` in the two rows' config (line 399) | 4 |

## Review Focus

The cases the spec implies and names no test for, most likely first. Each has its test in the task that owns the code.

- A conversation Harness reads only while saving (the row had none, the saved record has one) must be said kept: "none
  was kept" there tells a person their work is gone when it is not. Task 2, "the record the stop saved decides".
- A stop that fails after it saved its record answers its error, with no word about the conversation, and the harness
  stays. Task 2, "a stop that failed after it saved".
- A close that saved no record (an adoption cancelled, a row already gone, a stop already running) keeps
  `{ closed: true }`. Task 2, "a stop that saved no record".
- A help that is not alone on the command line (`codex -c x=1 --help`) is no probe to discovery, so the fake's child
  keeps the name `codex`, as an engine run does: the rollout reader needs that name. Task 1, the fourth row; `-h`
  alone is the third.
- A close past the ceiling carries its count beside the new field, and a cleanup on a core that says nothing of the
  conversation keeps "Its conversation is kept." Task 2, "a close once idle"; Task 3, the second line of its case.

Not exercised, and said in the pull request: `--version` and `-V` (the fake answers them at once, with no delay to
hold them open; they share the one set with `--help`), and Windows.

---

### Task 1: The fake Codex's help child reads as a probe, and `helpDelayMs`

**Depends on:** nothing. **Effort:** high.

**Files:**
- Modify: `cli/e2e/harness/fakeEngine.mjs` (the header's config paragraph, lines 52-65; `codexWrapper`, lines 125-137;
  the help branch, line 180)
- Create (test): `cli/src/testing/fakeEngineHelpProbe.spec.ts`

**The test that fails before the change:** `the fake engines' help, held open › codex ["--help"]: …` and its
`codex ["-h"]` row, in `cli/src/testing/fakeEngineHelpProbe.spec.ts`.

**Interfaces:** produces the fake config key `helpDelayMs` (milliseconds, a number): `run(engine, config)` waits that
long in its help branch (`--help` or `-h`, both engines) before it prints; absent or `0`, it does not wait. Task 4
passes `helpDelayMs: 400`.

- [ ] **Step 1: Give the fake `helpDelayMs`**

In `fakeEngine.mjs`, first statement of `run`'s help branch (`if (args.includes('--help') || args.includes('-h'))`):
when `config.helpDelayMs` is set, await a `setTimeout` of that long, not unref'd, so the process stays. Its comment
says why: a slow first run of a fresh Codex holds the launch script's probe open (2.9 s measured,
`engines/kit/launchStartup.ts` `ownedFlagProbe`), and a test holds it open the same way. Add one sentence for
`helpDelayMs` to the header paragraph that lists `startDelayMs` and `unreadableDescriptorMs`.

This goes in the red commit: without it the probe is gone before any test can read it (see "Found").

- [ ] **Step 2: Write the failing test**

Create `cli/src/testing/fakeEngineHelpProbe.spec.ts`:

```ts
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentCommandOwnershipSnapshot } from '../lib/engineBin.js'
import { engineProcessMatch, readProcessRows, type ProcessRow } from '../lib/processTable.js'

// The end-to-end harness is outside tsconfig's rootDir (src), so it is loaded untyped, as fakeCodexAppServer.spec.ts
// loads it.
const { fakeEngineShim } = await import('../../e2e/harness/daemon.js' as string) as {
  fakeEngineShim: (name: 'claude' | 'codex', config: Record<string, unknown>) => string
}

// No engine's file is known here: a row is judged by what `ps` prints of it alone, never by an engine this machine has.
const NO_OWNERS: AgentCommandOwnershipSnapshot = {
  cursorFileKeys: new Set(), grokFileKeys: new Set(), conflictingFileKeys: new Set(), agentCandidates: [], cursorAgentCandidates: [], grokCandidates: [],
}

let root = ''
let started: ChildProcess | undefined

afterEach(() => {
  try { if (started?.pid) process.kill(-started.pid, 'SIGKILL') } catch { /* already gone */ }
  started = undefined
  rmSync(root, { recursive: true, force: true })
})

/** [pid]'s row and every row under it, parents first. */
function tree(rows: readonly ProcessRow[], pid: number): ProcessRow[] {
  const found = rows.filter((row) => row.pid === pid)
  for (let at = 0; at < found.length; at++) found.push(...rows.filter((row) => row.parentPid === found[at].pid))
  return found
}

// The launch script asks the engine's help before each run (engines/kit/launchStartup.ts `ownedFlagProbe`), and
// discovery skips that probe (lib/processTable.ts `engineCapabilityProbe`). The fake Codex's help child was named
// `codex` with the script after it, so discovery recorded it as the engine for as long as it ran, and a close a second
// later said "Its conversation is kept" of a Codex that never bound one (CLI end to end run 43746252131, shard 4;
// docs/plans/2026-11-16-codex-help-race-design.md). Codex 0.167.0's own two probe processes are both skipped.
describe('the fake engines\' help, held open', () => {
  it.each([
    ['claude', ['--help'], [false]],
    ['codex', ['--help'], [false, false]],
    ['codex', ['-h'], [false, false]],
    // Not alone on the command line, so no probe to discovery: the child keeps the engine's name, as an engine run does.
    ['codex', ['-c', 'x=1', '--help'], [true, true]],
  ] as const)('%s %j: which of its processes discovery takes for the engine is %j', async (engine, args, engineHere) => {
    root = mkdtempSync(join(tmpdir(), 'fake-help-probe-'))
    mkdirSync(join(root, 'bin'))
    const bin = join(root, 'bin', engine)
    // Held far longer than the test reads it for: afterEach ends it, and it ends by itself if that fails.
    writeFileSync(bin, fakeEngineShim(engine, {
      port: 1, dataDir: join(root, 'data'), claudeProjectsDir: join(root, 'claude'), codexHome: join(root, 'codex'), root, hookLog: join(root, 'hooks.log'),
      helpDelayMs: 60_000,
    }), { mode: 0o755 })
    const help = spawn(bin, [...args], { stdio: 'ignore', detached: true })
    started = help
    const rows = await vi.waitFor(async () => {
      const mine = tree(await readProcessRows() ?? [], help.pid!)
      expect(mine).toHaveLength(engineHere.length)
      return mine
    }, { timeout: 20_000, interval: 100 })
    expect(rows.map((row) => engineProcessMatch(row, engine, NO_OWNERS).score > 0)).toEqual(engineHere)
  }, 30_000)
})
```

The claude row and the last codex row pass before the change too: they hold what must not change.

- [ ] **Step 3: Run it and see it fail**

Run: `cd cli && npx vitest run src/testing/fakeEngineHelpProbe.spec.ts`
Expected: `Tests  2 failed | 2 passed (4)`, both failures:

```
AssertionError: expected [ false, true ] to deeply equal [ false, false ]
```

A failure that says `expected [] to have a length of 2` means Step 1 is missing. Keep the output for the pull request.

- [ ] **Step 4: Commit the red test**

```bash
git add cli/src/testing/fakeEngineHelpProbe.spec.ts cli/e2e/harness/fakeEngine.mjs
git commit -m "CLI tests: a spec for the fake engines' help as discovery reads it, and helpDelayMs to hold it open (red)"
```

- [ ] **Step 5: Start a probe's child under Node's own name**

In `codexWrapper`: read the arguments once (`process.argv.slice(2)`). When they are a probe (exactly one argument, and
it is `--help`, `-h`, `--version` or `-V`), spawn the child without `argv0`; otherwise with `argv0: 'codex'` as today.
Everything else in the wrapper stays. Keep the existing comment on `argv0` and add why a probe differs, naming the
incident: the real Codex 0.167.0's native probe child is `<vendor>/codex --help`, which discovery skips; the fake's
was `codex <script> --help`, which it recorded as the engine until it exited (CLI end to end run 43746252131, shard 4;
`docs/plans/2026-11-16-codex-help-race-design.md`).

- [ ] **Step 6: Run the fixture's specs**

Run: `cd cli && npx vitest run src/testing/fakeEngineHelpProbe.spec.ts src/testing/fakeCodexAppServer.spec.ts`
Expected: `Test Files  2 passed (2)`, `Tests  6 passed (6)`, in about 3 s.

Run: `ps -A -o pid=,command= | grep fake-help-probe | grep -v grep`
Expected: nothing (the spec ended what it started).

Run: `cd cli && npm run typecheck`
Expected: no error (about 30 s): `tsc` reads the new spec.

- [ ] **Step 7: Commit**

```bash
git add cli/e2e/harness/fakeEngine.mjs
git commit -m "CLI tests: the fake Codex's help child is a probe to discovery, as the real one is"
```

Report both commits, and the Step 3 (red) and Step 6 (green) outputs with the commit each ran on.

---

### Task 2: A close says none was kept when the record it saved holds no conversation

**Depends on:** nothing. **Effort:** high (the core's process; a report only).

**Files:**
- Modify: `cli/src/lib/closeAgentService.ts` (the `AgentCloseResult` comment, lines 22-23; `attempt`'s `checkpoint`
  option, line 327)
- Test: `cli/src/lib/closeAgentService.spec.ts`, `cli/src/lib/unusedCodexClose.spec.ts`

**The test that fails before the change:** `what a close says of the conversation it kept › a codex whose saved
record holds no conversation: none was kept`, in `cli/src/lib/closeAgentService.spec.ts`.

**Interfaces:** produces no new name. `AgentCloseResult.withoutConversation?: true` is set in one more case: the
record passed to `checkpoint(s, 'before')` has `resumeMode(s.engine) === 'conversation'` and no `sessionId`.

- [ ] **Step 1: Write the failing tests, and move the five listed expectations to the truth**

In `cli/src/lib/closeAgentService.spec.ts`, above `describe('background commands', …)`:

```ts
// A close said "Its conversation is kept" of a Codex that never bound one: the process discovery had recorded for it had
// gone (the launch script's help probe; a first run the script ran again), so the stop saved a record with no
// conversation and went ahead (CLI end to end run 43746252131; docs/plans/2026-11-16-codex-help-race-design.md).
describe('what a close says of the conversation it kept', () => {
  /** A stop that saves [saved] over the row, as stopAgentService.ts saves its record before it signals anything. */
  const stopSaving = (saved: Partial<RegisteredSession> = {}) => vi.mocked(deps.stop).mockImplementation(async (id, options) => {
    await options.checkpoint!({ ...row, ...saved }, 'before')
    registry.removeAgent(id)
  })
  beforeEach(() => { Object.assign(row, { sessionId: '', transcriptPath: null }) })

  it.each(['codex', 'claude', 'devin'] as const)('a %s whose saved record holds no conversation: none was kept', async engine => {
    row.engine = engine
    stopSaving()
    expect(await service.request(request('now'))).toEqual({ closed: true, withoutConversation: true })
    expect(registry.byAgent(row.agentId)).toBeUndefined()
  })
  it('the record the stop saved decides, not the row: a conversation read while saving is kept', async () => {
    stopSaving({ sessionId: 'read-while-saving' })
    expect(await service.request(request('now'))).toEqual({ closed: true })
  })
  it.each(['terminal', 'omp'] as const)('a %s has no conversation id to lose: answered as before', async engine => {
    row.engine = engine
    stopSaving()
    expect(await service.request(request('now'))).toEqual({ closed: true })
  })
  it('a stop that saved no record says nothing of one: an adoption cancelled, a row already gone, a stop already running', async () => {
    vi.mocked(deps.stop).mockImplementation(async id => { registry.removeAgent(id) })
    expect(await service.request(request('now'))).toEqual({ closed: true })
  })
  it('a close once idle, past the ceiling, says it beside its count', async () => {
    stopSaving()
    const counted = new CloseAgentService({ ...deps, backgroundCommands: async () => 2 })
    expect(await counted.request({ ...request('idle'), background: 'count' })).toEqual({ closed: true, withoutConversation: true, backgroundCommands: 2 })
    counted.dispose()
  })
  it('a stop that failed after it saved answers its error, and nothing of the conversation', async () => {
    vi.mocked(deps.stop).mockImplementation(async (_id, options) => {
      await options.checkpoint!({ ...row }, 'before')
      throw Object.assign(new Error('Could not confirm that the harness stopped.'), { code: 'STOP_UNCONFIRMED' })
    })
    expect(await service.request(request('now'))).toEqual({ error: 'STOP_UNCONFIRMED', detail: 'Could not confirm that the harness stopped.' })
    expect(registry.byAgent(row.agentId)).toBe(row)
  })
})
```

Open question 1 moves two lines here and nothing else: if Devin keeps today's answer, `'devin'` goes from the first
`it.each` to the "answered as before" one, and Step 4's condition changes as Diego says.

Then change `toEqual({ closed: true })` to `toEqual({ closed: true, withoutConversation: true })` on these five lines
and no other (each closes a Claude Code or Codex whose saved record has no `sessionId`):

| File | Line | Case |
| --- | --- | --- |
| `closeAgentService.spec.ts` | 395 | `closes an unused %s chat only after saving its screen` (the `idle` close; both rows) |
| `closeAgentService.spec.ts` | 736 | `waits on a real timer when no sleep is given` |
| `unusedCodexClose.spec.ts` | 76 | `closes an unused companion with a shared Codex server …` (`mode`; both rows) |
| `unusedCodexClose.spec.ts` | 111 | `closes the saved shell when an unbound Codex client exits before discovery catches up` (the `now` close) |
| `unusedCodexClose.spec.ts` | 149 | `closes only the exited client pane in a real private tmux server` (`expect(result)`) |

- [ ] **Step 2: Run them and see them fail**

Run: `cd cli && npx vitest run src/lib/closeAgentService.spec.ts src/lib/unusedCodexClose.spec.ts`
Expected: `Tests  10 failed | 110 passed | 1 skipped (121)`: seven in `closeAgentService.spec.ts` (the three rows of
the first new `it.each`, "a close once idle", and the three moved cases) and three in `unusedCodexClose.spec.ts`.
Each says:

```
AssertionError: expected { closed: true } to deeply equal { closed: true, …(1) }
```

("a close once idle" names `backgroundCommands: 2` beside it.) The other five new cases pass before the change: they
hold what must not change. Keep the output for the pull request.

- [ ] **Step 3: Commit the red tests**

```bash
git add cli/src/lib/closeAgentService.spec.ts cli/src/lib/unusedCodexClose.spec.ts
git commit -m "CLI core: specs for what a close says of a saved record with no conversation (red)"
```

- [ ] **Step 4: Read the record the stop saved**

In `attempt`, the `checkpoint` option handed to `this.deps.stop` (line 327) becomes a wrapper: on phase `'before'`,
when `resumeMode(s.engine) === 'conversation' && !s.sessionId`, set the existing `unkept` flag to `true`; then call
`this.deps.checkpoint(s, phase)` and return its promise, as today. Nothing else in `attempt` changes: line 350 already
answers `withoutConversation: true` from `unkept`, and only after the stop is confirmed. `resumeMode` is imported
already. Reuse `unkept`: no second variable for the same answer. The comment says why: that record is what a resume starts
from, and without a conversation id an engine that resumes by one brings nothing back
(`lib/resumeCapability.ts` `resumesConversation`).

The `AgentCloseResult` comment (line 22) says both cases: the record the close saved holds no conversation a resume
could bring back, so none is kept: closed while still starting, before Harness could read its conversation, or its
engine never bound one.

- [ ] **Step 5: Run the specs, the typecheck and the neighbours**

Run: `cd cli && npx vitest run src/lib/closeAgentService.spec.ts src/lib/unusedCodexClose.spec.ts`
Expected: `Tests  120 passed | 1 skipped (121)`.

Run: `cd cli && RUN_REAL_TMUX_DISCOVERY=1 npx vitest run src/lib/unusedCodexClose.spec.ts`
Expected: `Tests  9 passed (9)`, in about 3 s. It is the only run of the case at line 149: a private tmux server under a
throwaway root (`src/testing/isolatedTmux.ts`), with `TMUX` and `TMUX_PANE` unset by the spec itself.

Run: `cd cli && npm run typecheck`
Expected: no error (about 30 s).

Run: `cd cli && npx vitest run src/lib/stopAgentService.spec.ts src/backendSocket.spec.ts src/core/agents/close.spec.ts src/core/agents/closeCleanup.spec.ts src/architecture.spec.ts`
Expected: `Test Files  5 passed (5)`, `Tests  387 passed (387)` (about 20 s): the other specs that close through the
real service, unchanged, and the core's file list.

- [ ] **Step 6: Commit**

```bash
git add cli/src/lib/closeAgentService.ts
git commit -m "CLI core: a close says none was kept when the record it saved holds no conversation"
```

Report both commits, and the Step 2 (red) and Step 5 (green) outputs with the commit each ran on.

---

### Task 3: The cleanup's log line says none was kept when none was

**Depends on:** nothing. It reads `AgentCloseResult.withoutConversation`, which the type has today. **Effort:** medium.

**Files:**
- Modify: `cli/src/services/agentCleanup.ts` (`close`, lines 139-146; the header comment, lines 25-26)
- Test: `cli/src/services/agentCleanup.spec.ts`

**The test that fails before the change:** `closing the harnesses a closed harness started › says none was kept of one
that had not started a conversation, and that it is kept of any other`, in `cli/src/services/agentCleanup.spec.ts`.

**Interfaces:** consumes `AgentCloseResult.withoutConversation?: true` from `core.agents.closeStarted`. Produces the
log line `[agent-cleanup] closed <label>: <why>[, with <n> background command(s) running]. <sentence>`, where
`<sentence>` is `It had not started a conversation, so none was kept.` when the result has `withoutConversation`, and
`Its conversation is kept.` otherwise.

- [ ] **Step 1: Write the failing test**

In `cli/src/services/agentCleanup.spec.ts`, inside `describe('closing the harnesses a closed harness started', …)`,
after its first case:

```ts
  // The core says when the record a close saved holds no conversation (lib/closeAgentService.ts `withoutConversation`):
  // the line said "Its conversation is kept." of a Codex that never bound one (docs/plans/2026-11-16-codex-help-race-design.md).
  it('says none was kept of one that had not started a conversation, and that it is kept of any other', async () => {
    const sessions = [kid('unbound'), kid('bound')]
    const { cleanup, closeStarted, log } = setup(sessions)
    closeStarted.mockImplementationOnce(async () => { sessions.splice(0, 1); return { closed: true, withoutConversation: true } })
    await cleanup.closeStartedBy('lead')
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      '[agent-cleanup] closed unbound (unbound): the harness that started it was closed. It had not started a conversation, so none was kept.',
      '[agent-cleanup] closed bound (bound): the harness that started it was closed. Its conversation is kept.',
    ])
    expect(sessions).toEqual([])
  })
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd cli && npx vitest run src/services/agentCleanup.spec.ts`
Expected: `Tests  1 failed | 25 passed (26)`: the first line reads `… was closed. Its conversation is kept.` where
`… It had not started a conversation, so none was kept.` is expected. Keep the output for the pull request.

- [ ] **Step 3: Commit the red test**

```bash
git add cli/src/services/agentCleanup.spec.ts
git commit -m "CLI cleanup: a spec for the log line of a close that kept no conversation (red)"
```

- [ ] **Step 4: Pick the sentence by the result**

In `close`, the log line's last sentence is `It had not started a conversation, so none was kept.` when
`result.withoutConversation` is set and `Its conversation is kept.` otherwise; the rest of the line is unchanged. Its
comment says it is the sentence `harness close` prints (`agentClient/commands.ts`), from the same answer of the core.
In the header comment, the paragraph "A close keeps the conversation, as `harness close` does…" gains one sentence: one
that had not started a conversation has none to keep, and its line says so.

- [ ] **Step 5: Run the spec, the typecheck and the coverage gate**

Run: `cd cli && npx vitest run src/services/agentCleanup.spec.ts`
Expected: `Tests  26 passed (26)`.

Run: `cd cli && npm run typecheck`
Expected: no error (about 30 s).

Run: `cd cli && npm run test:core`
Expected: exit 0, `Test Files  251 passed (251)`, `Tests  4561 passed (4561)`, and a coverage summary of 100% on all
four lines, in about 70 s. A file under 100% prints `ERROR: Coverage for …` and exits 1. Both sides of the new choice
are covered: the new case and every older one.

The gate loads `cli/src/lib/closeAgentService.ts` through the core's specs. It passes with and without Task 2's
change, but not while that file is half written in the same checkout: a failure in a file this task did not touch is
run again once Task 2 has committed, never fixed here. Verification runs the gate once more on the final head.

- [ ] **Step 6: Commit**

```bash
git add cli/src/services/agentCleanup.ts
git commit -m "CLI cleanup: the close's log line says none was kept when none was"
```

Report both commits, the Step 2 (red) and Step 5 (green) outputs, and the gate's summary lines.

---

### Task 4: Both end-to-end rows hold the help probe open 400 ms

**Depends on:** Task 1 (`helpDelayMs`, and the probe's child under Node's own name). **Effort:** medium.

**Files:**
- Modify (test): `cli/e2e/agentClient.e2e.ts` (line 399)

**The test that fails before the change:** none: no behavior. The task changes what two existing rows hand their fake
Codex; the rows are the test, and Task 1 is done when this starts. Their red is Task 1's cause, measured: with the help
delayed 400 ms and the wrapper unchanged, "never binds while the close waits" failed 3 of 3 on main (the spec), and
with Task 2 in, "binds its conversation a few seconds in" failed with
`Received: "pong on studio: closed. It had not started a conversation, so none was kept."`

- [ ] **Step 1: Pass the delay to both rows**

In `it.each(…)('an agent closes a Codex it started a second ago, which %s', …)`, the `config` literal gains
`helpDelayMs: 400` beside `unreadableDescriptorMs` and `firstHookDelayMs`. The comment above the `it.each` gains one
sentence: the fake's help takes 400 ms, as a slow first run's does, so the launch script's probe is still running when
discovery first reads the pane (CLI end to end run 43746252131, shard 4).

- [ ] **Step 2: Run the two rows**

Needs `tmux` and `/bin/zsh`. The daemon it starts is isolated (see Verification 3).

Run: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/agentClient.e2e.ts -t "started a second ago"`
Expected: `Tests  2 passed | 10 skipped (12)`, in about 30 s.

The daemon runs from the checkout's source. A failure while Task 2 or 3 is half written in the same checkout is run
again once they have committed.

- [ ] **Step 3: Commit**

```bash
git add cli/e2e/agentClient.e2e.ts
git commit -m "CLI e2e: both closes of a starting Codex run with its help probe held open 400 ms"
```

Report the commit and the Step 2 output.

---

## Left out

- Discovery, capture, stop, the wait loop and the agent client: the spec's "Nothing else". The comments at
  `agentClient/commands.ts:1796` and `:1798` still name only "still starting"; that file is not this change's.
- The comment in `lib/resumeCapability.ts` that calls Devin `fresh`: stale whatever open question 1 says. A proposal
  for the maintainers, not this pull request.
- `EngineConfig` in `cli/e2e/harness/daemon.ts` gains no `helpDelayMs`: the rows build their config as a literal and
  the unit spec loads the shim untyped, so nothing reads the type.
- An end-to-end row for a close of a Codex whose recorded engine has exited (the startup retry, an engine quit in its
  pane): the spec covers that answer in `closeAgentService.spec.ts` and `unusedCodexClose.spec.ts:111`.
- The windows' Close, which reads nothing from `withoutConversation`.

## Verification

All on the final head, after the review. Nothing here needs an account, a sign-in, a device or Diego, and nothing
touches production, the developer's daemon (port 18473), tmux server, `~/.codex` or `~/.claude`.

**On GitHub by itself.** Marking the pull request ready runs `cli-typecheck` and `cli-tests` (the default Vitest
suite, four Linux shards), with `pty-checks` and the companions' check that a `cli/` change selects. `cli-tests` runs
the four specs this plan changes or adds, and `src/architecture.spec.ts`, on Linux. Nothing is started by hand.

That run is the first of `fakeEngineHelpProbe.spec.ts` on Linux: it was rehearsed on macOS only. On Linux `ps` names a
script's process by the script, where macOS names its interpreter; each of the four rows was read through for both
(the probe check reads `args` alone), not run. A row that fails there is a finding to fix, never a row to skip.

1. **The coverage gate PR CI does not run, with its receipt.** On the Mac, from the repository root, on a clean tree
   at the final commit (the script refuses untracked files, so after the two documents under `docs/plans/` are
   committed), before that commit is pushed or the pull request marked ready:

   ```bash
   python3 scripts/local-checks.py --run
   ```

   It runs `npm run test:core` in `cli/` (the one check these paths need). To see: one `harness-local-checks` fence
   with `"check": "cli-core"` and `"status": "passed"`; the run itself prints `Test Files  251 passed (251)`,
   `Tests  4561 passed (4561)` and 100% four times, in about 70 s. Paste the fence into the pull request body as it is.
   It must be there when the pull request is opened or the tested commit is pushed: `process-checks` reads the body
   from that event, and a body edited afterwards is not read again.

2. **The case only a real tmux runs.** On the Mac, 3 s:

   ```bash
   cd cli && RUN_REAL_TMUX_DISCOVERY=1 npx vitest run src/lib/unusedCodexClose.spec.ts
   ```

   To see: `Tests  9 passed (9)`. Isolated by `src/testing/isolatedTmux.ts`: a tmux server of its own on a socket under
   a throwaway root, `TMUX` and `TMUX_PANE` unset, and the only process it signals is the fixture child it started.

3. **The two rows on macOS, three times.** On the Mac, about 90 s. Nothing to build: the daemon starts from source.

   ```bash
   cd cli && for run in 1 2 3; do npx vitest run --config vitest.e2e.config.ts e2e/agentClient.e2e.ts -t "started a second ago" || { echo "run $run failed"; break; }; done
   ```

   Isolated as every CLI end-to-end test is (`cli/AGENTS.md` rules 5 and 6; `cli/e2e/harness/daemon.ts`
   `IsolatedDaemon`): a throwaway root with its own home, data, auth and runtime folders, a free port, a private tmux
   server, the fake Claude Code and Codex as its engines (`CLAUDE_PATH` and `CODEX_PATH` in `<root>/bin`), an
   environment that takes no developer state (`src/testing/daemonEnvironment.ts`), and `FakeBackend` on loopback as
   its backend, with a made-up token. To see: three summaries, each `Tests  2 passed | 10 skipped (12)`, and no
   `run N failed` line. One failure in three is not a pass: report the run, the row and its error, and stop.

4. **The whole CLI end to end on Linux, once, by hand.** The fixture is read by about 25 end-to-end files and the
   failure was seen on a Linux shard, so the whole suite runs once on the branch, after the final head is pushed. The
   repo's own workflow, **Actions → CLI end to end → Run workflow** on `fix/codex-help-race`
   (`.github/workflows/cli-e2e.yml`: `permissions: contents: read`, no secrets, throwaway daemons on the runner):

   ```bash
   gh workflow run cli-e2e.yml --ref fix/codex-help-race
   gh run list --workflow cli-e2e.yml --branch fix/codex-help-race --limit 1
   ```

   To see, after about 25 minutes: `e2e (1)` to `e2e (8)`, `e2e (macOS, full disk)` and `e2e-summary` green; in the
   shard that holds `e2e/agentClient.e2e.ts`, both "an agent closes a Codex it started a second ago" rows pass. Put
   the run's link in the pull request body. It holds ten runners: start it once, never beside another heavy workflow,
   and never again to turn a failure green. A failing file is compared with the last nightly on main
   (`gh run list --workflow cli-e2e.yml --branch main --event schedule --limit 3`, green on 2026-11-15): red there too
   is reported as unchanged, red only here is this branch's.

**Temporary workflow:** none. The one long check has the repo's own workflow.

**Checks that keep running:** nothing new to decide. The unit specs run in `cli-tests` on every pull request; the two
rows run in the nightly CLI end to end, as before.

**Checks PR CI does not run:** `cli-core` is required (check 1). `test:resume`, `test:harnessd` and the others are not:
`scripts/local-checks.py --list` on the eight files names `cli-core` alone.
