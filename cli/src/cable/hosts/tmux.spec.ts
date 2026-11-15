import { describe, expect, it } from 'vitest'
import { detectApp, detectHost } from './hostDetect.js'
import { bundleOf, createOpenActions, type OpenTarget } from './open.js'
import { createTmuxAdapter, type TmuxDeps } from './tmux.js'

const OPEN = '/usr/bin/open'

interface Call { file: string; args: string[]; timeoutMs: number }

/** The agent (100) in its shell (90), the pane's process, under tmux's server (80). */
const TABLE = [{ pid: 100, ppid: 90 }, { pid: 90, ppid: 80 }, { pid: 80, ppid: 1 }, { pid: 4242, ppid: 1 }]

/** A recording runner that runs nothing, so no spec moves a tmux client or brings the developer's own apps forward: each
 *  call answers the next of [codes], then exit 0, and tmux prints what [said] gives it. The opener holds this adapter alone. */
function recorder(over: Partial<TmuxDeps & { platform: NodeJS.Platform }> = {}, codes: Array<number | null> = [], said: { pane?: string; clients?: string } = {}) {
  const calls: Call[] = []
  const logs: string[] = []
  const deps: TmuxDeps & { platform: NodeJS.Platform } = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      const stdout = args[0] === 'display-message' ? said.pane ?? '' : args[0] === 'list-clients' ? said.clients ?? '' : ''
      return { code: codes.length ? codes.shift()! : 0, stdout }
    },
    processes: async () => TABLE,
    log: (line) => { logs.push(line) },
    platform: 'darwin',
    ...over,
  }
  const adapter = createTmuxAdapter(deps)
  return { calls, logs, adapter, opener: createOpenActions({ run: deps.run, platform: deps.platform, adapters: [adapter], log: deps.log }) }
}

/** What the agent's hook hints let a tap open, as the observed source reads them, its process the hook's caller. */
const target = (hints: Record<string, string>, pid = 100): OpenTarget => {
  const place = { host: detectHost(hints), app: detectApp(hints), hints, pid }
  return { bundle: bundleOf(place.host, hints), pane: recorder().adapter.paneOf(place) }
}
const run = (file: string, ...args: string[]): Call => ({ file, args, timeoutMs: 10_000 })
const forward = (bundle: string): Call => run(OPEN, '-b', bundle)

const PANE = '%3'
const IN_GHOSTTY = { TMUX_PANE: PANE, TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'com.mitchellh.ghostty' }
const TAG = 'abcdef0123456789'
/** One line of `list-clients`, as tmux prints it: when it was used last, its name, the tag of the pane it shows, its session. */
const client = (activity: number, name: string, tag: string, session: string) => `${activity}|${name}|${tag}|${session}\n`
/** The pane holds the agent's shell, and the person's one client is on a session of their own. */
const OWN = { pane: '90\n', clients: client(1794700050, '/dev/ttys004', '', 'work') }
const asked: Call = run('tmux', 'display-message', '-p', '-t', PANE, '#{pane_pid}')
const listed: Call = run('tmux', 'list-clients', '-F', '#{client_activity}|#{client_name}|#{@harness_daemon}|#{session_name}')
const switched = (name = '/dev/ttys004'): Call => run('tmux', 'switch-client', '-c', name, '-t', PANE)
const ghostty = forward('com.mitchellh.ghostty')
const fallback = ['[device] open · tmux · fallback']

describe('the tmux adapter', () => {
  // It takes no platform: tmux's own command is the same on each (the Linux tap below).
  it('its id is tmux, it taps before its app, it can focus on every platform, and it has no show and no type', () => {
    const { adapter } = recorder()
    expect(adapter.id).toBe('tmux')
    expect(adapter.tap).toBe('before')
    expect(adapter.canFocus({ adapter: 'tmux', id: '%3:100' })).toBe(true)
    expect(adapter.show).toBeUndefined()
    expect(adapter.canShow).toBeUndefined()
    expect(adapter.type).toBeUndefined()
  })

  it('paneOf takes a pane id and the agent\'s process, and refuses any other', () => {
    const { adapter } = recorder()
    const place = (hints: Record<string, string>, pid?: number) => ({ host: 'tmux', app: 'tmux', hints, pid })
    expect(adapter.paneOf(place({ TMUX_PANE: '%3' }, 100))).toEqual({ adapter: 'tmux', id: '%3:100' })
    // From its own values alone: another host's beside it changes nothing (adapter.ts, rule 4).
    expect(adapter.paneOf(place({ TMUX_PANE: '%3', HERDR_PANE_ID: 'w1:p2', ORCA_TERMINAL_HANDLE: 'term_0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b' }, 100))).toEqual({ adapter: 'tmux', id: '%3:100' })
    expect(adapter.paneOf(place({}, 100))).toBeUndefined()
    for (const pid of [undefined, 0, -1, 1.5, Number.NaN]) expect(adapter.paneOf(place({ TMUX_PANE: '%3' }, pid)), String(pid)).toBeUndefined()
    for (const id of ['3', '%', '%3; rm -rf /', '%1234567890', '-t', '%3 ']) expect(adapter.paneOf(place({ TMUX_PANE: id }, 100)), id).toBeUndefined()
  })

  it('focus answers what happened: true once switched, refused when the pane holds another process, false when not reached', async () => {
    const pane = { adapter: 'tmux', id: '%3:100' }
    expect(await recorder({}, [], OWN).adapter.focus(pane)).toBe(true)
    const other = recorder({}, [], { ...OWN, pane: '4242\n' })
    expect(await other.adapter.focus(pane)).toBe('refused')
    expect(other.logs).toEqual(['[device] open · tmux · not its pane'])
    const silent = recorder({}, [1], OWN)
    expect(await silent.adapter.focus(pane)).toBe(false)
    expect(silent.logs).toEqual([])
  })

  it('a pane id not in its form runs nothing', async () => {
    const { calls, adapter } = recorder({}, [], OWN)
    for (const id of ['%3', '%3:', ':100', '%3:0', '%3:100; rm -rf /', '%3:100:1', '-t:100', '%3 :100']) {
      expect(await adapter.focus({ adapter: 'tmux', id }), id).toBe(false)
    }
    expect(calls).toEqual([])
  })

  it('its lines name the app only', async () => {
    const refused = recorder({}, [], { ...OWN, pane: '4242\n' })
    await refused.opener.open('a1', target(IN_GHOSTTY))
    const failed = recorder({}, [1], OWN)
    await failed.opener.open('a1', target(IN_GHOSTTY))
    for (const line of [...refused.logs, ...failed.logs]) for (const id of [PANE, '90', '100', '4242', 'ttys004', '/']) expect(line).not.toContain(id)
  })
})

describe('a tap on an agent in the person\'s own tmux pane (docs/specs/2026-11-15-device-wave1-checks.md)', () => {
  it('the pane holds the agent: the person\'s client is switched to it, then its app comes forward', async () => {
    const { calls, logs, opener } = recorder({}, [], OWN)
    expect(target(IN_GHOSTTY)).toEqual({ bundle: 'com.mitchellh.ghostty', pane: { adapter: 'tmux', id: '%3:100' } })
    expect(opener.can(target(IN_GHOSTTY))).toBe(true)
    expect(await opener.open('a1', target(IN_GHOSTTY))).toBe(true)
    expect(calls).toEqual([asked, listed, switched(), ghostty])
    expect(logs).toEqual([])
  })

  it('the pane\'s process is the agent\'s own or one of sixteen parents, and no further', async () => {
    const chain = Array.from({ length: 19 }, (_, i) => ({ pid: 100 + i, ppid: 101 + i }))
    const tap = async (panePid: number) => {
      const { calls, opener } = recorder({ processes: async () => chain }, [], { ...OWN, pane: `${panePid}\n` })
      await opener.open('a1', target(IN_GHOSTTY))
      return calls.some((call) => call.args[0] === 'switch-client')
    }
    expect([await tap(100), await tap(116), await tap(117)]).toEqual([true, true, false])
  })

  it('a pane of that id that holds another process is not switched to: its app comes forward, with one line', async () => {
    const other = recorder({}, [], { ...OWN, pane: '4242\n' })
    expect(await other.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
    // No client is even listed: the check comes first.
    expect(other.calls).toEqual([asked, ghostty])
    expect(other.logs).toEqual(['[device] open · tmux · not its pane'])
    // With no app to bring forward the tap is false, and the line is still said.
    const bare = recorder({}, [], { ...OWN, pane: '4242\n' })
    expect(await bare.opener.open('a1', target({ TMUX_PANE: PANE }))).toBe(false)
    expect(bare.calls).toEqual([asked])
    expect(bare.logs).toEqual(['[device] open · tmux · not its pane'])
  })

  // Its pid may be another process's by now: a pid the table does not hold matches nothing, itself included.
  it('an agent whose process is gone is not in its pane', async () => {
    for (const pane of ['90\n', '100\n']) {
      const gone = recorder({ processes: async () => TABLE.filter((p) => p.pid !== 100) }, [], { ...OWN, pane })
      expect(await gone.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
      expect(gone.calls).toEqual([asked, ghostty])
      expect(gone.logs).toEqual(['[device] open · tmux · not its pane'])
    }
  })

  // Desktop's terminals, a phone's and hn's are tmux clients too, on the same server: a tap never moves one of them.
  it('the client switched is the one used last among those not on a session Harness made', async () => {
    const clients = [
      client(1794700100, 'client-501', TAG, 'harness-claude-1790000000000-x'), // a Harness terminal, used last of all
      client(1794700090, 'client-502', '', 'harness-codex-1790000000000-y'), // a session a build before the tag named
      client(1794700080, 'client-503', TAG, 'work'), // showing a Harness pane the person moved
      client(1794700050, '/dev/ttys004', '', 'work'),
      client(1794700070, '/dev/ttys009', '', 'notes|2'), // a session's name may hold a bar
      client(1794700070, 'client-777', '', 'notes|2'), // the same second: the one listed later
      'not a client\n', 'soon|/dev/ttys010||work\n', '1794700099|||work\n', // no line tmux prints: each is passed over
    ].join('')
    const { calls, logs, opener } = recorder({}, [], { pane: '90\n', clients })
    expect(await opener.open('a1', target(IN_GHOSTTY))).toBe(true)
    expect(calls).toEqual([asked, listed, switched('client-777'), ghostty])
    expect(logs).toEqual([])
  })

  it('with no client of the person\'s nothing is switched: the app comes forward, as a fallback', async () => {
    const harnessOnly = client(1794700100, 'client-501', TAG, 'harness-claude-1790000000000-x') + client(1794700090, 'client-502', '', 'harness-codex-1790000000000-y')
    for (const clients of ['', harnessOnly]) {
      const none = recorder({}, [], { pane: '90\n', clients })
      expect(await none.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
      expect([none.calls, none.logs]).toEqual([[asked, listed, ghostty], fallback])
      const linux = recorder({ platform: 'linux' }, [], { pane: '90\n', clients })
      expect(await linux.opener.open('a1', target(IN_GHOSTTY))).toBe(false)
      expect(linux.calls).toEqual([asked, listed])
    }
  })

  it('tmux that does not say, a process table not read, or a switch that fails: the app comes forward, as a fallback', async () => {
    for (const pane of ['', '\n', 'abc\n', '-5\n']) {
      const silent = recorder({}, [], { ...OWN, pane })
      expect(await silent.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
      expect([silent.calls, silent.logs]).toEqual([[asked, ghostty], fallback])
    }
    const failed = recorder({}, [1], OWN)
    expect(await failed.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
    expect([failed.calls, failed.logs]).toEqual([[asked, ghostty], fallback])
    const unread = recorder({ processes: async () => { throw new Error('process table not read') } }, [], OWN)
    expect(await unread.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
    expect([unread.calls, unread.logs]).toEqual([[asked, ghostty], fallback])
    const unlisted = recorder({}, [0, 1], OWN)
    expect(await unlisted.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
    expect([unlisted.calls, unlisted.logs]).toEqual([[asked, listed, ghostty], fallback])
    // The client went between the list and the switch.
    const detached = recorder({}, [0, 0, 1], OWN)
    expect(await detached.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
    expect([detached.calls, detached.logs]).toEqual([[asked, listed, switched(), ghostty], fallback])
  })

  it('on Linux the client is switched, and nothing comes forward', async () => {
    const linux = recorder({ platform: 'linux' }, [], OWN)
    expect(linux.opener.can(target(IN_GHOSTTY))).toBe(true)
    expect(await linux.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
    expect(linux.calls).toEqual([asked, listed, switched()])
  })
})
