# Project switch, Can chat, and priority and pause rights (task #3819)

> Implemented by its Engineer test first, by superpowers:test-driven-development, as the project's instructions say
> (Engineer role). No subagent-driven-development and no execution handoff.

**Goal:** Phase 2 of the approved spec (docs/plans/2026-11-06-buddy-board-final-spec.md, Ken and anh Dee, 11-06), backend
part of #3819. A project's owner switches it to the Board way of working. In a switched project, writing in its chat is a
per-project Can chat right, and priority and pause follow roles. All of these are enforced on the server, so an older app
is held to them too. A switched project's PM text drops the inbox lines. Projects that are not switched behave exactly as
today.

**Architecture:**
1. Three project settings in `SwarmProject` (projects.ts), read by every reader of the project:
   - `boardMode?: true`: switched on, absent otherwise.
   - `canChat?: string[]`: people granted Can chat. The project owner and the Swarm owner always have it and are not listed.
   - `decider?: string`: the project's top decider (for openharness, Dee).

   The project owner or the Swarm owner sets them with `project.boardMode {projectId, on}`, `project.canChat {projectId,
   personId, granted}` and `project.decider {projectId, personId | null}`. A rights module (`boardRights.ts`) answers:
   `switched(project)`, `canChat(state, project, userId)`, `steers(state, project, userId)` (owner, Swarm owner or
   decider).
2. **Can chat:** `postable()` (commands.ts) refuses a person without the right to write in a switched project's chat with
   CHAT_NOT_ALLOWED (403). postable covers message.send and every upload and voice path (store.ts poster). The same check
   also guards message.edit, agent.add's initialMessage and delivery.resolve's resend in that chat. Reactions, deletes,
   Buddy proposals and agents are unchanged.
3. **Priority by role**, in a switched project, for people: only someone who steers sets P0, or changes the priority of a
   card they did not request; anyone else gets PRIORITY_FORBIDDEN (403). A member sets P1-P3 on their own cards. This
   covers both `work.priority` and a person's `conversation.create`. The PM keeps today's rights.
4. **Pause and resume:**
   - `work.pause {conversationId, reason?}` and `work.resume {conversationId}` set or clear `paused {by, at, reason?}` on a
     task. Only someone who steers may send them; anyone else gets PAUSE_FORBIDDEN (403).
   - Each change writes a line into the task, and its assignee is told.
   - A paused task is not handed out (dispatch.ts), not chased by the PM's sweep (pmSchedule.ts sweepDue), and shows as
     held on the board (pulse.ts holdOf).
   - Pause and resume are new commands, so they work in every project. Nothing changes for a project that never sends
     them.
5. **PM text follows the switch:**
   - A switched project's coordinator gets `pmScheduleText(project)`: the built-in text without its inbox line, served
     from store.ts instructions and hashed per project in read/hostRows.ts.
   - Its wakes and digests carry no owed-asks lines (inbox.ts owedLines).
   - A person's message there records no owed ask (pulse.ts owe).
   - `PM_SCHEDULE_TEXT` itself is unchanged, so the what-changed note pin (processNotes.ts) stands.
6. **Switch-on migration**, at the boundary agreed with Fir (#3817):
   - `project.boardMode on` hands each unanswered ask in the project chat, oldest first, to Fir's pure
     `importLegacyProposal(state, project, ask, now)`, with `ask = {messageId, conversationId, personId, text, at}`.
   - It clears only the asks the helper turned into cards (Fir, 11-06). Until the helper is wired, the asks stay.
   - `legacyAsks(state, project)` builds that list and is tested here.
   - Whichever of #3817 and #3819 merges second wires the call.
7. **The board read** that returns only what changed is the existing changes feed (`GET /:tabId/changes?cursor`,
   read/changes.ts). The new settings ride the project's part, and `paused` rides the task's part. No new route.

**Tech Stack:** TypeScript, vitest (backend unit), the Super Tab integration suite in PR CI.

**Spec:** task #3819's brief (River, 11-06), and the approved spec's "Who can write in the project chat", "Who may do what on
the Board", Phase 2 item 1 and Rollout sections.

## Global Constraints

- A project without `boardMode` reads, writes and wakes exactly as today: every test of today's behaviour passes unchanged.
- Every right is checked in the command or store path a client calls, never only in an app.
- Two security reviews (rights).
- Swarm code stays in backend/src/superTabs/; nothing in cli/src/core.

## Design

- growth: three small fields per project and one `paused` record per task, removed on resume. A grant names a member; an id
  whose person left matches nothing, and the next grant or revoke drops it.
- concurrency: every write goes through applyCommand's per-tab commit, as project.sharing does; switch-on migration runs in
  the same command, so the asks are taken once.
- read cost: none new. The settings travel in the project part and `paused` in the task's part, both through the changes
  feed.
- scale: at 10x members a canChat list stays a few dozen ids; the first warning would be the project part's size, far below
  any limit.
- compatibility: an older app shows a switched project as today, and its writes are refused with a plain message. An older
  backend ignores the fields, and nothing is switched on before this ships.
- migration + rollback: none on deploy; switching a project off restores today's chat rules at once. Proposal cards made
  meanwhile stay.
- audience: only the project owner or Swarm owner changes the settings; the server enforces chat, priority and pause rights.
- identity: by the person's Swarm id from the signed-in actor, never a machine owner's login; an agent never counts as a
  person.
- failure: each refusal says who may do it; none is silent.
- platforms: server only; every app is held to it.

## Review Focus

- No path lets a person without Can chat write a message into a switched project's chat (send, upload, voice, edit,
  initial message, resend).
- A non-switched project behaves exactly as today.
- P0 and pause from anyone who does not steer are refused, whatever the client.

## Tasks

### Task 1: project settings

**Files:** projects.ts, boardRights.ts (new), commands.ts, boardRights.test.ts.
**Interfaces:** `project.boardMode`, `project.canChat`, `project.decider`; `switched`, `canChat`, `steers`.

- [ ] Failing test: the owner and the Swarm owner set and clear each setting; a member, the PM and another agent are
  refused; a grant names a member of the project; readers of the project see the settings.
- [ ] Code.

### Task 2: Can chat is enforced

**Files:** commands.ts (postable, message.edit, agent.add, delivery.resolve), store.ts (poster), boardRights.test.ts,
integration test for an upload.

- [ ] Failing test: in a switched project a member without the right cannot send, edit or upload into its chat, and a granted
  one, the owner and the Swarm owner can; agents and Buddy proposals still can; in a project not switched, everyone writes
  as today.
- [ ] Code.

### Task 3: priority by role

**Files:** commands.ts (work.priority, conversation.create), boardRights.test.ts.

- [ ] Failing test: in a switched project a member sets P1-P3 on their own card, not on another's, and never P0; the owner
  and the decider set any; the PM keeps its rights; a project not switched is unchanged.
- [ ] Code.

### Task 4: pause and resume

**Files:** commands.ts, model.ts (Conversation.paused), dispatch.ts, pmSchedule.ts, pulse.ts, parts (light fields),
boardRights.test.ts, dispatch.test.ts.

- [ ] Failing test: someone who steers pauses and resumes a task, with a line in it; a member is refused; a paused task is not
  handed out, not swept, and shows held.
- [ ] Code.

### Task 5: the PM text follows the switch

**Files:** pmSchedule.ts, store.ts, read/hostRows.ts, inbox.ts, pulse.ts (owe), tests.

- [ ] Failing test: a switched project's PM text has no inbox line and its wakes and digest no owed lines, and a person's
  message there owes nothing; a project not switched gets today's text.
- [ ] Code.

### Task 6: switch-on hands unanswered asks over

**Files:** boardRights.ts (legacyAsks), commands.ts (project.boardMode), boardRights.test.ts.

- [ ] Failing test: switching on lists every unanswered ask, oldest first, in the agreed shape, and keeps each one until a card
  is made for it; switching on again adds nothing.
- [ ] Code (wiring to #3817's importLegacyProposal by whichever merges second).
