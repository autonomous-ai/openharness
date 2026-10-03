# hn merge verification — 2026-09-28

PR [#365](https://github.com/autonomous-ai/openharness/pull/365) adds the hn terminal
client, its CLI entry point and installer support. The user authorized fixing and
merging the PR. The creature is excluded from the TUI. Publishing a CLI/TUI release
and replacing an installed hn are separate actions and were not performed here.

## Tested revisions

The final macOS release binary was frozen from
`81a7ef3c1d7981643489d8b35016a8a12d85acd6`, with SHA-256
`022a10f739a740be9c7151db27c2f36b606c7634937c79547e55ba1778f5eda6`.

The subsequent commit `19698dbe8d20838d00dcc577f0832707bbf02855` changes only
`cli/src/dsh/install.spec.ts`: its fake clock now advances through the three-second
SIGKILL grace period before returning to real timers. Otherwise an interactive
shell that ignores SIGTERM can leave the test waiting for its real sleep to end.
The same file's example path was made non-personal. The TUI and all production
code are identical to the frozen revision. The final verification commit adds only
documentation.

## Verification

| Gate | Result |
| --- | --- |
| macOS release build and Rust unit tests | Passed; 122 tests. |
| Vendored Alacritty grid suite | Passed; 25 tests in a disposable Cargo workspace. |
| Full mock-daemon E2E | Passed, including rapid Escape/prefix use, pane/window lifecycle, detach, and replacement-question refusal. |
| Persistent native shell integration | Passed: exact 176 KB paste, environment, cwd, PID, history, detach, headless crash, split/window/popup, daemon arrival/loss/reconnect, and cleanup. |
| Native terminal integration against tmux | Passed: retained exits/signals, hooks, respawn metadata and window selection, immediate exits, startup typeahead, and exact 1×1 PTY geometry. |
| Terminal attributes | Passed all four native captures and all four outer-terminal repaint comparisons, including double underline, blink and overline. |
| Final independent question-hook replay | Passed on the frozen revision: a stale hook sends no answer; valid `run-shell` and `if-shell` callbacks retain their original question and harness after focus changes. |
| Local updater coverage | Passed: 838 tests, 9 skipped; 100% statements, branches, functions and lines for all four files in the existing coverage gate. |
| Final Linux/CLI/backend CI | Passed: [run 36381895961](https://github.com/autonomous-ai/openharness/actions/runs/36381895961) on `19698dbe`. All four jobs succeeded: Linux x86-64 and ARM64 static builds, Rust tests and all four integrations; Node 22.23.2 typecheck, 5,759 CLI tests (37 skipped), 838 updater tests (9 skipped) and 100% coverage; backend desk compatibility. |

The final native startup check reached its first screen without a DA1 reply in
51 ms for hn and 49 ms for tmux. This is one local measurement, not a performance
claim for arbitrary hosts.

Earlier CI failures were repaired before the final gate: a stale pnpm lockfile,
Cursor test fixtures inheriting runner XDG configuration, the separate-read Escape
regression, and the updater test's fake-timer cleanup. Coverage thresholds and test
expectations were not relaxed.

## Review panel

Each reviewer used frozen copies, explicit private sockets, guarded mock ports,
and disposable homes, comparing with tmux 3.5a or fzf 0.67.0 where applicable.
Reports identify the initial revision and any subsequent focused correction build.

| Review | Score | Report |
| --- | --- | --- |
| tmux commands, formats and sessions | 9/10 | [Round 20 tmux](2026-09-28-hn-round20-tmux.md) |
| fzf lists and previews | 9.5/10 | [Round 20 fzf](2026-09-28-hn-round20-fzf.md) |
| Harness workflows | 9/10 | [Round 20 agents](2026-09-28-hn-round20-agents.md) |
| Terminal rendering and interaction | 9/10 | [Round 20 feel](2026-09-28-hn-round20-feel.md) |

The reproduced round 19/20 findings were corrected and their matching cases replayed.
The final candidate includes native respawn metadata/window fixes, one-column grid
handling, conservative colour negotiation for unknown terminals, and the Escape
reader correction. The integration suites above run against the combined result.

## Reproduction and isolation

From `tui/`, after a release build:

```sh
cargo test --release --offline
E2E_PORT=19297 HN_SOCKET_NAME=hn-verify bash tests/e2e.sh
HN_LOCAL_TEST_PORT=19441 HN_LOCAL_TEST_PREFIX=hn-local-test-verify python3 tests/local-shells.py
HN_NATIVE_TEST_PORT=19433 HN_NATIVE_TEST_PREFIX=hnt19fixnativeverify python3 tests/native-terminal.py
HN_ATTR_TEST_PORT=19412 python3 tests/terminal-attributes.py
```

The integration drivers create private homes and sockets, guard their test ports,
unset inherited TMUX/TMUX_PANE/HN_SOCKET for hn, and clean up their owned processes.
Every hn invocation uses explicit `-L` and `--port` with matching PORT and
HN_SOCKET_NAME. The daemon cases require `cli/node_modules`; all reference tmux
servers are private. These checks used no default server, installed hn, production
daemon or real harness. Cleanup checks found no owned process or test-port listener.

## Limits

These are bounded compatibility reviews, not proof of complete tmux/fzf equivalence.
Fleet workflows use the mock daemon. No live provider-agent session or fresh SSH
installation was exercised. Linux x86-64 and ARM64 behavior is covered by CI's
static builds and the four integration drivers. Individual reviewer reports retain
their narrower limits and evidence; earlier dated handoffs remain historical records.
