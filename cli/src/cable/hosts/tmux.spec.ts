import { describe, expect, it, vi } from 'vitest'
import { detectApp, detectHost } from './hostDetect.js'
import { bundleOf, createOpenActions, type OpenTarget } from './open.js'
import { tmuxFinder } from '../../lib/binaryFinder.js'
import type { TmuxPathOutcome } from '../../lib/tmuxOnPath.js'
import { createTmuxAdapter, createTmuxNested, createTmuxOuter, PANES_A_LISTING, type TmuxDeps, type TmuxOuterDeps } from './tmux.js'
import type { PtyProcess } from './scannedApp.js'

const OPEN = '/usr/bin/open'
/** tmux on the process's PATH, as the core finds it. */
const PRESENT = async (): Promise<TmuxPathOutcome> => ({ state: 'present' })

interface Call { file: string; args: string[]; timeoutMs: number }

/** The agent (100) in its shell (90), the pane's process, under tmux's server (80), which made their terminal. */
const TABLE: PtyProcess[] = [
  { pid: 100, ppid: 90, tty: 'ttys010', executable: 'claude' }, { pid: 90, ppid: 80, tty: 'ttys010', executable: 'zsh' },
  { pid: 80, ppid: 1, executable: 'tmux' }, { pid: 4242, ppid: 1, executable: 'other' },
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
/** One line of `list-clients`, as tmux prints it: when it was used last, its process, its name, the tag of the pane it
 *  shows, its session. */
const client = (activity: number, pid: number | string, name: string, tag: string, session: string) => `${activity}|${pid}|${name}|${tag}|${session}\n`
/** What tmux says of the pane: its process, its session, and the tag of the daemon that made it, empty for the person's. */
const says = (pid: number, session = 'work', owner = '') => `${pid}|${session}|${owner}\n`
/** The pane holds the agent's shell, and the person's one client is on a session of their own. */
const OWN = { pane: says(90), clients: client(1794700050, 5004, '/dev/ttys004', '', 'work') }
/** A pane's process, session and daemon's tag, as tmux is asked for them. */
const PANE_FACTS = '#{pane_pid}|#{session_name}|#{@harness_daemon}'
  + '#{?#{m:/usr/bin/env HARNESS_DAEMON=*,#{pane_start_command}},#{=44:pane_start_command},#{?#{m:harness-*,#{session_name}},#{@harness_daemon},}}'
const askedOf = (pane: string): Call => run('tmux', 'display-message', '-p', '-t', pane, PANE_FACTS)
const asked = askedOf(PANE)
const listed: Call = run('tmux', 'list-clients', '-F', '#{client_activity}|#{client_pid}|#{client_name}|#{@harness_daemon}|#{session_name}')
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

// The raise on Linux starts its walk for a window from the client tmux switched, not the agent (the dial-linux spec, 2.2).
describe('the client a tap switched', () => {
  const pane = { adapter: 'tmux', id: '%3:100' }

  it('is the switched client\'s process, said once', async () => {
    const { adapter } = recorder({}, [], OWN)
    expect(adapter.windowPid?.(pane)).toBeUndefined()
    expect(await adapter.focus(pane)).toBe(true)
    expect(adapter.windowPid?.(pane)).toBe(5004)
    expect(adapter.windowPid?.(pane)).toBeUndefined()
  })

  it('is none for another pane, or after a switch that failed or was refused', async () => {
    const other = recorder({}, [], OWN)
    expect(await other.adapter.focus(pane)).toBe(true)
    expect(other.adapter.windowPid?.({ adapter: 'tmux', id: '%4:100' })).toBeUndefined()
    expect(other.adapter.windowPid?.({ adapter: 'tmux', id: '%3:101' })).toBeUndefined()
    // A tap that switched, then one whose switch failed: the first one's client is not the window now.
    const failed = recorder({}, [0, 0, 0, 0, 0, 1], OWN)
    expect(await failed.adapter.focus(pane)).toBe(true)
    expect(await failed.adapter.focus(pane)).toBe(false)
    expect(failed.adapter.windowPid?.(pane)).toBeUndefined()
    const refused = recorder({}, [], { ...OWN, pane: says(4242) })
    expect(await refused.adapter.focus(pane)).toBe('refused')
    expect(refused.adapter.windowPid?.(pane)).toBeUndefined()
    // A pane with its app is selected on its own session and no client moves: its window is its app's client's.
    const selectedOnly = recorder({}, [], OWN)
    expect(await selectedOnly.adapter.focus(WITH_APP)).toBe(true)
    expect(selectedOnly.calls).toEqual([asked, selected])
    expect(selectedOnly.adapter.windowPid?.(WITH_APP)).toBeUndefined()
  })

  it('a client whose process is not a whole number above 1 is still switched, and none is kept', async () => {
    for (const pid of ['', '1', '0', '-5', 'abc', '01', '12345678901']) {
      const odd = recorder({}, [], { pane: says(90), clients: client(1794700050, pid, '/dev/ttys004', '', 'work') })
      expect(await odd.adapter.focus(pane), pid).toBe(true)
      expect(odd.calls, pid).toEqual([asked, listed, switched()])
      expect(odd.adapter.windowPid?.(pane), pid).toBeUndefined()
    }
  })

  it('is kept for the last sixteen panes switched to, the oldest dropped', async () => {
    const panes = Array.from({ length: 17 }, (_, i) => ({ adapter: 'tmux', id: `%${i}:100` }))
    const { adapter } = recorder({}, [], OWN)
    for (const p of panes) expect(await adapter.focus(p)).toBe(true)
    expect(adapter.windowPid?.(panes[0])).toBeUndefined()
    for (const p of panes.slice(1)) expect(adapter.windowPid?.(p), p.id).toBe(5004)
  })
})

describe('a tap on an agent in the person\'s own tmux pane (docs/specs/2026-11-15-device-wave1-checks.md)', () => {
  it('the pane holds the agent: the person\'s client is switched to it, then its app comes forward', async () => {
    const { calls, logs, opener } = recorder({}, [], OWN)
    expect(target(IN_GHOSTTY)).toEqual({ bundle: 'com.mitchellh.ghostty', pane: { adapter: 'tmux', id: '%3:100' } })
    expect(opener.can('a1', target(IN_GHOSTTY))).toBe(true)
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
      client(1794700100, 5001, 'client-501', TAG, 'harness-claude-1790000000000-x'), // a Harness terminal, used last of all
      client(1794700090, 5002, 'client-502', '', 'harness-codex-1790000000000-y'), // a session a build before the tag named
      client(1794700080, 5003, 'client-503', TAG, 'work'), // showing a Harness pane the person moved
      client(1794700050, 5004, '/dev/ttys004', '', 'work'),
      client(1794700070, 5009, '/dev/ttys009', '', 'notes|2'), // a session's name may hold a bar
      client(1794700070, 5777, 'client-777', '', 'notes|2'), // the same second: the one listed later
      'not a client\n', 'soon|5010|/dev/ttys010||work\n', '1794700099|5011|||work\n', '1794700099|/dev/ttys011||work\n', // no line tmux prints: each is passed over
    ].join('')
    const { calls, logs, adapter, opener } = recorder({}, [], { pane: says(90), clients })
    expect(await opener.open('a1', target(IN_GHOSTTY))).toBe(true)
    expect(calls).toEqual([asked, listed, switched('client-777'), ghostty])
    expect(logs).toEqual([])
    expect(adapter.windowPid?.({ adapter: 'tmux', id: '%3:100' })).toBe(5777)
  })

  it('with no client of the person\'s nothing is switched: the app comes forward, as a fallback', async () => {
    const harnessOnly = client(1794700100, 5001, 'client-501', TAG, 'harness-claude-1790000000000-x') + client(1794700090, 5002, 'client-502', '', 'harness-codex-1790000000000-y')
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
    expect(linux.opener.can('a1', target(IN_GHOSTTY))).toBe(true)
    expect(await linux.opener.open('a1', target(IN_GHOSTTY))).toBe(true)
    expect(linux.calls).toEqual([asked, listed, switched()])
  })
})

/** The client's processes: tmux's client (4300) under a pseudo-terminal helper (4299), under Terminal in the person's
 *  Applications folder. */
const CLIENT_CHAIN: PtyProcess[] = [
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

/** Past every step an ask that runs takes before its first run: tmux is found, then run. */
const ranBy = () => new Promise<void>((resolve) => { setImmediate(resolve) })
/** A recording runner as `recorder`, for the lookup: it runs nothing, each call answers the next of [codes], then exit 0,
 *  and a process's terminal is the one the table gives it. */
function lookup(
  over: Partial<Omit<TmuxOuterDeps, 'processes'>> & { processes?: () => Promise<readonly PtyProcess[]> } = {},
  codes: Array<number | null> = [], said: { pane?: string; clients?: string } = {},
) {
  const calls: Call[] = []
  const logs: string[] = []
  const clock = { t: 1_000_000 }
  const table = over.processes ?? (async () => [...TABLE, ...CLIENT_CHAIN])
  let reads = 0
  const outer = createTmuxOuter({
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      const stdout = args[0] === 'display-message' ? said.pane ?? '' : args[0] === 'list-clients' ? said.clients ?? '' : ''
      return { code: codes.length ? codes.shift()! : 0, stdout }
    },
    tmux: PRESENT,
    log: (line) => { logs.push(line) },
    now: () => clock.t,
    platform: 'darwin',
    roots: ['/Users/u/Applications/'],
    bundleId: async (bundle) => (bundle === '/Users/u/Applications/Terminal.app' ? 'com.apple.Terminal' : undefined),
    tty: async (pid) => (await table()).find((p) => p.pid === pid)?.tty,
    ...over,
    processes: async () => { reads++; return table() },
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

  // Its process too: the window a raise brings forward on Linux is the one that holds the client (the dial-linux spec, 2.2).
  it('a person\'s pane with one client: the client\'s app, tty and process', async () => {
    const { calls, logs, reads, outer } = lookup({}, [], ONE)
    expect(await outer(NESTED, 100)).toStrictEqual({ app: 'terminal-app', tty: '/dev/ttys004', pid: 4300, nest: 'tmux' })
    expect(calls).toEqual([asked, clientsAsked])
    // One read of the table serves the pane's proof and the client's walk.
    expect(reads()).toBe(1)
    expect(logs).toEqual(found)
  })

  // Diego, 2026-11-23: an agent in a pane of the person's tmux is on tmux's page, whether or not a client shows it.
  it('the answer says tmux once the pane is the person\'s, holds the caller and tmux made its terminal: a client in an app, no client, and the clients not read', async () => {
    const cases: Array<[string, ReturnType<typeof lookup>, object, string[]]> = [
      ['a client in an app', lookup({}, [], ONE), { app: 'terminal-app', tty: '/dev/ttys004', pid: 4300, nest: 'tmux' }, found],
      ['no client', lookup({}, [], { ...ONE, clients: '' }), { nest: 'tmux' }, none],
      ['the clients not read', lookup({}, [0, 1], ONE), { nest: 'tmux' }, notRead('clients')],
    ]
    for (const [name, { logs, outer }, answer, said] of cases) {
      expect(await outer(NESTED, 100), name).toStrictEqual(answer)
      expect(logs, name).toEqual(said)
    }
  })

  it('a terminal started from a tmux pane (code .), a pane Harness made, a pane holding no process of the caller\'s, and facts not read answer {} with no nest', async () => {
    const started = async () => [
      { pid: 100, ppid: 96, tty: 'ttys011', executable: 'claude' }, { pid: 96, ppid: 95, tty: 'ttys011', executable: 'zsh' },
      { pid: 95, ppid: 90, executable: 'Code Helper' }, ...TABLE.filter((p) => p.pid !== 100), ...CLIENT_CHAIN,
    ]
    const cases: Array<[string, ReturnType<typeof lookup>]> = [
      ['a terminal started from a tmux pane', lookup({ processes: started }, [], ONE)],
      ['a pane Harness made', lookup({}, [], { ...ONE, pane: HARNESS_PANES[0] })],
      ['a pane holding no process of the caller\'s', lookup({}, [], { ...ONE, pane: says(4242) })],
      ['the pane\'s facts not read', lookup({}, [1], ONE)],
      ['the table not read', lookup({ processes: async () => { throw new Error('process table not read') } }, [], ONE)],
      ['the caller\'s terminal not read', lookup({ tty: async () => { throw new Error('tty not read') } }, [], ONE)],
    ]
    for (const [name, { outer }] of cases) {
      // An inherited pane id never puts the agent on tmux's page.
      const made = vi.fn()
      expect(await outer(NESTED, 100, made), name).toStrictEqual({})
      expect(made, name).not.toHaveBeenCalled()
    }
  })

  // A herdr pane in iTerm2 stayed on iTerm2's page while herdr's client steps ran (Mac eval IH4, 2026-11-24): tmux's
  // clients' list and app walk are such steps too, and the pane is tmux's from the maker's read on.
  it('tmux\'s page is told once tmux made the caller\'s terminal, before its clients are listed, to each ask that shares the answer', async () => {
    const held: Array<() => void> = []
    const { calls, outer } = lookup({
      run: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        if (args[0] === 'list-clients') await new Promise<void>((settle) => held.push(settle))
        return { code: 0, stdout: args[0] === 'display-message' ? says(90) : places(1794700050, 4300, '/dev/ttys004') }
      },
    })
    const answer = { app: 'terminal-app', tty: '/dev/ttys004', pid: 4300, nest: 'tmux' }
    const made = vi.fn()
    const again = vi.fn()
    let settled = false
    const first = outer(NESTED, 100, made)!
    void first.then(() => { settled = true })
    await vi.waitFor(() => expect(held.length).toBe(1))
    await vi.waitFor(() => expect(made.mock.calls).toEqual([['tmux']]))
    // Asked again while the clients are listed: the same answer, and told too.
    const shared = outer(NESTED, 100, again)
    await vi.waitFor(() => expect(again.mock.calls).toEqual([['tmux']]))
    expect(settled).toBe(false)
    held[0]()
    expect([await first, await shared]).toEqual([answer, answer])
    expect(made.mock.calls).toEqual([['tmux']])
    expect(calls).toEqual([asked, clientsAsked])
  })

  it('tmux inside a herdr pane: hints naming both panes, tmux the maker: the answer says tmux', async () => {
    const { logs, outer } = lookup({}, [], ONE)
    expect(await outer({ HERDR_PANE_ID: 'w1:p1', TMUX_PANE: PANE }, 100)).toStrictEqual({ app: 'terminal-app', tty: '/dev/ttys004', pid: 4300, nest: 'tmux' })
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

  // Linux: an xterm or WezTerm started from a tmux pane is that pane's child and keeps its TMUX_PANE, yet its agents
  // are in no tmux pane: the walk up holds the pane, the terminal's maker does not.
  it('a terminal started from a tmux pane: {}', async () => {
    const processes = async () => [
      { pid: 100, ppid: 96, tty: 'pts/7', executable: 'claude' }, { pid: 96, ppid: 95, tty: 'pts/7', executable: 'bash' },
      { pid: 95, ppid: 90, tty: 'ttys010', executable: 'xterm' }, ...TABLE.filter((p) => p.pid !== 100), ...CLIENT_CHAIN,
    ]
    const { calls, logs, outer } = lookup({ processes }, [], ONE)
    expect(await outer(NESTED, 100)).toEqual({})
    expect(calls).toEqual([asked])
    expect(logs).toEqual(none)
  })

  it('a detached session answers tmux alone', async () => {
    const { calls, logs, outer } = lookup({}, [], { ...ONE, clients: '' })
    expect(await outer(NESTED, 100)).toEqual({ nest: 'tmux' })
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
    expect(await outer(NESTED, 100)).toEqual({ app: 'terminal-app', tty: '/dev/ttys004', pid: 4300, nest: 'tmux' })
    expect(logs).toEqual(found)
  })

  // Every Harness terminal and a phone's is a control-mode client: no tty, and its parent no app.
  it('a control client used last answers tmux alone', async () => {
    const clients = places(1794700050, 4300, '/dev/ttys004') + places(1794700100, 4242, '')
    const { logs, outer } = lookup({}, [], { ...ONE, clients })
    expect(await outer(NESTED, 100)).toEqual({ nest: 'tmux' })
    expect(logs).toEqual(none)
  })

  it('a tty out of form: the app alone', async () => {
    for (const tty of ['/dev/pts/3', '', 'ttys004', '/dev/ttys004; x', '/dev/ttys12345']) {
      const { logs, outer } = lookup({}, [], { ...ONE, clients: places(1794700050, 4300, tty) })
      expect(await outer(NESTED, 100), tty).toStrictEqual({ app: 'terminal-app', pid: 4300, nest: 'tmux' })
      expect(logs, tty).toEqual(found)
    }
  })

  it('a client whose parents name no listed app answers tmux alone', async () => {
    const { logs, outer } = lookup({ bundleId: async () => 'com.example.other' }, [], ONE)
    expect(await outer(NESTED, 100)).toEqual({ nest: 'tmux' })
    expect(logs).toEqual(none)
  })

  // The app is read from the names; the pts names the WezTerm or kitty tab holding the client (the dial-linux follow-ups
  // spec), and a macOS tty there names none.
  it('Linux: a client in a WezTerm window on /dev/pts/3: its app, tty and process', async () => {
    const processes = async () => [...TABLE, { pid: 4300, ppid: 4299, executable: 'tmux' }, { pid: 4299, ppid: 1, executable: 'wezterm-gui' }]
    const { logs, outer } = lookup({ platform: 'linux', processes }, [], { ...ONE, clients: places(1794700050, 4300, '/dev/pts/3') })
    expect(await outer(NESTED, 100)).toStrictEqual({ app: 'wezterm', tty: '/dev/pts/3', pid: 4300, nest: 'tmux' })
    expect(logs).toEqual(found)
    const mac = lookup({ platform: 'linux', processes }, [], ONE)
    expect(await mac.outer(NESTED, 100)).toStrictEqual({ app: 'wezterm', pid: 4300, nest: 'tmux' })
  })

  it('tmux or ps that fails: no app and not read, with the step, never a rejection', async () => {
    const absent = async (): Promise<TmuxPathOutcome> => ({ state: 'absent', reason: 'tmux was not found' })
    const roots = Object.assign([], { some: () => { throw new Error('roots not read') } })
    // Once tmux is known to have made the caller's terminal, a client step that fails still answers tmux.
    const tmux = { nest: 'tmux' }
    const cases: Array<[string, ReturnType<typeof lookup>, Call[], string[], object]> = [
      ['no tmux is found', lookup({ tmux: absent }, [], ONE), [], notRead('tmux'), {}],
      ['the finder throws', lookup({ tmux: async () => { throw new Error('finder under /Users/someone') } }, [], ONE), [], notRead('tmux'), {}],
      ['tmux throws at once', lookup({ run: () => { throw new Error('spawn /x/bin/tmux EACCES') } }, [], ONE), [], notRead('tmux'), {}],
      ['tmux does not start', lookup({ run: async () => { throw new Error('spawn /x/bin/tmux EACCES') } }, [], ONE), [], notRead('pane'), {}],
      ['display-message fails', lookup({}, [1], ONE), [asked], notRead('pane'), {}],
      ['display-message says no fact', lookup({}, [], { ...ONE, pane: 'abc\n' }), [asked], notRead('pane'), {}],
      ['the table is not read', lookup({ processes: async () => { throw new Error('process table not read') } }, [], ONE), [asked], notRead('processes'), {}],
      ['the caller\'s terminal is not read', lookup({ tty: async () => { throw new Error('tty not read') } }, [], ONE), [asked], notRead('processes'), {}],
      ['list-clients fails', lookup({}, [0, 1], ONE), [asked, clientsAsked], notRead('clients'), tmux],
      ['the app scan throws', lookup({ roots }, [], ONE), [asked, clientsAsked], notRead('app'), tmux],
      ['a client with no activity', lookup({}, [], { ...ONE, clients: 'soon|4300|/dev/ttys004\n' }), [asked, clientsAsked], none, tmux],
      ['a client with no process', lookup({}, [], { ...ONE, clients: '1|0|/dev/ttys004\n' }), [asked, clientsAsked], none, tmux],
    ]
    for (const [name, { calls, logs, outer }, ran, said, answer] of cases) {
      expect(await outer(NESTED, 100), name).toEqual(answer)
      expect(calls, name).toEqual(ran)
      expect(logs, name).toEqual(said)
    }
  })

  // Command Code's turn-start comes at every tool call; a lookup is a `ps` and up to sixteen `plutil` runs.
  it('one lookup per pane and caller in flight, and one every 5 s', async () => {
    const answer = { app: 'terminal-app', tty: '/dev/ttys004', pid: 4300, nest: 'tmux' }
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
    clock.t = at + 3
    const caller = outer(NESTED, 90)
    await vi.waitFor(() => expect(calls.at(-1)).toEqual(asked))
    held[2]()
    expect(await caller).toEqual(answer)
    // Asked again within 5 s of its settle: the last answer, with nothing run.
    const count = calls.length
    clock.t = at + 5_000
    const kept = outer(NESTED, 100)
    await ranBy()
    expect(calls.length).toBe(count)
    expect(await kept).toEqual(answer)
    // At 5 s from its settle it runs again, while the caller's answer, settled later, still holds.
    clock.t = at + 5_001
    const later = outer(NESTED, 100)
    expect(await outer(NESTED, 90)).toEqual(answer)
    await vi.waitFor(() => expect(calls.slice(count)).toEqual([asked]))
    // Still in flight past its 5 s: one lookup, shared.
    clock.t = at + 10_002
    const stuck = outer(NESTED, 100)
    expect(calls.slice(count)).toEqual([asked])
    held[3]()
    expect([await later, await stuck]).toEqual([answer, answer])
    // A lookup that ran 5 s holds 5 s from its settle, not its start: a tmux that hangs costs one timeout.
    const settled = calls.length
    clock.t = at + 15_001
    const after = outer(NESTED, 100)
    await ranBy()
    expect(calls.length).toBe(settled)
    expect(await after).toEqual(answer)
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

/** The listing of every pane of the server, as the process form asks for it. */
const panesListed: Call = run('tmux', 'list-panes', '-a', '-F', `#{pane_id}|#{pane_tty}|${PANE_FACTS}`)
/** One line of that listing, as tmux prints it: the pane, its tty, then what tmux says of it. */
const paneLine = (id: string, tty: string, facts = says(90)) => `${id}|${tty}|${facts}`
/** The person's pane %3 on the agent's tty, beside another pane of theirs. */
const PANES = paneLine('%1', '/dev/ttys009', says(50)) + paneLine(PANE, '/dev/ttys010')
/** The agent the scan found: its process, its own tty as the maker read gave it, and the look's table. */
const AGENT = { pid: 100, tty: 'ttys010', rows: [...TABLE, ...CLIENT_CHAIN] }
/** The process form's answer for that agent: the hooked form's, and the pane with its app. */
const PLACED = { app: 'terminal-app', tty: '/dev/ttys004', pid: 4300, pane: { adapter: 'tmux', id: '%3:100:terminal-app' } }
const over = '[device] tmux client · over'

/** A recording runner as `lookup`, for the process form: it runs nothing, each call answers the next of [codes], then
 *  exit 0, and tmux prints what [said] gives it. */
function nestedLookup(over: Partial<Omit<TmuxOuterDeps, 'processes' | 'tty'>> = {}, codes: Array<number | null> = [], said: { panes?: string; clients?: string } = {}) {
  const calls: Call[] = []
  const logs: string[] = []
  const clock = { t: 1_000_000 }
  const nested = createTmuxNested({
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      const stdout = args[0] === 'list-panes' ? said.panes ?? '' : args[0] === 'list-clients' ? said.clients ?? '' : ''
      return { code: codes.length ? codes.shift()! : 0, stdout }
    },
    tmux: PRESENT,
    log: (line) => { logs.push(line) },
    now: () => clock.t,
    platform: 'darwin',
    roots: ['/Users/u/Applications/'],
    bundleId: async (bundle) => (bundle === '/Users/u/Applications/Terminal.app' ? 'com.apple.Terminal' : undefined),
    ...over,
  })
  return { calls, logs, clock, nested }
}

// Diego's report of 2026-11-22: an idle agent in his tmux, found by the open scan after the devices started again, was
// on Other's page until its next hook. The scan has no hook's TMUX_PANE: the pane is found by the agent's own tty.
describe('the place of an agent the scan found in the person\'s tmux', () => {
  it('out of form: undefined at once, and nothing runs', () => {
    const { calls, nested } = nestedLookup({}, [], { panes: PANES, clients: ONE.clients })
    for (const pid of [0, -1, 1.5]) expect(nested({ ...AGENT, pid }), String(pid)).toBeUndefined()
    for (const tty of ['ttys004; x', '/dev/ttys004', '', 'pts/2']) expect(nested({ ...AGENT, tty }), tty).toBeUndefined()
    const windows = nestedLookup({ platform: 'win32' }, [], { panes: PANES, clients: ONE.clients })
    expect(windows.nested(AGENT)).toBeUndefined()
    expect([calls, windows.calls]).toEqual([[], []])
  })

  it('the person\'s pane on the agent\'s tty: its client\'s app, tty and process, and the pane with its app', async () => {
    const { calls, logs, nested } = nestedLookup({}, [], { panes: PANES, clients: ONE.clients })
    expect(await nested(AGENT)).toStrictEqual(PLACED)
    // The scan read the table and the maker: no display-message, only the listing and the pane's clients.
    expect(calls).toEqual([panesListed, clientsAsked])
    expect(logs).toEqual(found)
  })

  it('Linux: pts/5 finds its pane on /dev/pts/5, the client in a WezTerm window', async () => {
    const rows = [...TABLE, { pid: 4300, ppid: 4299, executable: 'tmux' }, { pid: 4299, ppid: 1, executable: 'wezterm-gui' }]
    const { calls, logs, nested } = nestedLookup({ platform: 'linux' }, [], {
      panes: paneLine('%1', '/dev/pts/4', says(50)) + paneLine(PANE, '/dev/pts/5'), clients: places(1794700050, 4300, '/dev/pts/3'),
    })
    expect(await nested({ pid: 100, tty: 'pts/5', rows })).toStrictEqual({
      app: 'wezterm', tty: '/dev/pts/3', pid: 4300, pane: { adapter: 'tmux', id: '%3:100:wezterm' },
    })
    expect(calls).toEqual([panesListed, clientsAsked])
    expect(logs).toEqual(found)
  })

  it('a daemon\'s or Harness\'s pane on that tty answers {} and lists no client', async () => {
    for (const facts of HARNESS_PANES) {
      const { calls, logs, nested } = nestedLookup({}, [], { panes: paneLine(PANE, '/dev/ttys010', facts), clients: ONE.clients })
      expect(await nested(AGENT), facts).toEqual({})
      expect(calls, facts).toEqual([panesListed])
      expect(logs, facts).toEqual(none)
    }
  })

  // A second tmux server of the person's (`-L`) can have a pane on another tty that holds the agent: only this server's
  // pane on its own tty, holding its process or a parent, is its pane.
  it('a tty in no pane, or a pane that holds another process: {}', async () => {
    for (const panes of [paneLine('%1', '/dev/ttys009', says(50)), paneLine(PANE, '/dev/ttys010', says(4242)), '']) {
      const { calls, logs, nested } = nestedLookup({}, [], { panes, clients: ONE.clients })
      expect(await nested(AGENT), panes).toEqual({})
      expect(calls, panes).toEqual([panesListed])
      expect(logs, panes).toEqual(none)
    }
  })

  // Review Focus 2: the agent stays where the scan put it.
  it('a detached session, or a client in no listed app: {}', async () => {
    const detached = nestedLookup({}, [], { panes: PANES, clients: '' })
    const elsewhere = nestedLookup({ bundleId: async () => 'com.example.other' }, [], { panes: PANES, clients: ONE.clients })
    for (const { calls, logs, nested } of [detached, elsewhere]) {
      expect(await nested(AGENT)).toEqual({})
      expect(calls).toEqual([panesListed, clientsAsked])
      expect(logs).toEqual(none)
    }
  })

  // Review Focus 3: Harness's own panes share the person's server, and every one of them is a line of the listing.
  it('past 1024 lines it says over, once, and a pane past the bound is not found', async () => {
    expect(PANES_A_LISTING).toBe(1024)
    const others = Array.from({ length: PANES_A_LISTING }, (_, i) => paneLine(`%${i + 10}`, '/dev/ttys999', says(50))).join('')
    const past = nestedLookup({}, [], { panes: others + paneLine(PANE, '/dev/ttys010'), clients: ONE.clients })
    expect(await past.nested(AGENT)).toEqual({})
    expect(past.calls).toEqual([panesListed])
    expect(past.logs).toEqual([over, ...none])
    const within = others.split('\n').slice(1).join('\n') + paneLine(PANE, '/dev/ttys010')
    const bound = nestedLookup({}, [], { panes: within, clients: ONE.clients })
    expect(await bound.nested(AGENT)).toStrictEqual(PLACED)
    expect(bound.logs).toEqual(found)
  })

  it('lines out of form are passed over, and a session may hold a bar', async () => {
    const panes = ['garbage\n', '%3|ttys010|90|work|\n', paneLine(PANE, '/dev/ttys010', says(90, 'my|work'))].join('')
    const { calls, logs, nested } = nestedLookup({}, [], { panes, clients: ONE.clients })
    expect(await nested(AGENT)).toStrictEqual(PLACED)
    expect(calls).toEqual([panesListed, clientsAsked])
    expect(logs).toEqual(found)
  })

  it('no tmux, or a listing or client read that fails: {} and not read, with the step, never a rejection', async () => {
    const absent = async (): Promise<TmuxPathOutcome> => ({ state: 'absent', reason: 'tmux was not found' })
    const roots = Object.assign([], { some: () => { throw new Error('roots not read') } })
    const said = { panes: PANES, clients: ONE.clients }
    const cases: Array<[string, ReturnType<typeof nestedLookup>, Call[], string[]]> = [
      ['no tmux is found', nestedLookup({ tmux: absent }, [], said), [], notRead('tmux')],
      ['tmux does not start', nestedLookup({ run: async () => { throw new Error('spawn /x/bin/tmux EACCES') } }, [], said), [], notRead('pane')],
      ['list-panes fails', nestedLookup({}, [1], said), [panesListed], notRead('pane')],
      ['list-clients fails', nestedLookup({}, [0, 1], said), [panesListed, clientsAsked], notRead('clients')],
      ['the app scan throws', nestedLookup({ roots }, [], said), [panesListed, clientsAsked], notRead('app')],
    ]
    for (const [name, { calls, logs, nested }, ran, lines] of cases) {
      expect(await nested(AGENT), name).toEqual({})
      expect(calls, name).toEqual(ran)
      expect(logs, name).toEqual(lines)
    }
  })

  // A step that throws is said as no tmux is, as the hooked lookup's is: its listing is held 5 s from its settle like any
  // other answer, never kept as a rejection for every later look.
  it('the finder or tmux throws: {} and not read · tmux, never a rejection, and the listing is asked again 5 s on', async () => {
    const said = { panes: PANES, clients: ONE.clients }
    let finds = 0
    const throwing = async (): Promise<TmuxPathOutcome> => {
      finds++
      throw new Error('finder under /Users/someone')
    }
    const cases: Array<[string, ReturnType<typeof nestedLookup>]> = [
      ['the finder throws', nestedLookup({ tmux: throwing }, [], said)],
      ['tmux throws at once', nestedLookup({ run: () => { throw new Error('spawn /x/bin/tmux EACCES') } }, [], said)],
    ]
    for (const [name, { calls, logs, clock, nested }] of cases) {
      expect(await nested(AGENT), name).toEqual({})
      expect(calls, name).toEqual([])
      expect(logs, name).toEqual(notRead('tmux'))
      clock.t += 5_000
      expect(await nested(AGENT), name).toEqual({})
      expect(logs, name).toEqual([...notRead('tmux'), ...notRead('tmux')])
    }
    expect(finds).toBe(2)
  })

  // The scan asks for up to fifty sessions a look: a tmux that hangs costs the look one timeout, not one an ask.
  it('one listing serves every ask for 5 s, one in flight shared; one answer per tty and process', async () => {
    // A second agent (200) in pane %4 on ttys011.
    const rows = [...AGENT.rows, { pid: 200, ppid: 190, tty: 'ttys011', executable: 'claude' }, { pid: 190, ppid: 80, tty: 'ttys011', executable: 'zsh' }]
    const second = { pid: 200, tty: 'ttys011', rows }
    const first = { ...AGENT, rows }
    const held: Array<() => void> = []
    const { calls, clock, nested } = nestedLookup({
      run: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        if (args[0] === 'list-panes') await new Promise<void>((settle) => held.push(settle))
        return { code: 0, stdout: args[0] === 'list-panes' ? PANES + paneLine('%4', '/dev/ttys011', says(190, 'play')) : ONE.clients }
      },
    })
    const clientsOf = (pane: string): Call => ({ ...clientsAsked, args: ['list-clients', '-t', pane, ...clientsAsked.args.slice(3)] })
    const at = clock.t
    const a = nested(first)
    const again = nested(first)
    const b = nested(second)
    await vi.waitFor(() => expect(calls).toEqual([panesListed]))
    held[0]()
    const answerOf = (pid: number, pane: string) => ({ ...PLACED, pane: { adapter: 'tmux', id: `${pane}:${pid}:terminal-app` } })
    expect([await a, await again, await b]).toEqual([PLACED, PLACED, answerOf(200, '%4')])
    // One listing; each session's clients once, the same agent's two asks sharing one answer.
    expect(calls).toEqual([panesListed, clientsAsked, clientsOf('%4')])
    // Within 5 s of their settle: the agent's answer, and another process's on that tty, with nothing run.
    clock.t = at + 4_999
    expect(await nested(first)).toEqual(PLACED)
    expect(await nested({ ...first, pid: 90 })).toEqual(answerOf(90, '%3'))
    expect(calls).toHaveLength(3)
    // At 5 s the listing runs again, and is shared while in flight past its own 5 s.
    clock.t = at + 5_000
    const later = nested(first)
    await vi.waitFor(() => expect(calls.slice(3)).toEqual([panesListed]))
    clock.t = at + 10_001
    const stuck = nested(first)
    expect(calls.slice(3)).toEqual([panesListed])
    held[1]()
    expect([await later, await stuck]).toEqual([PLACED, PLACED])
    expect(calls.slice(3)).toEqual([panesListed, clientsAsked])
  })

  // A tmux that answers the listing, then hangs on the clients, costs the look one timeout, not one an agent: every
  // pane of a session has that session's clients.
  it('two agents in panes of one session run one list-clients, a failed one too, held 5 s from its settle', async () => {
    const rows = [...AGENT.rows, { pid: 200, ppid: 190, tty: 'ttys011', executable: 'claude' }, { pid: 190, ppid: 80, tty: 'ttys011', executable: 'zsh' }]
    const panes = PANES + paneLine('%4', '/dev/ttys011', says(190))
    const shown = nestedLookup({}, [], { panes, clients: ONE.clients })
    expect([await shown.nested({ ...AGENT, rows }), (await shown.nested({ pid: 200, tty: 'ttys011', rows }))?.pane])
      .toEqual([PLACED, { adapter: 'tmux', id: '%4:200:terminal-app' }])
    expect(shown.calls).toEqual([panesListed, clientsAsked])
    expect(shown.logs).toEqual([...found, ...found])

    const held: Array<() => void> = []
    const { calls, clock, logs, nested } = nestedLookup({
      run: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        if (args[0] !== 'list-clients') return { code: 0, stdout: panes }
        // The first read of the clients hangs to its timeout; a second answers at once, so an ask that runs one fails
        // rather than waits.
        if (!held.length) await new Promise<void>((settle) => held.push(settle))
        return { code: null, stdout: '' }
      },
    })
    const clientReads = () => calls.filter((call) => call.args[0] === 'list-clients')
    const at = clock.t
    const first = nested({ ...AGENT, rows })
    await vi.waitFor(() => expect(clientReads()).toHaveLength(1))
    clock.t = at + 10_000
    held[0]()
    expect(await first).toEqual({})
    const next = nested({ pid: 200, tty: 'ttys011', rows })
    await ranBy()
    expect(clientReads()).toHaveLength(1)
    expect(await next).toEqual({})
    expect(logs).toEqual([...notRead('clients'), ...notRead('clients')])
    // 5 s from its settle, the session's clients are read again.
    clock.t = at + 15_000
    expect(await nested({ ...AGENT, rows, pid: 90 })).toEqual({})
    expect(clientReads()).toHaveLength(2)
  })

  // The scan asks for its sessions one at a time: an answer kept from the listing's start would be gone after a listing
  // that hung to its timeout, and every ask after it would wait out one more.
  it('a listing that ran 10 s holds 5 s from its settle: the asks after it run none', async () => {
    const rows = [...AGENT.rows, { pid: 200, ppid: 190, tty: 'ttys011', executable: 'claude' }, { pid: 190, ppid: 80, tty: 'ttys011', executable: 'zsh' }]
    const first = { ...AGENT, rows }
    const held: Array<() => void> = []
    const { calls, clock, nested } = nestedLookup({
      run: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        // The first listing hangs; a second answers at once, so an ask that runs one fails rather than waits.
        if (args[0] === 'list-panes' && !held.length) await new Promise<void>((settle) => held.push(settle))
        return { code: 0, stdout: args[0] === 'list-panes' ? PANES + paneLine('%4', '/dev/ttys011', says(190, 'play')) : ONE.clients }
      },
    })
    const listings = () => calls.filter((call) => call.args[0] === 'list-panes')
    const at = clock.t
    const a = nested(first)
    await vi.waitFor(() => expect(listings()).toEqual([panesListed]))
    clock.t = at + 10_000
    held[0]()
    expect(await a).toStrictEqual(PLACED)
    expect((await nested({ pid: 200, tty: 'ttys011', rows }))?.pane).toEqual({ adapter: 'tmux', id: '%4:200:terminal-app' })
    clock.t = at + 14_999
    expect((await nested({ ...first, pid: 90 }))?.pane).toEqual({ adapter: 'tmux', id: '%3:90:terminal-app' })
    expect(listings()).toEqual([panesListed])
    // 5 s from its settle, the next ask lists again.
    clock.t = at + 15_000
    expect(await nested(first)).toStrictEqual(PLACED)
    expect(listings()).toEqual([panesListed, panesListed])
  })

  it('its lines name no pane, pid, tty, session or app', async () => {
    const others = Array.from({ length: PANES_A_LISTING }, (_, i) => paneLine(`%${i + 10}`, '/dev/ttys999', says(50))).join('')
    const lines: string[] = []
    for (const { logs, nested } of [
      nestedLookup({}, [], { panes: PANES, clients: ONE.clients }), nestedLookup({}, [], { panes: PANES, clients: '' }),
      nestedLookup({}, [1], { panes: PANES }), nestedLookup({}, [], { panes: others + PANES }),
    ]) {
      await nested(AGENT)
      lines.push(...logs)
    }
    expect(lines).toEqual([...found, ...none, ...notRead('pane'), over, ...none])
    for (const line of lines) {
      for (const id of [PANE, '4300', '100', 'ttys004', 'ttys010', 'work', 'com.apple.Terminal', 'Terminal', 'terminal-app']) expect(line).not.toContain(id)
    }
  })
})

/** tmux where the core found it, off the process's PATH: the master's PATH may hold no tmux. */
const ADOPTED = async (): Promise<TmuxPathOutcome> => ({ state: 'adopted', path: '/x/bin/tmux', from: 'login shell' })
const atPath = (call: Call): Call => ({ ...call, file: '/x/bin/tmux' })

describe('tmux as the core finds it', () => {
  it('a tmux found off the PATH runs at its path: the lookup places the agent in Terminal at its tty', async () => {
    const { calls, logs, outer } = lookup({ tmux: ADOPTED }, [], ONE)
    expect(await outer(NESTED, 100)).toEqual({ app: 'terminal-app', tty: '/dev/ttys004', pid: 4300, nest: 'tmux' })
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
    settle({ state: 'adopted', path: '/x/bin/tmux', from: 'login shell' })
    await Promise.all([first, second, shown, adapter.focus({ adapter: 'tmux', id: '%3:100' })])
    expect(finds).toBe(1)
  })
})
