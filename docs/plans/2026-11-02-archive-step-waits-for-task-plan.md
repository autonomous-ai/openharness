# Archive pass: a step waits for its task Implementation Plan

**Goal:** A review or test step is never archived on its own clock while its task is open, so a re-check never fails on an archived step.

**Architecture:** The task steps design says a step archives with its task. Three places still let one go alone: the worker's startup mark, the archive pass, and the store's write. All three now read the task. The write stays the last word, inside its transaction.

**Tech stack:** TypeScript, Prisma on MongoDB, Vitest integration tests with a real replica set.

## Files

- `backend/src/superTabs/archive.ts`: `markFinishedGroups`, `archiveFinishedGroups`.
- `backend/src/superTabs/steps.ts`: `taskEnded`.
- `backend/src/superTabs/tidy.ts`: `archivable` and `reviewClosable` use `taskEnded`.
- `backend/src/superTabs/store.ts`: `archiveFinished` reads the task's pull requests and touches the task.
- `backend/integration/superTabTidy.test.ts`, `backend/src/superTabs/tidy.test.ts`.

## Task 1: A step follows its task

- [x] Write failing tests: a finished step and a step nobody holds stay unarchived after a worker restart under an open task; an earlier mark is taken back; the write refuses a step of an open task or of a task it did not read.
- [x] Run them and watch them fail on the unchanged source.
- [x] Mark: no step in the legacy mark; clear every open step's mark; set it only where the task is done or cancelled.
- [x] Pass: read the task; skip unless it ended; settle both the step's and the task's pull requests.
- [x] Write: `archivable` and `reviewClosable` require `taskEnded`; a step's archive touches its task, so a hand-back since the load retries.
- [x] Run `npx vitest run --config vitest.super-tabs.config.ts integration/superTabTidy.test.ts`, then `npm run test:super-tabs`.

## Design

- **Growth:** nothing new is stored. A step still goes with its task.
- **Concurrency:** the write loads the task and touches it, so a task handed on during the archive retries and declines.
- **Read cost:** the pass reads one task per marked step. The startup mark runs one aggregate over open groups, with one `tabId_key` read per open step, once per worker start.
- **Scale:** at 10x, startup aggregate time warns first. It is not on any request path.
- **Compatibility:** no wire or client change.
- **Migration and rollback:** the first startup clears old marks on open steps. A rollback marks unattended steps again, as today.
- **Audience, identity:** N/A because no read or write gains a reader, and no login is used.
- **Failure:** a missing or unloaded task reads as not ended, so a step stays open. A failed write skips that group with the pass's existing warning.
- **Platforms:** backend only.
