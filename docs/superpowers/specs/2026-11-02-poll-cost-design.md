# Backend CPU from polling: fewer and cheaper reads, server, Desktop and CLI

**Status:** draft for review · **Owner:** Ken · **Area:** backend (`superTabs/cache*.ts`, `cachedReads.ts`, `read/*`,
`store.ts`), Desktop (`desktop/lib/super_tabs/controller.dart`), CLI daemon (`cli/src/superTabs/host.ts`, `terminal.ts`,
`cards.ts`, `gateway/productUsage.ts`, `core/experiments.ts`, `machineList.ts`)
**Follows:** [2026-11-02-swarm-cache-delta-design.md](2026-11-02-swarm-cache-delta-design.md) (#2519, released in v1.3.85).
#2394 (measure 1 minute in 10) stays held, as Ken decided.

## Why

Prod on v1.3.85, 2026-11-02 08:30–08:50Z, 4 pods, ~4,180 requests/min.

The delta cache works: verify sample 0 mismatches, `parts` served 84% hit, 13% patched, 3% full. DB bytes per request
fell from 145 to 102 KB. But CPU per request is flat (~32.6 ms), because most of what is left is **polling**: reads repeated
whether or not anything changed for the reader.

| Source | Measured | Cause (traced in code, file:line in the traces below) |
|---|---|---|
| Cache entries still reloaded whole on every bump: `feed`, `host` (almost all of it `host:state:{machineId}`, the light Swarm each machine's host rows are built from; `host:inputs` is a 22-character hash), `light`, `startsOf` | 610 + 273 + 170 + 80 MB per 20 min, against 11 MB for `parts`; `freeze` 6.4% of the JS thread | They have no patch rule (non-goal of the last spec) |
| Desktop's messages reads | person `after` 237/min, ~0 rows each; person bare `before` 234/min, ~131 rows decoded each | Every `after` that comes back empty is followed by a re-read of the 100-row page shown (`controller.dart:3785-3795`). The read is triggered by any change anywhere in the Swarm, including each machine's reading every 15 s, and by `_receiptOpen`, which stays true for `delivered`/`confirmed` until an agent replies with `replyTo` (`controller.dart:524,531-545`): in practice forever |
| Daemon delivery loop | list GET 294/min, claim/ack/hold POST 414/min, receipt GET 318/min (25% of all requests) | A held delivery is re-claimed every second, for up to 24 h (`host.ts:1719` with `:2099-2104`). Receipt checks ask every 5 s with no limit and keep asking after 403/404 (`host.ts:843-873`). Each receipt GET loads a whole Swarm (`store.ts deliveryReceipt`). `busy` is taken before the ack, costing one more list read per message (`host.ts:1082`) |
| Daemon telemetry | settings GET 330/min, report POST 284/min | Every 45–75 s per gateway, though the report already carries the settings revision (`productUsage.ts:299,350,380`) |
| Terminal pickup | `hosts/:m/terminal` 305/min, almost always empty; each a transaction | Every 3 s on daemons hosting Swarm agents (`terminal.ts:22,163-166`) |
| Lists | `super-tabs/list` 279/min, `machines` 227/min, `experimental-settings` 127/min | Pro cards poll `list` every 5 s, ignoring pushes (`cards.ts:269,300,376`); `MachineListCache` has no TTL (`machineList.ts:140`); every desk operation makes every daemon and window re-read experiment settings (`core/experiments.ts:135`, `desk.ts:56`) |

The traces' findings are from code reading. Prod rates fit them (see each part). Part 0 adds the counters that turn the
estimates into measurements.

## Goal

Cut what polls cost the backend, without making anything a person sees wrong or noticeably late:

- **Fewer requests:** about −1,500 requests/min (−35%) at today's load, mostly empty or repeated ones.
- **Cheaper reads:** the four remaining whole reloads become patches, which removes most of `freeze`'s 6.4% and a share of
  Prisma's 21%.
- **Measured success:** CPU per request and per minute in `cpu by kind`, requests per route in `route latency`, and the
  new counters, before and after each release.

### Non-goals

- **#2394, the measurement windows:** held.
- **Pushing deltas over WebSocket instead of "told, then read":** an architecture change for its own spec. This spec only
  removes reads that tell nothing new.
- **The phone:** it already reads messages by its counters. Making it honour `swarm_changed` instead of polling `/changes`
  every 5 s is a later, separate change.
- **Message history retention and compaction:** spec 5.

### Anti-goals

- **No missed messages or answers:** a message, an answer or an agent's work must never show late beyond the bounds stated
  here.
- **No lost deliveries:** a held delivery must still reach its agent when the pane frees, and a receipt must still be acked.
- **No silent staleness:** every new wait has a stated bound, and a fallback read when a push is lost.

## Part 0 — counters first (backend, ships with Part 1)

The counters go into the existing minute logs; they record counts only, never ids or content:

- **`route latency`:** per route, how many replies carried nothing new. That means `GET changes` with no changed parts,
  `GET messages` `after` with no rows, `GET deliveries` with nothing open, and `hosts/:m/terminal` with no request. Also
  bytes out per route.
- **`messages by reader`** (already there): unchanged.
- **New `delivery calls` log:**
  - claims of a delivery already claimed by the same host within 10 s, counted as re-claims;
  - receipt GETs answering 403/404;
  - holds by reason.

## Part 1 — the last four whole reloads become patches (backend)

Builds on `SwarmCache`'s delta (one per Swarm and stamp, `cache.ts deltaFor`). Each entry gets a patch rule, or is derived
from an entry that has one. The equivalence test of #2519 extends to each.

1. **`feed`** (the change feed `GET changes` reads: parts changed after `from`, `cachedReads.ts readChanged`):
   - **Rule:** merge the delta's parts by kind and key, keeping the newer version. The feed keeps tombstones, dormant
     groups and machines' `readAt`, as `loadChanged` returns them, so this rule keeps `readAt`, unlike the base's.
   - `from` stays as loaded. The feed grows until its 10-minute full reload. A busy Swarm changes about 80 parts in 5 min,
     so that is bounded.
   - Kinds: all seven, machines by `readAt` too. The feed is scoped `all`, so a machine reading patches it with machine
     parts only.
2. **`light` and `host:state:{machineId}`** (`readLight`, the light base `GET changes` reads; `read/host.ts tabState`, the
   light Swarm a machine's host rows are built from):
   - **Derived, not loaded:** both are `loadLight` selections, built in memory from entries that are already patched. The
     inputs are:
     - the `parts` entry and `machines`;
     - `dormant:agent:{id}` (Phase 2 of the last spec) for the dormant conversations of a machine's agents;
     - `light-group:{id}` for a named conversation the base lacks.
   - `light` is `groups: 'working'`:
     - Lead conversations;
     - running work;
     - conversations named by an unfinished start or an invitation;
     - undecided work;
     - legacy agents' awake groups.
   - `host:state:{m}` adds that machine's agents' conversations (dormant ones too), its starts' conversations and their
     projects' awake ones (`read/host.ts hostParts`).
   - Conversations are projected through `GROUP_FIELDS` as `lightGroup` does.
   - Each is held per Swarm and stamp, under today's name and scope.
   - The selection and the projection move to one function that `loadLight` also uses, so the loaded and derived forms
     cannot drift.
3. **`host:inputs`** (`read/host.ts inputs`, the signature behind `unchanged` answers to machines). It is a small value, but
   recomputing it reads every live row's stamps from five collections:
   - **Held as a map, not a hash:** the head's `changedAt`, and `key → changedAt` for members, agents and starts. Also
     `key → hostChangedAt` for machines, and `key → hostDigest + dormant` for every live group.
   - **Rule:** patch the map from the delta. The delta's projection adds `hostDigest` and `hostChangedAt`.
   - The hash is computed from the map in key order, exactly as today.
   - **Superseded:** main landed `read/hostInputs.ts` first (`host:groups` patched by `hostGroupsRule`, the same etag
     format). It patches the conversations, the long part, and still reads the other four collections' stamps. This branch
     uses it and drops its own map.
   - Scope `main`: a machine's own reading leaves `hostChangedAt`, so it moves no machine stamp here.
4. **`startsOf:{agents}`** (`read/service.ts pollStarts`):
   - **Rule:** a live start whose agent (`stableId(machineId, harnessId)`) is in the entry's list is added or replaced; a
     tombstone, or a start whose agent left the list, goes.

**Expected:** these four were ~1.1 GB of whole reloads per 20 min. After this change they should be about the size of the
`parts` entry's patches (~10–20 MB per 20 min).

## Part 2 — Desktop reads messages by the open conversation's own counters (Desktop)

1. **Trigger:**
   - The open conversation's messages are read only when its counters moved since what is shown:
     `lastMessageSequence` (or `lastMainSequence`) above the held tail, or `reactionSeq` changed.
   - These come with every `/changes` and `/parts` read (`read/contract.ts:35-38`). Desktop parses `reactionSeq` and
     `messageSeq` into the conversation model.
   - Swarm-wide signals stop triggering a messages read: `read.changed`, `lastChangedAt`, `_toldMachine` and `_toldMain`.
   - **My call: the early read is dropped.** Today a push starts the messages read in parallel with the state read. After
     this change the messages read follows the state read that showed the counter move, so a reply shows one `/changes`
     round trip later (tens of ms). Kept, the early read would fire on every Swarm-wide push and keep most of today's reads.
   - **My call: the trigger is `lastMessageSequence`,** not `lastMainSequence`, because `after` pages also bring thread
     replies and their summaries.
   - **My call: Desktop remembers the counter value it last read,** not only the held tail, so a message hidden from the
     reader costs one empty `after`, not one per poll.
   - First reads, saved views (`_showingSaved`) and `_latestWanted` still read the latest page.
2. **No page re-read after an empty `after`** (`controller.dart:3785-3795`), unless `reactionSeq` moved. A message the reader
   cannot see still moves the sequence; that costs one empty `after`, which is cheap.
3. **Receipts:**
   - `_receiptOpen` uses the phone's set: queued, claimed, uncertain. It is bounded by time: 10 minutes, or 60 for held
     deliveries (`swarm_conversation.dart:1074-1081,1123`).
   - The person's own message is refreshed with `?messageId=`: one row every 30 s, not the 100-row page every 3 s.
   - **Cost, my call:** a "Delivered → Answered" receipt on other rows of the page updates on the next real read rather
     than within 3 s.
4. **Unchanged:** the 3 s poll of `/changes`, the 15 s cadence off screen, and the push gating.

**Expected:** about 234 page re-reads/min and most of the 237 empty `after` reads are removed. That is roughly a third of the
`messages` route, ~11% of the JS thread, and the route's heaviest reads.

## Part 3 — the daemon's delivery loop (CLI, plus one backend change)

1. **A held delivery is retried locally.**
   - When the core refuses a write (dialog, draft, screen unavailable, `team_waiting_*`), the host keeps the claimed message
     in memory and retries the write on its own tick.
   - It re-claims at most every 2 min, well inside the backend's claim quiet time of 10 min (`deliverySettle.ts:13`), and
     sends `hold` once, as today.
   - The core's write lease is renewed locally.
   - Signed file links that expire are re-linked (`relink` exists).
2. **A held agent's list is read every 30 s and on push, not every second.**
   - The backend also pushes `super_tab_deliveries` when a delivery is cancelled or answered while held. Today it pushes
     only on new deliveries, so it must, or a cancel would wait 30 s.
3. **`busy` is computed after the pass**, so an acked message costs no extra list read.
4. **Receipt checks:**
   - An entry the list already shows is not asked about.
   - Each entry backs off: 5 s doubling to 5 min.
   - An entry is retired on a final refusal, or after 25 h:
     - final means the codes `ackRefused` already treats as final, and 404;
     - **my call:** a `HOST_UNAVAILABLE` from a billing lapse is not final, since it ends when billing returns.
   - On the backend, `deliveryReceipt` answers from the delivery row and the machine row. It loads the Swarm (through the
     read cache, not a command transaction) only when the row lacks `machineOwnerId`. It keeps the Swarm-row check (the Swarm
     still exists and is readable).
5. **The pass's write lease** (2.5 s, `host.ts:1716,1777`) is taken per agent right before its write, not once before a pass
   over every agent, so a slow pass no longer turns into refusals and re-claims.

**Expected:**
- claim POSTs: 414 → ~60/min;
- list GETs: 294 → ~120/min;
- receipt GETs: 318 → ~40/min, each also much cheaper.

## Part 4 — the other daemon polls (CLI)

1. **Telemetry:**
   - Settings are read at start, on a local settings change, and hourly.
   - Reports go every 5 minutes from the queue already on disk. The report's `revision` already makes the backend refuse
     counts after an opt-out elsewhere (`CHOICE_CHANGED`).
   - Expected: 330 → ~10/min settings, 284 → ~50/min reports.
2. **Terminal pickup** (my calls, from the builder check):
   - **Backend:** when a terminal request waits for a machine, it pushes a new control frame `__terminal_waiting` on that
     machine's channel. It ships in release step 1. The `__` prefix makes older daemons drop it silently, as they drop
     `__tui_open`.
   - **Daemon:** a daemon that has heard the backend push in the last 5 minutes (the delivery push lease it already keeps)
     picks up on the push and polls every 8 s as a fallback. Without that lease it polls every 3 s, as today.
   - **The backend's pickup deadline stays 10 s for every host,** so a Lead still learns quickly when a machine is gone, and
     old daemons keep working unchanged.
   - Expected: 305 → ~115/min.
3. **Pro cards' `list`:** follow the `swarm_changed` push lease as Desktop does, with a 2 min safety net. Expected: −200/min.
4. **`MachineListCache`** (my call, from the builder check):
   - The 45 s TTL applies only to the fleet's own refresh (`services/fleet.ts`), which moves from every 60 s to every
     5 min plus on `machines_changed`.
   - A window's `/api/machines` (`gateway/accountHttp.ts`) gets no TTL; it only joins a read already in flight. A window
     re-reading after `machines_changed`, or after its own rename, create or delete, still sees the change at once.
   - Expected: about −60/min.
5. **Experiment settings:**
   - Re-read only on `desk_changed` with revision 0, which is what experiment changes publish (`experimentalSettings.ts:31`).
   - Desk operations publish their own revision.
   - Expected: most of 127/min.

## Release order and switches

1. **Backend first: Part 0, Part 1, the backend side of Part 3.4, Part 3.2's push and Part 4.2's `__terminal_waiting`.** Part 1 rides `SWARM_CACHE_DELTA`
   (off: today's reloads). The receipt read and the extra push need no switch; older daemons ignore an extra push.
2. **CLI:** Parts 3 and 4. Each falls back to today's cadence when the backend has not said it pushes (the leases that
   already exist).
3. **Desktop:** Part 2.

Each release is judged against its own counters before the next.

## Design (AGENTS.md checklist)

- **Growth:**
  - `feed` grows until its 10-minute full reload (bounded by a Swarm's changes in 10 min); `light` and `host:inputs` hold
    one value per Swarm and stamp. All of these stay within the LRU's byte budget.
  - The daemon keeps held messages in memory, at most one per delivery, freed on ack, cancel or settle.
  - The receipt journal still retires entries; it now also retires failing ones.
- **Concurrency:**
  - Cache entries follow the delta cache's rules: no locks, one delta per Swarm and stamp.
  - A delivery's claim still guards it on the backend. A local retry never writes twice: the core's write lease and the
    claim id are kept.
- **Read cost:**
  - Part 1: reads only what changed.
  - Part 2: reads messages only when the conversation's counters say so.
  - Part 3: the receipt is read from its row.
  - Part 4: settings and lists are read on change, or on a long timer.
- **Scale:** at 10x daemons or viewers, requests grow with real changes, not with time × clients. First warnings: `route
  latency` nothing-new counts, `delivery calls` re-claims, and `swarm cache` full loads.
- **Compatibility:**
  - Old Desktops and daemons keep working against the new backend.
  - The new clients against an old backend fall back to today's cadence, through the push leases they already read.
  - No API or response shape changes. The only additions are the extra delivery pushes, the `__terminal_waiting` frame
    (dropped by older daemons) and the delta projection's fields.
- **Migration and rollback:**
  - Nothing is stored except daemon journal fields for back-off.
  - Backend: `SWARM_CACHE_DELTA=off`, or the previous release.
  - Clients: the previous release.
- **Audience:**
  - Permissions are applied after the cache, as today (`readerView`).
  - The receipt read keeps its owner, host and billing checks; only the way it finds them changes.
  - The `?messageId=` read is the same route, with the same checks.
- **Identity:** nothing new is keyed by, or sent as, the machine owner's login.
- **Failure:**
  - A lost push costs at most the stated fallback: 30 s for deliveries and terminal pickup, 2 min for cards and lists.
  - A failing receipt check backs off and is retired, and is counted in `delivery calls`.
  - A cache entry that cannot be patched loads in full, as today.
- **Platforms:**
  - Backend on Linux pods.
  - The CLI daemon on macOS, Linux and Windows: the timers are the same code on all three.
  - Desktop on macOS, Windows and Linux, and the web build. The web build shares `SuperTabController`, so Part 2 applies
    to it too.

## Tests

- **Part 0:** each counter, counts only, including the empty-window rule.
- **Part 1:**
  - extend #2519's equivalence test: after each of 60 seeded writes, `feed` equals `loadChanged(from)`, `light` equals
    `loadLight({groups:'working'})`, `host:state:{m}` equals `hostParts` for each machine, `host:inputs` equals today's hash, and `startsOf` equals `loadStartsOfAgents`;
  - a test that `loadLight` and the derived light share one selection and projection.
- **Part 2** (Desktop widget and controller tests):
  - no messages read while the open conversation's counters are unchanged, whatever else in the Swarm or its machines
    changed;
  - one `after` read when `lastMessageSequence` moves;
  - a page re-read only when `reactionSeq` moves;
  - the own-receipt refresh by `?messageId=` stops after its bound.
  - Update `super_tab_reading_test.dart` "each poll reads the state, then the messages" and the paging, reaction and
    saved-view tests that assert `?before=`.
- **Part 3** (CLI, `npm run test:core` scope where the files are core or service, or the host's own specs):
  - a held delivery makes no claim for 2 min and is written once the pane frees;
  - a cancel pushed while held stops the retry;
  - `busy` after the ack causes no extra list read;
  - receipt back-off, retirement on 403/404 and after 25 h;
  - `deliveryReceipt` makes no Swarm load when the row names its owner (backend).
- **Part 4:** each cadence, each push path, each fallback when the push lease lapses, and experiment re-reads only on
  revision 0.
- **End to end:** the CLI's e2e suite for delivery (a held pane, then freed) and for terminal pickup by push.

## Risks

| Risk | Mitigation |
|---|---|
| Desktop misses a message because a counter did not move | A posted message always moves `lastMessageSequence` (store writes it with the message); the 60 s safety net stays |
| A delivery held in memory is lost on a daemon restart | It is still claimed on the backend; after restart the list shows it again and the normal path resumes (as today after a crash) |
| A receipt entry is retired wrongly, so a late ack is lost | Retire only on 403/404 or after 25 h, past the backend's longest hold; count every retirement |
| The derived light base drifts from `loadLight` | One shared selection and projection; equivalence test after every seeded write |
| Telemetry lags or over-collects after an opt-out elsewhere | Bounded to 5 min; the backend's revision check refuses stale counts |
