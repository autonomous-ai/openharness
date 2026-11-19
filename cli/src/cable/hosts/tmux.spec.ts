import { describe, expect, it, vi } from 'vitest'
import { detectApp, detectHost } from './hostDetect.js'
import { bundleOf, createOpenActions, type OpenTarget } from './open.js'
import type { TmuxPathOutcome } from '../../lib/tmuxOnPath.js'
import { createTmuxAdapter, createTmuxOuter, tmuxFinder, type TmuxDeps, type TmuxOuterDeps } from './tmux.js'

/** The core's finder, as the default tmuxFinder asks it: never this machine's login shell or tmux. It adopts tmux as the
 *  core does, its folder put ahead on the PATH of the environment it is given. */
const core = vi.hoisted(() => ({ envs: [] as NodeJS.ProcessEnv[] }))
vi.mock('../../lib/tmuxOnPath.js', async (real) => ({
  ...await real<typeof import('../../lib/tmuxOnPath.js')>(),
  ensureTmuxOnPath: async (env: NodeJS.ProcessEnv) => {
    core.envs.push(env)
    env.PATH = `/x/bin:${env.PATH}`
    return { state: 'adopted', path: '/x/bin/tmux', from: '/x/bin' }
  },
  tmuxAvailableNow: () => false,
}))

const OPEN = '/usr/bin/open'
/** tmux on the process's PATH, as the core finds it. */
const PRESENT = async (): Promise<TmuxPathOutcome> => ({ state: 'present' })

interface Call { file: string; args: string[]; timeoutMs: number }

/** The agent (100) in its shell (90), the pane's process, under tmux's server (80). */
const TABLE = [
  { pid: 100, ppid: 90, executable: 'claude' }, { pid: 90, ppid: 80, executable: 'zsh' }, { pid: 80, ppid: 1, executable: 'tmux' },
  { pid: 4242, ppid: 1, executable: 'other' },
]

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
    tmux: PRESENT,
    log: (line) => { logs.push(line) },
    front: () => 'terminal-app',
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
/** What tmux says of the pane: its process, its session, and the tag of the daemon that made it, empty for the person's. */
const says = (pid: number, session = 'work', owner = '') => `${pid}|${session}|${owner}\n`
/** The pane holds the agent's shell, and the person's one client is on a session of their own. */
const OWN = { pane: says(90), clients: client(1794700050, '/dev/ttys004', '', 'work') }
const askedOf = (pane: string): Call => run('tmux', 'display-message', '-p', '-t', pane, '#{pane_pid}|#{session_name}|#{@harness_daemon}'
  + '#{?#{m:/usr/bin/env HARNESS_DAEMON=*,#{pane_start_command}},#{=44:pane_start_command},#{?#{m:harness-*,#{session_name}},#{@harness_daemon},}}')
const asked = askedOf(PANE)
const listed: Call = run('tmux', 'list-clients', '-F', '#{client_activity}|#{client_name}|#{@harness_daemon}|#{session_name}')
const switched = (name = '/dev/ttys004'): Call => run('tmux', 'switch-client', '-c', name, '-t', PANE)
const ghostty = forward('com.mitchellh.ghostty')
const fallback = ['[device] open · tmux · fallback']
/** What tmux says of a pane Harness made, each holding the agent's shell. */
const HARNESS_PANES = [
  says(90, 'work', TAG), // tagged by a daemon, moved into the person's session
  says(90, 'harness-claude-1790000000000-x'), // in a session Harness made, from a build before the tag
  says(90, 'work', `/usr/bin/env HARNESS_DAEMON=${TAG}`), // before tmux 3.0: the tag its start command carries
]

describe('the tmux adapter', () => {
  // It takes no platform: tmux's own command is the same on each (the Linux tap below).
  it('its id is tmux, it taps before its app, it can focus on every platform, it shows, and it has no type', () => {
    const { adapter } = recorder()
    expect(adapter.id).toBe('tmux')
    expect(adapter.tap).toBe('before')
    expect(adapter.canFocus({ adapter: 'tmux', id: '%3:100' })).toBe(true)
    expect(adapter.show).toBeTypeOf('function')
    expect(adapter.canShow).toBeTypeOf('function')
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
    const other = recorder({}, [], { ...OWN, pane: says(4242) })
    expect(await other.adapter.focus(pane)).toBe('refused')
    expect(other.logs).toEqual(['[device] open · tmux · not its pane'])
    const silent = recorder({}, [1], OWN)
    expect(await silent.adapter.focus(pane)).toBe(false)
    expect(silent.logs).toEqual([])
  })

  it('a pane id not in its form runs nothing', async () => {
    const { calls, adapter } = recorder({}, [], OWN)
    const ids = ['%3', '%3:', ':100', '%3:0', '%3:100; rm -rf /', '%3:100:1', '-t:100', '%3 :100',
      // An app field that is no app: a number, a display name, a second field, an empty one.
      '%3:100:Terminal', '%3:100:terminal-app:x', '%3:100:', '%3:100:nope']
    for (const id of ids) {
      expect(await adapter.focus({ adapter: 'tmux', id }), id).toBe(false)
      expect(await adapter.show!({ adapter: 'tmux', id }, 'a1'), id).toBe('failed')
      expect(adapter.canShow!({ adapter: 'tmux', id }), id).toBe(false)
    }
    expect(calls).toEqual([])
  })

  it('its lines name the app only', async () => {
    const refused = recorder({}, [], { ...OWN, pane: says(4242) })
    await refused.opener.open('a1', target(IN_GHOSTTY))
    const failed = recorder({}, [1], OWN)
    await failed.opener.open('a1', target(IN_GHOSTTY))
    for (const line of [...refused.logs, ...failed.logs]) for (const id of [PANE, '90', '100', '4242', 'ttys004', '/']) expect(line).not.toContain(id)
  })
})

const WITH_APP = { adapter: 'tmux', id: '%3:100:terminal-app' }
/** The pane's window, then the pane, made active on the pane's own session, in one run of tmux. */
const selected: Call = run('tmux', 'select-window', '-t', PANE, ';', 'select-pane', '-t', PANE)

describe('a pane with its app', () => {
  const place = (outer?: { app: string; tty?: string }) => ({ host: 'tmux', app: 'tmux', hints: { TMUX_PANE: PANE }, pid: 100, outer })

  it('paneOf adds the outer app when it is one of the apps', () => {
    const { adapter } = recorder()
    expect(adapter.paneOf(place({ app: 'terminal-app', tty: '/dev/ttys004' }))).toEqual(WITH_APP)
    expect(adapter.paneOf(place({ app: 'nope' }))).toEqual({ adapter: 'tmux', id: '%3:100' })
    expect(adapter.paneOf(place())).toEqual({ adapter: 'tmux', id: '%3:100' })
  })

  it('canShow: only a pane with an app, only while that app is in front', () => {
    expect(recorder().adapter.canShow!(WITH_APP)).toBe(true)
    for (const front of ['ghostty', undefined]) expect(recorder({ front: () => front }).adapter.canShow!(WITH_APP), String(front)).toBe(false)
    expect(recorder().adapter.canShow!({ adapter: 'tmux', id: '%3:100' })).toBe(false)
  })

  it('show selects the pane\'s window and pane on its own session, after the same checks as a tap', async () => {
    const { calls, logs, adapter } = recorder({}, [], OWN)
    expect(await adapter.show!(WITH_APP, 'a1')).toBe('ok')
    // No client is listed or switched: the session's own active pane moves, for every client on it.
    expect(calls).toEqual([asked, selected])
    expect(logs).toEqual([])
  })

  it('show refuses another process\'s pane or a Harness pane, with one line', async () => {
    for (const pane of [says(4242), ...HARNESS_PANES]) {
      const refused = recorder({}, [], { ...OWN, pane })
      expect(await refused.adapter.show!(WITH_APP, 'a1'), pane).toBe('failed')
      expect(refused.calls, pane).toEqual([asked])
      expect(refused.logs, pane).toEqual(['[device] open · tmux · not its pane'])
    }
  })

  it('show that tmux does not answer, a process table not read, or a select that fails, is failed', async () => {
    const cases: Array<[Array<number | null>, { pane?: string }, Call[]]> = [
      [[1], OWN, [asked]],
      [[0, 1], OWN, [asked, selected]],
      [[], { pane: '' }, [asked]],
    ]
    for (const [codes, said, expected] of cases) {
      const failed = recorder({}, codes, said)
      expect(await failed.adapter.show!(WITH_APP, 'a1')).toBe('failed')
      expect([failed.calls, failed.logs]).toEqual([expected, []])
    }
    const unread = recorder({ processes: async () => { throw new Error('process table not read') } }, [], OWN)
    expect(await unread.adapter.show!(WITH_APP, 'a1')).toBe('failed')
    expect(unread.calls).toEqual([asked])
  })

  it('a tap on a pane with its app runs the same select, never switch-client, then its app comes forward', async () => {
    const { calls, logs, opener } = recorder({}, [], OWN)
    expect(await opener.open('a1', { bundle: 'com.apple.Terminal', pane: WITH_APP })).toBe(true)
    expect(calls).toEqual([asked, selected, forward('com.apple.Terminal')])
    expect(logs).toEqual([])
    const refused = recorder({}, [], { ...OWN, pane: says(4242) })
    expect(await refused.opener.open('a1', { bundle: 'com.apple.Terminal', pane: WITH_APP })).toBe(true)
    expect(refused.calls).toEqual([asked, forward('com.apple.Terminal')])
    expect(refused.logs).toEqual(['[device] open · tmux · not its pane'])
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
    const chain = Array.from({ length: 19 }, (_, i) => ({ pid: 100 + i, ppid: 101 + i, executable: 'sh' }))
    const tap = async (panePid: number) => {
      const { calls, opener } = recorder({ processes: async () => chain }, [], { ...OWN, pane: says(panePid) })
      await opener.open('a1', target(IN_GHOSTTY))
      return calls.some((call) => call.args[0] === 'switch-client')
    }
    expect([await tap(100), await tap(116), await tap(117)]).toEqual([true, true, false])
  })

  it('a pane of that id that holds another process is not switched to: its app comes forward, with one line', async () => {
    const other = recorder({}, [], { ...OWN, pane: says(4242) })
    expect(await other.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
    // No client is even listed: the check comes first.
    expect(other.calls).toEqual([asked, ghostty])
    expect(other.logs).toEqual(['[device] open · tmux · not its pane'])
    // With no app to bring forward the tap is false, and the line is still said.
    const bare = recorder({}, [], { ...OWN, pane: says(4242) })
    expect(await bare.opener.open('a1', target({ TMUX_PANE: PANE }))).toBe(false)
    expect(bare.calls).toEqual([asked])
    expect(bare.logs).toEqual(['[device] open · tmux · not its pane'])
  })

  // The hook checked whose pane it was at its last event; the pane may have moved into a session Harness made since.
  it('a pane Harness made holds the agent\'s process, and is not switched to: its app comes forward, with one line', async () => {
    for (const pane of HARNESS_PANES) {
      const made = recorder({}, [], { ...OWN, pane })
      expect(await made.opener.open('a1', target(IN_GHOSTTY)), pane).toBe(true)
      expect(made.calls, pane).toEqual([asked, ghostty])
      expect(made.logs, pane).toEqual(['[device] open · tmux · not its pane'])
    }
    // The person's own session may hold a bar in its name.
    const own = recorder({}, [], { ...OWN, pane: says(90, 'notes|2') })
    expect(await own.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
    expect(own.calls).toEqual([asked, listed, switched(), ghostty])
  })

  // Its pid may be another process's by now: a pid the table does not hold matches nothing, itself included.
  it('an agent whose process is gone is not in its pane', async () => {
    for (const pane of [says(90), says(100)]) {
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
    const { calls, logs, opener } = recorder({}, [], { pane: says(90), clients })
    expect(await opener.open('a1', target(IN_GHOSTTY))).toBe(true)
    expect(calls).toEqual([asked, listed, switched('client-777'), ghostty])
    expect(logs).toEqual([])
  })

  it('with no client of the person\'s nothing is switched: the app comes forward, as a fallback', async () => {
    const harnessOnly = client(1794700100, 'client-501', TAG, 'harness-claude-1790000000000-x') + client(1794700090, 'client-502', '', 'harness-codex-1790000000000-y')
    for (const clients of ['', harnessOnly]) {
      const none = recorder({}, [], { pane: says(90), clients })
      expect(await none.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
      expect([none.calls, none.logs]).toEqual([[asked, listed, ghostty], fallback])
      const linux = recorder({ platform: 'linux' }, [], { pane: says(90), clients })
      expect(await linux.opener.open('a1', target(IN_GHOSTTY))).toBe(false)
      expect(linux.calls).toEqual([asked, listed])
    }
  })

  it('tmux that does not say, a process table not read, or a switch that fails: the app comes forward, as a fallback', async () => {
    // A pid alone, with no session or owner said, is no answer either: whose pane it is goes unchecked.
    for (const pane of ['', '\n', 'abc\n', '-5\n', '90\n', 'abc|work|\n', '-5|work|\n']) {
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

/** The client's processes: tmux's client (4300) under a pseudo-terminal helper (4299), under Terminal in the person's
 *  Applications folder. */
const CLIENT_CHAIN = [
  { pid: 4300, ppid: 4299, executable: 'tmux' },
  { pid: 4299, ppid: 4298, executable: '/usr/bin/python3' },
  { pid: 4298, ppid: 1, executable: '/Users/u/Applications/Terminal.app/Contents/MacOS/Terminal' },
]
/** One line of the session's clients, as tmux prints it: when it was used last, its process, its tty. */
const places = (activity: number, pid: number, tty: string) => `${activity}|${pid}|${tty}\n`
/** The agent's hook hints in a pane of a server the daemon started: no bundle id names the app around it. */
const NESTED = { TMUX_PANE: PANE, TERM_PROGRAM: 'tmux' }
/** The pane holds the agent's shell, and one client from Terminal shows its session. */
const ONE = { pane: says(90), clients: places(1794700050, 4300, '/dev/ttys004') }
const clientsAsked: Call = run('tmux', 'list-clients', '-t', PANE, '-F', '#{client_activity}|#{client_pid}|#{client_tty}')
const found = ['[device] tmux client · found']
const none = ['[device] tmux client · none']
/** The lookup's line when a step could not be read, naming that step. */
const notRead = (why: 'tmux' | 'pane' | 'processes' | 'clients' | 'app') => [`[device] tmux client · not read · ${why}`]

/** A recording runner as `recorder`, for the lookup: it runs nothing, each call answers the next of [codes], then exit 0. */
function lookup(over: Partial<TmuxOuterDeps> = {}, codes: Array<number | null> = [], said: { pane?: string; clients?: string } = {}) {
  const calls: Call[] = []
  const logs: string[] = []
  const clock = { t: 1_000_000 }
  let reads = 0
  const outer = createTmuxOuter({
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      const stdout = args[0] === 'display-message' ? said.pane ?? '' : args[0] === 'list-clients' ? said.clients ?? '' : ''
      return { code: codes.length ? codes.shift()! : 0, stdout }
    },
    processes: async () => { reads++; return [...TABLE, ...CLIENT_CHAIN] },
    tmux: PRESENT,
    log: (line) => { logs.push(line) },
    now: () => clock.t,
    platform: 'darwin',
    roots: ['/Users/u/Applications/'],
    bundleId: async (bundle) => (bundle === '/Users/u/Applications/Terminal.app' ? 'com.apple.Terminal' : undefined),
    ...over,
  })
  return { calls, logs, clock, reads: () => reads, outer }
}

describe('the outer place of an agent in the person\'s tmux', () => {
  it('not tmux: undefined at once, and nothing runs', () => {
    const { calls, reads, outer } = lookup({}, [], ONE)
    for (const hints of [{}, { TERM_PROGRAM: 'tmux' }, { TMUX_PANE: '%3; x' }, { TMUX_PANE: '%1234567890' }, { TMUX_PANE: '-t' }] as Record<string, string>[]) {
      expect(outer(hints, 100), JSON.stringify(hints)).toBeUndefined()
    }
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(outer(NESTED, pid), String(pid)).toBeUndefined()
    expect([calls, reads()]).toEqual([[], 0])
  })

  it('a person\'s pane with one client: the client\'s app and tty', async () => {
    const { calls, logs, reads, outer } = lookup({}, [], ONE)
    expect(await outer(NESTED, 100)).toEqual({ app: 'terminal-app', tty: '/dev/ttys004' })
    expect(calls).toEqual([asked, clientsAsked])
    // One read of the table serves the pane's proof and the client's walk.
    expect(reads()).toBe(1)
    expect(logs).toEqual(found)
  })

  it('a Harness pane answers {} and lists no client', async () => {
    for (const pane of HARNESS_PANES) {
      const { calls, logs, outer } = lookup({}, [], { ...ONE, pane })
      expect(await outer(NESTED, 100), pane).toEqual({})
      expect(calls, pane).toEqual([asked])
      expect(logs, pane).toEqual(none)
    }
  })

  // A second tmux server of the person's (`-L`) can have a pane of the same id.
  it('a pane not in the caller\'s chain answers {}', async () => {
    const { calls, logs, outer } = lookup({}, [], { ...ONE, pane: says(4242) })
    expect(await outer(NESTED, 100)).toEqual({})
    expect(calls).toEqual([asked])
    expect(logs).toEqual(none)
  })

  it('a detached session answers {}', async () => {
    const { calls, logs, outer } = lookup({}, [], { ...ONE, clients: '' })
    expect(await outer(NESTED, 100)).toEqual({})
    expect(calls).toEqual([asked, clientsAsked])
    expect(logs).toEqual(none)
  })

  it('the client used last wins; on a tie the one listed later', async () => {
    const clients = [
      places(1794700050, 4300, '/dev/ttys001'),
      places(1794700090, 4300, '/dev/ttys002'), // used last
      places(1794700090, 4300, '/dev/ttys004'), // the same second, listed later: this one
      places(1794700070, 4300, '/dev/ttys003'), // listed last, used before
      'not a client\n', 'soon|4300|/dev/ttys009\n', '1794700099|0|/dev/ttys009\n', '1794700099||/dev/ttys009\n', // passed over
    ].join('')
    const { logs, outer } = lookup({}, [], { ...ONE, clients })
    expect(await outer(NESTED, 100)).toEqual({ app: 'terminal-app', tty: '/dev/ttys004' })
    expect(logs).toEqual(found)
  })

  // Every Harness terminal and a phone's is a control-mode client: no tty, and its parent no app.
  it('a control client used last answers {}', async () => {
    const clients = places(1794700050, 4300, '/dev/ttys004') + places(1794700100, 4242, '')
    const { logs, outer } = lookup({}, [], { ...ONE, clients })
    expect(await outer(NESTED, 100)).toEqual({})
    expect(logs).toEqual(none)
  })

  it('a tty out of form: the app alone', async () => {
    for (const tty of ['/dev/pts/3', '', 'ttys004', '/dev/ttys004; x', '/dev/ttys12345']) {
      const { logs, outer } = lookup({}, [], { ...ONE, clients: places(1794700050, 4300, tty) })
      expect(await outer(NESTED, 100), tty).toStrictEqual({ app: 'terminal-app' })
      expect(logs, tty).toEqual(found)
    }
  })

  it('a client whose parents name no listed app answers {}', async () => {
    const { logs, outer } = lookup({ bundleId: async () => 'com.example.other' }, [], ONE)
    expect(await outer(NESTED, 100)).toEqual({})
    expect(logs).toEqual(none)
  })

  it('on Linux the app is read from the names, and no tty passes', async () => {
    const processes = async () => [...TABLE, { pid: 4300, ppid: 4299, executable: 'tmux' }, { pid: 4299, ppid: 1, executable: 'ghostty' }]
    const { logs, outer } = lookup({ platform: 'linux', processes }, [], { ...ONE, clients: places(1794700050, 4300, '/dev/pts/3') })
    expect(await outer(NESTED, 100)).toStrictEqual({ app: 'ghostty' })
    expect(logs).toEqual(found)
  })

  it('tmux or ps that fails: {} and not read, with the step, never a rejection', async () => {
    const absent = async (): Promise<TmuxPathOutcome> => ({ state: 'absent', reason: 'tmux was not found' })
    const roots = Object.assign([], { some: () => { throw new Error('roots not read') } })
    const cases: Array<[string, ReturnType<typeof lookup>, Call[], string[]]> = [
      ['no tmux is found', lookup({ tmux: absent }, [], ONE), [], notRead('tmux')],
      ['tmux does not start', lookup({ run: async () => { throw new Error('spawn /x/bin/tmux EACCES') } }, [], ONE), [], notRead('pane')],
      ['display-message fails', lookup({}, [1], ONE), [asked], notRead('pane')],
      ['display-message says no fact', lookup({}, [], { ...ONE, pane: 'abc\n' }), [asked], notRead('pane')],
      ['the table is not read', lookup({ processes: async () => { throw new Error('process table not read') } }, [], ONE), [asked], notRead('processes')],
      ['list-clients fails', lookup({}, [0, 1], ONE), [asked, clientsAsked], notRead('clients')],
      ['the app scan throws', lookup({ roots }, [], ONE), [asked, clientsAsked], notRead('app')],
      ['a client with no activity', lookup({}, [], { ...ONE, clients: 'soon|4300|/dev/ttys004\n' }), [asked, clientsAsked], none],
      ['a client with no process', lookup({}, [], { ...ONE, clients: '1|0|/dev/ttys004\n' }), [asked, clientsAsked], none],
    ]
    for (const [name, { calls, logs, outer }, ran, said] of cases) {
      expect(await outer(NESTED, 100), name).toEqual({})
      expect(calls, name).toEqual(ran)
      expect(logs, name).toEqual(said)
    }
  })

  // Command Code's turn-start comes at every tool call; a lookup is a `ps` and up to sixteen `plutil` runs.
  it('one lookup per pane and caller in flight, and one every 5 s', async () => {
    const answer = { app: 'terminal-app', tty: '/dev/ttys004' }
    const held: Array<() => void> = []
    const { calls, clock, outer } = lookup({
      run: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        if (args[0] === 'display-message') await new Promise<void>((settle) => held.push(settle))
        return { code: 0, stdout: args[0] === 'display-message' ? says(90) : places(1794700050, 4300, '/dev/ttys004') }
      },
    })
    const at = clock.t
    const first = outer(NESTED, 100)
    const again = outer(NESTED, 100)
    // tmux runs once it is found: a tick after the ask.
    await vi.waitFor(() => expect(calls).toEqual([asked]))
    // Another pane is not held back by the first.
    clock.t = at + 1
    const other = outer({ TMUX_PANE: '%4' }, 100)
    await vi.waitFor(() => expect(calls).toEqual([asked, askedOf('%4')]))
    held[1]()
    expect(await other).toEqual(answer)
    held[0]()
    expect([await first, await again]).toEqual([answer, answer])
    expect(calls.filter((call) => call.args[0] === 'display-message')).toEqual([asked, askedOf('%4')])
    // The answer holds for that caller alone: a pane of the same id may be another server's.
    const caller = outer(NESTED, 90)
    await vi.waitFor(() => expect(calls.at(-1)).toEqual(asked))
    held[2]()
    expect(await caller).toEqual(answer)
    // Asked again within 5 s of its start: the last answer, with nothing run.
    const count = calls.length
    clock.t = at + 4_999
    expect(await outer(NESTED, 100)).toEqual(answer)
    expect(calls.length).toBe(count)
    // At 5 s it runs again, while %4's answer, asked later, still holds.
    clock.t = at + 5_000
    const later = outer(NESTED, 100)
    expect(await outer({ TMUX_PANE: '%4' }, 100)).toEqual(answer)
    await vi.waitFor(() => expect(calls.slice(count)).toEqual([asked]))
    // Still in flight past its 5 s: one lookup, shared.
    clock.t = at + 10_001
    const stuck = outer(NESTED, 100)
    expect(calls.slice(count)).toEqual([asked])
    held[3]()
    expect([await later, await stuck]).toEqual([answer, answer])
  })

  it('its lines name no pane, pid, tty, session, bundle or app', async () => {
    const lines: string[] = []
    for (const { logs, outer } of [lookup({}, [], ONE), lookup({}, [], { ...ONE, clients: '' }), lookup({}, [1], ONE)]) {
      await outer(NESTED, 100)
      lines.push(...logs)
    }
    expect(lines).toEqual([...found, ...none, ...notRead('pane')])
    for (const line of lines) {
      for (const id of [PANE, '4300', '100', 'ttys004', 'work', 'com.apple.Terminal', 'Terminal', 'terminal-app']) expect(line).not.toContain(id)
    }
  })
})

/** tmux where the core found it, off the process's PATH: the master's PATH may hold no tmux. */
const ADOPTED = async (): Promise<TmuxPathOutcome> => ({ state: 'adopted', path: '/x/bin/tmux', from: '/x/bin' })
const atPath = (call: Call): Call => ({ ...call, file: '/x/bin/tmux' })

describe('tmux as the core finds it', () => {
  it('a tmux found off the PATH runs at its path: the lookup places the agent in Terminal at its tty', async () => {
    const { calls, logs, outer } = lookup({ tmux: ADOPTED }, [], ONE)
    expect(await outer(NESTED, 100)).toEqual({ app: 'terminal-app', tty: '/dev/ttys004' })
    expect(calls).toEqual([atPath(asked), atPath(clientsAsked)])
    expect(logs).toEqual(found)
  })

  it('a tap\'s select and switch run tmux at its path', async () => {
    const withApp = recorder({ tmux: ADOPTED }, [], OWN)
    expect(await withApp.opener.open('a1', { bundle: 'com.apple.Terminal', pane: WITH_APP })).toBe(true)
    expect(withApp.calls).toEqual([atPath(asked), atPath(selected), forward('com.apple.Terminal')])
    const bare = recorder({ tmux: ADOPTED }, [], OWN)
    expect(await bare.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
    expect(bare.calls).toEqual([atPath(asked), atPath(listed), atPath(switched()), ghostty])
  })

  it('no tmux found: a tap runs no tmux, and its app comes forward as a fallback', async () => {
    const { calls, logs, opener } = recorder({ tmux: async () => ({ state: 'absent', reason: 'tmux was not found' }) }, [], OWN)
    expect(await opener.open('a1', target(IN_GHOSTTY))).toBe(true)
    expect([calls, logs]).toEqual([[ghostty], fallback])
  })

  it('the finder runs once for every call of the adapter and the lookup, a lookup in flight shared', async () => {
    let finds = 0
    let settle!: (outcome: TmuxPathOutcome) => void
    const tmux = tmuxFinder(() => { finds++; return new Promise((resolve) => { settle = resolve }) })
    const { outer } = lookup({ tmux }, [], ONE)
    const { adapter } = recorder({ tmux }, [], OWN)
    const first = outer(NESTED, 100)
    const second = outer({ TMUX_PANE: '%4' }, 100)
    const shown = adapter.show!(WITH_APP, 'a1')
    settle({ state: 'adopted', path: '/x/bin/tmux', from: '/x/bin' })
    await Promise.all([first, second, shown, adapter.focus({ adapter: 'tmux', id: '%3:100' })])
    expect(finds).toBe(1)
  })

  // As the core retries its own (lib/terminalBackendRecovery.ts): a tmux installed after the process started, or a login
  // shell that timed out on a loaded Mac, otherwise left the dial with no tmux until the process restarted.
  it('no tmux found, or a lookup that threw, is asked again once a tmux is where the core looks without a shell', async () => {
    const answers: Array<() => Promise<TmuxPathOutcome>> = [
      async () => { throw new Error('lookup failed') },
      async () => ({ state: 'absent', reason: 'tmux was not found' }),
      ADOPTED,
    ]
    let finds = 0
    let there = false
    const tmux = tmuxFinder(() => answers[finds++](), () => there)
    expect((await tmux()).state).toBe('absent')
    // None there yet: nothing is asked again.
    expect((await tmux()).state).toBe('absent')
    expect(finds).toBe(1)
    there = true
    expect((await tmux()).state).toBe('absent')
    expect(await tmux()).toEqual(await ADOPTED())
    expect(finds).toBe(3)
    // Found, it holds.
    expect(await tmux()).toEqual(await ADOPTED())
    expect(finds).toBe(3)
  })

  it('the finder asks as the core does, on a copy of this process\'s environment: its own PATH stays the master\'s', async () => {
    const path = process.env.PATH
    expect(await tmuxFinder()()).toEqual(await ADOPTED())
    expect(process.env.PATH).toBe(path)
    expect(core.envs).toHaveLength(1)
    expect(core.envs[0]).not.toBe(process.env)
  })
})
