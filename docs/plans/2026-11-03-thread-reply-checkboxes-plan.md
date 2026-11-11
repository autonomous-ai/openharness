# Thread reply options as checkboxes, Also send in full: implementation plan

> Worked by this project's instructions (Engineer role): this plan is the pull request's first commit. Then each task is
> done test first, by one Engineer, with one Review step and one Test step on the pull request. Steps use checkbox
> (`- [ ]`) syntax.

**Goal:** in the Desktop thread reply box, New session and Also send look like square checkboxes, and Also send always
reads in full ("Also post to the main chat" / "Also post to #project"). Where the full label does not fit beside New
session, Also send moves to its own line under the box.

**Architecture:** `SuperTabComposerToggle` (shared by the thread box and the main chat's New session) draws a quiet
control: a square (off) or square-check (on, accent) before its label, with no pill outline. The thread panel measures
its send row once. If New session and the full Also send fit, both stay on the row. If not, the row keeps New session,
and Also send goes on a line under the box, aligned with the box's text. The Tab order does not depend on placement:
field, New session, Also send, attach, send. An ordered focus group keeps it.

**Tech Stack:** Flutter 3.47.2 Desktop (`flutter_test` widget tests, headless screenshots in
`super_tab_reply_box_shots_test.dart`).

**Spec:** task #2353 brief (Lead, 2026-11-03), and the mockup Scholes approved in the project chat (2026-11-03 14:24 VN):

```
Default width: both fit on one row          Narrow: Also send moves to its own line under the box
│ ☐ New session   ☐ Also post to the main chat  📎 ↑ │   │ ☐ New session          📎 ↑  │
                                                         ☐ Also post to the main chat
On: ☑ New session
```

## Global Constraints

- PR body first line: "Requested by scholes@autonomous.ai through Harness."
- Out of scope: what the options do. Harness design language (desktop/design/desktop-design-system.md). The keyboard
  order does not change.
- Never show the short labels ("Also to chat", "Also to #project").
- Before Ready: a test that fails without the fix for every risk named here, red/green evidence in a PR comment, and
  screenshots at rest, on and on hover. Also before Ready, run `python3 scripts/check-ui-style.py --only desktop/lib/super_tabs`.
- Desktop tests use a memory store and a fake sign-in, never the real CLI.

## Design

N/A because the change stores, syncs and exposes no data: it changes the layout of two existing controls.

## Review Focus

1. At the thread's narrowest width with 2x text, even the line under the box is too narrow for the full label. The label
   then ends in "…" on its own line, and nothing overflows (Task 2 test at 280px, 2x).
2. Toggling New session hides Also send. The box and the line under it must not jump (Task 2 test: the box's rect is
   unchanged).
3. Moving Also send under the box must not change the Tab order (Task 2 test: Tab from the field).
4. The disabled look (a blocked New session) must still read as a checkbox, greyed (Task 1 test).
5. The main chat's New session gets the same look with no layout change (Task 1 test in the main composer).

---

### Task 1: the checkbox look

**Files:**
- Modify: `desktop/lib/super_tabs/composer_toggle.dart`
- Test: `desktop/test/super_tab_reply_box_test.dart`

**Interfaces:**
- Produces: `SuperTabComposerToggle`, same constructor. Off: `Icon(AppIcons.square)`, key `composer-toggle-off`. On:
  `Icon(AppIcons.squareCheck)` in accent, key `composer-toggle-check`. The control is `DesktopPill(quiet: true)`, with
  no rim at rest and no fill when on. `widthOf` is unchanged.

- [ ] **Step 1: failing tests.** `off is an empty square, on a checked square; tapping toggles it`: the mark's icon is
  `AppIcons.square` / `AppIcons.squareCheck`. `no pill outline at rest or when on`: the pill is quiet.
  `a blocked New session is a greyed square`.
- [ ] **Step 2: run them and see them fail** (`flutter test test/super_tab_reply_box_test.dart`).
- [ ] **Step 3: implement.**
- [ ] **Step 4: run them and see them pass.** Then run every test file that names `composer-toggle` or
  `super-chat-new-session`.
- [ ] **Step 5: commit** test first, then code.

### Task 2: Also send in full, under the box when it does not fit

**Files:**
- Modify: `desktop/lib/super_tabs/thread_panel.dart` (`_alsoSendLabels` becomes one label; `_choices`; the line under
  the box)
- Modify: `desktop/lib/super_tabs/reply_box.dart` (`FocusTraversalOrder` on the field, attach and send; this has no
  effect outside an ordered group)
- Test: `desktop/test/super_tab_reply_box_test.dart`

**Interfaces:**
- Produces: key `super-thread-also-send` on the toggle wherever it sits, and key `super-thread-also-line` on the line
  under the box.

- [ ] **Step 1: failing tests** (they replace the step-down tests):
  - `Also send always reads in full`: Buddy and project threads at 800px, the default 340px, and 280px at 1x. The label
    is the full one, with no "…" (`didExceedMaxLines` false), and neither short label appears.
  - `where both fit they share the send row; where not, Also send is on its own line under the box`: at the exact
    boundary ±1px, it is on the row or on `super-thread-also-line` under the surface, left-aligned with it.
  - `toggling New session never moves the box`, in the narrow layout.
  - `Tab goes field, New session, Also send, attach, send`, in both layouts.
  - `at 280px with 2x text nothing overflows`: Also send is on its line, and its label may end in "…".
- [ ] **Step 2: run them and see them fail.**
- [ ] **Step 3: implement.** `_choices` decides "fits" from its constraints and records it after the frame
  (`_alsoBelow`). The decision depends only on the width, so it settles in one frame. While Also send is below, the
  row draws only New session.
- [ ] **Step 4: run them and see them pass**, plus `super_tab_thread_composer_test.dart`,
  `super_tab_threads_test.dart`, `super_tab_buddy_sessions_test.dart`, `laid_out_list_test.dart` and the style check.
- [ ] **Step 5: commit** test first, then code.

### Task 3: screenshots

**Files:** `desktop/test/super_tab_reply_box_shots_test.dart`

- [ ] Scenes: project and Buddy threads, off, on and hover, at the default width and at the narrowest, light and dark.
  Also the main chat's New session, off and on.
- [ ] Commit the PNGs in their own commit, link them in the PR body, and remove them in the next commit.
