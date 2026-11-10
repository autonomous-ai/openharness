import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration, type CommandEffects } from './model.js'
import { TASK_LINE_KIND } from './taskLine.js'
import { storedAssignment } from './storedWork.test-support.js'

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'dee@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const PR = 'https://github.com/example/app/pull/7'

function fixture() {
  let state = createSuperTab('tab', 'Office', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: 1000 + sequence, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const add = (name: string, group: string, lead = false) => run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId: name,
    name, configuration: config, lead }, owner, { contribution: { machineOwnerId: 'host-owner', contributorId: 'owner' } }).result.agentId as string
  const pm = add('River', 'lead', true)
  const as = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: 'host-owner' })
  /** A person's own top-level message in [chat], as the store loads it for a request (commands.ts requestOf). */
  const request = (id = 'ask', conversationId = 'lead') => ({ id, conversationId, replyTo: null, source: null,
    author: { kind: 'person' as const, id: 'owner', name: owner.email, membershipGeneration: state.people[0]!.generation } })
  /** A task the PM opens for the owner's message [ask]: its thread is the task's (taskLine.ts). */
  const group = (title = 'Offline drafts', extra: Record<string, unknown> = {}, ask = 'ask') => run({ type: 'conversation.create', title,
    brief: 'Keep drafts.', checks: [{ description: 'Done', independent: false }], priority: 'P2', requestMessageId: ask, ...extra } as Command, as(pm), { request: request(ask) } as Partial<CommandContext>)
    .result.conversationId as string
  const task = (id: string) => state.conversations.find(c => c.id === id)!
  const lines = (effects: CommandEffects) => effects.messages.filter(m => m.source?.kind === TASK_LINE_KIND)
  return { run, add, as, group, request, task, lines, pm, get state() { return state } }
}

describe('ordinary task messages and progress replies', () => {
  // Anh Dee, 11-04 ('bot messages'): a person sees only rows they wrote. A task no message asked for lives in Backlog and its
  // own conversation, never as a row under its requester's name or the PM's.
  it('posts nothing in the project chat for a task no message asked for, whoever opens it', () => {
    const f = fixture()
    for (const [actor, extra] of [[owner, {}], [f.as(f.pm), { requesterId: 'owner' }]] as const) {
      const created = f.run({ type: 'conversation.create', title: 'Offline drafts', brief: 'Keep drafts.', checks: [{ description: 'Done', independent: false }], priority: 'P2', ...extra } as Command, actor)
      const id = created.result.conversationId as string
      expect(created.messages.filter(m => m.conversationId !== id)).toEqual([])
      expect(f.task(id).cards?.line).toBeUndefined()
    }
  })

  it('names each task in the thread of the message that asked for it, and several tasks may share that message', () => {
    const f = fixture()
    const first = f.run({ type: 'conversation.create', title: 'Phone shows who answered', brief: 'Show who answered.', checks: [{ description: 'Done', independent: false }], priority: 'P2', requestMessageId: 'ask' } as Command,
      f.as(f.pm), { request: f.request() } as Partial<CommandContext>)
    const second = f.run({ type: 'conversation.create', title: 'Desktop shows who answered', brief: 'Same on Desktop.', checks: [{ description: 'Done', independent: false }], priority: 'P2', requestMessageId: 'ask' } as Command,
      f.as(f.pm), { request: f.request() } as Partial<CommandContext>)
    for (const [created, title] of [[first, 'Phone shows who answered'], [second, 'Desktop shows who answered']] as const) {
      const id = created.result.conversationId as string
      expect(f.task(id).cards?.line).toEqual({ messageId: 'ask', conversationId: 'lead' })
      expect(created.messages.filter(m => m.conversationId === 'lead')).toEqual([expect.objectContaining({ text: title, replyTo: 'ask', thread: 'ask',
        author: expect.objectContaining({ kind: 'agent', id: f.pm }), recipients: [], source: expect.objectContaining({ taskId: id }) })])
    }
  })

  it('keeps agents\' posts in the task\'s own conversation', () => {
    const f = fixture(), id = f.group()
    const builder = f.add('Kai', id)
    storedAssignment(f.state, id, builder)
    const posted = f.run({ type: 'message.send', conversationId: id, text: `Please check ${PR}`, replyTo: null, recipientIds: [] }, f.as(builder))
    expect(posted.messages.filter(m => m.conversationId === 'lead')).toEqual([])
  })

  // What each reply means for the task's row in the chat (threads.ts), so the tag outlives the task's own group.
  describe('marks each reply with what it means for the row', () => {
    const marks = (effects: CommandEffects, root: string) => effects.messages.filter(m => m.thread === root)
      .map(m => (m.source as { ask?: string } | undefined)?.ask)

    it('is on it from the brief', () => {
      const f = fixture(), first = f.run({ type: 'conversation.create', title: 'Offline drafts', brief: 'Keep drafts.', checks: [{ description: 'Done', independent: false }], priority: 'P2', requestMessageId: 'ask' } as Command,
        f.as(f.pm), { request: f.request() } as Partial<CommandContext>)
      const id = first.result.conversationId as string, root = f.task(id).cards!.line!.messageId
      expect(marks(first, root)).toEqual(['on-it'])
    })
  })


  it('keeps the message a person asked in as the root, with them as requester', () => {
    const f = fixture()
    const generation = f.state.people[0]!.generation
    const request = { id: 'ask', conversationId: 'lead', author: { kind: 'person' as const, id: 'owner', name: owner.email, membershipGeneration: generation },
      source: null, replyTo: null }
    const created = f.run({ type: 'conversation.create', title: 'Who answered', brief: 'Show who answered.', checks: [{ description: 'Done', independent: false }], priority: 'P2', requestMessageId: 'ask' } as Command,
      f.as(f.pm), { request } as Partial<CommandContext>)
    const id = created.result.conversationId as string
    expect(created.messages.filter(m => m.conversationId === 'lead' && !m.thread)).toEqual([])
    expect(f.task(id)).toMatchObject({ requesterId: 'owner', cards: { line: { messageId: 'ask', conversationId: 'lead' } } })
  })

  it('refuses a request message that is not a person\'s own top-level message in the project chat', () => {
    const generation = (f: ReturnType<typeof fixture>) => f.state.people[0]!.generation
    const cases = (f: ReturnType<typeof fixture>) => [
      { id: 'ask', conversationId: 'elsewhere', author: { kind: 'person', id: 'owner', name: owner.email, membershipGeneration: generation(f) }, source: null, replyTo: null },
      { id: 'ask', conversationId: 'lead', author: { kind: 'person', id: 'owner', name: owner.email, membershipGeneration: generation(f) }, source: null, replyTo: 'root' },
      { id: 'ask', conversationId: 'lead', author: { kind: 'person', id: 'owner', name: owner.email, membershipGeneration: generation(f) }, source: { kind: 'system' }, replyTo: null },
      { id: 'ask', conversationId: 'lead', author: { kind: 'agent', id: f.pm, name: 'River', membershipGeneration: 'g' }, source: null, replyTo: null },
      undefined,
    ]
    for (const index of [0, 1, 2, 3, 4]) {
      const f = fixture()
      expect(() => f.run({ type: 'conversation.create', title: 'Who answered', brief: '', checks: [{ description: 'Done', independent: false }], priority: 'P2', requestMessageId: 'ask' } as Command, f.as(f.pm),
        { request: cases(f)[index] } as Partial<CommandContext>)).toThrow(expect.objectContaining({ code: 'REQUEST_UNKNOWN' }))
    }
  })

  it('puts a private project\'s task only in its own project chat', () => {
    const f = fixture()
    const project = f.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).result.projectId as string
    const chat = f.state.projects!.find(p => p.id === project)!.leadConversationId
    const parent = f.run({ type: 'conversation.create', projectId: project, title: 'Hidden work', brief: 'Hidden.', checks: [{ description: 'Done', independent: false }], priority: 'P2', requestMessageId: 'secret-ask' } as Command,
      owner, { request: f.request('secret-ask', chat) } as Partial<CommandContext>).result.conversationId as string
    expect(f.task(parent).cards?.line).toEqual({ messageId: 'secret-ask', conversationId: chat })
  })

  it('never creates a root for a task that has none, on unrelated chat activity', () => {
    const f = fixture(), id = f.group()
    delete f.task(id).cards
    expect(f.lines(f.run({ type: 'message.send', conversationId: 'lead', text: 'Hello.', replyTo: null, recipientIds: [] }))).toEqual([])
  })
})
