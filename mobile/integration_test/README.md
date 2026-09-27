# Phone performance benchmark

`perf_test.dart` measures the phone app on a real phone, in a profile build,
with production widgets: `TerminalPage`, Find (`TerminalSearchOverlay`), the
mic orb, and the new-agent form. The account is synthetic — one machine, eight
agents, two attached terminals — and its terminals are fed Claude Code-shaped
output through the production binary path (`TerminalSession.handleBinary`:
zlib when the daemon would compress, UTF-8, the xterm parse). Nothing in it can
reach a real machine: no config or layout store, an in-memory auth session, and
a machine connection that never dials.

The method is the desktop benchmark's
([`desktop/tool/native_benchmark/README.md`](../../desktop/tool/native_benchmark/README.md)):
**framework dispatch → raster finish of the first frame that shows the verified
result**, joined to the engine's `FrameTiming` by frame number; five warmups;
every measured observation kept; nearest-rank percentiles. Touches are
delivered as device pointer events into the framework's hit test and dispatch —
not as test events, which the live test binding paints a crosshair for.

The results and what they exclude are in
[`docs/performance/2026-09-26-mobile-baseline.md`](../../docs/performance/2026-09-26-mobile-baseline.md).

## Run it

The phone must be connected, unlocked and signed for development. Build the
benchmark app first — building takes about a minute, and a phone left alone
that long can auto-lock before the app is up to keep it awake — then drive the
prebuilt app. From `mobile/`:

```sh
flutter build ios --profile --target=integration_test/perf_test.dart

flutter drive --profile --no-dds --keep-app-running \
  --use-application-binary=build/ios/iphoneos/Runner.app \
  --driver=test_driver/perf_driver.dart \
  --target=integration_test/perf_test.dart \
  -d <device id>
```

- `--profile` — timings from a debug build mean nothing.
- `--no-dds` — the in-app timeline trace connects to the VM service itself,
  which DDS would otherwise hold exclusively.
- `--keep-app-running` — **always.** Without it `flutter drive` UNINSTALLS the
  app when it finishes (`drive_service.dart`, `stop()`), and deleting the last
  app from a free developer team makes iOS drop the phone's trust in it. The
  benchmark is installed under the app's own development bundle id, so it
  replaces the development build on the phone; reinstall that afterwards.
- `--dart-define`s (below) go on the `flutter build` line: the prebuilt binary
  carries them.

(`flutter drive` without `--use-application-binary` builds and runs in one go;
it measures the same thing, it just leaves the phone idle for the build.)

The run takes about six minutes, most of it the 40 taps, swipes and switches per
interaction. The app keeps the screen awake while it runs, and ignores real
touches: only the benchmark's own events reach it, so picking the phone up
cannot add frames — but locking it or switching apps ends the run. The results
are written by the driver to
`../docs/performance/2026-09-26-mobile-data/baseline-<UTC time>.json`; an
earlier file is never overwritten. A run with a failed scenario goes to
`failed/` under the same directory, kept for review and never pooled.

### Measuring the redesign ("after")

Same commands, labelled and into their own directory, so the two can be
compared side by side with identical fixture code:

```sh
flutter build ios --profile --target=integration_test/perf_test.dart

HARNESS_PERF_LABEL=after \
HARNESS_PERF_OUT=../docs/performance/<date>-mobile-after-data \
flutter drive --profile --no-dds --keep-app-running \
  --use-application-binary=build/ios/iphoneos/Runner.app \
  --driver=test_driver/perf_driver.dart \
  --target=integration_test/perf_test.dart \
  -d <device id>
```

If the redesign renames what the benchmark taps or waits for — the
`terminal-find` key, `TerminalSearchOverlay`, `VoiceMicButton`'s face,
`NewAgentPage`, `FindRow` — update `perf/scenarios.dart` in the same
change and say so in the report: the boundary of each scenario must stay the
same for the numbers to compare. `test/perf_fixture_test.dart` runs the
fixture's assumptions on every `flutter test`, so a rename shows up there
first.

### Options

Passed as `--dart-define`s:

| Define | Default | |
|---|---|---|
| `PERF_SCENARIOS` | all | Comma-separated name prefixes: `idle`, `stream_redraw`, `stream_append`, `scroll_read`, `find_open_tap`, `find_open_swipe`, `mic_tap`, `new_open_swipe`, `find_switch`, `trace_`, `control_panel_redraw`. |
| `PERF_SAMPLES` | 35 | Measured observations per interaction. |
| `PERF_WARMUPS` | 5 | Warmups before them, kept in the file, excluded from percentiles. |
| `PERF_STREAM_SECONDS` | 10 | Length of each streaming window, after a 2 s warmup. |
| `PERF_TRACE` | true | Also record timeline passes (per-widget build/layout/paint events on) and rank their costliest events. |

Use small values only to check the harness; report only full runs.

`HARNESS_PERF_DEVICE` (optional) is copied into the result's `host` block — a
model name, for instance. Nothing from the host machine other than the git
revision and the Flutter version is recorded.

## Summarize

```sh
python3 scripts/perf_summarize.py ../docs/performance/2026-09-26-mobile-data
python3 scripts/perf_summarize.py <dir> --label after
```

It pools every measured observation and every frame across the runs in the
directory, then takes percentiles — it never averages percentiles — and prints
markdown tables, plus each run's timeline rankings.

## Files

- `perf_test.dart` — entry point; one test that runs the suite.
- `perf/perf_binding.dart` — the integration-test binding, drawing only frames
  the framework asked for (the live binding otherwise renders every vsync).
- `perf/scenarios.dart` — the scenarios and their verification.
- `perf/fixture.dart` — the synthetic account, terminals and the home host.
- `perf/claude_output.dart` — Claude Code-shaped ANSI output.
- `perf/stream.dart` — the 20 Hz producer.
- `perf/frames.dart` — frame numbers, `FrameTiming`, percentiles.
- `perf/gestures.dart` — device-sourced touches; real ones are ignored.
- `perf/timeline.dart` — self/inclusive time ranking of a VM timeline.
- `../test_driver/perf_driver.dart` — host side; writes the result file.
- `../scripts/perf_summarize.py` — the summarizer.
- `../test/perf_fixture_test.dart` — the fixture's assumptions, and that an
  idle terminal page asks for no frames, on every `flutter test`.
