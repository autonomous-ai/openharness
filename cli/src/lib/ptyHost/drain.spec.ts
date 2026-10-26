import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PtyHostBackend as PtyHostBackendType } from '../ptyHostBackend.js'
import type { TerminalBackend } from '../terminalBackend.js'
import { removeTree, SHELL } from '../terminalBackend.contract.js'
import { TerminalBackendCoordinator } from '../terminalBackendCoordinator.js'
import { terminalRouteKey } from '../terminalRuntime.js'
import type { ProcessRow } from '../processTable.js'
import type { PtyRuntimeRef, TerminalInventoryResult } from '../terminalTypes.js'
import { PtyHostClient } from './client.js'
import { discoveryFileName } from './instance.js'
import type { PtyHostTarget, ReachPtyHostResult } from './launch.js'
import { helloProof, PTY_PROTOCOL, SHUTDOWN_PROTOCOL, type PtyEvent, type PtyOp } from './protocol.js'

// The Windows seams, watched: a drain backend must never install them (they are the create backend's).
vi.mock('../processTable.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../processTable.js')>()
  return { ...actual, setProcessTableSource: vi.fn(actual.setProcessTableSource) }
})

const { PtyHostBackend } = await import('../ptyHostBackend.js')
const { EMPTY_PASSES, isDrainBackend, ptyHostBackends, ptyHostOnProbation, PtyHostDrain, rowInstancesOf, rowsOnInstance, untilHostAttached, withoutCreateHost } = await import('./drain.js')
const { listDiscoveries, readInstanceDiscovery, removeUnusedPtyVersions, targetHost } = await import('./launch.js')
const { setProcessTableSource } = await import('../processTable.js')

const OLD = PTY_PROTOCOL - 1
const cleanup: Array<() => unknown> = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const step of cleanup.splice(0).reverse()) await step()
})

function tmpHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pty-drain-'))
  cleanup.push(() => removeTree(dir))
  return dir
}

const quiet = () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}


/** An endpoint for a stand-in host: a named pipe on Windows, a socket file elsewhere. */
const endpointIn = (dir: string, name: string) => process.platform === 'win32'
  ? `\\\\.\\pipe\\pty-drain-${path.basename(dir)}-${name}`
  : path.join(dir, `${name}.sock`)

/**
 * A stand-in host in this process: it proves its token, says hello as [instance] (`p<protocol>` by default) with
 * [pid] (this process's by default), lists [panes], and records every op it is asked; a `shutdown` is granted, and
 * [onShutdown] told.
 */
async function fakeHostAt(endpoint: string, panes: unknown[] = [], options: { instance?: string; pid?: number; onShutdown?: () => void } = {}) {
  const token = `tok-${path.basename(endpoint)}`
  const hellos: number[] = []
  const ops: string[] = []
  const pid = options.pid ?? process.pid
  const server = net.createServer(socket => {
    socket.on('error', () => {})
    let pending = ''
    let said = false
    socket.on('data', chunk => {
      pending += chunk
      let at
      while ((at = pending.indexOf('\n')) >= 0) {
        const value = JSON.parse(pending.slice(0, at))
        pending = pending.slice(at + 1)
        if (said) {
          ops.push(value.op)
          if (value.op === 'shutdown') options.onShutdown?.()
          socket.write(`${JSON.stringify(value.op === 'inventory' ? { id: value.id, ok: true, panes } : value.op === 'create' ? { id: value.id, ok: true, pane: '%9' } : { id: value.id, ok: true })}\n`)
          continue
        }
        said = true
        hellos.push(value.hello.protocol)
        socket.write(`${JSON.stringify({ hello: { ok: true, instance: options.instance ?? `p${value.hello.protocol}`, version: '0.1.0', pid, proof: helloProof(token, value.hello.nonce) } })}\n`)
      }
    })
  })
  server.listen(endpoint)
  await once(server, 'listening')
  cleanup.push(() => new Promise(resolve => server.close(resolve)))
  return { endpoint, token, pid, hellos, ops }
}

function writeDiscovery(home: string, value: { protocol: number; instance: string; endpoint: string; token: string; pid: number; version?: string }) {
  mkdirSync(path.join(home, 'run'), { recursive: true })
  writeFileSync(path.join(home, 'run', discoveryFileName(value.instance)!), JSON.stringify({ version: '0.1.0', ...value }))
}

/** A target of [version] (`p<PTY_PROTOCOL>-<version>`), from [source]. */
const targetOf = (version: string, source: PtyHostTarget['source'] = 'installed', instance = `p${PTY_PROTOCOL}-${version}`): PtyHostTarget =>
  ({ protocol: PTY_PROTOCOL, version, instance, features: ['seed'], source })

/** A pid no process has any more: a child's that has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', ''])
  return child.pid!
}

/** A stub client of a host with [pid] speaking [protocol]: [replies] by op name, `ok {}` for the rest. */
function stubClient(pid: number, protocol: number, replies: Record<string, unknown | ((op: PtyOp) => unknown)> = {}) {
  const closes = new Set<() => void>()
  const calls: PtyOp[] = []
  const client = {
    instance: `p${protocol}`,
    pid,
    protocol,
    closed: false,
    calls,
    call: async (op: PtyOp) => {
      calls.push(op)
      const reply = replies[op.op]
      return (typeof reply === 'function' ? reply(op) : reply) ?? (op.op === 'inventory' ? { state: 'ok', value: { panes: [] } } : { state: 'ok', value: {} })
    },
    onEvent: (_listener: (event: PtyEvent) => void) => () => {},
    onClose: (listener: () => void) => { closes.add(listener); return () => { closes.delete(listener) } },
    close() { client.closed = true },
    openStream: async () => null,
    lose() { for (const listener of [...closes]) listener() },
  }
  return client
}
type StubClient = ReturnType<typeof stubClient>

/** A process table row for [pid], started at [marker]. */
const row = (pid: number, marker = 'Thu Oct 15 10:00:00 2026'): ProcessRow =>
  ({ pid, parentPid: 1, executable: 'harness-pty', startMarker: marker, args: 'harness-pty serve' })
/** `reachPtyHost`'s nothing-answered, naming [pid] (null: no readable file; [missing]: no file at all). */
const unreached = (pid: number | null, missing = false) => ({ unavailable: 'nothing answers', code: 'PTY_HOST_UNAVAILABLE' as const, pid, missing })

/** A drain backend whose launches answer from [results] in turn, then nothing answering at [results]' last pid. */
function drainBackend(results: Array<StubClient | ReachPtyHostResult>, options: { alive?: (pid: number) => boolean; rows?: () => Promise<ProcessRow[] | null>; home?: string; platform?: NodeJS.Platform } = {}) {
  const launch = vi.fn(async (): Promise<ReachPtyHostResult> => {
    const next = results.shift() ?? unreached(null)
    return 'call' in next ? { client: next as unknown as PtyHostClient } : next
  })
  const tables = vi.fn(options.rows ?? (async () => [row(10)]))
  const backend = new PtyHostBackend({
    home: options.home ?? '/tmp/none',
    instance: `p${OLD}`,
    launch,
    owner: () => 'me',
    platform: options.platform ?? 'linux',
    hostProcess: { alive: options.alive ?? (() => false), rows: tables },
  })
  return { backend, launch, tables }
}

const OLD_PANE: PtyRuntimeRef = { backend: 'ptyhost', instance: `p${OLD}`, paneId: '%3' }

const P = PTY_PROTOCOL
const PANE_ROW = { pane: '%3', rootPid: 7, cwd: '/w', title: '', dead: false, owner: 'me', label: null }

/**
 * [home] with the target's host (`p<P>-0.2.0`, this process's pid) and another of [version] of the same protocol, with
 * [panes]: its pid is one no process has, and the `hostProcess` seam says it runs until it is asked to shut down.
 * The runtime has `pty/0.1.0`, `pty/0.2.0` (`current-pty`) and `pty/0.3.0`.
 */
async function twoVersions(version: string, panes: unknown[] = []) {
  const home = tmpHome()
  const runtime = tmpHome()
  for (const name of ['0.1.0', '0.2.0', '0.3.0']) mkdirSync(path.join(runtime, 'pty', name), { recursive: true })
  writeFileSync(path.join(runtime, 'pty', 'current-pty'), '0.2.0')
  const pid = deadPid()
  let exited = false
  const other = await fakeHostAt(endpointIn(home, 'other'), panes, { instance: `p${P}-${version}`, pid, onShutdown: () => { exited = true } })
  const target = await fakeHostAt(endpointIn(home, 'target'), [], { instance: `p${P}-0.2.0` })
  writeDiscovery(home, { protocol: P, instance: `p${P}-${version}`, version, endpoint: other.endpoint, token: other.token, pid })
  writeDiscovery(home, { protocol: P, instance: `p${P}-0.2.0`, version: '0.2.0', endpoint: target.endpoint, token: target.token, pid: target.pid })
  const hostProcess = { alive: (candidate: number) => candidate !== pid || !exited, rows: async () => [] }
  return { home, runtime, other, target, hostProcess }
}

/** The create and drain backends of [home] under [target], prepared, and a drain over them. */
async function drained(home: string, target: PtyHostTarget | null, options: { hostProcess?: { alive: (pid: number) => boolean; rows: () => Promise<ProcessRow[] | null> }; inUse?: () => boolean; cleanup?: () => void } = {}) {
  const { create, drain } = ptyHostBackends(home, { target, owner: () => 'me', platform: 'linux', ...(options.hostProcess ? { hostProcess: options.hostProcess } : {}) })
  cleanup.push(() => { create.dispose(); for (const backend of drain) backend.dispose() })
  expect(await create.prepare({ ownedPanes: new Map() })).toEqual({ state: 'ready' })
  for (const backend of drain) expect(await backend.prepare({ ownedPanes: new Map() })).toEqual({ state: 'ready' })
  const backends: TerminalBackend[] = [create, ...drain]
  const drainer = new PtyHostDrain({ drain, backends, coordinator: { replaceBackends: () => {} }, inUse: options.inUse ?? (() => false), cleanup: options.cleanup })
  return { create, drain, backends, drainer }
}

describe.runIf(PTY_PROTOCOL >= 2)('ptyHostBackends', () => {
  it('creates on the target host and keeps older protocol panes on the old one', async () => {
    quiet()
    const home = tmpHome()
    const oldHost = await fakeHostAt(endpointIn(home, 'old'), [PANE_ROW])
    const newHost = await fakeHostAt(endpointIn(home, 'new'))
    writeDiscovery(home, { protocol: OLD, instance: `p${OLD}`, ...oldHost })
    writeDiscovery(home, { protocol: P, instance: `p${P}`, ...newHost })
    // A pre-G binary's target: its host is the legacy `p<P>`.
    const { create, drain } = ptyHostBackends(home, { target: targetOf('0.1.0', 'binary', `p${P}`), owner: () => 'me', platform: 'linux' })
    cleanup.push(() => { create.dispose(); for (const backend of drain) backend.dispose() })
    expect(await create.prepare({ ownedPanes: new Map() })).toEqual({ state: 'ready' })
    for (const backend of drain) expect(await backend.prepare({ ownedPanes: new Map() })).toEqual({ state: 'ready' })
    expect(create.instanceId).toBe(`ptyhost:p${P}`)
    expect(drain.map((b) => b.instanceId)).toEqual([`ptyhost:p${OLD}`])
    // Each is spoken to in its own protocol.
    expect([oldHost.hellos, newHost.hellos]).toEqual([[OLD], [P]])
    expect([isDrainBackend(create), isDrainBackend(drain[0])]).toEqual([false, true])
    // The old pane is listed on its own instance, and the route keys of both instances reach their own backend.
    expect(await drain[0].inventory()).toEqual({ state: 'available', roots: [{ runtime: OLD_PANE, rootPid: 7, cwd: '/w' }] })
    const created = await create.create({ command: ['sh'] })
    if (created.state !== 'succeeded') throw new Error(JSON.stringify(created))
    expect(created.runtime.instance).toBe(`p${P}`)
    const terminals = new TerminalBackendCoordinator([create, ...drain], ['ptyhost'])
    expect(terminals.backendFor(OLD_PANE)).toBe(drain[0])
    expect(terminals.backendFor(created.runtime)).toBe(create)
    expect(terminalRouteKey(OLD_PANE)).not.toBe(terminalRouteKey({ ...OLD_PANE, instance: `p${P}` }))
    // A drain backend never makes a pane.
    expect(await drain[0].create({ command: ['sh'] })).toMatchObject({ state: 'failed', dispatch: 'not_started', reason: expect.stringContaining('draining') })
  })

  it('an older version\'s host of the same protocol drains', async () => {
    quiet()
    const { home, other, target, hostProcess } = await twoVersions('0.1.0', [PANE_ROW])
    for (const source of ['installed', 'binary'] as const) {
      const { create, drain } = await drained(home, targetOf('0.2.0', source), { hostProcess })
      expect(drain.map((b) => [b.instanceId, b.draining, b.mayShutDown])).toEqual([[`ptyhost:p${P}-0.1.0`, true, true]])
      expect(create.instanceId).toBe(`ptyhost:p${P}-0.2.0`)
      const created = await create.create({ command: ['sh'] })
      expect(created).toMatchObject({ state: 'succeeded', runtime: { instance: `p${P}-0.2.0` } })
      expect(await drain[0].inventory()).toEqual({ state: 'available', roots: [{ runtime: { backend: 'ptyhost', instance: `p${P}-0.1.0`, paneId: '%3' }, rootPid: 7, cwd: '/w' }] })
      expect(await drain[0].create({ command: ['sh'] })).toMatchObject({ state: 'failed', dispatch: 'not_started', reason: expect.stringContaining('draining') })
    }
    // New panes went to the target alone.
    expect([other.ops.includes('create'), target.ops.filter((op) => op === 'create').length]).toEqual([false, 2])
  })

  it('a legacy p2 host drains', async () => {
    quiet()
    const home = tmpHome()
    const legacy = await fakeHostAt(endpointIn(home, 'legacy'), [PANE_ROW])
    const target = await fakeHostAt(endpointIn(home, 'target'), [], { instance: `p${P}-0.2.0` })
    writeDiscovery(home, { protocol: P, instance: `p${P}`, endpoint: legacy.endpoint, token: legacy.token, pid: legacy.pid })
    writeDiscovery(home, { protocol: P, instance: `p${P}-0.2.0`, version: '0.2.0', endpoint: target.endpoint, token: target.token, pid: target.pid })
    const { create, drain } = await drained(home, targetOf('0.2.0'))
    expect([create.instanceId, drain.map((b) => [b.instanceId, b.mayShutDown])]).toEqual([`ptyhost:p${P}-0.2.0`, [[`ptyhost:p${P}`, true]]])
    expect(await drain[0].inventory()).toMatchObject({ state: 'available', roots: [{ runtime: { instance: `p${P}`, paneId: '%3' } }] })
    expect(await create.create({ command: ['sh'] })).toMatchObject({ state: 'succeeded', runtime: { instance: `p${P}-0.2.0` } })
    expect(legacy.ops).not.toContain('create')
  })

  it('a newer host drains and shuts down under an installed target', async () => {
    quiet()
    const { home, other, hostProcess } = await twoVersions('0.3.0')
    const { create, drain, backends, drainer } = await drained(home, targetOf('0.2.0', 'installed'), { hostProcess })
    expect(drain.map((b) => [b.instanceId, b.mayShutDown])).toEqual([[`ptyhost:p${P}-0.3.0`, true]])
    for (let pass = 0; pass < EMPTY_PASSES; pass++) await drainer.step()
    expect(other.ops).toContain('shutdown')
    expect(drain[0].hostGone).toContain('shut down')
    expect(backends).toEqual([create])
  })

  it('a newer host is reached but never shut down under a binary target', async () => {
    quiet()
    const { home, other, hostProcess } = await twoVersions('0.3.0')
    let rows = true
    const { create, drain, backends, drainer } = await drained(home, targetOf('0.2.0', 'binary'), { hostProcess, inUse: () => rows })
    expect(drain.map((b) => [b.instanceId, b.mayShutDown])).toEqual([[`ptyhost:p${P}-0.3.0`, false]])
    expect(other.hellos).toEqual([P])
    for (let pass = 0; pass < EMPTY_PASSES + 2; pass++) await drainer.step()
    // Rows still name it: reached, listed, kept.
    expect(backends).toEqual([create, drain[0]])
    expect(await drain[0].inventory()).toEqual({ state: 'available', roots: [] })
    rows = false
    await drainer.step()
    // Its backend leaves; the host is never asked to go.
    expect(backends).toEqual([create])
    expect(other.ops).not.toContain('shutdown')
    expect(drain[0].hostGone).toBeNull()
  })

  it('a drain backend never shuts its host down when there is no target', async () => {
    quiet()
    const { home, other, hostProcess } = await twoVersions('0.1.0')
    const { drain } = ptyHostBackends(home, { target: null, owner: () => 'me', platform: 'linux', hostProcess })
    expect(drain.map((b) => [b.instanceId, b.mayShutDown])).toEqual([[`ptyhost:p${P}-0.1.0`, false], [`ptyhost:p${P}-0.2.0`, false]])
    expect(other.ops).toEqual([])
  })

  it('with no target, the drain backend of the host the create backend took leaves', async () => {
    quiet()
    const { home, hostProcess } = await twoVersions('0.1.0')
    const { create, drain } = ptyHostBackends(home, { target: null, owner: () => 'me', platform: 'linux', hostProcess })
    cleanup.push(() => { create.dispose(); for (const backend of drain) backend.dispose() })
    for (const backend of [create, ...drain]) expect(await backend.prepare({ ownedPanes: new Map() })).toEqual({ state: 'ready' })
    // The newest host answered the create backend.
    expect(create.instanceId).toBe(`ptyhost:p${P}-0.2.0`)
    const disposed = vi.spyOn(drain[1], 'dispose')
    const kept = withoutCreateHost([create, ...drain], create)
    expect(kept).toEqual([create, drain[0]])
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(withoutCreateHost(kept, create)).toEqual(kept)
  })

  it('rows on an instance with no discovery get a drain backend', () => {
    const home = tmpHome()
    expect(ptyHostBackends(home, { target: targetOf('0.2.0') }).drain).toEqual([])
    writeDiscovery(home, { protocol: P, instance: `p${P}-0.1.0`, version: '0.1.0', endpoint: '/x', token: 't', pid: 1 })
    const rows = [`ptyhost:p${P}-0.0.9`, `ptyhost:p${OLD}`, `ptyhost:p${P}-0.1.0`, `ptyhost:p${P}-0.2.0`, 'ptyhost:p9-1.0', 'ptyhost:../x', `ptyhost:p${OLD}`]
    const { create, drain } = ptyHostBackends(home, { target: targetOf('0.2.0'), rowInstances: () => rows })
    // The discovered one, then those only rows name: never the target's, an unsupported protocol's or a non-instance.
    expect(drain.map((b) => [b.instanceId, b.draining])).toEqual([[`ptyhost:p${P}-0.1.0`, true], [`ptyhost:p${P}-0.0.9`, true], [`ptyhost:p${OLD}`, true]])
    expect([create.instanceId, create.draining]).toEqual(['ptyhost:unprepared', false])
  })

  it('rowInstancesOf: the pty host instances rows name, once each', () => {
    const rows = [
      { runtimes: [OLD_PANE, { ...OLD_PANE, paneId: '%4' }] },
      { runtimes: [{ backend: 'tmux' as const, instance: 'default', paneId: '%1' }, { backend: 'ptyhost' as const, instance: `p${P}-0.1.0`, paneId: '%1' }] },
    ]
    expect(rowInstancesOf(rows)).toEqual([`ptyhost:p${OLD}`, `ptyhost:p${P}-0.1.0`])
  })

  it('an empty older host is shut down after EMPTY_PASSES and its folder removed', async () => {
    quiet()
    const { home, runtime, other, hostProcess } = await twoVersions('0.1.0')
    const { create, backends, drainer } = await drained(home, targetOf('0.2.0'), { hostProcess, cleanup: () => { removeUnusedPtyVersions(home, runtime) } })
    await drainer.step()
    expect(other.ops).not.toContain('shutdown')
    await drainer.step()
    expect(other.ops).toContain('shutdown')
    expect(backends).toEqual([create])
    expect(readInstanceDiscovery(home, `p${P}-0.1.0`)).toBeNull()
    expect(['0.1.0', '0.2.0', '0.3.0'].map((name) => existsSync(path.join(runtime, 'pty', name)))).toEqual([false, true, true])
  })

  it('a newer host\'s folder is never removed', async () => {
    quiet()
    const { home, runtime, other, hostProcess } = await twoVersions('0.3.0')
    const { create, backends, drainer } = await drained(home, targetOf('0.2.0'), { hostProcess, cleanup: () => { removeUnusedPtyVersions(home, runtime) } })
    for (let pass = 0; pass < EMPTY_PASSES; pass++) await drainer.step()
    // Shut down (a rollback), and gone: still its folder stays, newer than `current-pty`.
    expect([other.ops.includes('shutdown'), backends]).toEqual([true, [create]])
    expect(['0.1.0', '0.2.0', '0.3.0'].map((name) => existsSync(path.join(runtime, 'pty', name)))).toEqual([false, true, true])
  })

  it('rowsOnInstance: whether a row has a runtime on the instance', () => {
    const rows = [{ runtimes: [OLD_PANE] }, { runtimes: [{ backend: 'tmux' as const, instance: 'default', paneId: '%1' }] }]
    expect(rowsOnInstance(rows, `ptyhost:p${OLD}`)).toBe(true)
    expect(rowsOnInstance(rows, `ptyhost:p${P}`)).toBe(false)
  })
})

describe.runIf(PTY_PROTOCOL >= 2)('a drain backend', () => {
  it('installs no Windows seams: the process table and the signaller are the create backend\'s', async () => {
    quiet()
    vi.mocked(setProcessTableSource).mockClear()
    const { backend } = drainBackend([stubClient(10, OLD)], { platform: 'win32' })
    await backend.prepare({ ownedPanes: new Map() })
    backend.dispose()
    expect(setProcessTableSource).not.toHaveBeenCalled()
  })

  it('is ready on a host proven gone, and its panes are then gone for certain', async () => {
    quiet()
    // The discovery file names pid 4, which the process table does not have.
    const { backend } = drainBackend([unreached(4)], { rows: async () => [row(10)] })
    const replaced = vi.fn()
    backend.onHostReplaced = replaced
    // Known before it reaches anything: rows name it.
    expect(backend.instanceId).toBe(`ptyhost:p${OLD}`)
    expect(await backend.prepare({ ownedPanes: new Map() })).toEqual({ state: 'ready' })
    expect(backend.hostGone).toContain('(pid 4) has exited')
    expect(replaced).toHaveBeenCalledTimes(1)
    expect(await backend.prepare({ ownedPanes: new Map() })).toEqual({ state: 'ready' })
    expect(await backend.inventory()).toEqual({ state: 'available', roots: [] })
    expect(await backend.titles()).toEqual({ state: 'succeeded', value: new Map() })
    expect(await backend.rootProcess(OLD_PANE)).toBe('missing')
    expect(await backend.validate(OLD_PANE, { engine: 'claude' })).toMatchObject({ state: 'gone' })
    expect(await backend.paneState(OLD_PANE)).toBe('gone')
    expect(await backend.capture(OLD_PANE)).toEqual({ state: 'failed', reason: 'the pty host has exited' })
    expect(await backend.isHeld(OLD_PANE, '00000000-0000-0000-0000-000000000000')).toBe(false)
    expect((await backend.kill(OLD_PANE)).state).toBe('succeeded')
    expect((await backend.killHeld(OLD_PANE, '00000000-0000-0000-0000-000000000000', () => true)).state).toBe('succeeded')
    expect(await backend.drainState()).toBe('gone')
    expect(await backend.shutdownHost()).toBe('exited')
    // Another instance's pane is not this host's to call gone.
    expect(await backend.paneState({ ...OLD_PANE, instance: 'p9' })).toBe('unknown')
  })

  it('is gone with no discovery file at all and no host ever reached: there is no process to look for', async () => {
    quiet()
    const { backend, tables } = drainBackend([unreached(null, true)])
    await backend.prepare({ ownedPanes: new Map() })
    expect(backend.hostGone).toBe('nothing answers')
    expect(tables).not.toHaveBeenCalled()
  })

  it('keeps its panes while nothing proves the host gone: an unreadable file, a live pid, a table it cannot read', async () => {
    vi.useFakeTimers()
    quiet()
    let table: ProcessRow[] | null = [row(10)]
    const { backend, launch } = drainBackend([
      // A discovery file caught unreadable: no pid to look for, and it is there.
      unreached(null, false),
      // The pid it names runs.
      unreached(10),
      { incompatible: 'wrong token' },
      unreached(10),
    ], { rows: async () => table })
    expect(await backend.prepare({ ownedPanes: new Map() })).toEqual({ state: 'ready' })
    expect(await backend.inventory()).toMatchObject({ state: 'unavailable' })
    await vi.advanceTimersByTimeAsync(1_000 + 2_000)
    table = null
    await vi.advanceTimersByTimeAsync(4_000)
    // However many attempts fail: never gone without the proof.
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(30_000)
    expect(launch.mock.calls.length).toBeGreaterThan(10)
    expect(backend.hostGone).toBeNull()
    expect(await backend.inventory()).toMatchObject({ state: 'unavailable' })
    expect(await backend.paneState(OLD_PANE)).toBe('unknown')
    expect(await backend.kill(OLD_PANE)).toMatchObject({ state: 'failed', dispatch: 'not_started' })
  })

  it('a host that exits while connected is gone once its pid leaves the process table', async () => {
    vi.useFakeTimers()
    quiet()
    const client = stubClient(10, OLD)
    let table = [row(10)]
    const { backend } = drainBackend([client, unreached(10), unreached(null, false)], { rows: async () => table })
    await backend.prepare({ ownedPanes: new Map() })
    client.lose()
    expect(await backend.inventory()).toMatchObject({ state: 'unavailable' })
    // Still in the table: kept.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(backend.hostGone).toBeNull()
    // Gone from it, and its discovery file unreadable meanwhile: the last host reached is what is looked for.
    table = []
    await vi.advanceTimersByTimeAsync(2_000)
    expect(backend.hostGone).toContain('(pid 10) has exited')
    expect(await backend.inventory()).toEqual({ state: 'available', roots: [] })
  })

  it('a host whose pid another process now has is gone: the start marker differs from when it was reached', async () => {
    vi.useFakeTimers()
    quiet()
    const client = stubClient(10, OLD)
    let table = [row(10, 'Thu Oct 15 10:00:00 2026')]
    const { backend } = drainBackend([client, unreached(10), unreached(10)], { rows: async () => table })
    await backend.prepare({ ownedPanes: new Map() })
    await vi.advanceTimersByTimeAsync(0)
    client.lose()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(backend.hostGone).toBeNull()
    table = [row(10, 'Thu Oct 15 11:30:00 2026')]
    await vi.advanceTimersByTimeAsync(2_000)
    expect(backend.hostGone).toContain('another process has its pid')
  })

  it('drainState: empty, busy, or unknown when it cannot ask', async () => {
    quiet()
    let panes: unknown[] = []
    let failing = false
    const client = stubClient(10, OLD, { inventory: () => failing ? { state: 'failed', dispatch: 'not_started', code: 'x', reason: 'r' } : { state: 'ok', value: { panes } } })
    const { backend } = drainBackend([client])
    expect(await backend.drainState()).toBe('unknown')
    await backend.prepare({ ownedPanes: new Map() })
    expect(await backend.drainState()).toBe('empty')
    // Any owner's pane keeps the host.
    panes = [{ pane: '%1', rootPid: 1, cwd: '', title: '', dead: true, owner: 'another daemon', label: null }]
    expect(await backend.drainState()).toBe('busy')
    failing = true
    expect(await backend.drainState()).toBe('unknown')
  })

  it('never ends a host of a protocol without shutdown: it stays running, untouched', async () => {
    quiet()
    const client = stubClient(10, SHUTDOWN_PROTOCOL - 1)
    const { backend } = drainBackend([client], { alive: () => true })
    await backend.prepare({ ownedPanes: new Map() })
    expect(await backend.shutdownHost()).toBe('unsupported')
    expect(client.calls).toEqual([])
    expect(backend.hostGone).toBeNull()
    expect(client.closed).toBe(false)
  })

  it.runIf(SHUTDOWN_PROTOCOL <= PTY_PROTOCOL)('asks a host of the shutdown protocol on to shut down, and takes its refusal', async () => {
    quiet()
    let refuse = true
    const client = stubClient(10, SHUTDOWN_PROTOCOL, {
      shutdown: () => refuse ? { state: 'failed', dispatch: 'rejected', code: 'bad_request', reason: 'host still has panes (1)' } : { state: 'ok', value: {} },
    })
    const { backend } = drainBackend([client])
    await backend.prepare({ ownedPanes: new Map() })
    expect(await backend.shutdownHost()).toBe('refused')
    refuse = false
    expect(await backend.shutdownHost()).toBe('exited')
    expect(client.calls.filter((op) => op.op === 'shutdown')).toHaveLength(2)
    expect(backend.hostGone).toContain('pid 10')
  })

  it('a shutdown that could not be asked, or a host that does not exit, is failed', async () => {
    quiet()
    expect(await drainBackend([]).backend.shutdownHost()).toBe('failed')
    const unanswered = stubClient(10, SHUTDOWN_PROTOCOL, { shutdown: { state: 'unknown', dispatch: 'possibly_executed', reason: 'timeout' } })
    const first = drainBackend([unanswered])
    await first.backend.prepare({ ownedPanes: new Map() })
    expect(await first.backend.shutdownHost()).toBe('failed')
    vi.useFakeTimers()
    const stuck = drainBackend([stubClient(10, SHUTDOWN_PROTOCOL)], { alive: () => true })
    await stuck.backend.prepare({ ownedPanes: new Map() })
    const done = stuck.backend.shutdownHost()
    await vi.advanceTimersByTimeAsync(3_100)
    expect(await done).toBe('failed')
    expect(stuck.backend.hostGone).toBeNull()
  })
})

/** Drain backends stubbed by state, and a drain over them. */
function drainFixture(options: { oldPanes?: unknown[]; inUse?: () => boolean; createAvailable?: () => boolean } = {}) {
  type Stub = { instanceId: string; draining: true; mayShutDown: boolean; hostGone: string | null; shutdownCalled: boolean; disposed: boolean; panes: unknown[]; refuse: boolean; unknown: boolean
    drainState(): Promise<string>; shutdownHost(): Promise<string>; dispose(): void }
  const stub: Stub = {
    instanceId: `ptyhost:p${OLD}`,
    draining: true,
    mayShutDown: true,
    hostGone: null,
    shutdownCalled: false,
    disposed: false,
    panes: options.oldPanes ?? [],
    refuse: false,
    unknown: false,
    async drainState() { return this.hostGone ? 'gone' : this.unknown ? 'unknown' : this.panes.length ? 'busy' : 'empty' },
    async shutdownHost() {
      this.shutdownCalled = true
      if (this.refuse) return 'refused'
      this.hostGone = 'shut down'
      return 'exited'
    },
    dispose() { this.disposed = true },
  }
  const create = { instanceId: `ptyhost:p${PTY_PROTOCOL}` } as unknown as TerminalBackend
  const backends: TerminalBackend[] = [create, stub as unknown as TerminalBackend]
  const replaced: TerminalBackend[][] = []
  const cleaned = vi.fn()
  const drainer = new PtyHostDrain({
    drain: [stub as unknown as PtyHostBackendType],
    backends,
    coordinator: { replaceBackends: (list) => { replaced.push([...list]) } },
    inUse: options.inUse ?? (() => false),
    cleanup: cleaned,
    ...(options.createAvailable ? { createAvailable: options.createAvailable } : {}),
  })
  return { drain: [stub], drainer, step: () => drainer.step(), backends, create, replaced, cleaned }
}

describe('a host on probation', () => {
  it('is one with a pty-pending.json', () => {
    const runtime = mkdtempSync(path.join(tmpdir(), 'probation-'))
    try {
      expect(ptyHostOnProbation(runtime)).toBe(false)
      mkdirSync(path.join(runtime, 'pty'))
      writeFileSync(path.join(runtime, 'pty', 'pty-pending.json'), '{}')
      expect(ptyHostOnProbation(runtime)).toBe(true)
    } finally { rmSync(runtime, { recursive: true, force: true }) }
  })

  it('makes the core wait to be ready until the create backend is attached to it, said once, and forever when it never is', async () => {
    vi.useFakeTimers()
    try {
      const lines: string[] = []
      let attached = false
      let ready = false
      void untilHostAttached(() => attached, 'p2-0.11.0', (line) => lines.push(line)).then(() => { ready = true })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(ready).toBe(false)
      expect(lines).toEqual(['[terminal] ptyhost: the host on probation (p2-0.11.0) is not attached — not ready until it is; the master rolls it back if it never is'])
      attached = true
      await vi.advanceTimersByTimeAsync(250)
      expect(ready).toBe(true)
      expect(lines).toHaveLength(2)
      expect(lines[1]).toBe('[terminal] ptyhost: the host on probation (p2-0.11.0) is attached')
      // Attached from the start: ready at once, nothing said.
      const quietLines: string[] = []
      await untilHostAttached(() => true, null, (line) => quietLines.push(line))
      expect(quietLines).toEqual([])
    } finally { vi.useRealTimers() }
  })
})

describe('PtyHostDrain', () => {
  it('shuts a drained host down after two empty passes', async () => {
    quiet()
    expect(EMPTY_PASSES).toBe(2)
    const { drain, step, backends, create, replaced, cleaned, drainer } = drainFixture({ oldPanes: [] })
    await step(); expect(drain[0].shutdownCalled).toBe(false)
    await step(); expect(drain[0].shutdownCalled).toBe(true)
    // And leaves the daemon's backends: the list the reconciler reads, and the coordinator's.
    expect(backends).toEqual([create])
    expect(replaced).toEqual([[create]])
    expect(drain[0].disposed).toBe(true)
    expect(cleaned).toHaveBeenCalledTimes(1)
    expect(drainer.pending).toEqual([])
    await step()
    expect(replaced).toHaveLength(1)
  })

  it('removes an empty protocol 1 drain backend without signalling its host, once no row names it', async () => {
    quiet()
    const kill = vi.spyOn(process, 'kill')
    const client = stubClient(10, 1)
    const { backend } = drainBackend([client], { alive: () => true })
    await backend.prepare({ ownedPanes: new Map() })
    const create = { instanceId: `ptyhost:p${PTY_PROTOCOL}` } as unknown as TerminalBackend
    const backends: TerminalBackend[] = [create, backend]
    let rows = true
    const drainer = new PtyHostDrain({ drain: [backend], backends, coordinator: { replaceBackends: () => {} }, inUse: () => rows })
    await drainer.step(); await drainer.step(); await drainer.step()
    // Rows still name it: kept, though its host is idle.
    expect(backends).toHaveLength(2)
    rows = false
    await drainer.step()
    expect(backends).toEqual([create])
    // Asked for its panes and nothing else; no signal, no shutdown; the connection closed, the host left running.
    expect(new Set(client.calls.map((op) => op.op))).toEqual(new Set(['inventory']))
    expect(kill).not.toHaveBeenCalled()
    expect(backend.hostGone).toBeNull()
    expect(client.closed).toBe(true)
  })

  it('never asks a host it may not shut down: it stays running, and its backend leaves once no row names it', async () => {
    quiet()
    let rows = true
    const { drain, step, backends } = drainFixture({ inUse: () => rows })
    drain[0].mayShutDown = false
    for (let pass = 0; pass < EMPTY_PASSES + 1; pass++) await step()
    expect([drain[0].shutdownCalled, backends.length]).toEqual([false, 2])
    rows = false
    await step()
    expect([drain[0].shutdownCalled, backends.length, drain[0].hostGone]).toEqual([false, 1, null])
  })

  it('never shuts an old host down while the create backend is unavailable: it may be the only host that serves', async () => {
    quiet()
    let available = false
    const { drain, step, backends } = drainFixture({ createAvailable: () => available })
    for (let pass = 0; pass < EMPTY_PASSES + 2; pass++) await step()
    expect([drain[0].shutdownCalled, backends.length]).toEqual([false, 2])
    // Counted afresh once it is back: two empty passes with a create backend to go to.
    available = true
    await step()
    expect(drain[0].shutdownCalled).toBe(false)
    await step()
    expect(drain[0].shutdownCalled).toBe(true)
  })

  it('counts empty passes in a row: a pass with a pane, or one that could not ask, starts again', async () => {
    quiet()
    const { drain, step } = drainFixture({ oldPanes: [{ pane: '%1' }] })
    await step(); await step()
    expect(drain[0].shutdownCalled).toBe(false)
    drain[0].panes = []
    await step()
    drain[0].unknown = true
    await step()
    drain[0].unknown = false
    await step()
    expect(drain[0].shutdownCalled).toBe(false)
    await step()
    expect(drain[0].shutdownCalled).toBe(true)
  })

  it('a host that refuses (a pane came meanwhile) is asked again only after two more empty passes', async () => {
    quiet()
    const { drain, step, backends } = drainFixture()
    drain[0].refuse = true
    await step(); await step()
    expect(drain[0].shutdownCalled).toBe(true)
    drain[0].shutdownCalled = false
    drain[0].refuse = false
    await step()
    expect(drain[0].shutdownCalled).toBe(false)
    await step()
    expect(drain[0].shutdownCalled).toBe(true)
    expect(backends).toHaveLength(1)
  })

  it('a host that has gone leaves once no row names its instance, never before', async () => {
    quiet()
    let rows = true
    const { drain, step, backends, cleaned } = drainFixture({ inUse: () => rows })
    drain[0].hostGone = 'exited'
    await step(); await step(); await step()
    expect(drain[0].shutdownCalled).toBe(false)
    expect(backends).toHaveLength(2)
    rows = false
    await step()
    expect(backends).toHaveLength(1)
    expect(cleaned).toHaveBeenCalledTimes(1)
  })

  it('skips a step while one runs, and a cleanup that throws does not stop the drain', async () => {
    quiet()
    const { drain, drainer, backends } = drainFixture()
    let release: () => void = () => {}
    const slow = new Promise<void>((resolve) => { release = resolve })
    const original = drain[0].drainState.bind(drain[0])
    drain[0].drainState = async () => { await slow; return original() }
    const first = drainer.step()
    await drainer.step()
    release()
    await first
    drain[0].drainState = original
    await drainer.step()
    expect(drain[0].shutdownCalled).toBe(true)
    expect(backends).toHaveLength(1)
    const thrown = drainFixture()
    ;(thrown.drainer as unknown as { deps: { cleanup: () => void } }).deps.cleanup = () => { throw new Error('busy') }
    await thrown.step(); await thrown.step()
    expect(thrown.backends).toHaveLength(1)
  })

  it('a drain state or shutdown that throws counts as could not ask', async () => {
    quiet()
    const { drain, step } = drainFixture()
    drain[0].drainState = async () => { throw new Error('x') }
    await step(); await step()
    expect(drain[0].shutdownCalled).toBe(false)
    const other = drainFixture()
    other.drain[0].shutdownHost = async () => { throw new Error('x') }
    await other.step(); await other.step()
    expect(other.backends).toHaveLength(2)
  })

  it('dispose drops every drain backend left', () => {
    const { drain, drainer } = drainFixture()
    drainer.dispose()
    expect(drain[0].disposed).toBe(true)
  })
})

const realBinary = process.env.HARNESS_PTY_BIN
const previousBinary = process.env.HARNESS_PTY_BIN_PREV
const CASE_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 20_000
const WAIT_MS = process.platform === 'win32' ? 20_000 : 8_000

async function until<T>(read: () => Promise<T> | T, ok: (value: T) => boolean, ms = WAIT_MS): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value) || Date.now() > end) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const killPid = (pid: number | undefined) => { if (pid) try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/** A command a shell pane types for a line that shows only once it runs: "<word>-42". */
const computed = (word: string) => process.platform === 'win32' ? `echo "${word}-$(40+2)"\r` : `echo ${word}-$((40+2))\n`

// The real host: `cd pty && cargo +stable build`, then HARNESS_PTY_BIN=$(pwd)/../pty/target/debug/harness-pty.
describe.runIf(!!realBinary)('shutdown on the real host', () => {
  it('is refused while the host has a pane; granted, the host exits and takes its discovery file down', async () => {
    const home = tmpHome()
    const target = targetHost({ runtimeDir: home })
    if (!target) throw new Error('HARNESS_PTY_BIN says no version')
    const { create } = ptyHostBackends(home, { target, owner: () => 'me' })
    cleanup.push(() => { create.dispose(); killPid(readInstanceDiscovery(home, target.instance)?.pid) })
    expect(await create.prepare({ ownedPanes: new Map() })).toEqual({ state: 'ready' })
    expect(create.instanceId).toBe(`ptyhost:${target.instance}`)
    const discovery = readInstanceDiscovery(home, target.instance)!
    const client = await PtyHostClient.connect(discovery)
    if (!(client instanceof PtyHostClient)) throw new Error(JSON.stringify(client))
    cleanup.push(() => client.close())
    expect(client.protocol).toBe(PTY_PROTOCOL)
    const pane = await create.create({ command: SHELL })
    if (pane.state !== 'succeeded') throw new Error(JSON.stringify(pane))
    expect(await client.call({ op: 'shutdown' })).toMatchObject({ state: 'failed', code: 'bad_request', reason: expect.stringContaining('host still has panes') })
    expect((await create.kill(pane.runtime)).state).toBe('succeeded')
    expect(await client.call({ op: 'shutdown' })).toEqual({ state: 'ok', value: {} })
    expect(await until(() => alive(discovery.pid), (up) => !up)).toBe(false)
    expect(listDiscoveries(home).some((found) => found.pid === discovery.pid)).toBe(false)
  }, CASE_TIMEOUT_MS)
})

// Two builds of one protocol with real hosts: HARNESS_PTY_BIN_PREV is the previous version, the same source built
// with `HARNESS_PTY_VERSION=0.0.1` and copied aside first (as windows.yml builds it), HARNESS_PTY_BIN this one's.
describe.runIf(!!realBinary && !!previousBinary)('a previous version with the real hosts', () => {
  it('streams the old host\'s pane, makes new panes on the target, and shuts the old one down once its pane closes', async () => {
    quiet()
    const home = tmpHome()
    const target = targetHost({ runtimeDir: home })
    const previous = targetHost({ runtimeDir: home, env: { HARNESS_PTY_BIN: previousBinary } })
    if (!target || !previous) throw new Error('a binary says no version')
    expect(previous.instance).not.toBe(target.instance)
    cleanup.push(() => { killPid(readInstanceDiscovery(home, previous.instance)?.pid); killPid(readInstanceDiscovery(home, target.instance)?.pid) })
    // The host an older daemon started, with a shell pane in it.
    spawn(previousBinary!, ['serve', '--home', home], { cwd: home, detached: true, stdio: 'ignore', windowsHide: true }).unref()
    const old = await until(() => readInstanceDiscovery(home, previous.instance), (found) => found !== null)
    if (!old) throw new Error('the previous host published no discovery file')
    const oldPid = old.pid
    const before = await PtyHostClient.connect(old)
    if (!(before instanceof PtyHostClient)) throw new Error(JSON.stringify(before))
    const made = await before.call({ op: 'create', command: SHELL, cols: 80, rows: 24, owner: 'me', hold: true })
    before.close()
    if (made.state !== 'ok') throw new Error(JSON.stringify(made))
    const oldPane: PtyRuntimeRef = { backend: 'ptyhost', instance: previous.instance, paneId: made.value.pane }

    // This daemon: the target's host is started beside it, the old one drained.
    const { create, drain } = ptyHostBackends(home, { target, owner: () => 'me' })
    cleanup.push(() => { create.dispose(); for (const backend of drain) backend.dispose() })
    expect(drain.map((backend) => [backend.instanceId, backend.mayShutDown])).toEqual([[`ptyhost:${previous.instance}`, true]])
    expect(await create.prepare({ ownedPanes: new Map() })).toEqual({ state: 'ready' })
    expect(await drain[0].prepare({ ownedPanes: new Map() })).toEqual({ state: 'ready' })
    expect(create.instanceId).toBe(`ptyhost:${target.instance}`)
    const backends: TerminalBackend[] = [create, drain[0]]
    const terminals = new TerminalBackendCoordinator(backends, ['ptyhost'])
    expect(terminals.backendFor(oldPane)).toBe(drain[0])
    const listed = await drain[0].inventory()
    expect(listed.state === 'available' && listed.roots.map((root) => root.runtime)).toEqual([oldPane])

    // The old pane still streams, and takes input.
    let output = ''
    const opened = await drain[0].openStream(oldPane, { engine: 'terminal' }, { cols: 80, rows: 24 }, {
      onData: (bytes) => { output += Buffer.from(bytes).toString('utf8') },
      onClose: () => {},
    })
    if (opened.state !== 'succeeded') throw new Error(JSON.stringify(opened))
    expect((await drain[0].typeLiteral(oldPane, computed('drained'))).state).toBe('succeeded')
    expect(await until(() => output, (text) => text.includes('drained-42'))).toContain('drained-42')
    await opened.value.close()

    // New panes land on the target's host.
    const fresh = await create.create({ command: SHELL })
    if (fresh.state !== 'succeeded') throw new Error(JSON.stringify(fresh))
    expect(fresh.runtime.instance).toBe(target.instance)
    expect(terminals.backendFor(fresh.runtime)).toBe(create)

    // The old pane closes: two empty passes later the old host is shut down and its backend has left.
    const drainer = new PtyHostDrain({ drain, backends, coordinator: terminals, inUse: () => false })
    await drainer.step()
    expect(backends).toHaveLength(2)
    expect((await drain[0].kill(oldPane)).state).toBe('succeeded')
    await until(() => drain[0].drainState(), (state) => state === 'empty')
    await drainer.step()
    expect(backends).toHaveLength(2)
    await drainer.step()
    expect(backends).toEqual([create])
    expect(terminals.instances()).toEqual([create])
    expect(await until(() => alive(oldPid), (up) => !up)).toBe(false)
    expect(readInstanceDiscovery(home, previous.instance)).toBeNull()
    // The target's host and its pane are untouched.
    const remaining: TerminalInventoryResult = await create.inventory()
    expect(remaining.state === 'available' && remaining.roots.map((root) => root.runtime)).toEqual([fresh.runtime])
    expect((await create.kill(fresh.runtime)).state).toBe('succeeded')
  }, CASE_TIMEOUT_MS)
})
