# Swarm v3 approval and personal Tasks implementation plan

> Implement natively, task by task: commit each failing test before its code, then obtain independent security reviews of the final branch. No per-task subagent handoff.

**Goal:** Store and enforce each person's Auto approve / Review choice and deliver their Tasks summaries through existing cursor reads.
**Architecture:** Extend member and task JSON parts; reuse proposal cards, assignment/start/dispatch guards, operation receipts, project visibility and first-load/change APIs. One pure summary projection; no schema, endpoint, dependency or credential path.
**Tech Stack:** TypeScript, Zod, existing Mongo part store, Vitest, isolated real-store integration tests.
**Spec:** docs/specs/2026-11-07-swarm-v3.md; task #4115, conversation 62386c008cea90646d4c8eed.

## Global Constraints

- First commit includes the whole shared v3 spec and this plan; first PR body line: Requested by dee through Harness.
- Never read/post secrets or write production. No CLI login, relay, native process, phone/web UI, or account-removal changes here.
- Stay in backend/src/superTabs plus required spec/plan and focused integration tests. Coordinate overlapping model/commands/read contracts with the v3 agent and Desktop Tasks builders.
- Tests before implementation for every named behavior; affected tests locally, complete units and four integration shards in automatic PR CI. Real-store tests use isolated local fixtures, never real sign-in.
- Two independent security reviews for approval identity and feed authorization. Minor findings wait unless they block acceptance. Hold final head during review/CI.

## Review Focus

- A PM, Buddy, another person, rejoined membership or replay cannot change/forge personal approval.
- PM task preparation, automatic dispatch, explicit assignment and starts cannot run pending/rejected work; changing modes does not release existing pending work.
- Own proposals and PM tasks appear once with current state, time, project and visible agent; no private project/group leak or stale row after revocation/removal.
- Cursor changes read/return changed summaries, not history; failed/old cursors reset, and old clients keep their assignment status contract.

### Task 1: Approval preference and task lifecycle

**Files:** backend/src/superTabs/taskApproval.ts, taskApproval.test.ts, model.ts, commands.ts, proposalCards.ts, taskQueue.ts, parts/light.ts, parts/touches.ts; focused integration test.
**Interfaces:** approvalMode; taskApproval metadata; member.approvalMode and task.suggest/approve/reject commands as the spec defines.

- [ ] Commit tests for default/Review modes, Buddy consent, PM task staging, suggested agent changes, approval and rejection, exact own identity/generation, protected replays, assignment/start/dispatch refusal and unchanged auto mode.
- [ ] Observe failures; implement minimal guarded lifecycle and legacy-proposal card continuity.
- [ ] Run affected command/proposal/queue/dispatch/light/touch tests and typecheck; commit and push.

### Task 2: Personal Tasks summaries on first load and cursor changes

**Files:** backend/src/superTabs/read/personalTasks.ts, personalTasks.test.ts, contract.ts, service.ts; focused store/read integration test.
**Interfaces:** personalTasks {approvalMode, reset, upserts, removed}, row fields in shared spec; existing response cursor/epoch.

- [ ] Commit tests for own tasks/proposals, statuses and stable time order, project/agent identity, no hidden group/agent leak, removal/archive/reassignment, own-only preference, no agent feed, one-row/idle deltas and persisted API results.
- [ ] Observe failures; implement from existing loaded parts only, no extra whole-history reads.
- [ ] Run affected read tests and real-store integration, typecheck, diff checks and synthetic 1,000-task/one-row timing/size evidence; push.

### Task 3: Final acceptance and handoff

**Files:** plan validation notes and PR evidence only, unless a test-first review/CI fix is needed.
**Interfaces:** final PR head, tests, reviews, ci/required.

- [ ] Update spec/contract details to match tested implementation; send exact contract to sibling builders.
- [ ] Record red/green evidence and platform/rollback limitations in PR; mark Ready once.
- [ ] Two independent security reviews pass and ci/required green at final head; record acceptance and hand off for the 09:00 release. By 06:00 state any remaining release gap.
