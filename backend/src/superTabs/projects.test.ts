import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { agentOnly, createSuperTab, SuperTabError, visibleState, type Actor, type MessageDraft } from './model.js'
import { canReadAgent, canWatchAgent, markConfidential, projectOf, projectsOf, readConversation, skillModeOf, skillSetOf, watchersLost } from './projects.js'
import { mayDrive } from './terminal.js'

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
    expect(f.state.conversations.map(c => c.number)).toEqual([undefined, 1, undefined, 2, undefined])
    expect(f.state.conversations.map(c => c.id)).toContain(original.conversationId)
    expect(next.number).toBe(2)
    expect(() => f.run({ type: 'conversation.archive', conversationId: p.conversationId, archived: true })).toThrow('stays available')
  })

  it('hides private project metadata, groups, agents, starts and message access from other members', () => {
    const f = setup(), p = f.project()
    const id = f.add(p.conversationId, 'private-lead')
    const visible = visibleState(f.state, peer)
    expect(visible.projects!.map(p => p.id)).toEqual(['lead'])
    expect(visible.conversations.map(c => c.id)).toEqual(['lead', f.state.leadsConversationId])
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
    // Only the Swarm-wide Leads conversation is left.
    expect(f.state.conversations.map(c => c.kind)).toEqual(['leads'])
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
      expect(() => f.run(command, actor(workerId))).toThrow(expect.objectContaining({ code: 'COORDINATOR_REQUIRED' }))
      expect(() => f.run(command, actor(otherId))).toThrow('unavailable')
    }
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
    const f = setup(), p = f.project(), agentId = f.add(p.conversationId, 'idle', false), otherId = f.add('lead', 'other')
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
    const f = setup(), p = f.project(), agentId = f.add(p.conversationId, 'worker', false)
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

  // Skill modes are the project's instructions now (project instructions, phase 4): an older client's change is answered and
  // kept nowhere, and the stored mode stays for older readers.
  it('accepts an older client\'s mode change from whoever reads the project and keeps it nowhere', () => {
    const f = setup(), p = f.project('public', peer), other = f.project('private')
    const lead = agentActor(f.add(p.conversationId, 'app-lead'))
    for (const [actor, context] of [[peer, {}], [owner, {}], [lead, said('peer')]] as const) {
      expect(f.run(skills(p.projectId, 'orchestration', { conversationId: p.conversationId, messageId: 'm1' }), actor, context))
        .toMatchObject({ ignored: true, note: expect.stringContaining('instructions') })
    }
    expect(modeOf(f, p.projectId)).toBe('default')
    expect(f.messages).toEqual([])
    expect(() => f.run(skills(other.projectId, 'orchestration'), peer)).toThrow('unavailable')
  })
})

describe('custom role sets', () => {
  type Kind = 'lead' | 'builder' | 'reviewer'
  const role = (id: string, name: string, kind: Kind, text = `# ${name}`) => ({ id, name, kind, text })
  const defaults = () => [role('lead', 'Product Manager', 'lead'), role('dev', 'Engineer', 'builder'), role('review', 'Reviewer', 'reviewer')]
  const version = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)
  const agentActor = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host' })
  const request = (conversationId: string, extra: Record<string, unknown> = {}) => ({ conversationId, machineId: 'machine', engine: 'codex',
    name: 'Builder', cwd: '/work', worktree: true, ...extra,
    requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } })
  /** A public project owned by peer (not the Swarm owner), with the custom set an older client made before project instructions,
   *  as the state keeps it: role saves are kept nowhere now. */
  function custom(roles = defaults()) {
    const f = setup(), p = f.project('public', peer)
    projectOf(f.state, p.projectId).roles = roles.map(({ text, ...r }) => ({ ...r, version: version(text) }))
    return { f, p, roles: () => projectOf(f.state, p.projectId).roles }
  }

  // Custom role sets are the project's instructions now (project instructions, phase 4): an older client's set and role saves are
  // answered and kept nowhere; only the project's owner is answered, as before.
  it('accepts an older client\'s role set saves from the project owner, keeps them nowhere, and refuses anyone else', () => {
    const { f, p, roles } = custom()
    const before = structuredClone(roles())
    const commands: Command[] = [
      { type: 'project.roles.create', projectId: p.projectId, roles: [role('dev', 'Engineer', 'builder')] },
      { type: 'project.role.set', projectId: p.projectId, role: role('lead', 'Coordinator', 'builder', '# New') },
      { type: 'project.role.remove', projectId: p.projectId, roleId: 'lead' },
      { type: 'project.roles.reset', projectId: p.projectId, roles: [role('abcdefabcdef', 'Docs writer', 'reviewer')] }]
    for (const command of commands) {
      expect(f.run(command, peer), command.type).toMatchObject({ ignored: true, note: expect.stringContaining('instructions') })
      expect(f.messages).toEqual([])
    }
    expect(roles()).toEqual(before)
    const lead = agentActor(f.add(p.conversationId, 'app-lead'))
    for (const command of commands) for (const actor of [owner, lead]) expect(() => f.run(command, actor)).toThrow('Only the project owner')
    // The command shape is still checked: a role text over 64 KB is refused before anything.
    expect(() => f.run({ type: 'project.role.set', projectId: p.projectId, role: role('aaaaaaaaaaaa', 'Big', 'builder', 'x'.repeat(65_537)) } as Command, peer))
      .toThrow('64 KB')
  })

  it('reads Custom only while the stored mode is still Default, so an older release switching modes is followed', () => {
    const { f, p } = custom()
    Object.assign(projectOf(f.state, p.projectId), { skillSet: 'custom', skillMode: 'default' })
    // What today's release writes when it switches this project: skillMode only.
    projectOf(f.state, p.projectId).skillMode = 'orchestration'
    expect(skillSetOf(projectOf(f.state, p.projectId))).toBe('orchestration')
    expect(skillSetOf({ ...projectOf(f.state, p.projectId), skillMode: undefined })).toBe('orchestration')
  })

  // Role defaults live in the project's instructions now (project instructions, phase 4): a start fills none of an old set's.
  it('keeps a role\'s default engine, model and effort for older readers, and a start that names no model takes none of it', () => {
    const writer = { ...role('abcdefabcdef', 'Docs writer', 'builder'), defaults: { engine: 'codex' as const, model: 'gpt-6.1-sol', effort: 'medium' } }
    const { f, p, roles } = custom([...defaults(), writer])
    Object.assign(projectOf(f.state, p.projectId), { skillSet: 'custom' })
    expect(roles()!.find(r => r.id === 'abcdefabcdef')).toMatchObject({ defaults: { engine: 'codex', model: 'gpt-6.1-sol', effort: 'medium' } })
    const startWith = (extra: Record<string, unknown>) => {
      const startId = String(f.run({ type: 'agent.start', request: request(p.conversationId, extra) } as Command, peer).startId)
      return f.state.starts!.find(s => s.id === startId)!.request
    }
    expect(startWith({ roleId: 'abcdefabcdef' })).not.toHaveProperty('model')
    expect(startWith({ roleId: 'abcdefabcdef' })).not.toHaveProperty('effort')
    expect(startWith({ roleId: 'abcdefabcdef', model: 'gpt-6-luna' })).toMatchObject({ model: 'gpt-6-luna' })
    expect(startWith({ roleId: 'abcdefabcdef', model: 'gpt-6-luna' })).not.toHaveProperty('effort')
    expect(startWith({ roleId: 'abcdefabcdef', engine: 'claude' })).not.toHaveProperty('model')
    // The Engineer of the copied Default set has none: routing chooses.
    expect(startWith({ roleId: 'dev' })).not.toHaveProperty('model')
    const bad = (defaults: unknown) => () => f.run({ type: 'project.role.set', projectId: p.projectId, role: { ...writer, defaults } } as Command, peer)
    expect(bad({ engine: 'cursor' })).toThrow()
    expect(bad({ engine: 'codex', model: 'x'.repeat(201) })).toThrow()
    expect(bad({ engine: 'codex', other: true })).toThrow()
  })

  // An older client's role id is kept for older readers and names the agent; its kind decides nothing (project instructions, phase 4).
  it('starts and assigns in any role id an older client sends, keeping it and naming the agent by it', () => {
    const { f, p } = custom([...defaults(), role('abcdefabcdef', 'Docs writer', 'builder')])
    // The project's owner starts it: a teammate's project runs only on a Team machine (machines.ts teamWorkCheck).
    const start = (extra: Record<string, unknown>) => String(f.run({ type: 'agent.start', request: request(p.conversationId, extra) } as Command, peer).startId)
    for (const extra of [{ roleId: 'review' }, { roleId: 'lead' }, { roleId: 'eeeeeeeeeeee' }, { role: 'reviewer', roleId: 'dev' }]) {
      const id = start(extra)
      expect(f.state.starts!.find(s => s.id === id)!.request).toMatchObject(extra)
    }
    const startId = start({ roleId: 'abcdefabcdef' })
    const worker = String(f.run({ type: 'agent.started', startId, harnessId: 'native', configuration }, peer).agentId)
    expect(f.state.agents.find(a => a.id === worker)).toMatchObject({ roleId: 'abcdefabcdef', roleName: 'Docs writer' })
    const group = String(f.run({ type: 'conversation.create', projectId: p.projectId, title: 'Work', brief: 'Do it', checks: [{ description: 'Done', independent: false }] }, peer).conversationId)
    f.run({ type: 'work.assign', conversationId: group, agentId: worker, roleId: 'review' }, peer)
    // Its role name stays the one it started in.
    expect(f.state.agents.find(a => a.id === worker)).toMatchObject({ roleId: 'review', roleName: 'Docs writer' })
    const plain = f.project('public', peer)
    expect(f.run({ type: 'agent.start', request: request(plain.conversationId, { roleId: 'dev' }) } as Command).startId).toEqual(expect.any(String))
  })

  it('joins an agent with the role the New Harness form sends, kept with a reviewer role\'s kind for older readers and naming it', () => {
    const { f, p } = custom()
    let harness = 0
    /** Exactly what Desktop's New Harness form sends (PR #1659): lead, the chosen role id, its configuration. */
    const add = (lead: boolean, roleId?: string) => commandSchema.parse({ type: 'agent.add', conversationId: p.conversationId,
      machineId: 'machine', harnessId: `added-${++harness}`, name: lead ? 'Lead' : 'Added', lead, ...(roleId ? { roleId } : {}), configuration })
    const added = (agentId: string) => f.state.agents.find(a => a.id === agentId)!
    const engineer = added(String(f.run(add(false, 'dev')).agentId))
    expect(engineer).toMatchObject({ roleId: 'dev', roleName: 'Engineer' })
    expect(engineer).not.toHaveProperty('role')
    expect(added(String(f.run(add(false, 'review')).agentId))).toMatchObject({ roleId: 'review', role: 'reviewer', roleName: 'Reviewer' })
    const lead = added(String(f.run(add(true, 'lead')).agentId))
    expect(lead).toMatchObject({ roleId: 'lead', roleName: 'Product Manager' })
    expect(lead).not.toHaveProperty('role')
    const plainAgent = added(String(f.run(add(false)).agentId))
    expect(plainAgent).not.toHaveProperty('roleId')
    expect(plainAgent).not.toHaveProperty('roleName')
    // A role of another kind, or one the set does not have, decides nothing (project instructions, phase 4).
    expect(added(String(f.run(add(false, 'lead')).agentId))).toMatchObject({ roleId: 'lead', roleName: 'Product Manager' })
    const unknown = added(String(f.run(add(false, 'eeeeeeeeeeee')).agentId))
    expect(unknown).toMatchObject({ roleId: 'eeeeeeeeeeee' })
    expect(unknown).not.toHaveProperty('roleName')
    const plain = f.project('public', peer)
    expect(f.run(commandSchema.parse({ type: 'agent.add', conversationId: plain.conversationId, machineId: 'machine',
      harnessId: 'plain', name: 'Plain', configuration, lead: false, roleId: 'dev' })).agentId).toEqual(expect.any(String))
  })

  it('refuses no work or review groups to an agent whose kind has no role in an older client\'s set', () => {
    const { f, p } = custom([role('lead', 'Product Manager', 'lead'), role('dev', 'Engineer', 'builder')])
    f.add(p.conversationId, 'app-lead')
    const reviewer = f.add(p.conversationId, 'app-reviewer', false)
    f.state.agents.find(a => a.id === reviewer)!.role = 'reviewer'
    const build = String(f.run({ type: 'conversation.create', projectId: p.projectId, title: 'Build', brief: 'Do it', checks: [{ description: 'Done', independent: false }] }, peer).conversationId)
    // Switching to Custom is kept nowhere, and tells no agent anything.
    f.run({ type: 'project.skills', projectId: p.projectId, mode: 'custom' }, peer)
    expect(f.messages).toEqual([])
    Object.assign(projectOf(f.state, p.projectId), { skillSet: 'custom' })
    // A role set decides nothing (project instructions, phase 4): a review group, a Reviewer's start and its assignment are accepted.
    const review = String(f.run({ type: 'conversation.create', projectId: p.projectId, title: 'Review', brief: 'Check it', reviewOf: build, checks: [{ description: 'Read', independent: true }] }, peer).conversationId)
    expect(f.run({ type: 'agent.start', request: request(p.conversationId, { role: 'reviewer' }) } as Command).startId).toEqual(expect.any(String))
    f.run({ type: 'work.assign', conversationId: review, agentId: reviewer }, peer)
    expect(f.state.conversations.find(c => c.id === review)!.assignment).toMatchObject({ agentId: reviewer })
  })

  it('shows clients the set, the project\'s skillSet and each agent\'s role id, never a role text', () => {
    const { f, p } = custom()
    const lead = f.add(p.conversationId, 'app-lead'), worker = f.add(p.conversationId, 'w1', false)
    let visible = visibleState(f.state, peer)
    expect(visible.projects!.find(x => x.id === p.projectId)).toMatchObject({ skillSet: 'default', roles: expect.any(Array) })
    expect(visible.agents.find(a => a.id === worker)).not.toHaveProperty('roleId')
    Object.assign(projectOf(f.state, p.projectId), { skillSet: 'custom' })
    visible = visibleState(f.state, peer)
    expect(visible.projects!.find(x => x.id === p.projectId)!.skillSet).toBe('custom')
    expect(visible.agents.filter(a => [lead, worker].includes(a.id)).map(a => a.roleId)).toEqual(['lead', 'dev'])
    expect(visible.projects!.find(x => x.id === 'lead')!.skillSet).toBe('default')
  })
})

describe('who may watch an agent\'s terminal (final review, Critical 1)', () => {
  it('keeps a session in a private chat to its machine\'s owner even when it is no longer the Lead, and leaves other agents to every reader', () => {
    const f = setup()
    const host: Actor = { kind: 'person', userId: 'host', email: 'host@example.com' }
    f.state.people.push({ id: 'host', email: 'host@example.com', role: 'collaborator', generation: 'first' })
    const builder = f.add('lead', 'builder', false), former = f.add('lead', 'former', false)
    const target = (id: string) => f.state.agents.find(a => a.id === id)!
    // A private chat that still lists an earlier Lead's session: its screen holds that chat.
    f.state.conversations.push({ id: 'chat', title: 'Chat with PM', leadId: null, agentIds: [former], archived: false, brief: '', checks: [],
      assignment: null, lastMessageSequence: 0, audience: { people: [{ id: 'peer', generation: 'first' }] } })
    for (const reader of [owner, peer]) {
      expect(canWatchAgent(f.state, reader, target(former))).toBe(false)
      expect(canWatchAgent(f.state, reader, target(builder))).toBe(true)
    }
    expect(canWatchAgent(f.state, host, target(former))).toBe(true)
  })

  it('lets every reader watch the project\'s current Lead, private chats included, but only its machine\'s person type or read it on request', () => {
    const f = setup()
    const host: Actor = { kind: 'person', userId: 'host', email: 'host@example.com' }
    f.state.people.push({ id: 'host', email: 'host@example.com', role: 'collaborator', generation: 'first' })
    const pm = f.add('lead', 'pm')
    // peer's Chat with PM from before Buddies replaced it, still listing the PM.
    f.state.conversations.push({ id: 'chat', title: 'Chat with PM', leadId: pm, agentIds: [pm], archived: false, brief: '', checks: [],
      assignment: null, lastMessageSequence: 0, audience: { people: [{ id: 'peer', generation: 'first' }] } })
    const target = () => f.state.agents.find(a => a.id === pm)!
    // Marked as any Lead is, so that it stays closed once it is no longer the Lead, and to other Swarms and ordinary shares.
    expect(target().confidential).toBe(true)
    // Ken, 2026-10-28: a member watching the Product Manager reads the private chats it is in, and every member may.
    for (const reader of [owner, peer, host]) expect(canWatchAgent(f.state, reader, target())).toBe(true)
    // Confidential in another Swarm too: that Swarm's chats are not this one's members' to read.
    expect(canWatchAgent(f.state, peer, target(), true)).toBe(false)
    const refusal = (actor: Actor) => { try { mayDrive(f.state, actor, target()); return null } catch (error) { if (error instanceof SuperTabError) return error.code; throw error } }
    expect(refusal(owner)).toBe('TERMINAL_PRIVATE')
    expect(refusal(peer)).toBe('TERMINAL_PRIVATE')
    expect(refusal(host)).toBeNull()
    // A Lead leaves only with its project, but a state from before that rule can hold a former one: its mark keeps it closed.
    f.state.conversations.find(c => c.id === 'lead')!.leadId = null
    expect(canWatchAgent(f.state, peer, target())).toBe(false)
    expect(canWatchAgent(f.state, host, target())).toBe(true)
  })

  it('keeps a session confidential once marked, after its private membership ends, until it leaves', () => {
    const f = setup()
    const former = f.add('lead', 'former', false)
    f.state.conversations.push({ id: 'chat', title: 'Chat with PM', leadId: null, agentIds: [former], archived: false, brief: '', checks: [],
      assignment: null, lastMessageSequence: 0, audience: { people: [{ id: 'peer', generation: 'first' }] } })
    markConfidential(f.state)
    f.state.conversations = f.state.conversations.filter(c => c.id !== 'chat')
    expect(canWatchAgent(f.state, peer, f.state.agents.find(a => a.id === former)!)).toBe(false)
    // Every command marks: a Lead stored before the mark is marked by the next one.
    const lead = f.add('lead', 'pm', true)
    delete f.state.agents.find(a => a.id === lead)!.confidential
    f.run({ type: 'conversation.create', title: 'Next', brief: '', checks: [] })
    expect(f.state.agents.find(a => a.id === lead)!.confidential).toBe(true)
  })
})

describe('whether a commit narrows who may watch a terminal', () => {
  // Each case starts where peer may watch a Builder in the main project, then runs one command.
  function watched() {
    const f = setup()
    const builder = f.add('lead', 'builder', false)
    expect(canWatchAgent(f.state, peer, f.state.agents.find(a => a.id === builder)!)).toBe(true)
    const before = structuredClone(f.state)
    return { f, builder, before, narrowed: () => watchersLost(before, f.state).length > 0 }
  }

  it('is narrowed when a session turns confidential, whatever the command, and not when it becomes its project’s Lead', () => {
    const { f, builder, narrowed } = watched()
    // The current Lead is every reader's to watch (Ken, 2026-10-28), and marked: no longer the Lead, it is nobody's.
    f.run({ type: 'conversation.agent', conversationId: 'lead', agentId: builder, present: true, lead: true })
    expect(narrowed()).toBe(false)
    f.state.conversations.find(c => c.id === 'lead')!.leadId = null
    expect(narrowed()).toBe(true)
  })

  it('is narrowed when a person leaves or a project stops being shared with them', () => {
    const removed = watched()
    removed.f.run({ type: 'member.remove', userId: 'peer' })
    expect(removed.narrowed()).toBe(true)
    const unshared = watched()
    unshared.f.run({ type: 'project.sharing', projectId: 'lead', visibility: 'private', memberIds: [] })
    expect(unshared.narrowed()).toBe(true)
  })

  it('is narrowed when a watched agent leaves', () => {
    const { f, builder, narrowed } = watched()
    f.run({ type: 'agent.remove', agentId: builder })
    expect(narrowed()).toBe(true)
  })

  it('names each agent and the people who lost sight of it, never its machine\'s owner', () => {
    const { f, builder, before } = watched()
    f.state.people.push({ id: 'host', email: 'host@example.com', role: 'collaborator', generation: 'first' })
    before.people.push({ id: 'host', email: 'host@example.com', role: 'collaborator', generation: 'first' })
    expect(watchersLost(before, f.state)).toEqual([])
    // Made Lead and joined to a private chat, it is still every reader's to watch (Ken, 2026-10-28).
    f.run({ type: 'conversation.agent', conversationId: 'lead', agentId: builder, present: true, lead: true })
    f.state.conversations.push({ id: 'chat', title: 'Chat with PM', leadId: builder, agentIds: [builder], archived: false, brief: '', checks: [],
      assignment: null, lastMessageSequence: 0, audience: { people: [{ id: 'owner', generation: f.state.people[0]!.generation }] } })
    expect(watchersLost(before, f.state)).toEqual([])
    // A Lead leaves only with its project, but a state from before that rule can hold a former Lead still in the private chat:
    // marked, it is closed to everyone but its machine's owner, the chat's member too.
    f.state.conversations.find(c => c.id === 'lead')!.leadId = null
    expect(watchersLost(before, f.state)).toEqual([{ agentId: builder, personIds: ['owner', 'peer'] }])
  })

  it('is not narrowed by a change that leaves every watcher watching', () => {
    const { f, narrowed } = watched()
    f.run({ type: 'conversation.create', title: 'Another task', brief: '', checks: [] })
    f.run({ type: 'project.sharing', projectId: 'lead', visibility: 'private', memberIds: ['peer'] })
    f.add('lead', 'second', false)
    expect(narrowed()).toBe(false)
  })
})
