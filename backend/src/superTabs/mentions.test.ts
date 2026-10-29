import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor } from './model.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const third: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'third', email: 'third@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let next = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { operationId: `op${next++}`, now: 1000,
      contribution: { machineOwnerId: 'owner', contributorId: actor.kind === 'person' ? actor.userId : 'owner' }, ...context })
    state = effects.state
    return effects
  }
  for (const who of [peer, third]) {
    const invited = run({ type: 'invite.create', email: who.email, role: 'collaborator', conversationId: 'lead' })
    run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, who)
  }
  const app = run({ type: 'project.create', name: 'App', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
  const worker = run({ type: 'agent.add', conversationId: app.conversationId, harnessId: 'worker', machineId: 'machine', name: 'Worker', lead: false,
    configuration }).result.agentId as string
  const group = run({ type: 'conversation.create', projectId: app.projectId, title: 'Copy', brief: '', checks: [] }).result.conversationId as string
  const pmChat = run({ type: 'conversation.create', projectId: app.projectId, title: 'peer', brief: '', checks: [],
    audience: { personIds: ['peer'] } }, peer).result.conversationId as string
  const send = (conversationId: string, mentions: string[], actor: Actor = owner) => run({ type: 'message.send', conversationId,
    text: 'Please look.', replyTo: null, recipientIds: [], mentions }, actor).messages.at(-1)!
  return { run, send, app, worker, group, pmChat, get state() { return state } }
}

describe('people tagging people', () => {
  it('tags a person who can read the conversation', () => {
    const f = fixture()
    expect(f.send(f.group, ['peer', 'third']).mentions).toEqual(['peer', 'third'])
    expect(f.send(f.group, ['owner'], peer).mentions).toEqual(['owner'])
  })

  it('drops the author’s own tag', () => {
    const f = fixture()
    expect(f.send(f.group, ['owner', 'peer']).mentions).toEqual(['peer'])
  })

  it('refuses a tag of someone who cannot read the conversation, or is not in the Swarm', () => {
    const f = fixture()
    expect(() => f.send(f.pmChat, ['third'], peer)).toThrow(expect.objectContaining({ code: 'INVALID_MENTION' }))
    expect(() => f.send(f.group, ['stranger'])).toThrow(expect.objectContaining({ code: 'INVALID_MENTION' }))
  })

  it('refuses tags in the Leads conversation', () => {
    const f = fixture()
    const leads = f.state.leadsConversationId!
    expect(() => f.send(leads, ['peer'])).toThrow(expect.objectContaining({ code: 'MENTION_FORBIDDEN' }))
  })

  it('still lets only a project’s Lead among agents tag people', () => {
    const f = fixture()
    expect(() => f.send(f.app.conversationId, ['peer'], { kind: 'agent', agentId: f.worker, machineOwnerId: 'owner' }))
      .toThrow(expect.objectContaining({ code: 'MENTION_FORBIDDEN' }))
  })
})
