# Holding a task needs a reason (#3390) Implementation Plan

> Built the project's way (Engineer, test first, one pull request), not subagent-driven-development. No handoff step.

**Goal:** A task held for later, blocked or waiting on a person carries one of four reasons, shown on the task, and a hold
with none is refused with `HOLD_REASON_MISSING`, which lists the four kinds.

**Architecture:** One new module, `backend/src/superTabs/heldReason.ts`: the reason's schema (a discriminated union of four
kinds), a fact check against the Swarm, the refusal, and `heldView`. `work.queue` (with `notBefore`) and `work.status`
(`blocked`, `needs_human`) take an optional `hold` in their schema and require it when applied; it is stored on the task
(`Conversation.hold`) or the assignment (`Assignment.hold`) and shown as `held` in the group view, `{kind:'none'}` for a
hold from before reasons.

**Tech Stack:** TypeScript, zod, vitest (`npm test -- <path>`).

**Spec:** the task brief of #3390 (Dee's Swarm redesign, 2026-11-05).

## Global Constraints
- New guard, new name: `HOLD_REASON_MISSING`. `removedRefusals.test.ts` stays green.
- No numbers in constants: the reasons carry their own times (`defaultAt`, `at`); the server adds none.
- The release window never holds building or merging: nothing here reads it.
- `model.ts` gains fields: `parts/light.ts` and its test place them (light.test.ts fails otherwise).
- Staged (review of #3215, ENGINEERING.md §5): `blocked` and `needs_human` from today's CLI carry no `hold`, so they are accepted without one and shown as `none`; a `hold` that is sent is checked. `work.queue` (the PM's own call) already refuses a not-before date without one. The refusal for statuses follows once the CLI's examples, rules text and skill send `hold`.
- "Waits on a person already asked" checks that the person is a member, not that a decision to them is open (decisions live outside the Swarm state). A reason's time must still be ahead; a task reason must name a task, not a step.
- No new collection, index or stored shape outside the existing Swarm parts.

## Review Focus
- Every `blocked` / `needs_human` caller (agents, tests) now sends a `hold`; old agents get a refusal that says what to send.
- A reason that is not true (unknown task, stranger, a requester nobody has) is no reason.
- Clearing: `notBefore: null` and any later status remove the reason.

### Task 1: The reason and its refusal
**Files:** Create `backend/src/superTabs/heldReason.ts`; modify `commands.ts`, `model.ts`, `parts/light.ts`, `read/contract.ts`, `read/views.ts`.
**Interfaces:** `heldReason` (zod), `HeldReason`, `checkReason(state, group, reason)`, `missingReason()`, `heldView(group)`.
- [ ] Failing tests in `commands.test.ts` "a held task carries one of four reasons": each reason accepted and shown on `work.queue`, `blocked`, `needs_human`; no reason refused with the four kinds; untrue reasons refused; cleared by `notBefore: null` and the next status; legacy holds show `none`.
- [ ] Implement until they pass; update existing callers of `blocked` / `needs_human` to send a reason.
