# An agent whose model keeps failing gets no new work: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** An agent whose engine reports that its model keeps failing gets no new task or step until it answers again; the route
marks it; its PM and its machine's owner are told once, with the reason when the machine's reading has one (task #4076,
found by the PM 11-06: seven Codex Testers on daniel-pc, signed out of ChatGPT, kept being handed Linux steps that each sat
30 minutes and were lost, a dozen times).

**Architecture:** `Agent.modelFailing` ({ since, reason? }): set by the agent's `model` terminal alert (terminal.ts), which
already loses its task; kept when the alert's episode ends, since a quiet screen is not an answer; cleared only by the agent's
own report (work.status, work.check, or a post that is not an agent-only notice). While it is set: dispatch.ts freeCrew skips
it (lane dispatch and lost steps), reviewerPick.ts skips it (a handed task's steps), work.assign refuses MODEL_FAILING, and
route.record moves a member candidate to its exclusions with the reason. The alert row the PM already gets is written once per
failure, not per episode, says what the machine's reading shows (the engine signed out there) and that the agent gets no new
work until it answers, and tags the machine's owner where they can read it.

**Tech Stack:** TypeScript backend (vitest). **Spec:** task #4076 brief.

## Global Constraints

- Never stop or remove the agent: only stop giving it work. It gets work again with its first answer.
- Owns backend/src/superTabs/.

## Design

- growth: one small field per failing agent, cleared on its answer, gone with the agent.
- concurrency: inside the alert's and the answer's own command writes.
- read cost and scale: one more check in candidate filters that already walk the agents.
- compatibility: a new optional agent field and refusal code; readers ignore what they do not know.
- migration and rollback: none; revert.
- audience: the owner is tagged only where they can read the row.
- identity, platforms: N/A because nothing runs as anyone new; backend only.
- failure: this is the failure being made seen.

## Task 1: model failing is a lasting mark that keeps work away

**Files:** model.ts, terminal.ts, commands.ts, dispatch.ts, reviewerPick.ts, modelFailing.test.ts (new).

- [ ] Tests: after the model alert, the agent is skipped by lane dispatch, by a step's pick and by the route, and work.assign
      refuses it, also once the alert's episode ended; one answer of its own offers it work again; the PM and the machine
      owner are told once, with the signed-out engine.
- [ ] Watch them fail; code; watch them pass; commit.
