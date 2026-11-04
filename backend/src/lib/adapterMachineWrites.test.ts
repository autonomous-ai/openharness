import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// How many times an adapter socket writes its machine's row (Ken's prod scan of 11-04, #2676: `Machine.update` by
// machineId in background work was slow 53 times in 32 minutes). The socket's own code and dailyTracking run for real;
// Prisma, Redis and sign-in are faked, and every `machine.update` is counted.
const m = vi.hoisted(() => ({
  auth: vi.fn(), upgrade: vi.fn(),
  machineService: { resolveOrCreateForComputer: vi.fn(), resolveForTeamComputer: vi.fn() },
  machineUpdate: vi.fn(), userFindUnique: vi.fn(), nodeRole: vi.fn(), record: vi.fn(),
}))
vi.mock('./ssoAuth.js', async original => ({ ...await original<typeof import('./ssoAuth.js')>(), authenticateAccessToken: m.auth }))
vi.mock('./wsServer.js', async original => ({ ...await original<typeof import('./wsServer.js')>(), createWss: () => ({ handleUpgrade: m.upgrade }) }))
vi.mock('../services/MachineService.js', () => ({ machineService: m.machineService }))
vi.mock('./prisma.js', () => ({
  prisma: { machine: { update: m.machineUpdate }, user: { findUnique: m.userFindUnique }, swarmAgent: { aggregateRaw: vi.fn(async () => []) } },
  machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
}))
vi.mock('./bus.js', () => ({
  publishUp: vi.fn(async () => {}), claimMachineOwner: vi.fn(async () => true), releaseMachineOwner: vi.fn(async () => {}),
  publishDeviceE2eePair: vi.fn(), publishTerminalUp: vi.fn(), subscribeTerminalDown: vi.fn(async () => () => {}),
  setMachineAppState: vi.fn(), clearMachineAppState: vi.fn(),
}))
vi.mock('./adapterAccountPushes.js', () => ({ relayAccountPushes: vi.fn(async () => () => {}) }))
vi.mock('./deviceKeyLog.js', () => ({ appendDeviceKey: vi.fn(), touchDeviceKey: vi.fn() }))
vi.mock('./nodeRole.js', () => ({ attachNodeRole: m.nodeRole, PRESENCE_TTL_SEC: 30 }))
vi.mock('./productUsage.js', () => ({ recordRelayUsage: m.record, markActivity: vi.fn(async () => {}) }))
vi.mock('./hub.js', () => ({
  CLIENTS_FRAME: '__clients', CLIENTS_DIRTY: '__clients_dirty', LIVENESS_TICK_MS: 5_000, CLIENT_IDLE_DEADLINE_MS: 75_000,
  DEVICE_IDLE_DEADLINE_MS: 35_000, CLIENT_HEARTBEAT_MS: 25_000, deliverTerminalUpLocal: vi.fn(), deliverUpLocal: vi.fn(),
  pushDeviceRevoked: vi.fn(), sendClientsControl: vi.fn(), recomputeAndSendClients: vi.fn(), attachHubClient: vi.fn(),
  trackSocketLiveness: () => () => {},
}))

import { handleAdapterUpgrade } from './adapterWs.js'
import type { AuthUser } from './ssoAuth.js'

const COMPUTER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const MIN = 60_000
const t0 = new Date('2026-11-04T05:00:00.000Z')
const owner: AuthUser = { sub: 'owner', email: 'owner@example.com', role: 'user', autonomousEnv: 'prod' }
// The row as the upgrade reads it: every fact the CLI sends on connect already stored, stamped a minute ago.
const row = {
  machineId: 'mac-1', userId: 'owner', name: 'MacBook Pro', billingStatus: 'not_required', sessionKind: 'computer',
  hostname: 'MacBook-Pro.local', clientVersion: '0.5.13', computerId: COMPUTER, countryCode: 'VN', lastSeenAt: new Date(t0.getTime() - MIN),
}
const flush = async () => { for (let i = 0; i < 400; i++) await Promise.resolve() }

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0
  send = vi.fn()
  close = vi.fn(() => { this.readyState = 3; this.emit('close') })
  terminate = vi.fn(() => this.close())
}

let ws: Socket
const connect = async (version = '0.5.13') => {
  ws = new Socket()
  m.upgrade.mockImplementation((_r, _s, _h, done) => done(ws))
  const req = { url: `/api/adapter-ws?computer=${COMPUTER}&label=MacBook-Pro.local&v=${version}&autonomousEnv=prod`,
    headers: { 'sec-websocket-protocol': 'access-token', 'cf-ipcountry': 'VN' } }
  handleAdapterUpgrade(req as never, { write: vi.fn(), destroy: vi.fn(), on: vi.fn(), once: vi.fn() } as never, Buffer.alloc(0))
  await flush()
}
const heartbeatAt = async (ms: number) => {
  vi.setSystemTime(t0.getTime() + ms)
  m.nodeRole.mock.calls.at(-1)![0].onHeartbeat(); await flush()
}
const writes = () => m.machineUpdate.mock.calls.map(c => c[0].data as Record<string, unknown>)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(t0)
  m.auth.mockResolvedValue(owner)
  m.machineUpdate.mockResolvedValue({})
  m.record.mockResolvedValue(undefined)
  m.userFindUnique.mockResolvedValue({ gridName: null })
  m.nodeRole.mockResolvedValue({ touch: vi.fn(), detach: vi.fn(async () => {}) })
  m.machineService.resolveOrCreateForComputer.mockResolvedValue({ machine: row, created: false })
})
afterEach(() => { ws?.close(); vi.useRealTimers() })

describe('an adapter socket\'s writes to its machine row', () => {
  it('writes nothing on a reconnect that changed no fact, a minute after the row\'s last stamp, and still counts the connect', async () => {
    await connect()
    expect(writes()).toEqual([])
    expect(m.record.mock.calls.map(c => c[2])).toEqual(['relay_machine_connections'])
  })

  it('stamps on heartbeats only once the row\'s stamp is 5 minutes old, then once per 5 minutes, and once at close', async () => {
    await connect()
    for (const at of [15_000, 2 * MIN, 3 * MIN + 59_000]) await heartbeatAt(at)
    expect(writes()).toEqual([])
    await heartbeatAt(4 * MIN) // 5 minutes after the row's stamp
    await heartbeatAt(8 * MIN)
    await heartbeatAt(9 * MIN)
    expect(writes()).toEqual([{ lastSeenAt: new Date(t0.getTime() + 4 * MIN) }, { lastSeenAt: new Date(t0.getTime() + 9 * MIN) }])
    vi.setSystemTime(t0.getTime() + 10 * MIN)
    ws.close(); await flush()
    expect(writes()).toHaveLength(3)
    expect(writes()[2]).toEqual({ lastSeenAt: new Date(t0.getTime() + 10 * MIN) })
  })

  it('writes one update on a connect after 5 minutes away, with a changed fact riding in it', async () => {
    m.machineService.resolveOrCreateForComputer.mockResolvedValue({ machine: { ...row, lastSeenAt: new Date(t0.getTime() - 10 * MIN) }, created: false })
    await connect('0.5.14')
    expect(writes()).toEqual([{ clientVersion: '0.5.14', lastSeenAt: t0 }])
  })

  it('writes a changed fact at once even when the stamp is not due', async () => {
    await connect('0.5.14')
    expect(writes()).toEqual([{ clientVersion: '0.5.14' }])
  })

  it('stamps at once a row that was never stamped, and seeds an empty name', async () => {
    m.machineService.resolveOrCreateForComputer.mockResolvedValue({ machine: { ...row, name: null, lastSeenAt: null }, created: false })
    await connect()
    expect(writes()).toEqual([{ name: 'MacBook-Pro.local', lastSeenAt: t0 }])
  })

  it('flips a former team row before it attaches, and does not write that again on connect', async () => {
    m.machineService.resolveOrCreateForComputer.mockResolvedValue({ machine: { ...row, sessionKind: 'team' }, created: false })
    await connect()
    expect(writes()).toEqual([{ sessionKind: 'computer' }])
  })

  it('retries a changed fact whose connect write failed on the next heartbeat, then stops', async () => {
    m.machineUpdate.mockRejectedValueOnce(new Error('mongo slow'))
    await connect('0.5.14')
    await heartbeatAt(15_000)
    await heartbeatAt(30_000)
    expect(writes()).toEqual([{ clientVersion: '0.5.14' }, { clientVersion: '0.5.14' }])
  })

  it('retries a failed stamp on the next heartbeat', async () => {
    m.machineService.resolveOrCreateForComputer.mockResolvedValue({ machine: { ...row, lastSeenAt: null }, created: false })
    m.machineUpdate.mockRejectedValueOnce(new Error('mongo slow'))
    await connect()
    await heartbeatAt(15_000)
    expect(writes()).toEqual([{ lastSeenAt: t0 }, { lastSeenAt: new Date(t0.getTime() + 15_000) }])
  })
})
