# macOS executable-discovery experiment

The nonblocking `lsof` probe reduced command CPU by 49.2%. A subsequent comparison
isolating the daemon reduced idle CPU by 14.9%, with lower CPU in all three pairs.
This supports the narrow executable-discovery change in
[PR #657](https://github.com/autonomous-ai/openharness/pull/657). The connected
workspace measurements did not establish consistent whole-app savings. Nothing
from this experiment was released or installed into the running app or daemon.

**Additional measurement limitation:** later diagnostics found a hidden test app
drawing frames without ever receiving a Flutter lifecycle state. Earlier trials
did not record that state, so their background figures cannot establish normal
hidden-app behavior. The runner now rejects that condition; see the lifecycle
diagnostic below. No production visibility defect has yet been established.

## Daemon-only comparison

After diagnosing the native benchmark's invalid visibility state, six further
runs isolated the daemon from the GUI. Each used the original, unmodified CLI
bundles below, a private tmux server and ten idle terminal shells. There was no
desktop or model process. Each fresh stack settled for 20 seconds, then ran the
calibrated process-forest sampler for 30 seconds. Order was baseline/current,
current/baseline, baseline/current. All six completed and cleaned up.

| Metric | Median before → after |
| --- | ---: |
| Combined daemon/tmux/shell CPU, percent of one core | **3.51 → 2.99 (−14.9%)** |
| Interrupt wakeups/s | 7.97 → 7.77 |
| Summed physical footprint MiB | 102.56 → 102.75 |

Individual paired CPU changes were **−15.3%, −19.8%, −5.4%**. Wakeups were mixed
across pairs; there is no demonstrated memory improvement. The CPU boundary
includes exited helpers through kernel child counters. This is evidence of a
daemon component saving, not of GPU, battery or whole-app energy savings.

The [data and executed runner](2026-10-03-daemon-idle-component.json) retain all
six summaries, pair calculations, host load, hashes and cleanup results. The
comparison ran 02:22:08–02:27:23 UTC on October 3. Other real work remained
running; short read-only Git/receipt operations and a 0.004-second Python guard
suite overlapped, but no build or CPU-heavy test suite did. Later main-branch
memory-learning changes were not in these bundles; the measurement describes
these exact snapshots, not every later daemon build.

## Fresh-process comparison

Three pairs used the same native Release app, ten private tmux terminals and
identical workers. Only the CLI bundle differed. Each fresh stack ran hidden-cursor
idle, then active output, with five seconds of settling and 30 seconds of sampling
per phase. Both variants used the new `--background-only` mode. Its absolute values
must not be compared directly with the earlier five-phase experiment, which has
different allocation history.

CPU is percent of one core, summed over the app, daemon, tmux and terminal workers.
Values below are medians of three runs per variant.

| Workload | CPU before → after | Relative change | Interrupt wakeups/s before → after | Summed footprint MiB before → after |
| --- | ---: | ---: | ---: | ---: |
| Background idle, hidden cursors | 5.12 → 4.80 | −6.4% | 16.06 → 15.73 | 444.7 → 442.0 |
| Background active output | 37.01 → 48.05 | **+29.8%** | 1001.75 → 1046.33 | 661.5 → 667.2 |

Idle CPU changes in individual pairs were −6.4%, +9.7% and −17.9%.
Active-output CPU was **13.1%, 19.3% and 42.3% higher** in the respective pairs.
All six runs passed output-rate, connection, native visibility/geometry and
cleanup checks. Active output volume differed by less than 0.7% within each pair.

The higher active cost also affected unchanged code: median desktop CPU was
22.40 → 30.54%, daemon CPU 7.85 → 8.98%, and tmux/worker CPU 6.76 → 8.45%.
That suggests host or scheduling effects deserve investigation, but does not prove
them or excuse the result. Other real work remained running; one-minute load
averages at run boundaries ranged from 5.75 to 8.00. No thermal or CPU frequency
trace was captured. A mid-comparison observation reported AC power and a charged
battery; thermal status was unavailable.

## Same-process diagnostic

A second experiment kept the same app, daemon, tmux and worker PIDs alive for
six active-output phases. After 30 seconds of active warmup, a test-only hook
alternately removed or retained `-b` on executable-image probes. The order was
baseline/current, current/baseline, baseline/current, again with 30-second samples
and five-second settling periods.

The ordinary probe's median wall time was **52.33 ms**, versus **27.17 ms** for
the nonblocking probe. All image probes succeeded. Total CPU medians were
45.80 → 42.99% of one core, but paired changes remained inconsistent:
**+4.8%, −19.6%, −6.1%**. All output, native-state and cleanup checks passed.

This diagnoses the command mechanism; it is not an exact full-source A/B test.
Both modes used the candidate parser and deadlines, plus the same instrumentation.
The actual hook and transformed runner are retained in the data so the original
runner's hash is not mistaken for the entire executed experiment. This diagnostic
does not resolve the fresh-process CPU increase or establish an energy saving.

## Hardware-counter follow-up

Six further fresh-process trials used the same app, CLI bundles, workloads,
30-second phases and alternating order, with the sampler extended to record
macOS `RUSAGE_INFO_V6` counters. All six passed output and cleanup checks. The
[separate data](2026-10-03-process-discovery-counters.json) retain every pair,
process identity, raw counter boundary and source/artifact hash.

| Workload | Median combined CPU before → after | Relative change | Individual paired CPU changes |
| --- | ---: | ---: | --- |
| Background idle, hidden cursors | 5.25 → 4.92% of one core | −6.3% | −1.8%, −6.3%, −14.8% |
| Background active output | 42.54 → 46.07% of one core | **+8.3%** | +9.0%, −1.6%, +9.7% |

Hardware counters cover only matching processes present throughout a phase:
unlike the CPU-time accounting above, this API does not roll up exited helpers'
instructions or energy. Those persistent processes account for about 22–24% of
idle CPU time and 92–94% of active CPU time. Their median kernel-accounted active
CPU energy was 4.625 → 4.542 joules, but individual pairs changed by −0.8%, +3.4%
and −5.9%. This is mixed, incomplete CPU-energy evidence, not a battery or GPU
measurement. It cannot establish a total idle-energy improvement when most idle
CPU work belongs to short-lived helpers outside that counter boundary.

The unchanged app's median active instruction count increased 18.28 → 19.44
billion (+6.4%), with more instructions in every pair. Its median CPU time and
kernel-accounted CPU energy also increased. Core scheduling can make CPU time
and energy disagree, but it does not explain away the additional instructions.
The smaller CPU increase than in the first experiment does not resolve the
connected-workspace comparison. Its visibility gap, investigated below, prevents
interpreting those figures as representative hidden-app performance.

A separate five-second native stack sample observed Flutter rasterization and
Impeller text rendering while AppKit reported the benchmark hidden and its
window invisible before and after the phase. Profiling overlapped the workload,
so that diagnostic's timings are excluded from comparisons.

## Lifecycle diagnostic and stricter acceptance

Two new isolated builds added observation only: Flutter lifecycle/frame counts,
AppKit occlusion and the native delegate identity. Both diagnostic runs completed
their terminal-output checks and cleaned up. In the first, the hidden app drew
**343 frames in ten seconds** of active output. A second reproduced the same
condition, drawing **196 frames in five seconds**. In both, Flutter's lifecycle
remained null and frame scheduling stayed enabled. AppKit reported the app and
window occluded even at startup, and the app never became active.

The native `AppDelegate` existed and conformed to `FlutterAppLifecycleProvider`
before engine construction and afterwards. That rules out the simple missing-
delegate hypothesis in this fixture; it does not establish whether the missing
notifications arise from the launcher/environment or affect the shipped app.
The app log also reports unavailable persistent GPU disk caching in this sandbox.
These short runs diagnose the measurement boundary, not performance improvements.
The [retained observations](2026-10-03-connected-lifecycle-diagnostic.json)
include both independent state sources and source/build hashes.

The runner now requires Flutter `resumed` with frames enabled for foreground
phases, and `hidden` with frames disabled for background phases. It also rejects
frames drawn during a settled hidden phase. Missing observations require a new
fixture build. Rejected observations are saved with cleanup results. Previous
trials passed their then-existing native checks, but cannot be retroactively
certified against this additional framework check. Establishing a representative
lifecycle transition is required before further background comparisons.

### Locked console and installed-app observation

At 01:52:57 UTC on October 3, the on-console session explicitly reported its
screen locked. It still reported locked at 02:17:30 UTC. That is a concrete
environmental obstacle to establishing the fixture's foreground transition;
older runs did not record lock metadata, so this observation cannot establish
their console state retrospectively. The runner now rejects a known locked
console before creating its app, daemon or tmux. An actual invocation exercised
that rejection without starting any fixture processes. Missing lock metadata
remains unknown and does not bypass the independent lifecycle acceptance checks.

A read-only five-second sample of the already running installed Harness 1.2.54
at 02:18:10 UTC found its raster and I/O threads waiting in all 3,809 observations
of each thread. The main thread mostly waited for events. Its executable/PID/start
identity was unchanged across the sample; no app controls, restart, or session
changes were made. This short sample did not reproduce the fresh fixture's
continuous hidden rendering. It is neither a before/after comparison nor proof
that every product background workload is inexpensive.

A separate 35-second profile of the private daemon with ten idle shells found
99.3% of sampled JavaScript time idle. Its external process helpers still ran:
after the first five seconds, eight full process-table queries, seven executable
image queries and fifteen tmux inventory/title queries were observed. One
external Codex inventory query also ran during startup. Their recorded durations
are wall time, and instrumentation perturbs them; the profile identifies work
to investigate rather than establishing a resource saving.

## Candidate and command-level evidence

- Baseline CLI: `29e03783d3eb94c3a42969dbb9facce7915103e7`.
- Candidate CLI: `e2801a8b4f1761b542a7bd64c6ffdc586e1501fb`.
- Both use the same native app from the
  [earlier connected comparison](2026-10-02-connected-workspace-resources.md).
  Production Dart, native runner and package inputs were unchanged between its
  source and this candidate. Exact CLI bundle and tooling hashes are in the data.
- Installed macOS `lsof` 4.91, Node 22.23.2, Flutter 3.47.2/Dart 3.13.2, native arm64.
  The prior host record is Mac14,6 with 64 GiB RAM and 12 logical CPUs.

The candidate first uses `lsof -b` for executable text paths, then retries only
missing identities with the ordinary probe inside the existing three-second
budget. It retains fresh per-scan identities and the existing discovery cadence.
Partial/truncated output, unavailable helpers and same-PID exec are covered.
The [lsof documentation](https://github.com/lsof-org/lsof/blob/master/docs/manpage.md)
describes `-b` as avoiding potentially blocking filesystem operations. Darwin's
[text-region reader](https://github.com/lsof-org/lsof/blob/master/lib/dialects/darwin/dproc.c)
obtains mapped paths through libproc. Actual local checks supplement that upstream
evidence; it is not proof about every installed lsof build.

A separate six-round command comparison over ten disposable sleep processes
measured median CPU **50.657 → 25.709 ms (−49.2%)**. This is command CPU, not app
power. Renamed, Unicode, symlinked and hard-linked native images resolved correctly;
a private tmux pane's same-PID exec was discovered and later removed. An
instrumented connected run observed three image probes, no image fallbacks and
no errors. Its separate Codex process-inventory lsof invocation was excluded
from the image-fallback count.

Splitting `ps` into a thin inventory plus a detailed selected-PID pass was rejected:
their measured costs summed to about 65 ms versus about 52 ms for the original
single pass. No production change was made for that experiment.

## Evidence and limits

The [data](2026-10-02-daemon-process-discovery.json) include all six fresh-process
runs, paired changes, component CPU, output counts, native states, aggregate
samples, source hashes, cleanup outcomes and the same-process diagnostic. Full
private raw samples remain in the temporary run directories named in the local
receipts. Failed attempts contribute no timings: the initial sandbox denied a
loopback bind before daemon/app startup; a separate foreground diagnostic lost
focus and cleaned up. Five-second calibration and fallback tracing are not
performance trials. An early native test copied an Apple system binary and hit
a launch-constraint failure; the final test compiles its own disposable binary.

Full CLI CI and native fixture integration passed; the receipt and exact scope
are in the PR. Installed-engine/account matrix rows were not exercised, and
skipped checks are not described as passing.

The workspace is signed out and uses deterministic terminal workers. Installer,
sign-in and update acquisition are substituted; the real local daemon and terminal
transports run, with private data and sockets. Existing user sessions are untouched.
The sampler includes live processes and kernel-accounted exited children in the
selected trees, but excludes shared system services such as WindowServer and
processes that reparent outside those trees. Summed footprints can count shared
mappings more than once.

**CPU time and wakeups are not GPU energy, battery discharge or a measurement of
macOS's “Using Significant Energy” classification.** The mixed connected results
and missing physical energy measurement are why whole-app energy savings remain
unverified. Next work must isolate active-output cost and measure representative
power use before claiming an overall improvement.
