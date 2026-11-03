# A Failed Check Stays Failed When Another Checker Passes It Implementation Plan

> **How this is worked:** by the project's instructions, task by task, each failing test committed before its code.

**Goal:** A check failed by one checker stays failed until that same checker passes it, every checker's latest verdict and evidence is kept, and the leaderboard counts each checker's first verdict without inventing rework rounds.

**Architecture:** `work.check` overwrites `check.evidence` and `check.passedBy`, so a Reviewer's pass erases a Tester's failure. Each check gets `verdicts`: one entry per checker (`by`, `passed`, `evidence`, `at`), the latest replacing that checker's earlier one. `passedBy` and `evidence` are derived from it on every verdict, a failing checker winning, so every reader (Desktop, phone, CLI, tidy, links) reads the right state without knowing `verdicts`. The leaderboard keys its "first verdict" and rework trail by check and checker instead of check alone. The CLI's task output lists each checker's verdict.

**Tech Stack:** TypeScript, Vitest (backend, CLI); Dart, Flutter 3.47.2 (Desktop).

**Spec:** Task #2311 (Diego), its brief.

## Global Constraints

- The PR body starts with: `Requested by diego@autonomous.ai through Harness.`
- Before Ready: a test that fails without the fix for every risk the task names, red/green evidence in a PR comment, and the full Super Tab integration suite (backend change).
- Never run a test that signs the Mac out of the real CLI; Desktop tests use a memory store and a fake sign-in.
- Swarm code stays out of `cli/src/core`.
- Temporary files only in `mktemp -d` folders.

## Review Focus

1. The assignee's own verdict is a checker's verdict too: the Engineer passing a check the Reviewer failed leaves it failed (Task 1 test).
2. Two checkers failing: the check stays failed until both pass; the derived evidence is the latest failure's (Task 1 test).
3. A check recorded before this change (no `verdicts`, `passedBy` set) keeps its pass as that checker's verdict, so a later failure by another checker still fails it and a later pass by the same one does not duplicate it (Task 1 test).
4. A new attempt starts from no verdicts (Task 1 test).
5. The same checker failing then passing is still one review and one rework round (Task 2: the existing tests keep passing unchanged).

## Design

- **Growth:** at most one verdict per checker per check, replaced, not appended; `work.assign` clears them with `evidence` and `passedBy` for each new attempt. A group has few checkers (its agents and people).
- **Concurrency:** the Swarm's existing per-tab command lock; nothing new.
- **Read cost:** the verdicts ride on the check already read; readers that only need the state read the derived `passedBy`.
- **Scale:** 10x checkers on a check is still tens of entries; the state part size of a group warns first.
- **Compatibility:** older clients read `passedBy` and `evidence`, now derived so a failure wins; newer clients read `verdicts` when present and fall back to those fields.
- **Migration + rollback:** no migration. A check from before has no `verdicts`; its first new verdict seeds its kept pass (`passedBy`) as that checker's verdict. A kept failure names no checker and is not seeded (as today, a later verdict replaces it). Rolling back leaves `verdicts` unread and the old overwrite again.
- **Audience:** verdicts are part of the check, read by whoever reads the group, as its evidence already is.
- **Identity:** a verdict is keyed by the actor's key (`agent:ID` or `person:ID`), never a machine owner's login.
- **Failure:** nothing new fails; a refused `work.check` is refused as before.
- **Platforms:** backend, CLI and Desktop; the phone app reads the derived fields unchanged.

---

### Task 1: Each checker's verdict kept; a failure wins

**Files:**
- Create: `backend/src/superTabs/checkVerdicts.ts`
- Modify: `backend/src/superTabs/model.ts` (`Check`), `backend/src/superTabs/commands.ts` (`work.check`, `work.assign` reset)
- Test: `backend/src/superTabs/steps.test.ts`

**Interfaces:**
- Produces: `interface CheckVerdict { by: string; passed: boolean; evidence: string; at: number }`; `Check.verdicts?: CheckVerdict[]`;
  `recordCheckVerdict(check: Check, verdict: CheckVerdict): CheckVerdict | undefined` — replaces `verdict.by`'s earlier verdict, returns it (undefined on its first), and derives `check.passedBy` (the latest passer's key while no verdict failed, else null) and `check.evidence` (the latest failure's evidence, else the latest verdict's).

- [ ] **Step 1: Write the failing tests** in `steps.test.ts`, `describe('checks with several checkers')`:
  - `Tester fails, Reviewer passes: the check reads failed and keeps the Tester's evidence` — `passedBy` null, `evidence` 'Crashes offline\nlog', `verdicts` both.
  - `the same Tester passing it then passes the check` — `passedBy` `agent:<tester>`.
  - `the assignee passing a check the Reviewer failed leaves it failed`.
  - `two failures: failed until both pass, the latest failure's evidence shown`.
  - `a pass kept from before verdicts counts as its checker's verdict`.
  - `a new attempt starts with no verdicts`.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/steps.test.ts` in `backend`: the new tests FAIL (the check reads passed).
- [ ] **Step 3: Commit** the failing tests.
- [ ] **Step 4: Implement** `checkVerdicts.ts`, call it from `work.check` with `{ by: actorKey(actor), passed, evidence, at: context.now }`; `work.assign` deletes `verdicts`.
- [ ] **Step 5: Run** the file and `npx tsc --noEmit`: PASS.
- [ ] **Step 6: Commit and push.**

### Task 2: The leaderboard counts per checker

**Files:**
- Modify: `backend/src/superTabs/leaderboard/record.ts` (`recordVerdict`, `recordReview`, `recordRework`, `Run` docs), `backend/src/superTabs/commands.ts`
- Test: `backend/src/superTabs/leaderboard/record.test.ts`

**Interfaces:**
- Consumes: `recordCheckVerdict`'s return (the checker's earlier verdict).
- Produces: `recordVerdict(state, group, check, checker, now, first: boolean)`; `recordReview(group, check, by: string, passed, byAssignee, first: boolean)`. `first`: this checker gave no verdict on this check in this attempt.
  - `recordVerdict` credits each checker's first verdict on a check (no longer only the check's first), still never the assignee's and never on an attempt without a run.
  - `firstVerdicts[check]` is false once any checker's first verdict on it failed.
  - `reworks` is keyed by check and checker (`${checkId} ${by}`): a round is a checker's verdict after its own failure. Keys from before (check id alone) still count in `reworkRounds`.

- [ ] **Step 1: Write the failing tests** in `record.test.ts`:
  - `credits a Reviewer's verdict after a Tester's on the same check as its own review` — two reviewer agents on different models: `reviews` has a row for each.
  - `adds no rework round when another checker passes a check one failed` — Tester fails, Reviewer passes: `reworkRounds` 0; Tester passes: 1.
  - `fails the first review when a second checker's first verdict fails` — Reviewer passes, Tester fails: `firstReview` false.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/leaderboard/record.test.ts`: the new tests FAIL; the existing ones pass.
- [ ] **Step 3: Commit** the failing tests.
- [ ] **Step 4: Implement** in `record.ts`; `work.check` passes `first = previous === undefined`.
- [ ] **Step 5: Run** the file, `steps.test.ts`, `commands.test.ts` and `tsc`: PASS.
- [ ] **Step 6: Commit and push.**

### Task 3: The CLI shows every checker's verdict

**Files:**
- Modify: `cli/src/superTabs/agentContext.ts` (`checkLine`, `unknownAgents`)
- Test: `cli/src/superTabs/agentContext.spec.ts`

**Interfaces:**
- Consumes: `check.verdicts` as the backend writes it (Task 1); a check without it reads as today.
- Output, one line per check: `✗ Signs in offline — failed by Tester: Crashes offline; passed by Rev1` while any verdict failed (each failure with its evidence's first line, failures first); `✓ Signs in offline — by Rev1, Tester` when all passed.

- [ ] **Step 1: Write the failing tests:** `shows each checker's verdict, a failure first` and `names a stopped checker` (`unknownAgents` returns a verdict's agent missing from the read).
- [ ] **Step 2: Run** `npx vitest run src/superTabs/agentContext.spec.ts` in `cli`: FAIL.
- [ ] **Step 3: Commit** the failing tests.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** the file and `npx tsc --noEmit`: PASS.
- [ ] **Step 6: Commit and push.**

### Task 4: Desktop reads a failed check from its verdicts

**Files:**
- Create: `desktop/lib/super_tabs/checks.dart`
- Modify: `desktop/lib/super_tabs/live_card.dart`, `linked_tasks.dart`, `work_details.dart`
- Test: `desktop/test/super_tab_checks_test.dart`

**Interfaces:**
- Produces: `bool superTabCheckPassed(Map<String, dynamic> check)` and `bool superTabCheckFailed(Map<String, dynamic> check)`: from `verdicts` when it is a non-empty list (passed: every verdict passed; failed: any failed), else from `passedBy` and `evidence` as today. No copy changes: "Verified", "Not verified", "N of M checks passed", "1 check failed".

- [ ] **Step 1: Write the failing tests:** a check whose verdicts hold a failure reads failed and not passed even when an older field says passed; a check without verdicts reads as today; the live card counts it unpassed and the linked task line says "1 check failed".
- [ ] **Step 2: Run** `flutter test test/super_tab_checks_test.dart` in `desktop`: FAIL (no `checks.dart`).
- [ ] **Step 3: Commit** the failing tests.
- [ ] **Step 4: Implement** and use the helpers at the three readers.
- [ ] **Step 5: Run** the file, `super_tab_live_card_test.dart`, `super_tab_review_test.dart`, `super_tab_work_details_test.dart` and `flutter analyze lib/super_tabs`: PASS.
- [ ] **Step 6: Commit and push.**

### Task 5: Before Ready

- [ ] Full Super Tab integration suite (`npm run test:super-tabs` in `backend`), `npm test` in `backend`, CLI `npm run test:super-tabs`.
- [ ] Red/green evidence comment on the PR; mark it ready; Review step by Routing.
