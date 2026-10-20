import { describe, expect, it } from 'vitest'
import { applyCommand, type Command } from './commands.js'
import { createSuperTab, visibleState, type Actor } from './model.js'
import { canReadAgent, projectsOf, readConversation } from './projects.js'

const owner: Actor = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Actor = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'codex', model: null, effort: null, contextWindow: null, engineVersion: null }
function setup() {
  let state = createSuperTab('swarm', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test')
  state.people.push({ id: 'peer', email: 'peer@example.com', role: 'collaborator', generation: 'first' })
  let next = 0
  const run = (command: Command, actor = owner) => {
    const effect = applyCommand(state, actor, command, { operationId: `op${next++}`, now: 1000,
      contribution: { machineOwnerId: 'host', contributorId: actor.kind === 'person' ? actor.userId : 'owner' } })
    state = effect.state
    return effect.result
  }
  const project = (visibility: 'private' | 'public' = 'private', actor = owner) =>
    run({ type: 'project.create', name: 'Other project', visibility, brief: 'Its own outcome' }, actor) as { projectId: string; conversationId: string }
  const add = (conversationId: string, harnessId: string, lead = true) =>
    run({ type: 'agent.add', conversationId, harnessId, machineId: 'machine', name: harnessId, configuration, lead }).agentId as string
  return { run, project, add, get state() { return state } }
}

describe('projects inside an invite-only swarm', () => {
  it('keeps existing conversation identities and numbers while adding independent project leads', () => {
    const f = setup()
    expect(projectsOf(f.state)[0]).toMatchObject({ name: 'Team', leadConversationId: 'lead', updateMinutes: 5 })
    const original = f.run({ type: 'conversation.create', title: 'First', brief: '', checks: [] })
    const p = f.project()
    const next = f.run({ type: 'conversation.create', projectId: p.projectId, title: 'Second', brief: '', checks: [] })
    expect(f.state.conversations.map(c => c.number)).toEqual([undefined, 1, undefined, 2])
    expect(f.state.conversations.map(c => c.id)).toContain(original.conversationId)
    expect(next.number).toBe(2)
    expect(() => f.run({ type: 'conversation.archive', conversationId: p.conversationId, archived: true })).toThrow('stays available')
  })

  it('hides private project metadata, groups, agents, starts and message access from other members', () => {
    const f = setup(), p = f.project()
    const id = f.add(p.conversationId, 'private-lead')
    const visible = visibleState(f.state, peer)
    expect(visible.projects!.map(p => p.id)).toEqual(['lead'])
    expect(visible.conversations.map(c => c.id)).toEqual(['lead'])
    expect(visible.agents).toEqual([])
    expect(canReadAgent(f.state, peer, f.state.agents[0]!)).toBe(false)
    expect(() => readConversation(f.state, peer, p.conversationId)).toThrow('unavailable')
    expect(() => f.run({ type: 'message.send', conversationId: p.conversationId, text: 'Guessing an ID', replyTo: null, recipientIds: [] }, peer)).toThrow('unavailable')
    expect(() => f.run({ type: 'agent.remove', agentId: id }, peer)).toThrow('unavailable')
  })

  it('does not grant the swarm owner access to another person’s private project', () => {
    const f = setup(), p = f.project('private', peer)
    expect(visibleState(f.state, owner).projects!.some(item => item.id === p.projectId)).toBe(false)
    expect(() => f.run({ type: 'project.sharing', projectId: p.projectId, visibility: 'public', memberIds: [] })).toThrow('unavailable')
  })

  it('makes public projects readable within the swarm and lets only their owner change sharing', () => {
    const f = setup(), p = f.project('public')
    expect(readConversation(f.state, peer, p.conversationId).id).toBe(p.conversationId)
    expect(() => f.run({ type: 'project.sharing', projectId: p.projectId, visibility: 'private', memberIds: [] }, peer)).toThrow('Only the project owner')
    f.run({ type: 'project.sharing', projectId: p.projectId, visibility: 'private', memberIds: ['peer'] })
    expect(readConversation(f.state, peer, p.conversationId).id).toBe(p.conversationId)
    f.state.people.find(p => p.id === 'peer')!.generation = 'rejoined'
    expect(() => readConversation(f.state, peer, p.conversationId)).toThrow('unavailable')
  })

  it('keeps one terminal across workgroups in its project and refuses another project’s audience', () => {
    const f = setup(), p = f.project()
    const lead = f.add(p.conversationId, 'lead')
    const actor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: 'host' }
    const work = f.run({ type: 'conversation.create', title: 'Work', brief: 'Deliver it', checks: [{ description: 'It works', independent: true }] }, actor)
    expect(f.state.conversations.find(c => c.id === work.conversationId)).toMatchObject({ projectId: p.projectId, agentIds: [lead], leadId: lead })
    expect(visibleState(f.state, actor).projects!.map(p => p.id)).toEqual([p.projectId])
    expect(() => f.run({ type: 'conversation.agent', conversationId: 'lead', agentId: lead, present: true, lead: false })).toThrow('separate agent')
    expect(() => f.add('lead', 'lead')).toThrow('separate agent')
    expect(() => f.run({ type: 'message.send', conversationId: 'lead', text: 'Cross project', replyTo: null, recipientIds: [] }, actor)).toThrow('unavailable')
  })

  it('stores the cadence per project and keeps the other project’s setting', () => {
    const f = setup(), p = f.project()
    f.run({ type: 'project.cadence', projectId: p.projectId, minutes: 15 })
    expect(projectsOf(f.state).map(p => p.updateMinutes)).toEqual([5, 15])
    expect(() => f.run({ type: 'project.cadence', projectId: p.projectId, minutes: 1 }, peer)).toThrow('unavailable')
  })
})
