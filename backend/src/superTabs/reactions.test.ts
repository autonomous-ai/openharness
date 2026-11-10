import { describe, expect, it } from 'vitest'
import { applyCommand, REACTIONS_GONE, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor } from './model.js'

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
const target = { reaction: { messageId: 'm1' } }

// Reactions are gone (anh Dee, 2026-11-09): nothing stores, counts or shows one (reactions.ts).
describe('reactions', () => {
  it('does nothing for a person\'s: answered as ignored, nothing moves and nothing settles', () => {
    const f = fixture()
    for (const on of [true, false]) {
      const effects = f.run(react(on), owner, target)
      expect(effects.result).toMatchObject({ changed: false, ignored: true, note: REACTIONS_GONE })
      expect(effects.settles).toBeUndefined()
    }
    expect(f.lead().reactionSeq).toBeUndefined()
  })

  // Task #3391: an agent acknowledges with a reaction rather than an "on it" post, and that settles its delivery of the message,
  // as an answer does (the store closes the rows). It is kept nowhere and shown to nobody.
  it('settles an agent\'s delivery with its reaction, whatever the emoji, and moves nothing a reader polls', () => {
    const f = fixture()
    const builder = f.agent('lead', 'Builder')
    // A member stored there before the project chat held only its coordinator (#2207).
    f.lead().agentIds.push(builder)
    for (const emoji of ['eyes', 'check', 'thumbs_up']) {
      const effects = f.run(react(true, emoji), asAgent(builder), target)
      expect(effects.settles, emoji).toEqual({ messageId: 'm1', agentId: builder })
      expect(effects.result, emoji).toMatchObject({ changed: false })
    }
    expect(f.run(react(false, 'eyes'), asAgent(builder), target).settles).toBeUndefined()
    expect(f.lead().reactionSeq).toBeUndefined()
  })

  it('refuses an agent\'s reaction to a message the store did not find, an unknown emoji, and an agent outside the conversation', () => {
    const f = fixture()
    const builder = f.agent('lead', 'Builder')
    f.lead().agentIds.push(builder)
    expect(() => f.run(react(true, 'eyes'), asAgent(builder))).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => f.run(react(true, 'skull'), asAgent(builder), target)).toThrow()
    const group = f.run({ type: 'conversation.create', title: 'Side', brief: 'Side work.', checks: [] }).result.conversationId as string
    const outsider = f.agent(group, 'Outsider')
    expect(() => f.run(react(true, 'eyes'), asAgent(outsider), target)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  })
})
