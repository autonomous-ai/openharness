# Native tab label measurements — October 1, 2026

A live macOS development-app sample showed repeated AppKit text measurement
inside `SwarmTabButton.indicatorWidth`, `reservedIndicatorSpace`, and tab geometry.
Each 100 ms activity tick reconstructed the shortcut attributed string and
remeasured it, along with unchanged title text, throughout geometry and drawing.

The tab now retains the regular title, emphasized title, and shortcut with their
measured sizes. Existing label invalidation clears all three on a name, font,
color, shortcut, selection, or activity change. The cache is bounded to three
labels per tab; animation frames reuse it. Animation cadence and visibility
rules, hit targets, text, colors, and terminal behavior are unchanged.

## Matched native component benchmark

The same fixture was compiled against the original and changed production
AppKit source with Swift `-O` on ARM64 macOS 26.6.2. Each workload uses eight
working tabs, two warmup batches, and nine measured batches. All observations,
including the slower baseline batch, are in the [raw results](2026-10-01-native-tab-label-metrics.json).

| Workload per batch | Before median | After median | Reduction |
| --- | ---: | ---: | ---: |
| 400 geometry/activity steps across eight tabs | 505.51 ms | 1.54 ms | 99.7% |
| 80 geometry/activity steps plus offscreen drawing across eight tabs | 266.25 ms | 28.71 ms | 89.2% |

These are component elapsed times, **not whole-app CPU, energy, or battery-life
savings**. The fixture does not start Flutter, connect to agents, display a
window, or include GPU presentation. The complete cause of the reported
whole-app CPU spike remains under investigation.

Reproduce from the repository root:

```sh
bash desktop/tool/check_swarm_titlebar.sh /path/to/flutter --tab-performance
```

## Validation

- 4,544 AppKit checks pass on both original and changed source, including actual
  hidden-window layout and native controls. No window is displayed.
- All 28 rendered PNGs captured by the activity fixture are byte-identical.
- A retained tab is compared with a fresh tab after each individual mutation:
  short/long/empty/Unicode titles, font changes, shortcut remapping/removal,
  foreground changes, selected weight, all ten activity frames, Command hints,
  modal availability, legacy attention, and narrow/wide bounds. Geometry,
  tooltips, and rendered pixels agree.
- The separate hidden-protocol diagnostic feeds 16 and 48 retained terminals
  through the production binary decoder and parser while New Tab is visible.
  Both cases pass with no input sent, no hidden renderer needing layout, and no
  widgets rebuilt by the separately observed output burst. The benchmark is
  headless Debug and cannot establish the connected app's native energy cost.

```sh
bash desktop/tool/check_swarm_titlebar.sh /path/to/flutter --window-layout
cd desktop
flutter test --no-pub --concurrency=1 test/benchmarks/terminal_hidden_protocol_benchmark.dart
```

Set `HARNESS_HIDDEN_CPU_PROFILE` to a temporary output prefix and add
`--enable-vmservice` to collect a Dart CPU profile of that synthetic workload.
