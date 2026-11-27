/**
 * sway 1.9 as it ran on Ubuntu 24.04, for the desktop finder's and the sway raise's specs
 * (docs/plans/2026-11-19-dial-linux-plan.md, Tasks 3, 28 and 31; spec § 2.3). Recorded 2026-11-19 in a disposable
 * `arm64v8/ubuntu:24.04` container (Ubuntu 24.04.5, arm64, Podman on macOS), with sway 1.9-1build2 (`swaymsg` 1.9,
 * wlroots 0.17.1-2.1build1), foot 1.16.2-2ubuntu0.1, xwayland 2:23.2.6-1ubuntu0.8, xterm 390-1ubuntu3 and
 * fonts-dejavu-core from the archive (`--no-install-recommends`). No account.
 *
 * How it was made: user `u` (uid 1000) on host `box`, `XDG_RUNTIME_DIR=/run/user/1000` (0700, `u`'s), sway run as
 * `sway -c /work/sway.conf` (the file holds only `xwayland enable`) with `WLR_BACKENDS=headless`,
 * `WLR_RENDERER=pixman` and `WLR_LIBINPUT_NO_DEVICES=1`. A first sway was killed with SIGKILL, which left its socket
 * behind with nobody listening; then the live sway started beside it. Through the live socket, `exec foot -T agent`
 * (a native Wayland window) and `exec xterm -T other` (an XWayland one), each running a shell that wrote its
 * environment and then `cat`; the xterm was made floating, so the tree holds a window under `nodes` and one under
 * `floating_nodes`. Every command ran from outside sway with `-s <socket>`, as the daemon runs it; each value is its
 * exact argv, exit code and output, and which window had focus after it was read from `get_tree`. Two runs gave the
 * same pids, node ids and socket names.
 */
export const RECORDED_SWAY = {
  source: 'recorded',
  version: '1.9',
  /** The live sway's socket as it is named in `$XDG_RUNTIME_DIR`: `sway-ipc.<uid>.<sway's pid>.sock`. */
  socketName: 'sway-ipc.1000.2166.sock',
  /** What was in `$XDG_RUNTIME_DIR`, the killed sway's socket (`2149`) beside the live one's, as `stat` gave each:
   *  type and mode, owner name, owner uid, name. Both sways took `wayland-1` in turn: the killed one's lock was free. */
  runtimeLayout: [
    'srwxr-xr-x u 1000 sway-ipc.1000.2149.sock',
    'srwxr-xr-x u 1000 sway-ipc.1000.2166.sock',
    'srwxr-xr-x u 1000 wayland-1',
    '-rw-r----- u 1000 wayland-1.lock',
  ],
  /** The XWayland socket sway listened on for `DISPLAY=:0`: `/tmp/.X11-unix/X0`, `srwxr-xr-x u u`. */
  x11Socket: 'X0',
  /** As both windows' shells had them: sway sets `SWAYSOCK` and `I3SOCK` alike for what it starts. */
  childEnv: {
    SWAYSOCK: '/run/user/1000/sway-ipc.1000.2166.sock',
    I3SOCK: '/run/user/1000/sway-ipc.1000.2166.sock',
    WAYLAND_DISPLAY: 'wayland-1',
    DISPLAY: ':0',
    XDG_RUNTIME_DIR: '/run/user/1000',
  },
  /** Each window's client process, the `pid` its node carries: `foot` for `agent`, `xterm` for `other`. Each one's
   *  shell (`cat`, pids 2209 and 2234) is its child and owns no node; sway's `exec` leaves both with parent 1. */
  pids: { agent: 2205, other: 2227 },
  /** Each window's node `id`, what `[con_id=…]` takes. */
  conIds: { agent: 5, other: 6 },
  /** `swaymsg -s <socket> -t get_tree`, exit 0, after `float`, `other` focused. Only the two windows' nodes carry
   *  `pid`; `agent` is a `con` under the workspace's `nodes` (`app_id` `foot`, `window` null), `other` a
   *  `floating_con` under its `floating_nodes` (`app_id` null, `shell` `xwayland`, `window_properties.class`
   *  `XTerm`). */
  tree:
    '{\n' +
    '  "id": 1,\n' +
    '  "type": "root",\n' +
    '  "orientation": "horizontal",\n' +
    '  "percent": null,\n' +
    '  "urgent": false,\n' +
    '  "marks": [],\n' +
    '  "focused": false,\n' +
    '  "layout": "splith",\n' +
    '  "border": "none",\n' +
    '  "current_border_width": 0,\n' +
    '  "rect": {\n' +
    '    "x": 0,\n' +
    '    "y": 0,\n' +
    '    "width": 1280,\n' +
    '    "height": 720\n' +
    '  },\n' +
    '  "deco_rect": {\n' +
    '    "x": 0,\n' +
    '    "y": 0,\n' +
    '    "width": 0,\n' +
    '    "height": 0\n' +
    '  },\n' +
    '  "window_rect": {\n' +
    '    "x": 0,\n' +
    '    "y": 0,\n' +
    '    "width": 0,\n' +
    '    "height": 0\n' +
    '  },\n' +
    '  "geometry": {\n' +
    '    "x": 0,\n' +
    '    "y": 0,\n' +
    '    "width": 0,\n' +
    '    "height": 0\n' +
    '  },\n' +
    '  "name": "root",\n' +
    '  "window": null,\n' +
    '  "nodes": [\n' +
    '    {\n' +
    '      "id": 2147483647,\n' +
    '      "type": "output",\n' +
    '      "orientation": "horizontal",\n' +
    '      "percent": null,\n' +
    '      "urgent": false,\n' +
    '      "marks": [],\n' +
    '      "focused": false,\n' +
    '      "layout": "output",\n' +
    '      "border": "none",\n' +
    '      "current_border_width": 0,\n' +
    '      "rect": {\n' +
    '        "x": 0,\n' +
    '        "y": 0,\n' +
    '        "width": 1280,\n' +
    '        "height": 720\n' +
    '      },\n' +
    '      "deco_rect": {\n' +
    '        "x": 0,\n' +
    '        "y": 0,\n' +
    '        "width": 0,\n' +
    '        "height": 0\n' +
    '      },\n' +
    '      "window_rect": {\n' +
    '        "x": 0,\n' +
    '        "y": 0,\n' +
    '        "width": 0,\n' +
    '        "height": 0\n' +
    '      },\n' +
    '      "geometry": {\n' +
    '        "x": 0,\n' +
    '        "y": 0,\n' +
    '        "width": 0,\n' +
    '        "height": 0\n' +
    '      },\n' +
    '      "name": "__i3",\n' +
    '      "window": null,\n' +
    '      "nodes": [\n' +
    '        {\n' +
    '          "id": 2147483646,\n' +
    '          "type": "workspace",\n' +
    '          "orientation": "horizontal",\n' +
    '          "percent": null,\n' +
    '          "urgent": false,\n' +
    '          "marks": [],\n' +
    '          "focused": false,\n' +
    '          "layout": "splith",\n' +
    '          "border": "none",\n' +
    '          "current_border_width": 0,\n' +
    '          "rect": {\n' +
    '            "x": 0,\n' +
    '            "y": 0,\n' +
    '            "width": 1280,\n' +
    '            "height": 720\n' +
    '          },\n' +
    '          "deco_rect": {\n' +
    '            "x": 0,\n' +
    '            "y": 0,\n' +
    '            "width": 0,\n' +
    '            "height": 0\n' +
    '          },\n' +
    '          "window_rect": {\n' +
    '            "x": 0,\n' +
    '            "y": 0,\n' +
    '            "width": 0,\n' +
    '            "height": 0\n' +
    '          },\n' +
    '          "geometry": {\n' +
    '            "x": 0,\n' +
    '            "y": 0,\n' +
    '            "width": 0,\n' +
    '            "height": 0\n' +
    '          },\n' +
    '          "name": "__i3_scratch",\n' +
    '          "window": null,\n' +
    '          "nodes": [],\n' +
    '          "floating_nodes": [],\n' +
    '          "focus": [],\n' +
    '          "fullscreen_mode": 1,\n' +
    '          "sticky": false\n' +
    '        }\n' +
    '      ],\n' +
    '      "floating_nodes": [],\n' +
    '      "focus": [\n' +
    '        2147483646\n' +
    '      ],\n' +
    '      "fullscreen_mode": 0,\n' +
    '      "sticky": false\n' +
    '    },\n' +
    '    {\n' +
    '      "id": 3,\n' +
    '      "type": "output",\n' +
    '      "orientation": "none",\n' +
    '      "percent": 1.0,\n' +
    '      "urgent": false,\n' +
    '      "marks": [],\n' +
    '      "focused": false,\n' +
    '      "layout": "output",\n' +
    '      "border": "none",\n' +
    '      "current_border_width": 0,\n' +
    '      "rect": {\n' +
    '        "x": 0,\n' +
    '        "y": 0,\n' +
    '        "width": 1280,\n' +
    '        "height": 720\n' +
    '      },\n' +
    '      "deco_rect": {\n' +
    '        "x": 0,\n' +
    '        "y": 0,\n' +
    '        "width": 0,\n' +
    '        "height": 0\n' +
    '      },\n' +
    '      "window_rect": {\n' +
    '        "x": 0,\n' +
    '        "y": 0,\n' +
    '        "width": 0,\n' +
    '        "height": 0\n' +
    '      },\n' +
    '      "geometry": {\n' +
    '        "x": 0,\n' +
    '        "y": 0,\n' +
    '        "width": 0,\n' +
    '        "height": 0\n' +
    '      },\n' +
    '      "name": "HEADLESS-1",\n' +
    '      "window": null,\n' +
    '      "nodes": [\n' +
    '        {\n' +
    '          "id": 4,\n' +
    '          "type": "workspace",\n' +
    '          "orientation": "horizontal",\n' +
    '          "percent": null,\n' +
    '          "urgent": false,\n' +
    '          "marks": [],\n' +
    '          "focused": false,\n' +
    '          "layout": "splith",\n' +
    '          "border": "none",\n' +
    '          "current_border_width": 0,\n' +
    '          "rect": {\n' +
    '            "x": 0,\n' +
    '            "y": 0,\n' +
    '            "width": 1280,\n' +
    '            "height": 720\n' +
    '          },\n' +
    '          "deco_rect": {\n' +
    '            "x": 0,\n' +
    '            "y": 0,\n' +
    '            "width": 0,\n' +
    '            "height": 0\n' +
    '          },\n' +
    '          "window_rect": {\n' +
    '            "x": 0,\n' +
    '            "y": 0,\n' +
    '            "width": 0,\n' +
    '            "height": 0\n' +
    '          },\n' +
    '          "geometry": {\n' +
    '            "x": 0,\n' +
    '            "y": 0,\n' +
    '            "width": 0,\n' +
    '            "height": 0\n' +
    '          },\n' +
    '          "name": "1",\n' +
    '          "window": null,\n' +
    '          "nodes": [\n' +
    '            {\n' +
    '              "id": 5,\n' +
    '              "type": "con",\n' +
    '              "orientation": "none",\n' +
    '              "percent": 1.0,\n' +
    '              "urgent": false,\n' +
    '              "marks": [],\n' +
    '              "focused": false,\n' +
    '              "layout": "none",\n' +
    '              "border": "normal",\n' +
    '              "current_border_width": 2,\n' +
    '              "rect": {\n' +
    '                "x": 0,\n' +
    '                "y": 25,\n' +
    '                "width": 1280,\n' +
    '                "height": 695\n' +
    '              },\n' +
    '              "deco_rect": {\n' +
    '                "x": 0,\n' +
    '                "y": 0,\n' +
    '                "width": 1280,\n' +
    '                "height": 25\n' +
    '              },\n' +
    '              "window_rect": {\n' +
    '                "x": 2,\n' +
    '                "y": 0,\n' +
    '                "width": 1276,\n' +
    '                "height": 693\n' +
    '              },\n' +
    '              "geometry": {\n' +
    '                "x": 0,\n' +
    '                "y": 0,\n' +
    '                "width": 700,\n' +
    '                "height": 500\n' +
    '              },\n' +
    '              "name": "agent",\n' +
    '              "window": null,\n' +
    '              "nodes": [],\n' +
    '              "floating_nodes": [],\n' +
    '              "focus": [],\n' +
    '              "fullscreen_mode": 0,\n' +
    '              "sticky": false,\n' +
    '              "pid": 2205,\n' +
    '              "app_id": "foot",\n' +
    '              "visible": true,\n' +
    '              "max_render_time": 0,\n' +
    '              "shell": "xdg_shell",\n' +
    '              "inhibit_idle": false,\n' +
    '              "idle_inhibitors": {\n' +
    '                "user": "none",\n' +
    '                "application": "none"\n' +
    '              }\n' +
    '            }\n' +
    '          ],\n' +
    '          "floating_nodes": [\n' +
    '            {\n' +
    '              "id": 6,\n' +
    '              "type": "floating_con",\n' +
    '              "orientation": "none",\n' +
    '              "percent": 0.18162326388888886,\n' +
    '              "urgent": false,\n' +
    '              "marks": [],\n' +
    '              "focused": true,\n' +
    '              "layout": "none",\n' +
    '              "border": "normal",\n' +
    '              "current_border_width": 2,\n' +
    '              "rect": {\n' +
    '                "x": 396,\n' +
    '                "y": 202,\n' +
    '                "width": 488,\n' +
    '                "height": 318\n' +
    '              },\n' +
    '              "deco_rect": {\n' +
    '                "x": 396,\n' +
    '                "y": 177,\n' +
    '                "width": 488,\n' +
    '                "height": 25\n' +
    '              },\n' +
    '              "window_rect": {\n' +
    '                "x": 2,\n' +
    '                "y": 0,\n' +
    '                "width": 484,\n' +
    '                "height": 316\n' +
    '              },\n' +
    '              "geometry": {\n' +
    '                "x": 0,\n' +
    '                "y": 0,\n' +
    '                "width": 484,\n' +
    '                "height": 316\n' +
    '              },\n' +
    '              "name": "other",\n' +
    '              "window": 4194316,\n' +
    '              "nodes": [],\n' +
    '              "floating_nodes": [],\n' +
    '              "focus": [],\n' +
    '              "fullscreen_mode": 0,\n' +
    '              "sticky": false,\n' +
    '              "pid": 2227,\n' +
    '              "app_id": null,\n' +
    '              "visible": true,\n' +
    '              "max_render_time": 0,\n' +
    '              "shell": "xwayland",\n' +
    '              "inhibit_idle": false,\n' +
    '              "idle_inhibitors": {\n' +
    '                "user": "none",\n' +
    '                "application": "none"\n' +
    '              },\n' +
    '              "window_properties": {\n' +
    '                "class": "XTerm",\n' +
    '                "instance": "xterm",\n' +
    '                "title": "other",\n' +
    '                "transient_for": null\n' +
    '              }\n' +
    '            }\n' +
    '          ],\n' +
    '          "focus": [\n' +
    '            6,\n' +
    '            5\n' +
    '          ],\n' +
    '          "fullscreen_mode": 1,\n' +
    '          "sticky": false,\n' +
    '          "num": 1,\n' +
    '          "output": "HEADLESS-1",\n' +
    '          "representation": "H[foot]"\n' +
    '        }\n' +
    '      ],\n' +
    '      "floating_nodes": [],\n' +
    '      "focus": [\n' +
    '        4\n' +
    '      ],\n' +
    '      "fullscreen_mode": 0,\n' +
    '      "sticky": false,\n' +
    '      "primary": false,\n' +
    '      "make": "Unknown",\n' +
    '      "model": "Unknown",\n' +
    '      "serial": "Unknown",\n' +
    '      "modes": [],\n' +
    '      "non_desktop": false,\n' +
    '      "active": true,\n' +
    '      "dpms": true,\n' +
    '      "power": true,\n' +
    '      "scale": 1.0,\n' +
    '      "scale_filter": "nearest",\n' +
    '      "transform": "normal",\n' +
    '      "adaptive_sync_status": "disabled",\n' +
    '      "current_workspace": "1",\n' +
    '      "current_mode": {\n' +
    '        "width": 1280,\n' +
    '        "height": 720,\n' +
    '        "refresh": 0\n' +
    '      },\n' +
    '      "max_render_time": 0\n' +
    '    }\n' +
    '  ],\n' +
    '  "floating_nodes": [],\n' +
    '  "focus": [\n' +
    '    3\n' +
    '  ],\n' +
    '  "fullscreen_mode": 0,\n' +
    '  "sticky": false\n' +
    '}\n',
  /** The live socket answers. Printed nothing on stderr. */
  getVersion: {
    args: ['swaymsg', '-s', '/run/user/1000/sway-ipc.1000.2166.sock', '-t', 'get_version'],
    code: 0,
    stdout:
      '{\n' +
      '  "human_readable": "1.9",\n' +
      '  "variant": "sway",\n' +
      '  "major": 1,\n' +
      '  "minor": 9,\n' +
      '  "patch": 0,\n' +
      '  "loaded_config_file_name": "\\/work\\/sway.conf"\n' +
      '}\n',
  },
  /** Recording aid: makes `other` floating before `tree`. */
  float: {
    args: ['swaymsg', '-s', '/run/user/1000/sway-ipc.1000.2166.sock', '[pid=2227] floating enable'],
    code: 0,
    stdout:
      '[\n' +
      '  {\n' +
      '    "success": true\n' +
      '  }\n' +
      ']\n',
  },
  /** `agent` had focus after it. */
  focusByPid: {
    args: ['swaymsg', '-s', '/run/user/1000/sway-ipc.1000.2166.sock', '[pid=2205] focus'],
    code: 0,
    stdout:
      '[\n' +
      '  {\n' +
      '    "success": true\n' +
      '  }\n' +
      ']\n',
  },
  /** `other` had focus after it. */
  focusByConId: {
    args: ['swaymsg', '-s', '/run/user/1000/sway-ipc.1000.2166.sock', '[con_id=6] focus'],
    code: 0,
    stdout:
      '[\n' +
      '  {\n' +
      '    "success": true\n' +
      '  }\n' +
      ']\n',
  },
  /** The spec's `[app_id=<class>]` form, for a native window: `agent` had focus after it. */
  focusByAppId: {
    args: ['swaymsg', '-s', '/run/user/1000/sway-ipc.1000.2166.sock', '[app_id=foot] focus'],
    code: 0,
    stdout:
      '[\n' +
      '  {\n' +
      '    "success": true\n' +
      '  }\n' +
      ']\n',
  },
  /** An XWayland window has no `app_id`; `[class=…]` matches its `window_properties.class`: `other` had focus
   *  after it. */
  focusByClass: {
    args: ['swaymsg', '-s', '/run/user/1000/sway-ipc.1000.2166.sock', '[class=XTerm] focus'],
    code: 0,
    stdout:
      '[\n' +
      '  {\n' +
      '    "success": true\n' +
      '  }\n' +
      ']\n',
  },
  /** No window of that pid: exit 2, focus unchanged (`other`). Printed nothing on stderr. */
  focusNoMatch: {
    args: ['swaymsg', '-s', '/run/user/1000/sway-ipc.1000.2166.sock', '[pid=99999] focus'],
    code: 2,
    stdout:
      '[\n' +
      '  {\n' +
      '    "success": false,\n' +
      '    "parse_error": false,\n' +
      '    "error": "No matching node."\n' +
      '  }\n' +
      ']\n',
  },
  /** A pid that is not a number is refused as a parse error, exit 2, focus unchanged. */
  focusBadCriteria: {
    args: ['swaymsg', '-s', '/run/user/1000/sway-ipc.1000.2166.sock', '[pid=abc] focus'],
    code: 2,
    stdout:
      '[\n' +
      '  {\n' +
      '    "success": false,\n' +
      '    "parse_error": true,\n' +
      '    "error": "The value for \'pid\' should be numeric"\n' +
      '  }\n' +
      ']\n',
  },
  /** The killed sway's socket, still in the runtime dir: stdout empty. The time stamp is the client's own clock
   *  from its start. */
  staleSocket: {
    args: ['swaymsg', '-s', '/run/user/1000/sway-ipc.1000.2149.sock', '-t', 'get_version'],
    code: 1,
    stderr: '00:00:00.000 [ERROR] [common/ipc-client.c:67] Unable to connect to /run/user/1000/sway-ipc.1000.2149.sock\n',
  },
  /** No file at that path answers the same as the stale socket. */
  missingSocket: {
    args: ['swaymsg', '-s', '/run/user/1000/sway-ipc.1000.4242.sock', '-t', 'get_version'],
    code: 1,
    stderr: '00:00:00.000 [ERROR] [common/ipc-client.c:67] Unable to connect to /run/user/1000/sway-ipc.1000.4242.sock\n',
  },
} as const
