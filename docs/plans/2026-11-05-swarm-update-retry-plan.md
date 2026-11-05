# Swarm update Retry implementation plan

> Implement task by task in this session, test first, with one independent review of the pull request.

**Goal:** A malformed reconnect read never permanently locks the Swarm behind Update Harness.
**Architecture:** Classify missing or invalid read formats as retryable read failures in the CLI. Keep compatibility refusals latched until an explicit Desktop Retry rechecks the server, then resume normal scheduling after recovery.
**Tech Stack:** TypeScript/Vitest; Dart/Flutter widget and controller tests.
**Spec:** Swarm task #3273, conversation 0ac53b4a9733709144f7b3c2.

## Global Constraints

- Requested by Leo through Harness. CLI + Desktop only; no backend or core changes.
- Preserve genuine HTTP 426 and higher-format update refusals.
- Tests use in-memory fixtures and fake sign-in; never touch the real CLI account.
- Run wire/read specs, Desktop controller/view tests, changed-code analysis and check-ui-style before Ready. Full component suites run in PR CI.
- Keep polling stopped while compatibility is refused. Retry performs a fresh read; overlapping retries share it.

## Review Focus

- Missing, null, string, array, fractional or older formats must not demand an update.
- A changes-read failure must retain the cursor and recover on its next valid reply.
- Retry after the first load fails must recover even without a snapshot.
- A repeated genuine refusal must keep the banner and stop background reads.
- Successful Retry must restore periodic reads; access revocation remains final.

## Task 1: Classify malformed reads

**Files:** `cli/src/superTabs/wire.ts`, `wire.spec.ts`, `swarmReads.spec.ts`.
**Interfaces:** `readable<T>(reply: unknown): T` returns format 2, throws UPDATE_REQUIRED/426 only for an integer format above 2, otherwise throws BACKEND_UNAVAILABLE/503. `backend()` preserves HTTP 426.

- [ ] Add and commit parameterized malformed-format tests and first/changes recovery tests before code.
- [ ] Run `npx vitest run src/superTabs/wire.spec.ts src/superTabs/swarmReads.spec.ts --maxWorkers=2`; record the expected malformed-format failures.
- [ ] Implement format classification; run wire, swarmReads, hostFeed and serviceReads specs and typecheck; commit passing code.

## Task 2: Recover through explicit Retry

**Files:** `desktop/lib/super_tabs/controller.dart`, `view.dart`, `desktop/test/super_tab_update_required_test.dart`.
**Interfaces:** Add `Future<void> retry()` for explicit retry; background `refresh()` remains guarded. Both existing Retry buttons invoke it and are available during updateRequired, unless access is revoked.

- [ ] Add and commit controller tests for no-snapshot recovery, repeated refusal, shared in-flight retry and polling recovery, plus widget tests tapping Retry with and without a snapshot.
- [ ] Run the update-required test file and record failures before code.
- [ ] Implement Retry to clear the compatibility latch, coalesce reads and restore scheduling; expose both Retry buttons. Run the new tests; commit passing code.
- [ ] Run affected controller/view/reading/recovery tests, changed Dart analysis and `python3 scripts/check-ui-style.py --only desktop`.
- [ ] Record red/green evidence in the PR comment, mark Ready, and hand the stable head to the Integrator for independent review and test.

## Design

No stored data, audience or identity changes. Growth/concurrency: existing read coalescing and scheduler remain authoritative, no new queues. Read cost: one explicit retry, then existing incremental reads. Compatibility: format 2 remains unchanged, higher integer formats and HTTP 426 still require an update. Migration/rollback: none; revert the code. Failure: malformed reads retain ordinary visible retry errors. Platforms: shared CLI and Flutter logic; verify macOS locally and Linux in CI, with independent offscreen UI verification on a Team account.
