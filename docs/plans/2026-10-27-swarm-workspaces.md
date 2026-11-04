# Several workspaces on one account, with roles

**Goal (roadmap, January):** three workspaces use Swarm side by side, a person can belong to several of them, and no workspace
reads another's data. People in a workspace have roles: owner, admin, member, guest.

**Status:** design, waiting for the Product Manager's approval. Nothing is built yet.

## What is missing today

Each Swarm is already its own audience: a Swarm reads only for the people in it (`SuperTab.memberIds`, `person()` in
`superTabs/model.ts`). What is missing is the layer above a Swarm:

- A person in several groups sees one flat list of every Swarm, with nothing to tell the groups apart or switch.
- The only role above a project is the Swarm's own: owner, collaborator, viewer. Nobody but a Swarm's owner can manage
  its people, and nobody can manage people across several Swarms.
- Join by email domain is company-wide: two workspaces on `autonomous.ai` cannot keep each other out of their Swarms.
- Swarms an outside customer will own (March) need a boundary for people, roles and, later, billing and an audit log.

## Words

It is a **Workspace**, on screen and in code (`SwarmWorkspace`, `workspaceId`): Ken's decision (2026-10-28), in place
of the roadmap's **Team**. That word stays with the Harness **Team account** (a hidden macOS user for teammates' work,
`sessionKind: 'team'`, `teamWorkCheck`, `teamHost`), a different thing. The naming system defines **Workspace**
(docs/naming-system.md).

## Model

```
Workspace (SwarmWorkspace)  ── people with a workspace role (SwarmWorkspaceMember)
  └─ Swarms (SuperTab.workspaceId)  ── people with a Swarm role, as today (owner / collaborator / viewer)
       └─ projects  ── Public (everyone in the Swarm) or Private (invited), as today
```

- **`SwarmWorkspace`** `{ id, autonomousEnv, name, ownerId, revision, createdAt, deletedAt?, purgeAt? }`. Small, rarely
  written.
- **`SwarmWorkspaceMember`**, one document per person: `_id = workspaceId:userId`, `{ workspaceId, userId, email, role, generation,
  version, addedBy, addedAt, removedAt? }`. Indexes `[workspaceId, removedAt]` and `[userId, removedAt]`.
- **`SwarmWorkspaceInvitation`**, one per invited email: `{ workspaceId, email, role, invitedBy, expiresAt }`, 14 days.
- **`SuperTab.workspaceId`** (new, nullable until migration) with index `[autonomousEnv, workspaceId]`, and the same id on the
  Swarm's head part (`state.workspaceId`), which every load already reads. A Swarm belongs to exactly one Workspace, and never
  moves between Workspaces in this version.
- Swarm people, Swarm roles, project visibility and project members stay where they are (`SwarmMember` parts).

A Swarm is reachable only by its Swarm's people, as today, **and** only while each of them is a current person of the
Swarm's Workspace. The Workspace never grants access to a Swarm by itself; it limits who may be in one and who may manage it.

## Roles

| May… | Owner | Admin | Member | Guest |
|---|---|---|---|---|
| See the Workspace's people list | ✓ | ✓ | ✓ | only people in their own Swarms (as today) |
| See the names of the Workspace's Swarms | all | all | Workspace-visible ones and their own | their own |
| Read a Swarm | only if in it | only if in it | only if in it | only if in it |
| Read a Private project | only if invited | only if invited | only if invited | only if invited |
| Join a Workspace-visible Swarm by themselves | ✓ | ✓ | ✓ (as collaborator) | – |
| Create a Swarm in the Workspace | ✓ | ✓ | ✓ | – |
| Invite people to the Workspace | ✓ (any role) | ✓ (member, guest) | – | – |
| Invite people to a Swarm they are in | ✓ | ✓ | ✓ (member, guest) | – |
| Change roles, remove people | ✓ (anyone) | ✓ (members, guests) | – | – |
| Delete a Workspace Swarm, or set its Workspace visibility | ✓ | ✓ | the Swarm's owner | – |
| Contribute a machine to a Swarm they are in | ✓ | ✓ | ✓ | ✓ (as today) |
| Rename the Workspace, transfer or delete it | ✓ | – | – | – |

- **Deny by default.** Admins and owners manage people and Swarm metadata; they do **not** read a Swarm, a chat or a
  Private project they are not in. Reading always needs the Swarm's own membership.
- **Swarm roles stay.** Inside a Swarm a person is owner, collaborator or viewer, as today. A guest is never a
  Swarm's owner.
- **Workspace visibility of a Swarm:** `invite-only` (default, today's behavior) or `workspace` (every member and above sees its
  name and can join it). Guests never see a Swarm they were not added to.
- **Joining a Swarm from outside the Workspace** (an email invitation, a shared link or an email domain) also adds the person
  to its Workspace as a **guest**, never higher. A domain join is limited to the Workspace that owns the Swarm.
- **Removing someone from a Workspace** removes them from every Swarm of that Workspace (see Concurrency).
- **Exactly one owner.** Ownership transfers only to an admin, at once (ruling while building: an admin is already
  trusted, so no accept step; the old owner stays an admin).

## Shown on each platform

- **Desktop:** a Workspace menu at the top of the Swarm sidebar shows the current Workspace's name. It opens to the person's
  Workspaces, each with its Swarms, then **Workspace settings** (people and roles, for owners and admins) and **New Workspace**.
  Picking a Swarm opens its tab, as today. The tab bar keeps the Swarm tabs the person has opened, each with its
  Workspace's name on hover. Cmd-S creates the new Swarm in the current Workspace.
- **Web (account pages):** Workspace settings: people, roles, invitations, Workspace visibility of each Swarm. No Swarm
  chat on the web in this version.
- **Phone:** Swarm Home shows the Workspace's name over its projects and a switch when the person has more than one
  Workspace. Tony decides the layout; the API is ready with the backend.
- **CLI:** `harness super-tab workspaces` lists Workspaces and their Swarms. Commands by Swarm id keep working.

## Design (docs/feature-design-rules.md)

Reviewed revision: ______  Reviewer (another engine): ______

1. **Growth.** Lifecycle, no empty cells:

   | Record | Create | Update | Leave / removed | Delete | Purge | Recreated under the same key |
   |---|---|---|---|---|---|---|
   | SwarmWorkspace | New Workspace; migration; first Swarm created by a person with no Workspace | rename, `revision`+1 | – | owner deletes: only with no live Swarm; `deletedAt` | 30 days after `deletedAt` | ids are random, never reused |
   | SwarmWorkspaceMember | invitation accepted; joining a Workspace Swarm; migration | role change, `version`+1 | `removedAt` set, Swarm removals follow | with its Workspace | 30 days after `removedAt` | rejoin writes a new `generation`, so old receipts and deliveries stay refused (the D12 rule) |
   | SwarmWorkspaceRemoval | a removal from the Workspace | `finishedAt` once every Swarm of the Workspace is left | – | – | 30 days after `finishedAt` | keyed by the removed generation, so each removal is its own record |
   | SwarmWorkspaceInvitation | invite | resend moves `expiresAt` | accepted or revoked: deleted | – | at `expiresAt` | a new invitation per send |
   | SuperTab.workspaceId | Swarm create; migration | never (no moves in this version) | – | with the Swarm, as today | as today | – |

   Readers of "all": the people list and the Workspace's Swarm list skip `removedAt` and `deletedAt`; the purge sweep
   joins `sweeps.ts`. Without the purge, removed people grow by one small document per removal: nothing breaks
   before about a million in one Workspace.

2. **Concurrency.** A Workspace write locks one document: a role change or removal locks that person's
   `SwarmWorkspaceMember` (version compare); a Workspace rename locks `SwarmWorkspace`. Invariants and their keepers:
   - *A removed person never acts again in a Workspace Swarm.* Every Swarm read and command reads the caller's
     `SwarmWorkspaceMember` in its transaction (`store.actor()`), so every request that starts after the removal commits is
     refused. The person then leaves each Swarm of the Workspace through the existing leave (`member.remove` of
     themselves), one Swarm transaction each, which writes their `SwarmMember` part; the hourly sweep finishes any
     that failed, paging through every open removal record (`SwarmWorkspaceRemoval`) in id order. Nobody is brought back
     into the Workspace while a removal of theirs is open: accepting an invitation finishes it first, or is refused, so
     a Swarm the removal failed to leave never opens to them again under a new membership (review of #1811). Built: a request already in flight when the removal commits may still finish, the same window
     as a request that arrived a moment earlier (ruling while building: touching every Swarm's member part in the
     removal's transaction needs a write the parts layer has no no-op for).
   - *Exactly one owner:* transfer writes both members in one transaction.
   - *A guest is never a Swarm owner:* checked in Swarm ownership transfer and in Workspace role changes (demoting a
     Swarm owner to guest is refused until that Swarm has another owner).
   - *A machine serves teammates' work for one Workspace* (see Audience): checked in `teamWorkCheck`, which every start,
     assignment, Reviewer add and route already passes through.
   - Sweeps, liveness checks and machine reports act as the machine, not as a person, and do not read Workspace roles;
     cleanup after a removal is the only Workspace sweep.
   - Thin end-to-end slice before the build splits: two Workspaces, one person in both, a removal racing a post.

3. **Read cost.**
   - Every Swarm read and command: one point read of `SwarmWorkspaceMember` by `_id` (about 300 bytes loaded, nothing
     sent), in `store.actor()`; the Workspace id comes from the head part already loaded. Tested by counting database
     reads in the read fixture (`read/fixture.test-support.ts`).
   - Workspaces list (Desktop menu, phone, CLI): the person's `SwarmWorkspaceMember` rows by `userId`, their Workspaces, and the
     Swarms each shows them. At 10 Workspaces × 10 Swarms: about 3 KB sent, about 40 KB loaded. The Swarm list adds
     `workspaceId` to each row (about 30 bytes).
   - People list: one Workspace's members, 60 at 10x, about 12 KB, paged at 200.
   - Removals reach readers: a removed person's next read is refused (`WORKSPACE_ACCESS_REVOKED`), and the Swarm's
     own people see the existing person-removal change. The Workspaces list carries a `revision` per Workspace, so a client
     learns that a Workspace or Swarm left its list.

4. **Scale.** Today: 1 real Workspace (6 people, 1 main Swarm, about 25 agents). At 10x: 60 people per Workspace, 10 Swarms
   per Workspace, 10 Workspaces per person. The membership point read stays one indexed read. The removal transaction touches
   at most a Workspace's Swarm count of parts; first warning: the 95th percentile of that transaction's duration and the
   count of Swarms per Workspace, logged on each removal. A Workspace over 100 Swarms makes removal batch across
   transactions (the cleanup sweep already does). Measured on the thin slice: the read-count test, and the removal
   timing with 10 Swarms.

5. **Compatibility.** New fields: `SuperTab.workspaceId`, and `workspaceId` / `workspaceName` on Swarm list rows.
   - Old Desktop and phone ignore the new list fields and show every Swarm as today. No Workspace menu, no break.
   - Old CLI (`harness super-tab`) addresses Swarms by id; nothing changes for it.
   - An old client creating a Swarm (no `workspaceId`) creates it in the person's default Workspace: their own owned Workspace, made
     on first need. That is what Swarm creation does today.
   - A person removed from a Workspace gets `WORKSPACE_ACCESS_REVOKED` (403) on an old client, which already shows a 403
     Swarm as unavailable.
   - During a rolling deploy, an old backend serving a Swarm ignores `workspaceId` and serves it by Swarm membership, as
     today; the only gap is a removal whose Swarm cleanup has not run, which the removal's own transaction closes
     by finishing the cleanup before it answers when there are 10 Swarms or fewer.
   - Existing readers of `SuperTab` rows (from a search of `superTab.find*`/`update*` outside tests):
     `store.ts` (row, list, invitations, create, host grids), `read/service.ts` (list, row), `read/host.ts` (host
     changes: by machine, unchanged), `sweeps.ts` (unchanged), `migration/*` (state-parts migration: carries `workspaceId`
     over), `parts/commit.ts` (writes the row; keeps `workspaceId`). The build re-runs this search and adds one line per
     reader to the PR.

6. **Migration and rollback.**
   - Order: (1) deploy the backend that reads `workspaceId` when present and creates Workspaces for new Swarms; (2) run the
     migration; (3) turn on `SWARM_WORKSPACES_REQUIRED`, after which a Swarm without `workspaceId` is refused, then (4) release
     Desktop with the Workspace menu. Steps 2 and 3 on production only with Ken's go.
   - Migration, additive: one Workspace per Swarm owner, named after their Swarm when they own one, else "Name's workspace".
     The owner becomes the Workspace's owner. Everyone else in that owner's Swarms becomes a **guest**: they see exactly
     what they see today, and the owner promotes people in Workspace settings. It writes `workspaceId` on each Swarm and creates
     documents; it changes nothing that exists. Idempotent: ids are derived from the owner, so a second run finds
     them.
   - Rollback: the previous release ignores `workspaceId` and the three new collections, and serves every Swarm by Swarm
     membership, as today. Workspace-visible joins made meanwhile are ordinary Swarm memberships and stay valid. A guest's
     limits are not enforced by the old release, but a guest there has exactly a Swarm member's rights, as today.
     Removals finish their Swarm cleanup before answering, so nobody removed regains a Swarm. Undo of the
     migration: unset `workspaceId`, drop the three collections.
   - Production data check: an isolated restore of the production backup before the branch merges, or Ken's no plus
     read-only anomaly queries: Swarms without an owner in `people`, people in Swarms of several owners, and
     sessions registered in Swarms of two owners.

7. **Audience: the server enforces it.** One predicate, `workspaceAccess(tx, user, state, actor)`, called in
   `store.actor()`, where every person and agent path already resolves its caller: commands, the read API's
   parts, changes, groups and leaderboard, messages, mentions, decisions, starts, uploads, terminals, deliveries and
   GitHub tokens. For a person it checks the person; for an agent, both the machine's owner and the agent's
   contributor. Where private data can end up, and the guard:
   - API reads, change feeds, dormant stubs: through `store.actor()`; a test per route that a person of Workspace A gets
     404 for a Swarm of Workspace B, and `WORKSPACE_ACCESS_REVOKED` after removal. Host routes (by machine) serve only a
     machine's own pools and starts, as today; a removed person's contributions leave with the removal.
   - Swarm and Workspace lists, invitations: filtered by the person's `SwarmWorkspaceMember` rows and role; guests see only their
     own Swarms.
   - Notifications, mentions, morning digest, phone push: built from Swarm membership; the digest and push skip a
     person whose Workspace membership is removed (a test each).
   - Agents' terminals and scrollback: delivered only inside a Swarm, as today; removal stops the removed person's
     agents through the existing person-removal path.
   - Shares (`mayOpenShare`) of a Swarm agent: also require the opener's Workspace membership. For an agent, the check is
     on its contributor, not its machine's owner, who need not be in the Swarm today either.
   - The same session in another Swarm: `SuperTabSessionScope` already keeps a confidential session to one Swarm; see
     the next line for sessions in Swarms of two Workspaces.
   - **The same machine for two Workspaces:** a Team account runs every teammate's work as one macOS user, so Workspace A's
     agents could read Workspace B's worktrees there. A machine contributed to Swarms of two Workspaces takes teammates' work
     in neither (`MACHINE_IN_OTHER_WORKSPACE`, and routing leaves it out with that reason) until it leaves one; its owner's
     own projects run as the owner in any Workspace, as today. Ruling while building: neither Workspace wins, so nothing
     depends on which was first; the migration's dry run lists such machines first. This also covers a teammate's
     session in Swarms of two Workspaces, since teammates' sessions run in the Team account; a person's own session in two
     Workspaces is their own choice, and is not refused.
   - Logs and stored observations: Workspace ids and roles only, no emails in logs.
   - A rolled-back release: see 6; it shows no more than today.

8. **Identity.** Workspace actions are always the signed-in person's. A Team session (the macOS Team account) and an agent can
   never change a Workspace, its people or roles: refused with `TEAM_SESSION_LIMITED` / 403. Agents keep running as their
   contributor's grant, as today, and a machine's Team account never stands in for a person.

9. **Failure.**
   - A removal whose Swarm cleanup fails: the person is refused at once by the predicate; the cleanup sweep retries,
     and owners and admins see "Removing from 1 Swarm…" in Workspace settings until it finishes.
   - The last owner leaving: refused with a sentence asking to transfer first.
   - Deleting a Workspace with Swarms in it: refused with the count.
   - A refused join or invitation (guest limit, domain of another Workspace) says why in the dialog.
   - A start refused by `MACHINE_IN_OTHER_WORKSPACE` fails with that reason in the group, and the route leaves the
     machine out with the reason, as `teamWorkCheck` already does.

10. **Platforms.** Backend (all clients). Desktop on macOS, Windows and Linux: the same Workspace menu. Web: Workspace
    settings only. Phone: Workspace name and switch on Swarm Home, laid out by Tony. CLI: a Workspaces list. The
    one-Workspace-per-machine rule concerns Team accounts, which are macOS only; dedicated agent machines (Linux, Windows)
    follow the same rule.

Review again when a Workspace passes 100 Swarms or 1,000 people, or when a cross-Workspace read needs a second patch.

## Build, after approval

1. Backend model and migration (red first): `SwarmWorkspace`, `SwarmWorkspaceMember`, `SwarmWorkspaceInvitation`, `SuperTab.workspaceId`;
   create puts a new Swarm in a Workspace; the migration and its rollback, with a test on a fixture of today's Swarms.
2. Permission checks: `workspaceAccess` in `store.actor()`, the lists, the digest, push and shares; one cross-Workspace test per
   read path and per command family; the removal cascade with the in-flight race test.
3. Workspace commands and API: create, rename, invite, accept, role change, remove, transfer, Workspace visibility, Workspaces list.
4. Machine rule: one Workspace per machine for teammates' work, in `teamWorkCheck`.
5. Desktop: Workspace menu and Workspace settings (`desktop/lib/super_tabs/`), CLI `harness super-tab workspaces`.

## Open questions for the Product Manager

1. Migrated people as **guests** (no new visibility; the owner promotes) or as **members** (they see the Workspace's
   people list at once)? Recommended: guests.
2. Name: decided. **Workspace** on screen and `workspace` in code (Ken, 2026-10-28); `team` keeps meaning the macOS Team account.
3. Workspace visibility of a new Swarm: `invite-only` by default, as today? Recommended: yes.
