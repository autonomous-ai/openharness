# CI planner audit on a full checkout: plan

**Goal:** `python3 -m unittest scripts/tests/test_ci_plan.py` passes on main, and CI runs that file on a full checkout,
so an undeclared cross-read or a missing phone-test selection turns `ci/required` red (task #4313).

**Architecture:** process-checks stays sparse, because its checkout is the recorded evidence for reuse. A new
`planner-audit` job checks out the whole tree at depth 1 and runs the whole file. It has no `needs` and no `if`, and
`ci/required` lists it in its needs, so its failure or cancellation fails the gate (`verify` refuses any need that is
not success or skipped). In that job `CI_FULL_CHECKOUT=1` turns a "needs a full checkout" skip into a failure, so a
broken checkout cannot pass it by skipping.

**Tech Stack:** Python 3 unittest, GitHub Actions.

**Spec:** task #4313. On main (cbdcc6f06) the file fails 5 subtests: undeclared reads for backend (233), cli (2) and
desktop (2), and mobile selection for `desktop/lib/super_tabs/pulse.dart` and
`desktop/lib/super_tabs/tasks/personal_tasks.dart`.

## Global Constraints

- CI cost grows only by this one Python file on one runner; `ci/required` stays within 15 min.
- Data, not reads, go in `NOT_READS` with a reason; a file a suite's jobs open goes in `DEPENDS`.
- No change to process-checks' sparse inputs or to the recorded evidence.

## Review Focus

- Each `NOT_READS` entry is data (path strings matched against rules or owned paths), never a file the job opens.
- A `"dir/"` entry in `NOT_READS` now covers the paths under it; relative reads (`../x`) are still never exempted.
- `planner-audit` cannot be skipped or pass on a sparse tree.

## Task 1: the full-checkout job

**Files:** `.github/workflows/ci.yml`, `scripts/tests/test_ci_plan.py`

- [ ] Test: `ci.yml` has a `planner-audit` job with no `if`, no `needs`, no sparse checkout, `CI_FULL_CHECKOUT: "1"`, that
  runs `test_ci_plan.py`, and `ci/required` needs it. The two full-checkout tests fail instead of skipping when
  `CI_FULL_CHECKOUT` is set. Run: fails (no job, tests skip).
- [ ] Add the job and the guard. Run: the structural test passes; on a PR, `ci/required` is red with main's 5 failures.

## Task 2: declare main's cross-reads and phone-test selections

**Files:** `scripts/ci-plan.py`, `scripts/tests/test_ci_plan.py`

- [ ] Test: a `"dir/"` entry in `NOT_READS` hides quoted paths under it and not a sibling outside it. Run: fails.
- [ ] `NOT_READS` matches folders as prefixes; entries for the backend and desktop sources whose paths are test or rule
  data; `DEPENDS` for the files really read (backend reads `mobile/integration_test/push_e2e/reply_push.apns`; cli
  reads `backend/src/superTabs/processNotes.ts` and `backend/src/superTabs/machineRules.cases.json`); the two desktop
  files the phone parity test reads in `ALSO` for mobile. Run: the whole file passes on a full checkout.
