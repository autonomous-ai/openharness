import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor } from './model.js'
import { split } from './parts/shape.js'
import { changesFor } from './read/changes.js'
import { readerView } from './read/views.js'
import { usernameOf, usernames } from './usernames.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'Ken15@autonomous.ai' }
const NOW = Date.parse('2026-10-29T01:00:00.000Z')
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const person = (id: string, email: string) => ({ kind: 'person', userId: id, email }) as Extract<Actor, { kind: 'person' }>

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const join = (who: Extract<Actor, { kind: 'person' }>, role: 'viewer' | 'collaborator' = 'collaborator') => {
    const invited = run({ type: 'invite.create', email: who.email, role, conversationId: 'lead' })
    run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, who)
  }
  const name = (id: string) => usernameOf(state, id)
  return { run, join, name, get state() { return state } }
}

// The same cases desktop/test/super_tab_usernames_test.dart checks: both sides work out defaults by this one rule.
describe('default usernames', () => {
  it('is the lowercased email prefix, numbered by join order when two share one', () => {
    expect(usernames([
      { id: 'a', email: 'Ken@autonomous.ai' },
      { id: 'b', email: 'ken@example.com' },
      { id: 'c', email: 'tony@autonomous.ai' },
      { id: 'd', email: 'KEN@other.org' },
    ])).toEqual(new Map([['a', 'ken'], ['b', 'ken2'], ['c', 'tony'], ['d', 'ken3']]))
  })

  it('keeps a chosen name and numbers a default around it', () => {
    expect(usernames([
      { id: 'a', email: 'dee@autonomous.ai', username: 'ken' },
      { id: 'b', email: 'ken@autonomous.ai' },
      { id: 'c', email: 'diego@autonomous.ai' },
    ])).toEqual(new Map([['a', 'ken'], ['b', 'ken2'], ['c', 'diego']]))
  })

  it('makes a usable name of a prefix with other characters, or too short', () => {
    expect(usernames([
      { id: 'a', email: 'pham.ngoc+swarm@gmail.com' },
      { id: 'b', email: 'x@example.com' },
      { id: 'c', email: '__@example.com' },
      { id: 'd', email: `${'a'.repeat(40)}@example.com` },
    ])).toEqual(new Map([['a', 'pham.ngocswarm'], ['b', 'x1'], ['c', 'user'], ['d', 'a'.repeat(30)]]))
  })

  it('never ends a default name with a dot or puts two in a row, so @name tags them', () => {
    expect(usernames([
      { id: 'a', email: `${'a'.repeat(29)}.b@example.com` },
      { id: 'b', email: 'ken..nguyen@example.com' },
      { id: 'c', email: 'dee.@example.com' },
      { id: 'd', email: 'x.@example.com' },
    ])).toEqual(new Map([['a', 'a'.repeat(29)], ['b', 'ken.nguyen'], ['c', 'dee'], ['d', 'x1']]))
  })
})

describe('usernames in a Swarm', () => {
  it('gives the owner and each new person their default without storing one', () => {
    const f = fixture()
    f.join(person('peer', 'peer@example.com'))
    f.join(person('peer-2', 'Peer@other.org'))
    expect([f.name('owner'), f.name('peer'), f.name('peer-2')]).toEqual(['ken15', 'peer', 'peer2'])
    expect(f.state.people.map(p => p.username)).toEqual([undefined, undefined, undefined])
  })

  it('keeps a later person’s numbered name when the person before them leaves', () => {
    const f = fixture()
    const first = person('ken-a', 'ken@example.com')
    f.join(first)
    f.join(person('ken-b', 'ken@other.org'))
    f.run({ type: 'member.remove', userId: 'ken-a' }, first)
    expect(f.name('ken-b')).toBe('ken2')
    expect(f.state.people.find(p => p.id === 'ken-b')!.username).toBe('ken2')
  })

  it('never gives a person an agent’s name: a default is numbered', () => {
    const f = fixture()
    f.run({ type: 'agent.add', conversationId: 'lead', harnessId: 'pm', machineId: 'machine', name: 'River', configuration, lead: true },
      owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
    f.join(person('river', 'River@autonomous.ai'))
    expect(f.name('river')).toBe('river2')
    // An automatic agent name counts too.
    const nova = f.run({ type: 'agent.add', conversationId: 'lead', harnessId: 'builder', machineId: 'machine', name: 'Builder', configuration,
      lead: false }, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).result.agentId as string
    const shown = f.state.agents.find(a => a.id === nova)!.displayName!
    f.join(person('nova', `${shown.toLowerCase()}@example.com`))
    expect(f.name('nova')).toBe(`${shown.toLowerCase()}2`)
  })

  /** A Swarm with `peer`, a private project's Lead `Hush` that only the owner reads, and the owner's Buddy `Pal`. */
  function hidden() {
    const f = fixture()
    f.join(person('peer', 'peer@example.com'))
    const secret = f.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).result as { conversationId: string }
    f.run({ type: 'agent.add', conversationId: secret.conversationId, harnessId: 'hidden', machineId: 'machine', name: 'Hush', configuration,
      lead: true }, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
    const generation = f.state.people[0]!.generation
    f.state.agents.push({ id: 'buddy', machineId: 'machine', harnessId: 'buddy-harness', machineOwnerId: 'owner', contributorId: 'owner',
      membershipGeneration: generation, name: 'Pal', configuration, buddyOf: { personId: 'owner', generation } })
    return f
  }

  it('reads a Swarm whose agent’s project is gone: it counts for nobody', () => {
    const f = fixture()
    f.state.agents.push({ id: 'stray', projectId: 'removed', machineId: 'machine', harnessId: 'h', machineOwnerId: 'owner', contributorId: 'owner',
      membershipGeneration: 'g', name: 'Stray', configuration })
    expect(f.name('owner')).toBe('ken15')
    f.join(person('stray', 'stray@example.com'))
    expect(f.name('stray')).toBe('stray')
  })

  it('does not number a default around an agent some members cannot see, or a Buddy', () => {
    const f = hidden()
    f.join(person('hush', 'hush@example.com'))
    f.join(person('pal', 'pal@example.com'))
    expect([f.name('hush'), f.name('pal')]).toEqual(['hush', 'pal'])
  })

  it('keeps a person’s name when an agent named like them arrives later', () => {
    const f = fixture()
    f.join(person('river', 'river@autonomous.ai'))
    expect(f.name('river')).toBe('river')
    f.run({ type: 'agent.add', conversationId: 'lead', harnessId: 'pm', machineId: 'machine', name: 'River', configuration, lead: true },
      owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
    expect(f.name('river')).toBe('river')
  })

  it('reaches a Buddy as each person’s username, beside its own read limits (#2115)', () => {
    const f = fixture()
    f.join(person('peer', 'ken@example.com'))
    f.run({ type: 'agent.add', conversationId: 'lead', harnessId: 'pm', machineId: 'machine', name: 'River', configuration, lead: true },
      owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
    const generation = f.state.people[0]!.generation
    f.state.agents.push({ id: 'buddy', projectId: 'lead', machineId: 'machine', harnessId: 'buddy-harness', machineOwnerId: 'owner',
      contributorId: 'owner', membershipGeneration: generation, name: 'Pal', configuration, buddyOf: { personId: 'owner', generation } })
    const view = readerView(split(f.state, { tabId: 'tab', version: 1, now: NOW }), { kind: 'agent', agentId: 'buddy', machineOwnerId: 'owner' },
      NOW, { teamMachines: [] })
    expect(Object.fromEntries(view.parts.members.map(m => [m.key, m.data.username]))).toEqual({ owner: 'ken15', peer: 'ken' })
    // Its person's machines stay out of what it reads.
    expect(view.parts.agents.map(a => a.data.machineId)).not.toContain('machine')
  })

  it('reaches readers as each person’s username whatever order the members are read in', () => {
    const f = fixture()
    f.join(person('earlier', 'ken@example.com'))
    f.join(person('rejoined', 'ken@other.org'))
    const parts = split(f.state, { tabId: 'tab', version: 1, now: NOW })
    // Member parts load in no fixed order (parts/load.ts); their ordinals keep the join order.
    parts.members = [parts.members[0]!, parts.members[2]!, parts.members[1]!]
    const view = readerView(parts, owner, NOW, { teamMachines: [] })
    expect(Object.fromEntries(view.parts.members.map(m => [m.key, m.data.username])))
      .toEqual({ owner: 'ken15', earlier: 'ken', rejoined: 'ken2' })
    // So do changes, which send the member as the reader's view has it.
    const changed = changesFor(view, [parts.members.find(m => m.key === 'rejoined')!], owner)
    expect(changed.members.map(m => ('data' in m ? m.data.username : null))).toEqual(['ken2'])
    // And a whole-state read.
    expect(visibleState(f.state, owner, NOW).people.map(p => p.username)).toEqual(['ken15', 'ken', 'ken2'])
  })
})
