# Day pill over its own day line: one label — plan

**Goal:** While the Swarm chat's sticky day pill (#2425, #2784) floats over a day line, only one day label shows:
the pill takes the line's place, as Slack's, and its fill is opaque in light and dark (Huy 11-04).

**Way of working:** this project's Engineer flow: plan first, then each task's failing test before its code, one pull
request, one independent review.

**Architecture:** `SuperTabStickyDay` (desktop/lib/super_tabs/day_pill.dart) already measures the rows under it after
each frame. The chat's day line label (`_date` in view.dart) becomes a `SuperTabDayLabel` that registers with the same
scope. After each frame the sticky day measures the labels too: every label whose top has reached the pill's bottom
edge is hidden (painted invisible, same size, so no row moves), and the pill says the day of the lowest such label, else
the day of the row at the top as before. So a line meets the pill, the pill turns to the line's day and the line's
label goes; scrolling back, the label returns once it is below the pill. The rule lines stay; the pill covers their
middle.

**Tech stack:** Flutter widgets, flutter_test widget tests with the Super Tab fixture (memory store, fake sign-in).

**Spec:** task #2643 brief (Huy 11-04).

```
before                               after
──────── Wed, Nov 4 ────────         ────────(Wed, Nov 4)────────
        (Wed, Nov 4)    ← overlap            ↑ pill only; line label hidden
Lead  Pushed the branch…             Lead  Pushed the branch…
```

## Global constraints

- The pill still floats: no row moves when it shows, changes or hides, or when a label hides.
- Threads have no day lines; the thread pill keeps its behaviour.
- Desktop and web build the same widgets; nothing platform-specific.
- Tests use the memory store and fake sign-in of `test/support/super_tab_fixture.dart`.

## Review focus

- The pill's day and the hidden label are decided from the same measurement, so they can never disagree for a frame.
- A hidden label keeps its size and its semantics (screen readers still read the day line).

## Task 1: one label where the pill meets a day line

**Files:** `desktop/lib/super_tabs/day_pill.dart`, `desktop/lib/super_tabs/view.dart`,
`desktop/test/super_tab_day_pill_test.dart`

**Interfaces:** `SuperTabDayLabel({required DateTime day, required Widget child})`.

- [ ] Failing test: scrolling the chat in small steps across Tuesday's day line, at no step do the pill and a visible
      day-line label overlap, and the pill never shows next to a visible label of its own day under it.
- [ ] Failing test: the pill's fill is opaque in light and dark.
- [ ] Run them, see them fail.
- [ ] Implement `SuperTabDayLabel` and the measurement; opaque fill.
- [ ] Run the pill tests and the Super Tab view tests; screenshots in light and dark.
