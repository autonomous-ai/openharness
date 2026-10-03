# hn vs tmux 3.5a — round 20, tmux review

**Score: 9.0 / 10.** The round 19 tmux findings now pass their reproduced cases. This pass found two additional native-shell gaps, corrected them, and verified the corrections against tmux. No critical or high finding was observed. The score describes this bounded command/session review, not complete tmux equivalence.

**Reviewed candidate:** `5401458c7d6f7f59960f864731ff7bae1bd27d64`, binary SHA-256 `461ecf17895c9cac9c4eb5a5924cb1483904dd0873055cdaecf716cdc3c12b97`. The candidate was hash-checked and copied once before any tests. The reference was tmux 3.5a on macOS. The creature was excluded.

The initial review used nine fresh scenarios and 242 paired command observations, followed by two minimal native repros with another 22 paired observations. Raw equality was inspected rather than treated as a score: mock shell names, process IDs, tty paths, and shell prompts differ by construction. The native findings below apply to the original frozen candidate. Their correction evidence comes from a separately copied release binary built from the working fixes over that commit; its SHA-256 is `a5a5162993cd34ec3486b0e812aba11849a81e32f4d9b46341df6d4347559915`.

## Round 19 rechecks

| Area | Result and exact scope |
|---|---|
| M1: retained native exits | `remain-on-exit on` retains exit 7; `failed` retains exit 8; `pane_dead` and `pane_dead_status` match. `pane-died` logs each retained exit once, and `pane-exited` does not fire for those retained panes. The displayed death message matches. Native respawn works; the separate format/selection issues found below were then corrected. |
| M2: explicit window dimensions | An attached 80×24 client accepts `resize-window -x 66 -y 17`, reports `66x17:manual`, and keeps that size across window selection, outer resize to 92×30, full detach, and reattach at 100×28. Zero, nonnumeric, oversized, and invalid adjustment arguments return the same errors. |
| L1: pane inheritance | `set -w -t a:0 window-style fg=red` followed by `show -pAv -t a:0.0 window-style` returns `fg=red`. The complete `show -pA` output matches the reference's 14 inherited pane options. |
| L2: hook coverage and context | Explicit title changes fire `pane-title-changed`. New-session, split, new-window, physical `C-b n`, and killing an attached session produce matching event ordering and session context. `client-detached` has its actual client tty on both; the tty values naturally differ. No spurious initial window-rename event remains. |
| L3: active-window formats | Inactive windows report zero active sessions/clients. Grouped sessions and three attached terminals produce identical `window_active_sessions` and `window_active_clients` counts from all session rows. Group counts, stacks, nested session/window loops, and formats for the other terminal's session also match. |
| L4: validation and return codes | All ten reported cases match: nonexistent environment target, empty binding, invalid copy-table binding, display input into a nonempty pane, default verbose display trace, headless messages/server-info/customize-mode, owner access listing, and nonexistent `send-keys -K` client. The no-mode `send-keys -K -X cancel` case also matches. |
| L5: format/window/key edges | POSIX `\b` expression behavior, divide-by-zero integer conversion, moving a window with renumbering enabled, listing `C-S-H`, and one-pane `break-pane -P` output match. Breaking a split into an explicit target also matches. |
| Additional creation geometry fix | Session `a` is owned by a 100×28 client; the most recently active client owns `b` at 80×24. Detached windows created in `a` begin at 80×23. Selecting them in a detached group member does not resize them. A third 100×28 client attaching to another group window leaves the inactive window at 80×23. All paired size listings match. |

## High-value regressions

- Detached session creation and printed targets, bare session targets, command chains, `current_file`/dirname formats, `set -ogq`, and appended styles match.
- After-command hooks retain their target; forced direct and asynchronous hook output is returned; invalid array indexes leave valid entries intact.
- Background zoom preserves selection. Marked panes survive full detach and reattach.
- The most recently used terminal determines targetless session commands. Group creation through another client's socket works. After all three clients detach, exactly one headless holder remains, and all sessions report zero attachments.
- Separate prompt-open and text-injection calls preserve `viaK` and repeated `AbAbAb`. Screen-style `C-a C-a`, root-table fallback after a prefix, and the 500 ms prefix timeout behave as reproduced in round 19.
- Two-row status placement, `message-line 1`, a 2500 ms message, and a zero-duration message until input match the relevant screen rows.
- Status jobs show the last complete line, including after an empty line, and show streaming output before process exit. Both sampled job PIDs exit when the server is killed.
- With no daemon running, native shell PID, environment variable, and output survive detach and reattach. Immediate text after `C-b c` executes and survives another detach. Prompt history and OSC title hooks match. Both sampled native shell PIDs exit on `kill-server`.

## New findings and corrections

### M1. Whole-window respawn kept every split and did not select the window

In fresh private 80×24 clients, create session `a` on window 0, then run the same commands through the guarded hn and tmux wrappers:

```sh
h new-window -d -t a:4 -n tasks 'sleep 60'
h split-window -d -t a:4 'sleep 60'
h select-window -t a:0
h respawn-window -k -t a:4 'sleep 70'
h list-panes -t a:4 -F '#{pane_id}:#{pane_index}:#{pane_active}'
h list-windows -t a -F '#I:#{window_active}'
```

The candidate kept `%1` and `%2` and left window 0 active. tmux kept only the first pane, `%1`, and selected window 4. The missing selection also reproduced with a single retained dead pane followed by `respawn-window -k -t a:4 'sleep 30'`. `respawn-pane` correctly left window selection unchanged on both.

**Correction:** `respawn-window` now closes other splits, preserves and restarts the first pane, and selects the target window. `respawn-pane` retains its existing behavior. Fresh paired single-pane and split-pane repros now match exactly, including the surviving pane ID. The expanded native regression asserts first-pane retention and target-window selection.

### L1. `pane_start_command` was always empty

With `remain-on-exit on` in a fresh attached session:

```sh
h new-window -d -t a:4 -n dead 'exit 7'
# Wait for the retained exit.
h display -p -t a:4 '#{pane_dead}|#{pane_start_command}'
h respawn-window -k -t a:4 'sleep 30'
h display -p -t a:4 '#{pane_dead}|#{pane_start_command}'
```

The candidate printed `1|` and `0|`; tmux printed `1|"exit 7"` and `0|"sleep 30"`. The command itself ran correctly; the format discarded it.

**Correction:** shell creation and successful respawn retain the start command as pane metadata. Session serialization preserves it, and local terminal-info replies can restore it from the supervisor. The format uses the existing tmux argument escaping. The paired repro now matches, and the expanded native regression verifies quoted commands after creation, replacement respawn, command reuse, and a headless-holder crash.

## Correction verification

The corrected release build passes the two fresh minimal repros with no paired differences. Repeating the 66-observation headless command scenario leaves only the two expected mock `zsh` versus real `sh` window names.

The full `tests/native-terminal.py` regression, with only its private port/prefix guard adapted for this review, passes retained exits/signals, hook counts, history, crash recovery, original-command reuse, the new command metadata and whole-window respawn assertions, immediate/100 ms typeahead through delayed DA1 replies, and a real 1×1 native PTY. This run measured first output without DA1 at 51 ms for hn and 52 ms for tmux. Those timing samples are observations, not a benchmark guarantee. Final integration tests and Linux checks are recorded by the merge owner separately.

## Isolation and repro files

Every hn invocation used the copied binary, explicit `-L hnr20tm… --port 1950…`, matching `PORT` and `HN_SOCKET_NAME`, disposable `HOME`, and private short `HN_TMPDIR`. Guards reject every other port range or namespace. The outer tmux child explicitly removes `TMUX`, `TMUX_PANE`, and `HN_SOCKET` before launching either tool. Every tmux call uses a private `-L`; local-shell scenarios start no daemon. Other scenarios use the test mock only.

Private driver and original raw results: `/tmp/hnr20tm-review/`. Modes are `headless`, `clients`, `jobs`, `local`, `hooks`, `focused`, and `remain`; `geometry.py` and `creationsize.py` cover sizing. `native_edges.py` and `respawn_split.py` are the minimal new repros. Corrected copies and results are in `/tmp/hnr20tm-fixes/`. Raw logs contain runtime machine details and are intentionally not committed.

All scenarios clean up in `finally`. The final audit found no owned hn/tmux processes and successfully bound every assigned port, 19500–19509. UI processes, headless holders, native supervisors/shells, status jobs, named tmux servers, and mock processes were stopped. No default server, real daemon, real harness, installed binary, broad process kill, release, commit, push, or merge was used by this reviewer.

## Limits

This is a bounded follow-up to round 19, with adjacent native respawn checks. It does not establish parity for every tmux option, every verbose format diagnostic, full multi-user server access, every layout policy, cross-client pane mode, clipboard path, or real theme repository. The four active-window format variables were not all exhaustively tested; the reproduced session/client counts were. Startup captures can contain timing-dependent pre-prompt shell echo differences; execution and persistence were verified here, not complete pixel equality for that race. Linux behavior belongs to CI. Creature behavior was not reviewed.
