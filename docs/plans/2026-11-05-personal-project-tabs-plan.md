# Personal project tabs (tabs to Personal Swarm, Phase 1): plan

> Way of working: this project's Engineer workflow (test first, one commit for each failing test and one for its
> code, one independent review on the pull request). No subagent-driven development and no execution handoff.

**Goal:** Phase 1 of Huy's migration plan (`docs/plans/2026-11-04-tabs-to-personal-swarm-migration.md`, "fill the gaps,
existing tabs unchanged"), task #3099. A pane started from a Personal project lands in that project's own desk tab,
which every computer links to the same project; a full desk refuses the start before any agent runs; a no-repo pane
joins its project through that tab; a project of panes from several tabs keeps its own split sizes on this computer
only; Personal remembers the tab order it saw. Existing tabs stay exactly as they are.

**Architecture:** all of it is Desktop. `PersonalProjects` (`desktop/lib/super_tabs/personal_projects.dart`) owns the
rules: the project tab id, the link from a tab id back to a project, the room check, placing a pane, keeping the tab's
name, the saved layouts and the order. The Swarm launch (`desktop/lib/super_tabs/launch.dart`) asks it for room in
`prepare` (before the native start) and places the pane after the join in `complete`. `AppNotifier` gains three small
seams: make a desk tab in the background, rename a tab without marking the name the person's, and tell a listener when
the person arranged the panes of a Swarm tab. The desk and its server are unchanged: `project-` plus 24 hex characters
(and `-2`, `-3`) fits `backend/src/lib/desk.ts`'s id rule, so `desk.ts` is not touched.

**Tech Stack:** Flutter/Dart (Desktop), `flutter_test` with the existing `SuperTabLaunchFixture` (memory store, fake
sign-in, fake Swarm server).

**Spec:** the migration plan's Phase 1, items 1 to 5, and the task brief (#3099).

## Global Constraints

- No on/off switch. Rollback is a revert; project tabs already made stay as ordinary tabs.
- Existing tabs, their ids, their project keys (`tab:<id>`) and `super_tab.repos.<account>` entries stay as they are.
- A project's layout and the remembered order are kept in this computer's store only (`super_tab.repos.<account>`),
  never sent to the server or the desk.
- The refusal text is exactly: "Your tabs are full (24). Close a tab to start another agent."
- Tests use a memory store and a fake sign-in; nothing signs the real CLI out.
- Lupine2 changes `personal_projects.dart` in #3073 (task #3042, `hidden()` after `panesFor`): this work keeps its
  additions apart from those lines and rebases on whichever merges first. Project-tab links are read from the
  snapshot, never written into `_known`, so #3073's `hidden()` (which reads `_known`) never hides a project the
  person made.

## Decisions taken where the plan leaves a choice

- **Id:** `project-` + the first 24 hex characters of sha256(`project:<projectId>`); the second and third tabs add
  `-2`, `-3`. The same project id gives the same tab id on every computer.
- **Link:** a tab whose id has that shape belongs to the Personal project whose id hashes to it. Every pane in it joins
  that project, a pane with a repo too: it was started there, and its repo must not get a second project for it
  (Reed's review). If no project of Personal matches (deleted, or not read yet), no project is made for the tab: a
  no-repo pane stays in its tab only, and a repo pane joins its repo's project as in any ordinary tab.
- **Name:** the first tab takes the project's name, the next ones "api 2", "api 3". On each Personal sync a tab whose
  name the person did not choose follows the project's current name. A person's rename (`nameIsCustom`) stays.
- **Room:** a project tab is full at 9 harness panes (`PaneLayoutStore.maxPanes`, the desk's `DESK_MAX_PANES`). With
  no project tab of the project having room and 24 tabs on the desk, `prepare` throws `TABS_FULL` with the message.
  A new project needs a new tab, so it is refused at 24 tabs too. A start already asked for (a retried journal) is
  never refused, and a Product Manager started on a Swarm machine puts no pane here, so it is not checked.
- **Layout:** saved when the person drags the dividers or picks a preset in Personal while it shows a project whose
  panes are not exactly one tab's (where `soleTab` already gives the sizes). Applied when that project is shown again
  with the same number of panes. Removed when the project is gone from Personal.
- **Order:** the project ids in the order their panes first appear across the tabs, kept and extended on each sync
  (`projectOrder`). Phase 1 only remembers it: the PROJECTS list stays A to Z because the round dial swipes projects
  in that order (`superTabSidebarOrder`, cli `cards.ts`); Phase 2 starts the list from it.

## Review Focus

- The refusal happens before the native start: no `agents_create` (or equivalent) is sent when the desk is full.
- No project is ever created for a project tab, on any computer.
- The layout never leaves the computer: not in a server request, not in a desk op.
- Ordinary tabs and their projects are unchanged (existing tests stay green).

## Tasks

### Task 1: the project tab id and its link back to a project

**Files:** `desktop/lib/super_tabs/personal_projects.dart`, `desktop/test/personal_project_tabs_test.dart` (new).

**Interfaces:** `String personalProjectTabId(String projectId, [int number = 1])`;
`({String base, int number})? personalProjectTabParts(String tabId)`;
`SuperTabProject? PersonalProjects.projectOfTab(SuperTabController c, String tabId)`.

- [ ] Failing test: two computers (two fixtures) with the same project id compute the same id; it matches the desk
  id rule; `-2`/`-3` parse back; an ordinary tab id does not parse.
- [ ] Failing test: a no-repo pane in a project tab is shown by that project's `panesFor`, and `sync` creates no
  project for it; on a second computer the same.
- [ ] Code.

### Task 2: room on the desk, and the refusal before any agent runs

**Files:** `personal_projects.dart`, `desktop/lib/super_tabs/launch.dart`, `desktop/lib/state/app_state.dart`
(`deskTabCount`), the new test file.

**Interfaces:** `const kTabsFullMessage`; `String? PersonalProjects.projectTabRefusal(String? projectId)`.

- [ ] Failing test: with 24 desk tabs and no project tab with room, submitting New Harness from a Personal project
  fails with the message and no native start is asked for; with a project tab holding 8 panes it goes ahead; a
  Swarm that is not Personal is never refused.
- [ ] Code.

### Task 3: placing the started pane in the project's tab

**Files:** `personal_projects.dart`, `launch.dart`, `app_state.dart` (`ensureBackgroundTab`), the new test file.

**Interfaces:** `Future<void> PersonalProjects.placeInProjectTab(SuperTabController c, String projectId, String
machineId, String agentId)`.

- [ ] Failing test: after a start from a Personal project the pane is in tab `project-…` named after the project,
  which is on the desk projection; a 10th pane goes to "api 2" (`-2`); the active tab does not change.
- [ ] Code.

### Task 4: the tab follows the project's renames, unless the person renamed it

**Files:** `personal_projects.dart`, `app_state.dart` (`setTabNameAutomatic`), the new test file.

- [ ] Failing test: the project renamed on the server renames its tab (and "api 2") on the next sync; a tab the
  person renamed keeps its name.
- [ ] Code.

### Task 5: a project's own layout, on this computer only

**Files:** `personal_projects.dart`, `desktop/lib/super_tabs/workspace.dart`, `app_state.dart` (arranged listener),
the new test file.

**Interfaces:** `void PersonalProjects.rememberLayout(SuperTabController c, String conversationId, Swarm view)`;
`bool PersonalProjects.applyLayout(SuperTabController c, String conversationId, Swarm view)`.

- [ ] Failing test: arranging a project of panes from two tabs saves its sizes in `super_tab.repos.<account>`;
  showing another project and coming back restores them; no server post and no desk op carries them.
- [ ] Code.

### Task 6: Personal remembers the tab order it saw

**Files:** `personal_projects.dart`, the new test file.

**Interfaces:** `List<String> PersonalProjects.projectOrder(SuperTabController c)`.

- [ ] Failing test: projects come in the order their panes first appear in the tabs, survive a reload from the store,
  and a later reorder of tabs appends only new projects.
- [ ] Code.

### Task 7: evidence

- [ ] Run the new test file, `super_tab_personal_projects_test.dart`, `super_tab_launch_test.dart`, the desk tests
  (`desk_sync_test.dart`, `shared_tabs_desk_test.dart`) and the guard tests; `flutter analyze` on the changed files.
- [ ] Light and dark screenshots of a project tab beside an ordinary tab and of the refusal, sent to Huy.
- [ ] Red/green evidence in a pull request comment.

## Design

- Growth: one desk tab per Personal project that started a pane (two or three past 9 panes), closed by the person like
  any tab; one saved layout and one order entry per Personal project on each computer, deleted when the project is gone.
- Concurrency: desk changes go through the desk's existing idempotent ops (`tab.create` of an id already there changes
  nothing), so two computers placing at once make one tab. Local store writes are per account, as today.
- Read cost: nothing new is read; the link hashes the projects the Personal snapshot already holds.
- Scale: the desk's 24 tabs is reached first; the refusal names it and is logged by its code (`TABS_FULL`). A product
  measure of refusals needs a new flow in the shared measurement vocabulary (backend and phone), proposed separately
  rather than built here.
- Compatibility: older Desktops, the phone and the web read a project tab as an ordinary desk tab. An older Desktop
  maps its no-repo panes to a `tab:` project as today (one stray project there, until it updates).
- Migration and rollback: no data migrated; a revert leaves project tabs as ordinary tabs.
- Audience: the desk is the person's own document; the tab adds only a hashed project id. Layouts and order stay on
  the computer.
- Identity: Personal belongs to the signed-in account (`eligible`), never the machine owner's login.
- Failure: a full desk is refused with the message before the start; a failed tab placement leaves the agent in its
  project's Swarm view and is logged by its code.
- Platforms: Desktop on macOS, Windows and Linux; nothing platform-specific.
