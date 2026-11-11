# Manage ▸ Backlog: every task in the Swarm in one list: implementation plan

> Worked by this project's instructions (Engineer role): this plan is the pull request's first commit. Then each task
> is done test first, by one Engineer, with one Review step and one Test step on the pull request. Steps use checkbox
> (`- [ ]`) syntax.

**Goal:** a Backlog tab in Desktop Manage, after Swarm. It lists every task the reader can read, across projects,
grouped by state. Each row has two lines. It has filters for project, Mine and state, and a click on a row opens the
task's chat.

**Architecture:** the tab is a view over the Swarm snapshot the controller already holds, kept current by the change
reads it already makes. It adds no Swarm read and no timer. A pure function places each task in a group from its
assignment, liveness and shippedAt. The rows reuse the task line (`superTabTaskStatus`), the agent and machine names
(`snapshot.agentName`, `controller.sessionMachineName`) and the pull request state (`SuperTabCardPullRequest` over the
view's shared `SuperTabPullRequestFacts`). One getter is added: when a group last changed (`parts.groupChangedAt`), for
the row's last-activity time.

**Tech Stack:** Flutter 3.47.2 Desktop (`flutter_test`, `ConversationServer` fixture, headless screenshots).

**Spec:** task #2355 brief (Lead, 2026-11-03), and the mockup Scholes accepted in the project chat (2026-11-03 14:34 VN),
with "Waiting on someone" added:

```
 Machines   Models   Devices   Swarm   Backlog
 [All projects ▾]  [Mine]  [All states ▾]                 30 tasks
 Waiting for a machine · 1
  #2347 New session starts on last project  openharness · scholes
        no agent yet · waits on a Desktop engineer            5m
 Working · 9
  #2309 Sidebar task groups                 openharness · huy
        Thorne · Pro-9 · PR #2733 ● CI running                 2m
```

## Global Constraints

- PR body first line: "Requested by scholes@autonomous.ai through Harness."
- Out of scope: editing or reassigning from the tab.
- Harness design language (desktop/design/desktop-design-system.md): flat list rows, two lines, color never the only
  signal, and the existing PR icon and check words.
- Groups, in this order: Waiting for a machine, Working, Waiting on someone, In review, Ready to merge, Shipped.
  "Waiting on someone" uses the same rule as Huy's sidebar groups (#2733, `superTabTaskGroupOf`): a liveness wait on a
  person. Its wording is the task line's (task_status.dart).
- Reads: only what changed since the last read. Nothing polls whole state (PRODUCT.md tech targets).
- Desktop tests use a memory store and a fake sign-in, never the real CLI.

## Design

- Growth: nothing is stored. The tab holds no state beyond its three filters, which live in memory and are not saved.
- Concurrency: N/A because it only reads the controller's snapshot on the UI thread, as the sidebar does.
- Read cost: no new Swarm read and no timer. Rows rebuild when the controller notifies, which happens on the change
  reads it already makes. CI state comes from the view's shared pull request facts, which already serve the live
  cards. The tab watches only open tasks' pull request URLs, only while it is on screen, and stops watching when it
  leaves. Those URLs are read in the facts' one batched call.
- Scale 10x: 300 tasks across 30 projects means one pass over the snapshot (grouping and sorting, linear in the
  tasks) and a lazily built list (`LaidOutListView`). The first metric to warn is the number of watched pull request
  URLs (GitHub calls per facts round). It is capped at the open tasks' pull requests, with shipped ones not watched.
- Compatibility: Desktop only. A backend without liveness or `shippedAt` still lists its tasks: the group falls back
  to the assignment's status.
- Migration + rollback: none.
- Audience: the server sends only groups the reader may read (visibleState). The tab also leaves out the lead chats,
  Buddy chats, steps (`reviewOf`) and private chats (`hiddenByBuddies`), as the sidebar does.
- Identity: N/A because nothing acts on anyone's behalf.
- Failure: no pull request facts (no `gh`, or a failed read) shows "PR #N" with no CI word, as the live cards do. A
  task in an unknown state is listed under Working with its raw status, never dropped.
- Platforms: Desktop (macOS, Linux, Windows) and the web at desktop width, where Manage exists. The phone has no
  Manage.

## Checked against ENGINEERING.md

1. Simple: one new view and one placement function, with no options. 2. Nothing left behind: no stubs; the Manage
"four tabs" test is updated. 3. Correct: each behavior has a failing test first (below). 4. Hot paths: Desktop
rendering; the list is built lazily, and the numbers are given for 300 tasks (Task 3). 5. Data: N/A, nothing stored.
6. Failures seen: a missing CI state reads as "PR #N" alone, and an unknown state is shown. 7. Secure: it reads only
what the server sends this reader. 8. Measurable: Desktop counts use only by fixed counter names that the backend's vocabulary accepts
(measurement/product_measurement.dart). A "Backlog opened" counter therefore needs a backend vocabulary change, which is
outside this task. It is left to the PM as a follow-up, and this PR adds no measure. 9. Architecture:
a shared Flutter screen, no new dependency. 10. Platforms: as above. 11. Readable: Naming System words (task, agent,
machine, pull request). 12. One pull request.

## Review Focus

1. A task moving between groups while the tab is open (a change read lands): the row moves, and the filters keep
   their values (Task 2 test).
2. A reader in many projects with no tasks: an empty state reads "No tasks", never a blank page (Task 2 test).
3. A shipped task whose agent was removed: the row still shows, with "Agent unavailable" (Task 2 test).
4. Mine when the reader asked for nothing: "No tasks you asked for", with the count 0 (Task 2 test).
5. Pull request facts unavailable: "PR #N" with no CI word, and no error (Task 2 test).

---

### Task 1: placing a task in its group, and the list of tasks

**Files:**
- Create: `desktop/lib/super_tabs/backlog.dart`
- Modify: `desktop/lib/super_tabs/controller.dart` (one getter, `groupChangedAt`)
- Test: `desktop/test/super_tab_backlog_test.dart`

**Interfaces:**
- Produces: `enum SuperTabBacklogGroup { waitingForMachine('Waiting for a machine'), working('Working'),
  waitingOnSomeone('Waiting on someone'), inReview('In review'), readyToMerge('Ready to merge'), shipped('Shipped') }`.
- Produces: `SuperTabBacklogGroup? superTabBacklogGroupOf(SuperTabConversation task)`. Null means not listed (a
  cancelled task). Precedence:
  1. `shippedAt` set → shipped.
  2. Status `done` → ready to merge.
  3. Liveness `waiting`/`person`, or status `needs_human` or `blocked` → waiting on someone.
  4. Status `review`, or liveness `waiting`/`review` or `revision` → in review.
  5. No assignment, no agent, status `stopped` or `lost`, or liveness `waiting`/`queued` → waiting for a machine.
  6. Anything else → working.
- Produces: `List<SuperTabConversation> superTabBacklogTasks(SuperTabController c)`. These are the tasks of every
  project, open and closed, held by the snapshot, filtered as the sidebar filters them, newest number first.
- Produces: `DateTime? SuperTabController.groupChangedAt(String groupId)`.

- [ ] **Step 1: failing tests:** `each state lands in its group` (a table of assignment, liveness and shippedAt rows
  to the expected group, including cancelled → null); `lists every readable task across projects, and no lead chat,
  Buddy chat, step or private chat`.
- [ ] **Step 2: run them and see them fail** (`flutter test test/super_tab_backlog_test.dart`).
- [ ] **Step 3: implement.**
- [ ] **Step 4: run them and see them pass.**
- [ ] **Step 5: commit** test first, then code.

### Task 2: the Backlog view and its tab

**Files:**
- Create: `desktop/lib/super_tabs/backlog_view.dart` (`SuperTabBacklogView`)
- Modify: `desktop/lib/super_tabs/manage_page.dart` (`SuperTabManageTab.backlog`, its tab after Swarm, its body, and
  an `onOpenConversation` callback)
- Modify: `desktop/lib/super_tabs/view.dart` (pass `_openConversation` and the shared pull request facts)
- Test: `desktop/test/super_tab_backlog_test.dart`, `desktop/test/super_tab_manage_page_test.dart` (five tabs)

**Interfaces:**
- Consumes: Task 1's functions.
- Produces: keys `super-manage-tab-backlog`, `super-backlog-row-<groupId>`, `super-backlog-group-<group.name>`,
  `super-backlog-project`, `super-backlog-mine` and `super-backlog-state`.

Each row shows:
- Line 1: `#N title`, then `project · requester` in the metadata style.
- Line 2: `agent · machine · PR #N <check word>`, then the task line's reason ("no agent yet" when there is none).
- Right side: the age since `groupChangedAt`.
- A group header reads `Label · count`.
- The header row shows the filters and "N tasks".

- [ ] **Step 1: failing tests:**
  - `groups in order with counts, each row its two lines`;
  - `Mine shows only the tasks the reader asked for`;
  - `the project and state filters narrow the list and the count`;
  - `a task the reader cannot read is absent` (a private group whose audience leaves the reader out);
  - `clicking a row opens its chat`;
  - Review Focus 1–5.
- [ ] **Step 2: run them and see them fail.**
- [ ] **Step 3: implement.**
- [ ] **Step 4: run them and see them pass.** Then run the manage, sidebar, activity and pull request test files, plus
  `laid_out_list_test`, and `python3 scripts/check-ui-style.py --only desktop/lib/super_tabs`.
- [ ] **Step 5: commit** test first, then code.

### Task 3: screenshots and numbers

- [ ] `desktop/test/super_tab_backlog_shots_test.dart` (`SUPER_TAB_BACKLOG_SHOTS=<dir>`): a Swarm with tasks in every
  group, all filters off, Mine on, and one project, in light and dark.
- [ ] A build-time measure: the Backlog with 300 tasks across 30 projects, the time to build its first frame and to
  rebuild after a change read, reported in the PR.
- [ ] Commit the PNGs in their own commit, link them in the PR body, and remove them in the next commit.
