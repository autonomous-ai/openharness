import { describe, expect, it } from 'vitest'
import { APP_IDS, appDisplayName, detectApp, detectHost, hostDisplayName, UNKNOWN_APP } from './hostDetect.js'

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

  it('TMUX_PANE names the host tmux, after herdr, Rex and Zellij and before kitty and WezTerm', () => {
    expect(detectHost({ TMUX_PANE: '%3' })).toBe('tmux')
    expect(detectHost({ TMUX_PANE: '%3', TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'com.mitchellh.ghostty' })).toBe('tmux')
    for (const own of ['HERDR_PANE_ID', 'REX_BLOCK', 'ZELLIJ']) expect(detectHost({ [own]: '1', TMUX_PANE: '%3' })).not.toBe('tmux')
    for (const own of ['KITTY_WINDOW_ID', 'WEZTERM_PANE', 'ORCA_AGENT_SESSION_ID']) expect(detectHost({ [own]: '1', TMUX_PANE: '%3' })).toBe('tmux')
    // TERM_PROGRAM alone names no host: a pane is what a tap switches to.
    expect(detectHost({ TERM_PROGRAM: 'tmux' })).toBe('terminal')
  })

  it('names', () => {
    expect(['orca', 'herdr', 'rex', 'zellij', 'kitty', 'wezterm', 'iterm', 'terminal-app', 'ghostty', 'vscode', 'cursor', 'warp', 'terminal', 'harness'].map(hostDisplayName))
      .toEqual(['Orca', 'herdr', 'Rex', 'Zellij', 'kitty', 'WezTerm', 'iTerm2', 'Terminal', 'Ghostty', 'VS Code', 'Cursor', 'Warp', 'Terminal', 'Harness'])
  })
})

describe('detectApp', () => {
  it.each([
    ['ZELLIJ', 'ghostty', 'ghostty'], ['ZELLIJ', 'iTerm.app', 'iterm'], ['ZELLIJ', 'Apple_Terminal', 'terminal-app'],
    ['HERDR_PANE_ID', 'ghostty', 'ghostty'], ['HERDR_PANE_ID', 'iTerm.app', 'iterm'], ['HERDR_PANE_ID', 'Apple_Terminal', 'terminal-app'],
    ['REX_BLOCK', 'ghostty', 'ghostty'], ['REX_BLOCK', 'iTerm.app', 'iterm'], ['REX_BLOCK', 'Apple_Terminal', 'terminal-app'],
  ])('zellij, herdr and rex inside Ghostty, iTerm2 and Terminal give the terminal: %s in %s', (own, program, app) => {
    expect(detectApp({ [own]: '1', TERM_PROGRAM: program })).toBe(app)
  })

  it('the bundle id decides before TERM_PROGRAM: Cursor before VS Code', () => {
    expect(detectApp({ TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.todesktop.230313mzl4w4u92' })).toBe('cursor')
  })

  it('an unknown bundle id or TERM_PROGRAM gives the unknown app', () => {
    expect(detectApp({ __CFBundleIdentifier: 'org.alacritty' })).toBe(UNKNOWN_APP)
    expect(detectApp({ TERM_PROGRAM: 'rio' })).toBe(UNKNOWN_APP)
    expect(detectApp({ __CFBundleIdentifier: 'net.kovidgoyal.kitty-quick-access' })).toBe(UNKNOWN_APP)
    expect(UNKNOWN_APP).toBe('terminal')
  })

  it('tmux in Ghostty is on Ghostty\'s page; with no app named, tmux has a page of its own', () => {
    expect(detectApp({ TMUX_PANE: '%3', TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'com.mitchellh.ghostty' })).toBe('ghostty')
    expect(detectApp({ TERM_PROGRAM: 'tmux' })).toBe('tmux')
    expect(detectApp({ TMUX_PANE: '%3' })).toBe('tmux')
    expect(detectApp({ TMUX_PANE: '%3', TERM_PROGRAM: 'tmux', KITTY_WINDOW_ID: '1' })).toBe('tmux')
    // tmux in Alacritty: a bundle id no table lists (PM, 2026-11-15).
    expect(detectApp({ TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'org.alacritty' })).toBe('tmux')
    expect([hostDisplayName('tmux'), appDisplayName('tmux')]).toEqual(['tmux', 'tmux'])
  })

  it("a hint naming an object's own key gives the unknown app: hint values are outside text", () => {
    for (const key of ['constructor', '__proto__', 'toString']) {
      for (const hint of ['__CFBundleIdentifier', 'TERM_PROGRAM']) {
        expect(detectApp({ [hint]: key })).toBe(UNKNOWN_APP)
        expect(detectHost({ [hint]: key })).toBe('terminal')
      }
    }
  })

  it('kitty and WezTerm by bundle id, WezTerm by TERM_PROGRAM, Harness Desktop by bundle id', () => {
    expect(detectApp({ __CFBundleIdentifier: 'net.kovidgoyal.kitty' })).toBe('kitty')
    expect(detectApp({ __CFBundleIdentifier: 'com.github.wez.wezterm' })).toBe('wezterm')
    expect(detectApp({ TERM_PROGRAM: 'WezTerm' })).toBe('wezterm')
    expect(detectApp({ __CFBundleIdentifier: 'ai.autonomous.harness' })).toBe('harness')
  })

  it("herdr's app by its bundle id, the same table a tap opens it by", () => {
    expect(detectApp({ HERDR_PANE_ID: '1', __CFBundleIdentifier: 'dev.herdr.app' })).toBe('herdr')
  })

  it('zellij inside kitty is kitty, with and without a bundle id', () => {
    expect(detectApp({ ZELLIJ: '0', KITTY_WINDOW_ID: '1', __CFBundleIdentifier: 'net.kovidgoyal.kitty' })).toBe('kitty')
    expect(detectApp({ ZELLIJ: '0', KITTY_WINDOW_ID: '1' })).toBe('kitty')
  })

  it("kitty's variable never decides against a bundle id or a TERM_PROGRAM", () => {
    // VS Code started from a kitty shell.
    expect(detectApp({ KITTY_WINDOW_ID: '1', TERM_PROGRAM: 'vscode' })).toBe('vscode')
  })

  it('with neither set, the app is the host', () => {
    expect(detectApp({ ZELLIJ: '0' })).toBe('zellij')
    expect(detectApp({})).toBe('terminal')
    expect(detectApp({ ORCA_AGENT_SESSION_ID: 'x' })).toBe('orca')
    expect(detectApp({ WEZTERM_PANE: '0' })).toBe('wezterm')
  })

  it("the Claude desktop app's bundle id is claude, read Claude", () => {
    const hints = { __CFBundleIdentifier: 'com.anthropic.claudefordesktop' }
    expect(detectHost(hints)).toBe('claude')
    expect(detectApp(hints)).toBe('claude')
    expect(hostDisplayName('claude')).toBe('Claude')
    expect(appDisplayName('claude')).toBe('Claude')
  })

  it('APP_IDS has 16 ids, at most 16, and every one has a display name', () => {
    expect(APP_IDS).toHaveLength(16)
    expect(APP_IDS.length).toBeLessThanOrEqual(16)
    for (const id of APP_IDS) expect(appDisplayName(id)).toMatch(/\S/)
  })

  it('the unknown app reads Other, Apple\'s Terminal reads Terminal, and every other app reads as its host', () => {
    expect(appDisplayName('terminal')).toBe('Other')
    expect(appDisplayName('terminal-app')).toBe('Terminal')
    expect(hostDisplayName('terminal')).toBe('Terminal')
    const others = APP_IDS.filter((id) => id !== 'terminal' && id !== 'terminal-app')
    expect(others).toHaveLength(14)
    for (const id of others) expect(appDisplayName(id)).toBe(hostDisplayName(id))
  })
})
