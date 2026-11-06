# Agents answer people in the message's thread: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** In a project set to answer in threads, every agent's answer to a person's message goes in that message's thread,
so answers no longer stack in the main chat apart from their questions (task #3747, requested by Dee through Harness: "i
don't know which one you reply to which... why don't you answer in those replies as threads?"). Other projects are unchanged.

**Architecture:** A project setting, `SwarmProject.answersInThread` (projects.ts), set with a new command `project.answers`
{ projectId, inThread } by the project's coordinator or a person who manages the project, as `project.coordinatorName` is.
Three places follow it:

1. The server (commands.ts `placeAnswer`): a `message.send` that `answers` a person's main-chat message in such a project is
   posted as a reply in that message's thread (`replyTo`), so an older CLI's `--answers`, or an agent that ignores its reply
   line, still lands in the thread. Owed asks keep the message's own id as their thread (pulse.ts `owe`), so the reply
   settles it as an answer (`settleReply`), and `answer` records it.
2. The host (cli host.ts): a person's message in such a project gets the reply line `--reply-to MESSAGE`, and its rules say to
   answer every person's message in its thread.
3. Reads: the project field passes through every state read (read/views.ts), so the host sees it with no new read.

Main-chat posts that answer nothing (a release out, an outage) stay possible: only a post that names a person's message moves.

**Tech Stack:** TypeScript backend and CLI, vitest.

**Spec:** task #3747 brief.

## Global Constraints

- Per project; a project without the setting behaves exactly as before.
- An agent's message is answered as before (right below it, or in its thread).
- Swarm code stays out of cli/src/core.

## Design

- growth: one optional boolean on a project; nothing new grows.
- concurrency: the command writes the project in the Swarm's usual write.
- read cost: N/A because nothing new is read: the host reads the state it already reads per delivery.
- scale: N/A because it is a per-project flag.
- compatibility: an older host still writes `--answers`; the server puts it in the thread. An older server ignores nothing: the
  command is new, so an older server refuses it as unknown, and the setting waits for the release.
- migration + rollback: none; the flag is absent by default. Rollback leaves the flag stored and unread.
- audience: only the coordinator or a person who manages the project sets it (the server checks).
- identity: N/A because no new identity is used.
- failure: a host that cannot read the state writes `--answers`, and the server still threads it.
- platforms: backend and CLI; Desktop shows thread replies as it does.

## Review Focus

- Only a post answering a person's main-chat message moves; a post answering nothing stays in the main chat.
- The moved post settles the owed ask and is recorded as the answer.

## Task 1: the setting, and the server threads answers

**Files:** backend/src/superTabs/projects.ts, backend/src/superTabs/commands.ts, backend/src/superTabs/answers.test.ts

- [ ] Test: in a project set to answer in threads, a plain `--answers` post and an `answer` on a person's main-chat message land
  in its thread and settle it; an agent's message, a post answering nothing, and other projects behave as before; only the
  coordinator or a manager sets it.
- [ ] Watch it fail; commit.
- [ ] Code; watch it pass; commit.

## Task 2: the reply line says --reply-to

**Files:** cli/src/superTabs/host.ts, cli/src/superTabs/host.spec.ts

- [ ] Test: in such a project a person's main-chat message gets `--reply-to MESSAGE` and the thread rule; other projects keep
  `--answers`.
- [ ] Watch it fail; commit.
- [ ] Code; watch it pass; commit.
