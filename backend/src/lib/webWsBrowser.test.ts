import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Agent browser streams through both web socket handlers (spec 2026-11-10-agent-browser-design, "Nothing is dropped
// silently"). The harness is webWsOffline.test.ts's: authentication, the machine row, the bus and the hub are faked.
const m = vi.hoisted(() => ({
  auth: vi.fn(), upgrade: vi.fn(), presence: vi.fn(), online: vi.fn(), attach: vi.fn(), machineFindUnique: vi.fn(),
}))
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
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
vi.mock('./machineLifecycle.js', () => ({ ensureMachineReady: vi.fn(async () => {}), getMachineLifecycleStatus: vi.fn(async () => 'online') }))
vi.mock('./webAccountPushes.js', () => ({ relayWebDocumentPushes: vi.fn(async () => () => {}) }))
vi.mock('./hub.js', () => ({ attachHubClient: m.attach, trackSocketLiveness: () => () => {} }))

import { handleWebUpgrade } from './webWs.js'
import { TerminalBinaryKind } from './terminalBinary.js'

const owner = { sub: 'owner', email: 'owner@example.com', role: 'user', autonomousEnv: 'prod' }
const mac = { machineId: 'owner-mac', userId: 'owner', autonomousEnv: 'prod', billingStatus: 'not_required', authMode: 'remote', deletedAt: null }
const flush = async () => { for (let i = 0; i < 400; i++) await Promise.resolve() }
const sealed = { __e2e: { v: 1, n: 1, k: 'p', ct: 'x' } }
const RATE = { type: 'agent_browser_transport_error', payload: { code: 'RATE' } }

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0
  send = vi.fn()
  close = vi.fn(() => { this.readyState = 3; this.emit('close') })
  terminate = vi.fn(() => this.close())
  frame(body: unknown) { this.emit('message', Buffer.from(JSON.stringify(body)), false) }
  binary(kind: TerminalBinaryKind, bytes = 36) {
    const frame = Buffer.alloc(bytes)
    frame.write('HTRM'); frame[4] = 3; frame[5] = kind; frame.writeUInt32BE(bytes - 20, 16)
    this.emit('message', frame, true)
  }
  sent() { return this.send.mock.calls.map(c => JSON.parse(c[0] as string)) }
  rateErrors() { return this.sent().filter(f => f.type === 'agent_browser_transport_error') }
}
const raw = () => ({ write: vi.fn(), destroy: vi.fn(), destroyed: false, on: vi.fn(), once: vi.fn() })
let hub: { connId: string; detach: ReturnType<typeof vi.fn>; sendDown: ReturnType<typeof vi.fn>; sendTerminalDown: ReturnType<typeof vi.fn> }
let now = 1_000_000

async function userSocket(): Promise<Socket> {
  const ws = new Socket()
  m.upgrade.mockImplementation((_r, _s, _h, done) => done(ws))
  handleWebUpgrade({ url: '/api/web-ws?autonomousEnv=prod&client=relay', headers: { 'sec-websocket-protocol': 'access-token' } } as never, raw() as never, Buffer.alloc(0))
  await flush()
  ws.frame({ type: 'machine_select', payload: { machineId: 'owner-mac' } })
  await flush()
  return ws
}

async function legacySocket(): Promise<Socket> {
  const ws = new Socket()
  m.upgrade.mockImplementation((_r, _s, _h, done) => done(ws))
  handleWebUpgrade({ url: '/api/web-ws', headers: { 'sec-websocket-protocol': 'a'.repeat(64) } } as never, raw() as never, Buffer.alloc(0))
  await flush()
  return ws
}

beforeEach(() => {
  vi.clearAllMocks()
  now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  m.auth.mockResolvedValue(owner)
  m.machineFindUnique.mockResolvedValue(mac)
  hub = { connId: 'conn', detach: vi.fn(), sendDown: vi.fn(), sendTerminalDown: vi.fn() }
  m.attach.mockReturnValue(hub)
  m.presence.mockResolvedValue('manager')
  m.online.mockResolvedValue(true)
})
afterEach(() => { vi.restoreAllMocks() })

describe.each([['the per-user handler', userSocket], ['the legacy per-agent handler', legacySocket]])('%s', (_name, open) => {
  it('passes kind 8 to the machine', async () => {
    const ws = await open()
    ws.binary(TerminalBinaryKind.browser)
    expect(hub.sendTerminalDown).toHaveBeenCalledOnce()
    expect(ws.rateErrors()).toEqual([])
  })

  it('refuses kind 8 past 64 KiB a second, tells the client at most once a second, and leaves terminal input alone', async () => {
    const ws = await open()
    for (let i = 0; i < 63; i++) ws.binary(TerminalBinaryKind.browser, 64 * 1024)
    expect(hub.sendTerminalDown).toHaveBeenCalledTimes(60)
    expect(ws.rateErrors()).toEqual([RATE])
    expect(ws.sent().some(f => f.type === 'terminal_transport_error')).toBe(false)
    now += 1_000
    ws.binary(TerminalBinaryKind.browser, 64 * 1024)
    expect(ws.rateErrors()).toHaveLength(2)
    ws.binary(TerminalBinaryKind.input)
    expect(hub.sendTerminalDown).toHaveBeenCalledTimes(61)
  })

  it('relays the browser control frames down, and drops unknown, unsealed and backend-only ones', async () => {
    const ws = await open()
    for (const type of ['agent_browser_open', 'agent_browser_ack', 'agent_browser_close']) ws.frame({ type, payload: sealed })
    ws.frame({ type: 'agent_browser_foo', payload: sealed })
    ws.frame({ type: 'agent_browser_open_result', payload: sealed })
    ws.frame({ type: 'agent_browser_open', payload: { agentId: 'plain' } })
    ws.frame({ type: 'agent_browser_transport_error', payload: { code: 'RATE' } })
    await flush()
    expect(hub.sendDown.mock.calls.map(([frame]) => frame.type)).toEqual(['agent_browser_open', 'agent_browser_ack', 'agent_browser_close'])
  })

  it('never refuses agent_browser_ack at 16 a second, and answers a refused one with the transport error', async () => {
    const ws = await open()
    // Sixteen at a time, as they arrive: the per-user socket's ordered inbox is bounded.
    for (let i = 0; i < 961; i++) {
      ws.frame({ type: 'agent_browser_ack', payload: sealed })
      if (i % 16 === 15) await flush()
    }
    await flush()
    expect(hub.sendDown).toHaveBeenCalledTimes(960)
    expect(ws.rateErrors()).toEqual([RATE])
  })
})

it('reads no presence for a browser frame', async () => {
  const ws = await userSocket()
  const reads = m.presence.mock.calls.length
  now += 10_000
  for (let i = 0; i < 10; i++) ws.frame({ type: 'agent_browser_ack', payload: sealed })
  await flush()
  expect(hub.sendDown).toHaveBeenCalledTimes(10)
  expect(m.presence.mock.calls.length).toBe(reads)
})
