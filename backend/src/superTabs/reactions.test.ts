import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor } from './model.js'
import { reactionCounts } from './reactions.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const asAgent = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'owner' })

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
  const agent = (conversationId: string, name: string) => run({ type: 'agent.add', conversationId, machineId: 'machine', harnessId: name,
    name, configuration, lead: false }, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).result.agentId as string
  return { run, invite, lead, agent, get state() { return state } }
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

  it('lets an agent react in a conversation it is in, as a person does, with ✅ for done', () => {
    const f = fixture()
    const builder = f.agent('lead', 'Builder')
    for (const emoji of ['eyes', 'check', 'rocket']) {
      expect(f.run(react(true, emoji), asAgent(builder), target(false)).result, emoji).toMatchObject({ changed: true })
    }
    expect(f.lead().reactionSeq).toBe(3)
  })

  it('refuses an agent outside the conversation, so it cannot mark a message it does not take part in', () => {
    const f = fixture()
    const group = f.run({ type: 'conversation.create', title: 'Side', brief: 'Side work.', checks: [] }).result.conversationId as string
    const outsider = f.agent(group, 'Outsider')
    expect(() => f.run(react(true, 'eyes'), asAgent(outsider), target(false))).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(f.lead().reactionSeq).toBeUndefined()
  })

  it('shows an agent\'s progress in its order: 👀 started, ✅ done, 🚀 merged', () => {
    const f = fixture()
    const builder = f.agent('lead', 'Builder')
    const rows = ['rocket', 'check', 'eyes'].map(emoji => ({ messageId: 'm1', emoji, actorKind: 'agent', actorId: builder }))
    expect(reactionCounts(f.state, rows).get('m1')!.map(r => r.emoji)).toEqual(['eyes', 'check', 'rocket'])
  })
})
