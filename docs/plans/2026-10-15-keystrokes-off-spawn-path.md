# Keystrokes off the core's spawn path

Status: proposed, 2026-10-15. Follows the typing-latency spike of the same day and fix A (held-launch
backoff and the cached launch environment), which removed the worst spawner but not the mechanism.

## Problem

A local terminal stutters while typing when the machine is busy. The echo's median is fine; its tail is not.

Measured with the e2e harness (isolated daemon, private tmux, fake Claude Code, 150–250 keystrokes per
condition, a keystroke's echo timed from the client). Load = 12 busy `yes` processes on a 12-core Mac;
flood = 4 other agents printing as fast as tmux reads, their streams open and acked every 16 ms.

| Condition (ms) | raw pty p50 / p99 | tmux control client p50 / p99 | daemon over local WS p50 / p99 / max |
|---|---|---|---|
| idle | 0.1 / 0.6 | 0.4 / 1 | 0.7 / 5 / 7 |
| CPU load | 0.3 / 5–20 | 1.2 / 12–28 | 2–4 / 62–101 / 300+ |
| CPU load + flood | 0.2 / 12 | 2.5 / 24–28 | 4.5 / 126–224 / 350 |

- The core hop adds 4–5× the tail tmux does. Flutter is not the cause: a typing echo parses and paints in
  ~0.2 ms; a full 30-row redraw costs ~0.8 ms per pane with real fonts (debug build).
- Under load the core's event-loop delay reached p99 ~65 ms and max 200–300 ms while the core used ~5 % CPU:
  it was blocked, not busy.
- `sample` of the core's main thread under load (no profiler attached): **~60 % of its non-idle samples
  were inside `uv_spawn` → `posix_spawn`**. Node's `child_process` spawns synchronously on the calling
  thread; under CPU contention one spawn takes tens of milliseconds.
- The spawns are the core's own probes, each a `ps`, `lsof` or `tmux` child: `readProcessEnv` (`ps eww`, per
  process, for discovery, the gateway runtime and DSH), `readProcessRows` (`ps -axo`), `darwinProcessImages`
  (`lsof`), `panePidLookup` and `tmuxCapture` (`tmux display-message` / `capture-pane`), `listPaneTitles`.
- A keystroke arrives on the same thread (`localWsServer.ts` → `TerminalStreamManager.handleBinary` →
  `TmuxControlStream.writeRaw`), and so does its echo (`%output` → `onOutput` → `flushOutput` → `ws.send`).
  Every spawn in between is time the keystroke waits.

On the real Mac after fix A, the core still spawns ~45 children a minute (`ps`, `lsof`, `tmux`); `uv_spawn`
is 4–7 % of the main thread's busy time on a lightly loaded machine, and climbs with load as above.

## Goal

A keystroke never waits behind a probe's spawn.

Success, on the same e2e workload and machine as the baseline:

- CPU load: daemon p99 ≤ 2× the tmux control client's p99 (today 3–5×), max < 100 ms.
- CPU load + flood: daemon p99 < 60 ms (today 126–224 ms).
- Idle: no regression (p50 ≤ 1 ms, p99 ≤ 5 ms).
- Core main thread: `uv_spawn` < 5 % of non-idle samples under load.
- Core CPU and RSS within 5 % of baseline on `e2e/perf.e2e.ts`.

## Options

1. **Run the probes' children from a worker thread (chosen).** One `worker_threads` worker in the core
   owns `child_process` for short-lived probes. The main thread posts `{file, args, options}` and receives
   `{error, stdout, stderr}`. `posix_spawn` then blocks only the worker. Small and targeted: almost every
   hot probe already goes through one wrapper, `patientExec` (tmux.ts, tmuxCapture.ts, tmuxAgentDiscovery.ts,
   tmuxBackend.ts, tmuxVersion.ts); the rest are four direct `execFile` calls. No protocol or process change.
2. **Move the terminal data plane to a worker** (Orca's shape: a pty host whose loop does nothing else).
   The worker would own the tmux control clients and a socket of its own for terminal frames, since a
   keystroke read by the main thread is already behind whatever holds it. Isolates keystrokes from
   everything (GC, synchronous fs, JSON, other frames), but changes the desktop's protocol (a second local
   socket), splits the control lease and stream state across threads, and is several times the work.
3. **Move the probes to a service process.** Discovery and reconciliation are core by design ("must never
   go down"); moving them is an architecture change for a scheduling problem.

Option 1 removes the measured cause at a fraction of the cost. Option 2 stays on the table if Phase 3's
numbers show the tail is still the core's (see "Decision after measurement").

## Design (option 1)

`src/lib/offThreadExec.ts`

- `execFileOffThread(file, args, options, done)`: the same callback contract as `execFile`
  (`error | null, stdout, stderr`), returns a handle with `kill(signal)`.
- The worker is a few lines of inline code (`new Worker(code, { eval: true })`) using only `node:child_process`,
  so the lean bundle needs no extra file. Started lazily on first use, `unref()`ed so it never keeps the
  process alive.
- **The child's timeout runs in the worker.** The worker's loop is not held when the core's is, so a
  timeout there is a real one. The main thread keeps no timer of its own: a main-thread timer is exactly
  what a held loop fires late, before the reply waiting in the port is read. A worker that dies fails
  its calls from its `exit` event. This also removes the case `patientExec` exists for (a held loop
  firing a timeout on an answer that already arrived), for these calls.
- **The environment is sent with every call**: `options.env ?? process.env`, captured when called. A
  worker's `process.env` is a copy made at its start, and the core changes `PATH` after start
  (`tmuxOnPath.ts`); a stale copy would find another `tmux`.
- `maxBuffer`, `killSignal`, `cwd` and `encoding: 'utf8'` are passed through. Output arrives as strings
  (structured clone); the largest regular one is `ps -axo` (tens to hundreds of KB every few seconds).
- One worker serves every call; children run concurrently, as they do now. Requests are numbered; a
  reply for a cancelled request is dropped.
- **Failure**: if the worker cannot start, or exits, every call in flight gets an error (`EWORKER`) and the
  next call starts a new worker. Two worker deaths in 60 s turn the route off and fall back to in-thread
  `execFile` for the rest of the process, logged once.
- **Opt-in by the core only.** `enableOffThreadExec()` is called from `runForeground` (core/main.ts) and nowhere
  else: services, the CLI and unit tests keep calling `execFile` in-thread, and a test's `vi.mock` of
  `node:child_process` still applies to every call it makes.

Routing

- `patientExec(execFile)`: when the route is on, calls go to `execFileOffThread` instead of the `execFile`
  passed in, and without its own deadline (the worker's is enough). When it is off, unchanged.
- Direct `execFile` probes routed the same way, through one helper `probeExecFile` exported beside it:
  `processEnv.read` (`ps eww`), `tmux.ts` `execText` (`lsof`), `nativeProcessImages` (the helper binary),
  `launchExecutable.captureEnvironment` (the login shell).
- Not routed: long-lived children (`tmux -C` control clients, engine panes, services), synchronous calls
  (`execFileSync`/`spawnSync`, which need their own fix), and anything outside the core process.

## Phases

Each phase ends green on its own and can ship alone.

### Phase 0: the measurement, in the repo

- Turn the spike into an opt-in e2e, `e2e/typingLatency.e2e.ts` (`TYPING=1`, like `PERF=1`). It times
  keystroke echo in four paths: raw pty, a tmux control client, the daemon over the local WS, and the
  core probe's event-loop delay. It runs idle, CPU load, flood, and load with flood, and writes JSON
  (`TYPING_REPORT=<file>`).
- Lessons from the spike that the test must keep:
  - Spawn the load processes directly; `sh -c 'yes …'` leaves orphans.
  - Send `terminal_alive` every 5 s or the streams expire after 30 s.
  - Never use `--cpu-prof`: it profiles the fake engines too and skews everything.
  - Use `sample <pid>` for main-thread attribution.
- Record the baseline on main: 3 runs of each condition, with the machine's load average reported beside
  them, since the host's own load is noise.
- Out: a reproducible baseline JSON and the command to rerun it.

### Phase 1: the off-thread exec

- `src/lib/offThreadExec.ts` and its spec, using real children (`/bin/echo`, `/bin/sh -c 'sleep …'`, a
  command that exits 3, one that prints more than `maxBuffer`):
  - an answer;
  - an exit code;
  - a timeout killed in the worker;
  - `kill()` from the main thread;
  - the env passed through after `process.env.PATH` changes;
  - a worker that exits mid-call (its calls fail, the next one restarts it);
  - two deaths turning the route off;
  - `unref` (a script using it exits).
- `patientExec` routing, with specs for on and off. Off must stay byte-for-byte the current behaviour; its
  existing specs keep passing untouched.
- `enableOffThreadExec()` called from `runForeground`.
- Validation:
  - `npm run typecheck`;
  - the new and affected specs;
  - `npm run test:core` (the core's files stay at 100 %);
  - e2e: `stall.e2e.ts` (a held loop must still not turn a timeout into "no panes"), `terminal.e2e.ts`,
    `paneLifecycle.e2e.ts`, `robustness.e2e.ts`;
  - `scripts/check-lean-bundle.mjs dist/cli.js` (the worker's inline code loads from the lean bundle).

### Phase 2: the direct probes

- Route `processEnv.read`, `tmux.ts` `execText`, `nativeProcessImages` and the launch environment's capture
  through `probeExecFile`.
- Inventory the remaining `execFile`/`spawn` calls reachable from the core's timers (`rg` over
  `child_process` imports under `src/lib`, `src/core` and `src/engines`, about 58 files). Route the periodic
  ones; list the on-demand ones in this plan with why they stay.
- Validation: their specs (they mock `node:child_process`, which still applies since the route is off in
  unit tests), `test:core`, and the e2e set from Phase 1.

### Phase 3: measure, then decide

- Rerun Phase 0's e2e on the same machine, three runs each, against the recorded baseline.
- Check the core with `sample` under load: `uv_spawn`'s share of non-idle samples.
- Run `e2e/perf.e2e.ts` (CPU, RSS, event-loop delay of the core) against main's numbers.
- On the real Mac, install the build and check two things before and after: children per minute and
  `uv_spawn`'s share in the core.
- Record the numbers in the PR. The typing-latency targets are the gate, not a feeling.

### Decision after measurement

- Targets met: done. Sync spawns (`execFileSync`/`spawnSync`), if any remain on a timer, become a follow-up.
- Targets missed and `sample` shows the main thread busy with something else (GC, synchronous fs, frames):
  write option 2's design as its own document before any code.

## Risks

- **A stale environment in the worker**: handled by sending `env` with every call. A spec pins it.
- **Ordering**: no caller relies on two separate children finishing in order (each is its own process
  today too). tmux commands that must be ordered already share one `tmux` invocation or the control
  client, which stays on the main thread.
- **Memory**: one worker is a V8 isolate, about 5–10 MB RSS. Phase 3 measures it.
- **Lost children if the worker dies**: a probe's child outlives a dead worker until its own exit. They are
  short-lived (`ps`, `lsof`, `tmux` queries), and their timeouts are seconds.
- **Tests**: unit tests never turn the route on, so mocks behave as before; e2e runs it for real.

## Out of scope

- The terminal-specific improvements from the spike:
  - pane-hidden streams;
  - input frames bypassing the per-connection `chain` in `localWsServer.ts`;
  - an output-batch bypass right after a keystroke.

  They are smaller effects by the same measurements; revisit after Phase 3.
- GPU text rendering in the desktop's terminal (glyph atlas): paint is not the typing bottleneck.
- The search-path hold (`captureLaunchExecutable` holding forever on a dangling alias earlier in PATH,
  while the shell runs a valid engine later in it): a separate fix.

## Spawn inventory (after Phase 2)

| Call site | Runs | Thread | Why |
|---|---|---|---|
| `lib/patientExec.ts` users: `tmux.ts` (`run`), `tmuxCapture.ts`, `tmuxAgentDiscovery.ts`, `tmuxBackend.ts`, `tmuxVersion.ts` | timers (discovery, reconciler, titles, captures) and requests | worker | Phase 1 |
| `lib/processEnv.ts` `read` (`ps eww`) | discovery, gateway runtime, DSH | worker | Phase 2 |
| `lib/tmux.ts` `execText` (`lsof`) | process images, every discovery pass | worker | Phase 2 |
| `lib/nativeProcessImages.ts` (image helper) | every discovery pass | worker | Phase 2 |
| `engines/kit/launchExecutable.ts` `captureEnvironment` (login shell) | launches, held-launch passes | worker | Phase 2 |
| `lib/tmuxStream.ts` (`tmux -C attach`) | once per terminal stream | main | long-lived child: its stdin/stdout are the terminal |
| `lib/loginShellEnv.ts`, `lib/tmuxOnPath.ts` (login shells) | once at start | main | start-up only |
| engine panes, services, one-shots (`lib/oneshot.ts`), git, grid, installers | on a person's request | main | on demand, not periodic |

Measured on the e2e workload (`e2e/typingLatency.e2e.ts`, `TYPING_SAMPLE=1`): with the route on, `uv_spawn` is 0.0 % of
the core main thread's non-idle samples under CPU load and under load with flood, in all three runs (70–81 % and
29–31 % before). A `uv_spawn` frame covers `spawnSync` as well, so no periodic synchronous spawn remains on the main
thread for this workload either.

## Results (2026-10-15)

`e2e/typingLatency.e2e.ts`, three runs before (HEAD 65f648ac6) and three after, same 12-core Mac. Median of
the three runs; the host's own load average was 7–41 during them.

| Condition | Daemon p50 (ms) | Daemon p99 (ms) | Daemon max (ms) | Core loop delay p99 (ms) | tmux p99 for reference |
|---|---|---|---|---|---|
| idle | 0.60 → 0.57 | 3.9 → 7.8 | 10.7 → 12.5 | 14.0 → 11.9 | 1.7 → 0.9 |
| CPU load | 1.40 → 1.26 | 23.5 → 28.0 | 37.2 → 32.5 | 35.1 → 17.5 | 6.8 → 18.8 |
| flood | 1.12 → 1.11 | 49.4 → 41.3 | 56.5 → 58.4 | 23.9 → 18.6 | 1.6 → 4.4 |
| CPU load + flood | 4.14 → 4.22 | **222 → 122** | **344 → 135** | **74 → 33** | 18.9 → 23.0 |

- `uv_spawn` on the core's main thread, share of non-idle samples:
  - under CPU load: **70–81 % → 0 %**;
  - under load with flood: **29–31 % → 0 %**.
- On the owner's Mac (real agents, light load), 60 s `sample` of the core:
  - before (fix A only): 32 % of busy samples, 2,043 busy samples;
  - after: **2 %**, 1,156 busy samples. The rest is `tmux -C attach` at stream open.
- `e2e/perf.e2e.ts`, core process, one run per build:

  | | empty | populated, idle | active |
  |---|---|---|---|
  | CPU, base | 0.92 % | 2.87 % | 23.1 % |
  | CPU, change (2 runs) | 0.76, 0.81 % | 3.26, 3.06 % | 22.9, 25.0 % |
  | RSS, base | 72.0 MB | 88.1 MB | 103.4 MB |
  | RSS, change (2 runs) | 75.7, 77.8 MB | 104.4, 100.0 MB | 129.3, 116.1 MB |

  - CPU is within run-to-run noise.
  - RSS is up by 4–26 MB. The second run had the worker's heap capped with `resourceLimits`, but review
    showed the cap has no effect under the core's process-wide heap flags (`--max-old-space-size`), so the
    cap was removed. The two runs differ by run-to-run noise alone.
  - One base run is not enough to size the cost: it needs repeated runs before it is accepted or reduced.

Against the goal:

| Target | Met? | Result |
|---|---|---|
| CPU load: p99 ≤ 2× tmux, max < 100 ms | met | 28.0 ≤ 37.6; 32.5 |
| CPU load + flood: p99 < 60 ms | **missed** | 122 ms, halved |
| Idle: p50 ≤ 1 ms, p99 ≤ 5 ms | p50 met, p99 not | p99 sits between 3.6 and 8.8 in individual runs both before and after; the target was set from one quiet run |
| `uv_spawn` < 5 % | met | 0 % e2e, 2 % on the real Mac |
| CPU and RSS within 5 % | **RSS missed** | CPU met; RSS +4–26 MB, single runs |

**Decision.** Spawning is gone from the keystroke's thread, and the worst tail halved, but under load with
flood the core's main thread is still busy with other work. In the `sample`s that work is the flooding
panes' stream I/O (`uv__stream_io`), GC (incremental marking), and a JS `flatMap`. A keystroke still
queues behind that.

What remains is option 2 territory: either
- the terminal data plane in its own worker, or
- the cheaper items listed under "Out of scope": no output for hidden panes, and input frames off the
  per-connection chain.

Both need measurement first. Option 2 needs its own design document before any code. The RSS cost
(+4–26 MB in single runs) is the price of the worker. Measure it with repeated runs before the owner
decides whether it stands.
