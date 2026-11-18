# Dial: an agent's notice outlives a restart of the devices process — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(dial): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message.

**Goal:** A pending notice (`harness device notify`) is back in the dial's drawer after the devices process restarts, under the same card id, as a silent row: never asked again, never older than 24 hours, and not shown when its agent is gone or already in another turn.

**Architecture:**
- **The file** (`cli/src/cable/noticeFile.ts`, new, after `notifyMode.ts`): `dial-notices.json` in the daemon's data dir, read once and bounded at the start, written whole and renamed, one write a second at most.
- **The desk** (`cli/src/cable/notices.ts`): each card carries its agent's keys and the time it was shown; the cards of the file come back marked restored (a drawer row only), wait for their agent to be listed, and end when it is first seen in a turn.
- **The wiring** (`cli/src/services/devices.ts`): the file and the desk are joined, the stop freezes the file before its own detach, and the desk is shown the lists as they change (the outside lists' change, each read of the core's agents) and a Harness agent's running turn.
- **The held question** (`cli/src/cable/questionInbox.ts`, `cableSession.ts`, `cableFleet.ts`): each dial's cable session holds a restored card's question without asking it (`hold`), so opening its row on the dial reads the line; a held question is never asked for its whole life, on any dial, one plugged in later included.
- Devices process only. Nothing in `cli/src/core`, no request, no record, no new frame; `cableSession.replaceNotifications` and the firmware are not touched.

**Tech Stack:** TypeScript daemon (Node, vitest), `cli/`.

**Spec:** `docs/plans/2026-11-18-dial-notices-restart-design.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` (Protect the core) and `cli/src/services/AGENTS.md`.

## Base

- Branch `fix/dial-notices-restart`, at `03a6f95a0e`, worktree `/Users/nqhieu84/orca/workspaces/openharness/dial-notices-restart`.
- **Before the first task, once:** `cd cli && npm ci --no-audit --no-fund` (this worktree's `cli/` has no `node_modules`). One process runs it, never two tasks at once.
- Names at the base (the tasks name functions, never lines):
  - `cable/notices.ts`: `Notices` (`notify`, `ended`, `reask`, `attached`, `detached`, `rows`, `pending`, `from`), `NoticesDeps`, `NoticeCaller`, `NOTICES_PENDING_MAX`, `LINE_MAX_BYTES`, `Pending`. `cable/notifyMode.ts`: `NotifyModeStore`, `readMode` (the pattern). `cable/cableSession.ts`: `SHOWN_ONLY_PREFIX`, `CableSession.question`, `questionClose`, `owedQuestions`, `resendQuestions`, `owed`, `liveTurns`, the `question.read` case. `cable/questionInbox.ts`: `QuestionInbox` (`set`, `open`, `ask`, `forget`, `close`, `read`), `Entry`. `cable/cableFleet.ts`: `Surface`, `send`, the fan-out methods (`question`, `questionClose`), and in the scan the `attached` closure that gives a dial plugged in beside another its sibling's `owedQuestions()`.
  - `services/devices.ts` (`startDevices`): `part`, `timerIn`, `noticeCaller`, `notices`, `endNotice`, `reaskNotice`, `outsideEntries`, `busyState`, `outsideTurn`, `told`, `showWaits`, `dialAttached`, `toCable`, the cable host's wiring (`refresh: deps.refresh`, `noticeRows`), `startFleet(… refresh: deps.refresh)`, `port.stop` (`stopped = true`), `port.unread`.
  - Spec helpers: `notices.spec.ts` `desk`, `Call`, `notice`, `VPN`. `notifyMode.spec.ts` `aFolder`. `questionInbox.spec.ts` `question`, `read`. `cableSession.spec.ts`, in `describe('hello capabilities')`: `connect`, `richHost`, `PRO_HELLO`, `ofType`, `settle`, and the test `answers resync with machines, swarms, agents, notices and open questions, at most once per 2 s` (how a resync is driven). `cableFleet.spec.ts`, in `describe('a dial plugged in beside one already attached')`: `firstAlone`, `plugSecond`, `questions`, `flush`, `notice`, `noticeId`, and `Peer.say`. `devices.spec.ts` `FakeCable` (the mocked `CableFleet`, one `recorder` per method). `devices.spec.ts` `start`, `calls`, `seen`, `logs`, `dataDir`, `readers`, `fakeListener`, `fakeCore`, and inside `describe('an agent\'s notice …')`: `LINE`, `ID`, `hook`, `card`, `host`, `bound`, `devices`, `ids`, and the herdr client of `an agent herdr alone lists is tied by its session …`. `e2e/deviceNotify.e2e.ts` `fresh`, `plugged`, `startOutside`, `listed`, `notify`, `create`, `LINE`; `e2e/harness/desk.ts` `devicesPids`; `e2e/harness/daemon.ts` `until`.
- If a name differs at the base, the implementer follows the code and says so in its report.
- The spec and this plan are untracked. The main session commits them; no task does. The spec's `Reviewed revision / Reviewer` line is the main session's to fill.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The file of pending notices | `cli/src/cable/noticeFile.ts` (new), `noticeFile.spec.ts` (new), `cli/src/cable/notices.ts` (exports only) | none | xhigh | `noticeFile.spec.ts` |
| 2 A pending notice is kept in the file | `cli/src/cable/notices.ts`, `notices.spec.ts`, `cli/src/services/devices.ts`, `devices.spec.ts` | 1 | high | `notices.spec.ts`, `devices.spec.ts` |
| 3 The cards of the file come back, silent | same four files | 2, 6 | high | `notices.spec.ts`, `devices.spec.ts` |
| 4 A restored card finds its agent, or goes | same four files, `cli/e2e/deviceNotify.e2e.ts` | 3 | xhigh | `notices.spec.ts`, `devices.spec.ts`, `e2e/deviceNotify.e2e.ts` |
| 5 Docs | `cli/AGENTS.md`, `docs/cli.md` | none | medium | none (docs, one commit) |
| 6 A cable session holds a question it never asks | `cli/src/cable/questionInbox.ts`, `questionInbox.spec.ts`, `cableSession.ts`, `cableSession.spec.ts`, `cableFleet.ts`, `cableFleet.spec.ts` | none | high | `questionInbox.spec.ts`, `cableSession.spec.ts`, `cableFleet.spec.ts` |

Longest chain: 1 → 2 → 3 → 4, four tasks. Tasks 5 and 6 share no file with any other task and start at once; Task 6 runs beside Tasks 1 and 2, and Task 3 waits for it.

- Tasks 2, 3 and 4 each change the desk and its wiring together: a new member of `NoticesDeps` must be passed in `devices.ts` in the same commit, or `npm run typecheck` is red. They share those files, so they run one after another.
- Task 6 is numbered last only so the earlier tasks keep their numbers; it adds `CableSession.hold`, which Task 3's wiring calls.
- The file's tests are in `cable/noticeFile.spec.ts`, beside the module, as `notifyMode.ts` has `notifyMode.spec.ts`: the same layer the spec names (`cable/`), in a file of its own so the desk stays one responsibility.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/noticeFile.ts`, `notices.ts` | **Devices service process** only | their specs (PR CI `cli-tests`) |
| `cli/src/cable/questionInbox.ts`, `cableSession.ts`, `cableFleet.ts` | **Devices service process** (the dial's link) | their specs (PR CI `cli-tests`) |
| `cli/src/services/devices.ts` | **Devices service process** | 100% per file (`npm run test:core`, local) |
| `cli/e2e/deviceNotify.e2e.ts` | end to end, the real daemon | local run and the CLI end to end workflow |
| `cli/AGENTS.md`, `docs/cli.md` | Docs | review |

Not changed, and a diff in any is a finding: anything under `cli/src/core/`, `cli/src/architecture.coreFiles.txt`, `cli/src/cable/cableHost.ts`, `cli/src/lib/dialNotice.ts`, `cli/src/services/devicesListener.ts`, `devicesProcess.ts`, `devices/` (firmware), `desktop/`, `mobile/`, `device-app/`; in `cableSession.ts`, any line of `replaceNotifications`, `resendQuestions`, `owed`, `question`, `owedQuestions`, the `question.read` case or the frames they send (Task 6 adds the method `hold` and nothing else there).

## Global Constraints

- **The file.** `dial-notices.json` in `core.dataDir`. `{ "v": 1, "cards": [ { agentId, keys, id, line, host, who?, at } ] }` and a newline, oldest first, at most `NOTICES_PENDING_MAX` (20). Written to `<file>.<pid>.tmp` (`0600`) and renamed. An empty set writes `"cards":[]` (the builder's call: one path, no unlink).
- **Read once, bounded.** At most 32 KiB (`NOTICES_FILE_MAX_BYTES`), one byte more read to tell a longer file. Missing: empty, no line. Dropped whole with one line `[device] notices · file dropped · <reason>`, the reason one of `long`, `json`, `version`, `shape`, `unreadable` (`unreadable` is this plan's word for a read error other than a missing file). `load()` never throws.
- **A card's shape** (reader and writer use one check): `agentId` 1 to 64 letters; `keys` 0 to 4 strings of 1 to 160 letters; `id` starts with `shown:`, at most 64 letters; `line` 1 to 239 bytes; `host` at most 32 letters; `who` absent or `{ name (1 to 256), engine (at most 32), machine (at most 256) }`; `at` a safe integer, 0 or more; no two cards with one `agentId`. Unknown fields are ignored and not carried.
- **Coalesced.** `NOTICES_WRITE_MS = 1_000`: a write is scheduled on the first change and carries the set as it is when it runs. A failed write: `[device] notices · not saved · <code>` (the error's code, else `FAILED`), memory stays, the next change schedules again.
- **A stop is not an ending.** `port.stop()` closes the file first: what was waiting is written, and nothing after it, so neither the stop's detach nor a listing source's emptied list reaches the file.
- **Keys.** `<engine>:<sessionId>` when the agent has a session id, then its `paneKeys`, as its list entry held them when the notice was shown; none for a `who` card.
- **24 hours.** `NOTICE_RESTORE_MAX_MS = 24 * 3_600_000`, by `at` and the wall clock, checked on restore only. A live card has no cap.
- **Restored means silent, for good.** No `cable.question` for a restored card, at the start, on an attach or on `reask`. It is a row of `Notices.rows`, and its question is held (`cable.hold`) by every dial's cable session, so opening the row reads its line, never "No readable question. Check the terminal.".
- **Held, never asked.** A held question sends no frame when it is held, and no `question` frame ever after: not at a greeting, a drawer replace or a resync (`forget`, `resendQuestions`), not by `ask`, and not to a dial plugged in later (`owedQuestions` carries it as held, and the fleet holds it there). A later question of that agent replaces it as any question does; the card's `question.close` removes it. No new frame, no firmware change: the dial already sends `question.read` when a question row is opened (`open_question`, `ui_habitat.c`).
- **Held until listed.** No row until its agent is listed: a Harness card (`host === 'harness'`) among `core.agents.advertised()`, any other on `outsideEntries()`. A `who` card is not held. Held cards count toward the 20.
- **First seen in a turn, it ends.** An outside agent listed busy (`working` or `needs-you`) the first time it is found; a Harness agent at the first `processing` card heard.
- **Logs.** `[device] notices · restored <n> · aged out <m>` once at the start when the file held cards. No line holds the text, an agent id, a session id, a key or a path.
- **Limits start fresh** (`NoticeLimits` is not kept).
- **Rule 7.** No file under `cli/src/core` changes.
- **No fixed sleeps:** an injected timer in `noticeFile.spec.ts`, an injected clock in `notices.spec.ts`, `vi.useFakeTimers()` in `devices.spec.ts`, `until` in the end-to-end test.

## The restored row is sent `question: true`

As `Notices.rows` sends a live card's row. Checked against the code this branch must not touch; it does not depend on the dial-notice-loss pull request.

- **Text.** `cableSession.replaceNotifications` sends a question row's text as it is. A `question: false` row under 20 letters is looked up in the agent's recaps and may be extended.
- **Life.** The firmware keeps a question row until its `question.close`. A `question: false` row is news: it goes after 6 hours (`NOTICE_TTL_MS`) and on `notif.seen` (the window looking at the agent), and `replaceNotifications` drops it when a `notif.seen` races the replace, all while the card is still pending.
- **Silence.** `notif.replace` never beeps, wakes or lights (`ui_notif_replace`); only a `question`, an alert `summary` and `turn.error` do. The row is silent with either flag.
- **Its ending needs nothing new.** `Notices.ended` → `deps.close` → `cable.questionClose` → `question.close`: `questionInbox.close` removes the held entry (and lets a close through for an id the session never held, a dial that attached after the card ended), and the firmware's `ui_question_close` removes the agent's row (`notice_remove(id, true)`). So a restored card ends as a live one, with no drawer replace of its own.
- **Its question view.** Opening the row sends `question.read`; the session answers from its inbox (`QuestionInbox.read`), which holds the card's question (Task 6, held by Tasks 3 and 4): the dial shows the line and "In <app>", as for a live card.
- **The other pull request** is about question rows the new drawer does not carry. A restored row is in every drawer (`Notices.rows`), so neither merge order changes it.

## Decisions (harness-pm, 2026-11-18)

1. **Drawer replaces this branch adds: accepted.** A card found, or a covered restored row coming back, calls `cable.replaceNotifications(cableHost.listUnread())` outside an attach. On today's code any replace drops a Harness agent's open real question row until it is asked again, which is the bug dial-notice-loss fixes. This pull request merges on its own; whichever of it and the dial-notice-loss pull request merges second rebases and keeps both fixes.
2. **Session-first matching: accepted.** An agent that names a session is found by its session alone; a pane key finds only an agent that names none. A card never moves to another session in the same pane; it waits and ages out.
3. **A restored row opens to its line, in this pull request.** Each dial's cable session holds the card's question without asking it (Task 6, about 15 changed lines, no new frame, no firmware change); Tasks 3 and 4 hold it where they would otherwise ask nothing.

## Review Focus

1. **Another session in the same pane** (a `/clear`, or a new agent in that herdr or cmux pane, before the list comes back): the card must not show on it. Pinned in Task 4 (`another session in the same pane is not its agent`).
2. **A second notice while the restored card still waits under its old id** (a listing source's new random id): one card an agent, the new one rings, nothing is moved onto it later. Pinned in Task 4 (`a new notice from an agent whose restored card waits under another id ends that card`).
3. **A file from another build, or a clock that moved:** unknown fields, two cards for one agent, a card whose `at` is ahead of the clock. Pinned in Task 1 (`unknown fields are ignored`, the `shape` table) and Task 3 (`one ahead of the clock too`).
4. **The stop empties herdr's, Herdr's, cmux's and opencode's lists**, which ends their cards in memory as an agent leaving does: the file must keep them. Pinned in Task 2 (`neither its detach nor herdr's emptied list is written`).
5. **The dial says hello before the core's agents are read** (a devices process that just started): the attach's drawer has no Harness row, and it must come with the next list read, not the next plug-in. Pinned in Task 4 (`a Harness agent's restored row comes with the list that first names it`).

---

### Task 1: The file of pending notices

**Layer:** devices service process. **Depends on:** none. **Effort:** `xhigh` (stored data: format, bounded read, atomic write).

**Red test:** `cli/src/cable/noticeFile.spec.ts`.

**Files:**
- Create: `cli/src/cable/noticeFile.ts`
- Test: `cli/src/cable/noticeFile.spec.ts`
- Modify: `cli/src/cable/notices.ts` (exports only: the type and three constants below; `LINE_MAX_BYTES` is renamed and exported; no behavior changes)

**Interfaces:**
- Produces in `notices.ts`:
  - `export interface StoredNotice { agentId: string; keys: string[]; id: string; line: string; host: string; who?: { name: string; engine: string; machine: string }; at: number }`, doc: a pending card as `dial-notices.json` keeps it; `at` is the wall-clock ms it was shown.
  - `export const NOTICE_LINE_MAX_BYTES = 239` (was `LINE_MAX_BYTES`), `export const NOTICE_KEYS_MAX = 4`, `export const NOTICE_KEY_MAX_CHARS = 160`.
- Produces in `noticeFile.ts` (imports from `notices.ts` and `cableSession.ts`; `notices.ts` never imports it):
  - `export const NOTICES_FILE = 'dial-notices.json'`, `NOTICES_FILE_MAX_BYTES = 32 * 1024`, `NOTICES_WRITE_MS = 1_000`.
  - `export interface NoticeFileDeps { file: string; cards(): readonly StoredNotice[]; after(ms: number, run: () => void): () => void; log(line: string): void }`. `cards` is read as a write runs; `after` answers its cancel.
  - `export class NoticeFile { constructor(deps: NoticeFileDeps); load(): StoredNotice[]; changed(): void; close(): void }`.
    - `load()`: Global Constraints "Read once, bounded" and "A card's shape"; read with `openSync`/`readSync`/`closeSync` as `readMode` does; each card built from its known fields.
    - `changed()`: nothing when a write is already scheduled or the file is closed; else `after(NOTICES_WRITE_MS, write)`.
    - `close()`: a scheduled write is cancelled and run now; from then on `changed()` does nothing. Twice is once.
    - The write: `cards()` without those that fail the shape; while the text is over `NOTICES_FILE_MAX_BYTES`, the oldest card is left out; temp file `0600`, rename; on an error the temp file is removed and the line of "Coalesced" is logged.

Helpers for the spec: `aFolder` as `notifyMode.spec.ts`; `timers()` giving `after` and a `pending` list of `{ ms, run, cancelled }`; `card(n, over)` = `{ agentId: 'a<n>', keys: ['claude:s<n>'], id: 'shown:k<n>', line: 'Line <n>', host: 'orca', at: 1_000 + n, ...over }`; `store(cards)` building a `NoticeFile` over a mutable array and collecting `logs`. `WHO = { name: 'api', engine: 'codex', machine: 'Mac mini' }`.

- [ ] **Step 1: Write `noticeFile.spec.ts`,** `describe('the file of pending notices')`:
  - `no file reads as none, and says nothing`: `load()` is `[]`, `logs` is `[]`.
  - `a set is written whole a second after its first change, and read by the next start`: `changed()`; `pending` is one entry with `ms: 1_000` and no file exists; run it; the text is exactly `` `${JSON.stringify({ v: 1, cards: [card(1), card(2, { who: WHO })] })}\n` ``; off Windows its mode is `0o600`; `readdirSync(folder)` is `[NOTICES_FILE]`; a new store's `load()` equals the two cards.
  - `changes that come close together are one write, of the set as the write runs`: three `changed()` give one `pending` entry; push `card(3)`; run; the file holds three cards; `changed()` schedules a second entry.
  - `close writes what waits and nothing after; with nothing waiting it writes nothing`: `changed()`, `close()`: the entry is `cancelled`, the file holds the set; push a card, `changed()`: no new entry, file unchanged; `close()` again writes nothing. A fresh store's `close()` leaves no file.
  - `an empty set is an empty list`: the text is `'{"v":1,"cards":[]}\n'`.
  - `it.each` `a %s file is dropped whole, in one line with the reason alone`: `load()` is `[]`, `logs` is `['[device] notices · file dropped · <reason>']`, then `changed()` and its run leave a good file. Rows:
    - `json`: `'{not json'`, `''`.
    - `version`: `'{"v":2,"cards":[]}'`, `'{"cards":[]}'`, `'[]'`, `'null'`, `'7'`.
    - `shape`: `'{"v":1}'`, `'{"v":1,"cards":{}}'`, 21 cards, two cards with `agentId: 'a1'`, a card `null`, and `card(1)` with each of: `agentId` `''`, 65 letters, `7`; `keys` `'claude:s1'`, five keys, `['']`, a key of 161 letters, `[7]`; `id` `'k1'`, 65 letters starting `shown:`; `line` `''`, `'é'.repeat(120)` (240 bytes); `host` 33 letters, `null`; `who` `'api'`, `{ name: 'api', engine: 'codex' }`, `{ ...WHO, name: '' }`; `at` `-1`, `1.5`, `'1'`.
  - `a file at 32 KiB is read, one byte longer is not`: a valid file padded with spaces to exactly `NOTICES_FILE_MAX_BYTES` loads its cards; one more space gives `[]` and `file dropped · long`.
  - `unknown fields are ignored and not carried`: `{ v: 1, extra: true, cards: [{ ...card(1), color: 'red' }] }` loads `[card(1)]`.
  - `a path that cannot be read is dropped as unreadable; a write there says the error's code and the next change tries again`: `mkdirSync(file)`; `load()` is `[]` with `file dropped · unreadable`; `changed()`, run: `logs` gains `'[device] notices · not saved · EISDIR'`, `readdirSync(folder)` is `[NOTICES_FILE]`; `changed()` schedules again.
  - `a card that fails the shape is left out of a write`: cards `[card(1), card(2, { line: 'x'.repeat(240) })]` write a file whose `load()` is `[card(1)]`.
  - `a set too long for the file leaves its oldest cards out until it fits`: 20 cards with `line: '"'.repeat(239)`, four keys of 160 letters and a `who` of 256 quotes in `name` and `machine`: the file is at most `NOTICES_FILE_MAX_BYTES`, a new store loads it with no line, and what it loads is the tail of the 20.
  - `no line holds the path or what a card says`: across the cases above no line contains the folder, `'Line 1'` or `'claude:s1'`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/noticeFile.spec.ts`. Expected: FAIL (no module `./noticeFile.js`).
- [ ] **Step 3: Commit** `test(dial): the file of pending notices (red)`.
- [ ] **Step 4: Implement** `noticeFile.ts` and the exports in `notices.ts` (Interfaces above). The header comment says why the file exists and that the devices process is its one writer, as `notifyMode.ts`'s does.
- [ ] **Step 5: Run** `cd cli && npx vitest run src/cable/noticeFile.spec.ts src/cable/notices.spec.ts src/architecture.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `dial: the file of pending notices`.

### Task 2: A pending notice is kept in the file

**Layer:** devices service process. **Depends on:** 1 (`NoticeFile`, `StoredNotice`, the constants). **Effort:** `high` (`services/devices.ts` is in the 100% gate).

**Red tests:** `cli/src/cable/notices.spec.ts`, `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/cable/notices.ts`
- Test: `cli/src/cable/notices.spec.ts`
- Modify: `cli/src/services/devices.ts`
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `NoticeFile`, `NOTICES_FILE`, `StoredNotice`, `NOTICE_KEYS_MAX`, `NOTICE_KEY_MAX_CHARS` (Task 1).
- Produces in `notices.ts`:
  - `NoticeCaller.keys: readonly string[]` (Global Constraints "Keys").
  - `NoticesDeps.clock(): number` (wall-clock ms; `now` stays the limits' monotonic clock) and `NoticesDeps.changed(): void` (the pending set changed).
  - `export function noticeKeys(agent: { engine: string; sessionId?: string; paneKeys?: readonly string[] }): string[]`: `<engine>:<sessionId>` first when `sessionId` is not empty, then the pane keys in order; a key over `NOTICE_KEY_MAX_CHARS` is left out; at most `NOTICE_KEYS_MAX`.
  - `Notices.stored(): StoredNotice[]`: every pending card, oldest first, a new array each call; `who` only on a card that has one.
  - A card takes `keys` from its caller and `at: deps.clock()`. `deps.changed()` is called by a `notify` that shows, after the card is set, and by an `ended` that removed a card; by nothing else.
- Produces in `devices.ts`:
  - `noticeCaller` answers `keys`: `[]` for both `who` callers, `noticeKeys(own)` for a Harness agent, `noticeKeys(entry.agent)` for an outside one.
  - `const noticeFile = new NoticeFile({ file: join(core.dataDir, NOTICES_FILE), cards: () => notices.stored(), after: timerIn('notices'), log })`, built before `notices`; `notices` gets `clock: Date.now` and `changed: () => noticeFile.changed()`.
  - `port.stop`: `part.call('notices', () => noticeFile.close())` right after `stopped = true`, with the comment of Global Constraints "A stop is not an ending".

In `notices.spec.ts`, `desk` takes `keys?: Record<string, string[]>` and `clock?: number`, passes `keys: opts.keys?.[agentId] ?? []` from `resolve`, `clock: () => state.clock`, and counts `changed` in `state.changes`.

- [ ] **Step 1: Write the desk tests in `notices.spec.ts`:**
  - `a card is stored with its agent's keys, its line, its host and when it was shown`: `desk({ keys: { a1: ['claude:s1', 'herdr:w1:p1'] }, clock: 5_000 })`, `state.at = 99`; after `notify`, `stored()` equals `[{ agentId: 'a1', keys: ['claude:s1', 'herdr:w1:p1'], id: 'shown:u1', line: VPN, host: 'orca', at: 5_000 }]`. With `who`, the card has it and `keys: []`.
  - `the stored cards are oldest first, a replaced card last`: `a1`, `a2`, then `a1` again after `state.at = 61_000`: `stored().map((c) => c.agentId)` is `['a2', 'a1']`.
  - `each change of the pending set is told, and nothing else is`: `state.changes` grows on a shown notice, on `ended` of a card, on `detached` ending a Harness card and on the twenty-first card; it stays on `limited`, `no dial`, `ended` of no card, `reask`, `attached`, `rows`, `pending`, `from`, `stored`.
  - `noticeKeys names the session first, then the panes, bounded`: `{ engine: 'claude', sessionId: 's1', paneKeys: ['herdr:w1:p1'] }` gives `['claude:s1', 'herdr:w1:p1']`; no session gives the panes; neither gives `[]`; six pane keys give four keys; a key of 161 letters is left out.
- [ ] **Step 2: Write the wiring tests in `devices.spec.ts`,** in a `describe('outlives a restart of the devices (docs/plans/2026-11-18-dial-notices-restart-design.md)')` nested in `describe('an agent\'s notice …')`. Helpers: `FILE = () => join(dataDir, 'dial-notices.json')`, `saved = () => JSON.parse(readFileSync(FILE(), 'utf8'))`, `T = Date.parse('2026-11-18T03:00:00Z')`; each test `vi.useFakeTimers()` and `vi.setSystemTime(T)`.
  - `a notice shown is in the file a second later, with its agent's keys`: `port.observed(hook('session-start'))`, the notice; `existsSync(FILE())` is false; `vi.advanceTimersByTime(1_000)`; `saved()` equals `{ v: 1, cards: [{ agentId: ID, keys: ['claude:sess-1'], id: ids()[0], line: LINE, host: 'orca', at: T }] }`.
  - `a Harness agent's card and a caller no list holds are kept too`: `devices({ core: bound() })`, a notice for `s-h1` and one `{ engine: 'codex', sessionId: 't-9', folder: 'api' }`; the cards are `{ agentId: 'h1', keys: ['claude:s-h1'], host: 'harness', … }` and `{ agentId: observedAgentId('codex', 't-9'), keys: [], host: '', who: { name: 'api', engine: 'codex', machine: 'This machine' }, … }`.
  - `a card that ends leaves the file`: after the first test's state, `port.observed(hook('turn-start'))`, advance 1 s: `saved().cards` is `[]`.
  - `a stop writes what was waiting; neither its detach nor herdr's emptied list is written` (Review Focus 4): `bound()` and the herdr client of the existing herdr test, its agent `agent_status: 'idle'`, listed as that test lists it (`seen.host.watching!(true)`, `port.swarms(null)`, `subs[0].started()`, `await list`); a notice for `s-h1` and for `sess-h`; `await port.stop()` with no timer advanced; `saved().cards.map((c) => c.agentId)` is `['h1', id]`, the herdr card's `keys` are `['claude:sess-h', 'herdr:w1:p1']`, `calls('questionClose')` holds both cards' closes; `vi.advanceTimersByTime(10_000)` leaves the file as it is.
  - `a write that fails is one line with the error's code`: `mkdirSync(FILE())` before `devices()`; the notice answers `shown`; advance 1 s; `logs` contains `'[device] notices · not saved · EISDIR'`, and no line contains `'dial-notices'`, `'VPN'` or `'sess-1'`.
- [ ] **Step 3: Run** `cd cli && npx vitest run src/cable/notices.spec.ts src/services/devices.spec.ts -t 'stored|told|noticeKeys|outlives a restart'`. Expected: FAIL (`stored` and `noticeKeys` are not there; no file is written).
- [ ] **Step 4: Commit** `test(dial): a pending notice is kept in the file (red)`.
- [ ] **Step 5: Implement** the desk and the wiring (Interfaces above).
- [ ] **Step 6: Run** `cd cli && npx vitest run src/cable/notices.spec.ts src/cable/noticeFile.spec.ts src/services/devices.spec.ts && npm run typecheck`. Expected: PASS, every older notice test with no edit but `desk`'s new members.
- [ ] **Step 7: Commit** `dial: a pending notice is kept in the file`.

### Task 3: The cards of the file come back, silent

**Layer:** devices service process. **Depends on:** 2 (`stored()`, `changed`, `clock`, the file's wiring), 6 (`CableSession.hold`, `CableFleet.hold`). **Effort:** `high`.

**Red tests:** `cli/src/cable/notices.spec.ts`, `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/cable/notices.ts`
- Test: `cli/src/cable/notices.spec.ts`
- Modify: `cli/src/services/devices.ts`
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `CableFleet.hold(agentId: string, id: string, questions: unknown): Promise<void>` (Task 6).
- Produces in `notices.ts`:
  - `export const NOTICE_RESTORE_MAX_MS = 24 * 3_600_000`.
  - `NoticesDeps.restored: readonly StoredNotice[]` (the file's cards at the start; the method `stored()` keeps its name), `NoticesDeps.log(line: string): void`, `NoticesDeps.redraw(): void` (a row changed with no question frame to carry it: the dial's drawer is replaced), `NoticesDeps.hold(agentId: string, id: string, questions: unknown): void` (the card's question to every dial, held for its row to open, never asked).
  - `noticeQuestions(line: string, host: string)` (module-private): `[{ key: 'notice', q: line, options: [`In ${hostDisplayName(host)}`] }]`, used by `notify` and by the restore, so a restored card's question is the live one's, rebuilt from `line` and `host` (the spec: never stored).
  - The constructor: each card of `deps.restored` with `clock() - at > NOTICE_RESTORE_MAX_MS` is dropped; every other is pending under its `agentId`, in order, with its `questions` rebuilt, marked restored, and waiting for its agent unless it has `who`. It logs `[device] notices · restored <n> · aged out <m>` when `deps.restored` is not empty, and calls `changed()` when a card aged out. It asks, holds and closes nothing.
  - A restored card is never passed to `deps.ask`. For one that is not waiting and not covered by another question of its agent (`deps.held`): `attached()` calls `deps.hold` (no redraw: the attach's greeting replaces the drawer itself); `reask(agentId)` calls `deps.hold`, then `deps.redraw()`. On one waiting or covered, both do nothing.
  - `rows()` leaves out a waiting card, as it leaves out a held one; a restored row is `{ agentId, machineId, question: true, text: line }`.
  - `ended`, `detached`, the twenty-first card, `pending`, `from` and `stored` treat a restored card as any card (its `close` removes the held question too). A `notify` of its agent ends it and makes a live one.
- Produces in `devices.ts`: `notices` gets `restored: noticeFile.load()`, `log`, `redraw: () => { void cable.replaceNotifications(cableHost.listUnread()) }`, and `hold: (agentId, id, questions) => inOrder(agentId, () => { void cable.hold(agentId, id, questions) })` (in its agent's order, as `ask` is).

In `notices.spec.ts`: `Call` gains `['hold', string, string, unknown]`; `desk` takes `restored?: StoredNotice[]` (default `[]`), collects `logs`, counts `redraw` in `state.redraws`, and pushes `['hold', agentId, id, questions]` for `hold`. `asked(host) = [{ key: 'notice', q: VPN, options: [`In ${host}`] }]`. In `devices.spec.ts`, `FakeCable` gains `hold = recorder('hold')`. `NOW = 1_800_000_000_000`, `DAY = 24 * 3_600_000`, `kept(over) = { agentId: 'a1', keys: ['claude:s1'], id: 'shown:k1', line: VPN, host: 'orca', at: NOW - 60_000, ...over }`, `WHO = { name: 'api', engine: 'codex', machine: 'Mac mini' }`, `asWho = kept({ agentId: 'w1', id: 'shown:k2', keys: [], host: '', who: WHO })`, `back(cards, over) = desk({ restored: cards, clock: NOW, ...over })`.

- [ ] **Step 1: Write the desk tests,** `describe('Notices after a restart')`:
  - `a card of the file is pending again under its id, and nothing is asked`: `back([kept()])`: `calls` is `[]`, `pending('a1')`, `stored()` equals `[kept()]`; after `attached()` and `reask('a1')` (it waits for its agent), `calls` is `[]` and `redraws` is 0.
  - `a restored card of a caller no list holds is a drawer row at once; any other waits for its agent`: `back([kept(), asWho])`: `rows('m')` equals `[{ agentId: 'w1', machineId: 'm', question: true, text: VPN }]`, `from('w1')` equals `WHO`.
  - `a restored row's question is held as a dial attaches, never asked, so opening the row reads its line`: `back([kept(), asWho])`, `attached()`: `calls` equals `[['hold', 'w1', 'shown:k2', asked('Terminal')]]` (no `ask`, nothing for the waiting `a1`), `redraws` 0.
  - `a card older than 24 hours is dropped, one of exactly 24 hours is kept, and one ahead of the clock too` (Review Focus 3): `at` of `NOW - DAY - 1`, `NOW - DAY`, `NOW + 60_000` under three ids: `stored()` holds the last two, `calls` is `[]`.
  - `the start says the counts in one line, and tells the file when a card aged out`: that desk's `logs` is `['[device] notices · restored 2 · aged out 1']` and `changes` is 1; `back([kept()])` logs `restored 1 · aged out 0` with `changes` 0; `back([])` logs nothing; no line contains `VPN`, `'a1'` or `'claude:s1'`.
  - `a restored row another question covered comes back held, by a drawer replace, never an ask`: `back([kept(), asWho])`, `held.add('w1')`: `rows('m')` is `[]`, `attached()` and `reask('w1')` leave `calls` `[]` and `redraws` 0; `held.delete('w1')`, `reask('w1')`: `calls` is `[['hold', 'w1', 'shown:k2', asked('Terminal')]]`, `redraws` 1; `reask('a1')` (waiting) adds nothing.
  - `a restored card ends as any card: closed under its id, once`: `ended('w1')` gives `[['close', 'w1', 'shown:k2']]` and one more change; again, nothing.
  - `a new notice of its agent rings and takes its place`: `back([kept()])`, `notify(notice(VPN, 'a1'))` is `shown`; `calls.map((c) => [c[0], c[2]])` is `[['close', 'shown:k1'], ['ask', 'shown:u1']]`; `attached()` asks `shown:u1` again and holds nothing.
  - `restored cards count toward the twenty, waiting or not`: twenty `kept` cards `a1`…`a20`; a notice of `a21` closes `a1` under `shown:k1` and `stored()` has 20.
  - `the last dial going ends a restored Harness card and leaves the others`: `kept({ agentId: 'h1', host: 'harness' })` and `asWho`: `detached()` closes `h1` alone.
- [ ] **Step 2: Write the wiring tests,** in Task 2's `describe`. `again(first, over)` awaits `first.port.stop()` and answers `devices(over)`: the same `dataDir`, a new cable in `seen.cable` (the first process's later stop, from `onTestFinished`, writes nothing: its file is closed). `ringing = () => seen.cable.calls.filter(([name]) => name === 'question' || name === 'summary' || name === 'turnError')`.
  - `a restart puts the row of a caller no list holds back in the drawer, with no question and no alert, and holds the question its row opens to` (harness-pm's required test; the dial's own read of it is Task 6's session test and Task 4's end-to-end test): a notice `{ engine: 'codex', sessionId: 't-9', folder: 'api' }`, its card id `first` (`calls('question')[0][1]`), then `again`; `seen.host.watching!(true)`, `port.unread([])`: `calls('replaceNotifications').at(-1)` is `[[{ agentId: observedAgentId('codex', 't-9'), machineId: 'machine-1', question: true, text: LINE }]]`, `ringing()` is `[]`, `calls('hold')` equals `[[observedAgentId('codex', 't-9'), first, [{ key: 'notice', q: LINE, options: ['In Terminal'] }]]]`, `host().describe(that id)` names it `api`, and `logs` contains `'[device] notices · restored 1 · aged out 0'`.
  - `a card older than 24 hours is not restored, and leaves the file`: write `FILE()` with that card and `at: T - 24 * 3_600_000 - 1`; `devices()`: `host().listUnread()` is `[]`, `logs` contains `restored 0 · aged out 1`; advance 1 s: `saved().cards` is `[]`.
  - `a bad file never stops the devices: one line, and the next notice replaces it`: write `'{not json'`; `devices()` does not throw; `logs` contains `'[device] notices · file dropped · json'`; a notice is `shown`; advance 1 s: `saved().cards` has one card.
  - `only a new notice of that agent rings again, at once, and takes the restored card's place`: after the first test's restart, the same caller and line again answer `shown` (the limits start fresh); `calls('questionClose')` is `[[id, the restored card's id]]` and `calls('question')` has one ask under a new id.
  - `a restored row comes back by a drawer replace as the wait that covered it closes`: process A with no hook for `sess-1` (a `who` card under `ID`); `again`; `port.observed(hook('needs-input'))`, the `asked` event of the existing `its card goes when that agent's next turn starts` test, then `port.observed(hook('turn-stop'))` and `await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)`: the last `replaceNotifications` holds `{ agentId: ID, machineId: 'machine-1', question: true, text: LINE }`, `calls('hold').at(-1)` is `[ID, the card's id, …]` (its question held again, after the wait's own question replaced it in the session), and no `question` call carries the card's id.
- [ ] **Step 3: Run** `cd cli && npx vitest run src/cable/notices.spec.ts src/services/devices.spec.ts -t 'after a restart|outlives a restart'`. Expected: FAIL in the new tests (nothing is restored).
- [ ] **Step 4: Commit** `test(dial): the cards of the file come back as silent rows (red)`.
- [ ] **Step 5: Implement** the desk and the wiring (Interfaces above). The comment on the restored mark says why it never rings: it rang before the restart (harness-pm, 2026-11-18).
- [ ] **Step 6: Run** `cd cli && npx vitest run src/cable/notices.spec.ts src/cable/noticeFile.spec.ts src/services/devices.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 7: Commit** `dial: the cards of the file come back as silent rows`.

### Task 4: A restored card finds its agent, or goes

**Layer:** devices service process, and end to end. **Depends on:** 3 (the restored and waiting cards, `redraw`). **Effort:** `xhigh` (an agent's identity across a restart, and the order inside the list handlers).

**Red tests:** `cli/src/cable/notices.spec.ts`, `cli/src/services/devices.spec.ts`, `cli/e2e/deviceNotify.e2e.ts`.

**Files:**
- Modify: `cli/src/cable/notices.ts`
- Test: `cli/src/cable/notices.spec.ts`
- Modify: `cli/src/services/devices.ts`
- Test: `cli/src/services/devices.spec.ts`
- Test: `cli/e2e/deviceNotify.e2e.ts`

**Interfaces:**
- Produces in `notices.ts`:
  - `export interface ListedAgent { agentId: string; session?: string; panes: readonly string[]; busy: boolean }`: an agent on a list the devices hold; `session` is its `<engine>:<sessionId>`; `busy` is in a turn as listed.
  - `export function listedAgent(agentId: string, agent: { engine: string; sessionId?: string; paneKeys?: readonly string[] }, busy: boolean): ListedAgent`, naming the session exactly as `noticeKeys` does.
  - `Notices.look(harness: boolean, listed: () => readonly ListedAgent[]): void`. Only the waiting cards of that kind are looked for (`host === 'harness'` when `harness`, every other card when not); with none, `listed` is not called. For each, the first listed agent that is its agent: the same `agentId`; else, for an agent with a `session`, that session among the card's keys; else, for an agent with none, one of its `panes` among the card's keys.
    - None: it goes on waiting.
    - Its agent is `busy`, or already has another card: the card ends (`ended`).
    - Else it waits no more and, under another id, takes the agent's id in the same place of the order, with `changed()`; unless another question of that agent covers it (`deps.held`), its question is held (`deps.hold`, under the agent's id it now has). Once per call, when any card was found this way, `deps.redraw()`, after the holds.
    - A card found is never looked for again.
  - `Notices.working(agentId: string): void`: a restored card of that agent ends; a live one stays (it was shown in this turn).
  - `notify` also ends each waiting card that shares a key with `caller.keys`, before the new card is set.
- Produces in `devices.ts`:
  - `lookOutside(entries: HostEntry[])`: `part.call('notices', () => notices.look(false, () => entries.map(({ agent }) => listedAgent(agent.id, agent, busyState(agent.state)))))`, called in `outsideTurn` right after `const entries = outsideEntries()`, before `told` is read: an agent listed busy for the first time ends its card here, under the id the card was kept by.
  - `lookHarness()`: `part.call('notices', () => notices.look(true, () => core.agents.advertised().map((session) => listedAgent(session.agentId, session, false))))`.
  - `const refresh = deps.refresh && ((): Promise<void> => deps.refresh!().then(() => lookHarness()))`, declared above the fleet's start (it reads `lookHarness` only when called) and passed to `startFleet` and to the cable host in place of `deps.refresh`: the core's agents are read again as each list is built, once a second with a dial attached, and with no Harness card waiting the look reads nothing. Comment: inside the core's process there is no `deps.refresh` and no listener, so no notice is made there.
  - In `toCable`, for the event `cableEventFor` gives: `if (event.kind === 'processing') part.call('notices', () => notices.working(event.agentId))`, before `toDial(event)`.

In `notices.spec.ts`: `agent(agentId, over) = { agentId, panes: [], busy: false, ...over }`; `lists(...agents)` answers a thunk and counts its reads.

- [ ] **Step 1: Write the desk tests,** `describe('a restored card finds its agent')`:
  - `found by its id, its row is in the drawer by one drawer replace, and its question is held, never asked`: `back([kept()])`, `look(false, lists(agent('a1')))`: `rows('m')` has the row, `redraws` 1, `calls` `[['hold', 'a1', 'shown:k1', asked('Orca')]]`, `changes` 0. With `held.add('a1')` before the look: the card is found (a second `look` reads no list) but `calls` is `[]` and `rows('m')` `[]`.
  - `found by its session under a new id, it takes that id in its place, and the file is told`: `back([kept({ agentId: 'old' }), asWho])`, `look(false, lists(agent('new', { session: 'claude:s1' })))`: `stored().map((c) => c.agentId)` is `['new', 'w1']`, `pending('old')` is false, `changes` 1, the hold is `['hold', 'new', 'shown:k1', asked('Orca')]`; `ended('new')` gives `['close', 'new', 'shown:k1']`.
  - `found by a pane when the agent names no session`: keys `['claude:s1', 'herdr:w1:p1']`, `agent('new', { panes: ['herdr:w1:p1'] })`: its row is under `new`.
  - `another session in the same pane is not its agent` (Review Focus 1): the same card, `agent('new', { session: 'claude:s2', panes: ['herdr:w1:p1'] })`: `rows('m')` is `[]`, `redraws` 0, `pending('old')` holds.
  - `a Harness card looks among Harness agents alone, any other among the outside lists alone`: `kept({ host: 'harness' })`: `look(false, lists(agent('a1')))` reads no list and finds nothing, `look(true, …)` finds it; the mirror for an `orca` card.
  - `first seen in a turn, it ends and is never shown`: `agent('a1', { busy: true })`: `calls` is `[['close', 'a1', 'shown:k1']]`, `rows('m')` `[]`, `redraws` 0, `changes` 1.
  - `not listed, it waits; with none waiting the lists are not read`: `look(false, lists())` reads once and changes nothing; after a later look finds it, another `look` reads no list.
  - `found once, it is looked for no more`: found idle, then `look` with it `busy`: still pending.
  - `a new notice from an agent whose restored card waits under another id ends that card` (Review Focus 2): `back([kept({ agentId: 'old' })], { keys: { new: ['claude:s1'] } })`, `notify(notice(VPN, 'new'))`: `calls.map((c) => [c[0], c[1], c[2]])` is `[['close', 'old', 'shown:k1'], ['ask', 'new', 'shown:u1']]`, `stored()` has one card.
  - `a card whose agent already has one ends`: two waiting cards `x1` and `x2` with the key `claude:s1`, one `agent('new', { session: 'claude:s1' })`: one card remains, under `new`; the other is closed.
  - `working ends a restored card, waiting or shown, and leaves a live one`: `back([kept(), asWho])`: `working('a1')` and `working('w1')` give the two closes, under `shown:k1` and `shown:k2`; on a desk with a live card of `a1`, `working('a1')` adds no call and `pending('a1')` holds; `working` of an agent with no card does nothing.
  - `listedAgent and noticeKeys name a session the same way`: `listedAgent('x', { engine: 'claude', sessionId: 's1', paneKeys: ['herdr:p'] }, true)` equals `{ agentId: 'x', session: 'claude:s1', panes: ['herdr:p'], busy: true }`, and that `session` is `noticeKeys(…)[0]`; with no `sessionId`, `session` is undefined.
- [ ] **Step 2: Write the wiring tests,** in Task 2's `describe`:
  - `a restart with a pending card puts its row back as its agent is listed, with no question and no alert`: A: `port.observed(hook('session-start'))`, the notice; `again`; `seen.host.watching!(true)`; `host().listUnread()` is `[]`; `port.observed(hook('session-start'))`: `calls('replaceNotifications').at(-1)` is `[[{ agentId: ID, machineId: 'machine-1', question: true, text: LINE }]]`, `calls('hold')` is one call for `ID` under the card's id, and `ringing()` is `[]`.
  - `a restored card of an observed agent the scan finds working is not shown`: A as above; before `again`, `readers.known.set('sess-1', 'terminal')`, `readers.owners.set('sess-1', { engine: 'claude', pid: 4242 })`, `readers.rows.set('sess-1', { cwd: '/work/api', transcriptPath: null })` (`readers.working` unset reads as in a turn); `seen.host.watching!(true)`, `port.swarms(null)`; `vi.waitFor` until `host().listAgentSnapshot()` lists `ID`; `host().listUnread()` is `[]`, no `replaceNotifications` call holds `ID`, `calls('questionClose')` is `[[ID, the card's id]]`; advance 1 s: `saved().cards` is `[]`.
  - `a Harness agent's restored row comes with the list that first names it, though the dial attached first` (Review Focus 5): A: `devices({ core: bound() })`, a notice for `s-h1`; B: `again` with a core whose `advertised` answers a `view` that starts `[]` and a `refresh` that sets it to `h1` bound to `s-h1`; `seen.host.watching!(true)`: `host().listUnread()` is `[]`; `port.swarms(null)`, `await host().listAgentSnapshot()`: the last `replaceNotifications` is `[[{ agentId: 'h1', machineId: 'machine-1', question: true, text: LINE }]]`, `calls('hold')` is `[['h1', the card's id, [{ key: 'notice', q: LINE, options: ['In Harness'] }]]]` (the label `hostDisplayName('harness')` gives), `ringing()` is `[]`.
  - `a card of a running turn ends a Harness agent's restored row`: from that state, `port.card({ type: 'commander_event', agentId: 'h1', payload: { kind: 'processing', text: 'Working' } })`: `calls('questionClose')` is `[['h1', the card's id]]`. (A live card through a `processing` card is the existing `its card goes when that agent's next turn starts` test, unchanged.)
  - `an agent herdr lists under a new id is found by its session, and the file takes the new id`: A: the herdr test's client with the agent `idle`, the notice, its id `first`; `again` with the same client; `seen.host.watching!(true)`, `port.swarms(null)`, the list as that test drives it; the agent's new id `second` is not `first`; the last `replaceNotifications` holds `{ agentId: second, … text: LINE }`, `ringing()` is `[]`; advance 1 s: `saved().cards[0].agentId` is `second`.
- [ ] **Step 3: Write the end-to-end tests in `e2e/deviceNotify.e2e.ts`** (import `readFileSync` and `devicesPids`). `card = (d, id) => until('the card in the file', () => { try { return JSON.parse(readFileSync(join(d.dataDir, 'dial-notices.json'), 'utf8')).cards.some((c) => c.id === id) || null } catch { return null } }, 30_000, 50)`; `row = (dial, agentId, since) => dial.next((m) => m.t === 'notif.replace' && m.items.some((item) => item.agentId === agentId), 60_000, 'the row back', since)`.
  - `an outside session's notice comes back as a silent row after the devices restart, and its next prompt ends it`: `fresh`, `plugged`, `startOutside(d, 'fix-login')`, `listed`; `engine.type('before the restart')`, wait for its `Stop` hook and `engine.idle(d)` (a turn, so the scan finds its conversation); `notify` is `shown`; take the `question`; `await card(d, question.id)`; `back = dial.messages.length`; `SIGKILL` each of `devicesPids(d)`; `await dial.welcomeAfter(back, 60_000)`; the row found by `row` matches `{ agentId: engine.id, question: true, summary: LINE, name: 'fix-login' }`. Barrier: `dial.send({ t: 'agents.list' })`, wait for `agents.end` (the hold goes in its agent's order, a turn of the loop behind the drawer replace). Opening the row (harness-pm's required test, end to end): `dial.send({ t: 'question.read', agentId: engine.id, requestId: 'read-1' })`; its `question.state` matches `{ ok: true, id: question.id, questions: [{ q: LINE }] }`, never `error: 'No readable question. Check the terminal.'`. Since `back`, no message for `engine.id` is a `question`, a `turn.error`, or a `summary` that is neither `restore: true` nor `tier: 'silent'`. Then `engine.type('connected')`: a `question.close` with `question.id`; `until` the file's `cards` is `[]`; `d.log()` contains `'[device] notices · restored 1 · aged out 0'` and no line of it contains `LINE`.
  - `a Harness agent's notice comes back as a silent row after the devices restart`: `create(d, client, 'in-harness')`, `plugged`, `listed`, `notify` with its session, the `question`, `card`, the kill and the welcome as above; `row` matches `{ agentId: harness.id, question: true, summary: LINE }`; after the same barrier, `question.read` for `harness.id` answers `{ ok: true, id: question.id, questions: [{ q: LINE }] }`; since `back` no `question` for `harness.id`; `client.send('message', { agentId: harness.id, content: 'go on' })` brings a `question.close` with `question.id`.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/notices.spec.ts src/services/devices.spec.ts -t 'finds its agent|outlives a restart'` and `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceNotify.e2e.ts -t 'after the devices restart'`. Expected: FAIL (`look` and `working` are not there; end to end, no `notif.replace` carries the row: the card waits for good).
- [ ] **Step 5: Commit** `test(dial): a restored notice finds its agent, or goes (red)`.
- [ ] **Step 6: Implement** the desk and the wiring (Interfaces above).
- [ ] **Step 7: Run** `cd cli && npx vitest run src/cable src/services/devices.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts && npm run typecheck`, then `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceNotify.e2e.ts`, then `cd cli && npx vitest run src/services/devices.spec.ts --coverage --coverage.include=src/services/devices.ts --coverage.reporter=text`. Expected: PASS, the whole end-to-end file too, and the coverage table lists no line this branch added to `services/devices.ts` as uncovered (the 100% gate itself runs in Verification).
- [ ] **Step 8: Commit** `dial: a restored notice finds its agent again, and goes when it is in another turn`.

### Task 5: Docs

**Layer:** docs. **Depends on:** none. **Effort:** `medium`. **Red test:** none (no behavior changes; one commit).

**Files:**
- Modify: `cli/AGENTS.md` (the `devices` row of the processes table)
- Modify: `docs/cli.md` (the `harness device notify` row)

- [ ] **Step 1:** In `cli/AGENTS.md`, after "… the person taps "In <app>" or its agent leaves," add: "the pending ones kept in `dial-notices.json` (`cable/noticeFile.ts`) and back after the process restarts as drawer rows that do not ring again and open to their line, none older than 24 hours,".
- [ ] **Step 2:** In `docs/cli.md`, after "… until that agent's next turn starts or the person taps "In <app>"." add: "A notice still pending when the daemon restarts comes back in the dial's list without ringing again, for up to 24 hours."
- [ ] **Step 3: Run** `cd cli && npx vitest run src/lib/startEnvironment.spec.ts` (it reads `docs/cli.md`). Expected: PASS.
- [ ] **Step 4: Commit** `docs: a pending notice outlives a restart of the devices`.

### Task 6: A cable session holds a question it never asks

**Layer:** devices service process (the dial's link). **Depends on:** none. **Effort:** `high` (a question that must never beep, on every dial, for its whole life).

**Red tests:** `cli/src/cable/questionInbox.spec.ts`, `cli/src/cable/cableSession.spec.ts`, `cli/src/cable/cableFleet.spec.ts`.

**Files:**
- Modify: `cli/src/cable/questionInbox.ts`
- Test: `cli/src/cable/questionInbox.spec.ts`
- Modify: `cli/src/cable/cableSession.ts` (the method `hold` only)
- Test: `cli/src/cable/cableSession.spec.ts`
- Modify: `cli/src/cable/cableFleet.ts`
- Test: `cli/src/cable/cableFleet.spec.ts`

Size: about 15 changed lines outside the specs; no new frame, no firmware change (Decisions 3).

**Interfaces:**
- Produces in `questionInbox.ts`:
  - `QuestionInbox.set(agentId: string, id: string, raw: unknown, held = false): void`. `Entry` gains `held?: true`, set on a new entry only. The same id and questions set again, held or not, leave the entry as it is (today's early return), so a held entry never turns asked.
  - `ask()` answers `false` for a held entry, always. `forget()` is unchanged (it only clears `asked`, which a held entry never has).
  - `open()` items are `{ agentId, id, questions, held?: true }`, `held` only on a held entry. So `owedQuestions()` (unchanged: a held id starts with `shown:`, and `owed` says yes) carries the flag, and `resendQuestions` (unchanged) skips the entry at its `ask`.
- Produces in `cableSession.ts`: `async hold(agentId: string, id: string, questions: unknown): Promise<void>`: `this.questionInbox.set(agentId, id, questions, true)` and nothing else: no frame, no `liveTurns` (the agent's turn is not known). Doc comment: a question the dial reads when its row is opened and is never asked: a notice restored after the devices process restarted rang before it (cable/notices.ts, harness-pm 2026-11-18).
- Produces in `cableFleet.ts`:
  - `hold(...args: Parameters<Surface['hold']>) { return this.send('hold', ...args) }`, beside `question`: every session of the fleet holds it.
  - In the `attached` closure, a dial plugged in beside another holds what its sibling holds and is asked the rest: `for (const open of sibling.session.owedQuestions()) (open.held ? entry.session.hold(open.agentId, open.id, open.questions) : entry.session.question(open.agentId, open.id, open.questions)).catch(failed)`.

In the specs: `notice = [{ key: 'notice', q: 'Tests pass.', options: ['In Terminal'] }]`, `NID = `${SHOWN_ONLY_PREFIX}n1``.

- [ ] **Step 1: Write the inbox tests** in `questionInbox.spec.ts`, `describe('QuestionInbox')`:
  - `a held question is read, never asked, though the dial loses its questions`: `set('a', 'shown:n1', notice, true)`: `read(inbox)` has `id: 'shown:n1'` and `questions[0].q` `'Tests pass.'`; `ask('a', 'shown:n1')` is false; after `forget()` and `forget(new Set())`, still false; `set('a', 'shown:n1', notice)` (unheld, same) and `ask` still false; `open()` equals `[{ agentId: 'a', id: 'shown:n1', questions: [expect.objectContaining({ q: 'Tests pass.' })], held: true }]`.
  - `a later question of the agent replaces a held one and is asked; a close under the held id removes it`: hold `a`, `set('a', 'q2', question())`: `ask('a', 'q2')` is true, `open()[0]` has no `held`; on a fresh inbox, hold `a`, `close('a', 'shown:n1')` is true and `inbox.read('a').ok` is false.
- [ ] **Step 2: Write the session test** in `cableSession.spec.ts`, `describe('hello capabilities')`, beside the resync test:
  - `a held question is read when its row is opened, and never asked: not as it is held, at a greeting, a drawer replace or a resync`: `connect(richHost())`, `port.say({ ...PRO_HELLO })`, wait for `notif.replace`; `port.sent.length = 0`; `await session.hold('a3', NID, notice)`: `port.sent` is `[]`. `port.say({ t: 'question.read', agentId: 'a3', requestId: 'read-1' })`: its `question.state` matches `{ ok: true, id: NID, questions: [{ q: 'Tests pass.' }] }`. `await session.question('a1', 'q1', [{ key: 'k', q: 'Ship it?', options: ['yes', 'no'] }])` (a real one, the barrier: a greeting and a resync ask it again); `port.say({ ...PRO_HELLO })` again; `vi.waitFor` until `ofType(port, 'question')` holds `a1 q1` twice (its first ask and the greeting's), `settle()`, and no `question` frame has `agentId: 'a3'`. `await session.replaceNotifications([{ agentId: 'a3', machineId: 'local', question: true, text: 'Tests pass.' }])`, then `port.say({ t: 'resync' })`; `vi.waitFor` until `a1 q1` is there a third time, `settle()`: still no `question` frame for `a3`; `session.owedQuestions()` contains `{ agentId: 'a3', id: NID, held: true }`. Last, `await session.questionClose('a3', NID)`: a `question.close` for `a3` is sent and a new `question.read` answers `ok: false`.
- [ ] **Step 3: Write the fleet test** in `cableFleet.spec.ts`, `describe('a dial plugged in beside one already attached')`:
  - `holds a held question on every dial, one plugged in later too, and asks it of none`: `firstAlone()`; `await f.fleet.hold('b', noticeId, notice)` and `await f.fleet.question('a', 'q1', asked)`; `plugSecond(f)`; `vi.waitFor` until `questions(f.ports[1])` is `['a q1']`, `flush()`: `questions(f.ports[1])` is `['a q1']` and `questions(f.ports[0])` is `['a q1']`. On each port, `say({ t: 'question.read', agentId: 'b', requestId: 'r' })`: its `question.state` matches `{ ok: true, id: noticeId }`. Then `await f.fleet.hold('c', `${SHOWN_ONLY_PREFIX}n2`, notice)` with both attached: both ports read `c` as `ok: true`, and neither has a `question` frame for `b` or `c`.
- [ ] **Step 4: Run** `cd cli && npx vitest run src/cable/questionInbox.spec.ts src/cable/cableSession.spec.ts src/cable/cableFleet.spec.ts -t 'held'`. Expected: FAIL (`hold` is not a function; `open()` has no `held`; the inbox asks the held entry).
- [ ] **Step 5: Commit** `test(dial): a cable session holds a question it never asks (red)`.
- [ ] **Step 6: Implement** the three files (Interfaces above). No other line of `cableSession.ts` changes.
- [ ] **Step 7: Run** `cd cli && npx vitest run src/cable/questionInbox.spec.ts src/cable/cableSession.spec.ts src/cable/cableFleet.spec.ts && npm run typecheck`. Expected: PASS, every older test with no edit.
- [ ] **Step 8: Commit** `dial: a cable session holds a question it never asks, for a notice that rang before`.

## Verification

**Platforms the pull request names:** macOS (tested here), Linux (the same code; PR CI's unit tests and the end-to-end workflow run there). Windows: the devices' listener does not run, so no card is made and the file is never written.

**End-to-end checks:**

1. **The restart, on this Mac, against an isolated daemon and a fake dial.** `cd cli && TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceNotify.e2e.ts e2e/devicesProcess.e2e.ts`. Each test starts its own daemon (`e2e/harness/daemon.ts`: a throwaway home, data folder and port, a private tmux server, fake Claude Code and Codex engines) and a fake dial on a pseudo-terminal (`HARNESSD_TEST_DIAL_PORT`); no backend and no account are used. A person sees both files pass: Task 4's two tests (the row back after the devices are killed, opening it reads the line, no `question` since, the next prompt closing it) and every older notify and devices-process test.
2. **The same suite on Linux, on GitHub, by hand, once:** Actions → CLI end to end → Run workflow, branch `fix/dial-notices-restart`, `agent_browser_podman` off. Report the run's link. The repo has this workflow, so no temporary one is added.
3. **A real dial: none by an agent or a tester.** The one dial on this Mac is held by the person's own running daemon (the serial port is opened `O_EXLOCK`, one owner), and a second daemon could only take it by stopping that one. **The person's own check, after the release** (their dial, their eye): with a notice pinned, let the daemon restart (an update does it); the line is still in the dial's list and the dial does not beep; opening the row shows the line, not "No readable question"; their next prompt to that agent takes it away.

**Never touched by a tester or a test:** the person's daemon (port 18473) and its data folder, their dial, `~/.claude`, `~/.codex`, any backend, production.

**Required local gates**, at the final head on this Mac, recorded in the pull request:
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit: it runs `cli-core` (`npm run test:core`, 100% per file under `src/core/` and `src/services/`), which applies because `cli/src/services/devices.ts` changes. Its receipt goes in the pull request's body before the tested commit is pushed.
- `cd cli && npm run typecheck && npx vitest run src/cable/notices.spec.ts src/cable/noticeFile.spec.ts src/cable/questionInbox.spec.ts src/cable/cableSession.spec.ts src/cable/cableFleet.spec.ts src/services/devices.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts src/lib/startEnvironment.spec.ts`.
- `git diff --stat origin/main -- cli/src/core cli/src/architecture.coreFiles.txt cli/src/cable/cableHost.ts devices desktop mobile device-app` prints nothing, and `git diff -U0 origin/main -- cli/src/cable/cableSession.ts` is one hunk, the method `hold` (no line of `replaceNotifications`).
- Not needed: `npm run test:harnessd`, the serial specs (`cli-serial`: no serial code changes), firmware, Desktop, device-app.

**In PR CI, by itself:** `cli-typecheck` and `cli-tests` run every unit spec above on Linux.

**Numbers:** none to take. With no card waiting, the look added to each list read is one check and reads no list (Task 4, `with none waiting the lists are not read`); a `processing` card adds one map lookup; the file is read once, 32 KiB at most (Task 1, `a file at 32 KiB is read, one byte longer is not`), and written at most once a second.

**Against production:** none.
