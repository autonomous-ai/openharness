# Terminal link hit-testing — October 1, 2026

Long terminal text could stall pointer handling: detecting an ordinary 2,048-character
token took about 44 ms, and finding the underline cells for a 1,020-character URL
took about 176 ms. Both are synchronous work on the Dart UI isolate.

The matcher now rejects text without a supported media suffix before searching
for bare paths, starts relative-path matching once per token, and reuses line
reconstruction, regex matches and target validation while finding one underline.
The temporary lookup is discarded before returning. Output, terminal resizing,
alternate buffers and OSC 8 changes are read afresh on the next pointer event.
Pattern iteration remains lazy so a match does not require parsing later text.

## Paired measurements

Baseline: `1e9352c802209b4bade25b6f9e729af9748c464c`. Both implementations were
compiled into one ARM64 Dart AOT executable with Flutter 3.47.2 / Dart 3.13.2
and the same in-tree xterm. The baseline's only adaptation was importing
`xterm/core.dart` instead of the Flutter umbrella export; its executable matcher
code was unchanged. The [raw results](2026-10-01-terminal-link-hit-testing.json)
include exact source hashes, every observation and environment metadata.

These are **synchronous component elapsed times**, not whole-app CPU, native
pointer latency, GPU presentation or battery measurements. Each case used
20 warmups and 30 observations, alternating which implementation ran first.
Our build/test jobs had completed before this run; ordinary workstation activity
was not disabled. Earlier exploratory runs overlapped validation and are not
used for the table.

| Operation | Baseline median | Optimized median | Time reduction |
| --- | ---: | ---: | ---: |
| Reject plain token, 80 characters | 75.9 µs | 3.9 µs | 94.9% |
| Reject plain token, 512 characters | 2,746.0 µs | 22.1 µs | 99.2% |
| Reject plain token, 2,048 characters | 43,772.6 µs | 88.2 µs | 99.8% |
| Reject that token beside `image.png` | 43,503.3 µs | 199.2 µs | 99.5% |
| Underline extent, 60-character URL | 1,004.8 µs | 70.0 µs | 93.0% |
| Underline extent, 180-character URL | 6,506.2 µs | 242.6 µs | 96.3% |
| Underline extent, 1,020-character URL | 175,729.0 µs | 3,086.0 µs | 98.2% |

Single-cell URL lookup does not use the extent cache. Its medians were
14.9 → 15.2 µs, 33.3 → 34.3 µs and 162.9 → 164.3 µs for those URL lengths;
this run does not show a speedup for that operation. The benchmark uses a
120-column terminal. It does not establish an improvement for every possible
terminal width or output pattern.

## Correctness and validation

The paired comparison passed 10,373 checks over 400 seeded fixtures:
3,468 text offsets, 6,400 terminal cells and 505 underline extents. Cases include
Markdown, quoted media paths, Unicode, punctuation, malformed/unsupported
targets, streamed replacement text, OSC 8 links and resizing. Seed: `551551`.
Focused regression tests cover long neighboring tokens, wide-cell mapping,
disjoint identical links and cache freshness after terminal mutation.

The first full desktop run passed 5,242 tests, skipped 15 and failed four.
All four failures reproduced in an isolated copy of unchanged main: two
tooltip expectations still used “Search harnesses,” one test left activity
timers alive until after widget invariants, and one expected legacy heartbeat
packets to renew indefinitely. Updated fixtures use current “Open Harness”
wording, dispose the notifier inside the test body, and send fresh activity
evidence when testing renewal. The corrected files and existing legacy-heartbeat
safety tests passed all 16 tests. No production activity behavior was changed.

Full-project analysis reported 14 informational lints, all also present on the
unchanged baseline; none is in the optimized matcher or its new benchmark.
Analysis of all eight changed/new Dart entry points reported no issues.

The corrected full suite passed **5,246 tests, with 15 skipped**. A subsequent
coverage run found two previously unexercised lines in standalone painted URL
handling. Adding underlined and indented-colored URL cases, with unrelated prose
before and after the link, brought the focused matcher/panel run to **70 passing
tests and 297/297 executable matcher lines covered**. Only tests changed after
the full-suite run; the production matcher stayed byte-identical. Line coverage
does not establish complete branch or end-to-end coverage.

The new `integration_test/native_terminal_links_e2e_test.dart` also passed all
**19 tests** in an isolated macOS ARM64 Debug app. It runs the existing terminal
gesture/panel scenarios in the native renderer: modifier-click, ordinary mouse
reports, selection, hover updates after output/session changes, wrapped URLs,
missing files, and cancelled/failed previews. Input is dispatched through Flutter;
file reads, downloads, and URL launches are fake. Physical AppKit modifier delivery
and actual external applications are outside that check. `flutter test` in this
SDK does not support `--release`; the AOT timing comparison is separate.

A disposable Release build was also checked through native app controls: long
ASCII URL entry stayed in the selected pane, tab round trips returned to the same
zoomed pane, and neighboring panes retained their contents. An earlier apparent
tab/body mismatch was not reproduced in the freshly launched build; its root
cause was not established, so this is not claimed as a fix for that observation.
The fixture's lifecycle diagnostics and native test log are retained with the
local validation artifacts. No installed app or live user session was restarted.

## Reproduce

From the repository root, with desktop dependencies resolved:

```sh
python3 desktop/tool/benchmark_terminal_links.py \
  --flutter /path/to/flutter-3.47.2 \
  --baseline 1e9352c802209b4bade25b6f9e729af9748c464c \
  --aot --output /tmp/terminal-link-comparison.json
```

Use a new output path for every run. The runner rejects an existing output and
checks that the candidate source and fixture did not change during measurement.
This component result does not establish a 100× reduction in app resources.
