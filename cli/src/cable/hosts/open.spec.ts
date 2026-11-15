import { describe, expect, it, vi } from 'vitest'
import type { HostAdapter, Pane } from './adapter.js'
import { createClaudeAppAdapter } from './claudeApp.js'
import { createHerdrAdapter } from './herdr.js'
import { detectApp, detectHost } from './hostDetect.js'
import { bundleOf, createOpenActions, type OpenTarget } from './open.js'
import { createOrcaAdapter, type OrcaDeps } from './orca.js'
import { createTabsAdapter } from './tabs.js'
import { createWeztermAdapter } from './wezterm.js'

const HANDLE = 'term_0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b'
const SESSION = 'local_8d1f2c3a-4b5e-4f60-9a7b-1c2d3e4f5a6b'
const CLAUDE = 'com.anthropic.claudefordesktop'
const OPEN = '/usr/bin/open'
const APP_WEZTERM = '/Applications/WezTerm.app/Contents/MacOS/wezterm'

interface Call { file: string; args: string[]; timeoutMs: number }

/** What a test may set: the runner and the binaries it finds, Orca's switch, and the log. */
interface Over extends OrcaDeps {
  orcaSwitch(handle: string): Promise<boolean>
  log(line: string): void
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
    createHerdrAdapter(deps),
    createWeztermAdapter(deps),
    { ...createOrcaAdapter(deps), focus: (pane) => { switched.push(pane.id); return deps.orcaSwitch(pane.id) } },
    claude,
    createTabsAdapter({ isOpen: () => false, select: () => false }),
    ...more,
  ]
  return { calls, switched, logs, claude, opener: createOpenActions({ run: deps.run, platform: deps.platform, adapters, log: deps.log }) }
}

/** The adapters whose pane a tap takes, in the order the observed source keeps them: each reads the hints alone. */
const inert: OrcaDeps = { run: async () => ({ code: 0, stdout: '' }), onPath: () => null, exists: () => false, platform: 'darwin' }
const tapped = [createHerdrAdapter(inert), createWeztermAdapter(inert), createOrcaAdapter(inert), createClaudeAppAdapter({ ...inert, inFront: () => true })]

/** What an agent's hook hints let a tap open, as the observed source reads them. */
const target = (hints: Record<string, string>): OpenTarget => {
  const place = { host: detectHost(hints), app: detectApp(hints), hints }
  return { bundle: bundleOf(place.host, hints), pane: tapped.map((adapter) => adapter.paneOf(place)).find((pane) => pane) }
}
const run = (file: string, ...args: string[]): Call => ({ file, args, timeoutMs: 10_000 })
const forward = (bundle: string): Call => run(OPEN, '-b', bundle)

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
    expect(calls).toEqual([run(OPEN, `claude://code/continue?session=${SESSION}`)])
  })

  it('WezTerm: its pane is activated, then WezTerm comes forward', async () => {
    const { calls, opener } = recorder()
    expect(await opener.open('a1', target({ WEZTERM_PANE: '7' }))).toBe(true)
    expect(calls).toEqual([run('/fake/bin/wezterm', 'cli', 'activate-pane', '--pane-id', '7'), forward('com.github.wez.wezterm')])
  })

  it('WezTerm\'s own binary is used on macOS when PATH has none', async () => {
    const looked: string[] = []
    const { calls, opener } = recorder({ onPath: () => null, exists: (path) => { looked.push(path); return path === APP_WEZTERM } })
    expect(await opener.open('a1', target({ WEZTERM_PANE: '7' }))).toBe(true)
    expect(calls).toEqual([run(APP_WEZTERM, 'cli', 'activate-pane', '--pane-id', '7'), forward('com.github.wez.wezterm')])
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
    expect(link.calls).toEqual([run(OPEN, `claude://code/continue?session=${SESSION}`), forward(CLAUDE)])
    expect(link.logs).toEqual(['[device] open · claude · fallback'])

    const wezterm = recorder({}, [1])
    expect(await wezterm.opener.open('a1', target({ WEZTERM_PANE: '7' }))).toBe(true)
    expect(wezterm.calls).toEqual([run('/fake/bin/wezterm', 'cli', 'activate-pane', '--pane-id', '7'), forward('com.github.wez.wezterm')])
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
    expect(linux.calls).toEqual([run('/fake/bin/wezterm', 'cli', 'activate-pane', '--pane-id', '7'), run('/fake/bin/herdr', 'agent', 'focus', 'w1:p2')])
    const appsOnly: Array<Record<string, string>> = [
      { TERM_PROGRAM: 'WarpTerminal' }, { __CFBundleIdentifier: 'org.alacritty' }, { __CFBundleIdentifier: CLAUDE, CLAUDE_CODE_HOST_SESSION_ID: SESSION },
    ]
    for (const hints of appsOnly) {
      expect(linux.opener.can(target(hints))).toBe(false)
      expect(await linux.opener.open('a4', target(hints))).toBe(false)
    }
    expect(linux.calls).toHaveLength(2)

    // Not reached, nothing comes forward and nothing is said; the macOS app's own wezterm is never looked for.
    const failed = recorder({ platform: 'linux', onPath: () => null, exists: () => true, orcaSwitch: async () => false })
    expect(await failed.opener.open('a1', target({ WEZTERM_PANE: '7' }))).toBe(false)
    expect(await failed.opener.open('a2', target({ ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE }))).toBe(false)
    expect(failed.calls).toEqual([])
    expect(failed.logs).toEqual([])
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
  const link = (session: string): Call => run(OPEN, `claude://code/continue?session=${session}`)

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
