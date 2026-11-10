import { describe, expect, it } from 'vitest'
import { storeOldLeads } from '../leads.test-support.js'
import * as store from '../parts/index.js'
import { groupView, readerView } from './views.js'
import { NOW, outsider, owner, peer, richSwarm } from './fixture.test-support.js'
import type { Actor, Conversation } from '../model.js'

const R = 9_000
const MINUTE = 60_000

/** The rich Swarm with a contributed machine, a private conversation for `peer`, and store-written fields. */
function scene() {
  const s = richSwarm()
  s.contribute('mac', 'swarm')
  const privateId = s.group('Peer and PM')
  s.edit(state => {
    const peerGeneration = state.people.find(p => p.id === peer.userId)!.generation
    Object.assign(state.conversations.find(c => c.id === privateId)!, { kind: 'agent-chat', audience: { people: [{ id: peer.userId, generation: peerGeneration }] } })
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
    const { head } = readerView(parts, peer, NOW, {}).parts
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
    const view = readerView(store.split(s.state, { tabId: 'tab', version: R, now: NOW }), owner, NOW, {}).parts
    expect(view.head.data.invitations.map(i => i.email)).toEqual(['new@example.com'])
    expect(view.head.data.projects!.map(p => p.name)).toEqual(['Pilot', 'Secret'])
    expect(keys(readerView(parts, peer, NOW, {}).parts.groups)).not.toContain(s.secretGroup)
  })

  it('keeps a person\'s 1:1 chat from every reader but its owner, the Lead and the Swarm owner included, and a closed Chat with PM from all', () => {
    const { s, parts, privateId } = scene()
    const groups = (actor: Actor, from = parts) => keys(readerView(from, actor, NOW, {}).parts.groups)
    expect(groups(peer)).toContain(privateId)
    for (const reader of [agentActor(s.lead), owner, outsider, agentActor(s.worker)]) expect(groups(reader)).not.toContain(privateId)
    s.edit(state => { delete state.conversations.find(c => c.id === privateId)!.kind })
    const closed = store.split(s.state, { tabId: 'tab', version: R, now: NOW })
    for (const reader of [peer, agentActor(s.lead), owner]) expect(groups(reader, closed)).not.toContain(privateId)
  })

  it('never names a private conversation to the Swarm owner through an invitation', () => {
    const { s, privateId } = scene()
    s.run({ type: 'invite.create', email: 'new@example.com', role: 'viewer', conversationId: 'lead' })
    s.edit(state => { state.invitations[0]!.conversationId = privateId })
    const view = readerView(store.split(s.state, { tabId: 'tab', version: R, now: NOW }), owner, NOW, {}).parts
    expect(view.head.data.invitations).toEqual([])
  })

  it('sends groups with their message counter and none of the store-only fields', () => {
    const { s, parts } = scene()
    const web = readerView(parts, peer, NOW, {}).parts.groups.find(g => g.key === s.web)!
    expect(web).toMatchObject({ version: R, changedAt: NOW, data: { id: s.web, messageSeq: R, number: 1 } })
    for (const hidden of ['reportSeq', 'lastActivityAt', 'dormant', 'audience']) expect(web.data).not.toHaveProperty(hidden)
  })

  it('tells readers when a group shipped, and nothing else of its ledger', () => {
    const { s } = scene()
    const shipped = (ledger?: Record<string, unknown>) => {
      s.edit(state => { const group = state.conversations.find(c => c.id === s.web)!; if (ledger) group.ledger = ledger as never; else delete group.ledger })
      const parts = store.split(s.state, { tabId: 'tab', version: R, now: NOW })
      return readerView(parts, peer, NOW, {}).parts.groups.find(g => g.key === s.web)!.data
    }
    expect(shipped({ shippedAt: NOW - 50 })).toMatchObject({ shippedAt: NOW - 50 })
    expect(shipped({})).not.toHaveProperty('shippedAt')
    expect(shipped()).not.toHaveProperty('shippedAt')
    expect(shipped({ shippedAt: NOW - 50 })).not.toHaveProperty('ledger')
  })

  it('shows an older Swarm\'s stored Leads conversation to nobody, its id neither (model.ts leadsRemoved)', () => {
    const s = richSwarm()
    s.edit(state => { storeOldLeads(state, [s.lead]) })
    const parts = store.split(s.state, { tabId: 'tab', version: R, now: NOW })
    for (const actor of [owner, peer, agentActor(s.lead), agentActor(s.worker)]) {
      const view = readerView(parts, actor, NOW, {})
      expect(keys(view.parts.groups)).not.toContain('old-leads')
      expect(view.parts.head.data).not.toHaveProperty('leadsConversationId')
    }
  })

  it('keeps time-based agent values out of the part and puts them in derived', () => {
    const { s, parts } = scene()
    const view = readerView(parts, peer, NOW, {})
    const worker = view.parts.agents.find(a => a.key === s.worker)!
    for (const hidden of ['downNamed', 'downSince', 'limitedUntil', 'roleId']) expect(worker.data).not.toHaveProperty(hidden)
    expect(view.derived.agents[s.worker]).toEqual({ downSince: new Date(NOW - 5 * MINUTE).toISOString(), limitedUntil: null, workDecision: null, roleId: null, roleName: 'Engineer', kind: 'regular', chatId: null, myAgent: false, role: 'member', mainProjectId: null })
    expect(Object.keys(view.derived.agents).sort()).toEqual([s.lead, s.worker].sort())
  })

  // Task #4116 (Swarm v3): the left pane's "My agents" reads each agent's kind and its chat from the derived summary.
  it('says each agent\'s kind and the chat its person talks to it in', () => {
    const { parts, s } = scene()
    const view = readerView(parts, owner, NOW, {})
    // Swarm v4: a PM is talked to in a chat of its own, not the project's channel.
    expect(view.derived.agents[s.lead]).toMatchObject({ kind: 'pm' })
    expect(view.derived.agents[s.lead]!.chatId).not.toBe('lead')
    expect(view.derived.agents[s.worker]).toMatchObject({ kind: 'regular', chatId: null })
  })

  // Task #4192: whether each agent is in this reader's My agents comes from the server, so every client lists the same.
  it('says which agents are in the reader\'s My agents', () => {
    const { parts, s } = scene()
    const contributor = s.state.agents.find(a => a.id === s.lead)!.contributorId
    for (const actor of [owner, peer]) {
      const view = readerView(parts, actor, NOW, {})
      expect(view.derived.agents[s.lead]!.myAgent).toBe(actor.userId === contributor)
    }
  })

  // Free slots are what its free memory takes, whatever count its owner saved before (capacity settings went, 2026-11-10).
  it('derives a machine\'s free slots from its free memory, and cuts its harness ids to what the reader can see', () => {
    const { s } = scene()
    s.edit(state => { state.machines![0]!.observation!.resources = { memoryTotalBytes: 16 * 1024 ** 3, memoryUsedBytes: 13 * 1024 ** 3 } as never })
    const parts = store.split(s.state, { tabId: 'tab', version: R, now: NOW })
    const view = readerView(parts, peer, NOW, {})
    expect(view.parts.machines.map(m => m.key)).toEqual(['mac'])
    expect(view.parts.machines[0]!.data.observation!.runningHarnessIds).toEqual(['lead-harness'])
    expect(view.derived.machines).toEqual({ mac: { availableSlots: 1 } })
  })

  // Swarm v4 runs an agent on its own person's computer: no machine says whether it takes a teammate's work, and none says where
  // New Project's Product Manager would run on a teammate's machine.
  it('derives no team work and no Product Manager host for any reader', () => {
    const { parts, s } = scene()
    for (const actor of [owner, peer, agentActor(s.worker)]) {
      const machine = readerView(parts, actor, NOW, {}).derived.machines.mac!
      expect(machine).not.toHaveProperty('teamWork')
      expect(machine).not.toHaveProperty('lead')
    }
  })

  // The route leaves a suspended engine out and Desktop strikes it through (engineHealth.ts); 6 hours on it no longer shows.
  it('derives the engines suspended on a machine now, with why, and none once the suspension has run out', () => {
    const s = richSwarm()
    s.contribute('mac', 'swarm')
    s.edit(state => { state.machines![0]!.engineSuspensions = { codex: { at: NOW - MINUTE, fine: true }, claude: { at: NOW - 7 * 60 * MINUTE, fine: false } } })
    const view = readerView(store.split(s.state, { tabId: 'tab', version: R, now: NOW }), peer, NOW, {})
    expect(view.derived.machines.mac!.suspendedEngines).toEqual({ codex: expect.stringContaining('Codex is suspended on this machine for new work') })
  })

  it('exposes a machine cooldown to new and older routing clients, then drops it at expiry', () => {
    const s = richSwarm()
    s.contribute('mac', 'swarm')
    s.edit(state => { Object.assign(state.machines![0]!, { machineSuspension: { at: NOW, durationMs: 30 * MINUTE } }) })
    const parts = store.split(s.state, { tabId: 'tab', version: R, now: NOW })
    const current = readerView(parts, peer, NOW, {}).derived.machines.mac!
    expect(current).toMatchObject({ machineSuspended: expect.stringContaining('This machine is suspended'),
      suspendedEngines: { codex: expect.stringContaining('This machine is suspended') } })
    const expired = readerView(parts, peer, NOW + 30 * MINUTE, {}).derived.machines.mac!
    expect(expired).not.toHaveProperty('machineSuspended')
    expect(expired).not.toHaveProperty('suspendedEngines')
  })

  it('gives a Lead the other projects\' work, and nobody a tag count since Swarm v4', () => {
    const { s, parts } = scene()
    expect(readerView(parts, agentActor(s.lead), NOW, {}).derived).toHaveProperty('otherProjectsWork', [])
    for (const reader of [agentActor(s.lead), peer]) expect(readerView(parts, reader, NOW, {}).derived).not.toHaveProperty('mentionsWaiting')
    expect(readerView(parts, peer, NOW, {}).derived).not.toHaveProperty('otherProjectsWork')
  })

  it('refuses a reader who is not a member', () => {
    const { parts } = scene()
    expect(() => readerView(parts, { kind: 'person', userId: 'nobody', email: 'x@example.com' }, NOW, {})).toThrow(/no longer have access/)
  })
})

describe('reader view over what the read cache holds', () => {
  const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value) }
    return value
  }

  it('builds from the state it is given, over frozen parts, as it would from the parts alone', () => {
    const { parts } = scene()
    const expected = readerView(structuredClone(parts), peer, NOW, {})
    const frozen = deepFreeze(structuredClone(parts))
    const state = store.reassemble(frozen, { share: true })
    for (const actor of [peer, owner, outsider, agentActor(richSwarm().lead)]) {
      const view = readerView(frozen, actor, NOW, {}, state)
      expect(view.state).toBe(state)
      if (actor === peer) expect({ parts: view.parts, derived: view.derived }).toEqual({ parts: expected.parts, derived: expected.derived })
    }
  })
})

describe('role names in the reader\'s view', () => {
  it('gives every agent a role name, the PM\'s by what it is', () => {
    const s = richSwarm()
    s.edit(state => { state.agents.find(a => a.id === s.worker)!.roleName = 'Tester' })
    const view = readerView(store.split(s.state, { tabId: 'tab', version: R, now: NOW }), owner, NOW, {})
    expect(view.derived.agents[s.lead]!.roleName).toBe('PM')
    expect(view.derived.agents[s.worker]!.roleName).toBe('Tester')
  })
})

// Swarm v4 hands out no tasks (2026-11-10): a task's lane is not worked out.
describe('a task\'s lane', () => {
  it('is not worked out from its owned paths', () => {
    const task = { id: 't', title: 'Server', projectId: 'lead', leadId: null, agentIds: [], archived: false, checks: [], assignment: null,
      lastMessageSequence: 0, task: { goal: 'g', changes: 'c', constraints: 'n', owns: ['backend/src/x.ts'] } } as unknown as Conversation
    expect(groupView(task, new Set())).not.toHaveProperty('handOutLane')
  })
})
