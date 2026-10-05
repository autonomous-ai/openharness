# Finish settings setup before widget tests

The Desktop 1.2.54 [validation record](2026-10-02-accessibility-crash-validation.json)
reported four stalled cases in `share_toolbar_test.dart` and `daemon_off_test.dart`,
leaving both files incomplete. The sharing file also had two recorded assertion errors.

Both fixtures constructed `MemoryExperimentalFeaturesStore` in synchronous `setUp`.
Its constructor starts an asynchronous settings read outside the widget test's fake
clock. Tests then await that pending read from inside the fake clock; the real-zone
completion can leave its continuation queued without another fake-clock pump.
Other cases see settings before initialization finishes. Awaiting `refresh()` in
asynchronous setup completes this work before the widget test begins. Application
code and every existing test assertion remain unchanged.

On macOS arm64, Flutter 3.47.2 / Dart 3.13.2:

- The unchanged `empty and view-only panes keep an inactive Share button` case
  reached the 60-second outer deadline. An instrumented copy stopped at the initial
  settings write before mounting any widget.
- Awaiting setup made all four previously stalled cases pass together in 9.2 seconds.
- Final validation of the actual changed files ran October 2, 15:44:09–15:44:27 UTC.
  All 36 cases passed in 16.716 seconds; changed-file analysis passed in 5.146 seconds
  concurrently. The complete validation plan took 17.037 seconds.
- Tested parent: `dee2f27085e4080628575d2e8fb880053bfc58b1`. The working source remained
  unchanged throughout validation; its receipt fingerprint is
  `71e0f3e8079fbf81fc1d4b6eff7410beb3bb19bb583fb0589713badf5db6c311`.

This removes four known stalls and makes both complete files pass. It does not
establish a passing full Desktop suite or a fixed end-to-end release saving.
No test was skipped, weakened, or replaced with a shorter timeout.
