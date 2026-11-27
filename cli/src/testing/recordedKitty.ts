/**
 * kitty 0.32.2 as it ran on Ubuntu 24.04, for the kitty adapter's specs (docs/plans/2026-11-19-dial-linux-plan.md,
 * Task 8; spec § 3.3). Recorded 2026-11-19 in a disposable `arm64v8/ubuntu:24.04` container (Podman on macOS), from
 * the archive's packages: kitty 0.32.2-1ubuntu0.4 (it ships `/usr/bin/kitten` beside `/usr/bin/kitty`), xvfb
 * 2:21.1.12-1ubuntu1.9, libgl1-mesa-dri 25.2.8-0ubuntu0.24.04.5, fontconfig 2.15.0-1.1ubuntu2 and fonts-dejavu-core
 * 2.37-8. Nothing else installed; no account.
 *
 * How it was made: user `u` (uid 1000) on host `box`, `Xvfb :99 -screen 0 1280x800x24`, `DISPLAY=:99`,
 * `LIBGL_ALWAYS_SOFTWARE=1`. The agent's kitty was `kitty -o allow_remote_control=socket-only --listen-on
 * unix:/tmp/kitty --directory /work sh -c '…; exec cat >> landed'`, so each line typed into its window landed in a
 * file through the window's tty (Enter arrives as `\n` there). `kitten @ --to unix:/tmp/kitty launch --title other`
 * opened the second window and `set-window-title --match id:1 agent` named the first. Every command ran from outside
 * kitty, as the daemon runs; each value is its exact argv, exit code and output. The socket kitty made was
 * `srwxr-xr-x u u /tmp/kitty`, and kitty removed it when it quit. The Enter after each line was `send-key --match id:1
 * enter` then, with window 1 focused; `sendKeyOtherActive` shows why the adapter sends `enter` instead.
 *
 * The values with window 2 active (`sendKeyOtherActive`, `sendTextOtherActive`, `enter`) were recorded the same day in
 * the same way, with python3 3.12.3-0ubuntu2.1 also installed: `kitty -o allow_remote_control=socket-only --listen-on
 * unix:/tmp/kitty python3 raw.py w1`, then `kitten @ --to unix:/tmp/kitty launch --type=window python3 raw.py w2`,
 * which made window 2 active (`ls` said so before and after). `raw.py` puts its tty in raw mode and appends each read
 * to its file as Python's repr, so `landed` is the bytes each window's program read, untranslated, keyed by window id.
 *
 * The focus by process (`focusWindowPid`, `focusWindowPidDescendant`, `focusWindowPidMissing`) was recorded
 * 2026-11-21 the same way, with python3 3.12.3-0ubuntu2.1 and procps 2:4.0.4-4ubuntu3.3 (for `ps`) also installed:
 * `kitty -o allow_remote_control=socket-only --listen-on unix:/tmp/kitty --directory /work sh -c 'sh -c "sleep
 * 100000; true"; true'`, then `kitten @ --to unix:/tmp/kitty launch --type=tab --title other cat`, which made tab 2
 * (window 2) active and left window 1 in the inactive tab 1. Window 1's processes, by `ps`: `sh` 1430 (kitty's child),
 * its `sh` 1431 and that one's `sleep` 1432, all one process group, the tty's foreground one. Before each focus
 * `focus-window --match id:2` made tab 2 active again. Whether window 1 and its tab became active was read from `ls`:
 * its `is_active` fields alone.
 *
 * The focused window by `get-colors --match` (`focusedMatch`, for the dial's focus follow:
 * docs/plans/2026-11-23-dial-wezterm-kitty-focus-follow-plan.md, Task 1) was recorded 2026-11-23 in a disposable
 * `ubuntu:24.04` container (`--platform linux/arm64`, Docker on macOS), with the same kitty, xvfb, libgl1-mesa-dri,
 * fontconfig, fonts-dejavu-core and procps, and openbox 3.6.1-12build5 and xdotool 1:3.20160805.1-5build1 also
 * installed. User `u` (uid 1001), `Xvfb :99 -screen 0 1280x800x24` with `openbox` on it, `DISPLAY=:99`,
 * `LIBGL_ALWAYS_SOFTWARE=1`. `kitty -o allow_remote_control=socket-only --listen-on unix:/tmp/kitty sh -c 'sleep
 * 100000'` made window 1; `kitten @ --to unix:/tmp/kitty launch --type=tab --title other sleep 100000` made window 2
 * in tab 2, `launch --type=os-window --title osw sleep 100000` made window 3 in a second OS window, and `focus-window
 * --match id:1` came last; `get-colors` was asked after each, from outside kitty. The two kittys were two such
 * processes, on `unix:/tmp/kA` and `unix:/tmp/kB`, the second started 4 s after the first; then `xdotool
 * windowactivate` gave the first one's OS window the X focus. Each password mode was a kitty of its own, asked under
 * `timeout 10`: an exit within a second is a refusal, a wait to the timeout a prompt in kitty's window.
 */
export const RECORDED_KITTY = {
  source: 'recorded',
  version: '0.32.2',
  /** Under Xvfb with Mesa's llvmpipe it came up. With only kitty, xvfb and libgl1-mesa-dri installed it exited 1 at
   *  once, printing `Failed to find and load fontconfig`. */
  startsUnderXvfb: true,
  how:
    'Xvfb :99 and LIBGL_ALWAYS_SOFTWARE=1 (Mesa llvmpipe, OpenGL 4.5), with fontconfig and fonts-dejavu-core ' +
    'installed beside kitty, xvfb and libgl1-mesa-dri; kitty fails to start without fontconfig.',
  /** As the agent window's shell had them (beside `KITTY_PID`, `KITTY_PUBLIC_KEY` and `KITTY_INSTALLATION_DIR`).
   *  `--listen-on` is taken as it is. */
  env: { KITTY_WINDOW_ID: '1', KITTY_LISTEN_ON: 'unix:/tmp/kitty' },
  /** The two `kitty.conf` lines `docs/cli.md` gives (`allow_remote_control socket-only`, `listen_on unix:/tmp/kitty`)
   *  and no flags: kitty adds `-<its pid>` to a path from `kitty.conf`, and listens there. */
  envFromConf: { KITTY_WINDOW_ID: '1', KITTY_LISTEN_ON: 'unix:/tmp/kitty-4555' },
  /** `kitty --listen-on unix:/tmp/kitty-off` with remote control off (kitty's default): no socket is made and no
   *  `KITTY_LISTEN_ON` is set, the same as with no `--listen-on` at all. */
  envRemoteControlOff: { KITTY_WINDOW_ID: '1' },
  /** `kitten @ --to unix:/tmp/kitty ls`, after `focusWindow`: one OS window, one tab, windows 1 (`agent`) and 2
   *  (`other`). */
  ls:
    '[\n' +
    '  {\n' +
    '    "background_opacity": 1.0,\n' +
    '    "id": 1,\n' +
    '    "is_active": true,\n' +
    '    "is_focused": true,\n' +
    '    "last_focused": true,\n' +
    '    "platform_window_id": 2097164,\n' +
    '    "tabs": [\n' +
    '      {\n' +
    '        "active_window_history": [\n' +
    '          1,\n' +
    '          2\n' +
    '        ],\n' +
    '        "enabled_layouts": [\n' +
    '          "fat",\n' +
    '          "grid",\n' +
    '          "horizontal",\n' +
    '          "splits",\n' +
    '          "stack",\n' +
    '          "tall",\n' +
    '          "vertical"\n' +
    '        ],\n' +
    '        "groups": [\n' +
    '          {\n' +
    '            "id": 1,\n' +
    '            "windows": [\n' +
    '              1\n' +
    '            ]\n' +
    '          },\n' +
    '          {\n' +
    '            "id": 2,\n' +
    '            "windows": [\n' +
    '              2\n' +
    '            ]\n' +
    '          }\n' +
    '        ],\n' +
    '        "id": 1,\n' +
    '        "is_active": true,\n' +
    '        "is_focused": true,\n' +
    '        "layout": "fat",\n' +
    '        "layout_opts": {\n' +
    '          "bias": 50,\n' +
    '          "full_size": 1,\n' +
    '          "mirrored": false\n' +
    '        },\n' +
    '        "layout_state": {\n' +
    '          "biased_map": {},\n' +
    '          "main_bias": [\n' +
    '            0.5,\n' +
    '            0.5\n' +
    '          ],\n' +
    '          "num_full_size_windows": 1\n' +
    '        },\n' +
    '        "title": "agent",\n' +
    '        "windows": [\n' +
    '          {\n' +
    '            "at_prompt": false,\n' +
    '            "cmdline": [\n' +
    '              "cat"\n' +
    '            ],\n' +
    '            "columns": 70,\n' +
    '            "cwd": "/work",\n' +
    '            "env": {\n' +
    '              "KITTY_WINDOW_ID": "1"\n' +
    '            },\n' +
    '            "foreground_processes": [\n' +
    '              {\n' +
    '                "cmdline": [\n' +
    '                  "cat"\n' +
    '                ],\n' +
    '                "cwd": "/work",\n' +
    '                "pid": 4265\n' +
    '              }\n' +
    '            ],\n' +
    '            "id": 1,\n' +
    '            "is_active": true,\n' +
    '            "is_focused": true,\n' +
    '            "is_self": false,\n' +
    '            "lines": 11,\n' +
    '            "pid": 4265,\n' +
    '            "title": "agent",\n' +
    '            "user_vars": {}\n' +
    '          },\n' +
    '          {\n' +
    '            "at_prompt": false,\n' +
    '            "cmdline": [\n' +
    '              "cat"\n' +
    '            ],\n' +
    '            "columns": 70,\n' +
    '            "cwd": "/work",\n' +
    '            "env": {\n' +
    '              "KITTY_WINDOW_ID": "2"\n' +
    '            },\n' +
    '            "foreground_processes": [\n' +
    '              {\n' +
    '                "cmdline": [\n' +
    '                  "cat"\n' +
    '                ],\n' +
    '                "cwd": "/work",\n' +
    '                "pid": 4288\n' +
    '              }\n' +
    '            ],\n' +
    '            "id": 2,\n' +
    '            "is_active": false,\n' +
    '            "is_focused": false,\n' +
    '            "is_self": false,\n' +
    '            "lines": 11,\n' +
    '            "pid": 4288,\n' +
    '            "title": "other",\n' +
    '            "user_vars": {}\n' +
    '          }\n' +
    '        ]\n' +
    '      }\n' +
    '    ],\n' +
    '    "wm_class": "kitty",\n' +
    '    "wm_name": "kitty"\n' +
    '  }\n' +
    ']\n',
  /** Run after `launch` opened window 2; `ls` after it says window 1 is focused. It printed nothing. */
  focusWindow: { args: ['kitten', '@', '--to', 'unix:/tmp/kitty', 'focus-window', '--match', 'id:1'], code: 0 },
  /** `landed` is what reached the window's program after this and Enter. Printed nothing. */
  sendText: {
    args: ['kitten', '@', '--to', 'unix:/tmp/kitty', 'send-text', '--match', 'id:1', '--', 'hello agent'],
    code: 0,
    landed: 'hello agent\n',
  },
  /** `sent` is the argument after `--` of the same `send-text`, then Enter. kitty reads Python escapes in it:
   *  a lone backslash is read as an escape (`\n` lands a newline, `\x1b` an escape byte), and doubling every
   *  backslash lands the words as typed. Each exited 0 and printed nothing. */
  sendTextBackslash: [
    { sent: 'a\\nb', landed: 'a\nb\n' },
    { sent: '\\x1b[31m', landed: '\u001b[31m\n' },
    { sent: 'c:\\new', landed: 'c:\new\n' },
    { sent: 'a\\\\nb', landed: 'a\\nb\n' },
    { sent: '\\\\x1b[31m', landed: '\\x1b[31m\n' },
    { sent: 'c:\\\\new', landed: 'c:\\new\n' },
  ],
  /** kitty 0.32.2 sends the key to the active window, whatever `--match` names: a shell there would run its line. It
   *  printed nothing. */
  sendKeyOtherActive: {
    args: ['kitten', '@', '--to', 'unix:/tmp/kitty', 'send-key', '--match', 'id:1', 'enter'],
    code: 0,
    landed: { 1: '', 2: '\r' },
  },
  /** `send-text` reaches the window `--match` names, the active one or not. Printed nothing. */
  sendTextOtherActive: {
    args: ['kitten', '@', '--to', 'unix:/tmp/kitty', 'send-text', '--match', 'id:1', '--', 'words'],
    code: 0,
    landed: { 1: 'words', 2: '' },
  },
  /** Enter as the adapter sends it, after `sendTextOtherActive`: `\r` as two characters, which kitty reads as the
   *  carriage return the Enter key sends, to the matched window alone. Printed nothing. */
  enter: {
    args: ['kitten', '@', '--to', 'unix:/tmp/kitty', 'send-text', '--match', 'id:1', '--', '\\r'],
    code: 0,
    landed: { 1: '\r', 2: '' },
  },
  /** `kitty @` reaches the same `kitten @` (here `ls`, printing the same JSON). */
  kittyAt: { args: ['kitty', '@', '--to', 'unix:/tmp/kitty', 'ls'], code: 0 },
  /** `kitty +kitten @` is not a form 0.32.2 takes: stdout empty, stderr the list of kittens and this last line. */
  kittyPlusKitten: {
    args: ['kitty', '+kitten', '@', '--to', 'unix:/tmp/kitty', 'ls'],
    code: 1,
    stderrLastLine: 'No kitten named @\n',
  },
  /** A kitty that listens but refuses the request: `allow_remote_control=password` with
   *  `remote_control_password=pw focus-window`, the request sent with no password. Remote control fully off makes no
   *  socket (`envRemoteControlOff`), so this is the refusal a socket in `KITTY_LISTEN_ON` can answer. */
  remoteControlOff: {
    args: ['kitten', '@', '--to', 'unix:/tmp/kitty-pw', 'focus-window', '--match', 'id:1'],
    code: 1,
    stderr: 'Error: Remote control is disabled. Add allow_remote_control to your kitty.conf\n',
  },
  /** No socket at that path. A socket whose kitty had quit answered the same: kitty removes its socket on exit. */
  noSocket: {
    args: ['kitten', '@', '--to', 'unix:/tmp/nothing', 'ls'],
    code: 1,
    stderr: 'Error: dial unix /tmp/nothing: connect: no such file or directory\n',
  },
  /** `pid:` names window 1's own process, kitty's child: tab 1 became active, with window 1 its active window. It
   *  printed nothing. */
  focusWindowPid: {
    args: ['kitten', '@', '--to', 'unix:/tmp/kitty', 'focus-window', '--match', 'pid:1430'],
    code: 0,
    windowActive: true,
    tabActive: true,
  },
  /** A process two levels below window 1's own (`sleep` 1432) matches no window, although `ls` lists it among the
   *  window's `foreground_processes`: `pid:` matches the window's own process alone. The one level below (`sh` 1431)
   *  answered the same. Tab 2 stayed active; window 1 stayed what it was before, its own tab's active window. */
  focusWindowPidDescendant: {
    args: ['kitten', '@', '--to', 'unix:/tmp/kitty', 'focus-window', '--match', 'pid:1432'],
    code: 1,
    stderr: 'Error: No matching windows for expression: pid:1432\n',
    tabActive: false,
  },
  /** A pid no window holds. Tab 2 stayed active. */
  focusWindowPidMissing: {
    args: ['kitten', '@', '--to', 'unix:/tmp/kitty', 'focus-window', '--match', 'pid:99999'],
    code: 1,
    stderr: 'Error: No matching windows for expression: pid:99999\n',
  },
  missingWindow: {
    args: ['kitten', '@', '--to', 'unix:/tmp/kitty', 'focus-window', '--match', 'id:99'],
    code: 1,
    stderr: 'Error: No matching windows for expression: id:99\n',
  },
  /** Which window is kitty's focused one (header, "The focused window by `get-colors --match`"). `focused`,
   *  `notFocused`, `orFocused` and `orNone` were asked after `focus-window --match id:1`, window 2 in tab 2 and window 3
   *  in the second OS window. A match prints kitty's colour table (277 lines, the same for each) and nothing on
   *  stderr. */
  focusedMatch: {
    focused: {
      args: ['kitten', '@', '--to', 'unix:/tmp/kitty', 'get-colors', '--match', 'id:1 and state:focused'],
      code: 0,
      stderr: '',
      stdoutFirstLine: 'active_border_color     #00ff00',
    },
    notFocused: {
      args: ['kitten', '@', '--to', 'unix:/tmp/kitty', 'get-colors', '--match', 'id:2 and state:focused'],
      code: 1,
      stderr: 'Error: No matching windows for expression: id:2 and state:focused\n',
    },
    /** kitty 0.32.2 takes parentheses in `--match`. */
    orFocused: {
      args: ['kitten', '@', '--to', 'unix:/tmp/kitty', 'get-colors', '--match', 'state:focused and (id:2 or id:1)'],
      code: 0,
      stderr: '',
    },
    orNone: {
      args: ['kitten', '@', '--to', 'unix:/tmp/kitty', 'get-colors', '--match', 'state:focused and (id:2 or id:3)'],
      code: 1,
      stderr: 'Error: No matching windows for expression: state:focused and (id:2 or id:3)\n',
    },
    /** `state:focused` matched the new window and no longer the one before after `launch --type=tab` (2, not 1),
     *  `launch --type=os-window` (3, not 2) and `focus-window --match id:1` (1, not 2 or 3). */
    followed: { focusWindow: true, newTab: true, newOsWindow: true },
    /** With window 2 focused in tab 2, `id:1 and state:active` matched (exit 0) as `id:2 and state:active` did:
     *  `state:active` is each tab's active window, so it cannot say which one has the focus. */
    activeOfEveryTab: true,
    /** Two kitty processes: `id:1 and state:focused` matched in both (exit 0), whichever had the X focus, before and
     *  after `xdotool windowactivate` moved it; `id:1 and state:focused_os_window`, alone or with `state:focused`,
     *  matched in neither (exit 1, `No matching windows`). */
    twoKittys: { bothFocused: true, focusedOsWindow: false },
    /** `allow_remote_control=password` with no `remote_control_password`, the request sent with no password: refused
     *  at once, with the stderr of `remoteControlOff`: no prompt waited for the person. */
    password: {
      args: ['kitten', '@', '--to', 'unix:/tmp/kitty-pw', 'get-colors', '--match', 'id:1 and state:focused'],
      code: 1,
      stderr: 'Error: Remote control is disabled. Add allow_remote_control to your kitty.conf\n',
      ms: 29,
      askedThePerson: false,
    },
    /** The same with `-o 'remote_control_password=pw get-colors'`: refused at once, the same way. */
    passwordSet: {
      args: ['kitten', '@', '--to', 'unix:/tmp/kitty-pw', 'get-colors', '--match', 'id:1 and state:focused'],
      code: 1,
      stderr: 'Error: Remote control is disabled. Add allow_remote_control to your kitty.conf\n',
      ms: 24,
      askedThePerson: false,
    },
    /** The mean of 20 `focused` calls one after another, in ms. */
    callMs: 11.5,
  },
} as const
