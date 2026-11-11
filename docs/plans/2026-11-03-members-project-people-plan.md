# Members, This project: active people first, the rest under Others — Implementation Plan

> **For agentic workers:** this plan is carried out by the task's Engineer, task by task, test first, as the project's
> instructions (Engineer role) say. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With a project open and "This project" chosen, Members' People lists the people active in that project,
busiest first, and folds everyone else who can read it under "Others (N)", folded by default; "All projects" is unchanged.

**Architecture:** The open project's board already names exactly who can read the project (a private project: its
owner and members) and counts only that project's work in each person's points. A person is active when their score
there is above 0. A pure split in `roster_scope.dart` divides the roster's already sorted people into active and
others; `roster.dart` lists the active ones and adds an "Others (N)" heading that folds as Idle (N) does. Until the
board lands (or when it failed) there are no numbers to split by, so the list stays as it is today.

**Tech Stack:** Flutter 3.47.2 (Desktop; the web app is the same Flutter build), flutter_test widget tests.

**Spec:** Task #2319 brief (Super Tab conversation 5c8e500bb03f6e300f0a9dec), Dee's mockup in it, requested by
dee@autonomous.ai.

```
This project ▾
People
  (K) ken15 👑            38
  (D) dee                 30
  (D) diego                3
  (T) tony                 3
  (P) phamngochuy.1989     2
  Others (2) ▸
Agents
  Idle (1) ▾
    Wren   idle
```

## Global Constraints

- PR body first line: "Requested by dee@autonomous.ai through Harness."
- Harness design language; Dee's look is the merge gate. Screenshots in the PR, light and dark.
- Before Ready: a test that fails without the change for each risk (active/others split, the fold, a private
  project's members), red/green evidence in a PR comment. No backend change: the client already knows who can read
  a private project.
- Desktop tests use a memory store and a fake sign-in; never sign the Mac out of the real CLI.
- Owns: desktop/lib/super_tabs/roster.dart, roster_scope.dart, desktop/test. The phone has no Members scope
  (mobile/lib/swarm has no "This project" choice), so nothing changes there.

## Review Focus

- "All projects" never folds anyone: Others appears only under "This project" with a board of that project.
- The reader themselves with 0 points folds under Others like anyone else (no special case).
- A board still loading or failed: everyone who can read the project is listed as today, no Others heading.
- A private project: a Swarm person who is not a member shows neither in the list nor under Others, opened.
- Others' count and fold survive a board refresh; switching to All projects and back keeps the fold as it was.

---

### Task 1: Active people listed, the rest under a folded Others

**Files:**
- Modify: `desktop/lib/super_tabs/roster_scope.dart` (add the split)
- Modify: `desktop/lib/super_tabs/roster.dart` (`_members`: list active, then the Others heading and rows)
- Test: `desktop/test/super_tab_roster_scope_test.dart`

**Interfaces:**
- Produces: `({List<SuperTabPerson> active, List<SuperTabPerson> others}) splitProjectPeople(List<SuperTabPerson>
  people, Map<String, SuperTabPersonScore> scores)` — keeps the given order; active = `scores[id]?.points ?? 0` > 0.
- Produces: key `ValueKey('super-members-others')` on the "Others (N)" heading (`SuperTabSectionHeading`,
  `startInset: 16`, `collapsed`, `onToggleCollapsed`, as `super-members-idle`).

- [ ] **Step 1: Write the failing tests** in `super_tab_roster_scope_test.dart`:
  - `This project lists the active people busiest first, the rest folded under Others`: board owner 30, dee 12,
    tony 0 (tony can read the project); under This project, owner above dee, tony not shown,
    `Others (1)` shown; tap it: tony shown; tap again: hidden.
  - `All projects folds nobody`: same Swarm, All projects: owner, dee, tony shown, no `super-members-others`.
  - `a private project lists only its members, the idle ones under Others`: openharness private with member dee,
    Swarm has tony too; board names owner 30, dee 0; This project: owner shown, `Others (1)`; opened: dee shown,
    tony never shown.
  - `splitProjectPeople keeps the order and splits on points above 0` (unit test).
- [ ] **Step 2: Run, watch them fail** — `flutter test test/super_tab_roster_scope_test.dart`. Expected: the split
  and private cases FAIL (no `Others` heading; tony/dee listed), All projects passes; the unit test fails to compile
  until the function exists (stub it to return everyone as active first, so it fails on the assertion).
- [ ] **Step 3: Commit the failing tests.**
- [ ] **Step 4: Implement** `splitProjectPeople` and the Others heading in `_members` (only when `scoped != null &&
  board != null`); `_othersOpen` per visit, false at first.
- [ ] **Step 5: Run the file, then the whole `flutter test` and `flutter analyze`.** Expected: all PASS, no issues.
- [ ] **Step 6: Screenshots** — `HARNESS_ROSTER_CAPTURE_DIR=… flutter test test/super_tab_roster_scope_test.dart
  --name 'light and dark'` (with Others folded and opened), attach to the PR.
- [ ] **Step 7: Commit, push, red/green comment.**
