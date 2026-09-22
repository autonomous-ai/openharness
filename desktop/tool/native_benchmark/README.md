# Native Release interaction benchmark

## Framework-dispatch comparison and manual feature checks

The September 22 performance pass adds two separate modes:

```sh
python3 tool/native_benchmark/prepare.py --flutter /path/to/flutter --flutter-dispatch
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
checks include the actual production config and this renamed-build regression. See the
[handoff](../../../docs/harness-v2-handoff.md) and
[failed calibration notes](../../../docs/harness-v2-performance.md#native-calibration-remains-unmeasured-2026-09-13).
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
