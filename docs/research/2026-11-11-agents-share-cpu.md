# Agents sharing one computer's cores (11 to 12 November 2026)

> Package 7 of [the allocator's build list](../design/2026-11-11-swarm-allocator/BUILD.md), asked by anh Dee on
> 2026-11-11: "with multiple agents, it's CPU constraint". Measured by an agent on one Mac on the night of 11 to 12
> November (GMT+7), while other agents built this repository on it. The scripts and the runs' output were working files
> and are not kept here; each section says how its numbers were got, so they can be got again. Each claim is tagged
> **measured** (counted from a run), **modelled** (worked out from measured numbers), **read** (in a tool's code or
> documentation) or **assumed**.

## The short version

1. **Several runs at once, each sized to the whole machine, fail.** An eighth of the CLI's unit suite takes 79 to
   115 s alone with the suite's own 8 workers, and those 4 runs passed, as did one alone with 4 workers and one with 2.
   Started four at once, each with 8 workers, each took 204 to 230 s and all 12 failed, in three sets; two at once, 98
   and 151 s, and all 4 failed. Most failed files were a hook or a case past its deadline. *(measured)*
2. **Given half its share of the cores, every run passed.** Four at once with 2 workers each, and two at once with 4
   each: 20 runs of 20 passed, 10 sized by Vitest's own variable before the change and 10 by the share a Swarm now
   gives. With a whole share each (four runs of 4 workers: 16 on 16 threads), 2 of 4 failed. *(measured)*
3. **It costs time.** Four at once at half a share took 350 to 549 s each, against 204 to 230 s for those sized to the
   machine, which failed; two at once, 158 to 229 s against 98 and 151 s. Four runs one after another would take about
   as long, 317 to 458 s for all four, and give the first result in 79 to 115 s. *(measured; the four in a row modelled
   as four times a run alone)*
4. **The cores are not what the runs wait for.** Four runs of 2 workers computed on 1.4 to 2.2 of the 16 cores
   between them, and each still took 2 to 3.1 times as long as the same run alone. Each file's own time grows. What it
   waits for was not measured. *(measured; the cores modelled as the runs' CPU seconds over their wall time; the cause
   not measured)*
5. **A share costs a run that is alone.** With 4 workers a lone run takes 95 s, with 2 workers 176 s, against 79 s
   with 8. *(measured)*
6. **A lower priority did not stop four at once failing.** Under `nice -n 10` four at once failed as before, 4 of 4,
   in 172 s against 204 to 225 s without it; a pair under it passed, in 139 s, where a pair without it failed in 98 s:
   one sample each. Under macOS's background policy (`taskpolicy -b`) four at once failed, 4 of 4. A longer deadline
   did not save them either: with hooks given 30 s, 4 of 4 failed. *(measured)*
7. **The background policy protects the person's own work, and so does a share.** Beside 16 processes that only
   compute, a fixed piece of the person's work took 1.9 times as long as alone at normal priority, and no less at
   `nice` 10 or 20; under the background policy, 1.3 times. Beside four suite runs under it, and beside runs at half a
   share, it kept nearly its pace (one burst in ten at 138 to 155 ms, against 115 to 117 ms alone). *(measured)*
8. **Vitest's own variable cannot be handed to an agent.** `VITEST_MAX_WORKERS` overrides `--maxWorkers=1` and
   `--no-file-parallelism`: a suite that asks for one file at a time would run in parallel. *(read in Vitest's code,
   and counted)*
9. **Built:** each agent a Swarm starts gets its share of its computer's cores, the machine's cores over the Swarm's
   agents there, in `HARNESS_CORES`, and this repository's CLI suite takes half of what it is given. After it, four
   agents' runs at once passed, 8 of 8, in 350 to 517 s; the same runs with no share, as a person's own sessions start,
   failed 4 of 4. *(measured)*
10. **The plan stops counting cores.** It let 16 cores take four large tasks at once, which is four runs at once, and
    nothing checked it when a task was taken. *(read in the code)*
11. **The share's weak point:** an agent keeps the share it was started with until it is relaunched (agents started
    at the same moment count each other since the review of #4150, section 8). Four agents
    started one after another get 16, 8, 5 and 4 cores: 8, 4, 2 and 2 workers, 16 in all, as many as in the set where 2
    of 4 runs failed. *(modelled from the code; not measured)*

## Method, data and limits

- **The computer.** One Mac: Intel Core i7-10700K, 8 cores and 16 threads, 64 GB, an SSD, macOS 26.6.2. Node 26.7.0
  (libuv 1.52.1), Vitest 4.1.10. `os.availableParallelism()` says 16.
- **It was never idle.** Other agents were building this repository on it all night. Each set waited for a quiet
  moment (the machine at least 60% idle on two samples, for three to ten minutes at most), and its record says what
  else ran: the CPU of every process that was not one of the set's own, every 10 s. Everything else took 0.7 to 8.3
  cores as a set started, and 0.8 to 7.3 on average while one ran.
- **The work.** `npx vitest run --shard=1/8` in `cli/`: an eighth of the CLI's unit suite as Vitest splits it, by a
  hash of the paths, so the same 159 of its 1,270 spec files each time (79 under `src/lib`, 18 `src/engines`, 12
  `src/core`, 9 `src/superTabs`, 9 `src/services`, the rest spread), 2,555 cases. The whole suite was run once first
  (section 1.1), and is too long to repeat.
- **A set** is one, two or four of these runs started in the same second, each keeping its own output:

  ```
  env -u TMUX -u TMUX_PANE TMUX_TMPDIR=<a folder that exists> [VITEST_MAX_WORKERS=<n> | HARNESS_CORES=<n>] \
    /usr/bin/time -l -o run-<i>.time [nice -n 10 | taskpolicy -b] \
    npx vitest run --shard=1/8 --reporter=default --reporter=json --outputFile.json=run-<i>.json
  ```

  Wall and CPU time are `time`'s. A run failed when it exited 1; what failed is in its JSON report. Before the change a
  share was given as `VITEST_MAX_WORKERS` (section 6); after it, as `HARNESS_CORES` and nothing else, as a Swarm's
  launch gives it.
- **One checkout.** A run writes its fixtures in a folder of its own under `/tmp` (`src/__fixtures__/vitestRun.ts`,
  by `mkdtemp`) and in throwaway homes. In the checkout it writes only Vitest's record of file durations
  (`node_modules/.vite/vitest/<hash>/results.json`), which orders the files. So a set's runs did not collide, and
  shared one checkout.
- **The person's own work** is a probe beside each set: every second, one fixed piece of single-thread work (SHA-256
  over 64 MiB) at normal priority, timed. Beside nothing it takes 113 ms (one burst in ten: 115 to 117 ms).
- **Which setting a tool obeys** was read in its code, then counted: the most worker processes a
  run's own Vitest process had at once, sampled every 0.1 s, over 11 spec files (`src/superTabs/assign` and
  `src/superTabs/inCore`).
- **After the change** (section 8) the runs name the same 159 files instead of `--shard=1/8`: the change adds a spec
  file, which moves the shard's edges.
- **Limits.**
  - **One or two samples a set**, on a computer whose other load changed by the minute. A repeat of the same set took
    up to half as long again (four runs of 2 workers: 426 and 549 s before the change, 350 and 515 s after; one run
    of 8 workers: 79 to 115 s). Failures held steadier: no set that failed passed on its repeat, and none that passed
    failed.
  - **A suite run is not an agent.** Runs started in the same second do the same files at the same moments: the worst
    case of agents testing at once. How often agents' runs overlap on a real Swarm's day was not measured.
  - **One computer, one suite, one tool.** Desktop's suite needs Flutter, which is not on this Mac's path. Nothing was
    run on Linux or Windows: section 7 is their documentation and code.
  - **A set's runs read one checkout,** so they shared one file cache. Agents' worktrees would not.
  - **Every run of a set had the same share.** Uneven shares (point 11) were not measured.

## 1. Runs at once, each sized to the machine

### 1.1 The whole suite, once

`npx vitest run` in `cli/`, all 1,270 spec files, one run, started at 00:36 when the rest of the machine was 60 to 69%
idle. The other agents came back: the one-minute load while it ran was 7 at its lowest, 23 at its median and 39 at its
highest (103 samples). After 17 minutes 306 files had passed and 13 had failed, and it was stopped. Failed by then:
`hookNotify` (383 s for the file), `gitProject` (344 s), `dshLaunchShapes.golden` (158 s), `engineLaunch`,
`messages/service`, `localModels`, `registry.admission`, `ptyHost/launch`, `openclaw/live`, `launchPrep.golden`,
`launchArgv.golden`, `tmux` and `projectFolder`. *(measured)* This is the wall as the owner meets it: one sample with
nothing held still. The rest of the study uses an eighth of the suite, in sets a few minutes long.

### 1.2 An eighth of it: one, two and four at once

Each run sized as the suite's config says: 8 workers, half of 16. The runs after the change carry no share, as a
person's own session starts, so they are sized as before. *(measured)*

| Runs at once | When | Wall of each (s) | Runs that failed | Files failed in each | Everything else (cores, mean) |
|---:|---|---|---:|---|---:|
| 1 | 00:54 | 104 | 0 of 1 | 0 | 7.3 |
| 1 | 01:53 | 79 | 0 of 1 | 0 | 1.7 |
| 1 | 05:59, after | 87 | 0 of 1 | 0 | 3.1 |
| 2 | 01:38 | 98, 98 | 2 of 2 | 1, 1 | 2.0 |
| 2 | 05:57, after | 151, 151 | 2 of 2 | 1, 1 | 1.4 |
| 4 | 01:04 | 225, 225, 225, 224 | 4 of 4 | 2, 3, 4, 2 | 6.2 |
| 4 | 01:27 | 205, 205, 204, 205 | 4 of 4 | 3, 4, 4, 5 | 2.4 |
| 4 | 05:28, after | 230, 217, 230, 227 | 4 of 4 | 4, 5, 4, 4 | 3.2 |

- **Four at once take 1.8 to 2.9 times as long as one, and every run fails.** Two at once fail too.
- **What fails is deadlines.** Over every run sized to the machine two or four at once, with or without `nice`, the
  background policy or longer hooks (30 runs, 28 failed, 83 failed files): 54 were a hook past its deadline: 43 a
  file's setup past its 10 s (the golden files `dshLaunchShapes`, `otherRuntime` and once `otherTranscripts`, whose
  setup imports much of the daemon's code afresh), 2 the same past 30 s in the set whose hooks had 30 s, and 9 a
  case's setup past 10 s (`controlTranscript`); 13 a case past its own deadline (30 s, and 120 s for `otherRuntime`'s);
  16 an assertion that failed under load (`complete: false` where `true` was due, a path not yet written). Every one
  of those files passed in every run alone and in every run at half a share. *(measured)*

## 2. Each run with a share

The same runs, each told how many workers to take (`VITEST_MAX_WORKERS`). A share is the machine's 16 cores over the
runs. The suite's own rule takes half its cores for workers ("One worker per CPU starves those children on busy hosts":
`cli/src/testing/suiteWorkers.ts`, in `cli/vitest.config.ts` before this change), so half a share is 4 workers for
each of two runs, and 2 for each of four. *(measured)*

| Runs at once | Workers each | Wall of each (s) | Runs that failed | Files failed in each | Everything else (cores, mean) |
|---:|---:|---|---:|---|---:|
| 2 | 4, half a share | 159, 158 | 0 of 2 | 0, 0 | 1.9 |
| 4 | 4, a whole share | 304, 292, 292, 304 | 2 of 4 | 0, 2, 1, 0 | 1.9 |
| 4 | 2, half a share | 549, 549, 549, 549 | 0 of 4 | 0, 0, 0, 0 | 3.2 |
| 4 | 2, half a share | 426, 426, 426, 422 | 0 of 4 | 0, 0, 0, 0 | 2.0 |

- **At half its share every run passed**: 10 of 10 here, and 10 of 10 after the change (section 8).
- **It costs time.** Four runs at half a share took 422 to 549 s each here, 1.9 to 2.7 times what the ones sized to
  the machine took to fail. Two took 158 and 159 s, against 98.
- **A whole share is not enough.** Four runs of 4 workers took 292 to 304 s, and two of the four failed.

## 3. A lower priority, and the system's own control

Each run started under `nice -n 10`, or under macOS's background policy: `taskpolicy -b` "Run the program after calling
setpriority(2) with a priority of PRIO_DARWIN_BG", and "All children of the specified program also inherit these
policies" *(read: `man taskpolicy`)*. The person's work is the probe. *(measured)*

| Runs at once | Started under | Wall of each (s) | Runs that failed | The person's work: median / one in ten / slowest (ms) |
|---:|---|---|---:|---|
| 4 | nothing | 225 and 205, two sets | 8 of 8 | 167 / 557 / 814 and 121 / 316 / 589 |
| 4 | `nice -n 10` | 172, 172, 171, 172 | 4 of 4 | 123 / 447 / 615 |
| 4 | `taskpolicy -b` | 244, 244, 244, 244 | 4 of 4 | 134 / 142 / 162 |
| 4 | 2 workers each (section 2) | 549, and 422 to 426: two sets | 0 of 8 | 118 / 142 / 286 and 114 / 148 / 204 |
| 2 | nothing | 98, 98 | 2 of 2 | 117 / 202 / 254 |
| 2 | `nice -n 10` | 139, 139 | 0 of 2 | 116 / 147 / 235 |
| 1 | nothing | 79 | 0 of 1 | 114 / 144 / 189 |

- **`nice` did not stop four at once failing.** Four runs under it failed as before, in 172 s against 204 to 225 s
  without it, and one burst in ten of the person's work still took four times its time alone. The pair under it passed,
  in 139 s, where the pair without it failed in 98 s: one sample each, and no reason is known why `nice` would do
  either.
- **The background policy protects the person, and nothing else.** Under it the person's work is nearly as quick as
  beside nothing (one burst in ten at 142 ms, against 115 to 117), and the runs fail as before, a little slower.
- **A share protects the person too**: 8 workers on the machine in all leave room.

The same probe beside 16 processes that only compute (`node -e 'for(;;){}'`), started four ways, twice *(measured)*:

| The 16 started under | The person's work, median (ms) |
|---|---:|
| none running | 113, 113 |
| nothing | 211, 210 |
| `nice -n 10` | 356, 213 |
| `nice -n 20` | 215, 213 |
| `taskpolicy -b` | 146, 143 |

Beside a full machine the person's work takes 1.9 times as long, and `nice` leaves it there (the 356 ms was taken
while everything else used 5 cores, against 2 the second time). The background policy brings it back to 1.3 times.

## 4. What a share costs a run that is alone

A share is set when an agent starts. A run that happens to be alone keeps to it. *(measured)*

| Workers | Whose that is, on 16 cores | Wall alone (s) | Against 8 workers |
|---:|---|---:|---:|
| 8 | one agent, or a person's own session | 79 | |
| 4 | each of two agents | 95 | 1.2 times |
| 2 | each of three or four agents | 176 | 2.2 times |

One worker (each of five agents or more) was not measured.

## 5. What the runs wait for

Not the cores. *(measured)*

| Runs at once | Workers each | CPU seconds a run (user and system) | Its files' own times, added (s) | One-minute load, median |
|---:|---:|---|---|---|
| 1 | 2 | 150 | 309 | 4.9 |
| 1 | 4 | 153 | 328 | 4.4 |
| 1 | 8 | 180 to 243 | 543 to 749 | 4.6 to 13.3 |
| 2 | 4 | 182 to 197 | 563 to 820 | 5.5 to 6.3 |
| 2 | 8 | 206 to 211 | 647 to 1,073 | 4.2 to 16.5 |
| 4 | 2 | 194 to 204 | 615 to 996 | 6.3 to 6.8 |
| 4 | 4 | 204 to 209 | 1,012 to 1,076 | 6.8 |
| 4 | 8 | 208 to 269 | 1,100 to 1,569 | 7.1 to 13.8 |

- **A run computes 150 to 269 CPU seconds whatever runs beside it**, while its wall goes from 79 to 549 s.
- **With four runs of 2 workers the machine was more than half idle.** The four computed on 1.4 to 2.2 cores between
  them (their CPU seconds over their wall time), and each took 2 to 3.1 times as long as the same run alone.
- **What grows is each file's own time.** `otherTranscripts.golden` takes 3 s in a run alone with 2 workers and 41 to
  100 s alone with 8; four runs at once, 22 to 207 s.

What the files wait for was not measured. The slow ones start engines, shells and tmux servers and write files.
*Assumed:* starting a process and flushing the disk go through the one system whatever the cores, and every run on the
machine shares them.

## 6. What a tool reads for its workers

**Vitest reads `VITEST_MAX_WORKERS`, and obeys it over everything else.** Its config resolution takes the config's
`maxWorkers` or the `--maxWorkers` flag, sets one worker when `fileParallelism` is off, and after both sets
`if (process.env.VITEST_MAX_WORKERS) resolved.maxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS)` *(read:
`vitest` 4.1.10, `dist/chunks/coverage.DM_a_rWm.js`)*. With nothing set, a run takes `os.availableParallelism()` less
one, and a watch half *(read: its `getDefaultThreadsCount`)*.

Counted on this Mac over 11 spec files, the most worker processes at once *(measured)*:

| Asked | Workers |
|---|---:|
| nothing (this repository's config: half of 16) | 8 |
| `VITEST_MAX_WORKERS=3` | 3 |
| `--maxWorkers=1` | 1 |
| `VITEST_MAX_WORKERS=3` and `--maxWorkers=1` | **3** |
| `--no-file-parallelism` | 1 |
| `VITEST_MAX_WORKERS=3` and `--no-file-parallelism` | **3** |
| `VITEST_MAX_WORKERS=16` | 11, one a file: above the config's 8 |

So it cannot be set for an agent: it is an order, not a ceiling. An agent started with it would run in parallel every
suite that asks for one file at a time, and this repository has them: the serial port and terminal contract specs
(`--maxWorkers=1`), the backend's Super Tab gate (`fileParallelism: false`), the end-to-end suite (one worker). And an
agent alone on a machine would run this suite with 16 workers where its config asks for 8.

**Nothing on macOS makes a tool see fewer cores.** `os.availableParallelism()` is libuv's
`uv_available_parallelism()`, which on macOS takes the first of the system's `hw.activecpu`, `hw.logicalcpu` and
`hw.ncpu` *(read: libuv 1.52.0, `src/unix/core.c`)*.

**Other tools**, read in their documentation or this repository and not tried:

| Tool | Reads | Note |
|---|---|---|
| The backend's suite | Vitest's default | `backend/vitest.config.ts` sets no workers: 15 on 16 threads |
| Desktop's suite | `scripts/test-desktop.py --workers` | By default three quarters of `os.cpu_count()` on 16 CPUs or more, at most 12, passed to `flutter test --concurrency` |
| Python | `PYTHON_CPU_COUNT`, `-X cpu_count` | Overrides `os.cpu_count()`; added in 3.13. This Mac has 3.12 |
| Cargo | `CARGO_BUILD_JOBS` | `build.jobs`, by default the logical CPUs; `--jobs` overrides it |

## 7. Linux and Windows

Nothing here was run on either. It is their documentation, and libuv's code, for whoever tries them.

| Control | macOS (tried: sections 2 and 3) | Linux (not tried) | Windows (not tried) |
|---|---|---|---|
| A share of the cores | No system control: a variable the project's tools read | `taskset --cpu-list <cpus> <command>` sets a CPU affinity; a cgroup's `cpu.max` is its maximum bandwidth. libuv counts the calling thread's affinity mask and then takes the cgroup's quota when that is lower *(read: libuv 1.52.0, `src/unix/core.c`)*: `os.availableParallelism()` itself gets smaller, and a tool sizes itself with no variable | A job object manages a group of processes as one, and a process that one in a job creates is in that job by default. Its CPU rate control sets a hard cap, or a weight of 1 to 9. libuv counts the process's affinity mask (`GetProcessAffinityMask`) and reads no job limit *(read: libuv 1.52.0, `src/win/util.c`)*: a job's affinity would make Node count fewer cores, its rate control would not |
| A lower priority | `nice -n 10`: no effect found | `nice`; a cgroup's `cpu.weight`, 100 by default, 1 to 10,000 | A priority class: a process that one of the idle or below-normal class creates gets that class by default |
| A group of processes | `taskpolicy -b`, which every child inherits | cgroup v2: `cpu.max`, `cpu.weight`, `cpuset.cpus`; systemd's `CPUQuota=`, `CPUWeight=`, `AllowedCPUs=` | Job objects, as above |

`HARNESS_CORES` is read the same way on all three. On Linux the system's own control would do more: a tool that knows
nothing of Harness would size itself by it.

## 8. What was tried, what was built, and the same measurement after

| Tried, on macOS | What it did | Kept |
|---|---|---|
| A share of the cores, through Vitest's own variable (`VITEST_MAX_WORKERS`) | At half a share every run passed, 10 of 10 (section 2) | The share. Not the variable: it overrides a suite that asks for one file at a time (section 6) |
| A lower priority (`nice -n 10`) | Four at once failed as before, though quicker; a pair passed where a pair without it failed, one sample each; the person's work as slow as without it (section 3) | No: it did not stop four at once failing |
| The system's control for a group of processes (`taskpolicy -b`, which every child inherits) | Four runs failed as before, a little slower; the person's work kept its pace (section 3) | No: a share protects the person as well, and its runs pass |
| Hooks given 30 s instead of 10 | Four runs failed as before (section 1.2) | No |
| The same controls on Linux and Windows | Not tried (section 7) | |

- **A Swarm starts each of its agents with its share of the machine's cores**, in its environment as `HARNESS_CORES`:
  the machine's cores over the Swarm's agents on it, rounded down, never below one
  (`cli/src/superTabs/inCore/launch.ts`). At its first launch and at every relaunch, counted again each time. A
  person's own session gets none, and a daemon started from an agent's shell hands it to no pane.
- **The variable is Harness's own, and a project's tools read it.** This repository's CLI suite does: its workers are
  half the cores it may use, the machine's or its share, and never more than the machine has
  (`cli/src/testing/suiteWorkers.ts`). No tool's own variable is set, and no engine's own setting is changed.
- **Agents started at the same moment count each other.** A start registers its row only once its pane exists, so
  each worked out its share before the others' rows were there, and each took the whole machine (the review of #4150).
  Each now counts the agents handed a share whose rows are not registered yet, for two minutes at most. *(Read and
  tested in `launch.spec.ts`; not measured on a machine.)*
- **The daemon counts the Swarm's agents in its registry**, those running from before a restart too
  (`e2e/paneEnv.e2e.ts`), and **says each share in its log**, in counts only: `[swarm] a Swarm agent's share of this
  machine's cores: 4 of 16, among 4 of the Swarm's agents here`.

Workers after the change, as the suite's config gives them (`suiteWorkers.spec.ts` asks Vitest's own
`resolveConfig`), and counted with the 11 spec files of section 6 where they are two or fewer *(measured)*: the
machine was shared, and the checks of this change ran with two workers at most.

| Started with | Workers |
|---|---:|
| nothing: a person's own session | 8, as before |
| `HARNESS_CORES=16`: one agent | 8 |
| `HARNESS_CORES=8`: each of two agents | 4 |
| `HARNESS_CORES=4`: each of four agents | 2, counted |
| `HARNESS_CORES=4` and `--maxWorkers=1` | 1, counted |
| `HARNESS_CORES=4` and `--no-file-parallelism` | 1, counted |
| `HARNESS_CORES=1`: each of nine agents or more | 1, counted |

The same sets after the change, on the same 159 files, each run started with what the launch gives it and nothing
else, against the runs sized to the machine *(measured)*:

| Runs at once | Before: sized to the machine | After: its share (`HARNESS_CORES`) | After: no share |
|---:|---|---|---|
| 1 | 79 and 104 s; 0 of 2 failed | 115 s (16 cores: 8 workers, as before); 0 of 1 failed | 87 s; 0 of 1 failed |
| 2 | 98 s; 2 of 2 failed | 229, 228 s (8 cores: 4 workers); 0 of 2 failed | 151 s; 2 of 2 failed |
| 4 | 204 to 225 s; 8 of 8 failed | 515, 515, 517, 512 s and 350, 354, 354, 351 s (4 cores: 2 workers); 0 of 8 failed | 217 to 230 s; 4 of 4 failed. With hooks given 30 s, 225 to 226 s; 4 of 4 failed |

- **With its share, no run failed**: 11 of 11, of them 10 two or four at once, as with Vitest's own variable before
  (section 2).
- **Without it the runs fail as before**: two or four at once, 10 of 10 failed. A person's own sessions are as they
  were.
- **The time is the share's cost**: 1.5 to 2.5 times what the runs that failed took, four at once.
- **One agent alone is as before.** With 16 cores it runs 8 workers, as a person's own session does: 115 s, and the
  same run with no share took 87 s twenty minutes later, against 79 and 104 s before. One run alone spreads that much.

## 9. The plan's cores

The plan counted cores: a small task held 1 of its machine's, a medium 2, a large 4, and no machine went past what its
daemon reported (8 when it reported none). Nothing checked it when a task was taken. The build list asked for one of
two: the daemon checks cores as a task is taken, or the plan stops counting them. **The plan stops counting them.**

- **The count did not keep a machine working.** On 16 cores it let four large tasks run at once, which is four agents'
  runs at once, and those all failed (section 1.2). What a run takes is set by its runner, the same whatever its
  task's size *(read: `cli/vitest.config.ts` before this change: half the machine)*.
- **What keeps it working is the share**, where the agents start (section 8).
- **On a machine of 8 cores or fewer the count let two large tasks run at once and held a third and a fourth back.**
  Nothing holds them back now. Their agents share the cores through `HARNESS_CORES`, but a tool that ignores it
  (Desktop's suite, the backend's, a build) still sizes itself to the whole machine, and nothing limits how many such
  runs go at once *(read in the code)*.
- **Holding a task back costs time.** In the design's model a machine of 6 cores, where two large tasks cannot run
  together, does 6 to 10% worse than one of 8, where nothing is held back *(modelled: [the experiment's
  tables](../design/2026-11-11-swarm-allocator/README.md#the-experiment), the solver one ahead)*. The model has no
  contention in it, so this is the cost alone.
- **A check as a task is taken is not small.** It needs a way to decline a task that was given, which is the offer
  record of the build list's package 16.

A daemon still reports its cores until 2026-12-12, for a PM's Harness from before this. *Assumed, not measured:* an
agent's heavy runs are a small part of a task's time, so two agents building at once on a small machine do more than
one building while the other waits.

## 10. What to try next

1. **An agent's share kept up to date.** A share is counted when an agent starts: the first of four agents started
   one after another keeps 16 cores until it is relaunched, and the last one left keeps 4 after the others stop. The
   tool would have to read the share when it runs, not when its agent started.
2. **One heavy run at a time on a machine.** Four runs in a row end about when four at once at half a share do, and
   the first is done at a quarter of that time (point 3). A suite could wait its turn in its own setup; Harness could
   give any command a turn.
3. **How often agents' runs overlap**, from a real Swarm's day. It decides whether a share pays: a share costs a lone
   run up to 2.2 times its time, and saves a run that would have failed.
4. **The same reading of `HARNESS_CORES`** in the backend's suite and in `scripts/test-desktop.py`. Neither was
   measured.
5. **On Linux, an affinity or a cgroup for each agent**, which would size every tool with no variable (section 7).
6. **The background policy for a Swarm agent's tools on macOS**, and its like on Linux and Windows, if the person's
   own work matters more than the runs' time (section 3).
7. **Agents that are a person's own sessions.** The night of this study the machine was loaded by other agents
   working in this repository, each started as its person's own session, not by a Swarm: they get no share.
