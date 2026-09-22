# Desktop responsiveness — September 22, 2026

Baseline: `d4eeec74c2a403c5af6fff37bb793c2683771bf0`. Comparison: the combined production changes in [search rendering PR #219](https://github.com/autonomous-ai/openharness/pull/219) (`04cc6079d73967d519f4cdfda24bedbe8f96b01a`), [dialogs and shortcuts PR #220](https://github.com/autonomous-ai/openharness/pull/220) (`10e15951a84584113b12bec31ed1a5d9ab2826d3`), and [smaller UI fixes PR #221](https://github.com/autonomous-ai/openharness/pull/221) (`2f5e21f301bb9cb75945cd8891700cfec6bfa021`). The benchmark/tooling PR changes no production behavior; the final results below measure the three production PRs together, not each PR individually. Baseline production Dart files were checked byte-for-byte against that commit; the same benchmark driver and fixture configuration were used in both release builds.

Host: Apple M2 Max, 64 GiB RAM, macOS 26.6.2, arm64; Flutter 3.47.2 / Dart 3.13.2. The native fixture used a 1280 × 800 content area at 2× scale. The display reported a 120 Hz maximum; this is not a fixed-refresh or keyboard-to-photon measurement. Other user applications remained running. Timed comparisons ran sequentially after our builds and regression tests finished.

## Changes

- Reuse unchanged prompt-context widget trees and measured text widths; replace a non-scrolling scroll view with simple clipped overflow. Cache invalidation includes content, search matches, preferences, font/style, palette, width and text scaling.
- Build shortcut-browser rows only around the viewport, while preserving responsive columns, live binding search, keyboard paging, and shortcut practice.
- Avoid constructing temporary sets for every search row when checking whether an agent/group can be added.
- Open shared dialogs and the task palette without fades or live-terminal backdrop blur. Selection, hover, pane controls, sidebar/content changes and meters use immediate feedback. Store examples and images appear without entrance fades; review links jump directly into view.
- Stop decorative skeleton/status pulses and login illustration/background loops. Busy controls retain useful progress feedback, respect Reduce Motion, and stop rotating immediately when work finishes.
- Restore an accessibility tap action on New Harness defaults, found while exercising the native fixture.

Remaining timed behavior was reviewed: tooltips and hover text reveal retain intentional dwell; terminal previews retain their 140 ms attachment debounce; task-send receipts remain readable for 750 ms; actual I/O progress, retries and coalescing are unchanged. The unused legacy relay illustration and explicitly requested Store animation preview still support animation. Neither runs in the normal workspace/Store path.

## Measurement boundaries

The release fixture checks that each requested surface/state actually appears, tracks its exact Flutter frame number, and records keyboard dispatch, first raster completion, and fully opened route raster completion. It exercises the production keymap and widgets, with synthetic sessions and blocked networking. It excludes OS input delivery, native titlebar drawing completion, presentation to the display, and real transport/agent latency. There are five warmups and 40 measured samples per operation; raw samples include warmups and outliers.

Headless widget timings below are debug CPU/event-loop elapsed times. They include debug framework overhead and are useful for before/after comparison, not native latency claims. The large-catalog workload has 2,000 or 10,000 agents. The tab workload retains 16/48 terminals with 1,000 scrollback rows each. Baseline, interim and final results are retained in [the data directory](2026-09-22-data/).

Native input automation did not deliver Command modifiers reliably to this fixture. Those manual-key traces were rejected. The original AppKit benchmark also uses an outdated pane-focus binding; it is not used for any performance claim here. The separate validated framework-dispatch mode makes the measured boundary explicit.

## Results

### Native Release: framework dispatch to fully opened raster

Two complete runs per revision, pooled: 80 measured samples per operation. Milliseconds; lower is better. Every operation passed its expected-widget/state check.

| Action | Baseline median | Final median | Baseline p95 | Final p95 |
|---|---:|---:|---:|---:|
| Cmd+N — New Harness | 13.49 | 13.37 | 14.56 | 18.49 |
| Cmd+O — Open Harness | 15.67 | 16.05 | 18.35 | 19.70 |
| Cmd+P — command picker | 14.68 | 14.85 | 15.24 | 15.22 |
| Cmd+, — Settings | 12.20 | 12.33 | 13.09 | 13.05 |
| Cmd+/ — shortcut browser | 153.28 | 18.99 | 154.52 | 22.52 |
| Cmd+F — terminal Find | 12.50 | 12.68 | 18.27 | 15.93 |
| Next tab | 17.75 | 17.44 | 24.15 | 24.15 |
| Pane focus | 11.37 | 11.29 | 17.18 | 17.72 |
| Pane zoom | 14.76 | 14.56 | 17.20 | 17.17 |

**Shortcut-browser full visibility improved by 87.6% (153.28 → 18.99 ms).** Removing the fade accounts for most of this. Lazy row rendering also reduces initial layout work: the first optimized run before virtualization took 14.70 ms median build time; the final two-run median is 7.38 ms. Baseline first-frame raster was 24.43 ms; final first-frame raster is 18.99 ms.

The small 16-session fixture shows no consistent native median improvement in Cmd+N/O/P, Settings, Find, tabs, focus or zoom. Most remain around 11–17 ms to Flutter raster completion. Cmd+O median and Cmd+N p95 were slightly worse in the pooled comparison; these are retained, not excluded. The larger debug catalog benchmark below is a different workload and must not be substituted for native key-to-display latency.

Raw results: [baseline 1](2026-09-22-data/release-baseline-1.json), [baseline 2](2026-09-22-data/release-baseline-2.json), [interim](2026-09-22-data/release-interim.json), [final 1](2026-09-22-data/release-after-1.json), [final 2](2026-09-22-data/release-after-2.json), [pooled comparison](2026-09-22-data/release-comparison.json).

### Debug CPU/event-loop comparison

One final isolated run against the initial baseline run; milliseconds. Common actions use five warmups/40 samples, catalog interactions eight warmups/50 samples, and tab/focus cases 60 samples. Debug measurements are affected by JIT, GC and host scheduling.

| Workload | Baseline median | Final median | Median reduction | Baseline p95 | Final p95 |
|---|---:|---:|---:|---:|---:|
| Cmd+N (mixed-agent fixture) | 12.79 | 9.39 | 26.6% | 17.13 | 10.97 |
| Cmd+O (mixed-agent fixture) | 27.83 | 26.48 | 4.9% | 45.76 | 31.67 |
| Cmd+P (mixed-agent fixture) | 24.88 | 23.52 | 5.5% | 28.86 | 106.66 |
| Settings (mixed-agent fixture) | 36.12 | 28.84 | 20.1% | 116.32 | 76.99 |
| Shortcut browser (mixed-agent fixture) | 51.96 | 31.17 | 40.0% | 149.90 | 38.60 |
| Open picker — 2,000 agents | 56.77 | 40.86 | 28.0% | 206.01 | 82.64 |
| Broad query — 2,000 agents | 44.49 | 34.52 | 22.4% | 98.92 | 41.16 |
| Extend query — 2,000 agents | 18.46 | 10.15 | 45.0% | 50.78 | 13.39 |
| Narrow query — 2,000 agents | 41.44 | 31.22 | 24.7% | 97.84 | 84.26 |
| Move selection — 2,000 agents | 9.16 | 7.59 | 17.1% | 12.03 | 14.01 |
| Open picker — 10,000 agents | 47.77 | 37.67 | 21.1% | 166.38 | 128.85 |
| Broad query — 10,000 agents | 52.76 | 36.55 | 30.7% | 58.86 | 41.06 |
| Extend query — 10,000 agents | 29.84 | 19.48 | 34.7% | 64.18 | 25.05 |
| Narrow query — 10,000 agents | 46.01 | 35.60 | 22.6% | 174.34 | 44.89 |
| Move selection — 10,000 agents | 7.73 | 6.36 | 17.7% | 10.18 | 8.61 |
| Tab switch — 16 retained terminals (native bridge stub) | 19.72 | 13.81 | 30.0% | 22.71 | 16.75 |
| Pane focus — 16 retained terminals (native bridge stub) | 10.04 | 7.85 | 21.8% | 12.09 | 9.31 |
| Tab switch — 48 retained terminals (native bridge stub) | 19.83 | 15.98 | 19.4% | 21.17 | 17.21 |
| Pane focus — 48 retained terminals (native bridge stub) | 11.82 | 8.07 | 31.7% | 44.87 | 10.12 |

The clear repeated catalog gain is query extension: **45.0% faster at 2,000 agents** and **34.7% faster at 10,000** in the final debug run. Cmd+N debug CPU elapsed time improved **26.6%**. Cmd+O/P mixed-agent medians improved only about 5% in the final run, less than the earlier interim run; the final measurements take precedence.

Some debug tails worsened: Cmd+P p95 rose from 28.86 to 106.66 ms, and the 2,000-agent picker had a 393.91 ms p99 reopen outlier. Release Cmd+P p95 remained about 15.2 ms across both revisions. No claim of universally improved p95/p99 or zero latency is supported.

Unchanged code was also measured as a control: settings initialization 2.41 → 2.36 ms; settings plus keymap 3.77 → 3.36 ms; 10,000-row Find cold query 50.18 → 43.35 ms, cached query 12.87 → 10.88 ms, next match 0.008 → 0.006 ms. These differences are not attributed to this patch. Idle cursor timers remained one foreground timer/10 callbacks over five seconds with either 16 or 48 sessions, and zero for an inactive window or empty workspace. Separate login, skeleton and completed-spinner regression checks assert no decorative ticker work.

Complete debug observations, including parser, cache/ranking, Flutter-tab and startup results: [baseline](2026-09-22-data/debug-baseline.json), [common baseline](2026-09-22-data/common-baseline.json), [interim](2026-09-22-data/debug-interim.json), [final](2026-09-22-data/debug-final.json).

### Independent search PR check

After splitting the changes into independent PRs, the 2,000-agent debug benchmark was rerun with only #219 applied to the baseline. Query extension measured 11.40 ms median / 16.71 ms p95, versus the original baseline's 18.46 / 50.78 ms. Reopening measured 47.25 / 79.21 ms; broad query 35.80 / 88.22 ms. Selection p95 was worse at 54.65 ms (baseline 12.03 ms). This single debug run supports a query-extension improvement from the isolated search change, not universally better tail latency. All 50 measured observations per interaction contributed to the distributions; the [isolated result](2026-09-22-data/search-pr-isolated.json) is kept separately from the combined-series results above.

## CPU profile

The same 2,000-agent command-dock workload was sampled at a 1,000 µs interval. The baseline profile contains 12,084 samples across 19.16 s; the final profile contains 8,501 samples across 13.02 s. Framework build/layout work and debug element checks dominate; these are debug profiles, not native renderer or whole-process CPU measurements.

The profile exposed unnecessary per-row set construction in search eligibility. Inclusive sample counts for `canAdd` fell from 136 to 41 and `canSubmit` from 154 to 53. The removed `_missingIds` path accounted for 112 baseline samples; the replacement `_hasMissing`/`_missingCount` paths accounted for 7/8 final samples. `_filter` fell from 837 to 586. Inclusive counts overlap and sample totals differ, so these are supporting evidence, not additive percentages of time saved. Prompt-context reuse and the simpler clipped render tree address repeated widget/layout work; the native shortcut-list run independently showed the benefit of building fewer rows.

The [profile summary](2026-09-22-data/cpu-profiles-summary.json) preserves sample metadata and hot functions. Raw VM profiles remain at `/private/tmp/rapid-moose-before-2000.json` and `/private/tmp/rapid-moose-after-2000.json`; they are tens of megabytes and are not checked into the repository. The profiled benchmark observations are also retained [before](2026-09-22-data/debug-profiled-baseline.json) and [after](2026-09-22-data/debug-profiled-after.json), separately from the unprofiled comparison.

## Native feature sweep

The disposable Release app was exercised through normal native app controls: Open Harness, query filtering and preview, New Harness/project and agent choices, command filtering, shortcut-browser paging/search/practice and dismissal, tab switching, Store discovery/detail pages, Settings search/navigation, and terminal Find with next-match navigation across 1,000 rows. Screenshots were inspected for the search context line, shortcut list/dialog veil, Store and Settings, and terminal Find. The corrected New Harness Agent accessibility action opened its chooser successfully. The release dispatch benchmark separately asserted Cmd+N/O/P/comma/slash/F, tabs, pane focus and zoom for every sample.

This is not an exhaustive end-to-end test of every remote/backend operation. Synthetic transports block real launches, Store service connection, network/reconnect and agent response measurements. Real sessions and saved workspaces were not used. The native fixture was closed after verification.

## Verification

The full desktop suite completed 2,788 passing tests, 10 skips and one failure in a daemon-discovery timing test that waited only 120 ms. That file passed all 31 tests when rerun alone; the four prompt-context tests also passed, including cache invalidation for identity, matching and text scale. After the final shortcut-list change, all 55 tests in the live-binding/search/keyboard/Settings suite passed, paging traversed every group in both directions at normal and enlarged text, and all 20 Settings render cases passed. The render test now scrolls offscreen headings into view before inspecting them. The final 14 benchmark tests passed. Nine native-bundle isolation tests passed. Static analysis found no new issues (one existing informational lint in `test/desk_sync_test.dart`).

After splitting, each production PR also passed its checks independently against the baseline: #219 passed 59 search/context/render/navigation tests and its 2,000-agent benchmark; #220 passed 62 dialog/shortcut/Settings/keymap/spoken-task tests; #221 passed 149 spinner/login/skeleton/accessibility/Store/pane/entry-layout tests. Changed-file analysis passed on all three branches. These counts overlap with earlier suites and are not an additional combined-suite total.

## Next priority: primary workflows

The [primary-workflow follow-up](2026-09-22-primary-workflows.md) prioritizes Cmd+N, Cmd+O, Cmd+T and switching active workspaces. The comparison above did not include Cmd+T and does not establish a material Release improvement in Cmd+N/O. The extended driver now verifies new-tab creation and closing, and the follow-up measures a separate, isolated Cmd+O improvement in #226. It also preserves a rejected new-tab experiment and unchanged controls. Less frequently used settings/help surfaces are lower priority for further work.

## Reproduction

From `desktop/`, use the same SDK and run quantitative tests without simultaneous builds/tests:

```sh
flutter test --no-pub test/benchmarks/common_actions_benchmark.dart test/benchmarks/swarm_benchmark.dart test/benchmarks/startup_benchmark.dart test/benchmarks/terminal_find_benchmark.dart test/benchmarks/terminal_idle_benchmark.dart --concurrency=1 --reporter expanded
HARNESS_DOCK_CPU_PROFILE=/private/tmp/harness-dock flutter test --no-pub test/benchmarks/swarm_benchmark.dart --enable-vmservice --name 'command dock widget benchmark with 2000' --concurrency=1 --reporter expanded
python3 tool/native_benchmark/prepare.py --flutter /path/to/flutter --flutter-dispatch
```

Open the printed temporary app through normal app controls; it validates each operation, writes `interactive.json` in the printed temporary root and exits. See [the native benchmark instructions](../../desktop/tool/native_benchmark/README.md) for isolation and measurement limits. Use `--interactive` instead for manual feature checks with disposable sessions.
