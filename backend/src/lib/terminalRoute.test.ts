import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { encodeTerminalHop, TerminalBinaryKind, TerminalHopDirection } from './terminalBinary.js'

const bus = vi.hoisted(() => ({
  publishUp: vi.fn(async (..._args: unknown[]) => 1),
  publishTerminalUp: vi.fn(async (..._args: unknown[]) => 1),
  publishPodHop: vi.fn(async (..._args: unknown[]) => 1),
  publishPodJson: vi.fn(async (..._args: unknown[]) => 1),
  connOwner: vi.fn(async (_connId: string): Promise<string | null> => null),
  recordConnOwners: vi.fn(async () => undefined),
  forgetConnOwner: vi.fn(async () => undefined),
  subscribePod: vi.fn(async () => () => undefined),
  subscribeUp: async () => () => undefined,
  subscribeTerminalUp: async () => () => undefined,
  publishDown: async () => 1,
  publishTerminalDown: async () => 1,
  setAgentClientCount: async () => undefined,
  setAgentClientCountsBatch: async () => undefined,
  getAgentClientState: async () => ({ totals: { ui: 0, commander: 0, commanderActive: 0 }, commanderJoinGeneration: 1 }),
  bumpCommanderJoinGeneration: async () => 1,
}))
vi.mock('./bus.js', () => bus)
vi.mock('./providerLink.js', () => ({ routeDown: async (_m: string, _d: unknown, fallback: () => Promise<number>) => fallback() }))
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const { attachHubClient, startPodRoutes } = await import('./hub.js')
const { createConnectionRoutes, MAX_ROUTES } = await import('./terminalRoute.js')
const registry = await import('./registry.js')

const socket = (out: unknown[]): WebSocket => ({ readyState: 1, bufferedAmount: 0, send: (data: unknown) => out.push(data),
  close: vi.fn(), terminate: vi.fn(), on: () => undefined }) as unknown as WebSocket
const clientFrame = (byte: number) => {
  const frame = Buffer.alloc(36)
  frame.write('HTRM'); frame[4] = 3; frame[5] = TerminalBinaryKind.output; frame.writeUInt32BE(16, 16); frame[35] = byte
  return frame
}
const hop = (connId: string, byte: number) => encodeTerminalHop(TerminalHopDirection.up, connId, clientFrame(byte))!
const json = (connId: string, n: number) => ({ webEligible: true, commanderEligible: false, targetConnId: connId, targetKind: 'web' as const,
  frame: { type: 'terminal_output', payload: { n } } })
const flush = () => new Promise(resolve => setImmediate(resolve))
const remoteConn = () => '0f0e0d0c-0b0a-4908-8706-050403020100'
let machine = 0
const machineId = () => `route-${Date.now()}-${machine++}`

beforeEach(() => { for (const fn of Object.values(bus)) if (vi.isMockFunction(fn)) fn.mockClear(); bus.connOwner.mockImplementation(async () => null) })

describe('pod routes off (Phase 1 alone)', () => {
  it('delivers a hop and a targeted JSON frame to a local web connection without publishing, in order', () => {
    const id = machineId(), out: unknown[] = []
    const web = attachHubClient(socket(out), id, 'web')
    const routes = createConnectionRoutes(id)
    routes.hop(hop(web.connId, 1), web.connId)
    routes.targeted(json(web.connId, 2))
    routes.hop(hop(web.connId, 3), web.connId)
    expect(out).toHaveLength(3)
    expect(Buffer.from(out[0] as Uint8Array)).toEqual(clientFrame(1))
    expect(out[1]).toBe(JSON.stringify(json(web.connId, 2).frame))
    expect(Buffer.from(out[2] as Uint8Array)).toEqual(clientFrame(3))
    expect(bus.publishTerminalUp).not.toHaveBeenCalled()
    expect(bus.publishUp).not.toHaveBeenCalled()
    web.detach()
  })

  it('publishes for a connection that is not on this process, as before', async () => {
    const id = machineId(), routes = createConnectionRoutes(id), conn = remoteConn()
    const packet = hop(conn, 1)
    routes.hop(packet, conn)
    routes.targeted(json(conn, 2))
    expect(bus.publishTerminalUp).toHaveBeenCalledWith(id, packet)
    expect(bus.publishUp).toHaveBeenCalledWith(id, json(conn, 2))
    expect(bus.connOwner).not.toHaveBeenCalled()
  })

  it('keeps a connection on its first route: frames after a local viewer detaches are dropped, not published', () => {
    const id = machineId(), out: unknown[] = []
    const web = attachHubClient(socket(out), id, 'web')
    const routes = createConnectionRoutes(id)
    routes.hop(hop(web.connId, 1), web.connId)
    web.detach()
    routes.hop(hop(web.connId, 2), web.connId)
    routes.targeted(json(web.connId, 3))
    expect(out).toHaveLength(1)
    expect(bus.publishTerminalUp).not.toHaveBeenCalled()
    expect(bus.publishUp).not.toHaveBeenCalled()
  })

  it('delivers a frame targeted at a local device connection', () => {
    const id = machineId(), out: string[] = []
    const device = attachHubClient(socket(out), id, 'commander')
    const routes = createConnectionRoutes(id)
    routes.targeted({ webEligible: false, commanderEligible: true, targetConnId: device.connId, frame: { type: 'e2e_welcome', payload: { sealed: 1 } } })
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0]!)).toMatchObject({ type: 'e2e_welcome', machineId: id })
    expect(bus.publishUp).not.toHaveBeenCalled()
    device.detach()
  })

  it('sends a guest only the frames addressed to it', () => {
    const id = machineId(), ownerOut: unknown[] = [], guestOut: unknown[] = []
    const owner = attachHubClient(socket(ownerOut), id, 'web')
    const guest = attachHubClient(socket(guestOut), id, 'web', { guest: true })
    const routes = createConnectionRoutes(id)
    routes.targeted(json(guest.connId, 1))
    routes.hop(hop(owner.connId, 2), owner.connId)
    expect(guestOut).toHaveLength(1)
    expect(ownerOut).toHaveLength(1)
    owner.detach(); guest.detach()
  })

  it('still delivers locally when Redis takes no publish', async () => {
    bus.publishTerminalUp.mockImplementationOnce(async () => 0)
    const id = machineId(), out: unknown[] = []
    const web = attachHubClient(socket(out), id, 'web')
    createConnectionRoutes(id).hop(hop(web.connId, 1), web.connId)
    expect(out).toHaveLength(1)
    web.detach()
  })

  it('keeps one adapter socket\'s routes when another closes', () => {
    const id = machineId(), out: unknown[] = []
    const web = attachHubClient(socket(out), id, 'web')
    const first = createConnectionRoutes(id), second = createConnectionRoutes(id)
    first.hop(hop(web.connId, 1), web.connId)
    second.hop(hop(web.connId, 2), web.connId)
    first.close()
    first.hop(hop(web.connId, 3), web.connId)
    second.hop(hop(web.connId, 4), web.connId)
    expect(out.map(f => Buffer.from(f as Uint8Array)[35])).toEqual([1, 2, 4])
    web.detach()
  })
})

it('keeps at most MAX_ROUTES routes per adapter socket, forgetting the least recently used', () => {
  const id = machineId(), out: unknown[] = []
  const web = attachHubClient(socket(out), id, 'web')
  const routes = createConnectionRoutes(id)
  routes.hop(hop(web.connId, 1), web.connId)
  // Many connections that come and go (Desktop attaches a new one per agent switch), the live one used now and then.
  for (let i = 0; i < MAX_ROUTES * 2; i++) {
    const gone = `0f0e0d0c-0b0a-4908-8706-${String(i).padStart(12, '0')}`
    routes.hop(hop(gone, 2), gone)
    if (i % 500 === 0) routes.hop(hop(web.connId, 3), web.connId)
  }
  routes.hop(hop(web.connId, 4), web.connId)
  // The live connection kept its local route throughout: every one of its frames was delivered here.
  expect(out.map(f => Buffer.from(f as Uint8Array)[35])).toEqual([1, ...Array.from({ length: (MAX_ROUTES * 2) / 500 }, () => 3), 4])
  web.detach()
})

describe('pod routes on (Phase 2)', () => {
  let stop: () => void = () => {}
  beforeEach(async () => { stop(); stop = await startPodRoutes() })

  it('records a viewer on attach and forgets it on detach', async () => {
    const id = machineId()
    const web = attachHubClient(socket([]), id, 'web')
    expect(bus.recordConnOwners).toHaveBeenCalledWith([web.connId], registry.PROCESS_ID)
    web.detach()
    expect(bus.forgetConnOwner).toHaveBeenCalledWith(web.connId)
  })

  it('publishes on the machine\'s channels while the owner is looked up, then on the owner\'s alone, in send order', async () => {
    let answer: (owner: string | null) => void = () => {}
    bus.connOwner.mockImplementation(() => new Promise(resolve => { answer = resolve }))
    const id = machineId(), conn = remoteConn(), routes = createConnectionRoutes(id)
    const packets = Array.from({ length: 5 }, (_, i) => hop(conn, i))
    routes.hop(packets[0]!, conn); routes.targeted(json(conn, 1)); routes.hop(packets[1]!, conn)
    answer('other-process')
    await flush()
    routes.hop(packets[2]!, conn); routes.targeted(json(conn, 2)); routes.hop(packets[3]!, conn)
    expect(bus.connOwner).toHaveBeenCalledTimes(1)
    expect(bus.publishTerminalUp.mock.calls.map(c => c[1])).toEqual([packets[0], packets[1]])
    expect(bus.publishUp).toHaveBeenCalledWith(id, json(conn, 1))
    expect(bus.publishPodHop.mock.calls.map(c => [c[0], c[1], c[2]])).toEqual([['other-process', id, packets[2]], ['other-process', id, packets[3]]])
    expect(bus.publishPodJson).toHaveBeenCalledWith('other-process', id, json(conn, 2))
    // Every machine-channel publish was issued before any owner-channel publish: one Redis connection keeps that order.
    const lastMachine = Math.max(...bus.publishTerminalUp.mock.invocationCallOrder, ...bus.publishUp.mock.invocationCallOrder)
    const firstOwner = Math.min(...bus.publishPodHop.mock.invocationCallOrder, ...bus.publishPodJson.mock.invocationCallOrder)
    expect(lastMachine).toBeLessThan(firstOwner)
  })

  it('stays on the machine\'s channels for a connection with no owner, even once an owner appears', async () => {
    const id = machineId(), conn = remoteConn(), routes = createConnectionRoutes(id)
    routes.hop(hop(conn, 1), conn)
    await flush()
    bus.connOwner.mockImplementation(async () => 'other-process')
    routes.hop(hop(conn, 2), conn)
    await flush()
    expect(bus.publishTerminalUp).toHaveBeenCalledTimes(2)
    expect(bus.publishPodHop).not.toHaveBeenCalled()
  })

  it('keeps the machine\'s channels when the lookup fails, and when this process is the recorded owner', async () => {
    const id = machineId(), failed = remoteConn(), mine = '1f0e0d0c-0b0a-4908-8706-050403020100', routes = createConnectionRoutes(id)
    bus.connOwner.mockImplementation(async (connId: string) => { if (connId === failed) throw new Error('down'); return registry.PROCESS_ID })
    routes.hop(hop(failed, 1), failed); routes.hop(hop(mine, 1), mine)
    await flush()
    routes.hop(hop(failed, 2), failed); routes.hop(hop(mine, 2), mine)
    expect(bus.publishTerminalUp).toHaveBeenCalledTimes(4)
    expect(bus.publishPodHop).not.toHaveBeenCalled()
  })

  it('delivers nothing from the process channels to a connection of another machine', async () => {
    const handlers = (bus.subscribePod.mock.calls.at(-1) as unknown as [string, { hop(m: string, p: Uint8Array): void; json(m: string, msg: unknown): void }])[1]
    const machineA = machineId(), machineB = machineId(), out: unknown[] = []
    const viewer = attachHubClient(socket(out), machineB, 'web')
    handlers.hop(machineA, hop(viewer.connId, 1))
    handlers.json(machineA, json(viewer.connId, 2))
    expect(out).toHaveLength(0)
    handlers.hop(machineB, hop(viewer.connId, 3))
    handlers.json(machineB, json(viewer.connId, 4))
    expect(out).toHaveLength(2)
    viewer.detach()
  })

  it('does not look up, nor record, with the switch off', async () => {
    stop(); stop = () => {}
    bus.recordConnOwners.mockClear()
    const id = machineId(), conn = remoteConn()
    const web = attachHubClient(socket([]), id, 'web')
    createConnectionRoutes(id).hop(hop(conn, 1), conn)
    expect(bus.connOwner).not.toHaveBeenCalled()
    expect(bus.recordConnOwners).not.toHaveBeenCalled()
    web.detach()
  })
})
