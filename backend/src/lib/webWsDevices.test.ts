import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A web socket's device feed (DB optimization roadmap, Phase 2 item 7). Each open socket re-read the account's device
// bindings from the database every 30 s to notice a device whose worker died without saying it went offline. The
// bindings change only on a pair or a revoke, so the socket now keeps them, re-reads them when a change is pushed,
// and its 30 s check reads live presence alone.
const m = vi.hoisted(() => ({
  auth: vi.fn(), upgrade: vi.fn(), deviceFindMany: vi.fn(), subscribeDeviceStatus: vi.fn(), devicePresence: vi.fn(),
}))
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('./ssoAuth.js', async original => ({ ...await original<typeof import('./ssoAuth.js')>(), authenticateAccessToken: m.auth }))
vi.mock('./wsServer.js', async original => ({ ...await original<typeof import('./wsServer.js')>(), createWss: () => ({ handleUpgrade: m.upgrade }) }))
vi.mock('./prisma.js', () => ({
  prisma: { machine: { findUnique: vi.fn(), findMany: vi.fn(async () => []) }, deviceBinding: { findMany: m.deviceFindMany } },
  machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
}))
vi.mock('./bus.js', () => ({
  getAgentPresence: vi.fn(), getAgentPresenceMany: vi.fn(async () => new Map()), subscribeStatus: vi.fn(async () => () => {}),
  getDevicePresence: m.devicePresence, subscribeDeviceStatus: m.subscribeDeviceStatus,
  subscribeDeviceMachineListChanged: vi.fn(async () => () => {}), subscribeDeviceE2eePair: vi.fn(async () => () => {}),
  subscribeMachineShareChanged: vi.fn(async () => () => {}),
}))
vi.mock('./providerLink.js', () => ({ machineOnline: vi.fn() }))
vi.mock('./machineLifecycle.js', () => ({ ensureMachineReady: vi.fn(async () => {}), getMachineLifecycleStatus: vi.fn() }))
vi.mock('./webAccountPushes.js', () => ({ relayWebDocumentPushes: vi.fn(async () => () => {}) }))
vi.mock('./hub.js', () => ({ attachHubClient: vi.fn(), trackSocketLiveness: () => () => {} }))

import { DEVICE_BINDINGS_REREAD_MS, handleWebUpgrade } from './webWs.js'

const owner = { sub: 'owner', email: 'owner@example.com', role: 'user', autonomousEnv: 'prod' }
const flush = async () => { for (let i = 0; i < 400; i++) await Promise.resolve() }

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0
  send = vi.fn()
  close = vi.fn(() => { this.readyState = 3; this.emit('close', 1000, Buffer.alloc(0)) })
  terminate = vi.fn(() => this.close())
  frame(body: unknown) { this.emit('message', Buffer.from(JSON.stringify(body)), false) }
  sent() { return this.send.mock.calls.map(c => JSON.parse(c[0] as string)) }
}
const raw = () => ({ write: vi.fn(), destroy: vi.fn(), destroyed: false, on: vi.fn(), once: vi.fn() })

type StatusMsg = { deviceId: string; online: boolean; lastSeenAt?: string; removed?: true }
let push: (msg: StatusMsg) => void = () => { throw new Error('the socket did not subscribe') }
let online = new Set<string>()

async function opens(): Promise<Socket> {
  const ws = new Socket()
  m.upgrade.mockImplementation((_r, _s, _h, done) => done(ws))
  handleWebUpgrade({ url: '/api/web-ws?autonomousEnv=prod&client=web', headers: { 'sec-websocket-protocol': 'access-token' } } as never, raw() as never, Buffer.alloc(0))
  await vi.advanceTimersByTimeAsync(0)
  await flush()
  return ws
}

/** The device statuses of the last full picture the socket sent (the 30 s check sends every device it knows). */
const lastPicture = (ws: Socket) => ws.sent().filter((f) => f.type === 'devices_status').at(-1)?.payload.statuses
const tick = async () => { await vi.advanceTimersByTimeAsync(30_000); await flush() }
const bindings = (...rows: Array<{ deviceId: string; lastSeenAt?: Date | null }>) =>
  rows.map((r) => ({ deviceId: r.deviceId, lastSeenAt: r.lastSeenAt ?? null }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  online = new Set()
  m.auth.mockResolvedValue(owner)
  m.deviceFindMany.mockResolvedValue(bindings({ deviceId: 'dial' }))
  m.devicePresence.mockImplementation(async (id: string) => online.has(id))
  m.subscribeDeviceStatus.mockImplementation(async (_user: string, cb: (msg: StatusMsg) => void) => { push = cb; return () => {} })
})
afterEach(() => { vi.useRealTimers() })

describe('a web socket\'s device feed', () => {
  it('checks live presence every 30 s without reading the device bindings again', async () => {
    const ws = await opens()
    expect(m.deviceFindMany).toHaveBeenCalledOnce()
    expect(lastPicture(ws)).toEqual([{ deviceId: 'dial', online: false, lastSeenAt: null }])

    online.add('dial')
    await tick()
    expect(lastPicture(ws)).toEqual([{ deviceId: 'dial', online: true, lastSeenAt: null }])
    // A worker died holding the device's socket: nobody says offline, the presence key just ages out.
    online.delete('dial')
    await tick()
    await tick()
    expect(lastPicture(ws)).toEqual([{ deviceId: 'dial', online: false, lastSeenAt: null }])
    expect(m.deviceFindMany).toHaveBeenCalledOnce()
  })

  it('drops a revoked device at once, and the next check does not list it', async () => {
    m.deviceFindMany.mockResolvedValue(bindings({ deviceId: 'dial' }, { deviceId: 'lamp' }))
    const ws = await opens()
    push({ deviceId: 'lamp', online: false, removed: true })
    await flush()
    await tick()
    expect(lastPicture(ws)).toEqual([{ deviceId: 'dial', online: false, lastSeenAt: null }])
    expect(m.deviceFindMany).toHaveBeenCalledOnce()
  })

  it('reads the bindings again when a device it does not know reports, and lists it from then on', async () => {
    const ws = await opens()
    m.deviceFindMany.mockResolvedValue(bindings({ deviceId: 'dial' }, { deviceId: 'new', lastSeenAt: new Date('2026-10-29T03:00:00Z') }))
    online.add('new')
    push({ deviceId: 'new', online: true })
    await flush()
    expect(ws.sent()).toContainEqual({ type: 'devices_status', payload: { statuses: [{ deviceId: 'new', online: true }] } })
    expect(m.deviceFindMany).toHaveBeenCalledTimes(2)

    await tick()
    expect(lastPicture(ws)).toEqual([
      { deviceId: 'dial', online: false, lastSeenAt: null },
      { deviceId: 'new', online: true, lastSeenAt: '2026-10-29T03:00:00.000Z' },
    ])
  })

  // Each report may come from a device paired after the read under way began, so one more read follows it: never one per report.
  it('reads at most twice for a burst of reports from devices it does not know', async () => {
    await opens()
    let answer: (rows: unknown) => void = () => {}
    m.deviceFindMany.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    for (const id of ['a', 'b', 'c', 'd']) push({ deviceId: id, online: true })
    answer(bindings({ deviceId: 'dial' }, { deviceId: 'a' }, { deviceId: 'b' }, { deviceId: 'c' }, { deviceId: 'd' }))
    await flush()
    expect(m.deviceFindMany).toHaveBeenCalledTimes(3)
  })

  it('does not list a device the account does not hold, even after one reported on its channel', async () => {
    const ws = await opens()
    push({ deviceId: 'not-mine', online: true })
    await flush()
    await tick()
    expect(lastPicture(ws)).toEqual([{ deviceId: 'dial', online: false, lastSeenAt: null }])
  })

  it('reads again when a device was revoked while a read was in flight', async () => {
    const ws = await opens()
    let answer: (rows: unknown) => void = () => {}
    m.deviceFindMany.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    push({ deviceId: 'lamp', online: true })
    await flush()
    // The revoke lands after the read began: that read may still hold the device.
    m.deviceFindMany.mockResolvedValue(bindings({ deviceId: 'dial' }))
    push({ deviceId: 'lamp', online: false, removed: true })
    answer(bindings({ deviceId: 'dial' }, { deviceId: 'lamp' }))
    await flush()
    await tick()
    expect(lastPicture(ws)).toEqual([{ deviceId: 'dial', online: false, lastSeenAt: null }])
  })

  it('lists a device that reported while the first read was under way', async () => {
    let answer: (rows: unknown) => void = () => {}
    m.deviceFindMany.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const ws = await opens()
    // Paired after that read began: the read may not hold it.
    m.deviceFindMany.mockResolvedValue(bindings({ deviceId: 'dial' }, { deviceId: 'new' }))
    push({ deviceId: 'new', online: true })
    answer(bindings({ deviceId: 'dial' }))
    await flush()
    await tick()
    expect(lastPicture(ws)).toEqual([
      { deviceId: 'dial', online: false, lastSeenAt: null },
      { deviceId: 'new', online: false, lastSeenAt: null },
    ])
  })

  it('keeps the last seen time a device reported going offline', async () => {
    const ws = await opens()
    push({ deviceId: 'dial', online: false, lastSeenAt: '2026-10-29T04:00:00.000Z' })
    await flush()
    await tick()
    expect(lastPicture(ws)).toEqual([{ deviceId: 'dial', online: false, lastSeenAt: '2026-10-29T04:00:00.000Z' }])
  })

  it('still reads the bindings now and then, in case a change was lost on the way', async () => {
    await opens()
    await vi.advanceTimersByTimeAsync(DEVICE_BINDINGS_REREAD_MS)
    await flush()
    expect(m.deviceFindMany).toHaveBeenCalledTimes(2)
  })

  it('tries a failed read again at the next check, and sends nothing made up meanwhile', async () => {
    m.deviceFindMany.mockRejectedValueOnce(new Error('db down'))
    const ws = await opens()
    expect(lastPicture(ws)).toBeUndefined()
    await tick()
    expect(m.deviceFindMany).toHaveBeenCalledTimes(2)
    expect(lastPicture(ws)).toEqual([{ deviceId: 'dial', online: false, lastSeenAt: null }])
  })

  it('reads the bindings again when the client asks to watch devices', async () => {
    const ws = await opens()
    ws.frame({ type: 'devices_watch' })
    await flush()
    expect(m.deviceFindMany).toHaveBeenCalledTimes(2)
  })
})
