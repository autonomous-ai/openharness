// Real framed cable -> host -> window visit composition. Serial hardware,
// registry/fleet advertisements and the Desktop window boundary are substitutes;
// no user terminal, network, native UI or model is exercised here.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { CableDecoder, CableType, encodeCableFrame } from './cableFrame.js'
import { DaemonCableHost, type CableHostWiring } from './cableHost.js'
import { CableSession, type CableAgent, type CablePort } from './cableSession.js'
import { DialLog } from './dialLog.js'
import type { FleetMachine, MachineFleet } from './machineFleet.js'
import type { SelectionFocus } from './windowSelection.js'
import { WindowVisit, type VisitCommand } from './windowVisit.js'

type AdvertisedFixture = Pick<RegisteredSession, 'agentId' | 'sessionId' | 'engine' | 'active' | 'registeredAt'>
const data = vi.hoisted(() => ({ rows: [] as AdvertisedFixture[] }))
vi.mock('../lib/registry.js', () => ({
  registry: {
    advertised: () => [...data.rows], list: () => [...data.rows],
    active: () => data.rows.filter(row => row.active),
  },
  projectDisplayName: (row: AdvertisedFixture) => row.agentId,
}))

class Peer implements CablePort {
  readonly path = '/dev/owner-fixture'
  isOpen = true
  readonly sent: Record<string, unknown>[] = []
  private readonly decoder = new CableDecoder()
  constructor(private readonly incoming: (bytes: Buffer) => void,
              private readonly closed: (reason: string) => void) {}
  async write(bytes: Uint8Array): Promise<void> {
    this.decoder.feed(Buffer.from(bytes), frame => {
      if (frame.type === CableType.Json) this.sent.push(JSON.parse(Buffer.from(frame.payload).toString('utf8')))
    })
  }
  say(message: Record<string, unknown>): void {
    this.incoming(Buffer.from(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(message)))))
  }
  async close(reason = 'fixture closed'): Promise<void> {
    if (!this.isOpen) return
    this.isOpen = false
    this.closed(reason)
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  data.rows = []
  vi.restoreAllMocks()
})

async function fixture() {
  const origin = 'original-work', target = 'shared-public-id', visitId = 'saved-card-visit'
  data.rows = [{ agentId: origin, sessionId: 'original-session', engine: 'claude',
    active: true, registeredAt: 1 }]
  const machines: FleetMachine[] = [{ machineId: 'remote-a', name: 'First computer', state: 'ready', authMode: 'remote' }]
  const advertised: Record<string, CableAgent[]> = {
    'remote-a': [{ id: target, name: 'Saved alert', engine: 'claude' }],
    'remote-b': [{ id: target, name: 'Different work', engine: 'claude' }],
  }
  const fleet: MachineFleet = {
    list: async () => ({ machines: [...machines], source: 'backend' }),
    listAgents: vi.fn(async (id: string) => advertised[id] ?? []),
    online: async () => {}, select: async () => {}, release: vi.fn(),
    sendTurn: vi.fn(), stopTurn: vi.fn(), answer: vi.fn(), updateAgent: vi.fn(),
    listModels: async () => [], recentSummaries: async () => [], recentAsks: async () => [],
    onEvent: () => () => {},
  }
  let focus: SelectionFocus = { connId: 'original-window', machineId: 'local', agentId: origin }
  const navigation: Array<{ connId: string; payload: Record<string, unknown> }> = []
  const visit = new WindowVisit({ focus: () => focus, timeoutMs: 1000,
    send: (connId, payload) => { navigation.push({ connId, payload }); return true } })
  const wiring: CableHostWiring = {
    machineId: () => 'local', computerId: () => 'fixture', machineName: () => 'This computer',
    signedIn: () => false,
    sendTurn: vi.fn(), stopTurn: vi.fn(), answer: vi.fn(), opened: vi.fn(), focused: vi.fn(),
    recent: () => [], recentAsks: () => [], log: vi.fn(),
    visit: command => visit.command(command), rejectVisit: (id, error) => visit.refuse(id, error),
    clearVisit: () => visit.cancel(),
  }
  const host = new DaemonCableHost(wiring, fleet)
  host.setDesk([origin, target])
  host.setSwarms({ active: 'workspace', swarms: [{ id: 'workspace', name: 'Work', agentIds: [origin, target], panes: 2 }], tiles: [] })
  await vi.waitFor(async () => {
    expect((await host.listAgentsFlat()).find(row => row.id === target)?.machineId).toBe('remote-a')
  })
  const directory = await mkdtemp(join(tmpdir(), 'agent-owner-cable-'))
  let peer!: Peer
  const session = new CableSession(host, new DialLog(directory), async (incoming, closed) => peer = new Peer(incoming, closed))
  cleanups.push(async () => { await session.stop(); visit.cancel(); await rm(directory, { recursive: true, force: true }) })
  session.start()
  await vi.waitFor(() => expect(peer).toBeDefined())
  peer.say({ t: 'hello', product: 'harness', hw: 'harness-pro', fw: 'owner-fixture', proto: 3, mac: '28:84:85:90:5F:78' })
  await vi.waitFor(() => expect(peer.sent.some(frame => frame.t === 'agents.end')).toBe(true))
  let serial = 0
  function request(op: VisitCommand['op'], agentId: string | undefined = target, id = visitId): string {
    const requestId = `visit-${++serial}`
    peer.say({ t: 'visit', op, visitId: id, requestId, ...(agentId ? { agentId } : {}) })
    return requestId
  }
  async function result(requestId: string) {
    await vi.waitFor(() => expect(peer.sent.some(frame => frame.t === 'visit.state' && frame.requestId === requestId)).toBe(true))
    return peer.sent.find(frame => frame.t === 'visit.state' && frame.requestId === requestId)!
  }
  function acknowledge() {
    const { connId, payload } = navigation.at(-1)!
    const returning = payload.op === 'back'
    visit.reply(connId, 'local', { requestId: payload.requestId, visitId: payload.visitId,
      ok: true, active: !returning, agentId: returning ? origin : payload.agentId, label: 'Original work' })
    focus = returning ? { connId: 'original-window', machineId: 'local', agentId: origin }
      : { connId: 'remote-window', machineId: payload.machineId as string, agentId: payload.agentId as string }
  }
  async function open() {
    const requestId = request('open')
    await vi.waitFor(() => expect(navigation).toHaveLength(1))
    expect(navigation[0]).toMatchObject({ connId: 'original-window', payload: {
      op: 'open', fromMachineId: 'local', fromAgentId: origin, machineId: 'remote-a', agentId: target,
    } })
    acknowledge()
    expect(await result(requestId)).toMatchObject({ ok: true, active: true, agentId: target, label: 'Original work' })
  }
  return { host, peer, wiring, fleet, machines, navigation, target, origin, visitId, request, result, acknowledge, open }
}

describe('saved card machine ownership through the production cable composition', () => {
  it.each(['event', 'unread'] as const)('keeps an acknowledged Return while refusing an owner conflict from %s', async source => {
    const f = await fixture()
    await f.open()
    if (source === 'event') f.host.noteAgent('remote-b', f.target)
    else f.host.setUnread([{ agentId: f.target, machineId: 'remote-b', question: false,
      text: 'A different computer reused this public ID.', readToken: 'other-occurrence' }])
    expect(f.host.isAgentAmbiguous(f.target)).toBe(true)
    const navigationBefore = [...f.navigation]
    for (const op of ['open', 'latest'] as const) {
      const state = await f.result(f.request(op))
      expect(state).toMatchObject({ ok: false, active: true, label: 'Original work', visitId: f.visitId })
      expect(state.error).toBeTypeOf('string')
      expect(state).not.toHaveProperty('agentId')
    }
    const wrongVisit = await f.result(f.request('open', f.target, 'unrelated-visit'))
    expect(wrongVisit).toMatchObject({ ok: false, active: false })
    expect(wrongVisit).not.toHaveProperty('label')
    expect(f.navigation).toEqual(navigationBefore)

    // Dropping the first owner is not evidence that its saved card belongs to B.
    f.machines.splice(0, f.machines.length, { machineId: 'remote-b', name: 'Second computer', state: 'ready', authMode: 'remote' })
    f.host.setDesk([f.origin])
    f.host.setSwarms({ active: 'workspace', swarms: [{ id: 'workspace', name: 'Work', agentIds: [f.origin], panes: 1 }], tiles: [] })
    await f.host.listAgentsFlat()
    const remaining = await f.host.listAgentsFlat()
    expect(remaining.some(row => row.machineId === 'remote-a')).toBe(false)
    expect(f.fleet.listAgents).toHaveBeenCalledWith('remote-b')
    f.host.setUnread([])
    expect(f.host.isAgentAmbiguous(f.target)).toBe(true)
    f.peer.say({ t: 'turn.send', agentId: f.target, text: 'Must not reach either computer.' })
    f.peer.say({ t: 'focus', agentId: f.target })
    f.peer.say({ t: 'agent.open', agentId: f.target })
    expect(await f.result(f.request('open'))).toMatchObject({ ok: false, active: true, label: 'Original work' })
    expect(f.navigation).toEqual(navigationBefore)
    expect(f.wiring.sendTurn).not.toHaveBeenCalled()
    expect(f.fleet.sendTurn).not.toHaveBeenCalled()
    expect(f.wiring.focused).not.toHaveBeenCalled()
    expect(f.wiring.opened).not.toHaveBeenCalled()

    // Even an obsolete target field cannot route Back through the other machine.
    const back = f.request('back', f.target)
    await vi.waitFor(() => expect(f.navigation).toHaveLength(navigationBefore.length + 1))
    const frame = f.navigation.at(-1)!
    expect(frame).toMatchObject({ connId: 'original-window', payload: { op: 'back', visitId: f.visitId } })
    expect(frame.payload).not.toHaveProperty('machineId')
    expect(frame.payload).not.toHaveProperty('agentId')
    f.acknowledge()
    expect(await f.result(back)).toMatchObject({ ok: true, active: false, agentId: f.origin })
    expect(await f.result(f.request('open'))).toMatchObject({ ok: false, active: false })
  })

  it('refuses a conflicting first Open without inventing a Return', async () => {
    const f = await fixture()
    f.host.noteAgent('remote-b', f.target)
    expect(await f.result(f.request('open'))).toMatchObject({ ok: false, active: false })
    expect(f.navigation).toEqual([])
    expect(f.wiring.sendTurn).not.toHaveBeenCalled()
    expect(f.fleet.sendTurn).not.toHaveBeenCalled()
  })
})
