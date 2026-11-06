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

- [x] Commit tests for default/Review modes, Buddy consent, PM task staging, suggested agent changes, approval and rejection, exact own identity/generation, protected replays, assignment/start/dispatch refusal and unchanged auto mode.
- [x] Observe failures; implement minimal guarded lifecycle and legacy-proposal card continuity.
- [x] Run affected command/proposal/queue/dispatch/light/touch tests and typecheck; commit and push.

### Task 2: Personal Tasks summaries on first load and cursor changes

**Files:** backend/src/superTabs/read/personalTasks.ts, personalTasks.test.ts, contract.ts, service.ts; focused store/read integration test.
**Interfaces:** personalTasks {approvalMode, reset, upserts, removed}, row fields in shared spec; existing response cursor/epoch.

- [x] Commit tests for own tasks/proposals, statuses and stable time order, project/agent identity, no hidden group/agent leak, removal/archive/reassignment, own-only preference, no agent feed, one-row/idle deltas and persisted API results.
- [x] Observe failures; implement from existing loaded parts only, no extra whole-history reads.
- [x] Run affected read tests and real-store integration, typecheck, diff checks and synthetic 1,000-task/one-row timing/size evidence; push.

### Task 3: Final acceptance and handoff

**Files:** plan validation notes and PR evidence only, unless a test-first review/CI fix is needed.
**Interfaces:** final PR head, tests, reviews, ci/required.

- [x] Update spec/contract details to match tested implementation; send exact contract to sibling builders.
- [x] Record red/green evidence and platform/rollback limitations in PR; mark Ready once.
- [ ] Two independent security reviews pass and ci/required green at final head; record acceptance and hand off for the 09:00 release. By 06:00 state any remaining release gap.

## Validation before review

- Approval tests were committed before implementation. Corrected fixture setup separately; the supported-mode/command cases then failed against the old backend. Additional red tests caught duplicate legacy conversion, losing the approved worker before preparation, merging away approval, closing a mirror, and unsanitized rejection reasons. Each production fix follows its test commit. The final child-step test fails before the parent gate is checked, then passes once creation waits for approval. The rejection test also fails when its scrub hook is removed, and passes with it restored.
- Focused affected units: 600 passed across 11 files before the last two narrow lifecycle/credential cases; the final approval/credential/commands run passed 486 tests after those fixes and the review-step fence. Backend typecheck and diff checks clean.
- Isolated real-store proposal suite: 14 passed. Includes new-member mode persistence, Review staging, direct-person decisions and receipt replay checks, project revocation/reload, legacy PM delivery and dormant mirror conversion refusal, and both approval modes through normal store assignment. Full units/four integration shards are CI evidence after Ready.
- Synthetic projection only, 1,000 active tasks (100 iterations, no database): initial 211,848 bytes, mean 0.228 ms; one changed row 277 bytes, 0.00039 ms; idle 70 bytes, 0.00061 ms. This measures the new projection, not end-to-end API latency. Feed reads add no queries. Legacy conversion/close adds one bounded existing message-id lookup to name a possibly dormant mirror; existing indexed group loading/guards persist it.
- Decisions never start work themselves. They notify the PM, and the existing work.assign store path enforces all repository/account/machine/global-session checks. The selected worker binds the first assignment; ordinary recovery after an actual assignment retains existing policy. Review proposal merges are refused to preserve each person's decision.
- No credential/login reads, schema change, production read/write, native process or visible UI change. Desktop owns light/dark UI evidence. Backend must not roll back to a version that ignores Review metadata while such tasks exist; compatible fix forward or explicit decision/drain first. Coordinated release remains held until 09:00 VN.
