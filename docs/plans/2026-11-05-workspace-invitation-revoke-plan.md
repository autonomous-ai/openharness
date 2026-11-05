# Workspace removal is final, and a pending Workspace invitation can be revoked (task #3173) Plan

> Worked by the Engineer, test first (superpowers test-driven-development): each task's failing test is committed and
> seen red before the code that passes it.

**Goal:** A person removed from a Workspace cannot come back on an invitation sent before the removal, and owners and
admins can withdraw a pending Workspace invitation.

**Architecture:** `SwarmWorkspaces.remove` deletes the removed person's `SwarmWorkspaceInvitation` in the removal's
transaction. `SwarmWorkspaces.accept` also refuses an invitation sent before the person's latest removal from that
Workspace (an invitation pending from before this fix). A new `SwarmWorkspaces.revokeInvitation`, served by
`POST /api/super-tabs/workspaces/:workspaceId/invitations/revoke`, deletes a pending invitation for owners and admins,
limited to roles they may give (`mayAssignRole`).

**Tech Stack:** TypeScript, Fastify, Prisma on MongoDB, vitest with a real Mongo replica set (`npm run test:super-tabs`).

**Spec:** task #3173 brief; docs/plans/2026-10-27-swarm-workspaces.md (Growth: "accepted or revoked: deleted").

## Global Constraints

- Owned files only: `backend/src/superTabs/workspaceStore.ts`, `backend/src/routes/superTabs.ts`,
  `backend/integration/superTabWorkspaces.test.ts` (and this plan).
- No schema change. The invitation has no creation time; it is derived from `expiresAt - INVITATION_MS`, which is
  exact because `invite` sets (and every resend moves) `expiresAt` to send time plus `INVITATION_MS`.
- A POST, not a DELETE: Desktop reaches the backend through the daemon, which forwards only GET and POST.
- Access control is under the two-security-review rule.

## Design

- growth: no new record; revoke and removal delete an invitation (the plan's Growth row "accepted or revoked: deleted").
- concurrency: each action is one Mongo transaction. Remove's invitation delete and a concurrent invite's upsert write
  the same document, so Mongo aborts one as a write conflict. An invitation sent after the removal is a new, deliberate
  one and is accepted; one sent before it is refused at accept even if it survived (pending from before this fix).
- read cost: accept reads one more document (the newest removal of that person in that Workspace, by the
  `workspaceId, userId, finishedAt` index prefix); revoke reads one invitation by id.
- scale: unchanged at 10x; per-person reads only.
- compatibility: old clients never call revoke; accept answers 404 as for any unavailable invitation.
- migration + rollback: none. Rolling back restores today's behaviour; deleted invitations stay deleted (they were
  either withdrawn or belonged to a removed person).
- audience: the server checks the Workspace role (`workspace.invite`) and `mayAssignRole` for the invitation's role.
- identity: the signed-in person (`personOnly`), never the machine owner's login.
- failure: refusals answer 404 (no such pending invitation) or 403 (role), with a message.
- platforms: backend only; Desktop and phone Revoke buttons are a follow-up.

## Review Focus

- `revokeInvitation`: a member or guest gets 403, an outsider 404, an admin cannot revoke an admin invitation.
- `accept`: the removal-time comparison, and that an invitation for someone never removed is accepted as before.
- `remove`: the delete is in the same transaction as `removedAt`.

## Task 1: Removal deletes the pending invitation, and accept refuses one sent before the removal

**Files:** `backend/integration/superTabWorkspaces.test.ts`, `backend/src/superTabs/workspaceStore.ts`

**Interfaces:** none new.

- [ ] Test: invite a member's address again as admin (pending), remove the member, accept answers 404, the member row
      keeps `removedAt`, and no invitation is left.
- [ ] Test: an invitation pending from before the fix (written back after the removal, as an old removal left it)
      answers 404 at accept; a new invitation sent after the removal is accepted.
- [ ] Test: an invitation for someone never removed is accepted as today.
- [ ] Run them red: `npm run test:super-tabs -- integration/superTabWorkspaces.test.ts`.
- [ ] Code: `remove` deletes `${workspaceId}:${target.email}` in its transaction; `accept` reads the person's newest
      removal and refuses an invitation sent before it.
- [ ] Run them green.

## Task 2: Owners and admins revoke a pending invitation

**Files:** `backend/integration/superTabWorkspaces.test.ts`, `backend/src/superTabs/workspaceStore.ts`,
`backend/src/routes/superTabs.ts`

**Interfaces:** `SwarmWorkspaces.revokeInvitation(user, workspaceId, email): Promise<{ email: string; revoked: true }>`;
`POST /api/super-tabs/workspaces/:workspaceId/invitations/revoke` with body `{ email }`.

- [ ] Test: owner revokes an admin invitation, it leaves the people list's invitations and accept answers 404; a member
      and a guest get 403, an outsider 404; an admin gets 403 on an admin invitation and 200 on a guest one; revoking
      a missing invitation answers 404.
- [ ] Run red.
- [ ] Code: the method and the route.
- [ ] Run green, then the backend unit suite (`npm test`).
