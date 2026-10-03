# hn tmux fixes before round 19

Baseline: `af2971ee`. Compared private binary copies with tmux 3.5a, using mock daemons only, socket prefixes `hnt19fix*`, ports 19430–19438, and disposable homes. All mock processes, hn clients, headless servers, and reference tmux servers were stopped after each run.

## Fixed

- **M5:** `new-session -t` can group with a session another terminal owns. Creation runs in the owning client, and an attached creation switches the requesting terminal to the new group member.
- Group formats, session stacks, alerts, attachment counts, and attachment lists use the specified session. An unrelated remote session no longer inherits the caller's group. Attachment lists retain client creation order across group members.
- Switching between two sessions owned by the same remote client keeps the new attachment registered. An unregister for the old session cannot remove the new one.
- Grouped windows retain independent activity/bell flags, including sessions not currently in front. Group creation inherits the existing window alerts. Snapshots keep alert flags and last-window stacks current.
- The marked pane is server state: detach, reattach, and a second terminal preserve it. Closing the marked pane clears it. Session mark formats identify the marked session.
- Invalid array indexes and indexes on scalar options fail before changing the option. Choice values are case-sensitive. `show-options` preserves tmux's distinct behavior for indexed scalar reads and missing global array items.
- Session loops preserve literal commas. List commands and nested loops identify their session, window, or pane format context. Nested window loops retain alert/zoom flags and escape the activity `#` correctly.
- Concurrent prompt history keeps both clients’ additions. Pending append and clear operations replay under the server file lock, including a clear issued from an unchanged, empty local history. Detach saves the latest merged history under the same lock. A repeated entry still applies a reduced history limit.

## Verification

The final isolated comparison passed these cases against tmux:

1. Two terminals on independent sessions, then remote grouping from the second terminal.
2. Separate current-window stacks for two members sharing three windows.
3. Activity in a shared background window, read from another terminal.
4. Attaching to a group member, then creating and switching to another member owned by the same client.
5. Three attached clients, including two on one session: session/group counts, many-attached flags, and ordered tty lists.
6. `list-sessions`, `list-windows -a`, and `list-panes -a` format type flags; session-loop commas; nested window flags.
7. Ten option operations, comparing exit status, stdout, and stderr, including unchanged array item 0 after a rejected `[x]` write.
8. Marked pane before detach, with no terminal, after reattach, from another session, and after the pane is killed.

The history race was reproduced by opening command prompts in two clients, holding the shared server file lock, submitting one distinct command from each, then releasing the lock. Before the fix, both commands ran but one history entry disappeared. After the fix, both entries survive on both clients, a detach, and a new server loading `history-file`. A separate blocked-lock check confirms that a clear from a client with an empty stale history removes another client’s pending addition. Three focused tests cover concurrent additions, clear/append ordering, and reduced limits.

A focused unit regression also checks that invalid array/index and choice writes leave all option maps unchanged. The release build and `git diff --check` passed. The broader unit and end-to-end suites are run for the combined round-19 changes.

## Reproduction sequence

Build once, copy the binary to a private temporary path, and use this guard for every hn invocation. Run the mock daemon with the same port. The existing test harness supplies separate PTYs and cleans up its named tmux servers.

```sh
prefix=hnt19fixrepro
port=19439
scratch=$(mktemp -d)
mkdir "$scratch/home"
cp tui/target/release/harness-tui "$scratch/hn"
h() {
  case "$prefix:$port" in hnt19fix*:1943[0-9]) ;; *) return 64 ;; esac
  env -u TMUX -u TMUX_PANE -u HN_SOCKET \
    HOME="$scratch/home" PORT="$port" HN_SOCKET_NAME="$prefix" \
    HARNESS_TUI_DESK=off HARNESS_TUI_NOTIFY=off HN_DESKTOP=off \
    "$scratch/hn" -L "$prefix" --port "$port" "$@"
}
```

Start `h new-session -s one` and `h new-session -s two` in separate test PTYs. From the test command shell:

```sh
second=$(h display-message -p -t two '#{socket_path}')
h -S "$second" new-session -d -s grp -t one
h new-window -d -t one: -n extra
h select-window -t one:1
h select-window -t one:0
h new-window -d -t grp: -n last
h select-window -t grp:2
h select-window -t grp:1
h set-option -w -t one:2 monitor-activity on
h send-keys -t one:2 -l activity
h -S "$second" switch-client -t grp
h -S "$second" if-shell -F 1 'new-session -s grp2 -t one'
h -S "$second" list-sessions -F '#{session_name}|#{session_group}|#{session_group_size}|#{session_group_list}|#{session_attached}|#{session_group_attached}|#{session_stack}|#{session_alerts}'
h -S "$second" display-message -p '#{S:#{session_name}[#{W:#{window_index}#{window_flags} }]}'
```

For the marked-pane check: split a pane, mark pane 1 with `select-pane -m -t one:0.1`, then compare `#{pane_marked_set} #{P:#P#{?pane_marked,M,} }` before detach, after detach, after attach, and after killing pane 1.

Option checks: reject `set -g user-keys[x] replacement`, `set-hook -g after-new-window[x] display`, `set -g status-left[0] x`, `set -g status-keys EMACS`, and `set -g mode-keys Vi`; verify the previous option values remain. Compare the same commands against a separate `tmux -L hnt19fixrepro-ref -f /dev/null` server. Finally stop the guarded hn server, mock daemon, and named tmux servers.

## Concurrent history reproduction

Use the same guarded mock setup and two attached clients. Set `status-keys emacs` and an absolute `history-file` in the disposable directory. Open each client’s command prompt and type `set -g @one one` and `set -g @two two` without submitting. With a helper holding an exclusive `flock` on `$HOME/.harness/tui/sessions-$prefix.server.lock`, submit Enter in both terminals, wait for both clients to reach the lock, then release it. Both user options and both command-history lines must survive. Detach one client, stop the server, put the history-file setting in the disposable config, and start a fresh server; both lines must load again.

For the stale-clear case, start with empty histories, hold that lock, submit a command in client one, then issue `clear-prompt-history -T command` through client two’s explicit socket before releasing the lock. The command’s option survives and both histories are empty. Use exact outer tmux pane targets such as `=client-one:0.0`; a bare session name can instead resolve a similarly named window.
