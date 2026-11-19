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
  // WezTerm's CFBundleExecutable.
  'wezterm-gui': 'wezterm',
  kitty: 'kitty',
  ghostty: 'ghostty',
  // Harness Desktop's Linux binary (desktop/linux/CMakeLists.txt, BINARY_NAME).
  harness: 'harness',
  // The Claude and ChatGPT apps' Linux processes (cli/src/testing/recordedLinuxApps.ts, comm).
  'claude-desktop': 'claude',
  chatgpt: 'codex',
}

/** The app id of the app in front, or FRONT_NONE. A bundle id matches whole, as detectApp reads it. */
export function frontAppId(value: string): string {
  if (Object.hasOwn(BUNDLE_APPS, value)) return BUNDLE_APPS[value]
  const exe = value.toLowerCase().replace(/\.exe$/, '')
  return Object.hasOwn(EXE_APPS, exe) ? EXE_APPS[exe] : FRONT_NONE
}
