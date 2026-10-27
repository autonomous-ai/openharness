# Several teams on one account, with roles

**Goal (roadmap, January):** three teams use Swarm side by side, a person can belong to several of them, and no team
reads another's data. People in a team have roles: owner, admin, member, guest.

**Status:** design, waiting for the Product Manager's approval. Nothing is built yet.

## What is missing today

Each Swarm is already its own audience: a Swarm reads only for the people in it (`SuperTab.memberIds`, `person()` in
`superTabs/model.ts`). What is missing is the layer above a Swarm:

- A person in several groups sees one flat list of every Swarm, with nothing to tell the groups apart or switch.
- The only role above a project is the Swarm's own: owner, collaborator, viewer. Nobody but a Swarm's owner can manage
  its people, and nobody can manage people across several Swarms.
- Join by email domain is company-wide: two teams on `autonomous.ai` cannot keep each other out of their Swarms.
- Swarms an outside customer will own (March) need a boundary for people, roles and, later, billing and an audit log.

## Words

On screen it is a **Team**, the roadmap's word. That word is taken in code: the Harness **Team account** (a hidden
macOS user for teammates' work, `sessionKind: 'team'`, `teamWorkCheck`, `teamHost`). So that `team` keeps meaning the
macOS account in code, the new layer is **`org`** in code (`SwarmOrg`, `orgId`) and **Team** on screen. The naming
system gets one line: "A **Team** holds Swarms and people. Not the Harness Team account, which is a macOS user."

## Model

```
Team (SwarmOrg)  ── people with a team role (SwarmOrgMember)
  └─ Swarms (SuperTab.orgId)  ── people with a Swarm role, as today (owner / collaborator / viewer)
       └─ projects  ── Public (everyone in the Swarm) or Private (invited), as today
```

- **`SwarmOrg`** `{ id, autonomousEnv, name, ownerId, revision, createdAt, deletedAt?, purgeAt? }`. Small, rarely
  written.
- **`SwarmOrgMember`**, one document per person: `_id = orgId:userId`, `{ orgId, userId, email, role, generation,
  version, addedBy, addedAt, removedAt? }`. Indexes `[orgId, removedAt]` and `[userId, removedAt]`.
- **`SwarmOrgInvitation`**, one per invited email: `{ orgId, email, role, invitedBy, expiresAt }`, 14 days.
- **`SuperTab.orgId`** (new, nullable until migration) with index `[autonomousEnv, orgId]`, and the same id on the
  Swarm's head part (`state.orgId`), which every load already reads. A Swarm belongs to exactly one Team, and never
  moves between Teams in this version.
- Swarm people, Swarm roles, project visibility and project members stay where they are (`SwarmMember` parts).

A Swarm is reachable only by its Swarm's people, as today, **and** only while each of them is a current person of the
Swarm's Team. The Team never grants access to a Swarm by itself; it limits who may be in one and who may manage it.

## Roles

| May… | Owner | Admin | Member | Guest |
|---|---|---|---|---|
| See the Team's people list | ✓ | ✓ | ✓ | only people in their own Swarms (as today) |
| See the names of the Team's Swarms | all | all | Team-visible ones and their own | their own |
| Read a Swarm | only if in it | only if in it | only if in it | only if in it |
| Read a Private project | only if invited | only if invited | only if invited | only if invited |
| Join a Team-visible Swarm by themselves | ✓ | ✓ | ✓ (as collaborator) | – |
| Create a Swarm in the Team | ✓ | ✓ | ✓ | – |
| Invite people to the Team | ✓ (any role) | ✓ (member, guest) | – | – |
| Invite people to a Swarm they are in | ✓ | ✓ | ✓ (member, guest) | – |
| Change roles, remove people | ✓ (anyone) | ✓ (members, guests) | – | – |
| Delete a Team Swarm, or set its Team visibility | ✓ | ✓ | the Swarm's owner | – |
| Contribute a machine to a Swarm they are in | ✓ | ✓ | ✓ | ✓ (as today) |
| Rename the Team, transfer or delete it | ✓ | – | – | – |

- **Deny by default.** Admins and owners manage people and Swarm metadata; they do **not** read a Swarm, a chat or a
  Private project they are not in. Reading always needs the Swarm's own membership.
- **Swarm roles stay.** Inside a Swarm a person is owner, collaborator or viewer, as today. A guest is never a
  Swarm's owner.
- **Team visibility of a Swarm:** `invite-only` (default, today's behavior) or `team` (every member and above sees its
  name and can join it). Guests never see a Swarm they were not added to.
- **Joining a Swarm from outside the Team** (an email invitation, a shared link or an email domain) also adds the person
  to its Team as a **guest**, never higher. A domain join is limited to the Team that owns the Swarm.
- **Removing someone from a Team** removes them from every Swarm of that Team (see Concurrency).
- **Exactly one owner.** Ownership transfers only to an admin, who must accept.

## Shown on each platform

- **Desktop:** a Team menu at the top of the Swarm sidebar shows the current Team's name. It opens to the person's
  Teams, each with its Swarms, then **Team settings** (people and roles, for owners and admins) and **New Team**.
  Picking a Swarm opens its tab, as today. The tab bar keeps the Swarm tabs the person has opened, each with its
  Team's name on hover. Cmd-S creates the new Swarm in the current Team.
- **Web (account pages):** Team settings: people, roles, invitations, Team visibility of each Swarm. No Swarm
  chat on the web in this version.
- **Phone:** Swarm Home shows the Team's name over its projects and a switch when the person has more than one
  Team. Tony decides the layout; the API is ready with the backend.
- **CLI:** `harness super-tab teams` lists Teams and their Swarms. Commands by Swarm id keep working.

## Design (docs/feature-design-rules.md)

Reviewed revision: ______  Reviewer (another engine): ______

1. **Growth.** Lifecycle, no empty cells:

   | Record | Create | Update | Leave / removed | Delete | Purge | Recreated under the same key |
   |---|---|---|---|---|---|---|
   | SwarmOrg | New Team; migration; first Swarm created by a person with no Team | rename, `revision`+1 | – | owner deletes: only with no live Swarm; `deletedAt` | 30 days after `deletedAt` | ids are random, never reused |
   | SwarmOrgMember | invitation accepted; joining a Team Swarm; migration | role change, `version`+1 | `removedAt` set, Swarm removals follow | with its Team | 30 days after `removedAt` | rejoin writes a new `generation`, so old receipts and deliveries stay refused (the D12 rule) |
   | SwarmOrgInvitation | invite | resend moves `expiresAt` | accepted or revoked: deleted | – | at `expiresAt` | a new invitation per send |
   | SuperTab.orgId | Swarm create; migration | never (no moves in this version) | – | with the Swarm, as today | as today | – |

   Readers of "all": the people list and the Team's Swarm list skip `removedAt` and `deletedAt`; the purge sweep
   joins `sweeps.ts`. Without the purge, removed people grow by one small document per removal: nothing breaks
   before about a million in one Team.

2. **Concurrency.** A Team write locks one document: a role change or removal locks that person's
   `SwarmOrgMember` (version compare); a Team rename locks `SwarmOrg`. Invariants and their keepers:
   - *A removed person never acts again in a Team Swarm.* Every Swarm command reads the caller's `SwarmOrgMember` in its
     transaction. The removal's transaction sets `removedAt` **and** touches that person's `SwarmMember` part in each
     Swarm of the Team (at most the Team's Swarm count, 10 today), so a command in flight conflicts and retries into
     the refusal, as a Swarm removal does today. The per-Swarm cleanup (agents, contributions, private grants) then
     runs through the existing person-removal path, one Swarm transaction each; a sweep finishes any that failed.
   - *Exactly one owner:* transfer writes both members in one transaction.
   - *A guest is never a Swarm owner:* checked in Swarm ownership transfer and in Team role changes (demoting a
     Swarm owner to guest is refused until that Swarm has another owner).
   - *A machine serves teammates' work for one Team* (see Audience): checked in `teamWorkCheck`, which every start,
     assignment, Reviewer add and route already passes through.
   - Sweeps, liveness checks and machine reports act as the machine, not as a person, and do not read Team roles;
     cleanup after a removal is the only Team sweep.
   - Thin end-to-end slice before the build splits: two Teams, one person in both, a removal racing a post.

3. **Read cost.**
   - Every Swarm read and command: one point read of `SwarmOrgMember` by `_id` (about 300 bytes loaded, nothing
     sent), in `store.actor()`; the Team id comes from the head part already loaded. Tested by counting database
     reads in the read fixture (`read/fixture.test-support.ts`).
   - Teams list (Desktop menu, phone, CLI): the person's `SwarmOrgMember` rows by `userId`, their Teams, and the
     Swarms each shows them. At 10 Teams × 10 Swarms: about 3 KB sent, about 40 KB loaded. The Swarm list adds
     `orgId` to each row (about 30 bytes).
   - People list: one Team's members, 60 at 10x, about 12 KB, paged at 200.
   - Removals reach readers: a removed person's next read is refused (`TEAM_ACCESS_REVOKED`), and the Swarm's
     own people see the existing person-removal change. The Teams list carries a `revision` per Team, so a client
     learns that a Team or Swarm left its list.

4. **Scale.** Today: 1 real Team (6 people, 1 main Swarm, about 25 agents). At 10x: 60 people per Team, 10 Swarms
   per Team, 10 Teams per person. The membership point read stays one indexed read. The removal transaction touches
   at most a Team's Swarm count of parts; first warning: the 95th percentile of that transaction's duration and the
   count of Swarms per Team, logged on each removal. A Team over 100 Swarms makes removal batch across
   transactions (the cleanup sweep already does). Measured on the thin slice: the read-count test, and the removal
   timing with 10 Swarms.

5. **Compatibility.** New fields: `SuperTab.orgId`, and `orgId` / `orgName` on Swarm list rows.
   - Old Desktop and phone ignore the new list fields and show every Swarm as today. No Team menu, no break.
   - Old CLI (`harness super-tab`) addresses Swarms by id; nothing changes for it.
   - An old client creating a Swarm (no `orgId`) creates it in the person's default Team: their own owned Team, made
     on first need. That is what Swarm creation does today.
   - A person removed from a Team gets `TEAM_ACCESS_REVOKED` (403) on an old client, which already shows a 403
     Swarm as unavailable.
   - During a rolling deploy, an old backend serving a Swarm ignores `orgId` and serves it by Swarm membership, as
     today; the only gap is a removal whose Swarm cleanup has not run, which the removal's own transaction closes
     by finishing the cleanup before it answers when there are 10 Swarms or fewer.
   - Existing readers of `SuperTab` rows (from a search of `superTab.find*`/`update*` outside tests):
     `store.ts` (row, list, invitations, create, host grids), `read/service.ts` (list, row), `read/host.ts` (host
     changes: by machine, unchanged), `sweeps.ts` (unchanged), `migration/*` (state-parts migration: carries `orgId`
     over), `parts/commit.ts` (writes the row; keeps `orgId`). The build re-runs this search and adds one line per
     reader to the PR.

6. **Migration and rollback.**
   - Order: (1) deploy the backend that reads `orgId` when present and creates Teams for new Swarms; (2) run the
     migration; (3) turn on `SWARM_TEAMS_REQUIRED`, after which a Swarm without `orgId` is refused, then (4) release
     Desktop with the Team menu. Steps 2 and 3 on production only with Ken's go.
   - Migration, additive: one Team per Swarm owner, named after their Swarm when they own one, else "Name's team".
     The owner becomes the Team's owner. Everyone else in that owner's Swarms becomes a **guest**: they see exactly
     what they see today, and the owner promotes people in Team settings. It writes `orgId` on each Swarm and creates
     documents; it changes nothing that exists. Idempotent: ids are derived from the owner, so a second run finds
     them.
   - Rollback: the previous release ignores `orgId` and the three new collections, and serves every Swarm by Swarm
     membership, as today. Team-visible joins made meanwhile are ordinary Swarm memberships and stay valid. A guest's
     limits are not enforced by the old release, but a guest there has exactly a Swarm member's rights, as today.
     Removals finish their Swarm cleanup before answering, so nobody removed regains a Swarm. Undo of the
     migration: unset `orgId`, drop the three collections.
   - Production data check: an isolated restore of the production backup before the branch merges, or Ken's no plus
     read-only anomaly queries: Swarms without an owner in `people`, people in Swarms of several owners, and
     sessions registered in Swarms of two owners.

7. **Audience: the server enforces it.** One predicate, `orgAccess(tx, user, state, actor)`, called in
   `store.actor()`, where every person and agent path already resolves its caller: commands, the read API's
   parts, changes, groups and leaderboard, messages, mentions, decisions, starts, uploads, terminals, deliveries and
   GitHub tokens. For a person it checks the person; for an agent, both the machine's owner and the agent's
   contributor. Where private data can end up, and the guard:
   - API reads, change feeds, dormant stubs: through `store.actor()`; a test per route that a person of Team A gets
     404 for a Swarm of Team B, and `TEAM_ACCESS_REVOKED` after removal. Host routes (by machine) serve only a
     machine's own pools and starts, as today; a removed person's contributions leave with the removal.
   - Swarm and Team lists, invitations: filtered by the person's `SwarmOrgMember` rows and role; guests see only their
     own Swarms.
   - Notifications, mentions, morning digest, phone push: built from Swarm membership; the digest and push skip a
     person whose Team membership is removed (a test each).
   - Agents' terminals and scrollback: delivered only inside a Swarm, as today; removal stops the removed person's
     agents through the existing person-removal path.
   - Shares (`mayOpenShare`) of a Swarm agent: also require the opener's Team membership.
   - The same session in another Swarm: `SuperTabSessionScope` already keeps a confidential session to one Swarm;
     a session's Swarms must also belong to one Team, checked at registration.
   - **The same machine for two Teams:** a Team account runs every teammate's work as one macOS user, so Team A's
     agents could read Team B's worktrees there. A machine takes teammates' work for one Team at a time
     (`MACHINE_IN_OTHER_TEAM`); its owner's own projects run as the owner in any Team, as today.
   - Logs and stored observations: Team ids and roles only, no emails in logs.
   - A rolled-back release: see 6; it shows no more than today.

8. **Identity.** Team actions are always the signed-in person's. A team (macOS Team account) session and an agent can
   never change a Team, its people or roles: refused with `TEAM_SESSION_LIMITED` / 403. Agents keep running as their
   contributor's grant, as today, and a machine's Team account never stands in for a person.

9. **Failure.**
   - A removal whose Swarm cleanup fails: the person is refused at once by the predicate; the cleanup sweep retries,
     and owners and admins see "Removing from 1 Swarm…" in Team settings until it finishes.
   - The last owner leaving: refused with a sentence asking to transfer first.
   - Deleting a Team with Swarms in it: refused with the count.
   - A refused join or invitation (guest limit, domain of another Team) says why in the dialog.
   - A start refused by `MACHINE_IN_OTHER_TEAM` fails with that reason in the group, and the route leaves the
     machine out with the reason, as `teamWorkCheck` already does.

10. **Platforms.** Backend (all clients). Desktop on macOS, Windows and Linux: the same Team menu. Web: Team
    settings only. Phone: Team name and switch on Swarm Home, laid out by Tony. CLI: a Teams list. The
    one-Team-per-machine rule concerns Team accounts, which are macOS only; dedicated agent machines (Linux, Windows)
    follow the same rule.

Review again when a Team passes 100 Swarms or 1,000 people, or when a cross-Team read needs a second patch.

## Build, after approval

1. Backend model and migration (red first): `SwarmOrg`, `SwarmOrgMember`, `SwarmOrgInvitation`, `SuperTab.orgId`;
   create puts a new Swarm in a Team; the migration and its rollback, with a test on a fixture of today's Swarms.
2. Permission checks: `orgAccess` in `store.actor()`, the lists, the digest, push and shares; one cross-Team test per
   read path and per command family; the removal cascade with the in-flight race test.
3. Team commands and API: create, rename, invite, accept, role change, remove, transfer, Team visibility, Teams list.
4. Machine rule: one Team per machine for teammates' work, in `teamWorkCheck`.
5. Desktop: Team menu and Team settings (`desktop/lib/super_tabs/`), CLI `harness super-tab teams`.

## Open questions for the Product Manager

1. Migrated people as **guests** (no new visibility; the owner promotes) or as **members** (they see the Team's
   people list at once)? Recommended: guests.
2. Code name `org` with **Team** on screen, to keep `team` for the macOS Team account? Recommended: yes.
3. Team visibility of a new Swarm: `invite-only` by default, as today? Recommended: yes.
