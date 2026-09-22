# Tab-switch pane caching experiment — September 22, 2026

[PR #232](https://github.com/autonomous-ai/openharness/pull/232) is rejected. Retaining outgoing terminal pane controls reduced widget rebuilds and Flutter build time, but neither Release sampling cadence demonstrated faster tab switching. The accepted production changes do not include this experiment.

Baseline production source: `d4eeec74c2a403c5af6fff37bb793c2683771bf0`. Experimental source: `1a2d89d9aea6b23e12cab07492d17d423add0bba`. The copied Release sources were compared byte-for-byte: only `lib/widgets/pane_grid.dart` differs. Both copies use identical drivers within each comparison. No Cmd+O or welcome-page caching change is included.

## What changed

The experiment retained the outgoing terminal pane's controls while updating rendering, focus and ticker visibility through an inherited scope. Revealing a pane refreshed its controls and metadata; replacing a hidden session still updated its mounted terminal. Shared, web and setup panes kept the original path.

With 16 retained terminals, debug tab-switch rebuilds fell from 1,303 to 979; with 48, from 1,367 to 1,043 (24–25%). Debug medians were 43.225 → 36.857 ms and 32.811 → 30.374 ms respectively. These single debug runs include framework/JIT overhead and substantial variation. The 48-terminal p95 increased from 36.644 to 37.009 ms. Raw observations: [baseline](2026-09-22-pane-data/debug-baseline.json), [experiment](2026-09-22-pane-data/debug-after.json).

## Release results

Host: Apple M2 Max, 64 GiB, macOS 26.6.2, Flutter 3.47.2 / Dart 3.13.2. The fixture has 16 synthetic sessions, four visible panes, 1,000 scrollback rows per session and a 1280 × 800 content area at 2× scale. The display reports a 120 Hz maximum. Other user apps remained running; our builds and tests completed before timing. Runs alternate baseline and experiment.

The timing boundary is framework keyboard dispatch to the exact Flutter raster-completion frame for the requested state. It excludes OS input delivery, physical display presentation, native titlebar paint completion, network and agent response time. Every action verifies its destination. Cmd+T additionally verifies new-tab creation and closing/restoration before the next sample.

The initial cadence dispatches immediately after an awaited frame. Three runs per revision provide 120 measured samples per action, plus five warmups per run. Driver: `37cd801cf6b99f9e52184869fbdc895d5b6234d8`.

| Action | Baseline median | Experiment median | Baseline p95 | Experiment p95 |
|---|---:|---:|---:|---:|
| Cmd+N | 13.596 ms | 13.554 ms | 17.361 ms | 17.251 ms |
| Cmd+O | 16.221 ms | 16.298 ms | 19.049 ms | 20.633 ms |
| Cmd+T | 12.707 ms | 13.122 ms | 19.427 ms | 18.210 ms |
| Next workspace tab | 19.730 ms | 22.271 ms | 27.826 ms | 26.089 ms |

Tab-switch median build time decreased 8.794 → 8.251 ms, while median dispatch-to-raster time increased 12.9%. All ten measured operations, including slower controls, remain in the [initial comparison](2026-09-22-pane-data/release-initial-comparison.json).

Two additional diagnostic runs used driver `0f4ab589c621f8f78306fe2c5677e5a212bf75b3` with the same cadence. They split elapsed time into waiting for frame construction and build-start-to-raster time, using the engine's paired monotonic and wall-clock raster-finish timestamps. The baseline and experiment dispatched at different positions relative to the preceding frame. This showed that scheduling contributes to the elapsed-time difference; it did not establish a latency benefit.

The final comparison used repeatable 0–20 ms delays before dispatch to vary input timing across refresh phases. Delays are excluded from the measured interval and retained in each observation. Driver: `09b138a13beb042f3f4af53f8cb7756a9cdca6b1`. Three runs per revision provide **360 measured samples per action**, plus five warmups per run.

| Action | Baseline median | Experiment median | Baseline p95 | Experiment p95 |
|---|---:|---:|---:|---:|
| Cmd+N | 11.582 ms | 11.674 ms | 19.814 ms | 19.580 ms |
| Cmd+O | 12.846 ms | 13.002 ms | 16.759 ms | 16.605 ms |
| Cmd+T | 11.762 ms | 11.702 ms | 16.807 ms | 16.833 ms |
| Next workspace tab | 19.456 ms | 20.775 ms | 24.828 ms | 25.477 ms |

Tab-switch median build time decreased **6.1%**, from 8.853 to 8.317 ms, but dispatch-to-raster median increased **6.8%** and p95 increased **2.6%**. Build-start-to-raster medians were nearly unchanged (12.636 → 12.521 ms). Cmd+T did not establish an elapsed-time improvement either. Reduced build work alone does not justify this additional lifecycle complexity. The two cadences are reported separately and are never pooled together.

Raw observations and source/run order are in the [manifest](2026-09-22-pane-data/manifest.json). The [varied-input comparison](2026-09-22-pane-data/release-sweep-comparison.json) retains dispatch, frame-wait, build, raster and elapsed quantiles for every action. All **6,600 observations across 14 completed runs** are preserved; no completed run or slow sample was discarded. Quantiles use the sorted sample at `ceil(n * percentile) - 1`.

## Verification and reproduction

The experiment passed 93 focused tests covering pane visibility, workspace interactions, focus/input routing, terminal rendering suspension, tail following, offline output, layouts/reordering, shortcuts, web panes and shared harnesses. Its regression verifies that outgoing controls do not rebuild, hidden terminals stop rendering, input reaches the newly selected pane and renamed metadata/output appear on return. Changed-file analysis and Release builds passed.

The improved measurement tooling is retained in [PR #222](https://github.com/autonomous-ai/openharness/pull/222). Nine bundle-isolation tests and CLI mutual-exclusion checks passed. All native runs completed their expected-state checks. Every diagnostic observation satisfies `firstRasterMicros == waitForBuildMicros + buildStartToRasterMicros`; every varied-input observation uses the prescribed delay sequence. Stored pooled quantiles were recomputed from raw observations.

From `desktop/`, apply the same benchmark tooling to both production revisions and finish builds/tests before timing:

```sh
flutter test --no-pub test/benchmarks/primary_workflows_benchmark.dart --concurrency=1 --reporter expanded
python3 tool/native_benchmark/prepare.py --flutter /path/to/flutter --flutter-dispatch
python3 tool/native_benchmark/prepare.py --flutter /path/to/flutter --primary-workflows
```

Each prepare command creates a separate isolated fixture. Open its printed app through normal application controls; it writes `interactive.json` and exits. Preserve every result before relaunching. Use `--interactive` for manual QA. See the [benchmark README](../../desktop/tool/native_benchmark/README.md) and the [accepted Cmd+O comparison](2026-09-22-primary-workflows.md).
