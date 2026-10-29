import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor } from './model.js'
import { touchesFor } from './parts/touches.js'
import { usernameOf, usernames } from './usernames.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'Ken15@autonomous.ai' }
const NOW = Date.parse('2026-10-29T01:00:00.000Z')
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
})

describe('member.username', () => {
  it('gives the owner and each new person their default without storing one', () => {
    const f = fixture()
    f.join(person('peer', 'peer@example.com'))
    f.join(person('peer-2', 'Peer@other.org'))
    expect([f.name('owner'), f.name('peer'), f.name('peer-2')]).toEqual(['ken15', 'peer', 'peer2'])
    expect(f.state.people.map(p => p.username)).toEqual([undefined, undefined, undefined])
  })

  it('sets and clears the person’s own name, lowercased and trimmed', () => {
    const f = fixture()
    f.run({ type: 'member.username', username: '  River.K ' })
    expect(f.state.people[0]!.username).toBe('river.k')
    expect(f.name('owner')).toBe('river.k')
    f.run({ type: 'member.username', username: null })
    expect(f.state.people[0]!.username).toBeUndefined()
    expect(f.name('owner')).toBe('ken15')
  })

  it('refuses a name another person has, chosen or default, ignoring case', () => {
    const f = fixture()
    const peer = person('peer', 'peer@example.com')
    f.join(peer)
    expect(() => f.run({ type: 'member.username', username: 'Peer' })).toThrow(expect.objectContaining({ code: 'USERNAME_TAKEN', status: 409 }))
    f.run({ type: 'member.username', username: 'boss' })
    expect(() => f.run({ type: 'member.username', username: 'BOSS' }, peer)).toThrow(expect.objectContaining({ code: 'USERNAME_TAKEN' }))
    // Their own current name, default or chosen, is no conflict.
    f.run({ type: 'member.username', username: 'peer' }, peer)
    f.run({ type: 'member.username', username: 'boss' })
    expect([f.name('owner'), f.name('peer')]).toEqual(['boss', 'peer'])
  })

  it('refuses a name that would take a later default’s number', () => {
    const f = fixture()
    f.join(person('ken-a', 'ken@example.com'))
    f.join(person('ken-b', 'ken@other.org'))
    expect(f.name('ken-b')).toBe('ken2')
    expect(() => f.run({ type: 'member.username', username: 'ken2' })).toThrow(expect.objectContaining({ code: 'USERNAME_TAKEN' }))
  })

  it('keeps a later person’s numbered name when the name before it is freed by a rename', () => {
    const f = fixture()
    f.join(person('ken-a', 'ken@example.com'))
    f.join(person('ken-b', 'ken@other.org'))
    f.run({ type: 'member.username', username: 'kenny' }, person('ken-a', 'ken@example.com'))
    expect([f.name('ken-a'), f.name('ken-b')]).toEqual(['kenny', 'ken2'])
    expect(f.state.people.find(p => p.id === 'ken-b')!.username).toBe('ken2')
    // Nobody else's default moved, so nothing else was stored.
    expect(f.state.people[0]!.username).toBeUndefined()
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

  it('refuses a malformed name', () => {
    const f = fixture()
    for (const username of ['k', 'a'.repeat(33), 'ken nguyen', '.ken', 'kén', 'ken@x', '-'] as const) {
      expect(() => f.run({ type: 'member.username', username }), username).toThrow()
    }
    expect(f.state.people[0]!.username).toBeUndefined()
  })

  it('is the person’s own: refused for an agent and a viewer', () => {
    const f = fixture()
    const viewer = person('viewer', 'viewer@example.com')
    f.join(viewer, 'viewer')
    expect(() => f.run({ type: 'member.username', username: 'watcher' }, viewer)).toThrow(expect.objectContaining({ code: 'READ_ONLY' }))
    expect(() => f.run({ type: 'member.username', username: 'bot' }, { kind: 'agent', agentId: 'a1', machineOwnerId: 'owner' })).toThrow()
    expect(f.state.people.map(p => p.username)).toEqual([undefined, undefined])
  })

  it('touches every person and the head, so two people choosing one name at once, or a join, retry', () => {
    const f = fixture()
    f.join(person('peer', 'peer@example.com'))
    const before = f.state
    const command: Command = { type: 'member.username', username: 'pilot' }
    const effects = applyCommand(before, owner, command, { now: NOW, operationId: 'op-touch' })
    expect(touchesFor(command, owner, before, effects)).toEqual(expect.arrayContaining([
      { kind: 'member', key: 'owner' }, { kind: 'member', key: 'peer' }, { kind: 'head', key: 'head' },
    ]))
  })
})
