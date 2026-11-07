# Phone and web get the Board and Buddies: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** The phone shows the project's Board (six columns, cards, the card's chat) the way Desktop does, and a project
opens on it with its chat one tap away (task #3821, requested by Dee through Harness; Phase 2, step 3 of
docs/plans/2026-11-06-buddy-board-final-spec.md). This pull request is the phone's Board, built on what the server sends
today. What waits on backend work that is not on `main` is listed under "Not in this pull request", for the PM to split.

**Architecture:** One placement function for the phone, `swarmBoardPlaceOf` in `mobile/lib/swarm/swarm_board.dart`, puts every
task in exactly one of the six columns Proposal, Next up, Working, Done, Merged, Shipped, by the same rules as Desktop's
`superTabTaskPlaceOf` (task #3812, the Task Board table of the spec): Waiting folds into Working with a mark, a task set done
and waiting for its merge is Done, a merged task still releasing is Merged, a released one is Shipped for seven days.
`swarm_board_page.dart` draws it for a phone: the six columns are a scrollable tab strip with counts over one page per column,
a card is a raised rounded tile with a thin lane strip, the title first and one quiet line (priority, who, pull request),
and a "Needs you" bar sits on top from the same needs the Tasks tab lists today (`swarmProjectTasks().waiting`). A tap on a
card opens the task's own conversation, which is the card's one flat chat. The project page's tabs become Board then Chat
(`SwarmProjectTab.current`), so a project opens on its Board and the chat with everyone is unchanged one tap away.
The Proposal column reads the open Buddy proposals the server already answers (`GET /api/super-tabs/:tabId/proposals`), and
Merged and Shipped need the project's closed conversations, which a first load does not hold: the Board reads them with the
phone's own older-work read (`loadDormant`), back to the Shipped window, as Desktop's `readClosedShipped` does. Both reads
keep Desktop's bounds (a proposals read only when the project chat moved and at most once a minute; at most 40 pages).

**Tech Stack:** Dart, Flutter widget and unit tests with the fake Swarm of the mobile `test/swarm` fixtures; light and dark
screenshots from the shots tests and the iOS simulator.

**Spec:** docs/plans/2026-11-06-buddy-board-final-spec.md, "The Task Board", "Screens", "Rollout", "Design"; task #3821's brief.

## Global Constraints

- PR body first line: "Requested by dee through Harness."
- Phone only in this pull request: `mobile/lib/` and `mobile/test/`. No backend change: every right stays enforced by the
  server, and the phone sends no command it does not send today.
- A project not switched behaves as today: its chat, the PM's replies and every command are unchanged. The server has no
  switch yet, so every project is "not switched" and the Board only reads.
- Light and dark screenshots of the Board in the iOS simulator, posted in the task for Dee. Never install on a phone; always
  name the simulator with `-d`.
- Tests: no fixed sleeps. Test names and comments in English.

## Mockup (phone, this pull request)

```
+--------------------------------+   +--------------------------------+
| <  harness                  .. |   | <  harness                  .. |
|  Board          Chat           |   |  Board          Chat           |
|  ------                        |   |  ------                        |
| Needs you  2                 > |   | Needs you  2                 > |
| Prop 3|Next 4|Work 5|Done 1|... |   | Prop 3|Next 4|Work 5|Done 1|... |
|        ======                  |   |  ====                          |
| +----------------------------+ |   | +----------------------------+ |
| |# Phone gets the Board      | |   | |# CLI card port             | |
| |  P1 . Mobile . PR #3390    | |   | |  Tuan proposed . via Code  | |
| |  In review                 | |   | +----------------------------+ |
| +----------------------------+ |   |   Proposal column              |
| +----------------------------+ |   |                                |
| |# Backend many Buddies      | |   |                                |
| |  P1 . Builder . needs you  | |   |                                |
| +----------------------------+ |   |                                |
|   Working column (swipe >)     |   |                                |
+--------------------------------+   +--------------------------------+
```

The six columns are tabs on the phone, with one page each; a tap on a card opens its chat as a page, with a back arrow to
the Board.

## Design

- growth: N/A because nothing is stored; the Board is the same snapshot placed in columns. Shipped keeps its seven-day window
  and each column lists at most the tasks the read already holds.
- concurrency: N/A because the phone writes nothing new.
- read cost: no new poll. The Board draws from the Swarm read the phone already holds and its pushes; the Proposal column
  reads the proposals once when the Board opens and again when the read says a project changed.
- scale: 10x tasks means 10x cards; a column page is a lazy list, so only the cards on screen are built.
- compatibility: no contract change. A server that sends no `released` record shows the pull request number as Desktop does;
  a server that does not answer `/proposals` leaves the Proposal column empty with its error shown, never a wrong count.
- migration and rollback: none to migrate; rolling back removes the Board tab and the project opens on its chat as before.
- audience: the server decides what the phone reads; a card the reader may not read is not in the read.
- identity: unchanged; the phone acts as its person.
- failure: a Proposal read that fails says so in the column and logs the name once; it does not hide the other columns.
- platforms: iOS and Android phone. The web build is the Desktop app and gets the Board with Desktop (see below).

## Review Focus

- Every task lands in exactly one column, and the Board and the Tasks tab's waiting count agree.
- Done is never Shipped without a merge; Shipped keeps its seven-day window; a task waiting on the reader shows the mark.
- A project opens on the Board and the chat tab behaves as before (send, reply, unread dot, tags).

## Not in this pull request (waits on work that is not on `main`; for the PM to split into tasks)

- **Buddies as home:** the Buddy list with + New Buddy, the default Buddy and the Buddy cap wait on the many-Buddies backend
  (draft #3383). Today a person has one Buddy per Swarm; the phone keeps showing it as it does.
- **A card's decision, question with default and time, and propose from the Board:** wait on proposals as their own records
  and the PM's decision written on the card (backend Phase 2, item 1).
- **Priority by role and pause or resume:** the server has no pause command and lets any person set any priority today
  (spec, Phase 2, item 1); the phone must not decide rights, so the controls come after the server enforces them.
- **The per-project switch:** a switched project opening read-only for old apps needs the server's switch to read.
- **Web:** the web app is the Desktop Flutter app built for the browser (`desktop/scripts/build-web-release.sh`), so the Board
  and Buddies arrive on web with Desktop's. What is left for web is the narrow-screen layout and the Safari iPhone check; it
  lives in `desktop/lib`, which this task does not own. The PM names who owns it.

## Task 1: the six columns and where a task is placed

**Files:** `mobile/lib/swarm/swarm_board.dart`, `mobile/lib/swarm/model.dart` (read `released`),
`mobile/test/swarm/swarm_board_test.dart`.

**Interfaces:** `enum SwarmBoardColumn { proposal, nextUp, working, done, merged, shipped }` with `label`;
`typedef SwarmBoardPlace = ({SwarmBoardColumn column, bool needsYou, String? state})`;
`SwarmBoardPlace? swarmBoardPlaceOf(SuperTabConversation task, {required DateTime now, required bool waitsOnReader})`.

- [ ] Failing test: the columns read Proposal, Next up, Working, Done, Merged, Shipped. A task waiting on review, a person, a
  block, a machine or quiet is in Working with its caption; one set done with a pull request still to merge is in Done; one
  merged and still releasing is in Merged with its parts; one released inside seven days is in Shipped with its version, past
  seven days it is not listed; a done task with no code stays in Done. Each case lands in exactly one column. Watch it fail.
  Commit.
- [ ] Add the enum and the function with Desktop's rules; read `released` (`{at, tags}`) in `SuperTabConversation`. Commit.

## Task 2: the board of one project

**Files:** `mobile/lib/swarm/swarm_board.dart`, `mobile/test/swarm/swarm_board_test.dart`.

**Interfaces:** `SwarmBoard swarmBoardOf(SwarmInbox inbox, SwarmReader reader, String projectId, DateTime now)` returning the
tasks per column, newest first in Done, Merged and Shipped and in priority order in Next up, with the open proposals in
Proposal, and `needsYou` as the list `swarmProjectTasks().waiting` holds.

- [ ] Failing test: a project's read with ten tasks across the six states puts each in one column in the order above, leaves
  out another project's tasks, a private chat and the person's Buddy chat, and counts what waits on the reader. Commit.
- [ ] Implement `swarmBoardOf` over `swarmProjectWork` and the proposals. Commit.

## Task 3: the Board's two reads

**Files:** `mobile/lib/swarm/swarm_reader.dart`, `mobile/test/swarm/swarm_board_reads_test.dart`.

**Interfaces:** `SwarmReader.readProposals(projectId)`, `proposalsOf(projectId)`, `proposalsFailed(projectId)`;
`SwarmReader.loadShipped(projectId, since)`, `shippedFailed(projectId)`.

- [ ] Failing test: `readProposals` asks `GET /api/super-tabs/:tabId/proposals?projectId=` and holds the parsed list; it asks
  nothing again until the project chat has moved, and then at most once a minute (one read for every move in the minute);
  a failed read keeps what was shown, is named once in the log and flagged. `loadShipped` reads the project's closed
  conversations page by page until a page's last conversation changed before the window or 40 pages, and a failed page is
  flagged and asked again on the next call. Commit.
- [ ] Implement both on the reader with Desktop's bounds; remember each page's last change in `_readDormant`. Commit.

## Task 4: the Board page

**Files:** `mobile/lib/swarm/swarm_board_page.dart`, `mobile/test/swarm/swarm_board_page_test.dart`.

- [ ] Failing widget test: the strip shows six tabs with counts; a swipe or a tap changes the column; a card shows its title,
  its quiet line and, when it waits on the reader, the mark; the "Needs you" bar shows the count and opens the needs list;
  a tap on a card opens the task's conversation page; an empty column says what it holds. Commit.
- [ ] Build the page with the shared tokens (`AppSpace`, `AppGlass`, `AppColors`), light and dark. Commit.

## Task 5: a project opens on its Board

**Files:** `mobile/lib/swarm/swarm_project_tabs.dart`, `mobile/lib/swarm/swarm_project_page.dart`,
`mobile/test/swarm/swarm_board_page_test.dart`, `mobile/test/swarm/swarm_fixture.dart`.

- [ ] Failing test: a project opens on Board with Chat as the second tab; a link, a notice or a new message to the project's
  chat (`SwarmOpenedChat`) opens the Chat tab, not the Board; the Chat tab still shows its unread dot and the Lead's tags.
  Watch it fail. Commit.
- [ ] Set `SwarmProjectTab.current` to Board then Chat under Home C's header, open a chat on the Chat tab, and update the one
  shared helper (`expectHomeCProject`) that said "no tab bar". Direction B's tabs (Buddy, Tasks, Leaderboard) and
  `SwarmProjectTasks` stay: only tests reach them today, and they go with the Buddy-home part. Commit.

## Task 6: screenshots

**Files:** `mobile/integration_test/swarm_board_shots_test.dart`.

- [ ] Simulator test for the Board in dark and light, a screenshot at each column and at the Chat tab, run with
  `flutter drive -d <simulator>` on a simulator named by id, from in-memory data only. Post the images in the task for Dee
  with a person line naming the task.
