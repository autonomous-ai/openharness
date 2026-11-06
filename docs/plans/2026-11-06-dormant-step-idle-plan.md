# Dormant Step Idle Reporting Implementation Plan

> Implement natively, task by task, with tests committed and observed failing before production code, followed by one independent PR review.

**Goal:** Let a finished step's agent reach routine idle handling after its done task becomes dormant and drops out of loaded state.

**Architecture:** Change only `checksOpenWork`'s idle decision to require a loaded, unfinished parent. Keep `taskEnded` fail-closed for archival and review closing. All open tasks are loaded; dormant finished tasks can be absent.

**Tech Stack:** TypeScript, Vitest, existing Super Tab state model.

**Spec:** Swarm task #3729, conversation `4a7374c7ebf53a5ea5692d79` (Diego's 11-06 report).

## Global Constraints

- The archive pass never takes a step whose task is open.
- The Engineer's own idle reporting is unchanged.
- Preserve routine idle decisions: role-configured Reviewers/Testers are kept; other non-crew idle agents receive host-confirmed stop and an informational row.
- No schema, query, index, dependency or client changes.

## Review Focus

- Dormant finished parent absent after 25 hours: its finished step must not hold its agent busy.
- Loaded done or cancelled parent: same idle outcome as the absent-parent case.
- Loaded open parent: keep the step-only agent available and refuse to archive its steps.
- Missing parent: permit idle handling but keep archive and review closing fail-closed.
- Agents holding their own open task: retain current idle protection even if they also hold steps.

## Task 1: Distinguish idle handling from archive safety

**Files:**
- Modify: `backend/src/superTabs/steps.ts`
- Test: `backend/src/superTabs/tidy.test.ts`

**Interfaces:**
- Consumes: `SuperTabState.conversations` and loaded groups held by an agent.
- Preserves: `checksOpenWork(state, groups, agentId): boolean`; `taskEnded` and all callers retain their signatures.

- [x] Add `reports a step-only Reviewer idle once its done task sleeps`: a legacy role agent assigned only a finished Review step receives one idle row at 25 hours with the parent absent. Loaded done/cancelled controls produce the same row; tidying off does not suppress it.
- [x] Add configured Reviewer/Tester controls: absent finished parent reaches routine keep handling without a stop.
- [x] Add open-parent and missing-parent archive controls; own-task Engineer control remains unchanged.
- [x] Commit tests and run `npm --prefix backend test -- src/superTabs/tidy.test.ts`; observe absent-parent cases fail because no idle decision occurs.
- [x] In `checksOpenWork`, only consider a parent still open if it is loaded and `taskEnded` is false. Explain why idle can infer absence while archive cannot.
- [x] Run tidy, steps, sweeps, liveness and commands unit tests plus backend typecheck. Full backend and four Super Tab integration shards run in ready PR CI.
- [x] Commit production fix, push, record red/green evidence, mark ready and request the independent review through task status (handoff actions follow this commit).
