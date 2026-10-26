# Swarm state by parts: results on the integration branch (#1726)

The "after" numbers for [Swarm state by parts](../plans/2026-10-26-swarm-state-parts.md), measured on the combined
branch and compared with [the baseline on main](2026-10-26-swarm-state-baseline.md):
- **Goals 1 and 3:** the same benchmark, seeds and lanes as the baseline.
- **Goal 4:** the migration dry run.
- **Working together:** the suites and an isolated end-to-end run check that the parts work together.

**Status:** goals 1, 3 and 4 are met on `44d51aae8`. The migration dry run also ran on `63a497c0e`, the base that
ships: rollback there refuses, by design, the Swarms the previous release would misread.

A first run on `b4b28aec8` found that goal 3 held for what clients receive, but not for what the server reads from
MongoDB. That was fixed in its own group (#1745). Its before and after numbers are kept below.

## Code and machine

- **Integration head:** `feat/swarm-state-parts` at `44d51aae8`. It holds groups 0–5 (PRs #1731–#1735, #1737), the
  host-row clean-up (#1739), tonight's v1 work (liveness and takeover #1742 and #1744, routing readiness #1743) and the
  database-read fix (#1745).
- **What ran:** unless a section names another commit, the runs are from `4b8b5ea8a` on `validate/swarm-state-parts`,
  with a clean tree. That commit is the head plus this document. Other commits, where they apply:
  - the "before #1745" figures are from `b4b28aec8` (`03180d7a1` for the end-to-end run);
  - the Desktop suites, and the end-to-end reference file as checked in, ran on `1d79b4e57`. That commit adds #1746
    (Desktop's private chat with the PM), which changes only `desktop/` and `docs/`;
  - the first dry run in Goal 4 ran on `63a497c0e`, the base that ships, with the rollback guards of #1748–#1750.
- **Main, for comparison:**
  - the baseline runs at `b71522ab6` (main `0d3485bad`);
  - the hot variant, new here, at `f53d296d8`, whose `backend/src` and `backend/prisma` are identical to main.
- **Machine:** the baseline's: Apple M1 Max, 10 cores, 64 GB, macOS (Darwin 25.6.0, arm64), Node 24.18.0, MongoDB
  7.0.24 as a local single-node replica set.
- **Units:** KB is 1,024 bytes, as in the baseline.

## The benchmark change, and what it changes in the numbers

On the integration branch the old full-state routes answer 426, so the benchmark stopped at setup ("Snapshot failed:
UPDATE_REQUIRED"). The Lead approved fixing it here. The change is in the head as `ae2348366`, and touches the bench
folder only:

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
| … needed a retry | 453 (42%) | **0** | 779 / 785 (84%) | 8 / 9 (1%) | 581 (55%) | 5 (0%) |
| … failed transaction attempts | 1,038 | **0** | 4,576 / 4,338 | 10 / 10 | 1,990 | 6 |
| … `SWARM_BUSY` | 10 | **0** | 401 / 354 | 0 / 0 | 52 | 0 |
| Machine reports: failed attempts / `SWARM_BUSY` | 37 / 0 | **0 / 0** | 163 / 9, 201 / 15 | 0 / 0, 0 / 0 | 148 / 4 | 0 / 0 |
| Lead: failed attempts / `SWARM_BUSY` | — | — | 138 / 12, 122 / 9 | 0 / 0, 0 / 0 | 57 / 0 | 0 / 0 |
| All writes: calls / failed attempts / `SWARM_BUSY` | 1,114 / 1,075 / 10 | 1,116 / 0 / 0 | 2,079 / 5,209 / 426, 2,170 / 4,976 / 381 | 3,994 / 22 / 0, 3,994 / 20 / 0 | 2,998 / 2,308 / 56 | 3,078 / 20 / 0 |

- **Cross-group lane (the goal-1 test):** worker, terminal and machine writes have 0 failed attempts, 0 retries and
  0 `SWARM_BUSY`, against 42% retried on main. Every conflict left on main there was across groups. This is the
  threshold the baseline set, and it is met.
- **Mixed Swarm:** the few conflicts left are within one group: a worker's post with its own terminal turn, or a
  delivery claim with the post that made it. The goal allows those. No call ran out of retries.
- **Hot Swarm:** all 200 groups are active, with the same 20 workers spread over them. 5 calls retried, against 55% on
  main.
- **Why the call counts differ:** more calls ran on the new store, but the planned work is identical. On main, a
  terminal answer whose prompt ran out of retries is never sent (146 and 134 skipped in the mixed runs). Each turn
  that does land also makes a delivery to claim and acknowledge (2,852 delivery calls here, against 1,923 and 2,002).
- **Latency:** write p50 is 30–57 ms on the new store. On main it was 0.7–2.5 s, mostly waiting to retry.

By kind of writer, cross-group lane on the new store:

| Kind | Calls | OK | Failed attempts (conflicts) | Calls retried | SWARM_BUSY | Other errors | p50 ms | p95 ms | max ms |
|---|---|---|---|---|---|---|---|---|---|
| desktop | 120 | 120 | 0 | 0 | 0 | 0 | 31.5 | 52.8 | 109.3 |
| host | 240 | 240 | 0 | 0 | 0 | 0 | 37.3 | 63.8 | 112.8 |
| machine | 48 | 48 | 0 | 0 | 0 | 0 | 36.2 | 48.7 | 84.9 |
| terminal | 472 | 472 | 0 | 0 | 0 | 0 | 46.1 | 68.3 | 88.1 |
| worker | 596 | 596 | 0 | 0 | 0 | 0 | 44.2 | 65.4 | 143.6 |

Mixed Swarm, run 1, on the new store:

| Kind | Calls | OK | Failed attempts (conflicts) | Calls retried | SWARM_BUSY | Other errors | p50 ms | p95 ms | max ms |
|---|---|---|---|---|---|---|---|---|---|
| delivery | 2852 | 2852 | 12 | 6 | 0 | 0 | 40.3 | 71.0 | 411.4 |
| desktop | 120 | 120 | 0 | 0 | 0 | 0 | 43.5 | 81.0 | 103.6 |
| host | 240 | 240 | 0 | 0 | 0 | 0 | 49.8 | 91.2 | 114.3 |
| lead | 26 | 26 | 0 | 0 | 0 | 0 | 49.0 | 80.6 | 119.6 |
| machine | 48 | 48 | 0 | 0 | 0 | 0 | 40.0 | 53.7 | 94.0 |
| terminal | 472 | 472 | 2 | 2 | 0 | 0 | 57.4 | 91.5 | 171.5 |
| worker | 596 | 596 | 8 | 6 | 0 | 0 | 49.9 | 85.5 | 237.5 |

## Goal 3: a poll costs what changed

### What clients receive

| Measure | Main (mixed) | New store (mixed 1 / 2) | Main (hot) | New store (hot) |
|---|---|---|---|---|
| Desktop poll during the load, p50 | 1,021.8 KB | 109.7 KB | 771.7 KB | 363.6 KB |
| Desktop poll during the load, mean (includes the first load) | 1,020.0 KB | 233.5 / 236.7 KB | 769.9 KB | 456.7 KB |
| Host tick during the load, p50 | 4.1 KB | 269 B | 4.1 KB | 269 B |
| Host tick, isolated (up to date) | 4–5 KB | 268–269 B | 4–5 KB | 268 B |
| State after the load | 1 document, 1,036.5 KB | 237 parts, 1,170.0 KB | 1 document, 777.0 KB | 237 parts, 902.8 KB |

- **Desktop:** in the busy Swarm, a change read carries every part changed in the last 30 s. All 20 active groups
  change in that time, so about 110 KB comes back, about a tenth of today's full read. In the hot Swarm more groups
  change, so it is about half. On an idle Swarm a change read is small: 2.8 KB on the 200-group Swarm (below), 518 B
  on the local stack.
- **Host:** a tick is about 269 B, against 4–5 KB, because the server answers "unchanged" to the etags the host holds.
- **Stored state:** not smaller in this benchmark, because no group goes dormant during a two-minute run (a finished
  group goes dormant after a day idle). Goal 2 is shown by the dry run instead: in the 1.16 MB Swarm, 126 of 196
  groups are dormant, and a first load is 316.6 KB.

### What the server reads from MongoDB

The isolated poll counts what MongoDB sends the backend for one poll (`serverStatus` bytes out). It runs right after
the load, by a reader already up to date. Mixed run 1:

| Reader | Polls | p50 ms | p95 ms | Mean KB | p95 KB | Isolated: response KB | Isolated: database KB |
|---|---|---|---|---|---|---|---|
| desktop:bench-0@example.com | 40 | 39.0 | 80.0 | 234.4 | 843.7 | 110.8 | 181.2 |
| desktop:bench-1@example.com | 40 | 54.4 | 81.9 | 237.6 | 858.8 | 110.8 | 181.2 |
| desktop:bench-2@example.com | 40 | 38.4 | 60.0 | 228.6 | 820.1 | 110.8 | 181.2 |
| host:bench-machine-0 | 120 | 50.9 | 82.9 | 0.3 | 0.3 | 0.3 | 138.0 |
| host:bench-machine-1 | 120 | 49.2 | 98.6 | 0.3 | 0.3 | 0.3 | 83.7 |

| Isolated poll, database KB | Main | Before #1745 (`b4b28aec8`) | Now |
|---|---|---|---|
| Desktop, mixed | 1,037.4 | 1,284.2 | 181.2 |
| Host, mixed | 1,040.4–1,040.9 | 2,320.8–2,325.5 | 83.7–138.0 |
| Desktop, hot | 774.6–778.0 | 1,279.4–1,291.9 | 438.9–451.5 |
| Host, hot | 781.0–781.5 | 1,801.0–1,804.5 | 81.8–128.3 |

A diagnostic separates idle from active: `backend/integration/bench/pollDatabaseBytes.ts`. It used the default
200-group Swarm (1,147.1 KB of parts), one up-to-date reader of each kind (Desktop as the owner, the host of machine 1),
and no write for 35 s. Run it from `backend/` (about 1.5 minutes, on its own loopback replica set). It prints one JSON
line per poll:

```bash
NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  DATABASE_URL=mongodb://127.0.0.1:1/bench-never-used npx tsx integration/bench/pollDatabaseBytes.ts
```

The "before #1745" column is the same measurement at `b4b28aec8`.

| Poll | Sent to the client | Read from MongoDB, before #1745 | Read from MongoDB, now |
|---|---|---|---|
| Desktop change read, idle | 2.8 KB | 1,140.7 KB | 44.4 KB |
| Desktop change read, after one post | 6.9 KB | 1,145.3 KB | 49.1 KB |
| Host form, idle (nothing on its machine changed) | 132 B | 5.4 KB | 5.4 KB |
| Host form, after one post in a group with its agent | 269 B | 2,277.2 KB | 15.5 KB |
| Host form, in full | 5.7 KB | 2,275.0 KB | 69.1 KB |

Before #1745, every Desktop change read loaded the whole Swarm. A host form woken by any change to its machine's work
loaded it twice, just to answer "unchanged": 2.3 MB per tick per host in the busy run, against 1.04 MB on main. Now a
change read loads the parts that changed plus what the reader's view needs. A woken host form loads only the
conversations its rows read.

In the busy run that means:
- a host tick reads 84–138 KB from the database, against 1,041 KB on main;
- a Desktop change read reads 181 KB, against 1,037 KB.

Idle, a Desktop change read costs 44 KB and a host tick 5 KB.

## Goal 4: the migration dry run

`scripts/swarm-parts/dry-run.ts` runs on its own loopback replica set.

### On the base that ships

This run is from a clean checkout of `63a497c0e`. That base adds the rollback guards of #1748–#1750: rollback refuses
a Swarm that the previous release would misread. The dry run now writes one such Swarm of each kind after the migration
(step 5b). It exited 0 in 21.0 s.

| Step | Result | Time |
|---|---|---|
| Seed 13 synthetic production-shaped Swarms | the big one: 1.16 MB, 196 groups, 40,000 messages; medium: 412.2 KB, 51 groups, 8,000 messages; ten small; one from before projects | 3,024 ms |
| Migrate | 13 ok, 0 failed, each read back and verified field by field, message count and order unchanged; big 920 ms, medium 193 ms, the small ones 19–25 ms | 3,482 ms |
| Migrate again | nothing to do | 38 ms |
| Read by parts | the big one: first load 316.6 KB, idle change read 2.6 KB, host form 10.8 KB in full, 108 B idle; old Desktop read 1,130.8 KB | 182 ms |
| Real commands through the store, then poll | 4 commands, 1 part written each; change read after two of them 6.3 KB (1 group); the host running that work 4.5 KB, another host 108 B | 296 ms |
| 5b. Unsafe for the previous release, written after the migration | a private conversation in one small Swarm, a lost task in another | 30 ms |
| Roll back | **11 of 13 rolled back**: the 2 written since are rebuilt from their parts, and the other 9 are identical to their old state. **2 refused on purpose** (below) | 195 ms |
| Old-shape read of every rolled-back Swarm | ok for all 11: format 1, revision above every message sequence. This checks the rolled-back state's shape with this branch's reader, not the previous release's binary or its access checks | 78 ms |

The 2 refusals change nothing. The parts stay authoritative, so nothing is lost or made public, and the remedy is to
roll forward with a fix:
- **The Swarm with a private conversation:** the previous release would make its private conversation readable by
  every project reader.
- **The Swarm with a lost task:** the previous release would read that task as active work.

### Earlier, at `4b8b5ea8a`

This run is from before the rollback guards. It exited 0 in 15.3 s, and rolled back **13 of 13**:

| Step | Result | Time |
|---|---|---|
| Seed | the same 13 Swarms | 2,863 ms |
| Migrate | 13 ok, 0 failed, verified; big 952 ms, medium 209 ms, the small ones 20–25 ms | 3,561 ms |
| Migrate again | nothing to do | 38 ms |
| Read by parts | the same sizes as above | 189 ms |
| Real commands through the store, then poll | the same as above | 289 ms |
| Roll back | 13 ok: the 2 written since are rebuilt from their parts, and the other 11 are identical to their old state | 190 ms |
| Old read of every Swarm | ok: format 1, revision above every message sequence | 79 ms |

`integration/superTabMigration.test.ts` passed as part of `npm run test:super-tabs` at `4b8b5ea8a`. A first dry run on
`b4b28aec8` gave the same results (3,513 ms to migrate).

## Isolated end to end

The stack ran on one Mac at `4b8b5ea8a`, all on loopback, with its own data:
- **Database and cache:** a MongoDB 7 replica set and Redis 7 in throwaway containers.
- **Sign-in and backend:** a fake sign-in service with fixed test tokens, and the backend from that commit (group 3's
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
| Host tick, idle, 60 s | 60 reads, 300 B on average: one full read each minute (3.6 KB), every other read empty |
| Host tick, active, 60 s (a Lead post every 5 s to the Builder in its group) | 59 reads, 257 B on average, at most 269 B. None carried rows; every read named the etags it held. A full host form here is 1.9 KB |
| Desktop | `flutter test test/super_tab_local_backend_test.dart` against this backend passed: one first load (28.0 KB), change reads of 1,050 B and 1,334 B, the second person's post appears, old route 426. Today's full read of that Swarm is about 24.5 KB |

**Desktop was checked through the real Swarm controller over HTTP, not by running the app.** Desktop sends its calls
through the daemon on port 18473, and on this Mac that is the everyday one, which must not be touched. The controller
is the code Desktop and the web app run, and the widget tests cover the screens on top of it.

Not covered here: `harness super-tab status` from an agent. It needs a live agent session, so the placeholder agents in
this Swarm get `AGENT_UNAVAILABLE`, as designed. Group 5 ran it with live sessions at `3cb3e3350`. The same run on
`03180d7a1`, before #1745, gave the same results. Both times the stack was taken down at the end: processes stopped and
containers removed, with no port left open.

## Reproducing the numbers

All of these run from `backend/` after `npm ci`. Each starts its own MongoDB replica set on 127.0.0.1 and reads no
other database.

**Benchmark, new store** (at the integration head, about 3 minutes each, one after the other on a quiet machine):

```bash
npm run bench:swarm-state                          # mixed, run 1; run it again for run 2
npm run bench:swarm-state -- --lane cross-group    # the goal-1 lane
npm run bench:swarm-state -- --done-share 0        # the hot Swarm
```

**Benchmark, main** (the same three commands, from a checkout of `f53d296d8`, where the default driver is main's).
The mixed and lane baselines are recorded in [the baseline](2026-10-26-swarm-state-baseline.md). Only the hot run is
new here.

**Where the output lives.** Each run prints its markdown report and writes `<driver>-<time>.json` and `.md` to
`integration/bench/results/` (or `--out DIR`). That folder keeps only committed reports in git. The runs this document
quotes are committed there:
- main: `baseline-main-0d3485bad-{mixed-1,mixed-2,cross-group,hot}.json`;
- new store: `results-44d51aae8-{mixed-1,mixed-2,cross-group,hot}.json`.

Each report names its commit, machine and plan fingerprint.

**Database bytes per poll:** `pollDatabaseBytes.ts`, with the command above.

**Migration dry run:**

```bash
NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  node --import tsx scripts/swarm-parts/dry-run.ts --out <folder>
```

It prints the timings and writes `swarm-parts-migration-<date>.json` to the folder.

**Isolated end to end:**
- The stack is group 3's local backend recipe: containers, fake sign-in and the backend on port 18085.
- The Desktop part is the opt-in test in `desktop/`:
  `SWARM_LOCAL_BACKEND=http://127.0.0.1:18085 SWARM_LOCAL_TAB=<Swarm id> flutter test --no-pub test/super_tab_local_backend_test.dart`.
- The rest came from [2026-10-26-swarm-state-results-e2e.test.mts](2026-10-26-swarm-state-results-e2e.test.mts). It
  is kept here as a reference file, outside every test suite. It uses the CLI's end-to-end harness
  (`cli/e2e/harness/daemon.ts`, `client.ts`), after `cli/vitest.setup.ts` for test isolation:
  - it seeds the Swarm and checks each behaviour over HTTP;
  - it starts an `IsolatedDaemon` signed in through a counting proxy on port 18086, and wakes its Swarm host;
  - it counts the host-form replies for 60 s idle, then 60 s with a post every 5 s.
- Any failed check fails the run, and so does any post in the busy window that fails or takes over 30 s. The JSON
  file is written either way.
- The fake sign-in must also accept `local-outsider-token` (outsider@local.test), for the non-member check. Without it,
  the run fails on that check, as it should.
- The figures above ran at `4b8b5ea8a` (integration head `44d51aae8`).
- The file as checked in ran again on base `1d79b4e57`, whose backend and CLI are the same, and passed all 12 checks.
  The other figures were the same. The host-tick windows differed by a few bytes:
  - idle: 60 reads averaging 284 B (300 B before);
  - active: 59 reads averaging 257 B, with all 11 posts landed.
- Run it from `cli/`, with the stack up, in about 4.5 minutes. It writes every check and its figures to the JSON
  file:

  ```bash
  E2E_OUT=<file.json> npx vitest run --root ../docs/performance --globals --testTimeout 900000 \
    2026-10-26-swarm-state-results-e2e.test.mts
  ```

## Suites

Backend and CLI at `4b8b5ea8a`. Desktop at `1d79b4e57`, the current head, which adds #1746 under `desktop/`.

| Suite | Command | Result |
|---|---|---|
| Backend typecheck | `npm run typecheck` | 0 errors |
| Backend unit | `npm test` | 2,185 passed, 11 skipped, 1 failed. The failure is `src/lib/teamSession.test.ts` › "cannot share another machine's harness…" (expected 404, got 500), which fails identically on main |
| Backend integration | `npm run test:super-tabs` | 7 files, 274 passed (read and migration suites included) |
| Bench self-tests | `npx vitest run --config integration/bench/vitest.config.ts`; `npx tsc -p integration/bench/tsconfig.json` | 7 files, 42 passed; 0 errors |
| CLI typecheck | `npm run typecheck` | 0 errors |
| CLI Super Tab specs | `npx vitest run src/superTabs` | 34 files, 896 passed |
| CLI `test:super-tabs` | `npm run test:super-tabs` | 188 passed, 100% coverage |
| CLI `test:harnessd` | `npm run test:harnessd` | 358 passed, 1 skipped |
| CLI `test:core` | `npm run test:core` | 3,116 passed. The coverage gate fails with the same 15 misses as on main (transcripts `ingest`, `history`, `attach`, `lastTurn`; services `machineAddonsProcess`, `process`), compared line by line |
| Super Tab end to end | `npx vitest run --config vitest.e2e.config.ts e2e/superTabs.e2e.ts e2e/superTabMachines.e2e.ts e2e/superTabsCollaboration.e2e.ts e2e/superTabRoute.e2e.ts e2e/swarmLegacySkills.e2e.ts e2e/agentClient.e2e.ts` | 12 passed, 9 failed: exactly the 9 group 5 recorded as failing on the base (5 in `agentClient`, 3 in `superTabs`, 1 in `superTabsCollaboration`), compared by name |
| Desktop analyzer | `flutter analyze --no-pub` (Flutter 3.47.2) | 47 issues, the identical list at `d9cf81002`, none in a file #1726 changed |
| Desktop affected suites (VM) | `flutter test --no-pub --timeout 60s --concurrency=6 test/super_tab_*_test.dart test/welcome_closed_super_tabs_test.dart test/devices_harness_test.dart test/swarm_launch_recovery_test.dart test/swarm_projects_test.dart test/swarm_sharing_test.dart test/shared_tab_invites_test.dart` | 784 passed, 3 skipped (one is the opt-in local backend test). At `4eab760ed`, before #1746: 770 passed, 2 skipped |
| Desktop affected suites (Chrome) | `flutter test --no-pub --platform chrome --dart-define=HARNESS_TEST=true test/super_tab_reading_test.dart test/super_tab_reading_client_test.dart test/super_tab_reading_workspace_test.dart test/super_tab_saved_view_test.dart test/super_tab_saved_view_widget_test.dart test/super_tab_parts_reading_test.dart test/super_tab_dormant_groups_test.dart test/super_tab_message_paging_test.dart test/super_tab_update_required_test.dart` | 91 passed |

## Limits

- One local mongod on a laptop, without a network. Compare counts, rates and bytes between runs on the same machine,
  not absolute latencies.
- Read latency is close to main's: Desktop p50 is 31–54 ms against 19–38 ms, and host 37–51 ms against 24–60 ms.
- The benchmark keeps every group active for the run (no 24 h dormancy), and models no `agent.start` dispatch, joins,
  sharing or Pro cards.
