/**
 * KWin's scripting over D-Bus as it ran on Ubuntu 26.04 (Plasma 6) and Ubuntu 24.04 (Plasma 5), for the KDE raise's
 * specs (docs/plans/2026-11-19-dial-linux-plan.md, Task 5; spec § 2). The top level is Plasma 6; `plasma5` has the same
 * shape. Recorded 2026-11-19 in disposable `arm64v8/ubuntu:26.04` (26.04.1) and `arm64v8/ubuntu:24.04` (24.04.5)
 * containers (arm64, Podman on macOS), from the archive with `--no-install-recommends`: Plasma 6 `kwin-wayland`
 * 4:6.6.7-0ubuntu0.1, `foot` 1.25.0-1, `dbus` 1.16.2-2ubuntu4; Plasma 5 `kwin-wayland` 4:5.27.11-0ubuntu3, `foot`
 * 1.16.2-2ubuntu0.1, `dbus` 1.14.10-4ubuntu4.1; plus `fonts-dejavu-core` and `procps`. No account.
 *
 * How it was made: user `u` (uid 1000) on host `box`, `XDG_RUNTIME_DIR=/run/user/1000`, a session `dbus-daemon` on
 * `$XDG_RUNTIME_DIR/bus` (the address the spec finds), `kwin_wayland --virtual --no-lockscreen --socket wayland-0`
 * headless with `QT_LOGGING_RULES=kwin_scripting=true;js=true` (a script's `print` lands in KWin's stderr as `js: …`),
 * then `foot -T agent` and, last so it was the active one, `foot -T other`. The container ran with `--cap-add
 * SYS_NICE`; Plasma 5's binary carries `cap_sys_resource=ep`, which the container may not grant, so its exec failed
 * (`Operation not permitted`) until `setcap -r` took the capability off. Each raise wrote `raiseScript` (the agent's
 * foot pid filled in) to `$XDG_RUNTIME_DIR/harness/raise-1.js` (folder 0700, file 0600), then load, run and unload as
 * below; every call is its exact argv and stdout, each exited 0. The `method return` line's time and serials are as
 * they came. A probe script printed every window's `pid`, `resourceClass`, `resourceName`, `caption` and whether it
 * was the active one, before and after.
 */
export const RECORDED_KWIN = {
  source: 'recorded',
  version: '6.6.7',
  /** Whether KWin is on the session bus. */
  nameHasOwner: {
    args: [
      'dbus-send',
      '--bus=unix:path=/run/user/1000/bus',
      '--print-reply',
      '--dest=org.freedesktop.DBus',
      '/org/freedesktop/DBus',
      'org.freedesktop.DBus.NameHasOwner',
      'string:org.kde.KWin',
    ],
    stdout:
      'method return time=1795100540.893097 sender=org.freedesktop.DBus -> destination=:1.1 serial=3 reply_serial=2\n' +
      '   boolean true\n',
  },
  /** The same once KWin had exited. */
  nameHasNoOwner: {
    stdout:
      'method return time=1795100547.466240 sender=org.freedesktop.DBus -> destination=:1.26 serial=3 reply_serial=2\n' +
      '   boolean false\n',
  },
  /** The `int32` is the script's id; the script's object is `/Scripting/Script<id>`. An id is reused once its script
   *  is unloaded (every load here answered 0). A path with no file there loads too and answers an id as well. */
  loadScript: {
    args: [
      'dbus-send',
      '--bus=unix:path=/run/user/1000/bus',
      '--print-reply',
      '--dest=org.kde.KWin',
      '/Scripting',
      'org.kde.kwin.Scripting.loadScript',
      'string:/run/user/1000/harness/raise-1.js',
      'string:harness-raise-1',
    ],
    stdout:
      'method return time=1795100542.923053 sender=:1.0 -> destination=:1.10 serial=81 reply_serial=2\n' +
      '   int32 0\n',
  },
  run: {
    args: [
      'dbus-send',
      '--bus=unix:path=/run/user/1000/bus',
      '--print-reply',
      '--dest=org.kde.KWin',
      '/Scripting/Script0',
      'org.kde.kwin.Script.run',
    ],
    stdout: 'method return time=1795100542.934921 sender=:1.0 -> destination=:1.14 serial=86 reply_serial=2\n',
  },
  unloadScript: {
    args: [
      'dbus-send',
      '--bus=unix:path=/run/user/1000/bus',
      '--print-reply',
      '--dest=org.kde.KWin',
      '/Scripting',
      'org.kde.kwin.Scripting.unloadScript',
      'string:harness-raise-1',
    ],
    stdout:
      'method return time=1795100544.940436 sender=:1.0 -> destination=:1.16 serial=89 reply_serial=2\n' +
      '   boolean true\n',
  },
  /** `unloadScript` of a name no script was loaded under exits 0 too. */
  unloadNotLoaded: {
    stdout:
      'method return time=1795100546.954339 sender=:1.0 -> destination=:1.24 serial=97 reply_serial=2\n' +
      '   boolean false\n',
  },
  /** `loadScript`'s argv with no KWin on the bus (its exec had failed): nothing on stdout. */
  noKwin: {
    code: 1,
    stderr:
      'Error org.freedesktop.DBus.Error.ServiceUnknown: The name org.kde.KWin was not provided by any .service files\n',
  },
  /** What the script reads: `workspace.<list>()`, `workspace.<active>` (assigned to activate), a window's `<pid>`
   *  (a number) and `<class>` (a string, `foot` here, as is `resourceName`). */
  scriptApi: { list: 'windowList', active: 'activeWindow', pid: 'pid', class: 'resourceClass' },
  /** The text loaded as `raise-1.js`, 3123 being the agent's foot. The same text ran on Plasma 5 (with its pid). */
  raiseScript:
    'var pids = [3123];\n' +
    'var classes = ["foot"];\n' +
    'var hasWindows = typeof workspace.windowList === "function";\n' +
    'var list = hasWindows ? workspace.windowList() : workspace.clientList();\n' +
    'var hit = null;\n' +
    'for (var p = 0; p < pids.length && !hit; p++) for (var i = 0; i < list.length; i++) if (list[i].pid === pids[p]) { hit = list[i]; break; }\n' +
    'for (var c = 0; c < classes.length && !hit; c++) for (var j = 0; j < list.length; j++) if (String(list[j].resourceClass).toLowerCase() === classes[c].toLowerCase()) { hit = list[j]; break; }\n' +
    'if (hit) { if (hasWindows) workspace.activeWindow = hit; else workspace.activeClient = hit; }\n',
  /** The probe's lines: `probe api` is typeof windowList, clientList, activeWindow, activeClient; `probe win` is pid,
   *  typeof pid, resourceClass, typeof resourceClass, resourceName, caption, active. */
  probe: {
    before: [
      'js: probe api function undefined object undefined',
      'js: probe win 3123 number foot string foot agent false',
      'js: probe win 3134 number foot string foot other true',
    ],
    after: [
      'js: probe api function undefined object undefined',
      'js: probe win 3123 number foot string foot agent true',
      'js: probe win 3134 number foot string foot other false',
    ],
  },
  activated: true,
  /** Plasma 5: the same calls, but a script's object is `/<id>`, not `/Scripting/Script<id>`, and the script API
   *  names `clientList` and `activeClient`. */
  plasma5: {
    source: 'recorded',
    version: '5.27.11',
    nameHasOwner: {
      args: [
        'dbus-send',
        '--bus=unix:path=/run/user/1000/bus',
        '--print-reply',
        '--dest=org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus.NameHasOwner',
        'string:org.kde.KWin',
      ],
      stdout:
        'method return time=1795100756.139031 sender=org.freedesktop.DBus -> destination=:1.1 serial=3 reply_serial=2\n' +
        '   boolean true\n',
    },
    nameHasNoOwner: {
      stdout:
        'method return time=1795100762.786147 sender=org.freedesktop.DBus -> destination=:1.26 serial=3 reply_serial=2\n' +
        '   boolean false\n',
    },
    loadScript: {
      args: [
        'dbus-send',
        '--bus=unix:path=/run/user/1000/bus',
        '--print-reply',
        '--dest=org.kde.KWin',
        '/Scripting',
        'org.kde.kwin.Scripting.loadScript',
        'string:/run/user/1000/harness/raise-1.js',
        'string:harness-raise-1',
      ],
      stdout:
        'method return time=1795100758.191817 sender=:1.0 -> destination=:1.10 serial=93 reply_serial=2\n' +
        '   int32 0\n',
    },
    run: {
      args: [
        'dbus-send',
        '--bus=unix:path=/run/user/1000/bus',
        '--print-reply',
        '--dest=org.kde.KWin',
        '/0',
        'org.kde.kwin.Script.run',
      ],
      stdout: 'method return time=1795100758.209833 sender=:1.0 -> destination=:1.15 serial=101 reply_serial=2\n',
    },
    unloadScript: {
      args: [
        'dbus-send',
        '--bus=unix:path=/run/user/1000/bus',
        '--print-reply',
        '--dest=org.kde.KWin',
        '/Scripting',
        'org.kde.kwin.Scripting.unloadScript',
        'string:harness-raise-1',
      ],
      stdout:
        'method return time=1795100760.217766 sender=:1.0 -> destination=:1.16 serial=103 reply_serial=2\n' +
        '   boolean true\n',
    },
    unloadNotLoaded: {
      stdout:
        'method return time=1795100762.257608 sender=:1.0 -> destination=:1.24 serial=111 reply_serial=2\n' +
        '   boolean false\n',
    },
    noKwin: {
      code: 1,
      stderr:
        'Error org.freedesktop.DBus.Error.ServiceUnknown: The name org.kde.KWin was not provided by any .service files\n',
    },
    scriptApi: { list: 'clientList', active: 'activeClient', pid: 'pid', class: 'resourceClass' },
    probe: {
      before: [
        'js: probe api undefined function undefined object',
        'js: probe win 4102 number foot string foot agent false',
        'js: probe win 4114 number foot string foot other true',
      ],
      after: [
        'js: probe api undefined function undefined object',
        'js: probe win 4102 number foot string foot agent true',
        'js: probe win 4114 number foot string foot other false',
      ],
    },
    activated: true,
  },
} as const
