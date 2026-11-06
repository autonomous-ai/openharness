# The board's cards as Trello's, columns that fill the pane: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** The Desktop Board feels like Trello, which anh Dee finds delightful: a card shows the agent's avatar with the
requester's small beside it, colour chips for its state and a small row for its pull request, checks and comments; the columns
share the pane's full width with a sensible minimum, and when they do not fit a trackpad swipe, shift and the mouse wheel and a
visible scrollbar each reach every column and back (task #3869, requested by Dee through Harness, with Scholes's report that the
other columns cannot be reached).

**Architecture:** Delta to the board that exists (`task_card.dart`, `tasks_view.dart`), no other redesign.
- Card face (a tile on the Board): lane chip, title, one quiet line (priority and state words), the state chips, and a footer
  row: PR, checks done and comments on the left; the agent's avatar (`SuperTabAvatar.agent`, the app's one generated avatar,
  stable from its id) at the right with the requester's small beside it. This replaces the "dee · Agent" name line.
- State chips come from what the board already knows of a task (`superTabTaskPlaceOf`): green "Ready to merge" (done, checks
  green), red "CI failing" (the red state #3827 records), yellow "Needs you"; the lane chip stays. The chips' words leave the
  quiet line so nothing is said twice.
- Columns: each takes an equal share of the pane (`LayoutBuilder`), never below a minimum of 240; below it the row scrolls
  sideways with a permanent scrollbar. One spacing scale (`grid.AppDesktop`) for every padding, gap and heading.
- Scrolling: Flutter reads a trackpad's horizontal swipe and shift plus the mouse wheel on a horizontal scrollable already; the
  board gets the scrollbar, whose thumb a mouse drags, so each of the three reaches every column on macOS and Windows.

**Tech Stack:** Dart and Flutter widget tests with the fake Swarm of `test/support/super_tab_fixture.dart`.

**Spec:** Task #3869's brief and its scroll addition; anh Dee's option 2 (his Buddy's); #3787's Trello look; #3812's six columns
and #3827's check state, which this branch is stacked on.

## Mockup (for anh Dee; his look follows after merge)

```
 Proposal 1     Next up 3      Working 7      Done 2         Merged 2       Shipped 3      <- six equal columns, full pane
+------------+ +------------+ +------------+ +------------+ +------------+ +------------+
|[Desktop]   | |[CLI]       | |[Desktop]   | |[Backend]   | |[Desktop]   | |            |
| Chat limits| | Remove old | | Tasks board| | Waiting on | | Dial recap | |            |
| out in a.. | | preview .. | | six columns| | the merge  | | on main    | |            |
| P2 12 min  | | P2         | | P1 in revw | | P2 1 h 30m | | P2 next .. | |            |
| [Ready to  | |            | | [CI failing| | [Ready to  | |            | |            |
|  merge]    | |            | |  ][Needs   | |  merge]    | |            | |            |
| PR#3480 3/5| | PR#3470 0/2| |  you]      | | PR#3501 5/5| | PR#3498 5/5| |            |
| 4      (A)d| |  1     (A)d| | PR#3502 2/4| | 2      (A)d| |  0     (A)d| |            |
+------------+ +------------+ +------------+ +------------+ +------------+ +------------+
 (A) the agent's generated avatar, d the requester's, smaller, beside it.
 Below 6 x 240 plus gaps the row scrolls sideways under a visible scrollbar.
```

## Global Constraints

- PR body first line: "Requested by dee through Harness." Stacked on #3827 (and #3812): merge them first; #3863 and #3864 also
  touch the board page, so main is merged once when either lands.
- Owns `desktop/lib/super_tabs/` and `desktop/test/`. Desktop only, the Board's widgets only.
- Harness design language (`scripts/check-ui-style.py`): tokens, never frozen colours, light and dark. Trello's look and feel,
  not its logo, name or images. docs/windows-rules.md: no process, no window.
- Desktop tests use a memory store and a fake sign-in. No fixed sleeps.

## Design

N/A because nothing is stored, synced or exposed: the same snapshot is drawn differently. The comment count is the task's
message counter the snapshot already holds (`lastMessageSequence`), so no read is added. platforms: Desktop and web, one Dart
path; the scrollbar and the wheel and trackpad paths are tested for macOS and Windows behaviour.

## Review Focus

- Every card, chip, row and heading lines up on one grid; the avatars sit bottom right on every tile.
- No empty band at the right of the pane at 1280, 1920 and 2560; below the minimum, every column is reachable by trackpad,
  shift plus wheel and the scrollbar, and back.
- The chips say each state once.

## Task 1: columns fill the pane, and every column is reachable

**Files:** `desktop/lib/super_tabs/tasks_view.dart`, `desktop/test/super_tab_tasks_view_test.dart`.

- [ ] Failing tests: at 1920 and 2560 the six columns are equal width and the last ends at the pane's inner edge (no empty
  band); at 1280 they keep the minimum and the board scrolls; a scrollbar shows when they do not fit; a trackpad swipe, shift plus
  the wheel and a drag of the scrollbar's thumb each bring the last column into view and back.
- [ ] `LayoutBuilder` widths, a `Scrollbar` with a permanent thumb on the board's controller. Commit.

## Task 2: the card face

**Files:** `desktop/lib/super_tabs/task_card.dart`, `tasks_view.dart`, tests.

- [ ] Failing tests: a tile shows the agent's avatar and the requester's small beside it at the bottom right and no name line; the
  chips (Ready to merge, CI failing, Needs you) and the lane chip; the footer's PR, checks done (3/5) and comment count; a
  list row and a Member card keep their line.
- [ ] Footer, chips and avatars on `SuperTabTaskCard`; the board passes the agent, requester, chips and counts. Commit.

## Task 3: one grid, screenshots

- [ ] Light and dark screenshots of the board at 1280, 1920 and 2560, written when the capture directory is set; spacing from the
  scale only (`check-ui-style.py` clean). Red/green evidence and the PNGs in the pull request and the task thread.

## Review correction: comment counts

Hazel found that `lastMessageSequence` begins at the tab's sequence baseline, so it is not a count of comments.
The snapshot provides no real comment count. Omit that fact from the footer and its semantics; keep PR/checks/avatars.
The reviewer accepted this bounded fix, and the PM has been informed of the omitted count.

- [x] Commit a regression test with `lastMessageSequence: 241397`; watch it fail on the original footer.
- [x] Remove the invented count and the unused comment fact from the card.
- [x] Run affected widget tests (128 passed) and regenerate light/dark Board screenshots at all three widths (8 capture tests passed).

Six columns retain a 240 px minimum and scroll below about 1530 px of pane width, including a 1280 px window.
