# Desktop copy pass outside the Swarm screen (task #4501)

**Goal:** Every word on a Desktop screen outside the Swarm screen means something and is sharp, and an empty list or
pane stays empty (anh Dee, 11-07 16:23 and 16:30).

**Architecture:** Words only. Each user-facing string under `desktop/lib/` outside `desktop/lib/super_tabs/` is read
against the rules below and cut, shortened or kept. Where a line only fills an empty state, the line goes and its
space collapses. Tests that pin a changed line change first, then the line.

**Tech Stack:** Flutter (Desktop), flutter_test widget tests, offscreen screenshots in light and dark.

**Spec:** task #4501 brief (River, from anh Dee 11-07 16:23 and 16:30), quoted in Global Constraints.

Way of working: the project's Engineer flow: plan first, each area's changed tests committed before its strings, one
pull request, one independent review. Areas share no files, so they run in parallel.

## Global Constraints

- Rules: empty means empty: an empty list or pane shows nothing, or only the action that fills it; words stay only
  to say why something can't be used and who can fix it, or for an error. One idea per line, no line over one short
  sentence unless someone asked for an explanation. Buttons one or two words, verb first. Labels and notes a few
  words. Cut please, you can, just, simply, currently, in order to, will appear here. Say it once; never repeat what
  the screen shows. Errors say what happened and what to do, in two short sentences at most.
- anh Dee's examples: 'More disciplines will appear here as harnesses become available' is cut (store_discover.dart);
  'Your review of the last 24 hours is queued. Lessons will appear here for your approval' becomes 'Review queued'
  (daemon_lessons.dart). His third, in `super_tabs/buddy_model.dart`, is the Swarm screen's (#4465) and stays there.
- Desktop only, outside `desktop/lib/super_tabs/`. Words only; layout changes only where an empty line collapses.
- Not words people read: log lines, exception messages never shown, keys, identifiers, terminal protocol text.
- Names follow `docs/naming-system.md`; Cmd-N's Auto-approve keeps its name.

## Review Focus

- An error that lost its "what to do" while being shortened.
- An empty state whose line was the only way to learn why a list is empty when something can't be used.
- A string shared with the web build or the phone parity tests.
- A test that matched a string with `textContaining` and now passes for the wrong reason.
- A button whose new word no longer says what it does.

## Task 1: app state, connections and setup

**Files:** `lib/state/`, `lib/ws/`, `lib/core/`, `lib/bootstrap/`, `lib/usage/`, `lib/orchestrator/`, tests that pin them.

- [ ] Change the tests that pin each line to its new words; watch them fail.
- [ ] Change the lines; the tests pass.

## Task 2: widgets

**Files:** `lib/widgets/`, tests that pin them.

- [ ] Same two steps.

## Task 3: daemons and companions

**Files:** `lib/daemons/` (not the generated `roster.g.dart`), `lib/companions/`, tests that pin them.

- [ ] Same two steps; 'Review queued' for the daily review.

## Task 4: Store, Settings and the rest

**Files:** `lib/store/`, `lib/settings/`, `lib/screens/`, `lib/finder/`, `lib/devices/`, `lib/community/`,
`lib/web/`, `lib/viewer/`, tests that pin them.

- [ ] Same two steps; the Store's disciplines line is cut.

## Task 5: evidence

- [ ] Before and after screenshots, light and dark, of each changed screen that has a capture test; the PR lists
      every changed line, old and new, by screen.
