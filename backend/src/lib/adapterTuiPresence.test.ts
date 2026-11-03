import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A terminal app's presence on the real machine socket (change 5 of docs/plans/2026-10-31-live-events-relay-design.md):
// the account's daemons are told one is open. The socket harness is adapterShortTurns.test.ts's.
const m = vi.hoisted(() => ({
  auth: vi.fn(), upgrade: vi.fn(), noteTui: vi.fn(), resolve: vi.fn(), publishUp: vi.fn(), recordTurn: vi.fn(), nodeRole: vi.fn(), warn: vi.fn(), info: vi.fn(),
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
  publishTerminalUp: vi.fn(), noteTuiPresence: m.noteTui, subscribeTerminalDown: vi.fn(async () => () => {}), setMachineAppState: vi.fn(), clearMachineAppState: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks()
  m.auth.mockResolvedValue({ sub: 'owner', email: 'owner@example.com', role: 'user', autonomousEnv: 'prod' })
  m.resolve.mockResolvedValue({ machine: { machineId: 'looping-mac', userId: 'owner', name: 'Mac', billingStatus: 'not_required', sessionKind: null }, created: false })
  m.publishUp.mockResolvedValue(1)
  m.recordTurn.mockResolvedValue(undefined)
  m.nodeRole.mockResolvedValue({ touch: vi.fn(), detach: vi.fn(async () => {}) })
})

describe('a terminal app\'s presence', () => {
  const presence = (payload: Record<string, unknown>) => ({ t: 'up', webEligible: false, commanderEligible: false, frame: { type: 'app_presence', payload } })

  it('tells the account a terminal app is open, on Harness OS too, with its open or ping', async () => {
    const ws = await machineSocket()
    ws.frame(presence({ kind: 'open', surface: 'tui' }))
    ws.frame(presence({ kind: 'ping', surface: 'harness-os-pi' }))
    await flush()
    expect(m.noteTui.mock.calls).toEqual([['owner', 'open'], ['owner', 'ping']])
  })

  it('says nothing for the desktop app or a surface it does not know', async () => {
    const ws = await machineSocket()
    ws.frame(presence({ kind: 'open' }))
    ws.frame(presence({ kind: 'ping', surface: 'toaster' }))
    await flush()
    expect(m.noteTui).not.toHaveBeenCalled()
  })
})
