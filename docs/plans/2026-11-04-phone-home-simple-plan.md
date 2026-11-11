# Phone Home simplified Implementation Plan

> **For agentic workers:** Follow the project's Engineer workflow: this plan is the draft pull request's first commit;
> each plan task commits its failing test, watches it fail, then commits the code that passes it; one independent review
> step on the pull request. The tasks share `mobile/lib/swarm/swarm_page.dart`, so they run one after another.

**Goal:** Phone Home with less on it, as anh Dee asked (11-04: "keep it simple and clean. less is better! simplify
everything."): one "need you" line in place of three side-scrolling cards, one small heading per Swarm in place of the
Swarm's name on every row, no Projects heading or filter icon, the + in the header next to Search instead of floating
over the list, and unread projects bold with a dot. It strengthens "Tell the PM what you want, and your crew ships it":
the phone shows what needs the person and the projects, and nothing else.

**Architecture:** All in the phone's Swarm Home (`SwarmPage`) and the widgets it draws. The away/threads/agents tiles
become one `SwarmNeedLine`, drawn only while something waits on the person, opening Activity on Needs you. The project
list groups its projects by Swarm (pins first in each Swarm) under a `SwarmCaption` with the Swarm's name; with one
Swarm shown there is no heading, as the title names it. Nothing loses its only way in: Sort and filter (with Mark all
read and Refresh in its sheet) and the agents on the person's computers become rows of the Swarm switcher, opened
from Home's title; Threads becomes a button in Activity's top bar.

**Tech Stack:** Flutter/Dart (mobile), widget tests with the existing Swarm fixtures.

**Spec:** Task #2719 in Super Tab conversation a360130c4971f66cfd017ca2 (anh Dee, 2026-11-04; mockup by River the same
day, approved by Tony, who owns mobile).

## Global Constraints

- The mockup, and only this:

  ```
  All Swarms ⌄                  🔍  +  (me)
   2 need you · 1 done                    ›
   autonomous.ai
    # openharness                         ●
    # spaceship
    # lamp
    # computer
    …
   Personal
    # storage
   Home          Buddy          Activity 2
  ```

- Phone only. Harness Design Language tokens (AppSpace, AppPalette, AppType, LucideIcons 300). No new setting.
- Nothing removed that has no other way in. Where each goes:
  - While you were away → the need-you line ("2 need you · 1 done"), shown only while something needs the person.
  - Threads card → a Threads button in Activity's top bar (the followed threads page); replies are also Activity ▸
    Replies.
  - Agents card → an Agents row in the Swarm switcher (Home's title), opening the agents by computer; each agent is
    also in Search ▸ Agents.
  - Projects heading → gone; one small heading per Swarm instead, none with one Swarm shown.
  - Filter icon (Sort and filter, Mark all read, Refresh) → a Sort and filter row in the Swarm switcher, opening the
    same sheet, with its dot when anything but the defaults is on.
  - Pinned heading → pins stay first in their Swarm's list.
  - Floating + → a + in the header, next to Search, opening the same New message.
- Never install a build on anyone's phone. Screenshots from widget tests in light and dark, and from the iPhone
  simulator in the Team account.

## Review Focus

- No way in lost: every row of the old Sort and filter sheet, the Threads page and the agents list stay reachable.
- A Home filter left on Unread or Mentions still says so and can be cleared (the switcher row's dot and words).
- The need-you line is never drawn as "0 need you", nor while what waits is still being read.

## Tasks

### Task 1: The need-you line replaces the three cards

**Files:** `mobile/lib/swarm/swarm_home_tiles.dart`, `mobile/lib/swarm/swarm_page.dart`,
`mobile/test/swarm/swarm_home_tiles_test.dart`, `mobile/test/swarm/swarm_home_test.dart`.

**Interfaces:** `SwarmNeedLine({required int needs, int? done, required VoidCallback onTap})`, key
`swarm-need-line`. `SwarmHomeTiles`, `SwarmAwayTile`, `SwarmThreadsTile`, `SwarmAgentsTile` go.

- [ ] Failing tests: with two needs and one done, Home has one line "2 need you · 1 done" and no Threads or Agents card;
  with none waiting, no line; while what waits is read, no line; a tap opens Activity on Needs you.
- [ ] Code: `SwarmNeedLine`; `_tiles` becomes `_needLine`; Home no longer builds the threads merge.

### Task 2: The + moves to the header

**Files:** `mobile/lib/swarm/swarm_page.dart`, `mobile/lib/swarm/swarm_new_message_sheet.dart`,
`mobile/test/swarm/swarm_new_message_test.dart`.

**Interfaces:** a `SwarmIconButton` keyed `swarm-new-message` (LucideIcons.plus300, "New message") between Search and
You; the floating `SwarmNewMessageButton` goes, and the list's bottom padding no longer clears it.

- [ ] Failing tests: Home has no floating action button; the header's + opens New message once, offered only where it
  was offered before.
- [ ] Code.

### Task 3: Sort and filter and Agents move to the Swarm switcher; no Projects heading

**Files:** `mobile/lib/swarm/swarm_home_top.dart`, `mobile/lib/swarm/swarm_page.dart`,
`mobile/test/swarm/swarm_home_view_test.dart`, `mobile/test/swarm/swarm_home_test.dart`.

**Interfaces:** `showSwarmSwitcher(context, session, {VoidCallback? onView, SwarmAgents? agents})`: rows
`swarm-switch-view` ("Sort and filter", its words the sort and filter on, a dot when changed) and `swarm-switch-agents`
("Agents", opening `agents.openList`). Home has no `swarm-home-view` and no "Projects" caption.

- [ ] Failing tests: no Projects caption or filter icon on Home; the switcher's Sort and filter opens the view sheet
  (Mark all read and Refresh in it); its row says a filter is on; the switcher's Agents row opens the agents list.
- [ ] Code.

### Task 4: One heading per Swarm

**Files:** `mobile/lib/swarm/swarm_page.dart`, `mobile/lib/swarm/swarm_home_rows.dart`,
`mobile/test/swarm/swarm_home_test.dart`, `mobile/test/swarm/swarm_home_project_row_test.dart`.

**Interfaces:** `SwarmHomeProjectRow` loses `swarmName`. Home's list, over several Swarms, is per Swarm a
`SwarmCaption(swarm.name)` keyed `swarm-heading-<id>` and its group (pins, then recent, then Other projects); over one
Swarm, the group alone.

- [ ] Failing tests: over two Swarms, each project is under its Swarm's heading and no row names its Swarm; over one,
  no heading; a pin is first in its Swarm; a Swarm still read shows its heading over its skeleton.
- [ ] Code.

### Task 5: Unread projects bold with a dot

**Files:** `mobile/lib/swarm/swarm_home_rows.dart`, `mobile/test/swarm/swarm_home_project_row_test.dart`.

**Interfaces:** an unread project row (news bold, no tags) ends with a dot keyed `swarm-project-unread`; a read one has
none; one with tags keeps its "@2".

- [ ] Failing test, then code.

### Task 6: Threads in Activity's top bar

**Files:** `mobile/lib/swarm/swarm_activity_page.dart`, `mobile/test/swarm/swarm_activity_page_test.dart`.

**Interfaces:** on the Activity tab, a `SwarmIconButton` keyed `swarm-activity-threads` before You, opening
`openSwarmThreads`.

- [ ] Failing test, then code.

### Task 7: Screenshots

- [ ] Update `swarm_home_shots_test.dart` goldens for light and dark; capture Home on the iPhone simulator in the Team
  account in light and dark; attach both to the pull request.
