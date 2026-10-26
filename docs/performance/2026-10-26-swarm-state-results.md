# Swarm state by parts: results on the integration branch (#1726)

The "after" numbers for [Swarm state by parts](../plans/2026-10-26-swarm-state-parts.md), measured on the combined
branch (groups 0–5 merged) and compared with [the baseline on main](2026-10-26-swarm-state-baseline.md). Goals 1 and 3
come from the same benchmark, seeds and lanes. Goal 4 comes from the migration dry run. The suites and an isolated
end-to-end run check that the parts work together.

**Status:** goal 1 is met. Goal 3 is met for what clients receive, but not yet for what the server reads from MongoDB
(below). A fix is in progress in its own group, and this document is updated with a rerun once it merges.

## Code and machine

- **Integration head:** `feat/swarm-state-parts` at `b4b28aec8` (PRs #1731–#1735, #1737, #1739). All runs here are
  from `03180d7a1` on `validate/swarm-state-parts`, with a clean tree. That commit is the head plus one change to the
  benchmark only (below). The CLI and Desktop suites ran at `4eab760ed`, and `b4b28aec8` changes neither of them.
- **Main, for comparison:** the baseline runs at `b71522ab6` (main `0d3485bad`), and the hot variant, new here, at
  `f53d296d8`, whose `backend/src` and `backend/prisma` are identical to main.
- **Units:** KB is 1,024 bytes, as in the baseline.
- **Machine:** the baseline's: Apple M1 Max, 10 cores, 64 GB, macOS (Darwin 25.6.0, arm64), Node 24.18.0, MongoDB
  7.0.24 as a local single-node replica set.

## The benchmark change, and what it changes in the numbers

On the combined branch the old full-state routes answer 426, so the benchmark stopped at setup ("Snapshot failed:
UPDATE_REQUIRED"). The Lead approved fixing it in this group (`03180d7a1`, bench folder only):

- **The new-store driver** (`--driver parts`, now the default) reads the way the merged clients read:
  - setup facts come from a first load, and machine generations from the host form;
  - each Desktop window does one first load, then a change read since its cursor every 3 s; a `reload` answer is
    followed by a first load in the same poll;
  - each host reads its host form every 1 s: in full at start and at least every minute, by change in between, naming
    the etags of the rows it holds.
- **The main driver** (`--driver legacy`) is unchanged. Main's clients really do read the whole state, so main keeps
  those reads.
- **Same seeds, plans and lanes.** The plan fingerprints match the baseline: mixed `8ba3412b11e82391`, cross-group
  `575e841eb53ecf49`, hot `d078610a00b2c6bf`.

Numbers whose meaning changed:

| Measure | On main | On the new store |
|---|---|---|
| Desktop poll | the whole visible state | the first poll is a first load; later polls are change reads, which by design resend every part changed in the last 30 s |
| Host tick | today's roster route | the host form, with etags |
| State size | the one `SuperTab` document | the live parts: 7 collections, without tombstones or dormant groups |
| Isolated poll | one more poll after the load | the same, by a reader already up to date. The Desktop poll still falls inside the 30 s overlap, because the load just ended |

## Goal 1: agents in different groups never conflict

| Measure | Main: lane | New store: lane | Main: mixed 1 / 2 | New store: mixed 1 / 2 | Main: hot | New store: hot |
|---|---|---|---|---|---|---|
| Agent calls (worker posts, terminal turns) | 1,066 | 1,068 | 922 / 934 | 1,068 / 1,068 | 1,054 | 1,068 |
| … needed a retry | 453 (42%) | **0** | 779 / 785 (84%) | 10 / 5 (1% / 0%) | 581 (55%) | 4 (0%) |
| … failed transaction attempts | 1,038 | **0** | 4,576 / 4,338 | 11 / 8 | 1,990 | 5 |
| … `SWARM_BUSY` | 10 | **0** | 401 / 354 | 0 / 0 | 52 | 0 |
| Machine reports: failed attempts / `SWARM_BUSY` | 37 / 0 | **0 / 0** | 163 / 9, 201 / 15 | 0 / 0, 0 / 0 | 148 / 4 | 0 / 0 |
| Lead: failed attempts / `SWARM_BUSY` | — | — | 138 / 12, 122 / 9 | 0 / 0, 0 / 0 | 57 / 0 | 0 / 0 |
| All writes: calls / failed attempts / `SWARM_BUSY` | 1,114 / 1,075 / 10 | 1,116 / 0 / 0 | 2,079 / 5,209 / 426, 2,170 / 4,976 / 381 | 3,994 / 17 / 0, 3,994 / 16 / 0 | 2,998 / 2,308 / 56 | 3,080 / 16 / 0 |

- **Cross-group lane (the goal-1 test):** worker, terminal and machine writes have 0 failed attempts, 0 retries and
  0 `SWARM_BUSY`, against 42% retried on main. Every conflict left on main there was across groups. This is the
  threshold the baseline set, and it is met.
- **Mixed Swarm:** the few conflicts left are within one group: a worker's post with its own terminal turn, or a
  delivery claim with the post that made it. The goal allows those. No call ran out of retries.
- **Hot Swarm:** all 200 groups are active, with the same 20 workers spread over them. 4 calls retried, against 55% on
  main.
- **Why the call counts differ:** more calls ran on the new store, but the planned work is identical. On main, a
  terminal answer whose prompt ran out of retries is never sent (146 and 134 skipped in the mixed runs). Each turn
  that does land also makes a delivery to claim and acknowledge (2,852 delivery calls here, against 1,923 and 2,002).
- **Latency:** write p50 is 35–60 ms on the new store. On main it was 0.7–2.5 s, mostly waiting to retry.

By kind of writer, cross-group lane on the new store:

| Kind | Calls | OK | Failed attempts (conflicts) | Calls retried | SWARM_BUSY | Other errors | p50 ms | p95 ms | max ms |
|---|---|---|---|---|---|---|---|---|---|
| desktop | 120 | 120 | 0 | 0 | 0 | 0 | 42.6 | 58.6 | 82.3 |
| host | 240 | 240 | 0 | 0 | 0 | 0 | 59.0 | 80.1 | 110.9 |
| machine | 48 | 48 | 0 | 0 | 0 | 0 | 34.0 | 39.0 | 40.8 |
| terminal | 472 | 472 | 0 | 0 | 0 | 0 | 43.7 | 61.2 | 72.4 |
| worker | 596 | 596 | 0 | 0 | 0 | 0 | 40.1 | 53.8 | 68.3 |

Mixed Swarm, run 1, on the new store:

| Kind | Calls | OK | Failed attempts (conflicts) | Calls retried | SWARM_BUSY | Other errors | p50 ms | p95 ms | max ms |
|---|---|---|---|---|---|---|---|---|---|
| delivery | 2852 | 2852 | 6 | 3 | 0 | 0 | 40.7 | 80.0 | 744.7 |
| desktop | 120 | 120 | 0 | 0 | 0 | 0 | 59.8 | 101.9 | 189.5 |
| host | 240 | 240 | 0 | 0 | 0 | 0 | 82.3 | 142.7 | 268.6 |
| lead | 26 | 26 | 0 | 0 | 0 | 0 | 51.5 | 91.4 | 232.2 |
| machine | 48 | 48 | 0 | 0 | 0 | 0 | 38.9 | 80.6 | 132.0 |
| terminal | 472 | 472 | 3 | 3 | 0 | 0 | 59.4 | 106.2 | 309.3 |
| worker | 596 | 596 | 8 | 7 | 0 | 0 | 53.0 | 94.8 | 296.6 |

## Goal 3: a poll costs what changed

### What clients receive

| Measure | Main (mixed) | New store (mixed 1 / 2) | Main (hot) | New store (hot) |
|---|---|---|---|---|
| Desktop poll during the load, p50 | 1,021.8 KB | 108.6 KB | 771.7 KB | 362.6 KB |
| Desktop poll during the load, mean (includes the first load) | 1,020.0 KB | 223.1 / 229.7 KB | 769.9 KB | 458.7 KB |
| Host tick during the load, p50 | 4.1 KB | 247 B | 4.1 KB | 247 B |
| Host tick, isolated (up to date) | 4–5 KB | 246–247 B | 4–5 KB | 246–247 B |
| State after the load | 1 document, 1,036.5 KB | 237 parts, 1,154.5 KB | 1 document, 777.0 KB | 237 parts, 894.3 KB |

In the busy Swarm, a Desktop change read carries every part changed in the last 30 s. All 20 active groups change in
that time, so about 109 KB comes back, about a tenth of today's full read. In the hot Swarm more groups change, so it
is a third. On an idle Swarm a change read is small: 2.8 KB on the 200-group Swarm (diagnostic below), 518 B on the
local stack. A host tick is about 247 B, against 4–5 KB, because the server answers "unchanged" to the etags the host
holds.

The stored state is not smaller in this benchmark, because no group goes dormant during a two-minute run (a finished
group goes dormant after a day idle). Goal 2 is shown by the dry run instead: in the 1.16 MB Swarm, 126 of 196 groups
are dormant, and a first load is 316.6 KB.

### What the server reads from MongoDB: not met yet

The isolated poll counts what MongoDB sends the backend for one poll (`serverStatus` bytes out). Mixed run 1:

| Reader | Polls | p50 ms | p95 ms | Mean KB | p95 KB | Isolated: response KB | Isolated: database KB |
|---|---|---|---|---|---|---|---|
| desktop:bench-0@example.com | 40 | 55.9 | 95.0 | 224.1 | 778.6 | 109.8 | 1284.2 |
| desktop:bench-1@example.com | 40 | 67.8 | 101.9 | 226.6 | 788.3 | 109.8 | 1284.2 |
| desktop:bench-2@example.com | 40 | 57.9 | 96.3 | 218.5 | 755.2 | 109.8 | 1284.2 |
| host:bench-machine-0 | 120 | 76.1 | 157.0 | 0.3 | 0.2 | 0.2 | 2325.5 |
| host:bench-machine-1 | 120 | 87.1 | 135.2 | 0.3 | 0.2 | 0.2 | 2320.8 |

On main, the same host tick read 1,041 KB from MongoDB, and a Desktop poll 1,037 KB.

A diagnostic separates idle from active. It used the default 200-group Swarm (1,131.6 KB of parts), one up-to-date
reader of each kind, and no write for 35 s:

| Poll | Sent to the client | Read from MongoDB |
|---|---|---|
| Desktop change read, idle | 2.8 KB | 1,140.7 KB |
| Desktop change read, after one post | 6.9 KB | 1,145.3 KB |
| Host form, idle (nothing on its machine changed) | 132 B | 5.4 KB |
| Host form, after one post in a group with its agent | 247 B | 2,277.2 KB |

So the wire cost meets goal 3, and the database cost does not:
- every Desktop change read loads the whole Swarm;
- a host form woken by any change to its machine's work loads it twice, to answer "unchanged".

In the busy run that happened every second, for every host: about 2,320 KB per tick, against 1,041 KB on main. The Lead ruled
it in scope and blocking for main. The fix (change reads and the host form load only the parts they need, an
unchanged answer loads no part bodies, same wire contract) is in progress in its own group. The benchmark and the
backend suites are rerun on the head that includes it.

## Goal 4: the migration dry run

`scripts/swarm-parts/dry-run.ts`, on its own loopback replica set, ran at `03180d7a1`. It exited 0 in 16.4 s.

| Step | Result | Time |
|---|---|---|
| Seed 13 synthetic production-shaped Swarms | the big one: 1.16 MB, 196 groups, 40,000 messages; medium: 412.2 KB, 51 groups, 8,000 messages; ten small; one from before projects | 2,896 ms |
| Migrate | 13 ok, 0 failed, each read back and verified field by field, message count and order unchanged; big 914 ms, medium 204 ms, the small ones 19–28 ms | 3,513 ms |
| Migrate again | nothing to do | 37 ms |
| Read by parts | the big one: first load 316.6 KB, idle change read 2.6 KB, host form 10.8 KB in full, 108 B idle; old Desktop read 1,130.8 KB | 171 ms |
| Real commands through the store, then poll | 4 commands, 1 part written each; change read after two of them 6.3 KB (1 group); the host running that work 4.5 KB, another host 108 B | 292 ms |
| Roll back | 13 ok: the 2 written since rebuilt from their parts, the other 11 identical to their old state | 187 ms |
| Old read of every Swarm | ok: format 1, revision above every message sequence | 76 ms |

`integration/superTabMigration.test.ts` passes as part of `npm run test:super-tabs` on the same head.

## Isolated end to end

The stack ran on one Mac, all on loopback, with its own data:
- **Database and cache:** a MongoDB 7 replica set and Redis 7 in throwaway containers.
- **Sign-in and backend:** a fake sign-in service with fixed test tokens, and the backend from `03180d7a1` (group 3's
  recipe).
- **CLI daemon:** an isolated daemon from the CLI's end-to-end harness (throwaway home and private tmux), signed in as
  the test owner through a byte-counting proxy. The everyday daemon on port 18473 was never touched.
- **The Swarm:** 34 groups (one of them private to the owner), 2 people, and a Lead and a Builder on the daemon's
  machine.

| Behaviour | Result |
|---|---|
| First load | 26.4 KB: 34 groups, 2 agents, 2 members |
| Change reads | idle 518 B. The first read after a load resends the 30 s before it (26.4 KB), by design |
| A post from a second client appears | in the owner's next change read (919 B, 1 group) and in the messages |
| Private conversation, non-audience member | absent from their first load (33 of 34 groups), change read after a private post (0 groups), one-group read (404) and messages (404) |
| Non-member | 403 |
| Old routes | all five answer 426 `UPDATE_REQUIRED` |
| Host tick, idle, 60 s | 60 reads, 287 B on average: one full read each minute (3.4 KB), every other read empty |
| Host tick, active, 60 s (a Lead post every 5 s to the Builder in its group) | 59 reads, 237 B on average, at most 247 B. None carried rows; every read named the etags it held. A full host form here is 1.9 KB |
| Desktop | `flutter test test/super_tab_local_backend_test.dart` against this backend passed: one first load (27.9 KB), change reads of 646 B and 929 B, the second person's post appears, old route 426. Today's full read of that Swarm is about 24.3 KB |

**Desktop was checked through the real Swarm controller over HTTP, not by running the app.** Desktop sends its calls
through the daemon on port 18473, and on this Mac that is the everyday one, which must not be touched. The controller
is the code Desktop and the web app run, and the widget tests cover the screens on top of it.

Not covered here: `harness super-tab status` from an agent. It needs a live agent session, so the placeholder agents in
this Swarm get `AGENT_UNAVAILABLE`, as designed. Group 5 ran it with live sessions at `3cb3e3350`. The stack was taken
down at the end: processes stopped and containers removed, with no port left open.

## Suites

Backend at `03180d7a1`, CLI and Desktop at `4eab760ed` (`b4b28aec8` touches neither).

| Suite | Command | Result |
|---|---|---|
| Backend typecheck | `npm run typecheck` | 0 errors |
| Backend unit | `npm test` | 2,173 passed, 11 skipped, 1 failed. The failure is `src/lib/teamSession.test.ts` › "cannot share another machine's harness…" (expected 404, got 500), which fails identically on main |
| Backend integration | `npm run test:super-tabs` | 6 files, 254 passed (read and migration suites included) |
| Bench self-tests | `npx vitest run --config integration/bench/vitest.config.ts`; `npx tsc -p integration/bench/tsconfig.json` | 7 files, 42 passed; 0 errors |
| CLI typecheck | `npm run typecheck` | 0 errors |
| CLI Super Tab specs | `npx vitest run src/superTabs` | 34 files, 847 passed |
| CLI `test:super-tabs` | `npm run test:super-tabs` | 176 passed, 100% coverage |
| CLI `test:harnessd` | `npm run test:harnessd` | 358 passed, 1 skipped |
| CLI `test:core` | `npm run test:core` | 3,116 passed. The coverage gate fails with the same 15 misses as on main (transcripts `ingest`, `history`, `attach`, `lastTurn`; services `machineAddonsProcess`, `process`), compared line by line |
| Super Tab end to end | `npx vitest run --config vitest.e2e.config.ts e2e/superTabs.e2e.ts e2e/superTabMachines.e2e.ts e2e/superTabsCollaboration.e2e.ts e2e/superTabRoute.e2e.ts e2e/swarmLegacySkills.e2e.ts e2e/agentClient.e2e.ts` | 12 passed, 9 failed: exactly the 9 group 5 recorded as failing on the base (5 in `agentClient`, 3 in `superTabs`, 1 in `superTabsCollaboration`), compared by name |
| Desktop analyzer | `flutter analyze --no-pub` (Flutter 3.47.2) | 47 issues, the identical list at `d9cf81002`, none in a file #1726 changed |
| Desktop affected suites (VM) | `flutter test --no-pub --timeout 60s --concurrency=6 test/super_tab_*_test.dart test/welcome_closed_super_tabs_test.dart test/devices_harness_test.dart test/swarm_launch_recovery_test.dart test/swarm_projects_test.dart test/swarm_sharing_test.dart test/shared_tab_invites_test.dart` | 770 passed, 2 skipped (one is the opt-in local backend test) |
| Desktop affected suites (Chrome) | `flutter test --no-pub --platform chrome --dart-define=HARNESS_TEST=true` with the 9 reading, saved view, parts, dormant group, paging and update files | 91 passed |

## Limits

- One local mongod on a laptop, without a network. Compare counts, rates and bytes between runs on the same machine,
  not absolute latencies.
- Read latency rose a little: Desktop p50 is 43–68 ms against 19–38 ms on main, and host 55–87 ms against 24–60 ms.
  That is the database reads above, and the fix should bring it down.
- The benchmark keeps every group active for the run (no 24 h dormancy), and models no `agent.start` dispatch, joins,
  sharing or Pro cards.
