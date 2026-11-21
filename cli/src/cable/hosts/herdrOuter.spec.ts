import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createHerdrOuter, HERDR_CLIENTS_A_LOOKUP, SKIPPED_IDS_KEPT, ttyAtime, type HerdrOuterDeps } from './herdrOuter.js'
import type { PtyProcess } from './scannedApp.js'

interface Call { file: string; args: string[]; timeoutMs: number }
/** What the fake lsof and ps print, and each tty's access time. */
interface Said { lsof?: string; ps?: string; atime?: Record<string, number | undefined> }

const LSOF = '/usr/sbin/lsof'
const PS = '/bin/ps'
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
const IN_TERMINAL = { app: 'terminal-app', tty: '/dev/ttys004' }
const found = ['[device] herdr client · found']
const none = ['[device] herdr client · none']
/** The lookup's line when a step could not be read, naming that step. */
const notRead = (why: 'processes' | 'sockets' | 'ttys' | 'app') => [`[device] herdr client · not read · ${why}`]

/** A recording runner that runs nothing, so no spec reads a process of this machine's: each call answers the next of
 *  [codes], then exit 0, lsof and ps print what [said] gives them, a tty's access time is [said]'s, and a process's
 *  terminal is the one the table gives it. */
function lookup(
  over: Partial<Omit<HerdrOuterDeps, 'processes'>> & { processes?: () => Promise<readonly PtyProcess[]> } = {},
  codes: Array<number | null> = [], said: Said = {},
) {
  const calls: Call[] = []
  const logs: string[] = []
  const stats: string[] = []
  const ttys: number[] = []
  const clock = { t: 1_000_000 }
  const table = over.processes ?? (async () => TABLE)
  let reads = 0
  const outer = createHerdrOuter({
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      const stdout = file === LSOF ? said.lsof ?? '' : file === PS ? said.ps ?? '' : ''
      return { code: codes.length ? codes.shift()! : 0, stdout }
    },
    tty: async (pid) => { ttys.push(pid); return (await table()).find((p) => p.pid === pid)?.tty },
    log: (line) => { logs.push(line) },
    now: () => clock.t,
    platform: 'darwin',
    roots: ['/Users/u/Applications/'],
    bundleId: async (bundle) => (bundle === '/Users/u/Applications/Terminal.app' ? 'com.apple.Terminal' : undefined),
    atime: async (tty) => { stats.push(tty); return said.atime?.[tty] },
    ...over,
    processes: async () => { reads++; return table() },
  })
  return { calls, logs, stats, ttys, clock, reads: () => reads, outer }
}

describe('the outer place of an agent in the person\'s herdr', () => {
  it('not herdr, a pane id or pid out of form, or off macOS: undefined at once, and nothing runs', () => {
    const { calls, reads, stats, outer } = lookup({}, [], ONE)
    const hints: Array<Record<string, string>> = [
      {}, { TMUX_PANE: '%3' }, { HERDR_PANE_ID: 'w1' }, { HERDR_PANE_ID: 'w1:p2; x' }, { HERDR_PANE_ID: '--help' },
      { HERDR_PANE_ID: 'w1:p2:terminal-app' },
    ]
    for (const hint of hints) expect(outer(hint, 100), JSON.stringify(hint)).toBeUndefined()
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(outer(PANE, pid), String(pid)).toBeUndefined()
    expect([calls, reads(), stats]).toEqual([[], 0, []])
    for (const platform of ['linux', 'win32'] as const) {
      const off = lookup({ platform }, [], ONE)
      expect(off.outer(PANE, 100), platform).toBeUndefined()
      expect([off.calls, off.reads(), off.stats], platform).toEqual([[], 0, []])
    }
  })

  it('one client in a Terminal tab: its app and tty', async () => {
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
    // Off macOS nothing is said.
    const off = lookup({ platform: 'linux' }, [], ONE)
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
    const cases: Array<[Record<string, number>, string]> = [
      [{ '/dev/ttys004': 2000, '/dev/ttys007': 1000 }, '/dev/ttys004'],
      [{ '/dev/ttys004': 1000, '/dev/ttys007': 2000 }, '/dev/ttys007'],
      [{ '/dev/ttys004': 1000, '/dev/ttys007': 1000 }, '/dev/ttys007'],
    ]
    for (const [atime, tty] of cases) {
      const { calls, logs, stats, outer } = lookup({ processes }, [], { ...TWO, atime })
      expect(await outer(PANE, 100), tty).toEqual({ app: 'terminal-app', tty })
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
      ['the lower pid unread', { ...TWO, atime: { '/dev/ttys007': 1000 } }, { app: 'terminal-app', tty: '/dev/ttys007' }, ['/dev/ttys004', '/dev/ttys007']],
      ['neither read: the higher pid', { ...TWO, atime: {} }, { app: 'terminal-app', tty: '/dev/ttys007' }, ['/dev/ttys004', '/dev/ttys007']],
      ['the higher pid out of form', { ...TWO, ps: '4300 ttys004\n4310 ??\n', atime: { '/dev/ttys004': 1000 } }, IN_TERMINAL, ['/dev/ttys004']],
      ['neither in form: the higher pid', { ...TWO, ps: '4300 ??\n4310 console\n' }, { app: 'terminal-app' }, []],
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

  it('a client gone before ps is dropped', async () => {
    const processes = async () => [...TABLE, ...SECOND]
    const { calls, logs, stats, outer } = lookup({ processes }, [0, 1], { ...TWO, ps: '4300 ttys004\n' })
    expect(await outer(PANE, 100)).toEqual(IN_TERMINAL)
    expect(calls).toEqual([lsofAsked('80,4300,4310'), psAsked('4300,4310')])
    expect(stats).toEqual([])
    expect(logs).toEqual(found)
  })

  it('a tty out of form: the app alone', async () => {
    for (const tty of ['console', '??', 'pts/3', 'ttys004/../x', 'ttys12345']) {
      const { logs, stats, outer } = lookup({}, [], { ...ONE, ps: `4300 ${tty}\n` })
      expect(await outer(PANE, 100), tty).toStrictEqual({ app: 'terminal-app' })
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

  it('a client whose parents name no listed app answers {}', async () => {
    const { logs, outer } = lookup({ bundleId: async () => 'com.example.other' }, [], ONE)
    expect(await outer(PANE, 100)).toEqual({})
    expect(logs).toEqual(none)
  })

  it('herdr in Herdr\'s terminal: the holder is under no root the scan reads, {}', async () => {
    const processes = async () => [
      ...TABLE.filter((p) => p.pid !== 4300), { pid: 4300, ppid: 4290, executable: HERDR },
      { pid: 4290, ppid: 1, executable: '/opt/herdr-core/libexec/herdr-core-holder' },
    ]
    const { logs, outer } = lookup({ processes }, [], ONE)
    expect(await outer(PANE, 100)).toEqual({})
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
    expect(await outer(PANE, 100)).toEqual({ app: 'terminal-app', tty: '/dev/ttys005' })
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
