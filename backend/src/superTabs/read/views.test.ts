import { describe, expect, it } from 'vitest'
import { parts as store } from './partsPort.js'
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
    state.conversations.find(c => c.id === privateId)!.audience = { people: [{ id: peer.userId, generation: peerGeneration }] }
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
const agentActor = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'owner-machine' })
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

  it('keeps a private conversation from every reader outside its audience, the Swarm owner included', () => {
    const { s, parts, privateId } = scene()
    const groups = (actor: Actor) => keys(readerView(parts, actor, NOW, { teamMachines: [] }).parts.groups)
    expect(groups(peer)).toContain(privateId)
    expect(groups(agentActor(s.lead))).toContain(privateId)
    expect(groups(owner)).not.toContain(privateId)
    expect(groups(outsider)).not.toContain(privateId)
    expect(groups(agentActor(s.worker))).not.toContain(privateId)
    expect(readerView(parts, peer, NOW, { teamMachines: [] }).parts.groups.find(g => g.key === privateId)!.data.audience).toBeDefined()
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
    expect(readerView(parts, peer, NOW, { teamMachines: [], mentionsWaiting: 2 }).derived).toMatchObject({ mentionsWaiting: 2 })
    expect(readerView(parts, peer, NOW, { teamMachines: [] }).derived).not.toHaveProperty('otherProjectsWork')
  })

  it('refuses a reader who is not a member', () => {
    const { parts } = scene()
    expect(() => readerView(parts, { kind: 'person', userId: 'nobody', email: 'x@example.com' }, NOW, { teamMachines: [] })).toThrow(/no longer have access/)
  })
})
