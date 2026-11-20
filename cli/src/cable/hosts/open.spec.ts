import { describe, expect, it, vi } from 'vitest'
import type { HostAdapter, Pane } from './adapter.js'
import { createClaudeAppAdapter } from './claudeApp.js'
import { createCodexAppAdapter } from './codexApp.js'
import { windowClasses } from './frontApp.js'
import { createHerdrAdapter } from './herdr.js'
import { detectApp, detectHost } from './hostDetect.js'
import { createLinuxRaise, type LinuxRaise, type RaiseTarget } from './linuxRaise.js'
import { bundleOf, createOpenActions, type OpenTarget } from './open.js'
import { createOrcaAdapter, type OrcaDeps } from './orca.js'
import { createTabsAdapter } from './tabs.js'
import { createWeztermAdapter } from './wezterm.js'
import type { WindowsRaise } from './windowsRaise.js'

const HANDLE = 'term_0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b'
const SESSION = 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
const CLAUDE = 'com.anthropic.claudefordesktop'
const THREAD = '01a1de76-a3b7-7270-b39e-1245893274c1'
const CODEX_APP = 'com.openai.codex'
const OPEN = '/usr/bin/open'
const APP_WEZTERM = '/Applications/WezTerm.app/Contents/MacOS/wezterm'

interface Call { file: string; args: string[]; timeoutMs: number }
/** A window a raise is asked for: a process and an app. */
interface Window { pid?: number; app?: string }

/** herdr's socket, which no tap asks: a tap is `herdr agent focus`. */
const herdrClient = { prompt: vi.fn(), socketStamp: vi.fn() }

/** What a test may set: the runner and the binaries it finds, Orca's switch, the log, the opener's `open`, whether
 *  Herdr.app's window is herdr's ring's, Linux's raise with each agent's window, and Windows' raise. */
interface Over extends OrcaDeps {
  orcaSwitch(handle: string): Promise<boolean>
  log(line: string): void
  bin?: string
  herdrApp?(): boolean
  raise?: LinuxRaise
  windowOf?(agentId: string): Window | undefined
  windows?: WindowsRaise
}

/** A recording runner that runs nothing, so no spec brings the developer's own apps forward: each call answers the next
 *  of [codes], then exit 0. The opener holds the adapters over it, a tabs stream never open, and any [more]. */
function recorder(over: Partial<Over> = {}, codes: Array<number | null> = [], more: readonly HostAdapter[] = []) {
  const calls: Call[] = []
  const switched: string[] = []
  const logs: string[] = []
  const deps: Over = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return { code: codes.length ? codes.shift()! : 0, stdout: '' }
    },
    onPath: (name) => `/fake/bin/${name}`,
    exists: () => false,
    platform: 'darwin',
    orcaSwitch: async () => true,
    log: (line) => { logs.push(line) },
    ...over,
  }
  const claude = createClaudeAppAdapter({ ...deps, inFront: () => true })
  const adapters: HostAdapter[] = [
    createHerdrAdapter({ ...deps, client: herdrClient, front: () => undefined }),
    createWeztermAdapter(deps),
    { ...createOrcaAdapter(deps), focus: (pane) => { switched.push(pane.id); return deps.orcaSwitch(pane.id) } },
    claude,
    createCodexAppAdapter({ ...deps, inFront: () => true }),
    createTabsAdapter({ isOpen: () => false, select: () => false }),
    ...more,
  ]
  const opener = createOpenActions({
    run: deps.run, platform: deps.platform, adapters, log: deps.log, bin: deps.bin, herdrApp: deps.herdrApp, raise: deps.raise, windowOf: deps.windowOf,
    windows: deps.windows,
  })
  return { calls, switched, logs, claude, opener }
}

/** The adapters whose pane a tap takes, in the order the observed source keeps them: each reads the hints alone. */
const inert: OrcaDeps = { run: async () => ({ code: 0, stdout: '' }), onPath: () => null, exists: () => false, platform: 'darwin' }
const tapped = [createHerdrAdapter({ ...inert, client: herdrClient, front: () => undefined }), createWeztermAdapter(inert), createOrcaAdapter(inert), createClaudeAppAdapter({ ...inert, inFront: () => true })]

/** What an agent's hook hints let a tap open, as the observed source reads them. */
const target = (hints: Record<string, string>): OpenTarget => {
  const place = { host: detectHost(hints), app: detectApp(hints), hints }
  return { bundle: bundleOf(place.host, hints), pane: tapped.map((adapter) => adapter.paneOf(place)).find((pane) => pane) }
}
const run = (file: string, ...args: string[]): Call => ({ file, args, timeoutMs: 10_000 })
const forward = (bundle: string): Call => run(OPEN, '-b', bundle)
/** On Linux, asking whether a link's scheme has an app (appLink.ts): the recorder answers none, so nothing opens. */
const lookup = (scheme: string): Call => run('/fake/bin/xdg-mime', 'query', 'default', `x-scheme-handler/${scheme}`)

describe('opening an agent outside Harness from the dial', () => {
  it('Orca: its terminal is switched to, then Orca comes forward', async () => {
    const { calls, switched, opener } = recorder()
    const orca = target({ ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE })
    expect(opener.can(orca)).toBe(true)
    expect(await opener.open('a1', orca)).toBe(true)
    expect(switched).toEqual([HANDLE])
    expect(calls).toEqual([forward('com.stablyai.orca')])
  })

  it('the Claude app: its session through claude://code/continue, which brings the app forward itself', async () => {
    const { calls, opener } = recorder()
    const app = target({ __CFBundleIdentifier: CLAUDE, CLAUDE_CODE_HOST_SESSION_ID: SESSION })
    expect(opener.can(app)).toBe(true)
    expect(await opener.open('a1', app)).toBe(true)
    expect(calls).toEqual([run(OPEN, '-b', CLAUDE, `claude://code/continue?session=${SESSION}`)])
  })

  it('the Claude app: a link and an app that both fail run open -b once, said in one line', async () => {
    const { calls, logs, opener } = recorder({}, [1, 1])
    const app = target({ __CFBundleIdentifier: CLAUDE, CLAUDE_CODE_HOST_SESSION_ID: SESSION })
    expect(await opener.open('a1', app)).toBe(false)
    expect(calls).toEqual([run(OPEN, '-b', CLAUDE, `claude://code/continue?session=${SESSION}`), forward(CLAUDE)])
    expect(logs).toEqual(['[device] open · claude · fallback'])
  })

  // As the observed source builds it before the first hook: the pane its record gave, and its adapter's bundle
  // (observed.ts target(); docs/plans/2026-11-18-dial-claude-app-swipe-before-hook-design.md).
  it('a Claude app session only the scan found opens by its link, and still gets its app when the link fails', async () => {
    const scanned: OpenTarget = { bundle: CLAUDE, pane: { adapter: 'claude', id: SESSION } }
    const link = run(OPEN, '-b', CLAUDE, `claude://code/continue?session=${SESSION}`)
    const ok = recorder()
    expect(ok.opener.can(scanned)).toBe(true)
    expect(await ok.opener.open('a1', scanned)).toBe(true)
    expect(ok.calls).toEqual([link])
    expect(ok.logs).toEqual([])

    const failed = recorder({}, [1])
    expect(await failed.opener.open('a1', scanned)).toBe(true)
    expect(failed.calls).toEqual([link, forward(CLAUDE)])
    expect(failed.logs).toEqual(['[device] open · claude · fallback'])
  })

  it('WezTerm: its pane is activated, then WezTerm comes forward', async () => {
    const { calls, opener } = recorder()
    expect(await opener.open('a1', target({ WEZTERM_PANE: '7' }))).toBe(true)
    expect(calls).toEqual([run('/fake/bin/wezterm', 'cli', '--no-auto-start', 'activate-pane', '--pane-id', '7'), forward('com.github.wez.wezterm')])
  })

  it('WezTerm\'s own binary is used on macOS when PATH has none', async () => {
    const looked: string[] = []
    const { calls, opener } = recorder({ onPath: () => null, exists: (path) => { looked.push(path); return path === APP_WEZTERM } })
    expect(await opener.open('a1', target({ WEZTERM_PANE: '7' }))).toBe(true)
    expect(calls).toEqual([run(APP_WEZTERM, 'cli', '--no-auto-start', 'activate-pane', '--pane-id', '7'), forward('com.github.wez.wezterm')])
    expect(looked).toEqual([APP_WEZTERM])
  })

  it('herdr: its agent is focused, then the app it runs in comes forward', async () => {
    const own = recorder()
    expect(await own.opener.open('a1', target({ HERDR_PANE_ID: 'w1:p2' }))).toBe(true)
    expect(own.calls).toEqual([run('/fake/bin/herdr', 'agent', 'focus', 'w1:p2'), forward('dev.herdr.app')])
    // In Ghostty, Ghostty is the window to bring forward.
    const inGhostty = recorder()
    expect(await inGhostty.opener.open('a1', target({ HERDR_PANE_ID: 'w1:p2', __CFBundleIdentifier: 'com.mitchellh.ghostty' }))).toBe(true)
    expect(inGhostty.calls).toEqual([run('/fake/bin/herdr', 'agent', 'focus', 'w1:p2'), forward('com.mitchellh.ghostty')])
  })

  it.each([
    ['Terminal', { TERM_PROGRAM: 'Apple_Terminal' }, 'com.apple.Terminal'],
    ['iTerm2', { TERM_PROGRAM: 'iTerm.app' }, 'com.googlecode.iterm2'],
    ['Ghostty', { TERM_PROGRAM: 'ghostty' }, 'com.mitchellh.ghostty'],
    ['kitty', { KITTY_WINDOW_ID: '3' }, 'net.kovidgoyal.kitty'],
    ['VS Code', { TERM_PROGRAM: 'vscode' }, 'com.microsoft.VSCode'],
    ['Cursor', { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.todesktop.230313mzl4w4u92' }, 'com.todesktop.230313mzl4w4u92'],
    ['Warp', { TERM_PROGRAM: 'WarpTerminal' }, 'dev.warp.Warp-Stable'],
    ['Alacritty', { __CFBundleIdentifier: 'org.alacritty' }, 'org.alacritty'],
    ['WezTerm with no pane', { __CFBundleIdentifier: 'com.github.wez.wezterm' }, 'com.github.wez.wezterm'],
    ['the Claude app with no session', { __CFBundleIdentifier: CLAUDE }, CLAUDE],
    ['Zellij in Ghostty', { ZELLIJ: '0', __CFBundleIdentifier: 'com.mitchellh.ghostty' }, 'com.mitchellh.ghostty'],
    ['tmux in iTerm2', { TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'com.googlecode.iterm2' }, 'com.googlecode.iterm2'],
  ])('%s comes forward by its bundle id', async (_app, hints, bundle) => {
    const { calls, switched, opener } = recorder()
    expect(opener.can(target(hints))).toBe(true)
    expect(await opener.open('a1', target(hints))).toBe(true)
    expect(calls).toEqual([forward(bundle)])
    expect(switched).toEqual([])
  })

  // hc's terminals carry whatever bundle id the process that started Herdr Core had: Ghostty's or Orca's would raise that
  // app over Herdr's window.
  it('an agent in Herdr brings Herdr, whatever bundle id its terminal inherited; one started from it brings its own app', () => {
    for (const bundle of [undefined, 'com.mitchellh.ghostty', 'com.stablyai.orca', 'dev.herdr.core']) {
      const hints = { HC_TERMINAL_ID: 't7', TERM_PROGRAM: 'ghostty', ...(bundle ? { __CFBundleIdentifier: bundle } : {}) }
      expect(bundleOf(detectHost(hints), hints), String(bundle)).toBe('dev.herdr.app')
    }
    const vscode = { HC_TERMINAL_ID: 't3', TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.microsoft.VSCode' }
    expect(bundleOf(detectHost(vscode), vscode)).toBe('com.microsoft.VSCode')
  })

  // cmux is built on Ghostty, and its terminals may carry Ghostty's bundle id: after a failed cmux link, Ghostty would
  // come forward instead of cmux.
  it('an agent in cmux brings cmux, whatever bundle id its terminal carries', () => {
    const cmux = { CMUX_SURFACE_ID: '6F1C2B3A-4D5E-4F60-8172-93A4B5C6D7E8', CMUX_WORKSPACE_ID: '0A1B2C3D-4E5F-4061-8273-94A5B6C7D8E9' }
    for (const bundle of [undefined, 'com.mitchellh.ghostty', 'com.cmuxterm.app']) {
      const hints = { ...cmux, TERM_PROGRAM: 'ghostty', ...(bundle ? { __CFBundleIdentifier: bundle } : {}) }
      expect(bundleOf(detectHost(hints), hints), String(bundle)).toBe('com.cmuxterm.app')
    }
  })

  it('an app with no known bundle id opens nothing', async () => {
    const { calls, opener } = recorder()
    const none: Array<Record<string, string>> = [{}, { TERM_PROGRAM: 'tmux' }, { ZELLIJ: '0' }, { REX_BLOCK: 'x' }, { __CFBundleIdentifier: 'com.example.unknown' }]
    for (const hints of none) {
      expect(opener.can(target(hints)), JSON.stringify(hints)).toBe(false)
      expect(await opener.open('a1', target(hints))).toBe(false)
    }
    expect(calls).toEqual([])
  })

  // The Claude app's continue link is read from the app, not published: it may change with any release.
  it('a pane not reached still brings its app forward, and says so in one line with no session id, handle or pane', async () => {
    const link = recorder({}, [1])
    expect(await link.opener.open('a1', target({ __CFBundleIdentifier: CLAUDE, CLAUDE_CODE_HOST_SESSION_ID: SESSION }))).toBe(true)
    expect(link.calls).toEqual([run(OPEN, '-b', CLAUDE, `claude://code/continue?session=${SESSION}`), forward(CLAUDE)])
    expect(link.logs).toEqual(['[device] open · claude · fallback'])

    const wezterm = recorder({}, [1])
    expect(await wezterm.opener.open('a1', target({ WEZTERM_PANE: '7' }))).toBe(true)
    expect(wezterm.calls).toEqual([run('/fake/bin/wezterm', 'cli', '--no-auto-start', 'activate-pane', '--pane-id', '7'), forward('com.github.wez.wezterm')])
    expect(wezterm.logs).toEqual(['[device] open · wezterm · fallback'])

    // A command it could not start has no exit code.
    const herdr = recorder({}, [null])
    expect(await herdr.opener.open('a1', target({ HERDR_PANE_ID: 'w1:p2' }))).toBe(true)
    expect(herdr.calls).toEqual([run('/fake/bin/herdr', 'agent', 'focus', 'w1:p2'), forward('dev.herdr.app')])
    expect(herdr.logs).toEqual(['[device] open · herdr · fallback'])

    const orca = recorder({ orcaSwitch: async () => false })
    expect(await orca.opener.open('a1', target({ ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE }))).toBe(true)
    expect(orca.calls).toEqual([forward('com.stablyai.orca')])
    expect(orca.logs).toEqual(['[device] open · orca · fallback'])

    // No herdr or wezterm to run: the app alone.
    const none = recorder({ onPath: () => null })
    expect(await none.opener.open('a1', target({ HERDR_PANE_ID: 'w1:p2' }))).toBe(true)
    expect(await none.opener.open('a2', target({ WEZTERM_PANE: '7' }))).toBe(true)
    expect(none.calls).toEqual([forward('dev.herdr.app'), forward('com.github.wez.wezterm')])
    expect(none.logs).toEqual(['[device] open · herdr · fallback', '[device] open · wezterm · fallback'])

    for (const line of [...link.logs, ...wezterm.logs, ...herdr.logs, ...orca.logs]) {
      for (const id of [SESSION, HANDLE, 'w1:p2', '7', '/']) expect(line).not.toContain(id)
    }
  })

  it('false when the app does not come forward either; a pane with no app to bring forward is false when not reached', async () => {
    const both = recorder({}, [1, 1])
    expect(await both.opener.open('a1', target({ WEZTERM_PANE: '7' }))).toBe(false)
    expect(both.calls).toHaveLength(2)
    const app = recorder({}, [1])
    expect(await app.opener.open('a1', target({ TERM_PROGRAM: 'WarpTerminal' }))).toBe(false)
    // An Orca terminal no hint names the app of.
    const bare = recorder({ orcaSwitch: async () => false })
    const handleOnly = target({ ORCA_TERMINAL_HANDLE: HANDLE })
    expect(bare.opener.can(handleOnly)).toBe(true)
    expect(await bare.opener.open('a1', handleOnly)).toBe(false)
    expect(bare.calls).toEqual([])
    expect(bare.logs).toEqual([])
    // Reached, it is true with nothing more to run.
    const reached = recorder()
    expect(await reached.opener.open('a1', handleOnly)).toBe(true)
    expect(reached.switched).toEqual([HANDLE])
    expect(reached.calls).toEqual([])
  })

  it('a hint not in its own form never reaches a command', async () => {
    const bad: Array<[string, string]> = [
      ['WEZTERM_PANE', '7; rm -rf /'], ['WEZTERM_PANE', '--help'], ['WEZTERM_PANE', '-1'], ['WEZTERM_PANE', '7 '], ['WEZTERM_PANE', '1234567890'],
      ['HERDR_PANE_ID', '--help'], ['HERDR_PANE_ID', 'w1:p1; rm -rf /'], ['HERDR_PANE_ID', 'w1'], ['HERDR_PANE_ID', ' w1:p1'], ['HERDR_PANE_ID', 'w1:t1'],
      ['CLAUDE_CODE_HOST_SESSION_ID', 'local_'], ['CLAUDE_CODE_HOST_SESSION_ID', 'local_a/b'], ['CLAUDE_CODE_HOST_SESSION_ID', 'local_x&source=y'],
      ['CLAUDE_CODE_HOST_SESSION_ID', `local_${'a'.repeat(65)}`], ['CLAUDE_CODE_HOST_SESSION_ID', 'session_abc'], ['CLAUDE_CODE_HOST_SESSION_ID', '--args'],
      ['ORCA_TERMINAL_HANDLE', 'term_0f8e2c1a'], ['ORCA_TERMINAL_HANDLE', `${HANDLE}; rm -rf /`],
      ['__CFBundleIdentifier', '-a'], ['__CFBundleIdentifier', 'com.example.evil'],
    ]
    for (const [name, value] of bad) {
      const { calls, switched, opener } = recorder()
      // Beside the Claude app's own id, so a session is taken only for the app.
      const hints = { [name]: value, ...(name === 'CLAUDE_CODE_HOST_SESSION_ID' ? { __CFBundleIdentifier: CLAUDE } : {}) }
      await opener.open('a1', target(hints))
      expect(JSON.stringify(calls), `${name}=${value}`).not.toContain(value)
      expect(switched).toEqual([])
    }
  })

  it('a Claude session outside the Claude app opens no link', async () => {
    const { calls, opener } = recorder()
    expect(await opener.open('a1', target({ TERM_PROGRAM: 'ghostty', CLAUDE_CODE_HOST_SESSION_ID: SESSION }))).toBe(true)
    expect(calls).toEqual([forward('com.mitchellh.ghostty')])
  })

  it('on Linux only the exact pane, never open', async () => {
    const linux = recorder({ platform: 'linux', exists: () => true })
    expect(await linux.opener.open('a1', target({ ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE }))).toBe(true)
    expect(await linux.opener.open('a2', target({ WEZTERM_PANE: '7' }))).toBe(true)
    expect(await linux.opener.open('a3', target({ HERDR_PANE_ID: 'w1:p2' }))).toBe(true)
    expect(linux.switched).toEqual([HANDLE])
    expect(linux.calls).toEqual([run('/fake/bin/wezterm', 'cli', '--no-auto-start', 'activate-pane', '--pane-id', '7'), run('/fake/bin/herdr', 'agent', 'focus', 'w1:p2')])
    const appsOnly: Array<Record<string, string>> = [
      { TERM_PROGRAM: 'WarpTerminal' }, { __CFBundleIdentifier: 'org.alacritty' }, { __CFBundleIdentifier: CLAUDE, CLAUDE_CODE_HOST_SESSION_ID: SESSION },
    ]
    for (const hints of appsOnly) {
      expect(linux.opener.can(target(hints))).toBe(false)
      expect(await linux.opener.open('a4', target(hints))).toBe(false)
    }
    expect(linux.calls).toEqual([
      run('/fake/bin/wezterm', 'cli', '--no-auto-start', 'activate-pane', '--pane-id', '7'), run('/fake/bin/herdr', 'agent', 'focus', 'w1:p2'), lookup('claude'),
    ])

    // Not reached, nothing comes forward and nothing is said; the macOS app's own wezterm is never looked for.
    const failed = recorder({ platform: 'linux', onPath: () => null, exists: () => true, orcaSwitch: async () => false })
    expect(await failed.opener.open('a1', target({ WEZTERM_PANE: '7' }))).toBe(false)
    expect(await failed.opener.open('a2', target({ ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE }))).toBe(false)
    expect(failed.calls).toEqual([])
    expect(failed.logs).toEqual([])
  })

  it('Harness Desktop comes forward by its bundle id, on macOS only', async () => {
    const { calls, opener } = recorder({}, [0, 1])
    expect(await opener.desktop!()).toBe(true)
    expect(await opener.desktop!()).toBe(false)
    expect(calls).toEqual([forward('ai.autonomous.harness'), forward('ai.autonomous.harness')])
    expect(recorder({ platform: 'linux' }).opener.desktop).toBeUndefined()
  })

  it('one command at a time per agent; another agent\'s runs', async () => {
    const calls: string[][] = []
    const waiting: Array<() => void> = []
    const opener = createOpenActions({
      run: (_file, args) => {
        calls.push(args)
        return new Promise((resolve) => waiting.push(() => resolve({ code: 0, stdout: '' })))
      },
      platform: 'darwin',
      adapters: [],
      log: () => {},
    })
    const warp = target({ TERM_PROGRAM: 'WarpTerminal' })
    const first = opener.open('a1', warp)
    expect(await opener.open('a1', warp)).toBe(false)
    const other = opener.open('a2', warp)
    expect(calls).toHaveLength(2)
    for (const done of waiting) done()
    expect(await first).toBe(true)
    expect(await other).toBe(true)
    // Once its command has ended, the agent takes the next one.
    const next = opener.open('a1', warp)
    waiting[2]()
    expect(await next).toBe(true)
  })
})

// A rest's link is the Claude app adapter's own (claudeApp.spec.ts); a tap's one-at-a-time is the opener's.
describe('a rest on a Claude app session', () => {
  const link = (session: string): Call => run(OPEN, '-b', CLAUDE, `claude://code/continue?session=${session}`)

  /** The recorder, each command held until it is let go, so a link can be caught still running. */
  function holding() {
    const calls: Call[] = []
    const waiting: Array<() => void> = []
    const { claude, opener } = recorder({
      run: (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        return new Promise((resolve) => waiting.push(() => resolve({ code: 0, stdout: '' })))
      },
    })
    return { calls, waiting, claude, opener }
  }

  it('a tap is not refused while a rest\'s link runs, and a rest is not busy while a tap runs', async () => {
    const { calls, waiting, claude, opener } = holding()
    const app = target({ __CFBundleIdentifier: CLAUDE, CLAUDE_CODE_HOST_SESSION_ID: SESSION })
    const rest = claude.show({ adapter: 'claude', id: SESSION }, 'a1')
    const tap = opener.open('a1', app)
    expect(calls).toEqual([link(SESSION), link(SESSION)])
    for (const done of waiting.splice(0)) done()
    expect(await rest).toBe('ok')
    expect(await tap).toBe(true)

    const tapFirst = opener.open('a1', app)
    const restAfter = claude.show({ adapter: 'claude', id: SESSION }, 'a1')
    expect(calls).toEqual([link(SESSION), link(SESSION), link(SESSION), link(SESSION)])
    for (const done of waiting.splice(0)) done()
    expect(await tapFirst).toBe(true)
    expect(await restAfter).toBe('ok')
  })
})

// The Codex app's pane comes from the app, the engine and the session id (codexApp.ts), not from hints, so its targets
// are written here as the observed source builds them: a hook's has the app's bundle, a scan's none until its first hook.
describe('a tap on a Codex app session', () => {
  const pane: Pane = { adapter: 'codex', id: THREAD }
  const hooked: OpenTarget = { bundle: CODEX_APP, pane }
  const scanned: OpenTarget = { pane }
  const link = run(OPEN, '-b', CODEX_APP, `codex://threads/${THREAD}`)
  const FALLBACK = '[device] open · codex · fallback'

  it('the Codex app: its thread through codex://threads, which brings the app forward itself', async () => {
    for (const app of [hooked, scanned]) {
      const { calls, logs, opener } = recorder()
      expect(opener.can(app)).toBe(true)
      expect(await opener.open('a1', app)).toBe(true)
      expect(calls).toEqual([link])
      expect(logs).toEqual([])
    }
  })

  it('a Codex pane whose link failed and whose app came forward runs no second open -b', async () => {
    const { calls, logs, opener } = recorder({}, [1])
    expect(await opener.open('a1', hooked)).toBe(true)
    expect(calls).toEqual([link, forward(CODEX_APP)])
    expect(logs).toEqual([FALLBACK])
  })

  it('a Codex session only the scan found still gets its app when its link fails', async () => {
    const { calls, logs, opener } = recorder({}, [1])
    expect(await opener.open('a1', scanned)).toBe(true)
    expect(calls).toEqual([link, forward(CODEX_APP)])
    expect(logs).toEqual([FALLBACK])
  })

  // Rare and harmless (spec, Decided 9): the opener is not taught about the Codex adapter's own forward.
  it('the link and the adapter\'s own open -b both failed', async () => {
    const hook = recorder({}, [1, 1])
    expect(await hook.opener.open('a1', hooked)).toBe(true)
    expect(hook.calls).toEqual([link, forward(CODEX_APP), forward(CODEX_APP)])
    expect(hook.logs).toEqual([FALLBACK, FALLBACK])

    // No bundle, so the opener has no app to bring.
    const scan = recorder({}, [1, 1])
    expect(await scan.opener.open('a1', scanned)).toBe(false)
    expect(scan.calls).toEqual([link, forward(CODEX_APP)])
    expect(scan.logs).toEqual([FALLBACK])

    for (const line of [...hook.logs, ...scan.logs]) expect(line).not.toContain(THREAD)
  })

  it('on Linux a Codex pane opens nothing', async () => {
    const { calls, logs, opener } = recorder({ platform: 'linux' })
    for (const app of [hooked, scanned]) {
      expect(opener.can(app)).toBe(false)
      expect(await opener.open('a1', app)).toBe(false)
    }
    expect(calls).toEqual([lookup('codex')])
    expect(logs).toEqual([])
  })
})

// Each app says where its pane comes in a tap (adapter.ts `tap`): the opener keeps that order, knowing no app by name.
describe('a tap in the order its pane\'s adapter keeps', () => {
  const PANE: Pane = { adapter: 'made-up', id: 'p1' }
  const TERMINAL = 'com.apple.Terminal'
  const both: OpenTarget = { bundle: TERMINAL, pane: PANE }

  /** The recorder, its opener holding one app more that no other test knows: its focus answers as told, and notes the
   *  commands run before it; each command answers the next of [codes]. */
  function withMadeUp(tap: HostAdapter['tap'], focused: boolean | 'refused' = true, codes: Array<number | null> = []) {
    const before: Call[][] = []
    const adapter = {
      id: 'made-up',
      tap,
      paneOf: () => PANE,
      canFocus: () => true,
      focus: vi.fn(async (_pane: Pane) => { before.push([...r.calls]); return focused }),
    }
    const r = recorder({}, codes, [adapter])
    return { ...r, adapter, before }
  }

  it('a pane that taps before its app: its focus, then open -b; its focus failing, the line and open -b', async () => {
    const reached = withMadeUp('before')
    expect(await reached.opener.open('a1', both)).toBe(true)
    expect(reached.adapter.focus.mock.calls).toEqual([[PANE]])
    expect(reached.before).toEqual([[]])
    expect(reached.calls).toEqual([forward(TERMINAL)])
    expect(reached.logs).toEqual([])

    const failed = withMadeUp('before', false)
    expect(await failed.opener.open('a1', both)).toBe(true)
    expect(failed.before).toEqual([[]])
    expect(failed.calls).toEqual([forward(TERMINAL)])
    expect(failed.logs).toEqual(['[device] open · made-up · fallback'])
  })

  it('a pane that taps instead of its app: its focus alone; open -b and the line only when it fails', async () => {
    const reached = withMadeUp('instead')
    expect(await reached.opener.open('a1', both)).toBe(true)
    expect(reached.adapter.focus.mock.calls).toEqual([[PANE]])
    expect(reached.calls).toEqual([])
    expect(reached.logs).toEqual([])

    const failed = withMadeUp('instead', false)
    expect(await failed.opener.open('a1', both)).toBe(true)
    expect(failed.before).toEqual([[]])
    expect(failed.calls).toEqual([forward(TERMINAL)])
    expect(failed.logs).toEqual(['[device] open · made-up · fallback'])
  })

  // The adapter said why in a line of its own (tmux: "not its pane"): the opener adds none, and the app still comes.
  it('a pane its adapter refuses: open -b alone and no fallback line; false with no app, or when the app does not come', async () => {
    const refused = withMadeUp('before', 'refused')
    expect(await refused.opener.open('a1', both)).toBe(true)
    expect(refused.adapter.focus.mock.calls).toEqual([[PANE]])
    expect(refused.calls).toEqual([forward(TERMINAL)])
    expect(refused.logs).toEqual([])
    const bare = withMadeUp('before', 'refused')
    expect(await bare.opener.open('a1', { pane: PANE })).toBe(false)
    expect(bare.calls).toEqual([])
    const instead = withMadeUp('instead', 'refused')
    expect(await instead.opener.open('a1', both)).toBe(true)
    expect(instead.calls).toEqual([forward(TERMINAL)])
    expect(instead.logs).toEqual([])
    const stuck = withMadeUp('before', 'refused', [1])
    expect(await stuck.opener.open('a1', both)).toBe(false)
  })

  // Its pane is raised once its app came (observed.ts focus): the opener brings the app alone.
  it('a pane that taps after its app is not the opener\'s', async () => {
    const r = withMadeUp('after')
    expect(r.opener.can(both)).toBe(true)
    expect(await r.opener.open('a1', both)).toBe(true)
    expect(r.calls).toEqual([forward(TERMINAL)])
    expect(r.logs).toEqual([])
    expect(r.opener.can({ pane: PANE })).toBe(false)
    expect(await r.opener.open('a1', { pane: PANE })).toBe(false)
    expect(r.calls).toHaveLength(1)
    expect(r.adapter.focus).not.toHaveBeenCalled()
  })

  // A list built wrong at the wiring: nothing throws, and the app alone comes forward.
  it('a pane of an adapter the opener does not hold is no pane', async () => {
    const r = recorder()
    expect(await r.opener.open('a1', both)).toBe(true)
    expect(r.calls).toEqual([forward(TERMINAL)])
    expect(r.logs).toEqual([])
    expect(r.opener.can({ pane: PANE })).toBe(false)
    expect(await r.opener.open('a1', { pane: PANE })).toBe(false)
    expect(r.calls).toHaveLength(1)
    expect(r.switched).toEqual([])
  })
})

// Linux has no `open -b`: the window comes forward through the raise (linuxRaise.ts) where macOS brings the app.
describe('a tap on Linux brings the window forward through the raise', () => {
  const WEZTERM = target({ WEZTERM_PANE: '7' })
  const ACTIVATE = run('/fake/bin/wezterm', 'cli', '--no-auto-start', 'activate-pane', '--pane-id', '7')
  const WARP = target({ TERM_PROGRAM: 'WarpTerminal' })
  const PANE: Pane = { adapter: 'made-up', id: 'p1' }

  /** The recorder on Linux, its opener holding a raise that found a desktop or not, and each agent's window as the
   *  observed source knows it: each raise notes its window with the commands run before it, and answers the next of
   *  [raises], then true. */
  function onLinux(o: { windows?: Record<string, Window>; raises?: boolean[]; ready?: boolean; codes?: Array<number | null>; more?: readonly HostAdapter[] } = {}) {
    const raised: Array<{ window: Window; ran: Call[] }> = []
    const raises = [...(o.raises ?? [])]
    const windows = o.windows ?? { a1: { pid: 4242, app: 'wezterm' } }
    const raise: LinuxRaise = {
      ready: () => o.ready ?? true,
      raise: async (window) => { raised.push({ window, ran: [...r.calls] }); return raises.length ? raises.shift()! : true },
    }
    const r = recorder({ platform: 'linux', raise, windowOf: (agentId) => windows[agentId] }, o.codes, o.more)
    return { ...r, raised, windows: () => raised.map(({ window }) => window) }
  }

  /** An app no other test knows: its focus answers as told, and the process whose window holds its pane is [windowPid]. */
  const madeUp = (tap: HostAdapter['tap'], focused: boolean | 'refused', windowPid?: number) => ({
    id: 'made-up',
    tap,
    paneOf: () => PANE,
    canFocus: () => true,
    focus: vi.fn(async (_pane: Pane) => focused),
    windowPid: vi.fn((_pane: Pane) => windowPid),
  })

  it('Linux: a pane that comes before its app is followed by the raise, with the agent\'s process and app', async () => {
    const r = onLinux()
    expect(r.opener.can(WEZTERM)).toBe(true)
    expect(await r.opener.open('a1', WEZTERM)).toBe(true)
    expect(r.calls).toEqual([ACTIVATE])
    expect(r.raised).toEqual([{ window: { pid: 4242, app: 'wezterm' }, ran: [ACTIVATE] }])
    expect(r.logs).toEqual([])
    // The pane came: the tap is true whatever the raise did.
    const unraised = onLinux({ raises: [false] })
    expect(await unraised.opener.open('a1', WEZTERM)).toBe(true)
    expect(unraised.windows()).toEqual([{ pid: 4242, app: 'wezterm' }])
  })

  it('Linux: tmux\'s switched client is the process whose window is raised', async () => {
    const windows = { a1: { pid: 4242, app: 'ghostty' } }
    const switched = madeUp('before', true, 5150)
    const client = onLinux({ windows, more: [switched] })
    expect(await client.opener.open('a1', { pane: PANE })).toBe(true)
    expect(switched.windowPid.mock.calls).toEqual([[PANE]])
    expect(client.windows()).toEqual([{ pid: 5150, app: 'ghostty' }])
    // A switch that kept no client: the agent's own window.
    const kept = onLinux({ windows, more: [madeUp('before', true)] })
    expect(await kept.opener.open('a1', { pane: PANE })).toBe(true)
    expect(kept.windows()).toEqual([{ pid: 4242, app: 'ghostty' }])
    // A focus that failed switched no client: its window is not asked.
    const failed = madeUp('before', false, 5150)
    const fallback = onLinux({ windows, more: [failed] })
    expect(await fallback.opener.open('a1', { pane: PANE })).toBe(true)
    expect(failed.windowPid).not.toHaveBeenCalled()
    expect(fallback.windows()).toEqual([{ pid: 4242, app: 'ghostty' }])
  })

  it('Linux: an agent with no pane is raised by its process, and the tap answers what the raise did', async () => {
    const r = onLinux({ windows: { a1: { pid: 4242, app: 'warp' } }, raises: [true, false] })
    expect(r.opener.can(WARP)).toBe(true)
    expect(await r.opener.open('a1', WARP)).toBe(true)
    expect(await r.opener.open('a1', WARP)).toBe(false)
    expect(r.windows()).toEqual([{ pid: 4242, app: 'warp' }, { pid: 4242, app: 'warp' }])
    expect(r.calls).toEqual([])
    expect(r.logs).toEqual([])
  })

  it('Linux: a pane that failed logs the fallback and raises; one that refused raises with no line', async () => {
    const failed = onLinux({ codes: [1], raises: [false] })
    expect(await failed.opener.open('a1', WEZTERM)).toBe(false)
    expect(failed.raised).toEqual([{ window: { pid: 4242, app: 'wezterm' }, ran: [ACTIVATE] }])
    expect(failed.logs).toEqual(['[device] open · wezterm · fallback'])
    const raised = onLinux({ codes: [1] })
    expect(await raised.opener.open('a1', WEZTERM)).toBe(true)
    expect(raised.logs).toEqual(['[device] open · wezterm · fallback'])

    const refused = onLinux({ more: [madeUp('before', 'refused', 5150)] })
    expect(await refused.opener.open('a1', { pane: PANE })).toBe(true)
    expect(refused.windows()).toEqual([{ pid: 4242, app: 'wezterm' }])
    expect(refused.logs).toEqual([])
  })

  it('Linux: a link\'s pane raises nothing after it', async () => {
    const r = onLinux({ more: [madeUp('instead', true)] })
    expect(await r.opener.open('a1', { pane: PANE })).toBe(true)
    expect(r.raised).toEqual([])
  })

  it('Linux: can() is the pane or a desktop found', async () => {
    const none = onLinux({ ready: false })
    expect(none.opener.can(WEZTERM)).toBe(true)
    expect(none.opener.can(WARP)).toBe(false)
    expect(none.opener.can({})).toBe(false)
    expect(await none.opener.open('a1', WARP)).toBe(false)
    expect(none.raised).toEqual([])
    const found = onLinux()
    expect(found.opener.can(WARP)).toBe(true)
    expect(found.opener.can({})).toBe(true)
  })

  // On GNOME the raise takes an app's class alone: an agent in an app with none would answer false at every tap.
  it('Linux: can() asks the raise for an agent\'s window in the app its bundle names', () => {
    const asked: Array<{ agent: boolean; app?: string }> = []
    const r = recorder({
      platform: 'linux',
      raise: { ready: (window) => { asked.push(window); return window?.app === 'kitty' }, raise: async () => true },
    })
    expect(r.opener.can(target({ KITTY_WINDOW_ID: '1' }))).toBe(true)
    expect(r.opener.can(WARP)).toBe(false)
    expect(r.opener.can({})).toBe(false)
    expect(asked).toEqual([{ agent: true, app: 'kitty' }, { agent: true, app: 'warp' }, { agent: true }])
  })
})

// The last pick wins (docs/plans/2026-11-16-dial-pick-brings-app-design.md): the Mac's front app ends as the ring.
describe('a pick on the dial brings its app forward', () => {
  const VSCODE = 'com.microsoft.VSCode'
  const GHOSTTY = 'com.mitchellh.ghostty'

  /** An opener whose every command is held until it is let go with an exit code, or rejected. */
  function held() {
    const calls: Call[] = []
    const pending: Array<{ exit(code: number | null): void; reject(): void }> = []
    const opener = createOpenActions({
      run: (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        return new Promise((resolve, reject) => pending.push({ exit: (code) => resolve({ code, stdout: '' }), reject: () => reject(new Error('spawn')) }))
      },
      platform: 'darwin',
      adapters: [],
      log: () => {},
    })
    return { calls, pending, opener, bring: opener.bring! }
  }

  /** What a promise has answered once every pending callback has run, or 'waiting'. */
  async function settled<T>(promise: Promise<T>): Promise<T | 'waiting'> {
    let answer: T | 'waiting' = 'waiting'
    void promise.then((value) => { answer = value })
    await new Promise((resolve) => setImmediate(resolve))
    return answer
  }

  it('bring runs open -b with the app\'s bundle once and answers ok', async () => {
    const { calls, opener } = recorder()
    expect(await opener.bring!('vscode')).toBe('ok')
    expect(calls).toEqual([{ file: '/usr/bin/open', args: ['-b', VSCODE], timeoutMs: 10_000 }])
  })

  it('bring of Harness runs the open -b ai.autonomous.harness desktop runs', async () => {
    const { calls, opener } = recorder()
    expect(await opener.bring!('harness')).toBe('ok')
    await opener.desktop!()
    expect(calls).toEqual([forward('ai.autonomous.harness'), forward('ai.autonomous.harness')])
  })

  it('bring of herdr, of an app with no bundle and of a name no app has runs nothing', async () => {
    const { calls, opener } = recorder()
    for (const app of ['herdr', 'tmux', 'rex', 'zellij', 'terminal', 'constructor', '__proto__', 'toString']) {
      expect(await opener.bring!(app), app).toBeUndefined()
    }
    expect(calls).toEqual([])
  })

  // herdr's ring holds Herdr.app's agents too (docs/plans/2026-11-16-herdr-app-design.md): their window is Herdr's.
  it('bring of herdr runs open -b dev.herdr.app while Herdr.app is the ring\'s window, asked at each pick', async () => {
    let herdrApp = true
    const { calls, opener } = recorder({ herdrApp: () => herdrApp })
    expect(await opener.bring!('herdr')).toBe('ok')
    herdrApp = false
    expect(await opener.bring!('herdr')).toBeUndefined()
    expect(calls).toEqual([forward('dev.herdr.app')])
  })

  it('bring answers failed on exit 1, on a timeout (code null) and on a run that rejects, and runs once', async () => {
    for (const code of [1, null]) {
      const { calls, opener } = recorder({}, [code])
      expect(await opener.bring!('vscode')).toBe('failed')
      expect(calls).toEqual([forward(VSCODE)])
    }
    let runs = 0
    const { opener } = recorder({ run: async () => { runs += 1; throw new Error('spawn') } })
    expect(await opener.bring!('vscode')).toBe('failed')
    expect(runs).toBe(1)
  })

  it('a bring while none runs runs at once, and so does one after it has ended', async () => {
    const { calls, pending, bring } = held()
    const first = bring('vscode')
    expect(calls).toEqual([forward(VSCODE)])
    pending[0].exit(0)
    expect(await first).toBe('ok')
    void bring('ghostty')
    expect(calls).toEqual([forward(VSCODE), forward(GHOSTTY)])
  })

  it('picks A, B, A while A\'s first open runs: exactly two opens, A then A, and B never runs', async () => {
    const { calls, pending, bring } = held()
    const first = bring('vscode')
    const second = bring('ghostty')
    const third = bring('vscode')
    expect(calls).toEqual([forward(VSCODE)])
    expect(await settled(second)).toBeUndefined()
    expect(await settled(third)).toBe('waiting')
    pending[0].exit(0)
    expect(await first).toBe('ok')
    expect(calls).toEqual([forward(VSCODE), forward(VSCODE)])
    pending[1].exit(0)
    expect(await third).toBe('ok')
    expect(calls).toEqual([forward(VSCODE), forward(VSCODE)])
  })

  it('a failed run still runs the waiting one', async () => {
    for (const end of ['exit 1', 'reject'] as const) {
      const { calls, pending, bring } = held()
      const first = bring('vscode')
      const waiting = bring('ghostty')
      if (end === 'exit 1') pending[0].exit(1)
      else pending[0].reject()
      expect(await first, end).toBe('failed')
      expect(calls, end).toEqual([forward(VSCODE), forward(GHOSTTY)])
      pending[1].exit(0)
      expect(await waiting, end).toBe('ok')
    }
  })

  it('a bring with nothing to bring while one runs drops the waiting one', async () => {
    const { calls, pending, bring } = held()
    const first = bring('vscode')
    const waiting = bring('ghostty')
    const nothing = bring('tmux')
    expect(await settled(waiting)).toBeUndefined()
    expect(await settled(nothing)).toBeUndefined()
    pending[0].exit(0)
    expect(await first).toBe('ok')
    await settled(first)
    expect(calls).toEqual([forward(VSCODE)])
  })

  it('a tap while a bring runs opens its own app at once and drops the waiting bring; desktop() runs at once', async () => {
    const { calls, pending, opener, bring } = held()
    const first = bring('vscode')
    const waiting = bring('ghostty')
    const tap = opener.open('a1', { bundle: GHOSTTY })
    expect(calls).toEqual([forward(VSCODE), forward(GHOSTTY)])
    const desktop = opener.desktop!()
    expect(calls).toEqual([forward(VSCODE), forward(GHOSTTY), forward('ai.autonomous.harness')])
    expect(await settled(waiting)).toBeUndefined()
    for (const run of pending) run.exit(0)
    expect(await first).toBe('ok')
    expect(await tap).toBe(true)
    expect(await desktop).toBe(true)
    await settled(first)
    expect(calls).toHaveLength(3)
  })

  // A tap on a Harness agent with no window turns the dial to Harness's ring and starts Desktop by desktop(): a pick
  // waiting would come forward over Desktop and its settle turn the dial away.
  it('a tap\'s start of Desktop while a bring runs runs at once and drops the waiting bring', async () => {
    const { calls, pending, opener, bring } = held()
    const first = bring('vscode')
    const waiting = bring('ghostty')
    const desktop = opener.desktop!()
    expect(calls).toEqual([forward(VSCODE), forward('ai.autonomous.harness')])
    expect(await settled(waiting)).toBeUndefined()
    for (const run of pending) run.exit(0)
    expect(await first).toBe('ok')
    expect(await desktop).toBe(true)
    await settled(first)
    expect(calls).toHaveLength(2)
  })

  it('off macOS there is no bring', () => {
    const { opener } = recorder({ platform: 'linux' })
    expect(opener.bring).toBeUndefined()
    expect(opener.desktop).toBeUndefined()
  })

  it('Linux: a pick brings the app through the raise, one at a time, the last pick winning', async () => {
    const calls: Call[] = []
    const raised: Window[] = []
    const pending: Array<(raised: boolean) => void> = []
    const opener = createOpenActions({
      run: async (file, args, timeoutMs) => { calls.push({ file, args, timeoutMs }); return { code: 0, stdout: '' } },
      platform: 'linux',
      adapters: [],
      log: () => {},
      raise: { ready: () => true, raise: (window) => { raised.push(window); return new Promise((answer) => pending.push(answer)) } },
    })
    const bring = opener.bring!
    const first = bring('vscode')
    const second = bring('ghostty')
    const third = bring('harness')
    expect(raised).toEqual([{ app: 'vscode' }])
    expect(await settled(second)).toBeUndefined()
    expect(await settled(third)).toBe('waiting')
    pending[0](false)
    expect(await first).toBe('failed')
    expect(raised).toEqual([{ app: 'vscode' }, { app: 'harness' }])
    pending[1](true)
    expect(await third).toBe('ok')
    expect(calls).toEqual([])
    expect(opener.desktop).toBeUndefined()
  })

  // A pick has no process: only an app whose class the raise knows, on a desktop found, has a window to bring.
  it('Linux: a pick the raise cannot bring runs nothing and answers nothing', async () => {
    const raised: Window[] = []
    const asked: Array<{ agent: boolean; app?: string }> = []
    let found = true
    const { calls, opener } = recorder({
      platform: 'linux',
      raise: {
        ready: (window) => { asked.push(window); return found && window?.app === 'vscode' },
        raise: async (window) => { raised.push(window); return true },
      },
    })
    expect(await opener.bring!('warp')).toBeUndefined()
    expect(await opener.bring!('vscode')).toBe('ok')
    found = false
    expect(await opener.bring!('vscode')).toBeUndefined()
    expect(asked).toEqual([{ agent: false, app: 'warp' }, { agent: false, app: 'vscode' }, { agent: false, app: 'vscode' }])
    expect(raised).toEqual([{ app: 'vscode' }])
    expect(calls).toEqual([])
  })

  // herdr's agents have no window of their own, and Herdr.app is macOS's: herdr has no class.
  it('Linux: a pick of herdr runs nothing', async () => {
    // The raise itself, over a sway it found and the apps' own classes: only its backend is made up.
    const raised: RaiseTarget[] = []
    const raise = createLinuxRaise({
      find: async () => ({ kind: 'sway', socket: '/run/user/1000/sway-ipc.1000.7.sock' }),
      backend: () => ({ raise: async (target) => { raised.push(target); return true } }),
      processes: async () => [],
      classes: windowClasses,
      log: () => {},
    })
    await vi.waitFor(() => expect(raise.ready({ agent: false, app: 'vscode' })).toBe(true))
    const { calls, opener } = recorder({ platform: 'linux', herdrApp: () => true, raise })
    expect(await opener.bring!('herdr')).toBeUndefined()
    expect(raised).toEqual([])
    expect(calls).toEqual([])
  })

  it('an absolute bin is what a tap, desktop and bring run; unset, empty and relative run /usr/bin/open', async () => {
    const warp = target({ TERM_PROGRAM: 'WarpTerminal' })
    for (const [bin, file] of [['/tmp/e2e/fake-open', '/tmp/e2e/fake-open'], [undefined, OPEN], ['', OPEN], ['fake-open', OPEN], ['./fake-open', OPEN]] as const) {
      const { calls, opener } = recorder({ bin })
      expect(await opener.open('a1', warp)).toBe(true)
      expect(await opener.desktop!()).toBe(true)
      expect(await opener.bring!('vscode')).toBe('ok')
      expect(calls.map((call) => call.file), String(bin)).toEqual([file, file, file])
    }
  })
})

// Windows has no `open -b`: the app comes forward through the raise (windowsRaise.ts), where macOS opens its bundle.
describe('a tap on Windows brings the app forward through the raise', () => {
  const VSCODE = 'com.microsoft.VSCode'
  const WARP = target({ TERM_PROGRAM: 'WarpTerminal' })
  const ORCA = target({ ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE })

  /** The recorder on Windows, its opener holding a raise that notes each call, beside Orca's switch, in [asked], and
   *  answers the next of [answers] (true: raised or refused; false: none), then true. */
  function onWindows(answers: boolean[] = []) {
    const asked: string[][] = []
    const answer = async (call: string[]) => { asked.push(call); return answers.length ? answers.shift()! : true }
    const windows: WindowsRaise = {
      app: (bundle) => answer(['app', bundle]),
      link: (url, bundle) => answer(['link', url, String(bundle)]),
      cursorFolder: (folder) => answer(['cursorFolder', folder]),
      desktop: () => answer(['desktop']),
    }
    const orcaSwitch = async (handle: string) => { asked.push(['switch', handle]); return true }
    return { ...recorder({ platform: 'win32', windows, orcaSwitch }), asked }
  }

  /** The opener on Windows, each raise held until it is let go with its answer. */
  function held() {
    const asked: string[][] = []
    const pending: Array<(answer: boolean) => void> = []
    const answer = (call: string[]) => { asked.push(call); return new Promise<boolean>((resolve) => pending.push(resolve)) }
    const opener = createOpenActions({
      run: async () => ({ code: 0, stdout: '' }),
      platform: 'win32',
      adapters: [],
      log: () => {},
      windows: {
        app: (bundle) => answer(['app', bundle]),
        link: (url) => answer(['link', url]),
        cursorFolder: (folder) => answer(['cursorFolder', folder]),
        desktop: () => answer(['desktop']),
      },
    })
    return { asked, pending, opener }
  }

  async function settled<T>(promise: Promise<T>): Promise<T | 'waiting'> {
    let answer: T | 'waiting' = 'waiting'
    void promise.then((value) => { answer = value })
    await new Promise((resolve) => setImmediate(resolve))
    return answer
  }

  it('Orca: its terminal is switched to, then Orca comes forward by its bundle, and open never runs', async () => {
    const r = onWindows()
    expect(r.opener.can(ORCA)).toBe(true)
    expect(await r.opener.open('a1', ORCA)).toBe(true)
    expect(r.asked).toEqual([['switch', HANDLE], ['app', 'com.stablyai.orca']])
    expect(r.calls).toEqual([])
    // The pane came: the tap is done whatever the raise answered.
    const none = onWindows([false])
    expect(await none.opener.open('a1', ORCA)).toBe(true)
  })

  it('an agent with no pane brings its app, and the tap answers what the raise did: refused is done, none fails', async () => {
    const r = onWindows([true, false])
    expect(r.opener.can(WARP)).toBe(true)
    expect(await r.opener.open('a1', WARP)).toBe(true)
    expect(await r.opener.open('a1', WARP)).toBe(false)
    expect(r.asked).toEqual([['app', 'dev.warp.Warp-Stable'], ['app', 'dev.warp.Warp-Stable']])
    expect(r.calls).toEqual([])
    expect(r.logs).toEqual([])
  })

  it('a pick brings its app through the raise: ok for raised or refused, failed for none', async () => {
    const r = onWindows([true, false])
    expect(await r.opener.bring!('wezterm')).toBe('ok')
    expect(await r.opener.bring!('vscode')).toBe('failed')
    expect(r.asked).toEqual([['app', 'com.github.wez.wezterm'], ['app', VSCODE]])
    expect(r.calls).toEqual([])
  })

  it('a pick while one runs takes the waiting place, the last pick winning', async () => {
    const { asked, pending, opener } = held()
    const first = opener.bring!('vscode')
    const second = opener.bring!('cursor')
    const third = opener.bring!('wezterm')
    expect(asked).toEqual([['app', VSCODE]])
    expect(await settled(second)).toBeUndefined()
    pending[0](true)
    expect(await first).toBe('ok')
    expect(asked).toEqual([['app', VSCODE], ['app', 'com.github.wez.wezterm']])
    pending[1](false)
    expect(await third).toBe('failed')
  })

  it('desktop() starts Harness Desktop once, drops a waiting pick and answers what it answered; a pick of Harness is the same', async () => {
    const { asked, pending, opener } = held()
    const first = opener.bring!('vscode')
    const waiting = opener.bring!('cursor')
    const desktop = opener.desktop!()
    expect(asked).toEqual([['app', VSCODE], ['desktop']])
    expect(await settled(waiting)).toBeUndefined()
    pending[0](true)
    pending[1](false)
    expect(await first).toBe('ok')
    expect(await desktop).toBe(false)
    expect(asked).toHaveLength(2)

    const r = onWindows()
    expect(await r.opener.bring!('harness')).toBe('ok')
    expect(r.asked).toEqual([['desktop']])
  })

  it('a Codex app session opens by its link, sent to the app by its bundle', async () => {
    const r = onWindows()
    const codex = { bundle: CODEX_APP, pane: { adapter: 'codex', id: THREAD } }
    expect(r.opener.can(codex)).toBe(true)
    expect(await r.opener.open('a1', codex)).toBe(true)
    expect(r.asked).toEqual([['link', `codex://threads/${THREAD}`, CODEX_APP]])
    expect(r.calls).toEqual([])
  })

  it('with no raise, Windows answers as before: no app comes, and there is no desktop or bring', async () => {
    const { calls, opener } = recorder({ platform: 'win32' })
    expect(opener.can(WARP)).toBe(false)
    expect(await opener.open('a1', WARP)).toBe(false)
    expect(opener.desktop).toBeUndefined()
    expect(opener.bring).toBeUndefined()
    expect(calls).toEqual([])
  })
})
