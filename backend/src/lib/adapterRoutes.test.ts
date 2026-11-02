import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The machine socket sends each frame for one viewer through that viewer's route (lib/terminalRoute.ts), on the real
// handler; the harness is adapterShortTurns.test.ts's, with the routes faked.
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
const routes = vi.hoisted(() => ({ hop: vi.fn(), targeted: vi.fn(), close: vi.fn() }))
vi.mock('./terminalRoute.js', () => ({ createConnectionRoutes: vi.fn(() => routes) }))
vi.mock('./p2pSignaling.js', async original => ({ ...await original<typeof import('./p2pSignaling.js')>(),
  terminalP2pPolicy: () => ({ enabled: true, protocolVersion: 1, stunUrls: ['stun:example'], openWaitMs: 1_000 }) }))
vi.mock('../utils/logger.js', () => ({ logger: { warn: m.warn, info: m.info, error: vi.fn(), debug: vi.fn() } }))

import { handleAdapterUpgrade } from './adapterWs.js'
import { encodeTerminalHop, TerminalBinaryKind, TerminalHopDirection } from './terminalBinary.js'

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
const sealed = (k: 'p' | 'g' = 'p') => ({ __e2e: { v: 1, n: 1, k, ct: 'x' } })
const viewer = '0f0e0d0c-0b0a-4908-8706-050403020100'

beforeEach(() => {
  vi.clearAllMocks()
  m.auth.mockResolvedValue({ sub: 'owner', email: 'owner@example.com', role: 'user', autonomousEnv: 'prod' })
  m.resolve.mockResolvedValue({ machine: { machineId: 'routed-mac', userId: 'owner', name: 'Mac', billingStatus: 'not_required', sessionKind: null }, created: false })
  m.publishUp.mockResolvedValue(1)
  m.recordTurn.mockResolvedValue(undefined)
  m.nodeRole.mockResolvedValue({ touch: vi.fn(), detach: vi.fn(async () => {}) })
})

describe('a machine socket and its viewers\' frames', () => {
  it('delivers an untargeted frame to this process\'s viewers before a targeted frame sent after it, and publishes it for the others', async () => {
    const hub = await import('./hub.js')
    const ws = await machineSocket()
    ws.frame({ t: 'up', frame: { type: 'agent_synced', payload: { __e2e: 'y' } } })
    ws.frame({ t: 'up', targetConnId: 'c1', frame: { type: 'rpc_result', payload: { __e2e: 'z' } } })
    await flush()
    const local = vi.mocked(hub.deliverUpLocal)
    expect(local).toHaveBeenCalledWith('routed-mac', { webEligible: true, commanderEligible: false, frame: { type: 'agent_synced', payload: { __e2e: 'y' } } })
    expect(local.mock.invocationCallOrder[0]).toBeLessThan(routes.targeted.mock.invocationCallOrder[0]!)
    // The Redis copy carries this process's id, which this process's own subscription skips.
    expect(m.publishUp.mock.calls[0]![1]).toMatchObject({ frame: { type: 'agent_synced' }, originPid: expect.any(String) })
  })

  it('publishes a frame whose target is not a plausible connection id as before, without a route', async () => {
    const ws = await machineSocket()
    ws.frame({ t: 'up', targetConnId: 'x'.repeat(200), frame: { type: 'rpc_result', payload: { __e2e: 'z' } } })
    await flush()
    expect(routes.targeted).not.toHaveBeenCalled()
    expect(m.publishUp.mock.calls[0]![1]).toMatchObject({ targetConnId: 'x'.repeat(200) })
  })

  it('routes a hop, a terminal frame, a p2p frame and a targeted reply by their connection, and publishes the rest as before', async () => {
    const ws = await machineSocket()
    const frame = Buffer.alloc(36)
    frame.write('HTRM'); frame[4] = 3; frame[5] = TerminalBinaryKind.output; frame.writeUInt32BE(16, 16)
    const packet = encodeTerminalHop(TerminalHopDirection.up, viewer, frame)!
    ws.emit('message', packet, true)
    ws.frame({ t: 'up', targetConnId: viewer, frame: { type: 'terminal_output', payload: sealed() } })
    ws.frame({ t: 'up', targetConnId: viewer, frame: { type: 'p2p_answer', payload: sealed() } })
    ws.frame({ t: 'up', targetConnId: 'c2', frame: { type: 'e2e_welcome', payload: { x: 1 } } })
    ws.frame({ t: 'up', frame: { type: 'text_delta', payload: { __e2e: 'y' } } })
    // A terminal frame that fails today's checks (not sealed) is still dropped before any route.
    ws.frame({ t: 'up', targetConnId: viewer, frame: { type: 'terminal_output', payload: { plain: true } } })
    await flush()
    expect(routes.hop).toHaveBeenCalledTimes(1)
    expect(Buffer.from(routes.hop.mock.calls[0]![0] as Uint8Array)).toEqual(packet)
    expect(routes.hop.mock.calls[0]![1]).toBe(viewer)
    expect(routes.targeted.mock.calls.map(([msg]) => msg)).toEqual([
      { webEligible: true, commanderEligible: false, targetConnId: viewer, targetKind: 'web', frame: { type: 'terminal_output', payload: sealed() } },
      { webEligible: true, commanderEligible: false, targetConnId: viewer, targetKind: 'web', frame: { type: 'p2p_answer', payload: sealed() } },
      { webEligible: true, commanderEligible: false, targetConnId: 'c2', frame: { type: 'e2e_welcome', payload: { x: 1 } } },
    ])
    expect(m.publishUp.mock.calls.map(([, msg]) => msg)).toEqual([
      { webEligible: true, commanderEligible: false, frame: { type: 'text_delta', payload: { __e2e: 'y' } }, originPid: expect.any(String) }])
    ws.emit('close', 1000, Buffer.alloc(0))
    expect(routes.close).toHaveBeenCalled()
  })
})
