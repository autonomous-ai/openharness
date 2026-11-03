# New session remembers its project Implementation Plan

> **How this plan runs:** by this project's instructions (Engineer role): implemented task by task, test first (the
> failing test committed and watched failing, then the code); the pull request's Review step is the one independent
> review. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The "Where this session works" menu beside New session starts on the project the reader chose there last
time on this device, also after a restart; All projects is remembered too; a project the reader can no longer read is
never used.

**Architecture:** The choice joins the controller's saved view (`SuperTabController._localState` and its `initial`
restore), which is already per device, per account and per Swarm and survives a restart. The view reads it instead of
its per-chat map, and the existing readable-project check (`_chosenSessionProject`, security review 1 of #2437) stays
the only way it reaches a send.

**Tech Stack:** Flutter (Desktop and web share `desktop/lib/super_tabs`), widget tests with the conversation fixture.

**Spec:** task #2347's brief (Scholes, 2026-11-03).

## Global Constraints

- No visible change besides the menu's starting value. Harness design language.
- Out: syncing across devices or accounts, the phone app.
- PR body first line: "Requested by scholes@autonomous.ai through Harness."
- Desktop tests use a memory store and a fake sign-in; never the real CLI sign-out.

## Review Focus

1. A remembered project the reader lost (deleted or access gone) is shown as All projects and never sent. Test in Task 1.
2. A remembered project from another Swarm or account never applies: the saved view is per account and Swarm already
   (`initial['tabId']`, `initial['accountId']`). Test in Task 1.
3. Choosing All projects after a project replaces the remembered project. Test in Task 1.
4. Sending a New session keeps the choice (it no longer resets to All projects after a send). Test in Task 1.

---

### Task 1: Remember the session project in the controller's saved view

**Files:**
- Modify: `desktop/lib/super_tabs/controller.dart` (field, restore, `_localState`, `chooseSessionProject`)
- Modify: `desktop/lib/super_tabs/view.dart` (`_chatSessionProject`, `_chosenSessionProject`, send)
- Test: `desktop/test/super_tab_session_project_memory_test.dart`

**Interfaces:**
- Produces: `String SuperTabController.sessionProjectId` (`''` = All projects, the default);
  `void SuperTabController.chooseSessionProject(String projectId)` (saves soon, notifies); saved as
  `'sessionProjectId'`.

- [ ] **Step 1: Failing widget tests:** choose Pilot, send a New session, turn New session on again → the menu's
  value is Pilot and the send carries `sessionProjectId: 'pilot'`; a new controller built from the first one's saved
  view (restart) → Pilot preselected; choose All projects, restart → All projects; the remembered project removed
  from the reader's projects → All projects shown and no `sessionProjectId` sent; a saved view of another Swarm → All
  projects.
- [ ] **Step 2:** `flutter test test/super_tab_session_project_memory_test.dart` → FAIL.
- [ ] **Step 3:** Implement as the Interfaces say; drop `_chatSessionProjects`.
- [ ] **Step 4:** PASS; run `super_tab_one_buddy_test.dart`, `super_tab_one_buddy_shots_test.dart`, `flutter analyze`
  on the changed files, `python3 scripts/check-ui-style.py --only desktop/lib/super_tabs`.
- [ ] **Step 5:** Commit test, then code; screenshot of the menu preselected after a restart for the PR.
