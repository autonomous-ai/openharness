import { describe, expect, it } from 'vitest'
import { FRONT_NONE, frontAppId, windowClasses } from './frontApp.js'
import { APP_IDS, detectApp } from './hostDetect.js'
import { RECORDED_LINUX_APPS } from '../../testing/recordedLinuxApps.js'
import { RECORDED_ORCA } from '../../testing/recordedOrca.js'
import { RECORDED_WEZTERM } from '../../testing/recordedWezterm.js'

const BUNDLES: [string, string][] = [
  ['com.stablyai.orca', 'orca'],
  ['dev.herdr.app', 'herdr'],
  ['net.kovidgoyal.kitty', 'kitty'],
  ['com.github.wez.wezterm', 'wezterm'],
  ['com.googlecode.iterm2', 'iterm'],
  ['com.apple.Terminal', 'terminal-app'],
  ['com.mitchellh.ghostty', 'ghostty'],
  ['com.cmuxterm.app', 'cmux'],
  ['com.microsoft.VSCode', 'vscode'],
  ['com.todesktop.230313mzl4w4u92', 'cursor'],
  ['dev.warp.Warp-Stable', 'warp'],
  ['com.anthropic.claudefordesktop', 'claude'],
  ['com.openai.codex', 'codex'],
  ['ai.autonomous.harness', 'harness'],
]

const EXES: [string, string][] = [
  ['Code.exe', 'vscode'],
  ['CODE.EXE', 'vscode'],
  ['code', 'vscode'],
  ['Cursor.exe', 'cursor'],
  ['cursor', 'cursor'],
  ['WindowsTerminal.exe', 'terminal'],
  // The Store's ChatGPT on Windows is the Codex app (package OpenAI.Codex), its window ChatGPT.exe's.
  ['ChatGPT.exe', 'codex'],
  ['chatgpt.exe', 'codex'],
  ['wezterm-gui', 'wezterm'],
  ['kitty', 'kitty'],
  ['ghostty', 'ghostty'],
  // The Claude app's window on Windows is its claude.exe's (dial-windows VM notes, Task 37 §1).
  ['Claude.exe', 'claude'],
  ['claude.exe', 'claude'],
  // Orca's window on Windows is its Orca.exe's (dial-windows VM notes, "### 1. Window owners").
  ['Orca.exe', 'orca'],
  ['orca.exe', 'orca'],
  // Harness Desktop's window on Windows is its harness-desktop.exe's (desktop/windows/CMakeLists.txt, BINARY_NAME).
  ['harness-desktop.exe', 'harness'],
  ['Harness-Desktop.exe', 'harness'],
]

// The Claude, ChatGPT and Orca apps' Linux processes, by the comm their recording shows (ChatGPT's as recorded,
// capitalised; Orca's is its main process, the maker when no daemon runs).
const LINUX_APPS: [string, string][] = [
  [RECORDED_LINUX_APPS.claude.comm, 'claude'],
  [RECORDED_LINUX_APPS.chatgpt.comm, 'codex'],
  [RECORDED_ORCA.linux.inProcess.makerComm, 'orca'],
  // Harness Desktop's Linux binary (desktop/linux/CMakeLists.txt, BINARY_NAME).
  ['harness', 'harness'],
  ['Harness', 'harness'],
]

// Bundle ids known in front only: detectApp and open leave them as they are.
const FRONT_BUNDLES: [string, string][] = [
  // Alacritty's Info.plist: an agent there is in the unknown app.
  ['org.alacritty', 'terminal'],
  // Warp Preview (Homebrew cask warp@preview).
  ['dev.warp.Warp-Preview', 'warp'],
  // The Rex Server app (its Info.plist, 2026-11-25): the parent of every Rex block's program, which the open scan reads.
  ['com.superlogical.rex.server', 'rex'],
]

// Alacritty's and Warp's processes: alacritty.exe and warp.exe on Windows, alacritty and warp on Linux, and Warp
// Preview's warp-preview on Linux.
const TERMINAL_EXES: [string, string][] = [
  ['alacritty.exe', 'terminal'],
  ['Alacritty.exe', 'terminal'],
  ['alacritty', 'terminal'],
  ['warp.exe', 'warp'],
  ['Warp.exe', 'warp'],
  ['warp', 'warp'],
  ['warp-preview', 'warp'],
]

describe('frontAppId', () => {
  it.each(FRONT_BUNDLES)('Alacritty and Warp Preview map by their bundle ids on macOS: %s', (bundle, id) => {
    expect(frontAppId(bundle)).toBe(id)
  })

  // The front follows to the page their agents are on: Alacritty sets no TERM_PROGRAM, and Warp's is WarpTerminal.
  it('an agent in Alacritty or Warp Preview is on the page their bundle id in front gives', () => {
    expect(detectApp({ __CFBundleIdentifier: 'org.alacritty' })).toBe(frontAppId('org.alacritty'))
    expect(detectApp({ __CFBundleIdentifier: 'dev.warp.Warp-Preview', TERM_PROGRAM: 'WarpTerminal' }))
      .toBe(frontAppId('dev.warp.Warp-Preview'))
  })

  it.each(TERMINAL_EXES)('Alacritty and Warp map by their exe names on Windows and Linux: %s', (exe, id) => {
    expect(frontAppId(exe)).toBe(id)
  })

  it.each(BUNDLES)('every bundle id maps to the id detectApp gives for it: %s', (bundle, id) => {
    expect(frontAppId(bundle)).toBe(id)
    expect(detectApp({ __CFBundleIdentifier: bundle })).toBe(id)
  })

  it.each(EXES)('Code.exe, Cursor.exe, WindowsTerminal.exe, ChatGPT.exe, Claude.exe, Orca.exe, harness-desktop.exe (Harness Desktop), wezterm-gui, kitty and ghostty map: %s', (exe, id) => {
    expect(frontAppId(exe)).toBe(id)
  })

  it.each(LINUX_APPS)('the Claude, ChatGPT, Orca and Harness apps on Linux map by their process name: %s', (comm, id) => {
    expect(frontAppId(comm)).toBe(id)
  })

  it.each(['wezterm-mux-server', RECORDED_WEZTERM.muxServerComm])(
    'frontAppId names WezTerm for its mux server, whole and as Linux cuts it: %s', (comm) => {
      expect(frontAppId(comm)).toBe('wezterm')
    })

  it.each(['com.apple.Safari', 'net.kovidgoyal.kitty-quick-access', '', 'x'.repeat(128),
    'constructor', '__proto__', 'toString', 'COM.MITCHELLH.GHOSTTY', 'com.openai.chat', 'codex', 'Codex.exe',
    'com.cmuxterm.app.nightly', 'cmux',
    // The Linux processes' names are Linux's alone, and the Claude app's claude.exe is Windows' alone.
    'claude-desktop.exe', 'claude', 'orca-ide.exe',
    // harness.exe on Windows is the CLI (pty/src/command.rs), whose window is the terminal's; Harness Desktop is
    // harness-desktop.exe there.
    'harness.exe', 'Harness.exe',
    // A bare harness-desktop is no app's elsewhere: Harness Desktop's Linux binary is harness.
    'harness-desktop',
    // Warp Preview's Windows name is unconfirmed.
    'warp-preview.exe',
    // A bare orca on Linux is GNOME's screen reader (/usr/bin/orca), not the Orca app.
    'orca', 'Orca'])(
    'an unknown app, the empty string and a 128-character string are none: %j', (value) => {
      expect(frontAppId(value)).toBe(FRONT_NONE)
    })

  it('no value maps to the words other or Other, and none is no app id', () => {
    expect(FRONT_NONE).toBe('none')
    expect(APP_IDS).not.toContain(FRONT_NONE)
    expect(frontAppId('other')).toBe(FRONT_NONE)
    expect(frontAppId('Other')).toBe(FRONT_NONE)
    for (const [value] of [...BUNDLES, ...FRONT_BUNDLES, ...EXES, ...TERMINAL_EXES, ...LINUX_APPS]) expect(frontAppId(value)).not.toMatch(/^other$/i)
  })

  it('every id the table can give is an app id or none', () => {
    for (const [value] of [...BUNDLES, ...FRONT_BUNDLES, ...EXES, ...TERMINAL_EXES, ...LINUX_APPS]) {
      const id = frontAppId(value)
      expect(APP_IDS.includes(id) || id === FRONT_NONE).toBe(true)
    }
  })
})

// Each app's window class spellings on Linux. ChatGPT's .desktop has no StartupWMClass: its class is read from its code.
const CLASSES: [string, string[]][] = [
  ['vscode', [RECORDED_LINUX_APPS.vscode.startupWmClass, RECORDED_LINUX_APPS.vscode.startupWmClass.toLowerCase()]],
  ['cursor', [RECORDED_LINUX_APPS.cursor.startupWmClass, RECORDED_LINUX_APPS.cursor.startupWmClass.toLowerCase()]],
  ['claude', [RECORDED_LINUX_APPS.claude.startupWmClass, RECORDED_LINUX_APPS.claude.startupWmClass.toLowerCase()]],
  ['codex', [RECORDED_LINUX_APPS.chatgpt.windowClasses.x11, RECORDED_LINUX_APPS.chatgpt.windowClasses.wayland]],
  ['wezterm', ['org.wezfurlong.wezterm']],
  ['kitty', ['kitty']],
  ['ghostty', ['com.mitchellh.ghostty']],
  ['harness', ['com.autonomous.harness', 'harness']],
]

describe('windowClasses', () => {
  it.each(CLASSES)('an app with a row gives its spellings: %s', (app, classes) => {
    expect(windowClasses(app)).toEqual(classes)
  })

  it('every row is an app id, and every other app id gives none', () => {
    const rows = new Set(CLASSES.map(([app]) => app))
    for (const [app] of CLASSES) expect(APP_IDS).toContain(app)
    for (const app of APP_IDS.filter((id) => !rows.has(id))) expect(windowClasses(app)).toEqual([])
  })

  it.each(['unknown', '', 'constructor', '__proto__', 'toString', 'Code', 'VSCODE'])(
    'an app with no row and an inherited key give none: %j', (app) => {
      expect(windowClasses(app)).toEqual([])
    })

  it('every spelling is a safe class', () => {
    for (const [app] of CLASSES) {
      for (const cls of windowClasses(app)) expect(cls).toMatch(/^[A-Za-z0-9._-]{1,64}$/)
    }
  })
})
