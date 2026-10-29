import { describe, expect, it } from 'vitest'
import * as store from '../parts/index.js'
import { readerView } from './views.js'
import { NOW, outsider, owner, peer, richSwarm } from './fixture.test-support.js'
import type { Actor } from '../model.js'

const R = 9_000
const MINUTE = 60_000

/** The rich Swarm with a contributed machine, a private conversation for `peer`, and store-written fields. */
function scene() {
  const s = richSwarm()
  s.contribute('mac', 'swarm')
  const privateId = s.group('Peer and PM')
  s.edit(state => {
    const peerGeneration = state.people.find(p => p.id === peer.userId)!.generation
    Object.assign(state.conversations.find(c => c.id === privateId)!, { kind: 'buddy', audience: { people: [{ id: peer.userId, generation: peerGeneration }] } })
    const worker = state.agents.find(a => a.id === s.worker)!
    worker.downNamed = 'named'
    worker.limitedUntil = new Date(NOW - MINUTE).toISOString()
    worker.downSince = new Date(NOW - 5 * MINUTE).toISOString()
    state.sharing = { revision: 1 } as never
    state.overlapAlerts = ['a:b']
    state.machines![0]!.observation = { generation: 'g', receivedAt: NOW, resources: {} as never, tools: {}, quotas: [],
      runningHarnessIds: ['lead-harness', 'stranger'], stoppedHarnessIds: [] }
  })
  const parts = store.split(s.state, { tabId: 'tab', version: R, now: NOW })
  return { s, parts, privateId }
}
const agentActor = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: `${owner.userId}-machine` })
const keys = (list: Array<{ key: string }>) => list.map(p => p.key)

describe('reader view of the parts (design 4.1, 4.3)', () => {
  it('sends the head without owner-only and internal fields, and projects without their progress', () => {
    const { parts } = scene()
    const { head } = readerView(parts, peer, NOW, { teamMachines: [] }).parts
    expect(head).toMatchObject({ key: 'head', version: R, changedAt: NOW })
    for (const hidden of ['sharing', 'overlapAlerts', 'retiredConversationNumber', 'parkedConversations', 'groupCounter', 'sequenceBase']) {
      expect(head.data).not.toHaveProperty(hidden)
    }
    expect(head.data.projects!.map(p => p.name)).toEqual(['Pilot'])
    expect(head.data.projects!.every(p => !('progress' in p))).toBe(true)
    expect(head.data.invitations).toEqual([])
  })

  it('shows invitations and the private project only to those who may read them', () => {
    const { s, parts } = scene()
    s.run({ type: 'invite.create', email: 'new@example.com', role: 'viewer', conversationId: 'lead' })
    const view = readerView(store.split(s.state, { tabId: 'tab', version: R, now: NOW }), owner, NOW, { teamMachines: [] }).parts
    expect(view.head.data.invitations.map(i => i.email)).toEqual(['new@example.com'])
    expect(view.head.data.projects!.map(p => p.name)).toEqual(['Pilot', 'Secret'])
    expect(keys(readerView(parts, peer, NOW, { teamMachines: [] }).parts.groups)).not.toContain(s.secretGroup)
  })

  it('keeps a Buddy chat from every reader but its owner, the Lead and the Swarm owner included, and a closed Chat with PM from all', () => {
    const { s, parts, privateId } = scene()
    const groups = (actor: Actor, from = parts) => keys(readerView(from, actor, NOW, { teamMachines: [] }).parts.groups)
    expect(groups(peer)).toContain(privateId)
    for (const reader of [agentActor(s.lead), owner, outsider, agentActor(s.worker)]) expect(groups(reader)).not.toContain(privateId)
    expect(readerView(parts, peer, NOW, { teamMachines: [] }).parts.groups.find(g => g.key === privateId)!.data).toMatchObject({ buddyOwnerId: peer.userId })
    s.edit(state => { delete state.conversations.find(c => c.id === privateId)!.kind })
    const closed = store.split(s.state, { tabId: 'tab', version: R, now: NOW })
    for (const reader of [peer, agentActor(s.lead), owner]) expect(groups(reader, closed)).not.toContain(privateId)
  })

  it('never names a private conversation to the Swarm owner through an invitation', () => {
    const { s, privateId } = scene()
    s.run({ type: 'invite.create', email: 'new@example.com', role: 'viewer', conversationId: 'lead' })
    s.edit(state => { state.invitations[0]!.conversationId = privateId })
    const view = readerView(store.split(s.state, { tabId: 'tab', version: R, now: NOW }), owner, NOW, { teamMachines: [] }).parts
    expect(view.head.data.invitations).toEqual([])
  })

  it('sends groups with their message counter and none of the store-only fields', () => {
    const { s, parts } = scene()
    const web = readerView(parts, peer, NOW, { teamMachines: [] }).parts.groups.find(g => g.key === s.web)!
    expect(web).toMatchObject({ version: R, changedAt: NOW, data: { id: s.web, messageSeq: R, number: 1 } })
    for (const hidden of ['reportSeq', 'lastActivityAt', 'dormant', 'audience']) expect(web.data).not.toHaveProperty(hidden)
  })

  it('shows the Leads conversation to people and Leads, not to another agent', () => {
    const { s, parts } = scene()
    const leads = s.state.leadsConversationId!
    expect(keys(readerView(parts, peer, NOW, { teamMachines: [] }).parts.groups)).toContain(leads)
    expect(keys(readerView(parts, agentActor(s.lead), NOW, { teamMachines: [] }).parts.groups)).toContain(leads)
    expect(keys(readerView(parts, agentActor(s.worker), NOW, { teamMachines: [] }).parts.groups)).not.toContain(leads)
  })

  it('keeps time-based agent values out of the part and puts them in derived', () => {
    const { s, parts } = scene()
    const view = readerView(parts, peer, NOW, { teamMachines: [] })
    const worker = view.parts.agents.find(a => a.key === s.worker)!
    for (const hidden of ['downNamed', 'downSince', 'limitedUntil', 'roleId']) expect(worker.data).not.toHaveProperty(hidden)
    expect(view.derived.agents[s.worker]).toEqual({ downSince: new Date(NOW - 5 * MINUTE).toISOString(), limitedUntil: null, workDecision: null, roleId: null })
    expect(Object.keys(view.derived.agents).sort()).toEqual([s.lead, s.worker].sort())
  })

  // Free slots count every session the machine runs, as today, even ones this reader cannot see.
  it('derives a machine\'s free slots and team work, and cuts its harness ids to what the reader can see', () => {
    const { parts } = scene()
    const view = readerView(parts, peer, NOW, { teamMachines: [] })
    expect(view.parts.machines.map(m => m.key)).toEqual(['mac'])
    expect(view.parts.machines[0]!.data.observation!.runningHarnessIds).toEqual(['lead-harness'])
    expect(view.derived.machines).toEqual({ mac: { availableSlots: 1, teamWork: { allowed: true } } })
  })

  it('gives a Lead the other projects\' work and a person the mentions waiting', () => {
    const { s, parts } = scene()
    expect(readerView(parts, agentActor(s.lead), NOW, { teamMachines: [] }).derived).toHaveProperty('otherProjectsWork', [])
    expect(readerView(parts, agentActor(s.lead), NOW, { teamMachines: [] }).derived).not.toHaveProperty('mentionsWaiting')
    expect(readerView(parts, peer, NOW, { teamMachines: [], mentionsWaiting: 2, mentionsDigest: 'd' }).derived).toMatchObject({ mentionsWaiting: 2, mentionsDigest: 'd' })
    expect(readerView(parts, agentActor(s.lead), NOW, { teamMachines: [], mentionsWaiting: 2, mentionsDigest: 'd' }).derived).not.toHaveProperty('mentionsDigest')
    expect(readerView(parts, peer, NOW, { teamMachines: [] }).derived).not.toHaveProperty('otherProjectsWork')
  })

  it('refuses a reader who is not a member', () => {
    const { parts } = scene()
    expect(() => readerView(parts, { kind: 'person', userId: 'nobody', email: 'x@example.com' }, NOW, { teamMachines: [] })).toThrow(/no longer have access/)
  })
})

describe('reader view over what the read cache holds', () => {
  const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value) }
    return value
  }

  it('builds from the state it is given, over frozen parts, as it would from the parts alone', () => {
    const { parts } = scene()
    const expected = readerView(structuredClone(parts), peer, NOW, { teamMachines: [] })
    const frozen = deepFreeze(structuredClone(parts))
    const state = store.reassemble(frozen, { share: true })
    for (const actor of [peer, owner, outsider, agentActor(richSwarm().lead)]) {
      const view = readerView(frozen, actor, NOW, { teamMachines: [] }, state)
      expect(view.state).toBe(state)
      if (actor === peer) expect({ parts: view.parts, derived: view.derived }).toEqual({ parts: expected.parts, derived: expected.derived })
    }
  })
})
