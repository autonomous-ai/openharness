# The Thread Reply Bar Is One Easy Click Target Implementation Plan

> **How this is worked:** by the project's instructions, task by task, each failing test committed before its code.

**Goal:** The bar under a thread's root (faces, "N replies", "Last reply …") is one comfortable click target that, on hover or keyboard focus, gets a light fill and border, reads "View thread" and shows a chevron at its right, as Slack's does.

**Architecture:** `SuperTabThreadLine` (desktop/lib/super_tabs/message_row.dart) draws the replies part through `SuperTabLink`, a bare link the size of its text with 16-point faces. It gets its own bar instead: a padded, rounded `InkWell` with 24-point faces that tracks hover and focus, and lays out both "Last reply …" and "View thread" and the chevron at rest, showing one, so the bar keeps its size through hover. Its width is its content's up to a maximum. The web app is the same Flutter code, so one change serves Desktop and web. The session-only line (no reply yet), the session mark and End session stay as they are.

**Tech Stack:** Dart, Flutter 3.47.2; widget tests (`flutter test`, and `--platform chrome` for the web).

**Spec:** Task #2315 (Huy), its brief, and the mockup in Huy's proposal thread:

```
resting
  (a)(b)  17 replies   Last reply 5 days ago

hover or keyboard focus (light fill and border, pointer anywhere)
┌──────────────────────────────────────────────┐
│ (a)(b)  17 replies   View thread           › │
└──────────────────────────────────────────────┘
```

## Global Constraints

- The PR body starts with: `Requested by phamngochuy.1989@gmail.com through Harness.`
- Harness design language (desktop/design/desktop-design-system.md): controls keep their bounds through hover and focus; hover adds the shared fill (`AppSurface.hoverFill`) and the rim (`DesktopChrome.rim`); keyboard focus has the blue boundary (`DesktopChrome.focusRing`, `AppDesktop.focusWidth`); `AppIcons.chevronRight` at `AppIcons.inlineSize`.
- Faces 24 points. Tab reaches the bar, Enter opens the thread. Pointer cursor anywhere on the bar.
- Huy's look is the merge gate: screenshots of the bar resting and hovered in the PR.
- Desktop tests use a memory store and a fake sign-in; nothing signs the Mac out of the real CLI.

## Review Focus

1. A click on the bar's padding or its chevron, not its words, opens the thread (Task 1 test taps the bar's corner).
2. Hover does not move anything: the bar's size is the same resting and hovered (Task 1 test).
3. Many repliers or a narrow chat: the bar stays within its maximum and the chat's width, its words ellipsized, never overflowing (Task 1 test, 300-point chat).
4. A session thread's mark and End session stay outside the bar and keep working (existing `super_tab_threads_test.dart` tests).
5. The thread view shows no reply bar (the root's line opens nothing there, `view.dart` `onOpenThread`), so "the same in the thread view" holds by the same widget wherever a reply bar is drawn.

---

### Task 1: The reply bar

**Files:**
- Modify: `desktop/lib/super_tabs/message_row.dart` (`SuperTabThreadLine`)
- Test: `desktop/test/super_tab_threads_test.dart`

**Interfaces:**
- Produces: the bar keyed `super-thread-bar-<thread id>`; its words "View thread" on hover or focus; its chevron keyed `super-thread-chevron-<thread id>`, shown (opacity 1) only on hover or focus. `SuperTabThreadLine`'s constructor is unchanged.

- [ ] **Step 1: Write the failing tests** in `super_tab_threads_test.dart`, `group('the reply bar')`:
  - `hovering anywhere on it highlights it and offers View thread` — a mouse moved to the bar's right edge: "View thread" shown, "Last reply 2 min ago" not, the chevron's opacity 1, the bar's decoration has `AppSurface.hoverFill` and a `DesktopChrome.rim` border; the bar's size equals its resting size.
  - `one click anywhere on it opens the thread` — a tap 3 points inside the bar's top-left and one on the chevron each call `onOpen`; the bar is at least 32 points high; a face is 24 points.
  - `Tab reaches it and Enter opens the thread` — Tab focuses it: "View thread" and a `DesktopChrome.focusRing` border; Enter calls `onOpen`.
  - `it is as wide as its content, within its maximum` — in an 800-point column it is narrower than 600; with 12 repliers in a 300-point chat it fits, no overflow.
- [ ] **Step 2: Run** `flutter test test/super_tab_threads_test.dart` in `desktop`: the new tests FAIL (no hover state, no chevron, 16-point faces).
- [ ] **Step 3: Commit** the failing tests and push.
- [ ] **Step 4: Implement** the bar in `message_row.dart`: a private `_SuperTabThreadBar` stateful widget (hover and focus state; `Semantics` button with the line's label; `InkWell` with `SystemMouseCursors.click`, no splash; `AnimatedContainer`-free `DecoratedBox`; padding 8×4; maximum width 480).
- [ ] **Step 5: Run** the file, `flutter analyze lib/super_tabs/message_row.dart`, and the file again with `--platform chrome --dart-define=HARNESS_TEST=true`: PASS.
- [ ] **Step 6: Commit and push**; screenshots resting and hovered (light and dark) in the PR.

### Task 2: Before Ready

- [ ] `flutter test test/super_tab_threads_test.dart test/super_tab_chat_test.dart` and the other Super Tab tests that find the reply line, all passing; red/green evidence comment on the PR; mark it ready; Review step by Routing.
