# Agent posts reach only who they name Implementation Plan

> Implemented by the task's Engineer task by task, each failing test committed before its code (project instructions,
> Engineer). One independent review on the pull request.

**Goal:** The PM is delivered an agent's post only when the post names it (task #2963, Ken, 2026-11-04). In a day of
production data the PM got 841 deliveries, 420 of them agent posts; 402 of 437 agent posts reached the PM as their only
recipient and only 1 named it.

**Architecture:** `message.send` in `backend/src/superTabs/commands.ts` decides an agent post's recipients on the
server, so every CLI, old or new, gets the same rule. Today an unnamed agent post falls back to a default addressee:
the coordinator, the task's owner, or the assignee, through five overlapping rules (`leadToWorker`, `workerToLead`,
`ownerToStepAgent`, `memberToLead`, the step owner). They are replaced by one rule:

- An agent post reaches the agents it names: `--to` (recipientIds) and `@Name` of an agent in the conversation
  (`mentions.ts`, an agent's display name or name, matched only when exactly one agent there has it and no person's
  username is the same).
- A reply reaches the agent who wrote the message it answers, when that agent reads the conversation.
- A post that names no one in a task or step reaches its current assignee, unless the poster is the assignee (River's
  ruling in the task thread, 2026-11-04: the worker owns that room).
- Nothing else: no default to the coordinator, the task's owner or anyone in the project chat. The post stays readable
  in its conversation and people's tags and thread notices are unchanged.

Status notices (done, needs_human, blocked, lost, stalled) are built by `work.status` and the liveness sweep, not by
`message.send`, so they still reach the PM. The PM-to-worker loop guard (`leadWorkerBounced`, `PAIR_CHAIN_LIMIT`) only
existed because worker posts bounced back to the PM by default; with the assignee's unnamed post reaching no one there is
no automatic round trip, so it is removed. The 20-message pair notice stays.

**Tech Stack:** TypeScript, vitest (backend unit tests on the in-memory command model), the CLI's skill texts.

**Spec:** task #2963's brief and River's ruling in its thread.

## Global Constraints

- Server-side only for delivery: older CLIs send the same `message.send` and get the new rule.
- People's deliveries (a person's post, tags, thread notices) do not change.
- Swarm code stays out of `cli/src/core`.
- No new stored data.

## Design

- growth: N/A because nothing new is stored; deliveries only shrink.
- concurrency: N/A because recipients are computed inside the existing command transaction.
- read cost: N/A because no read is added; `@Name` matching reads only the conversation's own agents, and only for a
  post that says `@`.
- scale: fewer deliveries per post; the warning metric is the PM's deliveries per hour, measured in the fixture below.
- compatibility: old clients send the same command; the server decides. An old CLI's help still says unnamed posts reach
  the PM; its delivered prompt already names the author with `--to` when replying, so its replies still arrive.
- migration + rollback: none; revert the commit.
- audience: the server picks recipients; a named agent must still be one the sender may name (`requireNameable`).
- identity: N/A because no login is used.
- failure: an unnamed post is not lost: it stays in its conversation for people and agents who read it. The skill texts
  and help say to name whoever must act.
- platforms: backend (Linux), the CLI's skill texts on every platform.

## Review Focus

- Every default to the coordinator is gone, including in steps, the project chat and for an agent whose task ended.
- A thread reply reaches its author agent; a reply to an agent that does not read the conversation is not forced in.
- `@Name` never shadows a person's tag and never resolves an ambiguous agent name.
- Status notices still reach the PM.

## Task 1: one rule for an agent post's recipients

**Files:** `backend/src/superTabs/commands.ts`, `backend/src/superTabs/mentions.ts`, `backend/src/superTabs/commands.test.ts`,
`backend/src/superTabs/steps.test.ts`

- [ ] Failing tests: an unnamed post in a task by its assignee or another agent reaches no agent; one naming the PM
      reaches only the PM; one naming another agent reaches only it; `@Name` names an agent; an unnamed post by the PM or
      an Engineer reaches the assignee; a thread reply reaches the author agent; in a step, an unnamed post by the
      Reviewer reaches nobody and the Engineer's reaches the Reviewer; in the project chat an agent's line reaches nobody.
- [ ] Watch them fail.
- [ ] Replace the five defaults with the rule above; remove `leadWorkerBounced` and `PAIR_CHAIN_LIMIT`.
- [ ] Update the existing tests that asserted the old defaults.

## Task 2: status still reaches the PM

**Files:** `backend/src/superTabs/commands.test.ts`

- [ ] A test that done, needs_human, blocked and lost notices still reach the coordinator after the change (passes on
      both sides; it guards the rule).

## Task 3: the PM's deliveries per hour

**Files:** `backend/src/superTabs/commands.test.ts`

- [ ] A fixture day shaped like Ken's data (assignee reports, verdicts, acknowledgements, project-chat lines, one post
      naming the PM, a few replies to the PM) counts the PM's deliveries per hour. Run on main for the before number, on
      the branch for the after.

## Task 4: the texts say the new rule

**Files:** `cli/src/lib/swarmTools.ts`, `cli/src/lib/swarmSkills.ts`, `cli/src/superTabs/service.ts` (post help),
`cli/src/superTabs/command.ts`, `cli/src/superTabs/host.ts` (comments), `backend/src/superTabs/instructionsTemplate.ts`
(workflow), `backend/src/superTabs/commands.ts` (project-chat refusal text), and their specs.

- [ ] Failing spec lines for the new wording in swarmTools and swarmSkills.
- [ ] Rewrite "Who a post reaches" in swarm-tools and each role skill (Lead, Engineer, Reviewer, both sets); the post
      help; the workflow template: verdicts go to the Engineer by name, results reach the PM through status, never by a
      post to the PM.
