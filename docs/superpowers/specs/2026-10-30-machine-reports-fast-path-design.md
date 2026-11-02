# Design: cheap machine reports — a backend fast path and one report call per machine (DB roadmap 2.5)

Date: 2026-10-30. Code read at `origin/main` (e08d53f96). Spec 4 in the CPU-ranked series. It replaces the roadmap's
"project members and agents to the fields they use": those reads are 8% of what a report reads, so projecting them
saves almost nothing.

## Why

`POST /api/super-tabs/:tabId/machines/:machineId` is the machine report. Every CLI daemon sends one per Swarm it
contributes to (`cli/src/superTabs/machines.ts`): a pass every 5 s compares a signature (running and stopped
harnesses, reservations, pending and preparing starts, pause, privacy, local models) and sends when it changed, when a
model is starting, or when 15 s passed (`MACHINE_HEARTBEAT_MS`, so the Desktop can tell a silent machine from a quiet
one). `beat()` resends the last reading while a slow pass runs.

**Prod, 2026-10-30 (60 min of logs, 3 pods; Mongo read-only):**
- 1.36 s of event-loop time per pod-minute, 12% of backend busy time; 136 reports per pod-minute, ~10 ms CPU and
  ~10 queries each in one transaction; p95 85 ms; 7.2 MB read per pod-minute.
- 24 machines report into 84 machine–Swarm pairs. Heartbeats alone are 84 × 4 = 336 a minute of the ~408 observed:
  **about 82% of reports are heartbeats**.
- Two machines contribute to 20 and 21 Swarms each and send ~40% of all reports, the same machine reading 20 times
  every 15 s.
- What a report reads per pod-minute: progress 2.4 MB (spec 2 removes it), every machine part of the Swarm 2.4 MB,
  running and Lead conversations 1.3 MB, agents + members 0.6 MB, access checks (`Machine` ×2, `HarnessSession`,
  `User`, `SuperTab`) ~0.3 MB. Reports do commit: 84 of the 92 live machine parts had a `receivedAt` under 2 minutes
  old (Mongo, 2026-10-30).

A heartbeat whose decisions are the same as last time pays the full price: load the Swarm, freeze, copy, run the
checks, diff everything, and write only the machine's reading.

## Goals

- A heartbeat that changes nothing but the machine's reading costs one read and one write of that machine part, with
  no Swarm load.
- A machine sends one report call per pass for all its Swarms, not one per Swarm.
- Everything a report decides (lost tasks, presence, removals, sweeps, lent hours, suspensions, cleanups) comes out
  as it does today; liveness and the Desktop's offline rule are unchanged.

## Non-goals

- Changing the 15 s heartbeat, or deriving liveness from `adapter-ws` presence. Agents' Down state reads each Swarm's
  `receivedAt`; changing that is a separate design.
- The access checks' own cost beyond doing them once per call.
- Reads other than the report's (`changes`, `messages`): their own specs.

## Anti-goals

- A fast path that skips a decision the full path would have made: a task not lost, a removal not ended, a sweep not
  run, lent hours not counted.
- A machine that loses access to a Swarm still getting its readings accepted.

## Design decided

### 1. When a report may take the fast path

A report is a **reading-only report** when all of these hold:
1. The Swarm's state is what this machine's last full report saw: the Swarm's `main` stamp now equals the `main`
   stamp that full report read **before** it loaded (recorded in step 3). A report's own write that changes anything
   beyond its reading moves `main`, so the next report runs in full once and records the new stamp.
2. The decisions the observation feeds are unchanged against the stored machine part: the same `runningHarnessIds` and
   `stoppedHarnessIds` (as sets), no `stoppedReservations`, the same `preparingStartIds`, the same pool `generation`
   and contributor.
3. The record says no machine of the Swarm had a pending `removal` (`expireRemovals` is time-based).
4. No sweep is due for the Swarm. *(Author's call after the builder check.)* The sweep clock becomes one per Swarm
   across pods (Redis `SET NX PX 30000`), not one per process (`store.ts swept`): today each of 3 pods sweeps each
   Swarm every 30 s, which also forces ~2 full reports per Swarm per pod-minute. One clock means one sweep per Swarm
   per 30 s, as the roadmap's Phase 4 item 5 already asks.
5. `now` is before the record's `nextDeadline`: the earliest time-based judgment the full report saw coming for this
   machine's workers (`liveness.ts lostReason`: lease end, quiet or report-renewal limits), capped at 5 minutes after
   the full report. *(Author's call.)* This replaces a fixed 60 s window, which alone would force one full report in
   four.
6. Stamps are readable (Redis up). Without them every report runs in full, as today.

Time-based losses of this machine's workers are still judged on time: by the deadline in condition 5, and by the
Swarm's sweep every 30 s (`sweepLiveness`), as they are today when a report comes late. Losses a changed reading
causes (a harness stopped) change the running or stopped set, so they run in full at once.

In a Swarm that changes often (the busiest takes a command about every 9 s) condition 1 sends most reports in full;
the fast path pays off in quiet Swarms and for quiet machines, and batching (section 4) still cuts calls and access
checks everywhere. The per-minute fast/full counts say how the split comes out.

Everything else in the observation (`resources`, `quotas`, `harnessProgress`, `harnessTokens`, `privacy`, tools,
local models, `receivedAt`) is the machine's reading (`parts/commit.ts withoutReading`: `observation` and `lent`), and
the full path writes it without touching anything else when the decisions are unchanged. `recordAttempts`, `endRuns`
and `recordEvidence` act only on conversation changes, so a reading-only report leaves them idle.

### 2. What the fast path does

In one transaction on that one part:
- read the machine part by id (`${tabId}:${machineId}`) and check conditions 2 and the pool's contributor/generation
  (`CONTRIBUTION_REVOKED` as today);
- build the new observation exactly as `observeMachine` does for the pool alone (`observedPrivacy`, the running-only
  progress and tokens, quotas filtered by `contributedEngines`, `sessionKind`, `receivedAt`);
- `readingClearsSuspensions(pool, now)` runs too; if it changes the pool beyond its reading, the report runs in full;
- lent hours: `accrueLent` needs the Swarm's conversations, so the full report records `lentCount`: the number of this
  machine's agents `accrueLent` would count **for the next report**, i.e. over the running set just stored and the
  conversations as they stand after its commit (not the count it used for its own accrual, which read the previous
  running set). The fast path adds `elapsed × lentCount` to the current week the way `accrueLent` does (elapsed capped
  at `MACHINE_FRESH_MS`). With the state unchanged (condition 1) and the same running set (condition 2), that is what
  `accrueLent` would add;
- what the full path reads from the Swarm for a reading-only report, all fixed while `main` is unchanged, comes from
  the record: whether the machine is a Team account by its agents (`teamByRecord`, the second `hostFor` check, security
  re-check of #2089), the member ids the `swarm_changed` push with `parts: ['machine']` goes to (`membersToTell`), and
  the start ids `preparingStartIds` may name (the filter on `state.starts`). The `SuperTab` row check (`store.row`:
  the Swarm exists in the caller's environment) stays a read;
- the same `swarm_changed` push to the same members as a reading-only full report sends;
- a version-guarded update of the machine part (`guardedWrite`), which records a `machine`-scope stamp bump as a
  reading-only write does today. A version conflict or any failed condition falls back to the full path.

The access checks (`hostFor`: the machine is the caller's, alive, billing allows the data plane) run on the fast path
as on the full one.

### 3. The full-path record

After every full report commits, the backend records for `(tabId, machineId)`: the `main` stamp read before the load,
`lentCount`, whether any machine of the Swarm had a pending removal, `nextDeadline`, the Team-by-agents answer, the
member ids to push to, the start ids preparing may name, and the time. A process whose stamp bump failed after a
commit (cache.ts `owed`) runs every report of that Swarm in full until the bump is paid. It lives in Redis
(`swarm:machine-full:{tabId}`, one field per machine, expiring 2 minutes after the last write), beside the stamps.
Missing or unreadable means the next report runs in full.

### 4. One report call per machine

- A new route `POST /api/super-tabs/hosts/:machineId/readings` takes `{ readings: [{ tabId, observation }] }` (the same
  observation schema as the per-Swarm route) and answers `{ results: [{ tabId, ok: true } | { tabId, error: { code,
  message, status } }] }`. Each reading goes through the same code as the per-Swarm route (fast path, else full).
  The caller's identity and the machine's ownership and billing are checked once per call; each Swarm's own access
  is still checked per reading.
- Fast-path readings of one call share one read of their machine parts (`_id $in`); full-path ones run one at a time,
  as they would arrive today.
- The CLI's pass collects the readings it would send and sends them in one call (`beat()` too), then runs each Swarm's
  pending starts as today; a Swarm whose reading came back with a lost-access error runs no starts. A per-reading error is
  handled as today's per-Swarm error for that Swarm (`lostAccess` stops that Swarm's starts; a `VALIDATION_ERROR` sends
  that Swarm's reading again alone through the old route, so today's field fallbacks keep working).
- A backend without the route answers 404: the CLI goes back to one call per Swarm and asks again after 10 minutes.
  The per-Swarm route stays for older CLIs.

## Left to the builder

- Code layout: where the fast path lives (a function beside `observeMachine`, shared by both routes).
- The exact Redis shape of the record, and the batch size limit of the new route (at least the 21 Swarms seen today).
- How the CLI pass is reshaped to collect readings before sending, as long as starts are still picked up and the
  signature/heartbeat rules are unchanged.

## Tests

- **Same decisions, fast or full:** for each reason a report must run in full (running set changed, stopped set
  changed, stop proof, preparing changed, generation changed, Swarm changed since the last full report, pending removal,
  sweep due, deadline passed, record missing, Redis down, bump owed, suspension cleared), the report takes the full
  path. For a reading-only heartbeat before any deadline, the stored machine part after the fast path equals what the
  full path would store (run both on copies of one Swarm and compare the machine part, including `lent`), and the
  same push goes to the same members.
- **Deadlines:** a worker whose lease ends between two heartbeats is lost by the first report after the deadline,
  which runs in full.
- **One sweep per Swarm:** two stores sharing one Redis sweep a Swarm once per 30 s between them.
- **Lent hours:** a machine with counted agents gets the same `busyMs` after N fast heartbeats as after N full ones,
  including right after a full report that changed the running set.
- **Team machine:** a fast-path reading from the owner's ordinary sign-in for a machine whose agents run on a Team
  account is refused as the full path refuses it.
- **Revoked contribution:** a fast-path reading of a revoked or regenerated pool answers `CONTRIBUTION_REVOKED`.
- **Cost:** a reading-only heartbeat reads only the machine part among the Swarm's part collections (plus the
  `SuperTab` row), and writes once (`integration/superTabCache.test.ts` `partReads` style); it bumps the `machine` stamp
  only.
- **Batch route:** mixed results (one fast, one full, one revoked) in one call come back per Swarm; identity and
  ownership are checked once; a 21-Swarm call works.
- **CLI:** one call per pass for several Swarms; `beat()` batches; 404 falls back to per-Swarm calls and retries after
  10 minutes; a `VALIDATION_ERROR` for one Swarm resends it alone; a lost-access error for one Swarm stops only its
  starts. Run `npm run test:core` if the change touches `src/core` or `src/services`.

## Measuring

Before and after, same weekday hours, prod logs:
- calls per pod-minute to the per-Swarm route and to the new one (today 136 per pod-minute per-Swarm);
- busy ms per pod-minute of both routes together (today 1.36 s);
- queries and MB under them in `db by shape` (today ~10 queries a report, 7.2 MB per pod-minute);
- with #2368's `callers`/`inclusive`, `observeMachine` and its loads in `cpu profile`.

**Done when** the tests pass, the fast/full counts are logged per minute, and prod shows the report routes' busy time
and queries falling, reported before and after (expected: about 2× once most daemons run the new CLI; ~24 calls
instead of ~84 every 15 s; the fast share is highest in quiet Swarms and lowest in the busiest). The number is
reported, not a merge gate.

## Design (AGENTS.md rules)

- **Growth:** the Redis record expires 2 minutes after its last write; nothing new in Mongo.
- **Concurrency:** the fast path writes one machine part with its version guard, as the full path does; a conflict
  falls back to the full path. Two pods may both run a full report for one Swarm, as today.
- **Read cost:** a reading-only heartbeat reads one part; a batch reads all its fast-path parts in one query.
- **Scale:** at 10× machines or Swarms per machine, calls grow with machines, not pairs, and most readings cost one
  part. The first warning is the full-path share (log it per minute: fast vs full readings) and Redis calls.
- **Compatibility:** old CLIs keep the per-Swarm route, which gains the fast path too. A new CLI on an old backend
  falls back on 404. Replies of the per-Swarm route are unchanged.
- **Migration + rollback:** nothing stored in Mongo changes shape (`lent` is written as today). Roll back the backend
  and new CLIs fall back on 404; roll back the CLI and the per-Swarm route still has the fast path.
- **Audience:** the machine's owner only, checked per call; each Swarm's contribution checked per reading.
- **Identity:** the caller's own session, as today; never the machine owner's login on someone else's behalf.
- **Failure:** any failed condition, conflict or missing record runs the full path; a batch reading's error is
  answered for that Swarm, never dropped. The per-minute fast/full counts say when the fast path stops working.
- **Platforms:** backend; CLI on macOS, Linux and Windows (no platform-specific code).
