# Tab Activity, a leader and tasks in every tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In any tab with Agent Messages on, a person names a leader, gives it a task in one sentence, and follows from
a sidebar which harness is doing what and each task's step, without sharing the tab unless they want to invite someone.

**Architecture:** The leader moves from the shared tab's roster to the tab's Agent Messages setting on the backend (the
roster follows it for shared tabs). The daemon tells every agent its tab's leader, its role and its task marker, reads
tasks for any tab, and carries a one-line summary with the working state. The desktop gets Make Leader, the three-tab
panel in every tab, and a Tab Activity sidebar beside the panes.

**Tech Stack:** TypeScript (Node 24, vitest, Prisma on MongoDB) in `backend/` and `cli/`; Dart/Flutter (desktop + web)
in `desktop/`; Swift (AppKit) for the macOS File menu.

**Spec:** `docs/superpowers/specs/2026-10-16-shared-tab-activity-sidebar-design.md`. Shared tabs (shipped, PR #1376):
`docs/superpowers/specs/2026-10-16-shared-tabs-desktop-design.md`, `docs/plans/2026-10-16-shared-tabs-1c-desktop.md`.

## Global Constraints

- Everything needs Agent Messages on (Settings ▸ Experimental); with it off, nothing changes.
- Inviting, accepting, trust, alerts, Move here and Stop Sharing work as 1c built them.
- Strings from another account (names, emails, summaries, issue titles) are plain text, one line, ellipsized.
- Waiting is drawn in the shape of the answer (skeleton rows); "loading" and "nothing" never look alike.
- Copy follows `docs/naming-system.md` ("shared tab", "member", "leader"; never "team").
- Summary: at most 120 characters, control and format characters removed; sent across accounts only for harnesses the
  activity rule allows (listed in the roster; a member's harness on its own computer only if the member added it).
- Tasks are read when the sidebar or the panel's Tasks opens, when a harness in the tab goes from working to idle, and
  every 60 seconds while the window is in front and the sidebar is open; nothing is read while both are closed.
- A merged task stays in the sidebar for 24 hours.
- `npm run test:shared-tabs` and `npm run test:core` stay at 100% per file; the backend's agent-messages gate stays at
  100% (Node 24: `npx -y node@24` or nvm; the shell default v23 breaks `searchProcess.spec`).
- Never test against the developer's own daemon (port 18473), `~/.harness`, `~/.claude`, `~/.codex`, the real tmux
  server, or `/Applications/Harness.app`; tests never run the real `gh`. Never wrap Chrome in `timeout`.
- **No commits until the owner asks.** "Checkpoint" steps mean the controller snapshots the tree; implementers never
  run `git commit`, `stash`, `reset` or `push`.
- Desktop checks: `cd desktop && flutter analyze` and `make -C .. desktop-test`; web: `flutter test --platform=chrome
  --dart-define=HARNESS_TEST=true test/web/...`.

## Rulings this plan makes (beyond the spec)

Research found where the code differs from the spec's assumptions. Task D2 writes these into the spec.

- **T1 A leader that left the tab is derived, not cleared.** The backend has no table of agents; it knows them only as
  desk panes. It validates a new leader as a pane of that desk tab on a machine of the account, and the tab listing
  returns `leader: null` when that pane is no longer in the tab. Nothing writes to clear it; no two computers race.
- **T2 The running prompt is kept by the core.** `recentAsks` is written only when a turn ends, and recaps exist only
  with a paired device or `alwaysGenerate`. The core keeps `Map<agentId, string>` of the last prompt from the turn
  funnel's `turn_started` (`userMessage`). Summary rule: working → that prompt; idle → the latest recap line, else that
  prompt; nothing known → no summary.
- **T3 This account's harnesses' summaries come from a new `tab_activity` action.** `shares.activity` holds only what
  other accounts send. `tab_activity { tabId }` on this computer's daemon answers every harness of the tab:
  this machine's from the core, the account's other machines' through the existing `who` request (extended with
  `state` and `summary`), other accounts' from what `activity` frames brought.
- **T4 The summary switch is stored inverted.** Every account experiment is "off unless true". The setting is
  `agent_messages_hide_summary` (backend experiment) / `agentMessagesHideSummary` (daemon), off by default; the desktop
  shows it as "Share a one-line summary …" checked when it is off.
- **T5 Idle summaries reach the windows.** `ActivityIn.snapshot` returns idle entries that carry a summary for 10
  minutes after they were heard (`ACTIVITY_IDLE_KEEP_MS = 10 * 60_000`); working entries keep their lease.
- **T6 Make Leader lives where pane actions already are.** There is no pane context menu: Make Leader / Remove Leader
  is in the File menu (macOS and Linux), the command palette, and a chip on the focused pane (the web's way).
- **T7 Update now is native only and runs the CLI.** No daemon request updates it, and `harness update` stops the
  daemon it asks. The desktop runs `harness update` itself (a development build: `harness update --force`, after a
  confirmation that it replaces the development build). The daemon's version comes from its `/api/health`. The web
  shows the line without the button. Required version: `kAgentMessagesMinimumCli = '0.4.15'` in the desktop.
- **T8 The assignee label in an unshared tab** is the label shared tabs already use for this account in a marker, so a
  task assigned before sharing still names the right harness after.
- **T9 Every agent's note changes once.** Adding the marker (and roles) to unshared tabs changes each note's
  signature; agents are told the new note once. The "byte-identical unshared note" comment in `model.ts` is updated.
- **T10 Merge fields share the 20-PR cap** of the existing `gh pr view` calls (`CI_MAX`); a pull request beyond it
  shows the steps derivable without them.
- **T11 "Merging" is auto-merge only** (final review C1). gh has no merge-queue JSON field (`isInMergeQueue` is
  refused as unknown before any request, which failed every `gh pr view`); the queue would need an extra `gh api
  graphql` call. `tasks.spec.ts` pins every requested `--json` field to gh 2.95.0's own list.

## Review Focus

1. **The leader's pane is closed, moved to another tab or removed from the tab:** the leader is gone everywhere (chip,
   note, roster, sidebar) without anyone clearing it. Test in Task A1 and Task A2.
2. **Make Leader on the owner's second computer for a shared tab** while the sharing computer is asleep: the setting
   holds, and the roster follows when it wakes; members never see a leader the roster does not name. Test in Task A2.
3. **A task created before sharing** stays the tab's task after sharing, for the owner and for members. Test in Task A3
   and the E2E step in Task A5.
4. **A summary from another account with markup, a bidi override or 500 characters**: cut, cleaned, one line, never
   wider than the row. Test in Task A4 and Task B4.
5. **The sidebar open on a tab of 9 harnesses on three computers, one of them away:** rows show "waiting" for the away
   computer's harnesses, nothing spins forever, and `gh` is not called more than the reading rule allows. Test in
   Task B4.

## File map

| File | Responsibility | Task |
|---|---|---|
| `backend/prisma/schema.prisma`, `backend/src/lib/agentMessages.ts`, `backend/src/routes/agentMessages.ts` (+ test) | the tab's leader | A1 |
| `backend/src/lib/experimentalSettings.ts`, `backend/src/routes/experimentalSettings.ts` (+ test) | the hide-summary experiment | A4 |
| `cli/src/core/api.ts` | `MESSAGES_BACKEND_ROUTES` PATCH tabs; `agents.summaries` | A2, A4 |
| `cli/src/messages/directory.ts`, `model.ts`, `service.ts` (+ specs) | leader and roles in the note, marker everywhere, `tab_activity` | A2, A3, A4 |
| `cli/src/messages/sharedTabs.ts` (+ spec) | roster leader from the tab setting | A2 |
| `cli/src/messages/tasks.ts` (+ spec) | desk-tab key, merge fields | A3 |
| `cli/src/messages/tabActivity.ts` (+ spec) | summary in activity, idle keep | A4 |
| `cli/src/core/turns/funnel.ts`, `cli/src/core/messagesLink.ts`, `cli/src/core/main.ts`, `cli/src/services/processCoreApi.ts` | the running prompt and summaries | A4 |
| `cli/src/lib/agentSettings.ts`, `cli/src/core/experiments.ts` | the hide-summary setting | A4 |
| `cli/e2e/sharedTabs.e2e.ts` | end to end | A5 |
| `desktop/lib/agent_messages/tab_settings.dart` (new), `agent_messages.dart`, `lib/core/api_client.dart` | tab settings with leader | B1 |
| `desktop/lib/agent_messages/task_step.dart` (new), `tab_activity.dart` (new) | the step rule, `tab_activity` reads | B1 |
| `desktop/lib/state/app_state.dart` | wiring, `desk_changed` refresh, leader writes | B1, B2 |
| `desktop/lib/screens/swarm_screen.dart`, `macos/Runner/SwarmTitlebar.swift`, `lib/widgets/linux_menu_bar.dart`, `lib/shortcuts/keymap_commands.dart`, `lib/agent_messages/pane_shared_chips.dart` | Make Leader, Show Tab Activity | B2, B4 |
| `desktop/lib/agent_messages/agent_messages_view.dart`, `tab_people.dart` (new), `shared_tab_tasks.dart`, `shared_tab_people.dart`, `shared_tab_dialogs.dart` | the panel in every tab, confirmations | B3 |
| `desktop/lib/agent_messages/tab_activity_sidebar.dart` (new) | the sidebar | B4 |
| `desktop/lib/agent_messages/update_harness.dart` (new), `lib/settings/experimental_features.dart` | the update line, the switch | B5 |

---

## Phase A: backend and daemon

### Task A1: the tab's leader on the backend

**Files:**
- Modify: `backend/prisma/schema.prisma` (`model AgentMessageTab`, ~852), `backend/src/lib/agentMessages.ts`
  (`AgentMessagesDirectory` 16–24, `readAgentMessages` 27–44, `setAgentMessages` 47–60), `backend/src/routes/agentMessages.ts` (59–71)
- Test: `backend/src/routes/agentMessages.test.ts`

**Interfaces:**
- Produces: PATCH `/api/agent-messages/tabs/:tabId` body `{ enabled?: boolean, leader?: { machineId, agentId } | null }`
  (strict, at least one key) → `{ tabId, enabled, leader, revision }`; error `INVALID_LEADER` (400) "Choose a harness in
  this tab."; GET `/api/agent-messages` tabs gain `leader: { machineId, agentId } | null` (null when the pane left the
  tab, T1).

- [ ] **Step 1: Write the failing tests** (the file's `mocks.prisma`; add `machine.findFirst` if used)

```ts
it('sets a leader that is a pane of the tab on a machine of the account, and tells the account\'s computers', async () => {
  const res = await app.inject({ method: 'PATCH', url: '/api/agent-messages/tabs/app', payload: { leader: { machineId: 'm1', agentId: 'lead' } } })
  expect(res.statusCode).toBe(200)
  expect(res.json().data).toMatchObject({ tabId: 'app', leader: { machineId: 'm1', agentId: 'lead' } })
  expect(mocks.publishDeskChanged).toHaveBeenCalled()
})
it('clears the leader with null, and an enabled-only patch leaves the leader alone', async () => { /* … */ })
for (const [what, leader] of [['a pane of another account', { machineId: 'shared', agentId: 'observer' }],
  ['a harness not in the tab', { machineId: 'm1', agentId: 'other' }], ['an empty id', { machineId: '', agentId: 'x' }]] as const) {
  it(`refuses ${what}`, async () => { /* 400 INVALID_LEADER, nothing written */ })
}
it('refuses an empty body and an unknown tab', async () => { /* 400 */ })
it('lists the leader with its tab, and null once its pane left the tab', async () => { /* readAgentMessages */ })
```

Write each out in full in the file's style.

- [ ] **Step 2: Run to fail** — `cd backend && npm run test:agent-messages` (or the file's vitest command). Expected:
  FAIL (body refused / no `leader`).

- [ ] **Step 3: Implement**
  - Schema: `leaderMachineId String?` and `leaderAgentId String?` on `AgentMessageTab`; `npx prisma generate`. On
    create, write both as explicit `null` (Mongo null filters, see the comment in `agentMessageShares.ts` ~27–30).
  - Route body: `z.object({ enabled: z.boolean().optional(), leader: z.object({ machineId: z.string().min(1).max(200),
    agentId: z.string().min(1).max(160) }).strict().nullable().optional() }).strict().refine((b) => b.enabled !== undefined
    || b.leader !== undefined)`.
  - `setAgentMessages(userId, tabId, patch)`: write only the keys present; a non-null leader is checked first: the desk
    holds the tab, `{machineId, agentId}` is one of its panes, and `machineId` is one of the account's machines
    (`prisma.machine.findFirst({ where: { machineId, userId } })`); otherwise `INVALID_LEADER`.
  - `readAgentMessages`: each tab's `leader` is the stored pair if it is still one of the tab's owned panes, else null.

- [ ] **Step 4: Run to pass; gates** — `npm run test:agent-messages` (100%), `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task A2: leader and roles in every note; the roster follows the setting

**Files:**
- Modify: `cli/src/core/api.ts` (`MESSAGES_BACKEND_ROUTES` ~728–739: add `route('PATCH', '/tabs/' + DESK_TAB)`),
  `cli/src/messages/directory.ts` (`DirectoryTab` gains `leader?: { machineId, agentId } | null`, read from the
  listing), `cli/src/messages/model.ts` (`sharedLines` ~210 split into `leaderLines` + `markerLines` + the shared-only
  warning; `note` ~240), `cli/src/messages/service.ts` (`rosterOf` ~446, `sharedNote` ~468: a note for every tab;
  `share_leader` writes the setting), `cli/src/messages/sharedTabs.ts` (`SharedTabsDeps.ownLeader`; `share()` ~303 and
  `reshare` ~571 pass it to `composeCut`/`change`; `addHarness`/`removeHarness` keep it)
- Test: `cli/src/core/messagesLink.spec.ts` (route list), `cli/src/messages/model.spec.ts`, `service.spec.ts`,
  `service.sharedTabs.spec.ts`, `sharedTabs.spec.ts`

**Interfaces:**
- Consumes: A1's listing `leader` and PATCH body.
- Produces: `DirectoryTab.leader`; `SharedTabsDeps.ownLeader(tabId): Promise<{machineId,agentId} | null | undefined>`
  (undefined = directory unreadable, keep the roster's); `share_leader { sharedTabId, leader }` now PATCHes the owner's
  desk tab setting (`/api/agent-messages/tabs/<tabId>`) and answers `{ ok: true }`; note role lines (exact text below).

Role lines, verbatim:

```ts
export const LEADER_ROLE = 'You lead this tab. Split the work, give each part to a harness here with `harness send`, track it as GitHub issues with this tab\'s marker, and report back to the person.'
export const WORKER_ROLE = (leader: string) => `${leader} leads this tab. Take work from it, and tell it with \`harness send\` when a part is done or blocked.`
```

- [ ] **Step 1: Write the failing tests**
  - model: a note for an unshared tab with a leader names it and gives the leader `LEADER_ROLE` and the others
    `WORKER_ROLE(<leader name>)`; with no leader the role lines are absent; a leader whose pane left (listing `null`) →
    no role lines (Review Focus 1).
  - service: an unshared tab's leader from the listing reaches the notes of its harnesses on this machine; the shared
    tab's leader still comes from the roster for a member.
  - sharedTabs: the owner's `reshare` signs a roster with the tab setting's leader when it differs from the roster's;
    `ownLeader` undefined keeps the roster's leader; a leader not in the roster is dropped (composeCut).
  - service.sharedTabs: `share_leader` PATCHes the desk tab setting (fake backend records it) and does not sign a roster
    by itself; after the fake backend's `desk_changed`, the sharing computer signs the new leader (Review Focus 2: the
    owner's second computer PATCHes while the sharing computer is "asleep"; on wake, `refresh` signs it).
  - service.sharedTabs: sharing a tab whose setting names a leader signs the first roster with it; after `share_stop`
    the owner's harnesses' notes still name the leader (it lives in the setting).
  - messagesLink: the route list includes PATCH `/api/agent-messages/tabs/<id>`.
- [ ] **Step 2: Run to fail** — `cd cli && npx vitest run src/messages src/core/messagesLink.spec.ts`.
- [ ] **Step 3: Implement** as in Files. The member's note keeps the roster's leader; the owner's tab and every
  unshared tab use the listing's.
- [ ] **Step 4: Run to pass; gates** — `npm run test:shared-tabs`, `npm run test:core`, `npm run typecheck`, `npx vitest
  run src/leanEntry.spec.ts src/architecture.spec.ts`.
- [ ] **Step 5: Checkpoint.**

### Task A3: tasks in every tab, and the merge fields

**Files:**
- Modify: `cli/src/messages/tasks.ts` (marker regex ~116 unchanged; `gh pr view` fields ~153 add
  `autoMergeRequest,mergeStateStatus` (gh has no merge-queue field; see T11); `TaskRow.pr` gains `autoMerge: boolean`,
  `mergeState: string`), `cli/src/messages/service.ts` (`tasksOf` ~476; `share_tasks` ~1305 accepts `tabId`;
  `tasksSection` ~482 for every tab), `cli/src/messages/model.ts` (`markerLines` for every tab)
- Test: `tasks.spec.ts`, `service.spec.ts`, `service.sharedTabs.spec.ts`, `model.spec.ts`

**Interfaces:**
- Produces: `share_tasks { tabId }` (a desk tab of this account with Agent Messages on) → the same `TaskResult`; key =
  `sharedTabIdOf(account.accountId, tabId)`; refused `NOT_A_TAB` "That tab is not on your desk." otherwise. `TaskRow.pr`:
  `{ number, url, state, ci, autoMerge, mergeState }`.
- The note's marker line for every tab: ``Track work as GitHub issues with `<!-- harness-tab:<key> assignee:<account>/<harness> -->` in the body.`` — `<account>` is the label shared tabs already use for this account (T8).

- [ ] **Step 1: Write the failing tests**
  - tasks: `gh pr view` asked with the two new fields; a row's `autoMerge`, `mergeState` parsed (unknown
    `mergeState` → `'UNKNOWN'`); a failed view keeps the defaults `false/'UNKNOWN'`.
  - service: `share_tasks { tabId }` for an unshared desk tab reads `gh` with key `sharedTabIdOf(me, tabId)`; an unknown
    tab → `NOT_A_TAB` and no `gh`; Agent Messages off → `MESSAGES_OFF`.
  - Review Focus 3: the key of a desk tab equals the `sharedTabId` it gets when shared (`share_tab` then `share_tasks
    { sharedTabId }` reads the same marker as `share_tasks { tabId }` did).
  - model: an unshared tab's note carries the marker line with its key.
- [ ] **Step 2–4:** run to fail, implement, run to pass with the gates of Task A2.
- [ ] **Step 5: Checkpoint.**

### Task A4: the one-line summary, `tab_activity`, the switch, the version

**Files:**
- Modify: `cli/src/core/turns/funnel.ts` (~134–136: record `userMessage` per agent on `turn_started`),
  `cli/src/core/api.ts` (`CoreApi.agents.summaries(agentIds): Promise<Record<string, string>>`, fallback `{}`),
  `cli/src/core/main.ts` (wire it: T2 rule), `cli/src/core/messagesLink.ts` (`activity` query answers `{ activity,
  summaries }` when asked `{ agentIds, summaries: true }`), `cli/src/services/processCoreApi.ts`,
  `cli/src/messages/tabActivity.ts` (`ActivityOut.due` takes `{ state, summary? }` and treats a changed summary as due;
  `ActivityIn.take` reads `summary`; `snapshot` keeps idle entries with a summary for `ACTIVITY_IDLE_KEEP_MS`),
  `cli/src/messages/service.ts` (`shareActivity` adds summaries unless hidden; `whoAre` answers `state` and `summary`;
  new `tab_activity` action; `shares` gains `version`), `cli/src/lib/agentSettings.ts` + `cli/src/core/experiments.ts`
  (`agentMessagesHideSummary`, default false), `backend/src/lib/experimentalSettings.ts`,
  `backend/src/routes/experimentalSettings.ts` (`agent_messages_hide_summary`)
- Test: `tabActivity.spec.ts`, `service.sharedTabs.spec.ts`, `service.spec.ts`, `messagesLink.spec.ts`,
  `processCoreApi.spec.ts`, a core turns spec for the prompt map, `agentSettings.spec.ts`, backend experimental tests

**Interfaces:**
- Produces: `tab_activity { tabId }` → `{ harnesses: Array<{ machineId, agentId, state: 'working'|'idle'|'unknown',
  summary?: string, away?: true }> }` (every harness of the tab: this machine's from the core; the account's other
  machines' via `who` with a 4 s deadline, `away: true` when they do not answer; other accounts' from `ActivityIn`).
  `activity` tab request agents `{ agentId, state, summary? }`; `SharedActivity.summary?`; `shared_activity` frame and
  `shares.activity` carry it. `shares.version` = the daemon's `VERSION`. `ACTIVITY_IDLE_KEEP_MS = 10 * 60_000`.
  `SUMMARY_MAX = 120`.

```ts
/** The summary of an agent (T2): what it is doing while it works, else what it last did. */
export function summaryOf(state: 'working' | 'idle' | 'unknown', running: string | undefined, recap: string | undefined): string | undefined {
  const pick = state === 'working' ? running : (recap ?? running)
  const line = pick?.split('\n').find((l) => l.trim())?.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
  return line ? (line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line) : undefined
}
```

- [ ] **Step 1: Write the failing tests**
  - `summaryOf`: working → prompt; idle → recap, else prompt; multi-line → first non-empty line; 500 chars → 120 with
    `…`; bidi/markup control characters removed (Review Focus 4).
  - funnel: `turn_started` with `userMessage` records it for the agent; a later turn replaces it.
  - tabActivity: a changed summary with the same state is due; idle entries with a summary stay in `snapshot` for 10
    minutes then leave; a received summary over 120 or with control characters is cleaned and cut.
  - service: with `agentMessagesHideSummary` on, `shareActivity` sends no `summary`; `tab_activity` for an unshared
    tab answers this machine's harnesses with summaries, another own machine's through `who` (fake rpc), `away: true`
    when it does not answer within 4 s; for a shared tab adds other accounts' from `ActivityIn`; `shares.version` set.
  - messagesLink / processCoreApi: `summaries` asked and passed through; an older core's answer without `summaries`
    reads `{}`.
  - backend: the experiment `agent_messages_hide_summary` is accepted and returned; daemon `agentSettingsFromAnswer`
    maps it; a missing feature reads false.
- [ ] **Step 2–4:** run to fail, implement, run to pass; gates of Task A2 plus `cd backend && npm test -- experimental`
  (or the file's test) and `npx tsc --noEmit`.
- [ ] **Step 5: Checkpoint.**

### Task A5: end to end

**Files:** Modify `cli/e2e/sharedTabs.e2e.ts`.

- [ ] **Step 1: Add the steps** (real backend, two accounts, isolated daemons, the e2e `gh` stub):
  1. Alice sets a leader on an unshared tab through the backend route; her harness's note (read the way existing steps
     read a note) names the leader and the roles.
  2. Alice creates a task for that unshared tab (the `gh` stub returns an issue with the tab's key); `share_tasks
     { tabId }` lists it. Alice shares the tab and invites Bob; Bob's `share_tasks { sharedTabId }` lists the same task.
  3. Alice's second daemon (or the backend route from "another computer") changes the leader; Bob's roster names the
     new leader within 30 s.
  4. Bob's window receives `shared_activity` with a `summary` for Alice's working harness.
- [ ] **Step 2: Run three times** — `cd cli && env SHELL=/bin/sh PATH=<absolute entries only>
  HARNESS_E2E_SERVICES_DIR=$HOME/test-services npx vitest run --config vitest.e2e.config.ts e2e/sharedTabs.e2e.ts`.
  Expected: PASS each time; record timings.
- [ ] **Step 3: Checkpoint.**

---

## Phase B: desktop and web

### Task B1: tab settings, the leader, the step rule and `tab_activity` reads

**Files:**
- Create: `desktop/lib/agent_messages/tab_settings.dart`, `desktop/lib/agent_messages/task_step.dart`,
  `desktop/lib/agent_messages/tab_activity.dart`
- Modify: `desktop/lib/core/api_client.dart` (`readAgentMessageTabs` ~221 returns the parsed listing;
  `setAgentMessageTab(tabId, {bool? enabled, AgentMessageLeader? leader, bool clearLeader})` PATCH),
  `desktop/lib/agent_messages/agent_messages.dart` (`AgentMessagesController.refresh` ~316 keeps the tab settings),
  `desktop/lib/state/app_state.dart` (`desk_changed` handler ~18667 also calls `agentMessages.refresh()`;
  `tabLeader(deskTabId)`; `setTabLeader(deskTabId, machineId, agentId)` / `clearTabLeader`)
- Test: `desktop/test/tab_settings_test.dart`, `desktop/test/task_step_test.dart`, `desktop/test/tab_activity_test.dart`

**Interfaces:**
- Produces: `class AgentMessageLeader { machineId, agentId }`; `AgentMessagesController.leaderOf(deskTabId) →
  AgentMessageLeader?`; `AppNotifier.tabLeader(deskTabId)` = the roster's leader for a shared tab, else the setting's;
  `Future<void> AppNotifier.setTabLeader(String deskTabId, String machineId, String agentId)` and `clearTabLeader`;
  `enum TaskStep { merged, prClosed, merging, buildFailed, building, waitingForReview, workingDraft, closed, working, notStarted }`;
  `TaskStep taskStep(SharedTaskRow row, {required bool assigneeWorking})`; `String taskStepLabel(TaskStep)`;
  `class TabActivityReader` (`Future<List<TabHarnessActivity>> read(String tabId)` via `tab_activity`;
  `TabHarnessActivity { machineId, agentId, state, summary, away }`).

```dart
TaskStep taskStep(SharedTaskRow row, {required bool assigneeWorking}) {
  final pr = row.pr;
  if (pr != null) {
    if (pr.state == 'Merged') return TaskStep.merged;
    if (pr.state == 'Closed') return row.state == 'open' ? TaskStep.prClosed : TaskStep.closed;
    if (pr.autoMerge) return TaskStep.merging;
    if (pr.ci == 'failing') return TaskStep.buildFailed;
    if (pr.ci == 'pending') return TaskStep.building;
    if (pr.state == 'Open') return TaskStep.waitingForReview;
    if (pr.state == 'Draft') return TaskStep.workingDraft;
  }
  if (row.state == 'closed') return TaskStep.closed;
  return assigneeWorking ? TaskStep.working : TaskStep.notStarted;
}
```

Labels: merged "merged", prClosed "pull request closed", merging "merging", buildFailed "build failed", building
"building", waitingForReview "waiting for review", workingDraft "working (draft)", closed "closed", working "working",
notStarted "not started". (`SharedTaskRow.pr` gains `autoMerge`, `mergeState`, parsed with defaults.)

- [ ] **Step 1: Write the failing tests** — every row of the spec's step table (one case each, including a draft with
  pending CI → building); tab settings parse (`leader` null, missing, malformed dropped); `desk_changed` re-reads the
  settings; `setTabLeader` PATCHes `{leader: {...}}` and a failure keeps the old leader and surfaces the error;
  `tabLeader` prefers the roster in a shared tab; `TabActivityReader` parses, drops malformed rows, and keeps `away`.
- [ ] **Step 2–4:** run to fail (`flutter test test/tab_settings_test.dart test/task_step_test.dart
  test/tab_activity_test.dart`), implement, run to pass, `flutter analyze` on touched files.
- [ ] **Step 5: Checkpoint.**

### Task B2: Make Leader / Remove Leader, and the chip in every tab

**Files:**
- Modify: `desktop/lib/screens/swarm_screen.dart` (`paneActions` ~1993: `leader: 'make' | 'remove' | null`;
  `_onNative` case `toggleLeader` ~2468; allowlist ~2616; command `agent_messages.leader`), `desktop/macos/Runner/SwarmTitlebar.swift`
  (File menu item "Make Leader"/"Remove Leader" beside "Remove from Tab" ~361; validate ~549; hide ~577; allowlist
  ~152; icon ~328), `desktop/lib/widgets/linux_menu_bar.dart` (~330–341), `desktop/lib/shortcuts/keymap_commands.dart`
  (`HarnessCommand` like `'agent.share'` ~397), `desktop/lib/agent_messages/pane_shared_chips.dart` (`Leader` chip
  from `app.tabLeader`; on the focused pane, a "Make Leader" link for the web, T6)
- Test: `desktop/test/tab_leader_test.dart`, `desktop/test/native_toolbar_sync_test.dart`, `desktop/test/linux_menu_bar_test.dart`,
  `desktop/tool/swarm_titlebar_checks.swift`

- [ ] **Step 1: Write the failing tests** — the File menu offers "Make Leader" for a pane of this account in a tab with
  Agent Messages on, "Remove Leader" on the leader, nothing for another account's pane or when Agent Messages are off;
  the palette command; the chip appears in an unshared tab after `setTabLeader`; in a shared tab a member gets no Make
  Leader; the owner gets it on every computer; the leader's pane moved to another tab → no chip there and none in the
  old tab (Review Focus 1); the Swift check for the new item.
- [ ] **Step 2–4:** run to fail, implement, run to pass; `tool/check_swarm_titlebar.sh`; `flutter analyze`.
- [ ] **Step 5: Checkpoint.**

### Task B3: the panel in every tab, People for unshared tabs, confirmations

**Files:**
- Create: `desktop/lib/agent_messages/tab_people.dart`
- Modify: `desktop/lib/agent_messages/agent_messages_view.dart` (pills ~310 and bodies ~231–246 for every tab with
  Agent Messages on), `desktop/lib/agent_messages/shared_tab_tasks.dart` (works with a desk `tabId` when there is no
  shared tab: `loadTasks` by `{tabId}`), `desktop/lib/agent_messages/shared_tabs.dart` (`loadTasks(key, {String? tabId})`),
  `desktop/lib/agent_messages/shared_tab_people.dart` (Make Leader through `setTabLeader`; Remove and Remove member through
  the confirmation), `desktop/lib/agent_messages/shared_tab_dialogs.dart` (make `_confirm` public as `confirmSharedAction`)
- Test: `desktop/test/tab_people_test.dart`, `desktop/test/shared_tab_panel_test.dart`

**Interfaces:**
- Produces: `TabPeople(app, deskTabId)` — this account's harnesses in the tab (engine · machine · state · repo/branch
  from `who` where the daemon answers, else omitted), Make Leader / Remove Leader, and **Invite People…** (opens
  `showInvitePeople`).

Confirmation copy, verbatim: Remove — title "Remove <name> from this tab?", body "Its owner can add it again.", confirm
"Remove"; Remove member — title "Remove <email> and their harnesses from this tab?", body "They can be invited again.",
confirm "Remove". Cancel focused, never closes on failure.

- [ ] **Step 1: Write the failing tests** — an unshared tab shows Messages | People | Tasks; People lists its harnesses
  with Make Leader and Invite People…; Tasks reads `share_tasks { tabId }` and shows rows with their step labels;
  Remove and Remove member ask first and send nothing on Cancel; a shared tab's People unchanged otherwise.
- [ ] **Step 2–4:** run to fail, implement, run to pass; `flutter analyze`.
- [ ] **Step 5: Checkpoint.**

### Task B4: the Tab Activity sidebar

**Files:**
- Create: `desktop/lib/agent_messages/tab_activity_sidebar.dart`
- Modify: `desktop/lib/screens/swarm_screen.dart` (wrap the pane canvas `Expanded(Stack(...))` ~7473 in a `Row` with
  the sidebar; command `agent_messages.activity` "Show Tab Activity" ~6968 and gate ~7040; a toggle button in the tab's
  toolbar area), `desktop/lib/shortcuts/keymap_commands.dart` (~522), `desktop/macos/Runner/SwarmTitlebar.swift`
  (View or File menu row ~373), `desktop/lib/widgets/linux_menu_bar.dart` (~377), a per-computer preference via
  `LocalKeyValueStore` (`tab_activity.open.<tabId>`, `tab_activity.width`)
- Test: `desktop/test/tab_activity_sidebar_test.dart`, `desktop/test/web/tab_activity_web_test.dart`

**Interfaces:**
- Consumes: `TabActivityReader` (B1), `taskStep` (B1), `app.tabLeader` (B1), `app.sharedTabs` (tasks, activity frames).
- Produces: `TabActivitySidebar(app, deskTabId)`; width 220–480 px, default 280.

Reading rules (Global Constraints): read `tab_activity` when opened, on `shared_activity` frames and on a harness's
working→idle, else every 30 s while open and in front; tasks per the global rule. Rows: Harnesses first (leader first,
`Leader`), then Tasks ordered by step (working, building, waiting for review, merging, merged; merged older than 24 h
dropped by `updatedAt`). Row clicks: harness → focus its pane (tooltip "Not shown in this tab" when the desk holds no
pane for it); task → open the pull request, else the issue; assignee → focus its pane. Away harnesses: `⚠` and
"waiting for <owner>'s computer" (or "computer away" for this account's).

- [ ] **Step 1: Write the failing tests** — open/close and the remembered width and open state per tab; rows for 9
  harnesses on three machines with one away (Review Focus 5: `⚠` rows, no spinner forever, `gh` read once on open and
  not again within 60 s); a hostile 500-char summary with a bidi override renders one ellipsized line (Review Focus 4);
  skeleton rows while the first read is pending, "No harnesses in this tab." vs skeleton never alike; merged > 24 h
  hidden; clicks; the summary switch off on the other account → no summary text, state still shown; the Chrome test
  clicks the toggle and a row.
- [ ] **Step 2–4:** run to fail, implement, run to pass; `flutter analyze`; the Chrome test.
- [ ] **Step 5: Checkpoint.**

### Task B5: the update line and the summary switch

**Files:**
- Create: `desktop/lib/agent_messages/update_harness.dart`
- Modify: `desktop/lib/agent_messages/agent_messages_view.dart` (~332–342), `desktop/lib/settings/sections/tab_invites_section.dart`
  (~65–67), `desktop/lib/settings/experimental_features.dart` (the switch under Agent Messages)
- Test: `desktop/test/update_harness_test.dart`, `desktop/test/experimental_features_test.dart`

**Interfaces:**
- Produces: `const kAgentMessagesMinimumCli = '0.4.15'`; `UpdateHarnessLine(app)`; reads the local daemon's version from
  `/api/health` (`{ok, version}`, `cli/src/hookServer.ts` ~463) on the local base URL; **Update now** runs
  `harness update` (a `-dev` version: `harness update --force` after the confirmation "This replaces the development
  build on this computer with the latest release."), shows "Updating…" until the daemon answers with a newer version or
  the run fails ("The update didn't finish. Run harness update in a terminal."). Web: the line without the button.

Copy, verbatim: "This computer runs Harness <current>; shared tabs need <required> or newer." / development build:
"This computer runs a development build of Harness (<current>), which doesn't update itself." Switch title: "Share a
one-line summary of what your harnesses are doing with people in your shared tabs", checked when
`agent_messages_hide_summary` is off.

- [ ] **Step 1: Write the failing tests** — the line with versions; the dev wording and confirmation; Update now runs
  the right command through an injected runner (never the real CLI in tests); the web hides the button; the switch
  reads and writes the inverted experiment.
- [ ] **Step 2–4:** run to fail, implement, run to pass; `flutter analyze`.
- [ ] **Step 5: Checkpoint.**

---

## Phase C: verification and docs

### Task C1: verification

- [ ] **Step 1: Suites** — cli (Node 24): typecheck, `test:shared-tabs`, `test:core`, `test:sharing`, `leanEntry` +
  `architecture`; backend: `test:agent-messages`, `tsc`, experimental tests; desktop: `flutter analyze`, `make -C ..
  desktop-test` (0 failures; any failure diffed against a clean `main` worktree), `tool/check_swarm_titlebar.sh`, the
  Chrome tests under `test/web/` this work added. Record exact counts.
- [ ] **Step 2: By hand** — `cli/scripts/spike-a-stack.ts`, a desktop under the spike bundle id: one tab of three of
  Alice's harnesses, unshared: Make Leader (chip), give the leader one sentence, watch the sidebar (summaries, steps
  through the `gh` stub), Remove Leader; then share it and invite Bob: the task stays, Bob sees the leader and the
  sidebar with Alice's summaries. Screenshots in the scratchpad; report each step.

### Task C2: docs

- [ ] Write T1–T10 into the spec (as "Rulings made while building"), mark the spec "built", and add the plan's
  follow-ups (anything found in C1) at the end of this plan. English, plain sentences; grep the new visible strings for
  "team".

## Not in this plan

A working folder per harness, history over time, the phone, editing tasks from the sidebar, and the remaining 1c
follow-ups.

## Follow-ups

Open items after the build.

### Backend

- The backend's `key()` joins machine and agent ids with `/`, which is ambiguous when an agent id contains `/`; use
  `JSON.stringify` or an exact pane compare.
- The leader PATCH reply returns the stored leader without the pane check (the listing is authoritative), and the
  validation and the upsert are not atomic.
- The read-time roster query loads every live share's roster on each poll when a leader is a member's harness; narrow
  it by tab id.
- The PATCH tabs route also accepts `enabled` (the allowlist is method plus path).
- Roster leaders set before the upgrade are cleared at the first refresh after it; older desktops get a misleading
  `INVALID_LEADER` during the rollout.

### Daemon

- `whoAre` reads activity and summaries on every own-machine `who`; check the cost under a watch.
- `missedTabAt` is one timestamp for all tab ids, so a new tab asked within 15 seconds of a miss gets `NOT_A_TAB`.
- Cloud agents may never get a summary (`registry.byAgent`); `mirror.recent` is uncached per idle agent.
- A whitespace-only received summary is kept.
- `signedInAs().then(notesPump)` on wake may cost a backend call when not cached.
- `tab_activity` does not carry a "sharing ended" state (the window's model has only `away`).
- A member's computer with no harness in the tab gets no activity or summaries (the 1c viewer-only limitation).
- Stray blank line and a long doc comment in `markerLines`.

### Desktop

- Each tab switch re-opens the sidebar and re-reads both lists (the daemon's cache protects `gh`).
- The panes-only fallback marks offline panes idle.
- Saved per-tab sidebar preferences are never cleaned up.
- The drag handle clamps oddly and has no keyboard resize.
- The Step column narrows Title on narrow panels; unshared People omits repo and branch (`share_who` needs a shared id).
- The Leader chip itself can overflow in a very narrow pane; the real-font fit at about 640 px was not re-screenshotted.
- After a successful update the line keeps the old version until refresh.
- `removeLeaderOffered` and `removeLeader` compute the same value twice in `pane_shared_chips.dart`.
- `deskTabHolding` takes the first tab holding a pane.
- The fallback error text is generic.
- If the socket fails the app falls back to TCP on the base port (the app's existing behaviour).

### Tests

- No mounted test of palette enablement; no test of a failing confirmed Remove keeping the dialog open.
- `AppNotifier` tab-activity wiring and the panel and Settings wiring of the update line are untested.
- The summary-switch test cannot tell the switch from "no summary".
- The E2E stub `keyedGh` hard-codes assignee `alice`/`lead`, so a label rewritten on share would not be caught.
- `service.spec`, `model.spec` and `service.sharedTabs.spec` are outside the 100% gates.
