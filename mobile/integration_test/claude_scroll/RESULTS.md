# Claude Code scroll: why it changed, and what it measures now

Measured 2026-10-24 on an iPhone 14 (60 Hz) and a Galaxy S23 (120 Hz), profile
builds, touched through the device's own dispatch (`../perf/gestures.dart`).
**Old** is `3c024672b` on `feat/mobile-ios-android`; **new** is the commit that
added this file. How to run each benchmark: `../README.md`, "Claude Code's
fullscreen scroll". Raw results land in `build/claude_scroll/` and are not
committed.

- **Follow** — how far the content moved against the finger; 100% is a native
  list.
- **Drift** — rows the content kept moving after the finger and its fling
  stopped.
- **Stalled** — frames the content stood still under a moving finger.
- Ranges span the 2–3 rounds of one run.

## What was wrong

The phone draws Claude Code's fullscreen scroll from a local mirror of its rows
and asks Claude Code for more with wheel events and Page Up/Down. The old
mirror:

- moved the content 11–78% of the finger on the first drag after an agent
  opened, then drifted up to 6.5 rows. It did not know which rows scroll
  until Claude Code had answered a scroll;
- followed the first flicks at 28–67%. It asked one page per round trip, and
  only once the finger reached the last row it knew;
- stalled 76–287 frames on a flick back down to the newest row.

Frame rendering was not the cause. The Play build, with the old code,
presented 107–116 fps on the S23 while the content moved (SurfaceFlinger
`--latency`). In the benchmark, both builds build 96–99% of frames inside the
8.3 ms budget on slow reading drags.

## What changed

In `third_party/xterm/lib/src/ui/` (`remote_scroll_mirror.dart`,
`scroll_handler.dart`, `render.dart`); entry 21 of
`third_party/xterm/README.autonomous.md`.

| Change | Why |
|---|---|
| The next page is asked when the finger is within 80 ms of the last known row | a fling no longer waits a round trip at each edge |
| Up to 3 Page Up/Down sent in one batch, where they land among rows already known | one round trip instead of three |
| Which rows scroll is read off the prompt box once Claude Code has been quiet 300 ms | the first drag moves 1:1 |
| 400 rows above fetched 500 ms after opening (was 120 rows after 1200 ms) | the first flicks find rows already there |
| The blank row over the prompt box never counts as a scrolling row | it is the same in every frame, so it looked like one |
| "Quiet" waits 1.25× the measured answer time, at most 1 s | a slow link's late answer is not taken for a new frame |
| While the spring catches up, a finger move reaches the screen in the same frame | removes a lag that grew with finger speed |
| A Page Up that moves nothing marks the top of the transcript | flicks at the top stop on the top row |
| Frames placed by row-signature votes (`bestPlacing`) | same answer as trying every placing, less work |
| The mirror exists from the first frame for Claude Code terminals | the first drag is drawn from it too |

## Results

### iPhone 14, fake Claude Code, ~100 ms an answer

| Scenario | Old | New |
|---|---|---|
| First drag | 29–44%, drift ≤ 4 rows | **100%**, drift 0.4 |
| Reading drag | 100% | 100% |
| Flick up | 28–49% | **75–78%** |
| Flick on into unfetched rows | 38–45% | **64–67%** |
| Flick back down | 57–63%, 76–124 stalled | **100–101%**, 0 stalled |

### iPhone 14, fake Claude Code, slow link (~200 ms round trip)

| Scenario | Old | New |
|---|---|---|
| First drag | 27–38% | **100%** |
| Reading drag | 99–100%, 9–12 stalled | 100%, 0 stalled |
| Flick up | 31–35% | **65–67%** |
| Flick on into unfetched rows | 29–30% | 33–38% |
| Flick back down | 101% | 101% |

### iPhone 14, real app, a real agent over the real link

Its transcript was about 200 rows, so flicks reached its top in both builds.

| Scenario | Old | New |
|---|---|---|
| First drag | 11%, drift 6.5 rows | **100%**, drift 0.4 |
| Flick up, before / after the same-frame finger move | 50–51%, error p95 4.8–5.0 rows | **101–102%**, error p95 0 |

### Galaxy S23, fake Claude Code

| Scenario | Old | New |
|---|---|---|
| First drag | 33–40%, drift 3.6–4.2 rows | **100%**, drift 0.3 |
| Reading drag | 100% | 100% |
| Flick up | 45–51% | **72–82%** |
| Flick on into unfetched rows | 42–45% | **57–73%** |
| Flick back down | 54–63%, 197–287 stalled | **97–101%**, 0–22 stalled |

### Galaxy S23, real app, a real agent with 408 rows above, Wi-Fi

First round / second round.

| Scenario | Old | New |
|---|---|---|
| First drag | 78%, drift 3.5 / 92%, drift 1.9 | **100%**, drift 0.3 / 100% |
| Reading drag | 100% / 101% | 100% / 100% |
| Flick up | 67% / 91% | **97%** / 103% |
| Flick on into unfetched rows | 63% / 92% | **99%** / at the top |
| Flick back down | 88%, 26 stalled / 97%, 44 stalled | **101%** / 101% |

### Galaxy S23, real app, same agent, 4G (LTE, ping 51–196 ms, average 123)

First round / second round.

| Scenario | Old | New |
|---|---|---|
| First drag | 77%, drift 3.4 / 92%, drift 2.0 | **100%**, drift 0.3 / 100% |
| Reading drag | 100% / 100% | 100% / 100% |
| Flick up | 52% / 91% | **93%** / 101% |
| Flick on into unfetched rows | 46% / 63% | **72%** / 101% |
| Flick back down | 63%, 207 stalled / 83%, 169 stalled | **95%**, 89 stalled / 101%, 0 stalled |

Not measured: a very weak or lossy link (3G, packet loss), and whether 4G
went peer to peer or through the relay.

## Tests

- `test/remote_scroll_mirror_test.dart`: 14 tests against a fake Claude Code.
  Covers `bestPlacing` against brute force, the fling page lead, reattaching
  from memory, trimming on a long read, prompt-box seeding and prefetch,
  multi-page batches, never blanking a row, getting back to the newest row, a
  slow link, the chase following the finger, and a busy program not being
  seeded. Each fix was reverted once to check its test fails.
- `flutter test` on the 73 test files that touch the terminal: 1269 passed,
  27 skipped, 0 failed. `flutter analyze` on the changed files: no issues.
