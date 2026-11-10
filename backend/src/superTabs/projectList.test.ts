import { describe, expect, it } from 'vitest'
import { applyCommand, type Command } from './commands.js'
import { createSuperTab, type Actor, type SuperTabState } from './model.js'
import { projectList } from './projectList.js'

// Task #4540 (spec 2026-11-07-members-and-leads, section 1 and build task 3): the Cmd-N and join forms list the projects the
// person can read, each with what it is and its Lead, and say which row starts picked. Swarm v4 (2026-11-10): a task is the
// project's GitHub issue, so no task waits on the list: `waiting` is 0 for an older app, which reads it.
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }

function swarm() {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner) => {
    const effects = applyCommand(state, actor, command, { now: 1000, operationId: `op-${++sequence}` })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
  const chatOf = (projectId: string) => state.conversations.find(c => c.id === state.projects!.find(p => p.id === projectId)!.leadConversationId)!
  const project = (name: string, visibility: 'public' | 'private' = 'public') =>
    run({ type: 'project.create', name, visibility, brief: '' }).result.projectId as string
  const read = () => state
  const lead = (projectId: string, name: string, displayName?: string) => {
    const chat = chatOf(projectId)
    const id = `agent-${name}`
    state.agents.push({ id, machineId: 'mac', harnessId: name, machineOwnerId: 'owner', contributorId: 'owner',
      membershipGeneration: state.people[0]!.generation, hostGrant: null, name, ...(displayName ? { displayName } : {}), configuration: null, configurationVersion: 'v' } as unknown as SuperTabState['agents'][number])
    chat.leadId = id
    chat.agentIds.push(id)
  }
  return { run, project, chatOf, lead, read, get state() { return state } }
}


const names = (list: ReturnType<typeof projectList>) => list.projects.map(p => p.name)

describe('the project list', () => {
  it('lists only the projects the reader can read', () => {
    const f = swarm()
    f.project('harness')
    f.project('secret', 'private')
    expect(names(projectList(f.read(), peer))).not.toContain('secret')
    expect(names(projectList(f.read(), owner))).toContain('secret')
  })

  it('shows what each project is, else its repository\'s name, and its Lead', () => {
    const f = swarm()
    const harness = f.project('harness')
    f.run({ type: 'project.about', projectId: harness, about: 'The Harness app and Swarm' })
    f.lead(harness, 'River')
    const lamp = f.project('lamp')
    f.state.projects!.find(p => p.id === lamp)!.repository = { machineId: 'mac', cwd: '/Users/someone/lamp', repositoryUrl: 'https://github.com/autonomous-ai/lamp-os' }
    const rows = projectList(f.read(), peer).projects
    expect(rows.find(r => r.id === harness)).toEqual({ id: harness, name: 'harness', about: 'The Harness app and Swarm', repositoryName: null,
      lead: { agentId: 'agent-River', name: 'River' }, waiting: 0 })
    // A repository's name, never a folder on someone's computer.
    expect(rows.find(r => r.id === lamp)).toEqual({ id: lamp, name: 'lamp', about: null, repositoryName: 'lamp-os', lead: null, waiting: 0 })
  })

  // Review of #3552: a Lead goes by the name people see (River), not its internal one (Lead).
  it('names each Lead as people see it', () => {
    const f = swarm()
    const harness = f.project('harness')
    f.lead(harness, 'Lead', 'River')
    expect(projectList(f.read(), peer).projects.find(r => r.id === harness)!.lead).toEqual({ agentId: 'agent-Lead', name: 'River' })
  })

  it('starts on the project the person was invited to', () => {
    const f = swarm()
    f.project('busy')
    const quiet = f.project('quiet')
    const list = projectList(f.read(), peer, quiet)
    expect(list.pick).toBe(quiet)
    expect(list.projects[0]!.id).toBe(quiet)
  })

  it('ignores an invitation to a project the reader cannot read, or that is gone', () => {
    const f = swarm()
    const busy = f.project('a-busy')
    const secret = f.project('secret', 'private')
    expect(projectList(f.read(), peer, secret).pick).toBe(busy)
    expect(projectList(f.read(), peer, 'gone').pick).toBe(busy)
  })

  it('otherwise lists them A to Z, the first one picked', () => {
    const f = swarm()
    for (const name of ['crowded', 'short', 'alpha']) f.project(name)
    const list = projectList(f.read(), peer)
    expect(names(list)).toEqual(['alpha', 'crowded', 'Pilot', 'short'])
    expect(list.pick).toBe(list.projects[0]!.id)
  })

  // A project chat stored before Swarm v4 may still hold its last pulse, with the tasks that waited then: none counts.
  it('counts no waiting task, though a project chat stored one before Swarm v4', () => {
    const f = swarm()
    const busy = f.project('busy')
    Object.assign(f.chatOf(busy), { pulse: { nextUp: { count: 12, conversationIds: [] }, working: { count: 0, crew: 0, agentIds: [] } } })
    expect(projectList(f.read(), peer).projects.map(r => r.waiting)).toEqual([0, 0])
  })

  it('gives a person who reads no project an empty list and no pick', () => {
    const f = swarm()
    f.run({ type: 'project.create', name: 'mine', visibility: 'private', brief: '' })
    const state = f.read()
    // Only private projects of another person: the implicit first project is made private too.
    state.projects!.forEach(p => { p.visibility = 'private' })
    expect(projectList(state, peer)).toEqual({ projects: [], pick: null })
  })

  it('stays within its byte bound for 100 projects with every field at its longest', () => {
    const f = swarm()
    for (let i = f.state.projects?.length ?? 0; i < 100; i++) {
      const id = f.project(`${i}`.padStart(3, '0') + 'x'.repeat(157))
      f.state.projects!.find(p => p.id === id)!.repository = { machineId: 'mac', cwd: '/repo', repositoryUrl: `https://github.com/${'o'.repeat(39)}/${'r'.repeat(100)}` }
      f.lead(id, `${i}`.padStart(3, '0') + 'n'.repeat(77))
    }
    const list = projectList(f.read(), peer)
    expect(list.projects).toHaveLength(100)
    expect(Buffer.byteLength(JSON.stringify(list))).toBeLessThan(64 * 1024)
  })
})
