import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The account's feeds a per-user socket starts (WebSocket roadmap, Phase 1 item 4). Prod, 2026-10-29: about 121
// web-ws connects a minute living a median 0.4 s, nearly all daemon relays, and each one read the account's machine
// list and devices, subscribed a status channel per machine and four per-user channels, and armed a 30 s device
// re-read, none of which a relay ever reads. With WEB_WS_LAZY_FEEDS on, a socket that says it is a relay, a link or a
// group sync starts them only when it asks (`machines_watch`, `devices_watch`); every other socket is as before.
const m = vi.hoisted(() => ({
  auth: vi.fn(), upgrade: vi.fn(), presence: vi.fn(), online: vi.fn(), attach: vi.fn(), machineFindUnique: vi.fn(),
  machineFindMany: vi.fn(), deviceFindMany: vi.fn(), subscribeStatus: vi.fn(), subscribeDeviceStatus: vi.fn(),
  subscribeMachineList: vi.fn(), subscribeE2eePair: vi.fn(), documents: vi.fn(), lifecycle: vi.fn(),
}))
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('./ssoAuth.js', async original => ({ ...await original<typeof import('./ssoAuth.js')>(), authenticateAccessToken: m.auth }))
vi.mock('./wsServer.js', async original => ({ ...await original<typeof import('./wsServer.js')>(), createWss: () => ({ handleUpgrade: m.upgrade }) }))
vi.mock('./prisma.js', () => ({
  prisma: { machine: { findUnique: m.machineFindUnique, findMany: m.machineFindMany }, deviceBinding: { findMany: m.deviceFindMany } },
  machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
}))
vi.mock('./bus.js', () => ({
  getAgentPresence: m.presence, getAgentPresenceMany: vi.fn(async () => new Map()), subscribeStatus: m.subscribeStatus,
  getDevicePresence: vi.fn(async () => false), subscribeDeviceStatus: m.subscribeDeviceStatus,
  subscribeDeviceMachineListChanged: m.subscribeMachineList, subscribeDeviceE2eePair: m.subscribeE2eePair,
  subscribeMachineShareChanged: vi.fn(async () => () => {}),
}))
vi.mock('./providerLink.js', () => ({ machineOnline: m.online }))
vi.mock('./machineLifecycle.js', () => ({ ensureMachineReady: vi.fn(async () => {}), getMachineLifecycleStatus: m.lifecycle }))
vi.mock('./webAccountPushes.js', () => ({ relayWebDocumentPushes: m.documents }))
vi.mock('./hub.js', () => ({ attachHubClient: m.attach, trackSocketLiveness: () => () => {} }))

import { env } from '../config/env.js'
import { handleWebUpgrade } from './webWs.js'

const owner = { sub: 'owner', email: 'owner@example.com', role: 'user', autonomousEnv: 'prod' }
const mac = { machineId: 'owner-mac', userId: 'owner', autonomousEnv: 'prod', billingStatus: 'not_required', authMode: 'remote', deletedAt: null }
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

async function opens(query = ''): Promise<Socket> {
  const ws = new Socket()
  m.upgrade.mockImplementation((_r, _s, _h, done) => done(ws))
  handleWebUpgrade({ url: `/api/web-ws?autonomousEnv=prod${query}`, headers: { 'sec-websocket-protocol': 'access-token' } } as never, raw() as never, Buffer.alloc(0))
  await flush()
  return ws
}

/** Which of the account's feeds the socket started. */
const feeds = () => ({
  machines: m.machineFindMany.mock.calls.length > 0,
  devices: m.subscribeDeviceStatus.mock.calls.length > 0 || m.deviceFindMany.mock.calls.length > 0,
  machineList: m.subscribeMachineList.mock.calls.length > 0,
  documents: m.documents.mock.calls.length > 0,
  e2eePair: m.subscribeE2eePair.mock.calls.length > 0,
})
const all = { machines: true, devices: true, machineList: true, documents: true, e2eePair: true }
const none = { machines: false, devices: false, machineList: false, documents: false, e2eePair: false }

const before = env.WEB_WS_LAZY_FEEDS
beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  m.auth.mockResolvedValue(owner)
  m.machineFindUnique.mockResolvedValue(mac)
  m.machineFindMany.mockResolvedValue([{ machineId: 'owner-mac', billingStatus: 'not_required' }])
  m.deviceFindMany.mockResolvedValue([])
  m.attach.mockReturnValue({ connId: 'conn', detach: vi.fn() })
  m.presence.mockResolvedValue('manager')
  m.online.mockResolvedValue(true)
  m.lifecycle.mockResolvedValue('running')
  for (const sub of [m.subscribeStatus, m.subscribeDeviceStatus, m.subscribeMachineList, m.subscribeE2eePair, m.documents]) sub.mockResolvedValue(() => {})
})
afterEach(() => { env.WEB_WS_LAZY_FEEDS = before; vi.useRealTimers() })

describe('with WEB_WS_LAZY_FEEDS on', () => {
  beforeEach(() => { env.WEB_WS_LAZY_FEEDS = 'on' })

  it.each(['relay', 'link', 'group-sync'])('a %s socket starts none of the account\'s feeds', async client => {
    await opens(`&client=${client}`)
    expect(feeds()).toEqual(none)
  })

  it.each(['mobile', 'web', 'desktop'])('a %s socket starts them all, as before', async client => {
    await opens(`&client=${client}`)
    expect(feeds()).toEqual(all)
  })

  // Every daemon released before the relays said what they are: nothing tells it apart from an older app.
  it('a socket that declares nothing starts them all, as before', async () => {
    await opens()
    expect(feeds()).toEqual(all)
  })

  it('a relay that sends machines_watch gets the machine statuses', async () => {
    const ws = await opens('&client=relay')
    vi.useFakeTimers()
    ws.frame({ type: 'machines_watch' })
    await vi.advanceTimersByTimeAsync(300)
    vi.useRealTimers()
    await flush()
    expect(m.machineFindMany).toHaveBeenCalledOnce()
    expect(m.subscribeStatus).toHaveBeenCalledWith('owner-mac', expect.any(Function))
    expect(ws.sent()).toContainEqual({ type: 'machines_status', payload: { statuses: [{ machineId: 'owner-mac', online: true, status: 'running' }] } })
  })

  it('a relay that sends devices_watch gets the device statuses and their re-read', async () => {
    m.deviceFindMany.mockResolvedValue([{ deviceId: 'dial', lastSeenAt: null }])
    const ws = await opens('&client=relay')
    ws.frame({ type: 'devices_watch' })
    await flush()
    expect(m.subscribeDeviceStatus).toHaveBeenCalledWith('owner', expect.any(Function))
    expect(ws.sent()).toContainEqual({ type: 'devices_status', payload: { statuses: [{ deviceId: 'dial', online: false, lastSeenAt: null }] } })
  })

  // The machine-list channel also carries the account moving to another environment, which ends every socket signed in
  // to the old one. A relay that holds a machine keeps hearing it; one refused at its select never subscribes.
  it('a relay attached to a machine still ends when the account changes environment', async () => {
    let tell: ((msg: unknown) => void) | null = null
    m.subscribeMachineList.mockImplementation(async (_user: string, cb: (msg: unknown) => void) => { tell = cb; return () => {} })
    const ws = await opens('&client=relay')
    expect(m.subscribeMachineList).not.toHaveBeenCalled()
    ws.frame({ type: 'machine_select', payload: { machineId: 'owner-mac' } })
    await flush()
    expect(m.subscribeMachineList).toHaveBeenCalledOnce()
    tell!({ reason: 'environment_changed', autonomousEnv: 'dev' })
    expect(ws.close).toHaveBeenCalledWith(4403, 'env:dev')
  })

  it('a relay refused at its select subscribes nothing', async () => {
    m.presence.mockResolvedValue(null)
    m.online.mockResolvedValue(false)
    const ws = await opens('&client=relay')
    ws.frame({ type: 'machine_select', payload: { machineId: 'owner-mac' } })
    await flush()
    expect(ws.sent()).toContainEqual(expect.objectContaining({ type: 'machine_select_error' }))
    expect(feeds()).toEqual(none)
  })

  it('a relay selecting again subscribes the machine list once', async () => {
    const ws = await opens('&client=relay')
    for (let i = 0; i < 3; i++) {
      ws.frame({ type: 'machine_select', payload: { machineId: 'owner-mac' } })
      await flush()
    }
    expect(m.subscribeMachineList).toHaveBeenCalledOnce()
  })

  it('a relay closed while its machine-list subscription is pending lets it go', async () => {
    const unsub = vi.fn()
    let done: ((u: () => void) => void) | null = null
    m.subscribeMachineList.mockImplementation(() => new Promise(resolve => { done = resolve }))
    const ws = await opens('&client=relay')
    ws.frame({ type: 'machine_select', payload: { machineId: 'owner-mac' } })
    await flush()
    ws.emit('close', 1000, Buffer.alloc(0))
    done!(unsub)
    await flush()
    expect(unsub).toHaveBeenCalledOnce()
  })
})

describe('with WEB_WS_LAZY_FEEDS off (the default)', () => {
  beforeEach(() => { env.WEB_WS_LAZY_FEEDS = 'off' })

  it.each(['relay', 'link', 'group-sync', 'mobile'])('a %s socket starts them all, as before', async client => {
    await opens(`&client=${client}`)
    expect(feeds()).toEqual(all)
  })
})

// The test run sets no WEB_WS_LAZY_FEEDS, so what the module read is the default.
it('defaults to off', () => {
  expect(process.env.WEB_WS_LAZY_FEEDS).toBeUndefined()
  expect(before).toBe('off')
})

// The ack's node_status said `running` for an online machine whatever `machine_nodes` held, and read it on every
// accepted select anyway (WebSocket roadmap Phase 1 item 4).
describe('the select ack', () => {
  const nodeStatus = (ws: Socket) => ws.sent().filter(f => f.type === 'node_status')

  it('says an online machine is running without reading its lifecycle', async () => {
    const ws = await opens('&client=relay')
    ws.frame({ type: 'machine_select', payload: { machineId: 'owner-mac' } })
    await flush()
    expect(nodeStatus(ws)).toEqual([{ type: 'node_status', payload: { online: true, status: 'running' } }])
    expect(m.lifecycle).not.toHaveBeenCalled()
  })

  it('reads the lifecycle of an offline machine a phone waits on', async () => {
    m.presence.mockResolvedValue(null)
    m.online.mockResolvedValue(false)
    m.lifecycle.mockResolvedValue('stopped')
    m.machineFindMany.mockResolvedValue([])
    const ws = await opens('&client=mobile')
    ws.frame({ type: 'machine_select', payload: { machineId: 'owner-mac' } })
    await flush()
    expect(nodeStatus(ws)).toEqual([{ type: 'node_status', payload: { online: false, status: 'stopped' } }])
    expect(m.lifecycle).toHaveBeenCalledWith('owner-mac')
  })

  it('says offline for a machine whose lifecycle is unknown', async () => {
    m.presence.mockResolvedValue(null)
    m.online.mockResolvedValue(false)
    m.lifecycle.mockResolvedValue('unknown')
    m.machineFindMany.mockResolvedValue([])
    const ws = await opens('&client=mobile')
    ws.frame({ type: 'machine_select', payload: { machineId: 'owner-mac' } })
    await flush()
    expect(nodeStatus(ws)).toEqual([{ type: 'node_status', payload: { online: false, status: 'offline' } }])
  })
})
