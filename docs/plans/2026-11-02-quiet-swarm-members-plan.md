# Quiet Swarm 5/6: Members on demand and member cards Implementation Plan

> **For agentic workers:** this plan follows the project's own way of working (project instructions, Engineer):
> one Engineer implements it task by task, test first, each failing test committed before its code; the pull
> request's Review step is the one independent review. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Swarm screen's right column opens only from Members, and lists People and Agents in one line each
(screen 4); a click opens that person's or agent's card (screen 5).

**Architecture:** `SuperTabView` docks the roster only while `_rosterOpen` (wide windows) or shows it as today's
drawer (narrow); the Members button is in the header at every width and the roster's heading carries the
project-or-Swarm choice and a close. `SuperTabRoster` draws one-line rows: People with points and the crown, Agents
with name, status word and mark, ordered by the existing marks and with task-free idle, stopped or offline agents
folded under a collapsible "Idle (N)" heading. Cards are `SuperTabDetailDialog`s: the agent card in
`agent_details.dart` beside today's full details (which stay behind "Details…"), the person card in `roster.dart`
built from `leaderboard/person_row.dart` pieces.

**Tech Stack:** Flutter (Dart 3.13), `flutter_test` widget tests over the in-memory `ConversationServer` fixture
(`test/support/super_tab_fixture.dart`), the browser review fixture `tool/super_tab_mobile_fixture.dart` for
screenshots.

**Spec:** [docs/plans/2026-11-02-quiet-swarm-design.md](2026-11-02-quiet-swarm-design.md), screens 4 and 5, Rules,
"What moves where" rows Humans column / Agents column / Invite, and Calls made by the PM (Members).

## Global Constraints

- Follow `desktop/design/desktop-design-system.md`: no new colors, icons or controls; one line per row; fewer words.
- "Members rows: name, then status word and mark. Role, model, effort and machine go on the agent's card."
- "People show as their username." "Points: one number per person, rolling 7 days; the period is on hover. The crown
  follows the week's top name."
- "Agents are grouped: waiting on a person first, then working; idle agents fold under "Idle (N)"."
- "The project-or-Swarm choice Dee added today becomes Members' heading."
- Anything the design doesn't draw stays as it is (right-click Details / Remove from Swarm, the + on People and
  Agents, the waiting line, Edit profile, the row hovers).
- Desktop tests use a memory store and the fake server; never a test that signs this Mac out of the real CLI.
- Swarm code stays out of `cli/src/core`. No on/off switch: it ships on.
- Stay inside the owned files: `roster.dart`, `roster_scope.dart`, `agent_details.dart`, `leaderboard/person_row.dart`,
  their tests; plus the two touch points the column needs in `view.dart` (`_swarm`'s right side and the header's
  Members button) and the naming system's members paragraph.

## Review Focus

- A thread open in a wide window when Members is pressed: the thread closes and Members takes the right side
  (Slack's way), and Members closes when a thread opens. Test in Task 1.
- An agent with a task whose machine went down (lost work, mark offline) never hides under Idle (N). Test in Task 3.
- No project open (Activity, Devices): the heading reads "All projects" with no choice, and the list is the whole
  Swarm. Test in Task 2.
- A server before rolling periods (weeks only): points still show, with "this week" on hover, and no picker
  appears. Test in Task 2.
- An agent with no model or machine known: the card's second line shows only what is known, and is absent when
  nothing is. Test in Task 4.

---

### Task 1: The right column is closed at rest and opens from Members

**Files:**
- Modify: `desktop/lib/super_tabs/view.dart` (`_swarm`, `_header`'s Members button, `_toggleRoster`)
- Modify: `desktop/lib/super_tabs/roster.dart` (new `onClose`)
- Test: `desktop/test/super_tab_members_test.dart` (new)

**Interfaces:**
- Produces: `SuperTabRoster({..., VoidCallback? onClose})`; the close button `ValueKey('super-members-close')`;
  the header button keeps `AppIcons.users`, tooltip `Members`, `ValueKey('super-members-button')`.

- [ ] **Step 1: Write the failing tests** — `'the right column is closed at rest in a wide window'` (1440 wide:
  `find.byType(SuperTabRoster)` finds nothing); `'Members opens the column and its close shuts it'`;
  `'Members takes the right side from an open thread'`.
- [ ] **Step 2: Run** `flutter test test/super_tab_members_test.dart` — expected FAIL (roster docked at rest).
- [ ] **Step 3: Implement** — dock the roster when wide and `_rosterOpen`; the Members button shows at every width;
  opening it closes an open thread; opening a thread closes it.
- [ ] **Step 4: Run** the new file and `test/super_tab_view_test.dart` — PASS.
- [ ] **Step 5: Commit** test, then code.

### Task 2: The heading is the scope choice; People rows are one line

**Files:**
- Modify: `desktop/lib/super_tabs/roster.dart` (`_members` heading and people), `roster_scope.dart` (labels)
- Modify: `desktop/lib/super_tabs/leaderboard/person_row.dart` (`LeaderboardPersonRow`: one line)
- Test: `desktop/test/super_tab_members_test.dart`, `super_tab_humans_test.dart`, `super_tab_roster_scope_test.dart`

**Interfaces:**
- Produces: heading `AppSelectField<SuperTabRosterScope>` `ValueKey('roster-scope')` with labels
  `This project` / `All projects` (`superTabRosterScopeLabel(SuperTabRosterScope) -> String` in `roster_scope.dart`);
  section headings `People` and `Agents`; `LeaderboardPersonRow` no longer takes `weekName`-driven detail lines:
  avatar, name + crown, points; points' tooltip `Points in the last 7 days` (the board's `spanName`).

- [ ] **Step 1: Write the failing tests** — `'the heading is the project-or-Swarm choice'`
  (labels `This project`, `All projects`; no `leaderboard-period`/`leaderboard-week`);
  `'no open project reads All projects with no choice'`; `'a person row is one line: name, crown, points'`
  (no `leaderboard-meta-*`, points tooltip says the period); `'a weeks-only server shows points with this week on
  hover'`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** The period picker goes; the board stays on `leaderboardDefaultPeriod` ('7d').
- [ ] **Step 4: Run** the three files — PASS; update older tests that pinned the Humans heading, the week picker
  and the numbers line to the new screen.
- [ ] **Step 5: Commit** test, then code.

### Task 3: Agent rows are one line; idle agents fold under Idle (N)

**Files:**
- Modify: `desktop/lib/super_tabs/roster.dart` (`_agent`, `_members` agents)
- Test: `desktop/test/super_tab_members_test.dart`, `super_tab_roster_test.dart`

**Interfaces:**
- Produces: row `ValueKey('super-member-<id>')` with avatar, name, status word `ValueKey('super-member-word-<id>')`
  (the glance label with its first letter lower-cased: `waiting`, `working`, `idle`, `limited until 09:05`) and
  `ActivityMark` `ValueKey('super-member-mark-<id>')`; fold heading `SuperTabSectionHeading('Idle (N)')` with
  `onToggleCollapsed`, `ValueKey('super-members-idle')`, folded by default, kept for the visit.
  `superTabFoldsIdle(SuperTabAgentState) -> bool`: no task and mark idle, paused or offline.

- [ ] **Step 1: Write the failing tests** — `'an agent row is name, status word and mark'` (no role chip, no model,
  no `super-member-line-*`); `'waiting agents come first, then working'`; `'idle agents fold under Idle (N)'`
  (count, hidden until the heading is pressed); `'an agent with lost work stays above the fold'`;
  `'a click opens the agent card'`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Tap and long press open the card (Task 4); right-click keeps Details and Remove from
  Swarm; the hover keeps today's tooltip.
- [ ] **Step 4: Run** — PASS; update older row tests (detail line, model after the chip, tap opens the task).
- [ ] **Step 5: Commit** test, then code.

### Task 4: The agent card and the person card

**Files:**
- Modify: `desktop/lib/super_tabs/agent_details.dart` (new `showSuperTabAgentCard`)
- Modify: `desktop/lib/super_tabs/roster.dart` (`_person` becomes the person card)
- Modify: `desktop/lib/super_tabs/leaderboard/person_row.dart` (`LeaderboardPersonWeek` without its points line on
  the card)
- Test: `desktop/test/super_tab_members_test.dart`, `super_tab_humans_test.dart`

**Interfaces:**
- Produces: `Future<void> showSuperTabAgentCard(BuildContext, SuperTabController, AppNotifier?, SuperTabAgent,
  {required ValueChanged<SuperTabAgent> onOpenAgent, required ValueChanged<String> onOpenTask})`: a
  `SuperTabDetailDialog` titled with the agent's name, its role badge at the header's right, then the task title
  (a link that opens the task, `ValueKey('super-card-task')`), then `model · effort · machine`
  (`ValueKey('super-card-run')`, only what is known), and `Open terminal` (leading) and `Details…` (which opens
  `showSuperTabAgentDetails`).
  Person card: title `username` with the crown, `N points` at the header's right (period on hover), detail line
  `N shipped · N unblocked · N hours` (`ValueKey('super-card-numbers')`), the week's lists below as today, and
  `Manage people` (+ `Edit profile` on one's own).

- [ ] **Step 1: Write the failing tests** — `'the agent card shows task, model · effort · machine, Open terminal and
  Details…'`; `'the card's task opens its conversation'`; `'Details… opens the full details'`;
  `'an agent with nothing known shows no run line'`; `'the person card shows points, crown and the three numbers'`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** test, then code.

### Task 5: Naming, analysis, screenshots

**Files:**
- Modify: `docs/naming-system.md` (the members pane paragraph)
- Modify: `desktop/tool/super_tab_mobile_fixture.dart` (seed: points, waiting/working/idle agents) if the review
  scenario lacks them

- [ ] **Step 1:** Update the naming paragraph: Members opens on demand; People and Agents; one line each; the card.
- [ ] **Step 2: Run** `flutter analyze` on the changed files and the affected suites
  (`super_tab_members_test`, `super_tab_roster_test`, `super_tab_humans_test`, `super_tab_roster_scope_test`,
  `super_tab_view_test`, `super_tab_profile_sheet_test`, `super_tab_heartbeat_widgets_test`,
  `super_tab_phone_header_test`, `super_tab_agent_line_test`) — all PASS.
- [ ] **Step 3:** Build the browser fixture, capture screens 4 and 5 at 1440 in both themes, attach to the PR.
- [ ] **Step 4: Commit.**
