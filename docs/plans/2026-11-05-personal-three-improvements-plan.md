# Three Personal improvements Implementation Plan

> This plan follows the project's own way of working (project instructions, Engineer): each plan task commits its
> failing test before its code, and the pull request's one review step is the independent review. There is no
> execution handoff; the Engineer implements it.

**Goal:** Huy's three Personal asks (11-05, task #3042, mockup okayed in the main chat): (1) on Desktop, a Personal
project whose panes are all closed leaves the project list, its chat kept, and comes back when a pane of it opens;
(2) the phone's Start Lead picks what Desktop's Start Lead card picks, the picker still there to change it, and with
none of the person's computers online its button reads "Open Harness on your Mac to start"; (3) on Desktop, a machine
of theirs that hasn't joined Personal says why on its own row, in a few words, with Try again.

**Architecture:** All three are client-side; no backend change and no new stored data.
(1) `PersonalProjects` (desktop `super_tabs/personal_projects.dart`) already works out which of the person's panes
belong to which Personal project (`panesFor`). A new `hidden(c, projectId)` says a pane project with none of their
panes now is hidden; `ProjectSidebar` leaves it out (unless it is the chat open now, as the unread filter keeps it).
Nothing is deleted on the server, so its chat is there when the project shows again. While a machine holding one of
their panes has not listed its agents yet (just launched, reconnecting), no project hides: which project such a pane
belongs to isn't known yet.
(2) River ruled (11-05) to keep the phone's direct start (#3029): it needs only the computer on, not Harness open.
`swarmLeadPlan` (mobile `swarm/swarm_lead_start.dart`) picks as Desktop's `planFor` does: a computer holding the
project's repo, else the person's computer; engine Claude Code, else Codex; Claude at Opus xhigh (already the same).
Where Desktop prefers "this computer", the phone prefers the computer the person used last (its most recently opened
agent), the closest it can know. A repo is read as Desktop reads it: `repository` (an SSH alias's real repo, #2476)
before `remote`. With no computer online the card shows the disabled button "Open Harness on your Mac to start".
(3) `PersonalMachines.waiting` (desktop `super_tabs/personal_machines.dart`) gives each row a short reason ("machine
is off", "not signed in to Harness", "needs a Harness update", "no Claude Code or Codex", "not answering", "still
setting up"; a failure none of these fits reads just "Couldn't join") and `retry(c, machineId)` drops the machine's
wait and syncs again (an offline one has the machines reconnected first). `PersonalMachineRows` draws
"name · Couldn't join: reason [Try again]", the full reason on hover; a machine being asked reads "Adding", with no
Try again.

**Tech Stack:** Flutter (desktop/ and mobile/), widget tests with the existing fixtures
(`desktop/test/super_tab_personal_projects_test.dart`, `desktop/test/super_tab_swarm_switcher_test.dart`,
`mobile/test/swarm/swarm_lead_start_*`), screenshots through each suite's capture helpers in light and dark.

**Spec:** Swarm task #3042's brief and River's ruling on part 2 (11-05), quoted in the pull request.

## Design

- growth: nothing new is stored. Hiding is worked out from the panes on each read; the phone's pick from what it reads.
- concurrency: N/A because nothing new is written; Try again runs through the existing one-at-a-time sync.
- read cost: `hidden` walks the person's panes once per project row, as `panesFor` already does for the terminals
  count. No new request.
- scale: 10x panes or projects is 10x a walk over in-memory lists; the sidebar's build time warns first.
- compatibility: client-only; old and new clients read the same Swarm. Another client still lists a hidden project.
- migration + rollback: none; reverting the change shows every project again.
- audience: N/A because nothing is exposed; the server's rules are unchanged.
- identity: N/A because no machine or login changes hands.
- failure: a machine that can't join says why on its row; a project is never hidden while its panes' machine hasn't
  answered; the phone with no computer online says to open Harness.
- platforms: Desktop macOS/Linux/Windows and web share the sidebar and rows; the phone on iOS/Android.

## Global Constraints

- Not view-only panes, not team-project linking (brief). Only the person's own Personal Swarm (`eligible`).
- A hidden project keeps its chat: nothing is archived or deleted; only Desktop's list leaves it out.
- Few words (Naming System, design docs); the app's tokens only, no new numeric colours or radii.
- Never run a test that signs the Mac out of the real CLI; Desktop tests use a memory store and a fake sign-in.
- Temp files only in `mktemp -d` folders.

## Review Focus

- A project never hides because its panes' machine is still loading, and never while it is the open chat.
- Hiding is per Personal pane project only: a project the person made by hand (no panes ever) stays listed.
- Try again on a waiting machine asks again at once, once, whatever its back-off wait; it never adds a machine the
  person took out.
- The phone's default computer and folder match Desktop's for the same desk; a pick still overrides.

---

### Task 1: A Personal project with no panes leaves the list

**Files:**
- Modify: `desktop/lib/super_tabs/personal_projects.dart`, `desktop/lib/super_tabs/project_sidebar.dart`
- Test: `desktop/test/super_tab_personal_projects_test.dart`

**Interfaces:**
- Produces: `bool PersonalProjects.hidden(SuperTabController c, String projectId)`.

- [x] Failing test: closing every pane of a repo hides its project from the sidebar; reopening a pane shows it with
  its chat's messages; a project shows while its machine hasn't listed agents; the open chat stays listed; a project
  made by hand stays listed.
- [x] Implement `hidden` and the sidebar filter; run the file's tests.

### Task 2: The phone's Start Lead picks what Desktop's card picks

**Files:**
- Modify: `mobile/lib/swarm/swarm_lead_start.dart`, `mobile/lib/swarm/swarm_computers.dart`,
  `mobile/lib/swarm/swarm_lead_start_card.dart`, `mobile/lib/core/models.dart` (`AgentProject.repository`)
- Test: `mobile/test/swarm/swarm_lead_start_test.dart`, `swarm_lead_start_card_test.dart`,
  `swarm_lead_computers_test.dart`

**Interfaces:**
- Changes: `SwarmLeadComputer` gains `DateTime? lastUsed`.

- [ ] Failing tests: the default computer holds the repo, the last used first among several; with no repo, the last
  used computer; a folder found through `repository`; no computer online shows "Open Harness on your Mac to start",
  disabled.
- [ ] Implement; run the three files.

### Task 3: A machine that hasn't joined says why, with Try again

**Files:**
- Modify: `desktop/lib/super_tabs/personal_machines.dart`, `desktop/lib/super_tabs/personal_machine_rows.dart`
- Test: `desktop/test/super_tab_swarm_switcher_test.dart`

**Interfaces:**
- Changes: `PersonalMachineRow.status` becomes the few-word reason and gains `canRetry`;
  `Future<void> PersonalMachines.retry(c, machineId)`.

- [ ] Failing tests: an offline row reads "Couldn't join: machine is off" with Try again; a refusal reads its short
  reason with the full one on hover; Try again asks again at once inside the wait and the row goes once it joined.
- [ ] Implement; run the file's tests.

### Task 4: Pictures

- [ ] Light and dark screenshots of the sidebar before and after closing panes, the phone card's offline state, and
  the machine rows, sent to Huy in the task.
