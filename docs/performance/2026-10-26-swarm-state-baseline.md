# Swarm state baseline on main (#1726)

The "before" numbers for goals 1 and 3 of [Swarm state by parts](../plans/2026-10-26-swarm-state-parts.md): write
conflicts between agents in different work groups, and the cost of a poll. Group 6 reruns the same benchmark, with the
same seeds and lanes, on the finished branch for the "after" numbers.

## How it was run

- **Commands** (from `backend/`, after `npm ci`; see [the bench README](../../backend/integration/bench/README.md)):
  `npm run bench:swarm-state` twice (the mixed, busy Swarm), then `npm run bench:swarm-state -- --lane cross-group`
  once, one after the other.
- **Code measured:** main at `0d3485bad`. All three runs ran from `b71522ab6` on `bench/swarm-state-baseline`, with a
  clean tree. `backend/src` and `backend/prisma` there are identical to main (`git diff --quiet origin/main HEAD --
  backend/src backend/prisma`), and main has had no change under `backend/` through `c84d2bc2e`. The commits after
  `b71522ab6` on the branch add only this document, the result files and a docs-only merge of `feat/swarm-state-parts`
  (the design document), so the reviewed head's `backend/` tree is identical to `b71522ab6`'s.
- **Machine:** Apple M1 Max, 10 cores, 64 GB, macOS (Darwin 25.6.0, arm64), Node 24.18.0, MongoDB 7.0.24 as a local
  single-node replica set (mongodb-memory-server, the same set-up as `backend/integration/superTabs.test.ts`). The routes
  run in process through Fastify `inject`, so there is no network in the latencies.
- **Swarm:** seed 1726. 200 work groups: 180 done during setup, 20 active, 20 workers, each with one active group. One
  Lead on the owner's machine. 6 contributed machines, each owned by a different person. Briefs are 3,000 characters,
  so the state is about 1 MB, like the 1.16 MB Swarm with 195 groups in the issue. Plan fingerprints: mixed
  `8ba3412b11e82391…` (both runs), cross-group `575e841eb53ecf49…`.
- **Mixed load (120 s), the busy Swarm:** each worker posts about every 4 s in its own group (`message.send`,
  `work.status`, `work.check` in a 2:1:1 mix). Its terminal records a turn (a prompt and its answer) about every 10 s in
  the same group, at the same time. The Lead messages a worker in its group about every 5 s. Each machine reports every
  15 s. Each host passes over its agents' deliveries every 3 s and claims and acknowledges what waits. 3 Desktop windows
  poll the full state every 3 s, and 2 CLI hosts read their roster every 1 s.
- **Cross-group lane (120 s), for goal 1:** the same workers, posts, terminal turns, machine reports and readers. Each
  worker's posts and turns run in one sequence, though, and there are no Lead messages and no delivery passes. So no
  two calls ever write one group at once, and every conflict between agents is between different groups.
- **Time:** 187–194 s per run end to end: 59–60 s setup (1,178 calls), 120–123 s load, the rest database start-up and
  shutdown.
- **Raw data:** [mixed, run 1](../../backend/integration/bench/results/baseline-main-0d3485bad-mixed-1.json),
  [mixed, run 2](../../backend/integration/bench/results/baseline-main-0d3485bad-mixed-2.json),
  [cross-group lane](../../backend/integration/bench/results/baseline-main-0d3485bad-cross-group.json).

## Headline

| Measure | Mixed, run 1 | Mixed, run 2 | Cross-group lane |
|---|---|---|---|
| Agent calls (worker posts and terminal turns) | 922 | 934 | 1,066 |
| … needed at least one retry | 779 (84%) | 785 (84%) | 453 (42%) |
| … failed transaction attempts | 4,576 | 4,338 | 1,038 |
| … gave up as `SWARM_BUSY` | 401 (43%) | 354 (38%) | 10 (1%) |
| Machine reports: calls / failed attempts / `SWARM_BUSY` | 48 / 163 / 9 | 48 / 201 / 15 | 48 / 37 / 0 |
| All writes: calls / failed attempts / `SWARM_BUSY` | 2,079 / 5,209 / 426 (20%) | 2,170 / 4,976 / 381 (18%) | 1,114 / 1,075 / 10 (1%) |
| Desktop poll, response (mean) | 1,020.0 KB | 1,021.6 KB | 1,023.2 KB |
| Host roster tick: response / read from MongoDB (isolated) | 4–5 KB / 1,041 KB | 4–5 KB / 1,041 KB | 4–5 KB / 1,042 KB |
| State after the load | 1 document, 1,036.5 KB | 1 document, 1,036.9 KB | 1 document, 1,037.4 KB |

**Goal 1, from the cross-group lane.** Agents writing only in their own groups, one writer per group, still conflict
with each other today:
- 42% of their calls needed a retry, and 10 ran out of retries.
- Machine reports, which write no group, conflicted with them too: 37 failed attempts in 48 reports.

Every one of these conflicts is across groups, and goal 1 says they must be zero. In the mixed Swarm, where same-group
writes add to them, 84% of agent calls retried and 38%–43% gave up.

**Goal 3.** A Desktop poll returns the whole Swarm, about 1 MB every 3 s per open window, even when nothing changed. A
host's roster reply is a few KB, but to build it the backend loads the whole Swarm document from MongoDB on every 1 s
tick. That load is only visible in the isolated measure.

## Cross-group lane, by kind of writer

A failed attempt is one database transaction the store retried: a P2034 write conflict, or a transient error, with
#1722's backoff. `SWARM_BUSY` means a call used all 8 attempts. Latencies include that backoff.

| Kind | Calls | OK | Failed attempts (conflicts) | Calls retried | SWARM_BUSY | Other errors | p50 ms | p95 ms | max ms |
|---|---|---|---|---|---|---|---|---|---|
| desktop | 120 | 120 | 0 | 0 | 0 | 0 | 26.1 | 39.7 | 70.8 |
| host | 240 | 240 | 0 | 0 | 0 | 0 | 32.8 | 54.6 | 81.0 |
| machine | 48 | 48 | 37 | 20 | 0 | 0 | 66.3 | 371.2 | 958.8 |
| terminal | 470 | 465 | 433 | 168 | 5 | 0 | 77.0 | 1174.3 | 3755.8 |
| worker | 596 | 591 | 605 | 285 | 5 | 0 | 91.3 | 825.5 | 3377.0 |

## Mixed Swarm, run 1

By kind of writer (`delivery` is each host's delivery passes):

| Kind | Calls | OK | Failed attempts (conflicts) | Calls retried | SWARM_BUSY | Other errors | p50 ms | p95 ms | max ms |
|---|---|---|---|---|---|---|---|---|---|
| delivery | 1923 | 1919 | 332 | 135 | 4 | 0 | 45.9 | 186.8 | 3512.3 |
| desktop | 120 | 120 | 0 | 0 | 0 | 0 | 38.1 | 95.9 | 229.1 |
| host | 240 | 240 | 0 | 0 | 0 | 0 | 59.5 | 208.3 | 477.1 |
| lead | 26 | 14 | 138 | 22 | 12 | 0 | 2065.9 | 3467.1 | 3587.9 |
| machine | 48 | 39 | 163 | 37 | 9 | 0 | 476.6 | 4274.5 | 4479.9 |
| terminal | 326 | 147 | 1770 | 268 | 179 | 0 | 2456.9 | 4346.4 | 5719.3 |
| worker | 596 | 374 | 2806 | 511 | 222 | 0 | 1401.5 | 4031.2 | 5485.7 |

By operation:

| Operation | Calls | OK | Failed attempts (conflicts) | Calls retried | SWARM_BUSY | Other errors | p50 ms | p95 ms | max ms |
|---|---|---|---|---|---|---|---|---|---|
| deliveries.list | 840 | 840 | 0 | 0 | 0 | 0 | 32.1 | 98.9 | 502.5 |
| delivery.ack | 540 | 539 | 129 | 55 | 1 | 0 | 54.6 | 223.1 | 3097.0 |
| delivery.claim | 543 | 540 | 203 | 80 | 3 | 0 | 57.6 | 400.0 | 3512.3 |
| message.send | 339 | 192 | 1769 | 304 | 147 | 0 | 1900.9 | 4059.3 | 5485.7 |
| native.append | 326 | 147 | 1770 | 268 | 179 | 0 | 2456.9 | 4346.4 | 5719.3 |
| observeMachine | 48 | 39 | 163 | 37 | 9 | 0 | 476.6 | 4274.5 | 4479.9 |
| read.desktop | 120 | 120 | 0 | 0 | 0 | 0 | 38.1 | 95.9 | 229.1 |
| read.host | 240 | 240 | 0 | 0 | 0 | 0 | 59.5 | 208.3 | 477.1 |
| work.check | 128 | 92 | 516 | 104 | 36 | 0 | 801.4 | 3778.6 | 4303.0 |
| work.status | 155 | 104 | 659 | 125 | 51 | 0 | 736.6 | 3975.9 | 4709.3 |

The latency is mostly waiting to retry. A Desktop poll takes under 40 ms (p50), but a write that has to retry takes
seconds. Terminal answers whose prompt had ended in `SWARM_BUSY` were not sent: 146 and 134 in the
two mixed runs, 2 in the lane. The bench counts them as skipped. The recorder refuses an answer whose prompt
was not recorded, and a real host records a gap at that point.

## Per reader (mixed, run 1)

Response bytes during the load, and one isolated poll after it with nothing else running. The isolated poll counts what
MongoDB sent the backend (its `serverStatus` bytes out, minus the status call's own reply).

| Reader | Polls | p50 ms | p95 ms | Mean KB | p95 KB | Isolated: response KB | Isolated: database KB |
|---|---|---|---|---|---|---|---|
| desktop:bench-0@example.com | 40 | 37.8 | 69.4 | 1020.0 | 1026.8 | 1026.9 | 1037.4 |
| desktop:bench-1@example.com | 40 | 38.0 | 86.9 | 1019.9 | 1026.8 | 1026.9 | 1037.4 |
| desktop:bench-2@example.com | 40 | 39.4 | 95.9 | 1020.1 | 1026.8 | 1026.9 | 1037.4 |
| host:bench-machine-0 | 120 | 56.7 | 183.4 | 5.1 | 5.1 | 5.1 | 1040.9 |
| host:bench-machine-1 | 120 | 61.3 | 208.3 | 4.1 | 4.1 | 4.1 | 1040.4 |

## What group 6 compares

Rerun all three with the parts driver (`--driver <name>`, and `--lane cross-group` for the third) on the same kind of
machine, and check that the plan fingerprints match. These are suggestions, for the Lead and the owner to confirm:

- **Goal 1 (cross-group lane only):** the `worker`, `terminal` and `machine` kinds show 0 failed attempts and 0
  `SWARM_BUSY`. In the mixed Swarm, conflicts within one group (a worker's posts with its own terminal, or the Lead's
  messages into its group) may remain, which the goal allows. No threshold applies there.
- **Goal 3:** a Desktop reader's polls during the load cost about what changed in those 3 s, not 1 MB. An isolated
  poll of an up-to-date reader is near zero, both its response and what MongoDB sends for it. The same holds for the
  host tick.
- **Hot Swarm** (`--done-share 0`: all 200 groups active, the same 20 workers spread over them), for the variant the
  Lead asked for. No baseline is recorded here.

## Limits of this measure

- One local mongod on a laptop, without a network, so absolute latencies are not production's. Production's
  conflicts were worse: a 1.16 MB Swarm lost all five retries of a person's `agent.add`. Compare counts and rates
  between runs on the same machine.
- Which calls conflict depends on timing, so retry counts move by a few percent between runs (see the two mixed
  columns). The planned work is identical (same fingerprint).
- The bench models no `agent.start` dispatch, joins, sharing or Pro cards. It has 5 readers, as the brief names. In
  production every host also ticks every 1 s, and every open Desktop window polls.
- Setup is not measured. It builds the Swarm through 1,178 sequential commands before the load starts.

