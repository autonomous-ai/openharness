# Quiet Swarm 3/6: the chat Implementation Plan

> **Way of working:** by this project's instructions: each failing test committed before its code, then one independent review of the pull request.

**Goal:** The project chat shows one-line tasks and proposals, no stacked cards and no PM notices, under a `# name ▾` header with the project menu.

**Architecture:** One new row widget draws a task's message and another a proposal, chosen in the chat's message builder. The Status card becomes a dialog from the menu, and the catch-up and shipped cards leave the chat. The header and its menu change only for a project's chat; every other conversation stays as it is.

**Tech Stack:** Flutter (Dart), widget tests with a memory store and a fake sign-in, the browser build for screenshots.

**Spec:** `docs/plans/2026-11-02-quiet-swarm-design.md`, screens 1, 2, 3, 9, 9b, 11, 12.

## Global Constraints

- PR body starts with: Requested by dee@autonomous.ai through Harness.
- Follow `desktop/design/desktop-design-system.md`: no new colors, icons or controls; one line per row; fewer words.
- Anything the design doesn't draw stays as it is. No on/off switch.
- Desktop tests use a memory store and a fake sign-in, and never sign this Mac out of the real CLI.
- Stay inside `view.dart`'s chat body and header, the three cards, `project_options.dart` and their tests. Other Engineers build the other parts in parallel.
- Dee's look at the screenshots is the merge gate. Reviewer: Quinn 2.

## Contract with part 2/6

The server's task message has source kind `task-line`, with `taskId`, `state` (`planned`, `working`, `waiting`, `review`, `shipped`) and `answerFor`. Its text is the task's name. Until it lands, today's live cards stay; a message without that source draws as it does now.

## Review Focus

- A task the reader may not read: its line must not open anything or show more than the message itself.
- A person who isn't the one asked sees `working`-style wording, never Answer, on a task waiting on someone else.
- A hidden notice that something replies to or that holds the New line: the line and the quote must not point at a row that isn't there.
- The project menu for a viewer and for a non-owner: each item only if they may use it, as today's menu has it.
- A narrow window: the header and the task line must fit with no overflow.

---

### Task 1: One-line tasks and proposals

**Files:**
- Create: `desktop/lib/super_tabs/task_line.dart`
- Modify: `desktop/lib/super_tabs/view.dart`, `desktop/lib/super_tabs/model.dart`
- Test: `desktop/test/super_tab_task_line_test.dart`

**Interfaces:**
- Produces: `SuperTabTaskLine(message, readerId, onOpen)` and `SuperTabProposalLine(message, owner, onOpen)`; `SuperTabMessage.taskLine`.

- [x] **Step 1: Write the failing tests:** each state draws its mark and word on one row; `waiting` says Answer only to the person asked; clicking opens the task; a proposal is one row that opens.
- [x] **Step 2: Run to verify they fail.** Run: `flutter test test/super_tab_task_line_test.dart`. Expected: FAIL.
- [x] **Step 3: Implement** both rows, and use them in the chat's message builder.
- [x] **Step 4: Run to verify they pass.**
- [x] **Step 5: Commit.**

### Task 2: Nothing stacked over the chat

**Files:**
- Modify: `desktop/lib/super_tabs/view.dart`; `project_status_card.dart`, `catch_up_card.dart`, `ship_row.dart`
- Test: `desktop/test/super_tab_quiet_chat_test.dart`

- [x] **Step 1: Write the failing tests:** no Status card, While you were away or Shipped card in a project's chat; the New line stays; `work-stalled`, `work-lost`, `idle` and the other PM notices never show.
- [x] **Step 2: Run to verify they fail.**
- [x] **Step 3: Implement.**
- [x] **Step 4: Run to verify they pass.**
- [x] **Step 5: Commit.**

### Task 3: The header and project menu

**Files:**
- Modify: `desktop/lib/super_tabs/view.dart`, `desktop/lib/super_tabs/project_options.dart`
- Test: `desktop/test/super_tab_project_menu_test.dart`

- [x] **Step 1: Write the failing tests:** a project's header is `# name ▾`, Members and the terminal; the menu holds Status, Pull requests, Instructions, Sharing, Notifications, then Project settings…; Status opens the report with its time; Project settings… holds rename, switch PM, archived and delete; another conversation's header is unchanged.
- [x] **Step 2: Run to verify they fail.**
- [x] **Step 3: Implement.**
- [x] **Step 4: Run to verify they pass.**
- [x] **Step 5: Commit, then push.**

### Task 4: Screenshots

- [x] **Step 1:** Render screens 1, 2, 3, 9 and 9b from a browser build on made-up data, and put them in the PR.

## Design

- **Growth, concurrency, read cost, scale, migration:** N/A because this only changes how Desktop draws what it already reads.
- **Compatibility:** an older backend sends no `task-line` message, and today's cards stay for it.
- **Audience:** the server decides what a reader gets; a line opens only a conversation the reader's Swarm read includes.
- **Failure:** a task not in the read keeps its line and opens nothing.
- **Platforms:** Desktop and the web build, narrow windows included.
