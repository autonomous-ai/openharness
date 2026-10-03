# hn local shells and reconnects — 2026-09-27

With no Harness daemon running, hn now opens a native shell. A private local supervisor owns the PTYs independently of the attached UI or its detached headless holder, so detach, reattach and a client crash preserve the same running shell. Harness links continue reconnecting, and a daemon starting later leaves those local shells intact.

## Implementation

- `local.rs` uses the existing terminal protocol over a namespace-specific Unix socket, with a 0700 directory and 0600 socket. It handles stream ownership, ordered output/keyframes, complete nonblocking input writes, terminal queries, resize, native process/cwd information, natural shell exit and kill-server cleanup.
- Shell/session environment settings, hidden or removed variables, default shell, working directory and terminal type apply to local PTYs. Environment values are passed as child environment entries, never process arguments. Each shell receives a stable `TMUX_PANE` and server socket identity.
- `local_screen.rs` reconstructs normal and alternate screens, history, cursor state, text attributes, hyperlinks, terminal modes, tabs, character sets and unfinished parser input when a client reconnects. Only the PTY owner answers terminal queries; UI mirrors do not send duplicate replies.
- Persistent local panes turn their current desk into an ordinary saved session. This preserves mixed daemon/local windows through reconnection and prevents local pane IDs or private layouts from being sent to Harness. A transient offline popup leaves its parent desk session unchanged.
- Reattachment excludes the new client's own socket from headless handover targets. A crashed holder's socket path can be reused by its replacement UI; previously, stale metadata caused that UI to send `hn-hand-over` to itself and exit immediately.

## Verification

The release build and all five focused snapshot/query unit tests pass. The full reusable `tui/tests/local-shells.py` driver passed on the frozen local4 candidate, including:

1. Offline shell startup, configured/hidden/removed environment values, stable pane ID and private socket permissions.
2. A terminal device-status query handled through a real PTY, and a 176 KB bracketed paste with exact bytes and newline mapping.
3. Detach, SIGKILL of the headless holder, and reattach through the actual outer terminal: the shell PID, shell variable, current directory and earlier output survive.
4. Split, new-window command execution, natural window exit, popup execution and return to the original shell.
5. A Harness mock starting after the local shell: the original shell PID and variable survive. Kill-server then removes the supervisor, shell and socket.
6. A daemon-backed desk losing its mock to SIGSTOP: an offline popup keeps the same session ID; a local split and new window work; after SIGCONT the original daemon stream reconnects and both local panes remain. The daemon desk contains no local machine IDs.

Root independently checked a UI SIGKILL during a foreground loop. Reattachment preserved the original shell and exported value, captured all twenty output markers once each in order, and correctly resized the PTY to a 16-by-74 pane.

Tests used a copied binary, throwaway HOME, a private IPC directory, guarded `hne19fix` names and ports 19440–19449, explicit hn/tmux sockets, and no inherited credentials. All test mocks, hn processes and tmux servers were cleaned up. No real daemon or installed binary was used.

## Reproduce

From `tui/`, build with `cargo build --release --offline`, then run `python3 -u tests/local-shells.py`. The driver freezes its own binary copy and creates its private environment. It requires Python 3, tmux, Node and the existing `cli/node_modules` mock dependencies. Set `HN_LOCAL_TEST_BINARY` to test another frozen binary; optional port/prefix overrides must pass its isolation guard.

The pause note records the earlier failing state. Its self-handover and popup fixes are now implemented, and its remaining lifecycle checks all pass.
