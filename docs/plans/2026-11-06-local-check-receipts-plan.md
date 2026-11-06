# Local check receipts implementation plan

**Goal:** Task #3594: `ci/required` refuses a PR that changes a mapped local-check input without a passing receipt for its exact head.

**Architecture:** Add a bounded local-check contract beside the existing Python CI planner. The planner selects required checks from its complete Git diff (including deletions and both sides of renames); the process job validates a fenced JSON receipt in the PR body, and the aggregate requires that validated evidence. Keep receipt text as data and never execute it. Attach receipts after the final commit and before pushing or marking Ready; no new CI run is started on ordinary PR-body edits.

**Tech Stack:** Existing Python standard-library process tooling and GitHub Actions; unittest fixtures with temporary repositories and event files.

**Spec:** Harness #3594, conversation `ba757973e71728556c792f4d`, inventory Table A #3: eight CLI coverage gates, native serial/PTY checks, and macOS Desktop checks must have command/head/pass-count evidence. The referenced remote inventory is unavailable through the local shell guard; this task's quoted row and docs/validation-and-release.md define the scope.

Implement sequentially in this session, test first, with one independent review of the final pull request as the task requests.

## Global constraints

- Own scripts/ and .github/; this required plan is the only documentation outside them. The PM removes superseded policy prose after shipment.
- No runtime dependencies, live sign-ins, native tool execution or release actions in this gate. Tests use temporary folders and fixture evidence.
- Receipts identify the whole 40-character head, the named check, its canonical command and cwd, status passed, a positive integer pass count, and platform. Native Mac receipts require macos.
- At most one `harness-local-checks` fenced JSON list, bounded by the PR body limit and 32 entries; errors name only known required checks, never arbitrary PR text.
- A ready PR requires fresh evidence; a draft may omit it. Manual and merge-group runs have no PR receipts to collect and retain their existing behavior.
- Preserve the existing automatic-suite/reuse semantics and read-only workflow permissions. No new run on a body edit; prepare evidence before the next normal PR validation run.

## Design

- Growth/concurrency: no persisted data beyond the existing PR body and CI receipt/artifact lifetime; bounded list, immutable source identity, no new writer.
- Read cost/scale: one linear pass over the already bounded PR body and the planner's changed paths, no API or shell calls from receipt parsing.
- Compatibility: add optional fields to the existing CI plan/receipt; no public product wire change. Manual/merge-group CI unchanged. New ready PR runs enforce the gate immediately.
- Migration/rollback: no data migration; reverting the workflow and planner restores prior behavior. Existing prose evidence must be converted to the structured format before a mapped PR's next run.
- Audience/identity: PR body is already shared with repository readers; receipts are authors' attestations, not cryptographic proof of execution. No raw logs, environment values or arbitrary command output is copied into CI evidence.
- Failure/platforms: missing, stale, malformed, failed, zero-test and wrong-platform evidence fail with the missing-check list. Python runs on Linux CI and local macOS; it launches no native process on Windows.

## Review focus

- Each of the eight coverage gates, native serial/PTY/shell paths and macOS-specific Desktop paths selects the right checks; unrelated paths do not.
- Deleted/renamed files and sparse checkouts retain requirements; common CLI dependency/test configuration changes cover all CLI checks.
- Old-head, zero/boolean/negative-count, failed, wrong-command/cwd/platform and malformed receipts never count.
- PR-body text and commands are never evaluated or leaked; event/plan/head mismatches fail.
- A successful process job without its receipt output cannot bypass the aggregate; draft/manual/merge-group handling does not weaken ready-PR enforcement.

## Task 1: Select and enforce local evidence

**Files:** add `scripts/local-checks.py` and `scripts/tests/test_local_checks.py`; modify `scripts/ci-plan.py`, `.github/workflows/ci.yml`, `.github/pull_request_template.md`; extend planner tests where necessary.

**Interfaces:** `required_checks(paths) -> list[str]`; `validate_receipts(required, receipts, head) -> list[dict]`; `check(plan, event) -> list[dict]`. Plans expose `local_checks`; the process job exports validated `local_receipts`; `verify` revalidates them before emitting the existing `ci-required` receipt.

- [ ] Commit tests first: literal path mapping cases, real-Git rename/delete planning, bounded parser/refusal cases, subprocess process-check behavior, and aggregate refusal/pass with missing/valid evidence.
- [ ] Run the new tests, record their expected failure, then implement the contract and workflow wiring.
- [ ] Run targeted receipt/planner/source-input/merge-helper tests and actionlint; use automatic process CI for the full scripts suite.
- [ ] Add concise receipt instructions/example to the PR template. Record red/green evidence, stable head, platform limits and timing in the draft PR before Ready.
- [ ] Obtain independent review and hand the completed revision to the PM for merge.
