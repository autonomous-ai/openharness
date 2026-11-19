/**
 * Zellij 0.44.3 as it ran on Ubuntu 24.04, for the Zellij adapter's specs (docs/plans/2026-11-19-dial-linux-plan.md,
 * Task 7; spec § 3.2). Recorded 2026-11-19 in a disposable `ubuntu:24.04` container (arm64, Docker on macOS), from the
 * release's own static binary (`zellij-aarch64-unknown-linux-musl.tar.gz`, its sha256 checked against the release's
 * `.sha256sum`), with `jq` 1.7 from the archive to read the JSON. Nothing else installed; no account.
 *
 * How it was made: user `u` (uid 1000) on host `box`, `HOME` with a config from `zellij setup --dump-config` plus
 * `show_release_notes false` and `show_startup_tips false` (else a first run floats a release-notes plugin over the
 * panes), `TERM=xterm-256color`. `zellij --layout /work/two.kdl attach --create-background s1` started the session,
 * the layout two terminal panes, one above the other (`layout { pane split_direction="horizontal" { pane; pane } }`):
 * a background session is 50 columns wide, and `action new-pane --direction down` printed `terminal_1` yet opened no
 * pane there, so the layout makes the second pane. Every other command ran from outside the session, as the daemon
 * runs, in `/work/proj`; each value is its exact argv, exit code and output.
 */
export const RECORDED_ZELLIJ = {
  source: 'recorded',
  version: '0.44.3',
  /** The release's tarballs, by `process.arch`; each sha256 is of the tarball (the release's `.sha256sum` is of the
   *  binary inside it). */
  download: {
    x64: {
      url: 'https://github.com/zellij-org/zellij/releases/download/v0.44.3/zellij-x86_64-unknown-linux-musl.tar.gz',
      sha256: '0f7c346788627f506c0a28296517768633cff24fc822a739f8264b640ecad751',
    },
    arm64: {
      url: 'https://github.com/zellij-org/zellij/releases/download/v0.44.3/zellij-aarch64-unknown-linux-musl.tar.gz',
      sha256: '15e6534d42644d66973d136c590c49739dcfd6a1a2a0d3d917973f16c81b45fb',
    },
  },
  /** `zellij action --help`. A command's `PANE_ID` is `terminal_<n>`, `plugin_<n>` or a bare number, which is a
   *  terminal's: `write-chars` and `send-keys` take it as `--pane-id` (`-p`), `focus-pane-id` as its one argument. */
  actionHelp:
    'zellij-action \n' +
    'Send actions to a specific session\n' +
    '\n' +
    'USAGE:\n' +
    '    zellij action <SUBCOMMAND>\n' +
    '\n' +
    'OPTIONS:\n' +
    '    -h, --help    Print help information\n' +
    '\n' +
    'SUBCOMMANDS:\n' +
    '    are-floating-panes-visible\n' +
    '            Check if floating panes are visible in the specified tab (or active tab)\n' +
    '    change-floating-pane-coordinates\n' +
    '            \n' +
    '    clear\n' +
    '            Clear all buffers for a focused pane\n' +
    '    close-pane\n' +
    '            Close the focused pane\n' +
    '    close-tab\n' +
    '            Close the current tab\n' +
    '    close-tab-by-id\n' +
    '            Close tab with stable ID\n' +
    '    current-tab-info\n' +
    '            Get information about the currently active tab\n' +
    '    detach\n' +
    '            Detach from the current session\n' +
    '    dump-layout\n' +
    '            Dump current layout to stdout\n' +
    '    dump-screen\n' +
    '            Dumps the viewport and optionally scrollback of a pane to a file or STDOUT\n' +
    '    edit\n' +
    '            Open the specified file in a new zellij pane with your default EDITOR Returns: Created\n' +
    '            pane ID (format: terminal_<id>)\n' +
    '    edit-scrollback\n' +
    '            Open the pane scrollback in your default editor\n' +
    '    focus-next-pane\n' +
    '            Change focus to the next pane\n' +
    '    focus-pane-id\n' +
    '            Focus a specific pane by its ID\n' +
    '    focus-previous-pane\n' +
    '            Change focus to the previous pane\n' +
    '    go-to-next-tab\n' +
    '            Go to the next tab\n' +
    '    go-to-previous-tab\n' +
    '            Go to the previous tab\n' +
    '    go-to-tab\n' +
    '            Go to tab with index [index]\n' +
    '    go-to-tab-by-id\n' +
    '            Go to tab with stable ID\n' +
    '    go-to-tab-name\n' +
    '            Go to tab with name [name]\n' +
    '    half-page-scroll-down\n' +
    '            Scroll down half page in focus pane\n' +
    '    half-page-scroll-up\n' +
    '            Scroll up half page in focus pane\n' +
    '    help\n' +
    '            Print this message or the help of the given subcommand(s)\n' +
    '    hide-floating-panes\n' +
    '            Hide all floating panes in the specified tab (or active tab if tab_id is not provided)\n' +
    '    launch-or-focus-plugin\n' +
    '            Returns: Plugin pane ID (format: plugin_<id>) when creating or focusing plugin\n' +
    '    launch-plugin\n' +
    '            Returns: Plugin pane ID (format: plugin_<id>)\n' +
    '    list-clients\n' +
    '            \n' +
    '    list-panes\n' +
    '            List all panes in the current session\n' +
    '    list-tabs\n' +
    '            List all tabs with their information\n' +
    '    move-focus\n' +
    '            Move the focused pane in the specified direction. [right|left|up|down]\n' +
    '    move-focus-or-tab\n' +
    '            Move focus to the pane or tab (if on screen edge) in the specified direction [right|\n' +
    '            left|up|down]\n' +
    '    move-pane\n' +
    '            Change the location of the focused pane in the specified direction or rotate forwrads\n' +
    '            [right|left|up|down]\n' +
    '    move-pane-backwards\n' +
    '            Rotate the location of the previous pane backwards\n' +
    '    move-tab\n' +
    '            Move the focused tab in the specified direction. [right|left]\n' +
    '    new-pane\n' +
    '            Open a new pane in the specified direction [right|down] If no direction is specified,\n' +
    '            will try to use the biggest available space. Returns: Created pane ID (format:\n' +
    '            terminal_<id> or plugin_<id>)\n' +
    '    new-tab\n' +
    '            Create a new tab, optionally with a specified tab layout and name\n' +
    '    next-swap-layout\n' +
    '            \n' +
    '    override-layout\n' +
    '            Override the layout of the active tab\n' +
    '    page-scroll-down\n' +
    '            Scroll down one page in focus pane\n' +
    '    page-scroll-up\n' +
    '            Scroll up one page in focus pane\n' +
    '    paste\n' +
    '            Paste text to the terminal (using bracketed paste mode)\n' +
    '    pipe\n' +
    '            Send data to one or more plugins, launch them if they are not running\n' +
    '    previous-swap-layout\n' +
    '            \n' +
    '    query-tab-names\n' +
    '            Query all tab names\n' +
    '    rename-pane\n' +
    '            Renames the focused pane\n' +
    '    rename-session\n' +
    '            \n' +
    '    rename-tab\n' +
    '            Renames the focused pane\n' +
    '    rename-tab-by-id\n' +
    '            Rename tab by stable ID\n' +
    '    resize\n' +
    '            [increase|decrease] the focused panes area at the [left|down|up|right] border\n' +
    '    save-session\n' +
    '            Save the current session state to disk immediately\n' +
    '    scroll-down\n' +
    '            Scroll down in focus pane\n' +
    '    scroll-to-bottom\n' +
    '            Scroll down to bottom in focus pane\n' +
    '    scroll-to-top\n' +
    '            Scroll up to top in focus pane\n' +
    '    scroll-up\n' +
    '            Scroll up in the focused pane\n' +
    '    send-keys\n' +
    '            Send one or more keys to the terminal (e.g., "Ctrl a", "F1", "Alt Shift b")\n' +
    '    set-dark-theme\n' +
    '            Switch the theme to dark (uses configured `theme_dark`)\n' +
    '    set-light-theme\n' +
    '            Switch the theme to light (uses configured `theme_light`)\n' +
    '    set-pane-borderless\n' +
    '            \n' +
    '    set-pane-color\n' +
    '            Set the default foreground/background color of a pane\n' +
    '    show-floating-panes\n' +
    '            Show all floating panes in the specified tab (or active tab if tab_id is not provided)\n' +
    '    stack-panes\n' +
    '            Stack pane ids Ids are a space separated list of pane ids. They should either be in\n' +
    '            the form of `terminal_<int>` (eg. terminal_1), `plugin_<int>` (eg. plugin_1) or bare\n' +
    '            integers in which case they\'ll be considered terminals (eg. 1 is the equivalent of\n' +
    '            terminal_1)\n' +
    '    start-or-reload-plugin\n' +
    '            \n' +
    '    switch-mode\n' +
    '            Switch input mode of all connected clients [locked|pane|tab|resize|move|search|session]\n' +
    '    switch-session\n' +
    '            Switch to a different session\n' +
    '    toggle-active-sync-tab\n' +
    '            Toggle between sending text commands to all panes on the current tab and normal mode\n' +
    '    toggle-floating-panes\n' +
    '            Toggle the visibility of all floating panes in the current Tab, open one if none exist\n' +
    '    toggle-fullscreen\n' +
    '            Toggle between fullscreen focus pane and normal layout\n' +
    '    toggle-pane-borderless\n' +
    '            \n' +
    '    toggle-pane-embed-or-floating\n' +
    '            Embed focused pane if floating or float focused pane if embedded\n' +
    '    toggle-pane-frames\n' +
    '            Toggle frames around panes in the UI\n' +
    '    toggle-pane-pinned\n' +
    '            \n' +
    '    toggle-theme\n' +
    '            Toggle between dark and light themes (used configured `theme_dark` and `theme_light`)\n' +
    '    undo-rename-pane\n' +
    '            Remove a previously set pane name\n' +
    '    undo-rename-tab\n' +
    '            Remove a previously set tab name\n' +
    '    write\n' +
    '            Write bytes to the terminal\n' +
    '    write-chars\n' +
    '            Write characters to the terminal\n',
  /** A pane's shell, read from inside pane 1 (`env`). `ZELLIJ` is the session's `0`, not a pane's. */
  env: { ZELLIJ: '0', ZELLIJ_PANE_ID: '1', ZELLIJ_SESSION_NAME: 's1' },
  /** Tried with `zellij attach --create-background <name>`. */
  sessionNameRule:
    'Any name but one holding "/" (exit 1, "Session name cannot contain \'/\'."), "." or ".." (exit 1, "Invalid ' +
    'session name"), as long as its socket path, /tmp/zellij-<uid>/contract_version_1/<name>, fits 107 bytes (a ' +
    '100-character name: exit 1, "the IPC socket path is too long (136 bytes, max 107)"; 64 characters started). ' +
    'Spaces, ":" and "é" were taken. A name starting with "-" is refused by the argument parser as a flag (exit 2).',
  /** `action list-panes --json`: pane 0 is the `zellij:link` plugin, then terminal panes 0 and 1. Plugin and terminal
   *  ids are counted apart (both have a 0), so a pane is known by `id` and `is_plugin` together. */
  listPanes: {
    args: ['zellij', '--session', 's1', 'action', 'list-panes', '--json'],
    code: 0,
    stdout:
      '[\n' +
      '  {\n' +
      '    "id": 0,\n' +
      '    "is_plugin": true,\n' +
      '    "is_focused": false,\n' +
      '    "is_fullscreen": false,\n' +
      '    "is_floating": false,\n' +
      '    "is_suppressed": true,\n' +
      '    "title": "(.) - zellij:link",\n' +
      '    "exited": false,\n' +
      '    "exit_status": null,\n' +
      '    "is_held": false,\n' +
      '    "pane_x": 13,\n' +
      '    "pane_content_x": 14,\n' +
      '    "pane_y": 13,\n' +
      '    "pane_content_y": 14,\n' +
      '    "pane_rows": 25,\n' +
      '    "pane_content_rows": 23,\n' +
      '    "pane_columns": 25,\n' +
      '    "pane_content_columns": 23,\n' +
      '    "cursor_coordinates_in_pane": null,\n' +
      '    "terminal_command": null,\n' +
      '    "plugin_url": "zellij:link",\n' +
      '    "is_selectable": true,\n' +
      '    "index_in_pane_group": {},\n' +
      '    "default_fg": null,\n' +
      '    "default_bg": null,\n' +
      '    "tab_id": 0,\n' +
      '    "tab_position": 0,\n' +
      '    "tab_name": "Tab #1"\n' +
      '  },\n' +
      '  {\n' +
      '    "id": 0,\n' +
      '    "is_plugin": false,\n' +
      '    "is_focused": true,\n' +
      '    "is_fullscreen": false,\n' +
      '    "is_floating": false,\n' +
      '    "is_suppressed": false,\n' +
      '    "title": "u@box: /work/proj",\n' +
      '    "exited": false,\n' +
      '    "exit_status": null,\n' +
      '    "is_held": false,\n' +
      '    "pane_x": 0,\n' +
      '    "pane_content_x": 1,\n' +
      '    "pane_y": 0,\n' +
      '    "pane_content_y": 1,\n' +
      '    "pane_rows": 25,\n' +
      '    "pane_content_rows": 23,\n' +
      '    "pane_columns": 50,\n' +
      '    "pane_content_columns": 48,\n' +
      '    "cursor_coordinates_in_pane": [\n' +
      '      19,\n' +
      '      1\n' +
      '    ],\n' +
      '    "terminal_command": null,\n' +
      '    "plugin_url": null,\n' +
      '    "is_selectable": true,\n' +
      '    "index_in_pane_group": {},\n' +
      '    "default_fg": null,\n' +
      '    "default_bg": null,\n' +
      '    "tab_id": 0,\n' +
      '    "tab_position": 0,\n' +
      '    "tab_name": "Tab #1",\n' +
      '    "pane_command": "/bin/bash",\n' +
      '    "pane_cwd": "/work/proj"\n' +
      '  },\n' +
      '  {\n' +
      '    "id": 1,\n' +
      '    "is_plugin": false,\n' +
      '    "is_focused": false,\n' +
      '    "is_fullscreen": false,\n' +
      '    "is_floating": false,\n' +
      '    "is_suppressed": false,\n' +
      '    "title": "u@box: /work/proj",\n' +
      '    "exited": false,\n' +
      '    "exit_status": null,\n' +
      '    "is_held": false,\n' +
      '    "pane_x": 0,\n' +
      '    "pane_content_x": 1,\n' +
      '    "pane_y": 25,\n' +
      '    "pane_content_y": 26,\n' +
      '    "pane_rows": 25,\n' +
      '    "pane_content_rows": 23,\n' +
      '    "pane_columns": 50,\n' +
      '    "pane_content_columns": 48,\n' +
      '    "cursor_coordinates_in_pane": [\n' +
      '      19,\n' +
      '      1\n' +
      '    ],\n' +
      '    "terminal_command": null,\n' +
      '    "plugin_url": null,\n' +
      '    "is_selectable": true,\n' +
      '    "index_in_pane_group": {},\n' +
      '    "default_fg": null,\n' +
      '    "default_bg": null,\n' +
      '    "tab_id": 0,\n' +
      '    "tab_position": 0,\n' +
      '    "tab_name": "Tab #1",\n' +
      '    "pane_command": "/bin/bash",\n' +
      '    "pane_cwd": "/work/proj"\n' +
      '  }\n' +
      ']\n',
  },
  /** Pane 1 had no focus before; after it, `list-panes` says `is_focused` of terminal 1 and not of terminal 0. It works
   *  with no client attached (`action focus-next-pane` then answers "No connected clients to change focus for"). */
  focusPaneId: { args: ['zellij', '--session', 's1', 'action', 'focus-pane-id', '1'], code: 0 },
  /** `landed` is `action dump-screen --pane-id 1` after this and `sendKeys`. Words starting with `--` after the `--`
   *  were written as they are (`--not-a-flag` showed at the prompt). */
  writeChars: {
    args: ['zellij', '--session', 's1', 'action', 'write-chars', '--pane-id', '1', '--', 'echo agent-words'],
    code: 0,
    landed:
      'u@box:/work/proj$ echo agent-words\nagent-words\nu@box:/work/proj$\n' +
      '\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n',
  },
  sendKeys: { args: ['zellij', '--session', 's1', 'action', 'send-keys', '--pane-id', '1', 'Enter'], code: 0 },
  /** A pane id the session does not hold, to `focus-pane-id`. `write-chars` and `send-keys` to that id (and to
   *  `plugin_0`, and to pane 1 once it had closed) exited 0 and printed nothing: only `list-panes` tells a pane is
   *  there. Pane ids are not reused: after pane 1 closed, the next pane was `terminal_2`. */
  missingPane: {
    args: ['zellij', '--session', 's1', 'action', 'focus-pane-id', '9'],
    code: 2,
    stderr: 'Pane with id Terminal(9) not found\n',
  },
  /** A session that is not running; its stderr names the sessions that are (here `s1`). `list-panes` and
   *  `write-chars` to it answered the same. */
  missingSession: {
    args: ['zellij', '--session', 'gone', 'action', 'focus-pane-id', '1'],
    code: 1,
    stderr: 'Session \'gone\' not found. The following sessions are active:\ns1\n',
  },
  /** `zellij --session s1 subscribe --format json --pane-id 0 --pane-id 1` while `focus-pane-id` moved focus to
   *  pane 1 and back to pane 0 (2 s apart), then `echo hi` was typed into pane 1. `lines` is what it printed, in order:
   *  one initial `pane_update` per pane, nothing for either focus move, two updates for the typing; the last line came
   *  from a second run on pane 1 alone when its shell exited (that run then ended, exit 0). `--format raw` printed the
   *  same viewports as bare text, also nothing for focus. `--pane-id` is required (exit 2 without it), and one the
   *  session does not hold ends it at once (exit 2, "Pane terminal_9 not found"). */
  subscribe: {
    help:
      'zellij-subscribe \n' +
      'Subscribe to pane render updates (viewport and scrollback)\n' +
      '\n' +
      'USAGE:\n' +
      '    zellij [--session <OTHER SESSION NAME>] subscribe [OPTIONS] --pane-id...\n' +
      '\n' +
      'OPTIONS:\n' +
      '        --ansi\n' +
      '            Preserve ANSI styling in the output\n' +
      '\n' +
      '    -f, --format <FORMAT>\n' +
      '            Output format [default: raw] [possible values: raw, json]\n' +
      '\n' +
      '    -h, --help\n' +
      '            Print help information\n' +
      '\n' +
      '    -p, --pane-id <PANE_ID>...\n' +
      '            Pane ID(s) to subscribe to (e.g. terminal_1, plugin_2, or bare number like 1)\n' +
      '\n' +
      '    -s, --scrollback [<SCROLLBACK>...]\n' +
      '            Include scrollback lines in initial delivery. Bare --scrollback = all scrollback,\n' +
      '            --scrollback N = last N lines\n',
    lines: [
      '{"event":"pane_update","is_initial":true,"pane_id":"terminal_0","scrollback":null,"viewport":["u@box:/work/proj$                               ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                "]}',
      '{"event":"pane_update","is_initial":true,"pane_id":"terminal_1","scrollback":null,"viewport":["u@box:/work/proj$                               ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                "]}',
      '{"event":"pane_update","is_initial":false,"pane_id":"terminal_1","scrollback":null,"viewport":["u@box:/work/proj$ echo hi                       ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                "]}',
      '{"event":"pane_update","is_initial":false,"pane_id":"terminal_1","scrollback":null,"viewport":["u@box:/work/proj$ echo hi                       ","hi                                              ","u@box:/work/proj$                               ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                ","                                                "]}',
      '{"event":"pane_closed","pane_id":"terminal_1"}',
    ],
    reportsFocus: false,
    why:
      'zellij subscribe reports only the rendered viewport (and scrollback) of the panes it is given, as ' +
      'pane_update and pane_closed events; moving focus between them printed no line, and no event or field names ' +
      'the focused pane.',
  },
} as const
