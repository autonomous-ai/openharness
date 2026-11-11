# The board's Shipped column means released, not just merged (task #3452) Plan

> Retrospective: written after the code, at the Tester's request on the pull request. The red logic tests were
> committed before the code (`1ffd33fe1`, `6e0138345`); the board and Backlog widget tests, the screenshots and this
> plan came after it. Worked by the Engineer, test first where the history shows it.

**Goal:** A task shows as Shipped only once a verified release carries it. A task that merged and is still on the
server's release list waits in Waiting as `merged, releasing (parts)` on the Tasks board, and in a Releasing group in
Manage ▸ Backlog. Work merged before the server recorded releases, and any task from an older server, stays Shipped.

**Architecture:** The server (task #3405, with Shipper's follow-up) sends `releasing` on a task: the parts
`backend`, `cli`, `desktop`, `web`, in that order, present from the merge until the release and shrinking as each
release lands, and an empty list for a few minutes after the merge while it reads the pull request's files. Absent
before a merge, once released, and from a server that does not say. `SuperTabConversation.releasing` is that list, or
null. `superTabTaskReleasing` (presence) is the one test; `superTabTaskShipped` is "not releasing, and merged or Done
with nothing to merge", so every reader (board column, Backlog group, card mark and spoken label, agent line) follows
it. `superTabTaskPlaceOf` puts a releasing task in Waiting whatever else it is (it is often closed already); the
Backlog lists it under Releasing. The card's caption takes as many lines as it needs for a releasing task. The phone's
model reads the field because `mobile/test/swarm/desktop_parity_test.dart` requires it to read every field the
desktop's reads; it draws nothing from it.

**Tech Stack:** Dart, Flutter widget tests (`flutter test`), no new dependency.

**Spec:** task #3452 brief; River's messages of 11-05 (mockup approved, the `releasing` contract).

## Global Constraints

- Owned files: `desktop/lib/super_tabs/`, `desktop/test/`, this plan. One line in `mobile/lib/swarm/model.dart`
  (parse only) is outside them, because the parity test fails CI without it.
- Desktop reads one more field of a read it already makes. No request, poll or timer is added.
- Visible text follows the naming system: part names are `Desktop`, `CLI`, `backend`, `Web`.

## Review Focus

- A present list, even an empty one, is the only thing that moves a task to Waiting: no merge check, no guess.
- Nothing else calls a task shipped while it is releasing (`_activity`, the agent line, the card's spoken label).
- The caption never cuts the parts off.

## Design

- growth: no stored data. The server's list is bounded on its side (an entry leaves on release, after 14 days, or past
  100); Desktop holds the field only on the conversations it already holds.
- concurrency: N/A because Desktop only reads. A list that changes between two reads moves the card on the next read.
- read cost: no new read. One list per task rides the read that already carries the task; measured below.
- scale: 10x is 1,000 tasks on the board; the server's cap keeps releasing cards at 100 or fewer. The measure that
  warns first is the board's first build time.
- compatibility: an older server sends no list, so every merged task is Shipped as before. An older Desktop ignores
  the field. The phone's model parses it and draws nothing.
- migration + rollback: none. Reverting the change puts releasing tasks back in Shipped.
- audience: the server decides who reads a task; Desktop shows only the tasks the read returned.
- identity: N/A because nothing acts as anyone.
- failure: a read that fails keeps the last list; a list that is missing reads as released (Shipped), never as an error.
- platforms: one Dart UI on macOS, Linux and Windows; no process starts. The text and layout are the same on each.

## Measurements (ENGINEERING.md §4)

Same workload before and after: a project of 100 and of 1,000 tasks (a quarter working, three quarters merged, up to
100 of them releasing, as the server's cap allows). Flutter test (headless, macOS, debug), three runs each; medians
of the runs. The change touches the grouping logic and the card's caption layout, not a query or a poll.

| | Before (`main`) | After |
| --- | --- | --- |
| Board grouping, 1,000 tasks | 5.1 ms | 4.9 ms |
| Board grouping, 100 tasks | 0.71 ms | 0.74 ms |
| Backlog grouping, 1,000 tasks | 0.064 ms | 0.062 ms |
| Board first build, 1,000 tasks | 132 ms | 149 ms |
| Board first build, 100 tasks | 483 ms (includes the first frame's warm-up) | 494 ms |
| Backlog first build, 1,000 tasks | 44.9 ms | 42.2 ms |

Grouping cost is unchanged. The board's first build at 1,000 tasks reads about 17 ms slower in these runs, inside the
spread of the runs themselves (130 to 178 ms after, 130 to 148 ms before); with at most 100 two-line-or-longer cards
this is a one-time layout cost, not per frame. The standard asks "not slower": I cannot show that from three headless
runs, so the number is reported as measured. PRODUCT.md's targets for Desktop (at rest, with 16 terminals) are not
touched: nothing here runs at rest.

## Tasks

### Task 1: The release list decides the column (red logic tests first)

**Files:** `desktop/lib/super_tabs/model.dart`, `backlog.dart`, `task_groups.dart`, `backlog_view.dart`;
`desktop/test/super_tab_releasing_test.dart`.

**Interfaces:** `SuperTabConversation.releasing: List<String>?`; `superTabTaskReleasing(task)`;
`SuperTabBacklogGroup.releasing`.

- [x] Failing tests for the board and the Backlog: present list (empty or not), released, merged before releases,
  a closed task still releasing (`1ffd33fe1`). Code that passes them (`eee9cdd7b`).
- [x] Failing test for a Done task with no pull request cards that the server lists as releasing, then the predicate
  fix (`6e0138345`, `3194e5c32`).

### Task 2: The card shows every part

**Files:** `desktop/lib/super_tabs/task_card.dart`, `tasks_view.dart`; `desktop/test/super_tab_tasks_view_test.dart`.

- [x] Failing test: all four parts in full on a board card at normal and enlarged text (`6e0138345`), then the caption
  takes as many lines as it needs, without an ellipsis (an ellipsis with no line limit cuts to one line).
- [x] Board and Backlog widget tests, and the light and dark screenshots, written after the code (disclosed).

### Task 3: The phone reads the field

**Files:** `mobile/lib/swarm/model.dart`.

- [x] `mobile/test/swarm/desktop_parity_test.dart` failed on CI with `releasing` unread; the model now parses it.
