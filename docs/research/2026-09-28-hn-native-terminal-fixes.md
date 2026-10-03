# Native pane lifecycle and terminal startup fixes

Follow-up to round 19's tmux M1 and terminal-feel M1/M2, starting from `32f43bb0`.

- Native shells now report their actual exit code or terminating signal. `remain-on-exit on` retains any exit; `failed` retains failures and removes successful exits. Retained panes expose `pane_dead`, `pane_dead_status`, `pane_dead_signal` and `pane_dead_time`, draw the configured death message, and fire `pane-died` once per process exit. Linux uses numeric signal strings, matching tmux's fallback; macOS uses short lowercase names.
- The local supervisor keeps dead output and scrollback across detach and client crashes. Respawn preserves the pane ID and history, clears the visible screen, and reuses the previous command when no replacement is supplied. Generation IDs reject late frames from the previous process. Early exit notices are buffered until their terminal stream is installed.
- PTYs accept 1×1 sizes. A stopped bootstrap delays the user's command until the initial terminal dimensions have arrived, so even an immediate `stty size` sees the pane's actual size.
- Capability probes no longer read from stdin or block the first frame. One reader separates asynchronous XDA/DA1 replies from normal input and preserves typeahead until the first shell exists. Its byte parser comes from the pinned Crossterm 0.29.0 dependency, with the upstream MIT attribution retained. Split UTF-8, paste, modified keys and isolated Alt-P remain normal input.

## Reproduce

Run from `tui/`, with tmux 3.5a and Python 3 available:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
unset TMUX TMUX_PANE HN_SOCKET
cargo build --release --offline
cargo test --release --offline
HN_NATIVE_TEST_BINARY="$PWD/target/release/harness-tui" \
HN_NATIVE_TEST_PORT=19433 \
HN_NATIVE_TEST_PREFIX=hnt19fixnativecheck \
python3 tests/native-terminal.py
```

The driver copies the supplied binary before starting it. It creates a disposable HOME and HN_TMPDIR, accepts only ports 19430–19439 and the `hnt19fixnative` prefix, supplies every hn socket/port argument explicitly, and gives tmux its own named server. It starts no daemon. Cleanup stops its servers and asserts that its hn processes exited. The driver uses POSIX Python APIs and supports Linux x64/ARM; Linux runtime validation belongs to CI.

## Results

The release unit suite passed all 120 tests. The native regression passed against tmux 3.5a on macOS: retained exit codes and signals, hook counts, respawn commands and history, dead-pane recovery after a holder crash, delayed capability replies with immediate/100 ms typeahead, and a real 1×1 PTY. The first screen without a DA1 reply appeared in 49 ms for hn and 48 ms for tmux, versus the previously measured 1.56 s for hn. Twelve immediate-exit windows additionally exercise exit delivery during stream startup.
