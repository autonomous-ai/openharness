# Tasks pane tells the truth Implementation Plan

> Written by the writing-plans way of working; the Engineer implements it task by task, each failing test first.

**Goal:** Fix findings 3, 4 and 17 of the Desktop 1.3.89 audit (#4436): a refused Approve or Reject never locks the
Tasks pane, every task shows its own status, and a rejected task shows why.

**Architecture:** The controller already drops an action the server refused (a 4xx other than 408 and 429) and keeps
one whose answer was lost. The pane keeps its own copy of the action, which is what locks every card; it now drops that
copy on a refusal, says the server's sentence and reads the task again, keeping Retry for a lost answer only. The status
words and marks come from one mapping in `personal_task_card.dart`, used by the card and the task header; it names every
backend status. The rejection reason the row already carries is shown in the header and on the mark's hover.

**Tech Stack:** Flutter (Desktop), widget tests with a memory store and a fake sign-in.

**Spec:** `docs/audits/2026-11-07-desktop-1.3.89.md` on PR #3526, findings 3, 4 and 17 and their proposed tasks.

## Global Constraints

- Desktop only (`desktop/lib/`); no server change is needed: the backend already sends the refusal's sentence, every
  status and the reason (`backend/src/superTabs/read/personalTasks.ts`).
- Reuse existing components and styles; change only what the findings name.
- Words follow the backend's status labels (`STATUS_LABELS` in `backend/src/superTabs/model.ts`): Ready for review,
  Planned, Cancelled, Stuck, Done.
- Desktop tests use a memory store and a fake sign-in. Light and dark screenshots for each finding.
- Platforms: shared Flutter code, so macOS, Windows and Linux alike; tested offscreen on macOS.

## Review Focus

- A refusal of the approval mode menu (not a card) unlocks the same way: same `_send` path, covered by the 403 test.
- An Update-required refusal says "Update Harness to change Tasks." with no Retry.
- A refusal after a Retry of a lost answer unlocks too, rather than offering Retry again.
- A status the backend adds later reads "Status unavailable", never "Starting".
- A long rejection reason wraps in the header instead of overflowing.

---

### Task 1: A refused Approve unlocks the pane and says why (finding 3)

**Files:**
- Modify: `desktop/lib/super_tabs/tasks/personal_tasks_pane.dart` (`_send`, the error block)
- Test: `desktop/test/super_tab_personal_tasks_pane_test.dart`

**Interfaces:**
- Consumes: `SuperTabController.hasPendingAction`, `takeOperationError()`, `operationErrorCode`, `refresh()`.

- [ ] **Step 1: Write the failing tests** — the fixture gets `Object? refusal`, thrown from a POST, and counts change
  reads. For a 409 `SuperTabFailure('CONFLICT', 'The suggested agent changed. Read the task again.', statusCode: 409)`
  and a 403 `FORBIDDEN`: after Approve the sentence shows, `Retry` is absent, the other card's Approve is enabled, a
  second read happened, and a second Approve sends a new command. A refusal after a Retry of a lost answer unlocks too.
- [ ] **Step 2: Run** `flutter test test/super_tab_personal_tasks_pane_test.dart` — the new tests FAIL (the generic
  "not confirmed" text, Retry shown, buttons disabled).
- [ ] **Step 3: Implement** — after `command`/`retry` returns null: when `owner.hasPendingAction` the answer was lost
  (keep the action, the "not confirmed" text and Retry); otherwise drop `_action` and `_operationId`, show
  "Update Harness to change Tasks." for `UPDATE_REQUIRED` or else `owner.takeOperationError()`, and
  `unawaited(owner.refresh())`. Retry shows only while `_action != null`.
- [ ] **Step 4: Run** the same file — PASS.
- [ ] **Step 5: Commit** the test first, then the code.

### Task 2: Every task shows its own status (finding 4)

**Files:**
- Modify: `desktop/lib/super_tabs/tasks/personal_task_card.dart` (`SuperTabTaskStatusMark`, `superTabTaskActivity`,
  `superTabTaskStatusLabel`)
- Test: `desktop/test/super_tab_personal_tasks_pane_test.dart`

**Interfaces:**
- Produces: `String superTabTaskStatusLabel(String status)`, `HarnessActivity superTabTaskActivity(String status)`
  (unchanged signatures), and the mark's tooltip is that label.

- [ ] **Step 1: Write the failing test** listing every status with its word and mark:
  planned Planned ◌ starting; working Working; needs_human Needs a human (needsInput); blocked Stuck (failed);
  review Ready for review (needsInput); done Done (done); stopped Stopped (paused); cancelled Cancelled (paused);
  reconciling Checking its agent (unknown); lost Agent lost (offline); proposal Proposal; rejected Rejected;
  anything else Status unavailable (unknown). The mark's tooltip reads the same word.
- [ ] **Step 2: Run** — FAIL ("Starting", "Finished · unread", "Failed").
- [ ] **Step 3: Implement** the two switches over the backend's statuses; the mark wraps `ActivityMark(tooltip: false)`
  in a `Tooltip` with the label, as the Board tile does.
- [ ] **Step 4: Run** — PASS, with `super_tab_personal_tasks_middle_test.dart`.
- [ ] **Step 5: Commit** the test first, then the code.

### Task 3: A rejected task shows its reason (finding 17)

**Files:**
- Modify: `desktop/lib/super_tabs/tasks/personal_task_card.dart` (`SuperTabTaskStatusMark` takes `reason`),
  `desktop/lib/super_tabs/tasks/task_header.dart` (a reason line under the facts)
- Test: `desktop/test/super_tab_personal_tasks_middle_test.dart`, `desktop/test/super_tab_personal_tasks_pane_test.dart`

**Interfaces:**
- Produces: `SuperTabTaskStatusMark(String status, {String? reason})`; the tooltip reads "Rejected: <reason>".

- [ ] **Step 1: Write the failing tests** — the card's mark has tooltip "Rejected: Too much scope"; the header of that
  task shows "Reason: Too much scope", and a 600-character reason lays out without an exception.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — the card and header pass `task.reason`; the header adds the line in the metadata style
  when the task is rejected with a reason.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** the test first, then the code.

### Task 4: Screenshots

- [ ] Extend `desktop/test/super_tab_personal_tasks_shots_test.dart` with a refused Approve, every status card and a
  rejected task's header, in light and dark; run with `HARNESS_V3_TASKS_SHOTS=<dir>` and attach the shots to the PR.
