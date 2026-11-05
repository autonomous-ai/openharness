import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration, type CommandEffects } from './model.js'
import { SHIP_KIND } from './ship.js'
import { TASK_LINE_KIND } from './taskLine.js'

const HOLD = { kind: 'person', personId: 'owner', defaultAt: '2026-11-06T02:00:00.000Z' } as const

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
    brief: 'Keep drafts.', checks: [], requestMessageId: ask, ...extra } as Command, as(pm), { request: request(ask) } as Partial<CommandContext>)
    .result.conversationId as string
  const task = (id: string) => state.conversations.find(c => c.id === id)!
  const status = (id: string, worker: string, value: 'working' | 'needs_human' | 'blocked' | 'review' | 'done' | 'stopped', result: string | null = null,
    extra: Record<string, unknown> = {}) =>
    run({ type: 'work.status', conversationId: id, assignmentId: task(id).assignment!.id, status: value, result, ...(value === 'blocked' || value === 'needs_human' ? { hold: HOLD } : {}), ...extra } as Command, as(worker))
  const lines = (effects: CommandEffects) => effects.messages.filter(m => m.source?.kind === TASK_LINE_KIND)
  return { run, add, as, group, request, task, status, lines, pm, get state() { return state } }
}

describe('ordinary task messages and progress replies', () => {
  // Anh Dee, 11-04 ('bot messages'): a person sees only rows they wrote. A task no message asked for lives in Backlog and its
  // own conversation, never as a row under its requester's name or the PM's.
  it('posts nothing in the project chat for a task no message asked for, whoever opens it', () => {
    const f = fixture()
    for (const [actor, extra] of [[owner, {}], [f.as(f.pm), { requesterId: 'owner' }], [f.as(f.pm), {}]] as const) {
      const created = f.run({ type: 'conversation.create', title: 'Offline drafts', brief: 'Keep drafts.', checks: [], ...extra } as Command, actor)
      const id = created.result.conversationId as string
      expect(created.messages.filter(m => m.conversationId !== id)).toEqual([])
      expect(f.task(id).cards?.line).toBeUndefined()
      const builder = f.add('Kai', id)
      const moves = [f.run({ type: 'work.assign', conversationId: id, agentId: builder }), f.status(id, builder, 'review', `Ready: ${PR}`),
        f.status(id, builder, 'done', `Checks passed: ${PR}`), f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: PR })]
      expect(moves.flatMap(m => m.messages).filter(m => m.conversationId === 'lead')).toEqual([])
    }
  })

  it('names each task in the thread of the message that asked for it, and several tasks may share that message', () => {
    const f = fixture()
    const first = f.run({ type: 'conversation.create', title: 'Phone shows who answered', brief: 'Show who answered.', checks: [], requestMessageId: 'ask' } as Command,
      f.as(f.pm), { request: f.request() } as Partial<CommandContext>)
    const second = f.run({ type: 'conversation.create', title: 'Desktop shows who answered', brief: 'Same on Desktop.', checks: [], requestMessageId: 'ask' } as Command,
      f.as(f.pm), { request: f.request() } as Partial<CommandContext>)
    for (const [created, title] of [[first, 'Phone shows who answered'], [second, 'Desktop shows who answered']] as const) {
      const id = created.result.conversationId as string
      expect(f.task(id).cards?.line).toEqual({ messageId: 'ask', conversationId: 'lead' })
      expect(created.messages.filter(m => m.conversationId === 'lead')).toEqual([expect.objectContaining({ text: title, replyTo: 'ask', thread: 'ask',
        author: expect.objectContaining({ kind: 'agent', id: f.pm }), recipients: [], source: expect.objectContaining({ taskId: id }) })])
    }
  })

  const thread = (effects: CommandEffects, root: string) => effects.messages.filter(m => m.thread === root).map(m => m.text)

  it('replies in the approved words, as the PM, without editing the root', () => {
    const f = fixture(), id = f.group(), root = f.task(id).cards!.line!.messageId
    const builder = f.add('Kai', id)
    const assigned = f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    expect(f.lines(assigned)).toEqual([])
    // Kai's 👀 on the ask says it, not a reply (anh Dee, 11-04, 'bot messages').
    expect(assigned.messages.filter(m => m.thread === root)).toEqual([])
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

  // What each reply means for the task's row in the chat (threads.ts), so the tag outlives the task's own group.
  describe('marks each reply with what it means for the row', () => {
    const marks = (effects: CommandEffects, root: string) => effects.messages.filter(m => m.thread === root)
      .map(m => (m.source as { ask?: string } | undefined)?.ask)

    it('is on it from the brief to the merge, then shipped', () => {
      const f = fixture(), first = f.run({ type: 'conversation.create', title: 'Offline drafts', brief: 'Keep drafts.', checks: [], requestMessageId: 'ask' } as Command,
        f.as(f.pm), { request: f.request() } as Partial<CommandContext>)
      const id = first.result.conversationId as string, root = f.task(id).cards!.line!.messageId
      expect(marks(first, root)).toEqual(['on-it'])
      const builder = f.add('Kai', id)
      expect(marks(f.run({ type: 'work.assign', conversationId: id, agentId: builder }), root)).toEqual([])
      expect(marks(f.status(id, builder, 'review', `Ready: ${PR}`), root)).toEqual(['on-it'])
      expect(marks(f.status(id, builder, 'done', `Checks passed: ${PR}`), root)).toEqual([])
      expect(marks(f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: PR }), root)).toEqual(['shipped'])
    })

    it('closes on a cancel, and on a task finished with no pull request', () => {
      const cancelled = fixture(), a = cancelled.group(), rootA = cancelled.task(a).cards!.line!.messageId, kai = cancelled.add('Kai', a)
      cancelled.run({ type: 'work.assign', conversationId: a, agentId: kai })
      expect(marks(cancelled.run({ type: 'work.cancel', conversationId: a, assignmentId: cancelled.task(a).assignment!.id, reason: 'Not needed.' }), rootA))
        .toEqual(['closed'])
      const done = fixture(), b = done.group(), rootB = done.task(b).cards!.line!.messageId, lee = done.add('Lee', b)
      done.run({ type: 'work.assign', conversationId: b, agentId: lee })
      expect(marks(done.status(b, lee, 'done', 'Answered in the thread.'), rootB)).toEqual(['closed'])
    })

    it('tags the person\'s own message a task was opened from', () => {
      const f = fixture(), generation = f.state.people[0]!.generation
      const request = { id: 'ask', conversationId: 'lead', author: { kind: 'person' as const, id: 'owner', name: owner.email, membershipGeneration: generation },
        source: null, replyTo: null }
      const id = f.run({ type: 'conversation.create', title: 'Who answered', brief: 'Show who answered.', checks: [], requestMessageId: 'ask' } as Command,
        f.as(f.pm), { request } as Partial<CommandContext>).result.conversationId as string
      const builder = f.add('Kai', id)
      expect(marks(f.status(id, (f.run({ type: 'work.assign', conversationId: id, agentId: builder }), builder), 'review', 'Ready.'), 'ask')).toEqual(['on-it'])
    })

    it('says shipped for a merge recorded with no card, which otherwise leaves the row on it', () => {
      const f = fixture(), id = f.group(), root = f.task(id).cards!.line!.messageId, builder = f.add('Kai', id)
      f.run({ type: 'work.assign', conversationId: id, agentId: builder })
      f.status(id, builder, 'done', `Checks passed: ${PR}`)
      delete f.task(id).cards!.pullRequests
      const merged = f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: PR })
      expect(thread(merged, root)).toEqual(['Merged: PR #7. Ships in the next release.'])
      expect(marks(merged, root)).toEqual(['shipped'])
    })
  })

  it('reports each newly merged pull request once, including a second pull request for the same task', () => {
    const f = fixture(), id = f.group(), root = f.task(id).cards!.line!.messageId
    const second = 'https://github.com/example/app/pull/8'
    for (const [url, n] of [[PR, 7], [second, 8]] as const) {
      const merged = f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: url })
      expect(merged.messages.filter(m => m.thread === root)).toEqual([expect.objectContaining({ text: `Merged: PR #${n}. Ships in the next release.`,
        source: { kind: 'system', ask: 'shipped' } })])
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
    const id = f.run({ type: 'conversation.create', projectId: project, title: 'Offline drafts', brief: 'Keep drafts.', checks: [], requestMessageId: 'quiet-ask' } as Command,
      owner, { request: f.request('quiet-ask', chat) } as Partial<CommandContext>).result.conversationId as string
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
    expect(created.messages.filter(m => m.conversationId === 'lead' && !m.thread)).toEqual([])
    expect(f.task(id)).toMatchObject({ requesterId: 'owner', cards: { line: { messageId: 'ask', conversationId: 'lead' } } })
    const builder = f.add('Kai', id)
    expect(thread(f.run({ type: 'work.assign', conversationId: id, agentId: builder }), 'ask')).toEqual([])
  })

  // In place of the On it / Shipped label (anh Dee, 11-04, 'bot messages'): the agent doing the work reacts on the message that
  // asked, as a teammate would, once per task.
  describe('reacts as the task\'s agent on the message that asked for it', () => {
    const chatSeq = (f: ReturnType<typeof fixture>) => f.state.conversations.find(c => c.id === 'lead')!.reactionSeq ?? 0

    it('👀 when its work starts and ✅ once when its pull request merges', () => {
      const f = fixture(), id = f.group(), builder = f.add('Kai', id)
      const seq = chatSeq(f)
      expect(f.run({ type: 'work.assign', conversationId: id, agentId: builder }).reactions)
        .toEqual([{ conversationId: 'lead', messageId: 'ask', agentId: builder, emoji: 'eyes' }])
      expect(chatSeq(f)).toBe(seq + 1)
      expect(f.status(id, builder, 'review', `Ready: ${PR}`).reactions ?? []).toEqual([])
      expect(f.status(id, builder, 'done', `Checks passed: ${PR}`).reactions ?? []).toEqual([])
      expect(f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: PR }).reactions)
        .toEqual([{ conversationId: 'lead', messageId: 'ask', agentId: builder, emoji: 'check' }])
      expect(chatSeq(f)).toBe(seq + 2)
      expect(f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: PR }).reactions ?? []).toEqual([])
      expect(f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: 'https://github.com/example/app/pull/8' }).reactions ?? []).toEqual([])
    })

    it('once per task: a second agent taking it over reacts no second 👀; each task under one message reacts for itself', () => {
      const f = fixture(), first = f.group('Phone shows who answered'), second = f.group('Desktop shows who answered')
      const kai = f.add('Kai', first), lee = f.add('Lee', first), mo = f.add('Mo', second)
      f.run({ type: 'work.assign', conversationId: first, agentId: kai })
      f.run({ type: 'work.status', conversationId: first, assignmentId: f.task(first).assignment!.id, status: 'stopped', result: 'Handing it on.' } as Command,
        f.as(kai), { confirmedStopped: true })
      expect(f.run({ type: 'work.assign', conversationId: first, agentId: lee }).reactions ?? []).toEqual([])
      expect(f.run({ type: 'work.assign', conversationId: second, agentId: mo }).reactions)
        .toEqual([{ conversationId: 'lead', messageId: 'ask', agentId: mo, emoji: 'eyes' }])
    })

    it('reacts on a Buddy\'s proposal that a task was opened from', () => {
      const f = fixture()
      const id = f.run({ type: 'conversation.create', title: 'Offline drafts', brief: 'Keep drafts.', checks: [], proposalMessageId: 'proposal' }, f.as(f.pm),
        { proposal: { id: 'proposal', conversationId: 'lead', author: { kind: 'person', id: 'owner', name: owner.email, membershipGeneration: f.state.people[0]!.generation },
          source: { kind: 'buddy-proposal', personId: 'owner', buddyId: 'former-buddy' } } }).result.conversationId as string
      const builder = f.add('Kai', id)
      expect(f.run({ type: 'work.assign', conversationId: id, agentId: builder }).reactions)
        .toEqual([{ conversationId: 'lead', messageId: 'proposal', agentId: builder, emoji: 'eyes' }])
    })

    it('reacts nowhere for a task no message asked for', () => {
      const f = fixture()
      const id = f.run({ type: 'conversation.create', title: 'Offline drafts', brief: 'Keep drafts.', checks: [] }).result.conversationId as string
      const builder = f.add('Kai', id), seq = chatSeq(f)
      expect(f.run({ type: 'work.assign', conversationId: id, agentId: builder }).reactions ?? []).toEqual([])
      f.status(id, builder, 'done', `Checks passed: ${PR}`)
      expect(f.run({ type: 'conversation.merged', conversationId: id, pullRequestUrl: PR }).reactions ?? []).toEqual([])
      expect(chatSeq(f)).toBe(seq)
    })
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

  it('puts a private project\'s task only in its own project chat, and nothing for its steps', () => {
    const f = fixture()
    const project = f.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).result.projectId as string
    const chat = f.state.projects!.find(p => p.id === project)!.leadConversationId
    const parent = f.run({ type: 'conversation.create', projectId: project, title: 'Hidden work', brief: 'Hidden.', checks: [], requestMessageId: 'secret-ask' } as Command,
      owner, { request: f.request('secret-ask', chat) } as Partial<CommandContext>).result.conversationId as string
    expect(f.task(parent).cards?.line).toEqual({ messageId: 'secret-ask', conversationId: chat })
    const step = f.run({ type: 'conversation.create', projectId: project, title: 'Review', step: 'Review', reviewOf: parent, brief: 'Review.', checks: [] })
    expect(step.messages.filter(m => m.conversationId === chat || m.conversationId === 'lead')).toEqual([])
  })

  it('never creates a root for a task that has none, on unrelated chat activity or when it moves', () => {
    const f = fixture(), id = f.group(), builder = f.add('Kai', id)
    f.run({ type: 'work.assign', conversationId: id, agentId: builder })
    delete f.task(id).cards
    expect(f.lines(f.run({ type: 'message.send', conversationId: 'lead', text: 'Hello.', replyTo: null, recipientIds: [] }))).toEqual([])
    expect(f.status(id, builder, 'review', 'Ready.').messages.filter(m => m.conversationId === 'lead')).toEqual([])
  })
})
