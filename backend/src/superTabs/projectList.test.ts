import { describe, expect, it } from 'vitest'
import { applyCommand, type Command } from './commands.js'
import { createSuperTab, type Actor, type SuperTabState } from './model.js'
import { projectList } from './projectList.js'
import type { Pulse } from './pulse.js'

// Task #4540 (spec 2026-11-07-members-and-leads, section 1 and build task 3): the Cmd-N and join forms list the projects the
// person can read, each with what it is, its Lead and how many tasks wait, and say which row starts picked.
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
  // Every command records each project's pulse again (pulse.ts recordPulse), so the pulses wanted here are put on last.
  const wanted = new Map<string, Pulse | undefined>()
  const chatOf = (projectId: string) => state.conversations.find(c => c.id === state.projects!.find(p => p.id === projectId)!.leadConversationId)!
  const project = (name: string, extra: { visibility?: 'public' | 'private'; waiting?: number; members?: number } = {}) => {
    const id = run({ type: 'project.create', name, visibility: extra.visibility ?? 'public', brief: '' }).result.projectId as string
    wanted.set(id, pulse(extra.waiting ?? 0, extra.members ?? 0))
    return id
  }
  const noPulse = (projectId: string) => wanted.set(projectId, undefined)
  const read = () => {
    for (const [id, recorded] of wanted) { const chat = chatOf(id); if (recorded) chat.pulse = recorded; else delete chat.pulse }
    return state
  }
  const lead = (projectId: string, name: string, displayName?: string) => {
    const chat = chatOf(projectId)
    const id = `agent-${name}`
    state.agents.push({ id, machineId: 'mac', harnessId: name, machineOwnerId: 'owner', contributorId: 'owner',
      membershipGeneration: state.people[0]!.generation, hostGrant: null, name, ...(displayName ? { displayName } : {}), configuration: null, configurationVersion: 'v' } as unknown as SuperTabState['agents'][number])
    chat.leadId = id
    chat.agentIds.push(id)
  }
  return { run, project, noPulse, lead, read, get state() { return state } }
}

/** A stored pulse with [waiting] tasks in Next up and [members] agents working in the project beside its Lead. */
const pulse = (waiting: number, members: number): Pulse => ({ pmId: null,
  asks: { count: 0, oldestAt: null, personId: null, list: [] }, working: { count: 0, crew: members, agentIds: [] },
  nextUp: { count: waiting, conversationIds: [] }, lost: { count: 0, since: null, conversationIds: [] },
  held: { count: 0, withoutReason: 0, list: [] }, idleSince: null,
  redAt: { asks: null, idle: null, lost: null, held: null }, limits: { askMinutes: 5, idleMinutes: 10, lostMinutes: 10 } })

const names = (list: ReturnType<typeof projectList>) => list.projects.map(p => p.name)

describe('the project list', () => {
  it('lists only the projects the reader can read', () => {
    const f = swarm()
    f.project('harness')
    f.project('secret', { visibility: 'private' })
    expect(names(projectList(f.read(), peer))).not.toContain('secret')
    expect(names(projectList(f.read(), owner))).toContain('secret')
  })

  it('shows what each project is, else its repository\'s name, its Lead and how many tasks wait', () => {
    const f = swarm()
    const harness = f.project('harness', { waiting: 12 })
    f.run({ type: 'project.about', projectId: harness, about: 'The Harness app and Swarm' })
    f.lead(harness, 'River')
    const lamp = f.project('lamp')
    f.state.projects!.find(p => p.id === lamp)!.repository = { machineId: 'mac', cwd: '/Users/someone/lamp', repositoryUrl: 'https://github.com/autonomous-ai/lamp-os' }
    const rows = projectList(f.read(), peer).projects
    expect(rows.find(r => r.id === harness)).toEqual({ id: harness, name: 'harness', about: 'The Harness app and Swarm', repositoryName: null,
      lead: { agentId: 'agent-River', name: 'River' }, waiting: 12 })
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
    f.project('busy', { waiting: 9 })
    const quiet = f.project('quiet')
    const list = projectList(f.read(), peer, quiet)
    expect(list.pick).toBe(quiet)
    expect(list.projects[0]!.id).toBe(quiet)
  })

  it('ignores an invitation to a project the reader cannot read, or that is gone', () => {
    const f = swarm()
    const busy = f.project('busy', { waiting: 9 })
    const secret = f.project('secret', { visibility: 'private', waiting: 50 })
    expect(projectList(f.read(), peer, secret).pick).toBe(busy)
    expect(projectList(f.read(), peer, 'gone').pick).toBe(busy)
  })

  it('otherwise starts on the one that needs help most: waiting per Member there, then waiting, then A to Z', () => {
    const f = swarm()
    f.project('crowded', { waiting: 10, members: 5 })
    f.project('short', { waiting: 6, members: 1 })
    f.project('empty', { waiting: 1, members: 0 })
    f.project('beta', { waiting: 4, members: 2 })
    f.project('alpha', { waiting: 2, members: 1 })
    const list = projectList(f.read(), peer)
    // Nobody working where a task waits needs help first; 6 per Member; 2 per Member, the one with more waiting first, then A
    // to Z; nothing waiting comes last.
    expect(names(list)).toEqual(['empty', 'short', 'crowded', 'beta', 'alpha', 'Pilot'])
    expect(list.pick).toBe(list.projects[0]!.id)
  })

  it('lists a project whose pulse is not recorded yet with nothing waiting', () => {
    const f = swarm()
    const fresh = f.project('fresh')
    f.noPulse(fresh)
    expect(projectList(f.read(), peer).projects.find(r => r.id === fresh)).toMatchObject({ waiting: 0, lead: null })
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
      const id = f.project(`${i}`.padStart(3, '0') + 'x'.repeat(157), { waiting: 999 })
      f.state.projects!.find(p => p.id === id)!.repository = { machineId: 'mac', cwd: '/repo', repositoryUrl: `https://github.com/${'o'.repeat(39)}/${'r'.repeat(100)}` }
      f.lead(id, `${i}`.padStart(3, '0') + 'n'.repeat(77))
    }
    const list = projectList(f.read(), peer)
    expect(list.projects).toHaveLength(100)
    expect(Buffer.byteLength(JSON.stringify(list))).toBeLessThan(64 * 1024)
  })
})
