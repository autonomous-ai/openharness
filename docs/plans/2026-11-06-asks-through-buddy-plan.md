# An agent's ask reaches the person through their Buddy: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** In a switched project, an agent that needs a person's answer asks them directly: the question reaches their
default Buddy and their Needs you list, with a default and a time, and never goes through the PM; past the time the default
applies, unless the ask says the person must agree (task #3826, requested by Dee through Harness; spec
docs/plans/2026-11-06-buddy-board-final-spec.md, "When an agent needs a person"). Projects not switched are unchanged.

**Depends on:** #3818 (several Buddies: `defaultBuddyChat`) and #3819 (the project switch, `SwarmProject.boardMode`). Code
starts once both are on main; this plan is the draft's first commit.

**Architecture:** Today an agent's `work.status needs_human` with an `ask` goes to the PM as a crew need (crewNeeds.ts
`routesToPm`), "people talk only to the PM". The path that asks the person already exists beside it: `askDecisions` opens a
decision for them (decisions.ts), with an optional `defaultAt` that the overdue sweep applies when due
(store.ts leaveOverdueDecisions, `dueDefaultDecisions`). In a project with `boardMode`:

1. The ask takes the direct path: no crew need, no PM in the row's recipients; the task's `askedOf` mark (already kept) is
   what the PM sees.
2. The ask must carry `defaultAt` (refused with what is missing otherwise), and may carry `mustAgree: true`, which keeps the
   default from applying: past its time the decision stays open and the PM is told once (a notice, not the question).
3. The question is posted in the person's default Buddy chat (`defaultBuddyChat`), addressed to their Buddy, which answers
   from its context or asks its person (the Buddy's existing decision rights); the decision is in their Needs you list (the
   person's open decisions, which Desktop's bar reads, #3820).

**Tech Stack:** TypeScript backend, vitest.

## Global Constraints

- Projects without `boardMode` behave exactly as today: crew need to the PM.
- The server enforces it: the person answers their own decision; their Buddy answers within its existing rights.
- Swarm code stays out of cli/src/core.

## Design

- growth: decisions are already capped per person (MAX_OPEN_DECISIONS) and expire as today; one Buddy-chat line per ask.
- concurrency: the ask is the task's own status write; the default applies in the overdue sweep's conditional write, which a
  person's answer in the same second wins, as today.
- read cost: none new; the sweep's indexed read of due decisions is unchanged.
- scale: 10x asks is 10x decisions, bounded per person by the cap; the first warning is people's open decisions at the cap.
- compatibility: an older CLI sends an ask without `defaultAt` and is refused in a switched project with what to add; older
  apps read the decision and the Buddy-chat line as today.
- migration + rollback: none; rollback routes asks to the PM again.
- audience: the decision is the person's own; the Buddy chat is read by them and their Buddy only.
- identity: the agent asks as itself; the answer is the person's, or their Buddy's on their behalf, as today.
- failure: an ask refused says why; a must-agree decision past its time tells the PM once.
- platforms: backend.

## Review Focus

- A project not switched routes exactly as before.
- No path lets the default apply to a must-agree decision.

## Task 1: in a switched project an ask goes to the person, through their default Buddy

**Files:** backend/src/superTabs/{commands.ts, crewNeeds.ts, decisions.ts}, backend/src/superTabs/decisions.test.ts

- [ ] Test: in a switched project, an agent's needs_human ask opens a decision for the person with its default and time,
  posts the question in their default Buddy's chat, and sends nothing to the PM; without `defaultAt` it is refused; in a
  project not switched it is the PM's crew need, as today.
- [ ] Watch it fail; commit. Code; watch it pass; commit.

## Task 2: the default applies at its time, unless the person must agree

**Files:** backend/src/superTabs/{decisions.ts, overdueDecisions.ts, store.ts}, backend/integration/overdueDecisions.test.ts

- [ ] Test: past its time the default answers the decision and the agent hears it; a `mustAgree` one stays open and the PM is
  told once.
- [ ] Watch it fail; commit. Code; watch it pass; commit.
