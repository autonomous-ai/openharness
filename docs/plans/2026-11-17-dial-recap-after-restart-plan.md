# Dial: an agent found by the scan shows its last recap and its Claude app name — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(dial): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message.

**Goal:** After a daemon restart, an idle Claude Code or Codex session the open scan finds shows its last answer on the dial at once (through the dial's restore), and a Claude app session shows the title its app gave it, with no new prompt. **Addendum (Tasks 6-10):** a Herdr.app session the scan found is paired with the Herdr terminal running it, by hc's own foreground pid, and so is listed once, on Herdr's page, with that recap, its words and its tap.

**Architecture (addendum, Tasks 6-10):**
- **`hcClient.ts`** keeps `foreground.pid` of each terminal (`HcTerminal.foregroundPid`, a positive safe integer, else none).
- **`hcSource.ts`** answers `terminalOf(pid)`: the address of the one live terminal whose foreground is that pid, none for zero or two. It tells a change (`onChange`) when that index changes too.
- **`observed.ts`** takes it as an optional `ObservedDeps.herdrTerminal(pid)`, asked only for entries with no caller (no hook yet): in the scan's loop, and again on each hc change (`placeHerdr()`, which `devices.ts` wires to `hcSource.onChange`). A paired entry is placed as a hook from that terminal would place it (host and app `herdr`, Herdr's bundle, the `herdr-app` pane), with no hook state written: it keeps no caller and no hints, and only `locate()` reads the pairing. A real hook drops the pairing and places the entry itself; a pairing that no longer holds is taken back to what the scan gave the entry.
- The PM's decision (2026-11-17): a pairing by a foreground pid equal to the session's pid, exact and unique, is a certain identity, so the paired entry is placed exactly as a hook would place it, words included, under Herdr's existing `canType` (`reports`) and `canFocus` / `canShow` (`shows`) rules, with nothing special-cased.

**Architecture (Tasks 1-5, done):**
- **`observed.ts` `scanOnce`** reads everything of a look before its loop: apps and names (as today), then each Claude Code / Codex session's busy check (moved out of the loop), then each idle one's last answer with the Stop hook's reader (`deps.lastAnswer`). The loop then adds the entries, sets what was read and emits once, with no await in between. Nothing is stored; the state stays `idle`, `unseenDone` stays false, and the dial gets the recap through its existing restore (`summary`, `restore: true`).
- **`recordName.ts` `readRecordName`** also takes a record's `name` when it has no `nameSource` and `entrypoint === 'claude-desktop'` (N1).
- **The e2e fake Claude Code** writes `status` (`busy` / `idle`) in its process record, as Claude Code does, so the scan's idle-only read runs end to end.
- Everything is in the devices process. Nothing under `cli/src/core` changes (cli/AGENTS.md rule 7).

**Tech Stack:** TypeScript daemon (Node, vitest) in `cli/`; the e2e suite (real daemon, fake engines, fake dial).

**Spec:** `docs/plans/2026-11-17-dial-recap-after-restart-design.md`, with its "Addendum: a Herdr.app session the scan found is paired with its Herdr terminal" (decisions 5-7 and its Design) for Tasks 6-10. Read it with this plan, the root `AGENTS.md` and `cli/AGENTS.md` (Protect the core, rule 7; rule 4 for `services/devices.ts`; rules 5 and 6 for e2e).

## Base

- Branch `fix/dial-recap-after-restart` (PR #4391), at `ca2087458c`, in the worktree `/Users/duynguyen/orca/workspaces/autonomous-harness/dial-recap-restart`. Tasks 1-5 and the review fixes are landed there (below). Nothing else has to merge first.
- `cli/node_modules` is installed. If a task finds it missing: `cd cli && npm ci --no-audit --no-fund`, once, never two tasks at once.
- Names at `ca2087458c` for Tasks 6-10 (line numbers are hints, the tasks name functions):
  - `cable/hosts/hcClient.ts`: `HcTerminal`, `hcTerminal`, `READ`, `factsOf`, `TAKES`, `same`, `HC_MAX_TERMINALS` (1,024), `hcPaneKey`.
  - `cable/hosts/hcSource.ts`: `HcSource.snapshot`, `changed`, `note`, `take`, `told`, `clear`, `stop`, `shows`, `reports`, `onChange`, `emit`; its `shown` and `reported` sets.
  - `cable/hosts/herdrApp.ts`: `paneOf` (needs `place.host === 'herdr'`, `inHerdr(place.hints)`, `deps.hookIds === true`), `canType` (`deps.reports`), `canFocus` and `canShow` (`deps.shows`). `hostDetect.ts`: `inHerdr`, `APP_BUNDLES.herdr` (`dev.herdr.app`), `UNKNOWN_APP` (`'terminal'`). `open.ts`: `bundleOf`.
  - `cable/hosts/observed.ts`: `ObservedDeps`, `Entry` (`pid`, `hints`, `caller`, `panes`, `bundle`), `ObservedSource.locate`, `ingest`, `scanOnce` (its loop), `capabilities`, `send`, `focus`, `target`, `list`, `emit`.
  - `observed.spec.ts`: `setup`, `fakeActions` (the adapters list), `counted`, the `found` helper of `describe('ObservedSource and the last answer the scan reads')`.
  - `services/devices.ts`: `observedSource(...)`, `startDevices`'s `hookIds`, `herdrApp`, `hcSource`, the three `onChange` lines (`observed`, `herdr`, `hcSource` → `part.call('dial', outsideTurn)`).
  - `devices.spec.ts`: the `readers` mock (`known`, `owners`, `rows`, `working`, `answer`), `describe('Herdr\'s agents, through Herdr Core …')` with `terminal`, `hook`, `withHc` (`live`, `changed`, `hc.prompted`), `listed`, `host`, `orcaRuns`, `openHerdr`, `switchTo`, `logs`.
  - `src/testing/fakeHc.ts`: `fakeHc`, `FakeHcTerminal` (its `more` overrides any field, `foreground` included), the default foreground pid `4242 + n`.
  - `e2e/harness/hcCore.ts`: `AGENT`, `PrivateHc.plan`, `start`, `agent`, `rpc`, `report`, `screen`, `stop`. `e2e/deviceHerdrApp.e2e.ts`: `fresh`, `coreFor`, `speak`, `rosters`, `showing`, `rowOf`, `said`, `FILTER`, `ME`.
- Names at the first base (`e1f84bdfde`) for Tasks 1-5, kept for the record:
  - `cable/hosts/observed.ts`: `ObservedSource.scanOnce`, `namesOf`, `appsOf`, `readAnswer`, `entry`, `setState`, `learnTty`, `live`, `emit`; constants `MAX_SESSIONS` (50), `ANSWER_CHARS` (300); `ObservedDeps.lastAnswer`, `openSessions.busy`, `excluded`, `log`, `now`.
  - `cable/hosts/recordName.ts`: `readRecordName`, `MAX_RECORD_BYTES`. `lastAnswer.ts`: `readLastAnswer` (unchanged).
  - `observed.spec.ts`: `setup` (its `open`, `owners`, `working`, `externals`, `answers`, `logs`, `changes`, `clock`, `ev`; `busy` reads `working.get(owner.record) !== false`, and an owner's record is its session id unless one is given), the `found` helpers inside each `describe`.
  - `recordName.spec.ts`: `record`, `named`, `read`.
  - `e2e/harness/fakeEngine.mjs`: `announceProcess`, `finish`, `open`, `procStart`, the `goalpause` and `latestop` directives, the Esc interrupt. `e2e/harness/outsideAgent.ts`: `Outside.start`, `named`, `ran`. `e2e/deviceWithoutApp.e2e.ts`: `fresh`, `startOutside`, `showing`, `heard`, `rosters`, `ids`. `e2e/harness/daemon.ts`: `until`.
- If a name differs at the base, the implementer follows the code and says so in its report.
- The spec and this plan are tracked (`290c808870`); the addendum and this update are uncommitted. The main session commits them; no task does.

## Tasks at a glance

| Task | Status | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|---|
| 1 A Claude app record names its session | **done** `905f2f446d`, `800908889c` | `cli/src/cable/hosts/recordName.ts`, `recordName.spec.ts` | none | high | `recordName.spec.ts` |
| 2 The session-name spec reads three fields | **done** `9d8604e75c` | `docs/specs/2026-11-15-dial-session-name.md` | none | medium | none: docs only, one commit |
| 3 The scan reads each idle session's last answer before it lists any | **done** `01ec4bb006`, `76b6b3ba11` | `cli/src/cable/hosts/observed.ts`, `observed.spec.ts`, `cli/e2e/dialAppFilter.e2e.ts`, `cli/e2e/deviceWithoutApp.e2e.ts` (the scan line's assertion only) | none | xhigh | `observed.spec.ts` |
| 4 The fake Claude Code says busy and idle in its record | **done** `9ba52c911b` | `cli/e2e/harness/fakeEngine.mjs`, `cli/e2e/harness/outsideAgent.ts`, `cli/e2e/deviceWithoutApp.e2e.ts` (the two `named` calls only) | none | high | none: test harness only, one commit |
| 5 End to end: restored recap and Claude app name | **done** `07723fd328` | `cli/e2e/deviceWithoutApp.e2e.ts` | 1, 3, 4 | high | none: the end-to-end test of Tasks 1, 3 and 4, one commit |
| Review fixes | **done** `09567e50c3`, `b55b4551a0`, `634f81af54`, `ca2087458c` | `cli/src/cable/hosts/observed.ts`, `observed.spec.ts` | — | — | `observed.spec.ts` (a busy check that fails counts as busy; a last answer that cannot be read logs no error text) |
| 6 The hc client keeps each terminal's foreground pid | to do | `cli/src/cable/hosts/hcClient.ts`, `hcClient.spec.ts` | none | high | `hcClient.spec.ts` |
| 7 The hc source answers which terminal a pid runs in | to do | `cli/src/cable/hosts/hcSource.ts`, `hcSource.spec.ts` | 6 | high | `hcSource.spec.ts` |
| 8 A session the scan found is placed in the Herdr terminal running it | to do | `cli/src/cable/hosts/observed.ts`, `observed.spec.ts` | none | xhigh | `observed.spec.ts` |
| 9 The devices pair what the scan found with Herdr's terminals | to do | `cli/src/services/devices.ts`, `devices.spec.ts` | 7, 8 | high | `devices.spec.ts` |
| 10 End to end: a Herdr session found by the scan | to do | `cli/e2e/harness/hcCore.ts`, `cli/e2e/deviceHerdrApp.e2e.ts` | 9 | high | none: the end-to-end test of Tasks 6-9, one commit |

Longest chain of what is left: 6 → 7 → 9 → 10, four tasks (8 runs beside 6 and 7).

- Task 6 and Task 8 share no file and start at once. Task 8 tests through its own `ObservedDeps.herdrTerminal` stub, so it needs nothing of Tasks 6 and 7.
- Task 7 needs Task 6's `HcTerminal.foregroundPid`.
- Task 9 wires Task 7's `HcSource.terminalOf` into Task 8's `ObservedDeps.herdrTerminal` and `ObservedSource.placeHerdr`.
- Task 10 runs the real daemon through all of it. Its files are test files only.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/hosts/observed.ts`, `recordName.ts`, `hcClient.ts`, `hcSource.ts` | **Devices service process**, and only there | their specs (PR CI `cli-tests`); not under `test:core` |
| `cli/src/services/devices.ts` | **Devices service process** (its composition) | `devices.spec.ts` in PR CI, and **`npm run test:core` locally** (100% per file, cli/AGENTS.md rule 4; `scripts/local-checks.py` selects `cli-core` for it) |
| `cli/e2e/harness/fakeEngine.mjs`, `outsideAgent.ts`, `hcCore.ts`, `cli/e2e/*.e2e.ts` | Test: the real daemon, fake engines, fake dial, a private Herdr Core | Verification 1, 2 and 3 |
| `docs/specs/2026-11-15-dial-session-name.md` | Docs | review |

Not changed, and a diff in any is a finding:
- anything under `cli/src/core/`, and `cli/src/architecture.coreFiles.txt`;
- `cable/hosts/lastAnswer.ts`, `cable/hosts/herdrApp.ts`, `cable/hosts/hostDetect.ts`, `cable/hosts/registry.ts`, `cable/cableHost.ts`, `cable/cableSession.ts`, `src/testing/fakeHc.ts`, `e2e/harness/fakeEngine.mjs`;
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
- **Not in this pull request:** a session first heard of by a hook other than a start (decision 7 of the session-name spec). Herdr.app's rows, once decision 3's limit, are Tasks 6-10 (the addendum).

### Global Constraints (addendum, Tasks 6-10)

- **The pid.** `foreground.pid` from hc only: a positive safe integer (`Number.isSafeInteger(pid) && pid > 0`), else none. Never the terminal's own `pid` as a stand-in, never a process's environment (cli/AGENTS.md rule 4), no new read of anything: it rides hc's snapshot and `foreground` events.
- **Unique.** `terminalOf(pid)` answers only when exactly one live terminal's foreground is that pid. Two or more, or none: nothing is paired, and Herdr's row stays as before this branch.
- **Who is paired.** Only an entry with no caller (`Entry.caller === undefined`: no hook has told of it), by its `Entry.pid` (the scan's `owner.pid`). An entry a hook told of is never asked about.
- **Placed as a hook would place it (PM, 2026-11-17).** Host `herdr`, app `herdr` (no `appPending`), bundle `APP_BUNDLES.herdr`, and the pane the `herdr-app` adapter's own `paneOf` gives for hints `{ HC_TERMINAL_ID: <address> }`. Words, tap and rest follow that pane under the adapter's own rules (`canType` = `reports`, `canFocus` = `shows`, `canShow` = Herdr in front and `shows`); nothing in `herdrApp.ts`, `capabilities`, `send` or `focus` changes for it.
- **No forged hook state.** A pairing writes no `caller`, no `hints`, no `callerPid`, no `title`. It lives in one field (`Entry.paired`), and only `locate()` turns it into a place.
- **A real hook wins.** `ingest` clears `Entry.paired` before it places the entry by its own hints; with its caller set, the entry is never paired again.
- **Taken back.** When the lookup no longer names the paired terminal (its foreground moved, it finished or was removed, two terminals now say that pid, the hc source stopped), the next `placeHerdr()` puts back host `terminal`, the app and `appPending` the scan gave it, no bundle, and no Herdr pane. A pairing that moves to another terminal follows it.
- **The line.** `[observed] herdr · <n> paired`: logged by a look of the scan, or a `placeHerdr()` call, that paired at least one entry (new or moved), `<n>` how many; nothing else of the terminal or the session in any line. The scan's and hc's own lines are unchanged.
- **Where it runs.** macOS only: `hcSource` exists only on `darwin`, and the lookup is passed only where the devices take a hook's address (`hookIds`, Open question 1). Elsewhere the lookup is absent and nothing changes.
- **Bounds.** Per hc change, one lookup per unhooked entry (at most 50) over the hc source's live terminals (at most 1,024). No timer, no poll.

## Review Focus

1. **Harness's own session in the data folder** (the voice router's Claude Code): `entry()` refuses it, but `listing` still holds it, so the scan would read a Harness transcript for nothing. Expected: its answer is never read. Task 3 (`Harness's own session is never read for an answer`).
2. **A reader that throws with a path in its message** (`EACCES /Users/someone/...`): the session is still listed, with no recap, and no log line holds the text. Task 3 (`a read that fails or finds nothing leaves no recap…`).
3. **An answer past 300 code points made of emoji**: cut at a code point, never through a surrogate pair. Task 3 (`…cut at 300 code points`).
4. **More than 50 new idle sessions in one look**: at most 50 answers read, and the loop lists no session it has not read (it walks `listing`, not every open session). Task 3 (`at most 50 answers are read a look, and none past them is listed`).
5. **The dial's 1 s sync during a slow look**: a `list()` while a busy check or an answer read is pending holds none of the look's sessions; the first emit already carries every recap. Task 3 (`no reader of list() sees a session of the look half-read`).

### Review Focus (addendum, Tasks 6-10)

1. **The person's next prompt after a pairing.** Its hook must place the agent by its own hints and the pairing must never come back, though hc still reports the same pid. Task 8 (`a hook heard after the pairing places it by its own hints, and no later placeHerdr pairs it again`).
2. **Herdr's listing arrives after the scan** (hc's socket answers after the attach's scan, or the terminal starts later). Expected: paired at that hc change, one change told, the session listed once. Tasks 7 and 9 (`a foreground that moves tells one change though no listed row changed`; `Herdr's list after the scan pairs it…`).
3. **The dial detached, or Herdr Core stopped, with a pairing held.** The hc source clears; the pairing must be taken back so no stale Herdr pane takes words, even when no row was listed. Tasks 7 and 9 (`stopped, it answers none and tells the change, though it listed no row`; `detached, the pairing is taken back`).
4. **Two terminals reporting one pid** (a stale foreground, a program handed between terminals): nothing paired. Task 7 (`two terminals whose foreground is the same pid answer none`).
5. **Words to a paired agent whose terminal hc no longer reports an agent in**: refused by the adapter's `canType`, nothing typed. Task 8 (`a terminal hc reports no agent in takes no words, as for a hooked agent`).

---

### Task 1: A Claude app record names its session

**Status: done** (`905f2f446d` red, `800908889c`).

**Layer:** devices service process. **Depends on:** none. **Effort:** `high` (what the devices read of a file another program writes).

**Red test:** `cli/src/cable/hosts/recordName.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/recordName.ts` (`readRecordName` and its doc comment)
- Test: `cli/src/cable/hosts/recordName.spec.ts`

**Interfaces:**
- Produces: `readRecordName` unchanged in signature; it returns `observedTitle(name)` also for `{ name, sessionId, entrypoint: 'claude-desktop' }` with no `nameSource` key (or `nameSource: undefined`).

- [x] **Step 1: Write the tests.** Beside `named`, a fixture `app = { pid: 11, sessionId: 's', cwd: '/x', status: 'idle', name: 'Tho', entrypoint: 'claude-desktop', hostSessionId: 'h' }` (no `nameSource`).
  - `reads the title the Claude app gave its session`: `read(record(11, app))` is `'Tho'`; the cleaning holds (`{ ...app, name: '  Fix \t login ' }` reads `'Fix login'`).
  - In the `gives none for %s` table, add: `a cli record with no nameSource` (`{ ...app, entrypoint: 'cli' }`), `an sdk-cli record with no nameSource` (`{ ...app, entrypoint: 'sdk-cli' }`), `no entrypoint and no nameSource` (`{ ...app, entrypoint: undefined }`), `a Claude app record with a derived name` (`{ ...app, nameSource: 'derived' }`), `a Claude app record with a nameSource of 7` (`{ ...app, nameSource: 7 }`), `an entrypoint of 7` (`{ ...app, entrypoint: 7 }`), `an entrypoint of Claude-Desktop` (`{ ...app, entrypoint: 'Claude-Desktop' }`), `a Claude app record a /clear moved to another session` (`{ ...app, sessionId: 't' }`).
  - The existing `no nameSource` row stays (its record has no `entrypoint`).
- [x] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/recordName.spec.ts`. Expected: FAIL in `reads the title the Claude app gave its session` only; every new `gives none` row passes.
- [x] **Step 3: Commit** `test(dial): a Claude app session's own title names it from its record (red)`.
- [x] **Step 4: Implement.** Read `entrypoint` beside `name`, `nameSource`, `sessionId`; the name is taken when `sessionId === owner.sessionId` and (`nameSource === 'user'` or (`nameSource === undefined && entrypoint === 'claude-desktop'`)). The doc comment says three fields and why the Claude app's: it sets that title itself (`rename_session`), and its hook sends the same string as `session_title` on the next prompt (spec, decision 2; the session-name spec's decision 5 as Task 2 words it).
- [x] **Step 5: Run** the step 2 command, then `cd cli && npx vitest run src/cable/hosts/observed.spec.ts src/services/devices.spec.ts && npm run typecheck`. Expected: PASS.
- [x] **Step 6: Commit** `dial: a Claude app session the scan finds is named by the title its app gave it`.

### Task 2: The session-name spec reads three fields

**Status: done** (`9d8604e75c`).

**Layer:** docs. **Depends on:** none. **Effort:** `medium`.

**Red test:** none. Docs only. One commit.

**Files:**
- Modify: `docs/specs/2026-11-15-dial-session-name.md`

- [x] **Step 1: Edit decision 5** ("Decided late"): the devices read `name`, `nameSource` and `entrypoint` of that one record (beside `sessionId`, decision 6), and nothing else from it. A `user` name is shown, and, for the Claude app alone, a name with no `nameSource` when `entrypoint` is `claude-desktop`: the app sets that title itself and its hook sends the same string as `session_title` on the next prompt. A `derived` name, and a CLI record with no `nameSource`, are still refused. Widened 2026-11-17, link to `../plans/2026-11-17-dial-recap-after-restart-design.md`.
- [x] **Step 2: Edit the two other sentences that say `user` only**, so the doc says one thing: in "The open scan's name", "`nameSource` must be the string `user`" gains "or absent with `entrypoint` `claude-desktop`"; in "Data", "`name` with `nameSource: user`" gains the same. Nothing else changes.
- [x] **Step 3: Check** from the repository root: `git diff --stat` lists this file alone, and `grep -n "claude-desktop" docs/specs/2026-11-15-dial-session-name.md` shows the three places.
- [x] **Step 4: Commit** `docs(dial): the session-name spec takes the Claude app's own title`.

### Task 3: The scan reads each idle session's last answer before it lists any

**Status: done** (`01ec4bb006` red, `76b6b3ba11`). Review fixes after it: `09567e50c3` (a space the tests lost), `b55b4551a0` (a busy check that fails counts as busy in the scan), `634f81af54` red and `ca2087458c` (a last answer that cannot be read logs no error text).

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

- [x] **Step 1: Write the tests**, in a new `describe('ObservedSource and the last answer the scan reads')` with its own `found(s, sessionId, pid, engine = 'claude', transcriptPath = '/t/<id>.jsonl')` that sets `open`, `owners` (record = session id), `externals`, and `working.set(sessionId, false)` (idle).
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
- [x] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts`. Expected: FAIL in the new answer tests, the half-read test (today `list()` holds the session while `busy` is pending), the line test and the four edited lines; `one found in a turn…`, `one with no transcript path…`, `a hook heard…` and `Harness's own…` may pass already.
- [x] **Step 3: Commit** `test(dial): the scan reads an idle session's last answer before it lists it (red)`.
- [x] **Step 4: Implement** the Interfaces above. The comment at the reads says why the busy checks moved out of the loop: the dial reads `list()` every second and `pushRestores` marks an agent restored before reading it, so a session listed before its answer was read would never be restored (the builder check's finding). The comment at the line says `ms` is every read of the look.
- [x] **Step 5: Edit the two e2e line regexes** to `· 0 named · \d+ answered · \d+ ms` (`dialAppFilter.e2e.ts`) and `· 1 named · \d+ answered · \d+ ms` (`deviceWithoutApp.e2e.ts`): `\d+`, as their sessions read busy before Task 4 and idle after it.
- [x] **Step 6: Run** the step 2 command, then `cd cli && npx vitest run src/cable src/services/devices.spec.ts src/architecture.spec.ts && npm run typecheck`. Expected: PASS, and no existing expectation of `observed.spec.ts` edited but the four lines.
- [x] **Step 7: Run** on this Mac, `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts e2e/dialAppFilter.e2e.ts`. Expected: PASS.
- [x] **Step 8: Commit** `dial: an idle session the scan finds carries its last answer from its first listing`.

### Task 4: The fake Claude Code says busy and idle in its record

**Status: done** (`9ba52c911b`).

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

- [x] **Step 1: Implement** the Interfaces above, with one helper in `fakeEngine.mjs` for the status write (Claude only, only when `procStart` wrote a record). The comment says why: Claude Code's record says `idle` between turns, and the devices' scan reads a session's last answer only when it does (docs/plans/2026-11-17-dial-recap-after-restart-design.md); without it every session the scan found read `working`.
- [x] **Step 2: Update the two callers** to `await mine.named(d, 'Tho 7f3a91c2', { nameSource: 'user' })` and `await made.named(d, 'Fix login 5d2e8c41', { nameSource: 'derived' })`.
- [x] **Step 3: Run** `cd cli && npm run typecheck`, then on this Mac `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts e2e/dialAppFilter.e2e.ts e2e/devicesProcess.e2e.ts e2e/dialTerminalFollow.e2e.ts e2e/deviceNotify.e2e.ts e2e/deviceCodex.e2e.ts e2e/dialAppFilterOnDial.e2e.ts e2e/deviceClaudeOrca.e2e.ts`. Expected: PASS. A test that relied on a found Claude session reading `working` (spec, Tests) is a finding: report it with its file and test name, do not loosen it.
- [x] **Step 4: Commit** `test(e2e): the fake Claude Code says busy and idle in its process record`.

### Task 5: End to end: restored recap and Claude app name

**Status: done** (`07723fd328`).

**Layer:** test: the real daemon, a fake dial, the fake Claude Code outside a pane. **Depends on:** 1 (the Claude app's name), 3 (the scan's answer read), 4 (the idle record, `named`, `idle`). **Effort:** `high`.

**Red test:** none. No production file changes. One commit.

**Files:**
- Modify: `cli/e2e/deviceWithoutApp.e2e.ts` (one new test; the name test extended; the header's list gains a line)

**Interfaces:**
- Consumes: `Outside.idle`, `Outside.named` (Task 4); `fresh`, `startOutside`, `showing`, `heard`, `ids` (this file); `dial.messages`, `dial.next`.

- [x] **Step 1: Write the test** `an agent answered before the dial connects is restored with its last answer, and nothing is told as done`.
  - `fresh()`; `startOutside(d, 'in-ghostty', { TERM_PROGRAM: 'ghostty' })`; `type('before the dial')`; wait for its Stop (`ran(d, 'Stop')`), then `await engine.idle(d)`.
  - Plug the dial; `heard` a `summary` with `agentId === engine.id` and `restore === true`, within 15 s; its `text` contains `answer 1: before the dial`.
  - No `turn.done` and no `summary` without `restore` for `engine.id` in `dial.messages`.
  - The log matches `/\[observed\] scan · 1 found · \d+ app known · 0 named · 1 answered · \d+ ms/` and does not contain `answer 1`.
- [x] **Step 2: Extend** `an agent found by the scan reads the name the person gave it…` with a third session `scratch-2016c`, its turn done, `await app.named(d, 'Plan 9c4e1b07', { entrypoint: 'claude-desktop' })`. Its row reads `name: 'Plan 9c4e1b07'`; the line regex (Task 3's) becomes `/\[observed\] scan · 3 found · \d+ app known · 2 named · \d+ answered · \d+ ms/`; the log does not contain `9c4e1b07`. The test's title gains "and the Claude app's own title names it".
- [x] **Step 3: Run** on this Mac, `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts`. Expected: PASS, none skipped.
- [x] **Step 4: Commit** `test(e2e): a session found by the scan is restored with its last answer, and a Claude app session by its title`.

### Task 6: The hc client keeps each terminal's foreground pid

**Status:** to do. **Layer:** devices service process. **Depends on:** none. **Effort:** `high` (a field of another program's data, checked at the door).

**Red test:** `cli/src/cable/hosts/hcClient.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/hcClient.ts` (`HcTerminal`, `hcTerminal`, `READ` and its comment, `same`)
- Test: `cli/src/cable/hosts/hcClient.spec.ts`

**Interfaces:**
- Produces: `HcTerminal.foregroundPid?: number`: `foreground.pid` of hc's terminal (in a snapshot, a `missed` snapshot, `created` / `lost` / `restarted` data, and each `foreground` event), set only when `Number.isSafeInteger(pid) && pid > 0`. No fallback to the terminal's own `pid` (a shell holds that one; only the foreground is the program running now).
- `READ.foreground` becomes `['cwd', 'pid']`: `argv` and `name` of the foreground stay in the line they came in. `same` compares `foregroundPid`, so a `foreground` line that changes only the pid is told and one that repeats it tells nothing.

- [ ] **Step 1: Write the tests.**
  - `hcTerminal reads its foreground's pid when it is a positive safe integer, and none else`: `hcTerminal({ address: 't7', state: 'live', foreground: { argv: ['node'], cwd: '/w', name: 'node', pid: 4242 } })` has `foregroundPid: 4242`. `it.each` over `pid` values `0`, `-1`, `1.5`, `'4242'`, `2 ** 53`, `null`, over `foreground: 7`, and over no `foreground` with the terminal's own `pid: 4242`: no `foregroundPid` key (`not.toHaveProperty('foregroundPid')`).
  - `a subscription tells the foreground's pid and keeps nothing else new of it`: the fake server's recorded snapshot tells `t1` with `foregroundPid: 4242`, and the told object's keys are exactly `hcTerminal`'s fields (no `argv`, no `title`, no foreground `name`).
  - `a foreground line that changes only its pid is told; the same pid again tells nothing`: beside `a foreground's folder is the terminal's once hc tells it…`, two `server.event('foreground', { data: { argv: ['/usr/local/bin/node'], cwd: '/work/api', name: 'node', pid: 5000 }, terminal: 't7' })`; `changed` is told once, with `foregroundPid: 5000`.
  - Every existing exact expectation of a told terminal whose recording carries `foreground.pid` gains `foregroundPid` with that pid, and nothing else; the report lists them by test name.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/hcClient.spec.ts`. Expected: FAIL in the three new tests and in the existing expectations that gained `foregroundPid`.
- [ ] **Step 3: Commit** `test(dial): the hc client keeps each terminal's foreground pid (red)`.
- [ ] **Step 4: Implement** the Interfaces above. The comment at `READ` says why the pid is kept: the devices pair a session the scan found with the terminal running it by this pid (the spec's addendum, decision 5); it is an id, never logged or sent.
- [ ] **Step 5: Run** the step 2 command, then `cd cli && npx vitest run src/cable/hosts/hcSource.spec.ts src/cable/hosts/herdrApp.spec.ts src/services/devices.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `dial: the hc client keeps each terminal's foreground pid`.

### Task 7: The hc source answers which terminal a pid runs in

**Status:** to do. **Layer:** devices service process. **Depends on:** 6 (`HcTerminal.foregroundPid`). **Effort:** `high`.

**Red test:** `cli/src/cable/hosts/hcSource.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/hcSource.ts` (`note`, `snapshot`, `told`, `clear`; new `terminalOf`, new private `foregrounds`)
- Test: `cli/src/cable/hosts/hcSource.spec.ts`

**Interfaces:**
- Consumes: `HcTerminal.foregroundPid` (Task 6).
- Produces: `HcSource.terminalOf(pid: number): string | undefined`: the address of the one live terminal of this machine whose `foregroundPid` is `pid`, shown in Herdr's window or not, reporting an agent or not; none when no terminal or two or more say so, and none once stopped.
- Private `foregrounds: Map<string, number>` (address → pid), kept by `note()` beside `shown` and `reported` (a live terminal with a `foregroundPid` is set, any other deleted), cleared with them in `snapshot` and `clear`. Bounded by the client's 1,024 terminals.
- `onChange` is also told when that index changes and no listed row did (in `told`), and `clear()` tells a change when it cleared rows or foregrounds. No log line changes.

- [ ] **Step 1: Write the tests**, in the source's `describe`, setting a foreground pid through `FakeHcTerminal`'s `more` (`more: { foreground: { argv: [...], cwd, name: 'node', pid } }`); the fake's default is `4242 + n`:
  - `terminalOf answers the one live terminal whose foreground is that pid, shown or not, reporting or not`: `t1` (default 4242), `t2` with `labels: {}` and `status: null` (pid 4243) → `terminalOf(4242) === 't1'`, `terminalOf(4243) === 't2'`, `terminalOf(1) === undefined`.
  - `two terminals whose foreground is the same pid answer none`: `t1` and `t2` both at 4242 → `undefined`; once `t2`'s foreground moves to 5000, `t1` again.
  - `a terminal that finished or was removed answers none; a missed snapshot replaces every answer`.
  - `a foreground that moves tells one change though no listed row changed; nothing else is logged`: `t1`'s foreground to 5000 → the `onChange` listener is called once, `list()` is the same, the log gains no line.
  - `stopped, it answers none and tells the change, though it listed no row`: one terminal with `labels: {}` (no row), `stop()` → the listener called once, `terminalOf(4242) === undefined`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/hcSource.spec.ts`. Expected: FAIL in the five new tests.
- [ ] **Step 3: Commit** `test(dial): the hc source says which terminal a pid runs in (red)`.
- [ ] **Step 4: Implement** the Interfaces above. The comment at `terminalOf` says why only a unique answer counts: two terminals naming one pid leave no certain terminal, and a wrong one would take that session's words (the addendum, Design 9).
- [ ] **Step 5: Run** the step 2 command, then `cd cli && npx vitest run src/cable src/services/devices.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `dial: the hc source says which terminal a pid runs in`.

### Task 8: A session the scan found is placed in the Herdr terminal running it

**Status:** to do. **Layer:** devices service process. **Depends on:** none (its own `ObservedDeps.herdrTerminal`, stubbed in its tests). **Effort:** `xhigh` (who places an entry, a hook or a pairing; taking a pairing back; the scan's one emit).

**Red test:** `cli/src/cable/hosts/observed.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/observed.ts` (`ObservedDeps`, `Entry`, `locate`, `ingest`, `scanOnce`'s loop; new public `placeHerdr`, new private `pair`)
- Test: `cli/src/cable/hosts/observed.spec.ts` (`fakeActions` gains the Herdr adapter; a new `describe`)

**Interfaces:**
- Produces:
  - `ObservedDeps.herdrTerminal?(pid: number): string | undefined`: the hc terminal whose foreground is that pid, when exactly one is (Task 7's `HcSource.terminalOf`). Absent: nothing is paired.
  - `Entry.paired?: { address: string; app: string; appPending?: true }`: the hc terminal it is paired with, and the app (and `appPending`) the scan had given it, which a take-back puts back.
  - `ObservedSource.placeHerdr(): void`: for each entry with no caller, asks `herdrTerminal(entry.pid)` and pairs, moves or takes back (`pair`); one `emit()` when any changed; `[observed] herdr · <n> paired` when it paired or moved at least one.
  - `private pair(entry: Entry): boolean` (changed or not): no lookup, or an entry with a caller, changes nothing. A new address: keep `paired` (its `app` and `appPending` from before the first pairing; a move keeps them), `agent.host = 'herdr'`, `agent.app = 'herdr'`, `delete agent.appPending`, `entry.bundle = APP_BUNDLES.herdr`, `locate()`. No address while paired: host `terminal`, app and `appPending` from `paired`, `entry.bundle = undefined`, `paired = undefined`, `locate()`.
  - `locate()`: the place's `hints` are `{ HC_TERMINAL_ID: entry.paired.address }` while paired, else `entry.hints`. `entry.hints` itself is never written by a pairing: `learnApp` reads it as the latest hook's.
  - `ingest`: `entry.paired = undefined` before its `locate()`; its own hints, caller, host, app and bundle then place the entry, as today.
  - `scanOnce`'s loop: `pair(entry)` after the scan's app is set and before `learnTty`, counted; after the scan's line, `[observed] herdr · <n> paired` when `<n>` > 0; still one `emit()` and no `await` in the loop.
- `fakeActions`: the real `createHerdrAppAdapter` after tmux (as `devices.ts` orders them), `hookIds: true`, on `deps`' platform, with fakes `hcPrompt` (answers `{ outcome: 'sent' }`), `hcShows` (true), `hcReports` (true), `herdrInFront` (false). No existing test sends `HC_TERMINAL_ID`, so none should change; one that does is a finding for the report.

- [ ] **Step 1: Write the tests**, in a new `describe('ObservedSource and the Herdr terminal a session the scan found runs in')`, with a `found` helper as in the last-answer `describe` (idle, transcript `/t/<id>.jsonl`, answer `Done`) and `herdrTerminal` read from a `Map<number, string>` the test sets:
  - `paired by its pid, it is placed as its hook would place it, on Herdr's page, with its pane, words and tap there`: `a` (pid 11), the map `11 → 't7'`; after `scanOpen`, its row has `host: 'herdr'`, `app: 'herdr'`, no `appPending`, `paneKeys: ['herdr-app:t7']`, `state: 'idle'`, `lastAnswer: 'Done'`; its `{ host, app, paneKeys }`, `capabilities()` and `focus`'s target equal those of the same session in a second `setup` after `ingest(ev('session-start', { sessionId: 'a', callerPid: 11, hostHints: { HC_TERMINAL_ID: 't7', TERM_PROGRAM: 'ghostty' } }))`. `send(agent, 'next')` is `{ ok: true }`, `hcPrompt` was called with `['t7', 'claude', 'next']`, `counted(count)` ends `'herdr-app'`; `focus(agent)` opens `{ bundle: 'dev.herdr.app', pane: { adapter: 'herdr-app', id: 't7' } }`. `changes` was called once; `logs` is the scan's line then `'[observed] herdr · 1 paired'`.
  - `a terminal hc reports no agent in takes no words, as for a hooked agent`: `hcReports` false: `capabilities().voice` false, `send` refused with `did not answer`, `hcPrompt` never called.
  - `no lookup, or one that answers none, pairs nothing and logs no herdr line`: host `terminal`, app `terminal` with `appPending: true`, no `paneKeys`; no log line starts `[observed] herdr`.
  - `Herdr's list after the scan: placeHerdr pairs it and tells one change; again with nothing new, none`.
  - `a pairing that no longer holds is taken back to what the scan gave it; one that moves follows its terminal`: with `apps` naming pid 11 `vscode`, paired, then the map emptied and `placeHerdr()` → host `terminal`, app `vscode`, no `appPending`, no `paneKeys`, focus's target has no bundle; with no app known, `appPending: true` comes back; the map `11 → 't8'` → `paneKeys: ['herdr-app:t8']` and `'[observed] herdr · 1 paired'`.
  - `a hook heard after the pairing places it by its own hints, and no later placeHerdr pairs it again`: paired at `t7`, then `ingest(ev('turn-stop', { sessionId: 'a', callerPid: 11, hostHints: { TERM_PROGRAM: 'iTerm.app' } }))` → app `iterm`, no Herdr pane key; `placeHerdr()` with the map still `11 → 't7'` changes nothing, and the lookup spy is not called for 11. A hook with `{ HC_TERMINAL_ID: 't9', TERM_PROGRAM: 'ghostty' }` gives `paneKeys: ['herdr-app:t9']`.
  - `a hook heard while the scan's reads ran keeps its own place`: `lastAnswer` held; `ingest(ev('session-start', { sessionId: 'a', callerPid: 11, hostHints: { TERM_PROGRAM: 'ghostty' } }))`; released: no Herdr pane key, the lookup never called.
  - `the herdr line counts only: two paired in one look, and no pid, address or name in any line`: `a` (11 → `t7`), `b` (12 → `t8`) → `'[observed] herdr · 2 paired'`; no log line holds `t7`, `t8`, `11`, `12` as a word, or a session's name.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/observed.spec.ts`. Expected: FAIL in the new tests but `no lookup…` and `a hook heard while…`, which may pass already; every existing test passes.
- [ ] **Step 3: Commit** `test(dial): a session the scan found is placed in the Herdr terminal running it (red)`.
- [ ] **Step 4: Implement** the Interfaces above. The comment at `pair` says why it is a certain place: hc's own foreground pid equal to the session's pid, unique (the addendum, decision 5, and the PM's decision of 2026-11-17), so it is placed as a hook from that terminal would place it; and why it writes no hook state: a hook's own hints and caller are what later code and the next hook read, and the next hook wins.
- [ ] **Step 5: Run** the step 2 command, then `cd cli && npx vitest run src/cable src/services/devices.spec.ts src/architecture.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `dial: a session the scan found is placed in the Herdr terminal running it`.

### Task 9: The devices pair what the scan found with Herdr's terminals

**Status:** to do. **Layer:** devices service process (its composition). **Depends on:** 7 (`HcSource.terminalOf`, its change told), 8 (`ObservedDeps.herdrTerminal`, `placeHerdr`). **Effort:** `high`.

**Red test:** `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts` (`observedSource`'s parameters; `startDevices`: the lookup it passes, one `hcSource.onChange` line)
- Test: `cli/src/services/devices.spec.ts` (`describe('Herdr\'s agents, through Herdr Core …')`)

**Interfaces:**
- Consumes: `HcSource.terminalOf(pid)` (Task 7); `ObservedDeps.herdrTerminal`, `ObservedSource.placeHerdr()` (Task 8).
- `observedSource(dataDir, log, actions, tty, scanned, herdrTerminal: ObservedDeps['herdrTerminal'])` passes it into `ObservedDeps`.
- `startDevices` passes `hookIds ? (pid) => hcSource?.terminalOf(pid) : undefined` (Open question 1): a daemon that follows another hc session takes no hook's address, and `herdrApp.paneOf` gives no pane there, so a pairing would list the session twice on Herdr's page.
- `hcSource?.onChange(() => part.call('observed', () => observed!.placeHerdr()))`, registered before the hc source's `part.call('dial', outsideTurn)` line, so the dial's look after an hc change already sees the fold. No branch the coverage gate cannot reach.

- [ ] **Step 1: Write the tests**, with the scan's readers: `sess-1` known `terminal`, owner `{ engine: 'claude', pid: 4242 }`, row `{ cwd: '/work/api', transcriptPath: '/t/sess-1.jsonl' }`, `working` false.
  - `a session the scan found in an hc terminal is listed once, by its own copy, and takes words and a tap there`: `live([terminal('t7', { foregroundPid: 4242 })])`; `listed()` settles to `[{ id: ID, name: 'api', caps: 'svf' }]`; `sendTurn(ID, 'run the tests')` is `{ ok: true }` and `hc.prompted` is `[['t7', 'claude', 'run the tests']]`; `openAgent(ID)` runs `[openHerdr, switchTo('t7')]`; `logs` holds `'[observed] herdr · 1 paired'` and no line holds `t7` or `4242`.
  - `Herdr's list after the scan pairs it; a foreground that moves away takes it back`: `live([terminal('t7')])` (no pid): two rows, `ID` and Herdr's own; `changed({ foregroundPid: 4242 })`: one row, `ID`; `changed({ foregroundPid: 999 })`: two again.
  - `it.each` `with %j the devices pair a session the scan found: %s`: `{}` true, `{ HC_SESSION: 'other' }` false (two rows), as the hook test's table.
  - `detached, the pairing is taken back`: paired, then `seen.host.watching!(false)`; the observed copy no longer has Herdr's pane (`host` is `terminal` in its snapshot row) and takes no words through hc.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL in the new tests (two rows where one is wanted, no pairing line).
- [ ] **Step 3: Commit** `test(dial): the devices pair a session the scan found with its Herdr terminal (red)`.
- [ ] **Step 4: Implement** the Interfaces above. The comment at the lookup says why it is passed only with `hookIds`.
- [ ] **Step 5: Run** the step 2 command, then `cd cli && npm run typecheck && npx vitest run src/cable src/services/devicesListener.spec.ts src/architecture.spec.ts && npm run test:core`. Expected: PASS, `src/services/devices.ts` at 100% on every measure.
- [ ] **Step 6: Commit** `dial: the devices pair a session the scan found with its Herdr terminal`.

### Task 10: End to end: a Herdr session found by the scan

**Status:** to do. **Layer:** test: the real daemon, a private Herdr Core (`e2e/harness/hcCore.ts`), a fake dial. **Depends on:** 9 (and through it 6, 7, 8). **Effort:** `high`.

**Red test:** none. No production file changes. One commit.

**Files:**
- Modify: `cli/e2e/harness/hcCore.ts` (`AGENT`, `PrivateHc.agent`, the header comment)
- Modify: `cli/e2e/deviceHerdrApp.e2e.ts` (one new test; the header gains a line)

**Interfaces:**
- `PrivateHc.agent(folder: string, claude?: { projectsDir: string; sessionId: string; answer: string }): Promise<string>`. Without `claude`, as today (the four existing tests). With it, the agent, before it reports `idle`, writes what Claude Code leaves on disk, at paths it is given as arguments (hc's environment is built from nothing): its process record `<dirname(projectsDir)>/sessions/<its own pid>.json`, `{ pid, sessionId, cwd, procStart, status: 'idle' }` as `fakeEngine.mjs` `announceProcess` writes it (`procStart` from `/bin/ps -o lstart= -p <pid>`), and its transcript `<projectsDir>/<cwd with every non-alphanumeric as ->/<sessionId>.jsonl` with one turn: the user's line and the assistant's text `answer`, in the shapes `fakeEngine.mjs`'s `claude()` writes (`entrypoint: 'cli'`, `cwd`, `sessionId`, `parentUuid`, `uuid`, `timestamp`). Each written beside and renamed over.
- The header says why: on Diego's Mac each hc terminal's foreground pid is a live Claude Code record's pid (the addendum), and this is Claude Code as hc runs it, with no hook heard by the devices (none runs before a dial is plugged).

- [ ] **Step 1: Extend the harness** as above.
- [ ] **Step 2: Write the test** `a session started in a Herdr terminal before the dial is listed once, on Herdr's page, with its last answer, and takes words there`:
  - `fresh(planned)`; `hc = await coreFor(planned)`; `sessionId = randomUUID()`; `t = await hc.agent('api', { projectsDir: d.env.CLAUDE_PROJECTS_DIR!, sessionId, answer: 'answer 1: before the dial' })`; `id = observedAgentId('claude', sessionId)`.
  - The fact the pairing rests on, from the real hc: `(await hc.rpc('terminal.get', { terminal: t })).foreground.pid` equals the `pid` of the one record in the sessions folder.
  - `desk.plug('E2E-A', 'e2:e0:00:00:00:0a', FILTER)`; within 45 s a `summary` with `agentId === id`, `restore === true` and `text` containing `answer 1: before the dial`; no `turn.done` and no `summary` without `restore` for `id`.
  - The session counted once: the latest `apps` message counts `herdr` 1 and no other app; Herdr's ring (put in front through the watch as the swipe test does, if the ring does not settle on it alone) holds exactly one row with `host === 'herdr'`, and it is `{ id, name: 'api', caps: 'svf' }`.
  - `speak(dial, relay, id, 'run the paired words', 'paired-1')` is a `voice.transcript`; the terminal shows `GOT[run the paired words]`; `said(d, '[device] voice · herdr-app')`.
  - The log holds `[observed] herdr · 1 paired` and matches `/\[observed\] scan · 1 found · \d+ app known · 0 named · 1 answered · \d+ ms/`; it holds no `t` as a word (the existing regex), no `planned.root`, no `sessionId`, no `answer 1`, no `run the paired words`.
- [ ] **Step 3: Run** on this Mac (Herdr Core installed at `~/.local/bin/herdr-core`), `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceHerdrApp.e2e.ts`. Expected: PASS, all five tests, none skipped, and none of `hcCore.ts`'s safety checks refused.
- [ ] **Step 4: Commit** `test(e2e): a session found by the scan in a Herdr terminal is listed once, with its last answer`.

---

## Verification

**Platforms the pull request names:** macOS and Linux, run (unit specs on Linux in PR CI; e2e on this Mac, and the Linux e2e suite already run on GitHub at `ca2087458c`, item 3). The addendum (Tasks 6-10) runs on macOS only: the hc source exists only on `darwin`, and elsewhere `herdrTerminal` is absent and nothing is paired. Windows: the scan and the reader run there with no platform branch in this change; the by-hand Windows workflow (`windows.yml`) runs a fixed list of specs without these, so it is not run (as the session-name spec decided for the same code). The Claude app's records exist on macOS and Windows; Herdr.app is macOS only.

**Never touched by a tester or a test:** `~/.claude`, `~/.codex`, `~/.harness`, any real transcript or process record, Diego's daemon (port 18473) and tmux server, his dial, the Claude app, his Herdr.app and Herdr Core (the default hc session), Orca, any backend, production.

**Temporary workflow:** none. The long Linux check is the repo's own `cli-e2e.yml`, already run; the Herdr check needs Herdr Core, which no GitHub runner has, so it runs on this Mac.

**Local gates**, recorded in the pull request, on this Mac at the final head:
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit; paste its output. It selects `cli-core` now (`cli/src/services/devices.ts` changes, Task 9): `npm run test:core` passes with every file at 100%.
- `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts src/services/devicesListener.spec.ts src/architecture.spec.ts`.
- `git diff --stat origin/main -- cli/src/core cli/src/architecture.coreFiles.txt cli/src/cable/hosts/lastAnswer.ts cli/src/cable/hosts/herdrApp.ts cli/src/cable/hosts/hostDetect.ts cli/src/cable/hosts/registry.ts cli/src/cable/cableHost.ts cli/src/cable/cableSession.ts cli/src/testing/fakeHc.ts` prints nothing.
- Not needed: `test:harnessd`, the serial and PTY specs (no path of theirs changes).

**1. The restored recap, the Claude app name and the scan's paths, end to end (tester, this Mac)**
- Run at the final head: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceWithoutApp.e2e.ts e2e/dialAppFilter.e2e.ts e2e/dialAppFilterOnDial.e2e.ts e2e/devicesProcess.e2e.ts e2e/dialTerminalFollow.e2e.ts e2e/deviceNotify.e2e.ts e2e/deviceCodex.e2e.ts e2e/deviceClaudeOrca.e2e.ts e2e/dialClaudeAppFollow.e2e.ts`. Rerun because Task 8 changes the scan's loop that every one of them goes through. `E2E_BUNDLE=1` builds the daemon that ships; `TMPDIR=/tmp` keeps socket paths under the limit. A few minutes.
- Isolation, the suite's own (`cli/e2e/harness/daemon.ts`, cli/AGENTS.md rules 5 and 6): a throwaway home, data folder, Claude and Codex homes, a private port and tmux server, fake engines, a fake dial on a pseudo-terminal (`HARNESSD_TEST_DIAL_PORT`); no backend, no account, no secret.
- A person sees: every test passes, none skipped; in `deviceWithoutApp.e2e.ts`, a `summary` with `restore: true` carrying `answer 1: before the dial` and no `turn.done`; the log's scan line with `1 answered` and no answer text.

**2. Herdr's agents, end to end, with a private Herdr Core (tester, this Mac)**
- Run at the final head: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceHerdrApp.e2e.ts`. All five tests: the four existing ones (Tasks 6 and 7 change what the hc client and source keep and tell) and Task 10's.
- Needs Herdr Core installed for the account that runs the tests (`~/.local/bin/herdr-core`, present on this Mac); the file is skipped without it, so a skip is a failure of this check, not a pass.
- Isolation, `e2e/harness/hcCore.ts`'s own: a private core in session `harness-<random>`, its HOME and every `XDG_*` under a fresh `/tmp/hh-<random>` root, its socket there (`HC_SOCKET` for the daemon, which inherits no `HC_*` or `XDG_*`), every run of hc in an environment built from nothing; before and after each start and stop it checks that launchd holds no `dev.herdr.core.*` job and that the person's own Herdr (their cores, holders, Herdr.app and its connections) are the same processes. The daemon's `herdr-app` and `open` are fakes that record their arguments. The fake dial and fake backend as in item 1.
- A person sees: five passes, none skipped, no safety check refused; in Task 10's test, one row on Herdr's page with the observed id, a `summary` with `restore: true` carrying `answer 1: before the dial`, the words typed in the private terminal, and the log's `[observed] herdr · 1 paired` with no address, folder, session id or words.

**3. The whole e2e suite on GitHub: not run again.** It ran by hand at `ca2087458c` (Actions → CLI end to end, `.github/workflows/cli-e2e.yml`, eight Linux shards). What changed since does not change a Linux run: the hc source is macOS only, so on Linux the lookup is absent and `pair` and `placeHerdr` change nothing; `deviceHerdrApp.e2e.ts` is skipped on every runner (no Herdr Core); `fakeEngine.mjs` is unchanged. PR CI's unit specs (item 4) cover the new code on Linux. Its link stays in the pull request. Later pull requests: the nightly run has these files; no workflow change, no proposal.

**4. In PR CI, by itself:** `cli-typecheck` and `cli-tests` run `observed.spec.ts`, `recordName.spec.ts`, `hcClient.spec.ts`, `hcSource.spec.ts` and `devices.spec.ts` on Linux.

**5. Numbers:** the scan's line (`answered`, `ms` over every read) and the new `[observed] herdr · <n> paired`. No new read and no timer: the pid rides hc's existing events; each hc change costs one lookup per unhooked entry (at most 50) over at most 1,024 terminals. No hot path gains work.

**6. Diego's own check, on his Mac and his dial (the owner's, not a tester's).** Needs his login, his Claude app, Herdr.app and Orca sessions, his dial and his eye; the PM asks him once the pull request is ready. With the build from the pull request's head installed (`make install-cli` in that checkout) and the daemon restarted, before any prompt: the dial shows each idle session's recap, the Claude app's sessions by their titles, and each Herdr.app session once, on Herdr's page, with its recap; a word spoken to a Herdr.app session reaches its terminal. The log shows `[observed] herdr · <n> paired` with `<n>` his live Herdr sessions.

**7. Against production:** none.

## Open questions

1. **A daemon that follows another hc session (`HC_SESSION` or `HC_SOCKET` set, `hookIds` false).** There `herdrApp.paneOf` gives no pane, so a pairing would set app `herdr` with no pane to fold Herdr's row, and the session would be listed twice on Herdr's page. Task 9 passes the lookup only with `hookIds`, so nothing is paired there (as today). Recommendation: as planned. The other answer, pairing there too, needs `paneOf` to take an hc-given address while refusing a hook's, a change to `herdrApp.ts` the addendum does not ask for.
2. **What `<n>` counts in `[observed] herdr · <n> paired`, and whether a take-back is logged.** The plan logs, per scan look or `placeHerdr()` call, the entries it paired or moved (when at least one), and nothing for a take-back, as decision 7 names one line. Recommendation: as planned. The other answer is a second count, `· <m> taken back`, if a take-back should be seen in the log.
3. (Carried from the first plan, not blocking.) **When Claude Code writes `status: 'idle'` relative to its Stop hooks.** Task 4 landed with the fake writing it after the Stop hooks ran. No recorded Claude Code record was checked in this branch; correct the fake if one shows otherwise.
