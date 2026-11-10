import { describe, expect, it } from 'vitest'
import { createSuperTab, type Actor, type Agent, type Person } from './model.js'
import { agentChatId, agentKind, inMyAgents } from './agentKind.js'

// Task #4116 (Swarm v3, anh Dee 11-07): the left pane lists "My agents": the person's agents,
// a crown beside a PM, bold for an agent whose chat has news. Each agent says what it is and the chat its person talks to it in.
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }

function setup() {
  const state = createSuperTab('swarm', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test')
  const peer: Person = { id: 'peer', email: 'peer@example.com', role: 'collaborator', generation: 'second' }
  state.people.push(peer)
  const agent = (id: string, extra: Partial<Agent> = {}): Agent => {
    const made = { id, machineId: 'machine', harnessId: `${id}-harness`, machineOwnerId: 'peer', contributorId: 'peer', membershipGeneration: 'second',
      name: id, configuration, ...extra } as Agent
    state.agents.push(made)
    return made
  }
  return { state, peer, agent }
}

describe('an agent\'s kind and chat', () => {
  it('is a PM in its project\'s Lead chat', () => {
    const { state, agent } = setup()
    const pm = agent('pm')
    const lead = state.conversations.find(c => c.id === 'lead')!
    lead.leadId = pm.id
    lead.agentIds.push(pm.id)
    expect(agentKind(state, pm)).toBe('pm')
    expect(agentChatId(state, pm)).toBe('lead')
  })

  // Swarm v4 (anh Dee 2026-11-08): the project chat is its channel, where only agents post; its person talks to the PM in a
  // chat of its own, as with any agent.
  it('is a PM talked to in its own chat when it has one', () => {
    const { state, agent } = setup()
    const pm = agent('pm')
    const lead = state.conversations.find(c => c.id === 'lead')!
    lead.leadId = pm.id
    lead.agentIds.push(pm.id)
    state.conversations.push({ id: 'pm-chat', kind: 'agent-chat', title: 'pm', leadId: null, agentIds: [pm.id], archived: false, brief: '',
      checks: [], assignment: null, lastMessageSequence: 0, audience: { people: [{ id: 'peer', generation: 'second' }] } } as never)
    expect(agentKind(state, pm)).toBe('pm')
    expect(agentChatId(state, pm)).toBe('pm-chat')
  })

  it('is Regular otherwise, with no chat of its own yet', () => {
    const { state, agent } = setup()
    const worker = agent('worker')
    state.conversations.find(c => c.id === 'lead')!.agentIds.push(worker.id)
    expect(agentKind(state, worker)).toBe('regular')
    expect(agentChatId(state, worker)).toBeNull()
  })
})

// Task #4192 (anh Dee 11-07, Desktop 1.3.87): his My agents showed about 30 rows, agents he never started among them. It lists
// only the agents running on their own account: Team-account, stopped and finished agents leave it.
describe('the reader\'s My agents', () => {
  const peerReads: Actor = { kind: 'person', userId: 'peer', email: 'peer@example.com' }

  it('holds an agent they brought that runs on their own account', () => {
    const { state, agent } = setup()
    expect(inMyAgents(state, peerReads, agent('mine'))).toBe(true)
  })

  it('leaves out another person\'s agent and an agent reader', () => {
    const { state, agent } = setup()
    const theirs = agent('theirs', { contributorId: 'owner', machineOwnerId: 'owner' })
    expect(inMyAgents(state, peerReads, theirs)).toBe(false)
    expect(inMyAgents(state, { kind: 'agent', agentId: 'theirs', machineOwnerId: 'peer' }, agent('mine'))).toBe(false)
  })

  it('leaves out a stopped, finished or stopping agent', () => {
    const { state, agent } = setup()
    expect(inMyAgents(state, peerReads, agent('down', { downSince: new Date(0).toISOString() }))).toBe(false)
    expect(inMyAgents(state, peerReads, agent('finished', { workDecision: 'awaiting' }))).toBe(false)
    expect(inMyAgents(state, peerReads, agent('stopping', { workDecision: 'stop' }))).toBe(false)
    expect(inMyAgents(state, peerReads, agent('kept', { workDecision: 'keep' }))).toBe(true)
  })

  it('keeps a PM leading a project while its session restarts', () => {
    const { state, agent } = setup()
    const pm = agent('pm', { downSince: new Date(0).toISOString() })
    state.conversations.find(c => c.id === 'lead')!.leadId = pm.id
    expect(inMyAgents(state, peerReads, pm)).toBe(true)
  })
})
