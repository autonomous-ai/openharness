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
import { SsoAuthError } from './ssoAuth.js'
import { env } from '../config/env.js'

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
    const payload = { machineId: 'owner-mac', error: 'NOT_YOUR_MACHINE', ...(reason === 'deleted' ? { reason } : {}) }
    expect(ws.sent()).toContainEqual({ type: 'machine_select_error', payload })
    expect(m.warn).toHaveBeenCalledWith('machine_select rejected', { userId: 'owner', machineId: 'owner-mac', reason })
  })

  // Phase 1 (roadmap 2026-10-28): a daemon kept dialling a machine deleted on 2026-09-03 every few seconds, because a deleted
  // machine, an unshared one and a share check that failed for a moment were all the same refusal. Only the person's own
  // deleted machine says so; anyone else's says nothing more than before, so the answer tells no one that it existed.
  it('says deleted only of the person\'s own machine', async () => {
    m.machineFindUnique.mockResolvedValue({ ...mac, userId: 'someone-else', deletedAt: new Date('2026-10-01T00:00:00Z') })
    const ws = await selects({}, '&client=relay')
    expect(ws.sent()).toContainEqual({ type: 'machine_select_error', payload: { machineId: 'owner-mac', error: 'NOT_YOUR_MACHINE' } })
  })
})

// Roadmap Phase 1.3: a bad token used to finish the upgrade and then close 4401. A socket that says it reads an HTTP refusal
// (`auth=http`, the daemon's relay from this release) is refused before the upgrade when WEB_WS_AUTH_HTTP_401 is on. A
// browser cannot read the status of a failed upgrade (it sees 1006), so the web build and the phone keep their 4401.
describe('a bad token', () => {
  const upgradeWith = async (query: string) => {
    const ws = new Socket()
    const socket = raw()
    m.upgrade.mockImplementation((_r, _s, _h, done) => done(ws))
    m.auth.mockRejectedValue(new SsoAuthError('expired', 'INVALID_TOKEN'))
    handleWebUpgrade({ url: `/api/web-ws?autonomousEnv=prod${query}`, headers: { 'sec-websocket-protocol': 'access-token' } } as never, socket as never, Buffer.alloc(0))
    await flush()
    return { ws, socket }
  }
  const switchedOn = (on: boolean) => { (env as { WEB_WS_AUTH_HTTP_401: boolean }).WEB_WS_AUTH_HTTP_401 = on }

  it('is refused with HTTP 401 before the upgrade, when switched on, for a socket that reads it', async () => {
    switchedOn(true)
    try {
      const { socket } = await upgradeWith('&client=relay&v=1.3.64&auth=http')
      expect(m.upgrade).not.toHaveBeenCalled()
      expect(socket.write).toHaveBeenCalledWith(expect.stringMatching(/^HTTP\/1\.1 401 /))
      expect(socket.destroy).toHaveBeenCalled()
    } finally { switchedOn(false) }
  })

  it.each([
    ['switched off', false, '&client=relay&auth=http'],
    ['a socket that does not say it reads it', true, '&client=web'],
  ])('closes 4401 after the upgrade when %s', async (_why, on, query) => {
    switchedOn(on)
    try {
      const { ws, socket } = await upgradeWith(query)
      expect(socket.write).not.toHaveBeenCalled()
      expect(ws.close).toHaveBeenCalledWith(4401, 'auth expired')
    } finally { switchedOn(false) }
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

  // Review of #2029: `ws` emits an error before the close; the line must carry the close's code, not none.
  it('takes the close code from the close, not an error before it', async () => {
    const ws = await selects({}, '&client=relay')
    ws.emit('error', new Error('read ECONNRESET'))
    ws.emit('close', 1006, Buffer.alloc(0))
    expect(lines('web user disconnected')).toEqual([expect.objectContaining({ code: 1006 })])
  })

  // Review of #2029: the old per-agent key path was upgraded and never tracked, so each of its sockets counted as refused.
  it('tracks a legacy per-agent socket like any other', async () => {
    const ws = new Socket()
    m.upgrade.mockImplementation((_r, _s, _h, done) => done(ws))
    m.attach.mockReturnValue({ connId: 'legacy-conn', detach: vi.fn(), sendDown: vi.fn() })
    handleWebUpgrade({ url: '/api/web-ws', headers: { 'sec-websocket-protocol': 'a'.repeat(64) } } as never, raw() as never, Buffer.alloc(0))
    await flush()
    ws.emit('close', 1001, Buffer.from('going away'))
    expect(lines('web client (legacy) disconnected')).toEqual([expect.objectContaining({ endpoint: 'web', client: 'unknown',
      machineId: expect.any(String), code: 1001, reason: 'going away', aliveMs: expect.any(Number) })])
  })

  it('logs a client that declared nothing as unknown', async () => {
    const ws = await selects({})
    ws.emit('close', 1000, Buffer.alloc(0))
    expect(lines('web user disconnected')[0]).toMatchObject({ client: 'unknown', version: null })
  })
})
