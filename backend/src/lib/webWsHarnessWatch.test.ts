import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hachi, plan item 3 (docs/design/2026-11-12-hachi.md, "Across machines"): the home daemon subscribes to a harness on
// another of the person's machines with a sealed `harness_watch`, and that machine answers with `harness_event`s sealed
// to the one connection that asked (`targetConnId`). The design rests on two facts about the real backend, checked here
// end to end through web-ws, the hub and the registry, with only Redis, the database and auth faked:
//   - a targeted frame reaches that connection, and
//   - that connection is not counted as an app, so the machine keeps its live events (transcript text) off the relay.
// The connection is the daemon's tool relay: `?client=relay`, then the `machine_select { tool: true }` an agent client sends
// its daemon (agentClient/daemon.ts), which the daemon puts on an isolated pool and forwards with `relayIsolation: true`
// (cli localWsServer.ts). An older daemon forwards `{ tool: true }` alone, on the pool it shares with the desktop window.
const m = vi.hoisted(() => ({ auth: vi.fn(), upgrade: vi.fn(), findUnique: vi.fn() }))
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('./ssoAuth.js', async original => ({ ...await original<typeof import('./ssoAuth.js')>(), authenticateAccessToken: m.auth }))
vi.mock('./wsServer.js', async original => ({ ...await original<typeof import('./wsServer.js')>(), createWss: () => ({ handleUpgrade: m.upgrade }) }))
vi.mock('./prisma.js', () => ({
  prisma: { machine: { findUnique: m.findUnique, findMany: vi.fn(async () => []) }, deviceBinding: { findMany: vi.fn(async () => []) } },
  machineAlive: { OR: [{ deletedAt: null }, { deletedAt: { isSet: false } }] },
}))
vi.mock('./bus.js', () => ({
  getAgentPresence: vi.fn(async () => ({ managerId: 'manager' })), getAgentPresenceMany: vi.fn(async () => new Map()),
  subscribeStatus: vi.fn(async () => () => {}), getDevicePresence: vi.fn(async () => false),
  subscribeDeviceStatus: vi.fn(async () => () => {}), subscribeDeviceMachineListChanged: vi.fn(async () => () => {}),
  subscribeDeviceE2eePair: vi.fn(async () => () => {}), subscribeMachineShareChanged: vi.fn(async () => () => {}),
  setAgentClientCount: vi.fn(async () => undefined), setAgentClientCountsBatch: vi.fn(async () => undefined),
  getAgentClientState: vi.fn(async () => ({ totals: { ui: 0, commander: 0, commanderActive: 0 } })),
  bumpCommanderJoinGeneration: vi.fn(async () => 1), publishDown: vi.fn(async () => 1), publishUp: vi.fn(async () => 1),
  publishTerminalDown: vi.fn(async () => 1), subscribeUp: vi.fn(async () => () => {}), subscribeTerminalUp: vi.fn(async () => () => {}),
  subscribePod: vi.fn(async () => () => {}), recordConnOwners: vi.fn(async () => undefined), forgetConnOwner: vi.fn(async () => undefined),
}))
vi.mock('./providerLink.js', () => ({ machineOnline: vi.fn(async () => true), routeDown: vi.fn(async () => 1) }))
vi.mock('./machineLifecycle.js', () => ({ ensureMachineReady: vi.fn(async () => {}), getMachineLifecycleStatus: vi.fn(async () => 'running') }))
vi.mock('./webAccountPushes.js', () => ({ relayWebDocumentPushes: vi.fn(async () => () => {}) }))

import { handleWebUpgrade } from './webWs.js'
import { deliverUpLocal } from './hub.js'
import * as registry from './registry.js'

const owner = { sub: 'owner', email: 'owner@example.com', role: 'user', autonomousEnv: 'prod' }
const machineId = 'studio'
const flush = async () => { for (let i = 0; i < 400; i++) await Promise.resolve() }

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0
  send = vi.fn()
  close = vi.fn(() => { this.readyState = 3; this.emit('close', 1000, Buffer.alloc(0)) })
  terminate = vi.fn(() => this.close())
  ping = vi.fn()
  frame(body: unknown) { this.emit('message', Buffer.from(JSON.stringify(body)), false) }
  sent() { return this.send.mock.calls.map(c => JSON.parse(c[0] as string) as { type: string; payload?: Record<string, unknown> }) }
}
const raw = () => ({ write: vi.fn(), destroy: vi.fn(), destroyed: false, on: vi.fn(), once: vi.fn() })

/** The home daemon's relay to [machineId], selecting with [select]'s extra fields. */
async function toolRelay(select: Record<string, unknown> = { tool: true, relayIsolation: true }): Promise<Socket> {
  const ws = new Socket()
  m.upgrade.mockImplementation((_r, _s, _h, done) => done(ws))
  handleWebUpgrade({ url: '/api/web-ws?autonomousEnv=prod&client=relay&v=1.0.0&auth=http', headers: { 'sec-websocket-protocol': 'access-token' } } as never, raw() as never, Buffer.alloc(0))
  await flush()
  ws.frame({ type: 'machine_select', payload: { machineId, localProtocolVersion: 1, ...select } })
  await flush()
  expect(ws.sent()).toContainEqual(expect.objectContaining({ type: 'connected', payload: expect.objectContaining({ machineId }) }))
  return ws
}

beforeEach(() => {
  vi.clearAllMocks()
  m.auth.mockResolvedValue(owner)
  m.findUnique.mockResolvedValue({ machineId, userId: owner.sub, deletedAt: null, autonomousEnv: 'prod', billingStatus: 'active' })
})
afterEach(() => {
  for (const client of registry.clientsFor(machineId)) registry.removeClient(machineId, client.connId)
})

describe('a harness_watch subscriber on another machine', () => {
  it('gets the frames targeted at its connection, is not counted as an app, and hears no broadcast', async () => {
    const ws = await toolRelay()
    const [conn] = registry.clientsFor(machineId)
    expect(conn).toBeDefined()
    const before = ws.send.mock.calls.length

    deliverUpLocal(machineId, { targetConnId: conn.connId, webEligible: false, commanderEligible: false, frame: { type: 'harness_event', payload: { sealed: true } } })
    expect(ws.sent().slice(before).map((f) => f.type)).toEqual(['harness_event'])

    // While a subscription is open the machine's daemon must still hold its live events: the subscriber is no app.
    expect(registry.clientCounts(machineId).ui).toBe(0)
    deliverUpLocal(machineId, { webEligible: true, commanderEligible: false, frame: { type: 'text_delta', payload: { sealed: true } } })
    expect(ws.sent().slice(before).map((f) => f.type)).toEqual(['harness_event'])
  })

  it('an older daemon\'s tool select, shared with the desktop window, is still attached as an app that hears broadcasts', async () => {
    // Without `relayIsolation` the connection may be the one the desktop window rides too (cli remoteRelay.ts acquire):
    // made a guest, that window would freeze.
    const ws = await toolRelay({ tool: true })
    const before = ws.send.mock.calls.length

    expect(registry.clientCounts(machineId).ui).toBe(1)
    deliverUpLocal(machineId, { webEligible: true, commanderEligible: false, frame: { type: 'text_delta', payload: { sealed: true } } })
    expect(ws.sent().slice(before).map((f) => f.type)).toEqual(['text_delta'])
  })
})
