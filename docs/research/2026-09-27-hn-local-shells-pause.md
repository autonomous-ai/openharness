# Local shell work paused — 2026-09-27

Historical note: work has resumed. The self-handover and popup issues below are now fixed, and all lifecycle checks pass. See `2026-09-27-hn-local-shell-fixes.md` and `2026-09-27-hn-resume.md` for the current state.

Update: work resumed; both pending fixes and the complete lifecycle driver now pass. See [the local shell fixes report](2026-09-27-hn-local-shell-fixes.md). The remainder records the earlier pause state.

The user paused work. Source is preserved; no commit or push was made by this agent. There were **no product edits after the check4 frozen build**, and no fixes below have been applied since that build. Private test mocks, hn processes and explicitly named tmux servers were checked: none remain running. Temporary diagnostic files remain available outside the repository.

## Current implementation

The uncommitted local-shell implementation starts a private, persistent PTY supervisor when the Harness daemon is unavailable. `local.rs` serves the existing terminal protocol over a namespace-specific Unix socket (directory mode 0700, socket mode 0600). It owns shells across UI/headless exits, provides terminal query replies and native process/cwd information, applies shell/session environment settings without putting environment values in process arguments, handles complete writes and bracketed paste, and reaps shells on exit or kill-server.

`local_screen.rs` reconstructs normal/alternate screens, history, cursor, attributes, terminal modes and unfinished escape sequences for reconnects. Integration is in app, input, daemon, CLI, main, pane and capture. Local shell windows become an ordinary persisted session, keeping local pane IDs out of the synchronized desk. Real daemon links continue reconnecting. Popups also use local shells while offline.

The renderer fixes are already in compatibility commit `e30e701f`: the tested emoji cells/cursors match tmux 3.5a, and ten ordinary echoed keys emit ten bytes (previously 487). See `2026-09-27-hn-terminal-fixes.md`.

## Verified before pause

- Five snapshot/query unit tests cover history, saved cursor, alternate screens and resize, tabs, character sets, hyperlinks, partial escape/UTF-8 sequences, wide glyph margins and query ownership.
- Root reports 111 release unit tests, the full existing E2E suite and hook comparisons passing on local3. Its subsequent check4 build also includes the confirmed IPC socket-claim headless/activity metadata fix.
- The reusable lifecycle driver passed offline shell startup, environment removal/hidden values, stable pane ID, private socket permissions, real PTY device-status reply, native current directory and exact 176 KB bracketed-paste bytes/newline mapping.
- A separate actual-UI check passed split/new-window command execution, natural window exit and popup execution/return.
- Root independently verified UI SIGKILL recovery: same shell PID and exported value, correct resize, and a running foreground loop recovered all twenty output markers once each, in order.

## Exact next fix

`tui/tests/local-shells.py` currently fails when a detached **headless holder is SIGKILLed**, then a UI attaches to its named session with desk synchronization enabled. The UI exits; the PTY supervisor and shell survive.

In `App::load_sessions`, the headless-owner collection uses `filter_map(live_owner)` without excluding `ipc::here()`. The new UI can reuse the stale owner's socket path. The old row still says headless, so startup sends `hn-hand-over` to the new UI itself. That request is handled after startup and closes the UI. The later session-row loading code already excludes the current owner.

Apply the same exclusion to the initial handover collection, immediately after `filter_map(live_owner)`:

```rust
.filter(|owner| Some(owner) != me.as_ref())
```

This diagnosis has not yet been verified with a patched build. It complements root's already-applied socket-claim marker fix.

Also move `app.keep_local_shell_session()` out of `configure_local_shell` and into `new_shell_from` for local machines. An offline popup is transient and should not convert its parent desk into an ordinary session. This adjustment is also pending.

## Reusable regression and resume

`tui/tests/local-shells.py` is repo-relative and uncommitted. It freezes the supplied binary, uses a throwaway HOME, canonical temporary paths, explicit socket names, a credential-free environment, port/prefix guards and cleanup. It verifies reattachment through the actual outer terminal before issuing capture commands; an earlier version accidentally allowed a capture command to start a replacement headless process and mask the UI exit.

After fixing self-handover, rerun the whole driver. Its remaining daemon-arrival and daemon-loss → local split/window → reconnect checks have **not yet run to completion**. They must verify that both local panes survive and no local IDs enter the daemon desk. Then rerun combined release/E2E gates, review the diff and hand it back to root for commit/push and the four-role review.

From `tui/`, after a new frozen release build, use `HN_LOCAL_TEST_BINARY` to choose that copy and run `python3 -u tests/local-shells.py`. The driver permits only ports 19440–19449 and guarded private prefixes. Retain all handoff isolation rules; never use a real daemon, a default hn/tmux socket or the forbidden ports.
