# hn vs tmux 3.5a — round 19, tmux review

**Score: 8.5 / 10.** The first-hour blockers from round 18 are substantially repaired. Commands, detached session creation, remote grouping, target selection, injected prompt text, streaming status jobs and local-shell reconnection now behave much more like tmux. This is a bounded review of the frozen build, not a claim that every tmux feature was retested.

**Build:** commit `32f43bb0d541445c312b739d39c2d9265ca45c6a`; binary SHA-256 `1df2f355d7b3d5841d91f53a36d744234d93145108768a88565aeacf4cc8b3f9`. The binary was copied once to a private test path. Reference: tmux 3.5a. No product source was edited. Creature/tim was intentionally excluded.

**Method and isolation:** seven fresh scenarios, 210 paired command observations, physical keys through private outer tmux servers, three simultaneous attached clients, mock-backed panes and real offline local shells. Every hn call used the frozen copy, explicit `-L`, `--port`, matching `PORT`/`HN_SOCKET_NAME`, disposable `HOME`, private short `HN_TMPDIR`, and no inherited `TMUX`, `TMUX_PANE` or `HN_SOCKET`. Drivers refuse names outside `hnr19tm*` and ports outside 19500–19509. The scenarios used 19500–19506. Every tmux invocation used an explicit private `-L`. Raw equality counts are not a score: process IDs, ttys, shell names and mock terminal contents naturally differ.

## Critical and high

No critical or high finding in this bounded pass. Real theme repositories were not reloaded; their previously failing primitives were reproduced directly.

## Medium

### M1. Offline local panes ignore `remain-on-exit` and do not fire `pane-died` — newly testable

With no daemon listening, these commands succeed:

```sh
h new-session -d -s a
h set -g @died ''
h set-hook -g pane-died 'set -agF @died "#{window_index}:#{pane_dead_status},"'
h set -g remain-on-exit on
h new-window -d -t a:4 -n dead 'exit 7'
sleep 1
h list-panes -t a:4 -F '#{pane_dead}:#{pane_dead_status}'
h show -gv @died
```

| Read | hn | tmux |
|---|---|---|
| `list-panes` | rc 1, `can't find window: 4` | rc 0, `1:7` |
| `show -gv @died` | empty line | `4:7,` |
| `respawn-window -k -t a:4 'sleep 30'` | rc 1, missing window | rc 0, shell restarted |

Also reproduced with `remain-on-exit failed` and `exit 8`: hn removes window 5; tmux keeps it with `1:8` and appends `5:8,` to the hook log. Reproduced with an attached client and with only a headless holder. Users explicitly asking to preserve a failed terminal task lose the pane, its inspectable output and exit status. Round 18 listed real pane death as untestable; the new local-shell implementation makes this directly testable.

### M2. Window size control still differs — carried over

With a client attached at 80×24:

```sh
h resize-window -t b:0 -x 66 -y 17
h list-windows -t b -F '#I:#{window_width}x#{window_height}'
```

hn returns rc 1, `resize-window: a window on screen is the terminal's size here`, and keeps `0:80x23`. tmux returns rc 0 and reports `0:66x17`. The explicit error is an improvement over silently ignoring the request, but scripts that set fixed layouts still differ. This does not establish whether every older two-client sizing case remains; only the stated case was rerun.

## Low

### L1. Pane option inheritance and option listings

```sh
h set -w -t a:0 window-style fg=red
h show -pAv -t a:0.0 window-style
```

hn prints `default`; tmux prints `fg=red`. `show -pA` also prints 56 inherited option lines in hn versus tmux's 14. The former affects scripts reading the effective style; the latter includes window-only options in a pane-only listing. Both are round-18 carryovers.

### L2. Hook coverage and event context remain incomplete

The repaired after-command target state works, but these separate cases still differ:

```sh
h set -g @events ''
h set-hook -g pane-title-changed 'set -ag @events title'
h select-pane -t a:0.0 -T newtitle
h show -gv @events
```

hn prints an empty line; tmux prints `title`.

For event ordering, install append-only hooks using this form:

```sh
h set-hook -g after-new-session 'set -agF @events "after-new-session:#{hook_client}:#{hook_session_name},"'
```

Use the same body with the matching event name for `session-created`, `window-linked`, `window-renamed`, `after-select-window`, `session-window-changed`, `client-detached` and `session-closed`. Clear `@events` before each action. Observed differences:

| Action | hn | tmux |
|---|---|---|
| `new-session -d -s b` | `window-linked::b,session-created::b,after-new-session::,window-renamed::b,` | `after-new-session::,window-linked::b,session-created::b,` |
| Physical `C-b n` | no `after-select-window`; `session-window-changed` has the client tty | `after-select-window` fires; `session-window-changed` has empty `hook_client` |
| `kill-session -t a`, with its client attached and another session remaining | `session-closed` fires, but no `client-detached`; extra `window-linked` and `session-window-changed` for the closed session | `session-closed` then `client-detached` |

For `split-window -d -t a:0`, the old ordering bug is fixed: both fire `after-split-window` before `window-layout-changed`. The latter still supplies `hook_session_name=a` in hn where tmux leaves it empty. These are carried-over hook gaps, separate from M1's new local pane-death case.

### L3. Active-window formats count the wrong sessions and clients

Start one attached session `a` on window 0, then:

```sh
h new-window -d -t a:1 -n a1
h list-windows -t a -F '#I:#{window_active_sessions}:#{window_active_clients}'
h new-session -d -s ag -t a
h list-windows -t a -F '#I:#{window_active_sessions}:#{window_active_clients}'
```

Before grouping, hn prints `0:1:1` and `1:1:0`; tmux prints `0:1:1` and `1:0:0`. After grouping, hn still reports one active session for every window; tmux reports `0:2:1` and `1:0:0`. With a third terminal attached to `ag` on window 1, hn counts that client only when reading the `ag` row; tmux counts it for the shared window from either member. Session group attachment counts and stacks themselves are fixed.

### L4. Command validation and return codes

These are existing edge cases, reproduced on a live isolated server:

| Command | hn | tmux |
|---|---|---|
| `show-environment -t nosuch` | rc 0, prints the default removed-variable entries | rc 1, `no such session: nosuch` |
| `bind-key x` | rc 1, `bind x without a command` | rc 0, empty output |
| `bind -T copy-mode-vi x nosuchcmd` | rc 0 | rc 1, `unknown command: nosuchcmd` |
| `display -p -I`, nonempty pane | rc 0, ordinary display text | rc 1, `pane is not empty` |
| `display -v` | empty stdout | verbose format expansion on stdout |
| `show-messages`, no attached client | rc 0, command history | rc 1, `no current client` |
| `server-info`, no attached client | rc 0, terminal header | rc 1, `no current client` |
| `customize-mode`, no attached client | rc 0, whole options/key tree on stdout | rc 0, empty stdout |
| `server-access -l` | rc 1, unknown command | rc 0, access list |
| `send-keys -K -c /dev/nosuch a` | rc 1, `can't find client: /dev/nosuch` | rc 0, empty output |

The nonexistent environment target and silently accepted invalid key binding are the most useful fixes in this group. `send-keys -K -X cancel` now matches in the tested no-mode case: rc 1, `not in a mode`.

### L5. Remaining format, window and key normalization differences

| Reproduction | hn | tmux |
|---|---|---|
| `display -p '#{m/r:\bfoo,foo}'` | `1` | `0` |
| `display -p '#{e\|/\|:1,0}'` (unescaped pipes in the actual argument) | `inf` | `9223372036854775808` |
| Four windows at 0–3; `set -g renumber-windows on`; `move-window -s a:0 -t a:7`; list indexes | `0 1 2 3` | `1 2 3 7` |
| `bind C-S-H display-message SHIFT`; `list-keys -T prefix C-S-H` | key listed as `C-H` | key listed as `C-S-H` |
| `break-pane -d -P -F '#{session_name}:#{window_index}.#{pane_index}' -s a:6.0`, where window 6 has only one pane | prints new target, e.g. `a:1.0` | empty stdout |

The one-pane break moves the window on both sides; the output differs. Breaking one pane out of a two-pane window with an explicit target prints the same target on both sides.

## Prior findings rechecked

| Round-18 area | Round-19 result and scope |
|---|---|
| Earlier critical scripting checks | `new-session -d -P`, bare session targets, server responsiveness and command chains pass. No critical observed. |
| H1 theme prerequisites | `current_file`, dirname modifier and `set -ogq` all match. Real catppuccin files not reloaded. |
| H2 status jobs | Latest complete line is shown, including after an empty line; an ongoing loop shows `loop` before exit; both job PIDs are gone after `kill-server`. |
| H3 prefix twice | Screen-style `prefix C-a` plus `bind C-a last-window` selects the previous window on both. |
| H4 home/type-ahead | Immediate text after `C-b c` executes in a real shell; the window reports one pane, survives detach and retains its output. A new-window/split chain makes two panes. |
| H5 detached build then attach | `new -d … ; split-window … ; attach …` leaves one attached client and two panes on both. |
| M1 style append | `fg=white` plus `bg=black` produces `fg=white,bg=black` on both. |
| M2 after-hook target | Detached new-window, split and rename hooks receive the correct window/pane. Same-pane selection and title-only selection do not fire `after-select-pane`. Other hook gaps are listed above. |
| M3 best client | After input in terminal 2, targetless `display -p '#S'` and `new-window -d` use terminal 2's session. |
| M4 background zoom | Zooms the requested background window without selecting it. |
| M5 groups | Group creation through another client's socket works; unrelated sessions retain their own formats; separate stacks, nested session/window loops and three-client group counts match. Window active-count formats remain wrong. |
| M6 server after detach | After all three clients detach, exactly one headless hn holder remains and sessions report zero attachments. |
| M7 session closed | Fires without a terminal and when killing the attached session. Remaining event context/detach-hook differences are listed above. |
| M8 message lifetime | `-d 2500` shown at 1 second and gone at 2.8; `display-time 0` stays until a key. |
| M9 plugin free-key detection | `list-keys -T prefix R` reports `unknown key: R` on both before an explicit binding. |
| M10 terminal feature negotiation; M11 mode rename timing | Not rerun in this bounded pass. |
| Low 1–3 | Root fallback, 500 ms prefix timeout, two-row status with `message-line 1`, message and prompt placement match. |
| Low 5, marked pane | Persists with no client and after reattach; the marked-pane formats match. |
| Low 12–14 | `set-hook -R` returns direct and asynchronous output; invalid indexes leave item 0 unchanged; scalar-array writes and mixed-case choices fail identically. |
| Low 17, injected keys | Separate prompt-open and text calls preserve `viaK`; repeat count 3 preserves `AbAbAb`; opening a prompt returns rc 0. Invalid-client return code remains different. |
| Low 21, format context | `session_format` in list-sessions and ordinary display context flags match; session-loop commas and nested flags match. Active-window counts remain wrong. |
| Low 26, prompt history | A physical command prompt appears identically in `show-prompt-history`. The two-client history race and fresh-server reload were not repeated. |
| Older respawn selection report | The mock-backed `respawn-window -k -t a:4` check kept the active window on both. Actual local respawn after death was blocked by M1. |

Other previously reported lows were not systematically rerun: wire-byte counts, tiny-terminal rendering, all unused options, choose-buffer editor/navigation, startup-config context, terminal escape differences, all pane swaps/moves, cross-client pane modes, process-substitution buffers, and the full rendering matrix. No claim that these are fixed. A single combined `send-keys -K` call that opens and immediately types into a prompt also has different queue timing: hn completes it synchronously; tmux 3.5a can deliver the later text before the prompt opens. Splitting prompt-open from text input is the valid comparison for the repaired case/repeat behavior.

## Portable guarded setup

Run from a repository checkout. Set `HN_FROZEN` to the already-built frozen binary; these tests never build or install hn. The local-shell M1 reproduction deliberately starts no daemon. Use the same command sequence with `t` in place of `h` for the reference.

```sh
prefix=hnr19tmrepro
port=19509
scratch=$(mktemp -d /tmp/htm19.XXXXXX)
mkdir "$scratch/home"
cp "$HN_FROZEN" "$scratch/hn"
cat > "$scratch/test.conf" <<'EOF'
set -g default-shell /bin/sh
set -g @hn-look tmux
set -g automatic-rename off
EOF
guard() {
  case "$prefix:$port" in hnr19tm*:1950[0-9]) ;; *) return 64 ;; esac
}
h() {
  guard || return
  env -u TMUX -u TMUX_PANE -u HN_SOCKET \
    HOME="$scratch/home" HN_TMPDIR="$scratch" \
    PORT="$port" HN_SOCKET_NAME="$prefix" \
    HARNESS_TUI_DESK=off HARNESS_TUI_NOTIFY=off HN_DESKTOP=off \
    "$scratch/hn" -L "$prefix" --port "$port" -f "$scratch/test.conf" "$@"
}
t() {
  guard || return
  env -u TMUX -u TMUX_PANE -u HN_SOCKET HOME="$scratch/home" \
    tmux -L "$prefix-ref" -f "$scratch/test.conf" "$@"
}
cleanup() { h kill-server >/dev/null 2>&1; t kill-server >/dev/null 2>&1; }
trap cleanup EXIT INT TERM
guard || exit
```

For attached-client cases, run the wrapper's `attach-session -t a` in a separate disposable PTY with the same variables and configuration. The private driver creates those PTYs through an outer named tmux server and repeats all environment isolation in its child launch.

## Repro artifacts and cleanup

Reusable private driver: `/tmp/hnr19tm-review/driver.py`. Modes: `headless`, `clients`, `jobs`, `local`, `hooks`, `focused`, `remain`. Raw text and JSON for each scenario are beside it. They contain local runtime details and are intentionally not copied into the public repository.

All seven scenarios ran cleanup in `finally`. The exact test hn UI/headless/supervisor processes and named tmux servers were stopped, mock processes were waited for, both sampled status-job PIDs died, and both sampled local shell PIDs died on `kill-server`. No broad process kills, default sockets, real daemon, installation, release, commit, push or merge was used by this reviewer.
