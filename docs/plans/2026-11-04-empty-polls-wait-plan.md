# Empty polls stop: deliveries and terminal pickups wait for the server's word — plan

> Worked by the project's Engineer way of working: this plan first, then each task test first (failing test committed,
> then the code that passes it), one pull request, one independent review. No Execution Handoff.

**Goal:** Watch Production (#2773, task #2800). Ken's targets of 11-04: Atlas CPU peak hour ≤ 40% (now ~68%), per-minute
p95 ≤ 60% (now 88%). About 13% of requests are empty: `GET deliveries` is 84% empty and the hosts' terminal pickups are
almost all empty. Each of those empty answers costs DB reads. Stop asking on a timer where the server already says when
something waits, and keep a message reaching its reader at least as fast as now.

**Architecture:** The server already pushes, over each machine's daemon socket, when a delivery or a terminal request waits
for one of its agents (`super_tab_deliveries`, `__terminal_waiting`; spec 2026-11-02-poll-cost). The daemon still asks on a
timer as the net for a lost push: every idle agent's list every 30 s, and a terminal pickup every 8 s per machine. This plan
moves that net to the server, where it costs one read for all machines instead of one per agent:

1. The server repeats a push that may have been lost: a pass in the singleton worker every 15 s reads the queued deliveries
   (one indexed read for every Swarm) and tells each machine whose agent has one waiting 10 s or more; a sender waiting on
   a terminal request tells the machine again on each of its rechecks while the request is still pending.
2. The "this server pushes" repeat goes through the machine's Redis channel, as the host-changes repeat does: a lease renewal
   each minute (`__deliveries_lease`, which older daemons drop) and the old word every 4 minutes. The daemon's lease is 2.5
   minutes, so a silent Redis puts it back to reading each second within minutes, and it logs that once.
3. While the server pushes, the daemon reads an idle worker's list only when told (a push, a repeat, a reconnect, a retry
   after a failed read) and picks up terminal requests only when told. The Lead's list keeps its 30 s read: its poll runs the
   project's time checks (liveness.ts). Without the push lease everything stays as today (each second, every 3 s).

**Tech Stack:** backend TypeScript (Fastify, Prisma on MongoDB, ioredis bus), CLI TypeScript daemon (vitest specs).

**Spec:** task #2800's brief; follows docs/superpowers/specs/2026-11-02-poll-cost-design.md (Parts 3 and 4.2).

## Global Constraints

- No env switches; red-first tests where behavior changes; Swarm code stays out of `cli/src/core`.
- A message reaches its reader no slower: a delivered push is read in the same tick as today; a lost push is repeated by the
  server within 25 s (today the daemon's own 30 s read); a lost terminal push is repeated within the sender's 5 s recheck,
  inside the 10 s pickup deadline (today the 8 s poll).
- Old daemons are unchanged: they ignore nothing new and keep their timers. Release order: backend first, then CLI. A new
  daemon against an old backend still reads every list on each 4-minute repeat and on reconnect.

## Design

- **Growth:** nothing stored. The pass reads; terminal requests keep their TTL index (TERMINAL_EXPIRY_MS).
- **Concurrency:** no locks; the pass runs in the singleton worker, one run at a time (`running` flag). Pushes are
  idempotent: a host told twice reads once per tick.
- **Read cost:** one indexed read of queued deliveries `(status, _id)` every 15 s for all Swarms, at most one 500-row page;
  the terminal re-push adds no read (the sender's recheck already reads the row).
- **Scale:** at 10x agents the pass still makes 4 reads a minute; the publishes grow with machines that have queued work.
  The first metric to warn is the rows read per pass in the `[swarm-deliveries] re-announced` log (logged when non-zero)
  nearing the page size of 500: queues of machines that are away grow it while the agents told stay few.
- **Compatibility:** frame shapes unchanged (`super_tab_deliveries` with or without ids, `__terminal_waiting`). The Redis
  repeat message `{ pushes: true }` is new on the server's own channel and only the server reads it.
- **Migration + rollback:** none. Rolling the backend back to before this change brings back its in-process 4-minute word:
  new daemons hold their 2.5-minute lease for part of each 4 minutes and read each second for the rest, and a lost push waits
  for that word (up to 4 minutes) instead of the re-push pass.
- **Audience:** a push names only ids and reaches only the machine's own socket; the host reads through the checked poll.
- **Identity:** unchanged; the pass publishes per machine id from the delivery row.
- **Failure:** Redis away → no minute renewal → the daemon's lease (2.5 minutes) lapses → each-second reads, and the daemon
  logs the lapse once (review of #2977, Important 1: with the old 10-minute lease an idle worker's delivery could wait 10
  minutes). A failed list read is retried after its backoff without waiting for a push. A delivery the host keeps withholding
  stays queued and is told every 15 s, so that agent's list is read every 15 s instead of 30 s.
- **Platforms:** CLI daemon on macOS, Linux and Windows alike; no platform code.

## Review Focus

1. A push lost on the way: a queued delivery and a pending terminal request each reach the machine again without any
   daemon timer (server pass, sender recheck).
2. Paths that leave a delivery open without a push: covered by the pass (queued) or by the daemon's held/busy reads.
3. The Lead's list keeps its 30 s read (time checks), and a failed read retries after its backoff.

## Task 1: the push repeat goes through Redis (backend)

**Files:** `backend/src/lib/swarmDeliveryPushes.ts`, `backend/src/lib/bus.ts` (message type), test
`backend/src/lib/swarmDeliveryPushes.test.ts`.
**Interfaces:** `SwarmDeliveriesMsg` gains `| { pushes: true }`; `relaySwarmDeliveries` unchanged in signature.

- [x] Failing test: after 4 minutes the repeat reaches the socket only through the machine's channel; a channel that
      delivers nothing stops the repeat (and it is logged).
- [x] Code: publish `{ pushes: true }` on the machine's channel every 4 minutes; the subscriber turns it into `tell({})`.

## Task 2: the server repeats pushes for queued deliveries (backend)

**Files:** `backend/src/superTabs/deliveryRepush.ts` (new), `backend/src/worker.ts`, test
`backend/src/superTabs/deliveryRepush.test.ts`.
**Interfaces:** `repushQueuedDeliveries(db, tell, now): Promise<number>`; `startDeliveryRepush(db, tell, everyMs = 15_000)`.

- [x] Failing test: queued deliveries waiting ≥ 10 s are told once per machine and agent; fresh, claimed and other rows are not.
- [x] Code: one `(status, _id)` read of queued rows (500 max), filter by `updatedAt`, tell `deliveriesWaiting` per pair;
      started in the singleton worker next to the settle pass.

## Task 3: a sender's wait repeats the terminal push (backend)

**Files:** `backend/src/superTabs/store.ts` (`terminalResult`), test `backend/integration/superTabs.test.ts`.

- [x] Failing test: a request still pending at the sender's recheck is announced again to its machine; a claimed or
      answered one is not.
- [x] Code: on each recheck of a pending request (not the first read), call `terminalWaiting` for its machine and agent.

## Task 4: an idle worker's list is read only when told (CLI)

**Files:** `cli/src/superTabs/host.ts`, test `cli/src/superTabs/host.spec.ts`.

- [x] Failing test: with the push lease, an idle worker's list is read once over 3 minutes; the Lead's every 30 s; a pushed
      delivery is read and typed in the same tick; a failed read is retried after its backoff.
- [x] Code: `due` keeps the timer only for Lead rows; a list with a pending read retry is due once its backoff ends.

## Task 5: terminal pickups only when told (CLI)

**Files:** `cli/src/superTabs/terminal.ts`, test `cli/src/superTabs/terminal.spec.ts`.

- [x] Failing test: with the push lease, no pickup over a minute unless `__terminal_waiting` arrives, then at once; without
      the lease every 3 s as today.
- [x] Code: drop the 8 s pushed poll.

## Task 6: measure

**Files:** `backend/integration/superTabEmptyPolls.test.ts` (new), `cli/src/superTabs/emptyPolls.spec.ts` (new).

- [x] DB operations per empty worker list read (full and quiet), per empty terminal pickup, and per repush pass, under
      MongoDB's profiler on a seeded Swarm.
- [x] Requests per idle worker, per Lead and per machine per minute over 10 simulated minutes, before (main) and after.
- [x] Before/after table in the pull request.
