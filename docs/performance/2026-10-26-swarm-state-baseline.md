# Swarm state baseline on main (#1726)

The "before" numbers for goals 1 and 3 of [Swarm state by parts](../plans/2026-10-26-swarm-state-parts.md): write
conflicts between agents in different work groups, and the cost of a poll. Group 6 reruns the same benchmark, with the
same seed, on the finished branch for the "after" numbers.

## How it was run

- **Command:** `cd backend && npm ci && npm run bench:swarm-state` (defaults; see
  [backend/integration/bench/README.md](../../backend/integration/bench/README.md)). Two runs, one after the other.
- **Code measured:** main at `0d3485bad`. The bench ran from `98209c579` on `bench/swarm-state-baseline`, which was
  `feat/swarm-state-parts` (`20ab1bf3c`, main plus the spec document) plus the bench. `backend/src` and `backend/prisma` are
  identical to main at `0d3485bad` (`git diff --quiet origin/main HEAD -- backend/src backend/prisma`). Both reports say
  the tree was clean. The branch was then rebased onto the spec's private-conversations addendum (`83312cb7d`, docs
  only), so the same bench is now `019ea7a88`: its `backend/` tree is identical to `98209c579`'s. Main has since moved to
  `c84d2bc2e` with no change under `backend/`.
- **Machine:** Apple M1 Max, 10 cores, 64 GB, macOS (Darwin 25.6.0, arm64), Node 24.18.0, MongoDB 7.0.24 as a local
  single-node replica set (mongodb-memory-server, the same set-up as `backend/integration/superTabs.test.ts`). The routes
  run in process through Fastify `inject`, so there is no network in the latencies.
- **Swarm:** seed 1726 (plan fingerprint `9cdb018c69f21746…` in both runs). 200 work groups: 180 done during setup, 20
  active, each with its own worker. One Lead on the owner's machine. 6 contributed machines, each owned by a different
  person. Briefs are 3,000 characters, so the state is about 1 MB, like the 1.16 MB Swarm with 195 groups in the issue.
- **Load (120 s):** each worker posts about every 4 s in its own group (`message.send`, `work.status`, `work.check` in a
  2:1:1 mix). Each worker's terminal records a turn (a prompt and its answer) about every 10 s. The Lead messages a worker
  about every 5 s. Each machine reports every 15 s. Each machine's host goes over its agents' deliveries every 3 s and
  claims and acknowledges what waits. 3 Desktop windows poll the full state every 3 s, and 2 CLI hosts read their roster
  every 1 s.
- **Time:** about 187 s per run end to end: 57 s setup (1,178 calls), 122–124 s load, the rest database start-up and
  shutdown.
- **Raw data:** [run 1](../../backend/integration/bench/results/baseline-main-0d3485bad-run1.json) and
  [run 2](../../backend/integration/bench/results/baseline-main-0d3485bad-run2.json).

## Headline

| Measure | Run 1 | Run 2 |
|---|---|---|
| Agent calls in their own groups (worker posts and terminal turns) | 935 | 936 |
| … needed at least one retry | 782 (84%) | 776 (83%) |
| … failed transaction attempts (write conflicts) | 4,374 | 4,339 |
| … gave up as `SWARM_BUSY` | 363 (39%) | 346 (37%) |
| All writes during the load | 2,174 | 2,200 |
| … failed transaction attempts | 4,933 | 4,906 |
| … `SWARM_BUSY` | 382 (18%) | 372 (17%) |
| Desktop poll, response (mean) | 1,021.8 KB | 1,022.0 KB |
| Host roster tick, response | 4–5 KB | 4–5 KB |
| Host roster tick, read from MongoDB (isolated) | 1,041 KB | 1,041 KB |
| State after the load | 1 document, 1,036.5 KB | 1 document, 1,036.9 KB |

**Goal 1.** Today every worker conflicts with every other worker, although each one writes only in its own group. Five
of six of their calls had to retry, and more than a third ran out of retries. Machine reports and the Lead conflict
the same way. Only reads (`deliveries.list`, the Desktop and host polls) never conflict.

**Goal 3.** A Desktop poll returns the whole Swarm, about 1 MB every 3 s per open window, even when nothing changed. A
host's roster reply is a few KB, but to build it the backend loads the whole Swarm document from MongoDB on every 1 s
tick. That load is only visible in the isolated measure.

## Per operation (run 1)

A failed attempt is one database transaction the store retried: a P2034 write conflict, or a transient error, with
#1722's backoff. `SWARM_BUSY` means a call used all 8 attempts. Latencies include that backoff.

| Operation | Calls | OK | Failed attempts (conflicts) | Calls retried | SWARM_BUSY | Other errors | p50 ms | p95 ms | max ms |
|---|---|---|---|---|---|---|---|---|---|
| deliveries.list | 840 | 840 | 0 | 0 | 0 | 0 | 28.6 | 57.6 | 478.0 |
| delivery.ack | 581 | 581 | 113 | 41 | 0 | 0 | 50.4 | 165.5 | 3210.9 |
| delivery.claim | 584 | 581 | 179 | 81 | 3 | 0 | 51.1 | 275.4 | 4045.2 |
| message.send | 339 | 219 | 1570 | 292 | 120 | 0 | 1161.1 | 3725.2 | 4273.9 |
| native.append | 339 | 176 | 1685 | 272 | 163 | 0 | 1984.3 | 4047.5 | 4636.7 |
| observeMachine | 48 | 40 | 152 | 35 | 8 | 0 | 372.3 | 3033.5 | 3489.8 |
| read.desktop | 120 | 120 | 0 | 0 | 0 | 0 | 33.8 | 63.0 | 87.3 |
| read.host | 240 | 240 | 0 | 0 | 0 | 0 | 49.2 | 108.8 | 187.5 |
| work.check | 128 | 94 | 542 | 108 | 34 | 0 | 831.4 | 3235.0 | 3797.7 |
| work.status | 155 | 101 | 692 | 132 | 54 | 0 | 918.3 | 3698.2 | 4551.8 |

The latency is mostly waiting to retry. A Desktop poll takes about 33 ms (p50), but a write that has to retry takes
seconds. In 120 s, 132–133 terminal answers were not sent because their prompt had ended in `SWARM_BUSY`.
The bench counts them as skipped: the recorder refuses an answer whose prompt was not recorded, and a real host
records a gap at that point.

## Per reader (run 1)

Response bytes during the load, and one isolated poll after it with nothing else running. The isolated poll counts what
MongoDB sent the backend (its `serverStatus` bytes out, minus the status call's own reply). The host roster reply is
built from the whole Swarm document.

| Reader | Polls | p50 ms | p95 ms | Mean KB | p95 KB | Isolated: response KB | Isolated: database KB |
|---|---|---|---|---|---|---|---|
| desktop:bench-0@example.com | 40 | 28.8 | 63.0 | 1021.8 | 1026.9 | 1026.9 | 1037.5 |
| desktop:bench-1@example.com | 40 | 36.4 | 61.0 | 1021.7 | 1026.9 | 1026.9 | 1037.5 |
| desktop:bench-2@example.com | 40 | 35.7 | 61.3 | 1021.9 | 1026.9 | 1026.9 | 1037.5 |
| host:bench-machine-0 | 120 | 45.8 | 108.7 | 5.1 | 5.1 | 5.1 | 1041.0 |
| host:bench-machine-1 | 120 | 51.7 | 108.8 | 4.1 | 4.1 | 4.1 | 1040.5 |

## What group 6 compares

Run `npm run bench:swarm-state -- --driver <parts driver>` with the same defaults on the same kind of machine, and
check that the plan fingerprint matches. These are suggestions, for the Lead and the owner to confirm:

- **Goal 1:** the `worker-*` and `terminal-*` rows show 0 failed attempts and 0 `SWARM_BUSY`, because they write only in
  their own groups. `machine-*` reports do not conflict with them either. The Lead's messages into a worker's group may
  still meet that worker's own writes. That is the same group, which the goal allows.
- **Goal 3:** a Desktop reader's polls during the load cost about what changed in those 3 s, not 1 MB. An isolated
  poll of an up-to-date reader is near zero, both its response and what MongoDB sends for it. The same holds for the
  host tick.
- **Hot Swarm** (`--done-share 0`: all 200 groups active, 200 workers), for the variant the Lead asked for. No baseline
  is recorded here.

## Limits of this measure

- One local mongod on a laptop, without a network, so absolute latencies are not production's. Production's
  conflicts were worse: a 1.16 MB Swarm lost all five retries of a person's `agent.add`. Compare counts and rates
  between runs on the same machine.
- Which calls conflict depends on timing, so retry counts move by a few percent between runs (see the two columns
  above). The planned work is identical (same fingerprint).
- The bench models no `agent.start` dispatch, joins, sharing or Pro cards. It has 5 readers, as the brief names. In
  production every host also ticks every 1 s, and every open Desktop window polls.
- Setup is not measured. It builds the Swarm through 1,178 sequential commands before the load starts.

