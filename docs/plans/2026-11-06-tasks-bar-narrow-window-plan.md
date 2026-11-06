# The Board's Tasks bar in a narrow window: implementation plan

> Implemented task by task in this Engineer session, test first (each failing test committed before its code), with the pull request's one independent review.

**Goal:** In a narrow Desktop window the Board's Tasks bar never overflows, the chat pane keeps its width, and the Board scrolls sideways instead.

**Architecture:** #3425 made the side panes give way to a 540 px Board minimum. Under anh Dee's fixed layout (#3863) the chat pane keeps its width (about a third, never under 420 px) and the projects rail alone may narrow, so the pane layout gets no Board minimum. Instead, when the Board's centre is narrower than `SuperTabTasksBar.minWidth` (scaled with the text), the Board's bar and lanes are laid out at that width inside one horizontal scroll view. #3425's `FittedBox(scaleDown)` stays as the guard for a font wider than the one the minimum was measured with.

**Tech Stack:** Dart, Flutter, flutter_test; no new dependencies.

**Spec:** Harness task #4060 (Huy, 11-06; reshaped by River to anh Dee's #3863 layout rule). It builds on #3398 (one-row Tasks bar) and #3399 (#3863 fixed layout, chat pane at least 420 px) and retargets #3425 to main once #3398 merges.

## Global Constraints

- anh Dee's fixed layout wins where it differs from #3425: the chat pane keeps its width and is always visible; only the projects rail may narrow.
- The Tasks bar fits by wrapping or scaling its own controls, or the Board area scrolls sideways.
- Acceptance at 880 px and 1280 px wide: no overflow, chat width kept, sideways scroll when needed.
- Harness design language (scripts/check-ui-style.py), light and dark; docs/windows-rules.md.
- Desktop tests use a memory store and a fake sign-in.
- Owns desktop/lib/super_tabs/ and desktop/test/ only.

## Review Focus

1. Larger text (text scale 1.3): the scaled minimum still fits inside the scroll view, so nothing overflows.
2. A wide window (1920 px): no scroll view and no extra padding; the bar and lanes fill the centre as before.
3. The move error beside the title, in a narrow window: it truncates and never pushes Search out of reach.
4. Resizing from wide to narrow and back keeps the selected layout, Mine and the Search text.
5. The lanes' own sideways scroll (#3869) still works inside the narrow-window scroll: each column stays reachable.

---

### Task 1: The chat pane keeps its width; the Board no longer takes it

**Files:**
- Modify: `desktop/lib/super_tabs/pane_layout.dart` (drop #3425's `centerMin`), `desktop/lib/super_tabs/view.dart` (stop passing it)
- Test: `desktop/test/super_tab_board_layout_test.dart`

**Interfaces:**
- Produces: `SuperTabPaneLayout` without `centerMin`; the right pane's width follows #3863's rule.

- [ ] **Step 1: Write the failing test.** Replace #3425's "side panes give way" test with `at 880 and 1280 px the chat pane keeps its width beside the Board`. For each width, `show(tester, size: Size(w, 900))` and open the Board. Expect `tester.getSize(_key('super-board-chat')).width` to be at least `SuperTabPaneLayout.boardChatMinimum` (420), and at least a third of the window when that is wider.
- [ ] **Step 2: Run it.** `flutter test test/super_tab_board_layout_test.dart`: FAIL at 1280, because the chat gives way to the 540 px Board.
- [ ] **Step 3: Remove `centerMin` from `SuperTabPaneLayout` and from the Board's call in `view.dart`.**
- [ ] **Step 4: Run it.** PASS.
- [ ] **Step 5: Commit.**

### Task 2: Below its minimum, the Board scrolls sideways

**Files:**
- Modify: `desktop/lib/super_tabs/tasks_view.dart` (the Board's build)
- Test: `desktop/test/super_tab_board_layout_test.dart`, `desktop/test/super_tab_board_bar_shots_test.dart`

**Interfaces:**
- Consumes: `SuperTabTasksBar.minWidth` (540).
- Produces: key `super-tasks-narrow-scroll` on the horizontal scroll view, present only when the centre is narrower than the scaled minimum.

- [ ] **Step 1: Write the failing test.** `at 880 px the Board scrolls sideways and its Tasks bar never overflows`. Open the Board at `Size(880, 900)`. Expect `tester.takeException()` to be null. Expect `_key('super-tasks-narrow-scroll')` to be found. Then drag it left by 600 and expect `tester.getRect(_key('super-tasks-search')).right` to sit within the centre pane's right edge. At `Size(1920, 1000)`, expect `_key('super-tasks-narrow-scroll')` to be found nothing.
- [ ] **Step 2: Run it.** FAIL: a RenderFlex overflow at 880.
- [ ] **Step 3: In `tasks_view.dart`, wrap the Board's column in a `LayoutBuilder`.** When `maxWidth` is under `MediaQuery.textScalerOf(context).scale(SuperTabTasksBar.minWidth)`, lay it out at that width inside a horizontal `SingleChildScrollView` (key `super-tasks-narrow-scroll`) with a visible scrollbar. Keep the lanes' own scroll inside it.
- [ ] **Step 4: Run it, and the Review Focus 1 test at text scale 1.3.** PASS.
- [ ] **Step 5: Screenshots.** Board at 880 and 1280 px, light and dark, in `super_tab_board_bar_shots_test.dart`. Commit.
