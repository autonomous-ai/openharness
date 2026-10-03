# Reusing terminal drawings after identical redraws

A TUI often clears a row and writes its text back. The final cells can be
identical even though each erase and write advances `BufferLine.paintVersion`.
The renderer previously recorded a new drawing in that case.

`LinePictureCache` now keeps an exact copy of the cells behind each retained
drawing. An unchanged version still uses the existing constant-time lookup.
After a version change, equal cells and the same length and device-pixel phase
allow the previous drawing to be reused. A real change records a new drawing
and refreshes the snapshot, reusing its storage when the capacity matches.
There is no hash collision risk and no delayed output, discarded bytes, or
change to input, parsing, protocol, session lifetime or persistence.

Only rows painted in the last frame are retained. Existing hidden-view, theme,
font and pixel-ratio invalidation still release the cache. Hyperlink destinations
are read from the live buffer by the separate interaction/hover layer; the
row drawing contains cell colors, attributes and content, not the destination.

## Measurements

The [raw record](2026-10-02-rewritten-terminal-lines.json) contains all six
alternating trials, source hashes, validation results and limitations. The
fixture is `desktop/test/benchmarks/terminal_line_redraw_benchmark.dart`.
It measures parsing plus picture recording/replay in headless Debug, with
30 rows and 120 columns per terminal. Each trial has 40 warmups and seven
rounds of 40 frames. Values below are medians of the 21 round means per variant.

| Terminals | Redraw | Before, µs | After, µs | Change |
| --- | --- | ---: | ---: | ---: |
| 1 | Overwrite identical cells without erasing | 119.175 | 122.275 | 2.6% more |
| 1 | Erase and restore every row | 256.150 | 124.900 | 51.2% less |
| 1 | Erase all rows; one final row changes | 233.825 | 127.150 | 45.6% less |
| 1 | Every final row changes | 227.900 | 258.650 | 13.5% more |
| 4 | Overwrite identical cells without erasing | 392.175 | 389.675 | 0.6% less |
| 4 | Erase and restore every row | 938.375 | 483.425 | 48.5% less |
| 4 | Erase all rows; one final row changes per terminal | 923.200 | 498.700 | 46.0% less |
| 4 | Every final row changes | 953.275 | 959.900 | 0.7% more |

This is a tradeoff: exact snapshots avoid re-recording identical drawings but
cost memory and copies when every row changes. The single-terminal all-change
control adds 30.750 µs per parse/record iteration; the four-terminal control adds
6.625 µs. It is not a universal speedup. At this geometry, snapshots retain
60 KiB of raw cell storage per terminal, or 240 KiB for four, excluding object
overhead. They do not retain additional scrollback or hidden-view drawings.

The benchmark excludes native rasterization, display presentation, networking,
agent work, GPU energy and battery life. It does not establish a whole-app CPU
improvement or removal from macOS's significant-energy list. Other applications
and real agents remained running; our builds, tests and profilers did not run
concurrently with these benchmark trials. The earlier prototype comparison is
not used for the table.

Baseline is `a5b233d8ebf2ea9d3026da5c8547530af5cc93c0`; candidate starts at
`f537725295864d8150d439289dc24cf4f870e226`. All xterm Dart library files and the
dependency lockfile match between those sources except the changed cache file.
The identical fixture ran with Flutter 3.47.2 / Dart 3.13.2 on macOS arm64.

## Validation

- 143 affected unit/widget tests passed: cache invalidation, terminal sessions,
  hidden renderers, links, focus, scrolling, alternate buffers, themes and fonts.
- 42 exact RGBA comparisons passed in the headless renderer and the same 42
  passed in the native macOS renderer: repeated erases, real text/style changes,
  Unicode, hyperlinks, insertion/deletion, resizing, alternate screens, scrolling,
  font size and text scale, at 1×, 1.5× and 2× pixel ratios.
- The native run also passed both existing terminal journeys: keyframe replacement
  with continued input and switching agents with one retained terminal view.
- All 42 executable lines of `line_picture_cache.dart` were exercised. This is
  line coverage of that component, not 100% end-to-end coverage of Harness.
- Analysis of the five changed Dart files passed with no issues.

The first fixture compilation used a nonexistent circular-buffer `.first`
getter; it was corrected to `[0]` before the passing validation plan. The native
launcher reported that it could not foreground the app, then connected and
passed the renderer/input checks. These are native rendering and framework-input
checks, not foreground latency or physical keyboard/IME measurements.

Required validation ran from 14:59:03 to 14:59:49 UTC on October 2. The receipt
confirmed unchanged source throughout. The normal review build is restored
after the native fixture. Its first invocation failed before building because
Flutter was absent from PATH; the retry explicitly supplies the pinned SDK.
The original user-request timestamp is not available in this continuation.
Merge and publication times are recorded in the pull request.
