# Core developer experiences: performance measurements

This pass measures the work developers repeat: typing, opening a harness, finding
and selecting a session, creating a tab, switching tabs and panes, searching
scrollback, and scrolling while terminals produce output. It also measures the
real terminal path to a local daemon and two remote Macs, and the desktop
process's CPU, memory footprint, and wakeups.

The earlier implementation PRs [#219](https://github.com/autonomous-ai/openharness/pull/219),
[#220](https://github.com/autonomous-ai/openharness/pull/220),
[#221](https://github.com/autonomous-ai/openharness/pull/221), and
[#226](https://github.com/autonomous-ai/openharness/pull/226) are in this baseline.
Their measured gains and rejected experiments remain in the
[September 22 report](2026-09-22-wrap-up.md). This new baseline does not establish
an additional speedup by itself.

## What the numbers mean

There are three separate measurement boundaries:

1. **Desktop responsiveness:** framework text/key dispatch through the exact
   Flutter raster-completion frame that contains the verified result. The Release
   fixture uses production widgets, focus handling, terminal decoding, parsing,
   and rendering, with synthetic sessions and no network delay. Picking a
   terminal or changing tabs/panes includes the navigation frame and the next
   verified input-echo frame. Cmd+N means the input-ready creation surface;
   Cmd+T means a new empty tab. Neither means an agent has started.
2. **Real terminal round trip:** binary input sent by a client to a matching
   response from a Python probe in a real disposable PTY. This includes the local
   daemon, the actual transport, remote daemon/PTY processing, and the return
   path. It excludes desktop rendering, physical keyboard input, and model
   inference. Control requests, terminal creation, attachment, and reattachment
   are measured separately.
3. **Process resource use:** macOS `proc_pid_rusage` counters sampled once per
   second. CPU is a percentage of one core; memory is physical footprint, not
   virtual address space. Counts cover the fixture process, excluding daemons,
   agent processes, and GPU energy.

These replace the earlier idle-only shortcut table. Picker/navigation now includes
verified input, Find includes scan completion, and output load is explicit. The
changed workloads and timing boundaries mean differences from the old README
are not a measured product regression or improvement.

These distributions cannot be added to obtain an end-to-end p95. None is a
physical key-to-photon measurement. Native titlebar paint completion and display
presentation are outside the Flutter raster boundary.

## Desktop responsiveness

One complete Release sweep is reported for each fixture below. These are
workstation observations, not a causal comparison between fixture sizes.
The host had other applications running. Warmups are excluded; every measured
outlier is retained. Each cell is **median / p95 / p99 in milliseconds**.
Navigation-plus-input includes two frames and cannot be compared directly to a
single shortcut frame.

### 1 retained terminals, 1,000 seeded lines each

120 measured observations per action/load, five warmups, 1 visible
terminal(s). All 500 input commits were verified, with no
foreground-focus loss. Actual final buffers contain 1,004–1,004
physical rows per terminal. [Raw run](2026-09-23-data/core-1-1.json).

| Action | Idle median / p95 / p99 | Output median / p95 / p99 |
|---|---:|---:|
| Typing and echo | 11.65 / 17.55 / 18.03 | 27.29 / 50.85 / 68.64 |
| Cmd+N creation surface | 10.99 / 18.84 / 19.89 | 10.80 / 14.16 / 15.30 |
| Cmd+O picker | 10.91 / 15.96 / 17.68 | 10.54 / 14.32 / 14.91 |
| Picker query | 7.55 / 11.48 / 11.73 | 8.99 / 13.19 / 14.07 |
| Picker selection + input | 16.27 / 19.72 / 20.13 | 17.27 / 20.66 / 20.92 |
| Cmd+T empty tab | 9.86 / 14.57 / 15.78 | 10.62 / 15.39 / 15.98 |
| Find scan + results | 8.82 / 12.19 / 12.51 | 9.83 / 13.55 / 13.77 |
| Scroll one viewport | 23.58 / 38.44 / 51.21 | 26.18 / 62.23 / 104.61 |

Achieved decoded output: 18.3 kB/s;
0 explicitly skipped bursts. Timer coalescing can lower the achieved
rate without incrementing that counter, so the byte rate is the useful load check.

### 16 retained terminals, 1,000 seeded lines each

120 measured observations per action/load, five warmups, 4 visible
terminal(s). All 1,000 input commits were verified, with no
foreground-focus loss. Actual final buffers contain 1,001–1,002
physical rows per terminal. [Raw run](2026-09-23-data/core-16-1.json).

| Action | Idle median / p95 / p99 | Output median / p95 / p99 |
|---|---:|---:|
| Typing and echo | 11.16 / 18.50 / 20.36 | 34.74 / 74.16 / 161.95 |
| Cmd+N creation surface | 10.56 / 14.96 / 16.53 | 10.82 / 14.40 / 17.07 |
| Cmd+O picker | 12.32 / 16.09 / 16.96 | 12.98 / 16.91 / 18.14 |
| Picker query | 9.95 / 13.62 / 13.74 | 10.93 / 14.92 / 16.76 |
| Picker selection + input | 26.15 / 31.14 / 33.12 | 26.70 / 35.89 / 40.54 |
| Cmd+T empty tab | 13.21 / 18.12 / 19.87 | 13.74 / 18.01 / 22.73 |
| Tab change + input | 27.22 / 34.22 / 38.12 | 33.35 / 42.61 / 46.14 |
| Pane focus + input | 23.89 / 30.60 / 33.05 | 30.19 / 37.34 / 41.77 |
| Zoom | 55.29 / 100.91 / 348.99 | 73.16 / 326.03 / 783.98 |
| Find scan + results | 10.09 / 13.06 / 13.63 | 11.01 / 13.98 / 15.18 |
| Scroll one viewport | 40.89 / 83.24 / 106.97 | 48.78 / 139.60 / 301.10 |

Achieved decoded output: 251.8 kB/s;
0 explicitly skipped bursts. Timer coalescing can lower the achieved
rate without incrementing that counter, so the byte rate is the useful load check.

### 48 retained terminals, 1,000 seeded lines each

120 measured observations per action/load, five warmups, 4 visible
terminal(s). All 1,000 input commits were verified, with no
foreground-focus loss. Actual final buffers contain 1,001–1,002
physical rows per terminal. [Raw run](2026-09-23-data/core-48-1.json).

| Action | Idle median / p95 / p99 | Output median / p95 / p99 |
|---|---:|---:|
| Typing and echo | 10.94 / 18.76 / 20.25 | 37.80 / 91.49 / 161.71 |
| Cmd+N creation surface | 10.72 / 14.61 / 16.18 | 10.59 / 13.99 / 14.40 |
| Cmd+O picker | 12.83 / 16.16 / 16.60 | 12.91 / 17.88 / 23.77 |
| Picker query | 11.56 / 15.13 / 16.66 | 12.26 / 16.91 / 17.94 |
| Picker selection + input | 28.39 / 36.83 / 40.23 | 31.44 / 42.26 / 44.08 |
| Cmd+T empty tab | 14.15 / 20.17 / 22.80 | 16.62 / 24.76 / 28.64 |
| Tab change + input | 32.14 / 40.52 / 46.21 | 35.97 / 43.78 / 48.41 |
| Pane focus + input | 26.86 / 33.99 / 39.35 | 28.64 / 36.29 / 40.01 |
| Zoom | 58.67 / 126.44 / 168.18 | 65.25 / 136.09 / 222.21 |
| Find scan + results | 9.26 / 12.67 / 12.87 | 10.03 / 13.39 / 16.25 |
| Scroll one viewport | 35.02 / 67.38 / 98.82 | 42.66 / 109.84 / 143.88 |

Achieved decoded output: 872.6 kB/s;
0 explicitly skipped bursts. Timer coalescing can lower the achieved
rate without incrementing that counter, so the byte rate is the useful load check.

### 16 retained terminals, 10,000 seeded lines each

30 measured observations per action/load, five warmups, 4 visible
terminal(s). All 280 input commits were verified, with no
foreground-focus loss. Actual final buffers contain 10,000–10,000
physical rows per terminal. [Raw run](2026-09-23-data/core-16-full-scrollback.json).

| Action | Idle median / p95 / p99 | Output median / p95 / p99 |
|---|---:|---:|
| Typing and echo | 10.13 / 17.90 / 19.43 | 11.36 / 18.39 / 19.66 |
| Cmd+N creation surface | 10.28 / 14.05 / 14.07 | 11.79 / 13.89 / 14.23 |
| Cmd+O picker | 12.97 / 16.89 / 16.97 | 12.93 / 15.63 / 15.72 |
| Picker query | 9.66 / 14.12 / 14.34 | 10.33 / 13.83 / 14.24 |
| Picker selection + input | 27.35 / 32.30 / 32.67 | 30.31 / 38.45 / 39.47 |
| Cmd+T empty tab | 11.23 / 15.12 / 15.93 | 12.60 / 16.04 / 16.31 |
| Tab change + input | 31.95 / 40.50 / 43.50 | 31.56 / 41.96 / 50.40 |
| Pane focus + input | 24.22 / 32.57 / 33.74 | 24.56 / 31.75 / 34.99 |
| Zoom | 14.99 / 19.09 / 19.36 | 68.61 / 453.74 / 499.53 |
| Find scan + results | 26.09 / 29.37 / 31.40 | 28.26 / 35.91 / 39.13 |
| Scroll one viewport | 10.04 / 13.79 / 14.20 | 46.10 / 85.19 / 108.30 |

Achieved decoded output: 286.1 kB/s;
0 explicitly skipped bursts. Timer coalescing can lower the achieved
rate without incrementing that counter, so the byte rate is the useful load check.

At 16 terminals, the largest idle zoom observation was **4,436 ms**; the
accepted frame itself recorded 1,811 ms building and 49 ms rasterizing. Its idle
p99 was 349 ms. This stall is preserved, not trimmed. These measurements do not
isolate its cause. Output-heavy typing, resizing/zoom, and scrolling need further
profiling; the fast picker and new-tab numbers do not imply that every workflow
is consistently fast.

## Desktop process resources

Each row is one 30-second sample after the timing sweep. Memory is the median
physical footprint; CPU 100% means one core. Foreground fixtures were activated
through application controls; background fixtures were explicitly hidden. These
are snapshots, not a memory-leak study. The one-terminal process remained idle
longer before sampling than the other fixtures.

| Fixture / state | CPU, one core | Footprint median / peak | Interrupt wakeups/s |
|---|---:|---:|---:|
| core-1-background-idle | 0.08% | 217.3 / 223.7 MiB | 12.1 |
| core-1-foreground-idle | 0.08% | 212.8 / 223.5 MiB | 11.5 |
| core-16-background-idle | 0.10% | 306.1 / 311.5 MiB | 13.8 |
| core-16-foreground-idle | 0.09% | 304.4 / 311.4 MiB | 12.9 |
| core-16-full-background-output | 1.79% | 960.3 / 970.2 MiB | 180.1 |
| core-16-full-foreground-output | 1.28% | 956.7 / 968.0 MiB | 140.6 |
| core-48-background-idle | 0.08% | 558.5 / 564.0 MiB | 13.5 |
| core-48-foreground-idle | 0.10% | 559.2 / 596.1 MiB | 16.0 |

The idle samples include the fixture and benchmark bookkeeping, not daemon or
agent memory. A background window still has measurable wakeups. The synthetic
fixture has no real connections, so these results do not support a claim of zero
background work in the connected application. Raw samples include resident
bytes, CPU deltas, disk I/O, and package-idle wakeups as well.

## Native navigation work

Navigation changes rebuild the History menu even when it is closed in the
baseline. [PR #251](https://github.com/autonomous-ai/openharness/pull/251) keeps its destination model and command
validation current, retains installed shortcuts, and builds the display rows
when the menu opens. Updates while the menu is open remain immediate.

An optimized Swift component probe uses 64 recent and 24 closed entries and
alternates three before/after runs, with 20 warmups and 200 measured updates per
operation per run. Pooled results include 600 observations per cell:

| Native component elapsed time | Before median / p95 | After median / p95 |
|---|---:|---:|
| Update while History is closed | 4.306 / 5.051 ms | 0.060 / 0.066 ms |
| Update and immediately open History | 4.334 / 4.770 ms | 4.286 / 4.871 ms |

Closed updates use **98.6% less median elapsed time** in this component
probe. Construction moves to menu opening; opening is not claimed to be faster.
This is not an established percentage improvement to Cmd+T or tab-switch raster
latency. The desktop tables measure the unmodified baseline. The probe includes
autorelease cleanup but excludes input delivery, Flutter, and display completion.

The production comparison starts at `e566f0af`, whose History implementation is
unchanged from the desktop baseline. SHA-256 of `SwarmTitlebar.swift` is
`0e726abb3ca482a68a437aa2733c1e15e5a5dbd315bdad5f0091efb7210e5067` before and
`5435fef1dc5997758f95ade81e7fe3dfebc762311fde65164046ebccc6883517` after.
The dedicated lifecycle checks cover 17 assertions, including shortcuts,
coalesced updates, empty/stale destinations, accessibility, and modal blocking.
The existing broad native checker does not compile on that main revision because
its Models fixtures reference a removed API and view types; that failure also
occurs without this optimization.

## Real local and remote terminal latency

Each row pools 600 measured echoes from three runs. Times are milliseconds.

| Target / reported route | Workload | Median | p95 | p99 | Maximum |
|---|---|---:|---:|---:|---:|
| Local Mac / loopback | Idle | 1.14 | 7.16 | 30.37 | 233.06 |
| Local Mac / loopback | 20 Hz redraw | 1.72 | 11.06 | 36.60 | 96.79 |
| Office iMac / P2P | Idle | 13.88 | 77.31 | 144.42 | 490.34 |
| Office iMac / P2P | 20 Hz redraw | 16.80 | 57.40 | 146.78 | 227.67 |
| Home iMac / relay | Idle | 376.24 | 501.10 | 584.57 | 739.13 |
| Home iMac / relay | 20 Hz redraw | 379.17 | 500.00 | 541.11 | 654.15 |

All 3,600 measured echoes completed. All 270 measured control requests completed,
and all nine disposable terminals were deleted. Office's per-run idle p95 ranged
from 25.92 to 115.64 ms; its redraw p95 ranged from 32.03 to 136.55 ms. That
variation matters more than a single low median. These runs do not establish why
the tails occurred or that redraw improves latency.

The redraw payload is repetitive and compressible. Achieved decoded output was
roughly 76–81 kB/s, not a saturation test or a claim about maximum throughput.
The client daemon reported version 0.2.89; the two remote targets reported
Darwin/x86_64. The installed daemon binary was not built by this measurement run.

| Target | Control RPC median / p95 | Create terminal median (range) | Attach median (range) | Reattach median (range) |
|---|---:|---:|---:|---:|
| Local | 0.19 / 0.38 ms | 139.08 (138.53–140.93) ms | 14.26 (13.49–15.26) ms | 38.69 (38.12–59.19) ms |
| Office | 396.47 / 450.06 ms | 570.35 (569.13–570.53) ms | 29.84 (26.61–84.95) ms | 54.24 (50.65–61.36) ms |
| Home | 379.54 / 479.70 ms | 597.77 (537.52–644.69) ms | 388.79 (383.11–390.09) ms | 762.68 (759.10–908.12) ms |

Control is a `terminal_capabilities` request through the machine control path,
not a ping and not the terminal stream. It has 90 measured observations per host.
Setup and reattach each have only three observations. First echo after reattach
had medians of 18.02 ms local, 14.06 ms Office, and 370.77 ms Home; this is a
separate observation after the reattach stage, not part of the displayed reattach
duration. The large Office control/terminal difference is a reason to profile
control routing next; subtracting these independent percentiles would not measure
protocol overhead.

## Workloads and reproducibility

The client is an Apple M2 Max with 64 GiB RAM, macOS 26.6.2. The desktop uses a
Release build with Flutter 3.47.2 / Dart 3.13.2. The display's reported maximum is
120 Hz; that does not establish a fixed refresh cadence. Other applications
remained running. Our measurements ran serially, with our builds and tests
finished before timing began. This is a working developer machine, not an
otherwise isolated laboratory host.

The desktop fixture retains 1, 16, or 48 terminals, with up to four visible. It
visits every retained tab before sampling and seeds 1,000 lines per terminal.
A separate full-scrollback stress sweep seeds 10,000 lines and takes 30 measured
observations per action/load; the result records actual retained physical rows
after wrapping and interaction. Its p99 is just its maximum and should not be
read as a stable tail estimate. The standard fixtures have
five warmups and 120 measured observations per action at idle and with all terminals
receiving an eight-row ANSI redraw at 20 Hz. The fixture retains achieved byte
counts and skipped bursts. A deterministic 0–20 ms delay before input spreads
samples across frame phases and is excluded from the measured interval.

Every input must reach exactly the expected focused terminal once. Pickers must
return the expected session, Find must finish scanning and find matches, and
navigation must preserve the declared terminal and visible-pane counts. A run
fails if the window loses foreground focus. The scroll workload moves the
production scroll controller one viewport; it does not measure OS wheel-event
delivery.

The terminal probe makes three independent runs per host. Each run has 200
measured echoes and ten warmups for both idle and a 20 Hz ANSI redraw, plus 30
measured control requests and three warmups. The current valid series uses
schema 3. Control requests finish before typing begins, so experimental routing
hints cannot perturb the typing baseline. Every terminal created for these runs
is deleted in cleanup.

All percentiles use nearest rank over individual measured observations; warmups
are retained but excluded. Maxima and slower runs are retained. Three setup or
reattachment observations support a median and range, not a useful p95. A p99
from a small series is descriptive and should not be treated as a stable service
level.

Reproduce using the [Release fixture](../../desktop/tool/native_benchmark/README.md)
and [real terminal probe](../../cli/scripts/benchmark-terminal-latency.md).

## Interpretation and next priorities

The next pass should prioritize output-heavy typing, zoom/resize, and scrolling.
Capture CPU and renderer profiles around the preserved stalls before changing
code; these timings alone do not identify the bottleneck. Compare foreground
input under identical host load, retain the 16-terminal control, and repeat the
same sequence on both production revisions. Full-buffer memory and Find scan
cost also deserve a dedicated comparison: the 10,000-line stress sweep exercises
them, but its 30 samples per action are insufficient for a stable p99.

The full-scrollback streaming resource sample includes the 20 Hz producer and a
ten-second diagnostic counter write. Its [load counters](2026-09-23-data/full-scrollback-resource-load.json)
record actual decoded bytes and elapsed time. The idle fixtures have neither
producer nor diagnostic timer. Comparing their CPU percentages therefore
compares different workloads; it is not a before/after optimization result.

Remote typing depends on the route. A reported `p2p` mode is the daemon's label;
we did not collect the ICE candidate pair and cannot infer that it was a direct
LAN connection. The Home machine used the relay during the reported series.
Network conditions and route selection can change, so these are observations
of these connections, not promises for all remote sessions.

The 4090 rig was excluded at the owner's request because its installed daemon
lacked the terminal capability required by the probe. No update was performed.

This pass does not yet measure cold application startup, actual model first-token
latency, a complete network outage and recovery, IME composition, large paste,
long-running memory growth, or battery energy. A reconnect here means a new local
client socket reconnecting to the same daemon route and running PTY; it is not
evidence about recovery from a lost network. The synthetic idle fixture has no
real connections and cannot establish that a connected product has zero timers,
zero wakeups, or zero CPU use in the background.

## Artifacts and validation

The [artifact manifest](2026-09-23-data/manifest.json) records source revisions,
source hashes and SHA-256 checksums for raw runs. Desktop production code is
`cc5be5e9`, built with benchmark tooling `aca80aff`; terminal tooling is `c1deb5e6`.
The installed client daemon reports 0.2.89; we do not claim a source revision for
that installed binary. The native optimization is `9b20d50a` in
[PR #251](https://github.com/autonomous-ai/openharness/pull/251). Its symbolic
after labels in the raw files refer to the source hash recorded above.

Changed Dart benchmark files pass analysis; nine bundle-isolation tests and all
17 focused native History lifecycle checks pass. Release results validate focus,
exact input delivery, expected picker/Find results, and fixture size themselves.
[Calibration exclusions](2026-09-23-data/diagnostics/exclusions.json) document
invalid probes and retain representative failed or incomparable observations.
No slower successful run was removed from the reported series.

Pool the published observations with:

```sh
python3 desktop/tool/native_benchmark/summarize_results.py docs/performance/2026-09-23-data
```

For the native component comparison, use the focused checker/probe from PR #251
on both production revisions. It runs without showing a window or accessing
saved application state:

```sh
bash desktop/tool/check_swarm_titlebar.sh /path/to/flutter --history
HARNESS_TITLEBAR_PERF_OUTPUT=/private/tmp/history-run.json \
HARNESS_PERF_REVISION=YOUR_REVISION \
bash desktop/tool/check_swarm_titlebar.sh /path/to/flutter --history-performance
```
