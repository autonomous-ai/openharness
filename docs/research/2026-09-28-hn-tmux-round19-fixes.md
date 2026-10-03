# hn round 19 tmux fixes

This pass fixes M2 and L1–L5 from [the round 19 tmux review](2026-09-27-hn-round19-tmux.md). M1's local pane lifecycle is handled by the separate native terminal pass. The reference is tmux 3.5a on macOS.

## Changes

- **Window dimensions:** `resize-window -x/-y` establishes a manual size even while the window is visible. The size survives selecting another window, resizing the outer terminal, detaching every client, and reattaching. Invalid dimensions and adjustments return tmux's errors. A detached window created for another session uses the invoking client's dimensions, carried independently of target-session routing. Selecting a detached group member no longer resizes its window to the owner's terminal. Mirror refresh preserves inactive and manual window dimensions.
- **Pane options:** `show-options -pA` inherits eligible window values, then applies pane overrides. Its inherited listing contains tmux's 14 pane options instead of all window options.
- **Hooks:** explicit pane titles emit `pane-title-changed`; next/previous/last-window run `after-select-window`. New-session, current-window changes, layout changes, session closure, and client detachment use the reproduced tmux ordering and format context. Restoring an unnamed shell window retains its initial-name state and avoids a spurious rename notification.
- **Active-window formats:** the four `window_active_sessions*` and `window_active_clients*` variables count and list every session or client currently showing the same shared window. Inactive linked windows report zero.
- **Command edges:** nonexistent environment targets fail; an empty binding is a no-op; invalid binding commands fail before installation. `display-message -I` rejects a nonempty pane; `-v` emits the reproduced format expansion trace. Headless `show-messages` and `server-info` fail with `no current client`, while headless `customize-mode` prints nothing. `server-access -l` lists the owner, and `send-keys -K -c` with a nonexistent client succeeds without injecting keys.
- **Formats and keys:** regex matching uses the host's POSIX extended expressions, and integer arithmetic follows tmux's reproduced conversion. Moving a window within its session does not renumber the remaining windows. Explicit `C-S-H` retains its shift modifier. Breaking a one-pane window moves the whole window without printing a target.

`server-access` changes beyond listing still report that access is limited to the owner; this pass does not introduce multi-user socket access. The format trace comparison covers the review's default and basic expansion cases, not every verbose operator diagnostic. These fixes do not claim coverage of every tmux option or resize policy.

## Verification

All 120 Rust unit tests pass with `cargo test --release --offline`; the release build and `git diff --check` pass. New regression tests cover pane inheritance and option filtering, explicit shifted control keys, and POSIX expression behavior.

Private paired fixtures reran the review's headless, focused, hooks, and three-client scenarios. Additional assertions checked:

1. An attached 80×24 client resized to a 66×17 manual window; the window remains 66×17 after switching windows, changing the outer terminal to 92×30, detaching all clients, and reattaching at 100×28.
2. Zero, oversized, and nonnumeric dimensions; zero adjustment; and a left adjustment larger than the current width.
3. A 100×28 client owns session `a`, an active 80×24 client owns `b`, and a new detached window in `a` starts at 80×23. A detached grouped session selects that window without changing it. A third 100×28 client attaches to another group window, leaving the inactive window at 80×23.
4. New-session, split, physical prefix-next-window, and killing an attached session produce matching hook sequences; client tty values naturally differ.

Prompt injection comparisons open the prompt and send text in separate requests, as required by the reference's asynchronous key queue. Mock terminal shell names differ from the reference's real shell name; they are not format failures.

The final private test binary has SHA-256 `be3ba2eea4af167bc9b5c6bbed9f8aa4303b701a8dd0af95066402e05ddc3ae1`. It contains the working fixes over the reviewed `32f43bb0` build; the integration commit and final CI/panel results are recorded separately.

## Isolation

All test calls used private frozen binaries, `hnt19fixtm*` socket names, guarded ports 19450–19459, a disposable home, a short private socket directory, and matching explicit port/socket environment. Inherited tmux and hn socket variables were removed. Reference and outer tmux servers always used explicit private names. Tests used only mock-backed sessions; every fixture cleaned up its exact clients, headless holders, mock process, and tmux servers. No installed binary, default server, real daemon, real harness, release, commit, push, or merge was used by this pass.
