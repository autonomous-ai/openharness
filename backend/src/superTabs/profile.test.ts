import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor } from './model.js'
import { personView } from './profile.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const NOW = Date.parse('2026-10-27T09:00:00.000Z')

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invite = (role: 'viewer' | 'collaborator' = 'collaborator') => {
    const invited = run({ type: 'invite.create', email: peer.email, role, conversationId: 'lead' })
    run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
  }
  const member = (id: string) => state.people.find(p => p.id === id)
  return { run, invite, member, get state() { return state } }
}

describe('what readers get of a person', () => {
  // Their name follows their account (personNames.ts nameFromAccount): the one they chose before is kept and read by nobody.
  it('leaves out the name a person chose before their name followed their account', () => {
    const f = fixture()
    f.invite()
    Object.assign(f.member('owner')!, { name: 'Ken Tran', chosenName: 'Ken (ops)', nameFollowsAccount: true })
    const seen = visibleState(f.state, peer).people.find(p => p.id === 'owner')!
    expect(seen.name).toBe('Ken Tran')
    expect(seen).not.toHaveProperty('chosenName')
    expect(seen).not.toHaveProperty('nameFollowsAccount')
  })

  it('copies nobody who has neither stored, as a read always gave them', () => {
    const plain = { id: 'a', email: 'a@example.com', role: 'owner' as const, generation: 'g' }
    expect(personView(plain)).toBe(plain)
  })
})
