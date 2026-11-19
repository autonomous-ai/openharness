# A question beyond the dial's drawer frame rings once and stays reachable — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use devcrew phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(dial): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message. No task pushes or merges.

**Goal:** A question the dial was already told is never rung again because its drawer was replaced, and a question the daemon's inbox refuses stays on the dial as a row until it is closed.

**Architecture:**
- **The inbox** (`cli/src/cable/questionInbox.ts`) keeps `told` beside `asked`, and keeps a refused question as an unreadable, summary-only entry instead of deleting it. `answer.reviewed` (`submit`), `canSpeak` and `draft` refuse an unreadable entry; the legacy `answer` frame stays as #4451 left it.
- **The session** (`cli/src/cable/cableSession.ts`) reads `hello.questionTier`, answers it with `question.tier` in `welcome.features`, and one rule decides what a question the dial does not hold is sent as: a ring, a `tier: 'list'` row, the Pro's plain frame, or nothing. `resendQuestions` and `question()` both use it, and neither gives a told question back to an id the dial cannot keep (`dialKeepsId`). `replaceNotifications` changes only by Task 1's rename.
- **The drawer's words and the inbox's summary are one cut,** `noticeSummary`, in `cli/src/cable/dialText.ts` beside `dialText`, which #4451 wrote.
- **The firmware** (`devices/harness-device/firmware/`) says `questionTier: 'v1'`, reads `question.tier` from the welcome (`cable_features.c`), files a `tier: 'list'` question with no beep and no wake only when the welcome listed it, shows the words of a question it cannot answer, and its `notif.replace` reader keeps a row per agent and kind.
- Everything on the computer runs in the devices process. Nothing goes through the core, nothing is stored, no Desktop or Pro firmware change.

**Tech Stack:** TypeScript daemon (Node, vitest, `cli/`); ESP-IDF 5.5.4 C firmware with Python host tests (`devices/harness-device/firmware/`).

**Spec:** `docs/plans/2026-11-18-dial-drawer-limits-design.md`. Read it with this plan, the root `AGENTS.md` and `cli/AGENTS.md`.

**Open questions:** none. harness-pm answered both on 2026-11-18 ("Decided here", 13 and 14), and decided how the capability is declared (16). The main session decided 17 and 18 at the rebase onto `650b8115b3`.

## Base

- `fix/dial-drawer-limits` at `7cea6d4b5b`, rebased onto `origin/main` `650b8115b3` (#4451 `fix/dial-frame-cap`, with #4448, #4444, #4441 and #4427 before it). On top: the spec and plan commits (`00e479a694`, `0c3eebbaeb`, `fcadd37873`) and the commits of the done tasks.
- **Done and landed:** Task 10 (`06681f53da`), Task 2 (`d73cadd10b`, `622c0dabde`), Task 6 (`762a982828`, `362565ec7f`), Task 9 (`46eef9c23b`, `20259ed224`), Task 8 (`1e6595e5f7`, `7cea6d4b5b`). **Not started:** Tasks 1, 3, 4, 5, 7.
- Measured at `7cea6d4b5b` on this Mac, 2026-11-18:
  - `npx vitest run src/cable/questionInbox.spec.ts src/cable/cableFleet.spec.ts src/cable/cableSession.spec.ts`: 446 passed.
  - `test_cable_features.c` (Task 7's command), `test_cable_identity.py`, `test_cable_outbound.py` (with `IDF_PATH`) and `test_question_ui.py`: each passes.
  - Measured at the first base (`275512c33a`) and not changed since: `test_cable_models.py` does not build on macOS (`'snprintf' macro redefined`, green on CI's Linux) and stops `run.sh`, so SDK-dependent tests are run one file at a time here; both firmware builds of check 1 pass (default 41 s, bench 1 min 37 s).
- **What the tasks build on, read at `7cea6d4b5b`:**
  - `cableSession.ts`, module level: `NOTICE_SUMMARY_MAX = 239`, `NAME_MAX = 39`, `dialJson` (what `send` writes), `dialReads`, `asAsked`, `dialText(text, max)`, `dialKeepsId(agentId)`, `fitDrawer`. No `noticeSummary`: `replaceNotifications` cuts a row's words with `dialText(…, NOTICE_SUMMARY_MAX)` twice (the window's rows, the open questions' rows), and `whoIs` cuts the name and machine with `dialText(…, NAME_MAX)`.
  - `owed(agentId, id)` is `dialKeepsId(agentId) && (shown-only || live turn 'question')`; `replaceNotifications` leaves out a row whose id the dial cannot keep (`e6a1d90fde`); `forget(kept)` takes the question rows of the drawer **after** `fitDrawer`.
  - `question()` still sends a question the inbox refuses as it came (through `send`, so `dialJson`). The legacy `answer` case answers through `asAsked(this.questionInbox.asked(agentId, requestId), flat)`, and `asAsked(undefined, …)` passes the dial's text through as it is.
  - `welcome.features`: `...(this.appFilter && this.host.pickApp ? ['apps.switch'] : [])`, then `'settings'`. `describe('the app filter')` has "the fullest round-dial welcome is eight names".
  - `questionInbox.ts`: `latest: Map<agentId, { id, json? }>` (the questions as asked, through `frameJson`, which catches the throw of a BigInt), `asked(agentId, id)` returning them while they fit a frame; Task 2's `told`, `refile` and `forget(kept)`. `set` evicts and writes `latest` before it checks anything, an empty `agentId` or `id` included. An existing test passes a BigInt field to `set`.
  - Firmware: `CABLE_FEATURE_APPS_SWITCH = 1u << 7`; `test_cable_features.c`'s fullest check expects `255u`; `send_hello` says `appFilter`; `handle_question` passes `list` for `tier == "list"` with no feature gate (Task 6); `test_cable_identity.py` has no `cable_client_supports` double.
- **Another open branch touches the same file:** `fix/dial-notices-restart` (`301e37650d`, based before #4441) adds `held` entries and `set(agentId, id, raw, held = false)`. Task 3 never uses the names `hold` or `held`. Whoever lands second: a `held` entry is created `told` (it rang before), `set` returns its boolean, and `held` stays its last parameter.
- The tasks name functions, never lines. If a name differs at the base, the implementer follows the code and says so in its report.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 One cut for the drawer's words and the inbox's summary | `cli/src/cable/dialText.ts` (new), `cableSession.ts` | none | medium | none: a move, no behavior, one commit |
| 2 The inbox remembers what the dial was told | — | — | — | **Done** |
| 3 The inbox keeps a refused question as its summary | `cli/src/cable/questionInbox.ts`, `questionInbox.spec.ts`, `cableSession.spec.ts` (one existing test) | 1 | high | `questionInbox.spec.ts` |
| 4 A told question comes back as a silent row, never a ring; the welcome says `question.tier` | `cli/src/cable/cableSession.ts`, `cableSession.spec.ts` | 1 (and 2, done) | xhigh | `cableSession.spec.ts` |
| 5 A refused question reaches the dial small and stays on its drawer | `cli/src/cable/cableSession.ts`, `cableSession.spec.ts`, `cableFleet.spec.ts` | 3, 4 | high | `cableSession.spec.ts`, `cableFleet.spec.ts` |
| 6 Firmware: a `question` with `tier: 'list'` files its row silently | — | — | — | **Done** |
| 7 Firmware: the hello says `questionTier: 'v1'`, and only a welcome's `question.tier` makes `tier: 'list'` silent | `main/cable_features.h`, `main/cable_features.c`, `main/cable_client.c`, `test/test_cable_features.c`, `test/test_cable_outbound.py`, `test/test_cable_identity.py` | none (6, done) | high | `test_cable_features.c`, `test_cable_outbound.py`, `test_cable_identity.py` |
| 8 Firmware: a question the dial cannot answer shows its words | — | — | — | **Done** |
| 9 Firmware: the drawer's reader keeps a row per agent and kind | — | — | — | **Done** |
| 10 End to end: an open question comes back as a drawer row | — | — | — | **Done** |

Firmware paths are under `devices/harness-device/firmware/`.

Longest chain: three tasks, 1 → 3 → 5 or 1 → 4 → 5.

- Tasks 1 and 7 start at once. Tasks 3 and 4 start when Task 1 is done; Task 5 when both are.
- The CLI tasks and Task 7 share no file.
- Shared files with no dependency between the tasks (they do not run together, in either order): `cableSession.spec.ts` (3, 4). Every other shared file lies on a chain: `cableSession.ts` (1 → 4 → 5), `cableSession.spec.ts` (3 → 5, 4 → 5).

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/questionInbox.ts`, `dialText.ts`, `cableSession.ts` | **Devices service process**, in memory | Their specs (PR CI `cli-tests`) |
| `devices/harness-device/firmware/main/**` | **The round dial** | Host tests (PR CI `firmware-checks`), a local build |
| `cli/src/cable/*.spec.ts`, `firmware/test/*.py` | Tests | — |
| `cli/e2e/deviceNotify.e2e.ts`, `deviceClaudeOrca.e2e.ts` | End-to-end tests: the real daemon and a fake dial | Verification, check 4 |

No file under `cli/src/core/` or `cli/src/services/` changes, `src/architecture.coreFiles.txt` gains no line, and `cableFleet.ts`, `cableHost.ts`, `services/devices.ts`, `devices/harness-pro/` and the Desktop do not change.

## Before starting

- CLI: `cd cli && npm ci` if `cli/node_modules` is missing. Run one spec with `cd cli && npx vitest run <file>`.
- Firmware host tests need no SDK, except `test_cable_identity.py` and `test_cable_outbound.py`, which read the SDK's cJSON: run them with `IDF_PATH=$HOME/esp/esp-idf` (ESP-IDF 5.5.4 on this Mac). Every command below is from the repo root.
- No task builds or flashes firmware. The build is the tester's (Verification, check 1). Nothing ever touches a plugged-in dial, the everyday daemon (port 18473), `~/.claude` or `~/.codex`.

## Global Constraints

- **Wire values, exact:** `hello.questionTier` is `'v1'`, a positive string match per greeting, like `appFilter`. The daemon answers it with `question.tier` in `welcome.features`, only for that greeting. `tier: 'list'` goes only to a dial that said it, and the firmware files it silently only when its session's welcome listed `question.tier`.
- **The welcome's 16 names:** the firmware drops every feature of a welcome over 16 names. After this plan the fullest round-dial welcome is 9 names, a Pro's fullest 9, a greeting that said every capability 11. A Pro (`hello.board === 'pro'`, the session's `seqOn`) does not say it, and neither does an older round dial.
- **A `tier: 'list'` frame's `questions`:** `[{ key: '', q: <summary>, options: [] }]`.
- **An unreadable entry's `questions`:** `[{ key: '', q: <summary>, options: [], multi: false }]`. `<summary>` is `noticeSummary` (`dialText(text, NOTICE_SUMMARY_MAX)`, 239 bytes) of the first question's text, else of `Needs your answer`.
- **An id the dial cannot keep** (`dialKeepsId` false): a told question of it is never sent again, as a row or as the Pro's plain frame (Decided here, 18).
- **Raw questions are stringified only by `frameJson`** in `questionInbox.ts`: `JSON.stringify` throws on a BigInt, and an existing test passes one.
- **Limits unchanged:** 8 rows a `notif.replace`, 64 inbox entries, 6500 bytes of signature, 8192 bytes a frame, 4 questions, 6 options.
- **Copy unchanged:** `[ on desktop ]`, `This question needs the desktop.`, `Needs your answer`. No new copy.
- **Not edited:** the legacy `answer` case (Decided here, 17); the row building and field bounds of `replaceNotifications` (Task 1 renames its two cuts, nothing else); `whoIs`, `dialJson`, `dialReads`, `asAsked`, `dialKeepsId`; `notice_add` and `notice_unread` in `ui_habitat.c`.
- **No release:** no `version.txt` bump, no OTA, no flash.
- Repo rules: no fixed sleeps (wait on a condition); comments say why; no dead code; a replacement removes the old in the same task.

## Review Focus

Most likely to bite first. Each is pinned by a test in the task named.

1. The core and the devices ask every open question again when they reconnect. A refused 10 kB question delivered again unchanged must send nothing and ring nothing (Task 5).
2. A question delivered again while the walk's row for it is being written must be sent once, not twice (Task 4).
3. A Pro mutes a re-sent question by a hash of its id and words. A refused question must reach it in the same words both times (Task 5).
4. A refused question with no usable words (not a list, a null first item, whitespace only, a BigInt) must read `Needs your answer` and never throw (Task 3).
5. A `tier` the dial does not know (`"silent"`, a number, `"LIST"`) must ring as an alert, and a row filed again with other words than its receipt must stay unread (Task 6).

## Decided here, where the spec was silent

1. **Names.** Inbox mark `told`; inbox methods `told(agentId, id)` and `refile(agentId, id)`; nothing else is named `asked`; session flag `questionTier` and rule `giveQuestion`; firmware flag `bool list`, the last parameter of `ui_question_show`; firmware matcher `notice_question_read`.
2. **`dialText` and `noticeSummary` live in `cli/src/cable/dialText.ts`.** `questionInbox.ts` cannot import from `cableSession.ts`, which imports the inbox. Only `dialText`, `NOTICE_SUMMARY_MAX` and the new `noticeSummary` move: the inbox needs nothing else. `NAME_MAX` (only `whoIs`), `dialJson` and `dialReads` (`send`, `asAsked`) and `dialKeepsId` (the session's) stay beside their only callers.
3. **`notice_sequence`:** #4448 deleted it; Task 6 left the line where it was until then.
4. **Marks before the frame.** `ask` and `refile` mark before the frame is written, as `ask` does today, so two paths cannot both send.
5. **What a ring carries.** The live path's ring, and a Pro's plain frame, carry the questions as they came when the inbox holds them whole (as today), and the entry's summary-only shape when it does not. `set` returns that as a boolean.
6. **An empty `agentId` or `id`:** the call is dropped whole, before the inbox's 64-agent eviction and its `latest`. An earlier open question of that agent is untouched.
7. **"Words it can draw":** every character has a glyph (`ui_can_display` with no line limit). Words longer than five lines are cut at five; the spec's own check needs it ("a 10 kB plan question ... opens to its words"). The words are drawn in `FG`, as `question_text` draws a question; the sentences stay `DIM`.
8. **The fallback words** apply too when the first question's text has no words (whitespace only): an empty row helps nobody.
9. **A `list` re-file of the agent on the face** is read at once, as an alert is. The spec names three things `list` skips; this is not one.
10. **The handler tests** (`handle_question`, `handle_notifications`) go in `test_cable_identity.py`, where `cable_client.c`'s handlers are tested with the SDK's cJSON.
11. **The firmware build runs on this Mac,** not on a temporary workflow (Verification says why).
12. **A fact at the base that differs from the spec's "Why":** `send` drops a frame over the cap, logs `cable: dropped a question frame (...)` and keeps the link (2026-11-03). The design holds either way: the question never reached the dial.
13. **Both rows of one agent in one drawer** (harness-pm, 2026-11-18): the daemon does **not** start sending an agent's news beside its question. `replaceNotifications` keeps putting an agent's open question in the place of its news, and `ui_notif_replace` is not changed. Task 9 fixed the dial's reader only.
14. **The end-to-end reds from #4445** (harness-pm, 2026-11-18): fixed in this branch, by Task 10. Test-only: the daemon's frames are what #4445 meant them to be.
15. **`noticeSummary` after #4451** (harness-pm, 2026-11-18): #4451 merged and this branch is rebased onto it, so Task 1 no longer waits. #4451 left one cutting function, `dialText(text, max)`; Task 1 moves it out of `cableSession.ts` and names its 239-byte call `noticeSummary`, one cut for the drawer's words and the inbox's summary. Two cuts would make a read question come back unread.
16. **One way to declare the capability** (harness-pm, from diego-pm, 2026-11-18), as #4441 does for `apps.switch`: the dial says `questionTier: 'v1'` in its hello; the daemon answers `question.tier` in `welcome.features` only to that greeting (Task 4); the firmware parses it into `CABLE_FEATURE_QUESTION_TIER` (`1u << 8`, after #4441's `1u << 7`) and `handle_question` files a `tier: 'list'` frame silently only with that bit, otherwise it is an alert (Task 7). In the welcome, `question.tier` goes after `apps.switch`, before `settings`.
17. **The answer paths that refuse an unreadable entry** (main session, 2026-11-18): `answer.reviewed` (`submit`: no mask is valid for an empty option list), `canSpeak` and `draft` (no `canText`), each by the entry's own shape, with no new check. **The legacy `answer` frame stays exactly as #4451 left it:** `asAsked` of the raw questions as asked (`questionInbox.asked`). #4451 made a legacy answer to a question that repeats a key reach the agent on purpose: an older dial answers the raw question it was sent. This branch does not undo a behaviour just merged and reviewed, and #4451's test "forwards an answer verbatim to a question that repeats a key or an option" is not changed. So the inbox gains no `refused` method: nothing would read it.
18. **A told question goes back only to an id the dial can keep** (main session, 2026-11-18). `owed` already holds the walk to `dialKeepsId`; `giveQuestion` holds the live `question()` path to it too: no `tier: 'list'` row and no Pro plain frame for such an id. The first ring of a question never told is as at the base. #4451's test "an open question whose id the dial cannot keep is not carried as a row, nor asked again at each replace" stays green unchanged.
19. **`fitDrawer`'s comment** ("A question row cut here stays owed and is asked again") is no longer true after Task 4: such a row keeps `told` and loses `asked` (the forget takes the drawer after the cut), so it comes back by `giveQuestion`'s rule. Task 4 rewords it; the function does not change.

---

### Task 1: One cut for the drawer's words and the inbox's summary

**Files:**
- Create: `cli/src/cable/dialText.ts`
- Modify: `cli/src/cable/cableSession.ts` (`NOTICE_SUMMARY_MAX` and `dialText` leave it; the imports; the two `dialText(…, NOTICE_SUMMARY_MAX)` calls in `replaceNotifications`)

**Depends on:** none (#4451 is on this branch's base). **Effort:** medium. **Red test:** none (a move; `cableSession.spec.ts` already holds its behavior, #4451's tests of the drawer's words included).

**Interfaces:**
- Produces, in `cli/src/cable/dialText.ts`:
  - `export function dialText(text: string, max: number): string` — moved from `cableSession.ts` unchanged, with its comment.
  - `export function noticeSummary(text: string): string` — `dialText(text, NOTICE_SUMMARY_MAX)`: a drawer row's words and the inbox's summary of a refused question. Idempotent: `noticeSummary(noticeSummary(x)) === noticeSummary(x)`.
  - `NOTICE_SUMMARY_MAX = 239`, moved with its comment, not exported.

- [ ] **Step 1: Check the base.** `git merge-base --is-ancestor 650b8115b3 HEAD` succeeds (#4451 on the branch), and `grep -n "function dialText\|const NOTICE_SUMMARY_MAX" cli/src/cable/cableSession.ts` prints both. If either fails, stop and report.
- [ ] **Step 2: Move** `NOTICE_SUMMARY_MAX` and `dialText` to the new file, unchanged, and add `noticeSummary` with a comment: the drawer's words and the inbox's summary must be one cut, or a question read on the dial comes back unread. `cableSession.ts` imports `dialText` and `noticeSummary` from `./dialText.js` and keeps no copy. Its two `dialText(…, NOTICE_SUMMARY_MAX)` calls become `noticeSummary(…)`; `whoIs`'s `dialText(…, NAME_MAX)` calls, `NAME_MAX`, `dialJson`, `dialReads`, `asAsked`, `dialKeepsId` and `fitDrawer` stay where they are (Decided here, 2).
- [ ] **Step 3: Run** `cd cli && npm run typecheck && npx vitest run src/cable/cableSession.spec.ts src/architecture.spec.ts`, then `grep -n "NOTICE_SUMMARY_MAX\|function dialText" src/cable/cableSession.ts`. Expected: PASS, and the grep prints nothing.
- [ ] **Step 4: Commit** `Dial: one cut for the drawer's words and the inbox's summary`.

### Task 2: The inbox remembers what the dial was told

**Done:** landed as `d73cadd10b` (red), `622c0dabde`.

**Files:**
- Modify: `cli/src/cable/questionInbox.ts`
- Test: `cli/src/cable/questionInbox.spec.ts`

**Depends on:** none. **Effort:** high.

**Interfaces:**
- Produces, on `QuestionInbox`:
  - `ask(agentId: string, id: string): boolean` — unchanged answer; now sets `asked` and `told`.
  - `forget(kept?: ReadonlySet<string>): void` — with `kept`: `asked` and `told` set on the kept agents' entries, `asked` cleared on the others, `told` never cleared. Without: both cleared on every entry.
  - `told(agentId: string, id: string): boolean` — the agent's open entry has that id and is told.
  - `refile(agentId: string, id: string): boolean` — the dial was given the question back as a row with no ring: sets `asked`. True only when the entry is the open one, is told and was not asked.

- [ ] **Step 1: Write the failing test** in `describe('QuestionInbox')`:

```ts
it('remembers what the dial was told, by a ring or a drawer row, until the dial loses everything', () => {
  const inbox = new QuestionInbox()
  for (const agent of ['a', 'b', 'c']) inbox.set(agent, `q${agent}`, question())
  expect(inbox.told('a', 'qa')).toBe(false)
  expect(inbox.refile('a', 'qa')).toBe(false)   // never told: it is rung, not filed
  expect(inbox.ask('a', 'qa')).toBe(true)       // a ring tells it
  expect(inbox.told('a', 'qa')).toBe(true)
  expect(inbox.told('a', 'old')).toBe(false)    // not the open one
  expect(inbox.refile('a', 'qa')).toBe(false)   // the dial holds it
  inbox.forget(new Set(['b']))                  // a drawer that carries b's row and not a's
  expect(inbox.told('b', 'qb')).toBe(true)      // shown as a row: told, with no ring
  expect(inbox.refile('b', 'qb')).toBe(false)   // and held
  expect(inbox.told('a', 'qa')).toBe(true)      // a replace never clears it
  expect(inbox.told('c', 'qc')).toBe(false)
  expect(inbox.refile('a', 'old')).toBe(false)
  expect(inbox.refile('a', 'qa')).toBe(true)    // back on the dial as a row
  expect(inbox.refile('a', 'qa')).toBe(false)
  expect(inbox.ask('a', 'qa')).toBe(false)
  inbox.forget()                                // a greeting: its RAM is gone
  expect(['a', 'b', 'c'].map((agent) => inbox.told(agent, `q${agent}`))).toEqual([false, false, false])
  expect(['a', 'b', 'c'].map((agent) => inbox.ask(agent, `q${agent}`))).toEqual([true, true, true])
  inbox.set('a', 'qa2', question())             // a new question id: a new entry, neither mark
  expect(inbox.told('a', 'qa2')).toBe(false)
  expect(inbox.ask('a', 'qa2')).toBe(true)
})
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/questionInbox.spec.ts`. Expected: FAIL (`inbox.told is not a function`).
- [ ] **Step 3: Implement** the four members above and `told?: boolean` on `Entry`, each with a comment saying what the mark means (spec, "The daemon's inbox").
- [ ] **Step 4: Run** the same command. Expected: PASS, the existing "asks each question once" test included.
- [ ] **Step 5: Commit** `Dial: the inbox remembers what the dial was told`.

### Task 3: The inbox keeps a refused question as its summary

**Files:**
- Modify: `cli/src/cable/questionInbox.ts` (`Entry`, `set`, the class comment)
- Test: `cli/src/cable/questionInbox.spec.ts`
- Modify: `cli/src/cable/cableSession.spec.ts` (one existing test, Step 4)

**Depends on:** 1. **Effort:** high.

**Interfaces:**
- Consumes: `noticeSummary(text: string): string` from `./dialText.js` (Task 1).
- Produces:
  - `set(agentId: string, id: string, raw: unknown): boolean` — true when the inbox holds the question as it came; false when it kept its summary (an unreadable entry) or nothing. With an empty `agentId` or `id` it returns false **first**, before the 64-agent eviction and `latest.set`: nothing is read, evicted or changed. Otherwise `latest` is written as today (`frameJson(raw)`, for `asked`), and then the entry.
  - An unreadable entry: `questions` `[{ key: '', q: <summary>, options: [], multi: false }]`, its signature built from the same `[id, questions]`, a token, no marks. It is made for every refusal reason and for a signature over 6500 bytes.
  - `raw` is never passed to `JSON.stringify` outside `frameJson`: the summary reads only the first item's `q`, and only when it is a string.

- [ ] **Step 1: Write the failing tests.** Replace the test "refuses oversized or ambiguous catalogs and bounds the pending set" with:

```ts
it('bounds the pending set', () => {
  const inbox = new QuestionInbox()
  for (let i = 0; i < 65; i++) inbox.set(`agent-${i}`, 'q', question())
  expect(inbox.read('agent-0').ok).toBe(false)
  expect(inbox.read('agent-64').ok).toBe(true)
})
```

and add a describe block:

```ts
describe('a question the dial cannot answer', () => {
  const one = question()[0]
  const summaryOnly = (q: string) => [{ key: '', q, options: [], multi: false }]

  it('is kept as its summary, whatever made the inbox refuse it', () => {
    const refused: Array<[string, unknown, string]> = [
      ['five questions', Array.from({ length: 5 }, (_, i) => ({ ...one, key: `k${i}` })), 'Which scope?'],
      ['seven options', [{ ...one, options: ['1', '2', '3', '4', '5', '6', '7'] }], 'Which scope?'],
      ['no options', [{ ...one, options: [] }], 'Which scope?'],
      ['a duplicate key', [one, one], 'Which scope?'],
      ['over 6500 bytes', [{ ...one, q: `Approve  this\n\nplan? ${'x'.repeat(7000)}` }], `Approve this plan? ${'x'.repeat(220)}`],
      ['a BigInt beside its words', [{ ...one, options: [], size: BigInt(1) }], 'Which scope?'],
      ['a BigInt for text', [{ ...one, q: BigInt(7), options: [] }], 'Needs your answer'],
      ['no words', [{ ...one, q: ' \n ', options: [] }], 'Needs your answer'],
      ['no text', [{ key: 'k' }], 'Needs your answer'],
      ['a number for text', [{ ...one, q: 7, options: [] }], 'Needs your answer'],
      ['an empty list', [], 'Needs your answer'],
      ['not a list', 'approve?', 'Needs your answer'],
      ['a null question', [null], 'Needs your answer'],
    ]
    for (const [why, raw, words] of refused) {
      const inbox = new QuestionInbox()
      expect(inbox.set('a', 'q', raw), why).toBe(false)
      expect(read(inbox).questions, why).toEqual(summaryOnly(words))
      expect(inbox.open(), why).toEqual([{ agentId: 'a', id: 'q', questions: summaryOnly(words) }])
    }
  })

  it('is readable and refuses every answer', async () => {
    const inbox = new QuestionInbox(), send = vi.fn(async () => ({ ok: true as const }))
    inbox.set('a', 'q', [{ ...one, options: [] }])
    const { token } = read(inbox), pin = { agentId: 'a', token, index: 0 }
    for (const [masks, drafts] of [[[1], undefined], [[0], undefined], [[0], ['draft']], [[], undefined]] as const)
      expect((await inbox.submit('a', token, masks, send, drafts)).ok).toBe(false)
    expect(inbox.canSpeak(pin)).toBe(false)
    expect(inbox.draft(pin, 'Yes').ok).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('is the same entry when delivered again or as its own summary, and is replaced or closed like any other', () => {
    const inbox = new QuestionInbox(), plan = [{ ...one, q: `Approve? ${'x'.repeat(7000)}` }]
    expect(inbox.set('a', 'q', plan)).toBe(false)
    const first = read(inbox)
    expect(inbox.ask('a', 'q')).toBe(true)
    expect(inbox.set('a', 'q', plan)).toBe(false)
    expect(inbox.set('a', 'q', first.questions)).toBe(false)   // the fleet hands a dial beside this one `open()`'s questions
    expect(read(inbox).token).toBe(first.token)
    expect(inbox.ask('a', 'q')).toBe(false)                    // the same entry, still asked
    expect(inbox.set('a', 'q', question())).toBe(true)         // the same id, answerable now: a new entry
    expect(read(inbox).token).not.toBe(first.token)
    expect(inbox.set('a', 'q', question())).toBe(true)         // unchanged: still as it came
    expect(inbox.set('a', 'q2', plan)).toBe(false)
    expect(inbox.close('a', 'q')).toBe(false)
    expect(inbox.close('a', 'q2')).toBe(true)
    expect(inbox.open()).toEqual([])
  })

  it('counts against the 64 entries, and an empty agent or id keeps, evicts and changes nothing', () => {
    const inbox = new QuestionInbox()
    inbox.set('a', 'q', question())
    const before = inbox.open()
    for (const [agent, id] of [['', 'q'], ['a', ''], ['', '']]) expect(inbox.set(agent, id, question())).toBe(false)
    expect(inbox.set('a', '', [])).toBe(false)
    expect(inbox.open()).toEqual(before)                       // a's open question is as it was
    expect(inbox.asked('a', 'q')).toEqual(question())          // and so are the words it was asked in
    expect(inbox.close('a', 'q')).toBe(true)
    for (let i = 0; i < 65; i++) inbox.set(`agent-${i}`, 'q', [])
    expect(inbox.read('agent-0').ok).toBe(false)
    expect(inbox.open()).toHaveLength(64)
    const full = new QuestionInbox()
    for (let i = 0; i < 64; i++) full.set(`agent-${i}`, 'q', question())
    expect(full.set('', 'q', question())).toBe(false)
    expect(full.read('agent-0').ok).toBe(true)                 // not evicted for a question nobody can close
  })
})
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/questionInbox.spec.ts`. Expected: FAIL (`set` returns undefined; a refused question is not readable; an empty id overwrites `latest` and evicts `agent-0`).
- [ ] **Step 3: Implement** `set` as above. The summary is `noticeSummary` of the first question's `q` when that is a string, else of `Needs your answer`; an empty result falls back to `Needs your answer` too. Reading the first item must not throw on a non-list or a null item. The class comment says an entry may be unreadable, why it is kept (it stays on the dial's drawer until closed) and that `submit`, `canSpeak` and `draft` refuse it by its shape.
- [ ] **Step 4: One session test moves with it.** "names the agent on every summary and question, for one the dial does not hold" asks a refused question (`[{ key: 'k' }]`) as the dial greets. The inbox now holds it, so it waits for the greeting's walk instead of going out at once: wrap that test's `question` assertion in `await vi.waitFor(...)`. Change nothing else in `cableSession.spec.ts`.
- [ ] **Step 5: Run** `cd cli && npm run typecheck && npx vitest run src/cable/questionInbox.spec.ts src/cable/cableSession.spec.ts src/cable/cableFleet.spec.ts`. Expected: PASS, the BigInt case of "keeps the questions each agent asked last as they came" included.
- [ ] **Step 6: Commit** `Dial: a question the inbox refuses is kept as its summary`.

### Task 4: A told question comes back as a silent row, never a ring; the welcome says `question.tier`

**Files:**
- Modify: `cli/src/cable/cableSession.ts` (the capability fields, `capabilitiesNamed`, `resetCapabilities`, `hello` and its `welcome.features`, a new `giveQuestion`, `resendQuestions`, `question`, `fitDrawer`'s comment; not `replaceNotifications`)
- Test: `cli/src/cable/cableSession.spec.ts` (`describe('hello capabilities')`, and "the fullest round-dial welcome is eight names" in `describe('the app filter')`)

**Depends on:** 1 (and 2, done). **Effort:** xhigh (two async paths, three kinds of dial).

**Interfaces:**
- Consumes: `QuestionInbox.told`, `refile`, `ask` (Task 2, done); `noticeSummary(text)` from `./dialText.js` (Task 1); `dialKeepsId(agentId)` (module level in `cableSession.ts`, #4451).
- Produces:
  - `private questionTier = false` — `hello.questionTier === 'v1'`, read at every hello beside `appFilter` (before the welcome is sent), cleared in `resetCapabilities`, named `questionTier` in `capabilitiesNamed` (after `appFilter`).
  - `welcome.features` gains `...(this.questionTier ? ['question.tier'] : [])`, after the `apps.switch` line and before `'settings'`, with a comment: the dial files a `tier: 'list'` question silently only when told, so an older daemon's frame stays an alert (Decided here, 16).
  - `private async giveQuestion(agentId: string, id: string, questions: unknown, words: string): Promise<void>` — the one rule. `questions` is what a ring and a Pro's plain frame carry; `words` is the first question's text as the inbox holds it.

The rule, for a question the dial does not hold. Every mark is set before its frame is written:

| The entry | The dial | Sent | Marked |
|---|---|---|---|
| not told | any | `{ t: 'question', agentId, ...whoIs, id, questions }` | `ask` (asked and told) |
| told, `dialKeepsId(agentId)` false | any | nothing | nothing |
| told | said `questionTier` | the same frame with `tier: 'list'` and `questions: [{ key: '', q: noticeSummary(words), options: [] }]` | `refile` (asked) |
| told | a Pro (`seqOn`) that did not say it | the plain frame, as for "not told" | `refile` |
| told | an older round dial | nothing | nothing |

"Not told" is `!told(agentId, id)`: an entry told and no longer held is never `ask`ed again. A question the dial holds (`ask` and `refile` both answer false) sends nothing.

- `resendQuestions` gives each open, owed question through the rule, with `open()`'s `questions` and `questions[0].q`. It still clears `greeting` first, and `owed` (with its `dialKeepsId`) is unchanged.
- `question()` keeps today's start (`set`, `liveTurns`), then: a question the inbox does not hold (`read` not ok) is sent as it comes, as today (Task 5 ends that); during a greeting it waits for the walk, as today; otherwise it goes through the rule with the `questions` as they came and the inbox's first `q`.
- `fitDrawer`'s comment: its last sentence becomes "A question row cut here is not on the dial: the forget that follows takes the drawer after this cut, so the question keeps told and loses asked, and comes back by giveQuestion's rule (a silent row, the Pro's plain frame, or nothing on an older dial), never as a second ring." (Decided here, 19.)

- [ ] **Step 1: Write the failing tests.** In `describe('hello capabilities')`, replace "a drawer holds eight rows, open questions first: one past them is asked after it" with the first test below, and add the others:

```ts
it('a drawer holds eight rows, open questions first: one past them comes back as a row, with no ring', async () => {
  const ask = [{ key: 'k', q: 'Ship it?', options: ['yes', 'no'] }]
  const round = { t: 'hello', product: 'harness', mac: 'aa:bb', fw: '1.0.0' }
  const who = { name: '', engine: '', machine: '' }   // q8 is on no list
  /** Nine questions rung live, then two changes of the window's list: what follows the drawers. */
  const afterDrawers = async (hello: Record<string, unknown>) => {
    const { session, port } = await connect(richHost())
    try {
      port.say(hello)
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      for (let i = 0; i < 9; i++) await session.question(`q${i}`, `id${i}`, ask)
      expect(ofType(port, 'question')).toHaveLength(9)
      port.sent.length = 0
      await session.replaceNotifications([{ agentId: 'b', machineId: 'm1', question: false, text: 'The build passed, all green.' }])
      await session.replaceNotifications([])
      expect(ofType(port, 'notif.replace')).toHaveLength(2)
      for (const drawer of ofType(port, 'notif.replace'))
        expect((drawer.items as Array<{ agentId: string }>).map((row) => row.agentId)).toEqual(['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'])
      return port.sent.filter((m) => m.t !== 'notif.replace')
    } finally { await session.stop() }
  }
  // A dial that says questionTier: the ninth goes back on it as a row after each drawer, with no ring.
  const row = { t: 'question', agentId: 'q8', ...who, id: 'id8', tier: 'list', questions: [{ key: '', q: 'Ship it?', options: [] }] }
  expect(await afterDrawers({ ...round, questionTier: 'v1' })).toEqual([row, row])
  // An older round dial would ring, and so would one that says a tier this daemon does not know: neither is sent it.
  expect(await afterDrawers(round)).toEqual([])
  expect(await afterDrawers({ ...round, questionTier: 'v2' })).toEqual([])
  // A Pro mutes a question sent again by its id and words: the plain frame, as before.
  const plain = { t: 'question', agentId: 'q8', ...who, id: 'id8', questions: [{ key: 'k', q: 'Ship it?', options: ['yes', 'no'], multi: false }] }
  expect(await afterDrawers({ ...PRO_HELLO })).toEqual([plain, plain])
})

it("a question the greeting's drawer carried was told: a later drawer that cuts it does not ring", async () => {
  const host = richHost()
  const { session, port } = await connect(host)
  const ask = [{ key: 'k', q: 'Ship it?', options: ['yes', 'no'] }]
  const eight = ['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7']
  try {
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb', fw: '1.0.0' })
    await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
    for (let i = 0; i < 9; i++) await session.question(`q${i}`, `id${i}`, ask)
    host.listUnread = () => [{ agentId: 'q8', machineId: 'm1', question: true, text: 'Ship it?' }]
    port.sent.length = 0
    // It rebooted. Its drawer carries q8's question as the window's row; the walk rings the eight it does not carry.
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb', fw: '1.0.1' })
    await vi.waitFor(() => expect(ofType(port, 'question')).toHaveLength(8))
    await settle()
    expect(ofType(port, 'question').map((m) => m.agentId)).toEqual(eight)
    port.sent.length = 0
    // Live: the drawer's eight rows are q0 to q7. q8 was shown as a row, so this older dial is not sent it again.
    await session.replaceNotifications([])
    expect(port.types()).toEqual(['notif.replace'])
    expect((port.sent[0].items as Array<{ agentId: string }>).map((item) => item.agentId)).toEqual(eight)
  } finally { await session.stop() }
})

it('a told question the dial lost, delivered again unchanged, follows the same rule and stays one small frame', async () => {
  const long = [{ key: 'k', q: `Ship  it?\n${'x'.repeat(6000)}`, options: ['yes', 'no'] }]
  const round = { t: 'hello', product: 'harness', mac: 'aa:bb', fw: '1.0.0' }
  const who = { name: 'Fix login screen', engine: 'claude', machine: '' }
  const again = async (hello: Record<string, unknown>) => {
    const { session, port } = await connect(richHost())
    try {
      port.say(hello)
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      await session.question('a1', 'q1', long)      // rang
      await session.turnDone('a1')                  // its turn moved on without a close: no longer owed
      await session.replaceNotifications([])        // the drawer drops its row
      port.sent.length = 0
      await session.question('a1', 'q1', long)      // the core asks again as the devices reconnect
      await session.question('a1', 'q1', long)      // and again: the dial holds it now
      return port.sent
    } finally { await session.stop() }
  }
  const row = { t: 'question', agentId: 'a1', ...who, id: 'q1', tier: 'list', questions: [{ key: '', q: `Ship it? ${'x'.repeat(230)}`, options: [] }] }
  expect(await again({ ...round, questionTier: 'v1' })).toEqual([row])
  expect(Buffer.byteLength(JSON.stringify(row), 'utf8')).toBeLessThan(600)
  expect(await again(round)).toEqual([])
  expect(await again({ ...PRO_HELLO })).toEqual([{ t: 'question', agentId: 'a1', ...who, id: 'q1', questions: long }])
})

it('a told question whose id the dial cannot keep is not given back, as a row or as the plain frame', async () => {
  const ask = [{ key: 'k', q: 'Ship it?', options: ['yes', 'no'] }]
  const id48 = 'x'.repeat(48)
  for (const hello of [{ t: 'hello', product: 'harness', mac: 'aa:bb', fw: '1.0.0', questionTier: 'v1' }, { ...PRO_HELLO }]) {
    const { session, port } = await connect(richHost())
    try {
      port.say(hello)
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      await session.question(id48, 'q1', ask)       // rung once, as at the base: told
      await session.replaceNotifications([])        // no row carries it
      port.sent.length = 0
      await session.question(id48, 'q1', ask)       // the core asks again as the devices reconnect
      await session.replaceNotifications([])
      expect(port.types()).toEqual(['notif.replace'])
    } finally { await session.stop() }
  }
})

it('a question delivered again while its row is being written is sent once', async () => {
  const { session, port } = await connect(richHost())
  const ask = [{ key: 'k', q: 'Ship it?', options: ['yes', 'no'] }]
  try {
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb', fw: '1.0.0', questionTier: 'v1' })
    await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
    for (let i = 0; i < 9; i++) await session.question(`q${i}`, `id${i}`, ask)
    port.sent.length = 0
    // The core asks q8 again at the moment the walk's row for it is on its way out.
    const write = port.write.bind(port)
    let again: Promise<void> | undefined
    port.write = async (bytes) => {
      await write(bytes)
      if (!again && port.types().at(-1) === 'question') again = session.question('q8', 'id8', ask)
    }
    await session.replaceNotifications([])
    await again
    expect(ofType(port, 'question')).toEqual([expect.objectContaining({ agentId: 'q8', tier: 'list' })])
  } finally { await session.stop() }
})

it('the welcome says question.tier only to a dial that says questionTier v1', async () => {
  const round = { t: 'hello', product: 'harness', mac: 'aa:bb', fw: '1.0.0' }
  const features = async (hello: Record<string, unknown>) => {
    const { session, port } = await connect(richHost())
    try {
      port.say(hello)
      await vi.waitFor(() => expect(port.types()).toContain('welcome'))
      return ofType(port, 'welcome')[0].features as string[]
    } finally { await session.stop() }
  }
  expect(await features({ ...round, questionTier: 'v1' })).toContain('question.tier')
  for (const hello of [round, { ...round, questionTier: 'v2' }, { ...round, questionTier: 'V1' }, { ...round, questionTier: true }, { ...PRO_HELLO }])
    expect(await features(hello)).not.toContain('question.tier')
})

it('names questionTier in the greeting line', async () => {
  const log = vi.fn()
  const { session, port } = await connect(richHost({ log }))
  try {
    port.say({ t: 'hello', product: 'harness', mac: 'aa:bb', fw: '1.0.0', questionTier: 'v1' })
    await vi.waitFor(() => expect(log.mock.calls.map(([line]) => line)).toContainEqual(expect.stringMatching(/caps questionTier$/)))
  } finally { await session.stop() }
})
```

In `describe('the app filter')`, "the fullest round-dial welcome is eight names" becomes "the fullest round-dial welcome is nine names". The file's `greeted(host, appFilter)` helper cannot say `questionTier` and is left as it is: this test connects itself with `connect(host)` (same `appHost({...})` host as now), says `{ t: 'hello', product: 'harness', mac: 'aa:bb', appFilter: 'v1', questionTier: 'v1' }`, waits for `notif.replace`, and expects

```ts
expect(features).toEqual(['voice.draft', 'agents.refresh', 'form', 'selection', 'visit', 'question.review', 'apps.switch', 'question.tier', 'settings'])
// The dial drops every feature of a welcome that lists more than 16 names.
expect(features.length).toBeLessThanOrEqual(16)
```

"the welcome lists apps.switch for a dial that says appFilter and a host that picks" is not changed: its dials say no `questionTier`.

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts -t "hello capabilities|the fullest round-dial welcome"`. Expected: the eight new or changed tests FAIL (a ninth question, or one asked again after its row left, is rung again as a plain `question` on every dial, an id the dial cannot keep included; no `tier`; no `question.tier` in the welcome; no `questionTier` in the log). The others in the selection pass, #4451's "an open question whose id the dial cannot keep is not carried as a row, nor asked again at each replace" included.
- [ ] **Step 3: Implement** `questionTier`, the welcome's `question.tier`, `giveQuestion`, `resendQuestions`, `question` and `fitDrawer`'s comment as above. Update the comments of `resendQuestions`, `question` and the capability field to say the rule and why (a ring at every change of the window's list, 2026-11-18).
- [ ] **Step 4: Run** `cd cli && npm run typecheck && npx vitest run src/cable/cableSession.spec.ts src/cable/cableFleet.spec.ts`. Expected: PASS, every other test unchanged.
- [ ] **Step 5: Commit** `Dial: a question the dial was told comes back as a silent row, never a ring`.

**End to end:** Task 10's two cases see the same frames after this task. Their fake dial says no `questionTier`, so its welcome is as before, and each question is told and carried by the drawer as a row (`forget(kept)` marks it asked and told), so `giveQuestion` sends nothing, as at the base; a re-ask that lands after a greeting's drawer finds a new, untold entry and rings once, as at the base. No end-to-end run after this task: check 4 runs them at the final head.

### Task 5: A refused question reaches the dial small and stays on its drawer

**Files:**
- Modify: `cli/src/cable/cableSession.ts` (`question`; not the legacy `answer` case, Decided here 17)
- Test: `cli/src/cable/cableSession.spec.ts`, `cli/src/cable/cableFleet.spec.ts`

**Depends on:** 3, 4. **Effort:** high.

**Interfaces:**
- Consumes: `QuestionInbox.set(): boolean` and unreadable entries (Task 3); `giveQuestion(agentId, id, questions, words)` (Task 4).
- Produces:
  - `question(agentId, id, questions)` with no raw path. An empty `agentId` or `id` returns at once, before `set`: nothing kept, nothing sent, no live turn (`dialKeepsId('')` is true, so `owed` would not stop it). Otherwise, after `set` and `liveTurns`, during a greeting it waits for the walk as today, and else it goes through the rule with the `questions` as they came when `set` answered true, and the entry's own `questions` (`read(agentId)`) when it answered false; `words` is the entry's first `q` either way.

- [ ] **Step 1: Write the failing tests.** In `describe('hello capabilities')`:

```ts
describe('a question the inbox refuses', () => {
  const text = `Approve  this\n\nplan? ${'Étape très longue. '.repeat(600)}`   // 12 kB: over the frame cap as it comes
  const plan = [{ key: 'plan', q: text, options: ['Approve', 'Keep planning'] }]
  let summary = ''
  for (const ch of text.split(/[ \t-\r]+/).filter(Boolean).join(' ')) {
    if (Buffer.byteLength(summary + ch, 'utf8') > 239) break
    summary += ch
  }
  summary = summary.trimEnd()
  const who = { name: 'Fix login screen', engine: 'claude', machine: '' }
  const ring = { t: 'question', agentId: 'a1', ...who, id: 'q1', questions: [{ key: '', q: summary, options: [], multi: false }] }

  it('reaches the dial as its small entry, rings once, is read as its summary and stays on the drawer until closed', async () => {
    const { session, port } = await connect(richHost())
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb', fw: '1.0.0' })
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      port.sent.length = 0
      await session.question('a1', 'q1', plan)
      await session.question('a1', 'q1', plan)   // the core asks again as the devices reconnect: nothing
      expect(port.sent).toEqual([ring])
      expect(Buffer.byteLength(JSON.stringify(ring), 'utf8')).toBeLessThan(600)
      port.sent.length = 0
      await session.replaceNotifications([])
      expect(port.sent).toEqual([{ t: 'notif.replace', items: [{ agentId: 'a1', name: who.name, machine: '', summary, question: true }] }])
      port.say({ t: 'question.read', agentId: 'a1', requestId: 'read-1' })
      await vi.waitFor(() => expect(port.types()).toContain('question.state'))
      const state = ofType(port, 'question.state')[0]
      expect(state).toMatchObject({ ok: true, agentId: 'a1', id: 'q1', requestId: 'read-1', submitted: false,
        questions: [{ key: '', q: summary, options: [] }] })
      port.say({ t: 'answer.reviewed', agentId: 'a1', requestId: 'send-1', token: state.token, choices: [1] })
      await vi.waitFor(() => expect(port.types()).toContain('answer.receipt'))
      expect(ofType(port, 'answer.receipt')[0]).toMatchObject({ ok: false })
      port.sent.length = 0
      await session.questionClose('a1', 'q1')
      await session.replaceNotifications([])
      expect(port.sent).toEqual([{ t: 'question.close', agentId: 'a1', id: 'q1' }, { t: 'notif.replace', items: [] }])
    } finally { await session.stop() }
  })

  it('reaches a Pro in the same words each time', async () => {
    const { session, port } = await connect(richHost())
    try {
      port.say({ ...PRO_HELLO })
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      port.sent.length = 0
      await session.question('a1', 'q1', plan)
      expect(port.sent).toEqual([ring])
      await session.turnDone('a1')
      await session.replaceNotifications([])   // its row leaves the dial
      port.sent.length = 0
      await session.question('a1', 'q1', plan)
      expect(port.sent).toEqual([ring])        // the Pro's mute is a hash of the id and these words
    } finally { await session.stop() }
  })

  it('with no agent or no id is not kept and not sent', async () => {
    const { session, port } = await connect(richHost())
    const ask = [{ key: 'k', q: 'Ship it?', options: ['yes', 'no'] }]
    try {
      port.say({ t: 'hello', product: 'harness', mac: 'aa:bb', fw: '1.0.0' })
      await vi.waitFor(() => expect(port.types()).toContain('notif.replace'))
      port.sent.length = 0
      await session.question('', 'q1', ask)
      await session.question('a1', '', ask)
      await session.question('a1', '', plan)
      await session.replaceNotifications([])
      expect(port.sent).toEqual([{ t: 'notif.replace', items: [] }])
    } finally { await session.stop() }
  })
})
```

In `cableFleet.spec.ts`, `describe('a dial plugged in beside one already attached')`:

```ts
it('is given a question the dial cannot answer, once, and the first dial is not asked again', async () => {
  const f = await firstAlone()
  try {
    await f.fleet.question('a', 'q1', [{ key: 'plan', q: `Approve? ${'x'.repeat(9000)}`, options: ['Approve', 'Keep planning'] }])
    expect(questions(f.ports[0])).toEqual(['a q1'])
    await plugSecond(f)
    await vi.waitFor(() => expect(questions(f.ports[1])).toEqual(['a q1']))
    await flush()
    expect(questions(f.ports[1])).toEqual(['a q1'])
    expect(questions(f.ports[0])).toEqual(['a q1'])
  } finally { await f.fleet.stop() }
})
```

- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/cableSession.spec.ts src/cable/cableFleet.spec.ts`. Expected: the four new tests FAIL (the 12 kB frame is dropped or sent as it came; a question with no agent is sent; the fleet's second dial gets nothing it can file); the legacy `answer` tests, #4451's "repeats a key or an option" included, pass unchanged.
- [ ] **Step 3: Implement** `question()` as above, and update its comment: one the inbox cannot hold is kept and sent as its summary, never as it came (a plan of kilobytes passed the frame cap).
- [ ] **Step 4: Run** `cd cli && npm run typecheck && npx vitest run src/cable/questionInbox.spec.ts src/cable/cableSession.spec.ts src/cable/cableFleet.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `Dial: a refused question reaches the dial small and stays on its drawer`.

**End to end:** Task 10's two cases see the same frames after this task. Their questions (a notice card, an Orca wait) each have one option, so the inbox holds them as they came (`set` answers true) and nothing of this task applies to them. No end-to-end run after this task: check 4 runs them at the final head.

### Task 6: Firmware: a `question` with `tier: 'list'` files its row silently

**Done:** landed as `762a982828` (red), `362565ec7f`.

**Files** (under `devices/harness-device/firmware/`):
- Modify: `main/ui/habitat/ui_habitat.c` (`ui_question_show`, a new `notice_question_read` after `notice_was_read`), `main/ui/ui_screens.h`, `main/ui/ui_perf.c`, `main/cable_client.c` (`handle_question`)
- Test: `test/test_question_ui.py`, `test/test_cable_identity.py`

**Depends on:** none. **Effort:** high.

**Interfaces:**
- Produces:
  - `bool ui_question_show(const char *project_id, const char *agent_name, const char *machine, const char *request_id, const struct cJSON *questions, bool list);` — `list` true: the row is filed with no `notice_forget_read`, no `display_wake`, and the answer is false (no beep). Everything else is as an alert: the row is added, the pane on the face is read at once, a different request for the agent being read still invalidates it.
  - `static bool notice_question_read(const cable_notif_t *n)` — true when a receipt in `s.notice_reads` holds that agent's question (`question` true, same `id`) with the same `summary`, whatever its token. A `list` row it matches is set `read_on_dial`; it never un-reads a row.
  - `handle_question` passes `list` true only when the frame's `tier` is the string `list`.

- [ ] **Step 1: Write the failing tests.**

In `test_question_ui.py`, the harness first: import `typedef` from `native_shapes`; add `'NOTICES'` to the `defines(..., source=source)` line; add `code += typedef('cable_notif_t')` before the block that starts with `typedef struct cJSON`; add `notice_receipt_t notice_reads[NOTICES];` to the harness's `s`; add `'notice_question_read'` before `'ui_question_show'` in the function list; give the five existing `ui_question_show(...)` calls a last argument `false`; and replace the two doubles:

```c
static cable_notif_t filed;
static int forgets;
static cable_notif_t *notice_add(const char *id,const char *name,const char *machine,const char *text,bool question,bool failed) {
    assert(!failed); // Asking a question cannot manufacture a failure notification.
    (void)name;(void)machine;assert(question);notices++;
    memset(&filed,0,sizeof filed);snprintf(filed.agent_id,sizeof filed.agent_id,"%s",id);
    snprintf(filed.summary,sizeof filed.summary,"%s",text);filed.question=true;return &filed;
}
static void notice_forget_read(const char *id,bool questions_too) { assert(id && *id && questions_too);forgets++; }
```

Then, after the "pane on the face" assertions in `main`:

```c
    // Filed again with no ring (tier list: a question the dial was told, back on its drawer): no wake, no beep, the
    // receipts kept, and the row read when a receipt holds that agent's question with the same words, whatever its token.
    {
        cJSON fields[]={{.string="key",.type=JSTRING,.valuestring=""},
            {.string="q",.type=JSTRING,.valuestring="Deploy now?"}};
        cJSON question=object(fields,2),questions={.type=JARRAY,.child=&question};
        reset(false);view(HOME);wakes=0;notices=0;forgets=0;read_now=0;
        assert(!ui_question_show("b","Other","M2","q-b4",&questions,true) && s.view==HOME && !wakes && notices==1 && !forgets && !read_now);
        assert(!filed.read_on_dial);                          // never read: it comes back unread
        notice_receipt_t *r=&s.notice_reads[3];
        strcpy(r->id,"b");strcpy(r->summary,"Deploy now?");strcpy(r->token,"turn-7");r->question=true;
        assert(!ui_question_show("b","Other","M2","q-b4",&questions,true) && filed.read_on_dial && !forgets);
        strcpy(r->summary,"Deploy later?");                   // other words: another question
        assert(!ui_question_show("b","Other","M2","q-b4",&questions,true) && !filed.read_on_dial);
        strcpy(r->summary,"Deploy now?");r->question=false;   // its news's receipt is not its question's
        assert(!ui_question_show("b","Other","M2","q-b4",&questions,true) && !filed.read_on_dial);
        r->question=true;strcpy(r->id,"c");                   // another agent's
        assert(!ui_question_show("b","Other","M2","q-b4",&questions,true) && !filed.read_on_dial);
        // An alert still forgets the read, wakes and asks for the beep.
        strcpy(r->id,"b");wakes=0;
        assert(ui_question_show("b","Other","M2","q-b4",&questions,false) && wakes==1 && forgets==1 && !filed.read_on_dial);
        // The pane on the face: read at once, as an alert's is.
        face_agent="b";read_now=0;
        assert(!ui_question_show("b","Other","M2","q-b4",&questions,true) && read_now==1);
        face_agent="";
        // The question being read on screen is left as it is.
        reset(false);wakes=0;
        assert(!ui_question_show("a","Research","M2","q-a",&questions,true) && s.view==QUESTION && s.q.valid && !s.q.error[0] && !wakes);
    }
```

In `test_cable_identity.py`, add these doubles before the functions are appended, add `'handle_question'` to the function list, and the assertions to `main`:

```c
static unsigned shows,beeps;
static bool shown_list;
static char shown_request[80];
static bool ui_question_show(const char *id,const char *name,const char *machine,const char *request,const cJSON *questions,bool list) {
    (void)name;(void)machine;assert(id&&questions);shows++;shown_list=list;
    snprintf(shown_request,sizeof shown_request,"%s",request?request:"");return !list;
}
static void audio_notify_done(void) { beeps++; }
```

```c
    // `question` with tier "list" files a silent row: no beep. With no tier, or any other, it is an alert.
    p=cJSON_Parse("{\"id\":\"q1\",\"tier\":\"list\",\"questions\":[{\"key\":\"\",\"q\":\"Ship it?\",\"options\":[]}]}");
    assert(p);handle_question(p,"a");cJSON_Delete(p);assert(shows==1&&shown_list&&!beeps&&!strcmp(shown_request,"q1"));
    const char *alerts[]={"{\"id\":\"q1\",\"questions\":[]}","{\"id\":\"q1\",\"tier\":\"alert\",\"questions\":[]}",
        "{\"id\":\"q1\",\"tier\":\"silent\",\"questions\":[]}","{\"id\":\"q1\",\"tier\":5,\"questions\":[]}",
        "{\"id\":\"q1\",\"tier\":\"LIST\",\"questions\":[]}"};
    for(unsigned i=0;i<sizeof alerts/sizeof *alerts;i++) {
        p=cJSON_Parse(alerts[i]);assert(p);handle_question(p,"a");cJSON_Delete(p);
        assert(shows==2+i&&!shown_list&&beeps==1+i);
    }
    // No questions, or no agent: nothing, as before.
    p=cJSON_Parse("{\"id\":\"q1\",\"tier\":\"list\"}");assert(p);handle_question(p,"a");cJSON_Delete(p);
    p=cJSON_Parse("{\"id\":\"q1\",\"questions\":[]}");assert(p);handle_question(p,NULL);cJSON_Delete(p);
    assert(shows==6&&beeps==5);
```

- [ ] **Step 2: Run** `python3 devices/harness-device/firmware/test/test_question_ui.py` and `IDF_PATH=$HOME/esp/esp-idf python3 devices/harness-device/firmware/test/test_cable_identity.py`. Expected: both FAIL (`AssertionError: notice_question_read`; `handle_question` calls `ui_question_show` with five arguments).
- [ ] **Step 3: Implement** the three interfaces above. Update the comment over the declaration in `ui_screens.h` (what `list` means and that it never beeps), the comment over `handle_question` (`question` {agentId, id, questions, tier?}), and pass `false` in `ui_perf.c`. Leave `notice_add`, `notice_unread` and the `s.notice_sequence++` line as they are. Check the row for NULL before reading it.
- [ ] **Step 4: Run** both tests again, then `python3 devices/harness-device/firmware/test/test_touch_ui.py`, then `grep -rn "ui_question_show(" devices/harness-device/firmware/main`. Expected: PASS three times; four lines, each call with six arguments (the call in `ui_perf.c` is compiled only with `DEVICE_PERF_BENCH`, so no default build checks it).
- [ ] **Step 5: Commit** `Dial firmware: a question with tier list files its row silently`.

### Task 7: Firmware: the hello says `questionTier: 'v1'`, and only a welcome's `question.tier` makes `tier: 'list'` silent

**Files** (under `devices/harness-device/firmware/`):
- Modify: `main/cable_features.h` (a new bit), `main/cable_features.c` (`cable_features_parse`'s `names`), `main/cable_client.c` (`send_hello`, `handle_question`)
- Test: `test/test_cable_features.c`, `test/test_cable_outbound.py`, `test/test_cable_identity.py`

**Depends on:** none left: Task 6 (done) put the `list` argument in `handle_question`, and #4441's `CABLE_FEATURE_APPS_SWITCH` (`1u << 7`) is on the base. A build must never say `questionTier` before it files `tier: 'list'` silently, and Task 6 landed first. **Effort:** high.

**Interfaces:**
- Consumes: `handle_question` and its `list` argument to `ui_question_show` (Task 6); `bool cable_client_supports(uint32_t features)` (`cable_client.h`, which includes `cable_features.h`).
- Produces:
  - `CABLE_FEATURE_QUESTION_TIER = 1u << 8` in `cable_features.h`, after `CABLE_FEATURE_APPS_SWITCH`, with a comment like #4441's: the daemon sends a told question back as a `tier: 'list'` row; without the bit the dial treats such a frame as an alert, so an older daemon never mutes a ring.
  - `cable_features_parse`'s `names` maps the exact name `question.tier` to it.
  - `send_hello` adds `msg_string(&root, "questionTier", "v1");` after `appFilter`.
  - `handle_question` passes `list` true only when `cable_client_supports(CABLE_FEATURE_QUESTION_TIER)` and the frame's `tier` is the string `list` (Decided here, 16).

- [ ] **Step 1: Write the failing tests.**

In `test_cable_features.c`, after the `apps.switch` checks:

```c
    check("{\"features\":[\"question.tier\"]}", CABLE_FEATURE_QUESTION_TIER);
    check("{\"features\":[\"Question.tier\",\"question.Tier\",\"question\",\"tier\",\"questionTier\",\"question.tier.2\"]}", 0);
```

the fullest welcome becomes the daemon's nine names (Task 4), every bit:

```c
    // The daemon's fullest round-dial welcome sets every bit.
    check("{\"features\":[\"voice.draft\",\"agents.refresh\",\"form\",\"selection\",\"visit\","
          "\"question.review\",\"apps.switch\",\"question.tier\",\"settings\"]}", 511u);
```

and after `assert(!(CABLE_FEATURE_APPS_SWITCH & (CABLE_FEATURE_SETTINGS | 63u)));`:

```c
    assert(!(CABLE_FEATURE_QUESTION_TIER & 255u));
```

In `test_cable_outbound.py`, inside the block after `send_hello()` that parses the hello and checks `appFilter`:

```c
      const cJSON *tier=cJSON_GetObjectItemCaseSensitive(hello,"questionTier");
      assert(cJSON_IsString(tier)&&!strcmp(tier->valuestring,"v1"));
```

In `test_cable_identity.py`, which has no `cable_client_supports` at the base: a double after Task 6's `ui_question_show` double and `audio_notify_done` (non-static: `cable_client.h` declares it):

```c
static uint32_t welcome_features;
bool cable_client_supports(uint32_t features) { return (welcome_features & features) == features; }
```

In `main`, before Task 6's first `handle_question` assertion (the comment "`question` with tier "list" files a silent row"), since those assertions are the session whose welcome listed `question.tier`:

```c
    welcome_features=CABLE_FEATURE_QUESTION_TIER;
```

and after Task 6's last `handle_question` assertion (`assert(shows==6&&beeps==5);`):

```c
    // A welcome without question.tier (an older daemon, or no welcome yet): tier "list" is an alert.
    const uint32_t without[]={0,~(uint32_t)CABLE_FEATURE_QUESTION_TIER};
    for(unsigned i=0;i<sizeof without/sizeof *without;i++) {
        unsigned shows_before=shows,beeps_before=beeps;welcome_features=without[i];
        p=cJSON_Parse("{\"id\":\"q1\",\"tier\":\"list\",\"questions\":[]}");assert(p);handle_question(p,"a");cJSON_Delete(p);
        assert(shows==shows_before+1&&!shown_list&&beeps==beeps_before+1);
    }
```

- [ ] **Step 2: Run**, from the repo root:
  - `F=devices/harness-device/firmware; J=$HOME/esp/esp-idf/components/json/cJSON; cc -std=c11 -Wall -Wextra -Werror -Wno-deprecated-declarations -O1 -g -fsanitize=undefined,bounds -I $F/main -I $J -o /tmp/test_cable_features $F/test/test_cable_features.c $F/main/cable_features.c $J/cJSON.c && /tmp/test_cable_features` (the command `run.sh` uses)
  - `IDF_PATH=$HOME/esp/esp-idf python3 devices/harness-device/firmware/test/test_cable_outbound.py`
  - `IDF_PATH=$HOME/esp/esp-idf python3 devices/harness-device/firmware/test/test_cable_identity.py`

  Expected: all three FAIL (`CABLE_FEATURE_QUESTION_TIER` undeclared in the first and third; the hello's `questionTier` assertion in the second).
- [ ] **Step 3: Implement** the four interfaces above. The comment over `send_hello`'s line: this dial files a `question` with `tier: "list"` as a silent row once the welcome lists `question.tier`; an older daemon ignores the field and never sends the tier. Update the comment over `handle_question` to say the gate.
- [ ] **Step 4: Run** Step 2's three commands, then `python3 devices/harness-device/firmware/test/test_question_ui.py` and `python3 devices/harness-device/firmware/test/test_touch_ui.py` (both include `cable_features.h`). Expected: PASS five times.
- [ ] **Step 5: Commit** `Dial firmware: the hello says questionTier v1, and the welcome's question.tier makes a list question silent`.

### Task 8: Firmware: a question the dial cannot answer shows its words

**Done:** landed as `1e6595e5f7` (red), `7cea6d4b5b`.

**Files** (under `devices/harness-device/firmware/`):
- Modify: `main/ui/habitat/ui_habitat.c` (`render_question` only)
- Test: `test/test_question_ui.py`

**Depends on:** none. **Effort:** high.

**Interfaces:**
- Produces: in `render_question`'s branch for `s.q.error[0] || !s.q.valid || !s.q.supported`: with no error, a valid question and a first prompt whose every character Inter draws (`ui_can_display(prompt, UI_FONT, 336, INT_MAX)`, non-empty), the five lines show that prompt in `FG`; otherwise today's text in `DIM`. Same `ui_wrap` call (336 wide, five lines), same `[ on desktop ]`. It uses only functions both `test_question_ui.py` and `test_touch_ui.py` already extract.

- [ ] **Step 1: Write the failing test.** In `test_question_ui.py`, a helper before `main`:

```c
static bool shows(const char *words) {
    static ht_scene_t scene;ht_scene_clear(&scene,BG);s.hit_count=0;render_question(&scene);
    for(int i=0;i<scene.count;i++) if(strstr(scene.runs[i].text,words)) return true;
    return false;
}
```

and in `main`:

```c
    // A question the dial cannot answer says what is asked: its first question's words, then [ on desktop ].
    {
        static const char *plan="Approve this plan? It moves the parser into its own module, deletes the old reader, renames the public API, rewrites every test that touches them and ends on the word zebra";
        cJSON fields[]={{.string="key",.type=JSTRING,.valuestring=""},
            {.string="q",.type=JSTRING,.valuestring=plan},
            {.string="options",.type=JARRAY}};
        cJSON question=object(fields,3),questions={.type=JARRAY,.child=&question};
        reset(false);question_load(&questions);view(QUESTION);
        assert(s.q.valid && !s.q.supported && ui_rows(plan,UI_FONT,336)>5);
        assert(shows("Approve this") && !shows("needs the desktop") && shows("[ on desktop ]") && s.hit_count==2);
        assert(!shows("zebra"));                               // cut at the five lines
        render(dir,"unanswerable");
        // A letter Inter does not draw: the sentence, as before.
        fields[1].valuestring="Approve \xe9\x9b\xaa?";question_load(&questions);
        assert(!s.q.supported && shows("needs the desktop") && !shows("Approve") && shows("[ on desktop ]"));
        // No words, an error, or a question answered elsewhere: as before.
        fields[1].valuestring="";question_load(&questions);assert(shows("needs the desktop"));
        fields[1].valuestring="Approve this plan?";question_load(&questions);
        COPY(s.q.error,"Could not load the question.");assert(shows("Could not load") && !shows("Approve"));
        s.q.error[0]=0;s.q.valid=false;assert(shows("Answered elsewhere.") && !shows("Approve"));
    }
```

- [ ] **Step 2: Run** `python3 devices/harness-device/firmware/test/test_question_ui.py`. Expected: FAIL at `shows("Approve this")`.
- [ ] **Step 3: Implement** as above, with a comment: a plan to approve, or a shape the inbox refused, opens to what is asked instead of a sentence that names nothing (2026-11-18).
- [ ] **Step 4: Run** the same command and `python3 devices/harness-device/firmware/test/test_touch_ui.py`. Expected: PASS twice. With `HABITAT_PREVIEW_DIR=<a scratch folder>` the first writes `unanswerable.ppm`; the implementer looks at it and names its path in the report.
- [ ] **Step 5: Commit** `Dial firmware: a question the dial cannot answer shows its words`.

### Task 9: Firmware: the drawer's reader keeps a row per agent and kind

**Done:** landed as `46eef9c23b` (red), `20259ed224`.

**Files** (under `devices/harness-device/firmware/`):
- Modify: `main/cable_client.c` (`handle_notifications`)
- Test: `test/test_cable_identity.py`

**Depends on:** none. **Effort:** medium.

**What is known** (spec, "A question and a news row of one agent both reach the dial"; read at `a490c22c39`):
- A `notif.replace` row carries `agentId`, `name`, `machine`, `summary`, `question`, `failed`, `readToken`. There is **no question id**, so the key is the agent id and `question`.
- Nothing sends both rows of one agent in one frame today. The window's list holds one mark per agent (Desktop `AgentUnread`, the newest kind wins). `CableHost.listUnread` puts the devices' own rows first, all of them questions, and leaves out the window's row of an agent they name. The daemon's drawer puts an agent's open question in the place of its news (`replaceNotifications`, `rest`).
- Past the reader, `ui_notif_replace` keeps both rows only when the news row comes before the question row. With the question first, the daemon's drawer order, filing the question removes the news (`notice_add`). This task does not change that (open question 1).

So this task changes the reader only. No frame of the daemon changes.

- [ ] **Step 1: Write the failing test.** In `test_cable_identity.py`'s `main`, after the `failed`/`question` assertions:

```c
    // An agent's question and its news are two rows (the drawer keeps a row per agent and kind), in either order.
    // A second row of one agent and kind is still dropped. A row carries no question id: the kind is the whole key.
    p=cJSON_Parse("{\"items\":[{\"agentId\":\"a\",\"question\":true,\"summary\":\"Ship it?\"},{\"agentId\":\"a\",\"summary\":\"Built.\"},"
        "{\"agentId\":\"a\",\"question\":true,\"summary\":\"Again?\"},{\"agentId\":\"a\",\"summary\":\"Again.\"},{\"agentId\":\"b\",\"summary\":\"Done.\"}]}");
    assert(p);handle_notifications(p);cJSON_Delete(p);
    assert(notice_count==3 && notices[0].question && !strcmp(notices[0].summary,"Ship it?") &&
           !notices[1].question && !strcmp(notices[1].agent_id,"a") && !strcmp(notices[1].summary,"Built.") &&
           !strcmp(notices[2].agent_id,"b"));
    p=cJSON_Parse("{\"items\":[{\"agentId\":\"a\",\"summary\":\"Built.\"},{\"agentId\":\"a\",\"question\":true,\"summary\":\"Ship it?\"}]}");
    assert(p);handle_notifications(p);cJSON_Delete(p);
    assert(notice_count==2 && !notices[0].question && notices[1].question);
```

- [ ] **Step 2: Run** `IDF_PATH=$HOME/esp/esp-idf python3 devices/harness-device/firmware/test/test_cable_identity.py`. Expected: FAIL (`notice_count` is 2, then 1).
- [ ] **Step 3: Implement:** a row is a duplicate when an earlier row has the same `agent_id` and the same `question`. Comment: since #4445 the drawer keeps an agent's question and its news as two rows; one row an agent here dropped the second.
- [ ] **Step 4: Run** the same command. Expected: PASS, the existing one-row-per-agent assertions included (their rows are all news).
- [ ] **Step 5: Commit** `Dial firmware: the drawer's reader keeps a row per agent and kind`.

### Task 10: End to end: an open question comes back as a drawer row

**Done:** landed as `06681f53da`.

**Files:**
- Test: `cli/e2e/deviceNotify.e2e.ts`, `cli/e2e/deviceClaudeOrca.e2e.ts`

**Depends on:** none (starts at once). **Effort:** high (two files, the real daemon). **Red test:** none of its own. A test-only change, one commit: its two cases are red at the base, and that is the "failing first" evidence.

**Why they are red** (read at `a490c22c39`): before #4445, every `notif.replace` cleared the inbox's marks and asked each open question again, so the dial got a second `question` frame. Since #4445, `replaceNotifications` carries each open question as a row of the drawer (`question: true`, its words as `noticeSummary` cuts them) and `forget(kept)` marks the questions it carries as asked, so `resendQuestions` sends them no frame. Both cases still wait 45 s for that frame:
- `deviceNotify.e2e.ts`, "an outside Claude Code session's notice is its own card, read without closing it, and closed by its next prompt": after `agents.list`, `pushAgents` ends with a drawer from `CableHost.listUnread`, whose first rows are the devices' own (`noticeRows`: the pending notice cards). Fails with `heard no the card sent again with the list`.
- `deviceClaudeOrca.e2e.ts`, "the dial shows the agent waiting with "printf hi · answer in Orca", as a question nothing answers, and its Stop ends the wait": the dial plugged in again greets; the greeting's drawer carries the wait from `noticeRows` (the devices' `shown` map), and the forget that follows marks it asked. Fails with `heard no the question again`.

Neither case changes after Tasks 4 and 5 (their "End to end" notes): the fake dial (`e2e/harness/fakeDial.ts`) says no `questionTier`.

- [ ] **Step 1: See them fail.** `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceNotify.e2e.ts e2e/deviceClaudeOrca.e2e.ts -t "notice is its own card, read without closing it|the dial shows the agent waiting"`. Expected at the base: 2 failed, with the two messages above, the others skipped. About two minutes.
- [ ] **Step 2: `deviceNotify.e2e.ts`.** In that case, replace the wait for `'the card sent again with the list'` with the list's drawer and its row:

```ts
    // Opening the alert to read it leaves the card. The list asked after it is the barrier: the daemon has handled the
    // read, and whatever it sent for it, by the time the list's drawer is sent. A drawer carries the dial's open
    // questions as rows instead of asking them again (#4445): the card is one of them.
    let since = dial.messages.length
    dial.send({ t: 'question.read', agentId: engine.id, requestId: 'read-1' })
    const state = await dial.next((m) => m.t === 'question.state' && m.requestId === 'read-1', 45_000, 'the card read', since)
    expect(state).toMatchObject({ ok: true, id: question.id, questions: card('Ghostty') })
    since = dial.messages.length
    dial.send({ t: 'agents.list' })
    const drawer = await dial.next((m) => m.t === 'notif.replace', 45_000, 'the drawer sent with the list', since)
    expect(drawer.items).toContainEqual(expect.objectContaining({ agentId: engine.id, name: 'fix-login', summary: LINE, question: true }))
```

  The lines after it stay: the same card id each time, never a second one, never closed, then closed by the next prompt.
- [ ] **Step 3: `deviceClaudeOrca.e2e.ts`.** In that case, replace the wait for `'the question again'` with the first drawer's row:

```ts
    // A dial plugged in again holds it as a row of its first drawer, the devices' own questions first: a drawer carries
    // an open question as a row instead of asking it again (#4445).
    await desk.unplug('E2E-A')
    dial = await plugged(desk)
    const drawer = await dial.next((m) => m.t === 'notif.replace', 45_000, 'the drawer')
    expect(drawer.items).toContainEqual(expect.objectContaining({ agentId: claude.id, name: 'in-orca', summary: 'printf hi · answer in Orca', question: true }))
```

  In the file's header, "(every answer to it refused, and asked again of a dial plugged in again)" becomes "(every answer to it refused, and a row of the drawer of a dial plugged in again)". The rest of the case stays: the session's Stop still closes the question by its id, since the devices ask it again as the dial attaches and the new session's inbox holds it.
- Neither case asserts that no second `question` frame comes. There is no barrier after the drawer to wait on, and the devices' ask as a dial attaches can land after the greeting's drawer, find an entry nobody told and ring it once, at the base as after this plan.
- [ ] **Step 4: Run** Step 1's command. Expected: 2 passed (`npm run typecheck` does not read `e2e/`; vitest compiles both files).
- [ ] **Step 5: Commit** `test(dial): end to end, an open question comes back as a drawer row (#4445)`.

---

## The pull request's body

- **Platforms:** the daemon on macOS, Linux and Windows (one code path; unit tests on Linux in PR CI, and on this Mac). The round dial: firmware built and host-tested, not flashed in this pull request. The Harness Pro: no firmware change; the daemon sends it what it sent before, and a refused question as its summary.
- **Fixes the end-to-end reds from #4445 (deviceNotify, deviceClaudeOrca).** Test-only (Task 10): each case now reads the open question as a row of the drawer, which #4445 sends in place of a second `question` frame.
- **Evidence:** each task's red commit and code commit; Task 10's two cases red at the first base (`275512c33a`) and green after it; the receipts of Verification checks 1 to 4; `HABITAT_PREVIEW_DIR`'s `unanswerable.ppm` as a picture.
- **Declared as #4441 declares `apps.switch`:** `hello.questionTier: 'v1'`, answered by `question.tier` in `welcome.features`; the firmware files `tier: 'list'` silently only with that feature. The fullest round-dial welcome is 9 names (limit 16).
- **Says plainly:** an older round dial is never sent a told question again, so its row for a ninth or later question is missing until its next greeting. A question the inbox refuses reaches every dial only as its summary; the reviewed answer, `canSpeak` and `draft` refuse it, and the legacy `answer` frame is left as #4451 made it (an older dial answering the raw question it was sent). End to end on a real dial is harness-pm's, after its flash.

## Verification

**Never touched:** a plugged-in dial or its port, the everyday daemon (port 18473), `~/.claude`, `~/.codex`, any backend, production. No account and no sign-in is used by any check.

**Temporary workflow:** none. No check here is long: the two firmware builds take about two and a half minutes on this Mac, and the default build's product is the image harness-pm flashes from this Mac, so it is built here anyway. A second build on GitHub would prove nothing more, and the repo starts no extra runs. The host tests already run on every pull request (`firmware-checks`). Proposal, not built: a permanent `dial-firmware-build` check like the Pro's `pro-firmware-build`, since PR CI builds the Pro's firmware and not the round dial's.

**Local gates the repo requires for these paths:** none. `python3 scripts/local-checks.py --list <this plan's files>` prints `{}` at the first base; run it again with `cli/src/cable/dialText.ts` among the files. `npm run test:core` covers `cli/src/core/**` and `cli/src/services/**` only, and `cli-serial` only `cli/src/cable/serial*.ts` and `windowsSerial*.ts`: no file of this plan is under either. Still run `python3 scripts/local-checks.py --run` from a clean tree at the final commit and paste what it prints. If a task had to touch `cli/src/services/devices.ts`, `cli-core` becomes required.

**1. The firmware builds** (this Mac, the final head; built, never flashed)
- Free disk first: about 300 MB for the two build folders (134 MB each at the base).
- Run, from the repo root:
  ```bash
  . ~/esp/esp-idf/export.sh
  B=/tmp/dial-drawer-limits-build; mkdir -p "$B"; rm -f "$B"/*.sdkconfig
  idf.py -C devices/harness-device/firmware -B "$B/default" -DSDKCONFIG="$B/default.sdkconfig" -DPROJECT_VER=0.1.0-dev build
  idf.py -C devices/harness-device/firmware -B "$B/bench" -DSDKCONFIG="$B/bench.sdkconfig" -DPROJECT_VER=0.1.0-dev -DDEVICE_PERF_BENCH=1 build
  git status --short devices/
  ```
- A person sees: `Project build complete.` twice, `/tmp/dial-drawer-limits-build/default/interns_commander.bin` present, and `git status` printing nothing (a changed `dependencies.lock` is reverted, never committed). The `bench` build is the only compiler that sees the changed call in `ui_perf.c`.
- The report names the `.bin`'s path and SHA-256 for harness-pm. `0.1.0-dev` is a dev build: the daemon never offers it an update.
- On GitHub: none (above).

**2. The firmware's host tests** (this Mac, the final head)
- Run: `env -u IDF_PATH make device-test`, then Task 7's `test_cable_features.c` command, then each of `test_cable_identity.py`, `test_cable_outbound.py`, `test_cable_json_parse.py`, `test_cable_crc.py` and `test_cable_models.py` under `devices/harness-device/firmware/test/` with `IDF_PATH=$HOME/esp/esp-idf python3 <file>`.
- A person sees: every one passes, except `test_cable_models.py`, which fails to build on macOS at the base too (`'snprintf' macro redefined`). Any other failure is this branch's.
- On GitHub, by itself: `firmware-checks` runs every `test_*.py` on Linux, `test_cable_models.py` included.

**3. The daemon's specs** (this Mac, the final head)
- Run: `cd cli && npm run typecheck && npx vitest run src/cable/questionInbox.spec.ts src/cable/cableSession.spec.ts src/cable/cableFleet.spec.ts src/architecture.spec.ts`.
- A person sees: all pass, none skipped. `git diff --stat "$(git merge-base HEAD origin/main)" -- cli/src/core cli/src/services cli/src/architecture.coreFiles.txt devices/harness-pro` prints nothing.
- On GitHub, by itself: `cli-typecheck` and `cli-tests` on Linux.

**4. The real daemon and a fake dial: nothing else moved** (this Mac, the final head)
- The four end-to-end files that read a dial's `question` frames or drawer. Isolation is the suite's own (`cli/e2e/harness/daemon.ts`, cli/AGENTS.md rules 5 and 6): a throwaway home and data folder, a private port and tmux server, fake engines, a fake dial on a pseudo-terminal that says no `questionTier`.
- Run: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceNotify.e2e.ts e2e/deviceClaudeOrca.e2e.ts e2e/deviceCompat.e2e.ts e2e/fleet.e2e.ts`. About six minutes.
- A person sees: every test passes, none skipped, the two Task 10 fixed included, red at the first base `275512c33a` (`deviceNotify` "an outside Claude Code session's notice is its own card ..." and `deviceClaudeOrca` "the dial shows the agent waiting ..."). Not run at `7cea6d4b5b` by the planner.
- On GitHub, by hand: Actions → CLI end to end → Run workflow on `fix/dial-drawer-limits` (`.github/workflows/cli-e2e.yml`, the whole suite in eight shards). Not started for this change unless the orchestrator asks: these four files are every one that reads a dial's questions.

**5. On a real dial (needs harness-pm itself: its flash, its dial, its eye; after this plan, not by any agent of it)**
- After harness-pm flashes check 1's image, macOS first: 10 open questions, the window's list changed twice, one beep per question; a 10 kB plan question shows as a row and opens to its words with `[ on desktop ]`.

**6. In PR CI, by itself:** `cli-typecheck`, `cli-tests`, `companions` and `pty-checks` (a `cli/` change runs them), `firmware-checks` (`devices/`), `process-checks` (the docs). No Pro job: nothing under `devices/harness-pro/` changes. Nothing is started by hand.

**7. Numbers** (root rule 4, idle daemon work), held by the specs:
- at rest: nothing new runs. No timer, no poll;
- the welcome: one name more (`question.tier`) for a dial that says `questionTier`. The fullest round-dial welcome is 9 names, under the firmware's bound of 16 (Task 4's test);
- per `notif.replace`: one frame under 600 bytes for each open question past the drawer's eight rows, at most 56 (the inbox holds 64). Before: the same count of full `question` frames, up to 6.5 kB each, and a beep for each.

**8. Against production:** none, and never.

## Proposals

Not built in this branch.

- Send every `question` frame in the inbox's own shape instead of as it came. An answerable question whose raw frame passes the cap because of fields the inbox drops is still dropped by `send` today, and only its drawer row reaches the dial.
- An end-to-end case with a fake dial that says `questionTier: 'v1'` and nine questions.
- A permanent `dial-firmware-build` check in PR CI.
