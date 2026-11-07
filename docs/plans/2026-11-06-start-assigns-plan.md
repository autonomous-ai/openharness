# A start that names its task assigns and briefs its agent: plan (task #3614)

> Written after review round 1 asked for it (new behaviour over 20 lines). Way of working: test first, as the pull request's commits show.

**Goal:** The PM stays free to answer people: `start` takes the task to assign and an optional first message; the server assigns the agent when it is ready and posts the message; the PM hears only if the start fails or the task cannot take the agent.

**Architecture:** `AgentStartRequest.assign` (backend `startRequestSchema`). The coordinator alone may name it (`agent.start` refuses anyone else, so the brief is the coordinator's own words). The assignment runs inside the command that makes the agent ready: `agent.startSettled` for a pooled machine, `agent.started` for one with no pool (which never settles), using `assignRefusal` and `assignTo`, the same as `work.assign`. Everything the store does around a `work.assign` is done for it too: it reads who pushed the task's code and the repository's reach before the command (`startNamingTask` in store.ts), and writes the run record, the progress mark and the tag settling after it (`startAssigned`). The CLI returns the receipt at once for a start that names its task.

**Spec:** River's brief for #3614 (anh Dee, P1, Inventory Table A #13); review rounds of #3334 by Sec3684A and Rowtest.

## Global Constraints
- `start` without `assign` behaves as before. A pooled start with no `assign` still waits for an assign call.
- Team-written code never reaches a main-account agent through this path (audit H2); the same refusals as `work.assign`.

## Review Focus
- Authorship: only the coordinator, who made the start, speaks the brief.
- The store reads and writes for the settle what it does for `work.assign` (integration test, real store).
- A failed start is told once; a refused assignment is told once to the coordinator.

## Design
- growth: `assign` leaves the start's request once done. concurrency: inside the settle or join command's own transaction. read cost: one extra read of the start before such a command, only when it names a task. compatibility: an older backend refuses the unknown `assign`; an older CLI sends none. failure: told to the coordinator once. audience: the brief is a task message, the coordinator's. identity: the coordinator as author. platforms: N/A. migration + rollback: none. scale: N/A.

### Task 1: the coordinator alone, and pool-less starts (commands.ts)
- [x] Failing tests (commands.test.ts "a start that names its task…"), then code.
### Task 2: what the store does around an assignment (store.ts)
- [x] Failing store-level tests (integration/superTabStartAssign.test.ts: run record; Team-written code refused), then code.
### Task 3: the CLI returns at once (cli/src/superTabs/start.ts)
- [x] Failing test (start.spec.ts), then code.
