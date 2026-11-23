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
 *
 * How the GUI's clients were read (`listClients`, for the dial's focus follow:
 * docs/plans/2026-11-23-dial-wezterm-kitty-focus-follow-plan.md, Task 1): recorded 2026-11-23 in a disposable
 * `ubuntu:24.04` container (`--platform linux/arm64`, native, Docker on macOS), from the release's Ubuntu 22.04 arm64
 * `.deb` (`download.arm64`), with xvfb 2:21.1.12-1ubuntu1.9, libgl1-mesa-dri and libegl-mesa0 25.2.8-0ubuntu0.24.04.5,
 * libegl1 1.7.0-1build1, fontconfig 2.15.0-1.1ubuntu2, fonts-dejavu-core 2.37-8, openbox 3.6.1-12build5, xdotool
 * 1:3.20160805.1-5build1 and procps 2:4.0.4-4ubuntu3.3 from the archive. User `u` (uid 1001), `Xvfb :99 -screen 0
 * 1280x800x24` with `openbox` on it, `DISPLAY=:99`, `LIBGL_ALWAYS_SOFTWARE=1`, `XDG_RUNTIME_DIR=/tmp/xdg` (0700), a
 * `wezterm.lua` of `return { front_end = 'Software', enable_wayland = false }`, and the GUI started as people start it:
 * `wezterm start -- sleep 100000`, no `--always-new-process`; it made window 0, tab 0, pane 0. Every call ran as
 * `wezterm cli --no-auto-start …` from outside the GUI with no `WEZTERM_UNIX_SOCKET`, as the daemon runs. In order:
 * `spawn -- sleep 100000` made tab 1 (pane 1), `split-pane --pane-id 1 -- sleep 100000` made pane 2 in tab 1,
 * `activate-pane --pane-id 0`, `xdotool key --window <the GUI's X window> ctrl+Tab` (tab 1 again, pane 2 its active
 * pane), then `spawn --new-window -- sleep 100000` (window 1, pane 3); `list-clients` was read 2 s after each. `list`
 * right after the split said pane 2 was tab 1's active pane while `list-clients` still said 1: a pane split from the
 * CLI is not focused until the GUI moves. `hostname` is the container's.
 */
export const RECORDED_WEZTERM = {
  source: 'recorded',
  version: '20240203-110809-5046fc22',
  download: {
    x64: {
      url: 'https://github.com/wezterm/wezterm/releases/download/20240203-110809-5046fc22/wezterm-20240203-110809-5046fc22.Ubuntu22.04.deb',
      sha256: '86358dab5794a4fb63f7c91dd68d4fdc3da58faad648a58fc77d2bd51c7b0686',
    },
    arm64: {
      url: 'https://github.com/wezterm/wezterm/releases/download/20240203-110809-5046fc22/wezterm-20240203-110809-5046fc22.Ubuntu22.04.arm64.deb',
      sha256: '3e64e618601f254795f7d18a41d8dda27092ddc4e7f91e017492156c48f9798b',
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
  /** `list-clients --format json` against the GUI (header, "How the GUI's clients were read"). The GUI is the one
   *  client; `focused_pane_id` is the pane keyboard input goes to, and `idle_time` counts from the person's last key
   *  in the GUI (it equals `connection_elapsed` until the first one). Each stdout is whole (no newline at its end);
   *  exit 0 and stderr empty but where said. */
  listClients: {
    argv: ['wezterm', 'cli', '--no-auto-start', 'list-clients', '--format', 'json'],
    /** Under `$XDG_RUNTIME_DIR/wezterm/`, a link to the GUI's `gui-sock-<its pid>`, through which `wezterm cli` with
     *  no `WEZTERM_UNIX_SOCKET` connected. The link and the socket stayed after the GUI was killed. */
    guiSocketLink: 'x11-:99-org.wezfurlong.wezterm',
    /** As the GUI started: pane 0 focused. */
    gui: {
      exitCode: 0,
      stdout:
        '[\n' +
        '  {\n' +
        '    "username": "u",\n' +
        '    "hostname": "f3b2d8d02d68",\n' +
        '    "pid": 4751,\n' +
        '    "connection_elapsed": {\n' +
        '      "secs": 8,\n' +
        '      "nanos": 26143552\n' +
        '    },\n' +
        '    "idle_time": {\n' +
        '      "secs": 8,\n' +
        '      "nanos": 26143552\n' +
        '    },\n' +
        '    "workspace": "default",\n' +
        '    "focused_pane_id": 0\n' +
        '  }\n' +
        ']',
      stderr: '',
    },
    /** `spawn` made tab 1 (pane 1) and focused it. */
    afterSpawn: {
      stdout:
        '[\n' +
        '  {\n' +
        '    "username": "u",\n' +
        '    "hostname": "f3b2d8d02d68",\n' +
        '    "pid": 4751,\n' +
        '    "connection_elapsed": {\n' +
        '      "secs": 10,\n' +
        '      "nanos": 72363095\n' +
        '    },\n' +
        '    "idle_time": {\n' +
        '      "secs": 10,\n' +
        '      "nanos": 72363095\n' +
        '    },\n' +
        '    "workspace": "default",\n' +
        '    "focused_pane_id": 1\n' +
        '  }\n' +
        ']',
    },
    /** `split-pane --pane-id 1` from the CLI made pane 2: still 1. */
    afterSplit: {
      stdout:
        '[\n' +
        '  {\n' +
        '    "username": "u",\n' +
        '    "hostname": "f3b2d8d02d68",\n' +
        '    "pid": 4751,\n' +
        '    "connection_elapsed": {\n' +
        '      "secs": 12,\n' +
        '      "nanos": 108713929\n' +
        '    },\n' +
        '    "idle_time": {\n' +
        '      "secs": 12,\n' +
        '      "nanos": 108713929\n' +
        '    },\n' +
        '    "workspace": "default",\n' +
        '    "focused_pane_id": 1\n' +
        '  }\n' +
        ']',
    },
    /** `activate-pane --pane-id 0`: 0. */
    afterActivate: {
      stdout:
        '[\n' +
        '  {\n' +
        '    "username": "u",\n' +
        '    "hostname": "f3b2d8d02d68",\n' +
        '    "pid": 4751,\n' +
        '    "connection_elapsed": {\n' +
        '      "secs": 14,\n' +
        '      "nanos": 146738763\n' +
        '    },\n' +
        '    "idle_time": {\n' +
        '      "secs": 14,\n' +
        '      "nanos": 146738763\n' +
        '    },\n' +
        '    "workspace": "default",\n' +
        '    "focused_pane_id": 0\n' +
        '  }\n' +
        ']',
    },
    /** ctrl+Tab pressed in the GUI: tab 1's active pane, 2, with `idle_time` counting from the key. */
    afterKey: {
      stdout:
        '[\n' +
        '  {\n' +
        '    "username": "u",\n' +
        '    "hostname": "f3b2d8d02d68",\n' +
        '    "pid": 4751,\n' +
        '    "connection_elapsed": {\n' +
        '      "secs": 16,\n' +
        '      "nanos": 249970125\n' +
        '    },\n' +
        '    "idle_time": {\n' +
        '      "secs": 2,\n' +
        '      "nanos": 249970125\n' +
        '    },\n' +
        '    "workspace": "default",\n' +
        '    "focused_pane_id": 2\n' +
        '  }\n' +
        ']',
    },
    /** `spawn --new-window`: the new window's pane, 3. */
    afterNewWindow: {
      stdout:
        '[\n' +
        '  {\n' +
        '    "username": "u",\n' +
        '    "hostname": "f3b2d8d02d68",\n' +
        '    "pid": 4751,\n' +
        '    "connection_elapsed": {\n' +
        '      "secs": 19,\n' +
        '      "nanos": 280397918\n' +
        '    },\n' +
        '    "idle_time": {\n' +
        '      "secs": 5,\n' +
        '      "nanos": 280397918\n' +
        '    },\n' +
        '    "workspace": "default",\n' +
        '    "focused_pane_id": 3\n' +
        '  }\n' +
        ']',
    },
    /** The GUI killed (`pkill -f wezterm-gui`): the call still went through the link it left and failed. */
    noGui: {
      exitCode: 1,
      stdout: '',
      stderr:
        '15:22:34.467  ERROR  wezterm > failed to connect to Socket("/tmp/xdg/wezterm/gui-sock-4751"): connecting to /tmp/xdg/wezterm/gui-sock-4751; terminating\n',
    },
    /** The GUI running, the call made with `XDG_RUNTIME_DIR` unset (`env -u XDG_RUNTIME_DIR …`): it looked for the
     *  mux server's default socket instead, found none, and never reached the GUI. */
    noRuntimeDir: {
      exitCode: 1,
      stdout: '',
      stderr:
        '15:22:32.302  ERROR  wezterm > failed to connect to Socket("/home/u/.local/share/wezterm/sock"): connecting to /home/u/.local/share/wezterm/sock; terminating\n',
    },
    /** The mean of 20 calls one after another with the GUI running, in ms. */
    callMs: 7.2,
  },
  /** `activate-pane --pane-id 99`, a pane the server does not have: exit 1, nothing on stdout. */
  missingPane: {
    argv: ['wezterm', 'cli', '--no-auto-start', 'activate-pane', '--pane-id', '99'],
    exitCode: 1,
    stdout: '',
    stderr: '02:13:11.306  ERROR  wezterm > unexpected response Ok(ErrorResponse(ErrorResponse { reason: "Error: pane 99 not found" })); terminating\n',
  },
} as const
