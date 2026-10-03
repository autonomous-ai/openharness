# Buffered desktop diagnostic logs

Routine desktop DEBUG logging now batches durable file appends instead of
synchronously opening, writing and flushing the file for every record. The
batch has a one-second deadline from its first record and limits of 256 entries
or 64 Ki UTF-16 characters. It does not keep an idle timer running.

## Measurement

On macOS 26.6.2 arm64 with Flutter 3.47.2 / Dart 3.13.2, the real-file component
benchmark alternated the order of immediate and buffered runs. It compared
legacy immediate `File.writeAsStringSync(..., flush: true)` appends with buffered
native `O_APPEND` writes followed by `fsync`; both used the candidate logger's
formatting. This was not a comparison of two application binaries. No other test suite or
analyzer ran alongside this measurement. The source base was `922c9dc9c`.

| Workload | Paired trials | Durable appends, before → after | Reduction | Median synchronous logger time, before → after |
|---|---:|---:|---:|---:|
| 64 DEBUG records at 8/sec, plus 2 warnings | 3 | 66 → 8 | 87.9% | 43.444 → 10.528 ms (75.8% less) |
| 2,000 DEBUG records in a burst, plus 62 warnings | 5 | 2,062 → 63 | 96.9% | 112.062 → 5.860 ms (94.8% less) |

Every paired run produced byte-identical final log files. The counters record
successful durable append operations; real filesystem writes and flushes run
in both modes.
Timing includes synchronous append and timer/explicit flush execution and
excludes the intentional waits in the paced workload. It does not include all
upstream formatting or protocol handling.

These are component measurements, not whole-app CPU, frame latency, energy-impact
or battery-life improvements. Retained log bytes are unchanged. A five-second
sample of the deployed app showed synchronous Dart file writes on its main
thread, but did not identify the exact Dart caller; that sample alone cannot
attribute all those writes to this logger.

Raw measurements and source hashes are in
[`2026-10-02-buffered-diagnostic-logs.json`](2026-10-02-buffered-diagnostic-logs.json).
Reproduce from `desktop/`:

```sh
DIAGNOSTIC_LOG_BENCH_OUTPUT=/tmp/harness-diagnostic-logs.json \
  flutter test --no-pub test/benchmarks/diagnostic_log_benchmark.dart
```

## Behavior and durability

- INFO, WARN and admitted ERROR records immediately commit their preceding
  buffered context. Repeated errors suppressed by the existing burst filter
  retain that protection.
- The Debug mirror receives entries immediately. Log export, app backgrounding,
  normal quit, disposal and updater handoff flush pending diagnostics.
- An abrupt process kill can lose the pending DEBUG batch. The one-second timer
  can run late if the app's event loop is blocked or the process is suspended.
  Conversation history and CLI transcript flushing are unchanged.
- Oversized entries write directly. Day changes preserve the original record's
  file, including a timer firing after midnight or a backwards wall-clock jump.
- Disk failures remain best effort: the failed batch is dropped instead of
  accumulating an unbounded retry queue.

Concurrent writers exposed an existing append race: the
[Dart macOS file implementation](https://github.com/dart-lang/sdk/blob/main/runtime/bin/file_macos.cc)
seeks to EOF when opening an append handle. Two handles can then write at the
same position. macOS and Linux now use `O_APPEND` with close-on-exec, handle
partial writes and interrupted syscalls, and close their descriptor on failures.
Other platforms retain their existing Dart IO implementation. Mixed-version
writers still include the older writer's behavior.

## Validation

On macOS arm64, 118 focused tests passed; one Linux-only `/dev/full` error-path
test was skipped. Four concurrent real Dart processes retained all 2,000 records
and per-writer ordering. These checks cover real files, deadline/size limits,
shared writers, errors and stacks, Debug mirroring, log export, lifecycle
flushing and real loopback WebSocket event/RPC delivery. Dedicated macOS/Linux
CI runs the append probe and logging regressions.

The full desktop attempt reached 5,282 passes and 15 skips, but did not pass:
23 assertion failures reproduced on an unchanged `922c9dc9c` checkout. Two
settings tests reached their ten-minute timeout; the same files stalled on the
baseline. Both runs were interrupted after preserving their evidence. One
additional file failed to load its Flutter tester and passed in the focused
rerun. Full-suite coverage was not produced; focused coverage does not establish
100% end-to-end coverage. Exact failures are recorded in
[`2026-10-02-buffered-diagnostic-validation.json`](2026-10-02-buffered-diagnostic-validation.json).
