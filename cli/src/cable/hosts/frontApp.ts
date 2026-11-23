// Which app is in front, from the name the OS gives it: a bundle id on macOS, an exe name on Linux and Windows. The list
// is closed (a new row is a new decision), and the raw name stops here: only the app id goes on.

import { BUNDLE_APPS } from './hostDetect.js'

/** No listed app is in front (Safari, Finder, an unknown terminal). Not an app id: it never has agents. */
export const FRONT_NONE = 'none'

// Bundle ids known in front only, outside BUNDLE_APPS so that detecting and opening an app stay as they are.
const FRONT_BUNDLES: Readonly<Record<string, string>> = {
  // Alacritty's Info.plist (alacritty's extra/osx/Alacritty.app): an agent there has no host of its own, so the unknown
  // app, as WindowsTerminal below.
  'org.alacritty': 'terminal',
  // Warp Preview's bundle id (Homebrew cask warp@preview).
  'dev.warp.Warp-Preview': 'warp',
}

// Exe names, lower-cased with `.exe` dropped. The Windows rows wait for its source; WindowsTerminal is the one row that
// gives the unknown app, since an agent there has no host of its own.
const EXE_APPS: Readonly<Record<string, string>> = {
  code: 'vscode',
  cursor: 'cursor',
  windowsterminal: 'terminal',
  // The Codex app: ChatGPT on Linux (cli/src/testing/recordedLinuxApps.ts, comm) and the Store's ChatGPT on Windows,
  // package OpenAI.Codex, whose window is ChatGPT.exe's.
  chatgpt: 'codex',
  // WezTerm's CFBundleExecutable.
  'wezterm-gui': 'wezterm',
  // WezTerm's mux server, the parent of a mux-domain pane's shell on Linux, where its comm names no app: whole, and as
  // the kernel cuts it to 15 bytes (cli/src/testing/recordedWezterm.ts, muxServerComm).
  'wezterm-mux-server': 'wezterm',
  'wezterm-mux-ser': 'wezterm',
  kitty: 'kitty',
  ghostty: 'ghostty',
  // Alacritty: alacritty.exe on Windows (alacritty's windows/wix/alacritty.wxs), alacritty on Linux (its
  // Alacritty.desktop Exec). The unknown app, as WindowsTerminal.
  alacritty: 'terminal',
  // Warp: warp.exe on Windows (Scoop Extras warp-terminal.json), and on Linux /opt/warpdotdev/warp-terminal/warp, which
  // /usr/bin/warp-terminal links to (Warp's rpm filelists).
  warp: 'warp',
  // Harness Desktop's Linux binary (desktop/linux/CMakeLists.txt, BINARY_NAME).
  harness: 'harness',
}

// The apps' Linux processes, lower-cased: never with `.exe`, since each name is Linux's alone.
const LINUX_APPS: Readonly<Record<string, string>> = {
  // The Claude app (cli/src/testing/recordedLinuxApps.ts, comm).
  'claude-desktop': 'claude',
  // Orca's main process, the .deb's /opt/Orca/orca-ide and the AppImage's alike (cli/src/testing/recordedOrca.ts,
  // `executableName: 'orca-ide'`). A bare `orca` is GNOME's screen reader, so it has no row.
  'orca-ide': 'orca',
  // Warp Preview's /opt/warpdotdev/warp-terminal-preview/warp-preview (Warp's rpm filelists); its Windows name is
  // unconfirmed.
  'warp-preview': 'warp',
}

// The apps' Windows processes, each the owner of its app's window (docs/plans/2026-11-19-dial-windows-vm-notes.md),
// lower-cased: only with `.exe`, since the bare name is no app's, or another program's, elsewhere.
const WINDOWS_APPS: Readonly<Record<string, string>> = {
  // The Claude app (Task 37 §1): a bare `claude` is no app's window name elsewhere.
  'claude.exe': 'claude',
  // Orca ("### 1. Window owners"): a bare `orca` on Linux is GNOME's screen reader.
  'orca.exe': 'orca',
}

/** The app id of the app in front, or FRONT_NONE. A bundle id matches whole, as detectApp reads it. */
export function frontAppId(value: string): string {
  if (Object.hasOwn(BUNDLE_APPS, value)) return BUNDLE_APPS[value]
  if (Object.hasOwn(FRONT_BUNDLES, value)) return FRONT_BUNDLES[value]
  const name = value.toLowerCase()
  const exe = name.replace(/\.exe$/, '')
  if (Object.hasOwn(EXE_APPS, exe)) return EXE_APPS[exe]
  if (Object.hasOwn(WINDOWS_APPS, name)) return WINDOWS_APPS[name]
  return exe === name && Object.hasOwn(LINUX_APPS, name) ? LINUX_APPS[name] : FRONT_NONE
}

// The spellings each app's window is known by on Linux: X11's WM_CLASS class and Wayland's app id, which some desktops
// lower-case. A class nobody could confirm has no row.
const WINDOW_CLASSES: Readonly<Record<string, readonly string[]>> = {
  // cli/src/testing/recordedLinuxApps.ts, StartupWMClass.
  vscode: ['com.microsoft.VSCode', 'com.microsoft.vscode'],
  cursor: ['Cursor', 'cursor'],
  claude: ['com.anthropic.Claude', 'com.anthropic.claude'],
  // The ChatGPT app's .desktop has no StartupWMClass: read from its code (recordedLinuxApps.ts, windowClasses).
  codex: ['ChatGPT', 'chatgpt'],
  // WezTerm's default class (its config option `class`).
  wezterm: ['org.wezfurlong.wezterm'],
  // kitty's default class (its `--class` option).
  kitty: ['kitty'],
  // Ghostty's GTK application id.
  ghostty: ['com.mitchellh.ghostty'],
  // desktop/linux/CMakeLists.txt: APPLICATION_ID, and BINARY_NAME as the X11 instance.
  harness: ['com.autonomous.harness', 'harness'],
}

/** The spellings an app's window is known by, for a raise by class; none for an app with no row. */
export function windowClasses(app: string): readonly string[] {
  return Object.hasOwn(WINDOW_CLASSES, app) ? WINDOW_CLASSES[app] : []
}
