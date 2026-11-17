# Dial: an agent found by the scan shows its last recap and its Claude app name — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(dial): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message.

**Goal:** After a daemon restart, an idle Claude Code or Codex session the open scan finds shows its last answer on the dial at once (through the dial's restore), and a Claude app session shows the title its app gave it, with no new prompt.

**Architecture:**
- **`observed.ts` `scanOnce`** reads everything of a look before its loop: apps and names (as today), then each Claude Code / Codex session's busy check (moved out of the loop), then each idle one's last answer with the Stop hook's reader (`deps.lastAnswer`). The loop then adds the entries, sets what was read and emits once, with no await in between. Nothing is stored; the state stays `idle`, `unseenDone` stays false, and the dial gets the recap through its existing restore (`summary`, `restore: true`).
- **`recordName.ts` `readRecordName`** also takes a record's `name` when it has no `nameSource` and `entrypoint === 'claude-desktop'` (N1).
- **The e2e fake Claude Code** writes `status` (`busy` / `idle`) in its process record, as Claude Code does, so the scan's idle-only read runs end to end.
- Everything is in the devices process. Nothing under `cli/src/core` changes (cli/AGENTS.md rule 7).

**Tech Stack:** TypeScript daemon (Node, vitest) in `cli/`; the e2e suite (real daemon, fake engines, fake dial).

**Spec:** `docs/plans/2026-11-17-dial-recap-after-restart-design.md`. Read it with this plan, the root `AGENTS.md` and `cli/AGENTS.md` (Protect the core, rule 7; rules 5 and 6 for e2e).

## Base

- Branch `fix/dial-recap-after-restart`, at `e1f84bdfde`, in the worktree `/Users/duynguyen/orca/workspaces/autonomous-harness/dial-recap-restart`. Nothing else has to merge first.
- **Before the first task, once:** `cd cli && npm ci --no-audit --no-fund` (this worktree's `cli/` has no `node_modules`). One process runs it, never two tasks at once.
- The tasks name functions, never lines (line numbers below are hints). Names at the base:
  - `cable/hosts/observed.ts`: `ObservedSource.scanOnce`, `namesOf`, `appsOf`, `readAnswer`, `entry`, `setState`, `learnTty`, `live`, `emit`; constants `MAX_SESSIONS` (50), `ANSWER_CHARS` (300); `ObservedDeps.lastAnswer`, `openSessions.busy`, `excluded`, `log`, `now`.
  - `cable/hosts/recordName.ts`: `readRecordName`, `MAX_RECORD_BYTES`. `lastAnswer.ts`: `readLastAnswer` (unchanged).
  - `observed.spec.ts`: `setup` (its `open`, `owners`, `working`, `externals`, `answers`, `logs`, `changes`, `clock`, `ev`; `busy` reads `working.get(owner.record) !== false`, and an owner's record is its session id unless one is given), the `found` helpers inside each `describe`.
  - `recordName.spec.ts`: `record`, `named`, `read`.
  - `e2e/harness/fakeEngine.mjs`: `announceProcess`, `finish`, `open`, `procStart`, the `goalpause` and `latestop` directives, the Esc interrupt. `e2e/harness/outsideAgent.ts`: `Outside.start`, `named`, `ran`. `e2e/deviceWithoutApp.e2e.ts`: `fresh`, `startOutside`, `showing`, `heard`, `rosters`, `ids`. `e2e/harness/daemon.ts`: `until`.
- If a name differs at the base, the implementer follows the code and says so in its report.
- The spec and this plan are untracked. The main session commits them; no task does.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 A Claude app record names its session | `cli/src/cable/hosts/recordName.ts`, `recordName.spec.ts` | none | high | `recordName.spec.ts` |
| 2 The session-name spec reads three fields | `docs/specs/2026-11-15-dial-session-name.md` | none | medium | none: docs only, one commit |
| 3 The scan reads each idle session's last answer before it lists any | `cli/src/cable/hosts/observed.ts`, `observed.spec.ts`, `cli/e2e/dialAppFilter.e2e.ts`, `cli/e2e/deviceWithoutApp.e2e.ts` (the scan line's assertion only) | none | xhigh | `observed.spec.ts` |
| 4 The fake Claude Code says busy and idle in its record | `cli/e2e/harness/fakeEngine.mjs`, `cli/e2e/harness/outsideAgent.ts`, `cli/e2e/deviceWithoutApp.e2e.ts` (the two `named` calls only) | none | high | none: test harness only, one commit |
| 5 End to end: restored recap and Claude app name | `cli/e2e/deviceWithoutApp.e2e.ts` | 1, 3, 4 | high | none: the end-to-end test of Tasks 1, 3 and 4, one commit |

Longest chain: 3 → 5 (also 1 → 5, 4 → 5): two tasks.

- Tasks 1 and 2 share no file with anything and start at once. Task 2 describes what Task 1 builds, as this plan gives it, and needs none of it done first.
- Tasks 3 and 4 have no real dependency on each other but share `cli/e2e/deviceWithoutApp.e2e.ts` (each a different few lines), so devcrew runs them one after the other, in either order. Each one's e2e edits hold in both orders (Task 3's assertions take `\d+ answered`).
- Task 5 needs all three: the restored recap needs Task 3's read and Task 4's idle record; the name needs Task 1 and Task 4's `named`.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/hosts/observed.ts`, `recordName.ts` | **Devices service process**, and only there | their specs (PR CI `cli-tests`); not under `test:core` |
| `cli/e2e/harness/fakeEngine.mjs`, `outsideAgent.ts`, `cli/e2e/*.e2e.ts` | Test: the real daemon, fake engines, fake dial | Verification 1 and 2 |
| `docs/specs/2026-11-15-dial-session-name.md` | Docs | review |

Not changed, and a diff in any is a finding:
- anything under `cli/src/core/`, and `cli/src/architecture.coreFiles.txt`;
- `cable/hosts/lastAnswer.ts`, `cable/cableHost.ts`, `cable/cableSession.ts`, `services/devices.ts`, `hcSource.ts`;
- the firmware.

## Global Constraints

- **Rule 7.** No file under `cli/src/core` changes. The devices process owns all of it.
- **The reader.** The scan's answer read is `deps.lastAnswer(engine, transcriptPath)`, the Stop hook's reader: `readLastAnswer`, only a file inside the engine's own folders, a 256 KiB tail (`LAST_ANSWER_MAX_BYTES`), a 1 s deadline (`LAST_ANSWER_DEADLINE_MS`). No new bound, no new reader.
- **Who is read.** Engine `claude` or `codex` only; busy check reads idle; a truthy transcript path; one of the look's `listing` (at most 50, `MAX_SESSIONS`); read one at a time; once, as the session is first listed.
- **The cut.** 300 code points (`ANSWER_CHARS`), by code point, `…` past it: one helper shared with `readAnswer`.
- **State.** A scan recap leaves `state: 'idle'` and `unseenDone: false`. Nothing is told as `done`, no `summary` card is told, nothing rings.
- **Order.** Every read of a look (apps, names, busy checks, answers) runs before any entry is added. Between the first `entry()` of the look and its one `emit()`, nothing is awaited.
- **A hook wins.** A session a hook listed while the reads ran is skipped by the loop; no read of the scan lands on it.
- **The line.** `[observed] scan · <n> found · <n> app known · <n> named · <n> answered · <ms> ms`. Counts only: never a path, a name, an answer or an error's text. `ms` times every read of the look, from before the apps' walk to after the last answer.
- **The name (N1).** Taken when `nameSource === 'user'`, or when `nameSource` is absent (`undefined`) and `entrypoint === 'claude-desktop'`. Still refused: `nameSource: 'derived'` or any other value, no `nameSource` with any other or no `entrypoint`, and a non-string `entrypoint`. Every other check of `readRecordName` stands.
- **Nothing stored.** No file, no new field on `HostAgent`, no new frame.
- **Tests never reach the real thing:** never `~/.claude`, `~/.codex`, `~/.harness`, a real transcript, the developer's daemon (port 18473) or tmux server; throwaway homes only (cli/AGENTS.md rule 6). No fixed sleeps.
- **Not in this pull request:** Herdr.app's own `hc` rows (decision 3, a stated limit); a session first heard of by a hook other than a start (decision 7 of the session-name spec).

## Review Focus

1. **Harness's own session in the data folder** (the voice router's Claude Code): `entry()` refuses it, but `listing` still holds it, so the scan would read a Harness transcript for nothing. Expected: its answer is never read. Task 3 (`Harness's own session is never read for an answer`).
2. **A reader that throws with a path in its message** (`EACCES /Users/someone/...`): the session is still listed, with no recap, and no log line holds the text. Task 3 (`a read that fails or finds nothing leaves no recap…`).
3. **An answer past 300 code points made of emoji**: cut at a code point, never through a surrogate pair. Task 3 (`…cut at 300 code points`).
4. **More than 50 new idle sessions in one look**: at most 50 answers read, and the loop lists no session it has not read (it walks `listing`, not every open session). Task 3 (`at most 50 answers are read a look, and none past them is listed`).
5. **The dial's 1 s sync during a slow look**: a `list()` while a busy check or an answer read is pending holds none of the look's sessions; the first emit already carries every recap. Task 3 (`no reader of list() sees a session of the look half-read`).

---

### Task 1: A Claude app record names its session

**Layer:** devices service process. **Depends on:** none. **Effort:** `high` (what the devices read of a file another program writes).

**Red test:** `cli/src/cable/hosts/recordName.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/recordName.ts` (`readRecordName` and its doc comment)
- Test: `cli/src/cable/hosts/recordName.spec.ts`

**Interfaces:**
- Produces: `readRecordName` unchanged in signature; it returns `observedTitle(name)` also for `{ name, sessionId, entrypoint: 'claude-desktop' }` with no `nameSource` key (or `nameSource: undefined`).

- [ ] **Step 1: Write the tests.** Beside `named`, a fixture `app = { pid: 11, sessionId: 's', cwd: '/x', status: 'idle', name: 'Tho', entrypoint: 'claude-desktop', hostSessionId: 'h' }` (no `nameSource`).
  - `reads the title the Claude app gave its session`: `read(record(11, app))` is `'Tho'`; the cleaning holds (`{ ...app, name: '  Fix \t login ' }` reads `'Fix login'`).
  - In the `gives none for %s` table, add: `a cli record with no nameSource` (`{ ...app, entrypoint: 'cli' }`), `an sdk-cli record with no nameSource` (`{ ...app, entrypoint: 'sdk-cli' }`), `no entrypoint and no nameSource` (`{ ...app, entrypoint: undefined }`), `a Claude app record with a derived name` (`{ ...app, nameSource: 'derived' }`), `a Claude app record with a nameSource of 7` (`{ ...app, nameSource: 7 }`), `an entrypoint of 7` (`{ ...app, entrypoint: 7 }`), `an entrypoint of Claude-Desktop` (`{ ...app, entrypoint: 'Claude-Desktop' }`), `a Claude app record a /clear moved to another session` (`{ ...app, sessionId: 't' }`).
  - The existing `no nameSource` row stays (its record has no `entrypoint`).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/recordName.spec.ts`. Expected: FAIL in `reads the title the Claude app gave its session` only; every new `gives none` row passes.
- [ ] **Step 3: Commit** `test(dial): a Claude app session's own title names it from its record (red)`.
- [ ] **Step 4: Implement.** Read `entrypoint` beside `name`, `nameSource`, `sessionId`; the name is taken when `sessionId === owner.sessionId` and (`nameSource === 'user'` or (`nameSource === undefined && entrypoint === 'claude-desktop'`)). The doc comment says three fields and why the Claude app's: it sets that title itself (`rename_session`), and its hook sends the same string as `session_title` on the next prompt (spec, decision 2; the session-name spec's decision 5 as Task 2 words it).
- [ ] **Step 5: Run** the step 2 command, then `cd cli && npx vitest run src/cable/hosts/observed.spec.ts src/services/devices.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `dial: a Claude app session the scan finds is named by the title its app gave it`.

### Task 2: The session-name spec reads three fields

**Layer:** docs. **Depends on:** none. **Effort:** `medium`.

**Red test:** none. Docs only. One commit.

**Files:**
- Modify: `docs/specs/2026-11-15-dial-session-name.md`

- [ ] **Step 1: Edit decision 5** ("Decided late"): the devices read `name`, `nameSource` and `entrypoint` of that one record (beside `sessionId`, decision 6), and nothing else from it. A `user` name is shown, and, for the Claude app alone, a name with no `nameSource` when `entrypoint` is `claude-desktop`: the app sets that title itself and its hook sends the same string as `session_title` on the next prompt. A `derived` name, and a CLI record with no `nameSource`, are still refused. Widened 2026-11-17, link to `../plans/2026-11-17-dial-recap-after-restart-design.md`.
- [ ] **Step 2: Edit the two other sentences that say `user` only**, so the doc says one thing: in "The open scan's name", "`nameSource` must be the string `user`" gains "or absent with `entrypoint` `claude-desktop`"; in "Data", "`name` with `nameSource: user`" gains the same. Nothing else changes.
- [ ] **Step 3: Check** from the repository root: `git diff --stat` lists this file alone, and `grep -n "claude-desktop" docs/specs/2026-11-15-dial-session-name.md` shows the three places.
- [ ] **Step 4: Commit** `docs(dial): the session-name spec takes the Claude app's own title`.

### Task 3: The scan reads each idle session's last answer before it lists any

**Layer:** devices service process. **Depends on:** none. **Effort:** `xhigh` (the order of reads against the dial's 1 s sync and the hooks; the race the builder check found).

**Red test:** `cli/src/cable/hosts/observed.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts` (`scanOnce`, `readAnswer`; new private `busyOf`, `answersOf`; new module function `cutAnswer`)
- Test: `cli/src/cable/hosts/observed.spec.ts`
- Modify: `cli/e2e/dialAppFilter.e2e.ts` (the scan line's regex in `a dial plugged in while VS Code is already in front (the watch started first)…`), `cli/e2e/deviceWithoutApp.e2e.ts` (the scan line's regex in `an agent found by the scan reads the name…`, near line 239, only)

**Interfaces:**
- Produces (all private to `observed.ts`):
  - `function cutAnswer(text: string): string`: 300 code points, `…` past it (the body of `readAnswer`'s cut today). `readAnswer` uses it.
  - `private async busyOf(listing: readonly [string, ExternalEngine][], owners: ReadonlyMap<string, SessionOwner>): Promise<ReadonlySet<string>>`: the session ids of the Claude Code / Codex sessions whose `openSessions.busy(owner)` says true, one at a time; a rejection counts as busy (as `OpenSessions.busy` treats an engine that cannot say).
  - `private async answersOf(listing, rows: ReadonlyMap<string, { cwd?: string; transcriptPath?: string | null }>, busy: ReadonlySet<string>): Promise<ReadonlyMap<string, string>>`: for each Claude Code / Codex session of `listing` not in `busy`, with a truthy `transcriptPath` and a folder not within `deps.excluded`, `deps.lastAnswer(engine, transcriptPath)`, one at a time; a rejection or an empty answer gives none and logs nothing.
- `scanOnce` order: `owners` → `scanned` → `rows` → `listing` → `learning = now()` → `appsOf` → `namesOf` → `busyOf` → `answersOf` → `ms = now() - learning` → the loop, which walks `listing` (not every open session: a session it has not read is not listed this look) and keeps its skip of a session `this.entries` already has → the line → one `emit()`. In the loop: a session in `busy` gets `setState(entry, 'working', now)`; one with an answer gets `entry.agent.lastAnswer = cutAnswer(answer)` and `answered++`. No `await` in the loop.

- [ ] **Step 1: Write the tests**, in a new `describe('ObservedSource and the last answer the scan reads')` with its own `found(s, sessionId, pid, engine = 'claude', transcriptPath = '/t/<id>.jsonl')` that sets `open`, `owners` (record = session id), `externals`, and `working.set(sessionId, false)` (idle).
  - `a Claude session the scan lists idle reads its last answer, cut at 300 code points`: `answers.set('/t/a.jsonl', 'Done: 3 files')` and `answers.set('/t/b.jsonl', '😀'.repeat(301))`; after `scanOpen`, `a` has `lastAnswer: 'Done: 3 files'`, `b` has `'😀'.repeat(299) + '…'`.
  - `a Codex session the scan lists idle reads its last answer, once`: a `lastAnswer` spy is called with `('codex', '/t/c.jsonl')` and the agent holds its answer; a second and third `scanOpen` call it no more.
  - Holding a read: `setup`'s `busy` may await a held promise as `hold` does for `owners` (a small addition to `setup`, no existing test changed); `lastAnswer` and `recordName` are held through `over`, as the name tests hold `recordName`.
  - `one found in a turn is not read and reads working`: `working.set('a', true)`; the spy is not called; state `working`, no `lastAnswer`.
  - `one with no transcript path, or of another engine, is not read`: a Claude one with `transcriptPath: null` and a `grok` one; the spy is not called; both listed idle.
  - `a read that fails or finds nothing leaves no recap, still lists it, and logs no error text` (`it.each`: `async () => undefined`, `async () => ''`, `async () => { throw new Error('EACCES /Users/someone/.claude/projects/x.jsonl') }`): listed, idle, no `lastAnswer`; `logs` is exactly the line with `0 answered`, and holds no `someone`.
  - `a hook heard while the answers are read wins`: `lastAnswer` returns a held promise; once called, `ingest(ev('turn-start', { sessionId: 'a', callerPid: 11, cwd: '/x/a' }))`; then release with `'old answer'`; one agent, `state: 'working'`, no `lastAnswer`.
  - `no reader of list() sees a session of the look half-read`: `busy` and `lastAnswer` each return a held promise (two sessions, `a` idle and `b` idle); while `busy` is pending `src.list()` is `[]`; after releasing `busy`, while `lastAnswer` is pending, `src.list()` is still `[]`; a `changes` listener records `src.list()` at each call; after the release and `await scan`, `changes` was called once, and the list it saw holds `a` and `b` each with its `lastAnswer`.
  - `a recap from before the dial is history: idle, not unseen, nothing told`: after `scanOpen` the agent is `{ state: 'idle', unseenDone: false, lastAnswer: 'Done' }` and `changes` was called once.
  - `at most 50 answers are read a look, and none past them is listed`: 51 idle sessions; the spy is called 50 times; `src.list()` has 50, each with a `lastAnswer`.
  - `Harness's own session is never read for an answer`: a session whose row `cwd` is `/data/harness/voice`; the spy is not called and nothing is listed.
  - `the scan's line counts the answered ones and times every read of the look`: two idle Claude sessions `a` (pid 11) and `b` (pid 12), both with transcripts; `apps` adds 7 to `clock.t` and knows pid 11; `recordName` adds 5 per call and names `a` only; `busy` adds 3 per call; `lastAnswer` adds 2 per call and answers `a` only. `logs` equals `['[observed] scan · 2 found · 1 app known · 1 named · 1 answered · 27 ms']` (7 + 2·5 + 2·3 + 2·2); no log holds the answer, `/t/`, or the name.
  - The four existing exact line assertions (`the scan's log line counts and names nothing`, `a reader that %s still lists the session by its folder`, `the scan's line counts the named ones and holds no name`, `with no reader the scan names by folder`) gain `· 0 answered` before the `ms` (their sessions read busy).
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts`. Expected: FAIL in the new answer tests, the half-read test (today `list()` holds the session while `busy` is pending), the line test and the four edited lines; `one found in a turn…`, `one with no transcript path…`, `a hook heard…` and `Harness's own…` may pass already.
- [ ] **Step 3: Commit** `test(dial): the scan reads an idle session's last answer before it lists it (red)`.
- [ ] **Step 4: Implement** the Interfaces above. The comment at the reads says why the busy checks moved out of the loop: the dial reads `list()` every second and `pushRestores` marks an agent restored before reading it, so a session listed before its answer was read would never be restored (the builder check's finding). The comment at the line says `ms` is every read of the look.
- [ ] **Step 5: Edit the two e2e line regexes** to `· 0 named · \d+ answered · \d+ ms` (`dialAppFilter.e2e.ts`) and `· 1 named · \d+ answered · \d+ ms` (`deviceWithoutApp.e2e.ts`): `\d+`, as their sessions read busy before Task 4 and idle after it.
- [ ] **Step 6: Run** the step 2 command, then `cd cli && npx vitest run src/cable src/services/devices.spec.ts src/architecture.spec.ts && npm run typecheck`. Expected: PASS, and no existing expectation of `observed.spec.ts` edited but the four lines.
- [ ] **Step 7: Run** on this Mac, `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts e2e/dialAppFilter.e2e.ts`. Expected: PASS.
- [ ] **Step 8: Commit** `dial: an idle session the scan finds carries its last answer from its first listing`.

### Task 4: The fake Claude Code says busy and idle in its record

**Layer:** test harness. **Depends on:** none. **Effort:** `high` (every e2e file's Claude Code reads it; a turn the scan used to read `working` now reads idle).

**Red test:** none. No production file changes. One commit.

**Files:**
- Modify: `cli/e2e/harness/fakeEngine.mjs`
- Modify: `cli/e2e/harness/outsideAgent.ts` (`Outside.named`, new `Outside.idle`)
- Modify: `cli/e2e/deviceWithoutApp.e2e.ts` (the two `named` calls in `an agent found by the scan reads the name…`, only)

**Interfaces:**
- Produces:
  - Claude Code's process record (`<sessions>/<pid>.json`) holds `status`: `'idle'` as `announceProcess` writes it (start, `!clear`); `'busy'` once a prompt's turn opens (after its `UserPromptSubmit` hooks, where `open` is set to the turn); `'idle'` once the turn is over: in `finish` after its Stop hooks ran (Claude Code takes no prompt until they have), and, for a turn that ends without `finish` (the Esc interrupt, `goalpause`, `latestop`), where `open` goes back to null. Codex writes none (its busy reader reads its rollout).
  - Every write of the record goes to `<record>.tmp` and is renamed over, so the daemon never reads half a record. A status write reads the record and replaces `status` only, so fields a test wrote (`name`, `nameSource`, `entrypoint`) stay, as Claude Code keeps its own.
  - `Outside.idle(d: IsolatedDaemon): Promise<void>`: waits (`until`, 30 s, 100 ms) until its record reads `status: 'idle'`.
  - `Outside.named(d: IsolatedDaemon, name: string, fields: { nameSource?: 'user' | 'derived'; entrypoint?: string }): Promise<void>`: awaits `idle(d)` first (the engine writes no status until its next prompt then, so the rewrite never races its own), then writes the record with `name` and the given fields only. Its comment names the Claude app's record (`entrypoint: 'claude-desktop'`, no `nameSource`).

- [ ] **Step 1: Implement** the Interfaces above, with one helper in `fakeEngine.mjs` for the status write (Claude only, only when `procStart` wrote a record). The comment says why: Claude Code's record says `idle` between turns, and the devices' scan reads a session's last answer only when it does (docs/plans/2026-11-17-dial-recap-after-restart-design.md); without it every session the scan found read `working`.
- [ ] **Step 2: Update the two callers** to `await mine.named(d, 'Tho 7f3a91c2', { nameSource: 'user' })` and `await made.named(d, 'Fix login 5d2e8c41', { nameSource: 'derived' })`.
- [ ] **Step 3: Run** `cd cli && npm run typecheck`, then on this Mac `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts e2e/dialAppFilter.e2e.ts e2e/devicesProcess.e2e.ts e2e/dialTerminalFollow.e2e.ts e2e/deviceNotify.e2e.ts e2e/deviceCodex.e2e.ts e2e/dialAppFilterOnDial.e2e.ts e2e/deviceClaudeOrca.e2e.ts`. Expected: PASS. A test that relied on a found Claude session reading `working` (spec, Tests) is a finding: report it with its file and test name, do not loosen it.
- [ ] **Step 4: Commit** `test(e2e): the fake Claude Code says busy and idle in its process record`.

### Task 5: End to end: restored recap and Claude app name

**Layer:** test: the real daemon, a fake dial, the fake Claude Code outside a pane. **Depends on:** 1 (the Claude app's name), 3 (the scan's answer read), 4 (the idle record, `named`, `idle`). **Effort:** `high`.

**Red test:** none. No production file changes. One commit.

**Files:**
- Modify: `cli/e2e/deviceWithoutApp.e2e.ts` (one new test; the name test extended; the header's list gains a line)

**Interfaces:**
- Consumes: `Outside.idle`, `Outside.named` (Task 4); `fresh`, `startOutside`, `showing`, `heard`, `ids` (this file); `dial.messages`, `dial.next`.

- [ ] **Step 1: Write the test** `an agent answered before the dial connects is restored with its last answer, and nothing is told as done`.
  - `fresh()`; `startOutside(d, 'in-ghostty', { TERM_PROGRAM: 'ghostty' })`; `type('before the dial')`; wait for its Stop (`ran(d, 'Stop')`), then `await engine.idle(d)`.
  - Plug the dial; `heard` a `summary` with `agentId === engine.id` and `restore === true`, within 15 s; its `text` contains `answer 1: before the dial`.
  - No `turn.done` and no `summary` without `restore` for `engine.id` in `dial.messages`.
  - The log matches `/\[observed\] scan · 1 found · \d+ app known · 0 named · 1 answered · \d+ ms/` and does not contain `answer 1`.
- [ ] **Step 2: Extend** `an agent found by the scan reads the name the person gave it…` with a third session `scratch-2016c`, its turn done, `await app.named(d, 'Plan 9c4e1b07', { entrypoint: 'claude-desktop' })`. Its row reads `name: 'Plan 9c4e1b07'`; the line regex (Task 3's) becomes `/\[observed\] scan · 3 found · \d+ app known · 2 named · \d+ answered · \d+ ms/`; the log does not contain `9c4e1b07`. The test's title gains "and the Claude app's own title names it".
- [ ] **Step 3: Run** on this Mac, `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts`. Expected: PASS, none skipped.
- [ ] **Step 4: Commit** `test(e2e): a session found by the scan is restored with its last answer, and a Claude app session by its title`.

---

## Verification

**Platforms the pull request names:** macOS and Linux, run (unit specs on Linux in PR CI; e2e on this Mac and on Linux in `cli-e2e.yml`). Windows: the scan and the reader run there with no platform branch in this change; the by-hand Windows workflow (`windows.yml`) runs a fixed list of specs without these, so it is not run (as the session-name spec decided for the same code). The Claude app's records exist on macOS and Windows.

**Never touched by a tester or a test:** `~/.claude`, `~/.codex`, `~/.harness`, any real transcript or process record, Diego's daemon (port 18473) and tmux server, his dial, the Claude app, Herdr.app, Orca, any backend, production.

**Temporary workflow:** none. The repo's own `cli-e2e.yml` runs the long check by hand.

**Local gates**, recorded in the pull request, on this Mac at the final head:
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit; paste its output. No coverage gate applies (no path under `src/core/`, `src/services/`, `src/harnessd/` or another gate's area changes; `src/cable/hosts/` and `e2e/` are in none), so it should select none; if it selects one, run it.
- `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts src/services/devicesListener.spec.ts src/architecture.spec.ts`.
- `git diff --stat origin/main -- cli/src/core cli/src/architecture.coreFiles.txt cli/src/cable/hosts/lastAnswer.ts cli/src/cable/cableHost.ts cli/src/cable/cableSession.ts cli/src/services/devices.ts` prints nothing.
- Not needed: `npm run test:core`, `test:harnessd`, the serial and PTY specs (no path of theirs changes).

**1. The restored recap and the Claude app name, end to end (tester, this Mac)**
- Run at the final head: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts e2e/dialAppFilter.e2e.ts e2e/dialAppFilterOnDial.e2e.ts e2e/devicesProcess.e2e.ts e2e/dialTerminalFollow.e2e.ts e2e/deviceNotify.e2e.ts e2e/deviceCodex.e2e.ts e2e/deviceClaudeOrca.e2e.ts e2e/dialClaudeAppFollow.e2e.ts`. `E2E_BUNDLE=1` builds the daemon that ships; `TMPDIR=/tmp` keeps socket paths under the limit. A few minutes.
- Isolation, the suite's own (`cli/e2e/harness/daemon.ts`, cli/AGENTS.md rules 5 and 6): a throwaway home, data folder, Claude and Codex homes, a private port and tmux server, fake engines, a fake dial on a pseudo-terminal (`HARNESSD_TEST_DIAL_PORT`); no backend, no account, no secret.
- A person sees: every test passes, none skipped; in the new test, a `summary` with `restore: true` carrying `answer 1: before the dial` and no `turn.done`; the log's scan line with `1 answered` and no answer text.

**2. The whole e2e suite, on GitHub, by hand, once at the final head (tester)**
- Why: the fake Claude Code's record now says `busy`/`idle` for every e2e file, Harness agents included (the stop guard and display state read it too).
- Actions → CLI end to end → Run workflow, branch `fix/dial-recap-after-restart`, `agent_browser_podman` unticked (`.github/workflows/cli-e2e.yml`, eight Linux shards). The tester asks the orchestrator before starting it. Every shard passes and `e2e-summary` lists `e2e/deviceWithoutApp.e2e.ts`. The run's link goes in the pull request.
- Isolation: the suite's own, as above.
- Later pull requests: the files are in the nightly run already; no workflow change, no proposal.

**3. In PR CI, by itself:** `cli-typecheck` and `cli-tests` run `observed.spec.ts` and `recordName.spec.ts` on Linux.

**4. Numbers:** the scan's line is the measure (`answered`, and `ms` over every read). No hot path gains work: at most 50 tail reads per look, each once per session, bounded by the reader.

**5. Diego's own check, on his Mac and his dial (the owner's, not a tester's).** Needs his login, his Claude app, Herdr.app and Orca sessions, his dial and his eye; the PM asks him once the pull request is ready. With the build from the pull request's head installed (`make install-cli` in that checkout) and the daemon restarted, the dial shows each idle session's recap and the Claude app's sessions by their titles, before any prompt. Known and accepted: a Herdr.app session's own Herdr row shows no recap until its next hook (decision 3). The spec places this check with Diego, outside this branch's checks.

**6. Against production:** none.

## Open questions

1. **When Claude Code writes `status: 'idle'` relative to its Stop hooks.** Task 4 has the fake write it after the Stop hooks ran (and, for a turn ended with no `finish`, where the turn ends). If real Claude Code writes `idle` before running its Stop hooks, the fake should follow, and `Outside.idle` then needs no change. Recommendation: after, as planned (Claude Code takes no prompt until its Stop hooks return); confirm or correct from a recorded Claude Code record.
