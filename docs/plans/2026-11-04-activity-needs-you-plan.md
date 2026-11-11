# Activity shows only what needs you: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activity's number counts only what the reader must decide; decisions left 24 hours go to the PM; Let PM decide
for all; Mark read for mentions and threads; a tabbed, Slack-like view.

**Architecture:** The backend gains one hourly sweep that answers overdue decisions through the existing
`decision.answer` delegate path, marked `overdue`. Everything else is Desktop: the count rule in `activity.dart`, pure row
helpers in a new `activity_rows.dart`, batch actions on the existing decision/mention/thread controllers, and a rewritten
`activity_view.dart`.

**Tech Stack:** TypeScript, Prisma on MongoDB, vitest (backend); Flutter/Dart, flutter_test (Desktop).

**Spec:** `docs/specs/2026-11-04-activity-needs-you.md`

## Global Constraints

- Overdue means `createdAt + 24h` has passed: `OVERDUE_DECISION_MS = 24 * 60 * 60_000`. The clock never restarts.
- Every hourly pass reads waiting decisions with `createdAt` in `(now - 8d, now - 24h]`, at most 500, oldest first
  (changed after review: no in-memory cursor, so capped or failed rows are retried).
- Sweep operation id: `overdue-decision-<decisionId>` (operation ids allow only `[A-Za-z0-9_-]`).
- Overdue notice, exact: `A decision asked in this conversation waited 24 hours, so it was left to the ${name}, who took its recommended option. `
- Failure log, exact: `[swarm-sweeps] overdue decisions failed`, at error level, every failed pass.
- New index: `@@index([answeredAt, createdAt], map: "decision_waiting_created")` on `SuperTabDecision`. Query it with `aggregateRaw` `$match`,
  never a Prisma `in` (backend/AGENTS.md rule 3).
- Desktop copy, exact: tabs `Needs you`, `Mentions`, `Threads`; `Unreads only`; `Mark read`; `Mark all read`;
  `Let {name} decide for all`; dialog title `Let {name} decide all {n}?`; confirm `Let {name} decide`; bar
  `{name} takes over anything you leave for 24 hours`; empty `Nothing needs you`; `{name} handled {n} for you today`;
  `See what`; `PM in {h}h`, `PM in <1h`; `+{n} more from {author}`; `{n} new`; day labels `Today`, `Yesterday`, `Earlier`.
  `{name}` is the coordinator name when all listed decisions share a project, else `the PMs`.
- Thread subjects are cut to 90 characters with `…`.
- Commit or push only when Diego asks; stage only this branch's files.
- Gates: backend `npm test` for touched specs plus the new integration test; Desktop `flutter analyze` and the touched
  test files; record them in the PR. Measure `SuperTabDecision` on the read-only production DB before and after
  (backend/AGENTS.md rule 5): Diego runs it.

## Review Focus

- A person answers a decision in the same second the sweep delegates it: exactly one answer is stored, and the sweep
  gets `DECISION_ANSWERED` and moves on (Task 2 test `a person's answer wins over the sweep`).
- A decision whose recommended option is out of range (old data) must not stop the pass: it is skipped and counted as
  failed in the pass result (Task 2 test `a decision the PM cannot take is skipped, the rest are answered`).
- The worker was down for two days, or a pass hit the 500 cap: every pass reads the whole 8-day window, so nothing is
  dropped (Task 2 tests `a decision older than 8 days is never taken`, `a capped pass leaves the rest for the next one`).
- Mark all read while one `mention.done` fails: the others are marked, the error line shows, one read follows
  (Task 4 test `mark all read keeps going past a failure`).
- A thread root with no `Title:` and no newline, longer than 90 characters, is cut with an ellipsis
  (Task 3 test `a long first line is cut at 90`).

---

### Task 1: Overdue answers are recorded and worded as such (backend)

**Files:**
- Modify: `backend/prisma/schema.prisma` (model `SuperTabDecision`: field `overdue Boolean?` with a `///` line, and the
  `decision_waiting_created` index on `[answeredAt, createdAt]` with a `///` line naming the sweep)
- Modify: `backend/src/superTabs/decisions.ts` (`DecisionAnswer`, `answerDecision`, `recordAnswer`, `listDecisions`, a new
  `overdueNotice`)
- Modify: `backend/src/superTabs/commands.ts:2041` (`case 'decision.answer'`: pass `overdue: context.overdue === true`)
- Test: `backend/src/superTabs/decisions.test.ts`

**Interfaces:**
- Produces: `answerDecision(state, actor, decision, given: { choice?: number; note: string | null; delegate: boolean; overdue?: boolean })`.
  With `overdue`, `delegate` must be true, else `INVALID_DECISION`. `DecisionAnswer` gains `overdue?: true`.
- Produces: `overdueNotice(name: string): string` (exact copy in Global Constraints).
- Produces: the command context field `overdue?: boolean` that `applyCommand` reads for `decision.answer` (set only by
  the store in Task 2, never by a client; it is not in the command schema).
- Produces: `listDecisions` rows gain `overdue: boolean`.

- [ ] **Step 1: Write the failing tests** in `decisions.test.ts`, using the file's `swarm()` fixture:
  - `an overdue answer takes the recommended option and says it waited 24 hours`: `applyCommand` of `decision.answer`
    `{ delegate: true }` with context `{ overdue: true }` → `effects.decisionAnswer` equals
    `{ id, choice: recommended, note: null, delegated: true, overdue: true }`, and the notice message text equals
    `overdueNotice('Product Manager')`.
  - `overdue without delegate is refused`: `answerDecision(..., { choice: 0, note: null, delegate: false, overdue: true })`
    throws `INVALID_DECISION`.
  - `a person's delegate is not overdue`: `{ delegate: true }` without context → no `overdue` key, notice is
    `delegatedNotice('Product Manager')`.
- [ ] **Step 2: Run** `cd backend && npx vitest run src/superTabs/decisions.test.ts`. Expected: the three new tests FAIL.
- [ ] **Step 3: Implement.** `overdue` picks `overdueNotice` in place of `delegatedNotice` (the closed-chat variant keeps
  `closedChatDelegatedNotice`); `recordAnswer` writes `overdue: true` beside `delegated`; `listDecisions` maps
  `overdue: row.overdue === true`; the schema field and index as listed.
- [ ] **Step 4: Run** the same command. Expected: PASS. Also `npm run typecheck`.
- [ ] **Step 5: Commit** (when Diego asks): `git add backend/prisma/schema.prisma backend/src/superTabs/decisions.ts backend/src/superTabs/commands.ts backend/src/superTabs/decisions.test.ts`,
  message `Swarm: record a decision left to the PM after 24 hours as overdue`.

### Task 2: The hourly sweep answers overdue decisions (backend)

**Files:**
- Create: `backend/src/superTabs/overdueDecisions.ts`
- Modify: `backend/src/superTabs/store.ts` (new public method)
- Modify: `backend/src/superTabs/sweeps.ts` (`startSwarmSweeps` takes the callback and logs its result)
- Modify: `backend/src/worker.ts:136` (pass `now => swarms.leaveOverdueDecisions(now)`)
- Test: `backend/integration/overdueDecisions.test.ts` (MongoDB replica via `planDatabase`, as `swarmSweepPlans.test.ts`)

**Interfaces:**
- Consumes: Task 1's context `overdue` and `answerDecision` behaviour.
- Produces: `export const OVERDUE_DECISION_MS: number` and
  `export async function overdueDecisions(db: PrismaClient, now: number, since: number): Promise<Array<{ tabId: string; id: string; personId: string }>>`
  in `overdueDecisions.ts`: one `aggregateRaw` on `SuperTabDecision` with
  `$match: { createdAt: { $gt: since, $lte: now - OVERDUE_DECISION_MS }, answeredAt: null, withdrawn: { $ne: true }, kind: { $exists: false } }`,
  projecting `_id`, `tabId`, `personId`; capped at 500 per pass, oldest first.
- Produces: `SuperTabStore.leaveOverdueDecisions(now: number): Promise<{ answered: number; skipped: number; failed: number }>`.
  It keeps `private overdueSince?: number` (unset → `now - 8 * DAY`, then `now - 26 * HOUR`). For each row it reads the
  person's email from the Swarm's people (skipped when they left), builds
  `AuthUser { sub: personId, email, autonomousEnv: <the store's env as other internal callers use>, role: 'user' }` and runs
  the same pipeline as `execute` with `{ operationId: 'overdue-decision:' + id, command: { type: 'decision.answer', decisionId: id, delegate: true } }`
  and the internal context `overdue: true` threaded into `executeOnce`'s command context. `DECISION_ANSWERED` and
  `INVALID_DECISION` count as `skipped`, any other error as `failed` (logged with the error code, no ids).
- Produces: `startSwarmSweeps(db, everyMs?, finishWorkspaceRemovals?, leaveOverdueDecisions?: (now: number) => Promise<unknown>)`.
  Its result appears as `overdue` in the `[swarm-sweeps] done` log; a throw logs `[swarm-sweeps] overdue decisions failed`
  at error level.

- [ ] **Step 1: Write the failing integration tests** in `overdueDecisions.test.ts` (fresh replica, never `DATABASE_URL`):
  - `a decision asked 25 hours ago is left to the PM`: seed a Swarm through the store with an agent asking a person
    (`work.status` with `ask`), set its `createdAt` to `NOW - 25h`, run `leaveOverdueDecisions(NOW)` → result
    `{ answered: 1, skipped: 0, failed: 0 }`; the row has `delegated: true, overdue: true, choice: recommended`; the
    conversation has the overdue notice.
  - `a decision asked 23 hours ago waits`: `answered: 0`, row still waiting.
  - `a person's answer wins over the sweep`: answer it as the person first, then sweep → `skipped: 1`, `choice` is the
    person's, no `overdue`.
  - `a second pass replays nothing`: sweep twice → second `{ answered: 0 }`, one notice.
  - `the first pass reaches back 8 days`: a decision at `NOW - 7d` is answered on a new store's first pass; on that
    store's next pass one at `NOW - 3d` (seeded after) is not.
  - `a decision the PM cannot take is skipped, the rest are answered`: one row with `recommended: 9` and 2 options, one
    valid → `{ answered: 1, skipped: 1 }`.
  - `the overdue read uses decision_waiting_created`: `profiled(db, () => overdueDecisions(db, NOW))` →
    `plan(reads(entries, 'SuperTabDecision', ['createdAt']))` shows `IXSCAN { createdAt: 1 }` and `docsExamined` ≤ the
    rows in the window + 1, with 10 decisions outside the window seeded.
- [ ] **Step 2: Run** `cd backend && npx vitest run integration/overdueDecisions.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `overdueDecisions.ts`, the store method, the sweeps parameter and the worker wiring per
  Interfaces.
- [ ] **Step 4: Run** the integration test, `npx vitest run src/superTabs/sweeps.test.ts` if it exists, and
  `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** (when Diego asks): message `Swarm: leave a decision unanswered for 24 hours to the PM`.

### Task 3: Count rule and row helpers (Desktop)

**Files:**
- Modify: `desktop/lib/super_tabs/activity.dart` (`count`, `needsYou`, `unread`, new getters)
- Modify: `desktop/lib/super_tabs/project_sidebar.dart:1027` (fallback badge)
- Modify: `desktop/lib/super_tabs/decisions.dart` (`SuperTabDecision.overdue`, `answeredAt`)
- Create: `desktop/lib/super_tabs/activity_rows.dart`
- Test: `desktop/test/super_tab_activity_test.dart`, create `desktop/test/super_tab_activity_rows_test.dart`

**Interfaces:**
- Produces in `activity.dart`:
  - `int get count`: open decisions (the loaded `decisions.open` once loaded, else `snapshot.decisionsWaiting`) + groups
    where `work['status'] == 'needs_human'`, `work['askedOf'] == controller.accountId`, not closed, not a Buddy chat, and
    no loaded open decision in that conversation. No tags, no `blocked`, no requester or owner fallback.
  - `List<SuperTabNeed> get needsYou`: the same items, decisions then tasks, newest first (no mentions).
  - `bool get unread => count > 0 || _tags.isNotEmpty || attention.threadsUnread`.
  - `List<SuperTabDecision> get handledToday`: `decisions.answered` with `delegated` and `answeredAt` today, newest first.
  - `List<SuperTabMentionRow> get mentionRows` (via `groupMentions`), `List<SuperTabFollowedThread> get threadRows`
    (today's `newReplies`).
  - `String coordinatorFor(Iterable<SuperTabDecision>)`: the project's coordinator name when one project, else `the PMs`.
- Produces in `activity_rows.dart` (pure, no controller):
  - `class SuperTabMentionRow { final SuperTabMention newest; final List<SuperTabMention> all; final bool unread; int get more => all.length - 1; }`
  - `List<SuperTabMentionRow> groupMentions(List<SuperTabMention> mentions, bool Function(SuperTabMention) isUnread)`:
    folds neighbours with the same `leadId ?? leadName`, `conversationId` and `threadId`; `unread` if any member is.
  - `String threadSubject(String rootText)` (spec rule, 90-character cut).
  - `String pmIn(DateTime createdAt, DateTime now)`: `PM in {h}h` (hours to `createdAt + 24h` rounded up) or `PM in <1h`.
  - `bool pmSoon(DateTime createdAt, DateTime now)`: under 2 hours left.
  - `enum SuperTabDay { today, yesterday, earlier }` and `SuperTabDay dayOf(DateTime at, DateTime now)` (local time).
- `SuperTabDecision` gains `final bool overdue` (`row['overdue'] == true`) and `final DateTime? answeredAt` if absent.

- [ ] **Step 1: Write the failing tests.**
  - `super_tab_activity_test.dart`:
    - `tags do not count`: 4 waiting mentions, 0 decisions → `count == 0`, `unread == true`.
    - `a stuck task nobody was asked about does not count`: `blocked` group with `requesterId` = reader → `count == 0`.
    - `an agent that asked the reader by name counts once`: `needs_human`, `askedOf` = reader, an open decision in that
      conversation → `count == 1` both before and after `decisions.load()` (the double count fix).
    - `the sidebar fallback counts decisions only`: `snapshot.mentionsWaiting = 4, decisionsWaiting = 2` → the
      Activity row's badge reads `2`.
    - `handled today lists the PM's answers of today`: two delegated answered decisions (today, yesterday) → one row.
  - `super_tab_activity_rows_test.dart`:
    - `neighbours from one author in one chat fold`: dee×3 in `c1`, Plover×2, dee×1 in `c2` → rows `[dee(3), Plover(2), dee(1)]`, `more` `[2, 1, 0]`.
    - `a Title: line gives the subject`: `'Please send this to the openharness PM as a proposal (priority normal). Title: Swarm: a member cannot close a lost or stopped task — details'` → `'Swarm: a member cannot close a lost or stopped task'`.
    - `a long first line is cut at 90`: 120 `a`s → 89 `a`s + `…`.
    - `pm in rounds up and says <1h in the last hour`: asked 18.5h ago → `PM in 6h`; asked 23.5h ago → `PM in <1h`, `pmSoon` true; asked 21h ago → `pmSoon` false.
    - `days split at local midnight`: today 00:01 → today; yesterday 23:59 → yesterday; 3 days ago → earlier.
- [ ] **Step 2: Run** `cd desktop && flutter test test/super_tab_activity_test.dart test/super_tab_activity_rows_test.dart`.
  Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces. Remove the requester/owner fallback from `_waiting`; build `decided` only from
  the loaded list.
- [ ] **Step 4: Run** the same tests and `flutter analyze`. Expected: PASS, no issues.
- [ ] **Step 5: Commit** (when Diego asks): message `Desktop: Activity counts only what needs you`.

### Task 4: Batch actions (Desktop)

**Files:**
- Modify: `desktop/lib/super_tabs/decisions.dart` (`delegateAll`)
- Modify: `desktop/lib/super_tabs/notifications.dart` (`doneAll`)
- Modify: `desktop/lib/super_tabs/attention.dart` (`markRead`, `markAllRead`)
- Test: `desktop/test/super_tab_decisions_test.dart`, `desktop/test/super_tab_activity_lists_test.dart`

**Interfaces:**
- Produces: `Future<int> SuperTabDecisions.delegateAll(List<SuperTabDecision> decisions)`: sends `decision.answer`
  `{delegate: true}` for each `canDelegate` one, all at once, keeps each failure in `_failed` as `_answer` does, then one
  `load()` and one `controller.refresh()`; returns how many succeeded.
- Produces: `Future<int> SuperTabMentions.doneAll(List<SuperTabMention> mentions)`: `mention.done` for each unresolved one,
  all at once, then one `load()`; sets `error = 'Could not mark some as read. Try again.'` if any failed; returns how many
  succeeded. `done()` keeps its behaviour; its error text becomes `'Could not mark it read. Try again.'`.
- Produces: `void SuperTabAttention.markRead(SuperTabFollowedThread t)` →
  `controller.markThreadRead(t.conversationId, t.rootId, t.lastReplySequence)`; `void markAllRead(Iterable<SuperTabFollowedThread>)`.

- [ ] **Step 1: Write the failing tests** with the files' existing fake request recorders:
  - `delegate all sends one answer per decision and reads once`: 3 decisions (one without `recommended`) → 2 POSTs with
    `delegate: true`, 1 GET pair after, returns 2.
  - `mark all read keeps going past a failure`: 3 mentions, the 2nd POST throws → 3 POSTs, `error` set, one load, returns 2.
  - `mark read moves the thread mark to its newest reply`: after `markRead(t)` the controller's thread mark for
    `t.rootId` is `t.lastReplySequence` and `attention.isNew(t)` is false.
- [ ] **Step 2: Run** `flutter test test/super_tab_decisions_test.dart test/super_tab_activity_lists_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** (when Diego asks): message `Desktop: let the PM decide for all, and mark mentions and threads read`.

### Task 5: The tabbed Activity view (Desktop)

**Files:**
- Modify: `desktop/lib/super_tabs/activity_view.dart` (rewrite of the list; keep `SuperTabActivityView`'s constructor)
- Test: `desktop/test/super_tab_activity_view_test.dart`

**Interfaces:**
- Consumes: Task 3 getters and helpers, Task 4 batch actions, the existing decision answer/delegate calls,
  `superTabAgoShort`, `DesktopChrome`, `grid.AppDesktop` spacing and `AppIcons`.
- Produces: keys used by tests: `super-activity-tab-needs`, `super-activity-tab-mentions`, `super-activity-tab-threads`,
  `super-activity-decide-all`, `super-activity-decide-all-confirm`, `super-activity-mark-all-read`,
  `super-activity-unreads-only`, `super-activity-row-mention:<newest id>`, `super-activity-row-thread:<key>`,
  `super-activity-row-decision:<id>`, `super-activity-option:<decisionId>:<index>`, `super-activity-handled`.

- [ ] **Step 1: Write the failing widget tests:**
  - `opens on Needs you when something needs the reader, else on the tab with unread rows`.
  - `the Needs you tab shows the count in red and the others in grey`: tab texts `Needs you 2`, `Mentions 4`, `Threads 1`.
  - `a decision row answers from its options`: tap `super-activity-option:<id>:1` → one `decision.answer` `{choice: 1}`.
  - `a decision row says when the PM takes over`: asked 18.5h before `now` → text `PM in 6h`.
  - `let PM decide for all asks first`: tap decide-all → dialog `Let Product Manager decide all 2?`; Cancel sends nothing;
    confirm sends 2 delegated answers.
  - `mentions fold and show who said what`: dee×3 → one row with `dee`, the newest text, `+2 more from dee`.
  - `mark read on a folded row marks all of it`: hover dee's folded row, tap `Mark read` → 3 `mention.done`.
  - `mark all read marks only the mentions listed`: tap mark-all-read on Mentions → `mention.done` for each unread one, no
    `decision.answer`.
  - `unreads only hides read rows`: an answered mention disappears when the switch is on.
  - `a thread row shows its subject and latest reply`: root with `Title: X — y`, last replier River → `X`, `River: …`, `1 new`.
  - `hover shows mark read on a thread`: hover then tap `Mark read` → `attention.isNew` false, no navigation. The second hover action is `Unfollow`.
  - `nothing needs you says what the PM handled`: no open decisions, 2 handled today → `Nothing needs you`,
    `Product Manager handled 2 for you today`; `See what` lists both with their chosen option.
  - `rows are split by day`: mentions today and 2 days ago → `Today` and `Earlier` headings.
- [ ] **Step 2: Run** `flutter test test/super_tab_activity_view_test.dart`. Expected: FAIL.
- [ ] **Step 3: Implement** the view: a tab row (selected tab underlined), a bar per tab (decide-all on Needs you, Mark all
  read and Unreads only on the other two), day headings, the row widget (dot, avatar initial, name, `in # project` or the
  lock, time or `PM in`, preview, hover actions), the confirmation via the app's existing dialog helper, and the empty
  state. Remove the Done today section and its `_finished` row. Match the mockup `desktop/mockup/activity-slack.html`.
- [ ] **Step 4: Run** the view tests, `flutter test test/super_tab_activity_test.dart test/super_tab_activity_lists_test.dart`
  and `flutter analyze`. Expected: PASS. Then a manual look on macOS (`bash scripts/build-macos-debug.sh`) with screenshots
  of the three tabs for the PR.
- [ ] **Step 5: Commit** (when Diego asks): message `Desktop: a tabbed Activity, one list at a time`.
