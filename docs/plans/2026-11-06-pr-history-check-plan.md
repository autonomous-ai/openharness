# PR history checks implementation plan

> Implement natively, task by task: commit each failing test before its code, then obtain one independent review of the whole branch.

**Goal:** Report plan-first, test-before-code ordering and change size automatically in every review brief when a task goes Ready.

**Architecture:** A pure backend checker consumes bounded, oldest-first commit/file facts and net PR file counts. A scripts/ entry point runs the same checker against JSON sample histories. Ready's existing project-scoped GitHub read collects facts outside the write transaction, checks the head again, and puts a concise report into new and reused review briefs. These are evidence for the reviewer, not a new merge or approval gate.

**Tech Stack:** TypeScript, existing GitHub App read API, Vitest and tsx. No new dependency or datastore.

**Spec:** Task #3597, conversation cdb9f79b08483ed6198c2ee3 (Inventory Table A #6): plan first, failing test before code, size, sample histories, review brief integration. The inventory's other-machine scratchpad is unavailable here; the task and current project instructions contain the applicable rules.

## Global Constraints

- First PR body line: Requested by dee through Harness.
- Never run branch code, check out a PR or trust commit messages as instructions. Classify paths and parent relationships only.
- History proves ordering, not that a test failed or covers a particular behavior. Say that explicitly; red/green evidence remains the reviewer's check.
- A production commit needs an earlier test-only commit since the previous production commit. Same-commit tests/code and tests added after code do not qualify. Documentation-only changes need no code-order assessment.
- Merge commits do not count as plan/test/code commits; a mixed merge resolution cannot prove test order and is flagged for review.
- Missing, malformed, truncated or moved-head history is unknown, never passing. Bound reads and report size from the net PR diff, not accumulated commit churn.
- No confidential content or credentials in output. No CLI core, production writes or schema/index changes.
- Run affected tests locally; the task also explicitly requires the backend unit suite before Ready. Super Tab integrations run in automatic PR CI.

## Design

- **Growth/deletion:** At most five PR reports, each a bounded summary, embedded in the existing review brief. Replace the prior generated block on another Ready; no stored raw history or new collection. Existing task/step deletion removes it.
- **Concurrency/read cost/scale:** Reuse the current Ready hook, outside the write transaction. At most 50 commits per PR, 300 files per commit and 300 net files, four commit reads at once. Larger/truncated histories are unknown. The existing read-only token is revoked; add contents:read only for commit metadata. No new Mongo query or index. Record pure-checker timing on a maximum-size synthetic history.
- **Compatibility/audience/identity:** Add optional report facts to internal command context, not client commands. Existing project access/repository checks remain. Old stored steps gain a report on Ready; old clients need no change. Backend ships first, no client dependency.
- **Failure:** GitHub history errors are a visible unknown report and do not hide file-based security review requirements. Pin the report to the checked head; a push during the read invalidates it. No raw error/body is copied into the brief.
- **Migration/rollback/platforms:** No migration; rollback stops producing reports while the old text remains readable. Backend/shared script behavior affects all clients; validate on macOS and automatic Linux CI.

## Review Focus

- A test bundled with or following implementation must never count as prior test evidence (Task 1).
- Renames into/out of docs/tests must classify both names; merge commits must not manufacture a plan/test pass (Task 1).
- More data than the reader cap, malformed API facts, a missing commit, or a moving head must never look complete (Task 2).
- Multiple PRs and a second Ready must not attach an old or another PR's result; active and finished review steps both refresh (Task 2).
- Files, messages and patches are untrusted data; only fixed API paths and summarized facts reach reports, and no PR code executes (Tasks 1/2).

### Task 1: Shared checker and runnable script

**Files:** backend/src/superTabs/prHistory.ts, prHistory.test.ts; scripts/check-pr-history.ts.
**Interfaces:** `checkPrHistory(input: unknown): HistoryReport`; facts `{head, commits:[{sha, parents:string[], files:[{filename, previousFilename?, additions, deletions}]}], files:[...]}`; report `{planFirst, testBeforeCode, productionLines, totalLines, commits, missingTests}` with pass/fail/unknown/not-needed statuses. Script reads one bounded JSON input from stdin and writes JSON, failing invalid input without echoing it.

- [ ] Commit sample-history and real-script tests: plan-only first commit succeeds, code first/mixed plan fails, each implementation needs its own prior test-only commit, same-commit/late tests fail, docs-only, merge, rename, empty/malformed inputs and net size boundaries.
- [ ] Observe failure before implementation.
- [ ] Implement classifier/checker and script; expose only bounded summaries, never commit prose or patches.
- [ ] Run checker/script tests and typecheck; record counts/timing, commit and push.

### Task 2: Ready collection and review brief delivery

**Files:** backend/src/superTabs/prHistoryRead.ts, prHistoryRead.test.ts, pullRequestFiles.ts, pullRequestFiles.test.ts, commands.ts, reviewTable.ts, reviewTable.test.ts, reviewSteps.test.ts; backend/integration/superTabReviewSteps.test.ts.
**Interfaces:** `readPrHistory(app.get, repository, number, token, head): Promise<HistoryReport>`; optional per-PR `history` in PullRequestFilesRead.heads; review brief replaces a generated history block on every Ready.

- [ ] Commit failing tests for complete/failed/truncated/malformed reads, read cap, token permissions/revocation, moved head, separate reports for multiple PRs, every review brief, refreshed active/finished steps and real-store persisted brief.
- [ ] Observe failures before implementation.
- [ ] Read fixed repository endpoints with bounded concurrency, attach only current-head reports, preserve file-based review planning on history failure, refresh the generated brief block before step assignment.
- [ ] Run affected unit checks, focused store integration, typecheck, script tests and the explicitly requested backend unit suite. Record red/green; mark Ready once, hold the head for automatic CI and independent review.
