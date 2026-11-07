# Tasks approval capability implementation plan

> Implement natively, task by task, with failing tests committed before code and one independent review.

**Goal:** Let Desktop distinguish a pending personal approval from an ordinary Buddy proposal.

**Architecture:** Add a computed `canApprove` boolean to existing personal Tasks summaries after their existing audience and membership filters. No command or authorization policy changes.

**Tech Stack:** TypeScript, existing parts projection, Vitest.

**Spec:** `docs/specs/2026-11-07-swarm-v3.md`; Layoutfix's contract finding in task #4138.

## Global Constraints

- Backend only; no credentials, production operations, database query, or stored field.
- Missing capability means false on clients; old clients ignore the additive field.
- Run affected checks locally and full backend/integration in PR CI.

## Review Focus

- Plain Buddy proposal and pending approval share status but must differ in capability.
- Approved and rejected decisions must not remain actionable.
- Foreign or stale memberships must not receive an actionable row.
- Initial and change projections use the same capability rule.
- Missing capability on older servers must not enable controls.

## Design

The boolean is computed from the already-loaded taskApproval after the existing identity/read filters. It adds no retained state, query, timer, collection, index, migration or concurrency scope. Existing cursors and visibility resets carry it. Growth is one boolean per existing row; rollback removes the field and clients default false. The server's decision commands remain authoritative. All backend platforms use the same projection; no process or window changes.

### Task 1: expose the capability

**Files:** `backend/src/superTabs/read/personalTasks.ts`, its test, and the shared v3 spec.

**Interfaces:** `PersonalTask.canApprove: boolean`; true exactly for this membership's pending taskApproval. All other emitted rows carry false.

- [ ] Add table cases for pending/approved/rejected/no approval with and without a Buddy proposal; assert both initial and delta reads. Assert stale/foreign pending membership produces no row.
- [ ] Run the affected test and commit the expected failures before code.
- [ ] Add the boolean to the existing projection and document false fallback.
- [ ] Run affected read/approval tests, typecheck and diff check; record red/green and payload/timing evidence.
- [ ] Push, request independent review, and hold for current-head ci/required before completion.
