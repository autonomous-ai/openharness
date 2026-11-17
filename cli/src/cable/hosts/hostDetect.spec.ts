import { describe, expect, it } from 'vitest'
import { APP_BUNDLES, APP_IDS, appDisplayName, detectApp, detectHost, hostDisplayName, inCmux, inHerdr, UNKNOWN_APP } from './hostDetect.js'

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
    [{ HC_TERMINAL_ID: 't7' }, 'herdr'],
    [{ HC_TERMINAL_ID: 't7', TERM_PROGRAM: 'ghostty' }, 'herdr'],
    [{ HC_TERMINAL_ID: 't7', __CFBundleIdentifier: 'com.mitchellh.ghostty' }, 'herdr'],
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

  it('a multiplexer inside a Herdr terminal is the nearer host', () => {
    const hc = { HC_TERMINAL_ID: 't7' }
    expect(detectHost({ ...hc, REX_BLOCK: 'x' })).toBe('rex')
    expect(detectHost({ ...hc, ZELLIJ: '0' })).toBe('zellij')
    expect(detectHost({ ...hc, TMUX_PANE: '%3' })).toBe('tmux')
    for (const own of ['KITTY_WINDOW_ID', 'WEZTERM_PANE', 'ORCA_AGENT_SESSION_ID']) expect(detectHost({ ...hc, [own]: '1' })).toBe('herdr')
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

  it("an hc terminal is on herdr's page, whatever it says of its terminal", () => {
    const hc = { HC_TERMINAL_ID: 't7', TERM_PROGRAM: 'ghostty' }
    expect(detectApp(hc)).toBe('herdr')
    expect(detectApp({ ...hc, __CFBundleIdentifier: 'dev.herdr.core' })).toBe('herdr')
    expect(detectApp({ ...hc, __CFBundleIdentifier: 'com.stablyai.orca' })).toBe('herdr')
  })

  // Every program an hc terminal starts inherits its HC_TERMINAL_ID (`code .`, tmux, zellij, herdr): there it names the
  // terminal the other app was started from, whose agent is another.
  it('an hc address another app or a nearer host inherited is not herdr\'s', () => {
    const vscode = { HC_TERMINAL_ID: 't3', TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.microsoft.VSCode' }
    expect(detectHost(vscode)).toBe('vscode')
    expect(detectApp(vscode)).toBe('vscode')
    const tmux = { HC_TERMINAL_ID: 't3', TERM_PROGRAM: 'tmux', TMUX_PANE: '%3' }
    expect(detectHost(tmux)).toBe('tmux')
    expect(detectApp(tmux)).toBe('tmux')
    expect(detectApp({ HC_TERMINAL_ID: 't3', TERM_PROGRAM: 'ghostty', TMUX_PANE: '%3' })).toBe('ghostty')
    expect(detectApp({ HC_TERMINAL_ID: 't3', TERM_PROGRAM: 'iTerm.app' })).toBe('iterm')
    expect(detectHost({ HC_TERMINAL_ID: 't3', TERM_PROGRAM: 'WezTerm' })).toBe('terminal')
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

  it("the Codex app's bundle id is codex, read ChatGPT", () => {
    const hints = { __CFBundleIdentifier: 'com.openai.codex' }
    expect(detectHost(hints)).toBe('codex')
    expect(detectApp(hints)).toBe('codex')
    expect(hostDisplayName('codex')).toBe('ChatGPT')
    expect(appDisplayName('codex')).toBe('ChatGPT')
  })

  it('a multiplexer inside the Codex app is on the Codex page', () => {
    const hints = { TMUX_PANE: '%3', __CFBundleIdentifier: 'com.openai.codex' }
    expect(detectHost(hints)).toBe('tmux')
    expect(detectApp(hints)).toBe('codex')
  })

  it("OpenAI's chat app is not the Codex app", () => {
    const hints = { __CFBundleIdentifier: 'com.openai.chat' }
    expect(detectApp(hints)).toBe(UNKNOWN_APP)
    expect(detectHost(hints)).toBe('terminal')
  })

  it("cmux's bundle id is the app cmux, read cmux", () => {
    expect(detectApp({ __CFBundleIdentifier: 'com.cmuxterm.app' })).toBe('cmux')
    expect(hostDisplayName('cmux')).toBe('cmux')
    expect(appDisplayName('cmux')).toBe('cmux')
  })

  it('cmux NIGHTLY names nothing', () => {
    expect(detectApp({ __CFBundleIdentifier: 'com.cmuxterm.app.nightly' })).toBe(UNKNOWN_APP)
  })

  it('APP_IDS has 19 ids, and every one has a display name', () => {
    expect(APP_IDS).toHaveLength(19)
    expect(APP_IDS.indexOf('codex')).toBe(APP_IDS.indexOf('claude') + 1)
    expect(APP_IDS.indexOf('cmux')).toBe(APP_IDS.indexOf('ghostty') + 1)
    expect(APP_IDS.indexOf('opencode')).toBe(APP_IDS.indexOf('codex') + 1)
    expect(APP_IDS.at(-1)).toBe('terminal')
    for (const id of APP_IDS) expect(appDisplayName(id)).toMatch(/\S/)
  })

  it('the unknown app reads Other, Apple\'s Terminal reads Terminal, and every other app reads as its host', () => {
    expect(appDisplayName('terminal')).toBe('Other')
    expect(appDisplayName('terminal-app')).toBe('Terminal')
    expect(hostDisplayName('terminal')).toBe('Terminal')
    const others = APP_IDS.filter((id) => id !== 'terminal' && id !== 'terminal-app')
    expect(others).toHaveLength(17)
    for (const id of others) expect(appDisplayName(id)).toBe(hostDisplayName(id))
  })

  it('opencode is a page with a name, and no hint names it', () => {
    expect(hostDisplayName('opencode')).toBe('opencode')
    expect(appDisplayName('opencode')).toBe('opencode')
    expect(Object.hasOwn(APP_BUNDLES, 'opencode')).toBe(false)
    const hints = { TERM_PROGRAM: 'opencode' }
    expect(detectApp(hints)).toBe(UNKNOWN_APP)
    expect(detectHost(hints)).toBe('terminal')
  })
})

// Only hc's own terminal is Herdr's: the one predicate detectHost, detectApp, the Herdr adapter and a tap's bundle read.
describe('inHerdr', () => {
  it.each<Record<string, string>>([
    { HC_TERMINAL_ID: 't7' },
    { HC_TERMINAL_ID: 't1b', TERM_PROGRAM: 'ghostty' },
    { HC_TERMINAL_ID: 't7', TERM_PROGRAM: 'ghostty', __CFBundleIdentifier: 'com.stablyai.orca' },
  ])('hc\'s own terminal: %j', (hints) => {
    expect(inHerdr(hints)).toBe(true)
    expect(detectHost(hints)).toBe('herdr')
    expect(detectApp(hints)).toBe('herdr')
  })

  it.each<Record<string, string>>([
    {},
    { TERM_PROGRAM: 'ghostty' },
    ...['vps/t7', 'T7', 't', '--help', 't7; rm -rf /', `t${'1'.repeat(17)}`].map((id) => ({ HC_TERMINAL_ID: id, TERM_PROGRAM: 'ghostty' })),
    ...['vscode', 'tmux', 'iTerm.app', 'WezTerm', 'Apple_Terminal', 'rio'].map((program) => ({ HC_TERMINAL_ID: 't7', TERM_PROGRAM: program })),
    ...['HERDR_PANE_ID', 'REX_BLOCK', 'ZELLIJ', 'TMUX_PANE'].map((own) => ({ HC_TERMINAL_ID: 't7', TERM_PROGRAM: 'ghostty', [own]: '1' })),
  ])('not hc\'s own terminal: %j', (hints) => {
    expect(inHerdr(hints)).toBe(false)
    expect(detectApp(hints)).not.toBe('herdr')
  })
})

// Only cmux's own terminal is cmux's: every program started there inherits its CMUX_* variables (`code .`, WezTerm,
// kitty, tmux), and the ids are outside text that decide which adapter may type into a terminal.
describe('inCmux', () => {
  const S = '6F1C2B3A-4D5E-4F60-8172-93A4B5C6D7E8'
  const W = '0A1B2C3D-4E5F-4061-8273-94A5B6C7D8E9'
  const cmux = { CMUX_SURFACE_ID: S, CMUX_WORKSPACE_ID: W }

  it.each<Record<string, string>>([
    cmux,
    { ...cmux, TERM_PROGRAM: 'ghostty' },
    { ...cmux, __CFBundleIdentifier: 'com.cmuxterm.app' },
    { ...cmux, __CFBundleIdentifier: 'com.mitchellh.ghostty' },
    { CMUX_SURFACE_ID: S.toLowerCase(), CMUX_WORKSPACE_ID: W.toLowerCase() },
  ])("cmux's own terminal: %j", (hints) => {
    expect(inCmux(hints)).toBe(true)
  })

  it.each<Record<string, string>>([
    {},
    { CMUX_SURFACE_ID: S },
    { CMUX_WORKSPACE_ID: W },
    ...['--help', 'x; rm -rf /', `${S}0`].map((surface) => ({ CMUX_SURFACE_ID: surface, CMUX_WORKSPACE_ID: W })),
    ...['vscode', 'WezTerm', 'tmux', 'iTerm.app'].map((program) => ({ ...cmux, TERM_PROGRAM: program })),
    ...['com.cmuxterm.app.nightly', 'com.googlecode.iterm2'].map((bundle) => ({ ...cmux, TERM_PROGRAM: 'ghostty', __CFBundleIdentifier: bundle })),
    ...['HERDR_PANE_ID', 'REX_BLOCK', 'ZELLIJ', 'TMUX_PANE', 'HC_TERMINAL_ID', 'KITTY_WINDOW_ID', 'WEZTERM_PANE',
      'ORCA_AGENT_SESSION_ID', 'ORCA_TERMINAL_HANDLE'].map((own) => ({ ...cmux, [own]: '1' })),
  ])("not cmux's own terminal: %j", (hints) => {
    expect(inCmux(hints)).toBe(false)
  })

  it("a cmux terminal is cmux's host and page, never Ghostty's", () => {
    for (const hints of [{ ...cmux, TERM_PROGRAM: 'ghostty' }, { ...cmux, TERM_PROGRAM: 'ghostty', __CFBundleIdentifier: 'com.mitchellh.ghostty' }]) {
      expect(detectHost(hints)).toBe('cmux')
      expect(detectApp(hints)).toBe('cmux')
    }
  })

  // cmux NIGHTLY sets the same variables, and a tap's link goes to the release app alone, which has no such surface.
  it("a cmux NIGHTLY terminal is not cmux's", () => {
    const hints = { ...cmux, TERM_PROGRAM: 'ghostty', __CFBundleIdentifier: 'com.cmuxterm.app.nightly' }
    expect(detectHost(hints)).not.toBe('cmux')
    expect(detectApp(hints)).not.toBe('cmux')
  })

  it('an Orca session started from a cmux terminal is Orca\'s', () => {
    expect(detectHost({ ...cmux, TERM_PROGRAM: 'ghostty', ORCA_AGENT_SESSION_ID: '1' })).toBe('orca')
  })

  it('a program started from a cmux terminal is its own', () => {
    const hints = { ...cmux, TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.microsoft.VSCode' }
    expect(detectHost(hints)).toBe('vscode')
    expect(detectApp(hints)).toBe('vscode')
  })

  it("tmux inside cmux is tmux, on cmux's page", () => {
    const hints = { ...cmux, TMUX_PANE: '%3', TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'com.cmuxterm.app' }
    expect(detectHost(hints)).toBe('tmux')
    expect(detectApp(hints)).toBe('cmux')
  })

  it("a cmux terminal whose ids the hook left out is Ghostty's host, on cmux's page", () => {
    const hints = { TERM_PROGRAM: 'ghostty', __CFBundleIdentifier: 'com.cmuxterm.app' }
    expect(detectHost(hints)).toBe('ghostty')
    expect(detectApp(hints)).toBe('cmux')
  })
})
