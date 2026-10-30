# Terminal compatibility patches

These are the source and manifests from the published `alacritty_terminal` 0.26.0
and `vte` 0.15.0 crates, with their upstream licenses. Upstream integration-test
fixtures and example programs are omitted; the corresponding manifest targets
are omitted too. Their notices are also embedded in hn's THIRD_PARTY_NOTICES.md.

Local changes are marked `hn` in the relevant source:

- `vte/src/ansi.rs`: SGR 21 means double underline, as in tmux 3.5a; SGR 53/55
  enables/disables overline. Accept tmux 3.5a's `capture-pane -e` spelling `5:3`
  so streamed snapshots retain overline.
- `alacritty_terminal/src/term/cell.rs`: widen cell flags to retain blink and
  overline, including otherwise blank cells during scrollback reflow.
- `alacritty_terminal/src/grid/resize.rs`: permit one-column panes with clipped
  wide glyphs; avoid endlessly reflowing a two-cell glyph into a one-cell row
  and restore its spacer when the pane grows.
- `alacritty_terminal/src/term/mod.rs`: handle both blink variants (tmux treats
  them alike), blink reset and overline attributes in the cursor template.
- Windows only, for harness-pty's per-pane Job Object (`pty/src/job.rs`):
  - `alacritty_terminal/src/tty/mod.rs`: `Options::job`, a raw Job Object
    `HANDLE` (`#[cfg(windows)]`);
  - `alacritty_terminal/src/tty/windows/conpty.rs`: with a job, the child is
    created suspended, assigned to the job, then resumed, so nothing it starts
    escapes the job; a child that cannot join is terminated and the spawn fails;
  - `alacritty_terminal/src/tty/windows/mod.rs`: `Pty` drops its output pipe
    before the pseudoconsole (upstream drops it after), so `ClosePseudoConsole`
    never waits for a drain of output that nobody reads any more;
  - `alacritty_terminal/src/tty/windows/mod.rs`: with `escape_args`, the program is
    quoted when it has a space or tab (`push_program`), as the C runtime reads
    argv[0]; upstream pushed it bare, so `C:\Users\John Doe\…\claude.exe` ran
    `C:\Users\John.exe`;
  - `alacritty_terminal/src/tty/mod.rs` and `tty/windows/conpty.rs`: `Options::env_remove`,
    names left out of the environment the child inherits (compared without case, as Windows
    does), so a pane's cleared variables (a grid launch's provider keys) are not handed down from
    the host's own environment; upstream could only add variables;
  - `alacritty_terminal/src/tty/windows/conpty.rs`: the bundled `conpty.dll` is loaded with
    `LoadLibraryExW(LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32)`, from
    the executable's own directory only (where `OpenConsole.exe` sits beside it); upstream's
    `LoadLibraryW` searched the current directory and PATH, so a planted `conpty.dll` there
    would run inside the host;
  - `alacritty_terminal/Cargo.toml`: the `Win32_System_JobObjects` feature.

Keeping these attributes in the native grid makes erase, scrolling, cursor save,
alternate screens, history and reconnect use the existing terminal operations.
The pane capture/rendering regression tests cover the downstream behavior.
