import { describe, expect, it } from 'vitest'
import { detectHost, hostDisplayName } from './hostDetect.js'

describe('detectHost', () => {
  it.each([
    [{ HERDR_PANE_ID: '1' }, 'herdr'],
    [{ REX_BLOCK: 'x' }, 'rex'],
    [{ ZELLIJ: '0' }, 'zellij'],
    [{ KITTY_WINDOW_ID: '3' }, 'kitty'],
    [{ WEZTERM_PANE: '2' }, 'wezterm'],
    [{ ORCA_AGENT_SESSION_ID: 'abc' }, 'orca'],
    [{ __CFBundleIdentifier: 'com.stablyai.orca' }, 'orca'],
    [{ TERM_PROGRAM: 'iTerm.app' }, 'iterm'],
    [{ __CFBundleIdentifier: 'com.googlecode.iterm2' }, 'iterm'],
    [{ TERM_PROGRAM: 'Apple_Terminal' }, 'terminal-app'],
    [{ __CFBundleIdentifier: 'com.apple.Terminal' }, 'terminal-app'],
    [{ TERM_PROGRAM: 'ghostty' }, 'ghostty'],
    [{ __CFBundleIdentifier: 'com.mitchellh.ghostty' }, 'ghostty'],
    [{ TERM_PROGRAM: 'vscode' }, 'vscode'],
    [{ __CFBundleIdentifier: 'com.microsoft.VSCode' }, 'vscode'],
    [{ __CFBundleIdentifier: 'com.todesktop.230313mzl4w4u92' }, 'cursor'],
    [{ TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.todesktop.230313mzl4w4u92' }, 'cursor'],
    [{ TERM_PROGRAM: 'WarpTerminal' }, 'warp'],
    [{ __CFBundleIdentifier: 'dev.warp.Warp-Stable' }, 'warp'],
  ])('%j -> %s', (hints, id) => {
    expect(detectHost(hints)).toBe(id)
  })

  it('unknown -> terminal', () => {
    expect(detectHost({})).toBe('terminal')
    expect(detectHost({ TERM_PROGRAM: 'tmux' })).toBe('terminal')
  })

  it('a multiplexer variable wins over the outer terminal', () => {
    expect(detectHost({ ZELLIJ: '0', TERM_PROGRAM: 'ghostty' })).toBe('zellij')
  })

  it('names', () => {
    expect(['orca', 'herdr', 'rex', 'zellij', 'kitty', 'wezterm', 'iterm', 'terminal-app', 'ghostty', 'vscode', 'cursor', 'warp', 'terminal', 'harness'].map(hostDisplayName))
      .toEqual(['Orca', 'herdr', 'Rex', 'Zellij', 'kitty', 'WezTerm', 'iTerm2', 'Terminal', 'Ghostty', 'VS Code', 'Cursor', 'Warp', 'Terminal', 'Harness'])
  })
})
