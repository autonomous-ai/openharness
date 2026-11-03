import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The machine socket's short-turn cap (lib/shortTurnGuard.ts) on the real handler. The socket harness is the one in
// teamSessionSockets.test.ts: authentication, the machine row, the bus and the hub are faked.
const m = vi.hoisted(() => ({
  auth: vi.fn(), upgrade: vi.fn(), resolve: vi.fn(), publishUp: vi.fn(), recordTurn: vi.fn(), nodeRole: vi.fn(), warn: vi.fn(), info: vi.fn(),
}))
vi.mock('./ssoAuth.js', async original => ({ ...await original<typeof import('./ssoAuth.js')>(), authenticateAccessToken: m.auth }))
vi.mock('./wsServer.js', async original => ({ ...await original<typeof import('./wsServer.js')>(), createWss: () => ({ handleUpgrade: m.upgrade }) }))
vi.mock('../services/MachineService.js', () => ({ machineService: { resolveOrCreateForComputer: m.resolve } }))
vi.mock('./prisma.js', () => ({
  prisma: { machine: { update: vi.fn(async () => ({})), findUnique: vi.fn(async () => null) }, user: { findUnique: vi.fn(async () => null) } },
  machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
}))
vi.mock('./bus.js', () => ({
  publishUp: m.publishUp, claimMachineOwner: vi.fn(async () => true), releaseMachineOwner: vi.fn(), publishDeviceE2eePair: vi.fn(),
  publishTerminalUp: vi.fn(), subscribeTerminalDown: vi.fn(async () => () => {}), setMachineAppState: vi.fn(), clearMachineAppState: vi.fn(),
}))
vi.mock('./adapterAccountPushes.js', () => ({ relayAccountPushes: vi.fn(async () => () => {}) }))
vi.mock('./deviceKeyLog.js', () => ({ appendDeviceKey: vi.fn(), touchDeviceKey: vi.fn() }))
vi.mock('./nodeRole.js', () => ({ attachNodeRole: m.nodeRole, PRESENCE_TTL_SEC: 30 }))
vi.mock('./hub.js', () => ({
  CLIENTS_FRAME: '__clients', CLIENTS_DIRTY: '__clients_dirty', LIVENESS_TICK_MS: 5_000, CLIENT_IDLE_DEADLINE_MS: 75_000,
  DEVICE_IDLE_DEADLINE_MS: 35_000, CLIENT_HEARTBEAT_MS: 25_000, deliverTerminalUpLocal: vi.fn(), deliverUpLocal: vi.fn(),
  pushDeviceRevoked: vi.fn(), sendClientsControl: vi.fn(), recomputeAndSendClients: vi.fn(), attachHubClient: vi.fn(),
  trackSocketLiveness: () => () => {},
}))
vi.mock('./dailyTracking.js', async original => ({ ...await original<typeof import('./dailyTracking.js')>(),
  touchMachineOnlineDay: vi.fn(async () => {}), touchUserOnlineDay: vi.fn(async () => {}), touchClientOnlineDay: vi.fn(async () => {}),
  recordTurnStarted: m.recordTurn }))
vi.mock('../utils/logger.js', () => ({ logger: { warn: m.warn, info: m.info, error: vi.fn(), debug: vi.fn() } }))

import { handleAdapterUpgrade } from './adapterWs.js'

const flush = async () => { for (let i = 0; i < 400; i++) await Promise.resolve() }

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0
  send = vi.fn()
  close = vi.fn((code?: number, reason?: string) => { this.readyState = 3; this.emit('close', code, Buffer.from(reason ?? '')) })
  terminate = vi.fn(() => this.close())
  frame(body: unknown) { this.emit('message', Buffer.from(JSON.stringify(body)), false) }
}

async function machineSocket(query = ''): Promise<Socket> {
  const ws = new Socket()
  m.upgrade.mockImplementation((_r, _s, _h, done) => done(ws))
  handleAdapterUpgrade({ url: `/api/adapter-ws?computer=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&label=Mac&autonomousEnv=prod${query}`,
    headers: { 'sec-websocket-protocol': 'access-token' } } as never,
  { write: vi.fn(), destroy: vi.fn(), destroyed: false, on: vi.fn(), once: vi.fn() } as never, Buffer.alloc(0))
  await flush()
  return ws
}
const turnsRelayed = () => m.publishUp.mock.calls.filter(([, msg]) => (msg as { frame: { type: string } }).frame.type === 'turn_started').length

beforeEach(() => {
  vi.clearAllMocks()
  m.auth.mockResolvedValue({ sub: 'owner', email: 'owner@example.com', role: 'user', autonomousEnv: 'prod' })
  m.resolve.mockResolvedValue({ machine: { machineId: 'looping-mac', userId: 'owner', name: 'Mac', billingStatus: 'not_required', sessionKind: null }, created: false })
  m.publishUp.mockResolvedValue(1)
  m.recordTurn.mockResolvedValue(undefined)
  m.nodeRole.mockResolvedValue({ touch: vi.fn(), detach: vi.fn(async () => {}) })
})

describe('a machine starting turns in a loop', () => {
  it('has its turn starts counted and relayed 21 times in a row, then neither, and is logged once', async () => {
    const ws = await machineSocket()

    for (let i = 0; i < 30; i++) ws.frame({ t: 'up', frame: { type: 'turn_started', agentId: 'agent-1', payload: { __e2e: 'x' } } })
    await flush()

    expect(turnsRelayed()).toBe(21)
    expect(m.recordTurn).toHaveBeenCalledTimes(21)
    expect(m.warn.mock.calls.filter(([message]) => String(message).includes('turn starts'))).toEqual([
      [expect.stringContaining('turn starts'), expect.objectContaining({ machineId: 'looping-mac' })],
    ])
  })

  it('still relays everything else while its turn starts are held', async () => {
    const ws = await machineSocket()
    for (let i = 0; i < 30; i++) ws.frame({ t: 'up', frame: { type: 'turn_started', agentId: 'agent-1' } })

    ws.frame({ t: 'up', frame: { type: 'text_delta', payload: { __e2e: 'y' } } })
    ws.frame({ t: 'up', frame: { type: 'turn_started', agentId: 'agent-1', replay: true } })
    await flush()

    const types = m.publishUp.mock.calls.map(([, msg]) => (msg as { frame: { type: string; replay?: boolean } }).frame)
    expect(types.at(-2)?.type).toBe('text_delta')
    expect(types.at(-1)).toMatchObject({ type: 'turn_started', replay: true })
  })
})

// WebSocket roadmap Phase 0 (same harness): adapter reconnects could not be explained, the logs had no close codes.
describe('a machine socket', () => {
  it('logs its daemon version, and how and when it closed, a superseded one too (4000)', async () => {
    const first = await machineSocket('&v=0.9.1')
    // The second connect closes the first (4000 superseded), which still logs its own end.
    const second = await machineSocket('&v=0.9.1')
    expect(first.close).toHaveBeenCalledWith(4000, 'superseded')
    second.emit('close', 1006, Buffer.alloc(0))
    // The machine's socket left from the test before is superseded by the first connect here: only this test's two.
    const lines = m.info.mock.calls.filter(c => c[0] === 'adapter disconnected').map(c => c[1]).slice(-2)
    expect(lines).toEqual([
      expect.objectContaining({ endpoint: 'adapter', client: 'daemon', version: '0.9.1', machineId: 'looping-mac', code: 4000,
        reason: 'superseded', aliveMs: expect.any(Number) }),
      expect.objectContaining({ endpoint: 'adapter', client: 'daemon', machineId: 'looping-mac', code: 1006 }),
    ])
  })
})
