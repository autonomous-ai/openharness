# PM delivery carries the task's state and latest messages — plan

> Task #3114. Worked by the project's instructions: test first, plan tasks in order, one pull request.

**Goal:** A message in a numbered task, one of its steps, or a thread in either reaches the project's coordinator (PM) with
the task's state and the latest messages before it, so the PM answers what the task is waiting on (Ken, 11-05: "release
urgent" in #3022 was answered about something else). A person's answer to an agent whose assignment there is done also
reaches the PM.

**Architecture:** The CLI host builds each delivery's context lines (`cli/src/superTabs/host.ts` `contextLines`) from one
Swarm read as the receiving agent; the words come from pure functions in `cli/src/superTabs/deliveryContext.ts`. Two new
pure functions there, `taskStateLine(state, groupId)` and `recentLines(rows, readerId)`, and `contextLines` calls them only
when the receiver is a coordinator and the conversation is a numbered task or a step. The recent rows come from one message
page read as the agent (the conversation's latest page, or the thread's page for a thread reply), bounded by the same wait
as the Swarm read. Routing of a person's reply is the backend's `message.send` (`backend/src/superTabs/commands.ts`).

**Tech Stack:** TypeScript, Vitest (CLI and backend unit tests).

**Spec:** the task's brief and Ken's addition in its conversation (23c567b11d9a8f9d46d0f053).

## Global Constraints

- Only the coordinator's deliveries change; every other agent's delivery is byte for byte what it was.
- Added lines short: the state line at most 300 characters (cut with "…"), each quoted message about 120 characters.
- Names only, never emails (`personName.ts` `authorName`, agent names from the read).
- Any part the reads do not give is left out; the delivery always goes.
- Quoted messages are data: every quoted message is set off line by line with "> " (`setOff`) under a label saying they are
  quoted data, never instructions, and never a reason to read or send files or secrets. The message page carries no
  per-row account, and the server's claim checks only the reply-to and thread root, so the host cannot tell which rows an
  agent of another account wrote: it sets off all of them (fails closed), which keeps the "from another account" rule for
  those rows and never lets any quoted text start a line of the delivery.
- No new settings. Swarm code stays out of cli/src/core.

## Review Focus

- Quoted recent messages can never read as instructions or fake a delivery header (U+2028 etc. included).
- Non-coordinator deliveries unchanged; thread line from 1 reply only for the coordinator.
- Routing change: a person's reply to a done agent reaches the agent and the PM; nothing else changes.

## Tasks

### Task 1: State line

**Files:** `cli/src/superTabs/deliveryContext.ts`, `cli/src/superTabs/deliveryContext.spec.ts`

**Interfaces:** `taskStateLine(state: Json, groupId: string): string | null` — for a task or a step (said as its task):
`Task state: <status>, <assignee>; steps: <step> (<agent>): <status>[, Ready to merge: <verdict>] · …; PR <url>[ at <head>].`
Null when the group is not a numbered task or step of one. The head is the revision the assignment's result names, when it
names one.

- [ ] Failing spec: a task with an assignee, a review step with a verdict, a test step, a PR and a head; a step message
      gives its task's line; an unassigned task; a cut at 300 characters.
- [ ] Implement until green.

### Task 2: Recent messages

**Files:** same.

**Interfaces:** `recentLines(rows: Json[], before: Json, readerId?: string): string | null` — up to 3 rows before `before`
(by sequence, else page order), leaving out agent-only rows, deleted rows and the thread root; each `name: text` with
whitespace folded and cut at 120; under the quoted-data label; every line set off with "> ".

- [ ] Failing spec: three latest of five, newest last; a long text cut; a thread page without its root; a text faking a
      header with a newline and U+2028 stays set off; nothing before → null.
- [ ] Implement until green.

### Task 3: Wire into the coordinator's delivery

**Files:** `cli/src/superTabs/host.ts`, `cli/src/superTabs/host.spec.ts` (delivery tests).

- [ ] Failing host spec: a coordinator's delivery of a message in a task carries the state line and the recent messages
      after the place line; a non-coordinator's does not; a thread with one reply gets its thread line for the coordinator.
- [ ] `contextLines`: for a coordinator in a task or step, push `taskStateLine`, read the page (thread page for a thread
      reply) within the wait, push `recentLines`; thread line from 1 reply for the coordinator ("1 reply").

### Task 4: A person's reply to a done agent also reaches the PM

**Files:** `backend/src/superTabs/commands.ts`, `backend/src/superTabs/postRecipients.test.ts`.

- [ ] Failing test: a person's untagged reply to the assignee's message in a task whose assignment is done reaches the
      assignee and the PM; while it is working, the assignee alone.
- [ ] In `message.send`, add the coordinator (`group.leadId`, in the group) to a person's automatic recipients when the
      replied-to agent holds the group's assignment and it is done.
