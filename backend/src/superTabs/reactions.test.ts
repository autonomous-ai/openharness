import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor } from './model.js'
import { reactionCounts } from './reactions.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: 1000, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invite = (role: 'viewer' | 'collaborator' = 'collaborator') => {
    const invited = run({ type: 'invite.create', email: peer.email, role, conversationId: 'lead' })
    run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
  }
  const lead = () => state.conversations.find(c => c.id === 'lead')!
  return { run, invite, lead, get state() { return state } }
}
const react = (on: boolean, emoji = 'tada'): Command => ({ type: 'message.react', conversationId: 'lead', messageId: 'm1', emoji, on } as Command)
const target = (reacted: boolean) => ({ reaction: { messageId: 'm1', reacted } })

describe('reactions', () => {
  it('bumps the group only when the reaction changes', () => {
    const f = fixture()
    expect(f.run(react(true), owner, target(false)).result).toMatchObject({ changed: true })
    expect(f.lead().reactionSeq).toBe(1)
    expect(f.run(react(true), owner, target(true)).result).toMatchObject({ changed: false })
    expect(f.run(react(false), owner, target(false)).result).toMatchObject({ changed: false })
    expect(f.lead().reactionSeq).toBe(1)
    f.run(react(false), owner, target(true))
    expect(f.lead().reactionSeq).toBe(2)
  })

  it('refuses a message the store did not find here, an unknown emoji, a viewer and an archived group', () => {
    const f = fixture()
    expect(() => f.run(react(true))).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => f.run(react(true, 'skull'), owner, target(false))).toThrow()
    f.invite('viewer')
    expect(() => f.run(react(true), peer, target(false))).toThrow(expect.objectContaining({ code: 'READ_ONLY' }))
    const group = f.run({ type: 'conversation.create', title: 'Old', brief: 'Done.', checks: [] }).result.conversationId as string
    f.run({ type: 'conversation.archive', conversationId: group, archived: true })
    expect(() => f.run({ type: 'message.react', conversationId: group, messageId: 'm1', emoji: 'tada', on: true }, owner, target(false)))
      .toThrow(expect.objectContaining({ code: 'ARCHIVED' }))
  })

  it('counts each emoji in a fixed order, only from reactors still in the Swarm', () => {
    const f = fixture()
    f.invite()
    const rows = [
      { messageId: 'm1', emoji: 'tada', actorKind: 'person', actorId: 'peer' },
      { messageId: 'm1', emoji: 'thumbs_up', actorKind: 'person', actorId: 'owner' },
      { messageId: 'm1', emoji: 'tada', actorKind: 'person', actorId: 'owner' },
      { messageId: 'm1', emoji: 'tada', actorKind: 'person', actorId: 'left-the-swarm' },
      { messageId: 'm1', emoji: 'heart', actorKind: 'agent', actorId: 'removed-agent' },
      { messageId: 'm2', emoji: 'eyes', actorKind: 'person', actorId: 'owner' },
    ]
    expect(reactionCounts(f.state, rows).get('m1')).toEqual([
      { emoji: 'thumbs_up', count: 1, by: [{ kind: 'person', id: 'owner' }] },
      { emoji: 'tada', count: 2, by: [{ kind: 'person', id: 'peer' }, { kind: 'person', id: 'owner' }] },
    ])
    expect(reactionCounts(f.state, rows).get('m2')).toEqual([{ emoji: 'eyes', count: 1, by: [{ kind: 'person', id: 'owner' }] }])
  })
})
