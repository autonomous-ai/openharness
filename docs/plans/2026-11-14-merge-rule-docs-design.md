# Merge rule matches how merges are done

## Intent

`make merge-pr` (`scripts/merge-validated-pr.py`, `preflight`) refuses with "main moved since review; inspect the new
source before merging" whenever `main` gained a commit after the reviewed base. On a busy repository that is almost
every merge, so green pull requests are merged with
`gh pr merge <PR> --squash --admin --match-head-commit <head>`. The written rule says only `make merge-pr`, and the
guide says to integrate `main` and re-review whenever it moves. The docs should describe the merge as it is done.

## Goals

- `AGENTS.md` ("Merge and release"), `docs/validation-and-release.md` and `CONTRIBUTING.md` name the fallback: when
  `make merge-pr` refuses only because `main` moved, the required checks are green on the head, and GitHub shows the PR
  mergeable with no conflict and no unresolved review conversation, the merge is
  `gh pr merge <PR> --squash --admin --match-head-commit <head>`.
- A conflict still means integrating `main`, reviewing the combined change and rerunning only the affected checks.

## Non-goals

- No change to `scripts/merge-validated-pr.py` or the Makefile.
- No change to branch protection, CI or the merge train.

## Constraints

- Docs only, short, in the repo's style: docs describe, they name no person.

## Approaches

1. **Name the fallback in both docs (chosen).** One clause in `AGENTS.md`; the guide's hand-merge bullet and its
   "If `main` moved" paragraph say the same.
2. Teach the script to accept a moved `main`. Ruled out: the script stays unchanged.
3. Drop `make merge-pr` from the rule. Ruled out: it is still the first step and still verifies receipts on a quiet
   branch.

## Design

- `AGENTS.md`, "Merge and release": after "Merge with `make merge-pr`", add: when it refuses only because `main`
  moved, the required checks are green on the head and GitHub shows the PR mergeable with no conflict and no
  unresolved review conversation, merge with `gh pr merge <PR> --squash --admin --match-head-commit <head>`.
- `docs/validation-and-release.md`, the hand-merge bullet (Rules) and "Merge an already-reviewed PR": replace the
  "if `main` moves, integrate it and review again" text with the same rule; integrating `main`, the combined review
  and rerunning affected checks remain for a conflict.
- `CONTRIBUTING.md`, step 5 ("Merge and release"): its "If `main` moved, inspect and integrate" sentence gets the same
  rule.
- `docs/pr-triage/roles.md` keeps its rule; only its trailing "(AGENTS.md)" attribution is dropped. The PR triage role
  merges outside contributors' pull requests and keeps its stricter rule (merge helper only; on a moved `main`, update
  the branch and try once more).

## Left to the builder

The exact wording, within the lines above.
