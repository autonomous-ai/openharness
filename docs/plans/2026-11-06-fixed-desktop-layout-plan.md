# Fixed Desktop layout implementation plan

> Implement task by task in this Engineer session, test first, with one independent PR review.

**Goal:** Keep projects on the left and chat on the right; show the selected project's Board in the middle, otherwise blank.

**Architecture:** Remove the side-pane visibility preferences and their controls from `SuperTabView`. Desktop's Board layout reserves both side panes independently of project selection. Reuse the existing pane sizing, Board, conversation and navigation widgets.

**Tech Stack:** Dart, Flutter, flutter_test; no new dependencies.

**Spec:** Harness task #3863: Dee's fixed projects / Board / chat layout, replacing #3846. No other layout change. Both appearances; memory stores and fake sign-in in tests.

Dee's follow-up: the right chat is the main interface, approximately one-third of the window with a 420 px minimum. Smaller windows give space to chat before the Board. Task #3869 owns sideways Board scrolling. Capture light/dark at 1280, 1920 and 2560 px.

## Global Constraints

- No hide/show controls or remembered hidden state for either side pane.
- An update restores panes hidden in Desktop 1.3.83.
- No project selected: blank middle, with no placeholder content.
- Keep the project's Chat tab accessible, and task chat / return-to-Buddy navigation working.
- Keep existing Manage, Devices, terminal and web navigation intact.
- Use existing theme and sizing tokens; read `docs/windows-rules.md`.
- Scope: Desktop macOS, Linux and Windows; no backend or phone changes.

## Design

- Growth, concurrency, read cost, scale: no added data; remove two local preference reads and all visibility writes. Pane width preferences remain bounded to one existing record.
- Compatibility: old visibility values are ignored. No server contract changes or backend deployment required.
- Migration / rollback: no destructive migration; existing obsolete local keys can remain unread. Reverting restores old behavior.
- Audience / identity: existing server access and account identity are unchanged.
- Failure: existing loading and error states stay in the chat; an absent project cannot remove the side panes.
- Platforms: shared Desktop Flutter view on macOS, Linux, Windows; web keeps its current layout.

## Review Focus

1. Old hidden preferences must not conceal either pane after update or remount.
2. No project selected (including a Swarm with no projects) must leave the middle truly blank.
3. Selecting a project, opening a task and returning to Buddy must preserve the Board and both side panes.
4. Desktop's minimum 880-point window must keep both panes visible; existing web compact behavior must remain unchanged.
5. A project removed while open must not leave stale Board content in the middle.

## Task 1: Fixed panes and empty middle

**Files:**
- Modify: `desktop/lib/super_tabs/view.dart`
- Modify: `desktop/lib/super_tabs/tasks_view.dart` (wrap the toolbar only when both panes leave it too narrow).
- Modify / test: `desktop/test/super_tab_board_layout_test.dart`
- Test: existing `super_tab_pane_layout_test.dart`, `super_tab_tasks_view_test.dart`, `super_tab_navigation_test.dart`, `super_tab_sidebar_test.dart`, `super_tab_workspace_test.dart`.

**Interfaces:**
- Consumes `SuperTabView(board: true)`, `SuperTabPaneLayout`, fake `ConversationServer` and `MemoryKeyValueStore`.
- Produces the same public view interface; `paneStore` supplies pane sizing only. No visibility persistence remains.

- [x] Replace the old hide/show regression with tests seeded with both old hidden preferences; assert visible project rows and right chat, no hide/show controls, including after remount.
- [x] Add blank-center tests with a Buddy selected and with no projects; assert no center text, editor or controls. Select a project and assert the Board appears in the center, then remove it and assert blank again.
- [x] Cover the minimum Desktop window and light/dark screenshot capture using synthetic state. Keep existing task / Buddy navigation tests and update the project Chat test to keep the Board beside its chat.
- [x] Commit tests first; run the layout file and record behavioral failures on the unchanged implementation. Measure the same Board divider-drag workload before and after.
- [x] Remove visibility flags, reads, writes and buttons. Reserve side panes for the Desktop Board workspace at supported window widths, and leave the center blank without an open project. Keep other navigation surfaces intact.
- [x] Run the layout regression, named affected tests, changed-file analysis, icon and style audits. Capture and inspect both appearances, with and without a project. Record evidence and platform limitations in the PR.
- [ ] Commit implementation, push, mark ready and hand the stable revision to the Integrator for independent review and test. Full Desktop suite evidence comes from automatic PR CI.

## Task 2: Comfortable chat width (Dee's follow-up)

**Files:** `desktop/lib/super_tabs/view.dart`, `desktop/lib/super_tabs/pane_layout.dart`, `desktop/test/super_tab_board_layout_test.dart`.

**Interfaces:** Keep the existing resizable layout and stored widths. Add a `rightMinimum` size to `SuperTabPaneLayout` for the Board chat; other callers retain their current minimum. Desktop Board chat defaults to one-third of available width, at least 420 px. The center yields space before either side's minimum.

- [ ] Commit tests asserting chat widths 426.67 / 640 / 853.33 at windows 1280 / 1920 / 2560, in both appearances, and capture each. At 880 px and after restoring an old 280 px width, assert at least 420 px of chat and a visible Board.
- [ ] Watch these fail before adding the width rule; record the red revision.
- [ ] Implement the size contract and retain existing user resizing above the minimum. Preserve non-Board navigation's responsive behavior.
- [ ] Run layout and pane sizing regressions plus the changed Tasks toolbar tests, analyze the changed Dart, and inspect six screenshots. Record the rendering comparison and remaining platform limits.
