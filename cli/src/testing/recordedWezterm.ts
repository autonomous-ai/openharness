/**
 * WezTerm 20240203-110809-5046fc22 as it ran on Ubuntu 24.04, for the WezTerm adapter's specs
 * (docs/plans/2026-11-21-dial-linux-followups-plan.md, Task 3; spec "The tab (WezTerm, kitty)"). Recorded 2026-11-21 in
 * a disposable `ubuntu:24.04` container (`--platform linux/amd64`, emulated by qemu-user, Podman on macOS), from the
 * release's Ubuntu 22.04 `.deb`, the one `cli-e2e-dial-hosts.yml` installs (its sha256 checked as there), with `jq` and
 * `procps` from the archive. Nothing else installed; no account.
 *
 * How it was made: user `u` (uid 1001: the image's own `ubuntu` holds 1000), `WEZTERM_CONFIG_FILE` a config of
 * `e2e/harness/weztermMux.ts`'s form, `return { unix_domains = { { name = 'harness-e2e', socket_path =
 * '/home/u/wezterm/sock' } } }`, and `wezterm-mux-server` started headless with it; it made window 0, tab 0, pane 0
 * (u's login shell) itself. `split-pane --pane-id 0 -- /bin/sh` made pane 1 in tab 0 and `spawn --window-id 0 --
 * /bin/sh` made tab 1 with pane 2. Every other command ran as `wezterm cli --no-auto-start …` with
 * `WEZTERM_UNIX_SOCKET=/home/u/wezterm/sock`, from outside the server, as the daemon runs; each value is its exact
 * argv, exit code and output. Each pane's title is `qemu-x86_64-static` only because the run was emulated (WezTerm
 * reads the foreground process's executable): the adapter reads no title, only `pane_id` and `tty_name`.
 *
 * `list`'s `is_active` is the pane's place in its own tab, so whether a tab is its window's active one was read
 * apart: the same scene was made again under a server whose config also ran a `wezterm.time.call_after` loop writing
 * `wezterm.mux.all_windows()`' `active_tab():tab_id()` to a file every 0.2 s; `list` there matched this one's.
 */
export const RECORDED_WEZTERM = {
  source: 'recorded',
  version: '20240203-110809-5046fc22',
  download: {
    x64: {
      url: 'https://github.com/wezterm/wezterm/releases/download/20240203-110809-5046fc22/wezterm-20240203-110809-5046fc22.Ubuntu22.04.deb',
      sha256: '86358dab5794a4fb63f7c91dd68d4fdc3da58faad648a58fc77d2bd51c7b0686',
    },
  },
  /** `ps -o comm= -p <wezterm-mux-server's pid>`: the kernel's 15 bytes of its name. Each pane's shell is its child,
   *  on `/dev/pts/<n>` (`ps -o tty=` `pts/0`, `pts/1`, `pts/2`). */
  muxServerComm: 'wezterm-mux-ser',
  /** `list --format json`, exit 0, its stdout whole (no newline at its end): window 0 with tab 0 (panes 0 and 1, pane 1
   *  its active one) and tab 1 (pane 2), tab 1 the window's active tab. `tty_name` is the pane's tty as a path. */
  list:
    '[\n' +
    '  {\n' +
    '    "window_id": 0,\n' +
    '    "tab_id": 0,\n' +
    '    "pane_id": 0,\n' +
    '    "workspace": "default",\n' +
    '    "size": {\n' +
    '      "rows": 11,\n' +
    '      "cols": 80,\n' +
    '      "pixel_width": 640,\n' +
    '      "pixel_height": 176,\n' +
    '      "dpi": 0\n' +
    '    },\n' +
    '    "title": "qemu-x86_64-static",\n' +
    '    "cwd": "file:///home/u",\n' +
    '    "cursor_x": 2,\n' +
    '    "cursor_y": 0,\n' +
    '    "cursor_shape": "Default",\n' +
    '    "cursor_visibility": "Visible",\n' +
    '    "left_col": 0,\n' +
    '    "top_row": 0,\n' +
    '    "tab_title": "",\n' +
    '    "window_title": "",\n' +
    '    "is_active": false,\n' +
    '    "is_zoomed": false,\n' +
    '    "tty_name": "/dev/pts/0"\n' +
    '  },\n' +
    '  {\n' +
    '    "window_id": 0,\n' +
    '    "tab_id": 0,\n' +
    '    "pane_id": 1,\n' +
    '    "workspace": "default",\n' +
    '    "size": {\n' +
    '      "rows": 12,\n' +
    '      "cols": 80,\n' +
    '      "pixel_width": 640,\n' +
    '      "pixel_height": 192,\n' +
    '      "dpi": 0\n' +
    '    },\n' +
    '    "title": "qemu-x86_64-static",\n' +
    '    "cwd": "file:///home/u",\n' +
    '    "cursor_x": 2,\n' +
    '    "cursor_y": 0,\n' +
    '    "cursor_shape": "Default",\n' +
    '    "cursor_visibility": "Visible",\n' +
    '    "left_col": 0,\n' +
    '    "top_row": 12,\n' +
    '    "tab_title": "",\n' +
    '    "window_title": "",\n' +
    '    "is_active": true,\n' +
    '    "is_zoomed": false,\n' +
    '    "tty_name": "/dev/pts/1"\n' +
    '  },\n' +
    '  {\n' +
    '    "window_id": 0,\n' +
    '    "tab_id": 1,\n' +
    '    "pane_id": 2,\n' +
    '    "workspace": "default",\n' +
    '    "size": {\n' +
    '      "rows": 24,\n' +
    '      "cols": 80,\n' +
    '      "pixel_width": 640,\n' +
    '      "pixel_height": 384,\n' +
    '      "dpi": 0\n' +
    '    },\n' +
    '    "title": "qemu-x86_64-static",\n' +
    '    "cwd": "file:///home/u",\n' +
    '    "cursor_x": 2,\n' +
    '    "cursor_y": 0,\n' +
    '    "cursor_shape": "Default",\n' +
    '    "cursor_visibility": "Visible",\n' +
    '    "left_col": 0,\n' +
    '    "top_row": 0,\n' +
    '    "tab_title": "",\n' +
    '    "window_title": "",\n' +
    '    "is_active": true,\n' +
    '    "is_zoomed": false,\n' +
    '    "tty_name": "/dev/pts/2"\n' +
    '  }\n' +
    ']',
  /** `activate-pane --pane-id 0`, pane 0 neither its tab's active pane nor in the window's active tab: it made pane 0
   *  tab 0's active pane and tab 0 the window's active tab (the probe read tab 1 before, tab 0 after). So no
   *  `activate-tab` is needed after it, and none was recorded. */
  activatePane: {
    argv: ['wezterm', 'cli', '--no-auto-start', 'activate-pane', '--pane-id', '0'],
    exitCode: 0,
    stdout: '',
    stderr: '',
    activeTabBefore: 1,
    activeTabAfter: 0,
    tabBecameActive: true,
    /** `list --format json` right after: only pane 0's and pane 1's `is_active` changed. */
    listAfter:
      '[\n' +
      '  {\n' +
      '    "window_id": 0,\n' +
      '    "tab_id": 0,\n' +
      '    "pane_id": 0,\n' +
      '    "workspace": "default",\n' +
      '    "size": {\n' +
      '      "rows": 11,\n' +
      '      "cols": 80,\n' +
      '      "pixel_width": 640,\n' +
      '      "pixel_height": 176,\n' +
      '      "dpi": 0\n' +
      '    },\n' +
      '    "title": "qemu-x86_64-static",\n' +
      '    "cwd": "file:///home/u",\n' +
      '    "cursor_x": 2,\n' +
      '    "cursor_y": 0,\n' +
      '    "cursor_shape": "Default",\n' +
      '    "cursor_visibility": "Visible",\n' +
      '    "left_col": 0,\n' +
      '    "top_row": 0,\n' +
      '    "tab_title": "",\n' +
      '    "window_title": "",\n' +
      '    "is_active": true,\n' +
      '    "is_zoomed": false,\n' +
      '    "tty_name": "/dev/pts/0"\n' +
      '  },\n' +
      '  {\n' +
      '    "window_id": 0,\n' +
      '    "tab_id": 0,\n' +
      '    "pane_id": 1,\n' +
      '    "workspace": "default",\n' +
      '    "size": {\n' +
      '      "rows": 12,\n' +
      '      "cols": 80,\n' +
      '      "pixel_width": 640,\n' +
      '      "pixel_height": 192,\n' +
      '      "dpi": 0\n' +
      '    },\n' +
      '    "title": "qemu-x86_64-static",\n' +
      '    "cwd": "file:///home/u",\n' +
      '    "cursor_x": 2,\n' +
      '    "cursor_y": 0,\n' +
      '    "cursor_shape": "Default",\n' +
      '    "cursor_visibility": "Visible",\n' +
      '    "left_col": 0,\n' +
      '    "top_row": 12,\n' +
      '    "tab_title": "",\n' +
      '    "window_title": "",\n' +
      '    "is_active": false,\n' +
      '    "is_zoomed": false,\n' +
      '    "tty_name": "/dev/pts/1"\n' +
      '  },\n' +
      '  {\n' +
      '    "window_id": 0,\n' +
      '    "tab_id": 1,\n' +
      '    "pane_id": 2,\n' +
      '    "workspace": "default",\n' +
      '    "size": {\n' +
      '      "rows": 24,\n' +
      '      "cols": 80,\n' +
      '      "pixel_width": 640,\n' +
      '      "pixel_height": 384,\n' +
      '      "dpi": 0\n' +
      '    },\n' +
      '    "title": "qemu-x86_64-static",\n' +
      '    "cwd": "file:///home/u",\n' +
      '    "cursor_x": 2,\n' +
      '    "cursor_y": 0,\n' +
      '    "cursor_shape": "Default",\n' +
      '    "cursor_visibility": "Visible",\n' +
      '    "left_col": 0,\n' +
      '    "top_row": 0,\n' +
      '    "tab_title": "",\n' +
      '    "window_title": "",\n' +
      '    "is_active": true,\n' +
      '    "is_zoomed": false,\n' +
      '    "tty_name": "/dev/pts/2"\n' +
      '  }\n' +
      ']',
  },
  /** `activate-pane --pane-id 99`, a pane the server does not have: exit 1, nothing on stdout. */
  missingPane: {
    argv: ['wezterm', 'cli', '--no-auto-start', 'activate-pane', '--pane-id', '99'],
    exitCode: 1,
    stdout: '',
    stderr: '02:13:11.306  ERROR  wezterm > unexpected response Ok(ErrorResponse(ErrorResponse { reason: "Error: pane 99 not found" })); terminating\n',
  },
} as const
