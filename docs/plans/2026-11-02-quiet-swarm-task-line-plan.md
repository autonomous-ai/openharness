# Quiet Swarm 2/6: one server message per task — Implementation Plan

> Worked by the project instructions' Engineer role (revision 26): this plan's tasks are implemented in order, test first,
> by the Engineer that wrote it; the Review step on the pull request is the one independent review.

**Goal:** For each task that has an Engineer, the server posts one message in its project chat and edits it in place as
the task moves (planned, working, waiting on a person, in review, shipped); it replaces the Shipped line.

**Architecture:** A pure function (`taskLine.ts`) runs after every command: it compares each work group's drawn line
(state, person asked, title, audience) with the one it last drew (`cards.line`) and either posts the line's first message
in the project chat or edits that message. Edits are a new `CommandEffects.edits` list the store writes as row updates;
the project chat's `reactionSeq` moves with each edit, so every reader already polling for reaction changes (Desktop,
phone, older releases) reads the page again and sees the new words. A private task's line is hidden by `agentOnly` on
every read, and shown by the page read alone to its audience's people.

**Tech Stack:** TypeScript, Prisma on MongoDB, vitest (unit), MongoMemoryReplSet (integration).

**Spec:** [2026-11-02-quiet-swarm-design.md](2026-11-02-quiet-swarm-design.md) (Screens 1, 2, 3; "Calls made by the PM",
first bullet). Task #2191's brief.

## Global Constraints

- The PR body starts with: Requested by dee@autonomous.ai through Harness.
- Swarm code stays out of cli/src/core. No on/off switch: it ships on.
- Stay inside backend/src/superTabs, its tests and the wire format; Desktop and phone draw it (parts 3/6 and the phone pass).
- Fewer words: the line's text is the task's name and one status word.
- Full backend Super Tab integration suite (`npm run test:super-tabs` in backend) passes before Ready.

## Wire format (agreed with part 3/6)

A project-chat message, `source`:

```
{ kind: 'task-line', taskId: string, number?: number, title: string,
  state: 'planned' | 'working' | 'waiting' | 'review' | 'shipped' | 'stopped',
  answerFor?: string,                               // the asked person's id, only while waiting
  audience?: Array<{ id: string, generation: string }> }  // only on a private task's line
```

- `text` is `<title> · <word>` (`planned`, `working`, `waiting on <username>`, `in review`, `shipped`, `stopped`), so an
  older client reads a current line. New clients draw from `source` and open `taskId` on the right.
- The message keeps its id through every edit; its author is the project's coordinator (else whoever caused the post).
- No recipients and no deliveries: it wakes nobody.
- `stopped` (cancelled, or stopped and not shipped) is the one state the design does not draw; part 3/6 shows it with
  the same one-word style.

## State rules

| Group now | `state` |
| --- | --- |
| assigned, its agent has sent no status on this line yet | `planned` |
| working, blocked, reconciling, lost | `working` |
| needs_human | `waiting` (`answerFor` = `assignment.askedOf` when set) |
| review | `review` |
| done, or no active work and `ledger.shippedAt` set (Lark's field) | `shipped` |
| cancelled / stopped, never shipped | `stopped` |

A line exists only for a top-level work group of a project (not a step or `reviewOf` group, not the project chat, not a
Buddy chat, not Leads) and is first posted on a command that changes its assignment. Older tasks get theirs at their next
change; finished tasks never get one.

## Design

- growth: one message per task, deleted with its project chat; `cards.line` is a few fields per group.
- concurrency: the line is written in the command's transaction; posting or editing writes the project chat's group part,
  as the Shipped line did, so it locks at the group part like every chat post.
- read cost: no new read. Edits move `reactionSeq`; readers read only the page they show, as for a reaction.
- scale: at 10x tasks, edits stay one row update per state change (at most about six per task). First warning:
  page re-reads per poll (messageReadStats) on project chats.
- rate: an edit is written only when the line's words change (state, person asked, title, audience), never for a repeated
  status or a progress note, so a task's line is edited at most once per state change and never by a plain message.
- compatibility: older clients read `text` and refresh on `reactionSeq`; an unknown kind reads as people's.
- migration + rollback: none stored ahead; open tasks get a line on their next change. Rolling back leaves lines as plain
  messages and the Shipped line returns.
- audience: the server hides a private task's line in every read (`agentOnly`) and the page read shows it only to a person
  in its `audience` with the same generation.
- identity: authored by the project's coordinator agent, never a machine owner's login.
- failure: the post and edit are in the command's transaction; a failed write fails the command and retries.
- platforms: backend only; Desktop and phone draw `source`.

## Review Focus

1. A private task's line read by a project member outside its audience (page, thread, single message, inbox, catch-up)
   must never show: page and single-message reads are pinned by tests; the rest are hidden by `agentOnly`.
2. A status repeated (working → working with a new note) must not edit or bump anything.
3. A reassigned task (lost, then a new Engineer) keeps its one line, never a second.
4. A step (review or test) of a task gets no line, and its statuses do not change its task's line.
5. A task renamed or answered changes the line's words; the person asked shows only while waiting.

---

### Task 1: The drawn line and its sync (pure)

**Files:**
- Create: `backend/src/superTabs/taskLine.ts`
- Modify: `backend/src/superTabs/cards.ts` (`GroupCards.line`), `backend/src/superTabs/model.ts` (`CommandEffects.edits`,
  `NOTICE_READERS['task-line']`, `agentOnly` for a private line), `backend/src/superTabs/commands.ts` (`applyCommand` runs
  `syncTaskLines` on every return; the Shipped line is not written for a group with a line)
- Test: `backend/src/superTabs/taskLine.test.ts`

**Interfaces:**
- Produces:
  - `TASK_LINE_KIND = 'task-line'`
  - `type TaskLineState = 'planned' | 'working' | 'waiting' | 'review' | 'shipped' | 'stopped'`
  - `interface TaskLine { messageId: string; state: TaskLineState; title: string; answerFor?: string; audience?: Audience['people'] }` (stored at `group.cards.line`)
  - `interface MessageEdit { id: string; conversationId: string; text: string; source: Record<string, unknown> }`
  - `CommandEffects.edits?: MessageEdit[]`
  - `syncTaskLines(before: SuperTabState, effects: CommandEffects, reported: string | undefined, sender: Author | undefined, operationId: string): void`
    (`reported`: the group whose agent sent a `work.status` in this command)
  - `taskLineReader(state: SuperTabState, actor: Actor): (source: unknown) => boolean` — whether a person reads a private line.

- [ ] **Step 1: Write the failing tests** (`taskLine.test.ts`, through `applyCommand` on the commands.test fixtures)
  - `posts one line in the project chat when a task is assigned`: kind `task-line`, `state: 'planned'`, `taskId`, text `<title> · planned`, no recipients.
  - `edits the same line through working, waiting, review and shipped`: `effects.edits` names the first message's id each time; `answerFor` is the asked person while waiting and absent after; the project chat's `reactionSeq` moves by one per edit.
  - `writes no Shipped line for a task with a line`.
  - `does not edit for a repeated status or a plain message`.
  - `gives a step no line and leaves its task's line alone`.
  - `keeps one line through a lost task reassigned`.
  - `marks a private task's line with its audience and hides it from agentOnly readers`.
- [ ] **Step 2: Run** `cd backend && npx vitest run src/superTabs/taskLine.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Commit the failing tests.**
- [ ] **Step 4: Implement** `taskLine.ts`, wire it into `applyCommand` (rename the body `applyCommandOnce`), add
  `edits` and the reader rules in `model.ts`, skip `shipNotice` for a group with `cards.line`.
- [ ] **Step 5: Run** the unit file plus `src/superTabs/commands.test.ts src/superTabs/ship.test.ts src/superTabs/notices.test.ts` — Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 2: The store writes edits and shows a private line to its audience

**Files:**
- Modify: `backend/src/superTabs/store.ts` (write `effects.edits` after `writeMessages`; `readsRow` and the single-message read let an audience person read a private line), `backend/vitest.super-tabs.config.ts`
- Test: `backend/integration/superTabTaskLines.test.ts`

**Interfaces:**
- Consumes: `CommandEffects.edits`, `taskLineReader` (Task 1).

- [ ] **Step 1: Write the failing integration tests** (MongoMemoryReplSet, as superTabWorkflow.test.ts)
  - `one message per task with an Engineer, edited through each state`: the project chat's page holds one `task-line` row for the task whose `source.state`/`text` read planned → working → waiting (with `answerFor`) → review → shipped, and the page's `reactionSeq` moved.
  - `none for steps`: a review step assigned and done adds no row.
  - `a private task's line only to its audience`: a person in the audience reads it on the page and by id; a member outside does not.
- [ ] **Step 2: Run** `cd backend && npx vitest run --config vitest.super-tabs.config.ts integration/superTabTaskLines.test.ts` — Expected: FAIL.
- [ ] **Step 3: Commit the failing tests.**
- [ ] **Step 4: Implement** the edit write (`updateMany` by tab, conversation and id) and the audience reader.
- [ ] **Step 5: Run** the new file, then the full `npm run test:super-tabs` and `npx tsc --noEmit` — Expected: PASS.
- [ ] **Step 6: Commit and push; post red/green evidence on the PR.**
