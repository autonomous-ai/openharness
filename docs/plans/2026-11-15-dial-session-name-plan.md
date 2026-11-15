# The dial names a session as the person named it — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use diegodev phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The round dial shows a session outside a pane by the name the person gave it ("Tho"), sent by the session's own hook, and by its folder only when it has no name.

**Architecture:**
- **The hook** (`cli/hook/notify.mjs` `observedBody`) puts the hook input's `session_title` on the body it already posts, as one optional field `title`, cut and checked with the core's own bounds, on `session-start` and `turn-start` only.
- **The core** (`cli/src/core/observedHook.ts` `parseObservedHook`) checks `title` and hands it on with the event. It keeps nothing and logs nothing of it, as it does for `relayed`.
- **The devices process** (`cli/src/cable/hosts/observed.ts`) names the agent by its title, else its folder, else its engine. The name reaches the dial as any agent's name does: it is in the list's key (`CableSession.agentsKey`), so a rename re-sends the list.
- Nothing reads a transcript, the Claude app's stores or another session's files. No firmware, no Desktop, no Flutter.

**Tech Stack:** plain JavaScript for the hook (Node), TypeScript for the daemon's core and devices process (vitest, `cli/`), the CLI's end-to-end harness (`cli/e2e/harness/`).

**Spec:** `docs/specs/2026-11-15-dial-session-name.md`.

## Base

- Code starts when the orchestrator says: after #4326 and #4331 have merged (#4311 merged as `f979a5c6c3`). Implementers start from `fix/dial-session-name` rebased on `origin/main` after both.
- Check the base before Task 1, and stop and tell the orchestrator if a line fails:
  - `git log --oneline origin/main | grep -E '\(#(4326|4331)\)'` shows both, and `git merge-base --is-ancestor origin/main HEAD` passes.
  - `cd cli && npm ci` when `cli/node_modules` is missing (it is, in this worktree today).
- Read against: `main` at `f979a5c6c3`, #4331 at `c6f5b7ecd6`, #4326 at `ad5df93a9c`. In all three these are the same: `observedBody`, `parseObservedHook` (with `relayed`, which landed with #4311), `InOrca.hook(event, fields)`, `cli/e2e/deviceClaudeOrca.e2e.ts`, and the two naming lines of `observed.ts` (`a.name = basename(e.cwd) || a.name` in `ingest`, `name: (init.cwd && basename(init.cwd)) || engine` in `entry()`). What the two pull requests still change in this plan's files: #4331 `notify.mjs`, `hookNotify.spec.ts`, `observed.ts`, `observed.spec.ts`; #4326 `observed.ts`, `observed.spec.ts`.
- Tasks name code by name, never by line. If a name below is gone after the merges, stop and report.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/core/observedHook.ts` | **Core** (`harnessd-core`): one field checked and handed on | `src/core/observedHook.spec.ts`; 100% per file with `npm run test:core`, which PR CI does not run |
| `cli/hook/notify.mjs` | The hook: the session's own process, as the session's user | `src/hookNotify.spec.ts` (PR CI) |
| `cli/src/cable/hosts/observed.ts` | **Devices service process** (`harnessd-devices`) | `src/cable/hosts/observed.spec.ts` (PR CI) |
| `cli/e2e/deviceClaudeOrca.e2e.ts` | Test: the real daemon, the installed hook, a fake dial | By hand on this Mac; `cli-e2e.yml` by hand |

Checked, and unchanged by this work:
- `cli/src/architecture.coreFiles.txt`: `core/observedHook.ts` is already its line 102 and gains no import, so no line is added.
- `cli/src/core/AGENTS.md`: its sentence on `observedHook.ts` ("checked, bounded and rate limited, then handed to the devices and kept nowhere in the core") stays true. `cli/AGENTS.md` and `cli/src/services/AGENTS.md` list no field of the observed body.
- `cli/src/hookServer.ts`, `core/devicesLink.ts`, `services/devicesProcess.ts`, `services/devices.ts`: the event crosses as it is, as `relayed` does.
- `cli/src/cable/cableSession.ts`, the firmware (`CABLE_NAME_MAX` 40 bytes), Desktop.

## Start order

diegodev starts a task when the tasks it depends on are done and no running task shares its files. No two tasks share a file.

| Task | Depends on | Effort |
|---|---|---|
| 1 The core takes a title | none | `xhigh` |
| 2 The hook says the title | 1 (`MAX_TITLE`, and the parser its tests feed) | `high` |
| 3 The devices name an agent by its title | 1 (`ObservedHookEvent.title`) | `high` |
| 4 End to end | 2, 3 | `high` |

Longest chain: 1 → 2 → 4 (and 1 → 3 → 4): three tasks. Tasks 2 and 3 run side by side.

## Global Constraints

- **One field.** `title`, optional, on the existing observed body. No new route, message, file, import, state, counter or log line in the core.
- **Bounds.** A non-empty string of at most 64 UTF-16 units (`MAX_TITLE`, the unit the core's `bounded` counts), with no control character (`[\u0000-\u001f\u007f]`), on `session-start` and `turn-start` only.
- **The hook** reads `session_title` and nothing else for it: whitespace runs folded to one space, trimmed, cut to 64 units without splitting a surrogate pair, trimmed again. An empty result, or one with a control character left, is left out. Any engine whose hook sends `session_title` gets it.
- **The 4096-byte body.** `transcriptPath` is dropped first, then `cwd`, as today. The title is never dropped.
- **The core** refuses the whole event for a bad title, or a title on any other event (`asked` included, checked before its early return). It keeps nothing and logs nothing of it.
- **The name** of an agent outside a pane: its title, else the name of its last known folder (`a.cwd`), else the engine. A `session-start` or `turn-start` with a title sets it. A Claude Code `session-start` or `turn-start` with none clears it. Another engine's event with none leaves it. Every other event leaves it.
- **No reads.** Nothing reads the Claude app's stores, another session's files, a transcript's title lines or any conversation content.
- **Data.** The title is in memory only, while the agent is listed. Never on disk, in a log, an error, a measure, the backend, the phone or the gateway. No new measure.
- **Not in this pull request:** the check on the real Claude app (with Diego, later); moving the observed path out of the core; the firmware's 40-byte cut.
- **Repo rules.** Tests never touch the real `~/.claude`, the everyday daemon (18473), the real tmux server or a real dial. No fixed sleeps. `src/core` stays at 100% per file. Comments say why.
- **Commits.** A task with a red test is two commits: its failing tests (`… (red)`), then the code. Nobody commits the plan or the spec from a task.

## Review Focus

1. **The hook's cut and the core's bound drift apart.** A title the hook cut must always be one the core takes, or a named session loses its `session-start` and `turn-start` whole. Task 2: `the hook cuts a title at the core's bound, and the core takes what it cut`.
2. **The title in a log.** A refused event, a scan, a full table: no line may hold it. Task 1: `counts a refused title and logs none of it`. Task 3: `no log line holds a title`. Task 4: the daemon's log has no `7f3a91c2`.
3. **Names outside ASCII and JSON's own characters** ("Thơ", "gà", `"`, `\`, CJK, an emoji) arrive as they were typed. Task 1: `takes 64 UTF-16 units, letters outside ASCII and JSON's own characters`. Task 2: the `'Thơ "gà" \\ 数学 🙂'` row.
4. **A `session-start` in the middle of a turn** (Claude Code's compaction) with a new title renames the agent and leaves it working. Task 3: `a session-start in the middle of a turn renames it and leaves it working`.
5. **A rename with nothing else changed** (the turn already runs) must still reach the dial. Task 4: the second `UserPromptSubmit`.

---

### Task 1: The core takes a title

**Layer:** core. **Depends on:** none. **Effort:** `xhigh` (input validation in the most trusted process).

**Red test:** `parseObservedHook: title` in `cli/src/core/observedHook.spec.ts`.

**Files:**
- Modify: `cli/src/core/observedHook.ts`
- Test: `cli/src/core/observedHook.spec.ts`

**Interfaces:**
- Produces: `export const MAX_TITLE = 64`.
- Produces: `ObservedHookEvent.title?: string`. `ObservedAsked` gains nothing.
- Produces: `parseObservedHook` returns `title` on a `session-start` or `turn-start` that has a good one, has no `title` key otherwise, and returns `null` for a bad one.

- [ ] **Step 1: Write the failing tests,** a `describe('parseObservedHook: title', …)` after the `relayed` one, with `const named = (event: string, title: unknown) => ({ ...full, event, title })`:
  - `it.each(['session-start', 'turn-start'])('takes a title on %s and hands it on')`: for `body = named(event, 'Tho')`, `parseObservedHook(body)` is `toStrictEqual(body)`; `createObservedHook({ forward, now: () => 7 }).onObserved(body)` is `'ok'` and `forward` was called with `body`.
  - `takes 64 UTF-16 units, letters outside ASCII and JSON's own characters`: `'x'.repeat(64)`, `'😀'.repeat(32)` and `'Thơ "gà" \\ 数学'` each parse `toStrictEqual`.
  - `takes a title beside relayed`: `{ ...named('turn-start', 'Tho'), relayed: true }` parses `toStrictEqual`.
  - `an event without a title has no such key`: `{ ...full, event: 'session-start' }` parses `toStrictEqual` itself.
  - `it.each(…)('rejects a title %s')`, on both events, each `toBeNull()`: `'x'.repeat(65)`, `'😀'.repeat(33)`, `''`, `'Th\u0007o'`, `'Th\no'`, `'Th\u007fo'`, `7`, `null`, `true`, `{ text: 'Tho' }`, `['Tho']`.
  - `it.each(['needs-input', 'turn-stop', 'turn-error', 'session-end', 'asked'])('rejects a title on %s')`: the body parses without a title, and is `null` with `title: 'Tho'`. The `asked` body is `{ engine: 'claude', sessionId: 's1', event: 'asked' }`.
  - `counts a refused title and logs none of it` (fake timers, put back after; `forward: () => true`, `now: () => 0`, `log = vi.fn()`): `onObserved(named('turn-start', 'secret-title'))` is `'ok'`; `named('turn-stop', 'secret-title')` and `named('turn-start', 'secret\u0007title')` are `'invalid'`; after `vi.advanceTimersByTime(60_000)`, `log.mock.calls` equals `[['[devices] paneless hook events in the last minute: 2 refused, 0 dropped']]`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/core/observedHook.spec.ts`. Expected: FAIL (the parsed event has no `title`; a bad title is not refused).
- [ ] **Step 3: Implement** in `parseObservedHook`:
  - Read `title` from the body with the other fields.
  - One check, after the `relayed` check and before `if (event === 'asked')`: return `null` when `title !== undefined` and the event is neither `session-start` nor `turn-start`, or `!bounded(title, MAX_TITLE)`, or `title === ''`.
  - The returned hook event gains `...(title === undefined ? {} : { title })`.
  - The comment on `MAX_TITLE` says the hook cuts to as many (`hook/notify.mjs`). The one on `title` says it is the session's own name for itself, handed on and kept nowhere here.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/core/observedHook.spec.ts src/architecture.spec.ts && npm run typecheck && npm run test:core`. Expected: PASS; `core/observedHook.ts` reads 100 in all four columns; the core's file list is unchanged.
- [ ] **Step 5: Commit** `core: a paneless session-start or turn-start may say the session's title, one bounded string and nothing else`.

### Task 2: The hook says the title

**Layer:** the hook. **Depends on:** Task 1. **Effort:** `high`.

**Red test:** the title cases in `describe('hook notify: a session outside a pane', …)`, `cli/src/hookNotify.spec.ts`.

**Files:**
- Modify: `cli/hook/notify.mjs`
- Test: `cli/src/hookNotify.spec.ts`

**Interfaces:**
- Consumes: `MAX_TITLE` and `parseObservedHook` (Task 1), imported beside `MAX_HINTS`.
- Produces: the observed body's `title`, a string, present only on `session-start` and `turn-start`.
- Produces, in `notify.mjs`: `const MAX_TITLE = 64` on one line (the test reads the literal), and `function observedTitle(value)`, which returns the title to send or `undefined`.

- [ ] **Step 1: Write the failing tests.** A local helper `posted(input, env = noHints, engine?)`: one `collect()`, one `runHook` with `{ session_id: 'sess-1', cwd: '/w', ...input }`, exactly one request to `/api/hook/observed`, returns its body.
  - `it.each([['SessionStart', 'session-start'], ['UserPromptSubmit', 'turn-start']])('a Claude %s with session_title posts title')`: `session_title: 'Tho'` gives `toMatchObject({ event, title: 'Tho' })`.
  - `it.each(…)('a title %s is posted as %j')`, on `UserPromptSubmit`:

    | `session_title` | `title` |
    |---|---|
    | `'  Fix \t\n login   screen '` | `'Fix login screen'` |
    | `'x'.repeat(70)` | `'x'.repeat(64)` |
    | `` `${'x'.repeat(63)}😀tail` `` | `'x'.repeat(63)` |
    | `` `${'x'.repeat(62)}😀tail` `` | `` `${'x'.repeat(62)}😀` `` |
    | `` `${'x'.repeat(63)} yz` `` | `'x'.repeat(63)` |
    | `'Thơ "gà" \\ 数学 🙂'` | the same |
  - `it.each(…)('a title %s is left out, and the event is still posted')`: `''`, `' \t\n '`, `'Th\u0007o'`, `'Th\u007fo'`, `7`, `{ text: 'Tho' }`, and no `session_title`: `event` is `'turn-start'` and the body does `not.toHaveProperty('title')`.
  - `it.each(…)('no title on %s')`, each with `session_title: 'Tho'`: `Stop`, `StopFailure`, `SessionEnd`, and `Notification` with `notification_type: 'permission_prompt'`.
  - `another engine's hook that sends session_title posts it too`: `engine: 'codex'`, `UserPromptSubmit`.
  - `with an oversized body, transcriptPath goes, then cwd, and title stays`: `cwd` and `transcript_path` are `` `/${'日'.repeat(1000)}` ``, `session_title` is `'日'.repeat(64)`. With `noHints`: no `transcriptPath`, `cwd` kept, `title` kept. With every hint `'日'.repeat(64)`: neither path, `title` and the hints kept, and the body is at most 4096 bytes.
  - `a body with every field at its bound keeps its title and both paths`: hints of `'h'.repeat(64)`, both paths `` `/${'d'.repeat(1023)}` ``, `session_id` `'s'.repeat(128)`, `session_title` `'x'.repeat(64)`, a `<cross-session-message from="a1">x` prompt: `toMatchObject` with `relayed: true`, `title`, `cwd`, `transcriptPath` and the hints, under 4096 bytes.
  - `the hook cuts a title at the core's bound, and the core takes what it cut`: `Number(/const MAX_TITLE = (\d+)/.exec(readFileSync(HOOK, 'utf8'))?.[1])` is `MAX_TITLE`; the body for `'😀'.repeat(40)` has `title: '😀'.repeat(32)`; for that body and for the `'Thơ "gà" \\ 数学 🙂'` one, `parseObservedHook(body)` is `toEqual(body)`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/hookNotify.spec.ts -t "outside a pane"`. Expected: FAIL (no `title` in the body; `MAX_TITLE` not in the hook).
- [ ] **Step 3: Implement.**
  - `observedTitle(value)`, in this order: not a string, none; fold `/\s+/g` to one space and trim; when longer than `MAX_TITLE`, keep the first `MAX_TITLE` units, drop a last unit that is a high surrogate (`\ud800` to `\udbff`), and trim again; empty, or `CONTROL` matches, none.
  - `observedBody`: when `kind` is `session-start` or `turn-start`, set `body.title` to `observedTitle(input.session_title)` when it gave one, before the size check. The size check does not change.
  - `observedBody`'s comment gains why the title is never dropped: at most 64 units, it fits beside the hints and ids once both paths are gone, so a missing title always means the hook sent none.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/hookNotify.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `hook: a session outside a pane says its title, cut to the core's bound`.

### Task 3: The devices name an agent by its title

**Layer:** devices service process. **Depends on:** Task 1. **Effort:** `high`.

**Red test:** `describe('ObservedSource and the name a session gives itself', …)` in `cli/src/cable/hosts/observed.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts`
- Test: `cli/src/cable/hosts/observed.spec.ts`

**Interfaces:**
- Consumes: `ObservedHookEvent.title?: string` (Task 1). The spec file's `ev(event, over)` takes it as it is.
- Produces: no new export. `HostAgent.name` of an agent outside a pane is its title, else its folder's name, else its engine. `HostAgent` gains no field.
- Module-private: `Entry.title?: string`, and `folderName(cwd: string | undefined, engine: string): string`, which is `(cwd && basename(cwd)) || engine`.

- [ ] **Step 1: Write the failing tests** (each its own `setup()` as the file has it, reading `src.list()[0]`):
  - `a title names the agent, a new one renames it, a turn-stop keeps it, and a Claude turn-start with none reads the folder again`, one case, in this order:
    1. `ev('turn-start', { title: 'Tho', cwd: '/x/scratch-2016' })` gives `{ name: 'Tho', cwd: '/x/scratch-2016' }`.
    2. `ev('turn-start', { title: 'Math' })` gives `name: 'Math'`, and `changes` was called for it.
    3. `ev('turn-stop', { cwd: '/x/other' })` gives `{ name: 'Math', cwd: '/x/other' }`.
    4. `ev('turn-start', { cwd: undefined })` gives `name: 'other'`.
  - `a Claude turn-start with no title and a new folder reads that folder`: after a titled one, `ev('turn-start', { cwd: '/x/third' })` gives `'third'`.
  - `a Claude session-start with no title clears it too`.
  - `a session-start with a title renames a session the scan listed`: `open`, `owners` (`{ pid: 11, engine: 'claude' }`) and `externals` (`{ cwd: '/x/alpha', transcriptPath: '/t/a.jsonl' }`) for `'a'`, `await src.scanOpen()`, name `'alpha'`; then `ev('session-start', { sessionId: 'a', callerPid: 11, cwd: '/x/alpha', title: 'Tho' })` gives `'Tho'`.
  - `another engine's turn-start with no title keeps its title`: `engine: 'codex'`, `sessionId: 'c1'`, with `title: 'Tho'` and then without: still `'Tho'`.
  - `needs-input, asked, turn-error and session-end leave the name`: after a titled `turn-start`, each of them, in that order, leaves `'Tho'`.
  - `with no folder known, a cleared title reads the engine`: `ev('turn-start', { cwd: undefined, title: 'Tho' })` gives `'Tho'`; then `ev('turn-start', { cwd: undefined })` gives `'claude'`.
  - `a session-start in the middle of a turn renames it and leaves it working`: `turn-start` with `'Tho'`, then `ev('session-start', { title: 'Math' })` gives `{ name: 'Math', state: 'working' }`.
  - `a refusal names the agent by its title`: with no actions, `await src.send(src.list()[0], 'hi')` equals `{ ok: false, reason: 'Tho did not answer.' }`.
  - `no log line holds a title`: 51 sessions (`s0` to `s50`) each send a `turn-start` with its own title (`Name 0` to `Name 50`); the 51st is dropped and logged, as all 50 are working. Then one `asked` for `s0`. `logs` is not empty, and `logs.join('\n')` does not match `/Name \d/`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts -t "the name a session gives itself"`. Expected: FAIL (the agent reads `scratch-2016`).
- [ ] **Step 3: Implement.**
  - `entry()` names the new agent with `folderName(init.cwd, engine)`.
  - In `ingest`, the line that sets `a.cwd` and `a.name` becomes three things, in this order: a folder in the event sets `a.cwd`; on `session-start` and `turn-start`, a `title` sets `entry.title`, and none clears it when `e.engine === 'claude'`; then, on every event, `a.name = entry.title ?? folderName(a.cwd, a.engine)`.
  - `asked()` and the scan do not touch the title or the name.
  - The comment on `Entry.title` says why only Claude Code's event with none clears it: its hook says the name on each of these events, and Command Code's `turn-start` is every tool call.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts && npm run typecheck`. Expected: PASS, the file's other tests unchanged.
- [ ] **Step 5: Commit** `dial: an agent outside a pane reads the name its session gives itself, and its folder when it has none`.

### Task 4: End to end: the dial reads the folder, then the name

**Layer:** test. **Depends on:** Tasks 2, 3. **Effort:** `high`.

**Red test:** none: no behavior (it adds an end-to-end test of what Tasks 1 to 3 built).

**Files:**
- Modify: `cli/e2e/deviceClaudeOrca.e2e.ts`

**Interfaces:**
- Consumes: the file's own `fresh()`, `plugged(desk)` and `children`; `InOrca` and `InOrca.hook(event, fields)` (`e2e/harness/inOrca.ts`), whose `fields` go into the hook's input; `FakeDial.next(test, ms, what, since)` and `FakeDial.messages`; `IsolatedDaemon.log()`.
- The fake engine sends no `session_title`, so the test drives the installed hook directly.

- [ ] **Step 1: Write the test** `the dial reads a session by its folder, then by the name its hook says, and no log holds the name`, and add its line to the file's header comment:
  1. `fresh()`, `plugged(desk)`, `new InOrca(d, 'scratch-2016', children)`.
  2. `claude.hook('SessionStart', { source: 'startup' })`; the dial hears an `agent` row with `id === claude.id` and `name === 'scratch-2016'`.
  3. `claude.hook('UserPromptSubmit', { prompt: 'say hi', session_title: 'Tho' })`; since that call, the dial hears the row with `name === 'Tho'`.
  4. `claude.hook('UserPromptSubmit', { prompt: 'again', session_title: 'Math 7f3a91c2' })`; since that call, the row with `name === 'Math 7f3a91c2'`. The turn already runs, so the name is all that changed.
  5. `expect(d.log()).not.toContain('7f3a91c2')`.
  Each wait is `dial.next(…, 45_000, …, since)`, as the file's other tests wait. No sleep.
- [ ] **Step 2: Run,** on this Mac, `cd cli && npm run typecheck && npx vitest run --config vitest.e2e.config.ts e2e/deviceClaudeOrca.e2e.ts`. Expected: PASS, every test of the file, the new one among them. If `socketRoom` stops the run for a long `TMPDIR`, run it again with `TMPDIR=/tmp`.
- [ ] **Step 3: See it able to fail:** run once with `session_title` taken out of step 3's call. Expected: FAIL with `the dial heard no …`. Put it back; this change is never committed.
- [ ] **Step 4: Commit** `e2e: the dial reads a session outside a pane by its folder, then by its name`.

---

## Verification

**Platforms the pull request names:** macOS (the unit suites and check 1, on this Mac) and Linux (PR CI's unit suites; check 1's GitHub run). Windows: the same JavaScript and TypeScript, with no line that asks the platform; no workflow runs these three spec files on Windows, so it is reported as not run there (Open question 2).

**Temporary workflow:** none. No check here is long: the one end-to-end file runs in a few minutes on this Mac, and the repo's own **CLI end to end** workflow runs it on Linux by hand.

**Workflows:** none changes. The new test sits in a file the nightly CLI end to end run already takes, so it keeps running there with nothing added.

**The pull request says:**
- It adds one field, `title`, to the core's observed path: checked in `core/observedHook.ts`, handed on, kept nowhere, the same pattern as `relayed`. It moves out of the core with the rest of that path in the follow-up to `cli/AGENTS.md` rule 7 (the devices' routes move to `devicesListener`).
- `src/architecture.coreFiles.txt` gains no line, and no doc changes.
- The platforms above, the red-then-green commits, the local gates' receipts, and check 1's run link.
- The check on the real Claude app is done with Diego in the joint test session, not here.

**Turns.** The tester asks the orchestrator before the one hand-started GitHub run in check 1.

**Local gates,** recorded in the pull request (PR CI does not run the coverage gate):
- `cd cli && npm run typecheck`.
- `cd cli && npm run test:core`: 100% per file, `core/observedHook.ts` among them. It is the one gate `python3 scripts/local-checks.py --list` names for this plan's paths.
- `cd cli && npx vitest run src/architecture.spec.ts src/core/observedHook.spec.ts src/hookNotify.spec.ts src/cable/hosts/observed.spec.ts`.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit. Its fence goes in the pull request's body before that head is pushed.
- Not needed: `npm run test:harnessd`, the serial specs, `make device-test`, Harness Device's `cargo test`.

**1. The real daemon, the installed hook, a fake dial**
- Build: nothing. The suite starts the daemon from this checkout's sources. `cd cli && npm ci` first when `node_modules` is missing.
- Run, on this Mac, at the final head: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceClaudeOrca.e2e.ts e2e/deviceWithoutApp.e2e.ts e2e/dialPaneFollow.e2e.ts`. The last two drive the same hook, core and devices path with no title.
- Isolation (`cli/AGENTS.md` rule 6): the suite's own `IsolatedDaemon` (`e2e/harness/daemon.ts`). A throwaway home and data folder, its own port, a private tmux server, fake engines, hooks installed only inside the test's root. The dial is a fake on a pseudo-terminal (`HARNESSD_TEST_DIAL_PORT`). Signed out, no backend. The real `~/.claude`, the everyday daemon (18473), the real tmux server, a real dial, the Claude app and production are not touched.
- A person sees: every test passes. In the new test the dial is sent the agent as `scratch-2016`, then `Tho`, then `Math 7f3a91c2`, and the daemon's log has no `7f3a91c2`.
- On GitHub, by hand, once at the final head: Actions → CLI end to end → Run workflow, branch `fix/dial-session-name` (`.github/workflows/cli-e2e.yml`). Eight Linux shards; every shard passes. Report the run link.

**2. PR CI, nothing started by hand:** `cli-typecheck` and `cli-tests` run the three spec files on Linux; `companions` and `pty-checks` run because `cli/` changed.

**3. With Diego, not this pull request:** a Claude app session renamed in the app reads its new name on the dial after the next prompt. It needs Diego's Claude app, daemon and dial, in the joint test session. No task and no tester does it; nobody reports it as passed.

## Answered (the PM, 2026-11-15)

1. The Design section's review: "Reviewer: P1 builder-check + PM", at the spec's first commit.
2. Windows: not run. The change is the same code there, and the by-hand Windows workflow runs a fixed list without these
   specs; the spec says so under Platforms.
3. The name rule below (title, then folder, then engine) stands.

## Decided here, where the spec was silent

- `MAX_TITLE` is exported from the core. The hook is a plain script that cannot import it, so it holds its own `64`, and Task 2's test reads that literal and compares.
- The title is `Entry.title` inside the observed source, not a field of `HostAgent`: every reader gets it as `name`.
- One way to work out the name: `entry.title ?? folderName(a.cwd, a.engine)`, on every event. A folder with no base name (`/`) reads the engine, at a session's first event as today. Today a later event in `/` kept the earlier folder's name; with the one rule it reads the engine.
- The hook reads `session_title` in that spelling only, as its pane path does.
- The end-to-end test goes in `cli/e2e/deviceClaudeOrca.e2e.ts`, the file the spec names as an example. It adds a second prompt with a name no log line could hold by chance, for Review Focus 2 and 5.
- Task 2 depends on Task 1 only for the test that ties the hook's bound to the core's. Without that test the two bounds could drift unseen.
- No doc changes: no living doc lists the observed body's fields, and the title is part of "the agents outside a pane (from their hooks)" that `cli/AGENTS.md` already gives the devices process.
