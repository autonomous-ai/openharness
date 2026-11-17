# The dial names a session as the person named it — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use diegodev phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The round dial shows a session outside a pane by the name the person gave it ("Tho"), sent by the session's own hook or, for a session the open scan finds, read from the session's own process record, and by its folder only when it has no name.

**Architecture:**
- **The hook** (`cli/hook/notify.mjs` `observedBody`) puts the hook input's `session_title` on the body it already posts, as one optional field `title`, cut and checked with the core's own bounds, on `session-start` and `turn-start` only.
- **The core** (`cli/src/core/observedHook.ts` `parseObservedHook`) checks `title` and hands it on with the event. It keeps nothing and logs nothing of it, as it does for `relayed`.
- **The devices process** (`cli/src/cable/hosts/observed.ts`) names the agent by its title, else its folder, else its engine. The name reaches the dial as any agent's name does: it is in the list's key (`CableSession.agentsKey`), so a rename re-sends the list.
- **The open scan** (`observed.ts` `scanOnce`, decision 5) gives a Claude Code session it lists the name in the session's own process record, `<sessions folder>/<owner pid>.json`, whose path is already the scan's `SessionOwner.record`. The read is a reader of its own (`cli/src/cable/hosts/recordName.ts`), injected as `ObservedDeps.recordName` and wired in `cli/src/services/devices.ts` `observedSource`. It runs in the devices process; nothing in the core changes for it.
- **One cleaner** for a title in TypeScript (`cli/src/cable/hosts/observedTitle.ts`), used by the reader. The hook is one standalone file that can import nothing, so it keeps its own copy of the rule, and a test holds the two together.
- Nothing reads a transcript, the Claude app's stores or another session's files. No firmware, no Desktop, no Flutter.

**Tech Stack:** plain JavaScript for the hook (Node), TypeScript for the daemon's core and devices process (vitest, `cli/`), the CLI's end-to-end harness (`cli/e2e/harness/`).

**Spec:** `docs/specs/2026-11-15-dial-session-name.md`.

## Base

- Code starts when the orchestrator says: after #4331 has merged (#4311 merged as `f979a5c6c3`, #4326 as `aad8dcd535`). Implementers start from `fix/dial-session-name` rebased on `origin/main` after it.
- Check the base before the first task, and stop and tell the orchestrator if a line fails:
  - `git log --oneline origin/main | grep -E '\(#4331\)'` shows it, and `git merge-base --is-ancestor origin/main HEAD` passes.
  - `cd cli && npm ci` when `cli/node_modules` is missing (it is installed in this worktree today, arm64).
- Read against, for Tasks 1 to 4: `main` at `f979a5c6c3`, #4331 at `c6f5b7ecd6`, #4326 at `ad5df93a9c`. In all three these are the same: `observedBody`, `parseObservedHook` (with `relayed`, which landed with #4311), `InOrca.hook(event, fields)`, `cli/e2e/deviceClaudeOrca.e2e.ts`, and the two naming lines of `observed.ts` (`a.name = basename(e.cwd) || a.name` in `ingest`, `name: (init.cwd && basename(init.cwd)) || engine` in `entry()`).
- Read against, for Tasks 5 to 8: `main` at `aad8dcd535` and #4331 at `c6f5b7ecd6`. In both these are the same: `scanOnce` (its `pids` line, `appsOf`, the listing loop, the line `[observed] scan · … found · … app known · … ms`), `ObservedDeps.apps`, `observedSource` in `services/devices.ts` (`apps: learnApps`, `claudeProjectsRoots(env.CLAUDE_PROJECTS_DIR)`), the `readers` stand-ins of `devices.spec.ts`, `recordOwners` (`engines/kit/adoption.ts`, which claims `record: join(dir, file.name)`), `Outside` (`e2e/harness/outsideAgent.ts`) and the fake engine's record (`fakeEngine.mjs` `announceProcess`).
- What #4331 still changes in this plan's files: `notify.mjs`, `hookNotify.spec.ts`, `observed.ts`, `observed.spec.ts`, `services/devices.ts`, `services/devices.spec.ts`.
- Tasks name code by name, never by line. If a name below is gone after the merge, stop and report.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/core/observedHook.ts` | **Core** (`harnessd-core`): one field checked and handed on | `src/core/observedHook.spec.ts`; 100% per file with `npm run test:core`, which PR CI does not run |
| `cli/hook/notify.mjs` | The hook: the session's own process, as the session's user | `src/hookNotify.spec.ts` (PR CI) |
| `cli/src/cable/hosts/observed.ts` | **Devices service process** (`harnessd-devices`) | `src/cable/hosts/observed.spec.ts` (PR CI) |
| `cli/src/cable/hosts/observedTitle.ts` (new) | **Devices service process**: the title's cleaner | `src/cable/hosts/observedTitle.spec.ts` (PR CI) |
| `cli/src/cable/hosts/recordName.ts` (new) | **Devices service process**: the one read of a session's own process record | `src/cable/hosts/recordName.spec.ts` (PR CI) |
| `cli/src/services/devices.ts` | **Devices service process**: one line of wiring in `observedSource` | `src/services/devices.spec.ts`; 100% per file with `npm run test:core`, which PR CI does not run |
| `cli/e2e/deviceClaudeOrca.e2e.ts` | Test: the real daemon, the installed hook, a fake dial | By hand on this Mac; `cli-e2e.yml` by hand |
| `cli/e2e/deviceWithoutApp.e2e.ts`, `cli/e2e/harness/outsideAgent.ts` | Test: the real daemon, the real scan and reader, a fake Claude Code's own record, a fake dial | By hand on this Mac; `cli-e2e.yml` by hand |
| `cli/e2e/dialAppFilter.e2e.ts` | Test: one assertion on the scan's line | By hand on this Mac; `cli-e2e.yml` by hand |

Checked, and unchanged by this work:
- `cli/src/architecture.coreFiles.txt`: `core/observedHook.ts` is already its line 102 and gains no import, so no line is added. The two new files are loaded by the devices process alone; no file of the core's process imports them.
- The scan's own readers, none of which changes: `lib/sessionSearch/externals/types.ts` and `lib/processTable.ts` (core files), `lib/sessionSearch/external.ts` (`SessionOwner.record` already carries the record's path), `lib/sessionSearch/externals/support.ts`, `engines/kit/adoption.ts`, `engines/claude/adoption.ts`, `e2e/harness/fakeEngine.mjs`.
- `cli/src/core/AGENTS.md`: its sentence on `observedHook.ts` ("checked, bounded and rate limited, then handed to the devices and kept nowhere in the core") stays true. `cli/AGENTS.md` and `cli/src/services/AGENTS.md` list no field of the observed body.
- `cli/src/hookServer.ts`, `core/devicesLink.ts`, `services/devicesProcess.ts`: the event crosses as it is, as `relayed` does. `services/devices.ts` hands the event on unchanged too; its one change is the scan's reader (Task 7).
- `cli/src/cable/cableSession.ts`, the firmware (`CABLE_NAME_MAX` 40 bytes), Desktop.

## Start order

diegodev starts a task when the tasks it depends on are done and no running task shares its files. Two tasks share files: 3 and 7 (`observed.ts`, `observed.spec.ts`), and 7 depends on 3, so they never run at once. No other two tasks share a file.

| Task | Depends on | Effort |
|---|---|---|
| 1 The core takes a title | none | `xhigh` |
| 2 The hook says the title | 1 (`MAX_TITLE`, and the parser its tests feed), 5 (`observedTitle`, which one of its tests compares with) | `high` |
| 3 The devices name an agent by its title | 1 (`ObservedHookEvent.title`) | `high` |
| 4 End to end: the hook's name | 2, 3 | `high` |
| 5 One cleaner for a title | none | `medium` |
| 6 The reader of a session's own record | 5 (`observedTitle`) | `xhigh` |
| 7 The scan names a session from its record | 3 (`Entry.title`, `folderName`, and its files), 6 (`readRecordName`) | `xhigh` |
| 8 End to end: the scan's name | 7 | `high` |

Longest chain: 1 → 3 → 7 → 8 (and 5 → 6 → 7 → 8): four tasks. Tasks 1 and 5 start at once; then 2, 3 and 6 run side by side; then 4 and 7; then 8.

## Global Constraints

- **One field.** `title`, optional, on the existing observed body. No new route, message, file, import, state, counter or log line in the core.
- **Bounds.** A non-empty string of at most 64 UTF-16 units (`MAX_TITLE`, the unit the core's `bounded` counts), with no control character (`[\u0000-\u001f\u007f]`), on `session-start` and `turn-start` only.
- **The hook** reads `session_title` and nothing else for it: whitespace runs folded to one space, trimmed, cut to 64 units without splitting a surrogate pair, trimmed again. An empty result, or one with a control character left, is left out. Any engine whose hook sends `session_title` gets it.
- **The 4096-byte body.** `transcriptPath` is dropped first, then `cwd`, as today. The title is never dropped.
- **The core** refuses the whole event for a bad title, or a title on any other event (`asked` included, checked before its early return). It keeps nothing and logs nothing of it.
- **The name** of an agent outside a pane: its title, else the name of its last known folder (`a.cwd`), else the engine. A `session-start` or `turn-start` with a title sets it. A Claude Code `session-start` or `turn-start` with none clears it. Another engine's event with none leaves it. Every other event leaves it.
- **Reads.** Nothing reads the Claude app's stores, another session's files, a transcript's title lines or any conversation content. One read is new (decision 5): `name` and `nameSource`, and nothing else, of a Claude Code session's own process record, for a session the open scan lists.
- **The scan's name.**
  - Claude Code only, read in the devices process, never in the core.
  - Read only when the owner's `record` is `<a sessions folder>/<owner pid>.json`, the path `recordOwners` builds. An owner claimed from its arguments (`record: ''`) has none, and a transcript is never opened.
  - One read of at most 16 KiB (16 384 bytes). A larger file, one that is not JSON, one whose `name` is not a string, or one whose `nameSource` is not the string `user` gives no name.
  - The name is cleaned and cut as the hook's title is: whitespace folded, trimmed, 64 UTF-16 units without splitting a surrogate pair, none with a control character.
  - Read once, as a session is first listed, for the sessions of that look (at most 50), after the rows and the apps are read. A session a hook told of meanwhile keeps what the hook said. Later names come from its hooks.
  - A read that fails leaves the folder.
- **Data.** The title is in memory only, while the agent is listed. Never on disk, in a log, an error, a measure, the backend, the phone or the gateway.
- **Measure.** One: the scan's line gains a count, `[observed] scan · 7 found · 7 app known · 3 named · 57 ms`. Counts only: no name, session or path. Nothing else new.
- **Not in this pull request:** the check on the real Claude app (with Diego, later); moving the observed path out of the core; the firmware's 40-byte cut.
- **Repo rules.** Tests never touch the real `~/.claude`, the everyday daemon (18473), the real tmux server or a real dial. No fixed sleeps. `src/core` stays at 100% per file. Comments say why.
- **Commits.** A task with a red test is two commits: its failing tests (`… (red)`), then the code. Nobody commits the plan or the spec from a task.

## Review Focus

1. **The hook's cut and the core's bound drift apart.** A title the hook cut must always be one the core takes, or a named session loses its `session-start` and `turn-start` whole. Task 2: `the hook cuts a title at the core's bound, and the core takes what it cut`.
2. **The title in a log.** A refused event, a scan, a full table: no line may hold it. Task 1: `counts a refused title and logs none of it`. Task 3: `no log line holds a title`. Task 4: the daemon's log has no `7f3a91c2`.
3. **Names outside ASCII and JSON's own characters** ("Thơ", "gà", `"`, `\`, CJK, an emoji) arrive as they were typed. Task 1: `takes 64 UTF-16 units, letters outside ASCII and JSON's own characters`. Task 2: the `'Thơ "gà" \\ 数学 🙂'` row.
4. **A `session-start` in the middle of a turn** (Claude Code's compaction) with a new title renames the agent and leaves it working. Task 3: `a session-start in the middle of a turn renames it and leaves it working`.
5. **A rename with nothing else changed** (the turn already runs) must still reach the dial. Task 4: the second `UserPromptSubmit`.
6. **The real record's path fails the reader's check** (the provider builds it one way, the reader another; a home the person moved), and every session the scan finds silently reads its folder. Task 6: `reads the record at the path the provider builds, in the first home and in a moved one`. Task 8: the real provider and the real reader on the real daemon.
7. **A record caught while Claude Code rewrites it,** or grown past the bound: no name, no error, and the session is still listed by its folder. Task 6: the `cut mid-write` row. Task 7: `a reader that gives none or fails still lists the session by its folder`.
8. **The record's name or path in a log.** Task 7: `the scan's line counts the named ones and holds no name`. Task 8: the daemon's log has neither name.

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

**Layer:** the hook. **Depends on:** Tasks 1, 5. **Effort:** `high`.

**Red test:** the title cases in `describe('hook notify: a session outside a pane', …)`, `cli/src/hookNotify.spec.ts`.

**Files:**
- Modify: `cli/hook/notify.mjs`
- Test: `cli/src/hookNotify.spec.ts`

**Interfaces:**
- Consumes: `MAX_TITLE` and `parseObservedHook` (Task 1), imported beside `MAX_HINTS`.
- Consumes, in the spec only: `observedTitle(value: unknown): string | undefined` from `./cable/hosts/observedTitle.js` (Task 5).
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
  - `the hook cleans a title as the devices' cleaner does`: for every `session_title` of the two tables above (the posted ones and the ones left out), the posted body's `title` is `toBe(observedTitle(session_title))`, `undefined` for one left out. The hook cannot import the cleaner, so this is what keeps its copy of the rule the same.
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
- Module-private, and used again by Task 7: `Entry.title?: string`, and `folderName(cwd: string | undefined, engine: string): string`, which is `(cwd && basename(cwd)) || engine`.

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
  - `asked()` does not touch the title or the name. The scan sets no title in this task: Task 7 adds the one from the session's own record.
  - The comment on `Entry.title` says why only Claude Code's event with none clears it: its hook says the name on each of these events, and Command Code's `turn-start` is every tool call.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts && npm run typecheck`. Expected: PASS, the file's other tests unchanged.
- [ ] **Step 5: Commit** `dial: an agent outside a pane reads the name its session gives itself, and its folder when it has none`.

### Task 4: End to end: the dial reads the folder, then the name its hook says

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

### Task 5: One cleaner for a title

**Layer:** devices service process. **Depends on:** none. **Effort:** `medium`.

**Red test:** `describe('observedTitle', …)` in `cli/src/cable/hosts/observedTitle.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/observedTitle.ts`
- Test: `cli/src/cable/hosts/observedTitle.spec.ts`

**Interfaces:**
- Produces: `export function observedTitle(value: unknown): string | undefined`, the title to show, or `undefined` for none. It has the name and the rule of the hook's own `observedTitle` (Task 2).
- Module-private: `const MAX_TITLE = 64`. This process must not load the core's code, so it holds its own; Task 2's test holds the hook's, the core's and this one together.
- Not in `cli/src/lib/sessionTitle.ts`: `core/main.ts` imports that file, so it is the core's.

- [ ] **Step 1: Write the failing tests.**
  - `it.each(…)('cleans %j to %j')`, Task 2's rows and two more:

    | value | result |
    |---|---|
    | `'Tho'` | `'Tho'` |
    | `'  Fix \t\n login   screen '` | `'Fix login screen'` |
    | `'x'.repeat(70)` | `'x'.repeat(64)` |
    | `` `${'x'.repeat(63)}😀tail` `` | `'x'.repeat(63)` |
    | `` `${'x'.repeat(62)}😀tail` `` | `` `${'x'.repeat(62)}😀` `` |
    | `` `${'x'.repeat(63)} yz` `` | `'x'.repeat(63)` |
    | `'😀'.repeat(40)` | `'😀'.repeat(32)` |
    | `'Thơ "gà" \\ 数学 🙂'` | the same |
  - `it.each(…)('gives none for %j')`, each `toBeUndefined()`: `''`, `' \t\n '`, `'Th\u0007o'`, `'Th\u007fo'`, `'Th\u0000o'`, `7`, `null`, `undefined`, `true`, `{ text: 'Tho' }`, `['Tho']`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observedTitle.spec.ts`. Expected: FAIL (no such module).
- [ ] **Step 3: Implement** `observedTitle`, in this order: not a string, none; fold `/\s+/g` to one space and trim; when longer than `MAX_TITLE`, keep the first `MAX_TITLE` units, drop a last unit that is a high surrogate (`\ud800` to `\udbff`), and trim again; empty, or `/[\u0000-\u001f\u007f]/` matches, none. The file's comment says why there are two copies of the rule: the hook is one file that ships alone.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/hosts/observedTitle.spec.ts src/architecture.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: one cleaner for a session's title, the hook's rule in TypeScript`.

### Task 6: The reader of a session's own record

**Layer:** devices service process. **Depends on:** Task 5. **Effort:** `xhigh` (a file read in a trusted process, behind a path check and a size bound; the person's own label).

**Red test:** `describe('readRecordName', …)` in `cli/src/cable/hosts/recordName.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/recordName.ts`
- Test: `cli/src/cable/hosts/recordName.spec.ts`

**Interfaces:**
- Consumes: `observedTitle` (Task 5); the type `SessionOwner` from `../../lib/sessionSearch/external.js`.
- Produces: `export const MAX_RECORD_BYTES = 16 * 1024`.
- Produces: `export interface RecordNameOptions { roots: readonly string[] }`. `roots` are Claude Code's projects folders (`claudeProjectsRoots`), as `readLastAnswer` takes them; its process records are in `sessions` beside each.
- Produces: `export function readRecordName(owner: Pick<SessionOwner, 'pid' | 'record'>, opts: RecordNameOptions): Promise<string | undefined>`. It never rejects, logs nothing and keeps nothing.

- [ ] **Step 1: Write the failing tests.** Each test has a throwaway home from `mkdtempSync` (removed after): `projects = join(home, 'projects')`, `sessions = join(home, 'sessions')`. A helper `record(pid, content, dir = sessions)` writes `<dir>/<pid>.json` (an object as JSON, a string as it is) and returns ``join(dir, `${pid}.json`)``. `named = { pid: 11, sessionId: 's', cwd: '/x', status: 'idle', name: 'Tho', nameSource: 'user' }`, and `read = (path, pid = 11, roots = [projects]) => readRecordName({ pid, record: path }, { roots })`.
  - `reads the name the person gave`: `read(record(11, named))` is `'Tho'`.
  - `reads the record at the path the provider builds, in the first home and in a moved one`: with a second home `moved`, `read(join(moved, 'projects', '..', 'sessions', '11.json'), 11, [projects, join(moved, 'projects')])` is `'Tho'`; so is `read(join(projects, '..', 'sessions', '11.json'))`.
  - `it.each(…)('gives none for %s')`, each `toBeUndefined()`:
    - `nameSource` `'derived'`, missing, `7`, `'User'`;
    - `name` missing, `7`, `null`, `{ text: 'Tho' }`, `['Tho']`, `''`, `' \t '`, `'Th\u0007o'`;
    - a record cut mid-write, `'{"pid":11,"name":"Tho","nameSou'`;
    - JSON that is no object: `'[{"name":"Tho","nameSource":"user"}]'`, `'null'`, `'"Tho"'`;
    - no file at the path;
    - a folder at the path (`mkdirSync(join(sessions, '11.json'))`): the read fails and nothing is thrown.
  - `cleans and cuts the name as the hook's title`: `'  Fix \t\n login   screen '` gives `'Fix login screen'`; `'😀'.repeat(40)` gives `'😀'.repeat(32)`; `'Thơ "gà" \\ 数学 🙂'` gives the same.
  - `reads a record of 16 KiB and not one a byte larger`: `named` with a `pad` field sized so the file is `MAX_RECORD_BYTES` bytes gives `'Tho'`; one byte more gives none.
  - `it.each(…)('reads nothing at %s')`, each `toBeUndefined()` though the file there is `named`:
    - `record: ''` (an owner claimed from its arguments);
    - another process's record: `read(record(12, named), 11)`;
    - `join(sessions, '11.jsonl')`;
    - a file of the same name elsewhere: `record(11, named, join(projects, '-x'))`, and `record(11, named, join(home, 'other', 'sessions'))`;
    - the record by another spelling, which `join` would not build: `` `${sessions}/../sessions/11.json` ``.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/recordName.spec.ts`. Expected: FAIL (no such module).
- [ ] **Step 3: Implement** `readRecordName`:
  - The path check, with no file call: ``opts.roots.some((root) => owner.record === join(root, '..', 'sessions', `${owner.pid}.json`))``. It is the string `recordOwners` builds (`join` of the same folder and file name), so equality is the whole check; no `realpath`.
  - The read: its own `open` and one `read` of `MAX_RECORD_BYTES + 1` bytes (`node:fs/promises`), the handle closed in `finally`. More than `MAX_RECORD_BYTES` read, or any error, gives none.
  - The value: `JSON.parse` in a `try`; a plain object whose `nameSource === 'user'` and whose `name` is a string gives `observedTitle(name)`. No other field is read.
  - The file's comment says what decision 5 allows and why only a `user` name: a `derived` one can come from what was first asked.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/hosts/recordName.spec.ts src/architecture.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: a reader of the name in a Claude Code session's own process record, two fields and nothing else`.

### Task 7: The scan names a session from its record

**Layer:** devices service process. **Depends on:** Tasks 3, 6. **Effort:** `xhigh` (a hook can arrive while the scan reads; a name must reach no log).

**Red test:** `describe('ObservedSource and the name in a session\'s own record', …)` in `cli/src/cable/hosts/observed.spec.ts`, and `the scan asks a Claude session's own record for its name, inside Claude Code's folders` in `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts`
- Modify: `cli/src/services/devices.ts`
- Modify: `cli/e2e/dialAppFilter.e2e.ts` (one assertion on the scan's line)
- Test: `cli/src/cable/hosts/observed.spec.ts`
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `Entry.title` and `folderName` (Task 3); `readRecordName(owner, { roots })` (Task 6).
- Produces: `ObservedDeps.recordName?(owner: Pick<SessionOwner, 'pid' | 'record'>): Promise<string | undefined>`, the type `SessionOwner` imported beside `OpenSessions`. Absent, the scan names by folder.
- Produces: the scan's line, `[observed] scan · <n> found · <m> app known · <k> named · <ms> ms`. `<ms>` stays the time of the apps' read.

- [ ] **Step 1: Write the failing tests** in `observed.spec.ts`, with a `found(s, sessionId, pid, engine = 'claude')` as the apps' describe has it. The file's fake owners give `record: <session id>`.
  - `a Claude session the scan lists reads the name its record gives`: `setup({ recordName: async () => 'Tho' })`, `found(s, 'a', 11)`, scan: `{ name: 'Tho', cwd: '/x/a' }`, and `changes` was called.
  - `it.each(…)('a reader that %s still lists the session by its folder')`, for `async () => undefined` and `async () => { throw new Error('EACCES /Users/someone/.claude/sessions/11.json') }`: the name is `'a'`, `s.logs` equals `['[observed] scan · 1 found · 0 app known · 0 named · 0 ms']`, and no line holds `someone`.
  - `the reader is asked once, for the Claude sessions the scan is about to list`: with `recordName = vi.fn(async () => undefined)`; `a` (Claude, 11), `b` (Codex, 12), `c` (Claude, 13, no row) and `h` (Claude, 14, open in `'harness'`); scan; then `d` (Claude, 15); scan twice. `recordName.mock.calls` equals `[[expect.objectContaining({ pid: 11, record: 'a' })], [expect.objectContaining({ pid: 15, record: 'd' })]]`.
  - `at most 50 are asked a look`: 51 Claude sessions found, one scan: `recordName` was called 50 times.
  - `it.each([[{ title: 'Math' }, 'Math'], [{}, 'a']])('a hook that came while the names were read keeps what it said')`: the reader waits on a promise the test holds; after `vi.waitFor` sees it called, `src.ingest(ev('turn-start', { sessionId: 'a', callerPid: 11, cwd: '/x/a', ...over }))`; the reader answers `'Tho'`; after the scan the list has one agent, with that name.
  - `the record's name holds until a hook says otherwise`, in this order after a scan that named it `'Tho'`:
    1. `ev('turn-stop', { sessionId: 'a', callerPid: 11, cwd: '/x/moved' })` gives `{ name: 'Tho', cwd: '/x/moved' }`.
    2. `ev('turn-start', { sessionId: 'a', callerPid: 11, cwd: '/x/moved' })` gives `name: 'moved'`.
    3. `ev('session-start', { sessionId: 'a', callerPid: 11, cwd: '/x/moved', title: 'Math' })` gives `name: 'Math'`.
  - `the scan's line counts the named ones and holds no name`: `recordName: async (owner) => (owner.pid === 11 ? 'Tho 7f3a91c2' : undefined)`, `a` (11) and `b` (12): `s.logs` equals `['[observed] scan · 2 found · 0 app known · 1 named · 0 ms']`.
  - `with no reader the scan names by folder`: `setup()`: the name is `'a'` and the line says `0 named`.
  - Changed, in the apps' describe: `the scan's log line counts and names nothing` expects `'[observed] scan · 2 found · 1 app known · 0 named · 7 ms'`.
- [ ] **Step 2: Write the failing test** in `devices.spec.ts`:
  - The stand-ins: `readers.name = vi.fn(async (..._args: unknown[]): Promise<string | undefined> => undefined)`, put back where `readers.answer` is; `vi.mock('../cable/hosts/recordName.js', () => ({ readRecordName: readers.name }))`, beside the `scannedApp.js` one.
  - `the scan asks a Claude session's own record for its name, inside Claude Code's folders`, shaped as `the scan asks which app each session it found runs in, by pid`: `sess-7` owned by `{ engine: 'claude', pid: 78 }`, its row `{ cwd: '/work/scratch-2016', transcriptPath: null }`, not working, and `readers.name.mockResolvedValue('Tho')`. After `seen.host.watching!(true)` the machine list has `expect.objectContaining({ id: observedAgentId('claude', 'sess-7'), name: 'Tho' })`, and `readers.name.mock.calls` equals `[[expect.objectContaining({ pid: 78, record: 'sess-7' }), { roots: claudeProjectsRoots(env.CLAUDE_PROJECTS_DIR) }]]`.
- [ ] **Step 3: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts src/services/devices.spec.ts -t "own record"`. Expected: FAIL (the agent reads its folder; the line has no `named`; the reader is never called).
- [ ] **Step 4: Implement.**
  - `scanOnce`: the sessions it is about to list (a row, not yet known, the first `MAX_SESSIONS`) are worked out once; `pids` come from them. After `appsOf` and its `ms`, the names are read: for the Claude ones, in order, one `await this.deps.recordName(owner)` each, in a `try`. A string goes into a map by session id; none and a rejection add nothing, and log nothing. No reader, no names.
  - In the listing loop, right after the entry is made and counted, before any `await`: a name for the session sets `entry.title` and `entry.agent.name`, and is counted.
  - The line gains `· ${named} named` between the apps' count and the time.
  - The comment says why the names are read before the loop: the loop's own check then sees a session a hook told of during the read, and it keeps what the hook said. And why once: a listed session is never looked at again.
  - `observedSource` (`services/devices.ts`): `recordName: (owner) => readRecordName(owner, { roots: claudeProjectsRoots(env.CLAUDE_PROJECTS_DIR) })`, beside `apps: learnApps`. Its comment: asked for Claude Code's sessions alone (`observed.ts`), read only inside its own folders, which are worked out each time because a moved home is adopted while the daemon runs.
  - `cli/e2e/dialAppFilter.e2e.ts`: the line it expects becomes `/\[observed\] scan · 5 found · 5 app known · 0 named · \d+ ms/`.
- [ ] **Step 5: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts src/services/devices.spec.ts src/architecture.spec.ts && npm run typecheck && npm run test:core`. Expected: PASS; `services/devices.ts` reads 100 in all four columns.
- [ ] **Step 6: Run,** on this Mac, `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilter.e2e.ts -t "the watch started first"`. Expected: PASS (five found, none named). If `socketRoom` stops the run for a long `TMPDIR`, run it again with `TMPDIR=/tmp`.
- [ ] **Step 7: Commit** `dial: a session the scan finds reads the name the person gave it, from its own process record`.

### Task 8: End to end: a session the scan finds reads the name in its record

**Layer:** test. **Depends on:** Task 7. **Effort:** `high`.

**Red test:** none: no behavior (it adds an end-to-end test of what Tasks 5 to 7 built).

**Files:**
- Modify: `cli/e2e/deviceWithoutApp.e2e.ts`
- Modify: `cli/e2e/harness/outsideAgent.ts`

**Interfaces:**
- Consumes: the file's own `fresh()`, `startOutside(d, folder, hints)`, `showing(…)`, `ids(…)`; `Outside.type`, `Outside.ran`; `until`; `IsolatedDaemon.log()`.
- Produces: `Outside.named(d: IsolatedDaemon, name: string, nameSource: 'user' | 'derived'): void`. It adds the two fields to the session's own process record, as Claude Code keeps them there. The record is the one the fake engine wrote (`fakeEngine.mjs` `announceProcess`): ``join(dirname(d.env.CLAUDE_PROJECTS_DIR!), 'sessions', `${this.pid}.json`)``, in the daemon's throwaway root. (`d.projectsDir` is another folder: where the sessions work.) It writes `<pid>.json.tmp` beside the record and renames it over, so the daemon never reads half a record; the provider takes only names that end in `.json`.
- The fake engine writes its record only as it starts and on `/clear`, and sends no `session_title`: nothing rewrites the record after the test, and its next prompt is a Claude `turn-start` with no title.

- [ ] **Step 1: Write the test** `an agent found by the scan reads the name the person gave it in its own record, one Claude Code made up reads its folder, and no log holds either`, and add its line to the file's header comment:
  1. `fresh()`. Two sessions, as `an agent started before the dial connects is listed` starts one: `mine` in `scratch-2016a` and `made` in `scratch-2016b`, each with `{ TERM_PROGRAM: 'ghostty' }`, each types `before the dial` and its `Stop` hook has run. No devices process yet: their hooks reach nobody.
  2. `mine.named(d, 'Tho 7f3a91c2', 'user')` and `made.named(d, 'Fix login 5d2e8c41', 'derived')`.
  3. `desk.plug('E2E-A', 'e2:e0:00:00:00:0a')`. The dial is shown a list with both (`showing`, 15 s, as that test waits): `mine`'s row has `name: 'Tho 7f3a91c2'`, `made`'s has `name: 'scratch-2016b'`.
  4. `d.log()` matches `/\[observed\] scan · 2 found · \d+ app known · 1 named · \d+ ms/`, and holds neither `7f3a91c2` nor `5d2e8c41`.
  5. `mine.type('again')`; since then, the dial is shown `mine` as `scratch-2016a`: its hook said no name, and the hook has the last word.
  No sleep.
- [ ] **Step 2: Run,** on this Mac, `cd cli && npm run typecheck && npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts`. Expected: PASS, every test of the file, the new one among them. If `socketRoom` stops the run for a long `TMPDIR`, run it again with `TMPDIR=/tmp`.
- [ ] **Step 3: See it able to fail:** run once with `mine`'s `'user'` changed to `'derived'`. Expected: FAIL at step 3's name. Put it back; this change is never committed.
- [ ] **Step 4: Commit** `e2e: a session the scan finds reads the name in its own record, and its folder when Claude Code made the name up`.

---

## Verification

**Platforms the pull request names:** macOS (the unit suites and check 1, on this Mac) and Linux (PR CI's unit suites; check 1's GitHub run). Windows: the same JavaScript and TypeScript, with no line that asks the platform (the reader's path check is `join` on both sides); no workflow runs these spec files on Windows, so it is reported as not run there (Answered 2; Open question 2 asks whether that stands with the record's read).

**Temporary workflow:** none. No check here is long: the end-to-end files run in a few minutes on this Mac, and the repo's own **CLI end to end** workflow runs them on Linux by hand.

**Workflows:** none changes. The new tests sit in files the nightly CLI end to end run already takes, so they keep running there with nothing added.

**The pull request says:**
- It adds one field, `title`, to the core's observed path: checked in `core/observedHook.ts`, handed on, kept nowhere, the same pattern as `relayed`. It moves out of the core with the rest of that path in the follow-up to `cli/AGENTS.md` rule 7 (the devices' routes move to `devicesListener`).
- It adds one read in the devices process (decision 5): `name` and `nameSource`, and nothing else, of a Claude Code session's own process record, for a session the open scan lists; at most 16 KiB, once, at most 50 a look. Nothing in the core changes for it.
- The scan's line gains `· <k> named`: a count, no name, session or path.
- `src/architecture.coreFiles.txt` gains no line, and no doc changes.
- The platforms above, the red-then-green commits, the local gates' receipts, and check 1's run link.
- The check on the real Claude app is done with Diego in the joint test session, not here.

**Turns.** The tester asks the orchestrator before the one hand-started GitHub run in check 1.

**Local gates,** recorded in the pull request (PR CI does not run the coverage gate):
- `cd cli && npm run typecheck`.
- `cd cli && npm run test:core`: 100% per file, `core/observedHook.ts` and `services/devices.ts` among them. It is the one gate `python3 scripts/local-checks.py --list` names for this plan's paths.
- `cd cli && npx vitest run src/architecture.spec.ts src/core/observedHook.spec.ts src/hookNotify.spec.ts src/cable/hosts/observed.spec.ts src/cable/hosts/observedTitle.spec.ts src/cable/hosts/recordName.spec.ts src/services/devices.spec.ts`.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit. Its fence goes in the pull request's body before that head is pushed.
- Not needed: `npm run test:harnessd`, the serial specs, `make device-test`, Harness Device's `cargo test`.

**1. The real daemon, the installed hook, the real scan, a fake dial**
- Build: nothing. The suite starts the daemon from this checkout's sources. `cd cli && npm ci` first when `node_modules` is missing.
- Run, on this Mac, at the final head:
  - `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceClaudeOrca.e2e.ts e2e/deviceWithoutApp.e2e.ts e2e/dialPaneFollow.e2e.ts`. The first holds the hook's test (Task 4), the second the scan's (Task 8); the third drives the same hook, core and devices path with no title.
  - `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/dialAppFilter.e2e.ts -t "the watch started first"`: the one test whose expected line Task 7 changed. The rest of that file runs on GitHub, below.
- Isolation (`cli/AGENTS.md` rule 6): the suite's own `IsolatedDaemon` (`e2e/harness/daemon.ts`). A throwaway home and data folder, its own port, a private tmux server, fake engines, hooks installed only inside the test's root. The dial is a fake on a pseudo-terminal (`HARNESSD_TEST_DIAL_PORT`). Signed out, no backend. The process record the scan's test names is the fake Claude Code's own, `<the test's root>/claude/sessions/<pid>.json`, beside the daemon's `CLAUDE_PROJECTS_DIR`; the test adds the two fields there (`Outside.named`). The real `~/.claude` and its `sessions` folder, the everyday daemon (18473), the real tmux server, a real dial, the Claude app and production are not touched.
- A person sees: every test passes.
  - In Task 4's test the dial is sent the agent as `scratch-2016`, then `Tho`, then `Math 7f3a91c2`, and the daemon's log has no `7f3a91c2`.
  - In Task 8's test the dial, plugged in after both sessions ran, is sent one as `Tho 7f3a91c2` and the other as `scratch-2016b`; the daemon's log has `[observed] scan · 2 found · <n> app known · 1 named · <ms> ms` and neither name; after the named one's next prompt the dial is sent it as `scratch-2016a`.
- On GitHub, by hand, once at the final head: Actions → CLI end to end → Run workflow, branch `fix/dial-session-name` (`.github/workflows/cli-e2e.yml`). Eight Linux shards; every shard passes, `dialAppFilter.e2e.ts` whole among them. Report the run link.

**2. PR CI, nothing started by hand:** `cli-typecheck` and `cli-tests` run the six spec files on Linux; `companions` and `pty-checks` run because `cli/` changed.

**3. With Diego, not this pull request:** a Claude app session renamed in the app reads its new name on the dial after the next prompt. It needs Diego's Claude app, daemon and dial, in the joint test session. No task and no tester does it; nobody reports it as passed. Nothing in this plan reads a real Claude Code's record: the joint session also checks the scan's name after `fix/process-table-full-comm` (Answered 7).

## Answered (the PM, 2026-11-15)

1. The Design section's review: "Reviewer: P1 builder-check + PM", at the spec's first commit.
2. Windows: not run. The change is the same code there, and the by-hand Windows workflow runs a fixed list without these
   specs; the spec says so under Platforms.
3. The name rule below (title, then folder, then engine) stands.
4. Decision 5, the scan's name from the session's own process record: the spec at `61b5dcc40d`. Tasks 5 to 8.

5. Design review after decision 5: reviewed again by the PM at `61b5dcc40d`; the spec's header says so.
6. Windows: "not run" stands for the record's read too (the same code on every platform, behind the same path check).
7. The joint session with Diego also checks the scan's name on a named, idle Claude app session, after
   `fix/process-table-full-comm` lands; the spec lists it under "With Diego". No task or tester does it here.

## Decided here, where the spec was silent

- `MAX_TITLE` is exported from the core. The hook is a plain script that cannot import it, so it holds its own `64`, and Task 2's test reads that literal and compares.
- The title is `Entry.title` inside the observed source, not a field of `HostAgent`: every reader gets it as `name`.
- One way to work out the name: `entry.title ?? folderName(a.cwd, a.engine)`, on every event. A folder with no base name (`/`) reads the engine, at a session's first event as today. Today a later event in `/` kept the earlier folder's name; with the one rule it reads the engine.
- The hook reads `session_title` in that spelling only, as its pane path does.
- The end-to-end test goes in `cli/e2e/deviceClaudeOrca.e2e.ts`, the file the spec names as an example. It adds a second prompt with a name no log line could hold by chance, for Review Focus 2 and 5.
- Task 2 depends on Task 1 only for the test that ties the hook's bound to the core's. Without that test the two bounds could drift unseen. It depends on Task 5 the same way, for the test that ties the hook's cleaning to the devices' cleaner.
- No doc changes: no living doc lists the observed body's fields, and the title is part of "the agents outside a pane (from their hooks)" that `cli/AGENTS.md` already gives the devices process. That line names none of the scan's reads today (owners, rows, apps), and gains none for the record.

For decision 5:
- **Three tasks and one end-to-end task, not an extension of Task 3.** The cleaner (5) and the reader (6) are new files, so they run beside Tasks 1 to 3. Only the scan's change (7) shares `observed.ts` with Task 3, and comes after it.
- **The cleaner is `cable/hosts/observedTitle.ts`,** in the devices process, where the reader imports it. The hook cannot import it (`notify.mjs` ships alone), so it keeps its own `observedTitle`, as planned, and Task 2 gains the test that compares the two on every row. `lib/sessionTitle.ts` is not the place: `core/main.ts` imports it. The cleaner holds its own `64`: the devices process loads no core code, and the same test holds it to the hook's and the core's.
- **The reader's cases are tested where the reader lives.** The spec lists them under `observed.spec.ts` (`derived`, a missing or non-string name, over 16 KiB, a failed read, a path of another shape). They are in `recordName.spec.ts`, against real files in a throwaway folder. `observed.spec.ts` tests what the scan does with the reader's answer: the name, none, a failure, a hook during the read, a later hook, the count.
- **"A sessions folder" is `sessions` beside one of Claude Code's projects folders** (`claudeProjectsRoots`), the folders the provider claims records from (`engines/kit/adoption.ts`). The check is string equality with the path the provider builds; no `realpath`.
- **The dependency is one session at a time:** `recordName(owner)`, asked in order for at most 50. The reads are of files of 1 to 2 KiB, so no batch and no fan-out.
- **No deadline and no file-type check in the reader.** The spec gives a size bound alone, and the owners' look reads the same file moments before with neither (`recordOwners`, which claims only from regular files).
- **A reader that fails logs nothing.** The spec adds nothing but the count; a failure shows as a session not counted in `named`.
- **`<ms>` in the scan's line stays the time of the apps' read,** as today. The spec's example line changes nothing but the count.
- **`e2e/dialAppFilter.e2e.ts` is in Task 7,** which changes the line that file expects: the line and every assertion on it change in one task.
- **An end-to-end test of the scan's name (Task 8),** which the spec's "End to end" does not list. The harness can make the record: the fake Claude Code already writes `<root>/claude/sessions/<pid>.json`, and `Outside.named` adds the two fields. It is the one check of the real provider's path against the real reader's check. The fake engine is not extended: it sends no `session_title` either, as the spec notes.
