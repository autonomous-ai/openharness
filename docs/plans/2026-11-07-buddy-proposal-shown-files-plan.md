# Buddy proposal shown files implementation plan

> Implemented by the Engineer in this session, task by task, test first; two independent security reviews of the pull request.

**Goal:** A Buddy's proposal can carry a file it already showed its owner in their private chat, so a picture it drew reaches the PM and the builder even when the project's code is not on the Buddy's machine.

**Architecture:** `SuperTabStore.proposable` (backend/src/superTabs/store.ts) already finds a proposal's files: the Buddy's own unsent uploads to its chat, and files its owner sent there. It gains a third source: files on the Buddy's own plain messages in that same chat. They go with one proposal at most, by the existing `proposedBy` claim, as its owner's files do. The thread-session and Swarm-Buddy read rules that scope the owner's files scope these too. The CLI already passes `attachmentIds` from the JSON; only its help, error lines and the swarm-buddy skill change.

**Tech Stack:** TypeScript, Prisma on MongoDB, Vitest with an in-memory replica set; no new dependencies.

**Spec:** Harness task #4470, "A Buddy's proposal can carry the pictures it showed its owner in their private chat" (anh Dee, project chat, 2026-11-07 15:37: "it should take both instruction in text and pics").

## Global Constraints

- Backend and CLI only. No other source of files; the project-folder rule for `--attach` stays.
- Never a file from another chat, another person's message (other than the owner's, as today), or another Buddy.
- A "plain" message is the Buddy's own `message.send`: authored by that agent, with no system source, not deleted.
- Existing limits hold: 5 files per proposal, 10 MB per file (the upload limit).
- The server enforces who opens the files: the proposal's message in the project chat, read by its members.

## Review Focus

- `proposable` accepts a file only when its row is this Buddy's upload, in this chat, used by a message this Buddy wrote, with no source.
- A thread session takes only files from its own thread; the Swarm Buddy none from a session's thread.
- A deleted message's file (usedBy EXPIRED) and an unsent or swept file are refused as today.
- A file goes with one proposal at most, raced or not.
- Only the project's members open the proposal's files; the Buddy's private chat stays private.

## Design

- growth: no new rows or fields; an attachment row's existing `proposedBy` is set, removed with the row by the existing sweep.
- concurrency: the existing conditional `updateMany` on `proposedBy` claims a file once inside the command's transaction.
- read cost: one extra read of the named messages by id (`messagesById`, the `_id` index), at most 5 ids.
- scale: bounded by the 5-file limit per proposal; nothing grows with the Swarm.
- compatibility: an added accepted case of an existing command field; older CLIs send `attachmentIds` the same way. Backend ships first; a CLI without the new help still works.
- migration and rollback: none; rollback reverts the code, and proposals already sent keep their files.
- audience: server-enforced as today: the file shows on the owner's proposal message in the project chat, read by project members.
- identity: the proposal is posted as its owner, from their consent, as today; the Buddy's own login never posts it.
- failure: a refused file fails the whole proposal with ATTACHMENT_UNAVAILABLE or ATTACHMENT_USED and its reason.
- platforms: backend (Linux), CLI on macOS, Linux and Windows; no platform-specific code.

## Task 1: the backend accepts a file the Buddy showed its owner

**Files:** `backend/integration/superTabBuddies.test.ts`, `backend/src/superTabs/store.ts`, `backend/src/superTabs/commands.ts` (comments).

**Interfaces:** `buddy.propose` `attachmentIds` unchanged in shape.

- [ ] Write a failing integration test: a Buddy posts a picture in its chat; a proposal naming it carries it, its owner's members open it in the project chat; it is refused from another chat, from another person's message, from another Buddy's message, from a deleted message, for a second proposal, and past 5 files.
- [ ] Run it and watch the own-message case fail with "Upload this file again".
- [ ] Add the shown-file source to `proposable`, scoped like the owner's files, claimed through `proposedBy`.
- [ ] Run the test and the existing proposal file tests green.
- [ ] Commit.

## Task 2: the CLI and the swarm-buddy skill say so

**Files:** `cli/src/lib/swarmSkills.ts`, `cli/src/superTabs/service.ts`, `cli/src/superTabs/command.ts`, `cli/src/superTabs/attach.ts` and their specs.

- [ ] Write a failing spec that the built swarm-buddy skill names a file the Buddy showed its owner in their chat as attachable by id.
- [ ] Update the skill line, the help line and the two refusal lines.
- [ ] Run the specs green.
- [ ] Commit.
