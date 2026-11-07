# Desktop v3 UX fixes from the review: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** Task #4220 (anh Dee's Buddy's review of main 0413586e, 2026-11-07 06:45 VN, "verify each before fixing"): fix the
eight Desktop v3 findings, each checked against the code first.

**Architecture:** Delta to what the Desktop already shows; no new screen, setting or server change. Everything is in
`desktop/lib/super_tabs/`.

**Tech Stack:** Dart and Flutter widget tests on the fake Swarm of `test/support/super_tab_fixture.dart`; light and dark
pictures by `test/super_tab_v3_left_shots_test.dart`.

**Spec:** Task #4220's brief; the Swarm v3 left pane (#4118, #4192: `2026-11-07-desktop-left-pane-cleanup-plan.md`).

## Verification (main d1f33f5c)

Each finding was read in the code before planning. All eight are real:

1. **Clicking a project highlights Buddy.** `view.dart _openBoard` puts the project's Board in the middle and selects the
   Buddy chat for the right side (`_showBuddy`). The sidebar highlights by `controller.selectedId`, so the Buddy row lights
   and the project's does not.
2. **Tags are invisible in collapsed Projects.** `project_sidebar.dart` drops every project row while Projects is folded
   (closed by default once the person has an agent), and the Desktop has no Mentions row, so a tag in a project chat shows
   nowhere.
3. **Tasks vanishes on Decisions, Leaderboard and Manage.** `view.dart _swarm`: a page or Manage turns `boardLayout` off, and
   the Tasks pane is drawn only in `boardLayout`.
4. **Tasks stays locked after a failed change.** `tasks/personal_tasks_pane.dart _send`: when the server refuses a change
   (4xx) the controller drops it, but the pane keeps `_action`, so every control stays disabled, it says "not confirmed", and
   its Retry sends the refused change again.
5. **Leaderboard blanks on each refresh.** `leaderboard/weekly_page.dart _refresh` sets the board to null on every
   `lastChangedAt`, though only an audience change (another Swarm, access gone, the project set) needs it cleared.
6. **'Connect this computer' is a dead end.** `join/new_agent_dialog.dart` (renamed `bring_agent.dart` by #4196, which keeps
   this box) says to wait and try again, with only Close.
7. **Older idle agents are dead rows.** An agent made before v3's own agent chats (#4116) has no `chatId`; with no open task
   `superTabAgentChat` is null and its My agents row does nothing.
8. **My agents shows no status.** `buddy_rows.dart` draws `status` only beside `detail`; My agents rows have no detail.

## Mockup

```
 +---------------------------+
 | [ Company v ]             |
 | Decisions                 |
 | Leaderboard               |
 |                           |
 | v My agents               |
 | (B) Buddy              ○  |  8: quiet status dot at the row's end
 | (A) Kestrel            ⠋  |     (working spins, idle ○, offline ×)
 | (A) Fir                ○  |  7: no chat: opens its terminal
 |  +  New agent             |
 |                           |
 | > Projects            [+] |  folded
 | # openharness         (2) |  2: a project that tags you stays listed
 |---------------------------|
 | Manage                    |
 +---------------------------+
 1: clicking # openharness highlights # openharness (its Board), not Buddy.
 3: Decisions / Leaderboard / Manage in the middle, Tasks stays on the right.
 4: a refused Tasks change says the server's reason, with no Retry; the controls work again.
 5: the Leaderboard keeps its rows while it refreshes.
 6: "Connect this computer" waits for the connection and goes on by itself; Open Machines when it needs a link.
```

## Global Constraints

- Owns `desktop/lib/super_tabs/` only. #4196 (Cmd-N, renames `join/new_agent_dialog.dart`), #4204 (Tasks cards, `view.dart`
  right pane and `_middleChat`) and #4191 (Tasks pane background) own nearby code: keep each change small and rebase on
  whichever merges first.
- No new setting or switch; no new runtime dependency.
- Never read or print a secret or a login.
- Test first: each task's failing test is committed before its code.

## Review Focus

- A project chat that tags the reader while Projects is folded and the unread filter is on: still listed (Task 2 test).
- A Tasks change that fails without an answer (network): stays pending with Retry, as before (Task 4 test).
- A Leaderboard refresh that fails: keeps the last rows and says why (Task 5 test).
- A page opened with a thread open: the thread keeps the right side, as before (Task 3 test).
- The Buddy chat opened from My agents while a Board was open: the Buddy row is highlighted again (Task 1 test).

---

### Task 1: the open Board's project is the highlighted row

**Files:** Modify `desktop/lib/super_tabs/project_sidebar.dart`, `desktop/lib/super_tabs/view.dart`;
Test `desktop/test/super_tab_v3_ux_fixes_test.dart`.

**Interfaces:** Produces `ProjectSidebar({String? boardProjectId})`: the project whose Board holds the middle. On the Desktop
(`board`), while it is set, that project's row is highlighted and no My agents row is.

- [ ] Test `a project's row is highlighted while its Board is open, not the Buddy`: with `boardProjectId: 'lead'` and the
      Buddy chat selected, the project row's surface is selected and `super-swarm-buddy`'s Semantics is not; with
      `boardProjectId: null` and the Buddy chat selected, the Buddy row is.
- [ ] Run it: FAIL (no `boardProjectId`).
- [ ] Add `boardProjectId`; `view.dart _sidebar` passes the Board shown (`_boardProjectId` while the board layout holds it).
- [ ] Run it: PASS. Commit.

### Task 2: folded Projects keeps the projects that tag you

**Files:** Modify `desktop/lib/super_tabs/project_sidebar.dart`; Test `desktop/test/super_tab_v3_ux_fixes_test.dart`.

- [ ] Test `folded Projects still lists a project whose chat tags you, with its number`: a tag of the reader in `lead`'s chat,
      Projects folded: `super-project-lead` and its `SuperTabCountBadge` show; a project with no tag does not.
- [ ] Run it: FAIL. Implement: while folded, `_channels` keeps a project whose chat tags the reader
      (`attention.chatTagsIn(lead) > 0`). Run it: PASS. Commit.

### Task 3: Tasks stays on the right under Decisions, Leaderboard and Manage

**Files:** Modify `desktop/lib/super_tabs/view.dart`; Test `desktop/test/super_tab_v3_ux_fixes_test.dart`.

- [ ] Test `the Tasks pane stays while Decisions, the Leaderboard or Manage holds the middle`: `SuperTabView(board: true)`
      with personal Tasks supported; tap `super-decisions`, `super-leaderboard`, `super-manage` in turn: each time
      `SuperTabPersonalTasksPane` is found.
- [ ] Run it: FAIL. Implement: on the Desktop with the Tasks pane, the right side is the Tasks pane whenever no thread or
      Members holds it, at the board's fixed width. Run it: PASS. Commit.

### Task 4: a refused Tasks change unlocks Tasks and says why

**Files:** Modify `desktop/lib/super_tabs/tasks/personal_tasks_pane.dart`; Test `desktop/test/super_tab_v3_ux_fixes_test.dart`.

- [ ] Test `a refused change says the server's reason and Tasks works again`: the server refuses `member.approvalMode` with
      403; the pane shows the server's sentence, no Retry, and the mode menu is enabled again.
- [ ] Test `a change with no answer keeps Retry`: the request throws; "not confirmed" and Retry show, as before.
- [ ] Run them: the first FAILS. Implement: after a failed `_send`, when the controller no longer holds a pending command,
      clear `_action`/`_operationId` and show `operationError`; Retry only while one is pending. Run: PASS. Commit.

### Task 5: the Leaderboard keeps its rows while it refreshes

**Files:** Modify `desktop/lib/super_tabs/leaderboard/weekly_page.dart`; Test `desktop/test/super_tab_v3_ux_fixes_test.dart`.

- [ ] Test `a change in the Swarm refreshes the board without blanking it`: board shown; a change moves `lastChangedAt` while
      the next read is held: the rows stay; the new read replaces them.
- [ ] Run it: FAIL. Implement: `_refresh` clears the board only when the audience changes (access, the project set, another
      controller). Run it: PASS. Commit.

### Task 6: 'Connect this computer' waits and goes on

**Files:** Modify `desktop/lib/super_tabs/join/new_agent_dialog.dart`; Test `desktop/test/super_tab_v3_ux_fixes_test.dart`.

- [ ] Test `with this computer not connected yet, the box waits and goes on once it connects`: no local machine; the box shows
      "Connecting this computer…"; the local machine connects; the box closes and the agent form opens.
- [ ] Test `a computer that needs its link offers Open Machines`: tapping it closes the box and asks the app for Machines.
- [ ] Run them: FAIL. Implement the box as a listener on the app with Cancel and Open Machines (`app.requestMachines`).
      Run: PASS. Commit.

### Task 7: an agent with no chat opens its terminal

**Files:** Modify `desktop/lib/super_tabs/project_sidebar.dart`, `desktop/lib/super_tabs/view.dart`;
Test `desktop/test/super_tab_v3_left_test.dart` (its "no chat yet opens nothing" test becomes this one).

**Interfaces:** Produces `ProjectSidebar({ValueChanged<SuperTabAgent>? onOpenAgentTerminal})`.

- [ ] Test `an agent with no chat opens its terminal`: Kestrel with no task: tapping it calls `onOpenAgentTerminal(kestrel)`.
- [ ] Run it: FAIL. Implement; `view.dart` passes `widget.onChooseAgentTerminal ?? widget.onOpenTerminal`. Run: PASS. Commit.

### Task 8: My agents rows show a quiet status dot

**Files:** Modify `desktop/lib/super_tabs/buddy_rows.dart`; Test `desktop/test/super_tab_v3_left_test.dart`;
pictures `desktop/test/super_tab_v3_left_shots_test.dart`.

- [ ] Test `each agent row shows its status at the end`: `super-agent-kestrel` contains an `ActivityMark`.
- [ ] Run it: FAIL. Implement: with no `detail`, `SuperTabBuddyRow` draws `status` at the row's end. Run: PASS.
- [ ] Shots: light and dark of the left pane with a folded Projects listing a tagged project. Commit.
