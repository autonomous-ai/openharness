# Connected local workspace resource comparison

The controlled local workspace used less CPU and fewer interrupt wakeups while
idle with hidden terminal cursors. It did **not** establish an overall energy
improvement: foreground output used more CPU in all three pairs, and background
memory footprints increased. These results must accompany the much larger
component-level transcript improvements; those improvements are not whole-app
energy measurements.

## Results

Values are the median of three runs per variant. CPU is percent of **one core**,
summed across the desktop, daemon, tmux and terminal workers. “Hidden cursor”
means the terminal sent DECTCEM hide; “background” means the native app was hidden.

| Workload | CPU before → after | Relative CPU change | Interrupt wakeups/s before → after | Summed footprint MiB before → after |
| --- | ---: | ---: | ---: | ---: |
| Foreground idle, visible cursor | 5.20 → 5.75 | +10.6% | 28.63 → 27.49 | 507.9 → 485.0 |
| Foreground idle, hidden cursor | 4.65 → 3.84 | **−17.4%** | **28.00 → 15.40 (−45.0%)** | 492.3 → 447.7 |
| Foreground active output | 31.86 → 33.51 | **+5.2%** | 1087.15 → 1072.36 | 655.7 → 666.1 |
| Background idle, hidden cursor | 4.04 → 3.87 | −4.3% | 14.37 → 14.40 | 663.9 → 682.7 |
| Background active output | 23.52 → 23.23 | −1.2% | 915.55 → 926.07 | 675.1 → 694.1 |

The hidden-cursor wakeup reduction was 44.7–45.2% in the individual pairs;
CPU reductions were 11.5–17.8%. Foreground active CPU was **5.2–8.6% higher in
every pair**. That observed regression needs investigation. The unchanged
terminal workers also varied in CPU cost, so host scheduling/frequency may
contribute, but its cause has not been isolated. Three short pairs on a shared
machine cannot settle that attribution or establish a universal improvement.

Footprints are sums of per-process physical footprints, which can count shared
mappings more than once. Phases run in a fixed sequence after startup; allocation
and garbage-collection history affect them. These are not estimates of total
machine RAM saved.

The [data](2026-10-02-connected-workspace-resources.json) retain all six runs,
individual paired changes, component CPU, output counts, native states, source
and tooling hashes, 1 Hz aggregate samples, and hashes of the full private raw
samples. No failed run is silently included as passing.

## Source and workload

- Current source: `c966e1ac0e10d2741bad53352fcdba9b41d2a6de`.
- Baseline: that same source with only production patches from
  [#628](https://github.com/autonomous-ai/openharness/pull/628),
  [#631](https://github.com/autonomous-ai/openharness/pull/631),
  [#633](https://github.com/autonomous-ai/openharness/pull/633) and
  [#648](https://github.com/autonomous-ai/openharness/pull/648) reversed in a
  temporary checkout. Combined patch SHA-256:
  `cdcd1d9488f4713549a386cc67455a1487bb19edd4541681f0182691b09a4688`.
- Identical connected fixture source for both native Release builds. Flutter
  3.47.2/Dart 3.13.2, full Xcode selected per command, native arm64, unique
  `ai.autonomous.harness.benchmark` bundle. Exact app-source patches and CLI
  bundle hashes are in the data. The current build's identity record was added
  after building: all 563 tracked production Dart inputs were then checked
  byte-for-byte against the copied sources. This is a scoped identity check,
  not a complete reproducible-build attestation.
- Mac14,6, 64 GiB RAM, 12 logical CPUs, macOS 26.6.2; AC power, charged battery.
  Other real work remained running. Per-run host load averages are retained.
- Ten real private tmux terminals, four visible in the selected tab. Each worker
  seeds 1,000 terminal lines. Active workers redraw eight ANSI rows at 20 Hz
  through the actual tmux → daemon → native desktop transport and renderer.
- Five phases per fresh process, five-second settling periods, 30 seconds of
  sampling per phase. Three pairs ordered baseline/current, current/baseline,
  baseline/current. All builds finished before the comparison.
- Every active worker achieved at least 18 Hz, with skipped ticks at most 2%.
  Output reached every retained terminal; all connections remained controlling.
  Native focus, hidden state and window geometry remained unchanged within each
  phase. All six apps and private stacks exited successfully and their tmux
  sockets stopped listening.

The workload covers steady local terminal activity. It does **not** trigger
large Codex transcript recaps, so it cannot reproduce the component gains in
[the recap comparison](2026-10-02-codex-recap-tail.md).

## Measurement validity and limits

The older native fixtures suppress connections and production background
services. This fixture instead uses the real signed-out app bootstrap, local
daemon, discovery, supervision and terminal transports, without `FLUTTER_TEST`.
It substitutes installer/sign-in/update acquisition and disables ownership-driven
daemon replacement because the launcher owns a private daemon. No installed app,
daemon, tmux server, real session or credentials were changed.

The forest sampler converts Mach ticks using the recorded 125/3 timebase and
includes live processes, exited-but-unreaped children, and kernel child counters.
The initial experiment used `proc_listallpids`, which omitted unreaped children
before their CPU moved to parent counters. A deterministic reproduction exposed
the temporary loss; that comparison was rejected in full. The corrected
`KERN_PROC_ALL` inventory includes that interval and treats exited-process memory
as zero. Independent CPU calibrations measured 1.9843 s versus 1.9594 s for
live/reaped workers and 1.2481 s versus 1.2221 s for a delayed-reap worker. Both
passed the stated 0.06 s or 10% tolerance. Root overlap, PID reuse, unstable
membership and regressing counters reject a sample.

The sampler excludes processes reparented outside the selected trees, shared
system services such as WindowServer, GPU energy and battery discharge. There
are no signed-in accounts, remote machines or real Codex/Claude engines in this
workload. CPU and interrupt wakeups are resource indicators, **not joules or a
measurement of macOS's “Using Significant Energy” classification**. That claim
requires a separate matched energy measurement on representative user workloads.

The runner's missing-input cleanup was tightened after recording the comparison:
it now hashes required inputs before launching the private stack. This does not
change the measured workload; recorded tooling hashes identify the measured
revision rather than silently claiming that later tooling ran retroactively.

## Reproduction and next work

Use the [connected fixture instructions](../../desktop/tool/native_benchmark/README.md#connected-local-workspace-resources)
to build both variants and run them with the same tooling. Preserve failed runs
and inspect output-rate and focus checks before comparing medians. All local
results from this comparison remain under
`/private/tmp/harness-connected-v2-{1..6}-{baseline|current}-20261002`.

The next performance investigation is the daemon's remaining idle CPU and the
foreground-output regression, followed by representative signed-in and physical
energy measurements. This change adds measurement tooling and records evidence;
it does not change production behavior or publish a release.
