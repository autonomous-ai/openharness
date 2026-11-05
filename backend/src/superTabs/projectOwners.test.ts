import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor, type SuperTabState } from './model.js'
import { ownsProject, projectOf } from './projects.js'

// Task #3073 (Diego, 11-05): a private project's owner who leaves the Swarm, or is removed, loses it, and the project stays
// manageable. Ownership is a membership (id and generation), as a project member's is, never the account id alone.
const owner: Actor = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const p: Actor = { kind: 'person', userId: 'p', email: 'p@example.com' }

function setup() {
  let state = createSuperTab('swarm', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test')
  state.people.push({ id: 'p', email: 'p@example.com', role: 'collaborator', generation: 'p-first' })
  let next = 0
  const run = (command: Command, actor = owner, context: Partial<CommandContext> = {}) => {
    const effect = applyCommand(state, actor, command, { operationId: `op${next++}`, now: 1000,
      contribution: { machineOwnerId: 'host', contributorId: actor.kind === 'person' ? actor.userId : 'owner' }, ...context })
    state = effect.state
    return effect.result
  }
  const create = (actor: Actor, visibility: 'private' | 'public' = 'private') =>
    run({ type: 'project.create', name: 'X', visibility, brief: '' }, actor) as { projectId: string; conversationId: string }
  const reads = (actor: Actor, projectId: string) => (visibleState(state, actor).projects ?? []).some(item => item.id === projectId)
  return { run, create, reads, get state(): SuperTabState { return state } }
}

describe('a project owner\'s membership', () => {
  it('is stored when the project is created', () => {
    const f = setup(), x = f.create(p)
    expect(projectOf(f.state, x.projectId)).toMatchObject({ ownerId: 'p', ownerGeneration: 'p-first' })
  })

  it('keeps an owner who stayed reading and managing their project, as today', () => {
    const f = setup(), x = f.create(p)
    expect(f.reads(p, x.projectId)).toBe(true)
    expect(ownsProject(f.state, 'p', projectOf(f.state, x.projectId))).toBe(true)
    f.run({ type: 'project.rename', projectId: x.projectId, name: 'Renamed' }, p)
    expect(projectOf(f.state, x.projectId).name).toBe('Renamed')
  })

  it('does not let the same account at a later membership read or manage the project', () => {
    const f = setup(), x = f.create(p)
    // Left and came back: the same account, a new membership.
    f.state.people.find(person => person.id === 'p')!.generation = 'p-second'
    expect(ownsProject(f.state, 'p', projectOf(f.state, x.projectId))).toBe(false)
    expect(f.reads(p, x.projectId)).toBe(false)
    expect(() => f.run({ type: 'project.rename', projectId: x.projectId, name: 'Mine again' }, p)).toThrow('unavailable')
    expect(() => f.run({ type: 'project.sharing', projectId: x.projectId, visibility: 'public', memberIds: [] }, p)).toThrow('unavailable')
  })

  it('matches by account alone for a project from before the membership was stored, until it is settled', () => {
    const f = setup(), x = f.create(p)
    delete projectOf(f.state, x.projectId).ownerGeneration
    f.state.people.find(person => person.id === 'p')!.generation = 'p-second'
    expect(ownsProject(f.state, 'p', projectOf(f.state, x.projectId))).toBe(true)
    expect(f.reads(p, x.projectId)).toBe(true)
  })

  it('is no one\'s once its owner is not in the Swarm', () => {
    const f = setup(), x = f.create(p)
    f.state.people = f.state.people.filter(person => person.id !== 'p')
    expect(ownsProject(f.state, 'p', projectOf(f.state, x.projectId))).toBe(false)
  })
})
