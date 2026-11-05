import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor } from './model.js'
import type { MessageChangeTarget } from './messageEdits.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }

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
  const agent = () => run({ type: 'agent.add', conversationId: 'lead', machineId: 'machine', harnessId: 'h1', name: 'Worker', configuration,
    lead: false }, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).result.agentId as string
  const lead = () => state.conversations.find(c => c.id === 'lead')!
  return { run, invite, agent, lead }
}

const edit = (text = 'Fixed text'): Command => commandSchema.parse({ type: 'message.edit', conversationId: 'lead', messageId: 'm1', text })
const remove = (): Command => commandSchema.parse({ type: 'message.delete', conversationId: 'lead', messageId: 'm1' })
const target = (extra: Partial<MessageChangeTarget> = {}): Partial<CommandContext> => ({ messageChange: { messageId: 'm1',
  author: { kind: 'person', id: 'owner' }, plain: true, deleted: false, hasFiles: false, hasReplies: false, text: 'Old text', sequence: 1, ...extra } })

describe('message edits', () => {
  it('lets the author edit their own post and bumps the group only on a change', () => {
    const f = fixture()
    expect(f.run(edit(), owner, target()).result).toMatchObject({ changed: true })
    expect(f.lead().reactionSeq).toBe(1)
    expect(f.run(edit('Old text'), owner, target()).result).toMatchObject({ changed: false })
    expect(f.lead().reactionSeq).toBe(1)
  })

  it('lets the author delete their own post, kept as deleted while it has replies', () => {
    const f = fixture()
    expect(f.run(remove(), owner, target()).result).toMatchObject({ changed: true, kept: false })
    expect(f.run(remove(), owner, target({ hasReplies: true })).result).toMatchObject({ changed: true, kept: true })
    expect(f.lead().reactionSeq).toBe(2)
  })

  it('only the author: never another person, a viewer or an agent', () => {
    const f = fixture()
    f.invite()
    for (const command of [edit(), remove()]) {
      expect(() => f.run(command, peer, target())).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    }
    const worker = f.agent()
    const asWorker: Actor = { kind: 'agent', agentId: worker, machineOwnerId: 'owner' }
    for (const command of [edit(), remove()]) {
      // The owner's own agent on the owner's own machine cannot change the owner's post either.
      expect(() => f.run(command, asWorker, target())).toThrow(expect.objectContaining({ status: 403 }))
      // Nor its own post: agents' messages are never edited.
      expect(() => f.run(command, asWorker, target({ author: { kind: 'agent', id: worker } }))).toThrow(expect.objectContaining({ status: 403 }))
    }
    expect(f.lead().reactionSeq ?? 0).toBe(0)
  })

  it.each([false, true])('lets only the attributed owner delete their Buddy proposal, with replies: %s', hasReplies => {
    const f = fixture()
    f.invite()
    const proposalTarget = { ...target({ plain: false, author: { kind: 'person', id: 'peer' }, hasReplies }).messageChange!, proposalOwnerId: 'peer' }
    // Even the Swarm owner cannot delete another person's proposal.
    expect(() => f.run(remove(), owner, { messageChange: proposalTarget })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => f.run(edit(), peer, { messageChange: proposalTarget })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    const asAgent: Actor = { kind: 'agent', agentId: f.agent(), machineOwnerId: 'peer' }
    expect(() => f.run(remove(), asAgent, { messageChange: proposalTarget })).toThrow(expect.objectContaining({ status: 403 }))
    expect(f.run(remove(), peer, { messageChange: proposalTarget }).result).toMatchObject({ changed: true, kept: hasReplies })
    expect(f.lead().reactionSeq).toBe(1)
  })

  it('refuses proposal deletion when the source owner and attributed person disagree', () => {
    const f = fixture()
    f.invite()
    const messageChange = { ...target({ plain: false }).messageChange!, proposalOwnerId: 'peer' }
    for (const actor of [owner, peer]) expect(() => f.run(remove(), actor, { messageChange }))
      .toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(f.lead().reactionSeq ?? 0).toBe(0)
  })

  it('keeps deleted proposals deleted and never makes a system message deletable', () => {
    const f = fixture()
    const messageChange = { ...target({ plain: false, deleted: true }).messageChange!, proposalOwnerId: 'owner' }
    expect(() => f.run(remove(), owner, { messageChange })).toThrow(expect.objectContaining({ code: 'MESSAGE_DELETED' }))
    expect(() => f.run(remove(), owner, target({ plain: false }))).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  })

  it('refuses a viewer, a system row, a deleted message and a message the store did not find', () => {
    const f = fixture()
    for (const command of [edit(), remove()]) {
      expect(() => f.run(command)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
      expect(() => f.run(command, owner, target({ messageId: 'other' }))).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
      expect(() => f.run(command, owner, target({ plain: false }))).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
      expect(() => f.run(command, owner, target({ deleted: true }))).toThrow(expect.objectContaining({ code: 'MESSAGE_DELETED' }))
    }
    f.invite('viewer')
    expect(() => f.run(edit(), peer, target({ author: { kind: 'person', id: 'peer' } }))).toThrow(expect.objectContaining({ code: 'READ_ONLY' }))
  })

  it('refuses empty text unless the message has files, and an archived group', () => {
    const f = fixture()
    expect(() => f.run(edit('   '), owner, target())).toThrow(expect.objectContaining({ code: 'INVALID_MESSAGE' }))
    expect(f.run(edit(''), owner, target({ hasFiles: true })).result).toMatchObject({ changed: true })
    const group = f.run({ type: 'conversation.create', title: 'Old', brief: 'Done.', checks: [] }).result.conversationId as string
    f.run({ type: 'conversation.archive', conversationId: group, archived: true })
    expect(() => f.run(commandSchema.parse({ type: 'message.edit', conversationId: group, messageId: 'm1', text: 'x' }), owner, target()))
      .toThrow(expect.objectContaining({ code: 'ARCHIVED' }))
  })

  it('removes a credential edited into a message, as a send does, and tells the author', () => {
    const f = fixture()
    // Built at run time so no token-shaped literal sits in the source.
    const token = ['ghp', 'Q7mZ2xK9pL4vB8nR1tY6wC3sD5fG0hJ2kM4n'].join('_')
    const effects = f.run(edit(`Use ${token} for the deploy`), owner, target())
    expect(effects.result).toMatchObject({ changed: true, credentialNotice: expect.stringContaining('Removed a credential') })
    expect(effects.messageEdit).toEqual({ messageId: 'm1', text: 'Use [credential removed] for the deploy' })
    expect(JSON.stringify(effects)).not.toContain(token)
  })
})
