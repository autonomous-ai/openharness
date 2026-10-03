# Build one resource summary per toolbar update

Constructing the resource fields for a native toolbar update walked the entire
session inventory 32 times. Each count, tooltip, full label, and narrow label
independently rebuilt the live-session list and recomputed totals. This included
saved sessions that did not contribute to those totals.

The toolbar now captures one immutable `HarnessMonitorSummary` for that update.
The Flutter resource footer does the same for each layout. Width variants,
accessibility descriptions, and tooltips reuse the resulting values. The next
update reads current state again; there is no persistent summary cache, new
timer, additional sampling, or change to session lifecycle.

Shared Codex servers still contribute once, storage is deduplicated within each
machine, and unavailable or expired readings remain unknown. A test clock checks
the 45-second expiry boundary without waiting or changing production cadence.

## Measurements

[Raw evidence](2026-10-02-resource-summary.json) compares the exact 1.2.47 source
at `ea5afd5ad19758e4bcf7b690aafe8dba017591c9` with the candidate. Both use the same
final synthetic fixture on macOS ARM64, Flutter 3.47.2 / Dart 3.13.2, in headless
Debug mode. Runs are sequential, with 20 warmups and seven rounds of 40 resource
field constructions. Values below are medians of those round averages. Other
workstation apps remained running; this task ran no other test or build during
the timed loops.

| Live / saved sessions | Before | After | Less time |
| --- | ---: | ---: | ---: |
| 16 / 64 | 301.1 µs | 48.45 µs | 83.9% |
| 25 / 1,000 | 2,650.725 µs | 95.225 µs | 96.4% |
| 105 / 4,096 | 10,998.4 µs | 350.5 µs | 96.8% |

Inventory walks were **32 → 1** in every case. Every resulting label and tooltip
matched the baseline exactly. This measures one UI component's computation,
excluding native painting, transport, the daemon, agent processes, GPU and
battery. It does not establish equivalent whole-app energy or CPU savings.

## Reproduction and validation

From `desktop/`:

```sh
HARNESS_RESOURCE_BENCH_OUTPUT=/tmp/resource-after.json flutter test --no-pub \
  test/benchmarks/harness_monitor_summary_benchmark.dart --concurrency=1
```

Copy the same benchmark file into an isolated checkout of the baseline commit,
prepare its Flutter dependencies, and run with
`--dart-define=HARNESS_RESOURCE_BENCH_LEGACY=true` and a separate output file.
That flag uses the baseline's original getters; it does not reimplement them.
Compare the `footer` arrays as well as timings, and keep all rounds. The JSON
records the benchmark and changed production-file hashes.

The 52 targeted tests cover resource parsing, shared-server accounting, partial
readings, machine replacement and disconnect, stale data, responsive widths,
stopped-session updates, saved-session visibility, native toolbar updates,
workspace activity/event isolation, and opening/reusing Harness Monitor through
both footer controls. Coverage includes all 49 executable lines in the new summary
and formatting code (137/144 in the entire monitor). Analysis passes with 14
pre-existing informational findings and none in the changed files. No real agent
is started by these fixtures.

```sh
flutter test --no-pub --concurrency=1 \
  test/harness_monitor_summary_test.dart test/harness_resources_test.dart \
  test/harness_monitor_visibility_test.dart test/swarm_screen_test.dart \
  test/workspace_activity_test.dart test/workspace_event_isolation_test.dart \
  test/harness_monitor_test.dart
flutter analyze --no-pub --no-fatal-infos
```

These are component and workspace tests, not 100% end-to-end coverage. The prior
[full-suite audit](2026-10-02-buffered-diagnostic-validation.json) records
unrelated baseline failures and stalled tests; a green targeted run does not
mean the whole repository suite passes.
