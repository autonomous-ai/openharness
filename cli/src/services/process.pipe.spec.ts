import { randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { createServiceLinks, type ServiceLinksOptions } from '../core/serviceLinks.js'
import { createCoreApi, type CoreApiDeps } from '../core/api.js'
import { answerSessionRead } from '../core/agentQueries.js'
import { createFrameParts } from '../core/frameParts.js'
import { agentFacts } from '../lib/agentFrame.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { readWifiView } from './wifiView.js'
import { readCoreSessionRecords } from './sessionSnapshot.js'
import { runDevicesService } from './devicesProcess.js'
import type { DevicesCore, DevicesDeps } from './devices.js'
import { listenLocalSocket } from '../lib/localSocket.js'
import { newPipePath } from '../lib/windows/pipeAuth.js'
import type { PipeTarget } from '../lib/windows/pipeClient.js'
import { attachLocalWsServer, type LocalWsBackend } from '../localWsServer.js'
import { serviceConnector } from './localConnection.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'

const gate = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const BOOT = 'b'.repeat(48)

describe('services over the authenticated local pipe protocol', () => {
  const cleanup: Array<() => void | Promise<void>> = []
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
  const endpoint = () => {
    if (process.platform === 'win32') return newPipePath()
    const root = mkdtempSync('/tmp/hsp-')
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    return join(root, `harness-${randomBytes(16).toString('hex')}`)
  }
  const core = async (over: Partial<Pick<ServiceLinksOptions, 'owned' | 'read' | 'answer'>> = {}) => {
    const target = { pipe: endpoint(), token: randomBytes(32) }
    const pipe = await listenLocalSocket((_req, res) => { res.statusCode = 404; res.end() }, target.pipe, { token: target.token })
    cleanup.push(pipe.close)
    const backend: LocalWsBackend = {
      registerLocalClient: vi.fn(() => true), unregisterLocalClient: vi.fn(async () => {}),
      handleLocalFrame: vi.fn(), handleLocalBinary: vi.fn(async () => {}),
    }
    const links = createServiceLinks({ token: BOOT, owned: { search: ['session_search'] },
      answer: () => ({ current: true }), log: () => {}, ...over,
    })
    const unusedTcp = http.createServer()
    const local = attachLocalWsServer(unusedTcp, { machineId: 'machine', backend, localSocketServer: pipe.server, services: links })
    let closed = false
    const close = async () => { if (!closed) { closed = true; await local.close() } }
    cleanup.push(close)
    return { target, links, backend, close }
  }
  const service = (pipe: () => Promise<PipeTarget | null>, connected: (connection: CoreConnection) => void, log = (_line: string) => {}): ServiceProcess => {
    const running = runServiceProcess({ name: 'search', socketPath: '', machineId: 'machine', token: BOOT,
      env: {}, log, requests: { session_search: (payload) => ({ hits: [payload.query] }) }, onConnected: connected,
      connect: serviceConnector({ dataDir: '/unused', port: 1234 }, { platform: 'win32', pipe }), initialBackoffMs: 100,
    })
    cleanup.push(() => running.stop())
    return running
  }

  it('registers through the real local service door and rediscovers a restarted core and rotated token', async () => {
    const first = await core(), second = await core()
    let current = first.target
    const discovery = vi.fn(async () => current)
    const opened = [gate<CoreConnection>(), gate<CoreConnection>()]
    let count = 0
    const running = service(discovery, (connection) => opened[count++]!.resolve(connection))
    const initial = await opened[0]!.promise
    await expect(initial.query('fixture')).resolves.toEqual({ current: true })
    await expect(first.links.call('search', 'session_search', { query: 'first' })).resolves.toEqual({ hits: ['first'] })
    expect(first.backend.registerLocalClient).not.toHaveBeenCalled()
    current = second.target
    await first.close()
    await opened[1]!.promise
    expect(discovery).toHaveBeenCalledTimes(2)
    await expect(second.links.call('search', 'session_search', { query: 'second' })).resolves.toEqual({ hits: ['second'] })
    expect(second.backend.registerLocalClient).not.toHaveBeenCalled()
    running.stop()
  })

  it.each([
    { count: 4097, dshBytes: 0 },
    { count: 1600, dshBytes: 1_600_000 },
  ])('reads complete compact $count-row/$dshBytes-byte facts through the actual authenticated socket', async ({ count, dshBytes }) => {
    const name = (index: number) => `Current ${index}`
    const rows = Array.from({ length: count }, (_, index) => ({
      schemaVersion: 2, agentId: `member-${index}`, sessionId: index === 1 ? '' : `session-${index}`,
      engine: index === 4 ? 'terminal' : 'claude', registeredAt: 100 + index, transcriptPath: `/history/${index}`,
      lastHookAt: 200 + index, active: index !== 2, cwd: null, defaultName: name(index), title: null,
      ...(index === 1 ? {} : { dsh: index === 2 ? null : index === 3 ? '' : 'stored' }),
      ...(index === 0 ? { launch: { state: 'starting' } } : index === 3 ? { launch: { state: 'ready' } }
        : index === 5 ? { launch: { state: 'failed', error: 'FAILED' } }
          : index === 6 ? { launch: { state: 'failed', error: 'FAILED', detail: '' } }
            : index === 7 ? { launch: { state: 'held', service: 'engine', detail: 'Wait' } } : {}),
    }) as RegisteredSession)
    const members = new Map(rows.map(row => [row.agentId, row])), shown = new Set(rows.slice(0, 8).map(row => row.agentId))
    const registry = { rows: () => members.values(), byAgent: (id: string) => members.get(id),
      advertisedRows: function* () { for (const row of members.values()) if (shown.has(row.agentId)) yield row },
      terminalAvailable: (id: string) => shown.has(id),
      list: () => { throw new Error('AGGREGATE_REGISTRY_READ_FORBIDDEN') },
    } as unknown as CoreApiDeps['registry']
    const parts = createFrameParts({ core: fakeCore({ agents: { byAgent: registry.byAgent, terminalAvailable: registry.terminalAvailable } }),
      epoch: id => members.has(id) ? 'current' : undefined })
    cleanup.push(() => parts.disabled('viewers'))
    const published = new Map<string, string>()
    for (const index of [0, 4, 8, 9]) {
      const value = dshBytes && [0, 8].includes(index) ? 'x'.repeat(dshBytes) : index === 4 ? '' : `published-${index}`
      if (dshBytes && [0, 8].includes(index)) rows[index]!.dsh = value
      published.set(rows[index]!.agentId, value)
      expect(parts.answer('viewers', 'frame_part', { agentId: rows[index]!.agentId, frameEpoch: 'current', fields: { dsh: value } }, () => true)).toEqual({ ok: true })
    }
    const cloud = { agentId: 'cloud', sessionId: 'cloud-session', engine: 'fo', registeredAt: 500,
      transcriptPath: '/history/cloud', lastHookAt: 501, displayName: 'Cloud', runtimeProfile: 'cloud-model' }
    const deps = { registry, serviceRead: { ids: function* () { yield cloud.agentId }, row: () => cloud },
      facts: (row: RegisteredSession) => agentFacts(row, shown.has(row.agentId), parts.read(row.agentId)),
      runtimeProfile: (row: RegisteredSession) => row.engine === 'terminal' ? null : 'selected-model',
      turns: { running: (id: string) => id === 'session-0' }, machine: { id: () => 'machine', computerId: () => 'computer', name: () => 'Desk' },
      signedIn: () => true, environment: () => 'prod', hasWindow: () => true,
    }
    const api = createCoreApi(deps as unknown as CoreApiDeps)
    const server = await core({ owned: { wifi: [], devices: [] },
      answer: () => { throw new Error('AGGREGATE_QUERY_FORBIDDEN') },
      read: (service, query, receive, signal, authority) => answerSessionRead(api, service, query, receive, signal, authority),
    })
    const dataDir = dirname(server.target.pipe), workspace = realpathSync(dataDir)
    for (const row of rows) row.cwd = dataDir
    const connector = serviceConnector({ dataDir, port: 1234 }, { platform: 'win32', pipe: async () => server.target })
    const wifiOpened = gate<CoreConnection>()
    const wifi = runServiceProcess({ name: 'wifi', socketPath: '', machineId: 'machine', token: BOOT,
      env: {}, requests: {}, connect: connector, onConnected: wifiOpened.resolve })
    cleanup.push(() => wifi.stop())
    const wifiConnection = await wifiOpened.promise
    await expect(wifiConnection.read!('session_read_advertised', {}, () => {})).rejects.toThrow('READ_NOT_DECLARED')
    let seen = 0
    const view = await readWifiView((scope, receive, signal) => readCoreSessionRecords(wifiConnection, scope, receive, signal), 'machine', undefined,
      record => { if (record.type === 'row') seen++; else if (record.type === 'begin') expect(record.payload.header.version).toBe(2) })
    expect(seen).toBe(count + 1)
    const visibleRuntime = ['starting', 'starting', 'unavailable', 'ready', 'ready', 'unavailable', 'unavailable', 'ready']
    const runtime = (index: number) => visibleRuntime[index] ?? 'unavailable'
    const packageId = (row: RegisteredSession) => published.get(row.agentId) ?? row.dsh ?? null
    expect(view).toStrictEqual({ hasWindow: true,
      store: rows.map((row, index) => ({ agentId: row.agentId, machineId: 'machine', packageId: packageId(row),
        engine: row.engine, workspace, state: index === 2 ? 'inactive' : 'active', runtime: runtime(index),
        ...(index === 5 ? { error: 'FAILED' } : index === 6 ? { error: '' } : {}) })),
      agents: rows.slice(0, 8).map((row, index) => ({ agentId: row.agentId, name: name(index), engine: row.engine,
        packageId: packageId(row), workspace, runtime: runtime(index), state: index === 0 ? 'running' : 'idle' })),
    })
    let devicesCore!: DevicesCore, devicesDeps!: DevicesDeps
    const devicesOpened = gate<CoreConnection>()
    const ignore = () => {}
    const devices = runDevicesService({ dataDir, socketPath: '', machineId: 'machine', token: BOOT, processEnv: {},
      start: (givenCore, ports, givenDeps) => {
        devicesCore = givenCore; devicesDeps = givenDeps
        ports.devices = { card: ignore, desk: ignore, swarms: ignore, unread: ignore, appFocus: ignore, seen: ignore,
          settings: ignore, windowFocus: ignore, windowReply: ignore, windowGone: ignore, engines: ignore, commanders: ignore,
          observed: () => false, inboxPoll: async () => ({ off: true }), inboxGone: ignore, stop: async () => {} }
        return {}
      },
      run: options => runServiceProcess({ ...options, env: {}, connect: connector, onConnected: connection => {
        options.onConnected!(connection); devicesOpened.resolve(connection)
      } }),
    })
    cleanup.push(() => devices.stop())
    const devicesConnection = await devicesOpened.promise
    await expect(devicesDeps.refresh!()).resolves.toBe(true)
    await expect(devicesConnection.read!('session_read_registered', {}, () => {})).rejects.toThrow('READ_NOT_DECLARED')
    await expect(devicesDeps.refresh!()).resolves.toBe(true)
    expect(devicesCore.agents.advertised()).toStrictEqual([
      ...rows.slice(0, 8).map(row => ({ agentId: row.agentId, sessionId: row.sessionId, engine: row.engine,
        registeredAt: row.registeredAt, transcriptPath: row.transcriptPath, lastHookAt: row.lastHookAt, active: row.active, cwd: row.cwd,
        ...(row.dsh === undefined ? {} : { dsh: row.dsh }), ...(row.launch ? { launch: row.launch } : {}),
        displayName: row.defaultName, runtimeProfile: row.engine === 'terminal' ? null : 'selected-model' })),
      { agentId: 'cloud', sessionId: 'cloud-session', engine: 'fo', registeredAt: 500, transcriptPath: '/history/cloud', lastHookAt: 501,
        displayName: 'Cloud', selectedModel: 'cloud-model', runtimeProfile: 'cloud-model' },
    ])
    expect(devicesCore.machine.id()).toBe('machine'); expect(devicesCore.machine.computerId()).toBe('computer')
    expect(devicesCore.clients.hasWindow()).toBe(true); expect(devicesCore.account.signedIn()).toBe(true)
    expect(devicesCore.account.environment()).toBe('prod')
    expect(server.backend.registerLocalClient).not.toHaveBeenCalled()
  })

  it('sends no service token or application frame to a server whose 101 has no daemon proof', async () => {
    const path = endpoint(), server = http.createServer()
    const wss = new WebSocketServer({ server })
    const closed = gate<void>(), frames: unknown[] = []
    wss.on('connection', (socket) => {
      socket.on('message', (raw) => frames.push(raw))
      socket.once('close', () => closed.resolve())
    })
    await new Promise<void>((resolve) => server.listen(path, resolve))
    cleanup.push(async () => {
      for (const socket of wss.clients) socket.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const failed = gate<void>(), connected = vi.fn()
    const running = service(async () => ({ pipe: path, token: randomBytes(32) }), connected,
      (line) => { if (line.endsWith('SERVICE_CONNECT_UNAVAILABLE')) failed.resolve() })
    await Promise.all([closed.promise, failed.promise])
    running.stop()
    expect(connected).not.toHaveBeenCalled()
    expect(frames).toEqual([])
  })

  it('refuses a stale token, then connects using the next discovered record without falling back', async () => {
    const server = await core(), ready = gate<CoreConnection>(), failed = gate<void>()
    let target = { ...server.target, token: randomBytes(32) }
    const discovery = vi.fn(async () => target)
    service(discovery, ready.resolve, (line) => { if (line.endsWith('SERVICE_CONNECT_UNAVAILABLE')) failed.resolve() })
    await failed.promise
    target = server.target
    await ready.promise
    expect(discovery).toHaveBeenCalledTimes(2)
    await expect(server.links.call('search', 'session_search', { query: 'recovered' })).resolves.toEqual({ hits: ['recovered'] })
    expect(server.backend.registerLocalClient).not.toHaveBeenCalled()
  })
})
