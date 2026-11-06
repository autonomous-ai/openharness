# Docs inputs in reused CI implementation plan

> **Execution:** Native implementation in this Engineer session, test first, then an independent PR review. No subagent handoff or approval wait.

**Goal:** Keep docs input declarations honest without forcing reruns for path strings that are only test data.

**Architecture:** Reuse ci-plan's existing undeclared-read scanner and reasoned NOT_READS entries. Audit every docs match: real readers must have DEPENDS; fixture/policy path strings get exact source/target exemptions. Add synthetic docs-read and repository-audit checks, plus a merge-reuse regression for the two named fixture sources. Do not change component tests or their assertions.

**Tech Stack:** Python unittest, temporary Git fixtures, scripts/ci-plan.py.

**Spec:** Task #3798, conversation `1ac2162ad70116d1042527d1`; audit finding in its request thread: the two named tests contain docs path data, not file reads.

## Global constraints

- Workflow/script changes only; no changes to what component tests check.
- Real reads under docs/contracts, docs/research, docs/performance and named OS docs keep their current declarations. Do not declare all docs/ as a suite dependency.
- The two reported tests must stop falsely blocking reuse when unrelated docs change, while actual new undeclared reads remain reported.
- Leave unrelated cross-component scan debt outside this task; record any existing failures separately.

## Review focus

- An exclusion for a fixture's `docs/` string must not exempt a later explicit `docs/guide.md` read.
- A declared docs file must not silently cover a sibling file.
- Audit both relative file reads and repository-root paths, across every suite present in a full checkout.
- Process CI uses a sparse checkout: skip only the full repository audit there, keep synthetic checks active.
- Verify both named tests against real sources and verify the merge helper still rejects an actual undeclared docs read.

## Task 1: Docs reads, fixture paths and reuse

**Files:** Modify `scripts/ci-plan.py` and `scripts/tests/test_ci_plan.py`.

**Interfaces:** Preserve `undeclared_reads(root, suite, known_paths=())`, `reads(suite, path)` and `verify_reuse(...)`. Add reasoned exact source/target entries in NOT_READS, not broad scanner suppression. Existing DEPENDS cover actual docs readers found by the audit.

- [ ] Commit failing tests: fixture strings from the two named sources must not block docs-only reuse; an explicit new docs read in such a source must still be reported; undeclared relative/root docs reads must be reported until their exact dependency is declared; current repository docs scan must be empty after audit.
- [ ] Run the focused tests and record behavioral failures before changing the planner.
- [ ] Add only reviewed docs-data entries from the audit to NOT_READS. If an actual undeclared docs reader is found, add its narrow dependency instead.
- [ ] Run the affected ci-plan tests, record unrelated existing cross-read debt without changing it, and run the source-input, record-ci-validation and merge-helper test consumers.
- [ ] Commit/push the passing task, record red/green evidence and audit findings in the PR, mark Ready, and record acceptance at the full head on main. Independent review and process CI run before merge.
