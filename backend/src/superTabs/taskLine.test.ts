import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration, type CommandEffects } from './model.js'
import { SHIP_KIND } from './ship.js'
import { TASK_LINE_KIND } from './taskLine.js'

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
  const group = (title = 'Offline drafts', extra: Record<string, unknown> = {}) => run({ type: 'conversation.create', title, brief: 'Keep drafts.',
    checks: [], ...extra } as Command).result.conversationId as string
  const task = (id: string) => state.conversations.find(c => c.id === id)!
  const status = (id: string, worker: string, value: 'working' | 'needs_human' | 'blocked' | 'review' | 'done' | 'stopped', result: string | null = null,
    extra: Record<string, unknown> = {}) =>
    run({ type: 'work.status', conversationId: id, assignmentId: task(id).assignment!.id, status: value, result, ...extra } as Command, as(worker))
  const lines = (effects: CommandEffects) => effects.messages.filter(m => m.source?.kind === TASK_LINE_KIND)
  return { run, add, as, group, task, status, lines, pm, get state() { return state } }
}

describe('ordinary task messages and progress replies', () => {
  it('opens immediately as its requester with the brief first in its ordinary thread', () => {
    const f = fixture()
    const created = f.run({ type: 'conversation.create', title: 'Offline drafts', brief: 'Keep drafts.', checks: [] })
    const id = created.result.conversationId as string
    const [root] = f.lines(created)
    expect(root).toMatchObject({ conversationId: 'lead', author: { kind: 'person', id: 'owner', name: 'dee@example.com' },
      text: 'Offline drafts', replyTo: null, recipients: [], source: { kind: TASK_LINE_KIND, taskId: id } })
    expect(created.messages.filter(m => m.thread === root!.id)).toEqual([expect.objectContaining({ text: 'Keep drafts.',
      replyTo: root!.id, conversationId: 'lead' })])
    expect(f.task(id).cards?.line?.messageId).toBe(root!.id)
  })

  it('uses the project PM when no requester is named, never the machine owner', () => {
    const f = fixture()
    const created = f.run({ type: 'conversation.create', title: 'Offline drafts', brief: 'Keep drafts.', checks: [] }, f.as(f.pm))
    expect(f.lines(created)[0]).toMatchObject({ author: { kind: 'agent', id: f.pm }, text: 'Offline drafts' })
  })

  const thread = (effects: CommandEffects, root: string) => effects.messages.filter(m => m.thread === root).map(m => m.text)

  it('replies in the approved words, as the PM, without editing the root', () => {
    const f = fixture(), id = f.group(), root = f.task(id).cards!.line!.messageId
    const builder = f.add('Kai', id)
    const assigned = f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    expect(f.lines(assigned)).toEqual([])
    expect(assigned.messages.filter(m => m.thread === root)).toEqual([expect.objectContaining({ text: 'On it: Kai is building it.', replyTo: root,
      author: expect.objectContaining({ kind: 'agent', id: f.pm }), recipients: [] })])
    expect(thread(f.status(id, builder, 'working', 'Started.'), root)).toEqual([])
    const ready = f.status(id, builder, 'review', `Ready: ${PR}`)
    expect(ready.messages.filter(m => m.thread === root)).toEqual([expect.objectContaining({ text: 'Ready for review: PR #7',
      author: expect.objectContaining({ kind: 'agent', id: f.pm }) })])
    expect(thread(f.status(id, builder, 'working', 'Two findings: the draft is lost on restart.\nSecond line.'), root))
      .toEqual(['Changes needed: Two findings: the draft is lost on restart. Kai is fixing it.'])
    expect(thread(f.status(id, builder, 'review', `Fixed: ${PR}`), root)).toEqual(['Ready for review: PR #7'])
    const done = f.status(id, builder, 'done', `Checks passed: ${PR}`)
    expect(thread(done, root)).toEqual([])
    const merged = f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: PR })
    expect(thread(merged, root)).toEqual(['Merged: PR #7. Ships in the next release.'])
    expect(thread(f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: PR }), root)).toEqual([])
  })

  it('keeps agents\' posts in the task\'s own conversation and repeats no unchanged status', () => {
    const f = fixture(), id = f.group(), root = f.task(id).cards!.line!.messageId
    const builder = f.add('Kai', id)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    f.status(id, builder, 'working', 'Started.')
    expect(thread(f.status(id, builder, 'working', 'Halfway.'), root)).toEqual([])
    const posted = f.run({ type: 'message.send', conversationId: id, text: `Please check ${PR}`, replyTo: null, recipientIds: [] }, f.as(builder))
    expect(posted.messages.filter(m => m.conversationId === 'lead')).toEqual([])
    expect(thread(f.status(id, builder, 'review', 'Ready.'), root)).toEqual(['Ready for review.'])
  })

  it('reports each newly merged pull request once, including a second pull request for the same task', () => {
    const f = fixture(), id = f.group(), root = f.task(id).cards!.line!.messageId
    const second = 'https://github.com/example/app/pull/8'
    for (const [url, n] of [[PR, 7], [second, 8]] as const) {
      const merged = f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: url })
      expect(merged.messages.filter(m => m.thread === root)).toEqual([expect.objectContaining({ text: `Merged: PR #${n}. Ships in the next release.`,
        source: { kind: 'system' } })])
      expect(thread(f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: url }), root)).toEqual([])
    }
  })

  it('says what is stuck and what happens next', () => {
    const f = fixture(), id = f.group(), root = f.task(id).cards!.line!.messageId
    const builder = f.add('Kai', id)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    f.status(id, builder, 'working', 'Started.')
    expect(thread(f.status(id, builder, 'blocked', 'The build machine is offline.\nRestart it to unblock.'), root))
      .toEqual(['Stuck: The build machine is offline. Next: River is looking at it.'])
  })

  it('says the PM is looking at what is stuck when its chat has no coordinator, never the agent that is stuck', () => {
    const f = fixture()
    const project = f.run({ type: 'project.create', name: 'Quiet', visibility: 'private', brief: '' }).result.projectId as string
    const chat = f.state.projects!.find(p => p.id === project)!.leadConversationId
    expect(f.state.conversations.find(c => c.id === chat)!.leadId ?? null).toBeNull()
    const id = f.run({ type: 'conversation.create', projectId: project, title: 'Offline drafts', brief: 'Keep drafts.', checks: [] }).result.conversationId as string
    const root = f.task(id).cards!.line!.messageId
    const builder = f.add('Kai', id)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    f.status(id, builder, 'working', 'Started.')
    expect(thread(f.status(id, builder, 'blocked', 'The build machine is offline.'), root))
      .toEqual(['Stuck: The build machine is offline. Next: the PM is looking at it.'])
  })

  it('tags the person a decision waits on, with its default', () => {
    const f = fixture(), id = f.group(), root = f.task(id).cards!.line!.messageId
    const builder = f.add('Kai', id)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    const asked = f.status(id, builder, 'needs_human', 'Keep drafts for a week?', { ask: { personId: 'owner', options: ['A week', 'A month'], recommended: 1,
      unblocks: 'how long drafts are kept' } })
    expect(thread(asked, root)).toEqual(['@dee Your call: Keep drafts for a week? Default: A month.'])
  })

  it('says it is not building a cancelled task, with the reason', () => {
    const f = fixture(), id = f.group(), root = f.task(id).cards!.line!.messageId
    const builder = f.add('Kai', id)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    const cancelled = f.run({ type: 'work.cancel', conversationId: id, assignmentId: f.task(id).assignment!.id, reason: 'Dee chose the web version.' }, f.as(f.pm))
    expect(thread(cancelled, root)).toEqual(['Not building this: Dee chose the web version.'])
  })

  it('links a proposal root instead of posting a second opening message, and adds no brief under the proposal', () => {
    const f = fixture()
    const created = f.run({ type: 'conversation.create', title: 'Offline drafts', brief: 'Keep drafts.', checks: [], proposalMessageId: 'proposal' }, f.as(f.pm),
      { proposal: { id: 'proposal', conversationId: 'lead', author: { kind: 'person', id: 'owner', name: owner.email, membershipGeneration: f.state.people[0]!.generation },
        source: { kind: 'buddy-proposal', personId: 'owner', buddyId: 'former-buddy' } } })
    expect(f.lines(created)).toEqual([])
    expect(f.task(created.result.conversationId as string).cards?.line).toMatchObject({ messageId: 'proposal', conversationId: 'lead' })
    expect(created.messages.filter(m => m.conversationId === 'lead')).toEqual([])
  })

  it('keeps the message a person asked in as the root, with them as requester', () => {
    const f = fixture()
    const generation = f.state.people[0]!.generation
    const request = { id: 'ask', conversationId: 'lead', author: { kind: 'person' as const, id: 'owner', name: owner.email, membershipGeneration: generation },
      source: null, replyTo: null }
    const created = f.run({ type: 'conversation.create', title: 'Who answered', brief: 'Show who answered.', checks: [], requestMessageId: 'ask' } as Command,
      f.as(f.pm), { request } as Partial<CommandContext>)
    const id = created.result.conversationId as string
    expect(created.messages.filter(m => m.conversationId === 'lead')).toEqual([])
    expect(f.task(id)).toMatchObject({ requesterId: 'owner', cards: { line: { messageId: 'ask', conversationId: 'lead' } } })
    const builder = f.add('Kai', id)
    expect(thread(f.run({ type: 'work.assign', conversationId: id, agentId: builder }), 'ask')).toEqual(['On it: Kai is building it.'])
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
      expect(() => f.run({ type: 'conversation.create', title: 'Who answered', brief: '', checks: [], requestMessageId: 'ask' } as Command, f.as(f.pm),
        { request: cases(f)[index] } as Partial<CommandContext>)).toThrow(expect.objectContaining({ code: 'REQUEST_UNKNOWN' }))
    }
  })

  it('keeps legacy roots readable and appends updates without rewriting their stored words', () => {
    const f = fixture(), id = f.group(), builder = f.add('Kai', id)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    f.task(id).cards!.line!.messageId = 'old-root'
    const effects = f.status(id, builder, 'review', 'Review this.')
    expect(effects.messages.filter(m => m.thread === 'old-root')).toHaveLength(1)
  })

  it('puts private project messages only in their own project chat and excludes steps', () => {
    const f = fixture()
    const project = f.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).result.projectId as string
    const chat = f.state.projects!.find(p => p.id === project)!.leadConversationId
    const created = f.run({ type: 'conversation.create', projectId: project, title: 'Hidden work', brief: 'Hidden.', checks: [] })
    expect(f.lines(created)[0]!.conversationId).toBe(chat)
    const parent = created.result.conversationId as string
    const step = f.run({ type: 'conversation.create', projectId: project, title: 'Review', step: 'Review', reviewOf: parent, brief: 'Review.', checks: [] })
    expect(f.lines(step)).toEqual([])
  })

  it('does not create a root for an unchanged legacy task on unrelated chat activity', () => {
    const f = fixture(), id = f.group(), builder = f.add('Kai', id)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    delete f.task(id).cards
    expect(f.lines(f.run({ type: 'message.send', conversationId: 'lead', text: 'Hello.', replyTo: null, recipientIds: [] }))).toEqual([])
    expect(f.lines(f.status(id, builder, 'review', 'Ready.'))[0]!.text).toBe('Offline drafts')
  })
})
