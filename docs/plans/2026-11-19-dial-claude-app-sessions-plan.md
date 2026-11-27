# The Claude app's Code sessions on the dial, with or without a process — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(dial): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. No task pushes or merges.

**Goal:** On macOS, with a dial attached, every Code session of the Claude app that is not archived is a row on the dial's Claude page, newest first, at most 16: the hooked copy with its real state while its process runs, an idle row a tap opens while none does, one row and one id either way.

**Architecture:**
- **A store reader** (`cli/src/cable/hosts/claudeAppStore.ts`, new) reads the app's own files, `claude-code-sessions/<account>/<org>/local_<uuid>.json`: six fields of each, bounded, never written. It holds each file's size and mtime and parses only new or changed files.
- **A listing source** (`cable/hosts/claudeAppSource.ts`, new, id `claude-app`) turns each session into an idle `HostAgent` with the id the observed source gives the same session. Pushed by non-recursive folder watches, one pass at a time, never polled.
- **One row per session.** The Claude app's adapter gains `paneKey`, so the registry folds the hooked copy and the store's copy by session id or by the app's own id. `HostAgent.ended`: an ended hooked copy gives its row to another source's live copy. `HostAgent.resting`: a store row weighs nothing in the dial's default app, and counts for the app in front wherever the dial asks whether that app has agents to show (`AppCounts.inFront`).
- Devices process only: `cli/src/cable/hosts/`, `cli/src/cable/cableHost.ts` and `cli/src/services/devices.ts`. Nothing in `cli/src/core`, nothing stored, no firmware change (the rows are ordinary `HostAgent`s).

**Tech Stack:** TypeScript daemon (Node, vitest), `cli/`. No new dependency.

**Spec:** `docs/plans/2026-11-19-dial-claude-app-sessions-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` (Protect the core, rule 7) and `cli/src/services/AGENTS.md`.

**Open questions:** none. The PM answered the draft's three on 2026-11-19 (decisions 9 to 11 below).

## Base

- Branch `fix/dial-claude-app-idle-sessions` at `6dcb285e7d` (`origin/main` when this was written), worktree `/Users/duynguyen/orca/workspaces/autonomous-harness/dial-claudeapp-sessions`. Nothing else has to merge first.
- **Before the first task, once:** `cd cli && npm ci --no-audit --no-fund` (this worktree's `cli/` has no `node_modules`). One process runs it, never two tasks at once.
- Names at the base (the tasks name functions, never lines):
  - `types.ts`: `HostAgent` (`appPending`, `paneKeys`), `HostSource`, `Caps`, `PaneSwitch`. `registry.ts`: `HostRegistry.entries`, `outside`, `strength`. `registry.spec.ts`: `agent`, `fakeSource`, `ids`.
  - `observed.ts`: `ObservedSource.list`, `live`, `observedAgentId`, `folderName`, `END_DELAY_MS`. `observed.spec.ts`: `setup`, `ev`.
  - `select.ts`: `AppRings.counts`, `pageOf`. `select.spec.ts`: `agent`, `row`, `at`, `ringIds`, `describe('counts, of the agents given')`.
  - `appFilter.ts`: `AppCounts` (`all`, `known`), `AppFilter.shown` (its front rule), `givesWay`, `fallback`. `appFilter.spec.ts`: `setup` (its `agents(next, knownNext?)`), `settle`, `causes`, `describe('agents not known yet')`.
  - `cableHost.ts`: `DaemonCableHost.counts`, `viewOnTab`, `viewOnRing`, `setSwarms`, the file's `has`. `cableHost.spec.ts`: `describe('the view while a window is open')` and its `viewed`, `settle`, `onTab`, `onGhosttyRing`, `sessions`; the describe's `agent(id, app, over)` and `five()`.
  - `claudeApp.ts`: `createClaudeAppAdapter`, `CLAUDE_SESSION` (not exported). `claudeApp.spec.ts`: `recorder`, `pane`, `SESSION`.
  - `adapter.ts`: `HostAdapter.paneKey`, `Pane`. `appLink.ts`: `createAppLink`. `folderWatch.ts`: `watchNearest`. `observedTitle.ts`: `observedTitle`. `hostDetect.ts`: `APP_BUNDLES.claude` (`com.anthropic.claudefordesktop`). `vscode.ts`: `VSCODE_SESSION` (not exported: the form of a Claude Code session id). `herdrSource.ts`: `MAX_CWD` (4,096). `cmuxSource.ts`: the model for the source (`GAP_MS`, `look`, `forget`, `timed`, `counted`).
  - `services/devices.ts`: `DevicesDeps` (`cmux`), `apps`, `openBin`, `claude`, `noting`, `noteMove`, `noteLink`, `cmuxAppNoted`, `adapters`, `opener`, `timerIn`, `cmuxSource`, `registry`, `outsideTurn`, `dialAttached`, `claudeAttached`, `claudeSettled`.
  - `devices.spec.ts`: `start`, `orca`, `orcaRuns`, `logs`, `seen`, `watchedFolders` (the `folderWatch.js` mock), `fakeListener`, and the cmux describe's `onMac`, `attach`, `listed`, `flush`, `withCmux` (shapes to copy); the Claude app follow describe's `hook`, `continued`, `rest`, `backInFront`, `FRONT_SETTLE_MS`.
  - `cli/e2e`: `IsolatedDaemon` (`opens`, `log`, `env`, `root`), `Desk`, `until`, and `deviceCmux.e2e.ts`'s `rosters`, `showing`, `said`, `FILTER`; `harness/outsideAgent.ts`'s `Outside` (`start(d, folder, hints)`, `sessionId`, `id`, `pid`, `type`, `close`: the suite's fake Claude Code, which runs its `SessionEnd` hook and exits on `!exit`), and `deviceWithoutApp.e2e.ts`'s `heard` and its prompt's `turn.started`/`turn.done` wait. `cli/scripts/benchmark-dial-tab-read.ts`: the shape of a measuring script.
- If a name differs at the base, the implementer follows the code and says so in its report.
- The spec and this plan are untracked. The main session commits them; no task does.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 `HostAgent` says `ended` and `resting` | `cli/src/cable/hosts/types.ts` | none | medium | none: types and comments only, one commit |
| 2 An ended copy gives its row to a live copy | `cli/src/cable/hosts/registry.ts`, `registry.spec.ts`, `observed.ts` (`list()` only), `observed.spec.ts` | 1 | high | `registry.spec.ts`, `observed.spec.ts` |
| 3 A resting row weighs nothing in the default, and counts for the app in front | `cli/src/cable/hosts/select.ts`, `select.spec.ts`, `cli/src/cable/hosts/appFilter.ts`, `appFilter.spec.ts`, `cli/src/cable/cableHost.ts`, `cli/src/cable/cableHost.spec.ts` | 1 | high | `select.spec.ts`, `appFilter.spec.ts` (`cableHost.spec.ts` guards) |
| 4 The Claude app's adapter names its pane key | `cli/src/cable/hosts/claudeApp.ts`, `claudeApp.spec.ts` | none | medium | `claudeApp.spec.ts` |
| 5 The store reader | `cli/src/cable/hosts/claudeAppStore.ts` (new), `claudeAppStore.spec.ts` (new), `cli/src/testing/claudeAppFixture.ts` (new) | 4 | xhigh | `claudeAppStore.spec.ts` |
| 6 The source | `cli/src/cable/hosts/claudeAppSource.ts` (new), `claudeAppSource.spec.ts` (new) | 1, 4, 5 | xhigh | `claudeAppSource.spec.ts` |
| 7 The devices run the source | `cli/src/services/devices.ts`, `devices.spec.ts` | 2, 3, 4, 6 | high | `devices.spec.ts` |
| 8 End to end, a fixture store and a fake process | `cli/e2e/deviceClaudeAppSessions.e2e.ts` (new) | 7 | high | none: no behavior (the end-to-end tests of Tasks 1 to 7), one commit |
| 9 The read's measure | `cli/scripts/benchmark-claude-app-store.ts` (new) | 5 | medium | none: no behavior (a measuring script), one commit |
| 10 Say it in the docs | `cli/AGENTS.md`, `docs/specs/2026-11-15-device-host-adapter.md` | none | medium | none: docs only, one commit |

Longest chain: 4 → 5 → 6 → 7 → 8, five tasks.

- Tasks 1, 4 and 10 share no file and start at once. After Task 1: Tasks 2 and 3. After Task 5: Tasks 6 and 9 beside each other.
- No two tasks share a file. `types.ts` is Task 1's alone so that Tasks 2, 3 and 6 run beside each other. `appFilter.ts`, `cableHost.ts` and their specs are Task 3's alone: Task 7 touches only `devices.ts` and `devices.spec.ts`, and no other task edits a file under `cli/src/cable/` outside `hosts/`.
- A dependency is an import or a behavior: Task 5 imports `CLAUDE_SESSION` (Task 4); Task 6 imports the store's types (5), `claudePaneKey` (4) and sets `resting` (1); Task 7's tests need the fold, the default and the app in front's count, and the pane key (2, 3, 4).
- Tasks 2 and 3 run beside each other: Task 2's last run reads `src/cable` specs, Task 3's `cableHost.spec.ts` among them; a failure there in the other's file is reported, not edited.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/hosts/*.ts`, `cli/src/cable/cableHost.ts` | **Devices service process**, and only there (`cableHost.ts` is loaded by `services/devices.ts` and `devicesProcess.ts`; `core/api.ts` imports one type of it, which does not change) | their specs (PR CI `cli-tests`, Linux) |
| `cli/src/services/devices.ts` | **Devices service process** | 100% per file (`npm run test:core`, local) |
| `cli/src/testing/claudeAppFixture.ts` | Test: a fixture store in a folder the caller names | none |
| `cli/e2e/deviceClaudeAppSessions.e2e.ts` | Test: the real daemon, a fake dial, a fixture store, the suite's fake Claude Code, the fake `open` | Verification 1, locally on this Mac |
| `cli/scripts/benchmark-claude-app-store.ts` | A script, no process of the daemon | Verification 3 |
| The docs of Task 10 | Repo files, no process | review |

Not changed, and a diff in any is a finding: anything under `cli/src/core/`, `cli/src/architecture.coreFiles.txt`, `cli/vitest.setup.ts`, `cli/hook/`, `cli/e2e/harness/`; `cable/hosts/appLink.ts`, `open.ts`, `adapter.ts`, `folderWatch.ts`, `observedTitle.ts`, `record.ts`, `cmuxSource.ts`, `opencodeSource.ts`, `herdrSource.ts`, `hcSource.ts`; in `appFilter.ts` and `cableHost.ts`, anything but the reads Task 3 names (the type `RecentTurn` that `core/api.ts` imports above all); `cli/e2e/harness/outsideAgent.ts`, `fakeEngine.mjs`; the order of `adapters` in `devices.ts`; any firmware file.

## Global Constraints

- **Never the person's own.** No test, script or check reads, lists, stats or writes `~/Library/Application Support/Claude` or `~/.claude`, starts or signals the real Claude app, or runs `/usr/bin/open`. Unit tests use a fixture store in a temp folder (`mkdtemp`); `devices.spec.ts` runs under the suite's throwaway home (`cli/vitest.setup.ts`) with a recording runner; the e2e uses the daemon's throwaway `HOME` and the fake `open` (`HARNESS_OPEN_BIN`), both checked to be inside the daemon's root before it starts. Its session with a process is the suite's fake Claude Code (`Outside`), given the Claude app's hints in its own environment only, never the daemon's.
- **The store is never written.** No file of it is created, changed, renamed or removed by anything but a test's own fixture.
- **Fields.** Of a parsed file, only `sessionId`, `cliSessionId`, `cwd`, `isArchived`, `lastActivityAt` and `title` are read; nothing else of the object is kept, read or logged. No message or prompt is read.
- **Names opened.** In an org folder only names matching `^local_[A-Za-z0-9-]{1,64}\.json$`. `deleted_*`, `archived-sessions.idx`, `scheduled-tasks.json` and `waiting-input/` are never opened.
- **Bounds:** 8 account folders, 8 org folders each, 1,024 file names a folder, 1 MiB a file, a `cwd` of at most 4,096 characters, 16 sessions listed, 256 parses a read. Only real folders and regular files, never a link.
- **Which sessions:** every one not archived, newest first, at most 16, no time window (decision 1). Every account folder (decision 3).
- **The row:** id `observedAgentId('claude', cliSessionId)`; `engine` `claude`; pane key `claude-app:<local id>`; `host` and `app` `claude`; `state` `idle`, `unseenDone` false, no `lastAnswer`; `resting: true`; name `observedTitle(title) ?? (basename(cwd) || 'claude')`.
- **A store row can:** status and a tap, a rest while the Claude app is in front. No voice, no `send`, no answer (decision 4).
- **The link is unchanged:** `open -b com.anthropic.claudefordesktop claude://code/continue?session=<local_…>`, the local id checked against `CLAUDE_SESSION` (`/^local_[A-Za-z0-9-]{1,64}$/`) when read and again by the adapter before each link.
- **Pushed, never polled.** No timer but the 250 ms between two passes. One pass at a time; changes during a pass give one more, at least 250 ms after its start.
- **Log lines**, fixed words and counts only, never a title, folder, path or id: `[claude-app] watch · on`, `[claude-app] watch · none`, `[claude-app] listed · <n> sessions`, `[claude-app] read · <ms> ms · <parsed> parsed · <skipped> skipped`, `[claude-app] over · <n>`. Every line of the source matches `/^\[claude-app\] (watch · (on|none)|listed · \d+ sessions|read · \d+ ms · \d+ parsed · \d+ skipped|over · \d+)$/`.
- **Failures stay quiet.** No promise of the reader or the source rejects; nothing throws into the devices process; each skip and cut is a count.
- **Where it runs.** macOS only, behind `HARNESS_DEVICE_OBSERVED`, while a dial is attached: started at each attach, stopped at the last detach, everything held dropped then.
- **Rule 7.** No file under `cli/src/core` changes.
- **Repo rules.** Test first, at the layer where the behavior lives. No fixed sleeps. Every list bounded. Comments say why. `src/services` stays at 100% per file.

## Review Focus

1. **The person resumes one of the app's sessions in a terminal** (`claude --resume`), its store file still there. One row, the live copy's, on the terminal's page; when it ends, the store's row is back on the Claude page under the same id. Task 7, `a store session hooked from Ghostty is one row on Ghostty's page, and the store's again once it ended`.
2. **The app rewrites hundreds of session files at once** (its start, an update). The names waiting for a pass stay bounded: past 256 they become one listing of the folders, never a pile. Task 6, `more than 256 names waiting become one listing`.
3. **A file swapped for a link, or grown past 1 MiB, between its stat and its read.** It is skipped and counted; a link is never followed and no more than 1 MiB + 1 byte is read. Task 5, the two `between its stat and its read` tests.
4. **A file that says less than expected:** a `cwd` of `/`, a title the title rule refuses (blank, a control character), JSON that is no object (`null`, `[]`, `42`). The first two still give a named row (`claude`, the folder's name); the last is skipped and counted. Task 5 (`JSON that is no object`), Task 6 (`a row always has a name`).
5. **The dial unplugged while a read is under way, and plugged in again at once.** The first read's answer is dropped: no stale row, no row twice, the `watch` line not said again. Task 6, `a pass that lands after a stop lists nothing, and the next start reads afresh`.

## Decided (the PM, 2026-11-19)

The spec's "Decisions" holds each: (1) every session not archived, newest `lastActivityAt` first, at most 16, no time window; (2) the name is the store's `title` through `observedTitle`, else `basename(cwd)`; (3) every account folder; (4) a session with no process is idle, with no voice; (5) the approach and the end-to-end check; (6) `HostAgent.ended`, for every listing source, with tests that herdr's, cmux's and opencode's rows merge as before; (7) `HostAgent.resting`, left out of the known counts in `select.ts`; (8) a session whose store and hook ids still differ when its process ends moves the dial's pick to the store row's id: accepted, not handled.

The draft's three open questions, answered (the spec's decisions 9 to 11 and its "dial's default page" bullet):

9. **A resting row counts for the app in front (1b).** Wherever the dial asks whether the app in front has agents to show, a resting row counts: `AppCounts` gains `inFront`, read by `AppFilter.shown()`'s front rule and by `cableHost.ts`'s `viewOnTab` and `viewOnRing`. It weighs nothing only in the default app: `known`, which `fallback` and `givesWay` read, leaves it out. So with the Claude app settled in front before the dial attaches, no Code process, and another app holding a known agent, the dial shows the Claude page whichever comes first, the store's first read or the dial's first list. Task 3 (now `high`) holds it at the filter's layer, Task 7 through the devices.
10. **The end-to-end file also runs a session with a process.** A second test in Task 8: the suite's fake Claude Code with the Claude app's hints (`__CFBundleIdentifier` `com.anthropic.claudefordesktop`, `CLAUDE_CODE_HOST_SESSION_ID`) and a fixture file naming its session: one row while it runs, with its real state; the same agent id listed idle once it ends; a tap then runs the fake `open` with `-b com.anthropic.claudefordesktop` and the `claude://code/continue` link. Never the real Claude app, `~/.claude`, `~/Library/Application Support/Claude` or `/usr/bin/open`.
11. **Verification check 2 stays:** one hand-started `cli-e2e.yml` run in phase 4 (the tester asks the main session, which asks the PM for the turn first), and `deviceCmux.e2e.ts` on this Mac.

## Decided here, where the spec was silent

- **The forms live in `claudeApp.ts`**, where `CLAUDE_SESSION` is today: it is exported, with `claudePaneKey(localId)`. The reader builds its file-name check from it, so there is one form.
- **The reader has five calls:** `folders()`, `files()`, `touch()`, `read()`, `forget()`. The source sets its watches between `folders()` and `files()`, so a file written while the folders are listed is still heard (`cmuxSource.start`'s rule).
- **A fixture helper** (`cli/src/testing/claudeAppFixture.ts`, as `fakeCmux.ts`) writes the store the tests read: Tasks 5, 7, 8 and 9 use it.
- **`cliSessionId`'s form** is a lower-case UUID, Claude Code's own, as `vscode.ts` checks one (`VSCODE_SESSION`, which it does not export): a constant of the reader's own, so `vscode.ts` is not touched.
- **The checks' order** in a parsed file: an object; `sessionId` equal to the file's name; `isArchived` a boolean when present; archived dropped there, whatever its other fields; then `cliSessionId` and `cwd`. A `lastActivityAt` that is no finite number is the mtime and a `title` that is no string is none: neither skips the file.
- **The root itself** must be a real folder too. Past a bound, folders and names are taken in name order.
- **The walk's order** is fixed at its start: each held file by its sort time, a file not parsed at its present size and mtime by its mtime; ties by name. The stop reads the next file's place in that order against the 16th newest sort time counted: for a file still to parse that is its mtime, as the spec says; for one parsed and unchanged it is its sort time, never newer than its mtime, so nothing newer is left out.
- **A file is opened without following a link** (`O_NOFOLLOW`), its handle's own stat checked, and at most 1 MiB + 1 byte read (`record.ts`'s rule): Review Focus 3.
- **`parsed`** counts the files a read opened. **`skipped`** counts, of the files the walk reached, those that give no session and are not archived (unusable now, or held as unusable at the same size and mtime) and the older file of two with one `cliSessionId`. **`over`** counts the folders past 8 and 8, the names past 1,024, and the held files a walk cut at 256 did not reach.
- **`over` is said** when its number changes and is above zero; `listed` is said again after a detach; whether the root is there is kept across a detach, so a dial plugged in again says no `watch` line (all three as `cmuxSource`).
- **`read`'s `<ms>`** is the pass, from its start to its read's end, rounded.
- **While the root is not there**, an event naming another entry of the app's folder does nothing: only the root's own name, or no name, looks again.
- **Names waiting for a pass** are at most 256; more become one listing (Review Focus 2).
- **`DevicesDeps.claudeAppStore`** is a seam for `devices.spec.ts`, as `cmux` is: a fake reader the test answers, so no test waits on real file reads under fake timers. One test runs the real reader on a fixture under the suite's throwaway home.
- **`claudeNoted`** takes the Claude adapter's place in `adapters`; the order does not change. The source is last in the registry.
- **With no ended copy, `entries()` is today's one pass**, each list read once: the dial reads it every second.
- **"Merge as before"** is tested both ways for herdr, cmux and opencode: a live hooked copy still folds the listed one, and an ended hooked copy the source holds no copy of is still listed.
- **`claudeAppStore.spec.ts` is skipped on Windows** (its link tests need symlinks; the store is the macOS app's). It runs on Linux in PR CI.
- **The measure is a script** in `cli/scripts`, as `benchmark-dial-tab-read.ts` is. "Before" is nothing: at the base none of this runs.
- **The e2e asserts no time.** It prints the time from a fixture write to the source's `listed` line and to the dial's list, and the tester reports the first against the spec's second: the dial takes a changed list at its own next list, as every source's rows do.
- **The docs** (Task 10): `cli/AGENTS.md`'s devices row names every read of the devices process, so the store joins it, as cmux's did.
- **`AppCounts.inFront`** (decision 9) holds, by page, the agents that are not `appPending`: the known ones and the resting ones. A third map rather than a flag, so `known` stays the one map the default reads (`fallback`, `givesWay`) and `all` the one a pick, a hold, a settle and a window's opening read, as today.
- **The e2e's session with a process** (decision 10): the fake Claude Code picks its own session id, so its store file is written after its `SessionStart` hook is heard, naming that id and a fixed local id that is also its `CLAUDE_CODE_HOST_SESSION_ID`. Its real state is a prompt's `turn.started` and `turn.done` (a store row has no turn); its end is `!exit`, which runs its `SessionEnd` hook as Claude Code does.

---

### Task 1: `HostAgent` says `ended` and `resting`

**Layer:** devices service process. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: two optional fields and comments, no behavior. One commit.

**Files:**
- Modify: `cli/src/cable/hosts/types.ts`

**Interfaces:**
- Produces on `HostAgent`:
  - `ended?: true`: its session ended and its source still lists it (the observed source's, until its tick drops it): no tap, rest or voice. The registry gives its row to another source's live copy (`registry.ts`).
  - `resting?: true`: no process runs it: a row of the Claude app's store (`claudeAppSource.ts`). It is on its app's page and counts for nothing in the dial's default app (`select.ts`'s `known`), as `appPending`; it still counts for the app in front (`AppCounts.inFront`).
- The `paneKeys` comment gains the Claude app's session, `claude-app:<local id>`; `HostSource.id`'s comment names `cmux` and `claude-app` among the listing sources.

- [ ] **Step 1: Add the two fields and the comments.**
- [ ] **Step 2: Run** `cd cli && npm run typecheck`. Expected: no error.
- [ ] **Step 3: Commit** `dial: an agent can be ended, or resting with no process`.

### Task 2: An ended copy gives its row to a live copy

**Layer:** devices service process. **Depends on:** 1. **Effort:** `high` (every listing source's merge; the list the dial reads each second).

**Red tests:** `cli/src/cable/hosts/registry.spec.ts`, `cli/src/cable/hosts/observed.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/registry.ts`
- Test: `cli/src/cable/hosts/registry.spec.ts`
- Modify: `cli/src/cable/hosts/observed.ts` (`ObservedSource.list()` only)
- Test: `cli/src/cable/hosts/observed.spec.ts`

**Interfaces:**
- Consumes: `HostAgent.ended` (Task 1).
- Produces in `observed.ts`: `list()` gives `ended: true` to an entry that is not `live()`, and no `ended` key to a live one. Nothing else changes: an ended entry still has no pane keys.
- Produces in `registry.ts`, `HostRegistry.entries()`:
  - Each source's list is read once a call, in the sources' order.
  - A copy that is not ended folds and takes its keys exactly as today.
  - An ended copy takes no key, so it folds no later copy. It is listed unless it is folded as today (a stronger source's keys), or another source lists a copy that is not ended with its session key (`engine` + `sessionId`) or one of its pane keys; that copy is then listed, at its own source's turn.
  - The live copies' keys are gathered only when some list holds an ended copy: with none, the call is today's one pass.
  - The file's top comment says why: an ended hook copy has no tap, rest or voice, and must never hide a copy that can open the session.

Helpers for `registry.spec.ts`: `ended = (over: Partial<HostAgent>) => agent({ ...over, ended: true })`; `counting(id, agents)`, a `fakeSource` whose `list` counts its calls.

- [ ] **Step 1: Write the tests in `registry.spec.ts`,** in `describe('an ended copy (docs/plans/2026-11-19-dial-claude-app-sessions-design.md)')`:
  - `an observed copy and a store copy of one session are one row, the observed's, by its session id`: `observed` `[agent({ id: 'o', sessionId: 's' })]`, `claude-app` `[agent({ id: 'o', sessionId: 's', resting: true })]`: `entries()` equals `[{ agent: <the observed one>, source: observed }]`, in either constructor order.
  - `… and by the pane key alone`: `observed` `[agent({ id: 'o', sessionId: 'new', paneKeys: ['claude-app:local_a'] })]`, `claude-app` `[agent({ id: 'c', sessionId: 'old', paneKeys: ['claude-app:local_a'] })]`: `ids` is `['o']`.
  - `an ended observed copy gives its row to the store's live copy`: `observed` `[ended({ id: 'o', sessionId: 's' })]`, `claude-app` `[agent({ id: 'o', sessionId: 's', resting: true })]`: `entries()` equals `[{ agent: <the store's>, source: <the store> }]`.
  - `… and to herdr's, by the session id or by a pane key`: `observed` `[ended({ id: 'o', sessionId: 's' })]`, `herdr` `[agent({ id: 'x', sessionId: 's' })]`: `ids` `['x']`; and `observed` `[ended({ id: 'o', sessionId: 's', paneKeys: ['herdr:w1:p1'] })]`, `herdr` `[agent({ id: 'x', paneKeys: ['herdr:w1:p1'] })]`: `ids` `['x']`.
  - `an ended copy no other source lists is listed alone`: `observed` `[ended({ id: 'o', sessionId: 's' })]`, `herdr` `[agent({ id: 'x', sessionId: 't' })]`: `ids` `['o', 'x']`.
  - `an ended copy takes no key: the live copy that took its row still folds the next source's`: `observed` `[ended({ id: 'o', sessionId: 's' })]`, `cmux` `[agent({ id: 'x', sessionId: 's' })]`, `opencode` `[agent({ id: 'y', sessionId: 's' })]`: `ids` `['x']`.
  - `a Harness agent's session still takes an ended copy's row`: `harness` `[agent({ id: 'h', sessionId: 's' })]`, `observed` `[ended({ id: 'o', sessionId: 's' })]`: `ids` `['h']`.
  - `it.each` over `['herdr', { paneKeys: ['herdr:w1:p1'] }]`, `['cmux', { sessionId: 's', paneKeys: ['cmux:s1'] }]`, `['opencode', { engine: 'opencode', sessionId: 's' }]`, `%s's rows merge as before`: a live observed copy with the same keys and that source's copy `x`: `ids` `['o']`; then the observed list is `[<that live copy>, ended({ id: 'e', sessionId: 'gone' })]`: `ids` `['o', 'e']`.
  - `each list is read once a call, with an ended copy or none`: three `counting` sources; after one `entries()` each count is 1, with no ended copy and with one.
- [ ] **Step 2: Write the test in `observed.spec.ts`,** in `describe('ObservedSource removal')`: `list() says an ended session is ended, and a live or resumed one is not`: after `session-start`, `src.list()[0]` has no `ended` key (`not.toHaveProperty('ended')`); after `session-end`, `ended` is `true`; after a second `session-start`, no `ended` key.
- [ ] **Step 3: Run** `cd cli && npx vitest run src/cable/hosts/registry.spec.ts src/cable/hosts/observed.spec.ts`. Expected: FAIL in `gives its row to the store's live copy`, `… and to herdr's`, `takes no key` (today the ended copy keeps the row) and the `observed.spec.ts` test (no `ended`). The two `one row` tests, `listed alone`, `Harness`, `merge as before` and `read once` hold today's behavior and pass: they guard the change.
- [ ] **Step 4: Commit** `test(dial): an ended copy gives its row to another source's live copy (red)`.
- [ ] **Step 5: Implement** `list()` and `entries()` (Interfaces above).
- [ ] **Step 6: Run** `cd cli && npx vitest run src/cable src/services/devices.spec.ts && npm run typecheck`. Expected: PASS. An expectation of an ended entry in `observed.spec.ts` that now differs only by `ended: true` is updated here; a failure in `devices.spec.ts` is reported, not edited (Task 7's file).
- [ ] **Step 7: Commit** `dial: an ended copy gives its row to another source's live copy`.

### Task 3: A resting row weighs nothing in the default, and counts for the app in front

**Layer:** devices service process. **Depends on:** 1. **Effort:** `high` (the dial's page rule, read in three files; decision 9).

**Red tests:** `cli/src/cable/hosts/select.spec.ts`, `cli/src/cable/hosts/appFilter.spec.ts`. `cli/src/cable/cableHost.spec.ts`'s two tests hold today's behavior and guard the change.

**Files:**
- Modify: `cli/src/cable/hosts/select.ts` (`AppRings.counts` and its comment)
- Test: `cli/src/cable/hosts/select.spec.ts`
- Modify: `cli/src/cable/hosts/appFilter.ts` (`AppCounts`, `AppFilter.shown()`'s front rule, the class comment)
- Test: `cli/src/cable/hosts/appFilter.spec.ts`
- Modify: `cli/src/cable/cableHost.ts` (`viewOnTab`, `viewOnRing` and their comments)
- Test: `cli/src/cable/cableHost.spec.ts`

**Interfaces:**
- Consumes: `HostAgent.resting` (Task 1).
- Produces in `appFilter.ts`: `AppCounts` gains `inFront: ReadonlyMap<string, number>`: by page, the agents that are not `appPending`, the resting ones included; an app with none is absent. Its comment says why: a resting row weighs nothing in the default (`known`) yet the app in front shows its page (the spec's "dial's default page", PM 2026-11-19, 1b).
  - `AppFilter.shown()`'s front rule reads `has(inFront, front)` where it reads `has(known, front)` today. `fallback` and `givesWay` keep `known`; `pick`, `hold` and `settle` keep `all`. The class comment's "the app in front is shown whenever it has known agents" names resting ones too.
- Produces in `select.ts`: `AppRings.counts(agents)` returns `{ all, known, inFront }`: `known` leaves out an agent that is `appPending` or `resting`; `inFront` leaves out only an `appPending` one; `all` keeps every one. `update`, `apps` and `ring` are unchanged: a resting agent is on its app's page and in its ring.
- Produces in `cableHost.ts`: `viewOnTab` reads `this.rings.counts(listed).inFront` and `viewOnRing` reads `this.counts().inFront` where each reads `known` today. `setSwarms` and `viewOnSettle` keep `all`. Both reads change together: one reading `known` and the other `inFront` would turn a window's view back and forth.

Helpers: in `select.spec.ts`, `resting = (id: string) => agent(id, { app: 'claude', host: 'claude', resting: true })`. In `appFilter.spec.ts`, `setup`'s `agents(next, knownNext?, inFrontNext?)`, the filter's `inFront` being `inFrontNext ?? knownNext ?? next`, so every existing test reads as today. In `cableHost.spec.ts`, the describe's `agent(id, 'claude', { resting: true })`.

- [ ] **Step 1: Write the tests in `select.spec.ts`,** in `describe('counts, of the agents given')`:
  - `known leaves out a resting agent; all and inFront keep it`: `counts([resting('c1'), resting('c2'), at('ghostty')(agent('g'))])`: `[...all]` and `[...inFront]` equal `[['claude', 2], ['ghostty', 1]]`, `[...known]` equals `[['ghostty', 1]]`.
  - `an app whose agents all rest is absent from known, and in inFront`: `counts([resting('c1')])`: `known.size` is 0, `all.get('claude')` and `inFront.get('claude')` are 1.
  - `inFront leaves out an agent not known yet, as known does`: `counts([agent('t', { appPending: true })])`: `known.size` and `inFront.size` are 0, `all.size` is 1.
  - `a resting agent is on its app's page and in its ring`: after `update([resting('c1'), resting('c2')])`, `apps()` equals `[{ id: 'claude', count: 2, waiting: 0 }]` and `ringIds(rings, 'claude')` equals `['c1', 'c2']`.
- [ ] **Step 2: Write the tests in `appFilter.spec.ts`,** in a new `describe('resting agents (docs/plans/2026-11-19-dial-claude-app-sessions-design.md)')`:
  - `the app in front whose agents all rest is shown once they come, though the dial shows another app`: `filter.front('claude')`, `settle()`, `agents({ ghostty: 1 })`: `shown()` is `ghostty`; then `agents({ ghostty: 1, claude: 2 }, { ghostty: 1 }, { ghostty: 1, claude: 2 })`: `shown()` is `claude` and `causes()` equals `['front']`; two more `shown()` are `claude`, `causes()` unchanged.
  - `… and when they come before the dial's first list`: `filter.front('claude')`, `settle()`, `agents({ ghostty: 1, claude: 2 }, { ghostty: 1 }, { ghostty: 1, claude: 2 })`: four `shown()` are `claude`, `causes()` equals `[]`.
  - `resting agents weigh nothing in the default while their app is not in front`: `agents({ claude: 16, ghostty: 1 }, { ghostty: 1 }, { claude: 16, ghostty: 1 })`: `shown()` is `ghostty`; `filter.front('vscode')`, `settle()`: still `ghostty`; `pick('claude')` is `switched` and `shown()` is `claude`.
- [ ] **Step 3: Write the tests in `cableHost.spec.ts`,** in `describe('the view while a window is open')`:
  - `the app settled in front getting only resting agents turns tabs to apps at the next list a dial that says appFilter reads`: as `the app settled in front getting known agents …`: `five()`, `onTab(host, ['h1'])`, `settle(host, 'claude')`, then `agents.push(agent('c1', 'claude', { resting: true }))`: after `listAgentSnapshot({ apps: true })`, `views` equals `['tabs window', 'apps front']`.
  - `a pick of Harness made before the window opened holds with the app in front holding only resting agents`: as `a pick of Harness made before the window opened turns the view to tabs once and holds`, over `[...five(), agent('c1', 'claude', { resting: true }), agent('c2', 'claude', { resting: true })]` and `settle(host, 'claude')` in Ghostty's place: `views` equals `['apps window', 'tabs empty']`, and the same after three more reads with apps.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/hosts/select.spec.ts src/cable/hosts/appFilter.spec.ts src/cable/cableHost.spec.ts`. Expected: FAIL in the first three of `select.spec.ts` (`known` counts the resting agents; no `inFront`) and in `appFilter.spec.ts`'s `… though the dial shows another app` (the front rule reads `known`, so the dial stays on `ghostty`). The ring test, the other two `appFilter.spec.ts` tests and both `cableHost.spec.ts` tests hold today's behavior and pass: they guard the change (once `known` leaves resting agents out, a front rule or a view still reading it fails them).
- [ ] **Step 5: Commit** `test(dial): a resting agent counts for nothing in the default app, and for the app in front (red)`.
- [ ] **Step 6: Implement** (Interfaces above).
- [ ] **Step 7: Run** `cd cli && npx vitest run src/cable src/services/devices.spec.ts && npm run typecheck`. Expected: PASS. A failure in `devices.spec.ts` is reported, not edited (Task 7's file).
- [ ] **Step 8: Commit** `dial: a resting agent counts for nothing in the default app, and for the app in front`.

### Task 4: The Claude app's adapter names its pane key

**Layer:** devices service process. **Depends on:** none. **Effort:** `medium`.

**Red test:** `cli/src/cable/hosts/claudeApp.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/claudeApp.ts`
- Test: `cli/src/cable/hosts/claudeApp.spec.ts`

**Interfaces:**
- Produces: `export const CLAUDE_SESSION` (the same regex, now exported; no `g` flag).
- Produces: `export function claudePaneKey(localId: string): string`, answering `` `claude-app:${localId}` ``: the key the store's source lists the same session by.
- Produces: `createClaudeAppAdapter(deps: AppLinkDeps): HostAdapter & Required<Pick<HostAdapter, 'canShow' | 'show' | 'paneKey'>>`, with `paneKey: (pane) => claudePaneKey(pane.id)`. Nothing else of the adapter changes.

- [ ] **Step 1: Write the test:** `its pane key is claude-app: and the session's id, the key the store's source lists it by`: `adapter.paneKey(pane(SESSION))` equals `` `claude-app:${SESSION}` ``; `claudePaneKey(SESSION)` equals the same; `CLAUDE_SESSION.test(SESSION)` is true and `CLAUDE_SESSION.global` is false.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/claudeApp.spec.ts`. Expected: FAIL (`paneKey` is not a function; no export `claudePaneKey`).
- [ ] **Step 3: Commit** `test(dial): the Claude app's adapter names its pane key (red)`.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `cd cli && npx vitest run src/cable src/services/devices.spec.ts && npm run typecheck`. Expected: PASS with no other spec edited: a live Claude app agent's list now carries `paneKeys: ['claude-app:local_…']`. A failure in another spec is reported, not edited (those files are other tasks').
- [ ] **Step 6: Commit** `dial: the Claude app's adapter names its pane key`.

### Task 5: The store reader

**Layer:** devices service process, and a test fixture. **Depends on:** 4 (`CLAUDE_SESSION`). **Effort:** `xhigh` (another program's files, read while it writes them: links, bounds, and a walk that must never leave a newer session out).

**Red test:** `cli/src/cable/hosts/claudeAppStore.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/claudeAppStore.ts`
- Test: `cli/src/cable/hosts/claudeAppStore.spec.ts` (new)
- Create: `cli/src/testing/claudeAppFixture.ts`

**Interfaces:**
- Consumes: `CLAUDE_SESSION` (Task 4); `MAX_CWD` (`herdrSource.ts`).
- Produces in `claudeAppStore.ts`:
  ```ts
  export const MAX_ACCOUNTS = 8
  export const MAX_ORGS = 8
  export const MAX_FILES = 1_024
  export const MAX_LISTED = 16
  export const MAX_PARSES = 256
  export const MAX_FILE_BYTES = 1024 * 1024

  /** One Code session, as its store file says it. Nothing else of the file is kept. */
  export interface ClaudeAppSession {
    /** The app's id: the file's name without `.json`, and its `sessionId`. */
    localId: string
    /** Claude Code's id of the session: `cliSessionId`. */
    sessionId: string
    cwd: string
    /** `title` as written, when it is a string: the source runs the title rule. */
    title?: string
    /** The store's, when a finite number; else the file's mtime (ms). */
    lastActivityAt: number
  }
  /** The folders read, each an absolute path of a real folder, in name order. */
  export interface StoreFolders { accounts: readonly string[]; orgs: readonly string[] }
  export interface StoreRead { sessions: ClaudeAppSession[]; parsed: number; skipped: number; over: number; more: boolean }

  export class ClaudeAppStore {
    constructor(root: string)
    /** Lists the account folders and each one's org folders again. None when the root is no real folder: every file is forgotten. */
    folders(): Promise<StoreFolders | undefined>
    /** In each org folder read: the `local_….json` names, each `lstat`ed. No file is opened. */
    files(): Promise<void>
    /** One file's `lstat` alone; gone, it is forgotten. A name outside the form, or an org folder not read, does nothing. */
    touch(org: string, name: string): Promise<void>
    /** The walk: the sessions to list, newest sort time first, at most 16. */
    read(): Promise<StoreRead>
    /** Drops everything held. */
    forget(): void
  }
  ```
  - No method rejects, logs or writes. Reads go one file at a time (`node:fs/promises`).
  - `folders()`: `lstat`, real folders only, name order, at most 8 and 8; the rest counted. A folder that left takes its files with it.
  - `files()`: at most 1,024 names a folder in name order, the rest counted. A name gone is forgotten; a new one is held with its size and mtime; a size or mtime that moved is kept for the next read. A name that is no regular file (a link, a folder) is held as unusable and never opened.
  - `read()`: the walk of the spec's "A read", in the order and with the stop of "Decided here". A file whose size and mtime match what it was parsed at counts from what is held; a new or changed one is opened (`O_NOFOLLOW`, the handle's stat a regular file of at most 1 MiB, at most 1 MiB + 1 byte read) and checked in the order of "Decided here". Two files with one `cliSessionId`: the newest `lastActivityAt` is kept. After 256 opens the walk stops with `more: true`. `parsed`, `skipped` and `over` as "Decided here".
- Produces in `claudeAppFixture.ts`:
  ```ts
  export interface FixtureSession {
    localId: string; cliSessionId: string; cwd: string
    title?: unknown; lastActivityAt?: unknown; isArchived?: unknown
    /** Fields the reader must never keep. */
    more?: Record<string, unknown>
  }
  export interface FixturePlace { account?: string; org?: string; mtime?: number; bytes?: number }
  /** A store of the Claude app's in `root`, a folder the caller made: never a real one. */
  export function claudeAppFixture(root: string): {
    readonly root: string
    /** That account's org folder, made when missing. */
    org(place?: FixturePlace): string
    /** Writes `<localId>.json` as the app does, a temp file renamed over it; padded to `bytes`, its mtime set to `mtime`. Its path. */
    write(session: FixtureSession, place?: FixturePlace): string
    /** Removes the file and leaves a 13-byte `deleted_<uuid>` in its place. */
    remove(localId: string, place?: FixturePlace): void
  }
  ```
  One default account and org (two fixed UUIDs, exported as `ACCOUNT` and `ORG`). `write` puts `sessionId: localId` in the file unless `more` says otherwise.

Helpers for the spec: `store()` makes a temp folder (`mkdtemp`, removed after), its fixture and a `ClaudeAppStore`; `loaded(s)` runs `folders()`, `files()`, `read()`; `local(n)` and `cli(n)` are the n-th local id and lower-case UUID; `T` is a fixed mtime in ms, files written at `T - n * 1000` with `lastActivityAt` the same unless a test says otherwise; every write and rewrite names its mtime, so no test reads the wall clock. A test that needs text that is no session (half a JSON text, `null`, `1e999`) writes the file's text itself. The whole file is `describe.skipIf(process.platform === 'win32')`.

- [ ] **Step 1: Write the tests.**
  - **Fields.** `a session gives its five fields and nothing else`: a file with `title: 'Fix the build'` and `more: { messages: ['secret'], prompt: 'secret' }`: `Object.keys(session).sort()` equals `['cwd', 'lastActivityAt', 'localId', 'sessionId', 'title']`, and `JSON.stringify(read)` holds no `secret`. `a title that is no string is none; a lastActivityAt that is no finite number is the file's mtime`: `title` of `7` and `null`; `lastActivityAt` of `'x'`, `null` and a file whose text says `1e999`.
  - **Gone.** `an archived session is not listed and not counted skipped, whatever its other fields`; `a deleted session's tombstone is never a session`: after `remove`, then `touch` of its name, it is gone and `skipped` is 0.
  - **Skipped and counted,** one `it.each`, each giving no session and `skipped: 1` beside one good file: half a JSON text (the app mid-write); a file of 1 MiB + 1 byte; a link named `local_….json` to a good file elsewhere; `sessionId` another local id; `cliSessionId` of `'x'`, an upper-case UUID, `7` and none; `cwd` of `''`, `7`, none and 4,097 characters; `isArchived` of `'yes'` and `1`. Then `a file skipped mid-write is listed once it is whole`: rewritten and touched, the next read lists it with `skipped: 0`.
  - `JSON that is no object is skipped and counted` (Review Focus 4): files whose text is `null`, `[]`, `42` and `"x"`: no session, `skipped: 4`, nothing thrown.
  - `a file swapped for a link between its stat and its read is not followed` and `a file grown past 1 MiB between its stat and its read is not read whole` (Review Focus 3): after `files()`, the file is replaced (a link to a good file elsewhere; 2 MiB of JSON) with no `touch`; `read()` gives no session for it and `skipped: 1`.
  - **Names.** `only local_….json names are held`: `deleted_<uuid>`, `archived-sessions.idx`, `scheduled-tasks.json`, a `waiting-input` folder, `local_a.json.tmp`, `LOCAL_a.json` and `local_a b.json`, each holding a good session's text: none listed, `skipped: 0`.
  - `two files with one cliSessionId give one session, the newest lastActivityAt's`: one session, its `localId` the newer file's, `skipped: 1`; across two account folders too.
  - **Only new or changed files are parsed.** Three files: first read `parsed: 3`; again `parsed: 0`, the same sessions; one rewritten and touched: `parsed: 1`.
  - **The walk.** 20 files, the n-th at `T - n * 1000`; each test below starts from a new store of these 20 after a first read:
    - `it stops once 16 are counted and the next file is older`: that first read gave `parsed: 16` and 16 sessions, the newest first (`localId`s `local(1)` to `local(16)` in order); a second gives `parsed: 0`.
    - `a newer write is parsed`: `local(20)` rewritten at `T + 1000` and touched: `parsed: 1`, it is first, `local(16)` is out.
    - `archiving one of the 16 parses the next`: `local(3)` rewritten archived at its own mtime and touched: `parsed: 2`, `local(17)` is last.
    - `a file rewritten with no new activity sorts by its lastActivityAt`: `local(18)` rewritten at mtime `T + 1000` with `lastActivityAt: T - 18_000`: `parsed: 1`, the list unchanged.
    - `a lastActivityAt ahead of the file's mtime sorts by the mtime`: `local(2)` with `lastActivityAt: T + 9_000_000` at mtime `T - 2000`: it stays second, and its `lastActivityAt` is as written.
  - `a walk cut at 256 asks for one more read`: 300 archived files newer than 16 good ones: the first read gives `parsed: 256`, no session, `more: true`, `over: 60`; the second `parsed: 60`, 16 sessions, `more: false`, `over: 0`.
  - **Bounds.** `9 account folders: 8 are read, in name order, and over counts one`; `9 org folders in an account: over counts one`; `1,030 names in a folder: 1,024 are held and over counts six`; `an account or an org folder that is a link is not read`; `a root that is a link, a file or not there gives no folders, and a read of nothing`.
  - `touch: a name outside the form, or a folder not read, does nothing`.
  - `forget drops everything: the next read parses again`.
  - `nothing in the store is written`: the fixture's names, sizes and mtimes are the same before and after `folders()`, `files()`, `touch()` and `read()`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/claudeAppStore.spec.ts`. Expected: FAIL (no module `./claudeAppStore.js`).
- [ ] **Step 3: Commit** `test(dial): the Claude app's store, read with bounds (red)`.
- [ ] **Step 4: Implement** the fixture, then the reader. The reader's top comment says what is read and why it is never written, and that its log lines are the source's.
- [ ] **Step 5: Run** `cd cli && npx vitest run src/cable/hosts/claudeAppStore.spec.ts src/architecture.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `dial: the Claude app's store, read with bounds`.

### Task 6: The source

**Layer:** devices service process. **Depends on:** 1 (`resting`), 4 (`claudePaneKey`), 5 (the reader's types). **Effort:** `xhigh` (one pass at a time, changes during a pass, a stop mid-pass, watches set as folders come and go).

**Red test:** `cli/src/cable/hosts/claudeAppSource.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/claudeAppSource.ts`
- Test: `cli/src/cable/hosts/claudeAppSource.spec.ts` (new)

**Interfaces:**
- Consumes: `ClaudeAppStore`, `ClaudeAppSession`, `StoreFolders`, `StoreRead` (Task 5); `claudePaneKey`, `CLAUDE_SESSION` (Task 4); `observedAgentId` (`observed.ts`); `observedTitle`; `HostAgent.resting` (Task 1).
- Produces:
  ```ts
  export interface ClaudeAppSourceDeps {
    /** The store's reader (claudeAppStore.ts), on `root`. */
    store: Pick<ClaudeAppStore, 'folders' | 'files' | 'touch' | 'read' | 'forget'>
    /** The store's root, computed once by devices.ts. The folder above it is the Claude app's, watched while the root is not there. */
    root: string
    /** One watch on the nearest existing folder of the list (folderWatch.ts watchNearest), telling the changed entry's name when the OS gave one. Its stop. */
    watch(folders: readonly string[], changed: (file?: string) => void): () => void
    /** A timer; its cancel is returned. */
    after(ms: number, run: () => void): () => void
    /** A tap on that agent's session, as the devices route it. */
    focus(localId: string, agentId: string): Promise<boolean>
    canShow(localId: string): boolean
    show(localId: string, agentId: string): Promise<PaneSwitch>
    monotonic(): number
    log(line: string): void
  }
  export class ClaudeAppSource implements HostSource {
    readonly id = 'claude-app'
    constructor(deps: ClaudeAppSourceDeps)
    start(): void
    stop(): void
    onChange(listener: () => void): () => void
    list(): HostAgent[]
    capabilities(): Caps
    focus(agent: HostAgent): Promise<boolean>
    hasPane(agent: HostAgent): boolean
    showPane(agent: HostAgent): Promise<PaneSwitch>
  }
  ```
  No `send`, no `markSeen`.
- **A row** is Global Constraints' "The row", with `sessionId`, `cwd` and `lastActivityAt` the session's and `paneKeys: [claudePaneKey(localId)]`. `capabilities()` is `{ status: true, voice: false, focus: true, answer: false }`. `focus`, `hasPane` and `showPane` find the listed row by the agent's id and hand its local id to the deps; no such row answers `false`, `false`, `'failed'`.
- **A pass** is the one unit of work, one at a time:
  1. it takes what waits: a listing (set by the start, an org's event with no name, any event of an account's watch, and an event of the root's watch: any while the root is there, only one naming the root or naming nothing while it is not) or the names touched (an org's event naming a `local_….json`);
  2. for a listing: `folders()`; whether the root is there is said when it changed (`watch · on|none`); with no root every row goes (one `onChange` if there were rows), the account and org watches stop, and the pass ends; else the account and org watches are set to the folders read (`watch([folder], …)` each; kept, added, stopped), then `files()`;
  3. for names: `touch(org, name)` each;
  4. `read()`, then the rows, the log lines and `onChange` when the rows' ids, names, folders or order changed (never for a new `lastActivityAt` alone); `more` asks for one more pass.
  - A change during a pass waits; one more pass starts when the pass has ended and 250 ms have passed since its start. An org's event naming anything else does nothing and starts no pass.
  - `start()` sets the root's watch, `watch([root, dirname(root)], …)`, before the first `folders()`. `stop()` stops every watch and the timer, calls `store.forget()`, drops the rows (one `onChange` if there were rows) and what waits; a pass that lands after it changes and says nothing.
  - A store call that rejects ends the pass with the rows kept; the next change runs a pass.

Helpers for the spec: `setup(over)` as `cmuxSource.spec.ts`'s: a fake store whose five calls are recorded and answered by hand (`reply`), a `watch` that records each `(folders, changed)` with its stop, an `after` the test fires, a clock, `log` and a change counter. `ROOT = '/h/Library/Application Support/Claude/claude-code-sessions'`, `ACCOUNT = join(ROOT, 'acc')`, `ORG = join(ACCOUNT, 'org')`, `LOCAL = 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'`, `SESSION = '0b7c2f4e-8a1d-4c3b-9e5f-6a7b8c9d0e1f'`, `session(over)` a `ClaudeAppSession` in `/work/api` titled `Fix the build`. `LOG` is Global Constraints' regex.

- [ ] **Step 1: Write the tests.**
  - **The row.** `a session is one idle, resting agent on the Claude app's page, under the observed source's id`: `list()` equals `[{ id: observedAgentId('claude', SESSION), engine: 'claude', sessionId: SESSION, paneKeys: [`claude-app:${LOCAL}`], name: 'Fix the build', cwd: '/work/api', host: 'claude', app: 'claude', state: 'idle', unseenDone: false, resting: true, lastActivityAt: <the session's> }]`. `a row always has a name` (Review Focus 4): no title gives `api`; titles of `''`, `'  '` and `'a\u0007b'` give `api`; a title of 80 characters is cut to 64; `cwd: '/'` with no title gives `claude`.
  - `it has status and a tap, no voice and no answer, and takes no words`: `capsLetters(source.capabilities())` is `sf`; `source` has no `send` and no `markSeen`.
  - `a tap, a rest and its look go to the session's local id`: `focus`, `hasPane`, `showPane` call the deps with `(LOCAL, id)`, `(LOCAL)`, `(LOCAL, id)`; an agent it does not list answers `false`, `false`, `'failed'` and calls nothing.
  - **Which event reads what.** `the start lists the folders, then the files, then reads`: the store's calls are `['folders', 'files', 'read']`. `an org's event naming a session's file touches that file alone`: `['touch', 'read']`, with `(ORG, 'local_….json')`. `an org's event naming anything else does nothing`: for `deleted_x`, `archived-sessions.idx`, `scheduled-tasks.json`, `waiting-input`, `local_a.json.tmp`, `.DS_Store`: no call, no timer. `an org's event with no name, and any event of an account's or the root's watch, lists the folders again`.
  - **The watches.** `the root's watch is set before the folders are listed, on the root and the app's folder`: the first `watch` call is `[ROOT, dirname(ROOT)]`, made before `folders` is called. `the account and org watches are set before the files are listed, one a folder`: `[[ACCOUNT], [ORG]]` after `folders` answers and before `files` is called. `a folder that left loses its watch, a new one gets one, and none is set twice`.
  - **The root's wait.** `with no root it says watch · none, lists nothing and reads nothing`; `while it waits, an entry of the app's folder that is not the root does nothing`: `changed('Cookies')` and `changed('config.json')` call nothing; `changed('claude-code-sessions')` and `changed(undefined)` call `folders`. `the root made: watch · on, and its sessions are listed`. `the root removed: every row goes with one change, the account and org watches stop, and it says watch · none`.
  - **One pass at a time.** `ten changes during a pass give one more pass, not ten`; `the next pass starts no sooner than 250 ms after the last one's start`: `after` was asked for 250, and no store call is made until it fires and the pass has ended; `the names touched during a pass are all touched in the next`; `more than 256 names waiting become one listing` (Review Focus 2): 300 distinct names during a pass give `['folders', 'files', 'read']` next, and no `touch`; `a read cut short asks for one more with no event`: `more: true` gives one more `read` after the 250 ms.
  - **Told only when the list changes.** `a new lastActivityAt alone tells nothing, and list() has it`; `a new name, a new folder, a new order, a row come or gone each tell once`.
  - **Start and stop.** `a second start sets no second watch`; `stop stops every watch and the timer, forgets the store and drops the rows with one change`; `a pass that lands after a stop lists nothing, and the next start reads afresh` (Review Focus 5): the first pass's `read` answered after `stop()` changes nothing and logs nothing; after `start()` again the calls are `['folders', 'files', 'read']`, one row, `listed · 1 sessions` said again and no second `watch · on`.
  - **Failures.** `a store call that rejects keeps the rows and throws nothing, and the next change runs a pass`, for each of the five calls.
  - **Log lines.** `listed is said when the count changes`; `read is said for the first read of a start, then only for a slower one`: `[claude-app] read · 12 ms · 3 parsed · 1 skipped` with the clock moved 12 ms; `over is said when its number changes and is above zero`; `every line is fixed words and counts`: after every test's lines, each matches `LOG`, and none holds `Fix the build`, `api`, `/work`, `LOCAL`, `SESSION` or `ROOT`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/claudeAppSource.spec.ts`. Expected: FAIL (no module `./claudeAppSource.js`).
- [ ] **Step 3: Commit** `test(dial): the Claude app's sessions, listed from its store (red)`.
- [ ] **Step 4: Implement.** The top comment says what the source is, that it is pushed and never polled, why a pass is one at a time (a working turn writes its file several times a second), and that a log line holds fixed words and counts only.
- [ ] **Step 5: Run** `cd cli && npx vitest run src/cable && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `dial: the Claude app's sessions, listed from its store`.

### Task 7: The devices run the source

**Layer:** devices service process. **Depends on:** 2, 3, 4, 6. **Effort:** `high` (wiring in a file held at 100%; the tap's echo guards).

**Red test:** `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts`
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `ClaudeAppSource`, `ClaudeAppSourceDeps` (Task 6); `ClaudeAppStore` (Task 5); the adapter's `paneKey` (Task 4); the registry's ended rule (Task 2); the counts, `known` and `inFront` (Task 3); `claudeAppFixture` (Task 5).
- Produces in `devices.ts`:
  - `DevicesDeps.claudeAppStore?: ClaudeAppSourceDeps['store']`, for this service's tests, as `cmux` is.
  - The store's root, once: `join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions')`. Its comment says it is not a Harness path (so not `harnessHome.ts`'s).
  - `claudeNoted`, named beside `cmuxAppNoted`: `noting({ ...claude, show: (pane, agentId) => { noteLink(agentId); return claude.show(pane, agentId) } })`. It takes the inline copy's place in `adapters`, between Orca's and the Codex app's, and is noted once.
  - The source: `observed && apps.platform === 'darwin' ? new ClaudeAppSource({ … }) : null`, with
    - `store: deps.claudeAppStore ?? new ClaudeAppStore(root)`, `root`;
    - `watch: (folders, changed) => watchNearest(folders, changed)`; `after: timerIn('claude-app')`; `monotonic`; `log`;
    - `focus: (localId, agentId) => { noteMove(); noteLink(agentId); return opener.open(agentId, { bundle: APP_BUNDLES.claude, pane: { adapter: claude.id, id: localId } }) }`;
    - `canShow` the adapter's; `show` the noted copy's (`claudeNoted.show!`).
  - It joins `HostRegistry` last, after `opencode`; its `onChange` runs `part.call('dial', outsideTurn)`.
  - `dialAttached`: `part.call('claude-app', () => on ? source.start() : source.stop())`, beside opencode's.
  - `claudeAttached` and `claudeSettled` do not change.
- `devices.spec.ts`: `start` takes `claudeAppStore`.

Helpers, in a new `describe("the Claude app's Code sessions, from its store (docs/plans/2026-11-19-dial-claude-app-sessions-design.md)")`, shaped as the cmux describe's: `onMac`, `attach`, `listed`, `flush`; `ROOT = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions')` (the suite's throwaway home), `ACCOUNT_DIR`, `ORG_DIR` under it; `SESSION`, `LOCAL`, `BUNDLE`, `continued(local)` and `hook` as the Claude app follow describe's; `ID = observedAgentId('claude', SESSION)`. `withStore(over)` starts the devices on macOS with a fake reader whose five calls are recorded: `folders` answers `{ accounts: [ACCOUNT_DIR], orgs: [ORG_DIR] }`, `read` answers the test's sessions (one, `LOCAL` and `SESSION`, in `/work/api`, titled `Fix the build`); `live()` attaches the dial and lets the first pass land; `changed(folder, file?)` fires the latest recorded `watchedFolders` watch of that folder and lets its pass land. Every `open` is a recorded run: nothing is executed.

- [ ] **Step 1: Write the failing tests.**
  - `on macOS with a dial attached its sessions are listed sf, idle, on the Claude app's page; detached, the source stops, its watches close and the reader forgets`: no reader call before the attach; `listed()` equals `[{ id: ID, name: 'Fix the build', caps: 'sf' }]`; `host().hostOf(ID)` and `appOf(ID)` are `claude`; `watchedFolders.calls` holds `[[ROOT, dirname(ROOT)], expect.any(Function)]`, `[[ACCOUNT_DIR], …]` and `[[ORG_DIR], …]`; `logs` holds `[claude-app] watch · on` and `[claude-app] listed · 1 sessions`; after `watching!(false)`, `listed()` is `[]`, the three watches are stopped and `forget` was called.
  - `off macOS, and with HARNESS_DEVICE_OBSERVED off, there is no source`: the reader is never called and no watch names `ROOT`.
  - `a change of a session's file reaches the dial's list`: the read answering a second session, `changed(ORG_DIR, 'local_….json')`: two rows; the reader's calls since are `touch`, `read`.
  - `a tap on a store row is one open of the continue link, and is the dial's own move and link`: with `fakeListener`, the Claude app settled in front and an earlier attach of `SESSION` kept: `host().openAgent(ID)`; `orcaRuns` equals `[continued(LOCAL)]`; an attach of `SESSION` right after logs `[device] attach · skipped · echo`; a look away and back inside 2 s (`backInFront`) logs `[device] settle · skipped · echo`.
  - `a tap whose link fails brings the app by its bundle, said in one line with no id`: the run answering code 1 once: `orcaRuns` equals `[continued(LOCAL), ['/usr/bin/open', ['-b', BUNDLE], 10_000]]`; `logs` holds `[device] open · claude · fallback`; no line holds `LOCAL`.
  - `a rest with the Claude app in front shows the session by the noted adapter; with another app in front it has no pane`: `swipeEnded(ID, 'rest')` runs `[continued(LOCAL)]`, and an attach right after is skipped as an echo; with Orca in front nothing runs.
  - `a hooked session the store also lists is one row, the hook's; once its session ended the store's idle row has its place and its tap`: after `hook('session-start')`, `listed()` has one row, `ID`; after `hook('session-end')`, still one row, `ID`, caps `sf`, and `openAgent(ID)` runs `[continued(LOCAL)]`; 40 s on (the observed tick), still that one row.
  - `a hooked session whose id the store has not caught up with folds by the app's own id`: the store's session with another `cliSessionId` and the same `LOCAL`: one row, `ID`.
  - `a store session hooked from Ghostty is one row on Ghostty's page, and the store's again once it ended` (Review Focus 1): `hook('session-start', { hostHints: { TERM_PROGRAM: 'ghostty' } })`: one row, `appOf(ID)` is `ghostty`; after its `session-end`, one row, `appOf(ID)` is `claude`.
  - `the store's rows weigh nothing in the dial's default app` (decision 7), a dial that says `appFilter`: 16 store sessions and one hooked Ghostty agent: the `apps` list shows `ghostty` and counts `claude` 16; the Claude app settling in front shows `claude`; from Ghostty again, a pick of `claude` shows it.
  - `the Claude app in front before its rows arrive shows the Claude page, whichever comes first, the store's first read or the dial's first list` (decision 9), an `it.each` over the two orders: a dial that says `appFilter`, the Claude app settled in front (`FRONT_SETTLE_MS`) and one hooked Ghostty agent before the attach, no Code process (no hook names `LOCAL`), the reader's one session.
    - The read after the list: the reader's first `read` held until the dial has read its first list, which shows `ghostty`; once the pass lands, the dial's next list shows `claude`, its `apps` counting `claude` 1, and `logs` holds `[device] app filter: switched · front`.
    - The read before the list: the first `read` answered before the dial reads its first list, which shows `claude`.
    - Both: no further list of the test turns the dial off `claude`, and no `backInFront` is needed.
  - `the app's settle turns the dial to a session only the store still lists`: an attach kept, its session ended and dropped by the tick; the Claude app settling in front asks the dials to follow `ID`.
  - `with no reader given the devices read the store under the home folder`: `claudeAppFixture(ROOT)` with one session, removed after; real timers; once `[claude-app] listed · 1 sessions` is logged (`vi.waitFor`), `listed()` has its row. `it.skipIf(process.platform === 'win32')`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts -t "Claude app's Code sessions"`. Expected: FAIL (nothing listed; `claudeAppStore` is no dep).
- [ ] **Step 3: Commit** `test(dial): the devices list the Claude app's sessions from its store (red)`.
- [ ] **Step 4: Implement** (Interfaces above). The source's comment says when it runs (macOS, the observed switch, a dial attached) and that a row with a process is the observed copy.
- [ ] **Step 5: Run** `cd cli && npx vitest run src/cable src/services/devices.spec.ts src/architecture.spec.ts && npm run typecheck && npm run test:core`. Expected: PASS, `services/devices.ts` at 100%. The file's other macOS tests with a dial attached now run the real reader on the throwaway home's store, which is not there: one `lstat`, then `[claude-app] watch · none`. A test that expects the whole of `logs` is updated here for that line; none may be loosened otherwise.
- [ ] **Step 6: Commit** `dial: the Claude app's Code sessions are on the dial, with or without a process`.

### Task 8: End to end, a fixture store and a fake process

**Layer:** test. **Depends on:** 7. **Effort:** `high`.

**Red test:** none: no behavior (the end-to-end tests of Tasks 1 to 7). One commit.

**Files:**
- Create: `cli/e2e/deviceClaudeAppSessions.e2e.ts`

**Interfaces:**
- Consumes: `claudeAppFixture` (Task 5); `observedAgentId`; the e2e harness (`IsolatedDaemon`, `Desk`, `until`), with `deviceCmux.e2e.ts`'s shapes for `rosters`, `showing`, `said`, the tap (`{ t: 'agent.open', agentId }`) and `FILTER`; `Outside` (`e2e/harness/outsideAgent.ts`), the suite's fake Claude Code, unchanged; `deviceWithoutApp.e2e.ts`'s `heard` shape for a turn.

- [ ] **Step 1: Write the file**, `describe.skipIf(process.platform !== 'darwin')`. Its header says the real Claude app, its Application Support folder, `~/.claude` and `/usr/bin/open` are never touched: the store is a fixture in the daemon's own home, the session with a process is the suite's fake Claude Code, and `open` is the harness's fake.
  - `fresh(sessions)`: a daemon (`CABLE_DISABLE: 'false'`; no backend, nothing is spoken) and a desk. **Before the daemon starts** it checks that `HARNESS_OPEN_BIN` is an absolute path inside `d.root`, that `d.env.HOME` is inside `d.root`, that `d.env.CLAUDE_CODE_HOST_SESSION_ID` is undefined, and so that the store's root, `join(d.env.HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions')`, is inside `d.root`; then it makes the fixture's org folder there and writes the sessions given. The first test's: `alpha` (title `Fixture Alpha`, `cwd` `/work/e2e-alpha`, the newest), `beta` (no title, `cwd` `/work/e2e-beta`), `gamma` (archived, title `Fixture Gamma`), and one more written and removed, so its `deleted_<uuid>` is left. `onTestFailed` prints the daemon's last 200 log lines.
  - `the Claude app's sessions that are not archived are on the dial, idle, a tap opens one, and archiving one takes its row away`:
    1. A dial that says `appFilter` is plugged in. Its `apps` show `claude`, and the list holds exactly two rows of host `claude`, in this order: `{ id: observedAgentId('claude', <alpha's cliSessionId>), name: 'Fixture Alpha', engine: 'claude', host: 'claude', caps: 'sf' }` and `{ id: <beta's>, name: 'e2e-beta', … caps: 'sf' }`. No `turn.started` or `turn.done` names either.
    2. `{ t: 'agent.open', agentId: <alpha's> }`: `d.opens()` equals `[['-b', 'com.anthropic.claudefordesktop', 'claude://code/continue?session=<alpha's local id>']]`.
    3. `beta` is written again archived. The log says `[claude-app] listed · 1 sessions`, and the dial's list is `alpha` alone. The test prints the milliseconds from that write to that log line (the source's part) and to that list (which also waits for the dial's own next list).
    4. The log holds `[claude-app] watch · on`, `[claude-app] listed · 2 sessions`, `[claude-app] listed · 1 sessions` and one `[claude-app] read · ` line, which the test prints. Every line holding `[claude-app]` ends in one of the fixed forms (Global Constraints' regex). The whole log holds none of: `Fixture Alpha`, `Fixture Gamma`, `e2e-alpha`, `e2e-beta`, any of the four local ids, any `cliSessionId`, the account's or the org's UUID.
  - `a session the Claude app runs is one row with its real state while its process runs, and the store's idle row under the same id once it ends` (decision 10). `fresh([])`: the org folder, no session. `LIVE = 'local_<a fixed uuid>'`.
    1. A dial that says `appFilter` is plugged in. `Outside.start(d, 'e2e-live', { __CFBundleIdentifier: 'com.anthropic.claudefordesktop', CLAUDE_CODE_HOST_SESSION_ID: LIVE })`: the hints go to the fake's environment only. The dial's list holds one row, `engine.id`, host `claude`.
    2. The fixture writes `LIVE` with `cliSessionId: engine.sessionId`, title `Fixture Live`, `cwd` the fake's folder. Once the log says `[claude-app] listed · 1 sessions`, the dial's next list holds exactly one row, `engine.id`. No list the dial gets in this test holds two rows with that id, nor any other row.
    3. Its real state: a prompt typed at the fake (`engine.type`) gives the dial `turn.started`, then `turn.done`, for `engine.id` (a store row has no turn). `d.opens()` is `[]`.
    4. `engine.type('!exit')`: the fake runs its `SessionEnd` hook and exits. The dial's list then holds one row, `engine.id`, `name: 'Fixture Live'`, `host: 'claude'`, `caps: 'sf'`, with no turn after the end.
    5. `{ t: 'agent.open', agentId: engine.id }`: `d.opens()` equals `[['-b', 'com.anthropic.claudefordesktop', 'claude://code/continue?session=' + LIVE]]`.
    6. Every log line holding `[claude-app]` matches Global Constraints' regex, and none holds `Fixture Live`, `LIVE` or `engine.sessionId`.
  - `afterEach` closes the fake (`Outside.close`), then the desk, then the daemon.
- [ ] **Step 2: Run** `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceClaudeAppSessions.e2e.ts --reporter=default`. Expected: PASS, two tests, none skipped, on this Mac. A failure is a finding in the task that owns the behavior: report it, do not loosen the test.
- [ ] **Step 3: Commit** `e2e: the Claude app's sessions on the dial, from a fixture store and a fake process`.

### Task 9: The read's measure

**Layer:** a script, no process of the daemon. **Depends on:** 5. **Effort:** `medium`.

**Red test:** none: it changes no behavior. One commit.

**Files:**
- Create: `cli/scripts/benchmark-claude-app-store.ts`

**Interfaces:**
- Consumes: `ClaudeAppStore` (Task 5), `claudeAppFixture` (Task 5).
- Produces: `node --import tsx scripts/benchmark-claude-app-store.ts [output.json]`, run from `cli/`. It prints, and writes to `output.json` when given: `{ node, platform, arch, fileBytes, cases: [{ name, files, rounds, medianMs, maxMs, parsed }] }` with three cases: `first-16` and `first-200` (a new `ClaudeAppStore`, then `folders()`, `files()`, `read()`), and `changed-1` (on the 200, after a first read: one file written again, then `touch()` and `read()`).

- [ ] **Step 1: Write the script**, in the shape of `benchmark-dial-tab-read.ts`:
  - Before any module of the tree loads: a folder from `mkdtempSync`, set as `HOME` and `USERPROFILE`, with `ADAPTER_DATA_DIR`, `ADAPTER_RUNTIME_DIR` and `HARNESS_AUTH_DIR` inside it. The fixture store is a folder inside it; all of it is removed at the end. The script names no path under a home.
  - Each file is padded to 40,000 bytes (the spec's "about 40 KB each"), none archived, mtimes one second apart, `lastActivityAt` the mtime.
  - 21 rounds a case, each timed with `performance.now()`; `first-*` rounds use a new store on the same fixture; `changed-1` rewrites the newest file each round, at a newer mtime. `parsed` is the last round's `StoreRead.parsed`.
- [ ] **Step 2: Run** `cd cli && node --import tsx scripts/benchmark-claude-app-store.ts`. Expected: three cases in under 10 s; `parsed` 16, 16 and 1. Its only folder is the one it made and removed.
- [ ] **Step 3: Commit** `dial: a script that measures the Claude app store's read`.

### Task 10: Say it in the docs

**Layer:** docs. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: docs only. One commit.

**Files:**
- Modify: `cli/AGENTS.md`, `docs/specs/2026-11-15-device-host-adapter.md`

- [ ] **Step 1: `cli/AGENTS.md`**, the devices row of "The processes", after opencode's part: the Claude app's Code sessions, with or without a process, listed from the app's own store (`~/Library/Application Support/Claude/claude-code-sessions`, read only, six fields of each file) when a file there changes, while a dial is attached, on macOS (`cable/hosts/claudeAppSource.ts`, `claudeAppStore.ts`), and opened by the Claude app's link (`cable/hosts/claudeApp.ts`).
- [ ] **Step 2: `docs/specs/2026-11-15-device-host-adapter.md`:**
  - The De-duplication row: the listing sources are herdr, cmux, opencode and the Claude app's store; an ended hooked copy gives its row to another source's live copy.
  - Beside opencode's line: the Claude app's sessions with no process come from a listing source of the app's store, folded with the hooked copy by session id or by the adapter's pane key `claude-app:<local id>`, with a link to the spec.
- [ ] **Step 3: Commit** `docs: the Claude app's Code sessions reach the dial from its store`.

## Verification

**Platforms the pull request names:** macOS, where the Claude app's Code store and its link are. Tested: the unit specs on Linux in PR CI and on this Mac; check 1 on this Mac. Linux and Windows: nothing a person sees changes; a unit test with `platform: 'linux'` holds that no source is built (Task 7).

**Never touched by a tester or a test:** the real Claude app or its Application Support folder (not read, listed or stat-ed, before or after a run), `/usr/bin/open`, `~/.claude`, Diego's daemon (port 18473) and dial, his tmux server, any backend, production. No gate runs a real or renamed Claude app on this Mac. No test account is needed: nothing signs in.

**Temporary workflow:** none. Check 1 is one short file of two tests that runs isolated on this Mac; check 2 has a workflow of the repo's own.

**Turns** (decision 11). The one hand-started GitHub run (check 2) is in phase 4. Before it, the tester asks the main session, which asks the PM for the turn first: the repo starts no extra CI run without a reason.

**Required local gates**, on this Mac at the final head, recorded in the pull request (PR CI does not run them):
- `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts src/architecture.spec.ts`.
- `cd cli && npm run test:core`: 100% per file under `src/core/` and `src/services/`; it applies because `services/devices.ts` changes (`python3 scripts/local-checks.py --list` over this plan's files answers `cli-core` alone).
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit. Its receipt goes in the pull request's body before the tested commit is pushed.
- `git diff --stat origin/main -- cli/src/core cli/src/architecture.coreFiles.txt` prints nothing.
- Not needed: `npm run test:harnessd`, the serial and PTY specs, `make desktop-test`, `cargo test` in `device-app`, a firmware build or flash.

**1. A fixture store, the real daemon, a fake dial, the suite's fake Claude Code, the fake `open`**
- Where: this Mac only, at the final head. No account, no sign-in, no network.
- Build: nothing by hand. The suite starts the daemon from the working tree's bundle.
- Run: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceClaudeAppSessions.e2e.ts --reporter=default`.
- Isolation, the suite's own (`cli/e2e/harness/daemon.ts`, `cli/AGENTS.md` rules 5 and 6) and the file's:
  - a throwaway home, data folder and Codex home, a private port and tmux server, a fake dial on a pseudo-terminal;
  - the store is a fixture under that home (`<root>/…/Library/Application Support/Claude/claude-code-sessions`), checked to be inside the daemon's root before it starts;
  - the fake `open` (`HARNESS_OPEN_BIN`), checked to be inside the daemon's root, so a tap brings nothing forward;
  - the session with a process is the suite's fake Claude Code (`e2e/harness/outsideAgent.ts`), its Claude app hints (`__CFBundleIdentifier`, `CLAUDE_CODE_HOST_SESSION_ID`) in its own environment only; the daemon's has no `CLAUDE_CODE_HOST_SESSION_ID`, checked before it starts. The real Claude app, `~/.claude`, `~/Library/Application Support/Claude` and `/usr/bin/open` are never run, read or written.
- A person sees: two tests pass, none skipped. The first: The Claude app's page lists two sessions, idle, `Fixture Alpha` by its title and `e2e-beta` by its folder; the archived one and the deleted one are not there. The tap's `open` record is `-b com.anthropic.claudefordesktop claude://code/continue?session=local_…`. Archiving `beta` leaves `alpha` alone: the printed time from the write to `listed · 1 sessions` is under 1,000 ms on this Mac, else a finding; the dial's list follows at its own next list, whose time is printed too. The log has `[claude-app] watch · on`, `listed · 2 sessions`, `listed · 1 sessions` and a `read` line, and no title, folder or id. The second: the fake Claude Code started with the Claude app's hints is one row on the Claude page, its prompt's turn starting and ending on the dial; its store file written, still one row, the same id; once it exits, one idle row, the same id, named `Fixture Live`, and a tap's `open` record is `-b com.anthropic.claudefordesktop claude://code/continue?session=local_…`. `--reporter=default` keeps the printed lines visible under an agent's runner.
- Skipped or not run: report it as not verified, never as passed.
- On GitHub: none. `cli-e2e.yml`'s shards are Linux, where the file reads skipped. **Proposal** (not this pull request): a macOS job of `cli-e2e.yml` for the macOS-only dial files; this one needs nothing installed.

**2. The other dial flows still hold** (the registry's rule is every listing source's)
- On GitHub, by hand, once on the final head, in phase 4, after the PM's turn (asked through the main session): Actions → CLI end to end → Run workflow, branch `fix/dial-claude-app-idle-sessions`, `agent_browser_podman` not ticked (`.github/workflows/cli-e2e.yml`). Every shard passes; `deviceClaudeAppSessions.e2e.ts` reads skipped there. The link goes in the pull request.
- Isolation: the suite's own. No account, no secret.
- What it shows: `deviceHerdr`, `deviceOpencode`, `deviceWithoutApp`, `deviceClaudeOrca`, `dialAppFilter`, `dialAppFilterOnDial`, `dialClaudeAppFollow` and `devicesProcess` pass on the ended rule, the new pane key, the known counts and the app in front's count (`inFront`).
- On this Mac beside check 1, for the macOS-only file the shards skip: the same command with `e2e/deviceCmux.e2e.ts` (cmux's rows and their fold; it needs nothing installed and runs only its own fake). Three tests pass.

**3. The read's numbers** (the spec's Design 3; root rule 4; `cli/AGENTS.md` rule 8)
- Where: this Mac, at the final head. No daemon, port, account or network; the script's home and store are a throwaway folder.
- Run: `cd cli && node --import tsx scripts/benchmark-claude-app-store.ts "$(mktemp -d)/after.json"`.
- A person sees three cases: a first read of 16 files, a first read of 200 files (`parsed` 16: the walk stops), and one changed file (`parsed` 1). Before this change none of this ran: the "before" column is nothing. The table goes in the pull request with the Node version, beside check 1's printed write-to-list time and its `[claude-app] read` line.
- No number is a gate. Reported to the main session as a finding: a first read of 200 files over 100 ms (the tech limits' hot-path p95), or one changed file whose median, four times a second (the 250 ms rule), is over 1% of a core.
- The dial's list read, which the registry's change is on: `cd cli && node --import tsx scripts/benchmark-dial-tab-read.ts` at the final head and with `--src` on the base's `cli/src` (`git archive origin/main cli/src cli/package.json` into a scratch folder, `cli/node_modules` linked). The 50-agent median within noise of the base; both tables go in the pull request.
- At rest, held by specs: no timer, no read and no process while no file changes (Task 6, `an org's event naming anything else does nothing`; the source's only timer is the 250 ms between two passes); with no store folder, one watch and nothing else (Task 6, the root's wait).

**4. In PR CI, by itself:** `cli-typecheck` and `cli-tests` run the specs of Tasks 2 to 7 on Linux (the fixture store is a temp folder, so the reader's tests run there); `process-checks` runs for the docs. Nothing is started by hand.

**5. Diego's own check, after the merge** (his app, his dial, his eye; no tester or agent runs it): his three Code sessions show on the dial's Claude page, two idle; a tap on one opens it in the app.

**6. Against production:** none.
