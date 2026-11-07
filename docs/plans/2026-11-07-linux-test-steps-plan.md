# Linux test steps open only where the project can test on Linux (task #4278)

> Written by the Engineer, following writing-plans; implemented test first by the same Engineer, task by task.

**Goal:** A Ready opens a "Test on a Linux machine" step only when the project has a reachable own-account Linux machine.
Otherwise the task says "No Linux machine: CI's Linux runs stand in.", the step waits on the task, and it opens by itself
once such a machine is there. A later head never reopens a Linux step the PM closed while no Linux machine existed.

**Architecture:** `reviewTable.ts reviewPlan` keeps planning the step. `commands.ts openReviewSteps` asks the new
`linuxSteps.ts` whether the project can test on Linux before it opens a new Linux step; when it cannot, the planned step
and its pull requests are recorded on the task (`Conversation.osWaiting`) and one line is written in the task. The 30-second
time checks (`store.ts runTimeChecks`) call `linuxSteps.ts openWaitingSteps`, which opens each waiting step whose machine
is now there and tells the PM in the task. Opening a step moves out of the `commands.ts` closure into `stepOpen.ts`, so the
Ready and the time checks open steps the same way.

**Tech Stack:** TypeScript backend, vitest unit tests, MongoDB integration tests through `SuperTabStore`.

**Spec:** the task brief (River, 2026-11-07): "When review steps open, open an OS test step only if the project has a
reachable own-account machine of that OS. Otherwise don't open it: mark the card 'No Linux machine: CI's Linux runs stand
in', and open the step automatically once such a machine joins. Never reopen a step the PM closed for this reason at a later
head of the same task. Real-store tests." Constraints: backend only; Mac and Windows rules stay as they are.

## What counts as a Linux machine for a project

Since v3 (#4120) a new agent starts only on its own person's computer, and a Team account takes no work. Live on 11-07 the
only Linux entry, daniel-pc, has no agent of this project and is not the PM's person's computer, so no Tester can ever run
there. A machine counts when all hold:

- it reports Linux, is online (a reading within `MACHINE_FRESH_MS`), not paused, not being removed, not Buddy-only, not a
  Team account;
- its owner allows this project there (`machineProjectRefusal`);
- a Tester can get there: it is the project PM's own person's computer (the PM may start one), or an own-account agent of
  this project already runs there as that machine's person.

Mac and Windows steps open as before (constraint).

## Design

- growth: `osWaiting` holds at most one entry per OS on a task (only Linux today), each the planned step and its pull
  requests (at most the task's linked pull requests, no history). It is removed when the step opens and goes with the
  task's row.
- concurrency: the task's group row, as every Ready and time-check write already locks it; a racing second run opens the
  same step id (stable from task and step name) and finds the entry gone.
- read cost: the time checks read only what they already load; the gate reads machines and agents in memory. Nothing new
  is read from the database.
- scale: at 10x, machines (about 60 rows now) and agents are scanned only for tasks that have a waiting entry, once per
  project per pass. The time-check duration warns first.
- compatibility: a new optional field; older clients ignore it. The line in the task is an ordinary system row every
  client draws.
- migration and rollback: none. Rolling back leaves `osWaiting` unread; steps open at each Ready as before.
- audience: the line goes to the task's own chat; the server writes it.
- identity: no start is made; the PM is told and assigns as it does today.
- failure: a step that opens tells the PM in the task; a step that stays waiting is said in the task once.
- platforms: backend only (Linux in CI); no client change.

## Global Constraints

- Backend only, under `backend/src/superTabs/` and its tests.
- Mac and Windows test steps open exactly as before.
- No new database read; the time checks use what they load.

## Review Focus

- The machine rule above: does it match who can really take a Linux test after v3?
- A step the PM archived is never reopened at a later head while no Linux machine is there.
- `stepOpen.ts` opens steps exactly as the old closure did (ids, number, brief, card, step list).

## Tasks

### Task 1: A Ready opens no Linux step without a Linux machine, and the task says why

**Files:** `backend/src/superTabs/linuxSteps.ts` (new), `linuxSteps.test.ts` (new), `commands.ts`, `model.ts`
(`Conversation.osWaiting`), `stepOpen.ts` (new), `steps.ts` (`listStep` moves here).

**Interfaces:** `testsOnLinux(state, project, now): boolean`; `LINUX_WAIT_LINE`; `Conversation.osWaiting?: WaitingStep[]`.

- [ ] Failing unit tests: a Ready on a `cli/` change with only a Mac opens Review and Test on a Mac, no Linux step, and
      writes "No Linux machine: CI's Linux runs stand in." once in the task; a second head writes it no second time; a
      Linux machine of another person with no project agent, a Team account's, an offline or paused one each count as none;
      the PM's own Linux computer, or one with an own-account project agent, opens the step as before.
- [ ] Failing unit test: a Linux step the PM archived while no Linux machine is there is not reopened at a later head.
- [ ] Code: the gate in `openReviewSteps`, the waiting record, the line; `openStep` moved to `stepOpen.ts`.

### Task 2: A waiting Linux step opens once a Linux machine is there

**Files:** `linuxSteps.ts`, `linuxSteps.test.ts`, `store.ts` (`runTimeChecks`),
`backend/integration/superTabReviewSteps.test.ts`.

**Interfaces:** `openWaitingSteps(state, now): MessageDraft[]`.

- [ ] Failing unit test: with the step waiting, a pass with no Linux machine opens nothing; once one reports, it opens the
      step with its brief at the recorded head, clears the entry and tells the PM in the task; a second pass opens nothing.
- [ ] Failing real-store test: a Ready through `SuperTabStore` with only a Mac stores no Linux step and the line; after a
      Linux machine of the PM's person reports, `runTimeChecks` opens it in the database.
- [ ] Code: `openWaitingSteps`, called from `runTimeChecks`.
