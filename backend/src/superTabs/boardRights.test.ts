import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor, type SuperTabState } from './model.js'
import { projectOf } from './projects.js'
import { canChat, steers, switched } from './boardRights.js'

// Task #3819 (Phase 2 of docs/plans/2026-11-06-buddy-board-final-spec.md, Ken and anh Dee 11-06): a project's owner switches
// it to the Board way of working; in a switched project writing in its chat is a per-project Can chat right, and priority and
// pause follow roles, all on the server. A project not switched behaves exactly as today.
const swarmOwner: Actor = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const projectOwner: Actor = { kind: 'person', userId: 'p', email: 'p@example.com' }
const granted: Actor = { kind: 'person', userId: 'c', email: 'c@example.com' }
const member: Actor = { kind: 'person', userId: 'd', email: 'd@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }

export function boardFixture() {
  let state = createSuperTab('swarm', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test')
  state.people.push({ id: 'p', email: 'p@example.com', role: 'collaborator', generation: 'p1' },
    { id: 'c', email: 'c@example.com', role: 'collaborator', generation: 'c1' },
    { id: 'd', email: 'd@example.com', role: 'collaborator', generation: 'd1' })
  let next = 0
  const run = (command: Command, actor: Actor = projectOwner, context: Partial<CommandContext> = {}) => {
    const effect = applyCommand(state, actor, command, { operationId: `op${next++}`, now: 1000,
      contribution: { machineOwnerId: 'p', contributorId: actor.kind === 'person' ? actor.userId : 'p' }, ...context })
    state = effect.state
    return effect.result as Record<string, unknown>
  }
  const app = run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }) as { projectId: string; conversationId: string }
  const add = (harnessId: string, lead: boolean) => run({ type: 'agent.add', conversationId: app.conversationId, harnessId, machineId: 'machine',
    name: harnessId, lead, configuration }).agentId as string
  const pm = add('pm', true), worker = add('worker', false)
  const project = () => projectOf(state, app.projectId)
  const asAgent = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'p' })
  return { run, app, pm, worker, project, asAgent, get state(): SuperTabState { return state } }
}

describe('a project\'s Board settings', () => {
  it('are set and cleared by the project owner or the Swarm owner, and read by every reader of the project', () => {
    const f = boardFixture()
    expect(switched(f.project())).toBe(false)
    f.run({ type: 'project.boardMode', projectId: f.app.projectId, on: true })
    f.run({ type: 'project.canChat', projectId: f.app.projectId, personId: 'c', granted: true }, swarmOwner)
    f.run({ type: 'project.decider', projectId: f.app.projectId, personId: 'd' })
    expect(f.project()).toMatchObject({ boardMode: true, canChat: ['c'], decider: 'd' })
    expect(switched(f.project())).toBe(true)
    const seen = visibleState(f.state, member).projects!.find(p => p.id === f.app.projectId)!
    expect(seen).toMatchObject({ boardMode: true, canChat: ['c'], decider: 'd' })

    f.run({ type: 'project.canChat', projectId: f.app.projectId, personId: 'c', granted: false })
    f.run({ type: 'project.decider', projectId: f.app.projectId, personId: null }, swarmOwner)
    f.run({ type: 'project.boardMode', projectId: f.app.projectId, on: false }, swarmOwner)
    const project = f.project()
    expect(project.boardMode).toBeUndefined()
    expect(project.canChat).toBeUndefined()
    expect(project.decider).toBeUndefined()
  })

  it('refuse a member, the PM and any other agent', () => {
    const f = boardFixture()
    const commands: Command[] = [
      { type: 'project.boardMode', projectId: f.app.projectId, on: true },
      { type: 'project.canChat', projectId: f.app.projectId, personId: 'd', granted: true },
      { type: 'project.decider', projectId: f.app.projectId, personId: 'd' },
    ]
    for (const command of commands) {
      for (const actor of [member, granted, f.asAgent(f.pm), f.asAgent(f.worker)]) {
        expect(() => f.run(command, actor), `${command.type} by ${JSON.stringify(actor)}`).toThrow(expect.objectContaining({ status: 403 }))
      }
    }
    expect(f.project().boardMode).toBeUndefined()
  })

  it('grant and name only people who read the project', () => {
    const f = boardFixture()
    expect(() => f.run({ type: 'project.canChat', projectId: f.app.projectId, personId: 'stranger', granted: true }))
      .toThrow(expect.objectContaining({ code: 'PERSON_UNKNOWN' }))
    expect(() => f.run({ type: 'project.decider', projectId: f.app.projectId, personId: 'stranger' }))
      .toThrow(expect.objectContaining({ code: 'PERSON_UNKNOWN' }))
  })

  it('give Can chat to the owners and the granted, and steering to the owners and the decider', () => {
    const f = boardFixture()
    f.run({ type: 'project.canChat', projectId: f.app.projectId, personId: 'c', granted: true })
    f.run({ type: 'project.decider', projectId: f.app.projectId, personId: 'd' })
    const project = f.project()
    expect(['owner', 'p', 'c', 'd'].map(id => canChat(f.state, project, id))).toEqual([true, true, true, false])
    expect(['owner', 'p', 'c', 'd'].map(id => steers(f.state, project, id))).toEqual([true, true, false, true])
    // A person who left the Swarm keeps nothing.
    f.state.people.splice(f.state.people.findIndex(person => person.id === 'c'), 1)
    expect(canChat(f.state, project, 'c')).toBe(false)
  })
})
