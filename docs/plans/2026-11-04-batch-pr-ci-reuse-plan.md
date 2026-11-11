# A batch PR reuses its member PRs' passed results: plan

> Way of working: this plan's Engineer implements it task by task, test first (test-driven-development), in one pull
> request. No subagents, no execution handoff.

**Goal:** A batch PR (a branch from main with each member PR merged in) stops rerunning a component a member PR already
passed, when nothing that component reads changed between the member's tested commit and the batch head. Tony's phone
PRs waited two CI rounds (~10 min of mobile-checks each) for one phone PR in a batch.

**Architecture:** `scripts/ci-plan.py plan_reuse` already reuses a component after GitHub's Update branch: the head
merges a main commit into a passed head, and each component's result stands when the diff from the commit its run tested
to the head touches none of its inputs (own directory, DEPENDS; a shared input reruns everything). A batch head is a
chain of such merges with the member heads as second parents. The planner tells the two apart from Git alone: a head whose
second parent is on main is an update; otherwise it walks the head's first-parent line down to main, every commit a
two-parent merge, and takes each second parent not on main as a member's tested commit (a merge of main again brings
only main's commits). Each member's latest passed `ci/required` check is followed to its exact run and receipt, and a
component that run reused points at its original run, as for an update. For each component, a member whose run covered
it is reused when `reuse_blocker` passes from that origin to the batch head; an unreadable member is only no candidate,
since its changes stay in every other member's diff. The merge helper's `verify_reuse` re-derives the members from Git.
The PR body is never read.

**Tech Stack:** Python 3 (`scripts/ci-plan.py`), unittest with real Git repositories (`scripts/tests/test_ci_plan.py`).

**Spec:** Task #2720 (Tony, via River).

## Global Constraints

- Fails closed: any doubt (a hand commit on the batch line, an unreadable receipt, a shared input) runs the component,
  or everything.
- An Update-branch head plans exactly as before.
- This PR changes `scripts/`, so its own CI runs everything and main's planner judges it.

## Review Focus

- Soundness rests on the diff from a run's tested commit to the head, as for an update; how a member is found only picks
  candidates. Check that no path lets a member's own unreadable or failed run count.
- The member walk: two-parent merges only, main merges skipped, stops at main, bounded.
- `verify_reuse` (run from main's copy by the merge helper) refuses a receipt whose members differ from the head's.

## Task 1: main's planner data catches up

`main` fails three planner tests on its own: a backend test's client version strings read as paths, and two Desktop
files the phone tests now read. Declare them (`NOT_READS`, the phone's `ALSO` list).

## Task 2: batch reuse

**Files:** `scripts/ci-plan.py`, `scripts/tests/test_ci_plan.py`, `docs/validation-and-release.md`.
- [ ] Failing tests: one phone PR in a batch reuses mobile-checks; two phone PRs run it; a main change to a mobile input
  runs it; a shared input runs everything; an unreadable receipt runs its component; the PR body is never read; a batch
  that merged main again; a member whose run reused points at the original run; the helper verifies and refuses forged
  members.
- [ ] `batch_members`, `reuse_sources`; `plan_reuse` and `verify_reuse` take either; docs next to "Reuse after Update
  branch".
