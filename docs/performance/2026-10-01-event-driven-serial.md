# Idle serial transport: wait for kernel readiness

An open, silent serial port retried `FileHandle.read` every 5 ms after `EAGAIN`.
This avoided occupying a libuv worker indefinitely, but kept waking the daemon
even when a dial had no data. The replacement uses Node's full-duplex TTY stream
and libuv readiness notifications. Frame ordering, raw binary data, nonblocking
close and `O_NOCTTY` are preserved; no native dependency is added.

## Matched measurements

macOS 26.6.2 arm64, managed Node 22.23.2/libuv 1.51.0. Each observation opens
one or three **owned, silent PTYs**, warms for 350 ms, and records 12 seconds of
Node CPU time. Three observations per variant and port count alternate order.
Initialization and teardown are outside the interval. The measured candidate
precedes the write-callback cancellation guard; that guard is inactive during
this idle workload. The raw record preserves the exact measured source hash. A calibrated native
sampler records CPU, footprint and interrupt wakeups over 10 seconds inside it.

| Open ports | Node CPU before → after, % of one core | CPU reduction | Interrupt wakeups/sec before → after |
|---|---:|---:|---:|
| 1 | 1.6197 → 0.0914 | 94.35% | 371.70 → 1.90 |
| 3 | 2.1109 → 0.1076 | 94.90% | 388.80 → 1.90 |

Values are medians. Interrupt wakeups fell 99.49–99.51%. All 12 observations are
retained in [the raw record](2026-10-01-event-driven-serial.json), including
source hashes, runtime versions and every native sample. Native CPU numbers
differ slightly because their interval is shorter. Node context-switch counters
are not used as wakeup counters. Neither variant wrote disk data while idle.

These results concern an open serial transport, **not whole-app CPU, battery
life or the macOS energy warning**. Machines with no open serial ports do not
incur this polling cost. No real USB device, installed app or user daemon was
opened, stopped or restarted for these measurements.

## Correctness and compatibility

- Raw 64 KiB input with all byte values; two concurrent 1 MiB output frames,
  deliberately backpressured, checked byte-for-byte and by SHA-256.
- Unplug/EOF and explicit close during blocked writes: active and queued writes
  reject, the close callback runs once, and later writes fail.
- The native worker is a detached session leader. Unplug must not terminate it
  with `SIGHUP`; retaining `O_NOCTTY` is essential.
- Eight idle open/close cycles with one libuv worker: DNS, HTTP and file I/O
  remain available, descriptors do not accumulate, an unrelated file descriptor
  survives serial close, and close needs no input.
- Unit checks cover direct versus duplicated native descriptor ownership,
  constructor/configuration failure, frame ordering and callback failures.
- All 421 cable tests passed on managed Node 22.23.2/macOS, plus TypeScript
  checking. All 40 guard fuzz tests also passed on Linux after the correction.
  The transport class has 62/62 statements and 16/16 functions covered;
  macOS covers 24/25 branch arms, with the remaining arm
  selecting Linux's `stty -F`. The unchanged discovery code is not fully covered.
  All 19 serial unit/native tests passed on each of the four compatibility rows:
  Node 20.19.0 and 22.23.2 on macOS and Linux. Physical USB hardware is not covered
  by the PTY tests.

The broad local CLI run passed 8,276 tests and skipped 45, but failed 15 checks in
three unchanged suites: hook subprocess deadlines, installer subprocess deadlines
and installed OpenCode flags. A clean-main run reproduced hook deadlines and all
five OpenCode failures; its installer checks passed. An isolated candidate run
passed all 100 hook/installer checks and retained the five installed-OpenCode
failures. These results are retained as failures, not reported as a completely
green local suite.

On the corrected commit, the full Linux CLI job passed 8,287 tests (50 skipped),
all 40 guard fuzz tests, TypeScript checking, the launcher upgrade check and
844 updater tests (9 skipped, the existing updater coverage gate remains 100%).
The four native serial compatibility jobs also passed. The first full CI run
passed both Linux TUI end-to-end jobs; the corrected run hit the unchanged ARM
native-terminal `respawn death` timing check, then passed its isolated job rerun.
All jobs finished green in [CI run 36949101625, attempt 2](https://github.com/autonomous-ai/openharness/actions/runs/36949101625).
The failed first attempts remain available for inspection. Only this validation
note changed after the tested production commit `ac6cb26ed2e8294a10006fb3786ce7b1158fd633`.

The first native compatibility run caught a Node 20 cancellation difference on
both operating systems: its write callback can omit an error after stream
destruction. The production callback now rejects when the link or stream is
closed, so an interrupted frame cannot be acknowledged as complete. This is
covered by the existing native unplug/backpressure cases and two focused unit
cases. [Node 20 source](https://github.com/nodejs/node/blob/v20.19.0/lib/internal/stream_base_commons.js#L75-L94).

The implementation reads the internal native handle's `fd` once at construction.
On POSIX, libuv normally reopens the TTY and owns that duplicate; its fallback
adopts the supplied descriptor. The ownership check avoids both a leak and a
double-close. The native compatibility job must remain part of runtime upgrades.

## Reproduction

From the repository root with CLI dependencies installed:

```sh
git show 24128bec34cf24d83f18b6d93f1e20801eac5ca0:cli/src/cable/serial.ts > /tmp/serial-before.ts
python3 cli/scripts/benchmark-serial-idle.py \
  /tmp/serial-before.ts cli/src/cable/serial.ts /tmp/serial-new-run \
  --node /path/to/managed/node
```

Use a new output directory for each run. Add `--sampler /path/to/process-usage-v2`
on macOS to collect native counters using the calibrated sampler built from
`desktop/tool/native_benchmark/process_usage.swift`. The benchmark bundles both
sources with the same esbuild settings, preserves them and every observation,
and closes only the PTYs/processes that it created. The checked-in raw record
was collected with the equivalent driver before it was added to the repository.
