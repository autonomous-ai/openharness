# Contributor view Implementation Plan

> Worked by this project's instructions (Engineer role): design and plan first in a draft pull request, then each task
> test first (failing test committed before its code), one independent Review step and a Test step on the pull request.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each person's card (Desktop, web, phone) shows the machines they brought, the verified requests that shipped
on each in the period, the hours each spent on others' work and each subscription's weekly use and reset; the owner is
told once a week per machine when someone else's work starts on it; the leaderboard counts the week's contributors.

**Architecture:** Each attempt records its machine in the group's ledger (`Run.machineId`). The leaderboard read
(`leaderboard/stats.ts`) derives `details.brought` per person and `contributors` from the groups and visible machines
it already loads. `work.assign` posts a once-a-week notice in the machine owner's Buddy chat and marks the machine
(`ContributedMachine.othersToldWeek`). Clients render `brought` in the person card (Desktop/web) and person sheet
(phone), falling back to Lent from an older server.

**Tech Stack:** TypeScript, Prisma/MongoDB, vitest (backend); Flutter 3.47.2 (desktop/, mobile/).

**Spec:** [2026-11-03-contributor-view-design.md](2026-11-03-contributor-view-design.md) (task #2444 brief in the PR body).

## Global Constraints

- PR body first line: "Requested by 0xken15@gmail.com through Harness."
- Numbers only from what the server records; no new collection, endpoint or query (design, Read cost).
- A person sees only what they may read: `brought` from the reader's visible machines and readable groups; the notice
  names a task title or project only when its owner may read the project.
- Verified = shipped with a pull request and no `fixedAfterMergeAt`.
- Weekly window only for subscriptions (`observation.quotas[].windows[name === 'weekly']`); a Team account reads its
  Mac's (`hostMachineId`).
- Copy: section `Brought`, empty `No machines brought yet`, `N shipped · H h for others`, `<Engine> <P>% used · resets
  in <d>` / `not read yet`; phone lines `<machine>  N shipped · H h for others` then `Claude P% used, resets in <d>`.
- Notice once per machine per week (Monday 00:00 UTC, `weekStart`), source kind `others-work-notice`.
- Before Ready: red/green evidence in a PR comment, full Super Tab integration suite, `python3 scripts/check-ui-style.py
  --only desktop/lib/super_tabs`, screenshots light and dark. Desktop tests use a memory store and a fake sign-in.

## Review Focus

- A request shipped on a Team account attempt credits the Team account's Mac, folded into one Brought row. (Task 2 test.)
- A machine the reader cannot see (Buddy-only, or a private project's) never appears in anyone's Brought, and a group
  the reader cannot read never counts. (Task 2 test.)
- A request whose PR needed a fix after merge does not count as shipped on the machine. (Task 2 test.)
- The owner's own request, a PM's assignment or a private chat's never notifies; a second teammate assign the same week
  never notifies again; a new week does. (Task 3 tests.)
- The notice to an owner who cannot read the project names neither its title nor the project. (Task 3 test.)

---

### Task 1: An attempt records its machine

**Files:**
- Modify: `backend/src/superTabs/leaderboard/record.ts` (`Run`, `recordRun`)
- Test: `backend/src/superTabs/leaderboard/record.test.ts`

**Interfaces:**
- Produces: `Run.machineId?: string` (absent on runs recorded before); `GroupLedger.shippedBy` carries it.

- [x] **Step 1: Write the failing test** `records the machine each attempt ran on, and the shipping attempt keeps it`:
  assign a worker on machine `m1`, mark done; expect `ledger.runs.at(-1).machineId === 'm1'` and
  `ledger.shippedBy.machineId === 'm1'`.
- [x] **Step 2: Run** `cd backend && npm test -- src/superTabs/leaderboard/record.test.ts`; expect FAIL (undefined).
- [x] **Step 3: Implement**: `recordRun` adds `machineId: assignment.execution.machineId`.
- [x] **Step 4: Run** the same; expect PASS.
- [x] **Step 5: Commit** test then code.

### Task 2: The leaderboard says what each person brought, and counts contributors

**Files:**
- Modify: `backend/src/superTabs/leaderboard/contract.ts` (`PersonDetails.brought`, `Leaderboard.contributors`)
- Modify: `backend/src/superTabs/leaderboard/stats.ts` (new `brought`, `contributors` helpers in a new file below)
- Create: `backend/src/superTabs/leaderboard/brought.ts`
- Test: `backend/src/superTabs/leaderboard/brought.test.ts`, `stats.test.ts` (contract shape)

**Interfaces:**
- Consumes: `Run.machineId` (Task 1).
- Produces (contract):
  - `PersonDetails.brought: Array<{ machineId: string; machineName: string; shipped: number; busyHours: number;
    subscriptions: Array<{ engine: string; usedPercent: number | null; resetsAt: number | null }> }>`, most shipped, then
    busiest, then name; at most `DETAILS_LIMIT`.
  - `Leaderboard.contributors: { thisWeek: number; lastWeek: number | null; kept: number | null }`.
- Produces (code): `runMachine(state: SuperTabState, run: Pick<Run, 'machineId' | 'agentId'>): string | undefined`;
  `shippedOnMachine(group: Conversation, state: SuperTabState): string | undefined` (shippedBy's machine, else the last run
  before shipping); `homeOf(machines: ContributedMachine[], machineId: string): ContributedMachine | undefined` (a Team
  pool's Mac); `contributorsIn(state, groups, machines, span): Set<string>`.

- [x] **Step 1: Write the failing tests** in `brought.test.ts`:
  - `lists each machine a person brought with what shipped on it`: two machines of `ken`, three shipped requests (any
    requester) whose runs ran on `m1`, one on `m2` with `fixedAfterMergeAt` → `[{machineId:'m1', shipped:3, …}, {machineId:'m2', shipped:0, …}]`.
  - `folds a Team account into its Mac`: a run on the Team pool `t1` (`hostMachineId: 'm1'`) → counted on `m1`, one row.
  - `resolves an older run's machine from its agent`: run without `machineId`, `agentId` of an agent on `m1` → `m1`.
  - `shows each subscription's weekly window`: quotas Claude weekly `usedPercent 38, resetsAt T` and Codex unknown →
    `[{engine:'claude', usedPercent:38, resetsAt:T}, {engine:'codex', usedPercent:null, resetsAt:null}]`.
  - `never lists a machine the reader cannot see`: a machine not in `machines` input is absent.
  - `counts contributors this period, last period and kept`: runs on ken's machine both periods, diego's last only →
    `{ thisWeek: 1, lastWeek: 2, kept: 1 }`.
- [x] **Step 2: Run** `npm test -- src/superTabs/leaderboard/brought.test.ts`; expect FAIL (module missing).
- [x] **Step 3: Implement** `brought.ts`; `stats.ts` sets `details.brought` from `machinesBy.get(personId)` (busyHours
  from the `lentIn` it already computes) and `contributors` from `contributorsIn` over `shared` groups.
- [x] **Step 4: Run** brought and stats tests; expect PASS. Run `npm test -- src/superTabs/leaderboard` for regressions.
- [x] **Step 5: Commit** test then code.

### Task 3: The owner hears when others' work starts on their machine

**Files:**
- Create: `backend/src/superTabs/othersWork.ts`
- Modify: `backend/src/superTabs/commands.ts` (`work.assign`, after `recordRun`)
- Modify: `backend/src/superTabs/machines.ts` (`ContributedMachine.othersToldWeek?: number`)
- Modify: `backend/src/superTabs/model.ts` (`NOTICE_READERS['others-work-notice'] = 'people'`),
  `backend/src/superTabs/projects.ts` (`SERVER_WORDS` adds it)
- Test: `backend/src/superTabs/othersWork.test.ts`; `backend/src/superTabs/commands.test.ts` (assign path)

**Interfaces:**
- Produces: `othersWorkNotice(state: SuperTabState, group: Conversation, worker: Agent, now: number): { conversationId: string; text: string; machineId: string } | null`
  — null when not someone else's work (Lent's rule), already told this week, a PM's or private chat's; otherwise marks
  `pool.othersToldWeek = weekStart(now)`.
- Text: `${who}'s work${title ? ` "${title}"` : ''} started on your ${machine} (${engine}${quota ? `, ${quota}` : ''}). Members › your card shows what it runs and ships; Manage › Machines can pause new work.`
  where `quota` is `${P}% of this week used, resets in ${d}`, absent when unknown.

- [x] **Step 1: Write the failing tests**: `tells the owner once a week when someone else's task starts on their machine`
  (second assign same week: none; next week: one), `says nothing for the owner's own request, a PM or a private chat`,
  `names the task only when the owner may read its project`, and in `commands.test.ts`
  `work.assign posts the others-work notice in the machine owner's Buddy chat` (message source kind, conversation is the
  owner's Buddy chat, machine part has `othersToldWeek`).
- [x] **Step 2: Run** `npm test -- src/superTabs/othersWork.test.ts src/superTabs/commands.test.ts -t others`; expect FAIL.
- [x] **Step 3: Implement** `othersWork.ts`; in `work.assign` push the message with id `stableId(operationId, 'others-work-notice')`,
  author `sender`, source `{ kind: 'others-work-notice', machineId }`.
- [x] **Step 4: Run** the same; expect PASS; then the full Super Tab integration suite
  (`npm run test:integration:super-tabs` or the repo's documented command) under the shared suite lock.
- [x] **Step 5: Commit** test then code.

### Task 4: Desktop and web show Brought in the person card

**Files:**
- Modify: `desktop/lib/super_tabs/leaderboard/model.dart` (`SuperTabPersonDetails.brought`, nullable for an older server)
- Modify: `desktop/lib/super_tabs/leaderboard/person_row.dart` (`_LeaderboardPersonDetails`: Brought replaces Lent when present)
- Test: `desktop/test/super_tab_humans_test.dart` (group "Brought", beside the card's other tests); screenshots in `super_tab_leaderboard_shots_test.dart`

**Interfaces:**
- Consumes: the `brought` contract (Task 2).
- Produces: `SuperTabBrought { machineId, machineName, shipped, busyHours, subscriptions: List<({String engine, int? usedPercent, int? resetsAt})> }`.

- [x] **Step 1: Write the failing tests**: `the card lists each machine brought with what it shipped and its weekly use`
  (finds `Brought`, `Mac Studio`, `5 shipped · 31 h for others`, `Claude`, `38% used · resets in 3d`, `not read yet`);
  `with nothing brought it says so` (`No machines brought yet`); `from an older server it keeps Lent` (no `brought` key → `Lent`).
- [x] **Step 2: Run** `flutter test test/super_tab_humans_test.dart --plain-name Brought`; expect FAIL.
- [x] **Step 3: Implement** parsing and the section, reusing the card's `section`/`item`/`line` helpers and `superTabMachineName`.
- [x] **Step 4: Run** it and `flutter test test/super_tab_leaderboard*_test.dart test/super_tab_roster*_test.dart`; expect PASS.
  Run the style check. Capture light and dark card screenshots.
- [x] **Step 5: Commit** test then code.

### Task 5: The phone shows Brought in the person sheet

**Files:**
- Modify: `mobile/lib/swarm/swarm_leaderboard_reader.dart` (`SwarmScore.brought`, `swarmPersonWeek`)
- Test: `mobile/test/swarm/swarm_leaderboard_test.dart` (group "Brought")

**Interfaces:**
- Consumes: the `brought` contract (Task 2).

- [x] **Step 1: Write the failing test** `the person sheet has a line per machine brought`: `swarmPersonWeek(score)`
  contains `('Mac Studio', '5 shipped · 31 h for others\nClaude 38% used, resets in 3d\nCodex not read yet')` and no `Lent` line; from a
  score without `brought` it keeps `Lent`.
- [x] **Step 2: Run** `flutter test test/swarm/swarm_leaderboard_test.dart --plain-name Brought` in mobile/; expect FAIL.
- [x] **Step 3: Implement** parsing and the lines.
- [x] **Step 4: Run** it and `flutter test test/swarm/swarm_leaderboard*_test.dart`; expect PASS. Capture a screenshot.
- [x] **Step 5: Commit** test then code.
