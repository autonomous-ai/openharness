import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor, type MessageDraft } from './model.js'
import { canReadAgent, projectOf, projectsOf, readConversation, skillModeOf } from './projects.js'

const owner: Actor = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Actor = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'codex', model: null, effort: null, contextWindow: null, engineVersion: null }
function setup() {
  let state = createSuperTab('swarm', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test')
  state.people.push({ id: 'peer', email: 'peer@example.com', role: 'collaborator', generation: 'first' })
  let next = 0, messages: MessageDraft[] = []
  const run = (command: Command, actor = owner, context: Partial<CommandContext> = {}) => {
    const effect = applyCommand(state, actor, command, { operationId: `op${next++}`, now: 1000,
      contribution: { machineOwnerId: 'host', contributorId: actor.kind === 'person' ? actor.userId : 'owner' }, ...context })
    state = effect.state
    messages = effect.messages
    return effect.result
  }
  const project = (visibility: 'private' | 'public' = 'private', actor = owner) =>
    run({ type: 'project.create', name: 'Other project', visibility, brief: 'Its own outcome' }, actor) as { projectId: string; conversationId: string }
  const add = (conversationId: string, harnessId: string, lead = true) =>
    run({ type: 'agent.add', conversationId, harnessId, machineId: 'machine', name: harnessId, configuration, lead }).agentId as string
  return { run, project, add, get state() { return state }, get messages() { return messages } }
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

  it('deletes an empty legacy project without recreating a fallback or reusing its workgroup numbers', () => {
    const f = setup()
    const old = f.run({ type: 'conversation.create', title: 'Abandoned', brief: '', checks: [] })
    f.state.project = { machineId: 'machine', cwd: '/old', repositoryUrl: null }
    const machine = { machineId: 'old', name: 'Old', contributorId: 'owner', membershipGeneration: 'swarm',
      generation: 'g', cwd: '/old', engines: ['codex'], maxAgents: 2, paused: false }
    f.state.machines = [machine, { ...machine, machineId: 'shared', scope: 'swarm' }]
    f.run({ type: 'invite.create', email: 'new@example.com', role: 'collaborator', conversationId: 'lead' })
    expect(f.run({ type: 'project.delete', projectId: 'lead' })).toEqual({})
    expect(projectsOf(f.state)).toEqual([])
    expect(f.state.conversations).toEqual([])
    expect(f.state.invitations).toEqual([])
    expect(f.state.project).toBeUndefined()
    expect(f.state.machines?.map(m => m.machineId)).toEqual(['shared'])
    expect(f.state.people).toHaveLength(2)
    expect(visibleState(f.state, owner)).not.toHaveProperty('retiredConversationNumber')
    expect(() => readConversation(f.state, owner, 'lead')).toThrow('unavailable')
    const p = f.project('public')
    const next = f.run({ type: 'conversation.create', projectId: p.projectId, title: 'New work', brief: '', checks: [] })
    expect(next.number).toBe(Number(old.number) + 1)
    expect(f.state.conversations.map(c => c.id)).not.toContain(old.conversationId)
  })

  it('requires the project owner and preserves private-project boundaries during deletion', () => {
    const f = setup(), publicProject = f.project('public', peer), privateProject = f.project('private', peer)
    expect(() => f.run({ type: 'project.delete', projectId: publicProject.projectId })).toThrow('Only the project owner')
    expect(() => f.run({ type: 'project.delete', projectId: privateProject.projectId })).toThrow('unavailable')
    f.state.people.find(p => p.id === 'peer')!.role = 'viewer'
    expect(() => f.run({ type: 'project.delete', projectId: publicProject.projectId }, peer)).toThrow('read-only')
    f.state.people.find(p => p.id === 'peer')!.role = 'collaborator'
    f.run({ type: 'project.delete', projectId: publicProject.projectId }, peer)
    expect(projectsOf(f.state).map(p => p.id)).toEqual(['lead', privateProject.projectId])
  })

  it('lets a person unpause an empty swarm and create its next project', () => {
    const f = setup()
    f.run({ type: 'tab.pause', paused: true })
    f.run({ type: 'project.delete', projectId: 'lead' })
    expect(projectsOf(f.state)).toEqual([])
    expect(() => f.project()).toThrow('paused')
    f.run({ type: 'tab.pause', paused: false }, peer)
    const next = f.project('public')
    expect(projectsOf(f.state).map(p => p.id)).toEqual([next.projectId])
  })

  it('keeps human swarm controls separate from private projects and rejects viewers', () => {
    const f = setup(), privateProject = f.project('private', peer)
    f.run({ type: 'project.delete', projectId: 'lead' })
    f.run({ type: 'tab.rename', name: 'Renamed swarm' })
    f.run({ type: 'tab.pause', paused: true })
    expect(f.state.name).toBe('Renamed swarm')
    expect(visibleState(f.state, owner).projects).toEqual([])
    expect(() => readConversation(f.state, owner, privateProject.conversationId)).toThrow('unavailable')
    f.state.people.find(p => p.id === 'peer')!.role = 'viewer'
    expect(() => f.run({ type: 'tab.rename', name: 'Forbidden' }, peer)).toThrow('read-only')
    expect(() => f.run({ type: 'tab.pause', paused: false }, peer)).toThrow('read-only')
    expect(f.state.name).toBe('Renamed swarm')
    expect(f.state.paused).toBe(true)
  })

  it('does not grant swarm controls to another project’s agent when the original Lead is deleted', () => {
    const f = setup(), p = f.project()
    const leadId = f.add('lead', 'original-lead'), workerId = f.add('lead', 'worker', false)
    const otherId = f.add(p.conversationId, 'other-lead')
    const actor = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host' })
    f.run({ type: 'tab.rename', name: 'Lead renamed' }, actor(leadId))
    f.run({ type: 'tab.pause', paused: true }, actor(leadId))
    for (const command of [{ type: 'tab.rename', name: 'Forbidden' }, { type: 'tab.pause', paused: false }] as Command[]) {
      expect(() => f.run(command, actor(workerId))).toThrow('coordinating lead')
      expect(() => f.run(command, actor(otherId))).toThrow('unavailable')
    }
    f.run({ type: 'agent.remove', agentId: leadId })
    f.run({ type: 'agent.remove', agentId: workerId })
    f.run({ type: 'project.delete', projectId: 'lead' })
    expect(() => f.run({ type: 'tab.rename', name: 'Forbidden' }, actor(otherId))).toThrow('unavailable')
    expect(() => f.run({ type: 'tab.pause', paused: false }, actor(otherId))).toThrow('unavailable')
    f.run({ type: 'tab.pause', paused: false })
    expect(f.state.name).toBe('Lead renamed')
  })

  it('invites to a remaining public project once the original Lead group is deleted, and keeps pending invitations', () => {
    const f = setup(), hidden = f.project('private'), open = f.project('public')
    f.run({ type: 'invite.create', email: 'pending@example.com', role: 'viewer', conversationId: 'lead' })
    f.run({ type: 'project.delete', projectId: 'lead' })
    // Desktop still asks for the original 'lead' group; on 2026-10-22 that refused every invitation.
    f.run({ type: 'invite.create', email: 'new@example.com', role: 'collaborator', conversationId: 'lead' })
    expect(f.state.invitations.map(i => [i.email, i.conversationId])).toEqual([
      ['pending@example.com', open.conversationId], ['new@example.com', open.conversationId]])
    f.run({ type: 'project.delete', projectId: open.projectId })
    expect(f.state.invitations.map(i => i.conversationId)).toEqual([hidden.conversationId, hidden.conversationId])
    f.run({ type: 'project.delete', projectId: hidden.projectId })
    expect(f.state.invitations).toEqual([])
    expect(() => f.run({ type: 'invite.create', email: 'late@example.com', role: 'viewer', conversationId: 'lead' })).toThrow('Create a project')
  })

  it('removes only its own agents, even one that left every workgroup', () => {
    const f = setup(), p = f.project(), agentId = f.add(p.conversationId, 'idle'), otherId = f.add('lead', 'other')
    f.run({ type: 'conversation.agent', conversationId: p.conversationId, agentId, present: false, lead: false })
    f.run({ type: 'project.delete', projectId: p.projectId })
    expect(projectsOf(f.state).map(p => p.id)).toEqual(['lead'])
    expect(f.state.agents.map(a => a.id)).toEqual([otherId])
  })

  it.each(['queued', 'dispatched', 'settling'] as const)('refuses %s starts and removes only settled project history', phase => {
    const f = setup(), p = f.project()
    const request = { conversationId: p.conversationId, machineId: 'machine', engine: 'codex', name: 'Builder',
      cwd: '/work', worktree: true,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } }
    const startId = String(f.run({ type: 'agent.start', request }).startId)
    const start = f.state.starts!.find(s => s.id === startId)!
    start.dispatched = phase !== 'queued'
    if (phase === 'settling') { start.poolGeneration = 'pool'; start.harnessId = 'native'; start.poolSettled = false }
    expect(() => f.run({ type: 'project.delete', projectId: p.projectId })).toThrow('pending agent starts')
    if (phase === 'settling') start.poolSettled = true
    else f.run({ type: 'agent.startFailed', startId, error: 'The machine confirmed nothing started.' })
    f.run({ type: 'project.delete', projectId: p.projectId })
    expect(f.state.starts).toEqual([])
    expect(() => f.run({ type: 'agent.started', startId, harnessId: 'late', configuration })).toThrow('unavailable')
  })

  it('lets the owner or lead share a missing repository address once, without replacing it', () => {
    const f = setup(), p = f.project('public'), url = 'https://github.com/example/project'
    const share = (repositoryUrl: string): Command => ({ type: 'project.repository', projectId: p.projectId, repositoryUrl })
    expect(() => f.run(share(url))).toThrow('lead in its repository')
    // What Desktop recorded while it dropped the daemon's scheme-less remote.
    f.run({ type: 'agent.add', conversationId: p.conversationId, harnessId: 'lead', machineId: 'machine', name: 'Lead', configuration,
      lead: true, project: { cwd: '/work/project', repositoryUrl: null } })
    const lead: Actor = { kind: 'agent', agentId: f.state.agents[0]!.id, machineOwnerId: 'host' }
    const worker: Actor = { kind: 'agent', agentId: f.add(p.conversationId, 'worker', false), machineOwnerId: 'host' }
    expect(() => f.run(share(url), peer)).toThrow('Only the project owner or its lead')
    expect(() => f.run(share(url), worker)).toThrow('Only the project owner or its lead')
    f.run(share(url), lead)
    const repository = () => projectsOf(f.state).find(item => item.id === p.projectId)!.repository
    expect(repository()).toEqual({ machineId: 'machine', cwd: '/work/project', repositoryUrl: url })
    f.run(share(url))
    expect(() => f.run(share('https://github.com/example/another'))).toThrow('already shares another repository')
    expect(repository()!.repositoryUrl).toBe(url)
  })

  it('shares a missing repository address on a tab from before projects', () => {
    const f = setup(), url = 'git@github.com:example/project.git'
    delete f.state.projects
    f.state.project = { machineId: 'machine', cwd: '/old', repositoryUrl: null }
    f.run({ type: 'project.repository', projectId: 'lead', repositoryUrl: url })
    expect(f.state.project).toEqual({ machineId: 'machine', cwd: '/old', repositoryUrl: url })
    expect(projectsOf(f.state)[0]!.repository).toEqual(f.state.project)
  })

  it('keeps active work visible after its contributed agent is removed', () => {
    const f = setup(), p = f.project(), agentId = f.add(p.conversationId, 'worker')
    f.run({ type: 'work.define', conversationId: p.conversationId, brief: 'Finish the task',
      checks: [{ description: 'Verified', independent: false }] })
    f.run({ type: 'work.assign', conversationId: p.conversationId, agentId })
    f.run({ type: 'agent.remove', agentId })
    expect(() => f.run({ type: 'project.delete', projectId: p.projectId })).toThrow('active work')
    expect(readConversation(f.state, owner, p.conversationId).assignment?.status).toBe('reconciling')
  })
})

describe('project skill modes', () => {
  const skills = (projectId: string, mode: 'default' | 'orchestration', askedIn?: { conversationId: string; messageId: string }): Command =>
    ({ type: 'project.skills', projectId, mode, ...(askedIn ? { askedIn } : {}) })
  const said = (id: string, patch: Record<string, unknown> = {}): Partial<CommandContext> => ({ askedIn: {
    author: { kind: 'person', id, name: id, membershipGeneration: 'first' }, source: false, createdAt: 1000, ...patch } })
  const agentActor = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host' })
  const modeOf = (f: ReturnType<typeof setup>, projectId: string) => skillModeOf(projectOf(f.state, projectId))

  it('reads a project with no stored mode as Harness orchestration, and new projects and Swarms as Default', () => {
    const legacy = createSuperTab('old', 'Old', { id: 'owner', email: 'owner@example.com' }, 'test')
    delete legacy.projects
    expect(skillModeOf(projectsOf(legacy)[0]!)).toBe('orchestration')
    expect(skillModeOf({ ...projectsOf(legacy)[0]!, skillMode: undefined })).toBe('orchestration')
    for (const visibility of [undefined, 'private', 'public'] as const) {
      const swarm = createSuperTab('new', 'New', { id: 'owner', email: 'owner@example.com' }, 'test', visibility)
      expect(projectsOf(swarm).map(p => p.skillMode)).toEqual(['default'])
    }
    const f = setup(), p = f.project()
    expect(projectOf(f.state, p.projectId).skillMode).toBe('default')
  })

  it('lets the project owner change the mode and posts one Skills row in the project chat per real change', () => {
    const f = setup(), p = f.project('public', peer)
    f.run(skills(p.projectId, 'orchestration'), peer)
    expect(modeOf(f, p.projectId)).toBe('orchestration')
    expect(f.messages).toEqual([expect.objectContaining({ conversationId: p.conversationId, text: 'Skills: Harness orchestration', source: { kind: 'system' } })])
    f.run(skills(p.projectId, 'orchestration'), peer)
    expect(f.messages).toEqual([])
    const legacy = setup()
    delete legacy.state.projects
    legacy.run(skills('lead', 'orchestration'))
    expect([legacy.state.projects, legacy.messages]).toEqual([undefined, []])
    f.run(skills(p.projectId, 'default'), peer)
    expect(modeOf(f, p.projectId)).toBe('default')
    expect(f.messages).toEqual([expect.objectContaining({ conversationId: p.conversationId, text: 'Skills: Default', source: { kind: 'system' } })])
  })

  it('stores the mode on a Swarm whose original project was never materialized', () => {
    const f = setup()
    delete f.state.projects
    f.run(skills('lead', 'default'))
    expect(f.state.projects!.map(p => [p.id, p.skillMode])).toEqual([['lead', 'default']])
    expect(f.messages).toEqual([expect.objectContaining({ conversationId: 'lead', text: 'Skills: Default' })])
  })

  it('lets the project\'s Lead change it by quoting a chat message the project owner wrote in the last day', () => {
    const f = setup(), p = f.project('public', peer), lead = agentActor(f.add(p.conversationId, 'app-lead'))
    f.run(skills(p.projectId, 'orchestration', { conversationId: p.conversationId, messageId: 'm1' }), lead, said('peer'))
    expect(modeOf(f, p.projectId)).toBe('orchestration')
    expect(f.messages).toEqual([expect.objectContaining({ conversationId: p.conversationId, text: 'Skills: Harness orchestration' })])
  })

  it('refuses a collaborator, the Swarm owner, another project\'s Lead, a worker, a system row and an old message', () => {
    const f = setup(), p = f.project('public', peer), other = f.project('public')
    const lead = agentActor(f.add(p.conversationId, 'app-lead')), worker = agentActor(f.add(p.conversationId, 'app-worker', false))
    const otherLead = agentActor(f.add(other.conversationId, 'other-lead'))
    const quoted = { conversationId: p.conversationId, messageId: 'm1' }
    expect(() => f.run(skills(other.projectId, 'orchestration'), peer)).toThrow('Only the project owner')
    expect(() => f.run(skills(p.projectId, 'orchestration'), owner)).toThrow('Only the project owner')
    expect(() => f.run(skills(p.projectId, 'orchestration', quoted), otherLead, said('peer'))).toThrow('unavailable')
    expect(() => f.run(skills(p.projectId, 'orchestration', quoted), worker, said('peer'))).toThrow('Only the project owner')
    expect(() => f.run(skills(p.projectId, 'orchestration'), lead, said('peer'))).toThrow('quote a chat message the project owner wrote')
    expect(() => f.run(skills(p.projectId, 'orchestration', quoted), lead, said('owner'))).toThrow('quote a chat message the project owner wrote')
    expect(() => f.run(skills(p.projectId, 'orchestration', quoted), lead, said('peer', { source: true }))).toThrow('quote a chat message the project owner wrote')
    expect(() => f.run(skills(p.projectId, 'orchestration', quoted), lead, said('peer', { createdAt: 1000 - 24 * 3_600_000 - 1 }))).toThrow('quote a chat message the project owner wrote')
    expect(() => f.run(skills(p.projectId, 'orchestration', { conversationId: 'lead', messageId: 'm1' }), lead, said('peer'))).toThrow('unavailable')
    expect([modeOf(f, p.projectId), modeOf(f, other.projectId)]).toEqual(['default', 'default'])
  })
})
