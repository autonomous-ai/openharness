# Bounded session metadata reads — October 2, 2026

Fallback discovery for Claude, Pi, Command Code and Amp used `readFile` on the
entire transcript, then inspected only its first 256K JavaScript characters and
20 lines. A long conversation therefore caused large allocations just to learn
its directory. A sufficiently large file could also exceed V8's maximum string
length and quietly return no matching session despite a valid opening header.

Discovery now reuses the existing bounded header reader. Its 1 MiB byte cap is
sufficient to preserve the old 256K UTF-16 character budget with any UTF-8 text,
including a cutoff inside a surrogate pair. The 20-line limit, first declared
directory, ambiguity rules, timestamps and session IDs are unchanged. The shared
header helper now fills partial reads, stops at EOF and decodes only bytes read;
its existing Claude-continuation caller retains its own 256 KiB limit.

That caller also compared decoded character count against a byte limit. A real
file probe found ASCII continuation headers worked while equally large BMP/emoji
headers stranded the conversation. The helper now returns bytes, and each caller
decodes them explicitly: continuation checks count bytes, while directory scanning
keeps its existing character budget. Small background-only sessions remain rejected.

## Measured result

[Raw measurements](2026-10-02-session-metadata-reads.json) use the public
`findLiveSession` path, one real synthetic transcript per scan, minified bundles,
macOS ARM64 and Node 22.23.2. Three paired trials per size alternate order and run
in fresh processes. The baseline is commit `4e4f8af23a0f294f4594fcbc0d176aceb4443bb8`.

| Transcript payload | Median elapsed, before → after | Peak worker RSS, before → after |
| --- | ---: | ---: |
| Header only | 0.270 → 0.329 ms | 66.17 → 66.19 MiB |
| 1 MiB | 0.678 → 0.515 ms | 68.23 → 67.16 MiB |
| 64 MiB | 22.373 → 0.540 ms | 197.91 → 66.98 MiB |
| 256 MiB | 81.404 → 0.541 ms | 588.39 → 67.14 MiB |
| 513 MiB | 118.682 → 0.554 ms | 596.09 → 68.06 MiB |

For 256 MiB, elapsed time falls **99.33%**, CPU **98.23%**, and peak RSS **88.59%**.
The header-only case is 59.1 microseconds slower (21.9%), with 4.5% higher measured
CPU; no tiny-file speedup is claimed. Peak RSS includes process startup and warmup.
Explicit GC runs only in disposable benchmark children before timing. These are
component measurements, not whole-app energy savings or retained daemon memory.

All 24 trials up to 256 MiB return the same session identity and transcript name.
For 513 MiB, all three baseline trials return **null** while all three candidate
trials find the valid session. That row compares a failed scan with a successful
one, rather than equivalent useful work. The fixture exceeds this Node runtime's
536,870,888-character maximum string length.

Reproduce with CLI dependencies installed and a new output directory:

```sh
node cli/scripts/benchmark-session-metadata.mjs 4e4f8af23a0f294f4594fcbc0d176aceb4443bb8 /tmp/session-metadata-comparison-new
```

Workers have 60-second deadlines and private data, runtime and authentication
directories. Their synthetic files are removed after each size; no live session
store is used or changed.

## Validation and delivery

178 affected tests and typecheck passed. The tests cover all four engine layouts, the exact line and Unicode
character boundaries, the first declared directory, files beyond the JS string
limit, bounded actual reads, partial reads, early EOF, read errors and handle
cleanup. ASCII/BMP/emoji continuation checks include rejection of small background-only
sessions. Existing discovery ambiguity, restart and Claude-continuation tests
remain in scope. Typecheck and final counts are recorded on the eventual PR.

Five native checks passed using tmux 3.7c, Claude 2.1.287 and Pi 0.85.1 with
private tmux sockets and disposable engine profiles: lifecycle, Claude/Pi process
discovery and removal, literal input, and the restart capability-probe race.
Auto-updating and nonessential traffic were disabled. Fourteen matrix rows were
skipped: affected Command Code/Amp binaries are unavailable, and other engine
rows were outside this change's scope. No model prompt or paid request was sent.

The exact original user-request timestamp is unavailable. Initial local checks
completed around 19:44:50 UTC. The Unicode correction passed its final affected
checks at 20:13:33 UTC; the final benchmark timestamp is in the raw result. Source
identity, CI and merge evidence are tracked separately in the PR. GitHub connectivity is currently blocking shipping. The full CLI CI scope is
still required before merge. Publication and app/daemon updates are excluded by
the user's weekend hold.
