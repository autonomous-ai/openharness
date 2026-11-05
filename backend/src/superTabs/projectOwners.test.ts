import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor, type SuperTabState } from './model.js'
import { ownsProject, projectOf, settleOwners } from './projects.js'
import { visibilityChanged } from './parts/commit.js'

// Task #3073 (Diego, 11-05): a private project's owner who leaves the Swarm, or is removed, loses it, and the project stays
// manageable. Ownership is a membership (id and generation), as a project member's is, never the account id alone.
const owner: Actor = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const p: Actor = { kind: 'person', userId: 'p', email: 'p@example.com' }
const c: Actor = { kind: 'person', userId: 'c', email: 'c@example.com' }
const d: Actor = { kind: 'person', userId: 'd', email: 'd@example.com' }

function setup() {
  let state = createSuperTab('swarm', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test')
  state.people.push({ id: 'p', email: 'p@example.com', role: 'collaborator', generation: 'p-first' },
    { id: 'c', email: 'c@example.com', role: 'collaborator', generation: 'c-first' },
    { id: 'd', email: 'd@example.com', role: 'collaborator', generation: 'd-first' })
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
  /** Invites [actor] back to the Swarm and has them accept: a new membership of the same account. */
  const rejoin = (actor: Extract<Actor, { kind: 'person' }>, role: 'viewer' | 'collaborator') => {
    const invite = run({ type: 'invite.create', email: actor.email, role, conversationId: 'lead' }).inviteId as string
    run({ type: 'invite.accept', inviteId: invite }, actor)
  }
  return { run, create, reads, rejoin, get state(): SuperTabState { return state }, set state(next: SuperTabState) { state = next } }
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

describe('a project whose owner leaves or is removed', () => {
  // Diego's case, as he reported it on 1da94962a.
  it('passes to its remaining member, and its former owner invited back reads and manages nothing of it', () => {
    const f = setup(), x = f.create(p)
    f.run({ type: 'project.sharing', projectId: x.projectId, visibility: 'private', memberIds: ['c'] }, p)
    f.run({ type: 'member.remove', userId: 'p' })
    expect(projectOf(f.state, x.projectId)).toMatchObject({ ownerId: 'c', ownerGeneration: 'c-first' })
    // C manages it now: renames it and shares it.
    f.run({ type: 'project.rename', projectId: x.projectId, name: 'C\'s now' }, c)
    f.run({ type: 'project.sharing', projectId: x.projectId, visibility: 'private', memberIds: ['d'] }, c)
    expect(f.reads(d, x.projectId)).toBe(true)
    expect(f.reads(c, x.projectId)).toBe(true)
    f.rejoin(p, 'viewer')
    expect(f.reads(p, x.projectId)).toBe(false)
    expect(() => f.run({ type: 'project.sharing', projectId: x.projectId, visibility: 'public', memberIds: [] }, p)).toThrow()
    expect(projectOf(f.state, x.projectId).visibility).toBe('private')
  })

  it('passes on the same way when its owner leaves by themselves', () => {
    const f = setup(), x = f.create(p)
    f.run({ type: 'project.sharing', projectId: x.projectId, visibility: 'private', memberIds: ['c'] }, p)
    f.run({ type: 'member.remove', userId: 'p' }, p)
    expect(projectOf(f.state, x.projectId)).toMatchObject({ ownerId: 'c', ownerGeneration: 'c-first' })
    f.rejoin(p, 'collaborator')
    expect(f.reads(p, x.projectId)).toBe(false)
    expect(() => f.run({ type: 'project.rename', projectId: x.projectId, name: 'Back' }, p)).toThrow('unavailable')
  })

  it('passes to the earliest listed member who can manage it, never a stale listing or a viewer while another can', () => {
    const f = setup(), x = f.create(p)
    f.state.people.push({ id: 'v', email: 'v@example.com', role: 'viewer', generation: 'v-first' })
    f.run({ type: 'project.sharing', projectId: x.projectId, visibility: 'private', memberIds: ['v', 'c', 'd'] }, p)
    // C left and came back since: their listing is of an earlier membership.
    f.state.people.find(person => person.id === 'c')!.generation = 'c-second'
    f.run({ type: 'member.remove', userId: 'p' })
    expect(projectOf(f.state, x.projectId)).toMatchObject({ ownerId: 'd', ownerGeneration: 'd-first' })
    // The new owner is no longer listed as a member too; the others stay as they were.
    expect(projectOf(f.state, x.projectId).members.map(m => m.id)).toEqual(['v', 'c'])
  })

  it('passes to a viewer when only viewers remain, who still reads it', () => {
    const f = setup(), x = f.create(p)
    f.state.people.push({ id: 'v', email: 'v@example.com', role: 'viewer', generation: 'v-first' })
    f.run({ type: 'project.sharing', projectId: x.projectId, visibility: 'private', memberIds: ['v'] }, p)
    f.run({ type: 'member.remove', userId: 'p' })
    expect(projectOf(f.state, x.projectId)).toMatchObject({ ownerId: 'v', ownerGeneration: 'v-first' })
  })

  it('passes a public project with no member listed to the Swarm owner', () => {
    const f = setup(), x = f.create(p, 'public')
    f.run({ type: 'member.remove', userId: 'p' })
    expect(projectOf(f.state, x.projectId)).toMatchObject({ ownerId: 'owner', ownerGeneration: f.state.people[0]!.generation })
    f.run({ type: 'project.rename', projectId: x.projectId, name: 'Kept' })
    f.rejoin(p, 'collaborator')
    expect(f.reads(p, x.projectId)).toBe(true)
    expect(() => f.run({ type: 'project.rename', projectId: x.projectId, name: 'Mine' }, p)).toThrow('Only the project owner')
  })

  it('leaves the projects of owners who stayed as they were', () => {
    const f = setup(), mine = f.create(c), theirs = f.create(p)
    f.run({ type: 'project.sharing', projectId: mine.projectId, visibility: 'private', memberIds: ['p'] }, c)
    const before = structuredClone(projectOf(f.state, mine.projectId))
    f.run({ type: 'member.remove', userId: 'p' })
    expect(projectOf(f.state, mine.projectId)).toEqual(before)
    expect(f.reads(c, mine.projectId)).toBe(true)
    expect(projectOf(f.state, theirs.projectId).ownerId).not.toBe('p')
  })

  it('tells readers to reload when only its owner changed', () => {
    const f = setup(), x = f.create(p)
    f.run({ type: 'project.sharing', projectId: x.projectId, visibility: 'private', memberIds: ['c'] }, p)
    const before = structuredClone(f.state), after = structuredClone(f.state)
    expect(settleOwners(after)).toEqual([])
    after.people.find(person => person.id === 'p')!.generation = 'p-second'
    before.people.find(person => person.id === 'p')!.generation = 'p-second'
    expect(settleOwners(after)).toEqual([{ projectId: x.projectId, from: 'p', to: 'c' }])
    expect(visibilityChanged(before, after)).toBe(true)
  })
})
