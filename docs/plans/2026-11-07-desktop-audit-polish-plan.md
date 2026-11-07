# Desktop 1.3.89 audit: words, Board fit, new-project visibility, left pane and polish — Implementation Plan

> Way of working: the Engineer implements this plan task by task, test first, each failing test committed before
> its code (project instructions, Roles › Engineer). Groups A–D share no files and run in parallel.

**Goal:** Fix audit findings 11, 12, 14, 19, 20, 21 and the "Smaller polish" list of the Desktop 1.3.89 audit, so the
screens a person meets first say one thing and fit a laptop window.

**Architecture:** Desktop-only changes in `desktop/lib/`, each a small edit to the widget the finding names, reusing
its existing components (`AppMenuItem`, `ProjectVisibility`, `SuperTabSectionHeading`, `DesktopPill`,
`AppSelectField`, `SkeletonText`). No server change.

**Tech Stack:** Flutter (Dart), widget tests with a memory store and a fake sign-in, shot tests that write PNGs only
when `HARNESS_SUPER_TAB_CAPTURE` names a folder (`test/support/capture.dart`).

**Spec:** `docs/audits/2026-11-07-desktop-1.3.89.md` (PR #3526, task #4436), findings 11, 12, 14, 19, 20, 21 and
"Smaller polish"; task #4445.

## Global Constraints

- Words follow `docs/naming-system.md`: the coordinator is **Product Manager** on screen, never "Lead"; Swarm, never
  "org".
- Change only what a finding names; reuse existing components and styles; no new setting or switch.
- No raw Material `DropdownButton`/`IconButton` (`desktop/CLAUDE.md`).
- Tests never sign in or read a login; they use `MemoryKeyValueStore` and the existing fakes.
- Every finding: a test that fails before its code, then passes; light and dark shots at 880 and/or 1500 wide.
- Shared Flutter code: macOS, Windows, Linux alike; nothing here starts a process.

## Review Focus

- A text scale above 1.0: the role menu's lines, the folded Projects count and the empty-org buttons still fit.
- A Swarm the reader can only read: Cmd-N and the empty-org buttons stay disabled or hidden, as + New agent is.
- A Board with every column empty but one, and one with all columns full: the fit never cuts a column mid-word.
- A recovered + New agent journal (phase starting): the role and the visibility stay locked as sent.
- Keyboard only: Tab through the left pane shows one ring on the focused row, distinct from the selected fill.

---

## Group A — New agent form (`widgets/new_harness_form.dart`, `screens/swarm_screen.dart`, `super_tabs/launch.dart`, `state/new_harness.dart`, `state/harness_launch_integration.dart`)

### Task A1: One name for the PM role, whole menu lines (finding 11, words)

**Files:** Modify `lib/widgets/new_harness_form.dart` (`_desktopKindMenu`, the agent-kind `DesktopPill`). Test:
`test/super_tab_new_agent_words_test.dart`.

- [ ] Failing test: open + New agent's form; the chip reads `Agent`; the menu lists `Agent` — `Works with you in its
  own chat` and `Product Manager` — `Leads a project and its crew`; no `Lead` or `Member` text anywhere in the form;
  each detail line renders unclipped (its `RenderParagraph.didExceedMaxLines` is false) at 880 wide and text scale
  1.3. Choosing Product Manager makes the chip read `Product Manager` with the crown.
- [ ] Code: labels and details above; tooltip `Start as an agent or a Product Manager`; the menu is as wide as its
  longest line needs (at least today's `_machineMenuWidth`). Wire values stay `member`/`lead`.
- [ ] Shots light/dark at 880 and 1500 of the open menu.

### Task A2: Cmd-N in a Swarm opens + New agent's form (finding 11, two meanings)

**Files:** Modify `lib/screens/swarm_screen.dart` (`_newAgent`). Test: same file as A1.

- [ ] Failing test: in a Swarm v3 tab (the one that shows My agents and + New agent), Cmd-N, File ▸ New Agent and
  the search's New agent each open the form with the role chip and a `New agent` button — the same form + New agent
  opens. A reader who can't write gets what + New agent gives them (nothing).
- [ ] Code: in a Swarm tab where + New agent is offered, `_newAgent` with no explicit conversation, split or project
  takes the `newSwarmAgent: true` path.

### Task A3: Product Manager asks whether its project is public (finding 14)

**Files:** Modify `lib/super_tabs/launch.dart` (the `newAgent` journal and `projectVisibility`),
`lib/widgets/new_harness_form.dart` (show `ProjectVisibility` while the kind is `lead`). Test:
`test/super_tab_new_agent_visibility_test.dart`.

- [ ] Failing test: + New agent, choose Product Manager: the same `ProjectVisibility` control as + New project shows,
  defaulting to Public; choosing Private sends `project.create` with `visibility: private`. With Agent chosen the
  control is hidden. After the first request it is locked, as + New project's is.
- [ ] Code: the new-agent journal carries `visibility`; the integration's `projectVisibility` is set for a new agent;
  the form shows the control only while `agentKind == 'lead'`; `prepare` saves it as the + New project path does.

### Task A4: New agent names and folder chip (polish)

**Files:** Modify `lib/super_tabs/launch.dart` (`_openMemberChat` name), `lib/screens/swarm_screen.dart` (folder
chip with no remembered project). Test: `test/super_tab_new_agent_names_test.dart`.

- [ ] Failing test: with an agent already named `Claude Code` in the Swarm, a new Claude Code agent is sent as
  `Claude Code 2` (then `3`); Codex likewise.
- [ ] Failing test: with no remembered project the folder chip reads `New folder`, never the generated
  `claude-YYYY-…` name; the generated folder name is still what is created.
- [ ] Code: the first free name among the snapshot's agents; the chip's label for an auto project is `New folder`.

## Group B — Board and middle (`super_tabs/tasks_view.dart`, `super_tabs/view.dart`)

### Task B1: The Board shows Working at 1500 (finding 12)

**Files:** Modify `lib/super_tabs/tasks_view.dart` (`_fullWidth`). Test: `test/super_tab_board_fit_test.dart`.

- [ ] Failing test: a 1500×860 window with Proposal 2, Next up 2, Working 2, empty Review/Done/Merged, Shipped 1:
  Proposal, Next up and Working are fully on screen.
- [ ] Code: `_fullWidth` tries every count of full columns, with the slim lanes between them; trailing lanes are
  included when they fit and otherwise start at the view's edge, never cut. Today it only tries counts that end
  before a full column, so empty lanes after Working made it fall back to two.

### Task B2: At the smallest window the left pane folds into its drawer (finding 12)

**Files:** Modify `lib/super_tabs/view.dart` (`narrow` in the layout build, `_boardHeader`). Test:
`test/super_tab_board_fit_test.dart`.

- [ ] Failing test: at 880 wide with the Board on, the left pane is not laid out, the Board header has the
  `Conversations` menu button, pressing it opens the left pane as a drawer and Esc closes it; at 1100 the left pane
  is in place and the button is absent. The toolbar is one row at 880.
- [ ] Code: the Board layout folds the left pane below 1000 logical px (scaled by text scale), with the same drawer
  views without the Board use; the button goes in `_boardHeader`.

### Task B3: Empty Swarm says one thing (finding 20, middle)

**Files:** Modify `lib/super_tabs/view.dart` (`_conversation` empty state). Test:
`test/super_tab_empty_swarm_test.dart`.

- [ ] Failing test: a Swarm with no projects shows `Start a project, or bring an agent to work with you.`, then
  `New project` and `New agent` drawn by the same widget at the same size; a pending action reads `Check again`.
- [ ] Code: one sentence; both buttons the same secondary style with a + icon.

### Task B4: Board polish (polish)

**Files:** Modify `lib/super_tabs/tasks_view.dart` (`_offView`, the "Tasks" title), `lib/super_tabs/view.dart`
(`_openTask`/`_openPersonalTask` when the chat can't be read, Board/List tab). Test:
`test/super_tab_board_polish_test.dart`.

- [ ] Failing test: a pill names only columns wholly off screen.
- [ ] Failing test: with List on, the tab row shows which view is on and no `Tasks` title repeats it.
- [ ] Failing test: clicking a card whose chat can't be read shows `You can't open this task's chat.` where the
  pane shows action hints.
- [ ] Code: the smallest change for each.

## Group C — Left pane (`super_tabs/project_sidebar.dart`, `super_tabs/buddy_rows.dart`, `super_tabs/identity.dart`, `super_tabs/section_heading.dart`)

### Task C1: Folded Projects shows when something waits (finding 19)

**Files:** Modify `lib/super_tabs/section_heading.dart`, `lib/super_tabs/project_sidebar.dart`. Test:
`test/super_tab_projects_folded_test.dart`.

- [ ] Failing test: Projects folded with a mention in one project: the heading is bold and carries the waiting count
  (the same number the project rows' badges add up to); with nothing waiting it is the normal heading.
- [ ] Code: an optional `waiting` count on `SuperTabSectionHeading`, shown only while collapsed.

### Task C2: Keyboard focus is a ring, not a second selection (finding 21)

**Files:** Modify `lib/super_tabs/buddy_rows.dart`, `lib/super_tabs/project_sidebar.dart`. Test:
`test/super_tab_sidebar_focus_test.dart`.

- [ ] Failing test: Tab to a row that is not selected: its fill is unchanged (not the hover fill) and it draws a
  `DesktopChrome.focusRing`-coloured 2 px border; the selected row keeps its fill.
- [ ] Code: focus draws the ring; hover keeps the hover fill.

### Task C3: Left-pane polish and "No projects yet" (finding 20, polish)

**Files:** Modify `lib/super_tabs/project_sidebar.dart`, `lib/super_tabs/identity.dart`. Test:
`test/super_tab_sidebar_polish_test.dart`.

- [ ] Failing tests: a long Swarm name has a tooltip with the whole name; a PM's project reads `Orion · web-project`;
  the crown is at least 12 px on a 20 px avatar; an agent with no chat shows no hover fill or click cursor; open
  Projects with none shows `No projects yet.`
- [ ] Code: the smallest change for each.

## Group D — Tasks pane, Buddy dialogs, join dialog (`super_tabs/tasks/`, `super_tabs/buddy_*.dart`, `super_tabs/buddies.dart`, `super_tabs/join_dialog.dart`, and the other "Check pending action" sites)

### Task D1: Tasks pane and task header polish

**Files:** Modify `lib/super_tabs/tasks/personal_tasks_pane.dart`, `lib/super_tabs/tasks/task_header.dart`. Test:
`test/super_tab_tasks_pane_polish_test.dart`.

- [ ] Failing tests: the pressed Approve or Reject shows a spinner; buttons disabled by another pending action say
  why in their tooltip; a merged task's header draws the merged pull-request icon; Auto approve / Review is an
  `AppSelectField` whose options say what each does; loading draws skeleton cards; the empty pane says
  `No tasks yet. Tasks your agents start or propose show here.`
- [ ] Code: reuse the existing spinner, `AppIcons` merge icon, `AppSelectField` and `SkeletonText`. The header's ⋮
  is left out: nothing it would hold is missing from the header today (said in the PR).

### Task D2: Buddy dialogs and header polish

**Files:** Modify `lib/super_tabs/buddy_restart.dart`, `lib/super_tabs/buddies.dart`, `lib/super_tabs/buddy_model.dart`,
`lib/super_tabs/buddy_machines.dart`. Test: `test/super_tab_buddy_polish_test.dart`.

- [ ] Failing tests: Restart and Rename errors use the card's error colour; the Buddy header names its model, not
  `Your subscription`; with one model choice there is no menu arrow; `Choose a machine` is whole at 880.
- [ ] Code: the smallest change for each.

### Task D3: Join dialog and "Check pending action" words

**Files:** Modify `lib/super_tabs/join_dialog.dart`, `lib/super_tabs/project_add_people.dart`,
`lib/super_tabs/work_details.dart`, `lib/super_tabs/project_options.dart`, `lib/super_tabs/switch_pm.dart`. Test:
`test/super_tab_join_polish_test.dart`.

- [ ] Failing tests: the join dialog labels the account `Signed in as <email>` and draws errors in the error colour;
  every pending-action button reads `Check again`.
- [ ] Code: the smallest change for each.
