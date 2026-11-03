# Swarm Text Matches Slack Desktop Implementation Plan

> **How this is worked:** by the project's instructions, task by task, each failing test committed before its code.

**Goal:** The Swarm screens (chat messages, sender names and times, sidebar, composer, thread view) use Slack desktop's
text sizes, weights and line heights, in the system font, on Desktop and on the web build.

**Architecture:** One set of Swarm text tokens, `SwarmType` in `desktop/lib/super_tabs/swarm_type.dart`, holds Slack's
numbers. The Swarm widgets that draw these texts take their styles from it instead of the app-wide `DesktopChrome`
defaults (14 px on 1.45, names 14 px semibold, sidebar 13 px on 36 px rows). Message bodies get a Swarm markdown sheet
built on `desktopMarkdownStyleSheet`, so other screens' markdown is unchanged. The web app is the same Flutter code
(`lib/web`), so it changes with Desktop. A phone layout (`workspaceIsCompact`) keeps its 44 px finger targets.

**Tech Stack:** Flutter 3.47.2, flutter_test render tests.

**Spec:** Task #2312 (Huy), brief by the PM, 2026-11-03.

## Slack's numbers

To be measured from Huy's Slack desktop screenshots at Actual Size (asked in the task's thread). Until then these are the
values Slack's own web client sets, which the desktop app renders. The measurement replaces any that differ, before
Ready.

| Text | Size | Line | Weight |
|---|---|---|---|
| Message body | 15 px | 22 px | regular (400) |
| Sender name | 15 px | 22 px | black (900; the system font draws its heaviest) |
| Time beside the name | 12 px | 22 px line of the name | regular, muted |
| Sidebar item | 15 px | 28 px row | regular; unread bold (700) |
| Sidebar section heading | 15 px | 28 px row | medium (500), muted |
| Composer | 15 px | 22 px | regular |
| Thread view header | 15 px | 22 px | black (900) |

## Global Constraints

- The PR body starts with: `Requested by phamngochuy.1989@gmail.com through Harness.`
- Harness design language; the font family stays the system font unless Dee asks for Lato before the build starts.
- Swarm screens only: terminal, settings and other screens keep their styles (`DesktopChrome` and the shared markdown
  sheet are not changed).
- Keyboard focus and hit targets stay: no row gets shorter than its pointer target, and phone rows keep 44 px.
- Huy's look is the merge gate; side-by-side screenshots in the PR.
- Desktop tests use a memory store and a fake sign-in; nothing signs this Mac out of the real CLI.

## Review Focus

1. A long message wraps on 22 px lines with no clipped descenders: the line height is set on the text, not on a fixed
   box. (Task 1 test: a two-line body is 44 px tall.)
2. Markdown inside a message (lists, quotes, bold, links) uses the same 15/22 body, and inline code keeps the mono face.
   (Task 1 test.)
3. The sidebar's unread row stays bold and its selected row stays medium at the new size. (Task 2 test.)
4. The other screens that share `DesktopChrome.text` and `desktopMarkdownStyleSheet` (Finder's markdown view) are
   unchanged. (Task 1 test.)
5. Sidebar rows at 28 px on a pointer layout stay focusable and clickable over their whole width; a phone layout keeps
   44 px. (Task 2 test.)

## Design

- **Growth, concurrency, read cost, migration, audience, identity:** N/A because this stores, syncs and exposes no data:
  it changes text styles only.
- **Scale:** N/A because style constants cost nothing per message.
- **Compatibility:** N/A because no data or protocol changes; old and new clients only look different.
- **Rollback:** reverting the PR restores the old styles.
- **Failure:** N/A because nothing can fail at run time.
- **Platforms:** macOS, Windows and Linux Desktop and the web build share the code; phones keep their finger sizes.

---

### Task 1: Message text, names, times and the composer

**Files:**
- Create: `desktop/lib/super_tabs/swarm_type.dart`
- Modify: `desktop/lib/super_tabs/message_row.dart`, `desktop/lib/super_tabs/message_text.dart`,
  `desktop/lib/super_tabs/reply_box.dart`, `desktop/lib/super_tabs/thread_panel.dart`
- Test: `desktop/test/super_tab_typography_test.dart`

**Interfaces:**
- Produces: `abstract final class SwarmType` with `static const double bodySize = 15, bodyLine = 22, timeSize = 12,
  sidebarSize = 15, sidebarRow = 28` and `static TextStyle body({Color? color})`, `name({Color? color})`,
  `time({Color? color})`, `sidebar({Color? color, FontWeight? weight})`, `composer({Color? color})`;
  `MarkdownStyleSheet swarmMarkdownStyleSheet(BuildContext context)`.

- [ ] **Step 1: Write the failing tests** in `super_tab_typography_test.dart`, pumping a `SuperTabMessageRow` and a reply
  box from the existing test fixtures:
  - `it reads a message body at 15 px on 22 px lines`: the body's `RichText` style has `fontSize == 15` and
    `height * fontSize == 22`; a body of two lines in a narrow box renders 44 px tall.
  - `it names the sender at 15 px in the heaviest weight, and the time at 12 px`: name `fontSize 15`, `fontWeight w900`;
    time `fontSize 12`, muted colour.
  - `it writes in the composer at 15 px on 22 px lines`, hint included.
  - `it keeps markdown in the body at 15 px and code in the mono face`: a list item, a quote and bold at 15 px; inline
    code's family is `AppFonts.mono`.
  - `it leaves other screens' markdown as it was`: `desktopMarkdownStyleSheet(context).p!.fontSize == 14`.
  - `it heads the thread view at 15 px in the heaviest weight`.
- [ ] **Step 2: Run them and watch them fail:** `flutter test test/super_tab_typography_test.dart` (sizes are 14).
- [ ] **Step 3: Add `SwarmType` and `swarmMarkdownStyleSheet`; use them** for the body, name, time, composer and thread
  header.
- [ ] **Step 4: Run them and see them pass**, with the Swarm widget tests:
  `flutter test test/super_tab_typography_test.dart test/super_tab*_test.dart`.
- [ ] **Step 5: Commit** the tests first, then the code.

### Task 2: The sidebar

**Files:**
- Modify: `desktop/lib/super_tabs/project_sidebar.dart`
- Test: `desktop/test/super_tab_typography_test.dart`

**Interfaces:**
- Consumes: `SwarmType.sidebar`, `SwarmType.sidebarRow` (Task 1).

- [ ] **Step 1: Write the failing tests:**
  - `it draws sidebar items at 15 px on 28 px rows`: an item's text `fontSize 15`; its row 28 px tall on a pointer layout.
  - `it keeps an unread item bold and a selected one medium`.
  - `it keeps a phone's sidebar rows a finger tall`: 44 px under a compact layout.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Use `SwarmType.sidebar` and the 28 px row** in the item and section-heading rows.
- [ ] **Step 4: Run them and the Swarm widget tests and see them pass.**
- [ ] **Step 5: Commit** the tests first, then the code.

### Task 3: Measure Slack and show the result side by side

- [ ] Measure Huy's Slack screenshots (text cap height, row pitch, weight) and correct the table above and `SwarmType`
  where they differ, with the tests' numbers.
- [ ] Render the Swarm chat, sidebar and thread at Slack's zoom in the system font (a screenshot test run locally with
  macOS's own font loaded; not committed as a golden, since CI's fonts differ) and put each beside Slack's in the PR.
- [ ] `flutter analyze` and the Desktop test suite; red/green evidence in a PR comment; mark Ready; a Team-account
  Reviewer by Routing.
