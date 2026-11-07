# A project's purpose, the project list and a main project on every agent: implementation plan

> This plan is carried out by the project's Engineer way of working (test first, task by task, one pull request), not
> subagent-driven-development. There is no execution handoff.

**Goal:** The backend half of anh Dee's Members and Leads flow (task #4540, part of #4539): a project says what it is in
one line, Cmd-N and joining can read the list of projects to pick a main project from, and every agent carries its main
project and its role (Lead or Member) beside its kind.

**Architecture:** `about` is a project field set by `project.about`, which follows `project.coordinatorName` (the Lead or
the project's owner). The list is a new person-only GET read, `/api/super-tabs/:tabId/project-list`, computed by
`projectList.ts` from what the Swarm's first load already holds: each project and the pulse stored on its chat (waiting
count, Members working there, its Lead). `mainProjectId` is stored on the agent: `agent.new` and `buddy.create` take it,
and their server starts copy it from the start request when the agent starts. Desktop's new Cmd-N starts a Member through
the server, as Join does (#4541), so a local `agent.new` that names a main project is refused. Clients read `role` and `mainProjectId` in each agent's derived row, beside `kind`, which keeps its values.

**Tech Stack:** TypeScript backend (Fastify, zod), vitest.

**Spec:** `docs/specs/2026-11-07-members-and-leads.md` (PR #3542): build tasks 2, 3 and 4, sections 1 and 7, and the
Design section's lines for `about`, `mainProjectId`, the list's read cost, compatibility and audience.

## Global Constraints

- Backend only; ships in the next backend release once green and reviewed.
- `about`: plain text, one line, at most 80 characters, set by the project's owner or its Lead, through the same credential
  check as other agent text (`WORDS`, `withoutCredentials`).
- The list shows only projects the reader can read (`canReadProject`), enforced by the server; at most 100 projects of
  about 150 bytes each, so at most 15 KB; never on a timer; nothing loaded beyond the Swarm's first load.
- Which row starts picked: the invitation's project, else the one that needs help most (the most waiting tasks for each
  Member working there, then the most waiting tasks, then A to Z).
- `kind` keeps `buddy | pm | regular` for clients of the last 30 days (until 2026-12-07). `role` is `lead | member`,
  derived, never stored: a Lead when a project's chat names it as `leadId`, else a Member.
- A Lead's main project is the one it leads. A deleted project clears `mainProjectId` on every agent that named it.
- No production write, no backfill: every new field is optional.

## Review Focus

- A private project the reader can't read is absent from the list, and an agent whose main project is that private
  project shows no main project to that reader (an id alone says the project exists).
- An `invitedTo` naming a project the reader can't read, or no project, picks as if none was given.
- A project with no stored pulse yet (just created) lists with 0 waiting and no Lead, never fails the read.
- `about` with a newline, or only spaces, is refused or cleared: an empty one clears the field, a line break is refused.
- An older Desktop sending `agent.new` or `buddy.create` without `mainProjectId` works exactly as today.

---

### Task 1: A project's purpose (`project.about`)

**Files:**
- Modify: `backend/src/superTabs/projects.ts` (`SwarmProject.about?: string`)
- Modify: `backend/src/superTabs/commands.ts` (schema, `WORDS`, handler beside `project.coordinatorName`)
- Test: `backend/src/superTabs/projectAbout.test.ts`

**Interfaces:**
- Produces: command `{ type: 'project.about', projectId, about: string }` (trimmed, at most 80, no line break; `''`
  clears). `SwarmProject.about` reaches readers in the head's `projects`, absent when unset.

- [ ] **Step 1: Write the failing tests.** The owner sets it and the head shows it; the Lead (agent) sets it; a member who
  is neither is refused `PROJECT_OWNER_REQUIRED`; 81 characters and a line break are refused; `''` clears it; a key pasted
  in is removed before it is stored.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/projectAbout.test.ts`. Expected: FAIL (unknown command).
- [ ] **Step 3: Commit** the failing test.
- [ ] **Step 4: Implement** the field, schema, `WORDS` entry and handler.
- [ ] **Step 5: Run** the test file and `commands.test.ts` (its schema walk checks `WORDS`). Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 2: The project list read

**Files:**
- Create: `backend/src/superTabs/projectList.ts`
- Modify: `backend/src/superTabs/store.ts` (`projectList(user, tabId, invitedTo?)`)
- Modify: `backend/src/routes/superTabs.ts` (GET `/api/super-tabs/:tabId/project-list?invitedTo=`)
- Test: `backend/src/superTabs/projectList.test.ts`

**Interfaces:**
- Consumes: `SwarmProject.about` (task 1), `storedPulse` (`pulse.ts`), `canReadProject`, `githubRepository`.
- Produces: `projectList(state, actor, invitedTo?: string): ProjectList`, where
  `ProjectList = { projects: ProjectRow[]; pick: string | null }` and
  `ProjectRow = { id; name; about: string | null; repositoryName: string | null; lead: { agentId; name } | null; waiting: number }`.
  Rows come in pick order: the picked one first, then the one that needs help most, then A to Z.

- [ ] **Step 1: Write the failing tests.** Only readable projects (a private one of another person is absent); the
  invitation's project is picked and first; an unreadable or unknown `invitedTo` falls back to the needs-help order; that
  order is waiting per Member working there, then waiting, then A to Z; a project without a pulse lists 0 waiting and no
  Lead; `repositoryName` is the GitHub repository's name, never a folder; a person with no readable project gets an empty
  list and `pick: null`; 100 projects with 80-character purposes stay under 15 KB.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/projectList.test.ts`. Expected: FAIL (no module).
- [ ] **Step 3: Commit** the failing test.
- [ ] **Step 4: Implement** `projectList.ts`, the store method (person only, `readLoad` as `proposals` does) and the route.
- [ ] **Step 5: Run** the test file. Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 3: A main project and a role on every agent

**Files:**
- Modify: `backend/src/superTabs/model.ts` (`Agent.mainProjectId?`, `AgentStartRequest.mainProjectId?`)
- Modify: `backend/src/superTabs/agentKind.ts` (`AgentRole`, `ledProjects`)
- Modify: `backend/src/superTabs/read/views.ts` (`agentView` keeps `mainProjectId` out of the part; derived `role`,
  `mainProjectId`), `backend/src/superTabs/read/contract.ts`
- Modify: `backend/src/superTabs/commands.ts` (`agent.new`, `buddy.create`, `agent.started`, `project.delete`)
- Test: `backend/src/superTabs/mainProject.test.ts`, `backend/src/superTabs/agentKind.test.ts`

**Interfaces:**
- Produces: `ledProjects(state): Map<agentId, projectId>`, one pass per read (`ledProject` scans every conversation per
  call). A Lead's main project is the one it leads, else the stored one. Derived agent row gains `role` and `mainProjectId` (null when none, or when the reader
  can't read it). `agent.new` and `buddy.create` take an optional `mainProjectId`.

- [ ] **Step 1: Write the failing tests.** A Regular agent started by the server with a main project carries it; a local
  start or a Lead that names one is refused `MAIN_PROJECT_MEMBER_ONLY`; Bring agent (`buddy.create`) with a main
  project makes a Buddy whose role is member and main project is that one; a project the person can't read is refused
  `NOT_FOUND`; a PM made by `agent.new` is a Lead whose main project is its project; the derived rows carry `role` and
  `mainProjectId` while `kind` is unchanged; a reader who can't read the main project gets null; deleting the project
  clears it; a command without `mainProjectId` behaves as today.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/mainProject.test.ts src/superTabs/agentKind.test.ts`. Expected: FAIL.
- [ ] **Step 3: Commit** the failing tests.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** these tests and the tests of what imports the changed code (`agentNew.test.ts`, `buddies.test.ts`,
  `read/views.test.ts`, `deletion.test.ts`). Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 4: The read's cost at prod scale

- [ ] **Step 1:** On a synthetic Swarm (100 projects, 600 agents, 2,000 tasks), time `readerView` on main and on this
  branch, the added derive work alone, and `projectList` (p50 and p95), and record their bytes. Put the numbers in the
  pull request; no timing is asserted in a test (no flaky timing gates). The byte bound is asserted in
  `projectList.test.ts`: 100 projects with every field at its longest stay under 64 KB (the spec's 15 KB assumed 150-byte
  rows; a 100-project list with one-line purposes measures 16.5 KB). The read touches no collection beyond the first load
  and its project chats, so no index changes.
