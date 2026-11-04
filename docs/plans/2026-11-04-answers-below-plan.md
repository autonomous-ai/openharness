# Answers go right below, not in a thread: implementation plan

**Goal:** An agent answers a top-level chat message right below it, in the main flow, and the Swarm still counts its
delivery of that message as answered. Threads open only for a back-and-forth on one topic, an answer to something far up,
or a message that is already in a thread (anh Dee, 2026-11-04; project instructions rev 66, "Talking in the project chat").

**Architecture:** `message.send` gains an optional `answers: MESSAGE_ID`. It settles the poster's own deliveries of that
message exactly as `replyTo` does today (store.ts), routes the post as a reply to that message would be routed
(commands.ts), and writes the row with `replyTo: null`, so no thread opens. The CLI's `post` gains `--answers MESSAGE_ID`;
each delivery's prompt (host.ts) tells the agent which one to use: `--answers` for a top-level message, `--reply-to` for
a message inside a thread or a Buddy session's thread. The skill texts say the same.

**Tech Stack:** TypeScript backend (zod commands, Prisma/MongoDB), TypeScript CLI (vitest), Desktop Flutter launch prompt.

**Spec:** task #2929's brief (conversation 9e6d39c3e87fca905a3ae75e).

This plan is carried out by its Engineer, task by task, each failing test committed before its code (project
instructions, Engineer). There is no execution handoff.

## Global Constraints

- Older CLIs keep sending `replyTo` and keep working: nothing about `replyTo` changes.
- A newer CLI against an older backend (one that refuses the unknown `answers` key) falls back to `replyTo`, which still
  settles the delivery; the post then opens a thread, as today.
- No schema change: the answer is recorded on the delivery (`status: 'answered'`), which page reads already return.
- Swarm code stays out of `cli/src/core`.
- Never run a test that signs the Mac out of the real CLI.

## Design

- growth: N/A because nothing new is stored; `answers` is a command field and settles existing delivery rows.
- concurrency: the settlement is the same `updateMany` in the same command transaction as `replyTo`'s.
- read cost: one `findFirst` by id for the answered message, only when `answers` is sent (as `replyTo` does).
- scale: N/A because it is one indexed read per post that names it.
- compatibility: old CLI uses `replyTo` (unchanged); new CLI on an old backend retries with `replyTo` on the
  "Unrecognized key answers" refusal; Desktop and phone show an `answers` post as an ordinary top-level message.
- migration + rollback: none; rolling the backend back makes the CLI fall back to `replyTo`.
- audience: the server checks the answered message is in the same conversation, as for `replyTo`.
- identity: settles only the posting agent's own deliveries.
- failure: an unknown or foreign message id is refused with INVALID_ANSWER; `answers` with `replyTo` is refused.
- platforms: backend and CLI on every OS; Desktop launch prompt text only.

## Review Focus

- `answers` must route recipients exactly as a reply to the same message does (leadToWorker / ownerToStepAgent use the
  replied-to author), so answering a person does not wake the assigned worker.
- The CLI's `messages` read marks a question answered from the agent's settled delivery too, or an agent that answered
  below would see the question as unanswered and answer twice.
- Buddy session agents keep `--reply-to`: their session lives in one thread.

## Task 1: backend `answers` settles the delivery and posts top-level

**Files:** `backend/src/superTabs/commands.ts`, `backend/src/superTabs/store.ts`, a backend spec next to the existing
message.send / delivery settlement tests.

**Interfaces:** `message.send { answers?: string }`; `CommandContext.answered?: { id, conversationId, author }`.

- [ ] Failing tests: an agent's post with `answers` settles its delivery of that message (status `answered`), its row has
  `replyTo: null` and `thread` its own id, and the question has no thread replies; an older client's `replyTo` answer
  still settles; `answers` naming a message of another conversation is refused; `answers` with `replyTo` is refused; the
  PM answering a person's message with `answers` in a task does not reach the assigned worker.
- [ ] Watch them fail.
- [ ] Schema field, context read in store.ts, validation and routing in commands.ts, settlement uses
  `replyTo ?? answers`.
- [ ] Watch them pass; run the touched spec files.

## Task 2: CLI `post --answers` and the read that marks a question answered

**Files:** `cli/src/superTabs/command.ts`, `cli/src/superTabs/service.ts`, their specs.

**Interfaces:** `post GROUP TEXT OPERATION_ID [--answers MESSAGE_ID | --reply-to MESSAGE_ID] ...`.

- [ ] Failing tests: `--answers m1` sends `answers: 'm1', replyTo: null`; `--answers` with `--reply-to` is a usage error;
  an older backend's "Unrecognized key answers" refusal is retried once with `replyTo`; `messages` marks a question
  answered when the agent's delivery of it is `answered`; help text names `--answers`.
- [ ] Watch them fail, then implement, then pass.

## Task 3: the delivery text says which to use

**Files:** `cli/src/superTabs/host.ts`, `cli/src/superTabs/host.spec.ts`.

- [ ] Failing tests: a delivery of a top-level project-chat message says `--answers 'id'`; a delivery of a thread reply
  says `--reply-to 'id'`; a scheduled request (top-level) says `--answers`; a Buddy session's delivery keeps
  `--reply-to`; the reply-style line says when to open a thread.
- [ ] Watch them fail, then implement, then pass.

## Task 4: skill texts

**Files:** `cli/src/lib/swarmSkills.ts` (Lead in both modes, Buddy), `cli/src/lib/swarmTools.ts`,
`cli/src/lib/swarmSkills.spec.ts`, `desktop/lib/super_tabs/launch_prompt.dart` and its test.

- [ ] Failing tests: each Lead skill and swarm-tools carry the new answer line; the Buddy skill says to answer its owner
  right below; the byte-for-byte checks put back the approved line; the Desktop launch prompt names `--answers` and stays
  within 2,000 code units.
- [ ] Watch them fail, then implement, then pass.
