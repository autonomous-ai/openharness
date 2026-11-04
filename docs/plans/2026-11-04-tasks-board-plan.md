# Project Tasks view (Board and List) Implementation Plan

> **For agentic workers:** Follow the project's Engineer workflow: this plan is the draft pull request's first commit;
> each plan task commits its failing test, watches it fail, then commits the code that passes it; one independent review
> step on the pull request. Backend and CLI tasks (1–4) and Desktop tasks (5–10) share only the wire fields named in
> their Interfaces, so the two halves may run in parallel.

**Goal:** One place per project to see its work, from proposal to shipped: a Tasks view in the project header (Board by
default, or List), with a red count of the tasks that need the reader, in place of the sidebar's task groups. It
strengthens "Tell the PM what you want, and your crew ships it": every ask is in view until it ships, so none is
forgotten.

**Architecture:** One Desktop function places each task in a column (Proposals, Next up, Working, Waiting, Shipped) with
a Needs-you mark and a caption state. Board, List, the header badge and the project row's badge all use it. The server
keeps a shared Next-up order as one sparse rank per task, so moving a card rewrites only that task. It sets the rank
with one command a person or the PM sends. It keeps a project's unanswered Buddy proposals on the project, where they
reach readers as the status card does. Both arrive through the change feed the app already reads, so cards move with
no reload or poll.

**Tech Stack:** TypeScript, Zod, Vitest (backend, CLI); Flutter/Dart (Desktop).

**Spec:** Task #2569 in Super Tab conversation 4f517cb03e671a3604090a53 (Dee, 2026-11-04; brief from River the same
day). It builds on #2867 (ask state: `✋ Proposal`) and #2872 (Backlog's Shipped means merged).

## Global Constraints

- The mockup Dee confirmed, and only this:

  ```
  # openharness                     Chat  Terminals  Tasks (3)  People

  Tasks                                              [ Board | List ]   Mine   Search

  Proposals 2      Next up 3        Working 2        Waiting 2        Shipped 9
  Backlog shows    Shipped means    One tag per      ● Needs you      Task chat keeps
  nothing in Mine  merged           ask              First run of     its sender
  scholes · 3m     scholes          dee · Finch2 ·   the test copy    diego · 1h
                                    PR #2867         ken15 · Dee to
  Rename a Swarm   Remove the old                    decide
  from the phone   preview route    Dial thread
  tony · 23m       River · not      alerts           Task chat        …
                   before Dec 4     diego · Larch4   grouping
                                                     diego · in review
  ```

  The PM confirmed (2026-11-04) that only Tasks joins the project header, between Terminals and People. A project-wide
  Pull requests view is a later task.
- Columns, in this order: Proposals, Next up, Working, Waiting, Shipped. Not listed: cancelled, declined or stopped.
- Proposals: Buddy proposals the PM has not answered (#2867's `✋ Proposal`), however old, oldest first.
- Next up: open tasks nobody is moving yet, in the shared queue order. New tasks join the bottom.
- Working: an agent is working or starting.
- Waiting: in review, changes requested, waiting on a person, blocked, queued for a machine, or its agent lost or quiet.
  The caption says on what: "in review", "Ken to decide", "waiting for a machine", "agent lost".
- Shipped: merged in the last 7 days, archived tasks included, newest first. Finished with no pull request: "Done".
- Needs you: tagged, waited on by name, or asked in its agent's terminal. The task stays in its column, shows a red dot
  and the words "Needs you", and sorts first in its column. The Tasks icon shows a red count, with no badge at 0. The
  project's sidebar row adds them to its badge.
- Card: the title (up to two lines), then a caption: requester · agent · state, joined by " · ". No task numbers,
  machines or models. A click opens the task's chat with the Tasks icon selected; the Tasks icon brings the board back.
- Drag only inside Next up. A drop anywhere else goes back, and no other column shows a drop target. Keyboard: a focused
  Next-up card moves with ⌥↑ and ⌥↓.
- "not before <date>" on a Next-up card, set by the PM.
- List: the same groups as sections, in the same order, with Shipped folded. Each row has the title and the same
  caption.
- Board or List, and Mine, are remembered per person on this Mac.
- The view's bar holds a Board/List switch, Mine (tasks I asked for) and Search (by title), and nothing else.
- Sidebar: no task rows under a project. Needs you, Working, Waiting on others, The rest and Closed (N) all go. Next
  unread skips tasks. Task replies stay in Activity ▸ New replies and show as an unread dot on the card.
- An empty column shows its header with 0. A project with no tasks shows "No tasks yet".
- Manage ▸ Backlog stays.
- Harness Design Language (desktop/design/desktop-design-system.md, icon-design-system.md):
  - flat rows, with the caption on the second line
  - colour is never the only signal
  - no explanatory sentences
  - tokens, never hard-coded colours or sizes
- The header's Pull requests view is the model for how Tasks opens and closes.
- The phone app (mobile/) is untouched. No Swarm code goes in cli/src/core.
- Desktop tests use a memory store and a fake sign-in, and never sign the Mac out of the real CLI.
- The PR body starts with "Requested by dee@autonomous.ai through Harness.".

## Design

- **Growth.** A task's rank and date live on its group and go when the group goes: project or Swarm deletion, as today.
  Open proposals are capped at 100 per project. An entry goes when the PM replies in the proposal's thread or opens a
  task from it. Past 100, the oldest drops with a `proposals.dropped` log line. The cap is far above today's count:
  under 10 open per project.
- **Concurrency.** Both are written in the command's existing state transaction, so two moves serialize. A move names
  the task it goes after, never an index, so a stale view still lands where the person dropped the card.
- **Read cost.** No new read or query. A move rewrites one group's part. A proposal change rewrites the project's part,
  as a status card does. Renumbering a whole queue happens only when two ranks get closer than 1e-6, about 40 moves
  into the same gap.
- **Scale.** At 10x, 300 open tasks in a project, a move is still one write. The first warning is the size of the
  project part with 100 proposals (about 15 KB), visible in the change feed's bytes per part.
- **Compatibility.**
  - An older client ignores `queueRank`, `notBefore` and `openProposals`.
  - A new client on an older backend orders Next up by number (oldest first) and shows no Proposals. When the backend
    refuses `work.queue` with `VALIDATION_ERROR`, the card goes back and the view says "Update Harness's server to
    reorder".
- **Migration and rollback.**
  - No migration for ranks: an unranked task sorts by its number.
  - Proposals from before this ships get a one-time backfill per project (Task 3).
  - Rollback leaves the fields unread, and an older backend drops nothing it does not know.
- **Audience.**
  - `openProposals` reaches only readers of the project chat, by the same rule as `status` (model.ts `visibleState`).
  - `work.queue` is refused unless the sender is a person who can write in the project, or that project's PM
    (`coordinatorOrPerson`).
- **Identity.** No command takes a person from its sender. The proposal's `personId` is the one the server recorded
  when it posted it.
- **Failure.**
  - A refused move puts the card back and names why in the view's bar.
  - A failed read of Shipped's archived tasks shows "Couldn't load older shipped tasks", as Backlog does.
- **Platforms.**
  - Backend.
  - CLI skill text.
  - Desktop on macOS, Linux, Windows and web, through the shared Flutter code; tested on macOS.
  - The phone is untouched.

## Review Focus

- A task's column moves live: a status change, a merge, a lost agent, a reply that tags the reader. Board and List read
  the controller's snapshot each build, so a test changes the server state and pumps, with no reload.
- Two people reorder at once, or one drops on a stale board: the move names its neighbour, and the server's order wins
  on the next change. Test: a move after a task that has since left Next up is refused, and the card goes back.
- A task tagged for the reader in Shipped, or a quiet task with a question: Needs you is a mark, not a column. Test both.
- A project whose PM is gone (no lead agent): proposals stay listed, and a person can still reorder.
- Long titles and names, 160–200% text, an empty project, a column of 0. These go in the screenshot test.

## Task 1: Backend: a task's queue rank and not-before date

**Files:**

- Modify: `backend/src/superTabs/model.ts` (Conversation: `queueRank?: number`, `notBefore?: string`)
- Modify: `backend/src/superTabs/commands.ts` (schema and handler)
- Create: `backend/src/superTabs/taskQueue.ts`, `backend/src/superTabs/taskQueue.test.ts`
- Test: `backend/src/superTabs/commands.test.ts`

**Interfaces:**

- Produces:
  - command `{ type: 'work.queue', conversationId: string, after?: string | null, notBefore?: string | null }`
    - `after` absent: the task stays where it is. `null`: it goes to the top. An id: it goes right after that task.
    - `notBefore` is `YYYY-MM-DD`; `null` clears it.
    - At least one of the two is given.
  - group fields `queueRank?: number` and `notBefore?: string`, read by Desktop.
- `queueKey(g) = g.queueRank ?? g.number ?? 0`. Siblings are the project's open tasks:
  - not archived
  - not the project chat, a Buddy chat or a private chat
  - no `reviewOf`
- `placeAfter(siblings, taskId, after): Map<string, number>` returns the ranks to write:
  - usually just the moved task's: the midpoint between `after` and the next sibling, `min - 1` for the top,
    `max + 1` for the bottom
  - when the gap falls below 1e-6, every sibling, as 1..n in order

- [ ] Write failing tests:
  - `taskQueue.test.ts`: `placeAfter` to top, to the middle, to the bottom, and renumbering once gaps run out. An
    unranked task sorts by its number, so a new task comes last.
  - `commands.test.ts`:
    - a person moves a task after another, and the group reads `queueRank` between them
    - the PM sets `notBefore: '2026-12-04'`, then clears it with `null`
    - refused:
      - an Engineer agent (`COORDINATOR_REQUIRED`)
      - `after` naming a task of another project, an archived task, a step or itself (`QUEUE_UNKNOWN`, 400)
      - a malformed date, or neither field given (validation)
    - after a refusal, `f.state` is unchanged
    - the same operation id sent again does the work once
- [ ] Run `cd backend && npx vitest run src/superTabs/taskQueue.test.ts src/superTabs/commands.test.ts -t queue`:
  FAIL.
- [ ] Implement `taskQueue.ts` and the `work.queue` case: `chatOnly`, `open()`, `coordinatorOrPerson`, then
  `placeAfter`.
- [ ] Run again: PASS. Commit.

## Task 2: Backend: a project's open proposals

**Files:**

- Modify: `backend/src/superTabs/projects.ts` (SwarmProject `openProposals?: OpenProposal[]`)
- Modify: `backend/src/superTabs/commands.ts`:
  - `buddy.propose` adds an entry
  - `conversation.create` with a proposal removes it
  - `message.send` by the project's lead agent in a proposal's thread removes it
- Modify: `backend/src/superTabs/model.ts` (`visibleState`: strip `openProposals` where `status` is stripped)
- Test: `backend/src/superTabs/buddies.test.ts`, `backend/src/superTabs/commands.test.ts`

**Interfaces:**

- Produces: `OpenProposal = { messageId: string; title: string; personId?: string; at: number }`.
  - `title` is `proposalTitle(command)`.
  - The list is kept oldest first and capped at `MAX_OPEN_PROPOSALS = 100`.
  - Desktop reads it on the project.
- [ ] Write failing tests:
  - a proposal lists `{messageId, title, personId, at}` on its project
  - a PM reply in its thread removes it; a Buddy's or a person's reply does not
  - a task opened with `proposalMessageId` removes it
  - the 101st drops the oldest
  - a reader who cannot read the project chat gets no `openProposals`
- [ ] Run `npx vitest run src/superTabs/buddies.test.ts src/superTabs/commands.test.ts -t proposal`: FAIL.
- [ ] Implement. Run: PASS. Commit.

## Task 3: Backend: backfill proposals sent before this ships

**Files:**

- Create: `backend/src/superTabs/proposalBackfill.ts`, `backend/src/superTabs/proposalBackfill.test.ts`
- Modify: `backend/src/worker.ts` (start it beside `startThreadBackfill`)

**Interfaces:**

- A project without `openProposals` has not been backfilled. The backfill does the following for each such project:
  1. Pages its chat's messages by the existing `[tabId, conversationId, sequence, id]` index, reading only `id`,
     `source`, `text` and `createdAt`.
  2. Keeps the `buddy-proposal` roots that are still unanswered:
     - no group in the Swarm (live or dormant) has `ledger.proposal.messageId` naming it
     - no reply in its thread from the project chat's `leadId`
  3. Writes the list (`[]` when there is none) in one state transaction. Each project is read once.
- [ ] Write failing tests:
  - a project with an answered and an unanswered proposal gets only the unanswered one
  - a second run reads nothing
  - a proposal that arrives during the run is kept
- [ ] Run: FAIL. Implement, with the same run-once guard and batch cap as `threadBackfill.ts`. Run: PASS. Commit.

## Task 4: CLI: the PM keeps Next up in order

**Files:**

- Modify: `cli/src/lib/swarmSkills.ts` (both PM skills, under keeping work moving)
- Modify: `cli/src/lib/swarmTools.ts` (task and group commands)
- Test: `cli/src/lib/swarmSkills.spec.ts`

- [ ] Write a failing spec: the PM text names `work.queue` with `after` and `notBefore`, and the tools text documents
  the command's JSON.
- [ ] Run `cd cli && npx vitest run src/lib/swarmSkills.spec.ts`: FAIL.
- [ ] Add the text:
  - PM: "Keep the project's Next up in the order work should start: `work.queue` with `after` (null for the top) moves
    a task, and `notBefore` (YYYY-MM-DD) marks a promise such as removing a route after a date."
  - Tools: the JSON and who may send it.
- [ ] Run: PASS. Commit.

## Task 5: Desktop: one function places a task

**Files:**

- Modify: `desktop/lib/super_tabs/task_groups.dart`. It replaces `SuperTabTaskGroup` and `superTabGroupTasks`; the
  sidebar's groups go.
- Modify: `desktop/lib/super_tabs/model.dart`:
  - `SuperTabConversation.queueRank`, `notBefore`
  - `SuperTabProject.openProposals` (`SuperTabProposal`)
- Modify: `desktop/lib/super_tabs/backlog.dart` (make #2872's shipped test public: `superTabTaskShipped`)
- Test: `desktop/test/super_tab_task_groups_test.dart` (rewritten for columns)

**Interfaces:**

- Produces:
  ```dart
  enum SuperTabTaskColumn { proposals('Proposals'), nextUp('Next up'), working('Working'), waiting('Waiting'), shipped('Shipped') }
  typedef SuperTabTaskPlace = ({SuperTabTaskColumn column, bool needsYou, String? state});
  SuperTabTaskPlace? superTabTaskPlaceOf(SuperTabConversation task, {required String readerId, required DateTime now,
      int mentions = 0, int needsHuman = 0, String? Function(String personId)? personName});
  List<SuperTabConversation> superTabNextUpOrder(Iterable<SuperTabConversation> tasks); // queueRank ?? number, then number
  ```
- What `state` says, in the chat tag's and live card's words:
  - Working: `PR #N` once a pull request is linked
  - Waiting, by cause:
    - review: `in review`
    - revision: `changes requested`
    - person or `needs_human`: `<Name> to decide`
    - blocked: `blocked`
    - queued, or no agent: `waiting for a machine`
    - orphaned: `agent lost`
    - quiet: `quiet`
    - done with an unmerged pull request: `ready to merge`
  - Shipped: `PR #N`, or `Done`
  - Next up: `not before Dec 4`

- [ ] Write failing tests. They place each state:
  - no assignment, then Next up
  - working or planned, then Working
  - `waiting/starting`, then Working
  - `waiting/review`, then Waiting "in review"
  - `waiting/revision`, then Waiting "changes requested"
  - `waiting/person` naming Ken, then Waiting "Ken to decide", and Needs you when Ken is the reader
  - `needs_human`, then Needs you
  - `quiet` with a question, then Waiting with Needs you
  - `quiet` with none, then Waiting "quiet"
  - `orphaned/lost`, then Waiting "agent lost"
  - `waiting/queued`, then Waiting "waiting for a machine"
  - blocked, then Waiting
  - cancelled, then null
  - stopped, then null
  - done with no pull request, then Shipped "Done"
  - merged 2 days ago, then Shipped "PR #12"
  - merged 8 days ago, then null
  - done with an unmerged pull request, then Waiting "ready to merge"
  - tagged in a Shipped task, then Shipped with Needs you

  `superTabNextUpOrder` puts ranked tasks in rank order, and an unranked new task last.
- [ ] Run `cd desktop && flutter test test/super_tab_task_groups_test.dart`: FAIL.
- [ ] Implement. Run: PASS. Commit.

## Task 6: Desktop: the sidebar lists no tasks

**Files:**

- Modify: `desktop/lib/super_tabs/project_sidebar.dart`:
  - remove `_workgroups`, `_taskGroupHeading` and `_closed`
  - `superTabSidebarOrder` lists no tasks
  - the project row's badge adds Needs-you tasks
- Modify: `desktop/lib/super_tabs/controller.dart` (remove `taskGroupFolded`, `toggleTaskGroup`, `closedOpenProjects`,
  and the expansion that showed only them)
- Test: `desktop/test/super_tab_task_groups_test.dart` (sidebar and next-unread parts)

**Interfaces:**

- Produces: `int superTabTasksNeedingYou(SuperTabController c, SuperTabProject p, {int Function(SuperTabConversation)? needsHuman})`.

- [ ] Write failing tests:
  - the grouped fixture shows no `super-group-<task>` row and no `super-task-group-*` heading
  - the project row's badge reads the chat's mentions plus the Needs-you tasks
  - ⌥⇧↓ goes from one project chat to the next, past an unread task
- [ ] Run: FAIL. Implement. Run: PASS. Commit.

## Task 7: Desktop: the Tasks view, Board and List

**Files:**

- Create: `desktop/lib/super_tabs/tasks_view.dart` (bar, Board, List, empty state, saved choice)
- Create: `desktop/lib/super_tabs/task_card.dart` (card and list row: title, caption, Needs-you mark, unread dot)
- Modify: `desktop/lib/shared/theme/app_icons.dart` (`squareKanban`), then run `scripts/audit-icons.py`
- Test: `desktop/test/super_tab_tasks_view_test.dart`

**Interfaces:**

- Produces:
  - `SuperTabTasksView(controller:, project:, storage:, needsHuman:, onOpenTask:, onOpenProposal:, now:)`
  - the saved choice is under `super-tab-tasks-view/<accountId>` as `{"layout":"board"|"list","mine":bool}`
  - keys: `super-tasks-column-<column>`, `super-task-card-<id>`, `super-tasks-layout`, `super-tasks-mine`,
    `super-tasks-search`

- [ ] Write failing tests:
  - Board shows five columns in order, with counts, and 0 on an empty one
  - "No tasks yet" for a project with none
  - a Needs-you card sorts first and reads "Needs you"
  - the caption reads `dee · Finch2 · PR #2867`, with no number, machine or model
  - Proposals lists `openProposals` oldest first, as `scholes · 3m`
  - Shipped includes an archived task from the closed read
  - List shows the same sections, with Shipped folded
  - Mine keeps the reader's asks; Search filters by title
  - the layout and Mine survive a rebuild with the same memory store
  - a server change moves a card with no reload
- [ ] Run: FAIL. Implement. Run: PASS. Commit.

## Task 8: Desktop: reorder Next up by drag and keyboard

**Files:**

- Modify: `desktop/lib/super_tabs/tasks_view.dart`:
  - Next up is a `ReorderableListView` with drag handles
  - other columns are plain lists, so they offer no drop target
- Modify: `desktop/lib/super_tabs/controller.dart`:
  `Future<String?> queueTask(String taskId, {required String? after})`. It shows the new order until the server
  answers, and returns the refusal's message or null.
- Modify: `test/support/super_tab_fixture.dart` (the fake server applies `work.queue`)
- Test: `desktop/test/super_tab_tasks_view_test.dart`

- [ ] Write failing tests:
  - dragging the third Next-up card to the top sends `work.queue` with `after: null`, and the order holds after a new
    controller reads the same server (a reload)
  - dropping a Next-up card on Working sends nothing and leaves both columns as they were
  - a Working card has no drag handle
  - ⌥↑ on a focused card moves it up one, and ⌥↓ down one, each sending `after`
  - a refused move puts the card back and shows the refusal
- [ ] Run: FAIL. Implement. Run: PASS. Commit.

## Task 9: Desktop: the header's Tasks icon

**Files:**

- Modify: `desktop/lib/super_tabs/view.dart`:
  - `_showTasks`, which switches like `_showPullRequests`
  - the Tasks button `super-tasks`, between Terminals and People, with `SuperTabCountBadge` when the count is above 0
  - a task's header shows the Tasks button, selected, to go back to its project's board
  - the pane index for the view
- Test: `desktop/test/super_tab_tasks_header_test.dart`

- [ ] Write failing tests:
  - the project header lists Chat, Terminals, Tasks and Members in that order
  - Tasks shows a red badge "3" for three Needs-you tasks, and none at 0
  - Tasks opens the Board, as Board is the default
  - a card click opens the task's chat with Tasks selected, and Tasks brings the board back
  - Chat closes the view
- [ ] Run: FAIL. Implement. Run: PASS. Commit.

## Task 10: Screenshots and guards

**Files:**

- Create: `desktop/test/super_tab_tasks_shots_test.dart` (Board and List, light and dark, with a Needs-you card and the
  badge)

- [ ] Write the shots test, modelled on `super_tab_backlog_shots_test.dart`, and run it on the Mac.
- [ ] Run Desktop's guards: `python3 scripts/check-ui-style.py`, `flutter test test/laid_out_list_test.dart`, and
  `flutter analyze`.
- [ ] Run the backend unit suite (`cd backend && npm test`) and the CLI spec. Post red/green evidence in a PR comment.
  Mark the PR ready.
