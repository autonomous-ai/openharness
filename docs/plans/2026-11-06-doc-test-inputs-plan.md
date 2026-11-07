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

- [x] Commit failing tests: fixture strings from the two named sources must not block docs-only reuse; an explicit new docs read in such a source must still be reported; undeclared relative/root docs reads must be reported until their exact dependency is declared; current repository docs scan must be empty after audit.
- [x] Run the focused tests and record behavioral failures before changing the planner.
- [x] Add only reviewed docs-data entries from the audit to NOT_READS. If an actual undeclared docs reader is found, add its narrow dependency instead.
- [x] Run the affected ci-plan tests, record unrelated existing cross-read debt without changing it, and run the source-input, record-ci-validation and merge-helper test consumers.
- [ ] Commit/push the passing task, record red/green evidence and audit findings in the PR, mark Ready, and record acceptance at the full head on main. Independent review and process CI run before merge.


## Validation record

- Test-first commits: `7f9e7b916`, then `7acdc4cb5` to make expected-success refusals assertion failures. Before the fix, both named fixture sources refused reuse and the docs audit reported 17 backend matches plus one Desktop match.
- After the fix, all four focused docs tests pass, including actual-read refusal in both named source paths and the full repository docs audit. All actual docs readers found already have narrow DEPENDS declarations.
- Source-input, CI-record and merge-helper consumers: 74 tests pass. The full ci-plan file runs 92 tests with three unrelated failing subtests: the existing backend/Desktop cross-read audits and missing mobile selection for `desktop/lib/super_tabs/pulse.dart`. Keep that baseline debt outside this task.
- River's ruling in the request thread: “reasoned exclusions for strings that are only fixture data, declarations only for real reads, and the regression check.” Component test assertions are unchanged.
- Independent review and automatic process CI remain required before merge.
