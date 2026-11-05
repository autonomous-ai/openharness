# Project Ownership Follows Membership Implementation Plan

> Implemented task by task, test first, by the project's Engineer workflow (no subagent hand-off).

**Goal:** A private project's owner who leaves the Swarm or is removed from it loses the project. Ownership passes to a
remaining member, and the project stays manageable.

**Architecture:** Each project stores its owner's membership generation (`ownerGeneration`). Every owner check goes
through one helper (`ownsProject`) that matches id and generation, as member checks already do. One pure function
(`settleOwners`) gives a project whose owner is gone a new owner: the earliest-listed remaining member, else the Swarm
owner for a public project, else nobody (ownerless). `member.remove` (removal and leave), `invite.accept` and the one-off
migration job all call it. An ownerless project is readable by nobody. The Swarm owner sees only its id, name and number
of chats, and may delete it.

**Tech Stack:** TypeScript, vitest, Prisma (MongoDB) for the migration job.

**Spec:** Task #3073 (River's ruling, 2026-11-05) and Diego's proposal in the openharness project chat (current main
1da94962a).

## Global Constraints

- PR body first line: "Requested by diego through Harness."
- Access and private data: two independent security reviews.
- A project whose owner never left works exactly as today.
- A rejoining former owner gets nothing back unless invited to the project again.
- Nobody reads an ownerless private project, the Swarm owner included. The Swarm owner sees its name and size only, and
  may delete it.
- Swarm code stays out of cli/src/core. Temporary files only in mktemp -d folders.

## Design

- Growth: one optional string per project (at most 100 projects per Swarm). An ownerless project is deleted by the
  Swarm owner, and its delete removes the field with it.
- Concurrency: the same Swarm command lock as every command. The migration writes the head guarded by its version, as
  the instructions migration does: a command in between wins, and the Swarm is retried on the next run.
- Read cost: no new read. `visibleState` adds a list for the Swarm owner built from projects already loaded.
  `visibilityChanged` gains `ownerId`, so a handover reloads readers once, the same as the removal it comes with.
- Scale: O(projects × members) per settle, and settle runs only on member.remove and invite.accept: at most 100 × 200.
  The first warning would be member.remove latency in the command timing logs.
- Compatibility: `ownerGeneration` is an added field. Older clients ignore it and `ownerlessProjects`. An ownerless
  project never reaches a client's project list (no one reads it), so its empty `ownerId` is never shown.
- Migration + rollback: `scripts/swarm-project-owners/migrate.ts` is a dry run unless `--apply`. It fills
  `ownerGeneration` from the owner's current membership and hands over projects whose owner is already gone, printing
  each handover (project, old owner id, new owner id). Rollback: the previous backend ignores `ownerGeneration`. A
  handover is not reverted, because reverting it restores the bug; the printed report is the record. Until the job runs,
  a project without `ownerGeneration` keeps today's id-only owner check. `member.remove` and `invite.accept` settle such
  projects on their own.
- Audience: the server decides who owns and reads (`ownsProject`, `canReadProject`, `manageProject`). The Swarm owner's
  ownerless list carries id, name and chat count only.
- Identity: ownership is a membership (id + generation), never a login: the same account rejoining is a new membership.
- Failure: a refused manage or delete says why (PROJECT_OWNER_REQUIRED or NOT_FOUND, as today). A delete of an ownerless
  project with agents still starting is refused in words that name nothing inside it.
- Platforms: backend only. Clients read the new owner from `ownerId` as today.

## Review Focus

- A former owner rejoining by link, domain or Workspace join (store.ts) before the migration job runs keeps today's
  id-only check for a project without `ownerGeneration`. The job closes that window. Run it right after deploy.
- The earliest remaining member is a viewer: they become owner but cannot manage (READ_ONLY). Settle prefers the
  earliest non-viewer member, then any member.
- A stale member entry of the old owner (an earlier generation) must never be picked as the next owner.
- Refusals when the Swarm owner deletes an ownerless project must not name its chats, tasks or agents.
- Other raw `project.ownerId` checks (repository, task closing, buddy moves, machine accounts, team terminals) must use
  the generation-checked helper.

---

### Task 1: Owner checks match the owner's membership

**Files:**
- Modify: `backend/src/superTabs/projects.ts` (`SwarmProject.ownerGeneration`, `ownsProject`, `canReadProject`,
  `manageProject`, `teamSessionAccess`)
- Modify: `backend/src/superTabs/commands.ts` (`project.create`, and the raw owner checks at project.repository,
  agent moves, decisions/closes)
- Modify: `backend/src/superTabs/model.ts` (machine accounts `mayMove`)
- Test: `backend/src/superTabs/projectOwners.test.ts`

**Interfaces:**
- Produces: `ownsProject(state: SuperTabState, userId: string, project: SwarmProject): boolean`. It is true when
  `ownerId === userId`, the person is in the Swarm and `ownerGeneration` is absent (legacy) or equals their generation.

- [ ] Write the failing test: P creates private X. P's generation changes (left and rejoined). P no longer reads X
  (`visibleState(state, P).projects` lacks X), `project.sharing`/`project.rename` by P are refused, and `ownsProject` is
  false. P with the same generation still reads and manages X. A project with no `ownerGeneration` still matches by id.
  `project.create` stores the creator's generation.
- [ ] Run it and watch it fail.
- [ ] Implement it, routing every owner check through `ownsProject`.
- [ ] Run projectOwners.test.ts, projects.test.ts and commands.test.ts. Commit.

### Task 2: Ownership passes to the earliest remaining member

**Files:**
- Modify: `backend/src/superTabs/projects.ts` (`settleOwners`)
- Modify: `backend/src/superTabs/commands.ts` (`member.remove`, `invite.accept`)
- Modify: `backend/src/superTabs/parts/commit.ts` (`visibilityChanged` includes `ownerId`)
- Test: `backend/src/superTabs/projectOwners.test.ts`, `backend/src/superTabs/parts/commit.test.ts`

**Interfaces:**
- Produces: `settleOwners(state: SuperTabState): Array<{ projectId: string; from: string; to: string }>` (to is '' when
  ownerless). It fills a missing `ownerGeneration` for an owner still in the Swarm, and hands over a project whose owner is
  gone or whose generation is stale.

- [ ] Write the failing tests:
  - Diego's case: P creates private X with member C. The Swarm owner removes P. C now owns and manages X (renames it). P,
    invited again as viewer and accepted, doesn't see X and can't reshare it.
  - P leaves by itself: the same handover.
  - The earliest non-viewer member is chosen, and a stale entry is skipped.
  - A public project with no member goes to the Swarm owner.
  - A project whose owner stayed is unchanged.
  - `visibilityChanged` is true when only `ownerId` changed.
- [ ] Run them and watch them fail.
- [ ] Implement it.
- [ ] Run the tests above. Commit.

### Task 3: An ownerless project: nobody reads it, the Swarm owner may delete it

**Files:**
- Modify: `backend/src/superTabs/projects.ts` (`deletableProject`, `deleteProject`)
- Modify: `backend/src/superTabs/commands.ts` (`project.delete`)
- Modify: `backend/src/superTabs/model.ts` (`visibleState` `ownerlessProjects` for the Swarm owner, type on `SuperTabState`)
- Test: `backend/src/superTabs/projectOwners.test.ts`

- [ ] Write the failing test: P creates private X with no member. The Swarm owner removes P. X's `ownerId` is ''.
  Nobody reads X: not the Swarm owner, not P re-invited. The Swarm owner's `visibleState.ownerlessProjects` is
  `[{ id, name, conversations }]` and no one else gets it. The Swarm owner can't rename or reshare X, and
  `readConversation` is refused, but `project.delete` removes it with its chats and agents. A collaborator can't delete
  it. Pending starts refuse the delete without naming them.
- [ ] Run it and watch it fail.
- [ ] Implement it.
- [ ] Run the tests. Commit.

### Task 4: Migration job for existing projects

**Files:**
- Create: `backend/src/superTabs/migration/projectOwners.ts` (`migrateProjectOwners(db, { apply })`)
- Create: `backend/scripts/swarm-project-owners/migrate.ts`
- Test: `backend/src/superTabs/projectOwners.test.ts` (migration cases through `settleOwners` on legacy states)

- [ ] Write the failing tests: on a legacy state (no `ownerGeneration`), settle fills the present owner's generation and
  changes nothing else. A project whose owner already left is handed over, or made ownerless. A second settle changes
  nothing.
- [ ] Run them and watch them fail.
- [ ] Implement the job as `migration/instructions.ts` does: load each format-2 Swarm, settle, and write the head guarded
  by its version (visibility epoch +1 when an owner changed). Report swarms, projects filled, handovers and failures.
  It is a dry run without `--apply`.
- [ ] Run the tests and typecheck. Commit.
