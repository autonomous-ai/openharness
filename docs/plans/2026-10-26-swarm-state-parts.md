# Spec: Swarm state by parts (#1726)

Draft 1, 2026-10-26, Product Manager (River). Issue: https://github.com/autonomous-ai/openharness/issues/1726

## Intent and why

A Swarm must keep working with many people and agents at once and over months. Today each Swarm is one Mongo
document (`SuperTab.state`, one `revision`). Every write rewrites all of it and conflicts with every other
write; every reader downloads all of it; it only grows. One Swarm already returned 500s from write conflicts
(#1722 added retries and `SWARM_BUSY`, which eases the symptom only). The org launch waits for this work.

## Owner decisions (ken15, 2026-10-26, in project chat)

- Not tied to the 29 Oct date. Solve it properly, on its own branch, then merge and release once. Launch to
  the autonomous.ai org after this ships.
- Every client (backend, CLI, Desktop, web) moves to the new version at the same time. No compatibility period
  for older CLIs or Desktops.
- Highest priority, as fast as possible.

## Goals (from the issue's "Done when")

1. Agents working in different work groups of one Swarm never conflict with each other. Measured on a busy
   synthetic Swarm before and after.
2. A Swarm's active data stays small whatever its history. Finished work stays readable in Work details.
3. A poll costs what changed, not the whole Swarm.
4. Existing Swarms are migrated in place, with no lost history (messages, groups, decisions, runs).

## Non-goals

- No new Swarm features, no UI redesign. Screens look and behave as today, apart from archived groups
  loading on demand.
- No change to message, delivery, route-decision, run or attempt collections beyond what the new sequence
  source needs (they are already separate).
- No push transport (websocket or SSE) in this project. Polling for changes is enough; push can come later on
  the same cursor.

## Anti-goals (must not happen)

- A command acting on a stale read of something its rule depends on. Examples: two starts both taking a
  machine's last slot; an agent added after its member was removed.
- Any lost or reordered message, assignment result, check or route decision during or after migration.
- A client silently showing old data. An old client must get a clear "update Harness" error, not a broken
  screen.

## Facts the design starts from (code survey of main, 2026-10-26)

- Writers that bump the one revision: every command (`store.ts` execute), and outside commands:
  `observeMachine` (each contributed machine, at least every 15 s, per Swarm, probably the most frequent
  writer), native turn append (every terminal prompt and answer), delivery claim and ack (revision bump with
  no state change), hold notice, deliveries wake-up, stopped receipts, sharing, join.
- Every command also runs whole-state passes (`syncLeads`, `numberConversations`, `placeRules`,
  `expireRemovals`, `assignAgentDisplayNames`, `appendPullRequestUrls`, `noteProjectReports`). A worker's
  post in its own group also writes `projects[].progress`.
- Message `sequence` is the tab revision that carried it. Readers page messages by it.
- Readers: Desktop and web (the same Flutter code) poll the full state every 3 s per open Swarm. The CLI host
  ticks every 1 s and loads up to 100 full Swarms per tick. `harness super-tab` fetches the full state for
  every action, not just `status`. Pro cards load the full state every 5 s.
- Unbounded: `conversations` (removed only with their project), finished `starts`, `releasedHarnesses`,
  `overlapAlerts`, expired `invitations`.
- Tests: `backend/integration/superTabs.test.ts` (real MongoMemoryReplSet, about 10 concurrency cases),
  `commands.test.ts` (pure, no concurrency).

## Design

### Parts (storage)

| Part | One document per | Holds |
|---|---|---|
| Head | Swarm | scalars (name, owner, paused, environment, numbering), people, invitations, rules, routingPolicy, sharing, localModels, projects (settings and roles, not progress) |
| Group | work group / conversation | brief, task, checks, assignment, agentIds, leadId, pullRequestUrls, lastMessageSequence, archived, number, messageSeq counter |
| Agent | agent | the agent record, including volatile fields (downSince, alerting, limitedUntil, workDecision, configuration) |
| Machine | contributed machine | contribution settings, slots, harnessReservations, releasedHarnesses (capped), closingSessions, machineCleanups. The observation is stored here but written by its own path (below) |
| Start | agent start | one start record. Finished starts expire with a TTL (my call: 7 days) |
| Project progress | project | progress fields written by reports and posts |

Every part has its own `version` (incremented on each write) and a `changedAt` stamp (see Cursor).

### Concurrency rules

- A command writes only the parts it changes, each guarded by its version: compare-and-set inside one Mongo
  transaction, retried with #1722's backoff.
- Invariants are held by writes, not by reads. Mongo transactions catch write-write conflicts, not stale
  reads. So for every invariant one of these two must hold:
  (a) the command that depends on the invariant also writes (bumps) the part that holds it, or
  (b) the command that changes the invariant also writes every part that depends on it.
  - Example (a): `agent.start` and `agent.started` write the machine part (reservation), so two starts on one
    machine conflict, and starts on different machines don't.
  - Example (b): `member.remove` and `machine.remove` already write the affected agents and groups.
- The whole-state passes run only where their part changes. Example: display names when agents are added;
  numbering at group creation, using a head counter.
- Expected outcome: `message.send`, `work.status`, `work.check` and native turn appends in different groups
  touch only their own group and their own project-progress part.
- Machine observations write only the machine part. `recordAgentPresence` (`downSince`) writes an agent part
  only when the value actually changes.
- A delivery claim or ack must no longer bump a Swarm-wide revision. Its exactly-once and revocation
  guarantees move to the delivery row or the group part (left to the design group to choose; the existing
  integration tests must keep passing).
- The design group produces the full table: every command and every non-command writer, mapped to the parts
  it reads, the parts it writes, and the rule (a) or (b) that guards each invariant. The survey above seeds
  it.

### Change cursor and reads

- My call: no single global counter, because a counter written by every transaction is the same hotspot
  again. Each part write stamps `changedAt` from a monotonic per-process clock (server time, made strictly
  increasing).
- A client asks for parts with `changedAt > cursor − overlap` (overlap: my call, 10 s, so commits that land
  slightly out of order are not missed). It drops parts whose version it already has, and moves its cursor
  to the newest `changedAt` it received.
- Deletions are tombstones: a removed part keeps a document with `deleted: true` and a `changedAt`, and is
  purged after 7 days.
- Message `sequence` becomes per group, from the group part's `messageSeq` counter, written in the same
  transaction as the message. Clients page messages per group as they already do. Anything that needs a
  Swarm-wide order of messages uses `createdAt` plus `id`.
- Endpoints:
  - first load: the head plus active parts;
  - changes since a cursor;
  - archived groups on demand;
  - a host form for the CLI that returns, for all its Swarms, only the parts that changed. This replaces
    loading up to 100 full Swarms each second.
- `harness super-tab status` keeps its output (the Lead and agents depend on it) but builds it from the
  parts. Other actions stop fetching state they don't need.

### Archive

- A group whose assignment is done or cancelled and that has no message for 24 hours (my call), or that was
  archived by hand, leaves the active set.
- An archived group is not returned by first load or by changes. It is still readable in Work details, and a
  new message in it brings it back.
- `releasedHarnesses` is capped per machine (my call: 200, oldest dropped). Finished starts and expired
  invitations expire.

### Migration

- A one-shot, idempotent backend migration splits each `SuperTab` into parts, keeping every id.
- Messages get per-group sequences that preserve their current order.
- It runs during the release window, with backend, CLI and Desktop going out together. Verification for each
  Swarm: parts reassembled into the old shape equal the old state (field by field), and message counts and
  order match.
- A dry run on a copy of production data comes before the real run. The old `state` field is kept, read-only,
  until the owner says it can be dropped.
- Old clients: the backend answers the old full-state routes with an "update Harness" error that every client
  version shows as an error (my call: HTTP 426 with code `UPDATE_REQUIRED`).

## Rulings from the builder check (draft 2, my calls)

An engineer read draft 1 as a builder. These rulings settle what a wrong guess would change, and they override
the sections above where the two differ.

1. **Things that use the Swarm revision as a clock.** These are project progress (`noteProjectReports`
   writes `dirtyRevision` on every post), the Lead's wake-up text, `project.report.throughRevision`, and native
   `recordingProgress` (which looks a message up by `sequence: revision`). Each needs a replacement:
   - Project progress keeps a watermark per group (the group's last reported `messageSeq`). "Dirty" is
     computed on read.
   - The progress part is written only on the change from clean to dirty, so posts in different groups of
     one project don't conflict.
   - `throughRevision` becomes a map from group to sequence.
   - `recordingProgress` uses the group's `messageSeq`.
2. **Insert races.** Example: a message sent while its sender's membership is being removed. Every actor
   (person or agent) gets a small part of its own: a membership part for a person, the agent part for an
   agent.
   - Every command touches its actor's part, with a version-guarded no-op bump.
   - Removing the actor deletes or bumps that part.
   - The design table lists each command's touches (parts read and guarded, though unchanged) as well as its
     writes.
3. **Cursor safety.**
   - The client's next cursor is the server's read start time minus the overlap, not the newest `changedAt`
     received.
   - The overlap is at least the longest a transaction can live (set the transaction timeout explicitly;
     #1722 uses 15 s), plus clock drift between backend processes. My call: 30 s, with transaction timeout ≤
     15 s.
   - Group 1 confirms how many backend processes run and documents the clock source.
4. **Visibility.** Changes in role, project visibility, sharing and owner-only visibility, and derived views
   such as `otherProjectsWork`, can't be expressed as part changes. The head carries a visibility epoch; when
   it changes, the client reloads in full. Derived views are recomputed on the server for every response.
5. **Archive** uses the existing `Conversation.archived` field.
   - The change to archived is sent once (like a tombstone). After that the group drops out of the feed.
   - The CLI host and the delivery rules can still read archived groups by id.
   - A new message brings the group back, and that is sent as a change.
6. **Versions never reset.** A recreated part (for example an agent contributed again under the same
   `stableId`) continues from its tombstone's version. A cursor older than the tombstone retention (7 days)
   forces a full reload.
7. **Migration keeps every existing sequence value**; gaps are allowed.
   - Each group's `messageSeq` starts at the tab's final revision.
   - The head's group-number counter starts from the current highest number.
   - Every stored reference stays valid unchanged: `lastMessageSequence`, `recordingProgress`, the progress
     revisions, `checkpoint.sequence` in message sources, and `throughRevision`.
   - Writes to the old routes are frozen for the whole migration. This replaces "message sequence becomes
     per group, preserving order": that still holds for new messages, but old ones keep their numbers.
8. **Swarm "changed" token for clients.**
   - Lists and caches use a per-Swarm `lastChangedAt` (the newest `changedAt` of any part). It is kept on the
     head with a guarded max-update outside the hot path, or computed when read; group 1 picks one and shows
     it doesn't bring the hotspot back.
   - Command replies return the parts they wrote with their versions, in place of `revision`.
   - Operation receipts keep their stored `revision`.
9. **Delivery claim and ack.**
   - A claim touches the receiving agent's part and the sender's membership part (ruling 2) and keeps its
     `deliveryAllowed` and `senderAllowed` checks.
   - Revocation keeps cancelling delivery rows, so a claim and a cancel conflict on the same row.
   - The existing exactly-once and revocation integration tests stay as they are and must pass.
10. **Whole-state passes each serialize on one part.**
    - `syncLeads`: a change to `leadId` writes the Leads group.
    - Numbering (`numberConversations`, `retiredConversationNumber`) uses a head counter.
    - `assignAgentDisplayNames` touches the head, because display names must be unique across agents.
    - Group 1's table names the part for every remaining pass.

## Approval

Approved by the owner (ken15) on 2026-10-26, in project chat: "approve spec, hay plan, implement, e2e (isolate
app, backend, db, redis local tranh dung app live dang chay)". That is: approve the spec, plan, implement, and run
end-to-end tests on an isolated local stack (app, backend, database and Redis all local), never touching the
live app.

Ruling (PM): the migration dry run uses a local database seeded with synthetic Swarms shaped like production
(sizes from the issue: 1.16 MB with 195 groups, 422 KB with 50 groups, plus small ones), not a copy of
production. A production copy needs a separate ok from the owner.

## Constraints all groups share

- **Isolation.** Every end-to-end and integration run uses a local, isolated stack (backend, MongoDB replica
  set, Redis, CLI daemon and app, all on localhost) with its own data directories and ports. Never point at
  harness.autonomous.ai, the production backend or production data, and never use a person's real Harness
  session.

- One integration branch, `feat/swarm-state-parts`, cut from current main. Each group works on its own branch
  and opens a PR into it. One final PR from it to main, merged with `make merge-pr` after review and CI. No
  merge to main and no release without the owner's ok.
- Follow AGENTS.md, CONTRIBUTING.md, docs/validation-and-release.md and docs/naming-system.md (visible copy).
- Keep the existing behavior of every command: `commands.test.ts` and `backend/integration/superTabs*.test.ts`
  keep passing (adapted to the new store, never weakened). Behavior changes are only the ones this spec names.
- Mongo transactions through Prisma as today, with #1722's retry and backoff.
- Run the CLI and Desktop checks for the touched areas locally (AGENTS.md lists them) and record them in the
  PR.

## Left to builders

Internal module layout, names of new Prisma models and fields, exact endpoint paths and payload shapes (once
the design group fixes them), the test structure, and the benchmark tooling.

## Group plan

| # | Group | Depends on | Size | Produces |
|---|---|---|---|---|
| 0 | Measure: load benchmark | none | medium | Benchmark under `backend/integration/bench/`. A synthetic Swarm (about 200 groups, 20 agents posting in different groups, 6 machines observing every 15 s, 5 polling clients) on MongoMemoryReplSet. Reports conflicts and retries per command type, p50/p95 latency, bytes per poll. Baseline numbers on main. |
| 1 | Design doc | none | medium | `docs/design/2026-10-26-swarm-state-parts.md`: the full command and writer table, invariant rules, part schemas, cursor and endpoint contracts, migration plan. Strongest model. |
| 2 | Backend storage and commands | 1 | large | Part models, store, command layer, non-command writers, delivery claims, archive, TTLs. Existing tests adapted and passing. |
| 3 | Backend read API and migration | 1 (contracts); merges after 2 | large | First-load, changes, archived and host endpoints; `UPDATE_REQUIRED` on old routes; the migration with verification and dry-run tooling. |
| 4 | Desktop and web client | 1 (contracts) | large | Flutter `super_tabs` reads by cursor; archived groups on demand in Work details. |
| 5 | CLI | 1 (contracts) | large | Host tick, pools, assignments, Pro cards and `harness super-tab` on the new endpoints; `status` output unchanged. |
| 6 | Integrate, measure, migrate dry run | 2–5 | medium | Benchmark rerun against the branch (goal 1 and goal 3 numbers), full suites, dry run on a copy of production. |
| 7 | Whole-project review | 6 | medium | Independent review of the integrated branch. Strongest model. |

Groups 0 and 1 run now, in parallel. Groups 2–5 start when the design doc is accepted; 4 and 5 work against its
contracts in parallel with 2 and 3. Each group gets an independent Reviewer before its PR merges into the
integration branch.

Rough time (my estimate, not a commitment): groups 0–1 take a few hours; groups 2–5 take about 1–2 days in
parallel; group 6 plus review and the release take about half a day. Launch about 2–3 days from approval.

## My calls, for you to check while reading

1. Parts: head, group, agent, machine, start, project progress (machine observation inside the machine part).
2. No global counter. The cursor is `changedAt` with a 30 s overlap, taken from the server's read start time,
   plus per-part versions. Tombstones are kept 7 days; an older cursor forces a full reload.
3. New messages are numbered per group. Existing messages keep their current numbers.
3b. Every person and agent gets a small part of its own, so that removing someone and that person acting at
    the same time can't both succeed.
4. Archive after done or cancelled plus 24 hours without messages. `releasedHarnesses` capped at 200 per
   machine. Finished starts kept 7 days.
5. No push transport in this project.
6. Old clients get HTTP 426 `UPDATE_REQUIRED`. The old `state` field is kept read-only until you say drop it.
7. Synthetic benchmark as the before and after measure, plus a migration dry run on a copy of production. That
   copy needs your ok and access.

## Addendum, 2026-10-26: private conversations (owner decision)

The owner (ken15) chose in project chat to design private conversations into this project and build their UI
right after it ships ("chon 1 nha"). The product is a private channel for each person with the PM, under the
project: only that person and the project's Lead see it. It is in addition to the shared project chat, which
stays as it is ("mọi người vẫn có thể chat chung trao đổi như hiện tại").

For this project, that means:
- The storage, read API and visibility model support a conversation whose audience is an explicit set of
  people plus the Lead. Others do not see it: not in first load, not in changes, not in message reads, not in
  notifications or mentions, and not in `otherProjectsWork`.
- Changing a conversation's audience is a visibility change (ruling 4). Messages, deliveries and attachments
  in it follow its audience.
- No UI in this project. The channel UI (one channel per person, created on first use) is the next request,
  built on these contracts.
