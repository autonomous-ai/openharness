# hn session and terminal-feel fixes before round 19

Baseline: `af2971ee`. References: tmux 3.5a and the isolated mock daemon.

## Changes

- The last attached client leaves a headless hn process while sessions remain, so tmux-sessionizer can detect the running server.
- A new home window has a backing shell and reports one pane to scripts. Its home page, active window and shell ownership survive detach, including with desk synchronization enabled. Pending desk metadata is retained while a new client or headless server waits for the desk response.
- Buffered input and waiting command chains belong to their shell request. Switching between two pending home windows sends input to the selected window. Selecting a harness replaces the home window's unused shell.
- Long home-page titles keep their distinguishing ending with middle clipping.
- Injected `send-keys -K` text preserves case and repeat counts. Opening a prompt through injected keys returns control to the calling CLI. Explicit shifted characters follow tmux's status-prompt behavior.
- `prefix-timeout` reads its server option and expires on the following key. A prefix-table miss checks the root binding table.
- Messages and prompts replace only `message-line`; other status-format rows remain visible. Menus clear text attributes as tmux does. Very short terminals retain a pane row when configured status rows cannot fit.
- The default status line includes the short host name. Animation refreshes every 100 ms, independently of maintenance timers.
- WebSocket ping/pong deadlines detect an open but unresponsive daemon. A dedicated deadline avoids waiting for the next heartbeat tick; its last screen remains visible with reconnect feedback, and existing input queuing applies. Targetless commands prefer the attached UI even when one detached server also remains.
- End-to-end invocations now supply the socket name, daemon port and disposable home explicitly, reject ports outside the isolated test range, use a private IPC directory, and clean up detached servers. Stale socket cleanup affects only the selected namespace and removes its stale headless/activity markers. A client claiming the primary socket carries its own attached/headless role and activity time to that alias.
- `after-select-pane` fires only for the focus changes where tmux fires it. `set-hook -R` runs its hook in the calling command queue, so printed output and asynchronous hook commands reach the caller.

Prompt history persistence and its two-client concurrency check are documented in the companion tmux fixes report. Picker and rendering comparisons have their own reports.

## Rechecks

Every hn invocation used a frozen binary, throwaway HOME, matching `-L`, `--port`, `PORT` and `HN_SOCKET_NAME`, with `TMUX`, `TMUX_PANE` and `HN_SOCKET` unset. Root checks used guarded ports 19410–19419 and `hnr19fix` socket prefixes. Reference and outer tmux servers always used an explicit private `-L`.

- `send-keys -K C-b , C-u viaK Enter` produces `viaK`.
- With `status-keys emacs`, `send-keys -K -N 3 Ab` followed by `S-a Enter` produces `AbAbAb`, matching tmux.
- With two status rows, `message-line 1` preserves row zero and replaces row one for both messages and prompts. Captured text matches tmux.
- Bind a root `M-h` message, then type `C-b M-h`: both tools display it. Set `prefix-timeout 500`, type `C-b`, wait 800 ms, then type `c`: neither creates a window.
- Create a home window, detach, wait three seconds, then attach: one hn server remains, both windows and their panes remain, the home page remains selected, and typing reaches its backing shell. Repeated with desk synchronization enabled.
- Delay shell-creation replies by 500 ms, create two home windows rapidly, and type: only the second shell gets the text. Repeat after switching back to the first window before typing: only the first gets it.
- Stop the isolated mock with SIGSTOP after a desk detach/reattach: the attached UI shows the reconnect banner and its daemon-down format becomes 1 together at 14.78 seconds. A targetless CLI command reports that same UI PID rather than the detached server. Continue the mock before cleanup.
- Compare nine `select-pane` operations with an append-only `after-select-pane` hook: unchanged selection, title/input/mark changes and `-l` produce no hook; a changed explicit target does. Both tools produce the same hook log. `set-hook -R` prints `DIRECT` from a direct display command and `AFTERJOB` from an asynchronous `if-shell`.
- Seed stale sockets and sidecar files for two private names, then start one: its stale headless marker disappears, the other name is untouched, and targetless CLI commands reach the new UI. Repeat primary-socket takeover in both directions: an attached UI removes the former server's headless marker, and a headless server adds it when taking a former UI's socket.
- A command entered through the physical status prompt appears in shared history, is saved in tmux's typed history-file format and is restored by a new server.

The combined release unit suite passes all 111 tests. The full isolated end-to-end suite, release build and whitespace checks pass. No real daemon, default socket or installed hn binary was used.

## Local shell follow-up

A separate persistent local PTY supervisor supplies a shell when Harness is unavailable. The lifecycle and terminal reconstruction checks are documented in the local shell report. An independent UI-crash check killed only the attached UI, reattached, and verified the original shell PID, an exported variable, prior output and a resize to a 16-by-74 pane. A foreground loop also printed 20 numbered lines across the UI crash; capture history contained every line exactly once and in order.
