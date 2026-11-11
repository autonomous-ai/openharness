# Private project: add people from the People panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project owner adds Swarm people to a private project from the roster's This project ▸ People "+", through a picker (mockup option B).

**Architecture:** Desktop only. A new file `desktop/lib/super_tabs/project_add_people.dart` has a pure list builder and the picker dialog. The dialog sends the existing `project.sharing` command with the live member list plus the ticked ids. `roster.dart` points the People "+" at it under the spec's four conditions.

**Tech Stack:** Flutter/Dart (desktop), flutter_test widget tests with the `ConversationServer` fixture.

**Spec:** `docs/specs/2026-11-04-private-project-add-people.md`

## Global Constraints

- Copy, verbatim: tooltip "Add people to this project"; title "Add people to <project name>"; search placeholder "Search people in this Swarm"; sections "Not in this project" and "Already in"; owner mark "Project owner"; empty "Everyone in this Swarm is in this project."; no match "No one matches"; buttons "Cancel" and "Add 1 person" / "Add N people".
- Command, exactly: `{'type': 'project.sharing', 'projectId': id, 'visibility': 'private', 'memberIds': [...]}`. No backend change.
- `memberIds` = live snapshot `memberIds` at Add time ∪ ticked ids that are still Swarm people, minus the owner, no duplicates.
- The "+" is the picker only when: the scope is This project with a readable open project (`scoped != null`), `scoped.isPrivate`, `scoped.ownerId == c.accountId`, and `c.canWrite`. Otherwise the heading behaves exactly as today.
- Desktop only (desktop/lib). Nothing in mobile/, web, backend or cli.

## Review Focus

1. A member added from another device while the picker is open is kept, because Add reads the live snapshot (Task 2 test "keeps a member added since the dialog opened").
2. A refused Add (PROJECT_OWNER_REQUIRED or a 200-cap error) keeps the dialog open with the ticks and shows the error (Task 2 test "a refused Add stays open with its error").
3. Search with spaces or capital letters still matches (Task 1 test "search ignores case and surrounding spaces").
4. A ticked person who left the Swarm before Add is not sent (Task 2 test "drops a ticked person who left the Swarm").
5. A non-owner, or a public project, never gets the picker, and keeps today's "+" (Task 3 tests).

---

### Task 1: The picker's lists

**Files:**
- Create: `desktop/lib/super_tabs/project_add_people.dart`
- Test: `desktop/test/super_tab_project_add_people_test.dart`

**Interfaces:**
- Produces: `({List<SuperTabPerson> addable, List<SuperTabPerson> inProject}) projectPeopleLists(List<SuperTabPerson> people, SuperTabProject project, String query)`, and `String projectPersonName(SuperTabPerson p)` (`p.name ?? p.username`).

- [ ] **Step 1: Write the failing tests** (`group('projectPeopleLists')`), with people built through `SuperTabPerson.fromJson` and a project through `SuperTabProject.fromJson` (owner `owner`, members `[dee]`, private), Swarm people owner, dee, tony, Ana (`name: 'Ana'`):
  - "splits the Swarm into who can be added and who is in": `addable` ids `['Ana' person, 'tony']` sorted by `projectPersonName` case-insensitively; `inProject` ids `['owner', 'dee']`, owner first.
  - "search ignores case and surrounding spaces": query `'  TON '` gives `addable` `[tony]` and `inProject` `[]`. Query `'example.com'` matches by email.
  - "no one to add": with every person a member, `addable` is empty.
- [ ] **Step 2: Run** `cd desktop && flutter test test/super_tab_project_add_people_test.dart`. Expected: FAIL, `projectPeopleLists` is not defined.
- [ ] **Step 3: Implement** both functions in `project_add_people.dart`. The query is trimmed and lowercased, and matched as a substring of `name`, `username` and `email`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git add desktop/lib/super_tabs/project_add_people.dart desktop/test/super_tab_project_add_people_test.dart && git commit -m "Desktop: the lists of a private project's Add people picker"`

### Task 2: The picker dialog

**Files:**
- Modify: `desktop/lib/super_tabs/project_add_people.dart`
- Test: `desktop/test/super_tab_project_add_people_test.dart`

**Interfaces:**
- Consumes: `projectPeopleLists`, `projectPersonName` (Task 1); `SuperTabController.command(Map)` returns null on failure and sets `operationError`.
- Produces: `Future<void> showProjectAddPeople(BuildContext context, SuperTabController c, SuperTabProject project)`. Widget keys: `ValueKey('project-add-search')`, `ValueKey('project-add-person-<id>')` (each checkbox row), `ValueKey('project-add-confirm')`.

- [ ] **Step 1: Write the failing widget tests** (`group('showProjectAddPeople')`). Pump a `MaterialApp` with a button that calls `showProjectAddPeople(context, controller, project)` for a `ConversationServer` whose `lead` project is private, owner `owner`, members `[{'id':'dee'}]`, with people dee and tony added (as `super_tab_roster_scope_test.dart` `swarm()` does):
  - "lists who can be added and who is in": finds the "Add people to <name>" title, `project-add-person-tony`, no `project-add-person-dee`, and the text "Project owner". `project-add-confirm` is disabled.
  - "ticking tony and Add sends project.sharing and closes": after the tap on Add, the server's `lead` project `members` ids are `['dee', 'tony']`, `visibility` is `'private'`, and the dialog is gone. The button read "Add 1 person" before the tap.
  - "keeps a member added since the dialog opened": with the dialog open, set the server project's members to dee and ana, add person ana, `await controller.refresh()`, tick tony, Add. Expect members `{dee, ana, tony}`.
  - "drops a ticked person who left the Swarm": tick tony, remove tony from `server.state['people']`, refresh, Add. Expect members `['dee']`.
  - "a refused Add stays open with its error": set `server.refuse = {'code': 'PROJECT_OWNER_REQUIRED', 'message': 'Only the project owner can manage this project.'}`, tick, Add. Expect the dialog still shown, that message shown, and tony's checkbox still ticked.
  - "search narrows both lists, and an empty match says so": type `'zzz'` in `project-add-search`. Expect "No one matches". With every person a member, expect "Everyone in this Swarm is in this project.".
- [ ] **Step 2: Run** `cd desktop && flutter test test/super_tab_project_add_people_test.dart`. Expected: FAIL, `showProjectAddPeople` is not defined.
- [ ] **Step 3: Implement** `showProjectAddPeople` with `showAppDialog` and `SuperTabDialogScope(controller: c, projectId: project.id, requireWrite: true)`, laid out like the Sharing dialog in `project_options.dart` (`AlertDialog`, width 400, `CheckboxListTile` rows, `DesktopChrome` text styles). Rebuild from `c` (`ListenableBuilder`) so the lists follow the live snapshot. On Add, set busy, then read the live project (`c.snapshot?.projects` by id) and the live people, build `memberIds` per Global Constraints, `await c.command(...)`, pop on non-null, else clear busy. The button label is "Add 1 person" for one tick, "Add N people" otherwise.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `git add desktop/lib/super_tabs/project_add_people.dart desktop/test/super_tab_project_add_people_test.dart && git commit -m "Desktop: Add people picker for a private project"`

### Task 3: The People "+" opens it

**Files:**
- Modify: `desktop/lib/super_tabs/roster.dart:621-625` (People `SuperTabSectionHeading`)
- Test: `desktop/test/super_tab_roster_scope_test.dart`

**Interfaces:**
- Consumes: `showProjectAddPeople` (Task 2); `scoped` (roster.dart:513), `c.accountId`, `c.canWrite`, `c.isOwner`, `widget.onInvite`.

- [ ] **Step 1: Write the failing tests** in `super_tab_roster_scope_test.dart`, using `swarm(tester, board: false)` with the `lead` project made private with members `[{'id':'dee'}]`, then `choose(tester, 'This project')`:
  - "the project owner adds people to a private project from People's +": the tooltip "Add people to this project" exists. Tapping it shows "Add people to openharness" (the fixture project's name). Tick `project-add-person-tony`, tap `project-add-confirm`, and after `pumpAndSettle` `person('tony')` is found.
  - "a public project keeps the Swarm invite on People's +": with the project public, the tooltip is "Invite people", and tapping it calls the fixture's invite callback.
  - "someone who does not own the private project gets no picker": with the fixture on account `dee` (`RosterFixture(account: 'dee')`, or the existing way the file switches account), "Add people to this project" is not found.
- [ ] **Step 2: Run** `cd desktop && flutter test test/super_tab_roster_scope_test.dart`. Expected: the first test FAILs (no such tooltip). The other two pass already, which pins today's behaviour.
- [ ] **Step 3: Implement** in the People heading: `final addsToProject = scoped != null && scoped.isPrivate && scoped.ownerId == c.accountId && c.canWrite;` then `onAdd: addsToProject ? () => unawaited(showProjectAddPeople(context, c, scoped)) : c.isOwner ? widget.onInvite : null`, and `addTooltip: addsToProject ? 'Add people to this project' : 'Invite people'`.
- [ ] **Step 4: Run** `cd desktop && flutter test test/super_tab_roster_scope_test.dart test/super_tab_roster_test.dart test/super_tab_project_add_people_test.dart && flutter analyze lib/super_tabs/project_add_people.dart lib/super_tabs/roster.dart`. Expected: all pass, and analyze shows no issue in these two files.
- [ ] **Step 5: Commit** `git add desktop/lib/super_tabs/roster.dart desktop/test/super_tab_roster_scope_test.dart && git commit -m "Desktop: a private project's People + adds people to it (Diego)"`
