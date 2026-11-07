import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, SuperTabError, type Actor } from './model.js'

// Task #4623 (anh Dee, 11-07 18:55): a person sees every question for them, from every project, in one place, their Decisions.
// Faye's quiet-hours question in lamp was a chat tag; a tagged question in a chat is refused, naming decision.ask.

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const NOW = 1_000_000

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let next = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { operationId: `op${next++}`, now: NOW,
      contribution: { machineOwnerId: 'owner', contributorId: actor.kind === 'person' ? actor.userId : 'owner' }, ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
  const pm = run({ type: 'agent.add', conversationId: 'lead', harnessId: 'pm', machineId: 'machine', name: 'River', lead: true, configuration }).result.agentId as string
  const asPm: Actor = { kind: 'agent', agentId: pm, machineOwnerId: 'owner' }
  const post = (text: string, actor: Actor = asPm, extra: Record<string, unknown> = {}, context: Partial<CommandContext> = {}) =>
    run({ type: 'message.send', conversationId: 'lead', text, replyTo: null, recipientIds: [], ...extra } as Command, actor, context)
  return { run, pm, asPm, post, get state() { return state } }
}

const code = (act: () => unknown) => {
  try { act() } catch (error) { return [(error as SuperTabError).code, (error as Error).message] as const }
  return ['passed', ''] as const
}

describe('a question for a person', () => {
  it('is refused as a chat tag from a Lead, naming decision.ask', () => {
    const f = fixture()
    const [refused, words] = code(() => f.post('Quiet hours for the release: 22:00 or 23:00?', f.asPm, { mentions: ['peer'] }))
    expect(refused).toBe('QUESTION_FOR_PERSON')
    expect(words).toContain('decision.ask')
  })

  it('is refused when the tag is in the words too', () => {
    const f = fixture()
    expect(code(() => f.post('@peer which quiet hours do you want?'))[0]).toBe('QUESTION_FOR_PERSON')
  })

  it('leaves a tag that asks nothing, and a link with a query', () => {
    const f = fixture()
    expect(code(() => f.post('Shipped the quiet hours, see https://example.com/notes?id=4', f.asPm, { mentions: ['peer'] }))[0]).toBe('passed')
  })

  it('leaves a question that tags nobody', () => {
    const f = fixture()
    expect(code(() => f.post('Does anyone know why the lamp build is slow?'))[0]).toBe('passed')
  })

  it('leaves a person’s own question to another person', () => {
    const f = fixture()
    expect(code(() => f.post('@owner can you look at the lamp build?', peer))[0]).toBe('passed')
  })

  it('leaves a reply in a thread the person started: a conversation with them goes on', () => {
    const f = fixture()
    const asked = f.post('Can we have quiet hours?', peer).result.messageId as string
    const reply = { id: asked, conversationId: 'lead', author: { kind: 'person' as const, id: 'peer', name: peer.email, membershipGeneration: f.state.people.find(p => p.id === 'peer')!.generation },
      source: null, replyTo: null }
    expect(code(() => f.post('Which hours do you mean?', f.asPm, { replyTo: asked, mentions: ['peer'] }, { reply } as Partial<CommandContext>))[0]).toBe('passed')
  })
})
