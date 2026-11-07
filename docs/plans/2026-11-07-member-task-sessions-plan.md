# A Member's task sessions, apart from its chat (#4543) Implementation Plan

> Written by the writing-plans skill and carried out by its Engineer, task by task, test first (project instructions,
> Roles › Engineer). Steps use checkbox (`- [ ]`) syntax.

**Goal:** A Member's tasks run in a task session of their own per project, bound to that project's scope, in a worktree
of the Member's task home; its chat session keeps the Buddy's reads and commands and never runs a task.

**Architecture:** The server resolves an assignment naming a Member to that Member's task session for the task's
project, or queues that session's start and holds the task for it; the start becomes an ordinary project agent record
(`projectId`, project scope) plus `memberOf`. The server keeps `projectsHeld` on the Member and `privateOnDisk` on each
machine, from the starts it sends and from the host's report. The CLI host runs a task session's start in a worktree of
the Member's task home, one per project, reused by later starts, and reports what it holds.

**Tech Stack:** TypeScript (backend on Fastify/Prisma/MongoDB, CLI host), vitest.

**Spec:** `docs/specs/2026-11-07-members-and-leads.md` on PR #3542: section 2, build task 6, Design lines 1–10.

## Decisions this plan makes where the spec leaves a choice

1. **Who is a Member here.** Until build task 9 turns Buddies and Regular agents into Members, a Member is a person's main
   Swarm Buddy (`buddyScope: 'swarm'`, no `buddySession`) on a host that says `memberProjects`. Its Buddy session is the
   chat session and keeps today's reads and commands (`BUDDY_COMMANDS`). A Regular agent keeps today's path untouched
   (spec section 7: its session never becomes a chat session).
2. **How a Member gets a task here.** `work.assign` naming the Member (a Lead's pick by name). Dispatch giving free Members
   tasks is build task 7; this plan adds nothing to `dispatch.ts`.
3. **Where a Member may work here, until main projects (build tasks 4 and 7):** a public project its person reads, on a
   computer whose `privateOnDisk` is empty. A private project's task is refused for a Member (`MEMBER_PRIVATE`); a computer
   holding any private project's files takes no Member task (`MEMBER_PRIVATE_ON_DISK`). Strictest form of section 3.
4. **The ready line** is written by the server, as the task session, in the project's chat (`leadConversationId`), the first
   time the host reports that project set up for that Member: "Ready to work on <project name>." (Dee 11-06: rules a
   program can check run as code.)
5. **The sixth project.** With 5 projects held, a start for a sixth names the held project used longest ago whose task
   session holds no task (`dropProjectId`). Its host removes that worktree only when clean and pushed (the existing
   `sweepOne` rule), else the start fails naming why, and the task goes back to waiting. With none free, `work.assign`
   refuses (`MEMBER_PROJECTS_FULL`).
6. **Removing from `privateOnDisk`:** only when the host's report (which lists every project whose files Harness put on
   the computer) omits it and no start to that machine is still pending, so a report made before a clone finished never
   clears it.

## Global Constraints

- Backend, then CLI, each released on its own; every new field optional; a host that does not say `memberProjects`
  never gets a task-session start and its Buddy is refused a task as today (`BUDDY_NOT_ASSIGNABLE`).
- A task session reads and posts only in its project; the chat session never runs a task; nothing private reaches a
  public task (Review line).
- Bounds: `projectsHeld` ≤ 5 ids; `setUp` ≤ 5; `privateOnDisk` ≤ 100 ids (the Swarm's projects); report
  `projectsOnDisk` ≤ 200 ids, `memberSetUp` ≤ 1000 keys of ≤ 5 ids; one task session per Member and project.
- Windows: a task worktree's folder is the project id cut to 8 characters; every new git process uses `ownProcessGroup()`
  (through `createQuietGit`) with no window.
- No logs, measures or errors carry names, titles or paths.

## Review Focus

1. A task session's start is dispatched but its host reports before the clone exists: `privateOnDisk` must keep the entry.
2. A Member assigned again while its task session is still starting: refused (`MEMBER_BUSY`), never a second start.
3. The task is taken by someone else while its task session starts: the session joins, takes nothing, and no error.
4. The task-session start fails (clone, drop refused): the hold clears, the failure line names the step, the task waits.
5. The host restarts mid-start or reports an empty `memberSetUp` once: `projectsHeld` drops only what it reports dropped
   after the start has run, never a project with a pending start.

---

### Task 1: The host's report of what is on its disk (backend)

**Files:**
- Modify: `backend/src/superTabs/machines.ts` (observation schema, `storedObservation`, `readingOnly`, new helpers)
- Modify: `backend/src/superTabs/model.ts` (`ContributedMachine.privateOnDisk`, `AgentStartRequest.memberOf`)
- Modify: `backend/src/superTabs/commands.ts` (`agent.startDispatch`: one call)
- Modify: `backend/src/superTabs/store.ts` (full report: one call)
- Test: `backend/src/superTabs/privateOnDisk.test.ts`

**Interfaces:**
- Produces: `MEMBER_PROJECTS_CAPABILITY = 'memberProjects'`; observation `projectsOnDisk?: string[]`,
  `memberSetUp?: Record<string /* the Member's harnessId */, string[] /* project ids */>`;
  `notePrivateOnDisk(state, start): void` (adds the start's private project, and its `buddyProjects`' private ones);
  `applyDiskReport(state, pool, reading): void` (adds reported private projects, removes unreported ones per decision 6).

- [ ] Failing tests: a dispatched start in a private project adds it; a Buddy start's private `buddyProjects` are added;
  a public one adds nothing; a report naming a private project adds it; a report omitting it removes it only with no
  pending start to that machine; an older report without `projectsOnDisk` removes nothing; `readingOnly` is false when
  either field changes; the schema refuses 201 ids.
- [ ] Run `cd backend && npx vitest run src/superTabs/privateOnDisk.test.ts`: FAIL.
- [ ] Implement; run: PASS. Commit test, then code.

### Task 2: A Member's assignment goes to its task session (backend)

**Files:**
- Create: `backend/src/superTabs/taskSessions.ts`
- Modify: `backend/src/superTabs/model.ts` (`Agent.memberOf`, `Agent.projectsHeld`, `Conversation.sessionStart`,
  `AgentStartRequest.memberOf` / `memberProject` / `dropProjectId`)
- Modify: `backend/src/superTabs/commands.ts` (`work.assign`, `agent.started`, `agent.startFailed`, `assignTo`: a few
  lines each)
- Modify: `backend/src/superTabs/read/hostRows.ts` (a task-session start goes to its host's `starts`)
- Test: `backend/src/superTabs/taskSessions.test.ts`

**Interfaces:**
- Produces: `isMember(state, agent): boolean` (decision 1); `taskSessionOf(state, member, projectId): Agent | undefined`;
  `memberAssignment(state, member, group, now, operationId): { worker: Agent } | { start: AgentStart }` (checks of decision
  3, `MEMBER_BUSY`, decision 5); `taskSessionJoined(state, start, agent): Conversation | null` (records `projectsHeld`,
  stops a dropped project's session, returns the held task to assign).

- [ ] Failing tests: assigning a Member queues one start (`memberOf`, `memberProject`, worktree of the project's folder)
  and holds the task; the started session is a project agent of that project with `memberOf`, is assigned the task, and
  its session scope is that project's; the Member's own record is never the assignee and never joins the task; a second
  task in the same project goes to the same session; private project, private files on disk, a busy Member and an older
  host are each refused by name; a sixth project names the oldest free one to drop, and none free refuses; a task taken
  meanwhile is not reassigned when the session joins; a failed start clears the hold and says so in the task.
- [ ] Run `cd backend && npx vitest run src/superTabs/taskSessions.test.ts`: FAIL.
- [ ] Implement; run it and the touched suites' tests (`buddies.test.ts`, `regularAssign.test.ts`, `agentNew.test.ts`):
  PASS. Commit test, then code.

### Task 3: Set-up report, dropped worktrees and the ready line (backend)

**Files:**
- Modify: `backend/src/superTabs/taskSessions.ts` (`applyMemberSetUp`)
- Modify: `backend/src/superTabs/model.ts` (`Agent.setUp`)
- Modify: `backend/src/superTabs/store.ts` (full report: the rows it returns are written)
- Test: `backend/src/superTabs/taskSessions.test.ts`

**Interfaces:**
- Produces: `applyMemberSetUp(state, machineId, memberSetUp, now): MessageDraft[]`.

- [ ] Failing tests: a newly reported project sets `setUp` (kept `at` for one already there) and writes one "Ready to work
  on harness." row in the project's chat as the task session; the same report again writes nothing; a project no longer
  reported leaves `setUp` and `projectsHeld` unless a start for it is pending; at most 5 kept.
- [ ] FAIL, implement, PASS, commit as above.

### Task 4: The host runs a task session in its Member's own worktree (CLI)

The task home is the Member's worktrees, one per project, kept in this machine's record `member-worktrees-<machine>.json`
(memberHome.ts), never in its chat home. The first set-up makes one through the daemon's own worktree path (trusted and
cleaned like any Harness worktree), on branch `m/<project id, 8>-<start id, 8>`, so its folder is 17 characters on every
platform; a stopped task session leaves it; a later start for that Member and project works in it.

**Files:** Create `cli/src/superTabs/memberHome.ts`; modify `cli/src/superTabs/start.ts`, `cli/src/superTabs/machines.ts`.
**Tests:** `memberHome.spec.ts`, `start.spec.ts` (the folder), `machines.spec.ts` (reuse).

### Task 5: The host says memberProjects and reports its disk and set-ups (CLI)

`memberProjects` in its capabilities; to a backend that asks (`memberProjectsWanted`), `memberSetUp` per Member and
`projectsOnDisk`: its clones, every Buddy home's copies (`buddyHomesProjectIds`) and Members' worktrees; left out while its
clones are not read yet. **Files:** `machines.ts`, `buddyHome.ts`, backend `read/hostRows.ts`. **Tests:** `machines.spec.ts`,
`buddyHome.spec.ts`.

### Task 6: The sixth project's drop (CLI)

A start naming `dropProjectId` removes that worktree first by the stopped worker's rule (`sweepOne`), or fails with "The
oldest project folder still has unpushed work." and makes nothing. **Files:** `machines.ts`. **Tests:** `machines.spec.ts`.

### Finally

- [ ] Red/green evidence in a PR comment; CLI gates `npm run test:core` and `test:harnessd` for the host change.
- [ ] Mark ready; review, then two security reviews by different Reviewers.
