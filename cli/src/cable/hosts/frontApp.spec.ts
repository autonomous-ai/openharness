import { describe, expect, it } from 'vitest'
import { FRONT_NONE, frontAppId, windowClasses } from './frontApp.js'
import { APP_IDS, detectApp } from './hostDetect.js'
import { RECORDED_LINUX_APPS } from '../../testing/recordedLinuxApps.js'

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
  ['wezterm-gui', 'wezterm'],
  ['kitty', 'kitty'],
  ['ghostty', 'ghostty'],
  ['harness', 'harness'],
  ['Harness', 'harness'],
]

// The Claude and ChatGPT apps' Linux processes, by the comm their recording shows (ChatGPT's as recorded, capitalised).
const LINUX_APPS: [string, string][] = [
  [RECORDED_LINUX_APPS.claude.comm, 'claude'],
  [RECORDED_LINUX_APPS.chatgpt.comm, 'codex'],
]

describe('frontAppId', () => {
  it.each(BUNDLES)('every bundle id maps to the id detectApp gives for it: %s', (bundle, id) => {
    expect(frontAppId(bundle)).toBe(id)
    expect(detectApp({ __CFBundleIdentifier: bundle })).toBe(id)
  })

  it.each(EXES)('Code.exe, Cursor.exe, WindowsTerminal.exe, wezterm-gui, kitty, ghostty and harness map: %s', (exe, id) => {
    expect(frontAppId(exe)).toBe(id)
  })

  it.each(LINUX_APPS)('the Claude and ChatGPT apps on Linux map by their recorded comm: %s', (comm, id) => {
    expect(frontAppId(comm)).toBe(id)
  })

  it.each(['com.apple.Safari', 'org.alacritty', 'net.kovidgoyal.kitty-quick-access', 'alacritty', '', 'x'.repeat(128),
    'constructor', '__proto__', 'toString', 'COM.MITCHELLH.GHOSTTY', 'com.openai.chat', 'codex', 'Codex.exe',
    'com.cmuxterm.app.nightly', 'cmux'])(
    'an unknown app, the empty string and a 128-character string are none: %j', (value) => {
      expect(frontAppId(value)).toBe(FRONT_NONE)
    })

  it('no value maps to the words other or Other, and none is no app id', () => {
    expect(FRONT_NONE).toBe('none')
    expect(APP_IDS).not.toContain(FRONT_NONE)
    expect(frontAppId('other')).toBe(FRONT_NONE)
    expect(frontAppId('Other')).toBe(FRONT_NONE)
    for (const [value] of [...BUNDLES, ...EXES, ...LINUX_APPS]) expect(frontAppId(value)).not.toMatch(/^other$/i)
  })

  it('every id the table can give is an app id or none', () => {
    for (const [value] of [...BUNDLES, ...EXES, ...LINUX_APPS]) {
      const id = frontAppId(value)
      expect(APP_IDS.includes(id) || id === FRONT_NONE).toBe(true)
    }
  })
})

// Each app's window class spellings on Linux. ChatGPT's .desktop has no StartupWMClass, so codex has none recorded.
const CLASSES: [string, string[]][] = [
  ['vscode', [RECORDED_LINUX_APPS.vscode.startupWmClass, RECORDED_LINUX_APPS.vscode.startupWmClass.toLowerCase()]],
  ['cursor', [RECORDED_LINUX_APPS.cursor.startupWmClass, RECORDED_LINUX_APPS.cursor.startupWmClass.toLowerCase()]],
  ['claude', [RECORDED_LINUX_APPS.claude.startupWmClass, RECORDED_LINUX_APPS.claude.startupWmClass.toLowerCase()]],
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

  it.each(['codex', 'unknown', '', 'constructor', '__proto__', 'toString', 'Code', 'VSCODE'])(
    'an app with no row and an inherited key give none: %j', (app) => {
      expect(windowClasses(app)).toEqual([])
    })

  it('every spelling is a safe class', () => {
    for (const [app] of CLASSES) {
      for (const cls of windowClasses(app)) expect(cls).toMatch(/^[A-Za-z0-9._-]{1,64}$/)
    }
  })
})
