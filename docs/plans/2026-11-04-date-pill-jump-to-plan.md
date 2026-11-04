# The date pill's Jump to menu — plan

**Goal:** Clicking the sticky date pill of a Swarm chat or thread (#2425) opens a Jump to menu, as Slack's: Yesterday,
Last week, Last month, The very beginning, then Jump to a specific date. Each choice scrolls to the first message on or
after its time, reading older messages as needed, and lights it briefly (Huy 11-04, task #2608).

**Way of working:** this project's Engineer flow: plan first, then each task's failing test before its code, one pull
request, one independent review. Built on #2906 (one label where the pill meets a day line), whose overlap logic it
leaves alone.

**Architecture:** A pure function turns a choice into the local midnight it starts at (`day_jump.dart`). The pill
(`day_pill.dart`) becomes a button with a chevron when its list gives it `onJump`. It opens a `MenuAnchor` built from
`AppMenuItem`s, as the message More menu is, and its last item swaps the menu for a `CalendarDatePicker` in the same
popover. The chat (`view.dart`) jumps the way a message link already does (`_findMessage`, `_revealTarget`, `_light`).
It reads the latest first when the time is past what it holds, then older pages until the oldest one held is before the
time, at most 50 pages as a link does. The first message on or after the time becomes the target and is lit.
The very beginning reads back with `loadBackTo(id, 0)`, which takes the first page alone when it is far back. The thread
pane (`thread_panel.dart`) does the same with its earlier replies and lights the row itself.

**Tech stack:** Flutter widgets; flutter_test widget tests with the Super Tab fixture (memory store, fake sign-in).

**Spec:** task #2608 brief, with Huy's Slack screenshot.

```
              ┌──────────────────┐
              │  Wed, Oct 29  ⌄  │  ← the sticky pill, now a button
              └──────────────────┘
          ┌──────────────────────────┐
          │ Jump to…                 │  ← muted heading
          │ Yesterday                │
          │ Last week                │
          │ Last month               │
          │ The very beginning       │
          ├──────────────────────────┤
          │ Jump to a specific date  │  → a month calendar in the same spot
          └──────────────────────────┘
```

## Global constraints

- Harness Design Language (desktop/design/desktop-design-system.md): tokens only, `AppMenu` style and `AppMenuItem`
  rows, flat, no explanatory sentences.
- The pill still floats over the list: no row moves when it shows, changes, opens its menu or hides.
- #2906's day-line covering is unchanged.
- Times are the reader's local days: Yesterday, 7 days ago and a month ago, each from its midnight.
- Desktop and web build the same widgets; nothing platform-specific.
- Tests use the memory store and fake sign-in of `test/support/super_tab_fixture.dart`; no test signs the Mac out.

## Review focus

- A time past the newest message (nothing said since) lands on the newest message, not nowhere.
- A time older than 50 pages back says "That day is too far back to open." instead of landing on the wrong message.
- The very beginning of a chat far back lands on its first message, with the newer pages waiting as after a far-back
  unread line.
- Last month from the 31st lands on the last day of a shorter month, not in the month after.
- A choice made while an earlier jump is still reading wins over it (the jump request, as links use).

## Task 1: the times each choice starts at

**Files:** create `desktop/lib/super_tabs/day_jump.dart`; test `desktop/test/super_tab_day_jump_test.dart`.

**Interfaces:** `enum SuperTabJumpTo { yesterday, lastWeek, lastMonth, beginning }`;
`DateTime? superTabJumpStart(SuperTabJumpTo choice, DateTime now)`: the local midnight it starts at, null for the very
beginning.

- [ ] Failing tests: from Wed Nov 4 2026 15:30, Yesterday is Nov 3 00:00, Last week Oct 28 00:00, Last month Oct 4
      00:00, The very beginning null. Last month from Mar 31 is Feb 28 00:00, and from Jan 15 it is Dec 15 of the year
      before.
- [ ] Run them, see them fail.
- [ ] Implement `superTabJumpStart`.
- [ ] Run them, see them pass. Commit.

## Task 2: the pill opens the menu

**Files:** `desktop/lib/super_tabs/day_pill.dart`; test `desktop/test/super_tab_day_jump_test.dart`.

**Interfaces:** `SuperTabStickyDay({..., ValueChanged<DateTime?>? onJump})`: called with a choice's start, null for the
very beginning, or a picked day's midnight. Without it the pill is as today (no chevron, not hit).

- [ ] Failing widget tests on a `SuperTabStickyDay` over a scrolled list: the pill shows a chevron and is a button.
      A click opens "Jump to…", Yesterday, Last week, Last month and The very beginning, a divider, and Jump to a
      specific date. Each choice closes the menu and calls `onJump` with Task 1's time. Jump to a specific date shows
      a calendar, and picking a day calls `onJump` with that day's midnight. Esc closes the menu without a call.
- [ ] Run them, see them fail.
- [ ] Implement the pill button, the menu and the calendar.
- [ ] Run them and the #2906 day pill tests, see them pass. Commit.

## Task 3: the chat lands on the first message from that time

**Files:** `desktop/lib/super_tabs/view.dart`; test `desktop/test/super_tab_day_jump_test.dart`.

**Interfaces:** consumes `SuperTabStickyDay.onJump`, `superTabJumpStart`; adds `_jumpToTime(String id, DateTime? from)`
in the view.

- [ ] Failing widget tests in a chat with messages over several days (fixture `messagePage` small):
      - Yesterday lands on yesterday's first message, held already, and lights it.
      - Last week lands on its first message when that needs older pages read.
      - The very beginning lands on the chat's first message, far back.
      - A specific date with nothing said since lands on the newest message.
      - A time more than 50 pages back says "That day is too far back to open." and does not move the list.
- [ ] Run them, see them fail.
- [ ] Implement `_jumpToTime` and give the chat's pill `onJump`.
- [ ] Run them, the day pill tests and the Jump to unread tests, see them pass. Commit.

## Task 4: the thread lands on its first reply from that time

**Files:** `desktop/lib/super_tabs/thread_panel.dart`; test `desktop/test/super_tab_day_jump_test.dart`.

- [ ] Failing widget test: in a thread with earlier replies not read yet, Last week lands on its first reply from then
      (reading earlier replies) and lights it. The very beginning lands on the root.
- [ ] Run it, see it fail.
- [ ] Implement the thread pill's `onJump`: earlier replies until reached (at most 50 pages), then scroll to the row and
      light it.
- [ ] Run it and the thread tests, see them pass. Commit.

## Task 5: screenshots next to Slack's

- [ ] A screenshot test (env `SUPER_TAB_DAY_JUMP_SHOTS`) renders the open menu over a chat in light and dark.
- [ ] Put them next to Huy's Slack screenshot in the pull request. Run Desktop's guard tests
      (`scripts/check-ui-style.py`, `test/laid_out_list_test.dart`) before Ready.
