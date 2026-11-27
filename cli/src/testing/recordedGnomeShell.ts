/**
 * GNOME Shell 50.1 with the Activate Window By Title extension, as it ran on Ubuntu 26.04, for the GNOME raise's specs
 * (docs/plans/2026-11-19-dial-linux-plan.md, Task 6; spec § 2.3). Recorded 2026-11-19 in a disposable
 * `arm64v8/ubuntu:26.04` container (Ubuntu 26.04.1, arm64, Podman on macOS), with gnome-shell 50.1-0ubuntu1.5 (mutter
 * 50.1), xwayland 24.1.10, foot 1.25.0, xterm 407, dbus 1.16.2 and libglib2.0-bin 2.88.0 (`gdbus`) from the archive,
 * and the extension from its own repository at tag v15 (commit 1f7520843e9b): its `metadata.json` and `extension.js`
 * copied into `~/.local/share/gnome-shell/extensions/<uuid>/`. No account.
 *
 * How it was made: user `u` (uid 1000) on host `box`, `XDG_RUNTIME_DIR=/run/user/1000`. The container has no
 * systemd, so a system bus was started by hand (`dbus-daemon --system`) and `/run/systemd/seats` removed (GNOME Shell
 * then uses its logind stand-in instead of failing to reach logind). Under `dbus-run-session`, `gsettings` turned the
 * extension on (`enabled-extensions`), then `gnome-shell --headless --wayland --virtual-monitor 1280x800` ran with a
 * native Wayland `foot -T agent` and an XWayland `xterm -T other` (its `DISPLAY` the one the shell's log names, its
 * `XAUTHORITY` the shell's `$XDG_RUNTIME_DIR/.mutter-Xwaylandauth.*`). Which window had focus after each call was read
 * from a recording aid of our own (a second extension listing each window's `get_wm_class()`, client type and focus),
 * since GNOME Shell 50 answers `org.gnome.Shell.Eval` only in unsafe mode. Then `gnome-extensions disable` and the
 * same calls again. Each value is the exact argv, exit code and output; two runs gave the same.
 */
export const RECORDED_GNOME_SHELL = {
  source: 'recorded',
  version: '50.1',
  extension: {
    uuid: 'activate-window-by-title@lucaswerkmeister.de',
    /** `version` in its `metadata.json`, as `gnome-extensions info` prints it; it declares shells 45 to 51. */
    version: 15,
    repository: 'https://github.com/lucaswerkmeister/activate-window-by-title',
  },
  /** Whether GNOME Shell is on the session bus. Where it is not, the same call printed `(false,)`. */
  shellOwned: {
    args: [
      'call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
      '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.gnome.Shell',
    ],
    stdout: '(true,)\n',
  },
  /** `gdbus introspect` of the extension's object with the extension on: its own interface is the last one. */
  introspect: {
    args: [
      'introspect', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/de/lucaswerkmeister/ActivateWindowByTitle',
    ],
    code: 0,
    stdout:
      'node /de/lucaswerkmeister/ActivateWindowByTitle {\n' +
      '  interface org.freedesktop.DBus.Properties {\n' +
      '    methods:\n' +
      '      Get(in  s interface_name,\n' +
      '          in  s property_name,\n' +
      '          out v value);\n' +
      '      GetAll(in  s interface_name,\n' +
      '             out a{sv} properties);\n' +
      '      Set(in  s interface_name,\n' +
      '          in  s property_name,\n' +
      '          in  v value);\n' +
      '    signals:\n' +
      '      PropertiesChanged(s interface_name,\n' +
      '                        a{sv} changed_properties,\n' +
      '                        as invalidated_properties);\n' +
      '    properties:\n' +
      '  };\n' +
      '  interface org.freedesktop.DBus.Introspectable {\n' +
      '    methods:\n' +
      '      Introspect(out s xml_data);\n' +
      '    signals:\n' +
      '    properties:\n' +
      '  };\n' +
      '  interface org.freedesktop.DBus.Peer {\n' +
      '    methods:\n' +
      '      Ping();\n' +
      '      GetMachineId(out s machine_uuid);\n' +
      '    signals:\n' +
      '    properties:\n' +
      '  };\n' +
      '  interface de.lucaswerkmeister.ActivateWindowByTitle {\n' +
      '    methods:\n' +
      '      activateByTitle(in  s fullTitle,\n' +
      '                      out b found);\n' +
      '      activateByPrefix(in  s prefix,\n' +
      '                       out b found);\n' +
      '      activateBySuffix(in  s suffix,\n' +
      '                       out b found);\n' +
      '      activateBySubstring(in  s substring,\n' +
      '                          out b found);\n' +
      '      activateByWmClass(in  s name,\n' +
      '                        out b found);\n' +
      '      activateByWmClassInstance(in  s instance,\n' +
      '                                out b found);\n' +
      '      activateById(in  t id,\n' +
      '                   out b found);\n' +
      '      setSortOrder(in  s newSortOrder,\n' +
      '                   out s oldSortOrder);\n' +
      '      setCurrentDesktopFirst(in  b newCurrentDesktopFirst,\n' +
      '                             out b oldCurrentDesktopFirst);\n' +
      '    signals:\n' +
      '    properties:\n' +
      '  };\n' +
      '};\n',
  },
  /** The same with the extension off: GDBus answers an introspection of any path, so this exits 0 with an empty node;
   *  only the missing interface tells the extension is off. */
  introspectWithout: {
    args: [
      'introspect', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/de/lucaswerkmeister/ActivateWindowByTitle',
    ],
    code: 0,
    stdout: 'node /de/lucaswerkmeister/ActivateWindowByTitle {\n};\n',
    stderr: '',
  },
  /** `activateByWmClass` of the unfocused foot window: it took the focus. */
  activateHit: {
    args: [
      'call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/de/lucaswerkmeister/ActivateWindowByTitle',
      '--method', 'de.lucaswerkmeister.ActivateWindowByTitle.activateByWmClass', 'foot',
    ],
    stdout: '(true,)\n',
  },
  /** A class no window has: exit 0, nothing activated. */
  activateMiss: {
    args: [
      'call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/de/lucaswerkmeister/ActivateWindowByTitle',
      '--method', 'de.lucaswerkmeister.ActivateWindowByTitle.activateByWmClass', 'nope',
    ],
    stdout: '(false,)\n',
  },
  /** The call itself with the extension off: the one that fails. */
  activateWithout: {
    args: [
      'call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/de/lucaswerkmeister/ActivateWindowByTitle',
      '--method', 'de.lucaswerkmeister.ActivateWindowByTitle.activateByWmClass', 'foot',
    ],
    code: 1,
    stderr:
      'Error: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: Object does not exist at path ' +
      '“/de/lucaswerkmeister/ActivateWindowByTitle”\n',
  },
  /** What `activateByWmClass` compares (`get_wm_class()`): a native window's Wayland app id, and an XWayland window's
   *  WM_CLASS class part. The xterm's instance part `xterm` answered `(false,)`; `XTerm` answered `(true,)` and took
   *  the focus. */
  wmClassOf: { wayland: 'foot', xwayland: 'XTerm' },
} as const;
