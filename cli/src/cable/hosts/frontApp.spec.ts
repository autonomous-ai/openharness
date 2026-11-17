import { describe, expect, it } from 'vitest'
import { FRONT_NONE, frontAppId } from './frontApp.js'
import { APP_IDS, detectApp } from './hostDetect.js'

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

describe('frontAppId', () => {
  it.each(BUNDLES)('every bundle id maps to the id detectApp gives for it: %s', (bundle, id) => {
    expect(frontAppId(bundle)).toBe(id)
    expect(detectApp({ __CFBundleIdentifier: bundle })).toBe(id)
  })

  it.each(EXES)('Code.exe, Cursor.exe, WindowsTerminal.exe, wezterm-gui, kitty, ghostty and harness map: %s', (exe, id) => {
    expect(frontAppId(exe)).toBe(id)
  })

  it.each(['com.apple.Safari', 'org.alacritty', 'net.kovidgoyal.kitty-quick-access', 'alacritty', '', 'x'.repeat(128),
    'constructor', '__proto__', 'toString', 'COM.MITCHELLH.GHOSTTY', 'com.openai.chat', 'codex', 'Codex.exe', 'ChatGPT',
    'com.cmuxterm.app.nightly', 'cmux'])(
    'an unknown app, the empty string and a 128-character string are none: %j', (value) => {
      expect(frontAppId(value)).toBe(FRONT_NONE)
    })

  it('no value maps to the words other or Other, and none is no app id', () => {
    expect(FRONT_NONE).toBe('none')
    expect(APP_IDS).not.toContain(FRONT_NONE)
    expect(frontAppId('other')).toBe(FRONT_NONE)
    expect(frontAppId('Other')).toBe(FRONT_NONE)
    for (const [value] of [...BUNDLES, ...EXES]) expect(frontAppId(value)).not.toMatch(/^other$/i)
  })

  it('every id the table can give is an app id or none', () => {
    for (const [value] of [...BUNDLES, ...EXES]) {
      const id = frontAppId(value)
      expect(APP_IDS.includes(id) || id === FRONT_NONE).toBe(true)
    }
  })
})
