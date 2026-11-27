/**
 * Hyprland 0.53.3 and its `hyprctl`, as they ran on Ubuntu 26.04 and as their source answers, for the Hyprland raise's
 * specs (docs/plans/2026-11-19-dial-linux-plan.md, Task 4, Task 28 and Task 32; spec § 2.3). Made 2026-11-19 in a
 * disposable `arm64v8/ubuntu:26.04` container (Ubuntu 26.04.1, arm64, Podman on macOS, hostname `box`), with
 * `hyprland` 0.53.3+ds-4 (libaquamarine9 0.10.0, Mesa 26.0.8) and `foot` 1.25.0 from the archive, installed with
 * `--no-install-recommends`. No account.
 *
 * Hyprland did not start headless: as user `u` (uid 1000) with `XDG_RUNTIME_DIR=/run/user/1000`, `Hyprland` made
 * `hypr/<signature>/` and its `hyprland.log`, then aborted with `CBackend::create() failed!`; its crash report said
 * `drm: No gpus in scanGPUs` and `Cannot open backend: no allocator available`. Nested in headless sway (1.11,
 * `WLR_RENDERER=pixman`) it failed the same way (`Wayland backend cannot start: Missing protocols`). Aquamarine
 * allocates every buffer through GBM on a DRM device, and the container, like a GitHub runner, has none
 * (`/dev/dri` absent); Hyprland's own CI runs its tests in a QEMU VM with a virtio-gpu and 8 GB
 * (`nix/tests/default.nix`). So Hyprland does not start cheaply on a runner: no e2e (spec § Verification).
 *
 * What was still run: the archive's `hyprctl` binary, as user `u`, each argv below. `noSocket` and
 * `signatureWithoutUnderscore` are as it printed them with no Hyprland. For the rest, a stand-in listened on
 * `$XDG_RUNTIME_DIR/hypr/<signature>/.socket.sock` (folder 0700, as Hyprland makes it) and answered what Hyprland's
 * source answers for the request it got; so the argv, the exit code, the socket path, the request on the wire
 * (`j/clients`, `/dispatch focuswindow pid:4101`, …) and how `hyprctl` prints a reply are recorded, and the reply's
 * text is published. The two windows are `foot -T agent` and `foot -T other` on workspace 1; their pids, addresses
 * and geometry are made up, in the form Hyprland prints them (an address is the window's pointer, `0x` and lower-case
 * hex). Each published value names its source at the v0.53.3 tag, the same text as Ubuntu's source package.
 */
const SOURCE = 'https://github.com/hyprwm/Hyprland/blob/v0.53.3'

/** The signature Hyprland made on its start here: `<commit>_<unix time>_<random>` (`CCompositor::CCompositor`,
 *  `src/Compositor.cpp`); the commit is `unknown` in a build without git. Always two `_`. */
const SIGNATURE = 'dd220efe7b1e292415bd0ea7161f63df9c95bfd3_1795101025_1726482416'

export const RECORDED_HYPRLAND = {
  source: 'published',
  version: '0.53.3',
  startsHeadless: false,
  urls: {
    hyprctl: `${SOURCE}/hyprctl/src/main.cpp`,
    requests: `${SOURCE}/src/debug/HyprCtl.cpp`,
    focusWindow: `${SOURCE}/src/managers/KeybindManager.cpp`,
    windowByRegex: `${SOURCE}/src/Compositor.cpp`,
    eventSocket: `${SOURCE}/src/managers/EventManager.cpp`,
  },
  signature: { source: 'recorded', value: SIGNATURE },
  /** What is under `$XDG_RUNTIME_DIR/hypr/<signature>/` while Hyprland runs: the request socket (`HyprCtl.cpp`), the
   *  event socket (`EventManager.cpp`), the lock (`<pid>\n<wayland socket name>\n`, `Compositor.cpp`) and the log.
   *  `hypr/` and the folder are made 0700. Here only `hyprland.log` was made before the backend failed. */
  runtimeLayout: ['.socket.sock', '.socket2.sock', 'hyprland.lock', 'hyprland.log'],
  /** `hyprctl clients -j`: one object per mapped window, in the order they were made, pretty-printed, with no space
   *  between objects; `[]` with none (`clientsRequest`, `CHyprCtl::getWindowData`). `hyprctl` adds a `\n`. Sent on
   *  the wire as `j/clients`. */
  clients: {
    args: ['hyprctl', '-i', SIGNATURE, 'clients', '-j'],
    code: 0,
    stdout:
      '[{\n' +
      '    "address": "0xaaab1c8a2f50",\n' +
      '    "mapped": true,\n' +
      '    "hidden": false,\n' +
      '    "at": [22, 22],\n' +
      '    "size": [933, 1036],\n' +
      '    "workspace": {\n' +
      '        "id": 1,\n' +
      '        "name": "1"\n' +
      '    },\n' +
      '    "floating": false,\n' +
      '    "pseudo": false,\n' +
      '    "monitor": 0,\n' +
      '    "class": "foot",\n' +
      '    "title": "agent",\n' +
      '    "initialClass": "foot",\n' +
      '    "initialTitle": "agent",\n' +
      '    "pid": 4101,\n' +
      '    "xwayland": false,\n' +
      '    "pinned": false,\n' +
      '    "fullscreen": 0,\n' +
      '    "fullscreenClient": 0,\n' +
      '    "grouped": [],\n' +
      '    "tags": [],\n' +
      '    "swallowing": "0x0",\n' +
      '    "focusHistoryID": 1,\n' +
      '    "inhibitingIdle": false,\n' +
      '    "xdgTag": "",\n' +
      '    "xdgDescription": "",\n' +
      '    "contentType": "none"\n' +
      '},{\n' +
      '    "address": "0xaaab1c9d4e10",\n' +
      '    "mapped": true,\n' +
      '    "hidden": false,\n' +
      '    "at": [965, 22],\n' +
      '    "size": [933, 1036],\n' +
      '    "workspace": {\n' +
      '        "id": 1,\n' +
      '        "name": "1"\n' +
      '    },\n' +
      '    "floating": false,\n' +
      '    "pseudo": false,\n' +
      '    "monitor": 0,\n' +
      '    "class": "foot",\n' +
      '    "title": "other",\n' +
      '    "initialClass": "foot",\n' +
      '    "initialTitle": "other",\n' +
      '    "pid": 4127,\n' +
      '    "xwayland": false,\n' +
      '    "pinned": false,\n' +
      '    "fullscreen": 0,\n' +
      '    "fullscreenClient": 0,\n' +
      '    "grouped": [],\n' +
      '    "tags": [],\n' +
      '    "swallowing": "0x0",\n' +
      '    "focusHistoryID": 0,\n' +
      '    "inhibitingIdle": false,\n' +
      '    "xdgTag": "",\n' +
      '    "xdgDescription": "",\n' +
      '    "contentType": "none"\n' +
      '}]\n',
  },
  /** The windows' own pids in `clients`. */
  pids: { agent: 4101, other: 4127 },
  /** `pid:<p>` matches a mapped window whose pid prints as exactly `<p>`, the first in `clients`' order
   *  (`CCompositor::getWindowByRegex`). A dispatch that worked answers `ok` (`dispatchRequest`). */
  focusByPid: {
    args: ['hyprctl', '-i', SIGNATURE, 'dispatch', 'focuswindow', 'pid:4101'],
    code: 0,
    stdout: 'ok\n',
  },
  /** `address:<a>` matches the window whose `address` in `clients` is exactly `<a>`. (`class:<c>` would be an RE2
   *  full match of `<c>` against `class`, so a `.` in it matches any character.) */
  focusByAddress: {
    args: ['hyprctl', '-i', SIGNATURE, 'dispatch', 'focuswindow', 'address:0xaaab1c8a2f50'],
    code: 0,
    stdout: 'ok\n',
  },
  /** No window matches: the dispatcher's error as the reply (`CKeybindManager::focusWindow`), and `hyprctl` still
   *  exits 0, as it does for any reply. Only the reply says the window was not found. An address no window has
   *  answers the same. */
  focusNoMatch: {
    args: ['hyprctl', '-i', SIGNATURE, 'dispatch', 'focuswindow', 'pid:9999'],
    code: 0,
    stdout: 'No such window found\n',
  },
  /** No Hyprland: the folder is there, its socket is not. `hyprctl` prints its errors on stdout. */
  noSocket: {
    source: 'recorded',
    args: ['hyprctl', '-i', SIGNATURE, 'clients', '-j'],
    code: 4,
    stdout: `Couldn't connect to /run/user/1000/hypr/${SIGNATURE}/.socket.sock. (4)\n`,
    stderr: '',
  },
  /** `-i` takes a value with a `_` as a signature and any other as an instance's index (`hyprctl/src/main.cpp`). */
  signatureWithoutUnderscore: {
    source: 'recorded',
    args: ['hyprctl', '-i', 'abc', 'clients', '-j'],
    code: 1,
    stdout: 'instance invalid\n\n',
    stderr: '',
  },
} as const
