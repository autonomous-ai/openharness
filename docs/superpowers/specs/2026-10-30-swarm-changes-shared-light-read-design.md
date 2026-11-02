# Design: a small, shared light read for Desktop/web Swarm `changes` (DB roadmap 2.3)

Date: 2026-10-30. Code read at `origin/main` (2bbcad4c4). Spec 1 of 8 in the CPU-ranked list of unfinished items from
the database roadmap (`.vscode/2026-10-29-database-optimization-roadmap.md`, Phase 2 item 3) and the
[WebSocket roadmap](../../plans/2026-10-28-websocket-optimization-roadmap.md). Each spec is approved before the next
one is written.

## Why

`GET /api/super-tabs/:tabId/changes` is the read every open Desktop window and web tab makes for each Swarm it shows,
now mostly right after a `swarm_changed` push (`lib/swarmClientPushes.ts`, coalesced to one a second). It is the most
expensive unfinished item.

**Prod, 2026-10-30, 3 pods, v1.3.6x, 17 minutes of logs:**
- The route takes about 2.06 s of event-loop time per minute per pod, 20% of all busy time, at about 110 reads per
  minute per pod.
- About 30% of reads (32 a minute per pod) miss the read cache and run a full `loadLight`. Those loads are about
  9.5 MB a minute per pod, 70% of the bytes the route reads:

  | Shape under the route (per pod) | Calls/min | Docs/call | MB/min |
  |---|---|---|---|
  | `SwarmGroup` by `key $in` (light projection) | 52 | 244 | 6.97 |
  | `SwarmProgress.findMany` | 33 | 1 | 1.85 |
  | `SwarmAgent.findMany` | 32 | 11 | 0.42 |
  | `SwarmGroup` running work | 31 | 6 | 0.20 |
  | change feed, machines + groups | 140 | 2–5 | 2.6 |

- **Where backend CPU goes** (the `cpu profile` log, all routes): Prisma decoding results 33%, garbage collection
  about 10%, `structuredClone` 9%, the cache's `freeze` 2.6%. The Swarm logic itself (reassemble, views,
  `changesFor`) is under 3%. **CPU follows the bytes read from Mongo and copied, not the number of readers.** The
  way to cut it is to read fewer bytes.

**Why each miss is so large.** On the busiest Swarm (`c51479bd…`, openharness: 6 members, 126 live and 1,080 dormant
conversations, 396 commands an hour):
1. **Conversations of every live start.** `loadLight` with `recentStartGroups` loads the conversation of every live
   start (`parts/light.ts:129-132`). Finished starts are kept 7 days: 837 live starts, 0 unfinished, in 623
   conversations, most of them dormant. #2247 kept this load for one reason only: an agent stored with no
   `projectId` takes its project from the first conversation it is in (`projects.ts:98-100 agentProjectId`).
   That Swarm has no such agent. All of prod has 6 of 66 live agents, in 6 Swarms, last changed 27–29 Oct.
2. **The progress part.** One `SwarmProgress` document of 81 KB, read on every miss. A `changes` reply sends progress
   only from the change feed (`read/changes.ts`), never from the loaded base.
3. **One entry per reader.** `read/service.ts:120-125` passes `groupIds: mentioned` (every conversation the person
   was tagged in) to `readLight`, whose cache name includes them (`cachedReads.ts:64-65`). Every reader has their own
   entry, so each `main` stamp costs one full load per reader per pod. Reads land on pods at random.

## Goals

- A `changes` miss reads only what the reply needs: no conversations of finished starts, no progress part.
- One light base per Swarm per `main` stamp per pod, shared by every reader.
- The reply of every `changes` call is what the full state gives, for every reader (person, agent via `asAgentId`,
  Buddy): unchanged wherever today's light reply already was.

## Non-goals

- Keeping the base across writes by patching it with the change feed. With the base this small, a reload per write
  is cheap; patching adds risk for little.
- The per-person reads in a poll (`superTabMention` distinct list, `waitingMentions`, `decisionsWaiting`,
  `readMarks`): small indexed reads, per person by nature.
- The change feed's own cost (machine bumps reload it). Measured here, decided later.
- `structuredClone` of whole states (DB 2.6), the `lastChangedAt` aggregates (DB 2.4): specs 2 and 5 of this series.
- Retention of finished starts (DB roadmap Phase 5).
- Any client change.

## Anti-goals

- A reader seeing a conversation, agent, start, read mark or machine record that a first load would not show them,
  or missing one it would. The checks (`read/views.ts readerView`, `read/changes.ts changesFor`, `readableMarks`) keep the
  inputs they need for every reader.
- An agent stored without a `projectId` landing in a different project in a reply than it does today.
- A cache entry whose content depends on who read it.

## Design decided

### 0. The reference answer

*(Author's call after the builder check.)* Today's light reply is not one fixed answer: what it derives (an agent's
project, who awaits a decision) depends on which conversations happened to be loaded, including that reader's
mentions and every start of the last 7 days. The reference for every reply is therefore **the answer the full state
gives**, as commands and `firstLoad` see it: the Swarm's active conversations (`loadActive`). Where today's light reply
differs from that, the new reply follows the full state, and the equality tests compare against a reply built from
the full state, not against today's light reply.

### 1. Legacy agents: load only their own active conversations

- `agentProjectId` keeps its fallback (lowest-ordinal conversation the agent is in, else `'lead'`).
- The light base no longer loads every start's conversation to serve that fallback.
- Prod, 2026-10-30: the 6 live agents stored without a `projectId` are all in Swarms whose head has no `projects`.
  There every conversation has no project, so the answer is always `'lead'` and nothing needs loading. New agents
  without a `projectId` are still created only in such Swarms (`commands.ts:1476-1477`, `1744-1745`).
- So the base adds, through the `agents` index, the **active** conversations of the live agents stored without a
  `projectId`, as commands see them, and exactly as a machine report's load already does (`parts/load.ts
  loadObserved`, `legacy`). With no such agent, as on every Swarm but six today, no query runs.
- *(Author's call.)* No backfill and no change to stored data.

### 2. The light base reads only what a poll needs

- `loadLight`'s `recentStartGroups` option goes, with its `distinct` over every live start. The base holds the Lead
  conversations, running work, conversations of unfinished starts, invitations' conversations, and `undecidedWork`,
  as the `'working'` selection already does.
- The starts a poll adds after the base (`pollStarts`: changed starts from the feed, and finished starts a machine
  record still lists) need their conversations for the visibility checks. Their conversation ids join `unheld`
  (`read/service.ts:137`), which already loads the conversations of changed starts and moved read marks. No other
  reader of `loadLight` used `recentStartGroups`.
- The light base reads no progress parts (`machines: false` already shows the pattern). The change feed still carries
  changed progress parts, and `changesFor` sends them as today. If anything on the `changes` path reads
  `parts.progress` or `state.projects[].progress` from the base, the builder moves it to the feed's part or proves it
  unused; the response equality tests decide.

### 2b. Who awaits a decision: the base's busy rule matches `awaitingWorkers`

- `derived.agents[].workDecision` comes from `model.ts awaitingWorkers`: an agent with no stored decision awaits one
  if an active conversation shows its finished, non-lost work, unless it is a Reviewer, leads a conversation, or is
  the assignee of active work.
- `undecidedWork` (`parts/light.ts:63-71`) counts as busy also every member (`agentIds`) of running work, so it skips
  loading the finished work of an agent that is only a member of running work. Today the start conversations
  happen to cover that case; without them the reply would lose an `'awaiting'`.
- *(Author's call after the builder check.)* `undecidedWork`'s busy rule becomes the same as `awaitingWorkers`'
  (Lead of a conversation, or assignee of active work; Reviewers never wait), so the base holds every active
  conversation `awaitingWorkers` reads. This adds a few active conversations on some Swarms.

### 3. One shared base, named groups held per group

- The poll calls `readLight` with no `groupIds`, so its cache name is the same for every reader.
- *(Author's call after the builder check.)* A person's named conversations are those of their **waiting** tags
  (unresolved, under 30 days: the rows `mentions.ts readable` counts), not every conversation they were ever tagged
  in. Only the waiting count needs them, and `readable` reads any it lacks itself. The all-time `distinct` query at
  `service.ts:120` goes. (Prod: 2–15 tagged conversations per person on the busiest Swarm, so the bulk of today's
  244 docs a call is the start conversations of section 2.)
- A new read in `cachedReads.ts` (working name `readLightGroups(db, view, tabId, ids)`) returns the light groups for
  ids the base lacks (a reader's waiting-tag conversations, and `unheld`):
  - one cache entry per id at the `main` stamp (for example `light-group:<id>`), holding the group or "none" for a
    deleted or unknown id;
  - one query for the misses of a call, through the `key` index with the light projection
    (`parts/light.ts loadLightGroups(tx, tabId, 'key', { key: { $in: ids } })`, which exists), batched as
    `readLastChangedAts` batches its misses.
- `cache.ts` keeps an index of entry names per Swarm, so `drop`, `held` and eviction touch only that Swarm's entries.
  Today `drop` scans every entry of every Swarm on each bump, machine-only bumps included, and per-group entries
  would multiply the entry count.
- The loader the poll gives `load` returns the shared base, plus the named groups it lacks, plus the poll's own
  starts (`withStarts`). Both loads of a poll (`service.ts:132` and `:139`) use it. No per-person `readLight` name
  remains.

### 4. Equal responses

- The composed parts must give, for every reader, the reply the full state gives (section 0). Today's light reply
  already does in the common case; the tests below pin the cases where it did not.
- `undecidedWork` may now hold a few extra active conversations; extra active conversations never change a reply
  built from the full state, which holds them all.
- Group order: `reassemble` sorts by ordinal (`parts/shape.ts`), so composition order does not matter.
- Snapshot: named groups may be read outside the base's read transaction, as `readParts` already reads
  `group:<id>`. A write between the two moves the stamp; the cursor's `T0`, taken before any read, makes the next
  poll see it.

## Left to the builder

- Names, cache entry names, and removing whatever becomes dead (`recentStartGroups`, `readLight`'s per-person options
  if no caller is left, the start `distinct`).
- Whether `undecidedWork` keeps loading members' conversations once its busy rule matches `awaitingWorkers`, as long
  as the replies match the full state.

## Tests

- **Same reply as the full state.** A scene with several readers (owner, a member of a private project, a member
  outside it, an agent via `asAgentId`, a Buddy) and: waiting and resolved tags in active and dormant conversations;
  finished starts in dormant conversations, one changed since the cursor and one listed by a machine record; a moved
  read mark; a progress change; an agent with no stored decision that is a member (not assignee) of running work and
  has finished work in another active conversation; an agent stored without `projectId` in a Swarm with projects and
  in one without. Each reader's `changes` reply under the new code equals the reply built from the full state
  (`readParts`, as `firstLoad` reads it), and equals today's reply wherever today's already did.
- **Small miss.** A Swarm with hundreds of finished starts in dormant conversations: a `changes` miss reads none of
  those conversations and no progress part (count part reads, as `integration/superTabCache.test.ts` does).
- **Shared load.** Three people polling one Swarm at one stamp run `loadLight` once; after a write, once more in total.
- **Named groups.** Two readers mentioned in one dormant conversation read it once per stamp; an unknown id once.
- **Per-Swarm drop.** A bump of one Swarm drops only its entries; byte and entry counts stay right after drops,
  evictions and expiry.
- Existing suites stay green: `read/changes.test.ts`, `read/views.test.ts`, `parts/light.test.ts`,
  `integration/superTabCache.test.ts`, `integration/superTabRead.test.ts`, `integration/superTabHotReads.test.ts`,
  and the `projects` / `commands` unit tests.

## Measuring

Before and after, same weekday hours, from prod logs (`cpu by kind`, `db by shape`, `route latency`, `cpu profile`):
- the route's busy ms per pod per minute (baseline 2.06 s);
- calls, docs and bytes of each shape under the route (baseline table above);
- Prisma's and GC's share in `cpu profile`;
- the read cache's entry count per pod (`SwarmCache.size`).

**Done when:** tests show no reply change and one `loadLight` per Swarm, stamp and pod; and prod shows the
`SwarmGroup key $in` and `SwarmProgress` shapes under the route falling from about 8.8 MB to under 1 MB a minute per
pod. The CPU before/after is reported with it (expected: the route's busy time about halves; an estimate, since the
log does not split a read's time between loading and the rest).

## Design (AGENTS.md rules)

- **Growth:** the LRU (`SWARM_CACHE_MB`, 64 MB, 60 s max age) holds the new per-group entries; every `main` bump drops
  a Swarm's entries. Per-reader light entries go, and the base itself shrinks from hundreds of conversations to
  tens. The per-Swarm name index keeps bumps proportional to one Swarm's entries.
- **Concurrency:** no locks, as the read cache: entries are held under the stamp read before loading; concurrent
  misses of one entry share one load.
- **Read cost:** a hit costs the stamp `HMGET`, as today. A miss costs one small `loadLight` per pod per stamp, plus
  one batched group read for named ids that miss.
- **Scale:** at 10× readers per Swarm the base stays one load per stamp per pod; the per-person indexed reads grow
  linearly and are the first to watch in `db by shape`. At 10× live starts the base no longer grows with them.
  At 10× writes, the reload per write is the limit; the route's `cpu by kind` warns first.
- **Compatibility:** reply shapes are unchanged, so every client is unaffected. Values change only where today's
  light reply disagreed with the full state (section 0), toward what `firstLoad` already sends. During a rolling deploy old pods keep
  their per-person entries under other names; all pods read the same stamps.
- **Migration + rollback:** nothing stored changes. Roll back by deploying the previous release; the read cache can
  be turned off with `SWARM_READ_CACHE=off`.
- **Audience:** permissions stay after the cache; held values are the stored state, the same for every reader. The
  equality tests enforce it per reader kind.
- **Identity:** N/A because nothing here acts as or reads the machine owner's login.
- **Failure:** without stamps every read goes to Mongo, as today. A failed group read fails the poll as a failed
  `loadLight` does today.
- **Platforms:** backend only.
