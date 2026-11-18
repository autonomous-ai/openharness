/**
 * The home bridge's service (docs/plans/2026-11-18-linux-xdg-paths-design.md, The bridge service), on a home the move has
 * just left, written out on disk: what it serves, when it checks, who keeps the bridge, and how it goes. /proc's rows and
 * the Store's count are handed in; tmux is a private server of the test's own.
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { writeInstalledIndex, type InstalledDshRecord } from '../dsh/installed.js'
import { BRIDGE_FILE, makeRealFolders, writeBridge, type BridgeRecord } from '../homeMove/bridge.js'
import type { ProcRow } from '../homeMove/oldUsers.js'
import { writeMoveRecord, type MoveRecord } from '../homeMove/record.js'
import { harnessPaneOwner } from '../lib/harnessSessionLabel.js'
import { fakeCore } from '../testing/fakeCore.js'
import { isolatedTmux } from '../testing/isolatedTmux.js'
import { CHECK_MS, startHomeBridge, startHomeBridgeInCore, type HomeBridgeDeps } from './homeBridge.js'

const MOVED_AT = 1_700_001_234.56
/** A minute before the move. */
const OLD = MOVED_AT - 60
const ME = process.getuid!()
/** A data folder name that puts its socket past sockaddr_un's room (lib/localSocket.ts, 96 bytes): it is in the short folder. */
const LONG = 'x'.repeat(60)
const SOCKET = `daemon-${env.PORT}.sock`
const BRIDGED: MoveRecord = { version: 1, state: 'bridged', entries: 27, bytesCopied: 0, panes: 1, oldProcesses: 0, at: 1_700_001_235_000 }

const homes: string[] = []
const restore: Array<() => unknown> = []
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const undo of restore.splice(0)) await undo()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const hashed = (folder: string): string => createHash('sha256').update(folder).digest('hex').slice(0, 16)

/**
 * A home the move has just left: the XDG roots under it, ~/.harness holding a link per entry and its two real folders,
 * the daemon's socket in the state root's short folder, the connections bridge's socket and shim, the daemon's record
 * (its bound port, 4242), bridge.json and the move's record. Plain files stand in for the sockets: a hard link is made
 * to any file.
 */
function movedHome() {
  // In /tmp, so the old short socket path fits on any machine.
  const home = realpathSync(mkdtempSync('/tmp/hbs-'))
  homes.push(home)
  const oldHome = join(home, '.harness'), data = join(home, '.local', 'share', 'harness'), state = join(home, '.local', 'state', 'harness')
  mkdirSync(oldHome)
  for (const [name, root] of [['cli', data], ['connections', data], ['hook-routes', state], ['s', state], ['runtime', state]]) {
    mkdirSync(join(root, name), { recursive: true, mode: 0o700 })
    symlinkSync(join(root, name), join(oldHome, name))
  }
  makeRealFolders(oldHome)
  const dataDir = join(data, 'cli', LONG)
  mkdirSync(dataDir)
  writeFileSync(join(dataDir, `daemon-${env.PORT}.json`), JSON.stringify({ port: 4242, pipe: null, pid: null }))
  const socket = join(state, 's', hashed(dataDir), SOCKET)
  mkdirSync(dirname(socket), { mode: 0o700 })
  writeFileSync(socket, '')
  const connections = join(data, 'connections')
  writeFileSync(join(connections, 'bridge.sock'), '')
  writeFileSync(join(connections, 'mcp-shim.mjs'), '// the shim')
  const bridge: BridgeRecord = {
    version: 1, movedAt: MOVED_AT, oldHome, oldDataDir: join(oldHome, 'cli', LONG),
    oldTag: '0123456789abcdef', newTag: harnessPaneOwner(dataDir), panes: ['%1'],
  }
  writeBridge(state, bridge)
  writeMoveRecord(state, BRIDGED)
  return { home, oldHome, data, state, dataDir, socket, connections, bridge }
}

type Home = ReturnType<typeof movedHome>

/** Where an old client finds the daemon's socket: the old data folder's short folder, through the bridge's `s` link. */
const oldSocketLink = (h: Home): string => join(h.state, 's', hashed(h.bridge.oldDataDir), SOCKET)
const record = (h: Home): MoveRecord => JSON.parse(readFileSync(join(h.state, 'home-move.json'), 'utf8')) as MoveRecord
const sameFile = (a: string, b: string): boolean => lstatSync(a).ino === lstatSync(b).ino

let pids = 100
/** A process of this account that started a minute before the move. */
const row = (over: Partial<ProcRow>): ProcRow => ({ pid: pids++, uid: ME, startedAt: OLD, name: 'bash', exe: '/usr/bin/bash', parent: 1, ...over })

/**
 * The service on [h], on Linux, with no old user, no pane and no harness to set up, unless [over] says otherwise. A
 * member [over] sets to undefined is the service's own. The connections folder is named: off Linux its default is
 * ~/.harness's (lib/connectors/store.ts).
 */
function start(h: Home, over: Partial<HomeBridgeDeps> = {}) {
  const log = vi.fn()
  const deps: Partial<HomeBridgeDeps> = {
    platform: 'linux', home: h.home, environment: { HOME: h.home, HARNESS_CONNECTIONS_DIR: h.connections }, socket: h.socket,
    rows: () => [], tmux: () => ({ status: 1, stdout: '' }), setupsPending: async () => 0, log, ...over,
  }
  const given = Object.fromEntries(Object.entries(deps).filter(([, value]) => value !== undefined)) as Partial<HomeBridgeDeps>
  return { log, bridge: startHomeBridge(fakeCore({ dataDir: h.dataDir }), given) }
}

/** The check awaits only the Store's count: once the turns after it ran, it is over. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 3; turn++) await new Promise((done) => setTimeout(done, 0))
}

/** The one timer is the check's interval; the turns the tests wait on stay real. */
const fakeInterval = (): void => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) }

describe('the home bridge service', () => {
  it('with no bridge.json it starts nothing: no timer, no read of /proc, no file written; the same off Linux', async () => {
    fakeInterval()
    for (const [platform, keep] of [['linux', false], ['darwin', true]] as const) {
      const h = movedHome()
      if (!keep) rmSync(join(h.state, BRIDGE_FILE))
      const rows = vi.fn(() => [])
      const tmux = vi.fn(() => ({ status: 0, stdout: '' }))
      const setupsPending = vi.fn(async () => 0)
      const { bridge } = start(h, { platform, rows, tmux, setupsPending })
      bridge.connected()
      await settle()
      expect(vi.getTimerCount()).toBe(0)
      expect([rows, tmux, setupsPending].map((each) => each.mock.calls.length)).toEqual([0, 0, 0])
      expect(readdirSync(join(h.oldHome, 'hook-routes'))).toEqual([])
      expect(readdirSync(join(h.oldHome, 'connections'))).toEqual([])
      expect(existsSync(oldSocketLink(h))).toBe(false)
      bridge.stop()
    }
  })

  it('at its start, and each time the core connects, it serves the old paths', async () => {
    const h = movedHome()
    const { bridge, log } = start(h, { rows: () => [row({ name: 'claude' })] })
    const route = join(h.oldHome, 'hook-routes', `${h.bridge.newTag}.json`)
    expect(JSON.parse(readFileSync(route, 'utf8'))).toEqual({ dataDir: realpathSync(h.dataDir), port: 4242 })
    expect(sameFile(oldSocketLink(h), h.socket)).toBe(true)
    expect(sameFile(join(h.oldHome, 'connections', 'bridge.sock'), join(h.connections, 'bridge.sock'))).toBe(true)
    expect(sameFile(join(h.oldHome, 'connections', 'mcp-shim.mjs'), join(h.connections, 'mcp-shim.mjs'))).toBe(true)
    // The daemon started again: a new socket, and its route record to put back.
    rmSync(h.socket)
    writeFileSync(h.socket, '')
    rmSync(route)
    bridge.connected()
    expect(sameFile(oldSocketLink(h), h.socket)).toBe(true)
    expect(existsSync(route)).toBe(true)
    await settle()
    expect(log).not.toHaveBeenCalled()
    bridge.stop()
  })

  it('what could not be linked is logged once, not at each pass', () => {
    const h = movedHome()
    // A folder where the shim's link goes: nothing can be renamed over it.
    mkdirSync(join(h.oldHome, 'connections', 'mcp-shim.mjs', 'kept'), { recursive: true })
    const { bridge, log } = start(h, { rows: () => [row({ name: 'claude' })] })
    bridge.connected()
    bridge.connected()
    expect(log.mock.calls).toEqual([['home bridge: mcp-shim.mjs could not be linked where an old client looks for it']])
    bridge.stop()
  })

  it('with no socket path it serves the route and the connections, and no socket link', () => {
    const h = movedHome()
    const { bridge } = start(h, { socket: null, rows: () => [row({ name: 'claude' })] })
    expect(existsSync(oldSocketLink(h))).toBe(false)
    expect(existsSync(join(h.oldHome, 'hook-routes', `${h.bridge.newTag}.json`))).toBe(true)
    expect(sameFile(join(h.oldHome, 'connections', 'bridge.sock'), join(h.connections, 'bridge.sock'))).toBe(true)
    bridge.stop()
  })

  it('it checks at its start and every 10 minutes: one timer, unreferenced', async () => {
    fakeInterval()
    const every = vi.spyOn(globalThis, 'setInterval')
    const h = movedHome()
    const rows = vi.fn(() => [row({ name: 'claude' })])
    const { bridge } = start(h, { rows })
    await settle()
    expect(rows).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    expect((every.mock.results[0].value as NodeJS.Timeout).hasRef()).toBe(false)
    await vi.advanceTimersByTimeAsync(CHECK_MS - 1)
    expect(rows).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(rows).toHaveBeenCalledTimes(2)
    bridge.stop()
  })

  it.each<[string, (h: Home) => { rows: ProcRow[]; panes?: string }, number]>([
    ['an engine, by its name', () => ({ rows: [row({ name: 'claude', exe: '/opt/claude/versions/2.1.291' })] }), 1],
    ['an executable in the old tree', (h) => ({ rows: [row({ name: 'node', exe: join(h.oldHome, 'runtime', 'node-v24', 'bin', 'node') })] }), 1],
    ['an executable in a root its entries moved to', (h) => ({ rows: [row({ name: 'node', exe: join(h.state, 'runtime', 'node-v24', 'bin', 'node') })] }), 1],
    ['Desktop', () => ({ rows: [row({ name: 'harness', exe: '/tmp/.mount_HarnesAbC123/harness' })] }), 1],
    ['the Device app', () => ({ rows: [row({ name: 'harness-device', exe: '/usr/bin/harness-device' })] }), 1],
    ['a retagged pane\'s process, and its descendants', (h) => {
      const pane = row({}), child = row({ name: 'python3', exe: '/usr/bin/python3', parent: pane.pid }), another = row({})
      return { rows: [pane, child, another], panes: `${pane.pid} ${h.bridge.newTag}\n${another.pid} ${'0'.repeat(16)}\n` }
    }, 2],
  ])('it stays while an old user runs: %s', async (_, users, count) => {
    const h = movedHome()
    const { rows, panes = '' } = users(h)
    const setupsPending = vi.fn(async () => 0)
    const { bridge, log } = start(h, { rows: () => rows, tmux: () => ({ status: 0, stdout: panes }), setupsPending })
    await settle()
    expect(existsSync(join(h.state, BRIDGE_FILE))).toBe(true)
    expect(lstatSync(join(h.oldHome, 'cli')).isSymbolicLink()).toBe(true)
    expect(record(h)).toMatchObject({ state: 'bridged', oldProcesses: count })
    // An old user keeps the bridge whatever the Store says.
    expect(setupsPending).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    bridge.stop()
  })

  it('the record\'s oldProcesses is written when the count changes, not at each check', async () => {
    fakeInterval()
    const h = movedHome()
    const file = join(h.state, 'home-move.json')
    let users = [row({ name: 'claude' }), row({ name: 'codex' })]
    const { bridge } = start(h, { rows: () => users })
    await settle()
    expect(record(h).oldProcesses).toBe(2)
    utimesSync(file, 1_000, 1_000)
    await vi.advanceTimersByTimeAsync(CHECK_MS)
    await settle()
    expect(statSync(file).mtimeMs).toBe(1_000_000)
    users = users.slice(1)
    await vi.advanceTimersByTimeAsync(CHECK_MS)
    await settle()
    expect(record(h)).toMatchObject({ state: 'bridged', oldProcesses: 1 })
    bridge.stop()
  })

  it('once none is left it removes the bridge, deletes bridge.json, sets the record to moved, logs "home bridge: removed" once, and stops its timer', async () => {
    fakeInterval()
    const h = movedHome()
    let users = [row({ name: 'claude' })]
    const rows = vi.fn(() => users)
    const { bridge, log } = start(h, { rows })
    await settle()
    expect(existsSync(h.oldHome)).toBe(true)
    users = []
    await vi.advanceTimersByTimeAsync(CHECK_MS)
    await settle()
    expect(existsSync(h.oldHome)).toBe(false)
    expect(existsSync(oldSocketLink(h))).toBe(false)
    expect(existsSync(join(h.state, BRIDGE_FILE))).toBe(false)
    expect(record(h)).toMatchObject({ state: 'moved', oldProcesses: 0, entries: 27 })
    // What the links pointed to is whole.
    expect(readFileSync(join(h.connections, 'mcp-shim.mjs'), 'utf8')).toBe('// the shim')
    expect(existsSync(h.socket)).toBe(true)
    expect(log.mock.calls).toEqual([['home bridge: removed']])
    expect(vi.getTimerCount()).toBe(0)
    // Gone for good: a later connection serves nothing, and no check runs.
    bridge.connected()
    await vi.advanceTimersByTimeAsync(CHECK_MS)
    expect(existsSync(h.oldHome)).toBe(false)
    expect(rows).toHaveBeenCalledTimes(2)
  })

  it('the bridge waits while a harness\'s setup is pending', async () => {
    fakeInterval()
    const h = movedHome()
    let pending = 1
    const setupsPending = vi.fn(async () => pending)
    start(h, { setupsPending })
    await settle()
    expect(setupsPending).toHaveBeenCalledOnce()
    expect(existsSync(join(h.state, BRIDGE_FILE))).toBe(true)
    expect(existsSync(h.oldHome)).toBe(true)
    pending = 0
    await vi.advanceTimersByTimeAsync(CHECK_MS)
    await settle()
    expect(existsSync(join(h.state, BRIDGE_FILE))).toBe(false)
    expect(existsSync(h.oldHome)).toBe(false)
  })

  it('it counts the harnesses whose setup is pending in the Store\'s index: one marked needs-setup does not hold it', async () => {
    const h = movedHome()
    const dsh = join(h.data, 'dsh'), saved = env.DSH_DIR
    env.DSH_DIR = dsh
    restore.push(() => { env.DSH_DIR = saved })
    const harness = (id: string, over: Partial<InstalledDshRecord>): InstalledDshRecord =>
      ({ id, dir: join(dsh, ...id.split('/')), source: `https://github.com/${id}`, ref: null, commit: null, linked: false, installedAt: 1, ...over })
    writeInstalledIndex([harness('acme/notes', { setup: 'pending' }), harness('acme/draw', { setup: 'needs-setup' })])
    const { bridge } = start(h, { setupsPending: undefined })
    // The Store's module is loaded at the check: once it is here, the check that waited on it has ended.
    await import('../dsh/installed.js')
    await settle()
    expect(existsSync(join(h.state, BRIDGE_FILE))).toBe(true)
    bridge.stop()
    writeInstalledIndex([harness('acme/notes', {}), harness('acme/draw', { setup: 'needs-setup' })])
    start(h, { setupsPending: undefined })
    await vi.waitFor(() => expect(existsSync(join(h.state, BRIDGE_FILE))).toBe(false))
    expect(existsSync(h.oldHome)).toBe(false)
  })

  it('a ~/.harness that holds something else is left, and that is logged once', async () => {
    fakeInterval()
    const h = movedHome()
    writeFileSync(join(h.oldHome, 'notes.txt'), 'mine')
    const { log } = start(h)
    await settle()
    expect(readdirSync(h.oldHome)).toEqual(['notes.txt'])
    expect(existsSync(join(h.state, BRIDGE_FILE))).toBe(false)
    expect(record(h)).toMatchObject({ state: 'moved', oldProcesses: 0 })
    expect(log.mock.calls).toEqual([['home bridge: removed · ~/.harness holds something else, so it stays']])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('with no move record it still removes the bridge, and writes none', async () => {
    const h = movedHome()
    rmSync(join(h.state, 'home-move.json'))
    start(h)
    await settle()
    expect(existsSync(h.oldHome)).toBe(false)
    expect(existsSync(join(h.state, 'home-move.json'))).toBe(false)
  })

  it('a check that throws is logged and tried again at the next one', async () => {
    fakeInterval()
    const h = movedHome()
    const rows = vi.fn((): ProcRow[] => { throw new Error('/proc/stat gives no boot time') })
    // Whatever the Store's count rejects with is said too.
    const setupsPending = vi.fn(async () => 0).mockRejectedValueOnce('the index is busy')
    const { log } = start(h, { rows, setupsPending })
    await settle()
    expect(log.mock.calls).toEqual([['home bridge: a check failed: /proc/stat gives no boot time · tried again in 10 minutes']])
    expect(existsSync(join(h.state, BRIDGE_FILE))).toBe(true)
    rows.mockReturnValue([])
    await vi.advanceTimersByTimeAsync(CHECK_MS)
    await settle()
    expect(log.mock.calls.at(-1)).toEqual(['home bridge: a check failed: the index is busy · tried again in 10 minutes'])
    expect(existsSync(join(h.state, BRIDGE_FILE))).toBe(true)
    await vi.advanceTimersByTimeAsync(CHECK_MS)
    await settle()
    expect(existsSync(join(h.state, BRIDGE_FILE))).toBe(false)
  })

  it('stop() clears the timer, and a connection after it serves nothing', async () => {
    fakeInterval()
    const h = movedHome()
    const { bridge } = start(h, { rows: () => [row({ name: 'claude' })] })
    await settle()
    expect(vi.getTimerCount()).toBe(1)
    bridge.stop()
    expect(vi.getTimerCount()).toBe(0)
    rmSync(join(h.oldHome, 'hook-routes', `${h.bridge.newTag}.json`))
    bridge.connected()
    expect(readdirSync(join(h.oldHome, 'hook-routes'))).toEqual([])
  })

  it('reads the panes from tmux\'s default server: a pane carrying the new tag keeps the bridge', async () => {
    const tmux = await isolatedTmux()
    restore.push(() => tmux.close())
    // The service's own tmux call, on the test's server: TMUX outranks TMUX_TMPDIR.
    vi.stubEnv('TMUX', undefined)
    vi.stubEnv('TMUX_PANE', undefined)
    vi.stubEnv('TMUX_TMPDIR', tmux.root)
    const h = movedHome()
    await tmux.run('new-session', '-d', '-s', 'agent', 'sleep 600')
    await tmux.run('set-option', '-p', '-t', 'agent', '@harness_daemon', h.bridge.newTag)
    const pane = Number(await tmux.run('display-message', '-p', '-t', 'agent', '#{pane_pid}'))
    const { bridge } = start(h, { rows: () => [row({ pid: pane, name: 'sleep', exe: '/bin/sleep' })], tmux: undefined })
    await settle()
    expect(record(h).oldProcesses).toBe(1)
    expect(existsSync(h.oldHome)).toBe(true)
    bridge.stop()
  })

  it('in the core\'s process it is the same service, which the apps ask nothing', () => {
    // This test's home has no bridge: nothing starts.
    expect(startHomeBridgeInCore(fakeCore())).toEqual({})
  })
})
