# Agents ask people through the PM: implementation plan

> Written by the writing-plans skill. The Engineer implements it task by task, test first (test-driven-development).

**Goal:** Only the PM reaches people. When any other agent tags a person, needs a person, asks a person a decision or sends
a person a line, that becomes a crew need in the PM's inbox, and the agent is told it was routed there. The person is not
notified. This is routing, not a refusal (anh Dee, 2026-11-05; task #3404).

**Architecture:** A new module, `backend/src/superTabs/crewNeeds.ts`, decides who routes and builds the crew-need row.
`commands.ts` calls it from `message.send`, `work.status` (needs_human), `decision.ask` and `person.tell`. A crew need is a
message row with source kind `crew-need`, to the coordinator alone (`NOTICE_READERS` `recipients`), delivered at once (not
in `DIGEST_KINDS`). An agent's needs_human is the status row it already writes to the PM, now with `source.crewNeed` set.
`crewNeedOf(source)` reads both shapes for the inbox (#3403).

**Tech Stack:** TypeScript, vitest, the Super Tab command reducer (`applyCommand`).

**Spec:** the task brief of #3404 and River's ruling in the task (2026-11-05):
- The PM may tag anyone. Any other agent may tag only the person it is answering: the author of the message it answers
  (`--answers`) or replies to (`--reply-to`).
- Every other tag, and an agent's needs_human, decision.ask or person.tell, becomes a crew need for the PM.
- Without a PM in the project (no coordinator in its chat), everything stays as today.
- The 30-minute "PM owes it" rule belongs to the owed-asks task; crew-need rows carry enough for the inbox to list them.

## Global Constraints

- No new `*_FORBIDDEN` code; `removedRefusals.test.ts` stays green. A routed post, status, ask or tell succeeds.
- People's own tags still notify.
- A person's reply to an agent still reaches that agent.
- Swarm code stays in `backend/src/superTabs/`.

## Design

- growth: crew needs are message rows, deleted with their conversation like any message; no new collection.
- concurrency: written inside the command's transaction, like every message.
- read cost: no new read; one scan of the project's chat for its coordinator, already in state.
- scale: one row per routed post; at 10x posts the PM's turn count is the first warning, and the inbox (#3403) batches.
- compatibility: an older app shows a `crew-need` row only to its recipient (agent-only by kind); an older server ignores
  `source.crewNeed`.
- migration + rollback: none; rolling back only lets agents' tags reach people again.
- audience: the server decides routing from the actor, never from the client.
- identity: routing keys on the agent id and the project's coordinator, never a machine owner's login.
- failure: the agent's command result says where its tag or question went (`routedToPm`); with no PM, nothing routes.
- platforms: server only.

## Review Focus

- Every agent path that reached a person directly is covered: text tags, `--mention`, `mentionsIfNoWorker`, needs_human
  with or without ask, decision.ask, person.tell.
- The answered-person exemption cannot be used to tag anyone else.
- People's own tags and replies to agents behave as before.

## Task 1: Agent tags become crew needs

**Files:** `backend/src/superTabs/crewNeeds.ts` (new), `crewNeeds.test.ts` (new), `commands.ts` (message.send), `model.ts`
(`NOTICE_READERS`).

**Interfaces:** `coordinatorFor(state, group): { agentId, conversationId } | null`; `routesToPm(state, actor, group): boolean`;
`crewNeedOf(source): CrewNeed | null`; `CREW_NEED_KIND = 'crew-need'`.

- [ ] Failing test: a worker's tag (text and picked) writes no mention for the person; a crew-need row reaches the PM; the
  result says it was routed.
- [ ] Failing test: the PM's tag still tags; a person's tag still tags; a worker's tag of the person it answers still tags.
- [ ] Failing test: with no PM in the project, a worker's tag still tags.
- [ ] Regression test: a person's reply to an agent's message still reaches that agent.
- [ ] Implement.

## Task 2: needs_human, decision.ask and person.tell become crew needs

**Files:** `crewNeeds.ts`, `crewNeeds.test.ts`, `commands.ts` (work.status, decision.ask, person.tell).

- [ ] Failing test: a worker's needs_human with ask opens no decision; its status row to the PM carries `crewNeed` with the
  person, question and options; the result says it was routed.
- [ ] Failing test: a worker's decision.ask opens no decision and writes a crew need; the PM's still opens one.
- [ ] Failing test: a worker's person.tell writes nothing in the person's Buddy chat and writes a crew need; the PM's still
  reaches them.
- [ ] Implement.
