import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A daemon's relay selecting a machine with no socket to the backend (#314). Production saw 1,884 selects in 10 minutes,
// 68% of them to offline machines: each one set up the whole relay (hub client, ack, presence reads) only for the
// daemon to hang up half a second later. A relay (any socket that declares no phone or web client, so every daemon
// already out there) is refused at once, with how long to wait; a phone or the web viewer still waits attached.
const m = vi.hoisted(() => ({
  auth: vi.fn(), upgrade: vi.fn(), presence: vi.fn(), online: vi.fn(), attach: vi.fn(),
  machineFindUnique: vi.fn(), shared: vi.fn(), warn: vi.fn(), info: vi.fn(),
}))
vi.mock('../utils/logger.js', () => ({ logger: { warn: m.warn, info: m.info, error: vi.fn(), debug: vi.fn() } }))
vi.mock('./machineAccess.js', async original => ({ ...await original<typeof import('./machineAccess.js')>(), sharedMachineAccess: m.shared }))
vi.mock('./ssoAuth.js', async original => ({ ...await original<typeof import('./ssoAuth.js')>(), authenticateAccessToken: m.auth }))
vi.mock('./wsServer.js', async original => ({ ...await original<typeof import('./wsServer.js')>(), createWss: () => ({ handleUpgrade: m.upgrade }) }))
vi.mock('./prisma.js', () => ({
  prisma: { machine: { findUnique: m.machineFindUnique, findMany: vi.fn(async () => []) }, deviceBinding: { findMany: vi.fn(async () => []) } },
  machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
}))
vi.mock('./bus.js', () => ({
  getAgentPresence: m.presence, getAgentPresenceMany: vi.fn(async () => new Map()), subscribeStatus: vi.fn(async () => () => {}),
  getDevicePresence: vi.fn(async () => false), subscribeDeviceStatus: vi.fn(async () => () => {}),
  subscribeDeviceMachineListChanged: vi.fn(async () => () => {}), subscribeDeviceE2eePair: vi.fn(async () => () => {}),
  subscribeMachineShareChanged: vi.fn(async () => () => {}),
}))
vi.mock('./providerLink.js', () => ({ machineOnline: m.online }))
vi.mock('./machineLifecycle.js', () => ({ ensureMachineReady: vi.fn(async () => {}), getMachineLifecycleStatus: vi.fn(async () => 'offline') }))
vi.mock('./webAccountPushes.js', () => ({ relayWebDocumentPushes: vi.fn(async () => () => {}) }))
vi.mock('./hub.js', () => ({ attachHubClient: m.attach, trackSocketLiveness: () => () => {} }))

import { handleWebUpgrade, OFFLINE_RETRY_AFTER_MS } from './webWs.js'

const owner = { sub: 'owner', email: 'owner@example.com', role: 'user', autonomousEnv: 'prod' }
const mac = { machineId: 'owner-mac', userId: 'owner', autonomousEnv: 'prod', billingStatus: 'not_required', authMode: 'remote', deletedAt: null }
const flush = async () => { for (let i = 0; i < 400; i++) await Promise.resolve() }

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0
  send = vi.fn()
  close = vi.fn(() => { this.readyState = 3; this.emit('close') })
  terminate = vi.fn(() => this.close())
  frame(body: unknown) { this.emit('message', Buffer.from(JSON.stringify(body)), false) }
  sent() { return this.send.mock.calls.map(c => JSON.parse(c[0] as string)) }
}
const raw = () => ({ write: vi.fn(), destroy: vi.fn(), destroyed: false, on: vi.fn(), once: vi.fn() })

async function selects(payload: Record<string, unknown>, query = ''): Promise<Socket> {
  const ws = new Socket()
  m.upgrade.mockImplementation((_r, _s, _h, done) => done(ws))
  handleWebUpgrade({ url: `/api/web-ws?autonomousEnv=prod${query}`, headers: { 'sec-websocket-protocol': 'access-token' } } as never, raw() as never, Buffer.alloc(0))
  await flush()
  ws.frame({ type: 'machine_select', payload: { machineId: 'owner-mac', ...payload } })
  await flush()
  return ws
}

beforeEach(() => {
  vi.clearAllMocks()
  m.auth.mockResolvedValue(owner)
  m.machineFindUnique.mockResolvedValue(mac)
  m.attach.mockReturnValue({ connId: 'conn', detach: vi.fn() })
  m.presence.mockResolvedValue(null)
  m.online.mockResolvedValue(false)
})

describe('a relay selecting an offline machine', () => {
  it.each([['an older daemon', {}], ['a daemon that asks', { offline: 'refuse' }]])('%s is refused at once with how long to wait, and no relay is set up', async (_who, payload) => {
    const ws = await selects(payload)
    expect(ws.sent()).toContainEqual({ type: 'machine_select_error',
      payload: { machineId: 'owner-mac', error: 'MACHINE_OFFLINE', retryAfterMs: 30_000 } })
    expect(OFFLINE_RETRY_AFTER_MS).toBe(30_000)
    expect(m.attach).not.toHaveBeenCalled()
    expect(ws.sent().some(f => f.type === 'connected' && f.payload?.machineId)).toBe(false)
  })

  it('goes through when the machine is online', async () => {
    m.presence.mockResolvedValue('manager')
    m.online.mockResolvedValue(true)
    const ws = await selects({})
    expect(m.attach).toHaveBeenCalledOnce()
    expect(ws.sent()).toContainEqual(expect.objectContaining({ type: 'connected', payload: expect.objectContaining({ machineId: 'owner-mac' }) }))
  })
})

it.each(['mobile', 'web'])('a %s client still attaches to an offline machine and waits for it', async client => {
  const ws = await selects({}, `&client=${client}`)
  expect(m.attach).toHaveBeenCalledOnce()
  expect(ws.sent()).toContainEqual(expect.objectContaining({ type: 'connected', payload: expect.objectContaining({ machineId: 'owner-mac' }) }))
})

// Prod logs 2026-10-28: about 45 refused selects an hour, and the log did not say why.
describe('a refused machine select', () => {
  it.each([
    ['unknown', null, null],
    ['deleted', { ...mac, deletedAt: new Date('2026-10-01T00:00:00Z') }, null],
    ['not_shared', { ...mac, userId: 'someone-else' }, null],
    ['share_check_failed', { ...mac, userId: 'someone-else' }, new Error('database down')],
  ])('logs why: %s', async (reason, binding, failure) => {
    m.machineFindUnique.mockResolvedValue(binding)
    if (failure) m.shared.mockRejectedValue(failure)
    else m.shared.mockResolvedValue(null)
    const ws = await selects({}, '&client=web')
    expect(ws.sent()).toContainEqual({ type: 'machine_select_error', payload: { machineId: 'owner-mac', error: 'NOT_YOUR_MACHINE' } })
    expect(m.warn).toHaveBeenCalledWith('machine_select rejected', { userId: 'owner', machineId: 'owner-mac', reason })
  })
})

// Prod, 2026-10-28: 2,304 of 2,308 opens in 15 minutes declared no client and lived a median 0.4 s, and the disconnect
// line said only who. It now says which client and version, how the socket closed, after how long, and what its selects
// were answered (lib/wsAttribution.ts), so a relay's churn can be told apart from a person's reconnects.
describe('a closed socket', () => {
  const lines = (message: string) => m.info.mock.calls.filter(c => c[0] === message).map(c => c[1])

  it('logs a relay refused as offline with its client, close, lifetime and select', async () => {
    const ws = await selects({}, '&client=relay&v=0.9.1')
    ws.emit('close', 1000, Buffer.from('handshake failed'))
    const [connected] = lines('web user connected')
    expect(connected).toMatchObject({ endpoint: 'web', client: 'relay', version: '0.9.1', userId: 'owner' })
    expect(lines('web user disconnected')).toEqual([{ ...connected, code: 1000, reason: 'handshake failed',
      aliveMs: expect.any(Number), selects: 1, select: 'MACHINE_OFFLINE' }])
  })

  it('logs a phone with its release, the machine it had selected, and the select accepted', async () => {
    m.online.mockResolvedValue(true)
    const ws = await selects({}, '&client=mobile&release=1.4.2')
    ws.emit('close', 1006, Buffer.alloc(0))
    expect(lines('web user disconnected')).toEqual([expect.objectContaining({ client: 'mobile', version: '1.4.2', machineId: 'owner-mac',
      code: 1006, selects: 1, select: 'accepted' })])
  })

  it('logs a client that declared nothing as unknown', async () => {
    const ws = await selects({})
    ws.emit('close', 1000, Buffer.alloc(0))
    expect(lines('web user disconnected')[0]).toMatchObject({ client: 'unknown', version: null })
  })
})
