/**
 * Who still uses the bridge (docs/plans/2026-11-18-linux-xdg-paths-design.md, The bridge service): one case per kind of
 * old user, the processes that are not one, and what the check reads of /proc, on a /proc written out here.
 */
import { realpathSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { procNow, type BridgeRecord } from './bridge.js'
import { oldUsers, procRows, type OldUserFacts, type ProcRow } from './oldUsers.js'

const BRIDGE: BridgeRecord = {
  version: 1, movedAt: 1_700_001_234.56, oldHome: '/h/.harness', oldDataDir: '/h/.harness/cli/data',
  oldTag: '0123456789abcdef', newTag: 'fedcba9876543210', panes: ['%1'],
}
const DATA = '/h/.local/share/harness', STATE = '/h/.local/state/harness'
const ME = 1000, SERVICE = 4000
const FACTS: OldUserFacts = {
  uid: ME, self: SERVICE, roots: [DATA, STATE], engines: new Set(['claude', 'codex']),
  apps: new Set(['harness', 'harness-device']), panePids: [],
}
/** A minute before the move, and a minute after it. */
const OLD = BRIDGE.movedAt - 60, NEW = BRIDGE.movedAt + 60

let pids = 100
/** A process of this account that started a minute before the move, under pid 1, unless [over] says otherwise. */
const row = (over: Partial<ProcRow>): ProcRow => ({ pid: pids++, uid: ME, startedAt: OLD, name: 'x', exe: null, parent: 1, ...over })

const count = (rows: ProcRow[], facts: Partial<OldUserFacts> = {}): number => oldUsers(BRIDGE, rows, { ...FACTS, ...facts })

describe('an old user, counted', () => {
  it('an engine by its name', () => {
    expect(count([row({ name: 'claude', exe: '/h/.local/share/claude/versions/2.1.291' })])).toBe(1)
    expect(count([row({ name: 'MainThread', exe: '/usr/local/bin/codex' })])).toBe(1)
  })

  it('an executable in the old tree', () => {
    expect(count([row({ name: 'node', exe: '/h/.harness/runtime/node-v24.11.0-linux-x64/bin/node' })])).toBe(1)
  })

  it('or in a root its entries moved to', () => {
    expect(count([row({ name: 'node', exe: `${STATE}/runtime/node-v24.11.0-linux-x64/bin/node` })])).toBe(1)
    expect(count([row({ name: 'harness-tui', exe: `${DATA}/bin/harness-tui` })])).toBe(1)
    expect(count([row({ name: 'node', exe: `${DATA}2/bin/node` })])).toBe(0)
  })

  it('Desktop, an AppImage\'s mount included', () => {
    expect(count([row({ name: 'harness', exe: '/opt/harness/harness' })])).toBe(1)
    expect(count([row({ name: 'harness', exe: '/tmp/.mount_HarnesAbC123/harness' })])).toBe(1)
  })

  it('the Device app', () => {
    expect(count([row({ name: 'harness-device', exe: '/usr/bin/harness-device' })])).toBe(1)
  })

  it('a retagged pane\'s process, and its descendants', () => {
    const server = row({ name: 'tmux: server', exe: '/usr/bin/tmux' })
    const pane = row({ name: 'bash', exe: '/usr/bin/bash', parent: server.pid })
    const child = row({ name: 'python3', exe: '/usr/bin/python3.12', parent: pane.pid })
    const grandchild = row({ name: 'make', exe: '/usr/bin/make', parent: child.pid })
    expect(count([server, pane, child, grandchild], { panePids: [pane.pid] })).toBe(3)
  })

  it('a process that started in the move\'s own second', () => {
    expect(count([row({ name: 'claude', startedAt: Math.floor(BRIDGE.movedAt) + 0.99 })])).toBe(1)
    expect(count([row({ name: 'claude', startedAt: Math.floor(BRIDGE.movedAt) + 1 })])).toBe(0)
  })
})

describe('not an old user', () => {
  it('a plain shell outside Harness\'s panes', () => {
    const terminal = row({ name: 'gnome-terminal-', exe: '/usr/libexec/gnome-terminal-server' })
    const shell = row({ name: 'bash', exe: '/usr/bin/bash', parent: terminal.pid })
    const server = row({ name: 'tmux: server', exe: '/usr/bin/tmux' })
    const ownPane = row({ name: 'zsh', exe: '/usr/bin/zsh', parent: server.pid })
    const retagged = row({ name: 'bash', exe: '/usr/bin/bash', parent: server.pid })
    // Only the retagged pane counts: the shell beside it under the same server, and the terminal's, do not.
    expect(count([terminal, shell, server, ownPane, row({ name: 'vim', exe: '/usr/bin/vim', parent: ownPane.pid }), retagged], { panePids: [retagged.pid] })).toBe(1)
  })

  it('the session manager and systemd --user', () => {
    const systemd = row({ name: 'systemd', exe: '/usr/lib/systemd/systemd' })
    const session = row({ name: 'gnome-session-b', exe: '/usr/libexec/gnome-session-binary', parent: systemd.pid })
    expect(count([systemd, session, row({ name: 'gnome-shell', exe: '/usr/bin/gnome-shell', parent: session.pid })])).toBe(0)
  })

  it('a process that started after the move, of any kind', () => {
    const pane = row({ name: 'bash', exe: '/usr/bin/bash', startedAt: NEW })
    expect(count([
      row({ name: 'claude', startedAt: NEW }),
      row({ name: 'node', exe: '/h/.harness/runtime/node-v24.11.0-linux-x64/bin/node', startedAt: NEW }),
      row({ name: 'node', exe: `${STATE}/runtime/node-v24.11.0-linux-x64/bin/node`, startedAt: NEW }),
      row({ name: 'harness', exe: '/tmp/.mount_HarnesAbC123/harness', startedAt: NEW }),
      row({ name: 'harness-device', exe: '/usr/bin/harness-device', startedAt: NEW }),
      pane,
      row({ name: 'python3', exe: '/usr/bin/python3.12', parent: pane.pid, startedAt: NEW }),
    ], { panePids: [pane.pid] })).toBe(0)
  })

  it('another account\'s process', () => {
    const pane = row({ name: 'bash', exe: '/usr/bin/bash', uid: 1001 })
    expect(count([
      row({ name: 'claude', uid: 1001 }),
      row({ name: 'node', exe: `${STATE}/runtime/node-v24.11.0-linux-x64/bin/node`, uid: 1001 }),
      row({ name: 'harness', exe: '/opt/harness/harness', uid: 0 }),
      pane,
    ], { panePids: [pane.pid] })).toBe(0)
  })

  it('the service\'s own process and its ancestors, a master that moved and re-executed in place', () => {
    const runtime = `${STATE}/runtime/node-v24.11.0-linux-x64/libexec/harnessd`
    const systemd = row({ name: 'systemd', exe: '/usr/lib/systemd/systemd' })
    // Started by systemd before the move, and the same process since: its executable is now in the new roots.
    const master = row({ name: 'harnessd', exe: `${runtime}/harnessd`, parent: systemd.pid })
    const service = row({ pid: SERVICE, name: 'harnessd-edge', exe: `${runtime}/harnessd-edge`, parent: master.pid })
    expect(count([systemd, master, service])).toBe(0)
  })
})

/** A process as /proc shows it: its status, its stat and its exe link (null: none, as a kernel thread's). */
interface FakeProcess { pid: number; uid: number; comm: string; ppid: number; ticks: number; exe: string | null }

const BTIME = 1_700_000_000

/**
 * A /proc holding [processes], as the kernel writes it, noting each path asked in [asked]. A process in [ended] is listed
 * and its exe link read, then it is gone.
 */
function fakeProc(processes: FakeProcess[], asked: string[], ended: readonly number[] = []): Parameters<typeof procRows>[0] {
  const files = new Map<string, string>([['/proc/stat', `cpu  1 2 3\nbtime ${BTIME}\nprocesses 9\n`], ['/proc/uptime', '1234.56 999.00\n']])
  const links = new Map<string, string>()
  for (const { pid, uid, comm, ppid, ticks, exe } of processes) {
    if (exe !== null) links.set(`/proc/${pid}/exe`, exe)
    if (ended.includes(pid)) continue
    files.set(`/proc/${pid}/status`, `Name:\t${comm}\nState:\tS (sleeping)\nTgid:\t${pid}\nPid:\t${pid}\nPPid:\t${ppid}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${uid}\t${uid}\t${uid}\t${uid}\n`)
    files.set(`/proc/${pid}/stat`, `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 ${ticks} 1000000 100 18446744073709551615\n`)
    files.set(`/proc/${pid}/environ`, 'API_TOKEN=secret\0')
    files.set(`/proc/${pid}/cmdline`, `${comm}\0--token\0secret\0`)
  }
  const missing = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  const fs = {
    readdirSync: (path: string) => {
      asked.push(path)
      if (path !== '/proc') throw missing(path)
      return ['1', 'self', 'stat', 'uptime', 'sys', ...processes.map(({ pid }) => String(pid))]
    },
    readFileSync: (path: string) => {
      asked.push(path)
      const text = files.get(path)
      if (text === undefined) throw missing(path)
      return text
    },
    readlinkSync: (path: string) => {
      asked.push(path)
      const target = links.get(path)
      if (target === undefined) throw missing(path)
      return target
    },
  }
  return fs as unknown as Parameters<typeof procRows>[0]
}

const CLAUDE: FakeProcess = { pid: 4242, uid: ME, comm: 'claude', ppid: 4200, ticks: 123_456, exe: '/h/.local/share/claude/versions/2.1.291' }
const KTHREAD: FakeProcess = { pid: 2, uid: 0, comm: 'kthreadd', ppid: 0, ticks: 0, exe: null }

describe('procRows', () => {
  it('reads nothing but status, stat and the exe link', () => {
    const asked: string[] = []
    expect(procRows(fakeProc([CLAUDE, KTHREAD], asked))).toEqual([
      { pid: 4242, uid: ME, startedAt: BTIME + 1234.56, name: 'claude', exe: CLAUDE.exe, parent: 4200 },
      { pid: 2, uid: 0, startedAt: BTIME, name: 'kthreadd', exe: null, parent: 0 },
    ])
    expect(asked.filter((path) => /(environ|cmdline)$/.test(path))).toEqual([])
    expect(asked.filter((path) => !/^\/proc(\/stat|\/\d+\/(status|stat|exe))?$/.test(path))).toEqual([])
  })

  it('a process that ends mid-read is skipped', () => {
    const ended: FakeProcess = { ...CLAUDE, pid: 4300 }
    expect(procRows(fakeProc([CLAUDE, ended], [], [ended.pid])).map(({ pid }) => pid)).toEqual([CLAUDE.pid])
  })

  it('a comm with spaces and brackets is read whole', () => {
    const odd: FakeProcess = { ...CLAUDE, comm: 'a) (b [c] d)' }
    expect(procRows(fakeProc([odd], []))).toEqual([
      { pid: 4242, uid: ME, startedAt: BTIME + 1234.56, name: 'a) (b [c] d)', exe: CLAUDE.exe, parent: 4200 },
    ])
  })

  it('with no boot time in /proc/stat it says so, rather than count no process as old', () => {
    const fs = fakeProc([CLAUDE], [])
    const real = fs!.readFileSync
    expect(() => procRows({ ...fs!, readFileSync: ((path: string) => path === '/proc/stat' ? 'cpu  1 2 3\n' : real(path, 'utf8')) as typeof real })).toThrow()
  })

  it.runIf(process.platform === 'linux')('reads this process from the real /proc, on the clock the move\'s time uses', () => {
    const me = procRows().find(({ pid }) => pid === process.pid)
    expect(me).toMatchObject({ uid: process.getuid!(), parent: process.ppid, exe: realpathSync(process.execPath) })
    // btime is a whole second: a start time is that close to the one this process counts.
    expect(Math.abs(me!.startedAt - (procNow() - process.uptime()))).toBeLessThan(2)
  })
})
