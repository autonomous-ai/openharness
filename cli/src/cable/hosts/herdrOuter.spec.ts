import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RECORDED_HERDR } from '../../testing/recordedHerdr.js'
import {
  createHerdrNested, createHerdrOuter, FDS_A_PROCESS, HERDR_CLIENTS_A_LOOKUP, procSockets, SKIPPED_IDS_KEPT, ttyAtime, type HerdrOuterDeps,
  type HerdrWindowsDeps,
} from './herdrOuter.js'
import { FRESH_WITHIN_MS, type Fresh } from './outer.js'
import { parseProcessNames, type PtyProcess, type WindowsProcess } from './scannedApp.js'

interface Call { file: string; args: string[]; timeoutMs: number }
/** What the fake lsof, ps and ss print, each tty's access time, and the socket inodes each process's descriptors hold
 *  (none: its folder cannot be read). */
interface Said {
  lsof?: string; ps?: string; ss?: string; atime?: Record<string, number | undefined>
  sockets?: Readonly<Record<number, readonly string[] | undefined>>
}

const LSOF = '/usr/sbin/lsof'
const PS = '/bin/ps'
const SS = '/usr/bin/ss'
const CONFIG = '/Users/u/.config/herdr'
const TERMINAL = '/Users/u/Applications/Terminal.app/Contents/MacOS/Terminal'
const HERDR = '/opt/homebrew/bin/herdr'
const PANE = { HERDR_PANE_ID: 'w1:p2' }
/** The agent (100) on a pty of a detached server's (80), which runs on none; a client (4300) in a Terminal tab. Each
 *  process's terminal is what the lookup's `tty` reads. */
const TABLE: PtyProcess[] = [
  { pid: 100, ppid: 90, tty: 'ttys010', executable: 'claude' }, { pid: 90, ppid: 80, tty: 'ttys010', executable: '/bin/zsh' },
  { pid: 80, ppid: 1, executable: HERDR },
  { pid: 4300, ppid: 4299, tty: 'ttys004', executable: HERDR }, { pid: 4299, ppid: 4298, tty: 'ttys004', executable: '-zsh' },
  { pid: 4298, ppid: 1, executable: TERMINAL },
]
/** A second client (4310), in another Terminal tab. */
const SECOND: PtyProcess[] = [
  { pid: 4310, ppid: 4309, tty: 'ttys007', executable: HERDR }, { pid: 4309, ppid: 4298, tty: 'ttys007', executable: '-zsh' },
]

/** lsof -F pdn rows: per pid, its descriptors' `d` and `n`, each with an `f` line before it as lsof prints. */
const sockets = (rows: Record<number, Array<[d: string, n: string]>>): string => Object.entries(rows)
  .map(([pid, held]) => `p${pid}\n${held.map(([d, n], at) => `f${at + 3}\nd${d}\nn${n}\n`).join('')}`).join('')
/** The server's descriptors: the clients' socket listening and one connection on it, and the API's socket. */
const SERVER: Array<[string, string]> = [['0xa1', `${CONFIG}/herdr-client.sock`], ['0xa2', `${CONFIG}/herdr-client.sock`], ['0xa3', `${CONFIG}/herdr.sock`]]
const ONE: Said = { lsof: sockets({ 80: SERVER, 4300: [['0xb1', '->0xa2']] }), ps: '4300 ttys004\n' }
const TWO: Said = { lsof: sockets({ 80: SERVER, 4300: [['0xb1', '->0xa2']], 4310: [['0xb2', '->0xa1']] }), ps: '4300 ttys004\n4310 ttys007\n' }
const lsofAsked = (pids: string): Call => ({ file: LSOF, args: ['-a', '-U', '-p', pids, '-F', 'pdn'], timeoutMs: 10_000 })
const psAsked = (pids: string): Call => ({ file: PS, args: ['-o', 'pid=,tty=', '-p', pids], timeoutMs: 10_000 })
const IN_TERMINAL = { app: 'terminal-app', tty: '/dev/ttys004', pid: 4300 }
/** A hooked lookup's answer once herdr's server made the caller's terminal: [place] on herdr's page. */
const herdrs = (place: object = {}) => ({ ...place, nest: 'herdr' })
const found = ['[device] herdr client · found']
/** A client found in no app: the window to raise is its process's, or on Windows its window owner's. */
const foundWindow = ['[device] herdr client · found · window']
const none = ['[device] herdr client · none']
/** The lookup's line when no herdr server made the caller's terminal: no client was looked for. */
const outside = ['[device] herdr client · outside']
/** The lookup's line when a step could not be read, naming that step. */
const notRead = (why: 'processes' | 'sockets' | 'ttys' | 'app') => [`[device] herdr client · not read · ${why}`]

/** Past every step an ask that runs takes before its first run. */
const ranBy = () => new Promise<void>((resolve) => { setImmediate(resolve) })
/** A recording runner that runs nothing, so no spec reads a process of this machine's: each call answers the next of
 *  [codes], then exit 0, lsof, any ps and ss print what [said] gives them, a tty's access time and a process's sockets are
 *  [said]'s, ss and ps are on the PATH, and a process's terminal is the one the table gives it. */
function lookup(
  over: Partial<Omit<HerdrOuterDeps, 'processes'>> & { processes?: () => Promise<readonly PtyProcess[]> } = {},
  codes: Array<number | null> = [], said: Said = {},
) {
  const calls: Call[] = []
  const logs: string[] = []
  const stats: string[] = []
  const ttys: number[] = []
  const held: number[] = []
  const clock = { t: 1_000_000 }
  const table = over.processes ?? (async () => TABLE)
  let reads = 0
  const deps: HerdrOuterDeps = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      const stdout = file === LSOF ? said.lsof ?? '' : file.endsWith('/ps') ? said.ps ?? '' : file === SS ? said.ss ?? '' : ''
      return { code: codes.length ? codes.shift()! : 0, stdout }
    },
    onPath: (name) => (name === 'ss' ? SS : name === 'ps' ? PS : null),
    sockets: async (pid) => { held.push(pid); return said.sockets?.[pid] },
    tty: async (pid) => { ttys.push(pid); return (await table()).find((p) => p.pid === pid)?.tty },
    log: (line) => { logs.push(line) },
    now: () => clock.t,
    platform: 'darwin',
    roots: ['/Users/u/Applications/'],
    bundleId: async (bundle) => (bundle === '/Users/u/Applications/Terminal.app' ? 'com.apple.Terminal' : undefined),
    atime: async (tty) => { stats.push(tty); return said.atime?.[tty] },
    ...over,
    processes: async () => { reads++; return table() },
  }
  // The process form is made on its first ask: each form keeps answers of its own.
  let nestedForm: ReturnType<typeof createHerdrNested> | undefined
  const nested: ReturnType<typeof createHerdrNested> = (found, opts) => (nestedForm ??= createHerdrNested(deps))(found, opts)
  return { calls, logs, stats, ttys, held, clock, reads: () => reads, outer: createHerdrOuter(deps), nested }
}

/** herdr's recorded Linux scene (RECORDED_HERDR): the default server with clients A and B, a `herdr agent wait`, the
 *  fake `claude` in pane w2:p1, and a named session's server with its client. */
const P = RECORDED_HERDR.pids
const LINUX_PANE = { HERDR_PANE_ID: 'w2:p1' }
/** The recorded processes, each with the terminal `ps -o tty=` gave it, less [gone]; each stand-in terminal (`pty`)
 *  [terminals] names by pid is that app's process. */
function scene(terminals: Readonly<Record<number, string>> = {}, gone: readonly number[] = []): PtyProcess[] {
  return parseProcessNames(RECORDED_HERDR.table).filter((p) => !gone.includes(p.pid)).map((p) => {
    const tty = RECORDED_HERDR.ttyOf[p.pid]?.trim()
    const named = { ...p, executable: terminals[p.pid] ?? p.executable }
    return tty && tty !== '?' ? { ...named, tty } : named
  })
}
/** Each herdr process's socket inodes, from its recorded descriptor links: a socket on two descriptors once. */
const RECORDED_SOCKETS: Record<number, string[]> = Object.fromEntries(Object.entries(RECORDED_HERDR.fds)
  .map(([pid, fds]) => [pid, [...new Set(fds.map(({ link }) => /^socket:\[([0-9]+)\]$/.exec(link)![1]))]]))
/** ps's recorded rows of [pids] alone, as `ps -p` prints them. */
const recordedTtys = (...pids: number[]): string => RECORDED_HERDR.ttys.split('\n')
  .filter((line) => pids.includes(Number(line.trim().split(/\s+/)[0]))).map((line) => `${line}\n`).join('')
/** ss's rows of the sockets bound at a client socket's path alone: the machine's whole table can pass 1 MiB. */
const ssAsked: Call = { file: SS, args: ['-xn', 'src', '*/herdr-client.sock'], timeoutMs: 10_000 }
/** The lookup on Linux over [table], with the recorded `ss -xn` and descriptors unless [said] gives others. */
function onLinux(table: readonly PtyProcess[], said: Said = {}, over: Parameters<typeof lookup>[0] = {}, codes: Array<number | null> = []) {
  return lookup({ platform: 'linux', processes: async () => table, ...over }, codes, { ss: RECORDED_HERDR.ss, sockets: RECORDED_SOCKETS, ...said })
}

describe('the outer place of an agent in the person\'s herdr', () => {
  it('not herdr, or a pane id or pid out of form: undefined at once, and nothing runs', () => {
    const { calls, reads, stats, outer } = lookup({}, [], ONE)
    const hints: Array<Record<string, string>> = [
      {}, { TMUX_PANE: '%3' }, { HERDR_PANE_ID: 'w1' }, { HERDR_PANE_ID: 'w1:p2; x' }, { HERDR_PANE_ID: '--help' },
      { HERDR_PANE_ID: 'w1:p2:terminal-app' },
    ]
    for (const hint of hints) expect(outer(hint, 100), JSON.stringify(hint)).toBeUndefined()
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(outer(PANE, pid), String(pid)).toBeUndefined()
    expect([calls, reads(), stats]).toEqual([[], 0, []])
  })

  it('Windows with no Windows table to read: undefined at once and nothing runs', () => {
    const { calls, held, logs, reads, stats, ttys, outer } = lookup({ platform: 'win32' }, [], ONE)
    expect(outer(PANE, 100)).toBeUndefined()
    expect([calls, reads(), stats, ttys, held, logs]).toEqual([[], 0, [], [], [], []])
  })

  it('one client in a Terminal tab: its app, tty and process, as tmux\'s', async () => {
    const { calls, logs, reads, stats, outer } = lookup({}, [], ONE)
    expect(await outer(PANE, 100)).toEqual(herdrs(IN_TERMINAL))
    expect(calls).toEqual([lsofAsked('80,4300'), psAsked('4300')])
    expect(reads()).toBe(1)
    // One client left: no tty's access time is asked.
    expect(stats).toEqual([])
    expect(logs).toEqual(found)
  })

  it('a pane id with herdr\'s letters, w2:pE, is looked up', async () => {
    const { calls, logs, outer } = lookup({}, [], ONE)
    expect(await outer({ HERDR_PANE_ID: 'w2:pE' }, 100)).toEqual(herdrs(IN_TERMINAL))
    expect(calls).toEqual([lsofAsked('80,4300'), psAsked('4300')])
    expect(logs).toEqual(found)
  })

  it('a pane id out of form is said skipped once per id, with no id in the line; no pane id says nothing', () => {
    const skipped = '[device] herdr client · skipped · pane-id'
    const { logs, outer } = lookup({}, [], ONE)
    expect(outer({}, 100)).toBeUndefined()
    expect(outer({ TMUX_PANE: '%3' }, 100)).toBeUndefined()
    expect(logs).toEqual([])
    expect(outer({ HERDR_PANE_ID: 'w1:pI' }, 100)).toBeUndefined()
    expect(outer({ HERDR_PANE_ID: 'w1:pI' }, 90)).toBeUndefined()
    expect(logs).toEqual([skipped])
    expect(outer({ HERDR_PANE_ID: 'w1:p2; x' }, 100)).toBeUndefined()
    expect(logs).toEqual([skipped, skipped])
    // The ids kept are bounded: the oldest goes, and is said again.
    for (let at = 0; at < SKIPPED_IDS_KEPT; at++) outer({ HERDR_PANE_ID: `bad-${at}` }, 100)
    expect(logs.length).toBe(2 + SKIPPED_IDS_KEPT)
    outer({ HERDR_PANE_ID: 'w1:pI' }, 100)
    expect(logs.length).toBe(3 + SKIPPED_IDS_KEPT)
    expect(new Set(logs)).toEqual(new Set([skipped]))
    // On Windows nothing is said.
    const off = lookup({ platform: 'win32' }, [], ONE)
    off.outer({ HERDR_PANE_ID: 'w1:pI' }, 100)
    expect(off.logs).toEqual([])
  })

  // One table read, then the caller's terminal and its parents' up to the server, which runs on none.
  it('the server is the herdr that made the caller\'s terminal', async () => {
    const { calls, logs, reads, ttys, outer } = lookup({}, [], ONE)
    expect(await outer(PANE, 100)).toEqual(herdrs(IN_TERMINAL))
    expect(ttys).toEqual([100, 90, 80])
    expect(calls).toEqual([lsofAsked('80,4300'), psAsked('4300')])
    expect(reads()).toBe(1)
    expect(logs).toEqual(found)
  })

  // The pane is herdr's from the maker's read on, whatever the clients' steps read: the agent is on herdr's page even
  // with no app known (Diego, 2026-11-23).
  it('the answer says herdr once its server made the caller\'s terminal: a client in an app, a client in no app, no client, a client inside the person\'s tmux, and the sockets or ttys not read', async () => {
    const inTmux = [
      ...TABLE.filter((p) => p.pid !== 4300),
      { pid: 4400, ppid: 4399, tty: 'ttys009', executable: HERDR }, { pid: 4399, ppid: 4398, tty: 'ttys009', executable: '-zsh' },
      { pid: 4398, ppid: 1, executable: 'tmux' },
    ]
    const cases: Array<[string, ReturnType<typeof lookup>, Record<string, unknown>, string[]]> = [
      ['a client in an app', lookup({}, [], ONE), { ...IN_TERMINAL, nest: 'herdr' }, found],
      ['a client in no app', lookup({ bundleId: async () => 'com.example.other' }, [], ONE), { pid: 4300, nest: 'herdr' }, foundWindow],
      ['no client', lookup({ processes: async () => TABLE.filter((p) => p.pid !== 4300) }, [], { ps: '80 ??\n' }), { nest: 'herdr' }, none],
      ['a client inside the person\'s tmux', lookup({ processes: async () => inTmux }, [], {
        lsof: sockets({ 80: SERVER, 4400: [['0xb4', '->0xa1']] }), ps: '4400 ttys009\n',
      }), { nest: 'herdr' }, none],
      ['the sockets not read', lookup({}, [null], ONE), { nest: 'herdr' }, notRead('sockets')],
      ['the ttys not read', lookup({}, [0, null], ONE), { nest: 'herdr' }, notRead('ttys')],
    ]
    for (const [name, { logs, outer }, answer, said] of cases) {
      expect(await outer(PANE, 100), name).toStrictEqual(answer)
      expect(logs, name).toEqual(said)
    }
  })

  it('a terminal started from a herdr pane, whose maker is not herdr, and a table not read answer {} with no nest', async () => {
    const fromPane = async () => [
      ...TABLE, { pid: 300, ppid: 90, tty: 'ttys010', executable: '/Applications/WezTerm.app/Contents/MacOS/wezterm-gui' },
      { pid: 301, ppid: 300, tty: 'ttys020', executable: '-zsh' }, { pid: 302, ppid: 301, tty: 'ttys020', executable: 'claude' },
    ]
    const cases: Array<[string, ReturnType<typeof lookup>, number]> = [
      ['a terminal started from a herdr pane', lookup({ processes: fromPane }, [], ONE), 302],
      ['a table not read', lookup({ processes: async () => { throw new Error('process table not read') } }, [], ONE), 100],
    ]
    for (const [name, { outer }, pid] of cases) {
      // An inherited pane id never puts the agent on herdr's page.
      const made = vi.fn()
      expect(await outer(PANE, pid, made), name).toStrictEqual({})
      expect(made, name).not.toHaveBeenCalled()
    }
  })

  // A herdr pane in iTerm2 stayed on iTerm2's page while the clients' steps ran, each up to 10 s (Mac eval IH4,
  // 2026-11-24): the pane is herdr's from the maker's read on.
  it('herdr\'s page is told once its server made the caller\'s terminal, before the clients\' steps end, to each ask that shares the answer', async () => {
    const held: Array<() => void> = []
    const { calls, outer } = lookup({
      run: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        if (file === LSOF) await new Promise<void>((settle) => held.push(settle))
        return { code: 0, stdout: file === LSOF ? ONE.lsof! : ONE.ps! }
      },
    })
    const made = vi.fn()
    const again = vi.fn()
    let settled = false
    const first = outer(PANE, 100, made)!
    void first.then(() => { settled = true })
    await vi.waitFor(() => expect(held.length).toBe(1))
    await vi.waitFor(() => expect(made.mock.calls).toEqual([['herdr']]))
    // Asked again while lsof runs: the same answer, and told too.
    const shared = outer(PANE, 100, again)
    await vi.waitFor(() => expect(again.mock.calls).toEqual([['herdr']]))
    expect(settled).toBe(false)
    held[0]()
    expect([await first, await shared]).toEqual([herdrs(IN_TERMINAL), herdrs(IN_TERMINAL)])
    expect(made.mock.calls).toEqual([['herdr']])
    expect(calls.filter((call) => call.file === LSOF)).toEqual([lsofAsked('80,4300')])
  })

  // On Linux every program started from a pane is its child: the herdr server is among a WezTerm's parents, and the
  // WezTerm's agents are no herdr client's.
  it('a terminal started from a herdr pane (made by WezTerm, a herdr among its parents): {} and no socket or tty command runs', async () => {
    const processes = async () => [
      ...TABLE, { pid: 300, ppid: 90, tty: 'ttys010', executable: '/Applications/WezTerm.app/Contents/MacOS/wezterm-gui' },
      { pid: 301, ppid: 300, tty: 'ttys020', executable: '-zsh' }, { pid: 302, ppid: 301, tty: 'ttys020', executable: 'claude' },
    ]
    const { calls, logs, ttys, outer } = lookup({ processes }, [], ONE)
    expect(await outer(PANE, 302)).toEqual({})
    expect(ttys).toEqual([302, 301, 300])
    expect(calls).toEqual([])
    expect(logs).toEqual(outside)
  })

  it('a terminal that cannot be read: not read · processes', async () => {
    const { calls, logs, outer } = lookup({ tty: async () => { throw new Error('tty not read') } }, [], ONE)
    expect(await outer(PANE, 100)).toEqual({})
    expect(calls).toEqual([])
    expect(logs).toEqual(notRead('processes'))
  })

  it('no herdr in the caller\'s parents: {} and nothing runs', async () => {
    const cases: Array<[string, ReturnType<typeof lookup>, number]> = [['a caller outside herdr', lookup({}, [], ONE), 4299]]
    for (const executable of ['/opt/bin/herdr-dev', 'herdrx', '/opt/herdr.app']) {
      const table = TABLE.map((p) => (p.pid === 80 ? { ...p, executable } : p))
      cases.push([executable, lookup({ processes: async () => table }, [], ONE), 100])
    }
    for (const [name, { calls, logs, outer }, pid] of cases) {
      expect(await outer(PANE, pid), name).toEqual({})
      expect(calls, name).toEqual([])
      expect(logs, name).toEqual(outside)
    }
  })

  it('a detached server with no client: {}', async () => {
    const table = TABLE.filter((p) => p.pid !== 4300)
    const { calls, logs, outer } = lookup({ processes: async () => table }, [], { ps: '80 ??\n' })
    expect(await outer(PANE, 100)).toEqual(herdrs())
    expect(calls).toEqual([psAsked('80')])
    expect(logs).toEqual(none)
  })

  it('a herdr agent command connected only to herdr.sock is no client', async () => {
    const table = [...TABLE, { pid: 4500, ppid: 4000, executable: HERDR }]
    const lsof = sockets({ 80: SERVER, 4300: [], 4500: [['0xc1', '->0xa3']] })
    const { calls, logs, outer } = lookup({ processes: async () => table }, [], { lsof, ps: '80 ??\n' })
    expect(await outer(PANE, 100)).toEqual(herdrs())
    expect(calls).toEqual([lsofAsked('80,4300,4500'), psAsked('80')])
    expect(logs).toEqual(none)
  })

  it('a client of another server, or a connection the other way, is no client', async () => {
    const cases: Array<[string, string]> = [
      ['another server\'s client', sockets({ 80: SERVER, 4300: [['0xb1', '->0xff']] })],
      ['the other way', sockets({ 80: [...SERVER, ['0xa9', '->0xb9']], 4300: [['0xb9', `${CONFIG}/herdr-client.sock`]] })],
    ]
    for (const [name, lsof] of cases) {
      const { calls, logs, outer } = lookup({}, [], { lsof, ps: '80 ??\n' })
      expect(await outer(PANE, 100), name).toEqual(herdrs())
      expect(calls, name).toEqual([lsofAsked('80,4300'), psAsked('80')])
      expect(logs, name).toEqual(none)
    }
  })

  it('two clients: the tty typed into last wins; on a tie the higher pid', async () => {
    const processes = async () => [...TABLE, ...SECOND]
    const cases: Array<[Record<string, number>, string, number]> = [
      [{ '/dev/ttys004': 2000, '/dev/ttys007': 1000 }, '/dev/ttys004', 4300],
      [{ '/dev/ttys004': 1000, '/dev/ttys007': 2000 }, '/dev/ttys007', 4310],
      [{ '/dev/ttys004': 1000, '/dev/ttys007': 1000 }, '/dev/ttys007', 4310],
    ]
    for (const [atime, tty, pid] of cases) {
      const { calls, logs, stats, outer } = lookup({ processes }, [], { ...TWO, atime })
      expect(await outer(PANE, 100), tty).toStrictEqual(herdrs({ app: 'terminal-app', tty, pid }))
      expect(calls, tty).toEqual([lsofAsked('80,4300,4310'), psAsked('4300,4310')])
      expect(stats, tty).toEqual(['/dev/ttys004', '/dev/ttys007'])
      expect(logs, tty).toEqual(found)
    }
  })

  // The tab closed between ps and stat, or its tty is out of form (PM, 2026-11-19).
  it('a client whose tty cannot be read loses to one that can', async () => {
    const processes = async () => [...TABLE, ...SECOND]
    const cases: Array<[string, Said, Record<string, unknown>, string[]]> = [
      ['the higher pid unread', { ...TWO, atime: { '/dev/ttys004': 1000 } }, IN_TERMINAL, ['/dev/ttys004', '/dev/ttys007']],
      ['the lower pid unread', { ...TWO, atime: { '/dev/ttys007': 1000 } }, { app: 'terminal-app', tty: '/dev/ttys007', pid: 4310 }, ['/dev/ttys004', '/dev/ttys007']],
      ['neither read: the higher pid', { ...TWO, atime: {} }, { app: 'terminal-app', tty: '/dev/ttys007', pid: 4310 }, ['/dev/ttys004', '/dev/ttys007']],
      ['the higher pid out of form', { ...TWO, ps: '4300 ttys004\n4310 ??\n', atime: { '/dev/ttys004': 1000 } }, IN_TERMINAL, ['/dev/ttys004']],
      ['neither in form: the higher pid', { ...TWO, ps: '4300 ??\n4310 console\n' }, { app: 'terminal-app', pid: 4310 }, []],
    ]
    for (const [name, said, answer, asked] of cases) {
      const { stats, outer } = lookup({ processes }, [], said)
      expect(await outer(PANE, 100), name).toStrictEqual(herdrs(answer))
      expect(stats, name).toEqual(asked)
    }
  })

  it('a client in tmux has no app, and loses to one in Terminal even when typed into last', async () => {
    const processes = async () => [
      ...TABLE, { pid: 4400, ppid: 4399, executable: HERDR }, { pid: 4399, ppid: 4398, executable: '-zsh' },
      { pid: 4398, ppid: 1, executable: 'tmux' },
    ]
    const lsof = sockets({ 80: SERVER, 4300: [['0xb1', '->0xa2']], 4400: [['0xb4', '->0xa1']] })
    const atime = { '/dev/ttys004': 1000, '/dev/ttys009': 9000 }
    const { calls, logs, outer } = lookup({ processes }, [], { lsof, ps: '4300 ttys004\n4400 ttys009\n', atime })
    expect(await outer(PANE, 100)).toEqual(herdrs(IN_TERMINAL))
    expect(calls).toEqual([lsofAsked('80,4300,4400'), psAsked('4300,4400')])
    expect(logs).toEqual(found)
  })

  // A client whose own pty the person's tmux, Zellij or another herdr made: its parents end at the detached server, so
  // no window holds it. herdr 0.9.5 strips the multiplexers' variables from its panes, so the agent's hints cannot name
  // that multiplexer's pane (the follow-ups design): the agent stays on herdr's page, and no raise is tried.
  it('a client whose terminal tmux, Zellij or herdr made: {}, its own terminal\'s maker read alone', async () => {
    for (const maker of ['tmux', 'zellij', HERDR]) {
      const processes = async () => [
        ...TABLE.filter((p) => p.pid !== 4300), ...SECOND,
        { pid: 4400, ppid: 4399, tty: 'ttys009', executable: HERDR }, { pid: 4399, ppid: 4398, tty: 'ttys009', executable: '-zsh' },
        { pid: 4398, ppid: 1, executable: maker },
      ]
      const lsof = sockets({ 80: SERVER, 4310: [['0xb2', '->0xa1']], 4400: [['0xb4', '->0xa1']] })
      // The client inside the multiplexer was typed into last: the one asked of.
      const atime = { '/dev/ttys007': 1000, '/dev/ttys009': 9000 }
      const { calls, logs, ttys, outer } = lookup({ processes, bundleId: async () => 'com.example.other' }, [], {
        lsof, ps: '4310 ttys007\n4400 ttys009\n', atime,
      })
      expect(await outer({ ...PANE, TMUX_PANE: '%3' }, 100), maker).toStrictEqual(herdrs())
      // Another herdr's server is a herdr process too, and no client of this one's.
      expect(calls, maker).toEqual([lsofAsked(maker === HERDR ? '80,4310,4398,4400' : '80,4310,4400'), psAsked('4310,4400')])
      expect(ttys, maker).toEqual([100, 90, 80, 4400, 4399, 4398])
      expect(logs, maker).toEqual(none)
    }
  })

  // GNOME Terminal, Ptyxis, Konsole, Alacritty, xterm: the agent stays on herdr's page, and Linux's raise brings the
  // window of the client's process (design, Decided).
  it('a client in a terminal with no page and no multiplexer: the client\'s process alone', async () => {
    const XTERM = '/usr/bin/xterm'
    const processes = async () => [
      ...TABLE.filter((p) => p.pid !== 4298), { pid: 4298, ppid: 1, executable: XTERM },
      ...SECOND,
    ]
    // The client typed into last is the one answered.
    const atime = { '/dev/ttys004': 1000, '/dev/ttys007': 2000 }
    const { logs, outer } = lookup({ processes }, [], { ...TWO, atime })
    expect(await outer(PANE, 100)).toStrictEqual(herdrs({ pid: 4310 }))
    expect(logs).toEqual(foundWindow)
    // Linux: the recorded clients, each in a terminal the dial lists no page for.
    const linux = onLinux(scene(), { ps: recordedTtys(P.clientA, P.clientB), atime: { '/dev/pts/0': 2000, '/dev/pts/2': 1000 } })
    expect(await linux.outer(LINUX_PANE, P.agent)).toStrictEqual(herdrs({ pid: P.clientA }))
    expect(linux.logs).toEqual(foundWindow)
  })

  it('a client gone before ps is dropped', async () => {
    const processes = async () => [...TABLE, ...SECOND]
    const { calls, logs, stats, outer } = lookup({ processes }, [0, 1], { ...TWO, ps: '4300 ttys004\n' })
    expect(await outer(PANE, 100)).toEqual(herdrs(IN_TERMINAL))
    expect(calls).toEqual([lsofAsked('80,4300,4310'), psAsked('4300,4310')])
    expect(stats).toEqual([])
    expect(logs).toEqual(found)
  })

  it('a tty out of form: the app and the client\'s process', async () => {
    for (const tty of ['console', '??', 'pts/3', 'ttys004/../x', 'ttys12345']) {
      const { logs, stats, outer } = lookup({}, [], { ...ONE, ps: `4300 ${tty}\n` })
      expect(await outer(PANE, 100), tty).toStrictEqual(herdrs({ app: 'terminal-app', pid: 4300 }))
      expect(stats, tty).toEqual([])
      expect(logs, tty).toEqual(found)
    }
  })

  it('ps rows out of form are passed over', async () => {
    const ps = ['4300\n', 'x ttys004\n', '0 ttys004\n', '43000000000 ttys004\n', '4300 ttys004 x\n'].join('')
    const { logs, outer } = lookup({}, [], { ...ONE, ps })
    expect(await outer(PANE, 100)).toEqual(herdrs())
    expect(logs).toEqual(none)
  })

  it('a client whose parents name no listed app: the client\'s process alone', async () => {
    const { logs, outer } = lookup({ bundleId: async () => 'com.example.other' }, [], ONE)
    expect(await outer(PANE, 100)).toStrictEqual(herdrs({ pid: 4300 }))
    expect(logs).toEqual(foundWindow)
  })

  it('herdr in Herdr\'s terminal: the holder is under no root the scan reads, the client\'s process alone', async () => {
    const processes = async () => [
      ...TABLE.filter((p) => p.pid !== 4300), { pid: 4300, ppid: 4290, executable: HERDR },
      { pid: 4290, ppid: 1, executable: '/opt/herdr-core/libexec/herdr-core-holder' },
    ]
    const { logs, outer } = lookup({ processes }, [], ONE)
    expect(await outer(PANE, 100)).toStrictEqual(herdrs({ pid: 4300 }))
    expect(logs).toEqual(foundWindow)
  })

  // herdr before 0.9.0 (#4500's macOS tests ran 0.8.0): `--no-session` ran the panes under the client itself, on ptys
  // it made, from its tab's. 0.9.0 removed it (RECORDED_HERDR.noSession), so this table is made up.
  it('--no-session: the client that made the panes\' terminals', async () => {
    const processes = async () => [
      { pid: 100, ppid: 90, tty: 'ttys011', executable: 'claude' }, { pid: 90, ppid: 80, tty: 'ttys011', executable: '/bin/zsh' },
      { pid: 80, ppid: 79, tty: 'ttys005', executable: HERDR }, { pid: 79, ppid: 4298, tty: 'ttys005', executable: '-zsh' },
      { pid: 4298, ppid: 1, executable: TERMINAL },
    ]
    const { calls, logs, ttys, outer } = lookup({ processes }, [], { ps: '80 ttys005\n' })
    expect(await outer(PANE, 100)).toStrictEqual(herdrs({ app: 'terminal-app', tty: '/dev/ttys005', pid: 80 }))
    expect(ttys).toEqual([100, 90, 80])
    expect(calls).toEqual([psAsked('80')])
    expect(logs).toEqual(found)
  })

  // Each exits 1 when a pid in its list has gone, with the rest of its output intact (macOS, 2026-11-19).
  it('lsof and ps that exit 1 with their output are read', async () => {
    const { logs, outer } = lookup({}, [1, 1], ONE)
    expect(await outer(PANE, 100)).toEqual(herdrs(IN_TERMINAL))
    expect(logs).toEqual(found)
  })

  it('each step not read says its word and answers {}, never a rejection', async () => {
    const roots = Object.assign([], { some: () => { throw new Error('roots not read') } })
    const cases: Array<[string, ReturnType<typeof lookup>, Call[], string[]]> = [
      ['the table is not read', lookup({ processes: async () => { throw new Error('process table not read') } }, [], ONE), [], notRead('processes')],
      ['lsof prints nothing', lookup({}, [1], { ...ONE, lsof: '' }), [lsofAsked('80,4300')], notRead('sockets')],
      ['lsof prints blanks', lookup({}, [], { ...ONE, lsof: ' \n' }), [lsofAsked('80,4300')], notRead('sockets')],
      ['lsof times out', lookup({}, [null], ONE), [lsofAsked('80,4300')], notRead('sockets')],
      ['lsof does not start', lookup({ run: async () => { throw new Error('spawn EACCES') } }, [], ONE), [], notRead('sockets')],
      ['ps prints nothing', lookup({}, [0, 1], { ...ONE, ps: '' }), [lsofAsked('80,4300'), psAsked('4300')], notRead('ttys')],
      ['ps times out', lookup({}, [0, null], ONE), [lsofAsked('80,4300'), psAsked('4300')], notRead('ttys')],
      ['the app scan throws', lookup({ roots }, [], ONE), [lsofAsked('80,4300'), psAsked('4300')], notRead('app')],
      // Any other step that throws is said as the app scan is: a lookup never rejects.
      ['a run throws at once', lookup({ run: () => { throw new Error('spawn EACCES') } }, [], ONE), [], notRead('app')],
      ['the terminal of a client in no app is not read', lookup({
        bundleId: async () => 'com.example.other',
        tty: async (pid) => { if (pid === 4300) throw new Error('tty not read'); return TABLE.find((p) => p.pid === pid)?.tty },
      }, [], ONE), [lsofAsked('80,4300'), psAsked('4300')], notRead('ttys')],
    ]
    for (const [name, { calls, logs, outer }, ran, said] of cases) {
      expect(await outer(PANE, 100), name).toEqual(name === 'the table is not read' ? {} : herdrs())
      expect(calls, name).toEqual(ran)
      expect(logs, name).toEqual(said)
    }
  })

  it('more than 16 herdr processes: the 16 newest are asked', async () => {
    const others = Array.from({ length: 20 }, (_, at) => ({ pid: 5001 + at, ppid: 1, executable: HERDR }))
    const { calls, outer } = lookup({ processes: async () => [...TABLE, ...others] }, [], ONE)
    await outer(PANE, 100)
    const newest = others.slice(-HERDR_CLIENTS_A_LOOKUP).map((p) => p.pid)
    expect(newest[0]).toBe(5005)
    expect(calls[0]).toEqual(lsofAsked(['80', ...newest].join(',')))
    // On Linux the descriptors read are the server's and those of the same newest 16.
    const linux = onLinux([...scene(), ...others])
    await linux.outer(LINUX_PANE, P.agent)
    expect(linux.held.sort((a, b) => a - b)).toEqual([P.serverA, ...newest])
  })

  // Command Code's turn-start comes at every tool call; a lookup is a table read, an lsof, a ps and plutil runs.
  it('one lookup per pane and caller in flight, and one every 5 s', async () => {
    const held: Array<() => void> = []
    const { calls, clock, outer } = lookup({
      run: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        if (file === LSOF) await new Promise<void>((settle) => held.push(settle))
        return { code: 0, stdout: file === LSOF ? ONE.lsof! : ONE.ps! }
      },
    })
    const lsofs = () => calls.filter((call) => call.file === LSOF)
    const asked = lsofAsked('80,4300')
    const at = clock.t
    const first = outer(PANE, 100)
    const again = outer(PANE, 100)
    await vi.waitFor(() => expect(lsofs()).toEqual([asked]))
    // Another pane is not held back by the first.
    clock.t = at + 1
    const other = outer({ HERDR_PANE_ID: 'w1:p3' }, 100)
    await vi.waitFor(() => expect(lsofs()).toEqual([asked, asked]))
    held[1]()
    expect(await other).toEqual(herdrs(IN_TERMINAL))
    held[0]()
    expect([await first, await again]).toEqual([herdrs(IN_TERMINAL), herdrs(IN_TERMINAL)])
    expect(lsofs()).toEqual([asked, asked])
    // The answer holds for that caller alone.
    clock.t = at + 3
    const caller = outer(PANE, 90)
    await vi.waitFor(() => expect(lsofs().length).toBe(3))
    held[2]()
    expect(await caller).toEqual(herdrs(IN_TERMINAL))
    // Asked again within 5 s of its settle: the last answer, with nothing run.
    const count = calls.length
    clock.t = at + 5_000
    const kept = outer(PANE, 100)
    await ranBy()
    expect(calls.length).toBe(count)
    expect(await kept).toEqual(herdrs(IN_TERMINAL))
    // At 5 s from its settle it runs again, while the caller's answer, settled later, still holds.
    clock.t = at + 5_001
    const later = outer(PANE, 100)
    expect(await outer(PANE, 90)).toEqual(herdrs(IN_TERMINAL))
    await vi.waitFor(() => expect(calls.slice(count)).toEqual([asked]))
    // Still in flight past its 5 s: one lookup, shared.
    clock.t = at + 10_002
    const stuck = outer(PANE, 100)
    expect(calls.slice(count)).toEqual([asked])
    held[3]()
    expect([await later, await stuck]).toEqual([herdrs(IN_TERMINAL), herdrs(IN_TERMINAL)])
    // A lookup that ran 5 s holds 5 s from its settle, not its start: an lsof that hangs costs one timeout.
    const settled = calls.length
    clock.t = at + 15_001
    const after = outer(PANE, 100)
    await ranBy()
    expect(calls.length).toBe(settled)
    expect(await after).toEqual(herdrs(IN_TERMINAL))
  })

  it('its lines name no pane, pid, tty, path, bundle or app', async () => {
    const lines: string[] = []
    const asks: Array<[ReturnType<typeof lookup>, number]> = [
      [lookup({}, [], ONE), 100], [lookup({}, [], { lsof: sockets({ 80: SERVER }), ps: '80 ??\n' }), 100],
      [lookup({}, [], { ...ONE, ps: '' }), 100], [lookup({}, [], ONE), 4299],
      [lookup({ bundleId: async () => 'com.example.other' }, [], ONE), 100],
    ]
    for (const [{ logs, outer }, pid] of asks) {
      await outer(PANE, pid)
      lines.push(...logs)
    }
    expect(lines).toEqual([...found, ...none, ...notRead('ttys'), ...outside, ...foundWindow])
    for (const line of lines) {
      for (const id of ['w1:p2', '80', '4300', '100', 'ttys004', CONFIG, 'herdr-client.sock', 'com.apple.Terminal', 'Terminal', 'terminal-app']) {
        expect(line).not.toContain(id)
      }
    }
  })
})

describe('herdr\'s clients on Linux', () => {
  it('Linux: one client in a WezTerm window: wezterm, its /dev/pts tty and its process', async () => {
    const table = scene({ [P.terminalA]: 'wezterm-gui' }, [P.clientB])
    const { calls, held, logs, reads, stats, ttys, outer } = onLinux(table, { ps: recordedTtys(P.clientA) })
    expect(await outer(LINUX_PANE, P.agent)).toStrictEqual(herdrs({ app: 'wezterm', tty: '/dev/pts/0', pid: P.clientA }))
    expect(ttys).toEqual([P.agent, P.agentShell, P.serverA])
    expect(calls).toEqual([ssAsked, psAsked(String(P.clientA))])
    // The descriptors read are those of herdr's own processes alone: the server and every other herdr.
    expect(held.sort((a, b) => a - b)).toEqual([P.clientA, P.serverA, P.agentWait, P.otherClient, P.otherServer])
    expect([reads(), stats]).toEqual([1, []])
    expect(logs).toEqual(found)
  })

  it('Linux: a herdr agent command is no client', async () => {
    // The default server and `herdr agent wait`, which is connected to herdr.sock alone.
    const table = scene({}, [P.clientA, P.clientB, P.terminalOther, P.otherClient, P.otherServer, P.otherShell])
    const { calls, logs, outer } = onLinux(table, { ps: recordedTtys(P.serverA) })
    expect(await outer(LINUX_PANE, P.agent)).toEqual(herdrs())
    expect(calls).toEqual([ssAsked, psAsked(String(P.serverA))])
    expect(logs).toEqual(none)
  })

  it('Linux: two clients: the pts typed into last wins; on a tie the higher pid', async () => {
    const table = scene({ [P.terminalA]: 'wezterm-gui', [P.terminalB]: 'kitty' })
    const cases: Array<[Record<string, number>, Record<string, string | number>]> = [
      [{ '/dev/pts/0': 2000, '/dev/pts/2': 1000 }, { app: 'wezterm', tty: '/dev/pts/0', pid: P.clientA }],
      [{ '/dev/pts/0': 1000, '/dev/pts/2': 2000 }, { app: 'kitty', tty: '/dev/pts/2', pid: P.clientB }],
      // Linux moves a tty's time only when its 8-second slot changes (RECORDED_HERDR.atime): keys into both clients
      // within one slot read the same.
      [{ '/dev/pts/0': 1000, '/dev/pts/2': 1000 }, { app: 'kitty', tty: '/dev/pts/2', pid: P.clientB }],
    ]
    for (const [atime, place] of cases) {
      const name = JSON.stringify(atime)
      const { calls, logs, stats, outer } = onLinux(table, { ps: recordedTtys(P.clientA, P.clientB), atime })
      expect(await outer(LINUX_PANE, P.agent), name).toStrictEqual(herdrs(place))
      expect(calls, name).toEqual([ssAsked, psAsked(`${P.clientA},${P.clientB}`)])
      expect(stats, name).toEqual(['/dev/pts/0', '/dev/pts/2'])
      expect(logs, name).toEqual(found)
    }
  })

  // A named session's server has a client socket of its own (sessions/<name>/herdr-client.sock): only peers of the
  // sockets the caller's server holds are its clients.
  it('a second server\'s clients are no clients, nor peers of another server\'s socket', async () => {
    const table = scene({ [P.terminalA]: 'wezterm-gui', [P.terminalB]: 'wezterm-gui', [P.terminalOther]: 'wezterm-gui' })
    // The named session's client is the one typed into last.
    const atime = { '/dev/pts/0': 1000, '/dev/pts/2': 2000, '/dev/pts/4': 9000 }
    const inDefault = onLinux(table, { ps: recordedTtys(P.clientA, P.clientB), atime })
    expect(await inDefault.outer(LINUX_PANE, P.agent)).toStrictEqual(herdrs({ app: 'wezterm', tty: '/dev/pts/2', pid: P.clientB }))
    expect(inDefault.calls).toEqual([ssAsked, psAsked(`${P.clientA},${P.clientB}`)])
    // An agent in the named session's pane: that server's one client.
    const inOther = onLinux(table, { ps: recordedTtys(P.otherClient), atime })
    expect(await inOther.outer({ HERDR_PANE_ID: 'w1:p1' }, P.otherShell)).toStrictEqual(herdrs({ app: 'wezterm', tty: '/dev/pts/4', pid: P.otherClient }))
    expect(inOther.calls).toEqual([ssAsked, psAsked(String(P.otherClient))])
    // A client-socket row the other way round, the named session's client's socket bound there and the default server's
    // its peer, makes no client of the default server either.
    const ss = `${RECORDED_HERDR.ss}u_str ESTAB 0      0      /home/u/.config/herdr/herdr-client.sock 60001            * 60002       \n`
    const sockets = {
      ...RECORDED_SOCKETS, [P.serverA]: [...RECORDED_SOCKETS[P.serverA], '60002'],
      [P.otherClient]: [...RECORDED_SOCKETS[P.otherClient], '60001'],
    }
    const otherWay = onLinux(table, { ps: recordedTtys(P.clientA, P.clientB), atime, ss, sockets })
    expect(await otherWay.outer(LINUX_PANE, P.agent)).toStrictEqual(herdrs({ app: 'wezterm', tty: '/dev/pts/2', pid: P.clientB }))
    expect(otherWay.calls).toEqual([ssAsked, psAsked(`${P.clientA},${P.clientB}`)])
  })

  it('Linux: no ss, an ss not read, or the server\'s descriptors not read: not read · sockets', async () => {
    const table = scene({ [P.terminalA]: 'wezterm-gui' })
    const cases: Array<[string, ReturnType<typeof onLinux>, Call[]]> = [
      ['no ss', onLinux(table, {}, { onPath: () => null }), []],
      ['ss prints nothing', onLinux(table, { ss: '' }, {}, [1]), [ssAsked]],
      ['ss times out', onLinux(table, {}, {}, [null]), [ssAsked]],
      ['ss does not start', onLinux(table, {}, { run: async () => { throw new Error('spawn EACCES') } }), []],
      ['the server\'s descriptors', onLinux(table, { sockets: { ...RECORDED_SOCKETS, [P.serverA]: undefined } }), [ssAsked]],
    ]
    for (const [name, { calls, logs, outer }, ran] of cases) {
      expect(await outer(LINUX_PANE, P.agent), name).toEqual(herdrs())
      expect(calls, name).toEqual(ran)
      expect(logs, name).toEqual(notRead('sockets'))
    }
    // With no ss nothing is read.
    expect(cases[0][1].held).toEqual([])
  })

  // NixOS has no /bin/ps: ps is where the PATH has it, as ss is. macOS's is always /bin/ps.
  it('Linux: ps is the one on the PATH, and with none the ttys are not read; macOS runs /bin/ps', async () => {
    const nixos = '/run/current-system/sw/bin/ps'
    const at = (ps: string | null) => ({ onPath: (name: string) => (name === 'ss' ? SS : name === 'ps' ? ps : null) })
    const table = scene({ [P.terminalA]: 'wezterm-gui' }, [P.clientB])
    const onNixos = onLinux(table, { ps: recordedTtys(P.clientA) }, at(nixos))
    expect(await onNixos.outer(LINUX_PANE, P.agent)).toStrictEqual(herdrs({ app: 'wezterm', tty: '/dev/pts/0', pid: P.clientA }))
    expect(onNixos.calls).toEqual([ssAsked, { ...psAsked(String(P.clientA)), file: nixos }])
    const noPs = onLinux(table, { ps: recordedTtys(P.clientA) }, at(null))
    expect(await noPs.outer(LINUX_PANE, P.agent)).toEqual(herdrs())
    expect(noPs.calls).toEqual([ssAsked])
    expect(noPs.logs).toEqual(notRead('ttys'))
    const onMac = lookup(at(nixos), [], ONE)
    expect(await onMac.outer(PANE, 100)).toStrictEqual(herdrs(IN_TERMINAL))
    expect(onMac.calls).toEqual([lsofAsked('80,4300'), psAsked('4300')])
  })

  it('Linux: a descriptor folder that cannot be read leaves that process out', async () => {
    const table = scene({ [P.terminalA]: 'wezterm-gui', [P.terminalB]: 'kitty' })
    const sockets = { ...RECORDED_SOCKETS, [P.clientA]: undefined }
    const { calls, logs, stats, outer } = onLinux(table, { ps: recordedTtys(P.clientB), sockets, atime: { '/dev/pts/0': 9000 } })
    expect(await outer(LINUX_PANE, P.agent)).toStrictEqual(herdrs({ app: 'kitty', tty: '/dev/pts/2', pid: P.clientB }))
    expect(calls).toEqual([ssAsked, psAsked(String(P.clientB))])
    expect(stats).toEqual([])
    expect(logs).toEqual(found)
  })

  it('Linux: ss rows out of form are passed over', async () => {
    const table = scene({ [P.terminalA]: 'wezterm-gui', [P.terminalB]: 'kitty' })
    const socket = '/home/u/.config/herdr/herdr-client.sock'
    // Client A's row (50265, peer 49272) in each form ss -xn does not print; client B's in a home whose path holds
    // a space.
    const rows = [
      RECORDED_HERDR.ss.split('\n')[0],
      `u_str ESTAB 0      0      ${socket} 50265            * 49272       users:(("herdr",pid=1303,fd=19))`,
      `u_str ESTAB 0      0      ${socket} 5026x            * 49272       `,
      `u_str ESTAB 0      0      ${socket} 50265            * 4927x       `,
      `u_str ESTAB 0      0      ${socket} 50265            *       `,
      `u_str ESTAB 0      0      ${socket} 50265            ${socket} 49272       `,
      `u_dgr ESTAB 0      0      ${socket} 50265            * 49272       `,
      `u_str ESTAB 0      0      ${socket}50265            * 49272       `,
      '',
      `u_str ESTAB 0      0      /home/u w/.config/herdr/herdr-client.sock 48696            * 48695       `,
    ]
    const { calls, logs, outer } = onLinux(table, { ss: `${rows.join('\n')}\n`, ps: recordedTtys(P.clientB) })
    expect(await outer(LINUX_PANE, P.agent)).toStrictEqual(herdrs({ app: 'kitty', tty: '/dev/pts/2', pid: P.clientB }))
    expect(calls).toEqual([ssAsked, psAsked(String(P.clientB))])
    expect(logs).toEqual(found)
  })

  it('Linux: its lines name no pane, pid, tty, path or app', async () => {
    const lines: string[] = []
    const table = scene({ [P.terminalA]: 'wezterm-gui' }, [P.clientB])
    for (const { logs, outer } of [
      onLinux(table, { ps: recordedTtys(P.clientA) }),
      onLinux(scene({}, [P.clientA, P.clientB]), { ps: recordedTtys(P.serverA) }),
      onLinux(table, {}, { onPath: () => null }),
    ]) {
      await outer(LINUX_PANE, P.agent)
      lines.push(...logs)
    }
    expect(lines).toEqual([...found, ...none, ...notRead('sockets')])
    for (const line of lines) {
      for (const id of ['w2:p1', ...Object.values(P).map(String), 'pts/', '/dev/', '/home/u', 'herdr-client.sock', 'wezterm', 'kitty']) {
        expect(line).not.toContain(id)
      }
    }
  })
})

/** The start marker (`w:<FILETIME>`) of the k-th process to start in Part 1's tree, so start order is not pid order; a
 *  fractional k starts between two. */
const mark = (k: number): string => `w:${134080735400000000n + BigInt(Math.round(k * 1000))}`
/** A row as the Windows lookup reads it: four columns, no command line. */
const winRow = (pid: number, ppid: number, executable: string, k: number): WindowsProcess => ({ pid, ppid, executable, startMarker: mark(k) })
/** The tree Part 1 recorded on Ken's VM (docs/plans/2026-11-25-dial-herdr-windows-app-design.md, "What Part 1 showed"),
 *  with its pids: the server (5992) a child of client #1 (8412) in a Windows Terminal tab, the caller (8976) in its
 *  pane, client #2 (9904) in VS Code's terminal, and client #3 (3720, the newest) in the console Win+R's default-terminal
 *  handoff opened. Part 1 gave no pid for #3: one lower than #2's pins that the newest is by start marker. */
const RECORDED_WINDOWS: readonly WindowsProcess[] = [
  winRow(5616, 4900, 'explorer.exe', 1),
  winRow(7588, 5616, 'WindowsTerminal.exe', 2),
  winRow(4008, 7588, 'OpenConsole.exe', 3),
  winRow(5512, 7588, 'powershell.exe', 4),
  winRow(8412, 5512, 'herdr.exe', 5),
  winRow(5992, 8412, 'herdr.exe', 6),
  winRow(2264, 5992, 'OpenConsole.exe', 7),
  winRow(8928, 5992, 'powershell.exe', 8),
  winRow(8976, 8928, 'powershell.exe', 9),
  winRow(5864, 5616, 'Code.exe', 10),
  winRow(6400, 5864, 'Code.exe', 11),
  winRow(6936, 6400, 'OpenConsole.exe', 12),
  winRow(9264, 6400, 'powershell.exe', 13),
  winRow(9904, 9264, 'herdr.exe', 14),
  winRow(5604, 5616, 'powershell.exe', 15),
  winRow(4168, 5604, 'conhost.exe', 16),
  winRow(3720, 5604, 'herdr.exe', 17),
]
const WIN_CALLER = 8976
const WIN_PANE = { HERDR_PANE_ID: 'w1:p1' }
/** Client #2 and its shell ended. */
const SECOND_GONE = [9904, 9264]
/** Client #1 and its tab's shell ended; the server's parent pid still names 8412. */
const FIRST_GONE = [8412, 5512]
/** The recorded tree less [gone], with [added]. */
const recorded = (gone: readonly number[] = [], added: readonly WindowsProcess[] = []): WindowsProcess[] =>
  [...RECORDED_WINDOWS.filter((p) => !gone.includes(p.pid)), ...added]
const IN_VSCODE = herdrs({ app: 'vscode', pid: 9904 })
const IN_WINDOWS_TERMINAL = herdrs({ pid: 7588 })

/** The lookup on Windows over [table]: herdr's marker names no server unless [over] says, and the table each marker
 *  check was given is kept. */
function onWindows(table: readonly WindowsProcess[], over: Partial<HerdrWindowsDeps> = {}) {
  let tables = 0
  const servers: Array<readonly WindowsProcess[]> = []
  const windows: HerdrWindowsDeps = {
    processes: async () => { tables++; return table },
    server: async (rows) => { servers.push(rows); return undefined },
    ...over,
  }
  return { ...lookup({ platform: 'win32', windows }), tables: () => tables, servers }
}
/** The Windows lookup's answer for the caller over [table]. */
const windowsPlace = (table: readonly WindowsProcess[]) => onWindows(table).outer(WIN_PANE, WIN_CALLER)

describe('herdr\'s clients on Windows', () => {
  it('the client in VS Code places the agent, before the newer one with no window', async () => {
    const { calls, logs, reads, servers, stats, tables, ttys, outer } = onWindows(RECORDED_WINDOWS)
    const made = vi.fn()
    expect(await outer(WIN_PANE, WIN_CALLER, made)).toStrictEqual(IN_VSCODE)
    await vi.waitFor(() => expect(made.mock.calls).toEqual([['herdr']]))
    // One read of the PTY host's table serves the server, the marker's check and every walk: nothing runs, and no
    // terminal is read, which Windows names none of.
    expect([tables(), servers, reads(), calls, ttys, stats]).toEqual([1, [RECORDED_WINDOWS], 0, [], [], []])
    expect(logs).toEqual(found)
  })

  // Decision 5: a client in a window beats a newer one in none, as a client in an app beats one in none.
  it('with client #2 gone, Windows Terminal\'s window beats the newer handoff client', async () => {
    const { logs, outer } = onWindows(recorded(SECOND_GONE))
    expect(await outer(WIN_PANE, WIN_CALLER)).toStrictEqual(IN_WINDOWS_TERMINAL)
    expect(logs).toEqual(foundWindow)
  })

  // Part 1 step 5: nothing in the tree links the handoff's console to a window.
  it('with client #1 gone too, no window', async () => {
    const { logs, outer } = onWindows(recorded([...SECOND_GONE, ...FIRST_GONE]))
    const made = vi.fn()
    expect(await outer(WIN_PANE, WIN_CALLER, made)).toStrictEqual(herdrs())
    await vi.waitFor(() => expect(made.mock.calls).toEqual([['herdr']]))
    expect(logs).toEqual(none)
  })

  // Part 1 step 4: the server keeps its first client's pid as its parent after that client ends, and Windows may hand
  // that pid to a newer process, which is never the server's client.
  it('a reused pid of the first client changes nothing', async () => {
    const reused = winRow(8412, 5616, 'Code.exe', 18)
    expect(await windowsPlace(recorded([...SECOND_GONE, ...FIRST_GONE], [reused]))).toStrictEqual(herdrs())
    expect(await windowsPlace(recorded(FIRST_GONE, [reused]))).toStrictEqual(IN_VSCODE)
  })

  it('an app beats a newer client in a terminal', async () => {
    const newer = [winRow(7700, 7588, 'powershell.exe', 18), winRow(7710, 7700, 'herdr.exe', 19)]
    expect(await windowsPlace(recorded([], newer))).toStrictEqual(IN_VSCODE)
  })

  it('a tie on the start marker goes to the higher pid', async () => {
    expect(await windowsPlace(recorded([], [winRow(9950, 9264, 'herdr.exe', 14)]))).toStrictEqual(herdrs({ app: 'vscode', pid: 9950 }))
  })

  // A pane's `herdr agent …` command, or a herdr client nested in a pane: as many as fill the bound, each newer than every
  // client, so taken as clients they would leave only Windows Terminal's window, the server's first client's.
  it('a herdr under the server is no client', async () => {
    const commands = Array.from({ length: HERDR_CLIENTS_A_LOOKUP }, (_, at) => winRow(9990 + at, 8928, 'herdr.exe', 18 + at / 100))
    expect(await windowsPlace(recorded([], commands))).toStrictEqual(IN_VSCODE)
  })

  // `herdr --session x` runs a server of its own under its client, in VS Code here: neither is ours.
  it('a named session\'s client is no client', async () => {
    const session = [
      winRow(7100, 6400, 'powershell.exe', 18), winRow(7110, 7100, 'herdr.exe', 19), winRow(7120, 7110, 'herdr.exe', 20),
    ]
    expect(await windowsPlace(recorded([], session))).toStrictEqual(IN_VSCODE)
  })

  // Started before client #2: its parent pid named another process, so it is no named session's server under #2.
  it('a herdr whose parent pid was reused is no child of it', async () => {
    expect(await windowsPlace(recorded([], [winRow(300, 9904, 'herdr.exe', 13)]))).toStrictEqual(IN_VSCODE)
  })

  it('a reused parent pid ends the walk', async () => {
    // Client #2's shell ended and a Code.exe took its pid: #2 is in no app.
    expect(await windowsPlace(recorded([9264], [winRow(9264, 5616, 'Code.exe', 20)]))).toStrictEqual(IN_WINDOWS_TERMINAL)
  })

  // The PTY host leaves the marker empty on a process it could not open: another account's.
  it('a row with no start marker is left out', async () => {
    for (const startMarker of [undefined, '']) {
      const table = RECORDED_WINDOWS.map((p) => (p.pid === 9904 ? { pid: 9904, ppid: 9264, executable: 'herdr.exe', startMarker } : p))
      expect(await windowsPlace(table), String(startMarker)).toStrictEqual(IN_WINDOWS_TERMINAL)
    }
  })

  it('at most 16 candidates, the newest', async () => {
    const twenty = (k: (i: number) => number) => Array.from({ length: 20 }, (_, at) => winRow(20001 + at, 5604, 'herdr.exe', k(at + 1)))
    // Newer than every client, in no window: #1 and #2 fall out of the bound.
    expect(await windowsPlace(recorded([], twenty((i) => 100 + i)))).toStrictEqual(herdrs())
    // Started before #2: #2 stays inside the bound, and its app places the agent.
    expect(await windowsPlace(recorded([], twenty((i) => 13 + i / 100)))).toStrictEqual(IN_VSCODE)
  })

  it('the table not read: {}, said, and herdr\'s page not told', async () => {
    const { logs, outer, servers } = onWindows([], { processes: async () => { throw new Error('process table not read') } })
    const made = vi.fn()
    expect(await outer(WIN_PANE, WIN_CALLER, made)).toStrictEqual({})
    expect(made).not.toHaveBeenCalled()
    expect(servers).toEqual([])
    expect(logs).toEqual(notRead('processes'))
  })

  // A powershell started in a Windows Terminal tab, the pane's variables kept: no herdr made its console.
  it('a maker that is not herdr: {} and outside', async () => {
    const { logs, outer, servers } = onWindows(recorded([], [winRow(6000, 5512, 'powershell.exe', 18)]))
    const made = vi.fn()
    expect(await outer(WIN_PANE, 6000, made)).toStrictEqual({})
    expect(made).not.toHaveBeenCalled()
    expect(servers).toEqual([])
    expect(logs).toEqual(outside)
  })

  // The hook sends no pane id for a named session: a second guard.
  it('the marker names another server: herdr\'s page with no client; ours: the client', async () => {
    const other = onWindows(RECORDED_WINDOWS, { server: async () => 1234 })
    const made = vi.fn()
    expect(await other.outer(WIN_PANE, WIN_CALLER, made)).toStrictEqual(herdrs())
    await vi.waitFor(() => expect(made.mock.calls).toEqual([['herdr']]))
    expect(other.logs).toEqual(none)
    const ours = onWindows(RECORDED_WINDOWS, { server: async () => 5992 })
    expect(await ours.outer(WIN_PANE, WIN_CALLER)).toStrictEqual(IN_VSCODE)
    expect(ours.logs).toEqual(found)
  })
})

// The open scan finds an idle agent whose terminal the person's herdr made, with no hook to name its pane (Diego's
// iTerm2 tab running herdr, 2026-11-22): it has read the table and the agent's maker already, and asks from the server on.
describe('the place of an agent the scan found in the person\'s herdr', () => {
  it('the hooked form\'s answer, with no table read and no maker read of the agent\'s own', async () => {
    const cases: Array<[string, Parameters<typeof lookup>[0]]> = [
      ['a client in a Terminal tab', {}], ['a client in no listed app', { bundleId: async () => 'com.example.other' }],
    ]
    for (const [name, over] of cases) {
      const hooked = lookup(over, [], ONE)
      const { nest, ...answer } = (await hooked.outer(PANE, 100))!
      expect(nest, name).toBe('herdr')
      const { calls, logs, reads, ttys, nested } = lookup(over, [], ONE)
      expect(await nested({ pid: 100, maker: 80, rows: TABLE }), name).toStrictEqual(answer)
      expect(calls, name).toEqual(hooked.calls)
      expect(reads(), name).toBe(0)
      // Only a client in no app has its own terminal's maker read.
      expect(ttys, name).toEqual(hooked.ttys.filter((pid) => ![100, 90, 80].includes(pid)))
      expect(logs, name).toEqual(hooked.logs)
    }
    expect(await lookup({}, [], ONE).nested({ pid: 100, maker: 80, rows: TABLE })).toStrictEqual(IN_TERMINAL)
  })

  it('Linux: one client in a WezTerm window', async () => {
    const table = scene({ [P.terminalA]: 'wezterm-gui' }, [P.clientB])
    const { calls, logs, reads, ttys, nested } = onLinux(table, { ps: recordedTtys(P.clientA) })
    expect(await nested({ pid: P.agent, maker: P.serverA, rows: table }))
      .toStrictEqual({ app: 'wezterm', tty: '/dev/pts/0', pid: P.clientA })
    expect(calls).toEqual([ssAsked, psAsked(String(P.clientA))])
    expect([reads(), ttys, logs]).toEqual([0, [], found])
  })

  it('Windows, or a pid or maker out of form: undefined at once, and nothing runs', () => {
    const off = lookup({ platform: 'win32' }, [], ONE)
    expect(off.nested({ pid: 100, maker: 80, rows: TABLE })).toBeUndefined()
    const on = lookup({}, [], ONE)
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(on.nested({ pid: bad, maker: 80, rows: TABLE }), `pid ${bad}`).toBeUndefined()
      expect(on.nested({ pid: 100, maker: bad, rows: TABLE }), `maker ${bad}`).toBeUndefined()
    }
    for (const { calls, held, logs, reads, stats, ttys } of [off, on]) {
      expect([calls, reads(), stats, ttys, held, logs]).toEqual([[], 0, [], [], [], []])
    }
  })

  it('one lookup per server in flight, and one every 5 s: two agents of one server share it', async () => {
    const held: Array<() => void> = []
    const { calls, clock, nested } = lookup({
      run: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        if (file === LSOF) await new Promise<void>((settle) => held.push(settle))
        return { code: 0, stdout: file === LSOF ? ONE.lsof! : ONE.ps! }
      },
    })
    // A second server (81), whose lookup is its own.
    const rows = [...TABLE, { pid: 200, ppid: 90, tty: 'ttys010', executable: 'claude' }, { pid: 81, ppid: 1, executable: HERDR }]
    const lsofs = () => calls.filter((call) => call.file === LSOF)
    const asked = lsofAsked('80,81,4300')
    const at = clock.t
    const first = nested({ pid: 100, maker: 80, rows })
    const again = nested({ pid: 200, maker: 80, rows })
    await vi.waitFor(() => expect(lsofs()).toEqual([asked]))
    // Another server is not held back by the first.
    clock.t = at + 1
    const other = nested({ pid: 100, maker: 81, rows })
    await vi.waitFor(() => expect(lsofs()).toEqual([asked, lsofAsked('81,80,4300')]))
    held[1]()
    expect(await other).toEqual({})
    held[0]()
    expect([await first, await again]).toEqual([IN_TERMINAL, IN_TERMINAL])
    // Asked again within 5 s of its settle, for any agent of that server: the last answer, with nothing run.
    const count = calls.length
    clock.t = at + 5_000
    const kept = nested({ pid: 300, maker: 80, rows })
    await ranBy()
    expect(calls.length).toBe(count)
    expect(await kept).toEqual(IN_TERMINAL)
    // At 5 s from its settle it runs again; still in flight past its 5 s, one lookup, shared.
    clock.t = at + 5_001
    const later = nested({ pid: 100, maker: 80, rows })
    await vi.waitFor(() => expect(calls.slice(count)).toEqual([asked]))
    clock.t = at + 10_002
    const stuck = nested({ pid: 200, maker: 80, rows })
    expect(calls.slice(count)).toEqual([asked])
    held[2]()
    expect([await later, await stuck]).toEqual([IN_TERMINAL, IN_TERMINAL])
  })

  // The scan asks for its sessions one at a time: an answer kept from the lsof's start would be gone after an lsof that
  // hung to its timeout, and every agent of that server asked after it would wait out one more.
  it('an lsof that ran 10 s holds 5 s from its settle: the asks after it run none', async () => {
    const held: Array<() => void> = []
    const { calls, clock, nested } = lookup({
      run: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        // The first lsof hangs; a second answers at once, so an ask that runs one fails rather than waits.
        if (file === LSOF && !held.length) await new Promise<void>((settle) => held.push(settle))
        return { code: 0, stdout: file === LSOF ? ONE.lsof! : ONE.ps! }
      },
    })
    const rows = [...TABLE, { pid: 200, ppid: 90, tty: 'ttys010', executable: 'claude' }]
    const lsofs = () => calls.filter((call) => call.file === LSOF)
    const at = clock.t
    const first = nested({ pid: 100, maker: 80, rows })
    await vi.waitFor(() => expect(lsofs()).toHaveLength(1))
    clock.t = at + 10_000
    held[0]()
    expect(await first).toEqual(IN_TERMINAL)
    const count = calls.length
    const next = nested({ pid: 200, maker: 80, rows })
    await ranBy()
    expect(calls.length).toBe(count)
    expect(await next).toEqual(IN_TERMINAL)
    clock.t = at + 14_999
    expect(await nested({ pid: 300, maker: 80, rows })).toEqual(IN_TERMINAL)
    expect(lsofs()).toHaveLength(1)
    // 5 s from its settle, the next ask runs again.
    clock.t = at + 15_000
    expect(await nested({ pid: 100, maker: 80, rows })).toEqual(IN_TERMINAL)
    expect(lsofs()).toHaveLength(2)
  })

  it('each step not read says its word and answers {}, never a rejection', async () => {
    const roots = Object.assign([], { some: () => { throw new Error('roots not read') } })
    const cases: Array<[string, ReturnType<typeof lookup>, Call[], string[]]> = [
      ['lsof prints nothing', lookup({}, [1], { ...ONE, lsof: '' }), [lsofAsked('80,4300')], notRead('sockets')],
      ['lsof times out', lookup({}, [null], ONE), [lsofAsked('80,4300')], notRead('sockets')],
      ['lsof does not start', lookup({ run: async () => { throw new Error('spawn EACCES') } }, [], ONE), [], notRead('sockets')],
      ['ps prints nothing', lookup({}, [0, 1], { ...ONE, ps: '' }), [lsofAsked('80,4300'), psAsked('4300')], notRead('ttys')],
      ['ps times out', lookup({}, [0, null], ONE), [lsofAsked('80,4300'), psAsked('4300')], notRead('ttys')],
      ['the app scan throws', lookup({ roots }, [], ONE), [lsofAsked('80,4300'), psAsked('4300')], notRead('app')],
      ['a run throws at once', lookup({ run: () => { throw new Error('spawn EACCES') } }, [], ONE), [], notRead('app')],
      ['the terminal of a client in no app is not read', lookup({
        bundleId: async () => 'com.example.other',
        tty: async (pid) => { if (pid === 4300) throw new Error('tty not read'); return TABLE.find((p) => p.pid === pid)?.tty },
      }, [], ONE), [lsofAsked('80,4300'), psAsked('4300')], notRead('ttys')],
    ]
    for (const [name, { calls, logs, nested }, ran, said] of cases) {
      expect(await nested({ pid: 100, maker: 80, rows: TABLE }), name).toEqual({})
      expect(calls, name).toEqual(ran)
      expect(logs, name).toEqual(said)
    }
    const table = scene({ [P.terminalA]: 'wezterm-gui' })
    const noSs = onLinux(table, {}, { onPath: () => null })
    expect(await noSs.nested({ pid: P.agent, maker: P.serverA, rows: table })).toEqual({})
    expect([noSs.calls, noSs.logs]).toEqual([[], notRead('sockets')])
  })

  it('its lines name no pane, pid, tty, path or app', async () => {
    const lines: string[] = []
    for (const { logs, nested } of [lookup({}, [], ONE), lookup({}, [], { lsof: sockets({ 80: SERVER }), ps: '80 ??\n' }), lookup({}, [], { ...ONE, ps: '' })]) {
      await nested({ pid: 100, maker: 80, rows: TABLE })
      lines.push(...logs)
    }
    expect(lines).toEqual([...found, ...none, ...notRead('ttys')])
    for (const line of lines) {
      for (const id of ['80', '4300', '100', 'ttys004', CONFIG, 'herdr-client.sock', 'com.apple.Terminal', 'Terminal', 'terminal-app']) {
        expect(line).not.toContain(id)
      }
    }
  })
})

// Eval I13: the person detaches, attaches from another tab and types nothing; a tap or rest asks fresh and must see
// the client's new tab, while a hook's turn-start, at every tool call, keeps the 5 s hold.
describe('a fresh ask of herdr\'s lookups', () => {
  /** A run that records each call; lsof and ss print [said]'s, and ps the next of [ps], then the last. */
  function rerun(said: Said, ps: string[]) {
    const ran: Call[] = []
    const run: HerdrOuterDeps['run'] = async (file, args, timeoutMs) => {
      ran.push({ file, args, timeoutMs })
      const stdout = file === LSOF ? said.lsof! : file === SS ? said.ss! : ps.length > 1 ? ps.shift()! : ps[0]
      return { code: 0, stdout }
    }
    return { ran, run }
  }
  const table = scene({ [P.terminalA]: 'wezterm-gui' }, [P.clientB])
  /** Each platform's lookups, whose client is in tab 1, then in tab 2; the command that reads the client's sockets; and
   *  the hooked and the scan's ask. */
  const platforms = [
    {
      name: 'macOS', sockets: LSOF, tabs: ['/dev/ttys004', '/dev/ttys005'], place: (tty: string) => ({ ...IN_TERMINAL, tty }),
      made: () => {
        const { ran, run } = rerun(ONE, ['4300 ttys004\n', '4300 ttys005\n'])
        return { ran, ...lookup({ run }, [], ONE) }
      },
      outer: (l: ReturnType<typeof lookup>, opts?: Fresh) => l.outer(PANE, 100, undefined, opts),
      nested: (l: ReturnType<typeof lookup>, opts?: Fresh) => l.nested({ pid: 100, maker: 80, rows: TABLE }, opts),
    },
    {
      name: 'Linux', sockets: SS, tabs: ['/dev/pts/0', '/dev/pts/6'], place: (tty: string) => ({ app: 'wezterm', tty, pid: P.clientA }),
      made: () => {
        const { ran, run } = rerun({ ss: RECORDED_HERDR.ss }, [recordedTtys(P.clientA), recordedTtys(P.clientA).replace('pts/0', 'pts/6')])
        return { ran, ...onLinux(table, {}, { run }) }
      },
      outer: (l: ReturnType<typeof lookup>, opts?: Fresh) => l.outer(LINUX_PANE, P.agent, undefined, opts),
      nested: (l: ReturnType<typeof lookup>, opts?: Fresh) => l.nested({ pid: P.agent, maker: P.serverA, rows: table }, opts),
    },
  ]

  for (const form of ['outer', 'nested'] as const) {
    it(`a fresh ask past the second reads herdr's client again inside the 5 s hold (${form})`, async () => {
      for (const { name, sockets, tabs, place, made, ...asks } of platforms) {
        const l = made()
        const ask = (opts?: Fresh) => asks[form](l, opts)
        const answer = (tty: string) => (form === 'outer' ? herdrs(place(tty)) : place(tty))
        expect(await ask(), name).toEqual(answer(tabs[0]))
        // Within 999 ms a fresh ask shares the answer: nothing new runs.
        l.clock.t += FRESH_WITHIN_MS - 1
        const count = l.ran.length
        expect(await ask({ fresh: true }), name).toEqual(answer(tabs[0]))
        expect(l.ran.length, name).toBe(count)
        // At the second it reads the client again, and the new answer is held for a plain ask.
        l.clock.t += 1
        expect(await ask({ fresh: true }), name).toEqual(answer(tabs[1]))
        expect(await ask(), name).toEqual(answer(tabs[1]))
        expect(l.ran.filter((call) => call.file === sockets), name).toHaveLength(2)
      }
    })
  }
})

describe('a process\'s sockets', () => {
  it('procSockets reads at most 1024 descriptors and only socket links', async () => {
    // A temp folder stands in for /proc: <pid>/fd/<n> links, as Linux gives them.
    const proc = mkdtempSync(join(tmpdir(), 'herdr-proc-'))
    const fds = (pid: number): string => {
      const folder = join(proc, String(pid), 'fd')
      mkdirSync(folder, { recursive: true })
      return folder
    }
    try {
      // The server's recorded descriptors, a socket on two of them, beside descriptors that are no socket.
      const server = fds(P.serverA)
      for (const { fd, link } of RECORDED_HERDR.fds[P.serverA]) symlinkSync(link, join(server, String(fd)))
      const others = ['/dev/null', 'pipe:[4242]', 'anon_inode:[eventfd]', '/dev/pts/1', 'socket:[x]', 'socket:[50239] ', 'socket:[]']
      others.forEach((link, at) => symlinkSync(link, join(server, String(30 + at))))
      // A file that is no link.
      writeFileSync(join(server, '40'), '')
      expect([...(await procSockets(P.serverA, proc)) ?? []].sort()).toEqual([...RECORDED_SOCKETS[P.serverA]].sort())
      // More descriptors than the bound: that many are read.
      const many = fds(4000)
      for (let fd = 0; fd < FDS_A_PROCESS + 100; fd++) symlinkSync(`socket:[${70_000 + fd}]`, join(many, String(fd)))
      expect((await procSockets(4000, proc))?.length).toBe(FDS_A_PROCESS)
      // A folder that cannot be read, as a process gone: none.
      expect(await procSockets(4001, proc)).toBeUndefined()
    } finally {
      rmSync(proc, { recursive: true, force: true })
    }
  })
})

describe('a tty\'s access time', () => {
  it('ttyAtime reads a file\'s access time, and nothing for a path that is not there', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'herdr-outer-'))
    try {
      const file = join(folder, 'tty')
      writeFileSync(file, '')
      expect(await ttyAtime(file)).toBe(statSync(file).atimeMs)
      expect(await ttyAtime(join(folder, 'gone'))).toBeUndefined()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
