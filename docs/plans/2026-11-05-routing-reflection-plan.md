# Quiet routing reflection implementation plan

**Goal:** Stop nightly routing reports appearing in project chats while retaining costs and owner routing Decisions.

**Architecture:** Keep the existing nightly calculation and decision lifecycle. Remove its project-chat message write; only fresh proposals create Decisions. The costs command continues reading the existing attempt ledger unchanged.

**Tech Stack:** TypeScript, Prisma/MongoDB, Vitest.

**Spec:** Swarm task #2997, “No routing report in project chats”, requested by Dee.

**Execution:** Implement task-by-task, test first, following the project's Engineer workflow.

## Global Constraints

- No new settings; existing messages remain untouched.
- Keep owner/audience checks, proposal limits, expiry, deduplication and approval semantics.
- No production reads or writes, schema changes, new collections or query changes.
- Run affected tests locally; backend unit and Super Tab integration suites are automatic PR CI evidence.
- PR body starts with “Requested by dee through Harness.”

## Design

- Growth: removes new report messages; existing attempt and Decision retention remains unchanged.
- Concurrency: existing short Swarm transaction and stable nightly Decision operation ID; retain serialization of Decision writes.
- Read cost: existing bounded weekly evidence reads, no added queries.
- Scale: unchanged 5,000 candidate and three-proposal bounds; existing warnings remain.
- Compatibility: no client or command contract changes; existing reflection-message IDs remain recognized.
- Migration + rollback: no migration; revert restores future posts without touching historical rows.
- Audience: existing server-side project-owner access checks remain.
- Identity: existing project Lead asks Decisions; no machine-owner login.
- Failure: existing named worker warnings and bounded nightly retries remain.
- Platforms: server-only; no platform-specific behavior.

## Review Focus

- Both proposal and no-proposal nights must leave all project-chat messages unchanged.
- Multiple Swarms and private projects must retain isolation.
- Owner Decisions must contain a short change and reason, not internal report tables.
- Concurrent passes must not duplicate Decisions; expiry and recent-answer suppression must remain.
- Existing posted reports and the costs command must remain readable.

## Task 1: Quiet nightly reflection

**Files:** `backend/src/superTabs/store.ts` (`postReflection`), `backend/src/superTabs/costs/reflection.ts`, `backend/src/lib/routingReflection.ts`, and their tests, including `backend/integration/superTabReflection.test.ts`.

**Interfaces:** Preserve `postReflection` result keys and stable Decision IDs. `posted` counts fresh Decision writes, not chat posts; `empty` means no fresh proposal.

- [ ] Commit regression tests for no chat writes with/without proposals, owner wording, preserved costs/history, and lifecycle/isolation.
- [ ] Run focused tests and record the expected failures before production changes.
- [ ] Remove report-message creation and rendering from the store path; retain owner Decision writes and serialization.
- [ ] Simplify proposal wording to one change line and one reason line while retaining recognizable titles and approval routing lines.
- [ ] Run focused unit/integration tests and backend typecheck; record red/green evidence in the PR.
- [ ] Mark ready for automatic component CI; request an independent review step, then report evidence through task status.
