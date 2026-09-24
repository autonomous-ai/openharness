# Primary workflow responsiveness — September 22, 2026

This follow-up prioritizes Cmd+N, Cmd+O, Cmd+T and switching workspaces. The accepted production change is [Cmd+O PR #226](https://github.com/autonomous-ai/openharness/pull/226): retain one extra result row beyond the picker viewport instead of the default 250-pixel scroll cache. This reduces offscreen construction while preserving Tab traversal. It is independent of the earlier search and animation PRs.

Baseline: `d4eeec74c2a403c5af6fff37bb793c2683771bf0`. Accepted source: `2644030ab46accf6a1606f394da5831dd60ddab7`. The Release copies were checked byte-for-byte: the accepted copy differs from baseline only in `lib/widgets/swarm_switcher.dart`. Both use the same benchmark driver from `37cd801cf6b99f9e52184869fbdc895d5b6234d8`. No welcome-page retention or action-map cache is included.

## Cmd+O results

The debug fixture measures production shortcuts and widgets with synthetic metadata, four visible panes and 1,000 scrollback rows per terminal. Five warmups and a separate rebuild-counting pass precede 40 timed samples per action. Timings include debug framework/JIT overhead; they are not native display latency.

| Retained terminals / discovered agents | Baseline median | Picker median | Baseline p95 | Picker p95 | Baseline rebuilds | Picker rebuilds |
|---|---:|---:|---:|---:|---:|---:|
| 16 / 70 | 31.626 ms | 22.872 ms | 49.999 ms | 31.309 ms | 1,413 | 909 |
| 48 / 2,000 | 26.623 ms | 18.525 ms | 29.755 ms | 21.380 ms | 1,477 | 973 |

Cmd+O debug elapsed time fell 28–30%, with 34–36% fewer rebuilt widgets. These results use the final one-row cache; an earlier zero-cache experiment was discarded because offscreen Tab traversal needs a neighboring mounted row. Cmd+N/T and tab-switch measurements are also preserved in the [baseline](2026-09-22-primary-data/debug-baseline.json) and [accepted](2026-09-22-primary-data/debug-open-picker.json) observations. Their code is unchanged by #226; timing variation in those controls is not claimed as an improvement.

## Native Release comparison

Host: Apple M2 Max, 64 GiB RAM, macOS 26.6.2, arm64; Flutter 3.47.2 / Dart 3.13.2. The isolated fixture has 16 synthetic sessions, four visible panes, a 16-agent catalog, and a 1280 × 800 content area at 2× scale. The display reports a 120 Hz maximum. Other user applications remained running; our builds and tests finished before the serial timed runs.

The boundary is framework keyboard dispatch to the exact Flutter raster-completion frame for the requested state. It excludes OS input delivery, physical display presentation, native titlebar paint, real transport and agent response time. Cmd+T verifies that a new empty tab and welcome view appear; Cmd+W must remove it and restore the previous workspace before the next sample. Every other operation also checks its expected widget/state.

Three complete runs per revision, pooled: **120 measured samples per action**, plus five warmups per run. Each run contains 450 observations across ten operations. No completed run or slow observation was dropped. Quantiles use the sorted sample at `ceil(n * percentile) - 1`, matching the driver. The third baseline/picker pair was added after unchanged controls varied in the first two comparisons.

| Action | Baseline median | Picker median | Baseline p95 | Picker p95 |
|---|---:|---:|---:|---:|
| Cmd+N — New Harness | 13.593 ms | 13.834 ms | 16.067 ms | 16.746 ms |
| Cmd+O — Open Harness | 16.332 ms | 15.675 ms | 20.043 ms | 16.463 ms |
| Cmd+T — New tab | 11.711 ms | 12.190 ms | 16.673 ms | 18.348 ms |
| Next workspace tab | 19.331 ms | 19.556 ms | 26.742 ms | 26.827 ms |

Cmd+O median fell **4.0%**, p95 **17.9%** and median Flutter build time **15.3%** (4.603 → 3.900 ms). The build-time reduction and lower debug rebuild count support the targeted reduction in work. This is a local synthetic benchmark, not a guarantee of the same percentage on every machine.

The controls do not establish a Cmd+N, Cmd+T or tab-switch speedup. Cmd+T median/p95 are worse in the pooled accepted runs and are reported above. The unchanged baseline itself moved from 10.843/11.498 ms Cmd+T medians in its first two runs to 13.425 ms in its third; tab switching moved from 18.954/18.503 to 21.071 ms. These variations prevent attributing every timing difference to the picker change.

All three Cmd+O run pairs are retained:

| Run | Baseline median / p95 | Picker median / p95 |
|---|---:|---:|
| 1 | 15.763 / 20.043 ms | 15.414 / 16.057 ms |
| 2 | 17.051 / 20.552 ms | 15.869 / 16.707 ms |
| 3 | 16.267 / 18.380 ms | 15.540 / 16.045 ms |

Raw data: baseline [1](2026-09-22-primary-data/native-primary-baseline-1.json), [2](2026-09-22-primary-data/native-primary-baseline-2.json), [3](2026-09-22-primary-data/native-primary-baseline-3.json); picker [1](2026-09-22-primary-data/native-open-picker-1.json), [2](2026-09-22-primary-data/native-open-picker-2.json), [3](2026-09-22-primary-data/native-open-picker-3.json); [all-operation pooled comparison](2026-09-22-primary-data/native-open-picker-comparison.json). The [manifest](2026-09-22-primary-data/manifest.json) records source revisions and run order.

## Rejected new-tab experiment

[PR #224](https://github.com/autonomous-ai/openharness/pull/224) retained the previously visited welcome page offstage and cached action maps. Debug results looked promising, but the initial Release comparison did not justify keeping the added lifecycle complexity: with #224 and #226 together, Cmd+T median was 11.214 → 12.164 ms and tab switching 18.771 → 21.126 ms across 80 measured samples per action. The PR was closed and its production changes removed from the accepted build.

The later baseline control run also slowed, so these observations alone do not prove that welcome retention caused the entire regression. They do establish that a repeatable primary-workflow improvement was not demonstrated. The rejected measurements remain separate: [debug](2026-09-22-primary-data/debug-rejected-new-tab.json), Release [1](2026-09-22-primary-data/rejected-new-tab-after-1.json), [2](2026-09-22-primary-data/rejected-new-tab-after-2.json), and [initial comparison](2026-09-22-primary-data/rejected-new-tab-comparison.json). Its debug run used #224 alone; its Release runs included the picker change too.

## Verification and reproduction

The picker PR passed 63 focused search, rendering, preview, identity and keymap tests. The new regression checks initial row construction and Tab traversal through more than 15 distinct results beyond the initial viewport, including focused-row visibility and selection consistency. After the typed `ScrollCacheExtent` import was finalized, that regression passed again and changed-file analysis was clean. The primary workflow debug benchmark passed both workloads against baseline and the accepted change. Both isolated Release builds succeeded, and every sample in all eight native runs passed its expected-state checks. The settled appearance is unchanged.

From `desktop/`, use the same SDK and finish builds/tests before recording timings:

```sh
flutter test --no-pub test/benchmarks/primary_workflows_benchmark.dart --concurrency=1 --reporter expanded
flutter test --no-pub test/open_picker_rendering_test.dart --concurrency=1 --reporter expanded
python3 tool/native_benchmark/prepare.py --flutter /path/to/flutter --flutter-dispatch
```

The picker regression lives in #226 and the measurement tooling in #222. Open the printed temporary benchmark app through normal application controls; it writes `interactive.json` and exits. Preserve that file before each subsequent launch. Use identical fixture/driver sources on both production revisions. See the [benchmark README](../../desktop/tool/native_benchmark/README.md) for optional profiling and manual interaction mode.
