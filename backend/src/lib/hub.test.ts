import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'

const bus = vi.hoisted(() => ({
  setAgentClientCount: vi.fn(async () => undefined),
  setAgentClientCountsBatch: vi.fn(async () => undefined),
  getAgentClientState: vi.fn(async () => ({ totals: { ui: 0, commander: 0, commanderActive: 0 }, commanderJoinGeneration: undefined })),
  bumpCommanderJoinGeneration: vi.fn(async () => 1),
  publishDown: vi.fn(async () => 1),
  publishUp: vi.fn(async () => 1),
  publishTerminalDown: vi.fn(async () => 1),
  subscribeUp: vi.fn(async () => () => undefined),
  subscribeTerminalUp: vi.fn(async () => () => undefined),
}))
vi.mock('./bus.js', () => bus)
vi.mock('./providerLink.js', () => ({ routeDown: async (_m: string, _d: unknown, fallback: () => Promise<number>) => fallback() }))
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const { attachHubClient, deliverUpLocal, recomputeAndSendClients, sendClientsControl } = await import('./hub.js')
const registry = await import('./registry.js')
const { env } = await import('../config/env.js')
const { SEND_HIGH_WATER, SEND_KILL_WATER } = await import('./wsSend.js')

function socket(out: unknown[], bufferedAmount = 0): WebSocket {
  return {
    readyState: 1,
    bufferedAmount,
    send: (data: unknown) => { out.push(data) },
    close: vi.fn(),
    terminate: vi.fn(),
    on: () => undefined,
  } as unknown as WebSocket
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(() => setImmediate(r)))

describe('hub fan-out backpressure', () => {
  const attached: Array<ReturnType<typeof attachHubClient>> = []
  beforeEach(async () => {
    while (attached.length) attached.pop()!.detach()
    await flush()
    bus.setAgentClientCount.mockClear()
    bus.bumpCommanderJoinGeneration.mockClear()
  })

  it('delivers terminal_output losslessly even when the outbound buffer is backed up (must, not droppable)', () => {
    const machineId = `hub-bp-${Date.now()}`
    const sent: string[] = []
    // High-water but below kill-water: nothing may be silently dropped (a dropped terminal frame is an
    // undetectable gap that stalls the pane), so both frames must still be sent.
    const client = attachHubClient(socket(sent, SEND_HIGH_WATER + 1), machineId, 'web')
    attached.push(client)

    deliverUpLocal(machineId, { webEligible: true, commanderEligible: false, frame: { type: 'terminal_output', payload: {} } })
    deliverUpLocal(machineId, { webEligible: true, commanderEligible: false, frame: { type: 'text_delta', payload: { content: 'x' } } })
    expect(sent).toHaveLength(2)
    expect(sent[0]).toContain('terminal_output')
    expect(sent[1]).toContain('text_delta')
  })

  it('closes a web client whose buffer is past the kill line instead of buffering unbounded', () => {
    const machineId = `hub-kill-${Date.now()}`
    const sent: string[] = []
    const ws = socket(sent, SEND_KILL_WATER + 1) as unknown as { close: ReturnType<typeof vi.fn>; readyState: number }
    const client = attachHubClient(ws as never, machineId, 'web')
    attached.push(client)
    deliverUpLocal(machineId, { webEligible: true, commanderEligible: false, frame: { type: 'terminal_output', payload: {} } })
    expect(sent).toHaveLength(0)
    expect(ws.close).toHaveBeenCalledWith(1013, 'slow consumer')
  })
})

describe('a guest on a shared machine', () => {
  // A guest hears only what the machine addresses to it, never the owner's broadcasts
  // (docs/plans/2026-10-19-guest-machine-sharing-plan.md).
  it('is sent no broadcast, only the frames addressed to its own connection', () => {
    const machineId = `hub-guest-${Date.now()}`
    const ownerOut: string[] = []
    const guestOut: string[] = []
    const owner = attachHubClient(socket(ownerOut), machineId, 'web')
    const guest = attachHubClient(socket(guestOut), machineId, 'web', { guest: true })
    deliverUpLocal(machineId, { webEligible: true, commanderEligible: false, frame: { type: 'agent_synced', payload: { agent: { id: 'owners' } } } })
    deliverUpLocal(machineId, { webEligible: true, commanderEligible: false, targetConnId: guest.connId, frame: { type: 'agent_synced', payload: { sealed: true } } })
    expect(ownerOut).toHaveLength(1)
    expect(guestOut).toHaveLength(1)
    expect(guestOut[0]).toContain('sealed')
    owner.detach(); guest.detach()
  })
})

describe('sendClientsControl coalescing', () => {
  beforeEach(async () => {
    await flush() // let any attach/detach flush from the previous describe land first
    bus.setAgentClientCount.mockClear()
    bus.bumpCommanderJoinGeneration.mockClear()
  })

  it('collapses a burst of calls for one machine into a single count write, OR-ing commanderJoined', async () => {
    const machineId = `hub-coalesce-${Date.now()}`
    sendClientsControl(machineId, false)
    sendClientsControl(machineId, true)
    sendClientsControl(machineId, false)
    expect(bus.setAgentClientCount).not.toHaveBeenCalled()
    await flush()
    expect(bus.setAgentClientCount).toHaveBeenCalledTimes(1)
    expect(bus.bumpCommanderJoinGeneration).toHaveBeenCalledTimes(1)
  })

  it('keeps distinct machines separate', async () => {
    const a = `hub-a-${Date.now()}`
    const b = `hub-b-${Date.now()}`
    sendClientsControl(a)
    sendClientsControl(b)
    await flush()
    expect(bus.setAgentClientCount).toHaveBeenCalledTimes(2)
  })
})

describe('the __clients frame', () => {
  // A daemon holds a machine's live events while no UI client views it only when the backend says it may
  // (`uiGate`); RELAY_UI_GATE=off withdraws that without a daemon release (spec 2026-11-02-swarm-cache-delta-design, Part 4).
  it('__clients carries uiGate, and none with RELAY_UI_GATE=off', async () => {
    const machineId = `hub-uigate-${Date.now()}`
    const sent: string[] = []
    const control = socket(sent)
    registry.bindControlSocket(machineId, control)
    const saved = env.RELAY_UI_GATE
    try {
      await recomputeAndSendClients(machineId)
      env.RELAY_UI_GATE = 'off'
      await recomputeAndSendClients(machineId)
    } finally {
      env.RELAY_UI_GATE = saved
      registry.unbindControlSocket(machineId, control)
    }
    const payloads = sent.map((s) => JSON.parse(s).frame.payload)
    expect(payloads[0]).toEqual({ ui: 0, commander: 0, commanderActive: 0, uiGate: true })
    expect(payloads[1]).toEqual({ ui: 0, commander: 0, commanderActive: 0 })
  })

  it('a count it could not read never offers the gate: a Redis blip must not tell the daemon nobody is viewing', async () => {
    const machineId = `hub-uigate-failed-${Date.now()}`
    const sent: string[] = []
    const control = socket(sent)
    registry.bindControlSocket(machineId, control)
    vi.mocked(bus.getAgentClientState).mockResolvedValueOnce({ totals: { ui: 0, commander: 0, commanderActive: 0 }, commanderJoinGeneration: undefined, failed: true } as never)
    try {
      await recomputeAndSendClients(machineId)
    } finally {
      registry.unbindControlSocket(machineId, control)
    }
    expect(JSON.parse(sent[0]!).frame.payload).toEqual({ ui: 0, commander: 0, commanderActive: 0 })
  })
})
