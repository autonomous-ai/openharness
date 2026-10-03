# Stop clocks for remotely hidden terminal cursors

A focused, interactive terminal kept a 500 ms blink timer after its program sent
DECTCEM hide (`ESC[?25l`). Each callback also requested a terminal repaint even
though the effective cursor stayed hidden. This is common for programs that draw
their own caret.

`TerminalSession` now exposes the program's cursor visibility through a separate
`ValueListenable`. `TerminalPanel` stops its blink clock while that cursor is
hidden, then resumes on DECTCEM show when focus, pane visibility, window lifecycle,
input permission and ticker eligibility allow it. Cursor changes do not emit
session-wide notifications. Local blink changes request paint only when effective
cursor visibility changes. Replacing a session moves the listener; disposal
removes it.

## Measured scope

The same focused-pane fixture ran before and after the change. Ten 500 ms fake-clock
advances cover five simulated seconds after terminal output stops:

| Remotely hidden cursor | Before | After |
| --- | ---: | ---: |
| Active local blink timers | 1 | 0 |
| Timer callbacks in five simulated seconds | 10 | 0 |

This removes all callbacks from that clock while the program hides its cursor.
It does not measure whole-app CPU, GPU, battery life or macOS's significant-energy
classification. Visible cursors retain their normal blink behavior. The
[machine-readable record](2026-10-02-hidden-terminal-cursor.json) includes source
hashes, receipt identifiers, log hashes and the failed baseline reproduction.

## Validation

- **137 affected unit/widget tests passed** on the rebased implementation, covering
  cursor state, terminal sessions, hidden rendering, initial output, focus, input,
  selection and find. Analysis of all five changed Dart files passed.
- **11 distinct native macOS cases have passing evidence:** nine cursor scenarios
  plus the existing keyframe/input and agent-switch journeys. Pixel checks confirm
  hidden, shown, blink-dark and restored cursor output. The scenarios cover split
  escape sequences, visibility changes during the dark phase, inactive windows,
  disabled tickers, hidden/read-only/unfocused panes, session replacement,
  keyframe replacement and unmounting.
- Native validation used in-memory sessions with `FLUTTER_TEST=1`. The normal
  Debug review app was rebuilt afterward; strict signature validation passed.
  No installed app, daemon or real agent was restarted by these checks.

The initial native invocation had eight passes and three instrumentation failures.
The timer probe could not observe timers created from native engine callback
zones after a widget rebuild. Those resume assertions now check the actual cursor
phase before and after 550 ms. All five eligibility cases passed in the targeted
native retry; the other six cases retain their passing results. This is not a
claim that the first native invocation passed. All nine final cursor fixtures
also passed headlessly, then passed again in the rebased 137-test scope.

An earlier unit fixture used an 80×24 keyframe against a 100×30 startup size,
introducing an unrelated resize notification. Matching the startup grid fixed
that fixture before the passing 137-test run. The native launcher reported that
it could not foreground the app, then attached and executed the rendering checks.
These results cover native rendering and framework input, not physical AppKit
keyboard/IME input, foreground latency, Linux or browser rendering.

## Source and timing

Baseline: `56d71adf501b6d85c19334abf20a909a8baa3979` (1.2.54 source).
Validated implementation: `14b2e497a7c58c5c4fcd6d08fb7bc57ad1d651db`, rebased on
`a94c7aa83`. Toolchain: Flutter 3.47.2 / Dart 3.13.2, macOS arm64.

The rebase preserved all changed production code, native fixtures and their
dependencies. Upstream added a headless test binding configuration, so the entire
affected headless scope and analysis were rerun. Native evidence remains applicable:
that configuration is under `test/`, outside the `integration_test/` entry point,
and the native inputs were unchanged. No new runtime/dependency change was made
after validation; this report is documentation only.

Native validation ran from 15:56:09 to 15:59:30 UTC on October 2, including the
targeted retry. The normal review build was restored at 16:01:24. Rebased
validation completed at 16:04:17. Original request time is unavailable in this
continuation; merge time is recorded in the PR. This work is PR/merge only under
the user's release hold. No release is requested by this report.
