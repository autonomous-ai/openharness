# Native Release interaction benchmark

Start with the [September 22 wrap-up and resume notes](../../../docs/performance/2026-09-22-wrap-up.md)
for the ready PRs, measured improvements, rejected experiments and remaining priorities.

## Core experiences and process resources

```sh
python3 tool/native_benchmark/prepare.py --flutter /path/to/flutter \
  --core-workflows --terminals 16 --samples 120 --hold
```

Open the printed isolated app through normal application controls. Use three
samples for calibration first, then 120 for reporting. `run-config.json` in the
printed temporary root selects `terminals`, `samples`, `hold`, and a fresh JSON
`output` filename. After quitting the fixture, edit that file and reopen the same
bundle to repeat without changing its compiled production code. Existing results
are never overwritten. `active-run.json` identifies the latest invocation. The core mode
supports 1, 16, or 48 retained terminals, with up to four visible and 1,000
seeded lines each. Set `seedLines: 10000` to exercise full scrollback buffers;
wrapping and the production buffer limit affect retained physical rows, whose
counts are recorded in the result. It visits every retained tab before measuring,
then repeats at idle and while every terminal receives an eight-row ANSI redraw
at 20 Hz. Actual bytes, duration, and skipped output bursts are retained.

It validates eleven common actions: text commit with a synthetic terminal echo;
Cmd+N; Cmd+O; picker query; picker selection followed by immediate input; Cmd+T;
tab change followed by input; pane focus followed by input; zoom; Find through a
completed index scan; and a page-sized scroll. Inapplicable navigation actions
are skipped with one terminal. Five warmups precede each series. Every input
commit must arrive exactly once in the focused terminal. Picker queries and Find
must produce the expected real results before their frame is accepted.

These are **framework dispatch to completed Flutter raster** measurements.
Text uses the attached `TextInputClient`; shortcuts use the normal framework
keyboard/focus dispatcher. Text echo passes through the production terminal
binary decoder and parser with zero simulated network delay. Navigation-plus-
input measurements include the navigation frame and the following verified echo
frame; they are not interchangeable with a shortcut's first-frame time. Scrolling
uses the terminal's scroll position controller and excludes native wheel-event
delivery. AppKit keyboard delivery, actual networking, model inference, GPU
presentation, and native titlebar paint completion remain outside this boundary.

The native host records loss of foreground focus; those runs fail rather than
mixing foreground and background timings. `.progress` identifies the current
invocation and last completed operation. Preserve failed runs for diagnosis and
use the result's fresh timestamps rather than accepting an old result file.
`--hold` leaves the idle fixture open after the workload for resource sampling:

```sh
xcrun swiftc tool/native_benchmark/process_usage.swift -o /private/tmp/harness-process-usage
/private/tmp/harness-process-usage PID 30 foreground-idle /private/tmp/usage-foreground.json
```

Use the PID in the completed result's metadata. Hide the fixture through the app's
normal controls and repeat with a new label/file for background idle. This sampler
reads `proc_pid_rusage` once per second: CPU deltas (100% means one core), physical
memory footprint, resident memory, interrupt/package-idle wakeups, and disk I/O.
It does not control windows. Its totals cover that process, excluding daemon,
agent processes, and GPU energy. The fixture has no real network connections, so
its background cost cannot establish that the connected product has zero timers
or zero wakeups. Record other app activity and host contention; these are real
workstation measurements, not results from an otherwise isolated machine.

To sample sustained redraw cost separately, set `holdOutput: true` with `hold`
in `run-config.json`. After the timing sweep the same 20 Hz workload continues;
`.resource-load` records achieved bytes and skipped bursts every ten seconds.
That diagnostic timer exists only for this active-output resource mode. Use a
fresh process with `holdOutput: false` for idle measurements.

For actual loopback/direct/TURN/relay terminal round trips, use the separate
[real terminal probe](../../../cli/scripts/benchmark-terminal-latency.md). Never
add independently measured p95 values and label the sum end-to-end latency.

Pool a published data directory with `python3 tool/native_benchmark/summarize_results.py
/path/to/data`. It computes nearest-rank percentiles from individual measured
observations and lists contributing files, excluding warmups. Failed runs must
be reviewed separately; it does not silently discard them.

## Framework-dispatch comparison and manual feature checks

The fixture supports three separate modes:

```sh
python3 tool/native_benchmark/prepare.py --flutter /path/to/flutter --flutter-dispatch
python3 tool/native_benchmark/prepare.py --flutter /path/to/flutter --primary-workflows
python3 tool/native_benchmark/prepare.py --flutter /path/to/flutter --interactive
```

Open the printed `BENCHMARK_APP` through normal application controls. These
copies embed only their own temporary fixture environment in the copied host.
The dispatch mode runs and exits automatically, writing `interactive.json` in
`BENCHMARK_ROOT`; the interactive mode remains open for manual checks. They
cannot be combined. Neither mode opens a real transport or uses saved sessions.

`--flutter-dispatch` measures Cmd+N/O/T/P/comma/slash/F, tab changes, pane focus,
and zoom in the macOS Release renderer. It calls the framework's keyboard-state
and focus dispatch stages, validates the resulting widget/state, and joins the
exact first frame and fully opened route frame to `FrameTiming`. Each operation
has five warmups and 40 measured observations. All observations are retained.
The fixture has 16 sessions, four visible panes and 1,000 scrollback rows per
session. It measures idle-terminal interactions only. Run baseline and edited
production sources with identical fixture tooling, sequentially, with builds
and other tests finished. Preserve every completed run.

This mode **excludes AppKit input delivery, physical keyboard latency, GPU
presentation, network latency and native titlebar paint completion**. A fully
opened frame includes any route fade; the first frame is reported separately.
The reported display maximum is metadata, not an asserted refresh rate.
The driver also records the preceding frame, dispatch offset from its vsync,
waiting time until the requested frame starts building, and build-start-to-raster
time. A preceding busy frame can change the input's position within a refresh
interval; inspect these components before attributing elapsed-time differences
to CPU work. Wall-clock phase timestamps are correlated using the engine's
paired monotonic and wall-clock raster-finish timestamps.

`--primary-workflows` runs only Cmd+N/O/T and tab switching, with five warmups
and 120 measured samples per action. It inserts a repeatable sequence of 0–20 ms
delays **before** the measured dispatch to spread input across refresh phases.
The requested delay is retained on every sample. This supplements the original
post-frame cadence; preserve and report both if they give different results.
The recorded preceding frame is the frame awaited before that optional delay.
Use manual mode for visual/interaction QA, not timing claims. See the
[September 22 results](../../../docs/performance/2026-09-22-desktop-latency.md).

For primary-workflow debug CPU comparisons at 16/48 retained terminals:

```sh
flutter test --no-pub test/benchmarks/primary_workflows_benchmark.dart --concurrency=1 --reporter expanded
```

The fixture exercises Cmd+N/O/T and workspace switching with synthetic metadata
replies and 1,000 scrollback rows per terminal. It checks the destination and
terminal input isolation for every action. Five warmups and a separate rebuild
instrumentation pass precede 40 timed samples per action. Optional
`HARNESS_PRIMARY_CPU_PROFILE=/private/tmp/primary` with `--enable-vmservice`
records profiles; `HARNESS_PRIMARY_OPERATION=cmd_t` restricts the action.
See the [primary-workflow results](../../../docs/performance/2026-09-22-primary-workflows.md)
for the isolated Cmd+O comparison, unchanged controls and rejected new-tab experiment.
The [pane-caching experiment](../../../docs/performance/2026-09-22-pane-workflows.md)
reports both input cadences and frame-phase diagnostics; less build work did not
translate into faster tab switching, so that production change was rejected.

## Original AppKit event-queue runner

The original path below has no accepted calibration in this performance pass.
Its Cmd+1…4 pane-focus workload also predates the current default keymap; it
must be updated and recalibrated before reporting native-event latency.

**Status, September 14, 2026:** the builder supports the current Harness name,
validates the copied product identity and verifies the resulting bundle. It
accepts both the current `ai.autonomous.harness` and legacy `.v2` source IDs.
Since the preview and installed app now share their ID, the runner also checks
bundle location: only the release identity in `/Applications` or the current
user's `Applications` folder is exempt. Development copies, legacy previews
and other benchmark processes still stop preflight. Initial native focus uses
the same Flutter controller as the production titlebar. Nine Python isolation
checks include the actual production config and this renamed-build regression. The [current accepted measurements](../../../docs/performance/2026-09-23-core-experiences.md)
use a separate framework-dispatch boundary.
Foreground/key-window guards remain intact; no p50/p95/p99 result has been accepted.

This macOS fixture measures AppKit-queued input through the production Swarm
screen, terminal session parser and Flutter renderer. It runs as **Harness
Benchmark**, in an isolated copy with its own bundle ID, synthetic transports,
blocked HTTP and temporary state. It never reads the user's saved Swarms or sends
input to an agent. The benchmark bridge is appended only to the copied native
host; it is absent from the production Runner and Harness bundle.

From `desktop/`, build with a compatible Flutter SDK and Xcode:

```sh
python3 tool/native_benchmark/prepare.py --flutter /path/to/flutter
```

Use the `BENCHMARK_APP` path printed by the build. Unlock the Mac, normally close
the workspace preview and finish other builds/tests first. A locked desktop
cannot supply the active/key window required for valid samples. Keep this fixture in the foreground during a run; it
exits on focus loss instead of reclaiming focus between observations. The runner
refuses to start alongside another preview or benchmark process and never quits
them. Its error names the exact bundle path. A development copy outside the
standard installation folders is not exempt just because it shares the installed
Harness app's name and bundle identifier.
The installed app may remain open; record other app activity and host load when
reporting timings. That is not a guarantee of an otherwise idle workstation.

Run preflight checks without launching an app:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tool/native_benchmark -p 'test_*.py' -v
```

```sh
python3 tool/native_benchmark/run.py \
  --app '/private/tmp/harness-native-benchmark-EXAMPLE/desktop/build/macos/Build/Products/Release/Harness Benchmark.app' \
  --terminals 16 --samples 120 \
  --output /private/tmp/harness-native-16.json
```

Repeat with `--terminals 48` and a fresh output path. Use `--samples 3` only for
calibration, not percentile claims. The fixture closes itself normally when it
finishes; reopen the workspace preview afterward. Launch through `run.py`, which uses Launch Services
and supplies the required environment. Opening the fixture without that
environment fails immediately.

## Workload and timing boundary

- A 1280 × 800 content area, four visible terminals, 16 or 48 retained sessions,
  and 1,000 initial scrollback rows each. Every Swarm is visited before warming.
- Typing posts `x` through AppKit and echoes it through the production binary
  output handler with zero simulated network RTT. The exact destination session
  and input count are checked. Focus uses Cmd+1…4; tabs use Cmd+Shift+].
- One cold interaction per operation, then 20 warmups and the requested measured
  observations for each operation, both idle and with output to every terminal
  at 20 Hz. Each burst repaints eight rows with ANSI cursor save/restore. Reported
  byte counts, phase duration and skipped bursts expose the achieved output load.
- Input is posted only to this fixture's own `NSApplication` queue and window.
  Both aggregate and device-side modifier flags, with press/release events, match
  AppKit's keyboard representation. Initial content focus is established once;
  subsequent navigation must perform its own focus handoff.
- The first post-frame callback after the expected state/output change captures
  the engine's frame number. It joins that exact ID to `FrameTiming`, including
  its wall-clock raster-finish timestamp. Results retain every sample, including
  warmup and cold observations, and summarize p50/p95/p99/max in milliseconds.
- The fixture uses the real layout file store in a fresh temporary directory.
  Normal discovery, networking, telemetry and background services are disabled.

**These are native event-queue-to-Flutter-raster timings**, not physical
keyboard-to-photon measurements. They exclude device scanning, real transport
and agent response time, GPU/display presentation, and the completion of separate
AppKit titlebar drawing. The configured display maximum is recorded; it does not
establish a fixed refresh rate. This does not measure app startup, IME, paste,
scrolling, reconnect, or every output pattern. Preserve slower runs and report
the machine, build revision, host load and sampling limits with results.
