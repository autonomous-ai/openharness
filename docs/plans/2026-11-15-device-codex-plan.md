# The dial talks to Codex outside Harness through `codex queue` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use diegodev phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With Codex running outside Harness in any terminal, a person at the dial says the next prompt to it, idle, working or waiting on an approval, and it runs as the next turn. Every approval is still answered in its own app.

**Architecture:**
- The devices process runs `codex queue --thread <id> --message=<text>` itself, with no shell, as it runs `orca` (`cli/src/cable/hosts/codexQueue.ts`, new). The binary is the Codex Harness launches: `engineBin('codex')`.
- The observed source (`cable/hosts/observed.ts`) sends a queue-able Codex session's words there first, in every state, and gives such a session `v` whatever terminal it runs in. Only a definite failure goes on to today's Orca route, under today's rules, and its one log line names the reason. A timeout types nothing.
- `services/devices.ts` builds the queue with Harness's own Codex home (`env.CODEX_HOME`) and hands it to the observed source. Nothing goes through the core, and nothing new is stored.

**Tech Stack:** TypeScript daemon (Node, vitest, `cli/`).

**Spec:** `docs/specs/2026-11-15-device-codex.md`.

**Base:** the tasks start from `origin/main` once #4331 has merged. #4311 (`f979a5c6c3`) and #4326 (`aad8dcd535`) are merged; #4331 is rebasing. See "Base" below.

## Base

- Merged on `origin/main` (2026-11-15): #4311 as `f979a5c6c3`, #4326 as `aad8dcd535`.
- #4331 is open and rebasing onto them (it conflicts with `main` today; its head before the rebase was `c6f5b7ecd6`).
- `feat/device-codex` is rebased onto `origin/main` after #4331 merges. No task starts before that.
- The tasks are written against the code as #4326 leaves it on `main` and as #4331 will, by function and behavior, never by line:
  - `observed.ts`: `ObservedSource.send`, `capabilities`, `live`, `idleKnown`, `dialPrompt`, `promptSource`, `ObservedActions`.
  - `observed.spec.ts`: `setup`, `fakeActions`, `HANDLE`.
  - `devices.ts`: `startDevices`, `DevicesDeps.orca`, the `observedSource(...)` call and its `count`.
  - `devices.spec.ts`: `start`, `startHere`, `attach`, `listed`, `said`, `host`, `orcaRuns`.
  - `orca.ts`: `MAX_TEXT`, `orcaDeps`. `lib/sessionSearch/externals/support.ts`: `within`.
  - `lib/engineBin.ts`: `engineBin`. `lib/binaryOnPath.ts`: `resolveBinaryOnPath`.
- `ObservedActions` holds `claudeInFront` and `claudeShow` on `main` today, and `tabsOpen` and `tabSelect` once #4331 merges. This plan changes none of them, nor `orca.ts`, `open.ts`, `hostDetect.ts`, `types.ts`, `engineBin.ts` or `binaryOnPath.ts`.
- If a name differs at the base, the implementer follows the code and says so in its report.

## Start order

diegodev starts a task when the tasks it depends on are done and no running task shares its files.

| Task | Depends on | Shares files with |
|---|---|---|
| 1 The queue | none | none |
| 2 The observed source and the devices use it | 1 (`CodexQueue`, `CodexQueueResult`, `CODEX_THREAD`, `createCodexQueue`) | none |
| 3 End to end | 2 | none |
| 4 Say it in the docs | none | none |

Longest chain: 1 → 2 → 3.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/hosts/codexQueue.ts` (new) | **Devices service process**, and only there | Its spec |
| `cli/src/cable/hosts/observed.ts` | **Devices service process** | Its spec |
| `cli/src/services/devices.ts` | **Devices service process** | 100% per file (`npm run test:core`) |
| `cli/e2e/deviceCodex.e2e.ts` (new), `cli/e2e/harness/codexOutside.ts` (new), `cli/e2e/harness/fakeEngine.mjs` | Test: the real daemon, a fake dial, the suite's fake `codex` | `cli-e2e.yml` (nightly, and by hand on the branch) |
| `cli/AGENTS.md`, `docs/specs/2026-11-13-device-claude-orca.md` | Repo files, no process | none |

No file under `cli/src/core/` changes, and `cli/src/architecture.coreFiles.txt` gains no line (cli/AGENTS.md, Protect the core, rule 7).

**`codexQueue.ts` may import `lib/engineBin.ts`** (checked 2026-11-15, on `origin/main` at `aad8dcd535`):
- No rule of `cli/src/architecture.spec.ts` names an import from `cable/` into `lib/`. Its service rule forbids core modules, the registry, `cli.ts` and the socket, and `engineBin.ts` is none of them.
- `engineBin.ts` and what it imports are 14 files: none under `core/` or `services/`, and not the registry.
- The devices process loads `engineBin.ts` already (`core/api.ts` → `lib/registry.ts` → `lib/engineLaunch.ts` → `lib/windows/engineStart.ts`), so the import adds no file to it. `leanEntry.spec.ts` holds the devices to no rule this touches.
- Task 2, step 4 runs both specs.

## Global Constraints

- **The command.** `execFile(codex, ['queue', '--thread', <id>, `--message=${text}`])`. No shell. The text is one argument, joined to its flag, passed as is: newlines stay.
- **The binary** is the Codex Harness launches (PM, 2026-11-15): `resolveBinaryOnPath(engineBin('codex'))`, so `CODEX_PATH`, else `codex` on the daemon's `PATH`. No login-shell probe. Asked each time, never kept.
- **Its surroundings.** `cwd` is the home directory, so no project's `.codex/` config is read. `CODEX_HOME` is `env.CODEX_HOME`. 10 s, `killSignal: 'SIGKILL'`, and a deadline that answers by itself, as `orca.ts` does.
- **The thread id** is a UUID: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`. `--thread` also takes "an exact session name" (`codex queue --help`, 0.167.0), so nothing else may reach it.
- **The text** is 1 to `MAX_TEXT` (2,000) characters.
- **The home** is Harness's own setting. It is never derived from a hook's path: a session whose transcript is elsewhere keeps today's route.
- **Queue first, in every state.** Fallback to Orca typing only after a definite failure (a non-zero exit, a binary that did not start), and only where today's code would type (idle, at a known handle). After a failure today's checks answer with today's sentences (PM, 2026-11-15). A timeout never types: the message may be queued.
- **The dial's own queued words do not turn the dial** (PM, 2026-11-15): the pane-follow mark is recorded before the command runs and kept only on `queued`.
- **One command at a time per thread.** A second answers `busy`.
- **The dial's sentences**, unchanged: `<name> did not answer.`, `<name> has not taken your last words yet.`, `<name> is busy. Say it when it is done.`, `<name> is waiting for your answer in <Host>.`, `Too long. Say it shorter.`
- **Log.** One line for the queue's part of each send, written by the devices' `count` (PM, 2026-11-15): `[device] voice · codex`, `[device] voice · codex-timeout`, `[device] voice · codex-failed (exit N)`, `[device] voice · codex-failed (no binary)`. The queue itself logs nothing. Never the text, the thread id or a path. Codex's own output is never read or logged: it names the thread and the home.
- **The dial approves nothing.** No task adds a way to answer a Codex approval.
- **Platforms.** macOS and Linux. Windows is unchanged: the queue is never used there.
- **Not in this run:** `codex://threads/<id>`; a Codex home other than Harness's own.
- **Repo rules.** Tests never touch the developer's real `~/.codex`, daemon (port 18473), tmux server or dial, and no spec runs the developer's real `codex`: a recording `run`, or a fake `codex` script in a temp folder. No fixed sleeps.

## Review Focus

1. **`CODEX_PATH` names a file that is gone, while another `codex` is on `PATH`.** Harness would not launch that other one, so the queue must not run it either: Codex keeps today's route. And a `codex` installed later is found with no restart. Task 1, `the binary is the Codex Harness launches, asked each time`. (A `codex` only on the login shell's `PATH` keeps today's route: decided, PM.)
2. **The queued words' turn starts before `codex queue` has exited** (a turn within 0.4 s with Codex's daemon; the command runs 0.1 to 0.45 s). Its hook must find the dial's prompt already recorded, or the dial turns to its own words. Task 2, `the turn that starts while codex queue still runs is the dial's`.
3. **`codex` ends with no exit code and no deadline:** killed by a signal, or its output over the buffer. That is not a definite failure, so nothing is typed. Task 1, `a codex killed by a signal answers timeout, never failed`.
4. **A Codex session the open scan found, before any hook.** It has its row's transcript and no handle. It takes voice. Task 2, `a Codex session the open scan found takes voice before its first hook`.
5. **A path or an id that only looks right:** a transcript that leaves the home through `..`, a sibling folder named `sessions-old`, a session id that is a name or upper case. Task 2, `not queue-able`; Task 1, `a thread id that is not a lower-case UUID … runs nothing`.
6. **A text with a NUL** (a broken dial). It cannot be an argument, and `execFile` throws on it. Task 1, `… and one with a NUL run nothing and answer failed, refused`, and `run never rejects`.

---

### Task 1: The queue

**Layer:** devices service process. **Depends on:** none. **Effort:** `xhigh` (it runs a program with the dial's text; one run at a time per thread).

**Red test:** `cli/src/cable/hosts/codexQueue.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/codexQueue.ts`
- Test: `cli/src/cable/hosts/codexQueue.spec.ts`

**Interfaces:**
- Consumes: `MAX_TEXT` (`./orca.js`), `engineBin` (`../../lib/engineBin.js`), `resolveBinaryOnPath` (`../../lib/binaryOnPath.js`).
- Produces:
  ```ts
  export const CODEX_THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  export const QUEUE_TIMEOUT_MS = 10_000
  /** Why a send failed, as the log line names it: codex's exit code; 'no binary' when it is not there or could not
   *  start; 'refused' for a thread id or a text the queue will not run (Open question 1). */
  export type CodexQueueFailure = `exit ${number}` | 'no binary' | 'refused'
  export type CodexQueueResult =
    | { outcome: 'queued' | 'timeout' | 'busy' }
    | { outcome: 'failed'; reason: CodexQueueFailure }
  /** Its exit code; 'not-started' when the binary could not start; 'unknown' for every other ending. */
  export type CodexRunEnd = number | 'not-started' | 'unknown'
  export interface CodexQueueDeps {
    run(file: string, args: string[], options: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<CodexRunEnd>
    /** The Codex Harness launches, where it is; null when it is not there. */
    binary(): string | null
    platform: NodeJS.Platform
    home: string
    cwd: string
  }
  export interface CodexQueue { can(): boolean; send(threadId: string, text: string): Promise<CodexQueueResult> }
  export function codexQueueDeps(): Pick<CodexQueueDeps, 'run' | 'binary' | 'platform'>
  export function createCodexQueue(deps: CodexQueueDeps): CodexQueue
  ```
- Rules:
  - `can()`: not Windows, and `deps.binary()` is not null. Asked each time, never kept.
  - `send`, in this order:
    1. A thread id that fails `CODEX_THREAD`, an empty text, a text over `MAX_TEXT`, or a text with a NUL: `failed`, `refused`. Nothing runs.
    2. A run under way for that thread: `busy`. Nothing runs.
    3. No binary (`can()` is false): `failed`, `no binary`. Nothing runs.
    4. `deps.run(binary, ['queue', '--thread', threadId, `--message=${text}`], { cwd: deps.cwd, env: { CODEX_HOME: deps.home }, timeoutMs: QUEUE_TIMEOUT_MS })`. The thread is free again after any ending.
    5. `0` is `queued`. Another number is `failed`, `exit <N>`. `'not-started'` is `failed`, `no binary`. `'unknown'` is `timeout`.
  - **The queue logs nothing** (the spec, "What it logs"): it has no `log`. A failure's reason travels in its result, and the observed source's one line names it (Task 2).
  - `codexQueueDeps().binary`: `resolveBinaryOnPath(engineBin('codex'))` (PM, 2026-11-15): `CODEX_PATH`, else `codex`, on the daemon's `PATH`. No login-shell probe, and no second look for `codex` when `CODEX_PATH` names a file that is not there.
  - `codexQueueDeps().run`:
    - `execFile` with `cwd`, `env: { ...process.env, ...env }`, `timeout: timeoutMs`, `killSignal: 'SIGKILL'`, beside a timer of its own that answers `'unknown'` at `timeoutMs`, as `orcaDeps().run` does.
    - It ends the child's stdin at once: nothing is piped to `codex`.
    - `'not-started'` only when the child got no pid (`ENOENT`, `EACCES`, an argument `execFile` refuses). A numeric `error.code` is the exit code. Everything else is `'unknown'`.
    - It never rejects and never throws.

- [ ] **Step 1: Write the failing tests** in `codexQueue.spec.ts`. Three helpers, as `orca.spec.ts` has them: a recording `run` that runs nothing; a `run` held until the test lets it end; and `fakeCodex(tail)`, a shell script in a temp folder that writes `"$@"`, `$CODEX_HOME` and the answer of `pwd -P` to files and then runs `tail`, run through the real `codexQueueDeps().run`. `THREAD = '01a1de76-a3b7-7270-b39e-1245893274c1'`. Every answer is compared whole (`toEqual`), so a result holds its outcome and reason and no more.
  - `send runs codex queue with the thread and the text joined to its flag, in the home directory, under the Codex home, for 10 s`: with `binary: () => '/fake/bin/codex'`, the recorder's one call is `['/fake/bin/codex', ['queue', '--thread', THREAD, '--message=fix the login bug'], { cwd: '/home/u', env: { CODEX_HOME: '/home/u/.codex' }, timeoutMs: 10_000 }]`; the answer is `{ outcome: 'queued' }`.
  - `a text that starts with --, with quotes, $( ) and two lines reaches codex whole, as one argument`: the real run; the fake's argv has 4 entries and `argv[3]` is `--message=${text}` for ``--dash "q" $(touch ${marker}) `touch ${marker}`\nsecond line``; `marker` does not exist; the fake's `$CODEX_HOME` is the `home` given, and its folder is `realpathSync(cwd)`.
  - `a thread id that is not a lower-case UUID, an empty text, one over 2000 characters and one with a NUL run nothing and answer failed, refused`: ids `''`, `THREAD.toUpperCase()`, `` `${THREAD}; rm -rf /` ``, `'--help'`, `'my session'`; a text of 2000 characters runs, one of 2001 does not; each refusal is `{ outcome: 'failed', reason: 'refused' }`.
  - `exit 0 is queued; a non-zero exit is failed with its exit code; a binary that cannot start, and no binary, are failed with no binary`: `run` answering `0`, `1`, `127`, `'not-started'` gives `{ outcome: 'queued' }`, `{ outcome: 'failed', reason: 'exit 1' }`, `{ outcome: 'failed', reason: 'exit 127' }`, `{ outcome: 'failed', reason: 'no binary' }`; `binary: () => null` gives `{ outcome: 'failed', reason: 'no binary' }` and no run.
  - `the real run answers the exit code, not-started for a missing file, and never rejects`: `fakeCodex('exit 3')` is `3`; `join(dir, 'missing')` is `'not-started'`; an argument with a NUL is `'not-started'`.
  - `a run that outlasts its 10 s answers timeout at the deadline, and its codex is killed with SIGKILL`: `fakeCodex("trap '' TERM\nexec sleep 300")`, the real run asked through a wrapper that records `10_000` and passes 200; the answer is `{ outcome: 'timeout' }`; the child's `signalCode` is `'SIGKILL'` (read as `orca.spec.ts` reads it).
  - `a codex killed by a signal answers timeout, never failed`: `fakeCodex('kill -KILL $$')`; the real run answers `'unknown'`, and `send` answers `{ outcome: 'timeout' }`.
  - `run ends its codex's stdin at once`: `fakeCodex('cat > /dev/null')` answers `0`.
  - `a second send for the same thread while one runs is busy and runs nothing; another thread's runs; the thread is free again after queued, failed and timeout`: the second answer is `{ outcome: 'busy' }`.
  - `can() is whether the binary is there, asked each time, and false on Windows`: a `binary` that answers null, then a path; `platform: 'win32'` is false, and `send` there is `{ outcome: 'failed', reason: 'no binary' }` with no run.
  - `the binary is the Codex Harness launches, asked each time`, on the real `codexQueueDeps().binary`, in a temp folder `dir`:
    - `vi.stubEnv('CODEX_PATH', '')` and `vi.stubEnv('PATH', dir)`: null; then `join(dir, 'codex')` once that file exists and can be run.
    - `vi.stubEnv('CODEX_PATH', join(dir, 'other', 'my-codex'))`: null while that file is missing, though `join(dir, 'codex')` is on `PATH`; then that path once it exists and can be run.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/codexQueue.spec.ts`. Expected: FAIL (no `./codexQueue.js`).
- [ ] **Step 3: Implement** `codexQueue.ts` as "Interfaces" says. The file's header says why the id and the text are checked here (the id came from a hook, the text from the dial), why Codex's output is never read, and why the file logs nothing (Codex's own error text names the thread and the home).
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: codex queue, run with no shell, one at a time per thread`.

### Task 2: The observed source and the devices use the queue

**Layer:** devices service process. **Depends on:** Task 1. **Effort:** `xhigh` (when words may be typed into a terminal; a run racing the turn's hook; `services/devices.ts` is in the 100% gate).

**Red test:** `cli/src/cable/hosts/observed.spec.ts`, `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts`, `cli/src/services/devices.ts`
- Test: `cli/src/cable/hosts/observed.spec.ts`, `cli/src/services/devices.spec.ts`

One task, not two: `ObservedActions` gains required members, so `observed.ts` and its one caller change together or the typecheck fails between them.

**Interfaces:**
- Consumes: `CodexQueue`, `CodexQueueResult`, `CodexQueueFailure`, `CODEX_THREAD`, `CodexQueueDeps`, `createCodexQueue`, `codexQueueDeps` (Task 1).
- Produces, in `observed.ts`:
  - `ObservedActions.codexQueue: Pick<CodexQueue, 'can' | 'send'>` and `ObservedActions.codexHome: string`.
  - `ObservedActions.count` also takes ``'codex' | 'codex-timeout' | `codex-failed (${CodexQueueFailure})` ``: the route and, for a failure, its reason, in one line (PM, 2026-11-15).
- Rules, in `observed.ts`:
  - **Queue-able**, a private check on an entry, in this order: `engine === 'codex'`; the session is live; it has a transcript path; that path is `within(join(actions.codexHome, 'sessions'), path)`; its session id passes `CODEX_THREAD`; and, last, `actions.codexQueue.can()`.
  - **`capabilities`:** `voice` is `live && (queue-able || handle || mod ready)`.
  - **`send`**, for a queue-able session, after the length check and the ended check and before every other check:
    1. Record the dial's prompt (`dialPrompt`), before the command runs: the turn a queued message starts is the dial's own, and does not turn the dial (PM, 2026-11-15).
    2. `const result = await actions.codexQueue.send(sessionId, text)`.
    3. `queued`: `count('codex')`, answer `{ ok: true }`. The record stays.
    4. Any other outcome drops that one record, as a failed `orcaSend` does today.
    5. `busy`: the refusal counted `pending`, `<name> has not taken your last words yet.`
    6. `timeout`: `count('codex-timeout')`, once, and `{ ok: false, reason: '<name> did not answer.' }`. Nothing else runs.
    7. `failed`: ``count(`codex-failed (${result.reason})`)``, then on to today's checks as they are, with today's sentences (PM, 2026-11-15): ended or no handle is `<name> did not answer.`, `needs-you` is `<name> is waiting for your answer in <Host>.`, working or idle not known is `<name> is busy. Say it when it is done.`, and only an idle agent at its Orca handle is typed into (today's `orcaSend`).
  - A session that is not queue-able takes today's path, untouched.
- Produces, in `services/devices.ts`:
  - `DevicesDeps.codex?: Pick<CodexQueueDeps, 'run' | 'binary' | 'platform'>`: for this service's tests, how `codex` is found and run.
  - Beside the Orca actions: `const codexQueue = createCodexQueue({ ...(deps.codex ?? codexQueueDeps()), home: env.CODEX_HOME, cwd: homedir() })`.
  - The observed source's actions gain `codexQueue` and `codexHome: env.CODEX_HOME`. Its `count` line is unchanged, `[device] voice · ${what}`, and is the one line the queue's part of a send writes: a failure's reason is in `what`. The route that answers after a failure counts its own, as today.

- [ ] **Step 1: Write the failing tests.**
  - `observed.spec.ts`:
    - `fakeActions` gains `codexQueue: { can: vi.fn(() => true), send: vi.fn(async (_threadId: string, _text: string): Promise<CodexQueueResult> => ({ outcome: 'queued' })) }` and `codexHome: '/home/u/.codex'`. `FAILED = { outcome: 'failed', reason: 'exit 1' }`.
    - A new `describe('ObservedSource and codex queue')`. `THREAD` as in Task 1. `cx = { engine: 'codex', sessionId: THREAD, transcriptPath: `/home/u/.codex/sessions/2026/11/15/rollout-2026-11-15T16-07-59-${THREAD}.jsonl`, hostHints: { TERM_PROGRAM: 'ghostty' } }`. `inOrca` is `cx` with `hostHints: { ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE }`.
    - `a queue-able Codex session in Ghostty lists voice, with no handle and no mod`: caps are `{ status: true, voice: true, focus: true, answer: false }`.
    - `not queue-able`: each of these lists no voice, and its `send` never calls `codexQueue.send`: engine `claude`; an ended session; no transcript path yet; a transcript in `/other/.codex/sessions/…`; `/home/u/.codex/sessions/../../x/rollout.jsonl`; `/home/u/.codex/sessions-old/rollout.jsonl`; session id `'cx'`; session id `THREAD.toUpperCase()`; `can` answering false.
    - `can() is asked last`: for the Claude session and for the one outside the home, `can` was never called.
    - `idle, working and needs-you: the words go to the queue and nothing is typed`: in each state, for `cx` and for `inOrca`, `send` answers `{ ok: true }`, `codexQueue.send` got `[THREAD, 'next']`, `orcaSend` and `toMod` were not called, and `count` got `[['codex']]`.
    - `failed falls back to Orca only when idle at a handle, with today's sentences`, with `send` answering `FAILED`:
      - `inOrca`, idle: `orcaSend` got `[HANDLE, 'next']`; `{ ok: true }`; counts `[['codex-failed (exit 1)'], ['orca']]`.
      - `inOrca`, working: `{ ok: false, reason: 'proj is busy. Say it when it is done.' }`; `orcaSend` not called; counts `[['codex-failed (exit 1)'], ['busy']]`.
      - `inOrca`, needs-you: `{ ok: false, reason: 'proj is waiting for your answer in Orca.' }`; `orcaSend` not called; counts `[['codex-failed (exit 1)'], ['waiting']]`.
      - `cx` (no handle): `{ ok: false, reason: 'proj did not answer.' }`; counts `[['codex-failed (exit 1)'], ['no-answer']]`.
    - `a failure is counted with its reason`: `cx`, `send` answering `{ outcome: 'failed', reason: 'no binary' }`, then `{ outcome: 'failed', reason: 'refused' }`: counts `[['codex-failed (no binary)'], ['no-answer']]`, then `[['codex-failed (refused)'], ['no-answer']]`.
    - `timeout never types`: `inOrca`, idle, `send` answering `{ outcome: 'timeout' }`: `{ ok: false, reason: 'proj did not answer.' }`; `orcaSend` not called; counts `[['codex-timeout']]`.
    - `busy says the last words are not taken yet, and types nothing`: `send` answering `{ outcome: 'busy' }`: `{ ok: false, reason: 'proj has not taken your last words yet.' }`; counts `[['pending']]`.
    - `a session that ended, or moved to another terminal, while the queue ran is not typed into`: a held `codexQueue.send`, `inOrca` idle; meanwhile a `session-end`, or a `session-start` with another handle; then `FAILED`: `{ ok: false, reason: 'proj did not answer.' }`, `orcaSend` not called.
    - `a session that ends while codex queue runs is still answered sent once it queued`: a held `codexQueue.send`; a `session-end`; then `{ outcome: 'queued' }`: `{ ok: true }`, counts `[['codex']]` (the spec: its message waits for the thread's next resume).
    - `the turn that starts while codex queue still runs is the dial's`: a held `codexQueue.send`; `src.ingest(ev('turn-start', cx))` answers `'dial'`; then `{ outcome: 'queued' }`; the next `turn-start` answers `'person'`.
    - `after queued the next turn is the dial's; after failed, timeout or busy it is a person's` (`cx`, with no handle: a fallback that types records its own, as today).
    - `a Codex session the open scan found takes voice before its first hook`: `open`, `owners` and `externals` set for `THREAD` with `cx`'s transcript; after `scanOpen()` its caps have `voice: true`, and `send` reaches `codexQueue.send`.
    - `a text over 2000 characters is refused before the queue`: `Too long. Say it shorter.`; `codexQueue.send` not called.
  - `devices.spec.ts`:
    - Beside `orca`: `codexRuns` and a recording `codex = { run: async (file, args, options) => { codexRuns.push([file, args, options]); return 0 }, binary: () => '/opt/codex/bin/codex', platform: 'linux' }`. `start` passes `codex: over.codex ?? codex`, and so does every other `startDevices` call that passes `orca`. `codexRuns` is emptied in `beforeEach`.
    - A new `describe('codex queue, for Codex outside a pane (docs/specs/2026-11-15-device-codex.md)')`, its Codex hook: `engine: 'codex', sessionId: THREAD, cwd: '/work/api', transcriptPath: join(env.CODEX_HOME, 'sessions', '2026', '11', '15', `rollout-2026-11-15T16-07-59-${THREAD}.jsonl`), hostHints: { TERM_PROGRAM: 'ghostty' }`.
    - `the queue is wired with env.CODEX_HOME and the home directory`: `listed()` is `[{ id, name: 'api', caps: 'sv' }]`; `host().sendTurn(id, 'run the tests')` is `{ ok: true }`; `codexRuns` is `[['/opt/codex/bin/codex', ['queue', '--thread', THREAD, '--message=run the tests'], { cwd: homedir(), env: { CODEX_HOME: env.CODEX_HOME }, timeoutMs: 10_000 }]]`; `said()` is `['[device] voice · codex']`; `orcaRuns` is `[]`.
    - `a Codex session whose transcript is in another home lists s and runs nothing` (`transcriptPath: '/elsewhere/.codex/sessions/…'`).
    - `a failed queue is said in one line with its exit code, then today's route answers`: `run` answers 1; `sendTurn` matches `{ ok: false, message: 'api did not answer.' }`; `said()` is `['[device] voice · codex-failed (exit 1)', '[device] voice · no-answer']`.
    - `a codex that could not start is said with no binary`: `run` answers `'not-started'`; `said()` is `['[device] voice · codex-failed (no binary)', '[device] voice · no-answer']`.
    - `with no codex binary the session lists s, and nothing runs or is said` (`binary: () => null`): the spec's first failure case.
    - `a queue that times out is said once, and nothing is typed`: the session with an Orca handle, `run` answers `'unknown'`; `said()` is `['[device] voice · codex-timeout']`; `orcaRuns` is `[]`.
    - `no log line carries the thread id, the words, the transcript's path or the Codex home`.
    - The existing tests stay as they are: their Codex session `cx-1` is no UUID, so it keeps today's route.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts src/services/devices.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Give `codexQueue` and `codexHome` to every `ObservedActions` literal (`git grep -n "orcaSend" -- cli/src cli/e2e`). The comment over `send` says why the queue comes before the state checks: a queued message types nothing and answers no approval (the spec's spike). The one over the record says why it is made before the command runs: the queued turn's hook can be heard before `codex queue` has exited.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/services/devicesProcess.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`, the core's file list unchanged, and no finding for `cable/hosts/codexQueue.ts`'s import of `lib/engineBin.ts` ("Layers").
- [ ] **Step 5: Commit** `dial: Codex outside Harness takes voice through codex queue, in every state`.

### Task 3: End to end: a working Codex takes the dial's words

**Layer:** test. **Depends on:** Task 2. **Effort:** `high`.

**Red test:** none: no behavior (it adds the end-to-end test of what Tasks 1 and 2 built, and teaches the suite's fake engine one subcommand).

**Files:**
- Create: `cli/e2e/deviceCodex.e2e.ts`, `cli/e2e/harness/codexOutside.ts`
- Modify: `cli/e2e/harness/fakeEngine.mjs`

**Interfaces:**
- **The fake `codex` is the suite's fake engine**, at `<root>/bin/codex`. Every test daemon's environment names it: `CODEX_PATH` is `<root>/bin/codex`, and `PATH` starts with `<root>/bin` (`e2e/harness/daemon.ts`). So `engineBin('codex')` answers that path and `resolveBinaryOnPath` finds it (checked 2026-11-15; the master hands its environment to each service process). Without this task, `codex queue` under a test daemon would start a fake Codex session.
- `fakeEngine.mjs`, for `codex` with `args[0] === 'queue'`, beside the `app-server` case and before the launch ledger:
  - It reads `--thread <id>` and the `--message=<text>` argument.
  - An id that is no UUID, or with no `rollout-*-<id>.jsonl` under `<CODEX_HOME>/sessions`: a message on stderr, exit 1, nothing written (the spike's row "A thread not in that home; a malformed id").
  - Else it appends one line to `<root>/codex-queue`: `JSON.stringify({ args, codexHome: process.env.CODEX_HOME ?? null })`, and exits 0.
  - It writes nothing to `launch-argv`, runs no hook and starts no session. The file's header gains one line for it.
- `codexOutside.ts`: Codex outside Harness, told by its own hooks, as `inOrca.ts` tells Claude Code. `inOrca.ts` is not changed: it is Claude Code's settings and Orca's variables, and the other dial files depend on it.
  ```ts
  export class CodexOutside {
    readonly sessionId: string        // randomUUID()
    readonly cwd: string              // <projectsDir>/<folder>, made
    readonly transcriptPath: string   // <CODEX_HOME>/sessions/2026/11/15/rollout-2026-11-15T00-00-00-<sessionId>.jsonl
    constructor(d: IsolatedDaemon, folder: string, children: ChildProcess[], hints: Record<string, string>)
    get id(): string                  // observedAgentId('codex', sessionId)
    hook(event: 'SessionStart' | 'UserPromptSubmit', fields?: Record<string, unknown>): Promise<void>
  }
  ```
  - The constructor writes the rollout with one `session_meta` line, as the fake engine writes a Codex rollout's first line.
  - `hook` runs the command the daemon installed in `<CODEX_HOME>/hooks.json` for that event (the one that names `notify.mjs`), through `/bin/sh -c`, with `{ session_id, cwd, transcript_path, hook_event_name, ...fields }` on stdin and `{ ...d.env, ...hints }` as its environment, and expects exit 0.
- Consumes: `IsolatedDaemon`, `until`, `Desk`, `FakeDial`, `FakeBackend`, as `dialPaneFollow.e2e.ts`'s spoken case uses them (the daemon signed in as a fixture machine by `auth/session.json`, `relay.speech`).

- [ ] **Step 1: Write** the fake engine's `queue` case and `codexOutside.ts`.
- [ ] **Step 2: Write the test** in `deviceCodex.e2e.ts`, a daemon of its own, `CABLE_DISABLE: 'false'`, a dial with no `appFilter`:
  - `a working Codex in Ghostty takes the dial's spoken words: one codex queue call with its thread and the words, under the daemon's Codex home`:
    1. `const codex = new CodexOutside(d, 'api', children, { TERM_PROGRAM: 'ghostty' })`; its `SessionStart` (`{ source: 'startup' }`); the dial hears its `agent` row, and the row's `caps` holds `v`.
    2. Its `UserPromptSubmit` (`{ prompt: 'work on it' }`); the dial hears `turn.started` for it. Codex has no end-of-turn hook and no process here, so it stays working.
    3. `relay.speech = 'run the spoken tests'`; the dial sends `voice.begin` (`agentId: codex.id`), one audio chunk and `voice.end`; it hears `{ t: 'voice.transcript', text: 'run the spoken tests', agentId: codex.id }`.
    4. The lines of `<d.root>/codex-queue`, parsed, are `[{ args: ['queue', '--thread', codex.sessionId, '--message=run the spoken tests'], codexHome: d.env.CODEX_HOME }]`.
    5. The daemon's log has `[device] voice · codex`. It holds neither `codex.sessionId` nor `codex.transcriptPath`, and no `[device]` line holds `run the spoken tests`.
- [ ] **Step 3: Run** `cd cli && npm run typecheck && npx vitest run --config vitest.e2e.config.ts e2e/deviceCodex.e2e.ts e2e/deviceClaudeOrca.e2e.ts e2e/dialPaneFollow.e2e.ts e2e/deviceWithoutApp.e2e.ts`. Expected: PASS.
- [ ] **Step 4: Commit** `e2e: a working Codex outside Harness takes the dial's words through codex queue`.

Nothing registers the file: `vitest.e2e.config.ts` finds `e2e/**/*.e2e.ts`, a file with no hint in `cli/ci-e2e-durations.json` costs the default, and `ci.yml`, `scripts/tests/test_ci_plan.py` and `docs/validation-and-release.md` name no end-to-end file.

### Task 4: Say it in the docs

**Layer:** repo files. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: no behavior.

**Files:**
- Modify: `cli/AGENTS.md`, `docs/specs/2026-11-13-device-claude-orca.md`

- [ ] **Step 1:** Write the changes, in each file's own words and length:
  - `cli/AGENTS.md`, the devices row of the processes table, after "their waiting prompts and voice": Codex outside a pane takes the dial's voice through `codex queue`, which the devices process runs itself (`cable/hosts/codexQueue.ts`).
  - `docs/specs/2026-11-13-device-claude-orca.md`: where it says a working agent with no mod (Codex) is told busy, and where it says Codex's own adapter comes later, one sentence each that points at `2026-11-15-device-codex.md`: a Codex session in Harness's own Codex home now takes voice in every state.
- [ ] **Step 2:** Check every link resolves.
- [ ] **Step 3: Commit** `docs: Codex outside Harness takes the dial's voice through codex queue`.

---

## Verification

**Platforms the pull request names:** the daemon on macOS and Linux (tested: check 1 on this Mac and on Linux runners, check 2 on this Mac). Windows: nothing changes, and a unit test says the queue is never used there.

**Temporary workflow:** none. The one long check has a workflow of the repo's own (check 1), and check 2 needs a real Codex and a terminal.

**Turns.** The tester asks the orchestrator before the one hand-started GitHub run (check 1).

**Local gates**, recorded in the pull request (PR CI does not run them):
- `cd cli && npm run typecheck && npm run test:core`: 100% per file for `services/devices.ts`.
- `cd cli && npx vitest run src/architecture.spec.ts src/leanEntry.spec.ts`: the core's file list is unchanged. `git diff --stat origin/main -- cli/src/core cli/src/architecture.coreFiles.txt` prints nothing.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit (`cli-core`); its receipt goes in the pull request.
- Not needed: `npm run test:harnessd`, the serial and PTY specs, `cargo test` in `device-app`, `make device-test`.

**1. The real daemon, a fake dial, the suite's fake `codex`**
- Run, on this Mac, at the final head: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceCodex.e2e.ts e2e/deviceClaudeOrca.e2e.ts e2e/dialPaneFollow.e2e.ts e2e/deviceWithoutApp.e2e.ts e2e/devicesProcess.e2e.ts`.
- Isolation: the suite's own (`e2e/harness/daemon.ts`). A throwaway home, data folder and Codex home, a private port and tmux server, fake engines, a fake dial on a pseudo-terminal, a fake backend on loopback for the speech. No account. The real `codex`, `~/.codex`, the everyday daemon (18473) and production are not touched.
- A person sees: every test passes. The new test's daemon log has `[device] voice · codex`, and `<root>/codex-queue` holds one line.
- On GitHub, by hand, once on the final head: Actions → CLI end to end → Run workflow, branch `feat/device-codex` (`.github/workflows/cli-e2e.yml`). Every shard passes: the new file on Linux, and every other file on the changed fake engine. The link goes in the pull request. The nightly run keeps the new file running after the merge.

**2. The real Codex, once (the spec's Verification)**
- Where: this Mac, at the final head, with nothing of Diego's. The real `codex` 0.167.0 at `~/.nvm/versions/node/v22.23.5/bin/codex`. Never the everyday daemon (18473), `~/.codex`, Diego's tmux server or his dial.
- The driver: a throwaway copy of `cli/e2e/deviceCodex.e2e.ts` at `cli/e2e/tmp-deviceCodexReal.e2e.ts`. It is never staged or committed, and it is deleted after the run (`git status --short` then shows nothing of it). It differs from the test in four places:
  1. **The real `codex`.** `d.env.CODEX_PATH` is the path above, set before `d.start()`, as `eagerHooks.e2e.ts` sets its own. The suite points it at its fake engine, and `CODEX_PATH` is what the queue runs. Nothing is added to the daemon's `PATH`. Whatever else the daemon runs Codex for (a rate-limit read) then runs the real one too, under the same throwaway home, where no account is.
  2. **The Codex home.** `<root>/codex` (`d.env.CODEX_HOME`). Before `d.start()` the driver writes its `config.toml`, from the spike's (`…/scratchpad/codex-home/config.toml`): `check_for_update_on_startup = false`, `model_provider = "mock"` with `base_url = "http://127.0.0.1:<port>/v1"`, `approval_policy = "on-request"`, `sandbox_mode = "read-only"`, and the work folder trusted. The daemon then installs its Codex hooks there.
  3. **The model.** A copy of the spike's mock Responses server (`/private/tmp/claude-503/-Users-duynguyen-orca-workspaces-autonomous-harness-wave1-codex/83a2fce1-f047-4989-b605-1c082270104d/scratchpad/mock/server.mjs`), on a free loopback port, with a log file. No account, no secret. A prompt with `slow` holds its turn 10 s; one with `approve` asks to run `touch approved.txt` outside the sandbox.
  4. **The session.** The real TUI, not `CodexOutside`, in a tmux server of its own. The driver starts it with the daemon's own environment (`d.env`: its home, its Codex home, `CODEX_PATH`), so its hooks reach this daemon: `tmux -L codex-check new-session -d -x 120 -y 40 -c <root>/projects/work 'env -u TMUX -u TMUX_PANE "$CODEX_PATH" --no-daemon'`.
     - By its path, never by name: `codex` on that `PATH` is the suite's fake engine.
     - `-L codex-check` is a server apart from the daemon's own, whose panes the daemon takes for its own agents.
     - `TMUX_PANE` must be unset for Codex: with it the hook takes the session for a pane and tells the devices nothing (`hook/notify.mjs`, `paneless`).
     - `--no-daemon`, so no Codex daemon is left running. The TUI then reads its queue about every 10 s.
     - If the TUI asks to review hooks, trust them: they are the daemon's own.
- Isolation, besides: `IsolatedDaemon`'s throwaway root (home, data, auth, a free port, its own tmux server) and the suite's `FakeBackend` for the speech. Nothing leaves loopback.
- The tester does, with `tmux -L codex-check send-keys` and `capture-pane`, and sees:
  1. **Listed.** The dial hears the session's `agent` row with `v` in its `caps`.
  2. **Idle.** The dial speaks `say one`. It hears `voice.transcript`. Within 15 s the TUI shows a turn `say one` and `mock reply … to: say one`; the mock's log has `user="say one"`.
  3. **Working.** `slow one` typed into the TUI. While it works, the dial speaks `say two`: `voice.transcript` at once, and nothing appears in the composer. Within about 10 s of the slow turn's reply, a turn `say two` starts by itself.
  4. **Waiting on an approval.** `approve this` typed into the TUI: its approval prompt opens. The dial speaks `yes`: `voice.transcript`. 15 s later the prompt is still open and `<root>/projects/work/approved.txt` does not exist. The tester answers No in the TUI. Within about 10 s of that turn's end, a turn `yes` starts as a message of its own.
  5. **The hooks.** For each of the three queued turns the dial hears `turn.started` for the session as it starts, and the daemon's log has `[device] prompt · skipped · dial prompt`. This shows Codex runs its prompt hook for a queued message, which the rule that the dial's own queued words do not turn the dial rests on (the spec, `observed.ts`; PM, 2026-11-15). If it does not, report that as a finding.
  6. **The log.** Three `[device] voice · codex` lines, and no `codex-failed` or `codex-timeout` line. No line holds the thread id, a path or the words.
- That the three queue calls exit 0 also shows the hook's session id is the thread id `codex queue` takes.
- Evidence: the pane captures, the daemon's `[device]` lines, the mock's log.
- Afterwards: `/quit` in the TUI, `tmux -L codex-check kill-server`, stop the mock, close the daemon (the driver's `afterEach`), delete the driver.
- Not done, for whatever reason: report it as not verified, never as passed.
- On GitHub: none. It needs the real Codex binary and a terminal.

**3. In PR CI, by itself:** `cli-typecheck` and `cli-tests` run Tasks 1 and 2's specs on Linux. Nothing is started by hand.

## Decided (PM, 2026-11-15)

The plan's first four open questions, as answered. The spec holds each.

1. **Where `codex` is looked for.** The Codex Harness launches: `engineBin('codex')` (`CODEX_PATH`, else `codex`), resolved with `resolveBinaryOnPath` on the daemon's `PATH`. No login-shell probe. (Task 1: `binary`.)
2. **The dial's own queued words do not turn the dial.** The pane-follow rule holds for the queue: the mark is recorded before the command runs and kept only on `queued`. Verification 2, step 5 shows Codex runs its prompt hook for a queued message. (Task 2.)
3. **A failed queue's log is one line:** `[device] voice · codex-failed (exit N)` or `[device] voice · codex-failed (no binary)`. `send` answers `failed` with its reason, and `count` takes it. The queue logs nothing. (Tasks 1 and 2.)
4. **After a failed queue:** today's checks and today's sentences. `<name> did not answer.` only when ended or with no handle. (Task 2.)

## Open questions

The draft is written on the answer marked **Draft**.

1. **The reason in the log when the queue refuses the words before it runs anything.** The spec names two reasons, `exit N` and `no binary`. A third case exists: a thread id that is no UUID, an empty text, one over 2,000 characters or one with a NUL. Through the observed source only an empty text or a NUL can get that far (a broken dial); the id and the length are checked first. Nothing ran, and the binary may be there, so neither reason is true of it. **Draft:** a third reason, `[device] voice · codex-failed (refused)`, then today's route answers. The other way: say `no binary` for it too, and keep the log to the spec's two forms. (Task 1: `CodexQueueFailure`, one test; Task 2: one test.)

## Decided here, where the spec was silent

- **Windows.** `can()` is false there, so nothing changes on Windows. `codex` is a `.cmd` shim there, which runs only through a shell, and the text must never meet one.
- **An ending that is neither an exit code nor the deadline** (a signal, an output over the buffer) counts as a timeout: only a non-zero exit and a binary that did not start are definite failures.
- **A thread id or a text the queue will not take** (no UUID, empty, over 2,000, a NUL) answers `failed` and runs nothing. The observed source checks the id and the length first, so this is a second guard. Its reason in the log is Open question 1.
- **A failure's reason is the text the log shows** (`exit 1`, `no binary`), made once, in the queue. `count` takes it inside its route, so the devices' log line stays as it is and nothing formats it a second time.
- **`CODEX_PATH` that names a missing file** answers no binary: the queue does not look for another `codex`, as a launch would not.
- **`run`'s `env`** is what is set over the process's own environment, so a test names `CODEX_HOME` alone. The real `run` ends the child's stdin at once.
- **`can()` is asked last and never kept.** The cost is one look for the binary (one file check with `CODEX_PATH`, else one walk of `PATH`) for each queue-able Codex session each time the dial's list is built, and a `codex` installed or removed is seen at the next look.
- **`timeout` is counted once**, as `codex-timeout`, with no `no-answer` beside it.
- **`CODEX_THREAD` lives in `codexQueue.ts`**, and `observed.ts` imports it, as it imports `ORCA_HANDLE`. `MAX_TEXT` stays in `orca.ts`.
- **`DevicesDeps.codex`** stands beside `DevicesDeps.orca`, so no spec of the service runs the developer's real `codex`.
- **The end-to-end fake is the suite's fake engine**, which learns `queue`, as cli/AGENTS.md rule 5 asks ("extend the fake engine faithfully"). A second `codex` earlier on `PATH` would be a second fake of one program.
- **The end-to-end session is told by its hooks** (`CodexOutside`), not run as a fake engine: Codex has no end-of-turn hook, so a hook-told session stays working for as long as the test needs.
- **The end-to-end test speaks**, through the voice frames and the fake backend's speech, not `turn.send`: a recording is refused for an agent with no `v`, so the new capability is on the path.
- **The docs task** is not in the spec. `cli/AGENTS.md` lists what the devices process does, and the wave 1a spec still says a working Codex is told busy.
- **The real-Codex check runs `--no-daemon`.** The 0.4 s start with Codex's own daemon is the spike's measurement and is not taken again.
