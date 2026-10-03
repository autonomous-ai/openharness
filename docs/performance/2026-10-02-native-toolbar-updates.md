# Native toolbar update cost — October 2, 2026

One app notification can reach the toolbar through multiple listeners. The toolbar
previously rebuilt its entire payload for each listener, even when equality checks
subsequently suppressed every native message. Its working-session menu also searched
the agent roster for every saved or idle session.

The change combines synchronous notifications into one microtask and reads the final
state once. It also checks the existing processing flag before looking up full activity.
The remaining activity checks still exclude offline, stopped, starting, failed,
waiting, and shell sessions. Terminal input and action routing remain synchronous.

## Measurements

The [reproducible fixture](../../desktop/test/benchmarks/native_toolbar_sync_benchmark.dart)
mounts the real workspace with a mocked native channel. It measures notification and
microtask elapsed time, without pumping Flutter frames. Each scenario has 25 live
sessions, seven rounds, and the same inventory and notification burst on both versions.
Saved inventories of 64/1,000 use 20 warmup turns and 20 turns per round; 4,096 uses
five warmup turns and four turns per round to bound the quadratic baseline.

Baseline: `ce23cf697d9fcae170bb9e43c5457832f0900365`.
Flutter 3.47.2 / Dart 3.13.2, macOS arm64, headless debug execution.
Source fingerprints, all rounds, normalized final payloads and validation evidence
are in the [JSON record](2026-10-02-native-toolbar-updates.json).

| Saved | Working | Notifications per turn | Before, ms | After, ms | Less elapsed work |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 64 | 0 | 1 | 0.666 | 0.403 | 39.4% |
| 64 | 0 | 4 | 1.960 | 0.447 | 77.2% |
| 64 | 0 | 16 | 6.682 | 0.759 | 88.6% |
| 1,000 | 0 | 1 | 13.043 | 1.223 | 90.6% |
| 1,000 | 0 | 4 | 51.061 | 1.265 | 97.5% |
| 1,000 | 0 | 16 | 203.424 | 1.372 | 99.3% |
| 4,096 | 0 | 1 | 195.466 | 3.817 | 98.0% |
| 4,096 | 0 | 4 | 776.287 | 3.982 | 99.5% |
| 4,096 | 0 | 16 | 3,196.470 | 3.918 | 99.9% |
| 1,000 | 4 | 1 | 13.324 | 1.434 | 89.2% |
| 1,000 | 4 | 4 | 52.980 | 1.446 | 97.3% |
| 1,000 | 4 | 16 | 214.392 | 1.562 | 99.3% |

All 12 final payloads were identical. Both versions sent zero redundant native
messages; payload construction dropped from 2/8/32 times per turn to one.
A separate roster-read regression with 1,001 entries dropped from 503,503 reads
to 2,002 when idle, or 3,003 with one working session.

These are component measurements from one sequential baseline/candidate pair.
No owned builds, profilers or other tests ran concurrently; unrelated host activity
was not controlled. They do not establish battery savings or whole-app CPU reduction.

## Validation

- 196 affected unit/widget tests passed: 192 initially, plus four on an isolated
  retry after a runner WebSocket upgrade failure prevented one file from loading.
- Eight selected native macOS workspace journeys passed: reconnect, expiry,
  terminal ownership/input, creation, rename, stop confirmation and restart.
  Six passed initially. Two creation fixtures had obsolete carried-draft
  expectations; they now assert the documented fresh Cmd-N form and enter the
  intended task. Both then passed with terminal/input assertions retained.
- Changed Dart paths analyze with zero issues. All 10 added executable production
  lines are covered by the targeted tests. This is line coverage, not 100% E2E coverage.
- The normal debug app was rebuilt and its signature verified after native fixtures.
- Native checks use an AppKit/Flutter test window and in-memory transports. They
  do not prove physical keyboard/IME behavior or real-engine execution. No full-suite
  pass is claimed. The prior full-suite baseline audit remains separate.

Main through `4b506c872` added release/process tooling and separate CLI companion
changes after validation, with no changes to desktop application sources, test
fixtures or dependency locks. All tested source fingerprints match after that
rebase; merge/release timestamps belong in the PR record.

The broader energy investigation remains open. Removal from the macOS battery menu
and a 100× whole-app improvement have not been demonstrated.
