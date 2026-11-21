import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RECORDED_HERDR } from '../../testing/recordedHerdr.js'
import {
  createHerdrOuter, FDS_A_PROCESS, HERDR_CLIENTS_A_LOOKUP, procSockets, SKIPPED_IDS_KEPT, ttyAtime, type HerdrOuterDeps,
} from './herdrOuter.js'
import { parseProcessNames, type PtyProcess } from './scannedApp.js'

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
const found = ['[device] herdr client · found']
const none = ['[device] herdr client · none']
/** The lookup's line when a step could not be read, naming that step. */
const notRead = (why: 'processes' | 'sockets' | 'ttys' | 'app') => [`[device] herdr client · not read · ${why}`]

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
  const outer = createHerdrOuter({
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
    // No multiplexer holds a client unless a spec's says so.
    inner: () => undefined,
    ...over,
    processes: async () => { reads++; return table() },
  })
  return { calls, logs, stats, ttys, held, clock, reads: () => reads, outer }
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
const ssAsked: Call = { file: SS, args: ['-xn'], timeoutMs: 10_000 }
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

  it('Windows: undefined at once and nothing runs', () => {
    const { calls, held, logs, reads, stats, ttys, outer } = lookup({ platform: 'win32' }, [], ONE)
    expect(outer(PANE, 100)).toBeUndefined()
    expect([calls, reads(), stats, ttys, held, logs]).toEqual([[], 0, [], [], [], []])
  })

  it('one client in a Terminal tab: its app, tty and process, as tmux\'s', async () => {
    const { calls, logs, reads, stats, outer } = lookup({}, [], ONE)
    expect(await outer(PANE, 100)).toEqual(IN_TERMINAL)
    expect(calls).toEqual([lsofAsked('80,4300'), psAsked('4300')])
    expect(reads()).toBe(1)
    // One client left: no tty's access time is asked.
    expect(stats).toEqual([])
    expect(logs).toEqual(found)
  })

  it('a pane id with herdr\'s letters, w2:pE, is looked up', async () => {
    const { calls, logs, outer } = lookup({}, [], ONE)
    expect(await outer({ HERDR_PANE_ID: 'w2:pE' }, 100)).toEqual(IN_TERMINAL)
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
    expect(await outer(PANE, 100)).toEqual(IN_TERMINAL)
    expect(ttys).toEqual([100, 90, 80])
    expect(calls).toEqual([lsofAsked('80,4300'), psAsked('4300')])
    expect(reads()).toBe(1)
    expect(logs).toEqual(found)
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
    expect(logs).toEqual(none)
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
      expect(logs, name).toEqual(none)
    }
  })

  it('a detached server with no client: {}', async () => {
    const table = TABLE.filter((p) => p.pid !== 4300)
    const { calls, logs, outer } = lookup({ processes: async () => table }, [], { ps: '80 ??\n' })
    expect(await outer(PANE, 100)).toEqual({})
    expect(calls).toEqual([psAsked('80')])
    expect(logs).toEqual(none)
  })

  it('a herdr agent command connected only to herdr.sock is no client', async () => {
    const table = [...TABLE, { pid: 4500, ppid: 4000, executable: HERDR }]
    const lsof = sockets({ 80: SERVER, 4300: [], 4500: [['0xc1', '->0xa3']] })
    const { calls, logs, outer } = lookup({ processes: async () => table }, [], { lsof, ps: '80 ??\n' })
    expect(await outer(PANE, 100)).toEqual({})
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
      expect(await outer(PANE, 100), name).toEqual({})
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
      expect(await outer(PANE, 100), tty).toStrictEqual({ app: 'terminal-app', tty, pid })
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
      expect(await outer(PANE, 100), name).toStrictEqual(answer)
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
    expect(await outer(PANE, 100)).toEqual(IN_TERMINAL)
    expect(calls).toEqual([lsofAsked('80,4300,4400'), psAsked('4300,4400')])
    expect(logs).toEqual(found)
  })

  // A client whose own pty the person's tmux or Zellij made: its parents end at the detached server. The agent's hints
  // are what herdr's server inherited when it started in that multiplexer's pane.
  it('a client whose terminal tmux made: tmux\'s lookup is asked for the client with the agent\'s hints, and its place is the answer', async () => {
    const processes = async () => [
      ...TABLE.filter((p) => p.pid !== 4300), { pid: 4400, ppid: 4399, executable: HERDR }, { pid: 4399, ppid: 4398, executable: '-zsh' },
      { pid: 4398, ppid: 1, executable: 'tmux' },
    ]
    const hints = { ...PANE, TMUX_PANE: '%3' }
    const place = { app: 'terminal-app', tty: '/dev/ttys004', pid: 4200 }
    const asked: Array<[Readonly<Record<string, string>>, number]> = []
    const inner = (said: Readonly<Record<string, string>>, pid: number) => {
      asked.push([said, pid])
      return said.TMUX_PANE ? Promise.resolve(place) : undefined
    }
    const lsof = sockets({ 80: SERVER, 4400: [['0xb4', '->0xa1']] })
    const { calls, logs, outer } = lookup({ processes, inner }, [], { lsof, ps: '4400 ttys009\n' })
    expect(await outer(hints, 100)).toStrictEqual(place)
    expect(asked).toEqual([[hints, 4400]])
    expect(calls).toEqual([lsofAsked('80,4400'), psAsked('4400')])
    expect(logs).toEqual(found)
  })

  it('the same through Zellij\'s', async () => {
    const processes = async () => [
      ...TABLE.filter((p) => p.pid !== 4300), { pid: 4400, ppid: 4399, executable: HERDR }, { pid: 4399, ppid: 4398, executable: '-zsh' },
      { pid: 4398, ppid: 1, executable: 'zellij' },
    ]
    const hints = { ...PANE, ZELLIJ_SESSION_NAME: 'work', ZELLIJ_PANE_ID: '0' }
    const place = { app: 'wezterm', pid: 4200 }
    const asked: Array<[Readonly<Record<string, string>>, number]> = []
    const inner = (said: Readonly<Record<string, string>>, pid: number) => {
      asked.push([said, pid])
      return said.ZELLIJ_SESSION_NAME ? Promise.resolve(place) : undefined
    }
    const lsof = sockets({ 80: SERVER, 4400: [['0xb4', '->0xa1']] })
    const { logs, outer } = lookup({ processes, inner }, [], { lsof, ps: '4400 ttys009\n' })
    expect(await outer(hints, 100)).toStrictEqual(place)
    expect(asked).toEqual([[hints, 4400]])
    expect(logs).toEqual(found)
  })

  // GNOME Terminal, Ptyxis, Konsole, Alacritty, xterm: the agent stays on herdr's page, and Linux's raise brings the
  // window of the client's process (design, Decided).
  it('a client in a terminal with no page and no multiplexer: the client\'s process alone', async () => {
    const XTERM = '/usr/bin/xterm'
    const processes = async () => [
      ...TABLE.filter((p) => p.pid !== 4298), { pid: 4298, ppid: 1, executable: XTERM },
      ...SECOND,
    ]
    // The client typed into last is the one asked of, and answered.
    const atime = { '/dev/ttys004': 1000, '/dev/ttys007': 2000 }
    const cases: Array<[string, (said: Readonly<Record<string, string>>, pid: number) => ReturnType<HerdrOuterDeps['inner']>]> = [
      ['in no multiplexer', () => undefined],
      ['a multiplexer that finds no app', () => Promise.resolve({})],
    ]
    for (const [name, answer] of cases) {
      const asked: number[] = []
      const inner = (said: Readonly<Record<string, string>>, pid: number) => { asked.push(pid); return answer(said, pid) }
      const { logs, outer } = lookup({ processes, inner }, [], { ...TWO, atime })
      expect(await outer(PANE, 100), name).toStrictEqual({ pid: 4310 })
      expect(asked, name).toEqual([4310])
      expect(logs, name).toEqual(none)
    }
    // Linux: the recorded clients, each in a terminal the dial lists no page for.
    const linux = onLinux(scene(), { ps: recordedTtys(P.clientA, P.clientB), atime: { '/dev/pts/0': 2000, '/dev/pts/2': 1000 } })
    expect(await linux.outer(LINUX_PANE, P.agent)).toStrictEqual({ pid: P.clientA })
    expect(linux.logs).toEqual(none)
  })

  it('a client with an app still wins over one inside tmux', async () => {
    const processes = async () => [
      ...TABLE, { pid: 4400, ppid: 4399, executable: HERDR }, { pid: 4399, ppid: 4398, executable: '-zsh' },
      { pid: 4398, ppid: 1, executable: 'tmux' },
    ]
    const asked: number[] = []
    const inner = (_: Readonly<Record<string, string>>, pid: number) => {
      asked.push(pid)
      return Promise.resolve({ app: 'wezterm', pid: 4200 })
    }
    const lsof = sockets({ 80: SERVER, 4300: [['0xb1', '->0xa2']], 4400: [['0xb4', '->0xa1']] })
    const atime = { '/dev/ttys004': 1000, '/dev/ttys009': 9000 }
    const { logs, outer } = lookup({ processes, inner }, [], { lsof, ps: '4300 ttys004\n4400 ttys009\n', atime })
    expect(await outer({ ...PANE, TMUX_PANE: '%3' }, 100)).toEqual(IN_TERMINAL)
    expect(asked).toEqual([])
    expect(logs).toEqual(found)
  })

  it('a client gone before ps is dropped', async () => {
    const processes = async () => [...TABLE, ...SECOND]
    const { calls, logs, stats, outer } = lookup({ processes }, [0, 1], { ...TWO, ps: '4300 ttys004\n' })
    expect(await outer(PANE, 100)).toEqual(IN_TERMINAL)
    expect(calls).toEqual([lsofAsked('80,4300,4310'), psAsked('4300,4310')])
    expect(stats).toEqual([])
    expect(logs).toEqual(found)
  })

  it('a tty out of form: the app and the client\'s process', async () => {
    for (const tty of ['console', '??', 'pts/3', 'ttys004/../x', 'ttys12345']) {
      const { logs, stats, outer } = lookup({}, [], { ...ONE, ps: `4300 ${tty}\n` })
      expect(await outer(PANE, 100), tty).toStrictEqual({ app: 'terminal-app', pid: 4300 })
      expect(stats, tty).toEqual([])
      expect(logs, tty).toEqual(found)
    }
  })

  it('ps rows out of form are passed over', async () => {
    const ps = ['4300\n', 'x ttys004\n', '0 ttys004\n', '43000000000 ttys004\n', '4300 ttys004 x\n'].join('')
    const { logs, outer } = lookup({}, [], { ...ONE, ps })
    expect(await outer(PANE, 100)).toEqual({})
    expect(logs).toEqual(none)
  })

  it('a client whose parents name no listed app: the client\'s process alone', async () => {
    const { logs, outer } = lookup({ bundleId: async () => 'com.example.other' }, [], ONE)
    expect(await outer(PANE, 100)).toStrictEqual({ pid: 4300 })
    expect(logs).toEqual(none)
  })

  it('herdr in Herdr\'s terminal: the holder is under no root the scan reads, the client\'s process alone', async () => {
    const processes = async () => [
      ...TABLE.filter((p) => p.pid !== 4300), { pid: 4300, ppid: 4290, executable: HERDR },
      { pid: 4290, ppid: 1, executable: '/opt/herdr-core/libexec/herdr-core-holder' },
    ]
    const { logs, outer } = lookup({ processes }, [], ONE)
    expect(await outer(PANE, 100)).toStrictEqual({ pid: 4300 })
    expect(logs).toEqual(none)
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
    expect(await outer(PANE, 100)).toStrictEqual({ app: 'terminal-app', tty: '/dev/ttys005', pid: 80 })
    expect(ttys).toEqual([100, 90, 80])
    expect(calls).toEqual([psAsked('80')])
    expect(logs).toEqual(found)
  })

  // Each exits 1 when a pid in its list has gone, with the rest of its output intact (macOS, 2026-11-19).
  it('lsof and ps that exit 1 with their output are read', async () => {
    const { logs, outer } = lookup({}, [1, 1], ONE)
    expect(await outer(PANE, 100)).toEqual(IN_TERMINAL)
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
    ]
    for (const [name, { calls, logs, outer }, ran, said] of cases) {
      expect(await outer(PANE, 100), name).toEqual({})
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
    expect(await other).toEqual(IN_TERMINAL)
    held[0]()
    expect([await first, await again]).toEqual([IN_TERMINAL, IN_TERMINAL])
    expect(lsofs()).toEqual([asked, asked])
    // The answer holds for that caller alone.
    const caller = outer(PANE, 90)
    await vi.waitFor(() => expect(lsofs().length).toBe(3))
    held[2]()
    expect(await caller).toEqual(IN_TERMINAL)
    // Asked again within 5 s of its start: the last answer, with nothing run.
    const count = calls.length
    clock.t = at + 4_999
    expect(await outer(PANE, 100)).toEqual(IN_TERMINAL)
    expect(calls.length).toBe(count)
    // At 5 s it runs again, while w1:p3's answer, asked later, still holds.
    clock.t = at + 5_000
    const later = outer(PANE, 100)
    expect(await outer({ HERDR_PANE_ID: 'w1:p3' }, 100)).toEqual(IN_TERMINAL)
    await vi.waitFor(() => expect(calls.slice(count)).toEqual([asked]))
    // Still in flight past its 5 s: one lookup, shared.
    clock.t = at + 10_001
    const stuck = outer(PANE, 100)
    expect(calls.slice(count)).toEqual([asked])
    held[3]()
    expect([await later, await stuck]).toEqual([IN_TERMINAL, IN_TERMINAL])
  })

  it('its lines name no pane, pid, tty, path, bundle or app', async () => {
    const lines: string[] = []
    for (const { logs, outer } of [lookup({}, [], ONE), lookup({}, [], { lsof: sockets({ 80: SERVER }), ps: '80 ??\n' }), lookup({}, [], { ...ONE, ps: '' })]) {
      await outer(PANE, 100)
      lines.push(...logs)
    }
    expect(lines).toEqual([...found, ...none, ...notRead('ttys')])
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
    expect(await outer(LINUX_PANE, P.agent)).toStrictEqual({ app: 'wezterm', tty: '/dev/pts/0', pid: P.clientA })
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
    expect(await outer(LINUX_PANE, P.agent)).toEqual({})
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
      expect(await outer(LINUX_PANE, P.agent), name).toStrictEqual(place)
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
    expect(await inDefault.outer(LINUX_PANE, P.agent)).toStrictEqual({ app: 'wezterm', tty: '/dev/pts/2', pid: P.clientB })
    expect(inDefault.calls).toEqual([ssAsked, psAsked(`${P.clientA},${P.clientB}`)])
    // An agent in the named session's pane: that server's one client.
    const inOther = onLinux(table, { ps: recordedTtys(P.otherClient), atime })
    expect(await inOther.outer({ HERDR_PANE_ID: 'w1:p1' }, P.otherShell)).toStrictEqual({ app: 'wezterm', tty: '/dev/pts/4', pid: P.otherClient })
    expect(inOther.calls).toEqual([ssAsked, psAsked(String(P.otherClient))])
    // A client-socket row the other way round, the named session's client's socket bound there and the default server's
    // its peer, makes no client of the default server either.
    const ss = `${RECORDED_HERDR.ss}u_str ESTAB 0      0      /home/u/.config/herdr/herdr-client.sock 60001            * 60002       \n`
    const sockets = {
      ...RECORDED_SOCKETS, [P.serverA]: [...RECORDED_SOCKETS[P.serverA], '60002'],
      [P.otherClient]: [...RECORDED_SOCKETS[P.otherClient], '60001'],
    }
    const otherWay = onLinux(table, { ps: recordedTtys(P.clientA, P.clientB), atime, ss, sockets })
    expect(await otherWay.outer(LINUX_PANE, P.agent)).toStrictEqual({ app: 'wezterm', tty: '/dev/pts/2', pid: P.clientB })
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
      expect(await outer(LINUX_PANE, P.agent), name).toEqual({})
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
    expect(await onNixos.outer(LINUX_PANE, P.agent)).toStrictEqual({ app: 'wezterm', tty: '/dev/pts/0', pid: P.clientA })
    expect(onNixos.calls).toEqual([ssAsked, { ...psAsked(String(P.clientA)), file: nixos }])
    const noPs = onLinux(table, { ps: recordedTtys(P.clientA) }, at(null))
    expect(await noPs.outer(LINUX_PANE, P.agent)).toEqual({})
    expect(noPs.calls).toEqual([ssAsked])
    expect(noPs.logs).toEqual(notRead('ttys'))
    const onMac = lookup(at(nixos), [], ONE)
    expect(await onMac.outer(PANE, 100)).toStrictEqual(IN_TERMINAL)
    expect(onMac.calls).toEqual([lsofAsked('80,4300'), psAsked('4300')])
  })

  it('Linux: a descriptor folder that cannot be read leaves that process out', async () => {
    const table = scene({ [P.terminalA]: 'wezterm-gui', [P.terminalB]: 'kitty' })
    const sockets = { ...RECORDED_SOCKETS, [P.clientA]: undefined }
    const { calls, logs, stats, outer } = onLinux(table, { ps: recordedTtys(P.clientB), sockets, atime: { '/dev/pts/0': 9000 } })
    expect(await outer(LINUX_PANE, P.agent)).toStrictEqual({ app: 'kitty', tty: '/dev/pts/2', pid: P.clientB })
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
    expect(await outer(LINUX_PANE, P.agent)).toStrictEqual({ app: 'kitty', tty: '/dev/pts/2', pid: P.clientB })
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
