# An agent a person is chatting with is never idle: Implementation Plan

> Written by the project's Engineer by the writing-plans skill; implemented task by task, test first. The review step on
> the pull request is its one independent review.

**Goal:** An agent with no task that a person is talking with is never kept or stopped as idle (hieule, 11-06, task #3816).
One nobody talks to still is, after 15 minutes.

**Architecture:** When a message is numbered (`parts/commit.ts numberMessages`, where `heardAt` is set), its conversation
records, per agent, when a person last talked with it there (`Conversation.talkedAt`). A person's message stamps each agent
it reaches, and that agent's own later posts in the same chat stamp it too: its answers. It counts who wrote and whom the
message reached, never the words. `tidy.ts idleSince` adds the time, so a busy chat about others' work still renews nobody.
The map keeps one hour of entries and is hidden from every reader, like `chatLimits`.

**Tech Stack:** TypeScript, vitest.

**Spec:** task #3816's brief and Guide2's trace (tidy.ts idleNotices and idleSince).

## Global Constraints
- Idle stop still works for an agent nobody talks to. Crew rules are unchanged.
- No content is stored: agent ids and times only.

## Design
- growth: entries older than an hour drop on the chat's next write, so it holds at most the agents talked with in the last hour.
- concurrency: written in the message's own commit, on the conversation part that commit already writes.
- read cost: none new. The tidy pass already loads the groups it reads, and readers never get it.
- scale: one small map per active chat, so 10x chats means 10x small maps. The part size warns first.
- compatibility: an optional field. Old readers never see it, and an old part without it reads as "nobody talked".
- migration and rollback: none. Reverting ignores the field.
- audience: hidden from every view (read/contract.ts, read/views.ts, model.ts visibleState, parts/light.ts).
- identity: N/A because it records only which agent a message reached.
- failure: N/A because a missing entry falls back to today's rule (start or keep).
- platforms: backend only.

## Review Focus
- A person's message that reaches no agent, a system row or a notice: marks nobody.
- An agent posting in a busy chat nobody addressed it in: still idle from its start.
- A talked-to Reviewer or Tester: not kept while the chat goes on, and kept 15 minutes after.

### Task 1: record the talk (`parts/commit.ts`, `model.ts`); tested in `parts/talked.test.ts`
### Task 2: count it (`tidy.ts idleSince`); tested in `tidy.test.ts`; hide it from readers
