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

## Claude Code's fullscreen scroll

`claude_scroll_test.dart` measures one thing against what a native list does:
the rows that scroll move as far as the finger every frame, and stop when it
does. The production `TerminalView`, set up for Claude Code as `TerminalPanel`
sets it up (the `RemoteScrollMirror`, page keys, `RemoteScrollPhysics`), in a
profile build, touched through the device's own dispatch (`perf/gestures.dart`).
Per scenario — the first drag on a freshly opened terminal, slow reading drags,
flicks up after reading, flicks on into rows nobody fetched, flicks back down —
it reports how far the content went against the finger (`rowsBehind`), frame by
frame (`errorRows*`), frames it stood still under a moving finger
(`stalledFrames`), lurches past it (`jumpFrames`), movement after the finger and
its fling stopped (`rowsAfterStop`), when the mirror first drew
(`firstMirrorFrameMs`), and the engine's frame timings.

Behind the terminal is Claude Code 2.1.309's fullscreen renderer faked in the
app (`claude_scroll/program.dart`: wheel acceleration, a dropped wheel after a
turn, Page Up/Down by half the transcript, a pinned prompt and "Jump to bottom"
line, its layout under the transcript), across a link of
`CLAUDE_FAKE_ONE_WAY_MS` each way (30) with a redraw of `CLAUDE_FAKE_DRAW_MS`
(40). The same every run, so two builds compare.

```sh
flutter build ios --profile --target=integration_test/claude_scroll_test.dart

HARNESS_SCROLL_LABEL=after \
flutter drive --profile --no-dds --keep-app-running \
  --use-application-binary=build/ios/iphoneos/Runner.app \
  --driver=test_driver/claude_scroll_driver.dart \
  --target=integration_test/claude_scroll_test.dart \
  -d <device id>
```

Results go to `build/claude_scroll/<label>-<UTC time>.json` with every frame's
sample and the mirror's trace; the driver prints the per-scenario medians.
`CLAUDE_SCROLL_ROUNDS` (3) and `CLAUDE_SCROLL_SCENARIOS` (name prefixes) are
`--dart-define`s on the build line. Like the benchmark above it replaces the
app on the phone: reinstall the development build afterwards.

`claude_scroll_app_test.dart` measures the same in the REAL app, end to
end: it starts the app as a tap on its icon would, with the phone's own
sign-in, opens one of the owner's own Claude Code agents over the real link,
takes its terminal as "Take control" does, puts the keyboard away, and runs
the same scenarios. `CLAUDE_AGENT_NAME` is a comma-separated list of agent
names tried in turn: the first with 300 rows above its screen once it has
fetched ahead is measured, else the one with most. The phone must already be
signed in. Opening an agent takes its pane at the phone's size, as opening it
by hand does, and the scroll sends it wheel events and Page Up/Down — nothing
is typed; pick agents that are idle.

```sh
flutter build ios --profile --target=integration_test/claude_scroll_app_test.dart \
  --dart-define=CLAUDE_AGENT_NAME="T- 300,Testing with Claude Code"
HARNESS_SCROLL_LABEL=app flutter drive --profile --no-dds --keep-app-running \
  --use-application-binary=build/ios/iphoneos/Runner.app \
  --driver=test_driver/claude_scroll_driver.dart \
  --target=integration_test/claude_scroll_app_test.dart -d <device id>
```

With a real program the newest row is not known: frames past it count as
stalled in `flick_down`. The oldest is, once a page up has gone nowhere.

What these measured before and after the mirror's rework, on an iPhone 14 and
a Galaxy S23, over Wi-Fi and 4G: `claude_scroll/RESULTS.md`.

⚠️ **On Android, always `--keep-app-running` and a prebuilt APK.** `flutter
drive` uninstalls the app when it finishes, and on the first build — no APK yet
— it takes the package from the source manifest: it uninstalled a Play-installed
Harness that way (2026-10-24). A local build cannot replace the Play install
(Play re-signs it with Google's key); to run beside it, build with
`--android-project-arg=harnessIdSuffix=.bench` and check the package with
`aapt2 dump badging` before installing. A copy beside the Play one has its own
sign-in.

`CLAUDE_SCROLL_PROGRAM=live` puts the real Claude Code behind it instead: the
phone listens on `CLAUDE_BRIDGE_PORT` (8765) and prints its addresses, and
`claude_scroll/claude_bridge.py` on a Mac connects to it, runs
`claude --resume <session>` in a pseudo terminal at the phone's grid and holds
every byte `CLAUDE_BRIDGE_DELAY_MS` each way. Nothing on the Mac listens, and the
bridge passes only wheel reports and Page Up/Down to Claude Code. Resume a
session no agent is using, in a folder Claude Code already trusts.

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
- `claude_scroll_test.dart`, `claude_scroll_app_test.dart`, `claude_scroll/`
  and `../test_driver/claude_scroll_driver.dart` — Claude Code's fullscreen
  scroll, above; `claude_scroll/RESULTS.md` — its results.
