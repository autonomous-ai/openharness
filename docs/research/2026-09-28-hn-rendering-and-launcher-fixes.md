# hn rendering and launcher fixes after round 19

The round 19 reference build was `32f43bb0d541445c312b739d39c2d9265ca45c6a`.
The user requested finishing and merging PR #365 and keeping the creature out of the TUI.
This authorizes the PR merge only; no release, installed-binary replacement or release
workflow is part of this work.

## Rendering

The pane emulator now preserves double underline (SGR 21), blink (5/6 and reset 25)
and overline (53 and reset 55). It also accepts tmux's overline capture spelling, `5:3`.
The two pinned terminal crates are vendored with their licenses and small marked changes;
the native grid handles erase, scrollback, alternate screens and snapshots consistently.

Underline style, overline and hyperlink changes now trigger a repaint even when the
character and ordinary ratatui modifiers are unchanged. Drawing an overlay clears the
underlying pane's extra attributes. `set -g @hn-animations off` keeps loading indicators
still, including search spinners. The default animation cadence remains ten frames/second.

`tests/terminal-attributes.py` compares both native `capture-pane -e` and the actual outer
terminal with tmux 3.5a. All four cases match: initial attributes, underline-only change,
overline-only change and reset to plain text. The old round 19 binary fails these cases.
Three release unit tests cover capture, snapshot restoration and writer resets. A three-second
stationary demo observation produced 2,490 output bytes with animations on and zero with them off.

The README screenshots were refreshed from isolated demo-fleet terminal captures. They show
the bottom status line, use a demo hostname and contain no creature. Their caption says how
they were rendered.

## CLI launcher

The launcher honors a valid explicit `--port` while bootstrapping. Failed sign-in, daemon
startup failure and daemon timeout continue into hn's persistent local shells. Command-only,
help and invalid-argument invocations do not start the daemon. Eight launcher tests pass with
all subprocesses and network calls mocked. TypeScript checking passes in an isolated install.

The pnpm lockfile now includes dependencies already recorded in package.json and the npm
lockfile. The frozen pnpm check passes. Dependencies were installed into a disposable copy
for verification; the shared worktree node_modules were not modified.

## Isolation

Native attribute comparisons use unique frozen binaries and sockets, private HOME/HN_TMPDIR,
explicit guarded ports 19410–19419, and no inherited TMUX, TMUX_PANE or HN_SOCKET. Every real
tmux server has its own `-L`. The demo capture used mock port 19413. No default socket or real
daemon was contacted. Scripts clean up their exact owned clients, supervisors, shells, mocks
and named tmux servers. Evidence remains in private temporary directories; public reports
contain no private machine paths or real hostnames.

Final combined tests and the independent panel rechecks are recorded separately.
