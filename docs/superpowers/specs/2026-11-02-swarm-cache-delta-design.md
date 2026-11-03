# Backend CPU, November round: a Swarm cache that refreshes by change, cheaper freezes, relay publishes and hot loops

**Status:** draft for review · **Owner:** Ken · **Area:** backend (`superTabs/cache.ts`, `cachedReads.ts`, `parts/load.ts`, `lib/adapterWs.ts`, `lib/redisGuard.ts`,
`superTabs/projects.ts`, `model.ts`, `costs/read.ts`), CLI gateway (`cli/src/gateway/gateway.ts`)
**Builds on:** [docs/design/2026-10-28-swarm-read-cache.md](../../design/2026-10-28-swarm-read-cache.md) (the stamp cache)

## Why

Prod on `v1.3.78_backend` (2026-11-02, 02:27–02:50Z, 4 pods, ~3,480 requests/min):

| | Friday 10-30 (before the CPU series) | Monday 11-02 (after) |
|---|---|---|
| CPU per request | 25 ms | 33 ms |
| DB bytes per request | 51 KB | 148 KB |
| `messages` reads that reload the whole Swarm | 1.6% | 11% |

- **Whole-Swarm loads are 63% of the bytes read from Mongo and 30% of DB time, in 5% of the queries:**

  | Query | Share of bytes |
  |---|---|
  | `SwarmStart {deleted, tabId}` | 27% |
  | `SwarmGroup {deleted, dormant, tabId}` | 25% |
  | progress, machines and agents | 11% |

  Prisma parsing those rows is 19% of the JS thread in the CPU profile. Its engine also runs off the JS thread: about
  37% of each pod's CPU is outside the JS thread.
- **The cause is how the cache refreshes.** Any commit to a Swarm bumps its `main` stamp. Every process then drops
  *all* it holds of that Swarm, and its next read reloads the base:
  - every live start;
  - every non-dormant group;
  - agents, members and progress;
  - often all dormant groups as well.

  Cost per bump is therefore Swarm size × processes. Held entries also expire after 60 s and reload in full.
- **The Swarm keeps growing.** Prod's busiest Swarm `c51479bd`:

  | | 10-30 | 11-02 | Unchanged part |
  |---|---|---|---|
  | Starts | 859 | 1,114 (+30%) | 1,111 finished |
  | Groups | 1,248 | 1,715 (+37%) | 1,544 dormant, 8.9 of 9.6 MB |

  One reload is ~1.4 MB, nearly all of it parts that did not change.
- **Why earlier PRs did not fix it.** They made each *read* cheaper:
  - #2364 shared light base;
  - #2365 copy less;
  - #2383 one index key per collection for `lastChangedAt`;
  - #2378 machine readings move only the machine stamp;
  - #2374 / #2391 messages read less.

  None changed what a *refresh* costs. Data growth and more writes ate the savings, and new routes such as
  `GET /deliveries/:id` (112/min) read the same base.

AGENTS.md's design rule says "read cost: read only what changed". The cache breaks that rule on every bump.

Five parts, one delivery (Ken, 2026-11-02: "one spec for all of it"). Each is measured in the 2026-11-02 profile
(12 CPU profiles of 30 s, 4 pods, 02:27–02:50Z):

| Part | What | Share now |
|---|---|---|
| **Phase 1, delta refresh** | a refresh reads only what changed | whole-Swarm loads: 63% of DB bytes; Prisma 19% of the JS thread |
| **Phase 2, hot and cold** | finished starts and dormant groups held and read apart from the hot base | the rest of what full loads and reads carry |
| **Part 3, `freeze`** | a held value is frozen and sized once, never walked again | `freeze` 4.4% of the JS thread, 12.4 M calls in the 12 profiles |
| **Part 4, relay publishes** | count publishes nobody receives; a daemon stops sending live events nobody is viewing; a cheaper guard around each Redis command | `adapter-ws text` 7% of the JS thread, about a third of it the Redis publish and its guard |
| **Part 5, hot loops** | lookups that scan every conversation for every project or agent become one pass | about 1–2% now, growing with the square of a Swarm's size |

Not in this spec: the measurement's own cost (`async_hooks`, `selfProfile`, `queryStats`, about 17% of the JS thread
inside profile windows). #2394 (measure 1 minute in 10) stays held until a week of full logs from this release, as
Ken decided on 2026-10-31.

## Goal (Phase 1)

A held entry whose Swarm changed is brought up to date by reading **only the parts that changed** since it was loaded.
It is then patched in memory. Cost per bump becomes the size of the change (usually a few KB), not the size of the
Swarm.

- **Measured success:** whole-Swarm load bytes fall by more than 70% (`db by shape`), and DB bytes per request fall
  back toward the Friday level. The new `swarm cache` log shows patches far outnumbering full loads.
- **Same answers:** every response is byte-for-byte what a fresh load would give. A sampled background check proves
  this on prod.

### Non-goals

- Moving finished starts or dormant groups to other collections, or expiring them sooner. Phase 2 changes only what
  the cache holds together.
- Delta for the derived selections: `light:*`, `light-group:*`, `host:inputs`, `feed`. They keep today's drop-and-reload.
  The new log will show whether any of them matters.
- Any change to commands (they load in their own transaction, never from the cache), to stamps or bumps, to client
  APIs or response shapes.

### Anti-goals

- A reader ever sees a part older than it would from a fresh load at the same stamp, or a removed or dormant part where
  a fresh load has none. A wrong answer is worse than a slow one.
- A patch silently drifting from the database with no way to notice it.

## Design (Phase 1)

### What changes

1. **A bump marks entries stale instead of dropping them.**
   - Today `SwarmCache.drop` (from the bus broadcast and from `held` on a stamp mismatch) deletes the entry.
   - Now it is kept and marked stale, still counting against the LRU byte budget.
   - Entries whose name has no patch rule are dropped as today.
2. **A read that meets a stale entry asks for the Swarm's delta, then patches.**
   - **One delta per Swarm per stamp.** It is shared by every entry and every concurrent reader of that Swarm on the
     process (single flight keyed by `tabId` + the stamps the read took). Today's miss path already does this for full
     loads.
   - **The delta query** is `parts/load.ts loadChanged(db, [tabId], since)` with its seven kinds run in parallel.
     Today the loop is sequential. Machines are matched by `changedAt` or `readAt`, as the change feed is.
   - **`since`** = the oldest `readStart` among the Swarm's stale entries − `OVERLAP_MS` (30 s, `read/cursor.ts`: the
     longest transaction plus clock drift between processes). This is the same rule client change cursors rely on.
   - **`readStart`** is the time the read took its stamps, before any query. A full load sets it, and so does a patch.
   - **Head columns.** The head's projection adds `groupCounter`, `visibilityEpoch` and `sequenceBase`, so the base's
     own columns are patched too.
3. **Each patchable entry has a patch rule.** It applies a part only if its `version` is higher than the held one, so
   applying the same change twice, or an older one, does nothing. A changed part:

   | Entry (name in `cachedReads.ts`) | Holds | A changed part is |
   |---|---|---|
   | `parts` (`loadReadBase`) | head, members, agents, non-dormant groups, every live start, progress | replaced by key in its kind's list; removed if `deleted`; for a group, removed if `dormant`, added if it woke; head columns replaced |
   | `machines` | live machine parts | replaced by key (a reading moves `readAt` and the version); removed if `deleted` |
   | `dormant` | every dormant group | added or replaced if `dormant`; removed if it woke or was `deleted` |
   | `group:{id}` | that one group, or none | replaced if it is that key and not `deleted`; emptied if `deleted` |
   | `lastChangedAt` | the newest `changedAt` | `max(held, newest changedAt in the delta)` |

   - **List order is unaffected.** A list's order is the parts' `ordinal`, applied by `reassemble`.
   - **Copy-on-write.** A patched value is a new frozen object. Unchanged parts are shared, since they are already
     frozen. Part 3 makes a patch freeze and size only the new parts.
4. **Full reload still happens** when:
   - nothing is held (a cold read, an LRU eviction);
   - the entry is older than `DELTA_MAX_AGE_MS` (10 min since its last full load), the safety net for anything a delta
     cannot see;
   - the delta changed the head's `visibilityEpoch`;
   - the head is gone (a deleted Swarm, `PARTS_MISSING`, as today);
   - the delta holds more than `DELTA_MAX_PARTS` (500) parts, so a reload costs about the same;
   - the delta read failed.

   **Age expiry changes too.** `CACHE_MAX_AGE_MS` (60 s) now triggers a *delta*, not a reload. The 60-second net for a
   lost bump is kept and becomes cheap: a delta finds every commit since the load whether or not its bump arrived.

### Why a patched entry is right

- A full load at stamp S reads in one snapshot taken after the stamps were read. A patch at S therefore has to match
  what such a load would read.
- **Every commit the held entry misses is in the delta.**
  - Any commit missing from the snapshot behind `readStart` R committed after that snapshot.
  - It stamped each part's `changedAt` (or `readAt`) at write time from its process's clock, which is strictly
    increasing.
  - That time is at least R − (longest transaction 15 s + drift 15 s) = R − `OVERLAP_MS`.
  - So `changedAt > since` finds it. The client change cursor makes the same argument (`read/cursor.ts`).
- **A commit the delta itself misses** (committed after the delta's snapshot) bumps the stamp after it commits.
  The next read sees a newer stamp and patches again. Holding the patched entry at S is exactly as safe as holding a
  full load at S today.
- **What a delta does not carry: touches.** A touch moves a part's version without changing its data or `changedAt`,
  and bumps no stamp. A full load at the same stamp would therefore show the newer version with the *same data*, while
  a patched entry may hold the older version number.
  - Today's cache has this gap already: touches never bump.
  - Versions in a read are only used to keep the higher one (clients) and are never a guard. Commands read their own
    versions in their transactions.
  - The equivalence check below compares data and ignores versions. A test pins that no command guards a write with a
    version from a read.
- **Purges.** A tombstone's data emptied at `purgeAt` (`sweeps.ts`), or removed by the Mongo TTL, is already out of
  every entry, since entries hold no deleted parts. A deleted Swarm loses its head, which forces a full reload, which
  fails as today.

### Checking it on prod

- **Verify sample.** `SWARM_CACHE_VERIFY_RATE`, default `0.01`: one patch in 100 also runs a full load in the
  background, off the request path and capped at one at a time per process. It compares a canonical digest:
  - parts sorted by kind and key;
  - data only, versions left out.

  A mismatch:
  - drops the entry;
  - logs `swarm cache verify mismatch` with the entry name, the kinds and the keys that differ (ids only, never data);
  - counts in the minute log.
- **`swarm cache` log, every minute per process**, in the style of `swarm retries` and `terminal relay`. Per entry
  name it counts:
  - hits;
  - full loads (count and bytes);
  - patches (count, parts applied and bytes read);
  - reloads by reason (cold, age, epoch, too many parts, error);
  - verify samples and mismatches.

  Counts only, no ids. Nothing is logged in an empty window.
- **Kill switch.** `SWARM_CACHE_DELTA=on|off`, default `on`. `off` restores today's drop-and-reload exactly. The verify
  rate is its own variable (`0` turns it off).

### Expected effect (estimate, to be replaced by the log)

| Measure | Now | Expected |
|---|---|---|
| Whole-Swarm load bytes (63% of all DB bytes) | as above | most become deltas of a few KB |
| What remains of them | | cold loads, LRU evictions, 10-minute full reloads, the four non-patched entries |
| DB bytes per request | 148 KB | about half |
| Prisma parse on the JS thread | 19% | under 10% |
| CPU per request | | 10–15% lower |
| `freeze` (4.4% of the JS thread) | | mostly gone |

The HPA should then hold fewer pods at the same traffic. Memory is also a target (70% of 1 GB), and memory falls less
than CPU.

## Phase 2: hot and cold parts

### Why

Phase 1 makes a refresh cheap, but three costs still grow with the Swarm's history. Prod's busiest Swarm, 2026-11-02:

| Part | Count | Size | Read by |
|---|---|---|---|
| Unfinished starts | 2 | ~0 MB | every read |
| Finished starts (expire 7 days after finishing) | 1,118 | 1.37 MB | first loads (`includeRecentStarts`), and reads naming a start or an agent's starts |
| Awake groups | 175 | 0.81 MB | every read |
| Dormant groups | 1,544 | 8.86 MB | reads naming agents or projects, or all groups |
| Agents, members, progress, machines | 77 | 0.22 MB | every read |

1. **The base holds what most reads drop.** `parts` (`loadReadBase`) holds every live start, so finished starts are
   59% of its 2.3 MB.
   - `readParts` then filters them out (`namedStarts`) for every read that names none, which covers messages,
     changes, deliveries and threads.
   - Each full load (cold, eviction, the 10-minute net) still reads, parses, freezes and holds them.
2. **Dormant groups are held whole and filtered per read.**
   - A read naming one agent or one project loads the `dormant` entry, all 1,544 groups (8.9 MB), on each process.
     It then keeps the few it needs.
   - `confidentialSessions` (`store.ts cachedState`) and every command-shaped read with `agentIds` do this.
   - The 13 agents in dormant groups average 126 dormant groups each. The Lead, in nearly all of them, is the outlier.
3. **Memory.**
   - Each process holds the base and the whole dormant set of every busy Swarm it served, within the 64 MB LRU
     budget.
   - Memory is one of the two HPA targets (70% of 1 GB). Large cold entries also push out other Swarms' entries,
     and those then reload.

### Design

1. **Finished starts leave the base.**
   - `loadReadBase` loads `start: { deleted: false, finishedAt: null }`, the same match `loadActive` uses for
     commands.
   - A new entry `finished-starts` holds the live finished starts. It loads only when a read needs it:
     - `includeRecentStarts` (first loads);
     - `startIds` not found among the unfinished;
     - `startAgentIds`.
   - `namedStarts` takes the hot list plus, only in those cases, the cold one. A read naming a start or an agent's
     starts takes them from `finished-starts` by key and by agent (`stableId`, worked out once per entry load and
     kept beside it, not per read). It does not filter the whole list.
   - **Patch rule:** a start part whose data is finished (`startFinished`) moves from `parts` to `finished-starts`. A
     tombstone, or the 7-day expiry write, removes it.
2. **Dormant groups are read by the index the read names.**
   - `readParts` keeps one entry per selection instead of the whole `dormant` set:

     | Entry | Read through |
     |---|---|
     | `dormant:agent:{id}` | the `agents` index, `dormant: true` |
     | `dormant:project:{id}` | the `project` index; for `lead`, also groups with no project |

   - A read naming several agents or projects joins their entries; each is loaded once and shared.
   - **Patch rule:** a group part is in such an entry when it is dormant, not deleted, and lists that agent (or is in
     that project). A group that wakes, leaves, or is deleted is removed.
   - `allGroups` (mentions, route decisions) keeps the whole `dormant` entry, now patched by Phase 1.
3. **Nothing else changes.** Commands keep `loadActive` in their transaction. Responses are unchanged:
   - a read gets exactly the starts and groups `loadActive`'s rules give it;
   - only where the cache holds them changes.

### What it should change (estimate, to be checked with the `swarm cache` log)

| Measure | Now | Expected |
|---|---|---|
| Base full load, busiest Swarm | ~2.3 MB | ~1 MB |
| Per-read start filter | over 1,120 starts | over 2 starts |
| Reads naming an agent's dormant groups (a worker) | 8.9 MB of dormant groups loaded | the agent's own ~0.7 MB, on average |
| Memory held per busy Swarm per process | base + all dormant groups | base + the selections actually read |

The Lead's own selection stays close to the whole set.

### Tests (Phase 2)

- **Equivalence.** The Phase 1 command-sequence test also compares `readParts` for:
  - first loads (`includeRecentStarts`);
  - `startIds` of finished starts;
  - `startAgentIds`;
  - single and several `agentIds` and `projectIds`, including `lead`;
  - `allGroups`.

  Each must equal `loadActive`'s answer in a transaction at the same moment.
- **Moves between entries.** A start that finishes moves from hot to cold. A group put to sleep appears in its agents'
  and project's dormant entries. Woken, it leaves them and returns to the base.
- **Bounds.** A read naming one worker loads only that worker's dormant groups (query shape and bytes asserted on the
  integration Mongo).

## Part 3: `freeze` walks each value once

### Why

`cache.ts freeze` deep-freezes a loaded value and sizes it as JSON in the same pass. It recurses into every object of
every load: 12.4 M calls in the 12 profiles (6 minutes of sampling across 4 pods), 4.4% of the JS thread. It shows inside the messages
and changes routes, `(anonymous) cache.js:89`, the load's `then`.

- Every full load walks the whole Swarm again, though most of its parts are byte-for-byte what the process froze a
  minute earlier.
- Phase 1 cuts the number of full loads. Part 3 makes each freeze walk only what is new, so it holds with the delta
  switch off too.

### Design

1. **Frozen means done.** `freeze(value)` returns at once for an object that is already frozen, using its size
   remembered in a module `WeakMap<object, number>` set when it was frozen. Nothing holds a part alive but its entry,
   so the map frees with the entry.
2. **Size by part, not by walk.**
   - An entry's `bytes` is the sum of its parts' sizes, each sized once when frozen.
   - A patch (Phase 1) subtracts the replaced parts' sizes and adds the new ones'. It never re-walks the list.
3. **Same accounting.** The size is still the JSON estimate `freeze` gives today, so `SWARM_CACHE_MB` means what it
   meant.
4. **A value never frozen twice.** Values reach the cache only through `SwarmCache.load` and the patch. A test asserts
   that a held value's every nested object is frozen, and that a second `freeze` of it visits no child.

### Expected effect

`freeze` drops from 4.4% to a share proportional to new parts (estimate: under 1%), and its call count in the
profile's `calls` from about 12.4 M to about the number of parts loaded or patched.

## Part 4: relay publishes

### Why

`adapter-ws text` is 7% of the JS thread: JSON frames a machine's daemon sends up `/api/adapter-ws`.

| Inside it | Share |
|---|---|
| Parsing and routing the frame (`onMessage`) | ~25% |
| The Redis publish, its `redisGuard` wrapper and the circuit breaker's `run` | ~30% |
| Local delivery (`deliverUpLocal`, `terminalRoute`), moved here from the Redis loopback by #2413 | ~10% |

- **Untargeted frames:** 3,713 published a minute, reaching 4,517 subscriptions in total (`terminal relay`,
  2026-11-02). These are a machine's live events to every app viewing it.
- **#2416 (CLI 0.5.19, on 291 of 326 daemon connects) already cut the rest:**
  - one heartbeat a beat;
  - slim transcript events;
  - terminal-app-only events held while no terminal app is open.

  Its remaining holds (`agent_synced` duplicates, `swarm_changed` spacing) stay on hold for the reasons in
  `docs/plans/2026-10-31-live-events-relay-design.md`.
- **Two costs are left, and their size is unknown:**
  - **Live events for a machine nobody is viewing.** The backend tells each daemon how many UI clients its machine
    has across processes (`__clients` `ui`, `hub.ts recomputeAndSendClients`). The daemon reads only the device
    count from it and broadcasts every live event regardless. The log keeps only totals, so how many publishes reach
    no one is unknown; Desktop dials every machine of its account, so it may be few.
  - **A promise chain and an AbortController per Redis command.** `redisGuard.ts` sends every command through
    `breaker.run`, an `async` function that also builds an `AbortController` even when no timeout is set.

### Design

1. **Count publishes nobody receives.**
   - `relayStats.recordRelay` adds `none` (publishes that reached 0 subscriptions) beside `published` and
     `receivers`, per kind.
   - This is what decides whether item 2 matters. It ships with it, and item 2's effect is read from it.
2. **A daemon stops sending live events nobody can see.**
   - **Backend.** `recomputeAndSendClients` adds `uiGate: true` to `__clients` unless `RELAY_UI_GATE=off`. That is
     the kill switch, default `on`. Older backends never send it.
   - **Daemon** (`gateway.ts`). In `broadcast`, after `productUsage.observe` and before sealing, the untargeted copy
     of a **live event** is not sent while all of these hold:
     - the last `__clients` said `uiGate: true` and `ui: 0`;
     - no frame has come from a remote web connection in the last 60 s.

     The gate is open again as soon as `__clients` says `ui > 0`, or any frame arrives from a remote web connection.
     That first frame is its E2EE hello, sent before it can read anything, so it misses nothing it could have
     decrypted. A link that drops forgets the count, and every event is sent until the next `__clients`. This is the
     rule `tuiUntil` already follows.
   - **What counts as a live event:** `text_delta`, `tool_start`, `tool_end`, `user_message`, `thinking_delta`,
     `thinking_title`, `turn_heartbeat`, `agent_activity`, `turn_ended`, `turn_summary`, `subagent_finished`, `done`,
     `context_compact`.
   - **Never gated:**
     - frames the backend itself reads: `agent_synced` (machine agents), `agent_deleted`, and `turn_started` (daily
       turn counts, the short-turn guard);
     - every reply and targeted frame;
     - guests' sealed copies;
     - device (commander) and user frames.
   - **An app that connects lists the session itself** (`agents_list`, `session_get`), as for #2416's change 3, so a
     gated event leaves nothing missing once someone views the machine.
   - **`ui` must count every app that receives web-eligible frames:** Desktop, web and phone. A test pins that each
     client kind adds to it.
3. **One guard, no extra promise, per Redis command.**
   - While the circuit is closed, `guardRedisCommands` sends the command directly. It records the outcome with one
     `then` on the command's own promise: success resets the failure count, a failure counts toward opening.
   - It goes through `breaker.run` only while the circuit is open or half-open.
   - `createCircuitBreaker.withTimeout` builds no `AbortController` when `timeoutMs` is unset.
   - The breaker's behaviour (threshold 5, open 5 s, one trial) is unchanged and its tests stay as they are.

### Expected effect

- Item 3: roughly a third of the guard's share, about 0.5–1% of the JS thread.
- Item 2: whatever share of publishes `none` shows, times the 7%, plus the daemon's sealing and the Redis traffic.
  Unknown until counted, possibly small.

## Part 5: hot loops

### Why

The profiles' `calls` (V8 precise coverage) show callbacks run millions of times. Each scans every conversation for
every project or agent:

| Callback | Calls in the 12 profiles (6 min of sampling, 4 pods; a profile lists only its top 30) | Scan |
|---|---|---|
| `ledProject` (`projects.ts`): `projectsOf(state).find(p => state.conversations.some(...))` | 13.5 M | projects × conversations, per agent asked |
| `privateMember` (`projects.ts`, behind `confidentialSession`/`isConfidential`) | 1.6 M | conversations × their agents, per agent |
| `awaitingWorkers` (`model.ts`) | 2.6 M | agents × conversations, twice |
| `shipping` (`costs/read.ts`): `rows.filter(...)` per shipped group | 0.3 M or more | groups × cost rows |
| The messages page's join (`store.ts` messages, `deliveries.filter(d => d.messageId === m.id ...)` per message) | 1.4 M (116 k per profile) | page messages × the page's deliveries, on every messages read |

**Where `ledProject`'s calls come from.** Per pod in 30 s that is about 1.55 M callbacks for about 435 requests and
about 40 commands, roughly 3,600 per request. Most come from `markConfidential` (`projects.ts`), which every command
runs after its change (`commands.ts`, beside the commit):

- for each of the Swarm's agents (50 on prod's busiest), it asks `confidentialSession`;
- that is `ledProject` (5 projects × 175 conversations) and `privateMember` (every conversation's `agentIds`);
- about 44,000 comparisons per command, whoever sent it. At about 40 commands per pod per 30 s, that alone accounts
  for the order of the 1.55 M measured. This is inferred from the counts, since the profile does not attribute
  anonymous callbacks to callers.

The read side adds `hostRows` (per agent row: `ledProject`, `isConfidential` twice) and `visibleState`'s
`awaitingWorkers` (for each project, each agent scans the conversations up to three times, on every read).

Each call is cheap, so together they are about 1–2% now. The cost grows with the square of a Swarm's size, and prod's
busiest Swarm grew 30–37% in three days.

### Design

- Each becomes one pass that builds a lookup, then answers from it:

  | Callback | Lookup |
  |---|---|
  | `ledProject` | Lead conversation id → project, and agent → led project |
  | `privateMember` | agents in any conversation with an audience |
  | `awaitingWorkers` | agents leading a conversation, agents with active work, groups by assigned agent |
  | `shipping` | cost rows by conversation, sorted once |
  | `markConfidential` | one pass over the conversations for the set of agents leading a project's Lead conversation and the set of agents in a conversation with an audience; then each agent is two set lookups |
  | the messages page's join | the page's deliveries grouped by `messageId` once, each list kept in its order, then `shownTo` and `receiptOrder` per message as today |

- **Never across a change.** A command changes its state while it runs, so a lookup is built per call, or per
  caller's loop where the caller asks for many agents at once, never kept on the state. Reads, whose state is frozen,
  get the same code.
- **`markConfidential` first.** It is the largest single source, and it runs on every command. It keeps its rule (a
  session is marked once it leads a project or is in a private conversation, and stays marked). Only how it finds
  them changes.
- **Same answers.** Each function keeps its signature and returns what it returns today. Existing tests pin that. New
  tests compare old and new on a generated Swarm of 2,000 conversations, 50 agents and 20 projects.

### Expected effect

These callbacks leave the profile's `calls` top list. About 1–2% of the JS thread now, and it no longer grows with the
square of the Swarm.

## Design (AGENTS.md checklist)

- **Growth (Phase 2):** more, smaller entries. Dormant selections are one per agent or project actually read, within
  the same byte budget and LRU. A Swarm's history now costs memory only for the selections read.
- **Growth:** unchanged. The LRU byte budget (`SWARM_CACHE_MB`, 64 MB per process) holds stale entries too, so nothing
  new grows; over budget, stale entries are evicted before fresh ones. Entries are still dropped at the budget, and also after `DELTA_MAX_AGE_MS` without a full load. The data
  itself is bounded as before: finished starts expire 7 days after finishing, and tombstones 7 days after removal.
- **Concurrency:** no locks.
  - One delta per Swarm and stamp is shared by the readers that need it, as today's loads are.
  - A patch builds a new frozen value and swaps the entry. A reader that took the old value keeps a consistent
    snapshot of it.
  - Commands never read the cache.
- **Read cost (Phase 2):** a read loads and filters only the hot base. Finished starts and dormant groups are read by
  the index a read names, and only by reads that name them.
- **Read cost:** a hit is one Redis `HMGET`, as today. A refresh is seven indexed range reads on `(tabId, changedAt)`
  (and `readAt` for machines), bounded to the last `OVERLAP_MS` + time since the load, instead of the whole Swarm.
- **Scale:** at 10x Swarms, processes or writes, the cost of a bump grows with the change, not the Swarm. Deltas
  per minute still grow with bumps × processes. **First warning:** the `swarm cache` log's patch count and bytes per
  patch, and the share of whole-Swarm shapes in `db by shape`. If deltas grow large, `DELTA_MAX_PARTS` turns them
  into full loads. The log shows it.
- **Compatibility (Part 4):**
  - An older daemon ignores `uiGate` and keeps sending everything.
  - A newer daemon gates only when the backend says `uiGate: true`, so with an older backend, or with
    `RELAY_UI_GATE=off`, it sends everything.
  - Apps are unchanged. One that connects lists what it shows, as it does today after any reconnect.
- **Compatibility:** no response, API or client change, and no new Redis keys. Old and new processes bump the same way
  during a rolling deploy. Old processes keep dropping and reloading, new ones patch, and both stay correct.
- **Migration + rollback:** nothing is stored. Phase 2 changes only the cache's entries, so the previous release
  rolls it back. With `SWARM_CACHE_DELTA=off`, Phase 2's entries drop and reload like any other.
- **Migration + rollback (Phase 1):** nothing is stored. Roll back with `SWARM_CACHE_DELTA=off` (takes effect on restart) or the
  previous release.
- **Audience:** unchanged. The cache holds the stored state, the same for every reader. `readerView` applies
  permissions after the cache, as today. A patch never decides what a reader may see.
- **Identity:** nothing is keyed by or sent as the machine owner's login.
- **Failure:** nothing breaks without saying so.
  - A failed or slow delta read falls back to a full load, and the minute log counts it with its reason.
  - Redis down means reads go to Mongo, as today.
  - A wrong patch is caught by the verify sample, logged as a mismatch and dropped. Each entry is fully reloaded at
    least every 10 minutes.
- **Platforms:** backend (Node, Linux pods) for every part. Part 4's gate is also in the CLI gateway, the same code
  on macOS, Linux and Windows. The terminal app, Desktop, web and phone are unchanged.
- **Migration + rollback (Parts 3–5):** nothing stored.
  - Part 3 and Part 5 roll back with the previous release.
  - Part 4's gate is switched off on the backend (`RELAY_UI_GATE=off`), with no daemon release. Its counter and guard
    roll back with the previous release.
- **Audience (Part 4):** the gate only withholds a machine's live events from its own owner's apps while none is
  connected. It never sends anything to anyone new. Guests' sealed copies are never gated.

## Tests

- **Unit (`cache.test.ts`, `cachedReads.test.ts`)**, each patch rule:
  - insert, update, an older or equal version ignored;
  - a tombstone removes;
  - group dormant ↔ awake moves between `parts` and `dormant`;
  - a finished start stays in `parts`;
  - a machine reading by `readAt`;
  - head columns patched;
  - `visibilityEpoch` change → full reload;
  - over `DELTA_MAX_PARTS` → full reload;
  - delta error → full load;
  - age at 60 s → delta, at 10 min → full load;
  - one delta shared by concurrent readers;
  - `off` switch → today's behaviour.
- **Equivalence (integration, Mongo memory server, alongside `integration/superTabCache.test.ts`).** Run a random
  sequence of real store commands, including:
  - messages, task assignment and finishing;
  - starts that finish;
  - groups put to sleep by the sweep and woken;
  - agent removal;
  - project changes;
  - machine readings.

  After each command, every patched entry must deep-equal a fresh load of the same entry at the same stamp (data
  equal, sorted by kind and key).
- **Overlap.** A write whose `changedAt` is 20 s before the entry's `readStart`, committed after the entry loaded, is
  in the next patch.
- **Versions are never a guard from reads.** A test asserts that every `guardedWrite`'s `seen` comes from a load
  inside its transaction.
- **Verify path.** A planted divergence is detected, logged with ids only, and the entry is dropped.
- **Benchmark on the local copy of prod's busiest Swarm** (`harness_profile`): bytes and ms per bump, before and after,
  for one message send and one task finish.
- **Part 3:**
  - every nested object of a held value is frozen;
  - a second `freeze` of a held value visits no child;
  - entry `bytes` equals today's estimate for the same value, after a full load and after a patch.
- **Part 4:**
  - **Backend:**
    - `none` is counted for publishes with no subscriber;
    - `__clients` carries `uiGate: true`, and none with `RELAY_UI_GATE=off`;
    - `ui` counts a Desktop, a web and a phone client.
  - **Breaker:**
    - closed circuit sends without `run`;
    - five failures open it;
    - open refuses;
    - after 5 s one trial, and success closes it (the existing `circuitBreaker` and `redisGuard` tests unchanged and
      passing).
  - **CLI** (`npm run test:core` scope for the gateway; record it in the PR):
    - a live event is not enqueued when `uiGate` and `ui: 0` and no web frame in 60 s;
    - it is enqueued with `ui > 0`, after a web frame, before any `__clients`, after a link drop, and without
      `uiGate`;
    - `turn_started`, `agent_synced`, `agent_deleted`, replies, targeted, guest, device and user frames are never
      gated.
- **Part 5:** `markConfidential` marks the same agents as today on generated Swarms (Leads, private members, both,
  neither, an agent already marked); the messages page returns the same `deliveries` per message, in the same order,
  for an agent, a person and a Buddy reader. For each function, old and new answers equal on generated Swarms (including no projects, private
  projects, Leads without a conversation, lost assignments), and `calls` for them in a local profile of the
  `harness_profile` Swarm drops to about the number of agents or groups.

## Rollout

1. Release the backend first, with `SWARM_CACHE_DELTA=on`, `SWARM_CACHE_VERIFY_RATE=0.01` and `RELAY_UI_GATE=on`.
   The CLI follows in its next release: its gate does nothing until it hears `uiGate`.
2. In the first hour, read the `swarm cache` log: zero verify mismatches, patches far above full loads. Compare
   `db by shape` (whole-Swarm shapes) and `cpu by kind` against this spec's numbers.
3. After a day with zero mismatches, lower the verify rate to `0.001`. Keep it on: it is the drift alarm.
4. In the `terminal relay` log, read `none` before and after the CLI release. If it was near zero, item 2 bought
   little, and the spec says so in its result.
5. Read the profile's `calls` and functions for `freeze`, `ledProject`, `privateMember`, `awaitingWorkers`,
   `activeWork`, the messages page's join, the cost read and `redisGuard`, against the numbers above.

## Risks

| Risk | Mitigation |
|---|---|
| A patch misses a change and serves stale data | Overlap argument above, equivalence tests, verify sample on prod, full reload every 10 min, kill switch |
| A part kind or field added later without a patch rule | Patch rules live next to `loadReadBase`; the equivalence test runs every command type, so a new kind or field that changes loaded data fails it |
| Deltas get large in bursts (a migration, a mass sweep) | `DELTA_MAX_PARTS` → full load; counted in the log |
| Stale entries hold memory longer | Same LRU byte budget; stale entries are evicted first |
| Phase 2: a read gets fewer starts or dormant groups than `loadActive` would | Selection rules mirror `loadActive`'s matches; the equivalence test compares every named form against `loadActive` in a transaction |
| Phase 2: many small dormant selections churn the LRU | Counted per entry name in the `swarm cache` log; `allGroups` keeps one whole entry |
| Part 4: an app misses live events from the moment it connects | The gate opens on its first frame (the E2EE hello, before it can read anything); it lists the session itself on connect; kill switch on the backend |
| Part 4: `ui` misses a kind of app and its live events stop | Test pins every web-eligible client kind in `ui`; `RELAY_UI_GATE=off` needs no daemon release |
| Part 4: the backend stops counting turns for a machine nobody views | `turn_started`, `agent_synced` and `agent_deleted` are never gated; test |
| Part 5: a lookup kept across a command's change answers wrong | Lookups are built per call or per caller loop, never stored on the state; equivalence tests on generated Swarms |
| A process clock drifts more than 15 s | Same exposure as client change cursors today; the verify sample would show mismatches |
