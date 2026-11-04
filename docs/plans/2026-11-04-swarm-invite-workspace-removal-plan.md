# Swarm invitations respect a Workspace removal Implementation Plan

> Way of working: this project's Engineer role (project instructions): the Engineer implements this plan itself, task by
> task, test first; the pull request's review steps are the independent review. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A Swarm invitation never brings back a person the Workspace removed unless a Workspace owner or admin sent it,
and never clears that person's auto-join decline on anyone else's authority (task #2939, security review 2 of #2714).

**Architecture:** The Swarm invitation records its sender (`invitedBy`). `invite.create` refuses a plain member's
invitation for an email the Workspace removed; `invite.accept` in a Workspace Swarm re-checks at accept time that a
removed person's invitation was sent by someone who is, now, a Workspace owner or admin, and adds them with that sender
as `addedBy`. The accept check is the authority (it keys by the accepting account); the create check is the early answer.

**Tech Stack:** TypeScript, Fastify, Prisma on MongoDB, Vitest with an in-memory replica set.

**Spec:** task #2939's brief (Changes, Constraints, Acceptance checks); Workspaces design
docs/plans/2026-10-27-swarm-workspaces.md (Roles, Identity).

## Global Constraints

- Code: `WORKSPACE_ACCESS_REVOKED` for a refused accept. Workspace roles allowed to bring a removed person back: those
  with `workspace.invite` (owner, admin).
- Never clear the Workspace's `autoJoinDeclined` on a path no Workspace owner or admin authorized.
- `addedBy` is the real inviter, never the Swarm owner on someone else's behalf (design, Identity).
- Tests in backend/integration/superTabWorkspaces.test.ts. Swarm code stays out of cli/src/core.

## Design

- growth: `invitedBy` is one id on an invitation, which goes when it is accepted, revoked, replaced or expires.
- concurrency: the checks run inside the Swarm command's transaction, which already reads the Workspace rows.
- read cost: create adds, only for an inviter without `workspace.invite`, one `User` read by its unique email and the
  member row by id; accept adds the member row by id (and the Workspace row only when that row is gone) plus, for a
  removed person, the inviter's member row by id.
- scale: all reads are by unique key; nothing grows with Workspace size.
- compatibility: an invitation from before this change has no `invitedBy`: a removed person is refused it (fail closed),
  anyone else accepts it as today with the Swarm owner as `addedBy`. Clients ignore the extra field.
- migration + rollback: none; an older backend ignores `invitedBy`.
- audience: the server enforces both checks; the create refusal tells a member only what the Workspace's people list
  already shows (the person is not in it).
- identity: `addedBy` is the inviter.
- failure: refusals carry their code and message; nothing is silently skipped.
- platforms: backend only.

## Review Focus

1. An admin sends the invitation, then is demoted to member before it is accepted: the accept is refused (checked at
   accept time). Pinned in Task 1.
2. A member's invitation sent before the person's removal, accepted after it: refused, and the decline is kept. Pinned in
   Task 1.
3. The removed person's member row was purged, only the Workspace's decline remains: `removedFromWorkspace` still says
   removed (existing helper); the same accept check applies.
4. The refused create answers the inviter with a role refusal, not "not available": the inviter can still reach the
   Swarm, and Desktop reads "not available" as the Swarm being gone. Pinned in Task 1.
5. A never-removed person invited by a plain member still joins as before, with the member as `addedBy`. Pinned in
   Task 1.

---

### Task 1: Swarm invitations check a Workspace removal

**Files:**
- Modify: `backend/src/superTabs/model.ts` (`Invitation.invitedBy?: string`)
- Modify: `backend/src/superTabs/commands.ts` (`CommandContext.inviteeRemoved`, `invite.create`)
- Modify: `backend/src/superTabs/store.ts` (context for `invite.create`; `invite.accept` guest add)
- Test: `backend/integration/superTabWorkspaces.test.ts`

**Interfaces:**
- Produces: `Invitation.invitedBy?: string`; `CommandContext.inviteeRemoved?: boolean` (set by the store for
  `invite.create` when the inviter lacks `workspace.invite` and the email's account was removed from the Workspace).

- [ ] **Step 1: Write the failing tests** in `describe('a Swarm invitation for someone the Workspace removed')`:
  - `refuses a plain member's invitation, at create and at accept, and keeps the removal and the decline`: member's
    create for a removed email → 403 `WORKSPACE_ROLE_REQUIRED`; a member's invitation sent before the removal, accepted
    after → `WORKSPACE_ACCESS_REVOKED` (404 not available over the route); member row keeps `removedAt`, the Workspace's
    `autoJoinDeclined` still lists them, they are not in the Swarm's people. An admin's invitation whose admin is demoted
    to member before accept → refused the same way.
  - `brings them back on a Workspace admin's invitation, with the admin as addedBy`: accept 200; row active, guest,
    `addedBy` = admin; decline cleared.
  - `lets a person never removed join through a member's invitation as today`: accept 200, guest row with
    `addedBy` = the member.
- [ ] **Step 2: Run them and watch them fail**
  Run: `npx vitest run --config vitest.super-tabs.config.ts integration/superTabWorkspaces.test.ts -t "someone the Workspace removed"`
  Expected: FAIL (create 200 instead of 403; accept 200; `addedBy` the Swarm owner).
- [ ] **Step 3: Commit the failing tests**
- [ ] **Step 4: Implement**: store `invitedBy` on create; the store sets `context.inviteeRemoved` for `invite.create`
  (only when `context.workspaceRole` lacks `workspace.invite`); `invite.create` refuses with `WORKSPACE_ROLE_REQUIRED`
  when it is set; on `invite.accept` in a Workspace Swarm, when `removedFromWorkspace`, require the inviter's active
  member row with `workspace.invite`, else `WORKSPACE_ACCESS_REVOKED`; pass `invitedBy ?? ownerId` as `addedBy`; fix the
  stale comment.
- [ ] **Step 5: Run the tests and see them pass**, plus the file's other tests and the backend unit tests of the
  changed modules.
- [ ] **Step 6: Commit and push**
