import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor } from './model.js'
import { split } from './parts/shape.js'
import { touchesFor } from './parts/touches.js'
import { readerView } from './read/views.js'
import { MAX_NAME_LENGTH, shownNameOf, writtenNameOf } from './personNames.js'
import { usernameOf } from './usernames.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'Ken15@autonomous.ai' }
const NOW = Date.parse('2026-11-03T10:00:00.000Z')
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const person = (id: string, email: string) => ({ kind: 'person', userId: id, email }) as Extract<Actor, { kind: 'person' }>
const relay = person('relay', 'wkpnjjhbnm@privaterelay.appleid.com')
const peer = person('peer', 'dee@autonomous.ai')

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
  join(relay)
  join(peer)
  const name = (id: string) => state.people.find(p => p.id === id)!.name
  const shown = (id: string) => shownNameOf(state, id)
  const setName = (value: string | null, actor: Actor = relay) => run({ type: 'member.name', name: value }, actor)
  return { run, join, name, shown, setName, get state() { return state } }
}

describe('member.name', () => {
  it('shows the username until a person sets a name, and again once they clear it', () => {
    const f = fixture()
    expect(f.shown('relay')).toBe('wkpnjjhbnm')
    f.setName('Minh Nguyen')
    expect(f.name('relay')).toBe('Minh Nguyen')
    expect(f.shown('relay')).toBe('Minh Nguyen')
    f.setName(null)
    expect(f.name('relay')).toBeUndefined()
    expect(f.shown('relay')).toBe('wkpnjjhbnm')
  })

  it('trims the name and keeps one space between its words', () => {
    const f = fixture()
    f.setName('  Minh \t  Nguyen  ')
    expect(f.name('relay')).toBe('Minh Nguyen')
  })

  it(`refuses an empty name, one over ${MAX_NAME_LENGTH} characters, and hidden characters`, () => {
    const f = fixture()
    for (const name of ['', '   ', 'a'.repeat(MAX_NAME_LENGTH + 1), 'Minh‮Nguyen', 'Mi​nh', 'Minh\nNguyen', 'Minh Nguyen']) {
      expect(() => f.setName(name), JSON.stringify(name)).toThrow(expect.objectContaining({ code: 'INVALID_NAME', status: 400 }))
    }
    // Characters, not UTF-16 units: forty letters with accents or an emoji still fit.
    f.setName('é'.repeat(MAX_NAME_LENGTH - 1) + '🦊')
    expect([...f.name('relay')!]).toHaveLength(MAX_NAME_LENGTH)
  })

  it('refuses another member’s name, username or email, whatever its case, width, spacing or @', () => {
    const f = fixture()
    f.setName('Dee Tran', peer)
    for (const name of ['dee tran', 'DEETRAN', 'Ｄｅｅ Ｔｒａｎ', 'dee', '@Dee', 'D E E', 'dee@autonomous.ai', 'DEE@AUTONOMOUS.AI', 'ken15', '@ken15']) {
      expect(() => f.setName(name), name).toThrow(expect.objectContaining({ code: 'NAME_TAKEN', status: 409 }))
    }
    expect(f.name('relay')).toBeUndefined()
  })

  it('allows one’s own username or email, and a name close to but not another’s', () => {
    const f = fixture()
    f.setName('WKPNJJHBNM')
    expect(f.name('relay')).toBe('WKPNJJHBNM')
    f.setName('Dee’s friend')
    expect(f.name('relay')).toBe('Dee’s friend')
  })

  it('refuses an agent’s name the person can see', () => {
    const f = fixture()
    f.run({ type: 'agent.add', conversationId: 'lead', harnessId: 'pm', machineId: 'machine', name: 'River', configuration, lead: true },
      owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
    expect(() => f.setName('river')).toThrow(expect.objectContaining({ code: 'NAME_TAKEN' }))
  })

  it('changes only the person’s own name: an agent, or someone outside the Swarm, is refused', () => {
    const f = fixture()
    const lead = f.run({ type: 'agent.add', conversationId: 'lead', harnessId: 'pm', machineId: 'machine', name: 'River', configuration, lead: true },
      owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).result.agentId as string
    expect(() => f.setName('Bot', { kind: 'agent', agentId: lead, machineOwnerId: 'owner' })).toThrow(expect.objectContaining({ code: 'HUMAN_REQUIRED' }))
    expect(() => f.setName('Stranger', person('stranger', 'stranger@example.com'))).toThrow()
    // The command names no one: it sets the actor's own, and nobody else's.
    expect(() => f.run({ type: 'member.name', name: 'Minh', userId: 'relay' } as unknown as Command, owner)).toThrow()
    f.setName('Owner name', owner)
    expect([f.name('owner'), f.name('relay'), f.name('peer')]).toEqual(['Owner name', undefined, undefined])
  })

  it('lets a viewer set their own name, though they write nothing else', () => {
    const f = fixture()
    const viewer = person('viewer', 'viewer@example.com')
    f.join(viewer, 'viewer')
    f.setName('Watcher', viewer)
    expect(f.name('viewer')).toBe('Watcher')
    expect(() => f.run({ type: 'member.status', status: { text: 'Hi' } }, viewer)).toThrow(expect.objectContaining({ code: 'READ_ONLY' }))
  })

  it('refuses a username equal to another member’s name', () => {
    const f = fixture()
    f.setName('Minh')
    expect(() => f.run({ type: 'member.username', username: 'minh' }, peer)).toThrow(expect.objectContaining({ code: 'USERNAME_TAKEN' }))
    // One's own name is no conflict.
    f.run({ type: 'member.username', username: 'minh' }, relay)
    expect(f.state.people.find(p => p.id === 'relay')!.username).toBe('minh')
  })

  it('reaches members with the rest of the person, and only members', () => {
    const f = fixture()
    f.setName('Minh Nguyen')
    const view = readerView(split(f.state, { tabId: 'tab', version: 1, now: NOW }), peer, NOW, { teamMachines: [] })
    expect(view.parts.members.find(m => m.key === 'relay')!.data.name).toBe('Minh Nguyen')
    expect(visibleState(f.state, peer, NOW).people.find(p => p.id === 'relay')!.name).toBe('Minh Nguyen')
    expect(() => visibleState(f.state, person('stranger', 'stranger@example.com'), NOW)).toThrow()
  })

  it('touches every person and the head, so two people choosing one name at once retry', () => {
    const f = fixture()
    const before = f.state
    const command: Command = { type: 'member.name', name: 'Pilot' }
    const effects = applyCommand(before, relay, command, { now: NOW, operationId: 'op-touch' })
    expect(touchesFor(command, relay, before, effects)).toEqual(expect.arrayContaining([
      { kind: 'member', key: 'owner' }, { kind: 'member', key: 'relay' }, { kind: 'member', key: 'peer' }, { kind: 'head', key: 'head' },
    ]))
  })

  it('refuses a role’s or the Swarm’s own name, numbered too (review 1 of #2794)', () => {
    const f = fixture()
    for (const name of ['Product Manager', 'PM', 'pm 2', 'Lead', 'Engineer', 'Reviewer', 'Tester', 'Harness', 'System', 'Admin',
      'Everyone', 'Swarm', 'You', 'Someone']) {
      expect(() => f.setName(name), name).toThrow(expect.objectContaining({ code: 'NAME_RESERVED', status: 400 }))
    }
    f.setName('Leading Light')
    expect(f.name('relay')).toBe('Leading Light')
  })

  it('numbers a later joiner’s default around a name someone set, never the person’s own (review 1 of #2794)', () => {
    const f = fixture()
    f.setName('Bob')
    f.join(person('bob', 'bob@example.com'))
    expect(usernameOf(f.state, 'bob')).toBe('bob2')
    // One's own name never moves one's own default.
    f.setName('WKPNJJHBNM')
    expect(usernameOf(f.state, 'relay')).toBe('wkpnjjhbnm')
  })

  it('writes a name into server-written text as plain words, never Markdown (review 1 of #2794)', () => {
    const f = fixture()
    f.setName('[Ken](https://ev.il) *x*')
    expect(writtenNameOf(f.state, 'relay')).toBe('\\[Ken\\]\\(https://ev.il\\) \\*x\\*')
    // A username is written as it is today.
    expect(writtenNameOf(f.state, 'peer')).toBe('dee')
  })
})
