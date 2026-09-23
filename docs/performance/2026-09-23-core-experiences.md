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

These distributions cannot be added to obtain an end-to-end p95. None is a
physical key-to-photon measurement. Native titlebar paint completion and display
presentation are outside the Flutter raster boundary.

## Native navigation work

Navigation changes rebuild the History menu even when it is closed in the
baseline. The separate optimization keeps its destination model and command
validation current, retains installed shortcuts, and builds the display rows
when the menu opens. Updates while the menu is open remain immediate.

An optimized Swift component probe uses 64 recent and 24 closed entries and
alternates three before/after runs, with 20 warmups and 200 measured updates per
operation per run. Pooled results include 600 observations per cell:

| Native component CPU work | Before median / p95 | After median / p95 |
|---|---:|---:|
| Update while History is closed | 4.306 / 5.051 ms | 0.060 / 0.066 ms |
| Update and immediately open History | 4.334 / 4.770 ms | 4.286 / 4.871 ms |

Closed updates use **98.6% less median elapsed CPU-work time** in this component
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
A separate full-scrollback workload seeds 10,000 lines; the result records the
actual retained physical rows after wrapping and interaction. Each action has
five warmups and 120 measured observations at idle and with all terminals
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
