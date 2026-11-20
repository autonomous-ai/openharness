// Which app is in front, from the name the OS gives it: a bundle id on macOS, an exe name on Linux and Windows. The list
// is closed (a new row is a new decision), and the raw name stops here: only the app id goes on.

import { BUNDLE_APPS } from './hostDetect.js'

/** No listed app is in front (Safari, Finder, an unknown terminal). Not an app id: it never has agents. */
export const FRONT_NONE = 'none'

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
  kitty: 'kitty',
  ghostty: 'ghostty',
  // Harness Desktop's Linux binary (desktop/linux/CMakeLists.txt, BINARY_NAME).
  harness: 'harness',
}

// The Claude app's Linux process (cli/src/testing/recordedLinuxApps.ts, comm), lower-cased: never with `.exe`, since
// the name is Linux's alone.
const LINUX_APPS: Readonly<Record<string, string>> = {
  'claude-desktop': 'claude',
}

// The Claude app's Windows process, the owner of its window (docs/plans/2026-11-19-dial-windows-vm-notes.md, Task 37
// §1), lower-cased: only with `.exe`, since a bare `claude` is no app's window name elsewhere.
const WINDOWS_APPS: Readonly<Record<string, string>> = {
  'claude.exe': 'claude',
}

/** The app id of the app in front, or FRONT_NONE. A bundle id matches whole, as detectApp reads it. */
export function frontAppId(value: string): string {
  if (Object.hasOwn(BUNDLE_APPS, value)) return BUNDLE_APPS[value]
  const name = value.toLowerCase()
  const exe = name.replace(/\.exe$/, '')
  if (Object.hasOwn(EXE_APPS, exe)) return EXE_APPS[exe]
  if (Object.hasOwn(WINDOWS_APPS, name)) return WINDOWS_APPS[name]
  return exe === name && Object.hasOwn(LINUX_APPS, name) ? LINUX_APPS[name] : FRONT_NONE
}

// The spellings each app's window is known by on Linux: X11's WM_CLASS class and Wayland's app id, which some desktops
// lower-case. A class nobody could confirm has no row (the ChatGPT app's .desktop has no StartupWMClass).
const WINDOW_CLASSES: Readonly<Record<string, readonly string[]>> = {
  // cli/src/testing/recordedLinuxApps.ts, StartupWMClass.
  vscode: ['com.microsoft.VSCode', 'com.microsoft.vscode'],
  cursor: ['Cursor', 'cursor'],
  claude: ['com.anthropic.Claude', 'com.anthropic.claude'],
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
