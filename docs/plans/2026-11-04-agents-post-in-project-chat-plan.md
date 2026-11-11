# Agents post in the project chat — plan (task #2924)

> Written by the writing-plans skill as the project's instructions direct. The Engineer implements it here, task by task,
> test first; there is no execution handoff.

**Goal:** An agent with a task or step in a project posts top-level messages and thread replies in that project's chat
without joining it, so the agent doing the work answers people in the room itself (Dee, 2026-11-04; instructions rev 66,
"Talking in the project chat").

**Architecture:** One new access rule in `backend/src/superTabs/commands.ts`: `postable` lets such an agent post in its
project's chat and returns the chat without adding it to `agentIds`. Nothing else changes: joining the project chat (a
post's `--to`, `conversation.agent`, `agent.add`, `agent.start`, `work.assign`) stays refused by `projectChatJoin`
(#2207), reactions stay members-only, and the post's default addressee is unchanged (the coordinator, as for any agent's
unnamed post in a group it leads). Clients already draw an agent's post by its author and the Swarm's agent list, and
Desktop's terminal button lists `paneAgentIds`, the coordinator alone in a project chat.

**Tech Stack:** TypeScript backend (Vitest), CLI help text (TypeScript), Desktop Flutter widget test for the screenshots.

**Spec:** Task #2924's brief (conversation 549c1361f45e59012e1dd36c).

## Global Constraints

- Security-sensitive (who may write where): two independent security reviews.
- Keep #2207's guarantees: no member added to the project chat, no second terminal there.
- Refused, as today: agents of other projects, agents of this project with no task or step here, Buddies, a stopping
  agent; adding any agent to the project chat.
- Swarm code stays out of `cli/src/core`.

## Design

- growth: N/A because it stores nothing new; a post is an ordinary message row.
- concurrency: the post writes only the project chat's group, as any post does; the rule reads the agent's own task
  groups from the same loaded state.
- read cost: one pass over the loaded (non-dormant) groups, only for a non-member agent's post in a project chat.
- scale: 10x groups is a 10x scan of an in-memory list per such post; the command's latency metric warns first.
- compatibility: old CLIs send the same `message.send`; old clients draw the post like any agent's post.
- migration + rollback: none; rollback is a revert, and posts already written stay readable.
- audience: the server decides (`postable`), for the CLI, Desktop and the phone alike.
- identity: the actor is the agent itself (`projectAgent` checks its host speaks for it), never the machine owner.
- failure: a refused agent gets a 403 that says who may post there and where to post instead.
- platforms: backend only; every client renders the row it already renders.

## Review Focus

- `postable` must never push the agent into a project chat's `agentIds`; `message.send` must not run `teamJoin` for it.
- Which assignments count as "a task or step in the project": assigned to this agent, not lost, cancelled or stopped, in a
  non-archived group of the same project. A done task counts until it archives with its merged pull request, so its agent
  posts its result line (decided after both security reviews asked; pinned by a test).
- A person's answer reaches the agent only while that agent works in the project, rechecked when its host polls and claims.

## Task 1: a working agent posts in the project chat without joining it

**Files:** `backend/src/superTabs/commands.ts`, `backend/src/superTabs/commands.test.ts`

**Interfaces:** `postable(state, actor, conversationId)` (same signature); new `worksInProject(state, project, agentId)`.

- [ ] Test: an Engineer assigned a task posts a top-level line and a thread reply in the project chat; the chat's
  `agentIds` is unchanged and the post reaches the coordinator. A Reviewer holding a step does the same.
- [ ] Test: refused there — an agent of another project, an agent of this project with no task, an agent whose task was
  cancelled or lost, a Buddy; naming a non-member with `--to` and `conversation.agent` still refuse
  `PROJECT_CHAT_COORDINATOR_ONLY`; the chat's members are unchanged.
- [ ] Run them, see the posting test fail (`FORBIDDEN`).
- [ ] Commit the tests.
- [ ] Implement the rule in `postable` and skip `teamJoin` when the poster did not join.
- [ ] Run `commands.test.ts`, `projects.test.ts`, `steps.test.ts`; commit.

## Task 2: CLI post help

**Files:** `cli/src/superTabs/service.ts`, its spec if one pins the text.

- [ ] Test: post help says an agent with work in the project may post in its project chat without joining it, and that
  `--to` there names only its coordinator.
- [ ] See it fail; commit.
- [ ] Change `POST_ABOUT`; run the spec; commit.

## Task 3: Desktop screenshots

**Files:** `desktop/test/super_tab_project_chat_agent_post_shots_test.dart`

- [ ] Widget test over the in-memory Swarm: the project chat shows a working Engineer's post with its name and engine
  mark, and the terminal button lists only the coordinator; light and dark screenshots when
  `SUPER_TAB_AGENT_POST_SHOTS` names a folder.
- [ ] Run it; attach the screenshots to the task.

## Task 4: reactions and a person's answer (River, 2026-11-04, added to #2924)

**Files:** `backend/src/superTabs/commands.ts`, `store.ts`, `parts/light.ts`, `commands.test.ts`,
`integration/superTabProjectChatWorkers.test.ts`, `cli/src/superTabs/service.ts`, `cli/src/lib/swarmTools.ts`

- [x] Tests: an agent with work reacts in the project chat without joining; refused agents are refused a reaction too.
- [x] Tests: a person's thread reply to such an agent's line reaches that agent alone; a top-level line right below it
  reaches that agent and the coordinator (a new ask there may be the coordinator's); after its work ends, the coordinator
  alone. Lost, stopped, archived refused; done counts until archived; a Team account's post marks nothing.
- [x] `message.react` uses `worksInProjectChat`; `message.send` routes a person's answer to it without joining it.
- [x] Store: reads the newest top-level row above a person's top-level post in a project chat (sequence index, at most 20
  rows); hands such an agent its delivery while it works in the project; a claim loads that agent's groups only when it is
  not a member of the chat.
- [x] Integration test: the agent's host claims both answers, and a waiting one is revoked once its work ends; the read
  above is an index scan examining at most 20 rows.
