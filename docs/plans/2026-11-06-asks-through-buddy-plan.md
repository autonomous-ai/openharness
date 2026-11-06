# An agent's ask reaches the person through their Buddy: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** In a switched project, an agent that needs a person's answer asks them directly: the question reaches their
default Buddy and their Needs you list, with a default and a time, and never goes through the PM; past the time the default
applies, unless the ask says the person must agree (task #3826, requested by Dee through Harness; spec
docs/plans/2026-11-06-buddy-board-final-spec.md, "When an agent needs a person"). Projects not switched are unchanged.

**Depends on:** #3818 (several Buddies: `defaultBuddyChat`) and #3819 (the project switch, `SwarmProject.boardMode`). Code
starts once both are on main; this plan is the draft's first commit.

**Architecture:** Today an agent's ask of a person (a `work.status needs_human` with an `ask`, or a `decision.ask`) goes to
the PM as a crew need (crewNeeds.ts `routesToPm`), "people talk only to the PM". The path that asks the person already
exists beside it: `askDecisions` opens a decision for them (decisions.ts), with an optional `defaultAt` that the sweep
applies when due (store.ts leaveOverdueDecisions, `dueDefaultDecisions`). In a project with `boardMode` (boardRights.ts
`switched`):

1. Both asks take the direct path: no crew need, and a needs_human status row with a direct ask reaches no PM; the task's
   `askedOf` mark (already kept) is what the PM sees.
2. Each question must carry `defaultAt` (refused with what is missing otherwise), and may carry `mustAgree: true`.
3. Each question is posted in the person's default Buddy chat (`defaultBuddyChat`), addressed to their default Buddy
   (`defaultBuddy`), source kind `decision-asked`, marked with its project; the decision is in their Needs you list (the
   person's open decisions). The Buddy cannot answer for them (`answerable` takes the person only): it brings it to them.
4. At `defaultAt` the sweep answers with the recommendation, as today. A `mustAgree` decision is not answered: the PM is
   told once in the decision's conversation (source `decision-must-agree`, its alone), and its `defaultAt` is cleared in
   the same write so the due range never reads it again; the 24-hour legacy sweep skips `mustAgree` rows, so it waits for
   the person until answered or withdrawn with its work.

**Tech Stack:** TypeScript backend, vitest.

## Global Constraints

- Projects without `boardMode` behave exactly as today: crew need to the PM.
- The server enforces it: the person answers their own decision; their Buddy answers within its existing rights.
- Swarm code stays out of cli/src/core.

## Design

- growth: decisions are already capped per person (MAX_OPEN_DECISIONS) and expire as today; one Buddy-chat line per question;
  one optional `mustAgree` field per decision row, deleted with the row.
- concurrency: the ask is the task's own status write; the default applies in the overdue sweep's conditional write, which a
  person's answer in the same second wins, as today.
- read cost: none new; both sweep reads keep their indexes (`decision_waiting_default`, `decision_waiting_created`), with
  `mustAgree` a residual filter on the legacy one only.
- scale: 10x asks is 10x decisions, bounded per person by the cap; the first warning is people's open decisions at the cap.
- compatibility: `mustAgree` extends the ask's contract (optional); an older CLI sends an ask without `defaultAt` and is
  refused in a switched project with what to add; older apps read the decision and the Buddy-chat line as today.
- migration + rollback: none (an optional field); rollback routes asks to the PM again, and a `mustAgree` row with its
  `defaultAt` cleared then falls to the legacy 24-hour sweep.
- audience: the decision is the person's own; the Buddy chat is read by them and their Buddy only.
- identity: the agent asks as itself; the answer is the person's, or their Buddy's on their behalf, as today.
- failure: an ask refused says why; a must-agree decision past its time tells the PM once.
- platforms: backend.

## Review Focus

- A project not switched routes exactly as before.
- No path lets the default apply to a must-agree decision.

## Task 1: in a switched project an ask goes to the person, through their default Buddy

**Files:** backend/src/superTabs/{commands.ts, decisions.ts, model.ts}, backend/src/superTabs/asksThroughBuddy.test.ts

**Interfaces:** `askedThroughBuddy(state, group, drafts, author)`: the Buddy-chat lines for drafts in a switched project
(decisions.ts); `checkSwitchedAsk(question)`: refuses a question with no `defaultAt`.

- [ ] Test: in a switched project, an agent's needs_human ask and its decision.ask each open a decision for the person
  with its default and time, post the question in their default Buddy's chat addressed to that Buddy, send nothing to the
  PM, and keep `askedOf`; without `defaultAt` each is refused; in a project not switched both are the PM's crew needs, as
  today.
- [ ] Watch it fail; commit. Code; watch it pass; commit.

## Task 2: the default applies at its time, unless the person must agree

**Files:** backend/prisma/schema.prisma, backend/src/superTabs/{decisions.ts, overdueDecisions.ts, commands.ts, store.ts,
model.ts}, backend/integration/overdueDecisions.test.ts

- [ ] Test: past its time the default answers a switched project's decision and the agent hears it; a `mustAgree` one
  stays open, the PM is told once, the next pass and the 24-hour sweep take nothing, and the person can still answer.
- [ ] Watch it fail; commit. Code; watch it pass; commit.
