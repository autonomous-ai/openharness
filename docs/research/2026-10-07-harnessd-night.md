# harnessd, the night of 2026-10-06/07

What happened to the daemon overnight: what merged, the bugs found on the way, what was verified, what
is left, and the decisions waiting on the owner. Nothing was released. The release candidate is at the
end.

## In short

- **The core is down to session handling.** The core's process loads 72,125 lines in 340 files, from
  114,622 in 488 when the core-boundary work began (`cli/src/architecture.spec.ts` reports it). Every
  service runs in a process of its own. The experiments, the devices, models and the gateway start
  only when they are needed. The plan and its status are in
  [../design/2026-10-06-core-boundary-next.md](../design/2026-10-06-core-boundary-next.md).
- **A quiet daemon runs 6 processes instead of 8.** All of them together use about 190 MiB of physical
  memory at idle, against 0.3.60's 223 MiB in 6 processes, while every service keeps its own process.
  The core starts about 0.9 s sooner than 0.3.60's and is 13 to 19 MiB smaller. See
  [Processes and memory](#processes-and-memory).
- **Real bugs were found and fixed.** Most were found by the new tests, the soak run and an audit of the
  night's own merges. Two of them could cost a person every agent: a tmux crash on tmux before 3.7, and
  a dial unplug that hung the devices' process. See [Found on the way](#found-on-the-way).
- **Main's end-to-end suite is green again** on GitHub's Linux shards and on macOS. Three flaky tests
  turned out to be one product bug (tmux), one race (Share) and one test bug.
- **The unit suite no longer fails under load, and never reads a real home folder.** It runs in a
  throwaway `HOME`.
- **Main now has a merge queue** (#966). Before it, three teammate changes broke main's gates on the merged
  result (#752, #976, and c39f32d8d pushed straight to main); each was fixed forward within the hour (#969,
  #978).
- **Waiting on the owner:** four decisions. See [Decisions](#decisions-for-the-owner).

## What merged

Since the 0.3.60 release (0ed19668a), the daemon changes. Each passed the unit CI; the structural ones
also passed the full end-to-end suite.

| Area | PRs | What |
|---|---|---|
| Services out of the core | #875, #879, #896, #899, #905, #911 | The edge host (several light services in one process); the Store beside the viewers; models and the gateway (relay, E2EE, P2P) each in a process of their own |
| Experiments | #921, #924, #932, #933, #937 | The orchestrator, Tab collaboration, Share and the command bar: each a process that starts only once it is used, and can be killed without touching the core |
| Devices | #918, #928, #929, #946, #953 | The dials, window bridges, fleet and Wi-Fi device in one process, started only once there is a device |
| On demand | #971, #972 | Models start once grid is in use or a request needs them. The gateway starts once this machine is signed in, has anything paired, or needs it |
| More out of the core | #919, #922, #923, #931 | The old web dashboard deleted; the viewer forwarder moved to the viewers' process; recaps and the change-agent handoff moved to the edge host |
| Requests | #927, #940 | A routed request knows its connection and is abandoned when that connection closes; a service is welcomed before its first queued request |
| Updates | #895, #925, #960, #964 | `harness start -f` runs the master. The updater is a process the master runs, the core never downloads a build, the updater needs no socket, and only the updater can start a handover |
| Memory and start-up | #909, #917, #935, #955 | Less periodic CPU; old process tables released; the peer library loaded only for P2P; the core's own lean entry |
| tmux | #950, #962 | The control-client gate for tmux before 3.7, and a deadline on every tmux command |
| Turns and questions | #961, #970 | A question asked right after a typed prompt is announced; a late Stop hook closes only its own turn |
| Tests | #941, #943, #957, #958, #959, #963, #965 | Specs that failed under load or read a real home; compat |
| Docs | #939, #956 | The plans, and every AGENTS.md, match main |

## Found on the way

| Found by | Bug | Who it hits | Fixed in |
|---|---|---|---|
| The flaky `windows.e2e` (7 of 27 CI runs) | tmux before 3.7 segfaults when a control client attaches while a notification goes out: a detach, a session created, closed or renamed, or a paste. Every open terminal is a control client, so the server takes every agent with it (tmux issue 4980, fixed in 3.7) | Linux with the distribution's tmux (Ubuntu 24.04 ships 3.4, Debian 12 3.3a, Fedora 3.5a), and anyone on tmux 3.6 or older | #950 gates the daemon's own attaches and notifications. A person's own tmux clients can still trigger it; only tmux 3.7 fixes that |
| The macOS release check (`devicesProcess.e2e`) | Unplugging a dial as its port opened hung the devices' process for 40 s, because libuv reopens a tty by name with a blocking `open()`. The master killed it as hung, which cost the other dial too | Anyone with a dial | #953 streams the port over its own descriptor. Under load, 2 of 22 daemons hung before and 0 of 36 after |
| The soak run | Under load, a question asked right after a typed prompt was taken for the previous turn's and never shown. The agent waited on it for good, and its next prompt was held behind it | Anyone, more often on a busy machine | #961 |
| The soak run | A late Stop hook from one turn closed the next | Anyone | #970 |
| The flaky `experiments.e2e` | A service was sent queued requests before it was told it was connected. Share's first link answered "no longer available", and the teams called port 0 | Experiments starting on demand | #940 |
| The audit of #925 | With a data folder whose socket path is over 96 bytes, every service process crash-looped, and the updater with them, so that machine could never get the fix | Deep custom data folders | #960 runs the services in the core in that case, and the updater needs no socket |
| The audit of #925 | Any service process could start an update handover | A misbehaving service | #964 |
| The audit of #950 | `tmux load-buffer` had no deadline. On old tmux, a hung paste held every terminal open and close behind it | Old tmux with a hung server | #962 |
| Models and gateway on demand | A master whose re-execution was refused left every on-demand process stopped for good | Devices, experiments and models after a refused update | #971 |
| The load-sensitive specs | `hook/notify.mjs` passed a fractional timeout to `execFile`, which throws. On a busy machine the offline registration was dropped, 3 times in 3 | Anyone on a busy machine | #958 |
| The load-sensitive specs | Unit specs read the developer's real `~/.claude`, `~/.codex` and `~/.harness`, and two created and deleted folders in the real home | Developers running the tests | #957 and #965: the whole unit suite runs in a throwaway `HOME` |

The flaky `shell.e2e` was a test bug that #928 had already fixed. The fake phone said hello before the
gateway had joined the fake relay, and never said it again; the real phone app retries.

## Verified

On main `08548179c` (the lean core, #955), against the published 0.3.60 (sha256 checked against the
release manifest) and 0.3.58:

- **Unit gates:** tsc, plus `test:core`, `test:harnessd`, `test:local-models`, `test:resume`,
  `test:orchestrator`, `test:sharing`, `test:remote-viewers` and `test:portability`, each at 100% where
  it is a gate.
- **End to end:** the full suite on macOS from the bundle passed 75 files and 476 tests, with none
  failed. GitHub's Linux shards were all green (run 37556598301).
- **Update path:** the release rehearsal from 0.3.60 and from 0.3.58, signed in and signed out, and
  migration and re-exec from both. All passed.
- **Compat with 0.3.60:** one difference, which was timing: whether `agent_create` returns before
  discovery fills in the permission mode. #963 explains it, and compat has passed since.
- **Under load:** the unit suite at a load of 36 to 60 had 4 flaky files, down from 13 earlier in the
  night, and all of them passed on rerun. #965 then fixed the rest: under 12 busy loops at a load of 93
  to 120, main had 7, 8 and 4 failures in three runs, and the branch had none in four.

The final verification of the release candidate is under [The release candidate](#the-release-candidate).

## Processes and memory

Measured with the same harness, from the bundle, signed out, in a throwaway home, with medians of 3
runs. Physical footprint is the fair total; summed RSS counts shared pages again. The method and every
number are in [2026-10-07-harnessd-memory.md](2026-10-07-harnessd-memory.md).

| Idle, no agents | 0.3.60 | main at #955 | main now (#971, #972) |
|---|---|---|---|
| Processes | 6 | 8 | 6 |
| Footprint, all processes | 223 MiB | 277 MiB | about 190 MiB |
| Core footprint | 99 MiB | 86 MiB | not measured again |
| `harness start` until the core answers | 1,821 ms | 929 ms | not measured again |
| `harness start` until the first agent is created | 2,652 ms | 1,901 ms | not measured again |

- **Processes:** 0.3.60 runs a master, core, search, viewers, workspaces and teams, with the updater
  inside the core. Main at idle runs a master, core, search, viewers, the edge host and the updater.
  Models, the gateway, the devices and the experiments start when they are needed.
- **The "main now" column** was measured against main at 16469660b, a teammate's memory change (below):
  245 MiB with 8 processes, 222 with models on demand, 190 with the gateway on demand too. A phone
  reached a signed-in machine sooner with the gateway on demand: 743 ms to its first session, against
  912 ms.
- **The cost of each process:** an idle service process costs 61 to 85 MiB RSS, 20 to 40 MiB footprint,
  and about 0.12% of one core for its timers and heartbeat. The whole daemon at idle uses 1.2% to 1.8%
  of one core, in both builds.
- **16469660b** (a teammate, pushed straight to main) starts every process with
  `--max-semi-space-size=4` and builds the bundle Latin-1. Measured: the core's footprint is 46 MiB
  smaller under load and 23 MiB smaller at idle, but a busy core uses about 7% more CPU per turn and gets
  through about 7.5% fewer turns in 5 minutes. Idle CPU is unchanged. Its full end-to-end run passed.

## Decisions for the owner

1. **The updater as its own process** (#925): about 65 MiB RSS, 23 MiB footprint. It is the recovery
   path, so it was kept out of the edge host: a release whose edge services crash would otherwise park
   the updater with them, and that machine would never fetch the fix. Moving it into the edge host is a
   few lines in `master.ts`.
2. **The semi-space flag** (16469660b): less memory against about 7% more CPU per turn on a busy core.
   It is the teammate's change; it is reported here because it trades throughput for memory on every
   machine.
3. **Size is no longer a gate** (#906). The line budgets for the core's closure, `runForeground` and
   `backendSocket.ts` were replaced by dependency rules, with source size reported for review. That
   is a deliberate policy ("source line counts are informational, never a merge gate"). Since the recaps
   left (#923, 71,244 lines), the core has grown about 880 lines, most of it the SCM seam (#752, 611
   lines), which launching an agent uses. If the owner wants a size guard back, it is one test.
4. **tmux before 3.7:** the daemon now avoids the crash it can cause, but not one a person's own tmux
   clients cause. A start-up or `harness doctor` notice recommending 3.7 on older versions is small; it
   is a product call.

## Left

- **The engines' own code** is the main thing in the core that is not session handling. The
  engine-interface refactor is paused by the owner's call
  ([../design/2026-10-05-engine-interface.md](../design/2026-10-05-engine-interface.md)).
- **The soak and chaos harness** becomes an opt-in end-to-end suite the team can rerun before a
  release (in progress at the time of writing).
- **Unit flakes at a load above 100:** a handful remain under deliberate overload; they are being
  worked through one at a time.

## The release candidate

To be named after the final verification of main, with its results here.
