# Tasks pane cards and one-row agent chat header Implementation Plan

> Work this plan task by task, test first: each task's failing test is committed and watched failing before the code
> that passes it. One Engineer implements it in this session; the pull request's review step is the one independent
> review.

**Goal:** The right Tasks pane shows board-style cards, newest first with older ones loaded on scroll; a card opens its
task in the middle with its chat; every agent's chat header is one row (task #4204, anh Dee 2026-11-07 06:20 VN).

**Architecture:** The feed row model (`personal_tasks.dart`) reads the extra fields of the backend feed (#4203) and
keeps an older-page cursor. A new card widget draws one row of the pane. The middle shows a task through the existing
agent-chat path in `view.dart`, under a new task header. A new `chat/agent_chat_header.dart` replaces the middle
chat's name row and the Buddy bar's text line.

**Tech Stack:** Flutter (Desktop), `flutter_test` widget tests, the Harness design tokens (`AppDesktop`, `DesktopChrome`,
`AppPalette`).

**Spec:** the task brief of #4204 and anh Dee's message of 2026-11-07 06:14 VN (proposal #4202), quoted in the task.

## Global Constraints

- Change the delta to today's UI only; builds on #4191 (PR #3461), which merges first.
- Ships in Desktop 1.3.88 with #4192 and #4196; those also touch `view.dart`, so its changes stay small wiring.
- Card: project as a coloured tag, status mark top right, title up to three lines, two avatars and no names bottom left
  (who asked, then the agent); no priority, no check counts. In Review a waiting card shows Approve and Reject bottom
  right, with no agent switch.
- Click: the task opens in the middle (not the board): full title, status, who asked, agent and PR, then its chat; the
  card stays selected; the board stays under Projects.
- Header: one row: avatar and name left; engine picker, model picker and the menu right. No machine name, no
  "reads all your projects", no "only you can read this chat".
- Light and dark pictures; widget tests. Design tokens only (`scripts/check-ui-style.py`).
- Older Desktop rows stay readable: every new feed field is optional.

## Review Focus

- A row without `requester` (older backend or a proposal nobody owns): the card shows the agent avatar alone, no gap.
- A feed without `olderCursor` (backend before #4203): no "load older" request is ever sent.
- Scrolling to the end twice quickly sends one older-page read, not two.
- A non-Buddy agent: the server offers no engine or model switch for it, so its engine and model show as plain labels in
  the same place; a Buddy keeps its working pickers.
- A task the reader opens from a card and then archives: the middle keeps the chat until another is chosen.

---

### Task 1: Feed rows carry who asked, the PR and an older-page cursor

**Files:**
- Modify: `desktop/lib/super_tabs/tasks/personal_tasks.dart`
- Test: `desktop/test/super_tab_personal_tasks_test.dart`

**Interfaces:**
- Produces: `SuperTabPersonalTask.requester` (`Map<String, dynamic>`, empty when absent), `requesterId` (`String?`),
  `pullRequestUrl` (`String?`); `SuperTabPersonalTasks.olderCursor` (`String?`), `bool applyOlder(Object? page)` which
  adds rows of a `{upserts, olderCursor}` page without dropping newer ones.

- [ ] Step 1: tests `rows read who asked and the PR` (requester id/name, pullRequestUrl from a row; absent → empty map
      and null) and `an older page adds rows and moves the cursor` (first load `olderCursor: 'c1'`, `applyOlder` with two
      older rows and `olderCursor: null` → four rows newest first, `olderCursor` null; a stale version is ignored).
- [ ] Step 2: run `flutter test test/super_tab_personal_tasks_test.dart`; expect FAIL (no such getters).
- [ ] Step 3: add the getters; `apply` keeps `olderCursor` from a reset load; `applyOlder` reuses the version check.
- [ ] Step 4: run the same test; expect PASS. Commit test, then code.

### Task 2: Older tasks load on scroll

**Files:**
- Modify: `desktop/lib/super_tabs/controller.dart` (one method), `desktop/lib/super_tabs/tasks/personal_tasks_pane.dart`
- Test: `desktop/test/super_tab_personal_tasks_pane_test.dart`

**Interfaces:**
- Consumes: Task 1's `olderCursor`, `applyOlder`.
- Produces: `Future<void> SuperTabController.loadOlderPersonalTasks()`: one read in flight at most;
  `GET $_path/personal-tasks?before=<olderCursor>` (the read Feedfix names in #4203; this path changes to match it).

- [ ] Step 1: test `scrolling to the end reads the older page once`: a feed of 30 rows with `olderCursor: 'c1'`; drag to
      the end twice → exactly one GET with `before=c1`; its rows appear below. Test `no cursor, no read`.
- [ ] Step 2: run; expect FAIL.
- [ ] Step 3: implement; the pane calls it when the list is within one screen of its end.
- [ ] Step 4: run; expect PASS. Commit test, then code.

### Task 3: The card

**Files:**
- Create: `desktop/lib/super_tabs/tasks/personal_task_card.dart`
- Modify: `desktop/lib/super_tabs/tasks/personal_tasks_pane.dart` (rows use the card; the expanded agent switch goes)
- Test: `desktop/test/super_tab_personal_tasks_pane_test.dart`

**Interfaces:**
- Produces: `SuperTabPersonalTaskCard({task, project, projectColor, requester, agent, selected, onOpen, onApprove,
  onReject})`; `Color superTabProjectColor(String projectId)`, a stable pick from `AppPalette.avatarPalette`.

- [ ] Step 1: tests: `card shows tag, three-line title, mark top right, two avatars and no names` (finds the project
      text, `Text.maxLines == 3`, the mark's top-right lies right of and above the title, two `SuperTabAvatar`s left of
      centre, no agent or requester name text, no priority or check text); `a waiting card shows Approve and Reject and
      no agent switch` (buttons send `task.approve` / the reject dialog; no `task-agent-*` field); `a card opens its
      task` (tap → `onOpenTask(id)`, also for a waiting one).
- [ ] Step 2: run; expect FAIL.
- [ ] Step 3: build the card with the board tile's border, radius and padding (`SuperTabTaskCard.tilePadding`), the tag
      in `superTabProjectColor` with white text like a lane label.
- [ ] Step 4: run; expect PASS. Commit test, then code.

### Task 4: A card opens the task in the middle

**Files:**
- Create: `desktop/lib/super_tabs/tasks/task_header.dart`
- Modify: `desktop/lib/super_tabs/view.dart` (`onOpenTask` and `_middleChat` wiring only)
- Test: `desktop/test/super_tab_personal_tasks_middle_test.dart`

**Interfaces:**
- Consumes: Task 1's row getters; `SuperTabPersonalTasksPane.selectedId` (new, `String?`).
- Produces: `SuperTabTaskHeader({task, controller})`: full title, status mark and word, who asked, agent, PR link.

- [ ] Step 1: test `a card opens the task with its header and chat in the middle`: full view with a feed row; tap the
      card → `super-middle-chat` holds `super-task-header` with the full title, requester and agent names and the PR
      link; no board is shown; the card is selected.
- [ ] Step 2: run; expect FAIL.
- [ ] Step 3: `onOpenTask` loads the group and opens it through `_openAgentChat`; `_middleChat` shows the task header
      for a task; the pane gets `selectedId: c.selectedId`.
- [ ] Step 4: run; expect PASS. Commit test, then code.

### Task 5: One-row agent chat header

**Files:**
- Create: `desktop/lib/super_tabs/chat/agent_chat_header.dart`
- Modify: `desktop/lib/super_tabs/view.dart` (`_middleChat` uses it), `desktop/lib/super_tabs/buddies.dart` (the bar's
  text line goes), `desktop/lib/super_tabs/buddy_model.dart` (pickers only, no trailing text)
- Test: `desktop/test/super_tab_agent_chat_header_test.dart`

**Interfaces:**
- Produces: `SuperTabAgentChatHeader({controller, group, agent, menu})`: avatar and name left; for the reader's own
  Buddy `BuddyEnginePicker` and the model picker, else the engine and model as labels; `menu` (the existing ⋮) right.

- [ ] Step 1: tests: `Buddy header is one row with pickers and menu` (all children share one baseline row; finds
      `super-buddy-engine`, `super-buddy-model`, `super-group-options`; finds no machine name, no "reads all your
      projects", no "only you can read this chat"); `member agent header shows engine and model as labels`.
- [ ] Step 2: run; expect FAIL.
- [ ] Step 3: implement and wire; the Buddy bar keeps its limit and Start again rows.
- [ ] Step 4: run the new test and `super_tab_buddies_test.dart`; expect PASS. Commit test, then code.

### Task 6: Pictures

**Files:**
- Modify: `desktop/test/super_tab_personal_tasks_shots_test.dart`

- [ ] Step 1: capture light and dark pictures of the pane (0, 2, many, one waiting in Review), the middle task view and
      the header; attach them to the PR.
