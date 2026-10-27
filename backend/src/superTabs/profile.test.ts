import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, visibleState, type Actor } from './model.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const stranger: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'stranger', email: 'stranger@example.com' }
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

describe('status line', () => {
  it('sets and clears the person’s own status', () => {
    const f = fixture()
    f.run({ type: 'member.status', status: { text: '  Out until 2pm ', emoji: '🌴', until: '2026-10-27T14:00:00.000Z' } })
    expect(f.member('owner')!.status).toEqual({ text: 'Out until 2pm', emoji: '🌴', until: '2026-10-27T14:00:00.000Z' })
    f.run({ type: 'member.status', status: { text: 'Focus' } })
    expect(f.member('owner')!.status).toEqual({ text: 'Focus', emoji: null, until: null })
    f.run({ type: 'member.status', status: null })
    expect(f.member('owner')!.status).toBeUndefined()
  })

  it('refuses a status that is too long, unprintable, already over or set as an agent', () => {
    const f = fixture()
    expect(() => f.run({ type: 'member.status', status: { text: 'x'.repeat(81) } })).toThrow()
    expect(() => f.run({ type: 'member.status', status: { text: 'Focus‮' } })).toThrow()
    expect(() => f.run({ type: 'member.status', status: { text: 'Lunch', emoji: '💣' } } as unknown as Command)).toThrow()
    expect(() => f.run({ type: 'member.status', status: { text: 'Lunch', until: '2026-10-27T08:59:59.000Z' } }))
      .toThrow(expect.objectContaining({ code: 'STATUS_EXPIRED' }))
    expect(() => f.run({ type: 'member.status', status: { text: 'Lunch' } }, { kind: 'agent', agentId: 'a1', machineOwnerId: 'owner' })).toThrow()
    expect(f.member('owner')!.status).toBeUndefined()
  })

  it('keeps a credential out of the status', () => {
    const f = fixture()
    const effects = f.run({ type: 'member.status', status: { text: 'key ghp_R4nd0mT0k3nV4lu3Xq9Lp2Zs8Wd5Yb7Hc1Jk6Mn' } })
    expect(f.member('owner')!.status!.text).not.toContain('ghp_R4nd0m')
    expect(effects.result.credentialsRemoved).toBeTruthy()
  })

  it('is refused for a viewer and read only by members', () => {
    const f = fixture()
    f.invite('viewer')
    expect(() => f.run({ type: 'member.status', status: { text: 'Coffee', emoji: '☕' } }, peer))
      .toThrow(expect.objectContaining({ code: 'READ_ONLY' }))
    f.run({ type: 'member.status', status: { text: 'Coffee', emoji: '☕' } })
    expect(visibleState(f.state, peer).people.find(p => p.id === 'owner')!.status!.text).toBe('Coffee')
    expect(() => visibleState(f.state, stranger)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  })
})
